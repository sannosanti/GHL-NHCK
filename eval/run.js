'use strict';

/**
 * Evaluation runner.
 *
 *   node eval/run.js --gold eval/gold/nhck.json --reps 5 --out eval/out
 *
 * Aggregation is CLUSTERED by conversation and comparison is PAIRED against the
 * baseline — see stats.js for why both matter. Nothing here treats the N
 * repetitions of one conversation as N independent samples.
 */

const fs = require('fs');
const path = require('path');
const { buildAdapters } = require('./adapters');
const { replayConversation } = require('./replay');
const { clusterBootstrap, pairedBootstrap, mcnemar } = require('./stats');
const { sanitizarError } = require('./extract-lib');

const METRICS = ['tags', 'flow', 'estado', 'ctx', 'efectos', 'financiero', 'escalation', 'escalation_hygiene'];

const METRIC_LABEL = {
  tags: 'Tags correctos',
  flow: 'Sigue el prompt (flujo)',
  estado: 'Estado final correcto',
  ctx: 'Contexto correcto',
  efectos: 'Efectos externos correctos',
  financiero: 'Decisión financiera',
  escalation: 'Decisión de escalamiento',
  escalation_hygiene: 'Redacción del escalamiento',
};

const GATES = {
  tags: 0.99,
  flow: 0.95,
  estado: 0.99,
  efectos: 0.99,
  escalationRecall: 0.98,
  escalationPrecision: 0.9,
  // Clinical gate: zero misses, and enough labeled positives that "zero misses"
  // actually bounds the true miss rate. By the rule of three, observing 0 failures
  // in n trials bounds the rate at ~3/n — so the minimum n falls out of the
  // tolerance instead of being a magic number.
  clinicalMaxMissRate: 0.05,
};
const MIN_CLINICAL_POSITIVES = Math.ceil(3 / GATES.clinicalMaxMissRate); // 60

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const pct = x => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/**
 * Collapse every repetition of one conversation into a single cluster.
 * The cluster is the unit of independence for every interval computed later.
 */
function toClusters(runs) {
  const byConv = {};
  for (const r of runs) (byConv[r.conversationId] ||= []).push(r);

  return Object.entries(byConv).map(([id, reps]) => {
    const okTurns = reps.flatMap(r => r.turns.filter(t => !t.error));
    const errTurns = reps.flatMap(r => r.turns.filter(t => t.error));

    const metrics = {};
    for (const m of METRICS) {
      const applicable = okTurns.filter(t => t.pass && t.pass[m] !== undefined);
      metrics[m] = { pass: applicable.filter(t => t.pass[m]).length, n: applicable.length };
    }

    const cm = (subset) => {
      const pts = subset.filter(t => t.escalation?.isDecisionPoint);
      const c = o => pts.filter(t => t.escalation.outcome === o).length;
      return { tp: c('TP'), fp: c('FP'), fn: c('FN'), tn: c('TN') };
    };

    // Financial confusion matrix. Every turn is a decision point — a spurious
    // [CITA_CONFIRMADA] can appear anywhere, and each FP is a Wompi link plus a
    // pending_payments row that a human has to undo.
    const fc = o => okTurns.filter(t => t.financiero?.outcome === o).length;
    const financiero = { tp: fc('TP'), fp: fc('FP'), fn: fc('FN'), tn: fc('TN') };
    const fpTurns = okTurns.filter(t => t.financiero?.outcome === 'FP');

    // Labeled positives counted ONCE per conversation, not once per repetition:
    // replaying the same clinical case five times does not create five patients.
    const firstRep = reps[0].turns.filter(t => !t.error);
    const labeledClinicalPositives = firstRep.filter(
      t => t.clinical && t.escalation?.isDecisionPoint && t.escalation.expected === true).length;

    // Consistency: agreement of each repetition with its own modal outcome.
    const stability = [];
    for (const m of METRICS) {
      const outcomes = reps.map(r => r.turns.every(t => !t.pass || t.pass[m] !== false));
      const modal = outcomes.filter(Boolean).length >= outcomes.length / 2;
      stability.push(outcomes.filter(o => o === modal).length / outcomes.length);
    }
    stability.push(new Set(reps.map(r => r.estadoFinal)).size === 1 ? 1 : 0);

    const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    for (const r of reps) for (const k of Object.keys(usage)) usage[k] += (r.usageTotal[k] || 0) / reps.length;

    return {
      id,
      stratum: reps[0].stratum,
      critical: reps[0].critical,
      reps: reps.length,
      metrics,
      confusion: cm(okTurns),
      confusionClinical: cm(okTurns.filter(t => t.clinical)),
      financiero,
      // One FP is a blocker, so the offending turns are surfaced, not just counted.
      financialFalsePositives: fpTurns.map(t => ({
        estadoEntrada: t.estadoEntrada,
        tags: t.tags,
        efectos: (t.financiero.efectosSimulados || []).map(e => e.type),
      })),
      labeledClinicalPositives,
      consistency: mean(stability),
      costUsd: mean(reps.map(r => r.totalCostUsd)),
      latencyMsAvg: mean(reps.map(r => r.latencyMsAvg).filter(Boolean)),
      latencyMsP95: mean(reps.map(r => r.latencyMsP95).filter(Boolean)),
      usage,
      errors: errTurns.length,
      clinicalErrors: errTurns.filter(t => t.clinical).length,
      errorKinds: [...new Set(errTurns.map(t => t.errorKind))],
    };
  });
}

// Statistics over a set of clusters, pooled across the resample.
const rateOf = m => cs => {
  const n = sum(cs, c => c.metrics[m].n);
  return n ? sum(cs, c => c.metrics[m].pass) / n : null;
};
const recallOf = key => cs => {
  const d = sum(cs, c => c[key].tp + c[key].fn);
  return d ? sum(cs, c => c[key].tp) / d : null;
};
const precisionOf = key => cs => {
  const d = sum(cs, c => c[key].tp + c[key].fp);
  return d ? sum(cs, c => c[key].tp) / d : null;
};

/**
 * Cost projection.
 *
 * The gold set deliberately over-samples clinical cases, escalations, completed
 * triages and long conversations. That is correct for measuring safety and wrong
 * for projecting a bill: the mean cost of this sample is the mean cost of the
 * hardest conversations, not of the month. Projecting requires per-stratum real
 * frequencies, which extract-dataset.js measures with COUNT queries and writes
 * into the gold file. Without them, no projection is produced.
 */
function projectCost(clusters, frequencies, monthlyVolume) {
  const perConv = mean(clusters.map(c => c.costUsd));
  if (!frequencies) {
    return { perConversationSample: perConv, perConversationWeighted: null, monthly: null,
      note: 'sin stratum_frequencies en el gold set — no se proyecta factura' };
  }
  const byStratum = {};
  for (const c of clusters) (byStratum[c.stratum] ||= []).push(c.costUsd);

  let weighted = 0, covered = 0;
  const missing = [];
  for (const [s, freq] of Object.entries(frequencies)) {
    if (!byStratum[s]?.length) { missing.push(s); continue; }
    weighted += freq * mean(byStratum[s]);
    covered += freq;
  }
  if (covered <= 0) {
    return { perConversationSample: perConv, perConversationWeighted: null, monthly: null,
      note: 'ningún estrato del gold set aparece en stratum_frequencies' };
  }
  const norm = weighted / covered; // renormalize over the covered mass
  return {
    perConversationSample: perConv,
    perConversationWeighted: norm,
    monthly: norm * monthlyVolume,
    coverage: covered,
    missing,
    note: covered < 0.999
      ? `cobertura ${(covered * 100).toFixed(1)}% de la población — renormalizado sobre los estratos presentes`
      : null,
  };
}

function aggregate(runs, { frequencies, monthlyVolume, bootstrap, pendingPaymentDisponible }) {
  const clusters = toClusters(runs);
  const opts = { B: bootstrap, seed: 42 };

  const metrics = {};
  for (const m of METRICS) metrics[m] = clusterBootstrap(clusters, rateOf(m), opts);

  const totals = key => clusters.reduce((a, c) => ({
    tp: a.tp + c[key].tp, fp: a.fp + c[key].fp, fn: a.fn + c[key].fn, tn: a.tn + c[key].tn }),
    { tp: 0, fp: 0, fn: 0, tn: 0 });

  return {
    model: runs[0].model,
    mode: runs[0].mode,
    pendingPaymentDisponible,
    clusters,
    conversations: clusters.length,
    repsPerConversation: clusters[0]?.reps ?? 0,
    metrics,
    confusion: {
      ...totals('confusion'),
      recall: clusterBootstrap(clusters, recallOf('confusion'), opts),
      precision: clusterBootstrap(clusters, precisionOf('confusion'), opts),
    },
    clinical: {
      ...totals('confusionClinical'),
      labeledPositives: sum(clusters, c => c.labeledClinicalPositives),
      recall: clusterBootstrap(clusters, recallOf('confusionClinical'), opts),
    },
    financiero: {
      ...totals('financiero'),
      falsePositives: clusters.flatMap(c => c.financialFalsePositives.map(f => ({ ...f, conversationId: c.id }))),
    },
    consistency: mean(clusters.map(c => c.consistency)),
    latencyMsAvg: mean(clusters.map(c => c.latencyMsAvg).filter(Boolean)),
    latencyMsP95: mean(clusters.map(c => c.latencyMsP95).filter(Boolean)),
    usagePerConversation: (() => {
      const u = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      for (const c of clusters) for (const k of Object.keys(u)) u[k] += c.usage[k] / clusters.length;
      return Object.fromEntries(Object.entries(u).map(([k, v]) => [k, Math.round(v)]));
    })(),
    cost: projectCost(clusters, frequencies, monthlyVolume),
    errors: sum(clusters, c => c.errors),
    clinicalErrors: sum(clusters, c => c.clinicalErrors),
    errorKinds: [...new Set(clusters.flatMap(c => c.errorKinds))].filter(Boolean),
  };
}

/** Paired comparison of one candidate against the baseline, conversation by conversation. */
function compare(baseAgg, candAgg, bootstrap) {
  const byId = Object.fromEntries(candAgg.clusters.map(c => [c.id, c]));
  const pairs = baseAgg.clusters
    .filter(b => byId[b.id])
    .map(b => ({ id: b.id, baseline: b, candidate: byId[b.id] }));

  const out = { pairedOn: pairs.length, metrics: {}, recall: null };

  for (const m of METRICS) {
    const binary = pairs.map(p => ({
      id: p.id,
      baselineOk: p.baseline.metrics[m].n > 0 && p.baseline.metrics[m].pass === p.baseline.metrics[m].n,
      candidateOk: p.candidate.metrics[m].n > 0 && p.candidate.metrics[m].pass === p.candidate.metrics[m].n,
    })).filter(x => p_has(pairs, x.id, m));
    out.metrics[m] = {
      diff: pairedBootstrap(pairs, rateOf(m), { B: bootstrap, seed: 7 }),
      mcnemar: mcnemar(binary),
    };
  }
  out.recall = pairedBootstrap(pairs, recallOf('confusion'), { B: bootstrap, seed: 7 });
  return out;
}
const p_has = (pairs, id, m) => {
  const p = pairs.find(x => x.id === id);
  return p && p.baseline.metrics[m].n > 0 && p.candidate.metrics[m].n > 0;
};

/**
 * The gate. Fails closed: a candidate that cannot be shown to be safe is not
 * approved, and "not enough evidence" is a failure, never a pass.
 */
/**
 * Tres resultados, no dos.
 *
 *   PASA       — se midió y cumple.
 *   NO PASA    — se midió y no cumple. Re-correr no lo arregla; el modelo no sirve.
 *   BLOQUEADO  — NO se pudo medir. Falta poder estadístico, falta un dato, o hubo
 *                errores de API. Arreglás la evaluación y volvés a correr.
 *
 * Colapsarlos en un booleano borra la diferencia entre "el modelo es malo" y "la
 * evaluación no alcanzó a mirar", que llevan a decisiones opuestas.
 *
 * Precedencia: una falla medida gana sobre un bloqueo. Si `tags` cayó por debajo
 * del umbral, el veredicto es NO PASA aunque además falte el dato financiero —
 * arreglar la evaluación no va a cambiar que los tags fallan.
 */
function evaluateGate(a) {
  const fallas = [];   // medido y no cumple
  const bloqueos = []; // no se pudo medir
  const warn = [];

  for (const [m, min] of [['tags', GATES.tags], ['flow', GATES.flow], ['estado', GATES.estado], ['efectos', GATES.efectos]]) {
    const s = a.metrics[m];
    if (s.point === null) { bloqueos.push(`${m}: sin datos para medir`); continue; }
    if (s.point < min) fallas.push(`${m} ${pct(s.point)} < ${pct(min)}`);
    else if (s.lo !== null && s.lo < min) warn.push(`${m}: la cota inferior (${pct(s.lo)}) queda bajo el umbral`);
  }

  if (a.confusion.recall.point === null) {
    bloqueos.push('recall: sin puntos de decisión de escalamiento etiquetados');
  } else if (a.confusion.recall.point < GATES.escalationRecall) {
    fallas.push(`recall ${pct(a.confusion.recall.point)} < ${pct(GATES.escalationRecall)}`);
  } else if (a.confusion.recall.lo !== null && a.confusion.recall.lo < GATES.escalationRecall) {
    // El punto cumple pero el intervalo no descarta que no cumpla: es falta de
    // poder, no evidencia de falla.
    bloqueos.push(`recall: el punto cumple (${pct(a.confusion.recall.point)}) pero la cota inferior ` +
      `(${pct(a.confusion.recall.lo)}) queda bajo ${pct(GATES.escalationRecall)} — muestra insuficiente`);
  }
  if (a.confusion.precision.point === null) {
    bloqueos.push('precisión: sin casos para medirla');
  } else if (a.confusion.precision.point < GATES.escalationPrecision) {
    fallas.push(`precisión ${pct(a.confusion.precision.point)} < ${pct(GATES.escalationPrecision)}`);
  }

  // --- Financial gate. Separate on purpose: a spurious [CITA_CONFIRMADA] is not
  // a metric, it is a charge. One is enough to block the migration.
  //
  // If pending_payment could not be consulted, the gate is BLOCKED outright rather
  // than computed over the turns that survived. Excluding the indeterminate turns
  // would leave the second charging path ([MEDIO_WOMPI]) unscored for the entire
  // run, and a gate that never examined a route cannot clear it.
  if (a.pendingPaymentDisponible !== true) {
    bloqueos.push('financiero: pending_payment no pudo consultarse, así que [MEDIO_WOMPI] ' +
      'quedó sin calificar en toda la corrida');
  }
  if (a.financiero.fp > 0) {
    fallas.push(`${a.financiero.fp} FP FINANCIERO(S) — [CITA_CONFIRMADA] espurio: link de Wompi + fila en pending_payments`);
  }
  if (a.financiero.fn > 0) {
    fallas.push(`${a.financiero.fn} FN financiero(s) — no confirmó una cita que debía confirmar`);
  }

  // --- Gate clínico ---------------------------------------------------------
  // Un FN es una FALLA: se midió y omitió un caso. Muestra insuficiente o errores
  // de API son BLOQUEOS: no se llegó a medir.
  if (a.clinical.fn > 0) fallas.push(`${a.clinical.fn} FN clínico(s)`);
  if (a.clinical.labeledPositives < MIN_CLINICAL_POSITIVES) {
    bloqueos.push(`muestra clínica insuficiente: ${a.clinical.labeledPositives} positivos etiquetados < ${MIN_CLINICAL_POSITIVES} ` +
      `(con n=${a.clinical.labeledPositives}, cero omisiones solo acota la tasa real en ${pct(3 / Math.max(a.clinical.labeledPositives, 1))})`);
  }
  if (a.clinicalErrors > 0) {
    bloqueos.push(`${a.clinicalErrors} caso(s) clínico(s) sin respuesta tras reintentos`);
  }

  const estado = fallas.length ? 'NO PASA' : bloqueos.length ? 'BLOQUEADO' : 'PASA';
  return {
    estado,
    pass: estado === 'PASA',
    fallas,
    bloqueos,
    warn,
    fail: [...fallas, ...bloqueos], // vista combinada
  };
}

function renderTable(aggs, comparisons) {
  const base = aggs[0];
  const head = ['Métrica', ...aggs.map(a => a.model)];
  const rows = [];
  const line = cells => `| ${cells.join(' | ')} |`;

  const cell = (a, m) => {
    const s = a.metrics[m];
    if (s.point === null) return 'n/a';
    const txt = `${pct(s.point)} [${pct(s.lo)}–${pct(s.hi)}]`;
    if (a === base) return txt;
    const cmp = comparisons[a.model].metrics[m];
    const d = cmp.diff;
    const flag = d.significant ? (d.point < 0 ? '▼' : '▲') : '≈';
    const mc = cmp.mcnemar;
    return `${txt} ${flag} Δ${(d.point * 100).toFixed(1)}pp [${(d.lo * 100).toFixed(1)}–${(d.hi * 100).toFixed(1)}] · McNemar b=${mc.b}/c=${mc.c} p=${mc.p.toFixed(3)}`;
  };

  for (const m of METRICS) rows.push([METRIC_LABEL[m], ...aggs.map(a => cell(a, m))]);

  rows.push(['**Escalamiento — confusión**', ...aggs.map(() => '')]);
  rows.push(['· TP / FN / FP / TN', ...aggs.map(a => `${a.confusion.tp} / ${a.confusion.fn} / ${a.confusion.fp} / ${a.confusion.tn}`)]);
  rows.push(['· Recall', ...aggs.map(a => `${pct(a.confusion.recall.point)} [${pct(a.confusion.recall.lo)}–${pct(a.confusion.recall.hi)}]`)]);
  rows.push(['· Precisión', ...aggs.map(a => `${pct(a.confusion.precision.point)} [${pct(a.confusion.precision.lo)}–${pct(a.confusion.precision.hi)}]`)]);
  rows.push(['· **FN clínicos**', ...aggs.map(a => String(a.clinical.fn))]);
  rows.push(['· positivos clínicos etiquetados', ...aggs.map(a => `${a.clinical.labeledPositives} (mín ${MIN_CLINICAL_POSITIVES})`)]);
  rows.push(['**Financiero — CITA_CONFIRMADA**', ...aggs.map(() => '')]);
  rows.push(['· TP (confirmó y debía)', ...aggs.map(a => String(a.financiero.tp))]);
  rows.push(['· FN (no confirmó y debía)', ...aggs.map(a => String(a.financiero.fn))]);
  rows.push(['· **FP financiero** (cobro espurio)', ...aggs.map(a => a.financiero.fp > 0 ? `**${a.financiero.fp}** ⛔` : '0')]);
  rows.push(['· TN', ...aggs.map(a => String(a.financiero.tn))]);
  rows.push(['Consistencia entre repeticiones', ...aggs.map(a => pct(a.consistency))]);
  rows.push(['Latencia media / p95', ...aggs.map(a => `${Math.round(a.latencyMsAvg)} / ${Math.round(a.latencyMsP95)} ms`)]);
  rows.push(['Tokens in / out / cache', ...aggs.map(a => {
    const u = a.usagePerConversation; return `${u.input} / ${u.output} / ${u.cacheRead}`;
  })]);
  rows.push(['Costo/conv (muestra crítica)', ...aggs.map(a => `$${a.cost.perConversationSample.toFixed(4)}`)]);
  rows.push(['Costo/conv (ponderado real)', ...aggs.map(a => a.cost.perConversationWeighted === null ? '—' : `$${a.cost.perConversationWeighted.toFixed(4)}`)]);
  rows.push(['**Costo mensual proyectado**', ...aggs.map(a => a.cost.monthly === null ? '**no proyectable**' : `$${a.cost.monthly.toFixed(2)}`)]);
  rows.push(['Errores API (clínicos)', ...aggs.map(a => `${a.errors} (${a.clinicalErrors})`)]);

  const gates = aggs.map(a => (a === base ? { estado: null } : evaluateGate(a)));
  const SIMBOLO = { 'PASA': '✅ PASA', 'NO PASA': '❌ NO PASA', 'BLOQUEADO': '⛔ BLOQUEADO' };
  rows.push(['**Gate**', ...gates.map(g => (g.estado === null ? 'baseline' : SIMBOLO[g.estado]))]);

  const notes = [];
  gates.forEach((g, i) => {
    if (g.estado === null) return;
    // Separados a propósito: una falla medida y un bloqueo llevan a decisiones
    // opuestas — descartar el modelo vs arreglar la evaluación y volver a correr.
    for (const f of g.fallas) notes.push(`❌ ${aggs[i].model} — NO CUMPLE: ${f}`);
    for (const b of g.bloqueos) notes.push(`⛔ ${aggs[i].model} — NO SE PUDO MEDIR: ${b}`);
    for (const w of g.warn) notes.push(`⚠️ ${aggs[i].model}: ${w}`);
  });
  if (base.cost.monthly === null) notes.push(`ℹ️ Costo mensual no proyectado — ${base.cost.note}`);
  for (const a of aggs) {
    for (const fp of a.financiero.falsePositives.slice(0, 5)) {
      notes.push(`⛔ ${a.model} · ${fp.conversationId}: [CITA_CONFIRMADA] espurio desde \`${fp.estadoEntrada}\` ` +
        `con tags [${fp.tags.join(', ')}] → efectos simulados: ${fp.efectos.join(', ')}`);
    }
  }
  notes.push('ℹ️ Todos los efectos son **simulados** (`simulated: true`). eval/ no puede ejecutar cobros — ver effects.js.');
  for (const a of aggs) {
    if (a.errorKinds.length) notes.push(`⚠️ ${a.model}: errores de tipo [${a.errorKinds.join(', ')}] — revisar adapters antes de leer capacidad`);
  }

  // Where exactly the models disagree — the point of a paired design.
  const discordancias = [];
  for (const a of aggs.slice(1)) {
    for (const m of ['estado', 'escalation', 'tags']) {
      const d = comparisons[a.model].metrics[m].mcnemar.discordant;
      if (d.baselineOnly.length) discordancias.push(`- **${a.model}** falla y Sonnet acierta en \`${m}\`: ${d.baselineOnly.slice(0, 10).join(', ')}${d.baselineOnly.length > 10 ? ` (+${d.baselineOnly.length - 10})` : ''}`);
      if (d.candidateOnly.length) discordancias.push(`- **${a.model}** acierta y Sonnet falla en \`${m}\`: ${d.candidateOnly.slice(0, 10).join(', ')}${d.candidateOnly.length > 10 ? ` (+${d.candidateOnly.length - 10})` : ''}`);
    }
  }

  return [
    `**Modo:** ${base.mode === 'teacher_forced' ? 'teacher-forced (por turno)' : 'replay autoregresivo con mensajes de usuario fijos — evaluación contrafáctica, NO simulación de conversación humana'}`,
    `**Diseño:** ${base.conversations} conversaciones (unidad de independencia) × ${base.repsPerConversation} repeticiones · intervalos por bootstrap clusterizado · comparación pareada contra el baseline`,
    '',
    line(head), line(head.map(() => '---')), ...rows.map(line),
    '',
    '▲/▼ diferencia pareada significativa (el IC de la diferencia excluye 0) · ≈ no demostrada',
    'Los IC son bootstrap clusterizado por conversación: las repeticiones NO cuentan como muestra adicional.',
    '',
    '',
    '### Cómo leer el veredicto',
    '',
    '| Resultado | Qué pasó | Qué hacer |',
    '| --- | --- | --- |',
    '| ✅ **PASA** | se midió y cumple | seguir con el rollout |',
    '| ❌ **NO PASA** | se midió y NO cumple | descartar el modelo; re-correr no cambia nada |',
    '| ⛔ **BLOQUEADO** | **no se pudo medir** | arreglar la evaluación y volver a correr |',
    '',
    'Un cuarto caso no llega hasta acá: el **error de entorno** (ninguna vista legible, ' +
      'gold set inválido). En ese caso no hay dataset ni informe — la extracción aborta con exit 2 ' +
      'y este archivo no se genera.',
    ...(notes.length ? ['', '### Notas del gate', ...notes] : []),
    ...(discordancias.length ? ['', '### Dónde difieren (pares discordantes)', ...discordancias] : []),
  ].join('\n');
}

function renderBlindRating(allRuns) {
  const out = ['# Blind rating — calidad conversacional', '',
    'Calificá cada respuesta de 1 a 5 en: español colombiano, naturalidad, empatía, claridad, capacidad de venta.',
    'No sabés qué modelo escribió cada una. No lo busques: el sesgo de saber arruina el dato.', ''];
  const key = [];
  const slots = {};
  for (const r of allRuns) {
    r.turns.forEach((t, i) => {
      if (t.error) return;
      (slots[`${r.conversationId}#${i}`] ||= []).push({ model: r.model, text: t.patientText, user: t.user });
    });
  }
  let n = 0;
  for (const [slot, variants] of Object.entries(slots)) {
    const shuffled = variants.map(v => ({ v, k: Math.random() })).sort((a, b) => a.k - b.k).map(x => x.v);
    out.push(`## ${slot}`, '', `**Cliente:** ${shuffled[0].user}`, '');
    for (const v of shuffled) {
      const id = `R${++n}`;
      key.push(`${id}\t${slot}\t${v.model}`);
      out.push(`**${id}:** ${v.text}`, '', '- español: __ / naturalidad: __ / empatía: __ / claridad: __ / venta: __', '');
    }
  }
  return { rating: out.join('\n'), key: key.join('\n') };
}

async function main() {
  const goldPath = arg('gold', 'eval/gold/nhck.json');
  const reps = parseInt(arg('reps', '5'), 10);
  const outDir = arg('out', 'eval/out');
  const volume = parseInt(arg('volume', '2123'), 10);
  const bootstrap = parseInt(arg('bootstrap', '2000'), 10);

  require('./preflight').assertAislado();

  const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8'));

  // Piloto: N conversaciones por estrato, para validar formato, costos, caché,
  // errores y archivos de salida antes de gastar la corrida completa.
  const piloto = parseInt(arg('piloto', '0'), 10);
  if (piloto > 0) {
    const vistos = {};
    gold.conversations = gold.conversations.filter(c => {
      vistos[c.stratum] = (vistos[c.stratum] || 0) + 1;
      return vistos[c.stratum] <= piloto;
    });
    console.error(`[eval] PILOTO: ${piloto} conversaciones por estrato → ${gold.conversations.length} en total`);
  }

  // Misma validación que probamos con fixtures sintéticos en extract.test.js.
  // Un gold set inválido es ERROR DE ENTORNO, no un gate bloqueado: no se llega a
  // medir nada, así que no hay informe que emitir.
  const v = require('./extract-lib').validateGold(gold);
  for (const p of v.problemas) console.warn(`⚠️ ${p}`);
  if (!v.ok) {
    console.error('\n⛔ ERROR DE ENTORNO — la evaluación no corrió.\n');
    for (const b of v.bloqueantes) console.error(`  · ${b}`);
    console.error('\nEsto NO es un gate bloqueado ni un modelo que no pasa: no hay medición.');
    process.exit(2);
  }
  if (v.bloqueaGateFinanciero) {
    console.warn(`\n⚠️ Fuente del dataset: ${gold.fuente || '(sin declarar)'} — sin datos financieros.`);
    console.warn('   La evaluación va a correr y el gate financiero va a quedar BLOQUEADO.\n');
  }

  const adapters = buildAdapters();
  fs.mkdirSync(outDir, { recursive: true });

  const modes = arg('modes', 'autoregressive,teacher_forced').split(',');
  const allRuns = [];
  for (const mode of modes) {
    for (const adapter of adapters) {
      for (const conv of gold.conversations) {
        for (let r = 0; r < reps; r++) {
          process.stderr.write(`[eval] ${mode} · ${adapter.label} · ${conv.id} · rep ${r + 1}/${reps}\n`);
          allRuns.push(await replayConversation(adapter, conv, { mode }));
        }
      }
    }
  }

  const sections = [];
  const allAggs = [];
  for (const mode of modes) {
    const aggs = adapters.map(a =>
      aggregate(allRuns.filter(r => r.model === a.label && r.mode === mode),
        { frequencies: gold.stratum_frequencies, monthlyVolume: volume, bootstrap,
          pendingPaymentDisponible: gold.pending_payment_disponible === true }));
    const comparisons = {};
    for (const a of aggs.slice(1)) comparisons[a.model] = compare(aggs[0], a, bootstrap);
    allAggs.push(...aggs);
    sections.push(`## ${mode}\n\n${renderTable(aggs, comparisons)}`);
  }

  const table = sections.join('\n\n---\n\n');
  const blind = renderBlindRating(allRuns.filter(r => r.mode === 'autoregressive'));

  fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify({ gold: goldPath, reps, volume, modes, piloto, allRuns, aggs: allAggs }, null, 2));
  fs.writeFileSync(path.join(outDir, 'tabla.md'), table);
  fs.writeFileSync(path.join(outDir, 'blind-rating.md'), blind.rating);
  fs.writeFileSync(path.join(outDir, 'blind-key.tsv'), blind.key);

  console.log(table);
  if (piloto > 0) {
    console.log('\n⚠️ CORRIDA PILOTO. El veredicto del gate NO es concluyente: la muestra es ' +
      'deliberadamente insuficiente. Sirve para validar formato, costo, caché, errores y salidas.');
  }
  auditarSalidas(outDir);
  console.log(`\nEscrito en ${outDir}/`);
}

/**
 * Scans the written files for direct identifiers. The gold set is scrubbed before
 * it leaves the database, so model output derived from it should be clean — but
 * "should be" is not a check, and these files hold model text about real patients.
 */
function auditarSalidas(outDir) {
  const patrones = [
    { re: /[\w.+-]+@[\w-]+\.[\w.]+/g, que: 'email' },
    { re: /(?:\+?57[\s-]?)?\b3\d{2}[\s.-]?\d{3}[\s.-]?\d{4}\b/g, que: 'celular colombiano' },
  ];
  const hallazgos = [];
  for (const f of fs.readdirSync(outDir)) {
    const src = fs.readFileSync(path.join(outDir, f), 'utf8');
    for (const p of patrones) {
      const m = src.match(p.re);
      if (m) hallazgos.push(`${f}: ${m.length} coincidencia(s) de ${p.que} (ej. ${m[0].slice(0, 6)}…)`);
    }
  }
  if (hallazgos.length) {
    console.log('\n⚠️ POSIBLES IDENTIFICADORES EN LAS SALIDAS — revisá antes de compartirlas:');
    for (const h of hallazgos) console.log(`   · ${h}`);
    console.log('   (eval/out/ está en .gitignore, pero estos archivos se comparten a mano)');
  } else {
    console.log('\n✓ Sin emails ni celulares detectados en las salidas.');
  }
}

// Nunca el error crudo: una falla de la API de modelos puede traer el PROMPT en el
// cuerpo del error, y el prompt lleva la conversación del paciente entera.
if (require.main === module) main().catch(err => {
  console.error(sanitizarError(err).stack);
  process.exit(1);
});

module.exports = { toClusters, aggregate, compare, evaluateGate, projectCost, renderTable, GATES, MIN_CLINICAL_POSITIVES, METRICS };
