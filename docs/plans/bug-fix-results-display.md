# Bug Fix — Results chart rendering and What If visibility (Bugs 1 & 2)

**Date:** 2026-05-07
**Status:** ✅ Approved — implementation may begin.

---

## Task description

Two bugs discovered during initial browser testing. Bug 1: the Chart.js scenario bar chart fails to render because `new Chart(ctx, ...)` is called at `app.js:2191` while `#verdict-card` still has class `hidden` (`display: none`). Chart.js's ResizeObserver measures zero canvas dimensions and does not recover when the container later transitions to `display: grid`. Bug 2: `#what-if-tiles` (carrying both `.section-tiles` and `.hidden`) is visible on page load because both classes have equal CSS specificity (0,1,0) and `.section-tiles { display: grid; }` is declared later in the stylesheet, overriding `.hidden { display: none; }`.

---

## Research findings

Research phase skipped: both are mechanical fixes with fully-diagnosed root causes from architect debug document `docs/debug/2026-05-01-bug-results-display-and-ux.md`. No libraries or external references involved.

---

## Files to modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/app.js` | Move verdict card reveal before chart initialisation |
| MODIFY | `css/styles.css` | Add `!important` to `.hidden` rule |

---

## Implementation steps

### Step 1 — Bug 1: reveal verdict card before chart init (`app.js`)

Current sequence around lines 2173–2221:
```
// Step 16g
if (verdictChart) verdictChart.destroy();   ← line 2174
...
verdictChart = new Chart(ctx, { ... });     ← line 2191  [canvas hidden here — wrong]
...
verdictCard.classList.remove('hidden');     ← line 2221  [too late]
```

Change:
1. Insert `verdictCard.classList.remove('hidden');` immediately before line 2174 (`verdictChart.destroy()`).
2. Remove the existing `verdictCard.classList.remove('hidden')` at line 2221 and its "Step 16h" comment.
3. Update the Step 16g comment to: `// Step 16g — reveal verdict card before chart init so Chart.js can measure the canvas`

No changes to chart data, colours, options, or any other logic.

Confirmed by grep: only one `new Chart` call exists in `app.js` (line 2191). No other hidden-container initialisations to fix.

### Step 2 — Bug 2: fix `.hidden` specificity (`styles.css`)

Current at line 502:
```css
.hidden { display: none; }
```

Change to:
```css
.hidden { display: none !important; }
```

`!important` on a utility visibility class is established practice: it is intended to be unconditional regardless of declaration order or other `display` rules. Safe because all reveal operations in `app.js` remove `.hidden` from the element — no code relies on leaving `.hidden` in place on a visible element.

Audit confirms: the only element in `index.html` carrying both `.hidden` and a `display`-setting class is `#what-if-tiles` (`section-tiles hidden`), which is the exact bug being fixed. All other `hidden` elements carry classes where `.hidden` winning is correct.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `!important` blocks a legitimate future override | Only a risk if code intentionally leaves `.hidden` on a visible element — not the pattern used here. All reveals remove `.hidden`. |
| Moving card reveal earlier causes a visual flash | `#verdict-card` starts `hidden` in HTML; reveal only happens inside `buildAndDisplayVerdict`, never on page load. |
| A second `new Chart` call exists in a hidden container | Confirmed by grep: only one occurrence in `app.js` (line 2191). No further instances. |

---

## Success criteria

**Bug 1:**
- [ ] Chart.js bar chart renders in the verdict card after a full pipeline run
- [ ] Chart renders at correct width (~520px per m10b tile layout)
- [ ] No console errors related to ResizeObserver or canvas sizing

**Bug 2:**
- [ ] `#what-if-tiles` not visible on page load before data is entered
- [ ] `#what-if-tiles` becomes visible after M8 pricing completes (`.hidden` removed by JS)
- [ ] `#section-banner-what-if` remains correctly hidden on page load (regression check)
- [ ] No other previously-hidden element inadvertently revealed

**Both:**
- [ ] No new console errors
- [ ] All automated test suites remain green (no JS logic changed)

---

## Approval

**Status:** ✅ Approved — 2026-05-07
**Approved by:** Rhiannon

---

## Implementation Deviations

**Date:** 2026-05-07
**Commit:** (see git log)

None.
