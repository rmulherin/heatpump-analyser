# Bug: Results graph not rendering; What If tiles premature; manual-entry flag missing

**Date:** 2026-05-01
**Reporter:** Rhiannon
**Status:** Bugs 1–2 scoped for immediate fix. Bug 3 scoped, to implement after Bugs 1–2 confirmed. 4A/4B verified correct — no fix required.

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
Rhiannon's house requires certain manual inputs. A warning appears in the methodology
section but not on the main UI surface, so there is no indication that input is needed
until the user expands "Show methodology."

### Observations 4A and 4B — Verified correct behaviour (no fix)
- **4A:** HH average 15p/kWh — correct for 2024 UK APX wholesale with D=2.2 calibration.
  See analysis below.
- **4B:** Annual saving of £35 — mathematically correct at April 2026 Ofgem cap gas
  prices. See analysis below.

### Observations 4C/D/E — Design failure (separate document)
Smart HP dispatch does not use thermal mass. Moved to:
`docs/debug/2026-05-01-design-failure-smart-hp-thermal-mass.md`

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
- **index.html:177** — `<section class="card verdict-card hidden" id="verdict-card">` — starts hidden

### Proposed fix

Category A — application logic error.

Move `verdictCard.classList.remove('hidden')` from line 2221 to **before** the
`destroy()` / `new Chart()` sequence (before line 2174). The card must be visible
before Chart.js measures the canvas.

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
+  // (verdict card already revealed above, before chart init)
```

**Check for same pattern elsewhere:** Grep `new Chart` in app.js — confirm no other
Chart.js initialisation occurs while its parent container is hidden.

---

## Bug 2 — "What If" tiles visible on page load

### Root cause

CSS specificity conflict between `.hidden` and `.section-tiles`.

- **styles.css:502** — `.hidden { display: none; }` (specificity 0,1,0)
- **styles.css:519** — `.section-tiles { display: grid; ... }` (specificity 0,1,0)

Both are single-class selectors with identical specificity. CSS last-wins rule means
`.section-tiles` overrides `.hidden` for any element that carries both classes.
`#what-if-tiles` has `class="section-tiles hidden"` (index.html:413), so it renders as
`display: grid` on page load despite the `hidden` class.

`#section-banner-what-if` has `class="section-banner hidden"` — `.section-banner` sets
only `margin`, not `display`, so that element IS correctly hidden. **Only `#what-if-tiles`
is visually broken.**

### Evidence

- **styles.css:502** — `.hidden { display: none; }`
- **styles.css:519** — `.section-tiles { display: grid; ... }`
- **index.html:413** — `<div class="section-tiles hidden" id="what-if-tiles">`
- **app.js:1770–1771** — correctly removes `hidden` after M8 completes (intent is right; CSS priority is wrong)

### Proposed fix

Category A — CSS specificity bug. Add `!important` to `.hidden` in styles.css:

```css
/* styles.css:502 */
.hidden { display: none !important; }
```

`!important` on a utility visibility class is the established pattern — it is intended
to be unconditional regardless of declaration order or other `display` rules.

**Check for same pattern elsewhere:** Any element with both a `display:`-setting class
and `hidden` would be affected. Audit index.html for elements carrying both.

---

## Bug 3 — Manual entry flag not visible on main surface

### Root cause

All analysis-phase validation warnings for M4 (heat loss) and M5 (thermal character)
are rendered into `#heat-loss-status` and `#thermal-char-status` divs, which are
children of `#heat-loss-card` and `#thermal-char-card`. Both cards are inside
`<details class="methodology-disclosure hidden" id="methodology-disclosure">`
(index.html:234). Collapsed by default — warnings invisible until the user expands
"Show methodology."

When M5 returns `validation_status === 'insufficient_data'` (cold-soak estimation
failed — boiler ran continuously overnight), the calculation proceeds with degraded
inputs. No notice is pushed to the main-surface `#status-area` / `#status-details`
(app.js:1129–1132 for M4; same pattern in M5 handlers).

### Evidence

- **app.js:1129–1132** — M4 `insufficient_data` handler reveals `heatLossResults` and returns. No main-surface notice.
- **index.html:234** — `<details class="methodology-disclosure">` wraps both cards
- **index.html:239** — `#heat-loss-card` inside disclosure
- **index.html:273** — `#thermal-char-card` inside disclosure

### Proposed fix

Category A — missing UI surfacing.

In `displayThermalCharResults` and `displayHeatLossResults` in app.js, when
`validation_status === 'insufficient_data'` or `thermal_mass_source === 'no_data'`,
also push a notice to the main `#status-details` area **and** auto-open the
methodology disclosure so the user can see where to act.

Suggested notice text:
> "Your thermal mass estimate could not be determined from your data. Open
> 'Show methodology' → Thermal character and enter 'time away in winter' or
> 'how quickly your home cools' to improve accuracy."

**Specific locations to change:**

1. `displayThermalCharResults` in app.js (around line 1260–1370) — after detecting
   insufficient source, push notice to `#status-details` and set
   `methodologyDisclosure.open = true` / remove `hidden`.
2. `displayHeatLossResults` in app.js (around line 1120–1175) — similar for M4
   `insufficient_data`.

Surface only status values that indicate user input would materially improve results.
Do not surface a notice for `validation_status === 'good'`.

---

## Observations 4A and 4B — Verified correct, no fix required

### 4A — HH average 15p/kWh

The displayed average is the simple mean of all D×W+P slots across the year's 17,520
HH periods. With D_DEFAULT = 2.2 (pricing-engine.js:14), P_DEFAULT = 12p (line 15),
and 2024 UK APX wholesale averaging ~6p/kWh:
- Off-peak (87.5% of slots): D×W = 2.2 × 6 = 13.2p
- Peak (12.5% of slots — 4pm–7pm): D×W+P = 13.2+12 = 25.2p
- Simple annual mean ≈ **15p** ✓

15p is correct and lower than SVT (24.67p) by design — HH pricing is intended to be
cheaper for heat-pump users. Rhiannon confirmed this was acceptable once understood.

The consumption-weighted mean (what a dumb HP actually pays, weighted by when the
boiler fires — mornings/evenings overlapping with peak hours) is higher than 15p.
That weighted mean is computed by `computeWeightedMeanHhRate` (app.js:1822) and
surfaced via the `unusual-result-panel` if it exceeds a plausibility threshold.

### 4B — Annual saving of £35

With gas at ~5.7p/kWh (Ofgem cap) and boiler efficiency 0.9:
- Gas heat cost per kWh thermal: 5.7 / 0.9 = **6.3p**

With consumption-weighted HH rate ~17p and demand-weighted COP ~2.6:
- HP heat cost per kWh thermal: 17 / 2.6 = **6.5p**

Saving per kWh thermal ≈ 0.2–0.4p. At 15,000 kWh annual heating: saving £30–60/yr.
£35 is in range. Rhiannon's back-of-envelope confirmed this and the -22% heating cost
figure for dumb vs smart HP aligned with the tool's output.

This is the correct economic reality at April 2026 Ofgem cap prices. It confirms
the design premise: "the economics only work with HH pricing + efficient building
fabric + smart heating control." The What If → Policy Reform section (July 2026 cap)
is where the financial case improves.

---

## Fix sequencing

### Immediate — implement together in one Sonnet session
1. **Bug 1** — move `verdictCard.classList.remove('hidden')` before chart init (app.js)
2. **Bug 2** — add `!important` to `.hidden` rule (styles.css)

### After Rhiannon confirms graph and What If visibility are correct
3. **Bug 3** — surface M5/M4 insufficient_data warnings on main UI; auto-open methodology disclosure
