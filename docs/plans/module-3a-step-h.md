# Module 3a — Baseload Separation: Step H (Supplementary Electric Load Detection)

**Date:** 2026-04-17
**Status:** Awaiting approval — review via claude.ai before implementation begins.
**Depends on:** `module-3a-gas-separation.md` — must be implemented and verified first.

---

## Task description

Implement Step H (supplementary electric load detection) as an extension to `js/baseload.js`.
Adds multi-variable OLS regression machinery with an exact t-distribution CDF, the
`detectSupplementaryLoads()` function, and extends the `separateBaseload()` orchestrator to
call Step H and return the full `{ heating, baseload_metadata, supplementary_loads }` result.

---

## Research findings

**t-distribution CDF — approach:** The original plan proposed Abramowitz & Stegun normal-CDF
approximation, justified as "t with df > 25 ≈ normal". The Opus plan review (issue H1) identified
systematic error: at df=30, α=0.01, the normal approximation gives p ≈ 0.006 against a true p of
0.010 (~6% bias). Since `p < 0.01` is the boundary between `moderate` and `high` confidence, and
those tiers drive module 4's Check 4D HTC correction, normal approximation silently inflates `high`
classifications and over-corrects module 4's HTC estimate. Exact p-values are required.

**Chosen implementation — regularised incomplete beta function via Lentz's continued fraction:**
The two-tailed p-value for test statistic |t| with df degrees of freedom is:
```
p = I( df / (df + t²),  df/2,  0.5 )
```
where `I(x; a, b)` is the regularised incomplete beta function. This can be computed to
floating-point precision via Lentz's continued fraction algorithm (Numerical Recipes §6.4,
pp. 263–265). The complete implementation is ~65 lines of vanilla JS, comprising:
- `betaCF(x, a, b)` — Lentz CF (~20 lines)
- `lgamma(z)` — log-gamma via Lanczos 7-term approximation (~10 lines, accurate to 1e-12)
- `incompleteBeta(x, a, b)` — normalised using lgamma, symmetry relation for large x (~15 lines)
- `tDistPValue(t, df)` — calls incompleteBeta with the t-to-beta mapping (~5 lines)

This is adopted over the Abramowitz & Stegun approach because: (a) it is exact (not an
approximation), (b) it covers all df from 1 upward, (c) it is the standard reference
implementation, and (d) at ~65 lines it comfortably fits the "no library" constraint.

**Multi-variable OLS:** Normal equations `(X'X)β = X'y` for a 3-column design matrix `[HDD, CDD, 1]`
on 30+ observations. 3×3 system: Gaussian elimination with partial pivoting, ~25 lines. Singularity
detected when pivot < 1e-10 (relative). Standard errors from `s² × (X'X)⁻¹` diagonal.

**Through-origin vs intercept fit:** The design doc is explicit: electricity has a real non-zero
baseline (fridge, lighting, standby). Through-origin forces the slope terms to absorb this baseline,
producing spurious positive HDD slopes even when there is no electric heating. The intercept column
`[1, 1, ..., 1]` must always be present. Test 18 specifically validates this.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/baseload.js` | Add OLS helpers, `detectSupplementaryLoads()`, extend orchestrator |

---

## Implementation steps

### Step 1 — OLS helper: `tDistPValue(t, df)` (Medium complexity)

Add to `js/baseload.js`. Returns two-tailed p-value for test statistic `t` with `df` degrees
of freedom using the exact t-distribution.

```
tDistPValue(t, df):
  x = df / (df + t * t)
  return incompleteBeta(x, df / 2, 0.5)
```

**`incompleteBeta(x, a, b)`** — regularised incomplete beta function I(x; a, b):
1. Boundary cases: `x === 0` → 0; `x === 1` → 1.
2. Symmetry relation: if `x > (a + 1) / (a + b + 2)`, return `1 - incompleteBeta(1 - x, b, a)`.
   This ensures the CF is evaluated on the side where it converges faster.
3. Normalisation factor: `logBetaNorm = lgamma(a) + lgamma(b) - lgamma(a + b)`.
4. Return `Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBetaNorm) * betaCF(x, a, b) / a`.

**`betaCF(x, a, b)`** — Lentz's algorithm for the continued fraction:
- Implements the modified Lentz's method (Numerical Recipes §6.4, `betacf` routine).
- Iterate up to 200 steps. Convergence criterion: `|delta - 1| < 1e-10`.
- Return CF value. (~20 lines)

**`lgamma(z)`** — log-gamma function via Lanczos's approximation (g=5, 7 coefficients):
- Coefficients: `[1.000000000190015, 76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.001208650973866179, -0.000005395239384953]`
- Valid for `z > 0`. (~10 lines)

**Verification targets** (spot-check during implementation):
- `tDistPValue(2.042, 30) ≈ 0.050` (±0.001) — boundary of moderate detection
- `tDistPValue(2.750, 30) ≈ 0.010` (±0.001) — boundary of high confidence

### Step 2 — OLS helper: `computeMultiOls(ys, xMatrix)` (Medium complexity)

Add to `js/baseload.js`. `xMatrix` is an array of row arrays; each inner array is one observation's
predictor values (intercept column included by caller). Returns
`{ coefficients, standardErrors, tStatistics, pValues, residualVariance }` or null if singular or
`n < p + 1` (underdetermined).

1. Derive `n = ys.length`, `p = xMatrix[0].length`.
2. Guard: if `n < p + 1`, return null.
3. Build `XtX` (p×p) and `Xty` (p-vector) by iterating over rows.
4. Augment `XtX` with identity to form a `[p × 2p]` system. Gaussian elimination with partial
   pivoting to solve for `β` and simultaneously compute `(XtX)⁻¹`. If any pivot < 1e-10 (relative
   to row maximum), return null (singular).
5. `β = coefficients` from the solved system.
6. Fitted values: `yhat[i] = Σ xMatrix[i][j] * β[j]`. Residuals: `e[i] = ys[i] - yhat[i]`.
7. `RSS = Σ e[i]²`. `residualVariance = RSS / (n - p)`.
8. `standardErrors[j] = Math.sqrt(residualVariance * invXtX[j][j])`.
9. `tStatistics[j] = β[j] / standardErrors[j]`.
10. `pValues[j] = tDistPValue(Math.abs(tStatistics[j]), n - p)`.

### Step 3 — `detectSupplementaryLoads(consumption, external, heating, baseloadMethod)` (High complexity)

Export function. Called from the orchestrator (Step 4) regardless of gas-separation outcome.

**Constants:**

```js
const STEP_H_MIN_DAYS = 30;
const ELECTRIC_HEATING_COEFF_THRESHOLD = 0.2;  // kWh/K·day
const AC_COEFF_THRESHOLD = 0.2;                 // kWh/K·day
const P_VALUE_DETECT = 0.05;
const P_VALUE_HIGH = 0.01;
const COEFF_HIGH = 0.5;
const COEFF_LOW = 0.1;
const P_VALUE_LOW_UPPER = 0.20;
const MIN_SUM_CDD_FOR_AC = 20;                  // K·day

const LIMITATIONS = [
  "Solar PV generation is not modelled. If your electricity consumption excludes generation (net metering) or exported energy, the fitted baseline may be distorted. Slope coefficients (HDD, CDD) are less affected because they measure gradient, not level.",
  "If you already have a heat pump or electric immersion tied to heating, it will show here as 'electric heating'. The tool cannot distinguish an existing heat pump from supplementary resistance heating.",
  "Electric water heating (e.g. immersion on a timer) is typically weather-independent and appears in the baseline rather than as heating. Usually acceptable but may inflate the baseline estimate.",
];
```

**H0 — Pre-flight:**

1. If every `consumption[i].elec_kwh` is null:
   return `{ method: 'skipped_no_electricity', days_used_in_fit: 0, ...allNulls, limitations: LIMITATIONS, warnings: [] }`.

2. Build daily regression dataset. For each date in `groupByDay(consumption)`:
   - Eligibility: all 48 HH periods non-null for `elec_kwh`; `is_absence === false` for all 48
     corresponding records in `heating[]`; `temp_c` non-null for all 48 corresponding `external` records.
   - In the no-gas case (`baseloadMethod === 'no-gas'`): the gas-presence check is relaxed — use
     `elec_kwh` presence as the binding constraint (gas is zeroed, not null).
   - Compute:
     ```
     daily_elec_kwh    = sum of elec_kwh over 48 HH records
     daily_mean_temp_c = mean of temp_c over 48 corresponding external records
     daily_hdd         = Math.max(0, HDD_BASE_TEMP - daily_mean_temp_c)
     daily_cdd         = Math.max(0, daily_mean_temp_c - CDD_BASE_TEMP)
     ```

3. If `days < STEP_H_MIN_DAYS` (30):
   return `{ method: 'skipped_insufficient_data', days_used_in_fit: days, ...allNulls, limitations: LIMITATIONS, warnings: [] }`.

**H1 — OLS regression:**

Build design matrix X (each row: `[daily_hdd, daily_cdd, 1]`) and response vector y (`daily_elec_kwh`).

Call `computeMultiOls(y, X)`. If null: treat as `skipped_insufficient_data`.

```
a = result.coefficients[0]   // HDD slope (kWh/K·day)
b = result.coefficients[1]   // CDD slope (kWh/K·day)
c = result.coefficients[2]   // intercept — baseline electricity (kWh/day)
p_a = result.pValues[0]
p_b = result.pValues[1]
sum_hdd = Σ daily_hdd
sum_cdd = Σ daily_cdd
```

**Anti-pattern: do NOT use a through-origin fit.** Intercept column `1` is always the third
column. `c` is always populated as `baseline_kwh_per_day`. Test 18 specifically catches this.

**H2 — Electric heating detection:**

```
electric_heating_detected = (a > ELECTRIC_HEATING_COEFF_THRESHOLD) AND (p_a < P_VALUE_DETECT)
```

If detected: `electric_heating_kwh_per_dd = a`, `electric_heating_kwh_estimate = a * sum_hdd`.
Else: both null.

Confidence:
- `'high'` — `a >= COEFF_HIGH` AND `p_a < P_VALUE_HIGH`
- `'moderate'` — detected but not high
- `'low'` — not detected, but `a > COEFF_LOW` AND `P_VALUE_DETECT <= p_a < P_VALUE_LOW_UPPER`
- `'none'` — otherwise

**H3 — AC detection:**

If `sum_cdd < MIN_SUM_CDD_FOR_AC`:
```
air_conditioning_detected = false
air_conditioning_kwh_per_dd = null
air_conditioning_kwh_estimate = null
air_conditioning_confidence = 'none'
ac_detection_note = 'insufficient_cdd_data'
```

Otherwise:
```
air_conditioning_detected = (b > AC_COEFF_THRESHOLD) AND (p_b < P_VALUE_DETECT)
ac_detection_note = null
```
If detected: `air_conditioning_kwh_per_dd = b`, `air_conditioning_kwh_estimate = b * sum_cdd`.
Confidence: same tier structure as H2.

**H4 — No-gas framing:**

```
electric_heating_is_primary = (baseloadMethod === 'no-gas') AND electric_heating_detected
```

**Output field mapping (complete):**

| Field | Source |
|-------|--------|
| `method` | `'regression'` when fit ran; `'skipped_insufficient_data'` / `'skipped_no_electricity'` otherwise |
| `days_used_in_fit` | length of daily regression dataset |
| `baseline_kwh_per_day` | `c` = `result.coefficients[2]` |
| `hdd_coefficient_kwh_per_dd` | `a` = `result.coefficients[0]` |
| `cdd_coefficient_kwh_per_dd` | `b` = `result.coefficients[1]` |
| `hdd_p_value` | `p_a` = `result.pValues[0]` |
| `cdd_p_value` | `p_b` = `result.pValues[1]` |
| `sum_hdd_k_day` | `sum_hdd` |
| `sum_cdd_k_day` | `sum_cdd` |
| `electric_heating_detected` | H2 rule |
| `electric_heating_kwh_per_dd` | `a` if detected, else null |
| `electric_heating_kwh_estimate` | `a * sum_hdd` if detected, else null |
| `electric_heating_confidence` | H2 confidence tiers |
| `electric_heating_is_primary` | H4 |
| `air_conditioning_detected` | H3 rule |
| `air_conditioning_kwh_per_dd` | `b` if detected, else null |
| `air_conditioning_kwh_estimate` | `b * sum_cdd` if detected, else null |
| `air_conditioning_confidence` | H3 confidence tiers |
| `ac_detection_note` | `'insufficient_cdd_data'` or null |
| `warnings` | always `[]` — Step H adds no runtime warnings |
| `limitations` | `LIMITATIONS` array — always populated |

Null/false values for all detection fields when `method !== 'regression'`.

### Step 4 — Extend `separateBaseload()` orchestrator (Low complexity)

Modify `separateBaseload(consumption, external)` in `js/baseload.js` (created in
`module-3a-gas-separation.md`):

After the gas-separation and no-gas branches complete (but before the return), add:

```js
const supplementary_loads = detectSupplementaryLoads(
  consumption, external, heating, baseload_metadata.method
);
```

Replace the stub return with:
```js
return { heating, baseload_metadata, supplementary_loads };
```

This is the final form of the public API, matching the design doc output spec.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| t-CDF implementation giving wrong p-values | Verified at two boundary points (see Step 1). Lentz CF is the standard reference implementation — deviation would require a code bug, not an approximation choice. |
| Normal-equation matrix singular (zero HDD variance, all-same-temperature data) | `computeMultiOls` returns null on near-zero pivot. Caller treats as `skipped_insufficient_data`. Test 21 verifies no crash. |
| Through-origin regression producing false positives | Intercept column always the third column. Test 18 validates `baseline_kwh_per_day ≈ 10` and `electric_heating_detected = false` on flat-baseline synthetic data. |
| AC false positive from noisy warm days in mostly-winter data | `sum_cdd >= 20 K·day` guard. `ac_detection_note` field distinguishes "couldn't evaluate" from "no signal". Test 20 validates. |
| p-value inflation → over-confident HTC correction in module 4 | Using exact t-CDF (not normal approximation). Boundary `tDistPValue(2.750, 30) ≈ 0.010` verified. |
| lgamma approximation error at boundary | Lanczos g=5 is accurate to ~1e-12 across positive reals — orders of magnitude tighter than p-value threshold granularity (0.01, 0.05). |
| Step H running before gas-separation (dependency violation) | Depends-on line states `module-3a-gas-separation.md` must be implemented first. `detectSupplementaryLoads` requires `heating[]` (with `is_absence` flags) produced by that plan. |

---

## Success criteria

### Step H — supplementary electric load detection
- [ ] Step H runs regardless of gas-separation outcome, including no-gas case (Tests 7, 17–22)
- [ ] OLS fit uses intercept — `baseline_kwh_per_day` populated; on flat-baseline test data ≈ 10 (Test 18)
- [ ] `electric_heating_detected = false` on flat-baseline data (Test 18 — catches through-origin)
- [ ] Electric heating detection triggers at coefficient > 0.2 AND p < 0.05 (Tests 17, 22)
- [ ] `electric_heating_kwh_per_dd ≈ 0.8` (within 15% of truth) on Test 17 synthetic data
- [ ] AC detection triggers at coefficient > 0.2 AND p < 0.05 AND sum_cdd ≥ 20 (Test 19)
- [ ] AC detection skipped with `ac_detection_note = 'insufficient_cdd_data'` when sum_cdd < 20 (Test 20)
- [ ] Confidence tiers correctly assigned: high (≥0.5 AND p<0.01), moderate (detected, not high), low (suggestive), none (Tests 17, 22)
- [ ] `electric_heating_is_primary = true` when no-gas + electric detected (Test 22)
- [ ] `supplementary_loads.limitations` always populated with 3 MVP strings (all tests)
- [ ] Insufficient data (<30 days) → `method = 'skipped_insufficient_data'`, all detection false, no crash (Test 21)
- [ ] No electricity data → `method = 'skipped_no_electricity'`, no crash
- [ ] `separateBaseload()` returns `{ heating, baseload_metadata, supplementary_loads }` after extension

### OLS implementation
- [ ] `tDistPValue` uses incomplete beta / Lentz CF, NOT normal approximation
- [ ] Spot-check: `tDistPValue(2.042, 30) ≈ 0.050` (±0.001) — moderate detection boundary
- [ ] Spot-check: `tDistPValue(2.750, 30) ≈ 0.010` (±0.001) — high confidence boundary
- [ ] `computeMultiOls` returns null on singular matrix, no crash

### Design doc test mapping

| Test | Covers |
|------|--------|
| 17 | Electric heating positive — coefficient recovery, high confidence, baseline populated |
| 18 | Electric heating negative — through-origin anti-pattern, `baseline_kwh_per_day ≈ 10` |
| 19 | AC detection positive — both detected independently, coefficients recovered |
| 20 | AC skipped — no summer data, `ac_detection_note = 'insufficient_cdd_data'` |
| 21 | Skipped — <30 usable days, `skipped_insufficient_data`, no crash |
| 22 | Combined — both detected, `electric_heating_is_primary` flag in no-gas case |

Tests 1–16 (gas separation) are in `module-3a-gas-separation.md`.

---

## Design Review

[To be completed by Opus on resubmission]

---

## Approval

**Status:** Awaiting approval — review via claude.ai before implementation begins.

---

## Implementation Deviations

[To be completed during implementation]
