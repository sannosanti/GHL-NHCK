'use strict';

/**
 * Conversation replay.
 *
 * `ai/prompt.js` exposes buildSystemPrompt(estado, ctx) — the system prompt is
 * DIFFERENT per estado, and estado advances from the tags the model emits. So a
 * candidate cannot be graded by replaying a transcript against one frozen prompt:
 * a model that misses [TRIAJE_P1] never reaches the triaje_p2 prompt, and every
 * later turn would be judged against instructions it never received.
 *
 * Two modes:
 *
 *   'autoregressive' — REPLAY AUTOREGRESIVO CON MENSAJES DE USUARIO FIJOS.
 *     The model's own replies feed forward and estado advances from its own tags,
 *     but the customer's next message is the HISTORICAL one, originally provoked by
 *     a different reply. This is a COUNTERFACTUAL evaluation of the system, not a
 *     simulation of a human conversation: it measures tag propagation, error
 *     accumulation, state drift and context degradation — it does NOT tell you how
 *     the patient would have reacted to a different answer. Do not read a result
 *     here as "this is what production would have said end to end".
 *
 *   'teacher_forced' — history is the real production transcript and estado follows
 *     the gold-labeled path, so every turn starts from the same point for every
 *     model. Isolates per-turn decision quality; blind to error compounding.
 *
 * A model that scores well teacher-forced and badly autoregressive is fragile, not
 * incapable — and that changes whether the fix is prompt work or a different model.
 */

const { buildSystemPrompt } = require('../ai/prompt');
const { gradeTurn, parseTags, normalizeExpectedTags } = require('./graders');
const { resolveStateTransition, mergeCtxUpdate } = require('./state-spec');
const { simulateEffects, financialEffects, diffEffects } = require('./effects');

const asTags = list => (list || []).map(n => (typeof n === 'string' ? { name: n, payload: null } : n));

/** Estado transition only. Kept as a named export because the tests target it. */
function transition(estado, tags) {
  return resolveStateTransition(estado, asTags(tags)).nextState;
}

/** Does the exchange continue after this turn? */
function stopsReplay(estado, tags) {
  return !resolveStateTransition(estado, asTags(tags)).continueConversation;
}

/**
 * Apply a resolved decision's ctxUpdates to the running context.
 *
 * `estado` matters: the NOMBRE_PADRE rule only applies from 'nuevo', so passing a
 * placeholder silently drops the name. Defaults to 'nuevo' so the helper applies
 * every rule that can ever apply; the replay loop does not use this — it calls
 * resolveStateTransition directly with the real estado.
 */
function updateCtx(ctx, tags, estado = 'nuevo') {
  const { ctxUpdates } = resolveStateTransition(estado, asTags(tags), ctx);
  return mergeCtxUpdate({ ...ctx, triaje: { ...(ctx.triaje || {}) } }, ctxUpdates);
}

/** Stable comparison key for the ctx fields the prompt actually reads back. */
function ctxKey(ctx) {
  return JSON.stringify({
    nombre: ctx.nombre || '',
    p1: ctx.triaje?.p1 || '',
    p2: ctx.triaje?.p2 || '',
    p3: ctx.triaje?.p3 || '',
    derivadoA: ctx.derivadoA || null,
  });
}

/**
 * Classify a thrown error. An adapter or transport problem must never be scored as
 * a capability failure — a 404 from a wrong model id would otherwise read as "the
 * model refused to emit the tag".
 */
function classifyError(err) {
  const m = String(err?.message || err);
  if (/\b(429|rate.?limit)\b/i.test(m)) return 'rate_limit';
  if (/\b(401|403|invalid.?api.?key|authentication)\b/i.test(m)) return 'integration_error';
  if (/\b(404|model.*not.*found|missing model id)\b/i.test(m)) return 'integration_error';
  if (/\b(5\d\d|ECONN|ETIMEDOUT|socket|network|fetch failed)\b/i.test(m)) return 'transport_error';
  return 'integration_error';
}

async function replayConversation(adapter, conv, { maxTokens = 600, mode = 'autoregressive', maxRetries = 2 } = {}) {
  let estado = conv.seed_estado || 'nuevo';
  let ctx = {
    nombre: '',
    triaje: {},
    // Frozen so every model and every repetition sees identical availability.
    disponibilidadTexto: conv.disponibilidad || 'No consultada',
    derivadoA: conv.derivado_a || null,
    // Data-dependent condition for [MEDIO_WOMPI] (ghl.js:274). Deliberately left
    // `undefined` when the gold set does not declare it: the resolver then returns
    // INDETERMINATE instead of picking a behavior, and the turn is excluded from
    // the estado/ctx/efectos/financiero axes rather than scored against a guess.
    pendingPayment: conv.pending_payment,
    ...(conv.seed_ctx || {}),
  };

  const history = [];
  const turns = [];
  const priorQuestions = [];
  let totalCost = 0;
  const latencies = [];
  const usageTotal = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  for (const goldTurn of conv.turns) {
    history.push({ role: 'user', content: goldTurn.user });

    const estadoEntrada = estado;
    const ctxEntrada = ctx;
    const goldTags = normalizeExpectedTags(goldTurn.expect?.tags_required);
    const clinical = Boolean(goldTurn.expect?.clinical);

    const system = await buildSystemPrompt(estado, ctx);

    let result = null;
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        result = await adapter.call({ system, messages: history, maxTokens });
        break;
      } catch (err) {
        lastError = err;
        const kind = classifyError(err);
        // Only transient classes are worth retrying. A wrong model id will fail
        // identically forever.
        if (kind !== 'rate_limit' && kind !== 'transport_error') break;
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }

    if (!result) {
      turns.push({
        error: String(lastError?.message || lastError),
        errorKind: classifyError(lastError),
        estadoEntrada,
        clinical,
        retries: maxRetries,
      });
      break;
    }

    const grade = gradeTurn({
      raw: result.text,
      userMessage: goldTurn.user,
      expect: goldTurn.expect || {},
      priorQuestions,
    });

    const modelTags = parseTags(result.text);

    // --- Outcome comparison, reported on five independent axes ----------------
    // A model can emit exactly the right tag NAMES and still land in the wrong
    // estado, or fire the wrong effects, because combination and branch precedence
    // decide the outcome. Graded separately so the report says which one broke.
    //
    // Effects are SIMULATED, never executed — see effects.js.
    const got = resolveStateTransition(estadoEntrada, modelTags, ctxEntrada);
    const want = resolveStateTransition(estadoEntrada, goldTags, ctxEntrada);

    // If either side is indeterminate, production's behavior depends on data the
    // gold set did not declare. Those axes are marked NOT APPLICABLE for this turn
    // instead of scored — a guess here would be indistinguishable from a real
    // failure in the report. `tags` and `flow` still grade normally: what the model
    // emitted and how it wrote it do not depend on the missing data.
    const indeterminado = got.indeterminate || want.indeterminate;

    const ctxGot = indeterminado ? ctxEntrada
      : mergeCtxUpdate({ ...ctxEntrada, triaje: { ...(ctxEntrada.triaje || {}) } }, got.ctxUpdates);
    const ctxWant = indeterminado ? ctxEntrada
      : mergeCtxUpdate({ ...ctxEntrada, triaje: { ...(ctxEntrada.triaje || {}) } }, want.ctxUpdates);

    const efectosGot = simulateEffects(got.effects || []);
    const efectosWant = simulateEffects(want.effects || []);
    const efectosDiff = diffEffects(efectosGot, efectosWant);

    // Financial axis. Every turn is a decision point.
    //
    // Keyed on the resolved FINANCIAL EFFECTS, not on a single tag: there are three
    // paths that touch money — [CITA_CONFIRMADA] (Wompi link + pending_payments),
    // [MEDIO_WOMPI] (a second Wompi link, ghl.js:275) and
    // [MEDIO_TRANSFERENCIA]/[MEDIO_QR] (publish the real bank account). Gating on
    // CITA_CONFIRMADA alone left the other two unguarded.
    const finGot = financialEffects(efectosGot);
    const finWant = financialEffects(efectosWant);
    const debiaCobrar = finWant.length > 0;
    const cobro = finGot.length > 0;
    const financiero = {
      expected: debiaCobrar,
      actual: cobro,
      outcome: debiaCobrar ? (cobro ? 'TP' : 'FN') : (cobro ? 'FP' : 'TN'),
      efectosSimulados: finGot,
      efectosEsperados: finWant,
      sobrantes: efectosDiff.sobrantesFinancieros,
      faltantes: efectosDiff.faltantesFinancieros,
    };

    const outcome = {
      estado: { got: got.nextState, want: want.nextState, ok: got.nextState === want.nextState },
      ctx: { ok: ctxKey(ctxGot) === ctxKey(ctxWant), got: ctxKey(ctxGot), want: ctxKey(ctxWant) },
      efectos: efectosDiff,
      financiero,
      matchedRule: { got: got.matchedRule, want: want.matchedRule, ok: got.matchedRule === want.matchedRule },
      continues: { got: got.continueConversation, want: want.continueConversation,
        ok: got.continueConversation === want.continueConversation },
    };

    turns.push({
      estadoEntrada,
      user: goldTurn.user,
      raw: result.text,
      patientText: grade.patientText,
      tags: grade.tags,
      // `undefined` en un eje = NO APLICA para este turno, y el agregador lo saca
      // del denominador. No es lo mismo que "pasó".
      pass: {
        ...grade.pass,
        ...(indeterminado ? {} : {
          estado: outcome.estado.ok,
          ctx: outcome.ctx.ok,
          efectos: efectosDiff.ok,
          financiero: financiero.outcome === 'TP' || financiero.outcome === 'TN',
        }),
      },
      outcome,
      financiero: indeterminado ? { outcome: null, indeterminado: true } : financiero,
      indeterminado,
      indeterminateReason: got.indeterminateReason || want.indeterminateReason || null,
      escalation: grade.escalation,
      clinical,
      failures: grade.failures,
      latencyMs: result.latencyMs,
      costUsd: result.costUsd,
      usage: result.usage,
    });

    priorQuestions.push(...grade.questionsAsked);
    totalCost += result.costUsd;
    latencies.push(result.latencyMs);
    for (const k of Object.keys(usageTotal)) usageTotal[k] += result.usage[k] || 0;

    if (mode === 'teacher_forced') {
      // Teacher forcing: the customer's next message was caused by the reply they
      // actually received, so that reply is the causally correct context. The
      // state path and the context come from the GOLD tags — payloads included, so
      // later prompts are built with the real name and triage answers.
      history.push({
        role: 'assistant',
        content: goldTurn.assistant_real || grade.patientText || '(sin texto)',
      });
      ctx = ctxWant;
      if (want.indeterminate) break; // no hay estado siguiente que se pueda afirmar
      estado = want.nextState;
      if (!want.continueConversation) break;
    } else {
      history.push({ role: 'assistant', content: grade.patientText || '(sin texto)' });
      ctx = ctxGot;
      if (got.indeterminate) break;
      estado = got.nextState;
      if (!got.continueConversation) break;
    }
  }

  return {
    model: adapter.label,
    mode,
    conversationId: conv.id,
    stratum: conv.stratum || null,
    critical: Boolean(conv.critical),
    estadoFinal: estado,
    turns,
    totalCostUsd: totalCost,
    usageTotal,
    latencyMsAvg: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    latencyMsP95: latencies.length ? [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] : null,
  };
}

module.exports = { replayConversation, transition, stopsReplay, updateCtx, classifyError };
