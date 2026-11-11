# iCAUR Test Drive Queue

Walk-in test drive queueing for the showroom. Runs two ways from the same code:

- **Netlify (public URL)** — static pages + a Netlify Function, queue stored in Netlify Blobs.
- **Local (showroom PC)** — `node server.js`, queue stored in `data/queue.json`. No install needed.

| Screen | Path | Who uses it |
|---|---|---|
| Kiosk / customer ticket | `/` | Customers pick V27 or V23, enter name + mobile, get a number (e.g. `V27-001` or `V23-001`); page updates itself, ticket is printable |
| Staff console | `/staff` | Call next, start drive, finish, no-show, re-queue, remove (PIN protected) |
| Units reserved | `/reserved` | Event-wide sales total for TV/LED walls, gold pulse and opt-in chime |
| Lobby display | `/display` | TV screen: now calling, up next, chime on each call; light/dark toggle |

## Existing reservations

Registration requires Yes/No for an existing iCAUR reservation. Yes requires a dealer from the server's fixed list; No stores a null dealer. This is separate from the inviting dealer and guest list. Staff tickets, Excel registration columns and the daily summary include the answers; the public queue state omits them. Older tickets have blank reservation information.

## Units reserved

Staff use the Units reserved panel for +1, -1, or a confirmed Set total (0&#8211;99999). This is one event-wide total, independent of models, daily rollover and queue resets. Open `/reserved` on the TV/LED wall and click **Enable sound** once: increases glow gold and chime; first load and decreases stay quiet. It polls every 3 seconds and defaults to a night theme.

`GET /api/reserved` is public and returns `{count, updatedAt}` (initially `{count: 0, updatedAt: null}`). `POST /api/staff/reserved` requires `x-staff-pin` and exactly one of `{delta: 1}`, `{delta: -1}`, or `{set: integer}`. Invalid input returns 400; invalid PIN returns 401. Results clamp to 0&#8211;99999. Storage is `data/reserved.json` locally or key `units-reserved` in the Netlify `queue` store. Netlify follows the existing strong-consistency read-modify-write pattern; simultaneous operators can overwrite an update.

## Deploy to Netlify

One-time:

```bash
npm install
```

```bash
npx netlify login
```

```bash
npx netlify init
```
(choose **Create & configure a new site**; accept the defaults — `netlify.toml` already has the build settings)

Then, every deploy:

```bash
npm run deploy
```

After the first deploy, set the staff PIN in the Netlify dashboard: **Site configuration → Environment variables → Add** `STAFF_PIN` (default is `1234` if unset), then redeploy.

Optional env vars: `QUEUE_TZ` (default `Asia/Manila`, controls when the daily numbering resets).

### SMS alerts

Customers get a text when they register, when they become first in line, and when staff call their number. **SMSGate (SMS Gateway for Android, Cloud Server mode) is the recommended free option**; messages use your phone's SIM and carrier SMS allowance. Set credentials in Netlify's environment variables (then redeploy), or in the environment before starting the local server.

| Provider | Variables | Notes |
|---|---|---|
| SMSGate (recommended) | `SMSGATE_USERNAME`, `SMSGATE_PASSWORD` | Android phone with internet and an SMS-capable SIM |
| Traccar SMS Gateway (Android phone, Cloud mode) | `TRACCAR_KEY` | Free; uses the phone's SIM. Enable *Cloud service* in the app and copy its key |
| Semaphore (PH) | `SEMAPHORE_KEY`, optional `SEMAPHORE_SENDER` | ~₱0.50/SMS, needs account approval |

| SMSGate variable | Default | Purpose |
|---|---|---|
| `SMSGATE_USERNAME` | none | Required cloud username from the Android app |
| `SMSGATE_PASSWORD` | none | Required cloud password; store as a secret, never in source files |
| `SMSGATE_SIM` | omitted | Optional 1-based SIM slot: `1`, `2`, or `3`; other values are ignored |
| `SMSGATE_URL` | `https://api.sms-gate.app/3rdparty/v1/messages` | Optional full messages endpoint override |
| `SMS_PROVIDER` | auto | Force `smsgate`, `traccar`, or `semaphore`; `none` disables all SMS |

Auto selection prefers SMSGate when both credentials exist, then Traccar, then Semaphore. Without credentials, sends are skipped and the app keeps working. A forced provider with missing credentials also skips; it does not fall back.

One-time phone setup ([official cloud guide](https://docs.sms-gate.app/getting-started/public-cloud-server/)):

1. Install [SMS Gateway for Android](https://sms-gate.app/) on the phone with your SMS SIM and grant the requested SMS permissions.
2. Enable **Cloud Server**, tap **Start Service**, and confirm **Sign Up** if the phone is not registered. Copy the generated Cloud Server username and password into the environment variables above.
3. Keep the service running and the phone powered and online. Set `SMSGATE_SIM` if needed, then register a test ticket to check delivery.

Requests time out after six seconds. A 2xx response (usually 202) means queued, not confirmed delivered. Logs contain only masked recipients (e.g. `+63***67`) and status; no message text, response bodies, or credentials.

| Log / symptom | Check |
|---|---|
| `[sms:skipped]` | Both SMSGate credentials must be present; check forced provider and `SMS_PROVIDER=none` |
| `FAILED 401` | Recheck the app's cloud username/password and restart/redeploy after env changes |
| Other `FAILED <status>` | Check endpoint configuration and provider service status |
| `ERROR timeout` / `ERROR request failed` | Check server connectivity and endpoint; timeout is six seconds |
| `sent (queued)`, but no text | Check the phone's running service, internet, SMS permission, SIM slot, signal and SMS balance |

### Driver's license scan

On the form, customers photograph their license; the photo is sent to the GDS AI Gateway (vision model) which returns the name, license number and expiry, and the form is filled in for them to confirm. Expired licenses are rejected at registration and flagged on the staff console.

The photo (downsized JPEG, ~200–400 KB) is kept with the registration: on Netlify in the `licenses` blob store keyed by ticket id, locally under `data/licenses/`. Only the staff console can open it (**View license** next to the customer, PIN-protected); it never appears in the public queue data. The waiver text tells customers the photo is kept. There is no automatic deletion — clear old photos from the Netlify Blobs UI (Site → Blobs → `licenses`) or the local folder as your retention policy requires.

Env vars: `GDS_API_KEY` (required — the `gds_live_…` virtual key), optional `GDS_BASE_URL` (default `https://ai-gateway.heineraboka.site/v1`) and `LICENSE_MODEL` (default `gpt-6.1-sol`). Without a key the scan button reports that scanning isn't set up and customers can type the details manually.

### Dealer guest list

Staff upload who each dealer invited from the staff console (**Upload list**, `.csv` or `.xlsx`; **Download template** gives the columns: Name, Mobile, E-mail, Dealer). Uploads add to the list, and a repeated mobile number or e-mail replaces its entry. The list is kept across days until cleared.

When a customer registers with a mobile number or e-mail on the list, the form fills in and locks "Invited by dealer" and the dealer name, and the server applies the same match when the ticket is created. Names are not matched. `/api/guest-lookup` is public so the form can react as they type, and returns the dealer name only.

### QR poster

`/qr` renders a printable "Scan to join the queue" poster whose code points at the site's own registration page. Print it or download the PNG from that page. It's also linked from the staff console.

### Test the Netlify version locally

```bash
npm run dev
```
Opens on `http://localhost:8888` with a local copy of the Blobs store.

## Run locally without Netlify

```bash
node server.js
```
Serves on port 3000. `PORT` and `STAFF_PIN` can be set as env vars, e.g. `$env:STAFF_PIN="9876"; node server.js`.

## Changing models / wait times

The `MODELS` list at the top of `lib/queue.js` holds the models, demo-car count (`units`) and average drive length (`minutes`). Est. wait = people waiting ÷ units × minutes. The iCAUR V27 (Golden REEV SUV) and iCAUR V23 (Boxy Lifestyle EV) each have one demo unit and a 20-minute average drive. Tickets use model prefixes (`V27-001` / `V23-001`). Car images are in `public/img/`.

## Data

Numbering restarts each day (showroom time). On Netlify each day is a separate key in the `queue` blob store; locally each past day is kept as `data/queue-YYYY-MM-DD.json`. Live updates are by polling every 3 s (`POLL_MS` in `public/common.js`).

## Official iCAUR Philippines image sources

The registration hero uses the supplied official event key visual, `public/img/autofocus-hero.webp`, with 960px and 1440px responsive WebP variants.

- `public/img/logo_light.svg`: https://www.icaurglobal.com/ph/images/common/logo_light.svg (original wordmark, 118 x 21).
- `public/img/v23.webp`: https://www.icaurglobal.com/ph/images/v23/car1.webp (transparent side profile, resized to 1000 x 495, then transparent outer padding trimmed to 934 x 488).
- `public/img/v27.webp`: https://www.icaurglobal.com/ph/images/v27reev/bgDesertBronze.webp (official desert side-profile photograph; background removed with rembg `isnet-general-use`, cropped to the car and resized to 1000 x 392, transparent WebP).

Both car images are then re-framed onto the same 1000 x 420 transparent canvas: car body scaled to 360 px tall, centred, wheels on the same ground line (y = 400), so the two models render at the same size everywhere. The V27 also gets a ground-shadow band (y 382–400, fading out behind the car) drawn to mirror the shadow in the official V23 render.

Before go-live, confirm the iCAUR legal entity and the existing event name with Heiner; see the TODO above the kiosk waiver.

## Voice announcements

On `/display`, click **Enable call sound** after each page load. Calls and recalls chime, then speak twice; **Test announcement** uses the browser voice with sample `V27-001`. Without provider credentials the browser voice works automatically (preferring en-PH). The display only receives the first name; AI speech uses the sanitized full name stored on the server.

First call: "Queue Number V twenty-seven, zero zero one, Juan Dela Cruz. Please proceed to the iCAUR Booth for your test drive." Recall: "Now serving Queue Number V twenty-seven, zero zero one, Juan Dela Cruz. Please proceed to the iCAUR Booth. Thank you!" Server and browser sentences are identical. OpenAI instructions pronounce iCAUR as "eye-CAR"; browser pronunciation depends on the installed voice.

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | none | Optional secret enabling OpenAI voice. |
| `TTS_PROVIDER` | auto | `openai` or `elevenlabs`; auto prefers OpenAI when its key exists, then ElevenLabs. |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | Speech model; instructions are sent only for `gpt-*`. |
| `OPENAI_TTS_VOICE` | `alloy` | OpenAI voice. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Optional compatible gateway. |
| `ELEVENLABS_API_KEY` | none | Alternative provider secret. |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` | Alternative voice. |
| `ELEVENLABS_MODEL` | `eleven_flash_v2_5` | Alternative speech model. |

For AI voice, add `OPENAI_API_KEY` in Netlify Project configuration > Environment variables, mark it as containing secret values, then redeploy so functions receive it. Never put credentials in files. ElevenLabs may require a paid plan on cloud hosts. No credentials are needed for local browser speech.

`GET /api/announce?number=V27-001` accepts only a called ticket in today's queue and builds speech from that ticket; request text is ignored. Responses are MP3 (200), invalid number (400), called ticket not found (404), or `Voice not configured` / `Voice unavailable` (503). Providers time out after 8 seconds. Logs retain only safe status descriptions and whitelisted codes. MP3s are cached by provider/date/number/calledAt in Netlify Blobs `announcements`, or a 50-entry local LRU; concurrent requests share generation, recalls get a new cache key, and failures are retried. A failed cache read/write still permits generated audio.

The display queues up to five pending calls, holds them while hidden, waits 0.9 seconds after the chime, and repeats speech with a 1-second gap. Fetches time out after 10 seconds and playback watchdogs keep the queue moving. Missing configuration skips further AI attempts for five minutes. Click the sound button again after reloading; ensure the tab is unmuted.

Run `npm test` for built-in Node tests with mocked provider requests; no additional dependencies are needed.
