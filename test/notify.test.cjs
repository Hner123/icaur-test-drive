const { test } = require('node:test');
const assert = require('node:assert/strict');

const smsPath = require.resolve('../lib/sms');
const originalSms = require.cache[smsPath];
const calls = [];
require.cache[smsPath] = {
  id: smsPath,
  filename: smsPath,
  loaded: true,
  exports: { sendSms: (phone, text) => calls.push({ phone, text }) },
};
const { yourTurn } = require('../lib/notify');
if (originalSms) require.cache[smsPath] = originalSms;
else delete require.cache[smsPath];

const body = 'We would like to inform you that your Queue Number V27-001 is now being called. Kindly proceed to the iCAUR Booth and approach our staff for assistance.\n\n' +
  'Please have your queue number ready and make sure to proceed within 10 minutes to avoid delays and cancellation in the process.\n\n' +
  'Thank you for your patience and cooperation. We look forward to assisting you!';

test('yourTurn sends the approved template with normalized name and GSM-7 safe ASCII', () => {
  for (const name of ['Juan Dela Cruz', '  Juan\t Dela\n Cruz  ', '', ' \t\n ', undefined]) {
    const expected = (name && name.trim() ? 'Good day, Juan Dela Cruz!' : 'Good day!') + '\n\n' + body;
    const before = calls.length;
    yourTurn({ phone: '09171234567', name, number: 'V27-001' });
    assert.equal(calls.length, before + 1);
    assert.deepEqual(calls.at(-1), { phone: '09171234567', text: expected });
    // Printable ASCII and LF only; backtick is ASCII but absent from GSM-7.
    assert.match(calls.at(-1).text, /^[\x20-\x5f\x61-\x7e\n]+$/);
  }
});
