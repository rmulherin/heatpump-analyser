// test-m4-v2.mjs — M4 Heat Loss v2 test suite
// Run: node test-m4-v2.mjs
// Expected: 27/27 pass (T1–T26 + T21-int)

import assert from 'assert/strict';
import { estimateHeatLoss, applyHtcRescale } from './js/heat-loss.js';

// ===== Data generators =====
//
// Physical model: daily_heat_delivered [kWh] = htcTrue [W/K] × DD [K·day] × 24/1000
//                                            − solarApertureTrue [m²] × solar_kwh_per_m2 [kWh/m²]
// The × 24/1000 converts W/K × K·day → kWh (HTC is W/K, DD is degree-K-days).
// Temperature must vary across days or the OLS matrix is singular.
//
// OLS recovers: alpha = htcTrue × 24/1000, beta = −solarApertureTrue
//   → htc_w_per_k = alpha × 1000/24 = htcTrue  ✓
//   → solar_aperture = −beta = solarApertureTrue  ✓

const HDD_BASE = 15.5;

// buildHeating: main synthetic data builder.
//   tempRange [min,max]: outdoor temp (°C) varies linearly across n days — MUST vary for 2-predictor OLS.
//   solarW: W/m² (constant) — 0 forces one-predictor fallback (solar col = 0 → singular → DD-only OLS).
//   solarApertureTrue: true R (m²) — solar reduces heat demand: heat = htcTrue×DD×24/1000 − R×solar.
//   eta: boiler efficiency applied to gas term.
//   elecNull: true → elec_heating_kwh = null (gas-only home; gas_present=true, elec_present=false).
//   gasNull: true → heating_kwh = null (all-electric home; gas_present=false).
//   elecKwhPerDD: if set, elec delivers this many kWh per K·day × 24/1000 (mixed-fuel).
function buildHeating({
  n = 30,
  tempRange = [0, 12],
  solarW = 0,
  solarApertureTrue = 0,
  htcTrue = 250,
  eta = 0.85,
  elecNull = true,
  gasNull = false,
  elecKwhPerDD = null,
  dateStart = '2024-01-01',
} = {}) {
  const heating = [], external = [];
  const start = new Date(dateStart + 'T00:00:00Z').getTime();
  for (let d = 0; d < n; d++) {
    const t = n > 1 ? d / (n - 1) : 0;
    const tempC = tempRange[0] + (tempRange[1] - tempRange[0]) * t;
    const DD = Math.max(0, HDD_BASE - tempC);
    const solarKwh = solarW * 48 * 0.5 / 1000; // kWh/m²/day (constant solar per day)

    // Thermal heat delivered to the building
    const totalDelivered = Math.max(0, htcTrue * DD * 24 / 1000 - solarApertureTrue * solarKwh);

    // Split into gas/elec components.
    // When gasNull (all-electric home): elec carries the full heat load.
    let elecDelivered, gasDelivered;
    if (gasNull) {
      elecDelivered = totalDelivered;
      gasDelivered  = 0;
    } else if (elecKwhPerDD !== null) {
      elecDelivered = elecKwhPerDD * DD * 24 / 1000;
      gasDelivered  = Math.max(0, totalDelivered - elecDelivered);
    } else {
      elecDelivered = 0;
      gasDelivered  = totalDelivered;
    }

    const hhGasKwh  = gasNull  ? null : (eta > 0 ? gasDelivered / eta / 48 : 0);
    const hhElecKwh = elecNull ? null : elecDelivered / 48;

    const dayMs = start + d * 86400000;
    for (let hh = 0; hh < 48; hh++) {
      const ts = new Date(dayMs + hh * 1800000).toISOString().slice(0, 16);
      heating.push({ timestamp: ts, heating_kwh: hhGasKwh, elec_heating_kwh: hhElecKwh, is_absence: false });
      external.push({ temp_c: tempC, solar_w_m2: solarW });
    }
  }
  return { heating, external };
}

// ===== Test runner =====

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

// ===== v1 carry-through (T1–T10) =====

console.log('\n--- v1 carry-through (T1–T10) ---');

test('T1: Core HTC recovery — gas-only, HTC_true=250, R_true=3', () => {
  // solarW=150 → solar_kwh=3.6 kWh/m²/day, solarApertureTrue=3 → heat = 250×DD×24/1000 − 3×3.6
  const { heating, external } = buildHeating({
    n: 30, tempRange: [0, 12], solarW: 150, solarApertureTrue: 3,
    htcTrue: 250, eta: 0.85, elecNull: true,
  });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.ok(r.htc_w_per_k !== null, 'htc_w_per_k should not be null');
  assert.ok(Math.abs(r.htc_w_per_k - 250) / 250 < 0.15, `HTC ${r.htc_w_per_k?.toFixed(1)} not within 15% of 250`);
  assert.ok(r.solar_aperture !== null && r.solar_aperture > 0, 'solar_aperture should be > 0');
});

test('T2: Absence exclusion — one day with is_absence=true', () => {
  const { heating, external } = buildHeating({ n: 30, htcTrue: 250, elecNull: true });
  for (let hh = 0; hh < 48; hh++) heating[hh].is_absence = true;
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.ok(r.days_excluded.absence >= 1, `absence count: ${r.days_excluded.absence}`);
});

test('T3: Check 4A negative-R fallback — solar inversely correlated with heat', () => {
  // Build data where high solar coincides with high heat (cold+sunny early days)
  // → OLS produces beta > 0 → R = -beta < 0 → Check 4A fires
  const heating = [], external = [];
  const start = new Date('2024-01-01T00:00:00Z').getTime();
  for (let d = 0; d < 30; d++) {
    const tempC = d * 0.4;          // warm as days progress
    const solarW = 400 - d * 10;    // sunnier on colder early days
    const DD = Math.max(0, HDD_BASE - tempC);
    const solarKwh = solarW * 48 * 0.5 / 1000;
    const heat = Math.max(0, 250 * DD * 24 / 1000);  // no solar reduction — just heat by DD
    const hhGas = heat / 0.85 / 48;
    const dayMs = start + d * 86400000;
    for (let hh = 0; hh < 48; hh++) {
      const ts = new Date(dayMs + hh * 1800000).toISOString().slice(0, 16);
      heating.push({ timestamp: ts, heating_kwh: hhGas, elec_heating_kwh: null, is_absence: false });
      external.push({ temp_c: tempC, solar_w_m2: solarW });
    }
  }
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.strictEqual(r.solar_correction_applied, false, 'solar_correction_applied should be false');
  assert.strictEqual(r.solar_aperture, null, 'solar_aperture should be null');
  assert.strictEqual(r.solar_rating, null, 'solar_rating should be null');
});

test('T4: Check 4B low-HTC flag — HTC ≈ 40', () => {
  // solarW=0 → one-predictor OLS (solar col = 0 → singular → fallback) → exact HTC recovery
  const { heating, external } = buildHeating({ n: 30, tempRange: [0, 12], htcTrue: 40, eta: 0.85, elecNull: true, solarW: 0 });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.ok(r.htc_w_per_k !== null, 'htc_w_per_k should not be null');
  assert.ok(r.htc_w_per_k < 50, `htc ${r.htc_w_per_k?.toFixed(1)} should be < 50`);
  assert.strictEqual(r.htc_low_plausibility, true, 'htc_low_plausibility should be true');
  assert.strictEqual(r.validation_status, 'poor', `status should be poor, got ${r.validation_status}`);
});

test('T5: Check 4B high-HTC — HTC ≈ 1600', () => {
  const { heating, external } = buildHeating({ n: 30, tempRange: [0, 12], htcTrue: 1600, eta: 0.85, elecNull: true, solarW: 0 });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.ok(r.htc_w_per_k !== null, 'htc_w_per_k should not be null');
  assert.ok(r.htc_w_per_k > 1500, `htc ${r.htc_w_per_k?.toFixed(1)} should be > 1500`);
  assert.strictEqual(r.htc_low_plausibility, false, 'htc_low_plausibility should be false for high HTC');
  assert.strictEqual(r.validation_status, 'poor', 'validation_status should be poor');
});

test('T6: Check 4C poor R² — high noise data', () => {
  const heating = [], external = [];
  const start = new Date('2024-01-01T00:00:00Z').getTime();
  for (let d = 0; d < 30; d++) {
    const tempC = 3 + (d % 7) * 1.5;  // cyclic variation
    const DD = Math.max(0, HDD_BASE - tempC);
    // Noisy: alternate between 2× and 0.5× expected heating
    const mult = d % 2 === 0 ? 2.5 : 0.5;
    const hhGas = Math.max(0, 250 * DD * 24 / 1000 * mult / 0.85 / 48);
    const dayMs = start + d * 86400000;
    for (let hh = 0; hh < 48; hh++) {
      const ts = new Date(dayMs + hh * 1800000).toISOString().slice(0, 16);
      heating.push({ timestamp: ts, heating_kwh: hhGas, elec_heating_kwh: null, is_absence: false });
      external.push({ temp_c: tempC, solar_w_m2: 0 });
    }
  }
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.ok(['poor', 'acceptable'].includes(r.validation_status),
    `status should be poor or acceptable, got ${r.validation_status}`);
});

test('T7: Rating boundaries — HTC 100/200/300/400/600', () => {
  function ratingFor(htcTrue) {
    // solarW=0 → one-predictor OLS → exact HTC recovery
    const { heating, external } = buildHeating({ n: 30, tempRange: [0, 12], htcTrue, eta: 1.0, solarW: 0, elecNull: true });
    const r = estimateHeatLoss(heating, external, 1.0, null);
    return r.rating;
  }
  assert.strictEqual(ratingFor(100), 'excellent');
  assert.strictEqual(ratingFor(200), 'good');
  assert.strictEqual(ratingFor(300), 'average');
  assert.strictEqual(ratingFor(400), 'poor');
  assert.strictEqual(ratingFor(600), 'very_poor');
});

test('T8: Solar rating boundaries — R 1/3/5/10/15', () => {
  // With varying DD and constant solar, OLS exactly recovers solar_aperture = solarApertureTrue.
  function solarRatingFor(R) {
    // Use colder temp range for high R to keep enough days above 2 kWh threshold
    const tempRange = R >= 10 ? [-5, 5] : [0, 12];
    const n = R >= 10 ? 60 : 30;
    const { heating, external } = buildHeating({
      n, tempRange, solarW: 150, solarApertureTrue: R,
      htcTrue: 250, eta: 1.0, elecNull: true,
    });
    const r = estimateHeatLoss(heating, external, 1.0, null);
    return r.solar_rating;
  }
  assert.strictEqual(solarRatingFor(1),  'minimal');
  assert.strictEqual(solarRatingFor(3),  'moderate');
  assert.strictEqual(solarRatingFor(5),  'good');
  assert.strictEqual(solarRatingFor(10), 'high');
  assert.strictEqual(solarRatingFor(15), 'very_high');
});

test('T9: Cooling consideration cases', () => {
  function coolingFor(htcTrue, R) {
    const { heating, external } = buildHeating({
      n: 30, tempRange: [0, 12], solarW: 150, solarApertureTrue: R,
      htcTrue, eta: 1.0, elecNull: true,
    });
    const r = estimateHeatLoss(heating, external, 1.0, null);
    return r.cooling_consideration;
  }
  assert.strictEqual(coolingFor(200, 8),  'significant',  'R≥7 HTC<250 should be significant');
  assert.strictEqual(coolingFor(200, 4),  'worth_noting', 'R≥4 HTC<250 should be worth_noting');
  assert.strictEqual(coolingFor(400, 1),  'minimal',      'R=1 HTC=400 should be minimal');
});

test('T10: Degree-day base echo — 15.5', () => {
  const { heating, external } = buildHeating({ n: 30, elecNull: true });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.strictEqual(r.degree_day_base_c, 15.5);
});

// ===== v2-specific (T11–T26 + T21-int) =====

console.log('\n--- v2-specific (T11–T26 + T21-int) ---');

test('T11: Gas-only η-equivalence — η-move regression guard', () => {
  // htc_v2(η=0.85) must equal htc_v2(η=1.0) × 0.85 to 1e-9.
  // At η=0.85: y = gas×0.85 = htcTrue×DD×24/1000. alpha = htcTrue×24/1000. HTC = htcTrue.
  // At η=1.0:  y = gas×1.0  = htcTrue×DD×24/1000/0.85. alpha = htcTrue×24/1000/0.85. HTC = htcTrue/0.85.
  // Check: htcTrue == (htcTrue/0.85) × 0.85. ✓
  const { heating, external } = buildHeating({
    n: 30, tempRange: [0, 12], solarW: 0, htcTrue: 250, eta: 0.85, elecNull: true,
  });
  const r85 = estimateHeatLoss(heating, external, 0.85, null);
  const r10 = estimateHeatLoss(heating, external, 1.0,  null);
  assert.ok(r85.htc_w_per_k !== null, 'r85 htc not null');
  assert.ok(r10.htc_w_per_k !== null, 'r10 htc not null');
  const diff = Math.abs(r85.htc_w_per_k - r10.htc_w_per_k * 0.85);
  assert.ok(diff < 1e-9, `η-equivalence: diff=${diff}`);
});

test('T12: Combined-fuel mixed — HTC_true=250, elec 0.6 kWh/(K·day)×24/1000', () => {
  // heat_delivered = 250×DD×24/1000; elec contributes 0.6×DD×24/1000; gas = remainder/eta
  const { heating, external } = buildHeating({
    n: 30, tempRange: [0, 12], solarW: 0,
    htcTrue: 250, eta: 0.85, elecNull: false, elecKwhPerDD: 0.6,
  });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.ok(r.htc_w_per_k !== null, 'htc_w_per_k not null');
  assert.ok(Math.abs(r.htc_w_per_k - 250) / 250 < 0.15,
    `HTC ${r.htc_w_per_k?.toFixed(1)} not within 15% of 250`);
});

test('T13: All-electric — heating_kwh=null throughout, no short-circuit', () => {
  // m3 sets heating_kwh=null for all-electric homes (not 0). gas_present=false → null gas does not gate.
  const { heating, external } = buildHeating({
    n: 30, tempRange: [0, 12], solarW: 0,
    htcTrue: 220, gasNull: true, elecNull: false,
  });
  assert.ok(heating.every(h => h.heating_kwh === null), 'all heating_kwh should be null');
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.ok(['good', 'acceptable'].includes(r.validation_status),
    `status should be good or acceptable, got ${r.validation_status}`);
  assert.notStrictEqual(r.validation_status, 'no_gas', 'no_gas must not appear');
  assert.ok(r.htc_w_per_k !== null, 'htc_w_per_k should not be null');
  assert.ok(Math.abs(r.htc_w_per_k - 220) / 220 < 0.15,
    `HTC ${r.htc_w_per_k?.toFixed(1)} not within 15% of 220`);
});

test('T14: Solar-aperture basis shift — R_v2 ≈ 0.85 × R_v1', () => {
  // At η=0.85: solar_aperture_v2 = R_true
  // At η=1.0: solar_aperture_v1 = R_true/0.85 (gas in pre-η units scales both alpha and beta)
  // Ratio: R_v2 / R_v1 = (R_true) / (R_true/0.85) = 0.85
  const { heating, external } = buildHeating({
    n: 30, tempRange: [0, 12], solarW: 150, solarApertureTrue: 3,
    htcTrue: 250, eta: 0.85, elecNull: true,
  });
  const r85 = estimateHeatLoss(heating, external, 0.85, null);
  const r10 = estimateHeatLoss(heating, external, 1.0,  null);
  assert.ok(r85.solar_aperture !== null, 'solar_aperture at η=0.85 not null');
  assert.ok(r10.solar_aperture !== null, 'solar_aperture at η=1.0 not null');
  const ratio = r85.solar_aperture / r10.solar_aperture;
  assert.ok(Math.abs(ratio - 0.85) < 0.05,
    `basis shift ratio ${ratio.toFixed(4)} not within ±5% of 0.85`);
});

test('T15: η scaling — htc(0.70)/htc(0.85) == 0.70/0.85 to 1e-9', () => {
  const { heating, external } = buildHeating({
    n: 30, tempRange: [0, 12], solarW: 0, htcTrue: 250, eta: 0.85, elecNull: true,
  });
  const r85 = estimateHeatLoss(heating, external, 0.85, null);
  const r70 = estimateHeatLoss(heating, external, 0.70, null);
  assert.ok(r85.htc_w_per_k !== null);
  assert.ok(r70.htc_w_per_k !== null);
  const ratio = r70.htc_w_per_k / r85.htc_w_per_k;
  const expected = 0.70 / 0.85;
  assert.ok(Math.abs(ratio - expected) < 1e-9,
    `η scaling ratio ${ratio} != ${expected} (diff ${Math.abs(ratio - expected)})`);
});

test('T16: Per-HH thermal mint — length, nulls, values', () => {
  const { heating, external } = buildHeating({
    n: 5, tempRange: [0, 12], solarW: 0,
    htcTrue: 250, eta: 0.85, elecNull: false, elecKwhPerDD: 0.6,
  });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.strictEqual(r.thermal_heat_delivered_kwh.length, heating.length, 'mint length must equal heating array length');
  for (let i = 0; i < heating.length; i++) {
    const h = heating[i];
    const gas  = h.heating_kwh      ?? null;
    const elec = h.elec_heating_kwh ?? null;
    if (gas === null && elec === null) {
      assert.strictEqual(r.thermal_heat_delivered_kwh[i], null, `HH ${i}: should be null`);
    } else {
      const expected = (gas ?? 0) * 0.85 + (elec ?? 0);
      const actual = r.thermal_heat_delivered_kwh[i];
      assert.ok(Math.abs(actual - expected) < 1e-12,
        `HH ${i}: mint ${actual} != expected ${expected}`);
    }
  }
});

test('T17: Check 4D removed — htc_correction_w_per_k and htc_w_per_k_adjusted absent', () => {
  const { heating, external } = buildHeating({ n: 30, elecNull: true });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.ok(!('htc_correction_w_per_k' in r), 'htc_correction_w_per_k must not be in result');
  assert.ok(!('htc_w_per_k_adjusted' in r), 'htc_w_per_k_adjusted must not be in result');
});

test('T18: net_flow / internal_gains fields absent', () => {
  const { heating, external } = buildHeating({ n: 30, elecNull: true });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  for (const field of ['net_flow_w', 'net_flow_label', 'net_flow_warning', 'internal_gains_w_used', 'winter_setpoint_used_c']) {
    assert.ok(!(field in r), `${field} must not be in result`);
  }
});

test('T19: HLP / floor_area fields absent', () => {
  const { heating, external } = buildHeating({ n: 30, elecNull: true });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.ok(!('hlp_w_per_m2_k' in r), 'hlp_w_per_m2_k must not be in result');
});

test('T20: Rescale first pass — htc_used === htc_w_per_k (exact), htc_rescale_rejected === false', () => {
  const { heating, external } = buildHeating({ n: 30, elecNull: true });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.ok(r.htc_w_per_k !== null);
  assert.strictEqual(r.htc_used, r.htc_w_per_k, 'htc_used must === htc_w_per_k on first pass');
  assert.strictEqual(r.htc_rescale_rejected, false);
});

test('T21: Rescale within band — unit test of applyHtcRescale', () => {
  // rescale = 12/(12+2) = 12/14; htc_used = 220 × 12/14
  const result = applyHtcRescale(220, { setpoint_delta_k: 2, operating_delta_t_k: 12 });
  const expectedHtcUsed = 220 * (12 / 14);
  assert.ok(Math.abs(result.htc_used - expectedHtcUsed) < 1e-9,
    `htc_used ${result.htc_used} != ${expectedHtcUsed}`);
  assert.strictEqual(result.htc_rescale_rejected, false);
});

test('T21-int: Rescale integration — payload applied through estimateHeatLoss', () => {
  const { heating, external } = buildHeating({ n: 30, elecNull: true });
  const payload = { setpoint_delta_k: 2, operating_delta_t_k: 12 };
  const r = estimateHeatLoss(heating, external, 0.85, payload);
  assert.ok(r.htc_w_per_k !== null, 'htc_w_per_k not null');
  assert.notStrictEqual(r.htc_used, r.htc_w_per_k, 'htc_used should differ from htc_w_per_k when payload applied');
  assert.strictEqual(r.htc_rescale_rejected, false);
  const expectedRescale = 12 / 14;
  assert.ok(Math.abs(r.htc_used - r.htc_w_per_k * expectedRescale) < 1e-9,
    `htc_used ${r.htc_used} != htc×${expectedRescale}`);
});

test('T22: Rescale out-of-band rejected — unit test of applyHtcRescale', () => {
  // rescale = 12/16 = 0.75 < 0.8 → rejected; htc_used = 220 unchanged
  const result = applyHtcRescale(220, { setpoint_delta_k: 4, operating_delta_t_k: 12 });
  assert.strictEqual(result.htc_used, 220, `htc_used should be 220, got ${result.htc_used}`);
  assert.strictEqual(result.htc_rescale_rejected, true);
});

test('T23: Rescale idempotence — applying same payload twice gives identical result', () => {
  const payload = { setpoint_delta_k: 2, operating_delta_t_k: 12 };
  const r1 = applyHtcRescale(220, payload);
  const r2 = applyHtcRescale(220, payload);
  assert.strictEqual(r1.htc_used, r2.htc_used);
  assert.strictEqual(r1.htc_rescale_rejected, r2.htc_rescale_rejected);
});

test('T24: Low-HTC source-blind flag — htc≈45, no fuel-routed callout', () => {
  const { heating, external } = buildHeating({
    n: 30, tempRange: [0, 12], htcTrue: 45, eta: 1.0, elecNull: true, solarW: 0,
  });
  const r = estimateHeatLoss(heating, external, 1.0, null);
  assert.ok(r.htc_w_per_k !== null, 'htc_w_per_k should not be null');
  assert.ok(r.htc_w_per_k < 50, `htc ${r.htc_w_per_k?.toFixed(1)} should be < 50`);
  assert.strictEqual(r.htc_low_plausibility, true);
  assert.strictEqual(r.validation_status, 'poor');
  assert.ok(!('htc_low_plausibility_callout' in r), 'fuel-routed callout must not be in result');
});

test('T25: Insufficient data — 15 days, no fabrication, mint still present', () => {
  const { heating, external } = buildHeating({ n: 15, elecNull: true });
  const r = estimateHeatLoss(heating, external, 0.85, null);
  assert.strictEqual(r.htc_w_per_k, null, 'htc_w_per_k must be null');
  assert.strictEqual(r.htc_used, null, 'htc_used must be null');
  assert.strictEqual(r.rating, null, 'rating must be null');
  assert.strictEqual(r.validation_status, 'insufficient_data');
  assert.ok(Array.isArray(r.thermal_heat_delivered_kwh), 'mint must be present');
  assert.strictEqual(r.thermal_heat_delivered_kwh.length, heating.length, 'mint length must match heating');
});

test('T26: Whole-day presence-gating — (a) gas gap excludes; (b) absent gas does not gate', () => {
  // (a) Gas home with elec_heating_kwh=0 (non-null → elec_present=true, gas_present=true).
  //     One HH with null gas on day 0 → whole day excluded.
  const { heating: hA, external: eA } = buildHeating({
    n: 30, tempRange: [0, 12], solarW: 0, htcTrue: 250, eta: 0.85,
    elecNull: false,  // elec_heating_kwh = 0 (non-null) → elec_present = true
    elecKwhPerDD: 0,  // zero elec contribution
  });
  // Null one gas HH on day 0 (first 48 HH)
  hA[24].heating_kwh = null;
  const rA = estimateHeatLoss(hA, eA, 0.85, null);
  assert.ok(rA.days_excluded.missing_heating >= 1,
    `(a) day should be excluded for gas gap; missing_heating=${rA.days_excluded.missing_heating}`);

  // (b) All-electric home: heating_kwh=null throughout (gas_present=false) → days NOT excluded.
  const { heating: hB, external: eB } = buildHeating({
    n: 30, tempRange: [0, 12], solarW: 0, htcTrue: 220, gasNull: true, elecNull: false,
  });
  assert.ok(hB.every(h => h.heating_kwh === null), 'all gas should be null');
  const rB = estimateHeatLoss(hB, eB, 0.85, null);
  assert.ok(['good', 'acceptable'].includes(rB.validation_status),
    `(b) all-electric should fit; got ${rB.validation_status}`);
  assert.strictEqual(rB.days_excluded.missing_heating, 0,
    `(b) no days excluded for absent gas; got ${rB.days_excluded.missing_heating}`);
});

// ===== Summary =====

console.log(`\n${'='.repeat(50)}`);
const total = passed + failed;
console.log(`Result: ${passed}/${total} passed`);
if (failed > 0) {
  console.log(`FAILED: ${failed} test(s)`);
  process.exit(1);
} else {
  console.log('All tests passed.');
}
