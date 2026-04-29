# ui-design-m10b — Layout restructure + "What drove this answer" tile

**Date:** 2026-04-29
**Status:** ✅ Approved — 2026-04-29
**Design doc:** `design/ui-design-m10b.md`
**Implements:** sequence 4 of 6 (after m8-patch-gas-connection-retained; before ui-design-m10c-what-if). ui-fixes-2 is parallel to the main stream and not counted in the linear sequence.

---

## Task description

Restructure the single-column page into a paired-tile layout at desktop widths, and
add a new "What drove this answer" tile alongside the verdict card. Presentation-only
change — no data pipeline modifications. The "Adjust the assumptions" section (Section 5)
is intentionally left in its current M10a single-column form; M10c removes and replaces
it entirely in the next step.

---

## Research findings

**Container and grid:** `css/styles.css` currently has `.container { max-width: 720px; }`.
Increase to 1100px. New `.section-tiles` utility class with CSS Grid 2-column layout,
collapsing to 1-column at ≤768px.

**Section banners:** `bannerVerdict` DOM ref at app.js:229, pointing to
`id="section-banner-verdict"` (index.html:321, text "The verdict"). One reference to
reveal it at app.js:1668. Rename to `bannerCostBreakdown` / `section-banner-cost-breakdown`.

**Verdict card reveal:** `verdictCard.classList.remove('hidden')` at app.js:1996 (Step 16h
of `buildAndDisplayVerdict`). The drove-card reveals immediately after at the end of
the same function (Step 16i).

**drove-tile data sources:**
- Stat 1 (heat loss): `heatLossResult.htc_w_per_k`, `HEAT_LOSS_RATING_DISPLAY[result.rating]`
  (app.js:96). `heatLossResult` is passed as a parameter to `buildAndDisplayVerdict`.
- Stat 2 (HP size): `hpModelResult.hp_capacity_kw`, `hpModelResult.annual_mean_cop`.
  Not currently a parameter of `buildAndDisplayVerdict` — obtain via `getHeatPumpModelResult()`
  (already imported at app.js:53).
- Stat 3 (electricity): After m8-patch, HH rates are in `rateMetadata.elec_hh_rate_by_hh[]`
  (the Agile D×W+P rates). For the average, compute mean of non-null values in this array.
  SVT rate is `rateMetadata.svt_rate_p_per_kwh`. `agile_calibration.gsp_region` comes from
  `getExternalResult().agile_calibration` (m8-patch adds this to the external result).
  **Field name note:** the m10b design doc calls this array `agile_rate_by_hh` — that is an
  older draft name. Use `elec_hh_rate_by_hh` to match the m8-patch plan, which uses that
  name throughout `prepareRates`.
- Stat 4 (installation): `readCapitalParams()` returns `{ installation_cost_full_hp_gbp,
  bus_grant_gbp, ... }` (app.js:272). Call directly from `populateDroveTile`.
- `primaryKey` is computed inside `buildAndDisplayVerdict` at line 1823 and must be passed
  to `populateDroveTile` as a parameter.

**No changes to "Adjust the assumptions" section:** Leaving `#pricing-params-card`,
`#financial-params-card`, and `#section-banner-assumptions` untouched. M10c owns this section.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `css/styles.css` | Container width, `.section-tiles`, drove-card CSS |
| MODIFY | `index.html` | Section wrappers, drove-card HTML, banner rename |
| MODIFY | `js/app.js` | `populateDroveTile`, banner rename, drove-card DOM ref |

---

## Implementation steps

### Step 1 — CSS: Container width + `.section-tiles` (styles.css)

Update `.container` rule:
```css
.container {
  max-width: 1100px;     /* was: 720px */
  margin: 0 auto;
  padding: 1.5rem 1rem;
}
```

Append new `.section-tiles` utility class:
```css
/* ===== Paired-tile grid ===== */
.section-tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.5rem;
  margin-bottom: 1.5rem;
}

@media (max-width: 768px) {
  .section-tiles {
    grid-template-columns: 1fr;
    gap: 1rem;
  }
}
```

Append drove-card CSS rules (full spec from design doc):
```css
/* ===== "What drove this answer" tile ===== */
.drove-title {
  font-size: 1rem;
  color: var(--colour-navy);
  margin-bottom: 1rem;
  font-family: Montserrat, sans-serif;
}
.drove-stats { display: flex; flex-direction: column; }
.drove-stat {
  display: flex;
  flex-direction: column;
  padding: 0.85rem 0;
  border-bottom: 1px solid var(--colour-border);
}
.drove-stat:last-child { border-bottom: none; padding-bottom: 0; }
.drove-stat:first-child { padding-top: 0; }
.drove-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--colour-navy);
  font-weight: 600;
  margin-bottom: 0.2rem;
}
.drove-value {
  font-size: 1.35rem;
  font-weight: 600;
  color: var(--colour-dark);
  font-family: Montserrat, sans-serif;
  line-height: 1.3;
}
.drove-context {
  font-size: 0.85rem;
  color: var(--colour-dark);
  opacity: 0.7;
  margin-top: 0.15rem;
}
```

### Step 2 — index.html: Section 1 — Results tile pair

Wrap existing `verdict-card` and new `drove-card` in a `.section-tiles` div.
Insert drove-card HTML immediately after the closing `</section>` of verdict-card:

```html
<div class="section-tiles" id="results-tiles">
  <section class="card verdict-card hidden" id="verdict-card">
    <!-- existing content unchanged — verdict-cooling is removed by ui-fixes-2 -->
  </section>
  <aside class="card drove-card hidden" id="drove-card">
    <h3 class="drove-title">What drove this answer</h3>
    <div class="drove-stats">
      <div class="drove-stat" id="drove-heat-loss">
        <span class="drove-label">Heat loss</span>
        <span class="drove-value" id="drove-heat-loss-value">—</span>
        <span class="drove-context" id="drove-heat-loss-context"></span>
      </div>
      <div class="drove-stat" id="drove-hp-size">
        <span class="drove-label">Heat pump size</span>
        <span class="drove-value" id="drove-hp-size-value">—</span>
        <span class="drove-context" id="drove-hp-size-context"></span>
      </div>
      <div class="drove-stat" id="drove-electricity">
        <span class="drove-label" id="drove-electricity-label">Electricity</span>
        <span class="drove-value" id="drove-electricity-value">—</span>
        <span class="drove-context" id="drove-electricity-context"></span>
      </div>
      <div class="drove-stat" id="drove-install">
        <span class="drove-label">Installation</span>
        <span class="drove-value" id="drove-install-value">—</span>
        <span class="drove-context" id="drove-install-context"></span>
      </div>
    </div>
  </aside>
</div>
```

The section banner `section-banner-your-home` remains outside this wrapper.

### Step 3 — index.html: Section 2 — Your home tile pair

Wrap `results-card` and `energy-summary-card` in a `.section-tiles` div. The section
banner sits above the wrapper as before.

### Step 4 — index.html: Section 3 — Methodology disclosure 2×2 grid

Replace the flat list of four cards inside `<details class="methodology-disclosure">`
with two `.section-tiles` rows:

```html
<details class="methodology-disclosure hidden" id="methodology-disclosure">
  <summary class="methodology-summary">Show methodology</summary>
  <div class="section-tiles">
    <section class="card hidden" id="heat-loss-card">...</section>
    <section class="card hidden" id="thermal-char-card">...</section>
  </div>
  <div class="section-tiles">
    <section class="card hidden" id="hp-model-card">...</section>
    <section class="card hidden" id="scenario-card">...</section>
  </div>
</details>
```

The inner card content is unchanged — only the structural wrappers are added.

### Step 5 — index.html: Section 4 — Banner rename

Update the section banner:
```html
<div class="section-banner hidden" id="section-banner-cost-breakdown">
  <h2 class="section-heading">Cost breakdown</h2>
</div>
```

No `.section-tiles` wrapper for `pricing-card` or `financial-card` — they remain
full-width stacked cards as designed.

### Step 6 — Section 5 — No change

Leave `section-banner-assumptions`, `pricing-params-card`, and `financial-params-card`
exactly as they are. M10c owns this section.

### Step 7 — app.js: Banner rename + drove-card DOM reference

Change DOM reference at app.js:229:
```js
// was: const bannerVerdict = document.getElementById('section-banner-verdict');
const bannerCostBreakdown = document.getElementById('section-banner-cost-breakdown');
```

Change reveal call at app.js:1668 (in `displayPricingResults`):
```js
// was: bannerVerdict.classList.remove('hidden');
bannerCostBreakdown.classList.remove('hidden');
```

Add drove-card DOM reference near `verdictCard` (app.js:222):
```js
const droveCard = document.getElementById('drove-card');
```

### Step 8 — app.js: `populateDroveTile` function

Add new function `populateDroveTile(financialResult, heatLossResult, rateMetadata, primaryKey)`.
Additional data obtained directly within the function via module-level accessors:
`getHeatPumpModelResult()`, `getExternalResult()`, `readCapitalParams()`.

**Design doc deviation:** the m10b design doc specifies a 7-param signature
`populateDroveTile(financialResult, heatLossResult, hpModelResult, externalResult,
rateMetadata, capitalParams, primaryKey)`. This plan consolidates to 4 external params and
calls the accessors internally — these functions are already imported at module scope and
calling them inside the function reduces call-site complexity without loss of testability.

```js
function populateDroveTile(financialResult, heatLossResult, rateMetadata, primaryKey) {
  if (!financialResult) return;

  const hpModel      = getHeatPumpModelResult();
  const externalRes  = getExternalResult();
  const capitalP     = readCapitalParams();

  // Stat 1 — Heat loss
  const htcVal    = document.getElementById('drove-heat-loss-value');
  const htcCtx    = document.getElementById('drove-heat-loss-context');
  if (heatLossResult?.htc_w_per_k != null) {
    htcVal.textContent = `${Math.round(heatLossResult.htc_w_per_k)} W/K`;
    htcCtx.textContent = HEAT_LOSS_RATING_DISPLAY[heatLossResult.rating] ?? '';
  } else {
    htcVal.textContent = 'Not available';
    htcCtx.textContent = "Heat loss couldn't be estimated from your data";
  }

  // Stat 2 — Heat pump size
  const hpVal = document.getElementById('drove-hp-size-value');
  const hpCtx = document.getElementById('drove-hp-size-context');
  if (hpModel?.hp_capacity_kw != null) {
    hpVal.textContent = `${hpModel.hp_capacity_kw.toFixed(1)} kW`;
    hpCtx.textContent = `Running at average COP ${hpModel.annual_mean_cop?.toFixed(1) ?? '—'}`;
  } else {
    hpVal.textContent = 'Not available';
    hpCtx.textContent = 'Sizing requires a heat-loss estimate';
  }

  // Stat 3 — Electricity context
  const elecLabel = document.getElementById('drove-electricity-label');
  const elecVal   = document.getElementById('drove-electricity-value');
  const elecCtx   = document.getElementById('drove-electricity-context');
  if (primaryKey === 'smart_hp_hh' || primaryKey === 'dumb_hp_hh') {
    const hhRates   = rateMetadata?.elec_hh_rate_by_hh?.filter(r => r !== null) ?? [];
    const avgHhRate = hhRates.length > 0
      ? hhRates.reduce((s, r) => s + r, 0) / hhRates.length
      : null;
    elecLabel.textContent = 'Electricity (half-hourly)';
    elecVal.textContent   = avgHhRate != null ? `${avgHhRate.toFixed(1)} p/kWh average` : 'Not available';
    const region = externalRes?.agile_calibration?.gsp_region ?? 'regional pricing';
    elecCtx.textContent   = `Agile tariff — region ${region}`;
  } else if (primaryKey === 'dumb_hp_svt') {
    elecLabel.textContent = 'Electricity (flat rate)';
    elecVal.textContent   = `${(rateMetadata?.svt_rate_p_per_kwh ?? 0).toFixed(1)} p/kWh`;
    elecCtx.textContent   = 'Standard variable tariff';
  } else {
    elecLabel.textContent = 'Electricity';
    elecVal.textContent   = 'Not available';
    elecCtx.textContent   = 'Pricing data limited';
  }

  // Stat 4 — Installation
  const instVal = document.getElementById('drove-install-value');
  const instCtx = document.getElementById('drove-install-context');
  const install = capitalP.installation_cost_full_hp_gbp;
  const grant   = capitalP.bus_grant_gbp;
  instVal.textContent = `£${(install / 1000).toFixed(1)}k`;
  instCtx.textContent = grant > 0
    ? `Less £${(grant / 1000).toFixed(1)}k BUS grant`
    : 'No grant applied';

  droveCard.classList.remove('hidden');
}
```

### Step 9 — app.js: Call `populateDroveTile` from `buildAndDisplayVerdict`

At Step 16h (app.js:1995-1996), after `verdictCard.classList.remove('hidden')`, add:
```js
// Step 16i — drove tile
populateDroveTile(financialResult, heatLossResult, rateMetadata, primaryKey);
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `minmax(0, 1fr)` — Chart.js canvas has intrinsic sizing; may resist column shrinkage | `minmax(0, 1fr)` is the correct fix; `maintainAspectRatio: false` already set on the chart — test at ~520px tile width |
| `<details>` + inner `.section-tiles` — some browsers may have quirks with grid inside `<details>` | Native `<details>` doesn't create a grid context; inner `.section-tiles` div does — no interaction expected; verify in Chrome and Firefox |
| `agile_calibration` absent before m8-patch lands | Defensive null-coalescing in `populateDroveTile` for `externalRes?.agile_calibration?.gsp_region` — falls back to `'regional pricing'` |
| `bannerVerdict` rename — if any other reference to `bannerVerdict` exists (e.g. in CSV pipeline or recalculate path), it will throw | Grep for `bannerVerdict` after renaming and confirm zero remaining references |
| Methodology disclosure state — opening `<details>` with grid children inside: Chrome triggers layout on open; content flashes from single-column to 2-column | Acceptable on first open only; subsequent opens are instant. No mitigation needed |

---

## Success criteria

- [ ] At desktop (≥1100px), Results shows verdict-card and drove-card side by side, equal width
- [ ] At desktop, Your home shows results-card and energy-summary-card side by side
- [ ] At desktop, Methodology (when opened) shows 2×2: heat-loss + thermal-character, hp-model + scenario
- [ ] Adjust the assumptions section is unchanged from M10a
- [ ] Cost breakdown section shows pricing-card and financial-card full-width stacked
- [ ] At ≤768px, every `.section-tiles` collapses to single column
- [ ] drove-card populates four stat blocks with correct values
- [ ] Stat 3 label and value adapt for `dumb_hp_svt` vs HH scenarios
- [ ] Section banner reads "Cost breakdown" (not "The verdict")
- [ ] Container max-width 1100px confirmed in DevTools
- [ ] Bar chart renders correctly at ~520px tile width
- [ ] Methodology disclosure still opens/closes; inner 2×2 grid visible when open
- [ ] drove-card values use Montserrat; labels uppercase navy; context muted
- [ ] No layout breakage at desktop, tablet (768–1099px), mobile (≤375px)
- [ ] No console errors

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-29
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `design/ui-design-m10b.md` (praxis-claude-hub commit `b6a26cb`)
**Verdict:** ✅ APPROVED — implementation steps unchanged

### Context

Plan reviewed against the m10b design (latest commit `b6a26cb` in praxis-hub).
All 9 implementation steps map faithfully to design Sections A–E. One
signature-style deviation in Step 8 (`populateDroveTile`) accepted on codebase
grounds; six LOW findings (template hygiene + design-doc field-name drift)
addressed at amend time.

### Substantive checks performed

- **All 9 steps map to design Sections A–E line-for-line.** Container width,
  `.section-tiles` grid, drove-card CSS spec, four section restructures,
  banner rename, and `populateDroveTile` logic all align.
- **`populateDroveTile` 4-param signature deviation accepted as
  codebase-aligned.** Design specifies a 7-param explicit-dependency
  signature; plan reduces to 4 params + module-scope accessor calls inside
  the function (`getHeatPumpModelResult()`, `getExternalResult()`,
  `readCapitalParams()`). Verified at review time that the 4-param pattern
  matches the prevailing convention in `app.js`: existing display functions
  use 1-param signatures; `buildAndDisplayVerdict` uses 3 params;
  module-scope accessor calls (34 occurrences across app.js) are the
  established pattern for cross-module data access. Plan's deviation
  *aligns* the function to existing codebase conventions rather than
  drifting from them. Accepted.
- **`rateMetadata` scope at call site verified.** Step 9 calls
  `populateDroveTile(financialResult, heatLossResult, rateMetadata,
  primaryKey)` inside `buildAndDisplayVerdict`. Confirmed by grep that
  `buildAndDisplayVerdict(financialResult, heatLossResult, rateMetadata)`
  already takes `rateMetadata` as its third parameter (`app.js:1903`).
  No threading required.
- **`elec_hh_rate_by_hh` field name correctly used.** Plan resolves the
  m10b design's stale `agile_rate_by_hh` reference to match the m8-patch
  implementation's `elec_hh_rate_by_hh`. Architect has corrected the design
  doc in the same commit pass — both `agile_rate_by_hh` references in
  `design/ui-design-m10b.md` replaced with `elec_hh_rate_by_hh`.
- **Sequence number corrected** in plan header (`5 of 6` → `4 of 6`) to
  match the design's authoritative sequencing. ui-fixes-2 is parallel and
  not in the linear stream.

### Plan-internal cleanup applied at amend time

- Section heading: `Claude.ai Review` → `Design Review` (template hygiene).
- Status field: `Awaiting approval` → `✅ Approved — 2026-04-29`.
- Sequence numbering corrected to `4 of 6`.

### Note for future plans (not applied)

Same systemic note as ui-fixes-2, patch-agile, and m8-patch: research
findings and implementation steps reference specific line numbers
(e.g. `app.js:229`, `app.js:1668`, `app.js:1996`). Acceptable here because
implementation is imminent and surrounding function names are also given.
Worth discouraging in future plans per the heatpump architect brief.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | — |
| HIGH     | 0     | — |
| MEDIUM   | 0     | — |
| LOW      | 6     | All resolved (template hygiene applied at amend; design field-name fixed by architect; rateMetadata scope verified at review time) |

Verdict: ✅ APPROVED — implementation steps unchanged; 4-param
`populateDroveTile` signature accepted as codebase-aligned; design-doc
field-name drift resolved by architect.

---

## Approval

**Status:** ✅ Approved — 2026-04-29
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** 4-param `populateDroveTile` signature accepted
(matches prevailing `app.js` pattern: 1-param display functions, 3-param
`buildAndDisplayVerdict`, module-scope accessors throughout). Design doc
corrected in praxis-hub to use `elec_hh_rate_by_hh` field name (matches
m8-patch implementation).

---

## Implementation Deviations

[To be completed post-implementation]
