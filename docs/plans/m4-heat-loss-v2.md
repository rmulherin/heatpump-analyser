# m4-heat-loss-v2 — Combined-fuel Siviour fit, net_flow back-calc, boiler dropdown

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the M4 v2 delta as specified in `design/m4-heat-loss-v2.md`. Three focused
changes to `js/heat-loss.js`: (1) replace the v1 gas-only Siviour fit with a combined-fuel
fit that handles all four UK household heating profiles (gas-only, mixed-fuel,
all-electric, existing-HP) in one code path — removing the no-gas early return and the
post-fit Check 4D additive correction (INV-15); (2) add a `net_flow_w` back-calculation
using the user-stated winter setpoint and M3-v2's `baseline_kwh_per_day` as the
internal-gains term (INV-3); (3) replace the free-form numeric `boiler_efficiency` input
with a 4-tier dropdown anchored on UK SAP seasonal-average efficiencies, and remove the
`floor_area_m2` input and `hlp_w_per_m2_k` output (INV-12, §7 7b). Downstream: `app.js`
call-site and display function update; `index.html` HTML control changes; new
`test-m4-v2.mjs` covering the 13 v2-specific test criteria from the design doc.

---

## Research findings

**Existing code reviewed:**

- `js/heat-loss.js` — 388-line module. `estimateHeatLoss(heating, external,
  baseloadMetadata, supplementaryLoads, boilerEfficiency, floorAreaM2)` is the single
  public export. Private helpers: `aggregateToDays` (per-HH → per-day), `filterForRegression`
  (absence/DD/threshold exclusions), `runOLSTwoPredictor` (2-predictor through-origin OLS),
  `runOLSOnePredictor` (1-predictor Check 4A fallback), `buildRating` / `buildSolarRating` /
  `buildCoolingConsideration`. HTC recovery: `htc = alpha * 1000 * boilerEfficiency / 24`
  (v1 bakes η into the coefficient; v2 bakes η into the LHS instead).
- `js/app.js:1218–1231` — reads `boilerEfficiencyInput.value` (free text, fallback 0.90),
  `floorAreaInput.value`, calls `estimateHeatLoss` with 6 args, then `setHeatLossResult` +
  `displayHeatLossResults`. `displayHeatLossResults` at line 1133 uses a DL table approach;
  surfaces `htc_w_per_k_adjusted` (line 1184) and `hlp_w_per_m2_k` (line 1188) — both to
  be removed. `validation_status === 'no_gas'` branch (line 1144) to be removed (v2 runs
  all-electric through the fit; pathological no-gas + no-elec falls to `insufficient_data`).
- `index.html` — `#boiler-efficiency` is a `<input type="number">`, `#floor-area` is a
  `<input type="number">`. Both in the Heat Loss methodology card. A winter-setpoint input
  (`#winter-setpoint`) does not exist yet and must be added.
- No existing `test-m4*.mjs` file — test suite written from scratch.
- Design doc `m4-heat-loss-v2.md` confirms no external libraries required; all maths are
  pure JS float arithmetic matching the existing OLS helper pattern. Through-origin OLS is
  already correctly implemented in `runOLSTwoPredictor` and `runOLSOnePredictor` — no change
  to those functions' internal maths, only what `y` value the caller passes into them.
- `design/m3-baseload-v2.md` output contract confirmed: `supplementary_loads` exposes
  `electric_heating_classification_effective` ('none'|'some'|'all_electric'),
  `electric_heating_kwh_per_dd` (corrected slope), and `baseline_kwh_per_day` (Step H
  regression intercept). Deprecated `electric_heating_is_primary` is removed in m3-v2 — this
  plan must not read it.

**No third-party libraries needed.** All maths are vanilla JS. The OLS functions are reused
as-is; only the caller assembles a different `y` column.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/heat-loss.js` | Combined-fuel fit, net_flow, new outputs, API changes |
| MODIFY | `js/app.js` | Updated call site, dropdown read, winter setpoint, display updates |
| MODIFY | `index.html` | Boiler dropdown, remove floor area input, add winter setpoint input |
| CREATE | `test-m4-v2.mjs` | 13 v2-specific tests per design doc §7 |

---

## Implementation steps

### Step 1 — Update `estimateHeatLoss` signature; remove deprecated inputs

In `js/heat-loss.js`, change the function signature:

```js
// v1:
export function estimateHeatLoss(heating, external, baseloadMetadata, supplementaryLoads, boilerEfficiency, floorAreaM2)

// v2:
export function estimateHeatLoss(heating, external, baseloadMetadata, supplementaryLoads, boilerEfficiency, winterSetpointC)
```

`floorAreaM2` is removed. `winterSetpointC` is added as the final parameter (number, the
user's stated indoor winter setpoint in °C).

### Step 2 — Add combined-fuel pre-flight (replace no-gas early return)

Remove the v1 no-gas early return block at the top of `estimateHeatLoss` (lines 208–224).

In its place, derive `fuel_split` and `useElecHeating` from M3-v2's classification field:

```js
const classificationEffective = supplementaryLoads?.electric_heating_classification_effective ?? 'none';
let fuel_split, useElecHeating;
if (classificationEffective === 'none') {
  fuel_split = 'gas_only';
  useElecHeating = false;
} else if (classificationEffective === 'some') {
  fuel_split = 'mixed_fuel';
  useElecHeating = true;
} else {
  // 'all_electric'
  fuel_split = 'all_electric';
  useElecHeating = true;
}
const elecHeatingKwhPerDd = useElecHeating
  ? (supplementaryLoads?.electric_heating_kwh_per_dd ?? 0)
  : 0;
```

No early return for any classification. All paths enter the aggregation and fit below.

### Step 3 — Extend `aggregateToDays` to add `daily_heat_delivered` and `daily_mean_temp_c`

Change signature: `aggregateToDays(heating, external, boilerEfficiency, elecHeatingKwhPerDd)`.

In the day-building loop, after computing `daily_heating_kwh` and `daily_degree_days`, add:

```js
const daily_elec_heating_kwh = elecHeatingKwhPerDd * daily_degree_days;
const daily_heat_delivered   = daily_heating_kwh * boilerEfficiency
                             + daily_elec_heating_kwh * 1.0;
const daily_mean_temp_c      = missing_weather ? NaN : tempSum / 48;
```

Add `daily_elec_heating_kwh`, `daily_heat_delivered`, and `daily_mean_temp_c` to each day
object in the returned `days` array. `daily_heating_kwh` (gas, raw) is still kept because
it is referenced in the annual totals calculation in Step 11.

### Step 4 — Update `filterForRegression` to use combined-fuel threshold

Change the heating threshold check from:

```js
if (day.daily_heating_kwh < 2.0) { excluded.below_heating_threshold++; continue; }
```

to:

```js
if ((day.daily_heating_kwh + (day.daily_elec_heating_kwh ?? 0)) < 2.0) {
  excluded.below_heating_threshold++;
  continue;
}
```

All other filter criteria (absence, zero_degree_days, missing_heating, missing_weather) are
unchanged.

### Step 5 — Update OLS callers to pass `daily_heat_delivered` as `y`

In `runOLSTwoPredictor`, the loop currently reads `const y = d.daily_heating_kwh`. Change
this to `const y = d.daily_heat_delivered`. The same change applies to `runOLSOnePredictor`.
No other changes to either OLS function — the maths are identical; only the `y` column
changes.

### Step 6 — Update HTC recovery formula (no η factor)

v1 recovery: `htc = alpha * 1000 * boilerEfficiency / 24`
v2 recovery: `htc = alpha * 1000 / 24`

The gas efficiency is already baked into the LHS (`daily_heat_delivered` includes
`gas × η`), so recovering HTC from α must not apply η again. Update the CI calculation
similarly: `ci.lower = (alpha − 1.96 × seAlpha) * 1000 / 24` etc.

### Step 7 — Delete Check 4D

Remove the entire Check 4D block (currently lines 328–345 in `heat-loss.js`) that reads
`supplementaryLoads.electric_heating_detected` / `electric_heating_kwh_per_dd` and
computes `htc_correction` / `htc_adjusted`. Remove the local variables `htc_correction`
and `htc_adjusted`.

### Step 8 — Extend Check 4B for all-electric dual-handed framing

Declare `let htcLowPlausibilityCallout = null;` before Check 4B. Replace the existing
Check 4B block with:

```js
if (htc < 50) {
  if (fuel_split === 'all_electric') {
    htcLowPlausibilityCallout = 'all_electric_dual_handed';
    // Note: warning copy surfaces on the thermal-character card (UI Phase 4),
    // NOT in the Heat Loss card warnings[]. m4 sets the flag; UI routes it.
  } else {
    htcLowPlausibilityCallout = 'gas_only';
    warnings.push(`The calculated heat transfer coefficient (${htc.toFixed(0)} W/K) is outside the plausible UK range (50–1500). This could indicate a wood burner, unusual fuel mix, or data issues. Treat results with caution.`);
  }
  validation_status = 'poor';
} else if (htc > 1500) {
  validation_status = 'poor';
  warnings.push(`The calculated heat transfer coefficient (${htc.toFixed(0)} W/K) is outside the plausible UK range (50–1500). This could indicate a wood burner, unusual fuel mix, or data issues. Treat results with caution.`);
}
```

Note: the existing high-HTC branch (> 1500) warning copy is preserved unchanged.

### Step 9 — Make `insufficientDataResult` classification-aware

Replace the single `insufficientDataResult()` inner function with one that accepts
`fuelSplit` and emits the appropriate copy per §4.7 of the design doc:

```js
function insufficientDataResult(fuelSplit) {
  const warning = fuelSplit === 'all_electric'
    ? "Not enough heating data to calculate your home's heat loss. We need at least 20 days when your electricity consumption clearly reflects heating use. Come back in winter or with more data."
    : "Not enough heating data to calculate your home's heat loss. We need at least 20 days of heating (below 15.5°C outside). Come back in winter or with more data.";
  return {
    htc_w_per_k: null, htc_confidence_interval_95: null,
    fit_inputs: { used_elec_heating: false, fuel_split: fuelSplit ?? 'gas_only', elec_heating_share_annual: 0 },
    boiler_efficiency_used: boilerEfficiency, winter_setpoint_used_c: winterSetpointC,
    rating: null,
    solar_aperture_m2: null, solar_rating: null, solar_correction_applied: false,
    cooling_consideration: null,
    degree_day_base_c: HDD_BASE_TEMP,
    regression_r2: null, days_used_in_fit: 0,
    days_excluded: excluded ?? zeroExcluded,
    internal_gains_w_used: null,
    net_flow_w: null, net_flow_label: null, net_flow_warning: null,
    htc_low_plausibility_callout: null,
    validation_status: 'insufficient_data',
    warnings: [warning],
  };
}
```

All existing call sites that return `insufficientDataResult()` now pass `fuel_split`:
`return insufficientDataResult(fuel_split);`. The early call before `fuel_split` is
resolved (singular degenerate matrix case) passes `null` (falls back to `'gas_only'`
copy — acceptable for a pathological data state).

### Step 10 — Derive `t_outdoor_mean_full_year` from the full `days` array

After `aggregateToDays` returns, compute:

```js
const validTempDays = days.filter(d => !d.missing_weather && !isNaN(d.daily_mean_temp_c));
const tOutdoorMeanFullYear = validTempDays.length > 0
  ? validTempDays.reduce((s, d) => s + d.daily_mean_temp_c, 0) / validTempDays.length
  : null;
```

This uses all whole days (not just filtered regression days), consistent with §4.10's
"across all whole days".

### Step 11 — Add `deriveInternalGains()` helper

Add a private function after the rating helpers:

```js
function deriveInternalGains(supplementaryLoads) {
  if (
    supplementaryLoads?.method === 'regression' &&
    supplementaryLoads?.baseline_kwh_per_day != null
  ) {
    return { w: supplementaryLoads.baseline_kwh_per_day * 1000 / 24, usedFallback: false };
  }
  return { w: 300, usedFallback: true };
}
```

Call after the fit succeeds (htc is non-null). If `usedFallback`, push to `warnings[]`:
```js
"Internal gains estimated using a generic UK fallback value (~300 W) because we couldn't fit your appliance/occupancy baseline from your data. Net_flow estimates may be biased."
```

### Step 12 — Add `computeNetFlow()` helper

Add a private function:

```js
function computeNetFlow(htc, days, solarApertureM2, solarCorrectionApplied,
                        winterSetpointC, tOutdoorMeanFullYear, internalGainsW,
                        boilerEfficiency) {
  if (htc === null || tOutdoorMeanFullYear === null) return { w: null };

  const deltaT = winterSetpointC - tOutdoorMeanFullYear;
  const annualLossKwh = htc * deltaT * 8760 / 1000;

  let annualGasHeatKwh = 0, annualElecHeatKwh = 0, annualSolarKwh = 0;
  for (const d of days) {
    if (d.missing_heating || isNaN(d.daily_heating_kwh)) continue;
    annualGasHeatKwh += d.daily_heating_kwh * boilerEfficiency;
    annualElecHeatKwh += (d.daily_elec_heating_kwh ?? 0);
    if (!d.missing_weather && !isNaN(d.daily_solar_kwh_per_m2) && solarCorrectionApplied && solarApertureM2 !== null) {
      annualSolarKwh += solarApertureM2 * d.daily_solar_kwh_per_m2;
    }
  }
  const annualDeliveredKwh = annualGasHeatKwh + annualElecHeatKwh;
  const annualInternalKwh  = internalGainsW * 8760 / 1000;

  const netFlowKwh = annualLossKwh - annualDeliveredKwh - annualSolarKwh - annualInternalKwh;
  const netFlowW   = netFlowKwh * 1000 / 8760;
  return { w: netFlowW };
}
```

### Step 13 — Add `labelNetFlow()` helper

```js
function labelNetFlow(netFlowW) {
  if (netFlowW === null) return { label: null, warning: null };
  const abs = Math.abs(netFlowW);
  let label, warning = null;
  if (abs < 500) {
    label = 'typical';
  } else if (netFlowW >= 500 && abs <= 2000) {
    label = 'sheltered';
  } else if (netFlowW <= -500 && abs <= 2000) {
    label = 'exposed';
  } else {
    label = netFlowW > 0 ? 'sheltered' : 'exposed';
    warning = `Your home's passive heat flow is unusually large (${netFlowW >= 0 ? '+' : ''}${netFlowW.toFixed(0)} W). This often means the winter setpoint or HTC estimate needs review — double-check the setpoint you entered matches what you actually heat to in winter.`;
  }
  return { label, warning };
}
```

### Step 14 — Add `fit_inputs` subsection and annual elec heating share

After the fit completes and `htc` is computed, derive:

```js
const annualHeatTotal = days.reduce((s, d) => {
  if (d.missing_heating || isNaN(d.daily_heating_kwh)) return s;
  return s + d.daily_heating_kwh * boilerEfficiency + (d.daily_elec_heating_kwh ?? 0);
}, 0);
const elecHeatAnnual = days.reduce((s, d) => {
  if (d.missing_heating || isNaN(d.daily_heating_kwh)) return s;
  return s + (d.daily_elec_heating_kwh ?? 0);
}, 0);
const elecHeatShare = annualHeatTotal > 0 ? elecHeatAnnual / annualHeatTotal : 0;

const fit_inputs = {
  used_elec_heating: useElecHeating && elecHeatingKwhPerDd > 0,
  fuel_split,
  elec_heating_share_annual: elecHeatShare,
};
```

### Step 15 — Remove deprecated floor area CI warning; update return object

Remove the floor area plausibility warning block (currently around lines 352–356 in
`heat-loss.js`).

Update the return object of `estimateHeatLoss` to:
- **Remove:** `htc_correction_w_per_k`, `htc_w_per_k_adjusted`, `hlp_w_per_m2_k`
- **Add:** `fit_inputs`, `winter_setpoint_used_c`, `internal_gains_w_used`,
  `net_flow_w`, `net_flow_label`, `net_flow_warning`, `htc_low_plausibility_callout`

Full return object (success path):

```js
return {
  htc_w_per_k: htc,
  htc_confidence_interval_95: ci,
  fit_inputs,
  rating,
  boiler_efficiency_used: boilerEfficiency,
  winter_setpoint_used_c: winterSetpointC,
  solar_aperture_m2,
  solar_rating,
  solar_correction_applied,
  cooling_consideration,
  degree_day_base_c: HDD_BASE_TEMP,
  regression_r2: r2,
  days_used_in_fit: filtered.length,
  days_excluded: excluded,
  internal_gains_w_used: internalGainsResult.w,
  net_flow_w: netFlow.w,
  net_flow_label: netFlowLabelled.label,
  net_flow_warning: netFlowLabelled.warning,
  htc_low_plausibility_callout: htcLowPlausibilityCallout,
  validation_status,
  warnings,
};
```

All `insufficientDataResult` and early-exit paths must also include the new fields
(null/default values) and omit the removed fields.

### Step 16 — Update `index.html`: boiler dropdown, remove floor area, add winter setpoint

Locate the Heat Loss methodology card in `index.html`. Make three changes:

**a) Replace boiler efficiency input** — change `<input type="number" id="boiler-efficiency">` to:

```html
<select id="boiler-efficiency">
  <option value="0.92">Modern condensing (post-2010)</option>
  <option value="0.85" selected>Older condensing (2005–2010)</option>
  <option value="0.70">Non-condensing</option>
  <option value="0.60">Very old / back boiler</option>
</select>
```

Default is `0.85` (Older condensing) per §5.1 of design doc.

**b) Remove floor area input** — remove the `<label>` + `<input id="floor-area">` block entirely.

**c) Add winter setpoint input** — add `<label>` + `<input type="number" id="winter-setpoint" value="20" min="10" max="28" step="0.5">` with label "Indoor winter temperature (°C)". Position it near the boiler efficiency control.

### Step 17 — Update `app.js`: call site and DOM references

**DOM references** (near line 182): remove `floorAreaInput`. Add `winterSetpointInput` and
update `boilerEfficiencyInput` reference (the DOM element is the same ID; no change
needed to the reference since `select` and `input` both expose `.value`).

**`runHeatLoss` function** (lines 1218–1231): replace the body:

```js
// v1:
const boilerEfficiency = parseFloat(boilerEfficiencyInput.value) || 0.90;
const floorAreaRaw = parseFloat(floorAreaInput.value);
const floorAreaM2 = isNaN(floorAreaRaw) ? null : floorAreaRaw;

// v2:
const boilerEfficiency = parseFloat(boilerEfficiencyInput.value);
  // dropdown always has a valid selection — no fallback needed
const winterSetpointC = parseFloat(winterSetpointInput.value) || 20;
```

Update the `estimateHeatLoss` call to pass `winterSetpointC` in place of `floorAreaM2`.

### Step 18 — Update `displayHeatLossResults` in `app.js`

**Remove the `no_gas` validation_status branch** (lines 1144–1151) — v2 never returns
this status.

**Remove deprecated display rows** in the `rows.push(...)` section:
- `htc_w_per_k_adjusted` row (lines 1184–1186)
- `hlp_w_per_m2_k` row (lines 1188–1190)

**Add new display rows** after the Confidence Range row:
```js
rows.push(['Indoor setpoint used', `${result.winter_setpoint_used_c} °C`]);
if (result.net_flow_label !== null) {
  const nfW = result.net_flow_w !== null ? ` (${result.net_flow_w >= 0 ? '+' : ''}${result.net_flow_w.toFixed(0)} W)` : '';
  rows.push(['Building character', `${result.net_flow_label.charAt(0).toUpperCase() + result.net_flow_label.slice(1)}${nfW}`]);
}
if (result.net_flow_warning) {
  warnings.push(result.net_flow_warning);
}
```

Push `net_flow_warning` to `warnings` before the `result.warnings` loop so it joins the
existing warning rendering flow.

Rename the display label "Summer cooling consideration" → "Summer cooling potential" (§7 7i
of design doc).

### Step 19 — Write `test-m4-v2.mjs`

Create `test-m4-v2.mjs` at repo root. Use the same `assert(condition, id, description)`
+ `passed`/`failed` counter pattern as `test-m6.mjs`.

Build a synthetic data helper that produces N whole days × 48 HH records with fixed
`daily_heating_kwh`, `daily_degree_days`, and `daily_solar_kwh_per_m2` values — making
the OLS recovery analytically predictable (see T1 below for the pattern).

Tests to implement (from design doc §7):

- **T1** — Gas-only baseline: set `classification = 'none'`, zero elec, supply data
  where the true HTC = 200 W/K (α = 200 × 24 / 1000 = 4.8 kWh/K·day). Assert recovered
  HTC ≈ 200 ±15%. Assert `fit_inputs.used_elec_heating = false`.
- **T2** — Mixed-fuel: `classification = 'some'`, `elecKwhPerDd = 0.6`,
  `boilerEfficiency = 0.85`, true HTC = 250 W/K. Assert recovered HTC ≈ 250 ±15%.
  Assert `fit_inputs.fuel_split = 'mixed_fuel'`.
- **T3** — All-electric: `classification = 'all_electric'`, gas heating = 0, elecKwhPerDd
  = 0.8, true HTC = 220 W/K. Assert fit runs (no early return). Assert recovered HTC ≈ 220 ±15%.
- **T4** — Check 4D deleted: assert result does NOT have own property
  `htc_correction_w_per_k` or `htc_w_per_k_adjusted`.
- **T5** — η scaling: identical synthetic data, run twice with `boilerEfficiency = 0.85`
  then `0.70`. Assert `htc_0.70 / htc_0.85 ≈ 0.70 / 0.85` within 0.1%.
- **T6** — Internal-gains Rhiannon example: `supplementaryLoads.method = 'regression'`,
  `baseline_kwh_per_day = 10`. Assert `internal_gains_w_used ≈ 416.67` within 0.1 W.
- **T7** — Internal-gains fallback: `method = 'skipped_insufficient_data'`, `baseline =
  null`. Assert `internal_gains_w_used = 300`. Assert a warning is present.
- **T8** — Net_flow worked example: construct synthetic result inputs matching the design
  doc §4.10 example (HTC = 204, winterSetpointC = 21, t_outdoor_mean_full_year = 12.78°C,
  annualDelivered ≈ 6,967 kWh, annualSolar ≈ 328 kWh, internalGains = 417 W). Assert
  `net_flow_w ≈ 427` within 5 W. Assert `net_flow_label = 'typical'`. For this test,
  call the helper functions directly (export them for testing) or reconstruct their logic
  with a controlled call to `estimateHeatLoss` using matched synthetic day data.
- **T9** — Label boundaries: call `labelNetFlow` (exported for testing) with inputs:
  499, 500, 1999, 2000, 2001, −499, −500, −1999, −2000, −2001. Assert:
  499→typical, 500→sheltered, 1999→sheltered, 2000→sheltered, 2001→sheltered+warning,
  −499→typical, −500→exposed, −1999→exposed, −2000→exposed, −2001→exposed+warning.
- **T10** — All-electric HTC<50: `classification = 'all_electric'`, synthetic data
  producing HTC = 45. Assert `htc_low_plausibility_callout = 'all_electric_dual_handed'`.
  Assert `validation_status = 'poor'`. Assert NO check-4B warning in `result.warnings[]`
  (the callout is a flag, not a Heat Loss card warning for all-electric).
- **T11** — Gas-only HTC<50: `classification = 'none'`, synthetic data producing HTC =
  45. Assert `htc_low_plausibility_callout = 'gas_only'`. Assert a plausibility warning
  in `result.warnings[]`.
- **T12** — Removed fields: assert result does NOT have own property `hlp_w_per_m2_k`.
  Assert `estimateHeatLoss` does not reference `floorAreaM2` (structural: just pass no
  6th arg or `undefined` and confirm no field appears).
- **T13** — Net_flow null on missing temps: supply `external` with all `temp_c = null`.
  Assert `result.net_flow_w = null`. Assert `result.net_flow_label = null`.

Note: export `labelNetFlow` and `deriveInternalGains` from `heat-loss.js` for direct
testing in T9, T6, T7. These are pure helpers with no side effects.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| v1 downstream code reads `htc_w_per_k_adjusted` or `hlp_w_per_m2_k` from the result | Step 18 removes all `displayHeatLossResults` usages. Search `app.js` for any other reads of these fields before commit. |
| `runOLSTwoPredictor` / `runOLSOnePredictor` use `d.daily_heating_kwh` internally — risk of forgetting to update one | Step 5 changes both functions to `d.daily_heat_delivered`. The test T1 (gas-only reduces to v1 behaviour) catches a missed rename. |
| Combined-fuel fit: if `elecHeatingKwhPerDd` is null or undefined (M3 failed Step H), `daily_heat_delivered` would be NaN | Step 2 guards: `elecHeatingKwhPerDd = supplementaryLoads?.electric_heating_kwh_per_dd ?? 0`. Zero is the correct fallback (no elec contribution if not fitted). |
| `t_outdoor_mean_full_year` computed from `days` but `aggregateToDays` is called with different signature — caller mismatch | Step 3 explicitly documents the changed signature; Step 10 is sequential and uses the returned `days` array from Step 3's call. |
| Net_flow sign convention: positive = sheltered, negative = exposed — easy to flip | T9 verifies all 10 boundary cases including sign. Work through manually with the §4.10 formula before coding. |
| `no_gas` validation_status branch in `displayHeatLossResults` removed — if any other code path still emits it, display silently drops to no-op | v2 `heat-loss.js` emits only: `insufficient_data`, `poor`, `acceptable`, `good`. Grep `validation_status` after implementation to confirm no `no_gas` strings remain. |
| Dropdown default `0.85` vs v1 fallback `0.90` — existing users get a lower default | Intentional per INV-12 design. Note in deviations if any divergence occurs. |

---

## Success criteria

- [ ] `test-m4-v2.mjs` runs: T1–T13 all pass (`node test-m4-v2.mjs` exits 0 with 13 ✅)
- [ ] No existing test suites broken: `test-m3-step-f.mjs` 18/18, `test-m5.mjs` 39/39,
  `test-m5b.mjs` 29/29, `test-m6.mjs` 24/24, `test-m7.mjs` 39/39, `test-m8.mjs` 24/24,
  `test-m9.mjs` 24/24 (none of these import `heat-loss.js` directly; passing confirms no
  module-level breakage)
- [ ] `result.htc_w_per_k_adjusted` and `result.hlp_w_per_m2_k` do not appear anywhere
  in the result object (assert via T4 and T12)
- [ ] T8 net_flow worked example: `net_flow_w ≈ 427 W`, `net_flow_label = 'typical'`
  (the key regression showing internal-gains term corrects the v1 +676 W Sheltered misread)
- [ ] All `insufficientDataResult` returns include `net_flow_w: null`, `net_flow_label: null`,
  `htc_low_plausibility_callout: null` (no missing fields that would cause null-deref in app.js)
- [ ] `index.html` validates: boiler efficiency is a `<select>` with 4 options; floor area
  input is absent; winter setpoint input is present
- [ ] `app.js` grep: no remaining reference to `floorAreaM2`, `floorAreaInput`, or
  `htc_w_per_k_adjusted` post-edit
- [ ] Integration-v2 invariant F7 preserved: `result.boiler_efficiency_used` is echoed
  (equal to `boilerEfficiency` input); m5-v2 and m7-v2 will consume this field

---

## Implementation Deviations

**Date:** yyyy-mm-dd
**Commit:** [commit hash]

None.

<!--
The Design Review section is appended by the Opus reviewer when the plan is
amended. See `coding/agents/plan-reviewer.md` for the review record template
and the post-review Status values.

Status values (canonical, from plan-reviewer.md):
- Awaiting review — Opus architect review pending.    (planner sets)
- ✅ Approved — yyyy-mm-dd. Implementation may begin.  (reviewer sets)
- ⚠ Approved with edits — yyyy-mm-dd. Implementation may begin [once <prereq>].
- ⏸ Blocked — yyyy-mm-dd. See Design Review below; rewrite required.
- Implemented — yyyy-mm-dd, commit <hash>.            (implementer sets)
-->
