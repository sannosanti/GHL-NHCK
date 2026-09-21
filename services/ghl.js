'use strict';

const fetch = require('node-fetch');
const https = require('https');
const { env, constants, mapearSintoma, mapearGenero, mapearOcupacionNino, mapearSintomaAdulto } = require('../config');
const db = require('../db');

// Today's incidents (socket left dirty by an unconsumed body, then repeated
// "Premature close" on a specific contact's requests that only a fresh process
// — never the long-running server — could get past) both point to the same
// root cause: this process's pooled keep-alive connections to GHL degrade over
// hours of operation and don't recover. A fresh TCP+TLS handshake per request
// costs some latency but removes the whole "stale pooled socket" failure class
// instead of chasing its symptoms one endpoint at a time.
const ghlAgent = new https.Agent({ keepAlive: false });

// Always drain the response body — an unread body leaves the keep-alive socket
// in a bad state, which node-fetch later surfaces as "Premature close" on an
// unrelated request reusing that same pooled connection. Retry once on any
// network-level failure (the drain itself can also hit a dead socket).
//
// IMPORTANT: only a SyntaxError (body received but isn't valid JSON — e.g. a
// genuinely empty 204 response) is safe to swallow into `data: null`. Any other
// error thrown by res.json() is the body READ itself failing mid-stream (the
// same "Premature close" class this function exists to retry) — that must
// reach the outer catch/retry below, not be silently treated as "no data".
// (Previously this was swallowed unconditionally, which masked real fetch
// failures as an empty-but-successful response to every caller.)
async function fetchGHL(url, options = {}, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...options, agent: ghlAgent });
      let data = null;
      try {
        data = await res.json();
      } catch (parseErr) {
        if (!(parseErr instanceof SyntaxError)) throw parseErr;
      }
      return { res, data };
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

// ─── GHL: GUARDAR CAMPOS NIÑO ─────────────────────────────────────────────────
async function guardarCamposNinoGHL(contactId, { nombreNino, edadNino, generoNino, estudia, sintoma }) {
  try {
    const customFields = [
      { id: 'nhck__nombre_del_nio', value: nombreNino || '' },
      { id: 'nhck__edad_del_nio', value: edadNino || '' },
      { id: 'nhck__gnero_del_nio', value: mapearGenero(generoNino) },
      { id: 'nhck__estudia', value: estudia ? 'Sí' : 'No' },
      { id: 'nhck__sntoma_principal', value: mapearSintoma(sintoma) },
    ];
    await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields }),
    });
    await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
    console.log('Campos niño guardados en GHL');
  } catch (err) { console.error('Error guardando campos niño GHL:', err.message); }
}

async function guardarSintomaGHL(contactId, sintoma) {
  try {
    await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: [{ id: 'nhck__sntoma_principal', value: mapearSintoma(sintoma) }] }),
    });
    await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
  } catch (err) { console.error('Error guardando síntoma GHL:', err.message); }
}

// Used when a conversation was handed off to Luisa's persona mid-thread —
// the TRIAJE_P1 value comes from her adult categories, so it must go through
// her mapper into her field, not the kid one (same field ID as
// GHL-NHC-temp/services/ghl.js's guardarSintomaGHL).
async function guardarSintomaAdultoGHL(contactId, sintoma) {
  try {
    await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: [{ id: '2N0nl7XE77YeV6LUxM9Z', value: mapearSintomaAdulto(sintoma) }] }),
    });
    await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
  } catch (err) { console.error('Error guardando síntoma adulto GHL:', err.message); }
}

// Generic contact fields shared with Luisa (not the *_del_nio ones — those are
// Carolina's specifically). Same field IDs as GHL-NHC-temp/services/ghl.js —
// both agents share this GHL location, these fields already exist there.
const CAMPO_EDAD_ADULTO = 'Q3obnE2lFSPLy1DTUBuG';
const CAMPO_DOCUMENTO_IDENTIDAD = 'QlrYraCjioHiYTdYckMU';
const CAMPO_SINTOMA_O_NECESIDAD = '2N0nl7XE77YeV6LUxM9Z';

// Used when a conversation was handed off to Luisa's persona mid-thread
// (derivado_a='luisa') — writes to the adult fields instead of the *_del_nio
// ones, mirroring GHL-NHC-temp's guardarCamposPacienteGHL.
async function guardarCamposPacienteGHL(contactId, { edad, documentoIdentidad, sintoma }) {
  try {
    const customFields = [
      { id: CAMPO_EDAD_ADULTO, value: edad || '' },
      { id: CAMPO_DOCUMENTO_IDENTIDAD, value: documentoIdentidad || '' },
      { id: CAMPO_SINTOMA_O_NECESIDAD, value: mapearSintomaAdulto(sintoma) },
    ];
    await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields }),
    });
    await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
    console.log('Campos de paciente (derivado a Luisa) guardados en GHL');
  } catch (err) { console.error('Error guardando campos de paciente GHL:', err.message); }
}

async function guardarCiudadGHL(contactId, ciudad) {
  try {
    await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: ciudad }),
    });
    await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
  } catch (err) { console.error('Error guardando ciudad GHL:', err.message); }
}

// GoHighLevel renders {{appointment.start_time}} in English and gives no way to
// localise it. Confirmed live 2026-09-09: switching the location's Platform
// Language to Spanish translated the whole interface but left the merge field
// reading "Thursday, September 10, 2026". So the patient-facing wording is
// composed here, in Bogota time, and parked on the contact for the reminder
// templates to read instead.
//
// One value per contact: a second upcoming cita overwrites the first. That is
// acceptable for mapeos, which are one per patient, and is why this field must
// not be relied on for anything that has to survive.
const CAMPO_FECHA_CITA = 'x9MUWySqnd50WSJTLkwM'; // contact.cita_fecha_texto

function fechaCitaEnEspanol(startISO) {
  const d = new Date(startISO);
  if (Number.isNaN(d.getTime())) return '';
  const dia = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long',
  }).format(d).replace(',', '');
  const hora = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  // es-CO renders the meridiem as "p. m." with a trailing dot, and every template
  // body already closes the sentence with its own period — leaving both produces
  // "a las 6:37 p. m..". The template's period is the one that stays.
  return `${dia} a las ${hora}`.replace(/\.$/, '');
}

// Written BEFORE the appointment exists on purpose: creating it fires the
// confirmation workflow immediately, and that message would otherwise render an
// empty field.
async function guardarFechaCitaTextoGHL(contactId, startISO) {
  const texto = fechaCitaEnEspanol(startISO);
  if (!texto) return;
  try {
    await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: [{ id: CAMPO_FECHA_CITA, value: texto }] }),
    });
    await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
  } catch (err) { console.error('Error guardando fecha de cita GHL:', err.message); }
}

// ─── GHL API HELPERS ─────────────────────────────────────────────────────────
async function getContact(contactId, skipCache = false) {
  if (!skipCache) {
    const cached = await db.getCachedContact(contactId);
    if (cached) return { contact: cached };
  }
  const { res, data } = await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
  });
  if (res.status === 404) return { contact: null, deleted: true };
  if (data?.contact) await db.setCachedContact(contactId, data.contact);
  return data;
}

async function getConversationId(contactId) {
  try {
    const { res, data } = await fetchGHL(`https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&locationId=${env.ghlLocationId}`, {
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
    });
    // A missing `conversations` array on a non-200 (rate limit, auth, GHL-side error)
    // looks identical to "not indexed yet" if left unlogged — surface it so retries
    // aren't silently masking a real API failure.
    if (!data || !Array.isArray(data.conversations)) {
      console.error(`getConversationId: unexpected response for contactId=${contactId}, status=${res.status}, body=${JSON.stringify(data).substring(0, 300)}`);
    }
    return data?.conversations?.[0]?.id || null;
  } catch (err) {
    // Callers (ghlWebhookHandler's retry loop, pendingWebhookJob) treat null the
    // same as "not ready yet" and retry — don't let a fetch failure here abort
    // the whole webhook instead of being retried.
    console.error(`getConversationId: fetch failed for contactId=${contactId}:`, err.message);
    return null;
  }
}

// Maps GHL's search-endpoint conversation "type" (a readable string, e.g.
// "TYPE_FACEBOOK") to the value the send-message endpoint's `type` field
// expects (e.g. "FB"). The single-conversation fetch endpoint returns this
// as an undocumented numeric code instead, so we go through search by
// contactId, which reliably returns the string form.
const CHANNEL_TYPE_MAP = {
  TYPE_WHATSAPP: 'WhatsApp',
  TYPE_FACEBOOK: 'FB',
  TYPE_INSTAGRAM: 'IG',
  TYPE_SMS: 'SMS',
  TYPE_EMAIL: 'Email',
};

async function getConversationChannel(contactId) {
  try {
    const { data } = await fetchGHL(`https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&locationId=${env.ghlLocationId}`, {
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
    });
    const type = data?.conversations?.[0]?.lastMessageType;
    return CHANNEL_TYPE_MAP[type] || 'WhatsApp';
  } catch { return 'WhatsApp'; }
}

async function getLastMessage(conversationId) {
  try {
    const { data } = await fetchGHL(`https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=5`, {
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
    });
    const messages = data?.messages?.messages || data?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return { body: '', id: null, attachmentUrl: null };
    const last = messages.find(m => m.direction === 'inbound') || messages[0];
    const rawAttachments = last?.attachments || [];
    const attachmentUrl = Array.isArray(rawAttachments) && rawAttachments.length > 0
      ? rawAttachments[0]
      : (typeof rawAttachments === 'string' && rawAttachments ? rawAttachments : null);
    return { body: last?.body || '', id: last?.id || null, attachmentUrl };
  } catch (err) { return { body: '', id: null, attachmentUrl: null }; }
}

async function getConversationMessages(conversationId, limit = 30) {
  try {
    const { data } = await fetchGHL(
      `https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=${limit}`,
      { headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' } }
    );
    return data?.messages?.messages || data?.messages || [];
  } catch { return []; }
}

async function addTag(contactId, tag) {
  await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [tag] }),
  });
  await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
}

async function removeTag(contactId, tag) {
  await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [tag] }),
  });
  await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
}

async function sendMessage(conversationId, message, contactId, channel = 'WhatsApp') {
  const { data } = await fetchGHL('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: channel, conversationId, contactId, message }),
  });
  console.log('SEND MSG:', JSON.stringify(data));
}

async function sendMessages(conversationId, messages, contactId, channel = 'WhatsApp') {
  for (let i = 0; i < messages.length; i++) {
    await sendMessage(conversationId, messages[i], contactId, channel);
    if (i < messages.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
}

async function crearOportunidad(contactId, nombre, stageId) {
  try {
    const marca = env.agentName === 'luisa' ? 'Neuromapeo NHC' : 'Neuromapeo NHCK';
    const { data } = await fetchGHL('https://services.leadconnectorhq.com/opportunities/', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipelineId: constants.GHL_PIPELINE_ID, locationId: env.ghlLocationId,
        name: `${marca} - ${nombre}`, pipelineStageId: stageId, status: 'open', contactId,
        monetaryValue: 395000,
      }),
    });
    console.log('OPORTUNIDAD CREADA:', JSON.stringify(data));
    return data?.opportunity?.id || null;
  } catch (err) { console.error('Error creando oportunidad:', err.message); return null; }
}

async function addNote(contactId, body) {
  try {
    const { data } = await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    console.log('[addNote] Response:', JSON.stringify(data));
  } catch (err) { console.error('[addNote] Error:', err.message); }
}

async function sendInternalNote(conversationId, contactId, message) {
  try {
    const { data } = await fetchGHL('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Custom', conversationId, contactId, message }),
    });
    console.log('[sendInternalNote] Response:', JSON.stringify(data));
  } catch (err) { console.error('[sendInternalNote] Error:', err.message); }
}

async function actualizarEtapaOportunidad(contactId, stageId) {
  try {
    const { data } = await fetchGHL(`https://services.leadconnectorhq.com/opportunities/search?location_id=${env.ghlLocationId}&pipeline_id=${constants.GHL_PIPELINE_ID}&contact_id=${contactId}`, {
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-07-28' },
    });
    const opp = data?.opportunities?.[0];
    if (!opp) return null;
    const { data: dataUpdate } = await fetchGHL(`https://services.leadconnectorhq.com/opportunities/${opp.id}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineStageId: stageId }),
    });
    console.log('ETAPA ACTUALIZADA:', JSON.stringify(dataUpdate));
    return opp.id;
  } catch (err) { console.error('Error actualizando etapa:', err.message); return null; }
}

// Finds a GHL contact by phone, creating one if it doesn't exist yet.
async function buscarOCrearContactoPorTelefono(phone, nombre) {
  const { data } = await fetchGHL('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId: env.ghlLocationId, phone, name: nombre || '' }),
  });
  return data?.contact?.id || null;
}

// GHL answers a rejected appointment or block with an ordinary JSON body and a
// non-2xx status, so returning that body unchecked reads exactly like success.
// That is how `ZOHO-CITA: appointment creado en GHL: {...statusCode:500...}`
// reached the logs on 2026-08-03: two citas hit `DEADLINE_EXCEEDED`, were never
// created, and the line above them claimed they were. Throwing is what lets the
// webhook handler's catch report the loss — with enough context to recreate the
// entry by hand, since nothing retries it.
function verificarRespuestaGHL(res, data, accion, { calendarId, startISO }) {
  if (res.ok) return data;
  throw new Error(
    `${accion} falló con HTTP ${res.status} — calendario=${calendarId} inicio=${startISO} respuesta=${JSON.stringify(data)}`
  );
}

// GHL guarda `description` en el campo que su interfaz muestra como
// "Appointment description" -- y lo espeja en `notes`. Ahí van las Observaciones
// de Zoho completas: el título tiene un tope de 100 caracteres, pero la nota
// clínica no debería llegar recortada a quien atiende.
async function crearCitaEnCalendario({ contactId, calendarId, startISO, endISO, title, description }) {
  const { res, data } = await fetchGHL('https://services.leadconnectorhq.com/calendars/events/appointments', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      calendarId, locationId: env.ghlLocationId, contactId,
      startTime: startISO, endTime: endISO, title: title || 'Cita NHC Kids',
      description: description || '',
      ignoreFreeSlotValidation: true, ignoreDateRange: true, toNotify: false,
    }),
  });
  return verificarRespuestaGHL(res, data, 'crearCitaEnCalendario', { calendarId, startISO });
}

// For Zoho Citas entries with no Contacto (Bloqueo/Salida/Entrada/Descanso/
// Almuerzo/Festivo) — GHL's block-slots endpoint needs no contactId, unlike
// the appointments one above (verified live 2026-07-24).
async function crearBloqueoEnCalendario({ calendarId, startISO, endISO, title }) {
  const { res, data } = await fetchGHL('https://services.leadconnectorhq.com/calendars/events/block-slots', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      calendarId, locationId: env.ghlLocationId,
      startTime: startISO, endTime: endISO, title: title || 'Bloqueo NHC',
    }),
  });
  return verificarRespuestaGHL(res, data, 'crearBloqueoEnCalendario', { calendarId, startISO });
}

// Una reprogramación hecha en Zoho tiene que mover el evento que ya existe, no
// crear otro. citas_sync guarda el id del evento espejado, así que acá sólo hace
// falta pisarlo con el horario nuevo.
//
// El PUT reemplaza en vez de parchear: si no se reenvían title y
// appointmentStatus, se borran. Por eso se leen antes y se devuelven tal cual —
// una reprogramación cambia la hora, no el paciente ni el estado.
async function getCitaEnCalendario(eventId) {
  const { res, data } = await fetchGHL(`https://services.leadconnectorhq.com/calendars/events/appointments/${eventId}`, {
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
  });
  if (!res.ok) throw new Error(`getCitaEnCalendario falló con HTTP ${res.status}`);
  return data?.appointment || data?.event || data;
}

// `contactId` es obligatorio: el PUT reemplaza la cita entera y GHL responde
// 400 "Appointment ContactId must be provided" si no viaja. Sale del GET previo
// del evento, igual que el título y la descripción.
async function actualizarCitaEnCalendario({ eventId, calendarId, startISO, endISO, title, appointmentStatus, description, contactId }) {
  const { res, data } = await fetchGHL(`https://services.leadconnectorhq.com/calendars/events/appointments/${eventId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      calendarId, contactId, startTime: startISO, endTime: endISO, title,
      appointmentStatus: appointmentStatus || 'confirmed',
      // El PUT reemplaza: si no se reenvía, la descripción se borra.
      description: description || '',
      // Verificado en producción sobre una cita real: con esto en false el
      // paciente no recibe ningún mensaje por el cambio.
      toNotify: false,
      ignoreFreeSlotValidation: true, ignoreDateRange: true,
    }),
  });
  return verificarRespuestaGHL(res, data, 'actualizarCitaEnCalendario', { calendarId, startISO });
}

async function actualizarBloqueoEnCalendario({ eventId, calendarId, startISO, endISO, title }) {
  const { res, data } = await fetchGHL(`https://services.leadconnectorhq.com/calendars/events/block-slots/${eventId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarId, startTime: startISO, endTime: endISO, title }),
  });
  return verificarRespuestaGHL(res, data, 'actualizarBloqueoEnCalendario', { calendarId, startISO });
}

// Sólo lectura: lista los eventos de un calendario en una ventana de tiempo y
// busca uno de ESTA cita puntual — no cualquier cita de este contacto. Usada
// únicamente por jobs/reconciliacionCitasJob.js como chequeo de seguridad
// antes de crear una cita: citas_sync puede tener filas faltantes para citas
// que los scripts de migración de agosto espejaron directo (ver
// scripts/calendario/poblar-citas-sync.js), así que una fila ausente en esa
// tabla NO prueba que GHL no tenga ya el evento. Perder una pasada de
// reconciliación es recuperable; crear una segunda cita para el mismo
// paciente no lo es.
//
// El match NO puede ser sólo por contactId dentro de una ventana de tiempo:
// la clínica agenda hermanos y controles del mismo paciente en horarios
// consecutivos (caso real: un mismo padre con citas a las 09:00 y a las 10:00
// del mismo día, mismo consultor — ambas resuelven al mismo contacto GHL por
// teléfono). Si a la de las 10:00 le faltara la fila en citas_sync, un match
// por contactId dentro de ±1h encontraría el evento de las 9:00, lo daría por
// "ya existe", confirmaría citas_sync con el eventId equivocado, y la cita de
// las 10:00 quedaría descartada para siempre (la próxima pasada la ve con
// ghl_event_id y la salta). El rango de la CONSULTA puede ser amplio porque
// la API de GHL lo exige, pero el MATCH tiene que ser exacto: mismo contacto
// Y mismo minuto de inicio.
async function buscarCitaExistenteEnCalendario({ calendarId, contactId, startISO, endISO }) {
  const margenMs = 60 * 60 * 1000; // margen de la consulta, no del match — ver comentario arriba
  const desde = new Date(startISO).getTime() - margenMs;
  const hasta = new Date(endISO || startISO).getTime() + margenMs;
  const { res, data } = await fetchGHL(
    `https://services.leadconnectorhq.com/calendars/events?locationId=${env.ghlLocationId}&calendarId=${calendarId}&startTime=${desde}&endTime=${hasta}`,
    { headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' } }
  );
  if (!res.ok) throw new Error(`buscarCitaExistenteEnCalendario falló con HTTP ${res.status} — calendario=${calendarId}`);
  const eventos = data?.events || [];
  const inicioBuscadoMin = Math.floor(new Date(startISO).getTime() / 60000); // al minuto, no al milisegundo
  return eventos.find(e =>
    e.contactId === contactId && Math.floor(new Date(e.startTime).getTime() / 60000) === inicioBuscadoMin
  ) || null;
}

module.exports = {
  // Se exporta para jobs que consultan endpoints de GHL que este módulo todavía
  // no envuelve (p. ej. la lista de calendarios y la búsqueda de
  // conversaciones del reporte de salud). Sigue siendo el único camino a GHL:
  // un fetch suelto se saltaría el drenado del cuerpo y el reintento, que es lo
  // que evita los "Premature close" en una llamada posterior no relacionada.
  fetchGHL,
  getCitaEnCalendario,
  actualizarCitaEnCalendario,
  actualizarBloqueoEnCalendario,
  mapearSintoma,
  mapearGenero,
  mapearOcupacionNino,
  guardarCamposNinoGHL,
  guardarCamposPacienteGHL,
  guardarSintomaGHL,
  guardarSintomaAdultoGHL,
  guardarCiudadGHL,
  getContact,
  getConversationId,
  getConversationChannel,
  getLastMessage,
  getConversationMessages,
  addTag,
  removeTag,
  addNote,
  sendInternalNote,
  sendMessage,
  sendMessages,
  crearOportunidad,
  actualizarEtapaOportunidad,
  buscarOCrearContactoPorTelefono,
  guardarFechaCitaTextoGHL,
  fechaCitaEnEspanol,
  crearCitaEnCalendario,
  crearBloqueoEnCalendario,
  buscarCitaExistenteEnCalendario,
};
