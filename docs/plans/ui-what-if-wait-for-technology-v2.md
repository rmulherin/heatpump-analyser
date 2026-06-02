# ui-what-if-wait-for-technology-v2 — §15 Wait for Technology

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the §15 Wait for Technology card (second card of the WHAT IF section). The
card lets users explore HP performance via a master multiplier slider + four per-anchor
temperature sliders. Recalculate reruns M6→M7→M8→M9. The seasonal COP live-preview uses
m6-v2's exact `annual_mean_cop` formula (integration-v2 I2 — single source of truth).

Design doc: `ui-overhaul-what-if.md` §4. Required read: `ui-overhaul-conventions-v2.md`.

**Key elements:**
- 15a title/intro; 15b master multiplier slider (0–2×, step 0.05, default 1.00×);
  15c four per-anchor sliders at {−7, 2, 7, 12}°C (range 0.5–5.0, step 0.05, default
  EoH H4 base values 2.25/2.72/3.20/3.35); 15d seasonal COP live readout ("Your average
  COP: X.XX"); 15e Reset; 15f Recalculate at bottom; 15g status line above; no text below.
- Master slider: scales all anchors proportionally, **wipes** custom per-anchor pins.
- Per-anchor slider: pins one anchor, master shows `Custom`.
- Seasonal COP live readout: uses m6-v2's exact heating-hours-weighted formula (transient
  preview only — NOT a second source). See integration-v2 I2 carve-out.
- Drop `COP_BASELINE_AT_7C` constant; 7°C slider shows inline cert hint only.
- Propagation: M6→M7→M8→M9 exact rerun; `paybackFromCosts()` helper updates §12.

**Implementation prerequisite:** m6-v2, m7-v2, m8-v2, m9-v2 implemented; `paybackFromCosts`
exported from `js/financial.js` (per m8-m9 plan).

---

## Research findings

**Existing §15 card (`ui-design-m10c-what-if`):** has a COP master slider and a "Recalculate"
button. `COP_BASELINE_AT_7C = 2.91` constant is in `app.js`. The per-anchor sliders and
the live SCOP readout are new. The existing `btnRecalcScenario` handler triggers M6→M7→M8→M9.

**EoH H4 base values:** {−7: 2.25, 2: 2.72, 7: 3.20, 12: 3.35} — from m6-v2 design doc.
These are the default slider positions (user_cop_scalar = 1.0, no anchor overrides).

**Seasonal COP formula (I2 carve-out):** `Σ Q_delivered[t] × COP(T_out[t]) / Σ Q_delivered[t]`
summed over heating hours only (where `Q_delivered > 0`). This is m6-v2's exact
`annual_mean_cop` computation. The live readout implements this locally using the current
slider state + the stored `external[].temp_c` array and `m7.scenarios.dumb_hp.components.elec_space_heat[]`
as a proxy for heating hours. After Recalculate, m6-v2 sets the canonical value which
propagates to §4d.

**`COP_BASELINE_AT_7C` removal:** search `app.js` for the constant and all references;
remove them. The 7°C reference COP is no longer a standalone display value.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | §15 card DOM: master slider, per-anchor sliders, SCOP readout, Reset, status, Recalculate |
| MODIFY | `app.js` | Slider handlers, live SCOP compute, M6→M9 rerun, COP_BASELINE removal |
| MODIFY | `css/style.css` | Per-anchor sliders layout; SCOP readout prominence |

---

## Implementation steps

### Step 1 — §15 Card DOM in `index.html`

```html
<div id="card-15" class="what-if-card">
  <h3 class="card-title">Wait for Technology</h3>
  <p class="card-intro">Heat pump efficiency has improved from a field-trial median around 2.5 to around 3.4 over the last decade. See how changes to your modelled HP performance affect results.</p>

  <label class="cop-master-label">
    Performance multiplier (all temperatures): <strong id="master-display">1.00×</strong>
    <input type="range" id="cop-master-slider" min="0" max="2" step="0.05" value="1.00">
  </label>

  <details id="cop-anchor-details">
    <summary>Per-temperature sliders</summary>
    <p class="orientation-copy">Each slider sets the COP at a specific outdoor temperature. Your average COP below is the seasonal mean across the hours your heat pump would run.</p>
    <div class="anchor-sliders">
      <label>−7°C: <input type="range" class="cop-anchor" data-temp="-7" min="0.5" max="5.0" step="0.05" value="2.25"> <span class="anchor-display">2.25</span></label>
      <label>2°C:  <input type="range" class="cop-anchor" data-temp="2"  min="0.5" max="5.0" step="0.05" value="2.72"> <span class="anchor-display">2.72</span></label>
      <label>7°C:  <input type="range" class="cop-anchor" data-temp="7"  min="0.5" max="5.0" step="0.05" value="3.20"> <span class="anchor-display">3.20</span>
        <em class="anchor-hint">standard certification reference temperature</em>
      </label>
      <label>12°C: <input type="range" class="cop-anchor" data-temp="12" min="0.5" max="5.0" step="0.05" value="3.35"> <span class="anchor-display">3.35</span></label>
    </div>
  </details>

  <p class="scop-readout">Your average COP: <strong id="scop-live">3.20</strong></p>

  <button id="btn-cop-reset">Reset to field-trial median</button>

  <p id="cop-status" class="status-line">Same as the results above — this is the base case.</p>
  <button id="btn-recalc-cop" id="cop-sliders">Recalculate</button>
</div>
```

> Note: `id="cop-sliders"` on the Recalculate button is the hyperlink-to-adjust target
> used by §4d Mean COP and §10g Average COP (both link `#cop-sliders`).

### Step 2 — Master slider: proportional scaling + pin wipe

```js
const BASE_ANCHORS = { '-7': 2.25, '2': 2.72, '7': 3.20, '12': 3.35 };
let pinnedAnchors = {};   // { temp: value } — per-anchor overrides

document.getElementById('cop-master-slider').addEventListener('input', e => {
  const mult = parseFloat(e.target.value);
  document.getElementById('master-display').textContent = `${mult.toFixed(2)}×`;

  // Scale all anchors proportionally; wipe pins
  pinnedAnchors = {};
  document.querySelectorAll('.cop-anchor').forEach(slider => {
    const base = BASE_ANCHORS[slider.dataset.temp];
    const val  = Math.min(5.0, Math.max(0.5, base * mult));
    slider.value = val;
    slider.nextElementSibling.textContent = val.toFixed(2);
  });

  updateScopLiveReadout();
  updateCopStatus(mult === 1.0 ? 'base' : `${mult.toFixed(2)}× performance`);
});
```

### Step 3 — Per-anchor slider: pin one, master shows Custom

```js
document.querySelectorAll('.cop-anchor').forEach(slider => {
  slider.addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    const temp = slider.dataset.temp;
    pinnedAnchors[temp] = val;
    slider.nextElementSibling.textContent = val.toFixed(2);

    // Master shows Custom
    document.getElementById('master-display').textContent = 'Custom';
    updateScopLiveReadout();
    updateCopStatus('Custom');
  });
});
```

### Step 4 — Seasonal COP live readout (I2 carve-out)

Must use m6-v2's exact heating-hours-weighted formula. At slider-move time (before
Recalculate), compute a preview using the current anchor values + stored temperature data:

```js
function updateScopLiveReadout() {
  // Interpolate EoH piecewise-linear COP curve from current anchor values
  const anchors = getAnchorValues();  // { '-7': v, '2': v, '7': v, '12': v }
  const copAtTemp = t => interpolateCopCurve(anchors, t);  // m6-v2 piecewise-linear

  // Heating-hours-weighted SCOP: Σ Q[t] × COP(T[t]) / Σ Q[t]
  const dumbHp = getScenarioResult()?.scenarios?.dumb_hp;
  const ext    = getExternalData();
  if (!dumbHp || !ext) return;

  let sumWtd = 0, sumQ = 0;
  for (let i = 0; i < dumbHp.components.elec_space_heat.length; i++) {
    const q  = dumbHp.components.elec_space_heat[i] ?? 0;
    const tc = ext[i]?.temp_c ?? null;
    if (q <= 0 || tc == null) continue;
    const cop = copAtTemp(tc);
    sumWtd += q * cop;
    sumQ   += q;
  }
  const scop = sumQ > 0 ? sumWtd / sumQ : null;
  document.getElementById('scop-live').textContent = scop != null ? scop.toFixed(2) : '—';
}
```

`interpolateCopCurve(anchors, T)` uses the same EoH piecewise-linear formula as m6-v2
(clamped at −7 and 12). Implement once, shared with the Recalculate path.

### Step 5 — Reset button

```js
document.getElementById('btn-cop-reset').addEventListener('click', () => {
  pinnedAnchors = {};
  document.getElementById('cop-master-slider').value = 1.00;
  document.getElementById('master-display').textContent = '1.00×';
  Object.entries(BASE_ANCHORS).forEach(([temp, base]) => {
    const slider = document.querySelector(`.cop-anchor[data-temp="${temp}"]`);
    slider.value = base;
    slider.nextElementSibling.textContent = base.toFixed(2);
  });
  updateScopLiveReadout();
  updateCopStatus('base');
});
```

### Step 6 — Recalculate: M6→M7→M8→M9 exact rerun

```js
document.getElementById('btn-recalc-cop').addEventListener('click', async () => {
  const user_cop_scalar      = parseFloat(document.getElementById('cop-master-slider').value);
  const user_anchor_overrides = Object.keys(pinnedAnchors).length ? pinnedAnchors : null;

  // Rerun M6 with new scalar/overrides → M7 → M8 → M9
  await runPipelineFromM6({ user_cop_scalar, user_anchor_overrides });

  // After rerun, m6-v2 sets the canonical SCOP → propagates to §4d + §10g
  // Update §15d to match (it now matches the canonical value)
  const m6 = getHeatPumpModelResult();
  document.getElementById('scop-live').textContent = m6.annual_mean_cop.toFixed(2);

  // §12 payback updates via paybackFromCosts()
  const net_inv = getNetInvestment();
  const newPayback = paybackFromCosts(getPricingResult().scenarios, net_inv);
  refreshPaybackDisplay(newPayback);

  updateCopStatus('applied');
});
```

### Step 7 — Remove `COP_BASELINE_AT_7C` constant

Search `app.js` for `COP_BASELINE_AT_7C` (value 2.91). Remove the constant and all
references to it. The 7°C anchor slider carries only an inline certification hint now.

### Step 8 — Status line two-state

`updateCopStatus(state)`:
- `'base'` → `"Same as the results above — this is the base case."`
- `'Custom'` → `"You're modelling Custom per-temperature settings — results above reflect these changes."`
- `'applied'` → keeps the last override description.
- `'X× performance'` → `"You're modelling X× performance — results above reflect these changes."`

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Live SCOP preview diverges from m6-v2 canonical after Recalculate | Step 6: after Recalculate, overwrite the readout with `m6.annual_mean_cop` (canonical wins); preview is transient only |
| `interpolateCopCurve` must exactly match m6-v2's formula | Read m6-v2 design doc / implementation before writing; use exactly the same breakpoints and clamping logic |
| `pinnedAnchors` state lost if page rerenders | State is in-memory closure; fine for same-session use; no persistence needed |
| `getNetInvestment()` name may not match existing function | Read app.js for the §10B input accessor; use the exact name |

---

## Success criteria

- [ ] Master slider 1.50× scales all four anchor sliders proportionally; per-anchor pins wiped; SCOP rises
- [ ] Moving 7°C slider alone → master shows "Custom"; SCOP reflects non-uniform curve
- [ ] Seasonal COP live readout uses heating-hours-weighted formula; matches §4d after Recalculate
- [ ] 7°C slider has inline certification hint; no standalone "COP 2.9 at 7°C" headline anywhere
- [ ] `COP_BASELINE_AT_7C` constant absent from codebase after implementation
- [ ] Recalculate reruns M6→M7→M8→M9; §3 bars + §11/§12 including payback update
- [ ] Reset: master 1.00×, anchors → EoH base; `pinnedAnchors = {}`; SCOP → default
- [ ] Status line: base / "You're modelling X" / "Custom"; auto-calc OFF
- [ ] Recalculate at bottom; status line above; no text below
- [ ] Clicking §4d / §10g Mean COP focuses `#cop-sliders` (opens What-If if needed)

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
