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

  const cambios = [], sinEspejar = [], vistos = new Set(), diasIlegibles = [];
  let revisadas = 0;

  // Un fallo suelto no puede matar un recorrido de 184 días, pero tampoco se
  // puede ignorar: si un día no se pudo leer, no se sabe qué había en él.
  const citasDelDia = async (dia) => {
    for (let intento = 1; intento <= 3; intento++) {
      try { return await zoho.getDisponibilidad(dia); }
      catch (err) {
        if (intento === 3) { diasIlegibles.push(`${dia}: ${err.message}`); return null; }
        await dormir(2000);
      }
    }
  };

  for (let t = desde; t <= hasta; t += 86400000) {
    const delDia = await citasDelDia(new Date(t).toISOString().slice(0, 10));
    if (delDia === null) continue;
    for (const c of delDia) {
      vistos.add(c.ID);
      const prev = espejado.get(c.ID);
      if (!prev) {
        if (c.Contacto?.display_value) sinEspejar.push({
          zohoID: c.ID, inicio: c.Inicio, fin: c.Fin, estado: c.Estado,
          contacto: c.Contacto.display_value,
          consultor: c.Consultor?.display_value || '(sin consultor)',
        });
        continue;
      }
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

  // La otra mitad del barrido. El reporte de Zoho no trae el campo Estado: una
  // cita cancelada simplemente deja de aparecer. Así que un registro que está en
  // citas_sync con fecha dentro del rango pero que Zoho ya no lista quedó vivo
  // en GHL sin respaldo. No se borra nada acá: sólo se reportan para revisar,
  // porque también caen en esta bolsa las reprogramadas fuera del rango.
  // REGLA DURA: con un solo día sin leer no se puede afirmar que algo "ya no
  // está en Zoho" — pudo estar justo en ese día. Decidir con datos incompletos
  // acá significa mandar a cuarentena la cita de un paciente que sí existe.
  const huerfanas = [];
  let sinFechaRegistrada = 0;
  for (const r of diasIlegibles.length ? [] : rows) {
    if (vistos.has(r.zoho_cita_id)) continue;
    if (!r.inicio) { sinFechaRegistrada++; continue; }
    const iso = parseZohoDateTime(r.inicio);
    const ms = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms) || ms < desde || ms > hasta) continue;
    huerfanas.push(r);
  }

  console.log(`\nRANGO ${desdeISO} .. ${hastaISO}\n`);
  console.log(`  revisadas contra Zoho     : ${revisadas}`);
  console.log(`  DESACTUALIZADAS en GHL    : ${cambios.length}`);
  console.log(`  citas de Zoho sin espejar : ${sinEspejar.length}   (se crean con crear-faltantes.js)`);
  if (diasIlegibles.length) {
    console.log('');
    console.log(`  ATENCIÓN: ${diasIlegibles.length} día(s) no se pudieron leer de Zoho.`);
    for (const d of diasIlegibles) console.log(`      ${d}`);
    console.log('  NO se calculan huérfanas: con días sin leer, "no está en Zoho" no se puede afirmar.');
    console.log('');
  }
  // El plan se guarda para que resolver-huerfanas.js no tenga que repetir el
  // recorrido de Zoho: son ~184 llamadas de la cuota diaria de la cuenta.
  if (huerfanas.length && !diasIlegibles.length) {
    require('fs').writeFileSync(
      require('path').join(__dirname, 'plan-huerfanas.json'),
      JSON.stringify({ generado: new Date().toISOString(), desdeISO, hastaISO, huerfanas }, null, 2)
    );
  }
  console.log(`  espejadas que Zoho ya no lista: ${huerfanas.length}   (canceladas o movidas fuera del rango — revisar a mano)`);
  if (sinFechaRegistrada) console.log(`  (${sinFechaRegistrada} filas de citas_sync sin fecha registrada, no ubicables)`);
  for (const c of cambios.slice(0, 40)) {
    console.log(`      ${c.contacto.slice(0, 32).padEnd(34)} ${c.diffs.join(' | ')}${c.sinHorarioPrevio ? '   [sin horario previo: se confirma contra GHL antes de mover]' : ''}`);
  }
  if (cambios.length > 40) console.log(`      ... y ${cambios.length - 40} más`);
  if (huerfanas.length) {
    console.log('\n  Espejadas que Zoho ya no lista (primeras 40):');
    for (const h of huerfanas) {
      // Se resuelve el evento en GHL para que la lista diga de quién es y en qué
      // estado quedó. Un id suelto no le sirve a nadie para decidir.
      let detalle = '';
      try {
        if (h.clase === 'bloqueo') {
          const b = await bloqueoOriginal(h.ghl_event_id, h.calendar_id, parseZohoDateTime(h.inicio));
          detalle = `"${b.title}"`;
        } else {
          const a = await ghl.getCitaEnCalendario(h.ghl_event_id);
          detalle = `"${a?.title}"  [${a?.appointmentStatus}]`;
        }
      } catch (err) {
        detalle = `<ya no está en GHL: ${err.message}>`;
      }
      console.log(`      ${String(h.inicio).padEnd(22)} ${String(h.clase).padEnd(8)} ${detalle}`);
      await dormir(PAUSA);
    }
  }
  if (sinEspejar.length) {
    console.log('\n  Sin espejar en GHL:');
    for (const s of sinEspejar) {
      console.log(`      ${s.inicio}  ${String(s.estado).padEnd(12)} ${s.contacto.slice(0, 30).padEnd(32)} ${s.consultor}`);
    }
  }

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

      // El evento vivo se lee siempre: el PUT reemplaza, así que título, estado y
      // descripción hay que reenviarlos tal cual o se pierden.
      const actual = await ghl.getCitaEnCalendario(c.eventId);
      await dormir(PAUSA);

      // La clase se decide por lo que GHL devuelve, NO por lo que dice
      // citas_sync. Un bloqueo no trae contactId ni appointmentStatus, y hay
      // filas marcadas como "cita" que en realidad apuntan a un bloqueo:
      // mandarles el PUT de cita da 400 "Appointment ContactId must be
      // provided". El evento es la verdad; la etiqueta guardada puede mentir.
      const esBloqueo = !actual?.contactId;

      // Sin horario previo la diferencia contra citas_sync no prueba nada: la
      // fila puede ser vieja y GHL estar bien. Lo que sí prueba algo es el
      // evento en vivo, así que se compara contra él antes de mover nada.
      if (esBloqueo !== (c.clase === 'bloqueo')) {
        console.warn(`${prefijo} AVISO ${c.contacto} — citas_sync dice "${c.clase}" pero GHL dice "${esBloqueo ? 'bloqueo' : 'cita'}"; manda GHL`);
      }

      if (c.sinHorarioPrevio &&
          Date.parse(actual.startTime) === Date.parse(c.startISO) &&
          Date.parse(actual.endTime) === Date.parse(c.endISO) &&
          (!c.calendarPrevio || c.calendarPrevio === c.calendarId)) {
        await db.confirmarCitaZoho(c.zohoID, c.eventId, c.calendarId, c.inicio, c.fin);
        completadas++;
        console.log(`${prefijo} YA OK      ${c.contacto.slice(0, 30).padEnd(32)} GHL ya coincidía; sólo se registró`);
        continue;
      }

      if (esBloqueo) {
        await ghl.actualizarBloqueoEnCalendario({
          eventId: c.eventId, calendarId: c.calendarId, startISO: c.startISO, endISO: c.endISO,
          title: actual.title,
        });
      } else {
        await ghl.actualizarCitaEnCalendario({
          eventId: c.eventId, calendarId: c.calendarId, startISO: c.startISO, endISO: c.endISO,
          title: actual?.title, appointmentStatus: actual?.appointmentStatus,
          description: actual?.description, contactId: actual?.contactId,
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
