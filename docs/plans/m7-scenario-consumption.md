# Module 7 — Scenario Consumption

**Date:** 2026-04-26
**Status:** ⚠ Approved with edits — 2026-04-27
**Depends on:**
- `docs/plans/m5-thermal-character.md` — must be ✅ Approved AND merged. M7 reads
  `setpoint_c`, `thermal_mass_kj_per_k`, `occupancy_weights`.
- `docs/plans/m6-heatpump-model.md` — must be ✅ Approved AND merged. M7 reads
  `cop_by_hh`, `hp_capacity_kw`.

---

## Task description

Implement `js/scenario-consumption.js` — produces per-HH gas and electricity arrays for all
six comparison scenarios:
- `current` (observed boiler)
- `dumb_hp_svt` and `dumb_hp_hh` (HP fires on the same HH periods as the boiler did)
- `hybrid_dumb` (per-HH cheaper-fuel dispatch)
- `smart_hp_hh` (RC + DP pre-heating optimiser)
- `hybrid_smart` (RC + DP with per-HH HP/gas dispatch)

This module contains **all scenario logic — no financial calculation**. The Pricing Engine
(M8) applies tariff rates downstream to produce costs.

Wire it into `app.js` after M6 in both pipelines, with sliders for `t_max_preheat_offset_c`
and `occupancy_threshold` plus a recalculate button. Build the per-HH gas and HH-wholesale
electricity rate arrays in an app-level helper (M8 will reuse them).

Design doc: `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/scenario-consumption.md`

---

## Research findings

**Upstream contracts confirmed against live code and prior plans:**

- M2 `external[i]` — has `temp_c`, `solar_w_m2`, `wholesale_p_kwh`. All can be null per HH;
  `wholesale_p_kwh` was confirmed by inspection of `external-data.js:349`.
- M3 `baseloadResult.heating[i]` — `{ heating_kwh, is_absence, ... }`.
  `baseload_metadata.method === 'no-gas'` triggers the no-gas branch.
- M4 `getHeatLossResult()` — `{ htc_w_per_k, boiler_efficiency_used,
  solar_aperture_m2, solar_correction_applied, ... }`.
- M5 `getThermalCharacterResult()` — `{ setpoint_c, thermal_mass_kj_per_k,
  occupancy_weights, ... }` per the M5 plan.
- M6 `getHeatPumpModelResult()` — `{ cop_by_hh, hp_capacity_kw, ... }` per the M6 plan.
- M1 `getIngestionResult().tariff_rates` — `{ electricity: [...], gas: [...] }`. Each
  window has `{ valid_from, valid_to, rate_p_kwh, ... }` (confirmed against
  `data-ingestion.js`).

**No external libraries required.** DP is a hand-written 2D table with 365 × 49 × 15
entries per scenario. The design doc's complexity estimate (~4 M evaluations per smart
scenario, ~8 M total for both smart scenarios) sits well under 1 s in modern browsers.

**Reuse patterns:**
- State management mirrors M4/M5/M6: `setScenarioConsumptionResult` /
  `getScenarioConsumptionResult`.
- Day grouping by `timestamp.slice(0, 10)` — same as M5 `buildDaySummaries`.
- Constants block at module top — same style as previous modules.

**Memory:** per-day DP tables are 49 × 15 × 3 = 2,205 cells; allocate fresh per day and
discard after backtrack. Do NOT keep 365 days of tables in memory simultaneously.

**Filename:** `js/scenario-consumption.js` (matches the design doc module name). The
README's older `thermal-sim.js` label is stale — RC simulation now lives inside
scenario-consumption per the current design.

---

## Scope decisions / clarifications flagged for review

These are pre-emptive interpretations of design-doc ambiguity. If any are wrong, the plan
should be revised before implementation.

1. **Wholesale rate "overhead".** The design doc declares `elec_hh_rate_by_hh` as
   "HH wholesale + overhead" but does not define the overhead. **I propose using
   `external[i].wholesale_p_kwh` directly with no overhead** for M7. M8 will own retail-
   rate construction (markup, capacity charges) and can rebuild the rate array if needed.
   The marginal effect on hybrid dispatch is small — markup of e.g. +5 p/kWh shifts the
   HP/gas crossover by a few p/kWh_heat in either direction.

2. **`validation_status.dumb = "partial"` trigger.** Design doc lists "partial" as a
   value but does not define when to emit it. **I propose: "partial" if ≥ 5% of heating
   HH (heating_kwh > 0) had null `cop_by_hh` and fell back to gas in the dumb_hp arrays.**
   "ok" otherwise. "no_data" when heating_kwh is all null.

3. **DP infeasibility relaxation.** Design doc §5d says "relax the comfort constraint,
   re-run, warn." **I propose: relaxation drops the
   `if occupied[t] AND T_next < T_setpoint: continue` gate entirely for that day,
   leaving capacity and T_max_preheat gates intact.** Warning issued once per affected day.

4. **DST / non-48-HH days.** Design doc §Edge Cases says "Skip DP for that day; carry
   T_indoor unchanged." **I propose: detect non-48-HH days at day-grouping time, mark
   them in `dayMeta`, set elec/gas/indoor_temp = null for all their HH, advance T_init
   unchanged.** Smart scenarios only — dumb scenarios are unaffected (per-HH arithmetic).

5. **Day-chaining T_init when a day is non-heating or skipped.** **I propose: T_init
   passes through unchanged across non-heating days and skipped days.** This matches the
   design doc's degree-hour skip rule for non-heating days.

6. **DP backtrack uses discretised T_states, not interpolated values.** The
   `indoor_temp_c[i]` written into the output is `T_states[path[t+1]]` — i.e., a value
   from the discrete grid. Design doc accepts this discretisation. The `T_init_next_day`
   is also a grid value.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/scenario-consumption.js` | Six-scenario consumption arrays + RC + DP |
| MODIFY | `js/app.js` | Rate-array builder, orchestration, UI rendering |
| MODIFY | `index.html` | Smart-scenario controls + scenario summary card |

---

## Implementation steps

### Step 1 — Create `js/scenario-consumption.js`

#### 1a. Module constants

```javascript
const SC_CONFIG = {
  T_MAX_PREHEAT_OFFSET_DEFAULT: 2.0,    // °C above setpoint
  OCCUPANCY_THRESHOLD_DEFAULT:  0.5,    // weight ≥ this → occupied
  N_STATES:                     15,     // DP state grid resolution
  T_RANGE_BELOW_SETPOINT:       1.0,    // grid extends 1°C below setpoint
  NON_HEATING_DAY_DD_HOURS:     0.5,    // < this → skip DP for the day
  PARTIAL_DUMB_THRESHOLD:       0.05,   // ≥5% gas-fallback → "partial"
  PREHEAT_OFFSET_HIGH_WARN_C:   4.0,    // warn if user offset > this
  COLD_HOURS_WARN_FRACTION:     0.05,   // warn if >5% heating HH below T_design
};
```

#### 1b. Helper — `buildDayHhIndices(heating)`

Group `heating[]` indices by `timestamp.slice(0, 10)`. Return an ordered array of
`{ date: 'YYYY-MM-DD', indices: number[] }` sorted by date. Days with non-48 indices
remain in the returned array but flagged with `skipDp: true`.

#### 1c. Helper — `discretiseStates(setpointC, tMaxPreheatC, nStates)`

Returns `T_states` — a Float64Array of length `nStates` from
`setpointC − T_RANGE_BELOW_SETPOINT` to `tMaxPreheatC` inclusive, evenly spaced.

#### 1d. Helper — `nearestStateIndex(value, T_states)`

Linear scan (15-element array — no binary search needed). Returns the index of
`T_states` nearest to `value`. Used for chaining day d's end-state to day d+1's start.

#### 1e. Helper — `computeStepEnergetics(tCur, tempC, htc, C, R, solarWm2)`

Returns `{ heatLossKwh, solarGainKwh }` for a single HH transition starting at `tCur`.
Both pieces depend only on the starting indoor temperature and outdoor conditions, so
they can be reused across all candidate `s_next` transitions (15× speedup vs computing
per-transition).

```
heatLossKwh  = htc × (tCur − tempC) × 0.5 / 1000
solarGainKwh = R × solarWm2 × 0.5 / 1000        // 0 if R = 0 or solarWm2 null
```

#### 1f. Helper — `requiredQDelivered(tCur, tNext, C, heatLossKwh, solarGainKwh)`

Inverts the RC equation to find heat input required to move from `tCur` → `tNext`:

```
delta_T = tNext − tCur
Q_delivered_kwh = delta_T × C / 3600 + heatLossKwh − solarGainKwh
```

The `× C / 3600` converts kJ/K × K → kWh. Critical: missing `/ 3600` yields kJ in
place of kWh (factor 3,600 error). T8 catches this. Returns the required Q in kWh
(may be negative — caller decides feasibility).

#### 1g. `buildCurrentScenario(heating)`

```javascript
return {
  gas_kwh: heating.map(h => h.heating_kwh),  // null passes through
  elec_kwh: heating.map(h => h.heating_kwh === null ? null : 0),
  indoor_temp_c: heating.map(() => null),
};
```

`elec_kwh` mirrors gas null pattern so downstream null handling stays uniform.

#### 1h. `buildDumbHpScenario(heating, copByHh, eta)`

Returns the dumb_hp arrays (consumed by both `dumb_hp_svt` and `dumb_hp_hh`). Tracks
gas-fallback fraction for the validation status.

```javascript
let nHeatingHh = 0;
let nFallbackHh = 0;
const gas_kwh = new Array(heating.length);
const elec_kwh = new Array(heating.length);

for (let i = 0; i < heating.length; i++) {
  const h = heating[i].heating_kwh;
  const cop = copByHh[i];
  if (h === null) { gas_kwh[i] = null; elec_kwh[i] = null; continue; }
  if (h === 0)    { gas_kwh[i] = 0; elec_kwh[i] = 0; continue; }
  nHeatingHh += 1;
  if (cop === null) {
    gas_kwh[i] = h; elec_kwh[i] = 0;
    nFallbackHh += 1;
  } else {
    gas_kwh[i] = 0;
    elec_kwh[i] = h * eta / cop;
  }
}

return { gas_kwh, elec_kwh, indoor_temp_c: heating.map(() => null),
         _diagnostics: { nHeatingHh, nFallbackHh } };
```

The `_diagnostics` object is a private-by-convention prefix (underscore) used only by the
top-level orchestrator to compute `validation_status.dumb`. Strip before returning.

#### 1i. `buildHybridDumbScenario(heating, copByHh, eta, gasRateByHh, elecHhRateByHh)`

Per-HH cheaper-fuel dispatch:

```javascript
for (let i = 0; i < heating.length; i++) {
  const h = heating[i].heating_kwh;
  if (h === null) { gas_kwh[i] = null; elec_kwh[i] = null; continue; }
  if (h === 0)    { gas_kwh[i] = 0; elec_kwh[i] = 0; continue; }
  const cop = copByHh[i];
  const gasRate = gasRateByHh[i];
  const elecRate = elecHhRateByHh[i];

  if (cop === null || elecRate === null || gasRate === null) {
    // Cannot price one side — fall back to gas
    gas_kwh[i] = h; elec_kwh[i] = 0;
    continue;
  }

  const hpUnitCost  = elecRate / cop;     // p per kWh of heat via HP
  const gasUnitCost = gasRate / eta;      // p per kWh of heat via gas

  if (hpUnitCost < gasUnitCost) {
    gas_kwh[i] = 0;
    elec_kwh[i] = h * eta / cop;
  } else {
    gas_kwh[i] = h;
    elec_kwh[i] = 0;
  }
}
```

`indoor_temp_c` all null. `eta` MUST appear in the gas unit cost (T3 catches its omission).

#### 1j. Smart scenario DP — single-day solver

`runDpForDay({ dayIndices, params, scenario, T_init })` returns:

```
{
  q_delivered_kwh: number[],   // 48 entries
  fuel_mode: ('hp' | 'gas')[], // 48 entries; 'hp' for smart_hp_hh always
  indoor_temp_c: number[],     // 48 entries (T_states values)
  T_init_next: number,         // discretised T_states value at end of day
  feasible: boolean,           // false → relaxation was applied
}
```

`params` carries: `T_setpoint, T_max_preheat, htc, C, R, eta, hp_capacity_kw, occupied[],
external[], copByHh, gasRateByHh, elecHhRateByHh, T_states`.

**Forward DP (per HH t in 0..47):**

```
for each reachable s in 0..N_STATES-1:
  T_cur = T_states[s]
  i = dayIndices[t]
  tempC = external[i].temp_c
  if tempC === null: skip this HH — carry state unchanged (handled below)

  // Compute once per (t, s)
  { heatLossKwh, solarGainKwh } = computeStepEnergetics(T_cur, tempC, htc, C, R, external[i].solar_w_m2)

  for each s_next in 0..N_STATES-1:
    T_next = T_states[s_next]
    Q = requiredQDelivered(T_cur, T_next, C, heatLossKwh, solarGainKwh)
    if Q < 0: continue                                  // can't actively cool
    if Q > hp_capacity_kw * 0.5: continue               // capacity gate
    if occupied[t] AND T_next < T_setpoint: continue    // comfort gate (relaxable)
    if T_next > T_max_preheat: continue                 // upper thermal gate

    if scenario === 'smart_hp_hh':
      if copByHh[i] === null: continue
      stepCost = (Q / copByHh[i]) * elecHhRateByHh[i]
      fuel = 'hp'
    else: // hybrid_smart
      hpCost = (copByHh[i] !== null AND elecHhRateByHh[i] !== null)
                 ? (Q / copByHh[i]) * elecHhRateByHh[i] : Infinity
      gasCost = (gasRateByHh[i] !== null) ? (Q / eta) * gasRateByHh[i] : Infinity
      if hpCost === Infinity AND gasCost === Infinity: continue
      if hpCost <= gasCost: stepCost = hpCost; fuel = 'hp'
      else:                 stepCost = gasCost; fuel = 'gas'

    candidate = dpCost[t][s] + stepCost
    if candidate < dpCost[t+1][s_next]:
      dpCost[t+1][s_next] = candidate
      dpPrev[t+1][s_next] = s
      dpFuel[t+1][s_next] = fuel
```

**`temp_c === null` HH handling:** force a no-cost identity transition `s_next = s`
(state carries forward, Q = 0, fuel = previous-step fuel or 'hp' default). This avoids
breaking the chain.

**Feasibility check + relaxation:** after the forward pass, find `s_final = argmin
dpCost[48][s]`. If `dpCost[48][s_final] === Infinity`, the day is infeasible. Re-run the
DP for this day with the comfort gate dropped (`occupied[t] AND T_next < T_setpoint`
check skipped). Set `feasible = false` and emit a once-per-day warning at the
orchestrator level.

**Backtrack:** walk `dpPrev` from `s_final` down to t = 0. For each consecutive pair,
re-derive Q (clamp `max(0, Q)` for rounding), populate the result arrays. T_init_next
is `T_states[s_final]`.

#### 1k. `buildSmartScenario(scenario, heating, external, copByHh, hpCapKw, ratesContext, smartParams)`

Top-level loop over days. For each day:
- Skip if `dayMeta.skipDp` (non-48-HH): set arrays to null for that day's HH, advance
  `T_init` unchanged.
- Compute `daily_degree_hours = sum(max(0, T_setpoint − temp_c[i]) × 0.5)` over the 48 HH.
  If < `NON_HEATING_DAY_DD_HOURS`: set elec/gas/indoor to 0/0/null for the day, advance
  `T_init` unchanged. Emit no warning (this is normal summer behaviour).
- Otherwise call `runDpForDay`. Write the day's 48 entries into the output arrays.
  Propagate `T_init_next`.

`T_init` for day 0 is `T_setpoint` (per design doc §5b).

Returns `{ gas_kwh, elec_kwh, indoor_temp_c, infeasibleDays: number }`.

#### 1l. Validation status

```
function computeValidationStatusDumb(dumbDiagnostics, baseloadMethod) {
  if (baseloadMethod === 'no-gas' || dumbDiagnostics.nHeatingHh === 0) return 'no_data';
  const fallbackFrac = dumbDiagnostics.nFallbackHh / dumbDiagnostics.nHeatingHh;
  return fallbackFrac >= SC_CONFIG.PARTIAL_DUMB_THRESHOLD ? 'partial' : 'ok';
}

function computeValidationStatusSmart(heatLoss, thermalChar) {
  if (heatLoss?.htc_w_per_k == null) return 'no_htc';
  if (thermalChar?.thermal_mass_kj_per_k == null) return 'no_thermal_mass';
  if (thermalChar?.setpoint_c == null) return 'no_setpoint';
  if (thermalChar?.occupancy_weights == null) return 'insufficient_data';
  return 'ok';
}
```

Order matters for smart — check HTC first per design doc §Step 0.

#### 1m. Main export

```javascript
export function estimateScenarioConsumption({
  heating, external, heatLoss, thermalCharacter, heatPumpModel,
  baseloadMethod, gasRateByHh, elecHhRateByHh,
  tMaxPreheatOffsetC = SC_CONFIG.T_MAX_PREHEAT_OFFSET_DEFAULT,
  occupancyThreshold = SC_CONFIG.OCCUPANCY_THRESHOLD_DEFAULT,
}) {
  const warnings = [];
  const eta = heatLoss?.boiler_efficiency_used ?? 0.9;
  const copByHh = heatPumpModel?.cop_by_hh ?? new Array(heating.length).fill(null);

  // Step 0 — early "no_data" path
  if (baseloadMethod === 'no-gas' || heating.every(h => h.heating_kwh === null)) {
    const nullArr = () => heating.map(() => null);
    const nullScenario = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
    return {
      scenarios: { current: nullScenario, dumb_hp_svt: nullScenario, dumb_hp_hh: nullScenario,
                   hybrid_dumb: nullScenario, smart_hp_hh: nullScenario, hybrid_smart: nullScenario },
      validation_status: { dumb: 'no_data', smart: computeValidationStatusSmart(heatLoss, thermalCharacter) },
      warnings: ['No gas heating detected — heat pump scenarios cannot be modelled against an existing gas baseline.'],
    };
  }

  // Step 2–4: dumb scenarios
  const current     = buildCurrentScenario(heating);
  const dumbHp      = buildDumbHpScenario(heating, copByHh, eta);
  const hybridDumb  = buildHybridDumbScenario(heating, copByHh, eta, gasRateByHh, elecHhRateByHh);

  const dumbDiagnostics = dumbHp._diagnostics;
  delete dumbHp._diagnostics;

  // Step 5: smart scenarios (skipped if smart not OK)
  const smartStatus = computeValidationStatusSmart(heatLoss, thermalCharacter);
  let smartHpHh, hybridSmart;
  if (smartStatus === 'ok') {
    const smartParams = {
      T_setpoint: thermalCharacter.setpoint_c,
      T_max_preheat: thermalCharacter.setpoint_c + tMaxPreheatOffsetC,
      htc: heatLoss.htc_w_per_k,
      C: thermalCharacter.thermal_mass_kj_per_k,
      R: heatLoss.solar_correction_applied ? (heatLoss.solar_aperture_m2 ?? 0) : 0,
      eta,
      hp_capacity_kw: heatPumpModel?.hp_capacity_kw ?? Infinity,
      occupied: thermalCharacter.occupancy_weights.map(w => w >= occupancyThreshold),
    };
    if (tMaxPreheatOffsetC > SC_CONFIG.PREHEAT_OFFSET_HIGH_WARN_C) {
      warnings.push(`Pre-heat offset of ${tMaxPreheatOffsetC.toFixed(1)} °C is unusually wide; the DP grid resolution becomes coarser.`);
    }

    smartHpHh   = buildSmartScenario('smart_hp_hh',   heating, external, copByHh,
                                     smartParams.hp_capacity_kw, { gasRateByHh, elecHhRateByHh }, smartParams);
    hybridSmart = buildSmartScenario('hybrid_smart',  heating, external, copByHh,
                                     smartParams.hp_capacity_kw, { gasRateByHh, elecHhRateByHh }, smartParams);

    if (smartHpHh.infeasibleDays > 0 || hybridSmart.infeasibleDays > 0) {
      warnings.push(`HP appears undersized for ${Math.max(smartHpHh.infeasibleDays, hybridSmart.infeasibleDays)} day(s) of extreme cold — comfort constraint relaxed for those days.`);
    }
    delete smartHpHh.infeasibleDays;
    delete hybridSmart.infeasibleDays;
  } else {
    const nullArr = () => heating.map(() => null);
    smartHpHh   = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
    hybridSmart = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
  }

  // Shared reference per design doc §Outputs
  return {
    scenarios: {
      current,
      dumb_hp_svt: dumbHp,
      dumb_hp_hh: dumbHp,        // SAME reference, intentional
      hybrid_dumb: hybridDumb,
      smart_hp_hh: smartHpHh,
      hybrid_smart: hybridSmart,
    },
    validation_status: {
      dumb: computeValidationStatusDumb(dumbDiagnostics, baseloadMethod),
      smart: smartStatus,
    },
    warnings,
  };
}
```

#### 1n. State management

```javascript
let _scenarioConsumptionResult = null;
export function setScenarioConsumptionResult(r) { _scenarioConsumptionResult = r; }
export function getScenarioConsumptionResult()   { return _scenarioConsumptionResult; }
```

---

### Step 2 — Modify `js/app.js`

#### 2a. Imports

```javascript
import {
  estimateScenarioConsumption,
  setScenarioConsumptionResult,
  getScenarioConsumptionResult,
} from './scenario-consumption.js';
```

#### 2b. Rate-array builder (private helper)

```javascript
// Build per-HH gas and HH-wholesale electricity rate arrays.
// Indexed parallel to ingestion.consumption[] / external[].
function buildRateArrays(consumption, external, tariffRates) {
  const n = consumption.length;
  const gasRateByHh = new Array(n);
  const elecHhRateByHh = new Array(n);

  // Sort gas tariff windows once for reverse-walk lookup
  const gasWindows = [...tariffRates.gas].sort((a, b) =>
    new Date(a.valid_from) - new Date(b.valid_from));

  for (let i = 0; i < n; i++) {
    const ts = consumption[i].timestamp;
    const tsDate = new Date(ts);

    // Find the gas window covering this timestamp
    let gasRate = null;
    for (const w of gasWindows) {
      if (new Date(w.valid_from) > tsDate) break;
      if (!w.valid_to || new Date(w.valid_to) > tsDate) gasRate = w.rate_p_kwh;
    }
    gasRateByHh[i] = gasRate;
    elecHhRateByHh[i] = external[i]?.wholesale_p_kwh ?? null;
  }

  return { gasRateByHh, elecHhRateByHh };
}
```

(Linear scan for the gas window is fine — typically 1–4 windows per dataset.)

This helper will be reused by M8.

#### 2c. DOM refs

```javascript
const scenarioCard          = document.getElementById('scenario-card');
const scenarioResults       = document.getElementById('scenario-results');
const scenarioStatus        = document.getElementById('scenario-status');
const scenarioSummary       = document.getElementById('scenario-summary');
const preheatOffsetInput    = document.getElementById('preheat-offset');
const preheatOffsetValue    = document.getElementById('preheat-offset-value');
const occupancyThresholdInput = document.getElementById('occupancy-threshold');
const occupancyThresholdValue = document.getElementById('occupancy-threshold-value');
const btnRecalcScenario     = document.getElementById('btn-recalculate-scenario');
```

#### 2d. Live slider value display

```javascript
preheatOffsetInput.addEventListener('input', () => {
  preheatOffsetValue.textContent = parseFloat(preheatOffsetInput.value).toFixed(1);
});
occupancyThresholdInput.addEventListener('input', () => {
  occupancyThresholdValue.textContent = parseFloat(occupancyThresholdInput.value).toFixed(2);
});
```

#### 2e. `displayScenarioResults(result)`

Clear status and summary. For each scenario, compute annual totals:

```javascript
function totalKwh(arr) {
  let s = 0;
  for (const v of arr) if (v !== null) s += v;
  return s;
}
```

Render a table with rows per scenario and columns: gas (kWh/yr), elec (kWh/yr), notes.
Notes column shows the validation status when relevant
(`smart_hp_hh: insufficient_data` etc.).

If `validation_status.dumb === 'no_data'`: render an info-only message; no table rows.

Append warnings to `scenarioStatus`.

#### 2f. `runScenarioConsumption(showProgressFn, showStatusFn)`

```javascript
async function runScenarioConsumption(showProgressFn, showStatusFn) {
  const ingestion       = getIngestionResult();
  const externalResult  = getExternalResult();
  const baseloadResult  = getBaseloadResult();
  const heatLossResult  = getHeatLossResult();
  const thermalChar     = getThermalCharacterResult();
  const hpModel         = getHeatPumpModelResult();
  if (!ingestion || !externalResult || !baseloadResult || !hpModel) return;

  showProgressFn('Computing scenarios (this is the longest step)…');

  // Yield to the browser before the DP-heavy step so the progress message paints
  await new Promise(r => setTimeout(r, 0));

  const { gasRateByHh, elecHhRateByHh } = buildRateArrays(
    ingestion.consumption, externalResult.external, ingestion.tariff_rates);

  const tMaxPreheatOffsetC = parseFloat(preheatOffsetInput.value) || 2.0;
  const occupancyThreshold = parseFloat(occupancyThresholdInput.value) || 0.5;

  let result;
  try {
    result = estimateScenarioConsumption({
      heating: baseloadResult.heating,
      external: externalResult.external,
      heatLoss: heatLossResult,
      thermalCharacter: thermalChar,
      heatPumpModel: hpModel,
      baseloadMethod: baseloadResult.baseload_metadata.method,
      gasRateByHh, elecHhRateByHh,
      tMaxPreheatOffsetC, occupancyThreshold,
    });
  } catch (err) {
    showStatusFn('Scenario computation failed: ' + err.message, 'error');
    console.error('runScenarioConsumption error:', err);
    return;
  }

  setScenarioConsumptionResult(result);
  scenarioCard.classList.remove('hidden');
  displayScenarioResults(result);
}
```

#### 2g. Wire into both pipelines

In `continueWithProperty()`, after `runHeatPumpModel(...)`:

```javascript
// Step 14: Trigger Module 7 — Scenario Consumption
await runScenarioConsumption(
  (text) => showProgress(text, undefined),
  (msg, type) => showStatus(msg, type)
);
```

Same in `btnCsvAnalyse` handler after `runHeatPumpModel(...)`.

#### 2h. Recalculate button

```javascript
btnRecalcScenario.addEventListener('click', async () => {
  btnRecalcScenario.disabled = true;
  scenarioStatus.innerHTML = '';
  scenarioSummary.innerHTML = '';
  scenarioResults.classList.add('hidden');
  await runScenarioConsumption(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      scenarioStatus.appendChild(div);
    }
  );
  btnRecalcScenario.disabled = false;
});
```

When M8/M9 are implemented, this handler will chain their reruns. Out of scope for M7.

#### 2i. Debug export

```javascript
window.__getScenarioConsumptionResult = () => getScenarioConsumptionResult();
window.__buildRateArrays = (cs, ex, tr) => buildRateArrays(cs, ex, tr);
```

---

### Step 3 — Modify `index.html`

Add a new card after the heat-pump-model card:

```html
<div id="scenario-card" class="card hidden">
  <h2>Scenario Consumption</h2>

  <div id="scenario-controls">
    <label for="preheat-offset">Pre-heat ceiling above setpoint:</label>
    <input id="preheat-offset" type="range" min="0.5" max="5.0" step="0.5" value="2.0">
    <output id="preheat-offset-value">2.0</output>
    <span class="control-unit">°C</span>

    <label for="occupancy-threshold">Occupancy threshold:</label>
    <input id="occupancy-threshold" type="range" min="0.1" max="0.9" step="0.05" value="0.50">
    <output id="occupancy-threshold-value">0.50</output>

    <p class="control-help">
      Pre-heat ceiling caps how much the smart scenarios may overshoot the setpoint to
      bank cheap-rate heat. The occupancy threshold sets which HH slots are treated as
      "must be at setpoint" based on your observed heating pattern.
    </p>
  </div>

  <div id="scenario-results" class="hidden">
    <div id="scenario-status"></div>
    <h3>Annual heating energy by scenario</h3>
    <table id="scenario-summary">
      <thead><tr><th>Scenario</th><th>Gas (kWh/yr)</th><th>Electricity (kWh/yr)</th><th>Notes</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <button id="btn-recalculate-scenario">Recalculate scenarios</button>
</div>
```

Costs are deliberately NOT shown here — that is M8's job.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Missing `× 3600` in RC delta_T (factor 3,600 error in temperature dynamics) | Centralised in `requiredQDelivered` helper. T8 catches this directly with non-trivial delta_T. |
| η omitted in dumb HP elec calc | Test T1 (`heating_kwh=1, η=0.9, COP=3 → 0.30`); η omitted yields 0.333. |
| η omitted in hybrid gas cost | Test T3 with crossover-near setup catches dispatch boundary error. |
| η applied twice (e.g. on both gas→thermal and gas→cost) | Test T1 also catches this (would yield 0.27). Single-pass dumb HP arithmetic; η appears exactly once. |
| Day chaining lost (T_init resets each day) | Test T9 — verify day 2 inits at day 1's end-state nearest grid point, not at T_setpoint. |
| Comfort constraint not enforced | Test T7. Unit tests on `runDpForDay` should also assert the gate fires. |
| DP table memory blow-up across 365 days | Allocate per-day, discard after backtrack. Per-day tables are ~2k floats — negligible. |
| Slow DP causing UI freeze | Deliberate `await new Promise(r => setTimeout(r, 0))` before DP starts so the progress message paints. Single-day DP is ~10 ms; full year ~1s tops. |
| Infeasible DP day silently produces non-physical path | Check `dpCost[48][s_final] === Infinity`; relax comfort + warn. |
| Non-48-HH (DST) days silently corrupt indices | `buildDayHhIndices` flags `skipDp: true` for any day not exactly 48 HH; smart loop respects that flag. |
| `dumb_hp_svt` and `dumb_hp_hh` accidentally diverge | They are the SAME object reference (`scenarios.dumb_hp_hh = dumbHp`); tested in T13. |
| User sets `tMaxPreheatOffsetC = 0` (no pre-heat headroom) | DP still runs — grid is just narrower. Smart effectively becomes "match current". Acceptable. |

---

## Success criteria

- [ ] **T1 — Dumb HP unit conversion.** `heating_kwh=1.0, η=0.9, cop=3.0`.
  Expected: `elec_kwh = 0.30`. Verify T8 fail modes (`0.333` if η missing; `0.27` if η doubled).

- [ ] **T2 — Dumb HP null COP fallback.** `heating_kwh=1.5, cop=null`.
  Expected: `gas_kwh=1.5, elec_kwh=0`.

- [ ] **T3 — Hybrid dispatch HP wins.** `h=1.0, η=0.9, cop=3.5, elec_rate=10, gas_rate=7`.
  Expected: HP selected, `elec_kwh=0.257, gas_kwh=0`. Without η in gas cost the boundary
  shifts.

- [ ] **T4 — Hybrid dispatch gas wins.** Same parameters, `elec_rate=30`.
  Expected: gas selected, `gas_kwh=1.0, elec_kwh=0`.

- [ ] **T5 — RC steady state.** T=19, temp=5, HTC=200, C=10000, R=0, Q=1.4.
  Expected: T_next = 19.0 °C exactly.

- [ ] **T6 — RC non-trivial delta_T.** T=17, temp=5, HTC=200, C=10000, Q=2.0.
  Expected: T_next = 17.288 °C. Missing × 3600 fails this catastrophically.

- [ ] **T7 — DP comfort gate.** Free electricity, all HH occupied. Expected: every
  backtracked HH has `T_indoor ≥ T_setpoint`.

- [ ] **T8 — DP pre-heating cost reduction.** 1-day setup with 02:00–06:00 cheap rate
  (2 p) and 06:00–22:00 expensive (30 p), occupied from 07:00. Expected:
  `smart_hp_hh` total cost (elec_kwh × elec_rate per HH) is strictly less than
  `dumb_hp_hh` priced under the same rate schedule.

- [ ] **T9 — Day chaining.** 2 consecutive days, day 1 forced to end at T = 17.5 °C.
  Expected: day 2's `dpCost[0][s]` equals 0 only at the state nearest 17.5 °C, not at
  the state nearest T_setpoint.

- [ ] **T10 — Non-heating day skipped.** Day with all `temp_c = 22 °C`. Expected:
  all 48 HH `gas_kwh = elec_kwh = 0`, `indoor_temp_c = null`, no DP run, T_init carries.

- [ ] **T11 — Null-upstream passthrough.** `thermal_mass_kj_per_k = null`. Expected:
  `validation_status.smart = "no_thermal_mass"`; smart arrays all null; dumb scenarios
  computed normally.

- [ ] **T12 — Current scenario unchanged.** `current.gas_kwh[i] === heating_kwh[i]` for
  all i; `current.elec_kwh[i] === 0` (or null if heating_kwh null).

- [ ] **T13 — dumb_hp_svt and dumb_hp_hh shared reference.**
  `result.scenarios.dumb_hp_svt === result.scenarios.dumb_hp_hh` (object identity).

- [ ] **T14 — DST / non-48-HH day.** Inject a 47-HH day (spring-forward) and a 49-HH
  day (autumn back). Expected: smart arrays are null for those days' HH; T_init
  unchanged across them.

- [ ] **T15 — Validation `partial`.** Construct dumb_hp where 8% of heating HH have
  null COP. Expected: `validation_status.dumb = "partial"`.

- [ ] **T16 — DP infeasible day relaxation.** Construct a day where comfort cannot be
  maintained (e.g. very low T_init, low HP capacity, all HH occupied). Expected:
  forward DP first pass is infeasible; relaxation drops comfort gate; result returned;
  warning surfaced.

- [ ] **T17 — UI controls live.** Dragging either slider updates its `<output>` text.
  Recompute fires only on button click.

- [ ] **T18 — Card visibility, British English, no console errors.** End-to-end
  Octopus pipeline run produces a populated scenario card; no JS errors.

---

## Design Review — 2026-04-27

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Review date:** 2026-04-27
**Design doc reviewed:** `scenario-consumption.md` (praxis-claude-hub)

---

### Scope decisions — accepted as stated

All six pre-emptive interpretations in "Scope decisions / clarifications flagged for review" are
correct. Formally accepted:

1. **Wholesale overhead:** use `external[i].wholesale_p_kwh` directly; M8 owns retail markup. ✓
2. **"partial" trigger:** ≥ 5% of heating HH fell back to gas due to null COP. ✓
3. **Infeasibility relaxation:** drop the comfort gate for the whole day; keep capacity and
   T_max_preheat gates; warn. ✓
4. **DST / non-48-HH days:** detect at grouping time, null-fill, T_init unchanged. ✓
5. **T_init chaining across non-heating/skipped days:** pass through unchanged. ✓
6. **DP temperature discretisation:** backtrack writes T_states grid values, not interpolated
   values. Design doc accepts this. ✓

---

### What is solid

- **The six scenarios are correctly specified end-to-end.** The `current` scenario mirrors M3
  exactly. Dumb HP and hybrid dispatch have the right unit-cost comparison (`elec_rate / COP`
  vs `gas_rate / η`), with η appearing exactly once in each fuel path. T1–T4 directly catch
  the three known failure modes (η omitted, η doubled, η missing from gas cost).

- **RC model is correctly inverted.** `requiredQDelivered` = `ΔT × C / 3600 + heatLoss −
  solarGain` is the correct rearrangement of the forward RC equation. The `/ 3600` factor is
  present and explained; T5/T6 verify it.

- **`computeStepEnergetics` placed inside the `s` loop, outside the `s_next` loop.** This
  is the right placement — `heatLossKwh` depends on `T_cur` (which varies by `s`), and
  `solarGainKwh` depends on `solar_w_m2[i]` (constant across `s_next`). 15× speedup per
  step correctly realised.

- **`hp_capacity_kw ?? Infinity` in §1m.** When M6 could not size the HP, `Infinity` makes
  the capacity gate `Q > Infinity × 0.5` always false — effectively no constraint. This is
  the correct conservative fallback (don't penalise a scenario because sizing is unknown).

- **DP infeasibility relaxation is well-structured.** Forward pass → check `s_final` cost →
  re-run with comfort gate dropped if infeasible → warn. One re-run maximum. ✓

- **Day chaining via `nearestStateIndex`.** T9 covers this. Correct: T_init for day d+1 is
  the grid state nearest to day d's backtracked end-state. ✓

- **`dumb_hp_svt` and `dumb_hp_hh` as a shared reference.** Correct per design doc. T13
  verifies object identity. ✓

- **Memory management.** Per-day DP tables allocated and discarded within `runDpForDay`.
  No 365-day accumulation. ✓

---

### Required changes before implementation

**MEDIUM — §1e: `solarGainKwh` null guard missing**

```
solarGainKwh = R × solarWm2 × 0.5 / 1000        // 0 if R = 0 or solarWm2 null
```

When `R > 0` (solar correction is applied) and `solarWm2 = null` (sparse solar data gaps),
this produces `NaN`. NaN propagates silently: `requiredQDelivered` returns NaN → the comparison
`NaN < dpCost[t+1][s_next]` is always false in JS → that transition is silently skipped
with no warning or fallback. In the backtrack, re-computing Q for the path also produces NaN,
corrupting `elec_kwh` / `gas_kwh` for that HH period.

The comment "// 0 if R = 0 or solarWm2 null" states the intended behaviour but is not
implemented. Replace with:

```javascript
solarGainKwh = R * (solarWm2 ?? 0) * 0.5 / 1000  // null solar data → 0 gain (conservative)
```

**MEDIUM — §1j: null `tempC` identity transition absent from DP pseudo-code**

The forward pass reads:
```
if tempC === null: skip this HH — carry state unchanged (handled below)
```

A bare `continue` on the outer `s` loop writes nothing to `dpCost[t+1]`. Every `dpCost[t+1][s]`
remains `+Infinity`. All states become unreachable for t+1 and every subsequent step — the
remainder of the day is infeasible. The relaxation re-run drops the comfort gate but does
not fix the null-tempC root cause, so relaxation also fails. The text block below the
pseudo-code correctly describes the fix (identity write-back), but Sonnet implements the
pseudo-code. Expand it as follows:

```
if tempC === null:
  // No RC step possible — carry this state forward at zero cost
  if dpCost[t][s] < dpCost[t+1][s]:
    dpCost[t+1][s] = dpCost[t][s]
    dpPrev[t+1][s] = s
    // For hybrid_smart, carry previous fuel choice; for smart_hp_hh, 'hp' default
    if (dpFuel[t+1] exists) dpFuel[t+1][s] = dpFuel[t][s] ?? 'hp'
  continue  // skip s_next loop for this HH period
```

Remove the "handled below" text block and the italic "temp_c === null HH handling" paragraph
— the pseudo-code now shows it inline.

---

### Minor observations (not blockers)

1. **LOW — `COLD_HOURS_WARN_FRACTION` declared but unused.** The constant (0.05) is in
   `SC_CONFIG` but does not appear in any warning logic in the plan. The corresponding design
   doc edge case ("Warn if >5% of heating hours below −10°C") is already handled by M6's
   `fraction_below_design_temp` warning. Either emit the warning in §1k (unlikely to be
   useful given M6 already covers it) or remove the constant to avoid dead code.

2. **LOW — `elecHhRateByHh[i] === null` in smart_hp_hh step cost produces NaN.** The solar
   NaN guard above does not cover this case. If wholesale data is missing for an individual
   HH (rare — M2 confirmed 17,300 periods), `(Q / cop) * null = NaN` silently skips the
   transition. Add an explicit guard: `if (elecHhRateByHh[i] === null) continue;` before
   computing `stepCost` in the `smart_hp_hh` branch.

3. **LOW — Degree-hours null guard in §1k.** `Math.max(0, T_setpoint − null) = NaN`, so a
   summer day with patchy null temp_c values produces `daily_degree_hours = NaN`. `NaN < 0.5`
   is false — the day is not filtered. The DP runs but produces no valid transitions. Fix:
   `(temp_c !== null ? Math.max(0, T_setpoint - temp_c) * 0.5 : 0)` per-HH term.

4. **LOW — Hybrid backtrack fuel indexing not explicit.** `dp_fuel[t+1][s_final_at_this_step]`
   in the design doc backtrack section is ambiguous. Clarify in the plan as
   `dpFuel[t+1][path[t+1]]` — the fuel stored for the next state in the backtracked path.

---

## Approval

**Status:** ⚠ Approved with edits — 2026-04-27
**Approved by:** Rhiannon (via Opus review)

Two MEDIUM required changes must be actioned before implementation begins:
1. **§1e** — Add `?? 0` null guard to `solarGainKwh` computation.
2. **§1j** — Expand null tempC pseudo-code to show explicit identity write-back inline.

Four LOW observations are recommended but not conditions of approval.

---

## Implementation Deviations

None — implementation not yet started.
