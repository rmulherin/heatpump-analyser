# Step M10a — UI & Presentation (v1 launch build)

**Date:** 2026-04-28
**Status:** ✅ Approved — 2026-04-28

---

## Task description

Restructure the page from a computation-ordered card stack into an answer-first
narrative and add a verdict block as the primary output. Changes cover: typography
(Montserrat + Roboto), DOM reordering, a verdict card with Chart.js horizontal bar,
three section banners, a methodology `<details>` disclosure, DL label rewrites, scenario
label standardisation, and card h2 renames. No new JS modules, no new external
dependencies. Affects `index.html`, `css/styles.css`, and `js/app.js` only.

Design doc: `praxis-claude-hub/projects/tools/heatpump-analyser/design/ui-design-m10a.md`

---

## Research findings

**Chart.js horizontal bar** — `type: 'bar'` with `indexAxis: 'y'` is the correct
Chart.js 4.x API. Already used in the project; no new CDN needed.

**`<details>` / `<summary>`** — HTML standard, no polyfill needed. Design doc explicitly
accepts visible fallback on legacy browsers.

**Google Fonts** — `Montserrat:wght@400;600` and `Roboto:wght@400;500` loaded via
`fonts.googleapis.com` with `rel="preconnect"` preloads, as specified. Fonts are
referenced from external Google CDN only (client-side static tool — consistent with
existing Chart.js and Luxon CDN usage).

**`getCapitalParams` (design doc discrepancy):** The design doc references
`getCapitalParams().avoided_ac_gbp` for the cooling note. This function does not exist
in `app.js`. The correct call is `readCapitalParams().avoided_ac_cost_gbp`. This
resolution is used throughout Step 16.

**`methodology-disclosure` reveal location (design doc discrepancy):** The design doc
says reveal the `<details>` element "inside `displayHeatLossResults`, immediately before
the existing `heatLossCard.classList.remove('hidden')` call." However,
`heatLossCard.classList.remove('hidden')` is actually in `runHeatLoss`, not in
`displayHeatLossResults`. The disclosure will be revealed in `runHeatLoss`, alongside
`heatLossCard.classList.remove('hidden')`. Functionally identical to the design doc's
intent.

**Existing project patterns reused:**
- `escapeHtml()` — existing helper, used in verdict HTML
- `getRateMetadata()`, `getHeatLossResult()`, `getFinancialResult()` — existing getters,
  passed as parameters into `buildAndDisplayVerdict`
- `readCapitalParams()` — existing reader, used for cooling note
- Chart.js `verdictChart` managed with module-level variable + `.destroy()` on recreate
  (matches `charts.js` convention from prior modules)

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | Typography links, DOM restructure, h2 renames, card intros |
| MODIFY | `css/styles.css` | Typography rules, verdict/banner/disclosure CSS |
| MODIFY | `js/app.js` | Verdict function, label updates, reveal logic |

---

## Implementation steps

### Step 1 — Typography: Google Fonts links (index.html `<head>`)

Insert before the existing `<link rel="stylesheet" href="css/styles.css">`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600&family=Roboto:wght@400;500&display=swap" rel="stylesheet">
```

**Complexity:** Low

---

### Step 2 — DOM restructure (index.html)

The current body order is:
```
data-input-card → results-card → energy-summary-card → heat-loss-card →
thermal-char-card → hp-model-card → scenario-card → pricing-params-card →
pricing-card → financial-params-card → financial-card
```

Required order after restructure:
```
data-input-card
verdict-card            (NEW — insert after data-input-card)
section-banner-your-home (NEW — insert before results-card)
results-card
energy-summary-card
methodology-disclosure  (NEW <details> wrapping the 4 technical cards)
  heat-loss-card
  thermal-char-card
  hp-model-card
  scenario-card
section-banner-verdict  (NEW — insert before pricing-card)
pricing-card            (moved: was after pricing-params-card)
financial-card          (moved: was after financial-params-card)
section-banner-assumptions (NEW — insert before pricing-params-card)
pricing-params-card     (moved: was before pricing-card)
financial-params-card   (moved: was before financial-card)
```

**Sub-steps:**

**2a. Insert verdict card** immediately after closing `</section>` of `data-input-card`:

```html
<section class="card verdict-card hidden" id="verdict-card">
  <div class="verdict-headline" id="verdict-headline"></div>
  <div class="verdict-chart-wrap">
    <canvas id="verdict-chart"></canvas>
  </div>
  <p class="verdict-cooling hidden" id="verdict-cooling"></p>
  <p class="verdict-quality" id="verdict-quality"></p>
</section>
```

**2b. Insert section-banner-your-home** immediately before `results-card`:

```html
<div class="section-banner hidden" id="section-banner-your-home">
  <h2 class="section-heading">Your home</h2>
</div>
```

**2c. Wrap the four technical cards in `<details>`** — replace the four individual
`<section>` elements (heat-loss-card, thermal-char-card, hp-model-card, scenario-card)
with:

```html
<details class="methodology-disclosure hidden" id="methodology-disclosure">
  <summary class="methodology-summary">Show methodology</summary>
  [heat-loss-card section — content unchanged]
  [thermal-char-card section — content unchanged]
  [hp-model-card section — content unchanged]
  [scenario-card section — content unchanged]
</details>
```

All four inner `<section>` elements retain their `id` attributes and `.hidden` class.
No inner content changes in this step.

**2d. Insert section-banner-verdict** immediately before pricing-card:

```html
<div class="section-banner hidden" id="section-banner-verdict">
  <h2 class="section-heading">The verdict</h2>
</div>
```

**2e. Reorder pricing-card and financial-card** to appear before pricing-params-card
and financial-params-card. The new order of these four elements:

```
pricing-card
financial-card
section-banner-assumptions
pricing-params-card
financial-params-card
```

Insert section-banner-assumptions between financial-card and pricing-params-card:

```html
<div class="section-banner hidden" id="section-banner-assumptions">
  <h2 class="section-heading">Adjust the assumptions</h2>
</div>
```

**Complexity:** Medium — careful element relocation; all JS references are ID-based so
no JS references break.

---

### Step 3 — h2 renames (index.html)

Edit the `<h2>` text in each card per the design doc:

| Card id | Current h2 | Replace with |
|---------|-----------|-------------|
| `results-card` | "Data Summary" | "Your data" |
| `energy-summary-card` | "Energy Summary" | "How you use energy" |
| `heat-loss-card` | "Heat Loss Estimation" | "Heat loss" |
| `thermal-char-card` | "Thermal Character" | "Thermal character" |
| `hp-model-card` | "Heat Pump Model" | "Heat pump sizing" |
| `scenario-card` | "Scenario Consumption" | "Energy by scenario" |
| `pricing-card` | "Scenario Costs" | "Annual running costs" |
| `financial-card` | "Financial Summary" | "Savings and payback" |
| `pricing-params-card` | "Pricing Parameters" | "Pricing assumptions" |
| `financial-params-card` | "Installation Costs" | "Installation costs" |

**Complexity:** Low

---

### Step 4 — Card intro text (index.html)

**4a. Pricing parameters card** — replace existing `<p class="card-intro">` text:

```html
<p class="card-intro">These rates default to the Ofgem Q2 2026 price cap. Change them to model a
different tariff or future price scenario, then click Recalculate costs.</p>
```

**4b. Financial parameters card** — replace existing `<p class="card-intro">` text:

```html
<p class="card-intro">Defaults reflect typical 2025–2026 market rates and the current Boiler Upgrade
Scheme grant. Update with your own installer quote if you have one.</p>
```

**Complexity:** Low

---

### Step 5 — CSS: typography (styles.css)

**5a.** Replace existing `body` `font-family` declaration:

```css
body {
  font-family: Roboto, arial, sans-serif;
}
```

(Keep all other `body` rules unchanged.)

**5b.** Add new heading/button font rule after the `body` block:

```css
h1, h2, h3, h4,
.btn,
.section-heading,
.tab-btn,
.methodology-summary {
  font-family: Montserrat, sans-serif;
}
```

**Complexity:** Low

---

### Step 6 — CSS: section banners (styles.css)

Append to `styles.css`:

```css
/* ===== Section Banners ===== */
.section-banner {
  margin: 2rem 0 0.5rem;
}

.section-heading {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--colour-navy);
  border-bottom: 2px solid var(--colour-teal);
  padding-bottom: 0.35rem;
  margin-bottom: 0;
}
```

**Complexity:** Low

---

### Step 7 — CSS: methodology disclosure (styles.css)

Append to `styles.css`:

```css
/* ===== Methodology Disclosure ===== */
.methodology-disclosure {
  margin-bottom: 1.5rem;
}

.methodology-summary {
  display: block;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--colour-teal);
  cursor: pointer;
  padding: 0.75rem 1rem;
  background: var(--colour-light-grey);
  border: 1px solid var(--colour-border);
  border-radius: var(--radius);
  user-select: none;
}

.methodology-summary::-webkit-details-marker { display: none; }

.methodology-summary::before {
  content: '▶  ';
  font-size: 0.75em;
}

details[open] .methodology-summary::before {
  content: '▼  ';
}
```

**Complexity:** Low

---

### Step 8 — CSS: verdict card (styles.css)

Append to `styles.css`:

```css
/* ===== Verdict Card ===== */
.verdict-card {
  border-left: 4px solid var(--colour-teal);
}

.verdict-headline {
  font-size: 1rem;
  line-height: 1.7;
  color: var(--colour-dark);
}

.verdict-headline strong {
  color: var(--colour-navy);
}

.verdict-chart-wrap {
  height: 260px;
  margin: 1.25rem 0;
}

.verdict-quality {
  font-size: 0.82rem;
  color: var(--colour-dark);
  opacity: 0.65;
  margin-top: 0.75rem;
  border-top: 1px solid var(--colour-border);
  padding-top: 0.75rem;
}

.verdict-cooling {
  font-size: 0.9rem;
  background: var(--colour-light-grey);
  border-left: 3px solid var(--colour-teal);
  border-radius: 0 var(--radius) var(--radius) 0;
  padding: 0.6rem 0.85rem;
  margin-top: 0.75rem;
  color: var(--colour-dark);
}
```

**Complexity:** Low

---

### Step 9 — app.js: new DOM references

Add to the DOM References section, alongside existing pricing/financial refs:

```js
// Verdict card DOM references
const verdictCard      = document.getElementById('verdict-card');
const verdictHeadline  = document.getElementById('verdict-headline');
const verdictCooling   = document.getElementById('verdict-cooling');
const verdictQuality   = document.getElementById('verdict-quality');

// Section banner DOM references
const bannerYourHome      = document.getElementById('section-banner-your-home');
const bannerVerdict       = document.getElementById('section-banner-verdict');
const bannerAssumptions   = document.getElementById('section-banner-assumptions');

// Methodology disclosure DOM reference
const methodologyDisclosure = document.getElementById('methodology-disclosure');
```

**Complexity:** Low

---

### Step 10 — app.js: scenario label updates

Update the three label maps to use the new standardised labels:

```js
const SCENARIO_LABELS = {
  current:      'Your current boiler',
  dumb_hp_svt:  'Heat pump — flat-rate tariff',
  dumb_hp_hh:   'Heat pump — half-hourly tariff',
  hybrid_dumb:  'Hybrid — half-hourly tariff',
  smart_hp_hh:  'Smart heat pump — half-hourly tariff',
  hybrid_smart: 'Smart hybrid — half-hourly tariff',
};
```

Apply identical labels to `SCENARIO_DISPLAY_NAMES` and `FINANCIAL_DISPLAY_NAMES`.

(The `current` key in `SCENARIO_DISPLAY_NAMES` / `FINANCIAL_DISPLAY_NAMES` was previously
`'Current (gas boiler)'` — replace with `'Your current boiler'`.)

**Complexity:** Low

---

### Step 11 — app.js: financial table column headers

In `displayFinancialResults`, update the `<thead>` row:

| Current text | Replace with |
|-------------|-------------|
| "Annual saving vs boiler" | "Annual saving" |
| "Net investment" | "Net cost (after grant)" |
| "Payback" | "Payback period" |

**Complexity:** Low

---

### Step 12 — app.js: DL label rewrites and row removals

**12a. `displayHeatLossResults`** — update the `rows.push(...)` calls:

| Current label | Action |
|--------------|--------|
| `'Heat transfer coefficient (HTC)'` | → `'Heat loss rate'` |
| `'95% confidence interval'` | → `'Confidence range (95%)'` |
| `'Adjusted HTC (incl. electric heating)'` | → `'Adjusted heat loss rate (includes electric heating)'` |
| `'Heat loss parameter (HLP)'` | → `'Heat loss per m² (HLP)'` |
| `'Effective solar aperture'` | → `'Solar aperture (free heat from the sun)'` |
| `'Degree-day base temperature'` | **Remove entire `rows.push` line** |
| `'Boiler efficiency used'` | **Remove entire `rows.push` line** |
| `'Days used in fit'` | **Remove entire `rows.push` line** |
| `'Validation status'` | **Remove entire `rows.push` line** |

Rows for `'Insulation rating'`, `'Solar gain rating'`, `'Summer cooling consideration'`,
and `'Fit quality (R²)'` are unchanged.

**12b. `displayThermalCharacterResults`** — update the `rows.push(...)` calls:

| Current label | Action |
|--------------|--------|
| `'Inferred thermostat setpoint'` | → `'Estimated thermostat setpoint'` |
| `'Thermal mass'` | → `'Thermal mass (kJ/K)'` |
| `'Occupancy pattern'` | → `'Occupancy model'` |
| `'Half-hourly periods used (setpoint fit)'` | **Remove entire `rows.push` line** |
| `'Warm-up events used (thermal mass)'` | **Remove entire `rows.push` line** |
| `'Validation status'` | **Remove entire `rows.push` line** |

Rows for `'Thermal mass source'`, `'Thermal time constant'`, and `'Thermal mass rating'`
are unchanged.

**12c. `displayHeatPumpModelResults`** — update the `rows.push(...)` calls:

| Current label | Action |
|--------------|--------|
| `'HP heat output (design conditions, −3°C)'` | → `'Required heat output at −3°C'` |
| `'HP electrical input (design conditions)'` | **Remove entire `rows.push` line** |
| `'Annual mean COP (demand-weighted)'` | → `'Estimated mean annual COP'` |
| `'COP range across the year'` | → `'COP range (coldest to warmest days)'` |
| `'Hours below design temperature'` | **Remove entire `rows.push` line** |
| `'Design outdoor temperature'` | **Remove entire `rows.push` line** |
| `'Validation status'` | **Remove entire `rows.push` line** |

**Complexity:** Medium — surgical line-level edits across three functions

---

### Step 13 — app.js: energy summary intro sentence

In `renderEnergySummaryTable`, prepend the intro paragraph before the `<table>`:

```js
energySummaryContent.innerHTML = `
  <p class="card-intro">Here's how your annual energy use breaks down. Gas heating is
  what a heat pump would replace.</p>
  <table class="energy-summary-table">
    ...
  </table>`;
```

**Complexity:** Low

---

### Step 14 — app.js: section banner and disclosure reveal logic

**14a. `showSuccessSummary`** — immediately before (or after) `resultsCard.classList.remove('hidden')`, add:

```js
bannerYourHome.classList.remove('hidden');
```

**14b. `displayPricingResults`** — immediately after the existing reveals of `pricingCard`,
`pricingParamsCard`, and `btnRecalcPricing`, add:

```js
bannerVerdict.classList.remove('hidden');
bannerAssumptions.classList.remove('hidden');
```

**14c. `runHeatLoss`** — immediately before `heatLossCard.classList.remove('hidden')`, add:

```js
methodologyDisclosure.classList.remove('hidden');
```

This is the implementation-actual location (design doc specifies "inside
`displayHeatLossResults`" but `heatLossCard.classList.remove('hidden')` is in
`runHeatLoss` — see Research findings).

**Complexity:** Low

---

### Step 15 — app.js: module-level verdictChart variable

At module scope, after the existing label-map declarations and before the DOM
References section, add:

```js
let verdictChart = null;
```

**Complexity:** Low

---

### Step 16 — app.js: `buildAndDisplayVerdict` function

Add new function to `app.js`. Full specification below.

**Signature:**
```js
function buildAndDisplayVerdict(financialResult, heatLossResult, rateMetadata)
```

**Step 16a — Identify primary scenario** (priority: `smart_hp_hh` → `dumb_hp_hh` → `dumb_hp_svt`):

```js
const priority = ['smart_hp_hh', 'dumb_hp_hh', 'dumb_hp_svt'];
const primaryKey = priority.find(k =>
  financialResult.scenarios[k].payback_status !== 'no_data'
) ?? null;
```

**Step 16b — Determine verdict type:**

```js
let verdictType;
if (!primaryKey) {
  verdictType = 'insufficient';
} else {
  const ps = financialResult.scenarios[primaryKey];
  if (ps.payback_status === 'ok' && ps.annual_saving_gbp > 50) {
    verdictType = 'positive';
  } else if (ps.payback_status === 'ok' && ps.annual_saving_gbp > 0) {
    verdictType = 'marginal';
  } else {
    verdictType = 'negative';
  }
}
```

**Step 16c — Format helpers:**

```js
const roundGbp = (v) => Math.round(v);
const fmtGbpVerdict = (v) => `£${Math.abs(Math.round(v)).toLocaleString('en-GB')}`;
const fmtPaybackYears = (years) => {
  if (years > 30) return 'well beyond a 30-year planning horizon';
  return `${Math.round(years)} year${Math.round(years) === 1 ? '' : 's'}`;
};
```

**Step 16d — Build headline HTML** per copy templates in design doc § Step 3:

```js
const sc = (key) => financialResult.scenarios[key];
const currentCost = fmtGbpVerdict(sc('current').annual_cost_gbp ?? 0);
let headlineHtml = '';

if (verdictType === 'positive' && primaryKey === 'smart_hp_hh') {
  const saving = fmtGbpVerdict(sc('smart_hp_hh').annual_saving_gbp);
  const hpCost = fmtGbpVerdict(sc('smart_hp_hh').annual_cost_gbp);
  const payback = fmtPaybackYears(sc('smart_hp_hh').payback_years);
  const svtSaving = sc('dumb_hp_svt').annual_saving_gbp;
  const svtAvailable = sc('dumb_hp_svt').payback_status !== 'no_data';

  headlineHtml = `Based on your ${rateMetadata.data_period_days} days of data, a smart heat pump on a
half-hourly tariff would cut your annual heating bill by around <strong>${saving}</strong> — from
<strong>${currentCost}</strong> to <strong>${hpCost}</strong> per year.
At current installation costs, payback would be roughly <strong>${payback}</strong>.`;

  if (svtAvailable) {
    if (svtSaving <= 0) {
      headlineHtml += `<br><br>On a standard flat-rate tariff, a heat pump would cost slightly more to
run than your current boiler. The economics depend heavily on switching to a half-hourly tariff.`;
    } else {
      const svtSavingFmt = fmtGbpVerdict(svtSaving);
      headlineHtml += `<br><br>On a standard flat-rate tariff, the saving falls to about
<strong>${svtSavingFmt}</strong> per year — close to break-even. The difference comes down
largely to tariff choice and how well your home holds heat.`;
    }
  }

} else if (verdictType === 'positive' && primaryKey === 'dumb_hp_hh') {
  const saving = fmtGbpVerdict(sc('dumb_hp_hh').annual_saving_gbp);
  const hpCost = fmtGbpVerdict(sc('dumb_hp_hh').annual_cost_gbp);
  const payback = fmtPaybackYears(sc('dumb_hp_hh').payback_years);
  const svtAvailable = sc('dumb_hp_svt').payback_status !== 'no_data';
  headlineHtml = `Based on your ${rateMetadata.data_period_days} days of data, a heat pump on a
half-hourly tariff would cut your annual heating bill by around <strong>${saving}</strong> — from
<strong>${currentCost}</strong> to <strong>${hpCost}</strong> per year.
Payback is roughly <strong>${payback}</strong> at current installation costs.`;
  if (svtAvailable) {
    const svtSaving = fmtGbpVerdict(sc('dumb_hp_svt').annual_saving_gbp ?? 0);
    headlineHtml += `<br><br>On a flat-rate tariff, the saving falls to about <strong>${svtSaving}</strong> per year.`;
  }

} else if (verdictType === 'positive' && primaryKey === 'dumb_hp_svt') {
  const saving = fmtGbpVerdict(sc('dumb_hp_svt').annual_saving_gbp);
  const hpCost = fmtGbpVerdict(sc('dumb_hp_svt').annual_cost_gbp);
  const payback = fmtPaybackYears(sc('dumb_hp_svt').payback_years);
  headlineHtml = `Based on your ${rateMetadata.data_period_days} days of data, a heat pump on a
flat-rate tariff would cut your annual heating bill by around <strong>${saving}</strong> — from
<strong>${currentCost}</strong> to <strong>${hpCost}</strong> per year.
Payback is roughly <strong>${payback}</strong> at current installation costs.`;

} else if (verdictType === 'marginal') {
  const saving = fmtGbpVerdict(sc(primaryKey).annual_saving_gbp);
  headlineHtml = `Based on your data, the best heat pump scenario saves around <strong>${saving}</strong>
per year — roughly break-even against your current boiler. Whether it makes sense depends on
factors beyond running costs: the reliability of your existing boiler, the cooling capability a
heat pump adds, and future energy prices. Use the assumptions panel below to explore.`;

} else if (verdictType === 'negative') {
  const absSaving = fmtGbpVerdict(Math.abs(sc(primaryKey).annual_saving_gbp ?? 0));
  headlineHtml = `On your data, our modelling suggests a heat pump would cost slightly more to run
than your current boiler — by about <strong>${absSaving}</strong> per year on the best scenario.
This can shift significantly with tariff choice, installation quality, and future gas prices.
Use the assumptions panel below to explore.`;

} else {
  headlineHtml = `We couldn't get a confident picture from your data — you'll see why in the
methodology section below. The figures in the tables are rough estimates only.`;
}

verdictHeadline.innerHTML = headlineHtml;
```

**Step 16e — Data-quality footnote:**

```js
const r2 = heatLossResult?.regression_r2;
const vstatus = heatLossResult?.validation_status;
const n = rateMetadata.data_period_days;
let qualityText;

if (r2 === null || r2 === undefined || vstatus !== 'ok') {
  qualityText = 'Heat-loss estimation was not possible from your data — running cost figures are rough estimates only.';
} else if (r2 >= 0.80) {
  qualityText = `Analysis based on ${n} days of smart meter data. Fit quality: good (R²=${r2.toFixed(2)}) — accuracy is typically ±15–20% on the heat-loss estimate.`;
} else if (r2 >= 0.60) {
  qualityText = `Fit quality: fair (R²=${r2.toFixed(2)}) — treat these figures as a rough guide rather than a precise prediction.`;
} else {
  qualityText = `Fit quality: poor (R²=${r2.toFixed(2)}) — the heat-loss estimate is unreliable. Consider a professional survey before making a decision.`;
}
verdictQuality.textContent = qualityText;
```

**Step 16f — Cooling note:**

```js
const avoidedAc = readCapitalParams().avoided_ac_cost_gbp ?? 0;
if (avoidedAc === 0) {
  verdictCooling.textContent = 'A heat pump also provides cooling in summer. If you\'d otherwise buy or replace an air-conditioning unit, enter the estimated cost in "Adjust the assumptions" below to improve the payback figure.';
  verdictCooling.classList.remove('hidden');
} else {
  verdictCooling.classList.add('hidden');
}
```

**Step 16g — Scenario bar chart:**

Iterate `['current', 'dumb_hp_svt', 'dumb_hp_hh', 'hybrid_dumb', 'smart_hp_hh', 'hybrid_smart']`.
Include bar only if `annual_cost_gbp !== null`.

Y-axis labels:
```js
const VERDICT_CHART_LABELS = {
  current:      'Current boiler',
  dumb_hp_svt:  'HP — flat rate',
  dumb_hp_hh:   'HP — half-hourly',
  hybrid_dumb:  'Hybrid — HH',
  smart_hp_hh:  'Smart HP — HH',
  hybrid_smart: 'Smart hybrid — HH',
};
```

Bar colours: `current` → `'#26588D'` (navy); all others → `'#3B8284'` (teal) if
`annual_saving_gbp > 0`, else `'#FD7A7F'` (coral).

Chart config as specified in design doc § Section B (copied exactly):

```js
if (verdictChart) verdictChart.destroy();

const scenarioOrder = ['current', 'dumb_hp_svt', 'dumb_hp_hh', 'hybrid_dumb', 'smart_hp_hh', 'hybrid_smart'];
const chartData = scenarioOrder
  .filter(k => financialResult.scenarios[k].annual_cost_gbp !== null)
  .map(k => ({
    key: k,
    label: VERDICT_CHART_LABELS[k],
    cost: financialResult.scenarios[k].annual_cost_gbp,
    saving: financialResult.scenarios[k].annual_saving_gbp,
  }));

const bgColors = chartData.map(d =>
  d.key === 'current' ? '#26588D' : (d.saving > 0 ? '#3B8284' : '#FD7A7F')
);

const ctx = document.getElementById('verdict-chart').getContext('2d');
verdictChart = new Chart(ctx, {
  type: 'bar',
  data: {
    labels: chartData.map(d => d.label),
    datasets: [{
      data: chartData.map(d => d.cost),
      backgroundColor: bgColors,
    }],
  },
  options: {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: ctx => `£${Math.round(ctx.parsed.x).toLocaleString('en-GB')}/yr`,
        },
      },
    },
    scales: {
      x: {
        beginAtZero: true,
        title: { display: true, text: 'Annual cost (£/yr)' },
        ticks: {
          callback: v => `£${Math.round(v).toLocaleString('en-GB')}`,
        },
      },
      y: {
        ticks: { font: { size: 12 } },
      },
    },
  },
});
```

**Step 16h — Reveal verdict card:**

```js
verdictCard.classList.remove('hidden');
```

**Complexity:** High — new function with conditional branching; chart instance management

---

### Step 17 — app.js: wire `buildAndDisplayVerdict` into `displayFinancialResults`

At the end of `displayFinancialResults`, after `btnRecalcFinancial.classList.remove('hidden')`,
add:

```js
const heatLossRes = getHeatLossResult();
const rateMeta    = getRateMetadata();
if (rateMeta) {
  buildAndDisplayVerdict(result, heatLossRes, rateMeta);
}
```

`result` is the `financialResult` parameter already in scope.

The guard `if (rateMeta)` ensures the verdict does not crash if pricing has not run
(defensive; should not occur in the normal pipeline).

**Complexity:** Low

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| DOM restructure breaks a JS reference | All JS refs use `getElementById` by ID — IDs are unchanged. No risk. |
| `verdictChart` not destroyed on recalculate | Module-level `let verdictChart = null` with `destroy()` guard in Step 16g. |
| `getCapitalParams` doesn't exist | Resolved in Research: use `readCapitalParams().avoided_ac_cost_gbp`. |
| `methodology-disclosure` reveal location | Resolved in Research: add to `runHeatLoss` alongside `heatLossCard.classList.remove('hidden')`. |
| Chart.js 4.x `indexAxis: 'y'` not working | Already available in Chart.js 4.x; verified by existing project usage pattern. |
| Verdict copy innerHTML includes `<br>` and `<strong>` — XSS risk | All monetary/day values are computed numbers, not user input. `rateMetadata.data_period_days` is an integer from normalised data. No user-supplied strings interpolated into `headlineHtml`. Safe. |
| 375px layout: y-axis labels truncated | Design doc requires non-broken at 375px. Chart uses `maintainAspectRatio: false` and fixed height 260px. Abbreviated labels (`'HP — flat rate'`) should fit. Verify in browser at 375px. |
| `marginal` verdict condition — overlap with `positive` | Condition: `payback_status === 'ok'` AND `annual_saving_gbp > 50` → positive. Saving 0–50 → marginal. Saving ≤ 0 or `payback_status === 'no_saving'` → negative. No overlap. |

---

## Success criteria

- [ ] 1. After analysis completes, verdict card appears above "Your home" section banner.
- [ ] 2. Verdict copy correctly identifies primary scenario; second-paragraph comparison appears when `smart_hp_hh` is primary and `dumb_hp_svt` is also available.
- [ ] 3. All available scenarios appear as bars; bars with null `annual_cost_gbp` are absent.
- [ ] 4. Current-boiler bar is navy; HP bars are teal (positive saving) or coral (negative saving).
- [ ] 5. Chart tooltip shows `£X/yr` on hover.
- [ ] 6. Clicking "Show methodology" reveals the four technical cards; clicking again collapses them.
- [ ] 7. Four technical cards remain accessible inside the closed disclosure.
- [ ] 8. Section banners appear at the correct pipeline moments: "Your home" with results-card, "The verdict" and "Adjust the assumptions" with pricing-card.
- [ ] 9. Removed DL rows (validation status, days used, boiler efficiency, etc.) are absent from all three technical cards.
- [ ] 10. Scenario labels are consistent across pricing table, financial table, and scenario consumption table.
- [ ] 11. Financial table column headers show "Annual saving", "Net cost (after grant)", "Payback period".
- [ ] 12. Cooling note visible when avoided AC = £0; hidden when > £0.
- [ ] 13. Data-quality footnote reflects correct R² band.
- [ ] 14. No Chart.js console errors; no JS console errors.
- [ ] 15. Chart readable at 375px — bars visible, y-axis labels legible.
- [ ] 16. Body text renders in Roboto; headings and buttons render in Montserrat (check in DevTools).
- [ ] 17. Pricing-params and financial-params cards appear below pricing-card and financial-card in the page.

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-28
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `praxis-claude-hub/projects/tools/heatpump-analyser/design/ui-design-m10a.md`

### Context

M10a is the v1 UI & Presentation module, written the same day as this plan. The
design doc was produced by the Opus window and reviewed with Rhiannon before Sonnet
planned against it. Two discrepancies between the design doc and the actual codebase
were correctly identified and resolved in Research findings: `getCapitalParams` →
`readCapitalParams().avoided_ac_cost_gbp`, and the `methodology-disclosure` reveal
location (`runHeatLoss`, not `displayHeatLossResults`). Both resolutions are correct.

### Required changes for implementation

**1. `dumb_hp_hh` positive branch: add SVT availability guard**

The `dumb_hp_hh` branch showed the flat-rate comparison sentence unconditionally,
using `?? 0` to handle a null saving — which would silently display "£0" if
`dumb_hp_svt` has no data. Fixed to match the `smart_hp_hh` branch pattern:
`svtAvailable` guard added; sentence only rendered when `payback_status !== 'no_data'`.

**2. Marginal verdict condition: simplify**

`else if (ps.payback_status === 'ok' || (ps.annual_saving_gbp > 0 && ps.annual_saving_gbp <= 50))`
replaced with `else if (ps.payback_status === 'ok' && ps.annual_saving_gbp > 0)`.
The original OR arm was redundant (M9 sets `payback_status === 'ok'` whenever saving
is positive) and created a latent misclassification risk. Simplified form is correct
and matches the design doc intent.

### Resolution of review changes

1. **SVT guard in `dumb_hp_hh` branch** — applied inline to Step 16d. `svtAvailable`
   guard added; `svtSaving` computation moved inside the conditional block.
2. **Marginal condition simplified** — applied inline to Step 16b. OR arm removed.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | ✓ pass |
| HIGH     | 0     | ✓ pass |
| MEDIUM   | 1     | ✅ resolved |
| LOW      | 1     | ✅ resolved |

Verdict: APPROVE — plan is faithful to the design doc; two minor logic issues fixed inline.

---

## Approval

**Status:** ✅ Approved — 2026-04-28
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:**
1. Use `readCapitalParams().avoided_ac_cost_gbp` (not `getCapitalParams`).
2. Reveal `methodology-disclosure` in `runHeatLoss` alongside `heatLossCard.classList.remove('hidden')`.
3. `dumb_hp_hh` SVT comparison sentence guarded by `svtAvailable` check.
4. Marginal verdict condition: `payback_status === 'ok' && annual_saving_gbp > 0`.

---

## Implementation Deviations

**Date:** 2026-04-28
**Commit:** (see git log)

None. All four clarifications from the Opus review were applied as specified:
1. `readCapitalParams().avoided_ac_cost_gbp` used throughout Step 16.
2. `methodologyDisclosure.classList.remove('hidden')` added to `runHeatLoss`, alongside `heatLossCard.classList.remove('hidden')`.
3. `dumb_hp_hh` SVT comparison sentence guarded by `svtAvailable` check.
4. Marginal verdict condition: `payback_status === 'ok' && annual_saving_gbp > 0`.
