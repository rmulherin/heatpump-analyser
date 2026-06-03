# m3-baseload-v2 — M3 Baseload Separation v2 (the fork)

**Date:** 2026-06-04
**Status:** Awaiting review — Opus architect review pending.

> **Supersedes** the 2026-06-02 m3 plan (commit 51c67a8, on-hold, never approved).
> That plan covered only INV-9 + INV-16. This plan covers the full fork scope per
> `design/m3-baseload-v2.md` (commit a714d60, Rhiannon-agreed 2026-06-04):
> Steps I + J (electricity_baseload + per-HH attribution) + the updated fork outputs.

---

## Task description

Upgrade `js/baseload.js` (Module 3) from v1 to v2 per `design/m3-baseload-v2.md`. This makes M3 the **fork**: it emits per-HH `elec_heating_kwh` + `nonheat_residual_kwh` (Step J — new), the scalar `electricity_baseload` 24/7 floor (Step I — new), and the 3-tier `electric_heating_classification_auto/effective` with `user_classification_override` passthrough (INV-16). Step F.5 (low-gas-warm correction, INV-9) is inserted between Steps F and G. The 2% winter-non-heat detection floor (INV-16) is applied to the raw OLS slope before the detection gate. The deprecated `electric_heating_is_primary` field is removed. `baseline_kwh_per_day` is retained internally but no longer crosses to m4.

Existing v1 mechanics (Methods A–E, `detectAbsences`, `validateSeparation`, the `computeMultiOls` / `tDistPValue` math) are deferred to the working code per the design doc's top-note guardrail. Only the §10 Changes-from-v1 deltas are mandates.

---

## Research findings

All computation is vanilla JS with the existing Luxon import. No external libraries needed.

**`js/baseload.js` reviewed.** All v1 mechanics are implemented and deferred to:
- Methods A–E, `detectAbsences` (Step F), `validateSeparation` (Step G): working, no changes.
- `computeMultiOls` / `tDistPValue` / `betaCF` / `lgamma` / `incompleteBeta`: working, no changes.
- `detectSupplementaryLoads` OLS body (design matrix [HDD, CDD, 1], coefficient extraction): working, no changes.

The following **divergences from v2** exist in the live code. Each is a mandate:

- **Step H detection uses raw OLS slope `a`**, not the corrected slope. No `WINTER_NON_HEAT_FRACTION` correction is applied. Raw `a` drives detection gate, confidence tiers, and `electric_heating_kwh_per_dd` / `electric_heating_kwh_estimate`.
- **`electric_heating_is_primary`** (boolean) present in both the `skipped()` closure and the main return. V2 mandates removal.
- **Classification fields absent:** `electric_heating_classification_auto`, `electric_heating_classification_effective`, `electric_heating_fraction_of_total_energy`.
- **`BASELOAD_CONFIG` missing** four v2 constants: `LOW_GAS_WARM_MAX_GAS_KWH_FRACTION`, `LOW_GAS_WARM_MIN_DAILY_MEAN_TEMP_C`, `WINTER_NON_HEAT_FRACTION`, `ELECTRICITY_BASELOAD_PERCENTILE`.
- **Steps F.5, I, J absent.**
- **`separateBaseload`** lacks `user_classification_override` parameter and the two new `heating` array fields.

**`js/scenario-consumption.js` checked.** No `elec_heating_kwh`, no Step 1d. Step J is entirely new — no code to defer to.

**`app.js` (read during 2026-06-02 plan cycle):** `electric_heating_is_primary` is consumed at lines ~1082 and ~1090 in `displayBaseloadResults` (two conditional branches on which status message to show). `heat-loss.js` reads `supplementaryLoads.electric_heating_kwh_per_dd` for its Check 4D HTC correction — the field name is unchanged, but the value becomes the corrected slope in v2 (correct and intentional: a better estimate of real electric-heating signal).

**Test file structure:** `test-m3.mjs` has 18 passing v1 tests (CLAUDE.md reports M3 18/18). A separate `test-m3-step-f.mjs` tests Step F unit-level. V2 tests go in a new `test-m3-v2.mjs` following the same pattern.

**v1 test count note:** Design doc §5 references 22 v1 test criteria in `baseload-separation.md`; only 18 are in `test-m3.mjs`. The 4-test gap may be un-implemented v1 criteria. At implementation, read `test-m3.mjs` to confirm count and confirm all 18 still pass — do not add the missing 4 v1 tests (out of this plan's scope).

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/baseload.js` | Add v2 constants; add `applyLowGasWarmCorrection` (F.5), `computeElectricityBaseload` (I), `applyElectricHeatingAttribution` (J); update `detectSupplementaryLoads` for 2% correction + classification; update `separateBaseload` orchestrator |
| CREATE | `test-m3-v2.mjs` | 16 v2-specific test cases covering all §5 v2 criteria |
| MODIFY | `app.js` | Replace `electric_heating_is_primary` with `classification_effective` at lines ~1082, ~1090; update `separateBaseload` call signature; confirm `baseline_kwh_per_day` not wired to m4 |

---

## Implementation steps

### Step 1 — Add v2 constants to `BASELOAD_CONFIG` (`js/baseload.js`)

All four new constants live in `BASELOAD_CONFIG` (per design doc §2.5.4, §2.5.6, §2.5.8 — calibratable for future profile-robustness work):

```js
LOW_GAS_WARM_MAX_GAS_KWH_FRACTION: 2.2,
LOW_GAS_WARM_MIN_DAILY_MEAN_TEMP_C: 17,
WINTER_NON_HEAT_FRACTION: 0.02,
ELECTRICITY_BASELOAD_PERCENTILE: 5,
```

### Step 2 — Add `percentile` helper (`js/baseload.js`)

Add alongside `median()`. Linear interpolation on the sorted array:

```js
function percentile(arr, p) {
  const vals = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  const idx = (p / 100) * (vals.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? vals[lo] : vals[lo] + (idx - lo) * (vals[hi] - vals[lo]);
}
```

### Step 3 — Implement `applyLowGasWarmCorrection` (Step F.5) (`js/baseload.js`)

New exported function. Called from `separateBaseload` **after** `detectAbsences` (Step F) and **before** `validateSeparation` (Step G). Does NOT run in the no-gas branch.

```js
export function applyLowGasWarmCorrection(consumption, external, heating, baseloadMedianKwhPerDay) {
  const gasCeiling = BASELOAD_CONFIG.LOW_GAS_WARM_MAX_GAS_KWH_FRACTION * baseloadMedianKwhPerDay;
  const minTemp    = BASELOAD_CONFIG.LOW_GAS_WARM_MIN_DAILY_MEAN_TEMP_C;
  const dayIndexMap = buildDayIndexMap(consumption);
  let count = 0;

  for (const [, indices] of dayIndexMap) {
    if (indices.length !== 48) continue;
    if (indices.some(i => consumption[i].gas_kwh === null)) continue;
    if (indices.some(i => heating[i].is_absence)) continue;            // NOT absence
    const daily_gas_kwh = indices.reduce((s, i) => s + consumption[i].gas_kwh, 0);
    if (daily_gas_kwh >= gasCeiling) continue;                         // strict <
    const tempVals = indices.map(i => external?.[i]?.temp_c);
    if (tempVals.some(v => v === null || v === undefined)) continue;   // skip if temp unavailable
    const daily_mean_temp_c = tempVals.reduce((s, v) => s + v, 0) / 48;
    if (daily_mean_temp_c < minTemp) continue;                         // inclusive >=
    for (const i of indices) {
      heating[i].heating_kwh  = 0;
      heating[i].baseload_kwh = consumption[i].gas_kwh;               // is_absence unchanged (stays false)
    }
    count++;
  }
  return count;
}
```

Boundary semantics: strict `<` on gas (exclusive — protects heating-day boundaries); inclusive `>=` on temp (catches the exact-17.0 °C post-absence tank-refill case). Invariant preserved: `heating_kwh = 0`, `baseload_kwh = gas_kwh` → `sum = gas_kwh`.

### Step 4 — Implement `computeElectricityBaseload` (Step I) (`js/baseload.js`)

New exported function. Called from `separateBaseload` after `detectSupplementaryLoads`. Requires Step F to have run (uses `heating[i].is_absence`).

```js
export function computeElectricityBaseload(consumption, external, heating) {
  const dayIndexMap = buildDayIndexMap(consumption);
  const perHhValues = [];
  let daysUsed = 0;

  for (const [, indices] of dayIndexMap) {
    if (indices.length !== 48) continue;
    if (indices.some(i => consumption[i].elec_kwh === null || consumption[i].elec_kwh === undefined)) continue;
    if (indices.some(i => heating[i].is_absence)) continue;
    daysUsed++;
    for (const i of indices) perHhValues.push(consumption[i].elec_kwh);
  }

  if (daysUsed < STEP_H_CONFIG.MIN_DAYS) return null;
  return percentile(perHhValues, BASELOAD_CONFIG.ELECTRICITY_BASELOAD_PERCENTILE);
}
```

Returns null when < 30 qualifying days; m7 falls back to its trace-gains default.

### Step 5 — Implement `applyElectricHeatingAttribution` (Step J) (`js/baseload.js`)

New internal function (not exported — attribution tests go through `separateBaseload`). Called from `separateBaseload` after Steps H and I. Mutates `heating` array in-place.

`canAttribute` is day-level: true only for whole-elec days (all 48 HH non-null) where `classification_effective !== 'none'` and `corrected_kwh_per_dd` is available. All other days use per-HH fallback.

```js
function applyElectricHeatingAttribution(consumption, external, heating, electricityBaseload, supplementary_loads) {
  const classEff       = supplementary_loads.electric_heating_classification_effective;
  const correctedPerDd = supplementary_loads.electric_heating_kwh_per_dd;
  const floor          = electricityBaseload ?? 0;   // null → 0 (conservative: no floor protection)
  const dayIndexMap    = buildDayIndexMap(consumption);

  for (const [, indices] of dayIndexMap) {
    const allElecPresent = indices.length === 48
      && indices.every(i => consumption[i].elec_kwh !== null && consumption[i].elec_kwh !== undefined);
    const canAttribute = allElecPresent && classEff !== 'none' && correctedPerDd !== null;

    if (canAttribute) {
      const tempVals = indices.map(i => external?.[i]?.temp_c);
      const allTemps = tempVals.every(v => v !== null && v !== undefined);
      const meanTemp = allTemps ? tempVals.reduce((s, v) => s + v, 0) / 48 : null;
      const hdd      = meanTemp !== null ? Math.max(0, HDD_BASE_TEMP - meanTemp) : 0;
      const E_d      = Math.max(0, correctedPerDd * hdd);
      const excess   = indices.map(i => Math.max(0, consumption[i].elec_kwh - floor));
      const S        = excess.reduce((sum, e) => sum + e, 0);
      const r_d      = S > 0 ? Math.min(1, E_d / S) : 0;
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        heating[i].elec_heating_kwh     = r_d * excess[k];
        heating[i].nonheat_residual_kwh = consumption[i].elec_kwh - heating[i].elec_heating_kwh;
      }
    } else {
      for (const i of indices) {
        const elec = consumption[i].elec_kwh;
        if (elec === null || elec === undefined) {
          heating[i].elec_heating_kwh     = null;
          heating[i].nonheat_residual_kwh = null;
        } else {
          heating[i].elec_heating_kwh     = 0;
          heating[i].nonheat_residual_kwh = elec;
        }
      }
    }
  }
}
```

Three design-doc rules enforced:
- **Baseload protected:** `excess = max(0, elec − floor)` → heating never draws from the floor.
- **`total ≤ floor` → `excess = 0` → `elec_heating = 0`** regardless of regression estimate.
- **`E_d > S` → `r_d = 1`** → 100% of excess attributed to heating; regression excess above metered is discarded.

Partial-elec days (`canAttribute` false, fallback path): null HH → null/null; non-null HH → 0/total. Conservative — no heating attributed to partial-elec days (design doc specifies whole-day behaviour only).

### Step 6 — Update `detectSupplementaryLoads` for v2 mandates (`js/baseload.js`)

**6a — Signature:** Add `userClassificationOverride = null` as last parameter.

**6b — Update `skipped()` closure** (captures `userClassificationOverride` via closure scope). Remove `electric_heating_is_primary`. Add classification + fraction fields:

```js
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
    electricity_baseload: null,          // placeholder — overwritten by separateBaseload after Step I
    air_conditioning_detected: false, air_conditioning_kwh_per_dd: null,
    air_conditioning_kwh_estimate: null, air_conditioning_confidence: 'none',
    ac_detection_note: null,
    warnings: [], limitations: STEP_H_LIMITATIONS,
  };
}
```

**6c — Add `daily_gas_kwh` to the `dailyData` build loop:**
```js
const daily_gas_kwh = noGasCase ? 0 : indices.reduce((s, i) => s + consumption[i].gas_kwh, 0);
dailyData.push({ daily_elec_kwh: ..., daily_hdd: ..., daily_cdd: ..., daily_gas_kwh });
```
The existing `!noGasCase && gas_null` guard already ensures gas is non-null in the gas path.

**6d — After the OLS call, apply 2% correction:**
```js
const raw_estimate            = a * sum_hdd;
const total_annual_energy_kwh = dailyData.reduce((s, d) => s + d.daily_elec_kwh + d.daily_gas_kwh, 0);
const corrected_estimate      = Math.max(0, raw_estimate - BASELOAD_CONFIG.WINTER_NON_HEAT_FRACTION * total_annual_energy_kwh);
const corrected_kwh_per_dd    = sum_hdd > 0 ? corrected_estimate / sum_hdd : null;
const fraction_of_total       = total_annual_energy_kwh > 0 ? raw_estimate / total_annual_energy_kwh : 0;
```
`fraction_of_total` uses the **raw** estimate (signal magnitude for UI tickbox-default — §2.5.7).

**6e — Replace detection gate** (raw `a` → `corrected_kwh_per_dd`):
```js
const electric_heating_detected = corrected_kwh_per_dd !== null
  && corrected_kwh_per_dd > STEP_H_CONFIG.ELECTRIC_HEATING_COEFF_THRESHOLD
  && p_a < STEP_H_CONFIG.P_VALUE_DETECT
  && sum_hdd > 0;
```

**6f — Replace confidence tiers** (raw `a` → `corrected_kwh_per_dd`; thresholds unchanged):
```js
let electric_heating_confidence;
if (electric_heating_detected) {
  electric_heating_confidence =
    (corrected_kwh_per_dd >= STEP_H_CONFIG.COEFF_HIGH && p_a < STEP_H_CONFIG.P_VALUE_HIGH)
      ? 'high' : 'moderate';
} else {
  electric_heating_confidence =
    (corrected_kwh_per_dd !== null
     && corrected_kwh_per_dd > STEP_H_CONFIG.COEFF_LOW
     && p_a >= STEP_H_CONFIG.P_VALUE_DETECT
     && p_a < STEP_H_CONFIG.P_VALUE_LOW_UPPER)
      ? 'low' : 'none';
}
```

**6g — Compute 3-tier classification:**
```js
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

**6h — Updated return object.** Changed fields (all others unchanged):
```js
hdd_coefficient_kwh_per_dd: a,                                        // raw OLS — diagnostic
electric_heating_kwh_per_dd: electric_heating_detected ? corrected_kwh_per_dd : null,  // CORRECTED
electric_heating_kwh_estimate: electric_heating_detected ? corrected_estimate : null,   // CORRECTED
electric_heating_classification_auto: classification_auto,             // NEW
electric_heating_classification_effective: classification_effective,   // NEW
electric_heating_fraction_of_total_energy: fraction_of_total,         // NEW
electricity_baseload: null,   // placeholder — overwritten in separateBaseload
// REMOVED: electric_heating_is_primary
```

### Step 7 — Update `separateBaseload` orchestrator (`js/baseload.js`)

**7a — Signature:**
```js
export function separateBaseload(consumption, external, userClassificationOverride = null)
```

**7b — Extend initial `heating` array** with the two new v2 fields:
```js
const heating = consumption.map(rec => ({
  timestamp: rec.timestamp,
  heating_kwh: rec.gas_kwh === null ? null : 0,
  baseload_kwh: rec.gas_kwh === null ? null : 0,
  is_absence: false,
  elec_heating_kwh: null,       // populated by Step J
  nonheat_residual_kwh: null,   // populated by Step J
}));
```

**7c — No-gas branch.** After the existing `detectSupplementaryLoads` call:
- Pass `userClassificationOverride` as 5th argument.
- Add Steps I and J:
```js
const supplementary_loads = detectSupplementaryLoads(
  consumption, external, heating, baseload_metadata.method, userClassificationOverride
);
const electricity_baseload = computeElectricityBaseload(consumption, external, heating);
supplementary_loads.electricity_baseload = electricity_baseload;
applyElectricHeatingAttribution(consumption, external, heating, electricity_baseload, supplementary_loads);
return { heating, baseload_metadata, supplementary_loads };
```
Add `low_gas_warm_days_total: 0` to the no-gas `baseload_metadata` (F.5 does not run for no-gas).

**7d — Gas case — insert Step F.5** after `detectAbsences` return, before `validateSeparation` call:
```js
const low_gas_warm_days_total = applyLowGasWarmCorrection(
  consumption, external, heating, baseload_median_kwh_per_day
);
if (low_gas_warm_days_total > 30) {
  warnings.push(
    `Detected ${low_gas_warm_days_total} summer days where your gas use was below the ` +
    `heating-day threshold. These have been re-classified as non-heating to avoid ` +
    `mis-attributing your summer hot-water use as heating.`
  );
}
```
Add `low_gas_warm_days_total` to `baseload_metadata`.

**7e — Gas case — update `detectSupplementaryLoads` call** with `userClassificationOverride` as 5th argument.

**7f — Gas case — add Steps I and J** after `detectSupplementaryLoads`, same pattern as 7c.

### Step 8 — Update `app.js` call sites

**8a — `separateBaseload` call.** Locate the call (one in Octopus path, one in CSV path). Update to pass `userClassificationOverride` explicitly as `null` for now:
```js
separateBaseload(consumption, external, null)
```
The default is `null` so this is purely for explicitness; no behaviour change.

**8b — `electric_heating_is_primary` references** (lines ~1082, ~1090 in `displayBaseloadResults`). Replace both:

Line ~1082: `if (sl.electric_heating_detected && !sl.electric_heating_is_primary)` →
```js
if (sl.electric_heating_classification_effective === 'some')
```

Line ~1090: `} else if (sl.electric_heating_is_primary) {` →
```js
} else if (sl.electric_heating_classification_effective === 'all_electric') {
```

**8c — `baseline_kwh_per_day` → m4.** Grep for `baseline_kwh_per_day` in `app.js` and any m4 call. Confirm it is NOT passed to m4's inputs (§10 Deleted). If it is, remove that wiring. The field remains in `supplementary_loads` for internal use — do not remove from the object itself.

**8d — No new downstream wiring required** for Steps I / J fields in this plan. Those fields are emitted and available; the full m4-v2 / m7-v2 wiring belongs to those plans.

### Step 9 — Write `test-m3-v2.mjs`

Create `test-m3-v2.mjs` at the repo root. Follow the same Luxon stub pattern as `test-m3-step-f.mjs` (`global.luxon = { DateTime: FakeDateTime }`). Import `applyLowGasWarmCorrection`, `computeElectricityBaseload`, and `separateBaseload` from `./js/baseload.js`.

**Test helper functions:**
- `makeDay(dateStr, gasKwhPerHh, elecKwhPerHh)` — 48 UTC HH records for one day
- `makeExternal(count, tempC)` — `[{ temp_c: tempC }]` × count
- `makeHeating(consumption, heatingFraction)` — parallel array `{timestamp, heating_kwh, baseload_kwh, is_absence: false}`
- `buildDataset(n, hddFn, elecFn, gasFn)` — n days of consumption + external + heating for Step H tests

**TC-F5-1 — must-classify:** One day, gas = 10 kWh/day (below 2.2 × 6.18 = 13.596), temp = 19°C. Call `applyLowGasWarmCorrection(..., 6.18)`. Assert: return = 1; all `heating[i].heating_kwh === 0`; all `heating[i].baseload_kwh ≈ 10/48`; `is_absence === false`.

**TC-F5-2 — must-NOT-classify (temp below 17°C):** Gas = 10 kWh/day, temp = 13.3°C. Assert: return = 0; `heating_kwh` unchanged.

**TC-F5-3 — must-NOT-classify (gas above ceiling):** Gas = 14 kWh/day (above 13.596), temp = 19°C. Assert: return = 0.

**TC-F5-4 — must-NOT-classify (absence day):** Gas = 10 kWh/day, temp = 19°C, `heating[i].is_absence = true`. Assert: return = 0.

**TC-F5-5 — boundary (exact ceiling):** Gas = 13.596 kWh/day, temp = 19°C → NOT classified (strict `<`). Gas = 13.595 kWh/day, temp = 17.0°C → classified. Gas = 13.595 kWh/day, temp = 16.9°C → NOT classified.

**TC-F5-6 — heating+baseload invariant:** Classified day: `heating[i].heating_kwh + heating[i].baseload_kwh === consumption[i].gas_kwh` for all 48 HH (within 1e-10 tolerance).

**TC-F5-7 — is_absence not set:** All records on a classified day have `is_absence === false`.

**TC-H-1 — Rhiannon-like → `classification_auto = 'none'`:** Build ~200 days: `daily_elec ≈ 8 + 0.33 × HDD`, `daily_gas ≈ 50 + 2 × HDD`, `sum_hdd ≈ 1400`, `total_annual_energy ≈ 15000`. Expected: `raw ≈ 462`, `corrected = max(0, 462 − 300) = 162`, `corrected_per_dd ≈ 0.116` → fails 0.2 gate. Assert: `electric_heating_detected === false`; `classification_auto === 'none'`; `classification_effective === 'none'`. **Critical guard** — without 2% correction, raw 0.33 > 0.2 would fire.

**TC-H-2 — clear-positive → `classification_auto = 'some'`:** 200 days: `daily_elec ≈ 8 + 0.6 × HDD`, `total ≈ 10000`, `sum_hdd ≈ 1200`. Raw ≈ 720, corrected ≈ 520, `corrected_per_dd ≈ 0.43`. Assert: `detected === true`; `classification_auto === 'some'`; `electric_heating_kwh_per_dd ≈ 0.43` (corrected); `hdd_coefficient_kwh_per_dd ≈ 0.6` (raw); `electric_heating_fraction_of_total_energy ≈ 0.072` (raw / total).

**TC-H-3 — all-electric → `classification_auto = 'all_electric'`:** 200 all-electric days (gas = null): `daily_elec ≈ 12 + 1.5 × HDD`. Call with `baseloadMethod = 'no-gas'`. Assert: `detected === true`; `classification_auto === 'all_electric'`; `classification_effective === 'all_electric'`.

**TC-H-4 — user override wins (three cases):** TC-H-2 data (auto = 'some'):
- Override `'none'` → `effective === 'none'`
- Override `'all_electric'` → `effective === 'all_electric'`
- Override `null` → `effective === 'some'`

**TC-H-5 — deprecated field absent:** Any valid call: assert `!('electric_heating_is_primary' in result)`.

**TC-I-1 — 5th-pct floor:** Synthetic per-HH elec: flat 0.1 kWh/HH overnight + variable daytime 0.1–1.0 kWh/HH, 60 non-absence days. Call `computeElectricityBaseload`. Assert: `electricity_baseload ≈ 0.1` (within 0.02 — the quiet floor, not the mean ~0.4).

**TC-I-2 — EV does not inflate baseload:** Same base as TC-I-1; inject 7 kWh overnight EV on ~30% of nights (one HH slot). Assert: `electricity_baseload` unchanged within 0.01 kWh/HH vs without EV.

**TC-J-1 — proportional shape + invariant:** Via `separateBaseload` on a synthetic dataset (detection = 'some', known `corrected_kwh_per_dd`). For a day with known `E_d` and varied per-HH excess: assert `elec_heating_kwh[hh] = r_d × excess[hh]`; `Σ elec_heating ≈ E_d` (when `r_d < 1`); for every HH: `elec_heating_kwh + nonheat_residual_kwh === elec_kwh` (exact); `0 ≤ elec_heating_kwh ≤ elec_kwh`.

**TC-J-2 — baseload protected:** HH where `total_elec ≤ electricity_baseload` → `elec_heating_kwh === 0`.

**TC-J-3 — excess-capped (r_d = 1):** Cold day where `E_d > Σ excess` → `r_d === 1`; each HH: `elec_heating_kwh = excess[hh]`; `nonheat_residual_kwh = min(total_elec, floor)`.

**TC-J-4 — classification 'none':** `classification_effective = 'none'` (via user override). All HH: `elec_heating_kwh === 0`; `nonheat_residual_kwh === elec_kwh`.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| v1 Step H tests may assert detection with raw slope; corrected slope changes gate outcomes | At Step 9 start, read `test-m3.mjs` — confirm no v1 test uses a near-threshold (0.2 kWh/K·day) electric heating signal. The 2% correction only changes detection when `corrected_per_dd` crosses 0.2; strong signals (0.6+) remain detected. If any v1 test fails, update assertion to corrected value and document as deviation. |
| `applyElectricHeatingAttribution` runs after Step F; `is_absence` must be set first | Enforced by orchestrator order: F → F.5 → G → H → I → J. `canAttribute` guard prevents attribution when classification is unavailable. |
| `electricity_baseload = null` when < 30 qualifying days; Step J uses `floor ?? 0` | `floor = 0` means excess = full elec_kwh — conservative over-attribution. Acceptable: the 30-day guard matches Step H's, and null is the signal for m7 to fall back on its own default. |
| `app.js` line numbers may have shifted since 2026-06-02 | Step 8b greps for `electric_heating_is_primary` before editing; exact line numbers are not relied upon. |
| `heat-loss.js` Check 4D reads `electric_heating_kwh_per_dd` — value changes (raw → corrected) | Intentional and correct: corrected slope is a better estimate. In Rhiannon's gas-primary data, detection becomes `false` so Check 4D does not run at all. |
| Partial-elec days get fallback (0/total) not per-day attribution | Acceptable: design doc specifies whole-day behaviour; partial days are a meter gap, not a new calculation path. |
| `separateBaseload` new parameter is a breaking change for `app.js` callers | Mitigated: parameter defaults to `null` — existing calls with two arguments are unchanged. Step 8a makes the null explicit for clarity. |

---

## Success criteria

- [ ] `node test-m3.mjs` exits 0 — all 18 v1 tests still pass (no regressions)
- [ ] `node test-m3-v2.mjs` exits 0 — all 16 v2 tests pass
- [ ] `node test-m3-step-f.mjs` exits 0 — unaffected
- [ ] TC-H-1: `electric_heating_detected === false` on Rhiannon-like data (critical INV-16 guard)
- [ ] TC-H-5: `electric_heating_is_primary` absent from all return paths
- [ ] Gas invariant: `heating_kwh + baseload_kwh === gas_kwh` for all non-null gas records, including F.5-corrected days
- [ ] Elec invariant: `elec_heating_kwh + nonheat_residual_kwh === elec_kwh` for all non-null elec records
- [ ] `electricity_baseload` non-null in `supplementary_loads` when ≥ 30 qualifying elec days available
- [ ] `electric_heating_classification_auto`, `_effective`, `electric_heating_fraction_of_total_energy` present on all return paths (gas, no-gas, skipped branches)
- [ ] `app.js`: `separateBaseload` call updated; no `electric_heating_is_primary` references in codebase; `baseline_kwh_per_day` not passed to m4
- [ ] Other test suites unaffected: M5 39/39, M5b 29/29, M6 24/24, M7 39/39, M8 24/24, M9 24/24

---

## Implementation Deviations

None (plan phase).

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
