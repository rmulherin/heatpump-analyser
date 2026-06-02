# m3-baseload-v2 — Baseload Separation v2 (Step F.5 + Step H classification)

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the two focused v2 refinements to `js/baseload.js` defined in
`m3-baseload-v2.md`:

1. **Step F.5 — Low-gas-warm correction.** A new day-level pre-classifier
   inserted between Step F (absence detection) and Step G (R² validation). Days
   with gas use below `2.2 × baseload_median` AND mean outdoor temperature ≥ 17 °C
   have their per-HH `heating_kwh` forced to 0 (`baseload_kwh = gas_kwh`). Fixes
   the INV-9 phantom-heating failure mode on multi-modal summer baseload days.

2. **Step H — 2% winter-non-heat correction + 3-tier classification output.**
   After the OLS regression, subtract `2% × total_annual_energy_kwh` from the raw
   electric-heating estimate before applying the 0.2 kWh/K·day detection gate.
   Adds `electric_heating_classification_auto`, `electric_heating_classification_effective`,
   and `electric_heating_fraction_of_total_energy` to the `supplementary_loads`
   output. Accepts `user_classification_override` passthrough. Removes the
   deprecated `electric_heating_is_primary` field. Updates `app.js` display
   logic to consume the new classification field.

---

## Research findings

**Existing code reviewed:**

- `js/baseload.js` — full module. The orchestrator is `separateBaseload(consumption, external)`.
  Pipeline order: Method A/B/C/D/E → 4c (baseload mean/median) → 4b `detectAbsences`
  → 4d `validateSeparation` → `detectSupplementaryLoads`. Step F.5 inserts between
  `detectAbsences` and `validateSeparation`.

- `BASELOAD_CONFIG` object holds Method A/B/C thresholds and absence constants.
  `STEP_H_CONFIG` object holds Step H thresholds. Both are the correct home for
  the three new constants.

- `detectSupplementaryLoads(consumption, external, heating, baseloadMethod)` —
  builds `dailyData` rows of `{daily_elec_kwh, daily_hdd, daily_cdd}`. OLS runs
  on `ys` (elec) and `xMatrix` ([HDD, CDD, 1]). Detection is currently on raw `a`
  (HDD slope). In v2: add `daily_gas_kwh` to each `dailyData` entry, compute
  `total_annual_energy_kwh`, apply 2% subtraction, then gate on the corrected
  slope.

- `electric_heating_is_primary` is consumed by `app.js` lines 1082 and 1090
  (display logic — which status message to show). It is NOT consumed by
  `heat-loss.js` (which reads `electric_heating_detected`,
  `electric_heating_confidence`, and `electric_heating_kwh_per_dd`). The app.js
  usage is a clean two-line migration to `electric_heating_classification_effective`.

- `heat-loss.js` reads `supplementaryLoads.electric_heating_kwh_per_dd` for its
  Check 4D HTC correction. In v2 this field becomes the corrected slope (lower
  than raw). This is intentional and correct — the corrected slope is a better
  estimate of real electric-heating signal. No compatibility concern.

- `test-m3-step-f.mjs` exports `detectAbsences` for unit testing and uses a
  minimal Luxon stub (`global.luxon = { DateTime: FakeDateTime }`). The new
  `test-m3-v2.mjs` follows the same pattern.

**No external libraries needed.** All changes are pure vanilla JS within the
existing module pattern.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/baseload.js` | Add Step F.5 function; update Step H; update outputs; update signatures |
| MODIFY | `js/app.js` | Replace `electric_heating_is_primary` with `electric_heating_classification_effective` at lines ~1082 and ~1090 |
| CREATE | `test-m3-v2.mjs` | 13 v2-specific test cases (Step F.5 + Step H) |

---

## Implementation steps

### Step 1 — Add new constants

In `BASELOAD_CONFIG`, add after `EXCESSIVE_ABSENCE_DAYS`:

```javascript
LOW_GAS_WARM_MAX_GAS_KWH_FRACTION: 2.2,
LOW_GAS_WARM_MIN_DAILY_MEAN_TEMP_C: 17,
```

In `STEP_H_CONFIG`, add:

```javascript
WINTER_NON_HEAT_FRACTION: 0.02,
```

### Step 2 — Implement `applyLowGasWarmCorrection` and export it

Add a new exported function immediately before `separateBaseload`:

```javascript
export function applyLowGasWarmCorrection(consumption, external, heating, baseloadMedianKwhPerDay) {
  const gasThreshold = BASELOAD_CONFIG.LOW_GAS_WARM_MAX_GAS_KWH_FRACTION * baseloadMedianKwhPerDay;
  const tempFloor    = BASELOAD_CONFIG.LOW_GAS_WARM_MIN_DAILY_MEAN_TEMP_C;
  const dayIndexMap  = buildDayIndexMap(consumption);
  let count = 0;

  for (const [, indices] of dayIndexMap) {
    if (indices.length !== 48) continue;
    if (indices.some(i => consumption[i].gas_kwh === null || consumption[i].gas_kwh === undefined)) continue;
    if (indices.some(i => heating[i].is_absence)) continue;

    const dailyGas = indices.reduce((s, i) => s + consumption[i].gas_kwh, 0);
    if (dailyGas >= gasThreshold) continue;                          // strict <

    const tempVals = indices.map(i => external?.[i]?.temp_c).filter(v => v !== null && v !== undefined);
    if (tempVals.length < 48) continue;
    const dailyMeanTemp = tempVals.reduce((s, v) => s + v, 0) / tempVals.length;
    if (dailyMeanTemp < tempFloor) continue;                         // inclusive >=

    for (const i of indices) {
      heating[i].heating_kwh   = 0;
      heating[i].baseload_kwh  = consumption[i].gas_kwh;
    }
    count++;
  }

  return count;
}
```

Boundary semantics match the design doc exactly: strict `<` on gas (exclusive
upper bound protects genuine cold-but-low-gas heating days); inclusive `>=` on
temp (catches the 31-Aug exact-17.0 °C post-absence refill case).

### Step 3 — Wire Step F.5 into `separateBaseload`

Update `separateBaseload` signature to accept `userClassificationOverride = null`
(passed through to `detectSupplementaryLoads` in Step 5).

In the gas path, after the `detectAbsences` call and before `validateSeparation`:

```javascript
const lowGasWarmDaysTotal = applyLowGasWarmCorrection(
  consumption, external, heating, baseload_median_kwh_per_day
);

if (lowGasWarmDaysTotal > 30) {
  warnings.push(
    `Detected ${lowGasWarmDaysTotal} summer days where your gas use was below the ` +
    `heating-day threshold. These have been re-classified as non-heating to avoid ` +
    `mis-attributing your summer hot-water use as heating.`
  );
}
```

Add `low_gas_warm_days_total: lowGasWarmDaysTotal` to `baseload_metadata`.

The no-gas case short-circuits before this point and is unaffected.

### Step 4 — Update `detectSupplementaryLoads` signature

Change signature from:

```javascript
export function detectSupplementaryLoads(consumption, external, heating, baseloadMethod)
```

to:

```javascript
export function detectSupplementaryLoads(consumption, external, heating, baseloadMethod, userClassificationOverride = null)
```

### Step 5 — Add `daily_gas_kwh` to `dailyData` entries

In the `dailyData` build loop, compute and store `daily_gas_kwh` alongside
`daily_elec_kwh`. In the no-gas case, gas is null so treat as 0:

```javascript
const daily_gas_kwh = noGasCase
  ? 0
  : indices.reduce((s, i) => s + consumption[i].gas_kwh, 0);

dailyData.push({
  daily_elec_kwh: indices.reduce((s, i) => s + consumption[i].elec_kwh, 0),
  daily_hdd: Math.max(0, HDD_BASE_TEMP - daily_mean_temp_c),
  daily_cdd: Math.max(0, daily_mean_temp_c - CDD_BASE_TEMP),
  daily_gas_kwh,
});
```

Note: the existing guard `if (!noGasCase && indices.some(i => consumption[i].gas_kwh === null ...)) continue;`
ensures gas is non-null before this accumulation in the non-no-gas path.

### Step 6 — Compute 2% correction after OLS

After the OLS block that sets `a`, `b`, `c`, `p_a`, `p_b`, `sum_hdd`, `sum_cdd`:

```javascript
const raw_estimate             = a * sum_hdd;
const total_annual_energy_kwh  = dailyData.reduce((s, d) => s + d.daily_elec_kwh + d.daily_gas_kwh, 0);
const corrected_estimate       = Math.max(0, raw_estimate - STEP_H_CONFIG.WINTER_NON_HEAT_FRACTION * total_annual_energy_kwh);
const corrected_kwh_per_dd     = sum_hdd > 0 ? corrected_estimate / sum_hdd : null;
const fraction_of_total_energy = total_annual_energy_kwh > 0 ? raw_estimate / total_annual_energy_kwh : 0;
```

`raw_estimate` uses the uncorrected slope for `fraction_of_total_energy` (per design
§4.4 — the raw fraction is the UI tickbox-default signal). `corrected_estimate` and
`corrected_kwh_per_dd` gate detection.

### Step 7 — Update detection rule to use corrected slope

Replace the current line:

```javascript
const electric_heating_detected = a > STEP_H_CONFIG.ELECTRIC_HEATING_COEFF_THRESHOLD && p_a < STEP_H_CONFIG.P_VALUE_DETECT;
```

with:

```javascript
const electric_heating_detected =
  corrected_kwh_per_dd !== null &&
  corrected_kwh_per_dd > STEP_H_CONFIG.ELECTRIC_HEATING_COEFF_THRESHOLD &&
  p_a < STEP_H_CONFIG.P_VALUE_DETECT &&
  sum_hdd > 0;
```

### Step 8 — Update confidence tiers to use corrected slope

Replace the current confidence logic (which gates on raw `a`) with corrected
slope gates. The thresholds are unchanged (0.5 / 0.1; 0.01 / 0.20) — applied
to `corrected_kwh_per_dd`:

```javascript
let electric_heating_confidence;
if (electric_heating_detected) {
  electric_heating_confidence =
    (corrected_kwh_per_dd >= STEP_H_CONFIG.COEFF_HIGH && p_a < STEP_H_CONFIG.P_VALUE_HIGH)
      ? 'high' : 'moderate';
} else {
  electric_heating_confidence =
    (corrected_kwh_per_dd !== null &&
     corrected_kwh_per_dd > STEP_H_CONFIG.COEFF_LOW &&
     p_a >= STEP_H_CONFIG.P_VALUE_DETECT &&
     p_a < STEP_H_CONFIG.P_VALUE_LOW_UPPER)
      ? 'low' : 'none';
}
```

### Step 9 — Add classification logic

After the confidence block, add:

```javascript
let classification_auto;
if (noGasCase && electric_heating_detected) {
  classification_auto = 'all_electric';
} else if (electric_heating_detected) {
  classification_auto = 'some';
} else {
  classification_auto = 'none';
}
const classification_effective = userClassificationOverride ?? classification_auto;
```

### Step 10 — Update `skipped()` helper

The `skipped()` inner function currently returns `electric_heating_is_primary: false`.
Replace it with the new fields and omit the deprecated field:

```javascript
function skipped(method, days_used_in_fit) {
  return {
    method, days_used_in_fit,
    baseline_kwh_per_day: null,
    hdd_coefficient_kwh_per_dd: null, cdd_coefficient_kwh_per_dd: null,
    hdd_p_value: null, cdd_p_value: null,
    sum_hdd_k_day: null, sum_cdd_k_day: null,
    electric_heating_detected: false,
    electric_heating_kwh_per_dd: null,
    electric_heating_kwh_estimate: null,
    electric_heating_confidence: 'none',
    electric_heating_classification_auto: 'none',
    electric_heating_classification_effective: userClassificationOverride ?? 'none',
    electric_heating_fraction_of_total_energy: 0,
    air_conditioning_detected: false, air_conditioning_kwh_per_dd: null,
    air_conditioning_kwh_estimate: null, air_conditioning_confidence: 'none',
    ac_detection_note: null,
    warnings: [], limitations: STEP_H_LIMITATIONS,
  };
}
```

### Step 11 — Update the main return value of `detectSupplementaryLoads`

Replace the existing return object with the v2 shape:

```javascript
return {
  method: 'regression',
  days_used_in_fit: dailyData.length,
  baseline_kwh_per_day: c,
  hdd_coefficient_kwh_per_dd: a,          // raw slope — diagnostic only
  cdd_coefficient_kwh_per_dd: b,
  hdd_p_value: p_a,
  cdd_p_value: p_b,
  sum_hdd_k_day: sum_hdd,
  sum_cdd_k_day: sum_cdd,
  electric_heating_detected,
  electric_heating_kwh_per_dd: electric_heating_detected ? corrected_kwh_per_dd : null,  // corrected
  electric_heating_kwh_estimate: electric_heating_detected ? corrected_estimate : null,   // corrected
  electric_heating_confidence,
  electric_heating_classification_auto: classification_auto,
  electric_heating_classification_effective: classification_effective,
  electric_heating_fraction_of_total_energy: fraction_of_total_energy,
  air_conditioning_detected,
  air_conditioning_kwh_per_dd,
  air_conditioning_kwh_estimate,
  air_conditioning_confidence,
  ac_detection_note,
  warnings: [],
  limitations: STEP_H_LIMITATIONS,
};
```

Note: `electric_heating_is_primary` is **not** in this return — it is removed.
`hdd_coefficient_kwh_per_dd` retains the raw slope (for diagnostic consumers
that want the uncorrected OLS output).

### Step 12 — Update `separateBaseload` to pass override to `detectSupplementaryLoads`

In `separateBaseload`, update both call sites of `detectSupplementaryLoads`:

```javascript
// No-gas path:
const supplementary_loads = detectSupplementaryLoads(
  consumption, external, heating, baseload_metadata.method, userClassificationOverride
);

// Gas path:
const supplementary_loads = detectSupplementaryLoads(
  consumption, external, heating, baseload_metadata.method, userClassificationOverride
);
```

### Step 13 — Update `app.js` display logic

At `displayBaseloadResults` (the function containing the affected lines), replace
the two `electric_heating_is_primary` references:

**Line ~1082:** Replace:
```javascript
if (sl.electric_heating_detected && !sl.electric_heating_is_primary) {
```
with:
```javascript
if (sl.electric_heating_classification_effective === 'some') {
```

**Line ~1090:** Replace:
```javascript
} else if (sl.electric_heating_is_primary) {
```
with:
```javascript
} else if (sl.electric_heating_classification_effective === 'all_electric') {
```

Note: the `electric_heating_detected` check in the original condition is now
subsumed by `classification_effective === 'some'` (which requires detection).

### Step 14 — Write `test-m3-v2.mjs`

Create `test-m3-v2.mjs` at the repo root. Use the same Luxon stub pattern as
`test-m3-step-f.mjs`. Import `applyLowGasWarmCorrection` and
`detectSupplementaryLoads` from `./js/baseload.js`.

Helper functions needed:
- `makeDay(dateStr, gasKwhPerHh, elecKwhPerHh = 0.5)` — 48 HH records for one UTC day
- `makeExternal(count, tempC)` — array of `{ temp_c: tempC }`, length `count`
- `makeHeating(consumption, heatingFraction = 0.5)` — parallel array with
  `{timestamp, heating_kwh, baseload_kwh, is_absence: false}`
- `makeDailyDataForStepH(n, slope_hdd, intercept, gas_per_day, hdd_per_day)`
  — builds `consumption`, `external`, `heating` arrays for `n` non-absence days
  with the given parameters (for Step H unit tests)

**TC-F5-1 — must-classify (warm summer day, gas below threshold):**

Build one day: gas = 10/48 kWh/HH (10 kWh/day, threshold = 2.2 × 6.18 = 13.596 kWh/day),
mean temp = 19 °C. Heating pre-populated with non-zero values. Call
`applyLowGasWarmCorrection(consumption, external, heating, 6.18)`.
Assert: return value = 1; all `heating[i].heating_kwh === 0`; all
`heating[i].baseload_kwh ≈ 10/48`; `heating[i].is_absence === false` for all.

**TC-F5-2 — must-NOT-classify (temp below 17 °C):**

Same gas (10 kWh/day) but mean temp = 13.3 °C. Assert return value = 0;
`heating_kwh` unchanged from input.

**TC-F5-3 — must-NOT-classify (gas above threshold):**

Gas = 14/48 kWh/HH (14 kWh/day, above 13.596 threshold), temp = 19 °C.
Assert return value = 0.

**TC-F5-4 — must-NOT-classify (absence day):**

Gas = 10 kWh/day, temp = 19 °C, but `heating[i].is_absence = true` for all
48 records. Assert return value = 0.

**TC-F5-5 — boundary (gas exactly at threshold):**

Gas = 13.60/48 kWh/HH (13.60 kWh/day = exact threshold), temp = 19 °C.
Assert return value = 0 (strict `<` fails at exact equality).

Gas = 13.59/48 kWh/HH (13.59 kWh/day, just below threshold), temp = 17.0 °C
(exactly at floor), temp = 16.9 °C (below floor). Assert:
- 13.59 + 17.0 → classified (return = 1)
- 13.59 + 16.9 → NOT classified (return = 0)

**TC-F5-6 — heating+baseload invariant preserved:**

Classified day: assert `heating[i].heating_kwh + heating[i].baseload_kwh`
equals `consumption[i].gas_kwh` (within floating-point tolerance 1e-10) for
every HH record.

**TC-F5-7 — is_absence not set by F.5:**

Assert `heating[i].is_absence === false` for all records on a classified day
(Step F.5 must not flip absence — the day should still enter Step G regression).

**TC-H-1 — Rhiannon-like case → classification_auto = 'none':**

Build `dailyData`-equivalent consumption/external/heating for ~200 days with:
`daily_elec = 8 + 0.33 × HDD + small_noise`, `daily_gas = 50 + 2 × HDD`,
such that `sum_hdd ≈ 1400`, `total_annual_energy_kwh ≈ 15000`, raw_estimate
≈ 462 kWh, corrected_estimate = max(0, 462 − 300) = 162 kWh,
corrected_kwh_per_dd ≈ 0.116 → fails 0.2 gate.

Call `detectSupplementaryLoads(consumption, external, heating, 'summer-hh-profile-weekday-split')`.
Assert: `electric_heating_detected === false`;
`electric_heating_classification_auto === 'none'`;
`electric_heating_classification_effective === 'none'` (no override).

**TC-H-2 — clear-positive synthetic → classification_auto = 'some':**

Build 200 days with `daily_elec = 8 + 0.6 × HDD + noise`, `daily_gas` non-zero,
`total_annual_energy_kwh ≈ 10000`, `sum_hdd ≈ 1200`.
Expected: raw_estimate ≈ 720, corrected_estimate = max(0, 720 − 200) = 520,
corrected_kwh_per_dd ≈ 0.43 → passes 0.2 gate.
Assert: `electric_heating_detected === true`;
`electric_heating_classification_auto === 'some'`;
`electric_heating_kwh_per_dd ≈ 0.43` (corrected, not raw 0.6);
`electric_heating_kwh_estimate ≈ 520` (corrected).

**TC-H-3 — fraction_of_total_energy uses raw estimate:**

Using TC-H-2 data: assert `electric_heating_fraction_of_total_energy ≈ 720 / 10000 = 0.072`
(within 0.005). Fraction uses raw (uncorrected) estimate.

**TC-H-4 — all_electric on no-gas household:**

Build 200 all-electric days (all `gas_kwh = null`): `daily_elec = 12 + 1.5 × HDD + noise`.
Call `detectSupplementaryLoads(consumption, external, heating, 'no-gas')`.
Assert: `electric_heating_detected === true`;
`electric_heating_classification_auto === 'all_electric'`;
`electric_heating_classification_effective === 'all_electric'`.

**TC-H-5 — user override wins:**

Using TC-H-2 setup (auto = 'some'), call with three override values:
- `userClassificationOverride = 'none'` → assert `classification_effective === 'none'`
- `userClassificationOverride = 'all_electric'` → assert `classification_effective === 'all_electric'`
- `userClassificationOverride = null` → assert `classification_effective === 'some'`

**TC-H-6 — confidence tier = 'high' for corrected slope ≥ 0.5:**

Build data so corrected_kwh_per_dd ≈ 0.55, p_a < 0.01.
Assert `electric_heating_confidence === 'high'`.

**TC-H-7 — confidence tier = 'moderate' for corrected slope 0.2–0.5:**

Build data so corrected_kwh_per_dd ≈ 0.35, p_a < 0.05.
Assert `electric_heating_confidence === 'moderate'`.

**TC-H-8 — deprecated field absent:**

Using any valid call, assert `'electric_heating_is_primary' in result === false`.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `heat-loss.js` Check 4D reads `electric_heating_kwh_per_dd` — value changes from raw to corrected slope | Intentional: corrected slope is a better estimate. In Rhiannon's data `electric_heating_detected` becomes `false` so Check 4D won't run at all. For genuine electric heating, corrected slope is still correct. No behavioural regression. |
| Removing `electric_heating_is_primary` breaks `app.js` display | Mitigated by Step 13: update both references to `classification_effective` in the same plan. |
| `buildDayIndexMap` is not exported — unit tests call `applyLowGasWarmCorrection` which uses it internally | No issue: `applyLowGasWarmCorrection` is defined in the same module file as `buildDayIndexMap`. The export makes the function callable from tests; the internal helper is resolved at import time. |
| Synthetic Step H test data producing exact OLS coefficients requires careful construction | Accepted complexity: use high-count (200 days), deterministic data without randomness (noise = 0 or very small fixed delta per day); p-values will be near zero for clear signals. If OLS produces boundary p-values, adjust slope magnitude. |
| `separateBaseload` new parameter `userClassificationOverride` is a breaking change for current callers in `app.js` | Mitigated: parameter defaults to `null` — existing `app.js` calls `separateBaseload(consumption, external)` without a third argument and get the existing auto-detect behaviour unchanged. |

---

## Success criteria

- [ ] `node test-m3-v2.mjs` exits 0 with all 13 tests passing
- [ ] `node test-m3-step-f.mjs` still exits 0 — v1 Step F tests unaffected
- [ ] `node test-m6.mjs` still exits 0 — no regressions in other modules
- [ ] For a dataset matching Rhiannon's calibrated values: `electric_heating_classification_auto === 'none'` and `electric_heating_detected === false` (TC-H-1 confirmation)
- [ ] `baseload_metadata.low_gas_warm_days_total` is present and ≥ 0 in all return paths
- [ ] `electric_heating_is_primary` field is absent from `detectSupplementaryLoads` return value
- [ ] `electric_heating_classification_auto`, `electric_heating_classification_effective`, and `electric_heating_fraction_of_total_energy` present on all return paths (including `skipped()` branches)
- [ ] `separateBaseload` accepts `userClassificationOverride = null` and passes it through; existing callers with no third argument are unaffected

---

## Implementation Deviations

None. (Populate after implementation.)

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
