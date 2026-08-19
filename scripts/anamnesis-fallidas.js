'use strict';

/**
 * Lee las anamnesis que Zoho Creator rechazó y que el servidor dejó guardadas
 * en la tabla `anamnesis_fallidas`, para volver a cargarlas a mano.
 *
 * Nace de un caso real (18-Ago-2026): el aviso por correo vivía dentro de la
 * rama de éxito, así que un registro rechazado no avisaba a nadie y las
 * respuestas de la paciente se perdían. Ahora se guardan; esto es lo que las
 * saca.
 *
 * Deliberadamente NO hay endpoint HTTP: son respuestas clínicas, y los
 * `/admin/*` de este servidor no piden autenticación.
 *
 *   railway run node scripts/anamnesis-fallidas.js
 *   railway run node scripts/anamnesis-fallidas.js --id 7
 *   railway run node scripts/anamnesis-fallidas.js --recuperada 7
 */

const db = require('../db');

async function main() {
  const args = process.argv.slice(2);
  const valorDe = flag => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };

  const recuperada = valorDe('--recuperada');
  if (recuperada) {
    await db.marcarAnamnesisRecuperada(Number(recuperada));
    console.log(`Anamnesis ${recuperada} marcada como recuperada.`);
    return;
  }

  const pendientes = await db.getAnamnesisFallidas();
  if (!pendientes.length) {
    console.log('No hay anamnesis pendientes de recuperar.');
    return;
  }

  const id = valorDe('--id');
  if (id) {
    const fila = pendientes.find(f => String(f.id) === String(id));
    if (!fila) {
      console.error(`No hay una anamnesis pendiente con id ${id}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`#${fila.id} — ${fila.nombre} (${fila.formulario})`);
    console.log(`Falló en: ${fila.etapa}   ${new Date(fila.creado_at).toLocaleString('es-CO')}`);
    console.log(`Error de Zoho: ${JSON.stringify(fila.error)}\n`);
    // Las respuestas completas, tal como las escribió la persona: es lo que
    // hay que volver a cargar, así que se imprimen sin recortar.
    for (const [k, v] of Object.entries(fila.payload || {})) {
      if (v === '' || v == null) continue;
      console.log(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    return;
  }

  console.log(`${pendientes.length} anamnesis pendiente(s) de recuperar:\n`);
  for (const f of pendientes) {
    console.log(`  #${f.id}  ${new Date(f.creado_at).toLocaleString('es-CO')}  ${f.formulario.padEnd(8)} ${f.etapa.padEnd(17)} ${f.nombre || '(sin nombre)'}`);
    console.log(`        ${f.movil || 'sin móvil'}  ${f.email || 'sin email'}`);
  }
  console.log('\nVer una completa:  node scripts/anamnesis-fallidas.js --id <n>');
  console.log('Marcar cargada:    node scripts/anamnesis-fallidas.js --recuperada <n>');
}

main()
  .catch(err => { console.error('Error:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
