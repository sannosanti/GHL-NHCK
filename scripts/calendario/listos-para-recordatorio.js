// ¿Cuántas citas próximas se pueden recordar y cuántas no?
//
// Un recordatorio necesita un paciente al que escribirle. Una cita en GHL lo
// tiene (contactId); un bloqueo no. Y hay bloqueos que en realidad SON citas:
// cuando el webhook no pudo resolver el contacto en Zoho, archivó la cita como
// bloqueo con el nombre en el título. Esa persona existe, tiene turno, y hoy
// no hay forma de avisarle.
//
//   node scripts/calendario/listos-para-recordatorio.js 30
const H = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-04-15' };
const loc = process.env.GHL_LOCATION_ID;
const dormir = ms => new Promise(r => setTimeout(r, ms));
// Un bloqueo cuyo titulo empieza con el Tipo de una cita es una cita degradada.
const PARECE_CITA = /^(presencial|virtual|cita|neuromapeo)\s*-\s*\S/i;

async function traer(url, intentos = 4) {
  for (let i = 1; i <= intentos; i++) {
    const r = await fetch(url, { headers: H });
    await dormir(300);
    if (r.ok) return r.json();
    if (i === intentos) throw new Error(`HTTP ${r.status}`);
    await dormir(1500 * i);
  }
}

(async () => {
  const dias = Number(process.argv[2]) || 30;
  const desde = Date.now();
  const hasta = desde + dias * 86400000;
  const base = 'https://services.leadconnectorhq.com/calendars';
  const calendarios = ((await traer(`${base}/?locationId=${loc}`)).calendars || []).filter(c => /zoho sync/i.test(c.name));

  let conPaciente = 0, degradadas = 0, bloqueosReales = 0, canceladas = 0;
  const ejemplos = [];

  for (const cal of calendarios) {
    for (let t = desde; t < hasta; t += 7 * 86400000) {
      const fin = Math.min(t + 7 * 86400000, hasta);
      const citas = await traer(`${base}/events?locationId=${loc}&calendarId=${cal.id}&startTime=${t}&endTime=${fin}`);
      for (const e of (citas.events || [])) {
        if (e.appointmentStatus === 'cancelled') { canceladas++; continue; }
        if (e.contactId) conPaciente++;
        else { degradadas++; if (ejemplos.length < 8) ejemplos.push(`${cal.name.slice(0, 20)} · ${e.title}`); }
      }
      const bl = await traer(`${base}/blocked-slots?locationId=${loc}&calendarId=${cal.id}&startTime=${t}&endTime=${fin}`);
      for (const b of (bl.events || bl.blockedSlots || [])) {
        if (PARECE_CITA.test(String(b.title || ''))) {
          degradadas++;
          if (ejemplos.length < 8) ejemplos.push(`${cal.name.slice(0, 20)} · ${b.title}   [bloqueo]`);
        } else bloqueosReales++;
      }
    }
  }

  const total = conPaciente + degradadas;
  console.log(`Proximos ${dias} dias`);
  console.log(`  turnos de pacientes            : ${total}`);
  console.log(`    se les puede recordar        : ${conPaciente}   ${total ? (conPaciente / total * 100).toFixed(1) + '%' : ''}`);
  console.log(`    SIN paciente asociado        : ${degradadas}   ${total ? (degradadas / total * 100).toFixed(1) + '%' : ''}`);
  console.log(`  bloqueos reales (no son citas) : ${bloqueosReales}`);
  console.log(`  canceladas (se ignoran)        : ${canceladas}`);
  if (ejemplos.length) {
    console.log('\n  ejemplos de turnos sin paciente asociado:');
    for (const e of ejemplos) console.log(`    ${e}`);
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
