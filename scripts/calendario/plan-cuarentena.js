// DRY RUN. Solo lectura. Lista lo que sobra en los calendarios de terapeuta y
// escribe plan-cuarentena.json.
//
// Sobra un evento cuando Zoho no tiene una cita que lo respalde en ese
// calendario. Son restos de dos épocas: el ruteo viejo que mandaba todo al
// General, y los disparos repetidos del botón "Replicar" antes de que el sync
// fuera idempotente.
//
// De cada grupo de eventos idénticos se conserva UNO. Nunca se vacía un grupo:
// si Zoho respalda esa cita, tiene que quedar exactamente una copia en pie.
//
//   node scripts/calendario/plan-cuarentena.js 2026-07-01 2026-12-31
const fs = require('fs');
const path = require('path');
const zoho = require('../../services/zoho');

const key = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15' };
const SALIDA = path.join(__dirname, 'plan-cuarentena.json');

const GENERAL = 'lzwahRhkogIG1Ct9BX7p';
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
const NOMBRE_CAL = Object.fromEntries(Object.values(CALENDARIOS).map(([id, n]) => [id, n]));

const MESES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const nombreDeTitulo = t => norm(String(t || '').split(' - ').slice(1).join(' - '));
const aZoho = t => {
  const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[3]}-${MESES[+m[2] - 1]}-${m[1]} ${m[4]}:${m[5]}:${m[6]}` : null;
};

async function eventosDe(calendarId, desde, hasta) {
  const SEM = 7 * 24 * 3600 * 1000;
  const out = new Map();
  for (let t = desde; t < hasta; t += SEM) {
    const url = `https://services.leadconnectorhq.com/calendars/events?locationId=${locationId}&calendarId=${calendarId}&startTime=${t}&endTime=${Math.min(t + SEM, hasta)}`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) continue;
    for (const e of (await r.json()).events || []) out.set(e.id, e);
  }
  return [...out.values()];
}

(async () => {
  const desdeISO = process.argv[2] || '2026-07-01';
  const hastaISO = process.argv[3] || '2026-12-31';
  const desde = Date.parse(`${desdeISO}T00:00:00Z`);
  const hasta = Date.parse(`${hastaISO}T23:59:59Z`);

  // Mismo resguardo que el resto: si Zoho no contesta, el plan saldría diciendo
  // que sobra todo. Peor imposible.
  await zoho.getZohoAccessToken();
  if (!(await zoho.getDisponibilidad(desdeISO)).length &&
      !(await zoho.getDisponibilidad(new Date(desde + 86400000).toISOString().slice(0, 10))).length) {
    console.error('\nABORTADO: Zoho no devolvió citas en los dos primeros días. Casi seguro rate limit.');
    process.exit(1);
  }

  // Dos índices, y la diferencia entre ambos es lo que evita un desastre.
  //
  // `respaldado` empareja por contacto + hora + calendario: es el criterio
  // preciso. Pero los eventos que dejó una versión vieja del sync se titularon
  // con un contacto genérico ("Neuromapeo - NHC Kids") en vez del nombre del
  // paciente, así que no matchean aunque correspondan a una cita real. Con sólo
  // ese índice, el plan mandaba a cuarentena 116 citas verdaderas.
  //
  // `ocupado` empareja apenas por consultor + hora. Es más laxo, y justamente por
  // eso sirve de red: si Zoho tiene algo para ese profesional a esa hora exacta,
  // el evento probablemente le corresponde y no se toca. Se prefiere dejar
  // basura visible antes que esconder una cita real.
  const respaldado = new Set();
  const ocupado = new Set();
  for (let t = desde; t <= hasta; t += 86400000) {
    for (const c of await zoho.getDisponibilidad(new Date(t).toISOString().slice(0, 10))) {
      const destino = CALENDARIOS[c.Consultor?.ID || ''];
      if (!destino) continue;
      const contacto = c.Contacto?.display_value;
      // La red sólo cubre citas con paciente. Un evento de GHL titulado con el
      // nombre de alguien no puede corresponder a un Bloqueo, una Salida ni un
      // Festivo: si Zoho sólo tiene eso a esa hora, el evento está de más y
      // protegerlo era esconder el error en vez de corregirlo. Es lo que la
      // clínica reportó el 2026-08-06 como "citas trocadas" en el calendario de
      // Juan Esteban.
      if (!contacto) continue;
      ocupado.add(`${c.Inicio}|${destino[0]}`);
      respaldado.add(`${norm(contacto)}|${c.Inicio}|${destino[0]}`);
    }
  }
  console.error(`citas de Zoho con calendario asignado: ${respaldado.size} (franjas ocupadas: ${ocupado.size})`);

  const aCuarentena = [], aRevisar = [];
  let conservados = 0;
  for (const [calId, nombre] of Object.values(CALENDARIOS)) {
    const grupos = new Map();
    for (const e of await eventosDe(calId, desde, hasta)) {
      const clave = `${nombreDeTitulo(e.title)}|${aZoho(e.startTime)}`;
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push(e);
    }
    for (const [clave, eventos] of grupos) {
      const inicio = clave.split('|')[1];
      const ordenados = eventos.slice().sort((a, b) => String(a.dateAdded).localeCompare(String(b.dateAdded)));

      if (respaldado.has(`${clave}|${calId}`)) {
        // Zoho lo respalda con nombre y hora: queda uno, sobran las copias.
        conservados++;
        for (const e of ordenados.slice(1)) {
          aCuarentena.push({ eventId: e.id, title: e.title, startTime: e.startTime, desde: calId, calendario: nombre, motivo: 'copia duplicada' });
        }
        continue;
      }
      if (ocupado.has(`${inicio}|${calId}`)) {
        // El nombre no coincide pero el profesional sí tiene algo a esa hora. Es
        // ambiguo, así que no se toca: se lista aparte para que lo mire alguien.
        for (const e of ordenados) {
          aRevisar.push({ eventId: e.id, title: e.title, startTime: e.startTime, calendario: nombre, motivo: 'el nombre no coincide pero Zoho tiene cita a esa hora' });
        }
        continue;
      }
      for (const e of ordenados) {
        aCuarentena.push({ eventId: e.id, title: e.title, startTime: e.startTime, desde: calId, calendario: nombre, motivo: 'sin nada en Zoho a esa hora' });
      }
    }
  }

  const porMotivo = {}, porCal = {};
  for (const x of aCuarentena) {
    porMotivo[x.motivo] = (porMotivo[x.motivo] || 0) + 1;
    porCal[x.calendario] = (porCal[x.calendario] || 0) + 1;
  }
  console.log(`\nRANGO ${desdeISO} .. ${hastaISO}\n`);
  console.log(`  SE CONSERVAN (respaldados por Zoho): ${conservados}`);
  console.log(`  A REVISAR A MANO (no se tocan)     : ${aRevisar.length}`);
  console.log(`  A CUARENTENA                       : ${aCuarentena.length}`);
  for (const [m, n] of Object.entries(porMotivo).sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(4)}  ${m}`);
  console.log('\n  por calendario:');
  for (const [c, n] of Object.entries(porCal).sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(4)}  ${c}`);

  fs.writeFileSync(SALIDA, JSON.stringify({ generado: new Date().toISOString(), desdeISO, hastaISO, aCuarentena, aRevisar }, null, 2));
  console.log(`\nplan-cuarentena.json escrito. NADA fue modificado.`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
