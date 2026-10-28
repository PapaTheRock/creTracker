# Take Creatine – Tracker & Push Reminders

A small installable web app (PWA) that tracks creatine intake and sends a phone
notification on the days and time you choose. It runs entirely on Cloudflare's free
plan and works on iPhone and Android, even when the app is closed.

---

## 1. How it works

Phones do not run a web app's code in the background, so a timer inside the page or
service worker cannot fire a notification. Instead a server sends a Web Push:

```
Phone app ──subscribe + settings──▶ Cloudflare Worker ──saves──▶ D1 database
                                          ▲
                           cron, every minute: is a reminder due?
                                          │
                                          ▼
                     Apple / Google push service ──▶ Phone shows the notification
```

- **Static app** (`public/`): the page you use. History is stored on the phone only.
- **Worker** (`src/worker.js`): stores each phone's subscription and reminder settings,
  and sends the push when it is due.
- **D1 database**: one table, `subscriptions` (see `schema.sql`).
- **Cron trigger**: runs the Worker every minute (free plan allows this).
- **VAPID keys**: a key pair that proves to Apple/Google that pushes come from your Worker.

Reminders use the phone's own time zone. A reminder is sent once per day, within the
15 minutes after the chosen time (retries if a send fails). Changing the time, days or
time zone allows a fresh send the same day.

---

## 2. Files

| Path | Purpose |
|---|---|
| `wrangler.toml` | Cloudflare config: Worker name, assets folder, cron, D1 binding. **Contains your real `database_id`. Keep it.** |
| `schema.sql` | Creates the `subscriptions` table. |
| `generate-vapid.mjs` | Generates the VAPID key pair and prints the secret commands. |
| `src/worker.js` | Worker: API routes + cron reminder sender. |
| `public/index.html` | The app page. |
| `public/app.js` | App logic: settings, history, push subscription. |
| `public/sw.js` | Service worker: shows the notification when a push arrives. |
| `public/style.css` | Styling. |
| `public/manifest.json` | Makes the app installable (name, icons, standalone mode). |
| `public/icons/` | App icons (192, 512, maskable 512, Apple touch icon). |

### API routes (Worker)

| Route | Method | Use |
|---|---|---|
| `/api/vapid-public-key` | GET | Returns the public key the phone subscribes with. |
| `/api/subscribe` | POST | Saves or updates a phone's subscription and settings. |
| `/api/test` | POST | Sends an immediate test push to a subscribed phone. |

### Secrets (stored on Cloudflare, not in any file)

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | Public key printed by `generate-vapid.mjs`. |
| `VAPID_PRIVATE_JWK` | Private key, one line of JSON `{...}`. **Never share or commit it.** |
| `VAPID_SUBJECT` | `mailto:` plus your real email. Apple rejects placeholder values with `403 BadJwtToken`. |

---

## 3. First-time setup

You need: Node 18+, a free Cloudflare account, and a terminal open in this folder.

1. `npx wrangler login`
2. `npx wrangler d1 create creatine-db`
   Copy the `database_id` it prints into `wrangler.toml` (replace the placeholder).
3. `npx wrangler d1 execute creatine-db --remote --file=schema.sql`
4. `npx wrangler deploy`
   It prints your URL, e.g. `https://creatine-reminder.<your-name>.workers.dev`.
5. `node generate-vapid.mjs`
   Run the three `npx wrangler secret put ...` commands it prints, pasting each value
   when prompted. Use your real email for `VAPID_SUBJECT`.

   > Keep the keys from one single run of the script. Mixing keys from different runs
   > causes `401`/`403` errors.

### Install on the phone

- **iPhone (iOS 16.4 or later):** open the URL in **Safari** > Share > **Add to Home
  Screen**. Open the app **from the new icon** (notifications do not work from a
  Safari tab), tap **Enable Phone/Browser Notifications**, and tap **Allow**.
- **Android:** open the URL in **Chrome** > menu > **Install app** / **Add to Home
  screen**. Open it, tap **Enable...** and **Allow**.

A test notification should arrive immediately. Then choose the days, dose and time and
tap **Save & Activate Reminder**.

---

## 4. Everyday use

- **Change reminder days/time/dose:** change them in the app and tap
  **Save & Activate Reminder** (this sends the change to the server).
- **Log a dose:** tap **Log Intake Right Now**. History is kept on that phone only.
- **Stop reminders:** untick all days and save, or turn notifications off for the app in
  the phone's settings.

---

## 5. Updating the app

1. Edit files in `public/` or `src/worker.js`.
2. If you changed anything in `public/`, bump the number in `public/sw.js`
   (`CACHE_NAME = 'creatine-pwa-v3'` to `v4`, etc.) so phones fetch the new files.
3. Run `npx wrangler deploy`.

Secrets and the database are not touched by a deploy, so you do not redo them.

> When copying in updated files from anywhere, **never overwrite `wrangler.toml`** unless
> it contains your real `database_id`. A placeholder there makes the deploy fail with
> `binding DB of type d1 must have a valid database_id [code: 10021]`.

---

## 6. If it stops working: recovery guide

Work down this list. Stop when notifications come back.

### A. Quick fixes (try first)
1. Open the app from the Home Screen icon, tap **Enable Phone/Browser Notifications**.
   This re-subscribes the phone and sends a test push.
2. Tap **Save & Activate Reminder** to resend your settings.
3. Check the phone: Settings > Notifications > Take Creatine is **On**, and Focus / Do
   Not Disturb is not hiding it.

### B. Re-install the app on the phone
Delete the Home Screen icon, open the URL in Safari/Chrome, add it to the Home Screen
again, open it from the icon, tap Enable, set your reminder, and Save. This creates a
fresh subscription. Phones can drop a subscription (for example after an OS update,
resetting the phone, or long periods of the app not being opened).

### C. Check the Worker
- Visit `https://YOUR-URL/api/vapid-public-key`. You should see `{"key":"B..."}`.
  `{"key":null}` means the secrets are missing: redo section 7.
- Run `npx wrangler secret list`. All three secrets must be listed.
- Watch live logs: `npx wrangler tail`, then tap Enable on the phone.
- In the Cloudflare dashboard: Workers & Pages > creatine-reminder > Settings >
  Triggers. The cron `* * * * *` should be listed.

### D. Read the error the app shows after tapping Enable
| Message | Cause and fix |
|---|---|
| `push service replied 403` / `BadJwtToken` | `VAPID_SUBJECT` is missing or not a real `mailto:` address, or the keys are mismatched. Fix the secret(s), see section 7. |
| `push service replied 401` | Public and private keys do not match. Regenerate and set all three, section 7. |
| `push service replied 404 / 410` | The subscription expired. Re-install the app on the phone (B). |
| `Could not sign or send` | `VAPID_PRIVATE_JWK` is missing or pasted wrongly (must be one line of JSON). |
| `Notifications are blocked` | Turn notifications on for the app in the phone settings. |
| Orange "Add to Home Screen" message | On iPhone, open the app from the Home Screen icon, not Safari. |

### E. Deploy errors
| Error | Fix |
|---|---|
| `database_id ... [code: 10021]` | Run `npx wrangler d1 list`, put the id for `creatine-db` into `wrangler.toml`. |
| Not logged in / auth errors | Run `npx wrangler login` again. |
| Anything else | Copy the full red error text and look up the `[code: ...]`, or ask for help with it. |

---

## 7. Rebuilding from scratch

### Regenerating keys (only if lost or compromised)
1. `node generate-vapid.mjs`
2. Run `npx wrangler secret put` for **all three** names, using values from that one run.
3. Every phone must re-subscribe: re-install the app on each phone (section 6B).

Regenerating invalidates all existing subscriptions, so do it only when needed.

### New computer (or lost project folder)
1. Install Node 18+ and copy the project folder over (or rebuild the files).
2. `npx wrangler login`
3. `npx wrangler d1 list` and put the `creatine-db` id into `wrangler.toml`.
4. `npx wrangler deploy`
   The Worker, database and secrets still exist on Cloudflare, so nothing else is needed.

### Worker or database was deleted
1. Redo sections 3 steps 2 to 5 (create the database, run the schema, deploy, set the
   secrets).
2. Re-install the app on each phone (6B).

### Moving the folder on your PC
Safe at any time. Close terminals in it, move the whole folder, then run commands from
the new location. The live app does not depend on where the folder is.

---

## 8. Limits and notes

- Free plan: the Worker, D1 and a once-a-minute cron are all within free limits for a
  personal app.
- The server does not store your intake history, only subscription + reminder settings.
- The `/api/subscribe` endpoint is open (no login). That is fine for personal use, but
  anyone who knows your URL could register a phone. Keep the URL private.
- Notification text is built on the phone: it reads the dose from settings saved by the
  app, and falls back to a generic message if it can't.
- iOS requires the app to be installed to the Home Screen, and every push must show a
  visible notification (the service worker does this).
- Security: keep `VAPID_PRIVATE_JWK` out of this README, chats, emails and version control.
