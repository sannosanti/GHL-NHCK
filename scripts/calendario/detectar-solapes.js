// Encuentra eventos que se pisan en el tiempo dentro de un mismo calendario.
//
// Es lo que la clínica ve como "citas duplicadas o montadas una sobre la otra".
// Los barridos anteriores comparaban Zoho contra GHL; ninguno miraba si dentro
// de GHL dos cosas ocupan la misma franja.
//
// Clasifica, porque no todo solape es un error:
//   RESERVA DE PAGO  la cita y un bloqueo "pago pendiente de <la misma persona>".
//                    Es la forma normal de operar: el bloqueo reserva el espacio
//                    mientras el pago se confirma. Ruido visual, no un problema.
//   DUPLICADO        dos eventos con el mismo título y la misma hora.
//   CONFLICTO REAL   dos pacientes distintos en la misma franja del mismo
//                    profesional. Esto sí hay que resolverlo a mano.
//
//   node scripts/calendario/detectar-solapes.js 2026-08-25 2026-09-07
const H = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-04-15' };
const loc = process.env.GHL_LOCATION_ID;
const dormir = ms => new Promise(r => setTimeout(r, ms));

async function traer(url, intentos = 4) {
  for (let i = 1; i <= intentos; i++) {
    const r = await fetch(url, { headers: H });
    await dormir(300);
    if (r.ok) return r.json();
    if (i === intentos) throw new Error(`HTTP ${r.status}`);
    await dormir(1500 * i);
  }
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// El nombre del paciente va después del primer " - " del título.
const nombreDe = t => norm(String(t || '').split(' - ').slice(1).join(' - '));
const tokens = s => norm(s).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(x => x.length >= 4);

// ¿El bloqueo menciona a la persona de la cita? "Bloqueo - pago pendiente de
// victoria" contra "Isabel Victoria Olave Patiño" comparte "victoria".
const mencionaA = (textoBloqueo, nombrePaciente) => {
  const t = norm(textoBloqueo);
  return tokens(nombrePaciente).some(x => t.includes(x));
};

const hora = t => new Date(t).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

(async () => {
  const desdeISO = process.argv[2] || '2026-08-25';
  const hastaISO = process.argv[3] || '2026-09-07';
  const desde = Date.parse(`${desdeISO}T00:00:00-05:00`);
  const hasta = Date.parse(`${hastaISO}T23:59:59-05:00`);
  const base = 'https://services.leadconnectorhq.com/calendars';

  const calendarios = ((await traer(`${base}/?locationId=${loc}`)).calendars || [])
    .filter(c => /zoho sync/i.test(c.name));

  const resumen = [];
  for (const cal of calendarios) {
    const eventos = [];
    for (let t = desde; t < hasta; t += 7 * 86400000) {
      const fin = Math.min(t + 7 * 86400000, hasta);
      for (const [ruta, clase] of [['events', 'cita'], ['blocked-slots', 'bloqueo']]) {
        const d = await traer(`${base}/${ruta}?locationId=${loc}&calendarId=${cal.id}&startTime=${t}&endTime=${fin}`);
        for (const e of (d.events || d.blockedSlots || [])) {
          if (!eventos.some(x => x.id === e.id)) eventos.push({ ...e, clase });
        }
      }
    }

    // Se descartan las canceladas: no ocupan agenda.
    const vivos = eventos.filter(e => e.appointmentStatus !== 'cancelled')
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));

    const solapes = [];
    for (let i = 0; i < vivos.length; i++) {
      for (let j = i + 1; j < vivos.length; j++) {
        const a = vivos[i], b = vivos[j];
        const ini = Math.max(Date.parse(a.startTime), Date.parse(b.startTime));
        const fin = Math.min(Date.parse(a.endTime), Date.parse(b.endTime));
        if (ini >= fin) continue;   // no se pisan

        const mismoTitulo = norm(a.title) === norm(b.title);
        const mismaHora = Date.parse(a.startTime) === Date.parse(b.startTime);
        const cita = a.clase === 'cita' ? a : (b.clase === 'cita' ? b : null);
        const bloq = a.clase === 'bloqueo' ? a : (b.clase === 'bloqueo' ? b : null);

        // Clasificar bien importa más que detectar mucho. Primera versión marcó
        // 365 "conflictos" en Neurotecnologías: eran pacientes en paralelo, que
        // ahí es lo normal porque la sala tiene varias estaciones. Una lista con
        // cientos de falsos positivos no la revisa nadie.
        let tipo;
        if (mismoTitulo && mismaHora) {
          // Mismo título y misma hora: se creó dos veces. Esto sí es un error.
          tipo = 'DUPLICADO';
        } else if (cita && bloq && mencionaA(bloq.title, nombreDe(cita.title))) {
          // El bloqueo reserva el espacio de esa misma persona mientras paga.
          tipo = 'RESERVA DE PAGO';
        } else if (a.clase === 'bloqueo' && b.clase === 'bloqueo') {
          // Dos bloqueos pisándose no le quitan el turno a nadie: uno puede ser
          // el cierre de la jornada y el otro una reserva puntual.
          tipo = 'DOS BLOQUEOS';
        } else if (a.clase === 'cita' && b.clase === 'cita') {
          // Dos pacientes a la vez con el mismo profesional. NO se afirma que
          // sea un error: depende de si ese calendario atiende en paralelo.
          tipo = 'MISMA FRANJA';
        } else {
          // Una cita y un bloqueo ajeno: el bloqueo tapa el turno de un paciente.
          tipo = 'CITA TAPADA';
        }
        solapes.push({ tipo, a, b });
      }
    }

    const cuenta = t => solapes.filter(s => s.tipo === t).length;
    resumen.push({
      nombre: cal.name, eventos: vivos.length,
      dup: cuenta('DUPLICADO'), tapada: cuenta('CITA TAPADA'),
      franja: cuenta('MISMA FRANJA'), pago: cuenta('RESERVA DE PAGO'),
    });

    // Sólo se listan las accionables. Reserva de pago, dos bloqueos y misma
    // franja son formas normales de operar.
    const relevantes = solapes.filter(s => s.tipo === 'DUPLICADO' || s.tipo === 'CITA TAPADA');
    if (relevantes.length) {
      console.log(`\n=== ${cal.name} ===`);
      for (const s of relevantes) {
        console.log(`  [${s.tipo}] ${hora(s.a.startTime)}`);
        console.log(`      ${s.a.clase.padEnd(8)} ${s.a.title}`);
        console.log(`      ${s.b.clase.padEnd(8)} ${s.b.title}   (${hora(s.b.startTime)})`);
      }
    }
  }

  console.log(`\n\n--- RESUMEN ${desdeISO} .. ${hastaISO} ---`);
  console.log('calendario'.padEnd(38), 'eventos', 'DUPL', 'TAPADA', '| franja', 'pago');
  for (const r of resumen.sort((a, b) => (b.dup + b.tapada) - (a.dup + a.tapada))) {
    console.log(r.nombre.slice(0, 36).padEnd(38), String(r.eventos).padStart(7), String(r.dup).padStart(5), String(r.tapada).padStart(6), '|', String(r.franja).padStart(6), String(r.pago).padStart(4));
  }
  console.log('');
  console.log('DUPL   = mismo titulo y misma hora, creado dos veces. Es error.');
  console.log('TAPADA = un bloqueo ajeno encima del turno de un paciente. Revisar.');
  console.log('franja = dos pacientes a la vez; normal si el calendario atiende en paralelo.');
  console.log('pago   = bloqueo que reserva el espacio de esa misma persona. Normal.');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
