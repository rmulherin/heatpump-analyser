# Feature — M3 Labelling Fix and Energy Summary Table

**Date:** 2026-04-26
**Status:** ✅ Implemented — 2026-04-26 (commit f74c1f1)
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

**Files:** `js/external-data.js` (chunk loop), `js/app.js` (call site)

The existing progress mechanism is `showProgress(text, percent)` in `app.js`. Pipeline stages pass it down as `showProgressFn` — a callback taking `(text, percent?)`. `fetchWholesalePrices` currently takes no progress callback and has no yield points; this is why the browser freezes.

**Two-part fix:**

1. **`js/external-data.js`** — add an optional third parameter `onProgress` to `fetchWholesalePrices(dataStart, dataEnd, onProgress)`. Compute `totalChunks` before the loop as `Math.ceil((endDate - startDate) / (7 * 86400000)) + 1`. After each chunk completes, call `onProgress?.(Math.round((chunksDone / totalChunks) * 100))` and then `await new Promise(r => setTimeout(r, 0))` to yield to the browser.

2. **`js/app.js`** — update the `fetchWholesalePrices` call site in `runExternalData` (currently line 596) from:
   ```js
   fetchWholesalePrices(metadata.data_start, metadata.data_end)
   ```
   to:
   ```js
   fetchWholesalePrices(metadata.data_start, metadata.data_end,
     (pct) => showProgressFn(`Fetching price data… ${pct}%`))
   ```
   The call is inside `Promise.allSettled` alongside `fetchWeather`; the progress callback wires through without changing the settled-result structure.

The `await` yield is the primary fix for the unresponsive-page warning. The `onProgress` callback is a secondary UX improvement.

### Change 6 — Suppress individual SP count warnings from UI

**Files:** `js/app.js` (filtering at call site), `js/external-data.js` (retain as `console.warn`)

"Unexpected SP count N for YYYY-MM-DD" warnings are generated in `convertSpToUtc` (external-data.js line ~321) and returned in the `warnings` array of `fetchWholesalePrices`. In `app.js` `runExternalData`, these are emitted one-by-one via `showStatusFn(w, 'warning')` (currently lines ~619–621).

**Fix in `js/app.js`:** Before the `for (const w of priceWarnings)` loop, partition warnings into SP-count warnings and others. Emit non-SP-count warnings as before. If any SP-count warnings exist, emit a single summary: `"Wholesale price data incomplete on N dates — affected periods will use null prices."` Log the individual messages with `console.warn` instead.

**Fix in `js/external-data.js`:** No change to generation logic — individual warnings are still built and returned. The suppression happens entirely at the call site in `app.js`.

### Change 4 — Soften M4 Step 4D warning text

**File:** `js/heat-loss.js`

Current: `"Your home appears to use some electric heating (estimated N kWh)."`
Proposed: `"Your electricity use rises in cold weather (estimated N kWh — possibly supplementary electric heating, EV charging, or winter occupancy patterns). Your heat loss may be underestimated by up to N W/K — an adjusted estimate is N W/K."`

---

## Files affected

| File | Change |
|------|--------|
| `js/baseload.js` | STEP_H_LIMITATIONS text; remove "air conditioning" from warning strings |
| `js/app.js` | displayBaseloadResults — drop AC label; new energy table render function; progress callback at fetchWholesalePrices call site; SP count warning suppression |
| `js/heat-loss.js` | Step 4D warning text |
| `js/external-data.js` | fetchWholesalePrices — add optional onProgress param; yield per chunk |

---

## Success criteria

- [ ] No occurrence of "air conditioning" or "AC" in any user-visible string in app.js
- [ ] Energy table renders in M3 card with correct row order and values matching console diagnostic
- [ ] Table % column sums to 100%
- [ ] Table hidden when M3 has not yet run
- [ ] Step 4D warning in M4 uses neutral "cold-weather electricity uplift" framing
- [ ] STEP_H_LIMITATIONS includes occupancy-correlation note
- [ ] All existing M3 and M4 tests still pass after changes
- [ ] (B1) No "page unresponsive" browser warning during Elexon fetch on a large date range; progress percentage visible in UI while fetch runs
- [ ] (B2) SP count warnings reduced to a single summary line in the status panel; individual per-date messages suppressed to console only

---

## Out of scope

- Better AC detection (>27°C threshold) — future module
- Occupancy correction to the electricity regression — algorithm change requiring design doc
- Any change to `air_conditioning_*` field names on the result object

---

## Notes

- `getIngestionResult()` is already imported in `app.js` (exposed as `window.__getIngestionResult`); no new imports needed
- Energy table must handle the case where `electric_heating_kwh_estimate` is null (detection off) — cooling uplift is always available as `cdd_coefficient × sum_cdd` regardless of detection flag

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-26
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `baseload-separation.md`, `heat-loss.md` (M3/M4 modules)

### Context

Plan produced by Sonnet following diagnostic testing on Rhiannon's real data (2026-04-26). Two labelling issues and an energy summary table were identified, plus two bugs (Elexon fetch blocking the browser; SP count warning noise). Initial review raised one HIGH finding: Change 5 was under-specified — `showProgressFn` was named as the callback but not defined, leaving Sonnet to infer the existing function signature. Rhiannon edited the plan to add the full specification before re-review.

### Required changes for implementation

No required changes remain. The HIGH finding was resolved by Rhiannon's edit to Change 5. Two missing success criteria (B1, B2) were added inline as a LOW observation.

### Resolution of review changes

1. **Change 5 progress callback under-specified (HIGH)** — resolved by Rhiannon's edit. Plan now specifies `showProgress(text, percent)` as the existing mechanism, `onProgress` as the optional third parameter to `fetchWholesalePrices`, the `await new Promise(r => setTimeout(r, 0))` yield, and the call site at app.js line 596.
2. **Missing B1/B2 success criteria (LOW)** — resolved inline. Two criteria appended to Success criteria section.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | ✓ pass |
| HIGH     | 1     | ✅ resolved |
| MEDIUM   | 0     | ✓ pass |
| LOW      | 1     | ✅ resolved |

Verdict: APPROVE — all findings resolved before implementation; highest-risk item is Change 2 field names matching M3b result object exactly, covered by the "values matching console diagnostic" success criterion.

---

## Approval

**Status:** ✅ Approved — 2026-04-26
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** `setTimeout(r, 0)` yield is the correct browser event loop mechanism for B1. Change 5 call site is app.js line 596 inside `runExternalData`. Field names `electric_heating_kwh_estimate`, `cdd_coefficient_kwh_per_dd`, `sum_cdd_k_day` must match M3b result object exactly — verify at implementation time.
