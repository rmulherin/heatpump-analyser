# ui-design-m10c-what-if — "What If" section

**Date:** 2026-04-29
**Status:** Awaiting approval — review via claude.ai before implementation begins.
**Design doc:** `design/ui-design-m10c-what-if.md`
**Implements:** sequence 6 of 6 (after ui-design-m10b)

---

## Task description

Replace the "Adjust the assumptions" section (Section 5) with a new "What If" section
containing three equal tiles: Policy Reform, Wait for Technology, and Get Your Quotes.
All inputs from the old section migrate into the appropriate tile; nothing is lost. The
old `pricing-params-card` and `financial-params-card` (and their banner) are removed
from the HTML. The COP scalar slider relocates from the hp-model methodology card to the
Wait for Technology tile. Live auto-update where the recalculation chain is cheap (M8→M9
or M9-only); explicit Recalculate button where the chain is expensive (M6→M7→M8→M9).

---

## Research findings

**Current "Adjust the assumptions" section:** `index.html:346-396`. Contains:
- `#section-banner-assumptions` — banner (h2: "Adjust the assumptions")
- `#pricing-params-card` — inputs: `#svt-rate`, `#elec-standing-charge`,
  `#gas-standing-charge`, `#hh-overhead` (removed by m8-patch)
- `#financial-params-card` — inputs: `#install-full-hp`, `#install-hybrid`
  (removed since hybrids gone), `#bus-grant`, `#avoided-ac`

**COP scalar current location:** `#cop-scalar` (range input) in `#hp-model-card`
(index.html:264), with live display `#cop-scalar-value` and recalculate button
`#btn-recalculate-hp-model`. DOM reference `copScalarInput` at app.js:186.
`btnRecalcHpModel` event listener at app.js:1419 runs M6→M7→M8→M9 chain.

**Read functions in app.js:**
- `readCapitalParams()` (line 272): reads `#install-full-hp`, `#install-hybrid`,
  `#bus-grant`, `#avoided-ac` — needs updating to read from new tile IDs.
- `readPricingParams()` equivalent: pricing params are read directly from input
  elements in `runPricingEngine` at app.js:1688 via `prepareRates(ingestion, external,
  params)` where `params` is built from reading input fields. Needs to read from new
  tile input IDs after migration.

**Recalculation chains:**
- Policy Reform rate changes: M8→M9 only → `runPricingEngine() + runFinancialAnalysis()`
  (same as `btnRecalcPricing` listener at app.js:1701).
- Wait for Technology COP change: M6→M7→M8→M9 → same chain as `btnRecalcHpModel`
  (app.js:1419-1434).
- Get Your Quotes install/grant change: M9 only → `runFinancialAnalysis()` (same as
  `btnRecalcFinancial` at app.js). Update `readCapitalParams` to read new IDs.

**Threshold COP computation (Wait for Technology):** The design doc specifies iterating
0.6–1.5× in 0.05 steps (19 values) using "a lightweight M9-only recalculation using
the pre-existing M7/M8 outputs." Literal interpretation: hold `_scenarioResult` and
`_rateMetadata` fixed; for each COP scalar, scale HP electricity consumption
proportionally (`elec_kwh[i] *= baseline_cop / scaled_cop`), re-run `computeCosts`,
re-run `analyseFinancials`. This avoids the full RC model re-simulation (M7 chain) for
19 iterations. Implementation note: this is an approximation — COP changes affect HP
electricity non-linearly (the RC model dispatches differently at different COPs).
**Flag for review:** confirm whether true M6→M7→M8→M9 chain per step is required for
accuracy, or whether the proportional scaling approximation is acceptable for the
threshold display.

**`OFGEM_CAP_ELEC_P_KWH` and `OFGEM_CAP_GAS_P_KWH`:** These constants are added to
app.js by m8-patch. Policy Reform tile "Ofgem cap (base)" preset uses these constants
directly. `LEVY_ELEC_DELTA_P_PER_KWH = 2.0` and `LEVY_GAS_DELTA_P_PER_KWH = 0.5`
are new constants added by this plan.

**Historical rates for "Your historical rates" preset:** Available from
`getIngestionResult()` — tariff rates stored in the ingestion result. At implementation
time, identify the exact field names for historical SVT electricity rate and gas rate
in the ingestion result.

**`section-tiles.three-up` CSS:** Extend the `.section-tiles` class from M10b with a
`.three-up` modifier. The base `.section-tiles` uses 2-column — `.three-up` overrides
to 3-column. Mobile collapse at ≤767px (note: 767px not 768px to avoid overlap with
the 2-up breakpoint; the design doc specifies `≤767px` for three-up).

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | Remove old Section 5; add "What If" section; relocate COP slider from hp-model-card |
| MODIFY | `js/app.js` | New event listeners; updated read functions; threshold computation; DOM ref updates |
| MODIFY | `css/styles.css` | `.section-tiles.three-up`, `.preset-group`, `.preset-btn` |

---

## Implementation steps

### Step 1 — CSS additions (styles.css)

Append:
```css
/* ===== Three-up tile grid ===== */
.section-tiles.three-up {
  grid-template-columns: repeat(3, 1fr);
}
@media (max-width: 767px) {
  .section-tiles.three-up {
    grid-template-columns: 1fr;
  }
}

/* ===== Preset buttons ===== */
.preset-group {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.preset-btn {
  padding: 0.35rem 0.75rem;
  border: 1.5px solid var(--colour-teal);
  border-radius: var(--radius);
  background: #fff;
  color: var(--colour-teal);
  font-family: var(--font-heading);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.preset-btn.active {
  background: var(--colour-teal);
  color: #fff;
}
.preset-btn:hover:not(.active) { background: #f0f7f7; }
```

### Step 2 — COP slider relocation: remove from hp-model-card (index.html)

In `#hp-model-card` (index.html:260-281), remove the `#hp-model-controls` block entirely:
- `<label for="cop-scalar">` and its `<input id="cop-scalar">`, `<output id="cop-scalar-value">`, and the `.control-help` paragraph.
- The "Recalculate with updated COP setting" button label change: update `#btn-recalculate-hp-model` label to "Recalculate" (it continues to trigger M6→M7→M8→M9 chain, now reading COP from the new `#cop-scalar-what-if` input in the What If tile).

### Step 3 — index.html: Replace Section 5 with "What If"

**Remove** (in this order):
1. `<div class="section-banner hidden" id="section-banner-assumptions">` and its contents
2. `<section class="card hidden" id="pricing-params-card">` and its contents
3. `<section class="card hidden" id="financial-params-card">` and its contents

**Add** in their place — the complete "What If" section:

```html
<!-- Section 5: What If -->
<div class="section-banner hidden" id="section-banner-what-if">
  <h2 class="section-heading">What If</h2>
</div>
<div class="section-tiles three-up hidden" id="what-if-tiles">

  <!-- Tile 1: Policy Reform -->
  <div class="card" id="tile-policy-reform">
    <h3>Policy Reform</h3>
    <p class="card-intro">HP running costs above use the April 2026 Ofgem cap rates —
      what you'd pay if you installed today. See how further policy change, or your
      historical rates, compare.</p>
    <div class="preset-group">
      <button class="preset-btn active" data-preset="ofgem-apr26">Ofgem cap (base)</button>
      <button class="preset-btn" data-preset="levy-removal">Full levy removal</button>
      <button class="preset-btn" data-preset="historical">Your historical rates</button>
    </div>
    <div class="params-grid">
      <label for="wi-svt-rate">Electricity unit rate <span class="unit">p/kWh</span></label>
      <input id="wi-svt-rate" type="number" step="0.01" min="0">
      <label for="wi-gas-rate">Gas unit rate <span class="unit">p/kWh</span></label>
      <input id="wi-gas-rate" type="number" step="0.01" min="0">
    </div>
    <details class="wi-finetune">
      <summary>Fine-tune ▸</summary>
      <div class="params-grid">
        <label for="wi-elec-standing">Electricity standing charge <span class="unit">p/day</span></label>
        <input id="wi-elec-standing" type="number" step="0.01" min="0">
        <label for="wi-gas-standing">Gas standing charge <span class="unit">p/day</span></label>
        <input id="wi-gas-standing" type="number" step="0.01" min="0">
      </div>
    </details>
    <div class="wi-output" id="policy-output"></div>
  </div>

  <!-- Tile 2: Wait for Technology -->
  <div class="card" id="tile-wait-for-tech">
    <h3>Wait for Technology</h3>
    <p class="card-intro">Heat pump efficiency (COP) has improved from ~2.5 to ~3.4
      over the past decade. This analysis uses a field-trial median. Adjust the slider
      to see how better — or worse — real-world performance changes your payback.</p>
    <label for="cop-scalar-what-if">Performance vs field-trial median</label>
    <input type="range" id="cop-scalar-what-if" min="0.6" max="1.5" step="0.05" value="1.0">
    <span id="cop-scalar-what-if-display">1.0× (COP 2.9 at 7°C)</span>
    <button class="btn btn-primary" id="btn-recalc-cop-what-if">Recalculate</button>
    <div class="wi-output" id="cop-output">
      <p id="cop-payback-line"></p>
      <p id="cop-threshold-line"></p>
    </div>
  </div>

  <!-- Tile 3: Get Your Quotes -->
  <div class="card" id="tile-get-quotes">
    <h3>Get Your Quotes</h3>
    <p class="card-intro">Installation costs vary from £8,000 to £18,000 depending on
      property, installer, and system size. Get three quotes from MCS-certified
      installers and enter the range below.</p>
    <div class="preset-group">
      <button class="preset-btn active" data-preset="bus-current">BUS grant — £7,500</button>
      <button class="preset-btn" data-preset="bus-none">No grant</button>
      <button class="preset-btn" data-preset="bus-enhanced">Enhanced — £10,000 (proposed)</button>
    </div>
    <div class="params-grid">
      <label for="wi-install-cost">Installation cost <span class="unit">£</span></label>
      <input id="wi-install-cost" type="number" step="100" min="0" value="12500">
      <label for="wi-grant">Grant / subsidy <span class="unit">£</span></label>
      <input id="wi-grant" type="number" step="100" min="0" value="7500">
      <label for="wi-avoided-ac">Avoided AC cost <span class="unit">£</span></label>
      <input id="wi-avoided-ac" type="number" step="100" min="0" value="0">
    </div>
    <div class="wi-output" id="quotes-output"></div>
    <p class="card-intro" style="margin-top:0.75rem;font-size:0.85rem;">
      The BUS grant (£7,500) applies to standalone air-source or ground-source heat pump
      installations. Other schemes (e.g. £2,500 for air-to-air units) can be entered in
      the grant field above.
    </p>
  </div>

</div>
```

### Step 4 — app.js: New DOM references

Remove old references:
```js
// Remove: references to svtRateInput, hhOverheadInput, elecStandingInput,
//         gasStandingInput, installFullHpInput, installHybridInput,
//         busGrantInput, avoidedAcInput
```

Add new references:
```js
const sectionBannerWhatIf    = document.getElementById('section-banner-what-if');
const whatIfTiles            = document.getElementById('what-if-tiles');
// Policy Reform
const wiSvtRateInput         = document.getElementById('wi-svt-rate');
const wiGasRateInput         = document.getElementById('wi-gas-rate');
const wiElecStandingInput    = document.getElementById('wi-elec-standing');
const wiGasStandingInput     = document.getElementById('wi-gas-standing');
const policyOutput           = document.getElementById('policy-output');
// Wait for Technology
const copScalarWhatIfInput   = document.getElementById('cop-scalar-what-if');
const copScalarWhatIfDisplay = document.getElementById('cop-scalar-what-if-display');
const btnRecalcCopWhatIf     = document.getElementById('btn-recalc-cop-what-if');
const copPaybackLine         = document.getElementById('cop-payback-line');
const copThresholdLine       = document.getElementById('cop-threshold-line');
// Get Your Quotes
const wiInstallCostInput     = document.getElementById('wi-install-cost');
const wiGrantInput           = document.getElementById('wi-grant');
const wiAvoidedAcInput       = document.getElementById('wi-avoided-ac');
const quotesOutput           = document.getElementById('quotes-output');
```

Update `copScalarInput` reference (app.js:186) to point to the new element:
```js
// was: const copScalarInput = document.getElementById('cop-scalar');
const copScalarInput = document.getElementById('cop-scalar-what-if');
```

This means `btnRecalcHpModel` (methodology card recalculate) continues to read COP from
the new location automatically.

### Step 5 — app.js: Update `readCapitalParams` and pricing param reads

Update `readCapitalParams` (app.js:272) to read from new IDs:
- `installation_cost_full_hp_gbp`: from `wiInstallCostInput`
- `bus_grant_gbp`: from `wiGrantInput`
- `avoided_ac_cost_gbp`: from `wiAvoidedAcInput`
- Remove `installation_cost_hybrid_gbp` (hybrids removed by m8-patch)

Update wherever pricing params are read for `prepareRates` to use new IDs:
- `svt_rate_p_per_kwh`: from `wiSvtRateInput`
- `svt_standing_charge_p`: from `wiElecStandingInput`
- `gas_standing_charge_p`: from `wiGasStandingInput`
- Gas rate: from `wiGasRateInput` — pass to `prepareRates` as a new `gas_rate_override_p_kwh`
  param (if null, `prepareRates` uses the tariff-derived rate as before)

### Step 6 — app.js: Section reveal

Update the reveal logic so that `sectionBannerWhatIf` and `whatIfTiles` are revealed
at the same point where `section-banner-assumptions` was previously revealed (in
`displayPricingResults` or `runPricingEngine`). Grep for `bannerAssumptions` reveal to
find the exact location.

Also pre-fill the What If inputs when the analysis first completes:
- `wi-svt-rate` → `OFGEM_CAP_ELEC_P_KWH`
- `wi-gas-rate` → `OFGEM_CAP_GAS_P_KWH`
- `wi-elec-standing` → value from rate metadata
- `wi-gas-standing` → value from rate metadata
- `wi-install-cost` → `FA_CONFIG.INSTALLATION_FULL_HP_DEFAULT_GBP`
- `wi-grant` → `FA_CONFIG.BUS_GRANT_DEFAULT_GBP`

### Step 7 — app.js: Policy Reform tile logic

Add new constants (alongside `OFGEM_CAP_*` added by m8-patch):
```js
const LEVY_ELEC_DELTA_P_PER_KWH = 2.0;
const LEVY_GAS_DELTA_P_PER_KWH  = 0.5;
```

**Preset button wiring:**
```js
// "Ofgem cap (base)"
wiSvtRateInput.value = OFGEM_CAP_ELEC_P_KWH;
wiGasRateInput.value = OFGEM_CAP_GAS_P_KWH;

// "Full levy removal"
wiSvtRateInput.value = OFGEM_CAP_ELEC_P_KWH - LEVY_ELEC_DELTA_P_PER_KWH;
wiGasRateInput.value = OFGEM_CAP_GAS_P_KWH + LEVY_GAS_DELTA_P_PER_KWH;

// "Your historical rates"
// Read from ingestion result — identify field at implementation time
const ingestion = getIngestionResult();
wiSvtRateInput.value = ingestion?.tariff_rates?.svt_rate_p_per_kwh ?? OFGEM_CAP_ELEC_P_KWH;
wiGasRateInput.value = ingestion?.tariff_rates?.gas_rate_p_per_kwh ?? OFGEM_CAP_GAS_P_KWH;
```

If user manually edits a rate after selecting a preset, deactivate all preset buttons.

**Auto-update:** `wiSvtRateInput`, `wiGasRateInput`, `wiElecStandingInput`,
`wiGasStandingInput` each have an `input` event listener that calls
`runPricingEngine() + runFinancialAnalysis()` and then updates `policyOutput`.

**Output format:**
```
"At these rates, your best scenario payback is X years"
"Compared with Y years at the Ofgem cap base case"
```

When "Ofgem cap (base)" is active: "Same as the results above — this is the base case."

### Step 8 — app.js: Wait for Technology tile logic

**COP slider live display:**
```js
copScalarWhatIfInput.addEventListener('input', () => {
  const scalar = parseFloat(copScalarWhatIfInput.value);
  const copAt7 = (scalar * 2.91).toFixed(1);
  copScalarWhatIfDisplay.textContent = `${scalar.toFixed(2)}× (COP ${copAt7} at 7°C)`;
});
```

**Recalculate button:** `btnRecalcCopWhatIf` triggers the same M6→M7→M8→M9 chain as
`btnRecalcHpModel`. Since `copScalarInput` now points to `#cop-scalar-what-if`, the
existing `btnRecalcHpModel` handler already reads from the correct input — wire
`btnRecalcCopWhatIf` to run the same async chain. After completion, update
`copPaybackLine` and `copThresholdLine`.

Update `copScalarValue` display reference: `copScalarValue` (app.js:187) pointed to
`#cop-scalar-value` in the old methodology card. After removal of that element, either
remove this reference entirely or redirect it. Since the new tile has
`#cop-scalar-what-if-display` for the live display, `copScalarValue` reference can be
removed. At implementation time, search for all uses of `copScalarValue` in app.js and
update them.

**Threshold COP line:** Computed once after `runFinancialAnalysis` completes on the main
pipeline run. Iterate COP scalar from 0.6 to 1.5 in 0.05 steps — see "Flag for review"
in Research findings above. Store result in a module-level variable `_thresholdCopScalar`.
Display:
- If threshold found: `"Your payback drops below 10 years at a COP of X× the field-trial median."`
- If not found: `"Your payback stays above 10 years across the full range of modelled performance."`

### Step 9 — app.js: Get Your Quotes tile logic

Grant preset buttons pre-fill `wiGrantInput`:
- "BUS grant — £7,500" → 7500
- "No grant" → 0
- "Enhanced — £10,000 (proposed)" → 10000

Auto-update on any input change: call `runFinancialAnalysis()` (M9-only — no pipeline
re-run needed). Update `quotesOutput` with condensed payback table:

```
Full HP (smart HH):   X years   [or em-dash if no_data]
Full HP (SVT):        Y years
```

Positive-verdict rows in bold.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Threshold COP computation — 19 full M6→M7→M8→M9 chain runs on page load may take ~15s | Design doc says "M9-only using pre-existing M7/M8 outputs" — implement proportional scaling approximation; flag for Rhiannon to verify accuracy is acceptable |
| Historical rate field path in ingestion result — exact field name not confirmed | Flag at implementation time: search for where SVT and gas rates are stored in `getIngestionResult()`; the `_ingestionResult.tariff_rates` or similar structure |
| `copScalarValue` DOM reference (old `#cop-scalar-value`) — used in live display; after COP slider removal from methodology card, this ref must be cleaned up | Grep `copScalarValue` in app.js; confirm all uses updated or removed |
| "Adjust the assumptions" section removal — `btnRecalcPricing` and `btnRecalcFinancial` are currently defined as visible inside those cards; after card removal the DOM refs will be null | Remove the card DOM elements in index.html; the `btnRecalcPricing` and `btnRecalcFinancial` buttons inside those sections are also removed. The What If auto-update replaces their function — check whether any other code reveals or manipulates these buttons and update accordingly |
| Gas rate for Octopus users — currently no single gas unit rate is surfaced in the UI (it comes from tariff data); the Policy Reform tile adds an explicit gas rate input; this is the first time Octopus users see a gas rate input | Pre-fill from `OFGEM_CAP_GAS_P_KWH` as the default (m8-patch uses this as the base rate for HP scenarios); label clearly as the base rate |
| Three-up grid at 768px exact — `.section-tiles.three-up` collapses at ≤767px while 2-up collapses at ≤768px; at exactly 768px, 3-up shows 3 columns while 2-up shows 1 | Intentional per breakpoint spec; test at 768px to confirm visual coherence |

---

## Success criteria

- [ ] "What If" section appears as Section 5; old "Adjust assumptions" section is gone — no duplicate rate or installation inputs elsewhere
- [ ] Three tiles display side by side at desktop; stack at ≤767px without horizontal overflow
- [ ] Policy Reform: "Ofgem cap (base)" pre-fills cap constants; output reads "Same as results above"
- [ ] Policy Reform: "Full levy removal" adjusts rates by `LEVY_ELEC_DELTA` and `LEVY_GAS_DELTA`
- [ ] Policy Reform: "Your historical rates" fills from ingestion result
- [ ] Policy Reform: Manual rate edit deselects all preset buttons
- [ ] Policy Reform: Standing charges hidden behind "Fine-tune"; visible when expanded
- [ ] Wait for Technology: COP slider absent from methodology disclosure (relocated)
- [ ] Wait for Technology: Slider live display updates on drag (`X× (COP Y at 7°C)`)
- [ ] Wait for Technology: Recalculate updates payback and comparison line
- [ ] Wait for Technology: Threshold line appears on initial render; correct wording for both found/not-found cases
- [ ] Get Your Quotes: Grant presets fill the grant input; "Enhanced" shows "(proposed)" label
- [ ] Get Your Quotes: Changing any input updates condensed payback table immediately
- [ ] Get Your Quotes: Avoided AC input present (moved from old Installation card)
- [ ] No `#install-hybrid` input anywhere in the page
- [ ] No console errors after any combination of tile interactions

---

## Claude.ai Review — yyyy-mm-dd

**Reviewer:** Claude (Praxis Insight — Opus architect window)

**Overall verdict:** [Approved / Approved with clarifications / Revise and resubmit]

### What is solid

### Clarifications required before implementation

### Minor observations (not blockers)

---

## Approval

**Status:** [pending]
**Approved by:**
**Clarifications confirmed:**

---

## Implementation Deviations

[To be completed post-implementation]
