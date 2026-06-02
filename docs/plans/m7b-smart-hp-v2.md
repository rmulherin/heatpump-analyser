# m7b-smart-hp-v2 — Smart HP DP optimiser + smart_hp_hh components

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the smart-path half of the M7 v2 overhaul in `js/scenario-consumption.js`.
Prerequisite: m7a-scenario-consumption-v2 must be implemented first (it installs the
output shape, shared setup, and the m7b stub noted in Step 11 of the m7a plan).

Specifically:
- Replace the v1 greedy LP (`allocateGreedyDay` + `buildSmartScenario`) with the v2
  forward DP over discretised indoor-temperature states (design doc §4 Steps 5a–5e;
  N_STATES = 15).
- Update the RC heat-balance to include `internal_gains_w` + `net_flow_w` source terms
  (shared from m7a's `buildSharedValues`); the DP generates `indoor_temp_c` inline (no
  separate post-hoc simulation needed — remove `simulatePostHocTIndoor`).
- Assemble `smart_hp_hh.components` (7 sub-arrays) replacing the null-object stub left by
  m7a.
- Remove v1 helpers that are no longer needed: `allocateGreedyDay`, `buildSmartScenario`,
  `simulatePostHocTIndoor`.
- Retain `buildDayHhIndices` (reusable), `computeStepEnergetics` (update to add new
  terms), `requiredQDelivered` (unchanged).
- Tests 6–11, 15 from design doc + gate-continuity tests.

**Implementation prerequisite:** m7a implemented + approved; m3-v2, m4-v2, m5-v2, m6-v2
all implemented (Phase 3 depends on Phase 1+2 per architecture-v2 §5).

---

## Research findings

**v1 smart path (read `js/scenario-consumption.js` in full):**

- `buildSmartScenario`: top-level orchestrator; computes `tau` + `S_max` from
  `thermalMass` and `htc`; calls `allocateGreedyDay` per day; assembles `gas_kwh` and
  `elec_kwh` arrays; then calls `simulatePostHocTIndoor` for `indoor_temp_c`. No
  `components` sub-arrays on the output.
- `allocateGreedyDay`: greedy LP — sorts slots by unit cost, fills demand in price order
  with a cumulative storage headroom constraint (`S_max_kwh`). Does NOT use a discretised
  temperature state space. **Replaced entirely by the v2 forward DP.**
- `simulatePostHocTIndoor`: post-hoc RC simulation over `q_delivered` array from the
  greedy. In v2 the DP generates T_indoor inline during state-space search — this function
  is no longer needed.
- `computeStepEnergetics(tCur, tempC, htc, C, R, solarWm2)`: returns `heatLossKwh` +
  `solarGainKwh`. Reuse + extend with `internalKwh` + `netFlowKwh` in v2.
- `requiredQDelivered(tCur, tNext, C, heatLossKwh, solarGainKwh)`: unchanged formula —
  extend signature to subtract internal + net_flow.
- `buildDayHhIndices(heating)`: returns `[{date, indices, skipDp}]` sorted by date;
  `skipDp = indices.length !== 48`. Reuse unchanged.
- v1 smart gate called `computeValidationStatusSmart(heatLoss, heatPumpModel,
  thermalCharacter)` — replaced by m7a's single-field gate; m7b only runs when that gate
  returned `'ok'`.

**v2 DP description (design doc §4 Steps 5a–5e):**

State space: `T_states = linspace(T_setpoint − 1.0, T_setpoint + t_max_preheat_offset_c,
N_STATES)` (15 states). Forward DP over `t = 0..47`; cost = `(Q / COP[i]) ×
elec_hh_rate[i]`. Feasibility gates per candidate transition: Q < 0 (skip); Q >
hp_capacity × 0.5 (skip); occupied AND T_next < setpoint (skip — comfort); T_next >
T_setpoint + offset (skip — upper limit); COP null (skip HP option). Infeasible day:
relax comfort, re-run, warn. Backtrack recovers `Q_delivered[i]` + `indoor_temp_c[i]`
per HH. Day chaining: end-of-day state seeds next day's T_init.

RC formula (Step 5a — v2 adds internal_gains + net_flow_w):
```
delta_T = (Q + solar + internal + net_flow − heat_loss) × 3600 / C
```
Same discipline as m7a Step 2b.

**m7a-produced shared values consumed by m7b:**
`internal_gains_w`, `net_flow_w`, `η`, `cop_dhw`, `COP_COOKING`, `R`,
`classification`, `hp_replaces_electric_heating_eff`, `elec_heating`,
`elec_nonheat`, `gas_dhw_obs`, `gas_other_obs`, `occupied` — all from
`buildSharedValues` called in m7a's entry point.

**Components for smart_hp_hh** (Step 5e, design doc):
Gas space heat = 0; DHW/other identical to `dumb_hp` (from shared Step 3d logic);
`elec_space_heat = hp_elec_heating + retained_elec_heat` (retained per 3c, classification
`'some'` + tickbox OFF); `elec_nonheat` = shared invariant.

**Size assessment:** medium plan. 10 implementation steps + test suite. No combined
modules (m7b is a standalone upgrade within scenario-consumption.js).

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/scenario-consumption.js` | Replace greedy with DP; update RC; add smart components; remove v1 helpers |
| CREATE | `test-m7b.mjs` | Tests 6–11, 15 from design doc + gate-continuity |

---

## Implementation steps

### Step 1 — Update `computeStepEnergetics` (RC source terms)

Extend the v1 helper to include the new v2 terms and rename to reflect the full set:

```js
function computeStepEnergetics(tCur, tempC, htc, C, R, solarWm2, internal_gains_w, net_flow_w) {
  const heatLossKwh  = htc * (tCur - tempC) * 0.5 / 1000;
  const solarGainKwh = R * (solarWm2 ?? 0) * 0.5 / 1000;
  const internalKwh  = internal_gains_w * 0.5 / 1000;       // NEW v2 (single-source from m4)
  const netFlowKwh   = net_flow_w * 0.5 / 1000;             // NEW v2 (signed)
  return { heatLossKwh, solarGainKwh, internalKwh, netFlowKwh };
}
```

### Step 2 — Update `requiredQDelivered` (subtract new terms)

```js
function requiredQDelivered(tCur, tNext, C, heatLossKwh, solarGainKwh, internalKwh, netFlowKwh) {
  return (tNext - tCur) * C / 3600 + heatLossKwh - solarGainKwh - internalKwh - netFlowKwh;
}
```

The ×3600 discipline (kWh → K via kJ/K) is unchanged.

### Step 3 — Build `buildDpDay` (forward DP for one calendar day)

New function replacing `allocateGreedyDay`. Signature:
`buildDpDay({ dayIndices, external, heatLoss, thermalCharacter, heatPumpModel,
elecHhRateByHh, shared, T_init, t_max_preheat_offset_c })`.

**Constants:**
```js
const N_STATES = 15;
const T_setpoint  = thermalCharacter.setpoint_c;
const T_max       = T_setpoint + t_max_preheat_offset_c;
const htc = heatLoss.htc_w_per_k;
const C   = thermalCharacter.thermal_mass_kj_per_k;
const hpCapHh = (heatPumpModel.hp_capacity_kw ?? Infinity) * 0.5;  // thermal kWh per HH
const T_states = linspace(T_setpoint - 1.0, T_max, N_STATES);      // 15 discretised states
```

`linspace(lo, hi, n)` = `Array.from({length: n}, (_, k) => lo + k*(hi-lo)/(n-1))`.

**State init:** find index of `T_init` clamped into `T_states` by nearest value.

**Forward pass (t = 0..n-1):**
```js
const dp_cost = Array.from({length: n+1}, () => new Float64Array(N_STATES).fill(Infinity));
const dp_prev = Array.from({length: n+1}, () => new Int8Array(N_STATES).fill(-1));  // predecessor state
dp_cost[0][T_init_idx] = 0;

for (let t = 0; t < n; t++) {
  const i       = dayIndices[t];
  const tc      = external[i]?.temp_c ?? null;
  const solar   = external[i]?.solar_w_m2 ?? 0;
  const cop     = heatPumpModel.cop_by_hh[i] ?? null;
  const rate    = elecHhRateByHh[i];
  const occ     = shared.occupied[i % 48];

  for (let s = 0; s < N_STATES; s++) {
    if (dp_cost[t][s] === Infinity) continue;
    const T_cur = T_states[s];

    for (let s_next = 0; s_next < N_STATES; s_next++) {
      const T_next = T_states[s_next];
      // Feasibility: cannot actively cool
      const { heatLossKwh, solarGainKwh, internalKwh, netFlowKwh } = tc == null
        ? { heatLossKwh: 0, solarGainKwh: 0, internalKwh: shared.internal_gains_w * 0.5/1000, netFlowKwh: shared.net_flow_w * 0.5/1000 }
        : computeStepEnergetics(T_cur, tc, htc, C, shared.R, solar, shared.internal_gains_w, shared.net_flow_w);
      const Q = requiredQDelivered(T_cur, T_next, C, heatLossKwh, solarGainKwh, internalKwh, netFlowKwh);

      if (Q < 0) continue;                                  // cannot cool actively
      if (Q > hpCapHh) continue;                            // capacity bound
      if (occ && T_next < T_setpoint) continue;             // comfort (occupied → must reach setpoint)
      if (T_next > T_max) continue;                         // upper pre-heat limit
      if (cop == null && Q > 0) continue;                   // no COP data → skip HP; Q=0 drift allowed

      const step_cost = cop != null ? (Q / cop) * rate : 0;
      const new_cost  = dp_cost[t][s] + step_cost;
      if (new_cost < dp_cost[t+1][s_next]) {
        dp_cost[t+1][s_next] = new_cost;
        dp_prev[t+1][s_next] = s;
      }
    }
  }
}
```

> **Comfort gate**: occupied[h] uses `h = i % 48` (HH slot within day). Matches m7a Step
> 1c's `occupied` array which is 48-element indexed by HH-of-day.

> **Null outdoor temp**: when `tc == null`, heat loss = 0 (worst case — carry T forward
> without loss); internalKwh and netFlowKwh still apply.

**Feasibility fallback:** if no state at `t+1` is reachable (all Infinity), relax comfort
constraint and re-run the forward pass for that `t`. Append "HP may be undersized for
extreme cold days" warning once. Use the best-available solution.

**Backtrack:** find `s_final = argmin(dp_cost[n][*])`; walk `dp_prev` backwards to recover
`s_path[t]` for each step. Derive `Q_delivered[t]` from `T_states[s_path[t]]` →
`T_states[s_path[t+1]]` via the RC inverse.

**Returns:** `{ q_delivered, indoor_temp_c, hpUndersized }` — per-HH arrays over the day.

### Step 4 — Build `buildSmartScenarioV2` (orchestrator)

New function replacing `buildSmartScenario`. Signature:
`buildSmartScenarioV2({ heating, external, heatLoss, thermalCharacter, heatPumpModel,
elecHhRateByHh, shared, keep_gas_for_dhw_cooking, t_max_preheat_offset_c })`.

```js
const n    = heating.length;
const days = buildDayHhIndices(heating);  // reuse from v1

// Output arrays (all HH)
const gas_space_heat  = new Array(n).fill(0);
const elec_space_heat = new Array(n).fill(0);
const gas_dhw         = new Array(n).fill(0);
const gas_other       = new Array(n).fill(0);
const elec_dhw        = new Array(n).fill(0);
const elec_other      = new Array(n).fill(0);
const elec_nonheat    = shared.elec_nonheat.slice();  // invariant
const indoor_temp_c   = new Array(n).fill(null);
let hpUndersized = false;

let T_init = thermalCharacter.setpoint_c;  // day 0

for (const { indices, skipDp } of days) {
  if (skipDp) continue;  // DST transition day — carry T_init, place fixed loads

  // Degree-hours check (Step 5c — non-heating-day filter)
  const degree_hours = indices.reduce((s, i) => {
    const tc = external[i]?.temp_c;
    return tc != null ? s + Math.max(0, thermalCharacter.setpoint_c - tc) * 0.5 : s;
  }, 0);

  if (degree_hours < 0.5) {
    // No space heating this day — fixed loads still placed
  } else {
    const day = buildDpDay({
      dayIndices: indices, external, heatLoss, thermalCharacter, heatPumpModel,
      elecHhRateByHh, shared, T_init, t_max_preheat_offset_c,
    });
    if (day.hpUndersized) { hpUndersized = true; }

    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const cop = heatPumpModel.cop_by_hh[i];
      const Q   = day.q_delivered[k];
      elec_space_heat[i] = (cop != null && Q > 0) ? Q / cop : 0;
      // retained electric heating (classification 'some', tickbox OFF) — from m7a Step 3c
      const retained = (shared.classification === 'some' && !shared.hp_replaces_electric_heating_eff)
        ? (shared.elec_heating[i] ?? 0) : 0;
      elec_space_heat[i] += retained;
      gas_space_heat[i]   = 0;  // always 0 for smart HP
      indoor_temp_c[i]    = day.indoor_temp_c[k];
    }

    // Chain T_init: end-of-day state (closest T_states value)
    const lastIdx = indices[indices.length - 1];
    T_init = indoor_temp_c[lastIdx] ?? T_init;
  }

  // Fixed loads — identical to dumb_hp Step 3d (from shared)
  for (const i of indices) {
    if (keep_gas_for_dhw_cooking) {
      gas_dhw[i]    = shared.gas_dhw_obs[i];
      gas_other[i]  = shared.gas_other_obs[i];
    } else {
      elec_dhw[i]   = (shared.gas_dhw_obs[i] * shared.η) / shared.cop_dhw;
      elec_other[i] = shared.gas_other_obs[i] * shared.COP_COOKING;
    }
  }
}

// Rolled-up totals
const gas_kwh  = gas_space_heat.map((g, i) => g + gas_dhw[i] + gas_other[i]);
const elec_kwh = elec_space_heat.map((e, i) => e + elec_dhw[i] + elec_other[i] + elec_nonheat[i]);

if (hpUndersized) {
  warnings.push('HP may be undersized for extreme cold days — comfort constraint relaxed.');
}

return {
  gas_kwh, elec_kwh, indoor_temp_c,
  components: { gas_space_heat, gas_dhw, gas_other,
                elec_space_heat, elec_dhw, elec_other, elec_nonheat },
};
```

### Step 5 — Wire `buildSmartScenarioV2` into `estimateScenarioConsumption`

In the entry point (installed by m7a), replace the block:
```js
// m7b will replace this greedy dispatch with the v2 RC+DP optimiser
```
with:
```js
smartHpHh = buildSmartScenarioV2({
  heating, external, heatLoss, thermalCharacter, heatPumpModel,
  elecHhRateByHh, shared, keep_gas_for_dhw_cooking, t_max_preheat_offset_c,
});
```
`smartHpHh` now has real `components` — remove the null-object stub from m7a Step 11.

### Step 6 — Remove v1 smart-path helpers

Delete from `js/scenario-consumption.js`:
- `allocateGreedyDay` (entire function, ~105 lines)
- `buildSmartScenario` (entire function, ~40 lines)
- `simulatePostHocTIndoor` (entire function, ~25 lines)

`buildDayHhIndices` is retained (reused by `buildSmartScenarioV2`). `computeStepEnergetics`
and `requiredQDelivered` are retained (updated in Steps 1–2).

### Step 7 — Remove `comfort_demand_scale` parameter remnants

The v1 entry point accepted `comfort_demand_scale` and `underheat_ratio` to scale demand.
m7a removed it from the signature. Verify no reference to `comfort_demand_scale`,
`underheat_ratio`, or `demandScale` remains in the file after the greedy removal.

### Step 8 — Verify `validation_status.smart` codes

m7a changed the smart gate to `'ok' | 'no_thermal_mass'` only. Confirm that after m7b's
greedy removal there is no leftover reference to `'hp_undersized'` as a gate status code
(it was a v1 intermediate status set inside `buildSmartScenario` and surfaced in
`scenarioResult.validation_status.smart`). In v2, HP-undersized is a warning only; status
remains `'ok'`.

### Step 9 — Create `test-m7b.mjs`

One-day or few-day synthetic datasets throughout (except T15 which needs a full year or
≥30-day dataset to verify continuous chaining).

**T-gate-continuity:** `thermal_mass_kj_per_k` non-null, HTC non-null, COP array all non-null
→ `smart = "ok"`, `smart_hp_hh.indoor_temp_c` populated (not all null).

**T6 — RC unit check (v2 terms in DP):**
T_cur = 19, tc = 5, HTC = 200, C = 10,000, R = 0, internal_gains_w = 400, net_flow_w = 0,
Q chosen for steady state: Q = heat_loss − internal = 200×14×0.5/1000 − 0.2 = 1.2 kWh.
`delta_T = (1.2 + 0.2 − 1.4)×3600/10,000 = 0`. Assert T_next ≈ T_cur. Fails if internal
omitted.

**T7 — RC ×3600 discipline:**
T = 17, tc = 5, HTC = 200, C = 10,000, R = 0, internal = 0, net_flow = 0, Q = 2.0.
heat_loss = 1.2. delta_T = 0.8×3600/10,000 = 0.288. Assert |T_next − 17.288| < 0.001.

**T8 — Smart gate: thermal_mass source/evidence don't block:**
non-null thermal_mass (e.g. 5,000), but `thermal_mass_source = 'fallback'`, events_used = 0.
Assert `smart = "ok"` and `indoor_temp_c` populated.

**T9 — Pre-heating shifts to cheap periods:**
1-day dataset, 48 HH. `elec_hh_rate`: 2 p/kWh for HH 4–11 (02:00–06:00), 30 p/kWh
elsewhere. Occupied from HH 14 (07:00). T_setpoint = 19, HTC = 250, C = 10,000, COP = 3.
Assert: smart `elec_space_heat` is concentrated in the cheap window; smart-HH cost <
dumb-HH cost (same thermal demand, cheaper timing); `indoor_temp_c` populated for smart,
null for dumb.

**T10 — Classification 'some', tickbox OFF — retained elec stays in smart:**
class 'some', `hp_replaces_electric_heating = false`. `elec_heating[t] > 0` in some HHs.
Assert `smart_hp_hh.components.elec_space_heat[t] = DP_hp_elec[t] + elec_heating[t]`
(retained persists in smart as well as dumb).

**T11 — Classification 'all_electric':**
`heating_kwh ≈ 0`, `electric_heating_kwh_per_dd > 0`. `smart_hp_hh.gas_space_heat ≡ 0`;
`elec_space_heat = DP dispatch serving all-electric thermal demand`; `gas_kwh ≡ 0` when
toggle OFF. (Smart scenario fully electric, no gas, correct.)

**T13 (carried from m7a) — elec_nonheat invariant on smart:**
`smart_hp_hh.components.elec_nonheat[t] === current.components.elec_nonheat[t]` for all t.

**T15 — Current-home RC continuous chaining:**
30-day dataset. Assert `current.indoor_temp_c` is a full continuous trace (no null runs
beyond `tc`-null HHs); annual mean in heated winter days is plausible (18–22°C range),
not the v1 ~14–15°C. Fails if T is reset to setpoint on null outdoor-temp entries (v1 bug).

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| DP is O(N_STATES² × 48) per day × 365 days — may be slow | N_STATES=15 → 10,800 transitions per day, ~3.9M per year. Acceptable in JS (~300ms per design doc §8). Test T9 includes a timing assertion if needed. |
| Infeasible day (no comfort-feasible path) — infinite loop | Forward pass terminates at t=48 regardless; fallback re-run with relaxed comfort is a single additional pass, not a loop. |
| Comfort gate indexed by `i % 48` assumes UTC-day boundary aligns with HH slot 0 | `buildDayHhIndices` groups by UTC date; HH indices within day are naturally 0–47 for 48-HH days; DST days are skipped (`skipDp`). Safe. |
| `T_init` propagation on skip days or null-outdoor-temp HHs | DST days: carry T_init unchanged. Non-heating days: carry T_init unchanged. Null tc: heat-loss term = 0 (carry T). All documented in `buildDpDay`. |
| v1 test-m7.mjs may reference `allocateGreedyDay` or `hp_undersized` status | v1 suite tests the module through its public API; internal function names don't appear. Run suite after step 6 to confirm. |

---

## Success criteria

- [ ] `test-m7b.mjs`: all 9 test cases pass
- [ ] `test-m7.mjs` (v1 suite, 39 tests): all still pass (backwards-compat preserved)
- [ ] `test-m7a.mjs` (13 tests): all still pass (no regressions)
- [ ] `smart_hp_hh.components` populated with 7 real sub-arrays (not null-object)
- [ ] Component identity holds: `Σ(gas components) = gas_kwh[t]` and
      `Σ(elec components) = elec_kwh[t]` for smart_hp_hh
- [ ] Smart `indoor_temp_c` populated for all heating-day HHs where T_states ≥ 1 state
      reachable; null only where DP was skipped (DST / non-heating days)
- [ ] `allocateGreedyDay`, `buildSmartScenario`, `simulatePostHocTIndoor` absent from file
- [ ] No reference to `comfort_demand_scale`, `underheat_ratio`, `demandScale` in file
- [ ] `validation_status.smart` never returns `'hp_undersized'` — HP undersized is a
      `warnings[]` entry only

---

## Implementation Deviations

*To be completed after implementation.*

<!--
Status values:
- Awaiting review — Opus architect review pending.
- ✅ Approved — yyyy-mm-dd. Implementation may begin.
- ⚠ Approved with edits — yyyy-mm-dd. Implementation may begin [once <prereq>].
- ⏸ Blocked — yyyy-mm-dd. See Design Review below; rewrite required.
- Implemented — yyyy-mm-dd, commit <hash>.
-->
