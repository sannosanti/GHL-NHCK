'use strict';

const express = require('express');
const { env } = require('./config');
const db = require('./db');
const { removeTag, getContact, getConversationId } = require('./services/ghl');
const { ghlWebhookHandler } = require('./webhooks/ghl');
const { wompiWebhookHandler, pagoExitosoHandler } = require('./webhooks/wompi');
const analyticsRouter = require('./analytics');
const { startRecoveryJob } = require('./jobs/recoveryJob');
const { startWeeklyReport } = require('./jobs/weeklyReport');
const { startDailyReport } = require('./jobs/dailyReport');
const { notifyError } = require('./services/notifier');

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

// ─── ONE-SHOT STAGE MIGRATION ─────────────────────────────────────────────────

app.get('/migrate-stages', async (req, res) => {
  const { constants, env: cfg } = require('./config');
  const fetch = require('node-fetch');

  const STAGE_MAP = {
    nuevo:           constants.STAGE_INICIO,
    triaje_p1:       constants.STAGE_INICIO,
    triaje_p2:       constants.STAGE_INICIO,
    triaje_p3:       constants.STAGE_INICIO,
    activo:          constants.STAGE_INICIO,
    triaje_completo: constants.STAGE_INFO_COMPLETA,
    agendando:       constants.STAGE_INFO_COMPLETA,
    esperando_pago:  constants.STAGE_LINK_PAGO,
    completado:      constants.STAGE_PAGO_PARCIAL,
  };

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.write('=== MIGRATE STAGES — NHC Kids ===\n\n');

  let ok = 0, skip = 0, err = 0;

  try {
    const { rows } = await db.pool.query(
      `SELECT contact_id, estado, triaje FROM conversations ORDER BY updated_at DESC`
    );
    res.write(`Total conversaciones: ${rows.length}\n\n`);

    for (const row of rows) {
      const { contact_id, estado, triaje } = row;

      // Escalado: depende de si completó triaje
      let targetStage = STAGE_MAP[estado];
      if (estado === 'escalado') {
        targetStage = triaje?.triaje1 ? constants.STAGE_INFO_COMPLETA : constants.STAGE_INICIO;
      }
      // Cerrado: dejamos la oportunidad donde está (no mover)
      if (estado === 'cerrado') { skip++; res.write(`SKIP  [${contact_id.slice(0,8)}] cerrado — sin mover\n`); continue; }
      if (!targetStage) { skip++; res.write(`SKIP  [${contact_id.slice(0,8)}] estado desconocido: ${estado}\n`); continue; }

      try {
        // Buscar oportunidad en GHL
        const searchRes = await fetch(
          `https://services.leadconnectorhq.com/opportunities/search?location_id=${cfg.ghlLocationId}&pipeline_id=${constants.GHL_PIPELINE_ID}&contact_id=${contact_id}`,
          { headers: { 'Authorization': `Bearer ${cfg.ghlKey}`, 'Version': '2021-07-28' } }
        );
        const searchData = await searchRes.json();
        const opp = searchData.opportunities?.[0];

        if (!opp) { skip++; res.write(`SKIP  [${contact_id.slice(0,8)}] sin oportunidad en GHL\n`); continue; }
        if (opp.pipelineStageId === targetStage) { skip++; res.write(`OK    [${contact_id.slice(0,8)}] ya está en stage correcta (${estado})\n`); continue; }

        // Actualizar stage
        const updateRes = await fetch(`https://services.leadconnectorhq.com/opportunities/${opp.id}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${cfg.ghlKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
          body: JSON.stringify({ pipelineStageId: targetStage }),
        });
        const updateData = await updateRes.json();
        if (updateData.opportunity?.id) {
          ok++;
          res.write(`MOVED [${contact_id.slice(0,8)}] ${estado} → stage actualizada ✓\n`);
        } else {
          err++;
          res.write(`ERROR [${contact_id.slice(0,8)}] GHL respondió: ${JSON.stringify(updateData).slice(0, 80)}\n`);
        }
      } catch (e) {
        err++;
        res.write(`ERROR [${contact_id.slice(0,8)}] ${e.message}\n`);
      }

      // Respetar rate limit de GHL
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) {
    res.write(`\nFATAL: ${e.message}\n`);
  }

  res.write(`\n=== RESULTADO ===\n`);
  res.write(`Movidas: ${ok} | Saltadas: ${skip} | Errores: ${err}\n`);
  res.end();
});

// ─── ANALYTICS ────────────────────────────────────────────────────────────────

app.use('/dashboard', analyticsRouter);

// ─── WEBHOOK ROUTES ───────────────────────────────────────────────────────────

app.post('/webhook/ghl', ghlWebhookHandler);
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
