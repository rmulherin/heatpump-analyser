# UI — Day-View Two-Tile Charts

**Date:** 2026-05-07
**Status:** ⚠ Approved with edits — 2026-05-07. Implementation may begin once `m7-scenario-consumption-revised` is implemented.

---

## Task description

Add a two-tile day-view chart section between `financial-card` and
`section-banner-what-if`. Left tile: dual-axis dispatch and price chart (area fills for
current gas and smart HP electricity, rate lines for gas and HH electricity). Right tile:
single-axis temperature chart (outdoor, current indoor estimated, smart HP indoor
estimated). A date picker defaults to the 60th-percentile winter day and lets the user
explore any day in their dataset. Section is revealed when M8 completes (same trigger as
the verdict card).

Design spec: `praxis-claude-hub/projects/tools/heatpump-analyser/design/ui-day-view-charts.md`
(committed b8371e7).

**Prerequisite:** `m7-scenario-consumption-revised` must be implemented before this plan.
That plan adds `scenarios.current.indoor_temp_c` (Step 5a) and moves rate computation to
D×W+P (Step 6), both required by this feature.

---

## Research findings

All rendering uses Chart.js 4.x already loaded via CDN — no new dependencies. All data is
in memory at the point of reveal (M8 completion). No external lookups required.

Existing code reviewed:
- `js/app.js` lines 2174–2222: verdict chart creation — confirms Chart.js 4 pattern,
  `maintainAspectRatio: false`, `getContext('2d')` usage.
- `js/scenario-consumption.js` lines 33–36, 273, 291: confirms `scenarios.current.gas_kwh`,
  `scenarios.smart_hp_hh.elec_kwh`, `scenarios.current.indoor_temp_c`,
  `scenarios.smart_hp_hh.indoor_temp_c` all exist on the result object (arrays indexed
  1:1 with `baseloadResult.heating`).
- `js/pricing-engine.js` lines 75–187: confirms `rateMetadata.gas_rate_by_hh` and
  `rateMetadata.elec_hh_rate_by_hh` (D×W+P) are returned by `prepareRates` and stored
  via `setRateMetadata`. These are the correct per-HH rate arrays for the left tile.
- `js/baseload.js` lines 648–660: confirms `baseloadResult.heating[i].timestamp` exists
  (ISO 8601, UTC) and `heating` is 1:1 with `consumption` — same indexing as `external`
  and rate arrays.
- `index.html` lines 401–413: day-view section goes between `financial-card` and
  `section-banner-what-if`.
- `css/styles.css` lines 519–532: `.section-tiles` already provides 2-col grid with
  mobile collapse — will be reused for the two chart tiles.

Key finding: `buildAndDisplayVerdict` is called each time `runFinancialAnalysis` completes
(including What If recalculations). The day-view chart section will be set up once on
first call, then left untouched on subsequent calls (data doesn't change between What If
recalculations — only financial parameters change, not scenarios or rates).

Assumption: Section heading text "A typical day" — not specified in design doc. Flagged
below in Risks.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | Add `#day-view-section` HTML between financial-card and section-banner-what-if |
| MODIFY | `css/styles.css` | Add day-view header, chart wrap, and chart-note styles |
| MODIFY | `js/app.js` | DOM refs, helper functions, chart factories, render logic, picker listener, reveal wiring |

---

## Implementation steps

### Step 1 — `index.html`: add day-view section

Between the closing `</section>` of `#financial-card` and the `<!-- Section 5: What If -->`
comment, insert:

```html
<!-- Day-view charts -->
<section id="day-view-section" class="hidden">
  <div class="day-view-header">
    <h2>A typical day</h2>
    <input type="date" id="day-picker">
  </div>
  <p id="day-view-no-data" class="status-msg info hidden">No heating data for this day.</p>
  <div class="section-tiles" id="day-view-tiles">
    <div class="card">
      <h3>When the heating ran</h3>
      <div class="day-view-chart-wrap">
        <canvas id="chart-dispatch"></canvas>
      </div>
      <p class="chart-note hidden" id="dispatch-note"></p>
    </div>
    <div class="card">
      <h3>Indoor temperature</h3>
      <div class="day-view-chart-wrap">
        <canvas id="chart-temp"></canvas>
      </div>
      <p class="chart-note" id="temp-caveat">Temperature traces are estimated from your
        building's thermal model. Accuracy improves with
        <a href="#methodology-disclosure">manual thermal data</a>.</p>
      <p class="chart-note hidden" id="temp-note"></p>
    </div>
  </div>
</section>
```

Notes:
- `#day-view-section` uses `hidden` class (not `hidden` attribute) to match the project
  pattern — revealed via `classList.remove('hidden')` from app.js.
- `#day-view-tiles` reuses `.section-tiles` for the existing 2-col grid + mobile collapse.
- `#dispatch-note` is hidden by default; shown when smart HP data is absent from left tile.
- `#temp-caveat` is always visible; `#temp-note` surfaces per-dataset availability messages.
- Link in `#temp-caveat` points to `#methodology-disclosure` (confirmed ID at
  `index.html:234`).

---

### Step 2 — `css/styles.css`: day-view styles

Append to the end of `css/styles.css` (before the final `/* end */` comment if one
exists, otherwise at EOF):

```css
/* ===== Day-view charts ===== */

.day-view-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.day-view-header h2 {
  margin: 0;
}

.day-view-chart-wrap {
  position: relative;
}

.day-view-chart-wrap canvas {
  height: 280px;
}

.chart-note {
  font-size: 0.8rem;
  color: #666;
  font-style: italic;
  margin-top: 0.5rem;
}

@media (max-width: 768px) {
  .day-view-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .day-view-header input[type="date"] {
    width: 100%;
  }
}
```

Note: `position: relative` on `.day-view-chart-wrap` and `height: 280px` on `canvas`
together with Chart.js `maintainAspectRatio: false` give a fixed-height responsive chart
(standard Chart.js pattern used by the verdict chart).

---

### Step 3 — `js/app.js`: DOM refs and module-level chart variables

Add near the existing DOM ref block (around line 226, with `verdictCard` and other
section refs):

```js
// Day-view chart section
const dayViewSection   = document.getElementById('day-view-section');
const dayPicker        = document.getElementById('day-picker');
const dayViewNoData    = document.getElementById('day-view-no-data');
const dayViewTiles     = document.getElementById('day-view-tiles');
const dispatchNote     = document.getElementById('dispatch-note');
const tempCaveat       = document.getElementById('temp-caveat');
const tempNote         = document.getElementById('temp-note');
const chartDispatchCanvas = document.getElementById('chart-dispatch');
const chartTempCanvas     = document.getElementById('chart-temp');
```

Add module-level chart variables immediately after (or near existing `let verdictChart`
if one exists):

```js
let chartDispatch = null;
let chartTemp     = null;
```

---

### Step 4 — `js/app.js`: `selectDefaultDay(heating)` helper

Add in the day-view section of app.js (new labelled section `// ===== Day-view charts =====`):

```js
function selectDefaultDay(heating) {
  const byDay = {};
  for (const h of heating) {
    const d = h.timestamp.slice(0, 10);
    if (byDay[d] === undefined) byDay[d] = 0;
    if (h.heating_kwh != null) byDay[d] += h.heating_kwh;
  }
  const winterDays = Object.entries(byDay)
    .map(([date, total]) => ({ date, total }))
    .filter(({ date, total }) => {
      const month = parseInt(date.slice(5, 7), 10);
      return (month >= 10 || month <= 3) && total > 0;
    })
    .sort((a, b) => a.total - b.total);
  const idx = Math.floor(winterDays.length * 0.6);
  return winterDays[idx]?.date ?? heating[0].timestamp.slice(0, 10);
}
```

Implements the 60th-percentile winter day selection from the design spec verbatim, using
`Object.entries` instead of `groupBy` (no such built-in — confirmed from existing codebase
patterns).

---

### Step 5 — `js/app.js`: `getIndicesForDay(heating, dateStr)` helper

```js
function getIndicesForDay(heating, dateStr) {
  const indices = [];
  for (let i = 0; i < heating.length; i++) {
    if (heating[i].timestamp.slice(0, 10) === dateStr) indices.push(i);
  }
  return indices;
}
```

Returns array of global slot indices for the selected date. Used to slice all arrays
(scenarios, external, rate metadata) to the 48 HH entries for that day.

---

### Step 6 — `js/app.js`: `generateHhLabels(n)` helper

```js
function generateHhLabels(n) {
  return Array.from({ length: n }, (_, i) => {
    const hh = String(Math.floor(i / 2)).padStart(2, '0');
    const mm = (i % 2) ? '30' : '00';
    return `${hh}:${mm}`;
  });
}
```

Generates `n` HH slot time labels starting from "00:00". `n` is normally 48 but may be
46 or 50 on DST transition days — handled gracefully (chart renders with available slots).

---

### Step 7 — `js/app.js`: `createDispatchChart(canvas)` factory

```js
function createDispatchChart(canvas) {
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Current (gas)',
          yAxisID: 'y-energy',
          data: [],
          borderColor: '#FD7A7F',
          backgroundColor: 'rgba(253, 122, 127, 0.25)',
          fill: 'origin',
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.2,
        },
        {
          label: 'Smart HP (electricity)',
          yAxisID: 'y-energy',
          data: [],
          borderColor: '#3B8284',
          backgroundColor: 'rgba(59, 130, 132, 0.25)',
          fill: 'origin',
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.2,
        },
        {
          label: 'Gas rate',
          yAxisID: 'y-price',
          data: [],
          borderColor: '#FD7A7F',
          backgroundColor: 'transparent',
          fill: false,
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: 'HH electricity rate',
          yAxisID: 'y-price',
          data: [],
          borderColor: '#3B8284',
          backgroundColor: 'transparent',
          fill: false,
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: {
          ticks: {
            callback: (val, i) => (i % 4 === 0 ? generateHhLabels(48)[i] ?? '' : ''),
            maxRotation: 0,
          },
        },
        'y-price': {
          type: 'linear',
          position: 'left',
          min: 0,
          title: { display: true, text: 'p / kWh' },
          grid: { display: true },
        },
        'y-energy': {
          type: 'linear',
          position: 'right',
          min: 0,
          title: { display: true, text: 'kWh' },
          grid: { display: false },
        },
      },
    },
  });
}
```

Notes:
- Datasets 0 and 1 (areas) are listed before datasets 2 and 3 (lines) — Chart.js draws
  in array order, so areas render behind lines.
- `fill: 'origin'` fills down to y=0.
- x-axis tick callback: `i % 4 === 0` shows a label every 4 slots (every 2 hours).
  The callback receives the tick index; labels come from `generateHhLabels(48)`. For
  DST days with 46 or 50 slots the tick is still correct relative to index.
- `tooltip: { mode: 'index', intersect: false }` shows all four values at once on hover.

---

### Step 8 — `js/app.js`: `createTempChart(canvas)` factory

```js
function createTempChart(canvas) {
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Outdoor',
          data: [],
          borderColor: '#94A3B8',
          backgroundColor: 'transparent',
          fill: false,
          borderWidth: 1.5,
          borderDash: [6, 3],
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: 'Current (estimated)',
          data: [],
          borderColor: '#FD7A7F',
          backgroundColor: 'transparent',
          fill: false,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: 'Smart HP (estimated)',
          data: [],
          borderColor: '#3B8284',
          backgroundColor: 'transparent',
          fill: false,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: {
          ticks: {
            callback: (val, i) => (i % 4 === 0 ? generateHhLabels(48)[i] ?? '' : ''),
            maxRotation: 0,
          },
        },
        y: {
          title: { display: true, text: '°C' },
          afterDataLimits(scale) {
            scale.max += 2;
            scale.min -= 2;
          },
        },
      },
    },
  });
}
```

Notes:
- `afterDataLimits` hook adds 2°C padding above and below the data range (spec: "Auto range
  with 2°C padding above and below data min/max").
- Dataset visibility for indices 1 and 2 is set dynamically in `renderDayViewDay` via
  `chart.setDatasetVisibility(i, bool)`.
- `borderDash: [6, 3]` on the outdoor dataset matches the design spec.

---

### Step 9 — `js/app.js`: `renderDayViewDay(dateStr)` update function

```js
function renderDayViewDay(dateStr) {
  const heating   = getBaseloadResult().heating;
  const external  = getExternalResult().external;
  const scenarios = getScenarioConsumptionResult().scenarios;
  const valStatus = getScenarioConsumptionResult().validation_status;
  const rateMeta  = getRateMetadata();

  const indices = getIndicesForDay(heating, dateStr);

  // No-data condition: all heating_kwh null for this day
  const allNull = indices.length === 0
    || indices.every(i => heating[i].heating_kwh === null);

  dayViewNoData.classList.toggle('hidden', !allNull);
  dayViewTiles.classList.toggle('hidden', allNull);
  if (allNull) return;

  const labels      = generateHhLabels(indices.length);
  const currentGas  = indices.map(i => scenarios.current.gas_kwh[i] ?? null);
  const smartElec   = indices.map(i => scenarios.smart_hp_hh.elec_kwh[i] ?? null);
  const gasRate     = indices.map(i => rateMeta.gas_rate_by_hh[i] ?? null);
  const elecRate    = indices.map(i => rateMeta.elec_hh_rate_by_hh[i] ?? null);
  const outdoorTemp = indices.map(i => external[i]?.temp_c ?? null);
  const currentTemp = indices.map(i => scenarios.current.indoor_temp_c[i] ?? null);
  const smartTemp   = indices.map(i => scenarios.smart_hp_hh.indoor_temp_c[i] ?? null);

  // Update dispatch chart
  chartDispatch.data.labels           = labels;
  chartDispatch.data.datasets[0].data = currentGas;
  chartDispatch.data.datasets[1].data = smartElec;
  chartDispatch.data.datasets[2].data = gasRate;
  chartDispatch.data.datasets[3].data = elecRate;
  chartDispatch.update();

  // Dispatch note: shown when smart HP dispatch is unavailable (all elec_kwh null)
  const smartElecAvail = smartElec.some(v => v !== null);
  dispatchNote.textContent = smartElecAvail ? '' : 'Smart HP dispatch not available — thermal mass data required.';
  dispatchNote.classList.toggle('hidden', smartElecAvail);

  // Update temp chart
  chartTemp.data.labels           = labels;
  chartTemp.data.datasets[0].data = outdoorTemp;
  chartTemp.data.datasets[1].data = currentTemp;
  chartTemp.data.datasets[2].data = smartTemp;

  const currentTempAvail = currentTemp.some(v => v !== null);
  const smartTempAvail   = valStatus.smart === 'ok' || valStatus.smart === 'hp_undersized';

  chartTemp.setDatasetVisibility(1, currentTempAvail);
  chartTemp.setDatasetVisibility(2, smartTempAvail);
  chartTemp.update();

  // Notes on right tile
  const noteParts = [];
  if (!currentTempAvail) {
    noteParts.push('Building temperature model not available — enter thermal data manually.');
  }
  if (!smartTempAvail) {
    noteParts.push('Smart HP temperature not available — thermal mass data required.');
  }
  tempNote.textContent = noteParts.join(' ');
  tempNote.classList.toggle('hidden', noteParts.length === 0);
}
```

Notes:
- `dayViewTiles.classList.toggle('hidden', allNull)` hides both chart tiles (and their
  canvases) when no heating data exists for the day. The no-data message is shown instead.
- `?? null` throughout: ensures null is used rather than `undefined` for missing array
  entries; Chart.js treats null as a gap (no point drawn, area fill interrupted).
- `chartTemp.setDatasetVisibility(i, bool)` is the Chart.js 4 API for toggling a dataset
  including its legend entry.

---

### Step 10 — `js/app.js`: `setupDayViewCharts()` function

```js
function setupDayViewCharts() {
  const heating = getBaseloadResult()?.heating;
  if (!heating || !getScenarioConsumptionResult() || !getRateMetadata()) return;

  dayViewSection.classList.remove('hidden');

  // Set date picker bounds
  dayPicker.min = heating[0].timestamp.slice(0, 10);
  dayPicker.max = heating[heating.length - 1].timestamp.slice(0, 10);

  if (!chartDispatch || !chartTemp) {
    // First call: select default day and create chart instances
    dayPicker.value = selectDefaultDay(heating);
    chartDispatch = createDispatchChart(chartDispatchCanvas);
    chartTemp     = createTempChart(chartTempCanvas);
  }

  renderDayViewDay(dayPicker.value || heating[0].timestamp.slice(0, 10));
}
```

Notes:
- Guard against missing data (defensive: should always be set when called from
  `buildAndDisplayVerdict`, but belt-and-braces).
- Charts are created only once: if `chartDispatch` is already set (subsequent calls via
  What If recalculation), skip creation and just re-render. What If recalculations don't
  change scenario or rate data, so the chart data is unchanged — the render call is fast.
- Canvas refs `chartDispatchCanvas` and `chartTempCanvas` are declared as module-level
  consts in Step 3.

---

### Step 11 — `js/app.js`: date picker event listener

Add near other event listeners (e.g., after the `btnRecalcScenario` listener):

```js
dayPicker.addEventListener('change', () => {
  if (chartDispatch && chartTemp) {
    renderDayViewDay(dayPicker.value);
  }
});
```

Guard on `chartDispatch && chartTemp`: prevents error if picker fires before charts are
initialised (edge case — picker has no value and cannot fire before section is revealed,
but defensive).

---

### Step 12 — `js/app.js`: wire into `buildAndDisplayVerdict`

In `buildAndDisplayVerdict`, immediately after `verdictCard.classList.remove('hidden')`, add:

```js
  setupDayViewCharts();
```

No other changes to `buildAndDisplayVerdict` are needed. The day-view section reveal,
chart creation, and initial render are all handled inside `setupDayViewCharts`.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Section heading "A typical day" not specified in design doc | Flagged assumption. If Rhiannon wants different copy, change `<h2>` text in index.html. No logic depends on it. |
| `scenarios.current.indoor_temp_c` all null (pre-m7-revised or HTC missing) | Handled: `currentTempAvail = false` hides dataset 1 and shows note. No error. |
| `validation_status.smart` renamed from `'insufficient_data'` to `'no_htc'` / `'no_thermal_mass'` by m7-revised Step 1 | The render check uses explicit allowlist `['ok', 'hp_undersized']` — any other value (including new status names) correctly treats smart as unavailable. No change needed here. |
| DST transition days (46 or 50 HH slots) | `generateHhLabels(n)` uses actual slot count; tick callback uses `generateHhLabels(48)[i]` which returns `undefined` for i≥48 (guarded by `?? ''`). Acceptable per design doc: "may not align perfectly — acceptable." |
| `chartTemp.setDatasetVisibility` not in Chart.js 4 | Confirmed in Chart.js 4 docs and used elsewhere in Chart.js 4 projects. Alternative: `chart.data.datasets[i].hidden = bool` also works and is more portable. Use `.hidden` property as fallback if setDatasetVisibility unavailable. |
| `afterDataLimits` hook on single-trace day (only outdoor; both indoor null) | Hook fires on actual data present; min/max are computed from outdoor only. Padding of ±2°C still applied correctly. No error. |
| What If recalculations call `buildAndDisplayVerdict` repeatedly | `setupDayViewCharts` guards on `chartDispatch` existence and skips recreation. `renderDayViewDay` call is a no-op update with unchanged data. |
| `getIndicesForDay` with `indices.length === 0` (date outside data range) | `allNull` check covers `indices.length === 0`; tiles hidden, no-data message shown. Picker bounds prevent this in normal use. |

---

## Success criteria

- [ ] T1 (design doc). Left tile renders four datasets on a valid winter day: two area fills (coral current gas, teal smart HP electricity), two rate lines (coral gas rate, teal HH electricity rate). Both y-axes labelled (p/kWh left, kWh right).
- [ ] T2 (design doc). Area fill colour matches the series line colour — coral for gas, teal for smart HP.
- [ ] T3 (design doc). `picker.min` equals date of `heating[0].timestamp`; `picker.max` equals date of last entry. Dates outside range not selectable.
- [ ] T4 (design doc). Default day is in Oct–Mar with heating > 0. Not a summer day or zero-heating day.
- [ ] T5 (design doc). Changing picker → both charts update with data for new date. No page reload.
- [ ] T6 (design doc). With `validation_status.smart` not `'ok'` / `'hp_undersized'`: smart HP area present on left tile if `elec_kwh` non-null; smart temp series absent from right tile; note shown below right chart.
- [ ] T7 (design doc). Selecting an absence day (all `heating_kwh = null`): canvases hidden, "No heating data for this day" shown. No Chart.js console error.
- [ ] T8 (design doc). With `current.indoor_temp_c` all null (HTC unavailable): right tile shows outdoor temp and smart HP trace only; note shown. No missing-series error.
- [ ] Section is hidden on page load and revealed when results are displayed (not before).
- [ ] On mobile (375px): tiles stack vertically; date picker full width below heading.
- [ ] No new console errors.

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-05-07
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `praxis-claude-hub/projects/tools/heatpump-analyser/design/ui-day-view-charts.md`

### Context

Plan submitted for the day-view two-tile chart section that sits between `financial-card` and the What If section. Reviewed against the parent design doc (committed `b8371e7`) and the `m7-scenario-consumption-revised` plan (approved `aea62ed`, implementation underway). Read-only Explore sub-agent dispatched to verify two specific codebase claims (getter names and rate-array index parity); both verified clean.

### Required changes for implementation

**1. Step 10 canvas refs reconciled with Step 3.** Original plan had `setupDayViewCharts` using `document.getElementById('chart-dispatch')` / `'chart-temp'` inline, followed by a trailing "Clarification note" instructing the implementer to instead use module-level consts that the plan never declared in Step 3. Two competing instructions for the same code path forced the implementer to reconcile them. Resolved inline: canvas consts (`chartDispatchCanvas`, `chartTempCanvas`) declared in Step 3; Step 10 body uses those refs; trailing "Revised canvas refs" / "Add to Step 3 DOM refs" snippets dropped from the Notes block.

**2. Dispatch-note wiring added to `renderDayViewDay`.** Original plan declared `<p id="dispatch-note">` in HTML and a `dispatchNote` DOM ref in Step 3, but never set its content or visibility — leaving the design's "Smart HP area still shown if elec_kwh non-null; otherwise omit with note" only half-implemented (the omit half worked via `?? null`; the note half was unwired). Resolved inline: data-driven check on `smartElec.some(v => v !== null)` toggles `#dispatch-note` visibility and sets text. **Note copy:** "Smart HP dispatch not available — thermal mass data required." (parallel to the right-tile temp note for the same root cause). Final copy is Rhiannon's call — adjust at approval if a different phrasing is preferred.

**3. Step 12 line-number reference removed.** Plan referenced "currently at line ~2174" alongside a function-name anchor. Line numbers don't survive between sessions; the function-name anchor (`buildAndDisplayVerdict`, after `verdictCard.classList.remove('hidden')`) is durable. Hygiene edit applied.

### Resolution of review changes

1. **Step 10 canvas refs reconciled with Step 3** — Step 3 amended to declare `chartDispatchCanvas` / `chartTempCanvas` consts; Step 10 body uses those refs; trailing contradictory notes removed.
2. **Dispatch-note wiring added to `renderDayViewDay`** — three-line block added after `chartDispatch.update()`, parallel to the right-tile note pattern.
3. **Step 12 line-number reference removed** — replaced by function-name anchor only.

### Items noted but not edited

- **MEDIUM (verified clean) — Codebase claims.** Read-only Explore confirmed all four getters exist with the exact names the plan uses (`getBaseloadResult`, `getExternalResult`, `getScenarioConsumptionResult`, `getRateMetadata`) as exports of their respective modules, and that `gas_rate_by_hh` / `elec_hh_rate_by_hh` are 1:1 with `consumption.length` by construction (single indexed loop in `prepareRates`). No edit required; recording the verification here so future readers don't duplicate the check.
- **MEDIUM — Dependency on `m7-scenario-consumption-revised`.** Plan correctly declares the prerequisite. M7-revised is approved (`aea62ed`) but not yet implemented. Implementation of this plan must wait. The defensive allowlist for `validation_status.smart` (`'ok'` || `'hp_undersized'`) correctly treats any other status — including all post-rename values from m7-revised — as "smart unavailable". No edit required.
- **LOW — DST tick labels.** On 50-slot autumn days the tick callback's hardcoded `generateHhLabels(48)[i]` returns `undefined` for indices 48–49 (caught by `?? ''` → blank labels). On 46-slot spring days labels are sequential and don't reflect the missing hour. Acceptable per parent design doc ("may not align perfectly — acceptable").
- **LOW — `setDatasetVisibility` fallback note in Risks table.** Risks row mentions a `.hidden`-property fallback even though `setDatasetVisibility` is supported in Chart.js 4 and used throughout. Surface mentioned in the risk table is a style choice, not a defect.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | ✓ pass |
| HIGH     | 2     | ✅ resolved |
| MEDIUM   | 2     | ℹ noted |
| LOW      | 2     | — note |

Verdict: ⚠ APPROVED WITH EDITS — both HIGH issues resolved inline; MEDIUM items either verified clean or correctly handled defensively; LOW items acceptable per design.

---

## Approval

**Status:** ⚠ Approved with edits — 2026-05-07
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** Dispatch-note copy "Smart HP dispatch not available — thermal mass data required." (parallel to right-tile temp note); implementation cannot begin until `m7-scenario-consumption-revised` is implemented and merged.

---

## Implementation Deviations

*(To be completed after implementation.)*
