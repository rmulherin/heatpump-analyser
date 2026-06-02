# m5-thermal-character-v2 — User-driven thermal mass with data-derived defaults

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Rewrite M5 (thermal character) per `m5-thermal-character-v2.md`. The v1 architecture
preferred data-derived Path A and fell back to user input (Path B). v2 inverts this:
the user's `tau_bucket` dropdown is the authoritative operating value; Path A short-event
computation provides the initial default (with which the UI pre-populates the dropdown)
and an informational callout when the user's selection diverges from the data. Path A's
long-event branch and `t_at_restart_winter_c` input are deleted entirely. The
`wall_construction_type` input is also deleted. A `'medium'` fallback guarantees
`thermal_mass_kj_per_k` is non-null whenever `htc_w_per_k` is non-null.

**Prerequisite:** m4-heat-loss-v2 must be implemented before this plan is executed
(m5-v2 reads the new `htc_low_plausibility_callout` output that m4-v2 adds). The
passthrough in Step 6 guards with `=== 'all_electric_dual_handed'` so it fails safe
(null) until m4-v2 is in place.

---

## Research findings

**Existing code reviewed:**

`js/thermal-character.js` — the full module. Key structure:
- `TC_CONFIG` constants block — needs enum renames + constant deletions.
- `TAU_BUCKET_HOURS_MAP` — v1 uses `{fast:4, evening:10, all_day:20, stays_for_days:40}`;
  v2 renames to `{low:4, medium:10, high:20, very_high:40}`.
- `estimateThermalMass()` — currently handles both short and long events. Long-event
  branch (lines around the `isLongEvent` classification) to be deleted entirely; only
  the short-event iterative loop remains. Return value changes from
  `{thermal_mass_kj_per_k, thermal_mass_source, events_used, ...}` to
  `{data_derived_tau_h, events_used, any_off_period_found}`.
- `checkWallConstruction()` — DELETE.
- `checkTauBucketSanity()` — DELETE (replaced by divergence-ratio computation inline in
  main function).
- `computeValidationStatus()` — remove the `source === 'measured_cold_soak'` gate.
- Main export `estimateThermalCharacter()` — signature currently:
  `(heating, external, heatLoss, baseloadMethod, wallConstructionType, tAtRestartWinterC, tauBucket)`.
  v2 removes `wallConstructionType` and `tAtRestartWinterC`, leaving:
  `(heating, external, heatLoss, baseloadMethod, tauBucket)`.

`index.html` — thermal-char-card currently has `#wall-construction` select, `#t-at-restart`
number input, and `#tau-bucket` select with v1 enum values. Both deleted inputs have their
form-groups removed. `#tau-bucket` option values renamed to match v2 enum.

`js/app.js` — references to remove: `wallConstructionInput`, `tAtRestartInput` DOM refs;
the `wallConstruction`/`tAtRestart` local variables in `runThermalChar()`; the v1
`thermal_mass_source` label map (`measured_cold_soak`/`user_tau`); the stale B3 notice
handler that focused `#t-at-restart`; the `__getThermalDiagnostics()` getter that reads
`_path_diagnostics`.

`test-m5.mjs` — T10 (wall construction mismatch) to be deleted. T7/T8 assertions on
`thermal_mass_kj_per_k === null` must change (v2 fallback produces non-null). All call
signatures need one fewer positional parameter (wallConstruction removed from position 5).

`test-m5b.mjs` — T11, T12 (long-event tests), T20a/b/c (tAtRestart tests) to be deleted.
T13, T14, T14b: signature update only. T15/T16/T17/T18/T19/T21a/T21b/T21c: signature
update + assertions updated per v2 semantics (source enum, user-wins logic, fallback).

No new external libraries needed. All logic is vanilla JS arithmetic.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/thermal-character.js` | Core module rewrite per v2 spec |
| MODIFY | `index.html` | Remove deleted inputs; rename tau-bucket option values |
| MODIFY | `js/app.js` | Update call site, DOM refs, display logic, diagnostic getter |
| MODIFY | `test-m5.mjs` | Update signature + affected assertions; add 14 v2 tests |
| MODIFY | `test-m5b.mjs` | Delete long-event + tAtRestart tests; update remaining |

---

## Implementation steps

### Step 1 — thermal-character.js: Update constants

In `TC_CONFIG`:
- Remove: `T_AT_RESTART_MIN_C`, `T_AT_RESTART_MAX_C`, `LONG_EVENT_OFF_HH`.
- Keep unchanged: all other constants.

Replace `WALL_CONSTRUCTION_RANGES` constant: DELETE entirely.

Rename `TAU_BUCKET_HOURS_MAP` keys:
```js
const TAU_BUCKET_HOURS_MAP = {
  low:       4,
  medium:   10,
  high:     20,
  very_high: 40,
};
```

Add bucket-mapping boundary constants (or define inline in `mapTauToBucket`):
```js
// Used in Step 4b bucket mapping (§4.4 of design doc)
const BUCKET_THRESHOLDS = [7, 15, 30]; // boundaries between low/medium/high/very_high
const BUCKET_KEYS = ['low', 'medium', 'high', 'very_high'];
const FALLBACK_BUCKET = 'medium';
```

### Step 2 — thermal-character.js: Delete removed functions

Delete `checkWallConstruction()` in its entirety.

Delete `checkTauBucketSanity()` in its entirety. The divergence-ratio equivalent is
computed inline in the main function in Step 6.

### Step 3 — thermal-character.js: Revise `estimateThermalMass()` → Path A short-event only

Rename to `runPathAShortEvent(heating, external, htc, eta, setpointC)` to clarify its
new, narrower scope.

**Delete from the function body:**
- The `isLongEvent` classification block (the `(offEnd - offStart > LONG_EVENT_OFF_HH) || containsAbsenceInOff` branch).
- The `longC` array and its population loop (`for (const ev of validEvents.filter(ev => ev.kind === 'long'))`).
- The `tAtRestartWinterC` parameter.
- The `longEventDiscardedForMissingUserTemp` flag.

**Keep unchanged:**
- The off-period detection loop (`while (i < n)` scan for `< OFF_PERIOD_THRESHOLD_KWH`).
- The `anyOffPeriodFound` flag tracking.
- Anchor check (preceding HH must have positive non-absent heating).
- T_outdoor_off mean computation.
- Winter filter (`T_outdoor_off >= WINTER_TEMP_MAX_C`).
- Warm-up phase scan.
- The absence checks (warmup must be absence-free; relaxed filter allows absence in off period for short events).
- Classify remaining events as short-only (discard any long events silently — they no longer qualify).
- The iterative short-event C estimation loop (3 iterations, outlier filter, median).

**NOTE:** Off-period detection runs regardless of whether `setpointC` is non-null. The
`any_off_period_found` flag is tracked across the scan. However, C estimation requires
`setpointC` — if null, the off-period scan still runs (tracking the flag) but produces
no C estimates (events_used = 0).

**New return value:**
```js
return {
  data_derived_tau_h,      // median(shortC) / (htc × 3.6) if events_used >= MIN_EVENTS_FOR_MASS; else null
  events_used,             // count of short events that contributed a C estimate (before outlier filter)
  any_off_period_found,    // whether ≥1 off period of ≥ OFF_PERIOD_MIN_HH was detected
};
```

The old `thermal_mass_kj_per_k` and `thermal_mass_source` are no longer returned here
— those are computed in the main function's Step 4c resolution (Step 6 below).

Export `mapTauToBucket` for direct testing in `test-m5.mjs`:

### Step 4 — thermal-character.js: Add exported `mapTauToBucket()` function

```js
export function mapTauToBucket(tauH) {
  if (tauH === null || tauH === undefined) return null;
  if (tauH < 7)  return 'low';
  if (tauH < 15) return 'medium';
  if (tauH < 30) return 'high';
  return 'very_high';
}
```

Export this function so `test-m5.mjs` can test the boundary mapping directly (T_V2_5).

### Step 5 — thermal-character.js: Revise `computeValidationStatus()`

Remove the `source === 'measured_cold_soak'` gate. New logic:

```js
function computeValidationStatus(setpointC, thermalMassKjPerK, setpointDaysUsed, eventsUsed) {
  if (setpointC === null || thermalMassKjPerK === null) return 'insufficient_data';
  if (setpointDaysUsed >= 50 && eventsUsed >= 10) return 'good';
  return 'acceptable';
}
```

Note: `thermal_mass_source` is no longer a parameter. `eventsUsed` is the count from
Path A (0 for fallback/user_selection cases) — so 'good' requires both strong setpoint
evidence AND strong thermal-mass evidence regardless of how the mass was obtained.

### Step 6 — thermal-character.js: Revise main function `estimateThermalCharacter()`

**Signature change:**
```js
export function estimateThermalCharacter(heating, external, heatLoss, baseloadMethod, tauBucket)
```
Remove `wallConstructionType` (was param 5) and `tAtRestartWinterC` (was param 6).
`tauBucket` remains as param 5 (now takes v2 enum values: `'low'|'medium'|'high'|'very_high'|null`).

**Remove from function body:**
- The `tAtRestartWinterC` range-gate validation block (including `validatedTAtRestart`,
  `inputWarnings` around t_at_restart plausibility, and the setpoint-comparison gate).
- The Path B block (`if (thermal_mass_source === null && tauBucket && htc !== null)`).
- The `path_b_kj_per_k` / `path_b_tau_h` capture.
- The v1 Step 4c warning block references to `long_event_discarded_for_missing_user_temp`
  and the `tauBucket` "providing indoor temp would unlock additional events" prompt.
- The `checkWallConstruction()` call.
- The `checkTauBucketSanity()` call.

**Restructure Step 4 as follows:**

```js
// Step 4a — Run Path A (short-event only); always runs when setpoint_c is non-null
// Off-period detection runs regardless (for any_off_period_found flag)
const pathAResult = runPathAShortEvent(
  heating, external, htc, eta,
  setpoint_c   // null-safe: function still scans for off periods even if setpoint null
);
const { data_derived_tau_h, events_used: thermal_mass_events_used,
        any_off_period_found } = pathAResult;

// Step 4b — Bucket mapping
const tau_dropdown_default_bucket = mapTauToBucket(data_derived_tau_h);

// Step 4c — Effective bucket resolution (user > data_default > fallback)
let effective_bucket, thermal_mass_source;
if (tauBucket !== null && tauBucket !== undefined && TAU_BUCKET_HOURS_MAP[tauBucket] !== undefined) {
  effective_bucket     = tauBucket;
  thermal_mass_source  = 'user_selection';
} else if (tau_dropdown_default_bucket !== null) {
  effective_bucket     = tau_dropdown_default_bucket;
  thermal_mass_source  = 'data_default';
} else {
  effective_bucket     = FALLBACK_BUCKET;
  thermal_mass_source  = 'fallback';
}

// Derive thermal_mass_kj_per_k from effective bucket
let thermal_mass_kj_per_k = null;
if (htc !== null) {
  const tau_h = TAU_BUCKET_HOURS_MAP[effective_bucket];
  thermal_mass_kj_per_k = tau_h * htc * 3.6;
} else {
  // htc null → Step 0 passthrough would have caught this; guard for safety
  thermal_mass_source = null;
}

// Step 4d — Divergence ratio (for informational callout)
let tau_data_user_divergence_ratio = null;
if (thermal_mass_source === 'user_selection' && data_derived_tau_h !== null) {
  const selected_tau_h = TAU_BUCKET_HOURS_MAP[effective_bucket];
  tau_data_user_divergence_ratio = selected_tau_h / data_derived_tau_h;
}

// Step 4e — Failure-path warnings (revised)
const stepCWarnings = [];
if (thermal_mass_source === 'fallback') {
  if (!any_off_period_found) {
    stepCWarnings.push(
      'Heating appears to run continuously overnight — not enough cold-soak data '
      + 'to estimate thermal mass from your usage pattern. Using a typical UK-home '
      + 'default. Update the dropdown below if you know your home holds its warmth differently.'
    );
  } else {
    stepCWarnings.push(
      'Not enough overnight cold-soak events to estimate thermal mass from your data. '
      + 'Using a typical UK-home default. Update the dropdown below if you know your '
      + 'home holds its warmth differently.'
    );
  }
}
if (thermal_mass_source === 'data_default') {
  // Soft note; included in warnings for UI to optionally surface as tooltip
  stepCWarnings.push(
    'Thermal mass estimated from cool-down patterns in your heating data. Adjust the '
    + 'dropdown below if you\'d describe your home differently.'
  );
}
if (thermal_mass_source === 'user_selection' && tau_data_user_divergence_ratio !== null) {
  if (tau_data_user_divergence_ratio > TC_CONFIG.TAU_SANITY_HIGH_RATIO
      || tau_data_user_divergence_ratio < TC_CONFIG.TAU_SANITY_LOW_RATIO) {
    const data_tau_h = data_derived_tau_h;
    const sel_tau_h  = TAU_BUCKET_HOURS_MAP[effective_bucket];
    stepCWarnings.push(
      `Your data suggests a thermal time constant of ~${data_tau_h.toFixed(0)}h; `
      + `you've selected ~${sel_tau_h}h. Using your selection.`
    );
  }
}
```

**Step 7 — Existing-HP callout passthrough:**
```js
const htc_low_plausibility_callout_passthrough =
  (heatLoss?.htc_low_plausibility_callout === 'all_electric_dual_handed')
  ? 'all_electric_dual_handed' : null;
```

**Remove `_path_diagnostics` from the return object.** Replace with the new v2 diagnostic
fields that are already top-level outputs.

**Updated return object:**
```js
return {
  // Primary outputs (v1 fields)
  setpoint_c,
  thermal_mass_kj_per_k,
  thermal_mass_source,          // v2 enum: 'user_selection'|'data_default'|'fallback'|null
  time_constant_hours,
  thermal_mass_rating,
  occupancy_weights,
  setpoint_days_used,
  thermal_mass_events_used,     // count of Path A short events (0 for fallback/data_default if 0 events)
  validation_status,
  // NEW v2 outputs
  data_derived_tau_h,
  tau_dropdown_default_bucket,
  tau_data_user_divergence_ratio,
  htc_low_plausibility_callout_passthrough,
  // Underheat diagnostic (unchanged)
  warnings: [...spWarns, ...stepCWarnings, ...(owWarn ? [owWarn] : []), ...tcWarns],
  modelled_heating_kwh_by_hh: modelledByHh,
  annual_modelled_demand_kwh:  underheat.annual_modelled_demand_kwh,
  annual_observed_demand_kwh:  underheat.annual_observed_demand_kwh,
  underheat_ratio:             underheat.underheat_ratio,
  underheat_status:            underheat.underheat_status,
  underheat_narrative:         underheatNarrative,
};
```

**Removed from return:** `long_event_discarded_for_missing_user_temp`, `_path_diagnostics`.

**Update `computeValidationStatus()` call** (Step 5 function):
```js
const validation_status = computeValidationStatus(
  setpoint_c, thermal_mass_kj_per_k, setpoint_days_used, thermal_mass_events_used
);
```
(Remove `thermal_mass_source` parameter that was previously passed.)

**Update `nullResult` inner function** to include the new output fields with appropriate
null/fallback defaults, and remove `long_event_discarded_for_missing_user_temp`.

### Step 7 — index.html: Remove deleted inputs; rename tau-bucket options

In the `thermal-char-card` section:

**Delete the entire `#t-at-restart` form-group** (label + input + form-hint paragraph).

**Delete the entire `#wall-construction` form-group** from the heat-loss card (it is in the heat-loss section, not thermal-char). The `#wall-construction` select is inside the heat-loss card, NOT the thermal-char card — remove it there.

**Update intro text** in `#thermal-char-inputs` — the current copy refers to both optional
inputs. Replace with copy appropriate for v2 (dropdown-only card):
```html
<p class="card-intro">
  The dropdown below helps when your boiler runs continuously overnight, preventing the
  data-driven estimate. Leave it on the default if you're unsure — you can refine it
  later.
</p>
```

**Rename `#tau-bucket` option values** (user-facing labels unchanged):
```html
<select id="tau-bucket">
  <option value="">Don't know</option>
  <option value="low">Cools noticeably within a few hours</option>
  <option value="medium">Stays warm into the evening, cooler by morning</option>
  <option value="high">Holds its warmth for most of a day</option>
  <option value="very_high">Stays warm for days — takes ages to cool</option>
</select>
```

### Step 8 — js/app.js: Update call site, DOM refs, display, diagnostic getter

**a. Remove DOM constant declarations:**
```js
// DELETE these two lines:
const wallConstructionInput = document.getElementById('wall-construction');
const tAtRestartInput       = document.getElementById('t-at-restart');
```

**b. Update `runThermalChar()` (or equivalent function around line 1378):**
Remove the `wallConstruction` and `tAtRestart` local variable declarations and the
`tAtRestartInput.value` parsing block. The `estimateThermalCharacter()` call becomes:
```js
result = estimateThermalCharacter(
  baseloadResult.heating,
  externalResult.external,
  heatLossResult,
  baseloadResult.baseload_metadata.method,
  tauBucket,
);
```

**c. Update `displayThermalCharacterResults()` (around line 1320–1360):**

Remove the v1 `thermal_mass_source === 'no_data'` check (was checking for a v1 source
value that never existed as a string; dead code in v1 too).

Update the `thermal_mass_source` label map to v2 enum values:
```js
const sourceLabel = ({
  user_selection: 'From your description',
  data_default:   'Estimated from your heating data',
  fallback:       'UK typical default',
})[result.thermal_mass_source] ?? result.thermal_mass_source;
rows.push(['Thermal mass source', sourceLabel]);
```

Add display of the informational callout when `tau_data_user_divergence_ratio` triggers
the condition (ratio > 2.0 or < 0.5) — surface the relevant warning string from
`result.warnings` as a `status-msg info` div below the summary DL. (The warning string
is already built by the module; just conditionally add a div containing the matching
warning text.)

**d. Update Bug B3 notice handler (around line 2006–2016):**

The B3 handler currently focuses `#tau-bucket` or `#t-at-restart`. Remove all references
to `#t-at-restart`. The handler should focus only `#tau-bucket`:
```js
const tauBucketEl = document.getElementById('tau-bucket');
if (tauBucketEl && tauBucketEl.value === '') {
  tauBucketEl.focus();
  tauBucketEl.classList.add('highlight-flash');
}
```

**e. Update `__getThermalDiagnostics()` (around line 3331–3348):**

Replace the `_path_diagnostics` read with the v2 top-level fields:
```js
window.__getThermalDiagnostics = () => {
  const tc = getThermalCharacterResult();
  if (!tc) return { available: false };
  return {
    available:                     true,
    thermal_mass_source:           tc.thermal_mass_source,
    selected_kj_per_k:             tc.thermal_mass_kj_per_k,
    selected_tau_h:                tc.time_constant_hours,
    data_derived_tau_h:            tc.data_derived_tau_h,
    tau_dropdown_default_bucket:   tc.tau_dropdown_default_bucket,
    tau_data_user_divergence_ratio: tc.tau_data_user_divergence_ratio,
    events_used:                   tc.thermal_mass_events_used,
  };
};
```

### Step 9 — test-m5.mjs: Update + add v2 tests

**Add import for `mapTauToBucket`:**
```js
import { estimateThermalCharacter, mapTauToBucket } from './js/thermal-character.js';
```

**Update existing call signatures** — remove the `wallConstruction` positional parameter
(was 5th, now absent). All existing calls that had `(..., 'gas', null)` where `null` was
wallConstruction now remain `(..., 'gas', null)` where `null` is `tauBucket`. This is a
no-op — the parameter just shifts. Calls that explicitly pass wallConstruction type need
removing that argument.

Specifically:
- T1, T2, T3, T5, T6, T9, X1–X5: Call `(..., 'gas', null)` — no change in text, correct
  by coincidence (5th param was null wallConstruction in v1, now null tauBucket in v2).
- T4 (line 148): same — no change needed in text.

**Update T7 assertions** (`T7a`, `T7c`):
- `T7a`: Change `thermal_mass_kj_per_k === null` → `thermal_mass_source === 'fallback'`
  (3 events → data_derived_tau_h null → fallback; mass is non-null via 'medium' default).
- `T7c`: Update warning text match — v2 uses "Not enough overnight cold-soak events…
  Using a typical UK-home default." (instead of "Not enough overnight cold-soak events
  to estimate thermal mass. Either more winter data is needed, or you can describe how
  your home holds its warmth…"). Change to match the v2 warning copy that includes
  "Using a typical UK-home default."

**Update T8 assertions** (`T8a`, `T8b`):
- `T8a`: Change `thermal_mass_kj_per_k === null` → `thermal_mass_source === 'fallback'`.
- `T8b`: Warning text match — v2 uses "Heating appears to run continuously overnight …
  Using a typical UK-home default." Update assertion to match the longer v2 copy (check
  for `'continuously overnight'` which still appears in the v2 text, so this may pass
  without change — verify the exact match).

**Delete T10** in its entirety (wall construction mismatch; feature removed).

**Add v2-specific tests T_V2_1 through T_V2_14** per design doc §7:

```
T_V2_1 — Long-event branch removal regression
  Setup: synthetic off period > 24h spanning is_absence days (what v1 would classify
  as a long event). Confirm v2 silently discards it (events_used = 0 or unchanged by
  the long event). Assert: result produced without error; long event does NOT contribute
  to events_used.

T_V2_2 — wall_construction_type input removal regression
  Assert estimateThermalCharacter does NOT have 7 parameters (only 5). Call with 5
  params and verify no "thermal mass … lower/higher … than typical" warning in output.

T_V2_3 — Bucket enum rename regression
  Call with tauBucket = 'low' → assert result.thermal_mass_kj_per_k non-null (valid).
  Call with tauBucket = 'fast' → assert source is NOT 'user_selection' (old enum not
  accepted; falls through to data_default or fallback).
  Assert result.tau_dropdown_default_bucket (when non-null) uses new enum values.

T_V2_4 — Path A short-event → data-derived tau
  Uses T4 setup (HTC=250, η=0.9, target C=9000, 15 valid events). Expected:
  - data_derived_tau_h ≈ 8.88h within ±15% (i.e. in [7.55, 10.21])
  - tau_dropdown_default_bucket = 'medium' (8.88 in [7, 15))
  - thermal_mass_source = 'data_default' (no user tauBucket supplied)
  - thermal_mass_kj_per_k = 10 × 250 × 3.6 = 9000 kJ/K

T_V2_5 — Bucket-mapping boundary tests (direct function test)
  Call mapTauToBucket() with: 6.99→'low', 7.00→'medium', 14.99→'medium', 15.00→'high',
  29.99→'high', 30.00→'very_high', 3.00→'low', 50.00→'very_high', null→null.

T_V2_6 — User selection wins over data default
  Uses T4 setup + tauBucket='very_high'. Expected:
  - thermal_mass_source = 'user_selection'
  - thermal_mass_kj_per_k = 40 × 250 × 3.6 = 36000 kJ/K
  - tau_data_user_divergence_ratio = 40 / data_derived_tau_h (≈40/8.88 ≈ 4.5 > 2.0)
  - warnings includes "Your data suggests a thermal time constant"

T_V2_7 — Fallback to 'medium' (no off periods, no user selection)
  480 HH of continuous heating (T8 setup), no tauBucket. Expected:
  - thermal_mass_source = 'fallback'
  - thermal_mass_kj_per_k = 10 × htc × 3.6 (= 9000 with htc=250)
  - data_derived_tau_h = null
  - tau_dropdown_default_bucket = null
  - warnings includes 'continuously overnight'

T_V2_8 — Fallback: Rhiannon's runtime case
  T4 setup with only 4 events (events_used < 5), no tauBucket. Expected:
  - data_derived_tau_h = null (events_used = 4 < 5)
  - thermal_mass_source = 'fallback'
  - thermal_mass_kj_per_k = 10 × 250 × 3.6 = 9000 kJ/K

T_V2_9 — Divergence ratio: exact boundary (strict > 2.0)
  data_derived_tau_h = 5, user selects tauBucket='medium' (τ=10h) → ratio=2.0 exactly.
  Assert: warning about "data suggests a thermal time constant" NOT present (strict >).
  Then data_derived_tau_h = 4.99 (construct setup that approximates this), user selects
  'medium' → ratio ≈ 2.004 > 2.0. Assert: callout fires.
  [Implementation note: exact tau values cannot be directly injected; use T_V2_9 to
  test the mapping function output and the strict-boundary logic in isolation by checking
  that ratio=2.0 does not fire.]

T_V2_10 — Informational callout copy
  T_V2_6 setup (user selects 'very_high', data≈8.88h, ratio≈4.5 > 2.0). Assert warning
  text matches: "Your data suggests a thermal time constant of ~Xh; you've selected ~Yh.
  Using your selection." — specifically contains "Using your selection."

T_V2_11 — Existing-HP callout passthrough
  Pass heatLoss = { htc_w_per_k: 250, boiler_efficiency_used: 0.9,
                    htc_low_plausibility_callout: 'all_electric_dual_handed' }
  Assert: result.htc_low_plausibility_callout_passthrough === 'all_electric_dual_handed'.
  Pass same with htc_low_plausibility_callout = 'gas_only'.
  Assert: passthrough = null.
  Pass same with htc_low_plausibility_callout = null.
  Assert: passthrough = null.

T_V2_12 — thermal_mass_source enum migration
  Run three scenarios (user selection, data default, fallback) and assert source is in
  {'user_selection', 'data_default', 'fallback', null}. Assert source is never
  'measured_cold_soak' or 'user_tau'.

T_V2_13 — validation_status evidence-based gating
  Setup with ≥15 short events (strong Path A data), setpoint_days_used ≥50, no user
  bucket. Assert validation_status = 'good' AND thermal_mass_source = 'data_default'
  (evidence-based gating is orthogonal to user engagement).
  Same setup with setpoint_days_used=30. Assert 'acceptable'.

T_V2_14 — thermal_mass non-null invariant
  Test all combinations of {Path A succeeds / fails} × {user input present / absent}
  with non-null htc. Assert: thermal_mass_kj_per_k is non-null in every case.
```

**Update summary assertion** at end of file to reflect new expected pass count.

### Step 10 — test-m5b.mjs: Delete and update tests

**Add import for mapTauToBucket** (if used in any test — not needed in m5b, skip).

**Delete helper function `makeLongEventData()`** at the top of the file — only used by
T11, T12, T20a, T20b, T20c (all deleted).

**Delete test blocks:** T11, T12, T20a, T20b, T20c.

**Update call signatures** (remove two positional null params) in all remaining tests.
Current pattern: `estimateThermalCharacter(h, e, hl, 'gas', null, null, tauBucket)` → 
v2: `estimateThermalCharacter(h, e, hl, 'gas', tauBucket)`.
Current pattern: `estimateThermalCharacter(h, e, hl, 'gas', null, null, null)` →
v2: `estimateThermalCharacter(h, e, hl, 'gas', null)`.

**T13** — Signature update only. `events_used >= 1` assertion unchanged. ✅

**T14** — Signature update only. `events_used === 0` assertion unchanged. ✅

**T14b** — Signature update only. `events_used === 0` assertion unchanged. ✅

**T15** — Signature update + enum rename + assertion updates:
- Signature: `null, null, 'all_day'` → `'high'`
- T15a-C: `14400` — unchanged (τ='high'=20h, htc=200, 20×200×3.6=14400). ✅
- T15a-src: `'user_tau'` → `'user_selection'`
- T15a-val: `'acceptable'` — still valid (events_used=0, setpoint days < 50). ✅
- T15b-warn: Update warning text match — v2 does NOT emit a "description of how the home
  holds" path-B warning for user_selection. Instead the step-4e data_default/fallback
  warning is emitted. Update: when source='user_selection', no warning from step-4e.
  Assert the OPPOSITE: no "description of how the home holds" warning (the v1 pathBWarning
  is deleted). Delete T15b-warn assertion or change to assert no such warning exists.
- T15b-no-step4c: `'continuously overnight'` warning NOT present for user_selection.
  Still valid because step-4e only emits that warning for `thermal_mass_source === 'fallback'`. ✅

**T16** — Complete assertion rewrite:
  v1: Path A supersedes tau_bucket. v2: user wins.
  - Signature: `null, null, 'fast'` → `'low'`
  - T16a-src: `'measured_cold_soak'` → `'user_selection'`
  - T16a-C: Was `[6791, 9189]` (Path A). Now = `4 × 250 × 3.6 = 3600` kJ/K.
    Change assertion to `result.thermal_mass_kj_per_k === 3600`.
  - T16b: Old "no Path B warning" — replace with assertion that divergence callout FIRES
    (data_derived_tau_h≈8.88h, user selected 'low'=4h, ratio=4/8.88≈0.45 < 0.5).
    Assert: `result.warnings.some(w => w.includes('data suggests a thermal time constant'))`.

**T17** — Signature update + assertion updates:
  v2: setpoint_c null → Path A not run → data_derived_tau_h null → fallback 'medium'.
  - Signature: `null, null, null` → `null`
  - T17a-C: `null` → update to `thermal_mass_source === 'fallback'` (mass is non-null).
  - T17a-src: `null` → `'fallback'`
  - T17a-val: `'insufficient_data'` — still valid (setpoint_c null). ✅
  - T17b: `'continuously overnight'` warning — still fires (no off periods, source=fallback). ✅

**T18** — Signature update + enum rename only:
  v2: user selects 'very_high' (renamed from 'stays_for_days'). User wins.
  data_derived_tau_h≈8.88h, selected=40h, ratio=40/8.88≈4.5 > 2.0 → callout fires.
  - Signature: `null, null, 'stays_for_days'` → `'very_high'`
  - T18a: Warning includes "data suggests a thermal time constant" — STILL fires with v2
    informational callout. ✅ (Assertion passes without change to the string check.)
  - T18b: `thermal_mass_kj_per_k !== null` — STILL valid (user_selection gives 40×250×3.6=36000). ✅

**T19** — Signature update + enum rename only:
  - Signature: `null, null, 'evening'` → `'medium'`
  - T19: No "data suggests a thermal time constant" warning. In v2: user selects 'medium'
    (τ=10h); data_derived_tau_h≈8.88h; ratio=10/8.88≈1.13 — within (0.5, 2.0] → no callout. ✅

**T21a** — Signature update + assertion updates:
  "Both paths fail" → in v2: no user selection, no data → fallback.
  - Signature: `null, null, null` → `null`
  - Assertion: `mass=null && source=null` → update to `source='fallback'` and `mass non-null`.

**T21b** — Signature update + enum rename + source update:
  - Signature: `null, null, 'all_day'` → `'high'`
  - Source: `'user_tau'` → `'user_selection'`

**T21c** — Signature update + source update:
  Path A succeeds (T4 setup, no tau_bucket). In v2: source='data_default'.
  - Signature: `null, null, null` → `null`
  - Source: `'measured_cold_soak'` → `'data_default'`

**Update summary assertion** to reflect new pass count (29 − deleted tests + unchanged = ~22, after deletions of T11, T12, T20a, T20b, T20c = 5 deletions → ~24 remaining).

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Path A short-event computation change: removing the long-event pooling changes `allEstimates` — only short events remain. v1 pooled long + short for the percentile filter. | In v2 the percentile filter applies to `lastGoodShortFinal` only. No logic change to short-event path; confirmed by design doc §4.3 "Computation unchanged from v1 §Step 4a short-event branch." |
| `runPathAShortEvent()` is called regardless of `setpoint_c` being null, but internally needs setpoint_c for the settled-state criterion. | Guard: `if (setpointC == null) { continue; }` within the warm-up scan's settled-state check. Off-period detection still runs; C estimation skips. |
| `mapTauToBucket` exported — adds to the module's public API. | Acceptable: pure utility function with no side effects. |
| T15b-warn assertion — v2 does not emit a path-B-style warning for user_selection. The assertion tested for a v1-specific string. | Delete the T15b-warn assertion; replace with assertion that source='user_selection' and no path-B warning is present. |
| m4-v2 not yet implemented when this plan is approved: `heatLoss.htc_low_plausibility_callout` is undefined. | The passthrough guard `=== 'all_electric_dual_handed'` evaluates `undefined === '...'` as false → null. Safe until m4-v2 lands. |
| Enum rename breaks any other consumer of `tau_bucket` values from HTML select. | The only consumer of the select's `.value` is `app.js` line ~1389. That value is passed directly to `estimateThermalCharacter()`. The v2 function accepts only new enum values. HTML and JS updated in same commit. |
| `__getThermalDiagnostics` contract change (removes `path_a.kj_per_k` etc.). | Diagnostic getter is a dev-console tool, not a production contract. Update simultaneously with the module. |

---

## Success criteria

- [ ] `node test-m5.mjs` — all tests pass. Expected: prior 39 minus T10 (1 deleted) + 14 new v2 = ~52 assertions (exact count depends on sub-assertions per test).
- [ ] `node test-m5b.mjs` — all tests pass. Expected: prior 29 minus T11, T12, T20a, T20b, T20c (9 assertions) + updated T15-T21 = ~20 assertions.
- [ ] All other test suites unaffected (M3 18/18, M6 24/24, M7 39/39, M8 24/24, M9 24/24) — run at the end to confirm no regressions.
- [ ] `thermal_mass_kj_per_k` non-null whenever `htc_w_per_k` non-null (T_V2_14 invariant).
- [ ] v2 enum values (`'low'`, `'medium'`, `'high'`, `'very_high'`) accepted; v1 values (`'fast'`, `'evening'`, etc.) treated as null (fall through to data_default or fallback).
- [ ] `#wall-construction` select and `#t-at-restart` input absent from `index.html`.
- [ ] `estimateThermalCharacter()` function signature is 5 parameters.
- [ ] Informational callout fires when `tau_data_user_divergence_ratio > 2.0` or `< 0.5`.
- [ ] `htc_low_plausibility_callout_passthrough` echoes `'all_electric_dual_handed'` from `heatLoss` when present; null otherwise.
- [ ] No console errors on page load (browser verification by Rhiannon).

---

## Implementation Deviations

**Date:** yyyy-mm-dd
**Commit:** [commit hash]

None.

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
