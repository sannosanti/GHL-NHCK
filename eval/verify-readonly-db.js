'use strict';

/**
 * Proves the evaluation database role is read-only AT THE PERMISSION LEVEL.
 *
 *   node eval/verify-readonly-db.js
 *
 * Attempts writes and expects every one of them to be refused by PostgreSQL. A
 * code convention ("we only wrote SELECTs") is a claim about today's code; a
 * refused INSERT is a property of the server.
 *
 * Uses EVAL_DATABASE_URL, never DATABASE_URL — preflight.js aborts if the
 * production connection string is in the environment at all.
 */

const { Client } = require('pg');
// Los errores de PostgreSQL pueden traer valores de fila en .message, .detail y
// .query. Nada se imprime sin pasar por acá.
const { sanitizarError } = require('./extract-lib');

const URL = process.env.EVAL_DATABASE_URL;

const PRUEBAS = [
  {
    nombre: 'INSERT en conversations es rechazado',
    sql: "INSERT INTO conversations (conversation_id, agent) VALUES ('eval-probe', 'eval-probe')",
  },
  {
    nombre: 'UPDATE en conversations es rechazado',
    sql: "UPDATE conversations SET estado = 'eval-probe' WHERE conversation_id = 'no-existe'",
  },
  {
    nombre: 'DELETE en conversations es rechazado',
    sql: "DELETE FROM conversations WHERE conversation_id = 'no-existe'",
  },
  {
    nombre: 'CREATE TABLE es rechazado',
    sql: 'CREATE TABLE eval_probe (id int)',
  },
  {
    nombre: 'SELECT sobre pending_payments es rechazado (datos de pago)',
    sql: 'SELECT 1 FROM pending_payments LIMIT 1',
  },
];

async function main() {
  if (!URL) {
    console.error('⛔ Falta EVAL_DATABASE_URL. Creá el rol con eval/readonly-role.sql.');
    process.exit(1);
  }
  if (process.env.DATABASE_URL) {
    console.error('⛔ DATABASE_URL (producción, con escritura) está en el entorno. Sacala antes de continuar.');
    process.exit(1);
  }

  const client = new Client({ connectionString: URL });
  await client.connect();

  let fallos = 0;

  const who = await client.query('SELECT current_user, current_setting($1, true) AS ro', ['default_transaction_read_only']);
  console.log(`Usuario: ${who.rows[0].current_user} · default_transaction_read_only = ${who.rows[0].ro}`);
  if (who.rows[0].ro !== 'on') {
    console.log('  FAIL la sesión no es de solo lectura por defecto');
    fallos++;
  } else {
    console.log('  ok   la sesión es de solo lectura por defecto');
  }

  for (const p of PRUEBAS) {
    try {
      await client.query(p.sql);
      console.log(`  FAIL ${p.nombre} — LA ESCRITURA FUE ACEPTADA`);
      fallos++;
    } catch (err) {
      const esperado = /read-only|permission denied|must be owner|no existe la relación|does not exist/i.test(err.message);
      console.log(`  ${esperado ? 'ok  ' : 'FAIL'} ${p.nombre}${esperado ? '' : ` — rechazado por otro motivo: ${sanitizarError(err).message}`}`);
      if (!esperado) fallos++;
    }
  }

  try {
    const r = await client.query('SELECT count(*)::int AS n FROM conversations');
    console.log(`  ok   SELECT sobre conversations funciona (${r.rows[0].n} filas)`);
  } catch (err) {
    console.log(`  FAIL SELECT sobre conversations falla: ${sanitizarError(err).message}`);
    fallos++;
  }

  // --- La vista eval_pending_flag -------------------------------------------
  // Una vista con derechos del propietario es acceso indirecto a la tabla base.
  // Se verifica qué expone, que el rol no la pueda modificar, y que no abra la
  // tabla por otro camino.
  console.log('\nVista eval_pending_flag:');

  try {
    const cols = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'eval_pending_flag' ORDER BY ordinal_position`);
    const nombres = cols.rows.map(c => c.column_name);
    const esperado = ['contact_id', 'has_pending'];
    if (JSON.stringify(nombres) === JSON.stringify(esperado)) {
      console.log(`  ok   expone exactamente ${esperado.join(', ')} — nada más`);
    } else {
      console.log(`  FAIL expone [${nombres.join(', ')}]; se esperaba [${esperado.join(', ')}]`);
      fallos++;
    }
    const boolCol = cols.rows.find(c => c.column_name === 'has_pending');
    if (boolCol && boolCol.data_type === 'boolean') console.log('  ok   has_pending es booleano');
    else { console.log(`  FAIL has_pending es ${boolCol?.data_type}`); fallos++; }
  } catch (err) {
    console.log(`  FAIL no se pudo inspeccionar la vista: ${sanitizarError(err).message}`);
    fallos++;
  }

  try {
    await client.query('SELECT contact_id, has_pending FROM eval_pending_flag LIMIT 1');
    console.log('  ok   el rol puede leer la vista');
  } catch (err) {
    console.log(`  FAIL el rol no puede leer la vista: ${sanitizarError(err).message}`);
    fallos++;
  }

  for (const p of [
    { nombre: 'el rol NO puede modificar la vista', sql: 'ALTER VIEW eval_pending_flag RENAME TO eval_probe' },
    { nombre: 'el rol NO puede borrar la vista', sql: 'DROP VIEW eval_pending_flag' },
    { nombre: 'el rol NO puede crear una vista que abra la tabla base', sql: 'CREATE VIEW eval_fuga AS SELECT * FROM pending_payments' },
    { nombre: 'el rol NO puede crear una función SECURITY DEFINER', sql: "CREATE FUNCTION eval_fuga_fn() RETURNS int AS 'SELECT 1' LANGUAGE sql SECURITY DEFINER" },
  ]) {
    try {
      await client.query(p.sql);
      console.log(`  FAIL ${p.nombre} — LA OPERACIÓN FUE ACEPTADA`);
      fallos++;
    } catch (err) {
      const esperado = /permission denied|must be owner|read-only|no existe|does not exist/i.test(err.message);
      console.log(`  ${esperado ? 'ok  ' : 'FAIL'} ${p.nombre}${esperado ? '' : ` — rechazado por otro motivo: ${sanitizarError(err).message}`}`);
      if (!esperado) fallos++;
    }
  }

  await client.end();
  console.log(fallos === 0
    ? '\n✓ El rol es de solo lectura a nivel de permisos.'
    : `\n⛔ ${fallos} verificación(es) fallaron. NO conectes la evaluación a esta base.`);
  process.exit(fallos ? 1 : 0);
}

main().catch(err => { console.error(sanitizarError(err).stack); process.exit(1); });
