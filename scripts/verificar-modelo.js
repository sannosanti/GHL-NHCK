'use strict';

/**
 * Una sola llamada a la API para probar que el MODEL_ID configurado existe.
 *
 *   node scripts/verificar-modelo.js
 *
 * Lee el id del propio ai/claude.js, no de una constante repetida acá: la idea
 * es probar lo que produccion va a usar de verdad, no lo que creemos que usa.
 *
 * Cuesta fracciones de centavo. Si el id es incorrecto la API devuelve 404 y
 * TODOS los mensajes de los dos bots fallarian al desplegar.
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'claude.js'), 'utf8');
// Se resuelve igual que en produccion: la variable de entorno gana, y si no
// esta se usa el literal de respaldo del propio ai/claude.js. La version
// anterior buscaba solo el literal y dejo de encontrarlo cuando el codigo paso
// a `process.env.CLAUDE_MODEL_ID || '...'`.
const respaldo = (src.match(/const MODEL_ID = (?:process\.env\.CLAUDE_MODEL_ID \|\| )?'([^']+)'/) || [])[1];
const MODEL_ID = process.env.CLAUDE_MODEL_ID || respaldo;
// Búsqueda literal, no regex: el id lleva guiones y la expresión pasaba por dos
// capas de escapado, así que daba falso negativo. Como clave sólo puede aparecer
// en PRICING — la línea de MODEL_ID no lleva dos puntos después de la comilla.
const enPricing = !!MODEL_ID && src.includes(`'${MODEL_ID}':`);

const key = process.env.ANTHROPIC_API_KEY;

console.log(`modelo configurado : ${MODEL_ID || '(no se pudo leer)'}`);
console.log(`fila en PRICING    : ${enPricing ? 'sí' : 'NO — el costo se registraría como $0'}`);

if (!key) {
  console.error('\n⛔ Falta ANTHROPIC_API_KEY en el entorno.');
  console.error('   La clave vive en Railway, no en este repo (no hay .env).');
  console.error('   Opciones: `railway run node scripts/verificar-modelo.js`,');
  console.error('   o exportarla en esta terminal antes de correr el script.');
  process.exit(2);
}

(async () => {
  const t = Date.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Respondé exactamente: LISTO' }],
    }),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    console.error(`\n⛔ HTTP ${r.status} — ${data?.error?.type || 'error'}`);
    console.error(`   ${data?.error?.message || '(sin mensaje)'}`);
    if (r.status === 404) {
      console.error('\n   El id del modelo NO existe o no está habilitado en esta cuenta.');
      console.error('   NO DESPLIEGUES: al hacerlo fallarían todos los mensajes.');
    }
    if (r.status === 401) console.error('\n   La clave es inválida. El id del modelo queda sin probar.');
    process.exit(1);
  }

  // NO ALCANZA CON QUE RESPONDA.
  //
  // El 2026-08-19 se desplego Sonnet 5 y el bot quedo mudo para muchos pacientes:
  // el modelo devolvia content: [{type:'thinking'},{type:'text'}] y el codigo leia
  // content[0].text. Una prueba con un prompt trivial daba OK, porque un prompt
  // trivial no hace razonar al modelo — este mismo script habria aprobado el bug.
  //
  // Por eso ademas de llamar se ejerce el MISMO extractor que usa produccion,
  // contra la respuesta real y contra la forma con razonamiento.
  const a = src.indexOf('  const texto = (data.content');
  const b = src.indexOf(';', src.indexOf('return texto.replace', a));
  if (a === -1 || b === -1) {
    console.error('\n⛔ No se pudo aislar el extractor de ai/claude.js. Revisalo a mano.');
    process.exit(1);
  }
  const extraer = new Function('data', src.slice(a, b + 1));
  try {
    if (!extraer(data)) throw new Error('el extractor devolvio vacio con la respuesta real');
    const conRazonamiento = extraer({
      content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    });
    if (conRazonamiento !== 'ok') throw new Error('no maneja el bloque de razonamiento');
    console.log('\n✅ ai/claude.js lee bien la respuesta real y la forma con razonamiento.');
  } catch (err) {
    console.error(`\n⛔ El modelo responde, pero ai/claude.js NO puede leerlo: ${err.message}`);
    console.error('   Es la falla del 2026-08-19: el bot no enviaria nada al paciente. NO DESPLIEGUES.');
    process.exit(1);
  }

  console.log(`\n✅ El modelo responde. HTTP 200 en ${Date.now() - t} ms.`);
  console.log(`   texto : ${JSON.stringify(data?.content?.[0]?.text || '')}`);
  console.log(`   uso   : ${JSON.stringify(data?.usage || {})}`);
  console.log('\n   El id es correcto. Se puede desplegar.');
})().catch(err => {
  console.error('\n⛔ Fallo de red o de transporte:', err.message);
  console.error('   El id del modelo queda SIN probar.');
  process.exit(1);
});
