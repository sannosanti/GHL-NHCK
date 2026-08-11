// Trae el campo Observaciones de Zoho al "Appointment description" de GHL.
//
// El webhook sólo lo escribe al crear una cita nueva, así que todo lo que entró
// por la migración del histórico quedó sin descripción, y el barrido de fechas
// (resincronizar.js) la preserva pero nunca la rellena. Este script cierra ese
// hueco.
//
// Va aparte del barrido a propósito: citas_sync no guarda la descripción, así
// que comparar obliga a leer cada cita en GHL. Son ~1200 lecturas de una sola
// vez; meterlas en el barrido de fechas lo volvería lento para siempre.
//
// Regla: Zoho manda para LLENAR, no para VACIAR. Si Observaciones viene vacío se
// deja intacto lo que haya en GHL, que puede haberlo escrito una persona.
//
// Las Observaciones son notas clínicas: nunca se imprimen ni se registran. El
// log dice cuántos caracteres cambian, jamás qué dicen.
//
//   node scripts/calendario/sincronizar-descripciones.js 2026-07-01 2026-12-31
//   node scripts/calendario/sincronizar-descripciones.js 2026-07-01 2026-12-31 --aplicar
const db = require('../../db');
const zoho = require('../../services/zoho');
const ghl = require('../../services/ghl');

const aplicar = process.argv.includes('--aplicar');
const PAUSA = 350;
const CORTE_FALLOS = 5;
const dormir = ms => new Promise(r => setTimeout(r, ms));

// GHL y Zoho difieren en saltos de línea y espacios de sobra; comparar en crudo
// marcaría como distintas descripciones que dicen exactamente lo mismo.
const normalizar = s => String(s ?? '').replace(/\r\n/g, '\n').trim();

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

  const { rows } = await db.pool.query(
    `SELECT zoho_cita_id, ghl_event_id FROM citas_sync
     WHERE ghl_event_id IS NOT NULL AND (clase IS NULL OR clase <> 'bloqueo')`
  );
  const espejado = new Map(rows.map(r => [r.zoho_cita_id, r.ghl_event_id]));
  console.error(`citas espejadas: ${espejado.size}`);

  // Primero se junta todo lo que Zoho tiene con observaciones. Recién después se
  // consulta GHL, y sólo por esas: las citas sin observaciones no dan trabajo.
  const candidatas = [];
  for (let t = desde; t <= hasta; t += 86400000) {
    for (const c of await zoho.getDisponibilidad(new Date(t).toISOString().slice(0, 10))) {
      const eventId = espejado.get(c.ID);
      const obs = normalizar(c.Observaciones);
      if (!eventId || !obs) continue;
      candidatas.push({ zohoID: c.ID, eventId, obs, contacto: c.Contacto?.display_value || `(${c.Tipo})`, inicio: c.Inicio });
    }
  }
  console.log(`\nRANGO ${desdeISO} .. ${hastaISO}`);
  console.log(`citas de Zoho con observaciones: ${candidatas.length}\n`);

  let faltantes = 0, distintas = 0, iguales = 0, fallosLectura = 0, escritas = 0, seguidilla = 0;
  for (const [i, c] of candidatas.entries()) {
    const prefijo = `[${String(i + 1).padStart(4)}/${candidatas.length}]`;
    try {
      const actual = await ghl.getCitaEnCalendario(c.eventId);
      await dormir(PAUSA);
      const enGHL = normalizar(actual?.description);
      if (enGHL === c.obs) { iguales++; continue; }

      // Sólo se cuentan caracteres. El contenido es historia clínica y no se
      // imprime ni acá ni en ningún log.
      const etiqueta = enGHL ? `${enGHL.length} car. distintos -> ${c.obs.length}` : `vacía -> ${c.obs.length} car.`;
      if (enGHL) distintas++; else faltantes++;
      console.log(`${prefijo} ${aplicar ? 'ESCRIBIENDO' : 'PENDIENTE  '} ${c.inicio.slice(0, 11)} ${c.contacto.slice(0, 28).padEnd(30)} ${etiqueta}`);

      if (!aplicar) continue;

      // El PUT reemplaza el recurso entero: horario, título y estado se reenvían
      // tal cual estaban. El horario correcto lo fija resincronizar.js, no este
      // script, así que acá se respeta lo que ya hay.
      await ghl.actualizarCitaEnCalendario({
        eventId: c.eventId, calendarId: actual.calendarId,
        startISO: actual.startTime, endISO: actual.endTime,
        title: actual.title, appointmentStatus: actual.appointmentStatus,
        description: c.obs,
      });
      escritas++; seguidilla = 0;
      await dormir(PAUSA);
    } catch (err) {
      fallosLectura++; seguidilla++;
      console.error(`${prefijo} FALLO ${c.contacto} — ${err.message}`);
      if (seguidilla >= CORTE_FALLOS) {
        console.error(`\nABORTADO: ${CORTE_FALLOS} fallos seguidos. Escritas: ${escritas}.`);
        await db.pool.end();
        process.exit(1);
      }
      await dormir(PAUSA * 3);
    }
  }

  console.log('\n--- RESUMEN ---');
  console.log(`ya coincidían       : ${iguales}`);
  console.log(`sin descripción     : ${faltantes}`);
  console.log(`con texto distinto  : ${distintas}`);
  console.log(`fallos              : ${fallosLectura}`);
  if (aplicar) console.log(`escritas en GHL     : ${escritas}`);
  else console.log('\nDRY RUN — nada se modificó. Volvé a correr con --aplicar.');
  await db.pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
