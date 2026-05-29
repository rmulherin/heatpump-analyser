# Investigation Instrumentation — Diagnostic Getters

**Date:** 2026-05-28
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Add read-only console getters and one reconciliation function to expose already-computed
module results in a form that directly supports the investigation backlog in
`ui-overhaul-2026-05-investigation.md`. The headline goal is to make INV-1 (£806 vs
£690.83 current-boiler cost discrepancy) self-evident from the console, and to expose
thermal-model internals for INV-3 and INV-4. No calculations are changed; no production
UI is modified.

Design doc: `praxis-claude-hub/projects/tools/heatpump-analyser/design/investigation-instrumentation.md`

---

## Research findings

### Existing getter pattern
`app.js` lines 3154–3165 define `window.__get*Result()` for all pipeline modules
including `__getPricingResult` and `__getFinancialResult`. These are currently simple
pass-throughs; the plan replaces/extends them in place.

### Pricing result structure (pricing-engine.js `computeCosts`)
Per scenario the stored object has:
- `heating_gas_gbp`, `heating_elec_gbp` — already decomposed
- `non_heating_gas_gbp` — **bundles** baseload gas energy + gas standing charge
- `non_heating_elec_gbp` — equals elec standing charge only (no bundling issue here)
- `annual_cost_gbp`, `energy_cost_gbp`, `gas_energy_cost_gbp`, `elec_energy_cost_gbp`,
  `standing_charge_gbp` (total standing)

`gas_standing_charge_p_per_day` and `data_period_days` are available from `getRateMetadata()`.
The split is: `gas_standing_gbp = gas_standing_charge_p_per_day × 365 / 100` (annually scaled),
`gas_energy_gbp = non_heating_gas_gbp − gas_standing_gbp`.

### Financial result structure (financial.js `analyseFinancials`)
`getFinancialResult().scenarios[name]` stores: `annual_cost_gbp`, `annual_saving_gbp`,
`net_investment_gbp`, `payback_years`, `payback_status` only. The `annual_cost_gbp` is
taken directly from `effectivePricingResult.scenarios[name].annual_cost_gbp` (which is
the raw pricing result for `current`, potentially nullified for HH/smart scenarios via
`buildEffectivePricingResult`). No component breakdown is stored by M9.

`buildEffectivePricingResult` (app.js) does **not** modify the `current` scenario —
only `dumb_hp_hh` and `smart_hp_hh` are potentially nullified. So if M8 and M9 disagree
on `current.annual_cost_gbp`, the source must be in display logic, not stored results.
`__reconcileCosts()` will distinguish these cases definitively.

### Scenario consumption result (scenario-consumption.js)
`current.indoor_temp_c` is a per-HH array produced by `simulateCurrentRcTrace`. Heat
balance intermediates (heatLossKwh, solarGainKwh per HH) are not stored; they can be
derived in the getter from stored `current.gas_kwh`, `getHeatLossResult()`, and
`getExternalResult()` — pure reads only.

### Thermal character Path A / Path B (thermal-character.js)
`estimateThermalCharacter` calls `estimateThermalMass` (Path A cold-soak), stores the
result as `thermal_mass_kj_per_k`, then **overwrites** it if Path B (tau-bucket) is
used (line ~603–612). The Path A value is lost after overwrite. Fix: capture
`path_a_kj_per_k` and derive `path_a_tau_h` **before** the Path B block; add both to
the return object. Path B values (`path_b_kj_per_k`, `path_b_tau_h`) are added to the
return only when `thermal_mass_source === 'user_tau'`.

The "intermediate mapping from winter-return-temp input" (INV-4) is exposed via:
`time_constant_hours` (final selected τ), `setpoint_c`, and the `thermal_mass_kj_per_k`
from each path — enough for a ΔT/τ diagnosis without re-computing event-level internals.

### D4 (optional diagnostics panel)
Design doc recommends getters-first; D4 is out of scope for this plan unless Rhiannon
requests it after running the getters.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/thermal-character.js` | Store Path A value before Path B override; add `_path_diagnostics` to return |
| MODIFY | `js/app.js` | Replace `__getPricingResult`; enhance `__getFinancialResult`; add `__reconcileCosts`, `__getScenarioDiagnostics`, `__getThermalDiagnostics` |

---

## Implementation steps

### Step 1 — Capture Path A thermal mass before Path B override (`thermal-character.js`)

In `estimateThermalCharacter`, after the `estimateThermalMass` destructuring block
(immediately after the `if (setpoint_c !== null)` call), insert:

```javascript
// Diagnostic: capture Path A value before Path B may override
const path_a_kj_per_k = thermal_mass_kj_per_k;
const path_a_tau_h    = (path_a_kj_per_k !== null && htc !== null)
  ? path_a_kj_per_k / (htc * 3.6) : null;
```

After the Path B block (immediately before `computeRatingAndTimeConstant`), add:

```javascript
const path_b_kj_per_k = (thermal_mass_source === 'user_tau') ? thermal_mass_kj_per_k : null;
const path_b_tau_h    = (path_b_kj_per_k !== null && htc !== null)
  ? path_b_kj_per_k / (htc * 3.6) : null;
```

Add to the return object at the end of `estimateThermalCharacter`:

```javascript
_path_diagnostics: {
  path_a_kj_per_k,
  path_a_tau_h,
  path_b_kj_per_k,
  path_b_tau_h,
},
```

This is a diagnostic-only addition. No calculation is changed — `thermal_mass_kj_per_k`
and `time_constant_hours` in the main result are unaffected.

### Step 2 — Replace `window.__getPricingResult` with split-standing version (`app.js`)

Replace the existing pass-through at the `window.__getPricingResult` line with:

```javascript
window.__getPricingResult = () => {
  const pr   = getPricingResult();
  const meta = getRateMetadata();
  if (!pr || !meta) return { available: false };
  const gasScAnnual  = meta.gas_standing_charge_p_per_day  * 365 / 100;
  const elecScAnnual = meta.elec_standing_charge_p_per_day * 365 / 100;
  const scenarios = {};
  for (const [name, s] of Object.entries(pr.scenarios)) {
    if (!s || s.annual_cost_gbp === null) {
      scenarios[name] = { ...s, gas_standing_gbp: null, gas_energy_gbp: null, elec_standing_gbp: null };
      continue;
    }
    scenarios[name] = {
      ...s,
      gas_standing_gbp:  gasScAnnual,
      gas_energy_gbp:    (s.non_heating_gas_gbp ?? 0) - gasScAnnual,
      elec_standing_gbp: elecScAnnual,
    };
  }
  return { ...pr, scenarios, available: true };
};
```

Note: `non_heating_elec_gbp` already equals `elec_standing_gbp` in the current build
(only elec standing, no baseload energy). The added `elec_standing_gbp` alias confirms
this explicitly for diagnostic use.

### Step 3 — Enhance `window.__getFinancialResult` with pricing components (`app.js`)

Replace the existing pass-through with:

```javascript
window.__getFinancialResult = () => {
  const fr   = getFinancialResult();
  const pr   = getPricingResult();
  const meta = getRateMetadata();
  if (!fr) return { available: false };
  const scale = meta ? 365 / (meta.data_period_days || 365) : null;
  const scenarios = {};
  for (const [name, fs] of Object.entries(fr.scenarios)) {
    const ps  = pr?.scenarios?.[name];
    const m8Components = (ps && scale !== null && ps.annual_cost_gbp !== null) ? {
      gas_energy:   (ps.gas_energy_cost_gbp ?? 0) * scale,
      elec_energy:  (ps.elec_energy_cost_gbp ?? 0) * scale,
      standing:     (ps.standing_charge_gbp  ?? 0) * scale,
    } : null;
    scenarios[name] = { ...fs, m8_components: m8Components };
  }
  return { ...fr, scenarios, available: true };
};
```

This shows what M8 computed per component alongside M9's `annual_cost_gbp`, without any
recomputation.

### Step 4 — Add `window.__reconcileCosts` (`app.js`)

Add after the existing getter block:

```javascript
window.__reconcileCosts = () => {
  const pr   = getPricingResult();
  const fr   = getFinancialResult();
  const meta = getRateMetadata();
  if (!pr || !fr || !meta) return { available: false };

  const gasScAnnual  = meta.gas_standing_charge_p_per_day  * 365 / 100;
  const elecScAnnual = meta.elec_standing_charge_p_per_day * 365 / 100;
  const MISMATCH_THRESHOLD = 1; // £1

  const out = { available: true };
  for (const name of ['current', 'dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh']) {
    const ps = pr.scenarios?.[name];
    const fs = fr.scenarios?.[name];
    if (!ps || ps.annual_cost_gbp === null) {
      out[name] = { available: false };
      continue;
    }
    const m8Total = ps.annual_cost_gbp;
    const m9Total = fs?.annual_cost_gbp ?? null;
    const totalDiff = (m9Total !== null) ? m8Total - m9Total : null;

    out[name] = {
      heating_gas:      { m8: ps.heating_gas_gbp ?? 0 },
      non_heating_gas:  { m8: (ps.non_heating_gas_gbp ?? 0) - gasScAnnual },
      gas_standing:     { m8: gasScAnnual },
      heating_elec:     { m8: ps.heating_elec_gbp ?? 0 },
      non_heating_elec: { m8: 0 },
      elec_standing:    { m8: elecScAnnual },
      total:            {
        m8: m8Total,
        m9: m9Total,
        diff: totalDiff,
        mismatch: totalDiff !== null && Math.abs(totalDiff) > MISMATCH_THRESHOLD,
      },
    };
  }
  return out;
};
```

Note: `non_heating_elec_gbp` in M8 equals elec standing charge (as confirmed in research),
so `non_heating_elec` energy = 0. If this assumption is wrong it will show up in the total
mismatch.

### Step 5 — Add `window.__getScenarioDiagnostics` (`app.js`)

Add after `window.__reconcileCosts`:

```javascript
window.__getScenarioDiagnostics = () => {
  const sc  = getScenarioConsumptionResult();
  const tc  = getThermalCharacterResult();
  const hl  = getHeatLossResult();
  const ext = getExternalResult();
  if (!sc) return { available: false };

  const indoorArr = sc.scenarios.current?.indoor_temp_c ?? [];
  const gasArr    = sc.scenarios.current?.gas_kwh ?? [];
  const setpoint  = tc?.setpoint_c ?? null;
  const htc       = hl?.htc_w_per_k ?? null;
  const boilerEff = hl?.boiler_efficiency_used ?? 0.9;
  const solarR      = hl?.solar_aperture_m2 ?? null;
  const externalArr = ext?.external ?? null;  // array of { temp_c, solar_w_m2, ... }

  const validIndoor = indoorArr.filter(v => v !== null && v !== undefined);
  const indoorStats = validIndoor.length > 0 ? {
    min:                   Math.min(...validIndoor),
    max:                   Math.max(...validIndoor),
    mean:                  validIndoor.reduce((a, b) => a + b, 0) / validIndoor.length,
    fraction_below_setpoint: setpoint !== null
      ? validIndoor.filter(v => v < setpoint).length / validIndoor.length : null,
    n_hh: validIndoor.length,
  } : null;

  // Aggregate heat balance from stored arrays (kWh per HH, 0.5 h slots)
  let totalHeatDeliveredKwh = null;
  let totalHeatLossKwh      = null;
  let totalSolarGainKwh     = null;
  if (gasArr.length > 0) {
    totalHeatDeliveredKwh = gasArr.reduce((s, v) => s + (v ?? 0) * boilerEff, 0);
  }
  if (htc !== null && validIndoor.length > 0 && externalArr) {
    totalHeatLossKwh = 0;
    for (let i = 0; i < indoorArr.length; i++) {
      const tIn  = indoorArr[i];
      const tOut = externalArr[i]?.temp_c;
      if (tIn !== null && tOut !== undefined) {
        totalHeatLossKwh += htc * (tIn - tOut) * 0.5 / 1000;
      }
    }
  }
  if (solarR !== null && externalArr) {
    totalSolarGainKwh = externalArr.reduce(
      (s, slot) => s + solarR * (slot?.solar_w_m2 ?? 0) * 0.5 / 1000, 0
    );
  }

  return {
    available: true,
    indoor_temp_stats: indoorStats,
    heat_balance_kwh: {
      heat_delivered: totalHeatDeliveredKwh,
      heat_loss:      totalHeatLossKwh,
      solar_gain:     totalSolarGainKwh,
    },
    comfort_demand_inputs: {
      setpoint_c:    setpoint,
      htc_w_per_k:   htc,
      solar_aperture_m2: solarR,
      boiler_efficiency: boilerEff,
    },
  };
};
```

### Step 6 — Add `window.__getThermalDiagnostics` (`app.js`)

Add after `window.__getScenarioDiagnostics`:

```javascript
window.__getThermalDiagnostics = () => {
  const tc = getThermalCharacterResult();
  if (!tc) return { available: false };
  const pd = tc._path_diagnostics ?? {};
  return {
    available: true,
    thermal_mass_source:  tc.thermal_mass_source,
    selected_kj_per_k:    tc.thermal_mass_kj_per_k,
    selected_tau_h:       tc.time_constant_hours,
    path_a: {
      kj_per_k: pd.path_a_kj_per_k ?? null,
      tau_h:    pd.path_a_tau_h    ?? null,
      events_used: tc.thermal_mass_events_used,
    },
    path_b: {
      kj_per_k: pd.path_b_kj_per_k ?? null,
      tau_h:    pd.path_b_tau_h    ?? null,
    },
    setpoint_c:       tc.setpoint_c,
    validation_status: tc.validation_status,
  };
};
```

### Step 7 — Verify not-available behaviour

In `js/app.js`, the `{ available: false }` return is already the early-exit path for each
getter when the pipeline has not run (null result from `getPricingResult()` etc.).
Check that calling any getter before the pipeline runs returns `{ available: false }` and
does not throw. This is structural verification — confirm the null-guard is the first
check in each getter body.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `gas_energy_gbp` goes negative if gas standing derivation is off | The design doc acknowledges this is display-only. A negative value is itself diagnostic information (signals bundling mismatch). No guard needed. |
| `simulateCurrentRcTrace` heat-loss aggregate mismatches stored RC model internals | Getter computes from stored arrays only; any mismatch from the RC model's internal state IS the finding, not a bug. Document in plan. |
| Step 1 adds fields to `estimateThermalCharacter` return; tests may not cover them | `_path_diagnostics` is additive — no test assertions change. No test file changes needed. |
| External data field names | Confirmed: `getExternalResult().external` is an array of `{ temp_c, solar_w_m2, ... }` objects (external-data.js). Step 5 uses these paths. |

---

## Success criteria

- [ ] `window.__getPricingResult()` returns `gas_standing_gbp`, `gas_energy_gbp`, `elec_standing_gbp`
      per scenario after pipeline run; returns `{ available: false }` before.
- [ ] `window.__getFinancialResult()` returns `m8_components` per scenario after pipeline run.
- [ ] `window.__reconcileCosts()` flags the current-boiler total mismatch (INV-1 hypothesis:
      `|diff| > £1`) and localises it to a named component or confirms M8=M9 (points to display logic).
- [ ] `window.__getScenarioDiagnostics()` returns `indoor_temp_stats` with min/mean/max/
      fraction_below_setpoint; no console errors.
- [ ] `window.__getThermalDiagnostics()` returns `path_a.kj_per_k` and `path_b.kj_per_k` (one
      may be null depending on which path was used); `selected_kj_per_k` matches the final
      thermal character result.
- [ ] Calling any getter before the pipeline runs returns `{ available: false }` without throwing.
- [ ] No existing test suite results change (all suites still green).
- [ ] No production UI changes; no displayed results change.

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
