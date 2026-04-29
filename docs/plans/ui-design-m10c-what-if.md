# ui-design-m10c-what-if — "What If" section

**Date:** 2026-04-29
**Status:** ⚠ Approved with edits — applied 2026-04-29
**Design doc:** `design/ui-design-m10c-what-if.md`
**Implements:** sequence 5 of 6 (after ui-design-m10b). ui-fixes-2 is parallel to the main stream and not counted in the linear sequence.

---

## Task description

Replace the "Adjust the assumptions" section (Section 5) with a new "What If" section
containing two equal tiles: (1) Policy Reform + Wait for Technology combined in one card,
(2) Get Your Quotes. All inputs from the old section migrate into the appropriate tile;
nothing is lost. The old `pricing-params-card` and `financial-params-card` (and their
banner) are removed from the HTML. The COP scalar slider relocates from the hp-model
methodology card to the Wait for Technology sub-section within tile 1. Live auto-update
where the recalculation chain is cheap (M8→M9 or M9-only); explicit Recalculate button
where the chain is expensive (M6→M7→M8→M9). Get Your Quotes tile includes a "Disconnect
gas" toggle that, when enabled, shows a DHW/other split slider and computes the net annual
benefit of removing the gas connection.

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
0.6–1.5× in 0.05 steps (19 values) using proportional scaling. Hold `_scenarioResult`
and `_rateMetadata` fixed; for each COP scalar, scale HP electricity consumption
proportionally (`elec_kwh[i] *= baseline_cop / scaled_cop`), re-run `computeCosts`,
re-run `analyseFinancials`. **This is mathematically exact (not approximate) under
uniform COP scaling:** dispatch order, capacity constraint, and daily heat budget B_d
are all invariant to the scalar (scalar cancels in the rank function `elec_rate[i] /
(scalar × baseCOP[i])`). ~50× cheaper than full chain runs and produces the same
threshold COP. Use `COP_BASELINE_AT_7C` (defined in Step 8) for the live display.

**`OFGEM_CAP_ELEC_P_KWH` and `OFGEM_CAP_GAS_P_KWH`:** These constants are added to
app.js by m8-patch. Policy Reform tile "Ofgem cap (base)" preset uses these constants
directly. `LEVY_ELEC_DELTA_P_PER_KWH = 2.0` and `LEVY_GAS_DELTA_P_PER_KWH = 0.5`
are new constants added by this plan.

**Historical rates for "Your historical rates" preset:** Available from
`getIngestionResult()` — tariff rates stored in the ingestion result. At implementation
time, identify the exact field names for historical SVT electricity rate and gas rate
in the ingestion result.

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
/* ===== Tile divider (within a combined card) ===== */
.tile-divider {
  border: none;
  border-top: 1px solid var(--colour-border);
  margin: 1.5rem 0;
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

/* ===== Info popout (Avoided AC and future fields) ===== */
.info-popout {
  display: inline-block;
  position: relative;
  margin-left: 0.35rem;
}
.info-icon {
  cursor: pointer;
  list-style: none;
  color: var(--colour-teal);
  font-size: 0.95rem;
  font-weight: 600;
  user-select: none;
}
.info-icon::-webkit-details-marker { display: none; }
.info-popout[open] .info-icon { color: var(--colour-coral); }
.info-content {
  position: absolute;
  top: 1.6rem;
  left: 0;
  z-index: 10;
  width: 22rem;
  max-width: 90vw;
  padding: 0.75rem 0.9rem;
  background: #fff;
  border: 1px solid var(--colour-border);
  border-radius: var(--radius);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--colour-dark);
  font-weight: normal;
}
```

**No `.section-tiles.three-up` class.** The What If section uses the standard 2-column
`.section-tiles` from M10b — no new grid modifier is needed.

### Step 2 — COP slider relocation: remove from hp-model-card (index.html)

In `#hp-model-card`, remove the `#hp-model-controls` block entirely — all of:
- `<label for="cop-scalar">`, `<input id="cop-scalar">`, `<output id="cop-scalar-value">`, the `.control-help` paragraph.
- The `#btn-recalculate-hp-model` button (removed entirely — no slider context remains in the methodology card; `#btn-recalc-cop-what-if` in the What If tile owns this chain).

Confirm by grep that no other code references `btnRecalcHpModel` after removal.

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
<div class="section-tiles hidden" id="what-if-tiles">

  <!-- Tile 1: Policy Reform + Wait for Technology (combined card) -->
  <div class="card" id="tile-policy-and-tech">

    <!-- B1. Policy Reform -->
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
        <label for="wi-levy-elec-delta">Electricity levy reduction <span class="unit">p/kWh</span></label>
        <input id="wi-levy-elec-delta" type="number" step="0.1" min="0" value="2.0">
        <label for="wi-levy-gas-delta">Gas levy increase <span class="unit">p/kWh</span></label>
        <input id="wi-levy-gas-delta" type="number" step="0.1" min="0" value="0.5">
      </div>
      <p class="field-hint">The "Full levy removal" preset moves these amounts off
        your electricity unit rate and onto gas — adjust if you have a different
        view of the policy shift.</p>
    </details>
    <div class="wi-output" id="policy-output"></div>

    <hr class="tile-divider">

    <!-- B2. Wait for Technology -->
    <h3>Wait for Technology</h3>
    <p class="card-intro">Heat pump efficiency (COP) has improved from ~2.5 to ~3.4
      over the past decade. This analysis uses a field-trial median. Adjust the slider
      to see how better — or worse — real-world performance changes your payback.</p>
    <label for="cop-scalar-what-if">Performance vs field-trial median</label>
    <input type="range" id="cop-scalar-what-if" min="0.6" max="1.5" step="0.05" value="1.0">
    <span id="cop-scalar-display">1.0× (COP 2.9 at 7°C)</span>
    <button class="btn btn-primary" id="btn-recalc-cop-what-if">Recalculate</button>
    <div class="wi-output" id="cop-output">
      <p id="cop-payback-line"></p>
      <p id="cop-threshold-line"></p>
    </div>

  </div>

  <!-- Tile 2: Get Your Quotes -->
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
      <label>
        Avoided AC cost <span class="unit">£</span>
        <details class="info-popout">
          <summary class="info-icon" aria-label="More information">ⓘ</summary>
          <div class="info-content">
            Some heat pump systems (particularly air-to-air) can provide cooling,
            removing the need for a separate AC installation. Enter the avoided upfront
            cost here. AC running costs are not modelled — heat pumps have no efficiency
            advantage over conventional AC when used for cooling.
          </div>
        </details>
      </label>
      <input id="wi-avoided-ac" type="number" step="100" min="0" value="0">
    </div>
    <div class="wi-output" id="quotes-output"></div>
    <label class="field-group" style="margin-top:0.75rem;display:flex;gap:0.5rem;align-items:center;">
      <input type="checkbox" id="disconnect-gas-toggle">
      Disconnect gas connection entirely
    </label>
    <div id="gas-split-group" hidden>
      <label for="gas-split-slider">How is your non-heating gas used?</label>
      <div class="slider-labels" style="display:flex;justify-content:space-between;font-size:0.8rem;">
        <span>Hot water (HP-integrated DHW)</span>
        <span>Other (cooking / immersion)</span>
      </div>
      <input type="range" id="gas-split-slider" min="0" max="100" step="5" value="70">
      <span id="gas-split-display">70% hot water · 30% other</span>
      <p class="field-hint">If you plan to use an immersion heater rather than
        HP-integrated hot water, slide fully to Other.</p>
    </div>
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
//         busGrantInput, avoidedAcInput, btnRecalcPricing, btnRecalcFinancial,
//         btnRecalcHpModel (and its event listener — COP chain now on btnRecalcCopWhatIf)
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
const copScalarDisplay       = document.getElementById('cop-scalar-display');   // note: not 'cop-scalar-what-if-display'
const btnRecalcCopWhatIf     = document.getElementById('btn-recalc-cop-what-if');
const copPaybackLine         = document.getElementById('cop-payback-line');
const copThresholdLine       = document.getElementById('cop-threshold-line');
// Get Your Quotes
const wiInstallCostInput     = document.getElementById('wi-install-cost');
const wiGrantInput           = document.getElementById('wi-grant');
const wiAvoidedAcInput       = document.getElementById('wi-avoided-ac');
const quotesOutput           = document.getElementById('quotes-output');
// Disconnect gas
const disconnectGasToggle    = document.getElementById('disconnect-gas-toggle');
const gasSplitGroup          = document.getElementById('gas-split-group');
const gasSplitSlider         = document.getElementById('gas-split-slider');
const gasSplitDisplay        = document.getElementById('gas-split-display');
// Levy delta inputs (Fine-tune block)
const wiLevyElecDeltaInput   = document.getElementById('wi-levy-elec-delta');
const wiLevyGasDeltaInput    = document.getElementById('wi-levy-gas-delta');
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
  param (if null, `prepareRates` uses the tariff-derived rate as before). This is the third
  optional extension to `prepareRates` after `ofgem_cap_elec_p_kwh` and `agile_calibration`
  added by m8-patch — backwards-compatible: when `gas_rate_override_p_kwh` is null,
  existing tariff-windowing logic in `prepareRates` runs unchanged.

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

No `LEVY_*` constants — levy deltas are read from the `#wi-levy-elec-delta` and
`#wi-levy-gas-delta` inputs (added by Edit 7; defaults 2.0 and 0.5 set in HTML).

**Preset button wiring:**
```js
// "Ofgem cap (base)"
wiSvtRateInput.value = OFGEM_CAP_ELEC_P_KWH;
wiGasRateInput.value = OFGEM_CAP_GAS_P_KWH;

// "Full levy removal" — read levy deltas from inputs at click time
const elecDelta = parseFloat(wiLevyElecDeltaInput.value);
const gasDelta  = parseFloat(wiLevyGasDeltaInput.value);
wiSvtRateInput.value = (OFGEM_CAP_ELEC_P_KWH - (Number.isFinite(elecDelta) ? elecDelta : 2.0)).toFixed(2);
wiGasRateInput.value = (OFGEM_CAP_GAS_P_KWH  + (Number.isFinite(gasDelta)  ? gasDelta  : 0.5)).toFixed(2);

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

Add a named constant alongside the `OFGEM_CAP_*` constants:
```js
const COP_BASELINE_AT_7C = 2.91;  // EoH field-trial median COP at 7°C (M6 baseline)
```

**COP slider live display:**
```js
copScalarWhatIfInput.addEventListener('input', () => {
  const scalar = parseFloat(copScalarWhatIfInput.value);
  const copAt7 = (scalar * COP_BASELINE_AT_7C).toFixed(1);
  copScalarDisplay.textContent = `${scalar.toFixed(2)}× (COP ${copAt7} at 7°C)`;
});
```

**Recalculate button:** `btnRecalcCopWhatIf` triggers the same M6→M7→M8→M9 chain as
`btnRecalcHpModel`. Since `copScalarInput` now points to `#cop-scalar-what-if`, the
existing `btnRecalcHpModel` handler already reads from the correct input — wire
`btnRecalcCopWhatIf` to run the same async chain. After completion, update
`copPaybackLine` and `copThresholdLine`.

Update `copScalarValue` display reference: `copScalarValue` (app.js:187) pointed to
`#cop-scalar-value` in the old methodology card. After removal of that element, this
reference must be removed or redirected. The live display is now `copScalarDisplay`
(pointing to `#cop-scalar-display` in the What If tile). At implementation time, search
for all uses of `copScalarValue` in app.js and update or remove them.

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

Auto-update on any input change (installation cost, grant, avoided AC): call
`runFinancialAnalysis()` (M9-only — no pipeline re-run needed). Update `quotesOutput`
with condensed payback table:

```
Full HP (smart HH):   X years   [or em-dash if no_data]
Full HP (SVT):        Y years
```

Positive-verdict rows in bold.

**Disconnect gas toggle and slider:**

```js
disconnectGasToggle.addEventListener('change', () => {
  gasSplitGroup.hidden = !disconnectGasToggle.checked;
  updateQuotesOutput();
});

gasSplitSlider.addEventListener('input', () => {
  const hw = parseInt(gasSplitSlider.value);
  gasSplitDisplay.textContent = `${hw}% hot water · ${100 - hw}% other`;
  updateQuotesOutput();
});
```

**Disconnect gas delta calculation** (UI-level arithmetic — no M8/M9 rerun):

```js
function computeGasDisconnectDelta() {
  if (!disconnectGasToggle.checked) return 0;

  const COP_DHW   = 2.5;  // HP-integrated hot water
  const COP_OTHER = 1.0;  // immersion heater / cooking

  // `getBaseloadResult()` shape: { heating: [...{ baseload_kwh }], ... }
  // No pre-computed annual total — sum from per-HH array.
  const baseload = getBaseloadResult();
  const baseloadGasKwh = baseload?.heating
    ? baseload.heating.reduce((s, h) => s + (h.baseload_kwh ?? 0), 0)
    : null;
  if (baseloadGasKwh === null || baseloadGasKwh === 0) return 0;

  const gasRateP  = parseFloat(wiGasRateInput.value)      || OFGEM_CAP_GAS_P_KWH;
  const gasScP    = parseFloat(wiGasStandingInput.value)  || 0;
  const elecRateP = parseFloat(wiSvtRateInput.value)      || OFGEM_CAP_ELEC_P_KWH;

  const gasSaving = (baseloadGasKwh * gasRateP / 100) + (gasScP * 365 / 100);

  const hwFraction    = parseInt(gasSplitSlider.value) / 100;
  const otherFraction = 1 - hwFraction;
  const dhwElecKwh    = baseloadGasKwh * hwFraction    / COP_DHW;
  const otherElecKwh  = baseloadGasKwh * otherFraction / COP_OTHER;
  const elecAdded     = (dhwElecKwh + otherElecKwh) * elecRateP / 100;

  return gasSaving - elecAdded;
}
```

**Output when disconnect gas is off:** single payback column as above.

**Output when disconnect gas is on:** two-column table (Gas retained | Gas disconnected),
each computed as `net_investment / (base_annual_saving + gasDisconnectDelta)`. Below table:
```
Disconnecting gas saves £X/year in gas costs; adds £Y/year in electricity.
Net annual benefit: £Z.
```
If `gasDisconnectDelta` is negative: "Disconnecting gas would add £Z/year at these rates."
If `baseloadGasKwh` is null: disable the toggle, show tooltip "Gas usage data needed — run
the analysis first."

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Threshold COP computation — 19 iterations on page load | Proportional scaling — `elec_kwh[i] *= baseline_cop / scaled_cop`, then re-run M8 + M9 — is exact under uniform COP scaling because dispatch order, capacity, and B_d are all invariant. ~50× cheaper than full chain runs and produces the same threshold COP. |
| Historical rate field path in ingestion result — exact field name not confirmed | Flag at implementation time: search for where SVT and gas rates are stored in `getIngestionResult()`; the `_ingestionResult.tariff_rates` or similar structure |
| `copScalarValue` DOM reference (old `#cop-scalar-value`) — used in live display; after COP slider removal from methodology card, this ref must be cleaned up | Grep `copScalarValue` in app.js; confirm all uses updated or removed; new display ref is `copScalarDisplay` pointing to `#cop-scalar-display` |
| "Adjust the assumptions" section removal — `btnRecalcPricing` and `btnRecalcFinancial` are currently defined as visible inside those cards; after card removal the DOM refs will be null | Remove the card DOM elements in index.html; the `btnRecalcPricing` and `btnRecalcFinancial` buttons inside those sections are also removed. The What If auto-update replaces their function — check whether any other code reveals or manipulates these buttons and update accordingly |
| Gas rate for Octopus users — currently no single gas unit rate is surfaced in the UI (it comes from tariff data); the Policy Reform tile adds an explicit gas rate input; this is the first time Octopus users see a gas rate input | Pre-fill from `OFGEM_CAP_GAS_P_KWH` as the default (m8-patch uses this as the base rate for HP scenarios); label clearly as the base rate |
| Info popout `position: absolute` panel — may overflow the card boundary on narrow tiles (~520px) | Set `max-width: 90vw`; at narrow widths the 22rem panel clips to viewport width; acceptable; test at 520px tile width |
| Disconnect gas: `baseload_gas_annual_kwh` null path — toggle must be disabled gracefully | Wrap toggle interaction in a guard: check `getBaseloadResult()?.baseload_gas_annual_kwh != null` before enabling; show tooltip if null |

---

## Success criteria

- [ ] "What If" section appears as Section 5; old "Adjust assumptions" section is gone — no duplicate rate or installation inputs elsewhere
- [ ] Two tiles display side by side at desktop; stack at ≤768px without horizontal overflow; Policy Reform and Wait for Technology share tile 1 separated by a divider line
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
- [ ] Get Your Quotes: Avoided AC input present (moved from old Installation card); info popout (ⓘ) opens and displays explainer text
- [ ] Get Your Quotes: "Disconnect gas" toggle off — single payback column shown
- [ ] Get Your Quotes: "Disconnect gas" toggle on — two-column table (gas retained / gas disconnected) appears; split slider visible; net benefit line shown below table
- [ ] Get Your Quotes: Slider at 70/30 default — gas saving and electricity added arithmetic match hand calculation; slider at 100% Other applies full baseload at COP 1.0 only
- [ ] Get Your Quotes: Disconnect gas toggle disabled if `baseload_gas_annual_kwh` is null
- [ ] No `#install-hybrid` input anywhere in the page
- [ ] No console errors after any combination of tile interactions

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-29
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `design/ui-design-m10c-what-if.md` (praxis-claude-hub commit `3d015ca`)
**Verdict:** ⚠ APPROVED WITH EDITS — apply the seven edits below to the plan body before implementing, commit the amended plan (`plan amend: m10c-what-if — apply review edits`), then proceed to implementation.

### Context

Plan reviewed against the m10c-what-if design (latest commit `3d015ca`).
Architecture, scope, file targets, and step ordering all align. The
threshold-COP computation question Sonnet flagged for review is resolved
(proportional scaling is exact, not approximate, under uniform COP scalar).
One MEDIUM (redundant Recalculate button left over from COP relocation) and
several smaller items, all bounded enough for inline edits rather than full
rewrite.

### Threshold-COP question — resolved

Sonnet flagged in research findings: confirm full M6→M7→M8→M9 chain vs
proportional scaling. **Proportional scaling is exact for uniform COP scaling**:

- M6's COP slider is a uniform multiplicative scalar: `COP[i] = scalar × baseCOP[i]` for all i.
- Therefore `elec_kwh[i] = heat_demand[i] / COP[i] = baseElecKwh[i] / scalar` — uniform inverse scaling.
- Smart-scenario dispatch (post `smart-scenario-fixes-1` greedy LP) ranks HHs
  by cost = `elec_rate[i] / COP[i] = elec_rate[i] / (scalar × baseCOP[i])`.
  Scalar cancels in the ranking — dispatch order is invariant.
- HP capacity constraint is on thermal kWh per HH, with HP capacity =
  HTC × ΔT / 1000 — independent of COP. Constraint unchanged.
- Daily heat budget B_d is anchored to observed (`Σ heating_kwh × η`) —
  independent of COP.

Net: total elec scales by 1/scalar exactly; M8/M9 outputs scale linearly
from there. Use proportional scaling without accuracy hedge — covered in
Edit 2 below.

### Edits to apply before implementing

**Edit 1 (MEDIUM) — Remove the redundant `#btn-recalculate-hp-model` from the methodology card.**

Step 2 currently says "update `#btn-recalculate-hp-model` label to 'Recalculate'". Change to: remove the button entirely. The COP slider has relocated to the What If tile; the methodology card has no slider context, so a recalculate control there is confusing duplication of `#btn-recalc-cop-what-if`.

- In Step 2 (index.html section): remove the entire `#hp-model-controls` block, including the recalculate button (not just the slider).
- In Step 4 (DOM refs): remove the `btnRecalcHpModel` DOM reference and its event listener (`btnRecalcHpModel.addEventListener(...)` at app.js:1419 per research findings).
- Step 8 wiring is unaffected — `btnRecalcCopWhatIf` already runs the same M6→M7→M8→M9 chain.
- Confirm by grep that no other code references `btnRecalcHpModel` after removal.

**Edit 2 — Threshold-COP wording: drop the "approximation" hedge.**

In research findings (the "Threshold COP computation" paragraph) and Risk row 1: replace "lightweight M9-only recalculation"/"approximation" framing with the explicit statement that proportional scaling is **exact** under uniform COP scaling (rationale in the section above). Risk row 1 mitigation should read along the lines of: *"Proportional scaling — `elec_kwh[i] *= baseline_cop / scaled_cop`, then re-run M8 + M9 — is exact under uniform COP scaling because dispatch order, capacity, and B_d are all invariant. ~50× cheaper than full chain runs and produces the same threshold COP."*

**Edit 3 — Make the `prepareRates` extension explicit.**

In Step 5 (pricing param reads): the new `gas_rate_override_p_kwh` parameter is the third post-m8-patch extension to `prepareRates` (after `ofgem_cap_elec_p_kwh` and `agile_calibration`). Add a sentence calling this out: *"This adds a third optional parameter to `prepareRates` on top of `ofgem_cap_elec_p_kwh` and `agile_calibration` (added by m8-patch). Backwards-compatible: if `gas_rate_override_p_kwh` is null, `prepareRates` uses the tariff-derived rate as before."* So an implementer reading the plan understands they're amending m8-patch's contract, not creating a fresh function.

**Edit 4 — Replace `2.91` magic number in COP live display.**

Step 8 hardcodes `(scalar * 2.91).toFixed(1)` in the slider live-display formula. The `2.91` is the EoH field-trial median COP at 7°C used by M6. Replace with a named constant or read from the M6 baseline curve at module scope. Examples:

- Add a constant in `app.js`: `const COP_BASELINE_AT_7C = 2.91;` (with a comment noting source: M6 EoH field-trial median).
- Or expose via a helper from the M6 module if one exists (`getBaselineCopAt(7)` or similar).

Display formula then reads: `(scalar * COP_BASELINE_AT_7C).toFixed(1)`.

**Edit 5 — Verify `baseload_gas_annual_kwh` field at implementation time.**

Step 9's `computeGasDisconnectDelta` reads `baseload?.baseload_gas_annual_kwh`. M3's design produces baseload as `baseload_kwh` per HH slot, not as an annual total field. Verify at implementation time:

1. Grep `getBaseloadResult()` shape in app.js — does an `annual_*` field already exist?
2. If yes, use it.
3. If no, compute the annual total once: `const baseloadGasKwh = baseload.heating.reduce((s, h) => s + (h.baseload_kwh ?? 0), 0)` (or equivalent based on actual structure).

Add a brief note in Step 9 documenting the resolution and the source of the value.

**Edit 6 — Drop the stale `.three-up` paragraph from research findings.**

Research findings includes a paragraph (lines 77-80) describing a `.three-up` CSS modifier for a 3-tile grid. The design has since collapsed to 2 tiles, and Step 1 correctly uses the standard `.section-tiles` from M10b without the modifier. Delete the paragraph entirely so research findings doesn't contradict the implementation.

**Edit 7 — Make levy deltas editable inputs (replace hardcoded constants).**

The "Full levy removal" preset uses two policy-shift values that should be user-adjustable rather than hardcoded constants. Default values: `2.0p/kWh` electricity reduction, `0.5p/kWh` gas increase.

Concretely:

- Remove the constants from Step 7:
  ```js
  // remove:
  // const LEVY_ELEC_DELTA_P_PER_KWH = 2.0;
  // const LEVY_GAS_DELTA_P_PER_KWH  = 0.5;
  ```

- Add two new inputs to the Policy Reform tile's existing `<details class="wi-finetune">` block (alongside the standing-charge inputs in Step 3):
  ```html
  <label for="wi-levy-elec-delta">Electricity levy reduction <span class="unit">p/kWh</span></label>
  <input id="wi-levy-elec-delta" type="number" step="0.1" min="0" value="2.0">

  <label for="wi-levy-gas-delta">Gas levy increase <span class="unit">p/kWh</span></label>
  <input id="wi-levy-gas-delta" type="number" step="0.1" min="0" value="0.5">
  ```

- Add a short help line at the bottom of the fine-tune block:
  ```html
  <p class="field-hint">The "Full levy removal" preset moves these amounts off
    your electricity unit rate and onto gas — adjust if you have a different
    view of the policy shift.</p>
  ```

- Add DOM refs in Step 4:
  ```js
  const wiLevyElecDeltaInput = document.getElementById('wi-levy-elec-delta');
  const wiLevyGasDeltaInput  = document.getElementById('wi-levy-gas-delta');
  ```

- Update the "Full levy removal" preset handler in Step 7 to read from the inputs at click time (not from constants), with safe fallbacks if input is empty/invalid:
  ```js
  // "Full levy removal"
  const elecDelta = parseFloat(wiLevyElecDeltaInput.value);
  const gasDelta  = parseFloat(wiLevyGasDeltaInput.value);
  wiSvtRateInput.value = (OFGEM_CAP_ELEC_P_KWH - (Number.isFinite(elecDelta) ? elecDelta : 2.0)).toFixed(2);
  wiGasRateInput.value = (OFGEM_CAP_GAS_P_KWH + (Number.isFinite(gasDelta)  ? gasDelta  : 0.5)).toFixed(2);
  ```

- If the user manually edits a levy delta after the preset has been clicked, the displayed rates do NOT auto-update — the rate inputs only refresh when the preset button is re-clicked. (Consistent with the existing "manual rate edit deselects preset" pattern.)

### Plan-internal cleanup applied at amend time (reviewer-mode edits)

- Section heading: `Claude.ai Review` → `Design Review` (template hygiene).
- Status field: `Awaiting approval` → `⚠ Approved with edits — apply Edits 1–7 below before implementing (2026-04-29)`.
- Sequence numbering: `sequence 6 of 6` → `sequence 5 of 6` (matches design;
  ui-fixes-2 is parallel, not in the linear stream).

### Sonnet protocol

When picking up this plan for implementation:

1. Apply Edits 1–7 to the plan body. Update Status to `⚠ Approved with edits — applied 2026-04-29`. Commit (`plan amend: m10c-what-if — apply review edits`).
2. Then proceed with implementation against the amended plan.
3. Implementation Deviations section (post-implementation) records any further deviations discovered while writing the code.

### Note for future plans (not applied)

Same systemic note as ui-fixes-2, patch-agile, m8-patch, and m10b: research findings and implementation steps reference specific line numbers (e.g. `app.js:186`, `app.js:1419`, `app.js:1701`). Acceptable here because surrounding function names are also given. Worth discouraging in future plans per the heatpump architect brief.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | — |
| HIGH     | 0     | — |
| MEDIUM   | 1     | Edit 1 — Sonnet to apply |
| LOW      | 6     | Edits 2–7 + template hygiene — Sonnet to apply remaining; template hygiene applied at amend |

Verdict: ⚠ APPROVED WITH EDITS — Sonnet applies Edits 1–7 to plan body before implementation; threshold-COP question resolved (proportional scaling is exact); levy deltas surfaced as editable inputs with 2.0/0.5 defaults.

---

## Approval

**Status:** ⚠ Approved with edits — apply Edits 1–7 before implementing (2026-04-29)
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** Threshold-COP proportional scaling is mathematically exact under uniform COP scalar (no full chain runs needed). Levy delta defaults locked at 2.0p/kWh electricity reduction and 0.5p/kWh gas increase, but exposed as editable inputs in the fine-tune block so users can adjust without code changes. Methodology card recalculate button removed entirely after COP slider relocation. `prepareRates` extension explicitly noted as third post-m8-patch optional parameter.

---

## Implementation Deviations

[To be completed post-implementation]
