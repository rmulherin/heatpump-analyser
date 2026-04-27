# Module 5b — Thermal Mass Multi-Path Estimation

**Date:** 2026-04-27
**Status:** ✅ Approved — 2026-04-27
**Depends on:**
- `design/thermal-character.md` revised 2026-04-27 (multi-path Step 4 — Path A relaxation,
  long-event branch, Path B fallback). Authoritative spec for this plan.
- `m5-thermal-character.md` — implemented 2026-04-27, retained as historical record only.
  Per the revised design doc: "the original m5-thermal-character.md plan ... is the historical
  record of what was built against the pre-revision design and is not modified. These design
  changes reach the codebase through a new plan." This is that new plan.

---

## Task description

Extend `js/thermal-character.js` to implement the revised design's two-path thermal-mass
estimation: Path A (data-driven cold-soak events with relaxed absence filter and a new
long-event branch using user-supplied `t_at_restart_winter_c`) and Path B (lived-experience
`tau_bucket` fallback when Path A produces fewer than 5 events). Add the two new optional
user inputs to the M5 card and chain the thermal-character recalculate button through M7,
M8, and M9 so smart scenarios can run end-to-end on continuously-heated homes (Rhiannon's
data is the canonical case). Add the `thermal_mass_source` output discriminator.

The two new inputs and the recalculate chain are **functional UI**, not presentation. Per
Rhiannon's brief: M10 (the forthcoming UI plan) is "window dressing" — visual integration
into the building-profile panel — and must not be a prerequisite for any of the engine
behaviour shipped here.

---

## Research findings

### Why this change is needed

Rhiannon's real data produces ~4 cold-soak events across a full year — below the 5-event
minimum. The pre-revision M5 returns `thermal_mass_kj_per_k = null`, which propagates to
`validation_status.smart = "no_thermal_mass"` in M7 and nullifies `smart_hp_hh` and
`hybrid_smart` cost/saving outputs in M8/M9. This blocks the smart-scenario browser tests
(M8 T12, parts of T13/T15; M9 sensitivity directional checks where smart provides the best
payback) and — more importantly — blocks the tool from saying anything useful about smart
heat-pump dispatch for the constantly-heated households the design targets.

The design doc was revised today (file mtime 2026-04-27 16:38) with two new paths and two
new optional user inputs. The revision log explicitly routes the implementation via a new
plan; this is that plan.

### Current code state to extend

`js/thermal-character.js` (485 lines, last touched 2026-04-27 11:42):
- `TC_CONFIG` block (lines 13–36) — add `T_AT_RESTART_MIN_C`, `T_AT_RESTART_MAX_C`,
  `TAU_SANITY_HIGH_RATIO`, `TAU_SANITY_LOW_RATIO`, and `LONG_EVENT_OFF_HH` (= 48).
- `WALL_CONSTRUCTION_RANGES` (lines 38–42) — unchanged.
- `estimateThermalMass()` (lines 193–317) — substantial refactor: add anchor check, relax
  absence filter (keep warm-up absence check, drop off-period absence rejection), classify
  events into short/long, compute long-event C directly, add new return-object fields
  (`thermal_mass_source`, `any_off_period_found`,
  `long_event_discarded_for_missing_user_temp`).
- `estimateThermalCharacter()` (lines 371–432) — signature gains two parameters
  (`tAtRestartWinterC`, `tauBucket`), Path B logic, plausibility checks for `t_at_restart`,
  Step 4c warning emission, sanity-check warning, and `thermal_mass_source` in the return
  object.
- `computeValidationStatus()` (lines 362–367) — signature gains `source`; "good" gate now
  requires `source === "measured_cold_soak"`.

`index.html`:
- Wall-construction `<select>` lives in the M4 heat-loss card (line 165), **not** the
  M5 card. Out of scope to move; the existing M4 recalculate already re-runs M5
  downstream chain (so wall-construction edits already work end-to-end).
- `thermal-char-card` (line 182) currently has no input controls — only results and a
  "Recalculate with updated construction type" button (whose label is now stale).

`js/app.js`:
- `runThermalCharacter()` (lines 1197–1225) — currently reads `wallConstructionInput.value`
  only. Needs to read both new inputs and pass them through.
- `btnRecalcThermalChar` listener (lines 1227–1242) — currently re-runs M5 only. Needs to
  chain M7 → M8 → M9 (M6 unaffected — see "Module re-run scope" below).
- `displayThermalCharacterResults()` (around line 1138, full body around lines 1138–1195)
  — needs a row for `thermal_mass_source` between the existing thermal-mass row and the
  time-constant row.

### Module re-run scope on recalculate

The design doc states the chain is M5 → M7 → M8. M9 also needs to re-run because its
inputs include M8 (pricing) and M7 (consumption). M6 (heat-pump model) reads thermal-character
output but only for `setpoint_c` and indirectly via M5's `validation_status` — neither of
which changes when the new inputs (`t_at_restart_winter_c`, `tau_bucket`) flip Path B on or
unlock long events. Setpoint inference (Step 3) is untouched by this plan; only Step 4
changes. Therefore M6 does not re-run.

**Re-run chain on this card's Recalculate:** M5 → M7 → M8 → M9.

### M10 boundary

Per Rhiannon: M10 is window dressing only. This plan ships:
- The two new `<input>` / `<select>` controls in plain `form-group` styling (matches the
  M4 wall-construction input).
- A plain text label for `thermal_mass_source` in the M5 results list.
- The recalculate chain.

M10 will later integrate the new inputs into a richer "Your Home" building-profile panel,
restyle the thermal_mass_source label as part of a confidence-tier visualisation, and
present the sanity-check / Path B "indicative" warnings with appropriate visual weight.
None of that is required for the engine to be functional.

### No external library needed

All changes are arithmetic and DOM manipulation. No new CDN entries, no new dependencies.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/thermal-character.js` | Path A relaxation, long-event branch, Path B fallback, `thermal_mass_source` field, plausibility checks for `t_at_restart_winter_c`, sanity-check warning |
| MODIFY | `index.html` | Add `t-at-restart` number input and `tau-bucket` select to `thermal-char-card`; relabel recalculate button |
| MODIFY | `js/app.js` | DOM refs for new inputs; signature change in `runThermalCharacter`; recalc-chain to M7/M8/M9; `thermal_mass_source` row in results list |
| CREATE | `test-m5b.mjs` | Synthetic node test suite covering design doc tests 11–22 |

No files are deleted.

---

## Implementation steps

### Step 1 — Engine changes in `js/thermal-character.js`

#### 1a. Constants

Add to `TC_CONFIG`:
```javascript
T_AT_RESTART_MIN_C:       5,
T_AT_RESTART_MAX_C:      19,
LONG_EVENT_OFF_HH:       48,    // > 24 h ⇒ long event
TAU_SANITY_HIGH_RATIO:  2.0,
TAU_SANITY_LOW_RATIO:   0.5,
```

New top-level constant (alongside `WALL_CONSTRUCTION_RANGES`):
```javascript
const TAU_BUCKET_HOURS_MAP = {
  fast:            4,
  evening:        10,
  all_day:        20,
  stays_for_days: 40,
};
```

#### 1b. Helper: warm-up energy balance

Extract the per-event C calculation (currently inlined in the iteration loop) into a
named helper. Used by both short and long events.

```javascript
function computeC(T_at_restart, E_warmup_kwh, warmup_hh_count, T_outdoor_warmup,
                 htc, eta, setpointC) {
  const E_warmup_kj   = E_warmup_kwh * 3600;
  const T_mean_warmup = (T_at_restart + setpointC) / 2;
  const t_warmup_h    = warmup_hh_count * 0.5;
  const E_heatloss_kj = htc * (T_mean_warmup - T_outdoor_warmup) * t_warmup_h * 3.6;
  const E_net_kj      = E_warmup_kj * eta - E_heatloss_kj;
  const delta_T       = setpointC - T_at_restart;
  if (E_net_kj > 0 && delta_T > 0.5) return E_net_kj / delta_T;
  return null;
}
```

#### 1c. Refactor `estimateThermalMass()`

New signature:
```javascript
function estimateThermalMass(heating, external, htc, eta, setpointC, tAtRestartWinterC) {
```

Returns:
```javascript
{
  thermal_mass_kj_per_k: number | null,
  thermal_mass_source: "measured_cold_soak" | null,   // null here; main fn sets "user_tau"
  events_used: number,
  warnings: string[],
  any_off_period_found: boolean,
  long_event_discarded_for_missing_user_temp: boolean,
}
```

Per-event collection loop:

```
for each off-period [offStart, offEnd) with length ≥ OFF_PERIOD_MIN_HH:
  any_off_period_found = true        // tracked regardless of subsequent checks

  // Anchor check (NEW)
  if offStart === 0: continue        // no preceding HH
  prev = heating[offStart - 1]
  if (prev.heating_kwh == null OR prev.heating_kwh ≤ 0
      OR prev.is_absence === true): continue
  // Explicit null guard avoids relying on JS coercion (`null <= 0 === true`).

  // T_outdoor_off mean (existing)
  if no valid temp_c in off window: continue
  T_outdoor_off = mean(temp_c over off window)
  t_off_hours   = (offEnd - offStart) * 0.5

  // Winter filter (existing)
  if T_outdoor_off ≥ WINTER_TEMP_MAX_C: continue

  // Restart HH valid check (existing)
  if heating[offEnd].heating_kwh < OFF_PERIOD_THRESHOLD_KWH: continue
  restartIdx = offEnd

  // Warm-up phase scan (existing logic, returns warmup_indices, E_warmup_kwh, T_outdoor_warmup)
  if no valid temp_c during warm-up: continue

  // Absence check (RELAXED)
  // - WARM-UP must contain no is_absence HH (unchanged)
  // - OFF PERIOD may contain is_absence HH (relaxation)
  warmupHasAbsence = any heating[j].is_absence for j in warmup_indices
  if warmupHasAbsence: continue

  containsAbsenceInOff = any heating[j].is_absence for j in [offStart, offEnd)

  // Classify
  isLongEvent = (offEnd - offStart > LONG_EVENT_OFF_HH) OR containsAbsenceInOff

  if isLongEvent:
    if tAtRestartWinterC === null:
      long_event_discarded_for_missing_user_temp = true
      continue
    push { kind: 'long', T_at_restart: tAtRestartWinterC,
           warmup_hh_count, E_warmup_kwh, T_outdoor_warmup }
  else:
    push { kind: 'short', T_outdoor_off, t_off_hours,
           warmup_hh_count, E_warmup_kwh, T_outdoor_warmup }
```

C estimation:

```
// Long-event C estimates — independent of τ_seed, computed once
longC = []
for ev where ev.kind === 'long':
  c = computeC(ev.T_at_restart, ev.E_warmup_kwh, ev.warmup_hh_count,
               ev.T_outdoor_warmup, htc, eta, setpointC)
  if c !== null: longC.push(c)

// Short-event C estimates — iterative as before, but use computeC().
// Carry-over: if an iteration produces 0 estimates (e.g. converged τ pushes a
// borderline event over the delta_T > 0.5 gate), retain the last good iteration's
// values rather than discarding them. Mirrors the original M5 implementation's
// last_good_estimates pattern.
tauSeed = TAU_SEED_HOURS
lastGoodShortFinal = []
for iter in 0..ITERATIONS-1:
  shortFinal = []
  for ev where ev.kind === 'short':
    T_at_restart = ev.T_outdoor_off + (setpointC - ev.T_outdoor_off)
                                    * exp(-ev.t_off_hours / tauSeed)
    c = computeC(T_at_restart, ev.E_warmup_kwh, ev.warmup_hh_count,
                 ev.T_outdoor_warmup, htc, eta, setpointC)
    if c !== null: shortFinal.push(c)
  if shortFinal.length > 0:
    lastGoodShortFinal = shortFinal
    tauSeed = median(shortFinal) / (htc * 3.6)

// Pool and decide — use the last good iteration's short estimates, plus all long.
allEstimates = [...lastGoodShortFinal, ...longC]
events_used = allEstimates.length

if events_used >= MIN_EVENTS_FOR_MASS:
  sorted = allEstimates sorted ascending
  lo = percentile(sorted, OUTLIER_PCTILE_LOW)
  hi = percentile(sorted, OUTLIER_PCTILE_HIGH)
  thermal_mass_kj_per_k = median(sorted.filter(v => lo ≤ v ≤ hi))
  thermal_mass_source = 'measured_cold_soak'
else:
  thermal_mass_kj_per_k = null
  thermal_mass_source = null

return { thermal_mass_kj_per_k, thermal_mass_source, events_used, warnings: [],
         any_off_period_found, long_event_discarded_for_missing_user_temp }
```

Note: the existing per-event "Step 4 absence check" (lines 261–268 of current file) is
removed and replaced with the relaxed warm-up-only check above. The off-period absence
rejection that motivated the rewrite is retired.

#### 1d. Path B in `estimateThermalCharacter()`

After the call to `estimateThermalMass()`:

```javascript
let { thermal_mass_kj_per_k, thermal_mass_source, events_used: thermal_mass_events_used,
      warnings: massWarns, any_off_period_found,
      long_event_discarded_for_missing_user_temp } = massResult;

let pathBWarning = null;
if (thermal_mass_source === null && tauBucket && htc !== null) {
  const tauHours = TAU_BUCKET_HOURS_MAP[tauBucket];
  if (tauHours !== undefined) {
    thermal_mass_kj_per_k = tauHours * htc * 3.6;
    thermal_mass_source   = 'user_tau';
    pathBWarning = 'Thermal mass estimated from your description of how the home holds '
                 + 'its warmth (insufficient cold-soak events were found in your data). '
                 + 'For pre-heating analysis this is indicative — a data-driven estimate '
                 + 'would normally be more precise.';
  }
}
```

Note: `thermal_mass_events_used` is **not** modified by Path B. It records the data-driven
event count for transparency (per design doc Step 4b: "thermal_mass_events_used keeps
whatever count Path A produced (0–4)").

#### 1e. Step 4c failure-path warnings

Only emit when both paths failed (`thermal_mass_source === null` after Path B branch):

```javascript
const stepCWarnings = [];
if (thermal_mass_source === null) {
  if (!any_off_period_found && !tauBucket) {
    stepCWarnings.push(
      'Heating appears to run continuously overnight — not enough cold-soak data '
      + 'to estimate thermal mass. Describing how your home holds its warmth would '
      + 'unlock smart pre-heating analysis.'
    );
  } else if (any_off_period_found && !tauBucket) {
    stepCWarnings.push(
      'Not enough overnight cold-soak events to estimate thermal mass. Either more '
      + 'winter data is needed, or you can describe how your home holds its warmth '
      + 'to enable smart pre-heating analysis.'
    );
  }
  if (long_event_discarded_for_missing_user_temp) {
    stepCWarnings.push(
      "If you've returned home from being away during winter, providing the indoor "
      + 'temperature you typically find on return would unlock additional events from '
      + 'your data.'
    );
  }
}
```

If Path A produced events but they were filtered out (rare — outlier filter never reduces
count below the gate, see "Risks" below), the existing
"Not enough overnight cold-soak events" warning from `massWarns` is no longer emitted from
inside `estimateThermalMass()`. The new Step 4c logic is the single source of truth. Remove
the `massWarns` push at the end of the old `estimateThermalMass()`.

#### 1f. Plausibility checks for `t_at_restart_winter_c`

At the top of `estimateThermalCharacter()`, after the no-gas / no-htc gates and before
calling `estimateThermalMass()`:

```javascript
const inputWarnings = [];
let validatedTAtRestart = (tAtRestartWinterC == null) ? null : tAtRestartWinterC;
if (validatedTAtRestart !== null) {
  if (validatedTAtRestart < TC_CONFIG.T_AT_RESTART_MIN_C
      || validatedTAtRestart > TC_CONFIG.T_AT_RESTART_MAX_C) {
    inputWarnings.push(
      `Provided indoor temperature on return (${validatedTAtRestart}°C) is outside the `
      + 'plausible range — value ignored.'
    );
    validatedTAtRestart = null;
  }
}
```

After Step 3 (setpoint inference) completes:
```javascript
if (validatedTAtRestart !== null && setpoint_c !== null
    && validatedTAtRestart >= setpoint_c) {
  inputWarnings.push(
    `Provided indoor temperature on return (${validatedTAtRestart}°C) is at or above `
    + `your inferred setpoint (${setpoint_c.toFixed(1)}°C) — value ignored.`
  );
  validatedTAtRestart = null;
}
```

Pass `validatedTAtRestart` (not the raw user value) to `estimateThermalMass()`.

#### 1g. Tau-bucket sanity-check (Step 5)

New helper called after `computeRatingAndTimeConstant()`:

```javascript
function checkTauBucketSanity(time_constant_hours, tauBucket, source) {
  if (source !== 'measured_cold_soak') return null;
  if (!tauBucket || time_constant_hours == null) return null;
  const midpoint = TAU_BUCKET_HOURS_MAP[tauBucket];
  if (midpoint === undefined) return null;
  const ratio = time_constant_hours / midpoint;
  if (ratio > TC_CONFIG.TAU_SANITY_HIGH_RATIO
      || ratio < TC_CONFIG.TAU_SANITY_LOW_RATIO) {
    // Lower-cased forms of the UI <option> text — appear inside a sentence.
    const labels = {
      fast:           'cools noticeably within a few hours',
      evening:        'stays warm into the evening, cooler by morning',
      all_day:        'holds its warmth for most of a day',
      stays_for_days: 'stays warm for days — takes ages to cool',
    };
    return `Your data suggests a thermal time constant of ${time_constant_hours.toFixed(1)} h, `
         + `but your description (${labels[tauBucket]}) implies around ${midpoint} h. `
         + 'The data-driven figure is used — a large gap can indicate measurement noise, '
         + "irregular heating patterns, or that the lived-experience description didn't "
         + 'match the data.';
  }
  return null;
}
```

#### 1h. `computeValidationStatus()` — signature change

```javascript
function computeValidationStatus(setpointC, thermalMassKjPerK, source,
                                  setpointDaysUsed, eventsUsed) {
  if (setpointC === null && thermalMassKjPerK === null) return 'insufficient_data';
  if (setpointC !== null && thermalMassKjPerK !== null
      && source === 'measured_cold_soak'
      && setpointDaysUsed >= 50 && eventsUsed >= 10) return 'good';
  return 'acceptable';
}
```

The "good" status now requires `measured_cold_soak`. A `user_tau` result is always
"acceptable" even if all other criteria are met — by design.

#### 1i. Main `estimateThermalCharacter()` — full signature and return

```javascript
export function estimateThermalCharacter(heating, external, heatLoss, baseloadMethod,
                                          wallConstructionType,
                                          tAtRestartWinterC, tauBucket) {
  // ... existing no-gas / no-htc gates ...
  // ... plausibility check on tAtRestartWinterC (1f) ...
  // ... Step 1, Step 2, Step 3 unchanged ...
  // ... post-setpoint plausibility check on tAtRestartWinterC (1f) ...
  // ... Step 4 → estimateThermalMass(..., validatedTAtRestart) (1c) ...
  // ... Path B (1d), Step 4c warnings (1e) ...
  // ... computeRatingAndTimeConstant (existing) ...
  // ... checkTauBucketSanity (1g) ...
  // ... checkWallConstruction (existing) ...
  // ... computeValidationStatus(..., thermal_mass_source, ...) (1h) ...
  return {
    setpoint_c,
    thermal_mass_kj_per_k,
    thermal_mass_source,           // NEW: "measured_cold_soak" | "user_tau" | null
    time_constant_hours,
    thermal_mass_rating,
    occupancy_weights,
    setpoint_days_used,
    thermal_mass_events_used,
    validation_status,
    warnings: [
      ...spWarns, ...massWarns, ...tcWarns,
      ...inputWarnings,
      ...(pathBWarning ? [pathBWarning] : []),
      ...stepCWarnings,
      ...(sanityWarning ? [sanityWarning] : []),
      ...(owWarn ? [owWarn] : []),
      ...(wcWarn ? [wcWarn] : []),
    ],
  };
}
```

The nullResult helper also gains `thermal_mass_source: null` for shape consistency.

---

### Step 2 — UI changes in `index.html`

Modify `thermal-char-card` (currently lines 182–189) to add an inputs section. New
markup:

```html
<section class="card hidden" id="thermal-char-card">
  <h2>Thermal Character</h2>
  <div id="thermal-char-inputs">
    <p class="card-intro">
      Two optional inputs help when your boiler runs continuously overnight, which
      prevents the data-driven cold-soak estimate. Both can be left blank.
    </p>
    <div class="form-group">
      <label for="t-at-restart">Indoor temperature on return from a winter trip
        <span class="unit">°C</span>
        <span style="font-weight:normal;color:var(--colour-dark)">(optional)</span>
      </label>
      <input id="t-at-restart" type="number" step="0.5" min="5" max="19" placeholder="e.g. 14">
      <p class="form-hint">
        When you've come home after several days away in winter, what does the indoor
        thermometer typically read?
      </p>
    </div>
    <div class="form-group">
      <label for="tau-bucket">How does your home hold its warmth?
        <span style="font-weight:normal;color:var(--colour-dark)">(optional)</span>
      </label>
      <select id="tau-bucket">
        <option value="">Don't know</option>
        <option value="fast">Cools noticeably within a few hours</option>
        <option value="evening">Stays warm into the evening, cooler by morning</option>
        <option value="all_day">Holds its warmth for most of a day</option>
        <option value="stays_for_days">Stays warm for days — takes ages to cool</option>
      </select>
      <p class="form-hint">After turning the heating off in winter.</p>
    </div>
  </div>
  <div id="thermal-char-results" class="hidden">
    <div class="status-area" id="thermal-char-status"></div>
    <dl id="thermal-char-summary"></dl>
  </div>
  <button class="btn btn-primary" id="btn-recalculate-thermal-char">Recalculate</button>
</section>
```

Notes:
- Button label changes from "Recalculate with updated construction type" to "Recalculate"
  since it now drives multiple input changes (and chains downstream).
- The wall-construction `<select>` stays in the M4 heat-loss card (out of scope to move).
  The M4 recalculate already chains M5 → M6 → M7 → ... so wall-construction edits
  continue to flow end-to-end.
- Existing `form-group` / `form-hint` / `card-intro` / `unit` CSS classes are reused — no
  new styles required. (Note: `card-intro` is already present in styles.css per M8/M9.)

---

### Step 3 — App wiring in `js/app.js`

#### 3a. New DOM refs

After `wallConstructionInput` (line 173):
```javascript
const tAtRestartInput = document.getElementById('t-at-restart');
const tauBucketSelect = document.getElementById('tau-bucket');
```

#### 3b. `runThermalCharacter()` — read new inputs and pass through

Replace the body's input-read block (around line 1205) and the `estimateThermalCharacter`
call (around line 1209):

```javascript
const wallConstruction = wallConstructionInput.value || null;

const tAtRestartRaw = tAtRestartInput.value.trim();
let tAtRestart = null;
if (tAtRestartRaw !== '') {
  const parsed = parseFloat(tAtRestartRaw);
  tAtRestart = isNaN(parsed) ? null : parsed;
}

const tauBucket = tauBucketSelect.value || null;

let result;
try {
  result = estimateThermalCharacter(
    baseloadResult.heating,
    externalResult.external,
    heatLossResult,
    baseloadResult.baseload_metadata.method,
    wallConstruction,
    tAtRestart,
    tauBucket,
  );
} catch (err) { ... }
```

#### 3c. Recalculate button — chain to M7 → M8 → M9

Replace the existing handler (lines 1227–1242):

```javascript
btnRecalcThermalChar.addEventListener('click', async () => {
  btnRecalcThermalChar.disabled = true;
  thermalCharStatus.innerHTML  = '';
  thermalCharSummary.innerHTML = '';
  thermalCharResults.classList.add('hidden');

  const showStatus = (msg, type) => {
    const div = document.createElement('div');
    div.className = `status-msg ${type}`;
    div.textContent = msg;
    thermalCharStatus.appendChild(div);
  };

  await runThermalCharacter(() => {}, showStatus);
  // Thermal-mass change flips smart scenarios from null ↔ values; chain downstream.
  await runScenarioConsumption(() => {}, () => {});
  await runPricingEngine(() => {}, () => {});
  await runFinancialAnalysis(() => {}, () => {});

  btnRecalcThermalChar.disabled = false;
});
```

The downstream callbacks pass empty `showStatus` because each module's display function
already populates its own card's status area; double-routing to the M5 card would mix
warnings.

`runScenarioConsumption` is the slow step (~5–10 s on real data per session memory). The
button's disabled state covers the wait — no progress indicator added to this card per
the M10-is-window-dressing constraint (M10 will add one).

#### 3d. `displayThermalCharacterResults()` — new source row

In the existing summary-row build (around line 1192 of the current file — the `rows = [...]`
list), add a row for `thermal_mass_source` immediately after the `thermal_mass_kj_per_k`
row:

```javascript
if (result.thermal_mass_source !== null) {
  const sourceLabel = ({
    measured_cold_soak: 'Measured from your heating data',
    user_tau:           'Estimated from your description',
  })[result.thermal_mass_source];
  rows.push(['Thermal mass source', sourceLabel]);
}
```

(Use whichever push / template syntax matches the existing builder — the change is one row
inserted in the same builder. The null guard avoids a redundant "Thermal mass source: —"
row sitting next to a "Thermal mass: —" row when the failure path fires.)

---

### Step 4 — Test suite (`test-m5b.mjs`)

Create `test-m5b.mjs` at repo root, modelled on `test-m5.mjs`. Imports:

```javascript
import { estimateThermalCharacter } from './js/thermal-character.js';
```

Helper utilities (copy / adapt from `test-m5.mjs`): `assert(cond, label)`, `pass(label)`,
`fail(label, detail)`, synthetic event builders. Keep tests independent — do not rely on
shared mutable state.

Test coverage (each test maps to one or more design doc tests in `test-criteria.md`):

| ID  | Setup | Asserts |
|-----|-------|---------|
| T11a | 5-day winter absence; off-period spans absence; warm-up Saturday post-absence; `t_at_restart_winter_c = 14`, T_out=5°C, T_set=19°C, HTC=250, target C=9000 | Event qualifies; C ∈ [7650, 10350] (±15%); `thermal_mass_source === "measured_cold_soak"` |
| T11b | Same as T11a | `thermal_mass_events_used >= 1` |
| T12a | Same shape as T11; `t_at_restart_winter_c = null` | `long_event_discarded_for_missing_user_temp === true` |
| T12b | Same as T12a + `tau_bucket = null` | Step 4c "returned home" warning present |
| T13  | Sunday morning short off-period (4 HH off, no absence); standard warm-up | Event qualifies via short branch; contributes to events_used |
| T14  | Off-period preceded immediately by another off-period (anchor `heating_kwh = 0`) | Event discarded; not counted in events_used |
| T14b | Off-period preceded by `is_absence = true` HH | Event discarded; not counted in events_used |
| T15a | Continuous overnight heating (no events); `tau_bucket = "all_day"`, HTC=200 | `thermal_mass_kj_per_k === 14400`, `thermal_mass_source === "user_tau"`, `validation_status === "acceptable"` |
| T15b | Same as T15a | Path B indicative warning present; no Step 4c warning |
| T16a | Path A happy-path data (Test 4 setup) + `tau_bucket = "fast"` | `thermal_mass_source === "measured_cold_soak"`; thermal_mass within 15% of 9000 |
| T16b | Same as T16a | Path B indicative warning **not** present |
| T17a | Continuous overnight heating + `tau_bucket = null` | `thermal_mass_kj_per_k === null`, `thermal_mass_source === null`, `validation_status === "insufficient_data"` |
| T17b | Same as T17a | Step 4c "continuously overnight" warning present |
| T18  | Path A produces τ=5.5h (C=4000, HTC=200) + `tau_bucket = "stays_for_days"` (40h) | Sanity-check warning surfaced; `thermal_mass_kj_per_k` retained as 4000 |
| T19  | Path A produces τ=12h + `tau_bucket = "evening"` (10h, ratio 1.2) | No sanity-check warning |
| T20a | `t_at_restart_winter_c = 22`, setpoint inferred ~19 | "outside plausible range" warning; long events discarded as if null |
| T20b | `t_at_restart_winter_c = 3` (below 5) | "outside plausible range" warning |
| T20c | `t_at_restart_winter_c = 18`, setpoint inferred 17 | "at or above your inferred setpoint" warning; treated as null |
| T21a | Test 17 setup (both paths fail) | `thermal_mass_kj_per_k === null && thermal_mass_source === null` |
| T21b | Test 15 setup (Path B succeeds) | `thermal_mass_kj_per_k !== null && thermal_mass_source === "user_tau"` |
| T21c | Test 4 setup (Path A succeeds) | `thermal_mass_kj_per_k !== null && thermal_mass_source === "measured_cold_soak"` |

Design doc Test 22 (Path B output piped through M7's `estimateScenarioConsumption()`)
is **not** included in the node test suite. Adding it would require importing
`scenario-consumption.js` and fabricating plausible synthetic M2 / M4 / M6 outputs
purely to drive M7 — substantial harness for limited extra signal. The contract is
exercised end-to-end in browser test U2, which uses real upstream module outputs
rather than synthetic stand-ins. Existing `test-m7.mjs` already verifies M7 handles
arbitrary `thermal_mass_kj_per_k` values, so the M5/M7 boundary is covered without
duplicating the harness.

Total: 21 assertions. Each prints `✅ T## label` on pass and `❌ T## label — detail` on
fail. Exit code is 0 if all pass, 1 otherwise (matches existing test-m\*.mjs convention).

Synthetic builders: reuse the helpers from `test-m5.mjs` for warm-up event construction
(15-event happy path generator, etc.). Do not duplicate code from `test-m5.mjs` — import
or copy the helper into a shared location only if it would be used by both files; otherwise
keep T11/T13/T16 builders inline in `test-m5b.mjs`.

Existing `test-m5.mjs` must continue to pass after the refactor. Run it first as a
regression gate before adding any new tests.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Refactoring `estimateThermalMass()` breaks `test-m5.mjs` short-event T4 (15-event happy path) | The two-pass pool-and-filter is structurally identical to the current single-pass for short-only inputs (longC = []). Run `test-m5.mjs` first; do not proceed to Step 4 of this plan until 26/26 still pass. |
| Iteration N produces 0 short-event C estimates → final pool empty even though earlier iterations had valid values | `lastGoodShortFinal` carry-over (§1c) retains the most recent non-empty iteration's output, mirroring the original M5 implementation's `last_good_estimates` pattern. Required to prevent regression vs current shipped behaviour for borderline events. |
| Path B activates accidentally when Path A had ≥5 events but they were percentile-filtered to <5 | The 5-event gate is checked on `events_used` (count **before** percentile filter). Percentile filter only narrows the median, never the count. Verified in pseudocode above. Add explicit code comment. |
| `events_used` is reported as Path A's count even when Path B is used (per design intent) — could confuse a future reader | Add a comment in the main fn: `// thermal_mass_events_used reflects Path A's data-driven count even when Path B supplied the value (per design doc)`. The `thermal_mass_source` field disambiguates. |
| Setpoint check on `t_at_restart` runs before setpoint is inferred | Plausibility against [5, 19] runs at entry; the setpoint comparison runs only after Step 3 returns a non-null `setpoint_c`. Order is enforced in code; setpoint-null short-circuits the comparison. |
| Recalculate chain re-runs ~10 s of computation even when the user only changed wall construction | Acceptable: recalculate is user-triggered, not a hot path. The button is disabled during the chain, giving clear feedback. M10 will add a progress indicator. |
| Tau-bucket option strings drift between design doc, code constant, UI option `value` | Single source of truth: `TAU_BUCKET_HOURS_MAP` in `thermal-character.js`. UI dropdown `value=""` strings must exactly match keys. Test T15a will fail if mismatched. |
| `parseFloat("") === NaN`, not null — bare `\|\| null` would silently drop a legitimate `0` (impossible here since the range is [5,19], but worth being defensive) | Explicit empty-string check + `isNaN` guard in 3b, matching the M9 `parseGbp` pattern. |
| New `thermal_mass_source` field shape breaks existing test-m5.mjs assertions that don't reference it | M5 tests assert specific fields; an additive field is non-breaking. Verified: `test-m5.mjs` does not enumerate result keys with `Object.keys` (would flag extra fields). |
| Existing summary builder pattern (whatever it is — function-style vs template-string) doesn't accept the new row cleanly | Read `displayThermalCharacterResults()` first during implementation; match the existing pattern exactly. If row insertion is awkward, record as deviation. |
| Negative `T_outdoor_off` or extreme cold during a long event causes `T_mean_warmup` to be far below `T_at_restart` (user-supplied), leading to negative `E_heatloss_kj` correction | The energy-balance is well-defined for any `T_outdoor_warmup < T_mean_warmup`; the `E_net_kj > 0` and `delta_T > 0.5` guards in `computeC()` discard pathological events. No additional guard needed. |

---

## Success criteria

### Synthetic (Node — `test-m5b.mjs`)
- [ ] **T11** — Long event with `t_at_restart_winter_c = 14`: qualifies; C within 15% of 9000; source = `measured_cold_soak`.
- [ ] **T12** — Long event without `t_at_restart_winter_c`: discarded; `long_event_discarded_for_missing_user_temp = true`; Step 4c "returned home" warning surfaced.
- [ ] **T13** — Short event under relaxed filter still qualifies via short branch.
- [ ] **T14** — Off-period anchor enforcement: events with `heating_kwh = 0` or `is_absence = true` immediately preceding are discarded.
- [ ] **T15** — Path B with continuous overnight heating + `tau_bucket = "all_day"`: `thermal_mass_kj_per_k = 14400`, source = `user_tau`, validation = `acceptable`, indicative warning present, no Step 4c warning.
- [ ] **T16** — Path B does **not** fire when Path A succeeds: source = `measured_cold_soak`; no Path B warning.
- [ ] **T17** — Both paths fail: `thermal_mass_kj_per_k = null`, source = null, validation = `insufficient_data`, Step 4c warning present.
- [ ] **T18** — Sanity-check warning fires when ratio outside [0.5, 2.0].
- [ ] **T19** — Sanity-check suppressed when ratio inside [0.5, 2.0].
- [ ] **T20** — `t_at_restart_winter_c` outside [5, 19] or ≥ setpoint: ignored with warning.
- [ ] **T21** — `thermal_mass_kj_per_k === null` ⇔ `thermal_mass_source === null` across all paths.

Design doc Test 22 (M5→M7 contract preservation) is verified via browser test U2 below,
not in the node suite — see §4 rationale.

### Regression
- [ ] **`test-m5.mjs` 26/26 still pass** after refactor (no behavioural change to short-event happy path).
- [ ] **`test-m6.mjs` 24/24 still pass** (M6 unaffected by signature change).
- [ ] **`test-m7.mjs` 27/27 still pass** (M7 contract preserved per design doc).
- [ ] **`test-m8.mjs` 24/24 still pass**.
- [ ] **`test-m9.mjs` 28/28 still pass**.

### Browser (Rhiannon's Octopus data)
- [ ] **U1** — `thermal-char-card` renders both new inputs visibly with hint text. `Recalculate` button label is "Recalculate" (no longer mentions construction type).
- [ ] **U2** — Set `tau_bucket = "all_day"` (best-guess match for Rhiannon's house), leave `t_at_restart` blank, click Recalculate. Within ~10 s: M5 card shows `thermal_mass_kj_per_k` non-null, source = "Estimated from your description"; M7 card refreshes with smart scenarios populated; M8 card shows non-null totals for `smart_hp_hh` and `hybrid_smart`; M9 card shows non-null payback rows for both smart scenarios. Path B indicative warning visible in M5 status area.
- [ ] **U3** — Set `t_at_restart = 25` (out of range), click Recalculate. Plausibility warning visible in M5 status area; smart scenarios remain null (because Path A still has insufficient short-only events); no JS console errors.
- [ ] **U4** — Set `t_at_restart = 15` (in range), `tau_bucket = ""` (Don't know), click Recalculate. If long events exist in Rhiannon's data: Path A may produce ≥5 events and `thermal_mass_source = "measured_cold_soak"`. If still <5: Path A still fails, source remains null, smart scenarios still null. Either outcome is acceptable — record which one and note in test log.
- [ ] **U5** — `thermal_mass_source` row visible in M5 results list with the correct label text (one of "Measured from your heating data" / "Estimated from your description" / "—").
- [ ] **U6** — No JS console errors during any U1–U5 interaction. `window.__getThermalCharacterResult()` returns a result with the new `thermal_mass_source` field.

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-27
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/thermal-character.md` (revised 2026-04-27)

### Context

This is the new plan that actions the multi-path Step 4 design revision. The
implemented `m5-thermal-character.md` plan remains the historical record of the
pre-revision build and is not modified. M7's contract is preserved (the new
`thermal_mass_source` field is additive; M7 still consumes only
`thermal_mass_kj_per_k` and the existing peer fields). Plan tracks the design
closely; review found surgical issues only.

### Required changes for implementation

**1. Iteration carry-over regression vs current code (MEDIUM).**

The original implemented M5 plan's iteration loop preserved `last_good_estimates`
when an iteration produced zero C values. The pre-review m5b pseudocode reset
`shortFinal = []` at every iteration, so a borderline event passing in iter 1 but
failing in iter 3 (due to converged τ pushing it over the `delta_T > 0.5` gate)
would silently disappear from the pool — a regression vs shipped behaviour.

**Fix applied inline (§1c):** introduced `lastGoodShortFinal` carry-over mirroring
the original implementation's pattern. Pool composition uses
`lastGoodShortFinal`, not the live `shortFinal`. Risks-table entry added.

**2. Test T22 not implementable as scoped (MEDIUM).**

T22 ("Path B result piped through M7's `estimateScenarioConsumption()`") was
listed in the node test table but the test file imports only
`thermal-character.js`. Adding M7 + synthetic upstream stand-ins for one
contract-preservation assertion was disproportionate to the value.

**Fix applied inline (§4 + success criteria):** T22 removed from the node suite;
substitution note added explaining that browser test U2 exercises the same
contract end-to-end on real upstream outputs, and existing `test-m7.mjs` already
verifies M7 with arbitrary `thermal_mass_kj_per_k` values. Total node assertions
21 (was 22).

**3. Anchor null-coercion subtlety (LOW).**

The §1c anchor check used `if prev.heating_kwh ≤ 0` and relied on JS coercion
(`null <= 0 === true`) to discard null prior-HH cases. Worked, but read as
coincidence rather than intent.

**Fix applied inline (§1c):** explicit `prev.heating_kwh == null` precondition
added.

**4. Sanity-check warning labels did not match UI option text (LOW).**

§1g warning labels (`'cools in a few hours'` etc.) were paraphrased rather than
matching the `<select>` `<option>` text. A user reading "your description (cools
in a few hours)" against an option labelled "Cools noticeably within a few hours"
would notice the inconsistency.

**Fix applied inline (§1g):** labels now match the UI option text verbatim
(lower-cased to flow inside a sentence).

**5. Plan header status wording was stale (LOW).**

"Awaiting approval — review via claude.ai before implementation begins" reflected
the pre-two-window setup. Updated to the approved status.

**6. UX: redundant null source row (LOW).**

§3d unconditionally pushed a "Thermal mass source" row that rendered as `—` when
`thermal_mass_source` was null — redundant next to a "Thermal mass: —" row in
the failure path.

**Fix applied inline (§3d):** null guard added; the row only renders when source
is non-null.

### Cross-cutting note (not a plan change)

The design doc itself contained an internal contradiction in Step 4a item 1
between "scanned backwards … at most 48 HH" wording and the long-event
classification logic that requires the full physical off-period to be detected.
The plan correctly resolved the ambiguity (full-extent scan, classify by length)
without explicit instruction. The design doc is updated separately to remove the
ambiguous wording; no corresponding plan change required.

## Review Summary

| Severity | Count | Status                       |
|----------|-------|------------------------------|
| CRITICAL | 0     | ✓ pass                       |
| HIGH     | 0     | ✓ pass                       |
| MEDIUM   | 2     | ⚠ resolved inline            |
| LOW      | 4     | ⚠ resolved inline            |

Verdict: **APPROVE WITH EDITS** — six required changes documented above; all
applied inline. Plan ready to implement.

---

## Approval

**Status:** ✅ Approved — 2026-04-27
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:**
- Carry-over of `lastGoodShortFinal` mirrors the original M5 implementation's
  `last_good_estimates` pattern; required to prevent regression for borderline
  short events.
- Design doc Test 22 (M5→M7 contract preservation) is verified via browser test
  U2 on real upstream data, not via a node-suite end-to-end harness.
- Design-doc Step 4a item 1 ambiguity (scan-window wording) is updated separately
  in the design doc, not in this plan.

---

## Implementation Deviations

**D1 — `long_event_discarded_for_missing_user_temp` exposed in return object.**
Plan showed this field only in the internal `estimateThermalMass()` return; the outer `estimateThermalCharacter()` return object in §1i did not include it. Test T12a asserts the field directly on the outer return. Added to both the main return and `nullResult` for shape consistency and test transparency. The field is unused by M7/M8/M9 (additive).

**D2 — T14 test design: offStart=0 anchor, not kwh=0 preceding anchor.**
The plan described T14 as "off-period preceded immediately by another off-period (anchor heating_kwh = 0)". In practice, any HH with kwh = 0 immediately before an off-period would be absorbed into the off-period by the scan, making the `prev.heating_kwh ≤ 0` branch unreachable from contiguous 0-kwh HH. The test instead exercises the equivalent `offStart === 0` branch (no preceding HH at all), which is the real anchor-failure path for the continuous-zero case. The `is_absence` anchor (T14b) was unaffected.
