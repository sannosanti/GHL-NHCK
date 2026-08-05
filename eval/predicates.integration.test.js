'use strict';

/**
 * INTEGRACIÓN — equivalencia entre los predicados SQL y `assignStratum()`.
 *
 *   EVAL_DATABASE_URL=... node eval/predicates.integration.test.js
 *
 * Cada estrato define su regla dos veces: una en SQL (para la consulta) y otra en
 * JavaScript (para resolver solapamientos). Son dos expresiones de una intención y
 * pueden derivar en silencio — `~*` de PostgreSQL y las expresiones regulares de
 * JavaScript no comparten sintaxis de límite de palabra, ni tratamiento de acentos,
 * ni sensibilidad a mayúsculas por defecto. Los tests unitarios verifican que ambas
 * existan; solo PostgreSQL puede decir si coinciden.
 *
 * ── SIN ESCRITURAS ─────────────────────────────────────────────────────────────
 * No hace INSERT ni necesita ROLLBACK. Las filas sintéticas se construyen con una
 * CTE llamada `conversations`, que en PostgreSQL tiene precedencia sobre la tabla
 * real: el predicado corre contra los datos de prueba sin tocar producción y con
 * permisos de SOLO LECTURA. La transacción va marcada READ ONLY igual, para que un
 * error de escritura futuro falle en el servidor.
 *
 * Este archivo NO entra en `npm run test:eval`: requiere base. Se corre una vez,
 * después de crear el rol y antes de extraer el dataset.
 */

const assert = require('assert');
const { Client } = require('pg');
const { STRATA, assignStratum, textoDe, stratumWhere } = require('./extract-lib');

/**
 * Casos sintéticos. Cada uno existe para tensar una diferencia concreta entre los
 * dos motores de regex, no para cubrir el caso feliz.
 */
const FIXTURES = [
  { id: 'f01', estado: 'triaje_p1', recovery_status: null, texto: 'mi hijo tiene autismo' },
  { id: 'f02', estado: 'triaje_p1', recovery_status: null, texto: 'diagnostico de TEA nivel 1' },
  // `tea` como subcadena: SQL usa \m\M, JavaScript usa \b. Deben coincidir en NO marcarlo.
  { id: 'f03', estado: 'triaje_p1', recovery_status: null, texto: 'le gusta el te y la panetela' },
  { id: 'f04', estado: 'triaje_p1', recovery_status: null, texto: 'la maestra dice que es un TEAtro' },
  { id: 'f05', estado: 'triaje_p1', recovery_status: null, texto: 'sindrome de Asperger' },
  { id: 'f06', estado: 'triaje_p1', recovery_status: null, texto: 'tiene epilepsia controlada' },
  { id: 'f07', estado: 'triaje_p1', recovery_status: null, texto: 'tuvo convulsiones de bebe' },
  // Acentos: `deficit` sin tilde vs `déficit` con tilde.
  { id: 'f08', estado: 'triaje_p1', recovery_status: null, texto: 'deficit de atencion' },
  { id: 'f09', estado: 'triaje_p1', recovery_status: null, texto: 'déficit de atención' },
  { id: 'f10', estado: 'triaje_p1', recovery_status: null, texto: 'TDAH diagnosticado' },
  { id: 'f11', estado: 'triaje_p1', recovery_status: null, texto: 'ansiedad cronica' },
  { id: 'f12', estado: 'triaje_p1', recovery_status: null, texto: 'ansiedad crónica' },
  // Mayúsculas: ambos motores deben ser insensibles.
  { id: 'f13', estado: 'triaje_p1', recovery_status: null, texto: 'AUTISMO' },
  { id: 'f14', estado: 'escalado', recovery_status: null, texto: 'quiero hablar con alguien' },
  { id: 'f15', estado: 'escalado', recovery_status: null, texto: 'mi hijo tiene autismo' },
  { id: 'f16', estado: 'triaje_completo', recovery_status: null, texto: 'listo' },
  { id: 'f17', estado: 'agendando', recovery_status: null, texto: 'el martes' },
  { id: 'f18', estado: 'triaje_p1', recovery_status: null, texto: 'esta muy caro para mi' },
  { id: 'f19', estado: 'triaje_p1', recovery_status: null, texto: 'tienen convenio con COMFAMA?' },
  { id: 'f20', estado: 'triaje_p1', recovery_status: 'intento-1', texto: 'despues hablamos' },
  { id: 'f21', estado: 'nuevo', recovery_status: null, texto: 'buenas' },
  // Solapamiento explícito: clínico + precio.
  { id: 'f22', estado: 'triaje_p1', recovery_status: null, texto: 'tiene autismo y esta muy caro' },
  // Solapamiento: TDAH + precio, sin autismo.
  { id: 'f23', estado: 'triaje_p1', recovery_status: null, texto: 'tiene tdah y no tengo dinero' },
];

/** Cada fixture como fila con la forma que esperan los predicados. */
function comoFila(f, nMensajes = 3) {
  const messages = [{ role: 'user', content: f.texto }];
  for (let i = 1; i < nMensajes; i++) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: `relleno ${i}` });
  }
  return { conversation_id: f.id, estado: f.estado, recovery_status: f.recovery_status, messages };
}

/**
 * CTE con las filas sintéticas. `conversations` sombrea a la tabla real dentro de
 * la consulta, así que el predicado se evalúa contra los fixtures sin leer
 * producción.
 *
 * Los tipos son los de producción, no aproximaciones: `messages` va como `jsonb`
 * porque los predicados hacen `messages::text` y `jsonb_array_length(messages)`.
 * Con `json` (sin b) el `::text` conserva los espacios del original y
 * `jsonb_array_length` ni siquiera existe — un fixture con el tipo equivocado
 * probaría un predicado distinto al que corre en producción.
 */
function cteDeFixtures(filas) {
  const valores = filas.map((_, i) => {
    const b = i * 5;
    return `($${b + 1}::text, $${b + 2}::jsonb, $${b + 3}::text, $${b + 4}::text, $${b + 5}::text)`;
  }).join(',\n           ');
  const params = filas.flatMap(f => [
    f.conversation_id, JSON.stringify(f.messages), f.estado, f.recovery_status, f.agent ?? 'carolina',
  ]);
  return {
    cte: `WITH conversations AS (
            SELECT * FROM (VALUES
           ${valores}
            ) AS t(conversation_id, messages, estado, recovery_status, agent)
          )`,
    params,
  };
}

/** Verifica que los tipos de la CTE coincidan con los de la tabla real. */
async function verificarTipos(client, cte, params) {
  const { rows } = await client.query(
    `${cte} SELECT pg_typeof(messages) AS t_messages,
                   pg_typeof(estado) AS t_estado,
                   pg_typeof(recovery_status) AS t_recovery,
                   jsonb_array_length(messages) AS len
       FROM conversations LIMIT 1`, params);
  return rows[0];
}

async function main() {
  if (!process.env.EVAL_DATABASE_URL) {
    console.log('SKIP — falta EVAL_DATABASE_URL. Este test requiere base; el resto de la suite no.');
    process.exit(0);
  }
  if (process.env.DATABASE_URL) {
    console.error('⛔ DATABASE_URL (producción) está en el entorno. Sacala antes de continuar.');
    process.exit(1);
  }

  const filas = FIXTURES.map(f => comoFila(f, f.id === 'f16' || f.id === 'f17' ? 6 : 3));
  const { cte, params } = cteDeFixtures(filas);

  const client = new Client({ connectionString: process.env.EVAL_DATABASE_URL });
  await client.connect();
  await client.query('BEGIN READ ONLY');

  let fallos = 0;
  try {
    // --- Tipos ---------------------------------------------------------------
    console.log('\nTipos de la CTE vs producción:');
    const t = await verificarTipos(client, cte, params);
    for (const [campo, esperado, real] of [
      ['messages', 'jsonb', t.t_messages], ['estado', 'text', t.t_estado], ['recovery_status', 'text', t.t_recovery],
    ]) {
      if (String(real) === esperado) console.log(`  ok   ${campo} es ${esperado}`);
      else { console.log(`  FAIL ${campo} es ${real}, se esperaba ${esperado}`); fallos++; }
    }
    console.log(`  ok   jsonb_array_length funciona (${t.len} mensajes en la primera fila)`);

    // --- Predicado por predicado, aislado ------------------------------------
    console.log('\nPredicados aislados (SQL vs JS):');
    for (const s of STRATA) {
      const { rows } = await client.query(
        `${cte}
         SELECT conversation_id FROM conversations
          WHERE jsonb_array_length(messages) >= 2 AND (${s.where})
          ORDER BY conversation_id`, params);

      const sql = rows.map(r => r.conversation_id);
      const js = filas.filter(f => s.match({ ...f, _texto: textoDe(f) })).map(f => f.conversation_id);
      const soloSql = sql.filter(x => !js.includes(x));
      const soloJs = js.filter(x => !sql.includes(x));

      if (!soloSql.length && !soloJs.length) {
        console.log(`  ok   ${s.id.padEnd(20)} ${sql.length} filas`);
      } else {
        fallos++;
        console.log(`  FAIL ${s.id}`);
        if (soloSql.length) console.log(`       solo SQL: ${soloSql.join(', ')}`);
        if (soloJs.length) console.log(`       solo JS:  ${soloJs.join(', ')}`);
        console.log(`       SQL: ${s.where}`);
      }
    }

    // --- La asignación FINAL, que es lo que decide el muestreo ---------------
    // Que cada regex coincida por separado no implica que la asignación coincida:
    // "primera coincidencia gana" depende del ORDEN y de la exclusión, y un
    // desacuerdo en un estrato temprano reordena todo lo que viene después.
    console.log('\nAsignación final — stratumWhere(i) en SQL vs assignStratum() en JS:');
    const asignacionSql = {};
    for (let i = 0; i < STRATA.length; i++) {
      const { rows } = await client.query(
        `${cte}
         SELECT conversation_id FROM conversations
          WHERE jsonb_array_length(messages) >= 2 AND ${stratumWhere(STRATA, i)}
          ORDER BY conversation_id`, params);
      for (const r of rows) {
        if (asignacionSql[r.conversation_id]) {
          console.log(`  FAIL ${r.conversation_id} asignada a DOS estratos: ` +
            `${asignacionSql[r.conversation_id]} y ${STRATA[i].id} — la exclusión no es mutua`);
          fallos++;
        }
        asignacionSql[r.conversation_id] = STRATA[i].id;
      }
    }

    let desacuerdos = 0;
    for (const f of filas) {
      const js = assignStratum(f)?.id ?? null;
      const sql = asignacionSql[f.conversation_id] ?? null;
      const ok = js === sql;
      if (!ok) { desacuerdos++; fallos++; }
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${f.conversation_id}  SQL=${String(sql).padEnd(20)} JS=${String(js).padEnd(20)} ${textoDe(f).slice(0, 34)}`);
    }
    if (!desacuerdos) console.log(`  → las ${filas.length} filas se asignan igual en ambos motores`);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }

  console.log(fallos === 0
    ? `\n✓ Los ${STRATA.length} predicados SQL coinciden con assignStratum() sobre ${filas.length} filas sintéticas.`
    : `\n⛔ ${fallos} predicado(s) divergen. La eval mediría estratos distintos a los que la consulta trae.`);
  process.exit(fallos ? 1 : 0);
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exit(1); });

module.exports = { FIXTURES, comoFila, cteDeFixtures, verificarTipos };
