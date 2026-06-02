# ui-methodology-sizing-v2 — §10 HP Sizing · §10B Your Installation

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement §10 Heat Pump Sizing and §10B Your Installation (the last two methodology
cards behind the `Show methodology` toggle).

Design doc: `ui-overhaul-methodology.md` §§5–6. Required read: `ui-overhaul-conventions-v2.md`.
Companion plan: `ui-methodology-heat-loss-v2` must be implemented first (it sets up the
methodology section + toggle pattern).

**§10 key changes:**
- 10d keep-gas toggle: **default OFF** (gas disconnected).
- 70/30 DHW/cooking split slider: **relocated from What-If to §10**, shown when toggle OFF,
  hidden when ON.
- 10e pre-heat slider: align default to 3 °C (flagged reconcile in design doc).
- 10a Required heat output row; 10b sizing margin; 10c design temperature (postcode-derived,
  advanced-override); 10f HP capacity in UK bracket {4,5,6,8,9,11,14,16} kW; 10g mean COP.
- 10j progress indicator on Recalculate.
- **Cut:** COP-at-reference-temps table (10h) and per-scenario kWh table (10i).
- Recalculate at bottom; status line above.

**§10B key changes:**
- Three inputs: install cost (£12,500), BUS grant (£7,500), avoided AC cost (£0).
- Net cost output (bold; live update).
- Soft note when 10d is OFF: *"Disconnecting gas may add hot-water/cooking rework…"*
- No payback list here (payback lives on §12).
- Fast M9-only rerun on input change.

**Build prerequisites flagged in design doc:**
- Postcode → CIBSE design-temperature lookup table (10c). Flag if this table is not in
  the codebase; halt if unresolved.
- UK HP capacity bracket confirmation: {4,5,6,8,9,11,14,16} kW pending manufacturer
  confirmation. Use this set; note as a deviation if adjusted.

**Implementation prerequisite:** m6-v2, m7-v2 (for capacity + split slider wiring).

---

## Research findings

**Existing §10:** `displayHeatPumpResults()` in `app.js`. Currently shows a heat-pump
sizing card with a different structure. The `#gas-split-slider` (70/30) currently lives
on the What-If card — this plan relocates it.

**§10d toggle:** `keep_gas_for_dhw_cooking` boolean fed to m7-v2. The toggle's current
home (What-If) will have it removed by `ui-what-if-policy-reform-v2` or similar.

**Design-temperature lookup (10c):** check whether a postcode→design-temp table exists
in the codebase. If absent, flag as a blocker — the design doc (architecture-v2 §8)
calls it an open build prerequisite.

**Mean COP (10g):** from m6-v2 `annual_mean_cop`. Label "Average COP" per G5. Hyperlinks
to §15.

**HP capacity bracket (10f):** the bracket set {4,5,6,8,9,11,14,16} is from the design
doc; use verbatim. The sizing formula: `raw = HTC × (setpoint − T_design) × (1 + margin%)
/ 1000 + DHW_load`; round up to the nearest bracket. DHW load when toggle OFF: add
`gas_dhw_obs_annual_kWh × η / cop_dhw / 8760 × 1000` (steady-state thermal kW of DHW).

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | §10 + §10B card DOM: toggle, relocated slider, progress indicator, cut tables |
| MODIFY | `app.js` | `displayHeatPumpResults()`, §10B display, Recalculate wiring, toggle/slider handlers |
| MODIFY | `css/style.css` | §10 card flow; conditional slider show/hide |

---

## Implementation steps

### Step 1 — Check design-temperature lookup table

Before writing any code, verify whether a `postcode → CIBSE design temperature` mapping
exists in the codebase:

- Grep for "design_temp", "cibse", "T_design" in js/ and app.js.
- If absent: **halt and flag** to Rhiannon — this is a stated build prerequisite
  (architecture-v2 §8). Do not proceed with §10c until the table exists.

If found: read its structure; use it in Step 4.

### Step 2 — §10 Card DOM in `index.html`

Replace/update the §10 card:

```html
<div class="card-row">
  <span class="card-label">Required heat output at −<span id="design-temp-display">X</span>°C</span>
  <span class="card-value" id="heat-output-raw"></span>
</div>
<label>Sizing margin (%): <input type="number" id="sizing-margin" value="15" min="0" max="50"></label>
<label>
  <input type="checkbox" id="keep-gas-toggle"> Keep gas for hot water + cooking?
</label>
<div id="split-slider-row" class="card-row">
  <label>Hot-water / cooking split:
    <input type="range" id="gas-split-slider" min="0" max="100" value="70" step="5">
    <span id="gas-split-display">70% water · 30% other</span>
  </label>
</div>
<label>Maximum pre-heat above setpoint (°C):
  <input type="range" id="preheat-offset" min="0" max="5" value="3" step="0.5">
  <span id="preheat-display">3.0°C</span>
</label>
<div class="card-row">
  <span class="card-label">HP capacity</span>
  <span class="card-value" id="hp-capacity-display"></span>
</div>
<div class="card-row">
  <span class="card-label">Average COP</span>
  <a href="#cop-sliders" class="hyperlink-adjust" id="mean-cop-display"></a>
</div>
<!-- Cut: COP table (10h) and per-scenario kWh table (10i) — not added -->
<p id="sizing-status" class="status-line">Same as the results above — this is the base case.</p>
<button id="btn-recalc-sizing">Recalculate</button>
<p id="sizing-progress" class="progress-note" hidden>Recalculating…</p>
```

### Step 3 — §10d toggle and split slider show/hide

```js
const keepGasToggle = document.getElementById('keep-gas-toggle');
const splitRow      = document.getElementById('split-slider-row');

keepGasToggle.addEventListener('change', () => {
  splitRow.hidden = keepGasToggle.checked;
  if (!keepGasToggle.checked) {
    // ADD soft note on §10B
    document.getElementById('gas-disconnect-note')?.removeAttribute('hidden');
  } else {
    document.getElementById('gas-disconnect-note')?.setAttribute('hidden', '');
  }
  updateSizingStatus();
});

// Default ON LOAD: toggle OFF (gas disconnected per design doc)
keepGasToggle.checked = false;
splitRow.hidden = false;
```

Gas-split slider live display:
```js
document.getElementById('gas-split-slider').addEventListener('input', e => {
  const pct = parseInt(e.target.value);
  document.getElementById('gas-split-display').textContent =
    `${pct}% water · ${100-pct}% other`;
  updateSizingStatus();
});
```

### Step 4 — Design temperature from postcode (10c)

```js
function getDesignTemperatureFromPostcode(postcode) {
  // Uses the postcode→CIBSE lookup table verified in Step 1
  // Returns e.g. −3 for SE England, −5 for Scotland
  return lookupCibseDesignTemp(postcode);  // existing or new fn
}
```

Populate `#design-temp-display` after postcode is resolved. Advanced override: a
`<details>` element exposes `<input id="design-temp-override">` — if set, it takes
precedence.

### Step 5 — HP capacity sizing + bracket rounding (10f)

```js
const HP_BRACKETS_KW = [4, 5, 6, 8, 9, 11, 14, 16];

function computeHpCapacityBracket(m4Result, thermalCharacter, keepGas, hw_split, m6Result) {
  const htc    = m4Result.htc_w_per_k ?? 0;
  const Tdes   = m4Result.design_temp_c ?? -3;         // from 10c lookup
  const Tset   = thermalCharacter.setpoint_c ?? 20;
  const margin = parseFloat(document.getElementById('sizing-margin').value) / 100 || 0.15;

  const peak_heat_kw = htc * (Tset - Tdes) * (1 + margin) / 1000;

  let dhw_kw = 0;
  if (!keepGas) {
    // Steady-state DHW load: annual gas_dhw_kwh → kW thermal → HP elec kW via cop_dhw
    // Approximation using m6-v2 cop_dhw and observed baseload × hw_split fraction
    const annual_dhw_kwh = (m4Result.annual_gas_baseload_kwh ?? 0) * hw_split;
    dhw_kw = annual_dhw_kwh * (m4Result.boiler_efficiency_used ?? 0.85) / (m6Result.cop_dhw ?? 2.0) / 8760;
  }

  const raw_kw  = peak_heat_kw + dhw_kw;
  const bracket = HP_BRACKETS_KW.find(b => b >= raw_kw) ?? HP_BRACKETS_KW[HP_BRACKETS_KW.length - 1];
  return { raw_kw, bracket };
}
```

Display: `${bracket} kW class` (hover title: `raw_kw.toFixed(1)} kW raw`).

### Step 6 — `displayHeatPumpResults()` update

Update to populate:
- `#heat-output-raw`: `raw peak load` in kW (before margin + DHW).
- `#hp-capacity-display`: bracket label.
- `#mean-cop-display`: `m6Result.annual_mean_cop.toFixed(2)`.
- Remove any write to the deleted COP table (10h) and kWh table (10i) rows.

### Step 7 — Progress indicator on Recalculate (10j)

```js
document.getElementById('btn-recalc-sizing').addEventListener('click', async () => {
  const progressEl = document.getElementById('sizing-progress');
  progressEl.hidden = false;
  try {
    await runPipelineFromM6();   // M6→M7→M8→M9
    updateSizingStatus('applied');
  } finally {
    progressEl.hidden = true;
  }
});
```

`progressEl.hidden = false` before the await → visible during the ~300 ms M7 recompute.

### Step 8 — Relocate `#gas-split-slider` from What-If

The What-If card currently hosts the 70/30 split slider (old `ui-design-m10c-what-if`).
Find and remove it from the What-If DOM (it will be cleaned up by the what-if plans,
but add a `<!-- REMOVED: relocated to §10 -->` comment there to avoid confusion).
This plan adds it to §10 (Step 2 above).

### Step 9 — §10B Your Installation DOM

```html
<div id="card-10b" class="methodology-card">
  <h3 class="card-title">Your Installation</h3>
  <p id="gas-disconnect-note" class="soft-note" hidden>
    Disconnecting gas may add hot-water/cooking rework — consider uplifting this estimate.
  </p>
  <label>Installation cost £: <input type="number" id="install-cost" value="12500"></label>
  <label>BUS grant £: <input type="number" id="bus-grant" value="7500"></label>
  <label>Avoided AC cost £: <input type="number" id="avoided-ac" value="0"></label>
  <div class="card-row">
    <span class="card-label">Net cost</span>
    <strong id="net-cost-display">£5,000</strong>
  </div>
</div>
```

### Step 10 — §10B live net cost + fast M9 rerun

```js
['install-cost', 'bus-grant', 'avoided-ac'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    updateNetCostDisplay();
    runM9Fast();   // M9-only rerun — fast param, no M7/M8 rerun
  });
});

function updateNetCostDisplay() {
  const install = parseFloat(document.getElementById('install-cost').value) || 0;
  const grant   = parseFloat(document.getElementById('bus-grant').value) || 0;
  const ac      = parseFloat(document.getElementById('avoided-ac').value) || 0;
  const net     = Math.max(0, install - grant - ac);
  document.getElementById('net-cost-display').textContent = `£${Math.round(net).toLocaleString('en-GB')}`;
}
```

`runM9Fast()` calls `analyseFinancials` with updated inputs and re-renders §12.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Design-temp lookup table absent | Step 1: halt if absent; flag blocker |
| HP bracket set {4,5,6,8,9,11,14,16} pending manufacturer confirmation | Use verbatim; note as a deviation candidate |
| Removing 70/30 slider from What-If before that plan is implemented | Add comment marker in What-If DOM; the what-if plans will clean it up formally |
| DHW kW approximation for capacity sizing may differ from m6-v2 `hp_capacity_kw_elec` | Read m6-v2 plan to see if it exposes a DHW-adjusted capacity; if so, use that directly |
| `#gas-disconnect-note` on §10B depends on toggle state set in §10 | Toggle handler in Step 3 shows/hides it; §10B rendered after §10 in the DOM |

---

## Success criteria

- [ ] §10 keep-gas toggle defaults OFF; split slider visible at 70/30 on load
- [ ] §10 toggle ON: split slider hidden; capacity = space-heat only
- [ ] §10 split slider moved from What-If; 70/30 shown; wired to m7-v2 `hw_split_fraction`
- [ ] HP capacity in {4,5,6,8,9,11,14,16} kW brackets; "5 kW class" label
- [ ] Design temp label updates per postcode region
- [ ] COP table and per-scenario kWh table absent
- [ ] Mean COP hyperlinks to §15
- [ ] Progress indicator visible during Recalculate (~300 ms M7 recompute)
- [ ] §10B: install/grant/AC inputs; net cost = install − grant − AC; live update; gas-disconnect soft note when toggle OFF
- [ ] §10B changes trigger M9-only rerun (§12 payback updates); no M7/M8 rerun
- [ ] Recalculate at bottom; status line above; no text below; auto-calc OFF

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
