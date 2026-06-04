# M5 Thermal Character — v2 implementation

**Date:** 2026-06-04 (re-cut 2026-06-04)
**Status:** Awaiting review — re-cut for Opus re-review per 2026-06-04 blocking findings.

> **Supersedes the 2026-06-02 draft** in this file, which was a partial alignment plan for
> an older v2 design. The authoritative design is now `m5-thermal-character-v2.md`
> (praxis-claude-hub, 2026-06-04), self-contained and agreed with Rhiannon.
>
> **Re-cut vs the 2026-06-04 first draft** (commit 40ad6f7): Method B is redesigned to the
> absence-recovery duration-asymptote (design §2.5.3); EV-cap window fixed to use timestamp
> hour-of-day; `thermal_mass_fit_status` added to contract; UI input deferral for setpoint
> and household-size; TC2/TC4 rebuilt as first-principles forward RC simulations; TC4b added
> (uniform-duration rejection test).

---

## Task description

Re-implement `js/thermal-character.js` (Module 5) from v1 to v2 per `m5-thermal-character-v2.md`
(praxis-claude-hub, 2026-06-04). This is a redesign, not a transcription. Path A (the two-estimator
τ-fit) and the gains assembly (Step 1b) are new code. Only the tau-bucket dropdown mapping, the
time-constant derivation, the rating bands, and the heating-frequency readout are reproduced from v1.
Create `test-m5-v2.mjs` covering all 14 §5 test criteria (including TC4b). Update
`js/scenario-consumption.js` to remove the `setpoint_c` dependency and consume `internal_gains_w`
from m5. Update `js/app.js` call site and display (gated on m4-v2 being implemented first).

---

## Research findings

### `js/thermal-character.js` — v1 (701 lines, fully read)

Reproduced from v1 (defer to working code; flag in plan if live code diverges from design wording):

| v1 symbol | Location | v2 status |
|---|---|---|
| `TAU_BUCKET_HOURS_MAP` | `:51` | **Reproduced unchanged** — `{fast:4, evening:10, all_day:20, stays_for_days:40}` |
| `computeRatingAndTimeConstant` | `:446` | **Reproduced** — rating bands 6k/15k/30k kJ/K; `C/(htc×3.6)`; source changes to `htc_used` |
| `computeOccupancyWeights` | `:211` | **Reproduced as `computeHeatingFrequencyByHh`** — same per-HH fraction mechanic, renamed; source-blind: checks `thermal_heat_delivered_kwh > 0` not `heating_kwh > 0` |

Deleted from v1 (do not carry forward):

| v1 symbol | Reason |
|---|---|
| `estimateSetpoint` `:237` | Retired — FINDING §7.1 |
| `estimateThermalMass` `:292` | Replaced by Path A two-estimator redesign |
| `buildDaySummaries` `:165` | Replaced (logic changes with source-blind signal) |
| `checkWallConstruction`, `WALL_CONSTRUCTION_RANGES` `:45,497` | Dropped — §2.5.7, approved |
| `computeModelledHeatingByHh`, `computeUnderheatStatus`, `buildUnderheatNarrative` `:92,110,140` | Relocated to m7's trace — §2.8, approved |
| `computeValidationStatus` `:512` | Replaced — new CI-banded version |
| `no_gas` early return `:545` | Deleted — source-blind; the no_gas branch is gone |
| `checkTauBucketSanity` `:472` | Dropped — the tau-bucket pair surfaces data vs user as informational comparison already |
| `TC_CONFIG.*` fields for setpoint, cold-soak, long-event, underheat | All deleted with their dependants |

The `_path_diagnostics` block (added by investigation-instrumentation) is subsumed into the new
`thermal_mass_fit` and `data_derived_tau_h` output fields — no direct carry-over needed.

**Flag — divergence confirmed (mandate, not conflict):** `computeOccupancyWeights` uses `heating_kwh > 0`
(gas-only). v2 changes this to `thermal_heat_delivered_kwh > 0` (source-blind). This is an explicit
§7 mandate, not a conflict with the "defer to working code" guardrail.

### m4-v2 plan — confirmed m5 input contract

m4-v2 plan (`docs/plans/m4-heat-loss-v2.md`, Status `⚠ Approved with edits — 2026-06-04`) confirmed:
- `estimateHeatLoss` mints `thermal_heat_delivered_kwh[]` — a standalone per-HH array in the return
  object (`gas_kwh × η + elec_kwh × 1.0`, null only where BOTH fuels are null).
- Output field `htc_used` is added (first-pass = `htc_w_per_k`; the rescale mechanism is dormant).
- `solar_aperture_m2` → **renamed** to `solar_aperture` in m4-v2 output.
- `boiler_efficiency_used` (η) remains in the m4 output but is **NOT an m5 input** — m5 never
  re-applies η; the thermal series already carries it.
- **Prerequisite gate:** m4-v2 must be `Status: Implemented` before the app.js integration step
  (Step 15). Steps 1–13 can proceed immediately using synthetic test data with the m4-v2 contract.

### m3-v2 outputs — gains ingredients

From `baseload.js` (fully read):
- `supplementary_loads.electricity_baseload` — `computeElectricityBaseload` returns the **5th
  percentile of per-HH non-absence electricity consumption** in **kWh/HH** (a scalar). Null if
  fewer than 30 days of complete electricity data.
- `heating[i].nonheat_residual_kwh` — per-HH, kWh/HH. Set by `applyElectricHeatingAttribution`;
  null if electricity data missing for that day.
- `baseload_metadata.baseload_median_kwh_per_day` — daily gas baseload kWh/day. For no-gas homes
  this is 0 (not null). Used to derive `gas_baseload_w = (median_kwh_per_day / 48) × 2000` W.
  **There is no named `gas_baseload` field in m3's current output** — m5 derives it from this field.

### `js/scenario-consumption.js` — thermalChar reads (fully read)

m7 currently reads from `thermalChar`:
- `thermalChar?.setpoint_c` — **4 locations**: `simulatePostHocTIndoor` (null-guard + T_init),
  `simulateCurrentRcTrace` (`sp`), overshoot check. All replaced by the `operativeSetpoint` param
  added in Step 14.
- `thermalChar?.thermal_mass_kj_per_k` — unchanged name; still provided by m5-v2.
- `thermalChar?.underheat_ratio` (~line 334) — used in `demandScale` for the "Heat to Comfort"
  slider. **Removed from m5-v2** (relocated to m7's trace). Will be null after this plan, making
  `demandScale = 1.0` always. Known interim regression; flagged for m7-v2.
- Solar gains: `scenario-consumption.js` reads `heatLoss.solar_aperture` (**confirmed** — lines
  183 and 213 both use `solar_aperture`, not `solar_aperture_m2`). **Step 14b's rename is a
  no-op** — already correct. `heat-loss.js` (shipping) also outputs `solar_aperture` (not `_m2`).
  No pre-existing `solar_aperture_m2` bug.

### `js/app.js` — UI inputs (confirmed read)

App.js confirms (lines 188–189):
- `wallConstructionInput` — `document.getElementById('wall-construction')` ✓ (exists)
- `tAtRestartInput` — `document.getElementById('t-at-restart')` ✓ (exists)
- **`setpointInput`** — **does NOT exist** in app.js. No such variable or element reference.
- **`householdSizeInput`** — **does NOT exist** in app.js.

Step 15 must NOT reference `setpointInput?.value` or `householdSizeInput?.value` — they would be
`undefined` variables (ReferenceError) or undefined DOM nodes returning empty string. Phase-4 UI
scope; defer. Pass hard-coded defaults (`20` and `2`) at the call site; document the deferral.

### OLS patterns in the codebase

`baseload.js:computeMultiOls` — full OLS with standard errors (not exported). `heat-loss.js:runOLSTwoPredictor`
— through-origin 2-predictor OLS. Neither fits Method A (which needs OLS with intercept). A private
`ols2WithIntercept(xs, ys)` helper is written in `thermal-character.js` — closed-form for
[intercept, slope].

**JS learnings note:** "Origin-forced regression R² collapses for signals with constant baseline
offset" (learnings.md, 2026-06-02) — confirms Method A's with-intercept fit is correct; the intercept
absorbs the gains/setpoint offset as designed.

### Algorithm choices

- **Method A τ-fit**: 1D profile-LS — minimize `Var(z_i(τ))` over a log-spaced grid, then
  golden-section refinement. SE(τ) from numerical Hessian of RSS at τ_hat. No external library.
- **Method B asymptote fit**: profile-LS on A (the asymptote = C_true) — golden-section on A,
  inner OLS on linearized B = 1/τ. Bootstrap (resample absence events) for SE on A. Duration-spread
  gate before fitting. No external library.
- **Mode estimator**: half-sample-mode (HSM) — `O(n log n)`, no external deps, robust for small
  samples. Used by `computeMaxLoad` (heat_system_capacity_kw) only (no longer for C estimation).
- **No new imports** — vanilla JS throughout, consistent with project standards.

---

## Open constants — decisions for Opus review

The following constants appear in `TC_CONFIG` (Step 1). Values are proposals; Opus should confirm
or redirect before implementation begins.

| Constant | Proposed | Used by | Flag |
|---|---|---|---|
| `F_GAS` | `0.35` | Step 1b — gas_baseload term | Fraction of gas HW+cooking that becomes indoor heat. 35% ≈ UK norm. **Flag for Opus calibration.** |
| `METHOD_A_MIN_EVENTS` | `20` | Method A fire gate | Min morning-reheat events for regression to be meaningful. **Flag.** |
| `METHOD_A_PREDAWN_START_H` | `3` | Step 2a event collection | Start of pre-dawn window (03:00). **Flag.** |
| `METHOD_A_PREDAWN_END_H` | `7` | Step 2a event collection | End of pre-dawn window exclusive (07:00). **Flag.** |
| `METHOD_B_DURATION_SPREAD_H` | `12` | Step 2b spread gate | Min range of t_soak values (hours) needed to pin the asymptote curve. Uniform durations → under-determined. **Flag for Opus calibration.** |
| `PCTILE_UPPER_TAIL` | `0.95` | Step 2b max_load | 95th percentile for upper tail. Confirmed §3. |
| `CEILING_FACTOR` | `0.9` | Step 2b max_load | 0.9 × max_load. Confirmed §3. |
| `MIN_EVENTS_METHOD_B` | `4` | Step 2b fire gate | Min absence-recovery events (≥ ~4 per design §3). Confirmed. |
| `FIRE_THRESHOLD_SE` | `0.25` | Confidence selection | ±25% relative SE on τ to fire. Confirmed §3. |
| `GOOD_SE_THRESHOLD` | `0.12` | Validation status | ~12% → 'good'. Confirmed §2.5.8. |
| `EV_CAP_K` | `2` | Step 1b EV clip | k = 2 × electricity_baseload. Confirmed §2.5.2b. |
| `BOOTSTRAP_ITER` | `1000` | Method B CI | 1000 resamples — standard. Confirmed. |
| `WINTER_MAX_T_C` | `10` | Method A event filter | T_out < 10°C for winter. Same as v1. |

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY (full rewrite) | `js/thermal-character.js` | Complete v2 redesign — Path A, gains assembly, new contract |
| CREATE | `test-m5-v2.mjs` | 14 test cases covering all §5 criteria; synthetic data |
| MODIFY | `js/scenario-consumption.js` | Add `operativeSetpoint` param; remove `setpoint_c` reads; wire `internal_gains_w` |
| MODIFY | `js/app.js` | New m5 call site; display changes; **gated on m4-v2 Implemented** |

---

## Implementation steps

**Prerequisite gate for Steps 14–15:** m4-v2 plan must show `Status: Implemented`. Steps 1–13 use
synthetic test data with m4-v2 contract fields (`thermal_heat_delivered_kwh`, `htc_used`,
`solar_aperture`) and can proceed at any time.

---

### Step 1 — Constants, config, and module skeleton (`js/thermal-character.js`)

Delete the entire v1 file. Start from scratch.

```javascript
// ===== Thermal Character Module (Module 5) — v2 =====
// Owns: internal_gains_w (Q_gains → m7); thermal_mass_kj_per_k (C); time_constant_hours (τ).
// Does NOT: infer setpoint; re-apply η; gate on no-gas; auto-fill thermal mass.

let _thermalCharacterResult = null;
export function setThermalCharacterResult(r) { _thermalCharacterResult = r; }
export function getThermalCharacterResult()   { return _thermalCharacterResult; }

const TC_CONFIG = {
  // Gains assembly (§2.5.2b)
  EV_CAP_K:                    2,       // EV overnight cap multiplier on electricity_baseload
  F_GAS:                       0.35,    // Fraction of gas baseload → indoor heat  [OPUS DECISION]
  OCCUPANCY_W_PER_PERSON:      70,      // Body-heat per occupant (W)
  EV_WINDOW_START_H:           1,       // 01:00 — start of EV overnight cap window (hour-of-day)
  EV_WINDOW_END_H:             5,       // 05:00 — end of EV cap window (exclusive)

  // Method A (§2.5.3)
  METHOD_A_PREDAWN_START_H:    3,       // Pre-dawn window start hour  [OPUS DECISION]
  METHOD_A_PREDAWN_END_H:      7,       // Pre-dawn window end hour (exclusive)  [OPUS DECISION]
  METHOD_A_MIN_OFF_HH:         4,       // Min overnight off HH before a morning event
  METHOD_A_MIN_REHEAT_HH:      2,       // Min reheat HH to count as an event
  METHOD_A_MAX_REHEAT_HH:      16,      // Max reheat HH included (cap at 8 h)
  METHOD_A_MIN_EVENTS:         20,      // Min morning events to fire  [OPUS DECISION]
  METHOD_A_HEAT_THRESH_KWH:    0.05,    // Below this = "off" in the thermal series

  // Method B (§2.5.3)
  METHOD_B_MIN_SOAK_HH:        4,       // Min absence soak duration (HH) to form an event
  METHOD_B_LATE_SOAK_HH:       8,       // HH from gap end used to estimate T_eq
  METHOD_B_MIN_RECOVERY_HH:    3,       // Min sustained heat-delivery HH after gap (§3)
  METHOD_B_DURATION_SPREAD_H:  12,      // Min range of t_soak (hours) to fit asymptote  [OPUS DECISION]
  MIN_EVENTS_METHOD_B:         4,       // Min absence-recovery events to fire (≥ ~4, §3)

  // Shared (Method B heat_system_capacity_kw)
  PCTILE_UPPER_TAIL:           95,      // 95th percentile for upper tail (as %)
  CEILING_FACTOR:              0.9,     // At/near ceiling threshold (for max_load)

  // Confidence selection + validation (§2.5.3 / §2.5.8)
  FIRE_THRESHOLD_SE:           0.25,    // Relative SE on τ to fire (±25%)
  GOOD_SE_THRESHOLD:           0.12,    // Relative SE → 'good' status (~12%)
  BOOTSTRAP_ITER:              1000,    // Bootstrap resamples for Method B CI

  // Heating-frequency readout (v1 mechanic — §2.5.2)
  MIN_DAYS_HEATING_FREQ:       14,      // Min non-absence whole days

  // Rating bands (v1 — §2.5.7)
  MASS_RATING_MEDIUM_KJ:       6000,
  MASS_RATING_HIGH_KJ:         15000,
  MASS_RATING_VERY_HIGH_KJ:    30000,

  // Event filters
  WINTER_MAX_T_C:              10,      // Overnight T_out filter for Method A
};

const TAU_BUCKET_HOURS_MAP = {
  fast:            4,
  evening:        10,
  all_day:        20,
  stays_for_days: 40,
};
```

---

### Step 2 — Private helpers (`js/thermal-character.js`)

Add five private helpers immediately after constants.

**`percentile(arr, p)`** — p is 0–100; input unsorted, nulls filtered:
```javascript
function percentile(arr, p) {
  const vals = arr.filter(v => v !== null && v !== undefined && !isNaN(v)).sort((a, b) => a - b);
  if (!vals.length) return null;
  const idx = (p / 100) * (vals.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? vals[lo] : vals[lo] + (idx - lo) * (vals[hi] - vals[lo]);
}
```

**`halfSampleMode(arr)`** — half-sample-mode (HSM) estimator; O(n log n); robust for small samples:
```javascript
function halfSampleMode(arr) {
  const sorted = arr.filter(v => v !== null && !isNaN(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length <= 2) return (sorted[0] + sorted[sorted.length - 1]) / 2;
  let cur = sorted;
  while (cur.length > 2) {
    const half = Math.ceil(cur.length / 2);
    let best = Infinity, bestIdx = 0;
    for (let i = 0; i <= cur.length - half; i++) {
      const span = cur[i + half - 1] - cur[i];
      if (span < best) { best = span; bestIdx = i; }
    }
    cur = cur.slice(bestIdx, bestIdx + half);
  }
  return (cur[0] + cur[cur.length - 1]) / 2;
}
```

**`ols2WithIntercept(xs, ys)`** — closed-form OLS with intercept for (xs, ys) arrays; returns
`{intercept, slope, ss_res, r2}` or null if degenerate:
```javascript
function ols2WithIntercept(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; sxx += dx * dx; sxy += dx * (ys[i] - my); }
  if (Math.abs(sxx) < 1e-12) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ss_res = 0, ss_tot = 0;
  for (let i = 0; i < n; i++) {
    ss_res += (ys[i] - (intercept + slope * xs[i])) ** 2;
    ss_tot += (ys[i] - my) ** 2;
  }
  return { intercept, slope, ss_res, r2: ss_tot > 0 ? 1 - ss_res / ss_tot : 0 };
}
```

**`goldenSectionMin(f, lo, hi, tol)`** — 1D golden-section minimisation on [lo, hi]:
```javascript
function goldenSectionMin(f, lo, hi, tol = 1e-4) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi;
  let c = b - phi * (b - a), d = a + phi * (b - a);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < 100 && (b - a) > tol; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = f(c); }
    else         { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}
```

**`sampleWithReplacement(arr)`** — bootstrap resample:
```javascript
function sampleWithReplacement(arr) {
  return arr.map(() => arr[Math.floor(Math.random() * arr.length)]);
}
```

---

### Step 3 — Step 0: null passthrough (`js/thermal-character.js`)

Define the null-result helper and the null-passthrough gate. Delete the `no_gas` branch — m5 is
source-blind and does not gate on baseload method.

```javascript
function nullResult(validation_status) {
  return {
    internal_gains_w:         null,
    thermal_mass_kj_per_k:    null,
    time_constant_hours:      null,
    thermal_mass_rating:      null,
    heating_frequency_by_hh:  null,
    tau_bucket:               null,
    tau_bucket_used:          null,
    thermal_mass_source:      null,
    thermal_mass_method:      null,
    thermal_mass_fit_status:  'no_data',
    data_derived_tau_h:       null,
    thermal_mass_fit:         null,
    heat_system_capacity_kw:  null,
    validation_status,
    warnings: [],
  };
}
```

At the top of `estimateThermalCharacter` (Step 12): bind to `htc_used`, return null on null.
```javascript
const htcUsed = heatLoss?.htc_used ?? null;
if (htcUsed === null) return nullResult('no_htc');
```

---

### Step 4 — Step 1: `computeHeatingFrequencyByHh` (`js/thermal-character.js`)

Rename of `computeOccupancyWeights`. Source-blind: uses `thermalDelivered[i] > 0`, not
`heating[i].heating_kwh > 0`. Same 14-day minimum and per-HH fraction mechanic.

```javascript
function computeHeatingFrequencyByHh(heating, thermalDelivered) {
  const dayMap = new Map();
  for (let i = 0; i < heating.length; i++) {
    const day = heating[i].timestamp.slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day).push(i);
  }

  const nonAbsenceDayIndices = [];
  for (const [, indices] of dayMap) {
    if (indices.length !== 48) continue;
    if (indices.some(i => heating[i].is_absence)) continue;
    nonAbsenceDayIndices.push(indices);
  }

  if (nonAbsenceDayIndices.length < TC_CONFIG.MIN_DAYS_HEATING_FREQ) {
    return { heating_frequency_by_hh: null, warning: 'Not enough data to compute heating frequency.' };
  }

  const total = nonAbsenceDayIndices.length;
  const countHeated = new Array(48).fill(0);
  for (const indices of nonAbsenceDayIndices) {
    for (let h = 0; h < 48; h++) {
      const i = indices[h];
      if (thermalDelivered[i] !== null && thermalDelivered[i] > 0) countHeated[h]++;
    }
  }
  return {
    heating_frequency_by_hh: countHeated.map(c => c / total),
    warning: null,
  };
}
```

---

### Step 5 — Step 1b: `assembleGains` (`js/thermal-character.js`)

New function. Returns `internal_gains_w[]` in watts per HH. Inputs:
- `heating[i]` for `is_absence`, `nonheat_residual_kwh`
- `external[i]` for `solar_w_m2`
- `supplementaryLoads.electricity_baseload` (kWh/HH scalar; null → 0)
- `baseloadMetadata.baseload_median_kwh_per_day` (kWh/day; → W per HH)
- `solarAperture` (m²; null → 0)
- `householdSize` (integer ≥ 0)

**EV-cap window:** derive hour-of-day from `heating[i].timestamp` (ISO format HH:MM — use
`.slice(11, 13)`), matching how `collectMorningEvents` does it. Do **not** use `i % 48` — CSV
data is not midnight-aligned.

```javascript
function assembleGains(heating, external, supplementaryLoads, baseloadMetadata,
                        solarAperture, householdSize) {
  const n = heating.length;
  const elecBase_kwh = supplementaryLoads?.electricity_baseload ?? 0;
  const elecBase_w   = elecBase_kwh * 2000;   // kWh/HH → W (× 2 HH/h × 1000 W/kW)
  const gasBase_w    = ((baseloadMetadata?.baseload_median_kwh_per_day ?? 0) / 48)
                       * 2000 * TC_CONFIG.F_GAS;
  const R            = solarAperture ?? 0;
  const nOcc         = householdSize ?? 2;
  const gains        = new Array(n);

  for (let i = 0; i < n; i++) {
    const h   = heating[i];
    const ext = external[i];
    const absent = !!h.is_absence;
    const hour   = parseInt(h.timestamp.slice(11, 13), 10);   // hour-of-day from timestamp

    // Intermittent appliances: (nonheat_residual − elec_baseload) × 0.9, EV-capped overnight
    const nonheat_kwh = h.nonheat_residual_kwh ?? 0;
    let intermittent_kwh = Math.max(0, nonheat_kwh - elecBase_kwh) * 0.9;
    if (hour >= TC_CONFIG.EV_WINDOW_START_H && hour < TC_CONFIG.EV_WINDOW_END_H) {
      intermittent_kwh = Math.min(intermittent_kwh, TC_CONFIG.EV_CAP_K * elecBase_kwh);
    }
    const intermittent_w = intermittent_kwh * 2000;

    // Occupancy: zeroed on absence
    const occupancy_w = absent ? 0 : TC_CONFIG.OCCUPANCY_W_PER_PERSON * nOcc;

    // Solar
    const solar_w = R * (ext?.solar_w_m2 ?? 0);

    gains[i] = elecBase_w + intermittent_w + gasBase_w + occupancy_w + solar_w;
  }
  return gains;
}
```

---

### Step 6 — Step 2a: Method A — `collectMorningEvents` + `fitTauMethodA` (`js/thermal-character.js`)

**`collectMorningEvents(heating, external, thermalDelivered, htcUsed, operativeSetpoint)`:**

Scans chronologically for morning-reheat episodes. For each episode returns
`{y, T_out, t_off}` used by the τ-fit.

Algorithm:
1. Find a pre-dawn reheat start: a slot where `hour ∈ [PREDAWN_START_H, PREDAWN_END_H)` AND
   `thermalDelivered > METHOD_A_HEAT_THRESH_KWH` AND NOT `is_absence`.
2. Scan backwards to find the preceding overnight off-period:
   consecutive slots with `thermalDelivered ≤ HEAT_THRESH` and no absence.
3. If off-period < `METHOD_A_MIN_OFF_HH` → skip.
4. Compute `T_out_night` = mean T_out over off period; skip if ≥ `WINTER_MAX_T_C`.
5. Scan forward for the reheat run (capped at `METHOD_A_MAX_REHEAT_HH`).
6. Skip if reheat < `METHOD_A_MIN_REHEAT_HH`.
7. Compute: `correction = htcUsed × max(0, setpoint − T_out_night) × t_reheat_h / 1000`
   (kWh loss during reheat — G-independent; absorbed into intercept A).
8. `y_i = E_reheat − correction`; record `{y, T_out: T_out_night, t_off: t_off_h}`.

```javascript
function collectMorningEvents(heating, external, thermalDelivered, htcUsed, operativeSetpoint) {
  const events = [];
  const n = heating.length;
  let i = 0;

  while (i < n) {
    const hour = parseInt(heating[i].timestamp.slice(11, 13), 10);
    const isPreDawn = hour >= TC_CONFIG.METHOD_A_PREDAWN_START_H
                   && hour < TC_CONFIG.METHOD_A_PREDAWN_END_H;
    const hasThermal = thermalDelivered[i] !== null
                    && thermalDelivered[i] > TC_CONFIG.METHOD_A_HEAT_THRESH_KWH;

    if (!isPreDawn || !hasThermal || heating[i].is_absence) { i++; continue; }

    // Scan backwards for the overnight off-period preceding this reheat start
    let offStart = i - 1;
    while (offStart >= 0
           && (thermalDelivered[offStart] === null
               || thermalDelivered[offStart] <= TC_CONFIG.METHOD_A_HEAT_THRESH_KWH)
           && !heating[offStart].is_absence) {
      offStart--;
    }
    offStart++;
    const offHH = i - offStart;
    if (offHH < TC_CONFIG.METHOD_A_MIN_OFF_HH) { i++; continue; }

    // Overnight mean T_out and t_off
    let tSum = 0, tCount = 0;
    for (let j = offStart; j < i; j++) {
      const tc = external[j]?.temp_c;
      if (tc !== null && tc !== undefined) { tSum += tc; tCount++; }
    }
    if (tCount === 0 || tSum / tCount >= TC_CONFIG.WINTER_MAX_T_C) { i++; continue; }
    const T_out = tSum / tCount;
    const t_off = offHH * 0.5;

    // Scan forward for the reheat run
    let reEnd = i;
    let E_reheat = 0;
    while (reEnd < n
           && thermalDelivered[reEnd] !== null
           && thermalDelivered[reEnd] > TC_CONFIG.METHOD_A_HEAT_THRESH_KWH
           && !heating[reEnd].is_absence
           && (reEnd - i) < TC_CONFIG.METHOD_A_MAX_REHEAT_HH) {
      E_reheat += thermalDelivered[reEnd];
      reEnd++;
    }
    if (reEnd - i < TC_CONFIG.METHOD_A_MIN_REHEAT_HH) { i = reEnd + 1; continue; }

    const t_reheat = (reEnd - i) * 0.5;
    const correction = htcUsed * Math.max(0, operativeSetpoint - T_out) * t_reheat / 1000;
    events.push({ y: E_reheat - correction, T_out, t_off });
    i = reEnd;
  }
  return events;
}
```

**`fitTauMethodA(events, htcUsed)`:**

Minimises `Var(z_i(τ))` where `z_i(τ) = y_i + m_i(τ) × T_out_i` and
`m_i(τ) = 3.6 × htcUsed × τ × (1 − exp(−t_off_i / τ))`. Correct τ makes z_i constant = A.

Returns `{tau, r2, relative_se, ci95, n}` or null if < METHOD_A_MIN_EVENTS.

```javascript
function fitTauMethodA(events, htcUsed) {
  if (events.length < TC_CONFIG.METHOD_A_MIN_EVENTS) return null;
  const n = events.length;

  const mi = (tau, ev) => 3.6 * htcUsed * tau * (1 - Math.exp(-ev.t_off / tau));

  function rss(tau) {
    const zs = events.map(ev => ev.y + mi(tau, ev) * ev.T_out);
    const mz = zs.reduce((s, v) => s + v, 0) / n;
    return zs.reduce((s, v) => s + (v - mz) ** 2, 0);
  }

  // Grid search on log-spaced τ, then golden-section refinement
  const logLo = Math.log(0.5), logHi = Math.log(100);
  const GRID_N = 200;
  let bestRss = Infinity, bestTau = 5;
  for (let k = 0; k <= GRID_N; k++) {
    const tau = Math.exp(logLo + (logHi - logLo) * k / GRID_N);
    const r = rss(tau);
    if (r < bestRss) { bestRss = r; bestTau = tau; }
  }
  const step = Math.exp((logHi - logLo) / GRID_N);
  const tau_hat = goldenSectionMin(rss, Math.max(0.1, bestTau / step), bestTau * step);

  // R² relative to y_i
  const A_hat = events.reduce((s, ev) => s + ev.y + mi(tau_hat, ev) * ev.T_out, 0) / n;
  const my = events.reduce((s, ev) => s + ev.y, 0) / n;
  let ss_res = 0, ss_tot = 0;
  for (const ev of events) {
    ss_res += (ev.y - (A_hat - mi(tau_hat, ev) * ev.T_out)) ** 2;
    ss_tot += (ev.y - my) ** 2;
  }
  const r2 = ss_tot > 1e-12 ? 1 - ss_res / ss_tot : 0;
  const sigma2 = ss_res / Math.max(n - 2, 1);

  // SE(τ) from numerical Hessian of RSS at τ_hat (profile-likelihood approach)
  const delta = tau_hat * 0.01;
  const curvature = (rss(tau_hat + delta) - 2 * rss(tau_hat) + rss(tau_hat - delta))
                    / (delta * delta);
  const se_tau = curvature > 1e-12 ? Math.sqrt(sigma2) / Math.sqrt(curvature / 2) : Infinity;
  const relative_se = se_tau / tau_hat;
  const ci95 = [Math.max(0.1, tau_hat - 1.96 * se_tau), tau_hat + 1.96 * se_tau];

  return { tau: tau_hat, r2, relative_se, ci95, n };
}
```

---

### Step 7 — Step 2b: Method B — `computeMaxLoad`, `collectAbsenceRecoveryEvents`, `fitTauMethodB` (`js/thermal-character.js`)

**Why Method B changed from the first-draft plan:** The first-draft's `collectRecoveryEvents`
detected sustained ceiling runs (thermalDelivered ≥ CEILING_FACTOR × max_load) preceded by a
low-heat period. This is not absence-based detection — it fires on any sustained heat burst after
a quieter period, independent of whether the home was vacant. The revised design §2.5.3 requires
detecting **`is_absence` gaps** of varying soak duration, then computing C_est per event and
regressing against soak duration to extrapolate the asymptote (C_true). The old fixed-cooldown
equilibrium logic and the ceiling-run gate are replaced by absence-gap detection + profile-LS fit.

**`computeMaxLoad(thermalDelivered, heating)`** — retained for the `heat_system_capacity_kw`
byproduct (UI context); no longer used for recovery-run detection:

```javascript
function computeMaxLoad(thermalDelivered, heating) {
  const all = thermalDelivered.filter((v, i) => v !== null && !heating[i].is_absence);
  if (!all.length) return null;
  const p95 = percentile(all, TC_CONFIG.PCTILE_UPPER_TAIL);
  const tail = all.filter(v => v > p95);
  return tail.length ? halfSampleMode(tail) : null;
}
```

**`collectAbsenceRecoveryEvents(heating, external, thermalDelivered, internalGains, htcUsed, operativeSetpoint, maxLoad)`:**

Scans for `is_absence` gaps, then for each gap finds the subsequent at-ceiling recovery run and
computes C_est from the energy balance with forced equilibrium (`T_start = T_eq`). Returns
`[{t_soak_h, C_est}]`. C_est is intentionally biased (finite soak ≠ full equilibrium) — the bias
∝ exp(−t_soak/τ), which shrinks with duration. The asymptote fit in `fitTauMethodB` extrapolates
to true C.

Recovery is bounded by the max-firing ceiling: the boiler fires flat-out to re-warm after an
absence, and it ends when it drops off the ceiling (setpoint reached). `ceiling = CEILING_FACTOR ×
maxLoad`. If `maxLoad` is null, no events can be collected (return empty).

```javascript
function collectAbsenceRecoveryEvents(heating, external, thermalDelivered, internalGains,
                                       htcUsed, operativeSetpoint, maxLoad) {
  if (maxLoad === null || maxLoad === undefined) return [];
  const ceiling = TC_CONFIG.CEILING_FACTOR * maxLoad;
  const n = heating.length;
  const events = [];
  let i = 0;

  while (i < n) {
    if (!heating[i].is_absence) { i++; continue; }

    // Find extent of absence gap
    const gapStart = i;
    while (i < n && heating[i].is_absence) i++;
    const gapEnd = i;                         // first non-absence slot after gap
    const t_soak_hh = gapEnd - gapStart;
    if (t_soak_hh < TC_CONFIG.METHOD_B_MIN_SOAK_HH) continue;

    // T_eq forced from last METHOD_B_LATE_SOAK_HH slots of the gap (equilibrium assumption)
    const anchorStart = Math.max(gapStart, gapEnd - TC_CONFIG.METHOD_B_LATE_SOAK_HH);
    let tSum = 0, tCount = 0, gSum = 0, gCount = 0;
    for (let j = anchorStart; j < gapEnd; j++) {
      const tc = external[j]?.temp_c;
      if (tc !== null && tc !== undefined) { tSum += tc; tCount++; }
      const g = internalGains[j];   // zeroed on absence by assembleGains (no occupancy)
      if (g !== null && g !== undefined) { gSum += g; gCount++; }
    }
    if (tCount === 0) continue;
    const T_out_late = tSum / tCount;
    const G_late_w = gCount > 0 ? gSum / gCount : 0;   // ≈ 0 on absence (occupancy zeroed)
    const T_eq = T_out_late + G_late_w / htcUsed;       // W / (W/K) = K offset ✓
    if (T_eq >= operativeSetpoint) continue;             // already at setpoint — no recovery

    // Recovery = sustained at/near-ceiling run after gapEnd.
    // The boiler fires flat-out to re-warm; run ends when it drops off the ceiling (setpoint reached).
    // Allow up to 4 HH after gapEnd for heating to resume.
    let recStart = gapEnd;
    while (recStart < n && !heating[recStart].is_absence
           && (thermalDelivered[recStart] === null
               || thermalDelivered[recStart] < ceiling)
           && recStart - gapEnd < 4) {
      recStart++;
    }
    if (recStart >= n || heating[recStart].is_absence) continue;
    if (thermalDelivered[recStart] === null || thermalDelivered[recStart] < ceiling) continue;

    // recEnd = first HH after recStart where delivery drops off the ceiling
    let recEnd = recStart;
    while (recEnd < n
           && !heating[recEnd].is_absence
           && thermalDelivered[recEnd] !== null
           && thermalDelivered[recEnd] >= ceiling) {
      recEnd++;
    }
    const t_rec_hh = recEnd - recStart;
    if (t_rec_hh < TC_CONFIG.METHOD_B_MIN_RECOVERY_HH) { i = recEnd; continue; }

    // Energy balance over recovery run
    let E_del = 0, E_gains = 0, tRunSum = 0, tRunCount = 0;
    for (let j = recStart; j < recEnd; j++) {
      E_del   += thermalDelivered[j] ?? 0;                          // kWh
      E_gains += (internalGains[j] ?? 0) * 0.5 / 1000;             // W × 0.5 h / 1000 → kWh
      const tc = external[j]?.temp_c;
      if (tc !== null && tc !== undefined) { tRunSum += tc; tRunCount++; }
    }
    const T_out_run = tRunCount > 0 ? tRunSum / tRunCount : T_out_late;
    const t_h = t_rec_hh * 0.5;
    const T_mean = (T_eq + operativeSetpoint) / 2;
    const E_loss = htcUsed * (T_mean - T_out_run) * t_h / 1000;    // W/K × K × h / 1000 → kWh
    const deltaT = operativeSetpoint - T_eq;
    if (deltaT <= 0) { i = recEnd; continue; }
    const C_est = ((E_del + E_gains - E_loss) * 3600) / deltaT;    // kWh × 3600 / K → kJ/K
    if (C_est > 0) events.push({ t_soak_h: t_soak_hh * 0.5, C_est });

    i = recEnd;
  }
  return events;
}
```

**`fitTauMethodB(events)`:**

Profile-LS on the asymptote A (= C_true): outer golden-section on A, inner origin-forced OLS on
linearised B = 1/τ. Bootstrap resamples events for SE on A. Returns:
- `null` — events array is empty (no absence gaps with recoveries);
- `{fired: false, reason: 'insufficient_events', n}` — events < MIN_EVENTS_METHOD_B;
- `{fired: false, reason: 'insufficient_spread', n}` — soak durations too uniform;
- `{fired: false, reason: 'wide_ci', tau, relative_se, n}` — CI too wide to fire;
- `{fired: true, tau, C, relative_se, ci95, n}` — success.

```javascript
function fitTauMethodB(events) {
  if (events.length === 0) return null;
  if (events.length < TC_CONFIG.MIN_EVENTS_METHOD_B) {
    return { fired: false, reason: 'insufficient_events', n: events.length };
  }

  // Duration-spread gate
  const soaks = events.map(e => e.t_soak_h);
  const spread = Math.max(...soaks) - Math.min(...soaks);
  if (spread < TC_CONFIG.METHOD_B_DURATION_SPREAD_H) {
    return { fired: false, reason: 'insufficient_spread', n: events.length };
  }

  // Profile-LS: golden-section on A (asymptote), OLS on linearised B per candidate A
  function profileRss(A) {
    if (A <= 0) return Infinity;
    for (const { C_est } of events) { if (C_est >= A) return Infinity; }
    // Linearise: z = -log(1 - C_est/A) = B × t_soak; origin-forced OLS for B
    let sumZT = 0, sumT2 = 0;
    for (const { t_soak_h, C_est } of events) {
      const z = -Math.log(1 - C_est / A);
      sumZT += z * t_soak_h;
      sumT2 += t_soak_h * t_soak_h;
    }
    if (sumT2 <= 0) return Infinity;
    const B = sumZT / sumT2;
    if (B <= 0) return Infinity;
    let rss = 0;
    for (const { t_soak_h, C_est } of events) {
      rss += (C_est - A * (1 - Math.exp(-B * t_soak_h))) ** 2;
    }
    return rss;
  }

  const maxC = Math.max(...events.map(e => e.C_est));
  const A_hat = goldenSectionMin(profileRss, maxC * 1.001, maxC * 20, maxC * 0.01);
  if (!isFinite(A_hat) || profileRss(A_hat) === Infinity) {
    return { fired: false, reason: 'degenerate_fit', n: events.length };
  }

  // Recover B_hat at A_hat
  let sumZT = 0, sumT2 = 0;
  for (const { t_soak_h, C_est } of events) {
    const z = -Math.log(1 - C_est / A_hat);
    sumZT += z * t_soak_h;
    sumT2 += t_soak_h * t_soak_h;
  }
  const B_hat = sumT2 > 0 ? sumZT / sumT2 : null;
  if (!B_hat || B_hat <= 0) return { fired: false, reason: 'degenerate_fit', n: events.length };
  const tau_hat = 1 / B_hat;   // hours

  // Bootstrap CI on A (= C_true): resample events, refit A, collect distribution
  function fitA(sample) {
    if (sample.length < 2) return null;
    const mxC = Math.max(...sample.map(e => e.C_est));
    const A_b = goldenSectionMin(
      AA => {
        if (AA <= 0) return Infinity;
        for (const { C_est } of sample) { if (C_est >= AA) return Infinity; }
        let sZT = 0, sT2 = 0;
        for (const { t_soak_h, C_est } of sample) {
          const z = -Math.log(1 - C_est / AA);
          sZT += z * t_soak_h; sT2 += t_soak_h * t_soak_h;
        }
        if (sT2 <= 0) return Infinity;
        const B = sZT / sT2;
        if (B <= 0) return Infinity;
        let rss = 0;
        for (const { t_soak_h, C_est } of sample) {
          rss += (C_est - AA * (1 - Math.exp(-B * t_soak_h))) ** 2;
        }
        return rss;
      },
      mxC * 1.001, mxC * 20, mxC * 0.01
    );
    return isFinite(A_b) ? A_b : null;
  }

  const bootAs = [];
  for (let b = 0; b < TC_CONFIG.BOOTSTRAP_ITER; b++) {
    const A_b = fitA(sampleWithReplacement(events));
    if (A_b !== null && A_b > 0) bootAs.push(A_b);
  }
  bootAs.sort((a, b) => a - b);
  const ci_lo_C = percentile(bootAs, 2.5)  ?? A_hat * 0.5;
  const ci_hi_C = percentile(bootAs, 97.5) ?? A_hat * 1.5;
  const se_A = (ci_hi_C - ci_lo_C) / (2 * 1.96);
  const relative_se = se_A > 0 ? se_A / A_hat : Infinity;

  if (!isFinite(relative_se) || relative_se > TC_CONFIG.FIRE_THRESHOLD_SE) {
    return { fired: false, reason: 'wide_ci', tau: tau_hat, relative_se, n: events.length };
  }

  // CI on τ: same relative error as C (τ = C/(3.6×htcUsed), linear in C)
  const ci95 = [
    (ci_lo_C / A_hat) * tau_hat,
    (ci_hi_C / A_hat) * tau_hat,
  ];
  return { fired: true, tau: tau_hat, C: A_hat, relative_se, ci95, n: events.length };
}
```

---

### Step 8 — Step 2c: `selectTau` — confidence selection (`js/thermal-character.js`)

Both estimators convert to relative SE on τ, then apply the three-way logic (§2.5.3 Selection).
`fitA` is null when Method A had fewer than METHOD_A_MIN_EVENTS events; a non-null `fitA` always
has a `relative_se` (which may exceed FIRE_THRESHOLD). `fitB` is null when no absence events
were found at all; a non-null `fitB` has a `fired` flag. These distinctions drive `fit_status`.

```javascript
function selectTau(fitA, fitB) {
  const fireA = fitA !== null && isFinite(fitA.relative_se)
             && fitA.relative_se <= TC_CONFIG.FIRE_THRESHOLD_SE;
  const fireB = fitB !== null && fitB.fired === true;

  // fit_status: 'fired' if any estimator fires; 'rejected_low_confidence' if events present but
  // no fire (fitA non-null = had events; fitB non-null = had events); 'no_data' if neither had data.
  let fit_status;
  if (fireA || fireB) {
    fit_status = 'fired';
  } else if (fitA !== null || fitB !== null) {
    fit_status = 'rejected_low_confidence';
  } else {
    fit_status = 'no_data';
  }

  if (fireA && fireB) {
    const seA = fitA.tau * fitA.relative_se;
    const seB = fitB.tau * fitB.relative_se;
    const overlap = Math.abs(fitA.tau - fitB.tau) < 1.96 * (seA + seB);
    if (overlap) {
      const wA = 1 / (seA * seA), wB = 1 / (seB * seB);
      const tau_c = (fitA.tau * wA + fitB.tau * wB) / (wA + wB);
      const se_c  = 1 / Math.sqrt(wA + wB);
      const rel_c = se_c / tau_c;
      return {
        tau: tau_c, relative_se: rel_c,
        ci95: [Math.max(0.1, tau_c - 1.96 * se_c), tau_c + 1.96 * se_c],
        method: 'combined', disagree: false, fit_status,
      };
    }
    return { tau: null, relative_se: null, ci95: null, method: null, disagree: true, fit_status };
  }
  if (fireA) return {
    tau: fitA.tau, relative_se: fitA.relative_se, ci95: fitA.ci95,
    method: 'reheat_regression', disagree: false, fit_status,
  };
  if (fireB) return {
    tau: fitB.tau, relative_se: fitB.relative_se, ci95: fitB.ci95,
    method: 'asymptote', disagree: false, fit_status,
  };
  return { tau: null, relative_se: null, ci95: null, method: null, disagree: false, fit_status };
}
```

---

### Step 9 — Step 3: `resolveEffectiveC` — dropdown-wins inversion (`js/thermal-character.js`)

```javascript
function resolveEffectiveC(selected, htcUsed, tauBucket) {
  if (tauBucket && TAU_BUCKET_HOURS_MAP[tauBucket] !== undefined) {
    const tau_user = TAU_BUCKET_HOURS_MAP[tauBucket];
    return {
      thermal_mass_kj_per_k: tau_user * htcUsed * 3.6,
      thermal_mass_source: 'user_tau',
      thermal_mass_method: null,
    };
  }
  if (selected.tau !== null) {
    return {
      thermal_mass_kj_per_k: 3.6 * htcUsed * selected.tau,
      thermal_mass_source: 'measured',
      thermal_mass_method: selected.method,
    };
  }
  return { thermal_mass_kj_per_k: null, thermal_mass_source: null, thermal_mass_method: null };
}
```

---

### Step 10 — Step 4: rating + time constant + tau-bucket pair (`js/thermal-character.js`)

Reproduced from v1 `computeRatingAndTimeConstant` — now uses `htcUsed` (not `htc_w_per_k`).
The TAU_HIGH/LOW_WARN checks (v1 lines 453–460) are dropped — they had no design-doc basis in v2.

```javascript
function computeRatingAndTimeConstant(C, htcUsed) {
  if (C === null || htcUsed === null) return { time_constant_hours: null, thermal_mass_rating: null };
  const time_constant_hours = C / (htcUsed * 3.6);
  let thermal_mass_rating;
  if      (C < TC_CONFIG.MASS_RATING_MEDIUM_KJ)    thermal_mass_rating = 'low';
  else if (C < TC_CONFIG.MASS_RATING_HIGH_KJ)      thermal_mass_rating = 'medium';
  else if (C < TC_CONFIG.MASS_RATING_VERY_HIGH_KJ) thermal_mass_rating = 'high';
  else                                              thermal_mass_rating = 'very_high';
  return { time_constant_hours, thermal_mass_rating };
}

function buildTauBucketPair(dataTau, tauBucket) {
  // tau_bucket (bare) — nearest bucket to data-derived τ
  let tau_bucket = null;
  if (dataTau !== null) {
    let best = null, bestDiff = Infinity;
    for (const [bucket, h] of Object.entries(TAU_BUCKET_HOURS_MAP)) {
      const diff = Math.abs(dataTau - h);
      if (diff < bestDiff) { bestDiff = diff; best = bucket; }
    }
    tau_bucket = best;
  }
  // tau_bucket_used (effective) — user dropdown when set, else data-derived, else null
  const tau_bucket_used = (tauBucket && TAU_BUCKET_HOURS_MAP[tauBucket] !== undefined)
    ? tauBucket : tau_bucket;
  return { tau_bucket, tau_bucket_used };
}
```

---

### Step 11 — Step 5: `computeValidationStatus` — CI-banded (`js/thermal-character.js`)

```javascript
function computeValidationStatus(C, source, relative_se) {
  if (C === null) return 'insufficient_data';
  if (source === 'user_tau') return 'acceptable';
  if (relative_se !== null && isFinite(relative_se)
      && relative_se <= TC_CONFIG.GOOD_SE_THRESHOLD) return 'good';
  return 'acceptable';
}
```

---

### Step 12 — Main export: `estimateThermalCharacter` (`js/thermal-character.js`)

New signature replaces the v1 signature entirely.

**Old:** `(heating, external, heatLoss, baseloadMethod, wallConstructionType, tAtRestartWinterC, tauBucket)`
**New:** `(heating, external, heatLoss, supplementaryLoads, baseloadMetadata, operativeSetpoint, householdSize, tauBucket)`

**`householdSize` default = `2`** (architecture-v2 registry: ~2–3 UK household; not `1`).

```javascript
export function estimateThermalCharacter(
  heating,                    // m3 heating[] — is_absence, nonheat_residual_kwh per HH
  external,                   // m2 external[] — temp_c, solar_w_m2 per HH
  heatLoss,                   // m4 result — htc_used, solar_aperture, thermal_heat_delivered_kwh[]
  supplementaryLoads,         // m3 supplementary_loads — electricity_baseload (kWh/HH scalar)
  baseloadMetadata,           // m3 baseload_metadata — baseload_median_kwh_per_day
  operativeSetpoint = 20,     // UI — default 20°C (D2 bootstrap)
  householdSize = 2,          // UI — integer (~2–3 per architecture-v2 registry)
  tauBucket = null,           // UI — §8b dropdown or null
) {
  const htcUsed = heatLoss?.htc_used ?? null;
  if (htcUsed === null) return nullResult('no_htc');

  const thermalDelivered = heatLoss?.thermal_heat_delivered_kwh ?? [];
  const solarAperture    = heatLoss?.solar_aperture ?? null;
  const warnings         = [];

  // Step 1 — Heating frequency (source-blind rename of occupancy_weights)
  const { heating_frequency_by_hh, warning: hfWarn } =
    computeHeatingFrequencyByHh(heating, thermalDelivered);
  if (hfWarn) warnings.push(hfWarn);

  // Step 1b — Gains assembly (m5-owned → m7)
  const internal_gains_w = assembleGains(
    heating, external, supplementaryLoads, baseloadMetadata, solarAperture, householdSize
  );

  // heat_system_capacity_kw — byproduct for UI context (max_load still computed)
  const maxLoad = computeMaxLoad(thermalDelivered, heating);
  const heat_system_capacity_kw = maxLoad !== null ? maxLoad * 2 : null;

  // Step 2 — Path A: two independent estimators of τ
  const morningEvents = collectMorningEvents(
    heating, external, thermalDelivered, htcUsed, operativeSetpoint
  );
  const fitA = fitTauMethodA(morningEvents, htcUsed);

  const recovEvents = collectAbsenceRecoveryEvents(
    heating, external, thermalDelivered, internal_gains_w, htcUsed, operativeSetpoint, maxLoad
  );
  const fitB = fitTauMethodB(recovEvents);

  const selected = selectTau(fitA, fitB);

  // Step 3 — Effective C: user dropdown wins
  const { thermal_mass_kj_per_k, thermal_mass_source, thermal_mass_method } =
    resolveEffectiveC(selected, htcUsed, tauBucket);

  // Step 4 — Rating + time constant + tau-bucket pair
  const { time_constant_hours, thermal_mass_rating } =
    computeRatingAndTimeConstant(thermal_mass_kj_per_k, htcUsed);
  const data_derived_tau_h = selected.tau ?? null;
  const { tau_bucket, tau_bucket_used } = buildTauBucketPair(data_derived_tau_h, tauBucket);

  // Step 5 — Validation status (CI-banded from winning estimator)
  const validation_status = computeValidationStatus(
    thermal_mass_kj_per_k, thermal_mass_source, selected.relative_se
  );

  const thermal_mass_fit = (thermal_mass_source === 'measured' && selected.relative_se !== null)
    ? { relative_se: selected.relative_se, ci95: selected.ci95 } : null;

  // Failure-path warnings (no auto-'medium')
  if (thermal_mass_kj_per_k === null) {
    if (selected.disagree) {
      warnings.push('Two estimators of thermal mass gave conflicting results — using your warmth-retention description (if set) or awaiting your input.');
    } else if (selected.fit_status === 'rejected_low_confidence') {
      warnings.push('Couldn\'t read your home\'s thermal mass reliably — describe how your home holds warmth (below) to unlock smart pre-heating.');
    } else {
      warnings.push('Your home holds heat too steadily overnight to read its thermal mass from the data. Describe how your home holds warmth (below) to unlock smart pre-heating.');
    }
  }
  if (thermal_mass_source === 'user_tau') {
    warnings.push('Thermal mass estimated from your warmth-retention description (indicative).');
  }

  return {
    internal_gains_w,
    thermal_mass_kj_per_k,
    time_constant_hours,
    thermal_mass_rating,
    heating_frequency_by_hh,
    tau_bucket,
    tau_bucket_used,
    thermal_mass_source,
    thermal_mass_method,
    thermal_mass_fit_status: selected.fit_status,
    data_derived_tau_h,
    thermal_mass_fit,
    heat_system_capacity_kw,
    validation_status,
    warnings,
  };
}
```

---

### Step 13 — `test-m5-v2.mjs` — 14 test cases

Create at repo root. Uses the same `assert`/pass/fail harness pattern as `test-m3-v2.mjs`.
All tests use synthetic data; no m4/m3/m2 runtime dependency.

**Synthetic data helpers (local to test file):**
- `makeHeating(n, opts)` — array of `{timestamp, heating_kwh, is_absence, nonheat_residual_kwh}`
  where `opts` can override per-slot values.
- `makeExternal(n, opts)` — array of `{temp_c, solar_w_m2}`.
- `makeHeatLoss(htcUsed, solarAperture, thermalDelivered)` — m4 result stub:
  `{htc_used: htcUsed, solar_aperture: solarAperture, thermal_heat_delivered_kwh: thermalDelivered}`.
- `makeSupplementary(elecBase)` — `{electricity_baseload: elecBase}`.
- `makeMeta(medianKwhPerDay)` — `{baseload_median_kwh_per_day: medianKwhPerDay}`.

**Timestamp generation:** synthetic timestamps must parse correctly for hour-of-day detection.
Use ISO format: `'2024-01-15T03:00:00Z'` for slot within pre-dawn window.

**Test cases mapped to §5 criteria:**

| TC | §5 | Description |
|---|---|---|
| TC1 | §5.1 | Output has no `setpoint_c`, `setpoint_days_used` keys; no `estimateSetpoint` in module |
| TC2 | §5.2 | Method A τ-recovery: forward RC simulation with known τ=16.67h; fitted τ within ±15% |
| TC3 | §5.3 | Method A G-robust: same as TC2 but gains offset by constant; assert τ unchanged |
| TC4 | §5.4 | Method B asymptote: forward RC simulation with known C=12000 kJ/K, varying absence soaks; asymptote within ±15%; `method='asymptote'` |
| TC4b | §5.4 | Method B rejects on uniform-duration absences → `fit_status='rejected_low_confidence'`, `C=null` |
| TC5 | §5.5 | Source-blind: `gas_heating_kwh=0`, recovery on elec thermal; C recovered, `validation_status ≠ 'no_gas'` |
| TC6 | §5.6 | Continuous-heating → null: never cools, no tauBucket; `C=null`, `status='insufficient_data'`, `fit_status='no_data'` |
| TC7 | §5.7 | Confidence selection: Method A wins for regular-schedule; Method B wins for irregular; both-agree → 'combined'; both-disagree → null |
| TC8 | §5.8 | Dropdown overrides: estimator fires AND user sets tauBucket; `source='user_tau'`; data τ in `tau_bucket`/`data_derived_tau_h` |
| TC9 | §5.9 | `heating_frequency_by_hh`: 48-element array; null if <14 days; weekday-only → high weekday slots |
| TC10 | §5.10 | `no_gas` never produced: all-electric input → `validation_status ≠ 'no_gas'` |
| TC11 | §5.11 | Bootstrap D2: operativeSetpoint defaults to 20; C computed; output has no `setpoint_c` field |
| TC12 | §5.12 | Wall-construction dropped: no wall-construction-mismatch warning; no `wall_construction` parameter |
| TC13 | §5.13 | Underheat diagnostic relocated: output has no `underheat_status`, `underheat_narrative`, `annual_modelled_demand_kwh` |

**TC2 construction (concrete — first-principles forward RC simulation):**

Known: C_true = 12000 kJ/K, htcUsed = 200 W/K → τ_true = 12000/(200×3.6) = 16.67 h.
Operative setpoint = 20°C. G_w = 200 W (constant small gains).

For each of 40 morning events, simulate free RC cooling over t_off = 8 h then reheat:
1. T_eq_i = T_out_i + G_w / htcUsed = T_out_i + 1.0°C  (200 W / (200 W/K))
2. T_start_i = T_eq_i + (20 - T_eq_i) × exp(−t_off / τ_true)  [RC free-cooling formula]
3. E_mass_i = C_true × (20 − T_start_i) / 3600  [kWh — energy to reheat the mass]
4. t_reheat = 1.5 h; E_fabric_i = htcUsed × max(0, 20 − T_out_i) × t_reheat / 1000  [kWh]
5. E_reheat_i = E_mass_i + E_fabric_i  [total kWh in reheat slots]
6. Assign E_reheat_i / 3 to 3 pre-dawn HH slots in `thermalDelivered`; off-period HH get 0.
7. T_out_i drawn from `[−2, 8]°C` range (20 evenly-spaced values, repeated twice).

This generates synthetic thermalDelivered from RC physics with known C_true — not by inverting
the estimator formula. Assert: `|result.data_derived_tau_h − 16.67| / 16.67 < 0.15`.

**TC3 construction:**
Same as TC2, but add constant gain offset G_offset = 500 W to supplementaryLoads.electricity_baseload
(i.e. elecBase_kwh = G_offset / 2000 kWh extra). Method A's intercept absorbs constant G shifts.
Assert: `|tau_with_offset − tau_no_offset| < 1.5 h`.

**TC4 construction (concrete — first-principles forward RC simulation):**

Known: C_true = 12000 kJ/K, htcUsed = 200 W/K → τ_true = 16.67 h. Setpoint = 20°C. T_out = 5°C
(constant). G_w = 0 during absence (absence zeroes occupancy; no elec/gas/solar in test fixture).
Recovery ceiling: CEIL = 3.0 kWh/HH (a real boiler caps per-HH output and extends duration for
a deeper cool — it does not deliver more per HH).

Generate 6 absence soaks of varying duration: [4, 8, 16, 24, 36, 48] hours.

For each soak of duration t_soak_i:
1. T_eq = T_out + G_absent_w / htcUsed = 5 + 0 = 5°C  (G absent = 0)
2. T_at_end_i = T_eq + (20 − T_eq) × exp(−t_soak_i / τ_true)  [RC free-cooling]
   = 5 + 15 × exp(−t_soak_i / 16.67)
3. E_mass_i = C_true × (20 − T_at_end_i) / 3600  [kWh needed to reheat mass from T_at_end to 20]
4. t_fabric per HH = htcUsed × max(0, 20 − T_out) / 1000  [kW × HH = kWh/HH at T_mean ≈ setpoint]
5. Model recovery as a run of HH at fixed ceiling CEIL = 3.0 kWh/HH (variable length):
   - `n_rec_i = Math.ceil(E_recovery_i / CEIL)` where `E_recovery_i` is computed iteratively:
     n_rec_i_approx = Math.ceil((E_mass_i + htcUsed * 15 * (n_rec_approx * 0.5) / 1000) / CEIL)
     (simpler: set t_recovery = n_rec_i × 0.5 h; E_fabric_i = htcUsed × max(0, 20 − T_out) × t_recovery / 1000;
      E_recovery_i = E_mass_i + E_fabric_i; n_rec_i = Math.ceil(E_recovery_i / CEIL))
   - First (n_rec_i − 1) HH get CEIL = 3.0 kWh/HH; last HH gets E_recovery_i − (n_rec_i − 1) × CEIL
6. Assign to n_rec_i consecutive recovery HH; `is_absence = true` for the soak HH.

Build full `heating[]` and `thermalDelivered[]`:
- Absence slots: `is_absence = true`, `thermalDelivered = 0`
- Recovery slots: `is_absence = false`, `thermalDelivered` per step 5 above
- Non-absence non-recovery slots (between events): `is_absence = false`, `thermalDelivered = 0.1`
  (maintenance heat — below 0.9 × CEIL = 2.7, so the ceiling-based recEnd terminates correctly)

Set supplementaryLoads and baseloadMetadata to zero (minimal G — assembleGains produces near-zero
gains for absence slots, consistent with the forward-simulation assumption G_absent = 0).

Assert:
- `result.data_derived_tau_h` is non-null
- `|result.thermal_mass_kj_per_k − 12000| / 12000 < 0.15`  (asymptote within ±15%)
- `result.thermal_mass_method === 'asymptote'`
- `result.thermal_mass_fit_status === 'fired'`

**TC4b construction (uniform-duration rejection):**
Same home as TC4 (same C_true, τ_true, T_out, CEIL = 3.0, recovery logic), but all 6 absence soaks
are the same duration: all = 8 h. Duration spread = 0 h, below METHOD_B_DURATION_SPREAD_H = 12 h.
Method A has no events (continuous-heat home — no overnight setback). Assert:
- `result.thermal_mass_kj_per_k === null`
- `result.thermal_mass_fit_status === 'rejected_low_confidence'`

---

### Step 14 — `js/scenario-consumption.js`: update thermalChar reads

**Step 14a — Add `operativeSetpoint` parameter; replace `setpoint_c` reads:**

Update `estimateScenarioConsumption` signature to add `operativeSetpoint = 20`.

Replace ALL four reads of `thermalChar?.setpoint_c` / `thermalCharacter?.setpoint_c`:

| Location | Old | New |
|---|---|---|
| `simulatePostHocTIndoor` null-guard | `thermalChar?.setpoint_c == null` | Remove this condition (setpoint is always provided via param default) |
| `simulatePostHocTIndoor` T_init | `thermalCharacter?.setpoint_c ?? 20` | `operativeSetpoint ?? 20` |
| `simulateCurrentRcTrace` | `const sp = thermalChar?.setpoint_c` | `const sp = operativeSetpoint` |
| Overshoot check | `thermalCharacter?.setpoint_c` | `operativeSetpoint` |

Also update `simulateCurrentRcTrace`'s `sp == null` guard to remove it (always non-null).

**Flag — `underheat_ratio` / `demandScale`:** `thermalCharacter?.underheat_ratio` removed from m5.
The existing `ratio != null` guard already makes `demandScale = 1.0` safe. No code change needed
here — the "Heat to Comfort" slider becomes a no-op until m7-v2 adds the underheat diagnostic.
*(M3 — accepted interim; flagged for m7-v2.)*

**Step 14b — Wire `internal_gains_w` into the smart-scenario post-hoc RC trace:**

**Rename note:** `scenario-consumption.js` already reads `heatLoss.solar_aperture` (lines 183,
213 — confirmed). The m4-v2 rename `solar_aperture_m2 → solar_aperture` is **already done** in
shipping `heat-loss.js` (line 387). **No rename needed in this step.** Drop the rename sub-step.

In `simulatePostHocTIndoor`, replace the inline solar-aperture gain computation with consumption
of `thermalChar.internal_gains_w[i]`:

```javascript
// Old (inline solar only):
const aperture = (heatLoss?.solar_correction_applied && heatLoss?.solar_aperture != null)
  ? heatLoss.solar_aperture : 0;
// ...in loop:
const solarGainKwh = aperture * sw * 0.5 / 1000;
const dT = (q_delivered_per_hh[i] + solarGainKwh - lossKwh) * 3600 / C;

// New (full Q_gains from m5):
// Remove aperture declaration
// ...in loop:
const Q_gains_kwh = (thermalChar?.internal_gains_w?.[i] ?? 0) * 0.5 / 1000;
const dT = (q_delivered_per_hh[i] + Q_gains_kwh - lossKwh) * 3600 / C;
```

`simulateCurrentRcTrace` (the boiler-scenario trace) retains its inline solar computation
unchanged — this inconsistency is the accepted M3 interim until m7-v2 lands.

---

### Step 15 — `js/app.js`: call site + display

**Gated on m4-v2 `Status: Implemented`.** Once m4-v2 lands, apply these changes.

**Call site update (`runThermalCharacter` function):**

Remove:
```javascript
const wallConstruction = wallConstructionInput.value || null;
const tAtRestartRaw    = tAtRestartInput.value.trim();
let tAtRestart = null; if (tAtRestartRaw !== '') { ... }
```

**Do NOT add `setpointInput?.value` or `householdSizeInput?.value`** — these DOM elements do not
exist in the current app.js (confirmed: only `wallConstructionInput` and `tAtRestartInput` are
defined; Phase-4 UI scope). Pass defaults as literals:

```javascript
const operativeSetpoint = 20;    // D2 default — Phase-4 UI will replace with input
const householdSize     = 2;     // architecture-v2 registry default ~2–3; Phase-4 UI will replace
```

New call:
```javascript
result = estimateThermalCharacter(
  baseloadResult.heating,
  externalResult.external,
  heatLossResult,
  baseloadResult.supplementary_loads,
  baseloadResult.baseload_metadata,
  operativeSetpoint,
  householdSize,
  tauBucket,
);
```

Pass `operativeSetpoint` to `runScenarioConsumption` so m7 receives it:
```javascript
// Add to the estimateScenarioConsumption call in runScenarioConsumption:
operativeSetpoint,
```

**`displayThermalCharacterResults` update:**
- Remove `result.setpoint_c` display row (~line 1334–1336).
- Remove the `no_gas` status branch (~lines 1310–1316).
- Rename `result.occupancy_weights` → `result.heating_frequency_by_hh`; update label to "Heating
  pattern" (was "Occupancy model").
- Update `thermal_mass_source` label map:
  - Replace `measured_cold_soak: 'Measured from your heating data'` → `measured: 'Measured from your heating data'`
  - Drop `user_tau` rename (label already says 'Estimated from your description', keep as-is)

**Underheat display (`displayUnderheatPanel`, `setupHeatToComfortSlider`):**
Add a null-guard at entry: `if (!result.underheat_status) return;`. Panel silently hides until
m7-v2 implements the underheat diagnostic.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| m4-v2 not yet implemented; app.js integration blocked | Gate Step 15 on m4-v2 `Status: Implemented`. Steps 1–13 run with synthetic data. |
| Method A produces no events for continuously-heated homes (Rhiannon's use case) | By design — degenerate → fitA = null. TC6 covers this. |
| Method A τ-fit degenerate: exp(-t_off/τ) ≈ 1 when t_off ≪ τ, so m_i ≈ 0 → RSS flat → SE = ∞ | `curvature < 1e-12` → `se_tau = Infinity` → `relative_se = Infinity` → `> FIRE_THRESHOLD` → estimator doesn't fire. Correct. |
| Method B profile-LS: lower bound `maxC * 1.001` may be too tight if the true asymptote is only just above all C_est values | The duration-spread gate ensures varied soaks. Long soaks push C_est close to C_true so the bound is appropriate. If profileRss(A_hat) = Infinity → `degenerate_fit` returned. |
| `gas_baseload_w` derived from `baseload_median_kwh_per_day` — not a named m3 edge | Flagged in comment. If m3-v2 later adds a named `gas_baseload` field, update the derivation. |
| Bootstrap `Math.random()` non-deterministic — Method B CI bounds may vary run-to-run | TC4 asserts only the C asymptote (within ±15%), not the CI bounds. Bootstrap noise is expected. |
| `underheat_ratio` removed → `demandScale = 1.0` → "Heat to Comfort" slider is a no-op | Known interim regression; flagged for m7-v2. No action in this plan. |
| EV-cap window uses `timestamp.slice(11, 13)` — assumes ISO HH:MM format in all heating timestamps | All heating[] timestamps come from CSV ingestion in m1 which normalises to ISO format. Verify during TC2 test construction that synthetic timestamps satisfy this. |
| v1 test suites (test-m5.mjs, test-m5b.mjs) will fail after the signature change | Superseded test files. The new `test-m5-v2.mjs` covers all 14 §5 criteria. Retain the old files for reference; separate cleanup task (L4). |
| `setpointInput` / `householdSizeInput` don't exist in app.js | Confirmed above — Step 15 passes literals (20, 2). Phase-4 UI replaces with inputs when the DOM elements land. |

---

## Success criteria

- [ ] `node test-m5-v2.mjs` — all 14 test cases pass
- [ ] TC2: `|data_derived_tau_h - 16.67| / 16.67 < 0.15` (Method A recovers τ from RC-simulated data)
- [ ] TC3: τ with constant G offset ≈ τ without (within 1.5 h); intercept absorbs the offset
- [ ] TC4: `|thermal_mass_kj_per_k - 12000| / 12000 < 0.15` (Method B asymptote recovers C); `method = 'asymptote'`
- [ ] TC4b: `thermal_mass_kj_per_k = null`, `thermal_mass_fit_status = 'rejected_low_confidence'` (uniform-duration rejection)
- [ ] TC6: `C = null`, `validation_status = 'insufficient_data'`, `thermal_mass_fit_status = 'no_data'` for continuously-heated home
- [ ] TC8: `source = 'user_tau'` when dropdown set; data τ in `tau_bucket` / `data_derived_tau_h`
- [ ] Output contract has no `setpoint_c`, `setpoint_days_used`, `occupancy_weights`,
  `underheat_status`, `underheat_narrative`, `annual_modelled_demand_kwh`, `wall_construction` (TC1, TC12, TC13)
- [ ] `thermal_mass_fit_status` is always one of `'fired' | 'rejected_low_confidence' | 'no_data'` (never absent)
- [ ] `heating_frequency_by_hh` is a 48-element array; null < 14 non-absence days (TC9)
- [ ] `validation_status` never equals `'no_gas'` for any input (TC10)
- [ ] No `\.setpoint_c` references remaining in `scenario-consumption.js` (grep check)
- [ ] `internal_gains_w` is a non-null numeric array for all non-htcUsed-null inputs
- [ ] EV cap applied using hour-of-day from timestamp (not `i % 48`) — verify via TC2 or unit test
- [ ] Existing passing test suites (M3 v2, M6, M7, M8, M9) still pass after Steps 14–15
- [ ] No remaining references to `wall_construction`, `tAtRestartWinterC`, `measured_cold_soak`,
  `'no_gas'` (as validation_status), `underheat_narrative` in `thermal-character.js`

---

## Implementation Deviations

_None at plan time. Record D1, D2, … during implementation._

<!--
Status values (canonical):
- Awaiting review — Opus architect review pending.    (planner sets)
- ✅ Approved — yyyy-mm-dd. Implementation may begin.
- ⚠ Approved with edits — yyyy-mm-dd. Implementation may begin [once <prereq>].
- ⏸ Blocked — yyyy-mm-dd. See Design Review below; rewrite required.
- Implemented — yyyy-mm-dd, commit <hash>.            (implementer sets)
-->
