# Bug: Agile calibration P=0.00, wrong HH cost, no graceful degradation

**Date:** 2026-04-30
**Reporter:** Rhiannon
**Status:** Investigating — web search needed (see Phase 4)

## Symptoms

Three related symptoms:

1. **Console:** `external-data.js:431 Agile calibration P=0.00 outside expected range 5–20 p/kWh`
2. **UI:** Electricity (half-hourly) shows `0.0 p/kWh average`, Agile tariff region C
3. **Wrong HH cost:** dumb_hp_hh = £384, flat rate = £890 — implausibly large saving for
   an unscheduled HP; that margin should only appear on smart tariff with optimised scheduling

## Environment

- Rhiannon's Octopus data, Agile tariff, GSP region C
- Calibration covers April 2026 (reform date = 2026-04-01, product AGILE-24-10-01)
- Today is 2026-04-30 — calibration period is full April 2026

---

## Phase 1 — Observations

### fetchAgileCalibration (external-data.js:376–444)

Calibration loop (lines 411–423):

```javascript
for (const [ts, wholesale] of priceLookup) {
  if (wholesale === null || wholesale <= 1.0) continue;  // ← filter applies to BOTH D and P
  const tsDate = new Date(ts);
  const agileVal = agileMap.get(tsDate.toISOString());
  if (agileVal === undefined || agileVal === null) continue;
  if (isUkPeakHour(tsDate)) {           // 16:00–19:00 Europe/London
    P_samples.push({ agile: agileVal, wholesale });
  } else {
    D_samples.push(agileVal / wholesale);
  }
}
if (D_samples.length === 0) return null;   // only guards D, not P
const D = median(D_samples);
const P_computed = P_samples.map(s => s.agile - D * s.wholesale);
const P = P_computed.length > 0 ? median(P_computed) : 0;   // ← defaults 0 if P_samples empty
```

`P = 0.00` exactly — this means `P_computed.length === 0` → `P_samples.length === 0`.
(If P_computed had even a few non-zero values, the median would not be exactly 0.00.)

### Graceful degradation failure (pricing-engine.js:67–72)

```javascript
const calibration = params.agile_calibration ?? {
  D: D_DEFAULT,       // 2.2
  P_peak_p_kwh: P_DEFAULT_PEAK_P_KWH,  // 12
  source: 'default',
};
```

`??` only triggers for `null` or `undefined`. `fetchAgileCalibration` returns
`{ D, P_peak_p_kwh: 0, ... }` — a non-null object. The `??` fallback never fires.
P=0 is used directly.

### Consequences of P=0

**null-wholesale non-peak periods** (pricing-engine.js:105):
```javascript
elec_hh_rate_by_hh[i] = peak ? P_peak_p_kwh : 0;  // non-peak → 0 with P=0
```
Periods with no Elexon data get rate=0 instead of any fallback.

**"0.0 p/kWh average" display** (app.js:1942–1944):
```javascript
const hhRates = rateMetadata?.elec_hh_rate_by_hh?.filter(r => r !== null) ?? [];
```
This filter does NOT exclude zeros. Null-wholesale periods contribute 0 to the average,
pulling it toward zero. Extent depends on Elexon coverage for user's data period.
**Note:** With D×W alone, periods that DO have wholesale should give ~D×8 ≈ 17p.
"0.0" suggests either extensive null-wholesale coverage OR D is also wrong.
Needs further investigation (see Phase 3c).

**Wrong HH cost:** P=0 removes the peak premium from dumb_hp_hh. All HH rates become
D×W regardless of time-of-use. This makes Agile appear much cheaper than SVT (no
congestion pricing), producing an implausibly large saving for an unoptimised HP.

---

## Phase 2 — Hypotheses

**Why is P_samples empty?**

1. **[HIGH] wholesale ≤ 1.0 filter excludes peak-hour prices in spring.** April peak
   hours (16:00–19:00 BST) could have low wholesale prices due to solar generation.
   The filter `wholesale <= 1.0` is designed to protect D calculation (prevents division
   by tiny numbers) but is also applied to P sample collection (where no division occurs).
   If peak-hour wholesale is consistently ≤1.0 p/kWh in April afternoons, all P_samples
   are excluded. D_samples survive because off-peak wholesale is higher.
   **Requires web search to verify April 2026 peak-hour wholesale price levels.**

2. **[HIGH] Reformed AGILE-24-10-01 has no peak premium.** The AGILE_REFORM_DATE =
   2026-04-01 marks a structural change. If the reformed tariff is pure D×W (no P
   component), then for all peak samples: `agile_peak = D × wholesale_peak` → P_computed
   ≈ 0. P_samples would not be empty but P_computed median would be near 0.
   **Requires web search to verify AGILE-24-10-01 post-reform structure.**

3. **[LOW] Timestamp mismatch — agileMap and priceLookup keys don't align at peak hours.**
   priceLookup keys: `"...Z"` (no milliseconds, Luxon `suppressMilliseconds: true`).
   agileMap keys: `new Date(valid_from).toISOString()` → `"....000Z"`.
   At line 416: `agileMap.get(new Date(ts).toISOString())` — this adds `.000`, so keys
   SHOULD match. Evidence against: D_samples populate, meaning non-peak timestamps DO
   match. If peak timestamps had a different format, they'd all fail agileVal lookup.
   Unless the Octopus API returns peak-hour rates with a different valid_from format —
   unlikely.

4. **[LOW] D is over-calibrated, making P_computed ≈ 0 even with valid P_samples.**
   If D is computed as too high (e.g., 3.5), then `P_computed = agile - 3.5 × wholesale`
   could be near zero or negative for typical peak periods. However, D has its own
   range guard (1.5–3.0) and no D warning appears in the console.

---

## Phase 3 — Narrowing

### 3a. Confirmed regardless of root cause

The `??` fallback in pricing-engine.js NEVER fires because the calibration object is
non-null even when P=0. This is a definite bug independent of WHY P=0. Fix is clear
(see Phase 5, Bug B).

### 3b. P_samples empty vs near-zero P_computed

P = 0.00 exactly → P_computed.length = 0 → P_samples.length = 0. The `P_computed.length > 0 ? median(...) : 0` default to exactly 0 confirms P_samples is empty.

### 3c. "0.0 p/kWh average" display

If D is correctly computed (~2.2) and Elexon wholesale coverage is reasonable (~90%+),
the average of D×W rates should be ~15p, not 0. "0.0" suggests one of:
- Elexon coverage for the user's data period is very poor (many null-wholesale → many zeros)
- D is actually near 0 (miscalibration)
- `rateMetadata.elec_hh_rate_by_hh` is not being populated as expected

Diagnostic needed: add `console.log` of D value and Elexon null-wholesale count.
Deferred until root cause of P=0 is confirmed.

---

## Phase 4 — Root Cause

**Confirmed bug A — missing degradation (regardless of P root cause):**
`params.agile_calibration ?? defaults` doesn't catch out-of-range non-null calibration.
P=0 is used in calculations when it should fall back to P_DEFAULT_PEAK_P_KWH=12.

**Unconfirmed — WHY P_samples is empty:**
Needs web search (Phase 5b) to determine:
1. Are April 2026 UK peak-hour (16:00–19:00) wholesale prices consistently ≤1.0 p/kWh?
   If yes → Hypothesis 1 (filter too aggressive for P collection)
2. Does AGILE-24-10-01 post-2026-04-01 have a peak premium structure?
   If no → Hypothesis 2 (model mismatch — reformed tariff is pure D×W)

**Planned fixes (pending search confirmation):**
- Bug A: Validate D and P after calibration; fall back to defaults if out of range
- Bug B (if H1): Separate wholesale filters for D and P — keep >1.0 for D, use >0 for P
- Bug B (if H2): Remove P component from model, update pricing to use pure D×W

## Status: Phase 5 web search in progress
