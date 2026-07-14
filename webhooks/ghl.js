'use strict';

const fetch = require('node-fetch');
const { env, constants } = require('../config');
const db = require('../db');
const ghl = require('../services/ghl');
const zoho = require('../services/zoho');
const pagos = require('../services/pagos');
const timers = require('../services/timers');
const { buildSystemPrompt } = require('../ai/prompt');
const { callClaude } = require('../ai/claude');
const { triggerAnalysis, triggerAsesorAnalysis } = require('../jobs/insightJob');
const { notifyError } = require('../services/notifier');
const whisper = require('../services/whisper');

// ─── MODULE-LOCAL STATE ───────────────────────────────────────────────────────

/** Deduplication map: prevents double-processing the same message. */
const messageBuffers = {};

/** Per-conversation 30-second debounce: accumulates bursts before calling Claude. */
const textQueues = {};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Random human-like delay between 3 and 6 seconds. */
const humanDelay = () => new Promise(r => setTimeout(r, Math.floor(Math.random() * 3000) + 3000));

// ─── TEXT QUEUE PROCESSOR ────────────────────────────────────────────────────

/**
 * Called by the 30-second debounce timer. Re-fetches fresh state, combines
 * accumulated message bodies, and runs the full Claude response pipeline.
 */
async function flushTextQueue(conversationId) {
  const entry = textQueues[conversationId];
  delete textQueues[conversationId];
  if (!entry || !entry.bodies.length) return;

  const { contactId, bodies } = entry;
  const combinedMsg = bodies.join('\n');

  try {
    // skipCache: tags may have been changed manually in GHL (advisor escalation)
    // since this contact was last cached — this gate must see the live state.
    const contactData = await ghl.getContact(contactId, true);
    if (contactData.deleted) { await db.limpiarContactoDB(contactId); return; }

    const contact = contactData.contact || {};
    const tags = contact.tags || [];

    if (tags.includes('escalado nhck')) {
      triggerAsesorAnalysis(conversationId, contactId);
      return;
    }

    const channel = await ghl.getConversationChannel(contactId).catch(() => 'WhatsApp');
    const convData = await db.getConversationData(conversationId);
    const estado = convData?.estado || 'nuevo';
    const triaje = convData?.triaje || {};
    let history = convData?.messages || [];
    const nombre = contact.firstName || '';
    const phone = contact.phone || '';

    history.push({ role: 'user', content: [{ type: 'text', text: combinedMsg }] });
    if (history.length > 20) history = history.slice(-20);

    // Availability
    let disponibilidadTexto = '';
    if (estado === 'agendando' || estado === 'triaje_completo') {
      try {
        const hoy = new Date();
        const mesesN = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
        const diasN = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
        for (let offset = 1; offset <= 14; offset++) {
          const f = new Date(hoy); f.setDate(hoy.getDate() + offset);
          const ds = f.getDay();
          if (constants.HORARIOS_NHCK[ds]) {
            const fISO = f.toISOString().split('T')[0];
            let citas = await db.getCachedDisponibilidad(fISO);
            if (!citas) { citas = await zoho.getDisponibilidad(fISO); await db.setCachedDisponibilidad(fISO, citas); }
            const slots = zoho.calcularSlotsLibres(citas, fISO);
            if (slots.length > 0) {
              disponibilidadTexto += `${diasN[ds]} ${f.getDate()} de ${mesesN[f.getMonth()]} (${fISO}): ${slots.slice(0, 4).map(s => s.label).join(', ')}\n`;
            }
          }
        }
        if (!disponibilidadTexto) disponibilidadTexto = 'Sin disponibilidad próximos 14 días.';
      } catch (err) { disponibilidadTexto = 'No consultada. Intenta más tarde.'; }
    }

    const derivadoA = convData?.derivado_a || null;
    const systemPrompt = await buildSystemPrompt(estado, { nombre, triaje, disponibilidadTexto, derivadoA });
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

    const matchCiudad = rawReply.match(/\[CIUDAD_VALIDA:\s*(.+?)\]/);
    if (matchCiudad) {
      ghl.guardarCiudadGHL(contactId, matchCiudad[1].trim()).catch(() => {});
    }

    const matchP1 = rawReply.match(/\[TRIAJE_P1:\s*(.+?)\]/);
    const matchP2 = rawReply.match(/\[TRIAJE_P2:\s*(.+?)\]/);
    const matchP3 = rawReply.match(/\[TRIAJE_P3:\s*(.+?)\]/);
    const triajeCompleto = rawReply.includes('[TRIAJE_COMPLETO]');

    if (matchP1) {
      nuevoTriaje.triaje1 = matchP1[1].trim();
      nuevoEstado = 'triaje_p2';
      // Derivado a Luisa: la opción viene de sus categorías de adulto, no de
      // las de niño — tiene que ir por su mapper al campo de adulto.
      if (derivadoA === 'luisa') {
        ghl.guardarSintomaAdultoGHL(contactId, matchP1[1].trim()).catch(() => {});
      } else {
        ghl.guardarSintomaGHL(contactId, matchP1[1].trim()).catch(() => {});
      }
    }
    if (matchP2) { nuevoTriaje.triaje2 = matchP2[1].trim(); nuevoEstado = 'triaje_p3'; }
    if (matchP3) { nuevoTriaje.triaje3 = matchP3[1].trim(); }
    if (triajeCompleto) {
      nuevoEstado = 'triaje_completo';
      ghl.addTag(contactId, `nhck-triaje-${nuevoTriaje.triaje1?.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 20) || 'ok'}`).catch(() => {});
      ghl.actualizarEtapaOportunidad(contactId, constants.STAGE_INFO_COMPLETA).catch(() => {});
    }

    // Appointment confirmed
    if (rawReply.includes('[CITA_CONFIRMADA]')) {
      const extract = f => { const m = rawReply.match(new RegExp(`${f}:\\s*(.+)`)); return m ? m[1].trim() : ''; };
      const esAdultoCita = derivadoA === 'luisa';
      const fechaCita = extract('fecha'), horaCita = extract('hora');
      const edad = extract('edad');
      const genero = extract('genero');
      const emailCita = extract('email') || contact.email || '';
      const ciudadCita = extract('ciudad') || contact.city || '';

      // Field names in [CITA_CONFIRMADA] differ by persona — see prompt.js
      // PASO 5 (kid format vs Luisa's adult format).
      const nombreNino = esAdultoCita ? '' : extract('nombre_nino');
      const estudia = esAdultoCita ? false : ['si', 'sí'].includes(extract('estudia').toLowerCase());
      const documentoIdentidad = esAdultoCita ? extract('documento_identidad') : '';
      const nombreContactoCita = esAdultoCita
        ? (extract('nombre_paciente') || `${contact.firstName || ''} ${contact.lastName || ''}`.trim())
        : (extract('nombre_padre') || `${contact.firstName || ''} ${contact.lastName || ''}`.trim());

      const ghlUpdate = {};
      if (emailCita && emailCita !== contact.email) ghlUpdate.email = emailCita;
      if (ciudadCita) ghlUpdate.city = ciudadCita;
      if (nombreContactoCita) {
        const partes = nombreContactoCita.trim().split(' ');
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

      if (esAdultoCita) {
        await ghl.guardarCamposPacienteGHL(contactId, { edad, documentoIdentidad, sintoma: nuevoTriaje.triaje1 });
      } else {
        await ghl.guardarCamposNinoGHL(contactId, { nombreNino, edadNino: edad, generoNino: genero, estudia, sintoma: nuevoTriaje.triaje1 });
      }
      ghl.actualizarEtapaOportunidad(contactId, constants.STAGE_LINK_PAGO).catch(() => {});

      const referencia = `${esAdultoCita ? 'NHC' : 'NHCK'}-${contactId}-${Date.now()}`;
      await db.logEvent(contactId, conversationId, 'cita_confirmada', { fechaCita, horaCita, referencia });

      const ocupacion = esAdultoCita ? null : ghl.mapearOcupacionNino(estudia);
      try {
        const pagoResult = await pagos.generarLinkPago({
          referencia, monto: 100000,
          nombre: nombreContactoCita || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          email: emailCita || contact.email || '', telefono: contact.phone || '',
        });
        const contactConDatos = { ...contact, email: emailCita || contact.email || '', city: ciudadCita || contact.city || '' };
        await db.savePendingPayment(referencia, {
          contactId, conversationId, contact: contactConDatos, fechaCita, horaCita,
          edad, genero, ocupacion, sintoma: nuevoTriaje.triaje1,
          nombreNino: esAdultoCita ? nombreContactoCita : nombreNino, nombre: nombreContactoCita || nombre, paymentLinkId: pagoResult.linkId,
        });
      } catch (err) {
        const contactConDatos = { ...contact, email: emailCita || contact.email || '' };
        await db.savePendingPayment(referencia, {
          contactId, conversationId, contact: contactConDatos, fechaCita, horaCita,
          edad, genero, ocupacion, sintoma: nuevoTriaje.triaje1,
          nombreNino: esAdultoCita ? nombreContactoCita : nombreNino, nombre: nombreContactoCita || nombre, paymentLinkId: null,
        });
      }

      history.push({ role: 'assistant', content: [{ type: 'text', text: 'Cita confirmada, preguntando medio de pago.' }] });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', null, phone);
      await humanDelay();
      await ghl.sendMessage(conversationId,
        `Para confirmar tu cupo necesitamos un abono de $100.000 💳\nEl saldo restante ($295.000) se cancela el día de la cita.\n¿Cuál medio de pago te queda más fácil?\n\n1️⃣ Link de pago virtual (Wompi)\n2️⃣ Transferencia / consignación Bancolombia\n3️⃣ QR de pago`,
        contactId);
      ghl.actualizarEtapaOportunidad(contactId, constants.STAGE_LINK_PAGO).catch(() => {});
      timers.iniciarTimersInactividad(conversationId, contactId, ghl.sendMessage, async (convId, ctId) => {
        await db.marcarCerrado(convId);
        triggerAnalysis(convId, ctId || contactId, 'inactividad');
      });
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
          ], contactId, channel);
        }
        await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', null, phone);
        return;
      }

      if (rawReply.includes('[MEDIO_TRANSFERENCIA]')) {
        await humanDelay();
        await ghl.sendMessages(conversationId, [
          `Puedes hacer la transferencia o consignación por $100.000 a esta cuenta 👇`,
          `Bancolombia — Cuenta de Ahorros\nNúmero: 90790901451\nLlave: 0090435866\nA nombre de: Visión Integral Transformación Personal y Organizacional SAS\nNIT: 901164425`,
          `Una vez realizado el pago envíame aquí la foto del comprobante y confirmo tu cita 📸`,
        ], contactId, channel);
        await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', null, phone);
        return;
      }

      if (rawReply.includes('[MEDIO_QR]')) {
        await humanDelay();
        await ghl.sendMessages(conversationId, [
          `Aquí está el QR para pagar $100.000 👇\nhttps://neurohackingcenter.co/wp-content/uploads/2026/05/WhatsApp-Image-2026-05-29-at-11.00.03-AM.jpeg`,
          `Ábrelo, toma captura y escanéalo con tu app bancaria 📱\nO usa la llave Bancolombia: 0090435866`,
          `Cuando pagues envíame el comprobante aquí y confirmo tu cita 📸`,
        ], contactId, channel);
        await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', null, phone);
        return;
      }
    }

    // Cierre: ciudad fuera de cobertura
    if (rawReply.includes('[CIUDAD_NO_DISPONIBLE]')) {
      const replyLimpio = rawReply.replace(/\[CIUDAD_NO_DISPONIBLE\]/g, '').trim();
      const partes = replyLimpio.split('---').map(p => p.trim()).filter(p => p.length > 0);
      history.push({ role: 'assistant', content: [{ type: 'text', text: replyLimpio }] });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'cerrado', null, phone);
      await ghl.addTag(contactId, 'fuera-ciudad nhck');
      await db.logEvent(contactId, conversationId, 'cierre_fuera_ciudad', {});
      triggerAnalysis(conversationId, contactId, 'fuera_ciudad');
      await humanDelay();
      await ghl.sendMessages(conversationId, partes, contactId, channel);
      return;
    }

    // Cierre: sin presupuesto
    if (rawReply.includes('[SIN_PRESUPUESTO]')) {
      const replyLimpio = rawReply.replace(/\[SIN_PRESUPUESTO\]/g, '').trim();
      const partes = replyLimpio.split('---').map(p => p.trim()).filter(p => p.length > 0);
      history.push({ role: 'assistant', content: [{ type: 'text', text: replyLimpio }] });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'cerrado', null, phone);
      await ghl.addTag(contactId, 'sin-presupuesto nhck');
      await db.logEvent(contactId, conversationId, 'cierre_sin_presupuesto', {});
      triggerAnalysis(conversationId, contactId, 'sin_presupuesto');
      await humanDelay();
      await ghl.sendMessages(conversationId, partes, contactId, channel);
      return;
    }

    // Cierre: fuera de segmento (edad mínima, no lee)
    if (rawReply.includes('[FUERA_SEGMENTO]')) {
      const replyLimpio = rawReply.replace(/\[FUERA_SEGMENTO\]/g, '').trim();
      const partes = replyLimpio.split('---').map(p => p.trim()).filter(p => p.length > 0);
      history.push({ role: 'assistant', content: [{ type: 'text', text: replyLimpio }] });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'cerrado', null, phone);
      await ghl.addTag(contactId, 'fuera-segmento nhck');
      await db.logEvent(contactId, conversationId, 'cierre_fuera_segmento', {});
      triggerAnalysis(conversationId, contactId, 'fuera_segmento');
      await humanDelay();
      await ghl.sendMessages(conversationId, partes, contactId, channel);
      return;
    }

    // Adulto detectado → Luisa sigue la conversación en este mismo hilo
    // (mismo número, no requiere plantilla de WhatsApp de Meta). NO se marca
    // como 'escalado': el bot sigue respondiendo activamente, ahora como Luisa.
    if (rawReply.includes('[NHC_ADULTOS]')) {
      const replyLimpio = rawReply.replace(/\[NHC_ADULTOS\]/g, '').trim();
      const partes = replyLimpio.split('---').map(p => p.trim()).filter(p => p.length > 0);
      history.push({ role: 'assistant', content: [{ type: 'text', text: replyLimpio }] });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'triaje_p1', null, phone);
      await db.setDerivadoA(conversationId, 'luisa');
      await ghl.addTag(contactId, 'nhc-adultos');
      await ghl.addTag(contactId, 'escalado nhck-a-nhc');
      await db.logEvent(contactId, conversationId, 'derivado_nhck_a_nhc', {});
      await humanDelay();
      await ghl.sendMessages(conversationId, partes, contactId, channel);
      return;
    }

    // Escalate — do NOT start inactivity timers
    if (rawReply.includes('[ESCALAR]')) {
      await ghl.addTag(contactId, 'escalado nhck');
      await db.logEvent(contactId, conversationId, 'escalado', { motivo: combinedMsg });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'escalado', null, phone);
      triggerAnalysis(conversationId, contactId, 'escalado');
      await humanDelay();
      const replyLimpio = rawReply.replace(/\[ESCALAR\]/g, '').trim();
      if (replyLimpio) {
        const partes = replyLimpio.split('---').map(p => p.trim()).filter(p => p.length > 0);
        await ghl.sendMessages(conversationId, partes, contactId, channel);
      } else {
        await ghl.sendMessage(conversationId, 'En un momento un asesor de nuestro equipo te atiende por aquí 🙌', contactId, channel);
      }
      return;
    }

    // Deferred — user said they'll talk later: suppress timers and recovery for 24h
    if (rawReply.includes('[POSPONER]')) {
      const replyLimpio = rawReply.replace(/\[POSPONER\]/g, '').trim();
      const partes = replyLimpio.split('---').map(p => p.trim()).filter(p => p.length > 0);
      history.push({ role: 'assistant', content: [{ type: 'text', text: replyLimpio }] });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, nuevoEstado, null, phone);
      await db.pool.query(
        'UPDATE conversations SET recovery_status=$1 WHERE conversation_id=$2 AND agent=$3',
        ['pospuesto', conversationId, env.agentName]
      );
      await humanDelay();
      await ghl.sendMessages(conversationId, partes, contactId, channel);
      console.log('POSPONER: timers y recovery suprimidos para', conversationId);
      return;
    }

    // Normal reply
    const reply = rawReply
      .replace(/\[TRIAJE_P[123]:[^\]]+\]/g, '')
      .replace(/\[TRIAJE_COMPLETO\]/g, '')
      .replace(/\[NOMBRE_PADRE:[^\]]+\]/g, '')
      .replace(/\[CIUDAD_VALIDA:[^\]]+\]/g, '')
      .replace(/\[MEDIO_WOMPI\]/g, '')
      .replace(/\[MEDIO_TRANSFERENCIA\]/g, '')
      .replace(/\[MEDIO_QR\]/g, '')
      .replace(/\[CIUDAD_NO_DISPONIBLE\]/g, '')
      .replace(/\[SIN_PRESUPUESTO\]/g, '')
      .replace(/\[FUERA_SEGMENTO\]/g, '')
      .replace(/\[NHC_ADULTOS\]/g, '')
      .replace(/\[ESCALAR\]/g, '')
      .replace(/\[POSPONER\]/g, '')
      .split('\n').filter(l => l.trim() !== '').join('\n');

    const partes = reply.split('---').map(p => p.trim()).filter(p => p.length > 0);
    history.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
    await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, nuevoEstado, null, phone);
    await humanDelay();
    await ghl.sendMessages(conversationId, partes, contactId, channel);
    timers.iniciarTimersInactividad(conversationId, contactId, ghl.sendMessage, async (convId, ctId) => {
      await db.marcarCerrado(convId);
      triggerAnalysis(convId, ctId || contactId, 'inactividad');
    });
    console.log('RESPUESTA OK:', { reply: reply?.substring(0, 60), estado: nuevoEstado });

  } catch (err) {
    console.error('[flushTextQueue] Error:', err.message);
    notifyError('flushTextQueue ' + conversationId, err).catch(() => {});
  }
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

/**
 * POST /webhook/ghl
 * Full GHL state machine: handles incoming WhatsApp messages from GoHighLevel.
 */
async function ghlWebhookHandler(req, res) {
  res.json({ success: true, received: true });

  try {
    const contactId = req.body.contactId || req.body.customData?.contactId || req.body.contact_id || req.body.contact?.id;
    if (!contactId) return;

    let conversationId = req.body.conversationId || req.body.customData?.conversationId || '';
    let messageBody = req.body.message?.body || req.body.customData?.message || '';
    const messageId = req.body.message?.id || req.body.customData?.messageId || null;
    const messageType = String(req.body.customData?.messageType || req.body.message?.type || req.body.type || '');
    let imageUrl = req.body.customData?.attachments || null;
    // messageType=19 is GHL's generic media type — not reliable for distinguishing audio vs image.
    // Detect audio by file extension in the attachment URL instead.
    // When GHL omits the URL entirely (type=19, empty body, empty attachment), flag for API lookup.
    const isPotentialMedia = messageType === '19' && !messageBody && !imageUrl;
    const isAudioUrl = /\.(ogg|opus|mp3|mp4|m4a|wav|webm|aac|amr)(\?|$)/i.test(imageUrl || '');
    const isAudio = messageType === '2' || messageType === 'AUDIO' || isAudioUrl || isPotentialMedia;
    const isImage = !!imageUrl && !isAudio;

    console.log('WEBHOOK:', JSON.stringify({ contactId, messageType, isImage, isAudio, isPotentialMedia, messageBody: (messageBody || '').substring(0, 30), imageUrl }));

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
      // GHL's webhook payload rarely includes conversationId directly, so we fall back
      // to /conversations/search — but that search index lags the real conversation
      // state by an unpredictable amount, even for contacts with an existing, hours-old
      // conversation (observed up to ~20s in production, not just brand-new ad-click
      // contacts). Short in-process retry for the common case; if GHL is still behind
      // after that, hand off to pending_webhooks so jobs/pendingWebhookJob.js keeps
      // trying in the background instead of blocking this request indefinitely (and
      // so the message survives a deploy/restart, unlike an in-memory retry).
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 3000));
        conversationId = await ghl.getConversationId(contactId);
        if (conversationId) break;
      }
    }
    if (!conversationId) {
      console.error(`WEBHOOK: conversationId not found for contactId=${contactId} after retries — queueing for background retry`);
      await db.queuePendingWebhook(contactId, req.body);
      return;
    }

    const channel = await ghl.getConversationChannel(contactId).catch(() => 'WhatsApp');

    let convData = await db.getConversationData(conversationId);
    if (convData?.recovery_status) {
      db.pool.query('UPDATE conversations SET recovery_status=NULL WHERE conversation_id=$1 AND agent=$2', [conversationId, env.agentName]).catch(() => {});
    }
    timers.limpiarTimers(conversationId);

    // If conversation was closed by inactivity and user writes again → restart keeping triaje
    if (convData?.estado === 'cerrado') {
      const t = convData.triaje || {};
      const estadoRetoma = (t.triaje1 && t.triaje2 && t.triaje3)
        ? 'triaje_completo'
        : (t.triaje1 && t.triaje2 ? 'triaje_p3' : (t.triaje1 ? 'triaje_p2' : 'nuevo'));
      await db.pool.query(
        'UPDATE conversations SET estado=$1, messages=\'[]\'::jsonb, recovery_status=NULL, updated_at=NOW() WHERE conversation_id=$2 AND agent=$3',
        [estadoRetoma, conversationId, env.agentName]
      );
      convData = { ...convData, estado: estadoRetoma, messages: [] };
    }

    // skipCache: this fetch gates whether the bot replies at all — tags may
    // have been changed manually in GHL (advisor escalation) since this
    // contact was last cached, so the check must see the live state.
    const contactData = await ghl.getContact(contactId, true);
    if (contactData.deleted) { await db.limpiarContactoDB(contactId); return; }

    const contact = contactData.contact || {};
    const tags = contact.tags || [];
    const estado = convData?.estado || 'nuevo';

    // AUDIOS — transcribe with Whisper, then continue normal flow
    let skipAudioFlow = false;
    if (isAudio) {
      let audioUrl =
        imageUrl ||
        (Array.isArray(req.body.message?.attachments) && req.body.message.attachments[0]) ||
        (typeof req.body.message?.attachments === 'string' && req.body.message.attachments) ||
        (typeof req.body.message?.body === 'string' && req.body.message.body.startsWith('http') && req.body.message.body) ||
        null;

      // GHL webhook omits the media URL for type=19 — fetch from API
      if (!audioUrl && isPotentialMedia) {
        try {
          await new Promise(r => setTimeout(r, 1500)); // brief wait for GHL to index the message
          const lastMsg = await ghl.getLastMessage(conversationId);
          const candidate = lastMsg.attachmentUrl || (lastMsg.body?.startsWith('http') ? lastMsg.body : null);
          if (candidate && /\.(ogg|opus|mp3|mp4|m4a|wav|webm|aac|amr)(\?|$)/i.test(candidate)) {
            audioUrl = candidate;
          } else if (lastMsg.body) {
            // type=19 with real text (e.g. Facebook/Instagram Click-to-WhatsApp ad lead) — not media, treat as text
            console.log('MEDIA19: not audio, using fetched text instead');
            messageBody = lastMsg.body;
            skipAudioFlow = true;
          } else {
            // GHL hasn't indexed the message content yet either — queue for retry
            // instead of dropping (same eventual-consistency issue as conversationId).
            console.log('MEDIA19: no content found yet — queueing for background retry');
            await db.queuePendingWebhook(contactId, req.body);
            return;
          }
        } catch (e) {
          console.error('MEDIA19 lookup error:', e.message);
          await db.queuePendingWebhook(contactId, req.body);
          return;
        }
      }

      if (!skipAudioFlow) {
        console.log('AUDIO RECIBIDO — URL:', audioUrl ? audioUrl.substring(0, 60) : 'NO encontrada');

        if (audioUrl) {
          try {
            const transcription = await whisper.transcribeAudio(audioUrl);
            if (transcription) {
              console.log('AUDIO TRANSCRITO:', transcription.substring(0, 80));
              messageBody = transcription;
              // fall through to normal processing
            } else {
              await humanDelay();
              await ghl.sendMessage(conversationId, 'No pude entender el audio 🎙️ ¿Me lo podés escribir?', contactId, channel);
              return;
            }
          } catch (err) {
            console.error('Whisper error:', err.message);
            if (!tags.includes('escalado nhck')) {
              await ghl.addTag(contactId, 'escalado nhck');
              await db.saveConversationData(conversationId, contactId, convData?.messages || [], convData?.triaje || {}, 'escalado', messageId, contact.phone || '');
              triggerAnalysis(conversationId, contactId, 'audio_escalado');
              await humanDelay();
              await ghl.sendMessage(conversationId, '¡Hola! Por el momento no puedo escuchar audios, pero con gusto te atiendo por escrito. ¿Puedes contarme qué necesitas? Si prefieres, te puedo conectar con un asesor de nuestro equipo 😊', contactId, channel);
            }
            return;
          }
        } else {
          if (!tags.includes('escalado nhck')) {
            await ghl.addTag(contactId, 'escalado nhck');
            await db.saveConversationData(conversationId, contactId, convData?.messages || [], convData?.triaje || {}, 'escalado', messageId, contact.phone || '');
            triggerAnalysis(conversationId, contactId, 'audio_escalado');
            await humanDelay();
            await ghl.sendMessage(conversationId, '¡Hola! Por el momento no puedo escuchar audios, pero con gusto te atiendo por escrito. ¿Puedes contarme qué necesitas? Si prefieres, te puedo conectar con un asesor de nuestro equipo 😊', contactId, channel);
          }
          return;
        }
      }
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
        ghl.actualizarEtapaOportunidad(contactId, constants.STAGE_PAGO_PARCIAL).catch(() => {});
        timers.limpiarTimers(conversationId);
        await db.logEvent(contactId, conversationId, 'comprobante_recibido', { imageUrl });
        await db.saveConversationData(conversationId, contactId, history, triaje, 'escalado', lastMsgId, phone);
        triggerAnalysis(conversationId, contactId, 'pago_manual');
        await ghl.sendMessages(conversationId, [
          `¡Gracias ${nombrePago}! Recibimos tu comprobante 📋`,
          `Ahora mismo no te puedo confirmar el pago porque el área contable no se encuentra disponible. En cuanto lo validen, te confirmamos tu cita para el ${fechaL} a las ${horaL} 🙌`,
          `¡Que tengas un excelente día! 😊`,
        ], contactId, channel);
      } else {
        await ghl.addTag(contactId, 'escalado nhck');
        await ghl.addTag(contactId, 'validar pago nhck');
        await db.saveConversationData(conversationId, contactId, convData?.messages || [], convData?.triaje || {}, 'escalado', lastMsgId, contact.phone || '');
        await ghl.sendMessages(conversationId, [
          `¡Gracias! Recibimos tu comprobante 📋`,
          `Ahora mismo no te lo puedo confirmar porque el área contable no se encuentra disponible. En cuanto lo validen, te confirmamos tu cita 🙌`,
        ], contactId, channel);
      }
      return;
    }

    // Ignore image in other states
    if (isImage) return;
    if (!lastMsg) return;

    const nombre = contact.firstName || '';
    const phone = contact.phone || '';

    // Clean up old records by phone
    if (!convData && phone) {
      try {
        const resViejos = await db.pool.query(
          'SELECT conversation_id, contact_id FROM conversations WHERE phone=$1 AND contact_id!=$2 AND agent=$3',
          [phone, contactId, env.agentName]
        );
        for (const row of resViejos.rows) {
          await db.pool.query('DELETE FROM conversations WHERE conversation_id=$1 AND agent=$2', [row.conversation_id, env.agentName]);
          await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [row.contact_id]);
          await db.pool.query('DELETE FROM pending_payments WHERE contact_id=$1 AND agent=$2', [row.contact_id, env.agentName]);
        }
      } catch (err) { console.error('Error limpiando registros viejos:', err.message); }
    }

    console.log('ESTADO:', estado, '| CONTACTO:', nombre || contactId);

    if (!convData) {
      ghl.crearOportunidad(contactId, `${contact.firstName || ''} ${contact.lastName || ''}`.trim(), constants.STAGE_INICIO).catch(() => {});
      ghl.addTag(contactId, 'cliente-nhck').catch(() => {});
    }

    // Reset command — handled immediately, before queue
    if (lastMsg.trim().toLowerCase() === '/reset') {
      await db.limpiarContactoDB(contactId);
      await ghl.removeTag(contactId, 'escalado nhck');
      await ghl.sendMessage(conversationId, '✓ Conversación reiniciada', contactId, channel);
      return;
    }

    // 30-second debounce: accumulate burst messages before calling Claude
    if (!textQueues[conversationId]) {
      textQueues[conversationId] = { timer: null, bodies: [], contactId };
    }
    textQueues[conversationId].contactId = contactId;
    textQueues[conversationId].bodies.push(lastMsg);
    clearTimeout(textQueues[conversationId].timer);
    textQueues[conversationId].timer = setTimeout(
      () => flushTextQueue(conversationId).catch(e => console.error('[textQueue]', e.message)),
      30 * 1000
    );
    console.log(`[textQueue] Message queued for ${conversationId} — waiting 30s`);

  } catch (error) {
    console.error('Error webhook GHL:', error.message);
    notifyError('webhook GHL', error).catch(() => {});
  }
}

// ─── DEBUG / UTILITY ROUTES ──────────────────────────────────────────────────

/**
 * Mount utility/debug routes onto the Express app.
 * These routes are short enough to stay in server.js per the design spec,
 * but they are mounted here because they share the GHL context (fetch, env, db).
 *
 * NOTE: Per the orchestrator prompt, utility routes (/reset, /test-pago,
 * /reset-contact, /webhook/contact-deleted) stay inline in server.js.
 * This function is NOT used — it is kept for reference only.
 */
function mountDebugRoutes(app) {
  // intentionally left empty — routes stay in server.js per composition spec
}

// ─── TAG: CREAR EN CREATOR ───────────────────────────────────────────────────

async function ghlCrearEnCreatorHandler(req, res) {
  res.json({ success: true });

  try {
    const b = req.body;
    const contactId = b.contact_id || b.contactId || b.customData?.contactId;
    if (!contactId) return;

    // GHL sends all data flat in the body — read directly, no API call needed
    const tagsStr = (b.tags || '').toLowerCase();
    if (!tagsStr.includes('crear en creator')) return;

    const nombreNino = b['NHCK - Nombre del niño'] || '';
    const edad       = b['NHCK - Edad del niño']   || '';
    const genero     = b['NHCK - Género del niño'] || '';
    const estudia    = b['NHCK - Estudia'] === 'Sí';
    const sintoma    = b['NHCK - Síntoma principal'] || '';
    const movil      = b.phone  || '';
    const email      = b.email  || '';

    const faltantes = [
      !nombreNino && 'Nombre del niño',
      !edad       && 'Edad del niño',
      !genero     && 'Género',
      !sintoma    && 'Síntoma principal',
    ].filter(Boolean);

    if (faltantes.length) {
      console.log('[CrearEnCreator] Campos faltantes:', faltantes);
      await ghl.addNote(contactId,
        `⚠️ Etiqueta "Crear en Creator" aplicada pero la información NO se envió a Zoho Creator.\n\nCampos faltantes: ${faltantes.join(', ')}.\n\nCompletá esos campos y volvé a poner la etiqueta.`
      );
      return;
    }

    console.log('[CrearEnCreator] Iniciando para contacto:', contactId, { nombreNino, edad, genero, estudia, sintoma });
    await zoho.crearEnAnamnesis({ nombreNino, email, movil, contactIdGHL: contactId, edad, sintoma, genero, estudia });
    await ghl.removeTag(contactId, 'crear en creator');
    await ghl.addTag(contactId, 'creado-en-creator');
    await ghl.addNote(contactId, `✅ Contacto creado en Zoho Creator.\n\nNiño: ${nombreNino} | Edad: ${edad} | Síntoma: ${sintoma}`);
    console.log('[CrearEnCreator] Contacto creado en Zoho Creator:', contactId);
  } catch (err) {
    console.error('[CrearEnCreator] Error:', err.message);
    notifyError('ghl-crear-en-creator', err).catch(() => {});
  }
}

// ─── TAG: CREAR EN CREATOR NHC ───────────────────────────────────────────────

async function ghlCrearEnCreatorNHCHandler(req, res) {
  res.json({ success: true });

  try {
    const b = req.body;
    const contactId = b.contact_id || b.contactId || b.customData?.contactId;
    if (!contactId) return;

    // GHL sends all data flat in the body — read directly, no API call needed
    const tagsStr = (b.tags || '').toLowerCase();
    if (!tagsStr.includes('crear en creator nhc')) return;

    const nombre  = b.full_name || `${b.first_name || ''} ${b.last_name || ''}`.trim();
    const edad    = b['Edad'] || '';
    const genero  = b['Género'] || b['Sexo'] || '';
    const sintoma = b['Síntoma o necesidad'] || '';
    const movil   = b.phone || '';
    const email   = b.email || '';

    const faltantes = [
      !nombre  && 'Nombre',
      !edad    && 'Edad',
      !genero  && 'Género',
      !sintoma && 'Síntoma principal',
      !email   && 'Email',
    ].filter(Boolean);

    if (faltantes.length) {
      console.log('[CrearEnCreatorNHC] Campos faltantes:', faltantes);
      await ghl.addNote(contactId,
        `⚠️ Etiqueta "Crear en Creator NHC" aplicada pero la información NO se envió a Zoho Creator.\n\nCampos faltantes: ${faltantes.join(', ')}.\n\nCompletá esos campos y volvé a poner la etiqueta.`
      );
      return;
    }

    console.log('[CrearEnCreatorNHC] Iniciando para contacto:', contactId, { nombre, edad, genero, sintoma });
    await zoho.crearEnAnamnesis({ nombreNino: nombre, email, movil, contactIdGHL: contactId, edad, sintoma, genero });
    await ghl.removeTag(contactId, 'crear en creator nhc');
    await ghl.addTag(contactId, 'creado-en-creator');
    await ghl.addNote(contactId, `✅ Contacto creado en Zoho Creator.\n\n${nombre} | Edad: ${edad} | Síntoma: ${sintoma}`);
    console.log('[CrearEnCreatorNHC] Contacto creado en Zoho Creator:', contactId);
  } catch (err) {
    console.error('[CrearEnCreatorNHC] Error:', err.message);
    notifyError('ghl-crear-en-creator-nhc', err).catch(() => {});
  }
}

module.exports = { ghlWebhookHandler, ghlCrearEnCreatorHandler, ghlCrearEnCreatorNHCHandler, mountDebugRoutes };
