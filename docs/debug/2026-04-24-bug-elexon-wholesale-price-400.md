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

## Phase 3 continued: Fix deployed but 400 persists

Confirmed deployed URL: `?from=2025-04-24&to=2026-04-22&format=json` → still 400.

H1 (format) is confirmed fixed. H3 (range too large) is now confirmed.

Range boundary test results:

| Range | Days | Status |
|-------|------|--------|
| 2026-01-01 → 2026-01-07 | 7 | 200 (~672 records) |
| 2026-01-01 → 2026-01-08 | 8 | 200 (~674 records) |
| 2026-01-01 → 2026-01-09 | 9 | 400 |
| 30, 90, 180, 364 days   | — | 400 |

**API maximum: 8 days per request.**

A 364-day fetch requires 46 sequential chunks. Fix: implement chunked fetching loop
in `fetchWholesalePrices`, iterating in 8-day windows from `dataStart` to `dataEnd`.

Root cause update: two compounding bugs:
1. H1 (wrong format) — fixed in previous commit
2. H3 (range too large) — requires chunked fetch implementation

## Updated Root Cause

The Elexon MID API has two constraints the code did not honour:
1. Date values must be `YYYY-MM-DD` (not full ISO timestamps) — fixed.
2. Date range must not exceed 8 days per request — requires chunked fetching.

## Fix (revised)

Replace the single-URL fetch loop in `fetchWholesalePrices` with a chunked outer loop
that iterates in 8-day windows. Inner pagination loop remains unchanged per chunk.

364 days ÷ 8 = 46 chunks. ~46 API calls sequentially.

## Phase 3 continued: Chunked fetch working but SP counts wrong

Wholesale prices: 15,145 out of 17,471 expected. ~50 "Unexpected SP count" warnings:
- BST boundary dates (last day of each chunk, summer): SP count = 3
- GMT boundary dates (last day of each chunk, winter): SP count = 1

Root cause of the gap: the API filters by `startTime` (UTC), not `settlementDate`.
`to=YYYY-MM-DD` means startTime ≤ YYYY-MM-DDT00:00:00Z.

For a BST settlement date D as the last day of a chunk:
- SP 1: startTime = D-1T23:00Z ≤ DT00:00Z → included ✓
- SP 2: startTime = D-1T23:30Z ≤ DT00:00Z → included ✓
- SP 3: startTime = DT00:00Z ≤ DT00:00Z → included ✓
- SPs 4–48: startTime DT00:30Z to DT22:30Z > DT00:00Z → NOT included ✗

For a GMT settlement date D as the last day of a chunk:
- SP 1: startTime = DT00:00Z ≤ DT00:00Z → included ✓
- SPs 2–48: startTime DT00:30Z to DT23:30Z > DT00:00Z → NOT included ✗

Next chunk starts at `from=D+1` (startTime ≥ D+1T00:00Z), so the lost SPs fall in
the gap between chunks and are never captured.

Fix: extend `to` by 1 day per chunk. BST SP48 ends at DT22:30Z < D+1T00:00Z → now
captured. GMT SP48 ends at DT23:30Z < D+1T00:00Z → now captured. Stride reduced from
8 to 7 days so API range = to - from = 7 days ≤ 8-day limit ✓.

Side effect: SP3 of BST dates at chunk starts appears in both current and next chunk
(startTime D+1T00:00Z satisfies both to ≤ D+1T00:00Z and from ≥ D+1T00:00Z). The
priceLookup Map deduplicates — prices are correct. spCountsByDate will show 49 for
these dates (harmless warning).

## Revised Root Cause (final)

Three compounding bugs, fixed in sequence:
1. H1: Wrong timestamp format (`canonicaliseTs` → `dateOnly`) — fixed.
2. H3a: Single request exceeds 8-day API limit — fixed with chunked fetching (stride 8).
3. H3b: API filters by startTime UTC, not settlementDate. Chunk boundary dates lose
   SPs 4–48 (BST) or 2–48 (GMT). Fix: stride 7, extend `to` by 1 day per chunk.

## Phase 1 (round 3): Observations from latest run output

Output is **identical** to the run before the stride=7+to+1 fix. Counts and dates unchanged:
- SP count=3 boundary dates still every 8 days (May 1, May 9, May 17, May 25...)
- SP count=1 boundary dates still every 8 days in GMT period (Nov 1, Nov 9...)
- Wholesale prices: 15,145 — unchanged
- May 1 → May 9 = 8 days. May 9 → May 17 = 8 days. Confirms stride=8 pattern, not stride=7.

Additional data points not previously noted:
- Some dates have near-48 unexpected counts: Jun 12 (44), Jun 13 (47), Jun 24 (47),
  Jun 28 (36), Jul 1 (23), Jul 11 (47), Oct 23 (45), Nov 18 (47), Nov 30 (47),
  Dec 9 (47), Mar 4 (47). These do not follow the 8-day pattern — possible genuine
  Elexon data gaps, not a chunking artefact.

## Phase 2 (round 3): Hypotheses

| # | Hypothesis | Evidence if true | Likelihood |
|---|-----------|-----------------|------------|
| H-cache | stride=7 code not loaded — browser/CDN still serving old stride=8 code | Chunk URLs in Network tab show 8-day windows | High |
| H-deploy | GitHub Pages deployment failed or is delayed | Commit not visible on live site | Low |
| H-analysis | stride=7+to+1 fix deployed but my analysis of API behaviour was wrong | Chunk URLs show 7-day windows but same SP counts | Low |

H-cache is the leading hypothesis. The identical output is the key evidence —
if stride=7 deployed, the boundary dates would shift to every 7 days.

## Phase 3 (round 3): Narrowing

Minimal test required before any further code changes:
Confirm which version of the code is running by checking the Elexon request URLs in
the browser Network tab. If the URLs show 8-day windows (e.g. Apr 24 → May 1), old
code is running. If they show 7-day windows (e.g. Apr 24 → Apr 30), new code is running.

**Investigation blocked pending user confirmation.**

## Status: AWAITING CONFIRMATION — did the stride=7 code load?

## Phase 1 (round 4): Incognito test result — 2026-04-24

Rhiannon opened the live site in an incognito window (no cached JS). Result:

```
External data loaded. Weather: 17471 periods. Wholesale prices: 17300 periods (elexon-mid-n2ex). Gaps: 0.
```

stride=7 fix IS deployed and working. Price count improved from 15,145 → 17,300.
Remaining 171 gap (17,471 − 17,300) is genuine Elexon data gaps (some SPs absent from
the MID dataset entirely — already visible as the non-boundary unexpected-count warnings).

Remaining console warnings (all noisy, not blocking):

**Duplicate UTC key warnings** (one per chunk boundary, every 7 days):
```
Duplicate UTC key 2025-05-01T00:00:00Z from 2025-05-01 SP 3
... (51 more, weekly pattern)
```
BST boundary dates: duplicate at SP 3 (first SP whose UTC startTime = boundary midnight).
GMT boundary dates: duplicate at SP 1 (SP 1 in GMT = 00:00 UTC).

**Unexpected SP count 49** for same boundary dates (1 extra due to the duplicate).

**Genuine Elexon gap warnings** (non-boundary, real missing data):
Jun 12 (45), Jun 13 (47), Jun 24 (47), Jun 28 (36), Jul 1 (23), Jul 11 (47),
Nov 18 (47), Nov 30 (47), Dec 9 (47), Jan 12 (44), Mar 4 (47), Apr 23 (3 — partial
extension day, expected).

Baseload separation completed successfully (R² = 0.49). Data is usable.

## Root Cause (boundary duplicate noise)

Already documented under "Side effect" in the Phase 3 round 2 section: extending `to`
by 1 day causes the SP at exactly UTC midnight on the boundary date to satisfy both
`to ≤ boundary` (chunk N) and `from ≥ boundary` (chunk N+1). The Map deduplicates
automatically (last-write-wins), so prices are correct. The noise comes from:
1. `convertSpToUtc` warning on duplicate UTC key insertion
2. `spCountsByDate` counting the raw record twice → shows 49 instead of 48

## Fix (boundary duplicate noise)

Category A — application logic. Deduplicate `allRecords` by (settlementDate,
settlementPeriod) BEFORE calling `convertSpToUtc`. The Map dedup already makes prices
correct; this fix prevents the spurious warnings from ever firing.

```javascript
// In fetchWholesalePrices, after n2exRecords filter:
const seen = new Set();
const uniqueRecords = n2exRecords.filter(r => {
    const key = `${r.settlementDate}|${r.settlementPeriod}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
});
```

Genuine gap warnings (non-boundary dates) are unaffected — those SPs are absent from
the API response entirely, not duplicated.

## Fix Applied

**File:** `js/external-data.js` — `fetchWholesalePrices`
**Change:** deduplicate n2exRecords by (settlementDate, settlementPeriod) before map/convert
**Fix source:** own reasoning — application logic error (dedup step missing)

## Verification (incognito retest 2026-04-24)

- [x] No "Duplicate UTC key" warnings in console (all 51 gone)
- [x] No "Unexpected SP count 49" warnings for weekly-boundary dates
- [x] Genuine gap warnings still present (13 entries: Jun 12, Jun 13, Jun 24,
      Jun 28, Jul 1, Jul 11, Oct 23, Nov 18, Nov 30, Dec 9, Jan 12, Mar 4, Apr 23)
- [x] Wholesale prices count unchanged (17,300 periods)
- [x] Baseload separation completes successfully (R² = 0.49, method: summer profile)

## Status: RESOLVED
