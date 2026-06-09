'use strict';

const fetch = require('node-fetch');
const { env } = require('../config');

/**
 * Call the Claude API and return the raw text response.
 *
 * @param {string} systemPrompt
 * @param {Array} history - Array of message objects (role/content)
 * @returns {Promise<string>} raw reply text
 */
async function callClaude(systemPrompt, history) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: history,
    }),
  });
  const data = await res.json();
  console.log('CLAUDE:', JSON.stringify(data));
  return data.content[0].text;
}

module.exports = { callClaude };
