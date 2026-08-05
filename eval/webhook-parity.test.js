'use strict';

/**
 * Parity between production routing and the evaluation, at two levels.
 *
 *   node eval/webhook-parity.test.js
 *   node eval/webhook-parity.test.js --update    (after an intentional webhook change)
 *
 * NIVEL 1 — ALARMA DE DERIVA. Hashes the normalized source of each routing branch
 *   in webhooks/ghl.js. Detects that a branch changed. It does NOT prove the spec
 *   still describes it correctly, and normalization means it tolerates comment and
 *   whitespace edits but not logic edits. Treat a failure as "go read the diff",
 *   never as "the eval is wrong".
 *
 * NIVEL 2 — CONTRATO SEMÁNTICO. Exercises resolveStateTransition() — the pure
 *   function that production is meant to consume too — over the combinations where
 *   precedence decides the outcome. This is the level that proves behavior.
 *
 * NIVEL 3 — SEGURIDAD FINANCIERA. Statically proves no module under eval/ can
 *   execute a payment, and that every effect the harness produces is simulated.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { resolveStateTransition, EFFECT, FINANCIAL_EFFECTS } = require('./state-spec');
const { simulateEffects, financialEffects, diffEffects } = require('./effects');

const REPO = path.join(__dirname, '..');
const WEBHOOK = path.join(REPO, 'webhooks', 'ghl.js');
const BASELINE = path.join(__dirname, 'webhook-baseline.json');
const UPDATE = process.argv.includes('--update');

let n = 0, failed = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

// ---------------------------------------------------------------------------
// NIVEL 1 — alarma de deriva
// ---------------------------------------------------------------------------

/** Anchors for each routing block. If an anchor stops matching, the shape changed. */
const PROBES = [
  { id: 'NOMBRE_PADRE', anchor: /if \(matchNombrePadre && estado === 'nuevo'\) \{/ },
  { id: 'CIUDAD_VALIDA', anchor: /if \(matchCiudad\) \{/ },
  { id: 'TRIAJE_P1', anchor: /if \(matchP1\) \{/ },
  { id: 'TRIAJE_P2', anchor: /if \(matchP2\) \{/ },
  { id: 'TRIAJE_P3', anchor: /if \(matchP3\) \{/ },
  { id: 'TRIAJE_COMPLETO', anchor: /if \(triajeCompleto\) \{/ },
  { id: 'CITA_CONFIRMADA', anchor: /if \(rawReply\.includes\('\[CITA_CONFIRMADA\]'\)\) \{/ },
  { id: 'CIUDAD_NO_DISPONIBLE', anchor: /if \(rawReply\.includes\('\[CIUDAD_NO_DISPONIBLE\]'\)\) \{/ },
  { id: 'SIN_PRESUPUESTO', anchor: /if \(rawReply\.includes\('\[SIN_PRESUPUESTO\]'\)\) \{/ },
  { id: 'FUERA_SEGMENTO', anchor: /if \(rawReply\.includes\('\[FUERA_SEGMENTO\]'\)\) \{/ },
  { id: 'NHC_ADULTOS', anchor: /if \(rawReply\.includes\('\[NHC_ADULTOS\]'\)\) \{/ },
  { id: 'ESCALAR', anchor: /if \(rawReply\.includes\('\[ESCALAR\]'\)\) \{/ },
  { id: 'POSPONER', anchor: /if \(rawReply\.includes\('\[POSPONER\]'\)\) \{/ },
];

/**
 * Extract the block starting at the anchor. Blocks in this handler close on a line
 * that is exactly four spaces plus `}`; short one-liners balance on their own line.
 */
function extractBlock(lines, startIdx) {
  const first = lines[startIdx];
  const balanced = (first.match(/\{/g) || []).length === (first.match(/\}/g) || []).length;
  if (balanced) return first;
  const out = [first];
  for (let i = startIdx + 1; i < lines.length; i++) {
    out.push(lines[i]);
    if (/^ {4}\}/.test(lines[i])) break;
  }
  return out.join('\n');
}

/** Strip comments and collapse whitespace so cosmetic edits do not fire the alarm. */
function normalize(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function currentHashes() {
  const src = fs.readFileSync(WEBHOOK, 'utf8');
  const lines = src.split(/\r?\n/);
  const out = {};
  for (const p of PROBES) {
    const idx = lines.findIndex(l => p.anchor.test(l));
    if (idx === -1) { out[p.id] = null; continue; }
    const block = extractBlock(lines, idx);
    out[p.id] = {
      line: idx + 1,
      sha256: crypto.createHash('sha256').update(normalize(block)).digest('hex').slice(0, 16),
    };
  }
  return out;
}

if (UPDATE) {
  const h = currentHashes();
  fs.writeFileSync(BASELINE, JSON.stringify({
    _comment: 'Generado por: node eval/webhook-parity.test.js --update. Regeneralo SOLO después de revisar que state-spec.js sigue describiendo el comportamiento nuevo.',
    updatedAt: new Date().toISOString(),
    file: 'webhooks/ghl.js',
    blocks: h,
  }, null, 2));
  console.log(`Baseline actualizado: ${BASELINE}`);
  for (const [k, v] of Object.entries(h)) console.log(`  ${k.padEnd(22)} L${v?.line ?? '—'}  ${v?.sha256 ?? 'NO ENCONTRADO'}`);
  process.exit(0);
}

console.log('\nNIVEL 1 — alarma de deriva en webhooks/ghl.js');

if (!fs.existsSync(BASELINE)) {
  console.log('  (sin baseline — corré: node eval/webhook-parity.test.js --update)');
} else {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).blocks;
  const current = currentHashes();

  for (const p of PROBES) {
    test(`bloque \`${p.id}\` sin cambios`, () => {
      const was = baseline[p.id];
      const now = current[p.id];
      assert.ok(now, `El bloque de ${p.id} DESAPARECIÓ de webhooks/ghl.js o cambió de forma. ` +
        `Revisar y actualizar state-spec.js.`);
      assert.ok(was, `No hay baseline para ${p.id}; corré --update tras revisar el spec.`);
      assert.strictEqual(now.sha256, was.sha256,
        `Cambió el bloque de producción relacionado con ${p.id} ` +
        `(webhooks/ghl.js:${now.line}, antes L${was.line}); revisar y actualizar state-spec.js. ` +
        `Esto es una ALARMA: el hash detecta que cambió, no si el spec sigue siendo correcto.`);
    });
  }
}

// ---------------------------------------------------------------------------
// NIVEL 2 — contrato semántico
// ---------------------------------------------------------------------------

console.log('\nNIVEL 2 — contrato semántico (resolveStateTransition)');

const T = (name, payload = null) => ({ name, payload });
const types = d => d.effects.map(e => e.type);

/**
 * The mandatory cases. Each asserts estado, replay continuity, ctx updates, the
 * winning rule, the external effects, and whether financial or clinical risk is
 * involved.
 */
const CASOS = [
  {
    nombre: 'CITA_CONFIRMADA',
    estado: 'agendando', tags: [T('CITA_CONFIRMADA')],
    espera: {
      nextState: 'esperando_pago', continua: false, matchedRule: 'CITA_CONFIRMADA',
      ctx: {}, financiero: true,
      efectos: [EFFECT.CREATE_WOMPI_PAYMENT, EFFECT.INSERT_PENDING_PAYMENT],
    },
  },
  {
    nombre: 'CITA_CONFIRMADA + ESCALAR',
    estado: 'agendando', tags: [T('CITA_CONFIRMADA'), T('ESCALAR')],
    espera: {
      nextState: 'esperando_pago', continua: false, matchedRule: 'CITA_CONFIRMADA',
      ctx: {}, financiero: true,
      efectos: [EFFECT.CREATE_WOMPI_PAYMENT],
      noEfectos: [], // la rama de cita retorna primero: el escalamiento NO ocurre
    },
  },
  {
    nombre: 'CITA_CONFIRMADA + CIUDAD_NO_DISPONIBLE',
    estado: 'agendando', tags: [T('CITA_CONFIRMADA'), T('CIUDAD_NO_DISPONIBLE')],
    espera: {
      nextState: 'esperando_pago', continua: false, matchedRule: 'CITA_CONFIRMADA',
      ctx: {}, financiero: true,
      efectos: [EFFECT.CREATE_WOMPI_PAYMENT],
    },
  },
  {
    nombre: 'CITA_CONFIRMADA + POSPONER',
    estado: 'agendando', tags: [T('CITA_CONFIRMADA'), T('POSPONER')],
    espera: {
      nextState: 'esperando_pago', continua: false, matchedRule: 'CITA_CONFIRMADA',
      ctx: {}, financiero: true,
      efectos: [EFFECT.CREATE_WOMPI_PAYMENT],
      noEfectos: [EFFECT.SET_RECOVERY_STATUS], // POSPONER nunca se alcanza
    },
  },
  {
    nombre: 'MEDIO_WOMPI · esperando_pago · CON pago pendiente (SEGUNDA ruta de cobro)',
    estado: 'esperando_pago', tags: [T('MEDIO_WOMPI')], entrada: { pendingPayment: true },
    espera: {
      nextState: 'esperando_pago', continua: false, matchedRule: 'MEDIO_WOMPI',
      ctx: {}, financiero: true,
      efectos: [EFFECT.CREATE_WOMPI_PAYMENT],
    },
  },
  {
    nombre: 'MEDIO_WOMPI · esperando_pago · SIN pago pendiente cae a la rama siguiente',
    estado: 'esperando_pago', tags: [T('MEDIO_WOMPI')], entrada: { pendingPayment: false },
    espera: {
      // `if (rawReply.includes('[MEDIO_WOMPI]') && pending)` — sin `pending` la rama
      // no matchea y el control sigue. Sin otro tag de medio, sale del bloque de
      // esperando_pago y termina en el camino normal.
      nextState: 'esperando_pago', continua: false, matchedRule: null,
      ctx: {}, financiero: false,
      efectos: [EFFECT.SEND_MESSAGE],
      noEfectos: [EFFECT.CREATE_WOMPI_PAYMENT],
    },
  },
  {
    nombre: 'MEDIO_WOMPI + MEDIO_TRANSFERENCIA · SIN pendiente → gana transferencia',
    estado: 'esperando_pago', tags: [T('MEDIO_WOMPI'), T('MEDIO_TRANSFERENCIA')],
    entrada: { pendingPayment: false },
    espera: {
      nextState: 'esperando_pago', continua: false, matchedRule: 'MEDIO_TRANSFERENCIA',
      ctx: {}, financiero: true,
      efectos: [EFFECT.SEND_BANK_DETAILS],
      noEfectos: [EFFECT.CREATE_WOMPI_PAYMENT],
    },
  },
  {
    nombre: 'MEDIO_WOMPI fuera de esperando_pago NO cobra (ni consulta el pendiente)',
    estado: 'triaje_p2', tags: [T('MEDIO_WOMPI')],
    espera: {
      // La rama vive dentro de `if (estado === 'esperando_pago')`; fuera de ahí el
      // tag cae al camino normal SIN evaluar la condición de datos.
      nextState: 'triaje_p2', continua: true, matchedRule: null,
      ctx: {}, financiero: false,
      efectos: [EFFECT.SEND_MESSAGE],
      noEfectos: [EFFECT.CREATE_WOMPI_PAYMENT],
    },
  },
  {
    nombre: 'MEDIO_TRANSFERENCIA publica la cuenta bancaria real',
    estado: 'esperando_pago', tags: [T('MEDIO_TRANSFERENCIA')],
    espera: {
      nextState: 'esperando_pago', continua: false, matchedRule: 'MEDIO_TRANSFERENCIA',
      ctx: {}, financiero: true,
      efectos: [EFFECT.SEND_BANK_DETAILS],
    },
  },
  {
    nombre: 'MEDIO_QR publica la llave de pago',
    estado: 'esperando_pago', tags: [T('MEDIO_QR')],
    espera: {
      nextState: 'esperando_pago', continua: false, matchedRule: 'MEDIO_QR',
      ctx: {}, financiero: true,
      efectos: [EFFECT.SEND_BANK_DETAILS],
    },
  },
  {
    nombre: 'CITA_CONFIRMADA + MEDIO_WOMPI',
    estado: 'esperando_pago', tags: [T('CITA_CONFIRMADA'), T('MEDIO_WOMPI')], entrada: { pendingPayment: true },
    espera: {
      nextState: 'esperando_pago', continua: false, matchedRule: 'CITA_CONFIRMADA',
      ctx: {}, financiero: true,
      // La rama de cita retorna primero: un solo link, no dos.
      efectos: [EFFECT.CREATE_WOMPI_PAYMENT, EFFECT.INSERT_PENDING_PAYMENT],
      sinDuplicados: EFFECT.CREATE_WOMPI_PAYMENT,
    },
  },
  {
    nombre: 'ESCALAR + NHC_ADULTOS',
    estado: 'triaje_p1', tags: [T('ESCALAR'), T('NHC_ADULTOS')],
    espera: {
      nextState: 'triaje_p1', continua: true, matchedRule: 'NHC_ADULTOS',
      ctx: { derivadoA: 'luisa' }, financiero: false,
      efectos: [EFFECT.SET_DERIVADO_A],
      noEfectos: [EFFECT.TRIGGER_ANALYSIS], // la derivación gana; no escala
    },
  },
  {
    nombre: 'ESCALAR + FUERA_SEGMENTO',
    estado: 'triaje_p1', tags: [T('ESCALAR'), T('FUERA_SEGMENTO')],
    espera: {
      nextState: 'cerrado', continua: false, matchedRule: 'FUERA_SEGMENTO',
      ctx: {}, financiero: false,
      efectos: [EFFECT.ADD_TAG, EFFECT.LOG_EVENT, EFFECT.TRIGGER_ANALYSIS],
    },
  },
  {
    nombre: 'TRIAJE_P3 sin TRIAJE_COMPLETO',
    estado: 'triaje_p3', tags: [T('TRIAJE_P3', 'Terapia de lenguaje')],
    espera: {
      nextState: 'triaje_p3', continua: true, matchedRule: null,
      ctx: { triaje: { p3: 'Terapia de lenguaje' } }, financiero: false,
      efectos: [],
    },
  },
  {
    nombre: 'TRIAJE_P3 + TRIAJE_COMPLETO',
    estado: 'triaje_p3', tags: [T('TRIAJE_P3', 'Nada'), T('TRIAJE_COMPLETO')],
    espera: {
      nextState: 'triaje_completo', continua: true, matchedRule: null,
      ctx: { triaje: { p3: 'Nada' } }, financiero: false,
      efectos: [EFFECT.ADD_TAG, EFFECT.UPDATE_OPPORTUNITY_STAGE],
    },
  },
  {
    nombre: 'varios tags de triaje en una sola respuesta',
    estado: 'triaje_p1', tags: [T('TRIAJE_P1', 'TDAH'), T('TRIAJE_P2', '2 años'), T('TRIAJE_P3', 'Nada')],
    espera: {
      nextState: 'triaje_p3', continua: true, matchedRule: null,
      ctx: { triaje: { p1: 'TDAH', p2: '2 años', p3: 'Nada' } }, financiero: false,
      efectos: [EFFECT.SAVE_SYMPTOM],
    },
  },
  {
    nombre: 'tags duplicados',
    estado: 'triaje_p1', tags: [T('TRIAJE_P1', 'TDAH'), T('TRIAJE_P1', 'Ansiedad')],
    espera: {
      nextState: 'triaje_p2', continua: true, matchedRule: null,
      // El webhook usa String.match(), que devuelve la PRIMERA coincidencia.
      ctx: { triaje: { p1: 'TDAH' } }, financiero: false,
      efectos: [EFFECT.SAVE_SYMPTOM],
      sinDuplicados: EFFECT.SAVE_SYMPTOM, // la regla corre una sola vez
    },
  },
  {
    nombre: 'tag desconocido junto a uno válido',
    estado: 'triaje_p1', tags: [T('AGENDA_LISTA'), T('TRIAJE_P1', 'TDAH')],
    espera: {
      nextState: 'triaje_p2', continua: true, matchedRule: null,
      ctx: { triaje: { p1: 'TDAH' } }, financiero: false,
      efectos: [EFFECT.SAVE_SYMPTOM],
      // El desconocido se ignora en el ruteo. graders.js lo marca aparte como
      // `tags:invented`, que es donde tiene que doler.
    },
  },
];

for (const c of CASOS) {
  test(`${c.nombre} → estado`, () => {
    assert.strictEqual(resolveStateTransition(c.estado, c.tags, c.entrada || {}).nextState, c.espera.nextState);
  });
  test(`${c.nombre} → continuidad del replay`, () => {
    assert.strictEqual(resolveStateTransition(c.estado, c.tags, c.entrada || {}).continueConversation, c.espera.continua);
  });
  test(`${c.nombre} → regla ganadora`, () => {
    assert.strictEqual(resolveStateTransition(c.estado, c.tags, c.entrada || {}).matchedRule, c.espera.matchedRule);
  });
  test(`${c.nombre} → cambios de contexto`, () => {
    assert.deepStrictEqual(resolveStateTransition(c.estado, c.tags, c.entrada || {}).ctxUpdates, c.espera.ctx);
  });
  test(`${c.nombre} → efectos externos`, () => {
    const d = resolveStateTransition(c.estado, c.tags, c.entrada || {});
    for (const e of c.espera.efectos) assert.ok(types(d).includes(e), `falta ${e}; hay [${types(d)}]`);
    for (const e of c.espera.noEfectos || []) assert.ok(!types(d).includes(e), `no debía estar ${e}`);
    if (c.espera.sinDuplicados) {
      const veces = types(d).filter(t => t === c.espera.sinDuplicados).length;
      assert.strictEqual(veces, 1, `${c.espera.sinDuplicados} aparece ${veces} veces: [${types(d)}]`);
    }
  });
  test(`${c.nombre} → riesgo financiero declarado`, () => {
    const d = resolveStateTransition(c.estado, c.tags, c.entrada || {});
    const tieneRiesgo = d.effects.some(e => FINANCIAL_EFFECTS.has(e.type));
    assert.strictEqual(tieneRiesgo, c.espera.financiero);
  });
}

console.log('\nNIVEL 2a — condición dependiente de datos: pending_payments');

test('sin `pendingPayment` en el contexto la decisión es INDETERMINADA, no una suposición', () => {
  const d = resolveStateTransition('esperando_pago', [T('MEDIO_WOMPI')], {});
  assert.strictEqual(d.indeterminate, true);
  assert.strictEqual(d.nextState, null, 'no puede afirmar un estado siguiente');
  assert.strictEqual(d.effects, null, 'no puede afirmar efectos');
  assert.deepStrictEqual(d.missingContext, ['pendingPayment']);
  assert.match(d.indeterminateReason, /pendingPayment/);
  assert.match(d.indeterminateReason, /no adivina/);
});

test('la indeterminación NO se propaga a otros tags ni a otros estados', () => {
  // Solo la rama con requiresData la produce, y solo dentro de su estado.
  assert.strictEqual(resolveStateTransition('esperando_pago', [T('MEDIO_TRANSFERENCIA')], {}).indeterminate, false);
  assert.strictEqual(resolveStateTransition('triaje_p2', [T('MEDIO_WOMPI')], {}).indeterminate, false);
  assert.strictEqual(resolveStateTransition('agendando', [T('CITA_CONFIRMADA')], {}).indeterminate, false);
});

test('una rama anterior gana antes de que la condición de datos se evalúe', () => {
  // CITA_CONFIRMADA retorna primero, así que no importa si hay pendiente o no.
  const d = resolveStateTransition('esperando_pago', [T('CITA_CONFIRMADA'), T('MEDIO_WOMPI')], {});
  assert.strictEqual(d.indeterminate, false);
  assert.strictEqual(d.matchedRule, 'CITA_CONFIRMADA');
});

test('con pendingPayment=false el efecto financiero desaparece', () => {
  const con = simulateEffects(resolveStateTransition('esperando_pago', [T('MEDIO_WOMPI')], { pendingPayment: true }).effects);
  const sin = simulateEffects(resolveStateTransition('esperando_pago', [T('MEDIO_WOMPI')], { pendingPayment: false }).effects);
  assert.strictEqual(financialEffects(con).length, 1);
  assert.strictEqual(financialEffects(sin).length, 0, 'sin fila pendiente no hay link de pago');
});

console.log('\nNIVEL 2b — la función es pura');

test('resolveStateTransition no muta el contexto que recibe', () => {
  const ctx = Object.freeze({ nombre: 'Ana', triaje: Object.freeze({ p1: 'TDAH' }), derivadoA: null });
  const d = resolveStateTransition('triaje_p1', [T('TRIAJE_P2', 'B'), T('NHC_ADULTOS')], ctx);
  assert.strictEqual(ctx.nombre, 'Ana');
  assert.strictEqual(ctx.triaje.p1, 'TDAH');
  assert.strictEqual(ctx.derivadoA, null);
  assert.strictEqual(d.ctxUpdates.derivadoA, 'luisa', 'el cambio va en ctxUpdates, no en ctx');
});

test('la misma entrada da la misma salida', () => {
  const a = resolveStateTransition('triaje_p1', [T('TRIAJE_P1', 'x'), T('ESCALAR')]);
  const b = resolveStateTransition('triaje_p1', [T('TRIAJE_P1', 'x'), T('ESCALAR')]);
  assert.deepStrictEqual(a, b);
});

// ---------------------------------------------------------------------------
// NIVEL 3 — seguridad financiera
// ---------------------------------------------------------------------------

console.log('\nNIVEL 3 — los efectos financieros son imposibles de ejecutar desde eval/');

/**
 * Two scans, because they need opposite treatments of string literals.
 *
 * An import path IS a string, so the import scan runs on source with strings
 * intact. A call is code, so the call scan runs on source with strings and regex
 * literals blanked — otherwise this very file, which has to name every forbidden
 * function to define the patterns, flags itself. A guard that flags itself gets
 * disabled for being noisy, and then it guards nothing.
 */
const IMPORTS_PROHIBIDOS = [
  { re: /require\(\s*['"][^'"]*services\/pagos['"]\s*\)/, que: 'services/pagos (Wompi)' },
  { re: /require\(\s*['"][^'"]*services\/ghl['"]\s*\)/, que: 'services/ghl (envío de mensajes, tags)' },
  { re: /require\(\s*['"][^'"]*services\/zoho['"]\s*\)/, que: 'services/zoho' },
  { re: /require\(\s*['"][^'"]*jobs\/[^'"]*['"]\s*\)/, que: 'jobs/ (recovery, insights)' },
];

const LLAMADAS_PROHIBIDAS = [
  { re: /\bgenerarLinkPago\s*\(/, que: 'generarLinkPago()' },
  { re: /\bsavePendingPayment\s*\(/, que: 'savePendingPayment()' },
  { re: /\bsendMessages?\s*\(/, que: 'sendMessage()/sendMessages()' },
  { re: /\baddTag\s*\(/, que: 'addTag()' },
  { re: /\bactualizarEtapaOportunidad\s*\(/, que: 'actualizarEtapaOportunidad()' },
  { re: /\bguardarCampos\w*\s*\(/, que: 'guardarCampos*()' },
  { re: /\btriggerAnalysis\s*\(/, que: 'triggerAnalysis()' },
];

/**
 * This file is excluded from the IMPORT scan only, because its self-check fixture
 * contains a literal forbidden require. Two things keep that from being a hole:
 * the call scan still covers it, and `run.js` never requires any *.test.js — which
 * the last test in this section asserts.
 */
const EXENTO_IMPORTS = 'webhook-parity.test.js';

const evalFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.js'));

/**
 * Reduce a file to executable code: no strings, no template literals, no regex
 * literals, no comments.
 *
 * Naming `generarLinkPago` inside a regex or a comment does not call it — and this
 * file itself has to name all of them to define the patterns. Without this the
 * guard flags its own source, which is the classic way a safety check gets
 * disabled for being noisy.
 */
function soloCodigo(src) {
  return src
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
    .replace(/\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, ' RE ');
}

const sinComentarios = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

test(`ningún módulo de eval/ importa efectos reales (${evalFiles.length} archivos)`, () => {
  const hallazgos = [];
  for (const f of evalFiles) {
    if (f === EXENTO_IMPORTS) continue;
    const src = sinComentarios(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    for (const p of IMPORTS_PROHIBIDOS) if (p.re.test(src)) hallazgos.push(`${f} → ${p.que}`);
  }
  assert.deepStrictEqual(hallazgos, [], `eval/ importa módulos con efectos reales:\n       ${hallazgos.join('\n       ')}`);
});

test(`ningún módulo de eval/ invoca efectos reales (${evalFiles.length} archivos)`, () => {
  const hallazgos = [];
  for (const f of evalFiles) {
    const code = soloCodigo(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    for (const p of LLAMADAS_PROHIBIDAS) if (p.re.test(code)) hallazgos.push(`${f} → ${p.que}`);
  }
  assert.deepStrictEqual(hallazgos, [], `eval/ invoca efectos reales:\n       ${hallazgos.join('\n       ')}`);
});

test('el guard detecta una llamada real inyectada', () => {
  // Un guard que nunca puede fallar no protege nada.
  const inyectado = "const p = require('../services/pagos');\ngenerarLinkPago({ monto: 100000 });\naddTag(c, 'x');";
  const imports = IMPORTS_PROHIBIDOS.filter(p => p.re.test(sinComentarios(inyectado))).map(p => p.que);
  const llamadas = LLAMADAS_PROHIBIDAS.filter(p => p.re.test(soloCodigo(inyectado))).map(p => p.que);
  assert.ok(imports.includes('services/pagos (Wompi)'), `imports: ${imports}`);
  assert.ok(llamadas.includes('generarLinkPago()'), `llamadas: ${llamadas}`);
  assert.ok(llamadas.includes('addTag()'), `llamadas: ${llamadas}`);
});

test('la exención de imports solo cubre un archivo de test que run.js nunca carga', () => {
  assert.ok(EXENTO_IMPORTS.endsWith('.test.js'), 'la exención debe ser un test, no código del harness');
  const runSrc = sinComentarios(fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8'));
  assert.ok(!/require\([^)]*\.test['"]?\)/.test(runSrc) && !runSrc.includes('.test.js'),
    'run.js no debe requerir ningún archivo de test');
});

test('NINGÚN módulo de eval/ importa el pool de producción (../db)', () => {
  const conDb = evalFiles.filter(f =>
    /require\(\s*['"][^'"]*\.\.\/db['"]\s*\)/.test(sinComentarios(fs.readFileSync(path.join(__dirname, f), 'utf8'))));
  assert.deepStrictEqual(conDb, [],
    `importan el pool de producción (usa DATABASE_URL, con escritura): ${conDb.join(', ')}`);
});

test('quien usa pg lo hace con EVAL_DATABASE_URL, nunca con DATABASE_URL', () => {
  const conPg = evalFiles.filter(f =>
    /require\(\s*['"]pg['"]\s*\)/.test(sinComentarios(fs.readFileSync(path.join(__dirname, f), 'utf8'))));
  assert.ok(conPg.length > 0, 'se esperaba al menos un archivo con conexión propia');
  for (const f of conPg) {
    const code = sinComentarios(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    assert.ok(/EVAL_DATABASE_URL/.test(code), `${f} usa pg sin EVAL_DATABASE_URL`);
    // DATABASE_URL solo puede aparecer para ABORTAR si está presente.
    const usos = [...code.matchAll(/process\.env\.DATABASE_URL/g)];
    for (const u of usos) {
      const contexto = code.slice(Math.max(0, u.index - 120), u.index + 60);
      assert.ok(/if\s*\(|abort|process\.exit|throw/.test(contexto),
        `${f} usa DATABASE_URL fuera de un chequeo de aborto`);
    }
  }
});

test('extract-dataset.js no contiene ninguna sentencia SQL de escritura', () => {
  // Sobre el SQL real: los template literals de las consultas, no la prosa. El
  // chequeo anterior marcaba "drop-offs" dentro de un comentario de bloque.
  const src = fs.readFileSync(path.join(__dirname, 'extract-dataset.js'), 'utf8');
  const sinComentarios = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const consultas = [...sinComentarios.matchAll(/`([^`]*)`/g)].map(m => m[1]).filter(q => /\bSELECT\b/i.test(q));
  assert.ok(consultas.length > 0, 'no se encontró ninguna consulta que revisar');
  for (const q of consultas) {
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE)\b/i.test(q),
      `consulta con escritura: ${q.slice(0, 120)}`);
  }
});

test('effects.js no importa nada más que el spec puro', () => {
  const src = fs.readFileSync(path.join(__dirname, 'effects.js'), 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  assert.deepStrictEqual(requires, ['./state-spec'], `requires: ${requires.join(', ')}`);
});

test('simulateEffects marca TODO como simulado y congela los registros', () => {
  const d = resolveStateTransition('agendando', [T('CITA_CONFIRMADA')]);
  const sim = simulateEffects(d.effects);
  assert.ok(sim.length > 0);
  for (const e of sim) {
    assert.strictEqual(e.simulated, true, `${e.type} sin simulated:true`);
    assert.ok(Object.isFrozen(e), `${e.type} no está congelado`);
    assert.strictEqual(typeof e.execute, 'undefined', `${e.type} expone execute()`);
  }
});

test('el cobro aparece como registro simulado, nunca como llamada', () => {
  const sim = simulateEffects(resolveStateTransition('agendando', [T('CITA_CONFIRMADA')]).effects);
  const pago = sim.find(e => e.type === EFFECT.CREATE_WOMPI_PAYMENT);
  assert.deepStrictEqual({ ...pago }, {
    type: 'CREATE_WOMPI_PAYMENT', amount: 100000, currency: 'COP', simulated: true, financial: true,
  });
  assert.strictEqual(financialEffects(sim).length, 2, 'link de pago + fila en pending_payments');
});

test('el gate financiero cubre LAS TRES rutas que tocan dinero, no solo la cita', () => {
  const rutas = [
    { estado: 'agendando', tag: 'CITA_CONFIRMADA', espera: EFFECT.CREATE_WOMPI_PAYMENT },
    { estado: 'esperando_pago', tag: 'MEDIO_WOMPI', espera: EFFECT.CREATE_WOMPI_PAYMENT },
    { estado: 'esperando_pago', tag: 'MEDIO_TRANSFERENCIA', espera: EFFECT.SEND_BANK_DETAILS },
    { estado: 'esperando_pago', tag: 'MEDIO_QR', espera: EFFECT.SEND_BANK_DETAILS },
  ];
  for (const r of rutas) {
    const sim = simulateEffects(resolveStateTransition(r.estado, [T(r.tag)], { pendingPayment: true }).effects);
    const fin = financialEffects(sim);
    assert.ok(fin.length > 0, `${r.tag} no marca riesgo financiero`);
    assert.ok(fin.some(e => e.type === r.espera), `${r.tag}: esperaba ${r.espera}, hay [${fin.map(e => e.type)}]`);
  }
});

test('un [MEDIO_WOMPI] espurio también se detecta como sobrante financiero', () => {
  const got = simulateEffects(resolveStateTransition('esperando_pago', [T('MEDIO_WOMPI')], { pendingPayment: true }).effects);
  const want = simulateEffects(resolveStateTransition('esperando_pago', [], { pendingPayment: true }).effects);
  const d = diffEffects(got, want);
  assert.strictEqual(d.ok, false);
  assert.ok(d.sobrantesFinancieros.some(e => e.type === EFFECT.CREATE_WOMPI_PAYMENT));
});

test('un [CITA_CONFIRMADA] espurio se detecta como sobrante financiero', () => {
  const got = simulateEffects(resolveStateTransition('triaje_p2', [T('CITA_CONFIRMADA')]).effects);
  const want = simulateEffects(resolveStateTransition('triaje_p2', []).effects);
  const d = diffEffects(got, want);
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.sobrantesFinancieros.length, 2);
  assert.ok(d.sobrantesFinancieros.every(e => e.simulated === true));
});

console.log(`\n${n - failed}/${n} OK`);
process.exit(failed ? 1 : 0);
