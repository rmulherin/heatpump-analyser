# Module 4 — Heat Loss Estimation (Siviour Regression)

**Date:** 2026-04-23
**Status:** Awaiting approval — review via claude.ai before implementation begins.

---

## Task description

Implement the heat loss estimation module (`js/heat-loss.js`) which derives the building's Heat Transfer Coefficient (HTC, W/K) and solar aperture (R, m²) from the daily-aggregated heating demand, outdoor temperature, and solar irradiance produced by Modules 1–3.

The method is the Siviour regression: an ordinary least-squares through-origin fit of `daily_heating_kWh = α·DD + β·S` where DD is degree-days and S is daily solar energy. HTC is recovered from the fitted α, R from the fitted β. The module also applies four sanity checks, produces a building rating and cooling consideration flag, and integrates into the pipeline as a new step wired after Module 3 in both Octopus and CSV flows.

Design doc: `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/heat-loss.md`

---

## Research findings

### OLS method (2-predictor, no intercept)

The normal equations for through-origin OLS with two predictors reduce to a 2×2 linear system:

```
[Σx1²    Σx1·x2] [α]   [Σx1·y]
[Σx1·x2  Σx2²  ] [β] = [Σx2·y]
```

The 2×2 closed-form inverse is simpler and safer than the Gauss-Jordan approach used in M3 (which handled a 3×3 matrix with intercept). Cramer's rule:

```
det = (Σx1²)(Σx2²) − (Σx1·x2)²

[α]   1   [ Σx2²    −Σx1·x2] [Σx1·y]
[β] = ─── [                 ] [     ]
     det   [−Σx1·x2   Σx1² ] [Σx2·y]
```

Singularity check: if `|det| / (n × max(Σx1², Σx2²)) < 1e-10`, fall back to the one-predictor fit (solar term cannot be reliably estimated — happens when the solar column has insufficient variance, e.g. all-overcast winter data).

**Standard errors:**
```
σ² = SS_res / (n − 2)
SE(α) = sqrt(σ² × Σx2² / det)
SE(β) = sqrt(σ² × Σx1² / det)
```

**R² (raw/through-origin definition, as specified by the design doc):**
```
SS_res = Σ(y − α·x1 − β·x2)²
SS_tot_raw = Σy²   ← sum of squares of raw values, NOT deviations from mean
r2 = 1 − SS_res / SS_tot_raw
```

**One-predictor fallback (Check 4A path):**
```
α = Σ(x1·y) / Σ(x1²)
σ² = SS_res / (n − 1)
SE(α) = sqrt(σ² / Σx1²)
r2 = 1 − SS_res / Σy²
```

### HH resolution adaptation

The design doc refers to "24 hourly values" for external data, but `external[]` is aligned to the consumption HH timeline (48 slots per day). The formulas adapt directly:

| Design doc | Implementation with 48 HH slots |
|------------|----------------------------------|
| `mean(temp_c over 24 hourly)` | `mean(temp_c over 48 HH slots)` — identical result if hourly values are repeated |
| `sum(solar_w_m2 over 24 h) / 1000` | `sum(solar_w_m2 over 48 slots) × 0.5 / 1000 = sum / 2000` |

The `/2000` solar formula is noted in Test 1; any incorrect resolution factor produces wrong HTC by a factor of 2, which Test 1 catches.

### Shared constant

`HDD_BASE_TEMP = 15.5` is already exported from `js/constants.js` and imported in `baseload.js`. Module 4 imports the same constant — no redeclaration. Test 7 asserts the output `degree_day_base_c` equals `HDD_BASE_TEMP`.

### No new libraries

Pure vanilla JS. All required maths (2×2 matrix inversion, basic statistics) is written inline. The Luxon global is loaded by index.html for any date parsing needed in `aggregateToDays`.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/heat-loss.js` | Heat loss estimation: OLS regression + sanity checks + rating |
| MODIFY | `index.html` | Add heat loss card (parameter inputs + results display) |
| MODIFY | `js/app.js` | Import heat-loss, add `runHeatLoss()`, wire into Octopus and CSV flows |

No new CSS file — existing card, form-group, and status-msg classes cover all display needs. Full styled UI is Module 10's job; M4 adds functional display only.

---

## Implementation steps

### Step 1 — Create `js/heat-loss.js`

#### 1a. Module scaffold

```js
import { HDD_BASE_TEMP } from './constants.js';

let _heatLossResult = null;
export function setHeatLossResult(r) { _heatLossResult = r; }
export function getHeatLossResult() { return _heatLossResult; }

export function estimateHeatLoss(heating, external, baseloadMetadata, supplementaryLoads, boilerEfficiency, floorAreaM2) { ... }
```

#### 1b. Pre-flight check (no-gas)

At the top of `estimateHeatLoss`, before any computation:

```js
if (baseloadMetadata.method === 'no-gas') {
  return {
    htc_w_per_k: null, htc_confidence_interval_95: null,
    htc_correction_w_per_k: null, htc_w_per_k_adjusted: null,
    rating: null,
    solar_aperture_m2: null, solar_rating: null, solar_correction_applied: false,
    cooling_consideration: null,
    hlp_w_per_m2_k: null,
    boiler_efficiency_used: boilerEfficiency,
    degree_day_base_c: HDD_BASE_TEMP,
    regression_r2: null,
    days_used_in_fit: 0,
    days_excluded: { absence: 0, zero_degree_days: 0, missing_heating: 0, missing_weather: 0, below_heating_threshold: 0 },
    validation_status: 'no_gas',
    warnings: [],
  };
}
```

#### 1c. `aggregateToDays(heating, external)` — private

Group the parallel `heating[]` and `external[]` arrays by UTC calendar date (first 10 chars of timestamp). Only dates with exactly 48 slots are processed (others silently dropped — they are partial days at the data boundary and are never used).

For each 48-slot date, produce one object:

```js
{
  dateStr,                  // 'YYYY-MM-DD'
  daily_heating_kwh,        // sum of heating_kwh over 48 slots
  daily_mean_temp_c,        // mean of temp_c over 48 slots
  daily_solar_kwh_per_m2,   // sum of solar_w_m2 over 48 slots / 2000
  daily_degree_days,        // max(0, HDD_BASE_TEMP − daily_mean_temp_c)
  has_absence,              // any slot with is_absence === true
  missing_heating,          // any slot with heating_kwh === null
  missing_weather,          // any slot with temp_c === null or solar_w_m2 === null
}
```

`daily_degree_days` is computed inside `aggregateToDays` so that filtering can read it directly.

**Note:** the `daily_heating_kwh` sum only makes sense when `missing_heating` is false. The value is still computed (as it avoids a second pass) but the filtering step will exclude days where `missing_heating` is true.

#### 1d. `filterForRegression(days)` — private

Apply the four exclusion criteria from Step 2 of the design doc. Return `{ filtered, excluded }`:

| Exclusion | Condition | Counter |
|-----------|-----------|---------|
| Absence days | `has_absence` | `excluded.absence` |
| Zero degree-days | `daily_degree_days === 0` | `excluded.zero_degree_days` |
| Missing heating | `missing_heating` | `excluded.missing_heating` |
| Missing weather | `missing_weather` | `excluded.missing_weather` |
| Below heating threshold | `daily_heating_kwh < 2.0` | `excluded.below_heating_threshold` |

A day matching multiple criteria is counted in the **first** matching criterion above (earliest in this priority order). This keeps the sum consistent (no double-counting).

#### 1e. `runOLSTwoPredictor(filtered)` — private

Builds the 2×2 normal equations from `filtered` (x1 = degree-days, x2 = solar energy, y = heating kWh). Returns:

```js
{
  alpha,    // Σx2²·Σx1y − Σx1x2·Σx2y) / det
  beta,     // (Σx1²·Σx2y − Σx1x2·Σx1y) / det
  seAlpha,  // sqrt(σ² × Σx2² / det)
  seBeta,   // sqrt(σ² × Σx1² / det)
  r2,       // 1 − SS_res / SS_tot_raw
  n,        // number of days fitted
}
```

Returns `null` if `det` is near-zero (singularity check: `Math.abs(det) / (n * Math.max(sx1sq, sx2sq)) < 1e-10`).

#### 1f. `runOLSOnePredictor(filtered)` — private

Used for the Check 4A fallback path. x1 = degree-days only. Returns `{ alpha, seAlpha, r2, n }`.

#### 1g. Main computation flow in `estimateHeatLoss`

After the pre-flight and calling `aggregateToDays` + `filterForRegression`:

1. Gate: `if (filtered.length < 20)` → return `insufficientDataResult(excluded, boilerEfficiency)`. This function returns the null-HTC object with `validation_status = 'insufficient_data'` and the standard warning message.

2. Call `runOLSTwoPredictor(filtered)`. If it returns `null` (singular) treat as insufficient data (singular matrix is degenerate data, Step 5 of design doc).

3. Check `fit.alpha < 0`: inverted relationship → null HTC, `validation_status = 'poor'`, specific warning about inverted relationship. Populate `days_used_in_fit = filtered.length`.

4. Otherwise, recover physical params:
   ```js
   const htc = fit.alpha * 1000 * boilerEfficiency / 24;  // W/K
   const r = -fit.beta;                                    // m²
   const ci = {
     lower: (fit.alpha - 1.96 * fit.seAlpha) * 1000 * boilerEfficiency / 24,
     upper: (fit.alpha + 1.96 * fit.seAlpha) * 1000 * boilerEfficiency / 24,
   };
   ```

5. **Check 4A** — negative solar aperture: `if (r < 0)`:
   - Run `runOLSOnePredictor(filtered)` to refit
   - Recompute `htc`, `ci` from the one-predictor fit
   - Set `solar_correction_applied = false`, `solar_aperture_m2 = null`, `solar_rating = null`, `cooling_consideration = null`
   - Add warning: `"Solar correction produced a physically implausible result (likely noisy data). Fell back to temperature-only regression."`
   - Use the one-predictor R² for `regression_r2`

6. **Check 4B** — HTC plausibility (50–1500 W/K):
   - If out of range: set `validation_status = 'poor'`, add warning naming the specific value and the plausibility concern

7. **Check 4C** — R² thresholds:
   - R² ≥ 0.7 → `'good'`
   - 0.5 ≤ R² < 0.7 → `'acceptable'`
   - R² < 0.5 → `'poor'` + warning about poor fit

8. **Check 4D** — supplementary electric heating:
   - Only when `htc` is non-null AND `supplementaryLoads.electric_heating_detected === true` AND confidence is `'high'` or `'moderate'`
   - `correction = (1000 / 24) * supplementaryLoads.electric_heating_kwh_per_dd`
   - `htc_adjusted = htc + correction`
   - Add warning with both numbers

9. **Check 4B + 4C conflict resolution:** 4B can override the status to `'poor'` even if R² would give `'good'`. 4B check runs after 4C — if 4B fires, override the status to `'poor'` regardless of R².

10. **Check — wide CI:** after computing the CI, if `(ci.upper - ci.lower) > 0.5 * htc`, add warning: `"The uncertainty range on your heat loss estimate is wide (±{N} W/K). More heating data would improve this."`

11. **Step 6** — rating, solar rating, cooling consideration, HLP:
    - `buildRating(htc)` → string or null
    - `buildSolarRating(r)` → string or null (only if `solar_correction_applied`)
    - `buildCoolingConsideration(htc, r)` → string or null
    - `hlp = floorAreaM2 !== null ? htc / floorAreaM2 : null`
    - Floor area plausibility warning: if `floorAreaM2 !== null && (floorAreaM2 < 30 || floorAreaM2 > 500)`, add warning

12. Build and return the full result object matching the design doc spec. Populate `days_used_in_fit = filtered.length`.

#### 1h. `buildRating(htc)`, `buildSolarRating(r)`, `buildCoolingConsideration(htc, r)` — private

Implement the threshold tables from design doc Step 6 exactly. For `buildCoolingConsideration`, apply the three conditions in order (significant → worth_noting → minimal).

---

### Step 2 — Modify `index.html`

Replace the existing `analysis-card` placeholder (`<section class="card hidden" id="analysis-card">`) with a heat loss card:

```html
<!-- Heat Loss Card (Module 4) -->
<section class="card hidden" id="heat-loss-card">
  <h2>Heat Loss Estimate</h2>

  <!-- Parameter inputs -->
  <div class="form-row" id="heat-loss-params">
    <div class="form-group">
      <label for="boiler-efficiency">Boiler efficiency</label>
      <input type="number" id="boiler-efficiency" value="0.90"
             step="0.01" min="0.60" max="0.98">
      <p class="form-hint">Modern condensing boiler: 0.85–0.92. Older non-condensing: 0.70–0.80.</p>
    </div>
    <div class="form-group">
      <label for="floor-area">Floor area (m²) — optional</label>
      <input type="number" id="floor-area" placeholder="e.g. 120"
             step="1" min="0">
      <p class="form-hint">Total floor area in square metres. Enables heat loss per m² comparison.</p>
    </div>
  </div>
  <button class="btn btn-secondary" id="btn-recalculate-heat-loss">Recalculate</button>

  <!-- Results (populated by JS) -->
  <div id="heat-loss-results" class="hidden">
    <div class="status-area" id="heat-loss-status"></div>
    <dl id="heat-loss-summary"></dl>
  </div>
</section>
```

Add `btn-secondary` as a CSS class if not present — same styling as `btn-primary` but with a lighter fill using `var(--colour-teal)` at reduced opacity, or simply use `btn-primary` if the distinction isn't needed yet. Check `css/styles.css` before adding — if it already exists, use it; otherwise use `btn-primary`.

---

### Step 3 — Modify `js/app.js`

#### 3a. Add imports

```js
import {
  estimateHeatLoss,
  setHeatLossResult,
  getHeatLossResult,
} from './heat-loss.js';
```

#### 3b. Add DOM references

```js
const heatLossCard = document.getElementById('heat-loss-card');
const heatLossResults = document.getElementById('heat-loss-results');
const heatLossSummary = document.getElementById('heat-loss-summary');
const heatLossStatus = document.getElementById('heat-loss-status');
const boilerEfficiencyInput = document.getElementById('boiler-efficiency');
const floorAreaInput = document.getElementById('floor-area');
const btnRecalculateHeatLoss = document.getElementById('btn-recalculate-heat-loss');
```

#### 3c. Add `runHeatLoss(showProgressFn, showStatusFn)`

```js
async function runHeatLoss(showProgressFn, showStatusFn) {
  const baseload = getBaseloadResult();
  const externalResult = getExternalResult();
  if (!baseload || !externalResult) return;

  showProgressFn('Estimating heat loss…');

  const boilerEfficiency = parseFloat(boilerEfficiencyInput.value) || 0.90;
  const floorAreaRaw = parseFloat(floorAreaInput.value);
  const floorAreaM2 = isNaN(floorAreaRaw) ? null : floorAreaRaw;

  let result;
  try {
    result = estimateHeatLoss(
      baseload.heating,
      externalResult.external,
      baseload.baseload_metadata,
      baseload.supplementary_loads,
      boilerEfficiency,
      floorAreaM2
    );
  } catch (err) {
    showStatusFn('Heat loss estimation failed: ' + err.message, 'error');
    console.error('runHeatLoss error:', err);
    return;
  }

  setHeatLossResult(result);
  displayHeatLossResults(result);
}
```

#### 3d. Add `displayHeatLossResults(result)`

Clears `heat-loss-status` and `heat-loss-summary`. Displays the result using `heatLossStatus` for warnings, and `heatLossSummary` (`<dl>`) for key values.

Show at minimum:
- HTC value with CI and rating (or the "insufficient data" message if null)
- `validation_status` badge
- Adjusted HTC (if non-null) with framing: "Gas-based: X W/K · Adjusted for detected electric heating: Y W/K"
- Solar aperture + solar_rating (if non-null)
- cooling_consideration (if non-null and non-"minimal")
- HLP (if non-null)
- All warnings from `result.warnings` as status-msg items

Unhides `heat-loss-results` and `heat-loss-card` after populating.

#### 3e. Wire flows

In both Octopus and CSV flows, after the `await runBaseloadSeparation(...)` call, add:

```js
// Step 11: Trigger Module 4 — Heat Loss Estimation
await runHeatLoss(
  (text) => showProgress(text, undefined),
  (msg, type) => showStatus(msg, type)
);
```

(For CSV flow, use the CSV-specific `showCsvProgress` and `showCsvStatus` functions.)

#### 3f. Wire recalculate button

```js
btnRecalculateHeatLoss.addEventListener('click', async () => {
  btnRecalculateHeatLoss.disabled = true;
  heatLossStatus.innerHTML = '';
  await runHeatLoss(
    (text) => showProgress(text, undefined),
    (msg, type) => showStatus(msg, type)
  );
  btnRecalculateHeatLoss.disabled = false;
});
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Unit error (×24 or ×1000 applied wrong) producing HTC off by large factors | Test 1 (synthetic data recovery) will fail by a factor of 24 or 1000, making the error unmissable |
| `fit_intercept` equivalent — inadvertently including an implicit intercept | Through-origin OLS is explicit by construction: the normal equations contain no constant term |
| Near-singular 2×2 matrix when solar variance is low (all-overcast winter) | Singularity check on det; fall through to one-predictor fit (same path as Check 4A fallback) |
| solar_w_m2 HH vs hourly: wrong integration factor (÷1000 instead of ÷2000) | Test 1 catches factor-of-2 error on fitted R; Test 7 indirectly catches unit chain issues |
| R² raw definition vs deviation definition: silently wrong quality assessment | Documented explicitly in plan and code; Test 1 verifies R² ≥ 0.7 on clean synthetic data |
| Check 4B overriding 4C: validation_status ends up wrong in edge case | Both checks recorded; 4B always wins if it fires (last write wins in the status variable) |
| Wide CI not surfaced to user on sparse winter data | Step 1g.10 adds the CI-width warning; Test 19 verifies CI tightens with more data |
| `electric_heating_kwh_per_dd` null when `electric_heating_detected` true | Guard: only read `kwh_per_dd` if confidence is 'high' or 'moderate' — same gate prevents null-access |
| `btn-secondary` CSS class missing | Check `css/styles.css` before adding HTML; fall back to `btn-primary` if absent |

---

## Success criteria

All 20 tests are manual developer tests run in the browser console (no test framework). Each corresponds to a test in the design doc.

- [ ] **T1 — Units and core fit:** Generate synthetic daily data (HTC=250 W/K, R=3 m², η=0.9, DD range 2–14, solar 0.5–3 kWh/m²/day, 10% Gaussian noise, ≥30 days). Fitted HTC 225–275 W/K, fitted R 2.7–3.3 m².
- [ ] **T2 — Absence exclusion:** Same synthetic data + 10 `is_absence=true` days with zero heating. Fitted HTC unchanged from T1 within 5%.
- [ ] **T3 — Solar correction effect:** Days with same DD but different solar have different heating. R fitted within 20% of true. Temperature-only fit gives systematically higher HTC.
- [ ] **T4 — Negative R fallback:** Noisy data producing β > 0 → `solar_correction_applied=false`, `solar_aperture_m2=null`, warning surfaced. HTC still returned.
- [ ] **T5 — HTC plausibility bounds:** Synthetic data giving HTC=2000 → `validation_status='poor'`, warning naming the value. Same for HTC < 50.
- [ ] **T6 — Insufficient data:** 15 heating days → `htc_w_per_k=null`, `validation_status='insufficient_data'`, specific warning, no invented value.
- [ ] **T7 — Cross-module constant:** `result.degree_day_base_c === HDD_BASE_TEMP` (both equal 15.5). Verify by console assertion.
- [ ] **T8 — Boiler efficiency scaling:** Run same data η=0.9 and η=0.7. `htc_0.7 / htc_0.9 === 0.7/0.9` to floating-point precision.
- [ ] **T9 — Through-origin enforcement:** Inspect the OLS calculation — no constant term, no intercept column added. Confirm by checking that a synthetic dataset with non-zero y-intercept (constant baseline heating) produces a poor R² rather than a biased fit.
- [ ] **T10 — HTC rating boundaries:** HTC values 149, 150, 249, 250, 349, 350, 499, 500 → ratings "excellent", "good", "good", "average", "average", "poor", "poor", "very_poor".
- [ ] **T11 — Solar rating boundaries:** R values 1.9, 2.0, 3.9, 4.0, 6.9, 7.0, 11.9, 12.0 → ratings "minimal", "moderate", "moderate", "good", "good", "high", "high", "very_high".
- [ ] **T12 — Check 4D correction:** htc=250 W/K + `electric_heating_kwh_per_dd=0.6`, confidence='high' → `correction=25.0 W/K (±0.1)`, `adjusted=275 W/K (±0.1)`, warning surfaced. Confidence='low' → correction=null. Detected=false → correction=null.
- [ ] **T13 — Cooling consideration (significant):** HTC=180, R=8 → `"significant"`.
- [ ] **T14 — Cooling consideration (worth_noting):** HTC=240, R=5 → `"worth_noting"`.
- [ ] **T15 — Cooling consideration (minimal — leaky):** HTC=400, R=8 → `"minimal"`.
- [ ] **T16 — Cooling consideration (minimal — low solar):** HTC=150, R=2 → `"minimal"`.
- [ ] **T17 — Cooling consideration null on solar fallback:** Data triggering Check 4A → `solar_aperture_m2=null`, `solar_rating=null`, `cooling_consideration=null`.
- [ ] **T18 — HLP:** floor_area=100, HTC=300 → `hlp=3.0`. No floor area → `hlp=null`. HTC null → `hlp=null`.
- [ ] **T19 — CI sanity:** 30-day dataset R²≈0.85, HTC≈250 → CI roughly ±30–40 W/K. 100-day R²≈0.95 → tighter (≤±20 W/K).
- [ ] **T20 — No-gas passthrough:** `baseload_metadata.method='no-gas'` → all numeric outputs null, `validation_status='no_gas'`, no warnings. Check 4D does not trigger even if `electric_heating_detected=true`.

---

## Claude.ai Review — yyyy-mm-dd

**Reviewer:** Claude (Praxis Insight — Opus architect window)

**Overall verdict:** [Approved / Approved with clarifications / Revise and resubmit]

### What is solid
[What the plan gets right. Be specific.]

### Clarifications required before implementation
[Any ambiguity, missing specification, or underdefined behaviour that would force
Claude Code to make an undocumented decision mid-build. Each item must include
the resolution — not just the problem.]

### Minor observations (not blockers)
[Optional. Suggestions for V2, style notes, things to keep in mind.]

---

## Approval

**Status:** ✅ Approved — yyyy-mm-dd
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** [Restate each clarification resolution so Claude Code
has a single authoritative source.]

---

## Implementation Deviations

[None.]
