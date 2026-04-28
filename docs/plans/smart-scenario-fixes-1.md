# Smart Scenario Fixes 1 — implementation plan

**Date:** 2026-04-28
**Status:** ⚠ Approved with edits — 2026-04-28
**Parent design:** `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/smart-scenario-fixes-1.md` (DRAFT — pending Rhiannon approval)
**Related designs:** `design/thermal-character.md` (M5), `design/scenario-consumption.md` (M7), `design/ui-design-m10a.md` (M10), `architecture.md`, `scope.md`

---

## Task description

Three coupled corrections raised at launch-readiness testing on 2026-04-28:

1. **M7 smart-scenario optimiser is rebased onto observed daily heat totals** by replacing the DP-over-RC-with-comfort-constraint with a per-day greedy LP. This restores the `Smart ≤ Dumb` cost invariant by construction. The optimiser was previously charging the smart baseline against a modelled comfort demand that exceeds the dumb baseline's observed demand for any household that underheats — almost all UK households.
2. **M5 produces a comfort-demand diagnostic** — modelled annual heat demand at setpoint, observed-vs-modelled ratio, and an underheating narrative. This is the modelled demand calculation previously embedded in the M7 optimiser, repurposed as a user-visible "are you underheating?" output.
3. **M10 surfaces both** — an underheating sub-panel inside Your Home, plus a "Heat to Comfort" slider in What If that scales the daily heat budget M7 uses.

Module/file/test changes follow the design doc verbatim. The plan is phased so each phase merges independently and the validation gates fire in the right order.

---

## Research findings

The design doc fully specifies the algorithm, formulas, edge cases, test inputs, and expected outputs. No library research required:

- **Per-day greedy LP** is algorithmically simple (sort by unit cost, fill cheapest HH up to capacity until daily budget is met). Vanilla JS `Array.prototype.sort` with a numeric comparator is sufficient — no LP library needed.
- **Steady-state energy balance** for the M5 diagnostic is one HH-level multiplication and one sum — no integration, no library needed.
- **Existing helpers in `js/scenario-consumption.js`** to retain: `computeStepEnergetics`, `requiredQDelivered`, `buildDayHhIndices`, `buildCurrentScenario`, `buildDumbHpScenario`, `buildHybridDumbScenario`. These either feed dumb scenarios (unchanged) or feed the post-hoc T_indoor sim (chart-only, kept).
- **Existing helpers to delete:** `discretiseStates`, `nearestStateIndex`, `runDpForDay`, the entire DP forward pass + backtrack inside the smart-scenario builder, the `T_states` discretisation, the `T_init`/`T_init_next` chaining inside the optimiser (kept only inside the post-hoc sim), the relax-comfort fallback, the `T_max_preheat`/`occupancy_threshold` user inputs and their `SC_CONFIG` constants.
- **No existing JS in this repo solves the per-day greedy allocation pattern** for cost-weighted dispatch — write directly per design § 1.4.
- **Test runner:** existing `test-m*.mjs` files run via `node test-mN.mjs` from the repo root and import the modules under test. Add new tests in the same style.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/thermal-character.js` | Append M5 comfort-demand diagnostic outputs (Fix 2) |
| MODIFY | `js/scenario-consumption.js` | Replace smart-scenario DP with per-day greedy LP; add post-hoc T_indoor sim; update validation status (Fix 1) |
| MODIFY | `js/app.js` | Remove preheat/occupancy sliders wiring; add underheating panel render; add Heat to Comfort slider handler; surface `hp_undersized` warning (Fix 3) |
| MODIFY | `index.html` | Remove preheat/occupancy slider controls; add underheating sub-panel inside Your Home banner; add Heat to Comfort slider in What If banner (Fix 3) |
| MODIFY | `css/styles.css` | Add traffic-light ratio styling and slider polish for new controls (Fix 3) |
| MODIFY | `test-m5.mjs` | Add tests M5.X1–M5.X7 for new diagnostic outputs |
| MODIFY | `test-m7.mjs` | Remove obsolete DP tests; rewrite tests 8/9/11; add tests 13–16 |
| MODIFY | `CLAUDE.md` (heatpump-analyser) | Update Status line at end of implementation |
| MODIFY | `~/Documents/git-repos/claude-coding-hub/context/heatpump-memory.md` | Update session memory after each phase commit |

(Edits to praxis-claude-hub files — `architecture.md`, `scope.md`, the parent design doc's Status flip — are explicitly **out of scope** for this plan. Opus owns those and applies them post-launch as cleanup once code is verified on real data.)

No new files are created. The plan deliberately avoids new modules — the diagnostic and the rewritten optimiser stay inside their existing module files.

---

## Implementation steps

### Phase 1 — M5 comfort-demand diagnostic (Fix 2, additive)

This phase is fully additive. No existing M5 output changes; no downstream module behaviour changes. Land + test independently.

**Step 1.1 — Verify and wire M5's input contract.**
Read `js/thermal-character.js` to confirm `estimateThermalCharacter` already receives `heating[]`, `external[]`, and `heatLoss`. (Step 4a already consumes `external.temp_c`, so the array is in scope.) If `solar_w_m2` is not currently destructured per HH, add the destructure. No new parameters required from the caller; the existing pipeline already passes both arrays in.

**Step 1.2 — Append new constants to `TC_CONFIG`:**
```javascript
UNDERHEAT_RATIO_LOW:  0.85,   // < this → "underheat"
UNDERHEAT_RATIO_HIGH: 1.15,   // > this → "overheat"
```

**Step 1.3 — New helper `computeModelledHeatingByHh`** (private, after the existing `median` helper):
```javascript
function computeModelledHeatingByHh(heating, external, heatLoss, setpointC) {
  const htc = heatLoss?.htc_w_per_k;
  const aperture = (heatLoss?.solar_correction_applied && heatLoss?.solar_aperture_m2 != null)
    ? heatLoss.solar_aperture_m2 : 0;

  const out = new Array(heating.length).fill(null);
  if (htc == null || setpointC == null) return out;

  for (let i = 0; i < heating.length; i++) {
    const tc = external[i]?.temp_c;
    if (tc == null) continue;
    const lossKwh  = htc * Math.max(0, setpointC - tc) * 0.5 / 1000;
    const solarKwh = aperture * (external[i]?.solar_w_m2 ?? 0) * 0.5 / 1000;
    out[i] = Math.max(0, lossKwh - solarKwh);
  }
  return out;
}
```
Units cross-checked against design § 2.4 and Test M5.X1.

**Step 1.4 — New helper `computeUnderheatStatus`** (returns the diagnostic block):
```javascript
function computeUnderheatStatus(modelledByHh, heating, eta) {
  const annualModelled = modelledByHh.reduce((s, v) => v == null ? s : s + v, 0);
  const annualObserved = heating.reduce(
    (s, h) => (h.heating_kwh != null && !h.is_absence) ? s + h.heating_kwh * eta : s,
    0,
  );

  // Insufficient_data covers: no modelled demand (null/0 — missing HTC/setpoint or no
  // weather), AND no observed demand (null/0 — baseload separation found no heating
  // signal). Either edge produces a degenerate ratio that should not surface narrative.
  if (!annualModelled || annualModelled === 0 || !annualObserved || annualObserved === 0) {
    return {
      annual_modelled_demand_kwh: annualModelled || null,
      annual_observed_demand_kwh: annualObserved || null,
      underheat_ratio:  null,
      underheat_status: 'insufficient_data',
    };
  }
  const ratio = annualObserved / annualModelled;
  const status = ratio < TC_CONFIG.UNDERHEAT_RATIO_LOW  ? 'underheat'
               : ratio > TC_CONFIG.UNDERHEAT_RATIO_HIGH ? 'overheat'
               : 'match';
  return {
    annual_modelled_demand_kwh: annualModelled,
    annual_observed_demand_kwh: annualObserved,
    underheat_ratio:  ratio,
    underheat_status: status,
  };
}
```

**Step 1.5 — New helper `buildUnderheatNarrative`** producing the four pre-formatted strings per design § 2.5. Number formatting:
- kWh to nearest 100 via `Math.round(x / 100) * 100` then `.toLocaleString('en-GB')`
- percentage to nearest 1% via `Math.round((1 - ratio) * 100)` (deficit) or `Math.round(ratio * 100)` (raw)
- setpoint to one decimal via `setpointC.toFixed(1)`

The `insufficient_data` branch returns the empty string `''` (M10 hides the panel).

**Step 1.6 — Wire the new outputs into the result assembly.**
In `estimateThermalCharacter`, after `setpoint_c` and `thermal_mass_kj_per_k` are finalised but before the return statement, compute:
```javascript
const modelledByHh = computeModelledHeatingByHh(heating, external, heatLoss, setpoint_c);
const underheat    = computeUnderheatStatus(modelledByHh, heating, heatLoss?.boiler_efficiency_used ?? 0.9);
const narrative    = buildUnderheatNarrative(underheat, setpoint_c);
```
Append six fields to the returned `thermal_character` object: `modelled_heating_kwh_by_hh`, `annual_modelled_demand_kwh`, `annual_observed_demand_kwh`, `underheat_ratio`, `underheat_status`, `underheat_narrative`.

**Step 1.7 — Add tests M5.X1–M5.X7 to `test-m5.mjs`.** Synthetic inputs only; no real-data dependency. Use the existing test harness pattern (assertion helpers at top of the file).

| Test | Source | Asserts |
|------|--------|---------|
| M5.X1 | design § 2.6 | modelled = 1.75 kWh for HTC 250, ΔT 14, no solar |
| M5.X2 | design § 2.6 | solar gain 0.5 kWh subtracts cleanly → 1.25 kWh |
| M5.X3 | design § 2.6 | solar overshoot clamps to 0, never negative |
| M5.X4 | design § 2.6 | T_outdoor ≥ setpoint → modelled = 0 |
| M5.X5 | design § 2.6 | ratio thresholds: 0.7 → underheat, 1.0 → match, 1.3 → overheat |
| M5.X6 | design § 2.6 | HTC null → all-null array, underheat_status = 'insufficient_data' |
| M5.X7 | design § 2.6 | solar_correction_applied = false → solar gain treated as 0 |

**Step 1.8 — Regression run.**
Re-run `node test-m5.mjs` and `node test-m5b.mjs`. Both must report previous totals plus the new tests:
- `test-m5.mjs`: 26 + 7 = 33 assertions
- `test-m5b.mjs`: 29/29 (unchanged)

**Step 1.9 — Commit and push Phase 1.**
Commit message: `feat(m5): add comfort-demand diagnostic outputs (smart-scenario-fixes-1 phase 1)`.

---

### Phase 2 — M7 smart-scenario greedy LP (Fix 1, substitutive)

The riskiest phase. Replaces a substantial block of code; each step is independently verifiable.

**Step 2.1 — Delete obsolete code from `js/scenario-consumption.js`:**
- `discretiseStates`
- `nearestStateIndex`
- The entirety of `runDpForDay` — DP forward pass, dpCost/dpPrev/dpFuel matrices, runForwardPass closure, backtrack loop
- The DP-related branches inside `buildSmartScenario` — keep the function name and outer day-loop scaffolding for the next step
- `SC_CONFIG.N_STATES`, `T_RANGE_BELOW_SETPOINT`, `PREHEAT_OFFSET_HIGH_WARN_C`, `T_MAX_PREHEAT_OFFSET_DEFAULT`, `OCCUPANCY_THRESHOLD_DEFAULT` — no longer used after step 2.5

`computeStepEnergetics`, `requiredQDelivered`, `buildDayHhIndices`, `buildCurrentScenario`, `buildDumbHpScenario`, `buildHybridDumbScenario` are retained verbatim.

**Step 2.2 — Write `allocateGreedyDay` (private, replaces `runDpForDay`).**

Single helper used by both smart_hp_hh and hybrid_smart. Returns `{ q_delivered_thermal_kwh: number[], fuel_mode: ('hp'|'gas'|'none')[], elec_kwh_alloc: number[], gas_kwh_alloc: number[], hpUndersized: boolean }`.

```javascript
function allocateGreedyDay({
  scenario, dayIndices, heating, eta, copByHh, gasRateByHh, elecHhRateByHh,
  hpCapKw, isAbsence,
}) {
  const n = dayIndices.length;
  const cap = hpCapKw * 0.5;        // thermal kWh per HH at HP capacity

  // 1. Daily thermal budget B_d from observed gas heating × η, excluding absence HH
  let B_d = 0;
  for (const i of dayIndices) {
    const h = heating[i].heating_kwh;
    if (h != null && h > 0 && !isAbsence[i]) B_d += h * eta;
  }

  const elec_kwh_alloc = new Array(n).fill(0);
  const gas_kwh_alloc  = new Array(n).fill(0);
  const q_delivered    = new Array(n).fill(0);
  const fuel_mode      = new Array(n).fill('none');

  if (B_d <= 0) {
    return { q_delivered_thermal_kwh: q_delivered, fuel_mode,
             elec_kwh_alloc, gas_kwh_alloc, hpUndersized: false };
  }

  // 2. Per-HH unit cost + cap
  const isHybrid = scenario === 'hybrid_smart';
  const slots = [];
  for (let t = 0; t < n; t++) {
    const i        = dayIndices[t];
    const cop      = copByHh[i];
    const elecRate = elecHhRateByHh[i];
    const gasRate  = gasRateByHh[i];

    const hpCost  = (cop != null && elecRate != null) ? elecRate / cop : Infinity;
    const gasCost = (isHybrid && gasRate != null)     ? gasRate / eta  : Infinity;

    if (!isHybrid) {
      if (hpCost === Infinity) continue;                       // ineligible
      slots.push({ t, i, fuel: 'hp',  unitCost: hpCost,  capI: cap });
    } else {
      if (hpCost === Infinity && gasCost === Infinity) continue;
      if (hpCost <= gasCost) slots.push({ t, i, fuel: 'hp',  unitCost: hpCost,  capI: cap });
      else                   slots.push({ t, i, fuel: 'gas', unitCost: gasCost, capI: Infinity });
    }
  }

  // 3. Sort cheapest first, deterministic tiebreak by HH index
  slots.sort((a, b) => a.unitCost - b.unitCost || a.t - b.t);

  // 4. Greedy fill until B_d met
  let remaining = B_d;
  for (const s of slots) {
    if (remaining <= 0) break;
    const Q = Math.min(s.capI, remaining);
    q_delivered[s.t] = Q;
    fuel_mode[s.t]   = s.fuel;
    if (s.fuel === 'hp')  elec_kwh_alloc[s.t] = Q / copByHh[s.i];
    else                  gas_kwh_alloc[s.t]  = Q / eta;
    remaining -= Q;
  }

  // 5. Undersized fallback (smart_hp_hh only — hybrid gas pool has no cap)
  let hpUndersized = false;
  if (remaining > 1e-9 && !isHybrid) {
    hpUndersized = true;
    // Resistive backup at COP=1 in cheapest eligible HH
    const target = slots[0];
    if (target) {
      elec_kwh_alloc[target.t] += remaining;
      q_delivered[target.t]    += remaining;     // 1 kWh elec → 1 kWh heat at COP=1
      fuel_mode[target.t]       = 'hp';
    }
  }

  return { q_delivered_thermal_kwh: q_delivered, fuel_mode,
           elec_kwh_alloc, gas_kwh_alloc, hpUndersized };
}
```

The `slots` push for ineligible smart_hp_hh HH is `continue` (excluded entirely), matching design § 1.4 "For HH not allocated (or ineligible): elec_kwh = 0, gas_kwh = 0" and the absence-already-zeroed expectation.

Absence handling: design § 1.6 says absence HH excluded from `B_d` and from the allocation pool. Since absence HH have `heating_kwh = 0` or excluded by the `!isAbsence[i]` check at step 1, they contribute zero demand and never appear in `slots`. The output arrays remain at the zero default for those indices.

**Step 2.3 — Write `simulatePostHocTIndoor`** (chart-only, not load-bearing for cost):

```javascript
function simulatePostHocTIndoor({
  q_delivered_per_hh, external, heatLoss, thermalChar, T_init,
}) {
  const htc = heatLoss?.htc_w_per_k;
  const C   = thermalChar?.thermal_mass_kj_per_k;
  if (htc == null || C == null || thermalChar?.setpoint_c == null) {
    return { indoor_temp_c: q_delivered_per_hh.map(() => null), T_init_next: T_init };
  }

  const aperture = (heatLoss?.solar_correction_applied && heatLoss?.solar_aperture_m2 != null)
    ? heatLoss.solar_aperture_m2 : 0;

  const out = new Array(q_delivered_per_hh.length);
  let T = T_init;
  for (let i = 0; i < q_delivered_per_hh.length; i++) {
    const tc      = external[i]?.temp_c;
    const sw      = external[i]?.solar_w_m2 ?? 0;
    if (tc == null) { out[i] = T; continue; }   // carry forward at unknown outdoor temp

    const lossKwh  = htc * (T - tc) * 0.5 / 1000;
    const solarKwh = aperture * sw * 0.5 / 1000;
    const dT = (q_delivered_per_hh[i] + solarKwh - lossKwh) * 3600 / C;
    T += dT;
    out[i] = T;
  }
  return { indoor_temp_c: out, T_init_next: T };
}
```

Note `q_delivered_per_hh` is the **chronological** array over all HH (length 17,520-ish), not per-day. Day chaining of `T_init` is implicit because we walk the full series in order.

**Step 2.4 — Rewrite `buildSmartScenario`.** New signature, simpler body:

```javascript
function buildSmartScenario({
  scenario, heating, external, copByHh, hpCapKw,
  gasRateByHh, elecHhRateByHh, eta, isAbsence,
}) {
  const days = buildDayHhIndices(heating);
  const gas_kwh   = new Array(heating.length).fill(0);
  const elec_kwh  = new Array(heating.length).fill(0);
  const q_thermal = new Array(heating.length).fill(0);
  let anyHpUndersized = false;

  for (const { indices, skipDp } of days) {
    if (skipDp) {
      // Non-heating day per design § 1.4: arrays remain at the 0 init value.
      // Do NOT null these — M8 expects numeric arrays and design specifies zero.
      // q_thermal also stays at 0 from the outer init (post-hoc sim still applies
      // natural heat loss on top of zero delivery, which is physically correct).
      continue;
    }
    const day = allocateGreedyDay({
      scenario, dayIndices: indices, heating, eta,
      copByHh, gasRateByHh, elecHhRateByHh, hpCapKw, isAbsence,
    });
    if (day.hpUndersized) anyHpUndersized = true;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      gas_kwh[i]   = day.gas_kwh_alloc[k];
      elec_kwh[i]  = day.elec_kwh_alloc[k];
      q_thermal[i] = day.q_delivered_thermal_kwh[k];
    }
  }

  return { gas_kwh, elec_kwh, q_thermal, hpUndersized: anyHpUndersized };
}
```

Two key contract preservations:
- `dumb_hp_svt` and `dumb_hp_hh` continue sharing the same `dumbHp` object reference (the existing intentional T13 behaviour).
- Smart return shape preserved: `{ gas_kwh, elec_kwh, indoor_temp_c }` per scenario.

**Step 2.5 — Rewrite the entry point `estimateScenarioConsumption`.**

```javascript
export function estimateScenarioConsumption({
  heating, external, heatLoss, thermalCharacter, heatPumpModel,
  baseloadMethod, gasRateByHh, elecHhRateByHh,
  // No t_max_preheat_offset_c, no occupancy_threshold — removed.
}) {
  const warnings = [];
  const eta = heatLoss?.boiler_efficiency_used ?? 0.9;
  const copByHh = heatPumpModel?.cop_by_hh ?? new Array(heating.length).fill(null);
  const isAbsence = heating.map(h => !!h.is_absence);

  // Step 0 — early no_data
  if (baseloadMethod === 'no-gas' || heating.every(h => h.heating_kwh === null)) {
    const nullArr = () => heating.map(() => null);
    const nullScenario = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
    return {
      scenarios: {
        current: nullScenario, dumb_hp_svt: nullScenario, dumb_hp_hh: nullScenario,
        hybrid_dumb: nullScenario, smart_hp_hh: nullScenario, hybrid_smart: nullScenario,
      },
      validation_status: { dumb: 'no_data', smart: computeValidationStatusSmart(heatLoss, heatPumpModel) },
      warnings: ['No gas heating detected — heat pump scenarios cannot be modelled against an existing gas baseline.'],
    };
  }

  // Steps 1–3: dumb scenarios (unchanged)
  const current    = buildCurrentScenario(heating);
  const dumbHp     = buildDumbHpScenario(heating, copByHh, eta);
  const hybridDumb = buildHybridDumbScenario(heating, copByHh, eta, gasRateByHh, elecHhRateByHh);
  const dumbDiagnostics = dumbHp._diagnostics; delete dumbHp._diagnostics;

  // Step 4: smart scenarios (greedy LP)
  let smartStatus = computeValidationStatusSmart(heatLoss, heatPumpModel);
  let smartHpHh, hybridSmart;

  if (smartStatus === 'ok') {
    // hp_capacity_kw is guaranteed non-null here by computeValidationStatusSmart's
    // guard above. Do not fall back to Infinity — that would silently disable the
    // per-HH cap and let the greedy dump a day's heat into a single half-hour.
    const hpCap = heatPumpModel.hp_capacity_kw;

    const sm = buildSmartScenario({
      scenario: 'smart_hp_hh', heating, external, copByHh, hpCapKw: hpCap,
      gasRateByHh, elecHhRateByHh, eta, isAbsence,
    });
    const hb = buildSmartScenario({
      scenario: 'hybrid_smart', heating, external, copByHh, hpCapKw: hpCap,
      gasRateByHh, elecHhRateByHh, eta, isAbsence,
    });

    if (sm.hpUndersized) {
      smartStatus = 'hp_undersized';
      warnings.push('Heat pump capacity insufficient on some days at your current heating pattern; resistive backup applied at COP = 1.');
    }

    // Post-hoc T_indoor sims (chronological, day-chained implicitly)
    const smTinSim = simulatePostHocTIndoor({
      q_delivered_per_hh: sm.q_thermal, external, heatLoss,
      thermalChar: thermalCharacter, T_init: thermalCharacter.setpoint_c,
    });
    const hbTinSim = simulatePostHocTIndoor({
      q_delivered_per_hh: hb.q_thermal, external, heatLoss,
      thermalChar: thermalCharacter, T_init: thermalCharacter.setpoint_c,
    });

    smartHpHh   = { gas_kwh: sm.gas_kwh, elec_kwh: sm.elec_kwh, indoor_temp_c: smTinSim.indoor_temp_c };
    hybridSmart = { gas_kwh: hb.gas_kwh, elec_kwh: hb.elec_kwh, indoor_temp_c: hbTinSim.indoor_temp_c };

    // Concentrated-heating note (design § 1.5): inspect post-hoc indoor for overshoot.
    // Filter to HH where heat was actually delivered. Without this filter, summer days
    // where the building naturally tracks 22–28°C outdoor temperatures would trigger
    // the warning despite no smart-schedule activity, making the warning text
    // ("schedule concentrates heating into low-cost periods") misleading.
    const overshoot = sm.q_thermal.some((q, idx) => {
      if (q == null || q <= 0) return false;
      const t = smTinSim.indoor_temp_c[idx];
      if (t == null || thermalCharacter.setpoint_c == null) return false;
      return t > thermalCharacter.setpoint_c + 3.0;
    });
    if (overshoot) {
      warnings.push('Smart-HP schedule concentrates heating into low-cost periods; in practice your thermostat would moderate this.');
    }
  } else {
    const nullArr = () => heating.map(() => null);
    smartHpHh   = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
    hybridSmart = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
  }

  return {
    scenarios: {
      current,
      dumb_hp_svt: dumbHp,
      dumb_hp_hh:  dumbHp,        // shared ref preserved (T13)
      hybrid_dumb: hybridDumb,
      smart_hp_hh: smartHpHh,
      hybrid_smart: hybridSmart,
    },
    validation_status: {
      dumb:  computeValidationStatusDumb(dumbDiagnostics, baseloadMethod),
      smart: smartStatus,
    },
    warnings,
  };
}
```

**Step 2.6 — Update `computeValidationStatusSmart`.**

```javascript
function computeValidationStatusSmart(heatLoss, heatPumpModel) {
  if (heatLoss?.htc_w_per_k == null) return 'insufficient_data';
  if (heatPumpModel?.hp_capacity_kw == null) return 'insufficient_data';
  return 'ok';
}
```

The new algorithm anchors smart demand to observed heating, so thermal mass, setpoint, and occupancy weights are no longer required for the cost arrays. They are only needed for the post-hoc T_indoor sim (which gracefully nulls `indoor_temp_c` if absent). Codes per design § 1.3: `'ok'`, `'insufficient_data'` (htc null OR hp_capacity null OR heating_kwh all-null), `'hp_undersized'` (set inside `estimateScenarioConsumption` after the greedy run, not by this guard). The previous `'no_htc'`, `'no_thermal_mass'`, `'no_setpoint'` codes are removed. Consumers (app.js) must be updated in step 3.9.

**Step 2.7 — Update the orchestration call site in `js/app.js`.**

Find `runScenarioConsumption` (or wherever `estimateScenarioConsumption` is called). Remove the `t_max_preheat_offset_c` and `occupancy_threshold` parameters from the call. They are no longer present on the function signature.

The `Heat to Comfort` slider added in Phase 3 introduces a new optional parameter `comfort_demand_scale` — that is wired in step 3.6, not here.

**Step 2.8 — Rewrite `test-m7.mjs`.**

Per design § 1.7:

- **Retain unchanged:** Tests 1, 2, 3, 4 (dumb HP and hybrid dispatch), 10 (non-heating day skip), 12 (current scenario).
- **Demote to post-hoc-sim coverage:** Tests 5, 6 (RC unit checks). Same arithmetic, target moves from optimiser to `simulatePostHocTIndoor`.
- **Remove:** Test 7 (DP comfort constraint).
- **Rewrite:** Tests 8 (greedy fills cheapest first), 9 (post-hoc day chaining), 11 (null thermal_mass passthrough now allows smart cost arrays).
- **Add:** Tests 13 (Smart ≤ Dumb invariant), 14 (daily heat-budget conservation), 15 (HP undersized warning), 16 (hybrid_smart prefers HP at cheap HP HH).

Test 13 and Test 14 are the regression gates. Test 13 runs on a synthetic dataset with intra-day rate variance and sufficient HP capacity; assertion is `total_cost(smart_hp_hh) <= total_cost(dumb_hp_hh)` (computed from the M7 outputs × constant rate stub — full M8 not invoked). Test 14 sums `q_delivered_thermal` across each day's HH and asserts `|sum − B_d| < 0.01 kWh`.

Final count: 27 → 23 + 4 new = 27 (rough — exact count emerges from the rewrite).

**Step 2.9 — Validation gate before merge.** Run `node test-m7.mjs`. All assertions must pass. Then run `node test-m5.mjs`, `node test-m5b.mjs`, `node test-m6.mjs`, `node test-m8.mjs`, `node test-m9.mjs` to confirm no regression in adjacent modules (all consume M7 outputs by shape; shape is preserved).

**Step 2.10 — Commit and push Phase 2.**
Commit message: `refactor(m7): replace DP optimiser with per-day greedy LP (smart-scenario-fixes-1 phase 2)`.

---

### Phase 3 — M10 UI additions (Fix 3)

**Step 3.1 — Remove obsolete UI controls in `index.html`.**

In the M7 scenario card (`#scenario-card`, around line 271), remove the entire `#scenario-controls` block (preheat-offset slider, occupancy-threshold slider, and their help text). The card still surfaces results; it just no longer takes user inputs.

**Step 3.2 — Remove obsolete wiring in `js/app.js`.**

Find references to `preheatOffsetSlider`, `occupancyThresholdSlider`, `preheat-offset`, `occupancy-threshold` and their event handlers. Remove the DOM references and any code that reads their `.value` for the M7 call. `runScenarioConsumption` no longer takes these.

**Step 3.3 — Add the underheating diagnostic sub-panel to Your Home.**

Locate the Your Home section banner in `index.html`. The M10a layout (per design § 3.1) places this panel between "Building thermal character" and "Smart tariff potential". Use the existing `.results-summary` wrapper class on the inner div so the existing CSS grid rule applies and we avoid new CSS coupling. Insert:

```html
<section class="card hidden" id="underheat-card">
  <h2>Heating to comfort</h2>
  <div class="results-summary" id="underheat-content">
    <dl>
      <dt>Annual heat consumption (observed)</dt>
      <dd><span id="underheat-observed">—</span> kWh thermal</dd>
      <dt>Modelled comfort demand at <span id="underheat-setpoint">—</span>°C</dt>
      <dd><span id="underheat-modelled">—</span> kWh thermal</dd>
      <dt>Ratio</dt>
      <dd><span id="underheat-ratio-value">—</span><span class="underheat-light" id="underheat-light"></span></dd>
    </dl>
    <p class="underheat-narrative" id="underheat-narrative"></p>
  </div>
</section>
```

**Step 3.4 — Add traffic-light styling to `css/styles.css`:**

```css
.underheat-light {
  display: inline-block;
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
  margin-left: 0.5rem;
  vertical-align: middle;
}
.underheat-light.green  { background: #2E7D32; }
.underheat-light.amber  { background: #F57F17; }
.underheat-narrative {
  font-size: 0.9rem;
  color: var(--colour-dark);
  margin-top: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--colour-light-grey);
  border-left: 3px solid var(--colour-teal);
  border-radius: 0 var(--radius) var(--radius) 0;
}
```

**Step 3.5 — Add render function `displayUnderheatPanel(thermalCharacter)` in `js/app.js`.**

```javascript
function displayUnderheatPanel(tc) {
  const card = document.getElementById('underheat-card');
  if (!tc || tc.underheat_status === 'insufficient_data') {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  const fmtKwh = v => Math.round(v / 100) * 100;
  document.getElementById('underheat-observed').textContent = fmtKwh(tc.annual_observed_demand_kwh).toLocaleString('en-GB');
  document.getElementById('underheat-modelled').textContent = fmtKwh(tc.annual_modelled_demand_kwh).toLocaleString('en-GB');
  document.getElementById('underheat-setpoint').textContent = tc.setpoint_c.toFixed(1);
  document.getElementById('underheat-ratio-value').textContent = `${Math.round(tc.underheat_ratio * 100)}%`;

  const light = document.getElementById('underheat-light');
  light.className = 'underheat-light ' + (tc.underheat_status === 'match' ? 'green' : 'amber');

  document.getElementById('underheat-narrative').textContent = tc.underheat_narrative;
}
```

Call from the M5 display chain (immediately after `displayThermalCharacterResults(result)` or wherever the M5 card finalises).

**Step 3.6 — Add the Heat to Comfort slider (What If section).**

In `index.html`, inside the What If banner, add:

```html
<div class="form-group" id="heat-to-comfort-group">
  <label for="heat-to-comfort">Heat to comfort temperature
    <span class="unit">% of modelled demand</span>
  </label>
  <input id="heat-to-comfort" type="range" min="0" max="150" step="5" value="100">
  <output id="heat-to-comfort-value">100</output>
  <p class="form-hint">
    100% = the modelled demand to keep your home at setpoint year-round.
    Lower values match your current usage pattern; higher values explore consistent extra heating.
  </p>
</div>
```

The default value and the slider's visibility are set dynamically at panel render time. **When `underheat_ratio` is null** (M5 returned `underheat_status === 'insufficient_data'`), the entire `#heat-to-comfort-group` is hidden and the M7 call uses no `comfort_demand_scale` (so smart scenarios reflect observed demand verbatim). Otherwise, default = `Math.min(150, Math.max(0, Math.round(underheat_ratio * 100)))` — i.e. the slider starts at "match your current usage". The `value="100"` in HTML is just a fallback for cases where the JS hook hasn't run.

**Step 3.7 — Wire the slider in `js/app.js`.**

Add a `setupHeatToComfortSlider(thermalCharacter)` helper that hides the slider group when `underheat_ratio` is null and otherwise sets the default value. Call it from the M5 display chain alongside `displayUnderheatPanel(thermalCharacter)`.

```javascript
function setupHeatToComfortSlider(thermalCharacter) {
  const group  = document.getElementById('heat-to-comfort-group');
  const slider = document.getElementById('heat-to-comfort');
  const output = document.getElementById('heat-to-comfort-value');
  const ratio  = thermalCharacter?.underheat_ratio;

  if (ratio == null) {
    group.classList.add('hidden');
    return;
  }
  group.classList.remove('hidden');

  const defaultPct = Math.min(150, Math.max(0, Math.round(ratio * 100)));
  slider.value = defaultPct;
  output.value = defaultPct;
}

const heatToComfortSlider = document.getElementById('heat-to-comfort');
const heatToComfortValue  = document.getElementById('heat-to-comfort-value');
heatToComfortSlider.addEventListener('input', () => {
  heatToComfortValue.value = heatToComfortSlider.value;
});
heatToComfortSlider.addEventListener('change', async () => {
  await runScenarioConsumption(() => {}, () => {});  // re-run M7 with adjusted scale
  await runPricingEngine(() => {}, () => {});         // re-run M8 against new M7 outputs
  await runFinancialAnalysis(() => {}, () => {});     // re-run M9 + verdict + chart
});
```

**Step 3.8 — Plumb `comfort_demand_scale` into the M7 call.**

Modify `estimateScenarioConsumption` signature (Step 2.5) to accept an optional `comfort_demand_scale` parameter (default `1.0`). Inside the smart-scenario branch:

```javascript
const ratio = thermalCharacter?.underheat_ratio;
// Defensive: when ratio is null the slider is hidden in step 3.7 and the slider
// group element carries the .hidden class, so comfort_demand_scale should not be
// passed in. Belt-and-braces: if it is passed in by mistake, scale stays at 1.
const scale = (comfort_demand_scale != null && ratio != null)
  ? (comfort_demand_scale / 100) / Math.max(ratio, 0.001)
  : 1.0;
```
Apply `scale` to `B_d` inside `allocateGreedyDay` — multiply observed `B_d` by `scale`. When the slider is at the default value (`underheat_ratio × 100`), `scale === 1` and behaviour is unchanged.

Wire `runScenarioConsumption` in app.js to read the slider value and pass it through **only when** `underheat_ratio != null` (i.e. the slider group is visible). When ratio is null, omit the parameter entirely so M7 falls through to the default `1.0`.

**Step 3.9 — Surface `hp_undersized` warning.**

In `displayScenarioResults` (or wherever validation_status is rendered), if `validation_status.smart === 'hp_undersized'`, append a `.status-msg.warning` div under the cost comparison reading per design § 3.3. Use the actual undersized-day count if M7 surfaces it; otherwise the warning text from the M7 `warnings[]` array can be reused.

**Step 3.10 — Browser smoke test.** Open `index.html` locally:
- Run a known pipeline (Rhiannon's data) end-to-end.
- Confirm the underheating panel renders with sensible numbers.
- Confirm the Heat to Comfort slider triggers a re-run and updates the verdict, chart, and pricing tables.
- Confirm no console errors. Confirm the pre-heat ceiling and occupancy threshold sliders are gone.

**Step 3.11 — Commit and push Phase 3.**
Commit message: `feat(m10): underheating diagnostic + Heat to Comfort slider (smart-scenario-fixes-1 phase 3)`.

---

### Phase 4 — Documentation updates (Fix 4)

This phase covers heatpump-analyser-side documentation only. Edits to praxis-claude-hub files (`architecture.md`, `scope.md`, the parent design doc's Status flip from DRAFT to IMPLEMENTED) are explicitly **out of scope** for this plan — Opus owns those and applies them post-launch as cleanup, once code is verified on Rhiannon's real-data dataset and Rhiannon has confirmed the result.

**Step 4.1 — Update `CLAUDE.md` (heatpump-analyser).** Append a Status line summarising the three fixes and noting that the M7 design has been amended via `design/smart-scenario-fixes-1.md` (parent-design path in praxis-claude-hub). (Project Identity section.)

**Step 4.2 — Update `~/Documents/git-repos/claude-coding-hub/context/heatpump-memory.md`.** Add the three commits and their summaries (this is the standard CLAUDE.md "After every commit" workflow — operational territory, not a cross-repo design edit).

**Step 4.3 — Commit and push Phase 4.**
Commit message: `docs: CLAUDE.md status — smart-scenario-fixes-1 implemented`.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Phase 2 breaks adjacent modules (M5, M6, M8, M9) by changing M7 output shape | Output shape is preserved verbatim (`{ gas_kwh, elec_kwh, indoor_temp_c }` per scenario; same scenario keys; `dumb_hp_svt`/`dumb_hp_hh` shared reference preserved). Step 2.9 runs all adjacent test suites as a regression gate before merge. |
| Greedy LP produces materially different costs from the previous DP, but in unexpected directions on real data | Test 13 (Smart ≤ Dumb invariant) is the design's stated regression gate. Failure on Rhiannon's real data is a hard halt — flag to Opus, do not proceed. |
| Per-HH gas profile in `hybrid_smart` looks unrealistic (one HH delivers all gas) | Documented in design § 1.4 as acceptable for v1 — only daily/annual totals surface to the user; per-HH gas profile is not displayed. |
| Heat to Comfort slider re-run takes too long (> 1 s perceived latency) | Design § 3.2 estimates < 100 ms for the per-day greedy LP. If real-data run exceeds 500 ms, profile and either debounce slider input or move M7 into a Worker. Halt-and-flag rather than ship a sluggish UI. |
| Removing the comfort/preheat sliders without removing all references leaves dangling DOM lookups | Step 3.2 enumerates the DOM references and event handlers. Browser console errors at step 3.10 would catch a missed reference. |
| Underheat panel renders with wrong unit/sign because of `boiler_efficiency_used` placement | Test M5.X1 (units cross-check, single HH) and M5.X5 (ratio) are designed to catch this. Test M5.X4 catches sign errors at temp ≥ setpoint. |
| `underheat_ratio` near zero (almost no heating data) produces unhelpful narrative or div-by-zero | Step 1.4 guards `annualModelled === 0` → `'insufficient_data'` → narrative is empty string → M10 hides the panel. |
| Heat to Comfort slider with `underheat_ratio = null` (panel hidden) gives a bad default | If `underheat_ratio` is null, hide the slider too. Step 3.6 should mirror the panel's hidden state. |
| `t_max_preheat_offset_c` / `occupancy_threshold` removal cascades into other tests | Search for these symbol names across the repo before deletion. Tests in `test-m7.mjs` are the only known consumers; design § 1.7 expects them to be rewritten anyway. |
| M5 thermal_character tests for older paths regress because the M5 entry point changed signature | Step 1.1 requires verifying M5's existing input shape. The change is purely additive to outputs — no signature change to inputs. Existing tests pass through unchanged. |
| Sequencing: doing M10 changes before the M7 algorithm rewrite means UI breaks midway | Phasing enforces order: Phase 2 (M7) before Phase 3 (M10). Each phase is independently committed and the build remains usable between phases. |

---

## Success criteria

### Phase 1 (M5 diagnostic)

- [ ] `js/thermal-character.js` exports the same function signature; result object gains 5 new fields per design § 2.3
- [ ] `node test-m5.mjs` reports 33/33 passing (26 existing + 7 new)
- [ ] `node test-m5b.mjs` reports 29/29 passing (regression unchanged)
- [ ] Phase 1 commit pushed; CLAUDE.md status updated

### Phase 2 (M7 rewrite)

- [ ] DP infrastructure removed from `js/scenario-consumption.js` (no `dpCost`, `dpPrev`, `dpFuel`, `T_states`, `nearestStateIndex`, `discretiseStates`, `runDpForDay`)
- [ ] `allocateGreedyDay`, `simulatePostHocTIndoor`, and rewritten `buildSmartScenario` present
- [ ] `validation_status.smart` codes: `'ok'`, `'insufficient_data'`, `'hp_undersized'` (no others)
- [ ] `node test-m7.mjs` reports all assertions passing — including new tests 13, 14, 15, 16
- [ ] `node test-m5.mjs`, `test-m5b.mjs`, `test-m6.mjs`, `test-m8.mjs`, `test-m9.mjs` report unchanged regression status
- [ ] On Rhiannon's real-data dataset: `total_cost(smart_hp_hh) < total_cost(dumb_hp_hh)` strictly
- [ ] On Rhiannon's real-data dataset: `total_cost(hybrid_smart) ≤ total_cost(hybrid_dumb)`
- [ ] Phase 2 commit pushed

### Phase 3 (M10 UI)

- [ ] `#scenario-controls` removed from `index.html`; corresponding DOM references and event handlers removed from `js/app.js`
- [ ] Underheating sub-panel renders inside Your Home for at least one underheat case, one match case, one overheat case (synthetic if needed)
- [ ] Heat to Comfort slider triggers M7→M8→M9→verdict re-run; visible result changes within ~500 ms on Rhiannon's data
- [ ] `hp_undersized` warning surfaces under the cost comparison when `validation_status.smart === 'hp_undersized'`
- [ ] No console errors during a full pipeline run; no broken DOM lookups
- [ ] Phase 3 commit pushed

### Phase 4 (docs)

- [ ] `CLAUDE.md` (heatpump-analyser) Status line updated
- [ ] `heatpump-memory.md` (claude-coding-hub) records all four phase commits

(praxis-claude-hub edits — `architecture.md`, `scope.md`, parent design doc Status flip — are out of scope for this plan; Opus applies them post-launch once Rhiannon confirms the real-data result.)

### Pre-launch validation gates (per design § "Pre-launch validation gates")

- [ ] Smart_HP_HH cost < Dumb_HP_HH cost on Rhiannon's data (strict inequality)
- [ ] Hybrid_smart cost ≤ Hybrid_dumb cost on Rhiannon's data
- [ ] Daily heat-budget conservation (test 14) passes for every day where `validation_status.smart == "ok"`
- [ ] Underheat narrative renders correctly for synthetic underheat / match / overheat cases

---

## Opus Review — 2026-04-28

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-28
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/smart-scenario-fixes-1.md` (DRAFT — pending Rhiannon's approval after relaunch)

### Context

Plan was raised on launch day (2026-04-28) in response to a defect in deployed M7: `Smart_HP_HH > Dumb_HP_HH` in cost, contradicting the by-definition optimiser invariant. Diagnosis attributed the gap to a heat-demand baseline mismatch — dumb used observed `heating_kwh × η`, smart used a DP over RC simulation with comfort constraint, and the modelled comfort demand exceeded observed for any household that underheats. The amendment design rebases smart onto observed daily heat budgets via a per-day greedy LP and repurposes the modelled-demand calculation as an M5 underheating diagnostic (with a Heat to Comfort slider). The plan transcribes the design faithfully overall but introduced four silent-failure modes plus three workflow/protocol issues that needed correction before implementation.

### What is solid

- Phasing is correct and minimises blast radius: Phase 1 (additive M5) → Phase 2 (substitutive M7) → Phase 3 (UI) → Phase 4 (docs). The build remains usable between phases.
- `allocateGreedyDay` transcription matches design § 1.4: deterministic HH-index tiebreak, hybrid HP-vs-gas dispatch with HP-only capacity cap, resistive backup at COP=1 in cheapest eligible HH (with `q_thermal` tracked separately so the post-hoc sim doesn't double-count via `cop_by_hh`).
- New tests 13 (Smart ≤ Dumb invariant) and 14 (heat-budget conservation) are exactly the regression gates that would have caught the original launch bug, and Step 2.9 runs all adjacent module tests as a regression check before merge.
- Existing helpers (`computeStepEnergetics`, `requiredQDelivered`, `buildDayHhIndices`, `buildCurrentScenario`, `buildDumbHpScenario`, `buildHybridDumbScenario`) explicitly retained, and the output contract (`{ gas_kwh, elec_kwh, indoor_temp_c }` per scenario, plus the `dumb_hp_svt`/`dumb_hp_hh` shared-reference T13 behaviour) is preserved.
- Risks table is honest about the unknowns (real-data behaviour of the greedy, slider latency, dangling DOM references) and includes Test 13 as a hard halt on real data.

### Required changes for implementation

1. **Non-heating-day arrays must be zero, not null.** Step 2.4's `skipDp` branch was nulling `gas_kwh[i]` and `elec_kwh[i]`, but design § 1.4 explicitly requires zero (and the in-flight `B_d ≤ 0` path inside `allocateGreedyDay` already returns zeros — same physical condition was producing inconsistent outputs).
2. **`hp_capacity_kw` null must block smart, not silently default to `Infinity`.** Step 2.5's `?? Infinity` fallback would let the greedy dump a day's heat into a single HH with no flag if M6 returned null capacity (e.g. setpoint inference failed).
3. **Overshoot warning must filter to HH where heat was actually delivered.** The original `.some(v > setpoint + 3)` would fire on summer outdoor temperatures too (no heat delivered, indoor naturally tracks 22–28°C), making the warning text about "schedule concentrating heating" misleading on every real-data run.
4. **Heat to Comfort slider must hide when `underheat_ratio` is null.** Step 3.6 set `slider.value = Math.round(null * 100) = 0`, which would scale every day's `B_d` to zero and silently corrupt smart cost output. The plan's risks table flagged this but the implementation step didn't realise the fix.
5. **`validation_status.smart` codes must match design.** Plan returned `'no_htc'`; design § 1.3 specifies `'insufficient_data'`. Folded into change 2 above.
6. **`computeUnderheatStatus` must handle `annualObserved == 0`.** The original guard caught null/zero modelled, but a household with zero observed heating (baseload separation found no signal) and non-zero modelled produced ratio = 0 → status `'underheat'` → narrative reading "you used around 0 kWh — about 100% less", which is a UI bug.
7. **Phase 4 cross-repo edits dropped.** Plan had Sonnet editing `architecture.md`, `scope.md`, and the parent design doc's Status field — all in `praxis-claude-hub` (Opus territory). The amendment design is still DRAFT pending Rhiannon's post-launch sign-off, and the architecture/scope rollup was explicitly deferred to post-launch cleanup. Opus applies these separately after relaunch.

### Minor observations (corrected inline)

- **L1.** Step 2.1 listed explicit line numbers ("lines ~26–33"), violating the planner protocol's "no line numbers" rule. Symbol references retained; line numbers stripped.
- **L2.** Step 1.6 prose said *"Append five fields"* but the code adds six. Corrected to "six".
- **L3.** Step 3.3 included two HTML snippets for the underheat panel with prose between explaining the second supersedes the first. Collapsed to a single canonical snippet using the `.results-summary` wrapper.

### Resolution of review changes

1. **Non-heating-day zero, not null** — Step 2.4 `skipDp` branch now `continue`s without assignment; arrays remain at the 0 init.
2. **hp_capacity_kw guard** — `computeValidationStatusSmart` now takes both `heatLoss` and `heatPumpModel`; returns `'insufficient_data'` if either `htc_w_per_k` or `hp_capacity_kw` is null. Both call sites updated. `hpCap` dereferenced directly (no `?? Infinity`) under the now-guaranteed-`ok` branch.
3. **Overshoot filter** — Now iterates `sm.q_thermal.some((q, idx) => q > 0 && smTinSim.indoor_temp_c[idx] > setpoint + 3)`; comment explains the rationale.
4. **Slider hide-when-null** — Added `setupHeatToComfortSlider(thermalCharacter)` helper in Step 3.7, called from the M5 display chain. Step 3.6 prose updated to specify hide-when-null and dynamic default. Step 3.8 conditional plumbing (`comfort_demand_scale` omitted when ratio null) with a defensive double-guard on `scale = 1.0`.
5. **validation_status string** — Folded into change 2 (`'insufficient_data'` everywhere); Phase 2 success criteria updated to reflect the new code set.
6. **annualObserved == 0 → insufficient_data** — Extended Step 1.4 `computeUnderheatStatus` early-return guard to `!annualModelled || annualModelled === 0 || !annualObserved || annualObserved === 0`.
7. **Phase 4 cross-repo edits dropped** — Steps 4.1, 4.2, 4.5 removed; Files-to-modify table and Phase 4 success criteria updated; explanatory note added at the head of Phase 4 stating Opus owns the praxis-hub edits post-launch.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | ✓ pass |
| HIGH     | 4     | ✅ resolved (changes 1–4) |
| MEDIUM   | 3     | ✅ resolved (changes 5–7) |
| LOW      | 3     | ✅ resolved inline (L1–L3) |

Verdict: **APPROVE WITH EDITS** — algorithm transcription is faithful to the design; required changes addressed silent-failure modes and a workflow boundary issue. No structural rework needed.

---

## Approval

**Status:** ⚠ Approved with edits — 2026-04-28
**Approved by:** Rhiannon (via Opus review)
**Approval date:** 2026-04-28
**Clarifications confirmed:**
- Smart ≤ Dumb invariant restored by anchoring smart B_d to observed daily totals (per design § 1.4, replacing the DP+RC+comfort-constraint optimiser).
- Cross-repo praxis-hub edits remain Opus's responsibility post-launch.
- Plan amendment is the deliverable; no separate review document.

---

## Implementation Deviations

### Phase 1

**D1 — test-m5.mjs: 13 new assertions instead of estimated 7 (total 39 vs 33)**
Tests M5X1, M5X5, and M5X6 each expanded into multiple sub-assertions (a/b, a/b/c, a/b/c/d respectively) to cover array-level checks alongside scalar checks. More coverage, not less. No production code change.

### Phase 2

**D2 — test-m7.mjs T18b: warning keyword broadened to "insufficient" as well as "undersized"**
The hp_undersized warning text reads "Heat pump capacity insufficient on some days…" — it contains "insufficient" but not "undersized". The T18b assertion was updated to match either keyword. The warning text itself was not changed; it accurately describes the condition.
