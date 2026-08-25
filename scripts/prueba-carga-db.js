// Prueba de carga contra la base: simula respuestas simultáneas. No manda
// mensajes ni toca GHL.
//
// Guarda el MOTIVO de cada fallo: una versión anterior sólo contaba fallos y
// dio números sin sentido (lotes "rapidísimos" con 100% de error, que era un
// pool ya roto arrastrándose entre pruebas, no una medición).
const { Pool } = require('pg');
const dormir = ms => new Promise(r => setTimeout(r, ms));

const cicloDeRespuesta = async (pool) => {
  await pool.query('SELECT 1 FROM conversations WHERE conversation_id=$1', ['x']);
  await pool.query('SELECT 1 FROM contact_cache WHERE contact_id=$1', ['x']);
  await pool.query("SELECT count(*) FROM conversations WHERE updated_at > NOW() - INTERVAL '1 day'");
};

(async () => {
  for (const max of [10, 20]) {
    console.log(`\n--- pool de ${max} ---`);
    for (const simultaneas of [5, 10, 20, 40]) {
      // Un pool nuevo por lote: así un fallo no contamina la medición siguiente.
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max });
      pool.on('error', () => {});
      const t0 = Date.now();
      const res = await Promise.allSettled(Array.from({ length: simultaneas }, () => cicloDeRespuesta(pool)));
      const ms = Date.now() - t0;
      const fallos = res.filter(r => r.status === 'rejected');
      const motivo = fallos.length ? ` | ${fallos[0].reason?.message?.slice(0, 60)}` : '';
      console.log(`  ${String(simultaneas).padStart(2)} simultáneas -> ${String(ms).padStart(6)} ms   ${fallos.length ? `FALLOS ${fallos.length}/${simultaneas}` : 'sin fallos'}${motivo}`);
      await pool.end().catch(() => {});
      await dormir(1500);
    }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
