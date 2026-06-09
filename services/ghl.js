'use strict';

const fetch = require('node-fetch');
const { env, constants } = require('../config');
const db = require('../db');

// ─── MAPPERS ─────────────────────────────────────────────────────────────────
function mapearSintoma(s) {
  s = (s || '').toLowerCase().trim();
  if (s.includes('ansiedad') || s.includes('miedo') || s.includes('inseguridad')) return 'Ansiedad';
  if (s.includes('autis')) return 'Autismo';
  if (s.includes('autoestima') || s.includes('confianza')) return 'Autoestima';
  if (s.includes('deficit') || s.includes('déficit') || s.includes('atención') || s.includes('atencion') || s.includes('tdah') || s.includes('concentra')) return 'Déficit de atención';
  if (s.includes('depres')) return 'Depresión1';
  if (s.includes('rendimiento') || s.includes('aprendizaje') || s.includes('escolar') || s.includes('dislexia')) return 'Dificultades de aprendizaje';
  if (s.includes('desregul') || s.includes('emocional')) return 'Ansiedad';
  if (s.includes('conduct') || s.includes('impulsiv')) return 'TOD (Transtorno Oposicion...)';
  if (s.includes('estrés') || s.includes('estres')) return 'Estrés';
  if (s.includes('toc') || s.includes('obsesiv')) return 'TOC (Transtorno Obsesivo C...)';
  return 'Otros';
}

function mapearGenero(g) {
  g = (g || '').toLowerCase().trim();
  if (g.includes('mascul') || g.includes('niño') || g.includes('hombre') || g === 'm') return 'Masculino';
  if (g.includes('femen') || g.includes('niña') || g.includes('mujer') || g === 'f') return 'Femenino';
  return 'Otro';
}

function mapearOcupacionNino(estudia) {
  return (estudia === true || estudia === 'si' || estudia === 'sí') ? 'Estudiante de colegio' : 'N.A';
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
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields }),
    });
    await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
    console.log('Campos niño guardados en GHL');
  } catch (err) { console.error('Error guardando campos niño GHL:', err.message); }
}

// ─── GHL API HELPERS ─────────────────────────────────────────────────────────
async function getContact(contactId) {
  const cached = await db.getCachedContact(contactId);
  if (cached) return { contact: cached };
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
  });
  if (res.status === 404) return { contact: null, deleted: true };
  const data = await res.json();
  if (data.contact) await db.setCachedContact(contactId, data.contact);
  return data;
}

async function getConversationId(contactId) {
  const res = await fetch(`https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&locationId=${env.ghlLocationId}`, {
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
  });
  const data = await res.json();
  return data.conversations?.[0]?.id || null;
}

async function getLastMessage(conversationId) {
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=5`, {
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
    });
    const data = await res.json();
    const messages = data.messages?.messages || data.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return { body: '', id: null };
    const last = messages.find(m => m.direction === 'inbound') || messages[0];
    return { body: last?.body || '', id: last?.id || null };
  } catch (err) { return { body: '', id: null }; }
}

async function addTag(contactId, tag) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [tag] }),
  });
  await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
}

async function removeTag(contactId, tag) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [tag] }),
  });
  await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
}

async function sendMessage(conversationId, message, contactId) {
  const res = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'WhatsApp', conversationId, contactId, message }),
  });
  const data = await res.json();
  console.log('SEND MSG:', JSON.stringify(data));
}

async function sendMessages(conversationId, messages, contactId) {
  for (let i = 0; i < messages.length; i++) {
    await sendMessage(conversationId, messages[i], contactId);
    if (i < messages.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
}

async function crearOportunidad(contactId, nombre, stageId) {
  try {
    const res = await fetch('https://services.leadconnectorhq.com/opportunities/', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipelineId: constants.GHL_PIPELINE_ID, locationId: env.ghlLocationId,
        name: `NHC Kids - ${nombre}`, pipelineStageId: stageId, status: 'open', contactId,
      }),
    });
    const data = await res.json();
    console.log('OPORTUNIDAD CREADA:', JSON.stringify(data));
    return data.opportunity?.id || null;
  } catch (err) { console.error('Error creando oportunidad:', err.message); return null; }
}

async function actualizarEtapaOportunidad(contactId, stageId) {
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/opportunities/search?location_id=${env.ghlLocationId}&pipeline_id=${constants.GHL_PIPELINE_ID}&contact_id=${contactId}`, {
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-07-28' },
    });
    const data = await res.json();
    const opp = data.opportunities?.[0];
    if (!opp) return null;
    const resUpdate = await fetch(`https://services.leadconnectorhq.com/opportunities/${opp.id}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineStageId: stageId }),
    });
    const dataUpdate = await resUpdate.json();
    console.log('ETAPA ACTUALIZADA:', JSON.stringify(dataUpdate));
    return opp.id;
  } catch (err) { console.error('Error actualizando etapa:', err.message); return null; }
}

module.exports = {
  mapearSintoma,
  mapearGenero,
  mapearOcupacionNino,
  guardarCamposNinoGHL,
  getContact,
  getConversationId,
  getLastMessage,
  addTag,
  removeTag,
  sendMessage,
  sendMessages,
  crearOportunidad,
  actualizarEtapaOportunidad,
};
