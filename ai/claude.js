'use strict';

const fetch = require('node-fetch');
const { env } = require('../config');
const db = require('../db');

const MODEL_ID = 'claude-sonnet-4-5';

// $/MTok, from platform.claude.com/docs/en/about-claude/pricing (checked 2026-07-16).
// cacheWrite is the 5-minute-TTL rate — this codebase doesn't set cache_control,
// so cache_creation/read tokens are 0 today, but the API always reports the
// fields and rates differ per model, so keep them alongside input/output.
const PRICING = {
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
};

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
 * @param {string} systemPrompt
 * @param {Array} history - Array of message objects (role/content)
 * @returns {Promise<string>} raw reply text
 */
async function callClaude(systemPrompt, history, maxTokens = 600) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: history,
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
