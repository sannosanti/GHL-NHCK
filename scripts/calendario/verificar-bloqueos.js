// Read-only: how many block-slots remain in General vs each therapist's calendar.
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
};
(async () => {
  const inicio = Date.parse('2026-07-01T00:00:00Z'), fin = Date.parse('2026-12-31T23:59:59Z');
  const SEM = 7 * 24 * 3600 * 1000;
  console.log('CALENDARIO                  BLOQUEOS');
  for (const [id, nombre] of Object.entries(CALS)) {
    const ids = new Set();
    for (let t = inicio; t < fin; t += SEM) {
      const url = `https://services.leadconnectorhq.com/calendars/blocked-slots?locationId=${locationId}&calendarId=${id}&startTime=${t}&endTime=${Math.min(t + SEM, fin)}`;
      const r = await fetch(url, { headers: H });
      if (!r.ok) continue;
      const d = await r.json();
      for (const e of (d.events || d.blockedSlots || [])) ids.add(e.id);
    }
    console.log(`${nombre.padEnd(26)} ${String(ids.size).padStart(5)}`);
  }
})();
