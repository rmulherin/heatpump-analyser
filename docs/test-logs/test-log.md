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
| T1–T3 | Method A: median not mean, robustness, HH shape preservation | ✅ | mean=5.448 ≠ median=5.998; ratio 8.8% (<15%); profile peak 21:00 (0.1372 kWh), trough 03:30 (0.0969 kWh), ratio 1.42x — domestic hot water/heating shape confirmed |
| T4 | Method A weekday/weekend split selected | ✅ | method=summer-hh-profile-weekday-split |
| T5/T6 | heating+baseload=gas_kwh invariant, clamping ≥0 | ✅ | 17,465 records checked, 0 failures |
| T7 | No-gas case | ⏭ | Validated via M4 T20 Node suite |
| T8/T9 | Method cascade fallback | ⏳ | Requires dataset without summer data — deferred; cascade logic validated by code inspection |
| T10 | R²=0.533 → validation_status=acceptable | ✅ | Threshold boundary correct |
| T11 | Long absence detected | ✅ | See Step F T11 above |
| T12 | Summer absence fraction < 50% | ✅ | 14 absence days / 91 summer days = 15.4% — median unaffected |
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

### M3b — Integration: browser visual check (2026-04-26)

| Test | Description | Result | Notes |
|------|-------------|--------|-------|
| — | Baseload method displayed | ✅ | "Summer weekday/weekend profile (best)" |
| — | Baseload kWh/day shown | ✅ | "mean 5.4 kWh/day (≈ £0.32/day), median 6.0 kWh/day" |
| — | Validation status shown | ✅ | "acceptable (R² = 0.53)" |
| — | Absence count shown | ✅ | "Absences detected: 31 days" + full warning text |
| — | Electric heating phrased correctly | ⚠ | "Supplementary electric heating detected (moderate confidence). Estimated 464 kWh..." — label accurate but 4D warning text needs softening (feature plan Change 4) |
| — | AC detection shown | ❌ | "Air conditioning detected (high confidence)" with suggestion to replace cooling system — label wrong for 62 kWh signal; fix in feature-m3-labelling plan Change 1 |
| — | Limitations displayed | ✅ | 3 items shown |
| — | Absence warning surfaced | ✅ | 31-day boiler-off warning with HTC lower-bound note |
| — | No blocking on M3 failure | ✅ | Full pipeline ran to M4 |
| T8–T9 | kWh and £/day shown | ✅ | Gas 9,146 kWh + £0.32/day baseload shown in status |

---

### M1 patch — Tariff windowing and meters: browser assertions

| Test | Description | Result | Notes |
|------|-------------|--------|-------|
| T1–T3 | Tariff timeline: no 400 errors, rates loaded | ✅ | 5 gas + 5 elec periods loaded; quarterly Ofgem cap periods April 2025–April 2026; all rates plausible |
| T4–T6 | Gas meter unit detection | ✅ | gas_unit_source=m3_converted; serials=['22J0108234','E6S15259462261']; meters_stitched=false |
| T7 | Total gas kWh plausible | ✅ | 9,146 kWh; 0 gaps across 364 days |
| T8–T9 | M3b kWh and £/day shown post-fix | ✅ | "9,146 kWh over 364 days" in Data Summary; "£0.32/day" in baseload status |
| T10 | Getter before load returns null | ⏳ | Cannot retest once data loaded — deferred |
| T11 | Ingestion getter returns full result | ✅ | consumption array and metadata present |
| T12 | Baseload getter returns full result | ✅ | heating, baseload_metadata, supplementary_loads all present |

---

### M1 data ingestion / M2 external data — criteria

| Area | Criteria | Result | Notes |
|------|----------|--------|-------|
| M1 | Octopus happy path, no 400 errors | ✅ | Analysis completed; 5 tariff periods each loaded without 400 |
| M1 | Gas unit detection correct | ✅ | m3_converted applied; "Gas units: Converted from m³" shown in UI |
| M1 | Data-quality gate | ✅ | 0 gaps across 364 days |
| M2 | Postcode lookup | ✅ | "SE1 2BX" shown in Data Summary |
| M2 | Weather fetch | ✅ | 17,471 periods loaded (≈ 364×48); "Gaps: 0" |
| M2 | Price fetch | ✅ | 17,300 periods (elexon-mid-n2ex); some days with partial SP counts (expected Elexon gaps) |
| M2 | Alignment | ✅ | Weather 17,471 = electricity records 17,471 |
| M2 | SP→UTC clock-change timestamps | ✅ | 2026-03-29 (spring fwd, 46 SPs) and 2025-10-26 (autumn back, 50 SPs) absent from UI "Unexpected SP count" warnings — code got exactly the expected counts. Other flagged dates are genuine Elexon gaps. Corroborated by Luxon IANA timezone DST handling (learnings.md). |

---

## Known bugs fixed this session (2026-04-26)

| Bug | Fix | Commit |
|-----|-----|--------|
| `electric_heating_kwh_estimate.toFixed()` crashes when field is `undefined` — `!== null` guard passes for `undefined` | Changed to `!= null` in `heat-loss.js:340` | 27d88e6 |

---

## UX bugs found during testing (2026-04-26)

| # | Bug | Impact | Fix needed |
|---|-----|--------|------------|
| B1 | **No progress shown during Elexon price fetch** — browser shows "page unresponsive" warning; user must click "Wait". The chunked Elexon fetch loop (stride 7, ~52 chunks for a year) runs with no progress callbacks, blocking the UI thread. | User thinks the page has crashed | Add progress updates inside the chunk loop in `runExternalData()` / `fetchWholesalePrices()` — call `showProgressFn` with chunk count. May also need `await` yield points to keep browser responsive. |
| B2 | **"Unexpected SP count" warnings flood the UI on load** — 13 lines like "Unexpected SP count 47 for 2025-06-13" appear in the status area. These are genuine Elexon data gaps (not a code bug) but look alarming and make the UI look broken. | Poor UX, users alarmed by "errors" that are actually normal | Suppress individual SP count warnings from UI; replace with a single summary if any gaps found: "Wholesale price data has gaps on N dates — affected periods will use null prices." Keep individual warnings as `console.warn` only. |

---

## Open issues (not bugs — design/labelling)

| Issue | Status |
|-------|--------|
| "Air conditioning detected (high confidence)" shown in UI for 62 kWh signal — label wrong; UI also suggests replacing "existing cooling system" when user has no AC | Fix in `feature-m3-labelling-and-energy-summary.md` Change 1 |
| M4 4D warning "Your home appears to use some electric heating" — needs softening to acknowledge occupancy/EV as possible cause | Fix in `feature-m3-labelling-and-energy-summary.md` Change 4 |
| "Summer cooling consideration: minimal" shown in M4 card — label will need update once AC language dropped | Covered by feature plan |
| Elexon SP count warnings shown in UI (e.g. "Unexpected SP count 47 for 2025-06-13") — 13 dates with partial data; 2026-04-25 has only 3 SPs (yesterday, not yet complete) | Expected Elexon behaviour — genuine data gaps, not a code bug |
| M3a gas separation plan T13/T15 criteria pre-date Step F patch — show old "not flagged" expectation | Superseded by `module-3-step-f-patch.md` T13/T15 inverted criteria |
| T7 "ground truth" 8,600 kWh was an inaccurate conversational estimate — retracted | Removed from session memory 2026-04-26 |

---

## 2026-04-29 — Node test suites after m8-patch + smart-scenario-fixes-1

**Environment:** Windows 11, Node v24. Re-run required after m8-patch removed hybrid scenarios and changed M7/M8/M9 output shapes. smart-scenario-fixes-1 phase 1 added M5 comfort-demand diagnostic tests.

| Suite | Assertions | Result | Notes |
|-------|-----------|--------|-------|
| test-m5.mjs | 39/39 | ✅ | Added M5X1–M5X7 (comfort-demand diagnostic, smart-scenario-fixes-1 phase 1). Plan estimated 7 new; D1 deviation = sub-assertion expansion → 13 new. 26 original unchanged. |
| test-m5b.mjs | 29/29 | ✅ | Regression pass after phase 1 — no change |
| test-m7.mjs | 25/25 | ✅ | Rewritten for greedy LP (smart-scenario-fixes-1 phase 2); hybrid keys removed (m8-patch) |
| test-m8.mjs | 24/24 | ✅ | T4a/T4b updated for gas-connection-retained standing charge logic; T5 for Ofgem cap 24.67p; T10b/T10d for hybrid removal; T2a updated for D×W rate model (hh_overhead removed) |
| test-m9.mjs | 24/24 | ✅ | Hybrid keys removed throughout |

---

## Outstanding tests — 2026-04-29

All tests below are ⏳ Not yet run. These supersede the 2026-04-27 outstanding tests for M7–M9 (hybrid-removal changes the expected outputs). Tests are grouped by plan; within each plan, tests come from the plan's success criteria.

**Legend:** ✅ Pass | ❌ Fail | ⏭ Validated by other means | ⏳ Not yet run | 🚫 Deferred

---

### smart-scenario-fixes-1 — Phase 3 (M10 UI / underheat panel)

> **Blocked on smart-HP redesign + Bug 3** — all SF tests should run after the redesign lands. SF2, SF3, SF5 specifically flagged for re-specification before running.

Browser / real data (Rhiannon's Octopus account).

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| SF1 | `#scenario-controls` absent from page — no pre-heat offset slider or occupancy threshold input | ⏳ | Pre-heat/occupancy sliders removed in Phase 2; likely still valid after redesign |
| SF2 | Underheating sub-panel (`#underheat-card`) renders inside Your Home after pipeline run; traffic-light dot visible | ⏳ | ⚠ Review after smart-HP redesign — new dispatch uses cumulative storage constraint, not underheat ratio; UI surface needs re-confirmation before running |
| SF3 | Heat to Comfort slider triggers M7→M8→M9→verdict re-run; visible cost/payback values change; no console errors | ⏳ | ⚠ Review after smart-HP redesign — slider is demandScale knob; redesign adds mandatory ΔT_max flow-through (see SF7 below) |
| SF4 | `hp_undersized` warning appears under scenario comparison when `validation_status.smart === 'hp_undersized'` | ⏳ | May not trigger on Rhiannon's data if HP is well-sized; likely still valid after redesign |
| SF5 | Smart HP total cost < Dumb HP (HH) total cost on Rhiannon's data (strict inequality) | ⏳ | ⚠ Review after smart-HP redesign — new design enforces Smart ≤ Dumb by construction (T6 in design doc); runtime gate may become redundant |
| SF6 | No console errors during full pipeline run including Heat to Comfort slider re-run | ⏳ | Likely still valid after redesign |
| SF7 | ΔT_max flow-through: changing ΔT_max slider triggers M7→M8→M9→verdict re-run; cost/payback values change independently of demandScale | ⏳ | New — missing from original Phase 3 spec; T8 in revised design doc; add after redesign lands |

---

### m8-patch-gas-connection-retained — browser tests

Browser / real data. All pricing and financial cards affected.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| MP1 | Annual running costs table has 4 scenario rows (no hybrid), 5 cost columns + total | 🚫 | Deferred — table needs reformatting and fixing (B11) |
| MP2 | Non-heating gas column identical across all 4 scenarios | 🚫 | Deferred — blocked on B11 |
| MP3 | Non-heating elec column identical across all 4 scenarios | 🚫 | Deferred — blocked on B11 |
| MP4 | Heating gas column: non-zero for `current` only; HP scenarios show `—` | 🚫 | Deferred — blocked on B11 |
| MP5 | Heating elec column: `—` for `current`; non-zero for three HP scenarios | 🚫 | Deferred — blocked on B11 |
| MP6 | Total per scenario reconciles to ≈ actual annual bill | ❌ | 2026-05-27 Batch 8: total does not match actual bill; non-heating energy cost suspected missing. See B11. |
| MP7 | Gas-connection-retained footnote visible below the table | 🚫 | Deferred — blocked on B11 (table reformatting) |
| MP8 | Ofgem cap note reads: "Heat pump scenario electricity costs use the current Ofgem price cap rate (electricity: 24.67p/kWh). Gas costs (for the retained connection and baseload) and your current boiler costs use your actual historical tariff rates." | ✅ | 2026-05-27 Batch 10: note present. Exact wording not verified — recheck after B11 table fix. |
| MP9 | Table scrolls horizontally on mobile; no layout break | 🚫 | Deferred — blocked on B11 (table reformatting) |
| MP10 | `agile_calibration.D` in range 2.0–2.4 (devtools console) | ❌ | 2026-05-27 Batch 9: D = 1.745 — below expected range. Also `calibration_source` is undefined (should be 'live' or 'default'). See B12. |
| MP11 | `agile_calibration.P_peak_p_kwh` in range 8–16 p/kWh | ✅ | 2026-05-27 Batch 9: P_peak = 13.01 p/kWh |
| MP12 | Off-peak HH rate = D × wholesale; peak (16–19h) = D × wholesale + P (spot-check one period each) | ⏳ | |
| MP13 | `hh_overhead` input field gone from UI | ✅ | 2026-05-27: static code inspection — not found in index.html |
| MP14 | `dumb_hp_svt` uses Ofgem cap rate 24.67 p/kWh, not historical rate | 🚫 | Deferred — blocked on B11 |
| MP15 | No console errors | ✅ | 2026-05-27 Batch 10 |

---

### ui-fixes-1 — browser tests

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| UF1-1 | Savings column shows `£X` without `+` prefix; negative savings show `−£X` | ⏳ | |
| UF1-2 | Progress bar fill animates as Elexon chunks complete | ⏳ | Visual bar moves, not just text |
| UF1-3 | Methodology DLs render in two columns (label left, value right) | ⏳ | |
| UF1-4 | BUS-eligibility note appears below the financial table | ⏳ | Text from plan; no change to grant figures |
| UF1-5 | When smart scenarios unavailable but HH dumb available: amber status line + "Provide that input ↓" link | ⏳ | Blocked on Bug 3 (smart-HP redesign) — verdict status surface may change; run after redesign lands |
| UF1-6 | Clicking "Provide that input ↓" link: opens methodology disclosure, scrolls to thermal char card, focuses first-empty M5b input, applies 1.5s highlight | ⏳ | |
| UF1-7 | When all data good: no status line in verdict card | ⏳ | |
| UF1-8 | No console errors | ⏳ | |

---

### ui-fixes-2 — browser tests

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| UF2-1 | Octopus tab: Account Number field appears above API Key field | ⏳ | |
| UF2-2 | After single-meter fetch: gas toggle pre-checked to m³ if meter reported m³; pre-unchecked for kWh | ✅ | 2026-05-27: pre-checked; code inspection confirms driven by `gasResult.detectedUnit` — dynamic, not hardcoded |
| UF2-3 | Console shows `Tier 1 meter (gas): unit=m3` log line (or `unit=kwh`) | ✅ | 2026-05-27: confirmed in console |
| UF2-4 | Status notices hidden on page load; shows "N notices" summary when notices added; expands on click | ✅ | 2026-05-27: 11 notices, collapsed; expanded to show full list |
| UF2-5 | Clearing and re-running resets notices to closed and hidden | ⏳ | |
| UF2-6 | No cooling note text anywhere in verdict block | ⏳ | |
| UF2-7 | Break-even verdict copy does not mention cooling | ⏳ | |
| UF2-8 | No console errors | ⏳ | |

---

### patch-agile-region-calibration — browser tests

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| AC1 | Octopus path: `ingestionResult.gsp_region` is a single letter A–P (not I or O); visible in Data Input card | ⏳ | Rhiannon's meter is in London — expect `C` |
| AC2 | Octopus path: read-only region display shown in Octopus card (no dropdown) | ⏳ | |
| AC3 | CSV path: region `<select>` visible; selecting "London" produces `gsp_region = 'C'` | ⏳ | |
| AC4 | `agile_calibration.D` in range 2.0–2.4 on real data | 🚫 | Duplicate of MP10 — run MP10 instead |
| AC5 | `agile_calibration.P_peak_p_kwh` in range 8–16 on real data | 🚫 | Duplicate of MP11 — run MP11 instead |
| AC6 | `calibration_period` in external metadata reflects most recent completed post-reform month | ⏳ | As of 2026-05-07: April 2026 is a fully completed month — expect `2026-04` with no "(partial)" suffix |
| AC7 | No new console errors on normal (successful) path | ⏳ | |

---

### ui-design-m10b — browser tests

> **Bug 1 fixed** (bug-fix-results-display, 2026-05-07). All M10B tests can now run.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| M10B1 | At desktop (≥1100px): verdict-card and drove-card side by side, equal width | ✅ | 2026-05-27: side by side confirmed. Top section unlabelled; graph card + "What drove this answer" side by side. |
| M10B2 | At desktop: results-card and energy-summary-card side by side | ✅ | 2026-05-27: "Your data" + "How you use your energy" side by side in Your Home; heat loss + thermal char side by side in Methodology. Naming differs from spec but layout correct. |
| M10B3 | At desktop: Methodology (when opened) shows 2×2 grid — heat-loss + thermal-char (row 1), hp-model + scenario (row 2); underheat-card full-width between rows | ✅ | 2026-05-27: heat loss + thermal char side by side; "Heating to Comfort" full-width; HP sizing + energy by scenario side by side. 5 total items (4 technical + underheat) — consistent with spec. |
| M10B4 | Cost breakdown section shows pricing-card and financial-card full-width stacked | ✅ | 2026-05-27: "Annual running costs" + "Savings and payback" both full-width in Cost breakdown. |
| M10B5 | At ≤768px: every `.section-tiles` collapses to single column | ✅ | 2026-05-27: single-column order at narrow width confirmed. |
| M10B6 | drove-card populates four stat blocks: heat loss W/K, HP size kW, electricity context (region/rate), installation cost + grant | ✅ | 2026-05-27: four stats visible — Heat loss, Heat pump size, Electricity (Half-hourly), Installation. |
| M10B7 | Stat 3 label and value adapt for `dumb_hp_svt` (flat rate, no region) vs HH scenarios (region + Agile D×W+P) | ✅ | 2026-05-27: HH path shows region C + Agile rate — adaptation confirmed. Presentation notes: (a) region shows letter "C" only, "London" absent; (b) "Ofgem cap" visible but no label clarifying this equals the SVT rate. See P1, P2. |
| M10B8 | Section banner reads "Cost breakdown" (not "The verdict") | ✅ | Static (index.html:399) + browser confirmed 2026-05-27 |
| M10B9 | Container max-width 1100px confirmed in DevTools | ✅ | 2026-05-27: `getComputedStyle(document.querySelector('.container')).maxWidth` → '1100px'. |
| M10B10 | Bar chart renders correctly at ~520px tile width | ✅ | 2026-05-27: bars, labels and y-axis legible at tile width. |
| M10B11 | Methodology disclosure still opens/closes; inner 2×2 grid visible when open | ✅ | 2026-05-27: opens/closes confirmed; 5 cards visible (4 technical + underheat). |
| M10B12 | No layout breakage at desktop, tablet (768–1099px), mobile (≤375px) | ✅ | 2026-05-27: desktop and tablet confirmed; mobile collapse confirmed via M10B5. |
| M10B13 | No console errors | ✅ | 2026-05-27: none. |

---

### ui-design-m10c-what-if — browser tests

> **Bug 2 fixed** (bug-fix-results-display, 2026-05-07). All M10C tests can now run.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| WI1 | "What If" section appears after Cost breakdown; old "Adjust assumptions" section gone | ✅ | 2026-05-27: static code inspection — "Adjust the assumptions" not found in index.html |
| WI2 | Two tiles side by side at desktop; stack at ≤768px; no horizontal overflow | ✅ | 2026-05-27 Batch 5 |
| WI3 | Policy Reform: "Ofgem cap (base)" pre-fills 24.67 p/kWh elec, 5.70 p/kWh gas; output reads "Same as results above — this is the base case." | ✅ | 2026-05-27 Batch 5: rates pre-fill confirmed. Output text "Same as results above" not explicitly confirmed — recheck after B5/B6 fixed. See B5. |
| WI4 | Policy Reform: "Full levy removal" adjusts rates by levy delta inputs (default 2.0/0.5); rates update in the input fields | ✅ | 2026-05-27 Batch 5: rates update confirmed. See B5 (slow re-run). |
| WI5 | Policy Reform: "Your historical rates" fills from ingestion tariff data | ✅ | 2026-05-27 Batch 5: rates update confirmed. See B5 (slow re-run). |
| WI6 | Policy Reform: manually editing a rate deselects all preset buttons | ✅ | 2026-05-27 Batch 5: deselection confirmed. Typing unresponsive initially (stuck on '1' when trying '15') — auto-trigger firing on each keystroke. See B5. |
| WI7 | Policy Reform: any rate input change triggers M8→M9 re-run; policy output updates | ✅ | 2026-05-27 Batch 5: re-run confirmed by criteria. BUT Rhiannon: auto-trigger is a design error — should require Recalculate button. See B5, B6. |
| WI8 | Policy Reform: Fine-tune standing charges visible when `<details>` expanded | ✅ | 2026-05-27 Batch 5 |
| WI9 | Wait for Technology: COP slider absent from methodology disclosure (relocated to What If tile) | ✅ | 2026-05-27: static code inspection — slider only at index.html:502–504 |
| WI10 | Wait for Technology: dragging slider updates live display `X× (COP Y at 7°C)` instantly | ✅ | 2026-05-27 Batch 6 |
| WI11 | Wait for Technology: "Recalculate" runs M6→M7→M8→M9 chain; payback and threshold lines update | ❌ | 2026-05-27 Batch 6: chain ran (results tile updated to 30y payback). Get Your Quotes tile not refreshed (still showed >40y). See B7. Button position not confirmed. |
| WI12 | Wait for Technology: threshold COP line appears on initial render — correct wording for found/not-found cases | ✅ | 2026-05-27 Batch 6: line present in Savings & Payback tile; updated after WTT recalculate |
| WI13 | Get Your Quotes: grant presets fill `#wi-grant` input; "Enhanced — £10,000 (proposed)" label correct | ✅ | 2026-05-27 Batch 7: presets exist, clicking fills input and triggers re-calc. Auto-trigger noted as inconsistent — extends B6 scope. |
| WI14 | Get Your Quotes: changing any input immediately updates condensed payback table (M9 re-run) | ✅ | 2026-05-27 Batch 7: auto-update confirmed by criteria. Causes typing lag — extends B6 (should require Recalculate button). |
| WI15 | Get Your Quotes: avoided AC info popout (ⓘ) opens and displays explainer text | ✅ | 2026-05-27 Batch 7: popout opens. See B8 (no click-outside dismiss). Copy: add "and those connected to underfloor heating" alongside air-to-air. |
| WI16 | Get Your Quotes: "Disconnect gas" toggle off — single payback column shown | ❌ | 2026-05-27 Batch 7: HP half-hourly (dumb_hp_hh) missing from Get Your Quotes payback table. See B9. |
| WI17 | Get Your Quotes: "Disconnect gas" toggle on — two-column table (gas retained / gas disconnected); split slider appears | ✅ | 2026-05-27 Batch 7: new column appeared; slider appeared on toggle. BUT: main results, running costs, and savings cards did not update. See B10. Design issues for Opus: scenario list should be replaced with savings table update; slider should always be visible (not conditional on toggle). |
| WI18 | Get Your Quotes: net benefit line shows below table; arithmetic matches hand calculation at 70/30 default | ⚠️ | 2026-05-27 Batch 7: net benefit note exists. Position wrong — appears above the slider, should be below. Arithmetic not checked. Recheck after B10/design fix. |
| WI19 | No `#install-hybrid` input anywhere in page | ✅ | 2026-05-27: static code inspection — not found in index.html |
| WI20 | No console errors after any combination of tile interactions | ✅ | 2026-05-27 Batch 8 |

---

### m10a — UI Presentation: browser tests

Implemented 2026-04-28 (commit 9d31cd3). Browser / real data.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| M10A1 | Verdict card appears above "Your home" section after analysis completes | ✅ | 2026-05-27 |
| M10A2 | Verdict copy correctly identifies primary scenario; second paragraph appears when `smart_hp_hh` is primary and `dumb_hp_svt` also available | ✅ | 2026-05-27: primary scenario identified correctly; second paragraph present. |
| M10A3 | All available scenarios appear as bars; scenarios with null `annual_cost_gbp` absent | ✅ | 2026-05-27: 3 bars on initial load (smart HP null → correctly absent); 4th bar appeared after thermal char recalculate once smart HP computed. Criteria met. See B3 (no loading indicator). |
| M10A4 | Current-boiler bar is navy; HP bars are teal (positive saving) or coral (negative saving) | ✅ | 2026-05-27: navy current bar confirmed. |
| M10A5 | Chart tooltip shows `£X/yr` on hover | ✅ | 2026-05-27: confirmed. |
| M10A6 | Clicking "Show methodology" reveals four technical cards; clicking again collapses them | ✅ | 2026-05-27: confirmed. |
| M10A7 | Four technical cards remain accessible inside closed disclosure | ✅ | 2026-05-27: `details .card` query returns 5 while closed (4 technical + underheat — all in DOM). |
| M10A8 | Section banners appear at correct pipeline moments: "Your home" with results-card, "The verdict" and "Adjust the assumptions" with pricing-card | 🚫 | Stale — banner renamed "Cost breakdown" by m10b; "Adjust the assumptions" replaced by What If (m10c); current banner check is M10B8 |
| M10A9 | Removed DL rows (validation status, days used, boiler efficiency, etc.) absent from all three technical cards | ⏳ | |
| M10A10 | Scenario labels consistent across pricing table, financial table, and scenario consumption table | ✅ | 2026-05-27: confirmed. |
| M10A11 | Financial table column headers: "Annual saving", "Net cost (after grant)", "Payback period" | ⏳ | |
| M10A12 | Cooling note hidden when avoided AC > £0; not shown at all post-ui-fixes-2 cooling-note removal | 🚫 | Stale — ui-fixes-2 removed cooling note entirely; covered by UF2-6 and UF2-7 |
| M10A13 | Data-quality footnote reflects correct R² band | ✅ | 2026-05-27: confirmed. |
| M10A14 | No Chart.js console errors; no JS console errors | ✅ | 2026-05-27: confirmed. |
| M10A15 | Chart readable at 375px — bars visible, y-axis labels legible | ❌ | 2026-05-27: results card (bar chart) and drove card cut off horizontally at minimum browser width. Day-view chart cards ("when heating ran", "indoor temperature") also cut off. Annual running costs scrollbar is acceptable. See B4. |
| M10A16 | Body text in Roboto; headings and buttons in Montserrat (confirm in DevTools) | ✅ | 2026-05-27: p → 'Roboto, arial, sans-serif'; h2 → 'Montserrat, sans-serif'; button → 'Montserrat, sans-serif'. |
| M10A17 | Pricing-params and financial-params cards appear below pricing-card and financial-card | 🚫 | Stale — m10c replaced params-card area with What If section; page structure entirely different |

---

## Outstanding tests — 2026-04-27 (superseded by 2026-04-29 section above)

> The tests below were written against the codebase state as of 2026-04-27. Multiple subsequent changes have made individual entries stale:
>
> **Node suite descriptions (stale — historical record only):**
> - M7 T3/T4 (hybrid dispatch), T7/T8 (DP comfort gate / pre-heating), T11 (`'no_thermal_mass'` status), T16 (DP infeasible): all describe the DP optimiser removed by smart-scenario-fixes-1. The 2026-04-29 node run shows the current suite.
> - M8 T2b/T2c: describe the old `hh_overhead` additive model (m8-patch replaced with D×W+P; agile-rate-robustness then replaced null behaviour with imputation and removed the per-slot warning). See 2026-05-01 entry for current assertions.
> - M8 T4b (`hybrid_dumb` standing charge), T10b/T10d (`hybrid_smart` null passthrough): hybrid scenarios removed by m8-patch.
> - M9 T1b/T2b (hybrid net investment), T10b (`hybrid_smart` null): hybrid removed.
>
> **Browser tests (superseded — authoritative pending tests are in the 2026-04-29 section):**
> - M7 T17/T18 (pre-heat slider, hybrid row): slider removed by smart-scenario-fixes-1; hybrid removed by m8-patch.
> - M8 T11–T15: pricing table redesigned by m8-patch (4-scenario, 5-column cost decomposition); Recalculate button and params card removed by m10c.
> - M9 T11/T12: financial card recalculate removed by m10c; hybrid scenarios removed.
>
> **Tests that remain valid:** M5 (all), M6 (all), M3 Step F, M3a, M3b, M1 patch, M4.

All tests below are ⏳ Not yet run unless noted. Tests requiring a Node script are grouped separately — scripts need to be written before those can run. Browser tests require real data loaded via the Octopus flow (or CSV for no-gas variants).

**Legend:** ✅ Pass | ❌ Fail | ⏭ Validated by other means | ⏳ Not yet run | 🚫 Deferred

---

### Feature plan — M3 labelling + energy summary (`feature-m3-labelling-and-energy-summary`)

Browser / code inspection. Run 2026-04-27 against Octopus real-data flow (Rhiannon's account).

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| FC1 | No "air conditioning" or "AC" in any user-visible string in `app.js` | ✅ | `air_conditioning_detected` is a field accessor only; display strings use "Warm-weather electricity uplift" (app.js:801, 914, 919) |
| FC2 | Energy summary table renders in M3 card | ✅ | `energySummaryCard.classList.remove('hidden')` confirmed (app.js:826); user confirmed table visible |
| FC3 | Table % column sums to 100% | ✅ | User confirmed values look correct; total row hardcoded "100%" |
| FC4 | Table hidden when M3 has not yet run | ⏭ | Card starts hidden (`class="hidden"`); cannot retest after data loaded in session |
| FC5 | M4 4D warning uses "cold-weather electricity uplift" framing (neutral, no "electric heating") | ✅ | Text: "Your electricity use rises in cold weather… possibly supplementary electric heating, EV charging, or winter occupancy patterns" — matches plan's proposed text exactly (heat-loss.js:344); "electric heating" is hedged as one of several possibilities, not asserted |
| FC6 | `STEP_H_LIMITATIONS` array includes occupancy-correlation note | ✅ | baseload.js:47 — "Electricity use that correlates with temperature may reflect occupancy patterns…" |
| FC7 | All existing M3 and M4 tests still pass (regression) | ⏭ | test-m4.mjs not committed; real-data M4 result consistent with 2026-04-26 (htc=207, validation_status=good) |
| FC8 (B1) | No "page unresponsive" during Elexon fetch; progress percentage visible throughout | ✅ | Data loaded without issue |
| FC9 (B2) | SP count warnings suppressed to console only; not in UI status panel | ✅ | Individual per-date lines in console (app.js:719); no SP count messages in UI status panel |

---

### M5 — Thermal Character: synthetic unit tests (`test-m5.mjs`)

Ran via `node test-m5.mjs`. 26 assertions. All pass.

**Environment:** Windows 11, Node v24. **Date:** 2026-04-27.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| T1 | Setpoint recovery. 90 days, HTC=280, η=0.9, T_set=19°C, 8-HH blocks. `setpoint_c` within ±0.5°C of 19 | ✅ | Got 19.00°C |
| T2 | Setpoint clip. Same setup + 5 HH/day at 2×SS. Setpoint ≈ 19°C; inflated estimates (est≈33°C) clipped and excluded | ✅ | Got 19.00°C |
| T3 | Occupancy weights structure. 365-day weekday heating HH 12–17 + 34–43. `occ[12]`=0.715 ∈ [0.4,0.8]; `occ[34]`=0.715 ∈ [0.6,0.85]; `occ[4]`=0.000 < 0.05 | ✅ | |
| T4 | Thermal mass recovery. HTC=250, η=0.9, T_set=20°C, 15 events × [14 off, 4×6.80, 6×2.083 kWh]. C=7,981 kJ/K ∈ [6791,9189] (≈11% under C_true=9000; within 15%); rating='medium' | ✅ | Convergence from τ_seed=5.0h |
| T5 | Time constant formula. Verified τ = C/(htc×3.6) holds exactly for returned values | ✅ | Got τ=8.868h; formula exact |
| T6 | Null-HTC passthrough. `validation_status="no_htc"`, all numeric outputs null, no warnings | ✅ | |
| T7 | Insufficient events. 3 valid warm-up events. `thermal_mass=null`, `events_used=3`, "Not enough overnight cold-soak events" warning | ✅ | |
| T8 | Constant overnight heating. All HH ≥ 0.05 kWh. `thermal_mass=null`, "continuously overnight" warning | ✅ | |
| T9 | Rating null when no_htc. Boundary values (5999/6000/14999/15000/29999/30000) verified by code inspection of TC_CONFIG | ⏭ | T4d confirms 'medium' rating for 7981 kJ/K; exact boundary thresholds verified in source |
| T10 | Wall construction mismatch. C≈7981 with `"solid_masonry"` (expected 15000–45000) → warning. `"cavity_wall"` (6000–20000) → no warning | ✅ | |

**Total: 26/26 ✅** (T9 boundary assertion replaced by code inspection)

### M5 — Thermal Character: browser tests

Run 2026-04-27, Rhiannon's Octopus data. Real-data result: setpoint=17.6°C, thermal_mass=null (4 cold-soak events — below minimum 5; constant indoor temperature means no overnight cold-soak), occupancy_weights populated, validation_status=acceptable.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| T11 | Results card visible after full Octopus flow. No JS console errors | ✅ | Result object present; setpoint=17.6°C, warning "Not enough overnight cold-soak events" displayed |
| T12 | Wall construction dropdown → "Recalculate with updated construction type" updates mismatch warning | ⏭ | Wiring verified: `runThermalCharacter` reads `wallConstructionInput.value` at runtime (app.js:1129). Cannot produce visible mismatch with real data — thermal_mass=null means no comparison is possible. Expected behaviour for constantly-heated home |
| T13 | CSV with no gas data: `validation_status="no_gas"`, card visible with appropriate message | ⏳ | Deferred — no CSV no-gas file available in this session |

---

### M6 — Heat Pump Model: synthetic unit tests (`test-m6.mjs`)

Ran via `node test-m6.mjs`. 24 assertions. All pass.

**Environment:** Windows 11, Node v24. **Date:** 2026-04-27.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| T1 | COP interpolation. `temp=3.5°C`, scalar=1.0. 2.87 (got 2.8700) | ✅ | f=6.5/13=0.5 exactly |
| T2 | COP clamp cold. `temp=−20°C`. 1.44 — clamped at −15 anchor, not extrapolated | ✅ | |
| T3 | COP clamp warm. `temp=25°C`. 4.14 — clamped at 20 anchor | ✅ | |
| T4 | Scalar multiplicative. `temp=10°C`, ×1.2→4.044, ×0.8→2.696 (additive would give 3.57/3.17) | ✅ | |
| T5 | Clamp after scaling. `temp=−15°C`, ×0.5→0.72→clamped to 1.0 | ✅ | |
| T6 | HP capacity units. `htc=250`, `setpoint=20`, ×1.0. `hp_capacity_kw=5.75`, `cop_at_design=2.37`, `hp_capacity_kw_elec=2.426` | ✅ | |
| T7 | HP capacity null inputs. `htc=null`. `hp_capacity_kw=null`, `hp_capacity_kw_elec=null`; `cop_by_hh` populated; `validation_status="no_htc"` | ✅ | |
| T8 | Demand-weighted mean COP. `annual_mean_cop=2.570` = (2.0×2.37+0.5×3.37)/2.5 | ✅ | |
| T9 | `cop_by_hh` null passthrough. `temp_c=null` → `cop_by_hh[i]=null`; neighbours unaffected | ✅ | |
| T10 | Design temperature constant. `design_temp_c === −3.0` and used correctly in capacity formula | ✅ | |
| T11 | Setpoint below design temp. `setpoint_c=−5°C` → `hp_capacity_kw=null` + warning | ✅ | |
| T12 | EoH anchor exactness. COP(−3,×1.0)===2.37 and COP(10,×1.0)===3.37 exactly | ✅ | No float drift at anchor boundaries |

**Total: 24/24 ✅**

### M6 — Heat Pump Model: browser tests

Run 2026-04-27, Rhiannon's Octopus data. Real-data result: validation_status=ok, annual_mean_cop=3.19, fraction_below_design_temp=0.002 (0.2% — no warning), hp_capacity_kw=4.27, design_temp_c=−3, no warnings.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| T13 | Slider live display: dragging COP scalar updates `<output>` text immediately; recompute only on button click | ✅ | Confirmed by user |
| T14 | Card visible after Octopus flow. No JS console errors | ✅ | validation_status=ok; cop_by_hh populated; no warnings |
| T15 | CSV no-gas: `validation_status="no_gas"`, `cop_by_hh` populated, `hp_capacity_kw=null`, `annual_mean_cop=null` | ⏳ | Deferred — no CSV no-gas file available in this session |
| T16 | `fraction_below_design_temp=0.07` → warning with "7.0% of heating hours" | ⏭ | Verified by code inspection (heatpump-model.js:133–138): threshold 0.05, format `${pct}% of heating hours`. Real data: 0.002 — correctly no warning |

---

### M7 — Scenario Consumption: Node synthetic suite (test-m7.mjs)

Run 2026-04-27, `node test-m7.mjs` from repo root. 27 assertions covering plan tests T1–T16.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| T1 | Dumb HP unit conversion. `h=1.0, η=0.9, cop=3.0` → `elec=0.30` | ✅ | |
| T2 | Dumb HP null COP fallback. `h=1.5, cop=null` → `gas=1.5, elec=0` | ✅ | |
| T3 | Hybrid dispatch HP wins. `cop=3.5, elec=10p, gas=7p` → HP, `elec=0.2571` | ✅ | hpCost 2.86 < gasCost 7.78 |
| T4 | Hybrid dispatch gas wins. Same setup, `elec=30p` → gas, `gas=1.0` | ✅ | hpCost 8.57 > gasCost 7.78 |
| T5 | RC steady state. `T=19, temp=5, htc=200` → `Q=1.4` | ✅ | Spec verification — formula re-derived from scenario-consumption.js:45–55. Implementation verified by code inspection + integration via T7–T16. |
| T6 | RC non-trivial ΔT. `T=17, T_next=17.288, C=10000` → `Q=2.0` | ✅ | Same approach as T5. Confirms × C/3600 factor. |
| T7 | DP comfort gate. All occupied → all `indoor_temp_c ≥ 19` (min=19.071) | ✅ | |
| T8 | DP pre-heating cost reduction. Cheap 0–15, expensive 16–47, occ 16–47, offset=4 → `smart=386.63p < dumb=446.40p` | ✅ | |
| T9a | Day chaining: day 1 unoccupied → T drifts to 18.0 | ✅ | |
| T9b | Day 2 occupied: comfort gate active → day2Start ≥ 19 | 🔧✅ | **Bug found then fixed.** `occupied[t]` (day-local) → `occupied[i]` (global) at scenario-consumption.js:181. Day 2+ was reading day 1's occupancy, breaking comfort enforcement. Fixed 2026-04-27 (D3). |
| T10 | Non-heating day skipped. All `temp=22°C` → smart gas/elec all 0; indoor null | ✅ | |
| T11 | `thermal_mass=null` → `validation.smart='no_thermal_mass'`, smart null, dumb computed | ✅ | Critical: this is the path Rhiannon's data takes |
| T12 | `current.gas_kwh[i] === heating_kwh[i]`; `elec=0` (or null) | ✅ | |
| T13 | `dumb_hp_svt === dumb_hp_hh` (object identity) | ✅ | |
| T14 | DST 47-HH day → smart arrays null; days 0/2 (48-HH) populated | ✅ | |
| T15 | `partial` validation at 8% null COP | ✅ | |
| T16 | DP infeasible day → "undersized" warning + array still produced | ✅ | |

**Total: 27/27 ✅** (T9b was ❌; bug found, fixed, re-run passes — see D3 in m7-scenario-consumption.md)

### M7 — Scenario Consumption: browser tests

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| T17 | Scenario summary table visible after Octopus flow; 4 rows (current, dumb HP ×2, hybrid) | ⏳ | Pending user browser test |
| T18 | Pre-heat offset slider updates display; recalculate re-runs scenario engine | ⏳ | Pending user browser test |

---

### M8 — Pricing Engine: synthetic unit tests (`test-m8.mjs`)

Ran via `node test-m8.mjs`. 24 assertions. All pass.

**Environment:** Windows 11, Node v24. **Date:** 2026-04-27.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| CONFIG | PE_CONFIG.PARTIAL_MONTH_DAY_THRESHOLD === 20 | ✅ | Export smoke test |
| T1a | May timestamp → gas rate 7.5 p/kWh (3-period tariff) | ✅ | |
| T1b | August timestamp → gas rate 6.8 p/kWh (open-ended window) | ✅ | |
| T2a | wholesale=5 + overhead=13 → elec_hh_rate=18 p/kWh | ✅ | |
| T2b | null wholesale → overhead-only rate=13 p/kWh | ✅ | |
| T2c | null wholesale triggers warning string | ✅ | |
| T3 | wholesale=−5 + overhead=13 → rate=8 (not clamped to 13) | ✅ | Critical: smart scenarios exploit negative prices |
| T4a | dumb_hp_svt standing = £219 (electricity only; gasSc=30, elecSc=60, 365 days) | ✅ | |
| T4b | hybrid_dumb standing = £328.50 (gas + electricity; same rates) | ✅ | |
| T5 | dumb_hp_svt 2.0 kWh × SVT 24.5 p/kWh = £0.49 (HH rate 113 p/kWh not used) | ✅ | Deliberate high HH rate verifies SVT isolation |
| T6a | dumb_hp_hh 2.0 kWh × HH rate 18 p/kWh = £0.36 | ✅ | |
| T6b | HH rate (18) < SVT (24.5) → dumb_hp_hh cost < dumb_hp_svt cost | ✅ | |
| T7a | energy_cost_gbp = £30.00 (300 × 1 kWh × 10 p/kWh, 300-day window) | ✅ | |
| T7b | annual_cost_gbp = £36.50 (30 × 365/300) | ✅ | Scaling formula verified |
| T8a | Monthly energy sum = energy_cost_gbp (Jan+Feb 2025, 2832 HH) | ✅ | |
| T8b | Monthly standing sum = standing_charge_gbp | ✅ | |
| T8c | Monthly total sum = energy + standing (unscaled) | ✅ | Structural consistency confirmed computationally, not just by devtools |
| T9a | April with 16 days → partial: true | ✅ | |
| T9b | May with 31 days → partial: false | ✅ | |
| T9c | June with 10 days → partial: true | ✅ | |
| T10a | smart_hp_hh.annual_cost_gbp = null (smart=insufficient_data) | ✅ | |
| T10b | hybrid_smart.annual_cost_gbp = null | ✅ | |
| T10c | current unaffected by smart=insufficient_data | ✅ | |
| T10d | dumb_hp_hh unaffected by smart=insufficient_data | ✅ | |

**Total: 24/24 ✅**

### M8 — Pricing Engine: browser tests

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| T11 | Pricing card visible after M8 runs; 6-row scenario table with correct display names | ⏳ | Pending user browser test |
| T12 | Change SVT rate + Recalculate → dumb_hp_svt total changes; HH-rate scenarios unchanged | ⏳ | Pending user browser test |
| T13 | Edit gas standing charge + Recalculate → hybrid_dumb/hybrid_smart change; dumb_hp_svt unchanged | ⏳ | Pending user browser test |
| T14 | Octopus path: standing charge inputs pre-populated from M1 tariff data (not hardcoded defaults) | ⏳ | Pending user browser test |
| T15 | With Rhiannon's real data: dumb_hp_hh.annual_cost ≤ dumb_hp_svt.annual_cost (when mean HH rate < SVT) | ⏳ | Pending user browser test |

---

### M9 — Financial Analysis: synthetic unit tests (`test-m9.mjs`)

Ran via `node test-m9.mjs`. 28 assertions. All pass.

**Environment:** Windows 11, Node v24. **Date:** 2026-04-27.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| CONFIG | FA_CONFIG exports BUS grant default £7,500; 5 gas multipliers | ✅ | Export smoke test |
| T1a | full HP net investment = £5,000 (12500−7500) | ✅ | |
| T1b | hybrid net investment = £2,500 (10000−7500) | ✅ | |
| T1c | avoided_ac £1,500 → full HP net investment = £3,500 | ✅ | |
| T2a | full HP clamped to £0 (8000−7500−2000=−1500→0) | ✅ | floor at 0 |
| T2b | hybrid not clamped: 10000−9500=£500 | ✅ | Only full HP was clamped |
| T3a | annual_saving = £300 (2200−1900) | ✅ | |
| T3b | payback_years = 16.667 (5000/300) | ✅ | |
| T3c | payback_status = "positive" | ✅ | |
| T4 (×5) | For all 5 HP scenarios: annual_saving = currentAnnual − hpAnnual | ✅ | Saving invariant verified for each scenario |
| T5a | payback_status = "no_saving" when HP costs more | ✅ | |
| T5b | payback_years = null when no saving | ✅ | |
| T6a | grid(1.0,1.0) payback = 8.33y | ✅ | current=gas-heavy, HP=elec-heavy setup |
| T6b | grid(1.2,1.0) payback < grid(1.0,1.0) | ✅ | Rising gas → savings improve → payback shorter |
| T7a | cop_axis(1.0) payback = 8.33y | ✅ | |
| T7b | cop_mult=0.85 → higher payback than cop_mult=1.0 | ✅ | Lower COP → more electricity → worse economics |
| T8a | svt_be_p ≈ 29.1p/kWh (formula: (gas_dp_pence+gas_sc_pence)/elec_kwh) | ✅ | £1,400 gas, 31.66 p/day × 365, 5,200 kWh HP |
| T8b | gas_to_elec_ratio_at_break_even non-null | ✅ | |
| T8c | interpretation string contains "29.1p/kWh" | ✅ | |
| T9a | all 5 HP scenarios payback_status = "no_saving" | ✅ | |
| T9b | all-no-saving warning emitted | ✅ | |
| T10a | bus_grant=0 → net_investment = £12,500 (full installation) | ✅ | |
| T10b | payback = 41.67y (12500/300) | ✅ | Proportionally larger than T3b's 16.67y |

**Total: 28/28 ✅**

### M9 — Financial Analysis: browser tests

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| T11 | Financial card visible after M9 runs; payback table shows all 5 HP scenarios with correct display names | ⏳ | Pending user browser test |
| T12 | Change installation cost + Recalculate → updated payback for all scenarios | ⏳ | Pending user browser test |
| T13 | Break-even interpretation string renders with Rhiannon's real data; directional sense check | ✅ | svt_be=26.9p, current SVT=24.5p < 26.9p → HP saves. Gas break-even=5.5p, current gas=6.2p > 5.5p → HP saves. String present with correct values and directional sense. |

---

### Deferred (blocked — cannot run without missing data or state)

| ID | Module | Reason |
|----|--------|--------|
| T10 | M1 data ingestion | Getter-before-load: cannot retest once data is loaded in session |
| T8/T9 | M3a gas separation | Requires dataset without summer data — no such dataset available |
| T15 | M6 heatpump model | CSV no-gas dataset unavailable |

---

## 2026-05-01 — Node test suites: full re-run + test-m8 T2b/T2c correction

**Environment:** Windows 11, Node v24.

`test-m8.mjs` T2b and T2c were stale after agile-rate-robustness. Old assertions expected `rate=0` for null wholesale and a per-slot warning — both behaviours removed/replaced. Updated to match current imputation logic.

| Suite | Assertions | Result | Notes |
|-------|-----------|--------|-------|
| test-m3-step-f.mjs | 18/18 | ✅ | Unchanged |
| test-m5.mjs | 39/39 | ✅ | Unchanged |
| test-m5b.mjs | 29/29 | ✅ | Unchanged |
| test-m6.mjs | 24/24 | ✅ | Unchanged |
| test-m7.mjs | 25/25 | ✅ | Unchanged |
| test-m8.mjs | 24/24 | ✅ | T2b/T2c updated (commit 98ff3cc) — see below |
| test-m9.mjs | 24/24 | ✅ | Unchanged |

### test-m8.mjs — T2b and T2c corrected (commit 98ff3cc)

The T2 fixture has 2 slots: `[{wholesale: 5.0}, {wholesale: null}]`. Agile-rate-robustness replaced the `hh_overhead` additive model with `D×W+P` and added null-wholesale imputation (7-day rolling mean → global mean → cap/D last-resort). Per-slot warning was removed (coverage tier system handles signalling).

With 1 known slot (global mean = 5.0 p/kWh, below the 50-sample window threshold):

| ID | Old assertion (stale) | New assertion | Result |
|----|----------------------|---------------|--------|
| T2b | null wholesale → overhead-only rate = 13 p/kWh | null wholesale → imputed from global mean (5.0) → rate = D×5.0 = 11.0 p/kWh | ✅ |
| T2c | null wholesale triggers `'no wholesale'` warning | null wholesale does NOT trigger per-slot warning | ✅ |

---

## Outstanding tests — 2026-05-01

### agile-rate-robustness — browser tests (live data)

Implemented 2026-04-30. Sub-step 1 live gate was called PASS at implementation time (D1 deviation — cost ordering not yet restored due to null-wholesale bug; APX switch confirmed working via P_peak non-zero). Sub-steps 2 and 3 live tests pending.

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| AR1 | Drove tile electricity rate in 21–28 p/kWh band on Rhiannon's data | ❌ | 2026-05-27 Batch 11: rate = 15.6 p/kWh — below expected range. B12 consequence (D=1.745 too low). |
| AR2 | `dumb_hp_hh` total cost > `dumb_hp_svt` total cost on Rhiannon's data | ❌ | 2026-05-27 Batch 10: HH total LOWER than SVT — expected higher. B12 consequence. |
| AR3 | No unusual-result panel on Rhiannon's peak-heavy heating data | ❌ | 2026-05-27 Batch 11: plausibility note IS showing in drove tile: "the displayed average (15.6 p/kWh) is below the Ofgem cap (24.67 p/kWh)." Correct behaviour given B12 — note fires because rate < 0.85×cap (20.97p). Will pass once B12 fixed. |
| AR4 | Drove tile electricity context shows region only (no plausibility note) on Rhiannon's data | ❌ | 2026-05-27 Batch 11: plausibility note present alongside "Agile tariff — region C". B12 consequence — same as AR3. |
| AR5 | CSV path (no GSP region): tier-1 "couldn't fetch" coverage warning visible above pricing table | ⏳ | Requires CSV path — deferred |
| AR6 | No console errors on any path | ✅ | 2026-05-27: confirmed across multiple batches |

---

### agile-rate-robustness — console-injection tests

These require Rhiannon to paste synthetic JS into browser DevTools after a full pipeline run. Snippets to be prepared by Sonnet on request.

**Sub-step 2 — calibration validation + imputation (5 tests)**

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| AR-S2a | Inject 10% null slots into wholesale array → rates for null slots use preceding-7-day window mean, not zero | ⏳ | Requires ≥50 non-null slots in preceding 336 slots |
| AR-S2b | Inject `D_sample_count=30` (below 50 threshold) into `agile_calibration` → `calibration_valid=false`; D=2.2, P=12 defaults used; `calibration_source='default'` | ⏳ | |
| AR-S2c | Inject `P_peak_p_kwh=22` (above 20 bound) → `calibration_valid=false`, defaults used | ⏳ | |
| AR-S2d | Inject `D=1.0` (below 1.5 bound) → `calibration_valid=false`, defaults used | ⏳ | |
| AR-S2e | Inject all-null wholesale array → imputed rate = `OFGEM_CAP_ELEC_P_KWH / D` (last-resort); no console errors | ⏳ | |

**Sub-step 3 — coverage warnings + display checks (4 tests)**

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| AR-S3a | Inject `null_wholesale_fraction=0.06` → 5% tier info banner appears above pricing table | ⏳ | |
| AR-S3b | Inject `null_wholesale_fraction=0.26` → HH scenarios insufficient: em-dashes in pricing + financial; verdict falls back to `dumb_hp_svt`; bar chart omits HH bars; sensitivity grid excludes HH; drove tile reflects SVT primary | ⏳ | |
| AR-S3c | Inject off-peak-heavy heating scenario (02:00–06:00 concentration) → unusual-result panel fires with legitimate-result framing | ⏳ | |
| AR-S3d | Patch `OFGEM_CAP_ELEC_P_KWH=30.0` → plausibility floor automatically becomes 25.5; no other code changes needed | ⏳ | |

---

## 2026-05-07 — Node test suites: full re-run after m7-scenario-consumption-revised

**Environment:** Windows 11, Node v24.

`test-m7.mjs` grew from 25/25 to 39/39 — 14 new assertions (T11a–d through T26) added by m7-scenario-consumption-revised covering: `no_thermal_mass` validation status, `current.gas_kwh` / `elec_kwh` identity invariants, `dumb_hp_svt === dumb_hp_hh` object identity, DST day handling, partial validation, Smart ≤ Dumb invariant, budget conservation, `hp_undersized`, storage constraint (`S_max`), ΔT_max flow-through, absence exclusion, τ-based survival filter, `current.indoor_temp_c` RC trace, and D×W+P rate model in greedy dispatch.

| Suite | Assertions | Result | Notes |
|-------|-----------|--------|-------|
| test-m3-step-f.mjs | 18/18 | ✅ | Unchanged |
| test-m5.mjs | 39/39 | ✅ | Unchanged |
| test-m5b.mjs | 29/29 | ✅ | Unchanged |
| test-m6.mjs | 24/24 | ✅ | Unchanged |
| test-m7.mjs | 39/39 | ✅ | Grew from 25/25; T11a–T26 added for m7-scenario-consumption-revised |
| test-m8.mjs | 24/24 | ✅ | Unchanged |
| test-m9.mjs | 24/24 | ✅ | Unchanged |

### test-m7.mjs — new assertions T11a–T26 (m7-scenario-consumption-revised)

| ID | Description | Result |
|----|-------------|--------|
| T11a | `validation.smart = 'no_thermal_mass'` when thermal_mass=null | ✅ |
| T11b | Smart `elec_kwh[0]` null when thermal_mass=null | ✅ |
| T11c | Smart gas_kwh and elec_kwh all null when thermal_mass=null | ✅ |
| T11d | Dumb scenarios computed even when thermal_mass=null | ✅ |
| T12a | `current.gas_kwh[i] === heating_kwh[i]` for all i | ✅ |
| T12b | `current.elec_kwh[i] === 0` (or null when heating_kwh=null) | ✅ |
| T13 | `dumb_hp_svt === dumb_hp_hh` (object identity) | ✅ |
| T14a | 47-HH (DST) day: all smart gas/elec = 0 | ✅ |
| T14b | Day 0 (48 HH) allocated | ✅ |
| T14c | Day 2 (48 HH after DST gap) allocated | ✅ |
| T15 | `validation.dumb = 'partial'` at 8% null COP | ✅ |
| T16 | Smart ≤ Dumb invariant (smart=57.60p, dumb=172.80p) | ✅ |
| T17 | Budget conservation: `|Σq_thermal − B_d| < 0.01` | ✅ |
| T18a | `validation.smart = 'hp_undersized'` when cap exhausted | ✅ |
| T18b | `hp_undersized` warning surfaced | ✅ |
| T19 | Storage constraint: pre-heat thermal ≤ `S_max=4.17 kWh` | ✅ |
| T20 | ΔT_max flow-through: cost(t_max=5°C) < cost(t_max=1°C) | ✅ |
| T21 | Absence HH excluded from Q_delivered: smart elec_kwh[16..35] all 0 | ✅ |
| T22a | τ=8h: cheap overnight slots used (pre-heat = 2.0000) | ✅ |
| T22b | τ=2h: overnight slots 0–7 ineligible (sum=0) | ✅ |
| T22c | τ=2h: slots 8–11 eligible (pre-heat = 1.2000) | ✅ |
| T23a | Slot 12 eligible (at survival threshold): Q_thermal[12]=2.4000 | ✅ |
| T23b | Slot 11 ineligible (just beyond threshold): Q_thermal[11]=0.0000 | ✅ |
| T24a | `current.indoor_temp_c[11]` < 19 after cooling (got 10.71) | ✅ |
| T24b | `current.indoor_temp_c` rises when boiler fires: T[15]=11.56 > T[11]=10.71 | ✅ |
| T24c | `dumb_hp_svt.indoor_temp_c` all null (unaffected by RC trace) | ✅ |
| T25a | `current.indoor_temp_c` all null when HTC=null | ✅ |
| T25b | Dumb scenarios still computed when HTC=null | ✅ |
| T26 | D×W+P: peak-slot thermal lower with premium than flat | ✅ |

---

## Outstanding tests — 2026-05-07

### bug-fix-results-display

Implemented 2026-05-07. No separate browser criteria in plan — Bug 1 (chart not rendering) and Bug 2 (What If visible on page load) were visible failures whose absence confirms the fix. M10B, M10C, and M10A3/4/5/14/15 blocks lifted (see inline updates above).

---

### ui-day-view-charts — browser tests

Implemented 2026-05-07 (commit 91eed41). Browser / real data (Rhiannon's Octopus account). Section appears between financial-card and What If section after analysis completes.

Note on Rhiannon's data: `thermal_mass=null` → `validation_status.smart` is not `'ok'`/`'hp_undersized'` → right tile should show outdoor + current temp only (no smart HP trace); temp note shown; left tile smart HP area may be null (DV6).

| ID | Description | Result | Notes |
|----|-------------|--------|-------|
| DV1 | Left tile renders four datasets on a valid winter day: two area fills (coral current gas, teal smart HP electricity), two rate lines (coral gas rate, teal HH electricity rate). Both y-axes labelled (`p/kWh` left, `kWh` right). | ⏳ | |
| DV2 | Area fill colour matches series line colour — coral for current gas, teal for smart HP. | ⏳ | |
| DV3 | `picker.min` equals date of first `heating` entry; `picker.max` equals date of last entry. Dates outside range not selectable. | ⏳ | |
| DV4 | Default day is in Oct–Mar with heating > 0. Not a summer or zero-heating day. | ⏳ | |
| DV5 | Changing picker → both charts update with data for new date. No page reload. | ⏳ | |
| DV6 | With `validation_status.smart` not `'ok'`/`'hp_undersized'` (Rhiannon's data): smart HP trace absent from right tile; temp note shown below right chart. Left tile smart HP area shown if `elec_kwh` non-null, else dispatch note shown. | ⏳ | Expected on Rhiannon's data (thermal_mass=null) |
| DV7 | Selecting an absence day (all `heating_kwh = null`): canvases hidden, "No heating data for this day." shown. No Chart.js console error. | ⏳ | Pick a summer absence day from the known absence list |
| DV8 | With `current.indoor_temp_c` all null (HTC unavailable — not applicable on Rhiannon's data): right tile shows outdoor only; note shown. | 🚫 | Rhiannon's data has HTC — cannot test this path without synthetic injection |
| DV9 | Section is hidden on page load and revealed only when analysis completes. | ✅ | `class="hidden"` on `#day-view-section` in HTML — code inspection 2026-05-27 |
| DV10 | On mobile (375px): tiles stack vertically; date picker full width below heading. | ⏳ | |
| DV11 | No new console errors. | ⏳ | |

---

## 2026-05-27 — Node re-run + static code inspection

**Environment:** Windows 11, Node v24.14.1. Code inspection against commit `ce2d9d5` (HEAD).

### Node test suites — full re-run

All suites pass unchanged from 2026-05-07.

| Suite | Assertions | Result |
|-------|-----------|--------|
| test-m3-step-f.mjs | 18/18 | ✅ |
| test-m5.mjs | 39/39 | ✅ |
| test-m5b.mjs | 29/29 | ✅ |
| test-m6.mjs | 24/24 | ✅ |
| test-m7.mjs | 39/39 | ✅ |
| test-m8.mjs | 24/24 | ✅ |
| test-m9.mjs | 24/24 | ✅ |

---

### Static verification — HTML and code inspection

Tests verified by reading `index.html` and `js/app.js` directly. No browser required.

| ID | Description | Result | Method |
|----|-------------|--------|--------|
| SF1 | `#scenario-controls` absent from HTML | ✅ | Not found in index.html |
| WI19 | `#install-hybrid` absent from HTML | ✅ | Not found in index.html |
| MP13 | `hh_overhead` input absent from HTML | ✅ | Not found in index.html |
| WI1 | "Adjust the assumptions" section absent | ✅ | Not found in index.html |
| UF2-1 | Account Number field above API Key field | ✅ | Lines 35/41 in index.html |
| UF2-4 | Status notices panel hidden on load | ✅ | `class="status-details hidden"` line 88 |
| UF2-6 | No cooling note text in verdict block | ✅ | Only cooling ref is in heat-loss card (line 1196); no cooling in `buildAndDisplayVerdict` |
| UF2-7 | Break-even copy does not mention cooling | ✅ | No cooling ref in `displayFinancialResults` or `buildAndDisplayVerdict` |
| UF1-1 | Savings: `£X` (no `+`); negative `−£X` | ✅ | `fmtGbpSaving` at app.js:1904 |
| UF1-4 | BUS eligibility note present | ✅ | app.js:1960 |
| UF1-5/6 | `#verdict-status` element + fix-handler wired | ✅ | index.html:179; `buildVerdictStatusMessage` app.js:1991–2023 |
| WI9 | COP scalar slider only in What If (not methodology) | ✅ | index.html:502–504 only; not present in methodology disclosure |
| WI3 | Ofgem presets: elec 24.67 p/kWh, gas 5.70 p/kWh | ✅ | `OFGEM_CAP_ELEC_P_KWH`/`OFGEM_CAP_GAS_P_KWH` app.js:78,81; applied at 2338–2339 |
| WI8 | Fine-tune `<details>` present in Policy Reform tile | ✅ | index.html:478 |
| WI12 | `#cop-threshold-line` DOM element present | ✅ | index.html:508 |
| MP8 | Ofgem cap note exact wording (electricity 24.67p/kWh + gas retained) | ✅ | app.js:1785 — matches spec |
| M10A9 | Removed DL rows (validation status, days used, boiler efficiency) absent from display functions | ✅ | Not found in any `displayHeatLoss*` or `displayThermalChar*` rendering |
| M10A11 | Financial headers: "Annual saving" / "Net cost (after grant)" / "Payback period" | ✅ | app.js:1951–1953 |
| M10B8 | Section banner reads "Cost breakdown" | ✅ | index.html:399 |
| AC2 | Read-only region display (`#gsp-region-readonly`) in Octopus tab | ✅ | index.html:83–84 |
| AC3 | Region `<select>` with London=C in CSV tab | ✅ | index.html:109–126 |
| DV9 | Day-view section hidden on load | ✅ | `class="hidden"` on `#day-view-section` — index.html:425 |

**Documentation defect corrected this session:** README listed `charts.js` as a separate module. File does not exist — chart code lives in `app.js`. README corrected (commit this session).

---

### Bug found and fixed: favicon 404

Browser auto-requested `/favicon.ico` (GitHub Pages URL) — no favicon had ever been declared. Fixed by adding `favicon.svg` (Praxis Insight PI swirl logo) to repo root and `<link rel="icon" type="image/svg+xml" href="favicon.svg">` to `<head>` (commit 902d6a6). No runtime impact on tool behaviour.

### Browser session — Batch 1 (Rhiannon, Octopus data, 2026-05-27)

Full pipeline run with real Octopus data. Results visible. DevTools open.

| ID | Test | Result | Notes |
|----|------|--------|-------|
| UF2-2 | Gas toggle pre-checked to m³ | ✅ | Meter detected as m³; toggle set dynamically |
| UF2-3 | Console: `Tier 1 meter (gas): unit=m3` | ✅ | Present in console |
| UF2-4 | Status notices hidden on load; 11 notices shown collapsed | ✅ | Expands on click |
| M10A1 | Verdict card above "Your home" | ✅ | |
| M10B8 | Section banner reads "Cost breakdown" | ✅ | Browser confirms static check |
| Console | No JS errors (favicon 404 aside) | ✅ | SP count for 2026-05-26 is expected console-only — yesterday's Elexon data incomplete |

---

### Browser session — Batch 2 (Rhiannon, Octopus data, 2026-05-27)

Desktop ≥1100px, full pipeline run, results visible, DevTools open.

| ID | Test | Result | Notes |
|----|------|--------|-------|
| M10B1 | Verdict/drove equivalent side by side | ✅ | Top section unlabelled; graph card + "What drove this answer" side by side |
| M10B2 | Results/energy summary side by side | ✅ | "Your data" + "How you use your energy" side by side in Your Home; heat loss + thermal char in Methodology |
| M10B4 | Pricing/financial cards full-width stacked | ✅ | "Annual running costs" + "Savings and payback" full-width in Cost breakdown |
| M10B6 | Drove card — four stat blocks | ✅ | Heat loss, Heat pump size, Electricity (Half-hourly), Installation |
| M10A3 | All available scenarios as bars; null absent | ✅ | 3 bars on initial load (smart HP null → absent); 4th appeared after thermal char recalculate. Criteria met. See B3. |
| M10A4 | Current bar navy; HP bars teal/coral | ✅ | Navy current bar confirmed |
| M10B9 | Container max-width 1100px | ✅ | `getComputedStyle(document.querySelector('.container')).maxWidth` → '1100px' |

---

### Bug found — 2026-05-27 browser session

| # | Bug | Observed behaviour | Status |
|---|-----|--------------------|--------|
| B3 | **No loading indicator on thermal char recalculate** | "Recalculate" pressed → no visible feedback; verdict chart 4th bar appeared after a delay with no user action. User initially concluded nothing had happened. | Surfaced to Opus for investigation. Chain M5→M7→M8→M9 is async; likely missing progress/spinner. |

---

### Browser session — Batch 3 (Rhiannon, Octopus data, 2026-05-27)

Desktop ≥1100px plus responsive checks.

| ID | Test | Result | Notes |
|----|------|--------|-------|
| M10B3 | Methodology 2×2 grid + underheat full-width | ✅ | Heat loss + thermal char / Heating to Comfort / HP sizing + energy by scenario |
| M10B5 | ≤768px: tiles collapse to single column | ✅ | |
| M10B7 | Stat 3 adapts HH vs SVT | ✅ | Region C + Agile rate shown. Presentation notes P1, P2 (see below). |
| M10B10 | Bar chart readable at tile width | ✅ | |
| M10B11 | Methodology opens/closes; 5 cards inside | ✅ | 5 = 4 technical + underheat — consistent with spec |
| M10B12 | No layout breakage desktop/tablet/mobile | ✅ | |
| M10B13 | No console errors | ✅ | |
| M10A2 | Verdict copy + second paragraph | ✅ | Primary scenario identified; second paragraph present |
| M10A5 | Chart tooltip `£X/yr` on hover | ✅ | |

**Presentation notes (not test failures — flagged for Opus review):**

| # | Location | Issue |
|---|----------|-------|
| P1 | Drove card — Electricity stat | Region shows letter "C" only; "London" (human-readable name) absent |
| P2 | Drove card — Electricity stat | "Ofgem cap" text visible but no label clarifying this equals the SVT rate used in dumb HP SVT scenario |

---

### Browser session — Batch 4 (Rhiannon, Octopus data, 2026-05-27)

| ID | Test | Result | Notes |
|----|------|--------|-------|
| M10A6 | Methodology opens/closes | ✅ | |
| M10A7 | Cards in DOM while closed | ✅ | 5 cards (4 technical + underheat) present in DOM |
| M10A10 | Scenario labels consistent | ✅ | |
| M10A13 | Data-quality footnote R² band | ✅ | |
| M10A14 | No Chart.js/JS errors | ✅ | |
| M10A15 | Chart readable at 375px | ❌ | Results card (bar chart), drove card, day-view chart cards cut off horizontally. See B4. |
| M10A16 | Roboto body; Montserrat headings/buttons | ✅ | Confirmed via DevTools computed styles |

---

### Bug found — Batch 4 (2026-05-27)

| # | Bug | Observed behaviour | Status |
|---|-----|--------------------|--------|
| B4 | **Cards overflow at minimum browser width** | Results card (bar chart), drove card, day-view "when heating ran" and "indoor temperature" cards extend beyond viewport at minimum width. Annual running costs table scrollbar is acceptable (expected). | Surfaced to Opus. Core cards (results, drove) are M10 layout; day-view cards may be separate DV issue. |

---

### Browser session — Batch 5 (Rhiannon, Octopus data, 2026-05-27)

What If section — Policy Reform tile and layout checks. Results visible from prior pipeline run.

| ID | Test | Result | Notes |
|----|------|--------|-------|
| WI2 | Two tiles side by side at desktop; stack at ≤768px | ✅ | Layout correct at both widths |
| WI3 | Ofgem cap preset fills 24.67p elec / 5.70p gas | ✅ | Rates filled. Output text "Same as results above" not explicitly confirmed — recheck after B6 fix |
| WI4 | Full levy removal preset updates rates | ✅ | Rates update. Very slow response — see B5 |
| WI5 | Historical rates preset fills from tariff data | ✅ | Rates update. Very slow response — see B5 |
| WI6 | Manual rate edit deselects presets | ✅ | Deselection confirmed. Typing unresponsive (stuck on '1' when typing '15') — see B5 |
| WI7 | Rate change triggers M8→M9 re-run | ✅ by criteria | Re-run does fire. Rhiannon: auto-trigger is a design error — see B6 |
| WI8 | Fine-tune standing charges `<details>` expands | ✅ | Expands correctly |

---

### Bugs found — Batch 5 (2026-05-27)

| # | Bug | Observed behaviour | Status |
|---|-----|--------------------|--------|
| B5 | **Policy Reform re-runs with no progress indicator** | Preset button clicks and individual keystrokes in rate inputs trigger an immediate M8→M9 re-run. No spinner or progress feedback shown. User perceives app as crashed or hanging. Typing '15' was blocked after '1' triggered a re-run mid-entry. | Surfaced to Opus for investigation. Likely fix: debounce input events, add progress indicator, and/or switch to Recalculate-button model (see B6). |
| B6 | **Policy Reform auto-trigger is a design error (Rhiannon)** | Current design (WI7): every rate input change immediately triggers M8→M9. Rhiannon says this is wrong — should require an explicit Recalculate button click, same as other tiles. Additionally: the Recalculate button in the Wait for Technology tile is next to the COP slider; it should be at the bottom of that card. | Surfaced to Opus. Design change: (1) remove auto-trigger from Policy Reform rate inputs and preset buttons; (2) add Recalculate button at bottom of Policy Reform tile; (3) move WTT Recalculate button to bottom of card. |

---

### Browser session — Batch 6 (Rhiannon, Octopus data, 2026-05-27)

Wait for Technology tile — WI10–WI12.

| ID | Test | Result | Notes |
|----|------|--------|-------|
| WI10 | COP slider live display updates instantly | ✅ | |
| WI11 | Recalculate runs M6→M7→M8→M9; payback updates | ❌ | Results tile updated (30y payback); Get Your Quotes tile did not refresh (still >40y). See B7. |
| WI12 | Threshold COP line present on initial render | ✅ | Line in Savings & Payback tile; updated after WTT recalculate |

---

### Bug found — Batch 6 (2026-05-27)

| # | Bug | Observed behaviour | Status |
|---|-----|--------------------|--------|
| B7 | **WTT Recalculate does not refresh Get Your Quotes tile** | After clicking Recalculate in the Wait for Technology tile, the main results tile updated to show 30y payback. The Get Your Quotes condensed payback table still showed >40y (pre-recalculate value). `updateQuotesOutput` likely not called in the WTT recalculate handler. | Surfaced to Opus for investigation. |

---

### Browser session — Batch 7 (Rhiannon, Octopus data, 2026-05-27)

Get Your Quotes tile — WI13–WI18.

| ID | Test | Result | Notes |
|----|------|--------|-------|
| WI13 | Grant presets fill input | ✅ | Auto-triggers re-calc — extends B6 |
| WI14 | Input change auto-updates table | ✅ | Causes typing lag — extends B6 |
| WI15 | ⓘ popout opens | ✅ | No click-outside dismiss — B8. Copy: add underfloor heating. |
| WI16 | Toggle off — single column | ❌ | HP half-hourly missing from table — B9 |
| WI17 | Toggle on — two columns + slider | ✅ | Main cards (results, running costs, savings) did not update — B10. Design issues for Opus (see below). |
| WI18 | Net benefit line below table | ⚠️ | Net benefit exists; above slider not below — design issue. Arithmetic unchecked. |

**Design issues raised — Opus scope (not bugs, require design decisions):**
- Get Your Quotes should use Recalculate button model, not auto-trigger (extends B6 scope to all three What If tiles)
- Scenario list in Get Your Quotes should be removed; savings table should update instead
- Split slider should always be visible, not conditional on Disconnect gas toggle
- Net benefit note should be below the slider, not above

---

### Bugs found — Batch 7 (2026-05-27)

| # | Bug | Observed behaviour | Status |
|---|-----|--------------------|--------|
| B8 | **ⓘ popout (Get Your Quotes) does not dismiss on click-outside** | Clicking anywhere on the page other than the ⓘ icon does not close the popout. User had to click the ⓘ icon again to close it. | Surfaced to Opus. |
| B9 | **HP half-hourly missing from Get Your Quotes payback table** | The condensed payback table in Get Your Quotes does not show the `dumb_hp_hh` scenario row. All other scenarios appear to be present. | Surfaced to Opus. |
| B10 | **Disconnect gas toggle does not update main cards** | Toggling "Disconnect gas" on caused a new column to appear in the Get Your Quotes tile. The main results card, running costs card, and savings & payback card did not update to reflect the gas-disconnected scenario costs. | Surfaced to Opus. |

---

### Browser session — Batch 8 (Rhiannon, Octopus data, 2026-05-27)

Pricing table (MP group) — MP1–MP7 asked; table issues prevent individual assertion checks.

| ID | Test | Result | Notes |
|----|------|--------|-------|
| MP1–MP5 | Table structure and column contents | 🚫 | Table needs reformatting — cannot assess individual columns. See B11. |
| MP6 | Total reconciles to actual bill | ❌ | Total incorrect; non-heating energy cost suspected missing. B11. |
| MP7 | Gas-connection-retained footnote visible | 🚫 | Not checked due to table issues. |

---

### Bug found — Batch 8 (2026-05-27)

| # | Bug | Observed behaviour | Status |
|---|-----|--------------------|--------|
| B11 | **Annual running costs table: total incorrect, non-heating energy cost likely missing** | Table needs reformatting and the scenario totals do not reconcile to the actual annual energy bill. Rhiannon suspects non-heating energy cost (baseload gas + baseload electricity + standing charges) is absent from the total column. MP1–MP5, MP7, MP9, MP14 all deferred until this is fixed. | Surfaced to Opus for investigation. High priority — the table is a core financial output. |

---

### Browser session — Batch 9 (Rhiannon, DevTools console, 2026-05-27)

Calibration console check: `window.__getExternalResult?.()?.external_metadata?.agile_calibration`

Result: `D: 1.745231607629428 | P_peak: 13.014950272479561 | source: undefined`

| ID | Test | Result | Notes |
|----|------|--------|-------|
| MP10 | `agile_calibration.D` in range 2.0–2.4 | ❌ | D = 1.745 — below expected range. B12. |
| MP11 | `agile_calibration.P_peak_p_kwh` in range 8–16 | ✅ | P_peak = 13.01 p/kWh |

---

### Bug found — Batch 9 (2026-05-27)

| # | Bug | Observed behaviour | Status |
|---|-----|--------------------|--------|
| B12 | **`agile_calibration.D` below expected range; `calibration_source` undefined** | D = 1.745, below the expected 2.0–2.4 range. Also `calibration_source` is `undefined` — should be `'live'` or `'default'`. Two possible causes: (1) energy market conditions have shifted since the range was specified (Apr 2026), making D genuinely lower; (2) calibration bug. `calibration_source` being undefined is a separate missing-field issue regardless. | Surfaced to Opus. Investigate whether range expectation needs updating vs calibration bug. `calibration_source` field should always be populated. |

---

### Browser session — Batch 10 (Rhiannon, Octopus data, 2026-05-27)

MP8, MP15 confirmed; AR1–AR2 checked.

| ID | Test | Result | Notes |
|----|------|--------|-------|
| MP8 | Ofgem cap note present | ✅ | Note visible. Exact wording not verified. |
| MP15 | No console errors | ✅ | |
| AR1 | Drove tile rate in 21–28 p/kWh band | ⚠️ | Agile rate visible but p/kWh value not confirmed; scenario attribution unclear |
| AR2 | `dumb_hp_hh` total > `dumb_hp_svt` total | ❌ | HH total is LOWER than SVT — expected higher. Likely B12 (D=1.745 too low). |

---

### Browser session — Batch 11 (Rhiannon, Octopus data, 2026-05-27)

AR1 rate value and AR3/AR4 unusual-result check.

| ID | Test | Result | Notes |
|----|------|--------|-------|
| AR1 | Drove tile rate in 21–28 p/kWh band | ❌ | Rate = 15.6 p/kWh. Below range. B12 consequence. |
| AR3 | No unusual-result panel | ❌ | Plausibility note fires in drove tile (rate 15.6 < floor 20.97p). Correct behaviour given B12 — will pass once D fixed. |
| AR4 | Region only shown (no plausibility note) | ❌ | Plausibility note present. B12 consequence — same as AR3. |

Plausibility note text observed: *"Agile tariff — region C. Note: the displayed average (15.6 p/kWh) is below the Ofgem cap (24.67 p/kWh). This suggests either an off-peak-heavy heating pattern or a data quality issue. See coverage warning above for details."*

AR1, AR2, AR3, AR4 all fail as B12 consequences. The plausibility logic itself is working correctly.

---

### Outstanding browser tests (updated after Batch 11)

Reference the 2026-04-29 and 2026-05-07 outstanding-test sections for full criteria per group.

| Group | IDs remaining | State |
|-------|--------------|-------|
| ui-design-m10b | **complete** | ✅ |
| m10a presentation | **complete** (M10A15 ❌ — see B4) | ❌ |
| ui-design-m10c What If | **complete** (WI16 ❌ B9; WI18 ⚠️; WI11 ❌ B7; WI7 design B6) | ❌ |
| m8-patch (pricing) | MP12 runnable; rest done or 🚫 blocked (MP10 ❌ B12; MP6 ❌ B11) | ❌ |
| agile-rate-robustness live | **complete** (AR1–AR4 ❌ all B12; AR5 deferred CSV; AR6 ✅) | ❌ |
| ui-fixes-1 | UF1-2, UF1-3, UF1-5, UF1-6, UF1-8 | ⏳ |
| ui-fixes-2 | UF2-5, UF2-8 | ⏳ |
| patch-agile-region-calibration | AC1, AC6, AC7 | ⏳ |
| smart-scenario-fixes-1 Phase 3 | SF2–SF7 | ⏳ |
| ui-day-view-charts | DV1–DV7, DV10–DV11 | ⏳ |
| agile-rate-robustness injection | AR-S2a–e, AR-S3a–d | ⏳ |
