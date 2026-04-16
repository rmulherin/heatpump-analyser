# Module 3a — Baseload Separation: Core Computation

**Date:** 2026-04-16
**Status:** Awaiting approval — review via claude.ai before implementation begins.

---

## Task description

Implement the pure computation module `js/baseload.js` that separates each half-hourly gas consumption value into heating demand and non-heating baseload, detects absence periods, validates the separation against degree-days, and detects supplementary electric heating and air conditioning via electricity-vs-temperature regression (Step H).

This is the foundation for all downstream analysis: heat-loss regression (which also consumes the `supplementary_loads` output for Check 4D), heat pump sizing, pricing scenarios, and the HH heating heatmap.

This phase covers all stateless computation with no UI or orchestration wiring. Phase 3b handles app.js integration and UI display.

---

## Research findings

**No external libraries required.** The module is pure arithmetic over arrays:
- Median computation: simple sort-and-pick for arrays of ≤90 values per HH slot.
- Single-variable OLS R² (Step G validation): ~15 lines of code.
- Multi-variable OLS with p-values (Step H regression): requires solving a 3-parameter linear regression (`daily_elec = a × HDD + b × CDD + c`) with standard error estimates and t-test p-values. This is more involved than single-variable OLS but still implementable in ~60–80 lines of vanilla JS using the normal equations and t-distribution approximation. No statistics library needed.
- All timestamp arithmetic uses Luxon (available globally via CDN).

**Existing code reviewed:**
- `external-data.js` — established pattern: config constants at top, exported functions, no classes.
- `data-ingestion.js` — `normaliseConsumption()` establishes the `consumption[]` shape: `{ timestamp, gas_kwh, elec_kwh }`.
- `app.js` — Module 2 orchestration pattern (`runExternalData()`) shows how Module 3 will be wired in Phase 3b.

**Reuse from codebase:** None directly. The module is new computation. The getter/setter pattern (`getExternalResult`/`setExternalResult`) will be replicated for `getBaseloadResult`/`setBaseloadResult`.

**OLS implementation note:** Step H requires p-values for the HDD and CDD coefficients. The standard approach is:
1. Solve the normal equations `(X'X)^{-1} X'y` for a 3-column design matrix `[HDD, CDD, 1]`.
2. Compute residual variance `s² = RSS / (n - 3)`.
3. Standard errors from the diagonal of `s² × (X'X)^{-1}`.
4. t-statistics = coefficient / standard error.
5. Two-tailed p-values from the t-distribution with `n - 3` degrees of freedom, using an approximation (the Abramowitz & Stegun rational approximation to the normal CDF is sufficient for p-value thresholds of 0.01 and 0.05 — t-distribution with df > 25 is very close to normal, and Step H requires ≥30 days).

This avoids any need for a statistics library while producing reliable p-values for the detection thresholds specified in the design doc.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/baseload.js` | Core baseload separation module — Methods A–E, absence detection (Step F), validation (Step G), supplementary electric load detection (Step H) |

---

## Implementation steps

### Step 1 — Module scaffold and shared state (Low complexity)

Create `js/baseload.js` with:
- Module-level config constants:
  ```js
  const BASELOAD_CONFIG = {
    // Summer window
    SUMMER_MONTHS: [6, 7, 8],
    // Method eligibility thresholds
    METHOD_A_MIN_SUMMER_DAYS: 60,
    METHOD_A_MIN_WEEKDAY_DAYS: 20,
    METHOD_A_MIN_WEEKEND_DAYS: 20,
    METHOD_B_MIN_SUMMER_DAYS: 30,
    METHOD_C_MIN_SUMMER_DAYS: 14,
    // Absence detection
    ABSENCE_THRESHOLD_FRACTION: 0.20,
    ABSENCE_MIN_CONSECUTIVE_DAYS: 3,
    HIGH_ABSENCE_WARNING_DAYS: 30,
    EXCESSIVE_ABSENCE_DAYS: 300,
    // Literature fallback
    LITERATURE_BASELOAD_KWH_PER_DAY: 8,
    // Degree-day bases
    HDD_BASE_TEMP: 15.5,       // CIBSE TM41 — must match heat-loss module
    CDD_BASE_TEMP: 22,         // UK convention for cooling
    // Validation
    VALIDATION_MIN_HEATING_DAYS: 14,
    R2_GOOD_THRESHOLD: 0.7,
    R2_ACCEPTABLE_THRESHOLD: 0.5,
    // Balance-point method
    BALANCE_POINT_FLATNESS_FRACTION: 0.20,
    BALANCE_POINT_MIN_DAYS_PER_BIN: 3,
    // Step H — supplementary load detection
    STEP_H_MIN_DAYS: 30,
    STEP_H_ELECTRIC_HEATING_COEFF_THRESHOLD: 0.2,  // kWh/K·day
    STEP_H_AC_COEFF_THRESHOLD: 0.2,                // kWh/K·day
    STEP_H_P_VALUE_THRESHOLD: 0.05,
    STEP_H_HIGH_COEFF: 0.5,
    STEP_H_HIGH_P: 0.01,
    STEP_H_LOW_COEFF: 0.1,
    STEP_H_LOW_P: 0.20,
    STEP_H_MIN_SUM_CDD: 20,   // K·day — AC eligibility guard
  };
  ```
- Shared state: `_baseloadResult` with `setBaseloadResult()` / `getBaseloadResult()` exports.

### Step 2 — Helper functions (Medium complexity)

Implement utility functions used across methods:

- `median(arr)` — returns median of a numeric array. Handles even/odd length. Filters out nulls.
- `hhOfDay(timestamp)` — returns 0–47 HH slot index from an ISO timestamp (UTC).
- `isWeekday(timestamp)` — returns true for Mon–Fri (UTC).
- `groupByDay(records)` — groups an array of `{ timestamp, ... }` records into a Map keyed by ISO date string (`yyyy-mm-dd`), each value an array of that day's records.
- `isWholeDay(dayRecords, field)` — returns true if array has exactly 48 records with non-null values for `field` (e.g. `'gas_kwh'` or `'elec_kwh'`).
- `computeOlsR2(xs, ys)` — single-variable OLS R² (coefficient of determination). Returns null if fewer than 2 points or zero variance in x.
- `computeMultiOls(ys, xMatrix)` — multi-variable OLS via the normal equations. `xMatrix` is an array of arrays (each inner array is one row of predictors, intercept column included by caller). Returns `{ coefficients, standardErrors, tStatistics, pValues, residualVariance }` or null if matrix is singular or `n < columns + 1`.
- `tDistPValue(t, df)` — two-tailed p-value approximation for the t-distribution. For df ≥ 30 (guaranteed by Step H's minimum days), uses the normal approximation via the Abramowitz & Stegun rational formula. Sufficient accuracy for the 0.01 and 0.05 thresholds.

### Step 3 — Pre-flight: no-gas detection (Low complexity)

Export function `checkNoGas(consumption)`:
- Returns `true` if every record has `gas_kwh === null` or `gas_kwh === 0`.
- If true, `separateBaseload()` (Step 10) short-circuits the gas separation: sets all `heating_kwh = 0`, `baseload_kwh = 0`, `is_absence = false`, method = `"no-gas"`, `validation_status = "no_gas"`, warning per design doc.
- **Step H still runs** after the no-gas short-circuit — it is called unconditionally in the orchestrator (Step 10).

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

**Anti-pattern: do not use `mean()` here.** The design doc is explicit — median is non-negotiable for robustness to summer outliers.

**Sub-step A3 — Apply profile to full dataset:**
- For each consumption record:
  - Look up the appropriate profile value by HH slot and day-type.
  - `baseload_kwh = min(profile_value, gas_kwh)` — clamping.
  - `heating_kwh = gas_kwh - baseload_kwh`.
- Return `heating[]` array + method string + summer window metadata.

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

All methods apply the same clamping rule: `baseload_kwh = min(estimate, gas_kwh)`, `heating_kwh = gas_kwh - baseload_kwh`. Neither value ever negative.

### Step 6 — Step F: Absence detection (Medium complexity)

Export function `detectAbsences(consumption, heating, baseloadMedianPerDay)`:

1. Aggregate to daily totals using `gas_kwh` from consumption (whole days only).
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

### Step 8 — Step H: Supplementary electric load detection (High complexity)

Export function `detectSupplementaryLoads(consumption, external, heating, baseloadMethod)`:

This is the most algorithmically involved step. It fits a 3-parameter OLS regression of daily electricity consumption against HDD and CDD to detect supplementary electric heating and air conditioning.

**Sub-step H0 — Pre-flight:**
- If every `consumption[i].elec_kwh` is null: return `{ method: "skipped_no_electricity", ... }` with all detection booleans false, all coefficients null, limitations populated.
- Build the daily regression dataset: for each whole non-absence day (all 48 HH periods non-null for the relevant fuel — gas AND elec in the normal case; elec only in the no-gas case; non-null `temp_c`):
  ```
  daily_elec_kwh    = sum(elec_kwh over 48 HH periods)
  daily_mean_temp_c = mean(temp_c over 24 hourly values, derived from 48 HH temp values)
  daily_hdd         = max(0, 15.5 - daily_mean_temp_c)
  daily_cdd         = max(0, daily_mean_temp_c - 22)
  ```
- If `days_used_in_fit < 30`: return `{ method: "skipped_insufficient_data", ... }` with all detection booleans false, all coefficients null, limitations populated.

**Sub-step H1 — OLS regression with intercept:**
- Build design matrix X with columns `[HDD, CDD, 1]` (intercept column last).
- Build response vector y = `daily_elec_kwh`.
- Call `computeMultiOls(y, X)` to get coefficients `[a, b, c]`, p-values `[p_a, p_b, p_c]`.
- `a` = HDD slope (kWh/K·day), `b` = CDD slope (kWh/K·day), `c` = intercept (baseline kWh/day).
- Compute `sum_hdd = Σ daily_hdd` and `sum_cdd = Σ daily_cdd` over the fit set.

**Anti-pattern: do NOT use a through-origin fit.** The design doc is explicit — electricity has a real non-zero baseline (fridge, lighting, standby). Through-origin forces spurious non-zero HDD slope. Test 18 specifically catches this.

**Sub-step H2 — Electric heating detection:**
```
electric_heating_detected = (a > 0.2) AND (p_a < 0.05)
```
- If detected: `electric_heating_kwh_per_dd = a`, `electric_heating_kwh_estimate = a × sum_hdd`.
- Else: both null.
- Confidence:
  - `"high"` — a ≥ 0.5 AND p_a < 0.01
  - `"moderate"` — detected but not high
  - `"low"` — not detected, but a > 0.1 AND 0.05 ≤ p_a < 0.20
  - `"none"` — otherwise

**Sub-step H3 — AC detection:**
- If `sum_cdd < 20`: skip AC detection entirely. Set `air_conditioning_detected = false`, confidence = `"none"`, `ac_detection_note = "insufficient_cdd_data"`. Return from AC branch.
- Otherwise:
  ```
  air_conditioning_detected = (b > 0.2) AND (p_b < 0.05)
  ```
- If detected: `air_conditioning_kwh_per_dd = b`, `air_conditioning_kwh_estimate = b × sum_cdd`, `ac_detection_note = null`.
- Confidence follows same tier structure as electric heating.

**Sub-step H4 — No-gas case framing:**
- If `baseloadMethod === "no-gas"` AND `electric_heating_detected`: set `electric_heating_is_primary = true`.
- Otherwise: `electric_heating_is_primary = false`.

**Sub-step H5 — Limitations (always populated):**
Populate `limitations` array with the three MVP limitation strings from the design doc:
1. Solar PV / net metering caveat.
2. Existing heat pump indistinguishable from resistance heating.
3. Electric water heating appears in baseline.

Return the full `supplementary_loads` object per the design doc output spec.

### Step 9 — Step H regression edge case: singular matrix (Low complexity)

In `computeMultiOls`, if the `(X'X)` matrix is singular (e.g. zero variance in HDD — all days have the same temperature), return null. The caller (`detectSupplementaryLoads`) treats null as equivalent to `"skipped_insufficient_data"`.

### Step 10 — Main orchestrator function (Medium complexity)

Export function `separateBaseload(consumption, external)`:

This is the public API — called from app.js in Phase 3b.

1. **No-gas check:** if `checkNoGas(consumption)`, build no-gas result for the gas-separation portion (all zeros, method = `"no-gas"`). Do NOT return yet — Step H still needs to run.
2. **Gas separation (if not no-gas):**
   a. Identify summer days from consumption.
   b. Method cascade: try A → if ineligible, try B → C → D → E.
   c. Absence detection: run `detectAbsences()`.
   d. Validation: run `validateSeparation()`.
   e. Assemble `baseload_metadata`.
3. **Step H (always):** run `detectSupplementaryLoads(consumption, external, heating, baseloadMetadata.method)`.
4. **Return:** `{ heating, baseload_metadata, supplementary_loads }`.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Median computation slow on large datasets | Summer data is at most ~90 days × 48 HH = 4,320 values per slot. Sorting 90 values is trivial. No optimisation needed. |
| Floating-point drift breaking the invariant `heating + baseload = gas` | Both derived from the same `gas_kwh` value via subtraction. Clamping path is exact. Standard path has at most 1 ULP drift, within 0.001 kWh tolerance. |
| Method D balance-point detection fragile with sparse bins | Require ≥3 days per bin. Bins with fewer days skipped. No valid balance point → fall through to Method E. |
| R² computation on degenerate data (zero variance) | `computeOlsR2` returns null if x has zero variance or fewer than 2 points. Caller maps null to `"insufficient_data"`. |
| Accidentally using mean instead of median | Config and function names encode "median" explicitly. Step A2 has anti-pattern warning. |
| Step H normal-equation matrix singular | `computeMultiOls` detects singularity and returns null. Caller treats as `"skipped_insufficient_data"`. |
| Step H through-origin regression producing false positives | Design doc explicitly forbids through-origin. Intercept column always included in design matrix. Test 18 specifically validates this. |
| p-value approximation inaccuracy at low df | Step H guarantees ≥30 days (df ≥ 27). Normal approximation to t-distribution is accurate to ~1% at this df range, well within threshold granularity (0.01 vs 0.05). |
| Step H false AC detection from noise in winter-only data | `sum_cdd ≥ 20 K·day` guard prevents detection when insufficient cooling-season variation exists. `ac_detection_note` distinguishes "couldn't tell" from "no AC". |

---

## Success criteria

### Gas separation (Methods A–E, Steps F–G)
- [ ] `separateBaseload()` returns correctly shaped `{ heating, baseload_metadata, supplementary_loads }` matching the design doc output spec
- [ ] Invariant holds: for every non-null record, `heating_kwh + baseload_kwh === gas_kwh` within 0.001 kWh
- [ ] `heating_kwh >= 0` and `baseload_kwh >= 0` for every record (clamping works)
- [ ] No-gas case short-circuits gas separation cleanly: method = `"no-gas"`, all zeros, warning generated — but Step H still runs
- [ ] Method cascade: A → B → C → D → E falls through correctly based on data availability
- [ ] Method A uses median (not mean) and splits weekday/weekend
- [ ] Absence detection identifies runs of ≥3 consecutive low-gas days, ignores shorter runs
- [ ] Absence days excluded from R² regression
- [ ] R² maps to correct validation_status thresholds (0.7 / 0.5)
- [ ] Degree-day base temperature is 15.5°C (matches heat-loss module constant)
- [ ] All warnings per design doc generated in appropriate conditions

### Step H — supplementary electric load detection
- [ ] Step H runs regardless of gas-separation outcome (including no-gas case)
- [ ] OLS fit uses intercept (NOT through-origin) — `baseline_kwh_per_day` populated and realistic
- [ ] Electric heating detection triggers at coefficient > 0.2 AND p < 0.05
- [ ] AC detection triggers at coefficient > 0.2 AND p < 0.05 AND sum_cdd ≥ 20
- [ ] AC detection skipped with `ac_detection_note = "insufficient_cdd_data"` when sum_cdd < 20
- [ ] Confidence tiers correctly assigned: high (≥0.5, p<0.01), moderate (detected, not high), low (suggestive), none
- [ ] No-gas + electric heating detected → `electric_heating_is_primary = true`
- [ ] `supplementary_loads.limitations` always populated with 3 MVP limitation strings
- [ ] Insufficient data (<30 days) → `method = "skipped_insufficient_data"`, no crash
- [ ] No electricity data → `method = "skipped_no_electricity"`, no crash

### Module structure
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
