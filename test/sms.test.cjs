const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sendSms, provider, toE164, mask } = require('../lib/sms');

const envNames = [
  'SMS_PROVIDER', 'SMSGATE_USERNAME', 'SMSGATE_PASSWORD', 'SMSGATE_SIM', 'SMSGATE_URL',
  'TRACCAR_KEY', 'SEMAPHORE_KEY', 'SEMAPHORE_SENDER',
];
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const phone = '+639171234567';
const message = 'Private welcome message';
const password = 'private-smsgate-password';
const username = 'private-smsgate-user';
const traccarKey = 'private-traccar-key';
const semaphoreKey = 'private-semaphore-key';
const responseBody = 'private-provider-response';
let logs;
let calls;

beforeEach((t) => {
  for (const name of envNames) delete process.env[name];
  logs = [];
  calls = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return new Response(responseBody, { status: 202 });
  });
});

afterEach(() => {
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  const output = logs.join('\n');
  for (const secret of [phone, phone.slice(1), '09171234567', message, username, password,
    traccarKey, semaphoreKey, responseBody, Buffer.from(username + ':' + password).toString('base64')]) {
    assert.equal(output.includes(secret), false, `logs exposed ${secret}`);
  }
});

function credentials(which) {
  process.env.SMS_PROVIDER = which;
  process.env.SMSGATE_USERNAME = username;
  process.env.SMSGATE_PASSWORD = password;
  process.env.TRACCAR_KEY = traccarKey;
  process.env.SEMAPHORE_KEY = semaphoreKey;
}

test('toE164 normalizes local, country-code, plus and 0063 numbers', () => {
  for (const input of ['09171234567', '639171234567', phone, '00639171234567', '9171234567', '917 123 4567']) {
    assert.equal(toE164(input), phone);
  }
});

test('mask keeps only the first three and last two characters; short input stays hidden', () => {
  assert.equal(mask(phone), '+63***67');
  for (const input of ['', undefined, '123', '12345']) assert.equal(mask(input), '***');
});

test('automatic provider precedence requires both SMSGate credentials', () => {
  assert.equal(provider(), 'none');
  process.env.SEMAPHORE_KEY = semaphoreKey;
  assert.equal(provider(), 'semaphore');
  process.env.TRACCAR_KEY = traccarKey;
  assert.equal(provider(), 'traccar');
  process.env.SMSGATE_USERNAME = username;
  assert.equal(provider(), 'traccar');
  process.env.SMSGATE_PASSWORD = password;
  assert.equal(provider(), 'smsgate');
  delete process.env.SMSGATE_USERNAME;
  assert.equal(provider(), 'traccar');
  for (const which of ['smsgate', 'traccar', 'semaphore', 'none']) {
    process.env.SMS_PROVIDER = which;
    assert.equal(provider(), which);
  }
});

for (const sim of [undefined, '1', '2', '3', '5', 'abc', '0', '2.5']) {
  test(`SMSGate sends exact authenticated JSON with SIM ${sim}`, async () => {
    credentials('smsgate');
    if (sim !== undefined) process.env.SMSGATE_SIM = sim;
    assert.deepEqual(await sendSms('09171234567', message), { ok: true, status: 202 });
    assert.equal(calls.length, 1);
    const [url, options] = calls[0];
    assert.equal(url, 'https://api.sms-gate.app/3rdparty/v1/messages');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
    });
    const expected = { textMessage: { text: message }, phoneNumbers: [phone] };
    if (['1', '2', '3'].includes(sim)) expected.simNumber = Number(sim);
    assert.deepEqual(JSON.parse(options.body), expected);
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(logs, ['[sms:smsgate] +63***67 -> sent (queued)']);
  });
}

test('SMSGate honors URL override and accepts 204 without reading its body', async (t) => {
  credentials('smsgate');
  process.env.SMSGATE_URL = 'https://example.invalid/messages';
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, process.env.SMSGATE_URL);
    return { ok: true, status: 204, text() { throw new Error('must not read body'); } };
  });
  assert.deepEqual(await sendSms(phone, message), { ok: true, status: 204 });
});

for (const which of ['smsgate', 'traccar', 'semaphore']) {
  test(`${which} missing credentials skips even with other providers configured`, async () => {
    credentials(which);
    const missing = which === 'smsgate' ? ['SMSGATE_USERNAME', 'SMSGATE_PASSWORD']
      : [which === 'traccar' ? 'TRACCAR_KEY' : 'SEMAPHORE_KEY'];
    for (const name of missing) {
      const value = process.env[name];
      delete process.env[name];
      assert.deepEqual(await sendSms(phone, message), { skipped: true });
      process.env[name] = value;
    }
    assert.equal(calls.length, 0);
    assert.ok(logs.every(line => line === '[sms:skipped] +63***67'));
  });

  test(`${which} logs HTTP failure status without body or secrets`, async (t) => {
    credentials(which);
    t.mock.method(globalThis, 'fetch', async () => new Response(responseBody, { status: 401 }));
    assert.deepEqual(await sendSms(phone, message), { ok: false, status: 401 });
    assert.deepEqual(logs, [`[sms:${which}] +63***67 -> FAILED 401`]);
  });

  test(`${which} logs only request failed for errors containing private data`, async (t) => {
    credentials(which);
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error([password, phone, message, responseBody, traccarKey, semaphoreKey].join(' '));
    });
    assert.deepEqual(await sendSms(phone, message), { ok: false, status: 0 });
    assert.deepEqual(logs, [`[sms:${which}] +63***67 -> ERROR request failed`]);
  });

  test(`${which} aborts promptly and logs only timeout`, async (t) => {
    credentials(which);
    let aborted = false;
    t.mock.method(globalThis, 'fetch', async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }));
    assert.deepEqual(await sendSms(phone, message, { timeoutMs: 5 }), { ok: false, status: 0 });
    assert.equal(aborted, true);
    assert.deepEqual(logs, [`[sms:${which}] +63***67 -> ERROR timeout`]);
  });
}

for (const which of [undefined, 'none', 'unrecognized']) {
  test(`provider ${which} skips without leaking message text`, async () => {
    if (which !== undefined) credentials(which);
    assert.deepEqual(await sendSms(phone, message), { skipped: true });
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, ['[sms:skipped] +63***67']);
  });
}

for (const success of [true, false]) {
  test(`Traccar preserves HTTP 200 body verdict: success=${success}`, async (t) => {
    credentials('traccar');
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://www.traccar.org/sms/');
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.headers, { 'Content-Type': 'application/json', Authorization: traccarKey });
      assert.deepEqual(JSON.parse(options.body), { to: phone, message });
      return new Response(JSON.stringify({
        padding: responseBody.repeat(20),
        successCount: success ? 1 : 0, failureCount: success ? 0 : 1,
        responses: [{ error: { message: [password, phone, message, responseBody].join(' ') } }],
      }), { status: 200 });
    });
    assert.deepEqual(await sendSms(phone, message), { ok: success, status: 200 });
    assert.deepEqual(logs, [`[sms:traccar] +63***67 -> ${success ? 'sent' : 'FAILED 200'}`]);
  });
}

test('Traccar timeout also covers reading its response body', async (t) => {
  credentials('traccar');
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => ({
    ok: true, status: 200,
    text: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }));
  assert.deepEqual(await sendSms(phone, message, { timeoutMs: 5 }), { ok: false, status: 0 });
  assert.deepEqual(logs, ['[sms:traccar] +63***67 -> ERROR timeout']);
});

test('Traccar keeps HTTP verdict when response is not JSON', async () => {
  credentials('traccar');
  assert.deepEqual(await sendSms(phone, message), { ok: true, status: 202 });
  assert.deepEqual(logs, ['[sms:traccar] +63***67 -> sent']);
});

for (const sender of [undefined, 'SHOWROOM']) {
  test(`Semaphore keeps request format and HTTP success with sender ${sender}`, async () => {
    credentials('semaphore');
    if (sender) process.env.SEMAPHORE_SENDER = sender;
    assert.deepEqual(await sendSms(phone, message), { ok: true, status: 202 });
    const [url, options] = calls[0];
    assert.equal(url, 'https://api.semaphore.co/api/v4/messages');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), {
      apikey: semaphoreKey, number: phone, message, sendername: sender || 'SEMAPHORE',
    });
    assert.deepEqual(logs, ['[sms:semaphore] +63***67 -> sent']);
  });
}

test('production requests use a six-second timeout and clear it on completion', async (t) => {
  credentials('smsgate');
  const timer = {};
  let cleared = false;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 6000);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (value) => {
    assert.equal(value, timer);
    cleared = true;
  });
  assert.deepEqual(await sendSms(phone, message), { ok: true, status: 202 });
  assert.equal(cleared, true);
});
