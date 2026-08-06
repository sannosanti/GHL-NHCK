// Mueve a un calendario de cuarentena lo que plan-cuarentena.json marcó como
// sobrante. NO borra nada: los eventos quedan enteros, fuera de la vista de los
// terapeutas y recuperables uno por uno desde cuarentena.ndjson, que guarda de
// qué calendario salió cada uno.
//
// Necesita el id del calendario destino, que hay que crear a mano en GHL --
// crear calendarios es configuración de la cuenta del cliente, no algo que este
// script deba decidir.
//
//   node scripts/calendario/mover-a-cuarentena.js <calendarIdCuarentena> [--limite 1]
const fs = require('fs');
const path = require('path');

const key = process.env.GHL_API_KEY;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15', 'Content-Type': 'application/json' };
const BASE = __dirname;
const plan = require(path.join(BASE, 'plan-cuarentena.json'));
const registro = path.join(BASE, 'cuarentena.ndjson');

const args = process.argv.slice(2);
const CUARENTENA = args.find(a => !a.startsWith('--'));
const limite = args.includes('--limite') ? Number(args[args.indexOf('--limite') + 1]) : Infinity;
const PAUSA = 350;
const CORTE_FALLOS = 5;

if (!CUARENTENA) {
  console.error('Falta el id del calendario de cuarentena.');
  console.error('Creá uno en GHL (Calendarios > Nuevo, tipo "event") y pasá su id:');
  console.error('  node scripts/calendario/mover-a-cuarentena.js <calendarId> --limite 1');
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

(async () => {
  const pendientes = plan.aCuarentena.filter(x => !yaMovidos.has(x.eventId)).slice(0, limite);
  console.log(`Plan: ${plan.aCuarentena.length} | ya movidos: ${yaMovidos.size} | ahora: ${pendientes.length}`);
  console.log(`Destino: ${CUARENTENA}\n`);

  let movidos = 0, fallidos = 0, saltados = 0, seguidilla = 0;
  for (const [i, x] of pendientes.entries()) {
    const prefijo = `[${String(i + 1).padStart(4)}/${pendientes.length}]`;
    try {
      const g = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${x.eventId}`, { headers: H });
      if (!g.ok) throw new Error(`GET ${g.status}`);
      const actual = (await g.json()).appointment || {};
      await dormir(PAUSA);

      if (actual.calendarId === CUARENTENA) {
        saltados++;
        console.log(`${prefijo} YA OK    ${x.title}`);
        anotar({ eventId: x.eventId, estado: 'ya-estaba' });
        continue;
      }
      if (actual.calendarId !== x.desde) {
        // Se movió por otra vía desde que se armó el plan. No se pisa.
        saltados++;
        console.log(`${prefijo} SALTADO  ${x.title} — ya no está en ${x.calendario}`);
        anotar({ eventId: x.eventId, estado: 'saltado-cambio-calendario', calendarActual: actual.calendarId });
        continue;
      }

      const r = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${x.eventId}`, {
        method: 'PUT', headers: H,
        body: JSON.stringify({
          calendarId: CUARENTENA,
          startTime: actual.startTime, endTime: actual.endTime, title: actual.title,
          appointmentStatus: actual.appointmentStatus || 'confirmed',
          toNotify: false,               // verificado: el paciente no recibe nada
          ignoreFreeSlotValidation: true, ignoreDateRange: true,
        }),
      });
      if (!r.ok) throw new Error(`PUT ${r.status}`);
      movidos++; seguidilla = 0;
      console.log(`${prefijo} MOVIDO   ${x.calendario.padEnd(22)} ${x.title}  [${x.motivo}]`);
      // desde: adónde devolverlo si hubo que revertir.
      anotar({ eventId: x.eventId, estado: 'movido', desde: x.desde, calendario: x.calendario, title: x.title, motivo: x.motivo });
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

  console.log(`\n--- RESUMEN ---\nmovidos:  ${movidos}\nsaltados: ${saltados}\nfallidos: ${fallidos}`);
  console.log('\nNada fue borrado. cuarentena.ndjson guarda de qué calendario salió cada evento.');
})().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
