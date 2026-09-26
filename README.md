# Calorie Tracker

Log meals, see whether you are in a deficit or surplus for the day and for the
week, and fold in your Samsung Health activity burn.

Static site, no build step. `index.html` + `styles.css` + `app.js`, plus one
Netlify Function for optional cross-device sync.

## The calorie model

```
target  = 2550 kcal every day (editable in Settings)
left    = target − eaten
net     = eaten − (maintenance + activity)   (maintenance defaults to 2600)
```

The target is fixed: eat the same amount every day, whatever your activity.
Activity never changes it. The day's full net deficit, including activity, is
shown in smaller type under the calories remaining, as context rather than
a number to eat back.
The weekly figures only count days you actually logged — otherwise every
not-yet-happened day in the current week would read as a full-target deficit
and the weekly number would be meaningless by Tuesday.

## Samsung Health

**Samsung Health has no public web API.** The current Samsung Health Data SDK is
Android-native and gated behind Samsung's partner approval — there is no OAuth
endpoint a website can call, so no hosted site can pull your activity calories
live. Anything claiming otherwise is describing Fitbit, Google Fit, or Health
Connect.

The supported route is the data export:

1. Samsung Health → **Settings** → **Personal data** → **Download personal data**
2. Unzip the archive
3. In this app: **Settings → Samsung Health import**, drop in a CSV

Files that work: `com.samsung.shealth.calories_burned.details.*.csv` (best),
`com.samsung.health.step_daily_trend.*.csv`, `com.samsung.shealth.exercise.*.csv`.

The parser sniffs rather than assumes, because Samsung moves columns between
app versions. It skips the metadata line those exports start with, matches the
date and active-calorie columns by name, and deliberately refuses `rest_`,
`bmr_` and `tef_` columns — that is baseline burn, not activity, and would inflate the
activity figure by roughly 1700 kcal.

Daily-summary files take the **highest** value per day, since a phone and a
watch each write their own row and summing them double-counts. Exercise files
**sum**, since those are one row per session. Either way you get an editable
preview before anything is saved, so a wrong guess costs you nothing.

You can also just type the number into the Activity field on any day.

## Storage

Your log is written to `localStorage` immediately, so it survives refreshes,
closing the tab, and being offline. That copy lives in one browser.

**Settings → Sync across devices** adds a server copy, so the same log opens on
your phone and your laptop and survives clearing your browser data.

There are no accounts. You pick a passphrase; it is stretched on your device
with PBKDF2 (200k iterations, SHA-256) and only the derived 64-hex key is sent.
The server stores a document under that key and knows nothing else about you.

Consequences worth being clear about:

- **The passphrase cannot be reset.** Nobody holds a copy. Forget it and that
  server document is unreachable — keep an exported backup.
- The derived key *is* the credential. A weak passphrase is guessable by anyone
  who finds the endpoint, which is why 8 characters is the enforced floor and
  more is better.
- Merging is **per-day last-write-wins**. Two devices editing *different* days
  both keep their work; two devices editing *the same* day means the later
  write wins that day. Deletions use tombstones so they do not resurrect.
- A failed upload is remembered across reloads and retried when you come back
  online, so an entry logged with no signal is not silently lost.

Local-only use is fully supported — leave sync off and nothing leaves the device.

## Deploying to Netlify

The repo is deploy-ready; `netlify.toml` publishes the root and registers the
function.

1. Netlify → **Add new site → Import an existing project** → GitHub → this repo
2. Build command: **empty**. Publish directory: **`.`**
3. Deploy

Sync needs nothing further — Netlify Blobs is provisioned automatically for
functions running on Netlify. No environment variables, no add-ons, no database.

There is no rate limiting on `/api/sync`. For a personal site that is fine; if
the URL ever gets shared around, put Netlify's rate limiting in front of it.

## Local development

```bash
npm install
npx netlify dev          # serves the site and the function together
```

Opening `index.html` from the filesystem works for everything except sync —
`crypto.subtle` requires a secure context, so use `localhost` or the deployed
site for that.
