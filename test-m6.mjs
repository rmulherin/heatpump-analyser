// test-m6.mjs — Heat Pump Model (M6) synthetic unit tests
// Run: node test-m6.mjs  (from repo root)

import { estimateHeatPumpModel } from './js/heatpump-model.js';

let passed = 0, failed = 0;

function assert(condition, id, description) {
  if (condition) { console.log(`✅ ${id}: ${description}`); passed++; }
  else           { console.log(`❌ ${id}: ${description}`); failed++; }
}

// Minimal HH record
function ext(temp_c) { return { temp_c }; }
function hh(heating_kwh, is_absence = false) {
  return { timestamp: '2025-01-01T00:00:00', heating_kwh, is_absence };
}

// Call estimateHeatPumpModel with a single-HH external array; htc null for COP-only tests
function copAt(temp_c, scalar) {
  const result = estimateHeatPumpModel(
    [ext(temp_c)], [hh(0)],
    { htc_w_per_k: null, boiler_efficiency_used: 0.9 },
    { setpoint_c: null },
    'gas', scalar,
  );
  return result.cop_by_hh[0];
}

// ===== T1 — COP interpolation within range =====
// temp=3.5, scalar=1.0 → f=(3.5−(−3))/(10−(−3))=6.5/13=0.5 → 2.37+0.5×1.0=2.87
{
  const cop = copAt(3.5, 1.0);
  assert(Math.abs(cop - 2.87) < 0.0001, 'T1', `COP(3.5°C,×1.0) = 2.87 (got ${cop?.toFixed(4)})`);
}

// ===== T2 — COP clamp cold =====
// temp=−20°C → clamped to −15 anchor → 1.44 (not extrapolated)
{
  const cop = copAt(-20, 1.0);
  assert(Math.abs(cop - 1.44) < 0.0001, 'T2', `COP(−20°C,×1.0) clamped to 1.44 (got ${cop?.toFixed(4)})`);
}

// ===== T3 — COP clamp warm =====
// temp=25°C → clamped to 20 anchor → 4.14
{
  const cop = copAt(25, 1.0);
  assert(Math.abs(cop - 4.14) < 0.0001, 'T3', `COP(25°C,×1.0) clamped to 4.14 (got ${cop?.toFixed(4)})`);
}

// ===== T4 — Scalar multiplicative =====
// temp=10°C, base COP=3.37
// scalar=1.2 → 3.37×1.2=4.044 (additive would give 3.37+0.2=3.57)
// scalar=0.8 → 3.37×0.8=2.696 (additive would give 3.37−0.2=3.17)
{
  const cop12 = copAt(10, 1.2);
  const cop08 = copAt(10, 0.8);
  assert(Math.abs(cop12 - 4.044) < 0.0001, 'T4a',
    `COP(10°C,×1.2) = 4.044 multiplicative (got ${cop12?.toFixed(4)})`);
  assert(Math.abs(cop08 - 2.696) < 0.0001, 'T4b',
    `COP(10°C,×0.8) = 2.696 multiplicative (got ${cop08?.toFixed(4)})`);
}

// ===== T5 — Clamp after scaling =====
// temp=−15°C, scalar=0.5 → 1.44×0.5=0.72 → clamped to 1.0
{
  const cop = copAt(-15, 0.5);
  assert(Math.abs(cop - 1.0) < 0.0001, 'T5',
    `COP(−15°C,×0.5) = 0.72 → clamped to 1.0 (got ${cop?.toFixed(4)})`);
}

// ===== T6 — HP capacity units =====
// htc=250, setpoint=20, scalar=1.0
// hp_capacity_kw = 250×(20−(−3))/1000 = 5.75
// cop_at_design_temp = COP(−3,1.0) = 2.37
// hp_capacity_kw_elec = 5.75/2.37 = 2.4262...
{
  const result = estimateHeatPumpModel(
    [ext(5)], [hh(0)],
    { htc_w_per_k: 250, boiler_efficiency_used: 0.9 },
    { setpoint_c: 20 },
    'gas', 1.0,
  );
  assert(Math.abs(result.hp_capacity_kw - 5.75) < 0.01, 'T6a',
    `hp_capacity_kw = 5.75 (got ${result.hp_capacity_kw?.toFixed(3)})`);
  assert(Math.abs(result.cop_at_design_temp - 2.37) < 0.0001, 'T6b',
    `cop_at_design_temp = 2.37 (got ${result.cop_at_design_temp?.toFixed(4)})`);
  assert(Math.abs(result.hp_capacity_kw_elec - 5.75 / 2.37) < 0.01, 'T6c',
    `hp_capacity_kw_elec = 5.75/2.37 = 2.426 (got ${result.hp_capacity_kw_elec?.toFixed(3)})`);
}

// ===== T7 — HP capacity null inputs =====
// htc=null → hp_capacity_kw=null, hp_capacity_kw_elec=null; cop_by_hh still populated
{
  const result = estimateHeatPumpModel(
    [ext(5), ext(10)], [hh(1), hh(0)],
    { htc_w_per_k: null, boiler_efficiency_used: 0.9 },
    { setpoint_c: 20 },
    'gas', 1.0,
  );
  assert(result.hp_capacity_kw === null, 'T7a', 'hp_capacity_kw = null when htc = null');
  assert(result.hp_capacity_kw_elec === null, 'T7b', 'hp_capacity_kw_elec = null when htc = null');
  assert(result.cop_by_hh[0] !== null && result.cop_by_hh[1] !== null, 'T7c',
    'cop_by_hh populated even when htc = null');
  assert(result.validation_status === 'no_htc', 'T7d', "validation_status = 'no_htc'");
}

// ===== T8 — Demand-weighted mean COP =====
// HH0: temp=−3, kwh=2.0 → COP=2.37; HH1: temp=10, kwh=0.5 → COP=3.37; HH2: kwh=0 excluded
// annual_mean_cop = (2.0×2.37 + 0.5×3.37) / 2.5 = 6.425/2.5 = 2.57
{
  const external = [ext(-3), ext(10), ext(10)];
  const heating  = [hh(2.0), hh(0.5), hh(0)];
  const result = estimateHeatPumpModel(
    external, heating,
    { htc_w_per_k: null, boiler_efficiency_used: 0.9 },
    { setpoint_c: null },
    'gas', 1.0,
  );
  const expected = (2.0 * 2.37 + 0.5 * 3.37) / 2.5;
  assert(Math.abs(result.annual_mean_cop - expected) < 0.001, 'T8',
    `annual_mean_cop = ${expected.toFixed(3)} demand-weighted (got ${result.annual_mean_cop?.toFixed(3)})`);
}

// ===== T9 — cop_by_hh null passthrough =====
// One HH has temp_c=null → cop_by_hh[1]=null; others unaffected
{
  const external = [ext(10), { temp_c: null }, ext(5)];
  const heating  = [hh(1), hh(1), hh(1)];
  const result = estimateHeatPumpModel(
    external, heating,
    { htc_w_per_k: null, boiler_efficiency_used: 0.9 },
    { setpoint_c: null },
    'gas', 1.0,
  );
  assert(result.cop_by_hh[0] !== null, 'T9a', 'cop_by_hh[0] not null (temp=10)');
  assert(result.cop_by_hh[1] === null, 'T9b', 'cop_by_hh[1] = null when temp_c = null');
  assert(result.cop_by_hh[2] !== null, 'T9c', 'cop_by_hh[2] not null (temp=5)');
}

// ===== T10 — Design temperature constant =====
// result.design_temp_c === −3.0 (from HP_CONFIG.T_DESIGN_C)
// Same constant used in hp_capacity_kw formula: htc×(setpoint − T_design)/1000
{
  const result = estimateHeatPumpModel(
    [ext(5)], [hh(0)],
    { htc_w_per_k: 250, boiler_efficiency_used: 0.9 },
    { setpoint_c: 20 },
    'gas', 1.0,
  );
  assert(result.design_temp_c === -3.0, 'T10a', 'design_temp_c === −3.0');
  // Verify formula: 250×(20−(−3))/1000 = 5.75 kW
  assert(Math.abs(result.hp_capacity_kw - 250 * (20 - result.design_temp_c) / 1000) < 0.001, 'T10b',
    'hp_capacity_kw uses design_temp_c constant correctly');
}

// ===== T11 — Setpoint at or below design temp =====
// setpoint_c = −5°C (≤ −3°C) → hp_capacity_kw = null + warning
{
  const result = estimateHeatPumpModel(
    [ext(5)], [hh(0)],
    { htc_w_per_k: 250, boiler_efficiency_used: 0.9 },
    { setpoint_c: -5 },
    'gas', 1.0,
  );
  assert(result.hp_capacity_kw === null, 'T11a', 'hp_capacity_kw = null when setpoint ≤ T_design');
  assert(result.hp_capacity_kw_elec === null, 'T11b', 'hp_capacity_kw_elec = null when setpoint ≤ T_design');
  assert(result.warnings.some(w => w.includes('design outdoor temperature')), 'T11c',
    'Warning surfaced for setpoint below design temp');
}

// ===== T12 — EoH anchor exactness =====
// COP at exactly −3°C and 10°C (anchor points) must match anchor values exactly
{
  const cop_neg3 = copAt(-3, 1.0);
  const cop_10   = copAt(10, 1.0);
  assert(cop_neg3 === 2.37, 'T12a', `COP(−3°C,×1.0) === 2.37 exactly (no float drift, got ${cop_neg3})`);
  assert(cop_10  === 3.37, 'T12b', `COP(10°C,×1.0) === 3.37 exactly (no float drift, got ${cop_10})`);
}

// ===== Summary =====
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
