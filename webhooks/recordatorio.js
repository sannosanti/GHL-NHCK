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
const { env } = require('../config');
const ghl = require('../services/ghl');
const db = require('../db');

// Una fecha fuera de este rango no es una cita: es un campo mal mapeado en el
// workflow, o una plantilla que llegó sin resolver. Escribirla sería reemplazar
// una fecha vieja por una basura.
const MAX_ADELANTO_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_ATRASO_MS = 2 * 24 * 60 * 60 * 1000;

const MESES_EN = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// El formato en que GHL resuelve {{appointment.start_time}}, leído de los 50
// eventos que el endpoint ya registró: "Wednesday, September 30, 2026 2:00 PM".
// No es el de EE. UU. que supuse dos veces; es el largo en inglés.
const LARGO_EN = /^(?:[a-z]+,\s*)?([a-z]+)\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i;

// Lo que devuelve /contacts/{id}/appointments, que es de donde sale el respaldo.
const ISO_SIN_ZONA = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)$/;

const dosDigitos = n => String(n).padStart(2, '0');

// GHL manda la hora de la cita en la zona de la location —Bogotá— y sin decirlo.
// new Date() la interpreta como UTC porque el servidor corre en UTC, y al
// formatearla de vuelta a Bogotá queda cinco horas antes: una cita de las 2 p. m.
// se anuncia a las 9 a. m. Eso recibieron 18 de los 25 pacientes del 29/09.
// Colombia es UTC-5 todo el año, sin horario de verano, así que el desplazamiento
// es fijo y seguro de asumir. Verificado contra /calendars/events, que sí trae
// offset: la cita que GHL mandó como "Wednesday, September 30, 2026 2:00 PM" es
// 2026-09-30T14:00:00-05:00.
//
// Si el texto YA trae zona (una Z, o +05:00, o -0500) se respeta tal cual: ahí
// el emisor ya dijo a qué hora absoluta se refiere y no hay nada que suponer.
//
// Devuelve null cuando no reconoce el texto. Preferir rechazar antes que
// suponer: adivinar el formato ya costó dos incidentes, y un valor devuelto "tal
// cual" es exactamente cómo se coló el de -5 horas.
function conZonaBogota(texto) {
  const s = String(texto).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return s;   // el emisor ya fijó la hora absoluta

  const iso = s.match(ISO_SIN_ZONA);
  if (iso) return `${iso[1]}T${iso[2]}-05:00`;

  const en = s.match(LARGO_EN);
  if (en) {
    const mes = MESES_EN[en[1].toLowerCase()];
    if (!mes) return null;
    // 12 a. m. es 00 y 12 p. m. es 12: el módulo deja el 12 en cero y el sufijo
    // vuelve a subirlo sólo para p. m.
    const hora = (Number(en[4]) % 12) + (en[7].toLowerCase() === 'p' ? 12 : 0);
    return `${en[3]}-${dosDigitos(mes)}-${dosDigitos(en[2])}T${dosDigitos(hora)}:${en[5]}:${en[6] || '00'}-05:00`;
  }
  return null;                                      // cualquier otra forma: no se supone
}

// "2026-09-30" en hora de Bogotá. en-CA porque rinde el año primero, que es lo
// que hace comparables dos fechas como texto.
const diaBogota = ms => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

// Respaldo para cuando el workflow no manda la fecha.
//
// En una prueba manual no hay cita detrás, así que GHL no resuelve la merge
// field y llega el literal "{{appointment.start_time}}". El endpoint lo rechaza
// —bien— pero el campo queda con lo que tenía y el mensaje sale igual: eso es lo
// que recibió Santiago el 29/09, "mañana sábado 12 de septiembre", diecisiete
// días vencida. Rechazar protege de escribir una hora inventada; no protege de
// anunciar una vieja.
//
// El contactId sí llega siempre resuelto, así que la cita se puede buscar sola.
// Sólo se acepta si la respuesta es UNA: el mensaje dice "mañana", y si el
// paciente tiene dos citas mañana no hay manera de saber cuál motivó esta
// inscripción. Ambiguo se rechaza — elegir por nosotros es el error que este
// endpoint vino a cerrar, no uno nuevo que valga la pena introducir.
async function citaDeManana(contactId) {
  const { res, data } = await ghl.fetchGHL(
    `https://services.leadconnectorhq.com/contacts/${contactId}/appointments`,
    { headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' } }
  );
  if (!res.ok) throw new Error(`/contacts/${contactId}/appointments respondió HTTP ${res.status}`);

  // Mediodía como ancla en vez de sumar 24 h a "ahora": a las 23:30 sumar un día
  // da pasado mañana.
  const manana = diaBogota(Date.parse(`${diaBogota(Date.now())}T12:00:00-05:00`) + 24 * 60 * 60 * 1000);
  const ahora = Date.now();
  const candidatas = (data?.events || [])
    .filter(e => e.appointmentStatus !== 'cancelled')
    .map(e => ({ id: e.id, inicio: conZonaBogota(e.startTime) }))
    .filter(e => e.inicio
      && new Date(e.inicio).getTime() > ahora
      && diaBogota(new Date(e.inicio).getTime()) === manana);

  return { manana, candidatas };
}

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

  // De dónde salió la fecha viaja en el evento: un respaldo que se usa seguido
  // significa que el mapeo del workflow se rompió, y eso hay que poder verlo sin
  // abrir GHL.
  let normalizada = inicio ? conZonaBogota(inicio) : null;
  let origen = 'workflow';

  if (!normalizada) {
    let respaldo;
    try {
      respaldo = await citaDeManana(contactId);
    } catch (err) {
      return rechazar(502, `no pude consultar las citas del contacto: ${err.message}`,
        { formatoRecibido: inicio || null });
    }
    if (respaldo.candidatas.length !== 1) {
      // El texto crudo viaja en el evento y en la respuesta: es el único modo de
      // saber qué manda GHL sin volver a adivinarlo.
      return rechazar(400,
        respaldo.candidatas.length === 0
          ? `el workflow no mandó una fecha usable y el paciente no tiene ninguna cita el ${respaldo.manana}`
          : `el workflow no mandó una fecha usable y el paciente tiene ${respaldo.candidatas.length} citas el ${respaldo.manana}`,
        { formatoRecibido: inicio || null, citasManana: respaldo.candidatas.length,
          clavesRecibidas: Object.keys(b), clavesCustomData: Object.keys(cd) });
    }
    normalizada = respaldo.candidatas[0].inicio;
    origen = 'calendario';
  }

  const cuando = new Date(normalizada).getTime();
  if (Number.isNaN(cuando)) {
    return rechazar(400, `no interpreto esta fecha: ${inicio}`, { formatoRecibido: String(inicio) });
  }
  const ahora = Date.now();
  if (cuando > ahora + MAX_ADELANTO_MS || cuando < ahora - MAX_ATRASO_MS) {
    return rechazar(400, `fecha fuera de rango: ${normalizada}`, { origen });
  }

  // La respuesta sale DESPUÉS de escribir, nunca antes. Es lo contrario de lo
  // que hace el webhook de citas de Zoho, y esa diferencia es todo el punto: si
  // contestáramos primero, GHL podría mandar el WhatsApp con el campo viejo.
  const texto = await ghl.guardarFechaCitaTextoGHL(contactId, new Date(cuando).toISOString());

  if (!texto) {
    console.error(`RECORDATORIO-FECHA: no se pudo escribir la fecha de ${contactId}`);
    await db.logEvent(contactId, null, 'recordatorio_fecha_fallida', { inicio, origen }).catch(() => {});
    return res.status(500).json({ ok: false, error: 'no se pudo escribir la fecha en el contacto' });
  }

  console.log(`RECORDATORIO-FECHA: ${contactId} -> "${texto}" (${origen})`);
  await db.logEvent(contactId, null, 'recordatorio_fecha_escrita',
    { inicio: inicio || null, texto, origen }).catch(() => {});
  return res.json({ ok: true, fecha: texto, origen });
}

module.exports = { fechaRecordatorioHandler, conZonaBogota };
