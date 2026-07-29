'use strict';

const fetch = require('node-fetch');
const { env } = require('../config');
const db = require('../db');

const MODEL_ID = 'claude-sonnet-4-5';

// $/MTok, from platform.claude.com/docs/en/about-claude/pricing (checked 2026-07-16).
// cacheWrite here is the 1-hour-TTL rate (2x base input), not the 5-minute
// rate (1.25x) — buildSystemPrompt's conversational callers run at ~15
// calls/hour per brand, frequent enough that the 1h TTL (set below via
// cache_control.ttl) avoids paying constant cache-write churn on the 5m TTL.
const PRICING = {
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 6, cacheRead: 0.30 },
};

// Anthropic beta header required to request the 1-hour cache TTL instead of
// the 5-minute default (verify against current docs before relying on it —
// checked 2026-07-16).
const CACHE_BETA_HEADER = 'extended-cache-ttl-2025-04-11';

// The Anthropic API rejects the whole request when any text block is empty
// ("messages: text content blocks must be non-empty"), and empty blocks do
// reach here: a GHL media webhook can arrive before its transcription exists
// (`MEDIA19: no content found yet`), and the state machine still pushes that
// turn into history as `[{ type: 'text', text: '' }]`. One such message then
// poisons every later call on that conversation — both the customer-facing
// webhook reply and the recoveryJob, which was failing on the same row every
// 15 minutes because of it. Strip empty blocks here, at the single boundary
// every caller goes through, so no caller can build an invalid request.
function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return [];
  const cleaned = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    let content = m.content;
    if (typeof content === 'string') {
      if (!content.trim()) continue;
    } else if (Array.isArray(content)) {
      // Keep non-text blocks (images, documents) untouched; drop blank text.
      content = content.filter(b => b && (b.type !== 'text' || String(b.text ?? '').trim() !== ''));
      if (content.length === 0) continue;
    } else {
      continue;
    }
    cleaned.push({ ...m, content });
  }
  // The API requires the first message to use the user role.
  while (cleaned.length && cleaned[0].role !== 'user') cleaned.shift();
  return cleaned;
}

function calcCostUsd(model, usage) {
  const p = PRICING[model];
  if (!p || !usage) return 0;
  return (
    (usage.input_tokens || 0) * p.input +
    (usage.output_tokens || 0) * p.output +
    (usage.cache_creation_input_tokens || 0) * p.cacheWrite +
    (usage.cache_read_input_tokens || 0) * p.cacheRead
  ) / 1_000_000;
}

/**
 * Call the Claude API and return the raw text response.
 *
 * @param {string|{cached: string, dynamic: string}} systemPrompt - Plain
 *   string for one-off/low-volume callers. Pass { cached, dynamic } (as
 *   buildSystemPrompt returns) to mark the static part with cache_control
 *   so Anthropic caches it instead of re-billing it on every call.
 * @param {Array} history - Array of message objects (role/content)
 * @returns {Promise<string>} raw reply text
 */
async function callClaude(systemPrompt, history, maxTokens = 600) {
  const messages = sanitizeHistory(history);
  if (messages.length === 0) {
    throw new Error('Claude API error: historial vacío tras descartar bloques de texto vacíos');
  }
  const isCacheable = systemPrompt && typeof systemPrompt === 'object';
  const system = isCacheable
    ? [
        { type: 'text', text: systemPrompt.cached, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: systemPrompt.dynamic },
      ]
    : systemPrompt;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.anthropicKey,
      'anthropic-version': '2023-06-01',
      ...(isCacheable ? { 'anthropic-beta': CACHE_BETA_HEADER } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  const data = await res.json();
  console.log('CLAUDE:', JSON.stringify(data));
  if (data.type === 'error' || !data.content) {
    throw new Error(`Claude API error: ${data.error?.message || 'unknown'}`);
  }
  if (data.usage) {
    db.logTokenUsage(env.agentName, MODEL_ID, data.usage, calcCostUsd(MODEL_ID, data.usage)).catch(() => {});
  }
  // The system prompt forbids asterisks/bold, but the model doesn't always
  // comply — WhatsApp doesn't render ** as bold anyway, it shows the literal
  // characters, so this must be enforced in code, not just instructed.
  return data.content[0].text.replace(/\*/g, '');
}

module.exports = { callClaude };
