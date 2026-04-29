import { prepareRates, computeCosts, PE_CONFIG } from './js/pricing-engine.js';

// ── Infrastructure ────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else       { console.error(`  FAIL  ${name}`); failed++; }
}
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) < tol; }

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEFAULT_PARAMS = {
  svt_rate_p_per_kwh:    24.50,
  svt_standing_charge_p: null,
  gas_standing_charge_p: null,
};

const FLAT_GAS_W  = [{ valid_from: '2020-01-01T00:00:00Z', valid_to: null, rate_p_kwh: 7.0,  standing_p_day: 0 }];
const FLAT_ELEC_W = [{ valid_from: '2020-01-01T00:00:00Z', valid_to: null, rate_p_kwh: 24.5, standing_p_day: 0 }];

function makeIngestion(consumption, gasWindows, elecWindows = FLAT_ELEC_W) {
  return { consumption, tariff_rates: { gas: gasWindows, electricity: elecWindows } };
}

function makeExternal(n, wholesale) {
  return Array.from({ length: n }, (_, i) => ({
    wholesale_p_kwh: Array.isArray(wholesale) ? wholesale[i] : wholesale,
  }));
}

function makeScenario(n, gas_kwh_val = 0, elec_kwh_val = 0) {
  return {
    gas_kwh:      Array(n).fill(gas_kwh_val),
    elec_kwh:     Array(n).fill(elec_kwh_val),
    indoor_temp_c: Array(n).fill(19),
  };
}

function makeAllScenarios(n, gas_kwh = 0, elec_kwh = 0) {
  const s = makeScenario(n, gas_kwh, elec_kwh);
  return { current: s, dumb_hp_svt: s, dumb_hp_hh: s, smart_hp_hh: s };
}

function makeScenarioResult(scenarios, smartStatus = 'ok') {
  return { scenarios, validation_status: { dumb: 'ok', smart: smartStatus }, warnings: [] };
}

// ── CONFIG export ─────────────────────────────────────────────────────────────

console.log('\nCONFIG: PE_CONFIG export');
assert(PE_CONFIG.PARTIAL_MONTH_DAY_THRESHOLD === 20, 'CONFIG: partial month threshold = 20 days');

// ── T1: Time-varying gas tariff rate lookup ───────────────────────────────────

console.log('\nT1: Time-varying gas tariff rate');
{
  const gasWindows = [
    { valid_from: '2025-01-01T00:00:00Z', valid_to: '2025-04-01T00:00:00Z', rate_p_kwh: 7.0, standing_p_day: 0 },
    { valid_from: '2025-04-01T00:00:00Z', valid_to: '2025-07-01T00:00:00Z', rate_p_kwh: 7.5, standing_p_day: 0 },
    { valid_from: '2025-07-01T00:00:00Z', valid_to: null,                   rate_p_kwh: 6.8, standing_p_day: 0 },
  ];
  const consumption = [
    { timestamp: '2025-05-15T12:00:00' },
    { timestamp: '2025-08-10T06:00:00' },
  ];
  const rm = prepareRates(makeIngestion(consumption, gasWindows), makeExternal(2, 5.0), DEFAULT_PARAMS);
  assert(approx(rm.gas_rate_by_hh[0], 7.5), 'T1a: May timestamp → gas rate 7.5 p/kWh');
  assert(approx(rm.gas_rate_by_hh[1], 6.8), 'T1b: August timestamp → gas rate 6.8 p/kWh');
}

// ── T2: HH electricity rate construction (Agile D×W+P) ───────────────────────

console.log('\nT2: HH electricity rate construction');
{
  // Timestamps at 00:00 and 00:30 UTC on 2025-06-01 = 01:00–01:30 BST → off-peak
  const consumption = [
    { timestamp: '2025-06-01T00:00:00' },
    { timestamp: '2025-06-01T00:30:00' },
  ];
  const external = [{ wholesale_p_kwh: 5.0 }, { wholesale_p_kwh: null }];
  const rm = prepareRates(
    makeIngestion(consumption, FLAT_GAS_W, FLAT_ELEC_W),
    external,
    DEFAULT_PARAMS,
    // Default calibration: D=2.2, P=12
  );
  // Off-peak: D × W = 2.2 × 5.0 = 11.0
  assert(approx(rm.elec_hh_rate_by_hh[0], 11.0), 'T2a: off-peak wholesale=5, D=2.2 → rate=11.0 p/kWh');
  // Null wholesale, off-peak → rate = 0
  assert(approx(rm.elec_hh_rate_by_hh[1], 0.0), 'T2b: null wholesale, off-peak → rate=0 p/kWh');
  assert(rm.warnings.some(w => w.includes('no wholesale')), 'T2c: null wholesale triggers warning');
}

// ── T3: Negative wholesale passthrough ───────────────────────────────────────

console.log('\nT3: Negative wholesale passthrough');
{
  // 2025-06-01T00:00:00 UTC = 01:00 BST → off-peak; D × (-5) = -11.0
  const consumption = [{ timestamp: '2025-06-01T00:00:00' }];
  const rm = prepareRates(
    makeIngestion(consumption, FLAT_GAS_W, FLAT_ELEC_W),
    [{ wholesale_p_kwh: -5.0 }],
    DEFAULT_PARAMS,
  );
  assert(approx(rm.elec_hh_rate_by_hh[0], -11.0), 'T3: off-peak wholesale=-5, D=2.2 → rate=-11.0 (not clamped on lower end)');
}

// ── T4: Standing charge fuel supply logic ─────────────────────────────────────
// All scenarios now include gas (HP scenarios retain gas connection for baseload).

console.log('\nT4: Standing charge fuel supply logic');
{
  const n = 365;
  const consumption = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000);
    return { timestamp: d.toISOString().slice(0, 10) + 'T00:00:00' };
  });
  const gasW  = [{ valid_from: '2020-01-01T00:00:00Z', valid_to: null, rate_p_kwh: 7.0, standing_p_day: 30.0 }];
  const elecW = [{ valid_from: '2020-01-01T00:00:00Z', valid_to: null, rate_p_kwh: 24.5, standing_p_day: 60.0 }];
  const rm = prepareRates(makeIngestion(consumption, gasW, elecW), makeExternal(n, 5.0), DEFAULT_PARAMS);
  const result = computeCosts(
    rm,
    makeScenarioResult(makeAllScenarios(n, 0, 0)),
    { svt_rate_p_per_kwh: 24.5, svt_standing_charge_p: null, gas_standing_charge_p: null },
  );
  // All scenarios: gas+elec → standing = (30+60) × 365 / 100 = £328.50
  assert(approx(result.scenarios.dumb_hp_svt.standing_charge_gbp, 90 * 365 / 100, 1e-4),
    'T4a: dumb_hp_svt standing = £328.50 (gas + electricity — retained gas connection)');
  assert(approx(result.scenarios.current.standing_charge_gbp, 90 * 365 / 100, 1e-4),
    'T4b: current standing = £328.50 (gas + electricity standing charges combined)');
}

// ── T5: dumb_hp_svt uses SVT flat rate ───────────────────────────────────────

console.log('\nT5: dumb_hp_svt uses SVT flat rate');
{
  const consumption = [{ timestamp: '2025-06-01T00:00:00' }];
  // wholesale=100 → Agile rate capped at 100p; dumb_hp_svt ignores HH rate and uses Ofgem cap
  const rm = prepareRates(
    makeIngestion(consumption, FLAT_GAS_W, FLAT_ELEC_W),
    [{ wholesale_p_kwh: 100.0 }],
    { ...DEFAULT_PARAMS, ofgem_cap_elec_p_kwh: 24.67 },
  );
  const scenarios = {
    current:     makeScenario(1, 0, 0),
    dumb_hp_svt: makeScenario(1, 0, 2.0),
    dumb_hp_hh:  makeScenario(1, 0, 0),
    smart_hp_hh: makeScenario(1, 0, 0),
  };
  const result = computeCosts(rm, makeScenarioResult(scenarios), {
    svt_rate_p_per_kwh: 24.50, svt_standing_charge_p: 0, gas_standing_charge_p: 0,
  });
  // 2.0 kWh × 24.67 p/kWh / 100 = £0.4934
  assert(approx(result.scenarios.dumb_hp_svt.energy_cost_gbp, 2.0 * 24.67 / 100, 1e-9),
    'T5: dumb_hp_svt 2.0 kWh × Ofgem cap 24.67 p/kWh = £0.4934 (HH Agile rate ignored)');
}

// ── T6: dumb_hp_hh uses Agile D×W+P HH rate ──────────────────────────────────

console.log('\nT6: dumb_hp_hh uses HH Agile rate');
{
  const consumption = [{ timestamp: '2025-06-01T00:00:00' }];
  // Off-peak at 01:00 BST; wholesale=5, D=2.2 → elec_hh_rate=11.0; SVT cap=24.67 → dumb_hp_hh cheaper
  const rm = prepareRates(
    makeIngestion(consumption, FLAT_GAS_W, FLAT_ELEC_W),
    [{ wholesale_p_kwh: 5.0 }],
    { ...DEFAULT_PARAMS, ofgem_cap_elec_p_kwh: 24.67 },
  );
  const scenarios = {
    current:     makeScenario(1, 0, 0),
    dumb_hp_svt: makeScenario(1, 0, 2.0),
    dumb_hp_hh:  makeScenario(1, 0, 2.0),
    smart_hp_hh: makeScenario(1, 0, 0),
  };
  const result = computeCosts(rm, makeScenarioResult(scenarios), {
    svt_rate_p_per_kwh: 24.50, svt_standing_charge_p: 0, gas_standing_charge_p: 0,
  });
  // 2.0 kWh × 11.0 p/kWh / 100 = £0.22
  assert(approx(result.scenarios.dumb_hp_hh.energy_cost_gbp, 0.22, 1e-9),
    'T6a: dumb_hp_hh 2.0 kWh × Agile rate 11.0 p/kWh = £0.22');
  // dumb_hp_svt uses Ofgem cap 24.67p: 2.0 × 24.67 / 100 = £0.4934
  assert(approx(result.scenarios.dumb_hp_svt.energy_cost_gbp, 2.0 * 24.67 / 100, 1e-9),
    'T6b: dumb_hp_svt uses Ofgem cap rate 24.67p/kWh');
  assert(result.scenarios.dumb_hp_hh.energy_cost_gbp < result.scenarios.dumb_hp_svt.energy_cost_gbp,
    'T6c: Agile rate (11.0 p/kWh) < Ofgem cap (24.67 p/kWh) → dumb_hp_hh cost < dumb_hp_svt cost');
}

// ── T7: Annual scaling ────────────────────────────────────────────────────────

console.log('\nT7: Annual scaling (300-day window)');
{
  // 1 HH per day, 300 distinct dates, gas_kwh=1.0, gas_rate=10, no standing charges
  const n = 300;
  const consumption = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000);
    return { timestamp: d.toISOString().slice(0, 10) + 'T00:00:00' };
  });
  const gasW = [{ valid_from: '2020-01-01T00:00:00Z', valid_to: null, rate_p_kwh: 10.0, standing_p_day: 0 }];
  const rm = prepareRates(makeIngestion(consumption, gasW, FLAT_ELEC_W), makeExternal(n, 5.0), DEFAULT_PARAMS);
  const scenarios = {
    current:     makeScenario(n, 1.0, 0),
    dumb_hp_svt: makeScenario(n, 0, 0),
    dumb_hp_hh:  makeScenario(n, 0, 0),
    smart_hp_hh: makeScenario(n, 0, 0),
  };
  const result = computeCosts(rm, makeScenarioResult(scenarios), {
    svt_rate_p_per_kwh: 24.5, svt_standing_charge_p: 0, gas_standing_charge_p: 0,
  });
  const cur = result.scenarios.current;
  // energy = 300 × 1.0 kWh × 10 p/kWh / 100 = £30.00
  // annual = 30 × 365/300 = £36.50
  assert(approx(cur.energy_cost_gbp, 30.0, 1e-6),  'T7a: energy_cost_gbp = £30.00');
  assert(approx(cur.annual_cost_gbp, 36.5, 1e-6),  'T7b: annual_cost_gbp = £36.50 (scaled 365/300)');
}

// ── T8: Monthly sum equals annual unscaled ────────────────────────────────────

console.log('\nT8: Monthly sum = annual unscaled');
{
  // Jan + Feb 2025, 48 HH per day — current scenario, gas_kwh=0.5
  const entries = [];
  for (let day = 0; day < 59; day++) {
    for (let hh = 0; hh < 48; hh++) {
      const ms = Date.UTC(2025, 0, 1) + day * 86400000 + hh * 30 * 60000;
      entries.push({ timestamp: new Date(ms).toISOString().slice(0, 19) });
    }
  }
  const n = entries.length; // 2832
  const gasW  = [{ valid_from: '2020-01-01T00:00:00Z', valid_to: null, rate_p_kwh: 10.0, standing_p_day: 20.0 }];
  const elecW = [{ valid_from: '2020-01-01T00:00:00Z', valid_to: null, rate_p_kwh: 24.5, standing_p_day: 10.0 }];
  const rm = prepareRates(makeIngestion(entries, gasW, elecW), makeExternal(n, 5.0), DEFAULT_PARAMS);
  const scenarios = {
    current:     makeScenario(n, 0.5, 0),
    dumb_hp_svt: makeScenario(n, 0, 0),
    dumb_hp_hh:  makeScenario(n, 0, 0),
    smart_hp_hh: makeScenario(n, 0, 0),
  };
  const result = computeCosts(rm, makeScenarioResult(scenarios), {
    svt_rate_p_per_kwh: 24.5, svt_standing_charge_p: null, gas_standing_charge_p: null,
  });
  const cur = result.scenarios.current;
  const mb  = cur.monthly_breakdown;
  const sumEnergy = mb.reduce((s, m) => s + m.energy_cost_gbp,     0);
  const sumSc     = mb.reduce((s, m) => s + m.standing_charge_gbp, 0);
  const sumTotal  = mb.reduce((s, m) => s + m.total_gbp,           0);
  assert(approx(sumEnergy, cur.energy_cost_gbp,                  1e-6), 'T8a: monthly energy sum = energy_cost_gbp');
  assert(approx(sumSc,     cur.standing_charge_gbp,              1e-6), 'T8b: monthly standing sum = standing_charge_gbp');
  assert(approx(sumTotal,  cur.energy_cost_gbp + cur.standing_charge_gbp, 1e-6), 'T8c: monthly total sum = energy + standing (unscaled)');
}

// ── T9: Partial month flag ────────────────────────────────────────────────────

console.log('\nT9: Partial month flag');
{
  // April 15–30 (16 days, partial), May 1–31 (31 days, full), June 1–10 (10 days, partial)
  const dates = [];
  for (let d = 15; d <= 30; d++) dates.push(`2025-04-${String(d).padStart(2, '0')}T00:00:00`);
  for (let d = 1;  d <= 31; d++) dates.push(`2025-05-${String(d).padStart(2, '0')}T00:00:00`);
  for (let d = 1;  d <= 10; d++) dates.push(`2025-06-${String(d).padStart(2, '0')}T00:00:00`);
  const n = dates.length;
  const consumption = dates.map(ts => ({ timestamp: ts }));
  const rm = prepareRates(
    makeIngestion(consumption, FLAT_GAS_W, FLAT_ELEC_W),
    makeExternal(n, 5.0),
    DEFAULT_PARAMS,
  );
  const result = computeCosts(rm, makeScenarioResult(makeAllScenarios(n, 0, 0)), {
    svt_rate_p_per_kwh: 24.5, svt_standing_charge_p: 0, gas_standing_charge_p: 0,
  });
  const mb = result.scenarios.current.monthly_breakdown;
  const apr = mb.find(m => m.month === '2025-04');
  const may = mb.find(m => m.month === '2025-05');
  const jun = mb.find(m => m.month === '2025-06');
  assert(apr?.partial === true,  'T9a: April with 16 days → partial: true (< 20 day threshold)');
  assert(may?.partial === false, 'T9b: May with 31 days → partial: false');
  assert(jun?.partial === true,  'T9c: June with 10 days → partial: true (< 20 day threshold)');
}

// ── T10: Null passthrough for smart scenarios ─────────────────────────────────

console.log('\nT10: Null passthrough for smart = insufficient_data');
{
  const n = 10;
  const consumption = Array.from({ length: n }, (_, i) => ({
    timestamp: `2025-06-${String(i + 1).padStart(2, '0')}T00:00:00`,
  }));
  const rm = prepareRates(
    makeIngestion(consumption, FLAT_GAS_W, FLAT_ELEC_W),
    makeExternal(n, 5.0),
    DEFAULT_PARAMS,
  );
  const result = computeCosts(
    rm,
    makeScenarioResult(makeAllScenarios(n, 1.0, 1.0), 'insufficient_data'),
    { svt_rate_p_per_kwh: 24.5, svt_standing_charge_p: 0, gas_standing_charge_p: 0 },
  );
  assert(result.scenarios.smart_hp_hh.annual_cost_gbp  === null, 'T10a: smart_hp_hh.annual_cost_gbp = null');
  assert(result.scenarios.current.annual_cost_gbp      !== null, 'T10b: current unaffected by smart=insufficient_data');
  assert(result.scenarios.dumb_hp_hh.annual_cost_gbp   !== null, 'T10c: dumb_hp_hh unaffected by smart=insufficient_data');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
