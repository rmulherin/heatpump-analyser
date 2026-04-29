# patch-agile-region-calibration — M1 GSP region + M2 Agile calibration

**Date:** 2026-04-29
**Status:** ✅ Approved — 2026-04-29
**Design doc:** `design/patch-agile-region-calibration.md`
**Implements:** sequence 3 of 6 (after ui-fixes-1, ui-fixes-2; before m8-patch)

---

## Task description

Two upstream data-pipeline additions required by the M8 Agile tariff upgrade. M1
(`js/data-ingestion.js`) gains GSP region code extraction from the user's Octopus
tariff code (with a dropdown fallback for CSV users). M2 (`js/external-data.js`) gains
a new Agile calibration step that fetches recent post-reform Agile rates from the
Octopus public API and computes `D` (regional multiplier) and `P` (peak uplift) via
median regression. These are consumed by `m8-patch` section F3 to replace the current
flat `hh_overhead` model.

---

## Research findings

**M1 tariff extraction:** `data-ingestion.js` parses electricity agreements at line 109
(`elecAgreements = elecPoint.agreements || []`). `buildTariffTimeline` (line 274)
processes `agreement.tariff_code` per agreement. The ingestion result is assembled and
stored with `setIngestionResult` in `app.js`. The `gsp_region` must be extracted from
the most recent electricity agreement's `tariff_code` and added to the ingestion result
object. The extraction is a single-line slice: `tariff_code.slice(-1).toUpperCase()`,
validated against the 14 valid region codes.

**Where to add to ingestion result:** The ingestion result assembled in `app.js` will
include `gsp_region`. At implementation time, identify the exact location where the
ingestion result object is constructed and stored (around where `setIngestionResult`
is called) and add `gsp_region` to that object. The CSV path reads `gsp_region` from
the new `<select>` element at the point the CSV pipeline stores its ingestion result.

**M2 pipeline:** `external-data.js` has steps: 2 (postcode), 3 (weather), 4 (weather
fallback), 5 (HH lookup), 6 (Elexon MID fetch at line 209), 6a (SP→UTC conversion),
8 (alignment), 9 (metadata). The new Agile calibration step slots in after Step 8
(alignment) and before Step 9 (metadata assembly) in execution order. It is a new
exported function `fetchAgileCalibration(gsp_region)` called from `runExternalData`
in `app.js`.

**Elexon reuse:** `fetchWholesalePrices` (external-data.js:209) takes `dataStart`,
`dataEnd`, `onProgress`. The calibration window Elexon call reuses this function with
the calibration window dates. The overlap with the main historical fetch is acceptable
(independent result set).

**Octopus public API CORS:** Confirmed accessible from browser (design doc). URL
pattern: `https://api.octopus.energy/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-{region}/standard-unit-rates/`. No auth required.

**Pagination:** Octopus API returns `next` field when more pages exist — paginate with
while loop. Same pattern as `buildTariffTimeline` already in the codebase.

**Median function:** Sort a copy of samples array numerically; return
`arr[Math.floor(arr.length / 2)]` for odd length, average of two middle for even.
A helper function in `external-data.js` — no library needed.

**Peak window:** UK local time ≥ 16:00 and < 19:00. Use IANA `Europe/London` via
`Intl.DateTimeFormat` — already used in `convertSpToUtc` (external-data.js:298).

**Where `agile_calibration` goes in the external result:** `buildExternalMetadata`
(external-data.js:357) returns the metadata object. Add `agile_calibration` to this
return. In `app.js`, `runExternalData` calls `buildExternalMetadata` and stores the
result; `agile_calibration` will be available to downstream modules via `getExternalResult()`.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/data-ingestion.js` | Extract `gsp_region` from tariff_code in Tier 1 and Tier 2 paths |
| MODIFY | `js/external-data.js` | New `fetchAgileCalibration` function; `agile_calibration` in metadata |
| MODIFY | `js/app.js` | Pass `gsp_region` through; call `fetchAgileCalibration` in `runExternalData`; CSV path reads region select |
| MODIFY | `index.html` | Region `<select>` in CSV card; read-only region display in Octopus card |

---

## Implementation steps

### Step 1 — M1: Extract GSP region from tariff_code (data-ingestion.js)

Add a helper constant near the top of `data-ingestion.js`:
```js
const VALID_GSP_REGIONS = ['A','B','C','D','E','F','G','H','J','K','L','M','N','P'];
```

In the function that processes electricity agreements (where `elecAgreements` is built),
after identifying the most recent agreement's `tariff_code`, add:
```js
const lastChar   = (tariffCode ?? '').slice(-1).toUpperCase();
const gsp_region = VALID_GSP_REGIONS.includes(lastChar) ? lastChar : null;
```

Include `gsp_region` in whatever ingestion result structure is built. If `tariff_code`
is not available (CSV path), `gsp_region` comes from the UI select (Step 3).

### Step 2 — M1: Add `gsp_region` to ingestion result in app.js

At the location in `app.js` where the ingestion result is assembled and stored via
`setIngestionResult`, add `gsp_region` to the result object. For the Octopus path,
this comes from the extraction above. For the CSV path, read it from
`document.getElementById('gsp-region').value || null`.

### Step 3 — M1 CSV path: Region selector in index.html

In the CSV data entry card, after the postcode field, insert:
```html
<div class="field-group">
  <label for="gsp-region">Your electricity region</label>
  <select id="gsp-region" name="gsp-region">
    <option value="">— select your region —</option>
    <option value="A">Eastern England</option>
    <option value="B">East Midlands</option>
    <option value="C">London</option>
    <option value="D">North Wales &amp; Merseyside</option>
    <option value="E">West Midlands</option>
    <option value="F">North East England</option>
    <option value="G">North West England</option>
    <option value="H">Southern England</option>
    <option value="J">South East England</option>
    <option value="K">South West England</option>
    <option value="L">South Wales</option>
    <option value="M">Yorkshire</option>
    <option value="N">South Scotland</option>
    <option value="P">North Scotland</option>
  </select>
  <p class="field-hint">Used to fetch half-hourly electricity prices for your area.
    If unsure, check your electricity bill or
    <a href="https://www.energyguide.org.uk/whereismyelectricitysupplied/"
       target="_blank" rel="noopener">look up your region</a>.</p>
</div>
```

### Step 4 — M1 Octopus path: Read-only region display in index.html

In the Octopus tab's data display area, after region is determined from tariff, show:
```html
<p class="field-readonly">
  Region: <strong id="gsp-region-display"></strong> (from your Octopus account)
</p>
```

In `app.js`, after `gsp_region` is set from the Octopus path, populate this element:
```js
const GSP_NAMES = {
  A: 'Eastern England',   B: 'East Midlands',    C: 'London',
  D: 'North Wales & Merseyside', E: 'West Midlands', F: 'North East England',
  G: 'North West England', H: 'Southern England', J: 'South East England',
  K: 'South West England', L: 'South Wales',      M: 'Yorkshire',
  N: 'South Scotland',    P: 'North Scotland',
};
const displayEl = document.getElementById('gsp-region-display');
if (displayEl) displayEl.textContent = GSP_NAMES[gsp_region] ?? gsp_region ?? 'Unknown';
```

### Step 5 — M2: Add `fetchAgileCalibration` to external-data.js

Add constants near top of `external-data.js`:
```js
const AGILE_REFORM_DATE  = new Date('2026-04-01T00:00:00Z');
const AGILE_PRODUCT_CODE = 'AGILE-24-10-01';
```

Add a `median(arr)` helper:
```js
function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
```

Add `isUkPeakHour(ts)` helper using IANA `Europe/London`:
```js
function isUkPeakHour(ts) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: 'numeric', hour12: false
  });
  const hour = parseInt(fmt.format(ts), 10);
  return hour >= 16 && hour < 19;
}
```

Add exported function `fetchAgileCalibration(gsp_region)`:

```js
export async function fetchAgileCalibration(gsp_region) {
  if (!gsp_region) return null;

  // Calibration window
  const now            = new Date();
  const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const calibStart     = prevMonthStart >= AGILE_REFORM_DATE ? prevMonthStart : AGILE_REFORM_DATE;
  const calibEnd       = prevMonthStart >= AGILE_REFORM_DATE ? thisMonthStart : now;
  const isPartial      = prevMonthStart < AGILE_REFORM_DATE;

  try {
    // Fetch Agile rates (paginated)
    const tariffPath = `E-1R-${AGILE_PRODUCT_CODE}-${gsp_region}`;
    let url = `https://api.octopus.energy/v1/products/${AGILE_PRODUCT_CODE}`
            + `/electricity-tariffs/${tariffPath}/standard-unit-rates/`
            + `?period_from=${calibStart.toISOString()}&period_to=${calibEnd.toISOString()}&page_size=1500`;
    const agileRates = [];
    while (url) {
      const res  = await fetchWithRetry(url, 'Agile rates');
      const data = await res.json();
      agileRates.push(...(data.results ?? []));
      url = data.next ?? null;
    }
    if (agileRates.length === 0) return null;

    // Build Agile rate lookup: ISO timestamp → value_inc_vat (p/kWh)
    const agileMap = new Map();
    for (const r of agileRates) {
      agileMap.set(new Date(r.valid_from).toISOString(), r.value_inc_vat);
    }

    // Fetch Elexon wholesale for same calibration window
    const { priceLookup } = await fetchWholesalePrices(
      calibStart.toISOString(), calibEnd.toISOString(), () => {}
    );

    // Build aligned samples
    const D_samples = [];
    const P_samples = [];
    for (const [ts, wholesale] of priceLookup) {
      if (wholesale === null || wholesale <= 1.0) continue;
      const tsDate   = new Date(ts);
      const agileVal = agileMap.get(tsDate.toISOString());
      if (agileVal === undefined || agileVal === null) continue;
      if (isUkPeakHour(tsDate)) {
        // Will be used for P after D is computed — collect raw values
        P_samples.push({ agile: agileVal, wholesale });
      } else {
        D_samples.push(agileVal / wholesale);
      }
    }
    if (D_samples.length === 0) return null;

    const D = median(D_samples);
    // Now compute P_samples using D
    const P_computed = P_samples.map(s => s.agile - D * s.wholesale);
    const P = P_computed.length > 0 ? median(P_computed) : 0;

    if (D < 1.5 || D > 3.0) console.warn(`Agile calibration D=${D.toFixed(3)} outside expected range 1.5–3.0`);
    if (P < 5 || P > 20)    console.warn(`Agile calibration P=${P.toFixed(2)} outside expected range 5–20 p/kWh`);

    const monthNames = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
    const calibPeriod = isPartial
      ? `${monthNames[calibStart.getUTCMonth()]} ${calibStart.getUTCFullYear()} (partial)`
      : `${monthNames[calibStart.getUTCMonth()]} ${calibStart.getUTCFullYear()}`;

    return { D, P_peak_p_kwh: P, calibration_period: calibPeriod, gsp_region };

  } catch (err) {
    console.error('Agile calibration fetch failed:', err);
    return null;
  }
}
```

### Step 6 — M2: Add `agile_calibration` to `buildExternalMetadata` return

In `buildExternalMetadata` (external-data.js:357), add `agile_calibration` as a
parameter and include it in the return object:
```js
export function buildExternalMetadata(latitude, longitude, elevation,
    weatherSource, priceSource, priceWarnings, agile_calibration) {
  return {
    // ...existing fields...
    agile_calibration,
  };
}
```

### Step 7 — app.js: Wire into `runExternalData`

In `runExternalData` in `app.js`, after the alignment step and before calling
`buildExternalMetadata`, add:
```js
const ingestion = getIngestionResult();
const agileCalibration = await fetchAgileCalibration(ingestion?.gsp_region ?? null);
```

Pass `agileCalibration` to `buildExternalMetadata`.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `fetchWholesalePrices` in calibration call may overlap with main historical fetch; double network traffic | Design doc explicitly allows this; calibration result is kept independent |
| Agile API CORS — only confirmed for Octopus endpoints used in M1; Agile public product endpoint not separately tested | Error is caught and returns `null`; test criteria item 9 covers this explicitly; M8 falls back to flat SVT on null |
| `priceLookup` from `fetchWholesalePrices` uses UTC timestamps; `agileMap` keyed on ISO strings from `valid_from` — alignment may have minor offset if Octopus uses different timestamp precision | At implementation time, verify timestamp format alignment; may need to normalise both to 30-minute UTC boundary |
| April 2026 partial-month edge case: `prevMonthStart < AGILE_REFORM_DATE` means calibStart = `AGILE_REFORM_DATE` and calibEnd = `now`; if tool is run on 2026-04-01, calibration window is zero-length | If `calibEnd <= calibStart` after reform date logic, return null |
| `gsp_region` location in ingestion result — at implementation time the exact assembly point must be confirmed | `setIngestionResult` call in app.js is the single canonical location; search for it at implementation time |

---

## Success criteria

- [ ] Octopus path: `ingestionResult.gsp_region` is a single letter (A–P, not I or O)
- [ ] Octopus path: Data Input card shows read-only region name; no dropdown shown
- [ ] CSV path: Region `<select>` appears; selecting "London" produces `gsp_region = 'C'` in ingestion result
- [ ] CSV path with no region selected: `agile_calibration = null`, no crash, no console error from calibration
- [ ] `agile_calibration.D` is in range 2.0–2.4 on real data
- [ ] `agile_calibration.P_peak_p_kwh` is in range 8–16 on real data
- [ ] `calibration_period` reflects the most recent completed post-reform month
- [ ] Tool run during April 2026: `calibration_period` ends with "(partial)"
- [ ] Agile API unreachable (corrupt URL): `agile_calibration = null`, no crash, console error logged
- [ ] No new console errors on the normal (successful) path

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-29
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `design/patch-agile-region-calibration.md` (praxis-claude-hub commit `1f40cba`)

### Context

Plan reviewed against `design/patch-agile-region-calibration.md` (committed
2026-04-29 in praxis-claude-hub, `1f40cba`). The plan implements the M1 + M2
upstream additions required by `m8-patch-gas-connection-retained` section F3
(Agile D×W+P rate model). No CRITICAL, HIGH, or MEDIUM findings.

### Required changes for implementation

None — implementation steps are unchanged.

### Substantive checks performed

- **Algorithm correctness (B1–B6).** Calibration window logic, paginated
  Agile fetch, D/P median computation, and error handling all match the
  design line-for-line. The "compute D first, then derive P from previously
  collected raw `(agile, wholesale)` peak samples" sequencing is correct
  (P's formula depends on D).
- **VAT handling.** `D = agile_rate_inc_vat / wholesale_exc_vat` correctly
  absorbs the VAT factor; later `D × wholesale_exc_vat` produces inc_vat
  consumer-facing rates directly.
- **Off-peak / peak partition.** `wholesale > 1.0`, agile non-null, and the
  UK local time `isUkPeakHour` check are implemented correctly. Off-peak
  goes to `D_samples`; peak goes to `P_samples` for later derivation.
- **`fetchWithRetry` verified to exist** at `external-data.js:41` (used 4×
  elsewhere). Plan's call pattern is consistent with the existing code.
- **`buildExternalMetadata` has a single caller** at `app.js:845` — adding
  the `agile_calibration` parameter is a single-call-site change with no
  hidden breakage risk.
- **Timestamp alignment between `priceLookup` and `agileMap`.** Both keys
  are normalised via `new Date(x).toISOString()`. Risk row 3 acknowledges
  the alignment concern; Sonnet to verify at implementation time.
- **Defensive empty-array paths** present: `agileRates.length === 0 → null`,
  `D_samples.length === 0 → null`, `P_computed.length === 0 → P = 0`.
- **April 2026 partial-month edge case** acknowledged in Risk row 4. Empty
  Agile records array provides indirect safety at degenerate zero-length
  windows.

### Plan-internal cleanup applied at amend time

**1. Section heading renamed (LOW).** `## Claude.ai Review` → `## Design Review`
per the heatpump CLAUDE.md substitution table.

**2. Status field updated (LOW).** `Awaiting approval` → `✅ Approved — 2026-04-29`.

### Note for future plans (not applied)

Same as ui-fixes-2: research findings reference specific line numbers
(e.g. `data-ingestion.js:109`, `external-data.js:209/298/357`). Acceptable
here because implementation is imminent and most line refs are paired
with surrounding function names. Worth discouraging in future plans per
the heatpump architect brief.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | — |
| HIGH     | 0     | — |
| MEDIUM   | 0     | — |
| LOW      | 3     | 1 + 2 ✅ resolved; 3 noted for future |

Verdict: ✅ APPROVED — implementation steps unchanged; template hygiene applied.

---

## Approval

**Status:** ✅ Approved — 2026-04-29
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** None substantive — implementation matches design as written. M8-patch (sequence 3) consumes `gsp_region` from M1's ingestion result and `agile_calibration` from M2's external metadata.

---

## Implementation Deviations

D1: Step 4 specified `<p class="field-readonly" id="gsp-region-readonly">` directly. Implementation wraps this in a `hidden` class and reveals it only when `prop.gsp_region` is non-null, preventing "Region:  (from your Octopus account)" showing when region detection fails.
