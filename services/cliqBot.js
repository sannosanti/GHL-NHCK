'use strict';

const { pool } = require('../db');
const { callClaude } = require('../ai/claude');

const SYSTEM_PROMPT = `Sos un asistente interno de NHC Kids que analiza la gestión del agente WhatsApp "Carolina".
Recibís datos reales de la base de datos y respondés preguntas sobre el estado de las conversaciones.

Datos disponibles:
- funnel: totales por etapa del proceso
- estados: distribución de todas las conversaciones
- recientes_72h: actividad de las últimas 72 horas
- root_causes: por qué se caen las conversaciones (de conversation_insights)
- knowledge_gaps: preguntas que Carolina no supo responder
- pagos_pendientes: pagos sin confirmar

Estados del funnel:
- nuevo → el cliente acaba de escribir
- triaje_completo → Carolina recogió síntomas y situación
- agendando → en proceso de elegir fecha/hora
- esperando_pago → link de pago enviado, sin confirmar
- completado → pago confirmado, cita agendada
- cerrado → conversación terminó sin agendar
- escalado → requirió intervención humana

Respondé en español neutro, de forma directa y concisa. Usá bullets si hay varios puntos.
Si hay señales de alarma (muchos escalados, pagos sin confirmar hace mucho tiempo, gaps frecuentes), marcalos claramente.
Si la gestión va bien, decilo. Máximo 4-5 puntos o 3 párrafos cortos.`;

async function getSnapshot() {
  const [funnel, estados, recientes, causas, gaps, pendientes] = await Promise.all([
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
    pool.query(`SELECT estado, COUNT(*) AS total FROM conversations GROUP BY estado ORDER BY total DESC`),
    pool.query(`SELECT estado, COUNT(*) AS total FROM conversations WHERE updated_at > NOW() - INTERVAL '72 hours' GROUP BY estado ORDER BY total DESC`),
    pool.query(`SELECT root_cause, outcome, COUNT(*) AS total FROM conversation_insights GROUP BY root_cause, outcome ORDER BY total DESC LIMIT 6`),
    pool.query(`SELECT pregunta, frecuencia FROM knowledge_gaps ORDER BY frecuencia DESC LIMIT 5`),
    pool.query(`SELECT COUNT(*) AS total, MIN(created_at) AS mas_antigua FROM pending_payments`),
  ]);

  return {
    funnel: funnel.rows[0],
    estados: estados.rows,
    recientes_72h: recientes.rows,
    root_causes: causas.rows,
    knowledge_gaps: gaps.rows,
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

  return callClaude(SYSTEM_PROMPT, history, 600);
}

module.exports = { answerQuestion };
