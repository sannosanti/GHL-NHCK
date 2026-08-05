'use strict';

/**
 * Adapter smoke test. MUST pass before running the full evaluation.
 *
 *   node eval/verify-adapters.js
 *
 * Six real calls total (two per adapter), a few cents. The point is to fail loudly
 * on integration problems while they still cost nothing, because in the full run
 * they are indistinguishable from capability failures: a wrong model id returns a
 * 404, the turn is scored as "did not emit the tag", and the report says the model
 * cannot follow the prompt.
 *
 * The OpenAI adapter assumes /v1/chat/completions, max_completion_tokens, two
 * system messages, choices[0].message.content, and
 * usage.prompt_tokens_details.cached_tokens. Every one of those is a guess about
 * the GPT-5.6 surface until this script confirms it against the live API.
 */

const { buildAdapters } = require('./adapters');
const { classifyError } = require('./replay');
const { sanitizarError } = require('./extract-lib');

// Long enough to clear the caching minimum, so the second call can show a hit.
const CACHED_BLOCK = [
  'Eres una asesora comercial. Respondé siempre en español, en una sola oración corta.',
  'Reglas de prueba de integración, repetidas para superar el mínimo de tokens cacheables:',
  ...Array.from({ length: 60 }, (_, i) => `Regla ${i + 1}: mantené el tono cálido y no inventes precios ni datos.`),
].join('\n');

const SYSTEM = { cached: CACHED_BLOCK, dynamic: 'Contexto de la llamada: prueba de integración.' };
const MESSAGES = [{ role: 'user', content: 'Decí exactamente: LISTO' }];

const checks = [];
function check(adapter, name, ok, detail) {
  checks.push({ adapter, name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `  << ${detail}`}`);
}

async function verify(adapter) {
  console.log(`\n=== ${adapter.label} ===`);

  let first;
  try {
    first = await adapter.call({ system: SYSTEM, messages: MESSAGES, maxTokens: 64 });
  } catch (err) {
    const kind = classifyError(err);
    check(adapter.label, 'la llamada responde', false, `${kind}: ${sanitizarError(err).message}`);
    console.log(`  → ${kind}. NO es una falla de capacidad del modelo. Revisá id, endpoint y credenciales.`);
    return;
  }

  check(adapter.label, 'la llamada responde', true);
  check(adapter.label, 'devuelve texto no vacío', typeof first.text === 'string' && first.text.trim().length > 0,
    JSON.stringify(first.text));
  check(adapter.label, 'no viene truncado a cero tokens', (first.usage.output || 0) > 0,
    `output=${first.usage.output}`);

  for (const f of ['input', 'output', 'cacheWrite', 'cacheRead']) {
    check(adapter.label, `usage.${f} es numérico`, Number.isFinite(first.usage[f]), String(first.usage[f]));
  }
  check(adapter.label, 'reporta costo > 0', first.costUsd > 0, String(first.costUsd));
  check(adapter.label, 'reporta latencia', Number.isFinite(first.latencyMs) && first.latencyMs > 0, String(first.latencyMs));

  // Second identical call — the cached prefix should now register a hit.
  await new Promise(r => setTimeout(r, 1500));
  let second;
  try {
    second = await adapter.call({ system: SYSTEM, messages: MESSAGES, maxTokens: 64 });
  } catch (err) {
    check(adapter.label, 'segunda llamada responde', false, `${classifyError(err)}: ${sanitizarError(err).message}`);
    return;
  }
  const hit = (second.usage.cacheRead || 0) > 0;
  check(adapter.label, 'el caché registra lectura en la 2ª llamada', hit,
    `cacheRead=${second.usage.cacheRead}. Sin caché, el costo real sube frente a la proyección.`);

  console.log(`  muestra: ${JSON.stringify(first.text.slice(0, 60))}`);
  console.log(`  usage#1: ${JSON.stringify(first.usage)}`);
  console.log(`  usage#2: ${JSON.stringify(second.usage)}`);
}

async function verifyErrorClassification() {
  console.log('\n=== clasificación de errores ===');
  const { openaiAdapter } = require('./adapters');
  try {
    const bogus = openaiAdapter({ modelId: 'modelo-que-no-existe-000', rateKey: 'luna', label: 'bogus' });
    await bogus.call({ system: SYSTEM, messages: MESSAGES, maxTokens: 16 });
    check('bogus', 'un id inválido falla', false, 'no lanzó error');
  } catch (err) {
    const kind = classifyError(err);
    check('bogus', 'un id inválido se clasifica como integration_error', kind === 'integration_error', kind);
  }
}

async function main() {
  require('./preflight').assertAislado();
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠️ falta ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY) console.warn('⚠️ falta OPENAI_API_KEY');
  if (!process.env.EVAL_LUNA_MODEL || !process.env.EVAL_TERRA_MODEL) {
    console.warn('⚠️ faltan EVAL_LUNA_MODEL / EVAL_TERRA_MODEL — los ids exactos van por env, no se adivinan');
  }

  let adapters;
  try {
    adapters = buildAdapters();
  } catch (err) {
    console.error(`\n❌ No se pudieron construir los adapters: ${sanitizarError(err).message}`);
    process.exit(1);
  }

  for (const a of adapters) await verify(a);
  await verifyErrorClassification();

  const failed = checks.filter(c => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} verificaciones OK`);
  if (failed.length) {
    console.log('\nNO CORRAS LA EVALUACIÓN TODAVÍA. Fallas:');
    for (const f of failed) console.log(`  · [${f.adapter}] ${f.name} — ${f.detail ?? ''}`);
    process.exit(1);
  }
  console.log('Adapters verificados. Recién ahora tiene sentido correr eval/run.js.');
}

// El error de un proveedor de modelos puede incluir el request completo.
if (require.main === module) main().catch(err => {
  console.error(sanitizarError(err).stack);
  process.exit(1);
});
