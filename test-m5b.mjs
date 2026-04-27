// test-m5b.mjs — Thermal Character M5b (multi-path) synthetic unit tests
// Run: node test-m5b.mjs  (from repo root)
// Covers design doc tests T11–T21 per plan m5b-thermal-mass-multipath.md.

import { estimateThermalCharacter } from './js/thermal-character.js';

let passed = 0, failed = 0;

function assert(condition, id, description) {
  if (condition) { console.log(`✅ ${id}: ${description}`); passed++; }
  else           { console.log(`❌ ${id}: ${description}`); failed++; }
}

function ts(hhIndex) {
  const ms = Date.UTC(2025, 0, 1) + hhIndex * 30 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 19);
}

// ===== Shared event builders =====

// T4-style short-event stream: 15 events × [14 off, 4 warmup, 6 SS]
// HTC=250, η=0.9, T_set=20, T_out=5, warmupKwh=6.80
// First event anchor-fails (offStart=0); 14 events used → C≈7990 kJ/K, τ≈8.88h
function makeT4Data() {
  const htc = 250, eta = 0.9, T_set = 20, T_out = 5, warmupKwh = 6.80;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);
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
  return { heating, external, htc, eta };
}

// 5 long events designed to produce C≈9000 kJ/K when tAtRestart=14.
// Each event: [1 SS HH, 240 off+absence HH, 4 warmup HH, 6 SS HH] = 251 HH
// Warmup sized to target C=9000: E_warmup = (9000*5 + 250*(16.5-5)*2*3.6) / (3600*0.9) ≈ 20.278 kWh / 4 HH
// Also adds a 30-HH SS prefix block so setpoint inference passes (>20 estimates).
function makeLongEventData(htc = 250, eta = 0.9, T_set = 19, T_out = 5) {
  const ssKwh    = htc * (T_set - T_out) / (eta * 2000);
  // warmup energy: E_net = C*dT = 9000*(T_set - 14) = 9000*5 = 45000 kJ
  // E_heatloss = htc*(T_mean_wu - T_out)*t_wu*3.6 = 250*(16.5-5)*2*3.6 = 20700 kJ
  // E_warmup_kwh = (45000 + 20700) / (3600*0.9) ≈ 20.278 kWh over 4 HH
  const warmupKwhPerHh = (9000 * (T_set - 14) + htc * ((14 + T_set) / 2 - T_out) * 2 * 3.6)
                       / (4 * 3600 * eta);

  const heating = [], external = [];
  let idx = 0;

  // SS prefix for setpoint inference (30 HH → 28 estimates > SETPOINT_MIN_HH=20)
  for (let h = 0; h < 30; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }

  // 5 long events
  for (let ev = 0; ev < 5; ev++) {
    // anchor HH
    heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
    // 240 off HH with absence (long classification: >48 HH and contains absence)
    for (let h = 0; h < 240; h++) {
      heating.push({ timestamp: ts(idx), heating_kwh: 0, is_absence: true });
      external.push({ temp_c: T_out });
      idx++;
    }
    // 4 warmup HH
    for (let h = 0; h < 4; h++) {
      heating.push({ timestamp: ts(idx), heating_kwh: warmupKwhPerHh, is_absence: false });
      external.push({ temp_c: T_out });
      idx++;
    }
    // 6 SS HH
    for (let h = 0; h < 6; h++) {
      heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
      external.push({ temp_c: T_out });
      idx++;
    }
  }

  return { heating, external, htc, eta, T_set, T_out, ssKwh, warmupKwhPerHh };
}

// ===== T11 — Long event qualifies with t_at_restart_winter_c = 14 =====
{
  const { heating, external, htc, eta } = makeLongEventData();

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, 14, null);

  const C = result.thermal_mass_kj_per_k;
  assert(result.thermal_mass_source === 'measured_cold_soak', 'T11a-src',
    'T11: thermal_mass_source = "measured_cold_soak"');
  assert(C !== null && C >= 7650 && C <= 10350, 'T11a-C',
    `T11: C within ±15% of 9000 (got ${C?.toFixed(0)} kJ/K)`);
  assert(result.thermal_mass_events_used >= 1, 'T11b',
    `T11: thermal_mass_events_used >= 1 (got ${result.thermal_mass_events_used})`);
}

// ===== T12 — Long event without t_at_restart discarded =====
{
  const { heating, external, htc, eta } = makeLongEventData();

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, null);

  assert(result.long_event_discarded_for_missing_user_temp === true, 'T12a',
    'T12: long_event_discarded_for_missing_user_temp = true');
  assert(result.warnings.some(w => w.includes("returned home")), 'T12b',
    'T12: Step 4c "returned home" warning surfaced');
}

// ===== T13 — Short event under relaxed filter qualifies =====
// Uses a single short off-period (OFF_PERIOD_MIN_HH = 4) with no absence anywhere.
// Data: 30 SS HH (setpoint block), then [1 SS anchor, 4 off HH, 4 warmup, 6 SS].
{
  const htc = 250, eta = 0.9, T_set = 20, T_out = 5, warmupKwh = 6.80;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);
  const heating = [], external = [];
  let idx = 0;

  // 30 SS HH for setpoint
  for (let h = 0; h < 30; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }
  // anchor HH
  heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
  external.push({ temp_c: T_out });
  idx++;
  // 4 HH off, no absence (minimum qualifying length)
  for (let h = 0; h < 4; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: 0, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }
  // 4 warmup HH
  for (let h = 0; h < 4; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: warmupKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }
  // 6 SS HH
  for (let h = 0; h < 6; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, null);

  assert(result.thermal_mass_events_used >= 1, 'T13',
    `T13: short event contributes to events_used (got ${result.thermal_mass_events_used})`);
}

// ===== T14 — Anchor enforcement: off-period at offStart=0 (no preceding HH) =====
// Off-period that starts at HH 0 has no preceding HH; anchor check discards it.
// SS block after the warmup provides setpoint_c so estimateThermalMass is called.
{
  const htc = 250, eta = 0.9, T_set = 20, T_out = 5, warmupKwh = 6.80;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);
  const heating = [], external = [];
  let idx = 0;

  // 14 off HH at stream start → offStart = 0 → anchor check discards
  for (let h = 0; h < 14; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: 0, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }
  // 4 warmup + 30 SS (SS provides ≥20 setpoint estimates → setpoint_c non-null)
  for (let h = 0; h < 4; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: warmupKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }
  for (let h = 0; h < 30; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, null);

  assert(result.thermal_mass_events_used === 0, 'T14',
    `T14: event discarded (offStart=0, no preceding HH); events_used = 0 (got ${result.thermal_mass_events_used})`);
}

// ===== T14b — Anchor enforcement: is_absence = true immediately preceding =====
{
  const htc = 250, eta = 0.9, T_set = 20, T_out = 5, warmupKwh = 6.80;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);
  const heating = [], external = [];
  let idx = 0;

  for (let h = 0; h < 30; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }
  // anchor: positive heating but is_absence = true
  heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: true });
  external.push({ temp_c: T_out });
  idx++;
  for (let h = 0; h < 14; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: 0, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }
  for (let h = 0; h < 4; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: warmupKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }
  for (let h = 0; h < 6; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, null);

  assert(result.thermal_mass_events_used === 0, 'T14b',
    `T14b: event discarded (is_absence anchor); events_used = 0 (got ${result.thermal_mass_events_used})`);
}

// ===== T15 — Path B: continuous overnight heating + tau_bucket = "all_day", HTC=200 =====
// Expected: thermal_mass = 20 * 200 * 3.6 = 14400 kJ/K, source = "user_tau", validation = "acceptable"
{
  const htc = 200, eta = 0.9, T_set = 19, T_out = 5;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);
  const heating = [], external = [];
  // 480 HH of continuous SS heating (no off periods)
  for (let i = 0; i < 480; i++) {
    heating.push({ timestamp: ts(i), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
  }

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, 'all_day');

  assert(result.thermal_mass_kj_per_k === 14400, 'T15a-C',
    `T15: thermal_mass = 14400 kJ/K (got ${result.thermal_mass_kj_per_k})`);
  assert(result.thermal_mass_source === 'user_tau', 'T15a-src',
    `T15: thermal_mass_source = "user_tau" (got "${result.thermal_mass_source}")`);
  assert(result.validation_status === 'acceptable', 'T15a-val',
    `T15: validation_status = "acceptable" (got "${result.validation_status}")`);
  assert(result.warnings.some(w => w.includes('description of how the home holds')), 'T15b-warn',
    'T15b: Path B indicative warning present');
  assert(!result.warnings.some(w => w.includes('continuously overnight') || w.includes('Not enough overnight')), 'T15b-no-step4c',
    'T15b: no Step 4c warning when Path B succeeds');
}

// ===== T16 — Path A supersedes Path B when Path A produces ≥5 events =====
// Uses T4 setup + tau_bucket = "fast". Path A succeeds → Path B not activated.
{
  const { heating, external, htc, eta } = makeT4Data();

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, 'fast');

  assert(result.thermal_mass_source === 'measured_cold_soak', 'T16a-src',
    `T16: source = "measured_cold_soak" (got "${result.thermal_mass_source}")`);
  // T4 produces C≈7990 — same data, Path A result unchanged
  const C = result.thermal_mass_kj_per_k;
  assert(C !== null && C >= 6791 && C <= 9189, 'T16a-C',
    `T16: C within ±15% of 7990 (got ${C?.toFixed(0)} kJ/K)`);
  assert(!result.warnings.some(w => w.includes('description of how the home holds')), 'T16b',
    'T16b: Path B indicative warning NOT present when Path A succeeds');
}

// ===== T17 — Both paths fail: continuous overnight + no tau_bucket =====
// Uses 10 HH of continuous heating → setpoint_c = null (< SETPOINT_MIN_HH estimates)
// → both null → validation = "insufficient_data"
{
  const htc = 250, eta = 0.9, T_set = 19, T_out = 5;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);
  const heating = [], external = [];
  for (let i = 0; i < 10; i++) {
    heating.push({ timestamp: ts(i), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
  }

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, null);

  assert(result.thermal_mass_kj_per_k === null, 'T17a-C',
    `T17: thermal_mass = null`);
  assert(result.thermal_mass_source === null, 'T17a-src',
    `T17: thermal_mass_source = null`);
  assert(result.validation_status === 'insufficient_data', 'T17a-val',
    `T17: validation_status = "insufficient_data" (got "${result.validation_status}")`);
  assert(result.warnings.some(w => w.includes('continuously overnight')), 'T17b',
    'T17b: "continuously overnight" Step 4c warning present');
}

// ===== T18 — Sanity-check warning fires when ratio outside [0.5, 2.0] =====
// T4 data: C≈7990, HTC=250, τ≈8.88h. tau_bucket = "stays_for_days" (40h midpoint)
// ratio = 8.88/40 = 0.222 < 0.5 → warning fires; C value retained.
{
  const { heating, external, htc, eta } = makeT4Data();

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, 'stays_for_days');

  assert(result.warnings.some(w => w.includes('data suggests a thermal time constant')), 'T18a',
    'T18: sanity-check warning surfaced');
  assert(result.thermal_mass_kj_per_k !== null, 'T18b',
    `T18: thermal_mass_kj_per_k retained (not null) after sanity warning`);
}

// ===== T19 — Sanity-check suppressed when ratio inside [0.5, 2.0] =====
// T4 data: τ≈8.88h. tau_bucket = "evening" (10h midpoint). ratio ≈ 0.888 — within bounds.
{
  const { heating, external, htc, eta } = makeT4Data();

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, 'evening');

  assert(!result.warnings.some(w => w.includes('data suggests a thermal time constant')), 'T19',
    'T19: no sanity-check warning when ratio within [0.5, 2.0]');
}

// ===== T20a — t_at_restart = 22°C outside [5, 19] → range warning =====
{
  const { heating, external, htc, eta } = makeLongEventData();

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, 22, null);

  assert(result.warnings.some(w => w.includes('outside the') && w.includes('plausible range')), 'T20a',
    'T20a: "outside plausible range" warning for t_at_restart = 22');
}

// ===== T20b — t_at_restart = 3°C outside [5, 19] → range warning =====
{
  const { heating, external, htc, eta } = makeLongEventData();

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, 3, null);

  assert(result.warnings.some(w => w.includes('outside the') && w.includes('plausible range')), 'T20b',
    'T20b: "outside plausible range" warning for t_at_restart = 3');
}

// ===== T20c — t_at_restart = 18°C ≥ inferred setpoint ≈17°C → setpoint warning =====
// Use T_set=17 so setpoint_c ≈ 17, then t_at_restart=18 ≥ setpoint → warning, treated as null.
{
  const htc = 250, eta = 0.9, T_set = 17, T_out = 5;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);
  const heating = [], external = [];
  let idx = 0;

  // 30 SS HH for setpoint (estimates ≈ T_set = 17, within [14,25])
  for (let h = 0; h < 30; h++) {
    heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
  }
  // 5 long events (same design, but T_set = 17; warmup sized for C≈9000 with T_at_restart=14)
  // Since t_at_restart=18 will be ignored, no mass estimate occurs. We just need the structure.
  const warmupKwh = ssKwh * 10; // arbitrary large warmup to ensure scan picks up HH
  for (let ev = 0; ev < 5; ev++) {
    heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
    idx++;
    for (let h = 0; h < 240; h++) {
      heating.push({ timestamp: ts(idx), heating_kwh: 0, is_absence: true });
      external.push({ temp_c: T_out });
      idx++;
    }
    for (let h = 0; h < 4; h++) {
      heating.push({ timestamp: ts(idx), heating_kwh: warmupKwh, is_absence: false });
      external.push({ temp_c: T_out });
      idx++;
    }
    for (let h = 0; h < 6; h++) {
      heating.push({ timestamp: ts(idx), heating_kwh: ssKwh, is_absence: false });
      external.push({ temp_c: T_out });
      idx++;
    }
  }

  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, 18, null);

  assert(result.warnings.some(w => w.includes('at or above') && w.includes('setpoint')), 'T20c',
    'T20c: "at or above setpoint" warning for t_at_restart = 18 with setpoint ≈ 17');
}

// ===== T21 — thermal_mass_kj_per_k === null ↔ thermal_mass_source === null (all paths) =====

// T21a: both paths fail (T17 setup) → both null
{
  const htc = 250, eta = 0.9, T_set = 19, T_out = 5;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);
  const heating = [], external = [];
  for (let i = 0; i < 10; i++) {
    heating.push({ timestamp: ts(i), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
  }
  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, null);
  assert(result.thermal_mass_kj_per_k === null && result.thermal_mass_source === null, 'T21a',
    'T21a: both paths fail → mass=null and source=null');
}

// T21b: Path B succeeds (T15 setup with all_day) → both non-null
{
  const htc = 200, eta = 0.9, T_set = 19, T_out = 5;
  const ssKwh = htc * (T_set - T_out) / (eta * 2000);
  const heating = [], external = [];
  for (let i = 0; i < 480; i++) {
    heating.push({ timestamp: ts(i), heating_kwh: ssKwh, is_absence: false });
    external.push({ temp_c: T_out });
  }
  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, 'all_day');
  assert(result.thermal_mass_kj_per_k !== null && result.thermal_mass_source === 'user_tau', 'T21b',
    `T21b: Path B → mass non-null and source="user_tau" (got ${result.thermal_mass_kj_per_k}, "${result.thermal_mass_source}")`);
}

// T21c: Path A succeeds (T4 setup, no tau_bucket) → measured_cold_soak
{
  const { heating, external, htc, eta } = makeT4Data();
  const result = estimateThermalCharacter(heating, external,
    { htc_w_per_k: htc, boiler_efficiency_used: eta }, 'gas', null, null, null);
  assert(result.thermal_mass_kj_per_k !== null && result.thermal_mass_source === 'measured_cold_soak', 'T21c',
    `T21c: Path A → mass non-null and source="measured_cold_soak" (got ${result.thermal_mass_kj_per_k?.toFixed(0)}, "${result.thermal_mass_source}")`);
}

// ===== Summary =====
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
