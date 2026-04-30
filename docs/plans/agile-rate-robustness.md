# Agile Rate Robustness — implementation plan

**Date:** 2026-04-30
**Status:** Awaiting approval — review via claude.ai before implementation begins.
**Parent design:** `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/agile-rate-robustness.md` (DRAFT — ready for Sonnet planning, 2026-04-30)
**Related designs:** `design/external-data.md` (M2), `design/pricing-engine.md` (M8), `design/m8-patch-gas-connection-retained.md`, `design/patch-agile-region-calibration.md`
**Supersedes:** `docs/plans/debug-agile-calibration-apx-switch.md` (rejected 2026-04-30 — kept as historical record of initial bug investigation)

---

## Task description

Three interlinked symptoms surfaced on 2026-04-30 live testing:

1. Agile calibration returned `P_peak_p_kwh = 0` — N2EX has structurally withdrawn from UK MID peak-hour trading.
2. Verdict drove tile displayed `0.0 p/kWh` average HH rate — the display filter included zero-rate slots from null wholesale data.
3. `dumb_hp_hh` cost (£384) ran below `dumb_hp_svt` cost (£890) — for a peak-heavy heating pattern this inverts the structurally expected ordering (Agile is uncapped at peak; SVT is capped).

These are three distinct root causes. The rejected plan addressed each narrowly (APX switch, P-only fallback guard, display zero-filter); the new design covers the full breadth: APX switch, expanded calibration validation, per-slot null-wholesale fallback that preserves rate magnitude/shape, coverage metadata, coverage warnings, display-average plausibility floor, and a consumption-weighted-mean-vs-cap check on `dumb_hp_hh`.

This plan implements Sections A–G of the design across three commits. Section H (parent design-doc updates in praxis-hub) is Opus's responsibility, already committed (`3ecda16`); not in scope here.

---

## Research findings

The design specifies all algorithms, constants, thresholds, and edge cases. No library evaluation needed — every change is in existing modules using existing patterns.

**Verified existing code structures (line numbers as of `691f1e8`):**

- `js/external-data.js`
  - `fetchWholesalePrices` lines 226–309: filters `dataProvider === 'N2EXMIDP'` at line 286; returns `source: 'elexon-mid-n2ex'` at lines 282 and 308.
  - `convertSpToUtc` line 322: guard `if (dataProvider !== 'N2EXMIDP') continue;` at line 323.
  - `fetchAgileCalibration` lines 374–445: computes `D_samples` and `P_samples` in the loop at lines 411–423; returns `{ D, P_peak_p_kwh, calibration_period, gsp_region }` at line 439. Returns `null` at line 424 if `D_samples.length === 0`, at line 386 if calibration window invalid, and at line 443 on error.

- `js/pricing-engine.js`
  - `D_DEFAULT = 2.2` and `P_DEFAULT_PEAK_P_KWH = 12` at lines 14–15.
  - `prepareRates` `??` fallback at lines 67–72 (the bug).
  - Per-slot null-wholesale handling at lines 104–109 (the design-level bug from `m8-patch-gas-connection-retained` Section F3).
  - Return shape at lines 154–165 includes `calibration_source`. Plan extends this to also include `agile_calibration` (full object) so the display layer can read sample counts and coverage.

- `js/app.js`
  - `OFGEM_CAP_ELEC_P_KWH = 24.67` at line 78.
  - `displayPricingResults` lines 1648–1723. Existing `calibration-default warning` at lines 1679–1681 keys off `rateMetadata?.calibration_source === 'default'` — this becomes the basis for the design's three-tier coverage warning (Section E).
  - `populateDroveTile` Stat 3 (Electricity) at lines 1937–1958. Line 1942 contains `filter(r => r !== null)` — the design's Section F changes this filter behaviour and adds a plausibility-floor check.
  - `runPricingEngine` line 1741: `agileCalibration` already pulled from `getExternalResult().external_metadata.agile_calibration` and passed to `prepareRates` via `params.agile_calibration`. The design's M2 metadata extension flows through this existing path.

- Scenario data shape: `scenarios.dumb_hp_hh.elec_kwh` is a per-HH array, populated by `js/scenario-consumption.js`. Compatible with the design's `computeWeightedMeanHhRate` signature.

**Key observations affecting the plan:**

1. The display layer reads `getExternalResult().external_metadata.agile_calibration` (per `app.js:1741, 1948`). The design's snippet `getExternalResult().agile_calibration` is shorthand — the real path traverses `external_metadata`. Plan uses the real path.

2. `null_wholesale_fraction` is computed against the **full-period wholesale fetch**, not the calibration window. The cleanest place is `app.js:runExternalData` where both the main wholesale fetch and the calibration are visible — merge the fraction into the calibration object before storing. Plan specifies this.

3. The design's `mark_hh_scenarios_insufficient` and `surface_unusual_result_panel` are described behaviourally but not specified as DOM/CSS. See **Design doc question for Opus** below.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/external-data.js` | A: switch N2EXMIDP → APXMIDP. B: extend `fetchAgileCalibration` to return `D_sample_count`, `P_sample_count`, `calibration_window` markers. App.js merges `null_wholesale_fraction` after the main fetch. |
| MODIFY | `js/pricing-engine.js` | C: per-slot null-wholesale fallback using `wholesale_mean_known`. D: expanded calibration-result validation (D and P bounds + sample-count thresholds). Extend return shape to include `agile_calibration` object. |
| MODIFY | `js/app.js` | Merge `null_wholesale_fraction` into the calibration object in `runExternalData`. E: coverage warnings in `displayPricingResults`. F: display-average plausibility floor in drove tile. G: weighted-mean-vs-cap check in `displayPricingResults` (or adjacent). |
| MODIFY | `index.html` | New `unusual-result-panel` and `coverage-warning` placeholders (locations specified in plan; copy from design). |
| MODIFY | `css/styles.css` | Styles for unusual-result-panel and coverage-warning if existing `.status-msg.warning` insufficient. |
| MODIFY | `CLAUDE.md` (heatpump-analyser) | Update Status line at end of implementation (after sub-step 3). |
| MODIFY | `~/Documents/git-repos/claude-coding-hub/context/heatpump-memory.md` | Update session memory after each sub-step commit. |

No new files. No new modules. Existing test files (`test-m8.mjs`, `test-m9.mjs`) already cover the calibration-default branch; new behaviours covered by browser tests against synthetic and live data per the design's test criteria.

---

## Implementation steps

The work splits into three commits, each independently shippable. Sub-step 1 is the highest-value isolated fix (restores cost ordering on live data). Sub-steps 2 and 3 build robustness on top.

### Sub-step 1 — APX switch (Section A)

Single-file change to `js/external-data.js`. Self-contained. Ship and verify on live data before proceeding.

**1.1** — `fetchWholesalePrices`:
- Line 285 comment: `// Filter to N2EXMIDP only` → `// Filter to APXMIDP only`
- Line 286: `const n2exRecords = allRecords.filter(r => r.dataProvider === 'N2EXMIDP');` → `const apxRecords = allRecords.filter(r => r.dataProvider === 'APXMIDP');`
- Line 290: `n2exRecords.filter(...)` → `apxRecords.filter(...)`
- Line 282 (early return on fetch error): `source: 'elexon-mid-n2ex'` → `source: 'elexon-mid-apx'`
- Line 308 (success return): `source: 'elexon-mid-n2ex'` → `source: 'elexon-mid-apx'`

**1.2** — `convertSpToUtc`:
- Line 323: `if (dataProvider !== 'N2EXMIDP') continue;` → `if (dataProvider !== 'APXMIDP') continue;`

No other changes — pagination, SP→UTC conversion, and dedup are provider-agnostic.

**1.3** — Verify on live data before committing:
- Console clean — no `P=0` warning.
- Drove tile electricity rate plausible (~21–28 p/kWh).
- `dumb_hp_hh` total cost > `dumb_hp_svt` total cost for Rhiannon's data.

**Commit 1 message:** `fix(M2): switch wholesale data provider N2EX → APX (N2EX has withdrawn from UK MID)`

---

### Sub-step 2 — Calibration metadata + per-slot fallback + expanded validation (Sections B, C, D)

M2 produces sample counts; M8 reads them and uses per-slot fallback. App.js merges `null_wholesale_fraction` after the main wholesale fetch. These deploy together — they're functionally interdependent.

**2.1 — `js/external-data.js`: extend `fetchAgileCalibration` return shape (Section B)**

Track sample counts during the existing D/P collection loop (no new computation):

```js
const D_samples = [];
const P_samples = [];
for (const [ts, wholesale] of priceLookup) {
  if (wholesale === null || wholesale <= 1.0) continue;
  const tsDate   = new Date(ts);
  const agileVal = agileMap.get(tsDate.toISOString());
  if (agileVal === undefined || agileVal === null) continue;
  if (isUkPeakHour(tsDate)) {
    P_samples.push({ agile: agileVal, wholesale });
  } else {
    D_samples.push(agileVal / wholesale);
  }
}

const D_sample_count = D_samples.length;
const P_sample_count = P_samples.length;

if (D_sample_count === 0) return null;  // unchanged guard

// ... (median computation unchanged) ...

return {
  D, P_peak_p_kwh: P, calibration_period: calibPeriod, gsp_region,
  D_sample_count, P_sample_count,
  // null_wholesale_fraction merged in app.js after main fetch
  source: 'fetched',
};
```

Existing console warnings (D/P out-of-range) retained as diagnostic; the M8 validation supersedes them as the user-visible signal.

**2.2 — `js/app.js`: merge `null_wholesale_fraction` after main wholesale fetch**

In `runExternalData` (or wherever the main wholesale fetch result becomes the `external` array). After both the main fetch and `fetchAgileCalibration` complete:

```js
const wholesale_array = external.map(e => e.wholesale_p_kwh);
const total_slots = wholesale_array.length;
const null_slots  = wholesale_array.filter(w => w === null).length;
const null_wholesale_fraction = total_slots > 0 ? null_slots / total_slots : 1.0;

const agile_calibration = agileCalResult
  ? { ...agileCalResult, null_wholesale_fraction }
  : { D: 2.2, P_peak_p_kwh: 12,
      D_sample_count: 0, P_sample_count: 0,
      null_wholesale_fraction, source: 'default' };
```

The existing `external_metadata.agile_calibration` storage path is unchanged — only the object shape is enriched. Default-fallback object created here when `fetchAgileCalibration` returns null, so the M8 validation block always receives a non-null object with consistent shape.

**Note:** the existing default-fallback in `pricing-engine.js` (lines 67–72) currently fires when `agile_calibration` is null. After this change, calibration is *never* null — but the validation in step 2.4 below catches the structurally-bad case and falls back to defaults explicitly.

**2.3 — `js/pricing-engine.js`: per-slot null-wholesale fallback (Section C)**

Add helper `mean()` if not already present (vanilla utility). Compute `wholesale_mean_known` once outside the per-HH loop, after the calibration block resolves D:

```js
// (After the calibration validation block — D is now defined)
const known_wholesale = external
  .map(e => e?.wholesale_p_kwh)
  .filter(w => w !== null && w !== undefined);
const wholesale_mean_known = known_wholesale.length > 0
  ? known_wholesale.reduce((s, w) => s + w, 0) / known_wholesale.length
  : (OFGEM_CAP_ELEC_P_KWH / D);  // last-resort: entire fetch null

// Per-HH loop — replace lines 104–119:
const wholesale = external[i]?.wholesale_p_kwh;
const peak      = isPeakHour(tsDate);
if (wholesale === null || wholesale === undefined) {
  elec_hh_rate_by_hh[i] = D * wholesale_mean_known
                        + (peak ? P_peak_p_kwh : 0);
  if (!warnedNullWholesale) {
    warnings.push('Some HH periods have no wholesale price data — using a calibration-typical rate for affected periods.');
    warnedNullWholesale = true;
  }
} else {
  elec_hh_rate_by_hh[i] = Math.min(
    peak ? D * wholesale + P_peak_p_kwh : D * wholesale,
    100,
  );
  if (wholesale < PE_CONFIG.EXTREME_NEG_WHOLESALE_P && !hasExtremeNeg) {
    warnings.push('Extreme negative wholesale prices found — check Elexon data quality.');
    hasExtremeNeg = true;
  }
}
```

`OFGEM_CAP_ELEC_P_KWH` is currently in `app.js:78`. To use it inside `pricing-engine.js`, either (a) export it from `app.js` and import (cleanest with vanilla ES modules), or (b) pass it through `params` from `app.js:runPricingEngine`. **Plan choice: pass via `params.ofgem_cap_elec_p_kwh`** (already passed at app.js:290 according to grep) so `pricing-engine.js` stays free of hardcoded cap constants. If `params.ofgem_cap_elec_p_kwh` is missing/null, fall back to the existing `OFGEM_CAP_ELEC_P_KWH` reference in app.js — i.e. it's always populated.

**2.4 — `js/pricing-engine.js`: expanded calibration validation (Section D)**

Replace lines 67–72 with the `calibration_valid` ternary from the design:

```js
const D_MIN = 1.5, D_MAX = 3.0;
const P_MIN = 5,   P_MAX = 20;
const D_MIN_SAMPLES = 50;
const P_MIN_SAMPLES = 20;

const raw = params.agile_calibration;
const calibration_valid = raw
  && raw.D            >= D_MIN && raw.D            <= D_MAX
  && raw.P_peak_p_kwh >= P_MIN && raw.P_peak_p_kwh <= P_MAX
  && (raw.D_sample_count ?? 0) >= D_MIN_SAMPLES
  && (raw.P_sample_count ?? 0) >= P_MIN_SAMPLES;

const calibration = calibration_valid
  ? raw
  : { D: D_DEFAULT, P_peak_p_kwh: P_DEFAULT_PEAK_P_KWH, source: 'default' };

const { D, P_peak_p_kwh } = calibration;
const calibration_source = calibration.source ?? 'fetched';
```

These four constants (`D_MIN/MAX`, `P_MIN/MAX`, `D_MIN_SAMPLES`, `P_MIN_SAMPLES`) live as local constants inside `prepareRates`. They are not user-tunable.

**Important semantic note:** when `calibration_valid` is false, the new fallback object loses `null_wholesale_fraction` and `D_sample_count`/`P_sample_count`. The display layer (sub-step 3) reads coverage from the *original* `agile_calibration` on the external metadata, not from the rate metadata's calibration object — so this loss is fine. Plan specifies this routing in sub-step 3 below.

**2.5 — `js/pricing-engine.js`: extend return shape**

Add `agile_calibration` (the post-validation object) to the return at line 154:

```js
return {
  ...
  calibration_source,
  agile_calibration: calibration,  // NEW
  ...
};
```

This makes the validated calibration available to downstream code (e.g. the display layer for the weighted-mean check in Section G uses `D`, `P_peak_p_kwh` from here, while coverage warnings in Section E read `null_wholesale_fraction` from the original `external_metadata.agile_calibration`).

**2.6 — Verify before committing:**
- Console clean on Rhiannon's live data (calibration_valid = true; no fallback warning).
- Synthetic null-wholesale test: inject 10% null slots in a mock dataset; confirm rates for those slots are `D × wholesale_mean_known + (peak ? P : 0)` (within rounding), not zero.
- Synthetic calibration-validation test: simulate `D_sample_count = 30` (below 50) → defaults used.

**Commit 2 message:** `fix(M2/M8): expand Agile calibration validation, add coverage metadata, per-slot null-wholesale fallback`

---

### Sub-step 3 — Coverage warnings + display plausibility + weighted-mean check (Sections E, F, G)

Display-layer changes only. Reads from the metadata exposed by sub-step 2.

**3.1 — `js/app.js`: coverage warnings in `displayPricingResults` (Section E)**

Replace the existing single `calibrationWarning` (lines 1679–1681) with the three-tier check from the design. The thresholds and copy come straight from the design's Section E:

```js
const COVERAGE_WARN_THRESHOLD         = 0.05;
const COVERAGE_INSUFFICIENT_THRESHOLD = 0.25;

const cal = getExternalResult()?.external_metadata?.agile_calibration ?? null;
const fraction = cal?.null_wholesale_fraction ?? 0;
const calSource = rateMetadata?.calibration_source ?? 'fetched';

let coverageWarning = '';
let hhScenariosInsufficient = false;

if (calSource === 'default') {
  coverageWarning = `<p class="status-msg warning">Couldn't fetch live Agile rates for your region. Half-hourly tariff scenarios use typical UK averages (D=2.2, P=12 p/kWh peak). Numbers are indicative; your actual Agile rate will differ.</p>`;
} else if (fraction > COVERAGE_INSUFFICIENT_THRESHOLD) {
  hhScenariosInsufficient = true;
  coverageWarning = `<p class="status-msg warning">Half-hourly tariff scenarios couldn't be computed for your data period — wholesale price data was missing for ${(fraction * 100).toFixed(0)}% of half-hour slots (above the 25% coverage threshold).</p>`;
} else if (fraction > COVERAGE_WARN_THRESHOLD) {
  coverageWarning = `<p class="status-msg info">Wholesale price data was missing for ${(fraction * 100).toFixed(0)}% of your data period. Half-hourly tariff scenarios use a typical-rate estimate for those periods.</p>`;
}
```

`hhScenariosInsufficient` is propagated into the rows-builder: when set, the dumb_hp_hh and smart_hp_hh rows render as `—` for cost cells (existing `fmtGbp` already returns `—` for null inputs — pass `null` to force this). Replaces the existing `calibrationWarning` HTML. Sub-step 3.1 is one continuous change inside `displayPricingResults`.

**3.2 — `js/app.js`: display-average plausibility floor in drove tile (Section F)**

Replace lines 1942–1949 with:

```js
const PLAUSIBILITY_FACTOR = 0.85;
const plausibility_floor  = OFGEM_CAP_ELEC_P_KWH * PLAUSIBILITY_FACTOR;

const elec_hh_rates = rateMetadata?.elec_hh_rate_by_hh?.filter(r => r !== null) ?? [];
const avg_hh_rate   = elec_hh_rates.length > 0
  ? elec_hh_rates.reduce((s, r) => s + r, 0) / elec_hh_rates.length
  : null;

elecLabel.textContent = 'Electricity (half-hourly)';
elecVal.textContent   = avg_hh_rate != null ? `${avg_hh_rate.toFixed(1)} p/kWh average` : 'Not available';

const region = externalRes?.external_metadata?.agile_calibration?.gsp_region ?? 'regional pricing';
if (avg_hh_rate != null && avg_hh_rate < plausibility_floor) {
  elecCtx.textContent = `Agile tariff — region ${region}. Note: the displayed average (${avg_hh_rate.toFixed(1)} p/kWh) is below the Ofgem cap (${OFGEM_CAP_ELEC_P_KWH.toFixed(2)} p/kWh). This suggests either an off-peak-heavy heating pattern or a data quality issue. See coverage warning above for details.`;
} else {
  elecCtx.textContent = `Agile tariff — region ${region}`;
}
```

**Filter change from rejected plan:** the design explicitly retains `r => r !== null` rather than the rejected plan's `r => r > 0`. Reason per design: keep zeros visible so the plausibility-floor check sees them; the floor check now does the work the zero-filter was doing.

**3.3 — `js/app.js` + `index.html`: weighted-mean-vs-cap check (Section G)**

Add helper `computeWeightedMeanHhRate` (utility-style, near top of `app.js` or in a helper section). Add a call inside `displayPricingResults` (or a sibling that fires after pricing computes):

```js
function computeWeightedMeanHhRate(scenarioElecKwh, hhRates) {
  let weighted_sum = 0;
  let total_kwh    = 0;
  for (let i = 0; i < hhRates.length; i++) {
    if (hhRates[i] === null || scenarioElecKwh[i] === null || scenarioElecKwh[i] === undefined) continue;
    weighted_sum += scenarioElecKwh[i] * hhRates[i];
    total_kwh    += scenarioElecKwh[i];
  }
  return total_kwh > 0 ? weighted_sum / total_kwh : null;
}
```

In `displayPricingResults` (or wherever the dumb_hp_hh scenario data is in scope; if not, route via parameter):

```js
const dumbHpHhScenario = scenarioResult?.scenarios?.dumb_hp_hh;
const weighted_mean_dumb_hh = dumbHpHhScenario
  ? computeWeightedMeanHhRate(dumbHpHhScenario.elec_kwh, rateMetadata.elec_hh_rate_by_hh)
  : null;

if (weighted_mean_dumb_hh !== null && weighted_mean_dumb_hh < OFGEM_CAP_ELEC_P_KWH) {
  showUnusualResultPanel({
    title: 'Half-hourly tariff favours your heating pattern',
    body: `Your half-hourly tariff scenario has an effective rate of ${weighted_mean_dumb_hh.toFixed(1)} p/kWh across heating hours — below the flat-rate cap (${OFGEM_CAP_ELEC_P_KWH.toFixed(2)} p/kWh). This usually means your heating pattern is unusually off-peak weighted (e.g. continuous underfloor heating). If your heating runs heavily in evenings (typical gas-boiler timing), this result may indicate a data quality issue — check the coverage warning above.`,
  });
}
```

`showUnusualResultPanel` writes to a new `#unusual-result-panel` div in `index.html`, placed inside the pricing card just below `pricing-status` (above the table). The panel hides by default and reveals when populated.

`index.html` change:
```html
<div id="unusual-result-panel" class="status-msg info hidden" style="margin-bottom: 0.75rem;">
  <strong id="unusual-result-title"></strong>
  <p id="unusual-result-body"></p>
</div>
```

`showUnusualResultPanel({ title, body })` populates the title and body, then removes `hidden`. Re-running pricing resets it (add `unusualResultPanel.classList.add('hidden')` at the top of `displayPricingResults`).

If existing CSS is sufficient (`.status-msg.info` already styled), no `styles.css` changes needed. Otherwise add a small declaration for `.unusual-result-panel` with a left border accent — confirm during implementation.

**3.4 — Verify before committing:**
- Live data (Rhiannon's): no unusual-result panel; drove tile electricity context shows region only, no plausibility note.
- Synthetic 6% null slots: 5% threshold info banner appears.
- Synthetic 26% null slots: 25% threshold marks HH scenarios insufficient (em-dashes in cost cells).
- Synthetic off-peak-heavy heating: unusual-result panel fires with the legitimate-result framing.

**Commit 3 message:** `fix(M10): coverage warnings, HH plausibility floor, weighted-mean-vs-cap check`

---

### Final cleanup

After commit 3:
- Update `CLAUDE.md` (heatpump-analyser) Status line summarising the agile-rate-robustness work.
- Update `~/Documents/git-repos/claude-coding-hub/context/heatpump-memory.md` to reflect the new robustness layer; flag the design doc as implemented.
- Update `docs/debug/2026-04-30-agile-calibration-p-zero.md` Status to RESOLVED with commit references.
- No README change (no file structure change).

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| APX switch reveals a different data-quality issue (e.g. APX has different timestamp encoding) | Sub-step 1 verifies on live data before sub-step 2. Console-clean + plausible drove tile + cost-ordering check are blocking gates. |
| `wholesale_mean_known` last-resort branch (`OFGEM_CAP / D`) fires unexpectedly because the entire fetch returned null on a transient Elexon outage | Coverage warning tier 3 (>25%) fires and marks HH scenarios insufficient; em-dashes plus explanation render in cost cells. User gets context, not a silent number. |
| Sample-count thresholds (50/20) exclude valid calibrations on a partial-month CSV path with low density | Test criterion 6 explicitly verifies fallback fires below threshold. If real-world thresholds need adjustment, change is one-line and constants are local — no architectural impact. |
| Plausibility floor (0.85 × cap) fires for legitimate off-peak-heavy users without the unusual-result panel context | The floor surfaces a *note* in the drove tile context line, not a warning panel. The unusual-result panel (Section G) provides the full explanation alongside. Floor + panel reinforce each other; either alone is sufficient context. |
| `OFGEM_CAP_ELEC_P_KWH` updates for next quarter and the constant in `app.js:78` is missed | All four code paths (display-average floor, weighted-mean check, fallback rate `OFGEM_CAP/D`, prefill defaults) reference the same module-level constant. One edit propagates to all. |
| The existing `calibration_source = 'default'` warning copy duplicates the new tier-1 coverage warning copy | Tier 1 explicitly replaces the old `calibrationWarning` (lines 1679–1681) — only one warning fires. |
| `getExternalResult()?.external_metadata?.agile_calibration` is null on CSV path before pricing runs | The default-fallback object construction in step 2.2 ensures `agile_calibration` is always populated when pricing runs. CSV path with no GSP region → calibration object with `source: 'default'` → tier 1 coverage warning fires. |

---

## Success criteria

Per the design's Section "Test criteria". Success is sub-step-gated — sub-step `n+1` does not begin until sub-step `n` passes its criteria.

**Sub-step 1 (APX switch) — verify before commit:**

- [ ] Console: no `P=0.00` warning on Rhiannon's data covering Apr–May 2026.
- [ ] Drove tile electricity rate displayed within 21–28 p/kWh band.
- [ ] `dumb_hp_hh` total cost > `dumb_hp_svt` total cost on Rhiannon's data.
- [ ] No new console errors on the normal path.

**Sub-step 2 (validation + per-slot fallback + metadata) — verify before commit:**

- [ ] Console: `calibration_valid = true` on Rhiannon's data (D and P sample counts in the hundreds, both bounds satisfied).
- [ ] Synthetic 10% null slots: rates for null slots equal `D × wholesale_mean_known + (peak ? P : 0)` within rounding.
- [ ] Synthetic `D_sample_count = 30`: `calibration_valid = false`, defaults applied, `calibration_source === 'default'`.
- [ ] Synthetic `P_peak_p_kwh = 22`: `calibration_valid = false`, defaults applied.
- [ ] Synthetic `D = 1.0`: `calibration_valid = false`, defaults applied.
- [ ] All-null wholesale: `wholesale_mean_known` falls back to `OFGEM_CAP / D`; no console errors.

**Sub-step 3 (coverage warnings + plausibility + weighted-mean) — verify before commit:**

- [ ] Live data: no unusual-result panel; drove tile context shows region only.
- [ ] Synthetic 6% null slots: 5% tier info banner visible above pricing table.
- [ ] Synthetic 26% null slots: 25% tier marks HH scenarios insufficient; cost cells render em-dashes; explanation visible.
- [ ] Synthetic off-peak-heavy heating (heating concentrated 02:00–06:00): unusual-result panel fires with legitimate-result framing.
- [ ] Live (peak-heavy) data: weighted_mean > cap; unusual-result panel does NOT fire.
- [ ] Plausibility floor scaling: change `OFGEM_CAP_ELEC_P_KWH` to 30.0; floor automatically becomes 25.5; no other code changes.
- [ ] CSV path (no GSP region): calibration skipped, defaults used, tier 1 coverage warning shows "Couldn't fetch live Agile rates" copy.

**Cross-cutting:**

- [ ] No console errors on any path.
- [ ] HTML well-formed (no broken references introduced).
- [ ] CLAUDE.md status line updated.
- [ ] Session memory updated.

---

## Design doc question for Opus

**Q1 — `unusual-result-panel` and `coverage-warning` DOM specification**

The design's Sections E and G describe the panels behaviourally (`mark_hh_scenarios_insufficient`, `surface_unusual_result_panel`) but don't specify DOM structure or styling.

Plan proposes:
- Coverage warnings reuse the existing `.status-msg.warning` / `.status-msg.info` pattern (no new CSS).
- Unusual-result panel: new `#unusual-result-panel` div inside the pricing card, above the cost table, with hidden-by-default class. Title in `<strong>`, body in `<p>`. Reuses `.status-msg.info` styling.
- HH-scenarios-insufficient marker: pass a flag through to the row-rendering code; pass `null` to `fmtGbp` for cost cells (existing behaviour returns em-dash). The coverage warning above the table provides the explanation.

**Acceptable inference, or does Opus want a stronger spec?** Implementation can proceed on this inference if Opus is happy; otherwise a one-liner clarification (or Opus-driven `index.html` skeleton) before sub-step 3 begins.

**Q2 — Sub-step 1 commit gate**

Plan ships APX switch alone in commit 1, then waits on Rhiannon's "yes, cost ordering returns to plausibility" before commits 2 and 3 land. Confirms with the design's planning guidance: "Land first, verify cost ordering returns to plausibility on live data, then proceed." Treating this as a hard gate per the design — do not proceed past commit 1 without explicit verification.

---

## Claude.ai Review — yyyy-mm-dd

[To be filled by reviewer.]

---

## Approval

[To be filled on approval.]

---

## Implementation Deviations

[To be filled during implementation. None expected.]
