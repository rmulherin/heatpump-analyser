// test-m7.mjs — Scenario Consumption (M7) synthetic unit tests
// Run: node test-m7.mjs  (from repo root)

import { estimateScenarioConsumption } from './js/scenario-consumption.js';

let passed = 0, failed = 0;

function assert(cond, id, desc) {
  if (cond) { console.log(`✅ ${id}: ${desc}`); passed++; }
  else      { console.log(`❌ ${id}: ${desc}`); failed++; }
}

function ts(dayOffset, hhInDay) {
  const ms = Date.UTC(2025, 0, 1) + dayOffset * 86400000 + hhInDay * 30 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 19);
}

function hh(timestamp, heating_kwh, is_absence = false) {
  return { timestamp, heating_kwh, is_absence };
}

function ext(temp_c, solar_w_m2 = null) {
  return { temp_c, solar_w_m2 };
}

// Build a 1-day (48-HH) baseline with constant temp + zero heating.
function buildSimpleDay({ tempC = 5, dayOffset = 0, cop = 3.0 } = {}) {
  const heating = [], external = [], cop_by_hh = [];
  for (let i = 0; i < 48; i++) {
    heating.push(hh(ts(dayOffset, i), 0));
    external.push(ext(tempC));
    cop_by_hh.push(cop);
  }
  return { heating, external, cop_by_hh };
}

// Wrap raw arrays into the estimateScenarioConsumption argument shape.
function buildInputs({
  heating, external, cop_by_hh,
  htc_w_per_k = 200, eta = 0.9,
  setpoint_c = 19, thermal_mass_kj_per_k = 10000, occupancy_weights = null,
  hp_capacity_kw = 10,
  gasRateByHh = null, elecHhRateByHh = null,
  baseloadMethod = 'gas',
  thermalCharacterOverride = undefined,
} = {}) {
  const n = heating.length;

  let thermalCharacter;
  if (thermalCharacterOverride !== undefined) {
    thermalCharacter = thermalCharacterOverride;
  } else {
    thermalCharacter = {
      setpoint_c,
      thermal_mass_kj_per_k,
      occupancy_weights: occupancy_weights ?? new Array(n).fill(1.0),
    };
  }

  return {
    heating, external,
    heatLoss: {
      htc_w_per_k,
      boiler_efficiency_used: eta,
      solar_correction_applied: false,
      solar_aperture_m2: 0,
    },
    thermalCharacter,
    heatPumpModel: { cop_by_hh, hp_capacity_kw },
    baseloadMethod,
    gasRateByHh:    gasRateByHh    ?? new Array(n).fill(7),
    elecHhRateByHh: elecHhRateByHh ?? new Array(n).fill(20),
  };
}

// ===== T1 — Dumb HP unit conversion =====
// heating=1.0, η=0.9, cop=3.0 → elec = 1.0 × 0.9 / 3.0 = 0.30
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 10 });
  heating[0] = hh(ts(0, 0), 1.0);
  const result = estimateScenarioConsumption(buildInputs({ heating, external, cop_by_hh }));
  const elec0 = result.scenarios.dumb_hp_svt.elec_kwh[0];
  assert(Math.abs(elec0 - 0.30) < 0.0001, 'T1', `Dumb HP elec = h×η/cop = 0.30 (got ${elec0?.toFixed(4)})`);
}

// ===== T2 — Dumb HP null COP fallback =====
// heating=1.5, cop=null → gas=1.5, elec=0
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 10 });
  heating[0] = hh(ts(0, 0), 1.5);
  cop_by_hh[0] = null;
  const result = estimateScenarioConsumption(buildInputs({ heating, external, cop_by_hh }));
  const dumb = result.scenarios.dumb_hp_svt;
  assert(dumb.gas_kwh[0]  === 1.5, 'T2a', `gas_kwh = 1.5 when cop=null (got ${dumb.gas_kwh[0]})`);
  assert(dumb.elec_kwh[0] === 0,   'T2b', `elec_kwh = 0  when cop=null (got ${dumb.elec_kwh[0]})`);
}

// ===== T5 / T6 — RC formula spec verification =====
// `requiredQDelivered` and `computeStepEnergetics` feed simulatePostHocTIndoor.
// Formulas re-derived from spec (scenario-consumption.js) and verified against
// expected physical values. Integration tests T9/T16 exercise them end-to-end.
function _spec_heatLossKwh(htc, T_cur, temp) {
  return htc * (T_cur - temp) * 0.5 / 1000;
}
function _spec_requiredQ(T_cur, T_next, C, heatLossKwh, solarGainKwh) {
  return (T_next - T_cur) * C / 3600 + heatLossKwh - solarGainKwh;
}

// ===== T5 — RC steady state =====
// T_cur=T_next=19, temp=5, htc=200, C=10000, R=0 → Q = heatLoss = 1.4
{
  const heatLoss = _spec_heatLossKwh(200, 19, 5);
  const Q = _spec_requiredQ(19, 19, 10000, heatLoss, 0);
  assert(Math.abs(Q - 1.4) < 0.0001, 'T5', `RC steady state: Q = 1.4 kWh at T=19, temp=5 (got ${Q.toFixed(4)})`);
}

// ===== T6 — RC non-trivial ΔT =====
// T_cur=17, T_next=17.288, temp=5, htc=200, C=10000 → Q = 2.0
// Forward: T_next = 17 + (Q − heatLoss) × 3600 / C = 17 + 0.8 × 0.36 = 17.288
{
  const heatLoss = _spec_heatLossKwh(200, 17, 5);
  const Q = _spec_requiredQ(17, 17.288, 10000, heatLoss, 0);
  assert(Math.abs(Q - 2.0) < 0.001, 'T6', `RC ΔT formula: Q = 2.0 at T_cur=17, T_next=17.288 (got ${Q.toFixed(4)})`);
}

// ===== T8 — Greedy fills cheapest first =====
// Rate variance: HH 0-11 cheap (2p), HH 12-47 expensive (30p).
// Greedy concentrates all heat in cheap window → smart cost << dumb cost.
//
// Setup: 48 HH × 0.6 kWh heating, η=0.9, cop=3.0, cap=10 kW
// B_d = 48 × 0.6 × 0.9 = 25.92 kWh thermal; cap per HH = 5 kWh
// Greedy fills 5 cheap HH at 5 kWh + 6th at 0.92 → all at 2p elec
// Smart cost ≈ 25.92/3 × 2 = 17.28p
// Dumb: 12 × 0.18 × 2 + 36 × 0.18 × 30 = 4.32 + 194.4 = 198.72p
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 5, cop: 3.0 });
  for (let i = 0; i < 48; i++) heating[i] = hh(ts(0, i), 0.6);

  const elecRates = new Array(48);
  for (let i = 0; i < 48; i++) elecRates[i] = (i < 12) ? 2 : 30;

  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    gasRateByHh:    new Array(48).fill(1000),   // gas blocked
    elecHhRateByHh: elecRates,
  }));

  const dumb  = result.scenarios.dumb_hp_hh;
  const smart = result.scenarios.smart_hp_hh;
  let dumbCost = 0, smartCost = 0;
  for (let i = 0; i < 48; i++) {
    dumbCost  += (dumb.elec_kwh[i]  ?? 0) * elecRates[i];
    smartCost += (smart.elec_kwh[i] ?? 0) * elecRates[i];
  }
  assert(smartCost < dumbCost, 'T8', `Greedy cheapest-first: smart < dumb (smart=${smartCost.toFixed(2)}p, dumb=${dumbCost.toFixed(2)}p)`);
}

// ===== T9 — Post-hoc T_indoor day chaining =====
// Day 1: no heating (B_d=0) → building cools from setpoint toward outdoor temp.
// Day 2: normal heating. Post-hoc sim walks the full chronological array, so day 2
// starts from day-1's cooled state, not from setpoint.
//
// With htc=200, C=10000, setpoint=19, temp=5:
//   Time constant τ ≈ 13.9 h → after 24 h T ≈ 7.5°C
// indoor_temp_c[48] (day 2 first HH) should be well below 19 (chaining works),
// not above 19 (which is what a reset-to-setpoint would give).
{
  const heating = [], external = [], cop_by_hh = [];
  for (let i = 0; i < 48; i++) {        // day 0: no heating
    heating.push(hh(ts(0, i), 0));
    external.push(ext(5));
    cop_by_hh.push(3);
  }
  for (let i = 0; i < 48; i++) {        // day 1: normal heating
    heating.push(hh(ts(1, i), 1.0));
    external.push(ext(5));
    cop_by_hh.push(3);
  }

  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    setpoint_c: 19, thermal_mass_kj_per_k: 10000, htc_w_per_k: 200,
    hp_capacity_kw: 10,
    gasRateByHh:    new Array(96).fill(1000),
    elecHhRateByHh: new Array(96).fill(20),
  }));
  const indoor = result.scenarios.smart_hp_hh.indoor_temp_c;

  assert(indoor[47] < 18, 'T9a', `Day-0 no-heat cools building: T[47] < 18 (got ${indoor[47]?.toFixed(2)})`);
  // If chaining were broken, day 1 would reset to setpoint=19 and T[48] would be ~20.3.
  // With chaining, T[48] ≈ 9.2 (starts from ~7.5, then gets first greedy allocation).
  assert(indoor[48] < 15, 'T9b', `Day-1 starts from cooled state, not setpoint: T[48] < 15 (got ${indoor[48]?.toFixed(2)})`);
}

// ===== T10 — Non-heating day (B_d = 0) =====
// All heating_kwh = 0 → B_d = 0 → greedy returns all zeros.
// Post-hoc sim still runs (thermal params available) → indoor_temp_c is non-null.
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 22 });
  for (let i = 0; i < 48; i++) heating[i] = hh(ts(0, i), 0);
  const result = estimateScenarioConsumption(buildInputs({ heating, external, cop_by_hh }));
  const smart = result.scenarios.smart_hp_hh;
  const allZero = smart.gas_kwh.every(g => g === 0) && smart.elec_kwh.every(e => e === 0);
  assert(allZero,                'T10a', `B_d=0 day: smart gas/elec all 0`);
  assert(smart.indoor_temp_c[0] !== null, 'T10b', `Post-hoc sim runs even when B_d=0: indoor_temp_c[0] non-null`);
}

// ===== T11 — Null thermal_mass passthrough =====
// thermal_mass null does NOT block smart (greedy needs only htc and hp_capacity).
// Post-hoc sim returns all-null indoor_temp_c when C is missing.
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 10 });
  heating[0] = hh(ts(0, 0), 1.0);
  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    thermal_mass_kj_per_k: null,
  }));
  assert(result.validation_status.smart === 'ok',
    'T11a', `validation.smart = 'ok' when thermal_mass=null (got '${result.validation_status.smart}')`);
  assert((result.scenarios.smart_hp_hh.elec_kwh[0] ?? 0) > 0,
    'T11b', `Smart elec_kwh computed even when thermal_mass=null`);
  const allTempNull = result.scenarios.smart_hp_hh.indoor_temp_c.every(t => t === null);
  assert(allTempNull,
    'T11c', `indoor_temp_c all null when thermal_mass=null (post-hoc sim skipped)`);
  assert((result.scenarios.dumb_hp_svt.elec_kwh[0] ?? 0) > 0,
    'T11d', `Dumb scenarios computed even when thermal_mass=null`);
}

// ===== T12 — Current scenario unchanged =====
// current.gas_kwh[i] === heating_kwh[i] for all i; current.elec_kwh[i] === 0 (or null)
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 10 });
  heating[0]  = hh(ts(0, 0),  1.5);
  heating[5]  = hh(ts(0, 5),  0.7);
  heating[20] = { timestamp: ts(0, 20), heating_kwh: null, is_absence: false };
  const result = estimateScenarioConsumption(buildInputs({ heating, external, cop_by_hh }));
  const current = result.scenarios.current;

  let allMatch = true;
  for (let i = 0; i < 48; i++) {
    if (current.gas_kwh[i] !== heating[i].heating_kwh) { allMatch = false; break; }
  }
  assert(allMatch, 'T12a', 'current.gas_kwh[i] === heating_kwh[i] for all i');

  let elecCorrect = true;
  for (let i = 0; i < 48; i++) {
    const expected = heating[i].heating_kwh === null ? null : 0;
    if (current.elec_kwh[i] !== expected) { elecCorrect = false; break; }
  }
  assert(elecCorrect, 'T12b', 'current.elec_kwh[i] === 0 (or null when heating_kwh=null)');
}

// ===== T13 — dumb_hp_svt and dumb_hp_hh shared reference =====
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 10 });
  heating[0] = hh(ts(0, 0), 1.0);
  const result = estimateScenarioConsumption(buildInputs({ heating, external, cop_by_hh }));
  assert(
    result.scenarios.dumb_hp_svt === result.scenarios.dumb_hp_hh,
    'T13', `dumb_hp_svt === dumb_hp_hh (object identity)`,
  );
}

// ===== T14 — DST / non-48-HH day → zero (not null) =====
// Non-48-HH days (skipDp=true) are skipped by buildSmartScenario via continue.
// Arrays are initialised to 0 and remain at 0 for those HH.
{
  const heating = [], external = [], cop_by_hh = [];
  // Day 0: 48 HH normal
  for (let i = 0; i < 48; i++) {
    heating.push(hh(ts(0, i), 1.0));
    external.push(ext(5));
    cop_by_hh.push(3);
  }
  // Day 1: 47 HH (spring-forward)
  for (let i = 0; i < 47; i++) {
    heating.push(hh(ts(1, i), 1.0));
    external.push(ext(5));
    cop_by_hh.push(3);
  }
  // Day 2: 48 HH normal
  for (let i = 0; i < 48; i++) {
    heating.push(hh(ts(2, i), 1.0));
    external.push(ext(5));
    cop_by_hh.push(3);
  }
  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    setpoint_c: 19, thermal_mass_kj_per_k: 10000, htc_w_per_k: 200,
    hp_capacity_kw: 10,
    gasRateByHh:    new Array(heating.length).fill(1000),
    elecHhRateByHh: new Array(heating.length).fill(20),
  }));
  // Day 1 starts at index 48 and is 47 HH long → indices 48..94
  const smart = result.scenarios.smart_hp_hh;
  let day1AllZero = true;
  for (let i = 48; i < 95; i++) {
    if (smart.gas_kwh[i] !== 0 || smart.elec_kwh[i] !== 0) { day1AllZero = false; break; }
  }
  assert(day1AllZero,          'T14a', '47-HH (DST) day: all smart gas/elec = 0');
  // Day 0 and day 2 (full 48 HH) should get positive allocation
  assert(smart.elec_kwh[0]  > 0, 'T14b', 'Day 0 (48 HH) allocated');
  assert(smart.elec_kwh[95] > 0, 'T14c', 'Day 2 (48 HH after DST gap) allocated');
}

// ===== T15 — Validation 'partial' =====
// 8% of heating HH have null COP → validation.dumb = 'partial'
{
  const heating = [], external = [], cop_by_hh = [];
  for (let i = 0; i < 100; i++) {
    heating.push(hh(ts(0, i % 48), 1.0));
    external.push(ext(10));
    cop_by_hh.push(i < 8 ? null : 3.0);
  }
  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    occupancy_weights: new Array(100).fill(1.0),
  }));
  assert(result.validation_status.dumb === 'partial', 'T15', `validation.dumb = 'partial' at 8% null COP (got '${result.validation_status.dumb}')`);
}

// ===== T16 — Smart ≤ Dumb cost invariant =====
// Greedy anchors smart to observed B_d and allocates cheapest first.
// By construction, total cost(smart) ≤ cost(dumb) for any rate schedule.
// Uses same rate and COP as T8 but computes costs explicitly.
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 5, cop: 3.0 });
  for (let i = 0; i < 48; i++) heating[i] = hh(ts(0, i), 0.8);

  const elecRates = new Array(48);
  for (let i = 0; i < 48; i++) elecRates[i] = (i % 2 === 0) ? 5 : 25;  // alternating cheap/expensive

  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    gasRateByHh:    new Array(48).fill(1000),
    elecHhRateByHh: elecRates,
  }));

  const dumb  = result.scenarios.dumb_hp_hh;
  const smart = result.scenarios.smart_hp_hh;
  let dumbCost = 0, smartCost = 0;
  for (let i = 0; i < 48; i++) {
    dumbCost  += (dumb.elec_kwh[i]  ?? 0) * elecRates[i];
    smartCost += (smart.elec_kwh[i] ?? 0) * elecRates[i];
  }
  assert(smartCost <= dumbCost + 1e-6, 'T16',
    `Smart ≤ Dumb invariant (smart=${smartCost.toFixed(2)}p, dumb=${dumbCost.toFixed(2)}p)`);
}

// ===== T17 — Daily heat-budget conservation =====
// Sum of thermal delivery across a day must equal B_d within floating-point tolerance.
// For smart_hp_hh (HP-only), q_thermal[i] = elec_kwh[i] × cop[i].
{
  const cop = 3.0;
  const eta = 0.9;
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 5, cop });
  for (let i = 0; i < 48; i++) heating[i] = hh(ts(0, i), 1.2);

  const B_d = 48 * 1.2 * eta;   // 51.84 kWh thermal

  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    gasRateByHh:    new Array(48).fill(1000),
    elecHhRateByHh: new Array(48).fill(20),
  }));

  const smart = result.scenarios.smart_hp_hh;
  let sumQ = 0;
  for (let i = 0; i < 48; i++) sumQ += (smart.elec_kwh[i] ?? 0) * cop;

  assert(Math.abs(sumQ - B_d) < 0.01, 'T17',
    `Budget conservation: |Σq_thermal − B_d| < 0.01 (sum=${sumQ.toFixed(4)}, B_d=${B_d.toFixed(4)})`);
}

// ===== T18 — HP undersized → validation.smart = 'hp_undersized', warning =====
// HP cap = 0.01 kW → per-HH cap = 0.005 kWh << B_d → residual > 1e-9 → hpUndersized.
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 5, cop: 3.0 });
  for (let i = 0; i < 48; i++) heating[i] = hh(ts(0, i), 1.0);

  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    hp_capacity_kw: 0.01,                         // severely undersized
    gasRateByHh:    new Array(48).fill(1000),
    elecHhRateByHh: new Array(48).fill(20),
  }));

  assert(result.validation_status.smart === 'hp_undersized', 'T18a',
    `validation.smart = 'hp_undersized' when cap exhausted (got '${result.validation_status.smart}')`);
  const hasWarn = result.warnings.some(w => w.toLowerCase().includes('insufficient') || w.toLowerCase().includes('undersized'));
  assert(hasWarn, 'T18b',
    `Warning surfaced for undersized HP (warnings: ${JSON.stringify(result.warnings)})`);
}

// ===== Summary =====
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
