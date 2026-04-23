# Module 1 Patch — Tariff Windowing, Meter Stitching, M3b kWh Display

**Date:** 2026-04-23
**Status:** ⚠ Approved with edits — 2026-04-23. H1–H3 + M1–M3 applied inline per Design Review below; L1–L3 apply during implementation per Resolution.
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
- **T3 — Dated SVT outside data range (stubbed URL-parameter test):** With
  `buildTariffTimeline`'s network layer stubbed, supply an agreement whose
  product is stubbed as "live Jul 2021 – Apr 2023". Data window Jun 2021 – Dec
  2023. Assert that the constructed URL's `period_from` clips to the
  agreement's `valid_from` (not the earlier data start) and `period_to` clips
  to the agreement's `valid_to` (not the later data end). No live API call.
  Live-end-to-end verification against Rhiannon's own account — where the
  current code produces a 400 — remains as an informal post-fix check.

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

At the start of `fetchConsumptionStitched`, before iterating all meters,
fetch records from the **newest meter** only. "Newest" is identified by the
**same stable criterion used by the existing `elecSerial`/`gasSerial`
'most recent' selection** from M1 Phase 2 (deviation D3) — typically by
`install_date` or `effective_from` descending. **Do not rely on array
index.** If the existing "most recent" selection itself depends on array
ordering, audit and fix as part of this patch (add the affected function
to Files to modify).

The threshold for "newest meter sufficient" is `0.9 × CONFIG.LOOKBACK_MS`
(~328 days at the current 365-day lookback), not a hard-coded 365.
Tracking a relative fraction of `LOOKBACK_MS` keeps the threshold coherent
if the lookback ever changes, and the 10% slack absorbs minor
install-date boundary gaps without over-firing Tier 2.

Before implementation, grep for callers of `fetchConsumptionStitched` and
confirm no caller treats `metersStitched` as always-set or always-true.
Record the result (affected call-sites, or "none found") in the Design
Review Resolution section below (L3).

```js
const newestMeter = selectNewestMeter(meters); // stable criterion — same as elecSerial/gasSerial selection
// ... fetch newestData from newestMeter ...
if (newestData.results.length > 0) {
  const ts = newestData.results.map(r => new Date(r.interval_start).getTime());
  const spanDays = (Math.max(...ts) - Math.min(...ts)) / (24 * 60 * 60 * 1000);
  const sufficientDays = 0.9 * CONFIG.LOOKBACK_MS / (24 * 60 * 60 * 1000);
  if (spanDays >= sufficientDays) {
    // Newest meter covers >=90% of the lookback window — use it alone
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

Only reached when the newest meter spans <90% of `CONFIG.LOOKBACK_MS`. Apply a
plausibility heuristic per meter before stitching. Private helper `inferGasUnit`
in `data-ingestion.js` (gas only — electricity is always kWh from the Octopus API):

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
  const vals = [...byDay.values()];
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const maxDay = Math.max(...vals);
  // Two-point rule: m³ classification requires BOTH median < 2.5 AND
  // max-day < 5. Prevents misclassifying low-gas kWh households
  // (gas-cooking-only, small flats) where median might be <2 kWh/day but
  // occasional days push above 5 kWh. Real m³ households have summer max
  // days around 1–2 m³; real kWh households have summer max days >5 kWh
  // even if the median is low.
  return (median < 2.5 && maxDay < 5) ? 'm3' : 'kwh';
}
```

**Threshold rationale (two-point rule):** The single-threshold version
(`median < 2.0`) misclassifies gas-cooking-only households (summer daily
gas 0.2–0.8 kWh/day) and very small flats on combi boilers (1–2 kWh/day).
Requiring both a low median AND a low maximum prevents the kWh household
with legitimately sparse summer use from being multiplied ×11.19 by
spurious m³ classification. Typical m³ households: median 0.3–1.0,
max-day 1–2. Typical kWh households with low usage: median 1–4, max-day
5–15. Gap is clean. Fallback behaviour unchanged: insufficient summer
data (<48 HH records) still assumes kWh as the safer default.

**In addition, log the detection per meter** — serial, unit classified,
observed summer median, observed summer max-day — via `console.info`,
so an edge-case user can see the decision in devtools if the result
looks wrong. This is a debug aid; the sanity-check UI (Fix 2d below) is
where user-visible review of the unit happens.

**New `gas_unit_source` enum value — pre-implementation audit.**
This patch introduces `'m3_converted_per_meter'` as a new value for the
`gas_unit_source` metadata field. Before applying Fix 2b, grep for
`gas_unit_source` across all `js/*.js` files. If any code branches on
specific values (e.g. `if (source === 'm3_converted')`), extend that
code to handle the new value explicitly in this same patch. Record the
result (affected call-sites, or "none found") in the Design Review
Resolution section (M3).

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

**2d. Dual-unit display in the gas sanity check (`buildGasUnitCheck`).**

The gas sanity check is the first UI where unit-misreading can occur — it is
the gate where the user decides whether to toggle m³. The current
implementation shows only a £/day figure (summer-day, winter-day samples).
This is precisely the UX that caused Rhiannon to miss the unit bug during
user-testing: a £0.03/day figure is ambiguous on its own, while "0.64 kWh"
in kWh terms is obviously implausible for a gas-using household.

Modify `buildGasUnitCheck` to show **both kWh and £** for each sample day,
side by side. Suggested format:

> Estimated daily gas use — summer day: **7.2 kWh** ≈ £0.58; winter day:
> **42.1 kWh** ≈ £3.35. If these look wrong in kWh terms, toggle the unit
> below.

The displayed kWh is whatever the current (pre-toggle) interpretation
produces — so a raw reading of 0.64 m³ treated as kWh renders as
"0.64 kWh ≈ £0.05", which a user can immediately see is wrong even if the £
figure alone might not be alarming. That visibility is the whole point:
kWh makes unit-misinterpretation legible in a way £ does not.

The £ value follows from kWh × the most recent fetched gas unit rate (same
path as Fix 3a). Omit the £ portion gracefully if no gas rate is available.

### Tests

- **T8b — Gas sanity check shows both units:** The sanity-check dialog
  includes kWh and £ values for summer-day and winter-day samples, in that
  order. If the raw reading is m³ (pre-toggle), the kWh value displayed
  is the raw m³ number (intentionally — makes the unit problem visible).
- **T8c — Gas sanity check degrades gracefully without a gas rate:** If
  `tariff_rates.gas` is empty or unavailable (e.g. tariff fetch failed),
  the kWh values still render; the £ suffixes are omitted. No crash, no
  "£NaN" string.

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
- **T6c — Tier 1 relative-threshold boundary (M2):** Two gas meters, newest has
  340 days of data. With threshold `0.9 × CONFIG.LOOKBACK_MS` (≈328 days at
  current 365-day lookback), Tier 1 fires. Assert `metersStitched = false` and
  only the newest meter's records returned. A corresponding test at 320 days
  (below threshold) should fall through to Tier 2.
- **T7 — Total-kWh assertion:** Post-fix total gas kWh over data period is within
  ±5% of Rhiannon's Octopus-app annual figure. **Sonnet must request this value
  from Rhiannon before implementation begins**, so T7 is a real pre-implementation
  gate rather than a post-hoc verification step.

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
// debug-only — remove in post-launch cleanup (after 28-Apr-2026 launch)
window.__getIngestionResult = () => getIngestionResult();
window.__getBaseloadResult = () => getBaseloadResult();
```

These are needed immediately to inspect raw meter objects (Symptom 2 Fix 2a) and
verify per-meter unit detection. **Removal trigger:** post-launch cleanup commit,
on or after 2026-04-28. Named rather than open-ended to prevent drift.

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
| `js/app.js` | Add debug getters (`window.__getIngestionResult`, `window.__getBaseloadResult`) with post-launch removal comment |
| `js/data-ingestion.js` | `buildGasUnitCheck` (Fix 2d): show both kWh and £ for summer-day and winter-day sample values |
| `js/data-ingestion.js` or wherever it lives | Audit the existing `elecSerial`/`gasSerial` "most recent meter" selection logic; confirm it uses a stable criterion (install_date / effective_from), or fix if it relies on array ordering (H1) |
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
- Broader UI redesign of the gas sanity check beyond the kWh + £ dual-unit
  display added in Fix 2d — functional fix only
- Removal of debug getters within this patch — named trigger is post-launch
  cleanup commit on or after 2026-04-28 (see Step 4 above)

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-23
**Review type:** Plan review (pre-implementation)
**Authoritative specs:** `docs/plans/module-1-data-ingestion.md`,
`docs/plans/module-3b-baseload-integration.md`, and
`~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/data-ingestion.md`.

### Context

Bug-fix plan arising from Rhiannon's M3b user-test. Three symptoms surfaced:
(1) 400 errors on historical tariff fetches, (2) baseload estimate ~20× too
low (kWh-space factor ~15; £-space factor ~20 inflated by standing-charge
drag), and (3) M3b UI lacked the kWh cross-check needed to distinguish a
calculation bug from a display bug. Root causes are M1 defects (tariff
windowing, mixed-meter unit handling) plus one M3b plan deviation (kWh
display). Investigation confirmed hypothesis 3 (M3a scaling slip) is
refuted.

Review identified one additional UX-correctness gap (H3) in the gas
sanity check — the first UI where unit-misreading can occur and the
precise screen that let Rhiannon miss the unit bug during testing. My
original debug prompt scoped Symptom 3 narrowly around M3b; that scope
left the gate-point UI unchanged. H3 corrects that.

### Required changes for implementation

**1. H1 — Stable "newest meter" selection (Fix 2a).**

Replace `meters[meters.length - 1]` with a selection that uses the same
stable criterion as the existing `elecSerial`/`gasSerial` "most recent"
logic from M1 Phase 2 (deviation D3) — typically `install_date` or
`effective_from` descending. Array-index ordering is not guaranteed by
the Octopus API and would regress Rhiannon's case if the active meter
is not returned last. If the existing selection itself relies on array
order, audit and fix it in this patch.

**2. H2 — Two-point rule in `inferGasUnit` (Fix 2b).**

Raise the classification bar so low-gas-usage kWh households (gas-cooking
only, very small flats, holiday homes) are not misclassified as m³ and
spuriously multiplied ×11.19. Require both `median < 2.5` AND
`max-day < 5` to classify as m³. Kept the existing "insufficient summer
data → assume kWh" fallback. Added per-meter detection logging for
devtools visibility.

**3. H3 — Dual-unit display in the gas sanity check (Fix 2d, new).**

`buildGasUnitCheck` previously showed £/day only — the UI that failed
Rhiannon during testing. Add kWh alongside £ for summer-day and
winter-day samples. A 0.64 m³ reading mis-interpreted as kWh renders as
"0.64 kWh ≈ £0.05" — obviously wrong in kWh terms even when the £ alone
might not alarm. Graceful fallback if no gas rate is available.

**4. M1 — T3 reframed as stubbed URL-parameter test.**

T3 rewritten to state explicitly that it stubs `buildTariffTimeline`'s
network layer and asserts on the constructed URL's `period_from` /
`period_to` parameters. Live-API end-to-end remains an informal post-fix
check against Rhiannon's own account (which currently produces the 400).

**5. M2 — Relative Tier 1 threshold `0.9 × CONFIG.LOOKBACK_MS` (Fix 2a).**

Replaced the hard-coded 365-day threshold. Relative-to-`LOOKBACK_MS` keeps
the gate coherent if the lookback ever changes; the 10% slack absorbs
install-date boundary gaps without over-firing Tier 2. Added boundary
test T6c (340 days above threshold, 320 days below).

**6. M3 — Pre-implementation audit of `gas_unit_source` enum (Fix 2b).**

Before applying Fix 2b, grep for `gas_unit_source` across `js/*.js`. If
any code branches on specific values, extend it to handle the new
`'m3_converted_per_meter'` value explicitly in the same patch. Document
the grep result in the Resolution section below.

**7. L1 — Named removal trigger for debug getters (Step 4).**

"Production removal" changed from open-ended TODO to a named trigger:
post-launch cleanup commit on or after 2026-04-28. Mirrored in
Not-in-scope.

**8. L2 — T7 ground-truth gathered pre-implementation.**

Sonnet must request Rhiannon's Octopus-app annual gas kWh figure before
implementation begins, so T7 is a real gate rather than a post-hoc
check.

**9. L3 — Call-site compatibility check for `fetchConsumptionStitched` (Fix 2a).**

Before implementation, grep for callers and confirm none treats
`metersStitched` as always-set or always-true. Document the result in
the Resolution section.

### Resolution of review changes

1. **H1** — Applied inline to Fix 2a. Narrative + code updated to use
   `selectNewestMeter(meters)` with a pointer to the existing
   `elecSerial`/`gasSerial` selection criterion. Audit line added to
   Files to modify.
2. **H2** — Applied inline to Fix 2b. Two-point rule codified; rationale
   section added explaining the gap between typical m³ and typical
   low-gas kWh households. Per-meter logging added.
3. **H3** — New Fix 2d added under Symptom 2, with T8b and T8c tests.
   `buildGasUnitCheck` listed in Files to modify.
4. **M1** — T3 rewritten in place to state the stubbed nature and the
   URL-parameter assertion target.
5. **M2** — Applied inline to Fix 2a (`0.9 × CONFIG.LOOKBACK_MS`) and
   Fix 2b (threshold reference). T6c added. Open Question section
   removed (now resolved).
6. **M3** — Pre-implementation grep note added to Fix 2b. Result line
   placeholder: Sonnet populates during implementation.
7. **L1** — Applied inline to Step 4. Removal trigger now "on or after
   2026-04-28". Not-in-scope updated to match.
8. **L2** — Applied inline to T7. "Sonnet must request this value…
   before implementation begins" wording.
9. **L3** — Pre-implementation grep note added to Fix 2a. Result line
   placeholder: Sonnet populates during implementation.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | ✓ pass |
| HIGH     | 3     | ✅ resolved (inline) |
| MEDIUM   | 3     | ✅ resolved (inline) |
| LOW      | 3     | ℹ resolved (inline); grep placeholders populated during implementation |

Verdict: **APPROVE WITH EDITS** — all nine findings resolved inline. Plan
is implementable. Sonnet to populate the M3 and L3 grep-result placeholders
as part of implementation and record in the Deviations section below.

---

## Approval

**Status:** ⚠ Approved with edits — 2026-04-23. Implementation may begin.
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** Two HIGH findings (H1 newest-meter-selection
stability, H2 heuristic two-point rule) plus one HIGH scope-gap (H3 dual-unit
sanity check) reshape Fix 2a / 2b and add Fix 2d. Three MEDIUM items (M1
stubbed T3, M2 relative Tier 1 threshold, M3 enum-value audit) tightened
tests and pre-implementation checks. L1–L3 named the debug-getters removal
trigger, pre-sequenced T7 ground-truth gathering, and added the
`fetchConsumptionStitched` call-site grep. Open-question on Tier 1
threshold resolved in favour of `0.9 × CONFIG.LOOKBACK_MS`.

---

## Implementation Deviations

[None — not yet implemented.]
