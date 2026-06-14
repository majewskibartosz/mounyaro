# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A privacy-first weight tracker + Mounjaro (tirzepatide) KwikPen clicks calculator. The **entire application is `index.html`** — HTML, CSS, and JavaScript in one file, ~1500 lines. There is no build step, no package.json, no dependencies, no framework. Plain ES5-style vanilla JS (IIFE modules, `var`, no transpilation). The other files are static assets: `sw.js`, `manifest.webmanifest`, `icon.svg`, `vercel.json`.

## Running & verifying

- **Run:** open `index.html` directly in a browser (`file://`), or serve the folder over HTTP (e.g. `python3 -m http.server`).
- **No tests, no lint, no build.** There is nothing to install or compile.
- **PWA offline cache and the "linked file" auto-save only activate over `http(s)`**, not `file://` (the service worker bootstrap checks `location.protocol`). `localStorage` works on `file://`. To exercise those features, serve over HTTP.
- **Verify visually** by screenshotting in a browser at both mobile and desktop widths — the layout is responsive with a `760px` breakpoint, and behavior differs between the two.

## Architecture

The script is split into IIFE "modules" with deliberately strict boundaries. Respect them when editing:

- **`I18N`** — PL/EN dictionary + `t(key)`. Default language is Polish (`pl`). UI strings live in the `dict` object; static markup uses `data-i="key"` attributes resolved by `applyStatic()`. Add both languages for every new key.
- **`DOMAIN`** — **pure functions only: no DOM, no storage, no I18N.** All pen/click/cost/BMI/optimizer math lives here. Core invariants: `240 clicks/pen`, `60 clicks/dose`, `4 doses/pen`; `mg per click = pen strength ÷ 60`. Keep this layer side-effect-free and testable in isolation.
- **`STORE`** — persistence. `localStorage` (key `mounjaro.v1`) is the always-on source of truth; `defaults()` defines the full state shape and `merge()` deep-merges loaded data over defaults (this is the migration mechanism — add new fields to `defaults()`). Optionally mirrors to a real `.json` file via the **File System Access API** ("linked file", Chromium only); the file handle is persisted in **IndexedDB** (`mounjaro-fs`). On reconnect the **newer** copy wins (by `updatedAt`); an explicit "open existing file" force-adopts the file.
- **`CHART`** — inline-SVG weight chart rendering (no charting library).
- **`UI`** — all DOM rendering, event binding, and the **hash-based router**. Routes: `#jab`, `#weight`, `#bmi`, `#cost`, `#optimizer`, `#settings`, mapped in `routes`. `render()` re-runs the active view function and toggles the `.on` class on `nav.tabs a`. Bootstrap at the bottom of the file: `STORE.load(); UI.init();`.

Data flow: views read/write `STORE.state` then call `STORE.save()` (which persists to localStorage and schedules a debounced file write), and re-render. There is no virtual DOM — views rebuild their section's `innerHTML` on each render.

## Hard constraints

- **Content-Security-Policy (`vercel.json`) forbids all third-party origins.** `script-src`/`style-src` are `'self' 'unsafe-inline'` and `connect-src` is `'self'`. Do **not** add external scripts, CDN links, web fonts, or any network call — it will be blocked in production and breaks the privacy guarantee that nothing leaves the device. Everything stays inline and same-origin.
- **Bump the cache on release:** when shipping changes, increment `CACHE` in `sw.js` (and update `ASSETS` if files are added) so installed clients pick up the new version.
- **Keep it a single file.** New features go into the existing module structure in `index.html`, not new JS files.

## Conventions

- Commits follow Conventional Commits with a scope, e.g. `feat(calculator): ...`, `fix(ui): ...`, `fix(store): ...`, `fix(i18n): ...`.
- ES5 idioms throughout (`var`, `function`, IIFEs). Match the surrounding style rather than introducing ES modules or `let`/`const`/arrow-heavy code.

## Workflow: auto-commit & push

Commit and push automatically as you work — no need to wait for the user to ask:

- After each **logical** change (one feature, fix, or refactor), make a commit with a Conventional Commit message and `git push`.
- One logical unit per commit — split unrelated changes into separate commits rather than batching everything.
- Commit only when the change is complete and verified, not mid-edit.
- The default branch is `main`; push there.
