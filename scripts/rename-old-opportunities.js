'use strict';

/**
 * Renames legacy `NHC Kids - <nombre>` opportunities to `Neuromapeo NHCK - <nombre>`.
 *
 * Until commit 7cf3e86 (2026-07-10) there was a single bot and every opportunity
 * was created as `NHC Kids - X`. Splitting Carolina and Luisa changed the naming
 * to `Neuromapeo NHCK` / `Neuromapeo NHC` so the prefix tells you which bot
 * brought the lead, but GHL does not rename anything retroactively — the older
 * records kept the old prefix, so the pipeline shows three naming patterns.
 *
 * Only the prefix changes. The patient's name, value, stage, status and contact
 * are left exactly as they are.
 *
 * All of these are Kids opportunities by definition: the old name predates Luisa
 * existing, so there is no ambiguity about which prefix they should get.
 *
 * Run against the deployment's environment so GHL_API_KEY / GHL_LOCATION_ID are
 * present. ALWAYS dry-run first and read the output:
 *
 *   railway run node scripts/rename-old-opportunities.js --dry-run
 *   railway run node scripts/rename-old-opportunities.js
 *
 * Idempotent: renamed records no longer match the old prefix, so re-running
 * after a partial failure only retries what is left.
 */

const { env, constants } = require('../config');

const PREFIJO_VIEJO = 'NHC Kids - ';
const PREFIJO_NUEVO = 'Neuromapeo NHCK - ';

// GHL rejects bursts. One request at a time with a gap keeps the whole run under
// the rate limit without needing retry bookkeeping.
const DELAY_MS = 300;
const PAGE_SIZE = 100;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const headers = {
  'Authorization': `Bearer ${env.ghlKey}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
};

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
  return body;
}

// Walks the whole pipeline. GHL's search endpoint pages via startAfterId +
// startAfter; when a page comes back short we are done.
async function listarOportunidades() {
  const todas = [];
  let startAfter = null;
  let startAfterId = null;

  for (;;) {
    const params = new URLSearchParams({
      location_id: env.ghlLocationId,
      pipeline_id: constants.GHL_PIPELINE_ID,
      limit: String(PAGE_SIZE),
    });
    if (startAfter) params.set('startAfter', startAfter);
    if (startAfterId) params.set('startAfterId', startAfterId);

    const data = await fetchJson(`https://services.leadconnectorhq.com/opportunities/search?${params}`);
    const lote = data?.opportunities || [];
    todas.push(...lote);
    process.stdout.write(`\r  leídas ${todas.length} oportunidades...`);

    if (lote.length < PAGE_SIZE) break;
    const ultima = lote[lote.length - 1];
    startAfterId = ultima.id;
    startAfter = ultima.createdAt ? new Date(ultima.createdAt).getTime() : null;
    if (!startAfterId) break;
    await sleep(DELAY_MS);
  }
  process.stdout.write('\n');
  return todas;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!env.ghlKey || !env.ghlLocationId) {
    throw new Error('Faltan GHL_API_KEY / GHL_LOCATION_ID — corré esto con `railway run`.');
  }

  console.log(dryRun ? '=== DRY RUN — no se escribe nada ===' : '=== EJECUCIÓN REAL ===');
  console.log(`Pipeline: ${constants.GHL_PIPELINE_ID}`);

  const todas = await listarOportunidades();
  const objetivo = todas.filter(o => typeof o.name === 'string' && o.name.startsWith(PREFIJO_VIEJO));

  // Names already using the current prefixes, reported so the totals reconcile
  // with what the pipeline shows on screen.
  const yaNuevas = todas.filter(o => typeof o.name === 'string' &&
    (o.name.startsWith('Neuromapeo NHCK - ') || o.name.startsWith('Neuromapeo NHC - '))).length;
  const otras = todas.length - objetivo.length - yaNuevas;

  console.log(`\nTotal en el pipeline : ${todas.length}`);
  console.log(`  ya con prefijo nuevo: ${yaNuevas}`);
  console.log(`  a renombrar         : ${objetivo.length}`);
  console.log(`  otros nombres       : ${otras}`);

  if (!objetivo.length) { console.log('\nNada que renombrar.'); return; }

  console.log('\nEjemplos del cambio:');
  for (const o of objetivo.slice(0, 5)) {
    console.log(`  "${o.name}"  ->  "${PREFIJO_NUEVO}${o.name.slice(PREFIJO_VIEJO.length)}"`);
  }

  if (dryRun) {
    console.log(`\nDry run — ${objetivo.length} quedarían renombradas. Nada fue modificado.`);
    return;
  }

  let ok = 0;
  const fallidas = [];

  for (const [i, o] of objetivo.entries()) {
    const nuevo = PREFIJO_NUEVO + o.name.slice(PREFIJO_VIEJO.length);
    try {
      // Only `name` is sent: PUT on this endpoint merges, and sending stage or
      // status would risk moving a card that a human already advanced by hand.
      await fetchJson(`https://services.leadconnectorhq.com/opportunities/${o.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: nuevo }),
      });
      ok++;
    } catch (err) {
      fallidas.push({ id: o.id, name: o.name, error: err.message });
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${objetivo.length}`);
    await sleep(DELAY_MS);
  }

  console.log(`\nRenombradas ${ok}/${objetivo.length}.`);
  if (fallidas.length) {
    console.error(`${fallidas.length} fallaron — volvé a correr el script para reintentarlas:`);
    for (const f of fallidas) console.error(`  ${f.id} "${f.name}": ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch(err => { console.error('\nAbortado:', err.message); process.exitCode = 1; });
