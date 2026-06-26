'use strict';

const fetch = require('node-fetch');
const { env } = require('../config');

/**
 * Downloads an audio file from the given URL and transcribes it with
 * OpenAI Whisper (whisper-1). Returns the transcription text.
 *
 * GHL media URLs are pre-signed S3 URLs — no auth needed to download.
 * Falls back to GHL Bearer token if the initial fetch returns 401/403.
 */
async function transcribeAudio(audioUrl) {
  // 1. Download the audio file
  let audioRes = await fetch(audioUrl);
  if (audioRes.status === 401 || audioRes.status === 403) {
    audioRes = await fetch(audioUrl, {
      headers: { 'Authorization': `Bearer ${env.ghlKey}` },
    });
  }
  if (!audioRes.ok) throw new Error(`Audio download failed: ${audioRes.status}`);

  const audioBuffer = await audioRes.buffer();
  const contentType = audioRes.headers.get('content-type') || 'audio/ogg';

  const ext = contentType.includes('mp4') ? 'mp4'
    : contentType.includes('mpeg') ? 'mp3'
    : contentType.includes('wav') ? 'wav'
    : contentType.includes('webm') ? 'webm'
    : 'ogg';

  // 2. Build multipart/form-data manually (no extra dependencies)
  const boundary = `----WBoundary${Date.now()}`;
  const CRLF = '\r\n';

  const head = (name, extra = '') =>
    `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${extra}${CRLF}`;

  const bodyParts = [
    // audio file
    head('file', `; filename="audio.${ext}"`) + `Content-Type: ${contentType}${CRLF}${CRLF}`,
    audioBuffer,
    CRLF,
    // model
    head('model') + CRLF + 'whisper-large-v3-turbo' + CRLF,
    // language (Spanish)
    head('language') + CRLF + 'es' + CRLF,
    // closing boundary
    `--${boundary}--${CRLF}`,
  ];

  const body = Buffer.concat(bodyParts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));

  // 3. Call Whisper API
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.groqKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

module.exports = { transcribeAudio };
