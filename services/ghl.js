'use strict';

const fetch = require('node-fetch');
const { env, constants, mapearSintoma, mapearGenero, mapearOcupacionNino } = require('../config');
const db = require('../db');

// Always drain the response body — an unread body leaves the keep-alive socket
// in a bad state, which node-fetch later surfaces as "Premature close" on an
// unrelated request reusing that same pooled connection. Retry once on any
// network-level failure (the drain itself can also hit a dead socket).
async function fetchGHL(url, options = {}, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, options);
      let data = null;
      try { data = await res.json(); } catch { /* empty or non-JSON body */ }
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

// ─── GHL API HELPERS ─────────────────────────────────────────────────────────
async function getContact(contactId) {
  const cached = await db.getCachedContact(contactId);
  if (cached) return { contact: cached };
  const { res, data } = await fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
  });
  if (res.status === 404) return { contact: null, deleted: true };
  if (data?.contact) await db.setCachedContact(contactId, data.contact);
  return data;
}

async function getConversationId(contactId) {
  const { data } = await fetchGHL(`https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&locationId=${env.ghlLocationId}`, {
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
  });
  return data?.conversations?.[0]?.id || null;
}

async function getConversationChannel(conversationId) {
  try {
    const { data } = await fetchGHL(`https://services.leadconnectorhq.com/conversations/${conversationId}`, {
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
    });
    return data?.conversation?.type || 'WhatsApp';
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
    const { data } = await fetchGHL('https://services.leadconnectorhq.com/opportunities/', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipelineId: constants.GHL_PIPELINE_ID, locationId: env.ghlLocationId,
        name: `NHC Kids - ${nombre}`, pipelineStageId: stageId, status: 'open', contactId,
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

module.exports = {
  mapearSintoma,
  mapearGenero,
  mapearOcupacionNino,
  guardarCamposNinoGHL,
  guardarSintomaGHL,
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
};
