'use strict';

const fetch = require('node-fetch');
const { getZohoAccessToken } = require('./zoho');

const CLIQ_CHANNEL = 'NHCKCARO';

async function notify(text) {
  try {
    const token = await getZohoAccessToken();
    const res = await fetch(`https://cliq.zoho.com/api/v2/channelsbyname/${CLIQ_CHANNEL}/message`, {
      method: 'POST',
      headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error('[notifier] Cliq error:', res.status, await res.text());
  } catch (err) {
    console.error('[notifier] Error posting to Cliq:', err.message);
  }
}

async function notifyError(context, err) {
  const msg = err?.message || String(err);
  const text = `🚨 *Error — ${context}*\n\`${msg}\`\n_${new Date().toLocaleString('es-CO')}_`;
  await notify(text);
}

module.exports = { notify, notifyError };
