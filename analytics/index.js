'use strict';

const { Router } = require('express');
const router = Router();

router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Carolina · NHC Kids Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0F172A; --surface: #1E293B; --border: #334155;
      --text: #F1F5F9; --muted: #94A3B8;
      --green: #22C55E; --yellow: #EAB308; --red: #EF4444; --blue: #3B82F6;
      --carolina: #3987e5; --luisa: #d95926;
      --mono: 'Courier New', Courier, monospace;
    }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.4rem; }
    .agent-tag { font-size: 0.62rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.03em; }
    .agent-tag.carolina { background: rgba(57,135,229,.15); color: var(--carolina); }
    .agent-tag.luisa { background: rgba(217,89,38,.15); color: var(--luisa); }
    body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; padding: 1.5rem; min-height: 100vh; }

    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
    h1 { font-size: 1.2rem; font-weight: 700; }
    h1 small { color: var(--muted); font-weight: 400; font-size: 0.85rem; margin-left: 0.5rem; }
    #badge { font-size: 0.72rem; color: var(--muted); background: var(--surface); border: 1px solid var(--border); padding: 0.25rem 0.75rem; border-radius: 999px; }

    section { margin-bottom: 1.75rem; }
    h2 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 0.6rem; }

    /* KPIs */
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 0.65rem; }
    .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
    .kpi-label { font-size: 0.68rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.2rem; }
    .kpi-value { font-family: var(--mono); font-size: 2rem; font-weight: 700; line-height: 1; }
    .kpi-sub { font-size: 0.68rem; color: var(--muted); margin-top: 0.2rem; min-height: 1em; }
    .c-green { color: var(--green); } .c-red { color: var(--red); } .c-yellow { color: var(--yellow); } .c-blue { color: var(--blue); } .c-muted { color: var(--muted); }

    /* Funnel */
    .funnel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; }
    .f-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.55rem; }
    .f-row:last-child { margin-bottom: 0; }
    .f-label { width: 150px; font-size: 0.78rem; color: var(--muted); flex-shrink: 0; }
    .f-track { flex: 1; height: 26px; background: var(--bg); border-radius: 4px; overflow: hidden; }
    .f-bar { height: 100%; border-radius: 4px; display: flex; align-items: center; padding-left: 0.5rem; min-width: 2%; transition: width 0.7s ease; }
    .f-count { font-family: var(--mono); font-size: 0.78rem; font-weight: 700; color: #fff; }
    .f-pct { width: 52px; text-align: right; font-family: var(--mono); font-size: 0.72rem; color: var(--muted); flex-shrink: 0; }

    /* Two-col */
    .col2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.65rem; }
    @media (max-width: 600px) { .col2 { grid-template-columns: 1fr; } }

    /* Tables */
    .tcard { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    thead tr { background: var(--bg); }
    th { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); padding: 0.5rem 0.75rem; text-align: left; }
    td { font-size: 0.8rem; padding: 0.45rem 0.75rem; border-top: 1px solid var(--border); vertical-align: top; }
    td.mono { font-family: var(--mono); font-weight: 700; }
    td.muted { color: var(--muted); }
    tr:hover td { background: rgba(255,255,255,0.02); }

    /* Alerts */
    .alerts { display: flex; flex-direction: column; gap: 0.5rem; }
    .alert { display: flex; align-items: flex-start; gap: 0.75rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; font-size: 0.82rem; }
    .alert.r { border-left: 3px solid var(--red); }
    .alert.y { border-left: 3px solid var(--yellow); }
    .alert.g { border-left: 3px solid var(--green); }
    .a-msg { flex: 1; line-height: 1.4; }
    .a-tag { font-size: 0.65rem; padding: 0.15rem 0.45rem; border-radius: 3px; font-weight: 700; flex-shrink: 0; margin-top: 0.1rem; }
    .a-tag.r { background: rgba(239,68,68,.15); color: var(--red); }
    .a-tag.y { background: rgba(234,179,8,.15); color: var(--yellow); }
    .a-tag.g { background: rgba(34,197,94,.15); color: var(--green); }

    /* Recovery */
    .rec-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.65rem; }
    .rec-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; text-align: center; }
    .rec-val { font-family: var(--mono); font-size: 1.8rem; font-weight: 700; }
    .rec-lbl { font-size: 0.68rem; color: var(--muted); margin-top: 0.2rem; text-transform: uppercase; letter-spacing: 0.05em; }

    /* Leads toggle */
    .tbtn { font-size: 0.7rem; color: var(--blue); background: none; border: none; cursor: pointer; padding: 0; font-family: inherit; }
    .msgs { display: none; background: var(--bg); border-radius: 4px; padding: 0.4rem 0.5rem; margin-top: 0.3rem; }
    .msgs.open { display: block; }
    .mline { font-size: 0.72rem; padding: 0.1rem 0; line-height: 1.4; }
    .mline .rol { font-weight: 700; color: var(--muted); }
    .mline .rol.bot { color: var(--blue); }
    .rbadge { display: inline-block; font-size: 0.63rem; padding: 0.1rem 0.4rem; border-radius: 3px; font-weight: 700; }
    .rb-i2 { background: rgba(239,68,68,.15); color: var(--red); }
    .rb-i1 { background: rgba(234,179,8,.15); color: var(--yellow); }
    .rb-no { background: rgba(148,163,184,.15); color: var(--muted); }

    #err { display: none; background: rgba(239,68,68,.1); border: 1px solid var(--red); color: var(--red); padding: 0.6rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.82rem; }
    .spin { display: inline-block; width: 9px; height: 9px; border: 2px solid var(--border); border-top-color: var(--blue); border-radius: 50%; animation: s .8s linear infinite; margin-right: 4px; }
    @keyframes s { to { transform: rotate(360deg); } }
    .filters { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: flex-end; }
    .filters label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .filters select { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.35rem 0.6rem; font-family: inherit; font-size: 0.8rem; cursor: pointer; }
    h2 small { text-transform: none; letter-spacing: 0; color: var(--muted); font-weight: 400; margin-left: 0.5rem; }
  </style>
</head>
<body>

<header>
  <h1>Dashboard <small>Carolina (NHC Kids) + Luisa (NHC)</small></h1>
  <div style="display:flex;align-items:center;gap:0.5rem">
    <button id="refresh-btn" onclick="load()" style="font-size:0.75rem;padding:0.25rem 0.75rem;background:var(--blue);color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:inherit;">↻ Actualizar ahora</button>
    <div id="badge">—</div>
  </div>
</header>

<div id="err"></div>

<!-- Filters: apply to the day-by-day section and to every agent-scoped table -->
<section>
  <div class="filters">
    <label>Periodo
      <select id="f-dias" onchange="load()">
        <option value="7">Últimos 7 días</option>
        <option value="15">Últimos 15 días</option>
        <option value="30" selected>Últimos 30 días</option>
        <option value="90">Últimos 90 días</option>
      </select>
    </label>
    <label>Agente
      <select id="f-agente" onchange="render()">
        <option value="todos" selected>Ambos</option>
        <option value="carolina">Carolina (niños)</option>
        <option value="luisa">Luisa (adultos)</option>
      </select>
    </label>
    <label>Día
      <select id="f-dia" onchange="render()">
        <option value="todos" selected>Todos</option>
      </select>
    </label>
  </div>
</section>

<!-- Row 0: Day by day -->
<section>
  <h2>Por día <small id="dia-nota"></small></h2>
  <div class="tcard"><table>
    <thead><tr><th>Día</th><th>Agente</th><th>Conversaciones activas</th><th>Escalados</th><th>Cierres</th><th>Derivados</th><th>Llamadas IA</th><th>Costo</th></tr></thead>
    <tbody id="t-diario"></tbody>
  </table></div>
</section>

<!-- Row 1: KPIs -->
<section>
  <h2>KPIs</h2>
  <div class="kpi-grid" id="kpis"></div>
</section>

<!-- Row 2: Funnel -->
<section>
  <h2>Embudo de conversión</h2>
  <div class="col2" id="funnels"></div>
</section>

<!-- Row 3: Estados + Síntomas -->
<section>
  <div class="col2">
    <div>
      <h2>Estados actuales</h2>
      <div class="tcard"><table>
        <thead><tr><th>Agente</th><th>Estado</th><th>Cant.</th><th>%</th></tr></thead>
        <tbody id="t-estados"></tbody>
      </table></div>
    </div>
    <div>
      <h2>Síntomas más frecuentes</h2>
      <div class="tcard"><table>
        <thead><tr><th>Agente</th><th>Motivo de consulta</th><th>Cant.</th></tr></thead>
        <tbody id="t-sintomas"></tbody>
      </table></div>
    </div>
  </div>
</section>

<!-- Row 4: Alertas -->
<section>
  <h2>Alertas activas</h2>
  <div class="alerts" id="alerts"></div>
</section>

<!-- Row 5: Recovery -->
<section>
  <h2>Recovery — estado del job de reactivación</h2>
  <div class="col2" id="recovery"></div>
</section>

<!-- Row 6: Leads calificados -->
<section>
  <h2>Leads calificados sin convertir</h2>
  <div class="tcard"><table>
    <thead><tr><th>Agente</th><th>Contacto</th><th>Síntoma</th><th>Inactivo</th><th>Recovery</th><th>Mensajes</th></tr></thead>
    <tbody id="t-leads"></tbody>
  </table></div>
</section>

<script>
const LABELS = {
  nuevo:'Nuevo',triaje_p1:'Triaje 1/3',triaje_p2:'Triaje 2/3',triaje_p3:'Triaje 3/3',
  triaje_completo:'Triaje ✓',agendando:'Agendando',esperando_pago:'Esperando pago',
  escalado:'Escalado',cerrado:'Cerrado',completado:'Completado',activo:'Activo',
};
const AGENT_LABEL = { carolina: 'Carolina', luisa: 'Luisa' };
const AGENT_COLOR = { carolina: 'var(--carolina)', luisa: 'var(--luisa)' };
const AGENTS = ['carolina', 'luisa'];

let lastUpdate = 0;

function fmt(mins) {
  if (mins < 60) return mins + 'm';
  if (mins < 1440) return Math.round(mins / 60) + 'h';
  return Math.round(mins / 1440) + 'd';
}

function pct(n, total) {
  return total ? Math.round(n / total * 100) + '%' : '0%';
}

function agentDot(agent) {
  return \`<span class="dot" style="background:\${AGENT_COLOR[agent] || '#94A3B8'}"></span>\`;
}

// funnel/estados/sintomas/recovery/pagos_pendientes all arrive as one row
// per agent now (informe/*) instead of a single filtered object — this
// finds each agent's row, defaulting to zeros if that agent has no data yet.
function funnelFor(inf, agent) {
  return inf.funnel.find(f => f.agent === agent) || { total: 0, con_triaje: 0, esperando_pago: 0, completados: 0, cerrados: 0, escalados: 0 };
}

function renderKPIs(inf, leads) {
  const el = document.getElementById('kpis');
  const leadsPorAgente = {};
  (leads.conversaciones || []).forEach(l => { leadsPorAgente[l.agent] = (leadsPorAgente[l.agent] || 0) + 1; });

  el.innerHTML = agentesVisibles().map(agent => {
    const f = funnelFor(inf, agent);
    const total = +f.total || 0;
    const triaje = +f.con_triaje || 0;
    const ep = +f.esperando_pago || 0;
    const comp = +f.completados || 0;
    const esc = +f.escalados || 0;
    const citas = ep + comp;
    const tasa = total ? (comp / total * 100).toFixed(1) + '%' : '0%';
    const activos72h = (inf.recientes_72h || []).filter(r => r.agent === agent).reduce((s, r) => s + (+r.total || 0), 0);
    const ls = leadsPorAgente[agent] || 0;

    return \`
    <div class="kpi"><div class="kpi-label">\${agentDot(agent)}\${AGENT_LABEL[agent]} — Total</div><div class="kpi-value c-blue">\${total}</div><div class="kpi-sub">\${activos72h} activos últimas 72h</div></div>
    <div class="kpi"><div class="kpi-label">\${agentDot(agent)}\${AGENT_LABEL[agent]} — Triaje completado</div><div class="kpi-value \${triaje > 0 ? 'c-green' : 'c-muted'}">\${pct(triaje, total)}</div><div class="kpi-sub">\${triaje} conversaciones</div></div>
    <div class="kpi"><div class="kpi-label">\${agentDot(agent)}\${AGENT_LABEL[agent]} — Citas confirmadas</div><div class="kpi-value \${citas > 0 ? 'c-yellow' : 'c-muted'}">\${citas}</div><div class="kpi-sub">\${ep} pendientes de pago</div></div>
    <div class="kpi"><div class="kpi-label">\${agentDot(agent)}\${AGENT_LABEL[agent]} — Tasa de conversión</div><div class="kpi-value \${comp > 0 ? 'c-green' : 'c-red'}">\${tasa}</div><div class="kpi-sub">\${comp} completados</div></div>
    <div class="kpi"><div class="kpi-label">\${agentDot(agent)}\${AGENT_LABEL[agent]} — Leads sin convertir</div><div class="kpi-value \${ls > 0 ? 'c-yellow' : 'c-green'}">\${ls}</div><div class="kpi-sub">contacto manual recomendado</div></div>
    <div class="kpi"><div class="kpi-label">\${agentDot(agent)}\${AGENT_LABEL[agent]} — Escalados pendientes</div><div class="kpi-value \${esc > 0 ? 'c-red' : 'c-green'}">\${esc}</div><div class="kpi-sub">\${esc > 0 ? 'requieren atención del asesor' : 'sin escalados pendientes'}</div></div>
  \`;
  }).join('');
}

function renderFunnels(inf) {
  const el = document.getElementById('funnels');
  el.innerHTML = agentesVisibles().map(agent => {
    const f = funnelFor(inf, agent);
    const steps = [
      ['Total entrantes', +f.total || 0, '#3B82F6'],
      ['Triaje completo', +f.con_triaje || 0, '#8B5CF6'],
      ['Cita confirmada', (+f.esperando_pago || 0) + (+f.completados || 0), '#EAB308'],
      ['Pagaron', +f.completados || 0, '#22C55E'],
    ];
    const max = steps[0][1] || 1;
    const rows = steps.map(([label, v]) => {
      const w = Math.max(Math.round(v / max * 100), v > 0 ? 2 : 0);
      const p = v === steps[0][1] ? '100%' : pct(v, steps[0][1]);
      return \`<div class="f-row"><span class="f-label">\${label}</span><div class="f-track"><div class="f-bar" style="background:\${steps[steps.findIndex(s=>s[0]===label)][2]};width:\${w}%"><span class="f-count">\${v}</span></div></div><span class="f-pct">\${p}</span></div>\`;
    }).join('');
    return \`<div><h2>\${agentDot(agent)}\${AGENT_LABEL[agent]}</h2><div class="funnel">\${rows}</div></div>\`;
  }).join('');
}

function renderEstados(inf) {
  const totalPorAgente = {};
  inf.funnel.forEach(f => { totalPorAgente[f.agent] = +f.total || 1; });
  document.getElementById('t-estados').innerHTML = inf.estados.map(r =>
    \`<tr><td><span class="agent-tag \${r.agent}">\${AGENT_LABEL[r.agent] || r.agent}</span></td><td>\${LABELS[r.estado] || r.estado}</td><td class="mono">\${r.total}</td><td class="mono muted">\${pct(+r.total, totalPorAgente[r.agent] || 1)}</td></tr>\`
  ).join('');
}

function renderSintomas(inf) {
  const rows = inf.sintomas || [];
  document.getElementById('t-sintomas').innerHTML = rows.length
    ? rows.map(r => \`<tr><td><span class="agent-tag \${r.agent}">\${AGENT_LABEL[r.agent] || r.agent}</span></td><td>\${r.sintoma}</td><td class="mono">\${r.total}</td></tr>\`).join('')
    : '<tr><td colspan="3" class="muted">Sin datos</td></tr>';
}

function renderAlerts(inf, leads) {
  const alerts = [];

  agentesVisibles().forEach(agent => {
    const f = funnelFor(inf, agent);
    const ep = +f.esperando_pago || 0;
    const esc = +f.escalados || 0;
    const pagoPendiente = (inf.pagos_pendientes || []).find(p => p.agent === agent);

    if (ep > 0 && pagoPendiente?.mas_antigua) {
      const mins = Math.round((Date.now() - new Date(pagoPendiente.mas_antigua).getTime()) / 60000);
      if (mins > 120) {
        alerts.push({ t: 'r', icon: '🔴', tag: 'URGENTE', agent,
          msg: \`\${ep} lead(s) en <strong>esperando_pago</strong> — abono sin confirmar hace \${fmt(mins)}. Contactar manualmente.\` });
      }
    }

    const inact24 = (leads.conversaciones || []).filter(l => l.agent === agent && l.inactivo_minutos > 1440);
    if (inact24.length > 0) {
      alerts.push({ t: 'y', icon: '🟡', tag: 'ATENCIÓN', agent,
        msg: \`\${inact24.length} lead(s) calificado(s) con más de 24h de inactividad. Recovery agotado — requieren contacto del asesor.\` });
    }

    if (esc > 0) {
      alerts.push({ t: 'y', icon: '🟡', tag: 'ATENCIÓN', agent,
        msg: \`\${esc} conversación(es) escalada(s) esperando respuesta del asesor.\` });
    }
  });

  if (alerts.length === 0) {
    alerts.push({ t: 'g', icon: '🟢', tag: 'OK', agent: null, msg: 'Todo dentro de rangos normales — ambos agentes.' });
  }

  document.getElementById('alerts').innerHTML = alerts.map(a =>
    \`<div class="alert \${a.t}"><span>\${a.icon}</span>\${a.agent ? \`<span class="agent-tag \${a.agent}">\${AGENT_LABEL[a.agent]}</span>\` : ''}<span class="a-msg">\${a.msg}</span><span class="a-tag \${a.t}">\${a.tag}</span></div>\`
  ).join('');
}

function renderRecovery(inf) {
  const el = document.getElementById('recovery');
  el.innerHTML = agentesVisibles().map(agent => {
    const r = (inf.recovery || []).filter(x => x.agent === agent);
    const i1 = +((r.find(x => x.recovery_status === 'intento-1') || {}).total) || 0;
    const i2 = +((r.find(x => x.recovery_status === 'intento-2') || {}).total) || 0;
    const cerr = +((inf.estados.find(x => x.agent === agent && x.estado === 'cerrado') || {}).total) || 0;
    return \`<div>
      <h2>\${agentDot(agent)}\${AGENT_LABEL[agent]}</h2>
      <div class="rec-grid">
        <div class="rec-card"><div class="rec-val \${i1 > 0 ? 'c-yellow' : 'c-green'}">\${i1}</div><div class="rec-lbl">Intento 1 pendiente</div></div>
        <div class="rec-card"><div class="rec-val \${i2 > 0 ? 'c-red' : 'c-green'}">\${i2}</div><div class="rec-lbl">Intento 2 agotado</div></div>
        <div class="rec-card"><div class="rec-val c-muted">\${cerr}</div><div class="rec-lbl">Cerrados (excluidos)</div></div>
      </div>
    </div>\`;
  }).join('');
}

function renderLeads(leads) {
  const rows = leads.conversaciones || [];
  const tbody = document.getElementById('t-leads');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Sin leads en triaje_completo</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((l, i) => {
    const sintoma = l.triaje?.triaje1 || '—';
    const name = l.contacto.length > 16 ? l.contacto.slice(0, 12) + '…' : l.contacto;
    const rb = l.recovery === 'intento-2'
      ? '<span class="rbadge rb-i2">Agotado</span>'
      : l.recovery === 'intento-1'
      ? '<span class="rbadge rb-i1">Intento 1</span>'
      : '<span class="rbadge rb-no">Sin recovery</span>';
    const botLabel = l.agent === 'luisa' ? 'LUISA' : 'CAROLINA';
    const msgs = (l.ultimos_mensajes || []).slice(-4).map(m =>
      \`<div class="mline"><span class="rol \${m.rol === botLabel ? 'bot' : ''}">\${m.rol}:</span> \${m.texto.slice(0, 130)}\${m.texto.length > 130 ? '…' : ''}</div>\`
    ).join('');
    return \`<tr>
      <td><span class="agent-tag \${l.agent}">\${AGENT_LABEL[l.agent] || l.agent}</span></td>
      <td>\${name}</td>
      <td>\${sintoma}</td>
      <td class="mono">\${fmt(l.inactivo_minutos)}</td>
      <td>\${rb}</td>
      <td>
        <button class="tbtn" onclick="toggle(\${i})">ver (\${l.total_mensajes})</button>
        <div class="msgs" id="m\${i}">\${msgs}</div>
      </td>
    </tr>\`;
  }).join('');
}

window.toggle = function(i) {
  document.getElementById('m' + i).classList.toggle('open');
};

// Only the period filter needs the server; agent and day filters slice data
// already in memory, so switching them is instant and costs no query.
let DATA = { inf: null, leads: null, diario: null };

function agenteFiltro() { return document.getElementById('f-agente').value; }
function diaFiltro()    { return document.getElementById('f-dia').value; }
function agentesVisibles() {
  const a = agenteFiltro();
  return a === 'todos' ? AGENTS : [a];
}

// Rebuilds the day dropdown from whatever days the current period returned,
// keeping the selection if that day still exists.
function poblarDias(dias) {
  const sel = document.getElementById('f-dia');
  const previo = sel.value;
  sel.innerHTML = '<option value="todos">Todos</option>' +
    dias.map(d => '<option value="' + d + '">' + d + '</option>').join('');
  sel.value = dias.includes(previo) ? previo : 'todos';
}

function renderDiario() {
  const tbody = document.getElementById('t-diario');
  const nota  = document.getElementById('dia-nota');
  const d = DATA.diario;
  if (!d) { tbody.innerHTML = '<tr><td colspan="8" class="muted">Sin datos</td></tr>'; return; }

  nota.textContent = '(' + d.dias + ' días · "conversaciones activas" = tocadas ese día, no nuevas)';

  const visibles = agentesVisibles();
  const dia = diaFiltro();

  // One row per (day, agent): conversations touched, plus the events that
  // actually happened that day, plus AI calls and cost.
  const filas = {};
  const key = (day, agent) => day + '|' + agent;
  const fila = (day, agent) => (filas[key(day, agent)] = filas[key(day, agent)] ||
    { day, agent, conversaciones: 0, escalados: 0, cierres: 0, derivados: 0, calls: 0, costo: 0 });

  d.volumen.forEach(r => { fila(r.day, r.agent).conversaciones += r.conversaciones; });
  // Buckets chosen from the event types that actually occur: escalado,
  // escalado_nhc_adultos, cierre_fuera_ciudad, cierre_fuera_segmento,
  // cierre_sin_presupuesto, derivado_nhck_a_nhc, derivado_nhc_a_nhck.
  // "Derivados" replaced a "citas confirmadas" column: cita_confirmada has
  // never been logged (zero rows in 90 days), so that column was always empty
  // while 63 real cross-referrals between the two bots went uncounted.
  d.eventos.forEach(r => {
    const f = fila(r.day, r.agent);
    const t = r.event_type || '';
    if (t.startsWith('escalado'))      f.escalados += r.count;
    else if (t.startsWith('cierre_'))  f.cierres   += r.count;
    else if (t.startsWith('derivado_')) f.derivados += r.count;
  });
  d.tokens.forEach(r => { const f = fila(r.day, r.agent); f.calls += r.calls; f.costo += Number(r.cost_usd) || 0; });

  const rows = Object.values(filas)
    .filter(f => visibles.includes(f.agent))
    .filter(f => dia === 'todos' || f.day === dia)
    .sort((a, b) => b.day.localeCompare(a.day) || a.agent.localeCompare(b.agent));

  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="muted">Sin datos para este filtro</td></tr>'; return; }

  tbody.innerHTML = rows.map(f => '<tr>' +
    '<td class="mono">' + f.day + '</td>' +
    '<td>' + agentDot(f.agent) + (AGENT_LABEL[f.agent] || f.agent) + '</td>' +
    '<td class="mono">' + f.conversaciones + '</td>' +
    '<td class="mono">' + (f.escalados || '—') + '</td>' +
    '<td class="mono">' + (f.cierres || '—') + '</td>' +
    '<td class="mono">' + (f.derivados || '—') + '</td>' +
    '<td class="mono muted">' + (f.calls || '—') + '</td>' +
    '<td class="mono">$' + f.costo.toFixed(2) + '</td>' +
  '</tr>').join('');
}

// Re-renders from cached data. Called by the agent and day filters.
function render() {
  if (!DATA.inf) return;
  renderDiario();
  renderKPIs(DATA.inf, DATA.leads);
  renderFunnels(DATA.inf);
  renderEstados(DATA.inf);
  renderSintomas(DATA.inf);
  renderAlerts(DATA.inf, DATA.leads);
  renderRecovery(DATA.inf);
  renderLeads(DATA.leads);
}

async function load() {
  try {
    const days = document.getElementById('f-dias').value;
    const [r1, r2, r3] = await Promise.all([
      fetch('/informe'),
      fetch('/informe/triaje-completo'),
      fetch('/informe/diario?days=' + days),
    ]);
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('HTTP ' + r1.status + '/' + r2.status + '/' + r3.status);
    const [inf, leads, diario] = await Promise.all([r1.json(), r2.json(), r3.json()]);
    DATA = { inf, leads, diario };
    document.getElementById('err').style.display = 'none';

    const dias = [...new Set([
      ...diario.volumen.map(r => r.day),
      ...diario.eventos.map(r => r.day),
      ...diario.tokens.map(r => r.day),
    ])].sort((a, b) => b.localeCompare(a));
    poblarDias(dias);

    render();
    lastUpdate = Date.now();
  } catch (e) {
    const el = document.getElementById('err');
    el.style.display = 'block';
    el.textContent = 'Error cargando datos: ' + e.message;
  }
}

function tick() {
  const badge = document.getElementById('badge');
  if (!lastUpdate) return;
  const s = Math.round((Date.now() - lastUpdate) / 1000);
  badge.textContent = 'Actualizado hace ' + s + 's';
}

load();
setInterval(tick, 1000);
</script>
</body>
</html>`);
});

module.exports = router;
