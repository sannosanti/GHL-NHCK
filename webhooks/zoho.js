'use strict';

const zoho = require('../services/zoho');
const ghl = require('../services/ghl');

// Dedicated GHL calendars for the Zoho -> GHL sync, one per real Zoho
// Consultor/resource — see engram ghl-nhck/sync-zoho-ghl-calendario. Kept
// deliberately separate from the personal calendars already in GHL. Both
// Carolina (NHCK) and Luisa (NHC) share this same Zoho calendar and GHL
// location, so this single webhook covers both brands.
const CALENDARIOS = {
  '3572150000004930155': 'MvnOMgGMs69y6Ewix22r', // Juan Esteban Tamayo
  '3572150000005140253': 'iTdbaauOdCrcNHwsIe2h', // Mapeos
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

  try {
    const b = req.body || {};
    const consultorID = typeof b.Consultor === 'object' ? b.Consultor?.ID : b.Consultor;
    const calendarId = CALENDARIOS[consultorID] || CALENDAR_GENERAL;

    const startISO = parseZohoDateTime(b.Inicio);
    const endISO = parseZohoDateTime(b.Fin);
    if (!startISO) { console.error('ZOHO-CITA: no se pudo interpretar Inicio:', b.Inicio); return; }

    const tipo = b.Tipo || 'Cita';
    const obs = b.Observaciones || '';
    const contactoRef = typeof b.Contacto === 'object' ? b.Contacto?.ID : b.Contacto;

    if (!contactoRef) {
      const title = obs ? `${tipo} - ${obs}` : tipo;
      const bloqueo = await ghl.crearBloqueoEnCalendario({ calendarId, startISO, endISO, title });
      console.log('ZOHO-CITA: bloqueo creado en GHL:', JSON.stringify(bloqueo));
      return;
    }

    const contacto = await zoho.getContactoPorId(contactoRef);
    if (!contacto?.Movil) {
      console.error('ZOHO-CITA: contacto sin celular, contactoID=', contactoRef, '— creando como bloqueo');
      const bloqueo = await ghl.crearBloqueoEnCalendario({ calendarId, startISO, endISO, title: obs ? `${tipo} - ${obs}` : tipo });
      console.log('ZOHO-CITA: bloqueo creado en GHL:', JSON.stringify(bloqueo));
      return;
    }

    const ghlContactId = await ghl.buscarOCrearContactoPorTelefono(contacto.Movil, contacto.Nombre_Completo);
    if (!ghlContactId) {
      console.error('ZOHO-CITA: no se pudo resolver contacto GHL para', contacto.Movil, '— creando como bloqueo');
      const bloqueo = await ghl.crearBloqueoEnCalendario({ calendarId, startISO, endISO, title: obs ? `${tipo} - ${obs}` : tipo });
      console.log('ZOHO-CITA: bloqueo creado en GHL:', JSON.stringify(bloqueo));
      return;
    }

    const title = `${tipo} - ${contacto.Nombre_Completo || 'NHC'}`;
    const appt = await ghl.crearCitaEnCalendario({ contactId: ghlContactId, calendarId, startISO, endISO, title });
    console.log('ZOHO-CITA: appointment creado en GHL:', JSON.stringify(appt));
  } catch (err) {
    console.error('Error zohoCitaWebhookHandler:', err.message);
  }
}

module.exports = { zohoCitaWebhookHandler, parseZohoDateTime };
