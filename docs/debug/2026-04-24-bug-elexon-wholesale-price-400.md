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

## Phase 1: Observations

Code path from the failing console trace:
`fetchWholesalePrices` → `fetchWithRetry` → 400 → caught as non-5xx → throws `{ status: 400 }`
→ caught in `fetchWholesalePrices` catch block → warning appended, returns empty priceLookup.

Reading `fetchWholesalePrices` (`external-data.js:209–256`):

```javascript
const from = canonicaliseTs(dataStart);      // produces "2025-04-24T00:00:00Z"
const to = canonicaliseTs(dataEnd);          // produces "2026-04-22T23:30:00Z"
let pageUrl = `...MID?from=${from}&to=${to}&format=json`;
```

`canonicaliseTs` (line 30–32) uses Luxon to produce ISO without milliseconds but WITH time
component and `Z` suffix. The full URL sent is exactly what the console shows:
`?from=2025-04-24T00:00:00Z&to=2026-04-22T23:30:00Z`

Weather fetch succeeds in the same run, so:
- Network is up
- CORS is not blocking (confirmed PASS separately)
- The failure is specific to this request

The 400 is a client error — the server understood the request but rejected it. This rules
out server-side outages and points to a malformed request.

Observed facts written to file before proceeding.

## Phase 2: Hypotheses

| # | Hypothesis | Evidence if true | Likelihood |
|---|-----------|-----------------|------------|
| H1 | Wrong parameter format — API expects `YYYY-MM-DD`, not full ISO timestamp | Fix: use `dateOnly()` instead of `canonicaliseTs()`; test with date-only URL returns 200 | High |
| H2 | Wrong parameter names — design doc says `settlementDateFrom`/`settlementDateTo`; code uses `from`/`to` | Fix: rename params; test with `settlementDateFrom=...` returns 200 | Medium |
| H3 | Date range too large — API has a per-request limit and rejects ranges >N days | Fix: paginate in smaller chunks; shorter range test returns 200, full range returns 400 | Low |
| H4 | API endpoint has changed — Elexon has moved or deprecated the MID endpoint | Swagger/docs show different URL | Low |

H1 and H2 are not mutually exclusive. The failing URL could be wrong on both name and format.
Testing H1 first (date-only with existing `from`/`to` names) because it is the minimal change
and the design doc parameter names may themselves be wrong.

Hypotheses written to file before proceeding to Phase 3.

## Phase 3: Narrowing

### 3a. Minimal failing case

The full 364-day range may obscure whether it is a format issue or a range limit. Minimal
trigger: any request with full ISO timestamp format → 400. Any request with date-only → ?

### 3b. Binary elimination

**Test 1:** Single-day request with date-only format:
`?from=2026-01-15&to=2026-01-15&format=json`
→ **200 OK**. Records returned with `settlementDate`, `settlementPeriod`, `price`, `dataProvider`.

This eliminates H2 (parameter names `from`/`to` are correct), H3 (range limit — single day
works), and H4 (endpoint is live). It confirms H1 (format mismatch).

**Finding:** The API accepts `from`/`to` with `YYYY-MM-DD` format. The code sends full ISO
timestamps. That is the sole cause of the 400.

Additional finding from the test response:
- `dataProvider` values present: `"APXMIDP"` and `"N2EXMIDP"`
- The code filters for `'N2EXMIDP'` — correct
- The design doc says filter for `'N2EX'` — design doc is wrong

Finding written to file before proceeding to Phase 4.

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
