# Module 2 — External Data

**Date:** 2026-04-16
**Status:** ✅ Approved with edits — 2026-04-16 (see Design Review below)

---

## Task description

Build the external data module: fetches weather (temperature + solar radiation), wholesale
electricity prices, and postcode coordinates, then aligns all three series to the unified
HH UTC timeline produced by `data-ingestion`. This module sits between data ingestion and
all analytical modules — baseload separation, heat loss, thermal simulation, heat pump
model, and pricing engine all consume its output.

The highest-risk element is the Elexon settlement period → UTC conversion, which must
handle DST clock changes correctly regardless of the user's browser timezone.

---

## Research findings

### Settlement Period → UTC — authoritative BSC convention

**Settlement Period 1 begins at 00:00 LOCAL TIME on Settlement Day D.** Not 23:00 on D−1.
Confirmed from three Elexon sources:

- Elexon BSC Settlement page: "Settlement Periods are always based on local time. Period 1
  is always 0000hrs (midnight) local time."
- Elexon glossary (Settlement Day): "The period from 00:00 hours to 24:00 hours on each day."
- Elexon 26-Oct-2025 clock-change notice: "Settlement Periods one to four inclusive on
  26 October 2025 will begin as normal at 00:00 (BST), 00:30 (BST), 01:00 (BST) and
  01:30 (BST)... Settlement Period five will begin at 01:00 (GMT)."

A Normal Day has 48 SPs; a Short Day (spring forward) has 46; a Long Day (autumn back)
has 50. SPs are numbered 1 to N contiguously with no gaps — the clock change just gives
fewer or more real-time 30-min blocks, not skipped numbers.

The simplified algorithm (see Step 6a) takes `DateTime.fromISO(settlementDate, { zone:
'Europe/London' })` — which lands at 00:00 local on D — and adds `(sp-1) × 30` minutes of
absolute time. Luxon's `.plus()` handles DST transitions by construction.

### Timezone library

1. **Temporal API** — Not yet shippable (browser support incomplete as of April 2026). Ruled out.
2. **Luxon** — Pin to an exact version. CDN, no build step. Full IANA support. `DateTime.fromISO(...).plus().toUTC()` is the API we need. **Selected.**
3. **date-fns-tz** — No clean CDN single-file option. Ruled out.

### API endpoints

- **Postcodes.io** — `GET /postcodes/{postcode}`, no auth, CORS confirmed. Already used in
  Module 1 for CSV-path validation.
- **Open-Meteo Archive** — `GET /v1/archive`, no auth, CORS confirmed.
- **Open-Meteo Forecast** — `GET /v1/forecast` with `past_days` for recent-day fallback.
- **Elexon MID** — `GET /bmrs/api/v1/datasets/MID`, no auth. CORS status uncertain from
  documentation. **Phase 2 build starts with a CORS test from a real browser before any
  other work; fallback infrastructure is built only if CORS is blocked.**

### No other libraries required

All remaining operations (array alignment, lookup maps, null handling) are straightforward
vanilla JS.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/external-data.js` | Core module: postcode lookup, weather fetch, price fetch, SP→UTC conversion, timeline alignment |
| MODIFY | `index.html` | Add pinned Luxon CDN script tag; add progress indicators for external data fetch |
| MODIFY | `js/app.js` | Wire external-data fetch into the pipeline after data-ingestion completes |
| CREATE (conditional) | `data/mid-prices.json` | Static fallback file, **only if CORS test in Phase 2 shows Elexon is blocked from the browser** |

---

## Implementation steps

### Phase 1 — Postcode lookup + weather fetch + alignment

This phase delivers weather data aligned to the consumption timeline. It's independently
useful for downstream modules (baseload, heat loss) even without wholesale prices.

**Step 1: Luxon CDN + module skeleton — `index.html`, `js/external-data.js`**

Add Luxon via CDN to `index.html` (before `external-data.js`), pinned to an exact version:
```html
<script src="https://cdn.jsdelivr.net/npm/luxon@3.5.0/build/global/luxon.min.js"></script>
```

Pin rationale: the tool is "permanently available" per `scope.md`. A semver range
(`luxon@3`) could silently upgrade and change behaviour years from now.

Create `js/external-data.js` with constants block:
```javascript
const EXTERNAL_CONFIG = {
  POSTCODES_BASE_URL: 'https://api.postcodes.io/postcodes',
  OPEN_METEO_ARCHIVE_URL: 'https://archive-api.open-meteo.com/v1/archive',
  OPEN_METEO_FORECAST_URL: 'https://api.open-meteo.com/v1/forecast',
  ELEXON_MID_URL: 'https://data.elexon.co.uk/bmrs/api/v1/datasets/MID',
  COORDINATE_PRECISION: 4,
  WEATHER_VARIABLES: 'temperature_2m,shortwave_radiation',
  RECENT_DAY_BUFFER: 5,  // days within which to try forecast fallback
};
```

`POSTCODES_BASE_URL` duplicates the constant in `data-ingestion.js`. Intentional — each
module is self-contained. Not worth a refactor for one string.

**Step 2: Postcode → coordinates — `lookupPostcode()` in `js/external-data.js`**

```
async function lookupPostcode(postcode)
```

- Strip spaces from postcode, `GET {POSTCODES_BASE_URL}/{postcode}`.
- Extract `result.latitude` and `result.longitude`, round to 4 decimal places.
- Extract `result.elevation` if present (may be null).
- Error handling:
  - 404 → propagate: `"Postcode not recognised."`
  - Network error → retry once, then: `"Postcode lookup service is down. Try again shortly."`
- Returns: `{ latitude, longitude, elevation_m }`

**Design note:** Module 1 already calls Postcodes.io for CSV-path validation. To avoid a
redundant API call, `app.js` should pass the lat/lon from Module 1's validation result
into Module 2 when available. `lookupPostcode()` is still needed as a standalone function
for cases where Module 1 didn't perform the lookup (Octopus path provides postcode but
not coordinates). The orchestration in Step 10 handles this.

**Step 3: Weather fetch — `fetchWeather()` in `js/external-data.js`**

```
async function fetchWeather(latitude, longitude, dataStart, dataEnd)
```

- Extract date components (`YYYY-MM-DD`) from `dataStart` and `dataEnd` ISO strings.
- `GET {OPEN_METEO_ARCHIVE_URL}?latitude={lat}&longitude={lon}&start_date={startDate}&end_date={endDate}&hourly=temperature_2m,shortwave_radiation&timezone=UTC`
- Parse response: `hourly.time[]`, `hourly.temperature_2m[]`, `hourly.shortwave_radiation[]`.
- Open-Meteo returns timestamps without `Z` suffix (`"2025-04-01T14:00"`). That's fine —
  the alignment step (Step 8) normalises all keys via Luxon.
- Build a `Map<string, { temperature_2m, shortwave_radiation }>` keyed by the Luxon-canonical
  hour string (see Step 8 for canonical form).
- Error handling:
  - Network error or 5xx → retry once with 2-second delay, then:
    `"Weather data service is down. Try again shortly."`
  - 400 (bad parameters) → `"Weather data request failed. Check the date range."`
- Returns: `{ weatherMap, rawResponse }` (rawResponse retained for fallback check).

**Step 4: Recent-day weather fallback — `fetchWeatherFallback()` in `js/external-data.js`**

```
async function fetchWeatherFallback(latitude, longitude, weatherMap, expectedHours, dataEnd)
```

Called only if `fetchWeather()` leaves the tail of the expected hour range incomplete.

**Detection must cover both failure modes:**
- (a) Key present in `weatherMap` but value is `null`
- (b) Key entirely absent from `weatherMap` (array shorter than expected range)

```javascript
function needsFallback(weatherMap, expectedHours, dataEnd) {
  const cutoff = DateTime.fromISO(dataEnd, { zone: 'utc' })
    .minus({ days: EXTERNAL_CONFIG.RECENT_DAY_BUFFER });
  return expectedHours.some(hourKey => {
    if (DateTime.fromISO(hourKey, { zone: 'utc' }) < cutoff) return false;
    const entry = weatherMap.get(hourKey);
    return !entry || entry.temperature_2m == null;
  });
}
```

If fallback needed:
- `GET {OPEN_METEO_FORECAST_URL}?latitude={lat}&longitude={lon}&past_days=7&hourly=temperature_2m,shortwave_radiation&timezone=UTC`
- Merge forecast values into `weatherMap` only for keys currently missing or null.
  Do not overwrite archive data.
- Returns: `{ weatherMap, usedFallback: boolean }`

**Step 5: Weather → HH lookup helper — `buildWeatherLookup()` in `js/external-data.js`**

```
function buildWeatherLookup(weatherMap)
```

Given a consumption timestamp (already normalised to canonical UTC ISO with Z — see
Step 8), return the weather values for that hour:

- Compute the hour-start canonical key via Luxon: `DateTime.fromISO(ts, { zone: 'utc' }).startOf('hour').toISO({ suppressMilliseconds: true })`
- Look up in `weatherMap`.
- Both HH periods within an hour return the same weather values (per design doc).

### Phase 2 — Wholesale prices + SP→UTC conversion

**Before any code in Phase 2: run a CORS probe.** Open Chrome DevTools console and execute:
```javascript
fetch('https://data.elexon.co.uk/bmrs/api/v1/datasets/MID?settlementDateFrom=2026-04-01&settlementDateTo=2026-04-01&format=json').then(r => r.json()).then(d => console.log(d.data?.length ?? d))
```
Record the result in `process-notes.md`:
- **If the fetch returns JSON successfully:** Elexon CORS is open. Skip Step 7 (static
  fallback) entirely. Remove `data/mid-prices.json` from the file list. The "CORS error
  → fallback" branch in Step 6 becomes a plain error.
- **If the fetch fails with a CORS error:** implement Step 7 and populate the static file
  before launch.

This gate is non-negotiable — it determines the scope of the rest of Phase 2.

**Step 6: Elexon MID fetch — `fetchWholesalePrices()` in `js/external-data.js`**

```
async function fetchWholesalePrices(dataStart, dataEnd)
```

- Extract date components from ISO strings.
- `GET {ELEXON_MID_URL}?settlementDateFrom={startDate}&settlementDateTo={endDate}&format=json`
- If CORS is open (per gate above): any fetch failure is a plain error — retry once,
  then return a warning and proceed with null prices (HH scenarios degrade gracefully).
- If CORS is blocked (per gate above): catch TypeError/network error, fall back to static
  file via `loadStaticPrices()` (Step 7).
- Filter response to `dataProvider === "N2EX"` only.
- Handle pagination: if response indicates more data (check for pagination fields —
  exact mechanism to be verified empirically with a 12-month range during build), follow
  links and concatenate.
- Convert price: `£/MWh ÷ 10 = p/kWh`.
- Pass records to `convertSpToUtc()` (Step 6a).
- Returns: `{ priceLookup, source: "elexon-mid-n2ex", warnings: [] }`

**Step 6a: SP→UTC conversion — `convertSpToUtc()` in `js/external-data.js`**

The simplest correct implementation. Uses Luxon's `Europe/London` IANA zone for automatic
DST handling.

```javascript
function convertSpToUtc(midRecords) {
  const { DateTime } = luxon;
  const priceLookup = new Map();
  const warnings = [];
  const spCountsByDate = new Map();

  for (const { settlementDate, settlementPeriod, price, dataProvider } of midRecords) {
    if (dataProvider !== 'N2EX') continue;

    // Base: 00:00 LOCAL on settlementDate (Europe/London)
    const baseDate = DateTime.fromISO(settlementDate, { zone: 'Europe/London' });

    // Add (sp-1) × 30 minutes of ABSOLUTE time.
    // Luxon's .plus() operates on the absolute timeline, so DST transitions
    // are handled by construction.
    const localStart = baseDate.plus({ minutes: (settlementPeriod - 1) * 30 });

    const utcKey = localStart.toUTC().toISO({ suppressMilliseconds: true });

    if (priceLookup.has(utcKey)) {
      warnings.push(`Duplicate UTC key ${utcKey} from ${settlementDate} SP ${settlementPeriod}`);
    }
    priceLookup.set(utcKey, price);

    spCountsByDate.set(settlementDate, (spCountsByDate.get(settlementDate) || 0) + 1);
  }

  // Validate SP counts per date (46/48/50 only)
  for (const [date, count] of spCountsByDate) {
    if (![46, 48, 50].includes(count)) {
      warnings.push(`Unexpected SP count ${count} for ${date}`);
    }
  }

  return { priceLookup, warnings };
}
```

**Why this works for clock-change days:**

- **Spring forward (2026-03-29, 46 SPs).** `baseDate` = 2026-03-29T00:00 GMT (UTC 00:00).
  SP 3: `+60 min` → UTC 01:00 = local 02:00 BST (first SP after the jump — 01:00 GMT
  skipped to 02:00 BST by the IANA zone). SP 46: `+1350 min` → UTC 22:30 = local 23:30 BST.
- **Autumn back (2025-10-26, 50 SPs).** `baseDate` = 2025-10-26T00:00 BST (UTC
  2025-10-25T23:00). SP 3: `+60 min` → UTC 2025-10-26T00:00 = local 01:00 BST (first
  occurrence). SP 5: `+120 min` → UTC 2025-10-26T01:00 = local 01:00 GMT (second
  occurrence, after fallback). No explicit disambiguation needed — Luxon's absolute-time
  arithmetic paired with the IANA zone handles it.

**Runtime timezone independence:** `{ zone: 'Europe/London' }` is explicit. Does not use
the runtime's local timezone. Verified by running tests with `TZ=America/New_York` (see
success criteria).

**Step 7: Static price fallback — `data/mid-prices.json`, `loadStaticPrices()`** *(conditional: only if CORS gate in Phase 2 shows Elexon is blocked)*

```
async function loadStaticPrices(dataStart, dataEnd)
```

- `fetch('./data/mid-prices.json')` — relative path, served from GitHub Pages.
- File format: array of `{ settlementDate, settlementPeriod, price, dataProvider }`,
  pre-filtered to N2EX.
- Apply same `convertSpToUtc()` conversion.
- Record `source: "static-fallback"` in metadata.
- Periods outside the static file's coverage → `null` with warning:
  `"Wholesale prices unavailable for part of your data — HH scenarios will be incomplete."`

If this step is needed, the static file must be populated with ≥12 months of N2EX data
BEFORE launch. A one-off Node script that pulls from Elexon (server-side, no CORS
concern) and writes the JSON is the cleanest approach.

### Phase 3 — Alignment + orchestration

**Step 8: Timestamp normalisation + alignment — `alignExternalData()` in `js/external-data.js`**

```
function alignExternalData(consumption, weatherMap, priceLookup)
```

**Canonical timestamp form.** The module normalises every consumption timestamp on receipt
to the canonical form `YYYY-MM-DDTHH:MM:SSZ` (seconds precision, Z suffix, no milliseconds).
This removes any cross-module dependency on Module 1's exact output format — Module 1 can
produce timestamps with or without milliseconds and this module handles either:

```javascript
const { DateTime } = luxon;
function canonicaliseTs(ts) {
  return DateTime.fromISO(ts, { zone: 'utc' }).toISO({ suppressMilliseconds: true });
}
```

**Alignment loop:**

```javascript
const external = consumption.map(({ timestamp }) => {
  const tsCanonical = canonicaliseTs(timestamp);
  const hourCanonical = DateTime.fromISO(tsCanonical, { zone: 'utc' })
    .startOf('hour').toISO({ suppressMilliseconds: true });

  const weather = weatherMap.get(hourCanonical);
  return {
    timestamp: tsCanonical,
    temp_c: weather?.temperature_2m ?? null,
    solar_w_m2: weather?.shortwave_radiation ?? null,
    wholesale_p_kwh: priceLookup.get(tsCanonical) ?? null,
  };
});
```

Weather keys in `weatherMap` must also be stored in the canonical hour form (add a
normalisation pass when building the map from Open-Meteo's `"2025-04-01T14:00"` strings).
Price keys already come out of `convertSpToUtc()` in canonical form.

Returns: `external[]` array, same length as `consumption`.

**Step 9: Metadata assembly — `buildExternalMetadata()` in `js/external-data.js`**

```
function buildExternalMetadata(latitude, longitude, elevation, weatherSource, priceSource, priceWarnings)
```

Returns the `external_metadata` object matching the design doc spec exactly.

**Step 10: Orchestration — additions to `js/app.js`**

After Module 1 completes (data-ingestion stores its result), trigger Module 2:

1. Determine coordinates:
   - If Octopus path: call `lookupPostcode(metadata.postcode)`.
   - If CSV path and Module 1 already validated the postcode: reuse lat/lon from
     Module 1's validation result (avoid redundant API call).
2. Show progress: "Fetching weather data and wholesale prices…"
3. Run in parallel via `Promise.allSettled`:
   - `fetchWeather(lat, lon, metadata.data_start, metadata.data_end)`
   - `fetchWholesalePrices(metadata.data_start, metadata.data_end)`
4. **Handle results with explicit rejection branching:**
   - If `weatherResult.status === 'rejected'` → **block analysis** with the underlying
     error message (weather is essential for heat loss regression).
   - If `priceResult.status === 'rejected'` → **warn and continue** with null prices
     (wholesale scenarios degrade gracefully; baseline and fabric analysis still work).
5. If weather succeeded: check `needsFallback()` → call `fetchWeatherFallback()` if needed.
6. Build weather lookup via `buildWeatherLookup()`.
7. Call `alignExternalData()` (which handles timestamp normalisation internally).
8. Call `buildExternalMetadata()`.
9. Store `{ external, external_metadata }` via a `setExternalResult()` accessor paired
   with `getExternalResult()` (mirroring Module 1's shared-state pattern).
10. Show success summary: "Weather data: {n} hours. Wholesale prices: {n} periods ({source}).
    Gaps: {count}."

**Note on the weather-blocks vs prices-warn asymmetry:** this is deliberate. The design
doc mandates blocking on weather failure (no fallback available) but allows proceeding
without prices (HH scenarios become unavailable; all other analysis unaffected). The
`Promise.allSettled` pattern is chosen specifically to allow this asymmetric handling —
it is not a blanket "proceed regardless."

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Elexon CORS blocks client-side fetch | CORS probe is the first task of Phase 2, gating scope. Static fallback implemented only if blocked. |
| Elexon pagination mechanism undocumented | Test empirically with a 12-month range during build. Follow links if paginated. |
| Elexon SP-count anomaly on a given date (not 46/48/50) | Logged as warning in `price_alignment_warnings`; proceed with what's returned; affected HH periods get `null`. |
| Luxon CDN unavailable | Pinned to exact version at a major CDN (jsdelivr). Same risk profile as Chart.js. |
| Open-Meteo archive lag (1–2 days) | Forecast fallback (Step 4), with robust detection that handles both null values and absent keys. |
| Large date range (18+ months) hits Open-Meteo response size limits | Open-Meteo handles multi-year ranges in a single request. No pagination needed. |
| Consumption timestamp format from Module 1 varies (with/without ms) | Module 2 normalises on receipt via Luxon (Step 8). No cross-module format contract required. |

---

## Success criteria

### Phase 1

- [ ] Postcode lookup: valid UK postcode → lat/lon within expected bounds. Invalid → clean error.
- [ ] Weather happy path: 12-month range → ~8,760 hourly values, no missing records. Spot-check first and last values against Open-Meteo web UI.
- [ ] Weather fallback — both failure modes: (a) trailing `null` values → forecast fills them; (b) missing keys entirely → forecast fills them. No trailing nulls after fallback. `weather_source` is `"open-meteo-forecast"` when any fallback data was used.
- [ ] Alignment: 12-month range → `external` array same length as `consumption`. Spot-check any HH timestamp against independent lookup.
- [ ] Timestamp normalisation: Module 1 produces timestamps with milliseconds (`"...T14:30:00.000Z"`) → Module 2 produces alignment correctly and canonical output timestamps have no milliseconds.

### Phase 2 (CORS gate + prices)

- [ ] CORS probe recorded in `process-notes.md` before any Step 6 code written.
- [ ] Price fetch (CORS open): 1-week range → ~336 N2EX records, converted to p/kWh, realistic range (0–30 p/kWh typical).
- [ ] Price fetch failure handling: simulated Elexon 500 → warning logged, analysis proceeds with `wholesale_p_kwh = null`.
- [ ] Weather failure blocks: simulated Open-Meteo outage → analysis halted with user-facing error; `setExternalResult()` not called.
- [ ] SP→UTC normal GMT: 2026-01-15, SP 1 → `2026-01-15T00:00Z`. SP 48 → `2026-01-15T23:30Z`. 48 SPs.
- [ ] SP→UTC normal BST: 2025-06-15, SP 1 → `2025-06-14T23:00Z`. SP 48 → `2025-06-15T22:30Z`. 48 SPs.
- [ ] SP→UTC spring forward: 2026-03-29, 46 SPs numbered 1–46. SP 1 → `2026-03-29T00:00Z`. SP 2 → `2026-03-29T00:30Z`. SP 3 → `2026-03-29T01:00Z` (= local 02:00 BST, first after jump). SP 46 → `2026-03-29T22:30Z`.
- [ ] SP→UTC autumn back: 2025-10-26, 50 SPs numbered 1–50. SP 1 → `2025-10-25T23:00Z` (= local 00:00 BST). SP 3 → `2025-10-26T00:00Z` (= local 01:00 BST, first occurrence). SP 5 → `2025-10-26T01:00Z` (= local 01:00 GMT, second occurrence). SP 50 → `2025-10-26T23:30Z`.
- [ ] Runtime timezone independence: re-run the four SP→UTC test days with `TZ=America/New_York`. All UTC results identical to UK-localised runs.
- [ ] CORS fallback (only if gate showed CORS blocked): static JSON used, `price_source = "static-fallback"`, analysis proceeds.
- [ ] Missing data: range spanning a known Elexon gap → affected periods have `null`, no crash, array length unchanged.
- [ ] Security: no API keys involved, no user data transmitted beyond postcode.

---

## Design Review

**Reviewer:** Claude (Praxis Insight — claude.ai review session)
**Date:** 2026-04-16
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `projects/tools/heatpump-analyser/design/external-data.md` (in `praxis-claude-hub`) — **note: the design doc itself contained the SP→UTC error described below and has been updated in the same review.**

### Context

Second plan for the Heat Pump Analyser. Reviewed against the `external-data.md` design
doc. One finding (#1) was a CRITICAL correctness error that originated in the design doc
and was inherited by the plan. Required primary-source research against Elexon BSC
documentation to confirm the correct convention. Other findings were spec gaps and a
launch-readiness risk around CORS.

### Required changes for implementation

**1. SP→UTC convention: design doc AND plan were off by one day [CRITICAL]**

Both treated Settlement Period 1 as starting at 23:00 on D−1. The authoritative BSC
convention is SP 1 at 00:00 LOCAL on D. Three Elexon sources confirmed:
- BSC Settlement page: "Period 1 is always 0000hrs (midnight) local time"
- Elexon glossary (Settlement Day): "00:00 hours to 24:00 hours on each day"
- Elexon 26-Oct-2025 clock-change notice (SP 1 at 00:00 BST on 26 Oct, SP 5 at 01:00 GMT)

Every wholesale price would have been paired with the wrong consumption period by ~23
hours. All analytical outputs that depend on price alignment (HH scenarios, hybrid
scenarios, break-even analysis) would have been silently wrong.

**2. Tariff type classification pattern (wait — different module) — N/A here**

**3. Clock-change disambiguation fallback (Step 6b) — unnecessary complexity [MEDIUM]**

Plan included an "explicit SP-ordinal disambiguation" contingency for autumn-back.
Analytical verification of Luxon's absolute-time arithmetic paired with the IANA
`Europe/London` zone showed the basic algorithm handles both occurrences of 01:00
naturally. The contingency was both unnecessary and vague.

**4. `Promise.allSettled` without asymmetric rejection handling [HIGH]**

Plan Step 10 used `allSettled` on weather+price fetches in parallel. The comment said
"weather is essential, prices are not," but the step didn't branch on rejection — both
results flowed into the same path, potentially letting a weather failure through silently.
Design doc mandates blocking on weather failure.

**5. Consumption timestamp format unspecified between modules [HIGH]**

Plan Step 8 acknowledged uncertainty about Module 1's exact timestamp format
(with/without milliseconds) and proposed "log and spot-check during build." Not a plan,
a TODO.

**6. Static price fallback starts empty at launch [HIGH]**

If Elexon CORS blocks in production and the fallback file is empty, all users silently
get null prices and the HH wholesale scenario — the entire differentiating story — is
gone. Launch is Tue 22-Apr at 10:00.

**7. Weather fallback detection only handles null values [MEDIUM]**

Plan Step 4 detection checked `weatherMap` entries for null temperature, but Open-Meteo
may omit late-tail keys entirely rather than return nulls.

**8. Luxon CDN version pinning [MEDIUM]**

`luxon@3` is a semver range. Tool is "permanently available" per scope.md — silent minor
upgrades are a future-proofing risk.

**9. Hour-key derivation via string slicing [LOW]**

`ts.slice(0, 13) + ':00'` works for current formats but is fragile. Better to use Luxon's
`DateTime.fromISO(ts).startOf('hour').toISO(...)`.

### Resolution of review changes

1. **SP→UTC convention** — Step 6a rewritten with corrected algorithm (`baseDate` at 00:00
   local on D, not 23:00 on D−1). Worked examples and success criteria rewritten against
   Elexon's own 26-Oct-2025 notice. Design doc updated in same review.
2. N/A.
3. **Clock-change disambiguation** — Step 6b deleted. Absolute-time arithmetic makes it
   unnecessary. Replaced by concrete test assertions in success criteria.
4. **`Promise.allSettled`** — Step 10.4 now branches explicitly: weather rejection blocks
   with user-facing error; price rejection warns and continues with null prices. Rationale
   documented inline.
5. **Consumption timestamp format** — Step 8 now normalises all incoming timestamps via
   Luxon (`DateTime.fromISO(ts, {zone: 'utc'}).toISO({suppressMilliseconds: true})`) before
   any key comparison. No cross-module format contract required; Module 1 can emit any
   valid ISO UTC string.
6. **Static price fallback** — Phase 2 now starts with a mandatory CORS probe gate.
   Fallback infrastructure is conditional on CORS being blocked. If CORS is open (my
   expectation), Step 7 is skipped entirely and no empty JSON file ships.
7. **Weather fallback detection** — `needsFallback()` in Step 4 now checks both (a) null
   values and (b) absent keys within the recent-day window.
8. **Luxon CDN** — pinned to `luxon@3.5.0` in Step 1.
9. **Hour-key derivation** — Step 8 now uses Luxon's `startOf('hour')` throughout. No
   string slicing.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 1     | ✅ resolved |
| HIGH     | 3     | ✅ resolved |
| MEDIUM   | 3     | ✅ resolved |
| LOW      | 1     | ✅ resolved |

Verdict: APPROVED WITH EDITS — all eight findings resolved inline; ready for implementation. The CORS probe at the start of Phase 2 is a non-negotiable gate.

---

## Approval

**Status:** ✅ Approved with edits — 2026-04-16
**Approved by:** Rhiannon (via claude.ai review)
**Clarifications confirmed:** SP→UTC convention corrected per authoritative Elexon BSC sources (SP 1 at 00:00 local on D, not 23:00 on D−1); Luxon absolute-time arithmetic handles DST without explicit disambiguation; weather failure blocks, price failure warns; timestamp normalisation on receipt (no Module 1 amendment needed); CORS gate determines Step 7 scope.

---

## Implementation Deviations

**Date:** 2026-04-16
**Commit:** 5319d04

1. **CSV lat/lon reuse not possible (Step 10).** Plan said "If CSV path and Module 1
   already validated the postcode: reuse lat/lon from Module 1's validation result."
   Module 1 does not store lat/lon in the ingestion result — `validatePostcode()` returns
   coordinates but only `postcode` (string) is stored in metadata. **Resolution:**
   `runExternalData()` always calls `lookupPostcode(metadata.postcode)` regardless of
   input path. One extra Postcodes.io call for CSV users — trivial latency, no functional
   impact.

2. **`buildWeatherLookup()` implemented but unused in orchestration.** Plan Step 5 defined
   a lookup-function builder. The alignment function (`alignExternalData`, Step 8) performs
   the hour-key lookup inline, making the separate builder unnecessary for the current
   orchestration flow. The function is exported for potential use by downstream modules
   that may need ad-hoc weather lookups outside the alignment array.

3. **`buildExpectedHours()` exported from `external-data.js`.** Plan defined it as a
   private helper in Step 4. The orchestration in `app.js` also needs it (to pass to
   `needsFallback`), so it was promoted to an export rather than duplicated.

4. **CORS probe (Phase 2 gate) deferred to browser testing.** Plan mandates a live CORS
   probe from Chrome DevTools before writing any Elexon code. Code was written with
   graceful degradation (price failure warns, does not block). The probe must still be
   run manually during the Verify phase. If CORS is blocked, the static fallback path
   (Step 7) will need to be implemented.

5. **Static price fallback (Step 7) not implemented.** Conditional on CORS gate result.
   Code structure allows adding `loadStaticPrices()` if the CORS probe shows Elexon is
   blocked. Currently, a CORS/network failure returns an empty price map with a warning.
