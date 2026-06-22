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
      --mono: 'Courier New', Courier, monospace;
    }
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
  </style>
</head>
<body>

<header>
  <h1>Carolina Dashboard <small>NHC Kids</small></h1>
  <div id="badge"><span class="spin"></span>Cargando…</div>
</header>

<div id="err"></div>

<!-- Row 1: KPIs -->
<section>
  <h2>KPIs</h2>
  <div class="kpi-grid" id="kpis">
    <div class="kpi"><div class="kpi-label">Total conversaciones</div><div class="kpi-value c-blue" id="k-total">—</div><div class="kpi-sub" id="k-total-sub">&nbsp;</div></div>
    <div class="kpi"><div class="kpi-label">Triaje completado</div><div class="kpi-value" id="k-triaje">—</div><div class="kpi-sub" id="k-triaje-sub">&nbsp;</div></div>
    <div class="kpi"><div class="kpi-label">Citas confirmadas</div><div class="kpi-value" id="k-citas">—</div><div class="kpi-sub" id="k-citas-sub">&nbsp;</div></div>
    <div class="kpi"><div class="kpi-label">Tasa de conversión</div><div class="kpi-value" id="k-conv">—</div><div class="kpi-sub" id="k-conv-sub">&nbsp;</div></div>
    <div class="kpi"><div class="kpi-label">Leads sin convertir</div><div class="kpi-value" id="k-leads">—</div><div class="kpi-sub" id="k-leads-sub">&nbsp;</div></div>
    <div class="kpi"><div class="kpi-label">Escalados pendientes</div><div class="kpi-value" id="k-esc">—</div><div class="kpi-sub" id="k-esc-sub">&nbsp;</div></div>
  </div>
</section>

<!-- Row 2: Funnel -->
<section>
  <h2>Embudo de conversión</h2>
  <div class="funnel" id="funnel">
    <div class="f-row"><span class="f-label">Total entrantes</span><div class="f-track"><div class="f-bar" id="fb0" style="background:#3B82F6;width:0%"><span class="f-count" id="fc0">—</span></div></div><span class="f-pct" id="fp0">—</span></div>
    <div class="f-row"><span class="f-label">Triaje completo</span><div class="f-track"><div class="f-bar" id="fb1" style="background:#8B5CF6;width:0%"><span class="f-count" id="fc1">—</span></div></div><span class="f-pct" id="fp1">—</span></div>
    <div class="f-row"><span class="f-label">Cita confirmada</span><div class="f-track"><div class="f-bar" id="fb2" style="background:#EAB308;width:0%"><span class="f-count" id="fc2">—</span></div></div><span class="f-pct" id="fp2">—</span></div>
    <div class="f-row"><span class="f-label">Pagaron</span><div class="f-track"><div class="f-bar" id="fb3" style="background:#22C55E;width:0%"><span class="f-count" id="fc3">—</span></div></div><span class="f-pct" id="fp3">—</span></div>
  </div>
</section>

<!-- Row 3: Estados + Síntomas -->
<section>
  <div class="col2">
    <div>
      <h2>Estados actuales</h2>
      <div class="tcard"><table>
        <thead><tr><th>Estado</th><th>Cant.</th><th>%</th></tr></thead>
        <tbody id="t-estados"></tbody>
      </table></div>
    </div>
    <div>
      <h2>Síntomas más frecuentes</h2>
      <div class="tcard"><table>
        <thead><tr><th>Motivo de consulta</th><th>Cant.</th></tr></thead>
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
  <div class="rec-grid">
    <div class="rec-card"><div class="rec-val" id="r-i1">—</div><div class="rec-lbl">Intento 1 pendiente</div></div>
    <div class="rec-card"><div class="rec-val" id="r-i2">—</div><div class="rec-lbl">Intento 2 agotado</div></div>
    <div class="rec-card"><div class="rec-val c-muted" id="r-cerr">—</div><div class="rec-lbl">Cerrados (excluidos)</div></div>
  </div>
</section>

<!-- Row 6: Leads calificados -->
<section>
  <h2>Leads calificados sin convertir</h2>
  <div class="tcard"><table>
    <thead><tr><th>Contacto</th><th>Síntoma</th><th>Inactivo</th><th>Recovery</th><th>Mensajes</th></tr></thead>
    <tbody id="t-leads"></tbody>
  </table></div>
</section>

<script>
const LABELS = {
  nuevo:'Nuevo',triaje_p1:'Triaje 1/3',triaje_p2:'Triaje 2/3',triaje_p3:'Triaje 3/3',
  triaje_completo:'Triaje ✓',agendando:'Agendando',esperando_pago:'Esperando pago',
  escalado:'Escalado',cerrado:'Cerrado',completado:'Completado',activo:'Activo',
};

let lastUpdate = 0;

function fmt(mins) {
  if (mins < 60) return mins + 'm';
  if (mins < 1440) return Math.round(mins / 60) + 'h';
  return Math.round(mins / 1440) + 'd';
}

function pct(n, total) {
  return total ? Math.round(n / total * 100) + '%' : '0%';
}

function set(id, val) { document.getElementById(id).textContent = val; }
function setClass(id, cls) { document.getElementById(id).className = 'kpi-value ' + cls; }

function renderKPIs(inf, leads) {
  const f = inf.funnel;
  const total = +f.total || 0;
  const triaje = +f.con_triaje || 0;
  const ep = +f.esperando_pago || 0;
  const comp = +f.completados || 0;
  const esc = +f.escalados || 0;
  const citas = ep + comp;

  set('k-total', total); setClass('k-total', 'kpi-value c-blue');
  set('k-total-sub', inf.recientes_72h?.reduce((s,r)=>s+(+r.total||0),0) + ' activos últimas 72h');

  set('k-triaje', pct(triaje, total)); setClass('k-triaje', 'kpi-value ' + (triaje > 0 ? 'c-green' : 'c-muted'));
  set('k-triaje-sub', triaje + ' conversaciones');

  set('k-citas', citas); setClass('k-citas', 'kpi-value ' + (citas > 0 ? 'c-yellow' : 'c-muted'));
  set('k-citas-sub', ep + ' pendientes de pago');

  const tasa = total ? (comp / total * 100).toFixed(1) + '%' : '0%';
  set('k-conv', tasa); setClass('k-conv', 'kpi-value ' + (comp > 0 ? 'c-green' : 'c-red'));
  set('k-conv-sub', comp + ' completados');

  const ls = leads.total || 0;
  set('k-leads', ls); setClass('k-leads', 'kpi-value ' + (ls > 0 ? 'c-yellow' : 'c-green'));
  set('k-leads-sub', 'contacto manual recomendado');

  set('k-esc', esc); setClass('k-esc', 'kpi-value ' + (esc > 0 ? 'c-red' : 'c-green'));
  set('k-esc-sub', esc > 0 ? 'requieren atención del asesor' : 'sin escalados pendientes');
}

function renderFunnel(inf) {
  const f = inf.funnel;
  const steps = [
    +f.total || 0,
    +f.con_triaje || 0,
    (+f.esperando_pago || 0) + (+f.completados || 0),
    +f.completados || 0,
  ];
  const max = steps[0] || 1;
  steps.forEach((v, i) => {
    const w = Math.max(Math.round(v / max * 100), v > 0 ? 2 : 0);
    document.getElementById('fb' + i).style.width = w + '%';
    set('fc' + i, v);
    set('fp' + i, i === 0 ? '100%' : pct(v, steps[0]));
  });
}

function renderEstados(inf) {
  const total = +inf.funnel.total || 1;
  document.getElementById('t-estados').innerHTML = inf.estados.map(r =>
    \`<tr><td>\${LABELS[r.estado] || r.estado}</td><td class="mono">\${r.total}</td><td class="mono muted">\${pct(+r.total, total)}</td></tr>\`
  ).join('');
}

function renderSintomas(inf) {
  const rows = inf.sintomas || [];
  document.getElementById('t-sintomas').innerHTML = rows.length
    ? rows.map(r => \`<tr><td>\${r.sintoma}</td><td class="mono">\${r.total}</td></tr>\`).join('')
    : '<tr><td colspan="2" class="muted">Sin datos</td></tr>';
}

function renderAlerts(inf, leads) {
  const alerts = [];
  const ep = +inf.funnel.esperando_pago || 0;
  const esc = +inf.funnel.escalados || 0;

  if (ep > 0 && inf.pagos_pendientes?.mas_antigua) {
    const mins = Math.round((Date.now() - new Date(inf.pagos_pendientes.mas_antigua).getTime()) / 60000);
    if (mins > 120) {
      alerts.push({ t: 'r', icon: '🔴', tag: 'URGENTE',
        msg: \`\${ep} lead(s) en <strong>esperando_pago</strong> — abono sin confirmar hace \${fmt(mins)}. Contactar manualmente.\` });
    }
  }

  const inact24 = (leads.conversaciones || []).filter(l => l.inactivo_minutos > 1440);
  if (inact24.length > 0) {
    alerts.push({ t: 'y', icon: '🟡', tag: 'ATENCIÓN',
      msg: \`\${inact24.length} lead(s) calificado(s) con más de 24h de inactividad. Recovery agotado — requieren contacto del asesor.\` });
  }

  if (esc > 0) {
    alerts.push({ t: 'y', icon: '🟡', tag: 'ATENCIÓN',
      msg: \`\${esc} conversación(es) escalada(s) esperando respuesta del asesor.\` });
  }

  if (alerts.length === 0) {
    alerts.push({ t: 'g', icon: '🟢', tag: 'OK', msg: 'Todo dentro de rangos normales.' });
  }

  document.getElementById('alerts').innerHTML = alerts.map(a =>
    \`<div class="alert \${a.t}"><span>\${a.icon}</span><span class="a-msg">\${a.msg}</span><span class="a-tag \${a.t}">\${a.tag}</span></div>\`
  ).join('');
}

function renderRecovery(inf) {
  const r = inf.recovery || [];
  const i1 = +((r.find(x => x.recovery_status === 'intento-1') || {}).total) || 0;
  const i2 = +((r.find(x => x.recovery_status === 'intento-2') || {}).total) || 0;
  const cerr = +((inf.estados.find(x => x.estado === 'cerrado') || {}).total) || 0;
  const ri1 = document.getElementById('r-i1');
  const ri2 = document.getElementById('r-i2');
  ri1.textContent = i1; ri1.className = 'rec-val ' + (i1 > 0 ? 'c-yellow' : 'c-green');
  ri2.textContent = i2; ri2.className = 'rec-val ' + (i2 > 0 ? 'c-red' : 'c-green');
  set('r-cerr', cerr);
}

function renderLeads(leads) {
  const rows = leads.conversaciones || [];
  const tbody = document.getElementById('t-leads');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Sin leads en triaje_completo</td></tr>';
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
    const msgs = (l.ultimos_mensajes || []).slice(-4).map(m =>
      \`<div class="mline"><span class="rol \${m.rol === 'CAROLINA' ? 'bot' : ''}">\${m.rol}:</span> \${m.texto.slice(0, 130)}\${m.texto.length > 130 ? '…' : ''}</div>\`
    ).join('');
    return \`<tr>
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

async function load() {
  try {
    const [r1, r2] = await Promise.all([fetch('/informe'), fetch('/informe/triaje-completo')]);
    if (!r1.ok || !r2.ok) throw new Error('HTTP ' + r1.status);
    const [inf, leads] = await Promise.all([r1.json(), r2.json()]);
    document.getElementById('err').style.display = 'none';
    renderKPIs(inf, leads);
    renderFunnel(inf);
    renderEstados(inf);
    renderSintomas(inf);
    renderAlerts(inf, leads);
    renderRecovery(inf);
    renderLeads(leads);
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
setInterval(load, 60000);
setInterval(tick, 1000);
</script>
</body>
</html>`);
});

module.exports = router;
