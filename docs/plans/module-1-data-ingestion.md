# Module 1 — Data Ingestion

**Date:** 2026-04-16
**Status:** ✅ Approved with edits — 2026-04-16 (see Design Review below)

---

## Task description

Build the data ingestion module: the entry point for the entire Heat Pump Analyser pipeline. Two input paths (Octopus Energy API and CSV upload) feed into a shared normalisation layer that produces a unified half-hourly consumption array, tariff rate timeline, and property metadata object. All downstream modules consume this output.

This is the first module to be implemented. No existing code exists beyond the repo scaffolding (index.html, css/, js/ directories are not yet created).

---

## Research findings

No external libraries required beyond what the browser provides natively:

- **Octopus Energy API** — RESTful, Basic Auth, CORS confirmed for client-side JS. `page_size=25000` retrieves a full year per fuel type in one request. Pagination via `next` URL handles longer histories. Account endpoint returns MPAN/MPRN, meter serials, postcode, and tariff agreements in a single call.
- **Octopus tariff rates** — `/v1/products/{product_code}/electricity-tariffs/{tariff_code}/standard-unit-rates/` (and `/standing-charges/`, and `gas-tariffs` variants) return time-indexed rate arrays for every tariff type (SVT, Fixed, Tracker, Agile, Go, Cosy). Tariff type affects only record density, not the retrieval approach. No authentication required for these endpoints.
- **Postcodes.io** — Free, no auth, CORS confirmed. `GET /postcodes/{postcode}` returns lat/lon.
- **CSV parsing** — Format is simple (3 columns, comma-separated). Manual `split(',')` parsing is appropriate; no library needed.
- **Date handling** — All internal timestamps are ISO 8601 UTC. For Europe/London timezone detection on CSV timestamps without explicit timezone, use `Intl.DateTimeFormat` — no library required.
- **Fetch API** — Native browser `fetch()` with Basic Auth header for Octopus calls. No Axios or similar needed.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `index.html` | Page structure: data input section with Octopus/CSV tabs |
| CREATE | `css/styles.css` | Design tokens, base layout, form styles, responsive grid |
| CREATE | `js/app.js` | Module orchestration — wires UI events to data-ingestion functions |
| CREATE | `js/data-ingestion.js` | Core module: API client, CSV parser, normalisation, validation |

---

## Implementation steps

### Phase 1 — Octopus API path + shared normalisation + scaffolding

This phase delivers a working tool that accepts Octopus credentials and produces normalised output. It establishes the HTML/CSS/JS scaffolding that all subsequent modules build on. Phase 1 also includes the multiple-properties selection UI and data-quality warnings/blocks so the module is safe to hand off to downstream modules.

**Step 1: Project scaffolding — `index.html`, `css/styles.css`**

Create the HTML page structure with:
- `<head>` with meta tags, viewport, link to `styles.css`, Chart.js CDN
- Data input section with two-tab UI (Octopus / CSV) — only Octopus tab functional in Phase 1
- Octopus tab: API key field (`type="password"`), account number field, "Fetch Data" button, status/error display area, gas unit sanity check area (initially hidden), property selection area (initially hidden)
- CSV tab: placeholder "Coming in Phase 2"
- Progress indicator area
- Results area (placeholder sections for downstream modules)

CSS with:
- Design tokens as CSS custom properties: `--colour-teal: #3B8284`, `--colour-coral: #FD7A7F`, `--colour-navy: #26588D`, `--colour-dark: #2A3439`
- Base typography, form/button/tab/status styles
- Responsive breakpoints: 375px, 768px, 1280px
- Utility: `.hidden { display: none; }`

**Step 2: Constants and configuration — top of `js/data-ingestion.js`**

```javascript
const CONFIG = {
  OCTOPUS_BASE_URL: 'https://api.octopus.energy/v1',
  POSTCODES_BASE_URL: 'https://api.postcodes.io/postcodes',
  DEFAULT_POSTCODE: 'CV35 0AA',
  DEFAULT_GAS_RATE_P_KWH: 5.7,
  DEFAULT_ELEC_RATE_P_KWH: 24.5,
  DEFAULT_GAS_STANDING_P_DAY: 31.4,
  DEFAULT_ELEC_STANDING_P_DAY: 61.6,
  GAS_VOLUME_CORRECTION: 1.02264,
  GAS_CALORIFIC_VALUE_MJ: 39.5,
  GAS_M3_TO_KWH: 11.19,
  CONSUMPTION_PAGE_SIZE: 25000,
  TARIFF_PAGE_SIZE: 1500,
  LOOKBACK_MS: 365 * 24 * 60 * 60 * 1000,
  MIN_DAYS_FOR_ANALYSIS: 30,
  WARNING_DAYS_THRESHOLD: 90,
  GAP_WARNING_PERCENTAGE: 10,
  HH_INTERVAL_MS: 30 * 60 * 1000,
};
```

**Step 3: Account discovery — `fetchAccount()` in `js/data-ingestion.js`**

```
async function fetchAccount(apiKey, accountNumber)
```

- `GET {BASE_URL}/accounts/{accountNumber}/` with Basic Auth (`btoa(apiKey + ':')`)
- Extract from each property:
  - `electricity_meter_points[0].mpan`
  - `electricity_meter_points[0].meters` → last element (most recent). If >1 meter present, log all serial numbers to console; Phase 1 uses the most recent only (meter replacement stitching is Phase 2).
  - `gas_meter_points[0].mprn`
  - `gas_meter_points[0].meters` → last element (same fallback)
  - Postcode from property object
  - Tariff agreements from both meter points
- Error handling:
  - 401 → `"API key not recognised. Check your key at octopus.energy/dashboard."`
  - 404 → `"Account not found. Check the format: A-XXXXABCD."`
  - Network error → `"Could not reach the Octopus API. Check your internet connection and try again."`
  - 429 → `"Octopus API is busy. Wait a moment and try again."`
- Returns: `{ properties: [{ mpan, mprn, elecSerial, gasSerial, postcode, address, elecAgreements, gasAgreements }, ...] }`

The function always returns an array of properties. The orchestrator (Step 8) decides whether to auto-select (single) or present a selection UI (multiple).

**Step 4: Consumption retrieval — `fetchConsumption()` in `js/data-ingestion.js`**

```
async function fetchConsumption(apiKey, mpan, mprn, elecSerial, gasSerial)
```

- Calculate date range:
  ```
  periodTo = new Date();
  periodFrom = new Date(Date.now() - CONFIG.LOOKBACK_MS);
  periodFrom.setUTCHours(0, 0, 0, 0);  // floor to midnight UTC
  ```
  Append `Z` to both timestamps in the query string to force UTC interpretation.
- Two parallel fetches via `Promise.all`:
  - `GET /electricity-meter-points/{MPAN}/meters/{serial}/consumption/?period_from=...Z&period_to=...Z&page_size=25000&order_by=period`
  - `GET /gas-meter-points/{MPRN}/meters/{serial}/consumption/?period_from=...Z&period_to=...Z&page_size=25000&order_by=period`
- Pagination: follow `next` URL until null, concatenating results.
- Empty results → `"No half-hourly data found. This tool requires a smart meter (SMETS1 or SMETS2)."`
- Returns: `{ elecRecords, gasRecords }`

**Step 5: Gas unit sanity check — `buildGasUnitCheck()` in `js/data-ingestion.js`**

```
function buildGasUnitCheck(gasRecords, gasRatePKwh)
```

- Compute average daily gas consumption for a summer month (Jul or Aug) and a winter month (Jan or Dec).
- Calculate estimated daily cost at the given gas rate.
- Return: `{ summerDailyCostP, winterDailyCostP, summerMonth, winterMonth }`
- UI displays values and asks: "Your estimated daily gas cost: summer £X.XX, winter £Y.YY — does this look right?"
- Provides a toggle: "My meter reads in cubic metres (m³)".

```
function convertM3ToKwh(records)
```
- Multiplies consumption by `CONFIG.GAS_M3_TO_KWH` (11.19). Returns new array.

**Step 6: Tariff rate extraction — `buildTariffTimeline()` in `js/data-ingestion.js`**

```
async function buildTariffTimeline(agreements, fuelType, paymentMethod)
```

Returns a chronological array of rate windows in the design doc's `tariff_rates` format covering the full agreement history.

**Unified retrieval — works for every Octopus tariff type.** The `/standard-unit-rates/` and `/standing-charges/` endpoints return time-indexed rate arrays. Tariff type affects only record density:

| Tariff  | Records per fuel per year     |
|---------|-------------------------------|
| Fixed   | 1                             |
| SVT     | ~4 (quarterly cap changes)    |
| Tracker | ~365 (daily)                  |
| Agile   | ~17,520 (half-hourly)         |

No tariff-type branching is required in the retrieval logic.

**Retrieval flow:**

1. For each agreement:
   a. Derive `product_code` from `tariff_code` by stripping the `E-1R-` / `G-1R-` prefix and the trailing `-[A-P]` region letter. Example: `E-1R-VAR-22-11-01-A` → `VAR-22-11-01`.
   b. Fetch unit rates:
      ```
      GET /v1/products/{product_code}/{fuelType}-tariffs/{tariff_code}/standard-unit-rates/
          ?period_from={agreement.valid_from}
          &period_to={agreement.valid_to ?? now}
          &page_size=1500
      ```
   c. Fetch standing charges from the equivalent `/standing-charges/` endpoint with the same parameters.
   d. Handle `next` pagination.
   e. Filter to records matching `paymentMethod`.

2. Each returned unit-rate record becomes one `tariff_rates` entry. Pair each unit rate with the standing-charge window whose `valid_from`/`valid_to` most overlaps it.

3. Sort chronologically by `valid_from`. Log any gaps between windows to console.

4. Classify `tariff_type` from the product code prefix (informational only):

   | Prefix       | tariff_type |
   |--------------|-------------|
   | `VAR-`       | `svt`       |
   | `FIX-`       | `fixed`     |
   | `AGILE-`     | `agile`     |
   | `TRACKER-`   | `tracker`   |
   | `GO-`        | `go`        |
   | `COSY-`      | `cosy`      |
   | (otherwise)  | `other` (log product_code to console) |

**Payment method detection:** the account endpoint's agreement object does not always expose payment method explicitly. Strategy:
- Default to `DIRECT_DEBIT`.
- If filtered result is empty, retry with `NON_DIRECT_DEBIT`.
- If both empty, fail with `"Could not retrieve tariff rates for this agreement. This may be a tariff type the tool does not yet support."` and log the raw response.

**Output shape** (matching design doc, with `product_code` added for debugging):
```
[
  { valid_from, valid_to, rate_p_kwh, standing_p_day, tariff_type, product_code },
  ...
]
```

**Performance note:** Agile users generate ~17,520 rate records per fuel per year, requiring ~12 paginated requests per fuel. First-load time for Agile dual-fuel households may reach 10–15s. Step 8 must show a progress indicator during tariff retrieval.

**Step 7: Normalisation — `normaliseConsumption()` in `js/data-ingestion.js`**

```
function normaliseConsumption(elecRecords, gasRecords, dataStart, dataEnd)
```

- Generate expected HH timestamps from `dataStart` to `dataEnd` (every 30 minutes, UTC).
- Build a `Map` keyed by ISO timestamp string for both fuels.
- For each expected timestamp, look up values. Missing → `null`.
- Count gaps and compute `gap_percentage`.
- Returns: `{ consumption, metadata }` matching the design doc output format.

**Step 8: Orchestration and shared state — `js/app.js` and `js/data-ingestion.js`**

**Shared state contract** (in `js/data-ingestion.js`, exported):

```javascript
let _ingestionResult = null;
export function setIngestionResult(result) { _ingestionResult = result; }
export function getIngestionResult() { return _ingestionResult; }
```

Downstream modules import `getIngestionResult`. Result shape is the design doc's three-part output (`consumption`, `tariff_rates`, `metadata`). No globals. Loading is via `<script type="module">` in `index.html`.

**Wire the UI** (in `js/app.js`):

- `initApp()` — called on `DOMContentLoaded`. Sets up event listeners.
- Tab switching between Octopus and CSV.
- "Fetch Data" button handler:
  1. Validate inputs (API key non-empty, account number matches `A-` pattern).
  2. Show progress indicator with status: "Contacting Octopus…".
  3. Call `fetchAccount()`. If returned array has >1 property, render radio-button selection UI listing each property's address and postcode; await user choice. If one property, auto-select.
  4. Update status: "Fetching consumption data…"; call `fetchConsumption()`.
  5. Call `buildGasUnitCheck()` → show sanity check UI.
  6. On user confirmation (or toggle), call `convertM3ToKwh()` if needed.
  7. Update status: "Fetching tariff rates…"; call `buildTariffTimeline()` for both fuels. For Agile users this may take 10–15s — keep progress indicator visible and show pagination progress (e.g. "page 3 of 12") where possible.
  8. Call `normaliseConsumption()`.
  9. Apply data-quality gate against the normalised metadata:
     - `total_days < 30` → block: "At least 30 days of data needed for a meaningful analysis." Do not call `setIngestionResult()`. Stop here.
     - `total_days < 90` → warning: "Less than 3 months of data. Seasonal analysis will be limited." Continue.
     - `gap_percentage > 10` → warning: "Your data has significant gaps (X%). Results may be less accurate." Continue.
  10. Call `setIngestionResult({ consumption, tariff_rates, metadata })`.
  11. Show success summary: date range, record count, gap count, tariff types detected, any warnings.
- Error display: catch errors from each step, show user-facing message.

### Phase 2 — CSV path + meter replacement stitching

**Step 9: CSV form UI — additions to `index.html`**

Replace the CSV tab placeholder with:
- File upload input (`<input type="file" accept=".csv">`)
- Form fields:
  - Postcode (text, `placeholder="CV35 0AA"` — **not** a default value; field starts empty)
  - Gas rate p/kWh (number, default 5.7)
  - Electricity rate p/kWh (number, default 24.5)
  - Gas standing charge p/day (number, default 31.4)
  - Electricity standing charge p/day (number, default 61.6)
- "Analyse" button
- Default postcode note (shown when postcode field is empty after submission): "Using central England weather data. For best accuracy, enter your postcode — it's only used to look up local temperature and isn't stored or transmitted."

**Step 10: CSV parsing and validation — `parseCSV()` in `js/data-ingestion.js`**

```
function parseCSV(fileContent)
```

- Split by newlines, trim whitespace.
- Validate header row: `datetime, gas_kwh, electricity_kwh` (case-insensitive, whitespace-tolerant).
- For each data row:
  - Split by comma (3 fields expected).
  - Parse timestamp:
    - If timestamp includes `Z` or an explicit offset, honour it.
    - Otherwise, assume Europe/London. Convert to UTC using `Intl.DateTimeFormat` with `timeZone: 'Europe/London'`.
    - **Clock change handling:**
      - **Autumn ambiguity** (e.g. `2025-10-26 01:30` occurs twice): if two rows resolve to the same UTC timestamp after conversion, reject both with a specific error naming the row numbers. Do not silently deduplicate.
      - **Spring gap** (e.g. `2025-03-30 01:30` does not exist): reject with "Timestamp at row X falls in the spring clock-forward gap and is invalid."
  - Validate timestamp is at 00 or 30 minutes past the hour.
  - Parse `gas_kwh` and `electricity_kwh` as floats. Reject negative values with row number.
- Validate minimum 30 days of data present.
- Returns: `{ records, errors }`

Error messages:
- Wrong headers → "CSV format doesn't match the template. Expected columns: datetime, gas_kwh, electricity_kwh."
- Negative values → "Negative consumption value at row X. Check your data — consumption should be ≥ 0."
- Non-HH intervals → "Timestamps must be at half-hour intervals (e.g. 09:00, 09:30, 10:00)."
- Autumn duplicate → "Rows X and Y resolve to the same UTC timestamp (autumn clock change). Please resolve the ambiguity in your CSV."

**Step 11: Postcode validation — `validatePostcode()` in `js/data-ingestion.js`**

```
async function validatePostcode(postcode)
```

- `GET https://api.postcodes.io/postcodes/{postcode}`
- 200 → `{ valid: true, lat, lon }`
- 404 → `{ valid: false, error: "Postcode not recognised. Check the format (e.g. SW1A 1AA) and try again." }`

**`postcode_source` detection — state-based, not value-based:**

In `app.js`, attach an input listener:
```javascript
postcodeField.addEventListener('input', () => {
  postcodeField.dataset.touched = 'true';
}, { once: true });
```

On submission:
- `postcodeField.value` empty → use `CONFIG.DEFAULT_POSTCODE`, `metadata.postcode_source = 'default'`, show default note.
- `dataset.touched === 'true'` and value non-empty → validate. On success, `metadata.postcode_source = 'user'`.
- Invalid → show error, do not proceed.

Do not compare the field value against `CONFIG.DEFAULT_POSTCODE` — a user who explicitly types `CV35 0AA` is still recorded as `'user'`.

**Step 12: CSV orchestration — additions to `js/app.js`**

"Analyse" button handler:
1. Read file via `FileReader`.
2. `parseCSV()` — if errors, display and stop.
3. Determine postcode per Step 11; validate if user-entered.
4. Build single-entry `tariff_rates` arrays from form field values, spanning full data range.
5. `normaliseConsumption()`.
6. Apply data-quality gate (same as Step 8.9).
7. `setIngestionResult(...)`.
8. Show success summary.

**Step 13: Meter replacement stitching**

- If `fetchAccount()` returns >1 meter for either fuel, fetch consumption from each meter for its own active period and concatenate chronologically.
- Flag in `metadata.meters_stitched = true`; record serial numbers used.
- Phase 1 fallback (most recent meter only) is the default if this logic is not wired — Step 3 console log identifies accounts that would benefit.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Octopus API response structure varies by account type | Parse defensively. Log unexpected structures. Test with Rhiannon's real account first. |
| Agile users generate ~17,520 rate records per fuel per year | Paginate `/standard-unit-rates/` with `page_size=1500` (~12 requests per fuel). First-load may reach 10–15s. Show progress indicator and pagination status. |
| Gas unit detection relies on user judgement | Design doc specifies this approach. 11× difference is obvious. Clear guidance text. |
| CSV timezone edge cases at clock change | Autumn duplicates and spring non-existent timestamps rejected with specific row errors (Step 10). Test cases cover both transitions. |
| Large data sets (18+ months, paginated) could slow UI | Progress indicator during fetch. Pages ~1s each. |
| Unknown tariff type (new Octopus product) | Classified as `other`; rates still retrieved correctly. Product code logged for future classifier extension. |

---

## Success criteria

### Phase 1 (Octopus API path)

- [ ] Octopus happy path: valid credentials → retrieves 12 months both fuels, plausible sanity-check costs, correct HH normalisation
- [ ] Gas unit detection: SMETS2 m³ data shows implausibly low costs; m³ toggle brings to expected range
- [ ] Tariff rate timeline: SVT with cap changes → multiple entries; Tracker/Agile → full daily/HH arrays paginated correctly; `tariff_type` classified correctly
- [ ] Multiple properties: 2+ properties → selection UI; single → auto-select
- [ ] Data-quality gate: <30 days blocks (no state set); <90 days warns; >10% gap warns
- [ ] Error handling: 401 / 404 / no smart meter / unsupported payment method messages; no silent failures
- [ ] Variable data length: 4-month → 90-day warning; 18-month → paginated and stitched
- [ ] Shared state: `getIngestionResult()` null before fetch; full object after
- [ ] Responsive: usable at 375px, 768px, 1280px
- [ ] Security: no keys committed; no localStorage of keys or consumption data

### Phase 2 (CSV path + meter stitching)

- [ ] CSV happy path: valid CSV + form fields → parsed, validated, normalised; `tariff_rates` built from form values
- [ ] CSV validation: malformed CSV → specific actionable row-level error
- [ ] CSV clock change: autumn duplicates rejected with row numbers; spring gap rejected with row number
- [ ] Postcode handling: empty → default + note; user-typed (even identical to default) → `'user'`, no note; invalid → error
- [ ] Meter replacement stitching: two gas meters across adjacent periods → both fetched and concatenated; `meters_stitched = true`

---

## Design Review

**Reviewer:** Claude (Praxis Insight — claude.ai review session)
**Date:** 2026-04-16
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `projects/tools/heatpump-analyser/design/data-ingestion.md` (in `praxis-claude-hub`)

### Context

First plan for the Heat Pump Analyser. Reviewed against the data-ingestion design doc. All findings discussed conversationally; dispositions agreed before amending the plan. No rejection — structure, data flow, and module boundaries matched the design. Issues were spec gaps, one phase-split inconsistency, and one scope decision informed by a misreading of the Octopus API.

### Required changes for implementation

**1. Tariff rate retrieval endpoint underspecified**

Step 6 said rates were "embedded in the agreement or retrievable from a product endpoint" without specifying how. Unit rates are not in the account endpoint's agreements — they require calls to `/v1/products/{product_code}/electricity-tariffs/{tariff_code}/standard-unit-rates/` (and equivalent for gas, and `/standing-charges/`). The product_code derivation rule, pagination, payment_method filtering, and rate/standing-charge alignment all needed specifying.

**2. Tariff type classification pattern not defined**

"Determine tariff type from code pattern: SVT, Tracker, or fixed" — no pattern given. Claude Code would have invented its own.

**3. Tracker daily rates — supposed "simplification" was a misreading of the API**

The plan deferred Tracker daily rates to V2 with a flat-rate approximation, claiming per-day API calls. Verification against the Octopus REST docs confirmed `/standard-unit-rates/` returns time-indexed arrays for every tariff type in a single paginated call. Same endpoint, same parser — Tracker and Agile are just SVT with more rows.

**4. Phase 1 / Phase 2 split contradicted success criteria**

Multiple-properties UI, data-quality warnings, and meter stitching were deferred to Phase 2, but listed as Phase 1 success criteria. Step 8 also assumed multiple-properties handling was available.

**5. Shared state contract not specified**

"Store result in a module-level variable" with no variable name, shape, or access contract.

**6. `postcode_source` detection was value-based, not state-based**

"'user' if changed from default" fails if a user types the default value explicitly.

**7. Clock-change CSV timestamp handling not specified**

Autumn duplicate hour and spring skipped hour — risk noted, no resolution.

**8. "12 months ago" ambiguous**

Could mean 365 days, same date last year, or start-of-month last year.

### Resolution of review changes

1. **Tariff rate retrieval** — Step 6 rewritten with full flow: product_code derivation, endpoints, pagination, payment_method detection, rate/standing-charge alignment.
2. **Tariff type classification** — explicit prefix table in Step 6.
3. **Tracker daily rates** — unified approach handles all tariffs identically. `scope.md` updated. Agile first-load (~10–15s) added to Risks and Step 8 progress requirements.
4. **Phase 1 / Phase 2 split** — multiple-properties UI in Step 8; data-quality gate in Step 8.9 with explicit `<30 days` block; meter stitching remains in Phase 2 (Step 13) with Phase 1 fallback documented in Step 3. Success criteria labelled by phase.
5. **Shared state contract** — `getIngestionResult()` / `setIngestionResult()` accessor pair specified in Step 8.
6. **`postcode_source`** — switched to `dataset.touched`; postcode field uses `placeholder`, not `value`.
7. **Clock-change CSV** — autumn duplicates and spring non-existent timestamps rejected with row errors in Step 10.
8. **"12 months ago"** — explicit `LOOKBACK_MS` constant, floored to midnight UTC.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 1     | ✅ resolved |
| HIGH     | 3     | ✅ resolved |
| MEDIUM   | 3     | ✅ resolved |
| LOW      | 1     | ✅ resolved |

Verdict: APPROVED WITH EDITS — all eight findings resolved inline; ready for implementation.

---

## Approval

**Status:** ✅ Approved with edits — 2026-04-16
**Approved by:** Rhiannon (via claude.ai review)
**Clarifications confirmed:** Unified tariff retrieval works for any Octopus tariff; Phase 1 includes multiple-properties UI and data-quality gate; Phase 2 reduced to CSV path plus meter stitching; shared state via accessor functions.

---

## Implementation Deviations

**Date:**
**Commit:**

[If no deviations: "None."]
