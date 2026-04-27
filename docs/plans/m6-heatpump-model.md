# Module 6 — Heat Pump Model

**Date:** 2026-04-26
**Status:** ✅ Approved — 2026-04-27
**Depends on:** `docs/plans/m5-thermal-character.md` — must be ✅ Approved AND implemented (committed to main) before M6 implementation begins. M6 consumes `setpoint_c` from `getThermalCharacterResult()` for HP sizing. M6 can be planned now, but coding starts only once M5 is merged.

---

## Task description

Implement `js/heatpump-model.js` — converts heating demand into the parameters M7 needs to
compute electricity consumption under a heat pump: a per-HH COP array (17,520 entries) and
a design heat output (kW). Also produces diagnostic outputs (mean COP, HP sizing,
fraction-below-design-temp) for the "Your Home" panel.

This is parameter generation, not scenario generation. All scenario arithmetic (gas vs HP
vs hybrid, dumb vs smart) lives in M7. M6 has no knowledge of tariff rates or financial
logic.

Add a UI card with the COP scalar slider (range 0.5–1.5, default 1.0) and a recalculate
button. Wire into both Octopus and CSV pipelines after M5.

Design doc: `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/heatpump-model.md`

---

## Research findings

**Upstream contracts confirmed:**

- M2 `externalResult.external[]` — parallel to `heating[]`, contains `temp_c` (null when
  weather data missing).
- M3 `baseloadResult.heating[]` — `{ timestamp, heating_kwh, is_absence }` per HH.
  `baseloadResult.baseload_metadata.method === 'no-gas'` triggers the no-gas branch.
- M4 `getHeatLossResult()` — `{ htc_w_per_k, boiler_efficiency_used, ... }`. `htc_w_per_k`
  is null when M4 had insufficient data.
- M5 `getThermalCharacterResult()` — `{ setpoint_c, ... }` per the M5 plan output spec.
  `setpoint_c` is null when M5 had insufficient sustained heating data.

**No external libraries required.** The COP curve is a 4-anchor piecewise linear function;
interpolation is trivial. Per-HH arithmetic is a single `.map()` over `external[]`.

**Reuse patterns:**
- State management mirrors M4/M5: `let _result = null; export set/get HeatPumpModelResult(r)`.
- Constants block at module top — same style as M4/M5.
- App.js orchestration follows the M4/M5 pattern exactly.

**File naming:** `js/heatpump-model.js` matches the filename listed in `README.md`.

**Algorithm has no ambiguities.** The design doc's Step 2/3/4 are unambiguous:
- COP scalar applied multiplicatively, NOT additively (design doc explicit; T4 catches this)
- T_design = −3.0 °C (BS EN 12831, design doc explicit; T6 catches T_design = 0 mistake)
- Annual mean COP weighted by `heating_kwh`, not by HH count (design doc explicit; T8 catches this)
- COP clamp `[1.0, 6.0]` applied AFTER scaling (design doc explicit; T5 catches this)
- Anchor clamping at temp_c < −15°C and temp_c > 20°C uses the anchor COP value, not extrapolation

**No-gas branch:** the design doc requires that when `method === 'no-gas'`, `cop_by_hh` is
still computed (COP only depends on temperature, not gas data). Only `hp_capacity_kw` and
`annual_mean_cop` become null.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/heatpump-model.js` | Heat pump model computation |
| MODIFY | `js/app.js` | Import, orchestration, UI rendering |
| MODIFY | `index.html` | COP scalar slider + heat pump model card |

---

## Implementation steps

### Step 1 — Create `js/heatpump-model.js`

#### 1a. Module constants

```javascript
const HP_CONFIG = {
  T_DESIGN_C:                -3.0,   // BS EN 12831 / CIBSE TM55 UK design temperature
  COP_CLAMP_MIN:             1.0,    // physically below 1.0 means worse than resistance
  COP_CLAMP_MAX:             6.0,    // beyond commercial ASHP at H4 boundary
  USER_SCALAR_MIN:           0.5,
  USER_SCALAR_MAX:           1.5,
  USER_SCALAR_DEFAULT:       1.0,
  MEAN_COP_LOW_WARN:         2.0,    // warn if annual_mean_cop below this
  BELOW_DESIGN_WARN:         0.05,   // warn if > 5% of heating HH below T_design
  COP_AT_DESIGN_LOW_WARN:    1.5,    // warn if scalar pushes design-temp COP very low
};

// EoH field trial H4 anchor points (base — pre-scaling).
// Order matters for interpolation: ascending by temp_c.
const COP_ANCHORS_BASE = Object.freeze([
  { temp_c: -15, cop: 1.44 },  // extrapolated from EoH slope
  { temp_c:  -3, cop: 2.37 },  // EoH field trial H4 median
  { temp_c:  10, cop: 3.37 },  // EoH field trial H4 median
  { temp_c:  20, cop: 4.14 },  // extrapolated from EoH slope
]);
```

#### 1b. Helper — `clampScalar(value)`

Clamp to `[USER_SCALAR_MIN, USER_SCALAR_MAX]`. Used as a defensive guard at the function
boundary; UI validation is the primary gate.

#### 1c. Helper — `copBaseAt(tempC)`

Pure interpolation on `COP_ANCHORS_BASE` — does NOT apply user scaling or clamp. Logic:

```
if tempC <= COP_ANCHORS_BASE[0].temp_c: return COP_ANCHORS_BASE[0].cop
if tempC >= COP_ANCHORS_BASE[last].temp_c: return COP_ANCHORS_BASE[last].cop

find i such that COP_ANCHORS_BASE[i].temp_c <= tempC < COP_ANCHORS_BASE[i+1].temp_c
let lo = COP_ANCHORS_BASE[i], hi = COP_ANCHORS_BASE[i+1]
let f = (tempC - lo.temp_c) / (hi.temp_c - lo.temp_c)
return lo.cop + f * (hi.cop - lo.cop)
```

Loop is over a 4-element array — no binary search needed.

#### 1d. Helper — `copScaledAt(tempC, scalar)`

```
return clamp(copBaseAt(tempC) * scalar, COP_CLAMP_MIN, COP_CLAMP_MAX)
```

The clamp must be applied AFTER scaling — see design doc §Step 1 anti-pattern note. T5
catches this.

#### 1e. Helper — `buildScaledCopCurvePoints(scalar)`

Map over `COP_ANCHORS_BASE` returning `[{ temp_c, cop: clamp(base × scalar, 1.0, 6.0) }, ...]`.
Always 4 entries. Used for UI display and exposing to M10.

#### 1f. `computeCopByHh(external, scalar)`

```javascript
return external.map(e => e.temp_c === null ? null : copScaledAt(e.temp_c, scalar));
```

Always returns the same length as `external`. Null entries pass through as null. M7 must
handle null entries (skip or fall back to gas).

#### 1g. `computeHpCapacity(htc, setpointC, scalar, warnings)`

```
if htc === null OR setpointC === null:
  return { hp_capacity_kw: null, hp_capacity_kw_elec: null }

if setpointC <= T_DESIGN_C:
  warnings.push("Inferred setpoint ({setpointC}°C) is below the design outdoor "
              + "temperature (−3°C). Check the thermostat setpoint.")
  return { hp_capacity_kw: null, hp_capacity_kw_elec: null }

hp_capacity_kw = htc * (setpointC - T_DESIGN_C) / 1000
copDesign = copScaledAt(T_DESIGN_C, scalar)
hp_capacity_kw_elec = hp_capacity_kw / copDesign
return { hp_capacity_kw, hp_capacity_kw_elec }
```

#### 1h. `computeDiagnostics(external, heating, copByHh)`

Single pass over the parallel arrays:

```
weightedSum = 0
totalWeight = 0
heatingHhCount = 0
belowDesignHeatingCount = 0
copMin = +Infinity
copMax = -Infinity
nonNullCopExists = false

for i in 0..external.length:
  cop = copByHh[i]
  temp = external[i].temp_c
  hkwh = heating[i].heating_kwh
  absent = heating[i].is_absence

  if cop !== null:
    nonNullCopExists = true
    if cop < copMin: copMin = cop
    if cop > copMax: copMax = cop

  if cop !== null AND hkwh !== null AND hkwh > 0 AND !absent:
    weightedSum += hkwh * cop
    totalWeight += hkwh
    heatingHhCount += 1
    if temp !== null AND temp < T_DESIGN_C:
      belowDesignHeatingCount += 1

annual_mean_cop = totalWeight > 0 ? weightedSum / totalWeight : null
fraction_below_design_temp = heatingHhCount > 0 ? belowDesignHeatingCount / heatingHhCount : null
cop_range = nonNullCopExists ? { min: copMin, max: copMax } : null
```

Note: the `is_absence` check applies only to `annual_mean_cop` and
`fraction_below_design_temp`. `cop_range` reflects every non-null cop including absence
days, since absences do not change which COPs were physically possible.

#### 1i. `buildWarnings(annualMeanCop, fractionBelow, scalar, copAtDesign, warnings)`

Append messages per design doc §Step 5:
- `annualMeanCop !== null AND annualMeanCop < MEAN_COP_LOW_WARN`
- `fractionBelow !== null AND fractionBelow > BELOW_DESIGN_WARN`
- `scalar !== 1.0 AND copAtDesign < COP_AT_DESIGN_LOW_WARN`

Format the percentage in the second warning to one decimal place. British English throughout.

#### 1j. `computeValidationStatus(...)`

```
if baseloadMethod === 'no-gas': "no_gas"
else if all temp_c null: "no_temp_data"
else if htc === null: "no_htc"
else if setpointC === null: "no_setpoint"
else: "ok"
```

The `no_temp_data` check requires scanning `external[]` for any non-null `temp_c`. Cheap
short-circuit on first non-null.

#### 1k. Main export `estimateHeatPumpModel(external, heating, heatLoss, thermalCharacter, baseloadMethod, userCopScalar)`

```javascript
export function estimateHeatPumpModel(
  external, heating, heatLoss, thermalCharacter, baseloadMethod, userCopScalar
) {
  const warnings = [];
  const scalar = clampScalar(userCopScalar ?? HP_CONFIG.USER_SCALAR_DEFAULT);

  const htc = heatLoss?.htc_w_per_k ?? null;
  const setpointC = thermalCharacter?.setpoint_c ?? null;

  // Step 0 — validation status (early signal, but we still compute what we can)
  const validation_status = computeValidationStatus(external, baseloadMethod, htc, setpointC);

  // Step 1/2 — COP curve and per-HH array
  const cop_curve_points = buildScaledCopCurvePoints(scalar);
  const cop_at_design_temp = copScaledAt(HP_CONFIG.T_DESIGN_C, scalar);
  const cop_by_hh = computeCopByHh(external, scalar);

  // Step 3 — HP capacity
  const { hp_capacity_kw, hp_capacity_kw_elec } =
    computeHpCapacity(htc, setpointC, scalar, warnings);

  // Step 4 — diagnostics
  const { annual_mean_cop, fraction_below_design_temp, cop_range } =
    computeDiagnostics(external, heating, cop_by_hh);

  // Step 5 — warnings
  buildWarnings(annual_mean_cop, fraction_below_design_temp, scalar, cop_at_design_temp, warnings);

  return {
    cop_by_hh,
    hp_capacity_kw,
    hp_capacity_kw_elec,
    cop_curve_points,
    cop_at_design_temp,
    user_cop_scalar: scalar,
    annual_mean_cop,
    fraction_below_design_temp,
    cop_range,
    design_temp_c: HP_CONFIG.T_DESIGN_C,
    validation_status,
    warnings,
  };
}
```

#### 1l. State management

```javascript
let _heatPumpModelResult = null;
export function setHeatPumpModelResult(r) { _heatPumpModelResult = r; }
export function getHeatPumpModelResult()   { return _heatPumpModelResult; }
```

---

### Step 2 — Modify `index.html`

#### 2a. Heat pump model card (after thermal character card)

```html
<div id="hp-model-card" class="card hidden">
  <h2>Heat Pump Model</h2>

  <div id="hp-model-controls">
    <label for="cop-scalar">COP performance setting:</label>
    <input id="cop-scalar" type="range" min="0.5" max="1.5" step="0.05" value="1.0">
    <output id="cop-scalar-value">1.00</output>
    <p class="control-help">
      1.00 = average UK installed performance (EoH field trial median).
      Adjust to model a higher- or lower-performing unit.
    </p>
  </div>

  <div id="hp-model-results" class="hidden">
    <div id="hp-model-status"></div>
    <dl id="hp-model-summary"></dl>
    <h3>COP at reference temperatures</h3>
    <table id="hp-cop-table">
      <thead><tr><th>Outdoor temperature (°C)</th><th>COP</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <button id="btn-recalculate-hp-model">Recalculate with updated COP setting</button>
</div>
```

The slider's `<output>` updates live as the user drags (no recompute on input — only on
button click, to avoid recomputing 17,520-entry array on every drag tick). A short
input-event listener updates `<output>` text only.

---

### Step 3 — Modify `js/app.js`

#### 3a. Import

```javascript
import {
  estimateHeatPumpModel,
  setHeatPumpModelResult,
  getHeatPumpModelResult,
} from './heatpump-model.js';
```

(Add alongside existing imports for thermal-character.)

#### 3b. DOM refs

```javascript
const hpModelCard         = document.getElementById('hp-model-card');
const hpModelResults      = document.getElementById('hp-model-results');
const hpModelStatus       = document.getElementById('hp-model-status');
const hpModelSummary      = document.getElementById('hp-model-summary');
const hpCopTableBody      = document.querySelector('#hp-cop-table tbody');
const copScalarInput      = document.getElementById('cop-scalar');
const copScalarValue      = document.getElementById('cop-scalar-value');
const btnRecalcHpModel    = document.getElementById('btn-recalculate-hp-model');
```

#### 3c. Live slider value display

```javascript
copScalarInput.addEventListener('input', () => {
  copScalarValue.textContent = parseFloat(copScalarInput.value).toFixed(2);
});
```

#### 3d. `displayHeatPumpModelResults(result)`

Clear status and summary. Show `hpModelResults`. Handle each `validation_status`:

- `"no_temp_data"`: info "Temperature data unavailable — heat pump COP cannot be modelled."
- `"no_gas"`: info "No gas supply detected. COP curve shown for reference; HP sizing
  unavailable without a gas-derived heat loss measurement."
- `"no_htc"` / `"no_setpoint"`: info explaining HP sizing unavailable; COP curve still
  shown.
- `"ok"`: render the full summary.

Numeric rows (skip if value null):
- HP heat output (design conditions, −3°C): `{hp_capacity_kw}` kW
- HP electrical input (design conditions): `{hp_capacity_kw_elec}` kW
- Annual mean COP (demand-weighted): `{annual_mean_cop}`
- COP range across the year: `{cop_range.min} — {cop_range.max}`
- Hours below design temperature: `{fraction_below_design_temp × 100}%` of heating hours
- Design outdoor temperature: −3 °C (BS EN 12831)
- Validation status: `{validation_status}`

COP curve table: render all `cop_curve_points` rows.

Append warnings to `hpModelStatus` as `status-msg warning` divs.

#### 3e. `runHeatPumpModel(showProgressFn, showStatusFn)`

```javascript
async function runHeatPumpModel(showProgressFn, showStatusFn) {
  const externalResult = getExternalResult();
  const baseloadResult = getBaseloadResult();
  const heatLossResult = getHeatLossResult();
  const thermalChar    = getThermalCharacterResult();
  if (!externalResult || !baseloadResult) return;

  showProgressFn('Modelling heat pump performance…');

  const scalar = parseFloat(copScalarInput.value) || 1.0;

  let result;
  try {
    result = estimateHeatPumpModel(
      externalResult.external,
      baseloadResult.heating,
      heatLossResult,
      thermalChar,
      baseloadResult.baseload_metadata.method,
      scalar,
    );
  } catch (err) {
    showStatusFn('Heat pump modelling failed: ' + err.message, 'error');
    console.error('runHeatPumpModel error:', err);
    return;
  }

  setHeatPumpModelResult(result);
  hpModelCard.classList.remove('hidden');
  displayHeatPumpModelResults(result);
}
```

#### 3f. Wire into both pipelines

In `continueWithProperty()`, after the `runThermalCharacter(...)` call:

```javascript
// Step 13: Trigger Module 6 — Heat Pump Model
await runHeatPumpModel(
  (text) => showProgress(text, undefined),
  (msg, type) => showStatus(msg, type)
);
```

In the `btnCsvAnalyse` handler: same, after `runThermalCharacter(...)`.

#### 3g. Recalculate button

```javascript
btnRecalcHpModel.addEventListener('click', async () => {
  btnRecalcHpModel.disabled = true;
  hpModelStatus.innerHTML = '';
  hpModelSummary.innerHTML = '';
  hpCopTableBody.innerHTML = '';
  hpModelResults.classList.add('hidden');
  await runHeatPumpModel(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      hpModelStatus.appendChild(div);
    }
  );
  btnRecalcHpModel.disabled = false;
});
```

When M7–M9 are implemented, the recalculate handler will need to chain those reruns. Out
of scope for M6.

#### 3h. Debug export

```javascript
window.__getHeatPumpModelResult = () => getHeatPumpModelResult();
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Scalar applied additively instead of multiplicatively | Test T4 catches this. Algorithm code uses `* scalar` only — never `+ scalar`. |
| Clamp applied before scaling instead of after | Test T5 catches this. The helper `copScaledAt` is the single point where order matters; test it directly. |
| T_design hardcoded as 0 instead of −3 | Test T10 asserts `design_temp_c === −3.0` AND that the HP capacity formula uses the same constant. Constant lives in `HP_CONFIG.T_DESIGN_C` only. |
| Annual mean COP weighted by HH count instead of heating demand | Test T8 catches this with synthetic data crafted so unweighted vs weighted give different answers. |
| Negative `hp_capacity_kw` from setpoint < T_design | Guard added in `computeHpCapacity` — returns null + warning. T11 catches. |
| Performance: per-HH loop over 17,520 entries on every slider change | Slider input handler only updates `<output>`; recompute only on button click. Single-pass `.map()` and reduce in `computeDiagnostics` are O(n) and well under 50 ms in profile testing on M3/M4 of similar size. |
| `cop_by_hh` length mismatch with `external[]` | Use `.map()` on `external[]` directly — guaranteed parallel. |
| User scalar passed outside [0.5, 1.5] from a non-UI caller | `clampScalar` defensive guard inside `estimateHeatPumpModel`. UI is the primary gate. |

---

## Success criteria

- [ ] **T1 — COP interpolation within range.** `temp_c = 3.5°C`, scalar = 1.0.
  Expected: `COP = 2.37 + (3.5 − (−3)) / 13 × (3.37 − 2.37) = 2.37 + 0.5 = 2.87`.

- [ ] **T2 — COP clamp cold.** `temp_c = −20°C`, scalar = 1.0.
  Expected: COP = 1.44 (clamped to −15 anchor, NOT extrapolated).

- [ ] **T3 — COP clamp warm.** `temp_c = 25°C`, scalar = 1.0.
  Expected: COP = 4.14 (clamped to 20 anchor).

- [ ] **T4 — User scalar multiplicative.** `temp_c = 10°C`.
  scalar = 1.2 → COP = 3.37 × 1.2 = 4.044.
  scalar = 0.8 → COP = 3.37 × 0.8 = 2.696.
  Additive interpretation (3.37 + 0.2 = 3.57) is the failure case.

- [ ] **T5 — Clamp after scaling.** `temp_c = −15°C`, scalar = 0.5.
  `cop_scaled = 1.44 × 0.5 = 0.72` → clamped to 1.0.

- [ ] **T6 — HP capacity units.** `htc = 250`, `setpoint = 20`, scalar = 1.0.
  Expected: `hp_capacity_kw = 5.75`, `cop_at_design_temp = 2.37`,
  `hp_capacity_kw_elec = 5.75 / 2.37 = 2.426` (within 0.01).

- [ ] **T7 — HP capacity null inputs.** `htc = null`. Expected: `hp_capacity_kw = null`,
  `hp_capacity_kw_elec = null`. `cop_by_hh` still populated. `validation_status = "no_htc"`.

- [ ] **T8 — Annual mean COP demand-weighted.** 3 HH periods:
  - HH 0: `temp_c = −3`, `heating_kwh = 2.0` → COP = 2.37
  - HH 1: `temp_c = 10`, `heating_kwh = 0.5` → COP = 3.37
  - HH 2: `temp_c = 10`, `heating_kwh = 0` → excluded

  Expected: `annual_mean_cop = (2.0 × 2.37 + 0.5 × 3.37) / 2.5 = 2.57`.

- [ ] **T9 — `cop_by_hh` null passthrough.** One HH `temp_c = null`. Expected:
  `cop_by_hh[i] = null` for that HH; others unaffected.

- [ ] **T10 — Design temperature constant.** Output `design_temp_c === −3.0`.
  Verify same constant is used in HP-capacity formula and `cop_at_design_temp`.

- [ ] **T11 — Setpoint below design temp.** `setpoint_c = −5°C`. Expected:
  `hp_capacity_kw = null` AND warning surfaced about implausible setpoint.

- [ ] **T12 — EoH anchor regression.** Assert `interpolate(−3, 1.0) === 2.37` and
  `interpolate(10, 1.0) === 3.37` exactly (no floating-point drift at exact anchors).

- [ ] **T13 — Slider live display.** Dragging the slider updates the `<output>` text
  immediately. Recompute only fires on button click.

- [ ] **T14 — Card visibility / British English.** After running full Octopus flow,
  hp-model-card appears. No JS console errors. All user-facing text British English.

- [ ] **T15 — No-gas branch.** CSV with no gas data. Expected: `validation_status = "no_gas"`,
  `cop_by_hh` populated, `hp_capacity_kw = null`, `annual_mean_cop = null` (no heating
  demand to weight by).

- [ ] **T16 — Warning thresholds.** Construct synthetic data such that
  `fraction_below_design_temp = 0.07`. Expected: warning surfaced with "7.0% of heating hours".

---

## Design Review — 2026-04-27

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Review date:** 2026-04-27
**Design doc reviewed:** `heatpump-model.md` (praxis-claude-hub)

---

### What is solid

- **COP model fully specified and anti-patterns explicitly guarded.** The anchor table,
  piecewise interpolation, boundary clamping, multiplicative scalar order, and
  post-scaling clamp are all correct. T4 and T5 are precisely targeted failure cases
  that will catch the two most dangerous implementation errors (additive scalar, wrong
  clamp order).

- **`computeDiagnostics` single-pass logic is correct.** The parallel-array iteration
  accumulates all four accumulators in one pass. `cop_range` correctly uses all non-null
  COP entries (including absence days — the rationale is sound: absences do not change
  which temperatures were physically encountered). `annual_mean_cop` and
  `fraction_below_design_temp` both apply `!absent` — consistent with each other and
  now consistent with the updated design doc.

- **Null propagation is complete.** Every null path (no HTC, no setpoint, no gas,
  no temp data) is traced end-to-end through Step 0 and `computeValidationStatus`.
  `cop_by_hh` is always populated when temperature data exists, regardless of
  HTC/setpoint/gas availability — correct, because M7 needs the COP array independently.

- **`hp_capacity_kw` setpoint guard (`setpointC <= T_DESIGN_C`) is more correct than
  the original design doc edge case table, which said `<`.** Setpoint equal to T_design
  gives 0 kW capacity, which is nonsensical. Plan catches this correctly. Design doc
  updated to `≤` to match.

- **Slider UX pattern is correct.** `<output>` updates on `input`; recompute fires only
  on button click. Avoids 17,520-entry `.map()` on every drag tick.

- **`T_DESIGN_C` in `HP_CONFIG` is the single source.** T10 guards against the constant
  being hardcoded in multiple places. This is the right pattern.

- **`fraction_below_design_temp` absence-filter rationale.** This plan improves on the
  design doc. Absence periods produce frost-protection behaviour: boiler runs at low
  temperatures while the owner is away — unrepresentative of normal heating. Including
  them inflates the cold-weather fraction without informing HP sizing for the household's
  actual usage. Plan's interpretation is the correct one; design doc updated to match.

---

### Design doc corrections made by Opus (not plan deviations)

Two corrections applied to `heatpump-model.md` during this review:

1. **`fraction_below_design_temp` — added `is_absence === false` filter to both
   numerator and denominator of Step 4.** Added rationale (absence = frost-protection,
   unrepresentative of household heating behaviour). Updated the Outputs comment to match.

2. **Setpoint edge case — changed `setpoint_c < T_design` to `setpoint_c ≤ T_design`
   in the Edge Cases table.** Zero capacity is as nonsensical as negative capacity; the
   plan's `<=` guard is the correct implementation.

---

### Minor observations (not blockers)

1. **LOW — No test explicitly covering the `is_absence` filter.**
   T8 validates demand-weighting but its synthetic data has no absent HH periods.
   T16 tests the warning threshold, not the filter itself. Consider adding T17:
   - Set up 4 HH periods where HH 2 has `is_absence = true`, `heating_kwh = 0.5`,
     `temp_c = −5` (below design).
   - Assert that `annual_mean_cop` and `fraction_below_design_temp` are unchanged from
     the 3-period baseline (absent HH excluded from both).
   - Assert that the absent HH's COP still appears in `cop_range.min` (absences
     included in COP range).
   This is an optional but recommended addition; T8 as written is still a valid test.

---

### Clarifications required before implementation

None. The plan is unambiguous and complete.

---

## Approval

**Status:** ✅ Approved — 2026-04-27
**Approved by:** Rhiannon (via Opus review)

No required changes. T17 is a recommended addition but not a condition of approval.

---

## Implementation Deviations

None — implementation not yet started.
