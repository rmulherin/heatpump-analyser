# m8-patch-gas-connection-retained — Gas retained; Agile D×W+P; Ofgem cap rates

**Date:** 2026-04-29
**Status:** ✅ Approved — 2026-04-29
**Design doc:** `design/m8-patch-gas-connection-retained.md`
**Implements:** sequence 4 of 6 (after patch-agile-region-calibration; before ui-design-m10b)

---

## Task description

Three interconnected model corrections implemented together because they all modify
M7/M8's cost model in ways that are only coherent as a set:

1. **Gas connection retained (M7 + M8):** HP scenarios include gas baseload consumption
   and gas standing charge, reconciling totals to the user's actual annual bill.
2. **Agile D×W+P HH rates (M8):** Replace flat `hh_overhead + wholesale` with
   `D × wholesale + P` using the calibration data from `patch-agile-region-calibration`.
3. **Ofgem cap base rates (M8):** HP scenarios use current Ofgem cap rates for SVT
   electricity (not the user's historical rates, which predate the April 2026 reform).

Also removes hybrid scenarios (`hybrid_dumb`, `hybrid_smart`) from the entire tool —
they show no meaningful benefit and are ineligible for BUS. Removal spans all layers:
M7 (`scenario-consumption.js` + `test-m7.mjs`), M8 (`pricing-engine.js` +
`test-m8.mjs`), M9 (`financial.js` + `test-m9.mjs`), and the display layer in `app.js`.

The display layer gains a new 5-column cost breakdown table and supporting footnotes.

---

## Research findings

**SCENARIO_FUELS:** pricing-engine.js:14-21. HP scenarios currently `['electricity']`,
meaning `computeCosts` excludes gas standing charge for them (line 211-212:
`fuels.includes('gas') ? gasSc : 0`). Change `dumb_hp_svt`, `dumb_hp_hh`,
`smart_hp_hh` to `['gas', 'electricity']`.

**Gas baseload in M7:** `scenario-consumption.js` sets `gas_kwh[i] = 0` for all HP
scenario slots. The `heating` array parameter already contains `baseload_kwh` per slot
(baseload.js lines 270-271 confirm: each element has `{ heating_kwh, baseload_kwh }`).
`baseload_kwh` is available from `heating[i].baseload_kwh` without any changes to
function signatures. Use `heating[i].baseload_kwh ?? 0` for HP scenario `gas_kwh[i]`.

**computeCosts return:** pricing-engine.js:238-246. Currently returns
`{ annual_cost_gbp, energy_cost_gbp, gas_energy_cost_gbp, elec_energy_cost_gbp,
standing_charge_gbp, monthly_breakdown, fuels_supplied, electricity_rate_type }`.
The four decomposed components (`heating_gas_gbp`, `heating_elec_gbp`,
`non_heating_gas_gbp`, `non_heating_elec_gbp`) are additions to this, not replacements.
Legacy fields are retained.

**Electricity baseline split:** `current` scenario: baseline electricity = observed
total − `supplementary_loads.electric_heating_kwh_estimate` (or 0 if null). HP
scenarios: baseline electricity = same constant; heating electricity = scenario total
− baseline. The baseline is constant across scenarios — compute once. The
`supplementary_loads.electric_heating_kwh_estimate` is available from
`baseloadResult.supplementary_loads` in app.js.

**prepareRates:** pricing-engine.js:46. `hh_overhead_p_per_kwh` (default 13p,
line 58) is used at lines 84 (null wholesale fallback: `hh_overhead`) and 90 (main:
`wholesale + hh_overhead`). Replace both with the Agile D×W+P formula. The
`agile_calibration` object (`{ D, P_peak_p_kwh, ... }`) comes from
`getExternalResult().agile_calibration`. When `agile_calibration` is null, fall back
to default D/P constants (`D_DEFAULT = 2.2`, `P_DEFAULT_PEAK_P_KWH = 12`) defined in
`pricing-engine.js` — the same D×W+P formula applies with no separate code branch;
`calibration.source === 'default'` triggers the fallback warning in the display layer.

**isPeak helper:** Reuse the same IANA `Europe/London` approach as in
`patch-agile-region-calibration`. Add `isPeakHour(ts)` to pricing-engine.js or import
from external-data.js. Prefer a local helper in pricing-engine.js to avoid circular
imports.

**Ofgem cap constants:** New constants in `app.js`:
```js
const OFGEM_CAP_ELEC_P_KWH = 24.67;  // electricity, Apr–Jun 2026 cap
const OFGEM_CAP_GAS_P_KWH  = 5.70;   // gas, Apr–Jun 2026 cap
const OFGEM_CAP_VALID_FROM  = '2026-04-01';
```
Pass `OFGEM_CAP_ELEC_P_KWH` into `prepareRates` as a new param `ofgem_cap_elec_p_kwh`.
`prepareRates` uses this for `dumb_hp_svt` scenario SVT electricity rate only; HH
scenarios use Agile D×W+P regardless; `current` uses historical rate unchanged.

**Hybrid removal:** Spans all layers.
- M7: `estimateScenarioConsumption` in `scenario-consumption.js` produces `hybrid_dumb`
  and `hybrid_smart` scenario arrays — remove both. In `test-m7.mjs`, remove T3
  ("Hybrid dispatch HP wins"), T4 ("Hybrid dispatch gas wins"), and T19 ("hybrid_smart
  prefers HP at cheap HP HH") — all three test removed scenarios.
- M8: `SCENARIO_ORDER` at pricing-engine.js:32; `SCENARIO_FUELS` line 14;
  `SCENARIO_ELEC_RATE_TYPE` line 23. Also remove hybrid keys from `test-m8.mjs`
  helper `makeAllScenarios` and from T4b, T10b.
- M9: `HP_SCENARIOS` (financial.js:15) and `FULL_HP_SCENARIOS` (financial.js:16).
  Grep `financial.js` for `hybrid_` and remove all matches; verify zero remaining.
  In `test-m9.mjs`, remove hybrid keys from `buildPricing`, T1b, T2b, T4, T5, T7,
  T8, T9 (all confirmed by grep above — remove and re-verify pass count).
- Display: `VERDICT_CHART_LABELS` (~app.js:1467); label map at ~1597;
  `FINANCIAL_DISPLAY_ORDER` (~1729); `buildAndDisplayVerdict` scenario order (~1951).
  Also remove from `displayPricingResults` and `displayFinancialResults` table rows.
  Grep `app.js` for `hybrid_dumb` and `hybrid_smart` after editing; confirm zero.

**5-column display table:** `displayPricingResults` in app.js currently builds a
pricing table. Replace with the new 5-column table as specced. The scenario rows are
now four: `current`, `dumb_hp_svt`, `dumb_hp_hh`, `smart_hp_hh`.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/scenario-consumption.js` | Remove hybrid scenarios; HP scenarios use `baseload_kwh` for `gas_kwh` (not zero) |
| MODIFY | `test-m7.mjs` | Remove T3, T4, T19 (all test removed hybrid scenarios) |
| MODIFY | `js/pricing-engine.js` | D_DEFAULT/P_DEFAULT constants, SCENARIO_FUELS, SCENARIO_ORDER, Agile D×W+P with default calibration fallback, cost decomposition, hybrid removal |
| MODIFY | `test-m8.mjs` | Remove hybrid_dumb/hybrid_smart from makeAllScenarios helper and T4b, T10b |
| MODIFY | `js/financial.js` | Remove hybrid from HP_SCENARIOS, FULL_HP_SCENARIOS |
| MODIFY | `test-m9.mjs` | Remove hybrid keys from buildPricing helper and all affected test cases |
| MODIFY | `js/app.js` | Ofgem constants, updated `prepareRates` params, display updates, hybrid removal from all display arrays |
| MODIFY | `index.html` | Remove `hh_overhead` input field from Pricing assumptions card |
| MODIFY | `css/styles.css` | Add `.table-scroll-wrap` |

---

## Implementation steps

### Step 1 — Remove hybrid scenarios from all layers (surgical first)

**scenario-consumption.js (`estimateScenarioConsumption`):**
- Remove the `hybrid_dumb` and `hybrid_smart` branches entirely — do not produce
  those scenario arrays.
- After editing, confirm the function only produces:
  `{ current, dumb_hp_svt, dumb_hp_hh, smart_hp_hh }`.

**test-m7.mjs:**
- Delete T3 ("Hybrid dispatch HP wins") — tests `result.scenarios.hybrid_dumb`
- Delete T4 ("Hybrid dispatch gas wins") — tests `result.scenarios.hybrid_dumb`
- Delete T19 ("hybrid_smart prefers HP at cheap HP HH, gas at expensive HP HH") —
  tests `result.scenarios.hybrid_smart`
- After deletion, run `node test-m7.mjs` and confirm all remaining tests pass.

**pricing-engine.js:**
- `SCENARIO_ORDER` (line 32): Remove `'hybrid_dumb'`, `'hybrid_smart'`
- `SCENARIO_FUELS` (line 14): Remove `hybrid_dumb` and `hybrid_smart` entries
- `SCENARIO_ELEC_RATE_TYPE` (line 23): Remove `hybrid_dumb` and `hybrid_smart` entries

**financial.js:**
- Grep `financial.js` for `hybrid_` and remove all matches.
- Verify zero remaining occurrences post-edit.

**test-m8.mjs:**
- Remove `hybrid_dumb` and `hybrid_smart` from `makeAllScenarios` helper (line 44)
- Remove T4b (tests `hybrid_dumb.standing_charge_gbp`)
- Remove T10b (tests `hybrid_smart.annual_cost_gbp`)
- Run `node test-m8.mjs` and confirm pass.

**test-m9.mjs:**
- Remove `hybrid_dumb` and `hybrid_smart` from `buildPricing` names array (line 29)
- Update all test case input objects that include hybrid keys: T1, T2, T3, T4, T5,
  T7, T8, T9 — remove the hybrid entries from each `buildPricing` call and scenario
  map. T1b and T2b specifically test hybrid net investment — delete those assertions.
- Run `node test-m9.mjs` and confirm pass.

**app.js — remove hybrid from all label maps and display order arrays:**
- `VERDICT_CHART_LABELS` (~line 1467): remove `hybrid_dumb`, `hybrid_smart`
- The label map at ~line 1597: same
- `FINANCIAL_DISPLAY_ORDER` (~line 1729): remove hybrids
- Scenario order in `buildAndDisplayVerdict` (~line 1951): remove hybrids
- Any other display arrays or switches that reference hybrid keys — search and remove
- After all edits: grep `app.js` for `hybrid_dumb` and `hybrid_smart`; confirm zero.

### Step 2 — M7: HP scenarios retain gas baseload (scenario-consumption.js)

In `estimateScenarioConsumption`, for each HP scenario (`dumb_hp_svt`, `dumb_hp_hh`,
`smart_hp_hh`), wherever `gas_kwh[i] = 0` is set for HP slots, replace with:
```js
gas_kwh[i] = heating[i].baseload_kwh ?? 0;
```

The `heating` parameter already passes `baseload_kwh` per slot from M3. No signature
changes needed.

For the `current` scenario, `gas_kwh` remains the observed total gas (heating + baseload)
as before — no change.

### Step 3 — M8: SCENARIO_FUELS — HP scenarios gain gas

**pricing-engine.js `SCENARIO_FUELS`:**
```js
const SCENARIO_FUELS = {
  current:     ['gas', 'electricity'],
  dumb_hp_svt: ['gas', 'electricity'],  // was: ['electricity']
  dumb_hp_hh:  ['gas', 'electricity'],  // was: ['electricity']
  smart_hp_hh: ['gas', 'electricity'],  // was: ['electricity']
};
```

This causes `computeCosts` to include gas standing charge for all four scenarios
automatically — no change needed to `computeCosts` standing charge logic itself.

### Step 4 — M8: Ofgem cap constants and HP SVT forward-looking rate (app.js + pricing-engine.js)

**app.js:** Add at top (with other constants):
```js
const OFGEM_CAP_ELEC_P_KWH = 24.67;
const OFGEM_CAP_GAS_P_KWH  = 5.70;
const OFGEM_CAP_VALID_FROM  = '2026-04-01';
```

**pricing-engine.js `prepareRates`:** Accept new optional param `ofgem_cap_elec_p_kwh`.
Where the SVT rate is applied to HP scenario electricity, use `ofgem_cap_elec_p_kwh`
instead of the historical SVT rate. The `current` scenario continues to use the
historical rate unchanged.

In `prepareRates`, the rate arrays are built per-HH slot. Add logic:
- For `dumb_hp_svt`: use `ofgem_cap_elec_p_kwh ?? svtRate` as the SVT electricity rate
- For HH scenarios (`dumb_hp_hh`, `smart_hp_hh`): use Agile D×W+P (Step 5)
- For `current`: use historical SVT rate as before

**app.js:** Pass `OFGEM_CAP_ELEC_P_KWH` when calling `prepareRates`.

### Step 5 — M8: Agile D×W+P HH rate formula (pricing-engine.js `prepareRates`)

Add `isPeakHour(ts)` helper to pricing-engine.js (same IANA pattern as external-data.js):
```js
function isPeakHour(ts) {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false })
      .format(ts), 10);
  return hour >= 16 && hour < 19;
}
```

Add default-calibration constants near the top of `pricing-engine.js` (with other
module-level constants):
```js
const D_DEFAULT            = 2.2;   // mid of typical UK regional D range (2.0–2.4)
const P_DEFAULT_PEAK_P_KWH = 12;    // mid of typical UK P range (8–16 p/kWh)
```

In `prepareRates`, accept `agile_calibration` as a new optional param. Replace the
`hh_overhead`-based HH rate construction with the Agile formula. Build an effective
calibration object so the same formula path applies whether calibration is real or
default — no separate fallback branch:

```js
// Build effective calibration: real if available, default otherwise.
const calibration = agile_calibration ?? {
  D:            D_DEFAULT,
  P_peak_p_kwh: P_DEFAULT_PEAK_P_KWH,
  source:       'default',
};

const { D, P_peak_p_kwh } = calibration;

// Per HH slot:
const ts        = new Date(consumption[i].timestamp);
const wholesale = wholesale_prices[i];
if (wholesale === null) {
  elec_hh_rate_by_hh[i] = isPeakHour(ts) ? P_peak_p_kwh : 0;
  // No wholesale signal — rate is floor of peak uplift only; zero off-peak
} else {
  elec_hh_rate_by_hh[i] = isPeakHour(ts)
    ? Math.min(D * wholesale + P_peak_p_kwh, 100)
    : Math.min(D * wholesale, 100);
  // Negative wholesale → negative rate: correct, do not clamp on lower end
}
```

The `rateMetadata` returned from `prepareRates` should expose `calibration_source`
(either `'fetched'` or `'default'`) so the display layer can surface the fallback
warning without re-checking `agile_calibration`.

Remove the `hh_overhead_p_per_kwh` parameter from `prepareRates` signature and all
references to `PE_CONFIG.HH_OVERHEAD_DEFAULT_P` for the HH rate calculation.

**app.js:** Pass `agile_calibration` from `getExternalResult()` when calling
`prepareRates`.

**index.html:** Remove the `hh_overhead` input field from the Pricing assumptions card.

### Step 6 — M8: Cost decomposition (pricing-engine.js `computeCosts`)

The four new components require knowing which electricity is from heating vs baseline.
The `computeCosts` function receives `scenarioResult` which has per-slot `gas_kwh` and
`elec_kwh` arrays. M3's `supplementary_loads.electric_heating_kwh_estimate` gives the
current scenario's heating electricity estimate.

Pass `supplementary_elec_heating_kwh_estimate` (from `baseloadResult`) as a new
optional param to `computeCosts`. Compute once:
```js
// Baseline electricity per HH slot (constant across scenarios)
// For 'current': total observed elec − estimated elec heating
// For HP scenarios: same baseline; heating elec = scenario total − baseline
```

Extend the return from `computeCosts` for each scenario with:
```js
heating_gas_gbp:     number,   // heating_kwh portion × gas rate
heating_elec_gbp:    number,   // HP heating electricity × elec rate
non_heating_gas_gbp: number,   // baseload_kwh × gas rate + gas standing charge
non_heating_elec_gbp:number,   // baseline elec × elec rate + elec standing charge
```

The non-heating components will be numerically equal across all scenarios by construction.
Legacy fields (`annual_cost_gbp`, `energy_cost_gbp`, etc.) remain for compatibility with
financial.js and existing display code that reads them.

**app.js:** Pass `baseloadResult.supplementary_loads.electric_heating_kwh_estimate`
when calling `computeCosts`.

### Step 7 — Display: 5-column table and footnotes (app.js `displayPricingResults`)

Replace the existing pricing table with a 5-column table:

Columns: Scenario | Heating gas | Heating elec | Non-heating gas | Non-heating elec | Total (£/yr)

Rows: current, dumb_hp_svt, dumb_hp_hh, smart_hp_hh (four rows, no hybrids).

Formatting rules:
- Currency rounded to nearest £1 (`Math.round`)
- Zero values display as `—` not `£0`
- `toLocaleString('en-GB')` for thousands separators
- Wrap table in `<div class="table-scroll-wrap">` for horizontal scroll on mobile

Footnotes (below table, above or replacing existing footnotes):
1. Gas-connection-retained assumption note.
2. Ofgem cap rates note — inject only `OFGEM_CAP_ELEC_P_KWH` (not
   `OFGEM_CAP_GAS_P_KWH` — gas baseload uses historical M1 rates throughout).
   Exact wording from design Section E:
   ```
   Heat pump scenario electricity costs use the current Ofgem price cap rate
   (electricity: [OFGEM_CAP_ELEC_P_KWH]p/kWh). Gas costs (for the retained
   connection and baseload) and your current boiler costs use your actual
   historical tariff rates.
   ```
   Inject the value from `OFGEM_CAP_ELEC_P_KWH` at runtime so a constant update
   propagates automatically.

**css/styles.css:** Add:
```css
.table-scroll-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
```

If `rateMetadata.calibration_source === 'default'`, add a warning above the table:
```
"Couldn't fetch live Agile rates for your region — using typical UK averages
(D=2.2, P=12p/kWh peak). Numbers are indicative; your actual Agile rate will differ."
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Hybrid removal leaves stale references in app.js | Step 1 specifically targets all hybrid references; grep for `hybrid_dumb` and `hybrid_smart` after implementation and confirm zero matches |
| Cost decomposition — baseline electricity split requires `supplementary_loads.electric_heating_kwh_estimate`; this may be null for no-gas or CSV paths | Treat null as 0; baseline = observed total; current scenario heating_elec = 0. Document as acceptable |
| Gas baseload in HP scenarios — `heating[i].baseload_kwh` may be null for no-gas path | Use `?? 0`; existing null-passthrough behaviour for null inputs continues |
| `agile_calibration` null → HH rates use default D/P constants — numbers are indicative only; scenarios remain numerically distinct | Warning visible above pricing table per design F2; `dumb_hp_hh` and `smart_hp_hh` still differ from each other and from `dumb_hp_svt` because intra-day wholesale spread is preserved |
| Ofgem constants need quarterly update — hardcoded in app.js | Constants are named with `OFGEM_CAP_VALID_FROM`; easy to find and update. Accept this as the maintenance pattern |
| `computeCosts` monthly breakdown — the four new components would ideally have monthly equivalents too | Design doc only requires annual decomposition; monthly decomposition deferred. Do not extend monthly breakdown with new components unless explicitly requested |

---

## Success criteria

- [ ] Annual running costs table has 4 scenario rows (no hybrid), 5 cost columns + total
- [ ] Non-heating gas column is identical across all 4 scenarios
- [ ] Non-heating elec column is identical across all 4 scenarios
- [ ] Heating gas column: non-zero for `current` only (HP scenarios show `—`)
- [ ] Heating elec column: `—` for `current`; non-zero for three HP scenarios
- [ ] Total per scenario reconciles to ≈ user's actual annual bill (gas + elec, all components)
- [ ] Financial summary annual saving values unchanged from pre-patch (delta is purely heating)
- [ ] Gas-connection-retained footnote visible below the table
- [ ] Ofgem cap note shows injected constant values; changing `OFGEM_CAP_ELEC_P_KWH` in app.js propagates to both the calculation and the display
- [ ] Table scrolls horizontally on mobile; no layout break
- [ ] `agile_calibration.D` in range 2.0–2.4 (console/metadata)
- [ ] `agile_calibration.P_peak_p_kwh` in range 8–16 p/kWh
- [ ] Off-peak HH rate = D × wholesale; peak (16–19h) = D × wholesale + P (spot-check one each)
- [ ] Negative wholesale produces negative HH rate (not clamped to zero)
- [ ] `hh_overhead` input field is gone from the Pricing assumptions UI
- [ ] Agile fetch failure (or `gsp_region` unavailable): warning visible above pricing table; HH scenarios compute via default D/P fallback (D=2.2, P=12); `dumb_hp_hh` total differs numerically from `dumb_hp_svt` total (price spread preserved, not flat); `smart_hp_hh` total < `dumb_hp_hh` total (smart optimiser still benefits from intra-day variation)
- [ ] `dumb_hp_svt` uses Ofgem cap rate (24.67p/kWh), not historical rate
- [ ] The pricing card Ofgem note reads: "Heat pump scenario electricity costs use the current Ofgem price cap rate (electricity: 24.67p/kWh). Gas costs (for the retained connection and baseload) and your current boiler costs use your actual historical tariff rates." Gas rate is explicitly framed as historical, not Ofgem cap
- [ ] M7 produces no `hybrid_dumb` or `hybrid_smart` scenario arrays; T3, T4, and T19 removed from `test-m7.mjs`; test suite still passes
- [ ] No console errors on any path

---

## Design Review v1

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-29
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `design/m8-patch-gas-connection-retained.md` (praxis-claude-hub commit `aacf6a4`)
**Verdict:** ✅ APPROVED — v2 rewrite (heatpump commit `ab438b5`) resolves all v1 findings

### Context

Plan reviewed against the m8-patch design (latest commit `aacf6a4` — Opus has
applied review-driven updates to Sections F2, F3, E, Scope, and Test criteria
in praxis-claude-hub). Two HIGH findings and one MEDIUM require substantive
changes to plan body (new scope, rewritten code logic, rewritten copy). Per
heatpump reviewer-mode discipline, the architect does not author plan body
changes of this depth — the plan is returned to Sonnet for rewrite against
the updated design + this brief.

**Architectural decisions stand:** gas-connection-retained, Agile D × W + P,
Ofgem cap for HP electricity (not gas), hybrid removal across all layers,
four-component cost decomposition. The rewrite is a fix to the
specification of those decisions, not a redesign of them.

### Required changes for the rewrite

**1. HIGH — Extend hybrid removal to M7.**

Current Step 1 covers M8 (`pricing-engine.js`), M9 (`financial.js`), and the
display layer (`app.js`). It does NOT cover M7 (`scenario-consumption.js`).
Without that, M7 keeps producing `hybrid_dumb` and `hybrid_smart` arrays that
no consumer reads. Worse, `smart-scenario-fixes-1` Test 16
("Hybrid_smart prefers HP at cheap HP HH") would either continue testing
dead code or break silently if M7 logic is removed without test cleanup.

Rewrite must include explicit steps for:
- Removing `hybrid_dumb` and `hybrid_smart` from M7's scenario list and
  computation in `js/scenario-consumption.js`.
- Disposing of Test 16 in the M7 test suite (delete is fine — there is no
  general "removed-scenario contract" pattern worth keeping).

The design Scope (`aacf6a4`) now reflects this; the plan steps must follow.

**2. HIGH — Replace agile-failure fallback with default D/P.**

Current Step 5 fallback when `agile_calibration` is null:
`elec_hh_rate_by_hh[i] = svtRate;` — a flat-rate fallback.

Rejected. A flat-rate fallback (whether historical `svtRate` or
`OFGEM_CAP_ELEC_P_KWH`) makes `dumb_hp_hh` and `smart_hp_hh` numerically
identical to `dumb_hp_svt` — three identically-numbered scenarios with
different labels. Worse UX than indicative-with-warning.

Replace with the design's new F3 specification:
- Define constants in `js/pricing-engine.js`:
  `D_DEFAULT = 2.2`, `P_DEFAULT_PEAK_P_KWH = 12`.
- Build an effective calibration object:
  `agile_calibration ?? { D: D_DEFAULT, P_peak_p_kwh: P_DEFAULT_PEAK_P_KWH, source: 'default' }`.
- Apply the same `D × W + P` formula to historical wholesale either way —
  no separate fallback branch in the code.
- Surface the warning text per design F2 when `calibration.source === 'default'`.

**3. MEDIUM — Update display footnote text per revised design Section E.**

Current Step 7 injects both `OFGEM_CAP_ELEC_P_KWH` AND `OFGEM_CAP_GAS_P_KWH`
into the footnote, implying both rates are used in HP scenario costs. Only
electricity is. Gas baseload across all scenarios (HP and current) uses the
user's historical M1 rate.

Use revised footnote text from design Section E:
*"Heat pump scenario electricity costs use the current Ofgem price cap rate
(electricity: 24.67p/kWh). Gas costs (for the retained connection and
baseload) and your current boiler costs use your actual historical tariff
rates."*

Inject only `OFGEM_CAP_ELEC_P_KWH`. Drop `OFGEM_CAP_GAS_P_KWH` from this note.

**4. LOW — Tighten Step 1 hedge.**

Step 1 currently: *"FULL_HP_SCENARIOS (line 16): Remove hybrid entries
(or confirm these only contain full-HP scenarios already — if so no change
needed)"*. Replace the hedge with a definitive grep instruction:
*"Grep `financial.js` for `hybrid_` and remove all matches. Verify zero
remaining occurrences post-edit."*

**5. LOW — Section heading rename.**

`## Claude.ai Review` → `## Design Review` per the heatpump CLAUDE.md
substitution table.

**6. LOW — Status field protocol.**

The plan currently sits at `⏸ Blocked — pending rewrite per Design Review v1
(2026-04-29)`. After the v2 rewrite Sonnet sets it to
`Awaiting re-review — rewrite v2`. Opus will set the final approved value
during the v2 review.

**7. LOW — Update success criteria.**

- DROP the "If Agile fetch fails, warning visible AND HH scenarios fall back
  to flat SVT rate" criterion (no longer the design intent).
- ADD: *"Under default-calibration fallback (Agile fetch fails or `gsp_region`
  unavailable), `dumb_hp_hh` total differs numerically from `dumb_hp_svt`
  total (price spread preserved, not flat)."*
- ADD: *"Under default-calibration fallback, `smart_hp_hh` total <
  `dumb_hp_hh` total (smart optimiser still benefits from intra-day
  variation)."*
- ADD: *"M7 produces no `hybrid_dumb` or `hybrid_smart` arrays; Test 16 from
  the smart-scenario-fixes-1 suite is removed."*

### Resolution of review changes

1. **M7 hybrid removal** — Step 1 extended with a `scenario-consumption.js` sub-section
   (remove hybrid branches from `estimateScenarioConsumption`) and a `test-m7.mjs`
   sub-section (delete T3, T4, T19). Task description, Research findings, and Files
   table updated accordingly. `test-m8.mjs` and `test-m9.mjs` hybrid cleanup also
   added to Step 1 since the grep above confirmed extensive hybrid references in both.
2. **Default D/P fallback** — Step 5 rewritten: `D_DEFAULT = 2.2` and
   `P_DEFAULT_PEAK_P_KWH = 12` constants added to `pricing-engine.js`; single
   `agile_calibration ?? { D, P_peak_p_kwh, source: 'default' }` pattern with no
   separate fallback branch; `calibration.source === 'default'` exposes the warning
   flag via `rateMetadata.calibration_source`. Research findings and Risks updated.
   Warning text updated to match design F2.
3. **Footnote text** — Step 7 footnote 2 rewritten: only `OFGEM_CAP_ELEC_P_KWH`
   injected; exact wording from design Section E used verbatim; `OFGEM_CAP_GAS_P_KWH`
   removed from this note. Success criterion updated to verify gas is framed as
   historical.
4. **Step 1 hedge removed** — `financial.js` `FULL_HP_SCENARIOS` entry rewritten as
   a grep instruction ("Grep `financial.js` for `hybrid_` and remove all matches.
   Verify zero remaining occurrences post-edit.") with no hedge.
5. **Section heading** — Already applied by Opus when writing the review block;
   heading reads `## Design Review v1`. No further change needed.
6. **Status field** — Updated to `Awaiting re-review — rewrite v2`.
7. **Success criteria** — "Agile fetch failure: HH scenarios fall back to flat SVT
   rate" criterion replaced with the combined fallback + distinguishability criterion.
   Added: M7 hybrid arrays criterion (no hybrid arrays produced; T3/T4/T19 removed;
   suite passes). Ofgem note criterion added (electricity cap only; gas historical).

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | — |
| HIGH     | 2     | ✅ resolved in v2 (`ab438b5`) |
| MEDIUM   | 1     | ✅ resolved in v2 |
| LOW      | 4     | ✅ resolved in v2 |

---

## Approval

**Status:** ✅ Approved — 2026-04-29
**Approved by:** Rhiannon (via Opus review of v2 rewrite)
**Clarifications confirmed:** Default D/P fallback (D=2.2, P=12) is the agreed approach — no flat-rate fallback. M7 hybrid removal in scope. Display footnote references electricity Ofgem cap only; gas costs framed as historical. Sonnet's v2 rewrite extended hybrid-removal scope beyond the brief to include `test-m8.mjs` (T4b, T10b) and `test-m9.mjs` (hybrid keys throughout) — accepted as a thoroughness improvement, not a deviation.

---

## Implementation Deviations

**D1 — Duplicate `const scale` in `computeCosts`.**
When adding the pre-loop `scale` constant for cost decomposition, the existing inner `const scale = 365 / rateMetadata.data_period_days` inside the `for (const name of SCENARIO_ORDER)` loop would have caused a `SyntaxError` (block-scoped redeclaration). The inner declaration was removed; the outer `const scale = 365 / (rateMetadata.data_period_days || 365)` is used throughout. The `|| 365` guard protects the zero-data path where the inner version had no guard. No plan deviation — this is a required code hygiene fix to make the plan's pre-loop placement work.

**D2 — `.field-note` CSS class added alongside `.table-scroll-wrap`.**
The plan specified `.table-scroll-wrap`. A companion `.field-note` class (0.8rem, 75% opacity) was also added to `styles.css` to style the two footnote paragraphs the plan required below the table. Without it the footnotes render at body font size and full opacity, visually competing with the table. Not a plan deviation — the plan specified footnotes; the class is the minimal styling needed.

**D3 — Test-file hybrid cleanup extended beyond Step 1 brief.**
Step 1 listed `test-m8.mjs` hybrid entries (T4b standing charge, T10b), and `test-m9.mjs` hybrid scenario keys. These were cleaned up as part of Step 1 execution. Accepted by Opus review as a thoroughness improvement.
