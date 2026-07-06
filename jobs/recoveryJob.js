'use strict';

const cron = require('node-cron');
const { pool } = require('../db');
const { sendMessage, addTag } = require('../services/ghl');
const { callClaude } = require('../ai/claude');
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

async function generateRecoveryMessage(messages, attempt) {
  const systemPrompt = attempt === 1 ? SYSTEM_PROMPT_ATTEMPT_1 : SYSTEM_PROMPT_ATTEMPT_2;

  // Build a short history summary for Claude to draw context from
  const history = Array.isArray(messages) && messages.length > 0
    ? messages.slice(-6) // last 6 messages for context
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
    const { conversation_id, contact_id, messages, recovery_status, updated_at } = row;
    const updatedAt = new Date(updated_at);

    try {
      let attempt = null;

      if (recovery_status === null && updatedAt <= threeHoursAgo) {
        attempt = 1;
      } else if (recovery_status === 'intento-1' && updatedAt <= sixHoursAgo) {
        attempt = 2;
      }

      if (!attempt) continue;

      console.log(`[recoveryJob] Attempt ${attempt} for conversation ${conversation_id}`);

      // 1. Generate recovery message via Claude
      const parsedMessages = Array.isArray(messages) ? messages : [];
      const recoveryMessage = await generateRecoveryMessage(parsedMessages, attempt);

      // 2. Send via GHL — detect channel so IG/FB conversations reply correctly
      const { getConversationChannel } = require('../services/ghl');
      const channel = await getConversationChannel(contact_id).catch(() => 'WhatsApp');
      await sendMessage(conversation_id, recoveryMessage, contact_id, channel);

      // 3. Apply label and update recovery_status
      if (attempt === 1) {
        await addTag(contact_id, 'recuperacion-1');
        await pool.query(
          'UPDATE conversations SET recovery_status=$1 WHERE conversation_id=$2 AND agent=$3',
          ['intento-1', conversation_id, env.agentName]
        );
      } else {
        await addTag(contact_id, 'recuperacion-2');
        await addTag(contact_id, 'recuperacion-fallida');
        await pool.query(
          'UPDATE conversations SET recovery_status=$1 WHERE conversation_id=$2 AND agent=$3',
          ['intento-2', conversation_id, env.agentName]
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
