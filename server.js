'use strict';

const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');

// ─── CONFIG & DB ─────────────────────────────────────────────────────────────
const { env, constants } = require('./config');
const db = require('./db');

// ─── SERVICES ────────────────────────────────────────────────────────────────
const ghl = require('./services/ghl');
const zoho = require('./services/zoho');
const pagos = require('./services/pagos');
const timers = require('./services/timers');

// ─── AI ──────────────────────────────────────────────────────────────────────
const { buildSystemPrompt } = require('./ai/prompt');
const { callClaude } = require('./ai/claude');

// ─── EXPRESS ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/public', express.static('public'));

// ─── HELPERS (webhook-local) ──────────────────────────────────────────────────
const humanDelay = () => new Promise(r => setTimeout(r, Math.floor(Math.random() * 3000) + 3000)); // 3-6 seconds

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────
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
    try {
      await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['escalado nhck'] }),
      });
    } catch (e) {}
    const convRes = await fetch(`https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&locationId=${env.ghlLocationId}`, {
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
    });
    const convData = await convRes.json();
    const conversationId = convData.conversations?.[0]?.id;
    if (!conversationId) return res.status(400).send('No se encontró conversación para este contacto');
    const triaje = { triaje1: 'Atención/concentración', triaje2: 'Más de 1 año', triaje3: 'Nada aún' };
    const fechaCita = '2026-06-10';
    const horaCita = '14:00';
    const nombreNino = 'Felipe Test';
    const referencia = `NHCK-TEST-${contactId}-${Date.now()}`;
    const contactRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' },
    });
    const contactData = await contactRes.json();
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
    try {
      await fetch(`https://services.leadconnectorhq.com/contacts/${req.params.contactId}/tags`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['escalado nhck'] }),
      });
    } catch (e) {}
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

// ─── MESSAGE DEDUP (webhook-local state) ──────────────────────────────────────
const messageBuffers = {};

// ─── WEBHOOK GHL ──────────────────────────────────────────────────────────────
app.post('/webhook/ghl', async (req, res) => {
  res.json({ success: true, received: true });

  try {
    const contactId = req.body.contactId || req.body.customData?.contactId || req.body.contact_id || req.body.contact?.id;
    if (!contactId) return;

    let conversationId = req.body.conversationId || req.body.customData?.conversationId || '';
    let messageBody = req.body.message?.body || req.body.customData?.message || '';
    const messageId = req.body.message?.id || req.body.customData?.messageId || null;
    const messageType = String(req.body.customData?.messageType || req.body.message?.type || req.body.type || '');
    const imageUrl = req.body.customData?.attachments || null;
    // messageType=19 comes in ALL GHL messages — not reliable
    // Only detect image when there is a real attachment URL
    const isImage = !!imageUrl;
    const isAudio = messageType === '2' || messageType === 'AUDIO';

    // DEBUG: full log per webhook
    console.log('WEBHOOK:', JSON.stringify({ contactId, messageType, isImage, isAudio, messageBody: (messageBody || '').substring(0, 30), imageUrl }));

    if (isImage && !conversationId) {
      conversationId = await ghl.getConversationId(contactId);
      console.log('IMAGEN: conversationId recuperado:', conversationId);
    }

    // Deduplication
    const msgSnippet = isImage ? 'img' : isAudio ? 'audio' : (messageBody || '').trim().substring(0, 15) || 'nomsg';
    const dedupKey = `proc_${contactId}_${msgSnippet}`;
    if (messageBuffers[dedupKey]) {
      console.log(`DEDUP: ignorado (${dedupKey})`);
      return;
    }
    messageBuffers[dedupKey] = true;
    setTimeout(() => { delete messageBuffers[dedupKey]; }, 6000);

    if (!conversationId) {
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 2000));
        conversationId = await ghl.getConversationId(contactId);
        if (conversationId) break;
      }
    }
    if (!conversationId) return;

    const convData = await db.getConversationData(conversationId);
    timers.limpiarTimers(conversationId);

    const contactData = await ghl.getContact(contactId);
    if (contactData.deleted) { await db.limpiarContactoDB(contactId); return; }

    const contact = contactData.contact || {};
    const tags = contact.tags || [];
    const estado = convData?.estado || 'nuevo';

    // AUDIOS — escalate immediately, do NOT close conversation
    if (isAudio) {
      console.log('AUDIO RECIBIDO — escalando');
      if (!tags.includes('escalado nhck')) {
        await ghl.addTag(contactId, 'escalado nhck');
        await db.saveConversationData(conversationId, contactId, convData?.messages || [], convData?.triaje || {}, 'escalado', messageId, contact.phone || '');
        await humanDelay();
        await ghl.sendMessage(conversationId, 'Recibí tu mensaje de voz 😊 En un momento un asesor de nuestro equipo te atiende por aquí.', contactId);
      }
      return;
    }

    // If escalated, do not reply (except image in esperando_pago)
    if (tags.includes('escalado nhck') && !(isImage && estado === 'esperando_pago')) return;

    let lastMsg = messageBody;
    let lastMsgId = messageId;
    if (!lastMsg && !isImage) {
      const fetched = await ghl.getLastMessage(conversationId);
      lastMsg = fetched.body;
      lastMsgId = fetched.id;
    }

    // IMAGE IN esperando_pago
    if (isImage && estado === 'esperando_pago') {
      console.log('IMAGEN RECIBIDA en esperando_pago — procesando comprobante');
      await humanDelay();
      const nombre = contact.firstName || '';
      const triaje = convData?.triaje || {};
      const history = convData?.messages || [];
      const phone = contact.phone || '';

      const pago = await db.getPendingPaymentsByContact(contactId);

      if (pago) {
        const mesesN = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
        const [, mm, dd] = (pago.fecha_cita || '').split('-');
        const fechaL = pago.fecha_cita ? `${parseInt(dd)} de ${mesesN[parseInt(mm) - 1]}` : 'la fecha acordada';
        const [hh, min] = (pago.hora_cita || '00:00').split(':');
        const hN = parseInt(hh);
        const horaL = `${hN > 12 ? hN - 12 : hN === 0 ? 12 : hN}:${min}${hN < 12 ? 'am' : 'pm'}`;
        const nombrePago = pago.nombre || nombre;

        let resultado = null;
        try {
          resultado = await zoho.crearEnAnamnesis({
            nombreNino: pago.nombre_nino || contact.firstName || '',
            email: contact.email || '', movil: contact.phone || '', contactIdGHL: contactId,
            edad: pago.edad, sintoma: pago.sintoma, genero: pago.genero,
            estudia: pago.ocupacion === 'Estudiante de colegio',
          });
        } catch (err) { console.error('Error Anamnesis:', err.message); }

        try {
          await zoho.crearCitasCalendario({
            movil: contact.phone || '', email: contact.email || '',
            fechaISO: pago.fecha_cita, horaInicio: pago.hora_cita,
            contactoID: resultado?.contactoID || null, nombreNino: pago.nombre_nino || '',
          });
          await db.deleteAvailabilityCache(pago.fecha_cita);
        } catch (err) { console.error('Error Citas:', err.message); }

        await ghl.addTag(contactId, 'escalado nhck');
        await ghl.addTag(contactId, 'validar pago nhck');
        ghl.actualizarEtapaOportunidad(contactId, constants.STAGE_LINK_PAGO).catch(() => {});
        timers.limpiarTimers(conversationId);
        await db.logEvent(contactId, conversationId, 'comprobante_recibido', { imageUrl });
        await db.saveConversationData(conversationId, contactId, history, triaje, 'escalado', lastMsgId, phone);
        await ghl.sendMessages(conversationId, [
          `¡Gracias ${nombrePago}! Recibimos tu comprobante 📋`,
          `Tu cita para el ${fechaL} a las ${horaL} está reservada. Un asesor validará el pago y te confirmará en breve 🙌`,
          `¡Que tengas un excelente día! 😊`,
        ], contactId);
      } else {
        await ghl.addTag(contactId, 'escalado nhck');
        await ghl.addTag(contactId, 'validar pago nhck');
        await db.saveConversationData(conversationId, contactId, convData?.messages || [], convData?.triaje || {}, 'escalado', lastMsgId, contact.phone || '');
        await ghl.sendMessages(conversationId, [
          `¡Gracias! Recibimos tu comprobante 📋`,
          `Un asesor lo revisará y te confirmará tu cita en breve 🙌`,
        ], contactId);
      }
      return;
    }

    // Ignore image in other states
    if (isImage) return;
    if (!lastMsg) return;

    const nombre = contact.firstName || '';
    const phone = contact.phone || '';
    const triaje = convData?.triaje || {};
    let history = convData?.messages || [];

    // Clean up old records by phone
    if (!convData && phone) {
      try {
        const resViejos = await db.pool.query(
          'SELECT conversation_id, contact_id FROM conversations WHERE phone=$1 AND contact_id!=$2',
          [phone, contactId]
        );
        for (const row of resViejos.rows) {
          await db.pool.query('DELETE FROM conversations WHERE conversation_id=$1', [row.conversation_id]);
          await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [row.contact_id]);
          await db.pool.query('DELETE FROM pending_payments WHERE contact_id=$1', [row.contact_id]);
        }
      } catch (err) { console.error('Error limpiando registros viejos:', err.message); }
    }

    console.log('ESTADO:', estado, '| CONTACTO:', nombre || contactId);

    if (!convData) {
      ghl.crearOportunidad(contactId, `${contact.firstName || ''} ${contact.lastName || ''}`.trim(), constants.STAGE_INICIO).catch(() => {});
    }

    // Reset command
    if (lastMsg.trim().toLowerCase() === '/reset') {
      await db.limpiarContactoDB(contactId);
      await ghl.removeTag(contactId, 'escalado nhck');
      await ghl.sendMessage(conversationId, '✓ Conversación reiniciada', contactId);
      return;
    }

    history.push({ role: 'user', content: [{ type: 'text', text: lastMsg }] });
    if (history.length > 20) history = history.slice(-20);

    // Availability
    let disponibilidadTexto = '';
    if (estado === 'agendando' || estado === 'triaje_completo') {
      try {
        const hoy = new Date();
        const mesesN = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
        const diasN = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
        let offset = 1, diasOk = 0;
        while (diasOk < 3 && offset <= 14) {
          const f = new Date(hoy); f.setDate(hoy.getDate() + offset);
          const ds = f.getDay();
          if (constants.HORARIOS_NHCK[ds]) {
            const fISO = f.toISOString().split('T')[0];
            let citas = await db.getCachedDisponibilidad(fISO);
            if (!citas) { citas = await zoho.getDisponibilidad(fISO); await db.setCachedDisponibilidad(fISO, citas); }
            const slots = zoho.calcularSlotsLibres(citas, fISO);
            if (slots.length > 0) {
              disponibilidadTexto += `${diasN[ds]} ${f.getDate()} de ${mesesN[f.getMonth()]} (${fISO}): ${slots.slice(0, 4).map(s => s.label).join(', ')}\n`;
              diasOk++;
            }
          }
          offset++;
        }
        if (!disponibilidadTexto) disponibilidadTexto = 'Sin disponibilidad próximos días.';
      } catch (err) { disponibilidadTexto = 'No consultada. Intenta más tarde.'; }
    }

    const systemPrompt = buildSystemPrompt(estado, { nombre, triaje, disponibilidadTexto });
    const rawReply = await callClaude(systemPrompt, history);

    let nuevoEstado = estado;
    let nuevoTriaje = { ...triaje };

    // Nombre padre
    const matchNombrePadre = rawReply.match(/\[NOMBRE_PADRE:\s*(.+?)\]/);
    if (matchNombrePadre && estado === 'nuevo') {
      const nombreCapturado = matchNombrePadre[1].trim();
      nuevoEstado = 'triaje_p1';
      try {
        const partes = nombreCapturado.split(' ');
        await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
          body: JSON.stringify({ firstName: partes[0], lastName: partes.slice(1).join(' ') || '' }),
        });
        await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
      } catch (e) {}
    }

    const matchP1 = rawReply.match(/\[TRIAJE_P1:\s*(.+?)\]/);
    const matchP2 = rawReply.match(/\[TRIAJE_P2:\s*(.+?)\]/);
    const matchP3 = rawReply.match(/\[TRIAJE_P3:\s*(.+?)\]/);
    const triajeCompleto = rawReply.includes('[TRIAJE_COMPLETO]');

    if (matchP1) { nuevoTriaje.triaje1 = matchP1[1].trim(); nuevoEstado = 'triaje_p2'; }
    if (matchP2) { nuevoTriaje.triaje2 = matchP2[1].trim(); nuevoEstado = 'triaje_p3'; }
    if (matchP3) { nuevoTriaje.triaje3 = matchP3[1].trim(); }
    if (triajeCompleto) {
      nuevoEstado = 'triaje_completo';
      ghl.addTag(contactId, `nhck-triaje-${nuevoTriaje.triaje1?.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 20) || 'ok'}`).catch(() => {});
      ghl.actualizarEtapaOportunidad(contactId, constants.STAGE_INICIO).catch(() => {});
    }

    // Appointment confirmed
    if (rawReply.includes('[CITA_CONFIRMADA]')) {
      const extract = f => { const m = rawReply.match(new RegExp(`${f}:\\s*(.+)`)); return m ? m[1].trim() : ''; };
      const fechaCita = extract('fecha'), horaCita = extract('hora');
      const nombreNino = extract('nombre_nino'), edad = extract('edad');
      const genero = extract('genero');
      const estudia = ['si', 'sí'].includes(extract('estudia').toLowerCase());
      const emailCita = extract('email') || contact.email || '';
      const nombrePadreCita = extract('nombre_padre') || `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
      const ciudadCita = extract('ciudad') || contact.city || '';

      const ghlUpdate = {};
      if (emailCita && emailCita !== contact.email) ghlUpdate.email = emailCita;
      if (ciudadCita) ghlUpdate.city = ciudadCita;
      if (nombrePadreCita) {
        const partes = nombrePadreCita.trim().split(' ');
        ghlUpdate.firstName = partes[0] || contact.firstName || '';
        ghlUpdate.lastName = partes.slice(1).join(' ') || contact.lastName || '';
      }
      if (Object.keys(ghlUpdate).length > 0) {
        fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
          method: 'PUT', headers: { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
          body: JSON.stringify(ghlUpdate),
        }).catch(() => {});
        await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});
      }

      await ghl.guardarCamposNinoGHL(contactId, { nombreNino, edadNino: edad, generoNino: genero, estudia, sintoma: nuevoTriaje.triaje1 });
      ghl.actualizarEtapaOportunidad(contactId, constants.STAGE_INFO_COMPLETA).catch(() => {});

      const referencia = `NHCK-${contactId}-${Date.now()}`;
      await db.logEvent(contactId, conversationId, 'cita_confirmada', { fechaCita, horaCita, referencia });

      let linkPago = null;
      try {
        const pagoResult = await pagos.generarLinkPago({
          referencia, monto: 100000,
          nombre: nombrePadreCita || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          email: emailCita || contact.email || '', telefono: contact.phone || '',
        });
        linkPago = pagoResult.url;
        const contactConDatos = { ...contact, email: emailCita || contact.email || '', city: ciudadCita || contact.city || '' };
        await db.savePendingPayment(referencia, {
          contactId, conversationId, contact: contactConDatos, fechaCita, horaCita,
          edad, genero, ocupacion: ghl.mapearOcupacionNino(estudia), sintoma: nuevoTriaje.triaje1,
          nombreNino, nombre: nombrePadreCita || nombre, paymentLinkId: pagoResult.linkId,
        });
      } catch (err) {
        const contactConDatos = { ...contact, email: emailCita || contact.email || '' };
        await db.savePendingPayment(referencia, {
          contactId, conversationId, contact: contactConDatos, fechaCita, horaCita,
          edad, genero, ocupacion: ghl.mapearOcupacionNino(estudia), sintoma: nuevoTriaje.triaje1,
          nombreNino, nombre: nombrePadreCita || nombre, paymentLinkId: null,
        });
      }

      history.push({ role: 'assistant', content: [{ type: 'text', text: 'Cita confirmada, preguntando medio de pago.' }] });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', lastMsgId, phone);
      await humanDelay();
      await ghl.sendMessage(conversationId,
        `Para confirmar tu cupo necesitamos la reserva de $100.000 💳\n¿Cuál medio de pago te queda más fácil?\n\n1️⃣ Link de pago virtual (Wompi)\n2️⃣ Transferencia / consignación Bancolombia\n3️⃣ QR de pago`,
        contactId);
      ghl.actualizarEtapaOportunidad(contactId, constants.STAGE_LINK_PAGO).catch(() => {});
      timers.iniciarTimersInactividad(conversationId, contactId);
      return;
    }

    // Payment methods
    if (estado === 'esperando_pago') {
      const pending = await db.getPendingPaymentsByContact(contactId);

      if (rawReply.includes('[MEDIO_WOMPI]') && pending) {
        const pagoResult = await pagos.generarLinkPago({
          referencia: pending.referencia, monto: 100000,
          nombre: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          email: pending.contact_data?.email || contact.email || '', telefono: contact.phone || '',
        }).catch(() => null);
        const linkPago = pagoResult?.url;
        await humanDelay();
        if (linkPago) {
          await ghl.sendMessages(conversationId, [
            `Aquí tienes tu link de pago seguro 👇\n${linkPago}`,
            `Una vez completado te envío los detalles de tu cita 🙌`,
          ], contactId);
        }
        await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', lastMsgId, phone);
        return;
      }

      if (rawReply.includes('[MEDIO_TRANSFERENCIA]')) {
        await humanDelay();
        await ghl.sendMessages(conversationId, [
          `Puedes hacer la transferencia o consignación por $100.000 a esta cuenta 👇`,
          `Bancolombia — Cuenta de Ahorros\nNúmero: 90790901451\nLlave: 0090435866\nA nombre de: Visión Integral Transformación Personal y Organizacional SAS\nNIT: 901164425`,
          `Una vez realizado el pago envíame aquí la foto del comprobante y confirmo tu cita 📸`,
        ], contactId);
        await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', lastMsgId, phone);
        return;
      }

      if (rawReply.includes('[MEDIO_QR]')) {
        await humanDelay();
        await ghl.sendMessages(conversationId, [
          `Aquí está el QR para pagar $100.000 👇\nhttps://neurohackingcenter.co/wp-content/uploads/2026/05/WhatsApp-Image-2026-05-29-at-11.00.03-AM.jpeg`,
          `Ábrelo, toma captura y escanéalo con tu app bancaria 📱\nO usa la llave Bancolombia: 0090435866`,
          `Cuando pagues envíame el comprobante aquí y confirmo tu cita 📸`,
        ], contactId);
        await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', lastMsgId, phone);
        return;
      }
    }

    // City not available
    if (rawReply.includes('[CIUDAD_NO_DISPONIBLE]')) {
      const replyLimpio = rawReply.replace(/\[CIUDAD_NO_DISPONIBLE\]/g, '').trim();
      const partes = replyLimpio.split('---').map(p => p.trim()).filter(p => p.length > 0);
      history.push({ role: 'assistant', content: [{ type: 'text', text: replyLimpio }] });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'escalado', lastMsgId, phone);
      await ghl.addTag(contactId, 'escalado nhck');
      await humanDelay();
      await ghl.sendMessages(conversationId, partes, contactId);
      return;
    }

    // Escalate — do NOT start inactivity timers
    if (rawReply.includes('[ESCALAR]')) {
      await ghl.addTag(contactId, 'escalado nhck');
      await db.logEvent(contactId, conversationId, 'escalado', { motivo: lastMsg });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'escalado', lastMsgId, phone);
      await humanDelay();
      const replyLimpio = rawReply.replace(/\[ESCALAR\]/g, '').trim();
      if (replyLimpio) {
        const partes = replyLimpio.split('---').map(p => p.trim()).filter(p => p.length > 0);
        await ghl.sendMessages(conversationId, partes, contactId);
      } else {
        await ghl.sendMessage(conversationId, 'En un momento un asesor de nuestro equipo te atiende por aquí 🙌', contactId);
      }
      return;
    }

    // Normal reply
    const reply = rawReply
      .replace(/\[TRIAJE_P[123]:[^\]]+\]/g, '')
      .replace(/\[TRIAJE_COMPLETO\]/g, '')
      .replace(/\[NOMBRE_PADRE:[^\]]+\]/g, '')
      .replace(/\[MEDIO_WOMPI\]/g, '')
      .replace(/\[MEDIO_TRANSFERENCIA\]/g, '')
      .replace(/\[MEDIO_QR\]/g, '')
      .replace(/\[CIUDAD_NO_DISPONIBLE\]/g, '')
      .replace(/\[ESCALAR\]/g, '')
      .split('\n').filter(l => l.trim() !== '').join('\n');

    const partes = reply.split('---').map(p => p.trim()).filter(p => p.length > 0);
    history.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
    await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, nuevoEstado, lastMsgId, phone);
    await humanDelay();
    await ghl.sendMessages(conversationId, partes, contactId);
    timers.iniciarTimersInactividad(conversationId, contactId);
    console.log('RESPUESTA OK:', { reply: reply?.substring(0, 60), estado: nuevoEstado });

  } catch (error) {
    console.error('Error webhook GHL:', error.message);
  }
});

// ─── WEBHOOK WOMPI ────────────────────────────────────────────────────────────
app.post('/webhook/wompi', async (req, res) => {
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
});

app.get('/pago-exitoso', (req, res) => {
  res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:3rem">¡Pago recibido! Tu cita está confirmada. Puedes cerrar esta ventana.</h2>');
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────
db.initDB().then(() => {
  app.listen(env.port, () => console.log(`Servidor corriendo en puerto ${env.port}`));
}).catch(err => { console.error('Error DB:', err); process.exit(1); });
