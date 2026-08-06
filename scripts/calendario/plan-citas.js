// DRY RUN. Reads only. Builds the plan for moving misrouted events out of the
// General calendar into each therapist's, and writes it to plan.json so the
// apply step runs exactly what was reviewed here.
const fs = require('fs');
const zoho = require('../../services/zoho');

const key = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const GENERAL = 'lzwahRhkogIG1Ct9BX7p';
const SALIDA = require('path').join(__dirname, 'plan.json');

const CALENDARIOS = {
  '3572150000004930155': ['MvnOMgGMs69y6Ewix22r', 'Juan Esteban Tamayo'],
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

// GHL returns "2026-07-27T15:00:00-05:00" — the wall time is already Colombia
// local, so it maps straight onto Zoho's "27-Jul-2026 15:00:00".
function aFormatoZoho(ghlTime) {
  const m = String(ghlTime).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, yyyy, mm, dd, hh, mi, ss] = m;
  return `${dd}-${MESES[Number(mm) - 1]}-${yyyy} ${hh}:${mi}:${ss}`;
}

async function traerEventos(desdeMs, hastaMs) {
  const url = `https://services.leadconnectorhq.com/calendars/events?locationId=${locationId}&calendarId=${GENERAL}&startTime=${desdeMs}&endTime=${hastaMs}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Version: '2021-04-15' } });
  const data = await res.json();
  if (!res.ok) throw new Error(`GHL ${res.status}: ${JSON.stringify(data)}`);
  return data.events || [];
}

(async () => {
  // Weekly chunks so the 200-per-response cap never truncates a window.
  const inicio = Date.parse('2026-07-01T00:00:00Z');
  const fin = Date.parse('2026-12-31T23:59:59Z');
  const SEMANA = 7 * 24 * 3600 * 1000;
  const porId = new Map();
  for (let t = inicio; t < fin; t += SEMANA) {
    const lote = await traerEventos(t, Math.min(t + SEMANA, fin));
    if (lote.length >= 200) console.warn(`AVISO: tramo desde ${new Date(t).toISOString().slice(0,10)} devolvió ${lote.length} — puede estar topado`);
    for (const e of lote) porId.set(e.id, e);
  }
  const eventos = [...porId.values()];
  console.log(`EVENTOS EN GENERAL: ${eventos.length}\n`);

  // One Zoho query per distinct day, reused across that day's events.
  const cachePorDia = new Map();
  const plan = [];
  const sinMatch = [];
  const yaCorrectos = [];

  for (const e of eventos) {
    const inicioZoho = aFormatoZoho(e.startTime);
    const finZoho = aFormatoZoho(e.endTime);
    if (!inicioZoho) { sinMatch.push({ id: e.id, title: e.title, motivo: 'startTime ilegible' }); continue; }

    const dia = inicioZoho.slice(0, 11);
    if (!cachePorDia.has(dia)) cachePorDia.set(dia, await zoho.buscarCitaPorInicio(inicioZoho, '', finZoho));
    // The cache above only helps identical slots; do the real lookup per event.
    const reg = await zoho.buscarCitaPorInicio(inicioZoho, '', finZoho);

    const consultorID = reg?.Consultor?.ID || '';
    const destino = CALENDARIOS[consultorID];
    if (!destino) {
      sinMatch.push({
        id: e.id, title: e.title, inicio: inicioZoho,
        motivo: reg ? `cita ${reg.ID} sin Consultor mapeado` : 'no se encontró la cita en Zoho',
      });
      continue;
    }
    if (destino[0] === GENERAL) { yaCorrectos.push(e.id); continue; }
    plan.push({
      eventId: e.id,
      title: e.title,
      inicio: inicioZoho,
      contactId: e.contactId,
      desde: GENERAL,
      hacia: destino[0],
      terapeuta: destino[1],
      zohoID: reg.ID,
      tipo: reg.Tipo,
    });
  }

  const porTerapeuta = {};
  for (const p of plan) porTerapeuta[p.terapeuta] = (porTerapeuta[p.terapeuta] || 0) + 1;

  console.log('=== SE MOVERIAN ===');
  for (const [t, n] of Object.entries(porTerapeuta).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${t}`);
  }
  console.log(`\n  TOTAL A MOVER: ${plan.length}`);
  console.log(`  SE QUEDAN EN GENERAL (sin match): ${sinMatch.length}`);

  const motivos = {};
  for (const s of sinMatch) motivos[s.motivo] = (motivos[s.motivo] || 0) + 1;
  console.log('\n=== MOTIVOS DE LOS QUE NO SE MUEVEN ===');
  for (const [m, n] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${m}`);

  fs.writeFileSync(SALIDA, JSON.stringify({ generado: new Date().toISOString(), plan, sinMatch }, null, 2));
  console.log(`\nPlan escrito en plan.json (${plan.length} movimientos). NADA fue modificado.`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
