# Opt-in automatic FX rates

**Date:** 2026-06-14
**Scope:** `index.html` (`STORE.defaults`, `I18N`, `UI`), `vercel.json` (CSP),
`sw.js` (cache bump). Builds on the Travel/import savings mode.

## Problem

The Travel mode uses a manually entered exchange rate. The user wants an
**optional** automatic mode that fetches live rates — explicitly as a
precaution that the user opts into, with a clear notice that turning it on
changes the app's posture (it will make a network call), since the app is
otherwise 100% offline and private.

## Decisions

- **Off by default. Opt-in only**, enabled from Settings.
- Enabling shows a **consent dialog** spelling out that the app will contact an
  external service and is no longer fully offline for this feature.
- A **persistent visible indicator** ("online FX mode") shows whenever it's on.
- Provider: **open.er-api.com** (`/v6/latest/{BASE}`) — free, no API key,
  CORS-enabled, HTTPS. Returns `{result:"success", rates:{…}, time_last_update_utc}`.
- The rate is informational; the user should still sanity-check it.

## Design

### 1. CSP (`vercel.json`)

Add the provider to `connect-src`: `connect-src 'self' https://open.er-api.com`.
This only *allows* the call; no request is made unless the user opts in — so
users who never enable it keep the fully-offline guarantee.

### 2. State (`defaults()`, deep-merged)

```js
settings.fxAuto = false;
settings.fx = { base:"", rates:null, fetchedAt:null, updated:"" }; // last fetch cache
```

### 3. Fetch helper (UI layer — side-effectful)

```
fetchFx(base, cb): fetch open.er-api.com/v6/latest/<base>
  → success: cb(null,{base,rates,fetchedAt,updated}); cache to settings.fx
  → failure/offline/blocked: cb(err)  // UI degrades to manual entry + error note
```

### 4. Settings — "Auto-update FX rates (online)" toggle

- Toggle bound to `settings.fxAuto`.
- On **enable**: `confirm()` with the consent text. If accepted → `fxAuto=true`,
  fetch rates for the home currency, show status. If declined → revert toggle.
- On **disable**: `fxAuto=false`.
- Status line when on: "Online FX mode — rates from open.er-api.com · last
  update {time}" + a **Refresh now** button. Error note if the last fetch failed.

### 5. Travel mode integration

- When `fxAuto` is on and home + destination currencies are known: derive
  `rate = fx.rates[dest]` (base must equal home currency; refetch if base differs
  or cache is stale/empty), write it to `settings.travel.rate`, and show the rate
  field **read-only** with an "auto · online" badge, the last-update time, and a
  refresh button. A visible online-FX note banner appears in the mode.
- If the destination currency isn't in the rates, or the fetch failed/offline:
  show a note and fall back to the manual rate input.
- When `fxAuto` is off: manual rate entry exactly as today.

### 6. i18n

PL/EN keys: toggle label + description, consent dialog body, online-mode status,
last-update label, refresh button, error/offline note, "auto · online" badge.

## Verification

- Toggle on → consent dialog appears; decline reverts the toggle.
- With it on, Travel mode shows the online badge + read-only rate (or a graceful
  error note if the network is unavailable — tested by blocking the request).
- With it off, manual rate still works. Bump `CACHE`.
