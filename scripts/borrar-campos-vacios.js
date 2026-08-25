// Borra campos personalizados del CRM que están VACÍOS en todos los contactos.
//
// Borrar un campo en GHL elimina su valor en todos los contactos y no se
// deshace. Por eso este script sólo acepta una lista explícita, verificada
// antes con un muestreo: el 2026-08-25 se revisaron 6000 contactos y estos
// once no tenían dato en ninguno.
//
// NO se borran `¿Qué tan frecuente interfieren...?` ni `¿Te gustaría
// descubrir...?`: parecen duplicados por el nombre, pero son los que SÍ tienen
// las respuestas (1200 contactos cada uno). Los de nombre corto equivalentes
// son las cáscaras vacías.
//
//   node scripts/borrar-campos-vacios.js                 (simulacro)
//   node scripts/borrar-campos-vacios.js --aplicar --limite 1
//   node scripts/borrar-campos-vacios.js --aplicar
const H = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-07-28' };
const loc = process.env.GHL_LOCATION_ID;
const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const limite = args.includes('--limite') ? Number(args[args.indexOf('--limite') + 1]) : Infinity;
const dormir = ms => new Promise(r => setTimeout(r, ms));

const A_BORRAR = [
  'edad_de_tu_hijoa',
  'rango_de_edad',
  'nhck__rango_de_edad_legacy',
  'nhck__sexo_legacy',
  'nhck__necesidad_legacy',
  'sntomas_identificados',
  'frecuencia_de_sntomas',
  'inters_en_neuromapeo',
  'nhck__estado_histrico_legacy',
  'nhck__categora_de_cliente_legacy',
  'nhck__contacto_relacionado_legacy',
];

(async () => {
  const r = await fetch(`https://services.leadconnectorhq.com/locations/${loc}/customFields`, { headers: H });
  if (!r.ok) throw new Error(`listado HTTP ${r.status}`);
  const campos = (await r.json()).customFields || [];
  const clave = c => String(c.fieldKey || '').replace('contact.', '');

  const objetivo = campos.filter(c => A_BORRAR.includes(clave(c)));
  const noEncontrados = A_BORRAR.filter(k => !campos.some(c => clave(c) === k));

  console.log(`campos en el CRM: ${campos.length}`);
  console.log(`a borrar: ${objetivo.length} de ${A_BORRAR.length} de la lista`);
  if (noEncontrados.length) console.log(`  ya no existen: ${noEncontrados.join(', ')}`);

  const lote = objetivo.slice(0, limite);
  console.log(`ahora: ${lote.length}\n`);

  let ok = 0, fallos = 0;
  for (const c of lote) {
    if (!aplicar) { console.log(`  borraría  ${c.name}`); continue; }
    const d = await fetch(`https://services.leadconnectorhq.com/locations/${loc}/customFields/${c.id}`, { method: 'DELETE', headers: H });
    await dormir(400);
    if (d.ok) { ok++; console.log(`  BORRADO   ${c.name}`); }
    else { fallos++; console.error(`  FALLO     ${c.name} — HTTP ${d.status} ${(await d.text()).slice(0, 80)}`); }
  }

  if (!aplicar) return console.log('\nSIMULACRO — nada se borró. Volvé a correr con --aplicar.');
  const r2 = await fetch(`https://services.leadconnectorhq.com/locations/${loc}/customFields`, { headers: H });
  const quedan = ((await r2.json()).customFields || []).length;
  console.log(`\nborrados: ${ok} | fallidos: ${fallos}\ncampos en el CRM ahora: ${quedan}`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
