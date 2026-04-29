import { analyseFinancials, FA_CONFIG } from './js/financial.js';

// ── Infrastructure ────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else       { console.error(`  FAIL  ${name}`); failed++; }
}
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) < tol; }

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Build a ScenarioCost object; gas+elec+standing must equal annual for 365-day window (scale=1)
function sc(annual_cost_gbp, gas_energy = 0, elec_energy = 0, standing = 0) {
  if (annual_cost_gbp === null) {
    return { annual_cost_gbp: null, gas_energy_cost_gbp: null,
             elec_energy_cost_gbp: null, standing_charge_gbp: null,
             energy_cost_gbp: null, monthly_breakdown: null };
  }
  return { annual_cost_gbp, gas_energy_cost_gbp: gas_energy,
           elec_energy_cost_gbp: elec_energy, standing_charge_gbp: standing,
           energy_cost_gbp: gas_energy + elec_energy, monthly_breakdown: [] };
}

// Minimal pricing result: all scenarios derive decomposition from annual (50% gas, 50% standing, 0 elec)
// Consistent with scale=1 when data_period_days=365 → gas+elec+standing = annual
function buildPricing(annuals) {
  const names = ['current','dumb_hp_svt','dumb_hp_hh','smart_hp_hh'];
  const scenarios = {};
  for (const name of names) {
    const a = annuals[name] ?? 0;
    scenarios[name] = a === null ? sc(null) : sc(a, a * 0.5, 0, a * 0.5);
  }
  return { scenarios, warnings: [] };
}

function makeRm({ days = 365, gasSc = 31.66, svt = 24.50 } = {}) {
  return {
    data_period_days: days,
    gas_standing_charge_p_per_day: gasSc,
    elec_standing_charge_p_per_day: 61.64,
    svt_rate_p_per_kwh: svt,
    consumption: [], gas_rate_by_hh: [], elec_hh_rate_by_hh: [], warnings: [],
  };
}

// Minimal scenario result for break-even; gasKwhCurrent & elecKwhHp are totals (stored as [total])
function makeSr(gasKwhCurrent = 0, elecKwhHp = 0, smart = 'ok') {
  const gArr = [gasKwhCurrent], eArr = [elecKwhHp];
  const zz = [0];
  return {
    scenarios: {
      current:     { gas_kwh: gArr, elec_kwh: zz,  indoor_temp_c: zz },
      dumb_hp_svt: { gas_kwh: zz,  elec_kwh: eArr, indoor_temp_c: zz },
      dumb_hp_hh:  { gas_kwh: zz,  elec_kwh: zz,  indoor_temp_c: zz },
      smart_hp_hh: { gas_kwh: zz,  elec_kwh: zz,  indoor_temp_c: zz },
    },
    validation_status: { dumb: 'ok', smart },
    warnings: [],
  };
}

function params(overrides = {}) {
  return {
    installation_cost_full_hp_gbp: 12500,
    bus_grant_gbp: 7500,
    avoided_ac_cost_gbp: 0,
    ...overrides,
  };
}

const NULL_SR = makeSr(0, 0);      // zeroed scenario result — disables break-even (total=0 guard)
const BASIC_RM = makeRm();

// ── CONFIG export ─────────────────────────────────────────────────────────────

console.log('\nCONFIG: FA_CONFIG export');
assert(FA_CONFIG.BUS_GRANT_DEFAULT_GBP === 7500, 'CONFIG: BUS grant default = £7,500');
assert(FA_CONFIG.GAS_MULTIPLIERS.length === 5,   'CONFIG: 5 gas multipliers');

// ── T1: Net investment basic ──────────────────────────────────────────────────

console.log('\nT1: Net investment — basic');
{
  const pr = buildPricing({ current: 2000, dumb_hp_svt: 1800, dumb_hp_hh: 1800, smart_hp_hh: 1800 });
  const r1 = analyseFinancials(pr, BASIC_RM, NULL_SR, params());
  // install=12500, grant=7500, avoided_ac=0 → net_full=5000
  assert(approx(r1.scenarios.dumb_hp_svt.net_investment_gbp, 5000), 'T1a: full HP net investment = £5,000 (12500-7500)');

  const r2 = analyseFinancials(pr, BASIC_RM, NULL_SR, params({ avoided_ac_cost_gbp: 1500 }));
  // deductions = 7500+1500 = 9000 → net_full = 3500
  assert(approx(r2.scenarios.dumb_hp_svt.net_investment_gbp, 3500), 'T1b: avoided_ac £1,500 → net full HP = £3,500');
}

// ── T2: Net investment floor ──────────────────────────────────────────────────

console.log('\nT2: Net investment — floor at £0');
{
  const pr = buildPricing({ current: 2000, dumb_hp_svt: 1800, dumb_hp_hh: 1800, smart_hp_hh: 1800 });
  // install=8000, grant=7500, avoided_ac=2000 → deductions=9500, 8000-9500=-1500 → clamped £0
  const r = analyseFinancials(pr, BASIC_RM, NULL_SR,
    params({ installation_cost_full_hp_gbp: 8000, bus_grant_gbp: 7500, avoided_ac_cost_gbp: 2000 }));
  assert(approx(r.scenarios.dumb_hp_svt.net_investment_gbp, 0), 'T2: full HP net investment clamped to £0');
}

// ── T3: Payback — positive case ───────────────────────────────────────────────

console.log('\nT3: Payback — positive case');
{
  // current=2200, dumb_hp_svt=1900, net_full=5000 → saving=300, payback=16.667y
  const pr = buildPricing({ current: 2200, dumb_hp_svt: 1900, dumb_hp_hh: 1900, smart_hp_hh: 1900 });
  const r = analyseFinancials(pr, BASIC_RM, NULL_SR,
    params({ installation_cost_full_hp_gbp: 5000, bus_grant_gbp: 0, avoided_ac_cost_gbp: 0 }));
  const s = r.scenarios.dumb_hp_svt;
  assert(approx(s.annual_saving_gbp, 300.0, 1e-6), 'T3a: annual_saving_gbp = £300 (2200-1900)');
  assert(approx(s.payback_years, 5000 / 300, 1e-6), 'T3b: payback_years = 16.667 (5000/300)');
  assert(s.payback_status === 'positive', 'T3c: payback_status = "positive"');
}

// ── T4: Saving invariant — all HP scenarios ────────────────────────────────────

console.log('\nT4: Saving invariant (annual_saving = currentAnnual − scenarioAnnual)');
{
  const annuals = { current: 2200, dumb_hp_svt: 1900, dumb_hp_hh: 1800, smart_hp_hh: 1700 };
  const pr = buildPricing(annuals);
  const r = analyseFinancials(pr, BASIC_RM, NULL_SR, params());
  for (const name of ['dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh']) {
    const expectedSaving = annuals.current - annuals[name];
    assert(approx(r.scenarios[name].annual_saving_gbp, expectedSaving, 1e-6),
      `T4 ${name}: annual_saving = ${annuals.current} − ${annuals[name]} = £${expectedSaving}`);
  }
}

// ── T5: Payback — no saving ───────────────────────────────────────────────────

console.log('\nT5: Payback — no saving');
{
  // current=1800, dumb_hp_svt=1900 → saving=-100 → no_saving
  const pr = buildPricing({ current: 1800, dumb_hp_svt: 1900, dumb_hp_hh: 1900, smart_hp_hh: 1900 });
  const r = analyseFinancials(pr, BASIC_RM, NULL_SR, params());
  const s = r.scenarios.dumb_hp_svt;
  assert(s.payback_status  === 'no_saving', 'T5a: payback_status = "no_saving" when HP costs more');
  assert(s.payback_years   === null,        'T5b: payback_years = null when no saving');
}

// ── T6: Sensitivity grid — gas multiplier direction ────────────────────────────

console.log('\nT6: Sensitivity grid — gas multiplier direction');
{
  // current: high gas, zero elec (benefits most from rising gas)
  // HP scenarios: zero gas, high elec (not affected by gas multiplier)
  // At (1.2,1.0): current more expensive → saving rises → payback shorter than (1.0,1.0)
  const n = 5000;
  const currentCost = sc(1200, 800, 0, 400); // gas=800, elec=0, standing=400; annual=1200
  const hpCost      = sc(600,  0,  500, 100); // gas=0, elec=500, standing=100; annual=600
  const pr = {
    scenarios: {
      current:     currentCost,
      dumb_hp_svt: hpCost,
      dumb_hp_hh:  hpCost,
      smart_hp_hh: hpCost,
    },
    warnings: [],
  };
  const r = analyseFinancials(pr, BASIC_RM, NULL_SR,
    params({ installation_cost_full_hp_gbp: n, bus_grant_gbp: 0 }));

  const grid = r.sensitivity.grid;
  const at = (gm, em) => grid.find(p => p.gas_multiplier === gm && p.elec_multiplier === em);
  const p10 = at(1.0, 1.0)?.payback_years;
  const p12 = at(1.2, 1.0)?.payback_years;

  // At (1.0,1.0): saving = (800+0+400)-(0+500+100) = 1200-600 = 600; payback = 5000/600 = 8.333
  assert(approx(p10, n / 600, 1e-4), `T6a: grid(1.0,1.0) payback = ${(n/600).toFixed(2)}y`);
  // At (1.2,1.0): current = 800×1.2+0+400=1360; HP=0+500+100=600; saving=760; payback=5000/760=6.579
  assert(p12 < p10, 'T6b: grid(1.2,1.0) payback < grid(1.0,1.0) payback (rising gas helps HP vs boiler)');
}

// ── T7: COP sensitivity — direction check ─────────────────────────────────────

console.log('\nT7: COP sensitivity — direction check');
{
  // Lower COP (cop_mult=0.85) → HP uses more electricity → higher cost → longer payback
  const n = 5000;
  const currentCost = sc(1200, 800, 0, 400);
  const hpCost      = sc(600,  0,  500, 100);
  const pr = {
    scenarios: { current: currentCost, dumb_hp_svt: hpCost, dumb_hp_hh: hpCost, smart_hp_hh: hpCost },
    warnings: [],
  };
  const r = analyseFinancials(pr, BASIC_RM, NULL_SR,
    params({ installation_cost_full_hp_gbp: n, bus_grant_gbp: 0 }));

  const cop_axis = r.sensitivity.cop_axis;
  const atCop = (m) => cop_axis.find(e => approx(e.cop_multiplier, m, 0.01))?.payback_years;
  const p10 = atCop(1.0);
  const p085 = atCop(0.85);

  // cop_mult=1.0: scenarioScaled = 0 + 500×(1/1.0) + 100 = 600; saving=600; payback=8.333
  // cop_mult=0.85: scenarioScaled = 0 + 500×(1/0.85) + 100 = 688.24; saving=511.76; payback=9.77
  assert(approx(p10, n / 600, 1e-4), `T7a: cop_axis(1.0) payback = ${(n/600).toFixed(2)}y`);
  assert(p085 > p10, 'T7b: cop_mult=0.85 (worse COP) → higher payback than cop_mult=1.0');
}

// ── T8: Break-even numerical check ────────────────────────────────────────────

console.log('\nT8: Break-even calculation');
{
  // gas_energy_cost_gbp=1400, gas_sc=31.66 p/day × 365 days, elec_kwh_hp=5200, gas_kwh_cur=8000
  // svt_be = (140000 + 31.66×365) / 5200 ≈ 29.145 p/kWh
  // gas_be = (5200×24.50 - 31.66×365) / 8000 ≈ 14.480 p/kWh
  const gas_energy_data_period = 1400;
  const pr = {
    scenarios: {
      current:     sc(gas_energy_data_period, gas_energy_data_period, 0, 0),
      dumb_hp_svt: sc(900, 0, 900, 0),
      dumb_hp_hh:  sc(900, 0, 900, 0),
      smart_hp_hh: sc(900, 0, 900, 0),
    },
    warnings: [],
  };
  const rm = makeRm({ days: 365, gasSc: 31.66, svt: 24.50 });
  // Use single-element arrays representing totals
  const sr = makeSr(8000, 5200);
  const r = analyseFinancials(pr, rm, sr, params());
  const be = r.break_even;

  const expectedSvt = (gas_energy_data_period * 100 + 31.66 * 365) / 5200;
  const expectedGas = (5200 * 24.50 - 31.66 * 365) / 8000;
  assert(approx(be.dumb_hp_svt_break_even_elec_p_per_kwh, expectedSvt, 0.01),
    `T8a: svt break-even ≈ ${expectedSvt.toFixed(1)}p/kWh`);
  assert(approx(be.gas_to_elec_ratio_at_break_even !== null &&
    be.dumb_hp_svt_break_even_elec_p_per_kwh, expectedSvt, 0.01),
    'T8b: gas_to_elec_ratio_at_break_even is not null');
  // interpretation string contains the break-even rate to 1dp
  const interp = be.break_even_interpretation ?? '';
  assert(interp.includes(expectedSvt.toFixed(1)), `T8c: interpretation string contains ${expectedSvt.toFixed(1)}p/kWh`);
}

// ── T9: All-no-saving warning ─────────────────────────────────────────────────

console.log('\nT9: All-no-saving warning');
{
  // All HP scenarios cost more than current → all 'no_saving' → warning emitted
  const pr = buildPricing({ current: 1000, dumb_hp_svt: 1100, dumb_hp_hh: 1100, smart_hp_hh: 1100 });
  const r = analyseFinancials(pr, BASIC_RM, NULL_SR, params());
  const hpStatuses = ['dumb_hp_svt','dumb_hp_hh','smart_hp_hh']
    .map(n => r.scenarios[n].payback_status);
  assert(hpStatuses.every(s => s === 'no_saving'), 'T9a: all HP scenarios have payback_status = "no_saving"');
  assert(r.warnings.some(w => w.includes('none of the heat pump')), 'T9b: all-no-saving warning emitted');
}

// ── T10: BUS grant = 0 ────────────────────────────────────────────────────────

console.log('\nT10: BUS grant = 0');
{
  // current=2200, dumb_hp_svt=1900, saving=300
  const pr = buildPricing({ current: 2200, dumb_hp_svt: 1900, dumb_hp_hh: 1900, smart_hp_hh: 1900 });
  const r = analyseFinancials(pr, BASIC_RM, NULL_SR,
    params({ installation_cost_full_hp_gbp: 12500, bus_grant_gbp: 0, avoided_ac_cost_gbp: 0 }));
  // net_full = 12500 - 0 = 12500; payback = 12500/300 = 41.667
  assert(approx(r.scenarios.dumb_hp_svt.net_investment_gbp, 12500), 'T10a: grant=0 → net_investment = installation cost £12,500');
  assert(approx(r.scenarios.dumb_hp_svt.payback_years, 12500 / 300, 1e-4), 'T10b: payback = 12500/300 = 41.67y');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
