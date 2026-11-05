'use strict';

// Corre a mano el barrido de citas fantasma que el servidor ya ejecuta solo
// todos los días (jobs/barridoFantasmasJob.js). Sirve para mirar el estado en el
// momento o para forzar una pasada después de limpiar algo en Creator.
//
// La lógica NO está acá: está en el job. Una copia se desincroniza del original
// en la primera corrección y termina cancelando con un criterio distinto al que
// corre en producción.
//
//   node scripts/calendario/barrido-fantasmas.js              simulacro
//   node scripts/calendario/barrido-fantasmas.js --cancelar   aplica
//   node scripts/calendario/barrido-fantasmas.js --dias=60    otro rango
const { barrerFantasmas } = require('../../jobs/barridoFantasmasJob');

const cancelar = process.argv.includes('--cancelar');
const argDias = process.argv.find((a) => a.startsWith('--dias='));
const dias = argDias ? Number(argDias.split('=')[1]) : 30;

(async () => {
  console.log(cancelar
    ? `=== BARRIDO REAL — cancela en GHL (${dias} días)`
    : `=== SIMULACRO — no escribe nada (${dias} días). Pasá --cancelar para aplicar.`);

  let stats;
  try {
    stats = await barrerFantasmas({ dias, cancelar });
  } catch (err) {
    // El job aborta entero si un día de Zoho no se pudo leer, para no cancelar
    // citas reales de un día que simplemente no respondió.
    console.error('\nABORTADO:', err.message);
    process.exit(1);
  }

  console.log(`\ncitas futuras espejadas: ${stats.revisadas}`);
  console.log(`fantasmas encontrados  : ${stats.fantasmas}`);
  for (const d of stats.detalle) {
    console.log(`   ${d.inicio}  zoho ${d.zoho}  ghl ${d.ghl}${d.contacto ? `  contacto ${d.contacto}` : ''}`);
  }
  if (cancelar) console.log(`\ncanceladas: ${stats.canceladas} | fallidas: ${stats.fallidas}`);
  else if (stats.fantasmas) console.log('\n(simulacro: no se canceló ninguna)');
  process.exit(0);
})();
