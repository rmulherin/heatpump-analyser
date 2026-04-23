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

The fix has two tiers. Tier 1 handles Rhiannon's case (new meter has years of data)
and will resolve the immediate bug. Tier 2 handles the general stitching case where
per-meter unit detection is genuinely needed.

**2a. Tier 1 — Newest-meter-sufficient check (primary path)**

At the start of `fetchConsumptionStitched`, before iterating all meters, fetch records
from the **newest** meter only (last element of the `meters` array). Compute the span
covered:

```js
const newestMeter = meters[meters.length - 1];
// ... fetch newestData from newestMeter ...
if (newestData.results.length > 0) {
  const ts = newestData.results.map(r => new Date(r.interval_start).getTime());
  const spanDays = (Math.max(...ts) - Math.min(...ts)) / (24 * 60 * 60 * 1000);
  if (spanDays >= 365) {
    // Newest meter covers the full lookback window — use it alone
    const sorted = newestData.results.sort(
      (a, b) => new Date(a.interval_start) - new Date(b.interval_start)
    );
    return {
      records: sorted,
      serialsUsed: [newestMeter.serial_number],
      metersStitched: false,
    };
  }
}
```

When this path triggers, the returned array is from a single meter.
The existing all-or-nothing `convertM3ToKwh` toggle in `waitForGasConfirmation`
applies correctly to a single-unit array — no per-meter detection needed.
`gas_unit_source` remains `'kwh_native'` or `'m3_converted'` as set by the toggle,
same as the single-meter path.

**2b. Tier 2 — Per-meter unit detection (stitching path)**

Only reached when the newest meter spans <12 months. Apply a plausibility heuristic
per meter before stitching. Private helper `inferGasUnit` in `data-ingestion.js`
(gas only — electricity is always kWh from the Octopus API):

```js
function inferGasUnit(records) {
  const summerRecs = records.filter(r => {
    const m = new Date(r.interval_start).getUTCMonth() + 1;
    return m === 7 || m === 8;
  });
  if (summerRecs.length < 48) return 'kwh'; // insufficient summer data — assume kWh (safer)
  const byDay = new Map();
  for (const r of summerRecs) {
    const d = r.interval_start.slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + r.consumption);
  }
  const vals = [...byDay.values()].sort((a, b) => a - b);
  const med = vals[Math.floor(vals.length / 2)];
  return med < 2.0 ? 'm3' : 'kwh';
}
```

Threshold 2.0: summer m³/day is 0.2–1.8 for most households;
summer kWh/day is 3–12. Boundary risk is low.

Within the existing meter-iteration loop (for the stitching path), convert before
appending:

```js
for (const meter of meters) {
  // ... fetch data ...
  if (data.results.length > 0) {
    const unit = fuelType === 'gas' ? inferGasUnit(data.results) : 'kwh';
    const converted = unit === 'm3' ? convertM3ToKwh(data.results) : data.results;
    allRecords.push(...converted);
    serialsUsed.push(meter.serial_number);
  }
}
```

`gas_unit_source` in metadata: set to `'m3_converted_per_meter'` when the stitching
path fires and any meter was detected as m³. The all-or-nothing toggle is suppressed
on this path (records are already in kWh).

**2c. Total-kWh assertion in success summary:**

After normalisation, display total gas kWh over the data span:
- Add to `showSuccessSummary` `<dl>`: "Total gas consumption: X,XXX kWh over N days"
- Add guidance note: "Compare to your annual figure in the Octopus app. They should
  be within ~5%. If the figure looks wrong, use the unit override above."

### Tests

- **T4 — Single SMETS1 kWh meter (no change):** No conversion; `gas_unit_source = 'kwh_native'`;
  total kWh matches raw sum.
- **T5 — Single SMETS2 m³ meter (no change):** User toggles m³; `convertM3ToKwh` applied
  to single-unit array; `gas_unit_source = 'm3_converted'`; total kWh = raw sum × 11.19 (±0.01%).
- **T6a — Two gas meters, newest has >12m data (Rhiannon's case):** Tier 1 path fires;
  only newest meter's records returned; `metersStitched = false`; single-unit array;
  m³ toggle operates correctly on a single-unit array.
- **T6b — Two gas meters, newest has <12m data:** Tier 2 path fires; `inferGasUnit`
  called per meter; SMETS1 records untouched; SMETS2 records converted; stitched array
  is fully in kWh; toggle suppressed.
- **T7 — Total-kWh assertion:** Post-fix total gas kWh over data period is within
  ±5% of Rhiannon's Octopus-app annual figure (she supplies this value before the
  verification step).

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
| `js/data-ingestion.js` | `fetchConsumptionStitched`: add Tier 1 newest-meter check; add `inferGasUnit` + per-meter conversion for Tier 2 stitching path |
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

**Symptom 2 — Tier 1 threshold:** The plan uses 365 days as the "newest meter sufficient"
threshold. The lookback window is also 365 days (`CONFIG.LOOKBACK_MS`). Is this the right
threshold, or should it be slightly shorter (e.g. 350 days) to account for minor data gaps
at the meter installation date? The stitching path is only needed when the newer meter
genuinely lacks enough history; a few missing days at the boundary shouldn't trigger it.

---

## Opus Review — 2026-04-23

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Authoritative specs:** `docs/plans/module-1-data-ingestion.md`,
`docs/plans/module-3b-baseload-integration.md`, and
`~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/data-ingestion.md`.

**Overall verdict:** APPROVE WITH CLARIFICATIONS — core approach is sound; 2
HIGH-severity items and 3 MEDIUM items need resolution before implementation.

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0 | ✓ pass |
| HIGH | 2 | resolve before implementation |
| MEDIUM | 3 | resolve before implementation |
| LOW | 3 | apply during implementation |

### What is solid

- **Hypothesis 3 eliminated first.** Code-inspection of all `/48` occurrences
  in `baseload.js` before proposing any M3a changes is exactly the right
  discipline. Saves wasted work and matches the memory "don't touch M3a unless
  grep confirms".
- **Symptom 1 root-cause analysis is correct.** Account-level agreement dates
  vs product-level validity is a real distinction in the Octopus API. The
  clamping fix (per-agreement `[max(dataStart, valid_from), min(dataEnd, valid_to)]`)
  is the right shape. Placing `dataStartBound` derivation after Step 3 but
  before Step 4 is a clean ordering change.
- **Two-tier meter approach is pragmatic.** Using the newest-meter-sufficient
  check to avoid engaging per-meter detection when the newest meter has
  enough data is the right simplification. It keeps the existing single-unit
  toggle semantics intact for the common case (including Rhiannon's), and
  only adds heuristic complexity where genuinely needed.
- **£/day cross-check (Fix 3a) is useful diagnostic infrastructure.** Good
  instinct — having a tariff-converted value alongside kWh makes future
  user-testing anomalies immediately distinguishable from display bugs.
- **T7 assertion against real Octopus annual figure.** Ground-truth testing
  against the user's own billed data is the right bar for a consumer tool
  where "plausible but wrong" is the primary failure mode.

### Clarifications required before implementation

**H1 — "Newest meter" identification is not robust (Fix 2a).**

The plan uses `meters[meters.length - 1]` to identify the newest meter. The
Octopus account endpoint does not guarantee array ordering by install or
activity date. If the account returns meters in a different order (e.g. by
serial number, or in the order they were registered which may differ from
installation order), Tier 1 fires on the wrong meter — potentially the
stale one — and the fix actively regresses correctness for accounts like
Rhiannon's.

The existing M1 plan already identifies the "most recent" meter when
setting `elecSerial`/`gasSerial`. That logic — whatever it does — is the
correct reference point and should be reused. If it depends on
`elecMeters`/`gasMeters` array ordering itself, that needs auditing too.

**Resolution required:** Explicitly identify the newest meter by a stable
criterion (most likely `install_date` or `effective_from` descending, or
whatever field the existing `elecSerial`/`gasSerial` selection uses). Do
not rely on array index. State the criterion in the plan body of Fix 2a,
and confirm it is consistent with the existing M1 "most recent" selection.

**H2 — `inferGasUnit` threshold misclassifies low-consumption households
(Fix 2b).**

The 2.0 summer-kWh/day threshold is too high for edge cases that exist in
the target user base:
- Gas-cooking-only households (no gas hot water, no gas heating for hot
  water): real summer daily gas ~0.2–0.8 kWh/day. Would be misdetected as
  m³ and spuriously multiplied ×11.19.
- Very small households or flats with combi boilers: summer daily gas can
  be 1.0–2.0 kWh/day. Edges directly against the threshold.
- Holiday homes or second homes with low summer use.

These users are not Rhiannon's 6 kWh/day case, but they are within the
public tool's target audience. The boundary risk is not "low" as stated.

**Resolution required:** Either (a) tighten the heuristic — typical m³ daily
summer values are 0.2–1.8 and typical kWh daily summer values are 3–12,
so a threshold in the gap (e.g. 2.5 with an additional "at least one day
in the window ≥ 0.5" sanity check) would be safer; OR (b) combine the
numeric heuristic with an explicit user-visible confirmation step before
stitching when the inferred unit for a stitched meter differs from the
existing meter's unit. Document the chosen approach and its failure modes
in the plan body. The fallback "insufficient summer data → assume kWh" is
correct and should be preserved.

**M1 — T3 test case depends on stubbed product-date data.**

T3 asserts `VAR-21-07-02` is "active Jul 2021–Apr 2023". Octopus does not
publish product end dates in a way that the tool can rely on programmatically,
and those specific dates are not verified in the plan. T3 as written implies
the test calls the real Octopus API — which would be flaky, tariff-specific,
and likely rate-limited in automation.

**Resolution required:** Restate T3 as a unit test that stubs
`buildTariffTimeline`'s network layer. The assertion is on the constructed
URL's `period_from` / `period_to` parameters for each agreement, NOT on the
live API response. Two stubbed agreements — one inside the data window, one
partially outside — with assertions that the clipped URL parameters match
expectations. Live end-to-end validation against Rhiannon's own account
(which does produce the 400 today) can remain as an informal verification
step but is not the primary test.

**M2 — Tier 1 threshold: 365 vs something shorter.**

Open question at the end of the plan. Verdict: use **`0.9 × CONFIG.LOOKBACK_MS`
(approximately 328 days)** rather than a hard-coded 365 or 350.

Rationale:
- The threshold should track `LOOKBACK_MS`, not be a parallel constant.
  If `LOOKBACK_MS` ever changes, 365 becomes incoherent.
- A 10% margin (approximately one month) is generous enough to absorb
  install-date boundary gaps without letting a genuinely too-short newest
  meter through the Tier 1 gate.
- Over-firing Tier 2 when Tier 1 would have sufficed is a correctness
  hazard (more code paths to validate), so we want Tier 1 to trigger
  liberally.

**Resolution required:** Update Fix 2a to use the relative threshold,
document the 90% choice inline, and add a test (T6c) for a newest meter
with 340 days of data — should trigger Tier 1, not Tier 2.

**M3 — `gas_unit_source = 'm3_converted_per_meter'` is a new enum value.**

The plan introduces a new value for the `gas_unit_source` metadata field.
Any downstream consumer that reads this field (UI warnings, debug output,
future modules) now needs to handle three values where it previously
handled two.

**Resolution required:** Before implementation, confirm via grep that no
downstream code branches on specific `gas_unit_source` values (e.g.
`if (metadata.gas_unit_source === 'm3_converted') { ... }`). If any
does, add an explicit case or switch for the new value — do not rely on
a fallthrough default. List affected call-sites in the plan body.

### Minor observations (not blockers)

**L1 — Debug getters removal timeline.** Fix Step 4 adds `__getIngestionResult`
and `__getBaseloadResult` on `window` as debug-only, with a TODO comment for
later removal. "Not in scope: Production removal of debug getters — deferred
to a later cleanup commit." Fine to defer, but name the trigger in the plan:
either "remove in the next M1 patch after M4 user-test passes" or "keep
through launch, remove in post-launch cleanup". Ambiguous TODOs rot.

**L2 — T7 ground-truth-figure procedure.** The plan notes Rhiannon will
supply her Octopus-app annual gas kWh for the T7 assertion but does not
specify when — pre-implementation (so Sonnet tests against it before
committing) or post-implementation (so Rhiannon re-runs user-test). Flag
in the plan: Sonnet should request the number before starting
implementation so T7 is a real gate, not a post-hoc verification.

**L3 — Call-site compatibility for Tier 1 return shape.** `fetchConsumptionStitched`
now returns `metersStitched: false` in the Tier 1 path. Confirm no existing
caller treats this field as always-true or always-set. A quick grep
documented in the plan would close this.

---

**Verdict:** APPROVE WITH CLARIFICATIONS — resolve H1, H2, M1, M2, M3 inline
in plan body before implementation begins. L1–L3 can be applied during
implementation and noted in the Deviations section. Once the HIGH items
are resolved, the plan is implementable without further review.

---

## Approval

**Status:** Awaiting review — yyyy-mm-dd
**Approved by:** [Rhiannon (via Opus review)]
**Clarifications confirmed:** [None yet]

---

## Implementation Deviations

[None — not yet implemented.]
