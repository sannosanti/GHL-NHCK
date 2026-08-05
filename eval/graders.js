'use strict';

/**
 * Deterministic graders for the NHC model evaluation.
 *
 * Everything in this file is rule-based and reproducible. Nothing here asks a
 * model to judge another model — conversational quality is graded separately and
 * blind (see judge.js), because a Claude-graded Claude-vs-GPT comparison is not
 * evidence.
 *
 * Ground truth comes from the hand-labeled gold set, never from what Sonnet
 * happened to output. See README, "Baseline is not ground truth".
 */

const { limpiarTags } = require('../ai/tags');

// The complete tag vocabulary the prompt is allowed to produce. Anything outside
// this set that looks like a tag is an invented tag, which is a hard failure:
// invented tags are not routed by the webhook, so the state machine silently
// stalls.
const KNOWN_TAGS = new Set([
  'TRIAJE_P1', 'TRIAJE_P2', 'TRIAJE_P3', 'TRIAJE_COMPLETO',
  'NOMBRE_PADRE', 'CIUDAD_VALIDA', 'CIUDAD_NO_DISPONIBLE',
  'MEDIO_WOMPI', 'MEDIO_TRANSFERENCIA', 'MEDIO_QR',
  'SIN_PRESUPUESTO', 'FUERA_SEGMENTO',
  'NHC_ADULTOS', 'NHC_MENOR', 'CITA_CONFIRMADA', 'ESCALAR', 'POSPONER',
]);

const ANY_BRACKETED = /\[([^\]]{1,80})\]/g;

/** Extract every bracketed token and split it into name + payload. */
function parseTags(raw) {
  const out = [];
  for (const m of String(raw || '').matchAll(ANY_BRACKETED)) {
    const inner = m[1];
    const name = inner.includes(':') ? inner.slice(0, inner.indexOf(':')).trim() : inner.trim();
    out.push({ name, payload: inner.includes(':') ? inner.slice(inner.indexOf(':') + 1).trim() : null, raw: m[0] });
  }
  return out;
}

/**
 * Gold sets may declare an expected tag either as a bare name or as
 * `{name, payload}`. The payload form is required for the tags that write context
 * the later prompts read back — NOMBRE_PADRE and TRIAJE_P1/P2/P3. Reconstructing
 * those as null (the earlier behavior) advanced estado correctly but built every
 * subsequent prompt with an empty name and empty triage answers.
 */
function normalizeExpectedTags(list) {
  return (list || []).map(t =>
    typeof t === 'string'
      ? { name: t, payload: null }
      : { name: t.name, payload: t.payload ?? null });
}

const expectedNames = list => normalizeExpectedTags(list).map(t => t.name);

/** Tags whose payload carries data the prompt reads back on later turns. */
const PAYLOAD_TAGS = new Set(['NOMBRE_PADRE', 'TRIAJE_P1', 'TRIAJE_P2', 'TRIAJE_P3', 'CIUDAD_VALIDA']);

/** Sentences ending in '?' — used for the forbidden/repeated question checks. */
function questions(text) {
  return String(text || '')
    .split(/(?<=[?¿.!\n])/)
    .map(s => s.trim())
    .filter(s => s.includes('?'))
    .map(s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Crude but stable overlap score, for detecting a question asked twice. */
function similar(a, b) {
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  const inter = [...A].filter(w => B.has(w)).length;
  return inter / Math.max(A.size, B.size, 1);
}

// Phrases the prompt explicitly forbids. Each is a regex over the patient-facing
// text (after tag stripping), plus the rule it violates for the report.
const FORBIDDEN = [
  { id: 'convenio_proactivo', rule: 'PASO 3: nunca preguntar por convenios si el cliente no los menciona', re: /\b(comfama|feisa)\b/i, onlyIfUserSilent: true },
  { id: 'ofrece_email', rule: 'Nunca ofrecer enviar información por correo', re: /\b(te (envio|env[ií]o|mando)|puedo enviarte|te lo mando)\b[^.?!]{0,40}\b(correo|email|mail)\b/i },
  { id: 'asesores_humanos', rule: 'Nunca usar el término "asesores humanos"', re: /asesor(es)?\s+humanos?/i },
  { id: 'admite_ia', rule: 'Nunca decir que es IA', re: /\b(soy una? (ia|inteligencia artificial|bot|asistente virtual)|como (ia|modelo de lenguaje))\b/i },
  { id: 'marca_inventada', rule: 'La marca es exactamente NHC / NHC Kids', re: /neuro\s*hacking\s*center/i },
  { id: 'saludo_singular', rule: 'Saludos siempre en plural', re: /\bbuena tarde\b/i },
  { id: 'asteriscos', rule: 'Sin asteriscos ni negritas', re: /\*/ , onRaw: true },
];

/**
 * Grade one assistant turn.
 *
 * @param {object} turn
 * @param {string} turn.raw           model output, before any cleaning
 * @param {string} turn.userMessage   the customer message that produced it
 * @param {object} turn.expect        gold label for this turn (may be empty)
 * @param {string[]} turn.priorQuestions questions already asked earlier in the conversation
 */
function gradeTurn({ raw, userMessage, expect = {}, priorQuestions = [] }) {
  const tags = parseTags(raw);
  const names = tags.map(t => t.name);
  const patientText = limpiarTags(raw);
  const failures = [];

  // --- Tags -----------------------------------------------------------------
  const required = expectedNames(expect.tags_required);
  const forbidden = expectedNames(expect.tags_forbidden);

  const missing = required.filter(t => !names.includes(t));
  const emitted = forbidden.filter(t => names.includes(t));
  const invented = tags.filter(t => !KNOWN_TAGS.has(t.name)).map(t => t.raw);

  // Leakage: whatever survives limpiarTags and still looks like a marker is what
  // would have reached the patient on WhatsApp. Two live incidents (2026-07-25,
  // 2026-07-29) came from exactly this gap.
  const leaked = [...patientText.matchAll(ANY_BRACKETED)].map(m => m[0]);

  if (missing.length) failures.push({ metric: 'tags', kind: 'missing', detail: missing });
  if (emitted.length) failures.push({ metric: 'tags', kind: 'forbidden', detail: emitted });
  if (invented.length) failures.push({ metric: 'tags', kind: 'invented', detail: invented });
  if (leaked.length) failures.push({ metric: 'tags', kind: 'leaked', detail: leaked });

  // Payload tags must carry a payload; [TRIAJE_P1] with nothing after the colon
  // writes an empty triage answer into the DB.
  const emptyPayload = tags
    .filter(t => /^(TRIAJE_P[123]|NOMBRE_PADRE|CIUDAD_VALIDA)$/.test(t.name) && !t.payload)
    .map(t => t.raw);
  if (emptyPayload.length) failures.push({ metric: 'tags', kind: 'empty_payload', detail: emptyPayload });

  // --- Escalation decision --------------------------------------------------
  // Graded separately from generic tag fidelity: this is the metric with clinical
  // consequences (autismo/TEA, epilepsia no controlada), so it gets its own gate.
  //
  // DENOMINATOR RULE: escalation is only scored on turns that carry an explicit
  // escalation label — ESCALAR in tags_required (must escalate) or in
  // tags_forbidden (must not). Every other turn has no escalation decision to
  // make and is excluded, not counted as a pass. Averaging over all turns
  // dilutes the rate toward 100% and hides exactly the failures this metric
  // exists to catch.
  const mustEscalate = required.includes('ESCALAR');
  const mustNotEscalate = forbidden.includes('ESCALAR');
  const isDecisionPoint = mustEscalate || mustNotEscalate;
  const didEscalate = names.includes('ESCALAR');

  let escalation = { isDecisionPoint: false, expected: null, actual: didEscalate, outcome: null };
  if (isDecisionPoint) {
    const outcome = mustEscalate
      ? (didEscalate ? 'TP' : 'FN')
      : (didEscalate ? 'FP' : 'TN');
    escalation = { isDecisionPoint: true, expected: mustEscalate, actual: didEscalate, outcome };
    if (outcome === 'FN' || outcome === 'FP') {
      failures.push({
        metric: 'escalation',
        kind: outcome === 'FN' ? 'missed' : 'spurious',
        clinical: Boolean(expect.clinical),
        detail: expect.escalation_reason || null,
      });
    }
  }
  // Escalation hygiene (prompt rule: no further questions in the same turn, and
  // the concrete PRÓXIMO CONTACTO window must appear). Kept as its own metric so
  // it never pollutes the escalation confusion matrix — a well-decided escalation
  // that is badly worded is a different failure from escalating the wrong case.
  if (didEscalate) {
    if (patientText.includes('?')) {
      failures.push({ metric: 'escalation_hygiene', kind: 'question_in_escalation_turn', detail: null });
    }
    if (!/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|ma[ñn]ana|hoy)\b/i.test(patientText)) {
      failures.push({ metric: 'escalation_hygiene', kind: 'no_contact_window', detail: null });
    }
  }

  // --- Flow / prompt fidelity ----------------------------------------------
  for (const f of FORBIDDEN) {
    const haystack = f.onRaw ? raw : patientText;
    if (!f.re.test(haystack)) continue;
    // "Do not bring up convenios" only fires if the customer never mentioned them.
    if (f.onlyIfUserSilent && f.re.test(String(userMessage || ''))) continue;
    failures.push({ metric: 'flow', kind: 'forbidden_content', detail: f.id, rule: f.rule });
  }

  const qs = questions(patientText);
  for (const q of qs) {
    const dup = priorQuestions.find(p => similar(p, q) >= 0.75);
    if (dup) failures.push({ metric: 'flow', kind: 'repeated_question', detail: q });
  }
  for (const forb of expect.must_not_ask || []) {
    if (new RegExp(forb, 'i').test(patientText)) {
      failures.push({ metric: 'flow', kind: 'asked_forbidden', detail: forb });
    }
  }

  // Max 2 paragraphs unless separated with --- (prompt rule).
  //
  // Counted on the raw text with tags removed, NOT on patientText: limpiarTags
  // drops blank lines, so splitting patientText on blank lines finds exactly one
  // paragraph every time and the check silently never fires.
  const paras = String(raw || '')
    .replace(ANY_BRACKETED, '')
    .split(/\n\s*\n|---/)
    .map(s => s.trim())
    .filter(Boolean);
  if (paras.length > 2) failures.push({ metric: 'flow', kind: 'too_many_paragraphs', detail: paras.length });

  // Mixing tuteo and voseo inside one message is called out explicitly in the prompt.
  const tuteo = /\b(tienes|puedes|quieres|aceptas|tu hijo)\b/i.test(patientText);
  const voseo = /\b(ten[eé]s|pod[eé]s|quer[eé]s|acept[aá]s|compart[ií]s)\b/i.test(patientText);
  if (tuteo && voseo) failures.push({ metric: 'flow', kind: 'mixed_register', detail: null });

  const byMetric = m => failures.filter(f => f.metric === m).length === 0;

  // `pass.<metric> === undefined` means "not applicable to this turn" and the
  // aggregator drops it from that metric's denominator. Only tags and flow apply
  // to every turn.
  const pass = { tags: byMetric('tags'), flow: byMetric('flow') };
  if (escalation.isDecisionPoint) pass.escalation = byMetric('escalation');
  if (didEscalate) pass.escalation_hygiene = byMetric('escalation_hygiene');

  return { patientText, tags: names, failures, pass, escalation, questionsAsked: qs };
}

module.exports = { gradeTurn, parseTags, questions, normalizeExpectedTags, KNOWN_TAGS, PAYLOAD_TAGS };
