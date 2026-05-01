# Bug: Results graph not rendering; What If tiles premature; manual-entry flag missing; results incorrect

**Date:** 2026-05-01
**Reporter:** Rhiannon
**Status:** Bugs 1–3 root cause confirmed, fixes scoped. Bug 4 blocked pending Bug 1 fix.

---

## Symptoms

### Bug 1 — Results graph not rendering
The results section appears after calculation but the chart/graph is not displayed.
Expected: Chart.js horizontal bar chart renders inside the verdict card showing
the six-scenario cost comparison.

### Bug 2 — "What If" section visible on page load
Both `#section-banner-what-if` and `#what-if-tiles` are visible when the page first
opens, before any data has been entered or results calculated.
Expected: both elements hidden until M8 (pricing engine) completes.

### Bug 3 — No visible flag for manual-entry fields required
Rhiannon's house requires certain manual inputs to calculate correctly (e.g.
`t_at_restart`, `tau_bucket`, or wall construction type). A warning appears in
the methodology section but not on the main UI surface, so there is no indication
that input is needed until the user expands "Show methodology."

### Bug 4 — Results do not make sense (BLOCKED — awaiting user detail)
The numerical results are incorrect in some way. Detail cannot be provided until
Bug 1 (graph rendering) is resolved so Rhiannon can see the outputs clearly.
Investigation of this bug is deferred until Bug 1 is fixed.

---

## Environment

- App type: single-page client-side HTML/JS, no server
- Charting library: Chart.js 4.x (CDN, loaded with `defer`)
- `app.js` loaded as `type="module"` (always deferred, runs after Chart.js)
- Hosting: GitHub Pages (rmulherin/heatpump-analyser)
- Platform: Windows 11, local browser

---

## Bug 1 — Results graph not rendering

### Root cause

`new Chart(ctx, ...)` is called at **app.js:2191** while the `#verdict-card` element
still has class `hidden` (i.e. `display: none`). The card is only revealed at
**app.js:2221**, ten lines later.

Chart.js 4 uses ResizeObserver internally. When the parent container has `display: none`
at chart initialisation time, the canvas has zero width and zero height. Chart.js may
fail to render — the ResizeObserver does not reliably fire when a `display: none`
parent transitions to visible, particularly when the parent transitions to
`display: grid` (the `.section-tiles` class) rather than `display: block`.

The `.verdict-chart-wrap` div has an explicit `height: 260px` in CSS (styles.css:616),
which is correct and sufficient — but only when the container is visible.

### Evidence

- **app.js:2174** — `verdictChart.destroy()` if it exists (correct)
- **app.js:2191** — `new Chart(ctx, ...)` — chart created while card is hidden
- **app.js:2221** — `verdictCard.classList.remove('hidden')` — card revealed after
- **styles.css:615–618** — `.verdict-chart-wrap { height: 260px; }` — height set
- **index.html:177** — `<section class="card verdict-card hidden" id="verdict-card">` — hidden at load

### Proposed fix

Category A — application logic error.

Move `verdictCard.classList.remove('hidden')` from line 2221 to **before** the
`destroy()` / `new Chart()` sequence (before line 2174). The card must be visible
before Chart.js measures the canvas.

**Exact change in app.js — `buildAndDisplayVerdict` function:**

```diff
-  // Step 16g — scenario bar chart
-  if (verdictChart) verdictChart.destroy();
+  // Step 16g — reveal verdict card first so Chart.js can measure the canvas
+  verdictCard.classList.remove('hidden');
+
+  if (verdictChart) verdictChart.destroy();

  ...chart creation code (lines 2176–2218)...

-  // Step 16h — reveal verdict card
-  verdictCard.classList.remove('hidden');
+  // (verdict card revealed above, before chart init)
```

No other changes needed.

**Check for same pattern elsewhere:** Grep for `new Chart` in app.js — confirm no other
Chart.js initialisation occurs while its parent container is hidden.

---

## Bug 2 — "What If" tiles visible on page load

### Root cause

CSS specificity conflict between `.hidden` and `.section-tiles`.

- `styles.css:502` — `.hidden { display: none; }` (specificity 0,1,0)
- `styles.css:519` — `.section-tiles { display: grid; ... }` (specificity 0,1,0)

Both are single-class selectors with identical specificity. CSS last-wins rule means
`.section-tiles` overrides `.hidden` for any element that carries both classes.
`#what-if-tiles` has `class="section-tiles hidden"` (index.html:413), so it renders as
`display: grid` on page load despite the `hidden` class.

Same conflict affects `#section-banner-what-if` — it has `class="section-banner hidden"`.
The `.section-banner` rule appears at styles.css:504, also after `.hidden`, but it only
sets `margin`, not `display`, so the banner IS correctly hidden. **Only `#what-if-tiles`
is broken** — it is the only element with both `section-tiles` and `hidden`.

### Evidence

- **styles.css:502** — `.hidden { display: none; }`
- **styles.css:519** — `.section-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); ... }`
- **index.html:413** — `<div class="section-tiles hidden" id="what-if-tiles">`
- **app.js:237–238** — references confirmed
- **app.js:1770–1771** — correctly removes hidden after M8 completes (display intent is right; only CSS priority is wrong)

### Proposed fix

Category A — CSS rule ordering bug.

**Option A (preferred — surgical):** Add `!important` to `.hidden` in styles.css:
```css
/* styles.css:502 */
.hidden { display: none !important; }
```
This makes `.hidden` unconditionally win over any competing `display` rule regardless
of declaration order.

**Option B:** Reorder styles.css so `.hidden` is declared after `.section-tiles` (move
it to the end of the file). This fixes the immediate conflict but is fragile — any
future display-setting class added after `.hidden` would reintroduce the bug.

Option A is recommended. `!important` on `.hidden` is a well-established pattern
precisely for this reason — utility visibility classes are intended to be unconditional.

**Check for same pattern elsewhere:** Grep styles.css for other `display:` rules
declared after line 502 that might affect other `hidden`-bearing elements. Candidates
to check: `.params-grid`, `.wi-output`, `.preset-group` if any of them can carry
`hidden`.

---

## Bug 3 — Manual entry flag not visible on main surface

### Root cause

All analysis-phase validation warnings for M4 (heat loss) and M5 (thermal character)
are rendered into `#heat-loss-status` and `#thermal-char-status` divs. Both of these
are children of `#heat-loss-card` and `#thermal-char-card` respectively, which are
inside the `<details class="methodology-disclosure hidden" id="methodology-disclosure">`
element (index.html:234). The `<details>` element is collapsed by default, so none of
these warnings are visible until the user manually expands "Show methodology."

When M5 returns `validation_status === 'insufficient_data'` (i.e. the cold-soak
estimation failed because the boiler ran continuously overnight) or M4 similarly, the
calculation proceeds but with degraded inputs. No notice is pushed to the main-surface
`#status-area` / `#status-details` at the top of the page (app.js:1129–1132 for M4;
similar pattern in M5 handlers). The guidance about entering `t_at_restart` or
`tau_bucket` is only in `#thermal-char-card` inside the collapsed disclosure.

### Evidence

- **app.js:1129–1132** — M4 `insufficient_data` handler: reveals `heatLossResults` and returns. No call to `showStatusFn` or any main-surface notice.
- **index.html:234** — `<details class="methodology-disclosure hidden" id="methodology-disclosure">` wraps both M4 and M5 cards
- **index.html:239** — `#heat-loss-card` inside disclosure
- **index.html:273** — `#thermal-char-card` inside disclosure

### Proposed fix

Category A — missing UI surfacing.

When M5 (or M4) finishes with a `validation_status` that implies the result is degraded
and user input would improve it, surface a notice on the main UI — not only inside the
methodology disclosure.

**Recommended approach:** In `displayThermalCharResults` (and the equivalent for M4),
after detecting `validation_status === 'insufficient_data'` or the path where
`thermal_mass_source === 'tau_bucket_fallback'` or `'no_data'`, also call the main
`showStatusFn` (or directly push a notice into `#status-area`) with a brief message,
e.g.:

> "Your thermal mass estimate used a fallback — entering 'time away in winter' or
> 'how quickly your home cools' in Show methodology will improve accuracy."

The same notice should also open `#methodology-disclosure` (remove its `hidden` class
and set its `open` attribute) so the user can see where to enter the value.

**Specific locations to change:**

1. `displayThermalCharResults` in app.js (around line 1260–1370) — after checking
   the thermal mass source or validation status, push a notice to the main
   `#status-details` area and open the methodology disclosure.
2. `displayHeatLossResults` in app.js (around line 1120–1175) — similar check for
   M4 `insufficient_data`.

The Implementer should check: which `validation_status` values from M4/M5 indicate
that user input would materially improve the result (not just cosmetic), and only
surface those. Do not surface a notice for `validation_status === 'good'`.

---

## Bug 4 — Results do not make sense

**Status: BLOCKED.** Bug 1 must be fixed first so Rhiannon can see the chart and
report which numbers are wrong and in what direction. No investigation started.

---

## Fix sequencing

Implement in this order:

1. **Bug 1** (graph) and **Bug 2** (What If visibility) — both are small, surgical fixes
   in `app.js` and `styles.css` respectively. Implement together in one commit.
2. **Rhiannon browser-tests** — confirms graph is visible and What If is hidden on load.
3. **Bug 4 investigation begins** — Rhiannon provides detail on the incorrect results.
4. **Bug 3** (manual-entry flag) — implement once Bug 4 is understood; the fix may need
   to know which module is degraded to surface the right message.

---

## Secondary concerns

None identified at this stage.
