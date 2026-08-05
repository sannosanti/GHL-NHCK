'use strict';

/**
 * Environment guard. Runs before extract-dataset.js, verify-adapters.js and run.js.
 *
 *   node eval/preflight.js
 *
 * The harness has no code path that sends a WhatsApp message, writes to GHL, calls
 * Wompi or touches Zoho — that is enforced separately by webhook-parity.test.js
 * nivel 3. This is the second layer: even if such a path were introduced, the
 * credentials to use it are not in the process.
 *
 * Fails closed. An unexpected production credential aborts the run rather than
 * warning, because a warning in a 24.000-call job scrolls past.
 */

const REQUERIDAS = [
  { name: 'ANTHROPIC_API_KEY', para: 'baseline Sonnet 4.5' },
  { name: 'OPENAI_API_KEY', para: 'Luna y Terra' },
  { name: 'EVAL_LUNA_MODEL', para: 'id exacto del modelo Luna' },
  { name: 'EVAL_TERRA_MODEL', para: 'id exacto del modelo Terra' },
];

/**
 * Production credentials that must NOT be present. The evaluation only talks to
 * model providers; anything else in the environment is blast radius with no upside.
 */
const PROHIBIDAS = [
  { name: 'WOMPI_PRIVATE_KEY', riesgo: 'genera cobros reales' },
  { name: 'WOMPI_PUBLIC_KEY', riesgo: 'pasarela de pagos' },
  { name: 'WOMPI_INTEGRITY_KEY', riesgo: 'pasarela de pagos' },
  { name: 'GHL_API_KEY', riesgo: 'envía WhatsApp, escribe tags y oportunidades' },
  { name: 'GHL_LOCATION_ID', riesgo: 'identifica la cuenta GHL de producción' },
  { name: 'ZOHO_CLIENT_SECRET', riesgo: 'escribe historias clínicas' },
  { name: 'ZOHO_REFRESH_TOKEN', riesgo: 'escribe historias clínicas' },
  { name: 'ZOHO_CLIENT_ID', riesgo: 'credencial Zoho' },
  { name: 'GROQ_API_KEY', riesgo: 'transcripción de audios de pacientes' },
  {
    name: 'DATABASE_URL',
    riesgo: 'es la conexión de escritura de producción',
    enLugarDe: 'EVAL_DATABASE_URL con un rol de solo lectura (ver eval/readonly-role.sql)',
  },
];

function check() {
  const faltantes = REQUERIDAS.filter(v => !process.env[v.name]);
  const presentes = PROHIBIDAS.filter(v => process.env[v.name]);
  return { faltantes, presentes };
}

function report({ faltantes, presentes }, { requireModelKeys = true } = {}) {
  let fatal = false;

  if (presentes.length) {
    fatal = true;
    console.error('\n⛔ VARIABLES DE PRODUCCIÓN PRESENTES — abortando\n');
    console.error('   La evaluación solo necesita credenciales de proveedores de modelos.');
    console.error('   Cada una de estas amplía el radio de daño sin ningún beneficio:\n');
    for (const v of presentes) {
      console.error(`   · ${v.name} — ${v.riesgo}`);
      if (v.enLugarDe) console.error(`     usar en su lugar: ${v.enLugarDe}`);
    }
    console.error('\n   Sacalas del entorno (no del código) y volvé a correr.\n');
  }

  if (requireModelKeys && faltantes.length) {
    fatal = true;
    console.error('\n⛔ FALTAN CREDENCIALES DE MODELO — abortando\n');
    for (const v of faltantes) console.error(`   · ${v.name} — ${v.para}`);
    console.error('\n   Los ids de modelo van por env porque no se adivinan: un id inválido');
    console.error('   devuelve 404 y se lee como falla de capacidad del modelo.\n');
  }

  if (!fatal) {
    console.log('✓ Entorno aislado: solo credenciales de proveedores de modelos.');
    if (process.env.EVAL_DATABASE_URL) {
      console.log('✓ EVAL_DATABASE_URL presente (verificá que el rol sea de solo lectura:');
      console.log('  node eval/verify-readonly-db.js).');
    }
  }
  return !fatal;
}

/** Called by the other scripts. Throws instead of exiting so callers can decide. */
function assertAislado(opts) {
  if (!report(check(), opts)) {
    throw new Error('preflight: entorno no aislado — ver detalle arriba');
  }
}

if (require.main === module) {
  const requireModelKeys = !process.argv.includes('--solo-db');
  process.exit(report(check(), { requireModelKeys }) ? 0 : 1);
}

module.exports = { check, report, assertAislado, REQUERIDAS, PROHIBIDAS };
