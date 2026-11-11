// Server-only announcement generation. Send only the spoken number and sanitised name to the voice provider.
const { today } = require('./queue');

// Keep in sync with public/common.js; test/announce.test.cjs checks exact text parity.
function announcementText(ticket) {
  const rawNumber = String(ticket.number || '');
  const parts = rawNumber.match(/^([A-Za-z0-9]{1,6})-(\d{3,4})$/);
  const digitWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const small = [...digitWords, 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const prefix = parts && parts[1].match(/[A-Za-z]|\d+/g);
  const valid = prefix && prefix.every((part) => !/^\d/.test(part) || Number(part) <= 99);
  const number = valid
    ? `${prefix.map((part) => {
      if (!/^\d/.test(part)) return part.toUpperCase();
      const value = Number(part);
      return value < 20 ? small[value] : tens[Math.floor(value / 10)] + (value % 10 ? '-' + digitWords[value % 10] : '');
    }).join(' ')}, ${[...parts[2]].map((digit) => digitWords[Number(digit)]).join(' ')}`
    : [...rawNumber].join(' ');
  const name = String(ticket.name || '').replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\s'\-.]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  const customer = name ? `, ${name}` : '';
  return ticket.callCount > 1
    ? `Now serving Queue Number ${number}${customer}. Please proceed to the iCAUR Booth. Thank you!`
    : `Queue Number ${number}${customer}. Please proceed to the iCAUR Booth for your test drive.`;
}

function voiceError(status, reason) {
  return Object.assign(new Error(reason), { status, reason });
}

// Retain only a validated provider code; never attach body text or parse errors.
async function providerErrorCode(response, provider = 'elevenlabs') {
  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks = [];
  let size = 0;
  try {
    while (size < 2048) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, 2048 - size);
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    const codes = provider === 'openai' ? [body?.error?.code, body?.error?.type] : [body?.detail?.status];
    const allowed = provider === 'openai'
      ? ['invalid_api_key', 'insufficient_quota', 'model_not_found']
      : ['invalid_api_key', 'quota_exceeded', 'detected_unusual_activity'];
    return codes.find((code) => allowed.includes(code));
  } catch {} finally {
    try { await reader.cancel(); } catch {}
  }
}

async function synthesize(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw voiceError(503, 'Voice not configured');
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const model_id = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const code = await providerErrorCode(response);
      const reason = code === 'quota_exceeded' ? 'Quota unavailable' : { 401: 'Authentication rejected', 402: 'Quota unavailable', 429: 'Rate limited' }[response.status]
        || (response.status >= 500 ? 'Provider failure' : 'Request rejected');
      const error = voiceError(response.status, reason);
      if (code) error.code = code;
      throw error;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw voiceError(502, 'Empty audio');
    return bytes;
  } catch (error) {
    if (controller.signal.aborted) throw voiceError(504, 'Request timed out');
    if (error.reason) throw error;
    throw voiceError(502, 'Network failure');
  } finally {
    clearTimeout(timer);
  }
}

function selectedProvider() {
  if (process.env.TTS_PROVIDER) {
    return ['openai', 'elevenlabs'].includes(process.env.TTS_PROVIDER) ? process.env.TTS_PROVIDER : undefined;
  }
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
}

function providerConfigured(provider) {
  return !!(provider === 'openai' ? process.env.OPENAI_API_KEY
    : provider === 'elevenlabs' ? process.env.ELEVENLABS_API_KEY : false);
}

async function synthesizeOpenAI(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw voiceError(503, 'Voice not configured');
  const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  const voice = process.env.OPENAI_TTS_VOICE || 'alloy';
  const baseURL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const body = { model, voice, input: text, response_format: 'mp3' };
  if (model.startsWith('gpt-')) {
    body.instructions = 'Speak like a clear, friendly event announcer in a Philippine car showroom. Moderate pace. Read queue numbers slowly and clearly, letter by letter and digit by digit. Pronounce \'iCAUR\' as \'eye-CAR\'. Pronounce Filipino names naturally.';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${baseURL}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const code = await providerErrorCode(response, 'openai');
      const reason = response.status === 429 && code === 'insufficient_quota' ? 'Quota unavailable'
        : { 401: 'Authentication rejected', 429: 'Rate limited' }[response.status]
          || (response.status >= 500 ? 'Provider failure' : 'Request rejected');
      const error = voiceError(response.status, reason);
      if (code) error.code = code;
      throw error;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw voiceError(502, 'Empty audio');
    return bytes;
  } catch (error) {
    if (controller.signal.aborted) throw voiceError(504, 'Request timed out');
    if (error.reason) throw error;
    throw voiceError(502, 'Network failure');
  } finally {
    clearTimeout(timer);
  }
}

function generate(text, provider = selectedProvider()) {
  if (provider === 'openai') return synthesizeOpenAI(text);
  if (provider === 'elevenlabs') return synthesize(text);
  return Promise.reject(voiceError(503, 'Voice not configured'));
}

function memoryCache(limit = 50) {
  const entries = new Map();
  return {
    get(key) {
      const value = entries.get(key);
      if (entries.has(key)) { entries.delete(key); entries.set(key, value); }
      return value;
    },
    set(key, bytes) {
      entries.delete(key);
      entries.set(key, bytes);
      if (entries.size > limit) entries.delete(entries.keys().next().value);
    },
  };
}

const audioHeaders = { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=300' };

// Both HTTP adapters use this handler. Cache adapters store only MP3 bytes under public call keys.
function createAnnouncer({ cache = memoryCache(), generate: generateAudio = generate, log = (line) => console.warn(line) } = {}) {
  const inFlight = new Map();
  return async function announce(state, number) {
    if (typeof number !== 'string' || !/^[A-Z0-9]{1,6}-\d{3,4}$/.test(number)) {
      return { status: 400, body: { error: 'Invalid ticket number' } };
    }
    const provider = selectedProvider();
    try {
      if (typeof state === 'function') state = await state();
    } catch {
      log(`Announcement voice unavailable (${provider || 'none'}): 502 queue storage failure`);
      return { status: 503, body: { error: 'Voice unavailable' } };
    }
    const ticket = state.date === today() && state.tickets.find((t) => t.number === number && t.status === 'called');
    if (!ticket) return { status: 404, body: { error: 'Called ticket not found' } };
    if (!providerConfigured(provider)) return { status: 503, body: { error: 'Voice not configured' } };
    const key = `${provider}/${state.date}/${number}/${ticket.calledAt}`;
    if (inFlight.has(key)) return inFlight.get(key);
    // Snapshot only safe fields before any await (staff may recall/change the ticket meanwhile).
    const safeTicket = {
      number: ticket.number,
      name: String(ticket.name || '').replace(/<[^>]*>/g, '')
        .replace(/[^\p{L}\s'\-.]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60).trim(),
      callCount: ticket.callCount,
    };
    const work = (async () => {
      try {
        let cached;
        try { cached = await cache.get(key); } catch {
          log('Announcement cache read failed');
        }
        if (cached != null) return { status: 200, body: Buffer.from(cached), headers: audioHeaders };
        const bytes = await generateAudio(announcementText(safeTicket), provider);
        try { await cache.set(key, bytes); } catch {
          log('Announcement cache write failed');
        }
        return { status: 200, body: bytes, headers: audioHeaders };
      } catch (error) {
        // Never log provider bodies/messages: they may contain the request text or private data.
        const status = Number.isInteger(error.status) ? error.status : 502;
        const allowed = provider === 'openai'
          ? ['invalid_api_key', 'insufficient_quota', 'model_not_found']
          : ['invalid_api_key', 'quota_exceeded', 'detected_unusual_activity'];
        const code = allowed.includes(error.code) ? error.code : undefined;
        const reason = code === 'quota_exceeded' || (status === 429 && code === 'insufficient_quota') ? 'quota unavailable' : { 401: 'authentication rejected', 402: 'quota unavailable', 429: 'rate limited', 504: 'request timed out' }[status]
          || 'provider or storage failure';
        log(`Announcement voice unavailable (${provider}): ${status} ${reason}${code ? ` (${code})` : ''}`);
        return { status: 503, body: { error: 'Voice unavailable' } };
      }
    })();
    inFlight.set(key, work);
    try { return await work; } finally { inFlight.delete(key); }
  };
}

module.exports = { announcementText, synthesize, synthesizeOpenAI, generate, createAnnouncer, memoryCache };
