# Offline Sync TEST (throwaway prototype)

A small installable web app for checking how offline storage and sync behave on an iPhone Home Screen app.
It is **not** the beekeeping app. It holds TEST records only. Plain HTML, JavaScript and a service worker; no framework, no build step, no dependencies.

| File | What it does |
|---|---|
| `index.html`, `style.css` | The one page |
| `app.js` | UI, diagnostics, update banner |
| `db.js` | IndexedDB (records, test log, settings and session) |
| `auth.js` | Supabase email and password sign-in over plain `fetch` |
| `sync.js` | Upload (upsert on `id`), download, retries, test log |
| `sw.js` | Service worker: caches the app shell; holds `VERSION` |
| `config.js` | Supabase project URL and publishable key |
| `supabase/migrations/…sql` | Tables, conflict trigger, RLS, grants. **Not run yet.** |

## How it behaves

- **States.** `Created` = made on this device, never uploaded. `Pending Sync` = already on the server, edited here since. `Synced` = the server confirmed this exact version.
- **Sync** runs when the app opens, when the browser reports it is back online, and on **Sync now**. Each request times out after 15 s and is retried up to 3 times; after that the whole sync is retried after 30 s, 60 s … up to 5 min, but only while the app is open (iOS gives web apps no background sync).
- **No duplicates.** Uploads are an upsert on `id`, and the id is made on the device, so repeating an upload changes nothing.
- **Conflicts** are decided by a database trigger: the version with the later `updated_at` wins. Every overwrite writes a row to `proto_revisions` with `old_row` = the losing version and `new_row` = the winning version. A normal edit also writes one (the old server version "loses"), so the table is a full history. `updated_at` comes from each device's clock, so keep both clocks on automatic time.
- **Session.** Kept in IndexedDB until you tap Sign out. Access tokens last about 1 hour; the app refreshes them when online. Offline with an expired token it says so and keeps working locally. If the server refuses the refresh, it says "Session expired" and offers Sign in.
- **Sign-in is optional to use the app.** "Use offline without signing in" lets you start in airplane mode (step 1 of the test script). Sign in later from Diagnostics.

## Set up (one time)

1. **Approve and apply the migration.** In the Supabase dashboard for this project, open SQL Editor, paste the whole of `supabase/migrations/20261026000000_proto_offline_test.sql`, and run it.
2. **Create the single test user.** Authentication → Users → Add user → Create new user. Use a throwaway email and password and tick "Auto Confirm User". Sign-ups are disabled on this project, so this is the only way to get a user.

## Deploy to a free static host (GitHub Pages)

Any host that serves static files over HTTPS works (Cloudflare Pages and Netlify also do). The app uses relative paths, so it can live in a subfolder.

1. Create a new **public** GitHub repository, for example `sync-test`. (Free GitHub Pages needs a public repository. Nothing in this folder is secret: the publishable key is meant to be public, and access is controlled by sign-in and RLS.)
2. Upload the contents of this folder to the repository root (Add file → Upload files). The `supabase/` folder and this README can go too; they are harmless.
3. Settings → Pages → Build and deployment → Source: "Deploy from a branch", branch `main`, folder `/ (root)`. Save.
4. After a minute the site is at `https://<your-username>.github.io/sync-test/`.

**Publishing version 2** (test step 8): change `const VERSION = '1';` in `sw.js` to `'2'`, commit. GitHub Pages can take a few minutes to update, and its files are cached for up to 10 minutes.

**Second device** (test step 6): open the same URL in a browser on your computer and sign in with the same test user.

## Test script (run on the iPhone)

1. Install to Home Screen. Airplane mode. Open the app. It loads.
2. Create 20 records offline. Fully close the app (swipe away). Reopen offline. All 20 present.
3. Read the Diagnostics (persisted, quota). Tap persist and note the result.
4. Back online, tap Sync. Records become Synced. Create 10 more records offline and DO NOT sync. Note the date. Leave the app unused and the 10 unsynced. Check they are still there after 7, 14 and 30 days.
5. Weak-signal retry: sync with poor signal; confirm no duplicates on the server.
6. Conflict: edit one record's label offline on the phone, edit the same record on a computer, sync both. Later `updated_at` wins and the other appears in `proto_revisions`.
7. After several days offline, reopen and check whether login still works; note what happens when the token has expired with no signal.
8. Publish version 2. Confirm the update banner appears, tapping it updates, and local records survive.

Notes for running it:

- Step 1: open the URL in **Safari**, Share → Add to Home Screen, and open it once online so the app is cached, then switch to airplane mode. The Home Screen app has its own storage, separate from Safari, so do everything after that inside the Home Screen app.
- Step 2: choose "Use offline without signing in" on first open. Sign in later (step 4) from Diagnostics.
- Step 4: the device check runs automatically on open and when back online. Opening the app counts as use, so for the 7, 14 and 30-day checks, open it **in airplane mode** if you want the 10 records to stay unsynced, and read "Last open before this one" in Diagnostics.
- Step 5: the Test log shows "after N retried request(s)" when a retry happened. Check the server row count in the log line ("server rows N") or in Table Editor → `proto_records`.
- Step 6: edit on the phone first, then on the computer (so the computer is later), sync the computer, then turn the phone online. The phone's log says "server kept its newer version for 1" and its label changes to the computer's. Check `proto_revisions` in Table Editor.
- Step 7: the banner at the top tells you which case you are in (token expired with no signal, or session refused by the server).
- Step 8: the update check runs when the app opens or comes back to the front. If the banner does not appear, close and reopen the app.

## Removing it afterwards

Delete the GitHub repository, delete the test user, and in SQL Editor run:
`drop table public.proto_revisions, public.proto_records; drop function public.proto_resolve_conflict();`
