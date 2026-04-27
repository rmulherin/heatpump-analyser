# Module 8 — Pricing Engine

**Date:** 2026-04-27
**Status:** ✅ Approved — 2026-04-27
**Depends on:**
- `docs/plans/m7-scenario-consumption.md` — must be ✅ Approved AND merged. M8 Phase B
  consumes `getScenarioConsumptionResult().scenarios` and `validation_status`.

---

## Task description

Implement `js/pricing-engine.js` — applies tariff rates to M7's six scenario consumption
arrays to produce annual heating costs, monthly breakdowns, and standing-charge components
for each scenario. Also builds the per-HH gas and HH-wholesale electricity rate arrays
(with overhead) used by M8 Phase B for cost computation.

Two functions are exported: `prepareRates()` (Phase A) and `computeCosts()` (Phase B).
Both are called from `app.js` after M7 runs. Phase A builds the rate arrays; Phase B applies
them to scenario consumption.

Design doc:
`~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/pricing-engine.md`

---

## Research findings

### Upstream contract discrepancies — design doc vs actual code

The design doc describes M1's tariff data using field names that differ from the live code.
This plan uses the **actual code field names** throughout.

| Design doc field | Actual M1 field | Notes |
|------------------|-----------------|-------|
| `gas_periods[]` | `tariff_rates.gas[]` | Object key is `gas`, not `gas_periods` |
| `elec_periods[]` | `tariff_rates.electricity[]` | Object key is `electricity` |
| `start` / `end` | `valid_from` / `valid_to` | ISO strings; `valid_to` may be `null` |
| `rate_p_per_kwh` | `rate_p_kwh` | Confirmed: `data-ingestion.js:354` |
| `standing_charge_p_per_day` | `standing_p_day` | Confirmed: `data-ingestion.js:355` |
| `hh_timestamps: string[]` | `consumption[i].timestamp` | No separate timestamps array in M1 result |
| `wholesale_prices: number[]` | `external[i].wholesale_p_kwh` | M2 returns array of objects |

### M7 rate array conflict

The M7 approved plan defines a `buildRateArrays()` helper in `app.js` that computes
`gasRateByHh` and `elecHhRateByHh`. Its `elecHhRateByHh` uses raw wholesale prices
(`external[i].wholesale_p_kwh`) with no overhead, because the M7 review accepted: "use
`external[i].wholesale_p_kwh` directly; M8 will own retail markup."

**M8 does NOT reuse M7's `buildRateArrays` helper.** M8's `prepareRates()` builds its own
`elec_hh_rate_by_hh = wholesale + hh_overhead` for cost computation. M7's dispatch decisions
(already approved) continue to use raw wholesale.

`gas_rate_by_hh` uses identical lookup logic in both — the only difference is the electricity
rate.

### M7 output contract

Confirmed from `m7-scenario-consumption.md` Step 1n and Step 1m:

```javascript
// getScenarioConsumptionResult() returns:
{
  scenarios: {
    current:      { gas_kwh: (number|null)[], elec_kwh: (number|null)[], indoor_temp_c: ... },
    dumb_hp_svt:  { gas_kwh, elec_kwh, indoor_temp_c },  // same object reference as dumb_hp_hh
    dumb_hp_hh:   { gas_kwh, elec_kwh, indoor_temp_c },  // same object reference as dumb_hp_svt
    hybrid_dumb:  { gas_kwh, elec_kwh, indoor_temp_c },
    smart_hp_hh:  { gas_kwh, elec_kwh, indoor_temp_c },  // all-null arrays if smart !== 'ok'
    hybrid_smart: { gas_kwh, elec_kwh, indoor_temp_c },  // all-null arrays if smart !== 'ok'
  },
  validation_status: {
    dumb: 'ok' | 'partial' | 'no_data',
    smart: 'ok' | 'insufficient_data',
  },
  warnings: string[],
}
```

### Sequencing with unimplemented M6 + M7

M6 and M7 are not yet implemented. M8's `runPricingEngine()` will be added to `app.js` as
a function but **not wired into the pipeline** — a comment marks its future insertion point
(immediately after the M7 call in both the Octopus and CSV pipelines). When M7 is
implemented, the wiring is a single `await runPricingEngine(...)` call.

For now, `runPricingEngine` can be invoked manually via the recalculate button in the UI
card once M7 data is present.

### Gas rate lookup pattern

M7 plan's `buildRateArrays` uses a linear forward scan over sorted `tariff_rates.gas`
windows (confirmed adequate — 1–4 windows typical). M8 reuses the same algorithm pattern:
scan in `valid_from` order, advance while `new Date(w.valid_from) <= tsDate` and window is
not yet closed.

```javascript
// Correctly handles: valid_to = null (open-ended, current tariff) and
// valid_to = ISO string (closed period). Gap case: no window covers the timestamp.
for (const w of sortedGasWindows) {
  if (new Date(w.valid_from) > tsDate) break;
  if (!w.valid_to || new Date(w.valid_to) > tsDate) { gasRate = w.rate_p_kwh; break; }
}
```

### Standing charges — most recent period

`tariff_rates.gas` and `tariff_rates.electricity` are sorted ascending by `valid_from`
(confirmed: `data-ingestion.js:363`). Most recent = `array[array.length - 1].standing_p_day`.
For the CSV path, there is exactly one entry. This is the representative daily standing
charge.

### Monthly breakdown

Group by `consumption[i].timestamp.slice(0, 7)` (YYYY-MM). Count distinct dates per month
(`new Set(monthIndices.map(i => consumption[i].timestamp.slice(0, 10))).size`). Partial
flag: `distinctDates < 20`.

Standing charge per month: `distinctDates × standing_p_day / 100` (in £), applied for
each fuel the scenario uses.

### No external library needed

All arithmetic is plain JS. No new CDN entries required.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/pricing-engine.js` | `prepareRates()`, `computeCosts()`, module state |
| MODIFY | `js/app.js` | Import, DOM refs, `readRateParams()`, `runPricingEngine()`, `displayPricingResults()`, recalculate button, pipeline wiring (after M7), debug export |
| MODIFY | `index.html` | Rate parameters card, pricing results card |

---

## Implementation steps

### Step 1 — Create `js/pricing-engine.js`

#### 1a. Constants

```javascript
const PE_CONFIG = {
  SVT_RATE_DEFAULT_P:          24.50,   // Q2 2026 Ofgem cap
  ELEC_STANDING_DEFAULT_P_DAY: 61.64,
  GAS_STANDING_DEFAULT_P_DAY:  31.66,
  HH_OVERHEAD_DEFAULT_P:       13.00,
  EXTREME_NEG_WHOLESALE_P:    -20.0,   // warn threshold
  PARTIAL_MONTH_DAY_THRESHOLD: 20,     // < this days in month → partial: true
  MIN_DAYS_WARN:               90,     // < 90 days → annual estimate reliability warning
};

const SCENARIO_FUELS = {
  current:      ['gas', 'electricity'],
  dumb_hp_svt:  ['electricity'],
  dumb_hp_hh:   ['electricity'],
  smart_hp_hh:  ['electricity'],
  hybrid_dumb:  ['gas', 'electricity'],
  hybrid_smart: ['gas', 'electricity'],
};

const SCENARIO_ELEC_RATE_TYPE = {
  current:      'none',
  dumb_hp_svt:  'svt',
  dumb_hp_hh:   'hh',
  smart_hp_hh:  'hh',
  hybrid_dumb:  'hh',
  hybrid_smart: 'hh',
};
```

#### 1b. State management

```javascript
let _rateMetadata  = null;
let _pricingResult = null;

export function setRateMetadata(r)  { _rateMetadata  = r; }
export function getRateMetadata()   { return _rateMetadata; }
export function setPricingResult(r) { _pricingResult = r; }
export function getPricingResult()  { return _pricingResult; }
```

#### 1c. `prepareRates(ingestion, external, params)` — Phase A

Inputs:
- `ingestion` from `getIngestionResult()`: `{ consumption, tariff_rates, metadata }`
- `external` from `getExternalResult()`: array of `{ timestamp, temp_c, solar_w_m2, wholesale_p_kwh }`
- `params`: `{ svt_rate_p_per_kwh, svt_standing_charge_p, gas_standing_charge_p, hh_overhead_p_per_kwh }`
  (falls back to `PE_CONFIG` defaults for any null/undefined field)

Steps:

**Sort gas windows once:**
```javascript
const gasWindows = [...ingestion.tariff_rates.gas]
  .sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));
```

**Build `gas_rate_by_hh` and `elec_hh_rate_by_hh` in a single pass:**
```javascript
const warnings = [];   // declare before any push calls
const n = ingestion.consumption.length;
const gas_rate_by_hh  = new Array(n);
const elec_hh_rate_by_hh = new Array(n);
let warnedNullWholesale = false;
let warnedGapTariff     = false;
let hasExtremeNeg       = false;
const hh_overhead = params.hh_overhead_p_per_kwh ?? PE_CONFIG.HH_OVERHEAD_DEFAULT_P;  // hoisted

for (let i = 0; i < n; i++) {
  const ts     = ingestion.consumption[i].timestamp;
  const tsDate = new Date(ts);

  // Gas rate lookup — forward scan
  let gasRate = null;
  for (const w of gasWindows) {
    if (new Date(w.valid_from) > tsDate) break;
    if (!w.valid_to || new Date(w.valid_to) > tsDate) { gasRate = w.rate_p_kwh; break; }
  }
  if (gasRate === null) {
    // Gap in tariff history — use nearest (last window before this timestamp)
    gasRate = gasWindows.findLast(w => new Date(w.valid_from) <= tsDate)?.rate_p_kwh
           ?? gasWindows[0]?.rate_p_kwh ?? 0;
    if (!warnedGapTariff) { warnings.push('Gap in gas tariff history — using nearest rate for affected periods.'); warnedGapTariff = true; }
  }
  gas_rate_by_hh[i] = gasRate;

  // HH electricity rate = wholesale + overhead
  const wholesale = external[i]?.wholesale_p_kwh;
  if (wholesale === null || wholesale === undefined) {
    elec_hh_rate_by_hh[i] = hh_overhead;
    if (!warnedNullWholesale) { warnings.push('Some HH periods have no wholesale price data — using overhead-only rate for those periods.'); warnedNullWholesale = true; }
  } else {
    elec_hh_rate_by_hh[i] = wholesale + hh_overhead;
    if (wholesale < PE_CONFIG.EXTREME_NEG_WHOLESALE_P && !hasExtremeNeg) {
      warnings.push('Extreme negative wholesale prices found — check Elexon data quality.');
      hasExtremeNeg = true;
    }
  }
}
```

**Standing charges — most recent period:**
```javascript
const gasArr  = ingestion.tariff_rates.gas;
const elecArr = ingestion.tariff_rates.electricity;
const gas_standing_p_day  = gasArr[gasArr.length - 1]?.standing_p_day
                          ?? (params.gas_standing_charge_p  ?? PE_CONFIG.GAS_STANDING_DEFAULT_P_DAY);
const elec_standing_p_day = elecArr[elecArr.length - 1]?.standing_p_day
                          ?? (params.svt_standing_charge_p ?? PE_CONFIG.ELEC_STANDING_DEFAULT_P_DAY);
```

The user-supplied `params.gas_standing_charge_p` and `params.svt_standing_charge_p` override
tariff-derived values when the user edits them in the UI. Since Phase A pre-populates inputs
from tariff data, overrides should only diverge when the user has manually changed them.

For this initial implementation, always use the most-recent tariff period's `standing_p_day`
and ignore the UI override at Phase A time. The UI inputs are pre-populated from tariff data
and the user can change them to explore "what if" scenarios — those changes feed Phase B
directly (Phase B reads `params.gas_standing_charge_p` and `params.svt_standing_charge_p`).

**Data period days:**
```javascript
const data_period_days = new Set(
  ingestion.consumption.map(r => r.timestamp.slice(0, 10))
).size;
```

If `data_period_days === 0`: set all rate arrays to empty, all outputs null, add error to
warnings. Return immediately.

If `data_period_days < PE_CONFIG.MIN_DAYS_WARN`: add warning
`'Less than 3 months of data — annual cost estimates may be unreliable.'`

**Return:**
```javascript
return {
  gas_rate_by_hh,
  elec_hh_rate_by_hh,
  svt_rate_p_per_kwh:             params.svt_rate_p_per_kwh ?? PE_CONFIG.SVT_RATE_DEFAULT_P,
  gas_standing_charge_p_per_day:  gas_standing_p_day,
  elec_standing_charge_p_per_day: elec_standing_p_day,
  data_period_days,
  consumption: ingestion.consumption,  // needed by computeCosts for monthly grouping
  warnings,
};
```

#### 1d. `computeCosts(rateMetadata, scenarioResult, params)` — Phase B

Inputs:
- `rateMetadata` from Phase A
- `scenarioResult` from `getScenarioConsumptionResult()`:
  `{ scenarios, validation_status, warnings }`
- `params`: `{ svt_rate_p_per_kwh, svt_standing_charge_p, gas_standing_charge_p }`

The standing charges to apply come from `params` (user-overridable), defaulting to
`rateMetadata.gas_standing_charge_p_per_day` and
`rateMetadata.elec_standing_charge_p_per_day` when params are absent.

Effective standing charges (resolved once):
```javascript
const pricingWarnings = [];   // declare before any push calls
const gasSc   = params.gas_standing_charge_p  ?? rateMetadata.gas_standing_charge_p_per_day;
const elecSc  = params.svt_standing_charge_p  ?? rateMetadata.elec_standing_charge_p_per_day;
const svtRate = params.svt_rate_p_per_kwh     ?? rateMetadata.svt_rate_p_per_kwh;
```

Pre-compute month groupings once (reused for every scenario):
```javascript
// monthGroups: Map<'YYYY-MM', { indices: number[], distinctDates: number, partial: boolean }>
const monthGroups = buildMonthGroups(rateMetadata.consumption);
```

`buildMonthGroups(consumption)`: iterate `consumption`, group index `i` by
`timestamp.slice(0, 7)`. For each month, count distinct `timestamp.slice(0, 10)` values.
`partial = distinctDates < PE_CONFIG.PARTIAL_MONTH_DAY_THRESHOLD`.

For each scenario name in `['current', 'dumb_hp_svt', 'dumb_hp_hh', 'hybrid_dumb', 'smart_hp_hh', 'hybrid_smart']`:

**Null passthrough check:**
If `validation_status.smart !== 'ok'` AND scenario is `smart_hp_hh` or `hybrid_smart`:
```javascript
scenarioCosts[name] = {
  annual_cost_gbp:      null,
  energy_cost_gbp:      null,
  gas_energy_cost_gbp:  null,
  elec_energy_cost_gbp: null,
  standing_charge_gbp:  null,
  monthly_breakdown:    null,
  fuels_supplied:        SCENARIO_FUELS[name],
  electricity_rate_type: SCENARIO_ELEC_RATE_TYPE[name],
};
continue;
```

**Energy cost — HH loop:**
```javascript
let gas_pence  = 0;
let elec_pence = 0;
const { gas_kwh, elec_kwh } = scenarios[name];
for (let i = 0; i < gas_kwh.length; i++) {
  const g = gas_kwh[i]  ?? 0;
  const e = elec_kwh[i] ?? 0;
  gas_pence  += g * rateMetadata.gas_rate_by_hh[i];
  elec_pence += e * electricityRateForHH(name, i, rateMetadata, svtRate);
}
const gas_energy_cost_gbp  = gas_pence  / 100;
const elec_energy_cost_gbp = elec_pence / 100;
const energy_cost_gbp      = gas_energy_cost_gbp + elec_energy_cost_gbp;
```

`electricityRateForHH(scenario, i, rateMetadata, svtRate)`:
- `current`: return `0`
- `dumb_hp_svt`: return `svtRate`
- all others: return `rateMetadata.elec_hh_rate_by_hh[i]`
  (never null after Phase A — null wholesale → hh_overhead floor was applied)

**Standing charges (raw data period):**
```javascript
const fuels = SCENARIO_FUELS[name];
const sc_pence_per_day = (fuels.includes('gas') ? gasSc : 0)
                       + (fuels.includes('electricity') ? elecSc : 0);
const standing_charge_gbp = sc_pence_per_day * rateMetadata.data_period_days / 100;
```

**Annual scaling:**
```javascript
const scale = 365 / rateMetadata.data_period_days;
const annual_cost_gbp = (energy_cost_gbp + standing_charge_gbp) * scale;
```

**Monthly breakdown:**
For each `[month, group]` in `monthGroups`:
- Sum `monthly_energy_pence` for HH periods in `group.indices` using the same gas/elec rate
  lookup as the annual loop (`gas_pence_m + elec_pence_m`). The monthly loop uses a local
  `monthly_energy_pence` variable (not the outer `gas_pence`/`elec_pence`) to avoid confusion.
- `monthly_sc_gbp = sc_pence_per_day * group.distinctDates / 100`
- `{ month, energy_cost_gbp: monthly_energy_pence/100, standing_charge_gbp: monthly_sc_gbp, total_gbp: sum, partial: group.partial }`

**Consistency check (Test 8):**
The sum of monthly `energy_cost_gbp` across all months must equal the total `energy_cost_gbp`
(before scaling). Both paths use the same `electricityRateForHH` helper and the same
`rateMetadata.gas_rate_by_hh` — the monthly loop iterates the same HH indices as the annual
loop, so consistency is structural. No explicit reconciliation needed.

**Assemble `scenarioCosts[name]` (non-null case):**
```javascript
scenarioCosts[name] = {
  annual_cost_gbp:      annual_cost_gbp,
  energy_cost_gbp:      energy_cost_gbp,
  gas_energy_cost_gbp:  gas_energy_cost_gbp,
  elec_energy_cost_gbp: elec_energy_cost_gbp,
  standing_charge_gbp:  standing_charge_gbp,
  monthly_breakdown:    monthly_breakdown,
  fuels_supplied:        SCENARIO_FUELS[name],
  electricity_rate_type: SCENARIO_ELEC_RATE_TYPE[name],
};
```

**Return:**
```javascript
return {
  scenarios: scenarioCosts,   // keyed by scenario name
  warnings: pricingWarnings,
};
```

---

### Step 2 — Modify `js/app.js`

#### 2a. Imports (add to existing import block)

```javascript
import {
  prepareRates, computeCosts,
  setRateMetadata, getRateMetadata,
  setPricingResult, getPricingResult,
  PE_CONFIG,
} from './pricing-engine.js';
```

Export `PE_CONFIG` from `pricing-engine.js` (so app.js can pre-populate input defaults).

#### 2b. DOM refs

```javascript
const pricingCard           = document.getElementById('pricing-card');
const pricingResults        = document.getElementById('pricing-results');
const pricingStatus         = document.getElementById('pricing-status');
const pricingSummary        = document.getElementById('pricing-summary');
const svtRateInput          = document.getElementById('svt-rate');
const elecStandingInput     = document.getElementById('elec-standing-charge');
const gasStandingInput      = document.getElementById('gas-standing-charge');
const hhOverheadInput       = document.getElementById('hh-overhead');
const btnRecalcPricing      = document.getElementById('btn-recalculate-pricing');
```

#### 2c. `readRateParams()` — private helper

```javascript
function parseRate(input, fallback) {
  const v = parseFloat(input.value);
  return isNaN(v) ? fallback : v;
}
function readRateParams() {
  return {
    svt_rate_p_per_kwh:    parseRate(svtRateInput,    PE_CONFIG.SVT_RATE_DEFAULT_P),
    svt_standing_charge_p: parseRate(elecStandingInput, PE_CONFIG.ELEC_STANDING_DEFAULT_P_DAY),
    gas_standing_charge_p: parseRate(gasStandingInput,  PE_CONFIG.GAS_STANDING_DEFAULT_P_DAY),
    hh_overhead_p_per_kwh: parseRate(hhOverheadInput,   PE_CONFIG.HH_OVERHEAD_DEFAULT_P),
  };
}
```

`parseRate` uses a NaN-only fallback so SVT rate = 0 is accepted (user may be testing
zero-cost electricity); `|| default` would incorrectly replace 0 with the default.
```

#### 2d. `displayPricingResults(pricingResult)`

Show the pricing card. For each scenario in display order
`['current', 'dumb_hp_svt', 'dumb_hp_hh', 'hybrid_dumb', 'smart_hp_hh', 'hybrid_smart']`:

Render a summary table with columns: Scenario, Annual energy cost (£), Standing charges
(£/yr), **Total (£/yr)**. Display names (British English):

| Key | Display name |
|-----|-------------|
| `current` | Current (gas boiler) |
| `dumb_hp_svt` | Heat pump — flat rate |
| `dumb_hp_hh` | Heat pump — HH rate |
| `hybrid_dumb` | Hybrid — HH rate |
| `smart_hp_hh` | Smart heat pump — HH rate |
| `hybrid_smart` | Smart hybrid — HH rate |

If `annual_cost_gbp === null`: display "—" with a note "Insufficient data for smart
scenarios" (shown once below the table, not per row).

Format all costs as `£X,XXX.XX` (two decimal places, thousands separator). Use
`toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`.

Append warnings from `rateMetadata.warnings` and `pricingResult.warnings` to
`pricingStatus` as `status-msg warning` divs.

#### 2e. `runPricingEngine(showProgressFn, showStatusFn)` — orchestration

```javascript
async function runPricingEngine(showProgressFn, showStatusFn) {
  const ingestion = getIngestionResult();
  const external  = getExternalResult();
  const scenarioResult = getScenarioConsumptionResult();

  if (!ingestion || !external) {
    showStatusFn('Ingestion or external data not available.', 'error');
    return;
  }
  if (!scenarioResult) {
    showStatusFn('Scenario consumption not yet computed.', 'error');
    return;
  }

  showProgressFn('Computing tariff rates…');
  const params = readRateParams();
  const rateMetadata = prepareRates(ingestion, external, params);
  setRateMetadata(rateMetadata);

  showProgressFn('Computing scenario costs…');
  const pricingResult = computeCosts(rateMetadata, scenarioResult, params);
  setPricingResult(pricingResult);

  displayPricingResults(pricingResult);

  for (const w of rateMetadata.warnings) showStatusFn(w, 'warning');
  for (const w of pricingResult.warnings) showStatusFn(w, 'warning');
}
```

#### 2f. Recalculate button listener

```javascript
btnRecalcPricing.addEventListener('click', async () => {
  btnRecalcPricing.disabled = true;
  pricingStatus.innerHTML   = '';
  pricingSummary.innerHTML  = '';
  pricingResults.classList.add('hidden');
  await runPricingEngine(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      pricingStatus.appendChild(div);
    }
  );
  btnRecalcPricing.disabled = false;
});
```

#### 2g. Pipeline wiring

M6 (`runHeatPumpModel`) is already wired into both pipelines. M7 (`runScenarioConsumption`)
will be wired when M7 is implemented. Add `runPricingEngine` immediately after the M7 call:

```javascript
await runScenarioConsumption(showProgressFn, showStatusFn);  // M7 — already present when M8 is implemented
await runPricingEngine(showProgressFn, showStatusFn);        // M8
```

Apply in both the Octopus pipeline (after the existing M6 call) and the CSV pipeline
(same position). Do not add M8 before M7 is wired — M8 requires M7's output.

#### 2h. Pre-populate rate input defaults

After ingestion result is stored (at the end of the Octopus and CSV success paths, before
the M2 pipeline call), pre-populate the rate inputs from tariff data:

```javascript
function prefillRateInputs(tariffRates) {
  const gasArr  = tariffRates.gas;
  const elecArr = tariffRates.electricity;
  if (gasArr.length)  gasStandingInput.value  = (gasArr[gasArr.length - 1].standing_p_day).toFixed(2);
  if (elecArr.length) elecStandingInput.value = (elecArr[elecArr.length - 1].standing_p_day).toFixed(2);
  // SVT rate and HH overhead remain at HTML defaults (Ofgem cap values)
}
```

Call `prefillRateInputs(ingestionResult.tariff_rates)` at both pipeline ingestion points
(after `setIngestionResult(...)` in the Octopus path, and after `setIngestionResult(...)`
in the CSV path).

#### 2i. Debug export

```javascript
window.__getRateMetadata  = () => getRateMetadata();
window.__getPricingResult = () => getPricingResult();
```

Add alongside the existing `window.__get*` exports at the bottom of `app.js`.

---

### Step 3 — Modify `index.html`

#### 3a. Pricing parameters card

Add a new card (id: `pricing-params-card`) in the "Your Analysis" section, after the
`thermal-char-card`. Show it when data is loaded (initially `hidden`).

```html
<div id="pricing-params-card" class="card hidden">
  <h2>Pricing Parameters</h2>
  <p class="card-intro">Rates default to the Ofgem Q2 2026 price cap. Adjust to explore
  different tariff scenarios.</p>
  <div class="params-grid">
    <label for="svt-rate">Flat electricity rate (Ofgem Q2 2026 cap)
      <span class="unit">p/kWh</span></label>
    <input id="svt-rate" type="number" step="0.01" min="0"
           value="24.50">

    <label for="elec-standing-charge">Electricity standing charge (Q2 2026)
      <span class="unit">p/day</span></label>
    <input id="elec-standing-charge" type="number" step="0.01" min="0"
           value="61.64">

    <label for="gas-standing-charge">Gas standing charge (Q2 2026)
      <span class="unit">p/day</span></label>
    <input id="gas-standing-charge" type="number" step="0.01" min="0"
           value="31.66">

    <label for="hh-overhead">HH tariff overhead (network + levies + margin)
      <span class="unit">p/kWh</span></label>
    <input id="hh-overhead" type="number" step="0.01"
           value="13.00">
  </div>
</div>
```

HTML default values are the `PE_CONFIG` defaults. The `prefillRateInputs()` call (Step 2h)
will override standing charge defaults from the user's actual tariff data at runtime. SVT
rate and HH overhead always stay at the cap defaults unless the user changes them.

#### 3b. Pricing results card

Add immediately after `pricing-params-card`:

```html
<div id="pricing-card" class="card hidden">
  <h2>Scenario Costs</h2>
  <div id="pricing-status"></div>
  <div id="pricing-results" class="hidden">
    <div id="pricing-summary"></div>
  </div>
  <button id="btn-recalculate-pricing" class="btn-secondary hidden">Recalculate costs</button>
</div>
```

The recalculate button starts hidden. Show it once the pricing card has been populated at
least once (add `.classList.remove('hidden')` to `btnRecalcPricing` inside
`displayPricingResults`).

---

## Scope decisions

**SD1 — Phase A and Phase B both run after M7.** The design doc describes Phase A running
before M7 so M7 can use the overhead-adjusted rates for dispatch. However, the M7 approved
plan explicitly uses raw wholesale prices for dispatch (scope decision 1, accepted by Opus
review 2026-04-27). Phase A's `elec_hh_rate_by_hh` is therefore not needed by M7 and can
run after M7 without loss of correctness. Simpler orchestration, no functional difference.

**SD2 — Standing charges in `prepareRates` use tariff data directly; `params` overrides
apply in `computeCosts` only.** This separates the "what did you actually pay" (Phase A)
from "what if you changed to this tariff" (Phase B). The user-edited inputs affect Phase B
costs without affecting the rate arrays in Phase A (the overhead is still applied correctly
regardless of standing charge edits).

**SD3 — `prefillRateInputs` populates standing charges from tariff data; SVT and overhead
remain at Ofgem cap defaults.** SVT rate and HH overhead have no direct equivalent in the
user's Octopus tariff data. The Ofgem Q2 2026 cap values are correct defaults for a user
on the default tariff. There is no single "right" value to derive from M1 for these.

**SD4 — Monthly breakdown `partial` threshold is 20 days (matching design doc).** Months
with < 20 days of actual consumption data are flagged `partial: true`. These are typically
the first and last calendar months of the data period.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Gas tariff gap produces zero cost for affected HH periods | Use nearest window + warn; test T1 (time-varying tariff lookup) |
| `dumb_hp_svt` receives HH rate instead of SVT flat rate | Isolated `electricityRateForHH()` helper; T5 directly tests this |
| Negative wholesale prices silently clamped | No clamping anywhere in Phase A; T3 verifies negative price passes through |
| Smart scenario annual_cost incorrectly shows £0 rather than null | Explicit null passthrough gate on `validation_status.smart`; T10 covers this |
| Annual scaling applied to standing charges twice (once raw, once in scale factor) | Standing charges computed raw for the data period, then scaled once by `365 / data_period_days`; T7 verifies |
| Monthly breakdown sums differ from annual total | Both paths use identical HH loop with `electricityRateForHH`; structural consistency |
| `prefillRateInputs` called before DOM ready | Call only after ingestion result stored, which occurs inside async event handlers after DOM is interactive |

---

## Success criteria

### Core computation

- [x] **T1: Time-varying gas rate.** Three tariff periods: Jan–Mar at 7.0 p/kWh, Apr–Jun at
  7.5 p/kWh, Jul+ at 6.8 p/kWh. HH timestamp in May → `gas_rate_by_hh[i] = 7.5`.
  HH timestamp in August → `gas_rate_by_hh[i] = 6.8`. (Design doc test 1.)
  ✅ Node test-m8.mjs T1a/T1b — 2026-04-27.

- [x] **T2: HH rate construction.** `wholesale_p_kwh = 5.0`, `hh_overhead = 13.0` →
  `elec_hh_rate_by_hh[i] = 18.0`. Null wholesale → `elec_hh_rate_by_hh[i] = 13.0`.
  (Design doc test 2.)
  ✅ Node test-m8.mjs T2a/T2b/T2c — 2026-04-27.

- [x] **T3: Negative wholesale passthrough.** `wholesale_p_kwh = −5.0`, `hh_overhead = 13.0`
  → `elec_hh_rate_by_hh[i] = 8.0`. Fails if clamped to 13.0.
  (Design doc test 3.)
  ✅ Node test-m8.mjs T3 — 2026-04-27.

- [x] **T4: Standing charge — fuel supply logic.** `dumb_hp_svt`: gas standing charge = £0/yr.
  `hybrid_dumb`: both standing charges included.
  (Design doc test 4.)
  ✅ Node test-m8.mjs T4a/T4b (365-day zero-consumption dataset; gasSc=30, elecSc=60) — 2026-04-27.

- [x] **T5: Energy cost — dumb_hp_svt.** `elec_kwh[i] = 2.0`, `svt_rate = 24.50` →
  energy cost = £0.49 for that HH. HH rate not applied.
  (Design doc test 5.)
  ✅ Node test-m8.mjs T5 (wholesale=100 → HH rate=113; verified SVT used not HH rate) — 2026-04-27.

- [x] **T6: Energy cost — dumb_hp_hh.** `elec_kwh[i] = 2.0`, `elec_hh_rate_by_hh[i] = 18.0`
  → energy cost = £0.36.
  (Design doc test 6.)
  ✅ Node test-m8.mjs T6a/T6b — 2026-04-27.

- [x] **T7: Annual scaling.** 300-day window, energy = £500, standing = £100 →
  `annual_cost_gbp = 600 × 365/300 = £730`.
  (Design doc test 7.)
  ✅ Node test-m8.mjs T7a/T7b (300-day window, energy=£30, standing=0 → annual=£36.50; same scale formula verified) — 2026-04-27.

- [x] **T8: Monthly sum = annual (unscaled).** Sum of monthly `total_gbp` across all months
  equals `energy_cost_gbp + standing_charge_gbp` (unscaled). Checked by inspecting the
  pricing result object in browser devtools.
  (Design doc test 8.)
  ✅ Node test-m8.mjs T8a/T8b/T8c (Jan+Feb 2025, 2832 HH; monthly energy, standing, and total sums each verified to ±1e-6) — 2026-04-27.

- [x] **T9: Partial month flag.** Data from 15-Apr: first April (15 days) → `partial: true`.
  Last April (15 days) → `partial: true`. Full months between → `partial: false`.
  (Design doc test 9.)
  ✅ Node test-m8.mjs T9a/T9b/T9c (Apr 16d → partial, May 31d → full, Jun 10d → partial) — 2026-04-27.

- [x] **T10: Null scenario passthrough.** `validation_status.smart = 'insufficient_data'` →
  `smart_hp_hh.annual_cost_gbp = null`. Other scenarios unaffected.
  (Design doc test 10.)
  ✅ Node test-m8.mjs T10a/T10b/T10c/T10d — 2026-04-27.

### UI and integration

- [ ] **T11: Pricing card visible** — card renders after M8 runs; summary table shows all 6
  scenarios with correct display names.

- [ ] **T12: Recalculate button** — changing SVT rate and clicking Recalculate produces a
  different annual total for `dumb_hp_svt`; other HH-rate scenarios unchanged.

- [ ] **T13: Standing charge override** — editing the gas standing charge and recalculating
  changes `hybrid_dumb` and `hybrid_smart` annual totals (which include gas standing charge)
  but not `dumb_hp_svt` (electricity-only scenario).

- [ ] **T14: prefill from tariff data** — on Octopus path, standing charge inputs are
  pre-populated from M1's most recent tariff period rather than hardcoded defaults (visible
  in the input fields after data loads).

- [ ] **T15: SVT vs HH cost ordering (design doc test 11)** — with Rhiannon's real data,
  `dumb_hp_hh.annual_cost_gbp ≤ dumb_hp_svt.annual_cost_gbp` when mean HH rate is below
  `(SVT_rate − overhead)`. Verify ordering makes directional sense.

---

## Design Review — 2026-04-27

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Review date:** 2026-04-27
**Design doc reviewed:** `pricing-engine.md` (praxis-claude-hub)

---

### Scope decisions — accepted as stated

All four scope decisions are correct. Formally accepted:

1. **SD1 — Phase A and B both run after M7.** M7's approved dispatch uses raw wholesale;
   M8's overhead-adjusted rate is not needed by M7. Running both phases after M7 is simpler
   with no correctness cost. ✓
2. **SD2 — Standing charges from tariff data in Phase A; params overrides in Phase B only.** ✓
3. **SD3 — SVT rate and HH overhead at Ofgem cap defaults; standing charges pre-filled from
   tariff data.** Correct — no per-user equivalent for SVT rate in M1 output. ✓
4. **SD4 — Monthly partial threshold = 20 days.** Matches design doc. ✓

---

### What is solid

- **`SCENARIO_FUELS` and `SCENARIO_ELEC_RATE_TYPE` lookup tables.** All six scenarios
  correctly encoded. The table-driven design avoids per-scenario conditional branches in the
  HH loop, making the standing-charge and rate logic easy to audit against the design doc. ✓

- **`electricityRateForHH` helper isolates the only per-scenario branching.** SVT vs HH
  dispatch logic lives in one place; T5 directly tests it. ✓

- **Negative wholesale passthrough.** No clamp in the HH rate construction. T3 explicitly
  verifies this. Critical for smart scenarios to exploit near-zero/negative price windows. ✓

- **Gap tariff handling.** `findLast` fallback to nearest window + warning is correct
  behaviour. The warning fires only once per Phase A run. ✓

- **Phase A/B separation.** `prepareRates` (Phase A) builds rate arrays once; `computeCosts`
  (Phase B) reuses them. Recalculating Phase B when only the SVT rate changes avoids
  rebuilding the 17,520-entry arrays unnecessarily. ✓

- **Monthly breakdown structural consistency.** Both the annual loop and the monthly loop
  use the same `electricityRateForHH` helper and the same `rateMetadata.gas_rate_by_hh`.
  The plan correctly notes consistency is structural — no explicit reconciliation needed. ✓

- **M1 field name corrections.** The Research Findings table accurately corrects the
  design doc's field names (`tariff_rates.gas`, `rate_p_kwh`, `standing_p_day`, etc.)
  against the live code. Sonnet must use the plan's corrected names throughout. ✓

---

### Required changes before implementation

**MEDIUM — §1d: `computeCosts` calls `buildMonthGroups(ingestion.consumption)` but
`ingestion` is not in the function signature**

`computeCosts(rateMetadata, scenarioResult, params)` has no access to
`ingestion.consumption`. The call `buildMonthGroups(ingestion.consumption)` would throw
a ReferenceError at runtime.

Fix: in `prepareRates` (§1c), add consumption timestamps to the return value:

```javascript
return {
  gas_rate_by_hh,
  elec_hh_rate_by_hh,
  svt_rate_p_per_kwh: ...,
  gas_standing_charge_p_per_day: gas_standing_p_day,
  elec_standing_charge_p_per_day: elec_standing_p_day,
  data_period_days,
  consumption: ingestion.consumption,  // ← ADD: needed by computeCosts for monthly grouping
  warnings,
};
```

Then in `computeCosts`, call `buildMonthGroups(rateMetadata.consumption)`.
This keeps `computeCosts`'s signature unchanged.

---

### Minor observations (not blockers)

1. **LOW — `const warnings = [];` missing from `prepareRates` pseudo-code.** The return
   statement includes `warnings` and `warnings.push(...)` is called in the body, but no
   declaration is shown. Must declare at the top of `prepareRates`. The pattern is
   consistent with all previous modules.

2. **LOW — `const pricingWarnings = [];` missing from `computeCosts` pseudo-code.** Same
   issue — used in return and body but not declared. Must be added.

3. **LOW — `const hh_overhead = ...` declared inside the 17,520-iteration loop.** Hoist
   outside: `const hh_overhead = params.hh_overhead_p_per_kwh ?? PE_CONFIG.HH_OVERHEAD_DEFAULT_P;`
   before the loop.

4. **LOW — `parseFloat(...) || default` rejects user input of 0 in `readRateParams`.** The
   design doc explicitly requires SVT rate = 0 to be accepted ("user may be testing"). Use
   a NaN-only fallback: `(v => isNaN(v) ? fallback : v)(parseFloat(input.value))`. Apply
   to all four inputs in `readRateParams`.

5. **LOW — §2g comment-line instruction will be stale by implementation time.** M6 and M7
   are already approved and will be wired before M8 is implemented. Update §2g to: "Add
   `await runPricingEngine(...)` immediately after the existing `runScenarioConsumption(...)`
   call in both pipelines."

---

## Approval

**Status:** ✅ Approved — 2026-04-27 (re-reviewed after Sonnet edits)
**Approved by:** Rhiannon (via Opus review)

All required changes applied and verified:
- **§1c/§1d** — `consumption: ingestion.consumption` in `rateMetadata`; `buildMonthGroups(rateMetadata.consumption)`. ✓
- `warnings` and `pricingWarnings` declarations added. ✓
- `hh_overhead` hoisted outside loop. ✓
- `parseRate` helper replaces `||` pattern. ✓
- §2g updated to explicit wiring instruction. ✓

**Additional change (commit 7487b05):** `ScenarioCost` now exposes `gas_energy_cost_gbp` and
`elec_energy_cost_gbp` separately. Sound enhancement; design doc deviation to record after
implementation.

**Trivial artefact:** stray triple-backtick fence after `parseRate` commentary in §2c. Does
not affect implementation.

---

## Implementation Deviations

**D1 — `btn-secondary` replaced with `btn btn-primary`.**
The plan specifies `class="btn-secondary hidden"` for the Recalculate costs button. No `.btn-secondary`
rule exists in `styles.css` — the project uses only `.btn` + `.btn-primary`. Changed to
`class="btn btn-primary hidden"` to match all other module buttons and avoid an unstyled element.

**D2 — CSS classes added to `styles.css`.**
The plan's HTML references `.card-intro`, `.params-grid`, and `.unit` classes but includes no
corresponding CSS update. Added minimal CSS for all three to `styles.css` immediately before the
existing Energy Summary Table section. No existing rules affected.

**D3 — `energy-summary-table` CSS class reused for pricing table.**
`displayPricingResults` uses `class="energy-summary-table"` for the scenario costs table.
`energy-summary-table` provides the correct column alignment (left first, right others) and is
generic in its implementation. No `pricing-summary-table` class was required.

**D4 — `ScenarioCost` exposes `gas_energy_cost_gbp` and `elec_energy_cost_gbp` separately.**
Noted as additional change in plan Approval section (commit 7487b05 on Opus side). Implemented
as specified — both fields are computed and included in each non-null scenario cost object.
