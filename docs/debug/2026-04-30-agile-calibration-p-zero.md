# Bug: Agile calibration P=0.00, wrong HH cost, no graceful degradation

**Date:** 2026-04-30
**Reporter:** Rhiannon
**Status:** Investigating

## Symptoms

Three related symptoms, likely sharing a root cause:

1. **Console:** `external-data.js:431 Agile calibration P=0.00 outside expected range 5–20 p/kWh`
2. **UI:** Electricity (half-hourly) shows `0.0 p/kWh average` and `Agile tariff — region C`
   — suggests P=0 is being used in pricing rather than triggering fallback
3. **Wrong HH cost:** HH calc = £384, flat rate = £890. A ~£500 saving on dumb HH vs
   flat SVT is implausible — that level of saving is only expected on smart tariff with
   optimal scheduling. Likely caused by P=0 making Agile HH rates near-zero.

## Environment

- Vanilla JS, no build step
- Rhiannon's real Octopus data, Agile tariff, GSP region C
- Agile calibration added in patch-agile-region-calibration commit

## Initial hypotheses

[To be filled — see Phase 2]
