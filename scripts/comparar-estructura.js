// Compara la ESTRUCTURA de los dos repos, no sólo las funciones.
//
// comparar-repos.js mira seis archivos y funciones de primer nivel. Se le
// escapan: archivos que existen en un repo y no en el otro, endpoints HTTP,
// jobs programados y símbolos exportados. Un arreglo puede vivir en un archivo
// que el otro repo ni siquiera tiene.
//
//   node scripts/comparar-estructura.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const A = { nombre: 'Carolina', raiz: path.join(__dirname, '..') };
const B = { nombre: 'Luisa', raiz: 'C:/Users/sanch/GHL-NHC-temp' };
const IGNORAR = /node_modules|\.git|\.env|creados\.ndjson|resultados|plan.*\.json|cuarentena|huerfanas|ruteo|eval\/(gold|out)/;

function archivos(raiz, rel = '') {
  const dir = path.join(raiz, rel);
  if (!fs.existsSync(dir)) return [];
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (IGNORAR.test(r)) continue;
    if (e.isDirectory()) out = out.concat(archivos(raiz, r));
    else if (/\.(js|json|html|md)$/.test(e.name)) out.push(r);
  }
  return out;
}

const normalizar = t => t
  .replace(/\r\n/g, '\n')
  .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\bcarolina\b|\bluisa\b/gi, 'AGENTE')
  .replace(/\bnhck\b|\bnhc\b/gi, 'MARCA')
  .replace(/\s+/g, ' ').trim();
const hash = t => crypto.createHash('sha1').update(normalizar(t)).digest('hex').slice(0, 10);

const fa = archivos(A.raiz), fb = archivos(B.raiz);
const todos = [...new Set([...fa, ...fb])].sort();

const soloA = [], soloB = [], distintos = [], iguales = [];
for (const r of todos) {
  const ea = fa.includes(r), eb = fb.includes(r);
  if (ea && !eb) soloA.push(r);
  else if (!ea && eb) soloB.push(r);
  else {
    const ha = hash(fs.readFileSync(path.join(A.raiz, r), 'utf8'));
    const hb = hash(fs.readFileSync(path.join(B.raiz, r), 'utf8'));
    (ha === hb ? iguales : distintos).push(r);
  }
}

const bloque = (titulo, xs) => {
  if (!xs.length) return;
  console.log(`\n### ${titulo} (${xs.length})`);
  for (const x of xs) console.log(`   ${x}`);
};

console.log(`archivos: ${A.nombre} ${fa.length} | ${B.nombre} ${fb.length} | iguales ${iguales.length}`);
bloque(`SÓLO en ${A.nombre}`, soloA.filter(r => !r.startsWith('scripts/')));
bloque(`SÓLO en ${B.nombre}`, soloB.filter(r => !r.startsWith('scripts/')));
bloque('DISTINTOS (mismo archivo, distinto contenido)', distintos);
const scriptsA = soloA.filter(r => r.startsWith('scripts/')).length;
const scriptsB = soloB.filter(r => r.startsWith('scripts/')).length;
if (scriptsA || scriptsB) console.log(`\n(además, scripts propios: ${A.nombre} ${scriptsA}, ${B.nombre} ${scriptsB} — herramientas, no comportamiento)`);

// Endpoints y jobs: lo que el servidor expone y lo que corre solo.
const listar = (raiz, rel, re) => {
  const f = path.join(raiz, rel);
  if (!fs.existsSync(f)) return [];
  return [...fs.readFileSync(f, 'utf8').matchAll(re)].map(m => m[1] || m[0]);
};
for (const [titulo, rel, re] of [
  ['ENDPOINTS', 'server.js', /app\.(?:get|post)\('([^']+)'/g],
  ['JOBS arrancados', 'server.js', /(iniciar[A-Za-z]+|cron\.schedule)/g],
]) {
  const ea = listar(A.raiz, rel, re), eb = listar(B.raiz, rel, re);
  const soloEnA = ea.filter(x => !eb.includes(x));
  const soloEnB = eb.filter(x => !ea.includes(x));
  console.log(`\n### ${titulo}   ${A.nombre}: ${ea.length} | ${B.nombre}: ${eb.length}`);
  for (const x of soloEnA) console.log(`   sólo ${A.nombre}: ${x}`);
  for (const x of soloEnB) console.log(`   sólo ${B.nombre}   : ${x}`);
  if (!soloEnA.length && !soloEnB.length) console.log('   (los mismos en ambos)');
}
