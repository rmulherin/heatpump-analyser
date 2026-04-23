# Module 1 Patch — Tariff Windowing, Meter Stitching, M3b kWh Display

**Date:** 2026-04-23
**Status:** Awaiting review — review via claude.ai before implementation begins.
**Depends on:** M1 and M3b approved specs (no new design required)

---

## Task description

Three defects surfaced during M3b user testing. All fixes are to existing
M1 code (`js/data-ingestion.js`) and M3b orchestration (`js/app.js`).
M3a is unaffected (hypothesis eliminated). M4 implementation is blocked
until these are resolved — M4 consumes baseload output, and wrong values
propagate to HTC and every downstream number.

Authoritative specs:
- M1 plan: `docs/plans/module-1-data-ingestion.md`
- M3b plan: `docs/plans/module-3b-baseload-integration.md`
- M1 design: `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/data-ingestion.md`

---

## Investigation summary

### Hypothesis 3 eliminated first

Before investigating Symptoms 1 and 2, the M3a scaling hypothesis was checked.

All `/48` occurrences in `js/baseload.js`:
- Line 63: `(vals[mid-1] + vals[mid]) / 2` — median average
- Line 324: `(median(dailyTotals) ?? 0) / 48` — daily kWh → per-HH-slot (correct)
- Line 351: `tempVals.reduce(...) / 48` — mean of 48 temperature values (correct)
- Lines 387, 402, 498, 566: same pattern — all legitimate

**Hypothesis 3 is refuted.** No redundant scaling factor in M3a.

---

## Symptom 1 — 400 Bad Request on historical tariff rates

### Root cause (confirmed by code inspection)

`buildTariffTimeline` (`data-ingestion.js:278`) constructs the rate URL as:

```js
const ratesUrl = `...standard-unit-rates/?period_from=${validFrom}&period_to=${validTo}...`;
```

where `validFrom = agreement.valid_from` and `validTo = agreement.valid_to || now`.

These are the account-level agreement dates — when Rhiannon was on that tariff —
not the product's own validity window. Dated SVT products (e.g. `VAR-21-07-02`)
have a fixed live period. Querying the Octopus endpoint outside that window returns
400. Rhiannon's consumption window is ~19 months; the query extends well beyond the
`VAR-21-07-02` product's active dates.

`buildTariffTimeline` currently receives no `dataStart`/`dataEnd` parameters.
In `app.js`, `dataStart` and `dataEnd` are computed in Step 5 (normalisation)
**after** tariff rates are fetched in Step 4 — but the raw records are available
from `fetchedElecRecords` and `currentGasRecords` after gas unit confirmation (Step 3).

### Fix

**1a. Update `buildTariffTimeline` signature** in `js/data-ingestion.js`:

```js
export async function buildTariffTimeline(
  agreements, fuelType, paymentMethod, dataStart, dataEnd, onProgress
)
```

**1b. Clamp query window** per agreement inside the function:

```js
const qFrom = new Date(Math.max(new Date(validFrom), new Date(dataStart))).toISOString();
const qTo   = new Date(Math.min(
  new Date(validTo),
  new Date(dataEnd)
)).toISOString();
// Guard: if clipped window is zero-length, skip this agreement
if (new Date(qFrom) >= new Date(qTo)) continue;
```

Replace `validFrom`/`validTo` with `qFrom`/`qTo` in both the unit-rates and
standing-charges URL constructions (lines 278 and 304).

**1c. Compute bounds early in `app.js`** (`continueWithProperty`):

After gas unit confirmation (Step 3) and before tariff fetching (Step 4), add:

```js
const allTimestampsForBounds = [
  ...fetchedElecRecords.map(r => r.interval_start),
  ...currentGasRecords.map(r => r.interval_start),
].sort();
const dataStartBound = allTimestampsForBounds[0];
const dataEndBound   = allTimestampsForBounds[allTimestampsForBounds.length - 1];
```

Pass `dataStartBound` and `dataEndBound` to both `buildTariffTimeline` calls.

**Note:** The existing `allTimestamps` / `dataStart` / `dataEnd` computation in
Step 5 (normalisation) is unchanged — it is needed for `normaliseConsumption`.

### Tests

- **T1 — Single active tariff, full window:** Account on a current SVT (no `valid_to`)
  — query window is `[max(dataStart, agreement.valid_from), dataEnd]`. No regression.
- **T2 — Tariff switch mid-window:** Account with product A (Jan–Jun) followed by product B
  (Jul–present); data window Jan–Dec. Both products fetched; no 400; rate timeline has
  entries from both products.
- **T3 — Dated SVT outside data range:** `VAR-21-07-02` active Jul 2021–Apr 2023;
  data starts Aug 2021, ends Apr 2023. Clipped query window `[Aug 2021, Apr 2023]` —
  no 400. Query for the same product with data starting Jun 2021 (before product live)
  clips `period_from` to agreement start.

---

## Symptom 2 — Baseload estimate ~20× too low

### Root cause (confirmed by code inspection)

`fetchConsumptionStitched` (`data-ingestion.js:548–591`) concatenates raw records from all meters:

```js
allRecords.push(...data.results);  // line 571
```

No per-meter unit check or conversion is applied. The deduplication Map at line 580
resolves overlapping timestamps but does not touch `consumption` values. Records from
all meters are returned as-is.

`waitForGasConfirmation` (`app.js:437–451`) applies `convertM3ToKwh` to the **entire**
`fetchedGasRecords` array (or not at all):

```js
currentGasRecords = convertM3ToKwh(fetchedGasRecords);  // line 441
```

For Rhiannon's account, `fetchedGasRecords` is a stitched array where:
- Early records come from old SMETS1 meter (`E6S15259462261`) — kWh-native
- Recent records come from new SMETS2 meter (`G4A00159951501`) — m³-native

`buildGasUnitCheck` selects a summer month. Summer 2024/25 falls in the SMETS2 period,
so it operates on m³ values: ~0.5–0.7 m³/day instead of ~7–9 kWh/day. The sanity check
shows ~£0.03/day instead of ~£0.60/day.

If the user does NOT toggle m³ (perhaps because the £0.03 figure doesn't suggest the
expected prompt), `normaliseConsumption` receives m³ values for recent records. When
`separateBaseload` computes the summer baseload profile, those values (~0.7) are treated
as kWh, producing a baseload of ~0.7 kWh/day instead of ~8 kWh/day — approximately 11×
low. A compounding factor (seasonal mix between SMETS1 kWh data in winter and SMETS2 m³
data in summer) and the balance-point fallback can push this toward 20×.

If the user DOES toggle m³, `convertM3ToKwh` multiplies ALL records ×11.19 — including
the SMETS1 kWh records from the early period, inflating those by 11×. There is no correct
position for the single toggle.

### Fix

Per-meter unit detection and conversion before stitching.

**2a. Investigate Octopus API meter object**

`fetchAccount` (`data-ingestion.js:58–133`) collects `elecPoint.meters` and stores only
`serial_number` at the property level. The full meter object from the Octopus API may
include generation metadata (e.g. a `meter_type` or `is_smart_meter_120` flag).

Before implementing Fix 2b, use the debug getter added in Step 4 to inspect the raw meter
objects:

```js
window.__getIngestionResult()  // inspect .metadata.meters_detail
```

**Fix 2b depends on what the API returns:**

- **If meter type is available** in the meter object: map type to expected unit
  (SMETS1 → kWh, SMETS2 → m³) and convert m³ meters before stitching.
- **If meter type is NOT available**: implement the per-meter plausibility heuristic
  described in Fix 2c.

**2b. Modify `fetchAccount`** to store raw meter objects alongside serial numbers:

```js
properties.push({
  ...existing fields...,
  elecMeters,         // already returned (Phase 2 deviation D3 from M1 plan)
  gasMeters,          // already returned
  gasMeters_raw: gasMeters,  // full API objects — for unit detection
});
```

(If the full meter objects are already in `gasMeters`, no new field needed — just
inspect `gasMeters[i].meter_type` or equivalent.)

**2c. Per-meter plausibility heuristic** (fallback if API provides no type info):

In `fetchConsumptionStitched`, after fetching each meter's records, check the
first available summer month (July or August) if present:

```js
function inferGasUnit(records) {
  const summerRecs = records.filter(r => {
    const m = new Date(r.interval_start).getUTCMonth() + 1;
    return m === 7 || m === 8;
  });
  if (summerRecs.length < 48) return 'kwh'; // insufficient summer data — assume kWh (safer)
  const dailyValues = [];
  // group into days, take daily totals
  const byDay = new Map();
  for (const r of summerRecs) {
    const d = r.interval_start.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, 0);
    byDay.set(d, byDay.get(d) + r.consumption);
  }
  const vals = [...byDay.values()];
  const med = vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  return med < 2.0 ? 'm3' : 'kwh';
}
```

Threshold 2.0: summer m³/day is 0.2–1.8 for most households;
summer kWh/day is 3–12. Boundary risk is low.

**2d. Convert before stitching** in `fetchConsumptionStitched`:

```js
for (const meter of meters) {
  ...fetch records...
  if (data.results.length > 0) {
    const unit = inferGasUnit(data.results);
    const converted = unit === 'm3'
      ? convertM3ToKwh(data.results)
      : data.results;
    allRecords.push(...converted);
    serialsUsed.push(meter.serial_number);
    unitBySer[meter.serial_number] = unit;
  }
}
```

Return `unitBySer` from `fetchConsumptionStitched` so `app.js` can record
per-meter unit state in `metadata`.

**2e. Update `waitForGasConfirmation` and gas check UI:**

The per-meter detection means the gas check UI can now confirm detected units:
- Show a line per meter if detection ran: "Meter E6S...: kWh (native) | Meter G4A...: m³ → converted"
- Retain a single "override" toggle: "Override: treat all gas data as m³" (advanced)
  — applies `convertM3ToKwh` to records that were NOT already converted

Update `gas_unit_source` in `metadata` to reflect the detected state (e.g.
`'m3_converted_per_meter'` when mixed).

**2f. Total-kWh assertion in success summary:**

After normalisation, display total gas kWh over the data span:
- Add to the `showSuccessSummary` `<dl>`: "Total gas consumption: X,XXX kWh over N days"
- Add guidance note: "Compare to your annual figure in the Octopus app. They should
  be within ~5%. If the figure looks wrong, use the unit override above."

### Tests

- **T4 — Single SMETS1 kWh meter:** No conversion; `gas_unit_source = 'kwh_native'`;
  total kWh in summary matches raw sum.
- **T5 — Single SMETS2 m³ meter:** `inferGasUnit` returns `'m3'`; conversion applied;
  total kWh = raw sum × 11.19 (±0.01%).
- **T6 — Two gas meters, SMETS1 (early) + SMETS2 (recent):** Per-meter detection;
  SMETS1 records untouched; SMETS2 records converted; stitched array is fully kWh;
  no 11× inflation of early records; gas sanity check shows ~£0.60/day summer.
- **T7 — Total-kWh assertion:** Post-fix total gas kWh over data period is within
  ±5% of Rhiannon's Octopus-app annual figure (she supplies this value before
  the verification step).

---

## Symptom 3 — Plan deviation: kWh not clearly visible in M3b

### Investigation

Code inspection of `runBaseloadSeparation` (`app.js:625–628`):

```js
showStatusFn(
  `Baseload separation complete. Method: ${methodLabel}. Daily non-heating gas: mean ${meanStr} kWh/day, median ${medianStr} kWh/day.${validationStr}${absenceStr}`,
  'info'
);
```

The kWh label IS present in the code. However, with m³ data in the pipeline,
`baseload_mean_kwh_per_day` ≈ 0.07 (actually m³/day, mislabelled as kWh).
The status message displays `mean 0.1 kWh/day` — numerically similar to a
pence-per-day cost and indistinguishable from a £-display bug without debug access.

**The deviation:** M3b plan Step 3 item 5 specifies kWh/day. The code complies with
that literal spec. But the plan does not specify showing a £ equivalent alongside the
kWh value, and without it the output cannot be cross-checked against the Octopus app
during testing. A user (or developer) cannot tell whether a low kWh figure is a unit
bug or a display bug. This is the gap.

**After Symptom 2 is fixed**, the kWh values will be correct (~8 kWh/day) and the
primary ambiguity will be resolved. The fix below adds the £ cross-check to make
future testing unambiguous.

### Fix

**3a. Add £/day equivalent to M3b status message** in `runBaseloadSeparation`:

```js
// Derive gas rate from ingestion tariff rates
const ingestion = getIngestionResult();
let gasPKwh = null;
if (ingestion?.tariff_rates?.gas?.length > 0) {
  const rates = ingestion.tariff_rates.gas;
  gasPKwh = rates[rates.length - 1].rate_p_kwh;  // most recent rate
}

const costStr = (gasPKwh !== null && !isNaN(gasPKwh))
  ? ` (≈ £${((meta.baseload_mean_kwh_per_day * gasPKwh) / 100).toFixed(2)}/day)`
  : '';

showStatusFn(
  `Baseload separation complete. Method: ${methodLabel}. Daily non-heating gas: mean ${meanStr} kWh/day${costStr}, median ${medianStr} kWh/day.${validationStr}${absenceStr}`,
  'info'
);
```

If no gas tariff is available (CSV path with no gas rate), `costStr` is empty —
the kWh values are shown without conversion. No error, no crash.

**3b. Record deviation in M3b plan** — append to `docs/plans/module-3b-baseload-integration.md`
Deviations section:

> **D3 — £/day equivalent added to daily baseload display (post-launch patch)**
> M3b plan Step 3 item 5 specifies kWh/day display. Implementation complied literally.
> During user testing (2026-04-23), the kWh value (0.07 kWh/day with m³ data) was
> indistinguishable from a £ figure without a reference. Patch adds an optional
> £/day equivalent derived from `tariff_rates.gas[last].rate_p_kwh`. Shown only when
> a gas rate is available; omitted on CSV path without gas tariff.

### Tests

- **T8 — kWh displayed correctly post-fix:** After Symptom 2 fix, status message shows
  `mean ~8.0 kWh/day` for a typical household (not ~0.07).
- **T9 — £ equivalent shown when tariff available:** Status message includes
  `≈ £0.44/day` (at ~5.5p/kWh) for ~8 kWh/day baseload; matches Rhiannon's
  Octopus-app figure within 10%.

---

## Step 4 — Debug getters

Add to `js/app.js` (window-level only — not exported from the module):

```js
// debug-only — remove before release
window.__getIngestionResult = () => getIngestionResult();
window.__getBaseloadResult = () => getBaseloadResult();
```

These are needed immediately to inspect raw meter objects (Symptom 2 Fix 2a) and
verify per-meter unit detection. They should be removed in a later cleanup commit
(note in TODO comment).

### Tests

- **T10 — Getter before load:** `window.__getIngestionResult()` returns `null` before any
  data is fetched.
- **T11 — Getter after Octopus load:** Returns full ingestion result including `metadata`,
  `consumption`, and `tariff_rates`.
- **T12 — Getter after baseload:** `window.__getBaseloadResult()` returns full baseload
  result including `heating`, `baseload_metadata`, and `supplementary_loads`.

---

## Files to modify

| File | Change |
|------|---------|
| `js/data-ingestion.js` | `buildTariffTimeline`: add `dataStart`, `dataEnd` params; clamp per-agreement query window |
| `js/data-ingestion.js` | `fetchConsumptionStitched`: add `inferGasUnit`; convert per-meter before stitching; return `unitBySer` |
| `js/data-ingestion.js` | `fetchAccount`: confirm full meter objects are available (or add `meters_detail` field) |
| `js/app.js` | Compute `dataStartBound`/`dataEndBound` from raw records before tariff fetch; pass to both `buildTariffTimeline` calls |
| `js/app.js` | Update `waitForGasConfirmation` to show per-meter detection results; update `gas_unit_source` metadata |
| `js/app.js` | `showSuccessSummary`: add total gas kWh line with assertion guidance |
| `js/app.js` | `runBaseloadSeparation`: add optional £/day equivalent to kWh display |
| `js/app.js` | Add debug getters (`window.__getIngestionResult`, `window.__getBaseloadResult`) |
| `docs/plans/module-3b-baseload-integration.md` | Append D3 to Deviations section |

---

## Done when

- [ ] T1–T3: Tariff timeline fetches without 400 for dated SVT products; tariff switch test passes
- [ ] T4–T6: Per-meter unit detection correct for SMETS1, SMETS2, and mixed configurations
- [ ] T7: Total gas kWh within ±5% of Rhiannon's Octopus-app annual figure (value TBC)
- [ ] T8–T9: M3b status shows correct kWh and £/day values post-fix
- [ ] T10–T12: Debug getters return correct state before and after data load
- [ ] M3b plan Deviations section updated with D3 entry

---

## Not in scope

- M4 implementation — separate track, currently under architect review
- M3a changes — hypothesis 3 eliminated; no changes required
- UI redesign of the gas sanity check section — functional fix only
- Production removal of debug getters — deferred to a later cleanup commit

---

## Open question for Opus review

**Symptom 2 Fix 2a:** Does the Octopus API meter object (returned in `gas_meter_points[N].meters[N]`) include a field identifying the meter generation (SMETS1/SMETS2) or unit type? If so, the `inferGasUnit` heuristic can be replaced with a direct lookup. If not, the heuristic stands. This can be resolved by running the tool after adding the debug getter and inspecting `window.__getIngestionResult()` — but clarifying it here would allow the implementation plan to be more precise.

If meter generation IS available in the API: remove `inferGasUnit` and replace with a
lookup table keyed on meter type. If NOT available: `inferGasUnit` as specified above.

---

## Claude.ai Review — yyyy-mm-dd

**Reviewer:** Claude (Praxis Insight — Opus architect window)

**Overall verdict:** [Approved / Approved with clarifications / Revise and resubmit]

### What is solid

[What the plan gets right. Be specific.]

### Clarifications required before implementation

[Any ambiguity, missing specification, or underdefined behaviour that would force
Claude Code to make an undocumented decision mid-build. Each item must include
the resolution — not just the problem.]

### Minor observations (not blockers)

[Optional. Suggestions for V2, style notes, things to keep in mind.]

---

## Approval

**Status:** Awaiting review — yyyy-mm-dd
**Approved by:** [Rhiannon (via Opus review)]
**Clarifications confirmed:** [None yet]

---

## Implementation Deviations

[None — not yet implemented.]
