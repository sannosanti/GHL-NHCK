// Mueve al calendario correcto las citas que auditar.js marcó como mal ruteadas.
// Lee plan-ruteo.json, así que ejecuta exactamente lo que se revisó en el informe.
//
// Estas son las que la migración de agosto colocó mal: comparaba por hora de
// inicio con el contacto vacío, y cuando varias citas compartían Inicio y Fin el
// desempate por Added_Time podía elegir el consultor equivocado. auditar.js las
// detecta comparando por contacto, que es lo que las distingue de verdad.
//
//   node scripts/calendario/auditar.js 2026-07-01 2026-10-31   (genera el plan)
//   node scripts/calendario/corregir-ruteo.js                  (lo aplica)
const fs = require('fs');
const path = require('path');

const key = process.env.GHL_API_KEY;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15', 'Content-Type': 'application/json' };
const BASE = __dirname;
const plan = require(path.join(BASE, 'plan-ruteo.json'));
const registro = path.join(BASE, 'ruteo-corregido.ndjson');

const dormir = ms => new Promise(r => setTimeout(r, ms));
const anotar = o => fs.appendFileSync(registro, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');

(async () => {
  console.log(`Plan: ${plan.aCorregir.length} citas mal ruteadas\n`);
  let movidos = 0, saltados = 0, fallidos = 0;

  for (const [i, c] of plan.aCorregir.entries()) {
    const prefijo = `[${i + 1}/${plan.aCorregir.length}]`;
    // Sólo se toca el evento que está en un calendario distinto al que Zoho
    // indica. Si el contacto tiene además una cita legítima en otro calendario,
    // esa se deja donde está.
    const equivocados = c.eventos.filter(e => e.calendarId !== c.calendarDestino);
    if (!equivocados.length) {
      saltados++;
      console.log(`${prefijo} YA OK    ${c.contacto}`);
      continue;
    }

    for (const ev of equivocados) {
      try {
        const g = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${ev.id}`, { headers: H });
        if (!g.ok) throw new Error(`GET ${g.status}`);
        const actual = (await g.json()).appointment || {};
        await dormir(350);

        const r = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${ev.id}`, {
          method: 'PUT', headers: H,
          body: JSON.stringify({
            calendarId: c.calendarDestino,
            startTime: actual.startTime, endTime: actual.endTime, title: actual.title,
            appointmentStatus: actual.appointmentStatus || 'confirmed',
            toNotify: false,                 // verificado: no le llega nada al paciente
            ignoreFreeSlotValidation: true, ignoreDateRange: true,
          }),
        });
        if (!r.ok) throw new Error(`PUT ${r.status}`);
        movidos++;
        console.log(`${prefijo} MOVIDO   ${c.contacto}  ${ev.calendario} -> ${c.esperado}`);
        anotar({ eventId: ev.id, contacto: c.contacto, desde: ev.calendarId, hacia: c.calendarDestino, esperado: c.esperado });
        await dormir(350);
      } catch (err) {
        fallidos++;
        console.error(`${prefijo} FALLO    ${c.contacto} — ${err.message}`);
        anotar({ eventId: ev.id, estado: 'fallo', error: err.message });
        await dormir(1000);
      }
    }
  }

  console.log(`\n--- RESUMEN ---\nmovidos:  ${movidos}\nsaltados: ${saltados}\nfallidos: ${fallidos}`);
})().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
