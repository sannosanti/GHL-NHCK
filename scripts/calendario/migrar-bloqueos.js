// Moves misrouted block-slots out of General, following plan-bloqueos.json.
//
// Blocks have no single-item GET, so instead of re-reading each one the plan is
// grouped by day and General is listed once per day. Membership in that list is
// the "is it still here?" check — same skip-if-already-moved safety as the
// appointment backfill, at one call per day instead of one per block.
//
// Safe to re-run. Progress is appended to resultados-bloqueos.ndjson line by
// line, so a crash loses nothing and the next run resumes.
const fs = require('fs');
const { tituloGHL } = require('../../webhooks/zoho');

const key = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15', 'Content-Type': 'application/json' };
const BASE = __dirname;
const GENERAL = 'lzwahRhkogIG1Ct9BX7p';

const plan = require(`${BASE}/plan-bloqueos.json`).plan;
const registro = `${BASE}/resultados-bloqueos.ndjson`;
const PAUSA = 350;
const CORTE_FALLOS = 5;

const MESES = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
const dormir = ms => new Promise(r => setTimeout(r, ms));
const anotar = o => fs.appendFileSync(registro, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');

function diaISO(inicioZoho) {
  const m = String(inicioZoho).match(/^(\d{2})-(\w{3})-(\d{4})/);
  return m ? `${m[3]}-${MESES[m[2]]}-${m[1]}` : null;
}

async function listarBloqueos(calendarId, dia) {
  const desde = Date.parse(`${dia}T00:00:00Z`) - 12 * 3600 * 1000; // holgura por zona horaria
  const hasta = Date.parse(`${dia}T23:59:59Z`) + 12 * 3600 * 1000;
  const url = `https://services.leadconnectorhq.com/calendars/blocked-slots?locationId=${locationId}&calendarId=${calendarId}&startTime=${desde}&endTime=${hasta}`;
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`GET ${r.status}`);
  const d = await r.json();
  return d.events || d.blockedSlots || [];
}

async function mover(bloqueo, hacia, titulo) {
  const r = await fetch(`https://services.leadconnectorhq.com/calendars/events/block-slots/${bloqueo.id}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({
      calendarId: hacia,
      startTime: bloqueo.startTime,
      endTime: bloqueo.endTime,
      // Every block was titled a bare "Cita" because Tipo never reached the
      // webhook. The real one is restored on the way past.
      title: titulo,
    }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(`PUT ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  }
}

(async () => {
  const porDia = new Map();
  for (const p of plan) {
    const dia = diaISO(p.inicio);
    if (!dia) { anotar({ eventId: p.eventId, estado: 'fallo', error: 'inicio ilegible' }); continue; }
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(p);
  }
  const dias = [...porDia.keys()].sort();
  console.log(`Plan: ${plan.length} bloqueos en ${dias.length} días. Registro: resultados-bloqueos.ndjson\n`);

  let movidos = 0, saltados = 0, fallidos = 0, seguidilla = 0, n = 0;

  for (const dia of dias) {
    let presentes;
    try {
      presentes = new Map((await listarBloqueos(GENERAL, dia)).map(b => [b.id, b]));
      await dormir(PAUSA);
    } catch (err) {
      console.error(`  ${dia}: no se pudo listar General — ${err.message}`);
      for (const p of porDia.get(dia)) { fallidos++; anotar({ eventId: p.eventId, estado: 'fallo', error: `listado ${dia}: ${err.message}` }); }
      continue;
    }

    for (const p of porDia.get(dia)) {
      n++;
      const prefijo = `[${String(n).padStart(3)}/${plan.length}]`;
      const bloqueo = presentes.get(p.eventId);
      if (!bloqueo) {
        saltados++;
        console.log(`${prefijo} YA OK    ${p.terapeuta.padEnd(24)} ${dia} ${p.tipo}`);
        anotar({ eventId: p.eventId, estado: 'ya-estaba', hacia: p.hacia });
        continue;
      }
      try {
        // Same sanitiser as the live sync (tituloGHL in webhooks/zoho.js): GHL
        // answers 422 "Title must be a valid text" to any title with a line
        // break, and Zoho's Observaciones is free text full of them. Ten blocks
        // failed on this in the first run.
        const titulo = tituloGHL([p.tipo, p.obs], p.tipo || 'Bloqueo');
        await mover(bloqueo, p.hacia, titulo);
        movidos++;
        seguidilla = 0;
        console.log(`${prefijo} MOVIDO   ${p.terapeuta.padEnd(24)} ${dia} ${titulo}`);
        anotar({ eventId: p.eventId, estado: 'movido', desde: GENERAL, hacia: p.hacia, terapeuta: p.terapeuta, titulo, startTime: bloqueo.startTime, endTime: bloqueo.endTime });
        await dormir(PAUSA);
      } catch (err) {
        fallidos++; seguidilla++;
        console.error(`${prefijo} FALLO    ${dia} ${p.tipo} — ${err.message}`);
        anotar({ eventId: p.eventId, estado: 'fallo', error: err.message, hacia: p.hacia });
        if (seguidilla >= CORTE_FALLOS) {
          console.error(`\nABORTADO: ${CORTE_FALLOS} fallos seguidos. Movidos: ${movidos}. Corregí y volvé a correr — lo movido se saltea.`);
          process.exit(1);
        }
        await dormir(PAUSA * 3);
      }
    }
  }

  console.log(`\n--- RESUMEN ---\nmovidos:  ${movidos}\nsaltados: ${saltados}\nfallidos: ${fallidos}`);
  if (fallidos) console.log('Volvé a correr para reintentar los fallidos.');
})().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
