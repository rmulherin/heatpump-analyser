# Bug: m³ detection fires but conversion not applied to panel values

**Date:** 2026-04-30
**Reporter:** Rhiannon
**Status:** Investigating — clarification needed (see Phase 4)

## Symptom

Gas meter unit detection now correctly identifies Rhiannon's meter as m³ (checkbox is
pre-filled/ticked on load). However, the cost estimate shown in the gas sanity check
panel is the same wrong figure as before detection was added — suggests the panel is
displaying unconverted m³ values as if they were kWh.

## Secondary concern (design)

The checkbox says "My meter reads in m³" (ticked). Rhiannon expected:
- The conversion auto-applied so panel values display in correct kWh
- OR the checkbox label flipped to "My meter reads in kWh" (unticked) so she can
  just hit Continue without having to interrogate confusing panel values

## Environment

- Vanilla JS, no build step
- Rhiannon's real Octopus data — gas meter confirmed m³
- Multiple gas meters (required for the detection path — see Phase 3)

---

## Phase 1 — Observations

### Code path for m³ detection (Tier 1)

Detection only fires when:
1. `hasMultipleGasMeters === true` (prop.gasMeters.length > 1) — confirmed by the fact
   that the toggle IS pre-checked (it is the only code path that sets it to true)
2. `fetchConsumptionStitched` is called for gas → Tier 1 path fires (newest meter covers
   ≥90% of lookback window) → returns `{ records: sorted_raw_m3, gasUnitSource: null, detectedUnit: 'm3' }`

Key: Tier 1 returns **raw unconverted m³ records** with `gasUnitSource: null`.

### What the toggle-setting code does (app.js:491–496)

```
if (gasResult.gasUnitSource) detectedGasUnitSource = gasResult.gasUnitSource;
  → detectedGasUnitSource stays null (gasUnitSource is null in Tier 1)
if (gasResult.detectedUnit === 'm3') gasM3Toggle.checked = true;
  → toggle IS set to true ✓
```

### What the sanity check display does (app.js:533)

```javascript
const check = buildGasUnitCheck(gasRecords, gasRate);
```

`gasRecords` at this point = `fetchedGasRecords` = **raw m³ records**. These are passed
to `buildGasUnitCheck` which calculates £/day values treating the m³ consumption numbers
as if they were kWh. Result: tiny, wrong cost values displayed in the panel. E.g. a 0.3 m³
summer day shows as "0.3 kWh" instead of ~3.4 kWh — same wrong figures as before
detection was added.

### Contrast: Tier 2 path

Tier 2 (actual stitching, `anyM3Detected = true`) converts records inline and returns
`gasUnitSource: 'm3_converted_per_meter'`. For that path:
- `gasRecords` passed to `buildGasUnitCheck` are already converted → panel shows correct kWh ✓
- `detectedGasUnitSource` = `'m3_converted_per_meter'` → toggle set to false + disabled
  (conversion already done, no user action needed) ✓

**Tier 1 and Tier 2 are inconsistent**: Tier 2 gives correct panel values; Tier 1 gives
raw m³ values in the panel despite the toggle being pre-checked.

### What happens when Continue is clicked (app.js:735–742)

```javascript
if (detectedGasUnitSource === 'm3_converted_per_meter') {  // false for Tier 1
  currentGasRecords = fetchedGasRecords;
} else if (gasM3Toggle.checked) {                          // true — toggle was pre-checked
  currentGasRecords = convertM3ToKwh(fetchedGasRecords);  // conversion IS applied here ✓
}
```

**Conversion IS applied when Continue is clicked.** Downstream analysis (M3–M9) should
receive correct kWh values. The wrong estimate is in the panel display only, not in the
final analysis — pending confirmation (see Phase 4).

---

## Phase 2 — Hypotheses

1. **[HIGH] Tier 1 sanity check uses pre-conversion records.** `buildGasUnitCheck` is
   called before conversion at line 533. For Tier 1 m³ detection, `gasRecords` are still
   raw m³ at that point. Panel values are wrong. Conversion only applies after Continue.
   Evidence: confirmed by reading the code path above.

2. **[LOW] Downstream analysis is also wrong.** If `currentGasRecords` is never set to
   converted records, the analysis would also be wrong. Evidence against: code inspection
   shows conversion IS applied in `waitForGasConfirmation` when toggle is checked.
   **Requires confirmation (see Phase 4).**

3. **[LOW] Toggle not actually checked when panel is shown.** Some other code path
   overrides the toggle state. Evidence against: only one code path sets it to true
   (line 493) and only one path sets it back to false (line 551, gated on
   `detectedGasUnitSource === 'm3_converted_per_meter'` which is null for Tier 1).

---

## Phase 3 — Narrowing

Minimal failing case: Tier 1 gas detection path.

| Step | What happens | Correct? |
|------|-------------|---------|
| `fetchConsumptionStitched` Tier 1 | Returns raw m³ records + `detectedUnit: 'm3'` | ✓ |
| Toggle set to true (app.js:493) | `gasM3Toggle.checked = true` | ✓ |
| Sanity check built (app.js:533) | Uses raw m³ records — wrong panel values | ✗ |
| Continue clicked | `convertM3ToKwh(fetchedGasRecords)` called | ✓ |
| Downstream analysis | Receives converted records | ✓ (unconfirmed) |

**Root issue in panel display:** `buildGasUnitCheck(gasRecords, gasRate)` should receive
converted records when m³ has been detected. Currently it always receives raw records.

---

## Phase 4 — Root Cause and Clarification Needed

**Panel display bug (confirmed):**
For the Tier 1 detection path, `buildGasUnitCheck` is called with raw m³ records. The
panel shows m³ values treated as kWh — wrong cost estimates. This is a genuine bug.

**Fix:** Before calling `buildGasUnitCheck`, if `gasM3Toggle.checked === true` (Tier 1
m³ detection), build the check using converted records:

```javascript
const recordsForCheck = gasM3Toggle.checked
  ? convertM3ToKwh(gasRecords)
  : gasRecords;
const check = buildGasUnitCheck(recordsForCheck, gasRate);
```

This aligns Tier 1 behaviour with Tier 2 (which already shows converted values in the panel).

---

## Clarification needed before proceeding

**Question for Rhiannon:** After clicking Continue on the gas sanity check, does the
downstream analysis (cost estimate in the results) appear correct? Or is the final
analysis figure also wrong?

Code inspection suggests the final analysis IS correct (conversion is applied on Continue).
If confirmed, only the panel display needs fixing. If the final analysis is also wrong,
Phase 2 hypothesis 2 holds and further investigation is needed.

---

## Design concern (separate from the bug)

The checkbox label and flow design is a separate question. Current behaviour after the
panel-display bug is fixed:
- Panel shows correct converted kWh values
- Checkbox says "My meter reads in m³" (ticked)
- User clicks Continue → proceeds

Rhiannon's expected UX:
- Checkbox says "My meter reads in kWh" (unticked = my meter is NOT kWh = m³ assumed)
- User does not need to read or interact with the checkbox — just Continue

This is a design change (inverted checkbox semantics) that needs Opus review before
implementation. Flagging as secondary concern — not fixing inline.

## Fix Applied

**Changes (two in one commit):**

1. **Panel display (bug):** `buildGasUnitCheck` now receives converted records when m³
   is detected (`recordsForCheck = gasM3Toggle.checked ? convertM3ToKwh(gasRecords) : gasRecords`).
   Tier 2 path unaffected (toggle is false, records already converted).

2. **Label wording (design):** Label text is now dynamic:
   - Checked: "Yes, my meter reads in cubic metres (m³)"
   - Unchecked: "No, my meter reads in cubic metres (m³)"
   - `updateGasM3Label()` called after every programmatic toggle state change and on
     user `change` event. Default HTML text set to "No…" (matches unchecked default).

**Fix source:** Category A — direct from root cause; label wording and behaviour specified by Rhiannon.

**Amendment (commit ea81b39):** Removed `gasM3Toggle.addEventListener('change', updateGasM3Label)`.
Label is set by detection only — manual toggle does not update label text.

## Verification

- [ ] Panel shows correct kWh values when m³ detected (pre-ticked)
- [ ] Label reads "Yes, my meter reads in cubic metres (m³)" when pre-ticked
- [ ] Label reads "No, my meter reads in cubic metres (m³)" when unticked
- [ ] Label updates when user manually toggles the checkbox
- [ ] No regression — kWh meter path still shows raw (kWh) values in panel

## Status: Verification pending (browser)
