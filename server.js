'use strict';

const express = require('express');
const { env } = require('./config');
const db = require('./db');
const { removeTag, getContact, getConversationId } = require('./services/ghl');
const { ghlWebhookHandler, ghlCrearEnCreatorHandler } = require('./webhooks/ghl');
const { wompiWebhookHandler, pagoExitosoHandler } = require('./webhooks/wompi');
const analyticsRouter = require('./analytics');
const { startRecoveryJob } = require('./jobs/recoveryJob');
const { startWeeklyReport } = require('./jobs/weeklyReport');
const { startDailyReport } = require('./jobs/dailyReport');
const { notify, notifyError } = require('./services/notifier');
const { answerQuestion } = require('./services/cliqBot');
const { getZohoAccessToken, crearEnAnamnesis, buscarOCrearContactoHistoria } = require('./services/zoho');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static('public'));

// ─── UTILITY ROUTES ──────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send('Servidor NHC Kids activo ✓'));


// ─── GITHUB DEPLOY NOTIFICATIONS ─────────────────────────────────────────────

app.post('/github-webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  if (event !== 'push') return res.sendStatus(200);

  const { ref, commits = [], pusher, repository, compare } = req.body;
  if (!commits.length) return res.sendStatus(200);

  const branch = ref?.replace('refs/heads/', '') || 'main';
  const repo = repository?.name || 'GHL-NHCK';
  const autor = pusher?.name || 'desconocido';
  const fecha = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' });

  const lista = commits.slice(0, 6).map(c => `• ${c.message.split('\n')[0]}`).join('\n');
  const mas = commits.length > 6 ? `\n_...y ${commits.length - 6} más_` : '';

  const msg =
    `🚀 *Nuevo push — ${repo}*\n` +
    `Branch: \`${branch}\` | Autor: ${autor} | ${fecha}\n\n` +
    `*Cambios (${commits.length}):*\n${lista}${mas}`;

  await notify(msg).catch(() => {});
  res.sendStatus(200);
});

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

app.get('/informe', async (req, res) => {
  try {
    const [estados, eventos, causas, sintomas, recovery, funnel, gaps, pendientes, recientes] = await Promise.all([
      db.pool.query(`SELECT estado, COUNT(*) as total FROM conversations GROUP BY estado ORDER BY total DESC`),
      db.pool.query(`SELECT event_type, COUNT(*) as total FROM transaction_logs GROUP BY event_type ORDER BY total DESC`),
      db.pool.query(`SELECT root_cause, outcome, COUNT(*) as total FROM conversation_insights GROUP BY root_cause, outcome ORDER BY total DESC`),
      db.pool.query(`SELECT triaje->>'triaje1' as sintoma, COUNT(*) as total FROM conversations WHERE triaje->>'triaje1' IS NOT NULL AND triaje->>'triaje1' != '' GROUP BY sintoma ORDER BY total DESC`),
      db.pool.query(`SELECT recovery_status, COUNT(*) as total FROM conversations WHERE recovery_status IS NOT NULL GROUP BY recovery_status`),
      db.pool.query(`SELECT COUNT(*) FILTER (WHERE estado IN ('triaje_completo','agendando','esperando_pago','completado')) as con_triaje, COUNT(*) FILTER (WHERE estado='esperando_pago') as esperando_pago, COUNT(*) FILTER (WHERE estado='completado') as completados, COUNT(*) FILTER (WHERE estado='cerrado') as cerrados, COUNT(*) FILTER (WHERE estado='escalado') as escalados, COUNT(*) as total FROM conversations`),
      db.pool.query(`SELECT pregunta, frecuencia FROM knowledge_gaps ORDER BY frecuencia DESC LIMIT 10`),
      db.pool.query(`SELECT COUNT(*) as total, MIN(created_at) as mas_antigua FROM pending_payments`),
      db.pool.query(`SELECT estado, COUNT(*) as total FROM conversations WHERE updated_at > NOW() - INTERVAL '72 hours' GROUP BY estado ORDER BY total DESC`),
    ]);
    res.json({
      generado: new Date().toISOString(),
      funnel: funnel.rows[0],
      estados: estados.rows,
      recientes_72h: recientes.rows,
      eventos: eventos.rows,
      root_causes: causas.rows,
      sintomas: sintomas.rows,
      recovery: recovery.rows,
      pagos_pendientes: pendientes.rows[0],
      knowledge_gaps: gaps.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/informe/triaje-completo', async (req, res) => {
  try {
    const { rows } = await db.pool.query(`
      SELECT
        c.conversation_id,
        c.contact_id,
        c.estado,
        c.triaje,
        c.messages,
        c.updated_at,
        c.recovery_status,
        cc.contact_data
      FROM conversations c
      LEFT JOIN contact_cache cc ON cc.contact_id = c.contact_id
      WHERE c.estado = 'triaje_completo'
      ORDER BY c.updated_at DESC
    `);

    const result = rows.map(r => {
      const msgs = Array.isArray(r.messages) ? r.messages : [];
      const cd = r.contact_data || {};
      const lastMessages = msgs.slice(-6).map(m => ({
        rol: m.role === 'user' ? 'CLIENTE' : 'CAROLINA',
        texto: Array.isArray(m.content)
          ? m.content.map(c => c.text || '').join('')
          : (m.content || ''),
      }));
      const minutosInactivo = Math.round((Date.now() - new Date(r.updated_at).getTime()) / 60000);
      return {
        contacto: cd.firstName ? `${cd.firstName} ${cd.lastName || ''}`.trim() : r.contact_id,
        telefono: cd.phone || null,
        triaje: r.triaje,
        recovery: r.recovery_status,
        inactivo_minutos: minutosInactivo,
        total_mensajes: msgs.length,
        ultimos_mensajes: lastMessages,
      };
    });

    res.json({ total: result.length, conversaciones: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── EVALUACION NHCK ──────────────────────────────────────────────────────────

// Alias used by historia-clinica.html
app.get('/zoho-creator-token', async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    res.json({ access_token: token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/historia-clinica', async (req, res) => {
  const d = req.body;

  // ── 1. Validate required fields ──────────────────────────────────────────
  const REQUIRED = ['fechaElaboracion', 'nombreConsultante', 'edadConsultante', 'motivoConsulta', 'expectativasProceso', 'comoSupo'];
  const missing = REQUIRED.filter(k => !d[k] || String(d[k]).trim() === '');
  if (missing.length) {
    return res.status(400).json({ ok: false, stage: 'validation', missing, error: `Campos requeridos faltantes: ${missing.join(', ')}` });
  }

  // ── 2. Zoho token ─────────────────────────────────────────────────────────
  let token;
  try { token = await getZohoAccessToken(); }
  catch (err) { return res.status(500).json({ ok: false, stage: 'token', error: err.message }); }

  // ── 3. Find or create Contacto in Creator ────────────────────────────────
  let contactoID = null;
  try {
    contactoID = await buscarOCrearContactoHistoria({
      nombre: d.nombreConsultante,
      movil:  d.movilConsultante  || '',
      email:  d.emailConsultante  || '',
      edad:   d.edadConsultante   || '',
    });
    if (contactoID) console.log('[/historia-clinica] Contacto ID:', contactoID);
  } catch (err) {
    console.warn('[/historia-clinica] Contacto lookup/create failed:', err.message);
  }

  // ── 4. Build Creator payload ──────────────────────────────────────────────
  const creatorPayload = {
    Fecha_elaboracion:             d.fechaElaboracion,
    Nombre_consultante:            contactoID || d.nombreConsultante,
    Edad_consultante:              d.edadConsultante,
    Edad_padres_cuidadores:        d.edadPadresCuidadores        || '',
    Lateralidad:                   d.lateralidad                 || '',
    Dedicacion_padres:             d.dedicacionPadres            || '',
    Con_quien_vive:                d.conQuienVive                || '',
    Motivo_consulta:               d.motivoConsulta,
    Estado_actual_antecedentes:    d.estadoActualAntecedentes    || '',
    Num_embarazos:                 d.numEmbarazos                || '',
    Medicamentos_embarazo:         d.medicamentosEmbarazo        || '',
    Complicaciones_embarazo:       d.complicacionesEmbarazo      || '',
    Duracion_embarazo:             d.duracionEmbarazo            || '',
    Complicaciones_nacimiento:     d.complicacionesNacimiento     || '',
    Incubadora_enfermedades:       d.incubadoraEnfermedades      || '',
    Controles_desarrollo:          d.controlesDesarrollo         || '',
    Dificultades_gateo:            d.dificultadesGateo           || '',
    Control_esfinteres:            d.controlEsfinteres           || '',
    Primeras_palabras:             d.primerasPalabras            || '',
    Temperamento:                  d.temperamento                || '',
    Conformacion_familia:          d.conformacionFamilia         || '',
    Infancia_desarrollo:           d.infanciaDesarrollo          || '',
    Dinamica_familiar:             d.dinamicaFamiliar            || '',
    Relaciones_pares:              d.relacionesPares             || '',
    Pautas_crianza:                d.pautasCrianza               || '',
    Abusos_violencia:              d.abusosViolencia             || '',
    Grado_institucion:             d.gradoInstitucion            || '',
    Rendimiento_academico:         d.rendimientoAcademico        || '',
    Enfermedades:                  d.enfermedades                || '',
    Restricciones_tecnologia:      Array.isArray(d.restriccionesTecnologia)
                                     ? d.restriccionesTecnologia.join(', ')
                                     : (d.restriccionesTecnologia || ''),
    Trabajo_psicologico:           d.trabajoPsicologico          || '',
    Medicamentos:                  d.medicamentos                || '',
    Antecedentes_salud:            d.antecedentesSalud           || '',
    Actividades_extracurriculares: d.actividadesExtracurriculares || '',
    Factores_motivacion:           d.factoresMotivacion          || '',
    Alimentacion:                  d.alimentacion                || '',
    Sueno:                         d.sueno                       || '',
    Consume_sustancias:            d.consumeSustancias           || '',
    Exposicion_pantallas:          d.exposicionPantallas         || '',
    Expectativas_proceso:          d.expectativasProceso,
    Agregar_algo:                  d.agregarAlgo                 || '',
    Comentarios_profesional:       d.comentariosProfesional      || '',
    Test_BASCH:                    d.testBASCH                   || '',
    Como_supo:                     d.comoSupo,
    Comentario_devolucion:         d.comentarioDevolucion        || '',
    Recomendaciones_terapeuticas:  d.recomendacionesTerapeuticas || '',
    Neurotecnologias_no_usar:      d.neurotecnologiasNoUsar      || '',
  };

  // Conditional: only include substance fields when consumeSustancias = 'Sí'
  if (d.consumeSustancias === 'Sí') {
    creatorPayload.Tipo_sustancias      = d.tipoSustancias      || '';
    creatorPayload.Periodicidad_consumo = d.periodicidadConsumo || '';
  }

  // ── 5. Submit to Creator ──────────────────────────────────────────────────
  try {
    const cr = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/v2/form/Historia_Clinica', {
      method: 'POST',
      headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: creatorPayload }),
    });
    const crData = await cr.json();
    console.log('[/historia-clinica] Creator response:', JSON.stringify(crData));

    if (crData.code === 3000 || crData.data?.ID) {
      return res.json({ ok: true, id: crData.data?.ID, contactoID });
    }
    if (crData.code === 3100) {
      return res.status(401).json({ ok: false, stage: 'auth', error: 'Token Zoho inválido o expirado — reintentá en unos segundos' });
    }
    return res.status(422).json({ ok: false, stage: 'creator', error: crData.message || JSON.stringify(crData), details: crData });
  } catch (err) {
    res.status(500).json({ ok: false, stage: 'creator', error: err.message });
  }
});

app.get('/zoho-token', async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    res.json({ access_token: token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/evaluacion', async (req, res) => {
  try {
    const { nombreNino, email, movil, edad, sintoma, genero, estudia } = req.body;
    if (!nombreNino || !movil) {
      return res.status(400).json({ ok: false, error: 'Nombre y celular son requeridos.' });
    }

    // Create GHL contact first so Creator's required CRM lookup field has a valid ID.
    let contactIdGHL = '';
    if (env.ghlKey && env.ghlLocationId) {
      try {
        const ghlRes = await fetch('https://services.leadconnectorhq.com/contacts/', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.ghlKey}`,
            'Version': '2021-04-15',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            firstName: nombreNino,
            phone: movil,
            email: email || undefined,
            locationId: env.ghlLocationId,
            tags: ['formulario-evaluacion'],
          }),
        });
        const ghlData = await ghlRes.json();
        contactIdGHL = ghlData?.contact?.id || '';
        console.log('[/evaluacion] GHL contact:', contactIdGHL || 'not created');
      } catch (ghlErr) {
        console.warn('[/evaluacion] GHL contact creation failed:', ghlErr.message);
      }
    }

    const result = await crearEnAnamnesis({
      nombreNino, email, movil, edad, sintoma, genero, estudia, contactIdGHL,
    });
    res.json({ ok: true, contactoID: result.contactoID, ghlId: contactIdGHL });
  } catch (err) {
    console.error('[/evaluacion]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── CLIQ BOT ─────────────────────────────────────────────────────────────────

app.post('/cliq/bot', async (req, res) => {
  const { type, text } = req.body;
  if (type !== 'message' || !text?.trim()) return res.json({ text: '' });

  try {
    const answer = await answerQuestion(text.trim());
    res.json({ text: answer });
  } catch (err) {
    console.error('[cliqBot] Error:', err.message);
    res.json({ text: '⚠️ No pude consultar los datos en este momento. Intentá de nuevo.' });
  }
});

// ─── ANALYTICS ────────────────────────────────────────────────────────────────

app.use('/dashboard', analyticsRouter);

// ─── WEBHOOK ROUTES ───────────────────────────────────────────────────────────

app.post('/webhook/ghl', ghlWebhookHandler);
app.post('/webhook/ghl-crear-contacto', ghlCrearEnCreatorHandler);
app.post('/webhook/wompi', wompiWebhookHandler);
app.get('/pago-exitoso', pagoExitosoHandler);

// ─── BOOT ─────────────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err.message);
  notifyError('uncaughtException', err).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  notifyError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))).catch(() => {});
});

db.initDB().then(() => {
  startRecoveryJob();
  startWeeklyReport();
  startDailyReport();
  app.listen(env.port, () => console.log(`Servidor corriendo en puerto ${env.port}`));
}).catch(err => { console.error('Error DB:', err); process.exit(1); });
