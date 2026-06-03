// test-m2-v2.mjs — M2 External Data v2: buildBaseTariffs + alignExternalData + convertSpToUtc
//
// Luxon must be set as a global BEFORE external-data.js is evaluated.
// Use dynamic import after setting globalThis.luxon.

import * as luxonNs from 'luxon';
globalThis.luxon = luxonNs;

const {
  alignExternalData,
  buildBaseTariffs,
  convertSpToUtc,
} = await import('./js/external-data.js');

// ── Infrastructure ────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else       { console.error(`  FAIL  ${name}`); failed++; }
}
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) < tol; }

// ── Helpers ───────────────────────────────────────────────────────────────────

// Build a priceLookup Map from an array of { ts, price } pairs.
// ts must be in canonical ISO UTC form: 'YYYY-MM-DDTHH:mm:ssZ'
function makePriceLookup(pairs) {
  return new Map(pairs.map(({ ts, price }) => [ts, price]));
}

// Minimal agile calibration object for the 'calibrated' path.
function makeCal(D = 2.2, P = 12, source = 'calibrated') {
  return { D, P_peak_p_kwh: P, source, D_sample_count: 100, P_sample_count: 50, null_wholesale_fraction: null };
}

// Minimal agile calibration for the regional_table / national_default paths.
function makeTableCal(D = 2.2, P = 12, source = 'regional_table') {
  return { D, P_peak_p_kwh: P, source, D_sample_count: 0, P_sample_count: 0, null_wholesale_fraction: null };
}

// Minimal tariff_rates with one gas + one electricity window.
function makeTariffRates(gasRate, gasStanding = 31.66, elecRate = 24.5, elecStanding = 61.64) {
  const w = { valid_from: '2020-01-01T00:00:00Z', valid_to: null };
  return {
    gas:         [{ ...w, rate_p_kwh: gasRate, standing_p_day: gasStanding }],
    electricity: [{ ...w, rate_p_kwh: elecRate, standing_p_day: elecStanding }],
  };
}

// Build a consumption array from an array of UTC ISO timestamp strings.
function makeConsumption(timestamps) {
  return timestamps.map(ts => ({ timestamp: ts }));
}

// ── TC10: alignExternalData returns no wholesale_p_kwh ────────────────────────

console.log('\nTC10: alignExternalData output has no wholesale_p_kwh');
{
  // Both 00:00 and 00:30 fall within the same hour (00:xx), so both get weather[00:00].
  // 01:00 falls in hour 01:xx which has no weather entry → temp_c = null.
  const consumption = makeConsumption([
    '2026-01-15T00:00:00Z',
    '2026-01-15T00:30:00Z',
    '2026-01-15T01:00:00Z',
  ]);
  const weatherMap = new Map([
    ['2026-01-15T00:00:00Z', { temperature_2m: 5.0, shortwave_radiation: 0.0 }],
  ]);
  const external = alignExternalData(consumption, weatherMap);
  assert(external.length === 3, 'TC10a: output same length as consumption');
  assert(!('wholesale_p_kwh' in external[0]), 'TC10b: no wholesale_p_kwh in external[0] (M2-internal)');
  assert(!('wholesale_p_kwh' in external[1]), 'TC10c: no wholesale_p_kwh in external[1]');
  assert(external[0].temp_c === 5.0,  'TC10d: temp_c populated for 00:00 (hour key 00:00 in weatherMap)');
  assert(external[1].temp_c === 5.0,  'TC10e: 00:30 shares same hour (00:xx) → same temp_c as 00:00');
  assert(external[2].temp_c === null, 'TC10f: 01:00 has no weather entry → temp_c null');
}

// ── TC13: calibrated VAT path — D×W+P exact arithmetic ───────────────────────
// Calibrated: D absorbs VAT. hh_rate = min(D×W+P, 100).

console.log('\nTC13: calibrated path — D×W+P exact value');
{
  // Off-peak at 00:00 UTC on 2026-01-15 = 00:00 GMT → off-peak (not 16:00–18:59)
  const ts = '2026-01-15T00:00:00Z';
  // Peak slot: 16:00 GMT on the same day
  const tsPeak = '2026-01-15T16:00:00Z';

  const consumption = makeConsumption([ts, tsPeak]);
  const priceLookup = makePriceLookup([
    { ts, price: 5.0 },
    { ts: tsPeak, price: 5.0 },
  ]);
  const cal = makeCal(2.2, 12, 'calibrated');
  const tariffRates = makeTariffRates(7.0);

  const { hh_rate } = buildBaseTariffs(consumption, priceLookup, cal, tariffRates, null);

  // Off-peak: D×W = 2.2×5.0 = 11.0; no P
  assert(approx(hh_rate[0], 11.0),  'TC13a: calibrated, off-peak, W=5, D=2.2 → hh_rate=11.0 p/kWh');
  // Peak: D×W+P = 2.2×5.0+12 = 23.0; min(23.0, 100) = 23.0
  assert(approx(hh_rate[1], 23.0),  'TC13b: calibrated, peak, W=5, D=2.2, P=12 → hh_rate=23.0 p/kWh (exact)');
}

// ── TC14: table/national VAT path — D×W+P with VAT multiply ──────────────────
// Table/national: D and P VAT-exclusive. hh_rate = min(rawRate, 95) × 1.05.

console.log('\nTC14: regional_table/national_default path — VAT applied to D×W+P');
{
  const ts     = '2026-01-15T00:00:00Z';
  const tsPeak = '2026-01-15T16:00:00Z';

  const consumption = makeConsumption([ts, tsPeak]);
  const priceLookup = makePriceLookup([
    { ts, price: 5.0 },
    { ts: tsPeak, price: 5.0 },
  ]);
  const cal = makeTableCal(2.2, 12, 'regional_table');
  const tariffRates = makeTariffRates(7.0);

  const { hh_rate } = buildBaseTariffs(consumption, priceLookup, cal, tariffRates, null);

  // Off-peak: raw=2.2×5.0=11.0; min(11.0,95)×1.05=11.55
  assert(approx(hh_rate[0], 11.0 * 1.05), 'TC14a: table, off-peak, W=5, D=2.2 → hh_rate=11.55 p/kWh (×1.05 VAT)');
  // Peak: raw=2.2×5.0+12=23.0; min(23.0,95)×1.05=24.15
  assert(approx(hh_rate[1], 23.0 * 1.05), 'TC14b: table, peak, W=5 → hh_rate=24.15 p/kWh (×1.05 VAT)');
}

// ── TC15: negative wholesale passes through with correct sign ─────────────────

console.log('\nTC15: negative wholesale — calibrated and table paths');
{
  const ts = '2026-01-15T00:00:00Z'; // off-peak

  const consumption = makeConsumption([ts]);
  const priceLookup = makePriceLookup([{ ts, price: -5.0 }]);
  const tariffRates = makeTariffRates(7.0);

  // Calibrated: D×(-5)+0 = -11.0; min(-11.0, 100) = -11.0
  const { hh_rate: rCal } = buildBaseTariffs(
    consumption, priceLookup, makeCal(2.2, 12, 'calibrated'), tariffRates, null
  );
  assert(approx(rCal[0], -11.0), 'TC15a: calibrated, W=-5, off-peak → hh_rate=-11.0');
  assert(rCal[0] < 0,           'TC15b: calibrated negative passes through (not clamped)');

  // Table: raw=-11.0; min(-11.0,95)×1.05 = -11.0×1.05 = -11.55
  const { hh_rate: rTbl } = buildBaseTariffs(
    consumption, priceLookup, makeTableCal(2.2, 12, 'regional_table'), tariffRates, null
  );
  assert(approx(rTbl[0], -11.55), 'TC15c: table, W=-5, off-peak → hh_rate=-11.55 (×1.05)');
  assert(rTbl[0] < 0,             'TC15d: table negative passes through (not clamped)');
}

// ── TC16: null wholesale → imputed, not zero/null ─────────────────────────────

console.log('\nTC16: null wholesale → imputed value (not zero or null)');
{
  // 10 slots; first 9 have wholesale=5.0, last 1 is null
  const timestamps = Array.from({ length: 10 }, (_, i) =>
    `2026-01-15T${String(i * 2).padStart(2, '0')}:00:00Z`
  );
  const consumption = makeConsumption(timestamps);
  // Build priceLookup with all 10 present, then make slot 9 missing (null via absent key)
  const priceLookup = makePriceLookup(
    timestamps.slice(0, 9).map(ts => ({ ts, price: 5.0 }))
    // slot 9 is absent → null in wholesale_array
  );
  const cal = makeCal(2.2, 12, 'calibrated');
  const tariffRates = makeTariffRates(7.0);

  const { hh_rate } = buildBaseTariffs(consumption, priceLookup, cal, tariffRates, null);

  // Imputed slot should be neither null nor 0 (global mean = 5.0 → rate = 2.2×5=11.0)
  assert(hh_rate[9] !== null && hh_rate[9] !== undefined, 'TC16a: null wholesale slot → hh_rate is not null');
  assert(hh_rate[9] !== 0, 'TC16b: null wholesale slot → hh_rate is not 0');
  assert(hh_rate[9] > 0,  'TC16c: null wholesale slot → hh_rate is positive (imputed from global mean)');
}

// ── TC17: coverage warnings at 6% null and 26% null thresholds ───────────────

console.log('\nTC17: coverage warnings — 6% null (info) and 26% null (insufficient)');
{
  const tariffRates = makeTariffRates(7.0);
  const cal = makeCal();

  // Helper: build n unique half-hourly UTC timestamps starting 2026-01-01
  function makeHhTimestamps(n, dayOffset = 0) {
    return Array.from({ length: n }, (_, i) => {
      const totalHH = i + dayOffset * 48;
      const day  = 1 + Math.floor(totalHH / 48);
      const hour = Math.floor(totalHH / 2) % 24;
      const min  = (totalHH % 2) * 30;
      return `2026-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`;
    });
  }

  // 6% null: 100 slots, 6 absent — above 5% warn threshold
  {
    const timestamps = makeHhTimestamps(100, 0);
    const consumption = makeConsumption(timestamps);
    const priceLookup = makePriceLookup(
      timestamps.slice(0, 94).map(ts => ({ ts, price: 5.0 })) // 6 absent = 6% null
    );
    const { coverage_warnings } = buildBaseTariffs(consumption, priceLookup, cal, tariffRates, null);
    assert(coverage_warnings.length > 0,            'TC17a: 6% null → at least one coverage warning');
    // 6% message: "Wholesale price data was missing..."; NOT the insufficient "may be unreliable" message
    assert(!coverage_warnings.some(w => w.includes('unreliable')),
      'TC17b: 6% null → info warning (not "unreliable" / insufficient wording)');
  }

  // 26% null: 100 slots, 26 absent — above 25% insufficient threshold
  {
    const timestamps = makeHhTimestamps(100, 3); // offset 3 days to avoid collision
    const consumption = makeConsumption(timestamps);
    const priceLookup = makePriceLookup(
      timestamps.slice(0, 74).map(ts => ({ ts, price: 5.0 })) // 26 absent = 26% null
    );
    const { coverage_warnings, null_wholesale_fraction } = buildBaseTariffs(
      consumption, priceLookup, cal, tariffRates, null
    );
    assert(null_wholesale_fraction > 0.25,     'TC17c: 26% null → null_wholesale_fraction > 0.25');
    assert(coverage_warnings.length > 0,       'TC17d: 26% null → at least one coverage warning');
    assert(coverage_warnings.some(w => w.includes('25%') || w.includes('26%') || w.includes('Half-hourly')),
      'TC17e: 26% null → warning mentions threshold or Half-hourly');
  }
}

// ── TC18: gas rate source — API tariff vs Ofgem cap ──────────────────────────

console.log('\nTC18: gas rate source — API tariff path vs CSV/demo path (Ofgem cap)');
{
  const ts = '2026-05-15T12:00:00Z'; // Q2 2026
  const consumption = makeConsumption([ts]);
  const priceLookup = makePriceLookup([{ ts, price: 5.0 }]);
  const cal = makeCal();

  // API path: tariff_rates.gas has a window → uses that rate
  const tariffRatesWithGas = makeTariffRates(7.5);
  const { gas_rate: rWithTariff } = buildBaseTariffs(
    consumption, priceLookup, cal, tariffRatesWithGas, null
  );
  assert(approx(rWithTariff[0], 7.5),
    'TC18a: API path — gas rate from tariff window = 7.5 p/kWh');

  // CSV/demo path: tariff_rates.gas empty → falls back to Ofgem quarterly cap
  const tariffRatesEmpty = { gas: [], electricity: [] };
  const { gas_rate: rCapFallback } = buildBaseTariffs(
    consumption, priceLookup, cal, tariffRatesEmpty, null
  );
  // Q2 2026 Ofgem cap gas = 5.70 (per OFGEM_CAP_GAS_BY_QUARTER in external-data.js)
  assert(approx(rCapFallback[0], 5.70, 0.01),
    'TC18b: CSV/demo path — gas rate falls back to Ofgem Q2 2026 cap ≈ 5.70 p/kWh');
}

// ── TC19: regional standing charges from gsp_region ──────────────────────────

console.log('\nTC19: regional standing charges — empty tariff_rates uses REGIONAL_STANDING_CHARGES[gsp]');
{
  const ts = '2026-01-15T00:00:00Z';
  const consumption = makeConsumption([ts]);
  const priceLookup = makePriceLookup([{ ts, price: 5.0 }]);
  const cal = makeCal();
  const emptyTariffs = { gas: [], electricity: [] };

  // Region 'C': should use REGIONAL_STANDING_CHARGES['C'] = { gas: 31.66, elec: 61.64 }
  const { standing_charge } = buildBaseTariffs(consumption, priceLookup, cal, emptyTariffs, 'C');
  assert(approx(standing_charge.gas,  31.66, 0.01), 'TC19a: region C, no tariff → gas standing = 31.66 p/day');
  assert(approx(standing_charge.elec, 61.64, 0.01), 'TC19b: region C, no tariff → elec standing = 61.64 p/day');

  // Region null: should use national defaults (same values as region C in current table)
  const { standing_charge: scNull } = buildBaseTariffs(consumption, priceLookup, cal, emptyTariffs, null);
  assert(approx(scNull.gas,  31.66, 0.01), 'TC19c: gsp_region=null → national default gas standing = 31.66 p/day');
  assert(approx(scNull.elec, 61.64, 0.01), 'TC19d: gsp_region=null → national default elec standing = 61.64 p/day');
}

// ── SP→UTC regression ─────────────────────────────────────────────────────────
// Verifies convertSpToUtc handles GMT, BST, and DST transitions correctly.
// Note: the APXMIDP provider filter (renamed from N2EX in agile-rate-robustness).

function makeMidRecords(settlementDate, count) {
  return Array.from({ length: count }, (_, i) => ({
    settlementDate,
    settlementPeriod: i + 1,
    price: 10.0,
    dataProvider: 'APXMIDP',
  }));
}

console.log('\nSP→UTC: Normal winter day (GMT, 2026-01-15)');
{
  const records = makeMidRecords('2026-01-15', 48);
  const { priceLookup, warnings } = convertSpToUtc(records);
  assert(priceLookup.size === 48,               'SP-GMT-a: 48 SPs → 48 entries');
  assert(priceLookup.has('2026-01-15T00:00:00Z'),
    'SP-GMT-b: SP1 → 2026-01-15T00:00:00Z');
  assert(priceLookup.has('2026-01-15T23:30:00Z'),
    'SP-GMT-c: SP48 → 2026-01-15T23:30:00Z');
  assert(warnings.length === 0,                  'SP-GMT-d: no warnings for 48-SP day');
}

console.log('\nSP→UTC: Normal summer day (BST, 2025-06-15)');
{
  const records = makeMidRecords('2025-06-15', 48);
  const { priceLookup } = convertSpToUtc(records);
  assert(priceLookup.size === 48,                'SP-BST-a: 48 SPs');
  // SP1 = 00:00 BST = 23:00 UTC on D−1
  assert(priceLookup.has('2025-06-14T23:00:00Z'),
    'SP-BST-b: SP1 on 2025-06-15 → 2025-06-14T23:00:00.000Z (BST = UTC−1h)');
  // SP48 = 23:30 BST = 22:30 UTC
  assert(priceLookup.has('2025-06-15T22:30:00Z'),
    'SP-BST-c: SP48 on 2025-06-15 → 2025-06-15T22:30:00Z');
}

console.log('\nSP→UTC: Spring forward (2026-03-29, 46 SPs)');
{
  const records = makeMidRecords('2026-03-29', 46);
  const { priceLookup, warnings } = convertSpToUtc(records);
  assert(priceLookup.size === 46,                'SP-FWD-a: 46 SPs on spring-forward day');
  // SP1 = 00:00 GMT = UTC 00:00 (before the clock change)
  assert(priceLookup.has('2026-03-29T00:00:00Z'), 'SP-FWD-b: SP1 → UTC 00:00');
  // SP2 = 00:30 GMT → UTC 00:30
  assert(priceLookup.has('2026-03-29T00:30:00Z'), 'SP-FWD-c: SP2 → UTC 00:30');
  // SP3 = 01:00 GMT → clock jumps to 02:00 BST; UTC = 01:00
  assert(priceLookup.has('2026-03-29T01:00:00Z'), 'SP-FWD-d: SP3 → UTC 01:00 (first after spring gap)');
  // SP46 = 22:30 UTC (last SP)
  assert(priceLookup.has('2026-03-29T22:30:00Z'), 'SP-FWD-e: SP46 → UTC 22:30');
  assert(warnings.length === 0,                  'SP-FWD-f: no warnings for 46-SP spring-forward day');
}

console.log('\nSP→UTC: Autumn back (2025-10-26, 50 SPs)');
{
  const records = makeMidRecords('2025-10-26', 50);
  const { priceLookup, warnings } = convertSpToUtc(records);
  assert(priceLookup.size === 50,                    'SP-BACK-a: 50 SPs on autumn-back day');
  // SP1 = 00:00 BST = UTC 2025-10-25T23:00Z
  assert(priceLookup.has('2025-10-25T23:00:00Z'), 'SP-BACK-b: SP1 → UTC 2025-10-25T23:00');
  // SP3 = 01:00 BST (first occurrence) → UTC 2025-10-26T00:00
  assert(priceLookup.has('2025-10-26T00:00:00Z'), 'SP-BACK-c: SP3 → UTC 00:00 (01:00 BST, first)');
  // SP5 = 01:00 GMT (second occurrence) → UTC 2025-10-26T01:00
  assert(priceLookup.has('2025-10-26T01:00:00Z'), 'SP-BACK-d: SP5 → UTC 01:00 (01:00 GMT, second)');
  // SP50 = 23:30 UTC
  assert(priceLookup.has('2025-10-26T23:30:00Z'), 'SP-BACK-e: SP50 → UTC 23:30');
  assert(warnings.length === 0,                       'SP-BACK-f: no warnings for 50-SP autumn-back day');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('FAIL'); process.exit(1); }
console.log('PASS');
