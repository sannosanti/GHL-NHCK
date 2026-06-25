'use strict';

const fetch = require('node-fetch');
const { env } = require('../config');

const NOTIFY_EMAIL = 'desarrollo@te-m.co';

let mailToken = null;
let mailTokenExpiry = 0;
let mailAccount = null;

async function getMailToken() {
  if (mailToken && Date.now() < mailTokenExpiry) return mailToken;
  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.zohoClientId,
      client_secret: env.zohoClientSecret,
      refresh_token: env.zohoRefreshToken,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('No mail token: ' + JSON.stringify(data));
  mailToken = data.access_token;
  mailTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return mailToken;
}

async function getMailAccount(token) {
  if (mailAccount) return mailAccount;
  const res = await fetch('https://mail.zoho.com/api/accounts', {
    headers: { 'Authorization': `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  const acc = data?.data?.[0];
  if (!acc?.accountId) throw new Error('No mail account: ' + JSON.stringify(data));
  mailAccount = { id: acc.accountId, email: acc.sendMailDetails?.[0]?.fromAddress || acc.emailAddress };
  return mailAccount;
}

async function notify(text) {
  try {
    const token = await getMailToken();
    const acc = await getMailAccount(token);
    const subject = text.split('\n')[0].replace(/[*_🧠🚨✅]/g, '').trim().slice(0, 80);
    const res = await fetch(`https://mail.zoho.com/api/accounts/${acc.id}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromAddress: acc.email,
        toAddress: NOTIFY_EMAIL,
        subject: subject || 'Notificación Carolina',
        content: text.replace(/[*_]/g, ''),
        mailFormat: 'plaintext',
      }),
    });
    const result = await res.json();
    if (!res.ok) console.error('[notifier] Mail error:', res.status, JSON.stringify(result));
    else console.log('[notifier] Email enviado a', NOTIFY_EMAIL);
  } catch (err) {
    console.error('[notifier] Error enviando email:', err.message);
  }
}

async function notifyError(context, err) {
  const msg = err?.message || String(err);
  await notify(`Error — ${context}\n${msg}\n${new Date().toLocaleString('es-CO')}`);
}

module.exports = { notify, notifyError };
