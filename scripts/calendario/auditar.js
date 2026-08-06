// Reconciliación Zoho -> GHL. Solo lectura.
//
// Recorre las citas de Zoho en un rango y, para cada una, verifica que exista el
// evento correspondiente en el calendario del consultor que dice Zoho. Clasifica
// cada cita en OK, FALTA (nunca llegó a GHL) o MAL_RUTEADA (está en GHL pero en
// otro calendario).
//
// El emparejamiento se hace por NOMBRE DE CONTACTO + hora de inicio, no por hora
// sola. Esa es justamente la debilidad que tuvo la migración: cuando varias citas
// comparten Inicio y Fin, la hora no alcanza para distinguirlas.
//
//   node scripts/calendario/auditar.js 2026-08-09 2026-08-16
const zoho = require('../../services/zoho');

const key = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15' };

const GENERAL = 'lzwahRhkogIG1Ct9BX7p';
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
const NOMBRE_CAL = Object.fromEntries(
  Object.values(CALENDARIOS).map(([id, n]) => [id, n]).concat([[GENERAL, 'General']])
);

const MESES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const normalizar = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

function inicioZohoDesdeGHL(t) {
  const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, yyyy, mm, dd, hh, mi, ss] = m;
  return `${dd}-${MESES[Number(mm) - 1]}-${yyyy} ${hh}:${mi}:${ss}`;
}

// "Presencial - Juan Pérez" / "Cita - Juan Pérez" -> "Juan Pérez"
const nombreDeTitulo = t => normalizar(String(t || '').split(' - ').slice(1).join(' - '));

async function eventosDe(calendarId, desde, hasta) {
  const SEM = 7 * 24 * 3600 * 1000;
  const out = new Map();
  for (let t = desde; t < hasta; t += SEM) {
    const url = `https://services.leadconnectorhq.com/calendars/events?locationId=${locationId}&calendarId=${calendarId}&startTime=${t}&endTime=${Math.min(t + SEM, hasta)}`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) continue;
    const d = await r.json();
    for (const e of d.events || []) out.set(e.id, e);
  }
  return [...out.values()];
}

(async () => {
  const desdeISO = process.argv[2] || '2026-08-09';
  const hastaISO = process.argv[3] || '2026-08-16';
  const desde = Date.parse(`${desdeISO}T00:00:00Z`);
  const hasta = Date.parse(`${hastaISO}T23:59:59Z`);

  // Índice de todo lo que hay en GHL: nombre+inicio -> [calendarios donde aparece]
  const indice = new Map();
  for (const calId of [...Object.values(CALENDARIOS).map(c => c[0]), GENERAL]) {
    for (const e of await eventosDe(calId, desde, hasta)) {
      const clave = `${nombreDeTitulo(e.title)}|${inicioZohoDesdeGHL(e.startTime)}`;
      if (!indice.has(clave)) indice.set(clave, []);
      indice.get(clave).push({ calendarId: calId, id: e.id, title: e.title });
    }
  }

  const resultados = { ok: [], falta: [], malRuteada: [], sinConsultor: [] };
  // Lo que Zoho respalda, para poder preguntar también al revés: qué hay en GHL
  // que Zoho no justifica.
  const respaldadoPorZoho = new Set();

  for (let t = desde; t <= hasta; t += 24 * 3600 * 1000) {
    const dia = new Date(t).toISOString().slice(0, 10);
    for (const c of await zoho.getDisponibilidad(dia)) {
      const contacto = c.Contacto?.display_value;
      if (!contacto) continue;                       // los bloqueos se auditan aparte
      const destino = CALENDARIOS[c.Consultor?.ID || ''];
      if (!destino) { resultados.sinConsultor.push({ zohoID: c.ID, contacto, inicio: c.Inicio }); continue; }
      respaldadoPorZoho.add(`${normalizar(contacto)}|${c.Inicio}|${destino[0]}`);

      const encontrados = indice.get(`${normalizar(contacto)}|${c.Inicio}`) || [];
      const registro = { zohoID: c.ID, contacto, inicio: c.Inicio, esperado: destino[1] };
      if (!encontrados.length) resultados.falta.push(registro);
      else if (encontrados.some(e => e.calendarId === destino[0])) resultados.ok.push(registro);
      else resultados.malRuteada.push({ ...registro, estaEn: encontrados.map(e => NOMBRE_CAL[e.calendarId] || e.calendarId).join(', ') });
    }
  }

  // Dirección inversa. Un evento en GHL sin cita que lo respalde en ese
  // calendario es basura: quedó de un ruteo viejo, o el webhook lo creó dos
  // veces. Es lo que se ve como citas apiladas en la vista semanal.
  const sobrantes = [], duplicados = [];
  for (const [clave, eventos] of indice) {
    for (const e of eventos) {
      if (e.calendarId === GENERAL) continue;        // General ya se reporta aparte
      if (!respaldadoPorZoho.has(`${clave}|${e.calendarId}`)) {
        sobrantes.push({ calendario: NOMBRE_CAL[e.calendarId] || e.calendarId, title: e.title, clave, id: e.id });
      }
    }
    const porCalendario = {};
    for (const e of eventos) porCalendario[e.calendarId] = (porCalendario[e.calendarId] || 0) + 1;
    for (const [cal, n] of Object.entries(porCalendario)) {
      if (n > 1) duplicados.push({ calendario: NOMBRE_CAL[cal] || cal, clave, veces: n });
    }
  }
  resultados.sobrantes = sobrantes;
  resultados.duplicados = duplicados;

  console.log(`\nRANGO ${desdeISO} .. ${hastaISO}\n`);
  console.log(`  OK            ${resultados.ok.length}`);
  console.log(`  MAL RUTEADAS  ${resultados.malRuteada.length}`);
  console.log(`  FALTAN        ${resultados.falta.length}`);
  console.log(`  SIN CONSULTOR ${resultados.sinConsultor.length}`);
  console.log(`  SOBRANTES     ${resultados.sobrantes.length}   (en GHL sin respaldo en Zoho)`);
  console.log(`  DUPLICADOS    ${resultados.duplicados.length}   (mismo contacto y hora repetido en un calendario)`);

  if (resultados.duplicados.length) {
    console.log('\n=== DUPLICADOS ===');
    for (const d of resultados.duplicados.slice(0, 30)) console.log(`  x${d.veces}  ${d.calendario.padEnd(24)} ${d.clave}`);
  }
  if (resultados.sobrantes.length) {
    console.log('\n=== SOBRANTES (GHL los tiene, Zoho no los respalda ahí) ===');
    for (const s of resultados.sobrantes.slice(0, 40)) console.log(`  ${s.calendario.padEnd(24)} ${s.title}  [${s.clave.split('|')[1]}]`);
  }

  if (resultados.malRuteada.length) {
    console.log('\n=== MAL RUTEADAS (están en GHL, en el calendario equivocado) ===');
    for (const r of resultados.malRuteada.slice(0, 40)) {
      console.log(`  ${r.inicio}  ${r.contacto}\n      debería: ${r.esperado}   |   está en: ${r.estaEn}`);
    }
  }
  if (resultados.falta.length) {
    console.log('\n=== FALTAN EN GHL (nunca llegaron) ===');
    for (const r of resultados.falta.slice(0, 40)) {
      console.log(`  ${r.inicio}  ${r.contacto}   -> ${r.esperado}`);
    }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
