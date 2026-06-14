# Travel / import savings — destination-country pen pricing

**Date:** 2026-06-14
**Scope:** `index.html` — `DOMAIN` (new pure fn), `STORE.defaults()`, `I18N`,
`UI` (new Calculator mode + searchable currency picker). Single file, no CSP
change, fully offline.

## Problem

People on a "medical holiday" / expats buy meds cheaper abroad. They want the
calculator to compare the cost of stretching a pen bought at home against buying
in the destination country, accounting for currency conversion. The catch: in
some destinations a doctor only prescribes a pen equal to your dose (you can't
buy a big pen to stretch), so two distinct comparisons are needed.

## Decisions (locked)

- **Exchange rate is entered manually** (offline, no network, no CSP change) —
  consistent with the app's 100%-offline/private guarantee. Rate means
  `1 [home currency] = rate [destination currency]`.
- Show **both** savings comparisons: 1:1 same-pen, and prescription-limited.

## Design

### 1. State (`defaults()`, deep-merged → existing users migrate)

```js
settings.travel = {
  currency:"",                        // destination currency code
  rate:null,                          // 1 home = rate destination
  penCosts:{ "2.5":null,…,"15":null } // destination prices, in destination currency
}
```

Home prices/currency reuse `settings.penCosts` + `settings.currency`.

### 2. Pure math — `DOMAIN.travelCompare(o)`

`o = { homeStrength S, dose D, intervalDays, golden, rate, homePrice (home cur),
destPriceSame (dest cur, pen S), destPriceRx (dest cur, pen = D), rxStrength,
monthDays=30.4 }`.

```
budget          = budgetClicks(golden)               // 240 (+golden)
shots(strength) = floor(budget / clicksForDose(D, strength))
toHome(p)       = rate>0 ? p/rate : null
scenario(str,priceHome) = { strength, priceHome, shotsPerPen, perShot, perMonth, coverMonths }
  perShot   = priceHome / shots(str)
  perMonth  = perShot × monthDays / intervalDays
```

Returns `home` (S, homePrice), `same` (S, toHome(destPriceSame)), `rx`
(rxStrength, toHome(destPriceRx)) — any may be `null` when an input is missing —
plus signed deltas `saveVsSame`/`saveVsRx` (and per-month variants) =
`other.perShot − home.perShot` (positive ⇒ home-sourcing is cheaper). Verified:
S=15,D=5 → 12 shots/pen (~3 mo); rx pen 5 mg → 4 shots/pen.

### 3. UI — third Calculator mode "Travel / import"

Added to `#oMode`. Fields (persisted to `settings.travel`, so "set once"):
- home strength **chips** (auto-fills home price from `settings.penCosts`),
- your dose/shot,
- destination **currency** (searchable picker) + exchange **rate** (g2),
- two destination price inputs, relabelled to the current `S` mg (same-pen) and
  `D` mg (prescribed) pens; saved to `settings.travel.penCosts[S]` / `[D]`. If
  `S === D`, show one (no stretching possible).

Result card: three cost rows (A home stretched, B destination same pen, C
destination prescribed pen) each with per-shot + per-month in **home currency**
and "1 pen covers ~N months"; then the two savings figures, green when
home-sourcing saves, red when the destination is cheaper. Note shown and case C
skipped if `D` is not a manufactured strength.

### 4. Searchable currency picker

`<datalist id="curList">` of ISO currency codes injected once into `document.body`
at init; `<input list="curList">` for the destination currency and the existing
currency fields. Native, offline, CSP-safe — no library.

### 5. i18n

New PL/EN keys: mode label, dose/shot, destination currency, rate (with the
`1 home = … dest` hint), destination price labels, the three result rows, the two
savings, and the non-standard-dose note.

## Verification

Screenshot the Travel mode at mobile + desktop; run the worked example (15 mg
home, 5 mg dose, a sample rate + prices) and confirm both savings read sensibly
and flip sign correctly when destination is cheaper/dearer. Bump `CACHE`.
