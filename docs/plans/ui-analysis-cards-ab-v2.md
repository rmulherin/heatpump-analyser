# ui-analysis-cards-ab-v2 — ANALYSIS Card A (Your Home) · Card B (Your Comfort)

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the first pair of the new visible ANALYSIS section: Card A (thematic
archetype match) and Card B (cold/hot exposure from the corrected RC trace). The section
sits between YOUR HOME and COST BREAKDOWN — it is visible (not behind the methodology
toggle).

Design doc: `ui-overhaul-analysis.md` §§3–4. Required read: `ui-overhaul-conventions-v2.md`.

**Card A — Your home (thematic category match):**
- Four-category banded classification on insulation rating + absolute energy use
  (NOT a weighted distance metric; NOT occupancy).
- Icon per category (`{Big,Average,Modern,Small}_house.svg` — same as demo assets in
  `data/demos/`).
- Adaptive paragraph (A2): shared-considerations framing ("homes like yours…"); no
  house-type assertion; no demo dwelling bio; bold tokens from the user's analysis.

**Card B — Your comfort:**
- Cold + hot exposure hours from full-year `current.indoor_temp_c` (m7-v2 Step 2b).
- WHO/NHS/PHE thresholds; B3 interpretation sentence; B4 source footnote.
- No-block first-load (renders on default setpoint; soft framing when cold-start).

**Implementation prerequisite:** m7a + m7b implemented (for `current.indoor_temp_c`
and m4/m5 outputs for Card A ratings).

---

## Research findings

**Card A:** The four categories map to m4-v2 insulation rating (Good/Average/Poor/Very poor)
+ a coarse absolute-heat-demand band (m4-v2 HTC × design-temp delta, or annual gas heating
kWh). No occupancy input. The `insulation_rating` field from m4-v2 drives the primary
classification; absolute demand (total annual gas heating kWh from m3-v2) refines it for
the Low-energy-use (A) case. Thresholds are implementation-defined and coarse — e.g. "low
demand" < 5,000 kWh/yr heating gas; "high HTC" = Poor/Very poor rating. Final thresholds
are a build decision to be noted as a deviation if they change.

**House SVGs:** already in `data/demos/` after `ui-input-demos-and-template-v2`. Card A
reads from the same files — `data/demos/modern-out-for-work.svg` etc. (already committed).

**Card B cold/hot computation:** iterate over `current.indoor_temp_c` (17,520 entries).
Cold: coldest overnight = minimum over 23:00–07:00 local-time HHs; hours below 18°C in
waking window 07:00–23:00 local; hours below 16°C any time; hours below 12°C any time
(show only if >0). Hot: warmest at any time; hours above 25°C; above 28°C; above 30°C
(show only if >0). Local time = UTC + DST offset per `Intl.DateTimeFormat('Europe/London')`.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | New ANALYSIS section container; Card A + Card B DOM structure |
| MODIFY | `app.js` | Card A thematic match logic + A2 prose; Card B threshold computation + display |
| MODIFY | `css/style.css` | Two-column A/B layout; cold/hot column styling; category icon |

---

## Implementation steps

### Step 1 — ANALYSIS section skeleton in `index.html`

Between the YOUR HOME section and COST BREAKDOWN, add:
```html
<section id="analysis-section" class="section-analysis hidden">
  <h2 class="section-title">Analysis</h2>
  <div class="card-pair">
    <div id="card-a" class="analysis-card analysis-card--a"></div>
    <div id="card-b" class="analysis-card analysis-card--b"></div>
  </div>
</section>
```
Reveal on first result render (remove `hidden`). Cards C/D (typical day) added by the
companion plan `ui-analysis-cards-cd-v2`.

### Step 2 — `classifyHomeCategory(m4Result, m3Result)` in `app.js`

Returns one of `'C' | 'A' | 'B' | 'D'`:

```js
function classifyHomeCategory(m4, m3) {
  const rating   = m4.insulation_rating;    // 'excellent'|'good'|'average'|'poor'|'very_poor'
  const gasHeat  = m3.annual_gas_heating_kwh ?? 0;   // annual kWh

  // Priority order: C → A → B → D
  if (rating === 'poor' || rating === 'very_poor') return 'C';          // Hard to heat
  if (gasHeat < 5000 && (rating === 'good' || rating === 'excellent'))  return 'A';  // Low energy use
  if (rating === 'good' || rating === 'excellent')                       return 'B';  // Well insulated
  return 'D';                                                            // Average
}
```

> Thresholds are coarse/banded and implementation-defined. Note in deviations if adjusted.

### Step 3 — Card A DOM render

```js
const CATEGORY_CONFIG = {
  C: { label: '(C) Hard to heat',    svg: 'big-old-draughty.svg',      consideration: 'tough HP case — improving the fabric first is often worth weighing' },
  A: { label: '(A) Low energy use',  svg: 'small-and-efficient.svg',   consideration: 'HP runs well, but the absolute £ saving is small against install cost' },
  B: { label: '(B) Well insulated',  svg: 'modern-out-for-work.svg',   consideration: 'strong HP candidate — efficient on Half-Hourly tariff' },
  D: { label: '(D) Average',         svg: 'average-in-all-day.svg',    consideration: 'middle case — results depend heavily on tariff' },
};

function renderCardA(category, m4, m5) {
  const cfg = CATEGORY_CONFIG[category];
  const htc  = m4.htc_w_per_k?.toFixed(0) ?? '—';
  const tmKj = m5.thermal_mass_kj_per_k?.toLocaleString('en-GB') ?? '—';
  const insRating = formatInsulationRating(m4.insulation_rating);
  const tmRating  = formatThermalMassRating(m5.thermal_mass_rating);
  const buildChar = m4.net_flow_label ?? 'Typical';

  const prose = buildCardAProse(category, htc, insRating, tmRating, buildChar);

  document.getElementById('card-a').innerHTML = `
    <img src="data/demos/${cfg.svg}" alt="${cfg.label} illustration" class="card-a__icon">
    <h3 class="card-a__category">${cfg.label}</h3>
    <p class="card-a__prose">${prose}</p>
  `;
}
```

### Step 4 — `buildCardAProse(category, htc, insRating, tmRating, buildChar)` in `app.js`

Returns 3–4 sentences with `<strong>` tokens. Uses shared-considerations framing:
*"Homes like yours — [trait] — face [consideration]."* No house type, no occupancy.

Example for B:
> *"Your home is **well insulated** (HTC **204 W/K**, **high thermal mass**) — so, like
> other well-insulated homes, it's a **strong candidate** for a heat pump running
> efficiently on a Half-Hourly tariff. Building character: <strong>Typical</strong>."*

Token map: `{htc, insRating, tmRating, buildChar}` → bold in the string.
Four distinct template strings (one per category); selected by `category` argument.

### Step 5 — Card B cold/hot computation

`computeComfortMetrics(indoor_temp_c, externalData)`:

```js
// Convert UTC index → local hour using Intl
function utcIndexToLocalHour(i) {
  const ms = Date.parse(/* start of series */ '2024-01-01T00:00:00Z') + i * 30 * 60 * 1000;
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(new Date(ms));
  return parseInt(d, 10);
}

// Cold metrics
let coldest_overnight = Infinity;
let hours_below_18_waking = 0;
let hours_below_16 = 0;
let hours_below_12 = 0;

// Hot metrics
let warmest = -Infinity;
let hours_above_25 = 0;
let hours_above_28 = 0;
let hours_above_30 = 0;

for (let i = 0; i < indoor_temp_c.length; i++) {
  const t = indoor_temp_c[i];
  if (t == null) continue;
  const h = utcIndexToLocalHour(i);
  const overnight = (h >= 23 || h < 7);
  const waking    = (h >= 7 && h < 23);

  if (overnight && t < coldest_overnight) coldest_overnight = t;
  if (waking    && t < 18) hours_below_18_waking += 0.5;
  if (t < 16) hours_below_16 += 0.5;
  if (t < 12) hours_below_12 += 0.5;

  if (t > warmest) warmest = t;
  if (t > 25) hours_above_25 += 0.5;
  if (t > 28) hours_above_28 += 0.5;
  if (t > 30) hours_above_30 += 0.5;
}
return { coldest_overnight, hours_below_18_waking, hours_below_16, hours_below_12,
         warmest, hours_above_25, hours_above_28, hours_above_30 };
```

> **UTC index anchor:** the start-of-series UTC timestamp is available from `external[0].timestamp`.
> Do not hardcode a date — derive from the data.

### Step 6 — Card B DOM render

```js
function renderCardB(metrics, setpoint, isDefaultSetpoint) {
  const el = document.getElementById('card-b');

  const coldTier = metrics.hours_below_16 === 0 ? 'warm'
                 : metrics.hours_below_16 < 50    ? 'mild_cold' : 'cold';
  const hotTier  = metrics.hours_above_28 === 0   ? 'none'
                 : metrics.hours_above_25 < 100    ? 'mild_hot'  : 'hot';

  const interpretation = COMFORT_INTERPRETATIONS[`${coldTier}_${hotTier}`]
    ?? 'Temperature data computed; review the columns below.';

  el.innerHTML = `
    ${isDefaultSetpoint ? '<p class="soft-note">Based on a default winter setpoint of 20 °C — refine via the Heat loss card to personalise.</p>' : ''}
    <p class="comfort-interpretation">${interpretation}</p>
    <div class="comfort-columns">
      <div class="comfort-cold">
        <h4>❄ Cold exposure</h4>
        <p>Coldest overnight: <strong>${metrics.coldest_overnight.toFixed(1)}°C</strong></p>
        <p>Hours below 18°C (waking): ${metrics.hours_below_18_waking.toFixed(0)} h</p>
        <p>Hours below 16°C: ${metrics.hours_below_16.toFixed(0)} h</p>
        ${metrics.hours_below_12 > 0 ? `<p>Hours below 12°C: <strong>${metrics.hours_below_12.toFixed(0)} h</strong></p>` : ''}
      </div>
      <div class="comfort-hot">
        <h4>☀ Summer heat</h4>
        <p>Warmest: <strong>${metrics.warmest.toFixed(1)}°C</strong></p>
        <p>Hours above 25°C: ${metrics.hours_above_25.toFixed(0)} h</p>
        <p>Hours above 28°C: ${metrics.hours_above_28.toFixed(0)} h</p>
        ${metrics.hours_above_30 > 0 ? `<p>Hours above 30°C: <strong>${metrics.hours_above_30.toFixed(0)} h</strong></p>` : ''}
      </div>
    </div>
    <p class="card-b-footer" id="card-b-footer">
      Thresholds: WHO 2018 · NHS/PHE Cold Weather Plan · NICE NG6 · UKHSA heat-health alerts.
    </p>
  `;
  // Hyperlink cold/hot values to §7 7d
  el.querySelectorAll('strong').forEach(el =>
    el.innerHTML = `<a href="#winter-setpoint-input" class="hyperlink-adjust">${el.textContent}</a>`
  );
}
```

`isDefaultSetpoint` = `thermalChar.setpoint_c == null` (cold-start 20°C fallback).
`COMFORT_INTERPRETATIONS` is a small lookup: keys like `warm_none`, `mild_cold_mild_hot`, etc.

### Step 7 — Null guard (no indoor_temp_c)

If `current.indoor_temp_c` is all-null (HTC or thermal mass null), render Card B with:
*"Temperature model unavailable — your home's thermal characteristics couldn't be estimated
from your data."* Card A still renders (doesn't need the trace).

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| UTC index → local hour is called 17,520× times — may be slow | Cache `Intl.DateTimeFormat`; or pre-compute offsets for each day using the BST boundary; or use a lightweight offset lookup |
| Annual gas heating kWh for Card A classification: may not be directly available | Derive as `Σ current.components.gas_space_heat × 2` (HH to annual) or from m3 output field if exposed |
| Cold-start "default setpoint" detection is brittle | Use `thermalChar.setpoint_source === 'fallback'` if m5-v2 exposes it; else `setpoint_c == null` guard |

---

## Success criteria

- [ ] Card A classifies Rhiannon (HTC 204, good insulation, non-trivial demand) as (B) Well insulated
- [ ] Card A icon matches category; A2 prose uses shared-considerations framing; no demo bio shown
- [ ] Card A building character reads "Typical" (m4-v2 net_flow_label)
- [ ] Card B renders on first load (no-block); soft framing when cold-start 20°C
- [ ] Coldest overnight and waking-hours-below-18 compute from local time (not UTC)
- [ ] Conditional rows (>30°C, <12°C) omitted when not exceeded
- [ ] B3 correct interpretation sentence for {cold, hot} tier combination
- [ ] B4 source footnote present
- [ ] Cold/hot values hyperlink to §7 7d (winter setpoint)
- [ ] When thermal_mass/HTC null: Card B shows "unavailable"; Card A still renders

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
