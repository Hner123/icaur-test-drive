// Which SMS goes out when. All sends are best-effort: a failed text never fails the request.
const { MODELS } = require('./queue');
const { sendSms } = require('./sms');

const BRAND = 'XPENG Test Drive';

function modelOf(ticket) {
  return MODELS.find((m) => m.id === ticket.model) || { name: ticket.model, units: 1, minutes: 0 };
}

function firstWaiting(state, modelId) {
  return state.tickets.filter((t) => t.model === modelId && t.status === 'waiting').sort((a, b) => a.createdAt - b.createdAt)[0] || null;
}

// Snapshot of who is first in line per model; take it before a change, compare after.
function firstWaitingIds(state) {
  return Object.fromEntries(MODELS.map((m) => [m.id, (firstWaiting(state, m.id) || {}).id || null]));
}

// On registration
function welcome(state, ticket, position) {
  const m = modelOf(ticket);
  const ahead = Math.max(position - 1, 0);
  const est = Math.max(0, Math.ceil(ahead / m.units)) * m.minutes;
  const wait = ahead === 0 ? "You're first in line." : `${ahead} ahead of you, est. wait ${est} min.`;
  return sendSms(ticket.phone, `${BRAND}: You're in the ${m.name} queue as ${ticket.number}. ${wait} We'll text you when it's your turn.`);
}

// On call / recall
function yourTurn(ticket) {
  return sendSms(ticket.phone, `${BRAND}: ${ticket.number}, it's your turn! Please proceed to the front desk with your driver's license.`);
}

// After any change, text whoever newly became first in line (once per ticket).
// Returns true if a ticket was flagged, so the caller knows to save again.
async function notifyNext(state, beforeIds, { skipId } = {}) {
  const sends = [];
  for (const m of MODELS) {
    const first = firstWaiting(state, m.id);
    if (!first || first.id === beforeIds[m.id] || first.id === skipId || first.nextNotifiedAt) continue;
    first.nextNotifiedAt = Date.now();
    sends.push(sendSms(first.phone, `${BRAND}: ${first.number}, you're next for the ${m.name}. Please head back to the showroom now.`));
  }
  await Promise.allSettled(sends);
  return sends.length > 0;
}

module.exports = { welcome, yourTurn, notifyNext, firstWaitingIds };
