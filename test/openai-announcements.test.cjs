const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { synthesizeOpenAI, generate, createAnnouncer } = require('../lib/announce');
const { today } = require('../lib/queue');

const names = ['TTS_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_TTS_MODEL', 'OPENAI_TTS_VOICE', 'OPENAI_BASE_URL', 'ELEVENLABS_API_KEY'];
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
beforeEach(() => { for (const name of names) delete process.env[name]; });
afterEach(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});
const state = () => ({ date: today(), tickets: [{ number: 'V27-001', model: 'V27', name: 'Juan PrivateSurname', status: 'called', calledAt: 123 }] });

test('OpenAI defaults send exactly the speech API request and return MP3 bytes', async (t) => {
  process.env.OPENAI_API_KEY = 'test-only-secret';
  const bytes = Buffer.from([0x49, 0x44, 0x33, 0xff]);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/speech');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { Authorization: 'Bearer test-only-secret', 'Content-Type': 'application/json', Accept: 'audio/mpeg' });
    assert.deepEqual(JSON.parse(options.body), {
      model: 'gpt-4o-mini-tts', voice: 'alloy', input: 'Test text', response_format: 'mp3',
      instructions: "Speak like a clear, friendly event announcer in a Philippine car showroom. Moderate pace. Read queue numbers slowly and clearly, letter by letter and digit by digit. Pronounce 'iCAUR' as 'eye-CAR'. Pronounce Filipino names naturally.",
    });
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(bytes);
  });
  assert.deepEqual(await synthesizeOpenAI('Test text'), bytes);
});

test('OpenAI overrides strip trailing slashes and omit instructions for tts-1', async (t) => {
  Object.assign(process.env, { OPENAI_API_KEY: 'test-only-secret', OPENAI_BASE_URL: 'https://speech.test/v1///', OPENAI_TTS_MODEL: 'tts-1', OPENAI_TTS_VOICE: 'nova' });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://speech.test/v1/audio/speech');
    assert.deepEqual(JSON.parse(options.body), { model: 'tts-1', voice: 'nova', input: 'Test text', response_format: 'mp3' });
    return new Response('mp3');
  });
  await synthesizeOpenAI('Test text');
});

test('selection honors explicit provider, automatic priority and missing keys', async (t) => {
  const hosts = [];
  t.mock.method(globalThis, 'fetch', async (url) => { hosts.push(new URL(url).hostname); return new Response('mp3'); });
  const announce = createAnnouncer();
  const disabled = { status: 503, body: { error: 'Voice not configured' } };
  assert.deepEqual(await announce(state(), 'V27-001'), disabled);
  await assert.rejects(generate('test'), { status: 503 });
  await assert.rejects(synthesizeOpenAI('test'), { status: 503 });
  process.env.OPENAI_API_KEY = 'test-only-secret';
  process.env.TTS_PROVIDER = 'elevenlabs';
  assert.deepEqual(await announce(state(), 'V27-001'), disabled);
  await assert.rejects(generate('test'), { status: 503 });
  process.env.TTS_PROVIDER = 'invalid';
  assert.deepEqual(await announce(state(), 'V27-001'), disabled);
  delete process.env.TTS_PROVIDER;
  await generate('test');
  process.env.ELEVENLABS_API_KEY = 'test-only-secret';
  await generate('test');
  process.env.TTS_PROVIDER = 'elevenlabs';
  await generate('test');
  delete process.env.TTS_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  await generate('test');
  assert.deepEqual(hosts, ['api.openai.com', 'api.openai.com', 'api.elevenlabs.io', 'api.elevenlabs.io']);
});

test('default announcer separates provider caches, reuses audio and regenerates recalls', async (t) => {
  Object.assign(process.env, { OPENAI_API_KEY: 'test-only-secret', ELEVENLABS_API_KEY: 'test-only-secret' });
  const keys = [];
  const cache = new Map();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.input || body.text, 'Queue Number V twenty-seven, zero zero one, Juan PrivateSurname. Please proceed to the iCAUR Booth for your test drive.');
    return new Response(`mp3-${calls}`);
  });
  const announce = createAnnouncer({ cache: { get: (key) => cache.get(key), set: (key, bytes) => { keys.push(key); cache.set(key, bytes); } } });
  const fixture = state();
  const results = await Promise.all([announce(fixture, 'V27-001'), announce(fixture, 'V27-001')]);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 200);
  assert.deepEqual(results[0].body, results[1].body);
  await announce(fixture, 'V27-001');
  process.env.TTS_PROVIDER = 'elevenlabs';
  assert.equal((await announce(fixture, 'V27-001')).body.toString(), 'mp3-2');
  process.env.TTS_PROVIDER = 'openai';
  assert.equal((await announce(fixture, 'V27-001')).body.toString(), 'mp3-1');
  fixture.tickets[0].calledAt++;
  await announce(fixture, 'V27-001');
  assert.equal(calls, 3);
  assert.deepEqual(keys, [`openai/${today()}/V27-001/123`, `elevenlabs/${today()}/V27-001/123`, `openai/${today()}/V27-001/124`]);
});

for (const [status, error, code, reason] of [
  [401, { code: 'invalid_api_key', message: 'sk-secret' }, 'invalid_api_key', 'authentication rejected'],
  [429, { code: 'insufficient_quota', message: 'sk-secret' }, 'insufficient_quota', 'quota unavailable'],
  [429, { type: 'rate_limit_error', message: 'sk-secret' }, undefined, 'rate limited'],
  [400, { code: 'model_not_found', message: 'sk-secret' }, 'model_not_found', 'provider or storage failure'],
  [404, { code: 'model_not_found', message: 'sk-secret' }, 'model_not_found', 'provider or storage failure'],
  [401, { code: 'sk-secret', type: 'invalid_request_error', message: 'sk-secret' }, undefined, 'authentication rejected'],
  [401, { code: 'a'.repeat(41), type: 123, message: 'sk-secret' }, undefined, 'authentication rejected'],
  [500, { message: 'sk-secret' }, undefined, 'provider or storage failure'],
  [401, { code: 'juan_privatesurname', message: 'sk-secret' }, undefined, 'authentication rejected'],
]) {
  test(`OpenAI ${status}/${code} keeps only a validated code and logs safely`, async (t) => {
    process.env.OPENAI_API_KEY = 'test-only-secret';
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error }, { status }));
    await assert.rejects(synthesizeOpenAI('test'), (failure) => {
      assert.equal(failure.status, status);
      assert.equal(failure.code, code);
      assert.doesNotMatch(JSON.stringify(failure) + failure.message, /sk-secret|test-only-secret/);
      return true;
    });
    const logs = [];
    const announce = createAnnouncer({ log: (line) => logs.push(line) });
    assert.deepEqual(await announce(state(), 'V27-001'), { status: 503, body: { error: 'Voice unavailable' } });
    assert.deepEqual(logs, [`Announcement voice unavailable (openai): ${status} ${reason}${code ? ` (${code})` : ''}`]);
  });
}

test('OpenAI cancels error reads at 2 KB and ignores malformed JSON', async (t) => {
  process.env.OPENAI_API_KEY = 'test-only-secret';
  let reads = 0;
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, body: { getReader: () => ({
    async read() { reads++; return { done: false, value: Buffer.alloc(1024, 32) }; },
    async cancel() { cancelled = true; },
  }) } }));
  await assert.rejects(synthesizeOpenAI('test'), { status: 401, reason: 'Authentication rejected' });
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});

test('OpenAI rejects empty audio and sanitizes network failures', async (t) => {
  process.env.OPENAI_API_KEY = 'test-only-secret';
  t.mock.method(globalThis, 'fetch', async () => new Response(''));
  await assert.rejects(synthesizeOpenAI('test'), { status: 502, reason: 'Empty audio' });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('sk-secret'); });
  await assert.rejects(synthesizeOpenAI('test'), { status: 502, message: 'Network failure' });
});

test('OpenAI aborts after eight seconds during fetch and body download', async (t) => {
  process.env.OPENAI_API_KEY = 'test-only-secret';
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { assert.equal(ms, 8000); return realTimeout(fn, 5); });
  for (const bodyDownload of [false, true]) {
    t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
      const hanging = () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('sk-secret')), { once: true }));
      return bodyDownload ? { ok: true, arrayBuffer: hanging } : hanging();
    });
    await assert.rejects(synthesizeOpenAI('test'), { status: 504, reason: 'Request timed out' });
  }
});
