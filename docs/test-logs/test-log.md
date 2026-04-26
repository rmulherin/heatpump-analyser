# Heat Pump Analyser — Test Log

Running record of all test executions. Each entry records date, environment, result, and any notes.

**Legend:** ✅ Pass | ❌ Fail | ⏭ Validated via Node suite | 🔧 Fixed | ⏳ Not yet run

---

## 2026-04-26

**Environment:** Windows 11, Node v24 (synthetic), Chrome browser (real data: Rhiannon's Octopus account, 2025-04-26 → 2026-04-24, 364 days)

---

### M4 — Heat Loss Estimation: Node synthetic suite (test-m4.mjs)

Ran via `node test-m4.mjs` in `heatpump-analyser/`. All 62 assertions cover plan tests T1–T20.

| Test | Description | Result | Notes |
|------|-------------|--------|-------|
| T1a–T1f | Synthetic HTC recovery — htc not null, 225–275 W/K, solar 2.4–3.6 m², correction applied, good/acceptable status, 30 days used | ✅ | seed=42, 30 days, 10% noise |
| T2a–T2c | Absence exclusion — htc returned, days_used still 30, htc unchanged ±5% | ✅ | |
| T3a–T3b | Solar correction — aperture returned, R within 20% of true | ✅ | |
| T3c | Solar correction changes HTC by >5 W/K (direction not asserted — physical analysis showed 1-pred direction depends on solar-DD covariance structure) | ✅ | Design doc stated "higher" direction; mathematical analysis proved direction depends on B vs threshold ~2.538; physical B ≈ 0.192 makes "lower" the typical case. Test rewritten to test magnitude only. |
| T3d | 1-pred solar_correction_applied false | ✅ | |
| T4a–T4d | Negative R fallback — solar_correction_applied false, aperture null, htc present, warning surfaced | ✅ | |
| T5a–T5c | HTC plausibility bounds — HTC>1500 → poor + warning, HTC<50 → poor | ✅ | |
| T6a–T6d | Insufficient data (15 days) — htc null, insufficient_data status, days_used 0, warning present | ✅ | |
| T7a–T7b | Cross-module constant — degree_day_base_c = HDD_BASE_TEMP = 15.5 | ✅ | |
| T8 | Boiler efficiency scaling — ratio matches η scaling | ✅ | |
| T9a–T9b | Through-origin OLS — clean data recovers ~250 W/K; offset data inflates HTC | ✅ | T9 redesigned: original "constant offset → poor R²" fails for through-origin (intercept absorbed into slope). Correct test is offset inflates HTC, which IS the no-intercept behaviour. |
| T10a–T10e | HTC rating boundaries — 100→excellent, 200→good, 300→average, 450→poor, 600→very_poor | ✅ | |
| T11a–T11e | Solar rating boundaries — 1→minimal, 3→moderate, 5→good, 9→high, 15→very_high | ✅ | |
| T12a–T12f | Check 4D — high: correction ≈41.67, adjusted=htc+correction; mod: correction present; low/off: null | ✅ | Bug fixed: `!== null` → `!= null` for `electric_heating_kwh_estimate` (commit 27d88e6); field was undefined not null when not set |
| T13–T16 | Cooling consideration — significant/worth_noting/minimal (leaky/low solar) | ✅ | |
| T17a–T17d | Cooling null on solar fallback | ✅ | |
| T18a–T18b | HLP = htc/area; null when no area | ✅ | |
| T19a–T19b | CI sanity — 30-day half-width 10–80 W/K; 100-day tighter than 30-day | ✅ | |
| T20a–T20e | No-gas passthrough — htc null, no_gas status, no warnings, solar null, adjustment null | ✅ | |

**Total: 62/62 ✅**  
**Commit:** 27d88e6 (bug fix applied during this session)

---

### M4 — Real-data result on Rhiannon's house (2026-04-26)

| Field | Value |
|-------|-------|
| htc_w_per_k | **207 W/K** |
| htc_confidence_interval_95 | 190–223 W/K (half-width ±16.5 W/K) |
| rating | **good** (150–250 W/K band) |
| solar_aperture_m2 | 0.5 m² (consistent with very few windows) |
| solar_correction_applied | true |
| regression_r2 | **0.844** (excellent fit) |
| days_used_in_fit | 172 |
| validation_status | good |
| htc_correction_w_per_k | 14.6 W/K (cold-weather electricity uplift, confidence=moderate) |
| htc_w_per_k_adjusted | 221 W/K |
| hlp_w_per_m2_k | null (no floor area entered) |
| warnings | Cold-weather electricity uplift warning only |

Real-data browser assertions (console script, 2026-04-26, 33/33 ✅):

| Test | Description | Result |
|------|-------------|--------|
| T7/T16 | degree_day_base_c === 15.5 | ✅ |
| T12 | 4D correction = 14.6 W/K; adjusted = htc + correction | ✅ |
| T18 | HLP null (no floor area entered) | ✅ |
| T1–T11, T13–T17, T19–T20 | Synthetic — validated via Node suite 62/62 | ⏭ |

---

### M3 Step F patch — Absence detection (browser, real data)

Validated via `window.__getBaseloadResult().baseload_metadata.absence_periods` on Rhiannon's real data. Run 2026-04-26, console script batch.

Detected periods: 2025-05-06→08 (3d), 2025-05-30→06-01 (3d), 2025-07-21 (1d), 2025-08-24→30 (7d), 2025-11-08→10 (3d), 2026-01-08→09 (2d), 2026-01-23→25 (3d), 2026-03-31→04-08 (9d). Total: 8 periods, 31 days.

| Test | Description | Result | Notes |
|------|-------------|--------|-------|
| T11 | Long absence (≥7 days) detected | ✅ | 7d and 9d periods present |
| T13 | 2-day absence detected | ✅ | 2026-01-08→09 |
| T14 | 30% of normal gas NOT flagged (synthetic) | ⏭ | Threshold logic unchanged; validated by code inspection |
| T15 | 1-day absence detected | ✅ | 2025-07-21 |
| T15a | Partial-day NOT flagged (synthetic) | ⏭ | isWholeDay check unchanged by Step F patch |
| — | ABSENCE_MIN_CONSECUTIVE_DAYS removed | ✅ | Verified by grep (commit 54b9aa6) |

---

### M3a — Gas separation: browser assertions (real data)

Run 2026-04-26, console script batch.

| Test | Description | Result | Notes |
|------|-------------|--------|-------|
| T1–T3 | Method A: median not mean, robustness, HH shape preservation | ⏳ | Needs synthetic dataset or code-path trace |
| T4 | Method A weekday/weekend split selected | ✅ | method=summer-hh-profile-weekday-split |
| T5/T6 | heating+baseload=gas_kwh invariant, clamping ≥0 | ✅ | 17,465 records checked, 0 failures |
| T7 | No-gas case | ⏭ | Validated via M4 T20 Node suite |
| T8/T9 | Method cascade fallback | ⏳ | Requires dataset without summer data |
| T10 | R²=0.533 → validation_status=acceptable | ✅ | Threshold boundary correct |
| T11 | Long absence detected | ✅ | See Step F T11 above |
| T12 | Summer absence doesn't skew baseload median | ⏳ | Median robust by definition; 12/91 summer days absent — acceptable |
| T13–T15 | Short-run absences (Step F inverted) | ✅ | See Step F section |
| T16 | Degree-day base from constants.js = 15.5 | ✅ | Asserted via M4 real-data result |

---

### M3a Step H — Supplementary load detection: browser assertions (real data)

Run 2026-04-26, console script batch.

| Test | Description | Result | Notes |
|------|-------------|--------|-------|
| T17 | electric_heating_detected boolean; hdd_coefficient and p-value present | ✅ | detected=true, coeff=0.35, p=0.0000 |
| T18 | baseline_kwh_per_day > 0; method=regression | ✅ | baseline=11.722 kWh/day |
| T19 | CDD coefficient present; cdd_p_value present | ✅ | coeff=1.9315, p=0.0004 |
| T20 | Insufficient CDD skips OR sufficient CDD runs | ✅ | sum_cdd=32.3 > threshold 20 → ran |
| T21 | days_used_in_fit ≥ 30 | ✅ | 330 days |
| T22 | electric_heating_is_primary is boolean | ✅ | false (gas household) |

---

### M3b — Integration: browser assertions (real data)

| Test | Description | Result | Notes |
|------|-------------|--------|-------|
| — | Baseload method displayed in UI | ⏳ | Pending browser visual check |
| — | Warnings surfaced in UI | ⏳ | Pending |
| — | Absence count shown | ⏳ | Pending |
| — | Electric heating detection phrased correctly | ⏳ | Will update via feature-m3-labelling plan |
| — | Limitations displayed | ⏳ | Pending |
| — | No blocking on M3 failure | ⏳ | Pending |
| T8–T9 | M3b kWh and £/day values shown correctly | ⏳ | Pending |

---

### M1 patch — Tariff windowing and meters: browser assertions

| Test | Description | Result | Notes |
|------|-------------|--------|-------|
| T1–T3 | Tariff timeline: no 400 errors, switch mid-window, dated SVT clamping | ⏳ | Pending — check browser network tab |
| T4–T6 | Gas meter unit detection (SMETS1, SMETS2, mixed) | ⏳ | Pending |
| T7 | Total gas kWh plausible | ✅ | Actual: 9,146 kWh (prior "8,600 kWh" was inaccurate off-hand estimate, retracted 2026-04-26) |
| T8–T9 | M3b kWh and £/day shown post-fix | ⏳ | Pending |
| T10 | Getter before load returns null | ⏳ | Cannot retest once data loaded — deferred |
| T11 | Ingestion getter returns full result | ✅ | consumption array and metadata present |
| T12 | Baseload getter returns full result | ✅ | heating, baseload_metadata, supplementary_loads all present |

---

### M1 data ingestion / M2 external data — criteria

| Area | Criteria | Result | Notes |
|------|----------|--------|-------|
| M1 | Octopus happy path, no 400 errors | ⏳ | Pending network tab check |
| M1 | Gas unit detection correct | ⏳ | Pending |
| M1 | Data-quality gate | ⏳ | Pending |
| M2 | Postcode lookup, weather fetch | ⏳ | Pending |
| M2 | SP→UTC conversions for clock changes | ⏳ | Pending |
| M2 | Alignment, price fetch | ⏳ | Pending |

---

## Known bugs fixed this session (2026-04-26)

| Bug | Fix | Commit |
|-----|-----|--------|
| `electric_heating_kwh_estimate.toFixed()` crashes when field is `undefined` — `!== null` guard passes for `undefined` | Changed to `!= null` in `heat-loss.js:340` | 27d88e6 |

---

## Open issues (not bugs — design/labelling)

| Issue | Status |
|-------|--------|
| "Air conditioning" label disproportionate to 62 kWh signal; better detection needs >27°C threshold | Deferred to future module; label fix in `feature-m3-labelling-and-energy-summary.md` |
| "Electric heating" likely reflects occupancy-correlated electricity use (always-on lighting, EV, winter behaviour) — not a space heater | Noted; label softened in M4 4D warning via same feature plan |
| M3a gas separation plan T13/T15 criteria pre-date Step F patch — show old "not flagged" expectation | Superseded by `module-3-step-f-patch.md` T13/T15 inverted criteria |
| T7 "ground truth" 8,600 kWh was an inaccurate conversational estimate — retracted | Removed from session memory 2026-04-26 |
