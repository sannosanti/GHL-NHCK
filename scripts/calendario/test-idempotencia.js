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

  // Detección de reprogramación: el horario espejado queda guardado, así que un
  // disparo posterior puede compararse contra la base sin llamar a GHL.
  const ID4 = ID + '-REPROGRAMA';
  await db.reclamarCitaZoho(ID4, 'cita');
  await db.confirmarCitaZoho(ID4, 'evt-1', 'cal-A', '11-Aug-2026 17:00:00', '11-Aug-2026 18:00:00');
  const guardado = await db.getCitaSync(ID4);
  chequear('guarda el evento espejado',         guardado?.ghl_event_id, 'evt-1');
  chequear('guarda el inicio',                  guardado?.inicio, '11-Aug-2026 17:00:00');
  chequear('guarda el fin',                     guardado?.fin, '11-Aug-2026 18:00:00');
  chequear('mismo horario = sin cambios',       guardado.inicio === '11-Aug-2026 17:00:00', true);
  chequear('otro horario = hay cambio',         guardado.inicio !== '11-Aug-2026 19:00:00', true);

  // Tras propagar la reprogramación, la base refleja el horario nuevo y el
  // evento sigue siendo el mismo — se movió, no se duplicó.
  await db.confirmarCitaZoho(ID4, 'evt-1', 'cal-B', '11-Aug-2026 19:00:00', '11-Aug-2026 20:00:00');
  const tras = await db.getCitaSync(ID4);
  chequear('tras reprogramar, inicio nuevo',    tras?.inicio, '11-Aug-2026 19:00:00');
  chequear('tras reprogramar, calendario nuevo', tras?.calendar_id, 'cal-B');
  chequear('tras reprogramar, mismo evento',    tras?.ghl_event_id, 'evt-1');

  chequear('ID inexistente devuelve null',      await db.getCitaSync('NO-EXISTE-' + Date.now()), null);

  const { rows } = await pool.query(`DELETE FROM citas_sync WHERE zoho_cita_id LIKE 'TEST-IDEMPOTENCIA-%' RETURNING zoho_cita_id`);
  console.log(`\nlimpieza: ${rows.length} filas de prueba borradas`);
  await pool.end();
  console.log(fallos ? `\n${fallos} FALLOS` : '\nTODO OK');
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
