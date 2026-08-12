'use strict';

/**
 * Encuentra las citas que se espejaron a GHL como bloqueo: ocupan el horario
 * pero no tienen contacto asociado, así que esa persona nunca va a recibir el
 * recordatorio. Antes del arreglo del 2026-08-12 la tabla no distinguía el caso
 * -- reclamaba 'cita' con sólo ver que el registro traía Contacto, y no corregía
 * la clase al degradar -- de modo que las filas viejas mienten y hay que
 * preguntarle a GHL qué quedó realmente.
 *
 * Sólo lee. Para ver la semana en curso:
 *   railway run node scripts/calendario/auditar-degradadas.js 13-Aug-2026 14-Aug-2026 15-Aug-2026
 */

const db = require('../../db');
const ghl = require('../../services/ghl');

const DELAY_MS = 200;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const dias = process.argv.slice(2);
  if (!dias.length) {
    console.error('Uso: node auditar-degradadas.js 13-Aug-2026 [14-Aug-2026 ...]');
    process.exitCode = 1;
    return;
  }

  const condiciones = dias.map((_, i) => `inicio LIKE $${i + 1}`).join(' OR ');
  const { rows } = await db.pool.query(
    `SELECT zoho_cita_id, ghl_event_id, calendar_id, clase, inicio, fin
       FROM citas_sync
      WHERE (${condiciones}) AND clase = 'cita' AND ghl_event_id IS NOT NULL
      ORDER BY inicio`,
    dias.map(d => `%${d}%`)
  );

  console.log(`Revisando ${rows.length} filas marcadas 'cita' en ${dias.join(', ')}\n`);

  const degradadas = [];
  const noEncontradas = [];

  for (const [i, r] of rows.entries()) {
    try {
      const evento = await ghl.getCitaEnCalendario(r.ghl_event_id);
      // Un bloqueo no tiene contacto. Es la única señal fiable de que la cita se
      // degradó: el título y el calendario son idénticos en ambos casos.
      if (!evento?.contactId) degradadas.push({ ...r, titulo: evento?.title, estado: evento?.appointmentStatus || evento?.status });
    } catch (err) {
      noEncontradas.push({ ...r, error: err.message });
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${rows.length}`);
    await sleep(DELAY_MS);
  }

  console.log(`\n=== CITAS SIN CONTACTO EN GHL (${degradadas.length}) ===`);
  console.log('Ocupan el horario pero NO van a recibir recordatorio.\n');
  for (const d of degradadas) {
    console.log(`  ${d.inicio} -> ${d.fin || '?'}  "${d.titulo || '?'}"  [${d.estado || '?'}]`);
    console.log(`    zoho=${d.zoho_cita_id}  ghl=${d.ghl_event_id}  calendario=${d.calendar_id}`);
  }
  if (!degradadas.length) console.log('  ninguna');

  if (noEncontradas.length) {
    console.log(`\n=== NO SE PUDO LEER EN GHL (${noEncontradas.length}) ===`);
    console.log('Probablemente el evento fue borrado en GHL y la fila quedó huérfana.\n');
    for (const n of noEncontradas) {
      console.log(`  ${n.inicio}  zoho=${n.zoho_cita_id}  ghl=${n.ghl_event_id}  — ${n.error}`);
    }
  }
}

main()
  .catch(err => { console.error('Error:', err); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
