'use strict';

/**
 * What the evaluation itself costs to run, before spending anything.
 *
 *   node eval/estimate-cost.js
 *   node eval/estimate-cost.js --convs 203 --turns 4 --reps 5 --modes 2
 *
 * Every input is a labeled assumption, not a fudge factor. Where a number is
 * measured it says so; where it is estimated it says that too, so the estimate
 * can be audited and re-run rather than believed.
 */

const { PRICING } = require('./adapters');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

const ASSUMPTIONS = {
  // MEASURED: sum of the STRATA quotas in extract-dataset.js.
  convs: arg('convs', 80 + 40 + 25 + 13 + 20 + 10 + 15),

  // ESTIMATED: customer turns per conversation. Conversations with fewer than 2
  // are dropped by the extractor. Calibrate from the draft gold set once it
  // exists — it is the single largest source of error in this estimate.
  turns: arg('turns', 4),

  reps: arg('reps', 5),      // repetitions per conversation, for the consistency metric
  modes: arg('modes', 2),    // closed-loop + open-loop
  models: arg('models', 3),

  // ESTIMATED from two independent directions that agree within ~15%:
  //  (a) ai/prompt.js + config/index.js hold ~49KB of source; the assembled
  //      system prompt is roughly 12-18KB of Spanish text ≈ 3.4k-5.1k tokens.
  //  (b) July production aggregate implies ~4.1k prompt tokens per call.
  systemPromptTokens: arg('systemPrompt', 4000),

  // ESTIMATED: the brand-level block carries cache_control; the per-call suffix
  // (fecha, disponibilidad, tarea del estado) does not.
  cachedFraction: arg('cachedFraction', 0.85),

  // ESTIMATED: history accumulated by mid-conversation, at ~150 tokens per turn.
  avgHistoryTokens: arg('history', 300),

  // ESTIMATED: max_tokens is 600, but the prompt caps replies at 2 paragraphs.
  outputTokens: arg('output', 120),
};

function perCall(rateKey, a) {
  const cached = Math.round(a.systemPromptTokens * a.cachedFraction);
  const uncached = a.systemPromptTokens - cached + a.avgHistoryTokens;
  const p = PRICING[rateKey];
  return (cached * p.cacheRead + uncached * p.input + a.outputTokens * p.output) / 1_000_000;
}

const a = ASSUMPTIONS;
const callsPerModel = a.convs * a.turns * a.reps * a.modes;
const totalCalls = callsPerModel * a.models;

console.log('SUPUESTOS');
for (const [k, v] of Object.entries(a)) console.log(`  ${k.padEnd(20)} ${v}`);
console.log(`\nLlamadas por modelo: ${callsPerModel.toLocaleString()}`);
console.log(`Llamadas totales:    ${totalCalls.toLocaleString()}\n`);

console.log('COSTO ESTIMADO');
let total = 0;
for (const [label, rateKey] of [['Sonnet 4.5', 'claude-sonnet-4-5'], ['Luna', 'luna'], ['Terra', 'terra']]) {
  const c = perCall(rateKey, a) * callsPerModel;
  total += c;
  console.log(`  ${label.padEnd(12)} $${perCall(rateKey, a).toFixed(6)}/llamada  →  $${c.toFixed(2)}`);
}
console.log(`  ${'TOTAL'.padEnd(12)} ${' '.repeat(22)}$${total.toFixed(2)}`);
console.log(`  ${'+20% margen'.padEnd(12)} ${' '.repeat(22)}$${(total * 1.2).toFixed(2)}   (reintentos, errores de API, re-corridas)`);

console.log('\nSENSIBILIDAD — el supuesto que más mueve el número es `turns`:');
for (const t of [3, 4, 5, 6]) {
  const alt = { ...a, turns: t };
  const sum = ['claude-sonnet-4-5', 'luna', 'terra']
    .reduce((s, k) => s + perCall(k, alt) * alt.convs * t * alt.reps * alt.modes, 0);
  console.log(`  turns=${t}  →  $${sum.toFixed(2)}`);
}
