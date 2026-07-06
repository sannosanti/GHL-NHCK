'use strict';

const { Pool } = require('pg');
const { env } = require('../config');

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      contact_id TEXT,
      phone TEXT,
      messages JSONB DEFAULT '[]',
      triaje JSONB DEFAULT '{}',
      estado TEXT DEFAULT 'nuevo',
      last_message_id TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pending_payments (
      referencia TEXT PRIMARY KEY,
      contact_id TEXT,
      conversation_id TEXT,
      contact_data JSONB,
      fecha_cita TEXT,
      hora_cita TEXT,
      edad TEXT,
      genero TEXT,
      ocupacion TEXT,
      sintoma TEXT,
      nombre_nino TEXT,
      nombre TEXT,
      payment_link_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS availability_cache (
      fecha_iso TEXT PRIMARY KEY,
      citas JSONB DEFAULT '[]',
      cached_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS contact_cache (
      contact_id TEXT PRIMARY KEY,
      contact_data JSONB,
      cached_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transaction_logs (
      id SERIAL PRIMARY KEY,
      contact_id TEXT,
      conversation_id TEXT,
      event_type TEXT,
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS nombre_nino TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS nombre TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS payment_link_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS recovery_status VARCHAR(50) DEFAULT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS asesor_analyzed BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent VARCHAR(20) DEFAULT 'carolina'`).catch(() => {});
  await pool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS agent VARCHAR(20) DEFAULT 'carolina'`).catch(() => {});
  // GHL uses one conversation_id per contact regardless of which agent's
  // WhatsApp number they wrote to — without agent in the key, Luisa and
  // Carolina collide on the same row and inherit each other's history.
  await pool.query(`ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_pkey`).catch(() => {});
  await pool.query(`ALTER TABLE conversations ADD PRIMARY KEY (conversation_id, agent)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_insights (
      id SERIAL PRIMARY KEY,
      conversation_id TEXT UNIQUE,
      contact_id TEXT,
      outcome TEXT,
      estado_final TEXT,
      drop_off_point TEXT,
      root_cause TEXT,
      missed_questions JSONB DEFAULT '[]',
      what_worked TEXT,
      improvement_suggestion TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS knowledge_gaps (
      id SERIAL PRIMARY KEY,
      pregunta TEXT UNIQUE,
      frecuencia INT DEFAULT 1,
      sugerencia_respuesta TEXT,
      aprobada BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE conversation_insights ADD COLUMN IF NOT EXISTS agent VARCHAR(20) DEFAULT 'carolina'`).catch(() => {});
  await pool.query(`ALTER TABLE prompt_updates ADD COLUMN IF NOT EXISTS agent VARCHAR(20) DEFAULT 'carolina'`).catch(() => {});
  await pool.query(`ALTER TABLE learned_rules ADD COLUMN IF NOT EXISTS agent VARCHAR(20) DEFAULT 'carolina'`).catch(() => {});
  await pool.query(`ALTER TABLE transaction_logs ADD COLUMN IF NOT EXISTS agent VARCHAR(20) DEFAULT 'carolina'`).catch(() => {});
  // Same reasoning as conversations' PK: conversation_id alone collides across
  // agents sharing this Postgres, silently dropping whichever agent's insight
  // loses the ON CONFLICT race.
  await pool.query(`DROP INDEX IF EXISTS idx_insights_conv`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_conv_agent ON conversation_insights (conversation_id, agent)`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gaps_pregunta ON knowledge_gaps (pregunta)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompt_updates (
      id TEXT PRIMARY KEY,
      approval_key TEXT NOT NULL,
      root_cause TEXT,
      recommendation TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      approved_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS learned_rules (
      id SERIAL PRIMARY KEY,
      rule TEXT NOT NULL,
      source_update_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pending_webhooks (
      contact_id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      attempts INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      last_attempt_at TIMESTAMP
    );
  `);
  console.log('Base de datos inicializada ✓');
}

async function getConversationData(conversationId) {
  try {
    const res = await pool.query('SELECT * FROM conversations WHERE conversation_id = $1 AND agent = $2', [conversationId, env.agentName]);
    return res.rows[0] || null;
  } catch { return null; }
}

async function saveConversationData(conversationId, contactId, messages, triaje, estado, lastMessageId, phone) {
  try {
    await pool.query(`
      INSERT INTO conversations (conversation_id, contact_id, phone, messages, triaje, estado, last_message_id, agent, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (conversation_id, agent) DO UPDATE
      SET messages=$4, triaje=$5, estado=$6, last_message_id=$7, phone=COALESCE($3, conversations.phone), updated_at=NOW()
    `, [conversationId, contactId, phone || null, JSON.stringify(messages), JSON.stringify(triaje), estado, lastMessageId, env.agentName]);
  } catch (err) { console.error('Error guardando conversación:', err.message); }
}

async function limpiarContactoDB(contactId) {
  try {
    await pool.query('DELETE FROM conversations WHERE contact_id = $1', [contactId]);
    await pool.query('DELETE FROM contact_cache WHERE contact_id = $1', [contactId]);
    await pool.query('DELETE FROM pending_payments WHERE contact_id = $1', [contactId]);
    console.log(`DB limpiada para contacto: ${contactId}`);
  } catch (err) { console.error('Error limpiando contacto DB:', err.message); }
}

// GHL's search index can lag the actual write by more than any reasonable
// in-request wait. When a webhook can't resolve conversationId/message
// content in time, it's queued here instead of being dropped, and
// jobs/pendingWebhookJob.js retries it in the background — surviving
// deploys/restarts, unlike an in-memory retry loop.
async function queuePendingWebhook(contactId, payload) {
  try {
    await pool.query(`
      INSERT INTO pending_webhooks (contact_id, payload, attempts, created_at)
      VALUES ($1,$2,0,NOW())
      ON CONFLICT (contact_id) DO UPDATE SET payload=$2, last_attempt_at=NULL
    `, [contactId, JSON.stringify(payload)]);
  } catch (err) { console.error('Error queueing pending webhook:', err.message); }
}

async function getPendingWebhooks() {
  try {
    const res = await pool.query('SELECT * FROM pending_webhooks ORDER BY created_at ASC LIMIT 50');
    return res.rows;
  } catch (err) { console.error('Error fetching pending webhooks:', err.message); return []; }
}

async function bumpPendingWebhookAttempt(contactId) {
  try {
    await pool.query('UPDATE pending_webhooks SET attempts = attempts + 1, last_attempt_at = NOW() WHERE contact_id=$1', [contactId]);
  } catch (err) { console.error('Error bumping pending webhook:', err.message); }
}

async function deletePendingWebhook(contactId) {
  try {
    await pool.query('DELETE FROM pending_webhooks WHERE contact_id=$1', [contactId]);
  } catch (err) { console.error('Error deleting pending webhook:', err.message); }
}

async function getCachedContact(contactId) {
  try {
    const res = await pool.query(
      "SELECT contact_data FROM contact_cache WHERE contact_id=$1 AND cached_at > NOW() - INTERVAL '5 minutes'",
      [contactId]
    );
    return res.rows[0]?.contact_data || null;
  } catch { return null; }
}

async function setCachedContact(contactId, contactData) {
  try {
    await pool.query(`
      INSERT INTO contact_cache (contact_id, contact_data, cached_at) VALUES ($1,$2,NOW())
      ON CONFLICT (contact_id) DO UPDATE SET contact_data=$2, cached_at=NOW()
    `, [contactId, JSON.stringify(contactData)]);
  } catch (err) { console.error('Error cacheando contacto:', err.message); }
}

async function savePendingPayment(referencia, datos) {
  try {
    await pool.query(`
      INSERT INTO pending_payments (referencia,contact_id,conversation_id,contact_data,fecha_cita,hora_cita,edad,genero,ocupacion,sintoma,nombre_nino,nombre,payment_link_id,agent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (referencia) DO UPDATE SET fecha_cita=$5, hora_cita=$6, payment_link_id=$13
    `, [referencia, datos.contactId, datos.conversationId, JSON.stringify(datos.contact),
        datos.fechaCita, datos.horaCita, datos.edad, datos.genero, datos.ocupacion,
        datos.sintoma, datos.nombreNino, datos.nombre, datos.paymentLinkId || null, env.agentName]);
  } catch (err) { console.error('Error guardando pago:', err.message); }
}

async function getPendingPayment(reference) {
  try {
    let res = await pool.query('SELECT * FROM pending_payments WHERE referencia=$1', [reference]);
    if (!res.rows[0]) {
      const linkId = reference.split('_').slice(0, 2).join('_');
      res = await pool.query('SELECT * FROM pending_payments WHERE payment_link_id=$1', [linkId]);
    }
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      contactId: r.contact_id, conversationId: r.conversation_id, contact: r.contact_data,
      fechaCita: r.fecha_cita, horaCita: r.hora_cita, edad: r.edad, genero: r.genero,
      ocupacion: r.ocupacion, sintoma: r.sintoma, nombreNino: r.nombre_nino, nombre: r.nombre,
    };
  } catch { return null; }
}

async function deletePendingPayment(referencia) {
  try { await pool.query('DELETE FROM pending_payments WHERE referencia=$1', [referencia]); }
  catch (err) { console.error('Error borrando pago:', err.message); }
}

async function getCachedDisponibilidad(fechaISO) {
  try {
    const res = await pool.query(
      "SELECT citas FROM availability_cache WHERE fecha_iso=$1 AND cached_at > NOW() - INTERVAL '10 minutes'",
      [fechaISO]
    );
    return res.rows[0]?.citas || null;
  } catch { return null; }
}

async function setCachedDisponibilidad(fechaISO, citas) {
  try {
    await pool.query(`
      INSERT INTO availability_cache (fecha_iso, citas, cached_at) VALUES ($1,$2,NOW())
      ON CONFLICT (fecha_iso) DO UPDATE SET citas=$2, cached_at=NOW()
    `, [fechaISO, JSON.stringify(citas)]);
  } catch (err) { console.error('Error guardando caché:', err.message); }
}

async function logEvent(contactId, conversationId, eventType, data) {
  try {
    await pool.query(
      'INSERT INTO transaction_logs (contact_id,conversation_id,event_type,data,agent) VALUES ($1,$2,$3,$4,$5)',
      [contactId, conversationId, eventType, JSON.stringify(data), env.agentName]
    );
  } catch (err) { console.error('Error log:', err.message); }
}

// New wrapper helpers (resolve design open questions)
async function deleteAvailabilityCache(fechaISO) {
  await pool.query('DELETE FROM availability_cache WHERE fecha_iso=$1', [fechaISO]).catch(() => {});
}

async function getPendingPaymentsByContact(contactId) {
  try {
    const res = await pool.query(
      'SELECT * FROM pending_payments WHERE contact_id=$1 ORDER BY created_at DESC LIMIT 1',
      [contactId]
    );
    return res.rows[0] || null;
  } catch { return null; }
}

async function saveConversationInsight(conversationId, contactId, outcome, estadoFinal, analysis) {
  try {
    await pool.query(`
      INSERT INTO conversation_insights
        (conversation_id, contact_id, outcome, estado_final, drop_off_point, root_cause, missed_questions, what_worked, improvement_suggestion, agent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (conversation_id, agent) DO NOTHING
    `, [
      conversationId, contactId, outcome, estadoFinal,
      analysis.drop_off_point || null,
      analysis.root_cause || null,
      JSON.stringify(analysis.missed_questions || []),
      analysis.what_worked || null,
      analysis.improvement_suggestion || null,
      env.agentName,
    ]);
  } catch (err) { console.error('Error guardando insight:', err.message); }
}

async function getWeeklyInsights() {
  try {
    const res = await pool.query(`
      SELECT * FROM conversation_insights
      WHERE created_at > NOW() - INTERVAL '7 days' AND agent = $1
      ORDER BY created_at DESC
    `, [env.agentName]);
    return res.rows;
  } catch { return []; }
}

async function saveKnowledgeGap(pregunta, sugerencia) {
  try {
    await pool.query(`
      INSERT INTO knowledge_gaps (pregunta, frecuencia, sugerencia_respuesta)
      VALUES ($1, 1, $2)
      ON CONFLICT DO NOTHING
    `, [pregunta, sugerencia]);
  } catch (err) { console.error('Error guardando gap:', err.message); }
}

async function getKnowledgeGaps() {
  try {
    const res = await pool.query(`
      SELECT * FROM knowledge_gaps WHERE aprobada = FALSE ORDER BY frecuencia DESC
    `);
    return res.rows;
  } catch { return []; }
}

async function marcarCerrado(conversationId) {
  try {
    await pool.query(
      "UPDATE conversations SET estado='cerrado', updated_at=NOW() WHERE conversation_id=$1 AND agent=$2",
      [conversationId, env.agentName]
    );
  } catch (err) { console.error('Error marcando cerrado:', err.message); }
}

async function marcarCompletado(conversationId) {
  try {
    await pool.query(
      "UPDATE conversations SET estado='completado', updated_at=NOW() WHERE conversation_id=$1 AND agent=$2",
      [conversationId, env.agentName]
    );
  } catch (err) { console.error('Error marcando completado:', err.message); }
}

async function countInsightsByRootCause(rootCause, days = 30) {
  try {
    const res = await pool.query(
      `SELECT COUNT(*) FROM conversation_insights
       WHERE root_cause=$1 AND agent=$2 AND created_at > NOW() - INTERVAL '${days} days'`,
      [rootCause, env.agentName]
    );
    return parseInt(res.rows[0].count, 10);
  } catch { return 0; }
}

async function hasPendingUpdateForRootCause(rootCause) {
  try {
    const res = await pool.query(
      `SELECT id FROM prompt_updates WHERE root_cause=$1 AND status='pending' AND agent=$2`,
      [rootCause, env.agentName]
    );
    return res.rows.length > 0;
  } catch { return false; }
}

async function savePendingUpdate(id, approvalKey, rootCause, recommendation, reason) {
  try {
    await pool.query(
      `INSERT INTO prompt_updates (id, approval_key, root_cause, recommendation, reason, agent)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [id, approvalKey, rootCause, recommendation, reason, env.agentName]
    );
  } catch (err) { console.error('Error guardando update:', err.message); }
}

async function approveUpdate(id, approvalKey) {
  try {
    const res = await pool.query(
      `UPDATE prompt_updates SET status='approved', approved_at=NOW()
       WHERE id=$1 AND approval_key=$2 AND status='pending' RETURNING *`,
      [id, approvalKey]
    );
    const update = res.rows[0];
    if (!update) return null;
    await pool.query(
      `INSERT INTO learned_rules (rule, source_update_id, agent) VALUES ($1,$2,$3)`,
      [update.recommendation, id, update.agent]
    );
    return update;
  } catch (err) { console.error('Error aprobando update:', err.message); return null; }
}

async function getLearnedRules() {
  try {
    const res = await pool.query(
      `SELECT rule FROM learned_rules WHERE agent = $1 ORDER BY created_at ASC`,
      [env.agentName]
    );
    return res.rows.map(r => r.rule);
  } catch { return []; }
}

async function hasAsesorAnalysis(conversationId) {
  try {
    const res = await pool.query(
      `SELECT asesor_analyzed FROM conversations WHERE conversation_id = $1 AND agent = $2`,
      [conversationId, env.agentName]
    );
    return res.rows[0]?.asesor_analyzed === true;
  } catch { return false; }
}

async function markAsesorAnalyzed(conversationId) {
  try {
    await pool.query(
      `UPDATE conversations SET asesor_analyzed = TRUE WHERE conversation_id = $1 AND agent = $2`,
      [conversationId, env.agentName]
    );
  } catch { /* non-critical */ }
}

async function getRecentInsightSuggestions(rootCause, days = 30) {
  try {
    const res = await pool.query(
      `SELECT improvement_suggestion, drop_off_point, what_worked
       FROM conversation_insights
       WHERE root_cause=$1 AND agent=$2 AND created_at > NOW() - INTERVAL '${days} days'
       ORDER BY created_at DESC LIMIT 10`,
      [rootCause, env.agentName]
    );
    return res.rows;
  } catch { return []; }
}

module.exports = {
  pool,
  initDB,
  getConversationData,
  saveConversationData,
  limpiarContactoDB,
  getCachedContact,
  setCachedContact,
  savePendingPayment,
  getPendingPayment,
  deletePendingPayment,
  getCachedDisponibilidad,
  setCachedDisponibilidad,
  logEvent,
  deleteAvailabilityCache,
  getPendingPaymentsByContact,
  marcarCerrado,
  marcarCompletado,
  saveConversationInsight,
  getWeeklyInsights,
  saveKnowledgeGap,
  getKnowledgeGaps,
  countInsightsByRootCause,
  hasPendingUpdateForRootCause,
  savePendingUpdate,
  approveUpdate,
  getLearnedRules,
  getRecentInsightSuggestions,
  hasAsesorAnalysis,
  markAsesorAnalyzed,
  queuePendingWebhook,
  getPendingWebhooks,
  bumpPendingWebhookAttempt,
  deletePendingWebhook,
};
