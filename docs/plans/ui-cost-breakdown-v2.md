# ui-cost-breakdown-v2 — §11 Annual Running Costs · §12 Savings & Payback

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the COST BREAKDOWN section: §11 Annual Running Costs (six-component table +
adaptive blue box) and §12 Savings & Payback (decomposed-savings table + payback with
INV-17 denominator). Both are output-only cards (no Recalculate), reactive to all
upstream changes.

Design doc: `ui-overhaul-cost-breakdown.md`. Required read: `ui-overhaul-conventions-v2.md`.

**Key changes from v1:**
- §11a: six-component table (Gas/Elec × Heat/Non-Heat/Fixed + Total); layered two-row
  headers; full-bill scope including `elec_nonheat` (~£1,000 on Rhiannon's data — INV-8).
- §11b: adaptive blue box repurposed from data-quality hedge to analytical summary.
- §12a: decomposed-savings columns (Tariff / HP heating / Smart shift / Total / Payback).
- §12a HP payback denominator = `hp_attributable_saving` (same-tariff current, not total
  — INV-17); `Current — HH` shows "Instant (no install)"; `Std. HP — flat` shows "No saving".
- §12b: BUS-grant note rewrite.

**Implementation prerequisite:** m8-v2 + m9-v2 implemented.

---

## Research findings

**Existing §11 (pricing table):** `displayPricingResults()` in `app.js`. Currently renders
a 4-scenario table with a 4-component cost breakdown. Full rewrite of this function for
the new 5-scenario, 6-component shape.

**Existing §12 (financial results):** `displayFinancialResults()` in `app.js`. Currently
shows a payback table with total-saving denominator. Full rewrite for the decomposed
columns + `hp_attributable_saving` denominator.

**Adaptive copy (§11b):** shared `buildAdaptiveCopy(m8, m9)` implemented in
`ui-results-and-your-home-v2` — reuse; do not re-implement.

**10d toggle reactivity:** when the §10d keep-gas toggle fires, the pipeline reruns M7→M8→M9
and both tables re-render from the new m8-v2 output. The gas columns on HP rows go blank/0
when toggle OFF (gas_kwh = 0 in dumb_hp/smart → M8 `gas_heat = gas_nonheat = gas_fixed = 0`
for those scenarios). This is structural — M8's outputs already reflect it.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `app.js` | Rewrite `displayPricingResults()` + `displayFinancialResults()` |
| MODIFY | `index.html` | §11/§12 table container structure; blue-box element; footnote; BUS note |
| MODIFY | `css/style.css` | Layered headers; G1 row names; blue-box style; footnote |

---

## Implementation steps

### Step 1 — §11a Table HTML structure

In `index.html`, replace the existing §11 table with a container div; JS generates the
table HTML dynamically. Alternatively, keep a skeleton:

```html
<div id="annual-costs-table-container" class="table-scroll-wrap"></div>
```

### Step 2 — `buildAnnualCostsTable(pricingResult)` in `app.js`

New function replacing the relevant block of `displayPricingResults`. Generates the full
§11a HTML string:

```
Headers (two rows):
  Row 1: | Scenario | Gas (×3) | Electricity (×3) | Total |
  Row 2: |          | Heat | Non-Heat | Fixed | Heat | Non-Heat | Fixed |

Data rows (G1 order — 5 scenarios):
  Current — flat rate
  Std. HP — flat rate
  Current — HH rate
  Std. HP — HH rate
  Smart HP — HH rate  (or "—" cells if null)
```

Each cell value: from m8-v2 `components.{gas_heat, gas_nonheat, gas_fixed, elec_heat,
elec_nonheat, elec_fixed}_gbp`; formatted £ at 0 dp (G2). Total = `annual_cost_gbp`.

**Null/zero rendering:** when a component is 0 (e.g. `gas_heat` for HP scenarios with
toggle OFF), render `—` not `£0`. Use `val == null || val === 0 ? '—' : formatGbp(val)`.

### Step 3 — §11b Adaptive blue box

Above the §11a table, a `<div class="blue-box" id="cost-summary-box">` populated by
`buildAdaptiveCopy(pricingResult.scenarios, financialResult)` (shared function from
`ui-results-and-your-home-v2`).

### Step 4 — §12a Table HTML

```html
<div id="savings-payback-table-container"></div>
```

### Step 5 — `buildSavingsPaybackTable(financialResult, pricingResult)` in `app.js`

Columns: **Scenario | Tariff saving | HP heating | Smart shift | Total saving | HP payback**

Data from m9-v2:
- `tariff_saving_gbp`: shown on HH-rate rows; `—` on flat-rate rows.
- `hp_heating_component_gbp` (per scenario from m9-v2 headline or per-scenario delta): shown on HP rows.
- `smart_shift_saving_gbp`: shown on Smart HP row only.
- `total_saving_vs_current_flat_gbp`: all rows.
- `payback_years`/`payback_status`:
  - `Current — flat rate`: `—`
  - `Current — HH rate`: `Instant (no install)` (tariff saving, no HP)
  - `std_hp_flat` no_saving: `No saving`
  - `std_hp_hh`/`smart_hp_hh` positive: `~X yr`
  - `null` / `no_data`: `—`

### Step 6 — §12a Footnote

Below the §12a table, add as `<p class="table-footnote">`:
> *"HP payback is computed against HP-specific saving only (heating + Smart shift), not
> total saving. The tariff component is a separate decision with no install cost — you
> could capture the Half-Hourly saving without committing to a heat pump."*

### Step 7 — §12b BUS-grant note rewrite

Replace the existing BUS note in `index.html`/`app.js` with:
> *"Figures assume a full HP installation (no internal layout changes) at £12,500. The
> Boiler Upgrade Scheme (BUS) grant of £7,500 is deducted by default. Toggle 'Keep gas
> for hot water + cooking' to model a gas-retained scenario; this affects your net
> install estimate. Use the 'Avoided AC cost' input to offset the cost if you're
> replacing air conditioning at the same time. Explore rate and technology sensitivities
> in the Policy Reform and Wait for Technology cards."*

### Step 8 — Reactivity wiring

Confirm that calling `displayFinancialResults(newFinancialResult)` and
`displayPricingResults(newPricingResult)` (or their v2 equivalents) are wired into
every rerun path: M9-fast (§10B inputs), M8+M9 (§14 tariff rerun), M6→M9 (§15 COP
rerun), M7→M9 (§10d toggle / §10 sizing rerun). These wiring points should already exist
in `runFinancialAnalysis` / `buildAndDisplayVerdict` — verify rather than add new ones.

### Step 9 — `displayPricingResults` and `displayFinancialResults` cleanup

Remove v1 code paths:
- The old `heating_gas_gbp`/`non_heating_gas_gbp`/`non_heating_elec_gbp`/`heating_elec_gbp`
  four-component decomposition (replaced by six-component).
- The `dumb_hp_svt`/`dumb_hp_hh` separate rendering (v2 uses `std_hp_flat`/`std_hp_hh`).
- The old `annual_saving_gbp` payback denominator (replaced by `hp_attributable_saving_gbp`).
- The 5×5 sensitivity grid display (removed — m9-v2 has no grid).

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| v1 test-m8.mjs / test-m9.mjs suites reference old scenario keys | Per m8-m9 plan: retire these suites; test-m8m9.mjs is the replacement |
| `buildAdaptiveCopy` not yet available (depends on ui-results-and-your-home-v2) | Implementation prerequisite: that plan must be implemented first |
| Stacked 11a table may be wide on smaller screens | Design doc confirms no mobile-scroll concern (Rhiannon 2026-06-02) — use full-width; no scroll-wrap needed |

---

## Success criteria

- [ ] §11a shows six-component table with two-row layered headers; G1 rows in correct order
- [ ] Current-flat Total ≈ real bill (~£2,000 for Rhiannon); Elec Non-Heat ~£1,000 present
- [ ] Six-component identity holds per row: Total = sum of six cells
- [ ] 10d OFF default: HP rows gas-free (all `—`); DHW+cooking in Elec Non-Heat
- [ ] 10d ON: HP rows show Gas Non-Heat + Gas Fixed
- [ ] §11b blue box renders adaptive copy; static fallback only when logic can't decide
- [ ] §12a shows Tariff/HP-heating/Smart-shift/Total/Payback columns
- [ ] Smart-HP payback denominator = HP heating + Smart shift; `~30 yr` not `~11 yr`
- [ ] Current-HH payback reads "Instant (no install)"; Std-HP-flat reads "No saving"
- [ ] §12a footnote present; §12b BUS note updated
- [ ] §3 verdict bars = §11a Totals (reconciliation invariant — no divergent "current cost")
- [ ] Smart-null: Smart row shows "—"; headline falls back to Std-HP-HH; no crash

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
