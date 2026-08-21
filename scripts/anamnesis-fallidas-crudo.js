// Lista anamnesis_fallidas de la base que indique DATABASE_URL. Sirve para
// consultar la base de Luisa desde este repo cuando el suyo no tiene
// node_modules instalado:
//
//   cd ../GHL-NHC-temp && railway run node ../GHL-NHCK/scripts/anamnesis-fallidas-crudo.js
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT id, agent, formulario, nombre, movil, etapa,
            to_char(creado_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota','DD/MM/YYYY HH24:MI') AS hora,
            recuperado_at IS NOT NULL AS recuperada,
            COALESCE(error->>'code', left(error::text, 40)) AS motivo
     FROM anamnesis_fallidas ORDER BY id DESC LIMIT 30`
  );
  console.log(`filas: ${rows.length}`);
  for (const r of rows) {
    console.log(`  #${r.id} ${r.hora}  ${String(r.formulario).padEnd(8)} ${String(r.etapa).padEnd(17)} ${String(r.nombre || '(sin nombre)').slice(0, 32).padEnd(34)} ${r.recuperada ? 'recuperada' : 'PENDIENTE'}  ${r.motivo || ''}`);
  }
  await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
