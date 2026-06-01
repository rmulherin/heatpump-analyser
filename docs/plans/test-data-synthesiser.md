# Test Data Synthesiser — Implementation Plan

**Date:** 2026-06-01
**Status:** ✅ Approved — 2026-06-01. Implementation may begin.

---

## Task description

Implement the test-data synthesiser as a Node.js library + CLI script that produces per-archetype demo consumption CSVs for the heatpump analyser tool. The library runs a building-physics forward model against Open-Meteo historical weather (cached), applies schedule jitter, holiday-week injection, parametric HW/cooking pulses, and calibrated AR(1) + multiplicative noise, then writes a CSV (17,520 HH rows), a stats JSON, and a markdown bake report. A thin CLI wrapper (`scripts/synthesise.mjs`) exposes the library to Opus's iteration loop. The four archetype config files and a vendored copy of the real `noise-config.json` (from praxis-claude-hub) are also created as part of this plan.

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
| CREATE | `test-data/noise-config.json` | Vendored copy of real calibration output from praxis-claude-hub (no PII — derived stats only) |
| CREATE | `test-synthesiser.mjs` | Unit tests TCs 1–3, 5–7, TC10 |

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

### Step 2 — Vendor real noise-config.json from praxis-claude-hub

The real calibrated noise config lives at:
```
~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/test-data/noise-config.json
```

**Do not write a placeholder.** Copy this file verbatim to `test-data/noise-config.json` in the tool repo. It is committable — the file contains only derived statistics with no consumption values (strategy §V1 Step 0c contract). The `.gitignore` exception added in Step 1 (`!test-data/noise-config.json`) allows it to be tracked.

The real file does **not** contain `cooking_event_time_distribution.*` fields — those were design-doc placeholders that were never added to the calibration output. The synthesiser uses hardcoded pulse-timing defaults instead (see Step 10 and H1 fix). The real calibrated values are:

| Field | Real value |
|-------|-----------|
| `behavioural_noise.hh_residual_autocorr_lag1` | 0.735 |
| `behavioural_noise.daily_residual_cv` | 0.354 |
| `schedule_jitter.boiler_start_sd_minutes` | 15 |
| `holiday_weeks.events_per_year` | 7 |
| `holiday_weeks.mean_duration_days` | 7.6 |

These values, not the illustrative ones in the design doc, drive all bakes.

---

### Step 3 — Demo archetype config files

Write four JSON files in `demo-configs/` using the starting values from strategy §E. Each includes `noise_overrides` with the per-archetype `hh_residual_autocorr_lag1` value (strategy §E final column) and `weekday_weekend_elec_ratio` (per-archetype — strategy §C: not transferable from calibration household).

Per-archetype `noise_overrides` values and reasoning:

| Archetype | autocorr | ww_ratio | ww_ratio reasoning |
|-----------|----------|----------|--------------------|
| modern-out-for-work | 0.55 | **0.85** | Out all day on weekdays → weekday elec is lower than weekend. Opposite occupancy to the calibration household (WFH). Ratio < 1.0. |
| average-in-all-day | 0.75 | 1.15 | Continuous occupancy; mild weekday/weekend difference. |
| small-and-efficient | 0.70 | 1.06 | Single occupant; minimal weekday/weekend variation. |
| big-old-draughty | 0.65 | 1.12 | Multi-occupant; weekend is busier than weekday but less than calibration household. |

Each config file includes all fields required by `readConfigs` validation (see Step 4): `slug`, `label`, `bio`, `display_order`, `archetype_source`, `building`, `schedule`, `baseload`, `location`, `time_window`, `noise_overrides`, `prng_seed`, **plus** `annual_gas_target_kwh` and `annual_elec_target_kwh` (used by `computeStats` and TC7).

Annual targets per strategy §E:

| Archetype | annual_gas_target_kwh | annual_elec_target_kwh |
|-----------|----------------------|----------------------|
| modern-out-for-work | 7237 | 1946 |
| average-in-all-day | 10236 | 2586 |
| small-and-efficient | 4266 | 1555 |
| big-old-draughty | 17239 | 3089 |

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
  - Archetype: `slug`, `label`, `building.htc_w_per_k`, `building.thermal_mass_kj_per_k`, `building.boiler_efficiency`, `building.solar_aperture_m2`, `building.setpoint_c`, `schedule.kind`, `baseload.gas_hot_water_kwh_per_day`, `baseload.gas_cooking_kwh_per_day`, `baseload.elec_baseload_kwh_per_day`, `baseload.elec_appliance_events_per_week`, `location.postcode`, `time_window.start`, `time_window.end`, `prng_seed`, `annual_gas_target_kwh`, `annual_elec_target_kwh`
  - Noise: `measurement_noise.smart_meter_relative_sd`, `behavioural_noise.hh_residual_autocorr_lag1`, `behavioural_noise.daily_residual_cv`, `schedule_jitter.boiler_start_sd_minutes`, `holiday_weeks.events_per_year`, `holiday_weeks.mean_duration_days`
  - Note: `cooking_event_time_distribution.*` fields are **not** in the real noise config and are **not** validated. HW/cooking pulse timing uses hardcoded defaults (see Step 10).
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

Pulse-timing defaults (hardcoded — `cooking_event_time_distribution.*` fields are not in the real noise config):
```js
const HW_MORNING_PEAK_MINS = 7 * 60;    // 07:00 UTC
const HW_MORNING_SD_MINS   = 0.6 * 60;  // 36 min SD
const HW_EVENING_PEAK_MINS = 18 * 60;   // 18:00 UTC
const HW_EVENING_SD_MINS   = 1.1 * 60;  // 66 min SD
const HW_MORNING_FRACTION  = 0.35;
```

Main function: per day:
1. Draw daily residual: `dailyFactor = 1 + boxMuller(prng) × noiseConfig.behavioural_noise.daily_residual_cv`, clamped to [0.1, 3.0]
2. Total HW+cooking for this day = `(archetypeConfig.baseload.gas_hot_water_kwh_per_day + archetypeConfig.baseload.gas_cooking_kwh_per_day) × dailyFactor`
3. Split into morning (HW_MORNING_FRACTION) and evening (1 − HW_MORNING_FRACTION)
4. Jitter morning centre: `centre = HW_MORNING_PEAK_MINS + boxMuller(prng) × HW_MORNING_SD_MINS`, clipped to [0, 1440]
5. Same for evening using `HW_EVENING_PEAK_MINS` and `HW_EVENING_SD_MINS`
6. Apply `gaussianPulse` for morning and evening, add to output array

---

### Step 11 — Library: electricity baseload

**`computeElecBaseload(archetypeConfig, timestamps, timestampMs, weather, noiseConfig, prng)`** → `Float64Array`

Named constants at top of library (not inlined):
```js
const ELEC_NIGHT_FACTOR   = 0.6;   // 02:00–08:00 UTC occupancy multiplier
const ELEC_EVENING_FACTOR = 1.3;   // 18:00–22:00 UTC occupancy multiplier
const ELEC_LIGHTING_FRACTION = 0.35;      // fraction of base kWh that is lighting
const SOLAR_LIGHTING_THRESHOLD_WM2 = 50;  // solar irradiance above which lights off
```

Baseload split:
- `lightingKwhPerHh  = (elec_baseload_kwh_per_day × ELEC_LIGHTING_FRACTION) / 48`
- `otherKwhPerHh     = (elec_baseload_kwh_per_day × (1 − ELEC_LIGHTING_FRACTION)) / 48`

Per HH `i`:
1. **Lighting component** (solar/daylight modulated):
   ```js
   const solarFactor = 1 - Math.min(1, weather[i].solar_w_m2 / SOLAR_LIGHTING_THRESHOLD_WM2);
   lighting[i] = lightingKwhPerHh * solarFactor;
   ```
   Lights are fully on when dark (solar = 0), off when irradiance ≥ 50 W/m². This introduces realistic winter/summer seasonality: winter sees ~35% more lighting load than summer.

2. **Other load** (occupancy-modulated by time of day):
   ```js
   const hour = new Date(timestampMs[i]).getUTCHours();
   const occFactor = (hour >= 2 && hour < 8)  ? ELEC_NIGHT_FACTOR
                   : (hour >= 18 && hour < 22) ? ELEC_EVENING_FACTOR
                   : 1.0;
   other[i] = otherKwhPerHh * occFactor;
   ```

3. Combine: `elec[i] = lighting[i] + other[i]`

4. **Weekend uplift**: For HH on Sat/Sun, multiply `elec[i]` by `effectiveWwRatio` = `archetypeConfig.noise_overrides?.weekday_weekend_elec_ratio ?? noiseConfig.behavioural_noise.weekday_weekend_elec_ratio`.

5. **Discrete appliance events**: per week, sample `elec_appliance_events_per_week` event-start HH indices uniformly from the full week; each event delivers `0.5 + prng() × 1.5` kWh spread over `1 + Math.round(prng())` consecutive HH. Add to the relevant HH indices.

Note: `weather` array is now a required parameter (passed from the main `synthesise()` flow alongside `timestampMs`).

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
9. `computeElecBaseload` (passes `weather` array for solar modulation) → `elec`
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

**TC4 — Weather cache hit**: Call `fetchWeatherCached` twice with a real postcode + year window (integration test — requires network on first call). Verify the cache file is written after the first call and that the second call completes in <50ms (file read, not network round-trip). Mark as integration test; allow skip via `--offline` flag.

**TC5 — CSV format**: Run a minimal bake (with small synthetic weather: one day of data), then read the CSV back. Verify:
- Header row is exactly `datetime,gas_kwh,electricity_kwh`
- Data rows match `YYYY-MM-DD HH:MM,\d+\.\d{4},\d+\.\d{4}` pattern
- Row count matches expected (for the synthetic window)
- No null or undefined values

**TC6 — No nulls, all non-negative**: Run the synthesiser with a synthetic weather stub (avoid network in unit tests). Verify every `gas_kwh` and `electricity_kwh` value is a finite non-negative number.

**TC7 — Annual totals within ±20% of target**: Run the synthesiser with a pre-populated weather cache (no network). Read `{slug}-stats.json`. Verify `|gas_delta_pct| ≤ 20` and `|elec_delta_pct| ≤ 20` for all four archetypes. Catches forward-model bugs (wrong HTC unit, wrong time factor, etc.) before any manual upload step.

**TC10 — Reproducibility**: Run the full bake for `modern-out-for-work.json` twice (network call skipped by pre-populating the weather cache). Verify the two output CSV files are byte-identical.

Note: TC4 requires a real network call (Postcodes.io + Open-Meteo). It is an integration test; allow skip via `--offline` flag. TCs 1, 2, 3, 5, 6, 7, 10 should work offline with pre-cached weather.

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
| Holiday absence windows may fail to find N non-overlapping slots if the window (days 14–330) is densely packed | Real values: 7 events × 7.6 days ≈ 53 absence days out of 317 available (~17% density). Collisions are more likely than the design-doc illustrative values suggested. 100-attempt limit is kept; synthesiser warns in bake report if fewer events injected than configured. At 17% density, 7 non-overlapping placements are feasible but may require several retries. |
| `computeStats` R² uses heating-season days only — what counts as heating season? | Use Oct–Mar (months 10, 11, 12, 1, 2, 3) to exclude summer. Filter to days where HDD > 0 to avoid div-by-zero in the through-origin regression. |
| scheduleConfig `kind: 'continuous'` has different structure from `twin_peak` | `generateSchedule` must handle both: `twin_peak` has separate weekday/weekend window arrays; `continuous` has a single all-day window. Both are in the JSON config as `weekday_windows` / `weekend_windows` — the `kind` field is informational. The loop works the same way for both. |

---

## Success criteria

- [ ] `node scripts/synthesise.mjs --archetype demo-configs/modern-out-for-work.json --noise-config test-data/noise-config.json` runs without errors and writes `bake-output/modern-out-for-work/modern-out-for-work.csv`, `modern-out-for-work-stats.json`, `modern-out-for-work-bake-report.md`
- [ ] Generated CSV has exactly the right row count for the configured time window (17,520 for full 2025), correct header `datetime,gas_kwh,electricity_kwh`, 4 decimal places, no nulls, no negatives
- [ ] Stats JSON includes all required top-level keys: `slug`, `bake_timestamp`, `prng_seed`, `annual_totals`, `face_validity`, `input_parameters_for_audit`, `warnings`
- [ ] Bake report includes annual totals table, face validity table with expected ranges, and console snippet
- [ ] `node test-synthesiser.mjs` — TCs 1, 2, 3, 5, 6, 7, 10 pass without network access (pre-cached weather)
- [ ] TC2 hand-verify: `gasHeating = 1.4 kWh` for the specified inputs
- [ ] Second run with same inputs (warm weather cache) produces byte-identical CSV (TC10)
- [ ] `.gitignore` updated: `git status` after `git add bake-output/` shows it excluded; `git status` after writing a CSV to `data/demos/` shows it included
- [ ] 4 demo-config JSON files pass `readConfigs` validation without errors

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-06-01
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/test-data-synthesiser.md`
**Parent strategy:** `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/test-data-strategy.md`

### Context

First-cut plan written against the design doc immediately after the design was committed. Review caught one critical issue (stale placeholder noise-config) and three high-severity issues (validation schema mismatch, missing solar/lighting modulation, wrong weekday/weekend ratio for one archetype). Two medium and one low rounded out the findings.

### Required changes for implementation

**1. C1 — Vendor the real noise-config instead of writing a placeholder.**
Step 2 was writing illustrative values from the design-doc draft (autocorr 0.42, CV 0.11, etc.). The real calibrated values from praxis-hub Step 0c (autocorr 0.735, CV 0.354, boiler SD 15, 7 events × 7.6 days) must be used.

**2. H1 — Remove `cooking_event_time_distribution.*` from `readConfigs` validation.**
The real noise-config doesn't contain these fields. Hardcode the pulse-timing constants inside the HW/cooking subroutine instead.

**3. H2 — Add solar/daylight modulation to elec lighting load.**
Without it, demos will have no seasonal elec variation and the tool's M3 Step H will report 0 cold-weather uplift — missing a real feature (3-16% in actual households).

**4. H3 — Fix weekday/weekend ratio for modern-out-for-work.**
1.08 (matching calibration household) was wrong reasoning — calibration is WFH (opposite of "out for work"). Set to ~0.85 (weekday < weekend).

**5. M1 — Add `annual_gas_target_kwh` / `annual_elec_target_kwh` to archetype config schema.**
Referenced by Step 13 stats but not specified in Step 3 schema.

**6. M2 — Add TC7 (annual totals within ±20% of target).**
Useful offline smoke test for forward-model bugs.

**7. L1 — Name occupancy/lighting factors as module constants.**
Step 11's 0.6/1.3 should be named, not inlined.

### Resolution of review changes

1. **C1** — ✅ Resolved. Step 2 rewritten to vendor real noise-config from praxis-hub with real values documented in a table.
2. **H1** — ✅ Resolved. `cooking_event_time_distribution.*` removed from required-noise-fields; Step 10 uses hardcoded `HW_MORNING_PEAK_MINS = 7×60`, `HW_MORNING_SD_MINS = 0.6×60`, `HW_EVENING_PEAK_MINS = 18×60`, `HW_EVENING_SD_MINS = 1.1×60`, `HW_MORNING_FRACTION = 0.35`.
3. **H2** — ✅ Resolved. Step 11 split baseload into lighting (35%, solar-modulated via `1 - min(1, solar/SOLAR_LIGHTING_THRESHOLD_WM2)` with threshold = 50 W/m²) and other (65%, occupancy-modulated). Weather array added as parameter to `computeElecBaseload`.
4. **H3** — ✅ Resolved. modern-out-for-work `weekday_weekend_elec_ratio` set to 0.85 with explicit reasoning in per-archetype table.
5. **M1** — ✅ Resolved. `annual_gas_target_kwh` and `annual_elec_target_kwh` added to required archetype-config fields + per-archetype values listed in a new table.
6. **M2** — ✅ Resolved. TC7 added to Step 18 test list; included in offline-runnable success criteria.
7. **L1** — ✅ Resolved. `ELEC_NIGHT_FACTOR`, `ELEC_EVENING_FACTOR`, `ELEC_LIGHTING_FRACTION`, `SOLAR_LIGHTING_THRESHOLD_WM2` defined as named module constants in Step 11.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 1 | ✅ resolved |
| HIGH     | 3 | ✅ resolved |
| MEDIUM   | 2 | ✅ resolved |
| LOW      | 1 | ✅ resolved |

Verdict: ✅ APPROVED — all seven findings addressed in the revised plan body.

### Note for implementer (not blocking)

The lighting model in Step 11 has no occupancy gate — winter midday lighting will be on even when the demo's occupants would be out at work. Realistic enough for v1 (M3 will detect the seasonality and report cold-weather uplift correctly). Refine in iteration loop if face validity demands it. Out of scope for first implementation.

---

## Approval

**Status:** ✅ Approved — 2026-06-01
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** Real noise-config values are authoritative (not design-doc illustrative placeholders); lighting seasonality drives elec cold-weather uplift; modern-out-for-work has weekday < weekend (opposite of calibration household pattern).

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
