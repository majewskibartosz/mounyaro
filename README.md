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
- **Polish 🇵🇱 / English 🇬🇧** toggle.
- **Mobile-first & responsive.**

## The click math

Every Mounjaro KwikPen = **240 clicks** = **4 labeled doses** (60 clicks per dose).

- `mg per click = pen strength ÷ 60`
- `clicks for a dose = round(dose × 60 ÷ pen strength)`
- e.g. a 10 mg pen, 2.5 mg dose → `2.5 × 60 ÷ 10 = 15 clicks`.

## How to use it

**Locally:** just double-click `index.html` — it opens in any browser and works offline.

**Host for free (Netlify):** drag the folder onto <https://app.netlify.com/drop>. Done.

## Where is my data? (Privacy)

Your data is stored **only in your browser** on the device you use (via `localStorage`).
Nothing is ever sent to a server. Other people who open the same page see **none** of your data.

### Moving data between devices

Because data is per-device, use **Settings → Export to file** to download a backup `.json`.
Keep that file in a cloud folder that auto-syncs (e.g. **MEGA**, Dropbox), and on another
device use **Settings → Import from file** to load it.

## Disclaimer

Educational tool, **not medical advice**. Always confirm dosing with your doctor or
pharmacist. The "golden dose" is leftover priming liquid, is not medically endorsed, and its
accuracy is not guaranteed — the 2026 redesigned pen has less of it. Use at your own risk.
