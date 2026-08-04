// DRY RUN. Reads only. Same idea as plan-backfill.js but for block-slots, which
// /calendars/events does not return — they only show up under
// /calendars/blocked-slots. Writes plan-bloqueos.json.
const fs = require('fs');
const zoho = require('../../services/zoho');

const key = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const GENERAL = 'lzwahRhkogIG1Ct9BX7p';
const BASE = __dirname;

const CALENDARIOS = {
  '3572150000004930155': ['MvnOMgGMs69y6Ewix22r', 'Pre-evaluación NHC'],
  '3572150000005140253': ['iTdbaauOdCrcNHwsIe2h', 'Neuromapeo NHC'],
  '3572150000004871148': ['M1fNQqz0yn8LH1op8I4s', 'Neurotecnologías'],
  '3572150000009238003': ['pLhcRJMTzeTjhrv8dqDY', 'Katerine Bolivar Uribe'],
  '3572150000004912180': ['vvb8taavISxlgeGoXd78', 'Santiago Gallego'],
  '3572150000004826082': ['5OHWEK3t2Wvg1xc9tsRv', 'Yamile Herrera'],
  '3572150000004871136': ['hsHuxGh5wLknUFxWt0Sk', 'Laura Franco Gómez'],
  '3572150000013136002': ['wRUCuDmqhbxmU3rvgG5j', 'Juliana Restrepo Ruiz'],
  '3572150000004871160': ['kzPKbuB2npt64tyXuFnx', 'David Valderrama Goez'],
  '3572150000006479156': ['SAjr7SxN1h0biqbiprV1', 'Juliana Duque Rodriguez'],
};

const MESES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function aFormatoZoho(t) {
  const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, yyyy, mm, dd, hh, mi, ss] = m;
  return `${dd}-${MESES[Number(mm) - 1]}-${yyyy} ${hh}:${mi}:${ss}`;
}

(async () => {
  const inicio = Date.parse('2026-07-01T00:00:00Z');
  const fin = Date.parse('2026-12-31T23:59:59Z');
  const SEMANA = 7 * 24 * 3600 * 1000;
  const porId = new Map();
  for (let t = inicio; t < fin; t += SEMANA) {
    const url = `https://services.leadconnectorhq.com/calendars/blocked-slots?locationId=${locationId}&calendarId=${GENERAL}&startTime=${t}&endTime=${Math.min(t + SEMANA, fin)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Version: '2021-04-15' } });
    if (!r.ok) { console.error(`tramo ${new Date(t).toISOString().slice(0,10)}: HTTP ${r.status}`); continue; }
    const d = await r.json();
    const lote = d.events || d.blockedSlots || [];
    if (lote.length >= 200) console.warn(`AVISO: tramo ${new Date(t).toISOString().slice(0,10)} devolvió ${lote.length} — puede estar topado`);
    for (const e of lote) porId.set(e.id, e);
  }
  const bloqueos = [...porId.values()];
  console.log(`BLOQUEOS EN GENERAL: ${bloqueos.length}\n`);

  const plan = [], sinMatch = [];
  for (const b of bloqueos) {
    const inicioZoho = aFormatoZoho(b.startTime);
    const finZoho = aFormatoZoho(b.endTime);
    if (!inicioZoho) { sinMatch.push({ id: b.id, motivo: 'startTime ilegible' }); continue; }

    // Blocks carry no Contacto, so Inicio + Fin (and the Added_Time tiebreak
    // inside buscarCitaPorInicio) are all there is to identify them by.
    const reg = await zoho.buscarCitaPorInicio(inicioZoho, '', finZoho);
    const destino = CALENDARIOS[reg?.Consultor?.ID || ''];
    if (!destino) {
      sinMatch.push({ id: b.id, inicio: inicioZoho, title: b.title, motivo: reg ? `cita ${reg.ID} sin Consultor mapeado` : 'no se encontró en Zoho' });
      continue;
    }
    plan.push({
      eventId: b.id, title: b.title, inicio: inicioZoho,
      desde: GENERAL, hacia: destino[0], terapeuta: destino[1],
      zohoID: reg.ID, tipo: reg.Tipo, obs: reg.Observaciones || '',
    });
  }

  const porTerapeuta = {};
  for (const p of plan) porTerapeuta[p.terapeuta] = (porTerapeuta[p.terapeuta] || 0) + 1;
  console.log('=== SE MOVERIAN ===');
  for (const [t, n] of Object.entries(porTerapeuta).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t}`);
  console.log(`\n  TOTAL A MOVER: ${plan.length}`);
  console.log(`  SE QUEDAN: ${sinMatch.length}`);
  const motivos = {};
  for (const s of sinMatch) motivos[s.motivo] = (motivos[s.motivo] || 0) + 1;
  for (const [m, n] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${m}`);

  fs.writeFileSync(`${BASE}/plan-bloqueos.json`, JSON.stringify({ generado: new Date().toISOString(), plan, sinMatch }, null, 2));
  console.log(`\nplan-bloqueos.json escrito (${plan.length} movimientos). NADA fue modificado.`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
