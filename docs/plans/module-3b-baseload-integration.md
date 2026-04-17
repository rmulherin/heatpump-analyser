# Module 3b — Baseload Separation: Orchestration & UI Integration

**Date:** 2026-04-16
**Status:** ✅ Approved — implementation may begin. 2 clarification(s) apply (see review below).
**Depends on:** Module 3a (must be implemented and verified first)

---

## Task description

Wire the baseload separation module (`js/baseload.js` from Phase 3a) into the app orchestration and display results to the user. This includes the primary separation results (method, daily baseload, absence count, validation status), all warnings, and the supplementary electric load detection results (electric heating, AC, limitations).

This phase connects the pure computation to the running application.

---

## Research findings

**Existing pattern:** Module 2 integration in `app.js` (lines 467–555, `runExternalData()`) establishes the orchestration pattern:
- Retrieve upstream result via getter (`getIngestionResult()`, `getExternalResult()`)
- Run computation steps with progress callbacks
- Store result via setter (`setExternalResult()`)
- Display summary and warnings via `showStatus()`

Module 3 will follow this identical pattern.

**UI approach:** No new HTML sections needed. Warnings and status messages use the existing `showStatus()` / `showCsvStatus()` infrastructure. The supplementary loads results (electric heating, AC) are displayed as informational or warning status messages depending on confidence level. The HH heatmap visualisation is Module 9 scope, not this module.

**Supplementary loads display logic:** The design doc specifies that `supplementary_loads` outputs are consumed by `ui-design` for several distinct messaging purposes:
- Electric heating: accuracy caveat on the heat-loss panel ("your home also uses some electricity for heating")
- AC: cooling messaging reframe (three phrasing sets: AC present, no AC, couldn't tell)
- `electric_heating_is_primary`: framing in the no-gas case
- `limitations`: "what this doesn't cover" note

For 3b, we surface the detection results and limitations as status messages. The full UI treatment (panel-specific messaging, heatmap labelling) is Module 9 scope.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/app.js` | Add `runBaseloadSeparation()` function; call it after Module 2 completes in both Octopus and CSV flows |

---

## Implementation steps

### Step 1 — Import baseload functions (Low complexity)

Add imports from `./baseload.js` at the top of `app.js`:
```js
import {
  separateBaseload,
  setBaseloadResult,
  getBaseloadResult,
} from './baseload.js';
```

### Step 2 — Method and confidence label mappings (Low complexity)

Add label-mapping objects in `app.js`:

```js
const BASELOAD_METHOD_LABELS = {
  'summer-hh-profile-weekday-split': 'Summer weekday/weekend profile (best)',
  'summer-hh-profile-flat': 'Summer profile (no weekday/weekend split)',
  'summer-daily-flat': 'Summer daily average (limited summer data)',
  'balance-point': 'Warm-weather estimation (no summer data)',
  'literature-default': 'UK average estimate (insufficient data)',
  'no-gas': 'No gas supply detected',
};

const CONFIDENCE_LABELS = {
  'high': 'high confidence',
  'moderate': 'moderate confidence',
  'low': 'low confidence — treat with caution',
  'none': '',
};
```

### Step 3 — `runBaseloadSeparation()` orchestration function (Medium complexity)

Add function `runBaseloadSeparation(showProgressFn, showStatusFn)`:

1. **Retrieve upstream data:**
   ```js
   const ingestion = getIngestionResult();
   const externalResult = getExternalResult();
   if (!ingestion || !externalResult) return;
   ```

2. **Show progress:** `'Separating heating demand from baseload…'`

3. **Call `separateBaseload(ingestion.consumption, externalResult.external)`.**

4. **Store result** via `setBaseloadResult(result)`.

5. **Display primary separation summary:**
   - Method used (via `BASELOAD_METHOD_LABELS`)
   - Daily baseload: mean and median from metadata (formatted to 1 decimal place, kWh/day)
   - Validation status and R² value (if available)
   - Absence days detected (if any)

6. **Display warnings** from `result.baseload_metadata.warnings` via `showStatusFn(warning, 'warning')`.

7. **Display supplementary load results** (Step H output):

   **Electric heating:**
   - If `electric_heating_detected` and not `electric_heating_is_primary`:
     - Show as warning: "Supplementary electric heating detected ({confidence}). Estimated {X} kWh over the data period ({Y} kWh per degree-day). Your gas-derived heat loss may underestimate your home's true heating demand."
   - If `electric_heating_is_primary` (no-gas case):
     - Show as info: "Electric heating detected ({confidence}). Estimated {X} kWh over the data period. Your home appears to heat with electricity rather than gas."
   - If confidence = `"low"`:
     - Show as info: "Weak signal for supplementary electric heating (low confidence) — not included in heat loss adjustment."

   **Air conditioning:**
   - If `air_conditioning_detected`:
     - Show as info: "Air conditioning detected ({confidence}). An air-source heat pump could replace your existing cooling system as well as providing heating."
   - If `ac_detection_note === "insufficient_cdd_data"`:
     - Show as info: "Not enough warm-weather data to assess whether you have air conditioning."
   - If not detected and no note (evaluated, genuinely no signal): no message.

   **Limitations:**
   - If any detection ran (method = `"regression"`), show a compact note: "Note: supplementary load detection has limitations — see details below." followed by each limitation string from `result.supplementary_loads.limitations` as info-type status messages.
   - If method is `"skipped_insufficient_data"` or `"skipped_no_electricity"`: no limitations displayed (the module didn't run, so caveats don't apply).

### Step 4 — Wire into Octopus flow (Low complexity)

In `continueWithProperty()`, after the Module 2 call (`await runExternalData(...)` at ~line 397), add:
```js
await runBaseloadSeparation(
  (text) => showProgress(text, undefined),
  (msg, type) => showStatus(msg, type)
);
```

### Step 5 — Wire into CSV flow (Low complexity)

In the CSV `btnCsvAnalyse` click handler, after the Module 2 call (~line 746), add:
```js
await runBaseloadSeparation(
  (text) => showCsvProgress(text),
  (msg, type) => showCsvStatus(msg, type)
);
```

### Step 6 — Error handling (Low complexity)

Wrap `separateBaseload()` call in try/catch matching the existing Module 2 pattern:
- On error: show error status message, log to console, do not block user from seeing Module 1+2 results.
- `getBaseloadResult()` returns null — downstream modules will guard on this.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `separateBaseload()` throws unexpectedly, breaking the Octopus/CSV flow | Wrap in try/catch matching Module 2 pattern. Show error status, don't block Module 1+2 results. |
| Module 2 result not available (weather fetch failed earlier) | Guard clause at top of `runBaseloadSeparation()` — if `getExternalResult()` is null, skip silently (Module 2 already showed the error). |
| Progress message ordering unclear to user | Use distinct progress text ("Separating heating demand…") that clearly follows the external data step. |
| Supplementary load messages overwhelming the user | Only show detection messages when relevant (detected or low confidence). Limitations shown as a compact group. Skipped/no-electricity cases produce no output. |
| Phrasing confusion between "supplementary" and "primary" electric heating | `electric_heating_is_primary` flag drives distinct phrasing. No-gas case says "heats with electricity" not "supplementary electric heating". |

---

## Success criteria

- [ ] Module 3 runs automatically after Module 2 in both Octopus and CSV flows
- [ ] Baseload method, daily baseload estimate, and validation status displayed to user
- [ ] All warnings from `baseload_metadata.warnings` surfaced in the UI
- [ ] Absence count displayed when absences detected
- [ ] Electric heating detection result displayed with appropriate phrasing and confidence level
- [ ] AC detection result displayed (three cases: detected, insufficient data, no signal)
- [ ] `electric_heating_is_primary` drives correct framing in no-gas case
- [ ] Limitations displayed when Step H regression ran; suppressed when skipped
- [ ] Failure in Module 3 does not prevent user from seeing Module 1+2 results
- [ ] `getBaseloadResult()` returns the stored result for downstream modules
- [ ] No new HTML elements needed — uses existing status/progress infrastructure

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-17
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `design/baseload-separation.md` § Dependencies (downstream consumers)

### Context

Pre-implementation review of the Module 3 orchestration and UI-wiring plan. Plan structure is sound — imports, method labels, orchestration pattern match the established Module 2 flow; error handling and guard clauses are in place; no new HTML required; scope split from Module 9 (full UI treatment) is correctly observed. Two LOW-severity clarifications for implementation.

### Clarifications to apply during implementation

**C1. Remove stale line-number anchors.** Steps 4 and 5 reference `~line 397` (the `runExternalData` call in `continueWithProperty`) and `~line 746` (the `runExternalData` call in the `btnCsvAnalyse` handler). Line numbers drift between sessions and are an anti-pattern per Praxis plan-authoring guidance. Function/handler names are the stable references — when applying these steps during implementation, anchor the insertion points as "immediately after the `runExternalData` call in `continueWithProperty()`" and similarly for the CSV handler. Update the plan body inline if revising; otherwise just apply during implementation and note in the Resolution section.

**C2. Dependency scope may need updating if 3a splits.** Header currently says "Depends on: Module 3a (must be implemented and verified first)". If plan 3a's H3 finding is actioned and 3a is split into `3a-gas-separation` + `3a-step-h-electric-detection`, update the dependency line to reference both resulting plans. If 3a stays single-plan, current wording is fine.

### Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0 | ✓ pass |
| HIGH | 0 | — |
| MEDIUM | 0 | — |
| LOW | 2 | ℹ apply during implementation |

**Verdict: APPROVE WITH CLARIFICATIONS** — implementable once C1 and C2 applied. Contingent on plan 3a (or its successors) completing first.

### Resolution of review changes

[To be completed by Sonnet during implementation. C1 and C2 applied; confirm disposition here.]

---

## Approval

**Status:** ✅ Approved — implementation may begin. 2 clarification(s) apply (see review below).
**Date:** 2026-04-17
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** C1 (line-number anchors removed in favour of function/handler names), C2 (dependency scope updated to reflect 3a's final structure).

---

## Implementation Deviations

[To be completed during implementation]
