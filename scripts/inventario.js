// Inventario de los dos repos por módulo: cuántos archivos, cuántas líneas y
// qué contiene cada uno. Sirve para dimensionar el sistema de un vistazo.
//
//   node scripts/inventario.js [--json]
const fs = require('fs');
const path = require('path');

const REPOS = [
  { nombre: 'Carolina', clave: 'nhck', raiz: path.join(__dirname, '..') },
  { nombre: 'Luisa', clave: 'nhc', raiz: 'C:/Users/sanch/GHL-NHC-temp' },
];
const IGNORAR = /node_modules|\.git|creados\.ndjson|resultados|plan.*\.json|cuarentena|huerfanas|ruteo|eval\/(gold|out)/;

function recorrer(raiz, rel = '') {
  const dir = path.join(raiz, rel);
  if (!fs.existsSync(dir)) return [];
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (IGNORAR.test(r)) continue;
    if (e.isDirectory()) out = out.concat(recorrer(raiz, r));
    else if (/\.(js|html)$/.test(e.name)) {
      const t = fs.readFileSync(path.join(raiz, r), 'utf8');
      const lineas = t.split(/\r?\n/);
      out.push({
        ruta: r,
        modulo: rel.split('/')[0] || '(raíz)',
        total: lineas.length,
        // Código real: sin líneas vacías ni comentarios de una línea.
        codigo: lineas.filter(l => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)).length,
        funciones: (t.match(/^(?:async\s+)?function\s+\w+|^\s*const\s+\w+\s*=\s*(?:async\s*)?\(/gm) || []).length,
      });
    }
  }
  return out;
}

const datos = {};
for (const r of REPOS) {
  const archivos = recorrer(r.raiz);
  const porModulo = {};
  for (const a of archivos) {
    const m = porModulo[a.modulo] = porModulo[a.modulo] || { archivos: 0, total: 0, codigo: 0, funciones: 0, lista: [] };
    m.archivos++; m.total += a.total; m.codigo += a.codigo; m.funciones += a.funciones;
    m.lista.push({ ruta: a.ruta, codigo: a.codigo });
  }
  for (const m of Object.values(porModulo)) m.lista.sort((x, y) => y.codigo - x.codigo);
  datos[r.nombre] = { porModulo, totalArchivos: archivos.length, totalCodigo: archivos.reduce((s, a) => s + a.codigo, 0) };
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(datos, null, 1));
} else {
  for (const [nombre, d] of Object.entries(datos)) {
    console.log(`\n=== ${nombre} — ${d.totalArchivos} archivos, ${d.totalCodigo} líneas de código ===`);
    const mods = Object.entries(d.porModulo).sort((a, b) => b[1].codigo - a[1].codigo);
    for (const [m, v] of mods) {
      console.log(`  ${m.padEnd(14)} ${String(v.archivos).padStart(3)} arch  ${String(v.codigo).padStart(6)} líneas  ${String(v.funciones).padStart(3)} fn`);
      for (const f of v.lista.slice(0, 3)) console.log(`       ${String(f.codigo).padStart(5)}  ${f.ruta}`);
    }
  }
}
