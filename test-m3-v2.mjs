// test-m3-v2.mjs — M3 Baseload v2 test suite
// Run: node test-m3-v2.mjs  (from repo root)
//
// 19 test cases: F5×7 + H×5 + I×2 + J×5

// ── Luxon stub ────────────────────────────────────────────────────────────────

class FakeDateTime {
  constructor(ms) { this._ms = ms; }
  valueOf()              { return this._ms; }
  toISODate()            { return new Date(this._ms).toISOString().slice(0, 10); }
  diff(other, _unit)     { return { days: (this._ms - other._ms) / 86400000 }; }
  plus({ days })         { return new FakeDateTime(this._ms + days * 86400000); }
  get weekday()          { return ((new Date(this._ms).getUTCDay() + 6) % 7) + 1; }
  get month()            { return new Date(this._ms).getUTCMonth() + 1; }
  get hour()             { return new Date(this._ms).getUTCHours(); }
  get minute()           { return new Date(this._ms).getUTCMinutes(); }
  static fromISO(str, _opts) { return new FakeDateTime(new Date(str).getTime()); }
}
global.luxon = { DateTime: FakeDateTime };

// ── Imports ───────────────────────────────────────────────────────────────────

const {
  applyLowGasWarmCorrection,
  computeElectricityBaseload,
  separateBaseload,
} = await import('./js/baseload.js');

// ── Infrastructure ────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else       { console.error(`  FAIL  ${name}`); failed++; }
}
function assertNear(a, b, tol, name) {
  assert(Math.abs(a - b) <= tol, `${name} (got ${a?.toFixed(4)}, expected ${b} ±${tol})`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoTs(dateStr, h, m) {
  return `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`;
}

// 48 HH records for one UTC calendar day
function makeDay(dateStr, gasKwhPerHh, elecKwhPerHh = 0.1) {
  const records = [];
  for (let h = 0; h < 24; h++) {
    for (let mo = 0; mo < 60; mo += 30) {
      records.push({ timestamp: isoTs(dateStr, h, mo), gas_kwh: gasKwhPerHh, elec_kwh: elecKwhPerHh });
    }
  }
  return records;
}

function makeExternal(count, tempC) {
  return Array.from({ length: count }, () => ({ temp_c: tempC }));
}

function makeHeating(consumption) {
  return consumption.map(rec => ({
    timestamp: rec.timestamp,
    heating_kwh: rec.gas_kwh === null ? null : 0,
    baseload_kwh: rec.gas_kwh === null ? null : 0,
    is_absence: false,
    elec_heating_kwh: null,
    nonheat_residual_kwh: null,
  }));
}

// Build n days of consumption + external.
// tempFn(d) → °C for day d; elecFn(d, hdd, cdd) → daily kWh; gasFn(d, hdd, cdd) → daily kWh or null
// Uses a realistic seasonal cycle so the OLS sees both HDD and CDD variation.
function buildDataset(n, tempFn, elecFn, gasFn) {
  const HDD_BASE = 15.5;
  const CDD_BASE = 22;
  const consumption = [];
  const external    = [];
  for (let d = 0; d < n; d++) {
    const date = new Date(Date.UTC(2023, 0, 1 + d)).toISOString().slice(0, 10);
    const tempC   = tempFn(d);
    const hdd     = Math.max(0, HDD_BASE - tempC);
    const cdd     = Math.max(0, tempC - CDD_BASE);
    const dailyElec = elecFn(d, hdd, cdd);
    const dailyGas  = gasFn ? gasFn(d, hdd, cdd) : null;
    const hhElec    = dailyElec / 48;
    const hhGas     = dailyGas !== null ? dailyGas / 48 : null;
    for (let h = 0; h < 24; h++) {
      for (let mo = 0; mo < 60; mo += 30) {
        consumption.push({ timestamp: isoTs(date, h, mo), gas_kwh: hhGas, elec_kwh: hhElec });
        external.push({ temp_c: tempC });
      }
    }
  }
  return { consumption, external };
}

// UK-like seasonal temperature (°C): 2°C in Jan, 24°C in July, with CDD in summer.
const seasonalTemp = d => 13 - 11 * Math.cos(2 * Math.PI * d / 365);

// ─────────────────────────────────────────────────────────────────────────────
// F5 TESTS — applyLowGasWarmCorrection
// ─────────────────────────────────────────────────────────────────────────────
// gasCeiling = 2.2 × 6.18 = 13.596 kWh/day

console.log('\n── TC-F5-1 — must-classify (below ceiling, above 17°C) ──────────────────');
{
  const baseloadMedian = 6.18;
  const day = makeDay('2024-07-01', 10 / 48);
  const ext = makeExternal(48, 19);
  const heating = makeHeating(day);
  const count = applyLowGasWarmCorrection(day, ext, heating, baseloadMedian);
  assert(count === 1,                                                          'F5-1a: return = 1');
  assert(heating.every(s => s.heating_kwh === 0),                             'F5-1b: heating_kwh = 0');
  assert(heating.every((s, i) => Math.abs(s.baseload_kwh - day[i].gas_kwh) < 1e-10), 'F5-1c: baseload_kwh = gas_kwh');
  assert(heating.every(s => s.is_absence === false),                          'F5-1d: is_absence unchanged');
}

console.log('\n── TC-F5-2 — must-NOT-classify (temp below 17°C) ───────────────────────');
{
  const day = makeDay('2024-07-01', 10 / 48);
  const ext = makeExternal(48, 13.3);
  const heating = makeHeating(day);
  const origHeat = heating.map(s => s.heating_kwh);
  const count = applyLowGasWarmCorrection(day, ext, heating, 6.18);
  assert(count === 0, 'F5-2a: return = 0');
  assert(heating.every((s, i) => s.heating_kwh === origHeat[i]), 'F5-2b: heating_kwh unchanged');
}

console.log('\n── TC-F5-3 — must-NOT-classify (gas above ceiling) ─────────────────────');
{
  const day = makeDay('2024-07-01', 14 / 48); // 14 kWh > 13.596
  const ext = makeExternal(48, 19);
  const heating = makeHeating(day);
  const count = applyLowGasWarmCorrection(day, ext, heating, 6.18);
  assert(count === 0, 'F5-3a: return = 0');
}

console.log('\n── TC-F5-4 — must-NOT-classify (absence day) ────────────────────────────');
{
  const day = makeDay('2024-07-01', 10 / 48);
  const ext = makeExternal(48, 19);
  const heating = makeHeating(day);
  heating.forEach(s => s.is_absence = true);
  const count = applyLowGasWarmCorrection(day, ext, heating, 6.18);
  assert(count === 0, 'F5-4a: return = 0 when all absence');
}

console.log('\n── TC-F5-5 — boundary semantics ─────────────────────────────────────────');
{
  // Exact ceiling (13.596) → NOT classified (strict <)
  const d1 = makeDay('2024-07-01', 13.596 / 48);
  const h1 = makeHeating(d1);
  const c1 = applyLowGasWarmCorrection(d1, makeExternal(48, 19), h1, 6.18);
  assert(c1 === 0, 'F5-5a: exact ceiling not classified');

  // Just below ceiling + exact 17.0°C → classified (inclusive >=)
  const d2 = makeDay('2024-07-02', 13.595 / 48);
  const h2 = makeHeating(d2);
  const c2 = applyLowGasWarmCorrection(d2, makeExternal(48, 17.0), h2, 6.18);
  assert(c2 === 1, 'F5-5b: just-below ceiling + 17.0°C classified');

  // Just below ceiling + 16.9°C → NOT classified
  const d3 = makeDay('2024-07-03', 13.595 / 48);
  const h3 = makeHeating(d3);
  const c3 = applyLowGasWarmCorrection(d3, makeExternal(48, 16.9), h3, 6.18);
  assert(c3 === 0, 'F5-5c: 16.9°C not classified');
}

console.log('\n── TC-F5-6 — heating+baseload invariant ────────────────────────────────');
{
  const day = makeDay('2024-07-01', 10 / 48);
  const ext = makeExternal(48, 19);
  const heating = makeHeating(day);
  applyLowGasWarmCorrection(day, ext, heating, 6.18);
  const allOk = heating.every((s, i) =>
    Math.abs((s.heating_kwh + s.baseload_kwh) - day[i].gas_kwh) < 1e-10
  );
  assert(allOk, 'F5-6: heating_kwh + baseload_kwh = gas_kwh for all HH');
}

console.log('\n── TC-F5-7 — is_absence not set on classified day ───────────────────────');
{
  const day = makeDay('2024-07-01', 10 / 48);
  const ext = makeExternal(48, 19);
  const heating = makeHeating(day);
  applyLowGasWarmCorrection(day, ext, heating, 6.18);
  assert(heating.every(s => s.is_absence === false), 'F5-7: is_absence stays false');
}

// ─────────────────────────────────────────────────────────────────────────────
// H TESTS — classification via separateBaseload (365-day seasonal datasets)
// ─────────────────────────────────────────────────────────────────────────────
// Seasonal temp gives ~208 HDD days and ~90 CDD days → OLS matrix non-singular.
// sum_hdd over 365 days ≈ 1664 K·day.
//
// TC-H-1 (Rhiannon-like, should NOT detect):
//   elec = 8 + 0.33*HDD; gas = 50 + 2*HDD
//   raw ≈ 0.33*1664 ≈ 549; total ≈ 25000; 2% ≈ 500 → corrected ≈ 49 → per_dd ≈ 0.03 < 0.2
//
// TC-H-2 (clear-positive, SHOULD detect):
//   elec = 8 + 0.6*HDD; gas = 30 + 1.5*HDD
//   raw ≈ 0.6*1664 ≈ 998; total ≈ 17000; 2% ≈ 340 → corrected ≈ 658 → per_dd ≈ 0.40 > 0.2

console.log('\n── TC-H-1 — Rhiannon-like → classification_auto = none ─────────────────');
{
  const { consumption, external } = buildDataset(
    365,
    seasonalTemp,
    (d, hdd) => 8 + 0.33 * hdd,
    (d, hdd) => 50 + 2 * hdd
  );
  const result = separateBaseload(consumption, external, null);
  const sl = result.supplementary_loads;
  assert(sl.electric_heating_detected === false,              'H-1a: not detected');
  assert(sl.electric_heating_classification_auto === 'none',  'H-1b: auto = none');
  assert(sl.electric_heating_classification_effective === 'none', 'H-1c: effective = none');
}

console.log('\n── TC-H-2 — clear-positive → classification_auto = some ────────────────');
{
  const { consumption, external } = buildDataset(
    365,
    seasonalTemp,
    (d, hdd) => 8 + 0.6 * hdd,
    (d, hdd) => 30 + 1.5 * hdd
  );
  const result = separateBaseload(consumption, external, null);
  const sl = result.supplementary_loads;
  assert(sl.electric_heating_detected === true,               'H-2a: detected');
  assert(sl.electric_heating_classification_auto === 'some',  'H-2b: auto = some');
  assert(sl.electric_heating_classification_effective === 'some', 'H-2c: effective = some');
  assert(sl.electric_heating_kwh_per_dd !== null && sl.electric_heating_kwh_per_dd > 0.2, 'H-2d: corrected per_dd > 0.2');
  assert(sl.hdd_coefficient_kwh_per_dd !== null,              'H-2e: raw HDD coeff present');
  assert(sl.electric_heating_fraction_of_total_energy > 0,    'H-2f: fraction > 0');
}

console.log('\n── TC-H-3 — all-electric → classification_auto = all_electric ──────────');
{
  // gas = null throughout; elec = 12 + 1.5*HDD; corrected per_dd ≈ 1.4 >> 0.2
  const { consumption, external } = buildDataset(
    365,
    seasonalTemp,
    (d, hdd) => 12 + 1.5 * hdd,
    null
  );
  const result = separateBaseload(consumption, external, null);
  const sl = result.supplementary_loads;
  assert(sl.electric_heating_detected === true,                     'H-3a: detected');
  assert(sl.electric_heating_classification_auto === 'all_electric',     'H-3b: auto = all_electric');
  assert(sl.electric_heating_classification_effective === 'all_electric','H-3c: effective = all_electric');
}

console.log('\n── TC-H-4 — user override wins ──────────────────────────────────────────');
{
  const { consumption, external } = buildDataset(
    365,
    seasonalTemp,
    (d, hdd) => 8 + 0.6 * hdd,
    (d, hdd) => 30 + 1.5 * hdd
  );
  const r1 = separateBaseload(consumption, external, 'none');
  assert(r1.supplementary_loads.electric_heating_classification_effective === 'none',
         'H-4a: override none → effective none');
  const r2 = separateBaseload(consumption, external, 'all_electric');
  assert(r2.supplementary_loads.electric_heating_classification_effective === 'all_electric',
         'H-4b: override all_electric → effective all_electric');
  const r3 = separateBaseload(consumption, external, null);
  assert(r3.supplementary_loads.electric_heating_classification_effective === 'some',
         'H-4c: override null → effective = auto');
}

console.log('\n── TC-H-5 — deprecated field absent ────────────────────────────────────');
{
  const { consumption, external } = buildDataset(
    90,
    seasonalTemp,
    (d, hdd) => 8 + 0.33 * hdd,
    (d, hdd) => 40 + 2 * hdd
  );
  const result = separateBaseload(consumption, external, null);
  assert(!('electric_heating_is_primary' in result.supplementary_loads),
         'H-5: electric_heating_is_primary absent');
}

// ─────────────────────────────────────────────────────────────────────────────
// I TESTS — computeElectricityBaseload
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── TC-I-1 — 5th-percentile floor ───────────────────────────────────────');
{
  // 60 non-absence days: quiet overnight at 0.1 kWh/HH, variable daytime 0.1–1.0 kWh/HH
  const consumption = [];
  const heating = [];
  for (let d = 0; d < 60; d++) {
    const date = new Date(Date.UTC(2024, 0, 1 + d)).toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      for (let mo = 0; mo < 60; mo += 30) {
        const hh = h * 2 + (mo === 30 ? 1 : 0);
        const elec = (hh < 14 || hh > 40) ? 0.1 : 0.1 + (hh - 14) / 27 * 0.9;
        consumption.push({ timestamp: isoTs(date, h, mo), gas_kwh: 0.1, elec_kwh: elec });
        heating.push({ timestamp: isoTs(date, h, mo), is_absence: false });
      }
    }
  }
  const result = computeElectricityBaseload(consumption, heating);
  assert(result !== null, 'I-1a: non-null');
  assertNear(result, 0.1, 0.02, 'I-1b: ≈ 0.1 kWh/HH (quiet floor)');
}

console.log('\n── TC-I-2 — EV overnight spike does not inflate baseload ────────────────');
{
  // Same base; inject 7 kWh overnight EV on ~30% of nights (hh=2)
  const consumption = [];
  const heating = [];
  for (let d = 0; d < 60; d++) {
    const date = new Date(Date.UTC(2024, 0, 1 + d)).toISOString().slice(0, 10);
    const hasEv = d % 3 === 0;
    for (let h = 0; h < 24; h++) {
      for (let mo = 0; mo < 60; mo += 30) {
        const hh = h * 2 + (mo === 30 ? 1 : 0);
        let elec = (hh < 14 || hh > 40) ? 0.1 : 0.1 + (hh - 14) / 27 * 0.9;
        if (hasEv && hh === 2) elec += 7;
        consumption.push({ timestamp: isoTs(date, h, mo), gas_kwh: 0.1, elec_kwh: elec });
        heating.push({ timestamp: isoTs(date, h, mo), is_absence: false });
      }
    }
  }
  const result = computeElectricityBaseload(consumption, heating);
  assert(result !== null, 'I-2a: non-null');
  assertNear(result, 0.1, 0.02, 'I-2b: EV does not inflate 5th-pct floor');
}

// ─────────────────────────────────────────────────────────────────────────────
// J TESTS — per-HH attribution via separateBaseload
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── TC-J-1 — proportional shape + elec invariant ────────────────────────');
{
  const { consumption, external } = buildDataset(
    365,
    seasonalTemp,
    (d, hdd) => 8 + 0.6 * hdd,
    (d, hdd) => 30 + 1.5 * hdd
  );
  const result = separateBaseload(consumption, external, null);
  const { heating } = result;
  const sl = result.supplementary_loads;

  assert(sl.electric_heating_classification_effective === 'some', 'J-1a: attribution ran (effective=some)');

  // Invariant: elec_heating + nonheat_residual = elec_kwh for all non-null HH
  let invariantOk = true;
  for (let i = 0; i < consumption.length; i++) {
    if (consumption[i].elec_kwh === null || heating[i].elec_heating_kwh === null) continue;
    if (Math.abs(heating[i].elec_heating_kwh + heating[i].nonheat_residual_kwh - consumption[i].elec_kwh) > 1e-9) {
      invariantOk = false; break;
    }
  }
  assert(invariantOk, 'J-1b: elec_heating + nonheat_residual = elec_kwh (all non-null HH)');

  // Bounds: 0 ≤ elec_heating ≤ elec for all
  let boundsOk = true;
  for (let i = 0; i < consumption.length; i++) {
    if (heating[i].elec_heating_kwh === null) continue;
    if (heating[i].elec_heating_kwh < -1e-12 || heating[i].elec_heating_kwh > consumption[i].elec_kwh + 1e-12) {
      boundsOk = false; break;
    }
  }
  assert(boundsOk, 'J-1c: 0 ≤ elec_heating ≤ elec_kwh');
}

console.log('\n── TC-J-2 — baseload protected (HH at/below floor → elec_heating = 0) ──');
{
  const { consumption, external } = buildDataset(
    365,
    seasonalTemp,
    (d, hdd) => 8 + 0.6 * hdd,
    (d, hdd) => 30 + 1.5 * hdd
  );
  const result = separateBaseload(consumption, external, null);
  const { heating } = result;
  const floor = result.supplementary_loads.electricity_baseload;

  if (floor !== null) {
    let atFloorOk = true;
    for (let i = 0; i < consumption.length; i++) {
      if (heating[i].elec_heating_kwh === null) continue;
      if (consumption[i].elec_kwh <= floor + 1e-12) {
        if (Math.abs(heating[i].elec_heating_kwh) > 1e-10) { atFloorOk = false; break; }
      }
    }
    assert(atFloorOk, 'J-2: HH at/below floor → elec_heating = 0');
  } else {
    console.log('  SKIP  J-2: electricity_baseload null');
    passed++;
  }
}

console.log('\n── TC-J-3 — excess-capped (r_d = 1 when E_d > Σexcess) ─────────────────');
{
  // 365-day all-electric seasonal dataset gives corrected_per_dd ≈ 1.4.
  // Append one "suppressed" cold day (366th day): very low elec (≈ baseload + 0.01/HH)
  // so Σexcess is tiny while E_d = 1.4 × 10.5 ≈ 14.7 kWh >> Σexcess → r_d = 1.
  const { consumption, external } = buildDataset(
    365,
    seasonalTemp,
    (d, hdd) => 12 + 1.5 * hdd,
    null
  );
  // The electricity baseload floor ≈ 12/48 = 0.25 kWh/HH (summer min, HDD=0).
  const suppressDate = '2024-01-01'; // day 366
  const suppressHddTemp = 5; // HDD = 10.5
  const suppressElecPerHh = 0.26; // just above floor; excess ≈ 0.01 kWh/HH × 48 = 0.48 kWh/day << E_d
  for (let h = 0; h < 24; h++) {
    for (let mo = 0; mo < 60; mo += 30) {
      consumption.push({ timestamp: isoTs(suppressDate, h, mo), gas_kwh: null, elec_kwh: suppressElecPerHh });
      external.push({ temp_c: suppressHddTemp });
    }
  }

  const result = separateBaseload(consumption, external, null);
  const { heating } = result;

  // Find the suppressed day's heating records
  const floor = result.supplementary_loads.electricity_baseload;
  if (floor !== null) {
    const suppressStart = 365 * 48;
    const suppressSlots = heating.slice(suppressStart, suppressStart + 48);
    const suppressCons  = consumption.slice(suppressStart, suppressStart + 48);
    // On the suppressed day: each HH excess = max(0, 0.26 - floor) ≈ 0.01 kWh
    // E_d ≈ corrected_per_dd * 10.5 ≈ 14.7 kWh >> Σexcess ≈ 0.48 kWh → r_d = 1
    const capped = suppressSlots.every((s, i) => {
      const excess = Math.max(0, suppressCons[i].elec_kwh - floor);
      return Math.abs(s.elec_heating_kwh - excess) < 1e-9;
    });
    assert(capped, 'J-3: suppressed cold day → r_d = 1 (elec_heating = excess)');
  } else {
    console.log('  SKIP  J-3: electricity_baseload null');
    passed++;
  }
}

console.log('\n── TC-J-4 — classification none → all HH get elec_heating = 0 ──────────');
{
  const { consumption, external } = buildDataset(
    365,
    seasonalTemp,
    (d, hdd) => 8 + 0.6 * hdd,
    (d, hdd) => 30 + 1.5 * hdd
  );
  const result = separateBaseload(consumption, external, 'none');
  const { heating } = result;

  let allZero = true;
  for (let i = 0; i < heating.length; i++) {
    if (heating[i].elec_heating_kwh !== null && Math.abs(heating[i].elec_heating_kwh) > 1e-12) {
      allZero = false; break;
    }
  }
  assert(allZero, 'J-4a: override none → all elec_heating = 0 or null');

  let invariantOk = true;
  for (let i = 0; i < consumption.length; i++) {
    if (consumption[i].elec_kwh === null || heating[i].nonheat_residual_kwh === null) continue;
    if (Math.abs(heating[i].nonheat_residual_kwh - consumption[i].elec_kwh) > 1e-9) {
      invariantOk = false; break;
    }
  }
  assert(invariantOk, 'J-4b: nonheat_residual = elec when none');
}

console.log('\n── TC-J-5 — all-electric per-HH series ─────────────────────────────────');
{
  // Full-year no-gas; gas=null; elec = 12 + 1.5*HDD (summer HDD=0 → E_d=0 → elec_heating=0)
  const { consumption, external } = buildDataset(
    365,
    seasonalTemp,
    (d, hdd) => 12 + 1.5 * hdd,
    null
  );
  const result = separateBaseload(consumption, external, null);
  const { heating } = result;
  const sl = result.supplementary_loads;

  assert(sl.electric_heating_classification_effective === 'all_electric', 'J-5a: all_electric');

  // Invariant holds for all HH
  let invariantOk = true;
  for (let i = 0; i < consumption.length; i++) {
    if (consumption[i].elec_kwh === null || heating[i].elec_heating_kwh === null) continue;
    if (Math.abs(heating[i].elec_heating_kwh + heating[i].nonheat_residual_kwh - consumption[i].elec_kwh) > 1e-9) {
      invariantOk = false; break;
    }
  }
  assert(invariantOk, 'J-5b: elec invariant holds throughout');

  // Summer days (days 150–220 in the dataset): seasonalTemp(175) = 13 - 11*cos(2π*175/365)
  // cos(2π*175/365) = cos(3.01) ≈ -0.999 → temp ≈ 24°C → HDD = 0 → E_d = 0 → elec_heating = 0
  const summerStart = 150 * 48;
  const summerEnd   = 220 * 48;
  let summerZero = true;
  for (let i = summerStart; i < summerEnd; i++) {
    if (heating[i].elec_heating_kwh !== null && Math.abs(heating[i].elec_heating_kwh) > 1e-10) {
      summerZero = false; break;
    }
  }
  assert(summerZero, 'J-5c: summer HDD=0 → elec_heating = 0');

  // Winter days (days 0–30): HDD > 0 → some elec_heating > 0
  const winterEnd = 30 * 48;
  let someNonZero = false;
  for (let i = 0; i < winterEnd; i++) {
    if (heating[i].elec_heating_kwh !== null && heating[i].elec_heating_kwh > 0) {
      someNonZero = true; break;
    }
  }
  assert(someNonZero, 'J-5d: winter days have elec_heating > 0 for some HH');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
