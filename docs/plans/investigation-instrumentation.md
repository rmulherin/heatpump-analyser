# Investigation Instrumentation — Diagnostic Getters

**Date:** 2026-05-28
**Status:** ✅ Approved — 2026-05-29. Implementation may begin.

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
// Capture Path A value before Path B block — must precede the Path B override
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
  for (const name of Object.keys(pr.scenarios ?? {})) {
    const ps = pr.scenarios[name];
    const fs = fr.scenarios?.[name];
    if (!ps || ps.annual_cost_gbp === null) {
      out[name] = { available: false };
      continue;
    }
    const m8Total   = ps.annual_cost_gbp;
    const m9Total   = fs?.annual_cost_gbp ?? null;
    const totalDiff = (m9Total !== null) ? m8Total - m9Total : null;

    let verdict, note;
    if (m9Total === null) {
      verdict = 'm8_only';
      note    = 'M9 has no figure for this scenario — nullified by effectivePricingResult or scenario unavailable.';
    } else if (Math.abs(totalDiff) <= MISMATCH_THRESHOLD) {
      verdict = 'no_model_level_mismatch';
      note    = 'M8 and M9 stored values agree — if a visual discrepancy was observed, investigate display logic.';
    } else {
      verdict = 'm9_total_differs';
      note    = `M9 uses a different total (diff = £${totalDiff.toFixed(2)}) — investigate effectivePricingResult or financial.js.`;
    }

    out[name] = {
      heating_gas:      { m8: ps.heating_gas_gbp ?? 0 },
      non_heating_gas:  { m8: (ps.non_heating_gas_gbp ?? 0) - gasScAnnual },
      gas_standing:     { m8: gasScAnnual },
      heating_elec:     { m8: ps.heating_elec_gbp ?? 0 },
      non_heating_elec: { m8: (ps.non_heating_elec_gbp ?? 0) - elecScAnnual },
      elec_standing:    { m8: elecScAnnual },
      total:            { m8: m8Total, m9: m9Total, diff: totalDiff,
                          mismatch: totalDiff !== null && Math.abs(totalDiff) > MISMATCH_THRESHOLD,
                          verdict, note },
    };
  }
  return out;
};
```

Changes from original: (L6) iterates `Object.keys(pr.scenarios)` rather than a hardcoded
array, so the getter survives scenario renames; (L8) `non_heating_elec.m8` is computed as
`non_heating_elec_gbp − elecScAnnual` rather than a hardcoded `0`, surfacing any future
bundling change; (H1) `total` now includes `verdict` and `note` fields that route the
investigator to the right layer — `'no_model_level_mismatch'` points to display logic,
`'m9_total_differs'` points to `effectivePricingResult` / `financial.js`.

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

  // Single-pass stats to avoid spread-to-apply cliff on large arrays (M5)
  const validIndoor = indoorArr.filter(v => v !== null && v !== undefined);
  let indoorStats = null;
  if (validIndoor.length > 0) {
    let min = Infinity, max = -Infinity, sum = 0, countBelow = 0;
    for (const v of validIndoor) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      if (setpoint !== null && v < setpoint) countBelow++;
    }
    const n = validIndoor.length;
    indoorStats = {
      min,
      max,
      mean: sum / n,
      fraction_below_setpoint: setpoint !== null ? countBelow / n : null,
      n_hh: n,
    };
  }

  // Aggregate heat balance from stored arrays (kWh per HH, 0.5 h slots).
  // Post-hoc approximation: HTC × ΔT × time and R × W/m² × time — not the
  // RC model's per-step internal terms (see Risks).
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
      setpoint_c:        setpoint,
      htc_w_per_k:       htc,
      solar_aperture_m2: solarR,
      boiler_efficiency: boilerEff,
    },
    // Stored in thermal character result (annual_modelled_demand_kwh); pass through (H2)
    comfort_demand_kwh: tc?.annual_modelled_demand_kwh ?? null,
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

Note on scope boundary (M4): this getter exposes the Path A ↔ Path B τ discrepancy at
runtime. Root-causing *why* Path A returns ~2 h on a given winter-return-temp input
(INV-4) is architect code-reading work, not runtime instrumentation — that investigation
uses `__getThermalDiagnostics()` as its evidence source, not an extended getter.

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
| `heat_balance_kwh` is a post-hoc approximation | Computed from stored arrays (HTC × ΔT × time; R × W/m² × time), not from the RC model's per-step internal terms. Any discrepancy between this getter's aggregate and the model's internal accounting IS the finding for INV-3 — not a bug in the getter. |
| Step 1 adds fields to `estimateThermalCharacter` return; tests may not cover them | `_path_diagnostics` is additive — no test assertions change. No test file changes needed. |
| External data field names | Confirmed: `getExternalResult().external` is an array of `{ temp_c, solar_w_m2, ... }` objects (external-data.js). Step 5 uses these paths. |

---

## Success criteria

- [ ] `window.__getPricingResult()` returns `gas_standing_gbp`, `gas_energy_gbp`, `elec_standing_gbp`
      per scenario after pipeline run; returns `{ available: false }` before.
- [ ] `window.__getFinancialResult()` returns `m8_components` per scenario after pipeline run.
- [ ] `window.__reconcileCosts()` returns a `verdict` per scenario: `'no_model_level_mismatch'`
      confirms M8 and M9 stored values agree (routes INV-1 to display logic); `'m9_total_differs'`
      (|diff| > £1) routes to `effectivePricingResult` / `financial.js`; `'m8_only'` when M9 has
      no figure. Each verdict has a `note` in plain English.
- [ ] `window.__getScenarioDiagnostics()` returns `indoor_temp_stats` (min/mean/max/
      fraction_below_setpoint) and `comfort_demand_kwh` (from
      `getThermalCharacterResult().annual_modelled_demand_kwh`); no console errors.
      `heat_balance_kwh` values are post-hoc approximations from stored arrays, not the RC
      model's per-step internal terms — a discrepancy between getter output and model internals
      is expected and is itself diagnostic information for INV-3.
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

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-05-29
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `praxis-claude-hub/projects/tools/heatpump-analyser/design/investigation-instrumentation.md`

### Context

Review of the diagnostic-instrumentation plan against the parent design doc. The plan
is well-researched — load-bearing code-claim assertions were verified by an
Opus-spawned read-only Explore sub-agent (gas-standing bundling at
`pricing-engine.js:246–255`; M9 component-free shape at `financial.js:75–80`; Path B
overwrite at `thermal-character.js:606`; `getRateMetadata` fields at
`pricing-engine.js:190–192`; external-data field names at `external-data.js:366–367`;
getter locations at `app.js:3164–3165`). Two HIGH findings require new code logic
beyond the hygiene bright line, so the verdict is Blocked: the plan returns to the
planner for revision.

Notable strength worth elevating: the plan's research uncovered a substantive
refinement to INV-1's hypothesis. If `current.annual_cost_gbp` flows untransformed
M8 → M9 → display, M8 and M9 should *agree* on stored values, and the displayed-£
discrepancy must come from display logic — not from M9 dropping a component. The
revised `__reconcileCosts` (H1 below) operationalises this insight.

### Required changes for implementation

**1. H1 — Add a `verdict` field to `__reconcileCosts()` output, per scenario.** Make
the M8↔M9 diagnostic conclusion explicit rather than left to a reader's
interpretation. Values: `'no_model_level_mismatch'` (|diff| ≤ £1; routes to
display-logic investigation), `'m9_total_differs'` (|diff| > £1; routes to
`effectivePricingResult` / `financial.js`), or `'m8_only'` (M9 absent). Add a brief
`note: string` paraphrasing the verdict in plain English. Update Success Criterion 3
to reflect the two-path diagnostic.

**2. H2 — Add `comfort_demand_kwh` to `__getScenarioDiagnostics()` output.** Design
D3 called for the comfort-demand figure to be exposed alongside its inputs; the plan
exposes inputs (setpoint, HTC, solar aperture) but not the figure itself (the
10,100 kWh "Modelled comfort demand at 17.6°C" shown in the Heating-to-comfort
card). Without it, INV-3 cannot be diagnosed against the model's actual demand
value. Verify whether `comfort_demand_kwh` is stored in a module result first; if
stored, pass through; if not, derive using the exact formula the model uses to
produce the displayed value, documenting the source. Do not invent a new
computation. Update Success Criterion 4 to include `comfort_demand_kwh`.

**3. M3 — Document the post-hoc limit in Success Criteria.** Add: "`heat_balance_kwh`
is computed post-hoc from stored arrays (HTC × ΔT × time; R × W/m² × time), not from
the RC model's per-step internal terms. Any mismatch from the model's internal
accounting IS the finding for INV-3."

**4. M4 — Document the runtime-vs-code-reading split in Step 6 or Risks.** Add: "The
v1 surface reveals the Path A ↔ Path B τ discrepancy at runtime; root-causing why
Path A returns ~2h on the 14°C winter-return input is architect code-reading, not
runtime instrumentation."

**5. M5 — Single-pass reduce in `__getScenarioDiagnostics`.** Replace
`Math.min(...validIndoor)` and `Math.max(...validIndoor)` with a single-pass reduce
computing `min`, `max`, `mean`, `n_hh`, and `fraction_below_setpoint` together.
Removes the spread-to-apply cliff on large arrays.

**6. L6 — `Object.keys(pr.scenarios)` for scenario iteration in `__reconcileCosts`.**
Replace the hardcoded `['current', 'dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh']` so
the getter survives scenario renames.

**7. L8 — Computed residual for `non_heating_elec` in `__reconcileCosts`.** Replace
`non_heating_elec: { m8: 0 }` with `non_heating_elec: { m8: (ps.non_heating_elec_gbp
?? 0) - elecScAnnual }`. Same expected output today; surfaces any future bundling
change rather than hiding it.

**8. L9 — Code comment locking the Path A capture assumption.** In
`thermal-character.js` Step 1, add a one-line comment immediately before the Path A
capture noting that the capture must occur before any potential Path B override.

### Resolution of review changes

**H1** — `verdict` and `note` fields added to `total` in `__reconcileCosts()` per scenario.
Three values: `'no_model_level_mismatch'` (routes to display logic), `'m9_total_differs'`
(routes to effectivePricingResult/financial.js), `'m8_only'` (M9 absent). `note` is a
plain-English string. Success Criterion 3 updated to reflect the two-path diagnostic.

**H2** — `comfort_demand_kwh` added to `__getScenarioDiagnostics()` return. Field is a
pass-through from `getThermalCharacterResult().annual_modelled_demand_kwh` — already
stored in the module result (no new computation). The `annual_modelled_demand_kwh` field
is the same figure shown in the Heating-to-comfort card. Success Criterion 4 updated.

**M3** — Risk row rewritten to name `heat_balance_kwh` as a post-hoc approximation and
clarify that any mismatch from the RC model's internal terms is the diagnostic finding,
not a getter bug. Same note added inline in the Step 5 code comment and in Success
Criterion 4.

**M4** — Note added after Step 6 code block: the v1 getter surfaces the Path A ↔ Path B
τ discrepancy at runtime; root-causing why Path A returns ~2 h on a given input is
architect code-reading (INV-4), not runtime instrumentation.

**M5** — `indoorStats` computation replaced with a single-pass `for…of` loop computing
min, max, sum, and `countBelow` together. Removes the spread-to-apply cliff on large
arrays (17,000+ HH slots).

**L6** — `for (const name of Object.keys(pr.scenarios ?? {}))` replaces the hardcoded
scenario array in `__reconcileCosts()`.

**L8** — `non_heating_elec: { m8: (ps.non_heating_elec_gbp ?? 0) - elecScAnnual }`
replaces `{ m8: 0 }`. Expected output is unchanged today (elec SC is the only component);
future bundling changes will surface rather than be hidden.

**L9** — Comment updated in Step 1 thermal-character.js snippet: `// Capture Path A value
before Path B block — must precede the Path B override`.

**L7** — Not applied per agreed dispositions (Items noted but not edited). `?? 0.9`
default retained.

### Items noted but not edited

- **LOW — L7 — `boiler_efficiency_used ?? 0.9` silent default.** Changing to
  fail-loud would be a new behaviour change, not hygiene; explicitly out of scope per
  agreed dispositions. Keep the default.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | — |
| HIGH     | 2     | ✅ resolved |
| MEDIUM   | 3     | ✅ resolved |
| LOW      | 4     | ✅ resolved (L6/L8/L9 actioned; L7 retained per dispositions) |

Verdict: ✅ APPROVED — all eight Required Changes resolved in the revision
(commit `c4e18d5`); H2's pass-through claim (`annual_modelled_demand_kwh`)
independently verified end-to-end by a second Opus-spawned read-only Explore sub-agent.

---

## Approval

**Status:** ✅ Approved — 2026-05-29
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:**
- H1 (verdict field in `__reconcileCosts`) accepted as required.
- H2 (`comfort_demand_kwh` in `__getScenarioDiagnostics`) accepted as required.
- L7 (fail-loud on missing `boiler_efficiency_used`) explicitly dropped — keep the
  `?? 0.9` default.
- "No v2" applies to this instrumentation: the build must be complete in one pass.
  The documented runtime/code-reading split (M3, M4) is the deliberate scope
  boundary between runtime instrumentation and the architect's standard
  investigation tools, not a future build.
- All code-claim research findings in the plan were independently verified by an
  Opus-spawned read-only Explore sub-agent on 2026-05-29; the plan's key insight
  (that `buildEffectivePricingResult` leaves `current` untouched, so any displayed-£
  divergence on `current` is in display logic) is accepted as the working hypothesis
  the instrumentation will test.
- Revision (commit `c4e18d5`) addressed all eight Required Changes from the prior
  review round; the H2 pass-through claim
  (`getThermalCharacterResult().annual_modelled_demand_kwh` equals the UI's displayed
  comfort-demand figure) was independently verified end-to-end by a second
  Opus-spawned read-only Explore sub-agent on 2026-05-29 (chain:
  `thermal-character.js:679–680` → `getThermalCharacterResult()` at
  `thermal-character.js:9` → `app.js:1273` → `#underheat-modelled` in `index.html:321–322`).
