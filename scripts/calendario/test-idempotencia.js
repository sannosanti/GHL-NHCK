// Verifica la garantía de idempotencia contra la base real, con un ID sintético
// que se borra al final. El DDL es el mismo CREATE TABLE IF NOT EXISTS que la app
// corre al arrancar, así que no agrega nada que el deploy no fuera a crear igual.
const db = require('../../db');
const { Pool } = require('pg');

const ID = 'TEST-IDEMPOTENCIA-' + Date.now();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let fallos = 0;
function chequear(desc, real, esperado) {
  const ok = real === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}  (esperado ${esperado}, real ${real})`);
}

(async () => {
  await db.initDB();

  chequear('primer disparo reclama',            await db.reclamarCitaZoho(ID, 'cita'), true);
  chequear('segundo disparo NO reclama',        await db.reclamarCitaZoho(ID, 'cita'), false);
  chequear('tercer disparo NO reclama',         await db.reclamarCitaZoho(ID, 'cita'), false);

  // Dos disparos simultáneos: el INSERT atómico debe dejar pasar exactamente uno.
  const ID2 = ID + '-CARRERA';
  const carrera = await Promise.all([
    db.reclamarCitaZoho(ID2, 'cita'), db.reclamarCitaZoho(ID2, 'cita'),
    db.reclamarCitaZoho(ID2, 'cita'), db.reclamarCitaZoho(ID2, 'cita'),
  ]);
  chequear('de 4 disparos simultáneos gana 1', carrera.filter(Boolean).length, 1);

  // Confirmada la creación, liberar no debe borrar la marca.
  await db.confirmarCitaZoho(ID, 'evt-falso', 'cal-falso');
  await db.liberarCitaZoho(ID);
  chequear('confirmada, liberar no la suelta',  await db.reclamarCitaZoho(ID, 'cita'), false);

  // Sin confirmar, liberar sí debe permitir el reintento.
  const ID3 = ID + '-FALLIDA';
  await db.reclamarCitaZoho(ID3, 'cita');
  await db.liberarCitaZoho(ID3);
  chequear('sin confirmar, liberar permite reintento', await db.reclamarCitaZoho(ID3, 'cita'), true);

  // Sin ID de Zoho no hay deduplicación posible: nunca debe bloquear el sync.
  chequear('sin ID no bloquea',                 await db.reclamarCitaZoho('', 'cita'), true);

  const { rows } = await pool.query(`DELETE FROM citas_sync WHERE zoho_cita_id LIKE 'TEST-IDEMPOTENCIA-%' RETURNING zoho_cita_id`);
  console.log(`\nlimpieza: ${rows.length} filas de prueba borradas`);
  await pool.end();
  console.log(fallos ? `\n${fallos} FALLOS` : '\nTODO OK');
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
