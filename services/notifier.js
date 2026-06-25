'use strict';

const fetch = require('node-fetch');
const { env } = require('../config');

const BOT_INCOMING_URL = 'https://cliq.zoho.com/api/v2/bots/carolinastatus/incoming';

async function notify(text) {
  try {
    const token = await getZohoToken();
    const res = await fetch(BOT_INCOMING_URL, {
      method: 'POST',
      headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error('[notifier] Cliq error:', res.status, await res.text());
    else console.log('[notifier] Cliq OK');
  } catch (err) {
    console.error('[notifier] Error posting to Cliq:', err.message);
  }
}

async function getZohoToken() {
  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.zohoCliqClientId,
      client_secret: env.zohoCliqClientSecret,
      refresh_token: env.zohoCliqRefreshToken,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('No token Cliq: ' + JSON.stringify(data));
  return data.access_token;
}

async function notifyError(context, err) {
  const msg = err?.message || String(err);
  const text = `🚨 *Error — ${context}*\n\`${msg}\`\n_${new Date().toLocaleString('es-CO')}_`;
  await notify(text);
}

module.exports = { notify, notifyError };
