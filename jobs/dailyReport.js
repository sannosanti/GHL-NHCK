'use strict';

const cron = require('node-cron');
const { pool } = require('../db');
const { env } = require('../config');
const { notify } = require('../services/notifier');

const STATE_LABELS = {
  nuevo: 'Nuevo 👋',
  triaje_p1: 'Triaje 1/3',
  triaje_p2: 'Triaje 2/3',
  triaje_p3: 'Triaje 3/3',
  triaje_completo: 'Triaje ✅',
  agendando: 'Agendando 📅',
  esperando_pago: 'Esperando pago 💳',
  escalado: 'Escalado 🆘',
  cerrado: 'Cerrado ❌',
  completado: 'Completado ✅',
};

const EVENT_LABELS = {
  cita_confirmada: '📅 Citas confirmadas',
  cierre_fuera_ciudad: '📍 Fuera de ciudad',
  cierre_sin_presupuesto: '💸 Sin presupuesto',
  cierre_fuera_segmento: '👶 Fuera de segmento',
  escalado: '🆘 Escalado manual',
  escalado_nhc_adultos: '🧑 NHC Adultos',
  comprobante_recibido: '🧾 Comprobante recibido',
};

async function runDailyReport() {
  console.log('[dailyReport] Generando reporte diario...');

  const { rows: convRows } = await pool.query(`
    SELECT
      c.conversation_id, c.contact_id, c.estado, c.updated_at,
      c.triaje, c.recovery_status,
      cc.contact_data
    FROM conversations c
    LEFT JOIN contact_cache cc ON cc.contact_id = c.contact_id
    WHERE c.updated_at > NOW() - INTERVAL '24 hours' AND c.agent = $1
    ORDER BY c.updated_at DESC
  `, [env.agentName]);

  const fecha = new Date().toLocaleDateString('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  if (convRows.length === 0) {
    await notify(`📋 *Reporte Diario Carolina — ${fecha}*\n_Sin actividad en las últimas 24 horas._`);
    return null;
  }

  const { rows: eventRows } = await pool.query(`
    SELECT event_type, COUNT(*) as count
    FROM transaction_logs
    WHERE created_at > NOW() - INTERVAL '24 hours' AND agent = $1
    GROUP BY event_type
    ORDER BY count DESC
  `, [env.agentName]).catch(() => ({ rows: [] }));

  const events = {};
  for (const r of eventRows) events[r.event_type] = parseInt(r.count);

  const completados = convRows.filter(r => r.estado === 'completado');
  const escalados   = convRows.filter(r => r.estado === 'escalado');
  const cerrados    = convRows.filter(r => r.estado === 'cerrado');
  const enProceso   = convRows.filter(r => !['completado', 'escalado', 'cerrado'].includes(r.estado));

  // Drop-off funnel (from events)
  const citasConfirmadas = events['cita_confirmada'] || 0;
  const cierresSinVenta  = (events['cierre_fuera_ciudad'] || 0) +
                           (events['cierre_sin_presupuesto'] || 0) +
                           (events['cierre_fuera_segmento'] || 0);

  let msg = `📋 *Reporte Diario Carolina — ${fecha}*\n`;
  msg += `_${convRows.length} conversación(es) con actividad hoy_\n\n`;

  msg += `✅ *Pagaron:* ${completados.length}\n`;
  msg += `🔴 *Escaladas:* ${escalados.length}\n`;
  msg += `❌ *Cerradas sin venta:* ${cerrados.length}\n`;
  msg += `🔄 *En proceso:* ${enProceso.length}\n\n`;

  // Funnel events
  const eventEntries = Object.entries(EVENT_LABELS)
    .filter(([k]) => events[k])
    .map(([k, label]) => `${label}: ${events[k]}`);

  if (eventEntries.length > 0) {
    msg += `*Eventos del día:*\n${eventEntries.join('\n')}\n\n`;
  }

  // Drop-off insight
  if (cierresSinVenta > 0 || citasConfirmadas > 0) {
    msg += `*¿Por qué no se cierran?*\n`;
    if (citasConfirmadas > 0 && completados.length < citasConfirmadas) {
      const perdidoEnPago = citasConfirmadas - completados.length;
      msg += `• ${perdidoEnPago} cita(s) confirmada(s) no pagaron aún\n`;
    }
    if (events['cierre_sin_presupuesto']) msg += `• ${events['cierre_sin_presupuesto']} descartado(s) por precio\n`;
    if (events['cierre_fuera_ciudad'])    msg += `• ${events['cierre_fuera_ciudad']} fuera de cobertura\n`;
    if (events['cierre_fuera_segmento'])  msg += `• ${events['cierre_fuera_segmento']} fuera de segmento\n`;
    if (escalados.length > 0)            msg += `• ${escalados.length} escalado(s) sin cierre automático\n`;
    msg += '\n';
  }

  // Per-conversation detail (up to 15)
  msg += `*Conversaciones:*\n`;
  for (const r of convRows.slice(0, 15)) {
    const cd = r.contact_data || {};
    const nombre = cd.firstName
      ? `${cd.firstName}${cd.lastName ? ' ' + cd.lastName : ''}`
      : `#${r.contact_id.substring(0, 6)}`;
    const estado = STATE_LABELS[r.estado] || r.estado;
    const hace   = Math.round((Date.now() - new Date(r.updated_at).getTime()) / 60000);
    const sintoma = r.triaje?.triaje1 ? ` — ${r.triaje.triaje1}` : '';
    const rec = r.recovery_status ? ` (${r.recovery_status})` : '';
    msg += `• ${nombre}${sintoma} → ${estado}${rec} (hace ${hace}min)\n`;
  }

  if (convRows.length > 15) msg += `_...y ${convRows.length - 15} más_\n`;

  await notify(msg);
  console.log('[dailyReport] Reporte enviado ✓');
  return { total: convRows.length, completados: completados.length, escalados: escalados.length };
}

function startDailyReport() {
  // Every day at 9pm Colombia time (UTC-5 → 02:00 UTC)
  cron.schedule('0 2 * * *', () => {
    runDailyReport().catch(async (err) => {
      console.error('[dailyReport] Error:', err.message);
      const { notify: n } = require('../services/notifier');
      n(`🚨 *Error reporte diario:* ${err.message}`).catch(() => {});
    });
  });
  console.log('Daily report job scheduled (9pm Colombia) ✓');
}

module.exports = { startDailyReport, runDailyReport };
