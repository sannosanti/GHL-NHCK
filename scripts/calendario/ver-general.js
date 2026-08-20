// Lista lo que hay en el calendario general de GHL en un rango. Es el destino
// de todo lo que el webhook no pudo rutear, así que es donde se acumula el daño
// de un corte de Zoho. Sólo consulta GHL: no gasta cuota de Creator.
//
//   node scripts/calendario/ver-general.js 2026-08-20 2026-10-31
const CALENDAR_GENERAL = 'lzwahRhkogIG1Ct9BX7p';
const H = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-04-15' };
const locationId = process.env.GHL_LOCATION_ID;
const dormir = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const desde = Date.parse(`${process.argv[2] || '2026-08-20'}T00:00:00-05:00`);
  const hasta = Date.parse(`${process.argv[3] || '2026-10-31'}T23:59:59-05:00`);
  const base = 'https://services.leadconnectorhq.com/calendars';
  const todo = [];

  // De a una semana: pedir rangos largos devuelve resultados incompletos.
  for (let t = desde; t < hasta; t += 7 * 86400000) {
    const fin = Math.min(t + 7 * 86400000, hasta);
    for (const [ruta, marca] of [['events', 'cita'], ['blocked-slots', 'bloqueo']]) {
      const r = await fetch(`${base}/${ruta}?locationId=${locationId}&calendarId=${CALENDAR_GENERAL}&startTime=${t}&endTime=${fin}`, { headers: H });
      await dormir(300);
      if (!r.ok) { console.error(`  aviso: ${ruta} ${new Date(t).toISOString().slice(0,10)} -> HTTP ${r.status}`); continue; }
      const d = await r.json();
      for (const e of (d.events || d.blockedSlots || [])) todo.push({ ...e, marca });
    }
  }

  const vistos = new Set();
  const unicos = todo.filter(e => !vistos.has(e.id) && vistos.add(e.id));
  console.log(`\nEn el calendario general: ${unicos.length} eventos\n`);
  for (const e of unicos.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))) {
    const f = new Date(e.startTime).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    console.log(`  ${f}  ${e.marca.padEnd(8)} ${String(e.title).slice(0, 45).padEnd(47)} ${e.id}`);
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
