// DRY RUN. Solo lectura. La cuarentena original cubrió únicamente las citas con
// paciente; los bloqueos se migraron pero nunca se reconciliaron contra Zoho. La
// clínica lo reportó el 2026-08-06: bloqueos duplicados en Yamile, bloqueos que
// no existen en Katerine y Laura, y bloqueos encima de mapeos ya programados.
//
// Un bloqueo se identifica por inicio + fin, porque no tiene contacto que lo
// distinga. Se compara cuántos hay de cada par en Zoho y cuántos en GHL: los que
// exceden esa cuenta sobran, y los que no aparecen en Zoho sobran enteros.
//
//   node scripts/calendario/plan-cuarentena-bloqueos.js 2026-07-01 2026-12-31
const fs = require('fs');
const path = require('path');
const zoho = require('../../services/zoho');

const key = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15' };
const SALIDA = path.join(__dirname, 'plan-cuarentena-bloqueos.json');

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
const aZoho = t => {
  const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[3]}-${MESES[+m[2] - 1]}-${m[1]} ${m[4]}:${m[5]}:${m[6]}` : null;
};

async function bloqueosDe(calendarId, desde, hasta) {
  const SEM = 7 * 24 * 3600 * 1000;
  const out = new Map();
  for (let t = desde; t < hasta; t += SEM) {
    const url = `https://services.leadconnectorhq.com/calendars/blocked-slots?locationId=${locationId}&calendarId=${calendarId}&startTime=${t}&endTime=${Math.min(t + SEM, hasta)}`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) continue;
    const d = await r.json();
    for (const e of (d.events || d.blockedSlots || [])) out.set(e.id, e);
  }
  return [...out.values()];
}

(async () => {
  const desdeISO = process.argv[2] || '2026-07-01';
  const hastaISO = process.argv[3] || '2026-12-31';
  const desde = Date.parse(`${desdeISO}T00:00:00Z`);
  const hasta = Date.parse(`${hastaISO}T23:59:59Z`);

  await zoho.getZohoAccessToken();
  if (!(await zoho.getDisponibilidad(desdeISO)).length &&
      !(await zoho.getDisponibilidad(new Date(desde + 86400000).toISOString().slice(0, 10))).length) {
    console.error('\nABORTADO: Zoho no devolvió citas en los dos primeros días. Casi seguro rate limit.');
    process.exit(1);
  }

  // Cuántos bloqueos tiene Zoho de cada (inicio|fin) por calendario.
  const cuentaZoho = new Map();
  for (let t = desde; t <= hasta; t += 86400000) {
    for (const c of await zoho.getDisponibilidad(new Date(t).toISOString().slice(0, 10))) {
      const destino = CALENDARIOS[c.Consultor?.ID || ''];
      if (!destino || c.Contacto?.display_value) continue;   // sólo bloqueos
      const k = `${destino[0]}|${c.Inicio}|${c.Fin}`;
      cuentaZoho.set(k, (cuentaZoho.get(k) || 0) + 1);
    }
  }
  console.error(`bloqueos en Zoho con calendario asignado: ${[...cuentaZoho.values()].reduce((a, b) => a + b, 0)}`);

  const aCuarentena = [];
  let conservados = 0;
  for (const [calId, nombre] of Object.values(CALENDARIOS)) {
    const grupos = new Map();
    for (const e of await bloqueosDe(calId, desde, hasta)) {
      const k = `${aZoho(e.startTime)}|${aZoho(e.endTime)}`;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(e);
    }
    for (const [k, eventos] of grupos) {
      const enZoho = cuentaZoho.get(`${calId}|${k}`) || 0;
      // Se conservan tantos como tenga Zoho, empezando por los más viejos. El
      // resto sobra: o son copias de más, o no existen en la agenda real.
      const ordenados = eventos.slice().sort((a, b) => String(a.dateAdded).localeCompare(String(b.dateAdded)));
      conservados += Math.min(enZoho, ordenados.length);
      for (const e of ordenados.slice(enZoho)) {
        aCuarentena.push({
          eventId: e.id, title: e.title, startTime: e.startTime, endTime: e.endTime,
          desde: calId, calendario: nombre,
          motivo: enZoho ? `Zoho tiene ${enZoho}, GHL ${ordenados.length}` : 'no existe en Zoho',
        });
      }
    }
  }

  const porCal = {}, porMotivo = {};
  for (const x of aCuarentena) {
    porCal[x.calendario] = (porCal[x.calendario] || 0) + 1;
    const m = x.motivo.startsWith('Zoho tiene') ? 'copia de más' : x.motivo;
    porMotivo[m] = (porMotivo[m] || 0) + 1;
  }
  console.log(`\nRANGO ${desdeISO} .. ${hastaISO}\n`);
  console.log(`  BLOQUEOS QUE SE CONSERVAN: ${conservados}`);
  console.log(`  BLOQUEOS A CUARENTENA    : ${aCuarentena.length}`);
  for (const [m, n] of Object.entries(porMotivo).sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(4)}  ${m}`);
  console.log('\n  por calendario:');
  for (const [c, n] of Object.entries(porCal).sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(4)}  ${c}`);

  fs.writeFileSync(SALIDA, JSON.stringify({ generado: new Date().toISOString(), desdeISO, hastaISO, aCuarentena }, null, 2));
  console.log(`\nplan-cuarentena-bloqueos.json escrito. NADA fue modificado.`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
