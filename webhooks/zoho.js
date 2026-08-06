'use strict';

const zoho = require('../services/zoho');
const ghl = require('../services/ghl');
const db = require('../db');

// Dedicated GHL calendars for the Zoho -> GHL sync, one per real Zoho
// Consultor/resource — see engram ghl-nhck/sync-zoho-ghl-calendario. Kept
// deliberately separate from the personal calendars already in GHL. Both
// Carolina (NHCK) and Luisa (NHC) share this same Zoho calendar and GHL
// location, so this single webhook covers both brands.
// Zoho Consultor ID -> GHL calendar ID. Both sides audited live on 2026-08-04
// against the location's 19 calendars, so the comment names the GHL calendar the
// entry actually lands in — not the consultant it came from. They diverge: Juan
// Esteban Tamayo's citas go to "Pre-evaluación NHC" and the "Mapeos" resource to
// "Neuromapeo NHC", which read as mismatches until you know they are deliberate.
const CALENDARIOS = {
  '3572150000004930155': 'MvnOMgGMs69y6Ewix22r', // Juan Esteban Tamayo -> Pre-evaluación NHC
  '3572150000005140253': 'iTdbaauOdCrcNHwsIe2h', // Mapeos -> Neuromapeo NHC
  '3572150000004871148': 'M1fNQqz0yn8LH1op8I4s', // Neurotecnologías
  '3572150000009238003': 'pLhcRJMTzeTjhrv8dqDY', // Katerine Bolivar Uribe
  '3572150000004912180': 'vvb8taavISxlgeGoXd78', // Santiago Gallego (Asesorias y Cursos)
  '3572150000004826082': '5OHWEK3t2Wvg1xc9tsRv', // Yamile Herrera
  '3572150000004871136': 'hsHuxGh5wLknUFxWt0Sk', // Laura Franco Gómez
  '3572150000013136002': 'wRUCuDmqhbxmU3rvgG5j', // Juliana Restrepo Ruiz
  '3572150000004871160': 'kzPKbuB2npt64tyXuFnx', // David Valderrama Goez
  '3572150000006479156': 'SAjr7SxN1h0biqbiprV1', // Juliana Duque Rodriguez
};
// Fallback for entries with no Consultor (Bloqueo/Salida/Entrada/Descanso/
// Almuerzo/Festivo with nobody named) — same reasoning as the
// calcularSlotsLibres fix: a blockless entry still occupies real time and
// must show up somewhere in GHL, not be dropped.
const CALENDAR_GENERAL = 'lzwahRhkogIG1Ct9BX7p';

const MESES_ZOHO = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// Zoho Creator sends an unset lookup as the literal string "null" (or an empty
// string), never as JSON null. Those are truthy in JavaScript, so they sailed
// past `if (!contactoRef)` and reached getContactoPorId('null') — which is what
// produced the misleading "contacto sin celular, contactoID= null" in
// production on 2026-07-30. Normalizes both the object form ({ID, display_value})
// and the bare-string form into an ID, or '' when the field is genuinely empty.
const VALORES_VACIOS = new Set(['', 'null', 'undefined', 'none', '-none-']);

// GHL rejects a calendar title containing a line break with
// `422 Title must be a valid text`, and Zoho's Observaciones is a free-text
// field: it holds pasted Google Meet invitations, payment arrangements, whole
// paragraphs. This only became reachable once the sync started reading the
// record back from Citas_Report — before that Observaciones never arrived and
// every title was a bare "Cita". Found while migrating the historical blocks,
// where 10 of 271 were refused for exactly this.
//
// Flattening whitespace keeps the useful head of the note instead of losing the
// entry, and the cap keeps a pasted invitation from becoming the title.
const LARGO_MAXIMO_TITULO = 100;

function tituloGHL(partes, porDefecto = 'Bloqueo') {
  const texto = partes.filter(Boolean).join(' - ').replace(/\s+/g, ' ').trim();
  if (!texto) return porDefecto;
  return texto.length > LARGO_MAXIMO_TITULO ? `${texto.slice(0, LARGO_MAXIMO_TITULO - 3)}...` : texto;
}

function refZoho(campo) {
  const raw = campo && typeof campo === 'object' ? campo.ID : campo;
  const valor = String(raw ?? '').trim();
  return VALORES_VACIOS.has(valor.toLowerCase()) ? '' : valor;
}

// Zoho Creator datetime strings look like "03-Jul-2026 10:00:00" in Colombia
// local time (UTC-5, no DST). Converts to an ISO string in UTC.
function parseZohoDateTime(str) {
  const m = String(str || '').match(/(\d{2})-(\w{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mmm, yyyy, hh, min, ss] = m;
  const mes = MESES_ZOHO[mmm];
  if (mes === undefined) return null;
  return new Date(Date.UTC(+yyyy, mes, +dd, +hh + 5, +min, +ss)).toISOString();
}

/**
 * POST /webhook/zoho-cita
 * Fired by a Zoho Creator workflow webhook when a new "Citas" record is added.
 * Mirrors that entry into the GHL calendar for its Consultor. Entries with a
 * Contacto become a real appointment (linked to the matching GHL contact);
 * entries without one (blocks, breaks, closures) become a block-slot instead,
 * since GHL's appointment endpoint requires a contactId and block-slots don't.
 */
async function zohoCitaWebhookHandler(req, res) {
  res.json({ success: true, received: true });

  // Fuera del try para que el catch pueda soltar la reserva si la creación falló.
  let zohoCitaID = '';

  try {
    const b = req.body || {};

    // The Consultor -> calendar routing had never been observable: an unmapped
    // consultant and a genuine clinic-wide block both fell through the same
    // `|| CALENDAR_GENERAL` without a word in the logs. Confirmed in production
    // on 2026-07-30 that all ~30 citas of the day landed on CALENDAR_GENERAL and
    // not one reached a therapist's calendar — invisible until the client
    // noticed it in the GHL calendar view. Logs the routing fields only, never
    // Observaciones or Email: these logs are not a PHI store.
    console.log('ZOHO-CITA payload:', JSON.stringify({
      claves: Object.keys(b),
      Consultor: b.Consultor,
      Contacto: b.Contacto,
      Tipo: b.Tipo,
      Inicio: b.Inicio,
      Fin: b.Fin,
      ID: b.ID,
    }));

    const startISO = parseZohoDateTime(b.Inicio);
    const endISO = parseZohoDateTime(b.Fin);
    if (!startISO) { console.error('ZOHO-CITA: no se pudo interpretar Inicio:', b.Inicio); return; }

    const contactoRef = refZoho(b.Contacto);

    // The payload carries no Consultor, so the record is read back from
    // Citas_Report to recover it — see buscarCitaPorInicio in services/zoho.js.
    // Tipo and Observaciones come from there too: without them every entry was
    // titled a bare "Cita", blocks included.
    const registro = await zoho.buscarCitaPorInicio(b.Inicio, contactoRef, b.Fin);
    const consultorID = refZoho(b.Consultor) || refZoho(registro?.Consultor);
    const calendarId = CALENDARIOS[consultorID] || CALENDAR_GENERAL;

    if (!consultorID) {
      console.log(registro
        ? `ZOHO-CITA: la cita ${registro.ID} no tiene Consultor — va a CALENDAR_GENERAL`
        : 'ZOHO-CITA: no se encontró el registro en Citas_Report — va a CALENDAR_GENERAL');
    } else if (!CALENDARIOS[consultorID]) {
      console.error(
        'ZOHO-CITA: Consultor sin calendario mapeado, cae en CALENDAR_GENERAL —',
        JSON.stringify(registro?.Consultor || b.Consultor)
      );
    } else {
      console.log(`ZOHO-CITA: ruteada a ${registro?.Consultor?.display_value || consultorID} (calendario ${calendarId})`);
    }

    const tipo = b.Tipo || registro?.Tipo || 'Cita';
    const obs = b.Observaciones || registro?.Observaciones || '';

    // El workflow de Creator dispara varias veces por el mismo registro, y cada
    // disparo creaba otro evento: la auditoría del 2026-08-06 encontró 104 grupos
    // de eventos idénticos en julio-octubre, ninguno del backfill. Reservar el ID
    // antes de crear cierra también la carrera entre dos disparos simultáneos,
    // porque el INSERT es atómico y sólo uno se lleva la reserva.
    //
    // Sin registro en Citas_Report no hay ID que reservar. Se sigue igual: perder
    // la cita sería peor que arriesgar un duplicado, que ya sabemos detectar.
    zohoCitaID = registro?.ID || '';
    if (!(await db.reclamarCitaZoho(zohoCitaID, contactoRef ? 'cita' : 'bloqueo'))) {
      console.log(`ZOHO-CITA: la cita ${zohoCitaID} ya estaba sincronizada — disparo repetido, se ignora`);
      return;
    }

    if (!contactoRef) {
      const title = tituloGHL([tipo, obs], tipo || 'Bloqueo');
      const bloqueo = await ghl.crearBloqueoEnCalendario({ calendarId, startISO, endISO, title });
      await db.confirmarCitaZoho(zohoCitaID, bloqueo?.id, calendarId);
      console.log('ZOHO-CITA: bloqueo creado en GHL:', JSON.stringify(bloqueo));
      return;
    }

    const contacto = await zoho.getContactoPorId(contactoRef);
    if (!contacto?.Movil) {
      console.error(contacto
        ? `ZOHO-CITA: contacto ${contactoRef} existe pero no tiene Movil — creando como bloqueo`
        : `ZOHO-CITA: no se encontró el contacto Zoho ${contactoRef} — creando como bloqueo`);
      const bloqueo = await ghl.crearBloqueoEnCalendario({ calendarId, startISO, endISO, title: tituloGHL([tipo, obs], tipo || 'Bloqueo') });
      await db.confirmarCitaZoho(zohoCitaID, bloqueo?.id, calendarId);
      console.log('ZOHO-CITA: bloqueo creado en GHL:', JSON.stringify(bloqueo));
      return;
    }

    const ghlContactId = await ghl.buscarOCrearContactoPorTelefono(contacto.Movil, contacto.Nombre_Completo);
    if (!ghlContactId) {
      console.error('ZOHO-CITA: no se pudo resolver contacto GHL para', contacto.Movil, '— creando como bloqueo');
      const bloqueo = await ghl.crearBloqueoEnCalendario({ calendarId, startISO, endISO, title: tituloGHL([tipo, obs], tipo || 'Bloqueo') });
      await db.confirmarCitaZoho(zohoCitaID, bloqueo?.id, calendarId);
      console.log('ZOHO-CITA: bloqueo creado en GHL:', JSON.stringify(bloqueo));
      return;
    }

    const title = tituloGHL([tipo, contacto.Nombre_Completo || 'NHC'], 'Cita');
    const appt = await ghl.crearCitaEnCalendario({ contactId: ghlContactId, calendarId, startISO, endISO, title });
    await db.confirmarCitaZoho(zohoCitaID, appt?.id, calendarId);
    console.log('ZOHO-CITA: appointment creado en GHL:', JSON.stringify(appt));
  } catch (err) {
    // Nothing retries a cita: the 200 went out before any of this ran, so Zoho
    // considers it delivered. This line is the only trace the clinic gets that
    // an entry never reached GHL — it has to name the loss, not just the error.
    console.error('ZOHO-CITA: la entrada NO se sincronizó a GHL —', err.message);
    // Suelta la reserva para que un reenvío pueda reintentar. Sólo borra si no
    // llegó a asociarse un evento, así un fallo posterior a la creación no
    // reabre la puerta al duplicado que la reserva vino a evitar.
    await db.liberarCitaZoho(zohoCitaID);
  }
}

module.exports = { zohoCitaWebhookHandler, parseZohoDateTime, refZoho, tituloGHL };
