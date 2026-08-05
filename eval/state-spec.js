'use strict';

/**
 * THE state-resolution contract for NHC / NHC Kids.
 *
 * `resolveStateTransition()` is a PURE function: given the estado entering a turn,
 * the tags the model emitted, and the current context, it returns a DECLARATIVE
 * decision. It performs nothing. Every side effect is described, never executed.
 *
 *     state-spec.js  →  resolveStateTransition()
 *                            ↓                ↓
 *                    webhooks/ghl.js     eval/replay.js
 *                    EJECUTA efectos     SIMULA y califica
 *
 * The point is to end up with one implementation instead of three: the webhook's
 * real branching, a copy in the eval, and the replay's interpretation of that copy.
 * Today only the eval side consumes it — see PARIDAD.md for the production patch,
 * which is a blocking requirement before any model migration.
 *
 * Verified against webhooks/ghl.js:141-420 on 2026-08-05. Drift is detected by
 * webhook-parity.test.js, which is an ALARM (the block changed, go look), not a
 * proof of equivalence. Only the shared function gives equivalence.
 */

/** Effect types. Production maps these to calls; the eval maps them to records. */
const EFFECT = {
  UPDATE_GHL_CONTACT: 'UPDATE_GHL_CONTACT',
  CLEAR_CONTACT_CACHE: 'CLEAR_CONTACT_CACHE',
  SAVE_CITY: 'SAVE_CITY',
  SAVE_SYMPTOM: 'SAVE_SYMPTOM',
  SAVE_PATIENT_FIELDS: 'SAVE_PATIENT_FIELDS',
  ADD_TAG: 'ADD_TAG',
  UPDATE_OPPORTUNITY_STAGE: 'UPDATE_OPPORTUNITY_STAGE',
  LOG_EVENT: 'LOG_EVENT',
  TRIGGER_ANALYSIS: 'TRIGGER_ANALYSIS',
  SET_DERIVADO_A: 'SET_DERIVADO_A',
  SET_RECOVERY_STATUS: 'SET_RECOVERY_STATUS',
  SAVE_CONVERSATION: 'SAVE_CONVERSATION',
  SEND_MESSAGE: 'SEND_MESSAGE',
  SEND_FIXED_MESSAGE: 'SEND_FIXED_MESSAGE',
  START_INACTIVITY_TIMERS: 'START_INACTIVITY_TIMERS',
  // Financial. These move money or publish payment instructions.
  CREATE_WOMPI_PAYMENT: 'CREATE_WOMPI_PAYMENT',
  INSERT_PENDING_PAYMENT: 'INSERT_PENDING_PAYMENT',
  SEND_BANK_DETAILS: 'SEND_BANK_DETAILS',
};

/**
 * Effects that create a charge, a payment record, or publish payment instructions.
 * A single spurious one is a migration blocker, not a metric — hence its own gate,
 * separate from "tags correctos" and "estado correcto".
 *
 * SEND_BANK_DETAILS is here because [MEDIO_TRANSFERENCIA] and [MEDIO_QR] send the
 * company's real account number and payment key to the patient. Sending those to
 * someone who never agreed to pay is not a charge, but it is not recoverable
 * either.
 */
const FINANCIAL_EFFECTS = new Set([
  EFFECT.CREATE_WOMPI_PAYMENT,
  EFFECT.INSERT_PENDING_PAYMENT,
  EFFECT.SEND_BANK_DETAILS,
]);

const isFinancial = e => FINANCIAL_EFFECTS.has(e.type);

/** STAGE 1 — accumulator (ghl.js:141-187). Every matching rule applies, in order. */
const ACCUMULATOR = [
  {
    tag: 'NOMBRE_PADRE',
    ref: 'ghl.js:145-158',
    appliesWhen: estado => estado === 'nuevo',
    estado: 'triaje_p1',
    ctxUpdate: payload => (payload ? { nombre: payload } : {}),
    effects: payload => (payload
      ? [{ type: EFFECT.UPDATE_GHL_CONTACT, fields: ['firstName', 'lastName'] }, { type: EFFECT.CLEAR_CONTACT_CACHE }]
      : []),
  },
  {
    tag: 'CIUDAD_VALIDA',
    ref: 'ghl.js:160-163',
    estado: null, // never advances
    ctxUpdate: () => ({}),
    effects: payload => [{ type: EFFECT.SAVE_CITY, city: payload }],
  },
  {
    tag: 'TRIAJE_P1',
    ref: 'ghl.js:170-180',
    estado: 'triaje_p2',
    ctxUpdate: payload => (payload ? { triaje: { p1: payload } } : {}),
    effects: (payload, ctx) => [{ type: EFFECT.SAVE_SYMPTOM, adulto: ctx?.derivadoA === 'luisa', value: payload }],
  },
  {
    tag: 'TRIAJE_P2',
    ref: 'ghl.js:181',
    estado: 'triaje_p3',
    ctxUpdate: payload => (payload ? { triaje: { p2: payload } } : {}),
    effects: () => [],
  },
  {
    tag: 'TRIAJE_P3',
    ref: 'ghl.js:182',
    estado: null, // stores the answer only — only TRIAJE_COMPLETO advances
    ctxUpdate: payload => (payload ? { triaje: { p3: payload } } : {}),
    effects: () => [],
  },
  {
    tag: 'TRIAJE_COMPLETO',
    ref: 'ghl.js:183-187',
    estado: 'triaje_completo',
    ctxUpdate: () => ({}),
    effects: () => [
      { type: EFFECT.ADD_TAG, tag: 'nhck-triaje-<p1>' },
      { type: EFFECT.UPDATE_OPPORTUNITY_STAGE, stage: 'STAGE_INFO_COMPLETA' },
    ],
  },
];

/** STAGE 2 — early-return branches (ghl.js:190-413). FIRST match wins. */
const BRANCHES = [
  {
    tag: 'CITA_CONFIRMADA',
    ref: 'ghl.js:190-267',
    estado: 'esperando_pago',
    continues: false,
    ctxUpdate: () => ({}),
    effects: () => [
      { type: EFFECT.UPDATE_GHL_CONTACT, fields: ['email', 'city', 'nombre'] },
      { type: EFFECT.CLEAR_CONTACT_CACHE },
      { type: EFFECT.SAVE_PATIENT_FIELDS },
      { type: EFFECT.UPDATE_OPPORTUNITY_STAGE, stage: 'STAGE_LINK_PAGO' },
      { type: EFFECT.LOG_EVENT, event: 'cita_confirmada' },
      { type: EFFECT.CREATE_WOMPI_PAYMENT, amount: 100000, currency: 'COP' },
      { type: EFFECT.INSERT_PENDING_PAYMENT },
      { type: EFFECT.SEND_FIXED_MESSAGE, message: 'medios_de_pago' },
      { type: EFFECT.START_INACTIVITY_TIMERS },
    ],
  },

  // --- Payment-method branches (ghl.js:271-318) ------------------------------
  // Gated on estado === 'esperando_pago'. These were missing from the first
  // version of this spec, which made the financial gate incomplete: [MEDIO_WOMPI]
  // is a SECOND path that calls pagos.generarLinkPago (ghl.js:275).
  {
    tag: 'MEDIO_WOMPI',
    ref: 'ghl.js:274-292',
    appliesInEstado: estado => estado === 'esperando_pago',
    // DATA-DEPENDENT CONDITION, modeled explicitly.
    //
    // Production reads `pending = await db.getPendingPaymentsByContact(contactId)`
    // and the branch is `if (rawReply.includes('[MEDIO_WOMPI]') && pending)`. With
    // no pending row the branch does NOT match and control falls through to
    // MEDIO_TRANSFERENCIA, which has no such requirement.
    //
    // This used to be a comment saying "the eval assumes the row exists". An
    // assumption a reader has to find in a comment is not a model: it silently
    // scores one of the two real behaviors as the only behavior. Now the condition
    // is context, and an unknown value produces an INDETERMINATE decision instead
    // of a guess.
    requiresData: { pendingPayment: true },
    estado: 'esperando_pago',
    continues: false,
    ctxUpdate: () => ({}),
    effects: () => [
      { type: EFFECT.CREATE_WOMPI_PAYMENT, amount: 100000, currency: 'COP' },
      { type: EFFECT.SEND_MESSAGE, content: 'link_pago' },
    ],
  },
  {
    tag: 'MEDIO_TRANSFERENCIA',
    ref: 'ghl.js:294-305',
    appliesInEstado: estado => estado === 'esperando_pago',
    estado: 'esperando_pago',
    continues: false,
    ctxUpdate: () => ({}),
    effects: () => [
      { type: EFFECT.SEND_BANK_DETAILS, banco: 'Bancolombia', amount: 100000 },
    ],
  },
  {
    tag: 'MEDIO_QR',
    ref: 'ghl.js:307-318',
    appliesInEstado: estado => estado === 'esperando_pago',
    estado: 'esperando_pago',
    continues: false,
    ctxUpdate: () => ({}),
    effects: () => [
      { type: EFFECT.SEND_BANK_DETAILS, banco: 'Bancolombia QR', amount: 100000 },
    ],
  },

  {
    tag: 'CIUDAD_NO_DISPONIBLE',
    ref: 'ghl.js:322-333',
    estado: 'cerrado',
    continues: false,
    ctxUpdate: () => ({}),
    effects: () => [
      { type: EFFECT.ADD_TAG, tag: 'fuera-ciudad nhck' },
      { type: EFFECT.LOG_EVENT, event: 'cierre_fuera_ciudad' },
      { type: EFFECT.TRIGGER_ANALYSIS, motivo: 'fuera_ciudad' },
    ],
  },
  {
    tag: 'SIN_PRESUPUESTO',
    ref: 'ghl.js:336-347',
    estado: 'cerrado',
    continues: false,
    ctxUpdate: () => ({}),
    effects: () => [
      { type: EFFECT.ADD_TAG, tag: 'sin-presupuesto nhck' },
      { type: EFFECT.LOG_EVENT, event: 'cierre_sin_presupuesto' },
      { type: EFFECT.TRIGGER_ANALYSIS, motivo: 'sin_presupuesto' },
    ],
  },
  {
    tag: 'FUERA_SEGMENTO',
    ref: 'ghl.js:350-361',
    estado: 'cerrado',
    continues: false,
    ctxUpdate: () => ({}),
    effects: () => [
      { type: EFFECT.ADD_TAG, tag: 'fuera-segmento nhck' },
      { type: EFFECT.LOG_EVENT, event: 'cierre_fuera_segmento' },
      { type: EFFECT.TRIGGER_ANALYSIS, motivo: 'fuera_segmento' },
    ],
  },
  {
    tag: 'NHC_ADULTOS',
    ref: 'ghl.js:366-378',
    estado: 'triaje_p1',
    continues: true, // early return, but the exchange continues as Luisa
    ctxUpdate: () => ({ derivadoA: 'luisa' }),
    effects: () => [
      { type: EFFECT.SET_DERIVADO_A, value: 'luisa' },
      { type: EFFECT.ADD_TAG, tag: 'nhc-adultos' },
      { type: EFFECT.ADD_TAG, tag: 'escalado nhck-a-nhc' },
      { type: EFFECT.LOG_EVENT, event: 'derivado_nhck_a_nhc' },
    ],
  },
  {
    tag: 'ESCALAR',
    ref: 'ghl.js:381-397',
    estado: 'escalado',
    continues: false,
    ctxUpdate: () => ({}),
    effects: () => [
      { type: EFFECT.ADD_TAG, tag: 'escalado nhck' },
      { type: EFFECT.LOG_EVENT, event: 'escalado' },
      { type: EFFECT.TRIGGER_ANALYSIS, motivo: 'escalado' },
    ],
  },
  {
    tag: 'POSPONER',
    ref: 'ghl.js:400-413',
    estado: null, // keeps the accumulator's estado — there is no 'pospuesto' estado
    continues: false,
    ctxUpdate: () => ({}),
    effects: () => [{ type: EFFECT.SET_RECOVERY_STATUS, value: 'pospuesto' }],
  },
];

const TERMINAL_ESTADOS = ['escalado', 'cerrado', 'esperando_pago'];

/** Deep-ish merge that keeps `triaje` sub-keys instead of replacing the object. */
function mergeCtxUpdate(acc, update) {
  const out = { ...acc };
  for (const [k, v] of Object.entries(update)) {
    out[k] = k === 'triaje' ? { ...(acc.triaje || {}), ...v } : v;
  }
  return out;
}

/**
 * Resolve one turn. PURE — executes nothing.
 *
 * @param {string} estado                        estado entering the turn
 * @param {Array<{name,payload}>} tags           tags parsed from the reply
 * @param {object} [ctx]                         current context (read-only)
 * @returns {{
 *   nextState: string,
 *   continueConversation: boolean,
 *   ctxUpdates: object,
 *   effects: Array<{type: string}>,
 *   matchedRule: ?string,
 *   accumulatorRules: string[],
 * }}
 */
function resolveStateTransition(estado, tags = [], ctx = {}) {
  const names = tags.map(t => t.name);
  const payloadOf = name => tags.find(t => t.name === name)?.payload ?? null;

  let nextState = estado;
  let ctxUpdates = {};
  const effects = [];
  const accumulatorRules = [];

  // Stage 1 — every matching rule applies, in order; the last estado wins.
  for (const rule of ACCUMULATOR) {
    if (!names.includes(rule.tag)) continue;
    if (rule.appliesWhen && !rule.appliesWhen(estado)) continue;
    const payload = payloadOf(rule.tag);
    accumulatorRules.push(rule.tag);
    if (rule.estado) nextState = rule.estado;
    ctxUpdates = mergeCtxUpdate(ctxUpdates, rule.ctxUpdate(payload, ctx));
    effects.push(...rule.effects(payload, ctx));
  }

  // Stage 2 — first matching branch wins and overrides the accumulator's estado.
  //
  // Three gates per branch, in order, because they fail differently:
  //   · appliesInEstado — the branch does not exist in this estado. Falls through.
  //   · requiresData with an UNKNOWN value — production's behavior depends on data
  //     the eval was not given. Returns INDETERMINATE rather than picking a side.
  //   · requiresData with a KNOWN value that does not match — falls through, which
  //     is what production does.
  for (const branch of BRANCHES) {
    if (!names.includes(branch.tag)) continue;
    if (branch.appliesInEstado && !branch.appliesInEstado(estado)) continue;

    if (branch.requiresData) {
      const desconocidos = Object.keys(branch.requiresData).filter(k => ctx[k] === undefined);
      if (desconocidos.length) {
        return {
          nextState: null,
          continueConversation: null,
          ctxUpdates: null,
          effects: null,
          matchedRule: null,
          accumulatorRules,
          indeterminate: true,
          indeterminateReason:
            `[${branch.tag}] en estado '${estado}' depende de ${desconocidos.join(', ')}, ` +
            `que no vino en el contexto. Producción resolvería a '${branch.estado}' si es true, ` +
            `o caería a la rama siguiente si es false. La evaluación no adivina.`,
          missingContext: desconocidos,
        };
      }
      const noMatchea = Object.entries(branch.requiresData).some(([k, v]) => ctx[k] !== v);
      if (noMatchea) continue;
    }

    const finalState = branch.estado || nextState;
    return {
      nextState: finalState,
      continueConversation: branch.continues && !TERMINAL_ESTADOS.includes(finalState),
      ctxUpdates: mergeCtxUpdate(ctxUpdates, branch.ctxUpdate()),
      // Every branch persists the conversation and sends the model's text, except
      // the ones that declare their own message effect (CITA_CONFIRMADA sends a
      // fixed script; MEDIO_* send generated payment instructions).
      effects: [
        ...effects,
        ...branch.effects(),
        { type: EFFECT.SAVE_CONVERSATION, estado: finalState },
        ...(branch.effects().some(e => /MESSAGE|BANK_DETAILS/.test(e.type))
          ? [] : [{ type: EFFECT.SEND_MESSAGE, content: 'texto_del_modelo' }]),
      ],
      matchedRule: branch.tag,
      accumulatorRules,
      indeterminate: false,
    };
  }

  // Normal path (ghl.js:415-427): sends the model's text and starts the inactivity
  // timers that later mark the conversation `cerrado`.
  return {
    nextState,
    continueConversation: !TERMINAL_ESTADOS.includes(nextState),
    ctxUpdates,
    effects: [
      ...effects,
      { type: EFFECT.SAVE_CONVERSATION, estado: nextState },
      { type: EFFECT.SEND_MESSAGE, content: 'texto_del_modelo' },
      { type: EFFECT.START_INACTIVITY_TIMERS },
    ],
    matchedRule: null,
    accumulatorRules,
    indeterminate: false,
  };
}

module.exports = {
  resolveStateTransition,
  EFFECT, FINANCIAL_EFFECTS, isFinancial,
  ACCUMULATOR, BRANCHES, TERMINAL_ESTADOS, mergeCtxUpdate,
};
