// Lista los campos personalizados del CRM y marca cuáles usa el código.
//
// Sirve para limpiar: en GHL los campos se acumulan (uno por cada iteración del
// formulario) y nadie sabe cuál está vivo. Un campo que ninguna automatización
// lee es ruido para quien llena y para quien consulta.
//
//   node scripts/auditar-campos-ghl.js
const fs = require('fs');
const path = require('path');

const H = { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-07-28' };

// Se buscan los identificadores dentro del código: si un id o una clave aparece
// en algún archivo, el campo está en uso.
function fuentes() {
  const dirs = ['services', 'webhooks', 'ai', 'config', 'jobs', 'db'];
  let texto = '';
  for (const base of [__dirname + '/..', 'C:/Users/sanch/GHL-NHC-temp']) {
    for (const d of dirs) {
      const dir = path.join(base, d);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.js')) texto += fs.readFileSync(path.join(dir, f), 'utf8');
      }
    }
    const srv = path.join(base, 'server.js');
    if (fs.existsSync(srv)) texto += fs.readFileSync(srv, 'utf8');
  }
  return texto;
}

(async () => {
  const r = await fetch(`https://services.leadconnectorhq.com/locations/${process.env.GHL_LOCATION_ID}/customFields`, { headers: H });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 150)}`);
  const campos = (await r.json()).customFields || [];
  const codigo = fuentes();

  const usados = [], sinUso = [];
  for (const c of campos) {
    const clave = c.fieldKey ? String(c.fieldKey).replace(/^contact\./, '') : '';
    const enUso = (clave && codigo.includes(clave)) || codigo.includes(c.id);
    (enUso ? usados : sinUso).push({ ...c, clave });
  }

  // Repetidos: mismo nombre una vez normalizado (sin prefijo de marca, sin
  // signos y sin la forma de pregunta).
  const norm = s => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^nhck?\s*-\s*/, '').replace(/[¿?¡!.,]/g, '')
    .replace(/\b(del|de la|de|el|la|los|las|un|una|actualmente|nino|nina|nino\/a)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();

  const porNombre = new Map();
  for (const c of campos) {
    const k = norm(c.name);
    if (!porNombre.has(k)) porNombre.set(k, []);
    porNombre.get(k).push(c);
  }
  const repetidos = [...porNombre.entries()].filter(([, xs]) => xs.length > 1);

  console.log(`campos en el CRM: ${campos.length}`);
  console.log(`  usados por el código : ${usados.length}`);
  console.log(`  sin uso              : ${sinUso.length}`);
  console.log(`  grupos repetidos     : ${repetidos.length}`);

  console.log('\n=== USADOS POR EL CÓDIGO (no tocar) ===');
  for (const c of usados) console.log(`  ${c.name}`);

  console.log('\n=== REPETIDOS (mismo campo, varios nombres) ===');
  for (const [k, xs] of repetidos) {
    console.log(`  «${k}»`);
    for (const c of xs) {
      const enUso = usados.some(u => u.id === c.id);
      console.log(`      ${enUso ? 'EN USO  ' : 'sin uso '} ${c.name}`);
    }
  }

  console.log('\n=== SIN USO (candidatos a archivar) ===');
  for (const c of sinUso) console.log(`  ${c.name}`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
