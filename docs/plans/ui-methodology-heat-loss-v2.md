# ui-methodology-heat-loss-v2 — §7 Heat Loss · §8 Thermal Character

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement §7 Heat Loss and §8 Thermal Character cards (the first two of four
methodology cards behind the `Show methodology` toggle). These are the most
input-heavy cards: §7 replaces free-form boiler efficiency with a dropdown (7a),
adds the building-character row (7h), adds the electric-heating dropdown + tickbox
(7e), and removes several legacy inputs/rows; §8 reduces to a single thermal-mass
dropdown (8b) with no-block defaults.

Design doc: `ui-overhaul-methodology.md` §§3–4. Required read: `ui-overhaul-conventions-v2.md`.

**§7 key changes:**
- 7a: 4-tier boiler efficiency dropdown (replaces free-form numeric).
- 7d: winter setpoint numeric — no-block default from m5-v2 `setpoint_c` or 20°C.
- 7e: electric-heating dropdown (`None`/`Some`/`All electric`) + conditional tickbox.
  Default from m3-v2 `classification_effective`; tickbox default ticked iff fraction ≥ 0.15.
- 7h: new Building Character row (`net_flow_label` from m4-v2).
- 7i: Summer Cooling Potential — rename + title-case values.
- 7j: Heat-loss model fit (R²) — rename from "Fit quality".
- **Deleted:** floor area (7b), wall construction (7c), "Adjusted heat loss rate" row (7g),
  orange cold-weather-elec callout (7k).
- Hyperlinks from HTC grey value → 7a; Building character → 7d.
- Recalculate at card bottom; status line above; no-block.

**§8 key changes:**
- 8b: 4-bucket thermal-mass dropdown only — Path A long-event input deleted.
- 8d intro: single-input framing (Path A gone).
- 8a indicative caveat; soft prompt on `thermal_mass_source == 'fallback'`.
- **Deleted:** setpoint row (8f), occupancy model row (8c).
- No-block: pre-populated with `tau_dropdown_default_bucket` or `'medium'` fallback.
- Recalculate at bottom; status line above.

**Implementation prerequisite:** m3-v2, m4-v2, m5-v2 implemented.

---

## Research findings

**§7 existing code:** `displayHeatLossResults()` in `app.js` — renders the existing heat
loss card outputs. `btnRecalcHeatLoss` or similar triggers M4→M9 rerun. The boiler
efficiency input is currently a `<input type="number" id="boiler-efficiency">`. The
electric-heating section uses older API fields (`electric_heating_is_primary`,
`detected_uplift_pct`).

**§8 existing code:** `displayThermalCharacterResults()` — renders the existing thermal
character card. The thermal mass input has multiple fields (Path A: start-temp, overnight
hours). These must all be removed/hidden.

**Hyperlink-to-adjust pattern:** clicking a grey value focuses the corresponding input
control. Implemented as `el.addEventListener('click', () => targetInput.focus())`.
If the methodology toggle is closed, the click also opens it.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | §7/§8 card DOM: dropdown, tickbox, deleted inputs, new rows |
| MODIFY | `app.js` | `displayHeatLossResults()`, `displayThermalCharacterResults()`, Recalculate handlers |
| MODIFY | `css/style.css` | Status-line style; hyperlink-to-adjust cursor style |

---

## Implementation steps

### Step 1 — §7 Boiler efficiency dropdown (7a)

In `index.html`, replace `<input type="number" id="boiler-efficiency">` with:
```html
<select id="boiler-efficiency-dropdown">
  <option value="0.92">Modern condensing (post-2010) 0.92</option>
  <option value="0.85" selected>Older condensing (2005–2010) 0.85</option>
  <option value="0.70">Non-condensing 0.70</option>
  <option value="0.60">Very old / back boiler 0.60</option>
</select>
```
In `app.js`, update the boiler-efficiency read to `parseFloat(select.value)`.
Add `id="section-boiler-efficiency"` anchor for hyperlink-to-adjust target.

### Step 2 — §7 Delete legacy inputs/rows

In `index.html`, remove or hide:
- `<input>` for floor area (`#floor-area` or similar).
- `<input>` for wall construction (if a dropdown/field exists).
- The "Adjusted heat loss rate" output row (7g).
- The orange "cold-weather-elec" callout (7k).

In `app.js`, remove all reads of the deleted inputs and all writes to the deleted output row.

### Step 3 — §7 Electric-heating dropdown + tickbox (7e)

In `index.html`, add:
```html
<div id="electric-heating-section">
  <select id="electric-heating-dropdown">
    <option value="none">None</option>
    <option value="some">Some</option>
    <option value="all_electric">All electric household</option>
  </select>
  <label id="hp-replaces-elec-label" hidden>
    <input type="checkbox" id="hp-replaces-electric-heating" checked>
    Will the HP replace this electric heating?
    <span class="field-hint" id="hp-replaces-hint" hidden>
      Replacing structural electric heating typically isn't covered by the baseline install cost.
      Tick only if you're committing to the additional work.
    </span>
  </label>
</div>
```

In `app.js`, populate from m3-v2 on result render:
```js
function populateElectricHeatingControls(m3Result) {
  const cls = m3Result.electric_heating_classification_effective;
  const frac = m3Result.electric_heating_fraction_of_total_energy ?? 0;
  const dropdown = document.getElementById('electric-heating-dropdown');
  dropdown.value = cls;
  dropdown.disabled = cls === 'all_electric';   // lock when all_electric

  const tickboxLabel = document.getElementById('hp-replaces-elec-label');
  const tickbox = document.getElementById('hp-replaces-electric-heating');
  const hint    = document.getElementById('hp-replaces-hint');

  const showTickbox = cls !== 'none';
  tickboxLabel.hidden = !showTickbox;
  if (showTickbox) {
    tickbox.checked  = (frac >= 0.15);          // default per design doc
    tickbox.disabled = cls === 'all_electric';  // locked ticked
    hint.hidden = cls !== 'some';
  }
}
```

On dropdown change: set `m3Result.user_classification_override`; trigger M4→M9 rerun.
On tickbox change: set `hp_replaces_electric_heating`; trigger M7→M9 rerun.

### Step 4 — §7 Building character row (7h)

In `displayHeatLossResults()`, after existing output rows, add a new row:
```js
const label = m4Result.net_flow_label ?? 'Typical';    // 'Sheltered (+427 W)' etc.
const warning = Math.abs(m4Result.net_flow_w ?? 0) > 2000;
buildOutputRow('Building character', label, '#winter-setpoint-input', warning ? 'net_flow_warning' : null);
```
`buildOutputRow(label, value, hyperlink, warningClass)` creates `<tr>` with the grey
hyperlink value and optional warning class.

### Step 5 — §7 Output row renames

In `displayHeatLossResults()`:
- "Fit quality" → "Heat-loss model fit (R²)".
- "Summer cooling consideration" → "Summer cooling potential".
- Cooling values title-cased: `Minimal` / `Worth noting` / `Significant`.

### Step 6 — §7 Hyperlink-to-adjust wiring

```js
function addHyperlinkToAdjust(displayEl, targetId) {
  displayEl.style.cursor = 'pointer';
  displayEl.setAttribute('role', 'link');
  displayEl.addEventListener('click', () => {
    const target = document.getElementById(targetId);
    if (!target) return;
    // Open methodology toggle if closed
    const methSection = document.getElementById('methodology-section');
    if (methSection?.classList.contains('hidden')) {
      document.getElementById('show-methodology-btn')?.click();
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.focus();
  });
}
```

Wire: HTC grey value → `boiler-efficiency-dropdown`; Building character → `winter-setpoint-input`.

### Step 7 — §7 Status line + Recalculate

Add to the card (above the existing Recalculate button):
```html
<p id="heat-loss-status" class="status-line">Same as the results above — this is the base case.</p>
<button id="btn-recalc-heat-loss">Recalculate</button>
```

In `app.js`, set status to the "You're modelling X" variant when any input deviates from
the pipeline-run defaults. On Recalculate, run M4→M9 (or M7→M9 if only 7e/tickbox changed).

### Step 8 — §8 Thermal-mass dropdown only (8b)

In `index.html`, replace the Path-A inputs (start-temp, overnight-hours) with a single
`<select id="thermal-mass-bucket">`:
```html
<select id="thermal-mass-bucket">
  <option value="low">Cools noticeably within a few hours</option>
  <option value="medium" selected>Stays warm into the evening, cooler by morning</option>
  <option value="high">Stays warm until next morning</option>
  <option value="very_high">Stays warm for days</option>
</select>
```

In `app.js`, populate from m5-v2 `tau_dropdown_default_bucket` on result render:
```js
document.getElementById('thermal-mass-bucket').value =
  m5Result.tau_dropdown_default_bucket ?? 'medium';
```

On change: pass new bucket value to M5→M7→M9 rerun.

### Step 9 — §8 Delete legacy output rows

Remove from `displayThermalCharacterResults()`:
- "Estimated thermostat setpoint" row (8f — moved to §7 7d).
- "Occupancy model" row (8c — internal-only).

### Step 10 — §8 Indicative caveat + soft prompt (8a, fallback)

In `displayThermalCharacterResults()`:
- Always render: `<p class="card-caveat">Estimated from your description — indicative.</p>`.
- When `m5Result.thermal_mass_source === 'thermal_mass_source' === 'fallback'`:
  show `<p class="soft-note">We've used a typical UK default; update the dropdown above if you know your home holds its warmth differently.</p>`.
- Divergence text: when user bucket diverges from `tau_dropdown_default_bucket`:
  `<p class="divergence-note">Your data suggests a thermal time constant of ~X h; you've selected ~Y h. Using your selection.</p>`.

### Step 11 — §8 Status line + Recalculate + hyperlinks

Same pattern as §7 Step 7. Thermal mass + time constant grey values → `#thermal-mass-bucket`.

Status line (8e position): `<p id="thermal-char-status">Same as the results above…</p>`.

### Step 12 — §8 8d intro copy update

Replace the old Path-A-referencing intro with:
*"This optional input helps when your boiler runs continuously overnight or when Path A
estimation was uncertain. Can be left blank — a typical UK default is used."*

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Removing Path-A inputs may break existing event listeners that read them | Search `app.js` for all references to the Path-A input IDs before removing from HTML |
| `user_classification_override` may not be an existing m3-v2 input path in app.js | Read how `electric_heating_is_primary` was previously set; map the new dropdown → m3-v2 API |
| §7 Recalculate scope: 7e/tickbox only needs M7→M9 (not M4→M9) | Implement branching: if only 7e/tickbox changed → M7→M9; if 7a/7d changed → M4→M9 |

---

## Success criteria

- [ ] No modal on first load — all §7/§8 inputs pre-populated; pipeline runs on first load
- [ ] §7 boiler dropdown has 4 tiers; no free-form numeric remains
- [ ] §7 floor area, wall construction, "Adjusted heat loss rate" inputs/rows gone
- [ ] §7 orange cold-weather-elec callout gone
- [ ] §7 7e: `All electric` → dropdown locked + tickbox locked-ticked; `Some` + fraction ≥ 0.15 → tickbox default ticked; `None` → tickbox hidden
- [ ] §7 7h Building character row renders with `net_flow_label`; hyperlinks to §7 7d
- [ ] §7 row renames correct (Heat-loss model fit / Summer cooling potential / title-case values)
- [ ] §7 HTC grey value focuses `boiler-efficiency-dropdown` on click
- [ ] §8 dropdown only — no Path-A fields remain
- [ ] §8 pre-populated on first load with m5-v2 `tau_dropdown_default_bucket`; no modal
- [ ] §8 soft prompt shown when `thermal_mass_source == 'fallback'`
- [ ] §8 divergence note shown (not overriding) when user bucket diverges from data-derived
- [ ] §7 + §8 Recalculate at card bottom; status line above; nothing below Recalculate
- [ ] §8 setpoint + occupancy rows absent

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
