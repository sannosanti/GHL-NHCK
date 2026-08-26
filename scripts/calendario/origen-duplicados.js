// ¿Cuándo se crearon los eventos duplicados? Responde si el problema sigue vivo
// o si lo que se ve es escombro de antes de un arreglo.
//
// Contexto: hasta el 2026-08-20 el flujo de Zoho no mandaba el ID del registro
// en el webhook. Sin ID no hay forma de saber que ese evento ya se creó, así
// que CADA edición en Zoho generaba otra copia en GHL — y ninguna quedaba
// registrada en citas_sync.
//
//   node scripts/calendario/origen-duplicados.js 2026-08-25 2026-09-30
const H = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-04-15' };
const loc = process.env.GHL_LOCATION_ID;
const dormir = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

async function traer(url, intentos = 4) {
  for (let i = 1; i <= intentos; i++) {
    const r = await fetch(url, { headers: H });
    await dormir(300);
    if (r.ok) return r.json();
    if (i === intentos) throw new Error(`HTTP ${r.status}`);
    await dormir(1500 * i);
  }
}

(async () => {
  const desde = Date.parse(`${process.argv[2] || '2026-08-25'}T00:00:00-05:00`);
  const hasta = Date.parse(`${process.argv[3] || '2026-09-30'}T23:59:59-05:00`);
  const base = 'https://services.leadconnectorhq.com/calendars';
  const calendarios = ((await traer(`${base}/?locationId=${loc}`)).calendars || []).filter(c => /zoho sync/i.test(c.name));

  const grupos = new Map();   // "cal|titulo|inicio" -> [fechas de creacion]
  for (const cal of calendarios) {
    for (let t = desde; t < hasta; t += 7 * 86400000) {
      const fin = Math.min(t + 7 * 86400000, hasta);
      for (const ruta of ['events', 'blocked-slots']) {
        const d = await traer(`${base}/${ruta}?locationId=${loc}&calendarId=${cal.id}&startTime=${t}&endTime=${fin}`);
        for (const e of (d.events || d.blockedSlots || [])) {
          if (e.appointmentStatus === 'cancelled') continue;
          const k = `${cal.name}|${norm(e.title)}|${e.startTime}`;
          if (!grupos.has(k)) grupos.set(k, new Map());
          grupos.get(k).set(e.id, String(e.dateAdded || '').slice(0, 10));
        }
      }
    }
  }

  const dups = [...grupos.entries()].filter(([, v]) => v.size > 1);
  const fechas = dups.flatMap(([, v]) => [...v.values()]).filter(Boolean).sort();
  console.log(`grupos duplicados: ${dups.length}   copias en total: ${fechas.length}`);
  if (!fechas.length) return;

  const porMes = {};
  for (const f of fechas) { const m = f.slice(0, 7); porMes[m] = (porMes[m] || 0) + 1; }
  console.log('\ncuándo se crearon esas copias:');
  for (const [m, n] of Object.entries(porMes).sort()) console.log(`   ${m}   ${n}`);
  console.log(`\nmás antigua: ${fechas[0]}   más reciente: ${fechas[fechas.length - 1]}`);

  const CORTE = '2026-08-20';   // día en que el webhook empezó a mandar el ID
  const despues = fechas.filter(f => f > CORTE).length;
  console.log(`\ncopias creadas DESPUÉS del ${CORTE}: ${despues}`);
  console.log(despues ? '  El problema sigue vivo: revisar.' : '  Ninguna. Lo que se ve es escombro anterior al arreglo.');

  if (!despues) return;
  // Las copias nuevas son las que importan: dicen si el mecanismo sigue roto.
  const db = require('../../db');
  console.log('');
  console.log('copias creadas despues del corte:');
  for (const [k, v] of dups) {
    for (const [id, f] of v) {
      if (!f || f <= CORTE) continue;
      const { rows } = await db.pool.query('SELECT zoho_cita_id FROM citas_sync WHERE ghl_event_id=$1', [id]);
      const [cal, titulo, inicio] = k.split('|');
      console.log(`  ${f}  ${cal.slice(0, 22).padEnd(24)} ${String(inicio).slice(0, 16)}  ${titulo.slice(0, 34).padEnd(36)} ${rows[0] ? 'zoho ' + rows[0].zoho_cita_id : 'SIN FILA'}`);
    }
  }
  await db.pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
