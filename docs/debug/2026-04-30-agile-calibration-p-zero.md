# Bug: Agile calibration P=0.00, wrong HH cost, no graceful degradation

**Date:** 2026-04-30
**Reporter:** Rhiannon
**Status:** Root cause confirmed — plan drafted, awaiting Opus review before implementation

## Symptoms

1. **Console:** `external-data.js:431 Agile calibration P=0.00 outside expected range 5–20 p/kWh`
2. **UI:** Electricity (half-hourly) shows `0.0 p/kWh average`, Agile tariff region C
3. **Wrong HH cost:** dumb_hp_hh = £384, flat rate = £890 — implausibly large saving for
   an unscheduled HP; that margin should only appear on smart tariff

## Environment

- Rhiannon's Octopus data, Agile tariff, GSP region C
- Calibration covers April 2026 (reform date = 2026-04-01, product AGILE-24-10-01)
- Today is 2026-04-30

---

## Phase 1–3 — Observations and Narrowing

### Why P=0 exactly
`P_computed.length === 0` → P_samples is empty. The ternary at line 428 defaults to 0.
Not a near-zero median — P_samples contains nothing at all.

### Graceful degradation failure (confirmed)
`params.agile_calibration ?? defaults` only triggers for null/undefined. The calibration
function returns a non-null object `{ D, P_peak_p_kwh: 0, ... }`. Defaults never apply.
P=0 propagates to pricing.

### Display "0.0 p/kWh" cause
`elec_hh_rate_by_hh` array: null-wholesale + non-peak periods → rate = 0 (line 105).
`filter(r !== null)` at app.js:1942 keeps zeros. These zeros drag the displayed average
toward zero. Effect proportional to null-wholesale coverage in user's data period.

### Wrong HH cost cause
With P=0: peak-hour HH rates = D×wholesale (no uplift). Agile looks equivalent to a
pure wholesale-tracking tariff with no congestion premium → unrealistically cheap vs SVT.

---

## Phase 4 — Root Cause

### Confirmed bug A: graceful degradation missing
`??` fallback doesn't catch P=0. P_DEFAULT_PEAK_P_KWH=12 is never used when calibration
returns an out-of-range (but non-null) value.
**Fix: validate P in pricing-engine after extraction; fall back to default if P < 5.**

### Confirmed bug B: display includes zero-rate null-wholesale periods
`filter(r !== null)` includes zeros. Average is misleading when Elexon coverage is sparse.
**Fix: filter `r > 0` for display only.**

### Unconfirmed root cause: why P_samples is empty

**Web search result (Phase 5b):**
- AGILE-24-10-01 DOES have a peak premium P ≈ 12 p/kWh (4–7pm). Not removed by reform.
- April 2026 reform added a flat −3.5p/kWh levy reduction to all periods. D×W formula
  is otherwise intact.
- Q1 2026 UK wholesale ≈ 9.8p/kWh average — generally well above 1.0p threshold.
- **Conclusion: P_samples should not be empty.** The `wholesale > 1.0` filter and
  `agileMap` lookup should work for peak-hour periods.

**Root cause confirmed (2026-04-30 console investigation):**

N2EX (N2EXMIDP) has structurally withdrawn from UK electricity market trading in April 2026.
Settlement period records exist in Elexon MID but show price=0, volume=0 — no trades executed.

Console test results:

| Date range | N2EX total | N2EX non-zero | Peak SPs (33–38) | Peak non-zero |
|------------|-----------|--------------|-----------------|--------------|
| Apr 1      | 1         | 0            | 0               | 0            |
| Apr 2–3    | 49        | 1            | 6               | 0            |
| Apr 15     | 1         | 0            | 0               | 0            |

APX (APXMIDP) over the same period has complete, non-zero data:

| Date range | APX total | APX non-zero | Peak SPs (33–38) | Peak non-zero | Sample prices |
|------------|----------|-------------|-----------------|--------------|---------------|
| Apr 2–3    | 49       | 49          | 6               | 6            | 8.2–11.6 p/kWh |

The handful of non-zero non-peak N2EX records (e.g. SP16 at 14.0 p/kWh) produce a thin
D_samples, so D is computed and the function returns non-null with P=0. Peak SPs are
universally 0 → filtered by `wholesale <= 1.0` → P_samples empty → P=0.

**Fix:** Switch `N2EXMIDP` → `APXMIDP` as the data provider throughout `external-data.js`.
See plan `docs/plans/debug-agile-calibration-apx-switch.md`.

---

## Phase 5 — Proposed Fixes (pending Opus approval)

See plan `docs/plans/debug-agile-calibration-apx-switch.md` for full implementation
detail. Three fixes proposed:

### Fix 1: Switch N2EX → APX (external-data.js)
`N2EXMIDP` → `APXMIDP` in provider filter, SP conversion guard, and source tag.
APX has complete non-zero data; N2EX has withdrawn from UK peak-hour trading.

### Fix 2: Graceful degradation (pricing-engine.js)
Replace `??` fallback with explicit P validation:
`const calibration = (raw && raw.P_peak_p_kwh >= 5) ? raw : { D: D_DEFAULT, P_peak_p_kwh: P_DEFAULT_PEAK_P_KWH, source: 'default' };`

### Fix 3: Display average excludes zero-rate periods (app.js)
`filter(r => r !== null)` → `filter(r => r > 0)` for HH rate average display only.

---

## Verification

- [ ] Console no longer shows P=0.00 warning (or falls back gracefully)
- [ ] HH cost estimate is plausible (savings of smart HP > dumb HP)
- [ ] "0.0 p/kWh average" replaced by ~15–20p
- [ ] Diagnostic output printed to console — report values for root cause confirmation

## Status: Root cause confirmed (N2EX withdrawal). Plan drafted — awaiting Opus review.
