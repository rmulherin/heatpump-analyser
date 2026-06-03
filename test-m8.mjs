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
  svt_standing_charge_p: null,
  gas_standing_charge_p: null,
};

const FLAT_GAS_W  = [{ valid_from: '2020-01-01T00:00:00Z', valid_to: null, rate_p_kwh: 7.0,  standing_p_day: 0 }];
const FLAT_ELEC_W = [{ valid_from: '2020-01-01T00:00:00Z', valid_to: null, rate_p_kwh: 24.5, standing_p_day: 0 }];

function makeIngestion(consumption, gasWindows = FLAT_GAS_W, elecWindows = FLAT_ELEC_W) {
  return { consumption, tariff_rates: { gas: gasWindows, electricity: elecWindows } };
}

// Synthetic m2Result — replaces makeExternal() in v2.
// All rate computation (D×W+P, gas windowing) moved to buildBaseTariffs in external-data.js.
// prepareRates now reads pre-computed arrays from m2Result.
function makeMsResult(n, {
  gasRate      = 7.0,
  flatRate     = 24.5,
  hhRate       = 11.0,
  gasStanding  = 0,
  elecStanding = 0,
} = {}) {
  return {
    gas_rate:          Array.isArray(gasRate)  ? gasRate  : Array(n).fill(gasRate),
    flat_rate:         Array.isArray(flatRate) ? flatRate : Array(n).fill(flatRate),
    hh_rate:           Array.isArray(hhRate)   ? hhRate   : Array(n).fill(hhRate),
    standing_charge:   { gas: gasStanding, elec: elecStanding },
    agile_calibration: { D: 2.2, P_peak_p_kwh: 12, source: 'calibrated', null_wholesale_fraction: 0 },
  };
}

function makeScenario(n, gas_kwh_val = 0, elec_kwh_val = 0) {
  return {
    gas_kwh:       Array(n).fill(gas_kwh_val),
    elec_kwh:      Array(n).fill(elec_kwh_val),
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

// ── T1: gas_rate pass-through from m2Result ───────────────────────────────────
// D×W+P calculation and gas windowing moved to buildBaseTariffs (external-data.js).
// prepareRates now reads pre-computed per-HH arrays from m2Result.

console.log('\nT1: gas_rate and hh_rate pass-through from m2Result');
{
  const consumption = [
    { timestamp: '2025-05-15T12:00:00Z' },
    { timestamp: '2025-08-10T06:00:00Z' },
  ];
  const m2 = makeMsResult(2, { gasRate: [7.5, 6.8], hhRate: [11.0, 11.0] });
  const rm = prepareRates(makeIngestion(consumption), m2, DEFAULT_PARAMS);
  assert(approx(rm.gas_rate_by_hh[0], 7.5),  'T1a: gas_rate[0] = 7.5 p/kWh from m2Result');
  assert(approx(rm.gas_rate_by_hh[1], 6.8),  'T1b: gas_rate[1] = 6.8 p/kWh from m2Result');
  assert(approx(rm.elec_hh_rate_by_hh[0], 11.0), 'T1c: hh_rate[0] = 11.0 p/kWh from m2Result');
}

// ── T2: HH rate and flat rate pass-through ────────────────────────────────────

console.log('\nT2: HH and flat rate pass-through from m2Result');
{
  const consumption = [
    { timestamp: '2025-06-01T00:00:00Z' },
    { timestamp: '2025-06-01T00:30:00Z' },
  ];
  // D=2.2, W=5.0, off-peak → 11.0; second slot null wholesale → imputed to same 11.0
  // These values are what buildBaseTariffs would produce; passed pre-computed here.
  const m2 = makeMsResult(2, { hhRate: [11.0, 11.0], flatRate: 24.5 });
  const rm = prepareRates(makeIngestion(consumption), m2, DEFAULT_PARAMS);
  assert(approx(rm.elec_hh_rate_by_hh[0], 11.0),
    'T2a: hh_rate[0] = 11.0 p/kWh (pre-computed D×W off-peak, passed through from m2Result)');
  assert(approx(rm.elec_hh_rate_by_hh[1], 11.0),
    'T2b: hh_rate[1] = 11.0 p/kWh (imputed null slot, pre-computed in m2Result)');
  assert(!rm.warnings.some(w => w.includes('no wholesale')),
    'T2c: no per-slot wholesale warning in prepareRates (coverage handled in m2)');
}

// ── T3: Negative HH rate pass-through ────────────────────────────────────────

console.log('\nT3: Negative HH rate pass-through');
{
  const consumption = [{ timestamp: '2025-06-01T00:00:00Z' }];
  // D=2.2, W=-5.0, off-peak → -11.0; passes through unchanged
  const m2 = makeMsResult(1, { hhRate: -11.0 });
  const rm = prepareRates(makeIngestion(consumption), m2, DEFAULT_PARAMS);
  assert(approx(rm.elec_hh_rate_by_hh[0], -11.0),
    'T3: hh_rate=-11.0 passes through (negatives not clamped on lower end)');
}

// ── T4: Standing charge fuel supply logic ─────────────────────────────────────
// All scenarios include gas (HP scenarios retain gas connection for baseload).

console.log('\nT4: Standing charge fuel supply logic');
{
  const n = 365;
  const consumption = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000);
    return { timestamp: d.toISOString().slice(0, 10) + 'T00:00:00' };
  });
  // Standing charges now come from m2Result.standing_charge (not tariff windows).
  const m2 = makeMsResult(n, { gasStanding: 30.0, elecStanding: 60.0 });
  const rm = prepareRates(makeIngestion(consumption), m2, DEFAULT_PARAMS);
  const result = computeCosts(
    rm,
    makeScenarioResult(makeAllScenarios(n, 0, 0)),
    { svt_standing_charge_p: null, gas_standing_charge_p: null },
  );
  // All scenarios: gas+elec → standing = (30+60) × 365 / 100 = £328.50
  assert(approx(result.scenarios.dumb_hp_svt.standing_charge_gbp, 90 * 365 / 100, 1e-4),
    'T4a: dumb_hp_svt standing = £328.50 (gas + electricity — retained gas connection)');
  assert(approx(result.scenarios.current.standing_charge_gbp, 90 * 365 / 100, 1e-4),
    'T4b: current standing = £328.50 (gas + electricity standing charges combined)');
}

// ── T5: dumb_hp_svt uses flat_rate from m2Result ──────────────────────────────

console.log('\nT5: dumb_hp_svt uses flat_rate from m2Result');
{
  const consumption = [{ timestamp: '2025-06-01T00:00:00Z' }];
  // flat_rate=24.67 (Ofgem cap); hh_rate=100.0 (high — dumb_hp_svt must ignore it)
  const m2 = makeMsResult(1, { flatRate: 24.67, hhRate: 100.0 });
  const rm = prepareRates(makeIngestion(consumption), m2, DEFAULT_PARAMS);
  const scenarios = {
    current:     makeScenario(1, 0, 0),
    dumb_hp_svt: makeScenario(1, 0, 2.0),
    dumb_hp_hh:  makeScenario(1, 0, 0),
    smart_hp_hh: makeScenario(1, 0, 0),
  };
  const result = computeCosts(rm, makeScenarioResult(scenarios), {
    svt_standing_charge_p: 0, gas_standing_charge_p: 0,
  });
  // 2.0 kWh × 24.67 p/kWh / 100 = £0.4934
  assert(approx(result.scenarios.dumb_hp_svt.energy_cost_gbp, 2.0 * 24.67 / 100, 1e-9),
    'T5: dumb_hp_svt 2.0 kWh × flat_rate 24.67 p/kWh = £0.4934 (HH Agile rate ignored)');
}

// ── T6: dumb_hp_hh uses hh_rate; dumb_hp_svt uses flat_rate ──────────────────

console.log('\nT6: dumb_hp_hh uses HH rate, dumb_hp_svt uses flat rate');
{
  const consumption = [{ timestamp: '2025-06-01T00:00:00Z' }];
  // hh_rate=11.0 (off-peak Agile), flat_rate=24.67 (Ofgem cap)
  const m2 = makeMsResult(1, { hhRate: 11.0, flatRate: 24.67 });
  const rm = prepareRates(makeIngestion(consumption), m2, DEFAULT_PARAMS);
  const scenarios = {
    current:     makeScenario(1, 0, 0),
    dumb_hp_svt: makeScenario(1, 0, 2.0),
    dumb_hp_hh:  makeScenario(1, 0, 2.0),
    smart_hp_hh: makeScenario(1, 0, 0),
  };
  const result = computeCosts(rm, makeScenarioResult(scenarios), {
    svt_standing_charge_p: 0, gas_standing_charge_p: 0,
  });
  // 2.0 kWh × 11.0 p/kWh / 100 = £0.22
  assert(approx(result.scenarios.dumb_hp_hh.energy_cost_gbp, 0.22, 1e-9),
    'T6a: dumb_hp_hh 2.0 kWh × hh_rate 11.0 p/kWh = £0.22');
  // 2.0 kWh × 24.67 p/kWh / 100 = £0.4934
  assert(approx(result.scenarios.dumb_hp_svt.energy_cost_gbp, 2.0 * 24.67 / 100, 1e-9),
    'T6b: dumb_hp_svt uses flat_rate 24.67p/kWh');
  assert(result.scenarios.dumb_hp_hh.energy_cost_gbp < result.scenarios.dumb_hp_svt.energy_cost_gbp,
    'T6c: hh_rate (11.0 p/kWh) < flat_rate (24.67 p/kWh) → dumb_hp_hh cost < dumb_hp_svt cost');
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
  const m2 = makeMsResult(n, { gasRate: 10.0, gasStanding: 0, elecStanding: 0 });
  const rm = prepareRates(makeIngestion(consumption), m2, DEFAULT_PARAMS);
  const scenarios = {
    current:     makeScenario(n, 1.0, 0),
    dumb_hp_svt: makeScenario(n, 0, 0),
    dumb_hp_hh:  makeScenario(n, 0, 0),
    smart_hp_hh: makeScenario(n, 0, 0),
  };
  const result = computeCosts(rm, makeScenarioResult(scenarios), {
    svt_standing_charge_p: 0, gas_standing_charge_p: 0,
  });
  const cur = result.scenarios.current;
  // energy = 300 × 1.0 kWh × 10 p/kWh / 100 = £30.00
  // annual = 30 × 365/300 = £36.50
  assert(approx(cur.energy_cost_gbp, 30.0, 1e-6), 'T7a: energy_cost_gbp = £30.00');
  assert(approx(cur.annual_cost_gbp, 36.5, 1e-6), 'T7b: annual_cost_gbp = £36.50 (scaled 365/300)');
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
  const m2 = makeMsResult(n, { gasRate: 10.0, flatRate: 24.5, gasStanding: 20.0, elecStanding: 10.0 });
  const rm = prepareRates(makeIngestion(entries), m2, DEFAULT_PARAMS);
  const scenarios = {
    current:     makeScenario(n, 0.5, 0),
    dumb_hp_svt: makeScenario(n, 0, 0),
    dumb_hp_hh:  makeScenario(n, 0, 0),
    smart_hp_hh: makeScenario(n, 0, 0),
  };
  const result = computeCosts(rm, makeScenarioResult(scenarios), {
    svt_standing_charge_p: null, gas_standing_charge_p: null,
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
  const m2 = makeMsResult(n);
  const rm = prepareRates(makeIngestion(consumption), m2, DEFAULT_PARAMS);
  const result = computeCosts(rm, makeScenarioResult(makeAllScenarios(n, 0, 0)), {
    svt_standing_charge_p: 0, gas_standing_charge_p: 0,
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
  const m2 = makeMsResult(n);
  const rm = prepareRates(makeIngestion(consumption), m2, DEFAULT_PARAMS);
  const result = computeCosts(
    rm,
    makeScenarioResult(makeAllScenarios(n, 1.0, 1.0), 'insufficient_data'),
    { svt_standing_charge_p: 0, gas_standing_charge_p: 0 },
  );
  assert(result.scenarios.smart_hp_hh.annual_cost_gbp  === null, 'T10a: smart_hp_hh.annual_cost_gbp = null');
  assert(result.scenarios.current.annual_cost_gbp      !== null, 'T10b: current unaffected by smart=insufficient_data');
  assert(result.scenarios.dumb_hp_hh.annual_cost_gbp   !== null, 'T10c: dumb_hp_hh unaffected by smart=insufficient_data');
}

// ── T11: §14 gas rate override (uniform fill) ─────────────────────────────────

console.log('\nT11: §14 gas rate override');
{
  const consumption = [
    { timestamp: '2025-05-15T12:00:00Z' },
    { timestamp: '2025-08-10T06:00:00Z' },
  ];
  // m2Result has [7.5, 6.8] for gas, but override sets uniform 4.0
  const m2 = makeMsResult(2, { gasRate: [7.5, 6.8] });
  const rm = prepareRates(
    makeIngestion(consumption), m2,
    { ...DEFAULT_PARAMS, gas_rate_override_p_kwh: 4.0 },
  );
  assert(approx(rm.gas_rate_by_hh[0], 4.0), 'T11a: gas override 4.0 p/kWh overrides m2Result[0]=7.5');
  assert(approx(rm.gas_rate_by_hh[1], 4.0), 'T11b: gas override 4.0 p/kWh overrides m2Result[1]=6.8');
}

// ── T12: §14 SVT rate override (uniform fill) ─────────────────────────────────

console.log('\nT12: §14 SVT rate override');
{
  const consumption = [{ timestamp: '2025-06-01T00:00:00Z' }];
  // m2Result has flat_rate=24.5, override sets 20.0
  const m2 = makeMsResult(1, { flatRate: 24.5, hhRate: 11.0 });
  const rm = prepareRates(
    makeIngestion(consumption), m2,
    { ...DEFAULT_PARAMS, svt_rate_p_per_kwh: 20.0 },
  );
  assert(approx(rm.flat_rate_by_hh[0], 20.0),
    'T12: SVT override 20.0 p/kWh overrides m2Result.flat_rate=24.5');
  // hh_rate is NOT overridden by svt_rate_p_per_kwh
  assert(approx(rm.elec_hh_rate_by_hh[0], 11.0),
    'T12b: hh_rate unaffected by SVT override');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
