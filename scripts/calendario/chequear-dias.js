// Cuenta registros de Zoho por día en UN SOLO proceso. Cada `railway run`
// levanta su propio cache de token OAuth, y abrir muchos a la vez ya nos saturó
// las credenciales de Zoho una vez. Un proceso, varios días.
//
//   node scripts/calendario/chequear-dias.js 2026-08-17 2026-08-23
const zoho = require('../../services/zoho');

(async () => {
  const desde = Date.parse(`${process.argv[2]}T00:00:00Z`);
  const hasta = Date.parse(`${process.argv[3] || process.argv[2]}T00:00:00Z`);
  for (let t = desde; t <= hasta; t += 86400000) {
    const dia = new Date(t).toISOString().slice(0, 10);
    const r = await zoho.getDisponibilidad(dia);
    const citas = r.filter(c => c.Contacto?.display_value).length;
    console.log(`${dia}: ${String(r.length).padStart(3)} registros  (${citas} con contacto, ${r.length - citas} bloqueos)`);
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
