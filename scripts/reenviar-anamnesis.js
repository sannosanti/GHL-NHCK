'use strict';

/**
 * Reenvía una anamnesis rechazada al mismo endpoint que la recibió la primera
 * vez, usando la respuesta original que quedó guardada en `anamnesis_fallidas`.
 *
 * `guardarAnamnesisFallida` archiva el cuerpo COMPLETO de la petición
 * (`payload: d` en server.js), así que reenviarlo reproduce el envío original
 * exactamente. Es preferible a volver a tipear treinta y cinco campos a mano,
 * que es lo que hacía falta hasta ahora: cada campo tecleado es una oportunidad
 * de equivocarse con la historia clínica de un paciente.
 *
 * El endpoint sólo emite un aviso interno al equipo. NO le escribe al paciente,
 * así que un reenvío no le llega a la familia. Verificado en server.js.
 *
 *   node scripts/reenviar-anamnesis.js --id 2            (simulacro)
 *   node scripts/reenviar-anamnesis.js --id 2 --aplicar
 */

const db = require('../db');

const BASE = process.env.APP_URL || 'https://miraculous-solace-production-47dd.up.railway.app';
// Las rutas reales, verificadas contra server.js de cada repo. La de adultos
// vive en el servidor de Luisa, no en este.
const RUTAS = { infantil: '/anamnesis-clinica-infantil', adultos: '/anamnesis-clinica-adultos' };

async function main() {
  const args = process.argv.slice(2);
  const id = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;
  const aplicar = args.includes('--aplicar');
  if (!id) { console.error('Falta --id <n>. Ver pendientes: node scripts/anamnesis-fallidas.js'); process.exitCode = 1; return; }

  const fila = (await db.getAnamnesisFallidas()).find(f => String(f.id) === String(id));
  if (!fila) { console.error(`No hay una anamnesis pendiente con id ${id}.`); process.exitCode = 1; return; }

  const ruta = RUTAS[fila.formulario];
  if (!ruta) { console.error(`Formulario desconocido: ${fila.formulario}`); process.exitCode = 1; return; }

  const campos = Object.keys(fila.payload || {}).length;
  console.log(`#${fila.id} — ${fila.nombre} (${fila.formulario}, ${campos} campos)`);
  console.log(`Falló en: ${fila.etapa}   ${fila.hora_local}`);
  console.log(`Destino:  POST ${BASE}${ruta}\n`);

  if (!aplicar) {
    console.log('SIMULACRO — no se envió nada. Volvé a correr con --aplicar.');
    return;
  }

  const res = await fetch(`${BASE}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fila.payload),
  });
  const cuerpo = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status}:`, JSON.stringify(cuerpo));

  // Sólo se marca recuperada si Zoho aceptó las DOS escrituras. Una migración a
  // medias marcada como resuelta es peor que dejarla pendiente: nadie la vuelve
  // a mirar.
  if (res.ok && cuerpo.ok && cuerpo.anamnesisCreada !== false) {
    await db.marcarAnamnesisRecuperada(Number(id));
    console.log(`\n✅ Cargada y marcada como recuperada.`);
  } else {
    console.log(`\n⚠️ No se marcó como recuperada: revisá la respuesta de arriba. Sigue pendiente.`);
  }
}

main()
  .catch(err => { console.error('Error:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
