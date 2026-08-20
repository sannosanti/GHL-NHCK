// Lista lo que GHL tiene un día dado, calendario por calendario, citas Y
// bloqueos. Sólo consulta GHL: sirve justo cuando Zoho no responde y hace falta
// ver el otro lado sin gastar cuota de Creator.
//
//   node scripts/calendario/ver-dia-ghl.js 2026-08-20
const key = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15' };
const dormir = ms => new Promise(r => setTimeout(r, ms));

// GHL devuelve 524 cuando tarda de más; reintentar alcanza.
async function traer(url, intentos = 3) {
  for (let i = 1; i <= intentos; i++) {
    const r = await fetch(url, { headers: H });
    await dormir(300);
    if (r.ok) return r.json();
    if (i === intentos) throw new Error(`HTTP ${r.status}`);
    await dormir(1500);
  }
}

(async () => {
  const dia = process.argv[2] || new Date().toISOString().slice(0, 10);
  // La clínica trabaja en -05 y GHL guarda en UTC.
  const desde = Date.parse(`${dia}T00:00:00-05:00`);
  const hasta = Date.parse(`${dia}T23:59:59-05:00`);
  const base = `https://services.leadconnectorhq.com/calendars`;

  const calendarios = (await traer(`${base}/?locationId=${locationId}`)).calendars || [];

  let total = 0;
  for (const cal of calendarios) {
    const eventos = [];
    try {
      // Dos endpoints distintos: /events trae SOLO citas, los bloqueos viven
      // aparte. En la vista de Zoho los bloqueos son buena parte de lo que se ve.
      const citas = await traer(`${base}/events?locationId=${locationId}&calendarId=${cal.id}&startTime=${desde}&endTime=${hasta}`);
      eventos.push(...(citas.events || []));
      const bl = await traer(`${base}/blocked-slots?locationId=${locationId}&calendarId=${cal.id}&startTime=${desde}&endTime=${hasta}`);
      for (const b of (bl.events || bl.blockedSlots || [])) eventos.push({ ...b, esBloqueo: true });
    } catch (err) {
      console.log(`\n### ${cal.name}: NO SE PUDO LEER — ${err.message}`);
      continue;
    }

    if (!eventos.length) continue;
    total += eventos.length;
    console.log(`\n=== ${cal.name}  (${eventos.length}) ===`);
    for (const e of eventos.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))) {
      const hora = t => new Date(t).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota', hour12: false });
      const marca = e.esBloqueo ? 'BLOQUEO   ' : String(e.appointmentStatus || '').padEnd(10);
      console.log(`  ${hora(e.startTime)}-${hora(e.endTime)}  ${marca} ${e.title}`);
    }
  }
  console.log(`\nTOTAL en GHL el ${dia}: ${total} eventos`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
