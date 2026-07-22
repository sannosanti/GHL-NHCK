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
  <title>Tokens &amp; Costo · Carolina + Luisa</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0F172A; --surface: #1E293B; --border: #334155;
      --text: #F1F5F9; --muted: #94A3B8;
      --carolina: #3987e5; --luisa: #d95926;
      --mono: 'Courier New', Courier, monospace;
    }
    body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; padding: 1.5rem; min-height: 100vh; }

    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 0.75rem; }
    h1 { font-size: 1.2rem; font-weight: 700; }
    h1 small { color: var(--muted); font-weight: 400; font-size: 0.85rem; margin-left: 0.5rem; }
    #badge { font-size: 0.72rem; color: var(--muted); background: var(--surface); border: 1px solid var(--border); padding: 0.25rem 0.75rem; border-radius: 999px; }

    section { margin-bottom: 1.75rem; }
    h2 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 0.6rem; }

    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0.65rem; }
    .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
    .kpi-label { font-size: 0.68rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.2rem; }
    .kpi-value { font-family: var(--mono); font-size: 1.7rem; font-weight: 700; line-height: 1; }
    .kpi-sub { font-size: 0.68rem; color: var(--muted); margin-top: 0.3rem; min-height: 1em; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.4rem; }

    .legend { display: flex; gap: 1.25rem; margin-bottom: 0.75rem; font-size: 0.78rem; color: var(--muted); }
    .legend span.dot { width: 10px; height: 10px; }

    .chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; position: relative; }
    #chart, #chart-funnel, #chart-eventos { width: 100%; height: 260px; display: block; overflow: visible; }
    .bar { cursor: pointer; }
    .bar:hover { opacity: 0.8; }
    .axis-label { fill: var(--muted); font-size: 9px; font-family: var(--mono); }
    #tooltip, .cat-tooltip {
      position: absolute; display: none; pointer-events: none;
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 0.5rem 0.65rem; font-size: 0.72rem; line-height: 1.5; white-space: nowrap;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4); z-index: 10;
    }

    .tcard { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    thead tr { background: var(--bg); }
    th { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); padding: 0.5rem 0.75rem; text-align: left; white-space: nowrap; }
    td { font-size: 0.8rem; padding: 0.45rem 0.75rem; border-top: 1px solid var(--border); vertical-align: top; white-space: nowrap; }
    td.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
    td.muted { color: var(--muted); }
    tr:hover td { background: rgba(255,255,255,0.02); }

    #err { display: none; background: rgba(239,68,68,.1); border: 1px solid #EF4444; color: #EF4444; padding: 0.6rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.82rem; }
  </style>
</head>
<body>

<header>
  <h1>Tokens &amp; Costo <small>Carolina (NHC Kids) + Luisa (NHC)</small></h1>
  <div style="display:flex;align-items:center;gap:0.5rem">
    <button onclick="load()" style="font-size:0.75rem;padding:0.25rem 0.75rem;background:var(--carolina);color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:inherit;">↻ Actualizar</button>
    <div id="badge">—</div>
  </div>
</header>

<div id="err"></div>

<section>
  <h2>Hoy / Este mes</h2>
  <div class="kpi-grid" id="kpis"></div>
</section>

<section>
  <h2>Costo diario (últimos <span id="dias-label">30</span> días)</h2>
  <div class="legend">
    <span><span class="dot" style="background:var(--carolina)"></span>Carolina</span>
    <span><span class="dot" style="background:var(--luisa)"></span>Luisa</span>
  </div>
  <div class="chart-card">
    <svg id="chart"></svg>
    <div id="tooltip"></div>
  </div>
</section>

<section>
  <h2>Detalle diario</h2>
  <div class="tcard"><table>
    <thead><tr><th>Día</th><th>Agente</th><th>Llamadas</th><th>Tokens entrada</th><th>Tokens salida</th><th>Cache write</th><th>Cache read</th><th>Costo (USD)</th></tr></thead>
    <tbody id="t-diario"></tbody>
  </table></div>
</section>

<section>
  <h2>Conversaciones (últimos <span id="dias-label-neg">30</span> días)</h2>
  <div class="kpi-grid" id="kpis-negocio"></div>
</section>

<section>
  <h2>Estado de conversaciones</h2>
  <div class="legend">
    <span><span class="dot" style="background:var(--carolina)"></span>Carolina</span>
    <span><span class="dot" style="background:var(--luisa)"></span>Luisa</span>
  </div>
  <div class="chart-card">
    <svg id="chart-funnel"></svg>
    <div id="tooltip-funnel" class="cat-tooltip"></div>
  </div>
</section>

<section>
  <h2>Motivos de cierre y escalado</h2>
  <div class="legend">
    <span><span class="dot" style="background:var(--carolina)"></span>Carolina</span>
    <span><span class="dot" style="background:var(--luisa)"></span>Luisa</span>
  </div>
  <div class="chart-card">
    <svg id="chart-eventos"></svg>
    <div id="tooltip-eventos" class="cat-tooltip"></div>
  </div>
</section>

<script>
const AGENT_LABEL = { carolina: 'Carolina', luisa: 'Luisa' };
const AGENT_COLOR = { carolina: 'var(--carolina)', luisa: 'var(--luisa)' };
let lastUpdate = 0;

function usd(n) { return '$' + (Number(n) || 0).toFixed(2); }
function num(n) { return new Intl.NumberFormat('es-CO').format(Number(n) || 0); }

function renderKpis(totales) {
  const el = document.getElementById('kpis');
  if (!totales.length) { el.innerHTML = '<div class="kpi"><div class="kpi-sub">Sin datos todavía — se registran a partir del primer llamado a Claude tras este deploy.</div></div>'; return; }
  el.innerHTML = totales.map(t => \`
    <div class="kpi">
      <div class="kpi-label"><span class="dot" style="background:\${AGENT_COLOR[t.agent] || '#94A3B8'}"></span>\${AGENT_LABEL[t.agent] || t.agent} — hoy</div>
      <div class="kpi-value">\${usd(t.costo_hoy)}</div>
      <div class="kpi-sub">\${num(t.tokens_hoy)} tokens · \${num(t.llamadas_hoy)} llamadas</div>
    </div>
    <div class="kpi">
      <div class="kpi-label"><span class="dot" style="background:\${AGENT_COLOR[t.agent] || '#94A3B8'}"></span>\${AGENT_LABEL[t.agent] || t.agent} — este mes</div>
      <div class="kpi-value">\${usd(t.costo_mes)}</div>
      <div class="kpi-sub">\${num(t.tokens_mes)} tokens</div>
    </div>
  \`).join('');
}

function renderChart(diario) {
  const svg = document.getElementById('chart');
  const tooltip = document.getElementById('tooltip');
  const W = svg.clientWidth || 800, H = 260;
  const padL = 40, padB = 20, padT = 10;

  const days = [...new Set(diario.map(d => d.day))].sort();
  const byDay = {};
  days.forEach(d => { byDay[d] = { carolina: 0, luisa: 0 }; });
  diario.forEach(r => { if (byDay[r.day]) byDay[r.day][r.agent] = Number(r.cost_usd) || 0; });

  const maxVal = Math.max(0.0001, ...days.map(d => Math.max(byDay[d].carolina, byDay[d].luisa)));
  const groupW = (W - padL) / Math.max(days.length, 1);
  const barW = Math.max(2, groupW / 2.6);

  svg.setAttribute('viewBox', \`0 0 \${W} \${H}\`);
  const bars = [];
  days.forEach((day, i) => {
    const gx = padL + i * groupW;
    ['carolina', 'luisa'].forEach((agent, j) => {
      const val = byDay[day][agent];
      const h = (val / maxVal) * (H - padT - padB);
      const x = gx + j * barW;
      const y = H - padB - h;
      bars.push(\`<rect class="bar" x="\${x}" y="\${y}" width="\${barW - 2}" height="\${Math.max(h, val > 0 ? 1 : 0)}" rx="2" fill="\${agent === 'carolina' ? '#3987e5' : '#d95926'}" data-day="\${day}" data-agent="\${agent}" data-val="\${val}"></rect>\`);
    });
  });

  const nTicks = 4;
  const ticks = [];
  for (let t = 0; t <= nTicks; t++) {
    const v = (maxVal / nTicks) * t;
    const y = H - padB - (v / maxVal) * (H - padT - padB);
    ticks.push(\`<line x1="\${padL}" y1="\${y}" x2="\${W}" y2="\${y}" stroke="#334155" stroke-width="1"></line>\`);
    ticks.push(\`<text class="axis-label" x="0" y="\${y + 3}">\${usd(v)}</text>\`);
  }

  const labelEvery = Math.ceil(days.length / 8) || 1;
  const dayLabels = days.map((d, i) => i % labelEvery === 0
    ? \`<text class="axis-label" x="\${padL + i * groupW}" y="\${H - 4}">\${d.slice(5)}</text>\`
    : '').join('');

  svg.innerHTML = ticks.join('') + bars.join('') + dayLabels;

  svg.querySelectorAll('.bar').forEach(bar => {
    bar.addEventListener('mousemove', (e) => {
      const agent = bar.getAttribute('data-agent');
      const day = bar.getAttribute('data-day');
      const val = bar.getAttribute('data-val');
      tooltip.style.display = 'block';
      tooltip.style.left = (e.offsetX + 12) + 'px';
      tooltip.style.top = (e.offsetY - 10) + 'px';
      tooltip.innerHTML = \`<strong>\${AGENT_LABEL[agent]}</strong> — \${day}<br>\${usd(val)}\`;
    });
    bar.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  });
}

const ESTADO_LABEL = {
  nuevo: 'Nuevo', triaje_p1: 'Triaje 1', triaje_p2: 'Triaje 2', triaje_p3: 'Triaje 3',
  triaje_completo: 'Triaje completo', activo: 'Activo', agendando: 'Agendando',
  esperando_pago: 'Esperando pago', escalado: 'Escalado', completado: 'Completado', cerrado: 'Cerrado',
};
const ESTADO_ORDER = ['nuevo', 'triaje_p1', 'triaje_p2', 'triaje_p3', 'triaje_completo', 'activo', 'agendando', 'esperando_pago', 'escalado', 'completado', 'cerrado'];

const EVENT_LABEL = {
  escalado: 'Escalado', escalado_nhc_adultos: 'Escalado a NHC adultos',
  cierre_fuera_ciudad: 'Fuera de ciudad', cierre_sin_presupuesto: 'Sin presupuesto',
  cierre_fuera_segmento: 'Fuera de segmento', derivado_nhck_a_nhc: 'Derivado a NHC',
  derivado_nhc_a_nhck: 'Derivado a NHCK', comprobante_recibido: 'Comprobante recibido',
  cita_confirmada: 'Cita confirmada',
};
const EVENT_ORDER = ['escalado', 'escalado_nhc_adultos', 'cierre_fuera_ciudad', 'cierre_sin_presupuesto', 'cierre_fuera_segmento', 'derivado_nhck_a_nhc', 'derivado_nhc_a_nhck', 'cita_confirmada', 'comprobante_recibido'];

function renderKpisNegocio(costoPromedio, funnel) {
  const el = document.getElementById('kpis-negocio');
  if (!costoPromedio.length) { el.innerHTML = '<div class="kpi"><div class="kpi-sub">Sin datos todavía</div></div>'; return; }
  const escaladosPorAgente = {};
  const totalPorAgente = {};
  funnel.forEach(f => {
    totalPorAgente[f.agent] = (totalPorAgente[f.agent] || 0) + f.count;
    if (f.estado === 'escalado') escaladosPorAgente[f.agent] = (escaladosPorAgente[f.agent] || 0) + f.count;
  });
  el.innerHTML = costoPromedio.map(c => {
    const total = totalPorAgente[c.agent] || 0;
    const escalados = escaladosPorAgente[c.agent] || 0;
    const tasaEscalado = total > 0 ? (escalados / total * 100).toFixed(1) : '0.0';
    return \`
    <div class="kpi">
      <div class="kpi-label"><span class="dot" style="background:\${AGENT_COLOR[c.agent] || '#94A3B8'}"></span>\${AGENT_LABEL[c.agent] || c.agent} — conversaciones</div>
      <div class="kpi-value">\${num(c.conversaciones)}</div>
      <div class="kpi-sub">tocadas en el período</div>
    </div>
    <div class="kpi">
      <div class="kpi-label"><span class="dot" style="background:\${AGENT_COLOR[c.agent] || '#94A3B8'}"></span>\${AGENT_LABEL[c.agent] || c.agent} — tasa de escalado</div>
      <div class="kpi-value">\${tasaEscalado}%</div>
      <div class="kpi-sub">\${num(escalados)} de \${num(total)} conversaciones</div>
    </div>
    <div class="kpi">
      <div class="kpi-label"><span class="dot" style="background:\${AGENT_COLOR[c.agent] || '#94A3B8'}"></span>\${AGENT_LABEL[c.agent] || c.agent} — costo promedio</div>
      <div class="kpi-value">\${usd(c.costoPorConversacion)}</div>
      <div class="kpi-sub">por conversación · \${usd(c.costoTotal)} total</div>
    </div>
  \`;
  }).join('');
}

// Generic grouped-bar-by-category chart (estado or event_type on the x-axis,
// agent as the grouped color) — same mark/axis/tooltip approach as
// renderChart above, parameterized so it isn't duplicated per section.
function renderCategoryChart(svgId, tooltipId, rows, order, labelMap) {
  const svg = document.getElementById(svgId);
  const tooltip = document.getElementById(tooltipId);
  const W = svg.clientWidth || 800, H = 260;
  const padL = 34, padB = 56, padT = 10;

  const present = order.filter(cat => rows.some(r => r.estado === cat || r.event_type === cat));
  const byCat = {};
  present.forEach(c => { byCat[c] = { carolina: 0, luisa: 0 }; });
  rows.forEach(r => {
    const cat = r.estado || r.event_type;
    if (byCat[cat]) byCat[cat][r.agent] = (byCat[cat][r.agent] || 0) + Number(r.count || 0);
  });

  if (!present.length) { svg.innerHTML = ''; return; }

  const maxVal = Math.max(1, ...present.map(c => Math.max(byCat[c].carolina, byCat[c].luisa)));
  const groupW = (W - padL) / present.length;
  const barW = Math.max(2, groupW / 2.6);

  svg.setAttribute('viewBox', \`0 0 \${W} \${H}\`);
  const bars = [];
  present.forEach((cat, i) => {
    const gx = padL + i * groupW;
    ['carolina', 'luisa'].forEach((agent, j) => {
      const val = byCat[cat][agent];
      const h = (val / maxVal) * (H - padT - padB);
      const x = gx + j * barW;
      const y = H - padB - h;
      bars.push(\`<rect class="bar" x="\${x}" y="\${y}" width="\${barW - 2}" height="\${Math.max(h, val > 0 ? 1 : 0)}" rx="2" fill="\${agent === 'carolina' ? '#3987e5' : '#d95926'}" data-cat="\${cat}" data-agent="\${agent}" data-val="\${val}"></rect>\`);
    });
  });

  const nTicks = 4;
  const ticks = [];
  for (let t = 0; t <= nTicks; t++) {
    const v = Math.round((maxVal / nTicks) * t);
    const y = H - padB - (v / maxVal) * (H - padT - padB);
    ticks.push(\`<line x1="\${padL}" y1="\${y}" x2="\${W}" y2="\${y}" stroke="#334155" stroke-width="1"></line>\`);
    ticks.push(\`<text class="axis-label" x="0" y="\${y + 3}">\${num(v)}</text>\`);
  }

  const catLabels = present.map((c, i) => {
    const label = (labelMap[c] || c).slice(0, 14);
    const x = padL + i * groupW + groupW / 2;
    return \`<text class="axis-label" x="\${x}" y="\${H - padB + 14}" text-anchor="middle" transform="rotate(20 \${x} \${H - padB + 14})">\${label}</text>\`;
  }).join('');

  svg.innerHTML = ticks.join('') + bars.join('') + catLabels;

  svg.querySelectorAll('.bar').forEach(bar => {
    bar.addEventListener('mousemove', (e) => {
      const agent = bar.getAttribute('data-agent');
      const cat = bar.getAttribute('data-cat');
      const val = bar.getAttribute('data-val');
      tooltip.style.display = 'block';
      tooltip.style.left = (e.offsetX + 12) + 'px';
      tooltip.style.top = (e.offsetY - 10) + 'px';
      tooltip.innerHTML = \`<strong>\${AGENT_LABEL[agent]}</strong> — \${labelMap[cat] || cat}<br>\${num(val)}\`;
    });
    bar.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  });
}

function renderTable(diario) {
  const tbody = document.getElementById('t-diario');
  if (!diario.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Sin datos todavía</td></tr>';
    return;
  }
  const rows = [...diario].sort((a, b) => b.day.localeCompare(a.day));
  tbody.innerHTML = rows.map(r => \`<tr>
    <td class="mono">\${r.day}</td>
    <td><span class="dot" style="background:\${AGENT_COLOR[r.agent] || '#94A3B8'}"></span>\${AGENT_LABEL[r.agent] || r.agent}</td>
    <td class="mono">\${num(r.calls)}</td>
    <td class="mono">\${num(r.input_tokens)}</td>
    <td class="mono">\${num(r.output_tokens)}</td>
    <td class="mono muted">\${num(r.cache_creation_input_tokens)}</td>
    <td class="mono muted">\${num(r.cache_read_input_tokens)}</td>
    <td class="mono">\${usd(r.cost_usd)}</td>
  </tr>\`).join('');
}

async function load() {
  try {
    const [rTokens, rNegocio] = await Promise.all([
      fetch('/informe/tokens?days=30'),
      fetch('/informe/negocio?days=30'),
    ]);
    if (!rTokens.ok) throw new Error('HTTP ' + rTokens.status);
    if (!rNegocio.ok) throw new Error('HTTP ' + rNegocio.status);
    const data = await rTokens.json();
    const negocio = await rNegocio.json();

    document.getElementById('err').style.display = 'none';
    document.getElementById('dias-label').textContent = data.dias;
    renderKpis(data.totales);
    renderChart(data.diario);
    renderTable(data.diario);

    document.getElementById('dias-label-neg').textContent = negocio.dias;
    renderKpisNegocio(negocio.costoPromedio, negocio.funnel);
    renderCategoryChart('chart-funnel', 'tooltip-funnel', negocio.funnel, ESTADO_ORDER, ESTADO_LABEL);
    renderCategoryChart('chart-eventos', 'tooltip-eventos', negocio.eventos, EVENT_ORDER, EVENT_LABEL);

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
