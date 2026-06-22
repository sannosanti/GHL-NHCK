'use strict';

const { pool } = require('../db');
const { callClaude } = require('../ai/claude');

const SYSTEM_PROMPT = `Sos un asistente de gestión interno de NHC Kids. Respondés preguntas sobre cómo va el trabajo del agente WhatsApp Carolina.

Hablás como alguien del equipo, no como un sistema. Sin tecnicismos, sin mencionar bases de datos, queries, campos, ni recomendaciones técnicas. Si no tenés el dato exacto, decilo simple y directo.

Lo que significan los estados:
- nuevo: lead que acaba de escribir, Carolina aún no lo procesó o está en la primera interacción
- triaje_completo: Carolina ya recogió toda la info del caso
- agendando: están eligiendo fecha y hora para la cita
- esperando_pago: se mandó el link de pago, el cliente no pagó todavía
- completado: pagó y tiene cita confirmada
- cerrado: no se convirtió, la conversación terminó
- escalado: necesitó intervención humana

Reglas:
- Respondé en español, directo y breve
- Usá números concretos que estén en los datos
- Si hay algo que preocupa (muchos escalados, pagos sin confirmar, etc.), decilo sin rodeos
- Si algo va bien, también decilo
- Nunca sugerís cambios técnicos ni explicás cómo funciona el sistema internamente
- Máximo 5 puntos o 3 párrafos cortos`;

async function getSnapshot() {
  const [funnel, hoy, ultimas48h, causas, gaps, pendientes] = await Promise.all([
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
    `),
    pool.query(`
      SELECT estado, COUNT(*) AS total
      FROM conversations
      WHERE updated_at > NOW() - INTERVAL '24 hours'
      GROUP BY estado ORDER BY total DESC
    `),
    pool.query(`
      SELECT estado, COUNT(*) AS total
      FROM conversations
      WHERE updated_at > NOW() - INTERVAL '48 hours'
      GROUP BY estado ORDER BY total DESC
    `),
    pool.query(`SELECT root_cause, outcome, COUNT(*) AS total FROM conversation_insights GROUP BY root_cause, outcome ORDER BY total DESC LIMIT 6`),
    pool.query(`SELECT pregunta, frecuencia FROM knowledge_gaps ORDER BY frecuencia DESC LIMIT 5`),
    pool.query(`SELECT COUNT(*) AS total, MIN(created_at) AS mas_antigua FROM pending_payments`),
  ]);

  return {
    totales_historicos: funnel.rows[0],
    actividad_hoy: hoy.rows,
    actividad_48h: ultimas48h.rows,
    por_que_se_caen: causas.rows,
    preguntas_sin_respuesta: gaps.rows,
    pagos_pendientes: pendientes.rows[0],
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
