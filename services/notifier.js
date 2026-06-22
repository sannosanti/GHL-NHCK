'use strict';

const fetch = require('node-fetch');
const { env } = require('../config');

const CLIQ_CHANNEL = 'logcarolinanhck';
const CLIQ_COMPANY_ID = '656522263';

let cliqAccessToken = null;
let cliqTokenExpiry = 0;

async function getCliqAccessToken() {
  if (cliqAccessToken && Date.now() < cliqTokenExpiry) return cliqAccessToken;
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
  cliqAccessToken = data.access_token;
  cliqTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cliqAccessToken;
}

async function notify(text) {
  try {
    const token = await getCliqAccessToken();
    const res = await fetch(`https://cliq.zoho.com/company/${CLIQ_COMPANY_ID}/api/v2/channelsbyname/${CLIQ_CHANNEL}/message`, {
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
