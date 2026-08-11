'use strict';

/**
 * Backfills the `linea-nhck` / `linea-nhc` tag onto contacts that already have
 * conversations, so reminder workflows in GHL can pick their "from" number by
 * the line the patient actually writes to.
 *
 * The source of truth is `conversations.agent`, which is stamped with this
 * deployment's AGENT_NAME when the row is written — it records the line the
 * message arrived on, not the brand the patient belongs to. Those two diverge
 * (see the LINEA_TAG comment in webhooks/ghl.js), which is exactly why brand
 * tags can't be reused here.
 *
 * A contact that wrote to both lines gets both tags: that is accurate, and the
 * workflow should then prefer the line of the most recent conversation.
 *
 * Run against the deployment's environment so GHL_API_KEY / GHL_LOCATION_ID and
 * DATABASE_URL are present:
 *
 *   railway run node scripts/backfill-linea-tags.js --dry-run
 *   railway run node scripts/backfill-linea-tags.js
 *
 * Idempotent: re-adding an existing tag is a no-op in GHL, so re-running after
 * a partial failure is safe.
 */

const db = require('../db');
const ghl = require('../services/ghl');

const AGENT_TO_TAG = { luisa: 'linea-nhc', carolina: 'linea-nhck' };

// GHL's API rejects bursts. One request at a time with a small gap keeps the
// whole backfill under the rate limit without needing retry bookkeeping.
const DELAY_MS = 250;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const { rows } = await db.pool.query(`
    SELECT DISTINCT contact_id, agent
    FROM conversations
    WHERE contact_id IS NOT NULL AND agent IS NOT NULL
    ORDER BY contact_id
  `);

  // Rows whose agent isn't one we know about would otherwise be tagged
  // `undefined`. Surface them instead of writing garbage into GHL.
  const targets = [];
  const unknownAgents = new Set();
  for (const { contact_id, agent } of rows) {
    const tag = AGENT_TO_TAG[agent];
    if (tag) targets.push({ contactId: contact_id, tag });
    else unknownAgents.add(agent);
  }

  if (unknownAgents.size) {
    console.warn('SKIPPED unmapped agent values:', [...unknownAgents].join(', '));
  }

  const perTag = targets.reduce((acc, t) => ({ ...acc, [t.tag]: (acc[t.tag] || 0) + 1 }), {});
  console.log(`${rows.length} conversation rows -> ${targets.length} contact/tag pairs`, perTag);

  if (dryRun) {
    console.log('Dry run — nothing written.');
    return;
  }

  let ok = 0;
  const failed = [];

  for (const [i, { contactId, tag }] of targets.entries()) {
    try {
      await ghl.addTag(contactId, tag);
      ok++;
    } catch (err) {
      failed.push({ contactId, tag, error: err.message });
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${targets.length}`);
    await sleep(DELAY_MS);
  }

  console.log(`Tagged ${ok}/${targets.length}.`);
  if (failed.length) {
    console.error(`${failed.length} failed — re-run to retry:`);
    for (const f of failed) console.error(`  ${f.contactId} ${f.tag}: ${f.error}`);
  }
}

main()
  .catch(err => { console.error('Backfill aborted:', err); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
