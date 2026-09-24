'use strict';

// Escribe la fecha de LA cita que el recordatorio está por anunciar.
//
// El mensaje de recordatorio arma su texto con contact.cita_fecha_texto, que es
// un campo del CONTACTO: un solo valor para un paciente que puede tener varias
// citas. Hasta ahora se escribía al crear la cita, semanas antes, así que para
// cuando el recordatorio salía el campo ya apuntaba a otra. El 21/09 eso mandó
// "mañana jueves 24 de septiembre" a alguien que tenía cita al día siguiente, y
// dos intentos de repararlo por lotes fallaron por lo mismo: cualquier valor
// escrito por anticipado es correcto un día y falso al siguiente.
//
// La cita correcta sólo se sabe en un momento: cuando el workflow del
// recordatorio, que está anclado a UNA cita, termina su espera. Este endpoint
// existe para que ese workflow nos llame ahí y escribamos la fecha de esa cita
// justo antes de enviar el mensaje.
//
// Que un paciente tenga dos citas el mismo día deja de importar: cada cita entra
// al workflow por separado y cada entrada nos llama con la suya.
const ghl = require('../services/ghl');
const db = require('../db');

// Una fecha fuera de este rango no es una cita: es un campo mal mapeado en el
// workflow, o una plantilla que llegó sin resolver. Escribirla sería reemplazar
// una fecha vieja por una basura.
const MAX_ADELANTO_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_ATRASO_MS = 2 * 24 * 60 * 60 * 1000;

function primero(...valores) {
  for (const v of valores) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    // GHL manda la merge field sin resolver cuando el campo no existe en ese
    // contexto; eso llega literal como "{{appointment.start_time}}".
    if (!s || s.includes('{{')) continue;
    return s;
  }
  return '';
}

async function fechaRecordatorioHandler(req, res) {
  const b = req.body || {};
  const cd = b.customData || b.custom_data || {};

  const contactId = primero(
    b.contactId, b.contact_id, cd.contactId, cd.contact_id, b.contact?.id
  );
  const inicio = primero(
    cd.startTime, cd.start_time, cd.fechaCita, cd.appointmentStartTime,
    b.startTime, b.start_time, b.appointment?.startTime, b.appointment?.start_time
  );

  // Se responde con el detalle porque el registro de ejecución del workflow en
  // GHL muestra el cuerpo de la respuesta: cuando esto falle, la causa tiene que
  // estar a la vista de quien mira el workflow, no sólo en nuestros logs.
  // Un rechazo tiene que dejar rastro igual que un éxito. Sin esto, "GHL mandó
  // algo que no entiendo" y "GHL nunca me llamó" se ven idénticos desde la base,
  // que es exactamente la ceguera que este endpoint vino a cerrar.
  const rechazar = async (estado, error, extra = {}) => {
    console.error(`RECORDATORIO-FECHA: ${contactId || '(sin contacto)'} — ${error}`);
    await db.logEvent(contactId || null, null, 'recordatorio_fecha_rechazada',
      { error, inicio: inicio || null, ...extra }).catch(() => {});
    return res.status(estado).json({ ok: false, error, ...extra });
  };

  if (!contactId) {
    return rechazar(400, 'falta contactId', { clavesRecibidas: Object.keys(b) });
  }
  if (!inicio) {
    // Se guardan las claves recibidas: cuando el mapeo del workflow esté mal,
    // esto dice qué nombres llegaron y ahorra abrir GHL para adivinarlo.
    return rechazar(400, 'falta la fecha de inicio de la cita',
      { clavesRecibidas: Object.keys(b), clavesCustomData: Object.keys(cd) });
  }

  const cuando = new Date(inicio).getTime();
  if (Number.isNaN(cuando)) {
    return rechazar(400, `fecha ilegible: ${inicio}`);
  }
  const ahora = Date.now();
  if (cuando > ahora + MAX_ADELANTO_MS || cuando < ahora - MAX_ATRASO_MS) {
    return rechazar(400, `fecha fuera de rango: ${inicio}`);
  }

  // La respuesta sale DESPUÉS de escribir, nunca antes. Es lo contrario de lo
  // que hace el webhook de citas de Zoho, y esa diferencia es todo el punto: si
  // contestáramos primero, GHL podría mandar el WhatsApp con el campo viejo.
  const texto = await ghl.guardarFechaCitaTextoGHL(contactId, new Date(cuando).toISOString());

  if (!texto) {
    console.error(`RECORDATORIO-FECHA: no se pudo escribir la fecha de ${contactId}`);
    await db.logEvent(contactId, null, 'recordatorio_fecha_fallida', { inicio }).catch(() => {});
    return res.status(500).json({ ok: false, error: 'no se pudo escribir la fecha en el contacto' });
  }

  console.log(`RECORDATORIO-FECHA: ${contactId} -> "${texto}"`);
  await db.logEvent(contactId, null, 'recordatorio_fecha_escrita', { inicio, texto }).catch(() => {});
  return res.json({ ok: true, fecha: texto });
}

module.exports = { fechaRecordatorioHandler };
