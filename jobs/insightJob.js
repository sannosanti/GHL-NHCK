'use strict';

const { callClaude } = require('../ai/claude');
const db = require('../db');

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
  } catch (err) {
    console.error('[insightJob] Error analyzing conversation:', err.message);
  }
}

function triggerAnalysis(conversationId, contactId, outcome) {
  setImmediate(() => {
    analyzeConversation(conversationId, contactId, outcome).catch(() => {});
  });
}

module.exports = { triggerAnalysis };
