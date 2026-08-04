// Moves the remaining misrouted events out of General into each therapist's
// calendar, following plan.json exactly.
//
// Safe to re-run. Every event is re-read first: anything already at its
// destination is skipped, and anything sitting in a calendar other than General
// is left alone rather than clobbered. Progress is appended to resultados.ndjson
// line by line, so a crash halfway through loses nothing and the next run picks
// up where it stopped.
const fs = require('fs');

const key = process.env.GHL_API_KEY;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15', 'Content-Type': 'application/json' };
const BASE = __dirname;
const GENERAL = 'lzwahRhkogIG1Ct9BX7p';

const plan = require(`${BASE}/plan.json`).plan;
const registro = `${BASE}/resultados.ndjson`;
const PAUSA = 350;          // ms between calls, to stay clear of GHL's rate limit
const CORTE_FALLOS = 5;     // consecutive failures that abort the run

const dormir = ms => new Promise(r => setTimeout(r, ms));
const anotar = o => fs.appendFileSync(registro, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');

async function leerEvento(id) {
  const r = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${id}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${r.status}`);
  const d = await r.json();
  return d.event || d.appointment || d;
}

async function mover(evento, hacia) {
  const r = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${evento.id}`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({
      calendarId: hacia,
      // Resent unchanged: a PUT that omits these can blank them out, and these
      // are real patients' appointments.
      startTime: evento.startTime,
      endTime: evento.endTime,
      title: evento.title,
      appointmentStatus: evento.appointmentStatus || 'confirmed',
      toNotify: false,          // verified on the canary: no message reaches the patient
      ignoreFreeSlotValidation: true,
      ignoreDateRange: true,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PUT ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}

(async () => {
  console.log(`Plan: ${plan.length} eventos. Registro: resultados.ndjson\n`);
  let movidos = 0, saltados = 0, fallidos = 0, seguidillaFallos = 0;

  for (const [i, p] of plan.entries()) {
    const prefijo = `[${String(i + 1).padStart(3)}/${plan.length}]`;
    try {
      const ev = await leerEvento(p.eventId);
      await dormir(PAUSA);

      if (ev.calendarId === p.hacia) {
        saltados++;
        console.log(`${prefijo} YA OK    ${p.terapeuta.padEnd(24)} ${p.title}`);
        anotar({ eventId: p.eventId, estado: 'ya-estaba', hacia: p.hacia });
        continue;
      }
      if (ev.calendarId !== GENERAL) {
        saltados++;
        console.log(`${prefijo} SALTADO  no está en General (${ev.calendarId}) — ${p.title}`);
        anotar({ eventId: p.eventId, estado: 'saltado-otro-calendario', calendarActual: ev.calendarId });
        continue;
      }

      await mover(ev, p.hacia);
      movidos++;
      seguidillaFallos = 0;
      console.log(`${prefijo} MOVIDO   ${p.terapeuta.padEnd(24)} ${p.title}`);
      // desde: what to send back on a rollback.
      anotar({ eventId: p.eventId, estado: 'movido', desde: GENERAL, hacia: p.hacia, terapeuta: p.terapeuta, title: p.title });
      await dormir(PAUSA);
    } catch (err) {
      fallidos++;
      seguidillaFallos++;
      console.error(`${prefijo} FALLO    ${p.title} — ${err.message}`);
      anotar({ eventId: p.eventId, estado: 'fallo', error: err.message, hacia: p.hacia });
      if (seguidillaFallos >= CORTE_FALLOS) {
        console.error(`\nABORTADO: ${CORTE_FALLOS} fallos seguidos. Ya movidos: ${movidos}. Corregí la causa y volvé a correr — los movidos se saltan solos.`);
        process.exit(1);
      }
      await dormir(PAUSA * 3);
    }
  }

  console.log(`\n--- RESUMEN ---\nmovidos:  ${movidos}\nsaltados: ${saltados}\nfallidos: ${fallidos}`);
  if (fallidos) console.log('Volvé a correr para reintentar los fallidos; lo ya movido se salta.');
})().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
