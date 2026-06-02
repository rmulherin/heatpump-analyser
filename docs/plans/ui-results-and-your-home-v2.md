# ui-results-and-your-home-v2 — §3 Verdict · §4 What Drove · §5 Your Data · §6 Energy Use

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Combined plan covering the RESULTS section (§3 Verdict + §4 What Drove This Answer)
and the YOUR HOME section (§5 Your Data + §6 How You Use Energy).

Combined per v2-build-brief §7: §5/§6 Your Home is a "small" plan (8 tests, surface
fixes only) with no shared rendering logic that would be harmed by combining; both
sections read from the same upstream model outputs.

Design docs: `ui-overhaul-results.md` + `ui-overhaul-your-home.md`. Required reads:
`ui-overhaul-conventions-v2.md`.

**§3 Verdict (new/changed):**
- Five-bar stacked chart (m8-v2 annual costs; heating segment coloured per G1).
- Adaptive prose (3f): layered-saving framing; tariff component + HP component + combined.
- §3.5 "Worth checking" warnings block (hyperlinked to adjustment surfaces).
- G1 scenario names everywhere; INV-16(D) conditional naming removed.
- `Verdict` title (3e); methodology footer (3g) with N days + ±15–20%.

**§4 What Drove (new/changed):**
- Heat-loss block (4a): three columns (Insulation / Thermal mass / Indoor Temperature).
- Electricity-price block (4b): weighted HH rates (not a single year-mean).
- HP/Install/Payback block (4c): HP size + net cost + payback (now unblocked).
- Mean COP (4d): hyperlinks to §15.

**§5 Your Data (surface fixes):**
- Tariff label G3 (SVT not svt); total electricity row (5e); gas-units toggle + Recalculate
  (5c); data-quality flags as badges (5d); region name G4.
- Dual-handed self-exit callout visible here (§3.2 of your-home doc).

**§6 How You Use Energy (no structural change):** classification shown informationally;
no Recalculate.

**Implementation prerequisite:** m7a-v2 (for `current.indoor_temp_c`), m8-v2 (for costs),
m9-v2 (for payback/savings). Prior to full model implementation, can be developed
against stub outputs.

---

## Research findings

**Existing verdict display:** `app.js` has `buildAndDisplayVerdict()` which renders the
v1 verdict card. The five-bar chart is currently a Chart.js bar chart rendered by
`setupVerdictChart()` or similar. The v2 changes require: five scenarios instead of four;
stacked chart (heating + non-heating segments); axis at £0.

**Existing drove card:** `populateDroveTile()` in `app.js`. Update to three-block
structure (heat-loss / electricity-price / HP-install-payback) per §4 spec.

**Adaptive copy (3f/11b):** shared selection logic between §3 and §11b — implement as
a single `buildAdaptiveCopy(m8, m9)` function called from both renderers.

**G1 colour map:** navy `#26588D` (Current bars), coral `#FD7A7F` (Std HP bars),
teal `#3B8284` (Smart HP). Grey for non-heating segment.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | §3/§4 card structure; §5 badge markup; §3.5 warnings block; `Verdict` title |
| MODIFY | `app.js` | Verdict chart, adaptive prose, drove tile, §5 surface fixes, G3/G4/G5 compliance |
| MODIFY | `css/style.css` | Stacked bar chart, three-block drove layout, badges, warnings block |

---

## Implementation steps

### Step 1 — Five-bar stacked Chart.js configuration (§3 3d)

Update `setupVerdictChart()` in `app.js` to produce a stacked bar chart:

```js
type: 'bar',
data: {
  labels: ['Current — flat rate', 'Std. HP — flat rate', 'Current — HH rate',
           'Std. HP — HH rate', 'Smart HP — HH rate'],
  datasets: [
    {
      label: 'Heating',
      data: [heat costs per scenario from m8-v2],
      backgroundColor: ['#26588D','#FD7A7F','#26588D','#FD7A7F','#3B8284'],
    },
    {
      label: 'Non-heating',
      data: [non-heating + fixed costs per scenario],
      backgroundColor: ['#b0b0b0','#b0b0b0','#b0b0b0','#b0b0b0','#b0b0b0'],
    },
  ],
},
options: { scales: { y: { stacked: true, min: 0, title: { text: 'Annual energy bill (£/yr)' } }, x: { stacked: true } } },
```

Heating segment = `gas_heat + elec_heat` (from m8-v2 `components`). Non-heating =
`gas_nonheat + gas_fixed + elec_nonheat + elec_fixed`. Smart HP bar: if `smart_hp_hh`
null, render a greyed-out "Data unavailable" bar.

### Step 2 — Adaptive prose (3f) shared function

New function `buildAdaptiveCopy(m8Scenarios, m9Result)` (used by §3 and §11b):

Selection logic per conventions adaptive-copy rule:
1. If `tariff_saving > 50` → lead with tariff component.
2. If `hp_heating_component > 0` → add HP saving.
3. If `std_hp_flat` dearer than `current_flat` → add HP-on-flat warning.
4. If `smart_shift > 50` → add smart-vs-standard.
5. Static fallback.

Returns a 2–4 sentence string with bold tokens (`<strong>£NNN/yr</strong>`).

### Step 3 — §3.5 "Worth checking" warnings block

After the 3f prose, add a `<div id="verdict-warnings" class="verdict-warnings">` that is
populated if any of the three triggers fire:
- Gas-unit sanity fail: read from ingestion result.
- Electric-heating fraction 5–15%: render "Do you use any electric heating?" with link to `#electric-heating-input`.
- Electric-heating fraction ≥15%: render "You appear to have substantial electric heating…" with same link.
- Inferred setpoint <17 or >24 (still default): render with links to `#boiler-efficiency-dropdown` + `#thermal-mass-dropdown` (then `#winter-setpoint-input`).

If no triggers → `verdict-warnings` hidden.

### Step 4 — Add `Verdict` title (3e) and methodology footer (3g)

In `index.html`, add `<h2 class="card-title">Verdict</h2>` above the verdict card.
After the 3f prose, add:
```html
<p class="methodology-footer" id="verdict-footer"></p>
```
Populated in `app.js`: *"Analysis based on N days of smart meter data; accuracy
typically ±15–20%."* N from `rateMetadata.data_period_days`.

### Step 5 — §4 Three-block drove tile (4a/4b/4c)

Refactor `populateDroveTile()` into three block sections:

**4a Heat-loss block (three columns):**
```
Insulation    / Good    / 204 W/K       → links to §7 7a
Thermal mass  / High    / 29,396 kJ/K   → links to §8 8b
Indoor temp   / Comfortable / 20°C [edit] → links to §7 7d
```
Rating labels from m4-v2 insulation rating + m5-v2 thermal-mass rating. Indoor temp
from `thermalCharacter.setpoint_c`; WHO band lookup (Cold <16 / Cool 16–18 /
Comfortable 18–21 / Warm >21).

**4b Electricity-price block (list):**
- `Flat-rate assumption: X p/kWh (from Octopus / Ofgem cap / manual input)` — source text from rateMetadata.
- Three weighted HH rates: *electricity*, *Standard HP*, *Smart HP* — computed as
  `annual_cost_gbp elec_energy / elec_kwh_total` per scenario.

**4c HP/Install/Payback (three columns):**
```
HP Size    / Standard / 6 kW      → m6-v2 hp_capacity_kw (bracket label from §10f)
Install    / £5k      / £12.5k − £7.5k grant
Payback    / Long     / ~30 yr    → m9-v2 headline.payback_years
```
Payback band: Short <10 / Medium 10–25 / Long 25–40 / Beyond lifetime >40.

**4d Mean COP hyperlink:** `average COP X.XX` links to `#cop-sliders` (§15).

### Step 6 — Remove INV-16(D) per-fuel scenario labels

Search `app.js` for any conditional: `Current boiler` / `Current heater` / `Current
heating (boiler + electric)` / `Current electric heating`. Remove all of these; replace
with plain `Current — flat rate` / `Current — HH rate` (G1 verbatim). Verify no
remaining references in any function.

### Step 7 — §5 Your Data surface fixes (G3, G4, 5c, 5d, 5e)

**5a G3 tariff labels:** in `displayIngestionResult` or wherever tariff rows are rendered,
upper-case `svt` → `SVT`, `hh_rate` → `HH rate`.

**5e Total electricity row:** add a `<tr id="elec-total-row">` alongside the existing
gas-total row, populated with `total_electricity_kwh` from the ingestion result.

**5c Gas-units toggle + Recalculate:** add a row with:
```html
<label>Gas meter units <input type="checkbox" id="gas-m3-toggle"> Convert from m³</label>
<button id="btn-reconfirm-units">Recalculate</button>
```
Handler: flip the unit interpretation + rerun the pipeline from M1 onwards (not a full
re-fetch — reparse the stored raw data with the new unit flag).

**5d Data-quality flags:** replace any existing "Absences detected" sentence with a badge:
`<span class="badge badge-info">Absences detected: N days</span>`. Similarly for
estimated-prices. Both render adjacent to the relevant figure, not as a block.

**5d G4 region:** ensure the region row shows the name (London) not the GSP code (C).
Reuse `gspCodeToRegionName()` extracted in `ui-input-data-entry-v2` Step 5.

### Step 8 — Dual-handed self-exit callout (§3.2 your-home doc)

When `ingestionResult?.htc_low_plausibility_callout_passthrough === 'all_electric_dual_handed'`
(from m5-v2), show on the Your Data card:
> *"Your electricity consumption is unusually low for the building characteristics we've
> inferred. If you already have a heat pump installed, this tool isn't designed for you —
> it answers 'should I install a heat pump?', not 'how is my existing one performing?'.
> If instead you have exceptional passive gains, the numbers may still be useful."*

Render as a `<div class="callout callout-info">` visible on the Your Data card (not hidden
behind the methodology toggle).

### Step 9 — §6 Classification display (informational)

In the §6 How You Use Energy card, after the breakdown table, add an informational line:
*"Electric heating: [None / Some / All-electric household]"* — from
`m3Result.electric_heating_classification_effective`. No dropdown here (dropdown lives on §7).

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Smart HP bar null (no thermal mass) | Step 1: explicit null guard → grey "Data unavailable" bar |
| Adaptive copy selection logic diverges between §3 and §11b | Implement as one shared function `buildAdaptiveCopy`; both renderers call it |
| INV-16(D) label removal may miss occurrences in display helpers | Grep for all three per-fuel label strings; fix every occurrence |
| m5-v2 `htc_low_plausibility_callout_passthrough` field absent until m5-v2 is implemented | Guard with optional chaining |

---

## Success criteria

- [ ] Five-bar stacked chart renders with G1 order, colours, and names; axis at £0
- [ ] Bar heights equal §11a Totals (same m8-v2 source)
- [ ] Tariff-switch visible: bar-3 non-heating segment shorter than bar-1
- [ ] Adaptive prose: names tariff saving + HP saving + combined; caveat present
- [ ] HP-on-flat dearer → prose warns + bar-2 ≥ bar-1 visually
- [ ] §3.5 warnings block: only triggered items show; none triggered → block omitted
- [ ] §4a Indoor temp shows WHO band + [edit] link to §7 7d
- [ ] §4b three weighted HH rates; no single year-mean; source parenthetical correct
- [ ] §4c payback shows ~30 yr "Long" (not ">40 yr") using m9-v2
- [ ] Mean COP hyperlinks to §15
- [ ] G1 names everywhere; no "Current boiler/heater" variants
- [ ] §5: G3 tariff labels; total-electricity row; gas-units toggle + Recalculate; badge flags; region name
- [ ] Dual-handed callout visible (not behind methodology toggle) when passthrough set

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
