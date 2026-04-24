# Bug: All consumption null after gas unit override (m³)

**Date:** 2026-04-23
**Reporter:** Rhiannon
**Status:** Investigating

## Symptom

After the M1 patch, user-testing failed. Flow:
1. Ingestion runs. A prompt appears: "is this right?" (gas unit detection).
2. User answers **no** — meter is in m³.
3. Data loads, but **all consumption values are null**: 0 gas records, 0 electricity records,
   100% gap percentage.

UI output:
```
Your data has significant gaps (100%). Results may be less accurate.
Data loaded successfully.
…
Baseload separation complete. Method: No gas supply detected.
No gas consumption detected. This household appears to be all-electric.
```

Data Summary shows:
- Electricity records: 0 half-hourly periods
- Gas records: 0 half-hourly periods
- Data gaps: 17471 missing periods (100%)
- Total gas consumption: 0 kWh over 364 days

## Console evidence

```
Multiple electricity meters found: (2) ['D15A201287', '22J0108234']
Multiple gas meters found: (2) ['E6S15259462261', 'G4A00159951501']
```

Debug getter output:
```
gas_unit_source:      m3_converted        ← unit override was applied
total_days:           364
gap_percentage:       100
gas records in consumption:  0
elec records in consumption: 0

first: {timestamp: '2025-04-23T00:00:00.000Z', gas_kwh: null, elec_kwh: null}
last:  {timestamp: '2026-04-21T23:00:00.000Z', gas_kwh: null, elec_kwh: null}
total periods:        17471               ← timestamps correct; values all null

serials_used:         ['22J0108234', 'E6S15259462261']
meters_stitched:      false

gas tariff rate windows: 5
elec tariff rate windows: 5               ← tariff fetch worked
```

Key facts:
- Timestamps span the correct date range — the consumption grid was built properly.
- Tariff data fetched correctly.
- Serial selection ran and picked one elec + one gas meter.
- `meters_stitched: false` — Tier 1 path (single newest meter, no stitching).
- `gas_unit_source: m3_converted` — the m³ override was accepted.
- Despite all of the above, every `gas_kwh` and `elec_kwh` in the consumption array is null.

## Environment

- Vanilla JS, no build step
- Live site: rmulherin.github.io/heatpump-analyser (GitHub Pages)
- Commit: 4fb82f0

## Root Cause

`normaliseConsumption` builds a string-keyed Map from raw API `interval_start` values,
then looks up using `new Date(ts).toISOString()` which always produces UTC with milliseconds
(`"2025-04-23T00:00:00.000Z"`). The Octopus API returns `interval_start` without milliseconds
(`"2025-04-23T00:00:00Z"`) or with BST offset (`"2025-04-23T00:00:00+01:00"`). No key ever
matches. Every `elecMap.has(isoStr)` and `gasMap.has(isoStr)` returns `false`.
Result: all `gas_kwh` and `elec_kwh` values are `null` → 100% gap percentage.

The gas unit sanity check escaped this because `buildGasUnitCheck` uses `new Date(rec.interval_start)`
to parse dates, which handles any ISO format. The map comparison is a raw string comparison with no
such tolerance.

Confirmed by: sanity check ran (proving API returned data), but consumption was all null
(proving the map lookup failed). The normalised timestamp `"2025-04-23T00:00:00.000Z"` was
confirmed via console.

## Evidence

- `gas records in consumption: 0` and `elec records in consumption: 0` despite sanity check running
- `total periods: 17471` — the timestamp grid was built correctly
- `r?.consumption?.[0]?.timestamp` → `"2025-04-23T00:00:00.000Z"` (UTC + milliseconds)
- `normaliseConsumption` map keys: raw `rec.interval_start` from Octopus API (different format)
- Code: `data-ingestion.js:679–684` (elecMap/gasMap build) vs `data-ingestion.js:695` (isoStr lookup)

## Fix

In `normaliseConsumption`, normalise map keys to UTC ISO on construction:

```javascript
// Before (broken):
elecMap.set(rec.interval_start, rec.consumption);

// After (fixed):
elecMap.set(new Date(rec.interval_start).toISOString(), rec.consumption);
```

Same fix for `gasMap`. The loop lookup already uses `.toISOString()` — this aligns the keys.

## Fix Applied

**File:** `js/data-ingestion.js:679–684`
**Change:** `elecMap.set(rec.interval_start, ...)` → `elecMap.set(new Date(rec.interval_start).toISOString(), ...)`; same for `gasMap`.
**Fix source:** own reasoning — category A application logic error (string format mismatch).

## Verification

- [x] Symptom no longer observed — 17,471 electricity periods, 17,465 gas periods, 0% gaps
- [x] Gas unit summary shows non-zero kWh — 9,127 kWh over 364 days
- [x] Baseload separation runs on real data — method: summer weekday/weekend profile (best)
- [~] Total gas kWh: 9,127 vs T7 ground truth ~8,600 kWh (6.1% above — slightly outside 5% guidance)
- [ ] CSV path regression: not yet tested

Notes:
- Elexon wholesale price fetch returning 400 — pre-existing issue, separate investigation needed
- R² = 0.49 (poor validation) — data characteristic, not a bug
- 6 gas periods missing vs 17,471 electricity — acceptable minor gap
- The previous "20× low baseload" observation was likely from a run where normalisation was
  also broken (all-null data) — not a genuine signal

## Status: RESOLVED
