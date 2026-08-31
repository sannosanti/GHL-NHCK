// Compara Carolina (GHL-NHCK) y Luisa (GHL-NHC-temp) función por función.
//
// Son repos separados sincronizados A MANO, así que un arreglo aplicado en uno
// puede quedar sin portar en el otro durante semanas. Ya pasó con la evaluación
// previa de 30 minutos, con el prompt de disponibilidad y con la ventana de 60
// días: en todos los casos lo descubrió un paciente, no nosotros.
//
// Marca tres cosas:
//   SOLO EN ...   la función existe en un repo y no en el otro
//   DISTINTA      existe en los dos pero el cuerpo difiere
//   =             igual (ignorando comentarios, espacios y los nombres de marca)
//
//   node scripts/comparar-repos.js [--detalle nombreFuncion]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const A = { nombre: 'Carolina', raiz: path.join(__dirname, '..') };
const B = { nombre: 'Luisa', raiz: 'C:/Users/sanch/GHL-NHC-temp' };
const ARCHIVOS = ['services/zoho.js', 'services/ghl.js', 'webhooks/ghl.js', 'webhooks/zoho.js', 'db/index.js', 'ai/prompt.js'];

// Se normaliza lo que legítimamente difiere entre marcas: si no, TODO sale
// distinto y el informe no sirve para encontrar lo que de verdad quedó sin portar.
const normalizar = (t) => t
  .replace(/\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\bcarolina\b|\bluisa\b/gi, 'AGENTE')
  .replace(/\bnhck\b|\bnhc\b/gi, 'MARCA')
  .replace(/HORARIOS_MARCA/g, 'HORARIOS')
  .replace(/\s+/g, ' ')
  .trim();

function funciones(ruta) {
  if (!fs.existsSync(ruta)) return new Map();
  // Se normalizan los finales de linea ANTES de partir: Carolina tiene CRLF y
  // Luisa LF, asi que comparar la linea de cierre contra '}' fallaba en un repo
  // y no en el otro. El extractor seguia leyendo mas alla del final de cada
  // funcion y TODAS las diferencias de tamano salian infladas.
  const bruto = fs.readFileSync(ruta, 'utf8');
  const CR = String.fromCharCode(13);
  const lineas = bruto.split(String.fromCharCode(10))
    .map(l => (l.endsWith(CR) ? l.slice(0, -1) : l));
  const mapa = new Map();
  let actual = null, cuerpo = [];
  for (const l of lineas) {
    const m = l.match(/^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
    if (m) {
      if (actual) mapa.set(actual, cuerpo.join('\n'));
      actual = m[1]; cuerpo = [l];
    } else if (actual) {
      cuerpo.push(l);
      if (l === '}') { mapa.set(actual, cuerpo.join('\n')); actual = null; cuerpo = []; }
    }
  }
  if (actual) mapa.set(actual, cuerpo.join('\n'));
  return mapa;
}

const hash = t => crypto.createHash('sha1').update(normalizar(t)).digest('hex').slice(0, 8);

const detalle = process.argv.includes('--detalle') ? process.argv[process.argv.indexOf('--detalle') + 1] : null;
let distintas = 0, soloA = 0, soloB = 0, iguales = 0;

for (const rel of ARCHIVOS) {
  const fa = funciones(path.join(A.raiz, rel));
  const fb = funciones(path.join(B.raiz, rel));
  const nombres = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  const lineasArchivo = [];

  for (const n of nombres) {
    const a = fa.get(n), b = fb.get(n);
    if (a && !b) { soloA++; lineasArchivo.push(`  SOLO EN ${A.nombre.padEnd(9)} ${n}`); }
    else if (!a && b) { soloB++; lineasArchivo.push(`  SOLO EN ${B.nombre.padEnd(9)} ${n}`); }
    else if (hash(a) !== hash(b)) {
      distintas++;
      const dl = Math.abs(a.split('\n').length - b.split('\n').length);
      lineasArchivo.push(`  DISTINTA           ${n}   (${a.split('\n').length} vs ${b.split('\n').length} líneas${dl ? `, ${dl} de diferencia` : ''})`);
      if (detalle === n) {
        console.log(`\n===== ${n} en ${A.nombre} =====\n${a}\n\n===== ${n} en ${B.nombre} =====\n${b}\n`);
      }
    } else iguales++;
  }

  if (lineasArchivo.length) {
    console.log(`\n### ${rel}`);
    for (const l of lineasArchivo) console.log(l);
  }
}

console.log(`\n--- RESUMEN ---`);
console.log(`iguales: ${iguales} | distintas: ${distintas} | sólo en ${A.nombre}: ${soloA} | sólo en ${B.nombre}: ${soloB}`);
console.log(`\nVer una: node scripts/comparar-repos.js --detalle <nombreFuncion>`);
