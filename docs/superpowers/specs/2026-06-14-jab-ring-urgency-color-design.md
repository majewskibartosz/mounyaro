# Jab countdown ring — urgency color redesign

**Date:** 2026-06-14
**Scope:** `index.html` → `UI` module, `urgencyColor()` + `ringSVG()` (next-shot countdown ring on `#jab`).

## Problem

The countdown ring's color is mapped to *screen position* via a fixed vertical
gradient: green at 12 o'clock, amber at 3/9 o'clock, red at 6 o'clock. The arc
sweeps clockwise from the top and its fill fraction is `elapsed / intervalDays`.

Because the gradient is pinned to geometry, two things make it useless as an
urgency signal:

1. The arc reaches red at the **bottom** (≈ day 3.5 of a 7-day cycle), not near
   the deadline.
2. As the cycle completes, the leading edge sweeps past 6 o'clock and back up
   toward 12 o'clock — so the rounded cap drifts *back toward green*. At "due
   today" the cap sits on green, the opposite of urgent.

## Goal

Mostly calm (green) for the bulk of the cycle; the leading edge warms through
amber to a clear red only as the deadline approaches, and stays red when
overdue. Keep the gradient-painted-arc look (not a single flat color).

## Design

Three coordinated changes, all inside the existing `UI` IIFE. `DOMAIN`/`STORE`
untouched. No new keys, no CSP impact.

### 1. Gradient follows the arc, not the screen

Compute the gradient vector from `frac` so the **green end sits on the trailing
part of the arc** and the **hot end sits at the leading edge** (the rounded
cap). Leading-edge angle from top, clockwise: `a = 2π · frac`.

```
dir = (sin a, -cos a)           // unit vector toward leading edge from centre
x1,y1 = 100 - 85·sin a, 100 + 85·cos a   // offset 0%  (green, trailing)
x2,y2 = 100 + 85·sin a, 100 - 85·cos a   // offset 100% (hot, leading cap)
```

Drop the old `gradientTransform` rotate hack; set `x1/y1/x2/y2` directly with
`gradientUnits="userSpaceOnUse"`. The cap is always the "business end," for all
`frac`, with no re-greening.

### 2. Stretch the calm band

Gradient stops: `0% green → 55% green → 100% hotColor`. The bulk of the painted
arc stays green; the color shift is compressed into the last stretch near the
cap.

### 3. Gate the hot color by a biased curve

The leading-edge ("hot") color stays green until ~60% of the cycle, then ramps
amber→red:

```
m = frac <= 0.6 ? 0 : (frac - 0.6) / 0.4   // 0..1, clamped
hotColor = urgencyColor(m)                  // 0=green, 0.5=amber, 1=red
```

Result on a 7-day interval: green until ≈ day 4.2, amber around day 6, full red
at due. Overdue keeps `frac = 1` → full red.

The big number text color uses the **same** `m` so number and ring agree
(today it uses raw `frac`, which now disagrees with the band).

## Verification

Serve over HTTP, open `#jab`, log a shot, and check the ring at several
simulated elapsed values (edit history date) at mobile + desktop widths:
calm green early, amber mid-late, red at/after due. Bump `CACHE` in `sw.js`.
