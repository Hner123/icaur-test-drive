// Execute the real display module with fake media and a deterministic clock; no GUI needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MODELS } = require('../lib/queue');

function display({ fetchMode = 'ok', audioMode = 'ok', duration = 2, speechStalls = false } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const spoken = [], fetched = [], played = [], revoked = [], events = [];
  const button = {};
  const listeners = {};
  const setTimeout = (fn, ms) => { timers.set(++timerId, { fn, at: now + ms }); return timerId; };
  const clearTimeout = (id) => timers.delete(id);
  const document = {
    hidden: false, body: { dataset: {} }, querySelector: () => button,
    addEventListener: (name, fn) => { listeners[name] = fn; },
  };
  class Audio {
    constructor(src) { this.src = src; this.duration = duration; }
    play() {
      if (this.src.startsWith('data:')) { events.push('unlock'); return Promise.resolve(); }
      played.push({ src: this.src, at: now });
      if (audioMode === 'reject' || (audioMode === 'second-reject' && played.length === 2)) return Promise.reject(new Error('blocked'));
      if (audioMode === 'error') setTimeout(() => this.onerror?.(), 20);
      else if (audioMode !== 'stall') setTimeout(() => this.onended?.(), 120);
      return Promise.resolve();
    }
    pause() { events.push('pause'); }
    removeAttribute() { this.src = ''; }
    load() {}
  }
  const synth = {
    getVoices: () => [], cancel() {},
    speak(utterance) {
      spoken.push(utterance.text);
      if (!speechStalls) setTimeout(() => utterance.onend?.(), 120);
    },
  };
  class DateMock extends Date { static now() { return now; } }
  const context = vm.createContext({
    document, Audio, AbortController, Date: DateMock, setTimeout, clearTimeout,
    window: { speechSynthesis: synth, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } },
    URL: { createObjectURL: () => 'blob:voice', revokeObjectURL: (url) => revoked.push(url) },
    fetch: async (url, { signal, cache }) => {
      assert.equal(cache, 'no-store', 'recalls must bypass the browser HTTP cache');
      fetched.push(url);
      if (fetchMode === 'timeout') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      if (fetchMode === 'reject') throw new Error('network');
      if (fetchMode === 'disabled') return { status: 503, json: async () => ({ error: 'Voice not configured' }) };
      if (fetchMode === 'unavailable') return { status: 503, json: async () => ({ error: 'Voice unavailable' }) };
      return { status: 200, blob: async () => ({}) };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/common.js'), 'utf8'), context);
  context.chime = () => events.push('chime');
  const html = fs.readFileSync(path.join(__dirname, '../public/display.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script); // Also parse the entire actual inline script, including render/theme.
  vm.runInContext('let soundOn = false;\n' + script.slice(script.indexOf('const announcements ='), script.indexOf('function tick()')), context);
  context.models = MODELS;
  vm.runInContext('announcements.setModels(models)', context);
  async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  async function idle() {
    for (let i = 0; i < 200; i++) {
      await flush();
      if (!timers.size) return;
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id);
      now = timer.at;
      timer.fn();
    }
    assert.fail('announcement queue stalled');
  }
  function call(number = 'V27-001', callCount = 1) {
    context.ticket = { number, model: 'V27', name: 'Juan', callCount };
    vm.runInContext('announcements.call(ticket)', context);
  }
  return {
    button, document, spoken, fetched, played, revoked, events, idle, call,
    enable: async () => { button.onclick(); await idle(); },
    advance: (ms) => { now += ms; },
    visibility: (hidden) => { document.hidden = hidden; listeners.visibilitychange(); },
  };
}

test('nothing plays before unlock; real calls play MP3 twice with a gap and release the URL', async () => {
  const h = display();
  h.call(); await h.idle();
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.spoken, []);
  await h.enable();
  assert.ok(h.events.includes('unlock'));
  assert.equal(h.button.textContent, 'Test announcement');
  h.call(); await h.idle();
  assert.deepEqual(h.fetched, ['/api/announce?number=V27-001']);
  assert.equal(h.played.length, 2);
  assert.equal(h.played[1].at - h.played[0].at, 1120);
  assert.deepEqual(h.revoked, ['blob:voice']);
  assert.deepEqual(h.spoken, ['Call announcements are on.']);
  assert.equal(h.document.body.dataset.voice, 'ai');
  assert.equal(h.button.disabled, false);
});

for (const settings of [
  { fetchMode: 'reject' }, { fetchMode: 'timeout' }, { fetchMode: 'unavailable' },
  { audioMode: 'reject' }, { audioMode: 'error' },
  { audioMode: 'stall', duration: NaN }, { audioMode: 'stall', duration: 12 },
]) {
  test(`display falls back twice and drains after ${JSON.stringify(settings)}`, async () => {
    const h = display(settings);
    await h.enable();
    h.call(); await h.idle();
    assert.equal(h.spoken.length, 3);
    assert.equal(h.spoken[1], h.spoken[2]);
    assert.equal(h.spoken[1], 'Queue Number V twenty-seven, zero zero one, Juan. Please proceed to the iCAUR Booth for your test drive.');
    assert.equal(h.document.body.dataset.voice, 'browser');
    assert.equal(h.button.disabled, false);
    if (settings.audioMode) assert.deepEqual(h.revoked, ['blob:voice']);
  });
}

test('successful first playback with failed repeat avoids browser fallback and drains', async () => {
  const h = display({ audioMode: 'second-reject' });
  await h.enable();
  h.call(); await h.idle();
  assert.equal(h.played.length, 2);
  assert.deepEqual(h.spoken, ['Call announcements are on.']);
  assert.equal(h.document.body.dataset.voice, 'ai');
  assert.deepEqual(h.revoked, ['blob:voice']);
  assert.equal(h.button.disabled, false);
  h.call('V27-002'); await h.idle();
  assert.equal(h.played.length, 4);
  assert.deepEqual(h.spoken, ['Call announcements are on.']);
});

test('unconfigured voice skips requests for five minutes, then retries', async () => {
  const h = display({ fetchMode: 'disabled' });
  await h.enable();
  h.call(); await h.idle();
  h.call(); await h.idle();
  assert.equal(h.fetched.length, 1);
  assert.equal(h.spoken.length, 5);
  h.advance(5 * 60 * 1000);
  h.call(); await h.idle();
  assert.equal(h.fetched.length, 2);
});

test('test button uses browser speech without requesting fabricated ticket audio', async () => {
  const h = display();
  await h.enable();
  h.button.onclick(); await h.idle();
  assert.equal(h.fetched.length, 0);
  assert.equal(h.spoken[1], 'Queue Number V twenty-seven, zero zero one, Juan Dela Cruz. Please proceed to the iCAUR Booth for your test drive.');
  assert.equal(h.spoken.length, 3);
  assert.equal(h.spoken[1], h.spoken[2]);
});

test('hidden queue keeps only five pending, resumes in order, and recalls reannounce', async () => {
  const h = display();
  await h.enable();
  h.visibility(true);
  for (let i = 1; i <= 7; i++) h.call(`V27-00${i}`);
  await h.idle();
  assert.equal(h.fetched.length, 0);
  h.visibility(false); await h.idle();
  assert.deepEqual(h.fetched, [3, 4, 5, 6, 7].map((i) => `/api/announce?number=V27-00${i}`));
  assert.equal(h.played.length, 10);
  h.call('V27-007'); await h.idle();
  assert.equal(h.played.length, 12);
});

test('speech watchdog also allows the queue to finish when browser speech stalls', async () => {
  const h = display({ fetchMode: 'unavailable', speechStalls: true });
  await h.enable();
  h.call(); h.call('V27-002'); await h.idle();
  assert.equal(h.spoken.length, 5);
  assert.equal(h.button.disabled, false);
});


test('browser fallback uses recall wording twice', async () => {
  const h = display({ fetchMode: 'unavailable' });
  await h.enable();
  h.call('V27-001', 2); await h.idle();
  const expected = 'Now serving Queue Number V twenty-seven, zero zero one, Juan. Please proceed to the iCAUR Booth. Thank you!';
  assert.deepEqual(h.spoken, ['Call announcements are on.', expected, expected]);
});
