// Read-only: what is left in General, and did each therapist's calendar receive
// what the plan promised?
const key = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15' };

const CALS = {
  'lzwahRhkogIG1Ct9BX7p': 'General',
  'MvnOMgGMs69y6Ewix22r': 'Pre-evaluación NHC',
  'iTdbaauOdCrcNHwsIe2h': 'Neuromapeo NHC',
  'M1fNQqz0yn8LH1op8I4s': 'Neurotecnologías',
  'pLhcRJMTzeTjhrv8dqDY': 'Katerine Bolivar Uribe',
  'vvb8taavISxlgeGoXd78': 'Santiago Gallego',
  '5OHWEK3t2Wvg1xc9tsRv': 'Yamile Herrera',
  'hsHuxGh5wLknUFxWt0Sk': 'Laura Franco Gómez',
  'wRUCuDmqhbxmU3rvgG5j': 'Juliana Restrepo Ruiz',
  'kzPKbuB2npt64tyXuFnx': 'David Valderrama Goez',
  'SAjr7SxN1h0biqbiprV1': 'Juliana Duque Rodriguez',
};

async function contar(calendarId) {
  // Weekly chunks: the endpoint caps at 200 per response.
  const inicio = Date.parse('2026-07-01T00:00:00Z');
  const fin = Date.parse('2026-12-31T23:59:59Z');
  const SEMANA = 7 * 24 * 3600 * 1000;
  const ids = new Set();
  for (let t = inicio; t < fin; t += SEMANA) {
    const url = `https://services.leadconnectorhq.com/calendars/events?locationId=${locationId}&calendarId=${calendarId}&startTime=${t}&endTime=${Math.min(t + SEMANA, fin)}`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) continue;
    const d = await r.json();
    for (const e of d.events || []) ids.add(e.id);
  }
  return ids;
}

(async () => {
  console.log('CALENDARIO                  EVENTOS');
  let total = 0;
  for (const [id, nombre] of Object.entries(CALS)) {
    const ids = await contar(id);
    total += ids.size;
    console.log(`${nombre.padEnd(26)} ${String(ids.size).padStart(5)}`);
  }
  console.log(`${''.padEnd(26)} -----`);
  console.log(`${'TOTAL'.padEnd(26)} ${String(total).padStart(5)}`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
