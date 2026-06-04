# M4 Heat Loss — v2 implementation

**Date:** 2026-06-04
**Status:** ✅ Implemented — 2026-06-04. Commit `8d7e72e`.

---

## Task description

Re-implement `js/heat-loss.js` (Module 4) from v1 to v2 per `m4-heat-loss-v2.md` (commit 35c98a0,
2026-06-04). The load-bearing changes are: (1) combined-fuel Siviour LHS (`gas×η + elec×1.0` — one
source-blind fit for all household types, replacing v1's gas-only / no-gas-early-return / Check-4D
branches); (2) the η-move (η leaves HTC recovery, enters LHS — gas-only HTC provably unchanged);
(3) mint per-HH `thermal_heat_delivered_kwh` (m5/m7 consume; full series including absence periods);
(4) ±20%-bounded HTC rescale → `htc_used` (m7 feedback edge, dormant first pass: `htc_used = htc`);
(5) removal of Check 4D, no-gas short-circuit, net_flow/internal_gains, floor_area/HLP outputs;
(6) boiler efficiency converted from a free-form number input to the INV-12 4-tier dropdown (0.92 /
0.85 default / 0.70 / 0.60). Create `test-m4-v2.mjs` from scratch (no prior M4 committed test
suite). Update `index.html` and `js/app.js` to match the new signature and output contract.

**Prerequisite gate:** m3-v2 must be implemented and verified (plan Status `Implemented`) before
integrating m4-v2 into `app.js`. m4 consumes m3's per-HH `elec_heating_kwh` series from
`baseloadResult.heating[i].elec_heating_kwh`. The `test-m4-v2.mjs` test suite uses synthetic data
and can run independently at any time.

---

## Research findings

### `js/heat-loss.js` (v1, 388 lines) — fully read

Key reference points confirmed from the live code:

- **`aggregateToDays(heating, external)`** — reads only `h.heating_kwh` (gas); marks
  `missing_heating = true` if any HH gas value is null; day objects carry `daily_heating_kwh` as the
  LHS variable for the fit. Solar (W/m² → kWh/m²) and temperature aggregation are correct and
  survive v2 unchanged.
- **`filterForRegression(days)`** — thresholds on `day.daily_heating_kwh < 2.0 kWh`. This changes
  to `day.daily_heat_delivered` in v2.
- **`runOLSTwoPredictor(filtered)`** and **`runOLSOnePredictor(filtered)`** — read `d.daily_heating_kwh`
  as `y`. The normal-equations solver, through-origin constraint, standard errors, and R² computation
  are correct and unchanged in v2 (only the field name changes to `d.daily_heat_delivered`).
- **`estimateHeatLoss` signature**: `(heating, external, baseloadMetadata, supplementaryLoads,
  boilerEfficiency, floorAreaM2)`. v2 drops three params and adds one.
- **No-gas short-circuit** at the top of `estimateHeatLoss` (lines 209–224): DELETE.
- **HTC recovery** (line 306): `alpha * 1000 * boilerEfficiency / 24`. In v2: `alpha * 1000 / 24`
  (η is baked into `daily_heat_delivered`; do not double-apply).
- **CI** (lines 307–310): same `boilerEfficiency` factor — remove in v2.
- **Check 4D** (lines 329–346): DELETE entirely.
- **Floor area warning** (lines 354–356): DELETE.
- **Output field** `solar_aperture_m2` → renamed to `solar_aperture` in v2 contract (§2.6).
- **`zeroExcluded`** (line 206): only used by the deleted no-gas early return — DELETE.
- **`insufficientDataResult()` inline closure** (lines 229–244): update to v2 contract.

### `js/constants.js`

`HDD_BASE_TEMP = 15.5` exported from line 1. Import confirmed at `heat-loss.js:6`. No redeclaration
needed — already correct.

### Test scaffolding

No `test-m4*.mjs` found in the repository root. **M4 has no committed test suite.** The m3 plan
review (2026-06-04) confirmed M3 v1 similarly had no committed suite beyond Step F — M4 follows the
same pattern. `test-m4-v2.mjs` is created from scratch, covering all 16 v2-specific tests (design doc §5 tests
1–15 + presence-gating test 16) plus v1 carry-through tests (~10), totalling ~27 test cases.

### `js/app.js` call site — read lines 43, 180–181, 1130–1235, 1300–1316, 1450–1474, 3200–3271

Current call (lines 1216–1223):
```js
result = estimateHeatLoss(
  baseloadResult.heating,
  externalResult.external,
  baseloadResult.baseload_metadata,    // REMOVE — no-gas gate gone
  baseloadResult.supplementary_loads,  // REMOVE — Check 4D gone
  boilerEfficiency,
  floorAreaM2,                         // REMOVE — HLP gone
);
```

v2 call:
```js
result = estimateHeatLoss(
  baseloadResult.heating,   // now carries elec_heating_kwh per HH (m3-v2 contract)
  externalResult.external,
  boilerEfficiency,
  null,                     // setpointRescalePayload — first pass; dormant until m7-v2 lands
);
```

All field-level app.js changes confirmed by reading the relevant lines:

| Location | Current | Change |
|---|---|---|
| Line 181 | `const floorAreaInput = document.getElementById('floor-area')` | DELETE |
| Lines 1136–1143 | `if (result.validation_status === 'no_gas') { … }` display block | DELETE |
| Lines 1176–1178 | `htc_w_per_k_adjusted` display row | DELETE |
| Lines 1180–1182 | `hlp_w_per_m2_k` display row | DELETE |
| Line 1183 | `result.solar_aperture_m2` | → `result.solar_aperture` |
| Line 1184 | `result.solar_aperture_m2` | → `result.solar_aperture` |
| Line 1210 | `parseFloat(…) || 0.90` | → `|| 0.85` |
| Lines 1211–1212 | `floorAreaRaw` / `floorAreaM2` parse | DELETE |
| Line 3206 | `const htc = hl?.htc_w_per_k ?? null` in diagnostic | KEEP; also ADD `const htcUsed = hl?.htc_used ?? null` on the next line |
| Line 3208 | `hl?.solar_aperture_m2 ?? null` | → `hl?.solar_aperture ?? null` (output field renamed) |
| Line 3265 | `htc_w_per_k: htc` in diagnostic return | KEEP; also ADD `htc_used: htcUsed` as a new field |
| Line 3266 | `solar_aperture_m2: solarR` in diagnostic return | → `solar_aperture: solarR` |

**Harmlessly dead code — leave for downstream v2 plans:**
- Line 1310: `no_gas` check in `displayThermalCharResults` (refers to m5 result object)
- Line 1459: `no_gas` check in `displayHpModelResults` (refers to m6 result object)

These branches never trigger once m4-v2 never emits `no_gas`. Clean up in m5-v2 / m6-v2 plans.

### `index.html` inputs — read lines 231–237

- Line 232: `<input type="number" id="boiler-efficiency" value="0.90" step="0.01" min="0.60" max="0.98">` → replace with `<select>` (INV-12 4-tier).
- Lines 236–237: floor area `<label>` + `<input id="floor-area">` → DELETE both.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/heat-loss.js` | All v2 deltas: combined-fuel, η-move, mint, rescale, removals, field rename |
| MODIFY | `index.html` | Boiler efficiency → 4-tier dropdown (INV-12); remove floor area input |
| MODIFY | `js/app.js` | Call site update; remove/rename all affected field references |
| CREATE | `test-m4-v2.mjs` | M4 v2 test suite — 16 v2-specific + ~10 v1 carry-through (~27 total) |

---

## Implementation steps

**Prerequisite gate:** Before integrating into `app.js`, confirm `docs/plans/m3-baseload-v2.md`
shows `Status: Implemented`. The test suite and `heat-loss.js` changes can proceed at any point.

---

### Step 1 — New helper: `mintThermalHeatDelivered` (`js/heat-loss.js`)

Add a new private function immediately before `aggregateToDays`:

```js
function mintThermalHeatDelivered(heating, eta) {
  return heating.map(h => {
    const gas  = h.heating_kwh      ?? null;
    const elec = h.elec_heating_kwh ?? null;
    if (gas === null && elec === null) return null;
    return (gas ?? 0) * eta + (elec ?? 0);
  });
}
```

Contract: returns an array of the same length and order as `heating[]`; null only where BOTH
`heating_kwh` AND `elec_heating_kwh` are null (no data for that HH); a single non-null component
drives the value and the absent one contributes 0 (consistent with design doc §2.5.2).

---

### Step 2 — Update `aggregateToDays` (`js/heat-loss.js`)

Add `eta` parameter: `aggregateToDays(heating, external, eta)`.

**Presence-gated whole-day rule (design doc §2.5.2).** The fit's whole-day rule must distinguish an
**absent fuel** (the home has no meter for it — null for every HH across the dataset) from a **gap** (a
present fuel with a missing reading on one or more HH in a day). A gap in a present fuel must exclude
the whole day (as v1 did for gas); an absent fuel does not gate. This is data-presence detection, not
fuel classification — m4 still combines both fuels regardless.

At the top of `aggregateToDays`, before the day-building loop, compute two **home-level presence
flags** once:

```js
const gas_present  = heating.some(h => h.heating_kwh      !== null);
const elec_present = heating.some(h => h.elec_heating_kwh !== null);
```

Inside the day-building loop, replace the gas-only `daily_heating_kwh` accumulation with:

```js
let daily_gas_heating_kwh  = 0;
let daily_elec_heating_kwh = 0;
let missing_thermal = false;
for (const i of indices) {
  const h = heating[i];
  // Presence-gated: a gap in a PRESENT fuel excludes the day.
  // An absent fuel (gas_present = false / elec_present = false) does not gate.
  if (gas_present  && (h.heating_kwh      == null)) { missing_thermal = true; break; }
  if (elec_present && (h.elec_heating_kwh == null)) { missing_thermal = true; break; }
  daily_gas_heating_kwh  += (h.heating_kwh      ?? 0);
  daily_elec_heating_kwh += (h.elec_heating_kwh ?? 0);
  if (h.is_absence) has_absence = true;
}
const daily_heat_delivered = missing_thermal
  ? NaN
  : daily_gas_heating_kwh * eta + daily_elec_heating_kwh;
```

The `?? 0` in the daily sums is now safe: because any gap in a present fuel already excluded the day,
`?? 0` only ever coerces a genuinely **absent** fuel (legitimately 0 contribution). No silent undercount.

Replace `daily_heating_kwh` with `daily_heat_delivered` throughout the day object:

```js
days.push({
  dateStr,
  daily_heat_delivered,      // replaces daily_heating_kwh
  daily_solar_kwh_per_m2,
  daily_degree_days,
  has_absence,
  missing_heating: missing_thermal,   // field name kept for filterForRegression compatibility
  missing_weather,
});
```

**Mint vs fit distinction:** The MINT (Step 1 / `mintThermalHeatDelivered`) retains the looser
both-null rule — correct for m7's continuous trace (any present fuel drives a non-null output, full
series emitted). Only the FIT aggregation uses the stricter presence-gated rule.

---

### Step 3 — Update `filterForRegression` (`js/heat-loss.js`)

Change the below-threshold check:

```js
// v1: if (day.daily_heating_kwh < 2.0)
if (day.daily_heat_delivered < 2.0) { excluded.below_heating_threshold++; continue; }
```

No other change. The exclusion categories (`absence`, `zero_degree_days`, `missing_heating`,
`missing_weather`, `below_heating_threshold`) are unchanged.

---

### Step 4 — Update OLS field references (`js/heat-loss.js`)

In `runOLSTwoPredictor` and `runOLSOnePredictor`, change every `d.daily_heating_kwh` to
`d.daily_heat_delivered` (the `y` variable in the inner accumulation loop). The OLS math — normal
equations, through-origin constraint, SE computation, R² — is unchanged.

---

### Step 5 — Update `estimateHeatLoss` signature (`js/heat-loss.js`)

Old: `estimateHeatLoss(heating, external, baseloadMetadata, supplementaryLoads, boilerEfficiency, floorAreaM2)`

New: `estimateHeatLoss(heating, external, boilerEfficiency, setpointRescalePayload = null)`

Remove `baseloadMetadata`, `supplementaryLoads`, `floorAreaM2` throughout the function body (they
are unused after the subsequent deletions).

---

### Step 6 — Remove no-gas short-circuit + `zeroExcluded` (`js/heat-loss.js`)

Delete:
1. The `const zeroExcluded = { … }` declaration (line 206).
2. The entire no-gas pre-flight block (lines 208–224):
   ```js
   // Pre-flight: no-gas case — skip silently …
   if (baseloadMetadata.method === 'no-gas') { return { … }; }
   ```

---

### Step 7 — Mint early in `estimateHeatLoss` and update `aggregateToDays` call (`js/heat-loss.js`)

Immediately after the deleted no-gas block (i.e., at the top of the working function body), add:

```js
const thermal_heat_delivered_kwh = mintThermalHeatDelivered(heating, boilerEfficiency);
```

Then update the `aggregateToDays` call to thread `boilerEfficiency`:

```js
const days = aggregateToDays(heating, external, boilerEfficiency);
```

The mint is computed before any filtering, so it is always available for `insufficientDataResult()`.

---

### Step 8 — Update `insufficientDataResult` return object (`js/heat-loss.js`)

The inline `insufficientDataResult()` closure closes over `excluded` (from `filterForRegression`) and
`thermal_heat_delivered_kwh` (minted in Step 7). Update its return to the v2 contract:

```js
function insufficientDataResult() {
  return {
    htc_w_per_k:                null,
    htc_used:                   null,
    htc_confidence_interval_95: null,
    boiler_efficiency_used:     boilerEfficiency,
    thermal_heat_delivered_kwh,          // minted above — emitted even when fit fails
    solar_aperture:             null,    // RENAMED from solar_aperture_m2
    solar_correction_applied:   false,
    rating:                     null,
    solar_rating:               null,
    cooling_consideration:      null,
    htc_low_plausibility:       false,
    htc_rescale_rejected:       false,
    regression_r2:              null,
    days_used_in_fit:           0,
    days_excluded:              excluded,
    degree_day_base_c:          HDD_BASE_TEMP,
    validation_status:          'insufficient_data',
    warnings: ["Not enough heating data to calculate your home's heat loss. "
               + "We need at least 20 days of clear heating signal (cold days below 15.5 °C "
               + "outside). Come back in winter or with more data."],
  };
}
```

Note: the first call to `insufficientDataResult()` (after the singular-check logic) still closes
over `excluded` correctly — `excluded` is defined from `filterForRegression` before both call sites.

---

### Step 9 — Update HTC recovery + CI — the η-move (`js/heat-loss.js`)

**v1** (line 306): `const htc = alpha * 1000 * boilerEfficiency / 24;`
**v2**: `const htc = alpha * 1000 / 24;`

**v1 CI** (lines 307–310):
```js
const ci = {
  lower: (alpha - 1.96 * seAlpha) * 1000 * boilerEfficiency / 24,
  upper: (alpha + 1.96 * seAlpha) * 1000 * boilerEfficiency / 24,
};
```
**v2**: remove `* boilerEfficiency` from both bounds.

This is the η-move. η is baked into `daily_heat_delivered` on the LHS; the OLS slope α already
encodes it; the recovery reverts to the physical units without applying η again.
**Do not double-apply η** — Tests T11 and T15 catch this.

---

### Step 10 — Remove Check 4D and floor area warning (`js/heat-loss.js`)

Delete:
1. The entire Check 4D block (lines 329–346):
   ```js
   // Check 4D: supplementary electric heating correction
   let htc_correction = null;
   let htc_adjusted = null;
   if (supplementaryLoads?.electric_heating_detected && …) { … }
   ```
2. The floor area plausibility warning block (lines 354–356):
   ```js
   if (floorAreaM2 !== null && (floorAreaM2 < 30 || floorAreaM2 > 500)) { … }
   ```

Remove all references to the now-deleted variables `htc_correction`, `htc_adjusted`, `floorAreaM2`.

---

### Step 11 — Add `htc_low_plausibility` flag (`js/heat-loss.js`)

Before Check 4B, initialise: `let htc_low_plausibility = false;`

Inside the Check 4B `if (htc < 50 || htc > 1500)` block, add:
```js
if (htc < 50) htc_low_plausibility = true;
```

The flag is source-blind — m4 does not read fuel classification. The UI routes the framing (heat-loss
card for gas/mixed; dual-handed thermal-character copy for all-electric) via m3's
`classification_effective`.

---

### Step 12 — New named export `applyHtcRescale` + Step 7 (`js/heat-loss.js`)

Add a new **named export** after the rating helpers (pure function, no side effects — exported for
direct unit-testing in `test-m4-v2.mjs`):

```js
export function applyHtcRescale(htc, payload) {
  if (htc === null) return { htc_used: null, htc_rescale_rejected: false };
  if (!payload)     return { htc_used: htc,  htc_rescale_rejected: false };
  const { setpoint_delta_k: delta, operating_delta_t_k: dTOp } = payload;
  const dTUser = dTOp + delta;
  if (dTOp <= 0 || dTUser <= 0) return { htc_used: htc, htc_rescale_rejected: true };
  const rescale = dTOp / dTUser;
  if (rescale < 0.8 || rescale > 1.2) return { htc_used: htc, htc_rescale_rejected: true };
  return { htc_used: htc * rescale, htc_rescale_rejected: false };
}
```

Call it in `estimateHeatLoss` after the rating computation (Step 6 — ratings use bare `htc`, not
`htc_used`):

```js
const { htc_used, htc_rescale_rejected } = applyHtcRescale(htc, setpointRescalePayload);
```

**Key properties:**
- No payload (first pass / m7 not yet live): `htc_used = htc`, `htc_rescale_rejected = false`.
- Degenerate payload (ΔT_op ≤ 0 or ΔT_user ≤ 0): reject + flag.
- Out-of-band (|rescale − 1| > 0.20): `htc_used = htc` unrescaled, `htc_rescale_rejected = true`.
  **Not saturated at the bound** — per design doc §2.5.8 and FINDING §7.4.
- Always recomputed from bare `htc` — never from a prior `htc_used` (idempotent).
- Exported as a named export; tests T21–T23 unit-test `applyHtcRescale` directly with known inputs.

---

### Step 13 — Update all return objects (`js/heat-loss.js`)

Apply to every `return { … }` in `estimateHeatLoss` (the negative-alpha branch and the main
successful return). For each:

**Remove:** `htc_correction_w_per_k`, `htc_w_per_k_adjusted`, `hlp_w_per_m2_k`

**Add:** `htc_used`, `htc_low_plausibility`, `htc_rescale_rejected`, `thermal_heat_delivered_kwh`

**Rename:** `solar_aperture_m2` → `solar_aperture`

For the negative-alpha inverted-relationship return: set `htc_used: null`, `htc_low_plausibility:
false`, `htc_rescale_rejected: false` (no fit was produced).

Main successful return (after Step 12):
```js
return {
  htc_w_per_k:                htc,
  htc_used,                            // from applyHtcRescale
  htc_confidence_interval_95: ci,
  boiler_efficiency_used:     boilerEfficiency,
  thermal_heat_delivered_kwh,          // per-HH mint — full series
  solar_aperture,                      // RENAMED (was solar_aperture_m2)
  solar_correction_applied,
  rating,
  solar_rating,
  cooling_consideration,
  htc_low_plausibility,
  htc_rescale_rejected,
  regression_r2: r2,
  days_used_in_fit: filtered.length,
  days_excluded: excluded,
  degree_day_base_c: HDD_BASE_TEMP,
  validation_status,
  warnings,
};
```

Also update the internal variable name `solar_aperture_m2` → `solar_aperture` wherever it appears
in the function body (the assignment from `-fit2.beta`, the `solar_aperture_m2 = R` line, the guard
`solar_aperture_m2 !== null` in the ratings block, and the `buildCoolingConsideration` call argument).

---

### Step 14 — Update `index.html`

**1. Boiler efficiency → 4-tier dropdown (INV-12):**

Replace the `<input type="number" id="boiler-efficiency">` element with:
```html
<select id="boiler-efficiency">
  <option value="0.92">Modern condensing (post-2010) — 92%</option>
  <option value="0.85" selected>Older condensing (2005–2010) — 85% (default)</option>
  <option value="0.70">Non-condensing — 70%</option>
  <option value="0.60">Very old / back boiler — 60%</option>
</select>
```

Keep the `<label for="boiler-efficiency">Boiler efficiency</label>` unchanged.

**2. Remove floor area input:**

Delete lines 236–237:
```html
<label for="floor-area">Floor area (m²) …</label>
<input type="number" id="floor-area" …>
```

---

### Step 15 — Update `js/app.js`

Apply all changes identified in Research Findings, in line-number order:

1. **Line 181** — Delete `const floorAreaInput = document.getElementById('floor-area');`

2. **Line 1136–1143** — Delete the `no_gas` display block in `displayHeatLossResults`:
   ```js
   if (result.validation_status === 'no_gas') { … return; }
   ```

3. **Lines 1176–1178** — Delete the `htc_w_per_k_adjusted` display row.

4. **Lines 1180–1182** — Delete the `hlp_w_per_m2_k` display row.

5. **Line 1183** — `result.solar_aperture_m2` → `result.solar_aperture`

6. **Line 1184** — `result.solar_aperture_m2` → `result.solar_aperture`

7. **Line 1210** — `|| 0.90` → `|| 0.85` (default matches the dropdown's selected option).
   `parseFloat` on a `<select>` value still works correctly.

8. **Lines 1211–1212** — Delete floor area parse:
   ```js
   const floorAreaRaw = parseFloat(floorAreaInput.value);
   const floorAreaM2 = isNaN(floorAreaRaw) ? null : floorAreaRaw;
   ```

9. **Lines 1216–1223** — Update `estimateHeatLoss` call to 4-arg signature (see Research Findings).

10. **Line 3206** — Keep `const htc = hl?.htc_w_per_k ?? null`. On the next line, **add**
    `const htcUsed = hl?.htc_used ?? null`. The diagnostic exposes both the fitted and the
    rescaled value so they can be compared. Do not rename the existing variable.

11. **Line 3208** — `hl?.solar_aperture_m2 ?? null` → `hl?.solar_aperture ?? null`
    (the m4 output field is renamed; the diagnostic reads from it).

12. **Line 3265** — Keep `htc_w_per_k: htc` in the `comfort_demand_inputs` return object.
    **Add** `htc_used: htcUsed` as a new field alongside it (both present — the getter exists to
    compare fitted vs used).

13. **Line 3266** — `solar_aperture_m2: solarR` → `solar_aperture: solarR`

**Do not remove** `no_gas` checks at lines 1310 and 1459 — these refer to m5/m6 result objects,
are now dead code, and will be cleaned up in m5-v2/m6-v2 plans.

---

### Step 16 — Create `test-m4-v2.mjs`

ES module, Node.js `assert` (strict), run with `node test-m4-v2.mjs`. Import both
`estimateHeatLoss` and `applyHtcRescale` from `./js/heat-loss.js`.

**Synthetic data helper:** Generate `heating[]` entries with `{ timestamp, heating_kwh,
elec_heating_kwh, is_absence }` and `external[]` entries with `{ temp_c, solar_w_m2 }`. Build
enough calendar-whole cold days (all 48 HH present, T_mean < 15.5 °C, heat > 2.0 kWh/day) to
satisfy the 20-day minimum, plus a stock of warm days, absence days, and low-heating days for
exclusion tests. Use a simple linear synthetic model: `daily_heat_delivered = HTC_true × DD +
solar_noise` to ensure recoverable fits.

**~27 test cases total:**

#### v1 carry-through (T1–T10)

T1. **Core HTC recovery** — gas-only synthetic data, HTC_true = 250, R_true = 3. Expect
    `htc_w_per_k` ≈ 250 ±15%, `solar_aperture` > 0 (thermal-basis ≈ 0.85 × R_true).
T2. **Absence exclusion** — one cold day with `is_absence = true`. Expect
    `days_excluded.absence == 1`.
T3. **Check 4A negative-R fallback** — synthetic data where solar correlates inversely with heat.
    Expect `solar_correction_applied == false`, `solar_aperture == null`, `solar_rating == null`.
T4. **Check 4B low-HTC flag** — contrive data to produce HTC ≈ 40. Expect
    `htc_low_plausibility == true`, `validation_status == 'poor'`.
T5. **Check 4B high-HTC** — contrive HTC ≈ 1600. Expect `htc_low_plausibility == false`,
    `validation_status == 'poor'`.
T6. **Check 4C poor R²** — high-noise data. Expect `validation_status == 'poor'` or
    `'acceptable'` (not `'good'`).
T7. **Rating boundaries** — HTC = 100 → `'excellent'`; 200 → `'good'`; 300 → `'average'`; 400 →
    `'poor'`; 600 → `'very_poor'`.
T8. **Solar rating boundaries** — R = 1 → `'minimal'`; 3 → `'moderate'`; 5 → `'good'`; 10 →
    `'high'`; 15 → `'very_high'`.
T9. **Cooling consideration** — (R ≥ 7, HTC < 250) → `'significant'`; (R = 4, HTC = 200) →
    `'worth_noting'`; (R = 1, HTC = 400) → `'minimal'`.
T10. **Degree-day base echo** — `result.degree_day_base_c === 15.5`.

#### v2-specific (T11–T26, per design §5)

T11. **Gas-only η-equivalence (§5 Test 5.1 — the η-move regression).** Same gas-only data, no
     elec heating (`elec_heating_kwh = 0` throughout). Call at η = 0.85 to get `htc_v2`. Call at
     η = 1.0 to get `htc_1`; then `htc_v1 = htc_1 × 0.85` (this replicates what v1's recovery
     `α × 1000 × η / 24` would give, since `htc_1 = α × 1000/24` and v1 = `α × 1000 × 0.85/24`).
     Assert `|htc_v2 − htc_v1| < 1e-9`. **Fails if η is double-applied or omitted.**
T12. **Combined-fuel mixed (§5 Test 5.2).** HTC_true = 250, η = 0.85, elec contributing 0.6
     kWh/(K·day). Expect `htc_w_per_k` ≈ 250 ±15%.
T13. **All-electric, no short-circuit (§5 Test 5.3).** `heating_kwh = null` throughout (m3 sets gas
     null when there is no gas meter — not 0), `elec_heating_kwh` generating a clear cold-weather
     signal, HTC_true = 220. `gas_present = false` so null gas does **not** exclude any day via the
     presence-gated rule. Expect fit runs, `validation_status ∈ {'good', 'acceptable'}` (NOT
     `'no_gas'`), `htc_w_per_k` ≈ 220 ±15%. **Fails if the whole-day rule excludes days for null
     gas on an all-electric home.**
T14. **Solar-aperture basis shift (§5 Test 5.4).** Same gas-only data fitted at η = 0.85 and at
     η = 1.0. `solar_aperture_v2` (η = 0.85) should ≈ 0.85 × `solar_aperture_v1` (η = 1.0) within
     ±5%. Confirms thermal-basis shift is intended (not a regression).
T15. **η scaling (§5 Test 5.5).** Fit same gas-only data at η = 0.85 and η = 0.70. Expect
     `htc_at_0.70 / htc_at_0.85 ≈ 0.70 / 0.85` within ±1e-9.
T16. **Per-HH thermal mint (§5 Test 5.6).** Check for each HH: `thermal[i] == gas[i] × η +
     elec[i]`; null only where both null; `thermal_heat_delivered_kwh.length == heating.length`
     (absence-period HH included in the array).
T17. **Check 4D removed (§5 Test 5.7).** Assert `!('htc_correction_w_per_k' in result)` and
     `!('htc_w_per_k_adjusted' in result)`.
T18. **net_flow / internal_gains removed (§5 Test 5.8).** Assert none of `net_flow_w`,
     `net_flow_label`, `net_flow_warning`, `internal_gains_w_used`, `winter_setpoint_used_c` in
     result.
T19. **HLP / floor_area removed (§5 Test 5.9).** Assert `!('hlp_w_per_m2_k' in result)`.
T20. **Rescale first pass (§5 Test 5.10).** Call with `setpointRescalePayload = null`. Assert
     `result.htc_used === result.htc_w_per_k` (exact equality), `result.htc_rescale_rejected === false`.
T21. **Rescale within band — unit (§5 Test 5.11).** Call `applyHtcRescale` directly with
     `htc = 220`, `payload = { setpoint_delta_k: 2, operating_delta_t_k: 12 }`. Expected:
     `rescale = 12/14`, `htc_used = 220 × (12/14)` exactly (to `1e-9`), `htc_rescale_rejected ===
     false`. δ > 0 ⇒ HTC lowered — correct direction.
T21-int. **Rescale integration check.** Call `estimateHeatLoss` with a synthetic heating dataset
     and a within-band `setpointRescalePayload`. Assert `result.htc_used !== result.htc_w_per_k`
     (payload was applied) and `result.htc_rescale_rejected === false`.
T22. **Rescale out-of-band rejected — unit (§5 Test 5.12).** `applyHtcRescale(220, { setpoint_delta_k: 4,
     operating_delta_t_k: 12 })`. `rescale = 12/16 = 0.75` (< 0.8). Assert `htc_used === 220`
     (unrescaled, exact), `htc_rescale_rejected === true`.
T23. **Rescale idempotence — unit (§5 Test 5.13).** Call `applyHtcRescale` twice with identical
     inputs. Assert results are identical (pure function, no state).
T24. **Low-HTC source-blind flag (§5 Test 5.14).** Contrive data to produce HTC ≈ 45. Assert
     `htc_low_plausibility === true`, `validation_status === 'poor'`, `htc_w_per_k ≈ 45` (returned
     as-is, no clamp). Assert `!('htc_low_plausibility_callout' in result)` (no fuel-routed string).
T25. **Insufficient data — no fabrication (§5 Test 5.15).** 15 heating days (below 20-day
     minimum). Assert `htc_w_per_k === null`, `htc_used === null`, `rating === null`,
     `validation_status === 'insufficient_data'`, `thermal_heat_delivered_kwh.length == heating.length`
     (mint still emitted), no invented HTC value anywhere in the result.
T26. **Whole-day presence-gating (§5 Test 5.16).** Two sub-cases:
     (a) **Gas home, one HH gap:** Build a gas-only dataset (gas_present = true, elec = 0
         throughout). On one otherwise-complete cold heating day, set one `heating_kwh = null`.
         Assert that day is counted in `days_excluded.missing_heating` (excluded, not silently
         included with ~98% of its heat). **Fails if both-null rule is used** (null gas + 0 elec is
         NOT both-null → day would be included).
     (b) **All-electric home, null gas throughout:** Build an all-electric dataset (`heating_kwh =
         null` for all HH throughout, `elec_heating_kwh` set normally — gas_present = false). Assert
         that days are NOT excluded for the null gas (presence-gated: absent fuel does not gate).
         **Fails if the whole-day rule gates on null gas regardless of presence.**

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| η double-applied (LHS *and* recovery) | T11 catches it exactly; T15 catches scaling errors. Both tests must pass before integration. |
| `solar_aperture_m2` rename missed somewhere in `app.js` | Grep `solar_aperture_m2` across the entire repo before committing; any remaining hit is a bug. |
| `htc_used` not propagated to m5/m6/m7 | m5/m6/m7 are still v1 and read `htc_w_per_k` from the cached result — safe on first pass (`htc_used == htc`). Their v2 plans bind to `htc_used`. Note in deviations if still applicable at implementation time. |
| `thermal_heat_delivered_kwh` absent from `insufficientDataResult` | Mint is computed before the insufficient-data check; closure captures it. T25 verifies. |
| `zeroExcluded` not cleaned up when no-gas block is deleted | Check that the `const zeroExcluded` declaration is deleted in the same edit as the no-gas block. |
| m3-v2 not yet implemented when app.js integration runs | Prerequisite gate: check m3-v2 plan Status before touching `app.js`. Tests use synthetic data — unaffected. |
| Degenerate rescale payload (ΔT_op ≤ 0) passes silently | `applyHtcRescale` explicitly guards `dTOp <= 0` and `dTUser <= 0` → reject + flag. |
| T21–T23 rescale tests require exact htc input | `applyHtcRescale` is now a named export — unit tests call it directly with a known `htc` value; no synthetic-dataset engineering needed. |
| `boilerEfficiencyInput` type change (`<input>` → `<select>`) breaks JS read | `parseFloat` on a `<select>` value is valid; `|| 0.85` default unchanged. No JS change beyond the default value. |

---

## Success criteria

### `js/heat-loss.js`

- [ ] `estimateHeatLoss` signature is `(heating, external, boilerEfficiency, setpointRescalePayload = null)`
- [ ] Function runs without error on gas-only, mixed, and all-electric synthetic data (no early return)
- [ ] `validation_status` values are `{good, acceptable, poor, insufficient_data}` — `no_gas` absent
- [ ] Output contains `htc_used`, `htc_low_plausibility`, `htc_rescale_rejected`, `thermal_heat_delivered_kwh`
- [ ] Output contains `solar_aperture` (not `solar_aperture_m2`)
- [ ] Output contains **no** `htc_correction_w_per_k`, `htc_w_per_k_adjusted`, `hlp_w_per_m2_k`
- [ ] Output contains **no** `net_flow_*`, `internal_gains_*`, `winter_setpoint_*`
- [ ] HTC recovery: `alpha * 1000 / 24` (no η factor)

### `test-m4-v2.mjs`

- [ ] All ~27 tests pass: `node test-m4-v2.mjs` exits 0 (T1–T26 + T21-int)
- [ ] T11: gas-only HTC identical to v1 formula within 1e-9 (η-move regression test)
- [ ] T15: η scaling ratio exact within 1e-9
- [ ] T20–T23: rescale pass/reject/idempotence all confirmed
- [ ] T25: insufficient data — mint present, `htc = null`, `htc_used = null`

### `index.html`

- [ ] `#boiler-efficiency` is a `<select>` with 4 options; default `selected` is 0.85
- [ ] No `<input id="floor-area">` or associated label present

### `js/app.js`

- [ ] `estimateHeatLoss` call uses 4-arg signature
- [ ] No reference to `floorAreaInput`, `floorAreaM2`, `htc_w_per_k_adjusted`, `hlp_w_per_m2_k`
- [ ] `solar_aperture_m2` does not appear anywhere in `app.js` (grep confirms)
- [ ] Default boiler efficiency fallback is `0.85`
- [ ] Diagnostic `__getScenarioDiagnostics` has BOTH `htc_w_per_k` (fitted) and `htc_used` (rescaled) in `comfort_demand_inputs`; `solar_aperture_m2` → `solar_aperture`

---

## Flags for Opus review

1. **`solar_aperture` rename (not a regression):** The v2 output uses `solar_aperture` (design
   doc §2.6), dropping the `_m2` suffix from v1. The thermal-basis shift (≈ η × v1's gas-basis R
   for gas-only homes) is also intended by the η-move — not a regression against v1 R fixtures. See
   design doc §2.5.4 and §7 Changed.

2. **Mint vs fit — two different null rules (design doc §2.5.2):** The MINT (Step 1) uses the
   looser both-null rule: any present fuel drives a non-null output, absent fuel contributes 0. The
   FIT aggregation (Step 2) uses the stricter presence-gated rule: a gap in a present fuel excludes
   the whole day. These rules are deliberately different and must not be unified. The old "both-null"
   rule for the fit was wrong: a null `heating_kwh` HH on a gas home where `elec_heating_kwh = 0`
   is NOT both-null, so the day would have been silently included with ~98% of its heat, biasing HTC
   low. Presence-gating corrects this. T26 verifies both the gap-exclusion and the absent-fuel
   non-gating behaviours.

3. **`applyHtcRescale` export — resolved:** `applyHtcRescale` is now a named export. Tests T21–T23
   unit-test it directly with exact inputs; no synthetic dataset needed. One integration check
   (T21-int) confirms the export is wired through `estimateHeatLoss` correctly.

4. **Dead code — `no_gas` in m5/m6 display functions:** Lines 1310 and 1459 in `app.js` are now
   dead code. Leaving them for m5-v2/m6-v2 plans (they refer to m5/m6 result objects, not m4).

5. **Diagnostic `htc` fields — both retained:** `__getScenarioDiagnostics` now exposes BOTH
   `htc_w_per_k` (fitted) and `htc_used` (rescaled) in `comfort_demand_inputs`. The existing
   `htc_w_per_k` field is kept unchanged (no rename); `htc_used` is added alongside it. Any
   existing diagnostic consumer reading `comfort_demand_inputs.htc_w_per_k` continues to work.

---

## Implementation Deviations

**Date:** 2026-06-04
**Commit:** `8d7e72e`

**D1 — Downstream `solar_aperture_m2` rename propagated to v1 consumers (unplanned scope).**
`js/thermal-character.js` (line 94) and `js/scenario-consumption.js` (lines 183, 213) still
referenced `solar_aperture_m2` from the m4 result. These are v1 modules (m5-v2 and m7-v2 plans
will formally own the rename in their own steps), but the live code would silently read `undefined`
from the new `solar_aperture` field — producing `aperture = 0` for solar-correction-enabled homes
and degrading the RC trace. Fixed inline: renamed to `solar_aperture` in both files.
Corresponding test fixtures in `test-m5.mjs` (M5X2, M5X3) and `test-m7.mjs` updated to match.
All suites confirmed green: M3 44/44, M5 39/39, M5b 29/29, M6 24/24, M7 39/39, M8 29/29, M9 24/24.

**D2 — Test synthetic data generators required two corrections.**
(a) Unit bug: initial generator used `htcTrue × DD / eta` (missing `× 24/1000` W→kWh conversion);
corrected to `htcTrue × DD × 24/1000`. (b) Constant temperature across all days made the
two-predictor OLS singular when solar was non-zero; generators were redesigned to vary temperature
linearly across days. Neither deviation touches production code; the plan's mathematical intent
(the η-move equivalence, solar-aperture basis shift, OLS recovery) is verified correctly by the
final T1–T26+T21-int suite.

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-06-04
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/m4-heat-loss-v2.md` (commit `35c98a0`)

### Context

Plan for the m4 heat-loss v2 rewrite (combined-fuel Siviour, the η-move, per-HH thermal mint, the
±20% HTC rescale, and removal of Check 4D / the no-gas short-circuit / net_flow / internal_gains /
floor_area+HLP). Reviewed against the realigned design doc. The plan's codebase claims were verified
via a read-only Explore sub-agent — the `estimateHeatLoss` call site + v1 6-arg signature; the
`app.js` field/line anchors (floor-area input, `no_gas` display block, `htc_w_per_k_adjusted` / `hlp`
rows, `solar_aperture_m2`, the `|| 0.90` default, the diagnostic getters); the `index.html` boiler /
floor-area inputs; `heat-loss.js` no-gas:209 / recovery:306 / Check-4D:329–346; and m3-v2 (Implemented
at `98d47ae`, emitting `elec_heating_kwh` per HH) — all confirmed accurate against current code.

The first-cut review surfaced one HIGH finding (the whole-day completeness rule). The design doc was
itself ambiguous on the point, so it was clarified at source (§2.5.2, commit `35c98a0`) and the plan
was re-cut in the live Sonnet loop. This review is of the re-cut (`a51e200`).

### Required changes for implementation

**1. Presence-gated whole-day rule (HIGH).** The first-cut both-null exclusion silently undercounted
gas-gap days — a `heating_kwh = null` HH on a gas home (where `elec_heating_kwh = 0`) is not
both-null, so the day was included with the gap coerced to 0 → downward HTC bias. An `OR` rule would
have broken the all-electric unblock (m3 sets `heating_kwh = null` for every HH when there is no gas
meter). Required: distinguish an **absent fuel** (null home-wide → contributes 0, does not gate) from
a **gap** (present fuel, missing reading → excludes the whole day) via two home-level presence flags;
the fit gates per present fuel, the mint keeps the looser both-null rule.

**2. Test coverage for the rule.** T13 (all-electric) corrected to `heating_kwh = null` throughout;
T26 added (gas-gap excludes; absent-gas does not gate).

**3. `applyHtcRescale` export + diagnostic field retention.** Export `applyHtcRescale` (pure function)
so the rescale band/idempotence tests unit-test it directly; keep `htc_w_per_k` and add `htc_used` in
the diagnostic getter (no rename) so a fitted-vs-used comparison survives.

### Resolution of review changes

1. **Presence-gated whole-day rule** — Step 2 computes `gas_present`/`elec_present` and gates per
   present fuel; `?? 0` now only coerces absent fuels; the mint-vs-fit distinction is documented and
   the incorrect Flag 2 rationale replaced. Design §2.5.2 clarified at source (`35c98a0`).
2. **Tests** — T13 corrected; T26 added (both sub-cases). ~27 cases total.
3. **`applyHtcRescale` export + diagnostic** — named export; T21–T23 + T21-int retargeted; the
   diagnostic retains both `htc_w_per_k` and `htc_used`.

### Items noted but not edited

- **LOW — line-number anchors.** The plan references `app.js` / `heat-loss.js` line numbers
  (discouraged per sizing guidance). Verified accurate against current post-m3 code and recoverable
  by content; non-blocking. Re-locate by function/pattern if anything lands before m4.
- **LOW — η-equivalence test (T11).** v1 cannot be run; the `htc_v2(η) == htc_v2(1.0)×η` construction
  correctly catches a double-applied η (it would give a η² ratio). Verified sound.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | ✓ pass |
| HIGH     | 1     | ✅ resolved |
| MEDIUM   | 0     | — |
| LOW      | 2     | — note |

Verdict: ⚠ APPROVED WITH EDITS — the presence-gated whole-day rule resolves the one HIGH finding; two
hygiene edits applied inline (stale design-commit ref `bb098ec`→`35c98a0`; the `T11–T26` sub-header
numbering).

---

## Approval

**Status:** ⚠ Approved with edits — 2026-06-04
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:**
- The whole-day rule is **presence-gated** (absent fuel vs gap); design §2.5.2 is authoritative
  (commit `35c98a0`). The **mint** retains the both-null rule; only the **fit** is presence-gated.
- `applyHtcRescale` is a **named export**; the rescale tests unit-test it directly.
- The diagnostic getter **retains `htc_w_per_k` and adds `htc_used`** (no rename).
- The setpoint-rescale feedback path is **dormant** until m7-v2 lands (first pass `htc_used = htc`);
  the `app.js` call passes `null` for the payload.
- m3-v2 (Implemented, `98d47ae`) is the prerequisite for `app.js` integration; the `test-m4-v2.mjs`
  suite runs independently on synthetic data.
