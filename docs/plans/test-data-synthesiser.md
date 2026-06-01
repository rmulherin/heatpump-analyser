# Test Data Synthesiser — Implementation Plan

**Date:** 2026-06-01
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the test-data synthesiser as a Node.js library + CLI script that produces per-archetype demo consumption CSVs for the heatpump analyser tool. The library runs a building-physics forward model against Open-Meteo historical weather (cached), applies schedule jitter, holiday-week injection, parametric HW/cooking pulses, and calibrated AR(1) + multiplicative noise, then writes a CSV (17,520 HH rows), a stats JSON, and a markdown bake report. A thin CLI wrapper (`scripts/synthesise.mjs`) exposes the library to Opus's iteration loop. The four archetype config files and a placeholder `noise-config.json` are also created as part of this plan.

Design doc: `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/test-data-synthesiser.md`
Parent strategy: `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/test-data-strategy.md`

---

## Research findings

### Node.js environment

Node.js v24.14.1 is available. Native `fetch` is present (Node 18+). No npm packages are needed — Mulberry32 (inline PRNG) and native `fetch` cover all external calls.

### Reuse from tool's JS modules

All tool JS modules are vanilla ES modules (`export function`, no imports from npm). Whether they are importable in Node.js depends on whether they use browser globals at module level:

| Module | Importable in Node.js? | Notes |
|--------|------------------------|-------|
| `js/constants.js` | Yes | Pure exports only. `HDD_BASE_TEMP = 15.5` |
| `js/heat-loss.js` | Yes | Imports only from `constants.js`. No browser globals. |
| `js/baseload.js` | Yes | Imports only from `constants.js`. No browser globals. |
| `js/thermal-character.js` | Yes | No imports at all. No browser globals. |
| `js/scenario-consumption.js` | Yes | No imports at all. No browser globals. |
| `js/data-ingestion.js` | Yes (for `parseCSV`) | No import statements. `parseCSV` uses only `Intl.DateTimeFormat` + string ops (standard ECMA, works in Node.js). |
| `js/external-data.js` | **No** | Uses `const { DateTime } = luxon` (browser CDN global). Cannot be imported in Node.js without modification. |

**Consequence for weather fetching:** `external-data.js` is not importable, so the synthesiser replicates the two simple URL patterns directly — Postcodes.io and Open-Meteo archive. Both are single `GET` calls; replicating them is ~15 lines.

### Reuse decisions

- **`HDD_BASE_TEMP`**: Import from `../../js/constants.js` (used in stats computation for daily HDD).
- **`parseCSV`** (TC5 test + optional `runToolModules`): Import from `../../js/data-ingestion.js` via dynamic import inside the optional code path. Graceful fallback on import failure per design doc edge cases.
- **`estimateHeatLoss` (M4), `estimateThermalCharacter` (M5), `baseloadSeparation` (M3)**: Available for `runToolModules: true` flag via dynamic import. Not needed for the primary path.
- **Postcodes.io + Open-Meteo URL construction**: Implemented inline in the synthesiser (~15 lines each). Algorithm is identical to `external-data.js` but without Luxon.

### Date arithmetic

Luxon is not available in Node.js context. All date arithmetic uses native `Date.UTC()` and `Date` methods. For the 2025 year (non-leap), 17,520 HH periods = 365 × 48. UTC timestamps have no DST complications. Day-of-week is `new Date(ms).getUTCDay()`. Hour and minute from UTC: `getUTCHours()`, `getUTCMinutes()`.

### .gitignore state

Current `.gitignore` excludes `*.csv` globally (with exception `!docs/**/*.csv`) and `test-data/` entirely. Two additions needed:
1. `!data/demos/*.csv` and `!data/demos/*.json` — so the shipped demo files can be committed after validation.
2. `!test-data/noise-config.json` — so the committable noise stats file isn't excluded.
3. `bake-output/` and `bake-input/` — to exclude per-bake working directories.

### No package.json needed

The `.mjs` extension signals Node.js ESM mode without requiring a `package.json`. Existing test files (`test-m5.mjs` etc.) follow the same pattern and run with `node test-m5.mjs` from the repo root with no install step. The synthesiser follows the same convention.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `.gitignore` | Add bake-output/, bake-input/; add !data/demos/ and !test-data/noise-config.json exceptions |
| CREATE | `scripts/synthesise.mjs` | CLI wrapper — parses args, calls `synthesise()`, prints summary |
| CREATE | `scripts/lib/synthesiser.mjs` | Core library — all synthesiser logic |
| CREATE | `demo-configs/modern-out-for-work.json` | Archetype config, starting values from strategy §E |
| CREATE | `demo-configs/average-in-all-day.json` | Archetype config |
| CREATE | `demo-configs/small-and-efficient.json` | Archetype config |
| CREATE | `demo-configs/big-old-draughty.json` | Archetype config |
| CREATE | `test-data/noise-config.json` | Placeholder noise config (illustrative values from design doc §Inputs) |
| CREATE | `test-synthesiser.mjs` | Unit tests TCs 1–6 (+ TC10 reproducibility) |

---

## Implementation steps

### Step 1 — .gitignore additions

Add the following lines to `.gitignore`:

```gitignore
# Bake working directories (not shipped)
bake-output/
bake-input/

# Shipped demo files (exempt from *.csv exclusion)
!data/demos/*.csv
!data/demos/*.json

# Committable noise calibration output (exempt from test-data/ exclusion)
!test-data/noise-config.json
```

Also create `data/demos/.gitkeep` so the directory is tracked before any CSVs land.

---

### Step 2 — Placeholder noise-config.json

Write `test-data/noise-config.json` with the illustrative values from the design doc. These are placeholders for development; real values come from the noise-calibration step (strategy §V1 Step 0c) run before any production bake.

```json
{
  "_note": "Illustrative placeholder values — replace with output of noise-calibration step before production bake.",
  "source_note": "Derived from calibration step. Statistics only — no consumption values.",
  "measurement_noise": {
    "smart_meter_relative_sd": 0.018
  },
  "behavioural_noise": {
    "hh_residual_autocorr_lag1": 0.42,
    "daily_residual_cv": 0.11,
    "weekday_weekend_elec_ratio": 1.08
  },
  "schedule_jitter": {
    "boiler_start_sd_minutes": 14
  },
  "holiday_weeks": {
    "events_per_year": 3,
    "mean_duration_days": 5
  },
  "cooking_event_time_distribution": {
    "evening_peak_hour_utc": 18,
    "evening_peak_sd_hours": 1.1,
    "morning_peak_hour_utc": 7,
    "morning_peak_sd_hours": 0.6
  }
}
```

---

### Step 3 — Demo archetype config files

Write four JSON files in `demo-configs/` using the starting values from strategy §E. Each includes `noise_overrides` with the per-archetype `hh_residual_autocorr_lag1` value (strategy §E final column). The `weekday_weekend_elec_ratio` noise override is also set per archetype (strategy §C: not transferable).

**modern-out-for-work.json** (noise_overrides: autocorr 0.55, ww_ratio 1.08)
**average-in-all-day.json** (noise_overrides: autocorr 0.75, ww_ratio 1.15 — in-all-day continuous occupancy, more uniform weekday/weekend)
**small-and-efficient.json** (noise_overrides: autocorr 0.70, ww_ratio 1.06 — single occupant, mild weekday/weekend difference)
**big-old-draughty.json** (noise_overrides: autocorr 0.65, ww_ratio 1.12 — multi-occupant, more discrete events)

Weekend/weekday ratios for the non-calibration-household archetypes are set from first principles: "modern out for work" gets the calibration value (1.08) since the pattern is most similar; the others are estimated from CIBSE-style occupancy schedules. These will be adjusted through the iteration loop.

Each config file includes all fields specified in the design doc §Inputs schema: `slug`, `label`, `bio`, `display_order`, `archetype_source`, `building`, `schedule`, `baseload`, `location`, `time_window`, `noise_overrides`, `prng_seed`.

---

### Step 4 — Library: PRNG, config reading, schema validation

In `scripts/lib/synthesiser.mjs`:

**`mulberry32(seed)`**
```js
function mulberry32(seed) {
  return function() {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
```

**`boxMuller(prng)`** — returns a standard normal variate using Box-Muller:
```js
function boxMuller(prng) {
  let u1 = prng();
  while (u1 === 0) u1 = prng();   // avoid log(0)
  const u2 = prng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
```

**`readConfigs(archetypeConfigPath, noiseConfigPath)`**
- Read both files via `fs.readFileSync`
- `JSON.parse` each
- Validate required fields manually (no Ajv — matches "no dependency" spirit):
  - Archetype: `slug`, `label`, `building.htc_w_per_k`, `building.thermal_mass_kj_per_k`, `building.boiler_efficiency`, `building.solar_aperture_m2`, `building.setpoint_c`, `schedule.kind`, `baseload.gas_hot_water_kwh_per_day`, `baseload.gas_cooking_kwh_per_day`, `baseload.elec_baseload_kwh_per_day`, `baseload.elec_appliance_events_per_week`, `location.postcode`, `time_window.start`, `time_window.end`, `prng_seed`
  - Noise: `measurement_noise.smart_meter_relative_sd`, `behavioural_noise.hh_residual_autocorr_lag1`, `behavioural_noise.daily_residual_cv`, `schedule_jitter.boiler_start_sd_minutes`, `holiday_weeks.events_per_year`, `holiday_weeks.mean_duration_days`, `cooking_event_time_distribution.evening_peak_hour_utc`, `cooking_event_time_distribution.morning_peak_hour_utc`
- Merge `archetypeConfig.noise_overrides` into noise config (overrides take precedence for their fields)
- Throw with `Error('Missing required field: <path>')` if any required field absent

---

### Step 5 — Library: weather fetching with caching

**`resolvePostcode(postcode)`** — calls `https://api.postcodes.io/postcodes/{encoded_postcode}`:
```js
async function resolvePostcode(postcode) {
  const stripped = postcode.replace(/\s+/g, '');
  const url = `https://api.postcodes.io/postcodes/${encodeURIComponent(stripped)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Postcode ${postcode} not found (${resp.status}). Check the archetype config.`);
  const data = await resp.json();
  return { lat: data.result.latitude, lon: data.result.longitude };
}
```

**`fetchWeatherCached(postcode, timeWindow, cacheDir, verbose)`** → `Array<{timestamp, temp_c, solar_w_m2}>`

- `cacheKey = postcode.replace(/\s+/g, '').toLowerCase() + '-' + startDate + '-' + endDate + '.json'`
- `cachePath = path.join(cacheDir, cacheKey)`
- If cache file exists: read, JSON parse, return
- Otherwise:
  1. Call `resolvePostcode(postcode)` → `{ lat, lon }`
  2. Call Open-Meteo archive: `https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&start_date={startDate}&end_date={endDate}&hourly=temperature_2m,shortwave_radiation&timezone=UTC`
  3. Parse `data.hourly.time[]`, `data.hourly.temperature_2m[]`, `data.hourly.shortwave_radiation[]`
  4. Forward-fill logic: scan for nulls; fill ≤2 consecutive nulls with preceding value; abort with detailed error if gap > 2
  5. Convert hourly → half-hourly: for each hourly entry, emit two HH entries (`:00` and `:30`) with duplicated values
  6. Build array of `{ timestamp: 'YYYY-MM-DD HH:MM', temp_c, solar_w_m2 }`
  7. `fs.mkdirSync(cacheDir, { recursive: true })` then write JSON to `cachePath`
  8. Return the array

Timestamps in the weather array use format `YYYY-MM-DD HH:MM` (no seconds, no Z) matching the CSV output format and the HH timestamp array format.

---

### Step 6 — Library: HH timestamp array

**`generateTimestamps(timeWindow)`** → `string[]`

- `startMs = Date.UTC(2025, 0, 1, 0, 0, 0)` (from `time_window.start`)
- `endMs = Date.UTC(2025, 11, 31, 23, 30, 0)` (from `time_window.end`)
- Step: 1,800,000 ms (30 min)
- Format each `ms` as `YYYY-MM-DD HH:MM` using `new Date(ms)` UTC getters
- Returns 17,520 strings for 2025

Helper `formatTs(ms)`:
```js
function formatTs(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
```

---

### Step 7 — Library: schedule generation

**`generateSchedule(scheduleConfig, timestampMs, noiseConfig, prng)`** → `boolean[]`

`timestampMs` is a parallel array of epoch milliseconds (computed alongside the timestamp string array).

Per day (group HH indices by UTC date):
1. Determine if weekday (`getUTCDay()` in 1–5) or weekend (0, 6)
2. Select `weekday_windows` or `weekend_windows` from `scheduleConfig`
3. For each window, draw one jitter value: `jitterMin = boxMuller(prng) * noiseConfig.schedule_jitter.boiler_start_sd_minutes`, clipped to ±2 SD. Apply same jitter to start and end (shifts the whole window without changing its width). Convert minutes to HH offset.
4. For each HH in the day, compute HH's minutes-since-midnight-UTC. If within any jittered window, `heating_on[i] = true`.

---

### Step 8 — Library: holiday week injection

**`generateHolidayWeeks(timestampMs, noiseConfig, prng)`** → `boolean[]`

- `n_events = noiseConfig.holiday_weeks.events_per_year`
- `dur = noiseConfig.holiday_weeks.mean_duration_days`
- Total absence HH = `n_events × dur × 48`
- Pick `n_events` non-overlapping absence windows:
  - Sample candidate start day uniformly from day 14 through day 330 (excludes first two weeks of Jan and last few weeks of Dec — biased away from January per design doc)
  - Reject if overlaps with any already-selected window
  - Accept up to 100 attempts before moving on (avoids infinite loop with few valid slots)
- Mark all 48 HH within each absence day as `true`

---

### Step 9 — Library: forward model

**`computeForwardModel(archetypeConfig, timestampMs, weather, heatingOn, isAbsence)`** → `{ gasHeating: Float64Array, heatDemand: Float64Array }`

For each HH `i`:
```js
if (isAbsence[i] || !heatingOn[i]) {
  gasHeating[i] = 0;
  heatDemand[i] = 0;
  continue;
}
const dT = Math.max(0, archetypeConfig.building.setpoint_c - weather[i].temp_c);
const heatLoss  = archetypeConfig.building.htc_w_per_k * dT * 0.5 * 0.001;   // kWh
const solarGain = archetypeConfig.building.solar_aperture_m2 * weather[i].solar_w_m2 * 0.5 * 0.001; // kWh
heatDemand[i]  = Math.max(0, heatLoss - solarGain);
gasHeating[i]  = heatDemand[i] / archetypeConfig.building.boiler_efficiency;
```

Note: this is the forward direction of M4's Siviour regression — same physics, opposite solve direction (design doc §Method note).

---

### Step 10 — Library: HW and cooking gas baseload

**`computeHWandCooking(archetypeConfig, timestampMs, noiseConfig, prng)`** → `Float64Array`

Helper **`gaussianPulse(msArray, centreMins, sdMins, totalKwhPerDay)`**:
- For each HH index in a day, compute a Gaussian weight at that HH's minutes-since-midnight relative to `centreMins`
- Normalise weights so they sum to 1 across the day's 48 HH
- Multiply normalised weight by `totalKwhPerDay` to get per-HH kWh

Main function: per day:
1. Draw daily residual: `dailyFactor = 1 + boxMuller(prng) × noiseConfig.behavioural_noise.daily_residual_cv`, clamped to [0.1, 3.0]
2. Total HW+cooking for this day = `(archetypeConfig.baseload.gas_hot_water_kwh_per_day + archetypeConfig.baseload.gas_cooking_kwh_per_day) × dailyFactor`
3. Split into morning fraction (fixed at 0.35) and evening (0.65)
4. Jitter morning centre: `centre = noiseConfig.cooking_event_time_distribution.morning_peak_hour_utc × 60 + boxMuller(prng) × noiseConfig.cooking_event_time_distribution.morning_peak_sd_hours × 60`
5. Same for evening centre
6. Apply `gaussianPulse` for morning and evening, add to output array

---

### Step 11 — Library: electricity baseload

**`computeElecBaseload(archetypeConfig, timestamps, timestampMs, noiseConfig, prng)`** → `Float64Array`

- **Steady baseline**: `archetypeConfig.baseload.elec_baseload_kwh_per_day / 48` per HH
- **Occupancy modulation**: multiply by factor based on time-of-day. Approximate lighting+fridge+TV pattern: factor = 0.6 during 02:00–08:00 UTC, 1.3 during 18:00–22:00 UTC, 1.0 otherwise. (Simplified; refines through iteration loop.)
- **Weekend uplift**: multiply all weekend HH by `noiseConfig.behavioural_noise.weekday_weekend_elec_ratio` (or `archetypeConfig.noise_overrides.weekday_weekend_elec_ratio` if present — this field is per-archetype per strategy §C).
- **Discrete appliance events**: per week, sample `archetypeConfig.baseload.elec_appliance_events_per_week` start times from the evening-peak distribution (cooking_event_time_distribution); each event delivers `0.5 + prng() × 1.5` kWh spread over `1 + Math.round(prng())` hours (so 1 or 2 hours). Add to the relevant HH.

---

### Step 12 — Library: noise injection

**`injectNoise(gasArr, elecArr, noiseConfig, archetypeConfig, prng)`** — modifies arrays in place.

Effective `phi` = `archetypeConfig.noise_overrides?.hh_residual_autocorr_lag1 ?? noiseConfig.behavioural_noise.hh_residual_autocorr_lag1`

**Sigma calibration** (per design doc §Method `injectNoise`):
```js
// sigma calibrated so daily-aggregate CV matches daily_residual_cv under AR(1) with autocorr phi
const meanHhGas  = gasArr.reduce((a, b) => a + b, 0) / gasArr.length;
const meanHhElec = elecArr.reduce((a, b) => a + b, 0) / elecArr.length;
const cv = noiseConfig.behavioural_noise.daily_residual_cv;
const phi = effectivePhi;
const sigmaGas  = meanHhGas  * cv * Math.sqrt(2 * (1 - phi*phi) / (48 * (1 - phi) ** 2));
const sigmaElec = meanHhElec * cv * Math.sqrt(2 * (1 - phi*phi) / (48 * (1 - phi) ** 2));
```

Two noise passes (applied sequentially, per the design doc high-level flow — measurement noise first, then AR(1)):

1. **Measurement noise** (multiplicative, HH-independent):
   ```js
   const sd = noiseConfig.measurement_noise.smart_meter_relative_sd;
   gasArr[i]  *= (1 + boxMuller(prng) * sd);
   elecArr[i] *= (1 + boxMuller(prng) * sd);
   ```

2. **AR(1) behavioural residual** (additive, autocorrelated):
   ```js
   let rGas = 0, rElec = 0;
   for each i:
     rGas  = phi * rGas  + sigmaGas  * boxMuller(prng);
     rElec = phi * rElec + sigmaElec * boxMuller(prng);
     gasArr[i]  += rGas;
     elecArr[i] += rElec;
   ```

---

### Step 13 — Library: clamp and stats

**`clampNonNeg(arr)`** → returns clamp count (for bake report warning):
```js
let clamps = 0;
for (let i = 0; i < arr.length; i++) {
  if (arr[i] < 0) { arr[i] = 0; clamps++; }
}
return clamps;
```

**`computeStats(gasArr, elecArr, weather, timestamps, timestampMs, heatingOn, isAbsence, archetypeConfig, noiseConfig)`** → stats object (matching design doc §Outputs §2 schema):

- Annual totals: `gasKwh = gasArr.reduce((a,b) => a+b, 0)` (and same for elec)
- Targets from archetype config (need to add `annual_gas_target_kwh` and `annual_elec_target_kwh` fields to archetype configs — see Step 3)
- Deltas as percentage
- Daily aggregates: group by date, sum 48 HH
- Daily HDD: `max(0, 15.5 - mean(temp_c for day))` — use `HDD_BASE_TEMP` imported from `../../js/constants.js`
- R² (through-origin OLS on daily gas vs daily HDD, excluding absence days):
  - `beta = Σ(hdd_d × gasDay_d) / Σ(hdd_d²)` over non-absence non-summer days (Oct–Mar) where HDD > 0
  - `SS_res = Σ(gasDay_d - beta × hdd_d)²`; `SS_tot = Σ(gasDay_d - mean(gasDay_d))²`
  - `R2 = 1 - SS_res / SS_tot`
- Weekday/weekend elec ratio: `mean(elec on Mon-Fri days) / mean(elec on Sat-Sun days)`
- Summer/winter elec ratio: `mean(Jun-Aug daily elec) / mean(Dec-Feb daily elec)`
- Summer baseload: `median(Jun-Aug daily gas)`
- Holiday weeks injected: `sum(isAbsence) / 48 / noiseConfig.holiday_weeks.mean_duration_days`

Warnings array: add warning if `|gasDeltaPct| > 30` or if clamp count > 0.5% of HH.

---

### Step 14 — Library: output writing

**`writeOutputs(timestamps, gasArr, elecArr, stats, archetypeConfig, noiseConfigPath, opts)`**

`outputDir` is created with `fs.mkdirSync(opts.outputDir, { recursive: true })`.

**CSV** — written atomically (tmp file then rename per design doc):
```
datetime,gas_kwh,electricity_kwh
YYYY-MM-DD HH:MM,X.XXXX,X.XXXX
```
4 decimal places: `gas.toFixed(4)`, `elec.toFixed(4)`. Use `fs.writeFileSync` on a temp path then `fs.renameSync`.

**Stats JSON** — write `{slug}-stats.json` matching the design doc schema exactly, including `bake_timestamp` (ISO UTC, `new Date().toISOString()`), `prng_seed`, all `annual_totals`, `face_validity`, `input_parameters_for_audit`, `warnings`.

**Bake report MD** — write `{slug}-bake-report.md` including:
- Header block (slug, baked timestamp, config paths, output path)
- Annual totals table (fuel, synthesised, target, delta)
- Face validity table with expected ranges and pass/fail (ranges from design doc)
- Console snippet section (using current in-memory variable names — note in code comment that this may need updating if app.js structure changes)
- Next-step instructions

Expected ranges for face validity pass/fail:
- Daily gas vs HDD R²: [0.70, 0.97]
- Weekday/weekend elec ratio: [1.03, 1.20]
- Summer/winter elec ratio: [1.20, 1.80]
- Holiday weeks injected: [n_events - 1, n_events + 1] (tolerance of ±1 event)

---

### Step 15 — Library: optional runToolModules

**`runModuleSanityCheck(csvPath, archetypeConfig, opts)`** — only called when `opts.runToolModules: true`.

1. `const csvContent = fs.readFileSync(csvPath, 'utf8')`
2. Dynamic import: `const { parseCSV } = await import('../../js/data-ingestion.js')`. If import throws, log warning and return `{ error: 'import_failed' }`.
3. `const { records, errors } = parseCSV(csvContent)` — if errors non-empty, log and return
4. Build a minimal `heating` array from records (requires External data — skip M3/M5/M4 chain in V1 since the external data module is not importable). Instead, just verify `parseCSV` succeeds and record count matches expected (17,520). This is sufficient for TC5.
5. Write result to `{slug}-tool-modules.json`

Note: the full M3/M4/M5 chain requires External data (weather + wholesale prices), which would need network calls in the Node context. For V1, `runToolModules: true` is limited to verifying parseCSV succeeds. The design doc round-trip (§Option 8) is done via the manual upload path, not via this flag.

---

### Step 16 — Library: main `synthesise()` function

**`synthesise(archetypeConfigPath, noiseConfigPath, opts = {})`** → summary object

Orchestrates all steps. Default `opts`:
```js
{
  outputDir: `./bake-output/${slug}`,
  weatherCacheDir: './bake-input/weather',
  runToolModules: false,
  verbose: false,
}
```

Flow:
1. `readConfigs` → `{ archetype, noise }` (with noise_overrides merged)
2. `initialisePRNG` from `archetype.prng_seed` (or slug-hash fallback if seed missing)
3. `fetchWeatherCached` → `weather[]` (17,520 HH entries)
4. `generateTimestamps` → `{ timestamps, timestampMs }` (17,520)
5. `generateSchedule` → `heatingOn[]`
6. `generateHolidayWeeks` → `isAbsence[]`
7. `computeForwardModel` → `{ gasHeating, heatDemand }`
8. `computeHWandCooking` → `gasBaseload`
9. `computeElecBaseload` → `elec`
10. Combine: `gasArr[i] = gasHeating[i] + gasBaseload[i]`; `elecArr[i] = elec[i]`; override both to 0 if `isAbsence[i]`
11. `injectNoise` → modifies `gasArr`, `elecArr`
12. `clampNonNeg(gasArr)`; `clampNonNeg(elecArr)`
13. `computeStats` → `stats`
14. `writeOutputs` → writes CSV, stats JSON, bake report
15. Optionally `runModuleSanityCheck`
16. Return `{ slug, outputDir, stats, csvPath, statsPath, reportPath }`

---

### Step 17 — CLI wrapper

**`scripts/synthesise.mjs`** — thin wrapper around the library:

```js
// Usage: node scripts/synthesise.mjs --archetype <path> --noise-config <path> [--output <dir>] [--verbose] [--run-tool-modules]
import { synthesise } from './lib/synthesiser.mjs';
import { parseArgs } from 'node:util';   // Node 18+ built-in

const { values } = parseArgs({ options: {
  archetype:        { type: 'string' },
  'noise-config':   { type: 'string' },
  output:           { type: 'string' },
  verbose:          { type: 'boolean', default: false },
  'run-tool-modules': { type: 'boolean', default: false },
}});

if (!values.archetype || !values['noise-config']) {
  console.error('Usage: node scripts/synthesise.mjs --archetype <path> --noise-config <path>');
  process.exit(1);
}

try {
  const result = await synthesise(values.archetype, values['noise-config'], {
    outputDir:      values.output,
    verbose:        values.verbose,
    runToolModules: values['run-tool-modules'],
  });
  console.log(`\nBake complete: ${result.slug}`);
  console.log(`  CSV:    ${result.csvPath}`);
  console.log(`  Stats:  ${result.statsPath}`);
  console.log(`  Report: ${result.reportPath}`);
  console.log(`  Gas: ${result.stats.annual_totals.gas_kwh.toFixed(0)} kWh (${result.stats.annual_totals.gas_delta_pct > 0 ? '+' : ''}${result.stats.annual_totals.gas_delta_pct.toFixed(1)}%)`);
  console.log(`  Elec: ${result.stats.annual_totals.elec_kwh.toFixed(0)} kWh (${result.stats.annual_totals.elec_delta_pct > 0 ? '+' : ''}${result.stats.annual_totals.elec_delta_pct.toFixed(1)}%)`);
} catch (e) {
  console.error(`Bake failed: ${e.message}`);
  process.exit(1);
}
```

---

### Step 18 — Tests

**`test-synthesiser.mjs`** — follows the same pattern as existing `test-m*.mjs` files.

**TC1 — PRNG reproducibility**: Run `mulberry32(42)` twice; draw 1,000 values each run; verify every value matches. (Export `mulberry32` from the library, or inline it in the test.)

**TC2 — Forward model correctness**: With `htc=200, setpoint=19, T_outdoor=5, solar=0, boiler_efficiency=1.0, heating_on=true, absence=false`:
```
Expected: heat_loss = 200 × (19-5) × 0.5 × 0.001 = 1.4 kWh
          solar_gain = 0
          heat_demand = 1.4 kWh
          gas_heating = 1.4 / 1.0 = 1.4 kWh
```
Call the forward model with one HH and verify `gasHeating[0] === 1.4`.

**TC3 — Schedule jitter symmetric**: Generate 10,000 days worth of schedule with configured window `08:00–09:00`, jitter SD = 30 min. Extract the jitter-shifted start time for each day. Verify mean start time is within ±1 minute of 08:00.

**TC4 — Weather cache hit**: Call `fetchWeatherCached` twice with a real postcode + year window using the placeholder noise config. Verify the second call returns the same data without a second network request (check by verifying the cache file is written on first call and that timing of second call is <50ms, consistent with file read not network).

**TC5 — CSV format**: Run a minimal bake (with small synthetic weather: one day of data), then read the CSV back. Verify:
- Header row is exactly `datetime,gas_kwh,electricity_kwh`
- Data rows match `YYYY-MM-DD HH:MM,\d+\.\d{4},\d+\.\d{4}` pattern
- Row count matches expected (for the synthetic window)
- No null or undefined values

**TC6 — No nulls, all non-negative**: Run the synthesiser with a synthetic weather stub (avoid network in unit tests). Verify every `gas_kwh` and `electricity_kwh` value is a finite non-negative number.

**TC10 — Reproducibility**: Run the full bake for `modern-out-for-work.json` twice (network call skipped by pre-populating the weather cache). Verify the two output CSV files are byte-identical.

Note: TC4 requires a real network call (Postcodes.io + Open-Meteo). It is an integration test; mark it clearly and allow it to be skipped via `--offline` flag. TCs 1, 2, 3, 5, 6, 10 should work offline with stubbed/synthetic weather.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `data-ingestion.js` has browser globals that block Node.js import | Confirmed: no imports, no module-level browser globals. `parseCSV` uses only `Intl.DateTimeFormat` (standard ECMA). Import is safe. |
| Open-Meteo returns nulls or gaps in HH weather data | Forward-fill ≤2 HH gaps; abort with detailed error if larger (per design doc edge cases). |
| Sigma formula for AR(1) is an approximation — daily CV may not match target exactly | Flagged in design doc §Method `injectNoise`. TC9 (autocorrelation verification) is integration-level per design doc. Within scope of iteration loop, not hard gate here. |
| Box-Muller can return ±∞ if `u1 = 0` | Guard: `while (u1 === 0) u1 = prng()` before computing log. Mulberry32 produces uniform values that rarely hit 0 (2^-32 probability), but the guard is cheap. |
| `node:util` `parseArgs` availability | Available in Node 18+. Node v24 confirmed. |
| `data/demos/*.csv` in .gitignore | Step 1 adds explicit exception. Verify with `git check-ignore -v data/demos/test.csv` after Step 1. |
| Holiday absence windows may fail to find N non-overlapping slots if the window (days 14–330) is densely packed | Max 100 attempts per event, then move on. With 3 events × 5 days = 15 days out of 317, collisions are rare. Warn in bake report if fewer events injected than configured. |
| `computeStats` R² uses heating-season days only — what counts as heating season? | Use Oct–Mar (months 10, 11, 12, 1, 2, 3) to exclude summer. Filter to days where HDD > 0 to avoid div-by-zero in the through-origin regression. |
| scheduleConfig `kind: 'continuous'` has different structure from `twin_peak` | `generateSchedule` must handle both: `twin_peak` has separate weekday/weekend window arrays; `continuous` has a single all-day window. Both are in the JSON config as `weekday_windows` / `weekend_windows` — the `kind` field is informational. The loop works the same way for both. |

---

## Success criteria

- [ ] `node scripts/synthesise.mjs --archetype demo-configs/modern-out-for-work.json --noise-config test-data/noise-config.json` runs without errors and writes `bake-output/modern-out-for-work/modern-out-for-work.csv`, `modern-out-for-work-stats.json`, `modern-out-for-work-bake-report.md`
- [ ] Generated CSV has exactly the right row count for the configured time window (17,520 for full 2025), correct header `datetime,gas_kwh,electricity_kwh`, 4 decimal places, no nulls, no negatives
- [ ] Stats JSON includes all required top-level keys: `slug`, `bake_timestamp`, `prng_seed`, `annual_totals`, `face_validity`, `input_parameters_for_audit`, `warnings`
- [ ] Bake report includes annual totals table, face validity table with expected ranges, and console snippet
- [ ] `node test-synthesiser.mjs` — TCs 1, 2, 3, 5, 6, 10 pass without network access
- [ ] TC2 hand-verify: `gasHeating = 1.4 kWh` for the specified inputs
- [ ] Second run with same inputs (warm weather cache) produces byte-identical CSV (TC10)
- [ ] `.gitignore` updated: `git status` after `git add bake-output/` shows it excluded; `git status` after writing a CSV to `data/demos/` shows it included
- [ ] 4 demo-config JSON files pass `readConfigs` validation without errors

---

## Implementation Deviations

*To be filled in after implementation.*

<!--
The Design Review section is appended by the Opus reviewer when the plan is
amended. See `coding/agents/plan-reviewer.md` for the review record template
and the post-review Status values.

Status values (canonical, from plan-reviewer.md):
- Awaiting review — Opus architect review pending.    (planner sets)
- ✅ Approved — yyyy-mm-dd. Implementation may begin.  (reviewer sets)
- ⚠ Approved with edits — yyyy-mm-dd. Implementation may begin [once <prereq>].
- ⏸ Blocked — yyyy-mm-dd. See Design Review below; rewrite required.
- Implemented — yyyy-mm-dd, commit <hash>.            (implementer sets)
-->
