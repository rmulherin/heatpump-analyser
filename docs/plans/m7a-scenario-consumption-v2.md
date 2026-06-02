# m7a-scenario-consumption-v2 — Dumb-path rewrite, output-shape update, smart gate fix

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the dumb-path half of the M7 v2 overhaul in `js/scenario-consumption.js`. The
module is split at the natural seam identified in the design doc (§Status) and in
v2-build-brief §7: (a) dumb path + shared setup + output shape; (b) smart DP path.
This plan is (a).

Specifically:
- New three-array output shape (`current`, `dumb_hp`, `smart_hp_hh`) replacing the v1
  six-scenario set; full-consumption semantics (total gas + elec per scenario, not
  heating-only); 7-component decomposition per ScenarioArrays object.
- Revised Step 0 gate: dumb gate on data presence; smart gate on `thermal_mass_kj_per_k`
  non-null only (single field, per integration-v2 T8 / design doc Step 0).
- Shared derived values (Steps 1a–1f): internal-gains single-source from m4-v2
  (`internal_gains_w_used`), per-HH electric-heating attribution, gas baseload split.
- `current` scenario rewrite (Steps 2 + 2b): full-consumption + components; RC trace
  gains `internal_gains_w` + `net_flow_w` source terms; continuous chaining (no reset on
  null outdoor temp).
- `dumb_hp` scenario rewrite (Steps 3a–3e): classification branching
  (`none`/`some`/`all_electric`), electric-heating attribution, DHW/other conversion with
  η + cop_dhw (corrects the live tool's η-omission on DHW), gas-disconnect toggle, full
  components assembly.
- Smart scenario body carried at v1-greedy level pending m7b; only the gate is updated.
- Backwards-compat aliases (`dumb_hp_svt`, `dumb_hp_hh` → `dumb_hp`) for v1 consumers
  pending m8-v2.
- New test suite `test-m7a.mjs` covering design doc Tests 1–5, 12–14 plus gate tests and
  RC unit checks for Step 2b.

**Implementation prerequisite:** m3-v2, m4-v2, m5-v2, m6-v2 must all be implemented before
this plan begins (Phase 3 sequencing per architecture-v2 §5 / v2-build-brief §2). The input
structures below assume those output shapes are in place.

---

## Research findings

**`js/scenario-consumption.js` (read in full):**

- `estimateScenarioConsumption` entry point. Current signature: `{ heating, external,
  heatLoss, thermalCharacter, heatPumpModel, baseloadMethod, gasRateByHh,
  elecHhRateByHh, comfort_demand_scale, t_max_preheat_offset_c }`.
- Returns `{ scenarios: { current, dumb_hp_svt, dumb_hp_hh, smart_hp_hh },
  validation_status, warnings }`. `dumb_hp_svt` and `dumb_hp_hh` are the same object
  reference (shared) — pattern to carry forward as `dumb_hp`.
- `buildCurrentScenario(heating)`: returns heating-only `gas_kwh` (= `heating_kwh`),
  `elec_kwh` (= 0 where gas non-null), no `baseload`, no components. Full rewrite needed.
- `simulateCurrentRcTrace`: lacks `internal_gains_w` + `net_flow_w` source terms; resets
  T to setpoint on null entries (both are v2 bugs — T carry-forward is correct per
  design doc Step 2b). Updated in Step 7 below.
- `buildDumbHpScenario(heating, copByHh, eta)`: heating-only, no DHW conversion, no
  classification branching, no components. Full rewrite needed.
- `computeValidationStatusSmart(heatLoss, heatPumpModel, thermalCharacter)`: gates on htc,
  hp_capacity_kw, AND thermal_mass. v2 replaces with single field check.
- `buildSmartScenario` / `allocateGreedyDay`: v1 greedy LP — preserved unchanged for m7b.
- `computeStepEnergetics` / `requiredQDelivered`: v1 helpers for smart DP — preserved.

**Design doc input-spec note:** `internal_gains_w_used` is listed as an m4-v2 output in
`integration-v2.md` §2 (single-source table) and required by design doc Step 1b, but is
absent from the §2 heat_loss input struct in this doc. Treating it as present in
`heat_loss` per integration-v2 I5 and Step 1b intent; consuming as
`heat_loss.internal_gains_w_used`. Opus reviewer: please confirm or add to §2 if not
already done.

**Backwards-compat approach:** M8 v1 (`js/pricing-engine.js`) and `app.js` reference
`scenarios.dumb_hp_svt` and `scenarios.dumb_hp_hh`. m7a adds alias assignments on the
result object so v1 consumers continue to work until m8-v2 is implemented. M8 v1 does not
read `components` — no impact there. `smart_hp_hh.components` will be a null-object (all
7 arrays null) until m7b.

**`app.js` call-site:** currently passes `baseloadMethod` and `gasRateByHh` — both removed
in v2. Passes `comfort_demand_scale` and `t_max_preheat_offset_c` — retained. New params
(`keep_gas_for_dhw_cooking`, `hw_split_fraction`, `hp_replaces_electric_heating`,
`occupancy_threshold`) sourced from existing UI controls already in app.js (see Step 12).
`consumption` (raw M1 result) and `supplementary_loads` (m3-v2 result field) are new
pass-throughs.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/scenario-consumption.js` | Rewrite dumb path; shared setup; output shape; smart gate fix |
| MODIFY | `app.js` | Update `estimateScenarioConsumption` call site (new params; remove baseloadMethod + gasRateByHh) |
| CREATE | `test-m7a.mjs` | Tests 1–5, 12–14 from design doc + gate tests + RC unit checks |

---

## Implementation steps

### Step 1 — Update `estimateScenarioConsumption` signature

Remove `baseloadMethod` and `gasRateByHh` from the parameter destructure (no hybrid
dispatch in v2; gate no longer uses method type). Add new parameters with defaults:

```js
export function estimateScenarioConsumption({
  consumption,              // M1 raw per-HH { timestamp, gas_kwh, elec_kwh } — for elec_nonheat
  heating,                  // m3-v2 per-HH { timestamp, heating_kwh, baseload_kwh, is_absence }
  supplementary_loads,      // m3-v2 { electric_heating_classification_effective,
                            //         electric_heating_kwh_per_dd,
                            //         electric_heating_fraction_of_total_energy }
  external,                 // M2 per-HH { timestamp, temp_c, solar_w_m2 }
  heatLoss,                 // m4-v2 { htc_w_per_k, boiler_efficiency_used,
                            //         solar_aperture_m2, solar_correction_applied,
                            //         net_flow_w, winter_setpoint_used_c,
                            //         internal_gains_w_used }
  thermalCharacter,         // m5-v2 { setpoint_c, thermal_mass_kj_per_k, occupancy_weights }
  heatPumpModel,            // m6-v2 { cop_by_hh, cop_dhw, hp_capacity_kw }
  elecHhRateByHh,           // smart DP only (unchanged)
  keep_gas_for_dhw_cooking = false,
  hw_split_fraction = 0.70,
  hp_replaces_electric_heating = null,   // null → derive from fraction (Step 4)
  t_max_preheat_offset_c = 3.0,
  occupancy_threshold = 0.5,
  // removed: baseloadMethod, gasRateByHh, comfort_demand_scale
})
```

### Step 2 — Rewrite Step 0 dumb gate

Replace `baseloadMethod === 'no-gas'` check with data-presence check:

```js
const hasAnyGas  = heating.some(h => h.heating_kwh != null);
const hasAnyElec = consumption.some(c => c.elec_kwh != null);

if (!hasAnyGas || !hasAnyElec) {
  const nullScenario = makeNullScenario(heating.length);
  return {
    scenarios: { current: nullScenario, dumb_hp: nullScenario, smart_hp_hh: nullScenario,
                 dumb_hp_svt: nullScenario, dumb_hp_hh: nullScenario },  // compat aliases
    validation_status: { dumb: 'no_data', smart: computeValidationStatusSmart(thermalCharacter) },
    warnings: ['No gas or electricity data — heat pump scenarios cannot be modelled.'],
  };
}
```

`makeNullScenario(n)` returns a ScenarioArrays with all 7 component arrays set to
`new Array(n).fill(null)`, plus null `gas_kwh`, `elec_kwh`, `indoor_temp_c`.

### Step 3 — Rewrite smart gate

Replace `computeValidationStatusSmart(heatLoss, heatPumpModel, thermalCharacter)` with a
single-field check:

```js
function computeValidationStatusSmart(thermalCharacter) {
  return thermalCharacter?.thermal_mass_kj_per_k != null ? 'ok' : 'no_thermal_mass';
}
```

Called at the start of `estimateScenarioConsumption` (before computing any scenario). The
`'no_thermal_mass'` case sets `smart_hp_hh = makeNullScenario(n)` and skips the smart
body — current + dumb_hp still compute.

Remove the old multi-arg `computeValidationStatusSmart` and its references to
`heatLoss?.htc_w_per_k` and `heatPumpModel?.hp_capacity_kw`.

### Step 4 — Implement `buildSharedValues` (Steps 1a–1c)

New function. Takes the full param set from the entry point.

**1a — Constants and passthroughs:**
```js
const η              = heatLoss?.boiler_efficiency_used ?? 0.85;
const COP_COOKING    = 1.0;
const cop_dhw        = heatPumpModel?.cop_dhw ?? 2.0;
const R              = (heatLoss?.solar_correction_applied && heatLoss?.solar_aperture_m2 != null)
                       ? heatLoss.solar_aperture_m2 : 0;
const classification = supplementary_loads.electric_heating_classification_effective;
const internal_gains_w = heatLoss?.internal_gains_w_used ?? 300;   // 300 W defensive fallback
const net_flow_w       = heatLoss?.net_flow_w ?? 0;
```

**1b — `hp_replaces_electric_heating_eff` (derive if null):**
```js
const hp_replaces_electric_heating_eff = hp_replaces_electric_heating !== null
  ? hp_replaces_electric_heating
  : (supplementary_loads.electric_heating_fraction_of_total_energy >= 0.15);
```

**1c — Occupancy (no-block default):**
```js
const weights  = thermalCharacter?.occupancy_weights ?? new Array(48).fill(1.0);
const occupied = weights.map(w => w >= occupancy_threshold);   // 48-element boolean array
```

Returns all constants for use in Steps 1d–1f and the scenario builders.

### Step 5 — Implement `attributeElectricHeating` (Step 1d)

New function. Signature: `attributeElectricHeating({ heating, consumption, external,
supplementary_loads, occupied, thermalCharacter })`.

- Loop over calendar days (group by `timestamp.slice(0, 10)`).
- Per day: `HDD[d] = max(0, 15.5 − daily_mean_temp_c[d])` (mean of non-null `temp_c` over
  day's HH periods; skip day if all temp null).
- `elec_heat_day[d] = electric_heating_kwh_per_dd × HDD[d]`.
- If `elec_heat_day[d] === 0`: `elec_heating[t] = 0` for day's HH; continue.
- Intra-day weights `w[t]` for the 48 HH in day d:
  - `'some'`: `w[t] = heating_kwh[t] ?? 0` (co-occurs with gas heating).
  - `'all_electric'`: `w[t] = max(0, obs_elec[t] − median_obs_elec_offpeak)` where
    `median_obs_elec_offpeak` = median of `consumption[t].elec_kwh` over the day's
    off-peak hours (22:00–06:00 local; approximate as HH indices 0–11 and 44–47 of the day
    — 16 periods).
  - Fallback if `sum(w) === 0`: `w[t] = max(0, T_setpoint − temp_c[t]) × (occupied[t % 48] ? 1 : 0)`.
  - If still `sum === 0`: `elec_heating[t] = 0` for day; continue.
- Distribute: `elec_heating[t] = elec_heat_day[d] × w[t] / sum_w`.
- Clamp: `elec_heating[t] = Math.min(elec_heating[t], consumption[i].elec_kwh ?? 0)`.
- Accumulate total clipped; warn if clipped > 2% of annual elec sum.
- `'none'`: return `new Array(n).fill(0)` immediately.

Returns `elec_heating` (17,520-element `number[]`).

### Step 6 — Implement Steps 1e–1f (elec_nonheat + gas DHW split)

Within `buildSharedValues`, after `attributeElectricHeating` returns `elec_heating`:

```js
// 1e — invariant non-heating elec baseload
const elec_nonheat = consumption.map((c, i) =>
  Math.max(0, (c.elec_kwh ?? 0) - (elec_heating[i] ?? 0))
);

// 1f — gas baseload DHW / other split
const gas_dhw_obs   = heating.map(h => (h.baseload_kwh ?? 0) * hw_split_fraction);
const gas_other_obs = heating.map(h => (h.baseload_kwh ?? 0) * (1 - hw_split_fraction));
```

`buildSharedValues` returns `{ η, COP_COOKING, cop_dhw, R, classification,
internal_gains_w, net_flow_w, hp_replaces_electric_heating_eff, occupied, elec_heating,
elec_nonheat, gas_dhw_obs, gas_other_obs }`.

### Step 7 — Rewrite `buildCurrentScenario` (Step 2)

Replace the v1 function (heating-only, no components) with full-consumption + components:

```js
function buildCurrentScenario(heating, consumption, shared) {
  const n = heating.length;
  const { elec_heating, elec_nonheat, gas_dhw_obs, gas_other_obs } = shared;

  const gas_space_heat  = heating.map(h => h.heating_kwh);
  const gas_dhw         = gas_dhw_obs.slice();
  const gas_other       = gas_other_obs.slice();
  const elec_space_heat = elec_heating.slice();    // 0 for classification 'none'
  const elec_dhw        = new Array(n).fill(0);   // hot water is on gas in current state
  const elec_other      = new Array(n).fill(0);
  const elec_nonheat_   = elec_nonheat.slice();

  const gas_kwh  = gas_space_heat.map((g, i) =>
    g == null ? null : g + gas_dhw[i] + gas_other[i]);
  const elec_kwh = consumption.map((c, i) =>
    c.elec_kwh == null ? null : c.elec_kwh);   // observed total elec (identity: Test 1)

  return {
    gas_kwh, elec_kwh,
    indoor_temp_c: new Array(n).fill(null),   // filled by simulateCurrentRcTrace in entry point
    components: {
      gas_space_heat, gas_dhw, gas_other,
      elec_space_heat, elec_dhw, elec_other,
      elec_nonheat: elec_nonheat_,
    },
  };
}
```

Note: `elec_kwh[i] = consumption[i].elec_kwh` (observed) — the identity that Test 1 asserts.
The component sum `elec_space_heat + elec_dhw + elec_other + elec_nonheat` must equal this.

### Step 8 — Update `simulateCurrentRcTrace` (Step 2b)

Two changes from v1: add `internal_gains_w` + `net_flow_w` source terms; change null
outdoor-temp handling from "reset T to setpoint" to "carry T forward". Pass
`internal_gains_w` and `net_flow_w` from `shared`.

```js
function simulateCurrentRcTrace({ heating, external, heatLoss, thermalChar, shared }) {
  const htc = heatLoss?.htc_w_per_k;
  const C   = thermalChar?.thermal_mass_kj_per_k;
  const eta = heatLoss?.boiler_efficiency_used ?? 0.85;
  const sp  = thermalChar?.setpoint_c;
  if (htc == null || C == null || sp == null) return heating.map(() => null);

  const R           = shared.R;
  const internal_w  = shared.internal_gains_w;
  const net_flow_w  = shared.net_flow_w;
  const out         = new Array(heating.length);
  let T = sp;

  for (let i = 0; i < heating.length; i++) {
    const tc = external[i]?.temp_c;
    if (tc == null) { out[i] = T; continue; }   // carry T; no reset (v2 change)

    const Q_heat      = (heating[i].heating_kwh ?? 0) * eta
                      + (shared.elec_heating[i] ?? 0);  // existing elec heating (resistive)
    const heatLossKwh = htc * (T - tc) * 0.5 / 1000;
    const solarKwh    = R * (external[i]?.solar_w_m2 ?? 0) * 0.5 / 1000;
    const internalKwh = internal_w * 0.5 / 1000;         // NEW v2
    const netFlowKwh  = net_flow_w * 0.5 / 1000;         // NEW v2 (signed)
    const dT = (Q_heat + solarKwh + internalKwh + netFlowKwh - heatLossKwh) * 3600 / C;
    T += dT;
    out[i] = T;
  }
  return out;
}
```

Called from `estimateScenarioConsumption` after `buildCurrentScenario`, only when both HTC
and thermal mass are non-null: `if (heatLoss?.htc_w_per_k != null && thermalCharacter?.thermal_mass_kj_per_k != null)`.

### Step 9 — Rewrite `buildDumbHpScenario` (Steps 3a–3e)

Replace the v1 function. New signature: `buildDumbHpScenario(heating, shared,
heatPumpModel, keep_gas_for_dhw_cooking)`.

**3a — Space-heating thermal demand:**
```js
const { η, COP_COOKING, cop_dhw, classification, hp_replaces_electric_heating_eff,
        elec_heating, elec_nonheat, gas_dhw_obs, gas_other_obs } = shared;
const copByHh = heatPumpModel?.cop_by_hh ?? new Array(heating.length).fill(null);

// per HH:
thermal_from_gas[i]  = (heating[i].heating_kwh ?? 0) * η;
thermal_from_elec[i] = (classification === 'all_electric')                                    ? (elec_heating[i] ?? 0)
                     : (classification === 'some' && hp_replaces_electric_heating_eff)         ? (elec_heating[i] ?? 0)
                     : 0;
hp_thermal[i] = thermal_from_gas[i] + thermal_from_elec[i];
```

**3b — HP electricity for space heating (COP null handling):**
```js
if (heating[i].heating_kwh == null) { /* null passthrough */ continue; }
if (hp_thermal[i] === 0)            { hp_elec_heating[i] = 0; gas_fallback[i] = 0; continue; }
if (copByHh[i] == null) {
  // No COP data: fallback
  if (classification === 'all_electric') {
    hp_elec_heating[i] = hp_thermal[i];   // resistive fallback
    gas_fallback[i] = 0;
  } else {
    hp_elec_heating[i] = 0;
    gas_fallback[i] = heating[i].heating_kwh;  // keep gas this period
  }
  nFallback++;
} else {
  hp_elec_heating[i] = hp_thermal[i] / copByHh[i];
  gas_fallback[i] = 0;
}
```

Warn if `nFallback > 0.01 × nHeatingHh`.

**3c — Retained existing electric heating (`'some'` + tickbox OFF):**
```js
retained_elec_heat[i] = (classification === 'some' && !hp_replaces_electric_heating_eff)
  ? (elec_heating[i] ?? 0) : 0;
```

**3d — DHW + other per §10d toggle:**
```js
if (keep_gas_for_dhw_cooking) {
  gas_dhw[i]   = gas_dhw_obs[i];
  gas_other[i] = gas_other_obs[i];
  elec_dhw[i]  = 0;
  elec_other[i]= 0;
} else {
  gas_dhw[i]   = 0;
  gas_other[i] = 0;
  elec_dhw[i]  = (gas_dhw_obs[i] * η) / cop_dhw;    // gas → useful (×η) → HP elec (÷cop_dhw)
  elec_other[i]= gas_other_obs[i] * COP_COOKING;     // 1:1 resistive (COP_COOKING = 1.0)
}
```

**3e — Assemble components + rolled-up totals:**
```js
gas_space_heat[i]  = gas_fallback[i];
elec_space_heat[i] = hp_elec_heating[i] + retained_elec_heat[i];
// gas_dhw / gas_other / elec_dhw / elec_other from 3d
// elec_nonheat from shared (invariant)

gas_kwh[i]  = gas_space_heat[i] + gas_dhw[i] + gas_other[i];
elec_kwh[i] = elec_space_heat[i] + elec_dhw[i] + elec_other[i] + elec_nonheat[i];
indoor_temp_c[i] = null;
```

Return: `{ gas_kwh, elec_kwh, indoor_temp_c, components: { gas_space_heat, gas_dhw,
gas_other, elec_space_heat, elec_dhw, elec_other, elec_nonheat } }`.

### Step 10 — Update `computeValidationStatusDumb`

v1 checked `baseloadMethod === 'no-gas'` — remove. v2 dumb status is set at Step 0 gate
(`no_data`) or computed from null density:

```js
function computeValidationStatusDumb(heating) {
  const nTotal  = heating.filter(h => h.heating_kwh != null).length;
  // partial: >5% of non-null heating periods have no COP (fallback gas retained)
  // tracked via nFallback from buildDumbHpScenario
  if (nTotal === 0) return 'no_data';
  return (nFallback / nTotal >= 0.05) ? 'partial' : 'ok';
}
```

`nFallback` is returned from `buildDumbHpScenario` as a diagnostic.

### Step 11 — Assemble v2 output + backwards-compat aliases

In `estimateScenarioConsumption`, after building all three scenarios:

```js
const result = {
  scenarios: {
    current,
    dumb_hp:     dumbHp,
    smart_hp_hh: smartHpHh,
  },
  validation_status: { dumb: dumbStatus, smart: smartStatus },
  warnings,
};

// backwards-compat aliases — remove when m8-v2 is implemented
result.scenarios.dumb_hp_svt = dumbHp;
result.scenarios.dumb_hp_hh  = dumbHp;

return result;
```

`smartHpHh` is either the v1 greedy result (upgraded in m7b) or `makeNullScenario(n)` per
the gate. When the greedy runs, append a `components` null-object:
`smartHpHh.components = makeNullComponents(n)` (7 arrays of null) — m7b will replace with
real decomposition.

### Step 12 — Update `app.js` call site

Find the `estimateScenarioConsumption({...})` call in `app.js` (currently in
`runScenarioConsumption` or similar). Update the argument object:

- Remove: `baseloadMethod`, `gasRateByHh`, `comfort_demand_scale`.
- Add:
  - `consumption: ingestionResult.consumption` (M1 raw per-HH array)
  - `supplementary_loads: baseloadResult.supplementary_loads` (m3-v2 field)
  - `keep_gas_for_dhw_cooking: getKeepGasToggle()` (existing UI control — `#keep-gas-toggle` or equivalent)
  - `hw_split_fraction: getHwSplitFraction()` (existing `#gas-split-slider` / 100)
  - `hp_replaces_electric_heating: getHpReplacesElecToggle()` (§7 7e tickbox — null if not present)
  - `occupancy_threshold: 0.5` (hardcoded default; no UI control yet)
- Retain: `heating`, `external`, `heatLoss`, `thermalCharacter`, `heatPumpModel`,
  `elecHhRateByHh`, `t_max_preheat_offset_c`.

Read the existing call site in app.js before writing to confirm exact variable names for
the ingestion result, baseload result, and UI control accessors.

### Step 13 — Create `test-m7a.mjs`

Write the following test cases against the new dumb-path implementation. Use `node
--experimental-vm-modules` or the existing test runner pattern from `test-m3-step-f.mjs`.

All tests use a synthetic 48-HH day dataset (except T12 which uses a multi-day dataset).

**T-Gate-1 — Smart gate = thermal_mass only:**
`thermal_mass_kj_per_k = null`, all other inputs present. Assert: `smart = "no_thermal_mass"`,
`smart_hp_hh` all-null arrays, `current` and `dumb_hp` populated.

**T-Gate-2 — Weak thermal-mass evidence still runs smart:**
`thermal_mass_kj_per_k = 5000` (non-null), `thermal_mass_source = 'fallback'`,
`validation_status = "weak"`. Assert: `smart = "ok"` (gate does not inspect source or
evidence quality).

**T1 — Current = observed (identity):**
Synthetic: `consumption[t].gas_kwh = 0.5`, `consumption[t].elec_kwh = 0.3`, class 'none',
toggle ON, `baseload_kwh = 0.1`. Assert for all t: `current.gas_kwh[t] = 0.6` (heating +
baseload), `current.elec_kwh[t] = 0.3` (obs). Assert component identity sums:
`Σcomponents.gas = gas_kwh[t]`, `Σcomponents.elec = elec_kwh[t]`.

**T2 — Output shape (three arrays, not six):**
Assert `scenarios` has keys `current`, `dumb_hp`, `smart_hp_hh` (+ compat aliases).
Assert `dumb_hp_svt === dumb_hp` and `dumb_hp_hh === dumb_hp` (same reference). Assert
`dumb_hp` has `components` object with all 7 keys.

**T3 — Dumb HP space-heat unit chain:**
`heating_kwh = 1.0`, `baseload_kwh = 0`, η = 0.9, cop_by_hh[t] = 3.0, class 'none',
toggle ON. Expected `dumb_hp.components.elec_space_heat[t] = 1.0 × 0.9 / 3.0 = 0.30`.
Fails if η omitted (0.333) or doubled (0.27).

**T4 — DHW η + cop_dhw, toggle OFF:**
`heating_kwh = 0`, `baseload_kwh = 1.0`, hw_split = 0.70, η = 0.85, cop_dhw = 2.0,
toggle OFF. Expected: `elec_dhw[t] = 1.0 × 0.70 × 0.85 / 2.0 = 0.2975`;
`elec_other[t] = 1.0 × 0.30 = 0.30`; `gas_dhw[t] = gas_other[t] = 0`.
Fails if η omitted on DHW (gives 0.35).

**T5 — Toggle ON keeps baseload on gas:**
Same as T4 but toggle ON. Expected: `gas_dhw[t] = 0.70`, `gas_other[t] = 0.30`,
`elec_dhw[t] = elec_other[t] = 0`.

**T6-2b — RC unit check with v2 terms (Step 2b):**
T = 19, temp_c = 5, HTC = 200, C = 10,000, R = 0, internal_gains_w = 400, net_flow_w = 0,
`heating_kwh` chosen for steady state (Q_delivered = heat_loss − internal =
200×14×0.5/1000 − 0.2 = 1.2 kWh). Assert `delta_T ≈ 0.0`. Fails if internal_gains
omitted (T rises). Verifies internal-gains term present in `simulateCurrentRcTrace`.

**T7-2b — RC ×3600 discipline (Step 2b):**
T = 17, temp_c = 5, HTC = 200, C = 10,000, R = 0, internal = 0, net_flow = 0,
Q_delivered = 2.0 kWh. heat_loss = 200×12×0.5/1000 = 1.2. delta_T = (2.0−1.2)×3600/10,000
= 0.288°C. Assert `|T_next − 17 − 0.288| < 0.001`. Fails (→ 0.00008) if ×3600 missing.

**T12 — Attribution sums to daily:**
3-day dataset. Day 2: `electric_heating_kwh_per_dd = 0.5`, `HDD = 4.0`, class 'some',
observed `heating_kwh` shape distributed unevenly. Assert
`Σ_t elec_heating[t]` over day 2's 48 periods = 0.5 × 4.0 = 2.0 (within 0.001 rounding).

**T13 — elec_nonheat invariant:**
Same dataset for all three scenarios. Assert `current.components.elec_nonheat[t] ===
dumb_hp.components.elec_nonheat[t]` and `=== smart_hp_hh.components.elec_nonheat[t]`
for all t (where smart_hp_hh runs).

**T14 — Classification 'none' sanity:**
class = 'none', toggle OFF, `heating_kwh[t] = 0.8`, `baseload_kwh[t] = 0.2`,
`elec_kwh[t] = 0.4`, η = 0.85, cop = 3.0, hw_split = 0.70, cop_dhw = 2.0.
Assert: `elec_heating ≡ 0` (no attribution); `current.elec_kwh[t] = 0.4` (obs);
`dumb_hp.gas_kwh[t] = 0` (toggle OFF, full disconnect);
`dumb_hp.elec_dhw[t] = 0.2×0.70×0.85/2.0 = 0.0595`.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `internal_gains_w_used` absent from m4-v2 output (design doc §2 omission) | Defensive `?? 300` fallback; flag in research findings for Opus to confirm in m4-v2 plan review |
| App.js call site uses different variable names for UI controls than assumed in Step 12 | Step 12 explicitly defers to reading the existing call site before writing — do not assume names |
| v1 test-m7.mjs references `dumb_hp_svt`/`dumb_hp_hh` — may fail if aliases change behaviour | Aliases assigned directly on result object; same reference → v1 tests unaffected |
| Phase 3 prerequisite not yet met (m3/m4/m5/m6 v2 not implemented) | Implementation gate: confirm these are all ✅ Done in session memory before beginning |
| `simulateCurrentRcTrace` carry-T-forward (vs v1 reset) changes the plot trace | Expected change — INV-3 correction. T15 (excluded from this plan, in m7b test suite) will confirm realistic range |
| Attribution fallback (degree-hours × occupancy) relies on `occupied[]` indexed by `t % 48` | Day HH index is always 0–47 within a calendar day — safe; note in code comment |

---

## Success criteria

- [ ] `test-m7a.mjs`: all 12 test cases pass (`node test-m7a.mjs` exits 0)
- [ ] `test-m7.mjs` (v1 suite): all 39 tests still pass (backwards-compat aliases preserved)
- [ ] `estimateScenarioConsumption` output has `scenarios.current`, `scenarios.dumb_hp`,
      `scenarios.smart_hp_hh` — each with `gas_kwh`, `elec_kwh`, `indoor_temp_c`,
      `components` (7 sub-arrays)
- [ ] Component identity holds for all t: `Σ(gas components) = gas_kwh[t]`;
      `Σ(elec components) = elec_kwh[t]`
- [ ] `current.elec_kwh[t] = consumption[t].elec_kwh` (observed identity — Test 1)
- [ ] Smart gate: `thermal_mass_kj_per_k == null` → `smart = "no_thermal_mass"` with null
      arrays; presence of null `validation_status` / `thermal_mass_source` does not block
- [ ] `simulateCurrentRcTrace` carries T forward on null outdoor-temp periods (no reset);
      includes `internal_gains_w` + `net_flow_w` terms (Test 6-2b, Test 7-2b)
- [ ] No console errors in browser on page load (existing pipeline continues to run)
- [ ] Design doc invariants I1 (cost reconciliation via components) unbroken: component
      array names match m8-v2 bucketing keys exactly as specced in design doc §3

---

## Implementation Deviations

*To be completed after implementation.*

<!--
The Design Review section is appended by the Opus reviewer when the plan is amended.
See `coding/agents/plan-reviewer.md` for the review record template and post-review
Status values.

Status values (canonical, from plan-reviewer.md):
- Awaiting review — Opus architect review pending.    (planner sets)
- ✅ Approved — yyyy-mm-dd. Implementation may begin.  (reviewer sets)
- ⚠ Approved with edits — yyyy-mm-dd. Implementation may begin [once <prereq>].
- ⏸ Blocked — yyyy-mm-dd. See Design Review below; rewrite required.
- Implemented — yyyy-mm-dd, commit <hash>.            (implementer sets)
-->
