# Mounjaro Tracker 💉📉

A free, ad-free, **privacy-first** weight tracker + Mounjaro (tirzepatide) KwikPen
**clicks calculator**. Single HTML file, works fully offline, no login, no server.

> 🇵🇱 Darmowy, prywatny tracker wagi + kalkulator kliknięć Mounjaro. Jeden plik HTML,
> działa offline, bez logowania i bez serwera. Język polski i angielski.

## Features

- **Weight log + chart** — log weight over time; each point is coloured by the Mounjaro
  dose (mg) you were on, drawn with inline SVG (no libraries).
- **BMI** by WHO standards with a **fluid gauge + moving arrow** (underweight → normal →
  overweight → obese I/II/III) and your healthy weight range.
- **Cost calculator** — enter price per pen + currency → cost per labeled dose, per mg, per click.
- **Clicks calculator**:
  - **Stretch / save** — given a pen strength and a target weekly dose, see clicks/week,
    how many weeks one pen lasts, and savings vs the standard 4-dose use.
  - **Slow progression** — go from dose A to dose B on one pen; get several titration plans
    (longest/gentle, even, reach-then-maintain) with a week-by-week table.
  - **Golden dose** toggle (extra leftover clicks) — **off by default**, with a safety warning.
- **Polish 🇵🇱 / English 🇬🇧** toggle, **dark mode**.
- **Installable PWA** — add to home screen, works offline.
- **Optional linked file (auto-save)** on Chromium browsers — bind to a real `.json` file and
  auto-save every change (see below).
- **Mobile-first & responsive.**

## The click math

Every Mounjaro KwikPen = **240 clicks** = **4 labeled doses** (60 clicks per dose).

- `mg per click = pen strength ÷ 60`
- `clicks for a dose = round(dose × 60 ÷ pen strength)`
- e.g. a 10 mg pen, 2.5 mg dose → `2.5 × 60 ÷ 10 = 15 clicks`.

## How to use it

**Locally:** just double-click `index.html` — it opens in any browser and works offline. (The
PWA/offline-cache and linked-file features only activate when the app is served over `https`,
not from a local file — but the app itself is fully functional offline either way.)

### Host for free on Vercel (static, no build)

1. Push this repo to GitHub (already done if you're reading this there).
2. Go to <https://vercel.com> → **Add New… → Project** → import this repository.
3. Framework Preset: **Other** (it's plain static files — no build command, no output dir).
4. **Deploy.** You get an `https://…vercel.app` URL with global CDN + automatic HTTPS.
5. Optional: add a free custom domain under **Project → Settings → Domains**.

`vercel.json` ships strict security headers (a Content-Security-Policy that blocks any
third-party network calls — reinforcing that nothing about you leaves your device).

> Netlify works too: drag the folder onto <https://app.netlify.com/drop>.

### Install as an app (PWA)

Open the deployed `https` URL, then **Add to Home Screen** (Android/Chrome) or **Install**
(desktop Chrome/Edge). It launches fullscreen and works offline.

## Where is my data? (Privacy)

Your data is stored **only in your browser** on the device you use (via `localStorage`).
Nothing is ever sent to a server. Other people who open the same page see **none** of your data.

### Moving data between devices

**Every browser — manual backup:** use **Settings → Export to file** to download a backup `.json`.
Keep that file in a cloud folder that auto-syncs (e.g. **MEGA**, Dropbox), and on another device
use **Settings → Import from file** to load it.

**Chromium browsers (Chrome, Edge, Vivaldi, Android Chrome) — linked file (auto-save):**
In **Settings → Linked file** you can bind the app to a real `.json` file. After that, every
change auto-saves to that file. Put the file in your MEGA/Dropbox folder and it roams between
your devices; on each device, open the app and **Link existing file** (or it reconnects
automatically after a one-tap permission per session). The app keeps the **newer** copy when the
local data and the file disagree. *Not available on iPhone/Safari or Firefox — those use the
manual Export/Import above.*

## Disclaimer

Educational tool, **not medical advice**. Always confirm dosing with your doctor or
pharmacist. The "golden dose" is leftover priming liquid, is not medically endorsed, and its
accuracy is not guaranteed — the 2026 redesigned pen has less of it. Use at your own risk.
