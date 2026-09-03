// ¿Sirve la etiqueta de línea para decidir cuál bot contesta?
//
// El 2026-09-01 se prendió un filtro que usaba las etiquetas de FORMULARIO
// (`lead-formulario`, `formulario-sin-respuesta`…) para rutear, asumiendo que
// las sin sufijo eran de NHC. Un contacto de Kids traía una de esas y Carolina
// se quedó callada con un lead real. La premisa era falsa y no se midió antes.
//
// `linea-nhck` / `linea-nhc` es distinto: la pone cada bot para sí mismo en el
// primer mensaje entrante, sin depender de ninguna automatización externa. Esto
// mide si esa señal es confiable.
//
//   node scripts/medir-etiquetas-linea.js [paginas]
const H = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-07-28' };
const loc = process.env.GHL_LOCATION_ID;
const dormir = ms => new Promise(r => setTimeout(r, ms));

const FORMULARIO = ['lead-formulario', 'formulario-declinado', 'formulario-sin-respuesta', 'whatsapp-no-entregado'];

(async () => {
  const paginas = Number(process.argv[2]) || 60;
  const c = { soloKids: 0, soloNHC: 0, ambas: 0, ninguna: 0, total: 0 };
  const f = { kidsConFormSinSufijo: 0, nhcConFormSinSufijo: 0, conFormNhck: 0 };
  const ejemplos = [];
  let cursor = null;

  for (let p = 0; p < paginas; p++) {
    const url = new URL('https://services.leadconnectorhq.com/contacts/');
    url.searchParams.set('locationId', loc);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('startAfterId', cursor);
    const r = await fetch(url, { headers: H });
    await dormir(400);
    if (!r.ok) { console.error(`  aviso HTTP ${r.status} en la pagina ${p + 1}`); break; }
    const contactos = (await r.json()).contacts || [];
    if (!contactos.length) break;

    for (const ct of contactos) {
      const tags = (ct.tags || []).map(t => String(t).toLowerCase().trim());
      c.total++;
      const kids = tags.includes('linea-nhck');
      const nhc = tags.includes('linea-nhc');
      if (kids && nhc) c.ambas++;
      else if (kids) c.soloKids++;
      else if (nhc) c.soloNHC++;
      else c.ninguna++;

      const formSinSufijo = FORMULARIO.some(b => tags.includes(b));
      const formConNhck = FORMULARIO.some(b => tags.includes(`${b} nhck`));
      if (formConNhck) f.conFormNhck++;
      if (formSinSufijo && kids && !nhc) {
        f.kidsConFormSinSufijo++;
        if (ejemplos.length < 6) ejemplos.push(`${(ct.contactName || ct.firstName || ct.id).slice(0, 28)}  ${tags.filter(t => /linea|formulario|whatsapp-no/.test(t)).join(', ')}`);
      }
      if (formSinSufijo && nhc && !kids) f.nhcConFormSinSufijo++;
    }
    cursor = contactos[contactos.length - 1].id;
  }

  console.log(`contactos revisados: ${c.total}\n`);
  console.log('etiqueta de linea:');
  console.log(`  solo linea-nhck (Carolina) : ${c.soloKids}`);
  console.log(`  solo linea-nhc  (Luisa)    : ${c.soloNHC}`);
  console.log(`  LAS DOS                    : ${c.ambas}`);
  console.log(`  ninguna                    : ${c.ninguna}`);
  console.log('\netiquetas de formulario:');
  console.log(`  con sufijo " nhck"                        : ${f.conFormNhck}`);
  console.log(`  SIN sufijo y linea-nhck (rompe la regla)  : ${f.kidsConFormSinSufijo}`);
  console.log(`  SIN sufijo y linea-nhc  (encaja)          : ${f.nhcConFormSinSufijo}`);
  if (ejemplos.length) {
    console.log('\nejemplos de los que rompen la regla:');
    for (const e of ejemplos) console.log(`  ${e}`);
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
