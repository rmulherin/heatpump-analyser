/**
 * Test suite for scripts/lib/synthesiser.mjs
 * Run: node test-synthesiser.mjs
 * Pass --offline to skip TC4 (network integration test)
 *
 * TCs covered: 1, 2, 3, 5, 6, 7, 10
 * TC4 (cache hit timing) requires network on first call — skipped by default.
 * TC8, TC9 are integration/statistical tests outside this suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  mulberry32,
  readConfigs,
  fetchWeatherCached,
  generateTimestamps,
  generateSchedule,
  generateHolidayWeeks,
  computeForwardModel,
  computeHWandCooking,
  computeElecBaseload,
  injectNoise,
  clampNonNeg,
  computeStats,
  writeOutputs,
  synthesise,
} from './scripts/lib/synthesiser.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// Minimal synthetic weather: N days of constant temp/solar
function makeWeather(n, tempC = 5, solarWm2 = 0) {
  const weather = [];
  for (let i = 0; i < n; i++) {
    weather.push({ timestamp: '', temp_c: tempC, solar_w_m2: solarWm2 });
  }
  return weather;
}

// Minimal archetype config for unit tests (no file I/O)
function minimalArchetype(overrides = {}) {
  return {
    slug: 'test-archetype',
    label: 'Test',
    bio:   'Test',
    display_order: 1,
    archetype_source: 'test',
    building: {
      htc_w_per_k: 200,
      thermal_mass_kj_per_k: 8000,
      boiler_efficiency: 1.0,
      solar_aperture_m2: 0,
      setpoint_c: 19,
    },
    schedule: {
      kind: 'twin_peak',
      weekday_windows:  [{ start_mins: 420, end_mins: 480 }],
      weekend_windows:  [{ start_mins: 420, end_mins: 480 }],
    },
    baseload: {
      gas_hot_water_kwh_per_day: 3.0,
      gas_cooking_kwh_per_day: 0.5,
      elec_baseload_kwh_per_day: 4.0,
      elec_appliance_events_per_week: 5,
    },
    location: { postcode: 'SW1A 1AA' },
    time_window: { start: '2025-01-01', end: '2025-12-31' },
    noise_overrides: { hh_residual_autocorr_lag1: 0.55, weekday_weekend_elec_ratio: 1.0 },
    prng_seed: 42,
    annual_gas_target_kwh: 5000,
    annual_elec_target_kwh: 2000,
    ...overrides,
  };
}

function minimalNoise() {
  return {
    measurement_noise:  { smart_meter_relative_sd: 0.02 },
    behavioural_noise:  {
      hh_residual_autocorr_lag1: 0.735,
      daily_residual_cv: 0.354,
    },
    schedule_jitter:   { boiler_start_sd_minutes: 15 },
    holiday_weeks:     { events_per_year: 7, mean_duration_days: 7.6 },
    weekday_weekend_elec_ratio_calibration_household: { ratio: 1.31 },
  };
}

// Write a minimal archetype + noise config to temp files, return paths
function writeTempConfigs(tmpDir, archetypeOverrides = {}) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const aPath = path.join(tmpDir, 'archetype.json');
  const nPath = path.join(tmpDir, 'noise.json');
  fs.writeFileSync(aPath, JSON.stringify(minimalArchetype(archetypeOverrides)));
  fs.writeFileSync(nPath, JSON.stringify(minimalNoise()));
  return { aPath, nPath };
}

// ── TC1 — PRNG reproducibility ────────────────────────────────────────────────

console.log('\nTC1 — PRNG reproducibility');
test('Two independent runs with seed 42 produce identical 1000-value sequences', () => {
  const prng1 = mulberry32(42);
  const prng2 = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const a = prng1();
    const b = prng2();
    assert.equal(a, b, `Mismatch at index ${i}: ${a} !== ${b}`);
  }
});

test('Two runs with different seeds diverge immediately', () => {
  const prng1 = mulberry32(42);
  const prng2 = mulberry32(99);
  const a = prng1();
  const b = prng2();
  assert.notEqual(a, b, 'Different seeds should produce different first values');
});

// ── TC2 — Forward model correctness ───────────────────────────────────────────

console.log('\nTC2 — Forward model correctness');
test('htc=200, setpoint=19, T=5, solar=0, efficiency=1.0 → gasHeating=1.4 kWh', () => {
  const archetype = minimalArchetype({
    building: {
      htc_w_per_k: 200,
      thermal_mass_kj_per_k: 8000,
      boiler_efficiency: 1.0,
      solar_aperture_m2: 0,
      setpoint_c: 19,
    },
  });
  const weather     = [{ temp_c: 5, solar_w_m2: 0 }];
  const timestampMs = [Date.UTC(2025, 0, 1, 6, 0, 0)];
  const heatingOn   = new Uint8Array([1]);
  const isAbsence   = new Uint8Array([0]);

  const { gasHeating, heatDemand } = computeForwardModel(archetype, timestampMs, weather, heatingOn, isAbsence);

  // heat_loss = 200 × (19-5) × 0.5 × 0.001 = 1.4 kWh
  assert.ok(Math.abs(gasHeating[0] - 1.4) < 1e-10, `Expected 1.4, got ${gasHeating[0]}`);
  assert.ok(Math.abs(heatDemand[0]  - 1.4) < 1e-10, `heatDemand expected 1.4, got ${heatDemand[0]}`);
});

test('Solar gain reduces heat demand', () => {
  const archetype = minimalArchetype({
    building: {
      htc_w_per_k: 200,
      thermal_mass_kj_per_k: 8000,
      boiler_efficiency: 1.0,
      solar_aperture_m2: 2.0,
      setpoint_c: 19,
    },
  });
  // solar_gain = 2.0 × 200 × 0.5 × 0.001 = 0.2 kWh; heat_demand = 1.4 - 0.2 = 1.2
  const weather     = [{ temp_c: 5, solar_w_m2: 200 }];
  const timestampMs = [Date.UTC(2025, 0, 1, 10, 0, 0)];
  const heatingOn   = new Uint8Array([1]);
  const isAbsence   = new Uint8Array([0]);
  const { heatDemand } = computeForwardModel(archetype, timestampMs, weather, heatingOn, isAbsence);
  assert.ok(Math.abs(heatDemand[0] - 1.2) < 1e-10, `Expected 1.2, got ${heatDemand[0]}`);
});

test('No heating when heatingOn=0', () => {
  const archetype   = minimalArchetype();
  const weather     = [{ temp_c: 5, solar_w_m2: 0 }];
  const timestampMs = [Date.UTC(2025, 0, 1, 2, 0, 0)];
  const heatingOn   = new Uint8Array([0]);
  const isAbsence   = new Uint8Array([0]);
  const { gasHeating } = computeForwardModel(archetype, timestampMs, weather, heatingOn, isAbsence);
  assert.equal(gasHeating[0], 0);
});

test('No heating when isAbsence=1', () => {
  const archetype   = minimalArchetype();
  const weather     = [{ temp_c: 5, solar_w_m2: 0 }];
  const timestampMs = [Date.UTC(2025, 0, 1, 6, 0, 0)];
  const heatingOn   = new Uint8Array([1]);
  const isAbsence   = new Uint8Array([1]);
  const { gasHeating } = computeForwardModel(archetype, timestampMs, weather, heatingOn, isAbsence);
  assert.equal(gasHeating[0], 0);
});

// ── TC3 — Schedule jitter symmetric ──────────────────────────────────────────
// Note: the plan specifies "mean start ≈ 08:00 ±1 min" but the 30-minute HH
// discretisation creates a structural positive bias (~14 min): a tiny positive j
// always shifts the first heated HH from 480→510 (+30 min), while an equal
// negative j keeps it at 480 (0 change). The correct symmetry test is:
// P(first_HH ≤ 480) ≈ P(first_HH > 480) ≈ 50% (zero-mean jitter → equal split).
// Deviation D1 recorded in plan.

console.log('\nTC3 — Schedule jitter symmetric');
test('Over 10,000 days, P(first heated HH ≤ 08:00) ≈ P(first heated HH > 08:00) ≈ 50% ± 2%', () => {
  const noise = minimalNoise();
  const archetype = minimalArchetype({
    schedule: {
      kind: 'twin_peak',
      weekday_windows:  [{ start_mins: 480, end_mins: 540 }],
      weekend_windows:  [{ start_mins: 480, end_mins: 540 }],
    },
  });

  const nDays = 10000;
  const nHH   = nDays * 48;
  const timestampMs = [];
  let ms = Date.UTC(2025, 0, 6, 0, 0, 0); // Monday
  for (let i = 0; i < nHH; i++) {
    timestampMs.push(ms);
    ms += 30 * 60 * 1000;
  }

  const prng = mulberry32(999);
  const heatingOn = generateSchedule(archetype.schedule, timestampMs, noise, prng);

  let earlyOrNominal = 0; // first heated HH ≤ 480 (08:00)
  let late = 0;           // first heated HH > 480 (08:00)
  for (let d = 0; d < nDays; d++) {
    const base = d * 48;
    for (let hh = 0; hh < 48; hh++) {
      if (heatingOn[base + hh]) {
        const minsMidnight = hh * 30;
        if (minsMidnight <= 480) earlyOrNominal++;
        else                     late++;
        break;
      }
    }
  }

  const fracEarly = earlyOrNominal / nDays;
  const fracLate  = late / nDays;
  // Expected: each fraction ≈ 50%. With 10,000 samples, 2-sigma ≈ 1% → use ±2% tolerance.
  assert.ok(
    Math.abs(fracEarly - 0.5) < 0.02,
    `P(first ≤ 08:00) = ${(fracEarly * 100).toFixed(1)}%, expected 50% ± 2%`
  );
  assert.ok(
    Math.abs(fracLate - 0.5) < 0.02,
    `P(first > 08:00) = ${(fracLate * 100).toFixed(1)}%, expected 50% ± 2%`
  );
});

// ── TC5 — CSV format ──────────────────────────────────────────────────────────

console.log('\nTC5 — CSV format');
await testAsync('CSV header, row format, row count, no nulls/undefined', async () => {
  const tmpDir = './bake-test-tmp/tc5';
  const { aPath, nPath } = writeTempConfigs(tmpDir + '/configs');

  // Use a 1-day time window to keep the test fast
  const archetype1Day = minimalArchetype({
    time_window: { start: '2025-06-15', end: '2025-06-15' },
    prng_seed: 101,
    annual_gas_target_kwh: 5000,
    annual_elec_target_kwh: 2000,
  });
  const a1Path = path.join(tmpDir + '/configs', 'archetype-1day.json');
  fs.writeFileSync(a1Path, JSON.stringify(archetype1Day));

  // Stub weather: write a cache file directly so no network call is needed
  const weatherCacheDir = tmpDir + '/weather';
  fs.mkdirSync(weatherCacheDir, { recursive: true });
  const postcode = archetype1Day.location.postcode.replace(/\s+/g, '').toLowerCase();
  const cacheKey  = `${postcode}-2025-06-15-2025-06-15.json`;
  const cacheWeather = [];
  for (let h = 0; h < 24; h++) {
    const hr = String(h).padStart(2, '0');
    cacheWeather.push({ timestamp: `2025-06-15 ${hr}:00`, temp_c: 15, solar_w_m2: 100 });
    cacheWeather.push({ timestamp: `2025-06-15 ${hr}:30`, temp_c: 15, solar_w_m2: 100 });
  }
  fs.writeFileSync(path.join(weatherCacheDir, cacheKey), JSON.stringify(cacheWeather));

  const result = await synthesise(a1Path, nPath, {
    outputDir:      tmpDir + '/output',
    weatherCacheDir,
  });

  const content = fs.readFileSync(result.csvPath, 'utf8');
  const lines   = content.trim().split('\n');

  assert.equal(lines[0], 'datetime,gas_kwh,electricity_kwh', 'Header mismatch');

  const dataLines = lines.slice(1);
  assert.equal(dataLines.length, 48, `Expected 48 data rows for 1 day, got ${dataLines.length}`);

  const rowPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2},\d+\.\d{4},\d+\.\d{4}$/;
  for (let i = 0; i < dataLines.length; i++) {
    assert.ok(rowPattern.test(dataLines[i]), `Row ${i + 1} does not match expected format: ${dataLines[i]}`);
  }

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── TC6 — No nulls, all non-negative ─────────────────────────────────────────

console.log('\nTC6 — No nulls, all non-negative');
await testAsync('All gas_kwh and electricity_kwh values are finite non-negative numbers', async () => {
  const tmpDir = './bake-test-tmp/tc6';
  const { aPath, nPath } = writeTempConfigs(tmpDir + '/configs', {
    time_window: { start: '2025-01-01', end: '2025-01-07' },
    prng_seed: 202,
  });

  const weatherCacheDir = tmpDir + '/weather';
  fs.mkdirSync(weatherCacheDir, { recursive: true });
  const postcode = 'sw1a1aa';
  const cacheKey  = `${postcode}-2025-01-01-2025-01-07.json`;
  const cacheWeather = [];
  for (let day = 1; day <= 7; day++) {
    const dateStr = `2025-01-0${day}`;
    for (let h = 0; h < 24; h++) {
      const hr = String(h).padStart(2, '0');
      cacheWeather.push({ timestamp: `${dateStr} ${hr}:00`, temp_c: 2, solar_w_m2: 10 });
      cacheWeather.push({ timestamp: `${dateStr} ${hr}:30`, temp_c: 2, solar_w_m2: 10 });
    }
  }
  fs.writeFileSync(path.join(weatherCacheDir, cacheKey), JSON.stringify(cacheWeather));

  const result = await synthesise(aPath, nPath, {
    outputDir:      tmpDir + '/output',
    weatherCacheDir,
  });

  const content = fs.readFileSync(result.csvPath, 'utf8');
  const lines   = content.trim().split('\n').slice(1);
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const gas   = parseFloat(parts[1]);
    const elec  = parseFloat(parts[2]);
    assert.ok(isFinite(gas)  && gas  >= 0, `Row ${i + 1} gas is not finite non-negative: ${gas}`);
    assert.ok(isFinite(elec) && elec >= 0, `Row ${i + 1} elec is not finite non-negative: ${elec}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── TC7 — Annual totals within ±20% of target ─────────────────────────────────
// Note: TC7 requires a real pre-populated weather cache (real London weather for
// SW1A 1AA, 2025-01-01 to 2025-12-31). The targets in the archetype configs were
// calibrated against real weather. Synthetic weather produces incorrect totals
// (solar floor / temperature profile mismatch). On first run, fetch real weather
// by running a full bake with network access; subsequent offline runs use the
// cache. TC7 skips if the cache is absent. Deviation D2 recorded in plan.

console.log('\nTC7 — Annual totals within ±20% of target');

const noiseConfigPath = './test-data/noise-config.json';
const tc7WeatherDir   = './bake-input/weather';
const tc7WeatherFile  = path.join(tc7WeatherDir, 'sw1a1aa-2025-01-01-2025-12-31.json');

async function tc7Archetype(archetypeConfigPath, weatherCacheDir) {
  const result = await synthesise(archetypeConfigPath, noiseConfigPath, {
    outputDir: `./bake-test-tmp/tc7/${path.basename(archetypeConfigPath, '.json')}`,
    weatherCacheDir,
  });
  const at = result.stats.annual_totals;
  return { slug: result.slug, gasDelta: at.gas_delta_pct, elecDelta: at.elec_delta_pct };
}

const archetypePaths = [
  './demo-configs/modern-out-for-work.json',
  './demo-configs/average-in-all-day.json',
  './demo-configs/small-and-efficient.json',
  './demo-configs/big-old-draughty.json',
];

if (!fs.existsSync(tc7WeatherFile)) {
  console.log('  ⚠ TC7 skipped — no real weather cache found at ' + tc7WeatherFile);
  console.log('    Run: node scripts/synthesise.mjs --archetype demo-configs/modern-out-for-work.json --noise-config test-data/noise-config.json --verbose');
  console.log('    to populate the cache, then re-run tests offline.\n');
} else {
  for (const aPath of archetypePaths) {
    await testAsync(`${path.basename(aPath, '.json')}: gas and elec within ±20% of target`, async () => {
      const { slug, gasDelta, elecDelta } = await tc7Archetype(aPath, tc7WeatherDir);
      assert.ok(
        Math.abs(gasDelta) <= 20,
        `${slug} gas delta ${gasDelta.toFixed(1)}% exceeds ±20%`
      );
      assert.ok(
        Math.abs(elecDelta) <= 20,
        `${slug} elec delta ${elecDelta.toFixed(1)}% exceeds ±20%`
      );
    });
  }
}

// ── TC10 — Reproducibility ────────────────────────────────────────────────────
// Uses the real weather cache from bake-input/weather if available (same as TC7).
// Falls back to a minimal synthetic cache so reproducibility can be verified
// without network access even when TC7 is skipped.

console.log('\nTC10 — Reproducibility');
await testAsync('Two bakes of modern-out-for-work with warm weather cache produce byte-identical CSVs', async () => {
  const outA = './bake-test-tmp/tc10/run-a';
  const outB = './bake-test-tmp/tc10/run-b';

  // Use real weather cache if available; otherwise build minimal synthetic cache
  let tc10WeatherDir = tc7WeatherDir;
  if (!fs.existsSync(tc7WeatherFile)) {
    tc10WeatherDir = './bake-test-tmp/tc10/weather';
    fs.mkdirSync(tc10WeatherDir, { recursive: true });
    const synthWeather = [];
    for (let day = 0; day < 365; day++) {
      const ms    = Date.UTC(2025, 0, 1) + day * 24 * 60 * 60 * 1000;
      const d     = new Date(ms);
      const yr    = d.getUTCFullYear();
      const mo    = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dt    = String(d.getUTCDate()).padStart(2, '0');
      const month = d.getUTCMonth() + 1;
      // Use 0 W/m² for solar floor (avoids lighting suppression in all months)
      const tempC     = 8 - 6 * Math.cos((2 * Math.PI * (month - 1)) / 12);
      const solarWm2  = Math.max(0, 200 * Math.sin((2 * Math.PI * (month - 3)) / 12));
      for (let h = 0; h < 24; h++) {
        const hr = String(h).padStart(2, '0');
        synthWeather.push({ timestamp: `${yr}-${mo}-${dt} ${hr}:00`, temp_c: tempC, solar_w_m2: solarWm2 });
        synthWeather.push({ timestamp: `${yr}-${mo}-${dt} ${hr}:30`, temp_c: tempC, solar_w_m2: solarWm2 });
      }
    }
    fs.writeFileSync(path.join(tc10WeatherDir, 'sw1a1aa-2025-01-01-2025-12-31.json'), JSON.stringify(synthWeather));
  }

  const resultA = await synthesise('./demo-configs/modern-out-for-work.json', noiseConfigPath, {
    outputDir: outA, weatherCacheDir: tc10WeatherDir,
  });
  const resultB = await synthesise('./demo-configs/modern-out-for-work.json', noiseConfigPath, {
    outputDir: outB, weatherCacheDir: tc10WeatherDir,
  });

  const csvA = fs.readFileSync(resultA.csvPath, 'utf8');
  const csvB = fs.readFileSync(resultB.csvPath, 'utf8');
  assert.equal(csvA, csvB, 'CSVs are not byte-identical across two runs');

  fs.rmSync('./bake-test-tmp/tc10', { recursive: true, force: true });
});

// ── Cleanup TC7 tmp ───────────────────────────────────────────────────────────
try { fs.rmSync('./bake-test-tmp/tc7', { recursive: true, force: true }); } catch (_) {}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
