# M7 — Scenario Consumption: Audit and Revised Dispatch

**Date:** 2026-05-07
**Status:** ✅ Approved — implementation may begin. 1 clarification applies (see review below).

---

## Task description

Audit `js/scenario-consumption.js` and the M7 call site in `js/app.js` against the
revised design document `scenario-consumption-revised.md` (commits 6a0d086 + 65ee9d7 in
praxis-claude-hub). Implement all changes needed to bring the code into alignment.
The primary additions are: (1) a τ-based survival filter that makes pre-heat physically
meaningful by limiting look-ahead to one time-constant, (2) a cumulative-storage
constraint (S_max = C × ΔT_max / 3600) that enforces how much heat the building can
hold above setpoint, (3) correcting the `elecHhRateByHh` source (currently raw
wholesale; must be D×W+P from `prepareRates`), (4) exposing `t_max_preheat_offset_c`
as a user-editable input, and (5) a post-hoc RC temperature trace for the `current`
scenario (display only; makes the boiler's reactive pattern visible alongside the smart
HP's proactive pre-heat). Also implements Bug 3 (main-UI surfacing of missing thermal
data) and ensures null smart HP scenarios are visible in the cost display.

---

## Research findings

This is a spec-alignment audit. No external libraries are involved. All algorithms
(greedy LP, RC model, exponential decay) are already in use in the codebase or are
trivial arithmetic. No research phase required.

Existing code reviewed:
- `js/scenario-consumption.js` — full file (312 lines)
- `js/app.js` — M7 call site (lines 1492–1641), `runFinancialAnalysis` (lines 2225–2268),
  `buildAndDisplayVerdict` chart assembly (lines 2177–2219)
- `js/pricing-engine.js` — `prepareRates` output shape (lines 66–188), confirms
  `elec_hh_rate_by_hh` field name and `gas_rate_by_hh` field name
- `test-m7.mjs` — full file (399 lines), current test IDs T1–T18

Key findings:
1. `computeValidationStatusSmart` does not check `thermal_mass_kj_per_k` (checklist item 1).
2. `allocateGreedyDay` has no storage constraint and no survival filter (items 2, 11).
3. `elecHhRateByHh` in `runScenarioConsumption` is built from `external[i].wholesale_p_kwh`
   via `buildRateArrays`; it must instead come from `rateMetadata.elec_hh_rate_by_hh`
   (D×W+P) from `prepareRates` (item 5). `prepareRates` is currently called only in
   `runPricingEngine` which runs after M7.
4. Overshoot threshold is hardcoded `3.0` at `scenario-consumption.js:284` (item 6).
5. `t_max_preheat_offset_c` is not accepted by `estimateScenarioConsumption` and has no
   UI input (items 4, 7).
6. `occupancy_threshold` / `occupancy_weights` are not used in any dispatch logic
   (item 8 already satisfied — no change required).
7. Output shape already has four keys: `current`, `dumb_hp_svt`, `dumb_hp_hh`,
   `smart_hp_hh`. No hybrid keys present (item 10 already satisfied).
8. Bug 3 fix (main-UI notice for missing thermal data) is scoped in
   `docs/debug/2026-05-01-bug-results-display-and-ux.md` and not yet implemented.
9. Null smart HP scenarios: `computeCosts` receives null arrays and treats `null * rate = 0`
   in JS arithmetic, producing spurious standing-charge-only costs. The
   `buildEffectivePricingResult` pattern (already used in `runFinancialAnalysis` for
   HH-insufficient) needs to be extended to cover null smart scenarios and applied in
   both `runPricingEngine` (for display) and `runFinancialAnalysis`.
10. Test T11 currently expects `validation_status.smart = 'ok'` when
    `thermal_mass_kj_per_k = null`. After item 1 is implemented, this becomes
    `'no_thermal_mass'`; T11a–T11c need updating.
11. `current` scenario `indoor_temp_c` is always null (audit item 12 — `simulatePostHocTIndoor`
    not called for current scenario). Must add `simulateCurrentRcTrace` using
    `heating_kwh[i] × η` as input heat, same RC model as §4h. Resets T to `setpoint_c`
    on data gaps (null heating or null temp), unlike `simulatePostHocTIndoor` which carries
    T forward. Runs only when HTC, C, setpoint_c non-null; display only.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/scenario-consumption.js` | Items 1–4, 6, 11, 12: validation status, allocateGreedyDay, buildSmartScenario, estimateScenarioConsumption, overshoot threshold, current-scenario RC trace |
| MODIFY | `js/app.js` | Items 5, 7–9: prepareRates in M7 call site; t_max DOM refs + event wiring; Bug 3 main-UI notice; buildEffectivePricingResult helper; chart null handling |
| MODIFY | `index.html` | Item 7: t-max-preheat range input in scenario card |
| MODIFY | `test-m7.mjs` | Update T11; add T19–T25 |

---

## Implementation steps

### Step 1 — `computeValidationStatusSmart`: add thermal mass check, rename 'no_htc'

Current (`scenario-consumption.js:204–208`):
```js
function computeValidationStatusSmart(heatLoss, heatPumpModel) {
  if (heatLoss?.htc_w_per_k == null)         return 'insufficient_data';
  if (heatPumpModel?.hp_capacity_kw == null) return 'insufficient_data';
  return 'ok';
}
```

Replace with:
```js
function computeValidationStatusSmart(heatLoss, heatPumpModel, thermalCharacter) {
  if (heatLoss?.htc_w_per_k == null)                      return 'no_htc';
  if (heatPumpModel?.hp_capacity_kw == null)              return 'insufficient_data';
  if (thermalCharacter?.thermal_mass_kj_per_k == null)    return 'no_thermal_mass';
  return 'ok';
}
```

Update both call sites in `estimateScenarioConsumption` (two calls — Step 0 early exit and
the main smart-status check) to pass `thermalCharacter` as the third argument.

### Step 2 — `allocateGreedyDay`: add survival filter and storage constraint

This is the core algorithm change. The function gains two new parameters (`tau` and
`S_max_kwh`) and two new internal computations (demand array, d_next array,
survivalEligible array, max_addable_at helper).

**2a. New parameters:**
```js
function allocateGreedyDay({
  dayIndices, heating, eta, copByHh, gasRateByHh, elecHhRateByHh,
  hpCapKw, isAbsence, demandScale = 1.0,
  tau,        // hours — thermal time constant; non-null when smart runs
  S_max_kwh,  // kWh — max pre-heat storage budget above setpoint
}) {
```

**2b. Precompute demand array** (replaces the inline B_d accumulation):
```js
const n = dayIndices.length;
const demand = new Array(n);
for (let t = 0; t < n; t++) {
  const i = dayIndices[t];
  const h = heating[i].heating_kwh;
  demand[t] = (!isAbsence[i] && h != null && h > 0) ? h * eta * demandScale : 0;
}
let B_d = 0;
for (const d of demand) B_d += d;
```

**2c. Precompute d_next and survivalEligible:**
```js
// d_next[t] = local index of nearest subsequent demand slot (n = Infinity if none)
const d_next = new Array(n).fill(Infinity);
for (let t = n - 2; t >= 0; t--) {
  d_next[t] = (demand[t + 1] > 0) ? t + 1 : d_next[t + 1];
}

// survival_eligible[t] true when non-demand slot t can reach next demand in ≤ 2τ HH
// threshold: exp(−n_gap×0.5/τ) ≥ exp(−1)  ↔  n_gap×0.5/τ ≤ 1  ↔  n_gap ≤ 2τ
const survivalEligible = new Array(n).fill(false);
for (let t = 0; t < n; t++) {
  if (demand[t] > 0) continue;                  // demand slots handled separately
  const n_gap = d_next[t] - t;
  if (n_gap === Infinity) continue;             // no subsequent demand — no pre-heat value
  survivalEligible[t] = (n_gap * 0.5 / tau) <= 1;
}
```

**2d. max_addable_at helper** (inner function, O(n) forward scan):
```js
function max_addable_at(s, q_delivered, demand, S_max_kwh) {
  let cum = 0;
  for (let t = 0; t <= s; t++) cum += q_delivered[t] - demand[t];
  let headroom = S_max_kwh - cum;
  for (let t = s + 1; t < n; t++) {
    cum += q_delivered[t] - demand[t];
    headroom = Math.min(headroom, S_max_kwh - cum);
  }
  return Math.max(0, headroom);
}
```

**2e. Updated slot eligibility filter** — replace the existing `if (hpCost === Infinity) continue;` section:
```js
const slots = [];
for (let t = 0; t < n; t++) {
  const i       = dayIndices[t];
  const cop     = copByHh[i];
  const elecRate = elecHhRateByHh[i];
  if (cop == null || elecRate == null) continue;
  if (demand[t] === 0 && !survivalEligible[t]) continue;  // survival filter
  if (isAbsence[i]) continue;
  const unitCost = elecRate / cop;
  slots.push({ t, i, unitCost, capI: cap });
}
```

**2f. Updated greedy fill** — add storage headroom alongside capacity headroom:
```js
for (const s of slots) {
  if (remaining <= 0) break;
  const cap_headroom     = s.capI - q_delivered[s.t];
  const storage_headroom = max_addable_at(s.t, q_delivered, demand, S_max_kwh);
  const add = Math.min(remaining, cap_headroom, storage_headroom);
  if (add > 0) {
    q_delivered[s.t] += add;
    elec_kwh_alloc[s.t] = q_delivered[s.t] / copByHh[s.i];
    remaining -= add;
  }
}
```

Note: `q_delivered` is now a local array tracking running allocations per slot (used by
`max_addable_at` on subsequent iterations). The outer array `q_delivered_thermal_kwh`
in the return object is the same reference.

**2g. Rename internal arrays for clarity:** `q_delivered` replaces the existing per-slot
tracking; the return object key `q_delivered_thermal_kwh` is preserved (no downstream
changes needed).

### Step 3 — `buildSmartScenario`: accept thermal params, compute τ and S_max

```js
function buildSmartScenario({
  heating, external, copByHh, hpCapKw,
  gasRateByHh, elecHhRateByHh, eta, isAbsence, demandScale = 1.0,
  htc,         // W/K — required; non-null when called (computeValidationStatusSmart guards)
  thermalMass, // kJ/K — required; same guard
  tMaxPreheat, // °C — default 3.0
}) {
  const tau      = thermalMass * 1000 / (htc * 3600);          // hours
  const S_max    = thermalMass * tMaxPreheat / 3600;            // kWh
  ...
  const day = allocateGreedyDay({
    dayIndices: indices, heating, eta,
    copByHh, gasRateByHh, elecHhRateByHh, hpCapKw, isAbsence, demandScale,
    tau, S_max_kwh: S_max,
  });
```

### Step 4 — `estimateScenarioConsumption`: add `t_max_preheat_offset_c` parameter, wire through

Add parameter to the destructured input (default 3.0):
```js
export function estimateScenarioConsumption({
  heating, external, heatLoss, thermalCharacter, heatPumpModel,
  baseloadMethod, gasRateByHh, elecHhRateByHh,
  comfort_demand_scale,
  t_max_preheat_offset_c = 3.0,
}) {
```

Pass `thermalCharacter` to both `computeValidationStatusSmart` call sites:
```js
// Step 0 early exit:
validation_status: { dumb: 'no_data', smart: computeValidationStatusSmart(heatLoss, heatPumpModel, thermalCharacter) },

// Main check:
let smartStatus = computeValidationStatusSmart(heatLoss, heatPumpModel, thermalCharacter);
```

Pass thermal params to `buildSmartScenario`:
```js
const sm = buildSmartScenario({
  heating, external, copByHh, hpCapKw: hpCap,
  gasRateByHh, elecHhRateByHh, eta, isAbsence, demandScale,
  htc:         heatLoss.htc_w_per_k,
  thermalMass: thermalCharacter.thermal_mass_kj_per_k,
  tMaxPreheat: t_max_preheat_offset_c,
});
```

### Step 5 (in scenario-consumption.js) — Overshoot threshold: use `t_max_preheat_offset_c`

At `scenario-consumption.js:284`, change:
```js
return t > thermalCharacter.setpoint_c + 3.0;
```
to:
```js
return t > thermalCharacter.setpoint_c + t_max_preheat_offset_c;
```

`t_max_preheat_offset_c` is in scope as a parameter of `estimateScenarioConsumption`.

### Step 5a (in scenario-consumption.js) — Current scenario RC trace (audit item 12)

Add `simulateCurrentRcTrace` as a new module-level function. Key difference from
`simulatePostHocTIndoor`: resets T to `setpoint_c` on data gaps (null heating or null
temp) rather than carrying T forward. This is correct for the `current` scenario because
a null heating entry represents a metering gap — the building's true state is unknown
and setpoint is the least-bad assumption.

```js
function simulateCurrentRcTrace({ heating, external, heatLoss, thermalChar }) {
  const htc = heatLoss?.htc_w_per_k;
  const C   = thermalChar?.thermal_mass_kj_per_k;
  const eta = heatLoss?.boiler_efficiency_used ?? 0.9;
  const sp  = thermalChar?.setpoint_c;
  if (htc == null || C == null || sp == null) return heating.map(() => null);

  const R = (heatLoss?.solar_correction_applied && heatLoss?.solar_aperture_m2 != null)
    ? heatLoss.solar_aperture_m2 : 0;
  const out = new Array(heating.length);
  let T = sp;
  for (let i = 0; i < heating.length; i++) {
    const h  = heating[i].heating_kwh;
    const tc = external[i]?.temp_c;
    if (h == null || tc == null) {
      out[i] = null;
      T = sp;    // reset to setpoint on data gap
      continue;
    }
    const Q_current    = h * eta;
    const heatLossKwh  = htc * (T - tc) * 0.5 / 1000;
    const solarGainKwh = R * (external[i]?.solar_w_m2 ?? 0) * 0.5 / 1000;
    const dT = (Q_current + solarGainKwh - heatLossKwh) * 3600 / C;
    T += dT;
    out[i] = T;
  }
  return out;
}
```

In `estimateScenarioConsumption`, after `buildCurrentScenario` (before Step 3 dumb HP
computation):
```js
const current = buildCurrentScenario(heating);
// Step 2a — current scenario RC trace (display only; no effect on costs)
current.indoor_temp_c = simulateCurrentRcTrace({
  heating, external, heatLoss, thermalChar: thermalCharacter,
});
```

`buildCurrentScenario` initialises `indoor_temp_c` to `heating.map(() => null)`. This
line replaces it with the computed trace, or leaves it all-null if preconditions are not
met (HTC/C/setpoint missing). No other code paths need updating — `indoor_temp_c` on
the `current` scenario is display-only and not consumed by M8 or M9.

---

### Step 6 — `app.js`: replace `buildRateArrays` with `prepareRates` in `runScenarioConsumption`

In `runScenarioConsumption` (around line 1596), replace:
```js
const { gasRateByHh, elecHhRateByHh } = buildRateArrays(
  ingestion.consumption, externalResult.external, ingestion.tariff_rates);
```
with:
```js
const agileCalibration = externalResult.external_metadata?.agile_calibration ?? null;
const rateParamsForM7  = { ...readRateParams(), agile_calibration: agileCalibration };
const rateMetadataForM7 = prepareRates(ingestion, externalResult.external, rateParamsForM7);
setRateMetadata(rateMetadataForM7);
const gasRateByHh    = rateMetadataForM7.gas_rate_by_hh;
const elecHhRateByHh = rateMetadataForM7.elec_hh_rate_by_hh;
```

Add `t_max_preheat_offset_c` to the `estimateScenarioConsumption` call:
```js
result = estimateScenarioConsumption({
  ...existing params...,
  t_max_preheat_offset_c: parseFloat(tMaxPreheatInput?.value) || 3.0,
});
```

Update `btnRecalcScenario.addEventListener` to chain M7→M8→M9 (currently runs M7 only):
```js
btnRecalcScenario.addEventListener('click', async () => {
  btnRecalcScenario.disabled = true;
  // ... existing status clear ...
  await runScenarioConsumption(...);
  await runPricingEngine(() => {}, () => {});
  await runFinancialAnalysis(() => {}, () => {});
  btnRecalcScenario.disabled = false;
});
```

Note: `runPricingEngine` already calls `prepareRates` and sets `rateMetadata`. The
second call in M8 is safe (idempotent with same inputs) and preserves M8's independence.

### Step 7 — `index.html`: add t-max-preheat slider in scenario card

After the closing `</div>` of `heat-to-comfort-group` (line ~358), insert:
```html
<div class="form-group" id="t-max-preheat-group">
  <label for="t-max-preheat">Maximum pre-heat above setpoint
    <span class="unit">°C</span>
  </label>
  <input id="t-max-preheat" type="range" min="0" max="8" step="0.5" value="3">
  <output id="t-max-preheat-value">3.0</output>
  <p class="form-hint">
    How far above your thermostat setpoint the smart HP can pre-heat.
    Higher values allow more heat to be shifted to cheap overnight slots.
  </p>
</div>
```

### Step 8 — `app.js`: DOM refs and live display for t-max-preheat

Add DOM refs (near existing `heatToComfortSlider` refs around line 266):
```js
const tMaxPreheatInput  = document.getElementById('t-max-preheat');
const tMaxPreheatOutput = document.getElementById('t-max-preheat-value');
```

Wire live display (near existing `heatToComfortSlider` input handler):
```js
tMaxPreheatInput.addEventListener('input', () => {
  tMaxPreheatOutput.value = parseFloat(tMaxPreheatInput.value).toFixed(1);
});
```

No auto-recalculate on slider move — the existing "Recalculate scenarios" button
(now updated in Step 6 to chain M7→M8→M9) is the trigger.

### Step 9 — `app.js`: Bug 3 — surface missing thermal data on main UI

In `displayThermalCharResults` (around line 1260–1370): after detecting
`result.thermal_mass_source === 'no_data'` or `result.validation_status === 'insufficient_data'`,
push a notice to `#status-details` and open the methodology disclosure:
```js
if (result.thermal_mass_source === 'no_data' || result.validation_status === 'insufficient_data') {
  const noticeDiv = document.createElement('div');
  noticeDiv.className = 'status-msg warning';
  noticeDiv.textContent = 'Your thermal mass estimate could not be determined from your data. '
    + 'Open "Show methodology" → Thermal character and enter values manually to improve accuracy.';
  statusDetails.appendChild(noticeDiv);
  if (methodologyDisclosure) {
    methodologyDisclosure.removeAttribute('hidden');
    methodologyDisclosure.open = true;
  }
}
```

Locate `statusDetails` (the main `#status-details` element) — verify the DOM ref name
in the existing codebase. If not already declared, add `const statusDetails = document.getElementById('status-details');`.

Apply the same pattern in `displayHeatLossResults` for M4 `insufficient_data`.

### Step 10 — `app.js`: `buildEffectivePricingResult` helper and null smart override

Extract the existing inline HH-insufficient override in `runFinancialAnalysis` (lines
2244–2257) into a named helper that also covers null smart scenarios:

```js
function buildEffectivePricingResult(pricingResult, scenarioResult, rateMetadata) {
  const cal          = getExternalResult()?.external_metadata?.agile_calibration;
  const fraction     = cal?.null_wholesale_fraction ?? 0;
  const calSrc       = rateMetadata?.calibration_source ?? 'fetched';
  const hhInsufficient = calSrc !== 'default' && fraction > HH_COVERAGE_INSUFFICIENT_THRESHOLD;
  const smartNotOk   = !['ok', 'hp_undersized'].includes(
    scenarioResult?.validation_status?.smart
  );
  if (!hhInsufficient && !smartNotOk) return pricingResult;

  const newScenarios = { ...pricingResult.scenarios };
  if (hhInsufficient) {
    newScenarios.dumb_hp_hh  = { ...newScenarios.dumb_hp_hh,  annual_cost_gbp: null };
    newScenarios.smart_hp_hh = { ...newScenarios.smart_hp_hh, annual_cost_gbp: null };
  }
  if (smartNotOk) {
    newScenarios.smart_hp_hh = { ...newScenarios.smart_hp_hh, annual_cost_gbp: null };
  }
  return { ...pricingResult, scenarios: newScenarios };
}
```

Use this helper:
- In `runPricingEngine`: `displayPricingResults(buildEffectivePricingResult(pricingResult, getScenarioConsumptionResult(), rateMetadata));`
- In `runFinancialAnalysis`: replace the inline hhInsufficient block with `const effectivePricingResult = buildEffectivePricingResult(pricingResult, scenarioResult, rateMetadata);`

### Step 11 — `app.js`: verdict chart — show labelled entry for null smart HP

In `buildAndDisplayVerdict` (line ~2178), the chart currently filters out null-cost
scenarios. Replace with a pattern that includes all four scenarios but renders null-cost
ones as grey labelled entries:

```js
const chartData = scenarioOrder.map(k => ({
  key:       k,
  label:     VERDICT_CHART_LABELS[k],
  cost:      financialResult.scenarios[k].annual_cost_gbp,  // null for unavailable
  saving:    financialResult.scenarios[k].annual_saving_gbp,
}));

const bgColors = chartData.map(d =>
  d.cost === null ? '#CCCCCC'
  : d.key === 'current' ? '#26588D'
  : (d.saving > 0 ? '#3B8284' : '#FD7A7F')
);

// datasets.data: null values render the y-axis label but no bar in Chart.js 4
datasets: [{ data: chartData.map(d => d.cost), backgroundColor: bgColors }]
```

Update the tooltip callback:
```js
label: ctx => ctx.raw === null
  ? 'Data unavailable'
  : `£${Math.round(ctx.parsed.x).toLocaleString('en-GB')}/yr`,
```

### Step 12 — `test-m7.mjs`: update T11 and add T19–T23

**Update T11** (thermal_mass=null):
- T11a: expect `validation_status.smart === 'no_thermal_mass'` (was `'ok'`)
- T11b: expect `smart.elec_kwh[0] === null` (was `> 0`; dispatch no longer runs)
- T11c: expect smart `gas_kwh` and `elec_kwh` all null (arrays are null-filled)
- T11d: dumb scenarios computed — unchanged ✓

Also update `buildInputs` helper: the existing `thermalCharacterOverride` path allows
passing `thermal_mass_kj_per_k: null`; also add `t_max_preheat_offset_c` to the
destructured inputs for tests that need it.

**Add T19 — storage constraint enforced** (design doc T6):
Setup: C=5000 kJ/K, HTC=200 W/K, t_max=3°C → S_max=4.17 kWh; B_d=12 kWh (demand
uniform in slots 32–47, 0.75 kWh thermal each); cheap rate 8p in slots 4–11, 30p
elsewhere; cop=3, hp_cap=8 kW.
Assert: `Σ Q_delivered_thermal[4..11] ≤ 4.17 kWh` (storage constraint binds).
Derivation: `Q_thermal[i] = smart.elec_kwh[i] × cop`.

**Add T20 — ΔT_max flow-through** (design doc T7 — mandatory regression test):
Setup: C=5000 kJ/K, HTC=200 W/K (τ≈6.94h); morning demand only: slots 12–15, 0.8 kWh
heating each (B_d = 4 × 0.72 = 2.88 kWh); cheap 8p slots 0–11, expensive 30p slots 12–47;
cop=3, hp_cap=10 kW.
Run twice: `t_max_preheat_offset_c = 1.0` (S_max≈1.39 kWh — binding) and `5.0`
(S_max≈6.94 kWh — non-binding).
Cost proxy: `Σ smart.elec_kwh[i] × elecRates[i]`.
Assert: `costAt5 < costAt1`.
Derivation: at t_max=5°C, all 2.88 kWh fits in cheap slots (8p); at t_max=1°C, storage
limits pre-heat to 1.39 kWh in cheap slots, remainder at 30p.

**Add T21 — absence excluded from B_d and Q_delivered** (design doc T10):
Setup: 1-day, heating 1.0 kWh every slot; `is_absence=true` for slots 16–35.
Assert: smart `Q_delivered[16..35] = 0`; total allocated ≈ B_d computed over non-absent
heating slots only (28 slots × 0.9 = 25.2 kWh).

**Add T22 — survival filter: 8h vs 2h house** (design doc T15):
Setup: morning demand only at slots 12–15, 0.5 kWh thermal each (B_d=2.0 kWh); cheap
8p slots 0–11, expensive 20p slots 12–47; cop=3, hp_cap=8 kW.
With τ=8h (C=5760 kJ/K, HTC=200 W/K, S_max=5760×3/3600=4.8 kWh):
  Assert: `Σ smart.elec_kwh[0..11] × cop > 0` (pre-heat uses cheap overnight).
With τ=2h (C=1440 kJ/K, HTC=200 W/K, S_max=1440×3/3600=1.2 kWh):
  Assert: `smart.elec_kwh[0..7]` all 0 (overnight ineligible: n_gap 12..5, all > 4).
  Assert: `Σ smart.elec_kwh[8..11] × cop > 0` (slots 8–11 eligible: n_gap 4).

**Add T23 — survival filter: boundary precision** (design doc T16):
Setup: τ=4h (C=2880 kJ/K, HTC=200 W/K); demand only at slot 20 (3.0 kWh heating,
B_d=2.7 kWh); cheap 5p slots 0–19, expensive 30p slots 20–47; cop=3, hp_cap=10 kW.
d_next[0..19] = 20; n_gap for slot 12 = 8 (8×0.5/4=1 ≤ 1 → eligible);
n_gap for slot 11 = 9 (9×0.5/4=1.125 > 1 → ineligible).
Assert: `Q_delivered_thermal[12] > 0` (at-threshold slot receives pre-heat).
Assert: `Q_delivered_thermal[11] = 0` (just-beyond slot excluded by survival filter).

**Add T24 — current scenario RC trace shape** (design doc T17):
Setup: HTC=200, C=5000, setpoint_c=19, temp_c=5, R=0, η=0.9; 1-day (48 HH);
`heating_kwh=0` for HH 0–11 and 16–47; `heating_kwh=0.5` for HH 12–15.
Assert: `current.indoor_temp_c[11] < 19` (building cooled below setpoint with no heat).
Assert: `current.indoor_temp_c[15] > current.indoor_temp_c[11]` (temp rises when boiler fires).
Assert: all `dumb_hp_svt.indoor_temp_c` entries null (dumb scenarios unaffected).

**Add T25 — current scenario RC trace null when HTC missing** (design doc T18):
Setup: same as T24 but with `htc_w_per_k = null`.
Assert: all `current.indoor_temp_c` entries null.
Assert: dumb and smart scenarios computed normally (HTC null blocks RC trace only).

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `prepareRates` called twice per M7+M8 pipeline run (M7 call site + M8) | Idempotent with same inputs; O(n) cost negligible. Preserves M8 independence. |
| `max_addable_at` O(n) per slot → O(n²) per day | n=48, so O(2304) per day: ≤ 365×2304 ≈ 840k ops total — negligible for browser JS |
| `btnRecalcScenario` now chains M7→M8→M9; existing `heat-to-comfort` slider used same button expecting M7 only | Correct behaviour: heat-to-comfort changes demand which propagates to costs; M8+M9 should also update. No regression. |
| Chart.js null data: tooltip `ctx.parsed.x` undefined/NaN when `ctx.raw === null` | Guard with `ctx.raw === null` before `ctx.parsed.x`. Tested manually. |
| `buildEffectivePricingResult` duplicates HH-insufficient logic previously inline | The helper replaces the inline block in `runFinancialAnalysis` entirely; no duplication remains. |
| T11b/T11c assertions inverted — could mask regression if smart ran when it shouldn't | T11a (validation_status check) and T11b (elec_kwh null) together verify both smart status and that dispatch was skipped. |
| Survival filter excludes all pre-heat slots on days with no subsequent demand (summer) | Covered by existing `B_d = 0` path (Step 0); only allocation skipped, not an error. |
| `simulateCurrentRcTrace` reset-on-gap differs from `simulatePostHocTIndoor` carry-forward | Intentional per spec: null heating = metering gap, unknown building state → setpoint reset is safer than propagating stale T. Document in function comment. |

---

## Success criteria

### Automated tests

- [ ] All existing tests T1–T18 continue to pass
- [ ] T11a: `validation_status.smart === 'no_thermal_mass'` when `thermal_mass_kj_per_k = null`
- [ ] T11b: `smart_hp_hh.elec_kwh[0] === null` when thermal_mass null
- [ ] T11c: all smart gas_kwh and elec_kwh entries null when thermal_mass null
- [ ] T11d: dumb scenarios computed normally when thermal_mass null
- [ ] T19: `Σ Q_delivered_thermal[cheap_slots] ≤ S_max` (storage constraint enforced)
- [ ] T20 (MANDATORY): `cost(t_max=5°C) < cost(t_max=1°C)` — ΔT_max flow-through verified
- [ ] T21: absence HH excluded from B_d; Q_delivered=0 for absence slots
- [ ] T22: τ=8h → cheap overnight slots used; τ=2h → overnight ineligible, only 04:00–06:00 window
- [ ] T23: slot at exact exp(−1) threshold eligible; slot one beyond ineligible
- [ ] T24: current scenario indoor_temp_c drifts downward when no heat, rises when boiler fires; dumb scenarios unaffected (remain null)
- [ ] T25: current scenario indoor_temp_c all null when HTC=null; dumb and smart unaffected

### Browser / structural

- [ ] `t-max-preheat` slider present in scenario card; live output display updates on drag
- [ ] Changing `t_max_preheat_offset_c` and clicking "Recalculate scenarios" re-runs M7→M8→M9 and updates cost/payback display
- [ ] `elecHhRateByHh` passed to smart dispatch is `rateMetadata.elec_hh_rate_by_hh` (D×W+P), not raw wholesale — verify via agile-rate-robustness T8 (peak premium respected): `Σ Q_delivered[32..37] ≈ 0` on Rhiannon's data (peak avoided)
- [ ] When `thermal_mass_kj_per_k = null` (M5 insufficient data): smart HP shows `—` in pricing table
- [ ] Verdict bar chart includes "Smart heat pump — half-hourly tariff" label even when cost is null (grey / no bar)
- [ ] Main-UI notice pushed to status area when M5 returns `thermal_mass_source = 'no_data'` or `validation_status = 'insufficient_data'`; methodology disclosure auto-opens
- [ ] Same notice for M4 `insufficient_data`
- [ ] No new console errors
- [ ] No items deferred — all functionality specified in this plan is delivered

---

## Approval

**Status:** ✅ Approved — Rhiannon (via Opus review, 2026-05-07)

---

## Claude.ai Review — 2026-05-07

**Reviewer:** Claude (Praxis Insight — Opus architect window)

**Overall verdict:** Approved with 1 clarification

### What is solid

- **Approach correct.** Approach challenge performed: all three root causes addressed directly — wrong rate array (buildRateArrays → prepareRates), no storage constraint (S_max via max_addable_at), no horizon limit (survival filter via τ). No symptom-treatment or parallel computation concerns.
- **Algorithm verified.** τ units (kJ/K → hours), S_max units (kJ/K × °C / 3600 = kWh), survival condition (n_gap × 0.5 / τ ≤ 1 ↔ exp(−n_gap × 0.5 / τ) ≥ exp(−1)), max_addable_at forward scan — all correct on units and logic.
- **Test arithmetic spot-checked.** T20: S_max binding at 1°C (1.39 kWh < B_d 2.88 kWh), non-binding at 5°C (6.94 kWh > 2.88 kWh) — cost ordering correct. T22: τ=2h → slot 8 eligible (n_gap=4, exactly at threshold), slot 7 ineligible (n_gap=5). T23: τ=4h → slot 12 eligible (n_gap=8, at threshold), slot 11 ineligible (n_gap=9). ✓
- **Design alignment complete.** All 12 audit checklist items addressed across the 12 implementation steps.
- **Risk table thorough.** Dual prepareRates call (idempotent), O(n²)/day acceptable, T11 assertion inversion, reset-vs-carry-forward in simulateCurrentRcTrace, buildEffectivePricingResult duplication elimination all noted and mitigated.
- **No deferrals.** Day-view charts are explicitly out of scope (separate plan after M7 lands), not a deferral of in-scope work. ✓

### Clarifications required before implementation

**C1. `setRateMetadata` in Step 6 — verify setter pattern before writing code.**

The plan calls `setRateMetadata(rateMetadataForM7)` as a named function. In `app.js`, `rateMetadata` is likely a module-level `let` assigned directly (e.g. `rateMetadata = rateMetadataForM7`), with no named setter. If the function does not exist, the call fails silently or throws.

**Resolution:** At the start of Step 6, search `app.js` for how `rateMetadata` is currently assigned after M8 runs. If a named setter exists, use it. If not, use direct assignment. Do not assume either pattern — verify first.

### Minor observations (not blockers)

- **Session sizing.** 12 steps across 4 files exceeds the >8-step threshold. `app.js` carries 5 independent concerns in Steps 6–11 (prepareRates wiring, recalc chaining, Bug 3, buildEffectivePricingResult, chart null handling). Risk of context exhaustion mid-session. Recommended checkpoint: commit after Steps 1–5a (`scenario-consumption.js` complete, tests updated) before starting `app.js` changes.
- **Test ID mapping.** Design doc T17/T18 renumbered to T24/T25 in this plan due to existing test file using T17/T18. Design doc corrected to match. No action needed.
- **"No items deferred" success criterion added** (see below).

---

## Approval

**Status:** ✅ Approved — implementation may begin. 1 clarification applies (see review below).
**Approved by:** Rhiannon (via Opus review)

**Clarifications confirmed:**
- C1: Before writing Step 6, verify whether `rateMetadata` is assigned via a named setter or direct assignment in `app.js`. Use whichever pattern is established.

---

## Implementation Deviations

*(To be completed after implementation.)*
