# Calculator mobile redesign — pen-strength chips + per-pen costs

**Date:** 2026-06-14
**Scope:** `index.html` — CSS, `I18N`, `STORE.defaults()`, `UI` (`viewCost`,
`viewOpt`, `viewSettings`). No `DOMAIN` change, no CSP impact, single file.

## Problem

On mobile the Calculator/Cost forms break: `.g2`/`.g3` grids never collapse to a
single column (only `.g3` 3→2 at 520px), so fields get cramped and wrap badly.
Pen strength is a `<select>` — picking it is fiddly; a tap-to-choose row reads
better and is faster. And pen price must be re-entered every time even though it
only depends on which pen you bought.

## Goal

A clean single-column mobile layout, pen strength chosen via tappable chips, and
a "set once" per-pen cost table in Settings that the Calculator auto-uses based
on the selected strength. The Cost tab stays manual (ad-hoc checking).

## Design

### 1. Mobile layout fix (CSS)

Replace `@media(max-width:520px){.g3{grid-template-columns:1fr 1fr}}` with:

```css
@media(max-width:600px){ .g2,.g3{grid-template-columns:1fr} }
```

Every field stacks full-width on phones; desktop keeps 2/3 columns.

### 2. Pen-strength chips

New CSS, using the brand accent:

```css
.chips{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:0 0 12px}
@media(max-width:560px){.chips{grid-template-columns:repeat(3,1fr)}}
.chip{appearance:none;cursor:pointer;border:1px solid var(--line);background:var(--soft);
  border-radius:12px;padding:10px 4px;text-align:center;color:var(--ink);
  transition:border-color .15s,background .15s,box-shadow .15s}
.chip .cv{display:block;font-weight:800;font-size:16px;line-height:1.1}
.chip .cu{display:block;font-size:11px;color:var(--muted);margin-top:2px}
.chip.on{border-color:var(--brand);background:rgba(14,165,164,.10);
  box-shadow:0 0 0 1px var(--brand) inset}
```

Two reusable UI helpers:

```js
function chipRow(group, values, sel, unit){ /* <div class="chips" data-chip=group> of .chip buttons */ }
function bindChips(group, onPick){ /* click → toggle .on, call onPick(parseFloat(value)) */ }
```

`STRENGTHS = [2.5,5,7.5,10,12.5,15]`. Replace the strength `<select>` in
`viewCost` (`#cStr`) and both Calculator modes (`#oStr`) with `chipRow`. The
selected value writes to `st.calc.strengthMg` (shared, as today).

### 3. Per-pen costs in Settings

State — add to `defaults()`:

```js
settings: { …, penCosts:{ "2.5":null,"5":null,"7.5":null,"10":null,"12.5":null,"15":null } }
```

`merge()` deep-merges, so existing users migrate with all-null costs. New
Settings card "Pen costs": one row per strength (`STRENGTHS`), each a
currency-prefixed numeric input bound to `settings.penCosts[v]` (null when
blank), saved on input. Single column on mobile via `.g2`/grid.

### 4. Calculator auto-fills cost from Settings

In `viewOpt`, picking a strength chip pre-fills the cost field (`#oPrice`) from
`settings.penCosts[strength]` when that value is set (else leaves the field
as-is). The displayed/edited value is used for the calculation (writes to
`st.calc.costPerPen` on edit/Calculate, as today) but a chip pick does **not**
write back to `settings.penCosts` — Settings stays the source of truth. The Cost
tab keeps its own manual price entry, unchanged.

Update `opt.costShared` hint → "cost auto-fills from your per-pen prices in
Settings; edits here apply to this calculation only."

### 5. i18n

Add PL/EN keys: `set.penCosts` (card title), `set.penCostsHint`. Update
`opt.costShared`. Every key gets both languages.

## Verification

Screenshot Calculator, Settings, and Cost at mobile (≤375px) and desktop widths:
fields stack to one column on mobile, chips select and highlight, and picking a
strength in the Calculator pulls its cost from Settings. Bump `CACHE` in `sw.js`.
