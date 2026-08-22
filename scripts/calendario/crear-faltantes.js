// Crea en GHL lo que figura en plan-faltantes.json y no existe todavía.
//
// Re-ejecutable: cada creación queda anotada en creados.ndjson con el id que
// devolvió GHL, y las entradas ya anotadas se saltean. Un corte a mitad no
// duplica nada al reintentar.
//
// El límite existe para el canario. Empezar SIEMPRE con --limite 1 y verificar
// antes de soltar el lote entero:
//
//   node scripts/calendario/crear-faltantes.js --limite 1
//   node scripts/calendario/crear-faltantes.js --solo-bloqueos
//   node scripts/calendario/crear-faltantes.js
const fs = require('fs');
const path = require('path');
const zoho = require('../../services/zoho');
const ghl = require('../../services/ghl');
const { parseZohoDateTime } = require('../../webhooks/zoho');

const BASE = __dirname;
const registro = path.join(BASE, 'creados.ndjson');

const args = process.argv.slice(2);
// --plan permite usar un plan filtrado. plan-faltantes.js empareja por nombre y
// sólo mira citas, así que marca como faltantes horarios que ya están ocupados
// por el bloqueo de pago del mismo paciente: filtrar-faltantes.js los descarta.
const archivoPlan = args.includes('--plan') ? args[args.indexOf('--plan') + 1] : 'plan-faltantes.json';
const plan = require(path.join(BASE, archivoPlan));
const limite = args.includes('--limite') ? Number(args[args.indexOf('--limite') + 1]) : Infinity;
const soloBloqueos = args.includes('--solo-bloqueos');
const soloCitas = args.includes('--solo-citas');
const PAUSA = 400;
const CORTE_FALLOS = 5;

const dormir = ms => new Promise(r => setTimeout(r, ms));
const anotar = o => fs.appendFileSync(registro, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');

// Lo ya creado en corridas anteriores, para no repetirlo.
const yaHechos = new Set();
if (fs.existsSync(registro)) {
  for (const linea of fs.readFileSync(registro, 'utf8').trim().split('\n')) {
    if (!linea) continue;
    const o = JSON.parse(linea);
    if (o.estado === 'creado' || o.estado === 'sin-telefono') yaHechos.add(o.zohoID);
  }
}

(async () => {
  const tareas = [
    ...(soloBloqueos ? [] : plan.crearCitas.map(x => ({ ...x, clase: 'cita' }))),
    ...(soloCitas ? [] : plan.crearBloqueos.map(x => ({ ...x, clase: 'bloqueo' }))),
  ].filter(t => !yaHechos.has(t.zohoID));

  const lote = tareas.slice(0, limite);
  console.log(`Plan: ${plan.crearCitas.length} citas + ${plan.crearBloqueos.length} bloqueos`);
  console.log(`Ya hechos en corridas previas: ${yaHechos.size}`);
  console.log(`A procesar ahora: ${lote.length}${limite !== Infinity ? ` (limitado a ${limite})` : ''}\n`);

  let creados = 0, fallidos = 0, saltados = 0, seguidilla = 0;

  for (const [i, t] of lote.entries()) {
    const prefijo = `[${String(i + 1).padStart(4)}/${lote.length}]`;
    const startISO = parseZohoDateTime(t.inicio);
    const endISO = parseZohoDateTime(t.fin);
    if (!startISO) { fallidos++; anotar({ zohoID: t.zohoID, estado: 'fallo', error: 'inicio ilegible' }); continue; }

    try {
      if (t.clase === 'bloqueo') {
        const r = await ghl.crearBloqueoEnCalendario({ calendarId: t.calendarId, startISO, endISO, title: t.titulo });
        creados++; seguidilla = 0;
        console.log(`${prefijo} BLOQUEO  ${t.terapeuta.padEnd(24)} ${t.inicio}  ${t.titulo}`);
        anotar({ zohoID: t.zohoID, estado: 'creado', clase: 'bloqueo', ghlID: r?.id, calendarId: t.calendarId, terapeuta: t.terapeuta, inicio: t.inicio });
      } else {
        const contacto = await zoho.getContactoPorId(t.contactoZohoID);
        await dormir(PAUSA);
        if (!contacto?.Movil) {
          // Sin teléfono no hay contacto GHL al que colgar la cita. Se anota y se
          // sigue: inventar un contacto sería peor que dejar el hueco visible.
          saltados++;
          console.log(`${prefijo} SIN TEL  ${t.contacto} — se omite`);
          anotar({ zohoID: t.zohoID, estado: 'sin-telefono', contacto: t.contacto, inicio: t.inicio, terapeuta: t.terapeuta });
          continue;
        }
        const contactId = await ghl.buscarOCrearContactoPorTelefono(contacto.Movil, contacto.Nombre_Completo);
        await dormir(PAUSA);
        if (!contactId) throw new Error('no se pudo resolver el contacto en GHL');

        const title = `${t.tipo} - ${contacto.Nombre_Completo || t.contacto}`;
        const r = await ghl.crearCitaEnCalendario({ contactId, calendarId: t.calendarId, startISO, endISO, title });
        creados++; seguidilla = 0;
        console.log(`${prefijo} CITA     ${t.terapeuta.padEnd(24)} ${t.inicio}  ${t.contacto}`);
        anotar({ zohoID: t.zohoID, estado: 'creado', clase: 'cita', ghlID: r?.id, calendarId: t.calendarId, terapeuta: t.terapeuta, inicio: t.inicio, contacto: t.contacto });
      }
      await dormir(PAUSA);
    } catch (err) {
      fallidos++; seguidilla++;
      console.error(`${prefijo} FALLO    ${t.inicio} ${t.contacto || t.titulo} — ${err.message}`);
      anotar({ zohoID: t.zohoID, estado: 'fallo', error: err.message, inicio: t.inicio });
      if (seguidilla >= CORTE_FALLOS) {
        console.error(`\nABORTADO: ${CORTE_FALLOS} fallos seguidos. Creados: ${creados}. Volvé a correr después de corregir.`);
        process.exit(1);
      }
      await dormir(PAUSA * 3);
    }
  }

  console.log(`\n--- RESUMEN ---\ncreados:  ${creados}\nsin tel:  ${saltados}\nfallidos: ${fallidos}`);
  console.log('\nTodo lo creado queda en creados.ndjson con su ghlID.');
})().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
