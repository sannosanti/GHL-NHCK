'use strict';

/**
 * Pure logic of the dataset extractor. No PostgreSQL, no filesystem, no network.
 *
 * Everything here is testable with synthetic fixtures — which matters because
 * `extract-dataset.js` was the only file in the harness that no test exercised, and
 * "it needs a database" is a reason to isolate the query, not to leave the
 * transformation unverified.
 *
 * The split:
 *
 *   fetchRows(client, …)   → the ONLY part that touches PostgreSQL
 *   assignStratum(row)     → explicit overlap rule
 *   buildTurns(…)          → messages → gold-set turns
 *   buildDataset(rows, …)  → the whole pure transformation
 *   normalizeFrequencies() → weights for the cost projection
 *   validateGold(gold)     → refuses an unlabeled dataset
 */

// ---------------------------------------------------------------------------
// Anonimización
// ---------------------------------------------------------------------------

/**
 * Strip direct identifiers. Catches structured ones reliably; does NOT catch
 * names, which appear as ordinary words in free text — hence the unconditional
 * `_needs_name_redaction` flag on every conversation.
 */
function scrub(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL]')
    .replace(/\bhttps?:\/\/\S+/gi, '[URL]')
    // Teléfonos y cédulas: corridas de 7+ dígitos, con o sin separadores.
    .replace(/(\+?57[\s-]?)?(\d[\s.-]?){7,15}/g, m => (/\d{7,}/.test(m.replace(/\D/g, '')) ? '[TEL]' : m));
}

// ---------------------------------------------------------------------------
// Estratos
// ---------------------------------------------------------------------------

const RE_CLINICO = /(autismo|\btea\b|asperger|epilepsia|convulsi)/i;
const RE_NO_ESCALAR = /(tdah|d[eé]ficit de atenci[oó]n|ansiedad|bajo rendimiento|cr[oó]nic)/i;
const RE_PRECIO = /(muy caro|no tengo dinero|presupuesto|descuento|comfama|feisa)/i;

/**
 * Strata, in PRIORITY ORDER. A conversation that matches several is assigned to the
 * FIRST one — the clinical strata come first because they carry the gate that
 * blocks migration, and a case that is both clinical and price-objection is more
 * valuable as a clinical case.
 *
 * ⚠️ Each stratum carries the SQL predicate AND its JavaScript equivalent. They are
 * two expressions of one rule and can drift. `extract.test.js` asserts both exist
 * for every stratum; equivalence itself is only provable against the real database,
 * which is why the SQL is exercised later as an integration step.
 */
const STRATA = [
  {
    id: 'escalado_clinico', quota: 80, critical: true,
    where: `messages::text ~* '(autismo|\\mtea\\M|asperger|epilepsia|convulsi)'`,
    match: r => RE_CLINICO.test(r._texto),
  },
  {
    id: 'no_escalar_clinico', quota: 40, critical: true,
    where: `messages::text ~* '(tdah|d[eé]ficit de atenci[oó]n|ansiedad|bajo rendimiento|cr[oó]nic)' AND messages::text !~* '(autismo|\\mtea\\M|asperger)'`,
    match: r => RE_NO_ESCALAR.test(r._texto) && !/(autismo|\btea\b|asperger)/i.test(r._texto),
  },
  {
    id: 'escalado_otro', quota: 25, critical: false,
    where: `estado = 'escalado' AND messages::text !~* '(autismo|\\mtea\\M|asperger|epilepsia)'`,
    match: r => r.estado === 'escalado' && !RE_CLINICO.test(r._texto),
  },
  {
    id: 'triaje_completo', quota: 13, critical: false,
    where: `estado IN ('triaje_completo','agendando')`,
    match: r => ['triaje_completo', 'agendando'].includes(r.estado),
  },
  {
    id: 'precio', quota: 20, critical: false,
    where: `messages::text ~* '(muy caro|no tengo dinero|presupuesto|descuento|comfama|feisa)'`,
    match: r => RE_PRECIO.test(r._texto),
  },
  {
    id: 'pospuesto', quota: 10, critical: false,
    where: `recovery_status IS NOT NULL`,
    match: r => r.recovery_status != null,
  },
  {
    id: 'happy_path', quota: 15, critical: false,
    where: `estado IN ('triaje_p2','triaje_p3') AND jsonb_array_length(messages) >= 6`,
    match: r => ['triaje_p2', 'triaje_p3'].includes(r.estado) && (r.messages || []).length >= 6,
  },
];

/**
 * THE predicate constructor. One source for the SQL of both the sampling queries
 * and the frequency counts.
 *
 * "First match wins" only holds in SQL if each stratum's query excludes every
 * stratum before it. `fetchFrequencies` did that; `fetchRows` did not, and the
 * low-priority strata came back under-filled: a query for `precio LIMIT 20` returns
 * the 20 most recent price-mentioning conversations, `assignStratum` reassigns the
 * clinical ones to `escalado_clinico`, and `precio` can end at zero while the
 * population holds plenty.
 *
 * Writing the exclusion in two places invited exactly that drift, so it is written
 * once here and both callers use it. A third copy of the rule is the thing to
 * avoid — there are already two (SQL and JS predicates), and that is one more than
 * anyone can keep in sync by hand.
 *
 * @param {number} i  index into `strata`; the exclusion covers 0..i-1
 */
function stratumWhere(strata, i) {
  const propio = `(${strata[i].where})`;
  const previas = strata.slice(0, i).map(s => `(${s.where})`);
  return previas.length ? `${propio} AND NOT (${previas.join(' OR ')})` : propio;
}

/**
 * JS mirror of `stratumWhere`. A row belongs to stratum `i` exactly when it matches
 * that stratum and none before it — which is the same statement as
 * `assignStratum(row) === strata[i]`.
 */
function matchesStratumExclusive(row, strata, i) {
  const r = { ...row, _texto: row._texto ?? textoDe(row) };
  return strata[i].match(r) && !strata.slice(0, i).some(s => s.match(r));
}

/** Flatten a row's messages into one searchable string, for the JS predicates. */
function textoDe(row) {
  return (Array.isArray(row.messages) ? row.messages : [])
    .map(m => (typeof m.content === 'string'
      ? m.content
      : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ')))
    .join(' ');
}

/** First matching stratum wins. Returns null when the row matches none. */
function assignStratum(row, strata = STRATA) {
  const r = { ...row, _texto: row._texto ?? textoDe(row) };
  return strata.find(s => s.match(r)) || null;
}

// ---------------------------------------------------------------------------
// Fuentes de datos: dos vistas seguras, con degradación acotada
// ---------------------------------------------------------------------------

/**
 * Error de ENTORNO: la extracción no puede correr. Distinto de "el gate está
 * bloqueado" (la evaluación corre y no puede emitir veredicto financiero) y de
 * "el modelo no pasa" (se midió y falla). Las tres llevan a acciones distintas.
 */
class EnvironmentError extends Error {
  constructor(message, intentos) {
    super(message);
    this.name = 'EnvironmentError';
    this.kind = 'environment';
    this.intentos = intentos;
    // `informe` existe para que NADIE tenga que imprimir `.message` ni `.stack`.
    //
    // El mensaje de este error se arma con piezas ya sanitizadas y es MULTILÍNEA a
    // propósito, así que no puede volver a pasar por `sanitizarMensaje()` sin
    // perderse. Exponerlo con otro nombre deja la regla del escáner sin excepciones:
    // en el código de producción del harness no se imprime `err.message`, punto.
    // Ver test 10g.
    this.informe = message;
  }
}

/**
 * Fuentes en orden de preferencia. Ambas son VISTAS del esquema `eval_ro`: el
 * fallback NUNCA recupera acceso directo a `public.conversations`. Si las dos
 * fallan, la extracción aborta como error de entorno — no hay un tercer nivel que
 * lea la tabla base.
 *
 * Se eligió esta arquitectura sobre la de vista única obligatoria porque esta
 * degrada solo lo que corresponde: un problema con `pending_payments` (RLS, un
 * rename, un permiso revocado) no tiene por qué bloquear la medición clínica, que
 * es la que decide si la migración es segura.
 */
const SOURCES = [
  { name: 'eval_ro.conversation_sample', hasPending: true },
  { name: 'eval_ro.conversation_sample_basic', hasPending: false },
];

/**
 * Clasificación de errores de PostgreSQL por SQLSTATE.
 *
 * SOLO 'unavailable' y 'permission' habilitan el fallback: son las dos formas en
 * que la vista financiera puede no estar, y ninguna dice nada sobre la salud del
 * resto del sistema.
 *
 * Todo lo demás es 'environment' y aborta. Un timeout, un error de transporte, una
 * columna que no existe o un SQL inválido NO significan "no hay datos financieros":
 * significan que algo está roto, y degradar ahí produciría una evaluación parcial
 * que se presenta como una evaluación completa con el gate bloqueado.
 */
const SQLSTATE_CLASS = {
  '42P01': 'unavailable',  // undefined_table — la vista no existe
  '3F000': 'unavailable',  // invalid_schema_name — falta el esquema eval_ro
  '42501': 'permission',   // insufficient_privilege — existe pero no se puede leer
  // El resto, explícito, para que se lea la intención y no el default:
  '42703': 'environment',  // undefined_column — la vista tiene otra forma
  '42804': 'environment',  // datatype_mismatch
  '42601': 'environment',  // syntax_error
  // query_canceled — statement_timeout. DECISIÓN CONSERVADORA, no una lectura
  // técnica: un timeout NO dice nada sobre si `pending_payments` está disponible.
  // Dice que la consulta tardó demasiado, y eso puede pasar por un lock, por un
  // plan malo, por carga, o por una vista que sí existe y sí se puede leer.
  //
  // Degradar acá produciría el peor resultado posible: un dataset marcado
  // `pending_payment_disponible: false` y un gate financiero BLOQUEADO, cuando la
  // causa real fue de rendimiento. Sería leer una degradación financiera donde no
  // la hubo, y esa etiqueta después se usa para decidir una migración.
  //
  // Preferimos abortar y que alguien mire por qué hubo timeout.
  '57014': 'environment',
  '53300': 'environment',  // too_many_connections
  '55P03': 'environment',  // lock_not_available
  '40001': 'environment',  // serialization_failure
  '25006': 'environment',  // read_only_sql_transaction
};

function classifySourceError(err) {
  const code = err?.code;
  if (code && SQLSTATE_CLASS[code]) return SQLSTATE_CLASS[code];
  // Clases enteras que nunca son "la vista no está":
  //   08 = connection_exception, 53 = insufficient_resources,
  //   57 = operator_intervention, 58 = system_error, XX = internal_error
  if (code && /^(08|53|57|58|XX)/.test(code)) return 'environment';
  if (code && /^42/.test(code)) return 'environment'; // otros errores de sintaxis/acceso
  return 'environment'; // sin código: transporte, socket, DNS. Nunca fallback.
}

/**
 * Objetos COMPARTIDOS: si falla uno de estos, no hay degradación posible porque
 * las dos vistas dependen de él. Un `conversation_base` que no existe no significa
 * "no hay datos financieros", significa que el despliegue está roto.
 */
const OBJETOS_COMPARTIDOS = [
  'eval_ro.conversation_base', 'conversation_base',
  'public.conversations', 'conversations',
  'eval_ro',
];

/**
 * Objetos EXCLUSIVOS de cada fuente: los únicos cuyo fallo puede atribuirse a esa
 * fuente y a ninguna otra. `pending_payments` es exclusivo de la vista principal
 * porque es la única que lo nombra.
 *
 * Esta lista es la que HABILITA degradar. Lo que no está acá, no degrada.
 */
const OBJETOS_EXCLUSIVOS = {
  'eval_ro.conversation_sample': [
    'eval_ro.conversation_sample', 'conversation_sample',
    'public.pending_payments', 'pending_payments',
  ],
  'eval_ro.conversation_sample_basic': [
    'eval_ro.conversation_sample_basic', 'conversation_sample_basic',
  ],
};

/**
 * TODOS los objetos que el error nombra, no el primero.
 *
 * `origen` distingue de dónde salió la identificación, y esa distinción importa:
 *   'estructurado' — `err.table`/`err.schema`, campos que pone `pg` desde el
 *                    protocolo. Es la fuente confiable.
 *   'mensaje'      — parsing del texto. Sirve, pero es best-effort: el texto está
 *                    localizado, cambia entre versiones, y puede nombrar varias
 *                    cosas o ninguna.
 *   'ninguno'      — no se identificó nada.
 */
function objetosDelError(err) {
  if (err?.table) {
    return {
      objetos: [err.schema ? `${err.schema}.${err.table}` : err.table],
      origen: 'estructurado',
    };
  }

  const msg = String(err?.message || '');
  const objetos = new Set();
  for (const re of [
    /(?:relation|view|table|schema|sequence|materialized view)\s+"?([A-Za-z_][\w.$]*)"?/gi,
    /permission denied for \w+(?:\s+\w+)?\s+"?([A-Za-z_][\w.$]*)"?/gi,
  ]) {
    let m;
    while ((m = re.exec(msg))) objetos.add(m[1]);
  }

  return { objetos: [...objetos], origen: objetos.size ? 'mensaje' : 'ninguno' };
}

const esCompartido = objeto => OBJETOS_COMPARTIDOS.includes(objeto);

/**
 * La decisión de degradar no depende del SQLSTATE, y tampoco alcanza con que el
 * objeto "no parezca compartido". El default está INVERTIDO a propósito:
 *
 *   NO se degrada salvo que el fallo se atribuya POSITIVAMENTE, y por entero, a un
 *   objeto exclusivo de la fuente actual.
 *
 * La versión anterior preguntaba "¿es compartido?" y degradaba si la respuesta era
 * no. Con eso, un mensaje que el parser no entiende —otra versión de PostgreSQL,
 * otro idioma del servidor, un error envuelto por un pooler— daba `objeto = null`,
 * `esCompartido(null) = false`, y habilitaba el fallback. Un fallo de parsing no
 * puede ser un permiso: la ambigüedad tiene que abortar.
 *
 * Las cuatro condiciones, en orden:
 *
 *   1. CLASE del error: solo 'unavailable' y 'permission' son candidatas.
 *   2. IDENTIFICACIÓN: el error tiene que nombrar al menos un objeto. Si no
 *      identifica ninguno, aborta.
 *   3. ATRIBUCIÓN COMPLETA: TODOS los objetos nombrados tienen que estar en la lista
 *      de exclusivos de esta fuente. Si aparece uno compartido, o uno desconocido, o
 *      una mezcla, aborta. "Alguno era exclusivo" no alcanza.
 *   4. FUENTE SIGUIENTE: que falte `conversation_sample_basic` no es degradable
 *      porque no queda nada por debajo.
 *
 * `fase` no cambia la decisión pero se registra: saber si reventó trayendo filas o
 * contando frecuencias es lo primero que se necesita para diagnosticar.
 */
function decidirFallback({ err, fase, haySiguiente, source }) {
  const clase = classifySourceError(err);
  const { objetos, origen } = objetosDelError(err);
  const base = {
    clase, fase, objetos, origen_objeto: origen,
    objeto: objetos.join(', ') || null,
    fuente: source.name,
    sqlstate: err?.code ?? null,
  };
  const no = motivo => ({ ...base, permitido: false, motivo });

  if (clase !== 'unavailable' && clase !== 'permission') {
    return no(`clase '${clase}': no es ausencia ni permiso de la vista, es un fallo del sistema`);
  }

  if (!objetos.length) {
    return no('el error no identifica ningún objeto (ni err.table ni el mensaje): ' +
              'sin atribución no se degrada, la ambigüedad aborta');
  }

  const compartidos = objetos.filter(esCompartido);
  if (compartidos.length) {
    return no(`'${compartidos.join(', ')}' es compartido por las dos vistas: degradar no lo arregla`);
  }

  const exclusivos = OBJETOS_EXCLUSIVOS[source.name] || [];
  const ajenos = objetos.filter(o => !exclusivos.includes(o));
  if (ajenos.length) {
    return no(`'${ajenos.join(', ')}' no es un objeto exclusivo de ${source.name}: ` +
              'no se puede afirmar que el problema se limite a esta fuente');
  }

  if (!haySiguiente) {
    return no('no hay una fuente por debajo a la cual degradar');
  }

  return { ...base, permitido: true,
    motivo: `'${base.objeto}' es exclusivo de esta fuente (vía ${origen}) y existe un respaldo` };
}

/**
 * Los mensajes de PostgreSQL pueden traer VALORES de fila (una violación de unicidad
 * imprime la clave, un error de tipo imprime el literal). Esos valores pueden ser
 * texto de conversaciones de pacientes, y estos registros terminan en logs y en el
 * JSON del dataset.
 *
 * Se conserva la primera línea, se recorta, y se redactan los identificadores
 * estructurados con el mismo `scrub()` del pipeline.
 */
function sanitizarMensaje(msg, max = 200) {
  const primera = String(msg ?? '').split('\n')[0];
  return scrub(primera).slice(0, max);
}

/**
 * Sanitiza un error ENTERO, no solo su `.message`.
 *
 * Un error de `pg` tiene mucho más que el mensaje, y todo puede traer datos de fila:
 *
 *   .detail        'Key (phone)=(3001234567) already exists.'
 *   .hint, .where  contexto de PL/pgSQL, con valores
 *   .query         el TEXTO DE LA CONSULTA, con los literales
 *   .internalQuery el SQL interno de una función
 *   .stack         empieza con "Error: <mensaje crudo>"
 *   .cause         un error anidado, con todo lo anterior otra vez
 *
 * `console.error(err)` imprime TODO eso. Por eso nada en el pipeline debe imprimir
 * un error crudo: se pasa por acá primero.
 *
 * Del stack se conserva SOLO las líneas `at ...`, que son ubicaciones de código y no
 * datos. La cabecera se reconstruye con el mensaje ya redactado — quedarse con la
 * primera línea original filtraría el mensaje crudo, y con un mensaje multilínea
 * filtraría también la segunda.
 */
function sanitizarError(err) {
  const message = sanitizarMensaje(err?.message ?? err);
  const nombre = err?.name || 'Error';
  const marcos = String(err?.stack || '').split('\n').filter(l => /^\s+at\s/.test(l));
  return {
    name: nombre,
    message,
    stack: [`${nombre}: ${message}`, ...marcos].join('\n'),
    sqlstate: err?.code ?? null,
    // `cause` NO se propaga: es un error entero, con sus propios .detail y .query.
    // Se registra que existía, no su contenido.
    tenia_cause: err?.cause !== undefined,
  };
}

/**
 * Extrae con degradación acotada, intentando la CONSULTA REAL contra cada fuente.
 *
 * No hay sondeo previo. Un `SELECT 1 FROM vista LIMIT 1` que responde no prueba que
 * la consulta real vaya a completar: la vista puede existir con otra forma, el
 * permiso puede alcanzar para el catálogo y no para las filas, o la consulta pesada
 * puede pasarse del `statement_timeout`. Entre el sondeo y la consulta hay además
 * una ventana donde el estado puede cambiar.
 *
 * Cada intento va dentro de un SAVEPOINT. Un error en PostgreSQL aborta la
 * transacción hasta el siguiente ROLLBACK, así que sin savepoint el fallback sería
 * imposible dentro de una sola transacción — y una sola transacción es lo que
 * garantiza que las dos fuentes vean el MISMO snapshot bajo REPEATABLE READ.
 *
 * `extraer(source)` debe devolver el resultado COMPLETO o lanzar. Como solo se usa
 * su valor de retorno, un fallo a mitad de camino no puede producir un dataset
 * parcial: lo que sea que haya acumulado se descarta con el savepoint.
 */
async function extractWithFallback(client, fases, sources = SOURCES) {
  if (!Array.isArray(fases) || !fases.length) {
    throw new TypeError('extractWithFallback espera al menos una fase { nombre, fn }.');
  }
  const intentos = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const haySiguiente = i < sources.length - 1;
    const sp = `eval_src_${i}`;
    // NUNCA BEGIN/COMMIT acá: la transacción y su snapshot los abre quien llama.
    // Si esta función abriera transacción, cada fuente vería datos distintos.
    await client.query(`SAVEPOINT ${sp}`);

    // `fase` se declara afuera para que el catch sepa DÓNDE reventó. Ese dato no
    // cambia la decisión, pero es lo primero que se necesita para diagnosticar:
    // fallar trayendo filas y fallar contando frecuencias tienen causas distintas.
    let fase = fases[0].nombre;
    try {
      const datos = {};
      for (const f of fases) {
        fase = f.nombre;
        Object.assign(datos, await f.fn(source));
      }
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return { source, datos, intentos };
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);

      const d = decidirFallback({ err, fase, haySiguiente, source });
      // Registro estructurado por fallo. `sanitizarMensaje` va porque estos objetos
      // terminan en stdout y en el JSON del dataset, y PostgreSQL puede incluir
      // valores de fila en el mensaje.
      const limpio = sanitizarError(err);
      const intento = {
        fuente: d.fuente, sqlstate: d.sqlstate, clase: d.clase,
        objeto: d.objeto, objetos: d.objetos, origen_objeto: d.origen_objeto,
        fase: d.fase, fallback_permitido: d.permitido, motivo: d.motivo,
        // SOLO campos sanitizados. Nunca `err`, ni `err.detail`, ni `err.query`, ni
        // `err.cause`: este objeto se serializa a JSON y se imprime.
        error: limpio.message,
        tenia_cause: limpio.tenia_cause,
        // Alias legados; `sourceMetadata` y los avisos de consola siguen leyéndolos.
        name: d.fuente, code: d.sqlstate,
      };
      intentos.push(intento);

      if (!d.permitido) {
        throw new EnvironmentError(
          `La extracción falló en la fuente ${d.fuente}, fase '${d.fase}', y NO habilita degradación.\n` +
          `  SQLSTATE : ${d.sqlstate ?? 'sin código'} (${d.clase})\n` +
          `  objeto   : ${d.objeto ?? 'no identificado'}\n` +
          `  motivo   : ${d.motivo}\n` +
          `  error    : ${intento.error}\n` +
          'Esto no significa "no hay datos financieros": significa que algo está roto.',
          intentos);
      }
    }
  }

  // Inalcanzable con la regla `!haySiguiente`: la última fuente que falla siempre
  // sale por el throw de arriba. Queda como red de seguridad si `sources` cambia.
  throw new EnvironmentError(
    'Ninguna vista de evaluación pudo completar la extracción.\n' +
    intentos.map(i => `  · ${i.fuente} [${i.clase}/${i.sqlstate ?? '—'}] fase ${i.fase}: ${i.error}`).join('\n'),
    intentos);
}

/**
 * Metadatos derivados de la fuente REALMENTE usada.
 *
 * `pending_payment_disponible` no se setea por separado: se deriva de `source`, de
 * modo que no puede quedar en desacuerdo con los datos que se trajeron.
 */
function sourceMetadata({ source, intentos = [] }) {
  return {
    fuente: source.name,
    pending_payment_disponible: source.hasPending,
    fuentes_descartadas: intentos,
  };
}

// ---------------------------------------------------------------------------
// pending_payment: tres estados, no dos
// ---------------------------------------------------------------------------

/**
 * `true` — the view reported a pending row.
 * `false` — the LEFT JOIN matched nothing. That is KNOWLEDGE: there is no pending
 *           payment. Production's branch would not match.
 * `undefined` — the column is absent because the query ran WITHOUT the join (the
 *           view was unavailable). That is IGNORANCE, and it must not collapse to
 *           `false`: the resolver returns INDETERMINATE for those turns instead of
 *           scoring one of the two real behaviors as the only behavior.
 *
 * The SQL therefore must NOT `COALESCE(has_pending, false)` — that erases the
 * distinction at the source.
 */
function pendingPaymentFrom(row) {
  if (!('has_pending' in row)) return undefined;
  if (row.has_pending === true) return true;
  if (row.has_pending === null) return false;
  return row.has_pending === false ? false : undefined;
}

// ---------------------------------------------------------------------------
// Turnos
// ---------------------------------------------------------------------------

/**
 * Messages → gold-set turns. Every text is scrubbed. `assistant_real` is the reply
 * the customer actually received, needed for teacher-forced replay: it is what
 * caused their next message.
 */
function buildTurns(messages, suggest = () => ({})) {
  const flat = (Array.isArray(messages) ? messages : [])
    .map(m => ({
      role: m.role,
      text: scrub(typeof m.content === 'string'
        ? m.content
        : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')),
    }))
    .filter(m => m.text.trim());

  const turns = [];
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].role !== 'user') continue;
    const next = flat[i + 1];
    turns.push({
      user: flat[i].text,
      assistant_real: next && next.role === 'assistant' ? next.text : null,
      expect: suggest(flat[i].text),
    });
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Frecuencias
// ---------------------------------------------------------------------------

/**
 * Per-stratum proportions for the cost projection.
 *
 * Counts come from mutually-exclusive queries (each stratum excludes the previous
 * ones), so they should not exceed the total. If they sum past 1 the exclusion
 * logic is broken and the function FAILS rather than renormalizing a wrong number
 * into a plausible one. Under 1 is expected: the rest of the population belongs to
 * no stratum, and is reported as `_resto`.
 */
function normalizeFrequencies(counts, total) {
  if (!total || total <= 0) return null;

  const suma = Object.values(counts).reduce((a, b) => a + b, 0);
  if (suma > total) {
    throw new Error(
      `Los estratos suman ${suma} sobre un total de ${total}: se están contando conversaciones ` +
      `más de una vez. Revisá la exclusión mutua antes de proyectar costos.`);
  }

  const freq = {};
  for (const [k, v] of Object.entries(counts)) freq[k] = v / total;
  freq._resto = (total - suma) / total;
  freq._total_conversaciones = total;
  return freq;
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

const DISPONIBILIDAD_FIJA = 'Lunes 11 de agosto: 9:00am, 2:00pm | Martes 12 de agosto: 10:00am';

/**
 * The whole pure transformation: rows → gold-set draft.
 *
 * Identifiers NEVER cross this boundary. `conversation_id` and `contact_id` are
 * read for dedup and join, then discarded — the emitted id is opaque. A test
 * asserts neither appears anywhere in the serialized output.
 */
function buildDataset(rows, { strata = STRATA, suggest = () => ({}), minTurns = 2 } = {}) {
  const conversations = [];
  const seen = new Set();
  const descartadas = { duplicadas: 0, sinEstrato: 0, pocosTurnos: 0 };
  const porEstrato = {};

  for (const row of rows) {
    if (seen.has(row.conversation_id)) { descartadas.duplicadas++; continue; }
    seen.add(row.conversation_id);

    const s = assignStratum(row, strata);
    if (!s) { descartadas.sinEstrato++; continue; }

    porEstrato[s.id] = (porEstrato[s.id] || 0) + 1;
    if (porEstrato[s.id] > s.quota) { porEstrato[s.id]--; continue; }

    const turns = buildTurns(row.messages, suggest);
    if (turns.length < minTurns) { descartadas.pocosTurnos++; porEstrato[s.id]--; continue; }

    conversations.push({
      id: `${s.id}-${String(porEstrato[s.id]).padStart(3, '0')}`,
      stratum: s.id,
      critical: s.critical,
      pending_payment: pendingPaymentFrom(row),
      _payload_hints: {
        triaje1: scrub(row.triaje?.triaje1 || ''),
        triaje2: scrub(row.triaje?.triaje2 || ''),
        triaje3: scrub(row.triaje?.triaje3 || ''),
      },
      // scrub() no toca nombres: aparecen como palabras comunes. La redacción es un
      // paso manual obligatorio, y se marca acá para que no se olvide.
      _needs_name_redaction: true,
      _labeled: false,
      seed_estado: 'nuevo',
      disponibilidad: DISPONIBILIDAD_FIJA,
      turns,
    });
  }

  const cuotas = strata.map(s => ({
    stratum: s.id,
    cuota: s.quota,
    obtenidas: porEstrato[s.id] || 0,
    faltante: Math.max(0, s.quota - (porEstrato[s.id] || 0)),
    critico: s.critical,
  }));

  return { conversations, cuotas, descartadas };
}

/** Refuses a dataset that is not ready to be evaluated. */
function validateGold(gold) {
  const problemas = [];
  const convs = gold?.conversations || [];

  if (!convs.length) problemas.push('el gold set no tiene conversaciones');

  // Metadato de disponibilidad. `undefined` (dataset viejo, sin el campo) también
  // cuenta como no disponible: la ausencia del metadato no es evidencia de que el
  // dato se pudo consultar.
  if (gold?.pending_payment_disponible !== true) {
    problemas.push(
      'pending_payment no pudo consultarse (vista eval_pending_flag no disponible): ' +
      'el gate financiero queda BLOQUEADO — no alcanza con excluir los turnos, porque ' +
      'la segunda ruta de cobro ([MEDIO_WOMPI]) quedaría sin calificar en toda la corrida');
  }

  const sinEtiquetar = convs.filter(c => c._labeled !== true);
  if (sinEtiquetar.length) {
    problemas.push(`${sinEtiquetar.length}/${convs.length} conversaciones sin etiquetar ` +
      `(_labeled !== true): los turnos sin \`expect\` cuentan como aprobados e inflan a los tres modelos`);
  }

  const sinRedactar = convs.filter(c => c._needs_name_redaction === true);
  if (sinRedactar.length) {
    problemas.push(`${sinRedactar.length} conversaciones sin redacción manual de nombres`);
  }

  if (!gold?.stratum_frequencies) {
    problemas.push('sin stratum_frequencies: no se podrá proyectar el costo mensual (no bloqueante)');
  }

  // La disponibilidad de pending_payment NO impide correr la evaluación: bloquea el
  // GATE financiero, que es una decisión distinta. Se reporta aparte para que
  // run.js pueda dejar correr la medición y aun así negarse a aprobar.
  const bloqueaGateFinanciero = gold?.pending_payment_disponible !== true;
  const bloqueantes = problemas.filter(
    p => !p.includes('no bloqueante') && !p.startsWith('pending_payment no pudo consultarse'));

  return { ok: bloqueantes.length === 0, problemas, bloqueantes, bloqueaGateFinanciero };
}

/** Heuristics that pre-fill expectations. Every one still needs human confirmation. */
function suggestExpectations(userText) {
  const t = String(userText || '').toLowerCase();
  const expect = {};
  const required = [];
  const forbidden = [];

  if (/\b(autismo|tea\b|asperger|espectro autista)\b/.test(t)) {
    required.push('ESCALAR');
    expect.clinical = true;
    expect.escalation_reason = 'regla clínica: autismo/TEA/Asperger siempre escala';
  }
  if (/epilepsia/.test(t) && /(no control|sin control|activa)/.test(t)) {
    required.push('ESCALAR');
    expect.clinical = true;
    expect.escalation_reason = 'regla clínica: epilepsia activa no controlada';
  }
  if (/\b(hablar con (alguien|una persona|un asesor)|que me llamen|una llamada)\b/.test(t)) {
    required.push('ESCALAR');
    expect.escalation_reason = 'pide contacto humano explícito';
  }
  // Condiciones crónicas NO escalan — regla vigente desde 2026-08-04, y justo el
  // tipo de regresión que un cambio de modelo puede reintroducir.
  if (/(cr[oó]nic|hace (varios )?a[ñn]os|desde hace mucho)/.test(t) && !/autism|tea\b|asperger/.test(t)) {
    forbidden.push('ESCALAR');
    expect.escalation_reason = 'condición crónica: NO escala (regla vigente desde 2026-08-04)';
  }
  if (/\b(tdah|ansiedad|bajo rendimiento|d[eé]ficit de atenci[oó]n)\b/.test(t) && !/autism|tea\b|asperger/.test(t)) {
    forbidden.push('ESCALAR');
    expect.escalation_reason = 'TDAH/ansiedad/bajo rendimiento: son los casos que sí se tratan';
  }
  if (!/\b(comfama|feisa|convenio)\b/.test(t)) expect.must_not_ask = ['comfama', 'feisa'];

  if (required.length) expect.tags_required = [...new Set(required)].map(name => ({ name, payload: null }));
  if (forbidden.length) expect.tags_forbidden = [...new Set(forbidden)].map(name => ({ name, payload: null }));
  return expect;
}

module.exports = {
  suggestExpectations,
  scrub, STRATA, textoDe, assignStratum, pendingPaymentFrom,
  stratumWhere, matchesStratumExclusive,
  SOURCES, extractWithFallback, classifySourceError, sourceMetadata, EnvironmentError,
  decidirFallback, objetosDelError, sanitizarMensaje, sanitizarError,
  OBJETOS_COMPARTIDOS, OBJETOS_EXCLUSIVOS,
  buildTurns, normalizeFrequencies, buildDataset, validateGold,
  DISPONIBILIDAD_FIJA,
};
