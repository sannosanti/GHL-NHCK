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
  // Tracks a same-thread persona handoff (e.g. Carolina's number keeps
  // answering, but as Luisa, once the patient turns out to be an adult).
  // NULL means "answer as this deployment's own agent", as before.
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS derivado_a VARCHAR(20) DEFAULT NULL`).catch(() => {});
  // Preserves the estado a conversation was in right before it got marked
  // 'cerrado' (inactivity timeout), so reactivation can resume into
  // agendando/esperando_pago/escalado instead of being capped at whatever
  // triaje1/2/3 booleans can re-derive.
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS estado_antes_cierre TEXT DEFAULT NULL`).catch(() => {});
  // Per-call Claude token usage, tagged by agent (carolina/luisa share this
  // table via the same shared Postgres instance) — feeds the /dashboard/tokens
  // cost dashboard. Written by ai/claude.js after every successful API call.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id SERIAL PRIMARY KEY,
      agent VARCHAR(20) NOT NULL,
      model VARCHAR(60) NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_usage_agent_created ON token_usage (agent, created_at)`).catch(() => {});
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
  // loses the ON CONFLICT race. Two separate constraints enforced this on the
  // original single-agent schema — the inline "UNIQUE" on the column itself
  // (conversation_insights_conversation_id_key) and the explicit index below —
  // both must go or ON CONFLICT (conversation_id, agent) doesn't fully replace them.
  await pool.query(`ALTER TABLE conversation_insights DROP CONSTRAINT IF EXISTS conversation_insights_conversation_id_key`).catch(() => {});
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
    -- Un registro de Citas ya espejado en GHL. La clave primaria es lo que
    -- vuelve idempotente al webhook: el workflow de Creator lo dispara varias
    -- veces por el mismo registro, y sin esto cada disparo creaba otro evento.
    -- Auditado 2026-08-06 sobre julio-octubre: 104 grupos de eventos idénticos,
    -- ninguno del backfill, todos de disparos repetidos.
    CREATE TABLE IF NOT EXISTS citas_sync (
      zoho_cita_id TEXT PRIMARY KEY,
      ghl_event_id TEXT,
      calendar_id TEXT,
      clase TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Guardar además el horario espejado permite detectar una reprogramación
  // comparando contra la base, sin una llamada a GHL por cada disparo repetido
  // -- que son la mayoría. CREATE TABLE IF NOT EXISTS no agrega columnas a una
  // tabla que ya existe, de ahí los ALTER.
  await pool.query(`ALTER TABLE citas_sync ADD COLUMN IF NOT EXISTS inicio TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE citas_sync ADD COLUMN IF NOT EXISTS fin TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE citas_sync ADD COLUMN IF NOT EXISTS actualizado_at TIMESTAMP`).catch(() => {});

  // A submission Zoho refused is parked here so the answers survive the
  // rejection instead of being dropped. `etapa` records which of the two
  // Creator writes failed (historia-clinica or anamnesis), because the second
  // only runs when the first succeeds and the distinction decides what has to
  // be re-keyed by hand. `recuperado_at` stays NULL until someone loads it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anamnesis_fallidas (
      id SERIAL PRIMARY KEY,
      agent TEXT NOT NULL,
      formulario TEXT NOT NULL,
      nombre TEXT,
      movil TEXT,
      email TEXT,
      etapa TEXT NOT NULL,
      error JSONB,
      payload JSONB NOT NULL,
      recuperado_at TIMESTAMP,
      creado_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('Base de datos inicializada ✓');
}

// ─── IDEMPOTENCIA DEL SYNC DE CITAS ──────────────────────────────────────────
// Tres pasos, en este orden: reclamar antes de crear en GHL, confirmar con el id
// que devolvió, o liberar si falló.
//
// Reclamar primero y no después es lo que sostiene la garantía: el INSERT es
// atómico, así que entre dos disparos simultáneos del mismo registro sólo uno
// gana y el otro se va sin tocar GHL. Si se creara primero y se anotara después,
// ambos verían la tabla vacía y ambos crearían.
async function reclamarCitaZoho(zohoCitaId, clase) {
  if (!zohoCitaId) return true;   // sin ID no hay nada que deduplicar; no bloquear el sync
  try {
    const { rows } = await pool.query(
      `INSERT INTO citas_sync (zoho_cita_id, clase) VALUES ($1, $2)
       ON CONFLICT (zoho_cita_id) DO NOTHING
       RETURNING zoho_cita_id`,
      [zohoCitaId, clase || null]
    );
    return rows.length > 0;
  } catch (err) {
    // Un problema de base no puede costar una cita: se sigue de largo aceptando
    // el riesgo de un duplicado, que es recuperable, en vez de perder la cita.
    console.error('[citas_sync] no se pudo reclamar', zohoCitaId, '—', err.message);
    return true;
  }
}

// `clase` se vuelve a escribir acá, y no sólo al reclamar, porque la reserva la
// decide antes de saber qué se pudo crear: reclama 'cita' con sólo ver que el
// registro trae Contacto, y recién después se descubre que el contacto no tiene
// Movil y hay que degradar a bloqueo. Sin esta corrección la tabla decía 'cita'
// mientras GHL tenía un bloqueo, y esa mentira tapaba justo el caso que deja al
// paciente sin recordatorio. COALESCE para no pisar la clase cuando no se pasa.
async function confirmarCitaZoho(zohoCitaId, ghlEventId, calendarId, inicio, fin, clase) {
  if (!zohoCitaId) return;
  try {
    await pool.query(
      `UPDATE citas_sync
          SET ghl_event_id = $2, calendar_id = $3, inicio = $4, fin = $5,
              clase = COALESCE($6, clase), actualizado_at = NOW()
        WHERE zoho_cita_id = $1`,
      [zohoCitaId, ghlEventId || null, calendarId || null, inicio || null, fin || null, clase || null]
    );
  } catch (err) {
    console.error('[citas_sync] no se pudo confirmar', zohoCitaId, '—', err.message);
  }
}

// Lo ya espejado para este registro: contra esto se compara un disparo repetido
// para saber si es un reenvío igual o una reprogramación real.
async function getCitaSync(zohoCitaId) {
  if (!zohoCitaId) return null;
  try {
    const { rows } = await pool.query(`SELECT * FROM citas_sync WHERE zoho_cita_id = $1`, [zohoCitaId]);
    return rows[0] || null;
  } catch (err) {
    console.error('[citas_sync] no se pudo leer', zohoCitaId, '—', err.message);
    return null;
  }
}

// Sólo suelta la reserva si todavía no tiene evento asociado, para que un fallo
// tardío nunca borre la marca de una cita que sí llegó a crearse.
async function liberarCitaZoho(zohoCitaId) {
  if (!zohoCitaId) return;
  try {
    await pool.query(`DELETE FROM citas_sync WHERE zoho_cita_id = $1 AND ghl_event_id IS NULL`, [zohoCitaId]);
  } catch (err) {
    console.error('[citas_sync] no se pudo liberar', zohoCitaId, '—', err.message);
  }
}

async function getConversationData(conversationId) {
  try {
    const res = await pool.query('SELECT * FROM conversations WHERE conversation_id = $1 AND agent = $2', [conversationId, env.agentName]);
    return res.rows[0] || null;
  } catch (err) {
    // Re-throw instead of swallowing: a real DB error must not look like
    // "no row found" to callers, or a transient failure silently resets a
    // real contact back to a brand-new greeting (estado || 'nuevo').
    console.error('DB_ERROR getConversationData', conversationId, err);
    throw err;
  }
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

// Cuánto vale una lectura de agenda antes de volver a preguntarle a Zoho.
//
// Cada refresco barre ~12 días hábiles, o sea ~12 llamadas a Zoho. A 10 minutos
// eso daba un piso de ~1.000 llamadas diarias sobre un límite de cuenta de
// 4.000, y el 2026-08-20 la cuota se agotó a media tarde: las citas nuevas
// terminaron en el calendario general y la disponibilidad dejó de reflejar la
// ocupación real. A 30 minutos el piso baja a ~330.
//
// El techo lo pone el desfase aceptable, no el ahorro. Las citas que agenda el
// bot invalidan la caché de esa fecha al confirmarse (webhooks/ghl.js y
// webhooks/wompi.js), así que el desfase sólo afecta a lo que el personal
// agenda directo en Zoho. Media hora es tolerable para eso; una hora ya empieza
// a ofrecer horarios tomados.
const TTL_DISPONIBILIDAD_MINUTOS = 30;

async function getCachedDisponibilidad(fechaISO) {
  try {
    const res = await pool.query(
      "SELECT citas FROM availability_cache WHERE fecha_iso=$1 AND cached_at > NOW() - INTERVAL '1 minute' * $2",
      [fechaISO, TTL_DISPONIBILIDAD_MINUTOS]
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
    // Copies the current estado into estado_antes_cierre in the same UPDATE
    // (single query, no caller changes needed). Guarded so a repeat call
    // (already 'cerrado') doesn't clobber the previously saved estado.
    await pool.query(
      `UPDATE conversations
       SET estado_antes_cierre = CASE WHEN estado <> 'cerrado' THEN estado ELSE estado_antes_cierre END,
           estado='cerrado', updated_at=NOW()
       WHERE conversation_id=$1 AND agent=$2`,
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

async function getLearnedRules(overrideAgent) {
  try {
    const res = await pool.query(
      `SELECT rule FROM learned_rules WHERE agent = $1 ORDER BY created_at ASC`,
      [overrideAgent || env.agentName]
    );
    return res.rows.map(r => r.rule);
  } catch { return []; }
}

// Marks a conversation as being served under the other agent's persona/rules
// while staying on this deployment's own WhatsApp number/thread.
async function setDerivadoA(conversationId, brand) {
  try {
    await pool.query(
      'UPDATE conversations SET derivado_a=$1 WHERE conversation_id=$2 AND agent=$3',
      [brand, conversationId, env.agentName]
    );
  } catch (err) { console.error('Error guardando derivado_a:', err.message); }
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

async function logTokenUsage(agent, model, usage, costUsd) {
  try {
    await pool.query(
      `INSERT INTO token_usage
        (agent, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        agent, model,
        usage?.input_tokens || 0,
        usage?.output_tokens || 0,
        usage?.cache_creation_input_tokens || 0,
        usage?.cache_read_input_tokens || 0,
        costUsd || 0,
      ]
    );
  } catch (err) { console.error('Error logging token usage:', err.message); }
}

// Shared window predicate so every dashboard query can be scoped the same way,
// by rolling days or by a calendar month, without each one growing its own
// copy of the logic. Accepts a plain number for the old days-only callers.
// Months and days both resolve on Bogota time: on the 31st, an evening still
// inside business hours would otherwise land in the next month.
function rango(opts, col) {
  const o = (typeof opts === 'number' || opts == null) ? { days: opts } : opts;
  const mes = String(o.month || '').trim();
  if (/^\d{4}-\d{2}$/.test(mes)) {
    return {
      clause: `to_char(date_trunc('month', ${col} AT TIME ZONE 'America/Bogota'), 'YYYY-MM') = $1`,
      params: [mes],
    };
  }
  const days = Math.min(parseInt(o.days, 10) || 30, 90);
  return { clause: `${col} > NOW() - ($1 || ' days')::interval`, params: [String(days)] };
}

// Buckets by Bogotá calendar day, not UTC day — created_at is UTC
// (timestamptz), so grouping on date_trunc('day', created_at) directly
// splits every Bogotá evening (7pm-midnight, still inside business hours)
// into the "next day" bucket. Converting to America/Bogota before truncating
// fixes that (confirmed live 2026-07-21: ~15-30 calls/day were landing in
// the wrong bucket).
async function getTokenUsageDaily(opts = 30) {
  const r = rango(opts, 'created_at');
  const res = await pool.query(
    `SELECT
       agent,
       to_char(date_trunc('day', created_at AT TIME ZONE 'America/Bogota'), 'YYYY-MM-DD') AS day,
       SUM(input_tokens)::bigint AS input_tokens,
       SUM(output_tokens)::bigint AS output_tokens,
       SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
       SUM(cache_read_input_tokens)::bigint AS cache_read_input_tokens,
       SUM(cost_usd)::float AS cost_usd,
       COUNT(*)::int AS calls
     FROM token_usage
     WHERE ${r.clause}
     GROUP BY agent, day
     ORDER BY day ASC`,
    r.params
  );
  return res.rows;
}

// Current estado distribution per agent — the conversation funnel (nuevo ->
// triaje_p1/p2/p3 -> triaje_completo -> escalado/cerrado). estado is
// overwritten in place on every touch (no history table), so this is a
// snapshot of where conversations stand today, not a true day-by-day funnel.
async function getConversationFunnel(opts = 30) {
  const r = rango(opts, 'updated_at');
  const res = await pool.query(
    `SELECT agent, estado, COUNT(*)::int AS count
     FROM conversations
     WHERE ${r.clause}
     GROUP BY agent, estado
     ORDER BY agent, count DESC`,
    r.params
  );
  return res.rows;
}

// Why conversations close or escalate, from the same transaction_logs the
// weekly/daily reports already use — feeds the "motivos de cierre" chart.
async function getEventBreakdown(opts = 30) {
  const r = rango(opts, 'created_at');
  const res = await pool.query(
    `SELECT agent, event_type, COUNT(*)::int AS count
     FROM transaction_logs
     WHERE ${r.clause}
     GROUP BY agent, event_type
     ORDER BY agent, count DESC`,
    r.params
  );
  return res.rows;
}

// Daily distinct conversations touched per agent — token_usage has no
// conversation_id, so cost-per-conversation can only be an average over the
// period (total cost / total conversations), not a true per-lead figure.
// Bucketed by Bogotá day for the same reason getTokenUsageDaily is.
async function getConversationVolumeDaily(opts = 30) {
  const r = rango(opts, 'updated_at');
  const res = await pool.query(
    `SELECT agent,
       to_char(date_trunc('day', updated_at AT TIME ZONE 'America/Bogota'), 'YYYY-MM-DD') AS day,
       COUNT(DISTINCT conversation_id)::int AS conversaciones
     FROM conversations
     WHERE ${r.clause}
     GROUP BY agent, day
     ORDER BY day ASC`,
    r.params
  );
  return res.rows;
}

// Cost per calendar month per agent — the billing view. Grouped on Bogotá
// months for the same reason the daily queries are: an evening still inside
// business hours would otherwise be billed to the following day, and on the
// 31st, to the following MONTH. Returns whole months back from today, so the
// current month is always partial and must be labelled as such.
async function getTokenUsageMonthly(months = 12) {
  const res = await pool.query(
    `SELECT
       agent,
       to_char(date_trunc('month', created_at AT TIME ZONE 'America/Bogota'), 'YYYY-MM') AS mes,
       SUM(input_tokens)::bigint AS input_tokens,
       SUM(output_tokens)::bigint AS output_tokens,
       SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
       SUM(cache_read_input_tokens)::bigint AS cache_read_input_tokens,
       SUM(cost_usd)::float AS cost_usd,
       COUNT(*)::int AS calls,
       MIN(created_at AT TIME ZONE 'America/Bogota')::date AS primer_dia,
       MAX(created_at AT TIME ZONE 'America/Bogota')::date AS ultimo_dia
     FROM token_usage
     WHERE created_at > date_trunc('month', NOW() AT TIME ZONE 'America/Bogota') - ($1 || ' months')::interval
     GROUP BY agent, mes
     ORDER BY mes DESC`,
    [months]
  );
  return res.rows;
}

// Events split per day AND per type, for the day-by-day view. getEventBreakdown
// aggregates the same table over the whole period; this keeps the day axis so
// the dashboard can show what happened on each specific date. Bucketed by
// Bogotá day for the same reason getTokenUsageDaily is.
async function getEventsDaily(days = 30) {
  const res = await pool.query(
    `SELECT agent,
       to_char(date_trunc('day', created_at AT TIME ZONE 'America/Bogota'), 'YYYY-MM-DD') AS day,
       event_type,
       COUNT(*)::int AS count
     FROM transaction_logs
     WHERE created_at > NOW() - ($1 || ' days')::interval
     GROUP BY agent, day, event_type
     ORDER BY day ASC`,
    [days]
  );
  return res.rows;
}

// Insights (root cause of drop-off) per day. Same shape and caveats as above.
async function getInsightsDaily(days = 30) {
  const res = await pool.query(
    `SELECT agent,
       to_char(date_trunc('day', created_at AT TIME ZONE 'America/Bogota'), 'YYYY-MM-DD') AS day,
       root_cause,
       COUNT(*)::int AS count
     FROM conversation_insights
     WHERE created_at > NOW() - ($1 || ' days')::interval
     GROUP BY agent, day, root_cause
     ORDER BY day ASC`,
    [days]
  );
  return res.rows;
}


// Parks a submission Zoho refused so the answers survive the rejection. The
// anamnesis endpoints used to drop the payload on the floor when Creator said
// no, which meant a patient who had just spent twenty minutes on a clinical
// history had to be asked to do it again — if anyone noticed at all. Nobody
// did: the notice was sent inside the success branch. Stores the raw body,
// not a summary, because whoever re-keys it needs every answer.
// Returns the row id so the alert can name what to recover, or null if even
// this failed, in which case the caller must not promise a recovery.
async function guardarAnamnesisFallida({ formulario, nombre, movil, email, etapa, error, payload }) {
  try {
    const res = await pool.query(`
      INSERT INTO anamnesis_fallidas (agent, formulario, nombre, movil, email, etapa, error, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id
    `, [env.agentName, formulario, nombre || null, movil || null, email || null, etapa,
        JSON.stringify(error ?? null), JSON.stringify(payload || {})]);
    return res.rows[0]?.id || null;
  } catch (err) {
    console.error('Error guardando anamnesis fallida:', err.message);
    return null;
  }
}

async function getAnamnesisFallidas() {
  try {
    const res = await pool.query(
      // creado_at es TIMESTAMP sin zona y guarda UTC. Formatearlo en Node lo
      // leería como hora local y correría el reloj cinco horas, que es
      // justamente la hora que alguien va a buscar en el formulario.
      `SELECT *, to_char(creado_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota',
                         'DD/MM/YYYY HH24:MI') AS hora_local
       FROM anamnesis_fallidas WHERE recuperado_at IS NULL ORDER BY creado_at DESC LIMIT 100`
    );
    return res.rows;
  } catch (err) {
    console.error('Error leyendo anamnesis fallidas:', err.message);
    return [];
  }
}

async function marcarAnamnesisRecuperada(id) {
  try {
    await pool.query('UPDATE anamnesis_fallidas SET recuperado_at = NOW() WHERE id = $1', [id]);
  } catch (err) {
    console.error('Error marcando anamnesis recuperada:', err.message);
  }
}

module.exports = {
  pool,
  initDB,
  logTokenUsage,
  getTokenUsageDaily,
  getConversationFunnel,
  getEventBreakdown,
  getConversationVolumeDaily,
  getEventsDaily,
  getInsightsDaily,
  getTokenUsageMonthly,
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
  setDerivadoA,
  queuePendingWebhook,
  getPendingWebhooks,
  bumpPendingWebhookAttempt,
  deletePendingWebhook,
  guardarAnamnesisFallida,
  getAnamnesisFallidas,
  marcarAnamnesisRecuperada,
  reclamarCitaZoho,
  confirmarCitaZoho,
  liberarCitaZoho,
  getCitaSync,
};
