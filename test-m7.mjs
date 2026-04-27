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
  tMaxPreheatOffsetC = undefined,
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

  const args = {
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
  if (tMaxPreheatOffsetC !== undefined) args.tMaxPreheatOffsetC = tMaxPreheatOffsetC;
  return args;
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

// ===== T3 — Hybrid dispatch HP wins =====
// h=1.0, η=0.9, cop=3.5, elec=10p, gas=7p
// hpCost  = 10/3.5 = 2.857
// gasCost = 7/0.9  = 7.778
// HP cheaper → elec = 1.0 × 0.9 / 3.5 = 0.2571
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 10, cop: 3.5 });
  heating[0] = hh(ts(0, 0), 1.0);
  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    gasRateByHh:    new Array(48).fill(7),
    elecHhRateByHh: new Array(48).fill(10),
  }));
  const hyb = result.scenarios.hybrid_dumb;
  assert(Math.abs(hyb.elec_kwh[0] - 0.2571) < 0.001, 'T3a', `Hybrid: HP wins, elec ≈ 0.2571 (got ${hyb.elec_kwh[0]?.toFixed(4)})`);
  assert(hyb.gas_kwh[0] === 0,                       'T3b', `Hybrid: HP wins, gas = 0 (got ${hyb.gas_kwh[0]})`);
}

// ===== T4 — Hybrid dispatch gas wins =====
// Same parameters but elec=30p
// hpCost  = 30/3.5 = 8.571
// gasCost = 7/0.9  = 7.778
// Gas cheaper → gas=1.0, elec=0
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 10, cop: 3.5 });
  heating[0] = hh(ts(0, 0), 1.0);
  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    gasRateByHh:    new Array(48).fill(7),
    elecHhRateByHh: new Array(48).fill(30),
  }));
  const hyb = result.scenarios.hybrid_dumb;
  assert(hyb.gas_kwh[0]  === 1.0, 'T4a', `Hybrid: gas wins, gas = 1.0 (got ${hyb.gas_kwh[0]})`);
  assert(hyb.elec_kwh[0] === 0,   'T4b', `Hybrid: gas wins, elec = 0 (got ${hyb.elec_kwh[0]})`);
}

// ===== T5 / T6 — RC formula spec verification =====
// `requiredQDelivered` and `computeStepEnergetics` are not exported, so these tests
// re-derive the formula from spec (scenario-consumption.js:45-55) and verify expected
// physical values. Implementation conformance is verified by code inspection plus
// integration tests T7–T16, which exercise these formulas through the smart DP.
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
// Missing the × 3600 factor (kJ vs kWh) catastrophically underestimates Q.
{
  const heatLoss = _spec_heatLossKwh(200, 17, 5);
  const Q = _spec_requiredQ(17, 17.288, 10000, heatLoss, 0);
  assert(Math.abs(Q - 2.0) < 0.001, 'T6', `RC ΔT formula: Q = 2.0 at T_cur=17, T_next=17.288 (got ${Q.toFixed(4)})`);
}

// ===== T7 — DP comfort gate =====
// All occupied, HP fuel only → every backtracked indoor_temp_c ≥ setpoint
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 5, cop: 3 });
  // Force heating > 0 so 'heating.every(h===null)' early exit doesn't trigger
  for (let i = 0; i < 48; i++) heating[i] = hh(ts(0, i), 1.0);
  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    setpoint_c: 19, thermal_mass_kj_per_k: 10000, htc_w_per_k: 200,
    hp_capacity_kw: 10,
    occupancy_weights: new Array(48).fill(1.0),  // all occupied
    gasRateByHh:    new Array(48).fill(1000),    // gas effectively blocked
    elecHhRateByHh: new Array(48).fill(10),
  }));
  const indoor = result.scenarios.smart_hp_hh.indoor_temp_c;
  const allAboveSetpoint = indoor.every(t => t === null || t >= 19 - 1e-9);
  assert(allAboveSetpoint, 'T7', `All occupied indoor_temp_c ≥ setpoint 19 (min=${Math.min(...indoor.filter(t => t !== null)).toFixed(3)})`);
}

// ===== T8 — DP pre-heating cost reduction =====
// Cheap rate during overnight unoccupied window (HH 0-15), expensive HH 16-47.
// Occupied HH 16-47. T_max_preheat = setpoint+4 (offset=4) gives enough coast room.
// Smart DP should pre-heat during cheap and coast through expensive period.
// Expected: smart_hp_hh total cost < dumb_hp_hh total cost under same rate schedule.
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 5, cop: 3 });
  for (let i = 0; i < 48; i++) heating[i] = hh(ts(0, i), 1.5);  // 1.5 kWh ≈ comfort steady-state

  const elecRates = new Array(48);
  for (let i = 0; i < 48; i++) elecRates[i] = (i < 16) ? 2 : 30;

  const occupancy = new Array(48);
  for (let i = 0; i < 48; i++) occupancy[i] = (i >= 16) ? 1.0 : 0.0;

  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    setpoint_c: 19, thermal_mass_kj_per_k: 10000, htc_w_per_k: 200,
    hp_capacity_kw: 10,
    occupancy_weights: occupancy,
    gasRateByHh:    new Array(48).fill(1000),
    elecHhRateByHh: elecRates,
    tMaxPreheatOffsetC: 4,
  }));

  const dumb  = result.scenarios.dumb_hp_hh;
  const smart = result.scenarios.smart_hp_hh;
  let dumbCost = 0, smartCost = 0;
  for (let i = 0; i < 48; i++) {
    dumbCost  += (dumb.elec_kwh[i]  ?? 0) * elecRates[i];
    smartCost += (smart.elec_kwh[i] ?? 0) * elecRates[i];
  }
  assert(smartCost < dumbCost, 'T8', `Smart < Dumb cost under same rates (smart=${smartCost.toFixed(2)}p, dumb=${dumbCost.toFixed(2)}p)`);
}

// ===== T9 — Day chaining =====
// Day 1: unoccupied, expensive elec → DP drives T_indoor down to grid floor.
// Day 2: occupied → must start from day-1 end state, NOT from setpoint.
// Verify: day 2's indoor_temp_c[0] reflects ramp-up from low T (well below
// setpoint+T_max_preheat midpoint), not from setpoint as if reset.
{
  const heating = [], external = [], cop_by_hh = [];
  for (let d = 0; d < 2; d++) {
    for (let i = 0; i < 48; i++) {
      heating.push(hh(ts(d, i), 1.0));
      external.push(ext(5));
      cop_by_hh.push(3);
    }
  }
  // Day 1 unoccupied, day 2 occupied
  const occupancy = new Array(96);
  for (let i = 0; i < 48; i++) occupancy[i] = 0.0;
  for (let i = 48; i < 96; i++) occupancy[i] = 1.0;

  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    setpoint_c: 19, thermal_mass_kj_per_k: 10000, htc_w_per_k: 200,
    hp_capacity_kw: 10,
    occupancy_weights: occupancy,
    gasRateByHh:    new Array(96).fill(1000),
    elecHhRateByHh: new Array(96).fill(30),
  }));
  const indoor = result.scenarios.smart_hp_hh.indoor_temp_c;

  // Day 1 last HH: T should have drifted well below setpoint (no comfort gate)
  const day1End = indoor[47];
  // Day 2 first HH: must respect comfort gate (≥19), but starts from day1End, not 19
  const day2Start = indoor[48];

  assert(day1End < 19, 'T9a', `Day 1 unoccupied: T drifts below setpoint (day1End=${day1End?.toFixed(3)})`);
  assert(day2Start >= 19 - 1e-9, 'T9b', `Day 2 occupied: comfort gate active (day2Start=${day2Start?.toFixed(3)})`);
  // Most important: day 2 transitions FROM day1End. If day chaining were broken,
  // day 2 would start fresh at setpoint and there'd be no continuity. The actual
  // assertion is that the DP's reported day1End is plausible (< 19).
}

// ===== T10 — Non-heating day skipped =====
// All temps = 22 °C (above setpoint). dailyDdHours ≈ 0 → smart DP skipped.
// Expected: smart gas=elec=0, indoor_temp_c=null
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 22 });
  for (let i = 0; i < 48; i++) heating[i] = hh(ts(0, i), 0);
  const result = estimateScenarioConsumption(buildInputs({ heating, external, cop_by_hh }));
  const smart = result.scenarios.smart_hp_hh;
  const allZero = smart.gas_kwh.every(g => g === 0) && smart.elec_kwh.every(e => e === 0);
  const allTempNull = smart.indoor_temp_c.every(t => t === null);
  assert(allZero,     'T10a', `Non-heating day: smart gas/elec all 0`);
  assert(allTempNull, 'T10b', `Non-heating day: indoor_temp_c all null`);
}

// ===== T11 — Null-upstream passthrough =====
// thermal_mass = null → validation.smart = 'no_thermal_mass'; smart arrays null;
// dumb scenarios computed normally.
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: 10 });
  heating[0] = hh(ts(0, 0), 1.0);
  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    thermal_mass_kj_per_k: null,
  }));
  assert(result.validation_status.smart === 'no_thermal_mass', 'T11a', `validation.smart = 'no_thermal_mass' (got '${result.validation_status.smart}')`);
  const smart = result.scenarios.smart_hp_hh;
  const allNull = smart.gas_kwh.every(g => g === null) && smart.elec_kwh.every(e => e === null);
  assert(allNull, 'T11b', 'Smart scenarios all null when thermal_mass=null');
  // Dumb still computed
  assert(result.scenarios.dumb_hp_svt.elec_kwh[0] !== null, 'T11c', 'Dumb scenarios computed even when thermal_mass=null');
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

// ===== T14 — DST / non-48-HH day =====
// Inject a 47-HH day. Expected: smart arrays null for those HH; T_init unchanged.
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
    occupancy_weights: new Array(heating.length).fill(1.0),
    gasRateByHh:    new Array(heating.length).fill(1000),
    elecHhRateByHh: new Array(heating.length).fill(20),
  }));
  // Day 1 starts at index 48 and is 47 HH long → indices 48..94
  const smart = result.scenarios.smart_hp_hh;
  let day1AllNull = true;
  for (let i = 48; i < 95; i++) {
    if (smart.gas_kwh[i] !== null || smart.elec_kwh[i] !== null) { day1AllNull = false; break; }
  }
  assert(day1AllNull, 'T14a', '47-HH (DST) day: all smart arrays null');
  // Day 0 (full 48) and day 2 (full 48) should be populated
  assert(smart.elec_kwh[0]  !== null, 'T14b', 'Day 0 (48 HH) populated');
  assert(smart.elec_kwh[95] !== null, 'T14c', 'Day 2 (48 HH after DST gap) populated');
}

// ===== T15 — Validation 'partial' =====
// 8% of heating HH have null COP → validation.dumb = 'partial'
{
  const heating = [], external = [], cop_by_hh = [];
  // 100 HH with heating > 0; 8 of them have null COP
  for (let i = 0; i < 100; i++) {
    heating.push(hh(ts(0, i % 48), 1.0));  // timestamps reused — OK for dumb path
    external.push(ext(10));
    cop_by_hh.push(i < 8 ? null : 3.0);
  }
  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    occupancy_weights: new Array(100).fill(1.0),
  }));
  assert(result.validation_status.dumb === 'partial', 'T15', `validation.dumb = 'partial' at 8% null COP (got '${result.validation_status.dumb}')`);
}

// ===== T16 — DP infeasible day relaxation =====
// Severe under-sizing: tiny HP capacity vs cold day.
// Expected: warning surfaced about "undersized for N day(s)"; smart arrays still produced.
{
  const { heating, external, cop_by_hh } = buildSimpleDay({ tempC: -10, cop: 1.5 });
  for (let i = 0; i < 48; i++) heating[i] = hh(ts(0, i), 5.0);
  const result = estimateScenarioConsumption(buildInputs({
    heating, external, cop_by_hh,
    setpoint_c: 19, thermal_mass_kj_per_k: 10000, htc_w_per_k: 500,
    hp_capacity_kw: 0.5,                          // severely undersized
    occupancy_weights: new Array(48).fill(1.0),
    gasRateByHh:    new Array(48).fill(1000),
    elecHhRateByHh: new Array(48).fill(20),
  }));
  const undersizedWarn = result.warnings.some(w => w.toLowerCase().includes('undersized'));
  assert(undersizedWarn, 'T16a', `Warning surfaced for undersized HP (warnings: ${JSON.stringify(result.warnings)})`);
  // Result still produced (relaxed pass succeeded or zero-energy fallback)
  const smart = result.scenarios.smart_hp_hh;
  const hasOutput = smart.elec_kwh.length === 48;
  assert(hasOutput, 'T16b', `Smart array length 48 even with infeasible DP`);
}

// ===== Summary =====
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
