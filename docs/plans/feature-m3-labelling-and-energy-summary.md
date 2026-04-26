# Feature — M3 Labelling Fix and Energy Summary Table

**Date:** 2026-04-26
**Status:** ✅ Approved in-session — 2026-04-26
**Depends on:** M3a, M3a-step-h, M3b, M4 all implemented

---

## Background

Diagnostic testing on Rhiannon's real data (2026-04-26) surfaced two labelling issues:

1. **"Air conditioning" label**: The CDD coefficient (62 kWh/year at high confidence, p=0.0004) is too small to plausibly indicate AC. The label "air conditioning" causes user alarm disproportionate to the signal. Better AC detection (e.g. threshold at >27°C) is deferred to a future module. For now, replace all "air conditioning" language with neutral "warm-weather electricity uplift".

2. **"Electric heating" label**: The HDD coefficient (464 kWh/year, p=0.0000) is a statistically real signal but likely reflects occupancy-correlated electricity use (more time at home on cold days, always-on lighting) rather than a space heater. The existing STEP_H_LIMITATIONS array lacks this explanation. Label kept (it IS a cold-weather signal) but softened in M4 4D warning, and limitation added.

3. **Energy summary table**: Diagnostic work produced a clean breakdown of annual energy by use type. Adding this to the M3 card turns the technical detection output into actionable context.

---

## Changes

### Change 1 — Drop "air conditioning" from all UI text

**Files:** `js/app.js`, `js/baseload.js`

- In `js/baseload.js` `STEP_H_LIMITATIONS`: remove or replace any mention of "air conditioning"
- In `js/app.js` `displayBaseloadResults()`: replace all "air conditioning" / "AC" display text with "warm-weather electricity uplift"
- Detection logic and `air_conditioning_*` fields on the result object: **unchanged** (may be used by future modules)
- Remove "air conditioning" from any warning strings generated in `detectSupplementaryLoads`

### Change 2 — Energy summary table in M3 card

**File:** `js/app.js`

New table appended to the M3 baseload card after the existing status summary. Columns: Category | kWh | % of total.

Rows (in this order):
1. Gas baseload — from `getBaseloadResult().heating` slot sums
2. Electricity baseline — `getIngestionResult()` actual total minus detected uplifts
3. Gas heating — from `getBaseloadResult().heating` slot sums
4. Electricity "heating" — `supplementary_loads.electric_heating_kwh_estimate ?? 0`
5. Electricity "cooling" — `(cdd_coefficient_kwh_per_dd ?? 0) × sum_cdd_k_day`
6. **Total** — sum of all above

Electricity total: actual sum of `elec_kwh` from `getIngestionResult().consumption`.
Electricity baseline: total elec − heating uplift − cooling uplift.
Gas figures: actual slot sums from `heating[]` array.

Table is only rendered when both `getBaseloadResult()` and `getIngestionResult()` are available (non-null). Denominator for % is gas total + electricity total.

### Change 3 — Add occupancy-correlation limitation to Step H

**File:** `js/baseload.js`

Add to `STEP_H_LIMITATIONS`:
> "Electricity use that correlates with temperature may reflect occupancy patterns — households tend to spend more time at home in very cold or very hot weather, increasing electricity use from always-on appliances and lighting. This is indistinguishable from heating or cooling equipment in aggregate daily data."

### Change 5 — Add progress updates during Elexon price fetch

**File:** `js/app.js` (or wherever `fetchWholesalePrices` / the chunk loop lives)

The Elexon chunked fetch loop (stride 7, ~52 chunks/year) blocks the browser long enough to trigger the "page unresponsive" warning with no visible progress. Fix: call `showProgressFn` with a percentage after each chunk completes. Also add at least one `await new Promise(r => setTimeout(r, 0))` yield per chunk to keep the browser responsive.

### Change 6 — Suppress individual SP count warnings from UI

**File:** `js/app.js` or `js/external-data.js` (wherever "Unexpected SP count" strings are generated)

Replace per-date "Unexpected SP count N for YYYY-MM-DD" lines in the UI with a single summary if any gaps are found: e.g. "Wholesale price data incomplete on N dates — affected periods will use null prices." Retain individual messages as `console.warn` only. The last date's partial count (today/yesterday with only 3 SPs) should also be suppressed from the UI.

### Change 4 — Soften M4 Step 4D warning text

**File:** `js/heat-loss.js`

Current: `"Your home appears to use some electric heating (estimated N kWh)."`
Proposed: `"Your electricity use rises in cold weather (estimated N kWh — possibly supplementary electric heating, EV charging, or winter occupancy patterns). Your heat loss may be underestimated by up to N W/K — an adjusted estimate is N W/K."`

---

## Files affected

| File | Change |
|------|--------|
| `js/baseload.js` | STEP_H_LIMITATIONS text; remove "air conditioning" from warning strings |
| `js/app.js` | displayBaseloadResults — drop AC label; new energy table render function |
| `js/heat-loss.js` | Step 4D warning text |

---

## Success criteria

- [ ] No occurrence of "air conditioning" or "AC" in any user-visible string in app.js
- [ ] Energy table renders in M3 card with correct row order and values matching console diagnostic
- [ ] Table % column sums to 100%
- [ ] Table hidden when M3 has not yet run
- [ ] Step 4D warning in M4 uses neutral "cold-weather electricity uplift" framing
- [ ] STEP_H_LIMITATIONS includes occupancy-correlation note
- [ ] All existing M3 and M4 tests still pass after changes

---

## Out of scope

- Better AC detection (>27°C threshold) — future module
- Occupancy correction to the electricity regression — algorithm change requiring design doc
- Any change to `air_conditioning_*` field names on the result object

---

## Notes

- `getIngestionResult()` is already imported in `app.js` (exposed as `window.__getIngestionResult`); no new imports needed
- Energy table must handle the case where `electric_heating_kwh_estimate` is null (detection off) — cooling uplift is always available as `cdd_coefficient × sum_cdd` regardless of detection flag
