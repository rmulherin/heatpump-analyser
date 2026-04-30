# Bug: Agile calibration P=0.00, wrong HH cost, no graceful degradation

**Date:** 2026-04-30
**Reporter:** Rhiannon
**Status:** Partial fix applied — root cause of P_samples=empty unconfirmed (diagnostic pending)

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

**Remaining hypotheses for P_samples empty:**
- H1: April afternoon peak wholesale IS consistently ≤1.0 p/kWh (high renewables event
  specific to April 2026 — not confirmed by search). Low probability given Q1 avg = 9.8p.
- H2: agileMap timestamp lookup fails specifically for peak-hour timestamps (e.g. the
  Octopus API returns peak rates in an unexpected format). Possible if API changed format
  post-reform.
- H3: The Octopus API returns the 16:00–19:00 peak window as a single rate entry (one
  valid_from) rather than 6 separate HH entries. Only the first 30-min slot would match
  priceLookup; the other 5 would miss. This would give sparse but non-zero P_samples —
  inconsistent with P=0 exactly.

**Diagnostic added (see Phase 5c):** `console.log` added to count P_samples and D_samples
and print first few agile and wholesale values for peak hours. Re-run and report output
to confirm root cause.

---

## Phase 5 — Fixes Applied

### Fix A: graceful degradation (pricing-engine.js)
Validate D and P after calibration extraction; fall back to defaults with warning if
out of range.

### Fix B: display (app.js)
`filter(r !== null)` → `filter(r => r > 0)` for the HH average display only.

### Diagnostic (external-data.js)
Temporary `console.log` added to report P_samples.length, D_samples.length, and sample
peak agile/wholesale pairs. Remove once root cause confirmed.

---

## Verification

- [ ] Console no longer shows P=0.00 warning (or falls back gracefully)
- [ ] HH cost estimate is plausible (savings of smart HP > dumb HP)
- [ ] "0.0 p/kWh average" replaced by ~15–20p
- [ ] Diagnostic output printed to console — report values for root cause confirmation

## Status: Fixes A+B applied; root cause of P_samples=empty unconfirmed pending diagnostic
