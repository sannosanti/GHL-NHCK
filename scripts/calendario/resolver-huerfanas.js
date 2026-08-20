// Resuelve lo que está en GHL y Zoho ya no tiene, según plan-huerfanas.json.
//
// Zoho es la fuente de verdad: lo que allá no existe no debe seguir ocupando
// una agenda. Pero cada clase se resuelve distinto:
//
//   citas    -> se marcan CANCELADAS. Libera el horario, queda en la historia
//               del paciente y es reversible. Moverlas a otro calendario
//               perdería el vínculo con el contacto.
//   bloqueos -> se mueven a cuarentena. No tienen estado que marcar.
//
// Nada se borra. Todo queda anotado en huerfanas.ndjson con lo necesario para
// deshacerlo, y el script es re-ejecutable: lo ya hecho se saltea.
//
//   node scripts/calendario/resolver-huerfanas.js                (simulacro)
//   node scripts/calendario/resolver-huerfanas.js --aplicar --limite 1
//   node scripts/calendario/resolver-huerfanas.js --aplicar
const fs = require('fs');
const path = require('path');
const ghl = require('../../services/ghl');

const BASE = __dirname;
const plan = require(path.join(BASE, 'plan-huerfanas.json'));
const registro = path.join(BASE, 'huerfanas.ndjson');
const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const limite = args.includes('--limite') ? Number(args[args.indexOf('--limite') + 1]) : Infinity;
const CUARENTENA = args.includes('--cuarentena') ? args[args.indexOf('--cuarentena') + 1] : '4XVQsYDHYC13EV7EhpJ5';
const PAUSA = 350;
const CORTE_FALLOS = 5;

const dormir = ms => new Promise(r => setTimeout(r, ms));
const anotar = o => fs.appendFileSync(registro, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');

const hechos = new Set();
if (fs.existsSync(registro)) {
  for (const l of fs.readFileSync(registro, 'utf8').trim().split('\n')) {
    if (!l) continue;
    const o = JSON.parse(l);
    if (o.estado === 'cancelada' || o.estado === 'movido' || o.estado === 'ya-estaba') hechos.add(o.eventId);
  }
}

(async () => {
  const pendientes = plan.huerfanas.filter(h => !hechos.has(h.ghl_event_id)).slice(0, limite);
  console.log(`Plan del ${plan.generado} (${plan.desdeISO} .. ${plan.hastaISO})`);
  console.log(`Total: ${plan.huerfanas.length} | ya resueltas: ${hechos.size} | ahora: ${pendientes.length}\n`);

  let canceladas = 0, movidos = 0, saltados = 0, fallidos = 0, seguidilla = 0;
  for (const [i, h] of pendientes.entries()) {
    const prefijo = `[${String(i + 1).padStart(3)}/${pendientes.length}]`;
    try {
      const actual = await ghl.getCitaEnCalendario(h.ghl_event_id);
      await dormir(PAUSA);

      // La clase se decide por lo que devuelve GHL, no por la etiqueta guardada:
      // un bloqueo no trae contactId, y hay filas mal clasificadas en citas_sync.
      const esBloqueo = !actual?.contactId;

      if (esBloqueo) {
        if (!aplicar) { console.log(`${prefijo} movería a cuarentena  "${actual?.title}"`); continue; }
        await ghl.actualizarBloqueoEnCalendario({
          eventId: h.ghl_event_id, calendarId: CUARENTENA,
          startISO: actual.startTime, endISO: actual.endTime, title: actual.title,
        });
        movidos++;
        anotar({ eventId: h.ghl_event_id, estado: 'movido', desde: h.calendar_id, title: actual.title, startTime: actual.startTime, endTime: actual.endTime });
        console.log(`${prefijo} MOVIDO     "${actual.title}"`);
      } else {
        if (actual.appointmentStatus === 'cancelled') {
          saltados++;
          anotar({ eventId: h.ghl_event_id, estado: 'ya-estaba' });
          console.log(`${prefijo} YA ESTABA  "${actual.title}" ya figuraba cancelada`);
          continue;
        }
        if (!aplicar) { console.log(`${prefijo} cancelaría  "${actual.title}" (hoy: ${actual.appointmentStatus})`); continue; }
        await ghl.actualizarCitaEnCalendario({
          eventId: h.ghl_event_id, calendarId: actual.calendarId,
          startISO: actual.startTime, endISO: actual.endTime,
          title: actual.title, description: actual.description,
          contactId: actual.contactId, appointmentStatus: 'cancelled',
        });
        canceladas++;
        anotar({ eventId: h.ghl_event_id, estado: 'cancelada', calendarId: actual.calendarId, title: actual.title, startTime: actual.startTime, estadoPrevio: actual.appointmentStatus });
        console.log(`${prefijo} CANCELADA  "${actual.title}"`);
      }
      seguidilla = 0;
      await dormir(PAUSA);
    } catch (err) {
      fallidos++; seguidilla++;
      console.error(`${prefijo} FALLO ${h.ghl_event_id} — ${err.message}`);
      anotar({ eventId: h.ghl_event_id, estado: 'fallo', error: err.message });
      if (seguidilla >= CORTE_FALLOS) {
        console.error(`\nABORTADO: ${CORTE_FALLOS} fallos seguidos.`);
        process.exit(1);
      }
      await dormir(PAUSA * 3);
    }
  }

  console.log(`\n--- RESUMEN ---\ncanceladas: ${canceladas}\nbloqueos movidos: ${movidos}\nya estaban: ${saltados}\nfallidos: ${fallidos}`);
  if (!aplicar) console.log('\nSIMULACRO — nada se modificó. Volvé a correr con --aplicar.');
  else console.log('\nNada fue borrado. huerfanas.ndjson guarda el estado previo de cada una.');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
