'use strict';

/**
 * Build the gold-set skeleton from real production conversations.
 *
 *   node eval/extract-dataset.js --agent carolina --out eval/gold/nhck.draft.json
 *
 * This file holds ONLY the PostgreSQL-dependent part. Every transformation lives in
 * extract-lib.js and is covered by extract.test.js with synthetic fixtures — a
 * dependency on a database is a reason to isolate the query, not to leave the logic
 * unverified.
 *
 * Output is a DRAFT. Do not evaluate against it: unlabeled turns grade as passing,
 * which inflates every model equally and hides real failures.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Conexión propia con EVAL_DATABASE_URL (rol de solo lectura), nunca el pool de
// producción de ../db: ese usa DATABASE_URL, que tiene permisos de escritura.
// preflight.js aborta si DATABASE_URL está siquiera presente en el entorno.
require('./preflight').assertAislado({ requireModelKeys: false });
if (!process.env.EVAL_DATABASE_URL) {
  console.error('Falta EVAL_DATABASE_URL. Creá el rol con eval/readonly-role.sql y verificá con eval/verify-readonly-db.js.');
  process.exit(1);
}

const {
  STRATA, buildDataset, normalizeFrequencies, stratumWhere,
  extractWithFallback, sourceMetadata, EnvironmentError, suggestExpectations,
  sanitizarError,
} = require('./extract-lib');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}


// ---------------------------------------------------------------------------
// Única parte dependiente de PostgreSQL
// ---------------------------------------------------------------------------

/**
 * Fetch candidate rows, one query per stratum, from the ALREADY-RESOLVED source.
 *
 * Two safe views, never the base table:
 *   · `eval_ro.conversation_sample`       — trae `has_pending`
 *   · `eval_ro.conversation_sample_basic` — sin datos financieros
 *
 * Si se usa la segunda, la columna `has_pending` no viene y `pendingPaymentFrom()`
 * devuelve `undefined`, que el resolver traduce a INDETERMINADO. Nunca a `false`:
 * "no hay pago pendiente" y "no se pudo consultar" son cosas distintas.
 *
 * `extractWithFallback` corre esta función completa contra cada fuente, dentro de un
 * SAVEPOINT. Si falla a mitad, lo acumulado se descarta con el savepoint y solo se
 * devuelve un resultado cuando terminó entero — un dataset parcial es imposible.
 */
async function fetchRows(client, agent, elegida, strata = STRATA) {
  const { source } = elegida;
  const rows = [];

  // La fuente ya está decidida para toda la corrida. Una respuesta parcial —
  // algunas filas con `has_pending` y otras sin — es imposible por construcción:
  // no hay punto en el bucle donde la fuente pueda cambiar.
  const columnas = [
    'v.messages', 'v.estado', 'v.triaje', 'v.recovery_status',
    ...(source.hasPending ? ['v.has_pending'] : []),
  ].join(', ');

  for (let i = 0; i < strata.length; i++) {
    const s = strata[i];
    // MISMO constructor que fetchFrequencies: cada estrato excluye a los
    // anteriores, así el LIMIT se gasta en filas que van a quedar en este estrato
    // y no en filas que assignStratum va a reasignar.
    const cond = stratumWhere(strata, i).replace(/\b(estado|messages|recovery_status)\b/g, 'v.$1');

    const { rows: r } = await client.query(`
      SELECT ${columnas}
        FROM ${source.name} v
       WHERE v.agent = $1 AND jsonb_array_length(v.messages) >= 2 AND (${cond})
       ORDER BY v.updated_at DESC LIMIT $2`, [agent, s.quota]);

    // La vista no expone identificador. La clave posicional solo sirve para la
    // deduplicación defensiva de buildDataset; con estratos mutuamente excluyentes
    // no puede haber duplicados entre consultas.
    r.forEach((row, j) => { row.conversation_id = `${s.id}#${j}`; });
    rows.push(...r);
  }
  return rows;
}

/** Real per-stratum frequency across the whole population, for the cost weights. */
async function fetchFrequencies(client, agent, elegida, strata = STRATA) {
  const vista = elegida.source.name;
  const { rows: [{ total }] } = await client.query(
    `SELECT count(*)::int AS total FROM ${vista} WHERE agent = $1 AND jsonb_array_length(messages) >= 2`,
    [agent]);
  if (!total) return null;

  const counts = {};
  // Mismo constructor y mismo orden que fetchRows.
  for (let i = 0; i < strata.length; i++) {
    const { rows: [{ n }] } = await client.query(
      `SELECT count(*)::int AS n FROM ${vista}
        WHERE agent = $1 AND jsonb_array_length(messages) >= 2 AND ${stratumWhere(strata, i)}`,
      [agent]);
    counts[strata[i].id] = n;
  }
  return normalizeFrequencies(counts, total);
}

async function main() {
  const agent = arg('agent', 'carolina');
  const outPath = arg('out', 'eval/gold/nhck.draft.json');

  const client = new Client({ connectionString: process.env.EVAL_DATABASE_URL });
  await client.connect();

  let payload;
  try {
    // UNA transacción para todo. REPEATABLE READ fija el snapshot en la primera
    // consulta, así que si hay fallback, las dos fuentes ven exactamente los mismos
    // datos — sin eso, la población podría cambiar entre el intento fallido y el
    // que funciona, y la muestra dejaría de ser reproducible.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    // Sin sondeo: se intenta la EXTRACCIÓN COMPLETA contra cada fuente. Una fuente
    // se considera disponible cuando terminó de traer todo, no cuando contestó un
    // SELECT 1.
    // Fases nombradas: si algo falla, el registro dice si reventó trayendo filas o
    // contando frecuencias. Ambas deben completar para que la fuente se dé por buena.
    const { source, datos, intentos } = await extractWithFallback(client, [
      { nombre: 'rows',        fn: src => fetchRows(client, agent, { source: src }).then(rows => ({ rows })) },
      { nombre: 'frequencies', fn: src => fetchFrequencies(client, agent, { source: src }).then(frequencies => ({ frequencies })) },
    ]);

    const meta = sourceMetadata({ source, intentos });

    if (!meta.pending_payment_disponible) {
      console.warn(`⚠️ Usando ${meta.fuente}: sin datos financieros.`);
      console.warn('   El gate financiero quedará BLOQUEADO — no es lo mismo que NO PASA.');
      for (const i of meta.fuentes_descartadas) {
        console.warn(`   descartada ${i.fuente} [${i.clase}/${i.sqlstate ?? '—'}] fase '${i.fase}'`);
        console.warn(`     objeto: ${i.objeto ?? 'no identificado'} · fallback: ${i.fallback_permitido ? 'permitido' : 'denegado'}`);
        console.warn(`     motivo: ${i.motivo}`);
        console.warn(`     error : ${i.error}`);
      }
    }

    const { conversations, cuotas, descartadas } = buildDataset(datos.rows, { suggest: suggestExpectations });

    payload = {
      agent,
      generatedAt: new Date().toISOString(),
      ...meta,   // fuente + pending_payment_disponible, derivados de lo realmente usado
      stratum_frequencies: datos.frequencies,
      conversations,
    };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    console.log(`${conversations.length} conversaciones escritas en ${outPath}\n`);
    console.log('Cuotas por estrato:');
    for (const c of cuotas) {
      const marca = c.faltante > 0 ? (c.critico ? ' ⛔ CRÍTICO' : ' ⚠️') : '';
      console.log(`  ${c.stratum.padEnd(20)} ${String(c.obtenidas).padStart(3)}/${c.cuota}${c.faltante ? `  faltan ${c.faltante}` : ''}${marca}`);
    }
    console.log(`\nDescartadas: ${JSON.stringify(descartadas)}`);
    console.log();

    const clinicas = cuotas.filter(c => c.critico && c.faltante > 0);
    if (clinicas.length) {
      console.log('\n⛔ Estratos clínicos incompletos: el gate de recall clínico no tendrá poder suficiente.');
    }

    console.log('\nCHECKLIST OBLIGATORIO antes de correr run.js:');
    console.log('  1. Redactar NOMBRES a mano y poner "_needs_name_redaction": false.');
    console.log('     El scrub automático cubre teléfonos, emails y URLs, NO nombres.');
    console.log('  2. Completar `expect` en cada turno, con payload en TRIAJE_* y NOMBRE_PADRE.');
    console.log('  3. Marcar `clinical: true` donde aplique la regla clínica.');
    console.log('  4. Poner "_labeled": true en cada conversación revisada.');
    console.log('  5. Confirmar que eval/gold/ está en .gitignore.');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    // Tres salidas distintas, porque llevan a acciones distintas:
    //   exit 2 — ERROR DE ENTORNO: no hay dataset. Arreglás las vistas.
    //   exit 1 — cualquier otro fallo de la extracción.
    //   exit 0 — hubo dataset; el veredicto del modelo se decide después, en run.js.
    if (err instanceof EnvironmentError) {
      console.error('\n⛔ ERROR DE ENTORNO — la extracción no corrió.\n');
      console.error(err.informe);   // sanitizado por construcción, ver EnvironmentError
      console.error('\nEsto NO es un gate bloqueado ni un modelo que no pasa: no hay dataset.');
      process.exit(2);
    }
    // NUNCA `console.error(err)` ni `err.message` crudo. Un error de `pg` lleva
    // .detail, .hint, .where, .query e .internalQuery, y cualquiera de esos puede
    // contener texto de conversaciones de pacientes.
    const limpio = sanitizarError(err);
    console.error(limpio.stack);
    if (limpio.tenia_cause) console.error('(el error tenía una causa anidada; se omite por contener datos sin sanitizar)');
    process.exit(1);
  });
}

module.exports = { fetchRows, fetchFrequencies, suggestExpectations };
