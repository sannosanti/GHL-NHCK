// Carga en citas_sync la correspondencia registro de Zoho -> evento de GHL de
// todo lo que crearon o movieron los scripts de este directorio.
//
// citas_sync sólo se llena cuando el webhook crea una cita. El backfill escribió
// sus resultados en sus propios logs, así que los ~1580 eventos que generó
// quedaron sin fila. Sin esa fila, aplicarEstado y propagarCambios no encuentran
// el evento: una cancelación sobre una cita del histórico responde "no está
// espejada en GHL" y no hace nada. Detectado el 2026-08-11 probando cancelar una
// cita real.
//
// Fuentes:
//   creados.ndjson              zohoID + ghlID directos
//   plan.json + resultados      eventId -> zohoID por el plan de migración
//   plan-bloqueos.json + result. idem para bloqueos
//
//   node scripts/calendario/poblar-citas-sync.js [--aplicar]
const fs = require('fs');
const path = require('path');
const db = require('../../db');

const BASE = __dirname;
const aplicar = process.argv.includes('--aplicar');

const leerNdjson = f => {
  const p = path.join(BASE, f);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
};
const leerJson = f => {
  const p = path.join(BASE, f);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

(async () => {
  await db.initDB();

  // zohoID -> { ghlID, calendarId, clase, inicio, fin }
  const filas = new Map();

  // 1. Lo que creó crear-faltantes.js: trae ambos ids en la misma línea.
  for (const o of leerNdjson('creados.ndjson')) {
    if (o.estado !== 'creado' || !o.zohoID || !o.ghlID) continue;
    filas.set(o.zohoID, { ghlID: o.ghlID, calendarId: o.calendarId, clase: o.clase, inicio: o.inicio });
  }
  const deCreados = filas.size;

  // 2. Lo que movió la migración: el log guarda el evento, el plan el registro
  //    de Zoho que lo justifica. Se cruzan por eventId.
  const porEvento = new Map();
  for (const [planFile, clase] of [['plan.json', 'cita'], ['plan-bloqueos.json', 'bloqueo']]) {
    const plan = leerJson(planFile);
    for (const p of plan?.plan || []) {
      if (p.zohoID) porEvento.set(p.eventId, { zohoID: p.zohoID, clase, inicio: p.inicio });
    }
  }
  for (const f of ['resultados.ndjson', 'resultados-bloqueos.ndjson']) {
    for (const o of leerNdjson(f)) {
      if (o.estado !== 'movido' && o.estado !== 'ya-estaba') continue;
      const ref = porEvento.get(o.eventId);
      if (!ref || filas.has(ref.zohoID)) continue;   // creados.ndjson manda
      filas.set(ref.zohoID, { ghlID: o.eventId, calendarId: o.hacia || o.calendario, clase: ref.clase, inicio: ref.inicio });
    }
  }

  // 3. Reconciliación contra GHL. Los logs sólo cubren lo que hicieron estos
  //    scripts; las citas que creó el webhook viejo y que después la migración
  //    movió no aparecen en ninguno con su zohoID. Emparejar por contacto + hora
  //    contra el calendario que corresponde las alcanza a todas, sin depender de
  //    ningún registro previo. Es el mismo criterio que usa auditar.js.
  const zoho = require('../../services/zoho');
  const key = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const H = { Authorization: `Bearer ${key}`, Version: '2021-04-15' };
  const CALENDARIOS = {
    '3572150000004930155': 'MvnOMgGMs69y6Ewix22r', '3572150000005140253': 'iTdbaauOdCrcNHwsIe2h',
    '3572150000004871148': 'M1fNQqz0yn8LH1op8I4s', '3572150000009238003': 'pLhcRJMTzeTjhrv8dqDY',
    '3572150000004912180': 'vvb8taavISxlgeGoXd78', '3572150000004826082': '5OHWEK3t2Wvg1xc9tsRv',
    '3572150000004871136': 'hsHuxGh5wLknUFxWt0Sk', '3572150000013136002': 'wRUCuDmqhbxmU3rvgG5j',
    '3572150000004871160': 'kzPKbuB2npt64tyXuFnx', '3572150000006479156': 'SAjr7SxN1h0biqbiprV1',
  };
  const MESES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const nomTit = t => norm(String(t || '').split(' - ').slice(1).join(' - '));
  const aZ = t => { const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/); return m ? `${m[3]}-${MESES[+m[2]-1]}-${m[1]} ${m[4]}:${m[5]}:${m[6]}` : null; };

  const desdeISO = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : '2026-07-01';
  const hastaISO = process.argv[3] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3]) ? process.argv[3] : '2026-12-31';
  const desde = Date.parse(`${desdeISO}T00:00:00Z`), hasta = Date.parse(`${hastaISO}T23:59:59Z`);

  const eventosPorClave = new Map();   // "calId|nombre|inicio" -> eventId
  for (const calId of Object.values(CALENDARIOS)) {
    for (let t = desde; t < hasta; t += 7 * 24 * 3600 * 1000) {
      const url = `https://services.leadconnectorhq.com/calendars/events?locationId=${locationId}&calendarId=${calId}&startTime=${t}&endTime=${Math.min(t + 7*24*3600*1000, hasta)}`;
      const r = await fetch(url, { headers: H });
      if (!r.ok) continue;
      for (const e of (await r.json()).events || []) {
        eventosPorClave.set(`${calId}|${nomTit(e.title)}|${aZ(e.startTime)}`, e.id);
      }
    }
  }

  let deReconciliacion = 0;
  for (let t = desde; t <= hasta; t += 86400000) {
    for (const c of await zoho.getDisponibilidad(new Date(t).toISOString().slice(0, 10))) {
      const contacto = c.Contacto?.display_value;
      const calId = CALENDARIOS[c.Consultor?.ID || ''];
      if (!contacto || !calId || !c.ID || filas.has(c.ID)) continue;
      const eventId = eventosPorClave.get(`${calId}|${norm(contacto)}|${c.Inicio}`);
      if (!eventId) continue;
      filas.set(c.ID, { ghlID: eventId, calendarId: calId, clase: 'cita', inicio: c.Inicio, fin: c.Fin });
      deReconciliacion++;
    }
  }

  console.log(`correspondencias reunidas: ${filas.size}`);
  console.log(`   de creados.ndjson  : ${deCreados}`);
  console.log(`   de la migración    : ${filas.size - deCreados - deReconciliacion}`);
  console.log(`   por reconciliación : ${deReconciliacion}`);

  const yaEstaban = await db.pool.query('SELECT zoho_cita_id FROM citas_sync');
  const existentes = new Set(yaEstaban.rows.map(r => r.zoho_cita_id));
  const nuevas = [...filas.entries()].filter(([id]) => !existentes.has(id));
  console.log(`\nya en citas_sync : ${existentes.size}`);
  console.log(`a insertar       : ${nuevas.length}`);

  if (!aplicar) {
    console.log('\nDRY RUN — nada se escribió. Volvé a correr con --aplicar.');
    for (const [id, v] of nuevas.slice(0, 5)) console.log(`   ${id} -> ${v.ghlID} (${v.clase}) ${v.inicio || ''}`);
    await db.pool.end();
    return;
  }

  let ok = 0, fallos = 0;
  for (const [zohoID, v] of nuevas) {
    try {
      // ON CONFLICT DO NOTHING: si el webhook la registró mientras esto corre,
      // gana la del webhook, que es la fuente viva.
      await db.pool.query(
        `INSERT INTO citas_sync (zoho_cita_id, ghl_event_id, calendar_id, clase, inicio, fin)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (zoho_cita_id) DO NOTHING`,
        [zohoID, v.ghlID, v.calendarId || null, v.clase || null, v.inicio || null, v.fin || null]
      );
      ok++;
    } catch (err) {
      fallos++;
      console.error(`  fallo ${zohoID}: ${err.message}`);
    }
  }
  const total = await db.pool.query('SELECT count(*)::int AS n FROM citas_sync');
  console.log(`\ninsertadas: ${ok} | fallidas: ${fallos}`);
  console.log(`citas_sync ahora: ${total.rows[0].n} filas`);
  await db.pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
