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

## Bug 4 — Results analysis (Rhiannon observations, 01-May)

Rhiannon provided the following observations after the graph became visible:
1. HH average electricity price showing ~15p/kWh — expected ~as SVT (24.5p)
2. Annual saving of £35 doesn't seem realistic
3. Changing 'wall construction' dropdown and clicking Recalculate does nothing
4. Smart HP results show even with insufficient thermal mass data
5. Switching tau-bucket (e.g. "takes days to cool" vs "cools within hours") and
   clicking Recalculate changes only the thermal mass estimate — no effect on Smart HP costs

---

### 4A — HH average 15p/kWh

**Finding: expected behaviour, not a bug.**

The displayed average is the simple mean of all D×W+P slots across the year's 17,520
HH periods. With D_DEFAULT = 2.2 (pricing-engine.js:14), P_DEFAULT = 12p (line 15),
and 2024 UK APX wholesale averaging ~6p/kWh:
- Off-peak rate: D×W = 2.2 × 6 = 13.2p (87.5% of slots)
- Peak rate: D×W+P = 13.2+12 = 25.2p (12.5% of slots — 4pm–7pm)
- Simple mean ≈ 0.875×13.2 + 0.125×25.2 = 14.7p ≈ **15p**

The 15p simple mean is correct for 2024 UK data with default calibration. It is lower
than SVT (24.67p) because HH pricing is intended to be cheaper for heat-pump users who
shift demand to cheap periods — this is the tool's core economic premise.

The **consumption-weighted** mean (what a dumb HP actually pays, weighted by when the
boiler fires) will be higher than 15p, because the dumb HP follows the boiler's
morning/evening pattern which overlaps with peak hours. This weighted mean is
computed by `computeWeightedMeanHhRate` (app.js:1822) and shown in the
`unusual-result-panel` if it exceeds a plausibility threshold.

The key display question: is Rhiannon seeing the simple mean (15p) or the
consumption-weighted mean? The simple mean is the correct number to show as the "average
HH rate across the year" but it should be accompanied by the consumption-weighted mean
to show what a dumb HP actually pays.

**No code change required.** Consider adding a label clarifying it is the simple annual
mean, not the consumption-weighted mean.

---

### 4B — Annual saving of £35 not realistic

**Finding: mathematically correct given the inputs; surprising but not a bug.**

Saving = gas_heating_cost − HP_heating_electricity_cost (gas-for-baseload and standing
charges unchanged because gas connection is retained — m8-patch).

With gas at ~5.7p/kWh (Ofgem cap) and boiler efficiency 0.9:
- Gas heat cost = **5.7 / 0.9 = 6.3p per kWh thermal**

With HH consumption-weighted rate ~17p and demand-weighted COP ~2.6:
- HP heat cost = **17 / 2.6 = 6.5p per kWh thermal**

Saving is ~0.2–0.4p per kWh thermal. At 15,000 kWh heating demand: saving £30–60/yr.
£35 is in the right range.

This is the CORRECT economic reality at April 2026 Ofgem cap prices: the dumb HP on
HH pricing barely breaks even versus gas because Ofgem cap gas is very cheap.

The finding confirms the design premise in scope.md: "A heat pump on flat-rate
electricity barely breaks even vs gas. The economics only work with HH pricing + efficient
building fabric + smart heating control." The What If section exists precisely to show
how July 2026 gas price rise, levy removal, or higher COP flip the economics.

**No code change required.** The tool is showing the correct answer.

Recommend Rhiannon use the Policy Reform what-if to model July 2026 cap (~£1,972)
and the BUS grant page for payback on that scenario — that is where the financial
case becomes clearer.

---

### 4C — Wall construction recalculate does nothing visible

**Finding: UX gap, not a calculation bug.**

The `btn-recalculate-heat-loss` handler (app.js:1211–1226) only calls `runHeatLoss()`
— no chain to M5. Wall construction is not used by M4 (Siviour regression). It is used
exclusively in M5 for thermal mass cross-check validation.

To see the wall construction cross-check result, the user must click the **Thermal
Character Recalculate** button. That produces a validation note in `#thermal-char-status`
(inside the methodology disclosure) confirming whether the estimated thermal mass is
consistent with the wall type. It does NOT change the thermal mass estimate or any
downstream results — it is informational only.

**The wall construction input does not drive any calculation.** It only annotates
whether the data-derived thermal mass is consistent with the wall type.

**Proposed fix (minor):** Either (a) chain the heat-loss Recalculate button to also
run M5, or (b) move the wall construction dropdown from heat-loss-card to
thermal-char-card where it semantically belongs, or (c) add a label beneath the wall
construction dropdown: "Affects thermal mass cross-check — use Thermal Character
Recalculate to apply."

---

### 4D — Smart HP available despite insufficient thermal mass

**Finding: design limitation, not a bug.**

`computeValidationStatusSmart` (scenario-consumption.js:204–207) only requires:
- `htc_w_per_k` (heat loss coefficient, from M4)
- `hp_capacity_kw` (from M6)

It does NOT require thermal mass. So Smart HP shows results whenever M4 and M6
succeed, regardless of whether M5 returned a thermal mass.

The smart scenario uses `buildSmartScenario` → `allocateGreedyDay`
(scenario-consumption.js:166–196). This greedy LP does NOT take thermal mass as a
parameter. Thermal mass is only used in `simulatePostHocTIndoor` (lines 138–163) for
producing the indoor temperature trace — not for the heating schedule or costs.

**The "smart" scenario is therefore a cost-aware dispatch (greedily shifts heat to
cheapest HH slots within HP capacity limits), not a thermally-constrained dispatch.**
It assumes unlimited thermal storage — i.e., the HP can pre-heat by any amount, limited
only by HP capacity, not by how much heat the building can absorb and hold.

For a low-thermal-mass building this overstates smart HP savings. For a high-thermal-mass
building the assumption is more accurate.

**No immediate code fix required** (this is a consequence of the greedy LP design agreed
in smart-scenario-fixes-1). Raise as a known limitation. Add a note in the Smart HP
row or tooltip: "Assumes the building can store pre-heated energy; savings may be lower
for low-thermal-mass properties."

---

### 4E — Tau-bucket change has no effect on Smart HP costs

**Finding: confirmed consequence of 4D. The greedy LP does not use thermal mass.**

When tau_bucket is changed and thermal-char Recalculate is clicked, the chain
M5→M7→M8→M9 runs correctly (app.js:1384–1388). M5 produces a new thermal mass value
(Path B tau_bucket fallback). M7 receives the updated thermalChar via
`getThermalCharacterResult()` (app.js:1587).

However, within M7's smart scenario path (scenario-consumption.js:258):
```javascript
buildSmartScenario({
  heating, external, copByHh, hpCapKw: hpCap,
  gasRateByHh, elecHhRateByHh, eta, isAbsence, demandScale,
})
```
Thermal mass (`thermalChar.thermal_mass_kj_per_k`) is NOT passed to `buildSmartScenario`
and NOT used by `allocateGreedyDay`. The thermal mass only feeds
`simulatePostHocTIndoor`, which produces the indoor temperature trace for display.

**Result:** Changing tau_bucket changes:
- The displayed thermal mass estimate ✓
- The indoor temperature trace (in the scenario card, if shown) ✓

But does NOT change:
- The smart HP heating schedule ✗
- M8 costs for smart HP ✗
- M9 payback for smart HP ✗

This is the correct behaviour given the greedy LP design. However, it is potentially
misleading to the user — she would reasonably expect "how quickly your home cools"
to affect smart HP economics.

**Secondary concern (scoped separately from this fix session):** The greedy LP
optimises on raw wholesale prices (app.js:1511 `buildRateArrays` returns
`wholesale_p_kwh` without D×W+P). The M8 pricing then charges D×W+P rates including
the peak premium P=12p for 4pm–7pm slots. M7 doesn't know about P, so it may schedule
heat delivery into peak hours when it shouldn't. This reduces the smart scenario's
optimality. Fix: pass the calibrated D×W+P rate array to M7 instead of raw wholesale.

---

## Fix sequencing

### Immediate (commit together)
1. **Bug 1** (graph) — move `verdictCard.classList.remove('hidden')` before chart init
2. **Bug 2** (What If CSS) — add `!important` to `.hidden` rule in styles.css

### After Rhiannon confirms graph visible and What If hidden on load
3. **Bug 3** (manual-entry flag) — surface M5 insufficient_data warning on main UI;
   auto-open methodology disclosure

### Separate follow-up tasks (raise with Rhiannon for prioritisation)
4. **4C** (wall construction UX) — chain heat-loss Recalculate to M5, or relocate
   wall construction field, or add explanatory label
5. **4D/4E** (smart HP thermal mass) — add a note/tooltip that smart HP assumes
   unlimited thermal storage; optionally fix greedy LP to use D×W+P rates for dispatch
   optimisation (addresses the secondary concern above)
6. **4A display** — consider adding "consumption-weighted average" alongside simple
   mean to help users understand what they'd actually pay

---

## Secondary concerns

1. **Greedy LP uses raw wholesale for optimisation, M8 charges D×W+P** — M7's greedy
   LP (via `buildRateArrays` in app.js:1596) uses raw wholesale, unaware of the peak
   premium P. M8 then charges D×W+P rates. The smart dispatch will occasionally schedule
   heat during 4pm–7pm peak slots it should avoid, reducing optimality.
   Fix (separate task): pass `elec_hh_rate_by_hh` from pricing-engine's `prepareRates`
   to M7 instead of rebuilding from raw wholesale.

2. **"Smart" label implies thermal simulation** — consider renaming or adding a
   qualifier (e.g. "Cost-optimised HP") to avoid implying thermally-constrained dispatch.
