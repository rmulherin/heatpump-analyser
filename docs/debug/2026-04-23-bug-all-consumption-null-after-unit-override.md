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

## Initial hypotheses

[To be filled — see Phase 2]
