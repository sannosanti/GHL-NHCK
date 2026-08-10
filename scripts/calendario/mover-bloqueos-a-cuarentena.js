// Mueve a cuarentena los bloqueos que plan-cuarentena-bloqueos.json marcó como
// sobrantes. No borra: quedan enteros en el calendario de cuarentena y
// cuarentena-bloqueos.ndjson guarda de cuál salió cada uno.
//
// Los bloqueos no tienen GET individual, así que en lugar de releer cada uno se
// lista el calendario de origen por día y se comprueba pertenencia. Igual de
// seguro y una llamada por jornada en vez de una por bloqueo.
//
//   node scripts/calendario/mover-bloqueos-a-cuarentena.js <calendarIdCuarentena> [--limite 1]
const fs = require('fs');
const path = require('path');

const key = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15', 'Content-Type': 'application/json' };
const BASE = __dirname;
const plan = require(path.join(BASE, 'plan-cuarentena-bloqueos.json'));
const registro = path.join(BASE, 'cuarentena-bloqueos.ndjson');

const args = process.argv.slice(2);
const CUARENTENA = args.find(a => !a.startsWith('--'));
const limite = args.includes('--limite') ? Number(args[args.indexOf('--limite') + 1]) : Infinity;
const PAUSA = 350;
const CORTE_FALLOS = 5;

if (!CUARENTENA) {
  console.error('Falta el id del calendario de cuarentena.');
  process.exit(1);
}

const dormir = ms => new Promise(r => setTimeout(r, ms));
const anotar = o => fs.appendFileSync(registro, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');

const yaMovidos = new Set();
if (fs.existsSync(registro)) {
  for (const l of fs.readFileSync(registro, 'utf8').trim().split('\n')) {
    if (!l) continue;
    const o = JSON.parse(l);
    if (o.estado === 'movido') yaMovidos.add(o.eventId);
  }
}

async function bloqueosDelDia(calendarId, iso) {
  const desde = Date.parse(`${iso}T00:00:00Z`) - 12 * 3600 * 1000;
  const hasta = Date.parse(`${iso}T23:59:59Z`) + 12 * 3600 * 1000;
  const url = `https://services.leadconnectorhq.com/calendars/blocked-slots?locationId=${locationId}&calendarId=${calendarId}&startTime=${desde}&endTime=${hasta}`;
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`GET ${r.status}`);
  const d = await r.json();
  return new Map((d.events || d.blockedSlots || []).map(b => [b.id, b]));
}

(async () => {
  const pendientes = plan.aCuarentena.filter(x => !yaMovidos.has(x.eventId)).slice(0, limite);
  console.log(`Plan: ${plan.aCuarentena.length} | ya movidos: ${yaMovidos.size} | ahora: ${pendientes.length}`);
  console.log(`Destino: ${CUARENTENA}\n`);

  // Agrupado por día y calendario para no listar lo mismo muchas veces.
  const porDiaCal = new Map();
  for (const x of pendientes) {
    const k = `${String(x.startTime).slice(0, 10)}|${x.desde}`;
    if (!porDiaCal.has(k)) porDiaCal.set(k, []);
    porDiaCal.get(k).push(x);
  }

  let movidos = 0, saltados = 0, fallidos = 0, seguidilla = 0, n = 0;
  for (const [k, lista] of porDiaCal) {
    const [iso, calId] = k.split('|');
    let presentes;
    try { presentes = await bloqueosDelDia(calId, iso); await dormir(PAUSA); }
    catch (err) {
      for (const x of lista) { fallidos++; anotar({ eventId: x.eventId, estado: 'fallo', error: `listado ${iso}: ${err.message}` }); }
      console.error(`  ${iso}: no se pudo listar — ${err.message}`);
      continue;
    }

    for (const x of lista) {
      n++;
      const prefijo = `[${String(n).padStart(4)}/${pendientes.length}]`;
      const b = presentes.get(x.eventId);
      if (!b) {
        saltados++;
        console.log(`${prefijo} YA OK    ${x.calendario.padEnd(22)} ${x.title}`);
        anotar({ eventId: x.eventId, estado: 'ya-estaba' });
        continue;
      }
      try {
        const r = await fetch(`https://services.leadconnectorhq.com/calendars/events/block-slots/${x.eventId}`, {
          method: 'PUT', headers: H,
          body: JSON.stringify({
            calendarId: CUARENTENA,
            startTime: b.startTime, endTime: b.endTime, title: b.title,
          }),
        });
        if (!r.ok) throw new Error(`PUT ${r.status}`);
        movidos++; seguidilla = 0;
        console.log(`${prefijo} MOVIDO   ${x.calendario.padEnd(22)} ${String(x.startTime).slice(0, 16).replace('T', ' ')}  ${x.title}  [${x.motivo}]`);
        anotar({ eventId: x.eventId, estado: 'movido', desde: x.desde, calendario: x.calendario, title: x.title, startTime: b.startTime, endTime: b.endTime, motivo: x.motivo });
        await dormir(PAUSA);
      } catch (err) {
        fallidos++; seguidilla++;
        console.error(`${prefijo} FALLO    ${x.title} — ${err.message}`);
        anotar({ eventId: x.eventId, estado: 'fallo', error: err.message });
        if (seguidilla >= CORTE_FALLOS) {
          console.error(`\nABORTADO: ${CORTE_FALLOS} fallos seguidos. Movidos: ${movidos}.`);
          process.exit(1);
        }
        await dormir(PAUSA * 3);
      }
    }
  }

  console.log(`\n--- RESUMEN ---\nmovidos:  ${movidos}\nsaltados: ${saltados}\nfallidos: ${fallidos}`);
  console.log('\nNada fue borrado. cuarentena-bloqueos.ndjson guarda el origen de cada uno.');
})().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
