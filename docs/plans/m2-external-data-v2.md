# m2-external-data-v2 — Re-cut against self-contained v2 design

**Date:** 2026-06-03
**Status:** ⚠ Approved with edits — 2026-06-03. Implementation may begin.

---

## Task description

Re-cut the M2 External Data implementation plan against the self-contained v2 design doc
(`m2-external-data-v2.md`, committed `2ef9b20`). The 2026-06-02 m2 plan is on hold and
not reused.

The v2 design makes M2 the **single source of all operative base tariffs** (HH Agile,
flat/SVT elec, gas, standing charges), relocates M8's `prepareRates` base-rate half into
M2, adds the regional D/P table and regional standing-charge lookup, and closes the
wholesale-containment gap (`wholesale_p_kwh` removed from `external[]`). M8 retains the
entire §14 what-if layer (scale-all + rate/standing overrides); M2 builds base tariffs
only and M8 applies and manipulates them.

Two hard constraints for this plan:
1. **Do NOT implement §14.** The whole what-if layer (scale-all + rate/standing
   overrides) is M8's. M2 builds base tariffs; M8 applies them and owns §14.
2. **Regional standing-charge figures are not yet sourced.** Create
   `data/regional-standing-charges.csv` as a provisional skeleton; inline
   provisional national values as a JS constant marked `PENDING_SOURCE`; flag for
   Opus to source before v2 launch.

---

## Research findings

### Existing code reviewed

**`js/external-data.js`** — current M2:
- `alignExternalData()` currently includes `wholesale_p_kwh` in returned `external[]`
  entries. V2 mandate: remove it — wholesale is M2-internal; `external[]` is
  weather-only (§2.5.8).
- `fetchAgileCalibration()` returns `source: 'fetched'`. V2 renames this
  `'calibrated'` and adds a regional-table fallback (`'regional_table'`) and
  national-default path (`'national_default'`). No fallback paths exist today.
- `fetchAgileCalibration()` does not produce `null_wholesale_fraction`. That
  computation currently lives in app.js (~line 930): `external.map(e =>
  e.wholesale_p_kwh ?? null)`. It relocates to `buildBaseTariffs` in this plan.
- No `buildBaseTariffs()` function exists — new addition.
- `isUkPeakHour()` exists using `Intl.DateTimeFormat`; identical to m8's
  `isPeakHour()`. Will be the authoritative copy once m8's private duplicate is
  removed.
- `priceLookup` parameter is passed to `alignExternalData()` but only used to
  set `wholesale_p_kwh` — which is being removed. The parameter drops from
  `alignExternalData` and is instead passed directly to `buildBaseTariffs`.

**`js/pricing-engine.js`** — current M8:
- `prepareRates(ingestion, external, params)` builds `gas_rate_by_hh` from
  `ingestion.tariff_rates.gas` (tariff windowing), `elec_hh_rate_by_hh` from
  `external[i].wholesale_p_kwh`, and standing charges from
  `ingestion.tariff_rates`. The base-rate half of this logic relocates to M2.
- `imputeWholesaleForSlot()` — relocates from M8 to M2.
- `D_DEFAULT = 2.2` / `P_DEFAULT_PEAK_P_KWH = 12` — Agile defaults relocate to
  M2 as `D_DEFAULT_NATIONAL` / `P_DEFAULT_NATIONAL`.
- `PE_CONFIG.SVT_RATE_DEFAULT_P = 24.50` — becomes M2's `OFGEM_CAP_ELEC_BY_QUARTER`
  constant; remove from M8.
- `PE_CONFIG.ELEC_STANDING_DEFAULT_P_DAY = 61.64` / `GAS_STANDING_DEFAULT_P_DAY =
  31.66` — national standing defaults relocate to M2; remove from M8.
- `PE_CONFIG.HH_OVERHEAD_DEFAULT_P = 13.00` — already flagged "no longer used";
  remove.
- §14 overrides that **stay in M8**: `gas_rate_override_p_kwh` (prepareRates),
  `svt_rate_p_per_kwh` + `gas_standing_charge_p` + `svt_standing_charge_p`
  (computeCosts). These must continue to work.
- `electricityRateForHH()` currently uses
  `rateMetadata.ofgem_cap_elec_p_kwh ?? svtRate` for `dumb_hp_svt`. In v2 this
  becomes `rateMetadata.flat_rate_by_hh[i]` (the M2-sourced per-HH flat rate,
  with §14 SVT override already applied in prepareRates).

**`js/app.js`** — wiring (three call sites to update):
- `runExternalData()` stores `setExternalResult({ external, external_metadata })`.
  In v2, also stores `hh_rate`, `gas_rate`, `flat_rate`, `standing_charge`,
  `agile_calibration` (top-level, not inside `external_metadata`).
- `runScenarioConsumption()` (line ~1640–1643): reads
  `externalResult.external_metadata?.agile_calibration` and calls
  `prepareRates(ingestion, externalResult.external, rateParamsForM7)`.
- `runPricingEngine()` (line ~1861–1866): same pattern.
- Progress summary (line ~951) references `external.filter(e =>
  e.wholesale_p_kwh !== null)` — path changes since `wholesale_p_kwh` leaves
  `external[]`.
- Coverage display (line ~1724): `getExternalResult()?.external_metadata
  ?.agile_calibration` — path changes to `getExternalResult()?.agile_calibration`
  (top-level).

**Regional D/P data:**
- `praxis-hub/research/data/agile-regional-rates.csv` — 14-region table, fully
  populated (Octopus blog post, April 2026 update). Values inlined as a JS
  constant; the CSV is also committed to `data/` as the canonical reference.

**Regional standing-charge data:**
- Does not exist in either repo. Architect note: figures to source.
  Plan creates `data/regional-standing-charges.csv` as a skeleton with
  provisional national values (PE_CONFIG: 61.64p/day elec, 31.66p/day gas for
  all 14 regions). JS constant marked `PENDING_SOURCE`. Northern Scotland (P) is
  known to be materially higher — flag explicitly.

**Ofgem cap quarterly rate schedule:**
- Only Q2 2026 flat-elec rate (24.50p) is confirmed from
  `PE_CONFIG.SVT_RATE_DEFAULT_P`. The design specifies `OFGEM_CAP_ELEC_FLAT
  [quarter(i)]` and `OFGEM_CAP_GAS[quarter(i)]`. Gas Q1→Q2 2026 transition
  (5.90 → 5.70p) is cited in the design doc. Historical quarters back to Q1 2024
  (range of demo data) are not confirmed. Plan encodes known values and marks
  remaining quarters PROVISIONAL; `quarterKey()` warns on unconfirmed use. Does
  not affect the API path (m1 actual rates always used there).

**TC15 discrepancy in design doc §5:**
- TC15 quotes `W=−5.0, D=2.2` table-path off-peak → `−5.78`. The formula
  `min(2.2 × (−5), 95) × 1.05 = −11.55` does not reproduce −5.78. The value
  −5.78 arises from `min(1.1 × (−5), 95) × 1.05 = −5.775 ≈ −5.78` (D=1.1).
  Possible typo in the design doc. The load-bearing requirement — negative
  wholesale → negative rate, not clamped — is unambiguous and is what the
  verification test checks. Flagged for Opus to clarify.

### No new libraries needed

Luxon (existing), `Intl.DateTimeFormat` (existing), vanilla JS only. Tiny CSV files
are inlined as JS constants rather than fetched at runtime.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `data/agile-regional-rates.csv` | 14-region D/P reference (values also inlined as JS constant) |
| CREATE | `data/regional-standing-charges.csv` | Standing-charge skeleton — provisional national estimates, PENDING_SOURCE |
| CREATE | `test-m2-v2.mjs` | Node CLI verification: TC10, TC13–19 from design doc §5 |
| MODIFY | `js/external-data.js` | Add base-tariff composition; upgrade calibration; remove wholesale from external[] |
| MODIFY | `js/pricing-engine.js` | Refactor prepareRates to accept M2 tariffs; remove base-rate build loop; keep §14 |
| MODIFY | `js/app.js` | Update M2 result structure; update both prepareRates call sites; update display paths |

---

## Implementation steps

### Step 1 — Create `data/agile-regional-rates.csv`

Create `data/agile-regional-rates.csv` (copied from praxis-hub research). This is the
canonical reference file; the D/P values are also inlined in Step 3 as a JS constant
(no runtime fetch required).

```
region_code,region_name,multiplier_d,peak_adder_p_pence_per_kwh
A,Eastern England,2.10,13
B,East Midlands,2.00,14
C,London,2.00,12
D,Merseyside & Northern Wales,2.20,13
E,West Midlands,2.10,12
F,North East England,2.10,12
G,North West England,2.10,12
H,Southern England,2.10,12
J,South East England,2.20,12
K,Southern Wales,2.20,12
L,South West England,2.30,11
M,Yorkshire,2.00,13
N,Southern Scotland,2.10,13
P,Northern Scotland,2.40,12
```

### Step 2 — Create `data/regional-standing-charges.csv` skeleton

Create the file with provisional national values and a `PENDING_SOURCE` notice.

```
# PENDING_SOURCE — provisional national Ofgem-cap estimates for all regions.
# Northern Scotland (P) is known to carry higher distribution costs; current value is wrong.
# Replace all rows with genuine regional Ofgem-cap standing charges before v2 launch.
# Source: https://www.ofgem.gov.uk/information-for-household-consumers/energy-price-cap
region_code,region_name,gas_standing_p_day,elec_standing_p_day
A,Eastern England,31.66,61.64
B,East Midlands,31.66,61.64
C,London,31.66,61.64
D,Merseyside & Northern Wales,31.66,61.64
E,West Midlands,31.66,61.64
F,North East England,31.66,61.64
G,North West England,31.66,61.64
H,Southern England,31.66,61.64
J,South East England,31.66,61.64
K,Southern Wales,31.66,61.64
L,South West England,31.66,61.64
M,Yorkshire,31.66,61.64
N,Southern Scotland,31.66,61.64
P,Northern Scotland,31.66,61.64
```

### Step 3 — Add constants and helpers to `js/external-data.js`

After `EXTERNAL_CONFIG`, add:

```javascript
// ===== Ofgem price cap constants (M2-owned; relocated from PE_CONFIG) =====
// Unit rates (p/kWh, national, quarterly). Used on CSV/demo path only;
// API path uses m1's actual tariff timeline.
// TO POPULATE: source the full quarterly schedule (Q1 2024→Q4 2026+) from
// https://www.ofgem.gov.uk/check-if-energy-price-cap-affects-you before v2 launch.
// Out-of-range quarters fall back to the nearest known value.
const OFGEM_CAP_ELEC_BY_QUARTER = {
  '2025-Q1': 24.50,  // PROVISIONAL — to source
  '2025-Q2': 24.50,  // PROVISIONAL
  '2025-Q3': 24.50,  // PROVISIONAL
  '2025-Q4': 24.50,  // PROVISIONAL
  '2026-Q1': 24.50,  // PROVISIONAL (to source)
  '2026-Q2': 24.50,  // confirmed (was PE_CONFIG.SVT_RATE_DEFAULT_P)
  '2026-Q3': 24.50,  // PROVISIONAL
  '2026-Q4': 24.50,  // PROVISIONAL
};

const OFGEM_CAP_GAS_BY_QUARTER = {
  '2025-Q1': 5.90,   // PROVISIONAL
  '2025-Q2': 5.90,   // PROVISIONAL
  '2025-Q3': 5.90,   // PROVISIONAL
  '2025-Q4': 5.90,   // PROVISIONAL
  '2026-Q1': 5.90,   // design doc: "5.9→5.7 across quarters"
  '2026-Q2': 5.70,   // design doc confirmed
  '2026-Q3': 5.70,   // PROVISIONAL
  '2026-Q4': 5.70,   // PROVISIONAL
};

// 14-region Agile D/P table (VAT-exclusive; Octopus blog post, April 2026 update).
// Canonical source: data/agile-regional-rates.csv
const AGILE_REGIONAL_RATES = {
  'A': { D: 2.10, P: 13 }, 'B': { D: 2.00, P: 14 }, 'C': { D: 2.00, P: 12 },
  'D': { D: 2.20, P: 13 }, 'E': { D: 2.10, P: 12 }, 'F': { D: 2.10, P: 12 },
  'G': { D: 2.10, P: 12 }, 'H': { D: 2.10, P: 12 }, 'J': { D: 2.20, P: 12 },
  'K': { D: 2.20, P: 12 }, 'L': { D: 2.30, P: 11 }, 'M': { D: 2.00, P: 13 },
  'N': { D: 2.10, P: 13 }, 'P': { D: 2.40, P: 12 },
};

// 14-region standing charges (p/day, Ofgem-cap basis).
// PENDING_SOURCE — provisional national estimates for all regions.
// Northern Scotland (P) is materially wrong; source genuine regional values.
// Canonical source: data/regional-standing-charges.csv
const REGIONAL_STANDING_CHARGES = {
  'A': { gas: 31.66, elec: 61.64 }, 'B': { gas: 31.66, elec: 61.64 },
  'C': { gas: 31.66, elec: 61.64 }, 'D': { gas: 31.66, elec: 61.64 },
  'E': { gas: 31.66, elec: 61.64 }, 'F': { gas: 31.66, elec: 61.64 },
  'G': { gas: 31.66, elec: 61.64 }, 'H': { gas: 31.66, elec: 61.64 },
  'J': { gas: 31.66, elec: 61.64 }, 'K': { gas: 31.66, elec: 61.64 },
  'L': { gas: 31.66, elec: 61.64 }, 'M': { gas: 31.66, elec: 61.64 },
  'N': { gas: 31.66, elec: 61.64 }, 'P': { gas: 31.66, elec: 61.64 },
};

const NATIONAL_GAS_STANDING_DEFAULT  = 31.66; // p/day — fallback when region null
const NATIONAL_ELEC_STANDING_DEFAULT = 61.64;
const D_DEFAULT_NATIONAL             = 2.2;
const P_DEFAULT_NATIONAL             = 12;
const IMPUTE_MIN_WINDOW_SAMPLES      = 50;    // min non-null slots in 7-day window
```

Add after the constants:

```javascript
function quarterKey(tsDate) {
  const d = tsDate instanceof Date ? tsDate : new Date(tsDate);
  const year  = d.getUTCFullYear();
  const q     = Math.floor(d.getUTCMonth() / 3) + 1;
  const key   = `${year}-Q${q}`;
  if (OFGEM_CAP_ELEC_BY_QUARTER[key] !== undefined) return key;
  // Out-of-range: nearest key by string sort
  const keys  = Object.keys(OFGEM_CAP_ELEC_BY_QUARTER).sort();
  const before = [...keys].filter(k => k <= key).pop();
  const after  = keys.find(k => k > key);
  const fallback = before ?? after ?? keys[0];
  console.warn(`Ofgem cap: quarter ${key} not in table — using ${fallback}`);
  return fallback;
}

function getRateForTs(tsDate, sortedWindows) {
  if (!sortedWindows || sortedWindows.length === 0) return null;
  let rate = null;
  for (const w of sortedWindows) {
    if (new Date(w.valid_from) > tsDate) break;
    if (!w.valid_to || new Date(w.valid_to) > tsDate) { rate = w.rate_p_kwh; break; }
  }
  if (rate === null) {
    rate = sortedWindows.findLast(w => new Date(w.valid_from) <= tsDate)?.rate_p_kwh
        ?? sortedWindows[0]?.rate_p_kwh ?? null;
  }
  return rate;
}

function imputeWholesaleForSlot(i, wholesale_array, global_mean_known, D, ofgem_cap) {
  const window_start = Math.max(0, i - 336);
  const window_slots = wholesale_array.slice(window_start, i).filter(w => w !== null);
  if (window_slots.length >= IMPUTE_MIN_WINDOW_SAMPLES) {
    return window_slots.reduce((s, w) => s + w, 0) / window_slots.length;
  }
  if (global_mean_known !== null) return global_mean_known;
  return ofgem_cap / D;
}
```

`getRateForTs` is the forward-scan tariff-windowing logic extracted from M8's `prepareRates` gas loop.
`imputeWholesaleForSlot` is relocated from `pricing-engine.js` (identical logic).

### Step 4 — Upgrade `fetchAgileCalibration()` in `js/external-data.js`

Rewrite to implement the 3-path source hierarchy. Key changes from today:
- `source: 'fetched'` → `source: 'calibrated'`
- On live-calibration failure (any throw, or D/P outside valid range, or insufficient
  samples): fall to `AGILE_REGIONAL_RATES[gsp_region]` → `source: 'regional_table'`
- If region code not in table or `gsp_region` null: `source: 'national_default'`,
  D=2.2, P=12
- `null_wholesale_fraction` field set to `null` here; filled by `buildBaseTariffs`
  after the main wholesale array is built

Validation thresholds (unchanged from today's prepareRates): D ∈ [1.5,3.0],
P ∈ [5,20], D_sample_count ≥ 50, P_sample_count ≥ 20.

Structure of rewritten function:

```javascript
export async function fetchAgileCalibration(gsp_region) {
  // Path 3 short-circuit: no region
  if (!gsp_region) {
    return {
      D: D_DEFAULT_NATIONAL, P_peak_p_kwh: P_DEFAULT_NATIONAL,
      D_sample_count: 0, P_sample_count: 0,
      calibration_period: null, gsp_region: null,
      null_wholesale_fraction: null,
      source: 'national_default',
    };
  }

  // Path 1: live calibration — attempt
  try {
    // ... (existing calibration window + Octopus fetch + wholesale fetch + D/P derivation) ...
    // On success: all validation must pass (D_valid && P_valid && count_valid);
    // if any fails, throw to trigger regional-table fallback.
    return {
      D, P_peak_p_kwh: P,
      D_sample_count, P_sample_count,
      calibration_period: calibPeriod, gsp_region,
      null_wholesale_fraction: null,
      source: 'calibrated',          // changed from 'fetched'
    };
  } catch (err) {
    console.warn('Agile live calibration failed — using regional table:', err.message);
    // Path 2: regional table fallback
    const row = AGILE_REGIONAL_RATES[gsp_region];
    return {
      D:              row ? row.D : D_DEFAULT_NATIONAL,
      P_peak_p_kwh:  row ? row.P : P_DEFAULT_NATIONAL,
      D_sample_count: 0, P_sample_count: 0,
      calibration_period: null, gsp_region,
      null_wholesale_fraction: null,
      source: row ? 'regional_table' : 'national_default',
    };
  }
}
```

### Step 5 — Add `buildBaseTariffs()` to `js/external-data.js` (exported)

New exported function. Composes all four base tariff outputs and coverage metadata.
This is the relocated + extended Phase A of M8's `prepareRates`.

Inputs:
- `consumption[]` — m1's HH timeline (for timestamps)
- `priceLookup` — Map from UTC key to p/kWh (from `fetchWholesalePrices`)
- `agileCalibration` — object from `fetchAgileCalibration` (D, P_peak_p_kwh, source)
- `tariff_rates` — `{ gas: [...], electricity: [...] }` from m1 (may be empty arrays on
  CSV/demo path)
- `gsp_region` — GSP region code or null

Returns `{ hh_rate, gas_rate, flat_rate, standing_charge, null_wholesale_fraction,
coverage_warnings, non_null_wholesale_count }`.

Key logic:

**VAT-path determination:** `isCalibrated = (agileCalibration.source === 'calibrated')`.
- Calibrated path: D already absorbs VAT. `hh_rate[i] = min(D×W + peak?P, 100)`.
- Table/national path: D, P are VAT-exclusive.
  `hh_rate[i] = min(D×W + peak?P, 95) × 1.05`.
- Negative wholesale is preserved in both paths (not clamped).

**Null-wholesale imputation:** When `wholesale_array[i]` is null, call
`imputeWholesaleForSlot(i, wholesale_array, global_mean_known, D, 24.50)` to get an
imputed wholesale value (magnitude-preserving, not zero); then apply the D×W+P formula
as normal. The imputed value is only a wholesale proxy — the rate formula applies to it
exactly as to a real value.

**Gas rate per HH:** Sort `tariff_rates.gas` windows; call `getRateForTs(tsDate,
gasWindows)`. If non-null → use m1's actual rate. If null (no windows, or a gap) → use
`OFGEM_CAP_GAS_BY_QUARTER[quarterKey(tsDate)]`. Warn once on gaps when windows exist.

**Flat rate per HH:** Same pattern using `tariff_rates.electricity` windows →
`OFGEM_CAP_ELEC_BY_QUARTER[quarterKey(tsDate)]`.

**Standing charges (scalar `{gas, elec}`):**
```javascript
const m1GasStanding  = gasWindows[gasWindows.length - 1]?.standing_p_day  ?? null;
const m1ElecStanding = elecWindows[elecWindows.length - 1]?.standing_p_day ?? null;
const regionalRow    = REGIONAL_STANDING_CHARGES[gsp_region] ?? null;
standing_charge = {
  gas:  m1GasStanding  ?? (regionalRow?.gas  ?? NATIONAL_GAS_STANDING_DEFAULT),
  elec: m1ElecStanding ?? (regionalRow?.elec ?? NATIONAL_ELEC_STANDING_DEFAULT),
};
```

**Coverage warnings:**
- `> 5%` null wholesale → info string (estimate caveat).
- `> 25%` null wholesale → insufficient-data string.

### Step 6 — Modify `alignExternalData()` in `js/external-data.js`

Remove `wholesale_p_kwh` from returned entries; remove the `priceLookup` parameter
(no longer needed — `priceLookup` is passed directly to `buildBaseTariffs` in app.js):

```javascript
export function alignExternalData(consumption, weatherMap) {
  return consumption.map(({ timestamp }) => {
    const tsCanonical = canonicaliseTs(timestamp);
    const hourCanonical = DateTime.fromISO(tsCanonical, { zone: 'utc' })
      .startOf('hour').toISO({ suppressMilliseconds: true });
    const weather = weatherMap.get(hourCanonical);
    return {
      timestamp:  tsCanonical,
      temp_c:     weather?.temperature_2m    ?? null,
      solar_w_m2: weather?.shortwave_radiation ?? null,
      // wholesale_p_kwh removed: m2-internal only (design §2.5.8)
    };
  });
}
```

### Step 7 — Modify `buildExternalMetadata()` in `js/external-data.js`

Remove the `agile_calibration` parameter (it becomes top-level on the stored M2 result,
not inside metadata). Add `coverage_warnings`:

```javascript
export function buildExternalMetadata(
  latitude, longitude, elevation, weatherSource, priceSource, priceWarnings, coverage_warnings
) {
  return {
    latitude, longitude,
    elevation_m: elevation,
    weather_source: weatherSource,
    price_source: priceSource,
    price_alignment_warnings: priceWarnings,
    coverage_warnings: coverage_warnings ?? [],
    fetch_timestamp: new Date().toISOString(),
    // agile_calibration removed: now a top-level field on the m2 result
  };
}
```

### Step 8 — Export new functions from `js/external-data.js`

Confirm `buildBaseTariffs` is in the export list. The module already uses named exports,
so this is just adding `buildBaseTariffs` to the export statements. Remove the export
of `getExternalResult` / `setExternalResult` only if those were used elsewhere — they
stay (app.js reads them).

### Step 9 — Refactor `prepareRates()` in `js/pricing-engine.js`

**New signature:** `prepareRates(ingestion, m2Result, params)` where `m2Result` is the
full M2 result (stored via `setExternalResult`; has `hh_rate`, `gas_rate`, `flat_rate`,
`standing_charge`, `agile_calibration`).

**Remove entirely:**
- The `for (let i = 0; i < n; i++)` loop building `gas_rate_by_hh` and
  `elec_hh_rate_by_hh` from scratch
- `imputeWholesaleForSlot()` (relocated to external-data.js)
- Standing charge derivation from `ingestion.tariff_rates`
- Agile calibration validation + `D_MIN/D_MAX/P_MIN/P_MAX` constants
- `wholesale_array` / `global_mean_known` computation
- Module-level `D_DEFAULT` / `P_DEFAULT_PEAK_P_KWH` constants

**Keep:**
- `data_period_days` computation (still reads `ingestion.consumption`)
- `MIN_DAYS_WARN` check
- §14 gas rate override: `params.gas_rate_override_p_kwh`
- §14 flat rate override: `params.svt_rate_p_per_kwh`
- `warnings` array

**New body (sketch):**

```javascript
export function prepareRates(ingestion, m2Result, params) {
  const warnings = [];
  const n = ingestion.consumption.length;

  // Base rates from M2; §14 overrides applied here (not in M2)
  let gas_rate_by_hh;
  if (params.gas_rate_override_p_kwh != null) {
    gas_rate_by_hh = new Array(n).fill(params.gas_rate_override_p_kwh);
  } else {
    gas_rate_by_hh = [...m2Result.gas_rate];
  }

  let flat_rate_by_hh;
  if (params.svt_rate_p_per_kwh != null) {
    flat_rate_by_hh = new Array(n).fill(params.svt_rate_p_per_kwh);
  } else {
    flat_rate_by_hh = [...m2Result.flat_rate];
  }

  const elec_hh_rate_by_hh = [...m2Result.hh_rate];

  const gas_standing_p_day  = m2Result.standing_charge.gas;
  const elec_standing_p_day = m2Result.standing_charge.elec;

  const data_period_days = new Set(
    ingestion.consumption.map(r => r.timestamp.slice(0, 10))
  ).size;

  if (data_period_days === 0) {
    warnings.push('No consumption data found — cannot compute costs.');
    return { gas_rate_by_hh: [], elec_hh_rate_by_hh: [], flat_rate_by_hh: [],
             gas_standing_charge_p_per_day: gas_standing_p_day,
             elec_standing_charge_p_per_day: elec_standing_p_day,
             data_period_days: 0,
             agile_calibration: m2Result.agile_calibration,
             calibration_source: m2Result.agile_calibration?.source ?? 'unknown',
             consumption: ingestion.consumption, warnings };
  }
  if (data_period_days < PE_CONFIG.MIN_DAYS_WARN) {
    warnings.push('Less than 3 months of data — annual cost estimates may be unreliable.');
  }

  return {
    gas_rate_by_hh,
    elec_hh_rate_by_hh,
    flat_rate_by_hh,
    gas_standing_charge_p_per_day:  gas_standing_p_day,
    elec_standing_charge_p_per_day: elec_standing_p_day,
    data_period_days,
    agile_calibration:  m2Result.agile_calibration,
    calibration_source: m2Result.agile_calibration?.source ?? 'unknown',
    consumption:        ingestion.consumption,
    warnings,
  };
}
```

**Removed from return:** `svt_rate_p_per_kwh`, `ofgem_cap_elec_p_kwh` (replaced by
`flat_rate_by_hh`). Check all `rateMetadata.*` accesses in app.js and display functions
for these removed keys; update to use `flat_rate_by_hh[i]` or remove if unused.

### Step 10 — Update `electricityRateForHH()` in `js/pricing-engine.js`

Remove `svtRate` parameter; use `flat_rate_by_hh[i]` for `dumb_hp_svt`:

```javascript
function electricityRateForHH(scenario, i, rateMetadata) {
  if (scenario === 'current')     return 0;
  if (scenario === 'dumb_hp_svt') return rateMetadata.flat_rate_by_hh[i];
  return rateMetadata.elec_hh_rate_by_hh[i];
}
```

Update both call sites in `computeCosts` (annual loop + monthly loop) to match the
new 3-arg signature.

Also update `computeCosts` to remove the `svtRate` local variable (was
`params.svt_rate_p_per_kwh ?? rateMetadata.svt_rate_p_per_kwh`). The standing charge
locals `gasSc` / `elecSc` read `params.*_standing_charge_p ?? rateMetadata
.*_standing_charge_p_per_day` — this is the §14 standing override; keep unchanged.

### Step 11 — Clean `PE_CONFIG` in `js/pricing-engine.js`

Remove these constants (relocated to external-data.js):
- `SVT_RATE_DEFAULT_P` — was 24.50; replaced by `OFGEM_CAP_ELEC_BY_QUARTER` in M2
- `ELEC_STANDING_DEFAULT_P_DAY` — was 61.64; replaced by `REGIONAL_STANDING_CHARGES`
- `GAS_STANDING_DEFAULT_P_DAY` — was 31.66; same
- `HH_OVERHEAD_DEFAULT_P` — was 13.00; no longer used anywhere (remove)

Also remove the module-level `isPeakHour()` from pricing-engine.js — it is now
authoritative only in external-data.js (`isUkPeakHour()`). Confirm M8 no longer calls
it after Step 9 removes the rate-building loop.

Keep in `PE_CONFIG`:
- `EXTREME_NEG_WHOLESALE_P` — still used in display/warning logic
- `PARTIAL_MONTH_DAY_THRESHOLD` — used in `buildMonthGroups`
- `MIN_DAYS_WARN` — used in `prepareRates`

### Step 12 — Update `runExternalData()` in `js/app.js`

Changes in order:

1. Add `buildBaseTariffs` to the named imports from `'./external-data.js'`.

2. Update `alignExternalData` call — remove `priceLookup` argument (signature changed):
   ```javascript
   const external = alignExternalData(consumption, weatherMap);
   ```

3. Remove the manual `null_wholesale_fraction` block (lines ~929–939) entirely. The
   resulting `agileCalibration` object is now just the raw result of
   `fetchAgileCalibration` (with `null_wholesale_fraction: null`).

4. After Step 6 (Agile calibration), add Step 6b:
   ```javascript
   // Step 6b: Build base tariffs (M2 single tariff source; wholesale stays internal)
   const { hh_rate, gas_rate, flat_rate, standing_charge,
           null_wholesale_fraction, coverage_warnings, non_null_wholesale_count }
     = buildBaseTariffs(
         consumption, priceLookup, agileCalibration,
         ingestion.tariff_rates, ingestion.gsp_region ?? null
       );
   agileCalibration.null_wholesale_fraction = null_wholesale_fraction;
   ```

5. Update `buildExternalMetadata` call — remove `agileCalibration` arg, add
   `coverage_warnings`:
   ```javascript
   const externalMetadata = buildExternalMetadata(
     latitude, longitude, elevation_m, weatherSource, priceSource, priceWarnings, coverage_warnings
   );
   ```

6. Update `setExternalResult` — store full M2 output:
   ```javascript
   setExternalResult({
     external,
     hh_rate,
     gas_rate,
     flat_rate,
     standing_charge,
     agile_calibration: agileCalibration,   // top-level (not inside external_metadata)
     external_metadata: externalMetadata,
   });
   ```

7. Update progress summary — replace `external.filter(e => e.wholesale_p_kwh !==
   null).length` with `non_null_wholesale_count` (returned from `buildBaseTariffs`):
   ```javascript
   showStatusFn(
     `External data loaded. Weather: ${weatherCount} periods. ` +
     `Wholesale prices: ${non_null_wholesale_count} periods (${priceSource}). ` +
     `Gaps: ${gapCount}.`,
     'success'
   );
   ```

### Step 13 — Update `runScenarioConsumption()` in `js/app.js`

Change the `prepareRates` call to pass the full M2 result, and remove
`agile_calibration` from `params` (now read from `m2Result.agile_calibration` inside
`prepareRates`):

```javascript
const externalResult = getExternalResult();
// ...
const rateParamsForM7   = { ...readRateParams() };  // agile_calibration removed from params
const rateMetadataForM7 = prepareRates(ingestion, externalResult, rateParamsForM7);
```

### Step 14 — Update `runPricingEngine()` in `js/app.js`

Same change as Step 13:

```javascript
const externalResult = getExternalResult();
// ...
const params      = { ...readRateParams() };  // agile_calibration removed from params
const rateMetadata = prepareRates(ingestion, externalResult, params);
```

Also update the `agile_calibration` read two lines above — from
`getExternalResult()?.external_metadata?.agile_calibration` → `getExternalResult()
?.agile_calibration` (top-level). Check if this local is used downstream; if not,
remove it from this function.

### Step 15 — Update coverage/display references in `js/app.js`

1. **Three-tier coverage warning display (~line 1724):**
   ```javascript
   const cal       = getExternalResult()?.agile_calibration ?? null;
   // (was: external_metadata?.agile_calibration)
   const fraction  = cal?.null_wholesale_fraction ?? 0;
   const calSource = rateMetadata?.calibration_source ?? 'unknown';
   // (was: ?? 'fetched' — check if any display branch compares === 'fetched';
   //  if so, update comparison to === 'calibrated')
   ```

2. **Grep for any remaining `wholesale_p_kwh` references** in app.js and update or
   remove them. The progress summary is Step 12. The known remaining site is
   **`buildRateArrays` (app.js ~line 1547)**, which reads `external[i]?.wholesale_p_kwh`
   to build a local M7 rate array — it is **superseded by `prepareRates`** (M7 switched
   to `prepareRates` on 2026-05-07 and now consumes m2's `hh_rate`). Confirm
   `buildRateArrays` is no longer called and **remove it**; if a live caller is found,
   surface to Opus rather than leaving it reading the removed field.

3. **Grep for `external_metadata.agile_calibration`** — should be zero hits after
   Steps 13–15. Confirm.

4. **`renderDayViewDay` and day-view chart (~line 2813):** Uses `getRateMetadata()`
   which returns rateMetadata. Check if any chart code references
   `rateMetadata.svt_rate_p_per_kwh` or `rateMetadata.ofgem_cap_elec_p_kwh` (both
   removed from prepareRates return); replace with `rateMetadata.flat_rate_by_hh[i]`
   as appropriate.

### Step 16 — Write and run `test-m2-v2.mjs`

Create a Node-runnable test file (pattern: same as `test-m8.mjs` — no test framework,
assertions with `console.assert`). Tests are **unit tests against pure functions** —
no live API calls.

Import the functions under test from `js/external-data.js` (where they can be imported
via Node `--experimental-vm-modules` or the project's existing approach; check
`test-m8.mjs` for the import pattern).

**TC10** — `alignExternalData` returns entries with exactly `{timestamp, temp_c,
solar_w_m2}` and **no** `wholesale_p_kwh` key. Assertion:
`assert(!('wholesale_p_kwh' in result[0]))`.

**TC13 — Calibrated-path VAT:**
- Build a synthetic consumption/priceLookup with W=5.0, D_cal=2.2, P_cal=12.
- Peak slot: `buildBaseTariffs(...).hh_rate[peak_i] === 23.0` exactly.
- Off-peak: `=== 11.0`.
- No ×1.05 applied. (Would give 24.15 / 11.55 if incorrectly VAT-ing.)

**TC14 — Table-path VAT:**
- Same W=5.0; agileCalibration with D=2.2, P=12, `source: 'national_default'`
  (triggers the VAT-exclusive formula).
- Peak: `Math.abs(hh_rate[peak_i] - 24.15) < 0.01`.
- Off-peak: `Math.abs(hh_rate[off_i] - 11.55) < 0.01`.
- Must fail if ×1.05 was applied on the calibrated path or omitted on the table path.

**TC15 — Negative wholesale not clamped:**
- W=−5.0, D=2.2, calibrated, off-peak → `hh_rate[i] < 0` (not clamped to 0).
- Exact value: −11.0 (calibrated). Confirm no `Math.max(0, ...)` guard.
- Note: the design doc §5 TC15 table-path value is **−11.55** (`min(2.2×−5, 95)×1.05`),
  corrected this review from a typo'd −5.78 (which was D=1.1). Test checks `hh_rate < 0`
  (the load-bearing principle); the corrected exact table-path value is −11.55.

**TC16 — Null-wholesale fallback:**
- Build priceLookup with 10% of slots set to null.
- Null slots: `hh_rate[null_i] !== 0` and `hh_rate[null_i] !== null` (fallback used).
- Non-null slots: rate derived from the real wholesale value.

**TC17 — Coverage thresholds:**
- 6% null: `coverage_warnings.length > 0` and warning text contains "estimate" (info).
- 26% null: `coverage_warnings.length > 0` and text contains "unreliable" or
  "insufficient".

**TC18 — Supplied-vs-default (gas):**
- API path: `tariff_rates.gas = [{ valid_from: '...', rate_p_kwh: 7.5, ... }]` →
  `gas_rate[0] === 7.5`.
- CSV path: `tariff_rates.gas = []` →
  `gas_rate[0] === OFGEM_CAP_GAS_BY_QUARTER[quarterKey(ts)]`.

**TC19 — Supplied-vs-default (standing, regional):**
- `gsp_region='C'`, empty `tariff_rates` →
  `standing_charge.gas === REGIONAL_STANDING_CHARGES['C'].gas` and
  `standing_charge.elec === REGIONAL_STANDING_CHARGES['C'].elec`.

**SP→UTC regression (2 cases):**
- Normal GMT: 2026-01-15, SP1 → `2026-01-15T00:00:00Z`. SP48 → `2026-01-15T23:30:00Z`.
- BST: 2025-06-15, SP1 → `2025-06-14T23:00:00Z`.
(Existing `convertSpToUtc` logic; just regression-guard it.)

Run with: `node test-m2-v2.mjs`. **`external-data.js` has a top-level
`const { DateTime } = luxon;`**, so the test must set `globalThis.luxon` (import the
`luxon` package and assign it) **before** importing `external-data.js` — otherwise the
import throws `luxon is not defined` and no tests run. `test-m8.mjs`'s pattern alone does
**not** cover this (it imports `pricing-engine.js`, which does not use Luxon); use it for
the base plain-ESM import pattern only.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| VAT-path error (×1.05 on calibrated / omitted on table path) | TC13 + TC14 explicitly test both paths; branch on `agileCalibration.source === 'calibrated'`. Both must fail to catch either mistake. |
| Regional standing-charge figures not sourced | Explicitly provisional: CSV skeleton + JS constant both carry `PENDING_SOURCE` notices. Northern Scotland (P) flagged separately. Rhiannon/Opus to source before v2 launch. |
| Ofgem quarterly rate schedule incomplete | Only CSV/demo path affected. PROVISIONAL entries use nearest known value; `quarterKey()` console-warns. Flagged for Opus as research task. |
| `source: 'fetched'` renamed to `'calibrated'` | Step 15 explicitly audits all `calSource` references in app.js. Grep for `'fetched'` in display logic before commit. |
| `agile_calibration` path changes from `external_metadata.agile_calibration` to top-level | Steps 13–15 cover all three access sites. Grep for `external_metadata.agile_calibration` — must be zero hits after implementation. |
| `prepareRates` signature change breaks the M7 prepareRates call in `runScenarioConsumption` | Both call sites updated in Steps 13–14. Confirm the M7-path rate arrays (`gasRateByHh`, `elecHhRateByHh`) in app.js lines ~1644–1645 reference the new return keys. |
| `electricityRateForHH` signature change — missed call site | Two call sites in `computeCosts` (annual + monthly loops). Update both. |
| `rateMetadata.svt_rate_p_per_kwh` / `ofgem_cap_elec_p_kwh` removed — downstream display code breaks | Step 15 covers `renderDayViewDay` and day-view chart. Grep for both removed keys in app.js before commit. |
| `data/mid-prices.json` CORS fallback (pre-existing gap) | Pre-existing; out of scope. The Elexon fetch catches CORS and returns empty priceLookup. Flag for M2-v2 launch checklist. |
| §14 accidentally implemented | Hard constraint: only the existing §14 overrides in M8 (gas_rate_override_p_kwh, svt_rate_p_per_kwh, standing overrides) are preserved; no new §14 logic. Scale-all is out of scope. |
| TC15 design-doc value discrepancy (−5.78) | Plan's test checks `hh_rate < 0` (principle). Discrepancy flagged for Opus review — likely a typo in the design doc. |

---

## Success criteria

- [ ] `alignExternalData()` returns entries with exactly `{timestamp, temp_c, solar_w_m2}` — no `wholesale_p_kwh` field (TC10)
- [ ] `buildBaseTariffs()` produces `hh_rate[]`, `gas_rate[]`, `flat_rate[]`, `standing_charge` for a synthetic consumption timeline
- [ ] Calibrated-path: W=5.0, D=2.2, P=12, peak → `hh_rate = 23.0` (no ×1.05) (TC13)
- [ ] Table/national-path: W=5.0, D=2.2, P=12, peak → `hh_rate ≈ 24.15` (×1.05 applied) (TC14)
- [ ] Negative wholesale → negative rate, not clamped (TC15)
- [ ] 10% null wholesale → affected slots use imputed value, not zero (TC16)
- [ ] 6% null → info coverage warning; 26% null → insufficient-data warning (TC17)
- [ ] API-path gas: m1 actual rate used; CSV-path gas: Ofgem cap quarterly default (TC18)
- [ ] Regional standing fallback applied when m1 standing absent (TC19)
- [ ] `fetchAgileCalibration()` returns `source: 'calibrated'` on success; `source: 'regional_table'` on live-cal failure with valid region; `source: 'national_default'` when region null
- [ ] `prepareRates()` applies `gas_rate_override_p_kwh` §14 override on top of M2 base gas rate, replacing the array
- [ ] `prepareRates()` returns `flat_rate_by_hh[]` and `elec_hh_rate_by_hh[]` as separate arrays
- [ ] `computeCosts()` uses `rateMetadata.flat_rate_by_hh[i]` for `dumb_hp_svt` scenario
- [ ] `agile_calibration` accessible at `getExternalResult().agile_calibration` (top-level, not `external_metadata.agile_calibration`)
- [ ] `null_wholesale_fraction` present on `agile_calibration` object after `buildBaseTariffs` call
- [ ] Grep for `wholesale_p_kwh` in JS files: zero hits (containment complete)
- [ ] Grep for `external_metadata.agile_calibration`: zero hits in app.js
- [ ] All existing test suites pass: M3 18/18, M5 39/39, M5b 29/29, M6 24/24, M7 39/39, M8 24/24, M9 24/24
- [ ] **User-test items for Rhiannon (browser-side — not runnable in Node):**
  - Live Octopus API path: calibration runs without errors; D/P in expected range for the user's region; browser console shows `source: 'calibrated'`
  - Elexon wholesale prices fetch for a 1-year range: ~17,000 price periods, no APXMIDP gaps
  - CSV path: standings default correctly; gas rate resolves to Ofgem cap quarterly
  - Coverage warnings appear in UI for date ranges with known wholesale gaps
  - CORS fallback observable in DevTools (block Elexon via Network throttle → `price_source: 'static-fallback'` or empty wholesale)

---

## Flags for Opus review

**F1 — Regional standing-charge figures (PENDING_SOURCE):** `data/regional-standing
-charges.csv` and `REGIONAL_STANDING_CHARGES` JS constant use provisional national
values (61.64p elec / 31.66p gas) for all 14 regions. Northern Scotland (P) is
known to have materially higher standing charges. Figures must be sourced from Ofgem
price cap documentation before v2 launch.

**F2 — Ofgem quarterly rate schedule (PROVISIONAL):** Historical quarters (Q1 2024 →
Q1 2026) are marked PROVISIONAL and copy the nearest confirmed value. Affects CSV/demo
path only. Research task to populate before v2 launch.

**F3 — TC15 design-doc value — RESOLVED (Opus review 2026-06-03):** the design doc §5 TC15
table-path value has been corrected from −5.78 to **−11.55** (`min(2.2×−5, 95)×1.05`; the
−5.78 was a D=1.1 typo). Implementation tests the principle (negative → negative, not
clamped); the exact table-path value is −11.55.

**F4 — `data/mid-prices.json` CORS fallback:** Referenced in design §2.5.3 as a static
fallback for Elexon CORS blocks; the file was never built. Out of scope for this plan.
Flag for M2-v2 launch checklist.

**F5 — `calibration_source` string change:** `'fetched'` → `'calibrated'`. Any UI copy
or display branch comparing against `'fetched'` will silently stop matching. Step 15
audits this in app.js; confirm no other references exist (index.html, display functions).

---

## Implementation Deviations

**Date:** 2026-06-04

**D1 — `package.json` created for Luxon Node.js test dependency.**
Plan Step 16 specified `node test-m2-v2.mjs` but did not address that Luxon is not
installed as a Node.js dependency (the tool is client-side only). A minimal
`package.json` with `devDependencies: { luxon: "3.5.0" }` was created and `npm install`
run. The test uses a dynamic import to set `globalThis.luxon` before importing
`external-data.js`, satisfying the Step 16 Luxon-global requirement. `node_modules/` is
not committed (add to `.gitignore` if not already excluded).

**D2 — `PE_CONFIG` unused import removed from `app.js`.**
Code review found `PE_CONFIG` was imported from `pricing-engine.js` in `app.js` but not
used anywhere in the file (all uses of its former constants were already replaced by
inline literals or removed with the plan changes). Removed as dead code — no functional
impact.

**D3 — Two new test cases added to `test-m8.mjs` (T11, T12).**
The plan directed updating test-m8.mjs fixtures to use a synthetic `m2Result` object.
During the rewrite, two new test cases were added: T11 verifies the `§14` gas rate
override in `prepareRates` (uniform fill replaces m2Result.gas_rate); T12 verifies the
SVT flat-rate override (uniform fill replaces m2Result.flat_rate without affecting
hh_rate). Test count: 24 → 29 assertions. These test the §14 functionality that stayed
in M8, which was previously incidentally covered by the old rate-building loop but not
explicitly verified.

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-06-03
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/m2-external-data-v2.md`

### Context

Re-cut of the M2 plan against the realigned, self-contained m2-v2 design doc (m2 = single
tariff source; supplied-vs-default; regional Agile D/P + regional standing; §14 what-if
entirely in m8; wholesale containment). The plan is faithful to the design on every
load-bearing point. Codebase claims were verified via a read-only Explore sub-agent and all
CONFIRMED: the GSP-region access path (`ingestion.gsp_region`, top-level), the m1
`tariff_rates` schema (`{gas,electricity}` arrays with `rate_p_kwh` / `valid_from` /
`valid_to` / `standing_p_day`), the `isPeakHour` removal safety (single caller, the loop
being removed), and `external-data.js` Node-importability. The null-wholesale / coverage
machinery the plan relocates is **pre-existing** (agile-rate-robustness, live since
2026-04-30) — it guards isolated Elexon data gaps (~1–2% of slots), **not** APX provider
failure (APX is reliable); the plan moves it unchanged per the defer-to-working-code guardrail.

### Required changes for implementation

**1. Complete the wholesale-containment audit — `buildRateArrays` (app.js ~1547).** Step 15.2
asserted "any other accesses into `external[]` for price data should no longer exist," but
`buildRateArrays` still reads `external[i]?.wholesale_p_kwh`. It is superseded by `prepareRates`
(M7 switched on 2026-05-07). Step 15.2 amended to name it + disposition: confirm uncalled and
remove; surface to Opus if a live caller is found.

**2. Luxon global for the Node test (Step 16).** `external-data.js` has a top-level
`const { DateTime } = luxon;`, so `test-m2-v2.mjs` must set `globalThis.luxon` before importing
it — `test-m8.mjs`'s pattern does not cover this (it imports `pricing-engine.js`, no Luxon).
Step 16 amended.

**3. TC15 design-doc value (F3).** The design doc §5 TC15 table-path value was a typo (−5.78 =
D=1.1); corrected to **−11.55** in the design doc this review (separate praxis-hub commit). The
plan's TC15 note and F3 updated to the corrected value; the implementation correctly tests the
principle (negative → negative, not clamped).

### Resolution of review changes

1. **buildRateArrays audit** — Step 15.2 amended (names app.js:1547 + confirm-uncalled-and-remove).
2. **Luxon global** — Step 16 amended with the `globalThis.luxon` setup requirement.
3. **TC15 value** — design doc corrected (−5.78 → −11.55); plan TC15 note + F3 reconciled.

### Items noted but not edited

- **LOW — `imputeWholesaleForSlot` hardcodes `24.50`** (Step 5 call) for the all-null last-resort
  cap. Reference the Ofgem-cap constant during implementation rather than the literal;
  degenerate-case only, non-blocking.
- **MEDIUM (observation) — plan size.** 16 steps, 3 files modified heavily + 3 created — beyond the
  sizing guide, but the `prepareRates` relocation is atomic (splitting leaves a broken
  intermediate). Kept as one plan deliberately.
- **Accepted as provisional (architect-owned):** F1 (regional standing-charge figures,
  PENDING_SOURCE) and F2 (quarterly Ofgem schedule, PROVISIONAL) match the agreed architect-note
  approach. Opus owns sourcing `data/regional-standing-charges.csv` and the quarterly cap schedule
  before v2 launch; correctly deferred, not blockers.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | ✓ pass |
| HIGH     | 0     | ✓ pass |
| MEDIUM   | 3     | ✅ resolved (2) / ℹ noted (1) |
| LOW      | 1     | — noted |

Verdict: ⚠ APPROVED WITH EDITS — faithful relocation; three hygiene edits applied
(containment-audit completion, test Luxon-global, TC15 reconcile); regional-figure sourcing
remains architect-owned.

---

## Approval

**Status:** ⚠ Approved with edits — 2026-06-03
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:**
- The null-wholesale / coverage machinery is **pre-existing** (relocated unchanged), guarding
  Elexon data gaps, **not** APX failure (APX reliable) — not new scope.
- §14 (scale-all + rate/standing overrides) stays entirely in m8; m2 builds base tariffs only.
- Regional standing-charge figures + the full quarterly Ofgem cap schedule are **architect-owned**
  sourcing tasks; the PENDING_SOURCE / PROVISIONAL placeholders are accepted for now.
- `buildRateArrays` (app.js:1547) is the dead remnant of the 2026-05-07 prepareRates switch —
  confirm uncalled and remove.
