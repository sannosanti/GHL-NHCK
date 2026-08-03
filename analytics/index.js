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

    .periodo-nota { margin-top: 0.6rem; font-size: 0.72rem; color: var(--muted); }

    /* Glossary */
    .glos { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; }
    .glos summary { cursor: pointer; font-size: 0.8rem; font-weight: 700; color: var(--text); list-style: none; }
    .glos summary::-webkit-details-marker { display: none; }
    .glos summary::before { content: '▸ '; color: var(--blue); }
    .glos[open] summary::before { content: '▾ '; }
    .glos-hint { font-weight: 400; color: var(--muted); font-size: 0.72rem; }
    .glos-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.75rem; margin-top: 0.9rem; }
    .glos-grid div { border-left: 2px solid var(--border); padding-left: 0.6rem; }
    .glos-grid b { display: block; font-size: 0.78rem; color: var(--blue); margin-bottom: 0.15rem; }
    .glos-grid span { font-size: 0.75rem; color: var(--muted); line-height: 1.45; }

    /* Agent panels: identical structure on both sides so they read as a pair */
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.1rem; }
    .panel-head { display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; font-weight: 700; padding-bottom: 0.7rem; margin-bottom: 0.9rem; border-bottom: 1px solid var(--border); }
    .panel-head .sub { font-size: 0.7rem; font-weight: 400; color: var(--muted); margin-left: auto; }
    .panel h3 { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin: 1.1rem 0 0.5rem; }
    .panel h3:first-of-type { margin-top: 0; }
    .pk-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; }
    .pk { background: var(--bg); border: 1px solid var(--border); border-radius: 7px; padding: 0.6rem 0.7rem; }
    .pk-l { font-size: 0.63rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .pk-v { font-family: var(--mono); font-size: 1.45rem; font-weight: 700; line-height: 1.15; }
    .pk-s { font-size: 0.63rem; color: var(--muted); }
    .panel table { width: 100%; }
    .panel .tcard { background: var(--bg); }
    .ayuda { cursor: help; border-bottom: 1px dotted var(--muted); }
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
      <select id="f-dia" onchange="load()">
        <option value="todos" selected>Todos</option>
      </select>
    </label>
  </div>
  <div id="periodo-nota" class="periodo-nota"></div>
</section>

<!-- Glossary: every term on this page in plain language, so the numbers can be
     read without knowing the state machine behind them. -->
<section>
  <details class="glos">
    <summary>¿Qué significa cada término? <span class="glos-hint">(clic para abrir)</span></summary>
    <div class="glos-grid">
      <div><b>Conversación</b><span>Un chat de WhatsApp con una persona. Se cuenta una sola vez, aunque escriba muchos mensajes.</span></div>
      <div><b>Conversaciones activas</b><span>Chats que tuvieron actividad ese día. Ojo: NO son leads nuevos. Si alguien responde tres días seguidos, cuenta en los tres.</span></div>
      <div><b>Triaje</b><span>Las 3 preguntas iniciales: qué dificultad hay, hace cuánto, y qué han intentado antes. Es el filtro que decide si el caso encaja.</span></div>
      <div><b>Triaje completo</b><span>Contestó las 3 preguntas. Recién ahí el bot puede ofrecer fechas y agendar. Antes de este punto no hay venta posible.</span></div>
      <div><b>Escalado</b><span>El bot le pasó el caso a un asesor humano y dejó de responder. Pasa con autismo o TEA, condiciones crónicas, afiliados a COMFAMA o FEISA, o si piden hablar con una persona.</span></div>
      <div><b>Cierre</b><span>El bot cerró la conversación por su cuenta, sin pasarla a nadie. Tres motivos: fuera de ciudad (no es Medellín ni alrededores), fuera de segmento (no es el perfil que atiende el centro) o sin presupuesto.</span></div>
      <div><b>Derivado</b><span>El lead tocó la puerta equivocada y pasó al otro bot: Carolina manda a Luisa si el paciente es adulto, Luisa manda a Carolina si es menor. La conversación sigue viva.</span></div>
      <div><b>Cita confirmada</b><span>El lead eligió fecha y hora y entregó sus datos. Es el momento en que el bot genera la cita real.</span></div>
      <div><b>Esperando pago</b><span>Ya tiene cita y se le envió el link de pago, pero todavía no se confirma el abono.</span></div>
      <div><b>Completado</b><span>Pagó. Es el final del embudo, la venta cerrada.</span></div>
      <div><b>Recovery</b><span>Job automático que reescribe al lead que dejó de responder. Intento 1 a las 3 horas, intento 2 a las 6. Si no contesta, se da por perdido.</span></div>
      <div><b>Llamadas IA</b><span>Cuántas veces se consultó a la inteligencia artificial ese día. Cada respuesta del bot es una llamada, más los análisis automáticos.</span></div>
      <div><b>Costo</b><span>Lo que costaron esas llamadas en dólares ese día.</span></div>
      <div><b>Inactividad</b><span>El lead dejó de responder a mitad de la conversación. Es la principal causa de pérdida.</span></div>
    </div>
  </details>
</section>

<!-- Row 0: Day by day -->
<section>
  <h2>Por día <small id="dia-nota"></small></h2>
  <div class="tcard"><table>
    <thead><tr><th>Día</th><th>Agente</th><th>Conversaciones activas</th><th>Escalados</th><th>Cierres</th><th>Derivados</th><th>Llamadas IA</th><th>Costo</th></tr></thead>
    <tbody id="t-diario"></tbody>
  </table></div>
</section>

<!-- One mirrored panel per bot, side by side and identically ordered so the
     two can be read against each other without hunting across mixed tables. -->
<section>
  <div class="col2" id="paneles"></div>
</section>

<!-- Cross-agent: alerts concern the whole operation -->
<section>
  <h2>Alertas activas</h2>
  <div class="alerts" id="alerts"></div>
</section>

<!-- The conversations behind each root_cause bucket. The panels say how many
     closed for a given reason; this says WHICH ones, with a phone to call. -->
<section>
  <h2>Casos por motivo <small id="casos-nota"></small></h2>
  <div class="filters" style="margin-bottom:0.75rem">
    <label>Motivo
      <select id="f-causa" onchange="render()"></select>
    </label>
    <label>Solo pendientes
      <select id="f-pendientes" onchange="render()">
        <option value="si" selected>Sí — aún sin resolver</option>
        <option value="no">Todos</option>
      </select>
    </label>
  </div>
  <div class="tcard"><table>
    <thead><tr><th>Estado</th><th>Bot</th><th>Contacto</th><th>Teléfono</th><th>Motivo consulta</th><th>Fecha</th><th>Detalle</th></tr></thead>
    <tbody id="t-casos"></tbody>
  </table></div>
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

// One panel per bot, same sections in the same order on both sides. The old
// layout mixed both agents into shared tables (one row tagged "Carolina", the
// next "Luisa"), which made comparing them a hunt. Tooltips repeat the glossary
// wording so a term can be resolved without scrolling back up.
function panelHTML(agent, inf, leads) {
  const f = funnelFor(inf, agent);
  const total  = +f.total || 0;
  const triaje = +f.con_triaje || 0;
  const ep     = +f.esperando_pago || 0;
  const comp   = +f.completados || 0;
  const esc    = +f.escalados || 0;
  const citas  = ep + comp;
  const tasa   = total ? (comp / total * 100).toFixed(1) + '%' : '0%';
  const ls = (leads.conversaciones || []).filter(l => l.agent === agent).length;

  const kpi = (label, val, cls, sub, ayuda) =>
    '<div class="pk"><div class="pk-l"><span class="ayuda" title="' + ayuda + '">' + label + '</span></div>' +
    '<div class="pk-v ' + cls + '">' + val + '</div><div class="pk-s">' + sub + '</div></div>';

  const kpis =
    kpi('Total', total, 'c-blue', 'en el periodo elegido',
        'Conversaciones de este bot con actividad dentro del filtro seleccionado.') +
    kpi('Triaje completo', pct(triaje, total), triaje > 0 ? 'c-green' : 'c-muted', triaje + ' conversaciones',
        'Contestaron las 3 preguntas iniciales. Recien aca el bot puede agendar.') +
    kpi('Citas confirmadas', citas, citas > 0 ? 'c-yellow' : 'c-muted', ep + ' esperando pago',
        'Eligieron fecha y hora y entregaron sus datos.') +
    kpi('Conversion', tasa, comp > 0 ? 'c-green' : 'c-red', comp + ' pagaron',
        'Porcentaje del total que llego a pagar.') +
    kpi('Escalados', esc, esc > 0 ? 'c-red' : 'c-green', 'esperan al asesor',
        'El bot le paso el caso a un humano y dejo de responder.') +
    kpi('Leads sin convertir', ls, ls > 0 ? 'c-yellow' : 'c-green', 'contacto manual',
        'Calificaron pero no avanzaron. Vale contactarlos a mano.');

  const steps = [
    ['Total entrantes', total,  '#3B82F6'],
    ['Triaje completo', triaje, '#8B5CF6'],
    ['Cita confirmada', citas,  '#EAB308'],
    ['Pagaron',         comp,   '#22C55E'],
  ];
  const max = steps[0][1] || 1;
  const embudo = steps.map(function (st) {
    const label = st[0], v = st[1], color = st[2];
    const w = Math.max(Math.round(v / max * 100), v > 0 ? 2 : 0);
    const pp = v === steps[0][1] ? '100%' : pct(v, steps[0][1]);
    return '<div class="f-row"><span class="f-label">' + label + '</span><div class="f-track">' +
           '<div class="f-bar" style="background:' + color + ';width:' + w + '%"><span class="f-count">' + v + '</span></div>' +
           '</div><span class="f-pct">' + pp + '</span></div>';
  }).join('');

  const estados = (inf.estados || []).filter(r => r.agent === agent).sort((a, b) => +b.total - +a.total);
  const tEstados = estados.length
    ? estados.map(r => '<tr><td>' + (LABELS[r.estado] || r.estado) + '</td><td class="mono">' + r.total +
        '</td><td class="mono muted">' + pct(+r.total, total || 1) + '</td></tr>').join('')
    : '<tr><td colspan="3" class="muted">Sin datos</td></tr>';

  const sintomas = (inf.sintomas || []).filter(r => r.agent === agent).slice(0, 8);
  const tSintomas = sintomas.length
    ? sintomas.map(r => '<tr><td>' + r.sintoma + '</td><td class="mono">' + r.total + '</td></tr>').join('')
    : '<tr><td colspan="2" class="muted">Sin datos</td></tr>';

  const rec = (inf.recovery || []).filter(x => x.agent === agent);
  const i1 = +((rec.find(x => x.recovery_status === 'intento-1') || {}).total) || 0;
  const i2 = +((rec.find(x => x.recovery_status === 'intento-2') || {}).total) || 0;
  const cerr = +((inf.estados.find(x => x.agent === agent && x.estado === 'cerrado') || {}).total) || 0;

  return '<div class="panel">' +
    '<div class="panel-head">' + agentDot(agent) + AGENT_LABEL[agent] +
      '<span class="sub">' + (agent === 'carolina' ? 'NHC Kids · niños' : 'NHC · adultos') + '</span></div>' +
    '<h3>Indicadores</h3><div class="pk-grid">' + kpis + '</div>' +
    '<h3><span class="ayuda" title="Cada escalon es una etapa que el lead debe superar. La caida entre uno y otro muestra donde se pierde.">Embudo de conversion</span></h3>' +
      '<div class="funnel">' + embudo + '</div>' +
    '<h3><span class="ayuda" title="En que etapa esta parada hoy cada conversacion.">Estados actuales</span></h3>' +
      '<div class="tcard"><table><thead><tr><th>Estado</th><th>Cant.</th><th>%</th></tr></thead><tbody>' + tEstados + '</tbody></table></div>' +
    '<h3><span class="ayuda" title="Motivo de consulta declarado en la primera pregunta del triaje.">Motivos de consulta</span></h3>' +
      '<div class="tcard"><table><thead><tr><th>Motivo</th><th>Cant.</th></tr></thead><tbody>' + tSintomas + '</tbody></table></div>' +
    '<h3><span class="ayuda" title="Reintentos automaticos al lead que dejo de responder: intento 1 a las 3h, intento 2 a las 6h.">Recovery</span></h3>' +
      '<div class="rec-grid">' +
        '<div class="rec-card"><div class="rec-val ' + (i1 > 0 ? 'c-yellow' : 'c-green') + '">' + i1 + '</div><div class="rec-lbl">Intento 1</div></div>' +
        '<div class="rec-card"><div class="rec-val ' + (i2 > 0 ? 'c-red' : 'c-green') + '">' + i2 + '</div><div class="rec-lbl">Intento 2</div></div>' +
        '<div class="rec-card"><div class="rec-val c-muted">' + cerr + '</div><div class="rec-lbl">Cerrados</div></div>' +
      '</div>' +
  '</div>';
}

function renderPaneles(inf, leads) {
  const cont = document.getElementById('paneles');
  const visibles = agentesVisibles();
  // With a single agent selected the panel takes the full width instead of
  // leaving an empty half.
  cont.style.gridTemplateColumns = visibles.length === 1 ? '1fr' : '';
  cont.innerHTML = visibles.map(a => panelHTML(a, inf, leads)).join('');
}

function renderAlerts(inf, leads) {
  const alerts = [];

  agentesVisibles().forEach(agent => {
    const f = funnelFor(inf, agent);
    const ep = +f.esperando_pago || 0;
    const esc = +f.escalados || 0;
    const pagoPendiente = (inf.pagos_pendientes || []).find(p => p.agent === agent);

    if (ep > 0 && pagoPendiente && pagoPendiente.mas_antigua) {
      const mins = Math.round((Date.now() - new Date(pagoPendiente.mas_antigua).getTime()) / 60000);
      if (mins > 120) {
        alerts.push({ t: 'r', icon: '\u{1F534}', tag: 'URGENTE', agent,
          msg: ep + ' lead(s) en <strong>esperando pago</strong> — abono sin confirmar hace ' + fmt(mins) + '. Contactar manualmente.' });
      }
    }

    const inact24 = (leads.conversaciones || []).filter(l => l.agent === agent && l.inactivo_minutos > 1440);
    if (inact24.length > 0) {
      alerts.push({ t: 'y', icon: '\u{1F7E1}', tag: 'ATENCIÓN', agent,
        msg: inact24.length + ' lead(s) calificado(s) con más de 24h sin responder. Recovery agotado — requieren contacto del asesor.' });
    }

    if (esc > 0) {
      alerts.push({ t: 'y', icon: '\u{1F7E1}', tag: 'ATENCIÓN', agent,
        msg: esc + ' conversación(es) escalada(s) esperando respuesta del asesor.' });
    }
  });

  if (alerts.length === 0) {
    alerts.push({ t: 'g', icon: '\u{1F7E2}', tag: 'OK', agent: null, msg: 'Todo dentro de rangos normales.' });
  }

  document.getElementById('alerts').innerHTML = alerts.map(a =>
    '<div class="alert ' + a.t + '"><span>' + a.icon + '</span>' +
    (a.agent ? '<span class="agent-tag ' + a.agent + '">' + AGENT_LABEL[a.agent] + '</span>' : '') +
    '<span class="a-msg">' + a.msg + '</span><span class="a-tag ' + a.t + '">' + a.tag + '</span></div>'
  ).join('');
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
let DATA = { inf: null, leads: null, diario: null, casos: null };

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
// Cases are fetched once for the whole window with no root_cause filter, so
// changing the motivo dropdown is instant. "Pendiente" means the conversation
// is still sitting in escalado: the bot handed it over and nobody closed it.
function renderCasos() {
  const tbody = document.getElementById('t-casos');
  const nota  = document.getElementById('casos-nota');
  const sel   = document.getElementById('f-causa');
  const todos = (DATA.casos && DATA.casos.casos) || [];

  // Rebuild the motivo options from what the window actually contains, keeping
  // the current pick when it survives the new window.
  const conteo = {};
  todos.forEach(c => { conteo[c.root_cause] = (conteo[c.root_cause] || 0) + 1; });
  const causas = Object.keys(conteo).sort((a, b) => conteo[b] - conteo[a]);
  const previo = sel.value;
  sel.innerHTML = causas.map(c => '<option value="' + c + '">' + c + ' (' + conteo[c] + ')</option>').join('')
    || '<option value="">sin datos</option>';
  sel.value = causas.includes(previo) ? previo : (causas[0] || '');

  const causa = sel.value;
  const soloPendientes = document.getElementById('f-pendientes').value === 'si';
  const esPendiente = c => c.estado_actual === 'escalado' || String(c.estado_actual || '').startsWith('triaje');

  let filas = todos.filter(c => c.root_cause === causa).filter(c => agentesVisibles().includes(c.agent));
  const pendientes = filas.filter(esPendiente).length;
  if (soloPendientes) filas = filas.filter(esPendiente);

  nota.textContent = causa
    ? '— ' + pendientes + ' sin resolver de ' + todos.filter(c => c.root_cause === causa && agentesVisibles().includes(c.agent)).length + ' en el periodo'
    : '';

  if (!filas.length) { tbody.innerHTML = '<tr><td colspan="7" class="muted">Sin casos para este filtro</td></tr>'; return; }

  tbody.innerHTML = filas.slice(0, 200).map((c, i) => {
    const pend = esPendiente(c);
    const tel = c.telefono
      ? '<span class="mono">' + c.telefono + '</span>'
      : '<span class="muted" title="No está en la caché de contactos; buscar en GHL por contact_id">sin teléfono</span>';
    const detalle = (c.drop_off_point || '') + (c.sugerencia ? '\n\nSUGERENCIA: ' + c.sugerencia : '');
    return '<tr>' +
      '<td><span class="rbadge ' + (pend ? 'rb-i2' : 'rb-no') + '">' + (pend ? 'PENDIENTE' : (c.estado_actual || '—')) + '</span></td>' +
      '<td><span class="agent-tag ' + c.agent + '">' + (AGENT_LABEL[c.agent] || c.agent) + '</span></td>' +
      '<td>' + (c.contacto || '—') + '</td>' +
      '<td>' + tel + '</td>' +
      '<td>' + (c.sintoma || '—') + '</td>' +
      '<td class="mono muted">' + String(c.fecha || '').slice(0, 10) + '</td>' +
      '<td><button class="tbtn" onclick="toggleCaso(' + i + ')">ver</button>' +
        '<div class="msgs" id="caso' + i + '"><div class="mline">' +
        (detalle ? detalle.replace(/</g, '&lt;').replace(/\n/g, '<br>') : 'Sin detalle registrado') +
        '</div><div class="mline muted">contact_id: ' + (c.contact_id || '—') + '</div></div></td>' +
    '</tr>';
  }).join('');
}

window.toggleCaso = function (i) {
  document.getElementById('caso' + i).classList.toggle('open');
};

// States are overwritten in place, so a filtered board describes conversations
// ACTIVE in the window shown in the state they hold today. Saying it out loud
// beats letting the number read as history it cannot be.
function renderPeriodo() {
  const dia = diaFiltro();
  const d = document.getElementById('periodo-nota');
  if (!d) return;
  d.textContent = dia !== 'todos'
    ? 'Mostrando solo ' + dia + ' — todo el informe está filtrado a ese día.'
    : 'Mostrando los últimos ' + document.getElementById('f-dias').value + ' días — todo el informe está filtrado a ese periodo.';
}

function render() {
  if (!DATA.inf) return;
  renderPeriodo();
  renderDiario();
  renderPaneles(DATA.inf, DATA.leads);
  renderAlerts(DATA.inf, DATA.leads);
  renderCasos();
  renderLeads(DATA.leads);
}

async function load() {
  try {
    const days = document.getElementById('f-dias').value;
    const dia  = diaFiltro();
    // The panels and the leads list follow both filters. The day table keeps
    // asking for the WHOLE period on purpose: it feeds the day dropdown, which
    // would collapse to a single option if the server pre-filtered it, leaving
    // no way to switch back to another day.
    const q = 'days=' + days + (dia !== 'todos' ? '&day=' + encodeURIComponent(dia) : '');
    const [r1, r2, r3, r4] = await Promise.all([
      fetch('/informe?' + q),
      fetch('/informe/triaje-completo?' + q),
      fetch('/informe/diario?days=' + days),
      fetch('/informe/casos?' + q),
    ]);
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('HTTP ' + r1.status + '/' + r2.status + '/' + r3.status);
    const [inf, leads, diario, casos] = await Promise.all([r1.json(), r2.json(), r3.json(), r4.json()]);
    DATA = { inf, leads, diario, casos };
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
