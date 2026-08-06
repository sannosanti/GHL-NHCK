// DRY RUN. Solo lectura. Busca lo que existe en Zoho y nunca llegó a GHL, y
// escribe plan-faltantes.json con qué habría que crear y en qué calendario.
//
// El webhook solo crea cuando dispara: nunca hubo un proceso que trajera lo que
// ya estaba en Zoho, ni que recuperara los disparos perdidos. Por eso faltan
// citas viejas aunque el ruteo de las nuevas ya funcione.
//
//   node scripts/calendario/plan-faltantes.js 2026-07-01 2026-10-31
const fs = require('fs');
const path = require('path');
const zoho = require('../../services/zoho');
const { tituloGHL } = require('../../webhooks/zoho');

const key = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15' };
const SALIDA = path.join(__dirname, 'plan-faltantes.json');

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
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const nombreDeTitulo = t => norm(String(t || '').split(' - ').slice(1).join(' - '));

function aZoho(t) {
  const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[3]}-${MESES[+m[2] - 1]}-${m[1]} ${m[4]}:${m[5]}:${m[6]}` : null;
}

async function traer(endpoint, calendarId, desde, hasta) {
  const out = [];
  const SEM = 7 * 24 * 3600 * 1000;
  for (let t = desde; t < hasta; t += SEM) {
    const url = `https://services.leadconnectorhq.com/calendars/${endpoint}?locationId=${locationId}&calendarId=${calendarId}&startTime=${t}&endTime=${Math.min(t + SEM, hasta)}`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) continue;
    const d = await r.json();
    out.push(...(d.events || d.blockedSlots || []));
  }
  return out;
}

(async () => {
  const desdeISO = process.argv[2] || '2026-07-01';
  const hastaISO = process.argv[3] || '2026-10-31';
  const desde = Date.parse(`${desdeISO}T00:00:00Z`);
  const hasta = Date.parse(`${hastaISO}T23:59:59Z`);

  // Qué hay hoy en GHL, por calendario. Las citas se identifican por contacto +
  // inicio; los bloqueos, que no tienen contacto, por inicio + fin.
  const citasPorCal = new Map();     // calId -> Set("nombre|inicio")
  const bloqueosPorCal = new Map();  // calId -> Set("inicio|fin")
  for (const [calId, nombre] of Object.values(CALENDARIOS)) {
    const ev = await traer('events', calId, desde, hasta);
    const bl = await traer('blocked-slots', calId, desde, hasta);
    citasPorCal.set(calId, new Set(ev.map(e => `${nombreDeTitulo(e.title)}|${aZoho(e.startTime)}`)));
    bloqueosPorCal.set(calId, new Set(bl.map(e => `${aZoho(e.startTime)}|${aZoho(e.endTime)}`)));
    console.error(`  ${nombre.padEnd(24)} citas=${ev.length} bloqueos=${bl.length}`);
  }

  const crearCitas = [], crearBloqueos = [], sinTelefono = [], sinConsultor = [];
  for (let t = desde; t <= hasta; t += 24 * 3600 * 1000) {
    const dia = new Date(t).toISOString().slice(0, 10);
    for (const c of await zoho.getDisponibilidad(dia)) {
      const destino = CALENDARIOS[c.Consultor?.ID || ''];
      if (!destino) { sinConsultor.push({ zohoID: c.ID, inicio: c.Inicio }); continue; }
      const [calId, terapeuta] = destino;
      const contacto = c.Contacto?.display_value;

      if (contacto) {
        if (citasPorCal.get(calId).has(`${norm(contacto)}|${c.Inicio}`)) continue;
        crearCitas.push({
          zohoID: c.ID, contactoZohoID: c.Contacto.ID, contacto,
          inicio: c.Inicio, fin: c.Fin, tipo: c.Tipo || 'Cita',
          calendarId: calId, terapeuta,
        });
      } else {
        if (bloqueosPorCal.get(calId).has(`${c.Inicio}|${c.Fin}`)) continue;
        crearBloqueos.push({
          zohoID: c.ID, inicio: c.Inicio, fin: c.Fin,
          titulo: tituloGHL([c.Tipo, c.Observaciones], c.Tipo || 'Bloqueo'),
          calendarId: calId, terapeuta,
        });
      }
    }
  }

  const resumen = xs => {
    const m = {};
    for (const x of xs) m[x.terapeuta] = (m[x.terapeuta] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };

  console.log(`\nRANGO ${desdeISO} .. ${hastaISO}\n`);
  console.log(`  CITAS A CREAR    ${crearCitas.length}`);
  for (const [t, n] of resumen(crearCitas)) console.log(`      ${String(n).padStart(4)}  ${t}`);
  console.log(`\n  BLOQUEOS A CREAR ${crearBloqueos.length}`);
  for (const [t, n] of resumen(crearBloqueos)) console.log(`      ${String(n).padStart(4)}  ${t}`);
  console.log(`\n  SIN CONSULTOR (se ignoran) ${sinConsultor.length}`);

  fs.writeFileSync(SALIDA, JSON.stringify({ generado: new Date().toISOString(), desdeISO, hastaISO, crearCitas, crearBloqueos, sinConsultor }, null, 2));
  console.log(`\nplan-faltantes.json escrito. NADA fue creado.`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
