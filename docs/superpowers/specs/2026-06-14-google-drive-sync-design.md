# Google Drive Sync — Design Spec

**Date:** 2026-06-14
**Status:** Approved (pending spec review)
**Component:** `index.html` — `STORE`, new `GDRIVE` module, `UI` settings card; `vercel.json` CSP

## Problem

The existing "linked file" auto-save uses the **File System Access API**, which is
desktop-Chromium only. On phones (iOS Safari, Android Chrome) it is unsupported, so a
phone's edits never reach the MEGA/Dropbox-synced JSON and never appear on the desktop.
There is no working cross-device sync for mobile users today; only manual Export/Import.

## Goal

Add an **opt-in** Google Drive sync that works on every browser (it's just HTTPS),
stores data in the user's own Drive, requires **no application server**, and preserves
the app's offline-first, no-login-by-default, privacy-first identity.

Non-goals: real-time collaboration, multi-user sharing, replacing localStorage as the
source of truth, replacing the existing linked-file feature.

## Key decisions (locked)

1. **Storage location:** Drive's hidden `appDataFolder` via the `drive.appdata` scope.
   The app is technically incapable of reading any other Drive file. Strongest
   least-privilege guarantee; lightest verification path. Trade-off: the file is
   invisible in the user's normal Drive UI (Export remains the manual backup path).
2. **Relationship to linked-file:** Coexist, **mutually exclusive** — only one remote
   sync (`file` OR `drive`) active at a time, so two writers never fight.
3. **Conflict resolution:** **Newest wins + safety backup.** The copy with the newer
   `updatedAt` is kept; before overwriting, the losing copy is written as a timestamped
   backup in the appData folder (last 3 retained) so nothing is ever truly lost.
4. **Integration approach:** Google Identity Services (GIS) token client + Drive REST
   via `fetch`, no backend, no client secret, access token in memory only.

## Architecture

Three bounded units with clear responsibilities:

### `GDRIVE` (new IIFE module) — Google auth + Drive file I/O only

Knows Google; knows nothing about the app's data model.

- `signIn(cb)` — GIS `requestAccessToken()` (consent on first use).
- `restoreSilent(cb)` — `requestAccessToken({prompt:''})`; silent if consent still valid.
- `signOut(cb)` — revoke token, clear in-memory state.
- `isSignedIn()`, `account()` — connected email (requires `openid email` scopes).
- `readData(cb)` → `{text, modifiedTime}` of the appData file, or `null` if none yet.
- `writeData(text, cb)` — create/update the single appData JSON file.
- `backupData(text, cb)` — write `mounjaro-backup-<ISO>.json` to appData; prune to last 3.

Token (~1 hr) lives only in a JS variable. On any 401, do one silent refresh + retry;
if that fails, report a "reconnect" status. All failures (offline, 401, revoked) are
surfaced via callback status so STORE/UI can react.

### `STORE` — active-remote coordinator (minimal change)

- New state field: `settings.sync = { provider: "none" | "file" | "drive" }`.
- `save()` routes the debounced (~800 ms) remote write to the active provider.
- Load + tab `visibilitychange`/`focus` trigger a pull check on the active provider
  (reuses the `refreshFromHandle` pattern already added for linked-file).
- Existing linked-file logic becomes the `"file"` branch, largely unchanged.
- Enforces mutual exclusivity: enabling one remote disables the other.

### `decideSync(localUpdatedAt, remoteUpdatedAt, remoteChangedSinceLastSync, localDirty)` — pure

Returns `"push" | "pull" | "noop" | "conflict"`. Network-free and DOM-free so the
newest-wins-+-backup logic is unit-testable in isolation. This is the riskiest logic.

### `UI` — Settings "Sync with Google Drive" card

Renders STORE/GDRIVE status; knows neither Google nor sync internals.

## Data flow

Offline-first: `localStorage` is always the source of truth. If offline, signed out, or
a token fails, the app works normally and sync resumes when possible.

**Auth lifecycle:**
- Sign in → GIS consent → token in memory; persist `provider = "drive"`.
- On load, if `provider === "drive"` → `restoreSilent()`; on failure show "Reconnect".
- 401 → one silent refresh + retry → else "Reconnect".
- Sign out → revoke token, clear `provider`, leave localStorage untouched.

**Sync triggers:** debounced push after each `save()`; pull check on load and on
`visibilitychange`/`focus`.

**Sync decision:**
1. Pull check: `readData()` returns the file `modifiedTime` and its JSON `updatedAt`.
2. Track `lastSyncedModifiedTime`; a changed `modifiedTime` means the remote changed
   externally (another device).
3. Compare the `updatedAt` inside each copy:
   - Remote newer, local not dirty → **pull**.
   - Local newer, remote unchanged externally → **push**.
   - Both changed → **newest `updatedAt` wins**; first `backupData()` the losing copy.
   - Equal / no change → **noop**.

**Caveats (documented):**
- `updatedAt` is the writing device's wall clock; a badly-skewed clock can mis-order
  newest-wins. The safety backup is exactly what covers this rare case.
- First sign-in on a device that already has local data is treated as a normal
  conflict (newest wins, loser backed up) — neither side is silently dropped.

## UI states (Settings card)

- **Signed out:** explanation + privacy note ("data stored in a hidden folder in *your*
  Google Drive; this app has no server and stores nothing") + "Sign in with Google".
- **Connected:** account email, "Last synced HH:MM", "Sync now", "Sign out".
- **Reconnect needed:** "Reconnect" button (reuses the existing banner pattern).
- **Syncing / error:** inline status — "Syncing…", "Offline — will sync later",
  "Sync failed".
- **Mutual exclusivity:** if linked-file is active, the Drive card shows "Unlink the
  local file first" (disabled); and vice versa.

All strings added to the PL/EN dictionary under `set.drive.*`, following the existing
`data-i` pattern.

## CSP changes (`vercel.json`)

The one deliberate loosening of the security posture, scoped tightly to Google origins:

- `script-src`: add `https://accounts.google.com/gsi/client`
- `connect-src`: add `https://www.googleapis.com https://oauth2.googleapis.com https://accounts.google.com`
- `frame-src`: add `https://accounts.google.com` (GIS uses an iframe)

No service-worker change: its fetch handler already ignores cross-origin requests, so
Google traffic passes through untouched. The pure-offline guarantee still holds for
anyone who never signs in.

## Google Cloud setup (owner-provided; documented in README)

- Create a GCP project; configure the OAuth consent screen (External); add scopes
  `drive.appdata`, `openid`, `email`.
- Create an OAuth 2.0 **Web** client ID; add deployment origins to *Authorized
  JavaScript origins*: `https://<app>.vercel.app`, any custom domain, and
  `http://localhost:8000` for local testing.
- The public client ID goes in a `GOOGLE_CLIENT_ID` constant at the top of the script
  (committed — it is a public client, safe to expose).
- Unverified: up to 100 test users + an "unverified app" warning. `drive.appdata` is a
  **sensitive** (not **restricted**) scope → production verification needs Google's
  brand/consent-screen review but **no CASA security assessment**.

## Testing

- Pure `decideSync()` exercised across the full matrix (push/pull/noop/conflict, and
  who gets backed up) — network-free.
- OAuth + Drive I/O cannot run over `file://` (origins must be registered), so
  end-to-end verification is manual on a registered origin (`localhost:8000` or the
  deployed URL): sign in; edit on device A and confirm device B pulls; force a conflict
  and confirm the loser is backed up; test offline → online; test token-expiry →
  reconnect.

## Out of scope / future

- Provider abstraction interface (only justified beyond two providers).
- Real-time/multi-user, sharing, selective field merge.
- Showing/restoring backup files from within the UI (Export covers recovery for now).
