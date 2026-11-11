const crypto = require('crypto');

// Queue rules shared by the local Node server (server.js) and the Netlify function (netlify/functions/api.mjs).
// Everything here is plain state-in / state-out; persistence lives in the caller.

// Models offered for test drive. `units` = demo cars available, `minutes` = avg drive length.
const MODELS = [
  { id: 'V27', name: 'V27', prefix: 'V27-', tagline: 'Golden REEV SUV', image: '/img/v27.webp', units: 1, minutes: 20 },
  { id: 'V23', name: 'V23', prefix: 'V23-', tagline: 'Boxy Lifestyle EV', image: '/img/v23.webp', units: 1, minutes: 20 },
];

const ACTIVE = ['waiting', 'called', 'driving'];

// Showroom's local day, regardless of where the code runs (Netlify functions run in UTC).
const TZ = process.env.QUEUE_TZ || 'Asia/Manila';
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function emptyState() {
  return { date: today(), counters: {}, tickets: [] };
}

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, extra });
}

function maskPhone(p = '') {
  return p.length > 4 ? p.slice(0, 2) + '•'.repeat(p.length - 4) + p.slice(-2) : p;
}

function publicState(state) {
  return {
    date: state.date,
    models: MODELS.map((m) => {
      const waiting = state.tickets.filter((t) => t.model === m.id && t.status === 'waiting');
      return { ...m, waitingCount: waiting.length, estWaitMin: Math.ceil(waiting.length / m.units) * m.minutes };
    }),
    // Anyone can read this, so it lists only what the lobby display needs. Never add the ticket id:
    // it is what lets a customer open and cancel their own ticket.
    tickets: state.tickets.map((t) => ({
      number: t.number,
      model: t.model,
      name: t.name.split(' ')[0],
      status: t.status,
      createdAt: t.createdAt,
      calledAt: t.calledAt,
      callCount: t.callCount,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
    })),
    locationDealers: LOCATION_DEALERS,
    testDriveResources: TEST_DRIVE_RESOURCES,
    reservationDealers: RESERVATION_DEALERS,
  };
}

function position(state, ticket) {
  if (ticket.status !== 'waiting') return 0;
  return state.tickets.filter((t) => t.model === ticket.model && t.status === 'waiting' && t.createdAt <= ticket.createdAt).length;
}

// Limits leave headroom below Netlify's request limit, including base64 and JSON overhead.
const MAX_BODY_BYTES = 5500000;
const MAX_PHOTO_BYTES = 1800000;
const MAX_SIGNATURE_BYTES = 199999;

function decodePhoto(dataUrl, signature = false) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > (signature ? MAX_SIGNATURE_BYTES : MAX_PHOTO_BYTES)) throw httpError(413, signature ? 'Signature is too large (under 200 KB required)' : 'License photo is too large (maximum 1.8 MB each)');
  if (bytes.toString('base64') !== m[2]) return null;
  // Check container markers and dimensions; reject data merely labelled as an image.
  const png = bytes.length >= 57 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
    bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND';
  const jpeg = bytes.length > 20 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  const webp = bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!(signature ? m[1] === 'image/png' && png : m[1] === 'image/png' && png || m[1] === 'image/jpeg' && jpeg || m[1] === 'image/webp' && webp)) return null;
  return { type: m[1], bytes };
}

function ticketMedia(body) {
  const front = decodePhoto(body.licensePhoto);
  if (!front) throw httpError(400, "A valid driver's license front photo is required");
  const back = decodePhoto(body.licenseBackPhoto);
  if (!back) throw httpError(400, "A valid driver's license back photo is required");
  const signature = decodePhoto(body.signature, true);
  if (!signature) throw httpError(400, 'A valid PNG signature is required');
  return { front, back, signature };
}

// Ticket holders use their secret id for the existing ticket view; extra registration
// details and media flags are available only in PIN-protected staff responses.
function customerTicket(ticket) {
  const { gender, locationDealer, salesExecutive, testDriveResource, consentAt, hasLicenseBack, hasSignature, ...visible } = ticket;
  return visible;
}

const LOCATION_DEALERS = ['iCAUR Clark', 'iCAUR Commonwealth', 'iCAUR Greenhills', 'iCAUR Makati', 'iCAUR Quezon Ave.'];
const TEST_DRIVE_RESOURCES = ['Showroom', 'Mall Display', 'Bank Display', 'Event'];

const RESERVATION_DEALERS = [
  'iCAUR Quezon Ave.', 'iCAUR Greenhills', 'iCAUR Makati', 'iCAUR Commonwealth',
  'iCAUR Clark', 'iCAUR Cebu', 'iCAUR Davao', 'iCAUR Iloilo',
];

// Shared validation keeps the two counter routes identical.
function updateReserved(current, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Provide delta (1 or -1) or set (an integer from 0 to 99999)');
  const keys = Object.keys(body);
  if (keys.length !== 1 || !(keys[0] === 'delta' && (body.delta === 1 || body.delta === -1) ||
      keys[0] === 'set' && Number.isInteger(body.set) && body.set >= 0 && body.set <= 99999)) {
    throw httpError(400, 'Provide delta (1 or -1) or set (an integer from 0 to 99999)');
  }
  return { count: Math.max(0, Math.min(99999, keys[0] === 'set' ? body.set : current.count + body.delta)), updatedAt: Date.now() };
}

function createTicket(state, body) {
  let { model, name, phone, email, gender, locationDealer, salesExecutive, testDriveResource, consent, hasReservation, reservationDealer, guestMatched, licenseNumber, licenseExpiry } = body;
  const m = MODELS.find((x) => x.id === model);
  if (!m) throw httpError(400, 'Unknown model');
  name = String(name || '').trim().slice(0, 60);
  phone = String(phone || '').replace(/[^\d+]/g, '').slice(0, 16);
  email = String(email || '').trim().toLowerCase().slice(0, 120);
  salesExecutive = typeof salesExecutive === 'string' ? salesExecutive.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'A valid e-mail address is required');
  if (!['Male', 'Female'].includes(gender)) throw httpError(400, 'Gender must be Male or Female');
  if (!LOCATION_DEALERS.includes(locationDealer)) throw httpError(400, 'Please choose a valid Location/Dealer');
  if (!salesExecutive || salesExecutive.length > 60) throw httpError(400, 'Assigned Sales Executive is required (1-60 characters)');
  if (!TEST_DRIVE_RESOURCES.includes(testDriveResource)) throw httpError(400, 'Please choose a valid Test Drive Resource');
  if (consent !== true) throw httpError(400, 'Consent to the use of your information is required');
  ticketMedia(body);
  if (typeof hasReservation !== 'boolean') throw httpError(400, 'Please tell us if you have an existing iCAUR reservation');
  if (hasReservation && !RESERVATION_DEALERS.includes(reservationDealer)) throw httpError(400, 'Please choose the dealer where you made your reservation');
  if (!name) throw httpError(400, 'Name is required');
  if (phone.replace(/\D/g, '').length < 7) throw httpError(400, 'A valid mobile number is required');
  // License details are stored in queue state; media is stored separately by each backend.
  licenseNumber = String(licenseNumber || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20) || null;
  licenseExpiry = /^\d{4}-\d{2}-\d{2}$/.test(licenseExpiry || '') ? licenseExpiry : null;
  if (!licenseNumber) throw httpError(400, 'Driver\'s license number is required');
  if (!licenseExpiry || !Number.isFinite(Date.parse(licenseExpiry + 'T00:00:00Z')) || new Date(licenseExpiry + 'T00:00:00Z').toISOString().slice(0, 10) !== licenseExpiry) throw httpError(400, 'A valid license expiration date is required');
  if (licenseExpiry < today()) throw httpError(400, `This license expired on ${licenseExpiry.replace(/-/g, '/')}. A valid license is required to test drive.`);

  const dupe = state.tickets.find((t) => t.phone === phone && t.model === model && ACTIVE.includes(t.status));
  // The person typing may not be the ticket holder, so the reply carries no ticket details.
  if (dupe) throw httpError(409, `You are already in the ${m.name} queue as ${dupe.number}`);

  state.counters[model] = (state.counters[model] || 0) + 1;
  const ticket = {
    id: crypto.randomBytes(16).toString('hex'),
    number: `${m.prefix}${String(state.counters[model]).padStart(3, '0')}`,
    model,
    name,
    phone,
    email,
    gender,
    locationDealer,
    salesExecutive,
    testDriveResource,
    consentAt: Date.now(),
    hasReservation,
    reservationDealer: hasReservation ? reservationDealer : null,
    guestMatched: !!guestMatched,
    licenseNumber,
    licenseExpiry,
    hasLicensePhoto: true,
    hasLicenseBack: true,
    hasSignature: true,
    status: 'waiting',
    createdAt: Date.now(),
  };
  state.tickets.push(ticket);
  return ticket;
}

const TRANSITIONS = {
  call: { from: ['waiting', 'called'], to: 'called', stamp: 'calledAt' },
  start: { from: ['called'], to: 'driving', stamp: 'startedAt' },
  finish: { from: ['driving'], to: 'done', stamp: 'finishedAt' },
  noshow: { from: ['called'], to: 'noshow', stamp: 'finishedAt' },
  requeue: { from: ['called', 'noshow'], to: 'waiting', stamp: null },
  cancel: { from: ['waiting', 'called'], to: 'cancelled', stamp: 'finishedAt' },
};

function act(state, id, action) {
  const t = state.tickets.find((x) => x.id === id);
  if (!t) throw httpError(404, 'Ticket not found');
  const tr = TRANSITIONS[action];
  if (!tr) throw httpError(400, 'Unknown action');
  if (!tr.from.includes(t.status)) throw httpError(409, `Cannot ${action} a ticket that is ${t.status}`);
  t.status = tr.to;
  if (action === 'call') t.callCount = (t.callCount || 0) + 1;
  if (tr.stamp) t[tr.stamp] = Date.now();
  if (action === 'requeue') t.createdAt = Date.now(); // back of the line
  return t;
}

function callNext(state, model) {
  const next = state.tickets
    .filter((t) => t.model === model && t.status === 'waiting')
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) throw httpError(404, 'No one waiting for this model');
  return act(state, next.id, 'call');
}

// A day can be stored in several pieces when staff reset the queue mid-day; the report wants all of them.
function mergeDay(date, states) {
  const tickets = states.flatMap((s) => s.tickets || []).sort((a, b) => a.createdAt - b.createdAt);
  return { date, today: today(), models: MODELS, locationDealers: LOCATION_DEALERS, testDriveResources: TEST_DRIVE_RESOURCES, tickets };
}

module.exports = { MAX_BODY_BYTES, MAX_PHOTO_BYTES, MAX_SIGNATURE_BYTES, LOCATION_DEALERS, TEST_DRIVE_RESOURCES, ticketMedia, customerTicket, RESERVATION_DEALERS, updateReserved, mergeDay, MODELS, ACTIVE, today, emptyState, httpError, maskPhone, publicState, position, createTicket, act, callNext, decodePhoto };
