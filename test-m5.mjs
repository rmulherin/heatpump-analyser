// test-m5.mjs — Thermal Character (M5) synthetic unit tests
// Run: node test-m5.mjs  (from repo root)

import { estimateThermalCharacter } from './js/thermal-character.js';

let passed = 0, failed = 0;

function assert(condition, id, description) {
  if (condition) { console.log(`✅ ${id}: ${description}`); passed++; }
  else           { console.log(`❌ ${id}: ${description}`); failed++; }
}

// Sequential ISO timestamp (UTC), no real-calendar meaning needed for non-day tests
function ts(hhIndex) {
  const ms = Date.UTC(2025, 0, 1) + hhIndex * 30 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 19);
}

// Build a sequential HH array for tests that need a flat stream (no day structure)
function makeFlatHH(count, heatingFn, tempFn) {
  const heating = [], external = [];
  for (let i = 0; i < count; i++) {
    heating.push({ timestamp: ts(i), heating_kwh: heatingFn(i), is_absence: false });
    external.push({ temp_c: tempFn(i) });
  }
  return { heating, external };
}

// Build day-structured data: dayCount days × 48 HH, proper ISO dates
function makeDayHH(dayCount, heatingFn, tempFn, absenceFn) {
  const heating = [], external = [];
  for (let d = 0; d < dayCount; d++) {
    for (let h = 0; h < 48; h++) {
      const i = d * 48 + h;
      heating.push({
        timestamp: ts(i),
        heating_kwh: heatingFn(d, h),
        is_absence: absenceFn ? absenceFn(d, h) : false,
      });
      external.push({ temp_c: tempFn(d, h) });
    }
  }
  return { heating, external };
}

// ===== T1 — Setpoint recovery =====
// 90 days, HTC=280, η=0.9, T_set=19, 8-HH SS blocks at HH 40-47 per day
{
  const htc = 280, eta = 0.9, T_set = 19;
  const ssKwh = (temp) => htc * (T_set - temp) / (eta * 2000);

  const { heating, external } = makeDayHH(90,
    (d, h) => (h >= 40) ? ssKwh(3 + (d % 8)) : 0,
    (d, h) => 3 + (d % 8),
  );

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null);

  assert(result.setpoint_c !== null, 'T1a', 'setpoint_c not null');
  assert(Math.abs(result.setpoint_c - T_set) <= 0.5, 'T1b',
    `setpoint within ±0.5°C of 19 (got ${result.setpoint_c?.toFixed(2)}°C)`);
}

// ===== T2 — Setpoint clip =====
// Same as T1 but 5 HH per day at 2×SS (est ≈ 33°C → clipped, excluded from median)
{
  const htc = 280, eta = 0.9, T_set = 19, T_out = 5;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);

  const { heating, external } = makeDayHH(90,
    (d, h) => {
      if (h >= 40) return ssKwh;        // normal SS block
      if (h >= 20 && h < 25) return 2 * ssKwh; // 5 HH at 2×SS per day → est ≈ 33°C, clipped
      return 0;
    },
    () => T_out,
  );

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null);

  assert(result.setpoint_c !== null, 'T2a', 'setpoint_c not null with clipped data');
  assert(Math.abs(result.setpoint_c - T_set) <= 0.5, 'T2b',
    `setpoint ≈19°C despite 2×SS HH (got ${result.setpoint_c?.toFixed(2)}°C)`);
}

// ===== T3 — Occupancy weights structure =====
// 365 days, weekday heating at HH 12–17 (06:00–08:59) + HH 34–43 (17:00–21:59)
// 2025-01-01 = Wednesday → getDay() = 3
{
  const htc = 250, eta = 0.9, T_set = 20, T_out = 5;
  // SS heating that gives valid setpoint estimates (est = T_out + kwh*2000*eta/htc = 20)
  const ssKwh = htc * (T_set - T_out) / (eta * 2000); // 2.083 kWh

  // Day 0 = Wednesday (getDay=3), day 3 = Saturday (getDay=6), day 4 = Sunday (getDay=0)
  const BASE_DOW = 3; // Wednesday
  const isWeekday = (d) => { const dow = (BASE_DOW + d) % 7; return dow >= 1 && dow <= 5; };

  const { heating, external } = makeDayHH(365,
    (d, h) => {
      if (!isWeekday(d)) return 0;
      if (h >= 12 && h <= 17) return ssKwh; // morning block
      if (h >= 34 && h <= 43) return ssKwh; // evening block
      return 0;
    },
    () => T_out,
  );

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null);

  assert(result.occupancy_weights !== null, 'T3a', 'occupancy_weights not null');
  if (result.occupancy_weights) {
    const occ = result.occupancy_weights;
    assert(occ[12] >= 0.4 && occ[12] <= 0.8, 'T3b',
      `occ[12] (06:00) in [0.4,0.8] (got ${occ[12]?.toFixed(3)})`);
    assert(occ[34] >= 0.6 && occ[34] <= 0.85, 'T3c',
      `occ[34] (17:00) in [0.6,0.85] (got ${occ[34]?.toFixed(3)})`);
    assert(occ[4] < 0.05, 'T3d',
      `occ[4] (02:00) < 0.05 (got ${occ[4]?.toFixed(3)})`);
  }
}

// ===== T4 — Thermal mass recovery =====
// HTC=250, η=0.9, T_set=20, C_true=9000 kJ/K, T_out=5°C
// 15 events × [14 off, 4×6.80 kWh warmup, 6×2.083 kWh SS] = 360 HH (flat)
// Expected: thermal_mass_kj_per_k in [6791, 9189] (≈7990 ±15%)
{
  const htc = 250, eta = 0.9, T_set = 20, T_out = 5;
  const warmupKwh = 6.80;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000); // 2.083 kWh

  // Each event: 14 HH off, 4 HH warmup, 6 HH SS
  const EVENT_HH = 24; // 14 + 4 + 6
  const heating = [], external = [];
  for (let ev = 0; ev < 15; ev++) {
    for (let h = 0; h < EVENT_HH; h++) {
      const hhAbs = ev * EVENT_HH + h;
      let kwh = 0;
      if (h >= 14 && h < 18) kwh = warmupKwh;    // warmup
      if (h >= 18 && h < 24) kwh = ssKwh;         // steady state
      heating.push({ timestamp: ts(hhAbs), heating_kwh: kwh, is_absence: false });
      external.push({ temp_c: T_out });
    }
  }

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null);

  const C = result.thermal_mass_kj_per_k;
  assert(C !== null, 'T4a', 'thermal_mass_kj_per_k not null');
  assert(C !== null && C >= 6791 && C <= 9189, 'T4b',
    `thermal_mass in [6791,9189] — expected ≈7990 (got ${C?.toFixed(0)} kJ/K)`);
  assert(result.thermal_mass_events_used >= 5, 'T4c',
    `events_used ≥ 5 (got ${result.thermal_mass_events_used})`);
  // Rating: 6000 ≤ ~7990 < 15000 → 'medium'
  assert(result.thermal_mass_rating === 'medium', 'T4d',
    `rating = 'medium' for ~7990 kJ/K (got '${result.thermal_mass_rating}')`);
}

// ===== T5 — Time constant =====
// thermal_mass=12000 kJ/K, htc=300 W/K → τ = 12000/(300×3.6) = 11.111 h
// Drive via T4-like data scaled to produce C near 12000
// Alternative: verify τ = C/(htc×3.6) independently with a known-C scenario
// Use same structure as T4 but with HTC=300 and warmup sized for C≈12000
// Since we cannot directly set C, test T5 via the time_constant formula by
// verifying τ = result.thermal_mass_kj_per_k / (htc * 3.6) within 0.05 h
{
  const htc = 250, eta = 0.9, T_out = 5;
  // Use T4 result data: C≈7990, htc=250 → τ = 7990/(250×3.6) = 8.878 h
  // Instead: pass thermal_mass and htc through a wrapper — but these are internal.
  // Test: for any valid result with non-null mass and htc, verify the formula holds.
  const warmupKwh = 6.80;
  const ssKwh = htc * (20 - T_out) / (eta * 2000);
  const EVENT_HH = 24;
  const heating = [], external = [];
  for (let ev = 0; ev < 15; ev++) {
    for (let h = 0; h < EVENT_HH; h++) {
      const hhAbs = ev * EVENT_HH + h;
      let kwh = 0;
      if (h >= 14 && h < 18) kwh = warmupKwh;
      if (h >= 18 && h < 24) kwh = ssKwh;
      heating.push({ timestamp: ts(hhAbs), heating_kwh: kwh, is_absence: false });
      external.push({ temp_c: T_out });
    }
  }

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null);

  // If mass and time_constant both returned, verify formula: τ = C/(htc×3.6)
  if (result.thermal_mass_kj_per_k !== null && result.time_constant_hours !== null) {
    const expected_tau = result.thermal_mass_kj_per_k / (htc * 3.6);
    assert(Math.abs(result.time_constant_hours - expected_tau) < 0.001, 'T5a',
      `time_constant_hours = C/(htc×3.6) (got ${result.time_constant_hours?.toFixed(3)}, expected ${expected_tau.toFixed(3)})`);
  } else {
    assert(false, 'T5a', 'time_constant_hours not null (needed for formula check)');
  }
}

// ===== T6 — Null-HTC passthrough =====
{
  const { heating, external } = makeFlatHH(48, () => 1.0, () => 5);
  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: null, boiler_efficiency_used: 0.9 }, 'gas', null);

  assert(result.validation_status === 'no_htc', 'T6a', "validation_status = 'no_htc'");
  assert(result.setpoint_c === null, 'T6b', 'setpoint_c = null');
  assert(result.thermal_mass_kj_per_k === null, 'T6c', 'thermal_mass_kj_per_k = null');
  assert(result.time_constant_hours === null, 'T6d', 'time_constant_hours = null');
  assert(result.warnings.length === 0, 'T6e', 'no warnings on null-HTC passthrough');
}

// ===== T7 — Insufficient events (3 valid warm-up events) =====
// Prepend a 30-HH SS block to get setpoint_c, then 3 events
{
  const htc = 250, eta = 0.9, T_out = 5, T_set = 20;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);
  const warmupKwh = 6.80;

  const heating = [], external = [];
  // Setpoint block: 32 HH at SS (forms one sustained block → 30 valid estimates)
  for (let i = 0; i < 32; i++) {
    heating.push({ timestamp: ts(i), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
  }
  // 3 warmup events × [14 off, 4 warmup, 6 SS]
  const EVENT_HH = 24;
  for (let ev = 0; ev < 3; ev++) {
    for (let h = 0; h < EVENT_HH; h++) {
      const hhAbs = 32 + ev * EVENT_HH + h;
      let kwh = 0;
      if (h >= 14 && h < 18) kwh = warmupKwh;
      if (h >= 18 && h < 24) kwh = ssKwh;
      heating.push({ timestamp: ts(hhAbs), heating_kwh: kwh, is_absence: false });
      external.push({ temp_c: T_out });
    }
  }

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null);

  assert(result.thermal_mass_kj_per_k === null, 'T7a', 'thermal_mass_kj_per_k = null with 3 events');
  assert(result.thermal_mass_events_used === 3, 'T7b', `events_used = 3 (got ${result.thermal_mass_events_used})`);
  assert(result.warnings.some(w => w.includes('Not enough overnight')), 'T7c',
    '"Not enough overnight cold-soak events" warning surfaced');
}

// ===== T8 — Constant overnight heating =====
// All HH have heating_kwh ≥ 0.05 → no off periods → 'continuously overnight' warning
{
  const htc = 250, eta = 0.9, T_out = 5, T_set = 20;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000); // 2.083 kWh ≥ 0.05

  const { heating, external } = makeFlatHH(480, () => ssKwh, () => T_out);

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null);

  assert(result.thermal_mass_kj_per_k === null, 'T8a', 'thermal_mass_kj_per_k = null (no off periods)');
  assert(result.warnings.some(w => w.includes('continuously overnight')), 'T8b',
    '"continuously overnight" warning surfaced');
}

// ===== T9 — Rating boundaries (via known-value scenario) =====
// Derived from T4: C≈7990 → 'medium'. Exhaustive boundary values need internal access.
// T9a validated by T4d above. Here we check 'no_htc' returns null rating.
{
  const { heating, external } = makeFlatHH(48, () => 1.0, () => 5);
  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: null, boiler_efficiency_used: 0.9 }, 'gas', null);

  assert(result.thermal_mass_rating === null, 'T9a', 'thermal_mass_rating = null when no_htc');

  // Boundary constants (verified by code inspection: 6000, 15000, 30000 kJ/K)
  // Rating logic: < 6000 → low, < 15000 → medium, < 30000 → high, else very_high
  // T4 result (≈7990 kJ/K) → 'medium' is asserted in T4d above.
  console.log('   ℹ T9: exact boundary values (5999/6000/14999/15000/29999/30000) require exported helper');
  console.log('      Boundary thresholds verified by code inspection of TC_CONFIG in thermal-character.js');
}

// ===== T10 — Wall construction mismatch =====
// C=3500 kJ/K with solid_masonry (range 15000–45000) → warning
// C=3500 kJ/K with timber_frame (range 2000–8000) → no warning
// Drive via data that produces low C: short off period, small warmup
// Alternative: call with direct heatLoss values and check warning from checkWallConstruction
// Use T4-like data but solid_masonry declared. T4 gives C≈7990 which is still outside
// solid_masonry range [15000, 45000] → warning expected.
{
  const htc = 250, eta = 0.9, T_out = 5;
  const warmupKwh = 6.80;
  const ssKwh = htc * (20 - T_out) / (eta * 2000);
  const EVENT_HH = 24;
  const heating = [], external = [];
  for (let ev = 0; ev < 15; ev++) {
    for (let h = 0; h < EVENT_HH; h++) {
      const hhAbs = ev * EVENT_HH + h;
      let kwh = 0;
      if (h >= 14 && h < 18) kwh = warmupKwh;
      if (h >= 18 && h < 24) kwh = ssKwh;
      heating.push({ timestamp: ts(hhAbs), heating_kwh: kwh, is_absence: false });
      external.push({ temp_c: T_out });
    }
  }

  // T10a: C≈7990 with solid_masonry (15000–45000) → warning
  const resultSolid = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', 'solid_masonry');
  assert(resultSolid.warnings.some(w => w.includes('thermal mass') && w.includes('lower')), 'T10a',
    'Wall construction mismatch warning surfaced for solid_masonry (C < 15000)');

  // T10b: same C with cavity_wall (6000–20000) → no warning (7990 is within range)
  const resultCavity = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', 'cavity_wall');
  assert(!resultCavity.warnings.some(w => w.includes('thermal mass')), 'T10b',
    'No wall construction warning for cavity_wall (C in [6000,20000])');
}

// ===== Summary =====
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
