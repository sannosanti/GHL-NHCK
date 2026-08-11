// Barrido de puesta al día. Compara lo que Zoho tiene HOY contra lo que quedó
// espejado en GHL y corrige las diferencias de horario y de calendario.
//
// Los cambios hechos en Zoho antes de que existiera la propagación no llegaron
// nunca: reprogramaciones, cambios de profesional, cancelaciones. Este barrido
// los alcanza a todos de una vez.
//
// La comparación se hace contra citas_sync, que guarda el horario del último
// espejado. Eso vuelve el recorrido barato: sólo se llama a GHL por las que de
// verdad cambiaron, no por las 1900.
//
//   node scripts/calendario/resincronizar.js 2026-07-01 2026-12-31            (dry run)
//   node scripts/calendario/resincronizar.js 2026-07-01 2026-12-31 --aplicar
const db = require('../../db');
const zoho = require('../../services/zoho');
const ghl = require('../../services/ghl');
const { parseZohoDateTime } = require('../../webhooks/zoho');

const CALENDARIOS = {
  '3572150000004930155': 'MvnOMgGMs69y6Ewix22r', '3572150000005140253': 'iTdbaauOdCrcNHwsIe2h',
  '3572150000004871148': 'M1fNQqz0yn8LH1op8I4s', '3572150000009238003': 'pLhcRJMTzeTjhrv8dqDY',
  '3572150000004912180': 'vvb8taavISxlgeGoXd78', '3572150000004826082': '5OHWEK3t2Wvg1xc9tsRv',
  '3572150000004871136': 'hsHuxGh5wLknUFxWt0Sk', '3572150000013136002': 'wRUCuDmqhbxmU3rvgG5j',
  '3572150000004871160': 'kzPKbuB2npt64tyXuFnx', '3572150000006479156': 'SAjr7SxN1h0biqbiprV1',
};
const CALENDAR_GENERAL = 'lzwahRhkogIG1Ct9BX7p';

const aplicar = process.argv.includes('--aplicar');
const PAUSA = 350;
const CORTE_FALLOS = 5;
const dormir = ms => new Promise(r => setTimeout(r, ms));

// Los bloqueos no tienen GET individual, así que para recuperar el original se
// lista el calendario de origen alrededor de su fecha y se busca por id. Sin
// esto el PUT los renombraría con el Tipo de Zoho ("Bloqueo", "Salida") y se
// perdería lo que la clínica escribió.
async function bloqueoOriginal(eventId, calendarId, inicioISO) {
  const centro = Date.parse(inicioISO);
  const url = `https://services.leadconnectorhq.com/calendars/blocked-slots`
    + `?locationId=${process.env.GHL_LOCATION_ID}&calendarId=${calendarId}`
    + `&startTime=${centro - 24 * 3600 * 1000}&endTime=${centro + 24 * 3600 * 1000}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-04-15' } });
  if (!r.ok) throw new Error(`listado de bloqueos ${r.status}`);
  const d = await r.json();
  const b = (d.events || d.blockedSlots || []).find(x => x.id === eventId);
  if (!b) throw new Error('el bloqueo ya no está en su calendario de origen');
  return b;
}

(async () => {
  const desdeISO = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : '2026-07-01';
  const hastaISO = process.argv[3] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3]) ? process.argv[3] : '2026-12-31';
  const desde = Date.parse(`${desdeISO}T00:00:00Z`), hasta = Date.parse(`${hastaISO}T23:59:59Z`);

  await zoho.getZohoAccessToken();
  if (!(await zoho.getDisponibilidad(desdeISO)).length &&
      !(await zoho.getDisponibilidad(new Date(desde + 86400000).toISOString().slice(0, 10))).length) {
    console.error('\nABORTADO: Zoho no devolvió citas en los dos primeros días. Casi seguro rate limit.');
    process.exit(1);
  }

  const { rows } = await db.pool.query('SELECT zoho_cita_id, ghl_event_id, calendar_id, clase, inicio, fin FROM citas_sync WHERE ghl_event_id IS NOT NULL');
  const espejado = new Map(rows.map(r => [r.zoho_cita_id, r]));
  console.error(`espejadas conocidas: ${espejado.size}`);

  const cambios = [], sinEspejar = [];
  let revisadas = 0;
  for (let t = desde; t <= hasta; t += 86400000) {
    for (const c of await zoho.getDisponibilidad(new Date(t).toISOString().slice(0, 10))) {
      const prev = espejado.get(c.ID);
      if (!prev) { if (c.Contacto?.display_value) sinEspejar.push({ zohoID: c.ID, inicio: c.Inicio, contacto: c.Contacto.display_value }); continue; }
      revisadas++;

      const calDestino = CALENDARIOS[c.Consultor?.ID || ''] || CALENDAR_GENERAL;
      const diffs = [];
      // Sólo se compara contra lo que se guardó. Una fila sin horario previo es
      // de antes de que se registrara, y se completa sin tocar GHL: el próximo
      // barrido ya la va a poder comparar.
      if (prev.inicio && prev.inicio !== c.Inicio) diffs.push(`inicio ${prev.inicio} -> ${c.Inicio}`);
      if (prev.fin && prev.fin !== c.Fin) diffs.push(`fin ${prev.fin} -> ${c.Fin}`);
      if (prev.calendar_id && prev.calendar_id !== calDestino) diffs.push(`calendario ${prev.calendar_id} -> ${calDestino}`);
      if (!diffs.length) continue;

      cambios.push({
        zohoID: c.ID, eventId: prev.ghl_event_id, clase: prev.clase,
        calendarId: calDestino, inicio: c.Inicio, fin: c.Fin,
        startISO: parseZohoDateTime(c.Inicio), endISO: parseZohoDateTime(c.Fin),
        inicioPrevioISO: prev.inicio ? parseZohoDateTime(prev.inicio) : null,
        calendarPrevio: prev.calendar_id,
        contacto: c.Contacto?.display_value || `(${c.Tipo})`,
        sinHorarioPrevio: !prev.inicio || !prev.fin,
        diffs,
      });
    }
  }

  console.log(`\nRANGO ${desdeISO} .. ${hastaISO}\n`);
  console.log(`  revisadas contra Zoho     : ${revisadas}`);
  console.log(`  DESACTUALIZADAS en GHL    : ${cambios.length}`);
  console.log(`  citas de Zoho sin espejar : ${sinEspejar.length}   (se crean con crear-faltantes.js)`);
  for (const c of cambios.slice(0, 40)) {
    console.log(`      ${c.contacto.slice(0, 32).padEnd(34)} ${c.diffs.join(' | ')}${c.sinHorarioPrevio ? '   [sin horario previo: se confirma contra GHL antes de mover]' : ''}`);
  }
  if (cambios.length > 40) console.log(`      ... y ${cambios.length - 40} más`);

  if (!aplicar) {
    console.log('\nDRY RUN — nada se modificó. Volvé a correr con --aplicar.');
    await db.pool.end();
    return;
  }

  let ok = 0, fallos = 0, completadas = 0, seguidilla = 0;
  for (const [i, c] of cambios.entries()) {
    const prefijo = `[${String(i + 1).padStart(4)}/${cambios.length}]`;
    try {
      if (!c.startISO || !c.endISO) throw new Error(`horario ilegible en Zoho: "${c.inicio}" -> "${c.fin}"`);

      // El evento vivo se lee siempre: para las citas porque el PUT reemplaza y
      // hay que reenviar título, estado y descripción tal cual; para los
      // bloqueos porque su título no está en ningún otro lado.
      const actual = c.clase === 'bloqueo'
        ? await bloqueoOriginal(c.eventId, c.calendarPrevio, c.inicioPrevioISO || c.startISO)
        : await ghl.getCitaEnCalendario(c.eventId);
      await dormir(PAUSA);

      // Sin horario previo la diferencia contra citas_sync no prueba nada: la
      // fila puede ser vieja y GHL estar bien. Lo que sí prueba algo es el
      // evento en vivo, así que se compara contra él antes de mover nada.
      if (c.sinHorarioPrevio &&
          Date.parse(actual.startTime) === Date.parse(c.startISO) &&
          Date.parse(actual.endTime) === Date.parse(c.endISO) &&
          (!c.calendarPrevio || c.calendarPrevio === c.calendarId)) {
        await db.confirmarCitaZoho(c.zohoID, c.eventId, c.calendarId, c.inicio, c.fin);
        completadas++;
        console.log(`${prefijo} YA OK      ${c.contacto.slice(0, 30).padEnd(32)} GHL ya coincidía; sólo se registró`);
        continue;
      }

      if (c.clase === 'bloqueo') {
        await ghl.actualizarBloqueoEnCalendario({
          eventId: c.eventId, calendarId: c.calendarId, startISO: c.startISO, endISO: c.endISO,
          title: actual.title,
        });
      } else {
        await ghl.actualizarCitaEnCalendario({
          eventId: c.eventId, calendarId: c.calendarId, startISO: c.startISO, endISO: c.endISO,
          title: actual?.title, appointmentStatus: actual?.appointmentStatus, description: actual?.description,
        });
      }
      await db.confirmarCitaZoho(c.zohoID, c.eventId, c.calendarId, c.inicio, c.fin);
      ok++; seguidilla = 0;
      console.log(`${prefijo} ACTUALIZADA ${c.contacto.slice(0, 30).padEnd(32)} ${c.diffs.join(' | ')}`);
      await dormir(PAUSA);
    } catch (err) {
      fallos++; seguidilla++;
      console.error(`${prefijo} FALLO ${c.contacto} — ${err.message}`);
      if (seguidilla >= CORTE_FALLOS) {
        console.error(`\nABORTADO: ${CORTE_FALLOS} fallos seguidos. Actualizadas: ${ok}.`);
        await db.pool.end();
        process.exit(1);
      }
      await dormir(PAUSA * 3);
    }
  }

  console.log(`\n--- RESUMEN ---\nactualizadas: ${ok}\nya coincidían en GHL: ${completadas}\nfallidas: ${fallos}`);
  if (fallos) console.log('Volvé a correr para reintentar: lo ya corregido no vuelve a aparecer.');
  await db.pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
