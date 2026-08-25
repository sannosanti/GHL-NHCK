// Lista los campos del CRM que ninguna automatización lee, con CUÁNTOS
// contactos tienen dato en cada uno.
//
// El nombre no alcanza para decidir: el 2026-08-25 dos campos que parecían
// copias sucias resultaron ser los únicos con las respuestas (1200 contactos
// cada uno), mientras sus gemelos de nombre corto estaban vacíos. Se decide
// contando, no leyendo etiquetas.
//
//   node scripts/revisar-campos-sin-uso.js [paginas]
const fs = require('fs');
const path = require('path');

const H = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-07-28' };
const loc = process.env.GHL_LOCATION_ID;
const dormir = ms => new Promise(r => setTimeout(r, ms));

// Metadata de pauta: el código no la lee, pero es la que dice de qué anuncio
// vino cada lead. No es candidata a borrar aunque figure "sin uso".
const ATRIBUCION = new Set(['ad_name', 'adset_name', 'campaign_name', 'form_name',
  'utm_source', 'page_name', 'ad_account_name', 'social_lead_id', 'platform']);

function codigoDeAmbosBots() {
  let texto = '';
  for (const base of [path.join(__dirname, '..'), 'C:/Users/sanch/GHL-NHC-temp']) {
    for (const d of ['services', 'webhooks', 'ai', 'config', 'jobs', 'db']) {
      const dir = path.join(base, d);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) texto += fs.readFileSync(path.join(dir, f), 'utf8');
    }
    const srv = path.join(base, 'server.js');
    if (fs.existsSync(srv)) texto += fs.readFileSync(srv, 'utf8');
  }
  return texto;
}

(async () => {
  const paginas = Number(process.argv[2]) || 60;
  const r = await fetch(`https://services.leadconnectorhq.com/locations/${loc}/customFields`, { headers: H });
  const campos = (await r.json()).customFields || [];
  const codigo = codigoDeAmbosBots();
  const clave = c => String(c.fieldKey || '').replace('contact.', '');

  const aRevisar = campos.filter(c => {
    const k = clave(c);
    const enUso = (k && codigo.includes(k)) || codigo.includes(c.id);
    return !enUso && !ATRIBUCION.has(k);
  });

  const porId = new Map(aRevisar.map(c => [c.id, c.name]));
  const cuenta = new Map(aRevisar.map(c => [c.name, 0]));

  let vistos = 0, cursor = null;
  for (let p = 0; p < paginas; p++) {
    const url = new URL('https://services.leadconnectorhq.com/contacts/');
    url.searchParams.set('locationId', loc);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('startAfterId', cursor);
    const res = await fetch(url, { headers: H });
    await dormir(400);
    if (!res.ok) { console.error(`  aviso: HTTP ${res.status} en la página ${p + 1}`); break; }
    const contactos = (await res.json()).contacts || [];
    if (!contactos.length) break;
    for (const c of contactos) {
      vistos++;
      for (const cf of (c.customFields || [])) {
        const n = porId.get(cf.id);
        if (n && cf.value !== '' && cf.value != null) cuenta.set(n, cuenta.get(n) + 1);
      }
    }
    cursor = contactos[contactos.length - 1].id;
  }

  const orden = [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
  const conDatos = orden.filter(([, v]) => v > 0);
  const vacios = orden.filter(([, v]) => v === 0);

  console.log(`campos a revisar: ${aRevisar.length}   (contactos muestreados: ${vistos})\n`);
  console.log(`=== CON DATOS — borrarlos pierde información (${conDatos.length}) ===`);
  for (const [n, v] of conDatos) console.log(`  ${String(v).padStart(5)} contactos   ${n}`);
  console.log(`\n=== VACÍOS en los ${vistos} contactos — borrarlos no pierde nada (${vacios.length}) ===`);
  for (const [n] of vacios) console.log(`        —          ${n}`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
