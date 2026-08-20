'use strict';

const fetch = require('node-fetch');
const { env, constants, proximoHorarioComercial } = require('../config');
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

/**
 * ¿Este contacto ya es paciente, aunque nuestro estado diga 'nuevo'?
 *
 * Dos senales, en orden de costo:
 *   1. La etiqueta 'activo nhck', que pone el equipo a mano. Gratis.
 *   2. Existir en el modulo de Contactos de Zoho: haber pasado por la anamnesis.
 *      Cuesta una consulta HTTP, asi que solo se pregunta si la etiqueta falto.
 *
 * SI ZOHO FALLA, DEVUELVE false — o sea, sigue el flujo normal de captacion.
 *
 * Es al reves del criterio del cierre por inactividad, donde ante la duda NO
 * cerramos. Aca la asimetria se invierte: si Zoho se cae y devolvieramos true,
 * escalariamos A TODOS los leads nuevos y la captacion se apagaria entera
 * mientras Zoho este mal. Tratar a un paciente como lead es malo y recuperable;
 * escalar a todo el mundo es una caida total.
 *
 * Por eso el fallo se registra fuerte: es invisible en el chat.
 */
async function esPacienteEstablecido(contact, tags) {
  if ((tags || []).includes('activo nhck')) return true;

  const movil = contact?.phone || '';
  const email = contact?.email || '';
  if (!movil && !email) return false;

  // TIMEOUT DURO. Sin esto, `fetch` a Zoho no tiene limite: si Zoho no responde,
  // este `await` no resuelve nunca y el manejador del webhook queda colgado. El
  // paciente no recibe NADA — ni respuesta, ni escalamiento, ni un error en los
  // logs. Es la peor falla posible: silenciosa e invisible.
  //
  // 4 segundos es mas de lo que Zoho tarda normalmente y menos de lo que una
  // persona espera una respuesta. Si se pasa, seguimos sin el dato.
  const LIMITE_MS = 4000;
  const t0 = Date.now();
  try {
    const zohoID = await Promise.race([
      zoho.buscarContactoAnamnesis(movil, email),
      new Promise((_, rechazar) => setTimeout(() => rechazar(new Error(`Zoho no respondio en ${LIMITE_MS}ms`)), LIMITE_MS)),
    ]);
    const ms = Date.now() - t0;
    if (ms > 1500) console.warn(`⚠️ Zoho tardo ${ms}ms en responder (limite ${LIMITE_MS}ms).`);
    if (zohoID) {
      console.log('PACIENTE ESTABLECIDO: encontrado en Zoho sin etiqueta `activo nhck` —', zohoID);
      return true;
    }
    return false;
  } catch (err) {
    console.error('⚠️ No se pudo consultar Zoho para saber si es paciente establecido. ' +
      'Se sigue con el flujo normal: escalar a todos ante un fallo de Zoho apagaria la captacion. ' +
      'Detalle:', err.message);
    return false;
  }
}

// No cerrar por inactividad cuando la conversación está esperando un pago.
// Una consignación bancaria tarda más que los diez minutos del temporizador, así
// que el cierre llegaba antes que el comprobante y la imagen caía en un chat ya
// cerrado. Se consulta el estado en el momento del cierre, no el que había
// cuando se armó el temporizador: entre medio el paciente pudo avanzar.
async function noCerrarSiEsperaPago(convId) {
  try {
    const d = await db.getConversationData(convId);
    if (d?.estado === 'esperando_pago') return false;
    // También si ya hay un pago pendiente registrado: el comprobante puede estar
    // en camino aunque el estado haya cambiado por otra vía.
    return true;
  } catch (err) {
    // Ante duda, NO cerrar. Un chat abierto de más cuesta menos que un
    // comprobante perdido.
    console.error('noCerrarSiEsperaPago: no se pudo leer el estado, no se cierra:', err.message);
    return false;
  }
}

// Which WhatsApp line this deployment answers on. Deliberately separate from
// the brand tags (`cliente-nhck`, `nhc-adultos`, ...): those say who the
// patient IS, this says which number the thread lives on. They diverge for
// patients who arrive through Kids and turn out to be adults — they get
// `nhc-adultos` but keep answering on Carolina's number, because switching
// numbers mid-thread needs a Meta-approved template (see ai/prompt.js).
// Outbound automations must pick their "from" number by this tag: a reminder
// sent on the other line lands the patient's reply in a conversation whose
// bot has the wrong persona and knowledge base.
const LINEA_TAG = env.agentName === 'luisa' ? 'linea-nhc' : 'linea-nhck';

// Moved to ai/tags.js so every sender of model output shares one cleaner —
// the recoveryJob was sending raw output and leaked a literal referral tag to
// a patient (confirmed live 2026-07-29).
const { limpiarTags } = require('../ai/tags');

/**
 * Wraps ghl.sendMessage for inactivity timers: these fire minutes after being
 * scheduled, so the contact may have been escalated (manually in GHL, or by
 * the bot itself) in the meantime — always re-check live tags before sending.
 */
async function sendIfNoEscalado(conversationId, message, contactId) {
  const { contact } = await ghl.getContact(contactId, true);
  if ((contact?.tags || []).includes('escalado nhck')) return;
  return ghl.sendMessage(conversationId, message, contactId);
}

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
    let convData;
    try {
      convData = await db.getConversationData(conversationId);
    } catch (err) {
      console.error('[flushTextQueue] DB_ERROR getConversationData, aborting to avoid resetting to nuevo:', conversationId, err.message);
      return;
    }
    const estado = convData?.estado || 'nuevo';
    const triaje = convData?.triaje || {};
    let history = convData?.messages || [];
    const nombre = contact.firstName || '';
    const phone = contact.phone || '';

    history.push({ role: 'user', content: [{ type: 'text', text: combinedMsg }] });
    if (history.length > 20) history = history.slice(-20);

    // Availability — computed regardless of estado: a lead can ask "para
    // cuándo tienen cita" before finishing the triage, and Luisa must be able
    // to answer with real dates herself instead of escalating for lack of
    // data (see ai/prompt.js reglasBase). Cached per fecha ISO across all
    // conversations, so this doesn't add a Zoho call per message.
    let disponibilidadTexto = '';
    try {
      const hoy = new Date();
      const mesesN = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
      const diasN = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
      // Dias habiles ya transcurridos, contados desde manana. Un dia cuenta como
      // habil si la clinica abre ese dia de la semana y Zoho no tiene un cierre
      // de jornada completa (festivo). Ver constants.MIN_DIAS_HABILES_ANTICIPACION.
      let habilesPrevios = 0;

      const diaConCupo = async (offset) => {
        const f = new Date(hoy); f.setDate(hoy.getDate() + offset);
        const ds = f.getDay();
        if (!constants.HORARIOS_NHCK[ds]) return null;
        const fISO = f.toISOString().split('T')[0];
        let citas = await db.getCachedDisponibilidad(fISO);
        if (!citas) { citas = await zoho.getDisponibilidad(fISO); await db.setCachedDisponibilidad(fISO, citas); }

        // Un festivo no cuenta como dia habil, pero tampoco frena el barrido:
        // se salta y se sigue buscando.
        if (zoho.esCierreTotal(citas, fISO)) return null;

        // ANTICIPACION MINIMA. El dia es habil, asi que suma — pero solo se puede
        // OFRECER si ya pasaron los dias habiles requeridos. El incremento va
        // despues de la comprobacion: el propio dia de la cita no cuenta como
        // margen para mandar la anamnesis.
        const alcanzaAnticipacion = habilesPrevios >= constants.MIN_DIAS_HABILES_ANTICIPACION;
        habilesPrevios++;
        if (!alcanzaAnticipacion) return null;
        const slots = zoho.calcularSlotsLibres(citas, fISO);
        if (!slots.length) return null;
        return `${diasN[ds]} ${f.getDate()} de ${mesesN[f.getMonth()]} (${fISO}): ${slots.slice(0, 4).map(s => s.label).join(', ')}\n`;
      };

      // Un fallo de Zoho no es una agenda libre. Si no se pudo leer, se corta:
      // seguir barriendo daría un panorama parcial que parece completo, y el
      // bot ofrecería horarios que en realidad están ocupados.
      let zohoFallo = null;
      const barrer = async (desde, hasta, tope) => {
        let encontrados = 0;
        for (let offset = desde; offset <= hasta && !zohoFallo && (!tope || encontrados < tope); offset++) {
          try {
            const linea = await diaConCupo(offset);
            if (linea) { disponibilidadTexto += linea; encontrados++; }
          } catch (err) {
            zohoFallo = err;
          }
        }
      };

      await barrer(1, 14, null);

      // Quedarse en catorce días cuando la ventana sale vacía es lo que costó la
      // consulta del 2026-08-06: el prompt le prohíbe inventar horarios, así que
      // sin datos el bot dice "no hay disponibilidad" y cierra la conversación --
      // aunque haya cupo el día quince. Una agenda llena es motivo para ofrecer
      // la fecha siguiente, no para despedir a un paciente.
      //
      // Se sigue buscando hasta dos meses y alcanza con las tres primeras fechas
      // con cupo: son las que un paciente va a considerar, y cada día extra
      // cuesta una consulta a Zoho la primera vez que se mira.
      //
      // El respaldo NO corre si Zoho falló. El 2026-08-20 la cuenta agotó su
      // cuota diaria, los catorce días salieron vacíos por error, y este barrido
      // extra multiplicó por cuatro el consumo justo cuando ya no quedaba: una
      // espiral que se alimenta sola. Sin datos no se busca más lejos, se avisa.
      if (!disponibilidadTexto && !zohoFallo) {
        await barrer(15, 60, 3);
        if (disponibilidadTexto) {
          disponibilidadTexto = `No hay cupo en los próximos 14 días. Las fechas disponibles más próximas son:\n${disponibilidadTexto}`;
        }
      }

      // Con fechas ya encontradas, un fallo posterior no las invalida: se leyeron
      // bien y el barrido va en orden, así que son las más cercanas que hay. Se
      // ofrecen igual. Sólo si no quedó nada se admite que no se pudo consultar.
      if (zohoFallo) {
        if (!disponibilidadTexto) throw zohoFallo;
        console.warn('DISPONIBILIDAD: se corta el barrido por un fallo de Zoho, se ofrece lo ya leído —', zohoFallo.message);
      }
      if (!disponibilidadTexto) disponibilidadTexto = 'Sin disponibilidad en los próximos 2 meses.';
    } catch (err) {
      // Se registra fuerte. Antes este catch se tragaba el error sin dejar
      // rastro, y por eso la caída de Zoho del 2026-08-20 estuvo horas sin que
      // saltara una sola alarma.
      console.error('DISPONIBILIDAD: no se pudo consultar Zoho —', err.message);
      disponibilidadTexto = 'No consultada. Intenta más tarde.';
    }

    const derivadoA = convData?.derivado_a || null;
    const systemPrompt = await buildSystemPrompt(estado, { nombre, triaje, disponibilidadTexto, derivadoA, desdeFormulario: tags.includes('lead-formulario') });
    const rawReply = await callClaude(systemPrompt, history);

    // The Claude call above can take several seconds — an advisor may have
    // escalated this contact manually in GHL while it was in flight. Re-check
    // the live tag before acting on the reply, same reasoning as sendIfNoEscalado.
    const liveRecheck = await ghl.getContact(contactId, true);
    if ((liveRecheck.contact?.tags || []).includes('escalado nhck')) {
      console.log(`[flushTextQueue] Escalado detectado durante llamada a Claude — abortando respuesta para ${contactId}`);
      triggerAsesorAnalysis(conversationId, contactId);
      return;
    }

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
      timers.iniciarTimersInactividad(conversationId, contactId, sendIfNoEscalado, async (convId, ctId) => {
        await db.marcarCerrado(convId);
        triggerAnalysis(convId, ctId || contactId, 'inactividad');
      }, noCerrarSiEsperaPago);
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
          const mensajes = [
            `Aquí tienes tu link de pago seguro 👇\n${linkPago}`,
            `Una vez completado te envío los detalles de tu cita 🙌`,
          ];
          await ghl.sendMessages(conversationId, mensajes, contactId, channel);
          history.push({ role: 'assistant', content: [{ type: 'text', text: mensajes.join('\n') }] });
        }
        await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', null, phone);
        return;
      }

      if (rawReply.includes('[MEDIO_TRANSFERENCIA]')) {
        await humanDelay();
        const mensajes = [
          `Puedes hacer la transferencia o consignación por $100.000 a esta cuenta 👇`,
          `Bancolombia — Cuenta de Ahorros\nNúmero: 90790901451\nLlave: 0090435866\nA nombre de: Visión Integral Transformación Personal y Organizacional SAS\nNIT: 901164425`,
          `Una vez realizado el pago envíame aquí la foto del comprobante y confirmo tu cita 📸`,
        ];
        await ghl.sendMessages(conversationId, mensajes, contactId, channel);
        history.push({ role: 'assistant', content: [{ type: 'text', text: mensajes.join('\n') }] });
        await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', null, phone);
        return;
      }

      if (rawReply.includes('[MEDIO_QR]')) {
        await humanDelay();
        const mensajes = [
          `Aquí está el QR para pagar $100.000 👇\nhttps://neurohackingcenter.co/wp-content/uploads/2026/05/WhatsApp-Image-2026-05-29-at-11.00.03-AM.jpeg`,
          `Ábrelo, toma captura y escanéalo con tu app bancaria 📱\nO usa la llave Bancolombia: 0090435866`,
          `Cuando pagues envíame el comprobante aquí y confirmo tu cita 📸`,
        ];
        await ghl.sendMessages(conversationId, mensajes, contactId, channel);
        history.push({ role: 'assistant', content: [{ type: 'text', text: mensajes.join('\n') }] });
        await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', null, phone);
        return;
      }
    }

    // Cierre: ciudad fuera de cobertura
    if (rawReply.includes('[CIUDAD_NO_DISPONIBLE]')) {
      const replyLimpio = limpiarTags(rawReply).trim();
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
      const replyLimpio = limpiarTags(rawReply).trim();
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
      const replyLimpio = limpiarTags(rawReply).trim();
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
      const replyLimpio = limpiarTags(rawReply).trim();
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
      const replyLimpio = limpiarTags(rawReply).trim();
      const textoEnviado = replyLimpio || `Un asesor de nuestro equipo te contacta ${proximoHorarioComercial()} 🙌`;
      history.push({ role: 'assistant', content: [{ type: 'text', text: textoEnviado }] });
      await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, 'escalado', null, phone);
      triggerAnalysis(conversationId, contactId, 'escalado');
      await humanDelay();
      if (replyLimpio) {
        const partes = replyLimpio.split('---').map(p => p.trim()).filter(p => p.length > 0);
        await ghl.sendMessages(conversationId, partes, contactId, channel);
      } else {
        await ghl.sendMessage(conversationId, textoEnviado, contactId, channel);
      }
      return;
    }

    // Deferred — user said they'll talk later: suppress timers and recovery for 24h
    if (rawReply.includes('[POSPONER]')) {
      const replyLimpio = limpiarTags(rawReply).trim();
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
    const reply = limpiarTags(rawReply);

    const partes = reply.split('---').map(p => p.trim()).filter(p => p.length > 0);
    history.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
    await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, nuevoEstado, null, phone);
    await humanDelay();
    await ghl.sendMessages(conversationId, partes, contactId, channel);
    timers.iniciarTimersInactividad(conversationId, contactId, sendIfNoEscalado, async (convId, ctId) => {
      await db.marcarCerrado(convId);
      triggerAnalysis(convId, ctId || contactId, 'inactividad');
    }, noCerrarSiEsperaPago);
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

    // Deduplication — messageId-based first (longer TTL: retries can arrive
    // later than the 6s content-dedup window), falling back to the existing
    // content-based dedup for events that don't carry a messageId.
    if (messageId) {
      const msgIdKey = `proc_msgid_${messageId}`;
      if (messageBuffers[msgIdKey]) {
        console.log(`DEDUP: ignorado por messageId (${msgIdKey})`);
        return;
      }
      messageBuffers[msgIdKey] = true;
      setTimeout(() => { delete messageBuffers[msgIdKey]; }, 60000);
    }

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

    let convData;
    try {
      convData = await db.getConversationData(conversationId);
    } catch (err) {
      console.error('[ghlWebhookHandler] DB_ERROR getConversationData, aborting message processing:', conversationId, err.message);
      return;
    }

    // Tag the line on the first inbound message only. GHL treats re-adding an
    // existing tag as a no-op, but doing it per message would spend an API
    // call on every turn for no gain.
    if (!convData) {
      ghl.addTag(contactId, LINEA_TAG).catch(() => {});
    }

    if (convData?.recovery_status) {
      db.pool.query('UPDATE conversations SET recovery_status=NULL WHERE conversation_id=$1 AND agent=$2', [conversationId, env.agentName]).catch(() => {});
    }
    timers.limpiarTimers(conversationId);

    // If conversation was closed by inactivity and user writes again → restart,
    // resuming into estado_antes_cierre when it's a state worth preserving
    // (agendando/esperando_pago/escalado), falling back to triaje-derived
    // state otherwise (legacy rows / closed before reaching those states).
    // messages is intentionally kept (not wiped) so Claude retains context.
    if (convData?.estado === 'cerrado') {
      const t = convData.triaje || {};
      const estadoAntesCierre = convData.estado_antes_cierre;
      const estadosPreservables = ['agendando', 'esperando_pago', 'escalado'];
      const estadoRetoma = estadosPreservables.includes(estadoAntesCierre)
        ? estadoAntesCierre
        : ((t.triaje1 && t.triaje2 && t.triaje3)
          ? 'triaje_completo'
          : (t.triaje1 && t.triaje2 ? 'triaje_p3' : (t.triaje1 ? 'triaje_p2' : 'nuevo')));
      await db.pool.query(
        'UPDATE conversations SET estado=$1, recovery_status=NULL, updated_at=NOW() WHERE conversation_id=$2 AND agent=$3',
        [estadoRetoma, conversationId, env.agentName]
      );
      convData = { ...convData, estado: estadoRetoma };
    }

    // skipCache: this fetch gates whether the bot replies at all — tags may
    // have been changed manually in GHL (advisor escalation) since this
    // contact was last cached, so the check must see the live state.
    const contactData = await ghl.getContact(contactId, true);
    if (contactData.deleted) { await db.limpiarContactoDB(contactId); return; }

    const contact = contactData.contact || {};
    const tags = contact.tags || [];
    const estado = convData?.estado || 'nuevo';

    // PACIENTE YA ESTABLECIDO — nunca mostrarle el guion de captacion.
    //
    // La senal era solo la etiqueta 'activo nhck', que pone una persona a mano.
    // El 2026-08-18 el bot le hablo como venta nueva a la mama de un paciente
    // que tenia cita ESE DIA: no tenia la etiqueta. Depender de que alguien se
    // acuerde de etiquetar no es una proteccion.
    //
    // Se agrega una segunda senal que no depende de nadie: estar en el modulo
    // de Contactos de Zoho significa haber pasado por la anamnesis, o sea ser
    // paciente real. Confirmado que ese modulo tiene SOLO pacientes, no leads.
    //
    // Por que NO se uso 'cliente-nhck': esa etiqueta la pone nuestro propio bot
    // a todo el que escribe por primera vez (mas abajo, junto a crearOportunidad).
    // Usarla habria escalado cada conversacion desde el segundo mensaje.
    //
    // La consulta a Zoho solo corre si la etiqueta NO esta y el estado es
    // 'nuevo': es como mucho una vez por conversacion nueva, no por mensaje.
    if (estado === 'nuevo' && !tags.includes('escalado nhck')
        && await esPacienteEstablecido(contact, tags)) {
      await ghl.addTag(contactId, 'escalado nhck');
      await db.saveConversationData(conversationId, contactId, convData?.messages || [], convData?.triaje || {}, 'escalado', messageId, contact.phone || '');
      triggerAnalysis(conversationId, contactId, 'activo_reinicio_evitado');
      await humanDelay();
      await ghl.sendMessage(conversationId, 'Hola de nuevo 😊 Ya te conectamos con nuestro equipo para darte seguimiento personalizado.', contactId, channel);
      return;
    }

    // FORMULARIO DE META — la persona toco "Ahora No"
    //
    // El clic de un boton de plantilla llega como un mensaje entrante igual que
    // un texto escrito: el bot no los distingue. Sin esto, alguien que acaba de
    // decir que NO recibia el saludo de bienvenida y el arranque del triaje.
    //
    // Ademas de ser una mala experiencia, es lo que mas rapido baja la
    // calificacion del numero en Meta: gente que dijo que no y sigue recibiendo
    // mensajes es gente que reporta.
    //
    // Se responde una vez, corto, y se cierra. No se escala: no hay nada que un
    // asesor tenga que hacer con alguien que pidio no ser contactado ahora.
    if (estado === 'nuevo' && tags.includes('formulario-declinado')) {
      await db.saveConversationData(conversationId, contactId, convData?.messages || [], {}, 'cerrado', messageId, contact.phone || '');
      await humanDelay();
      await ghl.sendMessage(conversationId,
        'Con gusto 😊 Quedamos atentos por si mas adelante querés retomar. Escribinos cuando quieras.',
        contactId, channel);
      return;
    }

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

    // IMAGEN DE COMPROBANTE
    //
    // La condición ya no es sólo `estado === 'esperando_pago'`. Ese estado se
    // pierde por dos vías, y en las dos la imagen se descartaba en silencio:
    //
    //   · el cierre por inactividad pasa el estado a 'cerrado' (caso Maribel,
    //     2026-08-18: cerró 14:00, ella mandó el comprobante 14:02);
    //   · el paciente escribe algo entre medio y el flujo avanza a otro estado.
    //
    // Se acepta también cuando hay un pago pendiente registrado para el contacto.
    // Ese registro es la señal fuerte: significa que le pedimos plata y todavía no
    // la confirmamos. Una foto en ese contexto es un comprobante, venga en el
    // estado que venga.
    const pagoPendiente = isImage ? await db.getPendingPaymentsByContact(contactId).catch(() => null) : null;
    const esperabaComprobante = estado === 'esperando_pago'
      || convData?.estado_antes_cierre === 'esperando_pago'
      || !!pagoPendiente;

    if (isImage && esperabaComprobante) {
      console.log('IMAGEN RECIBIDA — procesando comprobante', { estado, antesCierre: convData?.estado_antes_cierre, hayPagoPendiente: !!pagoPendiente });
      await humanDelay();
      const nombre = contact.firstName || '';
      const triaje = convData?.triaje || {};
      const history = convData?.messages || [];
      const phone = contact.phone || '';

      const pago = pagoPendiente;

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
          resultado = await zoho.crearTriajeInfantil({
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

    // Imagen en cualquier otro estado. Ya no se descarta en silencio: si el
    // paciente se tomó el trabajo de mandar una foto, alguien tiene que verla.
    // Se etiqueta para revisión humana y se le responde, en vez de dejarlo
    // hablando solo — que es lo que pasaba antes.
    if (isImage) {
      console.log('IMAGEN en estado no esperado — escalando para revisión:', estado);
      await db.logEvent(contactId, conversationId, 'imagen_fuera_de_flujo', { estado });
      await ghl.addTag(contactId, 'escalado nhck').catch(() => {});
      await ghl.sendMessage(conversationId,
        'Recibí tu imagen 📸 Un asesor la revisa y te confirma en un momento 🙌',
        contactId).catch(() => {});
      return;
    }
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
    await zoho.crearTriajeInfantil({ nombreNino, email, movil, contactIdGHL: contactId, edad, sintoma, genero, estudia });
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
    await zoho.crearTriajeInfantil({ nombreNino: nombre, email, movil, contactIdGHL: contactId, edad, sintoma, genero });
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
