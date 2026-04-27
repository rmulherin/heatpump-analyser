# Module 9 — Financial Analysis

**Date:** 2026-04-27
**Status:** ✅ Approved — 2026-04-27
**Depends on:**
- `docs/plans/m8-pricing-engine.md` — must be ✅ Approved AND merged. M9 reads
  `getPricingResult().scenarios[name]` and `getRateMetadata()`.
- `docs/plans/m7-scenario-consumption.md` — must be ✅ Approved AND merged. M9 reads
  `getScenarioConsumptionResult().scenarios.current.gas_kwh[]` and `.dumb_hp_svt.elec_kwh[]`
  for break-even energy totals.

---

## Task description

Implement `js/financial.js` — converts M8's per-scenario annual costs into the investment
decision metrics: annual saving vs boiler, net investment after grant, payback period,
5×5 price-sensitivity grid, 5-point COP sensitivity, and a break-even interpretation
string. No energy calculations — purely arithmetic on M8's cost outputs and
user-supplied capital cost inputs.

Adds a capital cost input card and a financial summary card to the UI. Sensitivity
data structures are populated here; charts and heatmaps are rendered by M10.

Design doc:
`~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/financial-analysis.md`

---

## Research findings

### Required M8 amendment — cost decomposition

The design doc states: "M8 must decompose `annual_cost_gbp` into `gas_energy_cost_gbp`
and `elec_energy_cost_gbp` (in addition to `standing_charge_gbp`) so M9 can rescale them
independently" for the sensitivity grid.

The current M8 plan (`m8-pricing-engine.md`) exposes only a single `energy_cost_gbp` field
per scenario. **The M8 plan must be amended** to track gas and electricity cost components
separately in the Phase B HH loop and add them to `ScenarioCost`:

```javascript
// Add to ScenarioCost (data-period values, pre-annual-scaling):
gas_energy_cost_gbp:  number | null,   // sum(gas_kwh[i] × gas_rate_by_hh[i]) / 100
elec_energy_cost_gbp: number | null,   // sum(elec_kwh[i] × elec_rate(i)) / 100
```

`energy_cost_gbp` in the current M8 plan = `gas_energy_cost_gbp + elec_energy_cost_gbp`
(unchanged). Adding the decomposition is a one-line split in the existing HH loop.

**This amendment is a prerequisite for M9 implementation.** The reviewer should add
it as a required change in the M8 review.

### Break-even formula — design doc discrepancy

The design doc break-even formula mixes data-period gas energy with annual standing charges,
which is dimensionally inconsistent. This plan uses consistent data-period values throughout.

**Design doc formula (inconsistent):**
```
svt_rate_breakeven_p = (gas_total × 100 + gas_sc_annual_pence − elec_sc_annual_pence) / elec_kwh_total_hp
```
where `gas_total` is data-period £ but standing charges are annual pence.

**Correct derivation (break-even condition over data period):**

Current heating cost (data period) = HP SVT heating cost (data period):
```
gas_energy_dp_pence + gas_sc_dp_pence + elec_sc_dp_pence
  = elec_kwh_total_hp × svt_rate_be_p / 100 + elec_sc_dp_pence
```
Elec standing charges cancel (both scenarios pay elec SC):
```
svt_rate_breakeven_p = (gas_energy_dp_pence + gas_sc_dp_pence) / elec_kwh_total_hp
```

Where:
- `gas_energy_dp_pence` = `M8_current.energy_cost_gbp × 100` (data-period gas energy in pence;
  valid because "current" has `elec_kwh = 0` for heating, so `energy_cost_gbp` = gas only)
- `gas_sc_dp_pence` = `rate_metadata.gas_standing_charge_p_per_day × data_period_days`
- `elec_kwh_total_hp` = `sum(dumb_hp_svt.elec_kwh[i])` (kWh over data period; from M7)

Gas rate at break-even (electricity held at current SVT rate):
```
gas_breakeven_p = (elec_kwh_total_hp × current_svt_p − gas_sc_dp_pence) / gas_kwh_total_heating
```
Where `gas_kwh_total_heating = sum(current.gas_kwh[i] ?? 0)`.

If `gas_sc_dp_pence` is large relative to the numerator (unusual but theoretically possible
if the data period is very short), `gas_breakeven_p` may be negative. Clamp to `null` and
omit the gas break-even line from the interpretation string.

### Sensitivity grid — linear rescaling

The 5×5 grid rescales M8's annual-scaled cost components (not data-period). Use
`annual_cost_gbp` and the decomposed fields, annualised:

```
gas_energy_annual_gbp  = M8.gas_energy_cost_gbp  × (365 / data_period_days)
elec_energy_annual_gbp = M8.elec_energy_cost_gbp × (365 / data_period_days)
standing_annual_gbp    = M8.standing_charge_gbp   × (365 / data_period_days)
```

For each grid point `(gas_mult, elec_mult)`:
```
scaled_annual = gas_energy_annual × gas_mult
              + elec_energy_annual × elec_mult
              + standing_annual           // unchanged
scaled_saving  = current_scaled_annual − scenario_scaled_annual
scaled_payback = net_investment / scaled_saving  (null if scaled_saving ≤ 0)
```

For COP axis `cop_mult`:
```
scaled_annual = gas_energy_annual × 1.0
              + elec_energy_annual × (1.0 / cop_mult)   // lower COP → more electricity
              + standing_annual
```

Note: this approximation is exact for SVT scenarios (linear in rates, dispatch unchanged)
and approximate for HH/smart scenarios (dispatch was optimised at base prices; would shift
with changed prices). The design doc accepts this approximation.

### No external library needed

All arithmetic is plain JS. No new CDN entries.

### Scenario investment mapping

| Scenario | Net investment |
|----------|---------------|
| dumb_hp_svt | full HP |
| dumb_hp_hh | full HP |
| smart_hp_hh | full HP |
| hybrid_dumb | hybrid |
| hybrid_smart | hybrid |

"current" is the baseline — no investment, no payback calculation.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `js/financial.js` | `analyseFinancials()`, module state |
| MODIFY | `js/app.js` | Import, DOM refs, `readCapitalParams()`, `runFinancialAnalysis()`, `displayFinancialResults()`, recalculate button, pipeline comment marker, debug export |
| MODIFY | `index.html` | Capital cost inputs card, financial summary card |

---

## Implementation steps

### Step 1 — Create `js/financial.js`

#### 1a. Constants

```javascript
const FA_CONFIG = {
  INSTALLATION_FULL_HP_DEFAULT_GBP: 12_500,
  INSTALLATION_HYBRID_DEFAULT_GBP:  10_000,
  BUS_GRANT_DEFAULT_GBP:             7_500,
  AVOIDED_AC_DEFAULT_GBP:                0,
  GAS_MULTIPLIERS:  [0.7, 0.85, 1.0, 1.2, 1.5],
  ELEC_MULTIPLIERS: [0.7, 0.85, 1.0, 1.2, 1.5],
  COP_MULTIPLIERS:  [0.7, 0.85, 1.0, 1.15, 1.3],
  AVOIDED_AC_LARGE_FRACTION: 0.5,  // warn if avoided_ac > installation × this
};

const HP_SCENARIOS = ['dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh', 'hybrid_dumb', 'hybrid_smart'];
const FULL_HP_SCENARIOS = ['dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh'];
const HYBRID_SCENARIOS  = ['hybrid_dumb', 'hybrid_smart'];
```

#### 1b. State management

```javascript
let _financialResult = null;
export function setFinancialResult(r) { _financialResult = r; }
export function getFinancialResult()  { return _financialResult; }
```

#### 1c. `analyseFinancials(pricingResult, rateMetadata, scenarioResult, params)`

Inputs:
- `pricingResult` from `getPricingResult()`: `{ scenarios, warnings }`
- `rateMetadata` from `getRateMetadata()`: `{ gas_standing_charge_p_per_day, elec_standing_charge_p_per_day, svt_rate_p_per_kwh, data_period_days, ... }`
- `scenarioResult` from `getScenarioConsumptionResult()`: `{ scenarios, validation_status }`
- `params`: `{ installation_cost_full_hp_gbp, installation_cost_hybrid_gbp, bus_grant_gbp, avoided_ac_cost_gbp }`

##### Step A — Net investment

```javascript
const { installation_cost_full_hp_gbp, installation_cost_hybrid_gbp,
        bus_grant_gbp, avoided_ac_cost_gbp } = params;

const deductions = bus_grant_gbp + avoided_ac_cost_gbp;
const net_full_hp = Math.max(0, installation_cost_full_hp_gbp - deductions);
const net_hybrid  = Math.max(0, installation_cost_hybrid_gbp  - deductions);

const warnings = [];
if (avoided_ac_cost_gbp > installation_cost_full_hp_gbp * FA_CONFIG.AVOIDED_AC_LARGE_FRACTION) {
  warnings.push(
    `Avoided AC cost of £${avoided_ac_cost_gbp.toLocaleString('en-GB')} is large relative to `
    + `the heat pump installation. Double-check this figure.`
  );
}

function netInvestmentFor(scenario) {
  return FULL_HP_SCENARIOS.includes(scenario) ? net_full_hp : net_hybrid;
}
```

##### Step B — Per-scenario saving and payback

```javascript
const current = pricingResult.scenarios.current;
const currentAnnual = current?.annual_cost_gbp ?? null;

const scenarioResults = {};
for (const name of HP_SCENARIOS) {
  const s = pricingResult.scenarios[name];
  const sAnnual = s?.annual_cost_gbp ?? null;
  const netInv  = netInvestmentFor(name);

  let annual_saving_gbp, payback_years, payback_status;

  if (currentAnnual === null || sAnnual === null) {
    annual_saving_gbp = null;
    payback_years     = null;
    payback_status    = 'no_data';
  } else {
    annual_saving_gbp = currentAnnual - sAnnual;
    if (annual_saving_gbp <= 0) {
      payback_years  = null;
      payback_status = 'no_saving';
    } else if (netInv === 0) {
      payback_years  = 0;
      payback_status = 'positive';
    } else {
      payback_years  = netInv / annual_saving_gbp;
      payback_status = 'positive';
    }
  }

  scenarioResults[name] = {
    annual_cost_gbp:    sAnnual,
    annual_saving_gbp,
    net_investment_gbp: netInv,
    payback_years,
    payback_status,
  };
}

// Include current in output for display convenience
scenarioResults.current = {
  annual_cost_gbp:    currentAnnual,
  annual_saving_gbp:  0,
  net_investment_gbp: 0,
  payback_years:      null,
  payback_status:     'no_data',
};

// All-no-saving warning
const allNoSaving = HP_SCENARIOS.every(
  n => scenarioResults[n].payback_status !== 'positive'
     && scenarioResults[n].payback_status !== 'no_data'
);
if (allNoSaving) {
  warnings.push(
    'Based on current rates and your heating profile, none of the heat pump scenarios saves '
    + 'money compared to your boiler. This may improve if gas prices rise or electricity prices fall.'
  );
}
```

##### Step C — Sensitivity grid

Pre-compute annual-scaled cost components for each HP scenario:
```javascript
function annualComponents(scenarioCost) {
  if (!scenarioCost?.gas_energy_cost_gbp == null && scenarioCost.gas_energy_cost_gbp === null) {
    return null;
  }
  const scale = 365 / rateMetadata.data_period_days;
  return {
    gas:      (scenarioCost.gas_energy_cost_gbp  ?? 0) * scale,
    elec:     (scenarioCost.elec_energy_cost_gbp ?? 0) * scale,
    standing: (scenarioCost.standing_charge_gbp  ?? 0) * scale,
  };
}
```

Correction: the null-check logic above has a bug. Use:
```javascript
function annualComponents(scenarioCost) {
  if (!scenarioCost || scenarioCost.annual_cost_gbp === null) return null;
  const scale = 365 / rateMetadata.data_period_days;
  return {
    gas:      (scenarioCost.gas_energy_cost_gbp  ?? 0) * scale,
    elec:     (scenarioCost.elec_energy_cost_gbp ?? 0) * scale,
    standing: (scenarioCost.standing_charge_gbp  ?? 0) * scale,
  };
}
```

Build components map once:
```javascript
const components = {};
for (const name of ['current', ...HP_SCENARIOS]) {
  components[name] = annualComponents(pricingResult.scenarios[name]);
}
```

5×5 price sensitivity grid:
```javascript
const grid = [];
for (const gas_mult of FA_CONFIG.GAS_MULTIPLIERS) {
  for (const elec_mult of FA_CONFIG.ELEC_MULTIPLIERS) {
    const currentScaled = components.current
      ? components.current.gas * gas_mult + components.current.elec * elec_mult + components.current.standing
      : null;

    let best_payback = null;
    let best_scenario = null;

    for (const name of HP_SCENARIOS) {
      const c = components[name];
      if (!c) continue;
      const scenarioScaled = c.gas * gas_mult + c.elec * elec_mult + c.standing;
      if (currentScaled === null) continue;
      const saving = currentScaled - scenarioScaled;
      if (saving <= 0) continue;
      const payback = netInvestmentFor(name) / saving;
      if (best_payback === null || payback < best_payback) {
        best_payback   = payback;
        best_scenario  = name;
      }
    }

    grid.push({ gas_multiplier: gas_mult, elec_multiplier: elec_mult,
                payback_years: best_payback, best_scenario });
  }
}
```

5-point COP sensitivity axis:
```javascript
const cop_axis = [];
for (const cop_mult of FA_CONFIG.COP_MULTIPLIERS) {
  let best_payback = null;
  for (const name of HP_SCENARIOS) {
    const c = components[name];
    if (!c || components.current === null) continue;
    // COP rescaling: electricity cost scales as 1/cop_mult (lower COP → more electricity)
    const scenarioScaled = c.gas * 1.0 + c.elec * (1.0 / cop_mult) + c.standing;
    const currentBase    = components.current.gas + components.current.elec + components.current.standing;
    const saving = currentBase - scenarioScaled;
    if (saving <= 0) continue;
    const payback = netInvestmentFor(name) / saving;
    if (best_payback === null || payback < best_payback) best_payback = payback;
  }
  cop_axis.push({ cop_multiplier: cop_mult, payback_years: best_payback });
}
```

##### Step D — Break-even analysis

```javascript
const currentM8 = pricingResult.scenarios.current;
const dumbHpSvtM7 = scenarioResult?.scenarios?.dumb_hp_svt;
const currentM7   = scenarioResult?.scenarios?.current;

let break_even = {
  dumb_hp_svt_break_even_elec_p_per_kwh: null,
  gas_to_elec_ratio_at_break_even: null,
  current_gas_to_elec_ratio: null,
  break_even_interpretation: null,
};

if (currentM8?.gas_energy_cost_gbp != null && dumbHpSvtM7 && currentM7) {
  const gas_energy_dp_pence = currentM8.gas_energy_cost_gbp * 100;

  const gas_sc_dp_pence =
    rateMetadata.gas_standing_charge_p_per_day * rateMetadata.data_period_days;

  const elec_kwh_total_hp =
    dumbHpSvtM7.elec_kwh.reduce((s, v) => s + (v ?? 0), 0);

  const gas_kwh_total_heating =
    currentM7.gas_kwh.reduce((s, v) => s + (v ?? 0), 0);

  if (elec_kwh_total_hp > 0 && gas_kwh_total_heating > 0) {
    const svt_be_p = (gas_energy_dp_pence + gas_sc_dp_pence) / elec_kwh_total_hp;

    const mean_gas_rate_p = gas_energy_dp_pence / gas_kwh_total_heating;
    const current_svt_p   = rateMetadata.svt_rate_p_per_kwh;

    const gas_sc_dp_pence_local = gas_sc_dp_pence;  // same variable
    const gas_be_p_raw = (elec_kwh_total_hp * current_svt_p - gas_sc_dp_pence_local)
                         / gas_kwh_total_heating;
    const gas_be_p = gas_be_p_raw > 0 ? gas_be_p_raw : null;

    const ratio_be      = svt_be_p > 0 ? mean_gas_rate_p / svt_be_p : null;
    const ratio_current = current_svt_p > 0 ? mean_gas_rate_p / current_svt_p : null;

    let interpretation = null;
    if (svt_be_p > 0) {
      interpretation =
        `On a standard flat electricity tariff, the heat pump breaks even when electricity `
        + `costs less than ${svt_be_p.toFixed(1)}p/kWh (currently ${current_svt_p.toFixed(1)}p/kWh)`;
      if (gas_be_p !== null) {
        interpretation += ` or when gas costs more than ${gas_be_p.toFixed(1)}p/kWh `
          + `(currently ${mean_gas_rate_p.toFixed(1)}p/kWh).`;
      } else {
        interpretation += '.';
      }
    }

    break_even = {
      dumb_hp_svt_break_even_elec_p_per_kwh: svt_be_p,
      gas_to_elec_ratio_at_break_even: ratio_be,
      current_gas_to_elec_ratio: ratio_current,
      break_even_interpretation: interpretation,
    };
  }
}
```

##### Step E — Assemble and return

```javascript
return {
  scenarios: scenarioResults,
  sensitivity: {
    grid,
    gas_multipliers:  FA_CONFIG.GAS_MULTIPLIERS,
    elec_multipliers: FA_CONFIG.ELEC_MULTIPLIERS,
    cop_axis,
    cop_multipliers:  FA_CONFIG.COP_MULTIPLIERS,
  },
  break_even,
  inputs_used: {
    installation_cost_full_hp_gbp: params.installation_cost_full_hp_gbp,
    installation_cost_hybrid_gbp:  params.installation_cost_hybrid_gbp,
    bus_grant_gbp:                 params.bus_grant_gbp,
    avoided_ac_cost_gbp:           params.avoided_ac_cost_gbp,
  },
  warnings,
};
```

---

### Step 2 — Modify `js/app.js`

#### 2a. Imports

```javascript
import {
  analyseFinancials,
  setFinancialResult,
  getFinancialResult,
  FA_CONFIG,
} from './financial.js';
```

Export `FA_CONFIG` from `financial.js` (for pre-populating input defaults in HTML).

#### 2b. DOM refs

```javascript
const financialParamsCard       = document.getElementById('financial-params-card');
const financialCard             = document.getElementById('financial-card');
const financialResults          = document.getElementById('financial-results');
const financialStatus           = document.getElementById('financial-status');
const financialSummary          = document.getElementById('financial-summary');
const installFullHpInput        = document.getElementById('install-full-hp');
const installHybridInput        = document.getElementById('install-hybrid');
const busGrantInput             = document.getElementById('bus-grant');
const avoidedAcInput            = document.getElementById('avoided-ac');
const btnRecalcFinancial        = document.getElementById('btn-recalculate-financial');
```

#### 2c. `readCapitalParams()` — private helper

```javascript
function readCapitalParams() {
  return {
    installation_cost_full_hp_gbp: parseFloat(installFullHpInput.value) || FA_CONFIG.INSTALLATION_FULL_HP_DEFAULT_GBP,
    installation_cost_hybrid_gbp:  parseFloat(installHybridInput.value) || FA_CONFIG.INSTALLATION_HYBRID_DEFAULT_GBP,
    bus_grant_gbp:                 parseFloat(busGrantInput.value)       || FA_CONFIG.BUS_GRANT_DEFAULT_GBP,
    avoided_ac_cost_gbp:           parseFloat(avoidedAcInput.value)      || FA_CONFIG.AVOIDED_AC_DEFAULT_GBP,
  };
}
```

Note: `avoided_ac_cost_gbp` default is 0, so `|| 0` would incorrectly return 0 for empty
input (which is the intended default). Use `isNaN(parseFloat(v)) ? default : parseFloat(v)`.

Correction — `readCapitalParams()` should use explicit NaN-safe parsing:
```javascript
function parseGbp(input, fallback) {
  const v = parseFloat(input.value);
  return isNaN(v) ? fallback : v;
}
function readCapitalParams() {
  return {
    installation_cost_full_hp_gbp: parseGbp(installFullHpInput, FA_CONFIG.INSTALLATION_FULL_HP_DEFAULT_GBP),
    installation_cost_hybrid_gbp:  parseGbp(installHybridInput,  FA_CONFIG.INSTALLATION_HYBRID_DEFAULT_GBP),
    bus_grant_gbp:                 parseGbp(busGrantInput,        FA_CONFIG.BUS_GRANT_DEFAULT_GBP),
    avoided_ac_cost_gbp:           parseGbp(avoidedAcInput,       FA_CONFIG.AVOIDED_AC_DEFAULT_GBP),
  };
}
```

#### 2d. `displayFinancialResults(result)`

Show `financialParamsCard`, `financialCard`, and `financialResults` (remove `hidden`).

Render a summary table with rows per scenario (display order and names as per M8 plan),
columns: Annual cost (£), Annual saving vs boiler (£), Net investment (£), Payback (years).

| Payback status | Display |
|----------------|---------|
| `positive` | `X.X years` (one decimal) |
| `no_saving` | "No saving" |
| `no_data` | "—" |
| `positive`, payback > 40 | ">40 years" |

Annual cost format: `£X,XXX.XX` (same as M8 — `toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`).

Annual saving: prefix with `+` if positive, `−` if negative. Show "—" for null.

Below the table, render the break-even interpretation string if non-null. Wrap in a
`<p class="break-even-text">` element.

Do not render sensitivity grid or COP charts here — M10 owns those. Store `result.sensitivity`
in the module state; M10 will read it via `getFinancialResult().sensitivity`.

Append warnings to `financialStatus` as `status-msg warning` divs.

Show `btnRecalcFinancial` (remove `hidden`).

#### 2e. `runFinancialAnalysis(showProgressFn, showStatusFn)` — orchestration

```javascript
async function runFinancialAnalysis(showProgressFn, showStatusFn) {
  const pricingResult   = getPricingResult();
  const rateMetadata    = getRateMetadata();
  const scenarioResult  = getScenarioConsumptionResult();

  if (!pricingResult || !rateMetadata) {
    showStatusFn('Pricing data not yet computed.', 'error');
    return;
  }
  if (!scenarioResult) {
    showStatusFn('Scenario consumption not available.', 'error');
    return;
  }

  showProgressFn('Computing financial analysis…');
  const params = readCapitalParams();
  const result = analyseFinancials(pricingResult, rateMetadata, scenarioResult, params);
  setFinancialResult(result);

  displayFinancialResults(result);

  for (const w of result.warnings) showStatusFn(w, 'warning');
}
```

#### 2f. Recalculate button listener

```javascript
btnRecalcFinancial.addEventListener('click', async () => {
  btnRecalcFinancial.disabled = true;
  financialStatus.innerHTML   = '';
  financialSummary.innerHTML  = '';
  financialResults.classList.add('hidden');
  await runFinancialAnalysis(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      financialStatus.appendChild(div);
    }
  );
  btnRecalcFinancial.disabled = false;
});
```

#### 2g. Pipeline wiring — forward declaration

Immediately after the `await runPricingEngine(...)` call, add:

```javascript
// M9: await runFinancialAnalysis(showProgressFn, showStatusFn);
```

in both the Octopus and CSV pipelines. This is uncommented when M9 is wired into the pipeline.

#### 2h. Debug export

```javascript
window.__getFinancialResult = () => getFinancialResult();
```

---

### Step 3 — Modify `index.html`

#### 3a. Capital cost inputs card

Add after `pricing-card` (or `pricing-params-card`). Initially `hidden`.

```html
<div id="financial-params-card" class="card hidden">
  <h2>Installation Costs</h2>
  <p class="card-intro">Defaults reflect typical UK 2025–2026 market rates and the
  current Boiler Upgrade Scheme grant. Adjust for your own quotes.</p>
  <div class="params-grid">
    <label for="install-full-hp">Full heat pump installation
      <span class="unit">£</span></label>
    <input id="install-full-hp" type="number" step="100" min="0"
           value="12500">

    <label for="install-hybrid">Hybrid heat pump installation
      <span class="unit">£</span></label>
    <input id="install-hybrid" type="number" step="100" min="0"
           value="10000">

    <label for="bus-grant">Boiler Upgrade Scheme grant
      <span class="unit">£</span></label>
    <input id="bus-grant" type="number" step="100" min="0"
           value="7500">

    <label for="avoided-ac">Avoided air conditioning cost (if any)
      <span class="unit">£</span></label>
    <input id="avoided-ac" type="number" step="100" min="0"
           value="0">
  </div>
</div>
```

#### 3b. Financial results card

```html
<div id="financial-card" class="card hidden">
  <h2>Financial Summary</h2>
  <div id="financial-status"></div>
  <div id="financial-results" class="hidden">
    <div id="financial-summary"></div>
  </div>
  <button id="btn-recalculate-financial" class="btn-secondary hidden">Recalculate</button>
</div>
```

---

## Scope decisions

**SD1 — Break-even formula uses consistent data-period values.** The design doc formula
mixes data-period gas energy with annual standing charges, which is dimensionally
inconsistent. This plan uses data-period standing charges (`standing_p_day ×
data_period_days`) throughout, with elec SC cancelling correctly. The result is
equivalent to the design doc's formula in the limit where `data_period_days ≈ 365`.

**SD2 — `gas_energy_cost_gbp` used directly for "current" scenario gas energy.**
The "current" scenario has `elec_kwh = 0` for heating (verified in M7 plan Step 1g),
so `gas_energy_cost_gbp` equals `energy_cost_gbp`. M8 exposes `gas_energy_cost_gbp`
as a separate field; Step D uses it directly.

**SD3 — Sensitivity grid uses annualised cost components.** Grid payback values are
on an annual basis (net_investment / annual_saving). Annualising M8's data-period
components via `× (365 / data_period_days)` is the same scaling already applied in M8's
`annual_cost_gbp`. Directional correctness is unaffected.

**SD4 — COP sensitivity operates on the current (base) `current_annual_cost` for comparison.**
The "current" scenario (gas boiler) has no COP dependency — its cost is fixed. Only
HP scenarios scale with COP. This correctly models the physical reality: higher COP
means lower HP electricity consumption per unit of heat.

**SD5 — Avoided AC cost: `|| FA_CONFIG.AVOIDED_AC_DEFAULT_GBP` replaced with explicit
NaN-safe `parseGbp()`.** The `||` short-circuit incorrectly converts a valid `0` entry
(user explicitly enters £0) to the fallback. Since the default for avoided AC is £0,
the distinction matters only if the user clears and re-enters 0, but using `parseGbp`
is correct regardless.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| M8 does not expose `gas_energy_cost_gbp` / `elec_energy_cost_gbp` when M9 is implemented | Flag as required M8 amendment; implementation gate: both fields present before M9 coding begins |
| `net_investment = 0` displays payback of 0 years, which looks like a UI bug | Ensure `displayFinancialResults` handles `payback_years = 0` explicitly, displaying "Immediate" |
| Sensitivity grid computes payback for "current" vs "current" (zero saving, null payback) | Loop only over `HP_SCENARIOS`, not "current" |
| All-no-saving warning fires incorrectly when smart scenarios have null cost | Null-cost scenarios have `payback_status = 'no_data'`, not `'no_saving'` — the `allNoSaving` check uses strict `=== 'no_saving'` |
| `elec_kwh_total_hp = 0` produces division by zero in break-even | Guard: `if (elec_kwh_total_hp > 0)` before computing |
| Break-even `gas_breakeven_p` goes negative (gas SC dominates) | Clamp to null; omit gas break-even line from interpretation string |
| Sensitivity and COP grids silently wrong if cost decomposition is absent | Add a guard at start of Step C: if `components.current` is null, skip grid computation and push a warning |

---

## Success criteria

- [ ] **T1: Net investment — basic.** Installation £12,500, grant £7,500, avoided AC £0 →
  `net_full_hp = £5,000`. With avoided AC £1,500 → `net_full_hp = £3,500`. (Design doc test 1.)

- [ ] **T2: Net investment — floor.** Installation £8,000, grant £7,500, avoided AC £2,000 →
  unclamped −£1,500 → clamped to £0. (Design doc test 2.)

- [ ] **T3: Payback — positive case.** Current £2,200, dumb_hp_svt £1,900, net_investment
  £5,000 → saving £300, payback ≈ 16.7 years. (Design doc test 3.)

- [ ] **T4: Standing charges in payback.** Annual saving equals difference in total annual
  costs (including standing charges), verified by inspection in browser devtools.
  (Design doc test 4.)

- [ ] **T5: Payback — no saving.** Current £1,800, dumb_hp_svt £1,900 → saving −£100,
  `payback_status = 'no_saving'`, `payback_years = null`. (Design doc test 5.)

- [ ] **T6: Sensitivity grid direction — gas multiplier.** At `(gas_mult=1.2, elec_mult=1.0)`,
  boiler cost increases, HP saving increases, payback decreases relative to `(1.0, 1.0)`.
  (Design doc test 6.)

- [ ] **T7: COP sensitivity direction.** `cop_mult = 0.85` → `scaled_elec × (1/0.85)` →
  HP costs more → payback increases vs `cop_mult = 1.0`. Fails if same direction as rate
  rescaling. (Design doc test 7.)

- [ ] **T8: Break-even numerical check.** Gas total data-period £1,400 → gas_energy_dp_pence
  = 140,000. Gas SC: 31.66 p/day × 365 days ≈ 11,556 pence (or data-period equivalent).
  HP elec kWh = 5,200. Expected: `svt_be_p ≈ (140,000 + 11,556) / 5,200 ≈ 29.1p` (using
  365-day data period; design doc reference T8 uses different inputs — verify against
  design doc). (Design doc test 8 — verify formula and units match.)

- [ ] **T9: All-no-saving warning.** All HP scenarios cost more than current → warning
  emitted, all `payback_status = 'no_saving'`. (Design doc test 9.)

- [ ] **T10: BUS grant = 0.** `bus_grant_gbp = 0` → `net_investment = installation_cost`.
  Payback increases proportionally. (Design doc test 10.)

- [ ] **T11: Financial card visible** — card renders after M9 runs; payback table shows all
  5 HP scenarios with correct display names.

- [ ] **T12: Recalculate on capital change** — changing installation cost and clicking
  Recalculate produces updated payback values for all scenarios.

- [ ] **T13: Break-even string** — interpretation string renders with correct numeric values
  from Rhiannon's real data; passes directional sense check (HP saves if currently
  `current_svt_p < svt_be_p`).

---

## Implementation Deviations

*(To be completed after implementation.)*

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-27
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `docs/design/financial-analysis.md`

### Context

M8 (Pricing Engine) was approved and implemented on 2026-04-27, including the cost
decomposition (`gas_energy_cost_gbp`, `elec_energy_cost_gbp`) that M9 requires for its
sensitivity grid. The M9 plan correctly identified a dimensional inconsistency in the
design doc's break-even formula (design doc mixed data-period gas energy with annual
standing charges and incorrectly subtracted elec SC). The plan derives the corrected
formula from first principles — elec SC cancels because both scenarios pay it — and
adjusts the test criteria accordingly. The design doc has been updated to match.

### Required changes for implementation

**1. Step D: use `gas_energy_cost_gbp` directly (LOW)**

The plan guarded on `currentM8?.energy_cost_gbp` and used `energy_cost_gbp * 100`
as a proxy, with a comment "once M8 adds `gas_energy_cost_gbp`, prefer that field."
M8 already exposes `gas_energy_cost_gbp`. Guard updated to
`currentM8?.gas_energy_cost_gbp != null`; internal reference updated to
`currentM8.gas_energy_cost_gbp * 100`.

**2. Step 2g: stale wording (LOW)**

"Immediately after the M8 forward-declaration comments" updated to "immediately after
the `await runPricingEngine(...)` call" (M8 is already wired as live calls).
"Uncommented when M8 is wired in" updated to "when M9 is wired into the pipeline."

### Resolution of review changes

1. **`gas_energy_cost_gbp` direct reference** — guard and reference in Step D updated; SD2 commentary updated to match.
2. **Step 2g wording** — updated to reference the live M8 pipeline call and "M9 wired in."

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | ✓ pass |
| HIGH     | 0     | ✓ pass |
| MEDIUM   | 0     | ✓ pass |
| LOW      | 2     | ✅ resolved |

Verdict: APPROVE — clean plan; correctly fixes design doc break-even formula; two LOW stale-reference fixes applied inline.

---

## Approval

**Status:** ✅ Approved — 2026-04-27
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** Design doc break-even formula corrected (elec SC cancels; revised T8 expected value ≈29.2p); `gas_energy_cost_gbp` used directly in Step D.
