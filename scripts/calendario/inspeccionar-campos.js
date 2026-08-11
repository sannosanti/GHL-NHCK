// Volcado de un registro del reporte de citas de Zoho para ver qué campos
// devuelve realmente. El barrido mostró Estado como undefined y hace falta
// saber con qué nombre viaja antes de decidir sobre las citas sin espejar.
//
//   node scripts/calendario/inspeccionar-campos.js 2026-08-13 Joaqu
const zoho = require('../../services/zoho');

(async () => {
  const dia = process.argv[2] || new Date().toISOString().slice(0, 10);
  const filtro = (process.argv[3] || '').toLowerCase();
  const citas = await zoho.getDisponibilidad(dia);

  console.log(`registros en ${dia}: ${citas.length}`);
  if (!citas.length) return;
  console.log(`\ncampos: ${Object.keys(citas[0]).join(', ')}\n`);

  for (const c of citas) {
    const nombre = c.Contacto?.display_value || '';
    if (filtro && !nombre.toLowerCase().includes(filtro)) continue;
    console.log(JSON.stringify(c, null, 1));
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
