# Module 1 — Data Ingestion

**Date:** 2026-04-16
**Status:** Awaiting approval — review via claude.ai before implementation begins.

---

## Task description

Build the data ingestion module: the entry point for the entire Heat Pump Analyser
pipeline. Two input paths (Octopus Energy API and CSV upload) feed into a shared
normalisation layer that produces a unified half-hourly consumption array, tariff rate
timeline, and property metadata object. All downstream modules consume this output.

This is the first module to be implemented. No existing code exists beyond the repo
scaffolding (index.html, css/, js/ directories are not yet created).

---

## Research findings

No external libraries required beyond what the browser provides natively:

- **Octopus Energy API** — RESTful, Basic Auth, CORS confirmed for client-side JS.
  `page_size=25000` retrieves a full year per fuel type in one request. Pagination via
  `next` URL handles longer histories. Account endpoint returns MPAN/MPRN, meter serials,
  postcode, and tariff agreements in a single call.

- **Postcodes.io** — Free, no auth, CORS confirmed. `GET /postcodes/{postcode}` returns
  lat/lon. Used in CSV path for postcode validation (and later by external-data module
  for weather lookup).

- **CSV parsing** — Format is simple (3 columns, comma-separated). Manual `split(',')`
  parsing is appropriate; no library needed. The design doc explicitly permits this.

- **Date handling** — All internal timestamps are ISO 8601 UTC. Browser `Date` object
  handles UTC adequately. For Europe/London timezone detection on CSV timestamps without
  explicit timezone, we need to determine BST/GMT status for each timestamp. This can be
  done with `Intl.DateTimeFormat` — no library required.

- **Fetch API** — Native browser `fetch()` with Basic Auth header for Octopus calls.
  No Axios or similar needed.

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

This phase delivers a working tool that accepts Octopus credentials and produces
normalised output. It establishes the HTML/CSS/JS scaffolding that all subsequent
modules build on.

**Step 1: Project scaffolding — `index.html`, `css/styles.css`**

Create the HTML page structure with:
- `<head>` with meta tags, viewport, link to `styles.css`, Chart.js CDN
- Data input section with two-tab UI (Octopus / CSV) — only Octopus tab functional
  in Phase 1
- Octopus tab: API key field (`type="password"`), account number field, "Fetch Data"
  button, status/error display area, gas unit sanity check area (initially hidden)
- CSV tab: placeholder "Coming in Phase 2"
- Progress indicator area (shown during API calls)
- Results area (placeholder sections for downstream modules: Your Home, Results, What If)

CSS with:
- Design tokens as CSS custom properties: `--colour-teal: #3B8284`,
  `--colour-coral: #FD7A7F`, `--colour-navy: #26588D`, `--colour-dark: #2A3439`
- Base typography (system font stack), body layout
- Form input styles, button styles (primary teal, secondary outline)
- Tab component styles
- Status message styles (info, warning, error)
- Responsive breakpoints: mobile 375px, tablet 768px, desktop 1280px
- Utility: `.hidden { display: none; }`

**Step 2: Constants and configuration — top of `js/data-ingestion.js`**

Define all magic numbers as named constants in one block:

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
  GAS_M3_TO_KWH: 11.19,  // 1.02264 × 39.5 / 3.6
  CONSUMPTION_PAGE_SIZE: 25000,
  DEFAULT_LOOKBACK_MONTHS: 12,
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

- `GET {BASE_URL}/accounts/{accountNumber}/` with Basic Auth header
  (`btoa(apiKey + ':')`)
- Extract from first property (or present selection if multiple):
  - `electricity_meter_points[0].mpan`
  - `electricity_meter_points[0].meters` → last element (most recent meter)
  - `gas_meter_points[0].mprn`
  - `gas_meter_points[0].meters` → last element
  - Postcode from property object
  - Tariff agreements from both meter points (stored for Step 6)
- Error handling:
  - 401 → `"API key not recognised. Check your key at octopus.energy/dashboard."`
  - 404 → `"Account not found. Check the format: A-XXXXABCD."`
  - Network error → `"Could not reach the Octopus API. Check your internet connection and try again."`
  - 429 → `"Octopus API is busy. Wait a moment and try again."`
- Returns: `{ mpan, mprn, elecSerial, gasSerial, postcode, elecAgreements, gasAgreements, properties }`

If multiple properties: return all properties with address/postcode for the UI to
present a selection. Default to first if only one.

**Step 4: Consumption retrieval — `fetchConsumption()` in `js/data-ingestion.js`**

```
async function fetchConsumption(apiKey, mpan, mprn, elecSerial, gasSerial)
```

- Calculate date range: midnight UTC 12 months ago → now. Append `Z` to both
  timestamps to force UTC interpretation.
- Two parallel fetches via `Promise.all`:
  - `GET /electricity-meter-points/{MPAN}/meters/{serial}/consumption/?period_from=...Z&period_to=...Z&page_size=25000&order_by=period`
  - `GET /gas-meter-points/{MPRN}/meters/{serial}/consumption/?period_from=...Z&period_to=...Z&page_size=25000&order_by=period`
- Pagination: if response contains `next` URL (non-null), follow it and concatenate
  results. Loop until `next` is null.
- Handle empty results array (200 OK, no data) →
  `"No half-hourly data found. This tool requires a smart meter (SMETS1 or SMETS2)."`
- Returns: `{ elecRecords: [...], gasRecords: [...] }`

**Step 5: Gas unit sanity check — `buildGasUnitCheck()` in `js/data-ingestion.js`**

```
function buildGasUnitCheck(gasRecords, gasRatePKwh)
```

- Compute average daily gas consumption for a summer month (Jul or Aug) and a winter
  month (Jan or Dec) from the data.
- Calculate estimated daily cost at the given gas rate (default Ofgem cap).
- Return: `{ summerDailyCostP, winterDailyCostP, summerMonth, winterMonth }`
- The UI (in app.js) displays these values and asks: "Your estimated daily gas cost:
  summer £X.XX, winter £Y.YY — does this look right?"
- Provides a toggle: "My meter reads in cubic metres (m³)".

Conversion function:
```
function convertM3ToKwh(records)
```
- Multiplies each consumption value by `CONFIG.GAS_M3_TO_KWH` (11.19).
- Returns new array (does not mutate input).

**Step 6: Tariff rate extraction — `buildTariffTimeline()` in `js/data-ingestion.js`**

```
function buildTariffTimeline(agreements, fuelType)
```

- Takes the tariff agreements array from the account endpoint for one fuel type.
- For each agreement: extract `tariff_code`, `valid_from`, `valid_to`.
- Determine tariff type from code pattern: SVT, Tracker, or fixed.
- For SVT/fixed: the rate is embedded in the agreement or retrievable from a
  product endpoint. Build one entry per agreement period.
- Sort chronologically by `valid_from`.
- Returns array matching the `tariff_rates` output format from the design doc:
  `[{ valid_from, valid_to, rate_p_kwh, standing_p_day, tariff_type }]`

**Note on Tracker tariffs:** Tracker tariffs have daily-varying rates. For the
initial implementation, use the agreement's standard unit rate as a representative
average. Full daily Tracker rate lookup is a refinement that can be added if needed
— it requires per-day API calls and is not essential for the cost comparison
(Tracker rates closely follow the cap over a year). Flag this as a known simplification.

**Step 7: Normalisation — `normaliseConsumption()` in `js/data-ingestion.js`**

```
function normaliseConsumption(elecRecords, gasRecords, dataStart, dataEnd)
```

- Generate the complete set of expected HH timestamps from `dataStart` to `dataEnd`
  (every 30 minutes, UTC).
- Build a `Map` keyed by ISO timestamp string for both gas and electricity records.
- For each expected timestamp, look up gas and electricity values. Missing → `null`.
- Count gaps and compute `gap_percentage`.
- Returns: `{ consumption: [...], metadata: { ... } }` matching the design doc output
  format exactly.

**Step 8: Orchestration — `js/app.js`**

Wire the UI to the data-ingestion module:

- `initApp()` — called on `DOMContentLoaded`. Sets up event listeners.
- Tab switching between Octopus and CSV.
- "Fetch Data" button handler:
  1. Validate inputs (API key non-empty, account number matches `A-` pattern)
  2. Show progress indicator
  3. Call `fetchAccount()` → if multiple properties, show selection UI, wait for choice
  4. Call `fetchConsumption()`
  5. Call `buildGasUnitCheck()` → show sanity check UI
  6. On user confirmation (or toggle), call `convertM3ToKwh()` if needed
  7. Call `buildTariffTimeline()` for both fuels
  8. Call `normaliseConsumption()`
  9. Store result in a module-level variable for downstream modules
  10. Show success summary: date range, record count, gap count, data quality warnings
- Error display: catch errors from each step, show user-facing message in the status area.

### Phase 2 — CSV path + remaining edge cases

**Step 9: CSV form UI — additions to `index.html`**

Replace the CSV tab placeholder with:
- File upload input (`<input type="file" accept=".csv">`)
- Form fields (side by side with file input):
  - Postcode (text, default "CV35 0AA")
  - Gas rate p/kWh (number, default 5.7)
  - Electricity rate p/kWh (number, default 24.5)
  - Gas standing charge p/day (number, default 31.4)
  - Electricity standing charge p/day (number, default 61.6)
- "Analyse" button
- Default postcode note (shown when postcode unchanged):
  "Using central England weather data. For best accuracy, enter your postcode — it's
  only used to look up local temperature and isn't stored or transmitted."

**Step 10: CSV parsing and validation — `parseCSV()` in `js/data-ingestion.js`**

```
function parseCSV(fileContent)
```

- Split by newlines, trim whitespace.
- Validate header row: must be `datetime, gas_kwh, electricity_kwh` (case-insensitive,
  whitespace-tolerant).
- For each data row:
  - Split by comma (3 fields expected).
  - Parse timestamp: if no timezone indicator, assume Europe/London and convert to UTC
    using `Intl.DateTimeFormat` to determine BST/GMT offset for that date.
  - Validate timestamp is at 00 or 30 minutes past the hour.
  - Parse gas_kwh and electricity_kwh as floats. Reject negative values with row number
    in error message.
- Validate minimum 30 days of data present.
- Returns: `{ records: [...], errors: [] }`

Specific error messages per the design doc:
- Wrong headers → "CSV format doesn't match the template. Expected columns: datetime,
  gas_kwh, electricity_kwh."
- Negative values → "Negative consumption value at row X. Check your data — consumption
  should be ≥ 0."
- Non-HH intervals → "Timestamps must be at half-hour intervals (e.g. 09:00, 09:30,
  10:00)."

**Step 11: Postcode validation — `validatePostcode()` in `js/data-ingestion.js`**

```
async function validatePostcode(postcode)
```

- `GET https://api.postcodes.io/postcodes/{postcode}`
- If 200: return `{ valid: true, lat, lon }`
- If 404: return `{ valid: false, error: "Postcode not recognised. Check the format (e.g. SW1A 1AA) and try again." }`
- Record `postcode_source` in metadata: `"user"` if changed from default, `"default"`
  if left as CV35 0AA.

**Step 12: CSV orchestration — additions to `js/app.js`**

"Analyse" button handler:
1. Read file content via `FileReader` API.
2. Call `parseCSV()` — if errors, display and stop.
3. Call `validatePostcode()` — if invalid, display error and stop. If default, show note.
4. Build single-entry `tariff_rates` from form field values, spanning full data range.
5. Call `normaliseConsumption()`.
6. Store result (same module-level variable as Octopus path).
7. Show success summary.

**Step 13: Edge case hardening**

- Multiple properties UI: radio button list with address + postcode for each property.
- Data quality warnings:
  - `gap_percentage > 10` → "Your data has significant gaps (X%). Results may be less
    accurate."
  - `total_days < 90` → "Less than 3 months of data. Seasonal analysis will be limited."
  - `total_days < 30` → block: "At least 30 days of data needed for a meaningful
    analysis."
- Meter replacement stitching: if two meters found with adjacent date ranges, fetch
  consumption from both and concatenate chronologically. Flag in metadata.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Octopus API response structure varies by account type (e.g. export meters, prepayment) | Parse defensively. Only extract fields we need. Log unexpected structures to console for debugging. Test with Rhiannon's real account first. |
| Tracker tariff daily rate lookup adds complexity and API calls | Phase 1 uses agreement-level average rate. Flag as known simplification. Revisit if the cost comparison is materially affected. |
| Gas unit detection relies on user judgement (sanity check) | Design doc specifies this approach. The 11× difference between m³ and kWh is obvious in the cost display. Provide clear guidance text. |
| CSV timezone handling (Europe/London BST/GMT) has edge cases at clock change boundaries | Use `Intl.DateTimeFormat` with `Europe/London` timezone to determine offset for each timestamp individually. Test with timestamps spanning a clock change. |
| Large data sets (18+ months, paginated) could cause slow UI | Show progress indicator during fetch. Pagination is sequential but each page is fast (~1s). Total reasonable worst case: 3–4 pages, <5s. |

---

## Success criteria

- [ ] Octopus happy path: valid API key + account → retrieves 12 months gas + electricity, displays plausible daily costs in sanity check, normalises to HH array with correct record count
- [ ] Gas unit detection: SMETS2 m³ data shows implausibly low costs; toggling to m³ mode brings costs into expected range
- [ ] Tariff rate timeline: SVT customer spanning cap changes → multiple tariff_rates entries with correct dates and rates
- [ ] CSV happy path: correctly formatted CSV + form fields → parsed, validated, normalised output with expected record count
- [ ] CSV validation: malformed CSV → specific actionable error message identifying the problem
- [ ] Gap handling: data with known gaps → correct gap_count, warning if >10%
- [ ] Error handling: invalid API key → 401 message; invalid account → 404 message; no smart meter → informative message; no silent failures
- [ ] Multiple properties: account with 2+ properties → selection UI, analysis proceeds with chosen property
- [ ] Default postcode: CSV user leaves postcode blank → CV35 0AA used, postcode_source is "default", note shown
- [ ] Variable data length: 4-month account → 90-day warning, proceeds; 18-month account (paginated) → follows next URL, stitches, normalises full dataset
- [ ] Data minimum: <30 days → blocks analysis with clear message
- [ ] Responsive: data input section usable at 375px, 768px, 1280px
- [ ] Security: no API keys in committed code, no localStorage of keys or consumption data, no external data exfiltration

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
