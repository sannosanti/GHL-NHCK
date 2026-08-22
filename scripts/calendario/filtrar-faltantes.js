// Filtra plan-faltantes.json dejando SOLO lo que tiene el horario realmente
// libre en el calendario destino.
//
// plan-faltantes empareja por el nombre del paciente en el título y mira
// únicamente citas. Eso da falsos faltantes: la clínica marca "Bloqueo - pago
// pendiente de victoria" en el horario de Isabel Victoria, y como el título no
// se parece al nombre, la cita figura como ausente. Crearla pondría dos cosas
// encima en la misma franja.
//
// Criterio: si en el calendario destino ya hay CUALQUIER evento —cita o
// bloqueo— que empieza en ese minuto exacto, no se crea nada y se reporta.
// Preferimos crear de menos: un hueco se ve y se llena, un duplicado ensucia la
// agenda del terapeuta y nadie sabe cuál de los dos vale.
//
//   node scripts/calendario/filtrar-faltantes.js
const fs = require('fs');
const path = require('path');
const { parseZohoDateTime } = require('../../webhooks/zoho');

const BASE = __dirname;
const plan = require(path.join(BASE, 'plan-faltantes.json'));
const H = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-04-15' };
const loc = process.env.GHL_LOCATION_ID;
const dormir = ms => new Promise(r => setTimeout(r, ms));

// GHL devuelve 401 y 429 cuando se le pide demasiado seguido, no sólo cuando la
// credencial está mal. Reintentar con espera creciente lo resuelve; abortar el
// recorrido entero por un 401 aislado obligaría a repetir todo.
async function traer(url, intentos = 4) {
  for (let i = 1; i <= intentos; i++) {
    const r = await fetch(url, { headers: H });
    if (r.ok) return r.json();
    if (i === intentos) throw new Error(`HTTP ${r.status} tras ${intentos} intentos`);
    await dormir(2000 * i);
  }
}

async function ocupado(calendarId, ms) {
  const encontrados = [];
  for (const ruta of ['events', 'blocked-slots']) {
    const d = await traer(`https://services.leadconnectorhq.com/calendars/${ruta}?locationId=${loc}&calendarId=${calendarId}&startTime=${ms - 60000}&endTime=${ms + 60000}`);
    await dormir(500);
    for (const e of (d.events || d.blockedSlots || [])) {
      if (Date.parse(e.startTime) === ms) encontrados.push(e.title);
    }
  }
  return encontrados;
}

(async () => {
  const libres = { crearCitas: [], crearBloqueos: [] };
  const ocupados = [], ilegibles = [];
  const lotes = [['crearCitas', plan.crearCitas || []], ['crearBloqueos', plan.crearBloqueos || []]];

  let n = 0, total = lotes.reduce((s, [, xs]) => s + xs.length, 0);
  for (const [clave, xs] of lotes) {
    for (const x of xs) {
      n++;
      const ms = Date.parse(parseZohoDateTime(x.inicio) || '');
      if (!Number.isFinite(ms)) { ilegibles.push(x); continue; }
      const hay = await ocupado(x.calendarId, ms);
      if (hay.length) ocupados.push({ ...x, ocupadoPor: hay });
      else libres[clave].push(x);
      if (n % 20 === 0) console.error(`  ${n}/${total}`);
    }
  }

  fs.writeFileSync(path.join(BASE, 'plan-faltantes-filtrado.json'),
    JSON.stringify({ generado: new Date().toISOString(), desdeISO: plan.desdeISO, hastaISO: plan.hastaISO, ...libres }, null, 2));

  console.log(`\nDel plan original (${total}):`);
  console.log(`  horario LIBRE, se pueden crear : ${libres.crearCitas.length} citas + ${libres.crearBloqueos.length} bloqueos`);
  console.log(`  horario YA OCUPADO, se omiten  : ${ocupados.length}`);
  console.log(`  hora ilegible en Zoho          : ${ilegibles.length}`);

  console.log('\nOmitidos por horario ocupado:');
  for (const o of ocupados.slice(0, 40)) {
    console.log(`  ${o.inicio}  ${(o.contacto || o.titulo || '').slice(0, 30).padEnd(32)} ya hay: ${o.ocupadoPor.join(' / ').slice(0, 60)}`);
  }
  if (ocupados.length > 40) console.log(`  ... y ${ocupados.length - 40} más`);
  if (ilegibles.length) {
    console.log('\nCon hora ilegible en Zoho (hay que corregirlos allá):');
    for (const x of ilegibles) console.log(`  ${x.inicio} -> ${x.fin}  ${(x.contacto || x.titulo || '').slice(0, 40)}`);
  }
  console.log('\nplan-faltantes-filtrado.json escrito. NADA fue creado.');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
