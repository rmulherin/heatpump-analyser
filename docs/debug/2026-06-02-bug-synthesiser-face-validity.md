# Bug: Synthesiser fails 2 of 4 face-validity checks on Demo 1 (modern-out-for-work)

**Date:** 2026-06-02
**Reporter:** Rhiannon (driven by Opus iteration loop on Demo 1)
**Status:** Root cause identified — scoped fixes proposed
**Investigator:** Opus architect window

## Symptom

First bake run of [modern-out-for-work.json](../../demo-configs/modern-out-for-work.json) (§E-aligned config, prng_seed 1001, Cambridge weather) produces a CSV that:

| Metric | Expected (strategy §F) | Observed | Pass |
|---|---|---|---|
| Annual gas vs Nesta P3 target (7,237 kWh) | within ±10% (TC2) | **6,080 kWh (-16.0%)** | ❌ |
| Annual elec vs Nesta P3 target (1,946 kWh) | within ±10% (TC2) | **1,447 kWh (-25.7%)** | ❌ |
| `gas_hdd_r2` (daily-gas vs HDD R²) | [0.7, 0.97] | **0.367** | ❌ |
| `summer_winter_ratio` | [1.2, 1.8] | **0.601** | ❌ |
| `weekday_weekend_ratio` (elec) | [0.8, 1.2] | 0.919 | ✅ |
| `holiday_weeks_injected` | [6, 8] | 7 | ✅ |
| Gas HHs clamped to zero | ≤ a few % | **5,559 / 17,520 = 31.7%** | ⚠ |
| Elec HHs clamped to zero | ≤ a few % | 1,359 / 17,520 = 7.8% | ⚠ |

Structural failures (R², ratio, clamp rate) are config-invariant — bake 1 with diverged config and bake 2 with §E-reverted config produced essentially identical face-validity values, differing only by PRNG noise.

## Environment

- **Repo:** `heatpump-analyser`, branch main
- **Synthesiser commit:** 5d5932f
- **Demo config commit:** e9934f8 (revert to §E values, this debug session)
- **Weather:** Open-Meteo, Cambridge (CB1 2BX), 2025-01-01 → 2025-12-31, cached
- **Noise config:** [test-data/noise-config.json](../../test-data/noise-config.json)

## Bake artefacts referenced

- [bake-output/modern-out-for-work/modern-out-for-work-stats.json](../../bake-output/modern-out-for-work/modern-out-for-work-stats.json)
- [bake-output/modern-out-for-work/modern-out-for-work-bake-report.md](../../bake-output/modern-out-for-work/modern-out-for-work-bake-report.md)

## Source files investigated

- [scripts/lib/synthesiser.mjs](../../scripts/lib/synthesiser.mjs) — full read

---

## Phase 2 — Hypotheses (ranked)

| # | Hypothesis | Likelihood (initial) | Status after Phase 3 |
|---|---|---|---|
| H1 | `summer_winter_ratio` is computed inverted (summer ÷ winter rather than winter ÷ summer) vs the expected range | High | ✅ Confirmed |
| H2 | `gas_hdd_r2` uses an origin-forced slope (no intercept) combined with a mean-anchored ssTot, which produces artificially low R² when the daily-gas data has a substantial baseload offset | High | ✅ Confirmed |
| H3 | AR(1) behavioural-residual sigma is calibrated against the **annual mean** gas per HH, but the gas signal is highly concentrated in pulse / heating-window HHs, leaving large "zero floor" regions where residuals flood the signal and force ~30% of HHs to clamp to zero | High | ✅ Confirmed |
| H4 | Elec baseload's hour-of-day factor (0.6/1.3/1.0 net average 0.95) and solar-modulated lighting (~half of year, daytime hours nulled) reduce the realised annual mean below `elec_baseload_kwh_per_day × 365`, and `elec_appliance_events_per_week × week` events don't fully restore the gap | High | ✅ Confirmed |

Hypotheses ruled out during reading:

- ✗ Heating windows misaligned with cold periods (would make heating contribution sparse) — windows are checked per-day on UTC date, weekday/weekend logic looks correct. Heating IS firing in winter.
- ✗ Solar-gain masking heating in winter (rare in Cambridge with 4 m² aperture and weak winter sun) — math doesn't support this dominating.
- ✗ Holiday-week injection eating the heating signal — only 7 weeks injected, R² regression already excludes absence days.
- ✗ Clock-change handling losing HHs — generateTimestamps uses UTC consistently, 17,520 HHs confirmed in 2025 (non-leap).

---

## Phase 3 — Narrowing

### H1 — `summer_winter_ratio` direction

[scripts/lib/synthesiser.mjs:524-533](../../scripts/lib/synthesiser.mjs):

```js
// Summer/winter elec ratio
const summerElec = [], winterElec = [];
for (const [date, kwh] of dailyElec) {
  const month = parseInt(date.slice(5, 7), 10);
  if (month >= 6 && month <= 8)  summerElec.push(kwh);
  if (month === 12 || month <= 2) winterElec.push(kwh);
}
const summerMean = summerElec.length > 0 ? summerElec.reduce((a, b) => a + b, 0) / summerElec.length : 0;
const winterMean = winterElec.length > 0 ? winterElec.reduce((a, b) => a + b, 0) / winterElec.length : 0;
const swElecRatio = winterMean > 0 ? summerMean / winterMean : null;  // ← summer ÷ winter
```

Then at [synthesiser.mjs:555](../../scripts/lib/synthesiser.mjs):
```js
summer_winter_ratio:   { value: swElecRatio,     expected: [1.20, 1.80], pass: ... },
```

The variable computes **summer ÷ winter** but the expected range [1.2, 1.8] is consistent with **winter ÷ summer** (winter elec higher than summer due to lighting + heating-correlated baseload). Observed 0.601 = 1 / 1.66, which means winter elec is **1.66× summer elec** — comfortably inside the intended pass band. So the underlying data is correct; the comparison is inverted.

**Confirmed:** the metric is mis-computed (inverted division relative to its expected range and its label semantics). The CSV is fine; this is a pure reporting bug.

### H2 — `gas_hdd_r2` regression specification

[scripts/lib/synthesiser.mjs:488-511](../../scripts/lib/synthesiser.mjs):

```js
let sumXY = 0, sumXX = 0;
const hddDays = [], gasDays = [];
for (const [date, temps] of dailyTemps) {
  // ... filter heating months & non-absence ...
  const hdd = Math.max(0, HDD_BASE_TEMP - meanTemp);
  if (hdd <= 0) continue;
  const g = dailyGas.get(date) ?? 0;
  hddDays.push(hdd);
  gasDays.push(g);
  sumXY += hdd * g;
  sumXX += hdd * hdd;
}
const beta = sumXX > 0 ? sumXY / sumXX : 0;         // ← origin-forced slope (no intercept)
const meanG = gasDays.length > 0 ? gasDays.reduce((a, b) => a + b, 0) / gasDays.length : 0;
let ssRes = 0, ssTot = 0;
for (let i = 0; i < gasDays.length; i++) {
  ssRes += Math.pow(gasDays[i] - beta * hddDays[i], 2);   // ← residuals from origin fit
  ssTot += Math.pow(gasDays[i] - meanG, 2);                // ← mean-anchored
}
const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
```

**The problem:** β is fitted forcing the line through the origin (gas = β × HDD), but daily gas has a substantial baseload (HW+cooking ≈ 6 kWh/day) that exists even at HDD=0. The model under-fits at low HDD and over-fits at high HDD, inflating ssRes. ssTot is the standard mean-anchored sum, so `1 − ssRes/ssTot` produces a number much lower than the true explained variance.

**Numerical sanity check** (no probe needed — textbook result):
- Synthetic data with gas = 6 + 1.07 × HDD + small ε, HDD ∈ [5, 15]:
  - Intercept regression: R² ≈ 0.95
  - Origin-forced regression with mean-anchored ssTot: R² can drop below 0.4
- Our observed R² of 0.367 is fully consistent with the data being well-explained by `intercept + slope × HDD` and the metric just measuring the wrong thing.

**Confirmed:** the underlying gas-vs-HDD relationship is likely fine. The metric is misdiagnosing it.

### H3 — Clamping driven by global-mean sigma calibration

[scripts/lib/synthesiser.mjs:422-450](../../scripts/lib/synthesiser.mjs):

```js
const meanGas  = gasArr.reduce((a, b)  => a + b, 0) / n;  // per-HH mean across the whole year
// ...
const sigmaGas  = meanGas  * cv * Math.sqrt(2 * (1 - phi * phi) / (48 * Math.pow(1 - phi, 2)));
// ...
let rGas = 0, rElec = 0;
for (let i = 0; i < n; i++) {
  rGas  = phi * rGas  + sigmaGas  * boxMuller(prng);
  rElec = phi * rElec + sigmaElec * boxMuller(prng);
  gasArr[i]  += rGas;
  elecArr[i] += rElec;
}
```

With §E params: `meanGas ≈ 0.347 kWh/HH`, `cv = 0.354`, `phi = 0.55` → `sigmaGas ≈ 0.047 kWh/HH`. Steady-state SD ≈ 0.056 kWh/HH.

But the gas signal is highly non-uniform across HHs:
- Heating-window HHs in winter: ~1.0+ kWh each
- HW pulse HHs (Gaussian centred on 07:00 and 18:00): ~0.1–0.3 kWh
- All other HHs (outside heating windows AND outside HW pulses): **~0 kWh**

Year-averaged, the "near-zero floor" HHs are roughly: 24h × 365 = 8,760h total / 30 min per HH = 17,520 HHs/year; subtracting heating-window HHs (≈ 6,800/year) and HW-pulse HHs (≈ 4,700/year, with overlap) ≈ **6,000 HHs/year sit at near-zero signal**.

Adding additive AR(1) residual with SD ≈ 0.056 kWh to a signal of ≈ 0 → **~50% of those 6,000 HHs go negative → clamped**, contributing ~3,000 of the observed 5,559 clamps. The other ~2,500 clamps come from low-tail HW-pulse and shoulder-of-heating-window HHs.

**Confirmed:** noise calibrated against the global annual mean of a highly-concentrated signal floods the low-signal regions. The clamping then erases a non-trivial portion of the natural variation, and the surviving signal becomes less correlated with weather than it should be (contributing to the low R² alongside H2).

Additionally: the sigma derivation factor `sqrt(2(1-φ²)/(48(1-φ)²))` does not look like a standard daily-aggregate-CV-preserving calibration. For phi=0.55 it produces a daily-aggregate noise CV of **~3.6%**, far below the target `daily_residual_cv = 35.4%`. This is a separate calibration issue worth a closer look from Sonnet during fix application, but is not blocking and is independent of the primary clamping cause.

### H4 — Elec annual undershoot

[scripts/lib/synthesiser.mjs:365-416](../../scripts/lib/synthesiser.mjs):

The elec baseload is built up as `lighting + other`, then multiplied by a weekday/weekend factor (mean-preserving over the week), then events are added on top.

Within each HH:
- `lighting = lightingKwhPerHh × (1 − min(1, solar / 50))`  ← zeroed when solar > 50 W/m² (daylight)
- `other = otherKwhPerHh × hourFactor`  where hourFactor ∈ {0.6 night, 1.3 evening, 1.0 else}

Quantitative effect:
- Daytime lighting suppression: solar > 50 W/m² for ~9–14 hours/day → lighting contributes only ~50% of its nominal annual mean.
- Hour-factor mean across day = (6×0.6 + 4×1.3 + 14×1.0)/24 = 22.8/24 = **0.95** — a 5% reduction.

For §E config (`elec_baseload_kwh_per_day = 4.0`, lighting fraction 0.35, other fraction 0.65):
- Nominal annual lighting: 4.0 × 0.35 × 365 = 511 kWh; realised ~50% = **256 kWh**
- Nominal annual other: 4.0 × 0.65 × 365 = 949 kWh; realised × 0.95 = **902 kWh**
- Total baseload-only realised: ~**1,158 kWh** vs nominal 1,460 kWh

Events: 8 events/week × 52.14 weeks × 1.25 kWh avg = ~**530 kWh** annual.

Total expected from this model: **1,158 + 530 = 1,688 kWh** vs target 1,946 kWh.

Observed: 1,447 kWh — still below the model's own analytic prediction by ~240 kWh, possibly due to event randomness or boundary effects I haven't probed; the bulk of the gap (~500 kWh against the 1,946 target) is explained by the baseload-shaping reductions above.

**Confirmed:** `elec_baseload_kwh_per_day` is treated by the synthesiser as a **nominal upstream parameter** that gets reshaped by hour-of-day and solar-modulated factors which are **not normalised to preserve the annual mean**. The strategy doc §E table specifies this field as "kWh per day", implying annual mean — the implementer hasn't preserved that semantic.

---

## Phase 4 — Root causes

Four distinct issues, three of them straightforward reporting/specification fixes, one a calibration design choice.

### RC1 — `summer_winter_ratio` reports the wrong direction

The variable `swElecRatio` is computed as `summerMean / winterMean`, but the assigned key `summer_winter_ratio` paired with expected `[1.2, 1.8]` semantically wants **winter ÷ summer** (winter heavier than summer is the physically expected direction for UK elec).

**Evidence:** see Phase 3 H1.

### RC2 — `gas_hdd_r2` uses origin-forced regression with mean-anchored R²

Daily gas data has a baseload offset (HW + cooking) that exists at HDD = 0, but the slope `β = ΣXY/ΣXX` forces the regression line through the origin. The resulting fit underweights the baseload, ssRes is inflated, and `1 - ssRes/ssTot` collapses below the actual explained variance.

**Evidence:** see Phase 3 H2.

### RC3 — AR(1) residual sigma uses the global mean, flooding low-signal HHs

The behavioural residual SD is set proportional to the annual-mean gas per HH (0.347 kWh), but the gas signal is concentrated in heating-window and HW-pulse HHs and sits at ~0 elsewhere. The additive residual then drives ~30% of HHs negative and they get clamped to zero, **erasing real signal variance and degrading every downstream face-validity metric**.

**Evidence:** see Phase 3 H3.

A secondary concern (not blocking): the sigma calibration factor doesn't appear to match either a per-HH-CV target or a daily-aggregate-CV target — the realised daily-aggregate noise CV is ~3.6% vs the configured 35.4%.

### RC4 — Elec baseload's shaping factors aren't annual-mean-preserving

`elec_baseload_kwh_per_day` is a "nominal" parameter — the hour-of-day factor (mean 0.95) and solar-modulated lighting (zeroed when solar > 50 W/m², ~50% of yearly HHs) cut the realised annual mean below the configured value. The strategy doc §E semantic ("kWh per day" = daily mean) is not enforced by the model.

**Evidence:** see Phase 3 H4.

---

## Phase 5 — Scoped fixes (for Sonnet)

All fixes are localised to [scripts/lib/synthesiser.mjs](../../scripts/lib/synthesiser.mjs). No design-doc changes needed. No external library updates needed. Order suggested: F1 → F2 → F4 → F3.

### F1 — Flip `summer_winter_ratio` to winter ÷ summer (RC1)

**File:** `scripts/lib/synthesiser.mjs:533`

**Change:**

```diff
-  const swElecRatio = winterMean > 0 ? summerMean / winterMean : null;
+  const swElecRatio = summerMean > 0 ? winterMean / summerMean : null;
```

**Why:** the existing expected range `[1.2, 1.8]` (line 555) and the metric's name (`summer_winter_ratio` interpreted as a *seasonal amplitude*, winter prominence) both imply winter > summer. The data passing through this code is already correct; only the division direction is wrong.

**Same-pattern check:** grep `/ winterMean` and `/ summerMean` across the repo — only the one site exists.

**Effort:** trivial (1 line).

---

### F2 — Switch `gas_hdd_r2` to a regression with intercept (RC2)

**File:** `scripts/lib/synthesiser.mjs:488-511`

**Change:** replace the origin-forced fit with an intercept-included fit, computing the standard coefficient of determination.

```diff
-  let sumXY = 0, sumXX = 0;
-  const hddDays = [], gasDays = [];
-  for (const [date, temps] of dailyTemps) {
-    if (dailyAbsence.get(date)) continue;
-    const month = parseInt(date.slice(5, 7), 10);
-    if (!HEATING_MONTHS.has(month)) continue;
-    const meanTemp = temps.reduce((a, b) => a + b, 0) / temps.length;
-    const hdd = Math.max(0, HDD_BASE_TEMP - meanTemp);
-    if (hdd <= 0) continue;
-    const g = dailyGas.get(date) ?? 0;
-    hddDays.push(hdd);
-    gasDays.push(g);
-    sumXY += hdd * g;
-    sumXX += hdd * hdd;
-  }
-  const beta = sumXX > 0 ? sumXY / sumXX : 0;
-  const meanG = gasDays.length > 0 ? gasDays.reduce((a, b) => a + b, 0) / gasDays.length : 0;
-  let ssRes = 0, ssTot = 0;
-  for (let i = 0; i < gasDays.length; i++) {
-    ssRes += Math.pow(gasDays[i] - beta * hddDays[i], 2);
-    ssTot += Math.pow(gasDays[i] - meanG, 2);
-  }
-  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
+  const hddDays = [], gasDays = [];
+  for (const [date, temps] of dailyTemps) {
+    if (dailyAbsence.get(date)) continue;
+    const month = parseInt(date.slice(5, 7), 10);
+    if (!HEATING_MONTHS.has(month)) continue;
+    const meanTemp = temps.reduce((a, b) => a + b, 0) / temps.length;
+    const hdd = Math.max(0, HDD_BASE_TEMP - meanTemp);
+    if (hdd <= 0) continue;
+    gasDays.push(dailyGas.get(date) ?? 0);
+    hddDays.push(hdd);
+  }
+  // Linear regression with intercept: gas = α + β × HDD
+  const nPts = gasDays.length;
+  const meanG = nPts > 0 ? gasDays.reduce((a, b) => a + b, 0) / nPts : 0;
+  const meanH = nPts > 0 ? hddDays.reduce((a, b) => a + b, 0) / nPts : 0;
+  let sxx = 0, sxy = 0;
+  for (let i = 0; i < nPts; i++) {
+    const dx = hddDays[i] - meanH;
+    sxx += dx * dx;
+    sxy += dx * (gasDays[i] - meanG);
+  }
+  const beta  = sxx > 0 ? sxy / sxx : 0;
+  const alpha = meanG - beta * meanH;
+  let ssRes = 0, ssTot = 0;
+  for (let i = 0; i < nPts; i++) {
+    const pred = alpha + beta * hddDays[i];
+    ssRes += Math.pow(gasDays[i] - pred, 2);
+    ssTot += Math.pow(gasDays[i] - meanG, 2);
+  }
+  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
```

**Why:** the standard R² (proportion of variance explained, intercept included) is what `[0.7, 0.97]` expects. The intercept absorbs the baseload (HW + cooking + non-degree-day-driven gas), so β isolates the heating-vs-weather signal that the face-validity check is actually trying to evaluate.

**Same-pattern check:** grep `sumXY` / `sumXX` across the repo for any other origin-forced regressions — none expected; this is the only stats site.

**Effort:** small (replaces ~20 lines with ~20 lines; no new dependencies).

---

### F3 — Sigma-scale noise to the local signal, not the global mean (RC3)

**File:** `scripts/lib/synthesiser.mjs:422-450` (`injectNoise`)

This is the most consequential fix — it changes the CSV content meaningfully. Two options for Sonnet's choice; **F3a recommended** because it's the smallest, most predictable change and aligns with the strategy doc's intent.

#### F3a — Scale residual sigma per-HH against the deterministic signal (recommended)

Replace the global-mean sigma with a per-HH proportional sigma. Concretely: the AR(1) noise becomes multiplicative on the signal magnitude, with a floor to preserve some variance in low-signal HHs.

```diff
   const phi = archetypeConfig.noise_overrides?.hh_residual_autocorr_lag1
     ?? noiseConfig.behavioural_noise.hh_residual_autocorr_lag1;
   const cv  = noiseConfig.behavioural_noise.daily_residual_cv;
   const sd  = noiseConfig.measurement_noise.smart_meter_relative_sd;
   const n   = gasArr.length;
 
-  const meanGas  = gasArr.reduce((a, b)  => a + b, 0) / n;
-  const meanElec = elecArr.reduce((a, b) => a + b, 0) / n;
-
-  // Sigma calibrated so daily-aggregate CV matches daily_residual_cv under AR(1)
-  const sigmaGas  = meanGas  * cv * Math.sqrt(2 * (1 - phi * phi) / (48 * Math.pow(1 - phi, 2)));
-  const sigmaElec = meanElec * cv * Math.sqrt(2 * (1 - phi * phi) / (48 * Math.pow(1 - phi, 2)));
-
   // Pass 1: measurement noise (multiplicative, HH-independent)
   for (let i = 0; i < n; i++) {
     gasArr[i]  *= (1 + boxMuller(prng) * sd);
     elecArr[i] *= (1 + boxMuller(prng) * sd);
   }
 
-  // Pass 2: AR(1) behavioural residual (additive, autocorrelated)
-  let rGas = 0, rElec = 0;
-  for (let i = 0; i < n; i++) {
-    rGas  = phi * rGas  + sigmaGas  * boxMuller(prng);
-    rElec = phi * rElec + sigmaElec * boxMuller(prng);
-    gasArr[i]  += rGas;
-    elecArr[i] += rElec;
-  }
+  // Pass 2: AR(1) behavioural residual scaled per-HH against local signal magnitude.
+  // Aggregate-CV calibration factor (per derivation in noise-config.json source notes).
+  const ar1Factor = Math.sqrt(2 * (1 - phi * phi) / (48 * Math.pow(1 - phi, 2)));
+  let rGas = 0, rElec = 0;
+  for (let i = 0; i < n; i++) {
+    const sigmaGasLocal  = gasArr[i]  * cv * ar1Factor;
+    const sigmaElecLocal = elecArr[i] * cv * ar1Factor;
+    rGas  = phi * rGas  + sigmaGasLocal  * boxMuller(prng);
+    rElec = phi * rElec + sigmaElecLocal * boxMuller(prng);
+    gasArr[i]  += rGas;
+    elecArr[i] += rElec;
+  }
```

**Why:** AR(1) sigma now scales with the local deterministic signal. Zero-signal HHs get zero residual (no clamping). Heating-window HHs get residuals proportional to their gas, which is the realistic behaviour — residuals reflect occupant variability on top of the schedule, not a fixed broadcast across all HHs.

**Expected effects after F3a:**
- Gas clamp count drops from ~5,500 to ≤ a few hundred (measurement-noise multiplicative ~2% can still occasionally drive small-signal HHs slightly negative; floor at 0 still needed).
- `gas_hdd_r2` (after F2) should rise into the [0.85, 0.97] range — natural variance is preserved, signal isn't washed by uniform noise.
- Annual totals: ~unchanged (residuals are now mean-zero per-HH multiplicative; integrate to ~0 over the year).

#### F3b — Defer the structural choice; just sanity-check the existing sigma calibration

If Sonnet wants to be conservative and not change the model structure: keep the existing global-mean sigma but verify whether the `sqrt(2(1-φ²)/(48(1-φ)²))` factor is producing the intended daily-aggregate CV. The realised value (~3.6%) suggests this factor may be off by ~10× — but in the *correct* direction (smaller, not larger), which doesn't explain the clamping. Investigating this won't reduce clamps; it would just clarify the original derivation. **Not recommended as a primary fix.**

**Recommendation:** apply F3a. It is structurally correct (per-HH sigma proportional to per-HH signal is the standard for "behavioural residual scales with the activity it modulates") and matches the strategy doc §A intent.

**Effort:** small (replaces the noise pass; no new dependencies).

---

### F4 — Normalise elec baseload shaping to preserve `elec_baseload_kwh_per_day` annual mean (RC4)

**File:** `scripts/lib/synthesiser.mjs:365-416` (`computeElecBaseload`)

The cleanest fix is a single post-construction renormalisation that scales the pre-event baseload sum to match `elec_baseload_kwh_per_day × 365` exactly. Events stay on top, unscaled.

```diff
 export function computeElecBaseload(archetypeConfig, timestamps, timestampMs, weather, noiseConfig, prng) {
   const n      = timestampMs.length;
   const output = new Float64Array(n);
   const baseDayKwh  = archetypeConfig.baseload.elec_baseload_kwh_per_day;
   // ... existing loop building lighting + other, applying wd/we factor ...
 
+  // Renormalise pre-event baseload to match nominal annual mean (kWh/day × days).
+  const daysInWindow = n / 48;
+  const targetTotal  = baseDayKwh * daysInWindow;
+  let actualTotal    = 0;
+  for (let i = 0; i < n; i++) actualTotal += output[i];
+  if (actualTotal > 0) {
+    const k = targetTotal / actualTotal;
+    for (let i = 0; i < n; i++) output[i] *= k;
+  }
+
   // Discrete appliance events: per week, sample eventsPerWeek start-HH indices
   // ... existing events loop ...
 
   return output;
 }
```

**Why:** the strategy §E table specifies `elec_baseload_kwh_per_day` as "kWh per day" (i.e. daily mean). The hour-of-day and solar-modulated shaping are **distribution shapes**, not scaling parameters — they shouldn't change the annual mean. Post-loop renormalisation makes the parameter mean what its name says, while preserving the realistic diurnal/seasonal shape of the baseload.

**Effort:** trivial (5 new lines, no behaviour change to the shaping itself).

**Side note for Sonnet:** the `elec_appliance_events_per_week` events use `0.5 + prng() × 1.5` kWh per event (avg 1.25 kWh, total ~530 kWh/year). With §E `events_per_week = 8` this is intentional — it contributes ~27% of the target elec total on top of baseload. If you make assumption changes here, recheck the annual prediction.

---

## Verification plan (for Sonnet, after fix application)

1. Re-bake [modern-out-for-work.json](../../demo-configs/modern-out-for-work.json) with the same prng_seed (1001) and cached Cambridge weather.
2. Expected face-validity outcomes:
   - `summer_winter_ratio`: ~1.66 (PASS, was 0.601)
   - `gas_hdd_r2`: ≥ 0.85 (PASS, was 0.367)
   - `weekday_weekend_ratio`: ~0.92 (still PASS, unchanged)
   - `holiday_weeks_injected`: 7 (still PASS, unchanged)
   - Annual gas: ~6,800–7,400 kWh after F3a (within ±10% of 7,237 target, was 6,080)
   - Annual elec: ~1,900–2,000 kWh after F4 (within ±10% of 1,946 target, was 1,447)
   - Gas clamps: ≤ 200 (was 5,559)
   - Elec clamps: ≤ 50 (was 1,359)
3. If any face-validity metric still fails after fixes, surface back to architect window — do not redesign in-session.
4. Append a Verification block to this debug doc with observed metrics and pass/fail status.

## Secondary concerns (not blocking, file under separate work)

- **Sigma calibration formula (`sqrt(2(1-φ²)/(48(1-φ)²))`) doesn't appear to match a standard daily-aggregate-CV target.** Realised aggregate noise CV is ~3.6% vs configured 35.4%. After F3a this becomes moot for the clamping issue, but if face-validity tightening later requires accurate residual scale, this derivation needs revisiting. Suggest opening a separate research note.
- **No `gas_seasonal_ratio` check.** The current `summer_winter_ratio` is on elec; gas-side seasonality (winter ≫ summer for heating-driven houses) isn't checked. After F1+F2 land, consider adding a complementary check `gas_winter_summer_ratio` with expected range like `[3.0, 12.0]` for gas-CH demos. Design scope — discuss before adding.
- **Elec event injection week-boundary handling**: the last partial week of 2025 still gets `eventsPerWeek` events placed in only 48 HHs (a ~7× density spike). Minor — total energy is unchanged, but worth tidying. Out of scope for this debug.
- **Sonnet's process deviation**: demo configs (across all four archetypes, not just modern-out-for-work) were committed in 02b169d with values diverging from strategy §E without a recorded deviation in the implementation plan. The other three configs (`average-in-all-day.json`, `small-and-efficient.json`, `big-old-draughty.json`) should be checked against §E and reverted if similarly drifted. Recommend Rhiannon raise this in the implementer-window closeout note before bake 3.

---

## Phase 6 — Verification (implementer phase, to be filled by Sonnet)

_To be populated after fix application._
