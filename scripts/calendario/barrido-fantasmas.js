'use strict';

// Barrido de citas fantasma: eventos vivos en GHL cuyo registro de Zoho ya no
// existe.
//
// POR QUE HACE FALTA. La sincronizacion Zoho -> GHL viaja por avisos: creacion,
// modificacion y los botones de estado. Un BORRADO no tiene por donde viajar,
// porque al borrarse el registro desaparece lo unico que podria avisarnos. El
// evento queda vivo en GHL, ocupa la franja, y el workflow de recordatorios le
// manda al paciente un mensaje por una cita que no existe. Paso el 28/10 con un
// paciente que recibio dos recordatorios con horas distintas.
//
// QUE HACE. Lee las citas de Zoho del rango, arma el conjunto de IDs que siguen
// existiendo, y marca como fantasma toda fila de citas_sync cuya cita futura
// apunte a un ID que ya no esta.
//
// Por defecto NO escribe. Con --cancelar pone el evento en 'cancelled' en vez
// de borrarlo: cancelar deja rastro en la agenda y es reversible; borrar no.
const fs = require('fs');
const path = require('path');
const db = require('../../db');
const ghl = require('../../services/ghl');
const zoho = require('../../services/zoho');

const CANCELAR = process.argv.includes('--cancelar');
const DIAS = Number((process.argv.find((a) => a.startsWith('--dias=')) || '--dias=45').split('=')[1]);

const MESES_ZOHO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dos = (n) => String(n).padStart(2, '0');
const aZoho = (d) => `${dos(d.getDate())}-${MESES_ZOHO[d.getMonth()]}-${d.getFullYear()}`;

// Zoho pagina de a 200. Se recorre dia por dia para no toparse con el tope en
// un rango largo y para que un fallo puntual no invalide todo el barrido.
async function idsDeZoho(desde, dias) {
  const tok = await zoho.getZohoAccessToken();
  const vivos = new Set();
  let diasLeidos = 0;
  for (let i = 0; i < dias; i++) {
    const d = new Date(desde.getTime() + i * 86400000);
    const crit = `Inicio >= "${aZoho(d)} 00:00:00" && Inicio <= "${aZoho(d)} 23:59:59"`;
    const url = `https://creator.zoho.com/api/v2/visionintegralceo/calendario/report/Citas_Report`
      + `?criteria=${encodeURIComponent(crit)}&max_records=200`;
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${tok}` } });
    if (r.status === 404) { diasLeidos++; continue; }   // 404 = sin registros ese dia
    if (!r.ok) {
      // Un dia que no se pudo leer NO puede tratarse como "sin citas": cada
      // registro de ese dia pareceria borrado y se cancelarian citas reales.
      throw new Error(`Zoho respondio HTTP ${r.status} para ${aZoho(d)} — se aborta el barrido`);
    }
    const j = await r.json();
    for (const c of (j.data || [])) vivos.add(String(c.ID));
    diasLeidos++;
    await new Promise((res) => setTimeout(res, 150));
  }
  return { vivos, diasLeidos };
}

(async () => {
  console.log(CANCELAR ? '=== BARRIDO REAL (cancela en GHL)' : '=== SIMULACRO (no escribe). Pasá --cancelar para aplicar.');
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  console.log(`leyendo ${DIAS} dias de Zoho desde ${aZoho(hoy)}...`);
  const { vivos, diasLeidos } = await idsDeZoho(hoy, DIAS);
  console.log(`   dias leidos: ${diasLeidos} | citas vivas en Zoho: ${vivos.size}`);

  // Solo citas de paciente: un bloqueo no tiene contacto ni manda recordatorio,
  // asi que un bloqueo huerfano no le llega a nadie.
  const q = await db.pool.query(`
    SELECT zoho_cita_id, ghl_event_id, calendar_id, inicio, fin, clase
    FROM citas_sync
    WHERE ghl_event_id IS NOT NULL
      AND clase = 'cita'
      AND to_timestamp(inicio, 'DD-Mon-YYYY HH24:MI:SS') >= now()::date
      AND to_timestamp(inicio, 'DD-Mon-YYYY HH24:MI:SS') < now()::date + $1::int
    ORDER BY to_timestamp(inicio, 'DD-Mon-YYYY HH24:MI:SS')`, [DIAS]);

  console.log(`   citas futuras espejadas en GHL: ${q.rows.length}`);

  const fantasmas = q.rows.filter((r) => !vivos.has(String(r.zoho_cita_id)));
  console.log(`\n=== FANTASMAS: ${fantasmas.length}`);
  for (const f of fantasmas) {
    console.log(`   ${f.inicio}  zoho ${f.zoho_cita_id}  ghl ${f.ghl_event_id}`);
  }
  if (!fantasmas.length) { console.log('   nada que hacer'); process.exit(0); }

  if (!CANCELAR) {
    console.log('\n(simulacro: no se cancelo ninguna)');
    process.exit(0);
  }

  let ok = 0, fallos = 0;
  for (const f of fantasmas) {
    try {
      // Se relee el evento para no pisar su calendario, titulo ni contacto: el
      // PUT de GHL reemplaza el recurso entero.
      const actual = await ghl.getCitaEnCalendario(f.ghl_event_id);
      if (!actual) { console.log(`   ${f.ghl_event_id}: ya no esta en GHL`); await db.pool.query('DELETE FROM citas_sync WHERE ghl_event_id=$1', [f.ghl_event_id]); ok++; continue; }
      const r = await ghl.actualizarCitaEnCalendario({
        eventId: f.ghl_event_id,
        calendarId: actual.calendarId,
        contactId: actual.contactId,
        startISO: actual.startTime,
        endISO: actual.endTime,
        title: actual.title,
        description: actual.notes || actual.description || '',
        appointmentStatus: 'cancelled',
      });
      if (r === false) throw new Error('GHL rechazo la actualizacion');
      await db.pool.query('DELETE FROM citas_sync WHERE ghl_event_id=$1', [f.ghl_event_id]);
      await db.logEvent(actual.contactId || null, null, 'cita_fantasma_cancelada',
        { ghl_event_id: f.ghl_event_id, zoho_cita_id: f.zoho_cita_id, inicio: f.inicio }).catch(() => {});
      console.log(`   cancelada ${f.ghl_event_id} (${f.inicio})`);
      ok++;
    } catch (err) {
      console.error(`   FALLO ${f.ghl_event_id}: ${err.message}`);
      fallos++;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  console.log(`\ncanceladas: ${ok} | fallos: ${fallos}`);
  process.exit(0);
})();
