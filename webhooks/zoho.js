'use strict';

const zoho = require('../services/zoho');
const ghl = require('../services/ghl');

// Dedicated GHL calendars created for this sync — see engram ghl-nhck/sync-zoho-ghl-calendario
const CALENDAR_PRE_EVALUACION = 'MvnOMgGMs69y6Ewix22r';
const CALENDAR_NEUROMAPEO = 'iTdbaauOdCrcNHwsIe2h';

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
 * Mirrors that appointment into the corresponding GHL calendar.
 */
async function zohoCitaWebhookHandler(req, res) {
  res.json({ success: true, received: true });

  try {
    const b = req.body || {};
    const contactoRef = typeof b.Contacto === 'object' ? b.Contacto?.ID : b.Contacto;
    if (!contactoRef) { console.error('ZOHO-CITA: payload sin Contacto', JSON.stringify(b).substring(0, 300)); return; }

    const contacto = await zoho.getContactoPorId(contactoRef);
    if (!contacto?.Movil) { console.error('ZOHO-CITA: contacto sin celular, contactoID=', contactoRef); return; }

    const ghlContactId = await ghl.buscarOCrearContactoPorTelefono(contacto.Movil, contacto.Nombre_Completo);
    if (!ghlContactId) { console.error('ZOHO-CITA: no se pudo resolver contacto GHL para', contacto.Movil); return; }

    const esNeuromapeo = String(b.Duraci_n || '').includes('hora');
    const calendarId = esNeuromapeo ? CALENDAR_NEUROMAPEO : CALENDAR_PRE_EVALUACION;
    const title = esNeuromapeo ? 'Neuromapeo - NHC Kids' : 'Pre-evaluación - NHC Kids';

    const startISO = parseZohoDateTime(b.Inicio);
    const endISO = parseZohoDateTime(b.Fin);
    if (!startISO) { console.error('ZOHO-CITA: no se pudo interpretar Inicio:', b.Inicio); return; }

    const appt = await ghl.crearCitaEnCalendario({ contactId: ghlContactId, calendarId, startISO, endISO, title });
    console.log('ZOHO-CITA: appointment creado en GHL:', JSON.stringify(appt));
  } catch (err) {
    console.error('Error zohoCitaWebhookHandler:', err.message);
  }
}

module.exports = { zohoCitaWebhookHandler, parseZohoDateTime };
