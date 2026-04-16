# Module 3a — Baseload Separation: Core Computation

**Date:** 2026-04-16
**Status:** Awaiting approval — review via claude.ai before implementation begins.

---

## Task description

Implement the pure computation module `js/baseload.js` that separates each half-hourly gas consumption value into heating demand and non-heating baseload. This is the foundation for all downstream analysis: heat-loss regression, heat pump sizing, pricing scenarios, and the HH heating heatmap.

This phase covers the full separation logic (Methods A–E), absence detection, and R² validation — all stateless computation with no UI or orchestration wiring. Phase 3b will handle app.js integration and UI display.

---

## Research findings

**No external libraries required.** The module is pure arithmetic over arrays:
- Median computation: no library needed; a simple sort-and-pick implementation suffices for arrays of ≤90 values per HH slot.
- Linear regression (R²): single-variable OLS for the validation step. ~15 lines of code. No need for a statistics library.
- All timestamp arithmetic already uses Luxon (available globally via the existing project setup).

**Existing code reviewed:**
- `external-data.js` — established pattern for module structure: config constants at top, exported functions, no classes.
- `data-ingestion.js` — `normaliseConsumption()` establishes the `consumption[]` shape: `{ timestamp, gas_kwh, elec_kwh }`.
- `app.js` — Module 2 orchestration pattern (`runExternalData()`) shows how Module 3 will be wired in Phase 3b.

**Reuse from codebase:** None directly. The module is new computation. The getter/setter pattern (`getExternalResult`/`setExternalResult`) will be replicated for `getBaseloadResult`/`setBaseloadResult`.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/baseload.js` | Core baseload separation module — all methods, absence detection, validation |

---

## Implementation steps

### Step 1 — Module scaffold and shared state (Low complexity)

Create `js/baseload.js` with:
- Module-level config constants:
  ```js
  const BASELOAD_CONFIG = {
    SUMMER_MONTHS: [6, 7, 8],
    METHOD_A_MIN_SUMMER_DAYS: 60,
    METHOD_A_MIN_WEEKDAY_DAYS: 20,
    METHOD_A_MIN_WEEKEND_DAYS: 20,
    METHOD_B_MIN_SUMMER_DAYS: 30,
    METHOD_C_MIN_SUMMER_DAYS: 14,
    ABSENCE_THRESHOLD_FRACTION: 0.20,
    ABSENCE_MIN_CONSECUTIVE_DAYS: 3,
    LITERATURE_BASELOAD_KWH_PER_DAY: 8,
    DEGREE_DAY_BASE_TEMP: 15.5,
    VALIDATION_MIN_HEATING_DAYS: 14,
    R2_GOOD_THRESHOLD: 0.7,
    R2_ACCEPTABLE_THRESHOLD: 0.5,
    HIGH_ABSENCE_WARNING_DAYS: 30,
    EXCESSIVE_ABSENCE_DAYS: 300,
    BALANCE_POINT_FLATNESS_FRACTION: 0.20,
    BALANCE_POINT_MIN_DAYS_PER_BIN: 3,
  };
  ```
- Shared state: `_baseloadResult` with `setBaseloadResult()` / `getBaseloadResult()` exports.

### Step 2 — Helper functions (Low complexity)

Implement utility functions used across methods:

- `median(arr)` — returns median of a numeric array. Handles even/odd length. Ignores nulls.
- `hhOfDay(timestamp)` — returns 0–47 HH slot index from an ISO timestamp (UTC).
- `isWeekday(timestamp)` — returns true for Mon–Fri (UTC).
- `groupByDay(records)` — groups an array of `{ timestamp, ... }` records into a Map keyed by ISO date string (`yyyy-mm-dd`), each value an array of that day's records.
- `isWholeDay(dayRecords)` — returns true if array has exactly 48 non-null-gas records.
- `computeOlsR2(xs, ys)` — single-variable OLS R² (coefficient of determination). Returns null if fewer than 2 points or zero variance in x.

### Step 3 — Pre-flight: no-gas detection (Low complexity)

Export function `checkNoGas(consumption)`:
- Returns `true` if every record has `gas_kwh === null` or `gas_kwh === 0`.
- If true, `separateBaseload()` (Step 8) short-circuits: sets all `heating_kwh = 0`, `baseload_kwh = 0`, `is_absence = false`, method = `"no-gas"`, `validation_status = "no_gas"`, warning per design doc.

### Step 4 — Method A: Summer HH-profile with weekday/weekend split (High complexity)

Export function `methodA(consumption, summerDays)`:

**Sub-step A1 — Identify summer window:**
- Filter consumption to records where the UTC month is in `SUMMER_MONTHS`.
- Group by day; keep only whole days (48 non-null gas HH records).
- Count total summer days, weekday days, weekend days.
- Return eligibility boolean + the summer records + the window boundaries.

**Sub-step A2 — Compute HH profiles (median):**
- For each HH slot 0–47, for each day-type {weekday, weekend}:
  - Collect all `gas_kwh` values from summer records matching that slot + day-type.
  - Compute `median()`.
- Produces `weekdayProfile[48]` and `weekendProfile[48]`.

**Sub-step A3 — Apply profile to full dataset:**
- For each consumption record:
  - Look up the appropriate profile value by HH slot and day-type.
  - `baseload_kwh = min(profile_value, gas_kwh)` — clamping.
  - `heating_kwh = gas_kwh - baseload_kwh`.
- Return `heating[]` array + method string.

### Step 5 — Methods B, C, D, E: Fallbacks (Medium complexity)

Each as a separate exported function, following the same return signature as Method A:

**Method B** — `methodB(consumption, summerDays)`:
- Single 48-slot profile (no weekday/weekend split). Median per slot.
- Eligibility: `summer_days_used >= 30`.

**Method C** — `methodC(consumption, summerDays)`:
- Flat daily baseload: `median(daily_gas_totals) / 48`.
- Eligibility: `summer_days_used >= 14`.

**Method D** — `methodD(consumption, external)`:
- Aggregate to daily gas + daily mean temp.
- Bin by 1°C temperature bins.
- Find balance point: lowest bin where median gas ≤ 1.2× warmest-bin median.
- Baseload = median gas of days above balance point, distributed flat across 48 HH.
- Returns null (fall through to E) if no balance point found.

**Method E** — `methodE(consumption)`:
- Literature default: 8 kWh/day ÷ 48 = ~0.167 kWh per HH.
- Always succeeds.

All methods apply the same clamping rule: `baseload_kwh = min(estimate, gas_kwh)`, `heating_kwh = gas_kwh - baseload_kwh`.

### Step 6 — Step F: Absence detection (Medium complexity)

Export function `detectAbsences(consumption, heating, baseloadMedianPerDay)`:

1. Aggregate `heating[]` to daily totals (whole days only).
2. Compute threshold: `0.20 × baseloadMedianPerDay`.
3. Mark each day as low-gas if `daily_gas_kwh < threshold`.
4. Find runs of ≥3 consecutive low-gas days → absence periods.
5. Set `is_absence = true` on all HH records within absence period date ranges.
6. Return updated `heating[]` + `absence_periods` + `absence_days_total`.
7. If `absence_days_total > 30`, generate informational warning.
8. If `absence_days_total > 300`, set `validation_status = "insufficient_data"` with warning.

### Step 7 — Step G: Validation (Medium complexity)

Export function `validateSeparation(heating, external)`:

1. Aggregate to daily: `daily_heating_kwh` and `daily_mean_temp_c` for each whole day.
2. Exclude days where any HH has `is_absence = true`.
3. Compute `daily_degree_days = max(0, 15.5 - daily_mean_temp_c)`.
4. Filter to days with `daily_degree_days > 0`.
5. If fewer than 14 qualifying days: return `r2 = null`, `validation_status = "insufficient_data"`.
6. Compute R² via `computeOlsR2(degree_days, heating_kwh)`.
7. Map R² to `validation_status`: good / acceptable / poor.
8. If poor, generate warning per design doc.

### Step 8 — Main orchestrator function (Medium complexity)

Export function `separateBaseload(consumption, external)`:

This is the public API — called from app.js in Phase 3b.

1. **No-gas check:** if `checkNoGas(consumption)`, return early with no-gas result.
2. **Identify summer days:** extract summer window from consumption.
3. **Method cascade:**
   - Try Method A → if ineligible, try B → if ineligible, try C → if ineligible, try D → if fails, use E.
4. **Absence detection:** run `detectAbsences()` on the result.
5. **Validation:** run `validateSeparation()`.
6. **Assemble metadata:** populate all `baseload_metadata` fields per design doc.
7. **Return:** `{ heating, baseload_metadata }`.

The method cascade is a simple if/else-if chain — no complex routing needed.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Median computation slow on large datasets | Summer data is at most ~90 days × 48 HH = 4,320 values per slot. Sorting 90 values is trivial. No optimisation needed. |
| Floating-point drift breaking the invariant `heating + baseload = gas` | Both are derived from the same `gas_kwh` value via subtraction. The clamping path (`baseload = gas, heating = 0`) is exact. Standard path (`heating = gas - baseload`) has at most 1 ULP of drift, well within the 0.001 kWh tolerance. |
| Method D balance-point detection fragile with sparse bins | Require ≥3 days per bin before using its median. Bins with fewer days are skipped. If no valid balance point found, fall through to Method E cleanly. |
| R² computation on degenerate data (zero variance) | `computeOlsR2` returns null if x has zero variance or fewer than 2 points. Caller maps null to `"insufficient_data"`. |
| Accidentally using mean instead of median | Config and function names encode "median" explicitly. Step A2 comment block warns against mean as an anti-pattern. |

---

## Success criteria

- [ ] `separateBaseload()` returns correctly shaped `{ heating, baseload_metadata }` matching the design doc output spec
- [ ] Invariant holds: for every non-null record, `heating_kwh + baseload_kwh === gas_kwh` within 0.001 kWh
- [ ] `heating_kwh >= 0` and `baseload_kwh >= 0` for every record (clamping works)
- [ ] No-gas case short-circuits cleanly: method = `"no-gas"`, all zeros, warning generated
- [ ] Method cascade: A → B → C → D → E falls through correctly based on data availability
- [ ] Method A uses median (not mean) and splits weekday/weekend
- [ ] Absence detection identifies runs of ≥3 consecutive low-gas days, ignores shorter runs
- [ ] Absence days excluded from R² regression
- [ ] R² maps to correct validation_status thresholds (0.7 / 0.5)
- [ ] Degree-day base temperature is 15.5°C (matches heat-loss module constant)
- [ ] All warnings per design doc are generated in appropriate conditions
- [ ] Module exports `getBaseloadResult()` / `setBaseloadResult()` following established pattern
- [ ] No UI code, no DOM references, no side effects beyond the shared state setter

---

## Claude.ai Review — yyyy-mm-dd

**Reviewer:** Claude (claude.ai)

**Overall verdict:** [Pending]

---

## Approval

**Status:** [Pending]

---

## Implementation Deviations

[To be completed during implementation]
