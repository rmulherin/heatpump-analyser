# ui-what-if-policy-reform-v2 — §14 Policy Reform

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the §14 Policy Reform card (first card of the WHAT IF section). The card lets
users explore tariff/policy scenarios via three presets and optional fine-tune inputs.
Recalculate reruns M8→M9 only (uniform rate scaling leaves M7 dispatch unchanged).

Design doc: `ui-overhaul-what-if.md` §3. Required read: `ui-overhaul-conventions-v2.md`.

**Key elements:**
- 14a title/intro; 14b three presets (Ofgem cap base / Full levy removal / Historical);
  14c visible rate inputs; 14d fine-tune collapsible; 14e fine-tune note; 14f status line;
  14g Recalculate at bottom, auto-calc OFF; 14i scale-all slider; 14j helper text.
- Propagation (14h): M8→M9 exact rerun; §3 bars, §4b, §11/§12 all update; M7 NOT rerun.
- Old §10d split slider, if still on this card from v1, must be removed (relocated to §10
  by `ui-methodology-sizing-v2`).

**Implementation prerequisite:** m8-v2 + m9-v2 implemented; `ui-methodology-sizing-v2`
implemented (split slider relocated away from this card).

---

## Research findings

**Existing What-If card (`ui-design-m10c-what-if`):** has "Policy Reform" presets and
"Levy Removal" preset buttons. Structure partially aligned with §14 but rates may differ
and the fine-tune collapse / scale-all slider may not exist yet. Read the existing HTML
and app.js before writing to confirm which elements exist and which are new.

**Q2 2026 Ofgem cap values (from PE_CONFIG):** SVT 24.50 p/kWh, elec standing 61.64
p/day, gas standing 31.66 p/day; gas unit from user's tariff. Full levy removal preset:
SVT − 2.0 p/kWh, gas + 0.5 p/kWh.

**Historical rates preset:** reads from `rateMetadata` (the user's actual Octopus tariff
if available; otherwise greys out the preset for CSV-path users).

**Scale-all slider (14i):** scales elec + gas unit rates + the HH wholesale baseline
proportionally. Implementation note from design doc: *"Confirm the precise HH-baseline
propagation through `pricing-engine.js`/`external-data.js`."* Read `prepareRates` before
implementing to understand how to scale the wholesale baseline.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | §14 card DOM: presets, fine-tune, scale-all, status, Recalculate |
| MODIFY | `app.js` | Preset handlers, scale-all propagation, M8→M9 rerun, §4b source label |
| MODIFY | `css/style.css` | Fine-tune collapsible; active-preset highlight |

---

## Implementation steps

### Step 1 — §14 Card DOM in `index.html`

```html
<div id="card-14" class="what-if-card">
  <h3 class="card-title">Policy Reform</h3>
  <p class="card-intro">HP running costs above use the April 2026 Ofgem cap rates — what you'd pay if you installed today. See how further policy change, or your historical rates, compare.</p>
  <p class="helper-text">Edit either rate below for custom values, or click a preset above to reset.</p>
  <div class="preset-row">
    <button class="preset-btn active" data-preset="base">Ofgem cap (base)</button>
    <button class="preset-btn" data-preset="levy">Full levy removal</button>
    <button class="preset-btn" data-preset="historical" id="btn-historical">Your historical rates</button>
  </div>
  <div class="rate-inputs">
    <label>Electricity unit rate (p/kWh): <input type="number" id="svt-rate-input" value="24.50" step="0.1"></label>
    <label>Gas unit rate (p/kWh): <input type="number" id="gas-rate-override-input" value="" placeholder="from your tariff"></label>
  </div>
  <details id="fine-tune-details">
    <summary>▶ Fine-tune ▶</summary>
    <label>Electricity standing (p/day): <input type="number" id="elec-standing-input" value="61.64" step="0.01"></label>
    <label>Gas standing (p/day): <input type="number" id="gas-standing-input" value="29.47" step="0.01"></label>
    <label>Elec levy reduction (p/kWh): <input type="number" id="elec-levy-delta" value="2.0" step="0.1"></label>
    <label>Gas levy increase (p/kWh): <input type="number" id="gas-levy-delta" value="0.5" step="0.1"></label>
    <label>Scale all unit rates (%):
      <input type="range" id="scale-all-slider" min="-30" max="50" value="0" step="5">
      <span id="scale-all-display">0%</span>
    </label>
    <p class="fine-tune-note">The 'Full levy removal' preset moves these amounts off your electricity unit rate and onto gas — adjust if you have a different view of the policy shift.</p>
  </details>
  <p id="policy-status" class="status-line">Same as the results above — this is the base case.</p>
  <button id="btn-recalc-policy">Recalculate</button>
</div>
```

Remove any existing §10d split slider or keep-gas toggle from this card (relocated to §10).

### Step 2 — Preset handlers

```js
const BASE_RATES = {
  svt: 24.50, gasSC: 29.47, elecSC: 61.64, elecLevy: 0, gasLevy: 0, scaleAll: 0,
};

const LEVY_RATES = {
  svt: 24.50 - 2.0,  // 22.50
  gasUnit: /* base gas */ + 0.5,
  gasSC: 29.47, elecSC: 61.64, elecLevy: 2.0, gasLevy: 0.5, scaleAll: 0,
};

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const preset = btn.dataset.preset;
    if (preset === 'base') applyPreset(BASE_RATES);
    else if (preset === 'levy') applyPreset(LEVY_RATES);
    else if (preset === 'historical') applyHistoricalRates();

    // Reset scale-all to 0 on any preset click
    document.getElementById('scale-all-slider').value = 0;
    document.getElementById('scale-all-display').textContent = '0%';
    updatePolicyStatus(preset === 'base' ? 'base' : btn.textContent);
  });
});
```

Historical rates: read from `rateMetadata.gas_rate_by_hh` (most recent gas rate) and
`rateMetadata.svt_rate_p_per_kwh` (user's actual). Disable the "Your historical rates"
button on CSV path (no tariff history): add class `preset-btn--disabled` + tooltip
*"Available after connecting Octopus account."*

### Step 3 — Input-change listeners (custom rates)

```js
['svt-rate-input', 'gas-rate-override-input'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    updatePolicyStatus('custom rates');
  });
});
```

On any input change, mark status as "custom rates" but do NOT rerun — rerun only on
Recalculate (auto-calc OFF).

### Step 4 — Scale-all slider (14i)

```js
document.getElementById('scale-all-slider').addEventListener('input', e => {
  const pct = parseInt(e.target.value);
  document.getElementById('scale-all-display').textContent = `${pct > 0 ? '+' : ''}${pct}%`;

  // Scale the visible rate inputs proportionally
  const base_svt = 24.50;  // cap default reference
  const base_gas = parseFloat(document.getElementById('gas-rate-override-input').value) || baseGasRate;
  document.getElementById('svt-rate-input').value = (base_svt * (1 + pct/100)).toFixed(2);
  // Gas rate scaled similarly; HH baseline scaling applied in prepareRates (see Step 5)
  updatePolicyStatus('custom rates');
});
```

### Step 5 — HH baseline scaling in M8 rerun

When Recalculate fires, pass a `scale_all_pct` parameter to `prepareRates` (or apply
inline before calling `computeCosts`). The scaling must propagate the wholesale baseline
so HH-derived rates move proportionally:

```js
// In app.js Recalculate handler:
const scaleAll = parseInt(document.getElementById('scale-all-slider').value) / 100;
// Re-apply to rateMetadata.elec_hh_rate_by_hh[] before calling computeCosts
const scaledElecHh = rateMetadata.elec_hh_rate_by_hh.map(r => r * (1 + scaleAll));
const scaledGasHh  = rateMetadata.gas_rate_by_hh.map(r  => r * (1 + scaleAll));
```

> **Implementation note:** confirm that scaling `elec_hh_rate_by_hh` in place does not
> mutate the stored `rateMetadata` — create a shallow copy if needed. Log a deviation
> if a different propagation approach is required.

### Step 6 — Recalculate: M8→M9 rerun only

```js
document.getElementById('btn-recalc-policy').addEventListener('click', async () => {
  const params = readPolicyRateInputs();   // gather current field values
  // Rerun M8 with new rates; M7 NOT rerun
  const newPricing  = computeCosts(rateMetadata, scenarioResult, params);
  setPricingResult(newPricing);
  const newFinancial = analyseFinancials(newPricing, rateMetadata, scenarioResult, getCapitalParams());
  setFinancialResult(newFinancial);
  // Re-render affected displays
  refreshVerdictBars(newPricing);
  refreshDrovePriceBlock(rateMetadata, params);  // §4b source label update
  refreshCostBreakdown(newPricing, newFinancial);
  updatePolicyStatus('applied', params);
});
```

M7 is NOT rerun — uniform rate scaling changes prices but not the smart dispatch pattern.

### Step 7 — §4b source label update

After Recalculate, update the `Flat-rate assumption` source parenthetical in §4b:
- Base case: `(from Octopus)` or `(Ofgem cap)`.
- After override: `(manual input)`.

Read the existing §4b display function; add a source-label parameter.

### Step 8 — Status line two-state

`updatePolicyStatus(state, params)`:
- `'base'` → `"Same as the results above — this is the base case."`
- Otherwise → `"You're modelling ${state} — results above reflect these changes."`

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Scale-all propagation through HH baseline unclear | Step 5 note: read prepareRates first; log deviation if approach differs |
| Historical rates not available on CSV path | Step 2: disable button; tooltip |
| `computeCosts` may read rateMetadata by reference | Step 6: shallow-copy elec_hh_rate + gas_rate before scaling; do not mutate global rateMetadata |
| "Full levy removal" base gas rate is unknown until the user's tariff is loaded | For the levy preset, use `rateMetadata.gas_rate_by_hh[most_recent]` + 0.5 p/kWh; if unavailable, grey out the levy preset |

---

## Success criteria

- [ ] Three presets present; Ofgem cap (base) active on load; active state highlighted
- [ ] Levy removal: elec rate drops ~2 p, gas rate rises ~0.5 p; fine-tune fields update
- [ ] Scale-all: −30% to +50% scales elec + gas unit rates; not standing charges/levies; resets to 0% on preset click
- [ ] Historical rates: disabled on CSV path with tooltip; applies user's actual rates on Octopus path
- [ ] Manual rate override: presets deactivate; status shows "custom rates"
- [ ] Recalculate: M8→M9 reruns; §3 bars + §4b + §11/§12 all update; M7 NOT rerun (smart kWh unchanged)
- [ ] §4b `Flat-rate assumption` source flips to `(manual input)` when rate overridden
- [ ] Status line two-state; auto-calc OFF (edits don't apply until Recalculate)
- [ ] Split slider absent from this card (relocated to §10)
- [ ] No text below Recalculate button

---

## Implementation Deviations

*To be completed after implementation.*

<!--
Status values:
- Awaiting review — Opus architect review pending.
- ✅ Approved — yyyy-mm-dd. Implementation may begin.
- ⚠ Approved with edits.
- ⏸ Blocked.
- Implemented — yyyy-mm-dd, commit <hash>.
-->
