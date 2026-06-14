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

The color is a **live progress readout**: it shifts smoothly and continuously
every day — green when freshly injected, warming through amber to red at the
deadline — so you can read where you are in the cycle at a glance. No long flat
plateau where it stays green. Keep the gradient-painted-arc look (not a single
flat color).

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

### 2. Blend the full arc, green → hot

Each segment is colored by its position `p` (midpoint of `t0..t1`) along the
drawn arc, blended continuously across the **whole** arc — no flat band:

```
colorAt(p) = lerpRGB(green, hotColor, p)   // p=0 trailing (fresh) … p=1 leading cap
```

Color helpers work in RGB (`hex2rgb` / `lerpRGB` / `rgbCss`) so segments can
blend toward the dynamic `hotColor`.

### 3. Hot color tracks frac directly

The leading-cap ("hot") color is a direct, ungated readout of progress so it
shifts a little every day:

```
hotColor = urgencyColor(frac)   // 0=green, 0.5=amber, 1=red
```

Result on a 7-day interval: green-gold mid-cycle, orange with a few days left
(day 4 ≈ orange, not green), red at due. Overdue keeps `frac = 1` → full red.

The big number text color uses the same `hotColor` so number and ring agree.

## Verification

Serve over HTTP, open `#jab`, log a shot, and check the ring at several
simulated elapsed values (edit history date) at mobile + desktop widths: color
shifts smoothly green→amber→red across the cycle, visibly different each day,
red at/after due. Bump `CACHE` in `sw.js`.
