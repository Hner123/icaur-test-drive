// SMS sending. Provider is picked from env:
//   SMSGATE_USERNAME + SMSGATE_PASSWORD -> SMSGate Android cloud API (preferred)
//   TRACCAR_KEY    → Traccar SMS Gateway app in Cloud mode (https://www.traccar.org/sms/)
//   SEMAPHORE_KEY  → Semaphore (PH), optional SEMAPHORE_SENDER (default "SEMAPHORE")
//   no credentials -> sends are skipped (app keeps working without SMS)
// Set SMS_PROVIDER=none to force-disable even if a key is present.

const TIMEOUT_MS = 6000;

function provider() {
  if (process.env.SMS_PROVIDER === 'none') return 'none';
  if (process.env.SMS_PROVIDER) return process.env.SMS_PROVIDER;
  if (process.env.SMSGATE_USERNAME && process.env.SMSGATE_PASSWORD) return 'smsgate';
  if (process.env.TRACCAR_KEY) return 'traccar';
  if (process.env.SEMAPHORE_KEY) return 'semaphore';
  return 'none';
}

// PH-centric E.164: 09171234567 or 9171234567 -> +639171234567; + kept, 00 -> +, 63 -> +63.
function toE164(phone) {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) return p;
  if (p.startsWith('00')) return '+' + p.slice(2);
  if (p.startsWith('0')) return '+63' + p.slice(1);
  if (p.startsWith('63')) return '+' + p;
  if (/^9\d{9}$/.test(p)) return '+63' + p;
  return '+' + p;
}

function mask(phone) {
  const p = String(phone || '');
  return p.length > 5 ? p.slice(0, 3) + '***' + p.slice(-2) : '***';
}

async function post(url, headers, body, timeoutMs, readBody = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    const text = readBody ? await res.text().catch((err) => {
      if (err?.name === 'AbortError') throw err;
      return '';
    }) : '';
    return { ok: res.ok, status: res.status, body: text };
  } finally {
    clearTimeout(timer);
  }
}

// The optional timeout override keeps mocked abort tests fast; callers use six seconds.
async function sendSms(phone, message, { timeoutMs = TIMEOUT_MS } = {}) {
  const to = toE164(phone);
  const masked = mask(to);
  const which = provider();
  try {
    let r;
    if (which === 'smsgate' && process.env.SMSGATE_USERNAME && process.env.SMSGATE_PASSWORD) {
      const body = { textMessage: { text: message }, phoneNumbers: [to] };
      if (/^[1-3]$/.test(process.env.SMSGATE_SIM || '')) {
        body.simNumber = Number(process.env.SMSGATE_SIM);
      }
      r = await post(
        process.env.SMSGATE_URL || 'https://api.sms-gate.app/3rdparty/v1/messages',
        {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + Buffer.from(process.env.SMSGATE_USERNAME + ':' + process.env.SMSGATE_PASSWORD).toString('base64'),
        },
        JSON.stringify(body),
        timeoutMs,
      );
    } else if (which === 'traccar' && process.env.TRACCAR_KEY) {
      r = await post(
        'https://www.traccar.org/sms/',
        { 'Content-Type': 'application/json', Authorization: process.env.TRACCAR_KEY },
        JSON.stringify({ to, message }),
        timeoutMs,
        true,
      );
      // Traccar replies 200 even on failure; the verdict is in the body:
      // {"successCount":1,"failureCount":0,...} or {"successCount":0,"failureCount":1,"responses":[{"error":{...}}]}
      try {
        const j = JSON.parse(r.body);
        if (typeof j.failureCount === 'number') {
          r.ok = j.failureCount === 0 && j.successCount > 0;
        }
      } catch {}
    } else if (which === 'semaphore' && process.env.SEMAPHORE_KEY) {
      r = await post(
        'https://api.semaphore.co/api/v4/messages',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ apikey: process.env.SEMAPHORE_KEY, number: to, message, sendername: process.env.SEMAPHORE_SENDER || 'SEMAPHORE' }),
        timeoutMs,
      );
    } else {
      console.log(`[sms:skipped] ${masked}`);
      return { skipped: true };
    }
    console.log(`[sms:${which}] ${masked} -> ${r.ok ? (which === 'smsgate' ? 'sent (queued)' : 'sent') : 'FAILED ' + r.status}`);
    return { ok: r.ok, status: r.status };
  } catch (err) {
    console.log(`[sms:${which}] ${masked} -> ERROR ${err?.name === 'AbortError' ? 'timeout' : 'request failed'}`);
    return { ok: false, status: 0 };
  }
}

module.exports = { sendSms, toE164, provider, mask };
