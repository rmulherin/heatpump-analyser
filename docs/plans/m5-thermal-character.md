# Module 5 — Thermal Character

**Date:** 2026-04-26
**Status:** ✅ Approved — implementation may begin.

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

A day qualifies as **whole** only if ALL of the following hold (matching the design doc's
contract in §Step 1):
- `hhIndices.length === 48`
- `heating[i].heating_kwh !== null` for all 48 HH
- `external[i].temp_c !== null` for all 48 HH

Days that fail any condition are excluded from the returned map entirely. Downstream
consumers (occupancy weights, setpoint inference, mass inference) iterate only over the
returned whole-day entries.

Per whole day:
- `dailyMeanTempC` = mean of `external[i].temp_c` over the 48 HH (all non-null by construction)
- `dailyHeatingKwh` = sum of `heating[i].heating_kwh` over the 48 HH
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

#### 1g. `estimateThermalMass(heating, external, htc, eta, setpointC)`

Requires `setpointC` non-null. Returns `{ thermal_mass_kj_per_k, events_used, warnings }`.

**Event detection (single pre-iteration pass).** Scan `heating[]` linearly for off
periods (≥`OFF_PERIOD_MIN_HH` consecutive HH with `heating_kwh < OFF_PERIOD_THRESHOLD_KWH`).
For each candidate:

1. Find the restart HH immediately after the off period (first HH with
   `heating_kwh ≥ OFF_PERIOD_THRESHOLD_KWH`).
2. Compute `T_outdoor_off = mean(external[i].temp_c for non-null HH in the off period)`.
   This value is also reused inside the iteration loop for `T_at_restart` — compute once
   here and cache it on the event record.
3. **Winter filter (per design doc §Step 4 condition 3):** require
   `T_outdoor_off !== null AND T_outdoor_off < WINTER_TEMP_MAX_C` (10 °C). The off
   period's own mean replaces the previous calendar-day-mean test, so off periods
   spanning midnight are handled cleanly. Skip the candidate if the gate fails.
3a. **Determine warm-up range (cached for the iteration loop).** From the restart HH,
    scan forward (cap at 48 HH for safety) using the settled criterion: for each HH `j`,
    compute `ss_kwh = htc × (setpointC − external[j].temp_c) × 0.5 / (eta × 1000)`; the
    first HH where `heating[j].heating_kwh ≤ 1.2 × ss_kwh` is the settled HH and is
    **excluded** from the warm-up range. Cache on the event record:
    - `warmup_indices` — list of HH indices in the warm-up phase
    - `warmup_hh_count` — `warmup_indices.length`
    - `E_warmup_kwh` — `sum(heating[i].heating_kwh for i in warmup_indices)`
    - `T_outdoor_warmup` — `mean(external[i].temp_c for i in warmup_indices, skip nulls)`

    If any warm-up HH has `external[j].temp_c === null` for the settled-criterion
    calculation, skip that HH; if no settled HH is found within 48 HH, treat all 48 as
    the warm-up range. If `T_outdoor_warmup` cannot be computed (all nulls), discard the
    candidate.
4. Skip if any HH in the off-period range OR in `warmup_indices` has
   `is_absence === true`.

Each surviving candidate becomes a `validEvent` carrying: off-period HH range,
`T_outdoor_off` (cached), `t_off_hours`, restart index. **All winter / absence /
null-temp filtering happens in this pass — the iteration loop receives only valid
events and never re-filters them.**

**Track separately:** whether any off-period sequences were found at all (used for the
"constant overnight heating" warning if zero events ultimately make it through).

**Iterative C estimation (≤3 iterations, with previous-iteration fallback):**

```
τ_seed = TC_CONFIG.TAU_SEED_HOURS
last_good_estimates = null   // C_estimates from the most recent non-empty iteration

for iter in 1..3:
  C_estimates = []
  for each event in validEvents:
    T_at_restart   = event.T_outdoor_off + (setpointC − event.T_outdoor_off) × exp(−event.t_off_hours / τ_seed)
    E_warmup_kj    = event.E_warmup_kwh × 3600
    T_mean_warmup  = (T_at_restart + setpointC) / 2
    t_warmup_hours = event.warmup_hh_count × 0.5
    E_heatloss_kj  = htc × (T_mean_warmup − event.T_outdoor_warmup) × t_warmup_hours × 3.6
    E_net_kj       = E_warmup_kj × eta − E_heatloss_kj
    delta_T        = setpointC − T_at_restart

    if E_net_kj > 0 AND delta_T > 0.5:
      C_estimates.push(E_net_kj / delta_T)

  if C_estimates.length > 0:
    last_good_estimates = C_estimates
    C_median = median(C_estimates)
    τ_seed   = C_median / (htc × 3.6)
  // else: keep last_good_estimates and τ_seed; carry-over guarantees we use the best
  // result we have rather than discarding it.
```

**Final-result selection:**

- If `last_good_estimates === null` (iteration 1 itself produced zero `C_estimates`):
  no usable events overall — return `thermal_mass_kj_per_k = null`,
  `events_used = 0`. Emit warning per the "minimum events" rule below.
- Otherwise: apply the 5th–95th percentile outlier filter to `last_good_estimates`.
  `thermal_mass_kj_per_k = median(filtered)`.
  `events_used = last_good_estimates.length` (count BEFORE the percentile filter — this
  matches the design doc's "events contributing" wording).

**Minimum events:** if `events_used < TC_CONFIG.MIN_EVENTS_FOR_MASS`:
- If zero off-periods were ever found in event detection: warn "Heating appears to run
  continuously overnight — not enough cold-soak data to estimate thermal mass."
- Otherwise: warn "Not enough overnight cold-soak events to estimate thermal mass. More
  winter data needed."
- Set `thermal_mass_kj_per_k = null`.

#### 1h. `computeRatingAndTimeConstant(thermalMassKjPerK, htcWPerK)`

```
time_constant_hours = thermal_mass_kj_per_k / (htc_w_per_k × 3.6)  // if both non-null

rating thresholds (< 6000 → "low", 6000–14999 → "medium", 15000–29999 → "high", ≥ 30000 → "very_high")
```

Time constant warnings: `> TAU_HIGH_WARN_HOURS` or `< TAU_LOW_WARN_HOURS`.

#### 1i. `checkWallConstruction(thermalMassKjPerK, wallConstructionType)`

Returns `{ warning: string | null }` — `null` if no mismatch, else the warning string.

If `wallConstructionType` non-null and `thermalMassKjPerK` non-null: check against
`WALL_CONSTRUCTION_RANGES`. If outside range, return warning string with measured and
expected range values. Otherwise return `{ warning: null }`.

#### 1j. `computeValidationStatus(setpointC, thermalMassKjPerK, setpointDaysUsed, eventsUsed)`

Final union (matches design doc): `"good" | "acceptable" | "insufficient_data" | "no_htc" | "no_gas"`.
There is no `"low_confidence"` value — sub-threshold confidence is communicated via warnings,
not a separate status.

```
htc null → "no_htc"           (checked before calling this)
no-gas   → "no_gas"           (checked before calling this)
setpoint non-null AND mass non-null AND setpointDaysUsed >= 50 AND eventsUsed >= 10 → "good"
setpoint non-null AND mass non-null (lower counts) → "acceptable"
setpoint non-null AND mass null (or vice versa) → "acceptable"  (with warnings already appended)
both null due to insufficient data → "insufficient_data"
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
   `{ thermal_mass_kj_per_k, events_used, warnings: massWarns } = estimateThermalMass(heating, external, htc, eta, setpoint_c)`.
   Else: `thermal_mass_kj_per_k = null, events_used = 0, massWarns = []`.
8. `{ time_constant_hours, thermal_mass_rating, tcWarns } = computeRatingAndTimeConstant(thermal_mass_kj_per_k, htc)`.
9. `const { warning: wcWarn } = checkWallConstruction(thermal_mass_kj_per_k, wallConstructionType)`.
10. `validation_status = computeValidationStatus(...)`.
11. Assemble and return the output object. Internal local-variable names are mapped onto
    the design doc's output field names as follows (only fields where the names differ
    are listed; the rest pass through unchanged):

    | Internal var (this function) | Output field (design doc) |
    |------------------------------|---------------------------|
    | `events_used`                | `thermal_mass_events_used` |
    | `tcWarns`, `spWarns`, `massWarns`, `owWarn` (concatenated) | `warnings` |

    The full output object shape is:

    ```javascript
    return {
      setpoint_c,                              // from estimateSetpoint
      thermal_mass_kj_per_k,                   // from estimateThermalMass
      time_constant_hours,                     // from computeRatingAndTimeConstant
      thermal_mass_rating,                     // from computeRatingAndTimeConstant
      occupancy_weights,                       // from computeOccupancyWeights
      setpoint_days_used,                      // from estimateSetpoint
      thermal_mass_events_used: events_used,   // renamed
      validation_status,                       // from computeValidationStatus
      warnings: [
        ...spWarns,
        ...massWarns,
        ...tcWarns,
        ...(owWarn ? [owWarn] : []),
        ...(wcWarn ? [wcWarn] : []),
      ],
    };
    ```

    The `no_htc` / `no_gas` early-return branches assemble the same shape but with all
    numeric fields set to null, `setpoint_days_used = 0`, `thermal_mass_events_used = 0`,
    `occupancy_weights = null`, `thermal_mass_rating = null`, and `warnings = []` (per
    design doc §Step 0: "no warnings — M4/M3 already surfaced the reason").

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
- `"good"` / `"acceptable"`: render numeric table plus warnings.

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

- [ ] **T4 — Thermal mass recovery — synthetic.** Per design doc §Test Criteria #4
  (revised): HTC = 250 W/K, η = 0.9, T_setpoint = 20°C, target C = 9,000 kJ/K
  (true τ = 9,000 / (250 × 3.6) = 10.0 h). T_outdoor held constant at 5°C throughout.

  For each of 15 warm-up events, construct gas consumption with this exact profile:
  - **Off period:** 14 consecutive HH (7 h) with `heating_kwh = 0`.
  - **Warm-up:** 4 HH (2 h) with `heating_kwh = 6.80` per HH.
  - **Steady state thereafter:** `heating_kwh = 2.083` per HH
    (= HTC × ΔT × 0.5 / (η × 1000) at T_outdoor = 5°C).

  Derivation (energy balance assuming linear T_indoor ramp from
  `T_at_restart` (true) = 5 + 15 × exp(−7/10) = 12.45°C up to 20°C over 4 HH):
  - Mass heating: `C × ΔT_mass = 9,000 × 7.55 = 67,950 kJ`
  - Fabric loss during ramp: `HTC × ΔT_mean × t × 3.6 = 250 × 11.225 × 2 × 3.6 = 20,205 kJ`
  - Gas energy required: `(67,950 + 20,205) / 0.9 = 97,950 kJ = 27.21 kWh over 4 HH`
    → 6.80 kWh per HH

  The settled criterion (`heating_kwh ≤ 1.2 × steady_state_kwh = 2.5 kWh per HH`)
  classifies HH 14–17 as warm-up and HH 18 as settled; the settled HH is excluded
  from the warm-up sum (matches the boundary-marker rule in design doc §Step 4
  condition 2).

  **Expected:** `thermal_mass_kj_per_k` ≈ 7,990 kJ/K at 3 iterations
  (≈ 11% under true; within the 15% tolerance). The algorithm converges from
  τ_seed = 5.0 toward true τ = 10.0 across the 3 iterations.

  **Fails if** the heat-loss correction is missing — without it the algorithm
  diverges, reaching ≈ 13,000 kJ/K (~45% over true) at 3 iterations. Also fails on
  unit-conversion mistakes or non-convergence.

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

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-26
**Review type:** Plan review (pre-implementation, second pass)
**Authoritative design:** `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/thermal-character.md`

### Context

Two-pass review. Pass 1 raised three required design-level changes (Test 4 inverted
synthesis, whole-day filter contract, winter-filter ambiguity for midnight-spanning
off periods) and a few minor items. The Opus architect window updated the design doc
in-pass for items in design-doc scope:

- Test 4 rewritten with explicit gas profile (14 HH off, 4 HH × 6.80 kWh, 2.083 kWh/HH
  steady) and corrected expected output (~7,990 kJ/K at 3 iterations, within 15%
  tolerance; broken-algo result ~13,000 kJ/K).
- Step 4 winter filter switched from `daily_mean_temp_c` to `T_outdoor_off`
  (the off period's own mean) — handles midnight-spanning off periods cleanly.
- Step 4 condition 2 explicitly states the settled HH is the boundary marker and is
  excluded from the warm-up sum.
- `low_confidence` removed from the `validation_status` union (sub-threshold
  confidence is communicated via warnings, not a separate status).

This pass-2 review confirms the plan revision tracks the updated design doc and
specifies the residual changes needed before implementation begins.

### Required changes for implementation

**1. Wall-construction warning is silently lost (HIGH).**

§1i (`checkWallConstruction`) is described as "push warning" with no explicit
return value, implying it mutates a `warnings` array passed as the third argument.
§1k step 9 calls it as `checkWallConstruction(thermal_mass_kj_per_k, wallConstructionType, allWarnings)`.
But §1k step 11's return concatenation is:

```javascript
warnings: [...spWarns, ...massWarns, ...tcWarns, ...(owWarn ? [owWarn] : [])]
```

— `allWarnings` (or whatever channel `checkWallConstruction` writes to) is not
included. Test T10 explicitly verifies the wall-mismatch warning surfaces; as
written, T10 fails.

**Fix:** change `checkWallConstruction` to return `{ warning: string | null }`,
matching the shape used by other helpers (`computeOccupancyWeights` returns
`{ warning }`).

- §1i — change description from "push warning" to "returns `{ warning: string | null }`
  — `null` if no mismatch, else the warning string."
- §1k step 9 — capture the return: `const { warning: wcWarn } = checkWallConstruction(thermal_mass_kj_per_k, wallConstructionType);`
  (drop the third argument entirely — there is nothing to push to).
- §1k step 11 — extend the warnings concatenation to include `wcWarn`:
  ```javascript
  warnings: [
    ...spWarns,
    ...massWarns,
    ...tcWarns,
    ...(owWarn ? [owWarn] : []),
    ...(wcWarn ? [wcWarn] : []),
  ]
  ```

**2. `daySummaries` is now an unused parameter in `estimateThermalMass` (LOW).**

The pass-1 fix moved the winter filter from `dailyMeanTempC` (looked up via
`daySummaries`) to a locally-computed `T_outdoor_off`. As a result, `daySummaries`
is no longer referenced inside `estimateThermalMass`. The dead parameter should be
dropped to keep the signature honest and avoid implying a dependency that doesn't
exist.

**Fix:**

- §1g — change the function signature from `estimateThermalMass(heating, external, daySummaries, htc, eta, setpointC)`
  to `estimateThermalMass(heating, external, htc, eta, setpointC)`.
- §1k step 7 — update the call site to match the new signature
  (`estimateThermalMass(heating, external, htc, eta, setpoint_c)`).

**3. Settled-HH boundary needed in event detection, not just iteration (MEDIUM).**

§1g step 4 of event detection requires checking `is_absence` over the off period
**and the prospective warm-up phase** — but the warm-up phase boundary is currently
only computed inside the iteration loop. This leaves the implementer with an
implicit choice: re-do the settled scan during event detection, defer the
warm-up-phase absence check into the iteration body, or ignore the warm-up portion
of the absence check entirely. The plan should specify the answer.

The clean answer is: **the warm-up boundary is iteration-invariant** — it depends
only on `setpointC`, `htc`, `eta`, and per-HH `temp_c`, none of which change
between iterations. Compute it once in event detection, cache on the event record,
reuse in the iteration body.

**Fix to §1g event detection** — add as a new step between current step 3
(winter filter) and current step 4 (absence check):

> **3a. Determine warm-up range (cached for the iteration loop).** From the
> restart HH, scan forward (cap at 48 HH for safety) using the settled criterion:
> for each HH `j`, compute
> `ss_kwh = htc × (setpointC − external[j].temp_c) × 0.5 / (eta × 1000)`;
> the first HH where `heating[j].heating_kwh ≤ 1.2 × ss_kwh` is the settled HH and
> is **excluded** from the warm-up range. Cache the following on the event record:
>
> - `warmup_indices` — the list of HH indices in the warm-up phase
> - `warmup_hh_count` — `warmup_indices.length`
> - `E_warmup_kwh` — `sum(heating[i].heating_kwh for i in warmup_indices)`
> - `T_outdoor_warmup` — `mean(external[i].temp_c for i in warmup_indices, skip nulls)`
>
> If any warm-up HH has `external[j].temp_c === null` for the settled-criterion
> calculation, skip that HH (cannot evaluate settled criterion); if no settled HH
> is found within 48 HH, treat all 48 as the warm-up range (existing risk-table
> mitigation).

**Fix to §1g step 4 (absence check)** — clarify it now uses the cached
`warmup_indices`:

> Skip if any HH in the off-period range OR in `warmup_indices` has
> `is_absence === true`.

**Fix to §1g iteration loop** — replace the per-iteration warm-up scan with
cached values. The body becomes:

```
T_at_restart    = T_outdoor_off + (setpointC − T_outdoor_off) × exp(−t_off_hours / τ_seed)
E_warmup_kj     = event.E_warmup_kwh × 3600
T_mean_warmup   = (T_at_restart + setpointC) / 2
t_warmup_hours  = event.warmup_hh_count × 0.5
E_heatloss_kj   = htc × (T_mean_warmup − event.T_outdoor_warmup) × t_warmup_hours × 3.6
E_net_kj        = E_warmup_kj × eta − E_heatloss_kj
delta_T         = setpointC − T_at_restart

if E_net_kj > 0 AND delta_T > 0.5:
  C_estimates.push(E_net_kj / delta_T)
```

This also resolves an existing risk-table mitigation
("`T_outdoor_warmup` null (all temp_c null in warm-up phase)") — the event would
be discarded in the cache step (`T_outdoor_warmup` cannot be computed) rather than
inside the iteration.

### Resolution of review changes

1. **Wall-construction warning channel** — §1i changed to return `{ warning: string | null }` (no third parameter). §1k step 9 updated to `const { warning: wcWarn } = checkWallConstruction(...)`. §1k step 11 warnings array extended with `...(wcWarn ? [wcWarn] : [])`.
2. **Unused `daySummaries` parameter** — §1g signature updated to `estimateThermalMass(heating, external, htc, eta, setpointC)`. §1k step 7 call site updated to match.
3. **Settled-HH boundary cached in event detection** — Step 3a added to event detection: scans from restart HH, caches `warmup_indices`, `warmup_hh_count`, `E_warmup_kwh`, `T_outdoor_warmup` on the event record. Step 4 (absence check) updated to use `warmup_indices`. Iteration loop simplified to read all warm-up values from cached fields — no per-iteration settled-criterion scan.

## Review Summary

| Severity | Count | Status                            |
|----------|-------|-----------------------------------|
| CRITICAL | 0     | ✓ pass                            |
| HIGH     | 1     | ⚠ warn — fix #1 before implement  |
| MEDIUM   | 1     | ⚠ warn — fix #3 before implement  |
| LOW      | 1     | — fix #2 in same edit pass        |

Verdict: **APPROVE WITH EDITS** — three required changes documented above; once
applied inline by the implementer, plan is ready to implement.

---

## Approval

**Status:** ⚠ Approved with edits — 2026-04-26
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:**
- Test 4 synthetic-data construction uses derived gas profile (27.21 kWh / 4 HH = 6.80 kWh per HH) per revised design Test 4; expected ~7,990 kJ/K at 3 iterations within 15% tolerance.
- Winter filter for warm-up events uses `T_outdoor_off` (off period's own mean), not a calendar-day mean.
- `validation_status` union has no `low_confidence` value; sub-threshold confidence surfaces via warnings only.
- Settled HH is the boundary marker excluded from the warm-up sum (resolved in Pass 1 design-doc clarification).
- Wall-construction input lives in M4's heat-loss card for now; UI placement may be revisited when M10 is designed.

---

## Implementation Deviations

None — implementation not yet started.
