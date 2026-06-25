'use strict';

const crypto = require('crypto');
const { callClaude } = require('../ai/claude');
const db = require('../db');
const { notify } = require('../services/notifier');

const SERVER_URL = 'https://miraculous-solace-production-47dd.up.railway.app';
const PATTERN_THRESHOLD = 3;

const SYSTEM_PROMPT = `Eres un analista experto en conversaciones de ventas para NHC Kids, un centro de evaluación neurológica infantil en Medellín, Colombia. Tu rol es analizar conversaciones de WhatsApp entre Carolina (asesora IA) y potenciales clientes para identificar oportunidades de mejora.

Responde ÚNICAMENTE con JSON válido, sin texto adicional antes ni después.`;

async function analyzeConversation(conversationId, contactId, outcome) {
  try {
    const conv = await db.getConversationData(conversationId);
    if (!conv) return;

    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    if (messages.length < 3) return;

    const conversationText = messages.slice(-15).map(m => {
      const role = m.role === 'user' ? 'CLIENTE' : 'CAROLINA';
      const content = Array.isArray(m.content)
        ? m.content.map(c => c.text || '').join('')
        : (m.content || '');
      return `${role}: ${content}`;
    }).join('\n');

    const t = conv.triaje || {};
    const triajeText = t.triaje1
      ? `Síntoma: ${t.triaje1} | Tiempo: ${t.triaje2 || '-'} | Previo: ${t.triaje3 || '-'}`
      : 'Triaje no completado';

    const history = [{
      role: 'user',
      content: [{
        type: 'text',
        text: `RESULTADO: ${outcome}
ESTADO FINAL: ${conv.estado}
TRIAJE: ${triajeText}
MENSAJES: ${messages.length}

CONVERSACIÓN (últimos mensajes):
${conversationText}

Analiza y responde con este JSON exacto:
{
  "drop_off_point": "En qué momento y por qué se perdió el usuario (1-2 oraciones concretas)",
  "root_cause": "Una de: precio | friccion | falta_info | fuera_segmento | fuera_ciudad | sin_presupuesto | caso_complejo | completado | desistio",
  "missed_questions": ["pregunta que el cliente hizo y Carolina no respondió bien"],
  "what_worked": "Qué hizo bien Carolina en esta conversación",
  "improvement_suggestion": "Una sugerencia concreta y accionable para mejorar Carolina en casos similares"
}`
      }]
    }];

    const raw = await callClaude(SYSTEM_PROMPT, history, 800);

    let analysis;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      analysis = match ? JSON.parse(match[0]) : null;
    } catch { analysis = null; }

    if (!analysis) {
      console.log(`[insightJob] Could not parse analysis for ${conversationId}`);
      return;
    }

    const VALID_ROOT_CAUSES = ['precio', 'friccion', 'falta_info', 'fuera_segmento', 'fuera_ciudad', 'sin_presupuesto', 'caso_complejo', 'completado', 'desistio'];
    if (!VALID_ROOT_CAUSES.includes(analysis.root_cause)) {
      analysis.root_cause = 'desistio';
    }

    await db.saveConversationInsight(conversationId, contactId, outcome, conv.estado, analysis);
    console.log(`[insightJob] Insight saved for ${conversationId} — root_cause: ${analysis.root_cause}`);

    await maybeGenerateRecommendation(analysis.root_cause);
  } catch (err) {
    console.error('[insightJob] Error analyzing conversation:', err.message);
  }
}

const RECOMMENDATION_SYSTEM = `Eres un experto en optimización de asesoras de ventas IA para centros de salud infantil. Analizás insights de conversaciones reales y generás recomendaciones concretas para mejorar el comportamiento de Carolina, la asesora virtual de NHC Kids.

Responde ÚNICAMENTE con JSON válido, sin texto adicional.`;

async function maybeGenerateRecommendation(rootCause) {
  try {
    if (['completado', 'fuera_segmento', 'fuera_ciudad'].includes(rootCause)) return;

    const count = await db.countInsightsByRootCause(rootCause);
    if (count < PATTERN_THRESHOLD) return;

    const alreadyPending = await db.hasPendingUpdateForRootCause(rootCause);
    if (alreadyPending) return;

    const insights = await db.getRecentInsightSuggestions(rootCause);
    if (!insights.length) return;

    const insightText = insights.map((r, i) =>
      `Caso ${i + 1}:\n- Problema: ${r.drop_off_point || '-'}\n- Lo que funcionó: ${r.what_worked || '-'}\n- Sugerencia individual: ${r.improvement_suggestion || '-'}`
    ).join('\n\n');

    const history = [{
      role: 'user',
      content: [{
        type: 'text',
        text: `Se detectaron ${count} conversaciones con causa raíz "${rootCause}" en los últimos 30 días.

Insights recopilados:
${insightText}

Generá una recomendación concreta para mejorar el comportamiento de Carolina. Respondé con este JSON:
{
  "recommendation": "Texto exacto que se agregaría al prompt de Carolina como regla o comportamiento nuevo. Máximo 3 oraciones. En español neutro.",
  "reason": "Por qué se recomienda este cambio, basado en los insights. 1-2 oraciones."
}`
      }]
    }];

    const raw = await callClaude(RECOMMENDATION_SYSTEM, history, 400);
    let result;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      result = match ? JSON.parse(match[0]) : null;
    } catch { result = null; }

    if (!result?.recommendation) return;

    const id = crypto.randomUUID();
    const approvalKey = crypto.randomBytes(20).toString('hex');
    await db.savePendingUpdate(id, approvalKey, rootCause, result.recommendation, result.reason);

    const approvalUrl = `${SERVER_URL}/admin/update/${id}?key=${approvalKey}`;
    await notify(
      `🧠 *Sugerencia de aprendizaje para Carolina*\n\n` +
      `*Patrón detectado:* ${count} conversaciones con causa raíz "${rootCause}"\n\n` +
      `*Motivo:* ${result.reason}\n\n` +
      `*Recomendación:*\n${result.recommendation}\n\n` +
      `✅ *Aprobar:* ${approvalUrl}\n\n` +
      `_Si no hacés nada, la sugerencia queda pendiente._`
    );
    console.log(`[insightJob] Recomendación generada y enviada a Cliq — root_cause: ${rootCause}, id: ${id}`);
  } catch (err) {
    console.error('[insightJob] Error generando recomendación:', err.message);
  }
}

function triggerAnalysis(conversationId, contactId, outcome) {
  setImmediate(() => {
    analyzeConversation(conversationId, contactId, outcome).catch(() => {});
  });
}

module.exports = { triggerAnalysis };
