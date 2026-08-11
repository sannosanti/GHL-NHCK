'use strict';

// Outbound HTTPS calls across this process (GHL, Anthropic, Zoho — every
// node-fetch call that doesn't pass its own `agent` option) have been failing
// intermittently with "Premature close" for hours-old server instances while
// a freshly started process never reproduces it. That pattern points at
// Node's default keep-alive https.globalAgent accumulating stale pooled
// sockets over the process's lifetime rather than any one destination being
// unreliable. Disabling keep-alive globally trades a bit of per-request
// latency (fresh TCP+TLS handshake each time) for removing this entire
// failure class everywhere in the app, not just the GHL-specific fix applied
// earlier in services/ghl.js. Must run before any other module is required,
// in case something creates a fetch/agent at require-time.
require('https').globalAgent = new (require('https').Agent)({ keepAlive: false });

const express = require('express');
const { env } = require('./config');
const db = require('./db');
const { removeTag } = require('./services/ghl');
const { ghlWebhookHandler, ghlCrearEnCreatorHandler, ghlCrearEnCreatorNHCHandler } = require('./webhooks/ghl');
const { wompiWebhookHandler, pagoExitosoHandler } = require('./webhooks/wompi');
const { zohoCitaWebhookHandler } = require('./webhooks/zoho');
const analyticsRouter = require('./analytics');
const tokenDashboardRouter = require('./analytics/tokens');
const { startRecoveryJob } = require('./jobs/recoveryJob');
const { startWeeklyReport } = require('./jobs/weeklyReport');
const { startDailyReport } = require('./jobs/dailyReport');
const { startPendingWebhookJob } = require('./jobs/pendingWebhookJob');
const { notify, notifyError } = require('./services/notifier');
const { answerQuestion } = require('./services/cliqBot');
const { getZohoAccessToken, crearTriajeInfantil, buscarOCrearContactoAnamnesisClinica, crearAnamnesisNinos } = require('./services/zoho');
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

// Every dashboard query is scoped to the same window so the whole report
// answers one question ("what happened in this period"), instead of the panels
// showing all-time totals next to a filtered day table.
//
// `day` wins over `days` when present, and buckets by Bogota calendar day for
// the same reason getTokenUsageDaily does: an evening still inside business
// hours would otherwise fall into the next day.
//
// IMPORTANT about conversations: the table has no created_at, only updated_at,
// overwritten on every touch, and `estado` is overwritten in place too. So a
// filtered funnel reads "conversations ACTIVE in this window, in the state they
// are in TODAY" — not the state they were in back then. There is no history
// table to do better; the UI labels it accordingly.
function rangoFecha(req, col) {
  const day = String(req.query.day || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return {
      clause: `date_trunc('day', ${col} AT TIME ZONE 'America/Bogota') = $1::date`,
      params: [day],
      dia: day,
      dias: null,
    };
  }
  const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
  return {
    clause: `${col} > NOW() - ($1 || ' days')::interval`,
    params: [String(days)],
    dia: null,
    dias: days,
  };
}

// Both agents, since Carolina and Luisa share this Postgres instance — same
// scope decision as /informe/tokens and /informe/negocio. Every query returns
// an `agent` column instead of filtering to env.agentName so the dashboard
// can compare Carolina vs Luisa side by side.
app.get('/informe', async (req, res) => {
  try {
    const conv = rangoFecha(req, 'updated_at');   // conversations
    const crea = rangoFecha(req, 'created_at');   // event/insight/payment tables
    const P = conv.params;

    const [estados, eventos, causas, sintomas, recovery, funnel, gaps, pendientes] = await Promise.all([
      db.pool.query(`SELECT agent, estado, COUNT(*) as total FROM conversations WHERE ${conv.clause} GROUP BY agent, estado ORDER BY agent, total DESC`, P),
      db.pool.query(`SELECT agent, event_type, COUNT(*) as total FROM transaction_logs WHERE ${crea.clause} GROUP BY agent, event_type ORDER BY agent, total DESC`, P),
      db.pool.query(`SELECT agent, root_cause, outcome, COUNT(*) as total FROM conversation_insights WHERE ${crea.clause} GROUP BY agent, root_cause, outcome ORDER BY agent, total DESC`, P),
      db.pool.query(`SELECT agent, triaje->>'triaje1' as sintoma, COUNT(*) as total FROM conversations WHERE ${conv.clause} AND triaje->>'triaje1' IS NOT NULL AND triaje->>'triaje1' != '' GROUP BY agent, sintoma ORDER BY agent, total DESC`, P),
      db.pool.query(`SELECT agent, recovery_status, COUNT(*) as total FROM conversations WHERE ${conv.clause} AND recovery_status IS NOT NULL GROUP BY agent, recovery_status`, P),
      db.pool.query(`SELECT agent, COUNT(*) FILTER (WHERE estado IN ('triaje_completo','agendando','esperando_pago','completado')) as con_triaje, COUNT(*) FILTER (WHERE estado='esperando_pago') as esperando_pago, COUNT(*) FILTER (WHERE estado='completado') as completados, COUNT(*) FILTER (WHERE estado='cerrado') as cerrados, COUNT(*) FILTER (WHERE estado='escalado') as escalados, COUNT(*) as total FROM conversations WHERE ${conv.clause} GROUP BY agent`, P),
      db.pool.query(`SELECT pregunta, frecuencia FROM knowledge_gaps WHERE ${crea.clause} ORDER BY frecuencia DESC LIMIT 10`, P),
      db.pool.query(`SELECT agent, COUNT(*) as total, MIN(created_at) as mas_antigua FROM pending_payments WHERE ${crea.clause} GROUP BY agent`, P),
    ]);
    res.json({
      generado: new Date().toISOString(),
      dias: conv.dias,
      dia: conv.dia,
      funnel: funnel.rows,
      estados: estados.rows,
      eventos: eventos.rows,
      root_causes: causas.rows,
      sintomas: sintomas.rows,
      recovery: recovery.rows,
      pagos_pendientes: pendientes.rows,
      knowledge_gaps: gaps.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/informe/triaje-completo', async (req, res) => {
  try {
    // Scoped to the same window as /informe so the "leads sin convertir" count
    // in each panel matches the period the rest of the board is showing.
    const conv = rangoFecha(req, 'c.updated_at');
    const { rows } = await db.pool.query(`
      SELECT
        c.conversation_id,
        c.contact_id,
        c.agent,
        c.estado,
        c.triaje,
        c.messages,
        c.updated_at,
        c.recovery_status,
        cc.contact_data
      FROM conversations c
      LEFT JOIN contact_cache cc ON cc.contact_id = c.contact_id
      WHERE c.estado = 'triaje_completo' AND ${conv.clause}
      ORDER BY c.updated_at DESC
    `, conv.params);

    const result = rows.map(r => {
      const msgs = Array.isArray(r.messages) ? r.messages : [];
      const cd = r.contact_data || {};
      const botLabel = r.agent === 'luisa' ? 'LUISA' : 'CAROLINA';
      const lastMessages = msgs.slice(-6).map(m => ({
        rol: m.role === 'user' ? 'CLIENTE' : botLabel,
        texto: Array.isArray(m.content)
          ? m.content.map(c => c.text || '').join('')
          : (m.content || ''),
      }));
      const minutosInactivo = Math.round((Date.now() - new Date(r.updated_at).getTime()) / 60000);
      return {
        agent: r.agent,
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

// The individual conversations behind a root_cause bucket, with contact and
// phone so they can actually be followed up. /informe only returns the counts,
// which tells you 164 cases escalated as caso_complejo but not WHICH ones, so
// nobody could act on the number.
app.get('/informe/casos', async (req, res) => {
  try {
    const causa = String(req.query.root_cause || '').trim();
    const rango = rangoFecha(req, 'i.created_at');
    const params = [...rango.params];
    let filtroCausa = '';
    if (causa) { params.push(causa); filtroCausa = ` AND i.root_cause = $${params.length}`; }

    const { rows } = await db.pool.query(`
      SELECT
        i.conversation_id, i.contact_id, i.agent, i.root_cause, i.outcome,
        i.estado_final, i.drop_off_point, i.improvement_suggestion, i.created_at,
        c.estado AS estado_actual, c.updated_at, c.triaje,
        cc.contact_data
      FROM conversation_insights i
      LEFT JOIN conversations c ON c.conversation_id = i.conversation_id AND c.agent = i.agent
      LEFT JOIN contact_cache cc ON cc.contact_id = i.contact_id
      WHERE ${rango.clause}${filtroCausa}
      ORDER BY i.created_at DESC
      LIMIT 500
    `, params);

    const casos = rows.map(r => {
      const cd = r.contact_data || {};
      return {
        conversation_id: r.conversation_id,
        contact_id: r.contact_id,
        agent: r.agent,
        contacto: cd.firstName ? `${cd.firstName} ${cd.lastName || ''}`.trim() : (r.contact_id || '—'),
        telefono: cd.phone || null,
        sintoma: r.triaje?.triaje1 || null,
        root_cause: r.root_cause,
        outcome: r.outcome,
        estado_final: r.estado_final,
        estado_actual: r.estado_actual,
        drop_off_point: r.drop_off_point,
        sugerencia: r.improvement_suggestion,
        fecha: r.created_at,
      };
    });

    res.json({ total: casos.length, dias: rango.dias, dia: rango.dia, root_cause: causa || null, casos });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Token/cost usage — both agents, since Carolina and Luisa share this Postgres
// instance (see db/index.js token_usage table). Not filtered by env.agentName
// on purpose: this dashboard is meant to compare the two bots side by side.
app.get('/informe/tokens', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const mes = String(req.query.month || '').trim();
    const porMes = /^\d{4}-\d{2}$/.test(mes);

    // Billing view: whole calendar months, always returned so the month picker
    // stays populated no matter which window is being shown.
    const mensual = await db.getTokenUsageMonthly(12);

    // Picking a month shows that month day by day instead of a rolling window,
    // which is what you want when reconciling an invoice.
    const diario = porMes
      ? (await db.pool.query(
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
           WHERE to_char(date_trunc('month', created_at AT TIME ZONE 'America/Bogota'), 'YYYY-MM') = $1
           GROUP BY agent, day
           ORDER BY day ASC`, [mes])).rows
      : await db.getTokenUsageDaily(days);
    // Totals for the SELECTED window, summed from the very rows the detail
    // table renders. They used to be hardcoded to "today" and "this month" and
    // ignored the filters entirely, so the headline numbers contradicted the
    // table right below them. Deriving them here makes disagreement impossible.
    const acc = {};
    for (const r of diario) {
      const a = (acc[r.agent] = acc[r.agent] || { agent: r.agent, costo: 0, tokens: 0, llamadas: 0, cacheRead: 0 });
      a.costo     += Number(r.cost_usd) || 0;
      a.tokens    += Number(r.input_tokens || 0) + Number(r.output_tokens || 0);
      a.llamadas  += Number(r.calls) || 0;
      a.cacheRead += Number(r.cache_read_input_tokens) || 0;
    }
    const totales = Object.values(acc).map(a => ({
      ...a,
      costoPorLlamada: a.llamadas > 0 ? a.costo / a.llamadas : 0,
    }));
    res.json({
      generado: new Date().toISOString(),
      dias: porMes ? null : days,
      mes: porMes ? mes : null,
      mesActual: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }).slice(0, 7),
      diario,
      mensual,
      totales,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Business metrics — same shared-Postgres, both-agents scope as /informe/tokens.
// costoPromedio is an average over the period (token_usage has no
// conversation_id to join per-lead), not a true per-conversation cost.
app.get('/informe/negocio', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const mes = String(req.query.month || '').trim();
    const porMes = /^\d{4}-\d{2}$/.test(mes);
    // Same window object every query understands, so picking a month on the
    // tokens dashboard moves these sections too instead of leaving them on a
    // rolling 30-day view next to month-scoped costs.
    const win = porMes ? { month: mes } : { days };
    const [funnel, eventos, volumenDiario, costoDiario] = await Promise.all([
      db.getConversationFunnel(win),
      db.getEventBreakdown(win),
      db.getConversationVolumeDaily(win),
      db.getTokenUsageDaily(win),
    ]);
    const porAgente = {};
    for (const row of volumenDiario) {
      porAgente[row.agent] = porAgente[row.agent] || { conversaciones: 0, costo: 0 };
      porAgente[row.agent].conversaciones += row.conversaciones;
    }
    for (const row of costoDiario) {
      porAgente[row.agent] = porAgente[row.agent] || { conversaciones: 0, costo: 0 };
      porAgente[row.agent].costo += row.cost_usd;
    }
    const costoPromedio = Object.entries(porAgente).map(([agent, v]) => ({
      agent,
      conversaciones: v.conversaciones,
      costoTotal: v.costo,
      costoPorConversacion: v.conversaciones > 0 ? v.costo / v.conversaciones : 0,
    }));
    res.json({ generado: new Date().toISOString(), dias: porMes ? null : days, mes: porMes ? mes : null, funnel, eventos, volumenDiario, costoPromedio });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Day-by-day view for the dashboard. Everything here is bucketed by Bogotá
// calendar day, not UTC, so an evening still inside business hours does not
// land in the next day's row.
//
// Caveat worth knowing before reading these numbers: `conversations` has no
// created_at column, only updated_at, which is overwritten on every touch.
// So `conversaciones` is "conversations ACTIVE that day", not "new that day" —
// a lead that keeps replying counts on each day it was touched. Events and
// insights do have their own created_at, so those are true per-day counts.
app.get('/informe/diario', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const [volumen, eventos, insights, tokens] = await Promise.all([
      db.getConversationVolumeDaily(days),
      db.getEventsDaily(days),
      db.getInsightsDaily(days),
      db.getTokenUsageDaily(days),
    ]);
    res.json({ generado: new Date().toISOString(), dias: days, volumen, eventos, insights, tokens });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ANAMNESIS CLÍNICA Y TRIAJE NHCK ─────────────────────────────────────────

// Zoho Creator rejects a record with the offending VALUE quoted but no column
// name (`Invalid column value "chicunguna" specified`), so a real submission
// that fails is untraceable to the question that caused it. Match the quoted
// value back to the payload keys that hold it and log those key names. Logs
// the KEYS only — the patient's answers stay out of the log, which is not a
// place for clinical data.
function logOffendingCreatorFields(tag, crData, payload) {
  if (crData?.code === 3000 || crData?.data?.ID) return;
  const errors = Array.isArray(crData?.error) ? crData.error : [crData?.error].filter(Boolean);
  for (const e of errors) {
    if (typeof e !== 'string') continue;
    const quoted = e.match(/"([^"]+)"/);
    if (!quoted) continue;
    const value = quoted[1];
    const keys = Object.keys(payload).filter(k => {
      const v = payload[k];
      // Compare trimmed: Zoho echoes the value normalized, so a name typed
      // with a stray space matched nothing and the log said "ningun campo
      // coincide" on the very failure it was built to explain (2026-07-30).
      const norm = s => String(s ?? '').trim();
      return Array.isArray(v) ? v.some(x => norm(x) === norm(value)) : norm(v) === norm(value);
    });
    console.warn(`${tag} Creator rechazó el valor de: ${keys.length ? keys.join(', ') : '(ningún campo coincide — revisar tipo de campo en Zoho)'}`);
  }
}

// Alias used by anamnesis-clinica-infantil.html
app.get('/zoho-creator-token', async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    res.json({ access_token: token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/anamnesis-clinica-infantil', async (req, res) => {
  const d = req.body;

  // ── 1. Validate required fields ──────────────────────────────────────────
  // movilConsultante is mandatory because Zoho's own schema forces it, not as
  // a preference: Contactos rejects a record without Movil ("Enter a value for
  // Movil"), and HISTORIAS_CLINICAS requires the Nombre_del_consultante lookup
  // that points at a Contactos record. No phone means no contact, and no
  // contact means the anamnesis cannot be saved at all. Confirmed live
  // 2026-07-30 by submitting without one.
  const REQUIRED = ['fechaElaboracion', 'nombreConsultante', 'movilConsultante', 'emailConsultante', 'edadConsultante', 'motivoConsulta', 'expectativasProceso', 'comoSupo'];
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
    contactoID = await buscarOCrearContactoAnamnesisClinica({
      nombre: d.nombreConsultante,
      movil:  d.movilConsultante  || '',
      email:  d.emailConsultante  || '',
      edad:   d.edadConsultante   || '',
    });
    if (contactoID) console.log('[/anamnesis-clinica-infantil] Contacto ID:', contactoID);
  } catch (err) {
    console.warn('[/anamnesis-clinica-infantil] Contacto lookup/create failed:', err.message);
  }

  // ── 4. Build Creator payload ──────────────────────────────────────────────
  const creatorPayload = {
    Fecha_elaboracion:             d.fechaElaboracion,
    // Lookup field — it takes a Contactos record ID, never free text. Sending
    // the patient's name here made Zoho reject the WHOLE record with
    // `Invalid column value "<nombre>" specified`, losing the anamnesis
    // entirely. Better to save the record unlinked than to lose it.
    Nombre_del_consultante:        contactoID || '',
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
    // tipoSustancias is a checkbox list now (see anamnesis-clinica-infantil.html).
    // HISTORIAS_CLINICAS takes it as plain text, same as Restricciones_tecnologia
    // above — Anamnesis_nna2 is the one that needs the raw array.
    creatorPayload.Tipo_sustancias      = Array.isArray(d.tipoSustancias)
                                            ? d.tipoSustancias.join(', ')
                                            : (d.tipoSustancias || '');
    creatorPayload.Periodicidad_consumo = d.periodicidadConsumo || '';
  }

  // ── 5. Submit to Creator ──────────────────────────────────────────────────
  try {
    const cr = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/v2/form/HISTORIAS_CLINICAS', {
      method: 'POST',
      headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: creatorPayload }),
    });
    const crData = await cr.json();
    console.log('[/anamnesis-clinica-infantil] Creator response:', JSON.stringify(crData));
    // Creator's rejection names the offending VALUE but not the column
    // (e.g. `Invalid column value "chicunguna" specified`), which makes a
    // real-world failure impossible to trace back to a question. Report
    // which payload keys carry that value — key names only, never the
    // clinical answers themselves, since these logs are not a PHI store.
    logOffendingCreatorFields('/anamnesis-clinica-infantil', crData, creatorPayload);

    if (crData.code === 3000 || crData.data?.ID) {
      // ── 6. Also create the record in the KIDS psychologist-review module ──
      // "Anamnesis_nna2" — NOT "Anamnesis" (that module is for adults, see
      // crearAnamnesisNinos in services/zoho.js for the full field map).
      // Historia Clínica alone never fed the psychologist's review module.
      // Reuses contactoID already resolved above. Passes `d` and contactoID
      // directly — almost every field has its own real Zoho key now, so the
      // old cherry-picked/combined subset used for crearAnamnesisPsicologo
      // (adults' Anamnesis) is not needed here.
      let anamnesisCreada = false;
      let anamnesisError = null;
      try {
        const anamnesisResult = await crearAnamnesisNinos(d, contactoID);
        anamnesisCreada = anamnesisResult?.code === 3000 || !!anamnesisResult?.data?.ID;
        if (!anamnesisCreada) anamnesisError = anamnesisResult;
      } catch (err) {
        anamnesisError = err.message;
      }
      if (!anamnesisCreada) console.warn('[/anamnesis-clinica-infantil] Registro Anamnesis_nna2 NO se creó:', JSON.stringify(anamnesisError));

      // Sent after anamnesisCreada is resolved, so the notice reports what
      // actually landed in Zoho rather than just that the request arrived — a
      // "se envió" that hides a rejected record is worse than no notice.
      // Fire-and-forget: a mail outage must never turn a saved anamnesis into
      // an error for the person who pressed Enviar.
      notify(
        `Anamnesis infantil enviada — ${d.nombreConsultante}\n` +
        `Móvil: ${d.movilConsultante}\n` +
        `Email: ${d.emailConsultante || '—'}\n` +
        `Edad: ${d.edadConsultante || '—'}\n` +
        `Registro en Zoho: ${anamnesisCreada ? 'creado correctamente' : 'NO se creó — revisar'}\n` +
        new Date().toLocaleString('es-CO'),
        env.anamnesisNotifyEmail
      ).catch(() => {});

      return res.json({ ok: true, id: crData.data?.ID, contactoID, anamnesisCreada, anamnesisError });
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

app.post('/triaje-infantil', async (req, res) => {
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
            tags: ['triaje-infantil'],
          }),
        });
        const ghlData = await ghlRes.json();
        contactIdGHL = ghlData?.contact?.id || '';
        console.log('[/triaje-infantil] GHL contact:', contactIdGHL || 'not created');
      } catch (ghlErr) {
        console.warn('[/triaje-infantil] GHL contact creation failed:', ghlErr.message);
      }
    }

    const result = await crearTriajeInfantil({
      nombreNino, email, movil, edad, sintoma, genero, estudia, contactIdGHL,
    });
    res.json({ ok: true, contactoID: result.contactoID, ghlId: contactIdGHL });
  } catch (err) {
    console.error('[/triaje-infantil]', err.message);
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

// ─── LEARNING ADMIN ───────────────────────────────────────────────────────────

app.get('/admin/updates', async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      `SELECT id, approval_key, root_cause, recommendation, reason, status, created_at
       FROM prompt_updates WHERE agent=$1 ORDER BY created_at DESC LIMIT 20`,
      [env.agentName]
    );
    const cards = rows.map(r => {
      const approveBtn = r.status === 'pending'
        ? `<a href="/admin/update/${r.id}?key=${r.approval_key}" style="background:#22c55e;color:#fff;padding:8px 20px;border-radius:6px;text-decoration:none;font-size:14px">✅ Aprobar</a>`
        : `<span style="color:#888;font-size:13px">${r.status === 'approved' ? '✅ Aprobada' : r.status}</span>`;
      return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px;margin-bottom:16px">
        <div style="font-size:12px;color:#6b7280;margin-bottom:6px">${new Date(r.created_at).toLocaleString('es-CO')} · Patrón: <strong>${r.root_cause}</strong></div>
        <p style="margin:0 0 8px;font-size:14px;color:#374151"><strong>Motivo:</strong> ${r.reason}</p>
        <p style="margin:0 0 14px;font-size:14px;background:#f9fafb;padding:12px;border-radius:6px;border-left:3px solid #6366f1">${r.recommendation}</p>
        ${approveBtn}
      </div>`;
    }).join('');
    const empty = rows.length === 0 ? '<p style="color:#6b7280">No hay recomendaciones todavía.</p>' : '';
    res.send(`<html><head><meta charset="utf-8"><title>Aprendizaje Carolina</title></head>
      <body style="font-family:system-ui;max-width:680px;margin:40px auto;padding:20px;background:#f9fafb">
        <h2 style="margin-bottom:4px">🧠 Aprendizaje de Carolina</h2>
        <p style="color:#6b7280;font-size:14px;margin-bottom:24px">Recomendaciones generadas a partir de conversaciones reales.</p>
        ${empty}${cards}
      </body></html>`);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ─── LEARNING TEST ────────────────────────────────────────────────────────────

app.get('/admin/test-learning', async (req, res) => {
  try {
    const crypto = require('crypto');
    const { notify } = require('./services/notifier');
    const id = crypto.randomUUID();
    const approvalKey = crypto.randomBytes(20).toString('hex');
    const recommendation = 'Cuando el cliente pregunte por el precio y no responda de inmediato, Carolina debería enviar un mensaje de seguimiento 24 horas después recordando los beneficios del neuromapeo y ofreciendo resolver dudas.';
    const reason = 'Se detectaron 5 conversaciones donde el cliente desapareció después de recibir el precio sin objeción explícita.';
    const rootCause = 'precio';
    await db.savePendingUpdate(id, approvalKey, rootCause, recommendation, reason);
    const approvalUrl = `https://miraculous-solace-production-47dd.up.railway.app/admin/update/${id}?key=${approvalKey}`;
    await notify(
      `🧠 *Sugerencia de aprendizaje para Carolina* _(PRUEBA)_\n\n` +
      `*Patrón detectado:* 5 conversaciones con causa raíz "precio"\n\n` +
      `*Motivo:* ${reason}\n\n` +
      `*Recomendación:*\n${recommendation}\n\n` +
      `✅ *Aprobar:* ${approvalUrl}\n\n` +
      `_Si no hacés nada, la sugerencia queda pendiente._`
    );
    res.send('✓ Prueba enviada a Cliq. Revisá el canal logcarolinanhck.');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ─── LEARNING APPROVAL ────────────────────────────────────────────────────────

app.get('/admin/update/:id', async (req, res) => {
  const { id } = req.params;
  const { key } = req.query;
  if (!key) return res.status(400).send('Clave de aprobación requerida.');
  try {
    const update = await db.approveUpdate(id, key);
    if (!update) return res.status(404).send('Sugerencia no encontrada o ya procesada.');
    res.send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
        <h2>✅ Aprobado</h2>
        <p><strong>Patrón:</strong> ${update.root_cause}</p>
        <p><strong>Regla aplicada a Carolina:</strong></p>
        <blockquote style="background:#f5f5f5;padding:16px;border-left:4px solid #4CAF50">${update.recommendation}</blockquote>
        <p style="color:#666">Carolina aplicará esta regla a partir del próximo mensaje.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('Error al aprobar: ' + err.message);
  }
});

// ─── ANALYTICS ────────────────────────────────────────────────────────────────

app.use('/dashboard', analyticsRouter);
app.use('/dashboard/tokens', tokenDashboardRouter);

// ─── WEBHOOK ROUTES ───────────────────────────────────────────────────────────

app.post('/webhook/ghl', ghlWebhookHandler);
app.post('/webhook/ghl-crear-contacto', ghlCrearEnCreatorHandler);
app.post('/webhook/ghl-crear-contacto-nhc', ghlCrearEnCreatorNHCHandler);
app.post('/webhook/wompi', wompiWebhookHandler);
app.post('/webhook/zoho-cita', zohoCitaWebhookHandler);
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
  startPendingWebhookJob();
  app.listen(env.port, () => console.log(`Servidor corriendo en puerto ${env.port}`));
}).catch(err => { console.error('Error DB:', err); process.exit(1); });
