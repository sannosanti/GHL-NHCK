'use strict';

const crypto = require('crypto');
const { env, constants } = require('../config');
const db = require('../db');
const ghl = require('../services/ghl');
const zoho = require('../services/zoho');
const timers = require('../services/timers');
const { triggerAnalysis } = require('../jobs/insightJob');

/**
 * POST /webhook/wompi
 * Handles Wompi payment confirmation webhooks.
 */
async function wompiWebhookHandler(req, res) {
  console.log('WOMPI WEBHOOK RECIBIDO:', JSON.stringify(req.body));
  try {
    const transaccion = req.body?.data?.transaction;
    if (!transaccion) return res.json({ received: true });
    const { reference, status } = transaccion;

    const checksum = req.body?.signature?.checksum;
    const properties = req.body?.signature?.properties || [];
    const timestamp = req.body?.timestamp;
    if (checksum && properties.length > 0 && timestamp) {
      const cadena = properties.map(p => {
        const keys = p.split('.');
        let val = req.body.data;
        for (const k of keys) val = val?.[k];
        return val !== undefined && val !== null ? String(val) : '';
      }).join('') + String(timestamp) + env.wompiIntegrityKey;
      const firmaCalc = crypto.createHash('sha256').update(cadena).digest('hex');
      if (firmaCalc !== checksum && req.body?.environment !== 'test') {
        return res.status(401).json({ error: 'Firma inválida' });
      }
    }

    if (status !== 'APPROVED') return res.json({ received: true });

    const datos = await db.getPendingPayment(reference);
    if (!datos) return res.json({ received: true });

    const { contactId, conversationId, contact, fechaCita, horaCita, edad, genero, ocupacion, sintoma, nombreNino, nombre } = datos;

    let resultado = null;
    try {
      resultado = await zoho.crearEnAnamnesis({
        nombreNino: nombreNino || contact.firstName || '',
        email: contact.email || '', movil: contact.phone || '', contactIdGHL: contactId,
        edad, sintoma, genero, estudia: ocupacion === 'Estudiante de colegio',
      });
    } catch (err) { console.error('Error Anamnesis:', err.message); }

    try {
      await zoho.crearCitasCalendario({
        movil: contact.phone || '', email: contact.email || '',
        fechaISO: fechaCita, horaInicio: horaCita, contactoID: resultado?.contactoID || null, nombreNino: nombreNino || '',
      });
      await db.deleteAvailabilityCache(fechaCita);
    } catch (err) { console.error('Error Citas:', err.message); }

    const mesesN = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const [, mm, dd] = (fechaCita || '').split('-');
    const fechaL = fechaCita ? `${parseInt(dd)} de ${mesesN[parseInt(mm) - 1]}` : 'la fecha acordada';
    const [hh, min] = (horaCita || '00:00').split(':');
    const hN = parseInt(hh);
    const horaL = `${hN > 12 ? hN - 12 : hN === 0 ? 12 : hN}:${min}${hN < 12 ? 'am' : 'pm'}`;

    await ghl.addTag(contactId, 'escalado nhck');
    await ghl.addTag(contactId, 'pagó 100K nhck');
    await db.deletePendingPayment(reference);
    ghl.actualizarEtapaOportunidad(contactId, constants.STAGE_PAGO_PARCIAL).catch(() => {});
    timers.limpiarTimers(conversationId);
    await db.marcarCompletado(conversationId);
    triggerAnalysis(conversationId, contactId, 'completado');

    await ghl.sendMessages(conversationId, [
      `✅ ¡Pago recibido ${nombre}! Tu cita está confirmada para el ${fechaL} a las ${horaL} 🎉`,
      `Recuerda llegar 10 minutos antes. ¡Nos vemos pronto! 🙌`,
      `En breve un asesor te escribirá para coordinar los últimos detalles: ubicación del centro, test previo y recomendaciones para el proceso. 🙏`,
    ], contactId);

    return res.json({ received: true });
  } catch (error) {
    console.error('Error webhook Wompi:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * GET /pago-exitoso
 * Landing page shown after a successful Wompi redirect.
 */
function pagoExitosoHandler(req, res) {
  res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:3rem">¡Pago recibido! Tu cita está confirmada. Puedes cerrar esta ventana.</h2>');
}

module.exports = { wompiWebhookHandler, pagoExitosoHandler };
