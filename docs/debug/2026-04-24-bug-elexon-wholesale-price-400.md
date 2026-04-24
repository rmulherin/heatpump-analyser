# Bug: Elexon wholesale price fetch returning 400

**Date:** 2026-04-24
**Reporter:** Rhiannon
**Status:** Investigating

## Symptom

Wholesale price fetch fails with HTTP 400 on every run. UI shows:
```
Wholesale price fetch failed (400). Wholesale price scenarios will be incomplete.
External data loaded. Weather: 17471 periods. Wholesale prices: 0 periods (elexon-mid-n2ex).
```

## Failing request

```
GET https://data.elexon.co.uk/bmrs/api/v1/datasets/MID?from=2025-04-24T00:00:00Z&to=2026-04-22T23:30:00Z&format=json
400 (Bad Request)
```

Date range: ~364 days. Format: UTC ISO with Z suffix.

## Context

- Module 2 (`external-data.js` → `fetchWholesalePrices`)
- Called from `runExternalData` in `app.js:557`
- Weather fetch succeeds (Open-Meteo). Elexon alone fails.
- Blocks M3b sign-off: all M2 functions must be working for M3b to pass.
- CORS probe was confirmed PASS on 2026-04-23 — this is not a CORS issue.

## Initial hypotheses

[To be filled — see Phase 1]
