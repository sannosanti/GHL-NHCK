'use strict';

/**
 * Tests for the graders and the state machine.
 *
 *   node eval/graders.test.js
 *
 * A grader that never fires is worse than no grader: it reports 100% and hides
 * every real failure. Each case asserts both directions — that the check fires on
 * the violation AND that it stays quiet on the legitimate case.
 *
 * Aggregation, clustering, paired comparison, the gate and cost projection are in
 * pipeline.test.js — those need run fixtures, not turns.
 */

const assert = require('assert');
const { gradeTurn } = require('./graders');
const { transition, stopsReplay } = require('./replay');
const { resolveStateTransition, EFFECT, FINANCIAL_EFFECTS } = require('./state-spec');

let n = 0, failed = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
const kinds = g => g.failures.map(f => `${f.metric}:${f.kind}`);
const has = (g, k) => assert.ok(kinds(g).includes(k), `esperaba ${k}, obtuve [${kinds(g)}]`);
const lacks = (g, k) => assert.ok(!kinds(g).includes(k), `no esperaba ${k}, obtuve [${kinds(g)}]`);

console.log('\nTAGS');

test('1. respuesta limpia con el tag esperado pasa todas las métricas', () => {
  const g = gradeTurn({
    raw: 'Buenas tardes, con gusto te ayudo. ¿En qué ciudad se encuentran?\n[CIUDAD_VALIDA: Medellin]',
    userMessage: 'Hola, estamos en Medellin',
    expect: { tags_required: ['CIUDAD_VALIDA'] },
  });
  assert.ok(g.pass.tags && g.pass.flow, kinds(g));
});

test('2. ningún tag sobrevive al texto que ve el paciente', () => {
  const g = gradeTurn({ raw: 'Listo [TRIAJE_COMPLETO]', userMessage: 'ok', expect: {} });
  assert.ok(!g.patientText.includes('['), g.patientText);
});

test('3. detecta tag inventado (el webhook no lo rutearía)', () =>
  has(gradeTurn({ raw: 'Listo. [AGENDA_LISTA]', userMessage: 'ok', expect: {} }), 'tags:invented'));

test('4. detecta tag requerido faltante', () =>
  has(gradeTurn({ raw: 'Perfecto.', userMessage: 'x', expect: { tags_required: ['TRIAJE_P1'] } }), 'tags:missing'));

test('5. detecta tag prohibido emitido', () =>
  has(gradeTurn({ raw: 'Listo [CITA_CONFIRMADA]', userMessage: 'x', expect: { tags_forbidden: ['CITA_CONFIRMADA'] } }), 'tags:forbidden'));

test('6. el formato con payload también se acepta como requerido', () => {
  const g = gradeTurn({
    raw: 'Anotado. [TRIAJE_P1: TDAH]', userMessage: 'tiene tdah',
    expect: { tags_required: [{ name: 'TRIAJE_P1', payload: 'TDAH' }] },
  });
  lacks(g, 'tags:missing');
});

test('7. detecta payload vacío (escribiría un triaje vacío en la base)', () =>
  has(gradeTurn({ raw: 'Anotado. [TRIAJE_P1:]', userMessage: 'no se', expect: {} }), 'tags:empty_payload'));

test('8. detecta fuga de marcador al paciente', () =>
  // Corchete en minúscula: limpiarTags solo saca las formas en MAYÚSCULA.
  has(gradeTurn({ raw: 'Te contacto pronto [nota: escalar]', userMessage: 'x', expect: {} }), 'tags:leaked'));

console.log('\nESCALAMIENTO — matriz de confusión');

test('9. TP: escala cuando debe', () => {
  const g = gradeTurn({ raw: 'Un asesor te contacta el lunes. [ESCALAR]', userMessage: 'mi hijo tiene autismo', expect: { tags_required: ['ESCALAR'], clinical: true } });
  assert.strictEqual(g.escalation.outcome, 'TP');
  assert.strictEqual(g.pass.escalation, true);
});

test('10. FN: NO escala cuando debe (falla clínica)', () => {
  const g = gradeTurn({ raw: 'Claro, seguimos. ¿Qué edad tiene?', userMessage: 'mi hijo tiene autismo', expect: { tags_required: ['ESCALAR'], clinical: true } });
  assert.strictEqual(g.escalation.outcome, 'FN');
  has(g, 'escalation:missed');
  assert.strictEqual(g.failures.find(f => f.kind === 'missed').clinical, true);
});

test('11. FP: escala cuando NO debe (condición crónica, regla del 2026-08-04)', () => {
  const g = gradeTurn({ raw: 'Un asesor te contacta el lunes. [ESCALAR]', userMessage: 'tiene ansiedad cronica hace años', expect: { tags_forbidden: ['ESCALAR'] } });
  assert.strictEqual(g.escalation.outcome, 'FP');
  has(g, 'escalation:spurious');
});

test('12. TN: no escala y era correcto no escalar', () => {
  const g = gradeTurn({ raw: '¿Qué edad tiene?', userMessage: 'tiene TDAH', expect: { tags_forbidden: ['ESCALAR'] } });
  assert.strictEqual(g.escalation.outcome, 'TN');
});

test('13. REGLA DE DENOMINADOR: turno sin decisión de escalamiento queda EXCLUIDO', () => {
  const g = gradeTurn({ raw: 'Hola, ¿en qué ciudad estás?', userMessage: 'hola', expect: {} });
  assert.strictEqual(g.escalation.isDecisionPoint, false);
  assert.strictEqual(g.pass.escalation, undefined, 'no debe contar como aprobado ni como denominador');
});

console.log('\nHIGIENE DEL ESCALAMIENTO (métrica separada)');

test('14. detecta pregunta en el mismo turno que escala', () =>
  has(gradeTurn({ raw: 'Te contactamos el lunes. ¿Me confirmás tu ciudad? [ESCALAR]', userMessage: 'quiero hablar con alguien', expect: { tags_required: ['ESCALAR'] } }), 'escalation_hygiene:question_in_escalation_turn'));

test('15. detecta falta de la ventana de PRÓXIMO CONTACTO', () =>
  has(gradeTurn({ raw: 'Te contactamos pronto. [ESCALAR]', userMessage: 'x', expect: { tags_required: ['ESCALAR'] } }), 'escalation_hygiene:no_contact_window'));

test('16. la higiene NO contamina la matriz de confusión', () => {
  const g = gradeTurn({ raw: 'Te contactamos pronto. [ESCALAR]', userMessage: 'x', expect: { tags_required: ['ESCALAR'] } });
  assert.strictEqual(g.escalation.outcome, 'TP', 'decidió bien aunque lo redactó mal');
  assert.strictEqual(g.pass.escalation, true);
  assert.strictEqual(g.pass.escalation_hygiene, false);
});

console.log('\nFIDELIDAD AL FLUJO');

test('17. detecta convenio proactivo', () =>
  has(gradeTurn({ raw: '¿Tienes convenio con COMFAMA?', userMessage: 'cuanto cuesta', expect: {} }), 'flow:forbidden_content'));

test('18. NO marca convenio si el cliente lo mencionó primero', () =>
  lacks(gradeTurn({ raw: 'Sí, con COMFAMA hay 10% de descuento.', userMessage: 'tienen convenio con comfama?', expect: {} }), 'flow:forbidden_content'));

test('19. detecta pregunta repetida entre turnos', () =>
  has(gradeTurn({ raw: '¿En qué ciudad se encuentran ustedes?', userMessage: 'hola', expect: {}, priorQuestions: ['en que ciudad se encuentran ustedes'] }), 'flow:repeated_question'));

test('20. NO marca preguntas distintas como repetidas', () =>
  lacks(gradeTurn({ raw: '¿Qué edad tiene el niño?', userMessage: 'hola', expect: {}, priorQuestions: ['en que ciudad se encuentran ustedes'] }), 'flow:repeated_question'));

test('21. detecta mezcla de tuteo y voseo', () =>
  has(gradeTurn({ raw: 'Si aceptas el horario, podés confirmarme.', userMessage: 'ok', expect: {} }), 'flow:mixed_register'));

test('22. NO marca registro consistente', () =>
  lacks(gradeTurn({ raw: 'Si aceptás el horario, podés confirmarme.', userMessage: 'ok', expect: {} }), 'flow:mixed_register'));

test('23. detecta asteriscos (sobre el texto crudo, antes del strip de producción)', () =>
  has(gradeTurn({ raw: 'El valor es *$395.000*', userMessage: 'precio?', expect: {} }), 'flow:forbidden_content'));

test('24. detecta que admite ser IA', () =>
  has(gradeTurn({ raw: 'Soy una IA que te ayuda.', userMessage: 'sos un bot?', expect: {} }), 'flow:forbidden_content'));

test('25. detecta más de 2 párrafos', () =>
  // Se cuenta sobre el raw: limpiarTags colapsa las líneas en blanco y el check
  // nunca dispararía sobre patientText.
  has(gradeTurn({ raw: 'Uno.\n\nDos.\n\nTres.', userMessage: 'x', expect: {} }), 'flow:too_many_paragraphs'));

test('26. NO marca dos párrafos', () =>
  lacks(gradeTurn({ raw: 'Uno.\n\nDos.', userMessage: 'x', expect: {} }), 'flow:too_many_paragraphs'));

console.log('\nMÁQUINA DE ESTADOS (verificada contra webhooks/ghl.js:141-420)');

test('27. nuevo + NOMBRE_PADRE -> triaje_p1  (ghl.js:148)', () =>
  assert.strictEqual(transition('nuevo', ['NOMBRE_PADRE']), 'triaje_p1'));

test('28. REGRESIÓN: CIUDAD_VALIDA NO cambia el estado  (ghl.js:160-163)', () => {
  // La versión anterior avanzaba nuevo -> triaje_p1 acá, salteándose los pasos de
  // edad y dificultad del prompt.
  assert.strictEqual(transition('nuevo', ['CIUDAD_VALIDA']), 'nuevo');
  assert.strictEqual(transition('triaje_p1', ['CIUDAD_VALIDA']), 'triaje_p1');
});

test('29. TRIAJE_P1 -> triaje_p2  (ghl.js:172)', () =>
  assert.strictEqual(transition('triaje_p1', ['TRIAJE_P1']), 'triaje_p2'));

test('30. TRIAJE_P2 -> triaje_p3  (ghl.js:181)', () =>
  assert.strictEqual(transition('triaje_p2', ['TRIAJE_P2']), 'triaje_p3'));

test('31. REGRESIÓN: TRIAJE_P3 solo NO avanza  (ghl.js:182)', () => {
  // Solo TRIAJE_COMPLETO avanza. Un modelo que emite P3 sin COMPLETO se traba en
  // triaje_p3 — es una falla real que la eval tiene que reproducir, no tapar.
  assert.strictEqual(transition('triaje_p3', ['TRIAJE_P3']), 'triaje_p3');
  assert.strictEqual(transition('triaje_p3', ['TRIAJE_P3', 'TRIAJE_COMPLETO']), 'triaje_completo');
});

test('32. CITA_CONFIRMADA -> esperando_pago  (ghl.js:257)', () =>
  assert.strictEqual(transition('agendando', ['CITA_CONFIRMADA']), 'esperando_pago'));

test('33. los tres cierres -> cerrado  (ghl.js:326/340/354)', () => {
  for (const t of ['CIUDAD_NO_DISPONIBLE', 'SIN_PRESUPUESTO', 'FUERA_SEGMENTO']) {
    assert.strictEqual(transition('triaje_p1', [t]), 'cerrado', t);
  }
});

test('34. REGRESIÓN: NHC_ADULTOS -> triaje_p1, NO escalado  (ghl.js:370)', () => {
  assert.strictEqual(transition('triaje_p1', ['NHC_ADULTOS']), 'triaje_p1');
  assert.strictEqual(transition('nuevo', ['NHC_ADULTOS']), 'triaje_p1');
});

test('35. ESCALAR -> escalado  (ghl.js:387)', () =>
  assert.strictEqual(transition('triaje_p2', ['ESCALAR']), 'escalado'));

test('36. REGRESIÓN: precedencia — los cierres ganan sobre ESCALAR', () => {
  // En el webhook la rama de CIUDAD_NO_DISPONIBLE (322) retorna antes que la de
  // ESCALAR (381). La versión anterior ponía ESCALAR primero y daba 'escalado'.
  assert.strictEqual(transition('triaje_p1', ['CIUDAD_NO_DISPONIBLE', 'ESCALAR']), 'cerrado');
  assert.strictEqual(transition('triaje_p1', ['NHC_ADULTOS', 'ESCALAR']), 'triaje_p1');
});

test('37. precedencia: CITA_CONFIRMADA gana sobre todo lo demás', () =>
  assert.strictEqual(transition('agendando', ['CITA_CONFIRMADA', 'ESCALAR', 'SIN_PRESUPUESTO']), 'esperando_pago'));

test('38. REGRESIÓN: POSPONER NO cambia el estado  (ghl.js:404)', () => {
  // Escribe recovery_status='pospuesto' en otra columna. No existe un estado
  // 'pospuesto' en este flujo — la versión anterior lo inventaba.
  assert.strictEqual(transition('triaje_p2', ['POSPONER']), 'triaje_p2');
  assert.strictEqual(transition('triaje_p2', ['TRIAJE_P2', 'POSPONER']), 'triaje_p3');
});

test('39. el acumulador corre antes que las ramas de retorno temprano', () =>
  assert.strictEqual(transition('triaje_p1', ['TRIAJE_P1', 'ESCALAR']), 'escalado'));

test('40. sin tags el estado no avanza', () =>
  assert.strictEqual(transition('triaje_p2', []), 'triaje_p2'));

console.log('\nCORTE DEL REPLAY');

test('41. POSPONER corta el replay aunque el estado no cambie', () =>
  assert.strictEqual(stopsReplay('triaje_p2', ['POSPONER']), true));

test('42. REGRESIÓN: NHC_ADULTOS NO corta — la conversación sigue como Luisa', () =>
  assert.strictEqual(stopsReplay('triaje_p1', ['NHC_ADULTOS']), false));

test('43. escalado / cerrado / esperando_pago cortan el replay', () => {
  for (const e of ['escalado', 'cerrado', 'esperando_pago']) {
    assert.strictEqual(stopsReplay(e, []), true, e);
  }
  assert.strictEqual(stopsReplay('triaje_p2', []), false);
});

console.log('\nEFECTOS Y CONTEXTO POR COMBINACIÓN (state-spec)');

const T = (name, payload = null) => ({ name, payload });
const tipos = d => d.effects.map(e => e.type);

test('44. el acumulador aplica TODAS las reglas que matchean, no solo la última', () => {
  const r = resolveStateTransition('triaje_p1', [T('TRIAJE_P1', 'A'), T('TRIAJE_P2', 'B')]);
  assert.strictEqual(r.nextState, 'triaje_p3', 'gana el último estado');
  assert.deepStrictEqual(r.ctxUpdates, { triaje: { p1: 'A', p2: 'B' } }, 'los dos payloads se escriben');
  assert.deepStrictEqual(r.accumulatorRules, ['TRIAJE_P1', 'TRIAJE_P2']);
});

test('45. la rama sobrescribe el estado pero NO borra los efectos del acumulador', () => {
  const r = resolveStateTransition('triaje_p1', [T('TRIAJE_P1', 'A'), T('ESCALAR')]);
  assert.strictEqual(r.nextState, 'escalado');
  assert.strictEqual(r.matchedRule, 'ESCALAR');
  assert.deepStrictEqual(r.ctxUpdates, { triaje: { p1: 'A' } }, 'el triaje se guardó igual');
  assert.ok(tipos(r).includes(EFFECT.SAVE_SYMPTOM));
  assert.ok(tipos(r).includes(EFFECT.TRIGGER_ANALYSIS));
});

test('46. CITA_CONFIRMADA arrastra el efecto de cobro, marcado como financiero', () => {
  const r = resolveStateTransition('agendando', [T('CITA_CONFIRMADA')]);
  const cobro = r.effects.find(e => e.type === EFFECT.CREATE_WOMPI_PAYMENT);
  assert.ok(cobro, 'un FP acá genera un link de pago Wompi, no solo un estado equivocado');
  assert.strictEqual(cobro.amount, 100000);
  assert.ok(FINANCIAL_EFFECTS.has(cobro.type));
});

test('47. NHC_ADULTOS deja el contexto derivado y NO corta', () => {
  const r = resolveStateTransition('triaje_p1', [T('NHC_ADULTOS'), T('ESCALAR')]);
  assert.strictEqual(r.nextState, 'triaje_p1');
  assert.strictEqual(r.continueConversation, true);
  assert.strictEqual(r.matchedRule, 'NHC_ADULTOS');
  assert.deepStrictEqual(r.ctxUpdates, { derivadoA: 'luisa' });
});

test('48. POSPONER conserva lo acumulado y corta igual', () => {
  const r = resolveStateTransition('triaje_p2', [T('TRIAJE_P2', 'B'), T('POSPONER')]);
  assert.strictEqual(r.nextState, 'triaje_p3');
  assert.strictEqual(r.continueConversation, false);
  assert.ok(tipos(r).includes(EFFECT.SET_RECOVERY_STATUS));
});

console.log(`\n${n - failed}/${n} OK`);
process.exit(failed ? 1 : 0);
