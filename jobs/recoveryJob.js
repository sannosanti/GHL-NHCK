'use strict';

const cron = require('node-cron');
const { pool } = require('../db');
const { sendMessage, addTag, getContact } = require('../services/ghl');
const { callClaude } = require('../ai/claude');
const { limpiarTags } = require('../ai/tags');
const { CONOCIMIENTO_NHC, env } = require('../config');
const { triggerAnalysis } = require('./insightJob');
const { notifyError } = require('../services/notifier');

// Colombia is UTC-5 year-round (no DST)
const COLOMBIA_OFFSET_HOURS = -5;

function getColombiaHour() {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const local = (utcHour + 24 + COLOMBIA_OFFSET_HOURS) % 24;
  return local;
}

function isWithinOperatingHours() {
  const hour = getColombiaHour();
  // 7:00 AM to 10:00 PM Colombia time
  return hour >= 7 && hour < 22;
}

const EXCLUDED_STATES = ['escalado', 'esperando_pago', 'pagado', 'completado', 'cerrado'];

const SYSTEM_PROMPT_ATTEMPT_1 = `Eres Carolina, asesora de NHC Kids. Escribes por WhatsApp.

${CONOCIMIENTO_NHC}

TU TAREA — MENSAJE DE RECUPERACIÓN (intento 1):
Escribe UN mensaje corto (1-2 oraciones) para retomar contacto con un padre/madre que dejó de responder.

REGLAS:
- Tono emocional, cálido, genuinamente preocupado por el bienestar del niño
- Menciona sutilmente la situación del niño (usa el historial para contexto) sin sonar salesy
- NO menciones que eres IA
- NO uses asteriscos ni negritas
- NO ofrezcas el servicio directamente — solo reencuentra la conversación
- Máximo 2 oraciones
- Solo español
- Varía el mensaje para que suene espontáneo y humano`;

const SYSTEM_PROMPT_ATTEMPT_2 = `Eres Carolina, asesora de NHC Kids. Escribes por WhatsApp.

${CONOCIMIENTO_NHC}

TU TAREA — MENSAJE DE RECUPERACIÓN (intento 2, último):
Escribe UN mensaje corto (1-2 oraciones) para hacer un último acercamiento con un padre/madre que no respondió.

REGLAS:
- Tono emocional, cálido, con un sutil sentido de urgencia por el bienestar del niño
- Diferente al primer intento — más personal, más desde el corazón
- NO menciones que eres IA
- NO uses asteriscos ni negritas
- NO suenes a vendedor
- Máximo 2 oraciones
- Solo español
- Este es el último mensaje — hazlo memorable`;

const SYSTEM_PROMPT_ATTEMPT_3 = `Eres Carolina, asesora de NHC Kids. Escribes por WhatsApp.

${CONOCIMIENTO_NHC}

TU TAREA — MENSAJE DE RECUPERACIÓN (intento 3, al día siguiente):
Escribe UN mensaje corto (1-2 oraciones) para un cliente que no respondió los dos mensajes anteriores, enviado al día siguiente.

REGLAS:
- Ya pasó un día: NO repitas el tono de los dos intentos previos, suena a insistencia
- Abrí una puerta concreta y fácil de contestar: ofrecé resolver UNA duda puntual, o preguntá si prefiere que lo contacten en otro momento
- Tono tranquilo y sin presión — si no responde, no se vuelve a escribir
- NO menciones que es el último intento ni que le escribiste antes varias veces
- NO menciones que eres IA
- NO uses asteriscos ni negritas
- Máximo 2 oraciones
- Solo español`;

/**
 * Ficha de datos VERIFICADOS que se le antepone al historial.
 *
 * Sin esto, el modelo recibia solo los ultimos 6 mensajes. Cuando el nombre del
 * paciente se habia dicho antes de esa ventana, quedaba fuera y el modelo lo
 * COMPLETABA: a Natalia Carmona le escribio "como va todo con Samuel" dos veces
 * y despues "como va todo con Valentina" (2026-08-18, 11:30 a 12:00). No se
 * equivoco de contacto: no tenia el dato y lo invento.
 *
 * El triaje ya venia en la consulta SQL de este mismo archivo y no se usaba.
 *
 * Se declara explicitamente lo que NO se sabe. Un campo ausente en silencio
 * invita a rellenarlo; uno que dice "desconocido" con la instruccion de no
 * inventar, no.
 */
function fichaDeDatos({ nombreContacto, triaje }) {
  const t = triaje || {};
  const nino = t.nombre_nino || t.nombreNino || null;
  const lineas = [
    'DATOS VERIFICADOS DE ESTA CONVERSACION — son los UNICOS que podes usar:',
    `- Quien escribe: ${nombreContacto || 'DESCONOCIDO'}`,
    `- Nombre del paciente: ${nino || 'DESCONOCIDO'}`,
    `- Dificultad: ${t.triaje1 || 'DESCONOCIDA'}`,
    `- Tiempo con la dificultad: ${t.triaje2 || 'DESCONOCIDO'}`,
    `- Que han intentado: ${t.triaje3 || 'DESCONOCIDO'}`,
    '',
    'REGLA ABSOLUTA SOBRE NOMBRES Y DATOS:',
    '- Usa SOLO los datos de arriba. Si alguno dice DESCONOCIDO, NO lo inventes.',
    '- Si no sabes el nombre del paciente, escribi sin nombrarlo ("tu hijo/a", "ustedes").',
    '- NUNCA deduzcas un nombre del historial ni elijas uno que suene probable.',
    '- Inventar un nombre de paciente es peor que no nombrarlo: destruye la confianza.',
  ];
  return lineas.join('\n');
}

async function generateRecoveryMessage(messages, attempt, datos = {}) {
  const base = attempt === 1 ? SYSTEM_PROMPT_ATTEMPT_1
    : attempt === 2 ? SYSTEM_PROMPT_ATTEMPT_2
    : SYSTEM_PROMPT_ATTEMPT_3;

  // La ficha va al FINAL: es lo ultimo que lee el modelo antes de escribir, y
  // pesa mas que el conocimiento general de arriba.
  const systemPrompt = `${base}\n\n${fichaDeDatos(datos)}`;

  // Build a short history summary for Claude to draw context from. Messages
  // whose only text is blank are dropped first: a media webhook that arrived
  // without its transcription leaves one behind, and it made this job fail on
  // the same conversation every 15 minutes forever (the row never advances
  // past its recovery_status because that update happens after this call).
  const usable = (Array.isArray(messages) ? messages : []).filter(m => {
    const c = m?.content;
    if (typeof c === 'string') return c.trim() !== '';
    if (Array.isArray(c)) return c.some(b => b && (b.type !== 'text' || String(b.text ?? '').trim() !== ''));
    return false;
  });

  const history = usable.length > 0
    ? usable.slice(-6) // last 6 messages for context
    : [{ role: 'user', content: 'Hola' }];

  // Ensure it ends with a user message so Claude can reply
  const lastRole = history[history.length - 1]?.role;
  const claudeHistory = lastRole === 'user'
    ? history
    : [...history, { role: 'user', content: 'Genera el mensaje de recuperación ahora.' }];

  return await callClaude(systemPrompt, claudeHistory);
}

async function runRecoveryJob() {
  if (!isWithinOperatingHours()) {
    console.log('[recoveryJob] Outside operating hours — skipping');
    return;
  }

  const now = new Date();
  const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  // Attempts 1 and 2 both land within six hours, i.e. the same afternoon. A
  // lead who simply put the phone down never saw either. The third waits a
  // full day so it arrives as a fresh contact, not as more of the same thread.
  const oneDayAgo = new Date(now.getTime() - 26 * 60 * 60 * 1000);

  let rows;
  try {
    const result = await pool.query(`
      SELECT conversation_id, contact_id, phone, messages, triaje, estado, recovery_status, updated_at
      FROM conversations
      WHERE estado NOT IN (${EXCLUDED_STATES.map((_, i) => `$${i + 1}`).join(',')})
        AND agent = $${EXCLUDED_STATES.length + 1}
        AND (
          recovery_status IS NULL
          OR recovery_status = 'intento-1'
          OR recovery_status = 'intento-2'
          OR (recovery_status = 'pospuesto' AND updated_at <= NOW() - INTERVAL '24 hours')
        )
    `, [...EXCLUDED_STATES, env.agentName]);
    rows = result.rows;
  } catch (err) {
    console.error('[recoveryJob] DB query error:', err.message);
    return;
  }

  if (!rows || rows.length === 0) {
    console.log('[recoveryJob] No eligible conversations');
    return;
  }

  console.log(`[recoveryJob] Checking ${rows.length} eligible conversation(s)`);

  for (const row of rows) {
    const { conversation_id, contact_id, messages, triaje, recovery_status, updated_at } = row;
    const updatedAt = new Date(updated_at);

    try {
      let attempt = null;

      if (recovery_status === null && updatedAt <= threeHoursAgo) {
        attempt = 1;
      } else if (recovery_status === 'intento-1' && updatedAt <= sixHoursAgo) {
        attempt = 2;
      } else if (recovery_status === 'intento-2' && updatedAt <= oneDayAgo) {
        attempt = 3;
      }

      if (!attempt) continue;

      // Live GHL tags can be ahead of our internal `estado` — e.g. an advisor
      // escalates the contact by hand in GHL, which never touches this row.
      // Never send a recovery message to an already-escalated contact.
      const { contact } = await getContact(contact_id, true);
      if ((contact?.tags || []).includes('escalado nhck')) continue;

      console.log(`[recoveryJob] Attempt ${attempt} for conversation ${conversation_id}`);

      // 1. Generate recovery message via Claude
      const parsedMessages = Array.isArray(messages) ? messages : [];
      const rawRecovery = await generateRecoveryMessage(parsedMessages, attempt, {
        nombreContacto: contact?.firstName || null,
        triaje,
      });

      // The history handed to Claude is full of internal tags, so the model
      // imitates them: the adults bot shipped a literal "[NHC_MENOR]" to a
      // patient on WhatsApp (2026-07-29). Clean it like every other sender.
      const recoveryMessage = limpiarTags(rawRecovery).trim();

      // Nothing left to send once the tags are gone. Still advance
      // recovery_status below rather than skipping, because the row would
      // otherwise stay eligible and this job would retry it every 15 minutes
      // forever — the loop this whole path was already stuck in.
      if (!recoveryMessage) {
        console.warn(`[recoveryJob] Mensaje vacío tras limpiar tags — no se envía nada para ${conversation_id}`);
      }

      // 2. Send via GHL — detect channel so IG/FB conversations reply correctly
      if (recoveryMessage) {
        const { getConversationChannel } = require('../services/ghl');
        const channel = await getConversationChannel(contact_id).catch(() => 'WhatsApp');
        await sendMessage(conversation_id, recoveryMessage, contact_id, channel);
      }

      // 3. Apply label and update recovery_status
      if (attempt === 1) {
        await addTag(contact_id, 'recuperacion-1');
        await pool.query(
          'UPDATE conversations SET recovery_status=$1 WHERE conversation_id=$2 AND agent=$3',
          ['intento-1', conversation_id, env.agentName]
        );
      } else if (attempt === 2) {
        await addTag(contact_id, 'recuperacion-2');
        await pool.query(
          'UPDATE conversations SET recovery_status=$1 WHERE conversation_id=$2 AND agent=$3',
          ['intento-2', conversation_id, env.agentName]
        );
      } else {
        // Third and last. `recuperacion-fallida` and the drop-off analysis move
        // here: marking the lead lost after attempt 2 was premature now that
        // another message still goes out the following day.
        await addTag(contact_id, 'recuperacion-3');
        await addTag(contact_id, 'recuperacion-fallida');
        await pool.query(
          'UPDATE conversations SET recovery_status=$1 WHERE conversation_id=$2 AND agent=$3',
          ['intento-3', conversation_id, env.agentName]
        );
        triggerAnalysis(conversation_id, contact_id, 'recovery_fallido');
      }

      console.log(`[recoveryJob] Attempt ${attempt} sent for conversation ${conversation_id}`);
    } catch (err) {
      console.error(`[recoveryJob] Error processing ${conversation_id}:`, err.message);
      notifyError(`recoveryJob conv ${conversation_id}`, err).catch(() => {});
    }
  }
}

function startRecoveryJob() {
  // Every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    runRecoveryJob().catch(err => console.error('[recoveryJob] Unhandled error:', err.message));
  });
  console.log('Recovery job scheduled (every 15 minutes) ✓');
}

module.exports = { startRecoveryJob };
