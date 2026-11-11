const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { announcementText, synthesize, createAnnouncer, memoryCache } = require('../lib/announce');
const Q = require('../lib/queue');

const envNames = ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_MODEL', 'NETLIFY_BLOBS_CONTEXT', 'TTS_PROVIDER', 'OPENAI_API_KEY'];
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
beforeEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.TTS_PROVIDER;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

test('server and actual browser text builders produce identical, expected text', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/common.js'), 'utf8'), context);
  const cases = [
    [{ number: 'V27-001', name: 'Mark Yuri Patawaran', callCount: 1 }, 'V twenty-seven, zero zero one', 'Mark Yuri Patawaran'],
    [{ number: 'V27-001', name: 'Mark Yuri Patawaran', callCount: 2 }, 'V twenty-seven, zero zero one', 'Mark Yuri Patawaran'],
    [{ number: 'V23-012', model: 'V23', name: 'Ana', callCount: 3 }, 'V twenty-three, zero one two', 'Ana'],
    [{ number: 'V23-003', name: '' }, 'V twenty-three, zero zero three', ''],
    [{ number: 'V27-005', name: "<b>Bob</b> O'Neil-Smith", callCount: 0 }, 'V twenty-seven, zero zero five', "Bob O'Neil-Smith"],
    [{ number: 'V27-006', name: 'Jos\u00e9 Rizal' }, 'V twenty-seven, zero zero six', 'Jos\u00e9 Rizal'],
    [{ number: 'X', name: '' }, 'X', ''],
    [{ number: 'V27-100', name: '  Ana-Mar\u00eda\t  Cruz! 42  ' }, 'V twenty-seven, one zero zero', 'Ana-Mar\u00eda Cruz'],
    [{ number: 'V23-000', name: '123<>' }, 'V twenty-three, zero zero zero', ''],
    [{ number: 'V27-1000', name: 'A'.repeat(70) }, 'V twenty-seven, one zero zero zero', 'A'.repeat(60)],
    [{ number: 'X-?', name: '\u674e \u5c0f\u9f8d.' }, 'X - ?', '\u674e \u5c0f\u9f8d.'],
  ];
  for (const [ticket, number, name] of cases) {
    const customer = name ? `, ${name}` : '';
    const expected = ticket.callCount > 1
      ? `Now serving Queue Number ${number}${customer}. Please proceed to the iCAUR Booth. Thank you!`
      : `Queue Number ${number}${customer}. Please proceed to the iCAUR Booth for your test drive.`;
    assert.equal(announcementText(ticket, Q.MODELS), expected);
    assert.equal(context.callAnnouncementText(ticket, Q.MODELS), expected);
  }
});

test('synthesize posts the required defaults and returns MP3 bytes as a Buffer', async (t) => {
  process.env.ELEVENLABS_API_KEY = 'test-only-secret';
  delete process.env.ELEVENLABS_VOICE_ID;
  delete process.env.ELEVENLABS_MODEL;
  const bytes = Buffer.from([0x49, 0x44, 0x33, 0xff, 0]);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_64');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { 'xi-api-key': 'test-only-secret', 'Content-Type': 'application/json', Accept: 'audio/mpeg' });
    assert.deepEqual(JSON.parse(options.body), { text: 'Test text', model_id: 'eleven_flash_v2_5' });
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(bytes, { status: 200 });
  });
  const result = await synthesize('Test text');
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual(result, bytes);
});

test('synthesize respects voice/model overrides', async (t) => {
  process.env.ELEVENLABS_API_KEY = 'test-only-secret';
  process.env.ELEVENLABS_VOICE_ID = 'custom/voice';
  process.env.ELEVENLABS_MODEL = 'custom-model';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /custom%2Fvoice\?output_format=mp3_44100_64$/);
    assert.equal(JSON.parse(options.body).model_id, 'custom-model');
    return new Response('mp3');
  });
  await synthesize('Test text');
});

for (const status of [401, 402, 429, 500]) {
  test(`synthesize preserves HTTP ${status} without retaining provider body or secrets`, async (t) => {
    process.env.ELEVENLABS_API_KEY = 'test-only-secret';
    t.mock.method(globalThis, 'fetch', async () => new Response('test-only-secret Juan Fullname '.repeat(50), { status }));
    await assert.rejects(synthesize('Juan Fullname'), (error) => {
      assert.equal(error.status, status);
      assert.ok(error.reason.length < 200);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /test-only-secret|Juan|Fullname/);
      return true;
    });
  });
}

test('synthesize aborts at its eight-second timeout, including during body download', async (t) => {
  process.env.ELEVENLABS_API_KEY = 'test-only-secret';
  const realTimeout = globalThis.setTimeout;
  let timers = 0;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    assert.equal(ms, 8000);
    timers++;
    return realTimeout(fn, 5, ...args);
  });
  for (const bodyDownload of [false, true]) {
    t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
      const hanging = () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      return bodyDownload ? { ok: true, arrayBuffer: hanging } : hanging();
    });
    await assert.rejects(synthesize('Test text'), { status: 504, reason: 'Request timed out' });
  }
  assert.equal(timers, 2);
});

test('unset key disables synthesize without fetching', async (t) => {
  delete process.env.ELEVENLABS_API_KEY;
  const fetchMock = t.mock.method(globalThis, 'fetch', () => assert.fail('must not fetch'));
  await assert.rejects(synthesize('Test text'), { status: 503, message: 'Voice not configured' });
  assert.equal(fetchMock.mock.callCount(), 0);
});

function fixture() {
  return { date: Q.today(), tickets: [
    { id: 'private-id', number: 'V27-001', model: 'V27', name: '  Juan <b>PrivateSurname</b> ! 42  ', phone: 'private-phone', email: 'private-email', licenseNumber: 'private-license', status: 'called', calledAt: 123, callCount: 1 },
    { number: 'V27-002', model: 'V27', name: 'Waiting', status: 'waiting' },
  ] };
}

test('endpoint validates numbers, today and called status even when voice is disabled', async () => {
  delete process.env.ELEVENLABS_API_KEY;
  const announce = createAnnouncer({ generate: () => assert.fail('must not generate') });
  for (const number of [null, '', 'hello', 'V27-01', 'V27-12345', 'TOOLONG-001', 'j5-001', 'V27-001\n', '<b>Bob</b>']) {
    assert.equal((await announce(() => assert.fail('bad number must not load state'), number)).status, 400);
  }
  assert.equal((await announce(fixture(), 'V27-002')).status, 404);
  assert.equal((await announce(fixture(), 'V27-999')).status, 404);
  assert.equal((await announce({ ...fixture(), date: '2000-01-01' }, 'V27-001')).status, 404);
  assert.deepEqual(await announce(fixture(), 'V27-001'), { status: 503, body: { error: 'Voice not configured' } });
});

test('endpoint shares in-flight generation, caches bytes and regenerates on recall', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-only-secret';
  const state = fixture();
  let calls = 0;
  const keys = [];
  const cache = memoryCache();
  const announce = createAnnouncer({ cache: {
    get: (key) => cache.get(key),
    set: (key, bytes) => { keys.push(key); cache.set(key, bytes); },
  }, generate: async (text) => {
    calls++;
    assert.equal(text, calls === 1
      ? 'Queue Number V twenty-seven, zero zero one, Juan PrivateSurname. Please proceed to the iCAUR Booth for your test drive.'
      : 'Now serving Queue Number V twenty-seven, zero zero one, Juan PrivateSurname. Please proceed to the iCAUR Booth. Thank you!');
    assert.doesNotMatch(text, /private-/);
    return Buffer.from('MP3 audio');
  } });
  const results = await Promise.all([announce(state, 'V27-001'), announce(state, 'V27-001')]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'MP3 audio');
    assert.deepEqual(result.headers, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=300' });
  }
  await announce(state, 'V27-001');
  assert.equal(calls, 1);
  state.tickets[0].calledAt++;
  state.tickets[0].callCount++;
  await announce(state, 'V27-001');
  assert.equal(calls, 2);
  assert.deepEqual(keys, [`elevenlabs/${state.date}/V27-001/123`, `elevenlabs/${state.date}/V27-001/124`]);
  state.tickets[0].status = 'driving';
  assert.equal((await announce(state, 'V27-001')).status, 404);
});

test('endpoint reads persisted ArrayBuffer audio without regeneration', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-only-secret';
  const announce = createAnnouncer({ cache: { get: async () => Uint8Array.from([1, 2, 3]).buffer }, generate: () => assert.fail('cache hit') });
  assert.deepEqual((await announce(fixture(), 'V27-001')).body, Buffer.from([1, 2, 3]));
});

for (const operation of ['get', 'set']) {
  test(`cache.${operation} failure still returns generated audio and logs one safe line`, async () => {
    process.env.ELEVENLABS_API_KEY = 'test-only-secret';
    const bytes = Buffer.from('MP3 audio');
    const logs = [];
    let generations = 0;
    let writes = 0;
    const announce = createAnnouncer({
      cache: {
        async get() {
          if (operation === 'get') throw new Error('private-id test-only-secret');
        },
        async set(_key, value) {
          writes++;
          assert.deepEqual(value, bytes);
          if (operation === 'set') throw new Error('private-id test-only-secret');
        },
      },
      generate: async () => { generations++; return bytes; },
      log: (line) => logs.push(line),
    });
    const result = await announce(fixture(), 'V27-001');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, bytes);
    assert.equal(result.headers['Content-Type'], 'audio/mpeg');
    assert.equal(generations, 1);
    assert.equal(writes, 1);
    assert.deepEqual(logs, [`Announcement cache ${operation === 'get' ? 'read' : 'write'} failed`]);
  });
}

test('endpoint failures log one safe line, are not cached, and allow retry', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-only-secret';
  let writes = 0;
  let calls = 0;
  const logs = [];
  const announce = createAnnouncer({ cache: { get() {}, set() { writes++; } }, log: (line) => logs.push(line), generate: async () => {
    calls++;
    throw Object.assign(new Error('private-id PrivateSurname test-only-secret'), { status: 429 });
  } });
  const results = await Promise.all([announce(fixture(), 'V27-001'), announce(fixture(), 'V27-001')]);
  assert.deepEqual(results, Array(2).fill({ status: 503, body: { error: 'Voice unavailable' } }));
  assert.equal(calls, 1);
  assert.equal(writes, 0);
  assert.deepEqual(logs, ['Announcement voice unavailable (elevenlabs): 429 rate limited']);
  await announce(fixture(), 'V27-001');
  assert.equal(calls, 2);
});

test('memory cache drops the oldest entry at 50 entries', () => {
  const cache = memoryCache();
  for (let i = 0; i <= 50; i++) cache.set(String(i), Buffer.from([i]));
  assert.equal(cache.get('0'), undefined);
  assert.deepEqual(cache.get('1'), Buffer.from([1]));
  assert.deepEqual(cache.get('50'), Buffer.from([50]));
});

test('real Netlify adapter and Blobs SDK validate, store MP3 metadata, reuse and recall', async (t) => {
  const { pathToFileURL } = require('node:url');
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({
    siteID: 'test-site', token: 'test-blob-token', edgeURL: 'https://blobs.test', uncachedEdgeURL: 'https://blobs.test',
  })).toString('base64');
  const state = fixture();
  const blobs = new Map();
  const writes = [];
  let generations = 0;
  let unexpected = 0;
  let providerFails = false;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.elevenlabs.io') {
      generations++;
      const { text } = JSON.parse(options.body);
      assert.match(text, /Juan PrivateSurname\./);
      assert.doesNotMatch(text, /private-/);
      if (providerFails) return Response.json({ detail: { status: 'invalid_api_key', message: 'private-provider-body' } }, { status: 401 });
      return new Response(Buffer.from('MP3 fixture'));
    }
    if (url.hostname === 'blobs.test' && url.pathname === `/test-site/site:queue/${Q.today()}`) return Response.json(state);
    if (url.hostname === 'blobs.test' && url.pathname.startsWith('/test-site/site:announcements/')) {
      if (options.method === 'put') {
        assert.ok(options.body instanceof ArrayBuffer, 'Blobs receives a supported ArrayBuffer');
        assert.equal(options.body.byteLength, Buffer.byteLength('MP3 fixture'));
        const metadata = JSON.parse(Buffer.from(options.headers['x-amz-meta-user'].slice(4), 'base64').toString());
        writes.push({ key: url.pathname, metadata });
        blobs.set(url.pathname, Buffer.from(options.body));
        return new Response('', { status: 200 });
      }
      return blobs.has(url.pathname) ? new Response(blobs.get(url.pathname)) : new Response('', { status: 404 });
    }
    unexpected++;
    return new Response('', { status: 418 });
  });
  const { default: handler } = await import(pathToFileURL(path.join(__dirname, '../netlify/functions/api.mjs')).href);
  const request = (number, extra = '') => handler(new Request(`https://queue.test/api/announce?number=${encodeURIComponent(number)}${extra}`));
  delete process.env.ELEVENLABS_API_KEY;
  assert.equal((await request('bad')).status, 400);
  assert.equal((await request('V27-002')).status, 404);
  assert.equal((await request('V27-999')).status, 404);
  const disabled = await request('V27-001');
  assert.equal(disabled.status, 503);
  assert.deepEqual(await disabled.json(), { error: 'Voice not configured' });
  process.env.ELEVENLABS_API_KEY = 'test-only-secret';
  for (let i = 0; i < 2; i++) {
    const response = await request('V27-001', '&text=NEVER-SPEAK-THIS');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=300');
    assert.equal(await response.text(), 'MP3 fixture');
  }
  assert.equal(generations, 1);
  state.tickets[0].calledAt++;
  state.tickets[0].callCount++;
  assert.equal((await request('V27-001')).status, 200);
  assert.equal(generations, 2);
  assert.deepEqual(writes.map((item) => item.metadata), [{ contentType: 'audio/mpeg' }, { contentType: 'audio/mpeg' }]);
  assert.ok(writes.every((item) => !/private-|PrivateSurname/.test(item.key)));
  state.tickets[0].calledAt++;
  providerFails = true;
  const warnings = [];
  t.mock.method(console, 'warn', (line) => warnings.push(line));
  for (let i = 0; i < 2; i++) {
    const failed = await request('V27-001');
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'Voice unavailable' });
  }
  assert.equal(generations, 4);
  assert.equal(writes.length, 2, 'provider failures must not be cached');
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((line) => line === 'Announcement voice unavailable (elevenlabs): 401 authentication rejected (invalid_api_key)'));
  providerFails = false;
  assert.equal((await request('V27-001')).status, 200);
  assert.equal(generations, 5);
  state.tickets[0].status = 'done';
  assert.equal((await request('V27-001')).status, 404);
  state.tickets[0].status = 'called';
  const currentDate = state.date;
  state.date = '2000-01-01';
  assert.equal((await request('V27-001')).status, 404);
  state.date = currentDate;
  assert.equal(unexpected, 0);
});

for (const [body, code, reason] of [
  [JSON.stringify({ detail: { status: 'invalid_api_key', message: 'sk_secret' } }), 'invalid_api_key', 'authentication rejected'],
  [JSON.stringify({ detail: { status: 'quota_exceeded', message: 'sk_secret' } }), 'quota_exceeded', 'quota unavailable'],
  ['not JSON sk_secret', undefined, 'authentication rejected'],
  [JSON.stringify({ detail: { status: 'sk_secret!', message: 'sk_secret' } }), undefined, 'authentication rejected'],
  [JSON.stringify({ detail: { status: 123 } }), undefined, 'authentication rejected'],
  [JSON.stringify({ detail: { status: 'a'.repeat(41) } }), undefined, 'authentication rejected'],
  [' '.repeat(2048) + JSON.stringify({ detail: { status: 'invalid_api_key' } }), undefined, 'authentication rejected'],
]) {
  test(`provider error safely extracts code from ${body.slice(0, 80)}`, async (t) => {
    process.env.ELEVENLABS_API_KEY = 'test-only-secret';
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 401 }));
    await assert.rejects(synthesize('Test text'), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /sk_secret/);
      if (code === 'quota_exceeded') assert.equal(error.reason, 'Quota unavailable');
      return true;
    });
    const logs = [];
    const announce = createAnnouncer({ log: (line) => logs.push(line) });
    assert.deepEqual(await announce(fixture(), 'V27-001'), { status: 503, body: { error: 'Voice unavailable' } });
    assert.deepEqual(logs, [`Announcement voice unavailable (elevenlabs): 401 ${reason}${code ? ` (${code})` : ''}`]);
    assert.doesNotMatch(logs.join(''), /sk_secret/);
  });
}

test('provider error stops reading and cancels at 2 KB', async (t) => {
  process.env.ELEVENLABS_API_KEY = 'test-only-secret';
  let reads = 0;
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false, status: 401,
    body: { getReader: () => ({
      async read() { reads++; return { done: false, value: Buffer.alloc(1024, 32) }; },
      async cancel() { cancelled = true; },
    }) },
  }));
  await assert.rejects(synthesize('Test text'), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, undefined);
    return true;
  });
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});


test('call counts survive recall and requeue, and public state exposes only safe fields', () => {
  const ticket = {
    id: 'private-id', number: 'V27-001', model: 'V27', name: 'Juan Dela Cruz',
    phone: 'private-phone', email: 'private-email', licenseNumber: 'private-license',
    licenseExpiry: '2099-12-31', hasLicensePhoto: true, status: 'waiting', createdAt: 1,
  };
  const state = { date: Q.today(), tickets: [ticket] };
  assert.equal(Q.callNext(state, 'V27').callCount, 1);
  assert.equal(Q.act(state, ticket.id, 'call').callCount, 2);
  const publicTicket = Q.publicState(state).tickets[0];
  assert.equal(publicTicket.callCount, 2);
  assert.equal(publicTicket.name, 'Juan');
  for (const field of ['id', 'phone', 'email', 'licenseNumber', 'licenseExpiry', 'hasLicensePhoto']) {
    assert.ok(!(field in publicTicket));
  }
  Q.act(state, ticket.id, 'requeue');
  assert.equal(Q.callNext(state, 'V27').callCount, 3);
});

test('live polling forwards callCount when a calledAt changes', async () => {
  const states = [123, 124].map((calledAt, i) => ({ tickets: [
    { number: 'V27-001', model: 'V27', name: 'Juan', status: 'called', calledAt, callCount: i + 1 },
  ] }));
  const calls = [];
  let tick;
  let updates = 0;
  const context = vm.createContext({
    fetch: async () => ({ ok: true, json: async () => states.shift() }),
    document: { hidden: false, addEventListener() {} },
    setTimeout: (fn) => { tick = fn; }, clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/common.js'), 'utf8'), context);
  context.live(() => { updates++; }, (ticket) => calls.push(JSON.parse(JSON.stringify(ticket))));
  for (let i = 0; i < 20 && !tick; i++) await Promise.resolve();
  assert.equal(updates, 1);
  await tick();
  assert.deepEqual(calls, [{ number: 'V27-001', model: 'V27', name: 'Juan', callCount: 2 }]);
});


test('prefix numbers zero through ninety-nine and malformed tickets retain browser parity', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/common.js'), 'utf8'), context);
  const expected = 'zero, one, two, three, four, five, six, seven, eight, nine, ten, eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen, nineteen, twenty, twenty-one, twenty-two, twenty-three, twenty-four, twenty-five, twenty-six, twenty-seven, twenty-eight, twenty-nine, thirty, thirty-one, thirty-two, thirty-three, thirty-four, thirty-five, thirty-six, thirty-seven, thirty-eight, thirty-nine, forty, forty-one, forty-two, forty-three, forty-four, forty-five, forty-six, forty-seven, forty-eight, forty-nine, fifty, fifty-one, fifty-two, fifty-three, fifty-four, fifty-five, fifty-six, fifty-seven, fifty-eight, fifty-nine, sixty, sixty-one, sixty-two, sixty-three, sixty-four, sixty-five, sixty-six, sixty-seven, sixty-eight, sixty-nine, seventy, seventy-one, seventy-two, seventy-three, seventy-four, seventy-five, seventy-six, seventy-seven, seventy-eight, seventy-nine, eighty, eighty-one, eighty-two, eighty-three, eighty-four, eighty-five, eighty-six, eighty-seven, eighty-eight, eighty-nine, ninety, ninety-one, ninety-two, ninety-three, ninety-four, ninety-five, ninety-six, ninety-seven, ninety-eight, ninety-nine'.split(', ');
  assert.equal(expected.length, 100);
  for (let i = 0; i < 100; i++) {
    const ticket = { number: `V${i}-012`, callCount: 1 };
    const sentence = `Queue Number V ${expected[i]}, zero one two. Please proceed to the iCAUR Booth for your test drive.`;
    assert.equal(announcementText(ticket), sentence);
    assert.equal(context.callAnnouncementText(ticket), sentence);
  }
  for (const [number, spoken] of [['V27-12', 'V 2 7 - 1 2'], ['V100-001', 'V 1 0 0 - 0 0 1'], ['AB23-012', 'A B twenty-three, zero one two']]) {
    const ticket = { number };
    assert.equal(announcementText(ticket), `Queue Number ${spoken}. Please proceed to the iCAUR Booth for your test drive.`);
    assert.equal(context.callAnnouncementText(ticket), announcementText(ticket));
  }
});

test('memory cache evicts least recently used entries, including overwritten entries', () => {
  const cache = memoryCache();
  for (let i = 0; i < 50; i++) cache.set(String(i), Buffer.from([i]));
  cache.get('0');
  cache.set('1', Buffer.from('updated'));
  cache.set('50', Buffer.from([50]));
  assert.equal(cache.get('2'), undefined);
  assert.deepEqual(cache.get('0'), Buffer.from([0]));
  assert.equal(cache.get('1').toString(), 'updated');
});

test('queue storage failures and untrusted error codes produce only fixed safe log lines', async () => {
  process.env.OPENAI_API_KEY = 'test-only-secret';
  const logs = [];
  const announce = createAnnouncer({ log: (line) => logs.push(line), generate: async () => {
    throw Object.assign(new Error('Juan PrivateSurname test-only-secret'), { status: 401, code: 'juan_privatesurname' });
  } });
  assert.deepEqual(await announce(() => { throw new Error('test-only-secret'); }, 'V27-001'), { status: 503, body: { error: 'Voice unavailable' } });
  assert.deepEqual(await announce(fixture(), 'V27-001'), { status: 503, body: { error: 'Voice unavailable' } });
  assert.deepEqual(logs, ['Announcement voice unavailable (openai): 502 queue storage failure', 'Announcement voice unavailable (openai): 401 authentication rejected']);
});

test('ElevenLabs rejects empty successful responses', async (t) => {
  process.env.ELEVENLABS_API_KEY = 'test-only-secret';
  t.mock.method(globalThis, 'fetch', async () => new Response(''));
  await assert.rejects(synthesize('Test text'), { status: 502, reason: 'Empty audio' });
});
