// DRY RUN. Planifica el envío a cuarentena de los bloqueos genéricos que quedaron
// en el calendario general durante un corte de Zoho.
//
// Cuando Creator no responde, el webhook no puede resolver el Consultor ni el
// contacto, así que archiva la cita en el general como bloqueo sin paciente y
// titulado "Cita". Una vez recreadas en el calendario que corresponde
// (crear-faltantes.js), esos bloqueos quedan duplicados.
//
// LA COMPROBACIÓN QUE IMPORTA: cada bloqueo se manda a cuarentena SOLO si se
// confirma que existe su reemplazo — una cita real, en el calendario del
// profesional, a la misma hora. Sin reemplazo se deja quieto y se reporta.
// Mover un bloqueo sin verificarlo sería esconder la cita de un paciente.
//
//   node scripts/calendario/plan-cuarentena-general.js 2026-08-21 2026-09-09
const fs = require('fs');
const path = require('path');
const zoho = require('../../services/zoho');
const { parseZohoDateTime } = require('../../webhooks/zoho');

const CALENDAR_GENERAL = 'lzwahRhkogIG1Ct9BX7p';
const CALENDARIOS = {
  '3572150000004930155': 'MvnOMgGMs69y6Ewix22r', '3572150000005140253': 'iTdbaauOdCrcNHwsIe2h',
  '3572150000004871148': 'M1fNQqz0yn8LH1op8I4s', '3572150000009238003': 'pLhcRJMTzeTjhrv8dqDY',
  '3572150000004912180': 'vvb8taavISxlgeGoXd78', '3572150000004826082': '5OHWEK3t2Wvg1xc9tsRv',
  '3572150000004871136': 'hsHuxGh5wLknUFxWt0Sk', '3572150000013136002': 'wRUCuDmqhbxmU3rvgG5j',
  '3572150000004871160': 'kzPKbuB2npt64tyXuFnx', '3572150000006479156': 'SAjr7SxN1h0biqbiprV1',
};
const H = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-04-15' };
const locationId = process.env.GHL_LOCATION_ID;
const BASE = 'https://services.leadconnectorhq.com/calendars';
const SALIDA = path.join(__dirname, 'plan-cuarentena-general.json');
const dormir = ms => new Promise(r => setTimeout(r, ms));

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
  const desdeISO = process.argv[2] || '2026-08-21';
  const hastaISO = process.argv[3] || '2026-09-09';
  const desde = Date.parse(`${desdeISO}T00:00:00-05:00`);
  const hasta = Date.parse(`${hastaISO}T23:59:59-05:00`);

  const calendarios = (await traer(`${BASE}/?locationId=${locationId}`)).calendars || [];
  const nombrePorId = new Map(calendarios.map(c => [c.id, c.name]));
  const cuarentena = calendarios.find(c => /cuarentena/i.test(c.name));
  if (!cuarentena) throw new Error('no existe un calendario de cuarentena');
  console.error(`cuarentena: ${cuarentena.name} (${cuarentena.id})`);

  // 1. Los bloqueos genéricos que siguen en el general.
  const sospechosos = [];
  for (let t = desde; t < hasta; t += 7 * 86400000) {
    const fin = Math.min(t + 7 * 86400000, hasta);
    const d = await traer(`${BASE}/blocked-slots?locationId=${locationId}&calendarId=${CALENDAR_GENERAL}&startTime=${t}&endTime=${fin}`);
    for (const b of (d.events || d.blockedSlots || [])) {
      // Sólo los genéricos: un bloqueo con título real lo escribió una persona.
      if (String(b.title || '').trim() !== 'Cita') continue;
      if (!sospechosos.some(x => x.id === b.id)) sospechosos.push(b);
    }
  }
  console.error(`bloqueos genéricos en el general: ${sospechosos.length}`);

  // 2. Para cada uno, qué dice Zoho que debería ser, y si ya existe allá.
  const citasPorDia = new Map();
  const aCuarentena = [], sinReemplazo = [];

  for (const b of sospechosos) {
    const dia = new Date(Date.parse(b.startTime)).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    if (!citasPorDia.has(dia)) citasPorDia.set(dia, await zoho.getDisponibilidad(dia));
    const zohoInicio = citasPorDia.get(dia).filter(c => Date.parse(parseZohoDateTime(c.Inicio)) === Date.parse(b.startTime));

    const conConsultor = zohoInicio.find(c => CALENDARIOS[c.Consultor?.ID || '']);
    if (!conConsultor) {
      sinReemplazo.push({ eventId: b.id, startTime: b.startTime, motivo: 'Zoho no tiene una cita con consultor a esa hora' });
      continue;
    }
    const calDestino = CALENDARIOS[conConsultor.Consultor.ID];

    const evs = await traer(`${BASE}/events?locationId=${locationId}&calendarId=${calDestino}&startTime=${Date.parse(b.startTime) - 60000}&endTime=${Date.parse(b.endTime) + 60000}`);
    const reemplazo = (evs.events || []).find(e => Date.parse(e.startTime) === Date.parse(b.startTime));
    if (!reemplazo) {
      sinReemplazo.push({ eventId: b.id, startTime: b.startTime, motivo: `falta la cita en ${nombrePorId.get(calDestino)}` });
      continue;
    }

    aCuarentena.push({
      eventId: b.id, desde: CALENDAR_GENERAL, calendario: 'General',
      title: b.title, startTime: b.startTime,
      motivo: `duplicado: ya existe "${reemplazo.title}" en ${nombrePorId.get(calDestino)}`,
    });
  }

  fs.writeFileSync(SALIDA, JSON.stringify({ generado: new Date().toISOString(), cuarentenaId: cuarentena.id, aCuarentena, sinReemplazo }, null, 2));
  console.log(`\nA CUARENTENA (con reemplazo confirmado): ${aCuarentena.length}`);
  for (const x of aCuarentena.slice(0, 40)) {
    console.log(`  ${new Date(x.startTime).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}  ${x.motivo}`);
  }
  console.log(`\nSE DEJAN QUIETOS (sin reemplazo): ${sinReemplazo.length}`);
  for (const x of sinReemplazo) {
    console.log(`  ${new Date(x.startTime).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}  ${x.motivo}`);
  }
  console.log(`\nplan-cuarentena-general.json escrito. NADA fue movido.`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
