# Module 2 — External Data

**Date:** 2026-04-16
**Status:** Awaiting approval — review via claude.ai before implementation begins.

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

### Timezone handling — the critical decision

The design doc specifies three options for DST-aware SP→UTC conversion: Temporal API,
Luxon, or date-fns-tz. Evaluation:

1. **Temporal API** — Not yet available in any stable browser release as of April 2026.
   Behind flags in Chrome/Firefox but not shippable for a public tool. Ruled out.

2. **Luxon** — 70KB minified, available via CDN. Full IANA timezone support.
   `DateTime.fromObject({...}, { zone: "Europe/London" }).toUTC()` is exactly the API
   we need. Maintained by a moment.js co-author. No build step required — loads as a
   single `<script>` tag from cdnjs/unpkg. Consistent with the project's use of Chart.js
   via CDN (utility library, not a framework).

3. **date-fns-tz** — Tree-shakeable but designed for bundler workflows. No clean CDN
   single-file option. Poor fit for a no-build-step project. Ruled out.

**Recommendation: Luxon via CDN.** It's the only option that satisfies all three
constraints: DST-correct, no build step, browser-timezone-independent. The design doc
explicitly states that `new Date()` and manual DST arithmetic are not acceptable.

### API endpoints — confirmed from design doc research

- **Postcodes.io** — `GET /postcodes/{postcode}`, no auth, CORS confirmed. Already used
  in Module 1 for postcode validation; this module reuses the lat/lon from that call
  rather than re-fetching.
- **Open-Meteo Archive** — `GET /v1/archive` with lat, lon, date range, hourly variables.
  Free, no auth, CORS confirmed. Returns parallel arrays of timestamps and values.
- **Open-Meteo Forecast** — `GET /v1/forecast` with `past_days` for recent-day fallback.
  Same format as archive API.
- **Elexon MID** — `GET /bmrs/api/v1/datasets/MID` with date range, JSON format.
  No auth. CORS status uncertain — design doc specifies static-file fallback if blocked.

### No other libraries required

All remaining operations (array alignment, lookup maps, null handling) are straightforward
vanilla JS.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/external-data.js` | Core module: postcode lookup, weather fetch, price fetch, SP→UTC conversion, timeline alignment |
| MODIFY | `index.html` | Add Luxon CDN script tag; add progress indicators for external data fetch |
| MODIFY | `js/app.js` | Wire external-data fetch into the pipeline after data-ingestion completes |
| CREATE | `data/mid-prices.json` | Static fallback file for Elexon CORS scenario (initially empty structure; populated manually or via a script) |

---

## Implementation steps

### Phase 1 — Postcode lookup + weather fetch + alignment

This phase delivers weather data aligned to the consumption timeline. It's independently
useful for downstream modules (baseload, heat loss) even without wholesale prices.

**Step 1: Luxon CDN + module skeleton — `index.html`, `js/external-data.js`**

Add Luxon via CDN to `index.html` (before `external-data.js`):
```html
<script src="https://cdn.jsdelivr.net/npm/luxon@3/build/global/luxon.min.js"></script>
```

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

Note: `POSTCODES_BASE_URL` duplicates the constant in `data-ingestion.js`. This is
intentional — each module is self-contained. If a future refactor extracts shared
constants, that's a separate task.

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

**Design note:** Module 1 already calls Postcodes.io for CSV-path validation. To avoid
a redundant API call, `app.js` should pass the lat/lon from Module 1's validation result
into Module 2 when available. `lookupPostcode()` is still needed as a standalone function
for cases where Module 1 didn't perform the lookup (Octopus path provides postcode but
not coordinates). The orchestration in Step 8 handles this.

**Step 3: Weather fetch — `fetchWeather()` in `js/external-data.js`**

```
async function fetchWeather(latitude, longitude, dataStart, dataEnd)
```

- Extract date components (`YYYY-MM-DD`) from `dataStart` and `dataEnd` ISO strings.
- `GET {OPEN_METEO_ARCHIVE_URL}?latitude={lat}&longitude={lon}&start_date={startDate}&end_date={endDate}&hourly=temperature_2m,shortwave_radiation&timezone=UTC`
- Parse response: `hourly.time[]`, `hourly.temperature_2m[]`, `hourly.shortwave_radiation[]`.
- Build a `Map<string, { temperature_2m, shortwave_radiation }>` keyed by the hour
  string (e.g. `"2025-04-01T14:00"`). Open-Meteo returns timestamps without `Z` suffix;
  store keys without `Z` to match this format. The alignment step (Step 6) handles the
  format difference.
- Error handling:
  - Network error or 5xx → retry once with 2-second delay, then:
    `"Weather data service is down. Try again shortly."`
  - 400 (bad parameters) → `"Weather data request failed. Check the date range."`
- Returns: `{ weatherMap, rawResponse }` (rawResponse retained for fallback check).

**Step 4: Recent-day weather fallback — `fetchWeatherFallback()` in `js/external-data.js`**

```
async function fetchWeatherFallback(latitude, longitude, weatherMap, dataEnd)
```

- Called only if `fetchWeather()` returns trailing `null` values within the last
  `RECENT_DAY_BUFFER` days.
- Detection: check the last 5 days of keys in `weatherMap` — if any have `null`
  temperature, fallback is needed.
- `GET {OPEN_METEO_FORECAST_URL}?latitude={lat}&longitude={lon}&past_days=7&hourly=temperature_2m,shortwave_radiation&timezone=UTC`
- Merge forecast values into `weatherMap` only for keys that are currently `null`.
  Do not overwrite archive data.
- Returns: `{ weatherMap, usedFallback: boolean }`

**Step 5: Weather → HH alignment helper — `buildWeatherLookup()` in `js/external-data.js`**

```
function buildWeatherLookup(weatherMap)
```

This is a thin wrapper that the alignment step uses. Given a consumption timestamp
(ISO 8601 UTC with `Z`), it returns the weather values for that hour.

- Truncate timestamp to the hour: `"2025-04-01T14:30:00.000Z"` → `"2025-04-01T14:00"`.
- Look up in `weatherMap`.
- Both HH periods within an hour return the same weather values (per design doc:
  temperature doesn't change meaningfully within 30 minutes).

### Phase 2 — Wholesale prices + SP→UTC conversion

This is the high-risk phase. The SP→UTC conversion must be implemented and tested
carefully.

**Step 6: Elexon MID fetch — `fetchWholesalePrices()` in `js/external-data.js`**

```
async function fetchWholesalePrices(dataStart, dataEnd)
```

- Extract date components from ISO strings.
- `GET {ELEXON_MID_URL}?settlementDateFrom={startDate}&settlementDateTo={endDate}&format=json`
- Handle CORS error: catch TypeError/network error, fall back to static file
  (see Step 7).
- Filter response to `dataProvider === "N2EX"` only.
- Handle pagination: if response indicates more data (check for pagination fields —
  the exact mechanism needs empirical verification during build), follow links and
  concatenate.
- Convert price: `£/MWh ÷ 10 = p/kWh`.
- Pass records to `convertSpToUtc()` (Step 6a).
- Returns: `{ priceLookup, source: "elexon-mid-n2ex", warnings: [] }`

**Step 6a: SP→UTC conversion — `convertSpToUtc()` in `js/external-data.js`**

This is the most complex function in the module. Uses Luxon for all timezone operations.

```
function convertSpToUtc(midRecords)
```

For each `{ settlementDate, settlementPeriod, price }` record:

1. Compute naive local start:
   ```javascript
   // Settlement date D, SP starts at 23:00 on D-1
   const { DateTime } = luxon;
   const baseDate = DateTime.fromISO(settlementDate, { zone: 'Europe/London' });
   const dayBefore = baseDate.minus({ days: 1 });
   const localStart = dayBefore.set({ hour: 23, minute: 0, second: 0, millisecond: 0 })
     .plus({ minutes: (settlementPeriod - 1) * 30 });
   ```

2. Luxon handles DST automatically:
   - On spring-forward days, adding minutes across the gap correctly jumps the clock.
   - On autumn-back days, Luxon's arithmetic stays in the pre-change offset for the
     first pass through the repeated hour, which matches the expected behaviour
     (earlier-numbered SPs are BST, later are GMT). **This needs empirical verification
     against the worked examples in the design doc during implementation.**

3. Convert to UTC:
   ```javascript
   const utcStart = localStart.toUTC();
   const utcKey = utcStart.toISO({ suppressMilliseconds: true }); // "2025-04-01T14:00:00Z"
   ```

4. Build lookup `Map<string, number>` keyed by UTC ISO string → price in p/kWh.

5. Track warnings in `price_alignment_warnings`:
   - If a settlement date has SP count ≠ 46, 48, or 50 → warn.
   - If duplicate UTC keys are produced → warn (indicates conversion error).

Returns: `{ priceLookup: Map, warnings: string[] }`

**Critical test requirement:** The design doc specifies runtime timezone independence
(test criterion 9). The Luxon approach inherently satisfies this because
`{ zone: 'Europe/London' }` is explicit — it does not use the runtime's local timezone.
This must still be verified with `TZ=America/New_York` during testing.

**Step 6b: Autumn back disambiguation — detail**

On autumn-back days (last Sunday of October), the local hour 01:00–02:00 occurs twice.
Luxon's `plus()` arithmetic starting from 23:00 the previous day will naturally produce:

- SP 5 (01:00 first occurrence, BST): `plus({ minutes: 120 })` from 23:00 GMT the
  previous night = 01:00 BST (UTC+1) → UTC 00:00. Correct.
- SP 7 (01:00 second occurrence, GMT): `plus({ minutes: 180 })` from 23:00 GMT =
  01:00 GMT (UTC+0) → UTC 01:00. **This relies on Luxon maintaining the BST→GMT
  transition correctly during arithmetic.**

**This must be tested against the design doc's worked examples before proceeding past
Phase 2.** If Luxon's arithmetic does not produce the correct mapping for the autumn-back
SPs, an explicit disambiguation approach using the SP ordinal will be needed:
- Count SPs covering the 01:00–02:00 local hour
- First pair: force BST interpretation
- Second pair: force GMT interpretation

**Step 7: Static price fallback — `data/mid-prices.json`, `loadStaticPrices()`**

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

Initially, `data/mid-prices.json` will be an empty array `[]`. Rhiannon can populate it
with a script or manual download if CORS proves to be a real issue. The module handles an
empty file gracefully (all prices → `null`, warning displayed).

### Phase 3 — Alignment + orchestration

**Step 8: Final alignment — `alignExternalData()` in `js/external-data.js`**

```
function alignExternalData(consumption, weatherLookup, priceLookup)
```

- Iterate over `consumption` array.
- For each `consumption[i]`:
  ```javascript
  const ts = consumption[i].timestamp;
  const hourKey = ts.slice(0, 13) + ':00'; // "2025-04-01T14:30:00.000Z" → "2025-04-01T14:00"
  // Note: remove trailing Z for weather map lookup
  const weatherKey = hourKey.replace('Z', '');
  ```
  Wait — this needs care. The consumption timestamps are full ISO with Z suffix
  (`"2025-04-01T14:30:00.000Z"` or similar from Module 1). The weather map keys are
  Open-Meteo format without Z (`"2025-04-01T14:00"`). The price lookup keys are Luxon
  UTC ISO strings with Z (`"2025-04-01T14:00:00Z"`).

  Normalise the lookup:
  ```javascript
  const hourNoZ = ts.slice(0, 13) + ':00';  // "2025-04-01T14:00" — for weather
  const hhUtcIso = ts.slice(0, 19) + 'Z';   // normalise to seconds precision with Z — for prices
  // But prices are keyed at HH start, which IS the consumption timestamp...
  ```

  The exact key format depends on what Module 1 produces and what the Luxon conversion
  produces. **During implementation, log both key formats and verify alignment with a
  spot-check before proceeding.**

- Build output:
  ```javascript
  external[i] = {
    timestamp: ts,
    temp_c: weatherMap.get(hourNoZ)?.temperature_2m ?? null,
    solar_w_m2: weatherMap.get(hourNoZ)?.shortwave_radiation ?? null,
    wholesale_p_kwh: priceLookup.get(priceKey) ?? null,
  };
  ```

- Returns: `external[]` array, same length as `consumption`.

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
4. Check weather fallback need → call `fetchWeatherFallback()` if needed.
5. Build weather lookup via `buildWeatherLookup()`.
6. Call `alignExternalData()`.
7. Call `buildExternalMetadata()`.
8. Store `{ external, external_metadata }` for downstream modules.
9. Show success summary: "Weather data: {n} hours. Wholesale prices: {n} periods.
   Gaps: {count}."
10. If price fetch failed entirely: show warning but proceed (prices are enhancing,
    not essential for heat loss analysis).

Use `Promise.allSettled` (not `Promise.all`) because weather is essential but prices
are not — a price failure should not block the weather path.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Luxon's `plus()` arithmetic may not correctly disambiguate autumn-back repeated hour | Test against all 5 worked examples in design doc before proceeding. Fallback: explicit SP-ordinal disambiguation (Step 6b). |
| Elexon CORS blocks client-side fetch | Static JSON fallback (Step 7). Design doc specifies this approach. |
| Elexon pagination mechanism undocumented in design doc | Test empirically with a 12-month range during build. If paginated, follow links. If not, single fetch suffices. |
| Key format mismatch between weather map, price lookup, and consumption timestamps | Log and spot-check during Step 8 implementation. Normalise keys explicitly. |
| Luxon CDN unavailable | Extremely unlikely for jsdelivr/cdnjs. No mitigation needed — same risk profile as Chart.js CDN. |
| Open-Meteo archive lag (1–2 days) | Forecast fallback (Step 4). Already specified in design doc. |
| Large date range (18+ months) may hit Open-Meteo response size limits | Open-Meteo handles multi-year ranges in a single request. No pagination needed. |

---

## Success criteria

- [ ] Postcode lookup: valid UK postcode → lat/lon within expected bounds. Invalid → clean error.
- [ ] Weather happy path: 12-month range → ~8,760 hourly values, no missing records. Spot-check first and last values against Open-Meteo web UI.
- [ ] Weather fallback: data_end is yesterday → archive returns nulls for tail → forecast API fills them → no trailing nulls → `weather_source` is `"open-meteo-forecast"`.
- [ ] Price fetch: 1-week range → ~336 N2EX records, converted to p/kWh, realistic range (0–30 p/kWh typical).
- [ ] SP→UTC normal GMT: settlement date 2026-01-15, SP 1 → `2026-01-14T23:00Z`, SP 48 → `2026-01-15T22:30Z`. 48 SPs.
- [ ] SP→UTC normal BST: settlement date 2025-06-15, SP 1 → `2025-06-14T22:00Z`, SP 48 → `2025-06-15T21:30Z`. 48 SPs.
- [ ] SP→UTC spring forward: 2026-03-29, 46 SPs returned. SP 2 → `2026-03-28T23:30Z`. SP 5 → `2026-03-29T01:00Z`. SPs 3–4 absent.
- [ ] SP→UTC autumn back: 2025-10-26, 50 SPs returned. First 01:00 pair → UTC `00:00Z`/`00:30Z`. Second 01:00 pair → UTC `01:00Z`/`01:30Z`.
- [ ] Runtime timezone independence: SP→UTC tests produce identical results with `TZ=America/New_York`.
- [ ] Alignment: 12-month range → `external` array same length as `consumption`. Spot-check any HH timestamp against independent lookup.
- [ ] CORS fallback: simulated CORS block → static file used, `price_source = "static-fallback"`, analysis proceeds.
- [ ] Missing data: range spanning known Elexon gap → affected periods have `null`, no crash, array length unchanged.
- [ ] Partial failure: weather succeeds but prices fail entirely → analysis proceeds with null prices and warning displayed.
- [ ] Security: no API keys involved (all APIs are unauthenticated), no user data transmitted beyond postcode.

---

## Claude.ai Review — yyyy-mm-dd

**Reviewer:** Claude (claude.ai)

**Overall verdict:** [Approved / Approved with clarifications / Revise and resubmit]

### What is solid
[What the plan gets right. Be specific.]

### Clarifications required before implementation
[Any ambiguity, missing specification, or underdefined behaviour that would force
Claude Code to make an undocumented decision mid-build. Each item must include
the resolution — not just the problem.]

### Minor observations (not blockers)
[Optional. Suggestions for V2, style notes, things to keep in mind.]

---

## Approval

**Status:** [Pending]
**Approved by:**
**Clarifications confirmed:**

---

## Implementation Deviations

**Date:**
**Commit:**

[For each deviation from the approved plan, document:]

[If no deviations: "None."]
