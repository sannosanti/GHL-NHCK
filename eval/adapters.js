'use strict';

/**
 * Model adapters for the NHC evaluation harness.
 *
 * Every adapter exposes the same call signature and returns the same shape, so
 * the replay engine is model-agnostic and each candidate model sees byte-for-byte
 * the same system prompt and message history that production sends.
 *
 *   call({ system, messages, maxTokens }) -> {
 *     text,            // raw reply, before tag stripping
 *     usage,           // normalized: { input, output, cacheWrite, cacheRead }
 *     costUsd,
 *     latencyMs,
 *   }
 *
 * `system` is the { cached, dynamic } pair returned by ai/prompt.js. Each adapter
 * decides how to express the cached/dynamic split for its provider — that split
 * is precisely one of the things under test (see README, "Caching is not portable").
 */

const fetch = require('node-fetch');

// $/MTok. Anthropic rates verified against platform.claude.com pricing.
// OpenAI rates are the published GPT-5.6 tier rates as of 2026-08-05 and MUST be
// re-verified before any migration decision is signed off — see README step 0.
const PRICING = {
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 6, cacheRead: 0.3 },
  luna: { input: 0.2, output: 1.2, cacheWrite: 0.2, cacheRead: 0.02 },
  terra: { input: 2, output: 12, cacheWrite: 2, cacheRead: 0.2 },
};

const CACHE_BETA_HEADER = 'extended-cache-ttl-2025-04-11';

function cost(rateKey, usage) {
  const p = PRICING[rateKey];
  if (!p || !usage) return 0;
  return (
    (usage.input || 0) * p.input +
    (usage.output || 0) * p.output +
    (usage.cacheWrite || 0) * p.cacheWrite +
    (usage.cacheRead || 0) * p.cacheRead
  ) / 1_000_000;
}

/**
 * Baseline. Mirrors ai/claude.js exactly: same endpoint, same cache_control
 * placement, same 1h TTL beta header. If this drifts from production the whole
 * comparison is invalid, so keep the two in sync.
 */
function anthropicAdapter({ modelId = 'claude-sonnet-4-5', rateKey = 'claude-sonnet-4-5' } = {}) {
  return {
    label: modelId,
    async call({ system, messages, maxTokens = 600 }) {
      const body = {
        model: modelId,
        max_tokens: maxTokens,
        system: [
          { type: 'text', text: system.cached, cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: system.dynamic },
        ],
        messages,
      };
      const t0 = Date.now();
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': CACHE_BETA_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const latencyMs = Date.now() - t0;
      const data = await res.json();
      if (data.type === 'error' || !data.content) {
        throw new Error(`anthropic: ${data.error?.message || res.status}`);
      }
      const usage = {
        input: data.usage?.input_tokens || 0,
        output: data.usage?.output_tokens || 0,
        cacheWrite: data.usage?.cache_creation_input_tokens || 0,
        cacheRead: data.usage?.cache_read_input_tokens || 0,
      };
      return { text: data.content[0].text, usage, costUsd: cost(rateKey, usage), latencyMs };
    },
  };
}

/**
 * OpenAI-compatible adapter for the GPT-5.6 candidates.
 *
 * Two structural differences from the Anthropic path, both of which the report
 * must surface rather than hide:
 *
 *  1. No explicit cache_control. Caching is automatic prefix matching, so the
 *     { cached, dynamic } split only pays off if `cached` is a strict prefix of
 *     every request. It already is here (cached is emitted first), but there is
 *     no 1h TTL control — cache behavior under real traffic gaps is an empirical
 *     question this harness answers via the cacheRead column, not an assumption.
 *  2. The system prompt becomes a leading `system` message rather than a separate
 *     top-level field.
 *
 * MODEL IDS ARE NOT HARDCODED ON PURPOSE. Pass the exact API model string from
 * OpenAI's current docs via env (EVAL_LUNA_MODEL / EVAL_TERRA_MODEL). Guessing a
 * model id produces a 404 that looks like a capability failure.
 */
function openaiAdapter({ modelId, rateKey, label }) {
  if (!modelId) {
    throw new Error(
      `openaiAdapter: missing model id for "${label}". Set the matching env var to the exact ` +
        `model string from OpenAI's docs — do not guess it.`
    );
  }
  return {
    label,
    async call({ system, messages, maxTokens = 600 }) {
      const body = {
        model: modelId,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system.cached },
          { role: 'system', content: system.dynamic },
          ...messages.map(m => ({
            role: m.role,
            content: typeof m.content === 'string'
              ? m.content
              : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
          })),
        ],
      };
      const t0 = Date.now();
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const latencyMs = Date.now() - t0;
      const data = await res.json();
      if (data.error || !data.choices?.length) {
        throw new Error(`openai(${label}): ${data.error?.message || res.status}`);
      }
      const cached = data.usage?.prompt_tokens_details?.cached_tokens || 0;
      const usage = {
        // Uncached prompt tokens only, so the column means the same thing it does
        // on the Anthropic side and the cost math stays comparable.
        input: (data.usage?.prompt_tokens || 0) - cached,
        output: data.usage?.completion_tokens || 0,
        cacheWrite: 0,
        cacheRead: cached,
      };
      return {
        text: data.choices[0].message.content || '',
        usage,
        costUsd: cost(rateKey, usage),
        latencyMs,
      };
    },
  };
}

function buildAdapters() {
  return [
    anthropicAdapter(),
    openaiAdapter({ modelId: process.env.EVAL_LUNA_MODEL, rateKey: 'luna', label: 'luna' }),
    openaiAdapter({ modelId: process.env.EVAL_TERRA_MODEL, rateKey: 'terra', label: 'terra' }),
  ];
}

module.exports = { buildAdapters, anthropicAdapter, openaiAdapter, PRICING, cost };
