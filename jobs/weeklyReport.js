'use strict';

const cron = require('node-cron');
const { callClaude } = require('../ai/claude');
const { notify } = require('../services/notifier');
const db = require('../db');

async function runWeeklyReport() {
  console.log('[weeklyReport] Generando reporte semanal...');

  const insights = await db.getWeeklyInsights();
  if (!insights || insights.length === 0) {
    console.log('[weeklyReport] Sin insights esta semana');
    return null;
  }

  const outcomes = {};
  const rootCauses = {};
  const allMissedQuestions = [];
  const allSuggestions = [];

  for (const i of insights) {
    outcomes[i.outcome] = (outcomes[i.outcome] || 0) + 1;
    if (i.root_cause) rootCauses[i.root_cause] = (rootCauses[i.root_cause] || 0) + 1;
    if (Array.isArray(i.missed_questions)) allMissedQuestions.push(...i.missed_questions);
    if (i.improvement_suggestion) allSuggestions.push(i.improvement_suggestion);
  }

  const history = [{
    role: 'user',
    content: [{
      type: 'text',
      text: `Eres analista de mejora continua para Carolina, asesora IA de NHC Kids.

DATOS DE LA SEMANA — ${insights.length} conversaciones analizadas:

Outcomes: ${JSON.stringify(outcomes)}
Causas raíz más frecuentes: ${JSON.stringify(rootCauses)}
Preguntas sin respuesta detectadas: ${[...new Set(allMissedQuestions)].slice(0, 15).join(' | ')}
Sugerencias individuales: ${allSuggestions.slice(0, 10).join(' | ')}

Genera un reporte ejecutivo con:
1. LOS 3 PROBLEMAS PRINCIPALES de la semana
2. LAS 3 PREGUNTAS que Carolina no sabe responder y debería aprender
3. UNA MEJORA DE ALTO IMPACTO para el prompt o el conocimiento base
4. QUÉ ESTÁ FUNCIONANDO BIEN

Sé concreto y accionable. Máximo 350 palabras. Español.`,
    }],
  }];

  const report = await callClaude(
    'Eres analista de mejora continua de IA de ventas. Directo y accionable.',
    history,
    1000
  );

  const uniqueQuestions = [...new Set(allMissedQuestions)];
  for (const q of uniqueQuestions.slice(0, 10)) {
    await db.saveKnowledgeGap(q, null);
  }

  const semana = new Date().toLocaleDateString('es-CO');
  console.log('\n========== REPORTE SEMANAL CAROLINA ==========');
  console.log(`Semana: ${semana} | Conversaciones: ${insights.length}`);
  console.log(report);
  console.log('===============================================\n');

  await notify(`📊 *Reporte Semanal Carolina — ${semana}*\n_${insights.length} conversaciones analizadas_\n\n${report}`);

  return { report, insights: insights.length, outcomes, rootCauses };
}

function startWeeklyReport() {
  // Every Monday at 8am Colombia time (UTC-5 = 13:00 UTC)
  cron.schedule('0 13 * * 1', () => {
    runWeeklyReport().catch(err => console.error('[weeklyReport] Error:', err.message));
  });
  console.log('Weekly report job scheduled (lunes 8am Colombia) ✓');
}

module.exports = { startWeeklyReport, runWeeklyReport };
