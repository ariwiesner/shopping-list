# הסל שלי — Shopping List

A mobile-first, Hebrew (RTL) shopping list. Lists are shared live between people
(Google sign-in + Firebase). Planned: calculate the total cost of the shopping.

## Files

| File | What it does |
|------|--------------|
| `index.html`, `styles.css` | Screens: login, list, sheets |
| `app.js` | UI logic; works with a local (on-device) or cloud backend |
| `catalog.js` | Store catalogs: loading, product search, item prices |
| `import-parse.js` | Import a pasted list (WhatsApp, notes): one item per line or comma, quantities, chatter removed |
| `photo-config.js` | Address of the photo-reading worker (`null` = not set up) |
| `worker/` | Cloudflare Worker that reads photos of lists, and chatty pasted messages, with Google Gemini (free tier) |
| `compare-worker.js` | "Where is it cheapest?": prices the list in every chain and the nearest branches, in the background |
| `scripts/build_catalog.py` | Daily price build (GitHub Action), incl. branch locations from OpenStreetMap |
| `cloud.js` | Firebase: Google sign-in, Firestore lists, live updates, invites |
| `firebase-config.js` | Your Firebase web config (`null` = local mode, no sign-in) |
| `firestore.rules` | Who can read/edit what (members only) |
| `firebase.json` | Firebase Hosting + rules deploy config |

## Run locally

The app uses ES modules, so it must be served over http (opening `index.html` directly won't work):

```
npx serve .
```

Google sign-in works on `localhost`, but **not** on a LAN address like `10.x.x.x` —
to test on a phone, deploy to Firebase Hosting.

## Firebase setup (one time)

1. Go to https://console.firebase.google.com → **Add project** (Google Analytics: optional).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable** (pick a support email) → Save.
3. **Build → Firestore Database → Create database** → choose a location (e.g. `eur3`) → **Start in production mode**.
4. **Project settings (⚙️) → Your apps → Web (`</>`)** → register the app → copy the `firebaseConfig` object
   into `firebase-config.js`.
5. Install the CLI and deploy rules + site:
   ```
   npm install -g firebase-tools
   firebase login
   firebase use --add          # pick your project
   firebase deploy
   ```
   The app is then live at `https://<project-id>.web.app`.

## How sharing works

- Signing in is optional. Without it, the list is saved on the phone only.
- Sign in with Google from **Share** or the ⋮ menu. The list already on the phone moves to the cloud.
- Opening an invite link asks you to sign in (needed to join), with a "continue without signing in" option.
- **Share** → WhatsApp / email / copy link. The link contains a secret invite code; whoever opens it signs in and joins.
- Members see each other's changes live (changed items glow and show who changed them).
- The owner can remove members or reset the invite link; members can leave.

## Photo import (reading handwritten lists)

Photos are read by a Cloudflare Worker (`worker/`) using Google Gemini's free tier.
The Gemini key stays in the worker, never in the app. One-time setup:

1. Get a free Gemini API key at https://aistudio.google.com/apikey (no card needed).
2. Create a free Cloudflare account at https://dash.cloudflare.com.
3. In the `worker` folder:
   ```
   npx wrangler login
   npx wrangler secret put GEMINI_API_KEY     # paste the key when asked
   npx wrangler deploy                        # prints the worker's https://...workers.dev address
   ```
4. Put that address in `photo-config.js` (`PHOTO_URL`) and deploy the app.

Free-tier limits apply per day; when they run out the app says so and pasting text still works.
On Gemini's free tier, Google may use the photos sent to improve its products.
