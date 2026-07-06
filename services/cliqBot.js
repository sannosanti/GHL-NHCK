'use strict';

const { pool } = require('../db');
const { env } = require('../config');
const { callClaude } = require('../ai/claude');

const SYSTEM_PROMPT = `Sos un asistente de gestión interno de NHC Kids. Respondés preguntas sobre cómo va el trabajo del agente WhatsApp Carolina.

Hablás como alguien del equipo, no como un sistema. Sin tecnicismos, sin mencionar bases de datos, queries, campos ni recomendaciones técnicas.

Tenés acceso completo a toda la información: totales, actividad reciente y los nombres reales de cada persona en cada estado. Nunca digas que no tenés acceso a algo ni que hay que revisarlo en otro sistema.

Lo que significan los estados:
- nuevo: lead que acaba de escribir
- triaje_completo: Carolina ya recogió toda la info, pendiente de agendar
- agendando: están eligiendo fecha y hora
- esperando_pago: link de pago enviado, el cliente no pagó todavía — estos son los "en proceso de cierre"
- completado: pagó y tiene cita confirmada
- cerrado: no se convirtió
- escalado: necesitó intervención humana

Reglas:
- Respondé en español, directo y breve
- Usá los nombres reales de los contactos cuando te los pidan (están en contactos_activos)
- Si alguien pregunta por personas en un estado, listá los nombres de ese estado
- Tenés los últimos mensajes de cada conversación en ultimos_mensajes — podés leerlos y dar recomendaciones concretas basadas en lo que pasó
- Si te piden qué hacer con alguien, leé su chat y recomendá la acción específica más útil (ej: "seguir con el precio", "resolver la duda sobre la EPS", "recordarle el link de pago")
- Nunca decís que no tenés acceso a los chats ni que hay que revisar otro sistema
- Nunca sugerís cambios técnicos
- Máximo 5 puntos o 3 párrafos cortos`;

async function getSnapshot() {
  const [funnel, hoy, ultimas48h, causas, gaps, pendientes, contactos] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE estado='completado') AS completados,
        COUNT(*) FILTER (WHERE estado='esperando_pago') AS esperando_pago,
        COUNT(*) FILTER (WHERE estado IN ('triaje_completo','agendando')) AS en_proceso,
        COUNT(*) FILTER (WHERE estado='escalado') AS escalados,
        COUNT(*) FILTER (WHERE estado='cerrado') AS cerrados,
        COUNT(*) FILTER (WHERE estado='nuevo') AS nuevos,
        COUNT(*) AS total
      FROM conversations
      WHERE agent=$1
    `, [env.agentName]),
    pool.query(`
      SELECT estado, COUNT(*) AS total
      FROM conversations
      WHERE agent=$1 AND updated_at > NOW() - INTERVAL '24 hours'
      GROUP BY estado ORDER BY total DESC
    `, [env.agentName]),
    pool.query(`
      SELECT estado, COUNT(*) AS total
      FROM conversations
      WHERE agent=$1 AND updated_at > NOW() - INTERVAL '48 hours'
      GROUP BY estado ORDER BY total DESC
    `, [env.agentName]),
    pool.query(`SELECT root_cause, outcome, COUNT(*) AS total FROM conversation_insights WHERE agent=$1 GROUP BY root_cause, outcome ORDER BY total DESC LIMIT 6`, [env.agentName]),
    pool.query(`SELECT pregunta, frecuencia FROM knowledge_gaps ORDER BY frecuencia DESC LIMIT 5`),
    pool.query(`SELECT COUNT(*) AS total, MIN(created_at) AS mas_antigua FROM pending_payments`),
    pool.query(`
      SELECT
        c.estado,
        c.updated_at,
        c.triaje,
        c.messages,
        COALESCE(
          TRIM(CONCAT(cc.contact_data->>'firstName', ' ', cc.contact_data->>'lastName')),
          c.phone,
          c.contact_id
        ) AS nombre,
        c.phone
      FROM conversations c
      LEFT JOIN contact_cache cc ON cc.contact_id = c.contact_id
      WHERE c.agent=$1 AND c.estado IN ('esperando_pago','triaje_completo','agendando','escalado','nuevo')
      ORDER BY c.updated_at DESC
      LIMIT 50
    `, [env.agentName]),
  ]);

  const contactos_activos = contactos.rows.map(r => {
    const msgs = Array.isArray(r.messages) ? r.messages : [];
    const ultimos_mensajes = msgs.slice(-8).map(m => ({
      de: m.role === 'user' ? 'cliente' : 'carolina',
      texto: Array.isArray(m.content)
        ? m.content.map(c => c.text || '').join('')
        : (m.content || ''),
    }));
    return {
      nombre: r.nombre,
      telefono: r.phone,
      estado: r.estado,
      triaje: r.triaje,
      ultima_actividad: r.updated_at,
      ultimos_mensajes,
    };
  });

  return {
    totales_historicos: funnel.rows[0],
    actividad_hoy: hoy.rows,
    actividad_48h: ultimas48h.rows,
    por_que_se_caen: causas.rows,
    preguntas_sin_respuesta: gaps.rows,
    pagos_pendientes: pendientes.rows[0],
    contactos_activos,
  };
}

async function answerQuestion(question) {
  const snapshot = await getSnapshot();
  const context = JSON.stringify(snapshot, null, 2);

  const history = [
    {
      role: 'user',
      content: `Datos actuales:\n${context}\n\nPregunta: ${question}`,
    },
  ];

  return callClaude(SYSTEM_PROMPT, history, 500);
}

module.exports = { answerQuestion };
