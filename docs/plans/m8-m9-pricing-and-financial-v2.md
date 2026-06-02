# m8-m9-pricing-and-financial-v2 — Six-component pricing + savings decomposition

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Combined plan for M8 (Pricing Engine) and M9 (Financial Analysis) v2 overhaul.
Combined per v2-build-brief §7 (m9 is ≤10 implementation steps standalone; tight coupling
of M8 output → M9 input makes cross-plan review harder than a single plan).

**M8 changes** (in `js/pricing-engine.js`):

- Rename scenario keys from v1 (`current`, `dumb_hp_svt`, `dumb_hp_hh`, `smart_hp_hh`)
  to v2 (`current_flat`, `current_hh`, `std_hp_flat`, `std_hp_hh`, `smart_hp_hh`).
  `current_flat` and `current_hh` both price m7-v2's single `current` array — two tariffs,
  identical consumption (structural enforcement of INV-17 tariff-switch isolation).
- Phase B pricing loop: read from `components` sub-arrays (from m7a/m7b) rather than
  rolled-up `gas_kwh`/`elec_kwh`. Produce six-component `ScenarioCost` (Gas/Elec ×
  Heat/Non-Heat/Fixed) plus `cop_sensitive_elec_cost_gbp` for M9's §15.
- Standing charge derived from actual gas consumption (`Σ gas_kwh > 0`) rather than the
  v1 hard-coded `SCENARIO_FUELS` table — handles the §10d toggle + all-electric automatically.
- Remove v1 `baseloadHeating` parameter (non-heating gas was passed separately; in v2 it
  is in m7's `components.gas_dhw + gas_other`).
- Remove `electricityRateForHH(scenario === 'current' → 0)` guard (v2 always prices the
  full observed elec for all scenarios, including `current_*`).
- Phase A rate-preparation: unchanged structurally. Update `isPeakHour` export if needed.
  Only change: remove `gas_rate_by_hh` and `elec_hh_rate_by_hh` pass to M7 in app.js
  (m7-v2 takes only `elecHhRateByHh`).

**M9 changes** (in `js/financial.js`):

- Consume v2 scenario keys (`current_flat` not `current`; `std_hp_flat/hh`, `smart_hp_hh`).
- Remove 5×5 gas/elec sensitivity grid + 1-D COP rescaling (`FA_CONFIG.GAS_MULTIPLIERS`,
  `ELEC_MULTIPLIERS`, `COP_MULTIPLIERS`; entire `grid` + `cop_axis` computation blocks).
- Add INV-17 savings decomposition: `tariff_saving_gbp`, `smart_shift_saving_gbp`.
- Change payback denominator: `hp_attributable_saving` (same-tariff current vs scenario)
  rather than `total_saving_vs_current_flat`.
- Add `paybackFromCosts(m8_scenarios, net_investment_gbp)` — pure helper, no state.
- Add `headline` object (best HP case for §3/§12).
- Update break-even: use `std_hp_flat` + `current_flat` (renaming `dumb_hp_svt`); consume
  M8's `standing_charge_gbp` (not re-derive from rateMetadata).

**Implementation prerequisite:** m7a + m7b implemented (M8 reads `components` sub-arrays).

---

## Research findings

**`js/pricing-engine.js` (read in full):**

- `prepareRates`: Phase A — gas rate lookup, Agile D×W+P HH rate, imputation, standing
  charges, data_period_days. **Largely unchanged** in v2. Remove only: the
  `gas_rate_by_hh` pass to M7 (done in app.js call site). `isPeakHour` and
  `imputeWholesaleForSlot` carry through. `PE_CONFIG` constants carry through.
- `computeCosts(rateMetadata, scenarioResult, params, baseloadHeating)`: Phase B.
  Currently: iterates `SCENARIO_ORDER = ['current', 'dumb_hp_svt', 'dumb_hp_hh',
  'smart_hp_hh']`; applies `electricityRateForHH` (returns 0 for `current` — v2 removes
  this guard); uses hard-coded `SCENARIO_FUELS` for standing charge; outputs
  `{heating_gas_gbp, heating_elec_gbp, non_heating_gas_gbp, non_heating_elec_gbp}` (four
  components, v2 needs six). `baseloadHeating` is used for `non_heating_gas_pence` — remove
  in v2 (it's in `components.gas_dhw + gas_other`).
- `buildMonthGroups`: carry through unchanged.
- `SCENARIO_FUELS`, `SCENARIO_ELEC_RATE_TYPE`, `SCENARIO_ORDER` constants: replace with v2
  equivalents. Hard-coded `SCENARIO_FUELS` is what the design doc's standing-charge
  derivation change replaces.

**`js/financial.js` (read in full):**

- `analyseFinancials(pricingResult, rateMetadata, scenarioResult, params)`: current HP
  scenarios = `['dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh']`. Payback uses
  `currentAnnual − sAnnual` as denominator (total saving vs flat current — INV-17 bug).
  Contains the 5×5 grid (FA_CONFIG.GAS/ELEC_MULTIPLIERS) and 1-D COP axis — both removed.
  Break-even uses `dumbHpSvtM7.elec_kwh` and `currentM7.gas_kwh` from the m7
  scenarioResult — still needed in v2 for elec-kWh delta; update key names.
- `FA_CONFIG`: remove `GAS_MULTIPLIERS`, `ELEC_MULTIPLIERS`, `COP_MULTIPLIERS`.
  Retain `INSTALLATION_FULL_HP_DEFAULT_GBP`, `BUS_GRANT_DEFAULT_GBP`,
  `AVOIDED_AC_DEFAULT_GBP`, `AVOIDED_AC_LARGE_FRACTION`.

**Integration-v2 invariants to preserve:**

- I1: `annual_cost_gbp = Σ(six components)`;
  `gas_energy + elec_energy + standing_charge = annual_cost`.
- I3: M7 component sum identities → M8 bucketing X (Heat = space heat; Non-Heat = DHW +
  other + nonheat).
- I4: `total_saving (current_flat − smart_hp_hh) = tariff_saving + hp_heating + smart_shift`.
- Integration-v2 §2: `standing_charge_gbp` is M8-owned; M9 consumes it, never re-derives.

**Size assessment:** combined plan is correct. M8 is medium (Phase A mostly unchanged;
Phase B is the main work). M9 is small (pure arithmetic changes). Total ~17 steps + tests.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/pricing-engine.js` | v2 scenario keys; six-component pricing; standing charge from gas consumption |
| MODIFY | `js/financial.js` | Remove grid; add decomposition + hp_attributable payback + paybackFromCosts |
| MODIFY | `app.js` | Update M8 call sites (new scenario keys, remove baseloadHeating, update M9 call) |
| CREATE | `test-m8m9.mjs` | M8 Tests 1–11 + M9 Tests 1–11 from design docs |

---

## Implementation steps

### Step 1 — Replace M8 scenario-key constants

Remove `SCENARIO_FUELS`, `SCENARIO_ELEC_RATE_TYPE`, `SCENARIO_ORDER`. Replace with:

```js
// v2: 5 priced scenarios from 3 m7 arrays. Keys match design doc §1 and conventions-v2 G1.
const V2_SCENARIOS = {
  current_flat: { array: 'current',     rateType: 'svt' },
  current_hh:   { array: 'current',     rateType: 'hh'  },
  std_hp_flat:  { array: 'dumb_hp',     rateType: 'svt' },
  std_hp_hh:    { array: 'dumb_hp',     rateType: 'hh'  },
  smart_hp_hh:  { array: 'smart_hp_hh', rateType: 'hh'  },
};
const SCENARIO_ORDER_V2 = ['current_flat', 'current_hh', 'std_hp_flat', 'std_hp_hh', 'smart_hp_hh'];
```

Remove `electricityRateForHH` helper (v2 always prices elec at the scenario's tariff;
`current_flat` uses SVT, `current_hh` uses HH — no zero-rate special case).

### Step 2 — Remove `baseloadHeating` from `computeCosts`

Remove the `baseloadHeating` parameter and the `non_heating_gas_pence` loop that consumed
it. In v2 non-heating gas cost emerges from `components.gas_dhw + gas_other` (owned by m7)
— no separate input needed.

### Step 3 — Rewrite Phase B pricing loop (six-component)

Replace the single gas/elec loop with a component-reading loop:

```js
for (const key of SCENARIO_ORDER_V2) {
  const { array: arrName, rateType } = V2_SCENARIOS[key];
  const arr = scenarioResult.scenarios[arrName];

  if (arr == null || arr.gas_kwh.every(v => v == null)) {
    // null passthrough for smart when no thermal mass
    scenarioCosts[key] = makeNullScenarioCost();
    continue;
  }

  const c = arr.components;
  const r_elec = (i) => rateType === 'svt'
    ? (svtRate)                                      // p/kWh flat
    : rateMetadata.elec_hh_rate_by_hh[i];            // HH wholesale + overhead

  let gas_heat_p = 0, gas_nonheat_p = 0;
  let elec_heat_p = 0, elec_nonheat_p = 0, cop_sensitive_p = 0;

  for (let i = 0; i < arr.gas_kwh.length; i++) {
    const gr = rateMetadata.gas_rate_by_hh[i];
    const er = r_elec(i);
    gas_heat_p      += (c.gas_space_heat[i] ?? 0) * gr;
    gas_nonheat_p   += ((c.gas_dhw[i] ?? 0) + (c.gas_other[i] ?? 0)) * gr;
    elec_heat_p     += (c.elec_space_heat[i] ?? 0) * er;
    elec_nonheat_p  += ((c.elec_dhw[i] ?? 0) + (c.elec_other[i] ?? 0) + (c.elec_nonheat[i] ?? 0)) * er;
    cop_sensitive_p += ((c.elec_space_heat[i] ?? 0) + (c.elec_dhw[i] ?? 0)) * er;
  }
```

### Step 4 — Standing charge derived from actual gas consumption

```js
  // Standing charge — derived from whether this scenario burned any gas
  const gas_supplied = arr.gas_kwh.some(v => (v ?? 0) > 0);
  const gas_fixed_p   = gas_supplied
    ? gasSc * rateMetadata.data_period_days           // gas standing charge for data period
    : 0;
  const elec_fixed_p  = elecSc * rateMetadata.data_period_days;  // always present

  const fuels_supplied = gas_supplied ? ['gas', 'electricity'] : ['electricity'];
```

> This replaces the hard-coded `SCENARIO_FUELS` table and automatically handles:
> §10d toggle OFF (m7 zeros gas → `gas_supplied = false` → gas SC = 0);
> toggle ON (gas baseload retained → `gas_supplied = true` → gas SC applies);
> all-electric homes (no gas ever → 0).

### Step 5 — Assemble six-component ScenarioCost

```js
  const scale = 365 / (rateMetadata.data_period_days || 365);

  const gas_heat_gbp     = gas_heat_p     / 100 * scale;
  const gas_nonheat_gbp  = gas_nonheat_p  / 100 * scale;
  const gas_fixed_gbp    = gas_fixed_p    / 100 * scale;
  const elec_heat_gbp    = elec_heat_p    / 100 * scale;
  const elec_nonheat_gbp = elec_nonheat_p / 100 * scale;
  const elec_fixed_gbp   = elec_fixed_p   / 100 * scale;

  const annual_cost_gbp = gas_heat_gbp + gas_nonheat_gbp + gas_fixed_gbp
                        + elec_heat_gbp + elec_nonheat_gbp + elec_fixed_gbp;

  scenarioCosts[key] = {
    annual_cost_gbp,
    data_period_cost_gbp: (gas_heat_p + gas_nonheat_p + gas_fixed_p
                         + elec_heat_p + elec_nonheat_p + elec_fixed_p) / 100,
    components: {
      gas_heat_gbp, gas_nonheat_gbp, gas_fixed_gbp,
      elec_heat_gbp, elec_nonheat_gbp, elec_fixed_gbp,
    },
    gas_energy_cost_gbp:         (gas_heat_gbp    + gas_nonheat_gbp),
    elec_energy_cost_gbp:        (elec_heat_gbp   + elec_nonheat_gbp),
    cop_sensitive_elec_cost_gbp: cop_sensitive_p  / 100 * scale,
    standing_charge_gbp:         gas_fixed_gbp + elec_fixed_gbp,
    monthly_breakdown:           buildMonthBreakdown(arr, key, monthGroups, rateMetadata, svtRate, gasSc, elecSc),
    fuels_supplied,
    electricity_rate_type: rateType,
  };
}
```

`buildMonthBreakdown` extracts the existing monthly loop logic into a helper function,
reading components per HH (same six-component accumulation within each month group).
Monthly `Σ total_gbp = data_period_cost_gbp` (Test 8).

### Step 6 — Update `prepareRates` return and M8 exports

`prepareRates` return: unchanged except remove `SCENARIO_FUELS`/`SCENARIO_ELEC_RATE_TYPE`
references (these were never part of the returned object). No structural change to Phase A.

Update module-level exports: keep `prepareRates`, `computeCosts`, `PE_CONFIG`,
`setRateMetadata`/`getRateMetadata`, `setPricingResult`/`getPricingResult`.

### Step 7 — Update `app.js` M8 call sites

In `runScenarioConsumption` (or equivalent) in `app.js`:

- Pass only `elecHhRateByHh` to M7 (remove `gasRateByHh` pass — v2 M7 doesn't need it).
- In `computeCosts(...)` call: remove `baseloadHeating` argument.
- Where app.js reads M8 output by scenario key, update from v1 keys to v2 keys:
  - `pricingResult.scenarios.current` → `current_flat` (for "current" display)
  - `pricingResult.scenarios.dumb_hp_svt` → `std_hp_flat`
  - `pricingResult.scenarios.dumb_hp_hh` → `std_hp_hh`
  - `pricingResult.scenarios.smart_hp_hh` → unchanged
- Read the existing call sites in app.js before writing to confirm all reference points.

### Step 8 — Remove M9 sensitivity grid and COP axis

In `js/financial.js`, delete:
- `FA_CONFIG.GAS_MULTIPLIERS`, `ELEC_MULTIPLIERS`, `COP_MULTIPLIERS` entries.
- The `annualComponents` helper function (used only by the grid).
- The `components` map construction.
- The `grid` computation (outer for-loop over gas_mult × elec_mult).
- The `cop_axis` computation.
- The `sensitivity` key from the return object.

Retain `FA_CONFIG.INSTALLATION_FULL_HP_DEFAULT_GBP`, `BUS_GRANT_DEFAULT_GBP`,
`AVOIDED_AC_DEFAULT_GBP`, `AVOIDED_AC_LARGE_FRACTION`.

### Step 9 — Update M9 to consume v2 scenario keys

Replace `HP_SCENARIOS = ['dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh']` with:

```js
const HP_SCENARIOS_V2 = ['std_hp_flat', 'std_hp_hh', 'smart_hp_hh'];
```

Update `current` reference: `pricingResult.scenarios.current` → `current_flat`.

### Step 10 — Add INV-17 savings decomposition to M9

After Step 1 (net investment), before the per-scenario loop:

```js
const C = pricingResult.scenarios;

// INV-17 decomposition
const tariff_saving_gbp = (C.current_flat?.annual_cost_gbp ?? null) !== null
  && (C.current_hh?.annual_cost_gbp ?? null) !== null
  ? C.current_flat.annual_cost_gbp - C.current_hh.annual_cost_gbp
  : null;

const smart_shift_saving_gbp = (C.std_hp_hh?.annual_cost_gbp ?? null) !== null
  && (C.smart_hp_hh?.annual_cost_gbp ?? null) !== null
  ? C.std_hp_hh.annual_cost_gbp - C.smart_hp_hh.annual_cost_gbp
  : null;
```

### Step 11 — Rewrite M9 per-scenario payback (hp_attributable denominator)

In the per-scenario loop, use `hp_attributable_saving` (same-tariff current vs scenario):

```js
for (const name of HP_SCENARIOS_V2) {
  const s = C[name];
  const sAnnual = s?.annual_cost_gbp ?? null;

  // Same-tariff baseline: std_hp_flat and current_hh/smart compare to current_hh;
  // std_hp_flat compares to current_flat (same SVT tariff)
  const same_tariff_current_annual = name === 'std_hp_flat'
    ? C.current_flat?.annual_cost_gbp ?? null
    : C.current_hh?.annual_cost_gbp ?? null;

  const total_saving_vs_current_flat_gbp = C.current_flat?.annual_cost_gbp != null && sAnnual != null
    ? C.current_flat.annual_cost_gbp - sAnnual : null;

  const hp_attributable_saving_gbp = same_tariff_current_annual != null && sAnnual != null
    ? same_tariff_current_annual - sAnnual : null;

  let payback_years, payback_status;
  if (sAnnual == null || hp_attributable_saving_gbp == null) {
    payback_years = null; payback_status = 'no_data';
  } else if (hp_attributable_saving_gbp <= 0) {
    payback_years = null; payback_status = 'no_saving';
  } else if (net_full_hp === 0) {
    payback_years = 0; payback_status = 'positive';
  } else {
    payback_years = net_full_hp / hp_attributable_saving_gbp; payback_status = 'positive';
  }

  scenarioResults[name] = {
    annual_cost_gbp: sAnnual,
    total_saving_vs_current_flat_gbp,
    hp_attributable_saving_gbp,
    payback_years,
    payback_status,
  };
}
```

### Step 12 — Add `paybackFromCosts` helper and `headline` object

```js
export function paybackFromCosts(m8Scenarios, net_investment_gbp) {
  // Pure function — no state. Used by §14/§15 rerun cards.
  const scenarios = {};
  for (const name of HP_SCENARIOS_V2) {
    const c = m8Scenarios[name];
    const currentRef = name === 'std_hp_flat' ? m8Scenarios.current_flat : m8Scenarios.current_hh;
    const hp_attr = (currentRef?.annual_cost_gbp ?? null) != null && (c?.annual_cost_gbp ?? null) != null
      ? currentRef.annual_cost_gbp - c.annual_cost_gbp : null;
    const payback = hp_attr != null && hp_attr > 0 && net_investment_gbp > 0
      ? net_investment_gbp / hp_attr : hp_attr === 0 ? 0 : null;
    scenarios[name] = { payback_years: payback, hp_attributable_saving_gbp: hp_attr };
  }
  return scenarios;
}
```

`headline` object — best HP case (Smart if non-null, else std_hp_hh):

```js
const best_name = C.smart_hp_hh?.annual_cost_gbp != null ? 'smart_hp_hh' : 'std_hp_hh';
const best = scenarioResults[best_name];
const headline = {
  best_scenario:               best_name,
  total_saving_gbp:            best.total_saving_vs_current_flat_gbp,
  tariff_component_gbp:        tariff_saving_gbp,
  hp_heating_component_gbp:    C.current_hh?.annual_cost_gbp != null && C.std_hp_hh?.annual_cost_gbp != null
    ? C.current_hh.annual_cost_gbp - C.std_hp_hh.annual_cost_gbp : null,
  smart_shift_component_gbp:   smart_shift_saving_gbp,
  payback_years:               best.payback_years,
  payback_status:              best.payback_status,
};
```

### Step 13 — Update M9 break-even to consume M8 standing charge

v1 recomputed gas SC from `rateMetadata.gas_standing_charge_p_per_day` — in v2, consume
`C.std_hp_flat.standing_charge_gbp` for the full standing-charge figure (M8-owned, per
integration-v2 §2). Update the break-even formula to use `std_hp_flat` (renamed from
`dumb_hp_svt`) and source elec/gas kWh from m7's scenario arrays under the new key names:

```js
const stdHpFlat = C.std_hp_flat;
const stdHpM7   = scenarioResult?.scenarios?.dumb_hp;    // m7-v2 key
const currentM7 = scenarioResult?.scenarios?.current;

// gas energy pence: already scaled in M8; undo scale for data-period calc
const data_period_days = rateMetadata.data_period_days;
const scale = 365 / data_period_days;
const gas_sc_dp_gbp = (stdHpFlat?.standing_charge_gbp ?? 0) / scale   // unscale to data period
                    - (stdHpFlat?.components.elec_fixed_gbp ?? 0) / scale;  // subtract elec SC
// ... rest of break-even formula unchanged in structure
```

> Note: consuming the M8 `standing_charge_gbp` minus the electric fixed component gives the
> gas-only SC for data period — simpler than re-deriving from `rateMetadata`. Flag for Opus
> to confirm this is numerically correct.

### Step 14 — Update M9 output structure and `analyseFinancials` signature

Update `analyseFinancials` to accept the new M8 shape (no `baseloadHeating` or
`rateMetadata.gas_multipliers`). Return:

```js
return {
  net_investment_gbp,
  tariff_saving_gbp,
  smart_shift_saving_gbp,
  scenarios: scenarioResults,      // std_hp_flat, std_hp_hh, smart_hp_hh
  headline,
  break_even,
  inputs_used: { installation_cost_full_hp_gbp, bus_grant_gbp, avoided_ac_cost_gbp },
  warnings,
};
```

Remove `sensitivity` key entirely.

### Step 15 — Create `test-m8m9.mjs`

**M8 tests (from design doc §8 Tests 1–11):**

T-M8-2: Six-component identity. For each scenario, `annual_cost = gas_heat + gas_nonheat +
gas_fixed + elec_heat + elec_nonheat + elec_fixed`. Also `gas_energy + elec_energy +
standing_charge = annual_cost`. Use synthetic components; assert within £0.01.

T-M8-3: Negative wholesale not clamped. wholesale = −5.0, overhead = 13.0 →
`elec_hh_rate = 8.0`. Assert rate used in `current_hh` pricing = 8.0 p/kWh.

T-M8-4: Bucketing X — DHW stays Non-Heat. `elec_dhw[i] = 0.5`, `elec_space_heat[i] = 0`.
Assert `elec_nonheat_gbp` includes the DHW cost; `elec_heat_gbp = 0`.

T-M8-5: Standing charge follows gas. Same m7 `dumb_hp` array with toggle OFF (gas_kwh = 0
in dumb_hp): `std_hp_flat.gas_fixed_gbp = 0`; `fuels_supplied = ['electricity']`. Same
array with toggle ON (gas_kwh > 0): `gas_fixed_gbp > 0`.

T-M8-6: Tariff-switch isolation. `current_flat` and `current_hh` have identical
`gas_heat_gbp`, `gas_nonheat_gbp`, `gas_fixed_gbp`, `elec_heat_gbp`; differ only in
`elec_nonheat_gbp` + `elec_fixed_gbp` (same kWh, different rate). Difference = pure
tariff saving.

T-M8-7: Std-HP unit check. `elec_space_heat[i] = 2.0`, SVT 24.50 p/kWh →
`std_hp_flat.elec_heat_gbp ≈ 2.0 × 24.50/100 × scale`. Same kWh at HH 18.0 p/kWh →
`std_hp_hh.elec_heat_gbp` proportionally lower.

T-M8-8: Monthly completeness. Σ monthly `total_gbp` (un-scaled) = `data_period_cost_gbp`
for each scenario.

T-M8-10: `cop_sensitive_elec_cost_gbp` = priced(`elec_space_heat + elec_dhw`); excludes
`elec_other` and `elec_nonheat`. Use distinct per-component synthetic values to verify
selection.

T-M8-11: Null smart passthrough. `smart_hp_hh` arrays null → `smart_hp_hh` ScenarioCost
all null; `current_flat` etc. computed.

**M9 tests (from design doc §7 Tests 1–11):**

T-M9-1: Net investment basic + AC. install 12,500, grant 7,500, AC 0 → 5,000; AC 1,500 → 3,500.

T-M9-2: Net investment floor. install 8,000, grant 7,500, AC 2,000 → 0.

T-M9-3: Payback positive. net 5,000; `C_current_hh − C_std_hp_hh = 300` → payback ≈ 16.7 yr.

T-M9-4: Decomposition identity (I4). `(C_current_flat − C_smart_hp_hh) = tariff_saving +
(C_current_hh − C_std_hp_hh) + smart_shift_saving`. Exact within £0.01.

T-M9-5: Payback excludes tariff. Smart payback denominator = `C_current_hh − C_smart_hp_hh`
(not `C_current_flat − C_smart_hp_hh`). Force `tariff_saving = 300`, HP-heating = 164,
smart_shift = 50: assert `smart_hp_hh.payback_years = 5000 / (164 + 50) ≈ 23.4 yr`, NOT
`5000 / (300 + 164 + 50) ≈ 9.8 yr`. Guards the INV-17 correction.

T-M9-6: `std_hp_flat` no-saving. Force `C_current_flat − C_std_hp_flat ≤ 0` (HP more
expensive on flat rate) → `payback_status = "no_saving"`.

T-M9-7: Break-even numeric. gas energy £1,400 dp (annualised), gas SC £116 annual,
extra HP elec 5,200 kWh. Expected `svt_rate_breakeven ≈ 29.2 p/kWh`.

T-M9-8: No approximation grid. Assert `financial_result.sensitivity` is undefined/absent.
Assert `paybackFromCosts` is exported and callable.

T-M9-11: Headline fallback. `smart_hp_hh.annual_cost_gbp = null` →
`headline.best_scenario = 'std_hp_hh'`; payback from `std_hp_hh.hp_attributable_saving`.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Break-even M8-standing-charge decomposition (Step 13 note) | Flagged for Opus review. Fallback: derive gas SC from `rateMetadata.gas_standing_charge_p_per_day × data_period_days / 100 × scale` if the M8-consumption approach proves messy |
| `app.js` uses v1 scenario key strings in many display functions | Read all references to v1 keys in app.js before writing; update systematically. Treat as a find-and-replace with context — do not assume keys; verify each call site |
| v1 test-m8.mjs and test-m9.mjs may fail after key renaming | v1 suites reference old scenario keys — they WILL break after this plan (unlike m7a which kept compat aliases). This is expected; v1 suites should be retired/updated alongside this plan. Note explicitly in plan |
| v1 M8 hard-coded `SCENARIO_FUELS` assumed current always has gas — removing it changes SC for all-electric users | Design doc §5 is explicit: derive from `Σ gas_kwh > 0`. All-electric `current` has gas_kwh ≈ 0 → gas SC = 0 for current too. This is the correct behaviour (no gas connection). |

**Note on v1 test suites:** `test-m8.mjs` (24 tests) and `test-m9.mjs` (24 tests) both
reference v1 scenario keys and the old ScenarioCost shape. They **will fail** after this
plan is implemented — this is expected and correct (the v1 API is gone). The new
`test-m8m9.mjs` replaces them. Remove or archive the v1 suites at implementation.

---

## Success criteria

- [ ] `test-m8m9.mjs`: all tests pass
- [ ] Six-component identity holds for all five scenarios: `annual_cost = Σ(six components)`
      (assert within £0.01 rounding)
- [ ] `standing_charge_gbp` = `gas_fixed + elec_fixed` (M8-owned; M9 consumes it)
- [ ] `current_flat` and `current_hh` have identical component values except for
      rate-driven elec figures (Test T-M8-6)
- [ ] M9 `payback_years` for `std_hp_hh` / `smart_hp_hh` uses `hp_attributable_saving`
      (same-tariff current) as denominator (Test T-M9-5)
- [ ] `paybackFromCosts` exported from `js/financial.js`; `financial_result.sensitivity`
      absent from return value
- [ ] No reference to `dumb_hp_svt`, `dumb_hp_hh`, `SCENARIO_FUELS` in
      `pricing-engine.js` after implementation
- [ ] `analyseFinancials` does not re-derive standing charges — consumes M8's value

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
