# Module 5 — Thermal Character

**Date:** 2026-04-26
**Status:** Awaiting approval — review via claude.ai before implementation begins.

---

## Task description

Implement `js/thermal-character.js` — the thermal character module that infers setpoint
temperature, building thermal mass, time constant, and per-HH occupancy weights from the
observed heating pattern. Outputs feed the pre-heating optimiser (M7) and the "Your Home"
building profile panel (M10). All values are inferred from existing M1–M4 data; no new
API calls required.

Wire it into `app.js` and add a results card to `index.html`, following the M4 pattern.

Design doc: `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/thermal-character.md`

---

## Research findings

**Upstream data contracts confirmed against live code:**

- `baseloadResult.heating[]` — `{ timestamp, heating_kwh, baseload_kwh, is_absence }` per
  HH period. This is the exact shape the design doc specifies. `baseloadResult.baseload_metadata.method`
  is the field to check for `'no-gas'`.

- `getHeatLossResult()` — returns `{ htc_w_per_k, boiler_efficiency_used, degree_day_base_c,
  validation_status, ... }`. `htc_w_per_k` is null when M4 had insufficient data.
  `degree_day_base_c` is present but not used in M5's algorithm.

- `externalResult.external[]` — parallel to `heating[]` (same index = same HH period).
  Contains `temp_c` (null when weather data missing).

**No external libraries required.** All processing is sequential HH-array operations and
arithmetic. UTC day grouping uses `timestamp.slice(0, 10)` — no Luxon needed.

**Reuse patterns:**
- State management: `let _result = null; export function set/get ThermalCharacterResult(r)`
  — identical pattern to M4 (`setHeatLossResult` / `getHeatLossResult`).
- Constants block at module top — same style as M4's `HEAT_LOSS_CONFIG`.
- Day index map building: same approach as M4 — iterate `heating[]`, group by
  `timestamp.slice(0, 10)`.

**Algorithm — no existing library:** the iterative warm-up energy approach described in the
design doc is custom. 3-iteration convergence for τ is sufficient (design doc justified).
No concerns about convergence instability in the UK τ range (1–40 h).

**Algorithm ambiguity resolved (warm-up phase boundary):** the design doc says
`warmup_hh_count = number of HH periods from restart until settled` and the `settled` HH
is `the first HH where heating_kwh ≤ 1.2 × steady_state`. The warm-up energy sum includes
all HH periods from (and including) the first restart HH up to (but NOT including) the
settled HH. Rationale: the settled HH is already at or below steady state; the mass has
been warmed by the time this HH runs. Including it would double-count steady-state loss
energy as warm-up energy.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/thermal-character.js` | Thermal character computation module |
| MODIFY | `js/app.js` | Import, orchestration, UI rendering |
| MODIFY | `index.html` | Wall construction input + thermal character results card |

---

## Implementation steps

### Step 1 — Create `js/thermal-character.js`

#### 1a. Module constants

```javascript
const TC_CONFIG = {
  SUSTAINED_BLOCK_MIN_HH:   4,     // ≥4 consecutive HH with heating > 0 for setpoint
  SETPOINT_SKIP_INITIAL_HH: 2,     // skip first 2 HH of each block (transient)
  SETPOINT_CLIP_MIN_C:      14,    // discard setpoint estimates outside [14, 25]
  SETPOINT_CLIP_MAX_C:      25,
  SETPOINT_MIN_HH:          20,    // minimum HH periods for reliable median
  SETPOINT_LOW_WARN_C:      16,    // warn if inferred setpoint below this
  SETPOINT_HIGH_WARN_C:     23,    // warn if inferred setpoint above this
  OFF_PERIOD_MIN_HH:        4,     // ≥4 consecutive HH < threshold for off period
  OFF_PERIOD_THRESHOLD_KWH: 0.05,  // HH < this = boiler off
  WINTER_TEMP_MAX_C:        10,    // only warm-up events when daily mean < 10°C
  SETTLED_RATIO:            1.2,   // ≤ 1.2× steady-state counts as settled
  MIN_EVENTS_FOR_MASS:      5,
  OUTLIER_PCTILE_LOW:       0.05,  // discard below 5th percentile of C_estimates
  OUTLIER_PCTILE_HIGH:      0.95,
  TAU_SEED_HOURS:           5.0,
  ITERATIONS:               3,
  MIN_DAYS_OCCUPANCY:       14,    // minimum non-absence days for occupancy weights
  MASS_RATING_MEDIUM_KJ:    6000,
  MASS_RATING_HIGH_KJ:      15000,
  MASS_RATING_VERY_HIGH_KJ: 30000,
  TAU_HIGH_WARN_HOURS:      30,
  TAU_LOW_WARN_HOURS:       2,
};

const WALL_CONSTRUCTION_RANGES = {
  solid_masonry: { min: 15000, max: 45000 },
  cavity_wall:   { min:  6000, max: 20000 },
  timber_frame:  { min:  2000, max:  8000 },
};
```

#### 1b. Helper — `median(arr)`

Sort a numeric array, return median. Returns null if arr is empty.

#### 1c. Helper — `percentile(sortedArr, p)`

Given a pre-sorted array, return the value at fractional position `p`. Used for 5th/95th
percentile outlier filter.

#### 1d. `buildDaySummaries(heating, external)`

Returns a `Map<dateString, { dailyMeanTempC, dailyHeatingKwh, isAbsence, isHeatingDay, hhIndices }>`.

For each calendar day (UTC), group `heating[]` indices by `heating[i].timestamp.slice(0, 10)`.
Only include days where all 48 HH are present. A day is whole only if `hhIndices.length === 48`.

Per day:
- `dailyMeanTempC` = mean of `external[i].temp_c` over the 48 HH (skip nulls; null if all null)
- `dailyHeatingKwh` = sum of `heating[i].heating_kwh` over 48 HH (skip nulls)
- `isAbsence` = `heating[i].is_absence === true` for ANY HH in the day
- `isHeatingDay` = `dailyHeatingKwh > 0.5`
- `hhIndices` = the 48 HH index positions in the original `heating[]` array

#### 1e. `computeOccupancyWeights(heating, daySummaries)`

Build a `Map<dateString, hhIndices>` from `daySummaries`. Only use non-absence whole days.

Count total non-absence whole days (`countTotal`). If `countTotal < TC_CONFIG.MIN_DAYS_OCCUPANCY`:
return `{ occupancy_weights: null, warning: "Not enough data to estimate heating pattern." }`.

For slot `h = 0..47`:
```
countHeated[h] = count of days where heating[dayStart + h].heating_kwh > 0
occupancy_weights[h] = countHeated[h] / countTotal
```

No smoothing (design doc §Step 2 explicitly prohibits it).

#### 1f. `estimateSetpoint(heating, external, htc, eta)`

Scans `heating[]` for sustained blocks: ≥`TC_CONFIG.SUSTAINED_BLOCK_MIN_HH` consecutive HH
where `heating_kwh > 0`. (Use index-contiguous scan — consecutive indices, not calendar days.)

For each sustained block, skip the first `SETPOINT_SKIP_INITIAL_HH` HH. For remaining HH in block:
- Skip if `is_absence === true` for that day
- Skip if `external[i].temp_c === null`
- Compute `setpoint_estimate = temp_c + (heating_kwh × 2000 × eta) / htc`
- Skip if outside `[SETPOINT_CLIP_MIN_C, SETPOINT_CLIP_MAX_C]`

Collect all valid estimates. Apply confidence gate:
- `< MIN_SETPOINT_HH (20)` → `setpoint_c = null`, warning
- `[20, 49]` → proceed, add moderate-confidence warning
- `≥ 50` → proceed, no warning

Plausibility warnings if setpoint outside `[SETPOINT_LOW_WARN_C, SETPOINT_HIGH_WARN_C]`.

Returns `{ setpoint_c, setpoint_days_used, warnings }`.

#### 1g. `estimateThermalMass(heating, external, daySummaries, htc, eta, setpointC)`

Requires `setpointC` non-null. Returns `{ thermal_mass_kj_per_k, events_used, warnings }`.

**Event detection:** scan `heating[]` linearly for off periods (≥`OFF_PERIOD_MIN_HH`
consecutive HH with `heating_kwh < OFF_PERIOD_THRESHOLD_KWH`). For each off period:
- Find the start of heating resumption immediately after (first HH with `heating_kwh ≥ OFF_PERIOD_THRESHOLD_KWH`)
- Look up the day's `dailyMeanTempC` for the off-period day(s) — skip if null or `≥ WINTER_TEMP_MAX_C`
- Skip if any HH in the off period or warm-up phase has `is_absence === true`
- This is a valid warm-up event candidate

**Track separately:** whether any off-period sequences were found at all (for the "constant
overnight heating" warning).

**Iterative C estimation (3 iterations):**

```
τ_seed = TC_CONFIG.TAU_SEED_HOURS

for iter in 1..3:
  C_estimates = []
  for each valid event:
    t_off_hours      = (off period HH count) × 0.5
    T_outdoor_off    = mean(external[i].temp_c for non-null HH in off period)
    T_at_restart     = T_outdoor_off + (setpointC − T_outdoor_off) × exp(−t_off_hours / τ_seed)

    Scan warm-up phase from restart HH forward:
      For each HH j from restart:
        ss_kwh = htc × (setpointC − external[j].temp_c) × 0.5 / (eta × 1000)
        if heating[j].heating_kwh ≤ 1.2 × ss_kwh: this is the settled HH — stop (do NOT include)
        else: include in warm-up sum

      E_warmup_kwh = sum(heating_kwh over warm-up HH, not including settled)
      warmup_hh_count = count of those HH

    E_warmup_kj  = E_warmup_kwh × 3600
    T_mean_warmup    = (T_at_restart + setpointC) / 2
    T_outdoor_warmup = mean(external[i].temp_c over warm-up HH, skip nulls)
    t_warmup_hours   = warmup_hh_count × 0.5
    E_heatloss_kj = htc × (T_mean_warmup − T_outdoor_warmup) × t_warmup_hours × 3.6

    E_net_kj = E_warmup_kj × eta − E_heatloss_kj
    delta_T   = setpointC − T_at_restart

    if E_net_kj > 0 AND delta_T > 0.5:
      C_estimates.push(E_net_kj / delta_T)

  if C_estimates.length === 0: break (no events — handled below)
  C_median = median(C_estimates)
  τ_seed   = C_median / (htc × 3.6)
```

After 3 iterations, apply 5th–95th percentile outlier filter to the final `C_estimates`.
`thermal_mass_kj_per_k = median(filtered)`.

If `thermal_mass_events_used < TC_CONFIG.MIN_EVENTS_FOR_MASS`:
- If zero off-periods were ever found: warn "Heating appears to run continuously overnight
  — not enough cold-soak data to estimate thermal mass."
- Otherwise: warn "Not enough overnight cold-soak events to estimate thermal mass. More
  winter data needed."
- Return `thermal_mass_kj_per_k = null`.

#### 1h. `computeRatingAndTimeConstant(thermalMassKjPerK, htcWPerK)`

```
time_constant_hours = thermal_mass_kj_per_k / (htc_w_per_k × 3.6)  // if both non-null

rating thresholds (< 6000 → "low", 6000–14999 → "medium", 15000–29999 → "high", ≥ 30000 → "very_high")
```

Time constant warnings: `> TAU_HIGH_WARN_HOURS` or `< TAU_LOW_WARN_HOURS`.

#### 1i. `checkWallConstruction(thermalMassKjPerK, wallConstructionType, warnings)`

If `wallConstructionType` non-null and `thermalMassKjPerK` non-null: check against
`WALL_CONSTRUCTION_RANGES`. If outside range, push warning with measured and expected
range values.

#### 1j. `computeValidationStatus(setpointC, thermalMassKjPerK, setpointDaysUsed, eventsUsed)`

```
htc null → "no_htc"           (checked before calling this)
no-gas   → "no_gas"           (checked before calling this)
setpoint non-null AND mass non-null AND setpointDaysUsed >= 50 AND eventsUsed >= 10 → "good"
setpoint non-null AND mass non-null (lower counts) → "acceptable"
setpoint non-null AND mass null (or vice versa) → "acceptable"  (with warnings already appended)
either null due to insufficient data → "insufficient_data"
```

#### 1k. Main export `estimateThermalCharacter(heating, external, heatLoss, baseloadMethod, wallConstructionType)`

Parameters:
- `heating` — from `getBaseloadResult().heating`
- `external` — from `getExternalResult().external`
- `heatLoss` — from `getHeatLossResult()`
- `baseloadMethod` — `getBaseloadResult().baseload_metadata.method`
- `wallConstructionType` — from UI dropdown (or `null`)

Steps:
1. If `baseloadMethod === 'no-gas'`: return null result with `validation_status = "no_gas"`.
2. If `heatLoss === null || heatLoss.htc_w_per_k === null`: return null result with
   `validation_status = "no_htc"`.
3. Extract `htc = heatLoss.htc_w_per_k`, `eta = heatLoss.boiler_efficiency_used`.
4. `daySummaries = buildDaySummaries(heating, external)`.
5. `{ occupancy_weights, warning: owWarn } = computeOccupancyWeights(heating, daySummaries)`.
6. `{ setpoint_c, setpoint_days_used, warnings: spWarns } = estimateSetpoint(heating, external, htc, eta)`.
7. If `setpoint_c !== null`:
   `{ thermal_mass_kj_per_k, events_used, warnings: massWarns } = estimateThermalMass(heating, external, daySummaries, htc, eta, setpoint_c)`.
   Else: `thermal_mass_kj_per_k = null, events_used = 0, massWarns = []`.
8. `{ time_constant_hours, thermal_mass_rating, tcWarns } = computeRatingAndTimeConstant(thermal_mass_kj_per_k, htc)`.
9. `checkWallConstruction(thermal_mass_kj_per_k, wallConstructionType, allWarnings)`.
10. `validation_status = computeValidationStatus(...)`.
11. Assemble and return the output object per design doc spec.

#### 1l. State management

```javascript
let _thermalCharacterResult = null;
export function setThermalCharacterResult(r) { _thermalCharacterResult = r; }
export function getThermalCharacterResult()   { return _thermalCharacterResult; }
```

---

### Step 2 — Modify `index.html`

#### 2a. Wall construction input (inside the heat loss card optional-parameters section)

Add a `<select>` for wall construction type near the floor-area input:

```html
<label for="wall-construction">Wall construction (optional):</label>
<select id="wall-construction">
  <option value="">Unknown</option>
  <option value="solid_masonry">Solid masonry (pre-1920s brick / stone)</option>
  <option value="cavity_wall">Cavity wall (1930s–2000s brick)</option>
  <option value="timber_frame">Timber frame</option>
</select>
```

#### 2b. Thermal character results card

Add below the heat-loss card:

```html
<div id="thermal-char-card" class="card hidden">
  <h2>Thermal Character</h2>
  <div id="thermal-char-results" class="hidden">
    <div id="thermal-char-status"></div>
    <dl id="thermal-char-summary"></dl>
  </div>
  <button id="btn-recalculate-thermal-char">Recalculate with updated construction type</button>
</div>
```

---

### Step 3 — Modify `js/app.js`

#### 3a. Import

```javascript
import {
  estimateThermalCharacter,
  setThermalCharacterResult,
  getThermalCharacterResult,
} from './thermal-character.js';
```

#### 3b. Label map

```javascript
const THERMAL_MASS_RATING_LABELS = {
  low:       'Low (lightweight — timber frame or thin construction)',
  medium:    'Medium (typical cavity-brick semi-detached)',
  high:      'High (solid brick — 1930s–1950s terrace or semi)',
  very_high: 'Very high (solid stone, large Victorian, concrete)',
};
```

#### 3c. DOM refs

```javascript
const thermalCharCard         = document.getElementById('thermal-char-card');
const thermalCharResults      = document.getElementById('thermal-char-results');
const thermalCharStatus       = document.getElementById('thermal-char-status');
const thermalCharSummary      = document.getElementById('thermal-char-summary');
const wallConstructionInput   = document.getElementById('wall-construction');
const btnRecalcThermalChar    = document.getElementById('btn-recalculate-thermal-char');
```

#### 3d. `displayThermalCharacterResults(result)` function

Clear `thermalCharStatus` and `thermalCharSummary`. Show `thermalCharResults` (remove
hidden class). Handle each `validation_status`:

- `"no_htc"`: info message "Heat loss data not available — thermal character estimation
  requires a heat loss result."
- `"no_gas"`: info message "No gas supply — thermal character estimation requires gas data."
- `"insufficient_data"`: show warnings, no numeric table.
- `"good"` / `"acceptable"` / `"low_confidence"`: render numeric table plus warnings.

Numeric rows to render (skip row if value is null):
- Inferred setpoint
- Thermal mass
- Time constant
- Thermal mass rating
- Occupancy pattern: "Available (feeds pre-heating optimiser)" or "Insufficient data"
- HH periods used in setpoint fit
- Warm-up events used
- Validation status

Warnings: render each as a `status-msg warning` div in `thermalCharStatus`.

#### 3e. `runThermalCharacter(showProgressFn, showStatusFn)` function

```javascript
async function runThermalCharacter(showProgressFn, showStatusFn) {
  const baseloadResult = getBaseloadResult();
  const externalResult = getExternalResult();
  const heatLossResult = getHeatLossResult();
  if (!baseloadResult || !externalResult) return;

  showProgressFn('Estimating thermal character…');

  const wallConstruction = wallConstructionInput.value || null;

  let result;
  try {
    result = estimateThermalCharacter(
      baseloadResult.heating,
      externalResult.external,
      heatLossResult,
      baseloadResult.baseload_metadata.method,
      wallConstruction,
    );
  } catch (err) {
    showStatusFn('Thermal character estimation failed: ' + err.message, 'error');
    console.error('runThermalCharacter error:', err);
    return;
  }

  setThermalCharacterResult(result);
  thermalCharCard.classList.remove('hidden');
  displayThermalCharacterResults(result);
}
```

#### 3f. Wire into both pipelines

In `continueWithProperty()`: add after `runHeatLoss(...)` call:
```javascript
// Step 12: Trigger Module 5 — Thermal Character
await runThermalCharacter(
  (text) => showProgress(text, undefined),
  (msg, type) => showStatus(msg, type)
);
```

In `btnCsvAnalyse` handler: same, after `runHeatLoss(...)`.

#### 3g. Recalculate button

```javascript
btnRecalcThermalChar.addEventListener('click', async () => {
  btnRecalcThermalChar.disabled = true;
  thermalCharStatus.innerHTML = '';
  thermalCharSummary.innerHTML = '';
  thermalCharResults.classList.add('hidden');
  await runThermalCharacter(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      thermalCharStatus.appendChild(div);
    }
  );
  btnRecalcThermalChar.disabled = false;
});
```

#### 3h. Debug export

```javascript
window.__getThermalCharacterResult = () => getThermalCharacterResult();
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Iterative thermal mass fails to converge on unusual data | 3 iterations with τ_seed clamp to range — design doc confirmed this is sufficient. Percentile filter removes outlier events after. |
| `steady_state_kwh_per_hh` denominator zero (temp_c null or HTC zero) | Guard: skip any warm-up HH where `external[j].temp_c === null`; HTC null already caught at Step 0. |
| `T_at_restart ≥ setpoint_c` (short off period, high mass) | Design doc explicitly says: discard that event (delta_T ≤ 0). Handled in `E_net_kj > 0 AND delta_T > 0.5` gate. |
| Warm-up phase never settles (building too big / data too short) | Cap scan at 48 HH from restart. If no settled HH found within 48 HH, use all 48 as warm-up — acceptable since the settled HH guard is conservative. |
| `T_outdoor_warmup` null (all temp_c null in warm-up phase) | Skip that event — cannot compute heat loss correction. Guard: only compute if at least 1 non-null temp_c in warm-up phase. |
| steady_state_kwh_per_hh ≤ 0 (setpoint ≤ outdoor temp during warm-up) | During warm-up in winter this should not occur (off-period winter filter ensures cold day). Guard: skip any HH with `setpoint_c ≤ external[j].temp_c`. |

---

## Success criteria

- [ ] **T1 — Setpoint recovery — synthetic.** 90 days, HTC = 280 W/K, η = 0.9,
  T_setpoint = 19°C, T_outdoor 3–10°C, 8-HH sustained blocks daily.
  `heating_kwh = 280 × (19 − T_outdoor) / (0.9 × 2000)` at steady state for all 8 HH.
  First 2 HH skipped per spec. Expected: `setpoint_c` within ±0.5°C of 19.

- [ ] **T2 — Setpoint clip.** Same setup plus 15 HH at 2× steady-state.
  Expected: `setpoint_c` still ≈ 19°C; inflated estimates discarded at clip.

- [ ] **T3 — Occupancy weights structure.** 12 months, heating Mon–Fri 06:00–09:00 +
  17:00–22:00 only.
  - `occupancy_weights[12]` (06:00 Mon–Fri) in [0.4, 0.8]
  - `occupancy_weights[34]` (17:00) in [0.6, 0.85]
  - `occupancy_weights[4]` (02:00) < 0.05

- [ ] **T4 — Thermal mass recovery — synthetic.** HTC = 250 W/K, η = 0.9,
  T_setpoint = 20°C, C = 9,000 kJ/K, 15 events, off = 7h, T_outdoor = 5°C.
  Expected: `thermal_mass_kj_per_k` within 15% of 9,000 after 3 iterations.

- [ ] **T5 — Time constant.** Inputs: `thermal_mass = 12,000`, `htc = 300`.
  Expected: `time_constant_hours = 11.11` within 0.05 h.

- [ ] **T6 — Null-HTC passthrough.** `htc_w_per_k = null`.
  Expected: all numeric outputs null, `validation_status = "no_htc"`, no warnings.

- [ ] **T7 — Insufficient events.** Only 3 valid warm-up events.
  Expected: `thermal_mass_kj_per_k = null`, `thermal_mass_events_used = 3`, warning surfaced.

- [ ] **T8 — Constant overnight heating.** All HH have `heating_kwh ≥ 0.05`.
  Expected: zero events; `thermal_mass = null`; "continuously overnight" warning.

- [ ] **T9 — Rating boundaries.** Values 5,999; 6,000; 14,999; 15,000; 29,999; 30,000.
  Expected ratings: "low", "medium", "medium", "high", "high", "very_high".

- [ ] **T10 — Wall construction mismatch.** C = 3,500, declared `"solid_masonry"`.
  Expected: warning surfaced. No warning if `"timber_frame"`.

- [ ] **T11 — Results card visible.** After running full Octopus flow, thermal-char-card
  appears. No JS console errors. British English throughout.

- [ ] **T12 — Wall construction recalculate.** Changing dropdown and clicking recalculate
  updates mismatch warning without re-running M1–M4.

- [ ] **T13 — No-gas passthrough.** CSV input with no gas data.
  Expected: `validation_status = "no_gas"`, card visible with appropriate message.

---

## Claude.ai Review — yyyy-mm-dd

**Reviewer:** Claude (Praxis Insight — Opus architect window)

### What is solid
[To be completed by reviewer]

### Clarifications required before implementation
[To be completed by reviewer]

### Minor observations (not blockers)
[To be completed by reviewer]

---

## Approval

**Status:** Awaiting approval.

---

## Implementation Deviations

None — implementation not yet started.
