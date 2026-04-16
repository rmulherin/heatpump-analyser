# Module 3b — Baseload Separation: Orchestration & UI Integration

**Date:** 2026-04-16
**Status:** Awaiting approval — review via claude.ai before implementation begins.
**Depends on:** Module 3a (must be implemented and verified first)

---

## Task description

Wire the baseload separation module (`js/baseload.js` from Phase 3a) into the app orchestration and display results, warnings, and method transparency to the user. This phase connects the pure computation to the running application.

---

## Research findings

**Existing pattern:** Module 2 integration in `app.js` (lines 467–555, `runExternalData()`) establishes the orchestration pattern:
- Retrieve upstream result via getter (`getIngestionResult()`, `getExternalResult()`)
- Run computation steps with progress callbacks
- Store result via setter (`setExternalResult()`)
- Display summary and warnings via `showStatus()`

Module 3 will follow this identical pattern.

**UI approach:** No new HTML sections needed for this phase. Warnings and status messages use the existing `showStatus()` / `showCsvStatus()` infrastructure. The baseload summary (method used, daily baseload, absence count) appends to the existing results display. The HH heatmap visualisation is Module 9 scope, not this module.

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

### Step 2 — `runBaseloadSeparation()` orchestration function (Medium complexity)

Add function `runBaseloadSeparation(showProgressFn, showStatusFn)`:

1. Retrieve upstream data:
   ```js
   const ingestion = getIngestionResult();
   const externalResult = getExternalResult();
   if (!ingestion || !externalResult) return;
   ```
2. Show progress: `'Separating heating demand from baseload…'`
3. Call `separateBaseload(ingestion.consumption, externalResult.external)`.
4. Store result via `setBaseloadResult(result)`.
5. Display summary status message:
   - Method used (human-readable label)
   - Daily baseload (mean and median from metadata)
   - Absence days detected
   - Validation status
6. Display each warning from `result.baseload_metadata.warnings` via `showStatusFn(warning, 'warning')`.
7. If `validation_status === "poor"`, show the R² warning as a warning-type status.

### Step 3 — Wire into Octopus flow (Low complexity)

In `continueWithProperty()`, after the Module 2 call (`await runExternalData(...)` at line ~397), add:
```js
await runBaseloadSeparation(
  (text) => showProgress(text, undefined),
  (msg, type) => showStatus(msg, type)
);
```

### Step 4 — Wire into CSV flow (Low complexity)

In the CSV `btnCsvAnalyse` click handler, after the Module 2 call (~line 746), add the same pattern:
```js
await runBaseloadSeparation(
  (text) => showCsvProgress(text),
  (msg, type) => showCsvStatus(msg, type)
);
```

### Step 5 — Method label mapping (Low complexity)

Add a helper function (or object) in `app.js` to map method codes to user-facing labels:
```js
const BASELOAD_METHOD_LABELS = {
  'summer-hh-profile-weekday-split': 'Summer weekday/weekend profile (best)',
  'summer-hh-profile-flat': 'Summer profile (no weekday/weekend split)',
  'summer-daily-flat': 'Summer daily average (limited summer data)',
  'balance-point': 'Warm-weather estimation (no summer data)',
  'literature-default': 'UK average estimate (insufficient data)',
  'no-gas': 'No gas supply detected',
};
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `separateBaseload()` throws unexpectedly, breaking the Octopus/CSV flow | Wrap in try/catch matching the existing Module 2 pattern. Show error status, don't block the user from seeing Module 1+2 results. |
| Module 2 result not available (weather fetch failed earlier) | Guard clause at top of `runBaseloadSeparation()` — if `getExternalResult()` is null, skip silently (Module 2 already showed the error). |
| Progress message ordering unclear to user | Use distinct progress text ("Separating heating demand…") that clearly follows the external data step. |

---

## Success criteria

- [ ] Module 3 runs automatically after Module 2 in both Octopus and CSV flows
- [ ] Baseload method, daily baseload estimate, and validation status displayed to user
- [ ] All warnings from `baseload_metadata.warnings` surfaced in the UI
- [ ] Absence count displayed when absences detected
- [ ] Failure in Module 3 does not prevent user from seeing Module 1+2 results
- [ ] `getBaseloadResult()` returns the stored result for downstream modules
- [ ] No new HTML elements needed — uses existing status/progress infrastructure

---

## Claude.ai Review — yyyy-mm-dd

**Reviewer:** Claude (claude.ai)

**Overall verdict:** [Pending]

---

## Approval

**Status:** [Pending]

---

## Implementation Deviations

[To be completed during implementation]
