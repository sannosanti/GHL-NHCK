'use strict';

const express = require('express');
const { env } = require('./config');
const db = require('./db');
const { removeTag, getContact, getConversationId } = require('./services/ghl');
const { ghlWebhookHandler } = require('./webhooks/ghl');
const { wompiWebhookHandler, pagoExitosoHandler } = require('./webhooks/wompi');

const app = express();
app.use(express.json());
app.use('/public', express.static('public'));

// ─── UTILITY ROUTES ──────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send('Servidor NHC Kids activo ✓'));

app.get('/reset/:conversationId', async (req, res) => {
  try {
    await db.pool.query('DELETE FROM conversations WHERE conversation_id=$1', [req.params.conversationId]);
    res.send(`✓ Conversación ${req.params.conversationId} reiniciada`);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.get('/test-pago/:contactId', async (req, res) => {
  try {
    const contactId = req.params.contactId;
    await db.limpiarContactoDB(contactId);
    try { await removeTag(contactId, 'escalado nhck'); } catch (e) {}
    const conversationId = await getConversationId(contactId);
    if (!conversationId) return res.status(400).send('No se encontró conversación para este contacto');
    const triaje = { triaje1: 'Atención/concentración', triaje2: 'Más de 1 año', triaje3: 'Nada aún' };
    const fechaCita = '2026-06-10';
    const horaCita = '14:00';
    const nombreNino = 'Felipe Test';
    const referencia = `NHCK-TEST-${contactId}-${Date.now()}`;
    const contactData = await getContact(contactId);
    const contact = contactData.contact || {};
    await db.savePendingPayment(referencia, {
      contactId, conversationId, contact, fechaCita, horaCita, edad: '10', genero: 'Masculino',
      ocupacion: 'Estudiante de colegio', sintoma: 'Atención/concentración',
      nombreNino, nombre: contact.firstName || 'Tester', paymentLinkId: null,
    });
    await db.saveConversationData(conversationId, contactId, [], triaje, 'esperando_pago', null, contact.phone || '');
    res.send(`✓ Modo tester activado para ${contactId}<br>Estado: esperando_pago<br>Niño: ${nombreNino}<br>Cita: ${fechaCita} ${horaCita}<br>Referencia: ${referencia}<br><br>Ahora escribe en WhatsApp para probar el medio de pago.`);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.get('/reset-contact/:contactId', async (req, res) => {
  try {
    await db.limpiarContactoDB(req.params.contactId);
    try { await removeTag(req.params.contactId, 'escalado nhck'); } catch (e) {}
    res.send(`✓ Contacto ${req.params.contactId} reiniciado`);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.post('/webhook/contact-deleted', async (req, res) => {
  try {
    const contactId = req.body.id || req.body.contactId || req.body.contact?.id || req.body.customData?.contactId || req.body.contact_id;
    if (!contactId) return res.json({ ok: false, reason: 'no contactId' });
    await db.limpiarContactoDB(contactId);
    res.json({ ok: true, contactId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── WEBHOOK ROUTES ───────────────────────────────────────────────────────────

app.post('/webhook/ghl', ghlWebhookHandler);
app.post('/webhook/wompi', wompiWebhookHandler);
app.get('/pago-exitoso', pagoExitosoHandler);

// ─── BOOT ─────────────────────────────────────────────────────────────────────

db.initDB().then(() => {
  app.listen(env.port, () => console.log(`Servidor corriendo en puerto ${env.port}`));
}).catch(err => { console.error('Error DB:', err); process.exit(1); });
