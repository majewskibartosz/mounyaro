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

### 1. Blend runs *along the arc*, not across the screen

An SVG `linearGradient` can only interpolate along a straight screen line, so it
never follows the ring's curve and degenerates to a hard split near a full
circle. Instead, draw the progress arc as **many short arc segments**
(`N = ceil(frac · 96)`), each a `<path>` arc command with `stroke-linecap="round"`
so consecutive caps overlap and the joins disappear. The leading cap is the
moving "bowl"; green sits on the older trailing part — anchored to arc position,
independent of where on screen the cap is.

Segment endpoints, going clockwise from the top, for `t ∈ [0,1]` along the arc:

```
angle(t) = (-90 + t · frac · 360)°
pt(t)    = (100 + 85·cos angle, 100 + 85·sin angle)
```

### 2. Stretch the calm band

Each segment is colored by its position `p` (midpoint of `t0..t1`) along the
drawn arc: `p ≤ 0.55 → green`, else lerp `green → hotColor` over `(p-0.55)/0.45`.
The bulk of the arc stays green; the color shift is compressed into the last
stretch near the leading cap.

Color helpers work in RGB (`hex2rgb` / `lerpRGB` / `rgbCss`) so segments can
blend toward the dynamic `hotColor`.

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
