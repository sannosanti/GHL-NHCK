// Lista las citas que se archivaron mal mientras Zoho no respondía. Cuando el
// lookup del Consultor falla, el webhook las manda al calendario general; y si
// además falla el lookup del contacto, las crea como BLOQUEO en vez de cita, o
// sea sin paciente asociado y sin recordatorio.
//
// Sale todo de citas_sync: no gasta cuota de Zoho.
//
//   node scripts/calendario/danos-del-corte.js 2026-08-20
const db = require('../../db');
const CALENDAR_GENERAL = 'lzwahRhkogIG1Ct9BX7p';

(async () => {
  const dia = process.argv[2] || new Date().toISOString().slice(0, 10);
  const { rows } = await db.pool.query(
    `SELECT zoho_cita_id, ghl_event_id, clase, inicio, fin,
            to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota','HH24:MI') AS hora
     FROM citas_sync
     WHERE created_at::date = $1::date AND calendar_id = $2
     ORDER BY created_at`, [dia, CALENDAR_GENERAL]);

  console.log(`Registradas en CALENDAR_GENERAL el ${dia}: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`  ${r.hora}  ${String(r.clase).padEnd(8)} cita ${r.inicio || '(sin inicio)'}  zoho ${r.zoho_cita_id}  evento ${r.ghl_event_id}`);
  }
  const bloqueos = rows.filter(r => r.clase === 'bloqueo').length;
  if (rows.length) {
    console.log(`\n  como bloqueo (sin paciente): ${bloqueos}`);
    console.log(`  como cita                  : ${rows.length - bloqueos}`);
  }
  await db.pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
