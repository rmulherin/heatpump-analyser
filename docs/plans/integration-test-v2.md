# integration-test-v2 — End-to-end reconciliation invariant assertions

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Phase 5: write the end-to-end integration test suite that asserts the reconciliation
invariants I1–I5 (integration-v2 §1) and the data-sufficiency gates (§6) hold across
the full pipeline on synthetic and real data.

This is the final plan in the v2 build. It does not add user-facing functionality.

Design doc: `ui-overhaul-integration-v2.md` §§1–2. All module plans (m1–m9 v2, all UI
plans) must be implemented before this plan runs.

**Invariants to assert:**

| # | Invariant | Identity |
|---|---|---|
| I1 | Cost reconciliation | §3 verdict bars = §11a Totals = §12a saving-deltas |
| I2 | SCOP single-source | §4d = §10g = §15d = m6 `annual_mean_cop` (committed value) |
| I3 | Six-component cost identity | Σ(Gas/Elec × Heat/Non-Heat/Fixed) = scenario `annual_cost_gbp` |
| I4 | m9 Total-saving identity | `(current_flat − smart_hp_hh)` = tariff + hp_heating + smart_shift |
| I5 | RC ↔ HTC reconciliation | m7 RC uses `internal_gains_w_used` + `net_flow_w` from m4 (single-source) |

Additional gate tests:
- 90-day load gate (m1).
- Seasonal sufficiency: hard-stop on insufficient heating days (m4 null HTC); soft caveat
  on insufficient summer days (m3 Method-E).
- Null degradation chain: `thermal_mass = null` → smart null → UI "—" never "£0".
- `standing_charge_gbp` consumed by m9, never re-derived.

---

## Research findings

**Test infrastructure:** the project uses `.mjs` test files run with `node {file}`.
The existing pattern (see `test-m7a.mjs`, `test-m8m9.mjs` etc.) creates synthetic
inputs, calls module functions directly, and asserts with `console.assert` + exit-code
reporting. Integration tests require wiring multiple modules in sequence.

**Synthetic dataset:** one full-year (17,520 HH) minimal synthetic dataset is sufficient
for most invariant checks. Use the test data synthesiser (`scripts/synthesise.mjs`) with
the `modern-out-for-work` archetype (a well-behaved baseline), or generate a minimal
in-test array. For I5 reconciliation, exact numerical equality is within floating-point
tolerance (±0.001 kWh / ±£0.01).

**Real-data sanity (I1):** the design doc lists a predictive test on Rhiannon's data
(current_flat ≈ £2,000). This cannot run in automated CI (Octopus API key required).
Mark as `// MANUAL: run with real data` and document expected ranges.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `test-integration.mjs` | End-to-end invariant assertions on synthetic + real data |

---

## Implementation steps

### Step 1 — Synthetic pipeline runner

Build a thin `runFullPipeline(syntheticInputs)` helper in `test-integration.mjs` that:
1. Calls `estimateBaseloadSeparation` (m3-v2 equivalent).
2. Calls `estimateHeatLoss` (m4-v2).
3. Calls `estimateThermalCharacter` (m5-v2).
4. Calls `estimateHeatPumpModel` (m6-v2).
5. Calls `estimateScenarioConsumption` (m7a+m7b).
6. Calls `prepareRates` + `computeCosts` (m8-v2).
7. Calls `analyseFinancials` (m9-v2).

Returns `{ m3, m4, m5, m6, m7, m8, m9 }`.

Uses the `modern-out-for-work` baked CSV or a generated 17,520-row synthetic array.

### Step 2 — I1: Cost reconciliation

```js
// §3 bars = §11a Totals: m8 annual_cost_gbp is the single source
for (const key of ['current_flat','current_hh','std_hp_flat','std_hp_hh','smart_hp_hh']) {
  const m8Cost = m8.scenarios[key]?.annual_cost_gbp;
  const sum6   = Object.values(m8.scenarios[key].components).reduce((s,v)=>s+(v??0), 0);
  assert(Math.abs((m8Cost ?? 0) - sum6) < 0.01, `I1 six-component sum: ${key}`);
}
// §12a saving delta
const cfCost   = m8.scenarios.current_flat.annual_cost_gbp;
const smartCost= m8.scenarios.smart_hp_hh?.annual_cost_gbp;
if (smartCost != null) {
  const totalSaving = cfCost - smartCost;
  const decomposed  = (m9.tariff_saving_gbp ?? 0)
                    + (m9.headline.hp_heating_component_gbp ?? 0)
                    + (m9.smart_shift_saving_gbp ?? 0);
  assert(Math.abs(totalSaving - decomposed) < 0.01, 'I4 decomposition identity');
}
```

### Step 3 — I2: SCOP single-source

```js
// After Recalculate, m6.annual_mean_cop is the canonical value
// The §15 live readout must match it post-commit (test via module, not DOM)
const scop_m6 = m6.annual_mean_cop;
// Re-derive SCOP using m6's formula on m7's heating hours
let sumWtd = 0, sumQ = 0;
m7.scenarios.dumb_hp.components.elec_space_heat.forEach((q, i) => {
  if ((q ?? 0) <= 0 || ext[i]?.temp_c == null) return;
  sumWtd += q * interpolateCopCurve(m6.cop_curve_points, ext[i].temp_c);
  sumQ   += q;
});
const scop_recomputed = sumQ > 0 ? sumWtd / sumQ : null;
assert(scop_recomputed != null && Math.abs(scop_m6 - scop_recomputed) < 0.01,
  'I2 SCOP single-source: m6 formula matches re-derived');
```

### Step 4 — I3: Six-component identity (per scenario, both fuels)

```js
for (const key of SCENARIO_ORDER_V2) {
  const s = m8.scenarios[key];
  if (!s) continue;
  const gasSum  = (s.components.gas_heat_gbp ?? 0) + (s.components.gas_nonheat_gbp ?? 0) + (s.components.gas_fixed_gbp ?? 0);
  const elecSum = (s.components.elec_heat_gbp ?? 0) + (s.components.elec_nonheat_gbp ?? 0) + (s.components.elec_fixed_gbp ?? 0);
  assert(Math.abs(s.annual_cost_gbp - gasSum - elecSum) < 0.01, `I3: ${key}`);
  assert(Math.abs(s.gas_energy_cost_gbp - (s.components.gas_heat_gbp + s.components.gas_nonheat_gbp)) < 0.01, `I3 gas: ${key}`);
  assert(Math.abs(s.standing_charge_gbp - (s.components.gas_fixed_gbp + s.components.elec_fixed_gbp)) < 0.01, `I3 sc: ${key}`);
}
```

### Step 5 — I5: RC ↔ HTC reconciliation (single-source)

Verify that m7 consumed m4's `internal_gains_w_used` (not re-derived):

```js
// Structural assertion: m7 output was produced using m4's internal_gains_w_used.
// We cannot see inside the function, so verify consistency:
// If m7 RC uses m4's exact internal_gains, then over the year the mean RC-derived
// indoor temp should track the winter setpoint (the back-calc closed this balance).
// Use the current.indoor_temp_c annual mean during heating hours.
const heatingHours = m7.scenarios.current.indoor_temp_c
  .filter((t, i) => t != null && (m7.scenarios.current.components.gas_space_heat[i] ?? 0) > 0);
if (heatingHours.length > 500) {
  const meanT = heatingHours.reduce((s,t)=>s+t,0) / heatingHours.length;
  const setpt = m5.setpoint_c ?? 20;
  assert(Math.abs(meanT - setpt) < 3.0,
    `I5 RC consistency: heating-hour mean indoor temp ${meanT.toFixed(1)}°C vs setpoint ${setpt}°C (within 3°C)`);
}
```

> This is a consistency check, not an exact equality test. A deviation >3°C would indicate
> incorrect RC source terms (likely missing internal_gains or net_flow).

### Step 6 — Standing charge: m9 consumes m8, never re-derives

```js
// m9 must NOT compute standing charge independently.
// Assert the m9 net-saving arithmetic uses m8's standing_charge_gbp value.
// Indirect check: m9 per-scenario totals = m8 totals (same source).
for (const key of ['std_hp_flat', 'std_hp_hh', 'smart_hp_hh']) {
  const m9Annual = m9.scenarios[key]?.annual_cost_gbp;
  const m8Annual = m8.scenarios[key]?.annual_cost_gbp;
  if (m9Annual != null && m8Annual != null) {
    assert(Math.abs(m9Annual - m8Annual) < 0.01, `SC single-source: m9 echoes m8 for ${key}`);
  }
}
```

### Step 7 — Null degradation chain

```js
// Force thermal_mass = null → smart scenario null → m8 smart null → m9 smart null → UI "—" not "£0"
const m7Null = runScenarioConsumptionWithNullMass();
assert(m7Null.validation_status.smart === 'no_thermal_mass', 'null-mass gate');
assert(m7Null.scenarios.smart_hp_hh.gas_kwh.every(v => v == null), 'null-mass smart all null');
const m8Null = computeCosts(rateMetadata, { scenarios: m7Null.scenarios, ... }, params);
assert(m8Null.scenarios.smart_hp_hh.annual_cost_gbp == null, 'null-mass m8 smart null');
const m9Null = analyseFinancials(m8Null, ...);
assert(m9Null.scenarios.smart_hp_hh == null || m9Null.scenarios.smart_hp_hh.payback_years == null,
  'null-mass m9 smart null — no £0 payback');
assert(m9Null.headline.best_scenario === 'std_hp_hh', 'null-mass headline fallback');
```

### Step 8 — 90-day load gate

```js
// A 50-row CSV (< 90 days) should trigger the load gate
const short = generateSyntheticHhArray(50 * 48);  // 50 days × 48 HH
const m1Short = estimateDataIngestion(short);
assert(m1Short.validation?.days_with_data < 90, '90-day gate detect');
// (The pop-up / rejection is UI behaviour — assert only the m1 metadata flag here)
```

### Step 9 — Seasonal sufficiency gates

```js
// Insufficient heating days → m4 null HTC
const summerOnly = generateSyntheticHhArray(365 * 48, { heating: 'summer_only' });
const m4SummerOnly = estimateHeatLoss(m3SummerOnly, ...);
assert(m4SummerOnly.htc_w_per_k == null, 'hard-stop: null HTC on summer-only data');
assert(m4SummerOnly.validation_status === 'insufficient_data', 'hard-stop status');

// Insufficient summer → m3 Method-E baseload
const winterOnly = generateSyntheticHhArray(365 * 48, { heating: 'winter_only' });
const m3WinterOnly = estimateBaseloadSeparation(winterOnly, ...);
assert(m3WinterOnly.baseload_method === 'E', 'soft-caveat: Method-E on winter-only data');
```

### Step 10 — Manual real-data canary (documented, not automated)

Add a `// MANUAL` block at the end of `test-integration.mjs`:

```js
// MANUAL: run with real Octopus data (Rhiannon's account, or any complete-year dataset)
// Expected ranges on a full-year complete-data run:
//   current_flat.annual_cost_gbp:  £1,800–£2,400 (Rhiannon: ~£2,000)
//   m9.tariff_saving_gbp:          £150–£450
//   m9.smart_shift_saving_gbp:     > 0 (positive, < tariff saving)
//   m9.scenarios.smart_hp_hh.payback_years: 15–40 yr
//   I1: §3 bars = §11a Totals within £1 rounding
// These are predictive sanity checks, not unit tests. They fail on toy/summer-only data.
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Full pipeline runner requires all module functions imported — coupling risk | Import only the module-boundary functions; avoid internal helpers |
| I5 consistency check tolerance (3°C) may be too tight for some synthetic datasets | Adjust tolerance if synthetic data doesn't converge; document in deviations |
| Seasonal sufficiency gate tests require synthetic data generators that produce summer-only and winter-only patterns | The test-data synthesiser may not support these patterns; if so, hand-craft minimal 365-day arrays inline |

---

## Success criteria

- [ ] `test-integration.mjs` runs with `node test-integration.mjs` and exits 0 on the synthetic `modern-out-for-work` dataset
- [ ] I1: six-component sum = annual_cost within £0.01 for all 5 scenarios
- [ ] I2: SCOP re-derived from m6 formula matches m6 `annual_mean_cop` within 0.01
- [ ] I3: gas + elec decomposition sums match annual_cost, gas_energy, standing_charge within £0.01
- [ ] I4: tariff + HP-heating + smart_shift = total_saving within £0.01
- [ ] I5: heating-hour mean indoor temp within 3°C of winter setpoint (RC consistency check)
- [ ] Null degradation: thermal_mass null → smart null chain → m9 smart null → headline fallback to std_hp_hh
- [ ] 90-day gate: <90-day input triggers days_with_data flag
- [ ] Seasonal gates: summer-only → null HTC; winter-only → Method-E baseload
- [ ] Manual canary block documented; not blocking CI

---

## Implementation Deviations

*To be completed after implementation.*

<!--
Status values:
- Awaiting review — Opus architect review pending.
- ✅ Approved — yyyy-mm-dd. Implementation may begin.
- ⚠ Approved with edits.
- ⏸ Blocked.
- Implemented — yyyy-mm-dd, commit <hash>.
-->
