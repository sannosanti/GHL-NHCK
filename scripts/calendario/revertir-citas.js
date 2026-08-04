// Undo: sends every event recorded as moved in resultados.ndjson back to the
// General calendar. Exists so the backfill is a reversible decision rather than
// a one-way door — reads the log, not the plan, so it only touches what actually
// moved.
const fs = require('fs');

const key = process.env.GHL_API_KEY;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15', 'Content-Type': 'application/json' };
const BASE = __dirname;

const dormir = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const lineas = fs.readFileSync(`${BASE}/resultados.ndjson`, 'utf8').trim().split('\n').map(JSON.parse);
  const movidos = lineas.filter(l => l.estado === 'movido');
  console.log(`Se devolverán ${movidos.length} eventos a General.\n`);

  let ok = 0, fallos = 0;
  for (const [i, m] of movidos.entries()) {
    try {
      const g = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${m.eventId}`, { headers: H });
      const d = await g.json();
      const ev = d.event || d.appointment || d;
      await dormir(350);

      const r = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${m.eventId}`, {
        method: 'PUT', headers: H,
        body: JSON.stringify({
          calendarId: m.desde,
          startTime: ev.startTime, endTime: ev.endTime, title: ev.title,
          appointmentStatus: ev.appointmentStatus || 'confirmed',
          toNotify: false, ignoreFreeSlotValidation: true, ignoreDateRange: true,
        }),
      });
      if (!r.ok) throw new Error(`PUT ${r.status}`);
      ok++;
      console.log(`[${i + 1}/${movidos.length}] devuelto  ${m.title}`);
      await dormir(350);
    } catch (err) {
      fallos++;
      console.error(`[${i + 1}/${movidos.length}] FALLO  ${m.title} — ${err.message}`);
    }
  }
  console.log(`\ndevueltos: ${ok}  fallidos: ${fallos}`);
})().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
