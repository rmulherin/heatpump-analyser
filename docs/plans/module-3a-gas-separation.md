# Module 3a — Baseload Separation: Gas Separation

**Date:** 2026-04-17
**Status:** ✅ Approved — implementation may begin. 4 clarification(s) apply (see review below).

---

## Task description

Implement the gas-separation portion of `js/baseload.js`: the 48-slot HH profile (Methods A–E),
absence detection (Step F), and validation against degree-days (Step G). Also creates
`js/constants.js` for cross-module shared constants.

This plan covers all gas-side computation. Step H (supplementary electric load detection
via OLS regression) is in `module-3a-step-h.md` and extends the same module once this plan
is implemented and verified. Phase 3b handles app.js integration and UI display.

---

## Research findings

**No external libraries required.** The module is pure arithmetic over arrays:
- Median computation: simple sort-and-pick for arrays of ≤90 values per HH slot.
- Single-variable OLS R² (Step G validation): ~15 lines of code.
- All timestamp arithmetic uses Luxon (available globally via CDN).

**Existing code reviewed:**
- `external-data.js` — established pattern: config constants at top, exported functions, no classes.
- `data-ingestion.js` — `normaliseConsumption()` establishes the `consumption[]` shape:
  `{ timestamp, gas_kwh, elec_kwh }`.
- `app.js` — Module 2 orchestration pattern (`runExternalData()`) shows how Module 3 will be
  wired in Phase 3b.

**Reuse from codebase:** None directly. The getter/setter pattern (`getExternalResult` /
`setExternalResult`) is replicated for `getBaseloadResult` / `setBaseloadResult`.

**Cross-module `HDD_BASE_TEMP`:** The design doc (Step G, Assumptions table) states the
base temperature used in Step G (15.5°C) must match the heat-loss module. Centralising in
`js/constants.js` prevents the silent-mismatch bug flagged in design Test 16. Module 4's
plan must import `HDD_BASE_TEMP` from `constants.js`, not redeclare it.

**Why split from Step H:** Step H (multi-variable OLS with exact p-values) is algorithmically
distinct from gas separation (robust medians, method cascade). Splitting keeps each plan within
the 80–150-line sizing envelope, allows Step H to be reviewed independently, and avoids
blocking gas separation on the t-CDF implementation decision. The orchestrator stub in this
plan is extended by the step-h plan once both are implemented.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/constants.js` | Shared cross-module constants (`HDD_BASE_TEMP`, `CDD_BASE_TEMP`) |
| CREATE | `js/baseload.js` | Gas separation — Methods A–E, Step F, Step G, orchestrator stub |

---

## Implementation steps

### Step 1 — `js/constants.js`: cross-module shared constants (Low complexity)

Create `js/constants.js` exporting:

```js
export const HDD_BASE_TEMP = 15.5; // CIBSE TM41 (°C). Shared with heat-loss module — import from here, never redeclare.
export const CDD_BASE_TEMP = 22;   // UK cooling convention (°C)
```

This file is intentionally minimal — it is not a general-purpose config dump. Only constants
that span module boundaries belong here.

### Step 2 — Module scaffold and shared state (Low complexity)

Create `js/baseload.js` with:

```js
import { HDD_BASE_TEMP, CDD_BASE_TEMP } from './constants.js';
```

Module-level config (local to baseload only — cross-module constants come from Step 1):

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
  HIGH_ABSENCE_WARNING_DAYS: 30,
  EXCESSIVE_ABSENCE_DAYS: 300,
  LITERATURE_BASELOAD_KWH_PER_DAY: 8,
  VALIDATION_MIN_HEATING_DAYS: 14,
  R2_GOOD_THRESHOLD: 0.7,
  R2_ACCEPTABLE_THRESHOLD: 0.5,
  BALANCE_POINT_FLATNESS_FRACTION: 0.20,
  BALANCE_POINT_MIN_DAYS_PER_BIN: 3,
};
```

Shared state: `let _baseloadResult = null`. Export `setBaseloadResult(r)` and `getBaseloadResult()`.

### Step 3 — Helper functions (Low complexity)

Implement utility functions:

- `median(arr)` — returns median of a numeric array. Filters nulls, then sorts and picks middle.
  Handles even-length (average of two middle values) and odd-length. Returns null on empty input.
- `hhOfDay(timestamp)` — returns 0–47 HH slot index from an ISO UTC timestamp using Luxon:
  `DateTime.fromISO(ts, { zone: 'UTC' }).hour * 2 + Math.floor(minute / 30)`.
- `isWeekday(timestamp)` — returns true for weekday (Mon–Fri, UTC) using Luxon `.weekday` (1–5).
- `groupByDay(records)` — returns a Map keyed by ISO date string `yyyy-mm-dd` (UTC), each value
  an array of that day's records. Use Luxon `toISODate()` on the UTC DateTime.
- `isWholeDay(dayRecords, field)` — returns true if the array has exactly 48 entries with
  non-null values for `field`.
- `computeOlsR2(xs, ys)` — single-variable OLS R² (coefficient of determination). Returns null
  if fewer than 2 points or zero variance in xs.

### Step 4 — Pre-flight: no-gas detection (Low complexity)

Export function `checkNoGas(consumption)`:
- Returns `true` if every record in `consumption` has `gas_kwh === null` or `gas_kwh === 0`.

### Step 5 — Method A: Summer HH-profile with weekday/weekend split (High complexity)

Export function `methodA(consumption)`:

**A1 — Identify the summer window:**
- Filter to records where the UTC month is in `SUMMER_MONTHS`.
- Group by day via `groupByDay`. Keep only whole days (`isWholeDay(records, 'gas_kwh')`).
- Count: `summer_days_used`, `weekday_days`, `weekend_days`.
- Eligibility: `summer_days_used >= METHOD_A_MIN_SUMMER_DAYS`
  AND `weekday_days >= METHOD_A_MIN_WEEKDAY_DAYS`
  AND `weekend_days >= METHOD_A_MIN_WEEKEND_DAYS`.
- `summer_window = { start: earliest qualifying day, end: latest qualifying day }`.

**A2 — Compute HH profiles (using median):**

For each HH slot `s` in 0..47, each day-type `d` in {weekday, weekend}:
```
weekdayProfile[s] = median(gas_kwh for all summer HH records where hhOfDay === s AND isWeekday)
weekendProfile[s] = median(gas_kwh for all summer HH records where hhOfDay === s AND !isWeekday)
```

**Anti-pattern: do not use `mean()` here.** The design doc is explicit — median is
non-negotiable for robustness to summer outliers (visitor periods, plumbing faults, holidays).
Test 2 specifically fails under mean.

**A3 — Apply profile to full dataset:**

For each consumption record where `gas_kwh` is non-null:
```
s             = hhOfDay(timestamp)
profile_value = isWeekday(timestamp) ? weekdayProfile[s] : weekendProfile[s]
baseload_kwh  = Math.min(profile_value, gas_kwh)   // clamping — mandatory
heating_kwh   = gas_kwh - baseload_kwh
```

Return `{ heatingSlots, method: 'summer-hh-profile-weekday-split', summer_window, summer_days_used }`.

### Step 6 — Methods B, C, D, E: Fallbacks (Medium complexity)

Same return shape as Method A: `{ heatingSlots, method, summer_window, summer_days_used }`.

**Method B** (`methodB(consumption)`):
- Single 48-slot profile, no weekday/weekend split.
- `profile[s] = median(gas_kwh for all summer HH records where hhOfDay === s)`.
- Eligibility: `summer_days_used >= METHOD_B_MIN_SUMMER_DAYS` (30).
- Clamping rule applies.
- `method = 'summer-hh-profile-flat'`.

**Method C** (`methodC(consumption)`):
- `baseload_per_day = median(daily_gas_totals across summer window)`.
- `baseload_per_hh = baseload_per_day / 48`.
- Apply flat estimate to all records (with clamping).
- Eligibility: `summer_days_used >= METHOD_C_MIN_SUMMER_DAYS` (14).
- `method = 'summer-daily-flat'`.
- Warning (canonical — push to warnings array): `"Limited summer data (${N} days). Baseload estimated as flat daily average — HH heating pattern may be less distinct."`

**Method D** (`methodD(consumption, external)`):
1. Aggregate to daily: `daily_gas_kwh` and `daily_mean_temp_c` (mean of `temp_c` over 48 HH records).
2. Bin by 1°C temperature bins. Require `BALANCE_POINT_MIN_DAYS_PER_BIN` (3) days per bin.
3. Compute median `daily_gas_kwh` per qualifying bin.
4. Find lowest-temperature bin where median ≤ warmest-bin-median × (1 + `BALANCE_POINT_FLATNESS_FRACTION`).
   This is the balance point.
5. Baseload = median `daily_gas_kwh` of days where `daily_mean_temp_c >= balance_point`, divided by 48.
6. If no balance point found: return null (caller falls through to Method E).
- Clamping rule applies.
- `method = 'balance-point'`.
- Warning (canonical): `"Insufficient summer data. Baseload estimated from warm-weather days (>${balancePoint}°C). Heatmap will not show non-heating pattern detail."`

**Method E** (`methodE()`):
- `baseload_per_hh = LITERATURE_BASELOAD_KWH_PER_DAY / 48` (≈ 0.167 kWh).
- Always succeeds.
- `method = 'literature-default'`. `validation_status = 'insufficient_data'`.
- Warning (canonical): `"Not enough data to estimate your household's non-heating gas use. Using UK average (8 kWh/day). Results should be treated as indicative only."`

**Clamping rule (all methods):** `baseload_kwh = Math.min(estimate, gas_kwh)`, `heating_kwh = gas_kwh - baseload_kwh`. Neither value ever negative. Do not store negative heating demand.

### Step 7 — Step F: Absence detection (Medium complexity)

Export function `detectAbsences(consumption, heatingSlots, baseloadMedianKwhPerDay)`:

1. Group `consumption` by day via `groupByDay`. Aggregate daily `gas_kwh` totals for whole days
   only (`isWholeDay(records, 'gas_kwh')`).
2. Threshold: `absence_threshold = ABSENCE_THRESHOLD_FRACTION × baseloadMedianKwhPerDay`.
3. Mark each whole day "low-gas" if `daily_gas_kwh < absence_threshold`.
4. Find runs of `>= ABSENCE_MIN_CONSECUTIVE_DAYS` (3) consecutive low-gas days.
   Each run → `{ start: string, end: string, days: number }` absence period.
5. For each HH record that falls within an absence period's date range, set `is_absence = true`.
   All other records: `is_absence = false`. (Null-gas records already have `is_absence: false`
   from the orchestrator's null-passthrough — absence detection does not touch null records.)
6. `absence_days_total = sum of days across all absence periods`.
7. If `absence_days_total > HIGH_ABSENCE_WARNING_DAYS` (30): push warning (canonical):
   `"Detected ${N} days when your boiler appears to have been off (likely holidays). These are excluded from the heat loss calculation for accuracy."`
8. If `absence_days_total > EXCESSIVE_ABSENCE_DAYS` (300): set `validation_status = 'insufficient_data'`,
   push warning (canonical): `"Most of your data shows very low gas use — results not meaningful."`

Return: updated `heatingSlots` (with `is_absence` set), `absence_periods`, `absence_days_total`.

### Step 8 — Step G: Validation (Medium complexity)

Export function `validateSeparation(heatingSlots, external)`:

1. Group by day. For each whole day: compute `daily_heating_kwh` and `daily_mean_temp_c`
   (from `external`). Exclude days where any HH has `is_absence === true`.
2. `daily_degree_days = Math.max(0, HDD_BASE_TEMP - daily_mean_temp_c)` (uses imported constant).
3. Filter to days with `daily_degree_days > 0`.
4. If fewer than `VALIDATION_MIN_HEATING_DAYS` (14) qualifying days: return
   `{ r2: null, validation_status: 'insufficient_data' }`.
5. `r2 = computeOlsR2(degree_days_array, heating_kwh_array)`.
6. Map R²:
   - `>= R2_GOOD_THRESHOLD` (0.7) → `'good'`
   - `>= R2_ACCEPTABLE_THRESHOLD` (0.5) → `'acceptable'`
   - otherwise → `'poor'`
7. If `'poor'`: push warning (canonical):
   `"Your heating demand doesn't correlate strongly with outdoor temperature (R² = ${r2.toFixed(2)}). This can happen if you use a wood burner, have variable occupancy, or have very good solar gains. Results may be less accurate."`

Return: `{ r2, validation_status }`.

### Step 9 — Main orchestrator — gas-separation portion (Medium complexity)

Export function `separateBaseload(consumption, external)`:

This is the public API, called from app.js in Phase 3b. After this plan's implementation it
returns `{ heating, baseload_metadata }`. The step-h plan extends it to add `supplementary_loads`
and return the complete output.

**Warnings initialisation:** Begin with `const warnings = []`. All methods and steps above push
to this array using exact canonical strings. Pass `warnings` down to each sub-step.

**Null-gas passthrough:** Before invoking any method, build the output `heating[]` array:
```js
const heating = consumption.map(rec => ({
  timestamp: rec.timestamp,
  heating_kwh: rec.gas_kwh === null ? null : 0,  // filled in by method below
  baseload_kwh: rec.gas_kwh === null ? null : 0,
  is_absence: false,
}));
```
Methods A–E then overwrite the non-null slots. This ensures null records unconditionally
satisfy `{ heating_kwh: null, baseload_kwh: null, is_absence: false }` without special-casing
inside each method.

**Invariant:** For every record where `consumption[i].gas_kwh !== null`:
`heating[i].heating_kwh + heating[i].baseload_kwh === consumption[i].gas_kwh` within 0.001 kWh.

**Flow:**

1. Initialise `warnings = []`.
2. Build null-passthrough `heating[]` as above.

3. **No-gas case:** if `checkNoGas(consumption)`:
   - All non-null records already have `heating_kwh: 0, baseload_kwh: 0` from the passthrough.
   - Push warning (canonical): `"No gas consumption detected. This household appears to be all-electric. The heat pump comparison will be against existing electric heating rather than gas."`
   - Assemble `baseload_metadata`:
     ```
     { method: 'no-gas', summer_window: null, summer_days_used: 0,
       baseload_mean_kwh_per_day: 0, baseload_median_kwh_per_day: 0,
       absence_periods: [], absence_days_total: 0,
       heating_vs_degree_days_r2: null, validation_status: 'no_gas', warnings }
     ```
   - **Do not return yet.** Step H (added by step-h plan) runs unconditionally.

4. **Normal gas-separation case:**
   a. Method cascade: try `methodA` → `methodB` → `methodC` → `methodD` → `methodE`.
      Use the first eligible result. Copy heating/baseload slots into the `heating[]` array.
   b. Run `detectAbsences(consumption, heating, baseloadMedianKwhPerDay)`. (Compute
      `baseloadMedianKwhPerDay` from the method result before calling — see 4c below.)
   c. **Compute `baseload_mean_kwh_per_day` and `baseload_median_kwh_per_day`:**
      - Collect daily baseload totals: for each whole day in the **full dataset**
        (all days, not just the summer window) where `isWholeDay(records, 'gas_kwh')`,
        sum `baseload_kwh` over the 48 HH records for that day.
      - `baseload_mean_kwh_per_day = mean(daily_totals)`.
      - `baseload_median_kwh_per_day = median(daily_totals)`.
      - This is the value passed to `detectAbsences` as the absence threshold base.
      - Note: compute this from the baseload values written into `heating[]` by the method,
        not from the summer-window estimate. The full-year median is the appropriate sanity
        check for the user and is the correct threshold for Step F.
   d. Run `validateSeparation(heating, external)`. Merge `validation_status` (and any Method E
      override) into a single value — Method E sets `insufficient_data` directly; Step G may
      also set it; use the worse of the two.
   e. Assemble `baseload_metadata` from method result, absence result, validation result,
      computed mean/median, warnings.

5. **Return (stub):** `return { heating, baseload_metadata };`
   The step-h plan replaces this with `return { heating, baseload_metadata, supplementary_loads };`.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Median computation slow on large datasets | Summer data is at most ~90 days × 48 HH = 4,320 values per slot. Sort-and-pick on 90 values is trivial. |
| Floating-point drift breaking `heating + baseload = gas` | Both derived from same `gas_kwh` via subtraction. Clamping path is exact. Standard path has at most 1 ULP drift. Invariant restated in success criteria. |
| Method D balance-point detection fragile with sparse bins | Require ≥3 days per bin. Bins with fewer days are skipped. No valid balance point → fall through to Method E. |
| R² computation on degenerate data (zero variance) | `computeOlsR2` returns null on zero variance or <2 points. Caller maps null to `'insufficient_data'`. |
| Accidentally using mean instead of median | Function names encode "median" explicitly. Anti-pattern note in Step 5 A2. Test 2 specifically catches this. |
| HDD_BASE_TEMP mismatch with heat-loss module | Exported from `js/constants.js`. Module 4 must import from there. Test 16 verifiable via grep. |
| Null-gas records receiving non-null outputs | Explicit null-passthrough loop in orchestrator runs before any method. Null records are never touched by methods. |
| `baseload_mean/median` computed over wrong window | Step 9c specifies full-dataset whole days, not summer window. Absence threshold base uses same value. |
| Warnings missing or mis-phrased | Canonical strings enumerated in Steps 6–8. No ad-hoc phrasing. |

---

## Warnings registry

All warnings use these exact strings (substituting `${N}` or `${value}` as shown):

| Condition | String |
|-----------|--------|
| No gas detected | `"No gas consumption detected. This household appears to be all-electric. The heat pump comparison will be against existing electric heating rather than gas."` |
| Method C — limited summer | `"Limited summer data (${N} days). Baseload estimated as flat daily average — HH heating pattern may be less distinct."` |
| Method D — balance-point | `"Insufficient summer data. Baseload estimated from warm-weather days (>${balancePoint}°C). Heatmap will not show non-heating pattern detail."` |
| Method E — literature default | `"Not enough data to estimate your household's non-heating gas use. Using UK average (8 kWh/day). Results should be treated as indicative only."` |
| Absence > 30 days | `"Detected ${N} days when your boiler appears to have been off (likely holidays). These are excluded from the heat loss calculation for accuracy."` |
| Absence > 300 days | `"Most of your data shows very low gas use — results not meaningful."` |
| Poor R² | `"Your heating demand doesn't correlate strongly with outdoor temperature (R² = ${r2.toFixed(2)}). This can happen if you use a wood burner, have variable occupancy, or have very good solar gains. Results may be less accurate."` |

---

## Success criteria

### Gas separation (Methods A–E, Steps F–G)
- [ ] `separateBaseload()` returns `{ heating, baseload_metadata }` matching the design doc output spec
- [ ] **Invariant:** for every non-null record, `heating_kwh + baseload_kwh === gas_kwh` within 0.001 kWh (Tests 5, 6)
- [ ] `heating_kwh >= 0` and `baseload_kwh >= 0` for every record — clamping works (Test 5)
- [ ] Null records → `{ heating_kwh: null, baseload_kwh: null, is_absence: false }` unconditionally
- [ ] No-gas case short-circuits gas separation: method = `'no-gas'`, all zeros, warning generated (Test 7)
- [ ] Method cascade A → B → C → D → E falls through correctly (Tests 8, 9)
- [ ] Method A uses median, not mean — robust to outliers (Tests 1, 2)
- [ ] Method A splits weekday/weekend correctly (Test 4)
- [ ] Method A preserves intra-day HH shape (Test 3)
- [ ] Absence detection identifies runs of ≥3 consecutive low-gas days (Test 11)
- [ ] Runs shorter than 3 days not flagged (Tests 13, 14, 15)
- [ ] Summer absence does not skew baseload median (Test 12)
- [ ] Absence days excluded from R² regression (Test 11)
- [ ] R² maps to correct thresholds: good ≥0.7, acceptable ≥0.5, poor <0.5 (Test 10)
- [ ] Degree-day base uses `HDD_BASE_TEMP` imported from `constants.js` — no local literal (Test 16)
- [ ] `baseload_mean/median_kwh_per_day` computed from full-dataset whole days, not summer window only
- [ ] All 7 canonical warnings generated in appropriate conditions, using exact strings from Warnings registry

### Module structure
- [ ] `js/constants.js` exports `HDD_BASE_TEMP = 15.5` and `CDD_BASE_TEMP = 22`
- [ ] `js/baseload.js` imports from `./constants.js` — no local redeclarations of either constant
- [ ] Module exports `getBaseloadResult()` / `setBaseloadResult()` following established pattern
- [ ] No UI code, no DOM references, no side effects beyond the shared state setter

### Design doc test mapping

| Test | Covers |
|------|--------|
| 1 | Happy path — Method A, R² > 0.9, no absences |
| 2 | Median robustness — outlier rejection (mean anti-pattern) |
| 3 | HH profile fidelity — distinct intra-day heating shape |
| 4 | Weekday/weekend differentiation — A2 split |
| 5 | Clamping — no negative heating_kwh |
| 6 | Invariant — heating + baseload = gas within 0.001 |
| 7 | No-gas household — short-circuit, warning, Step H still runs |
| 8 | Sparse summer → Method C (`summer-daily-flat`) |
| 9 | No summer → Method D (`balance-point`) |
| 10 | Degraded signal → poor R² and warning |
| 11 | Winter absence detection — Step F + R² exclusion |
| 12 | Summer absence does not skew baseload |
| 13 | 2-day trip not flagged (below 3-day threshold) |
| 14 | Setback mode not flagged (above 20% threshold) |
| 15 | Single anomalous day not flagged |
| 16 | Degree-day base consistency — grep confirms single source |

Tests 17–22 (Step H) are in `module-3a-step-h.md`.

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-17
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `design/baseload-separation.md`

*(Original review was on `module-3a-baseload-core.md`. This plan is the revised and split
successor. The Opus review findings are carried forward; resolutions are in the section below.)*

### Resolution of review changes

**H1 (p-value approximation too aggressive):** Resolved by split. The OLS and t-CDF implementation
are entirely in `module-3a-step-h.md`, which adopts the proper incomplete-beta / Lentz continued
fraction approach (Numerical Recipes §6.4). No normal approximation used anywhere.

**H2 (cross-module HDD_BASE_TEMP sharing):** Accepted — option (a). `js/constants.js` created
in Step 1, exporting `HDD_BASE_TEMP` and `CDD_BASE_TEMP`. `js/baseload.js` imports both.
Module 4's plan must import `HDD_BASE_TEMP` from `./constants.js`, not redeclare it.
Test 16 verifiable by grep.

**H3 (plan sizing — split):** Accepted. This plan covers gas separation only. Step H is
`module-3a-step-h.md`. Module 3b depends on both.

**M4 (null-gas record passthrough):** Resolved in Step 9 orchestrator. Null-passthrough loop
builds the full `heating[]` array before any method runs. Invariant explicitly restated in
success criteria.

**M5 (warnings accumulation flow):** Resolved. `warnings = []` initialised at orchestrator start.
All methods and steps receive `warnings` and push using exact canonical strings. Strings enumerated
in the Warnings registry section.

**M6 (baseline_kwh_per_day field mapping):** Resolved in `module-3a-step-h.md`, which contains
a complete output field-mapping table for Step H.

**M7 (baseload_mean/median derivation):** Resolved in Step 9c. Full-dataset whole-day computation
specified explicitly. Note that Step F uses the same median as its absence threshold base.

**M8 (design doc test coverage):** Resolved. Design doc test mapping table added to success
criteria, Tests 1–16 mapped here, Tests 17–22 in step-h plan.

**LOW findings (informational, actioned or noted):**
- L9 (Method D phrasing): confirmed one-sided (≤ 1.2×) — functionally matches design doc.
- L11 (public surface): Individual method functions are exported for testability; only
  `separateBaseload` + getter/setter are consumed by app.js. Acceptable.
- L12 (`summer_window.start/end`): specified in Step 5 A1 as earliest/latest qualifying day.
- L13 (Step H daily_mean_temp_c): resolved in step-h plan ("mean of 48 HH temp_c values").

---

### Re-review (2026-04-17, Opus — revised plan post-split)

The revised plan addresses all original findings cleanly. New observations below.

**MEDIUM** — M1 applies to the step-h plan, not this one. See `module-3a-step-h.md` Design Review.

**LOW clarifications to apply during implementation**

- **L14. Step 9 orchestrator ordering.** The list shows 4b (`detectAbsences`) before 4c (compute `baseload_mean/median`), but 4b consumes `baseloadMedianKwhPerDay` produced by 4c. Parenthetical "see 4c below" clarifies intent but the list order is reversed. Swap 4b and 4c during implementation.
- **L15. `CDD_BASE_TEMP` import in Step 2.** Imports both `HDD_BASE_TEMP` and `CDD_BASE_TEMP` from `constants.js`, but `CDD_BASE_TEMP` is only used by the step-h plan. Either move the `CDD_BASE_TEMP` import into the step-h plan's modification, or leave and add a comment explaining it's imported pre-emptively to avoid a second import edit. Implementer's choice.
- **L16. Step 8 "for each whole day".** Design requires Step G's daily aggregation to use whole-gas-days only (matching Step F's definition). Tighten the wording during implementation to "whole-gas day".

**Design-level amendment — absence warning string**

Rhiannon flagged during re-review that the Step F absence rule catches the "boiler fully off" pattern cleanly but misses the more common "de-icing setpoint" case. Magnitude analysis: missed de-icing absences produce ~5% systematic downward bias on HTC, within the Siviour method's inherent ±15–20% accuracy envelope — not worth adding a second detection rule in MVP. Instead, the user-facing warning is updated to acknowledge what is NOT caught. `design/baseload-separation.md` Step F warning string updated accordingly.

- **L17. Update Warnings Registry "Absence > 30 days" entry** in this plan to match the revised canonical string in `design/baseload-separation.md` at implementation time.

### Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0 | ✓ pass |
| HIGH | 0 | — |
| MEDIUM | 0 | — (M1 is on the step-h plan) |
| LOW | 4 | ℹ apply during implementation |

Verdict: APPROVE WITH CLARIFICATIONS — implementable once L14–L17 are applied.

---

## Approval

**Status:** ✅ Approved — implementation may begin. 4 clarification(s) apply (see review below).
**Date:** 2026-04-17
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:**
- L14 — Step 9 4b/4c ordering swapped at implementation
- L15 — CDD_BASE_TEMP import location is implementer's choice
- L16 — Step 8 "whole day" interpreted as whole-gas-day
- L17 — Warnings Registry "Absence > 30 days" string updated to match revised `design/baseload-separation.md` at implementation time

---

## Implementation Deviations

[To be completed during implementation]
