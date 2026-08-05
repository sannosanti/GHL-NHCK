'use strict';

/**
 * Tests for the pure extractor logic. Synthetic fixtures only — no database, no
 * credentials, no network.
 *
 *   node eval/extract.test.js
 *
 * The SQL and the JOIN are verified later, as an integration step against the
 * read-only role. Everything else is provable now.
 */

const assert = require('assert');
const {
  scrub, STRATA, assignStratum, pendingPaymentFrom, buildTurns, stratumWhere, matchesStratumExclusive,
  SOURCES, extractWithFallback, classifySourceError, sourceMetadata,
  normalizeFrequencies, buildDataset, validateGold, suggestExpectations, sanitizarError,
} = require('./extract-lib');

let n = 0, failed = 0;
const pendientes = [];
function test(name, fn) {
  n++;
  try {
    const r = fn();
    // Los tests de fuentes son asíncronos; se encolan y se esperan al final.
    if (r && typeof r.then === 'function') {
      pendientes.push(r.then(
        () => console.log(`  ok   ${name}`),
        err => { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }));
      return;
    }
    console.log(`  ok   ${name}`);
  } catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

/** Synthetic row. `texto` becomes one user message unless `messages` is given. */
const fila = (o = {}) => ({
  conversation_id: o.conversation_id ?? `conv-${Math.random().toString(36).slice(2, 8)}`,
  contact_id: o.contact_id ?? 'contact-xyz',
  estado: o.estado ?? 'triaje_p1',
  recovery_status: o.recovery_status ?? null,
  triaje: o.triaje ?? {},
  messages: o.messages ?? [
    { role: 'user', content: o.texto ?? 'hola' },
    { role: 'assistant', content: 'respuesta' },
    { role: 'user', content: 'gracias' },
  ],
  ...(o.has_pending !== undefined ? { has_pending: o.has_pending } : {}),
});

console.log('\nESTRATOS — asignación y solapamiento');

test('1. cada estrato define predicado SQL Y su equivalente en JS', () => {
  for (const s of STRATA) {
    assert.ok(typeof s.where === 'string' && s.where.length, `${s.id} sin SQL`);
    assert.ok(typeof s.match === 'function', `${s.id} sin predicado JS`);
    assert.ok(Number.isInteger(s.quota) && s.quota > 0, `${s.id} sin cuota`);
  }
});

test('2. una conversación que cumple clínico Y precio queda en clínico', () => {
  const r = fila({ texto: 'mi hijo tiene autismo y el presupuesto es un problema' });
  assert.strictEqual(assignStratum(r).id, 'escalado_clinico', 'la prioridad documentada es clínico primero');
});

test('3. TDAH + precio queda en no_escalar_clinico, no en precio', () => {
  assert.strictEqual(assignStratum(fila({ texto: 'tiene tdah, pero está muy caro' })).id, 'no_escalar_clinico');
});

test('4. TDAH junto con autismo NO cae en no_escalar_clinico', () => {
  // La exclusión importa: es un caso clínico que sí debe escalar.
  assert.strictEqual(assignStratum(fila({ texto: 'tiene tdah y autismo' })).id, 'escalado_clinico');
});

test('5. escalado sin mención clínica cae en escalado_otro', () => {
  assert.strictEqual(assignStratum(fila({ estado: 'escalado', texto: 'quiero hablar con alguien' })).id, 'escalado_otro');
});

test('6. una conversación que no cumple ningún estrato devuelve null', () => {
  assert.strictEqual(assignStratum(fila({ estado: 'nuevo', texto: 'buenas' })), null);
});

test('7. happy_path exige 6 mensajes o más', () => {
  const corta = fila({ estado: 'triaje_p2', texto: 'hola' });
  assert.strictEqual(assignStratum(corta), null, 'con 3 mensajes no califica');
  const larga = fila({ estado: 'triaje_p2', messages: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })) });
  assert.strictEqual(assignStratum(larga).id, 'happy_path');
});

console.log('\nSQL GENERADO — exclusión de estratos anteriores');

test('8a. el primer estrato no excluye a nadie', () => {
  const w = stratumWhere(STRATA, 0);
  assert.ok(w.includes(STRATA[0].where), 'debe incluir su propio predicado');
  assert.ok(!/AND NOT/.test(w), `no debería tener exclusión: ${w}`);
});

test('8b. cada estrato excluye a TODOS los anteriores', () => {
  for (let i = 1; i < STRATA.length; i++) {
    const w = stratumWhere(STRATA, i);
    for (let j = 0; j < i; j++) {
      assert.ok(w.includes(STRATA[j].where),
        `estrato ${STRATA[i].id} no excluye a ${STRATA[j].id}`);
    }
  }
});

test('8c. ningún estrato se excluye a sí mismo', () => {
  for (let i = 0; i < STRATA.length; i++) {
    const w = stratumWhere(STRATA, i);
    const notPart = w.includes('AND NOT') ? w.slice(w.indexOf('AND NOT')) : '';
    assert.ok(!notPart.includes(STRATA[i].where),
      `${STRATA[i].id} aparece en su propia cláusula NOT: se anularía a sí mismo`);
  }
});

test('8d. ningún estrato excluye a los POSTERIORES', () => {
  // Excluir hacia adelante rompería la prioridad: un estrato de baja prioridad
  // dejaría sin filas a uno de alta.
  for (let i = 0; i < STRATA.length; i++) {
    const w = stratumWhere(STRATA, i);
    for (let j = i + 1; j < STRATA.length; j++) {
      assert.ok(!w.includes(STRATA[j].where),
        `${STRATA[i].id} excluye a ${STRATA[j].id}, que va después`);
    }
  }
});

test('8e. el constructor es determinista y depende solo del índice', () => {
  for (let i = 0; i < STRATA.length; i++) {
    assert.strictEqual(stratumWhere(STRATA, i), stratumWhere(STRATA, i));
  }
});

test('8e-bis. ALARMA ARQUITECTÓNICA: dos usos de stratumWhere en el extractor', () => {
  // Esto NO garantiza que no exista otra copia de la exclusión: alguien puede
  // escribirla a mano con otro texto, construirla dinámicamente, o ponerla en otro
  // archivo. Es una alarma barata para el caso más probable —que alguien vuelva a
  // duplicar la regla en fetchRows o fetchFrequencies— y nada más.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'extract-dataset.js'), 'utf8');
  const usos = (src.match(/stratumWhere\(strata, i\)/g) || []).length;
  assert.strictEqual(usos, 2,
    `se esperaba stratumWhere en fetchRows y en fetchFrequencies, hay ${usos}. ` +
    `Si el cambio es intencional, actualizá este número — pero revisá primero que ` +
    `la exclusión no quedó escrita a mano en algún lado.`);
});

test('8f. el predicado exclusivo en JS equivale a "primera coincidencia gana"', () => {
  const filas = [
    fila({ texto: 'autismo y muy caro' }),
    fila({ texto: 'tdah y no tengo dinero' }),
    fila({ texto: 'esta muy caro' }),
    fila({ estado: 'escalado', texto: 'quiero una llamada' }),
    fila({ estado: 'nuevo', texto: 'buenas' }),
  ];
  for (const f of filas) {
    const asignado = assignStratum(f);
    for (let i = 0; i < STRATA.length; i++) {
      const exclusivo = matchesStratumExclusive(f, STRATA, i);
      assert.strictEqual(exclusivo, asignado?.id === STRATA[i].id,
        `desacuerdo en ${STRATA[i].id} para "${f.messages[0].content}"`);
    }
  }
});

test('8g. REGRESIÓN: con 15 casos válidos y cuota 20, recupera 15, no 0', () => {
  // El bug: la consulta de `precio` traía las 20 más recientes SIN excluir clínico,
  // assignStratum las reasignaba, y el estrato terminaba vacío.
  const iPrecio = STRATA.findIndex(s => s.id === 'precio');
  const pobl = [];
  for (let i = 0; i < 40; i++) {
    pobl.push(fila({
      conversation_id: `p${i}`,
      // Las 25 primeras (más recientes) también son clínicas.
      texto: i < 25 ? 'mi hijo tiene autismo y esta muy caro' : 'esta muy caro',
    }));
  }
  const realesDePrecio = pobl.filter(r => assignStratum(r)?.id === 'precio').length;
  assert.strictEqual(realesDePrecio, 15, 'la población tiene 15 de precio real');

  // Con exclusión: la consulta ya no devuelve las clínicas.
  const conExclusion = pobl
    .filter(r => matchesStratumExclusive(r, STRATA, iPrecio))
    .slice(0, STRATA[iPrecio].quota);
  assert.strictEqual(conExclusion.length, 15, 'debe recuperar las 15');

  // Y buildDataset las conserva todas en `precio`.
  const { conversations } = buildDataset(conExclusion);
  assert.strictEqual(conversations.filter(c => c.stratum === 'precio').length, 15);
});

console.log('\nFUENTES — degradación acotada, sin volver a la tabla base');

const V_PRINCIPAL = 'eval_ro.conversation_sample';
const V_FALLBACK = 'eval_ro.conversation_sample_basic';

/** Error de PostgreSQL con SQLSTATE, como los que devuelve `pg`. */
const pgError = (code, message) => Object.assign(new Error(message), { code });

/** Cliente falso: registra los savepoints y no toca ninguna base. */
function clienteFalso() {
  const sql = [];
  return {
    sql,
    async query(text) { sql.push(String(text).trim().split('\n')[0]); return { rows: [] }; },
    savepoints: () => sql.filter(s => /^(SAVEPOINT|RELEASE|ROLLBACK TO)/.test(s)),
  };
}

/**
 * Extractor falso: define qué pasa con cada fuente, en una sola fase.
 * `fasesFalsas` cubre los casos donde importa EN QUÉ fase falló.
 */
const unaFase = fn => [{ nombre: 'extraccion', fn }];

const extractorFalso = plan => unaFase(async src => {
  const p = plan[src.name];
  if (typeof p === 'function') return p();
  if (p instanceof Error) throw p;
  if (p === undefined) throw pgError('42P01', `relation "${src.name}" does not exist`);
  return p;
});

/** Dos fases nombradas como las reales, para verificar el registro de `fase`. */
const fasesFalsas = plan => ['rows', 'frequencies'].map(nombre => ({
  nombre,
  fn: async src => {
    const p = (plan[src.name] || {})[nombre];
    if (p instanceof Error) throw p;
    return { [nombre]: p ?? [] };
  },
}));

test('8h. vista principal completa → se usa y el dato financiero está', async () => {
  const c = clienteFalso();
  const r = await extractWithFallback(c, extractorFalso({
    [V_PRINCIPAL]: { rows: [1, 2, 3] },
  }));
  const m = sourceMetadata(r);
  assert.strictEqual(m.fuente, V_PRINCIPAL);
  assert.strictEqual(m.pending_payment_disponible, true);
  assert.deepStrictEqual(m.fuentes_descartadas, []);
  assert.deepStrictEqual(r.datos, { rows: [1, 2, 3] });
  assert.deepStrictEqual(c.savepoints(), ['SAVEPOINT eval_src_0', 'RELEASE SAVEPOINT eval_src_0']);
});

test('8i. principal ausente y básica disponible → fallback, con el savepoint revertido', async () => {
  const c = clienteFalso();
  const r = await extractWithFallback(c, extractorFalso({
    [V_FALLBACK]: { rows: [1] },
  }));
  const m = sourceMetadata(r);
  assert.strictEqual(m.fuente, V_FALLBACK);
  assert.strictEqual(m.pending_payment_disponible, false);
  assert.strictEqual(m.fuentes_descartadas[0].clase, 'unavailable');
  assert.deepStrictEqual(c.savepoints(), [
    'SAVEPOINT eval_src_0', 'ROLLBACK TO SAVEPOINT eval_src_0',
    'SAVEPOINT eval_src_1', 'RELEASE SAVEPOINT eval_src_1',
  ]);
});

test('8j. principal con PERMISO DENEGADO → sí hace fallback', async () => {
  const r = await extractWithFallback(clienteFalso(), extractorFalso({
    [V_PRINCIPAL]: pgError('42501', 'permission denied for view conversation_sample'),
    [V_FALLBACK]: { rows: [] },
  }));
  assert.strictEqual(r.source.name, V_FALLBACK);
  assert.strictEqual(r.intentos[0].clase, 'permission');
});

test('8k. principal con TIMEOUT o SQL inválido → NO hace fallback', async () => {
  for (const [code, desc] of [
    ['57014', 'statement timeout'],
    ['42601', 'syntax error'],
    ['42703', 'column does not exist (esquema incompatible)'],
    ['08006', 'connection failure'],
    [undefined, 'error de transporte sin SQLSTATE'],
  ]) {
    await assert.rejects(
      () => extractWithFallback(clienteFalso(), extractorFalso({
        [V_PRINCIPAL]: pgError(code, desc),
        [V_FALLBACK]: { rows: [] },   // disponible, y aun así NO debe usarse
      })),
      err => {
        assert.strictEqual(err.name, 'EnvironmentError', `${desc} debería abortar`);
        assert.match(err.message, /NO habilita degradación/);
        return true;
      }, desc);
  }
});

test('8l. el fallback es una VISTA de eval_ro, nunca public.conversations', () => {
  for (const s of SOURCES) {
    assert.ok(s.name.startsWith('eval_ro.'), `${s.name} está fuera del esquema eval_ro`);
    assert.ok(!/public\./.test(s.name), `${s.name} apunta a public`);
  }
});

test('8m. ambas vistas ausentes → EnvironmentError, NO un dataset degradado', async () => {
  await assert.rejects(
    () => extractWithFallback(clienteFalso(), extractorFalso({})),
    err => {
      assert.strictEqual(err.name, 'EnvironmentError');
      assert.strictEqual(err.kind, 'environment');
      assert.strictEqual(err.intentos.length, 2, 'debe reportar los dos intentos');
      return true;
    });
});

test('8n. la principal responde al inicio pero falla DURANTE la extracción', async () => {
  // El caso que un sondeo previo no atrapa: la vista existe y contesta, y la
  // consulta real se cae después de traer parte.
  let filasTraidas = 0;
  const r = await extractWithFallback(clienteFalso(), extractorFalso({
    [V_PRINCIPAL]: () => { filasTraidas = 40; throw pgError('42501', 'permission denied for table pending_payments'); },
    [V_FALLBACK]: { rows: ['completo'] },
  }));
  assert.ok(filasTraidas > 0, 'la extracción había empezado');
  assert.strictEqual(r.source.name, V_FALLBACK);
  assert.deepStrictEqual(r.datos, { rows: ['completo'] }, 'nada de lo parcial sobrevive');
});

test('8o. un fallo tras iniciar la extracción NO genera dataset parcial', async () => {
  // Ni siquiera cuando el fallback también falla: no hay valor de retorno que
  // contenga lo acumulado.
  await assert.rejects(
    () => extractWithFallback(clienteFalso(), extractorFalso({
      [V_PRINCIPAL]: () => { throw pgError('42P01', 'no existe'); },
      [V_FALLBACK]: () => { throw pgError('42P01', 'tampoco'); },
    })),
    err => {
      assert.strictEqual(err.name, 'EnvironmentError');
      assert.strictEqual(err.datos, undefined, 'el error no transporta datos parciales');
      return true;
    });
});

test('8p. el metadato financiero es consistente con la fuente realmente usada', async () => {
  for (const [plan, fuenteEsperada, disponibleEsperado] of [
    [{ [V_PRINCIPAL]: { rows: [] }, [V_FALLBACK]: { rows: [] } }, V_PRINCIPAL, true],
    [{ [V_FALLBACK]: { rows: [] } }, V_FALLBACK, false],
    [{ [V_PRINCIPAL]: { rows: [] } }, V_PRINCIPAL, true],
  ]) {
    const m = sourceMetadata(await extractWithFallback(clienteFalso(), extractorFalso(plan)));
    assert.strictEqual(m.fuente, fuenteEsperada);
    assert.strictEqual(m.pending_payment_disponible, disponibleEsperado);
    assert.strictEqual(m.pending_payment_disponible,
      SOURCES.find(s => s.name === m.fuente).hasPending);
  }
});

test('8q. PARIDAD: cambiar de fuente no altera estratos ni casos clínicos', async () => {
  // Las dos vistas comparten la definición base, así que la población y las columnas
  // comunes son idénticas. Lo único que cambia es `has_pending`.
  const comunes = [
    { estado: 'triaje_p1', recovery_status: null, triaje: {},
      messages: [{ role: 'user', content: 'mi hijo tiene autismo' }, { role: 'assistant', content: 'r' }, { role: 'user', content: 'ok' }] },
    { estado: 'triaje_p1', recovery_status: null, triaje: {},
      messages: [{ role: 'user', content: 'esta muy caro' }, { role: 'assistant', content: 'r' }, { role: 'user', content: 'ok' }] },
    { estado: 'escalado', recovery_status: null, triaje: {},
      messages: [{ role: 'user', content: 'quiero una llamada' }, { role: 'assistant', content: 'r' }, { role: 'user', content: 'ok' }] },
  ];
  const conId = (f, i) => ({ ...f, conversation_id: `k${i}` });
  const conPending = comunes.map((f, i) => ({ ...conId(f, i), has_pending: i === 0 ? true : null }));
  const sinPending = comunes.map(conId);

  const A = buildDataset(conPending, { suggest: suggestExpectations });
  const B = buildDataset(sinPending, { suggest: suggestExpectations });

  assert.deepStrictEqual(A.conversations.map(c => c.stratum), B.conversations.map(c => c.stratum),
    'los estratos no cambian');
  assert.deepStrictEqual(
    A.conversations.map(c => JSON.stringify(c.turns)),
    B.conversations.map(c => JSON.stringify(c.turns)),
    'los turnos y las expectativas clínicas no cambian');
  // Lo único que difiere:
  assert.deepStrictEqual(A.conversations.map(c => c.pending_payment), [true, false, false]);
  assert.deepStrictEqual(B.conversations.map(c => c.pending_payment), [undefined, undefined, undefined]);
});

console.log('\nDECISIÓN DE FALLBACK: FUENTE + FASE, NO SOLO SQLSTATE');

test('9a. 42501 en la vista PRINCIPAL → degrada a la básica', async () => {
  const r = await extractWithFallback(clienteFalso(), extractorFalso({
    [V_PRINCIPAL]: pgError('42501', 'permission denied for view conversation_sample'),
    [V_FALLBACK]: { rows: ['ok'] },
  }));
  assert.strictEqual(r.source.name, V_FALLBACK);
  const i = r.intentos[0];
  assert.strictEqual(i.fallback_permitido, true);
  assert.strictEqual(i.objeto, 'conversation_sample');
  assert.match(i.motivo, /respaldo/);
});

test('9b. 42501 en la vista BÁSICA → error de entorno, no hay a qué degradar', async () => {
  // El MISMO SQLSTATE que 9a. Lo que cambia es la fuente: abajo no hay nada.
  await assert.rejects(
    () => extractWithFallback(clienteFalso(), extractorFalso({
      [V_PRINCIPAL]: pgError('42P01', `relation "${V_PRINCIPAL}" does not exist`),
      [V_FALLBACK]: pgError('42501', 'permission denied for view conversation_sample_basic'),
    })),
    err => {
      assert.strictEqual(err.name, 'EnvironmentError');
      assert.strictEqual(err.intentos.length, 2);
      const ultimo = err.intentos[1];
      assert.strictEqual(ultimo.fuente, V_FALLBACK);
      assert.strictEqual(ultimo.clase, 'permission', 'la clase sigue siendo degradable…');
      assert.strictEqual(ultimo.fallback_permitido, false, '…pero la POSICIÓN lo impide');
      assert.match(ultimo.motivo, /no hay una fuente por debajo/);
      return true;
    });
});

test('9c. 42P01 en la vista PRINCIPAL → degrada a la básica', async () => {
  const r = await extractWithFallback(clienteFalso(), extractorFalso({
    [V_FALLBACK]: { rows: ['ok'] },
  }));
  assert.strictEqual(r.source.name, V_FALLBACK);
  assert.strictEqual(r.intentos[0].clase, 'unavailable');
  assert.strictEqual(r.intentos[0].fallback_permitido, true);
});

test('9d. objeto COMPARTIDO ausente → error de entorno aunque el SQLSTATE degrade', async () => {
  // Éste es el punto entero: 42P01 y 42501 son degradables como CLASE, pero si el
  // que falta es `conversation_base` o `public.conversations`, las dos vistas están
  // rotas y cambiar de fuente no arregla nada.
  for (const [code, msg, objeto] of [
    ['42P01', 'relation "eval_ro.conversation_base" does not exist', 'eval_ro.conversation_base'],
    ['42501', 'permission denied for table conversations', 'conversations'],
    ['3F000', 'schema "eval_ro" does not exist', 'eval_ro'],
  ]) {
    await assert.rejects(
      () => extractWithFallback(clienteFalso(), extractorFalso({
        [V_PRINCIPAL]: pgError(code, msg),
        [V_FALLBACK]: { rows: ['disponible, y aun así no debe usarse'] },
      })),
      err => {
        assert.strictEqual(err.name, 'EnvironmentError', msg);
        assert.strictEqual(err.intentos[0].objeto, objeto);
        assert.strictEqual(err.intentos[0].fallback_permitido, false);
        assert.match(err.intentos[0].motivo, /compartido/);
        return true;
      }, msg);
  }
});

test('9e. TIMEOUT en la principal → aborta, y NO se lee como degradación financiera', async () => {
  await assert.rejects(
    () => extractWithFallback(clienteFalso(), extractorFalso({
      [V_PRINCIPAL]: pgError('57014', 'canceling statement due to statement timeout'),
      [V_FALLBACK]: { rows: ['ok'] },
    })),
    err => {
      assert.strictEqual(err.name, 'EnvironmentError');
      assert.strictEqual(err.intentos[0].clase, 'environment');
      assert.strictEqual(err.intentos[0].fallback_permitido, false);
      // Lo importante: no existe un dataset con pending_payment_disponible:false.
      assert.strictEqual(err.datos, undefined);
      return true;
    });
});

test('9f. cada fallo registra fuente, SQLSTATE, fase, permiso y motivo', async () => {
  const c = clienteFalso();
  const r = await extractWithFallback(c, fasesFalsas({
    [V_PRINCIPAL]: { frequencies: pgError('42501', 'permission denied for table pending_payments') },
    [V_FALLBACK]: { rows: ['a'], frequencies: { total: 1 } },
  }));
  const i = r.intentos[0];
  assert.deepStrictEqual(Object.keys(i).sort(), [
    'clase', 'code', 'error', 'fallback_permitido', 'fase', 'fuente', 'motivo',
    'name', 'objeto', 'objetos', 'origen_objeto', 'sqlstate', 'tenia_cause',
  ]);
  assert.strictEqual(i.fuente, V_PRINCIPAL);
  assert.strictEqual(i.sqlstate, '42501');
  assert.strictEqual(i.fase, 'frequencies', 'no reventó trayendo filas, sino contando');
  assert.strictEqual(i.fallback_permitido, true);
  assert.strictEqual(i.objeto, 'pending_payments');
  // Y la fuente que sí completó devuelve las DOS fases fusionadas.
  assert.deepStrictEqual(r.datos, { rows: ['a'], frequencies: { total: 1 } });
});

test('9g. el rollback vuelve al savepoint correcto y no hay BEGIN/COMMIT propio', async () => {
  const c = clienteFalso();
  await extractWithFallback(c, extractorFalso({ [V_FALLBACK]: { rows: [] } }));
  assert.deepStrictEqual(c.savepoints(), [
    'SAVEPOINT eval_src_0', 'ROLLBACK TO SAVEPOINT eval_src_0',
    'SAVEPOINT eval_src_1', 'RELEASE SAVEPOINT eval_src_1',
  ]);
  // La transacción la abre quien llama. Si extractWithFallback abriera o cerrara
  // una, el snapshot REPEATABLE READ cambiaría entre fuentes y las dos dejarían de
  // ver la misma población.
  for (const s of c.sql) {
    assert.doesNotMatch(s, /^(BEGIN|COMMIT|ROLLBACK$|ROLLBACK;|START TRANSACTION)/i,
      `extractWithFallback no debe emitir '${s}'`);
  }
});

test('9h. la segunda extracción corre sobre el MISMO snapshot', async () => {
  // Un solo BEGIN, hecho afuera: las dos fuentes ven la misma población. Se verifica
  // por lo que la función NO emite y por el orden de savepoints anidados en la misma
  // transacción — un ROLLBACK TO no cierra ni renueva el snapshot.
  const c = clienteFalso();
  await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await extractWithFallback(c, extractorFalso({ [V_FALLBACK]: { rows: [] } }));
  const begins = c.sql.filter(s => /^BEGIN/i.test(s));
  assert.strictEqual(begins.length, 1, 'exactamente una transacción, la de afuera');
  assert.strictEqual(c.sql[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.strictEqual(c.sql[1], 'SAVEPOINT eval_src_0', 'el primer intento va dentro de esa transacción');
});

test('9i. si las dos fuentes fallan no se genera archivo', async () => {
  // La escritura vive DESPUÉS del await en extract-dataset.js. Se verifica de dos
  // formas: que la función lance en vez de devolver, y que en el fuente no haya
  // ninguna escritura antes de que la extracción haya devuelto.
  await assert.rejects(
    () => extractWithFallback(clienteFalso(), extractorFalso({})),
    err => { assert.strictEqual(err.name, 'EnvironmentError'); return true; });

  const src = require('fs').readFileSync(require('path').join(__dirname, 'extract-dataset.js'), 'utf8');
  const iExtraccion = src.indexOf('extractWithFallback(');
  const iEscritura = src.indexOf('writeFileSync');
  assert.ok(iExtraccion > -1 && iEscritura > -1);
  assert.ok(iEscritura > iExtraccion,
    'writeFileSync debe estar después de la extracción, nunca antes ni en paralelo');
  assert.strictEqual((src.match(/writeFileSync|mkdirSync/g) || []).length, 2,
    'una sola escritura en todo el archivo');
});

test('9j. los registros técnicos no llevan datos de pacientes', async () => {
  // PostgreSQL mete VALORES en el mensaje: una violación de unicidad imprime la
  // clave, un error de tipo imprime el literal. Esos valores pueden ser texto de
  // conversaciones, y estos objetos terminan en stdout y en el JSON del dataset.
  const sucio = pgError('42501',
    'permission denied for view conversation_sample: fila de Juan Pérez, ' +
    'tel 3001234567, juan@mail.com, https://ghl.io/x/abc\n' +
    'DETAIL: Key (phone)=(3001234567) already exists.');
  const r = await extractWithFallback(clienteFalso(), extractorFalso({
    [V_PRINCIPAL]: sucio,
    [V_FALLBACK]: { rows: [] },
  }));
  const registro = JSON.stringify(r.intentos[0]);
  for (const pii of ['3001234567', 'juan@mail.com', 'https://ghl.io/x/abc']) {
    assert.ok(!registro.includes(pii), `el registro filtró ${pii}`);
  }
  assert.ok(!registro.includes('DETAIL'), 'solo se conserva la primera línea');
  assert.ok(r.intentos[0].error.length <= 200, 'el mensaje se recorta');
  assert.ok(registro.includes('[TEL]') || registro.includes('[EMAIL]'), 'se ve que hubo redacción');
});

console.log('\nATRIBUCIÓN POSITIVA Y SANITIZACIÓN COMPLETA');

test('10a. sin objeto identificable NO se degrada, aunque el SQLSTATE lo permita', async () => {
  // El default está invertido: no alcanza con que el objeto "no parezca compartido".
  // Un mensaje que el parser no entiende —otro idioma del servidor, otra versión,
  // un pooler que envuelve el error— daba antes objeto=null, esCompartido(null)=false
  // y HABILITABA el fallback. Un fallo de parsing no puede ser un permiso.
  for (const msg of [
    'no existe',                                       // sin palabra clave
    'ОШИБКА: отношение не существует',                 // servidor en otro idioma
    'Error from connection pooler: upstream closed',   // envuelto por un intermediario
  ]) {
    await assert.rejects(
      () => extractWithFallback(clienteFalso(), extractorFalso({
        [V_PRINCIPAL]: pgError('42P01', msg),
        [V_FALLBACK]: { rows: ['disponible, y aun así no debe usarse'] },
      })),
      err => {
        assert.strictEqual(err.name, 'EnvironmentError', msg);
        assert.strictEqual(err.intentos[0].origen_objeto, 'ninguno');
        assert.deepStrictEqual(err.intentos[0].objetos, []);
        assert.match(err.intentos[0].motivo, /ambigüedad aborta/);
        return true;
      }, msg);
  }
});

test('10b. un objeto DESCONOCIDO tampoco degrada: exclusivo o nada', async () => {
  // No está en la lista de compartidos, pero tampoco es de esta fuente. Antes pasaba
  // por el filtro de "no es compartido"; ahora exige atribución positiva.
  await assert.rejects(
    () => extractWithFallback(clienteFalso(), extractorFalso({
      [V_PRINCIPAL]: pgError('42501', 'permission denied for table auditoria_externa'),
      [V_FALLBACK]: { rows: [] },
    })),
    err => {
      assert.strictEqual(err.intentos[0].objetos[0], 'auditoria_externa');
      assert.strictEqual(err.intentos[0].fallback_permitido, false);
      assert.match(err.intentos[0].motivo, /no es un objeto exclusivo/);
      return true;
    });
});

test('10c. si el error nombra VARIOS objetos, todos deben ser exclusivos', async () => {
  // Mezcla: uno propio y uno compartido. "Alguno era exclusivo" no alcanza.
  await assert.rejects(
    () => extractWithFallback(clienteFalso(), extractorFalso({
      [V_PRINCIPAL]: pgError('42P01',
        'relation "conversation_sample" depends on relation "conversation_base" which does not exist'),
      [V_FALLBACK]: { rows: [] },
    })),
    err => {
      assert.ok(err.intentos[0].objetos.includes('conversation_base'));
      assert.strictEqual(err.intentos[0].fallback_permitido, false);
      assert.match(err.intentos[0].motivo, /compartido/);
      return true;
    });
});

test('10d. err.table/err.schema ganan sobre el mensaje y se marcan como estructurados', async () => {
  const estructurado = Object.assign(new Error('mensaje engañoso sobre conversation_sample'),
    { code: '42501', schema: 'public', table: 'conversations' });
  await assert.rejects(
    () => extractWithFallback(clienteFalso(), extractorFalso({
      [V_PRINCIPAL]: estructurado,
      [V_FALLBACK]: { rows: [] },
    })),
    err => {
      // El mensaje decía `conversation_sample` (exclusivo). Los campos del protocolo
      // dicen `public.conversations` (compartido). Manda el campo estructurado.
      assert.strictEqual(err.intentos[0].origen_objeto, 'estructurado');
      assert.deepStrictEqual(err.intentos[0].objetos, ['public.conversations']);
      assert.strictEqual(err.intentos[0].fallback_permitido, false);
      return true;
    });
});

test('10e. sanitizarError limpia mensaje Y stack, y no propaga cause', () => {
  const interno = pgError('23505', 'Key (phone)=(3001234567) already exists.');
  const externo = Object.assign(
    new Error('fallo al leer la conversación de juan@mail.com\nsegunda línea con 3009998888'),
    { code: '42501', cause: interno,
      detail: 'DETAIL: contacto 3001234567', query: "SELECT * FROM c WHERE phone='3001234567'" });

  const limpio = sanitizarError(externo);
  const todo = JSON.stringify(limpio) + limpio.stack;

  for (const pii of ['juan@mail.com', '3009998888', '3001234567']) {
    assert.ok(!todo.includes(pii), `sanitizarError filtró ${pii}`);
  }
  // La segunda línea del mensaje NO puede colarse por el stack: quedarse con
  // stack.split('\n').slice(1) la habría dejado pasar.
  assert.ok(!todo.includes('segunda línea'), 'el stack filtró la segunda línea del mensaje');
  assert.ok(!todo.includes('SELECT'), 'el stack o el JSON filtraron err.query');
  assert.strictEqual(limpio.tenia_cause, true, 'se registra que HABÍA cause…');
  assert.strictEqual(limpio.cause, undefined, '…pero no se propaga su contenido');
  // Los marcos de pila sí se conservan: son ubicaciones de código, no datos.
  assert.ok(/\n\s+at\s/.test(limpio.stack), 'se pierden los marcos de pila');
});

test('10f. el EnvironmentError no transporta nada crudo, ni en message ni en stack ni en JSON', async () => {
  const sucio = Object.assign(
    new Error('permission denied for view conversation_sample_basic: paciente Ana Gómez 3001112222'),
    { code: '42501', detail: 'Key (contact_id)=(cxq-9911)', where: 'PL/pgSQL function f() line 3',
      query: "SELECT * FROM pending_payments WHERE contact_id='cxq-9911'",
      internalQuery: "SELECT 'cxq-9911'", cause: new Error('socket a 3001112222') });

  await assert.rejects(
    () => extractWithFallback(clienteFalso(), extractorFalso({
      [V_PRINCIPAL]: pgError('42P01', `relation "${V_PRINCIPAL}" does not exist`),
      [V_FALLBACK]: sucio,
    })),
    err => {
      const todo = [err.message, err.stack, JSON.stringify(err.intentos)].join('\n');
      for (const pii of ['3001112222', 'cxq-9911', 'SELECT', 'PL/pgSQL']) {
        assert.ok(!todo.includes(pii), `el EnvironmentError filtró ${pii}`);
      }
      assert.strictEqual(err.cause, undefined, 'el error no encadena la causa original');
      assert.strictEqual(err.intentos[1].tenia_cause, true, 'pero deja constancia de que existía');
      return true;
    });
});

test('10g. ningún módulo de eval/ toca un error crudo fuera de sanitizarError()', () => {
  // La sanitización solo sirve si NADIE se saltea el camino, y el camino se saltea
  // con una interpolación de una línea. `console.error(err)` imprime .detail, .query,
  // .internalQuery y la cadena de causas enteros; `${err.message}` dentro de un
  // template que después se imprime hace lo mismo con menos ruido visual.
  //
  // Por eso la regla NO es "no llames a console con un error": es que ningún campo
  // crudo se lea, vaya a donde vaya. Se permite en dos casos, y los dos se justifican
  // en la línea misma:
  //   · la línea llama a sanitizarError() — el camino correcto;
  //   · el valor alimenta un `.test(` de regex — se clasifica, no se emite.
  //
  // EXENTOS los `*.test.js`: sus errores son fallas de assert sobre fixtures
  // sintéticos, no errores de `pg` ni de la API. Nunca ven datos de pacientes, y su
  // mensaje ES el resultado del test. La exención se verifica: ninguno de ellos entra
  // en el grafo de require de run.js ni de extract-dataset.js (ver el test de
  // aislamiento en webhook-parity.test.js).
  const fs = require('fs'), path = require('path');
  const CAMPOS = /\b(err|error|e)\.(message|stack|detail|hint|where|query|internalQuery|cause)\b/;
  const CRUDO = /console\.(log|warn|error)\(\s*(err|error|e)\s*(\)|,)/;
  const ofensores = [];

  const fuentes = fs.readdirSync(__dirname)
    .filter(n => n.endsWith('.js') && !n.endsWith('.test.js'));
  assert.ok(fuentes.length >= 10, 'el escaneo debe cubrir el harness entero');

  for (const f of fuentes) {
    fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').forEach((l, n) => {
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;          // comentarios
      if (l.includes('sanitizarError') || l.includes('.test(')) return;  // los dos casos válidos
      if (CAMPOS.test(l) || CRUDO.test(l)) ofensores.push(`${f}:${n + 1}  ${t}`);
    });
  }
  assert.deepStrictEqual(ofensores, [],
    'estas líneas leen un campo crudo del error sin pasar por sanitizarError():\n' +
    ofensores.join('\n'));
});

test('10h. el escáner de 10g detecta una fuga inyectada', () => {
  // Un escáner que nunca falla no prueba nada. Se verifica contra las dos formas.
  const CAMPOS = /\b(err|error|e)\.(message|stack|detail|hint|where|query|internalQuery|cause)\b/;
  const CRUDO = /console\.(log|warn|error)\(\s*(err|error|e)\s*(\)|,)/;
  const detecta = l => (CAMPOS.test(l) || CRUDO.test(l)) &&
                       !l.includes('sanitizarError') && !l.includes('.test(');

  for (const fuga of [
    'console.error(err);',
    'console.error(err, ctx);',
    'console.log(`falló: ${err.message}`);',
    'reporte.push(`${err.detail}`);',            // no usa console y también filtra
    'const q = err.internalQuery;',
    'logger.warn(e.stack);',
  ]) assert.ok(detecta(fuga), `no detectó la fuga: ${fuga}`);

  for (const ok of [
    'console.error(sanitizarError(err).stack);',
    'const esperado = /permission denied/i.test(err.message);',
    'console.error(err.informe);   // sanitizado por construcción',
  ]) assert.ok(!detecta(ok), `falso positivo: ${ok}`);
});

console.log('\nDEDUPLICACIÓN Y CUOTAS');

test('8. la misma conversación en dos consultas no se duplica', () => {
  const r = fila({ conversation_id: 'dup-1', texto: 'autismo' });
  const { conversations, descartadas } = buildDataset([r, r, r]);
  assert.strictEqual(conversations.length, 1);
  assert.strictEqual(descartadas.duplicadas, 2);
});

test('9. la cuota corta el estrato y lo demás se descarta', () => {
  const strata = [{ id: 'chico', quota: 2, critical: false, where: 'x', match: () => true }];
  const filas = Array.from({ length: 5 }, (_, i) => fila({ conversation_id: `c${i}` }));
  const { conversations, cuotas } = buildDataset(filas, { strata });
  assert.strictEqual(conversations.length, 2);
  assert.strictEqual(cuotas[0].obtenidas, 2);
  assert.strictEqual(cuotas[0].faltante, 0);
});

test('10. un estrato que no alcanza la cuota lo declara explícitamente', () => {
  const strata = [{ id: 'clinico', quota: 80, critical: true, where: 'x', match: () => true }];
  const { cuotas } = buildDataset([fila(), fila({ conversation_id: 'b' })], { strata });
  assert.deepStrictEqual(cuotas[0], { stratum: 'clinico', cuota: 80, obtenidas: 2, faltante: 78, critico: true });
});

test('11. una conversación con menos de 2 turnos de usuario se descarta y NO consume cuota', () => {
  const solaUna = fila({ messages: [{ role: 'user', content: 'hola' }] });
  const strata = [{ id: 'x', quota: 5, critical: false, where: 'x', match: () => true }];
  const { conversations, cuotas, descartadas } = buildDataset([solaUna], { strata });
  assert.strictEqual(conversations.length, 0);
  assert.strictEqual(descartadas.pocosTurnos, 1);
  assert.strictEqual(cuotas[0].obtenidas, 0, 'no debe contar contra la cuota');
});

console.log('\nFRECUENCIAS Y RENORMALIZACIÓN');

test('12. las frecuencias son proporciones del total y el resto queda explícito', () => {
  const f = normalizeFrequencies({ a: 30, b: 20 }, 100);
  assert.strictEqual(f.a, 0.3);
  assert.strictEqual(f.b, 0.2);
  assert.strictEqual(f._resto, 0.5, 'la mitad de la población no pertenece a ningún estrato');
  assert.strictEqual(f._total_conversaciones, 100);
});

test('13. si los estratos suman MÁS que el total, FALLA en vez de renormalizar', () => {
  // Sumar de más significa que la exclusión mutua está rota. Renormalizar
  // convertiría un número equivocado en uno plausible.
  assert.throws(() => normalizeFrequencies({ a: 70, b: 60 }, 100), /más de una vez/);
});

test('14. total cero devuelve null, no una división por cero', () => {
  assert.strictEqual(normalizeFrequencies({ a: 0 }, 0), null);
});

console.log('\npending_payment — TRES estados');

test('15. la vista reporta pendiente → true', () => {
  assert.strictEqual(pendingPaymentFrom({ has_pending: true }), true);
});

test('16. el LEFT JOIN no encontró fila → false (es conocimiento, no ignorancia)', () => {
  assert.strictEqual(pendingPaymentFrom({ has_pending: null }), false);
});

test('17. REGRESIÓN: la columna ausente → undefined, NUNCA false', () => {
  // "no existe" y "no se pudo consultar" no pueden representarse igual: el
  // resolver devuelve INDETERMINADO para el segundo caso.
  assert.strictEqual(pendingPaymentFrom({ conversation_id: 'x' }), undefined);
});

test('18. el dataset propaga los tres estados sin colapsarlos', () => {
  const strata = [{ id: 'x', quota: 9, critical: false, where: 'x', match: () => true }];
  const { conversations } = buildDataset([
    fila({ conversation_id: 'a', has_pending: true }),
    fila({ conversation_id: 'b', has_pending: null }),
    fila({ conversation_id: 'c' }),
  ], { strata });
  assert.strictEqual(conversations[0].pending_payment, true);
  assert.strictEqual(conversations[1].pending_payment, false);
  assert.strictEqual(conversations[2].pending_payment, undefined);
});

console.log('\nTURNOS Y payload hints');

test('19. los mensajes se convierten en turnos de usuario con su respuesta real', () => {
  const turns = buildTurns([
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'buenas, ¿en qué ciudad?' },
    { role: 'user', content: 'Medellín' },
  ]);
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[0].user, 'hola');
  assert.strictEqual(turns[0].assistant_real, 'buenas, ¿en qué ciudad?');
  assert.strictEqual(turns[1].assistant_real, null, 'el último turno no tiene respuesta posterior');
});

test('20. los mensajes vacíos se descartan antes de aparear', () => {
  const turns = buildTurns([
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: '   ' },
    { role: 'assistant', content: 'respuesta real' },
  ]);
  assert.strictEqual(turns[0].assistant_real, 'respuesta real', 'el blanco no debe quedar como la respuesta');
});

test('21. el contenido en bloques se aplana a texto', () => {
  const turns = buildTurns([
    { role: 'user', content: [{ type: 'text', text: 'linea uno' }, { type: 'image' }, { type: 'text', text: 'linea dos' }] },
    { role: 'assistant', content: 'ok' },
  ]);
  assert.strictEqual(turns[0].user, 'linea uno\nlinea dos');
});

test('22. _payload_hints sale de la columna triaje y va anonimizado', () => {
  const strata = [{ id: 'x', quota: 5, critical: false, where: 'x', match: () => true }];
  const { conversations } = buildDataset([
    fila({ triaje: { triaje1: 'TDAH', triaje2: '2 años', triaje3: 'escribir a juan@mail.com' } }),
  ], { strata });
  assert.deepStrictEqual(conversations[0]._payload_hints,
    { triaje1: 'TDAH', triaje2: '2 años', triaje3: 'escribir a [EMAIL]' });
});

console.log('\nANONIMIZACIÓN');

test('23. teléfono, email y URL se redactan', () => {
  const out = scrub('escribime a ana@correo.com o al 3001234567, mirá https://ejemplo.com/x');
  assert.ok(out.includes('[EMAIL]'), out);
  assert.ok(out.includes('[TEL]'), out);
  assert.ok(out.includes('[URL]'), out);
  assert.ok(!/\d{7,}/.test(out), `quedaron dígitos: ${out}`);
});

test('24. el +57 y los separadores también caen', () => {
  assert.ok(!/\d{7,}/.test(scrub('+57 300 123 4567').replace(/\D/g, '')), scrub('+57 300 123 4567'));
  assert.ok(scrub('mi cédula es 1.020.304.050').includes('[TEL]'));
});

test('25. NO redacta números cortos legítimos', () => {
  assert.strictEqual(scrub('tiene 8 años y son 2 sesiones'), 'tiene 8 años y son 2 sesiones');
});

test('26. el NOMBRE permanece → se marca redacción manual pendiente', () => {
  const strata = [{ id: 'x', quota: 5, critical: false, where: 'x', match: () => true }];
  const { conversations } = buildDataset([fila({ texto: 'mi hijo Santiago Restrepo tiene 8 años' })], { strata });
  assert.ok(conversations[0].turns[0].user.includes('Santiago Restrepo'),
    'scrub no toca nombres, y pretender lo contrario sería peor que no hacerlo');
  assert.strictEqual(conversations[0]._needs_name_redaction, true);
});

console.log('\nFUGA DE IDENTIFICADORES');

test('27. conversation_id y contact_id entran al transformador y NO salen en el JSON', () => {
  const strata = [{ id: 'x', quota: 5, critical: false, where: 'x', match: () => true }];
  const { conversations } = buildDataset([
    fila({ conversation_id: 'CONV-SECRETO-123', contact_id: 'CONTACT-SECRETO-456' }),
  ], { strata });
  const json = JSON.stringify(conversations);
  assert.ok(!json.includes('CONV-SECRETO-123'), 'se filtró conversation_id');
  assert.ok(!json.includes('CONTACT-SECRETO-456'), 'se filtró contact_id');
  assert.ok(!json.includes('conversation_id'), 'se filtró la clave conversation_id');
  assert.ok(!json.includes('contact_id'), 'se filtró la clave contact_id');
  assert.match(conversations[0].id, /^x-\d{3}$/, 'el id emitido es opaco');
});

console.log('\nVALIDACIÓN DEL GOLD SET');

test('28. un dataset sin etiquetar se rechaza', () => {
  const v = validateGold({ conversations: [{ _labeled: false, _needs_name_redaction: false }] });
  assert.strictEqual(v.ok, false);
  assert.ok(v.bloqueantes.some(p => /sin etiquetar/.test(p)), v.bloqueantes.join(' | '));
});

test('29. un dataset sin redacción manual de nombres se rechaza', () => {
  const v = validateGold({ conversations: [{ _labeled: true, _needs_name_redaction: true }] });
  assert.strictEqual(v.ok, false);
  assert.ok(v.bloqueantes.some(p => /redacción manual/.test(p)), v.bloqueantes.join(' | '));
});

test('30. un dataset vacío se rechaza', () => {
  assert.strictEqual(validateGold({ conversations: [] }).ok, false);
});

test('31. sin stratum_frequencies advierte pero NO bloquea', () => {
  const v = validateGold({ conversations: [{ _labeled: true, _needs_name_redaction: false }] });
  assert.strictEqual(v.ok, true, v.bloqueantes.join(' | '));
  assert.ok(v.problemas.some(p => /stratum_frequencies/.test(p)));
});

test('32. un dataset completo pasa', () => {
  const v = validateGold({
    stratum_frequencies: { x: 1 },
    pending_payment_disponible: true,
    conversations: [{ _labeled: true, _needs_name_redaction: false }],
  });
  assert.strictEqual(v.ok, true, v.problemas.join(' | '));
  assert.deepStrictEqual(v.problemas, []);
});

test('33. sin pending_payment el dataset corre pero marca bloqueo del gate financiero', () => {
  // Distinción deliberada: la medición puede correr, la aprobación no.
  const v = validateGold({
    stratum_frequencies: { x: 1 },
    pending_payment_disponible: false,
    conversations: [{ _labeled: true, _needs_name_redaction: false }],
  });
  assert.strictEqual(v.ok, true, 'la corrida no se bloquea');
  assert.strictEqual(v.bloqueaGateFinanciero, true, 'pero el gate financiero sí');
  assert.ok(v.problemas.some(p => /MEDIO_WOMPI/.test(p)), v.problemas.join(' | '));
});

test('34. el metadato ausente cuenta como NO disponible', () => {
  const v = validateGold({ conversations: [{ _labeled: true, _needs_name_redaction: false }] });
  assert.strictEqual(v.bloqueaGateFinanciero, true,
    'la ausencia del metadato no es evidencia de que el dato se pudo consultar');
});

Promise.all(pendientes).then(() => {
  console.log(`\n${n - failed}/${n} OK`);
  process.exit(failed ? 1 : 0);
});
