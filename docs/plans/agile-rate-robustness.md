# Agile Rate Robustness — implementation plan

**Date:** 2026-04-30
**Status:** ⚠ Approved with edits — apply Edits 1–3 below before implementing (2026-04-30)
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

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-30
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `design/agile-rate-robustness.md` (praxis-claude-hub commit `69ccf2e`)
**Verdict:** ⚠ APPROVED WITH EDITS — apply Edits 1–3 below before implementing, commit the amended plan (`plan amend: agile-rate-robustness — apply review edits`), then proceed to sub-step 1.

### Context

Strong plan. Sonnet correctly diagnosed two design gaps (`null_wholesale_fraction` placement should be in `app.js:runExternalData` not `fetchAgileCalibration`; default-object construction routes through `app.js` to ensure consistent shape) and proposed fixes that achieve design intent better than the design's literal specification. Sub-step gating with explicit verification criteria is structured well. "Design doc question for Opus" callouts used appropriately for Q1 (DOM spec) and Q2 (sub-step 1 hard gate).

Three substantive items to apply before implementing:

1. **(LOW from review)** Drop a redundant per-slot warning that doubles up with Section E's tier-2 coverage warning.
2. **(New, from Rhiannon's pushback during review)** Replace full-year wholesale mean with preceding-7-day rolling mean — preserves seasonality.
3. **(New, from Rhiannon's pushback during review)** Extend insufficient-data propagation beyond the pricing table to cover all downstream consumers via the existing `payback_status = 'no_data'` mechanism.

Architectural decisions from the design stand: APX provider, default D=2.2/P=12, validation bands (D 1.5–3.0, P 5–20, sample counts 50/20), coverage thresholds 5%/25%, plausibility floor 0.85×cap, weighted-mean-vs-cap check on `dumb_hp_hh`. The edits sharpen execution, not the architecture.

### Edits to apply before implementing

**Edit 1 — Drop the per-slot null-wholesale warning push (sub-step 2.3).**

Sub-step 2.3 currently includes:

```js
if (!warnedNullWholesale) {
  warnings.push('Some HH periods have no wholesale price data — using a calibration-typical rate for affected periods.');
  warnedNullWholesale = true;
}
```

This duplicates Section E's tier-2 coverage warning, which fires above 5% null fraction with similar text. Two warnings for the same condition through different channels (warnings array vs DOM banner) is redundant; firing thresholds also don't match (per-slot fires at any null; Section E fires at 5% threshold).

Resolution: remove the `warnings.push(...)` block and the `warnedNullWholesale` flag from sub-step 2.3. Section E's three-tier system in sub-step 3.1 is the user-visible signal. Sub-step 2.3 keeps the per-slot fallback behaviour without adding a separate warning channel.

**Edit 2 — Replace full-year wholesale mean with preceding-7-day rolling mean (sub-step 2.3).**

Current plan computes `wholesale_mean_known` once across the full-year wholesale array and uses that single global value for every null-wholesale slot. This smears summer wholesale into winter imputation (and vice versa), losing seasonality.

Replace with a 7-day preceding-window mean per slot, with a three-tier fallback hierarchy:

```js
function imputeWholesaleForSlot(i, wholesale_array, global_mean_known, D, ofgem_cap) {
  // Preceding 7 days × 48 HHs = 336 slots
  const window_start = Math.max(0, i - 336);
  const window_slots = wholesale_array.slice(window_start, i)
                                       .filter(w => w !== null && w !== undefined);
  const MIN_WINDOW_SAMPLES = 50;
  if (window_slots.length >= MIN_WINDOW_SAMPLES) {
    return window_slots.reduce((s, w) => s + w, 0) / window_slots.length;
  }
  // Fall back to global mean of known wholesale prices
  if (global_mean_known !== null) return global_mean_known;
  // Last resort: every slot is null → use cap/D so resulting rate ≈ Ofgem cap
  return ofgem_cap / D;
}
```

Three-tier fallback covers:

- Slot has at least 50 non-null wholesale prices in the preceding 7 days → use that mean. Common case.
- Preceding-week window has too few samples (early in dataset, or sustained outage) → global mean of all known wholesale prices.
- All wholesale is null → `OFGEM_CAP_ELEC_P_KWH / D` (existing layer-4 last-resort).

`global_mean_known` is computed once outside the per-HH loop. Implementation note: the per-slot rolling sum can be maintained incrementally during the iteration to avoid recomputing per null slot — optimisation is implementation-time concern, not architectural.

The peak/off-peak shape is *not* preserved by the wholesale mean (the 7-day window averages across both peak and off-peak hours). The formula's `+ (peak ? P_peak_p_kwh : 0)` term restores time-of-day shape via P. This is correct — the shape comes from P, not from wholesale; preserving same-hour-of-day in the wholesale window would be over-engineering.

Update sub-step 2.6 success criteria — replace the "rates use `wholesale_mean_known`" check with "rates use the preceding-week mean for the slot's date". Add a synthetic test injecting null slots in a winter month where summer/winter wholesale differs meaningfully, and confirm imputed rates reflect the seasonal context (winter slots get winter-ish mean, not year-mean).

**Edit 3 — Extend insufficient-data propagation in sub-step 3.1.**

Plan currently says: when `hhScenariosInsufficient = true`, the dumb_hp_hh and smart_hp_hh rows render em-dashes via `fmtGbp(null)`. That only covers the pricing card 5-column table. The HH scenarios are consumed by additional downstream paths:

| Downstream consumer | Notes |
|---|---|
| Financial card savings/payback rows | likely already em-dash via `fmtGbp(null)`; verify during implementation |
| Financial card sensitivity grid (5×5 gas/elec best-payback) | must exclude HH scenarios from "best payback per cell" selection when insufficient |
| Verdict bar chart | should omit HH scenario bars (or annotate) when insufficient |
| Verdict primary-scenario selection (`priority = ['smart_hp_hh', 'dumb_hp_hh', 'dumb_hp_svt']`) | falls through to `dumb_hp_svt` if HH scenarios' `payback_status = 'no_data'` — mechanism exists from smart-scenario-fixes-1 |
| Verdict status line (Fix 6 from ui-fixes-1) | handles "smart absent, dumb_hp_hh available"; may need a sibling case for "all HH absent, dumb_hp_svt available" |
| Drove card Stat 3 "Electricity (HH)" | adapts via primary-scenario branch; already handles the `dumb_hp_svt`-primary case |

**The simplifying mechanism:** most consumers already handle "scenario absent / payback_status = no_data" through patterns established by `smart-scenario-fixes-1` and `ui-fixes-1`. The propagation reduces to **one specific edit**:

When sub-step 3.1 sets `hhScenariosInsufficient = true`, also set
- `financialResult.scenarios.dumb_hp_hh.payback_status = 'no_data'`
- `financialResult.scenarios.smart_hp_hh.payback_status = 'no_data'`

(and nullify the relevant cost-array fields for these scenarios) **before** the verdict, chart, financial card, and drove-tile rendering runs. The existing `payback_status === 'no_data'` handling in those consumers naturally treats the scenarios as unavailable.

Specifically check during implementation:

- **Verdict status line (Fix 6).** Does the existing trigger logic handle "all HH absent, dumb_hp_svt available" as a sibling case to its existing "smart absent" condition? If not, extend it with one new condition.
- **Sensitivity grid.** Confirm the "best payback across scenarios" selection respects `payback_status = 'no_data'`. If not, add the filter.

Update sub-step 3.1's success criteria to verify end-to-end:

- Synthetic 26% null slots: HH rows em-dash in pricing AND financial cards; verdict bar chart omits HH bars (or annotates); verdict primary scenario falls back to `dumb_hp_svt`; drove tile electricity stat reflects SVT primary; sensitivity grid best-payback excludes HH scenarios.

### Answers to Sonnet's questions

**Q1 — DOM spec for `unusual-result-panel` and coverage warnings.** Sonnet's inference is acceptable. Confirmed:

- Coverage warnings reuse `.status-msg.warning` / `.status-msg.info` (no new CSS).
- `#unusual-result-panel` placed inside the pricing card above the cost table; hidden by default; title in `<strong>`, body in `<p>`; `.status-msg.info` styling.
- HH-scenarios-insufficient marker via `payback_status = 'no_data'` + `fmtGbp(null)` returning em-dash. Per Edit 3, this propagation extends beyond the pricing table.

If during implementation `.status-msg.info` looks insufficient for the unusual-result panel (it is a structural finding, not a passing note), add a small `.unusual-result-panel` rule with a left-border accent. Implementation-time decision; no Opus input needed.

**Q2 — Sub-step 1 commit gate.** Confirmed as a hard gate. Sub-step 1 ships and pauses for Rhiannon's verification before sub-step 2 begins. Verification criteria per the design's planning guidance: console clean (no `P=0` warning), drove tile electricity rate within 21–28 p/kWh, dumb_hp_hh cost > dumb_hp_svt cost on Rhiannon's data.

### Plan-internal cleanup applied at amend time (reviewer-mode edits)

Already applied by Opus when this Design Review block was added:

- Status field: `Awaiting approval` → `⚠ Approved with edits — apply Edits 1–3 below before implementing (2026-04-30)`.
- Section heading: `Claude.ai Review` → `Design Review`.

### Sonnet protocol

When picking up this plan for implementation:

1. Apply Edits 1–3 to the plan body. Update Status to `⚠ Approved with edits — applied 2026-04-30`. Commit (`plan amend: agile-rate-robustness — apply review edits`).
2. Proceed with sub-step 1 (APX switch). Commit, push, **stop for Rhiannon's verification** (sub-step 1 hard gate per Q2 confirmation above).
3. After verification, proceed with sub-step 2 then sub-step 3.
4. Implementation Deviations section (post-implementation) records any further deviations discovered while writing code.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | — |
| HIGH     | 0     | — |
| MEDIUM   | 0     | — |
| LOW      | 1     | Edit 1 (per-slot warning redundancy) — Sonnet applies |
| Edits from review discussion | 2 | Edits 2 (preceding-week mean), 3 (insufficient propagation) — Sonnet applies |

Verdict: ⚠ APPROVED WITH EDITS — three plan-body edits before implementation; sub-step 1 hard gate confirmed; Q1 DOM spec inference accepted.

---

## Approval

**Status:** ⚠ Approved with edits — apply Edits 1–3 before implementing (2026-04-30)
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** Preceding-7-day rolling mean for null-wholesale imputation (preserves seasonality) replaces full-year mean. Insufficient-data marking propagates beyond pricing table to verdict, chart, financial card, drove tile, and sensitivity grid via the existing `payback_status = 'no_data'` mechanism. Per-slot null-wholesale warning push removed (Section E tier system is the user-visible signal). Sub-step 1 (APX switch) is a hard gate — pause for verification before proceeding. DOM spec for `unusual-result-panel` and coverage warnings per Sonnet's inference. Wholesale dataset is shared across users (static, evolving day-by-day, not personalised) — relevant context for future "Elexon down" handling but no plan change needed.

---

## Implementation Deviations

[To be filled during implementation. None expected.]
