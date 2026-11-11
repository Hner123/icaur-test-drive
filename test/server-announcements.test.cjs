// Exercise the real local HTTP adapter in an isolated workspace. Provider fetch is mocked in the child.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('local HTTP adapter: 400/404/503/200, call/recall, privacy, dedupe, cache and failure retry', async () => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'icaur-announce-server-'));
  let child;
  let output = '';
  try {
    fs.copyFileSync(path.join(root, 'server.js'), path.join(temp, 'server.js'));
    fs.cpSync(path.join(root, 'lib'), path.join(temp, 'lib'), { recursive: true });
    const providerMode = path.join(temp, 'provider-mode');
    fs.writeFileSync(providerMode, 'ok');
    fs.writeFileSync(path.join(temp, 'mock-provider.cjs'), `
      const fs = require('node:fs');
      let calls = 0;
      globalThis.fetch = async (url, options) => {
        if (url !== 'https://api.openai.com/v1/audio/speech') throw new Error('Unexpected external request');
        const text = JSON.parse(options.body).input;
        if (!text.includes('Juan Dela Cruz') || text.includes('NEVER-SPEAK')) throw new Error('Incorrect server text');
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (fs.readFileSync(${JSON.stringify(providerMode)}, 'utf8') === 'fail') {
          return Response.json({ error: { code: 'invalid_api_key', message: 'NEVER-LOG-provider-body' } }, { status: 401 });
        }
        return new Response('MP3-fixture-' + calls);
      };
    `);
    async function start(configured) {
      const env = { ...process.env, PORT: '3114', STAFF_PIN: '1234', SMS_PROVIDER: 'none' };
      for (const name of ['OPENAI_API_KEY', 'TTS_PROVIDER', 'ELEVENLABS_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_TTS_MODEL', 'OPENAI_TTS_VOICE']) delete env[name];
      if (configured) Object.assign(env, { OPENAI_API_KEY: 'test-only-secret', TTS_PROVIDER: 'openai' });
      child = spawn(process.execPath, ['--require', './mock-provider.cjs', 'server.js'], { cwd: temp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        let startup = '';
        const timer = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
        child.stdout.on('data', (data) => { output += data; startup += data; if (startup.includes('Lobby display')) { clearTimeout(timer); resolve(); } });
        child.stderr.on('data', (data) => { output += data; });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
      });
    }
    async function stop() {
      if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    }
    const request = (url, options) => fetch(`http://localhost:3114${url}`, { ...options, signal: AbortSignal.timeout(5000) });
    const post = (url, body, staff = false) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(staff ? { 'x-staff-pin': '1234' } : {}) }, body: JSON.stringify(body || {}) });
    await start(false);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
    const registration = { model: 'V27', name: 'Juan Dela Cruz', phone: '09170000001', email: 'fixture@example.test', gender: 'Male', locationDealer: 'iCAUR Makati', salesExecutive: 'Fixture Executive', testDriveResource: 'Event', consent: true, hasReservation: false, licenseNumber: 'FIXTURE-001', licenseExpiry: '2099-12-31', licensePhoto: png, licenseBackPhoto: png, signature: png };
    const created = await post('/api/tickets', registration);
    assert.equal(created.status, 201);
    const ticket = (await created.json()).ticket;
    assert.equal(ticket.number, 'V27-001');
    const announce = () => request(`/api/announce?number=${ticket.number}&text=NEVER-SPEAK`);
    assert.equal((await request('/api/announce?number=bad')).status, 400);
    assert.equal((await request('/api/announce?number=V27-999')).status, 404);
    assert.equal((await announce()).status, 404, 'waiting ticket cannot speak');
    const call = await post('/api/staff/next/V27', {}, true);
    assert.equal(call.status, 200);
    const called = (await call.json()).ticket;
    assert.equal(called.callCount, 1);
    const before = performance.now();
    const disabled = await announce();
    assert.equal(disabled.status, 503);
    assert.deepEqual(await disabled.json(), { error: 'Voice not configured' });
    assert.ok(performance.now() - before < 1000);
    await stop();
    await start(true);
    const pair = await Promise.all([announce(), announce()]);
    for (const response of pair) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'audio/mpeg');
      assert.equal(response.headers.get('cache-control'), 'private, max-age=300');
      assert.equal(await response.text(), 'MP3-fixture-1');
    }
    assert.equal(await (await announce()).text(), 'MP3-fixture-1');
    const recall = await post(`/api/staff/tickets/${ticket.id}/call`, {}, true);
    assert.equal(recall.status, 200);
    const recalled = (await recall.json()).ticket;
    assert.equal(recalled.callCount, 2);
    assert.notEqual(recalled.calledAt, called.calledAt);
    fs.writeFileSync(providerMode, 'fail');
    for (let i = 0; i < 2; i++) {
      const failed = await announce();
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: 'Voice unavailable' });
    }
    fs.writeFileSync(providerMode, 'ok');
    assert.equal(await (await announce()).text(), 'MP3-fixture-4', 'failed generations are retried');
    assert.equal(await (await announce()).text(), 'MP3-fixture-4');
    const state = await (await request('/api/state')).json();
    assert.deepEqual(Object.keys(state.tickets[0]).sort(), ['number', 'model', 'name', 'status', 'createdAt', 'calledAt', 'callCount'].sort());
    assert.equal(state.tickets[0].name, 'Juan');
    assert.equal(state.tickets[0].callCount, 2);
    await post(`/api/staff/tickets/${ticket.id}/start`, {}, true);
    assert.equal((await announce()).status, 404, 'cached audio is unavailable after ticket leaves called status');
    assert.match(output, /Announcement voice unavailable \(openai\): 401 authentication rejected \(invalid_api_key\)/);
    assert.doesNotMatch(output, /Juan|Dela Cruz|test-only-secret|NEVER-LOG|data:image/);
    console.log('Local HTTP: 400/404/503/200; no-key response under 1 s; callCount 1/2; MP3 dedupe/cache/retry; public privacy verified.');
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('icaur-announce-server-'));
    fs.rmSync(temp, { recursive: true, force: true });
    assert.equal(fs.existsSync(temp), false);
  }
});
