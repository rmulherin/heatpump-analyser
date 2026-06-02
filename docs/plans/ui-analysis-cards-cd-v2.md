# ui-analysis-cards-cd-v2 — ANALYSIS Cards C/D (Typical Day) + INV-20 Local Labels

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the second pair of the ANALYSIS section: Card C (typical-day energy + price
chart) and Card D (corresponding temperature traces) plus the INV-20 UTC→local-time
label fix for day-view charts.

Design doc: `ui-overhaul-analysis.md` §§5–6. Required read: `ui-overhaul-conventions-v2.md`.

**Companion plan:** `ui-analysis-cards-ab-v2` must be implemented first (it adds the ANALYSIS section container and the "A typical day" sub-heading element).

**Cards C/D cover:**
- Same representative day for both charts (13d: non-holiday winter weekday with heating > 0;
  local-date grouping — INV-20).
- Card C: dual-axis (energy areas Y2 + price lines Y1); gas + Smart HP series; 13g
  daily-cost line with consumption-weighted effective rate.
- Card D: three temperature traces (current/boiler, Smart HP, outdoor) for the same day.
- INV-20: `getIndicesForDay`, `generateLocalHhLabels`, `selectDefaultDay` all use
  local-clock time (Europe/London); 6-hourly x-axis labels; DST-day handling.

**Implementation prerequisite:** `ui-analysis-cards-ab-v2` + m7a + m7b (for both RC
traces and Smart HP consumption).

---

## Research findings

**Existing day-view charts:** `setupDayViewCharts()` in `app.js` sets up two Chart.js
charts. `renderDayViewDay(date)` renders them for a chosen date. These functions use
UTC-based date grouping and UTC labels — INV-20 changes them to local-clock.

**Existing date picker:** there is a date picker control and a `selectDefaultDay` function.
`selectDefaultDay` currently picks the 60th-percentile winter day (or similar) but uses
UTC grouping.

**INV-20 scope:** isolated to chart display code — no model changes. Three functions
require local-time updates. The existing HH-label array is UTC-based; in BST (April–Oct)
it is off by one hour.

**13g effective rate:** for a time-varying-price day, the consumption-weighted effective
rate = `Σ(kWh[i] × rate[i]) / Σ(kWh[i])`. This gives `use × rate = cost` exactly. £ at
2 dp (G2 exception for small daily values).

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | "A typical day" sub-heading; Card C + Card D containers |
| MODIFY | `app.js` | INV-20 local-label functions; Card C/D chart logic; 13g cost line; `selectDefaultDay` fix |
| MODIFY | `css/style.css` | "A typical day" sub-heading style; Card C/D card pair layout |

---

## Implementation steps

### Step 1 — "A typical day" sub-heading + Card C/D containers in `index.html`

In the ANALYSIS section (added by `ui-analysis-cards-ab-v2`), after the A/B pair:
```html
<h3 class="analysis-subheading analysis-subheading--day">A typical day</h3>
<div class="card-pair">
  <div id="card-c" class="analysis-card analysis-card--c">
    <h4 class="card-title">Typical day: Boiler vs HP heating pattern</h4>
    <canvas id="chart-typical-day-energy"></canvas>
    <p id="daily-cost-line" class="daily-cost-line"></p>
  </div>
  <div id="card-d" class="analysis-card analysis-card--d">
    <h4 class="card-title">Corresponding temperature modelling</h4>
    <canvas id="chart-typical-day-temp"></canvas>
  </div>
</div>
```

### Step 2 — INV-20: `getIndicesForDay(date, timestamps)` → local date

Existing `getIndicesForDay` filters by UTC date (`timestamp.slice(0, 10)`). Update to
group by **local date**:

```js
function getIndicesForDay(localDate, timestamps) {
  // localDate = 'YYYY-MM-DD' in Europe/London
  return timestamps
    .map((ts, i) => ({ i, localDate: toLocalDateStr(ts) }))
    .filter(e => e.localDate === localDate)
    .map(e => e.i);
}

function toLocalDateStr(isoTs) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(isoTs)).split('/').reverse().join('-');
}
```

### Step 3 — INV-20: `generateLocalHhLabels(indices, timestamps)` → local clock

Replace `generateHhLabels` with:
```js
function generateLocalHhLabels(indices, timestamps) {
  return indices.map(i => {
    const h = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(timestamps[i]));
    return h;  // e.g. "02:30"
  });
}
```

**Reduced-density (6-hourly) x-axis labels:** Chart.js `ticks.maxTicksLimit` or
`tick.autoSkip` configuration; show every 12th label (48 HHs ÷ 12 = 4 per day:
`00:00 · 06:00 · 12:00 · 18:00`). The final `00:00` of the next day can be shown as a
fifth label if Chart.js includes it naturally; suppress otherwise.

### Step 4 — INV-20: `selectDefaultDay(heating, timestamps, external)` → local date

Update `selectDefaultDay` to:
1. Group HH indices by **local date** (using `toLocalDateStr`).
2. Filter to non-holiday winter weekdays with `Σ heating_kwh > 0` for the day.
3. Holiday detection: exclude 25-Dec (and any other UK bank holidays in the data window).
4. "Winter": local month 10–3 (Oct–Mar).
5. Pick the median day by total heating_kwh (or the first qualifying day if few options).

### Step 5 — Card C: dual-axis Chart.js chart

Update `setupDayViewCharts` (or create `renderCardC(dayIndices, m7, rateMetadata)`) to
produce a `bar/line` mixed Chart:

```js
datasets: [
  // Y2 (right) — energy areas (bar chart)
  { type: 'bar', label: 'Current gas use',         data: gas_kwh_day,  yAxisID: 'y2', backgroundColor: '#26588D44' },
  { type: 'bar', label: 'Smart HP electricity use', data: hp_elec_day, yAxisID: 'y2', backgroundColor: '#3B828444' },
  // Y1 (left) — price lines (line chart, dashed)
  { type: 'line', label: 'Gas price',         data: gas_rate_day,  yAxisID: 'y1', borderColor: '#26588D', borderDash: [4,4] },
  { type: 'line', label: 'Electricity price', data: elec_rate_day, yAxisID: 'y1', borderColor: '#3B8284', borderDash: [4,4] },
],
scales: {
  y1: { position: 'left',  title: { text: 'Price (p/kWh)' } },
  y2: { position: 'right', title: { text: 'Energy use (kWh)' } },
},
```

`gas_kwh_day` = `m7.scenarios.current.components.gas_space_heat[dayIndices]`.
`hp_elec_day` = `m7.scenarios.smart_hp_hh.components.elec_space_heat[dayIndices]`.
When Smart HP unavailable: `hp_elec_day` all zero + note in 13g.

### Step 6 — 13g Daily cost line

Below Card C chart, populate `#daily-cost-line`:

```js
function buildDailyCostLine(dayIndices, m7, rateMetadata) {
  const gasKwh   = dayIndices.map(i => m7.scenarios.current.components.gas_space_heat[i] ?? 0);
  const gasRate  = dayIndices.map(i => rateMetadata.gas_rate_by_hh[i] ?? 0);
  const gasTotal = gasKwh.reduce((s, k, i) => s + k * gasRate[i], 0);
  const gasEff   = gasKwh.reduce((s, k) => s + k, 0) > 0
    ? gasTotal / gasKwh.reduce((s, k) => s + k, 0) : null;

  const hpElec   = dayIndices.map(i => m7.scenarios.smart_hp_hh?.components?.elec_space_heat[i] ?? 0);
  const elecRate = dayIndices.map(i => rateMetadata.elec_hh_rate_by_hh[i] ?? 0);
  const hpTotal  = hpElec.reduce((s, k, i) => s + k * elecRate[i], 0);
  const hpEff    = hpElec.reduce((s, k) => s + k, 0) > 0
    ? hpTotal  / hpElec.reduce((s, k)  => s + k, 0) : null;

  const gasStr  = gasEff != null
    ? `Current gas use (${gasKwh.reduce((s,k)=>s+k,0).toFixed(2)} kWh) × ${gasEff.toFixed(1)}p/kWh = £${(gasTotal/100).toFixed(2)}`
    : '—';
  const hpStr   = hpEff  != null
    ? `Smart HP electricity (${hpElec.reduce((s,k)=>s+k,0).toFixed(2)} kWh) × ${hpEff.toFixed(1)}p/kWh = £${(hpTotal/100).toFixed(2)}`
    : 'unavailable';

  return `${gasStr} · ${hpStr}`;
}
```

£ at 2 dp per G2 exception (small daily values).

### Step 7 — Card D: temperature traces

`renderCardD(dayIndices, m7, external)`:

Three line datasets:
```js
datasets: [
  { label: 'Current (boiler)',   data: m7.scenarios.current.indoor_temp_c.slice by dayIndices,    borderColor: '#26588D' },
  { label: 'Smart HP',           data: m7.scenarios.smart_hp_hh?.indoor_temp_c by dayIndices,     borderColor: '#3B8284' },
  { label: 'Outdoor temperature',data: external[dayIndices].map(e => e.temp_c),                  borderColor: '#aaa', borderDash: [4,4] },
],
```

Smart HP trace null → dataset hidden/absent (not drawn).
Current trace shows the corrected ~18–22°C RC trace (Step 2b from m7a); not the ~14–15°C v1 trace.

### Step 8 — Shared day selection and chart update

On first render and when the date picker changes, call:
1. `localDay = selectDefaultDay(...)` (or the picker value).
2. `dayIndices = getIndicesForDay(localDay, timestamps)`.
3. `labels = generateLocalHhLabels(dayIndices, timestamps)`.
4. Update Card C chart + 13g cost line.
5. Update Card D chart.

Hyperlink in Card C: HP dispatch overlay links to `#cop-sliders` (§15).

### Step 9 — DST-day handling

`selectDefaultDay` (Step 4) already skips 46-HH and 50-HH days by checking
`dayIndices.length === 48`. When the selected day is 46 or 50 HH (DST), the chart
renders but x-axis label count adjusts to the actual HH count. The 6-hourly density
(`maxTicksLimit`) remains; Chart.js handles non-48 arrays gracefully.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `Intl.DateTimeFormat` called 17,520+ times for local-date grouping | Cache a Map of `timestamp → localDate` built once; reuse across both Card B (cards-ab plan) and cards-cd |
| Smart HP trace null (no thermal mass) | Step 7: null-check before dataset creation; dataset omitted from chart |
| 13g effective rate = 0 / div-by-zero when kWh is 0 | `> 0` guard before division; show `—` when gas or HP kWh = 0 |
| Existing `setupDayViewCharts` and `renderDayViewDay` may conflict with new card IDs | Read existing function references before overwriting; rename the Canvas IDs in HTML if they clash |

---

## Success criteria

- [ ] Default day is a non-holiday winter weekday (not 25-Dec); heating > 0; local-date grouping
- [ ] Card C: dual-axis chart; gas areas + Smart HP areas + rate lines; correct legend
- [ ] 13g: `use × rate = cost` holds exactly; £ at 2 dp; "unavailable" when Smart HP null
- [ ] Card D: current (~18–22°C), Smart HP, outdoor traces for the same day
- [ ] INV-20: day-view labels in UK local time (not UTC during BST); 6-hourly density
- [ ] DST day: 46/50 HH day renders without crash; labels still local-clock
- [ ] Card C HP dispatch hyperlinks to §15 COP sliders
- [ ] Changing §14 rates updates 13g daily-cost line; Cards A/B unchanged

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
