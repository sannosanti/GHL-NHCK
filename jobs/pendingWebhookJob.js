'use strict';

const cron = require('node-cron');
const db = require('../db');
const ghl = require('../services/ghl');
const { notifyError } = require('../services/notifier');

// GHL's /conversations/search index lags the real write by an unpredictable
// amount (observed 20s+ in production, even for hours-old conversations, not
// just brand-new contacts). Rather than block the webhook request or rely on
// an in-memory retry that dies on the next deploy, unresolved webhooks are
// queued in pending_webhooks and retried here every minute until GHL catches up.
const MAX_ATTEMPTS = 15;

async function runPendingWebhookJob() {
  const rows = await db.getPendingWebhooks();
  if (!rows.length) return;

  console.log(`[pendingWebhookJob] Checking ${rows.length} pending webhook(s)`);

  for (const row of rows) {
    const { contact_id, payload, attempts } = row;

    try {
      if (attempts >= MAX_ATTEMPTS) {
        console.error(`[pendingWebhookJob] Giving up on contact ${contact_id} after ${attempts} attempts`);
        await notifyError(`pendingWebhookJob contact ${contact_id}`, new Error('Message never became readable in GHL after max retries — needs manual follow-up')).catch(() => {});
        await db.deletePendingWebhook(contact_id);
        continue;
      }

      const conversationId = await ghl.getConversationId(contact_id);
      if (!conversationId) {
        await db.bumpPendingWebhookAttempt(contact_id);
        continue;
      }

      // GHL has caught up — remove from the queue before replaying so a fresh
      // inbound message during processing queues its own retry instead of
      // being silently absorbed into this one.
      await db.deletePendingWebhook(contact_id);

      const { ghlWebhookHandler } = require('../webhooks/ghl');
      const fakeRes = { json: () => {} };
      await ghlWebhookHandler({ body: payload }, fakeRes);
      console.log(`[pendingWebhookJob] Replayed webhook for contact ${contact_id}`);
    } catch (err) {
      console.error(`[pendingWebhookJob] Error processing contact ${contact_id}:`, err.message);
      await db.bumpPendingWebhookAttempt(contact_id);
    }
  }
}

function startPendingWebhookJob() {
  cron.schedule('* * * * *', () => {
    runPendingWebhookJob().catch(err => console.error('[pendingWebhookJob] Unhandled error:', err.message));
  });
  console.log('Pending webhook job scheduled (every 1 minute) ✓');
}

module.exports = { startPendingWebhookJob };
