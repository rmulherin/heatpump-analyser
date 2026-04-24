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

## Root Cause

The Elexon MID API requires date-only values (`YYYY-MM-DD`) for the `from` and `to` parameters.
The code passes `canonicaliseTs(dataStart)` which produces `"2025-04-24T00:00:00Z"` — a full
ISO timestamp. The API rejects this with 400.

Confirmed by: direct API test with `from=2026-01-15&to=2026-01-15` returned 200 with valid data.

## Evidence

- Failing URL: `?from=2025-04-24T00:00:00Z&to=2026-04-22T23:30:00Z` → 400
- Working URL: `?from=2026-01-15&to=2026-01-15` → 200
- Code: `external-data.js:216` — `canonicaliseTs()` produces full ISO, not date-only
- `dateOnly()` helper already exists in the same file (`external-data.js:33`)
- `dataProvider: 'N2EXMIDP'` confirmed correct — design doc's `'N2EX'` is wrong (code is right)

## Fix

`external-data.js:213–216`: replace `canonicaliseTs` with `dateOnly` for from/to parameters.

```javascript
// Before (broken):
const from = canonicaliseTs(dataStart);
const to = canonicaliseTs(dataEnd);

// After (fixed):
const from = dateOnly(dataStart);
const to = dateOnly(dataEnd);
```

## Secondary concerns

- Design doc `external-data.md` incorrectly states parameters as `settlementDateFrom`/`settlementDateTo`
  and filter value as `'N2EX'`. Needs correction in a documentation pass.
- 364-day response size: not tested at full range — pagination via `data.links` may be needed.
  Verify in user testing that all ~17,000 SP records are returned.

## Fix Applied

**File:** `js/external-data.js:213–214`
**Change:** `canonicaliseTs(dataStart/dataEnd)` → `dateOnly(dataStart/dataEnd)`
**Fix source:** empirical API test confirming date-only format required.

## Verification

- [ ] Wholesale prices: > 0 periods in external data status message
- [ ] Price count close to 17,465 (one per gas HH period)
- [ ] No 400 error in console
- [ ] Spot-check: a known date's price is plausible (0–30 p/kWh typical)

## Status: AWAITING USER VERIFICATION
