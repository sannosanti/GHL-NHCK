'use strict';

/**
 * Tests for the aggregation, statistics and gate layer.
 *
 *   node eval/pipeline.test.js
 *
 * These use synthetic run fixtures — no network, no database. The properties under
 * test are the ones that decide whether a number in the report can be trusted:
 * that repetitions do not inflate the sample, that a comparison is paired, that the
 * cost projection refuses to guess, and that the gate fails closed.
 */

const assert = require('assert');
const { toClusters, aggregate, compare, evaluateGate, projectCost, MIN_CLINICAL_POSITIVES } = require('./run');
const { clusterBootstrap, pairedBootstrap, mcnemar, wilson } = require('./stats');
const { normalizeExpectedTags } = require('./graders');
const { updateCtx } = require('./replay');

let n = 0, failed = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

/** Build a synthetic run. `outcomes` is one entry per turn. */
function run({ model = 'm', mode = 'autoregressive', id = 'c1', stratum = 'happy_path', critical = false,
  outcomes = [], cost = 0.01, estadoFinal = 'triaje_p2' }) {
  return {
    model, mode, conversationId: id, stratum, critical, estadoFinal,
    turns: outcomes.map(o => o.error ? { error: o.error, errorKind: o.errorKind, clinical: !!o.clinical }
      : {
        pass: { tags: o.tags !== false, flow: true, estado: o.estado !== false, ctx: true, efectos: true,
          ...(o.escalation ? { escalation: o.escalation.outcome === 'TP' || o.escalation.outcome === 'TN' } : {}) },
        escalation: o.escalation || { isDecisionPoint: false, outcome: null, expected: null },
        clinical: !!o.clinical,
        failures: [], latencyMs: 100, costUsd: cost / Math.max(outcomes.length, 1),
        usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 20 },
      }),
    totalCostUsd: cost,
    usageTotal: { input: 10, output: 5, cacheWrite: 0, cacheRead: 20 },
    latencyMsAvg: 100, latencyMsP95: 120,
  };
}
const esc = (outcome, expected) => ({ isDecisionPoint: true, outcome, expected });

console.log('\nPUNTO 1 — payloads del contexto');

test('1. normalizeExpectedTags acepta string y objeto', () => {
  assert.deepStrictEqual(normalizeExpectedTags(['ESCALAR']), [{ name: 'ESCALAR', payload: null }]);
  assert.deepStrictEqual(normalizeExpectedTags([{ name: 'TRIAJE_P1', payload: 'TDAH' }]),
    [{ name: 'TRIAJE_P1', payload: 'TDAH' }]);
});

test('2. REGRESIÓN: el gold set con payloads llena el contexto de verdad', () => {
  // Antes se reconstruía como payload:null, así que el estado avanzaba pero los
  // prompts siguientes se armaban con nombre vacío y triaje vacío.
  const tags = normalizeExpectedTags([
    { name: 'NOMBRE_PADRE', payload: 'Ana Gómez' },
    { name: 'TRIAJE_P1', payload: 'Dificultad para concentrarse' },
  ]);
  const ctx = updateCtx({ nombre: '', triaje: {} }, tags);
  assert.strictEqual(ctx.nombre, 'Ana Gómez');
  assert.strictEqual(ctx.triaje.p1, 'Dificultad para concentrarse');
});

test('3. sin payload el contexto queda vacío (el modo que teníamos)', () => {
  const ctx = updateCtx({ nombre: '', triaje: {} }, normalizeExpectedTags(['NOMBRE_PADRE', 'TRIAJE_P1']));
  assert.strictEqual(ctx.nombre, '');
  assert.strictEqual(ctx.triaje.p1, undefined);
});

console.log('\nPUNTO 2 — las repeticiones no son pacientes independientes');

test('4. toClusters colapsa las repeticiones en UN cluster por conversación', () => {
  const runs = [
    run({ id: 'c1', outcomes: [{ tags: true }] }),
    run({ id: 'c1', outcomes: [{ tags: true }] }),
    run({ id: 'c1', outcomes: [{ tags: false }] }),
    run({ id: 'c2', outcomes: [{ tags: true }] }),
  ];
  const cs = toClusters(runs);
  assert.strictEqual(cs.length, 2, 'dos conversaciones, no cuatro observaciones');
  assert.strictEqual(cs[0].reps, 3);
  assert.strictEqual(cs[0].metrics.tags.n, 3, 'los turnos de las 3 reps suman dentro del cluster');
});

test('5. REGRESIÓN: los positivos clínicos se cuentan una vez, no una por repetición', () => {
  const one = { tags: true, clinical: true, escalation: esc('TP', true) };
  const cs = toClusters([
    run({ id: 'c1', critical: true, outcomes: [one] }),
    run({ id: 'c1', critical: true, outcomes: [one] }),
    run({ id: 'c1', critical: true, outcomes: [one] }),
    run({ id: 'c1', critical: true, outcomes: [one] }),
    run({ id: 'c1', critical: true, outcomes: [one] }),
  ]);
  assert.strictEqual(cs[0].labeledClinicalPositives, 1,
    'replayar 5 veces el mismo caso clínico no crea 5 pacientes');
});

test('6. el bootstrap clusterizado da un IC más ancho que Wilson sobre turnos pooleados', () => {
  // 20 conversaciones, 5 reps cada una, una falla concentrada en 4 conversaciones.
  const runs = [];
  for (let i = 0; i < 20; i++) {
    for (let r = 0; r < 5; r++) runs.push(run({ id: `c${i}`, outcomes: [{ tags: i >= 4 }] }));
  }
  const cs = toClusters(runs);
  const boot = clusterBootstrap(cs, s => {
    const d = s.reduce((a, c) => a + c.metrics.tags.n, 0);
    return d ? s.reduce((a, c) => a + c.metrics.tags.pass, 0) / d : null;
  }, { B: 500 });
  const pooled = wilson(80, 100); // el error de tratar 100 turnos como independientes
  const anchoBoot = boot.hi - boot.lo;
  const anchoWilson = pooled.hi - pooled.lo;
  assert.ok(anchoBoot > anchoWilson,
    `bootstrap ${anchoBoot.toFixed(3)} debería ser más ancho que Wilson ${anchoWilson.toFixed(3)}`);
});

console.log('\nPUNTO 3 — comparación pareada');

test('7. McNemar solo usa los pares discordantes', () => {
  const m = mcnemar([
    { id: 'a', baselineOk: true, candidateOk: true },
    { id: 'b', baselineOk: false, candidateOk: false },
    { id: 'c', baselineOk: true, candidateOk: false },
    { id: 'd', baselineOk: true, candidateOk: false },
  ]);
  assert.strictEqual(m.b, 2); assert.strictEqual(m.c, 0);
  assert.strictEqual(m.both, 1); assert.strictEqual(m.neither, 1);
  assert.strictEqual(m.n, 2, 'los concordantes no informan');
});

test('8. McNemar identifica EN QUÉ conversaciones difieren', () => {
  const m = mcnemar([
    { id: 'conv-7', baselineOk: true, candidateOk: false },
    { id: 'conv-9', baselineOk: false, candidateOk: true },
  ]);
  assert.deepStrictEqual(m.discordant.baselineOnly, ['conv-7']);
  assert.deepStrictEqual(m.discordant.candidateOnly, ['conv-9']);
});

test('9. McNemar detecta una diferencia sistemática que el solapamiento de IC no vería', () => {
  const pairs = Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`, baselineOk: true, candidateOk: i >= 12,
  }));
  const m = mcnemar(pairs);
  assert.strictEqual(m.b, 12); assert.strictEqual(m.c, 0);
  assert.ok(m.significant, `p=${m.p}`);
});

test('10. el bootstrap pareado evalúa ambos modelos sobre las MISMAS conversaciones', () => {
  const pairs = Array.from({ length: 25 }, (_, i) => ({
    baseline: { v: 1 },
    candidate: { v: i < 20 ? 1 : 0 },
  }));
  const d = pairedBootstrap(pairs, s => s.reduce((a, x) => a + x.v, 0) / s.length, { B: 500 });
  assert.ok(d.point < 0, 'el candidato es peor');
  assert.ok(d.significant, 'y el IC de la diferencia excluye 0');
});

console.log('\nPUNTO 4 — proyección de costo');

test('11. REGRESIÓN: sin stratum_frequencies NO se proyecta factura', () => {
  const cs = toClusters([run({ id: 'c1', stratum: 'escalado_clinico', cost: 0.05 })]);
  const p = projectCost(cs, null, 2123);
  assert.strictEqual(p.monthly, null);
  assert.match(p.note, /stratum_frequencies/);
});

test('12. la ponderación corrige el sesgo del muestreo estratificado', () => {
  const cs = toClusters([
    run({ id: 'a', stratum: 'escalado_clinico', outcomes: [{}], cost: 0.10 }), // caro, raro
    run({ id: 'b', stratum: 'happy_path', outcomes: [{}], cost: 0.01 }),       // barato, común
  ]);
  const sinPonderar = (0.10 + 0.01) / 2; // 0.055 — lo que hacía el código anterior
  const p = projectCost(cs, { escalado_clinico: 0.05, happy_path: 0.95 }, 1000);
  assert.ok(Math.abs(p.perConversationSample - sinPonderar) < 1e-9);
  assert.ok(Math.abs(p.perConversationWeighted - (0.05 * 0.10 + 0.95 * 0.01)) < 1e-9);
  assert.ok(p.perConversationWeighted < p.perConversationSample,
    'la muestra crítica sobreestima la factura');
});

test('13. cobertura parcial se renormaliza y se declara', () => {
  const cs = toClusters([run({ id: 'a', stratum: 'happy_path', outcomes: [{}], cost: 0.02 })]);
  const p = projectCost(cs, { happy_path: 0.30, otro_no_muestreado: 0.70 }, 100);
  assert.ok(Math.abs(p.perConversationWeighted - 0.02) < 1e-9);
  assert.match(p.note, /cobertura/);
});

console.log('\nPUNTO 5 — el gate falla cerrado');

const baseAgg = (over = {}) => aggregate(
  Array.from({ length: 70 }, (_, i) => run({
    id: `c${i}`, critical: true,
    outcomes: [{ tags: true, estado: true, clinical: true, escalation: esc('TP', true) }],
  })),
  { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: true });

test('14. con muestra y desempeño suficientes, PASA', () => {
  const a = baseAgg();
  assert.ok(a.clinical.labeledPositives >= MIN_CLINICAL_POSITIVES);
  const g = evaluateGate(a);
  assert.strictEqual(g.pass, true, g.fail.join(' | '));
});

test('15. REGRESIÓN: recall clínico 100% con muestra insuficiente NO pasa', () => {
  const a = aggregate(
    Array.from({ length: 10 }, (_, i) => run({
      id: `c${i}`, critical: true,
      outcomes: [{ tags: true, estado: true, clinical: true, escalation: esc('TP', true) }],
    })),
    { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: true });
  assert.strictEqual(a.clinical.fn, 0, 'cero omisiones observadas');
  const g = evaluateGate(a);
  assert.strictEqual(g.pass, false, 'pero 10 positivos no alcanzan para afirmarlo');
  assert.ok(g.fail.some(f => /muestra clínica insuficiente/.test(f)), g.fail.join(' | '));
});

test('16. un solo FN clínico hace fallar el gate', () => {
  const runs = Array.from({ length: 70 }, (_, i) => run({
    id: `c${i}`, critical: true,
    outcomes: [{ tags: true, estado: true, clinical: true, escalation: esc(i === 3 ? 'FN' : 'TP', true) }],
  }));
  const g = evaluateGate(aggregate(runs, { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: true }));
  assert.strictEqual(g.pass, false);
  assert.ok(g.fail.some(f => /FN clínico/.test(f)), g.fail.join(' | '));
});

test('17. errores de API en casos clínicos hacen fallar el gate', () => {
  const runs = Array.from({ length: 70 }, (_, i) => run({
    id: `c${i}`, critical: true,
    outcomes: i === 5
      ? [{ error: 'rate limited', errorKind: 'rate_limit', clinical: true }]
      : [{ tags: true, estado: true, clinical: true, escalation: esc('TP', true) }],
  }));
  const g = evaluateGate(aggregate(runs, { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: true }));
  assert.strictEqual(g.pass, false);
  assert.ok(g.fail.some(f => /sin respuesta tras reintentos/.test(f)), g.fail.join(' | '));
});

test('18. una tasa de tags por debajo del umbral hace fallar el gate', () => {
  const runs = Array.from({ length: 70 }, (_, i) => run({
    id: `c${i}`, critical: true,
    outcomes: [{ tags: i % 10 !== 0, estado: true, clinical: true, escalation: esc('TP', true) }],
  }));
  const g = evaluateGate(aggregate(runs, { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: true }));
  assert.strictEqual(g.pass, false);
  assert.ok(g.fail.some(f => /^tags/.test(f)), g.fail.join(' | '));
});

console.log('\nINDETERMINADO — no aplica ≠ aprobado');

test('21. un eje indeterminado sale del denominador, no cuenta como aprobado', () => {
  // Un turno indeterminado no trae `pass.estado`. Si el agregador lo contara como
  // aprobado, un modelo con muchos turnos indeterminados subiría su tasa sin haber
  // acertado nada.
  const conIndeterminado = [
    run({ id: 'c1', outcomes: [{ tags: true, estado: true }] }),
    run({ id: 'c2', outcomes: [{ tags: true, estado: false }] }),
  ];
  // Turno sin el eje `estado` (simula el indeterminado).
  conIndeterminado.push({
    ...run({ id: 'c3', outcomes: [{ tags: true }] }),
    turns: [{ pass: { tags: true }, escalation: { isDecisionPoint: false }, clinical: false,
      failures: [], latencyMs: 1, costUsd: 0, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }],
  });

  const cs = toClusters(conIndeterminado);
  const totalEstado = cs.reduce((a, c) => a + c.metrics.estado.n, 0);
  assert.strictEqual(totalEstado, 2, 'el turno indeterminado no entra al denominador de `estado`');
  const totalTags = cs.reduce((a, c) => a + c.metrics.tags.n, 0);
  assert.strictEqual(totalTags, 3, 'pero sí al de `tags`, que no depende del dato faltante');
});

console.log('\nDISPONIBILIDAD DE pending_payment — bloquea el gate financiero');

const aggSano = (extra = {}) => aggregate(
  Array.from({ length: 70 }, (_, i) => run({
    id: `c${i}`, critical: true,
    outcomes: [{ tags: true, estado: true, clinical: true, escalation: esc('TP', true) }],
  })),
  { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: true, ...extra });

test('22. si pending_payment NO se pudo consultar, el resultado es BLOQUEADO', () => {
  // No alcanza con excluir los turnos indeterminados: [MEDIO_WOMPI] quedaría sin
  // calificar en toda la corrida, y un gate que nunca miró una ruta no puede
  // aprobarla. Pero tampoco es NO PASA: no se midió nada malo.
  const g = evaluateGate(aggSano({ pendingPaymentDisponible: false }));
  assert.strictEqual(g.estado, 'BLOQUEADO');
  assert.strictEqual(g.pass, false);
  assert.strictEqual(g.fallas.length, 0, 'no hay nada medido que falle');
  assert.ok(g.bloqueos.some(b => /pending_payment/.test(b)), g.bloqueos.join(' | '));
});

test('22b. TRES resultados distintos: PASA, NO PASA y BLOQUEADO', () => {
  assert.strictEqual(evaluateGate(aggSano()).estado, 'PASA');
  assert.strictEqual(evaluateGate(aggSano({ pendingPaymentDisponible: false })).estado, 'BLOQUEADO');

  const conFalla = aggregate(
    Array.from({ length: 70 }, (_, i) => run({
      id: `c${i}`, critical: true,
      outcomes: [{ tags: i % 5 !== 0, estado: true, clinical: true, escalation: esc('TP', true) }],
    })),
    { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: true });
  assert.strictEqual(evaluateGate(conFalla).estado, 'NO PASA');
});

test('22c. una falla medida gana sobre un bloqueo', () => {
  // Arreglar la evaluación no va a cambiar que los tags fallan.
  const ambos = aggregate(
    Array.from({ length: 70 }, (_, i) => run({
      id: `c${i}`, critical: true,
      outcomes: [{ tags: i % 5 !== 0, estado: true, clinical: true, escalation: esc('TP', true) }],
    })),
    { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: false });
  const g = evaluateGate(ambos);
  assert.strictEqual(g.estado, 'NO PASA');
  assert.ok(g.fallas.length > 0 && g.bloqueos.length > 0, 'ambas listas se reportan igual');
});

test('22d. muestra clínica insuficiente es BLOQUEO, un FN clínico es FALLA', () => {
  const pocos = aggregate(
    Array.from({ length: 10 }, (_, i) => run({
      id: `c${i}`, critical: true,
      outcomes: [{ tags: true, estado: true, clinical: true, escalation: esc('TP', true) }],
    })),
    { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: true });
  const g1 = evaluateGate(pocos);
  assert.strictEqual(g1.estado, 'BLOQUEADO', 'no se midió nada malo, faltó poder');
  assert.ok(g1.bloqueos.some(b => /muestra clínica insuficiente/.test(b)));

  const conFN = aggregate(
    Array.from({ length: 70 }, (_, i) => run({
      id: `c${i}`, critical: true,
      outcomes: [{ tags: true, estado: true, clinical: true, escalation: esc(i === 3 ? 'FN' : 'TP', true) }],
    })),
    { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: true });
  const g2 = evaluateGate(conFN);
  assert.strictEqual(g2.estado, 'NO PASA', 'se midió y omitió un caso clínico');
  assert.ok(g2.fallas.some(f => /FN clínico/.test(f)));
});

test('23. con el dato disponible y sin FP, el gate financiero no bloquea', () => {
  const g = evaluateGate(aggSano());
  assert.ok(!g.fail.some(f => /gate financiero BLOQUEADO/.test(f)), g.fail.join(' | '));
});

test('24. `undefined` cuenta como no disponible, no como disponible', () => {
  // La ausencia del metadato no es evidencia de que el dato se pudo consultar.
  const g = evaluateGate(aggSano({ pendingPaymentDisponible: undefined }));
  assert.strictEqual(g.estado, 'BLOQUEADO');
  assert.ok(g.bloqueos.some(b => /pending_payment no pudo consultarse/.test(b)), g.bloqueos.join(' | '));
});

console.log('\nPUNTO 8 — cuatro ejes independientes');

test('19. tags correctos + estado incorrecto se reportan por separado', () => {
  const runs = Array.from({ length: 70 }, (_, i) => run({
    id: `c${i}`, critical: true,
    outcomes: [{ tags: true, estado: i % 2 === 0, clinical: true, escalation: esc('TP', true) }],
  }));
  const a = aggregate(runs, { frequencies: null, monthlyVolume: 1000, bootstrap: 200, pendingPaymentDisponible: true });
  assert.strictEqual(a.metrics.tags.point, 1, 'los tags están perfectos');
  assert.ok(a.metrics.estado.point < 0.6, 'y el estado igual falla');
  const g = evaluateGate(a);
  assert.ok(g.fail.some(f => /^estado/.test(f)), 'el gate lo tiene que ver');
});

test('20. compare() aparea por id de conversación', () => {
  const mk = (model, ok) => Array.from({ length: 20 }, (_, i) => run({
    model, id: `c${i}`, outcomes: [{ tags: ok(i), estado: true }],
  }));
  const A = aggregate(mk('base', () => true), { frequencies: null, monthlyVolume: 1, bootstrap: 200 });
  const B = aggregate(mk('cand', i => i >= 8), { frequencies: null, monthlyVolume: 1, bootstrap: 200 });
  const c = compare(A, B, 200);
  assert.strictEqual(c.pairedOn, 20);
  assert.strictEqual(c.metrics.tags.mcnemar.b, 8, 'ocho conversaciones donde solo el candidato falla');
  assert.deepStrictEqual(c.metrics.tags.mcnemar.discordant.baselineOnly.slice(0, 3), ['c0', 'c1', 'c2']);
});

console.log(`\n${n - failed}/${n} OK`);
process.exit(failed ? 1 : 0);
