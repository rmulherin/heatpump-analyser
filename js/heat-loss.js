// ===== Heat Loss Estimation Module (Module 4) =====
// Siviour regression: derives HTC (W/K) and solar aperture (m²) from daily
// thermal heat-delivered vs degree-days and solar radiation. Through-origin OLS only —
// zero DD + zero sun ⇒ zero heat delivered (opposite of baseload.js Step H).
// v2: combined-fuel LHS (gas×η + elec×1.0); η-move (η in LHS, not recovery);
// per-HH thermal mint; ±20%-bounded HTC rescale → htc_used.

import { HDD_BASE_TEMP } from './constants.js';

// ===== Shared state =====

let _heatLossResult = null;
export function setHeatLossResult(r) { _heatLossResult = r; }
export function getHeatLossResult() { return _heatLossResult; }

// ===== Private: per-HH thermal heat-delivered mint =====

function mintThermalHeatDelivered(heating, eta) {
  return heating.map(h => {
    const gas  = h.heating_kwh      ?? null;
    const elec = h.elec_heating_kwh ?? null;
    if (gas === null && elec === null) return null;
    return (gas ?? 0) * eta + (elec ?? 0);
  });
}

// ===== Private: daily aggregation =====

function aggregateToDays(heating, external, eta) {
  // Home-level presence flags — computed once before the day-building loop.
  // Distinguishes an absent fuel (null everywhere — contributes 0, does not gate)
  // from a gap (present fuel, missing reading — excludes the whole day).
  const gas_present  = heating.some(h => h.heating_kwh      !== null);
  const elec_present = heating.some(h => h.elec_heating_kwh !== null);

  const dayMap = new Map();
  for (let i = 0; i < heating.length; i++) {
    const day = heating[i].timestamp.slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day).push(i);
  }

  const days = [];
  for (const [dateStr, indices] of dayMap) {
    if (indices.length !== 48) continue;

    let daily_gas_heating_kwh  = 0;
    let daily_elec_heating_kwh = 0;
    let missing_thermal = false;
    let has_absence = false;
    for (const i of indices) {
      const h = heating[i];
      // Presence-gated: a gap in a PRESENT fuel excludes the whole day.
      // An absent fuel (gas_present = false / elec_present = false) does not gate;
      // its ?? 0 coercion is legitimate (no contribution, not a missing reading).
      if (gas_present  && (h.heating_kwh      == null)) { missing_thermal = true; break; }
      if (elec_present && (h.elec_heating_kwh == null)) { missing_thermal = true; break; }
      daily_gas_heating_kwh  += (h.heating_kwh      ?? 0);
      daily_elec_heating_kwh += (h.elec_heating_kwh ?? 0);
      if (h.is_absence) has_absence = true;
    }
    const daily_heat_delivered = missing_thermal
      ? NaN
      : daily_gas_heating_kwh * eta + daily_elec_heating_kwh;

    let tempSum = 0;
    let solarSum = 0;
    let missing_weather = false;
    for (const i of indices) {
      const e = external[i];
      if (!e || e.temp_c === null || e.temp_c === undefined ||
          e.solar_w_m2 === null || e.solar_w_m2 === undefined) {
        missing_weather = true;
        break;
      }
      tempSum += e.temp_c;
      solarSum += e.solar_w_m2;
    }

    let daily_solar_kwh_per_m2, daily_degree_days;
    if (missing_weather) {
      daily_solar_kwh_per_m2 = NaN;
      daily_degree_days = NaN;
    } else {
      // 48 HH slots × 0.5 h/slot ÷ 1000 W/kW = sum ÷ 2000
      daily_solar_kwh_per_m2 = solarSum / 2000;
      daily_degree_days = Math.max(0, HDD_BASE_TEMP - tempSum / 48);
    }

    days.push({
      dateStr,
      daily_heat_delivered,
      daily_solar_kwh_per_m2,
      daily_degree_days,
      has_absence,
      missing_heating: missing_thermal,
      missing_weather,
    });
  }

  return days;
}

// ===== Private: filter for regression =====

function filterForRegression(days) {
  const filtered = [];
  const excluded = {
    absence: 0,
    zero_degree_days: 0,
    missing_heating: 0,
    missing_weather: 0,
    below_heating_threshold: 0,
  };

  for (const day of days) {
    if (day.has_absence)                { excluded.absence++;                 continue; }
    if (day.daily_degree_days === 0)    { excluded.zero_degree_days++;        continue; }
    if (day.missing_heating)            { excluded.missing_heating++;          continue; }
    if (day.missing_weather)            { excluded.missing_weather++;          continue; }
    if (day.daily_heat_delivered < 2.0) { excluded.below_heating_threshold++; continue; }
    filtered.push(day);
  }

  return { filtered, excluded };
}

// ===== Private: 2-predictor through-origin OLS =====
// Fits: y = α·x1 + β·x2  (no intercept)
// x1 = degree-days, x2 = solar kWh/m², y = daily_heat_delivered

function runOLSTwoPredictor(filtered) {
  const n = filtered.length;
  let sx1sq = 0, sx2sq = 0, sx1x2 = 0, sx1y = 0, sx2y = 0, sy2 = 0;
  for (const d of filtered) {
    const x1 = d.daily_degree_days;
    const x2 = d.daily_solar_kwh_per_m2;
    const y  = d.daily_heat_delivered;
    sx1sq += x1 * x1;
    sx2sq += x2 * x2;
    sx1x2 += x1 * x2;
    sx1y  += x1 * y;
    sx2y  += x2 * y;
    sy2   += y  * y;
  }

  const det = sx1sq * sx2sq - sx1x2 * sx1x2;

  if (Math.abs(det) / (n * Math.max(sx1sq, sx2sq, 1)) < 1e-10) {
    return { singular: true, sx2sq, sy2 };
  }

  const alpha = (sx2sq * sx1y - sx1x2 * sx2y) / det;
  const beta  = (sx1sq * sx2y - sx1x2 * sx1y) / det;

  let ss_res = 0;
  for (const d of filtered) {
    const yhat = alpha * d.daily_degree_days + beta * d.daily_solar_kwh_per_m2;
    ss_res += (d.daily_heat_delivered - yhat) ** 2;
  }

  const sigma2 = ss_res / (n - 2);
  const seAlpha = Math.sqrt(Math.max(0, sigma2 * sx2sq / det));
  const seBeta  = Math.sqrt(Math.max(0, sigma2 * sx1sq / det));
  const r2 = sy2 > 0 ? 1 - ss_res / sy2 : null;

  return { singular: false, alpha, beta, seAlpha, seBeta, r2, n, sy2 };
}

// ===== Private: 1-predictor through-origin OLS (Check 4A fallback) =====
// Fits: y = α·x1  (temperature only, no solar term)

function runOLSOnePredictor(filtered) {
  const n = filtered.length;
  let sx1sq = 0, sx1y = 0, sy2 = 0;
  for (const d of filtered) {
    const x1 = d.daily_degree_days;
    const y  = d.daily_heat_delivered;
    sx1sq += x1 * x1;
    sx1y  += x1 * y;
    sy2   += y  * y;
  }

  if (sx1sq === 0) return null;

  const alpha = sx1y / sx1sq;

  let ss_res = 0;
  for (const d of filtered) {
    ss_res += (d.daily_heat_delivered - alpha * d.daily_degree_days) ** 2;
  }

  const sigma2 = ss_res / (n - 1);
  const seAlpha = Math.sqrt(Math.max(0, sigma2 / sx1sq));
  const r2 = sy2 > 0 ? 1 - ss_res / sy2 : null;

  return { alpha, seAlpha, r2, n };
}

// ===== Private: rating helpers =====

function buildRating(htc) {
  if (htc === null) return null;
  if (htc < 150) return 'excellent';
  if (htc < 250) return 'good';
  if (htc < 350) return 'average';
  if (htc < 500) return 'poor';
  return 'very_poor';
}

function buildSolarRating(r) {
  if (r === null) return null;
  if (r < 2)  return 'minimal';
  if (r < 4)  return 'moderate';
  if (r < 7)  return 'good';
  if (r < 12) return 'high';
  return 'very_high';
}

function buildCoolingConsideration(htc, r) {
  if (htc === null || r === null) return null;
  if (r >= 7 && htc < 250) return 'significant';
  if ((r >= 4 && htc < 250) || (r >= 7 && htc < 350)) return 'worth_noting';
  return 'minimal';
}

// ===== Named export: applyHtcRescale =====
// Pure function — exported for direct unit-testing (T21–T23).
// Always recomputes from bare htc, never from a previous htc_used (idempotent).

export function applyHtcRescale(htc, payload) {
  if (htc === null) return { htc_used: null, htc_rescale_rejected: false };
  if (!payload)     return { htc_used: htc,  htc_rescale_rejected: false };
  const { setpoint_delta_k: delta, operating_delta_t_k: dTOp } = payload;
  const dTUser = dTOp + delta;
  if (dTOp <= 0 || dTUser <= 0) return { htc_used: htc, htc_rescale_rejected: true };
  const rescale = dTOp / dTUser;
  if (rescale < 0.8 || rescale > 1.2) return { htc_used: htc, htc_rescale_rejected: true };
  return { htc_used: htc * rescale, htc_rescale_rejected: false };
}

// ===== Main: estimateHeatLoss =====

export function estimateHeatLoss(heating, external, boilerEfficiency, setpointRescalePayload = null) {
  // Mint the per-HH thermal series before any filtering — always emitted.
  const thermal_heat_delivered_kwh = mintThermalHeatDelivered(heating, boilerEfficiency);

  const days = aggregateToDays(heating, external, boilerEfficiency);
  const { filtered, excluded } = filterForRegression(days);

  function insufficientDataResult() {
    return {
      htc_w_per_k:                null,
      htc_used:                   null,
      htc_confidence_interval_95: null,
      boiler_efficiency_used:     boilerEfficiency,
      thermal_heat_delivered_kwh,
      solar_aperture:             null,
      solar_correction_applied:   false,
      rating:                     null,
      solar_rating:               null,
      cooling_consideration:      null,
      htc_low_plausibility:       false,
      htc_rescale_rejected:       false,
      regression_r2:              null,
      days_used_in_fit:           0,
      days_excluded:              excluded,
      degree_day_base_c:          HDD_BASE_TEMP,
      validation_status:          'insufficient_data',
      warnings: ["Not enough heating data to calculate your home's heat loss. "
                 + "We need at least 20 days of clear heating signal (cold days below 15.5 °C "
                 + "outside). Come back in winter or with more data."],
    };
  }

  if (filtered.length < 20) return insufficientDataResult();

  const fit2 = runOLSTwoPredictor(filtered);

  let alpha, seAlpha, r2;
  let solar_correction_applied = true;
  let solar_aperture = null;
  const warnings = [];

  if (fit2.singular) {
    if (fit2.sx2sq / Math.max(1, fit2.sy2) < 1e-10) {
      const fit1 = runOLSOnePredictor(filtered);
      if (!fit1) return insufficientDataResult();
      alpha = fit1.alpha;
      seAlpha = fit1.seAlpha;
      r2 = fit1.r2;
      solar_correction_applied = false;
      warnings.push('Solar correction produced a physically implausible result (likely noisy data). Fell back to temperature-only regression.');
    } else {
      return insufficientDataResult();
    }
  } else if (fit2.alpha < 0) {
    // Inverted relationship — physically impossible; no fit produced
    return {
      htc_w_per_k:                null,
      htc_used:                   null,
      htc_confidence_interval_95: null,
      boiler_efficiency_used:     boilerEfficiency,
      thermal_heat_delivered_kwh,
      solar_aperture:             null,
      solar_correction_applied:   false,
      rating:                     null,
      solar_rating:               null,
      cooling_consideration:      null,
      htc_low_plausibility:       false,
      htc_rescale_rejected:       false,
      regression_r2:              fit2.r2,
      days_used_in_fit:           filtered.length,
      days_excluded:              excluded,
      degree_day_base_c:          HDD_BASE_TEMP,
      validation_status:          'poor',
      warnings: ['The relationship between cold weather and your heating use is inverted — this usually means a data issue or unusual heating pattern.'],
    };
  } else {
    const R = -fit2.beta;
    if (R < 0) {
      // Check 4A: negative solar aperture — refit without solar term
      const fit1 = runOLSOnePredictor(filtered);
      if (!fit1) return insufficientDataResult();
      alpha = fit1.alpha;
      seAlpha = fit1.seAlpha;
      r2 = fit1.r2;
      solar_correction_applied = false;
      warnings.push('Solar correction produced a physically implausible result (likely noisy data). Fell back to temperature-only regression.');
    } else {
      alpha = fit2.alpha;
      seAlpha = fit2.seAlpha;
      r2 = fit2.r2;
      solar_aperture = R;
    }
  }

  // Recover physical parameters — η-move: no boilerEfficiency factor (η is baked into the LHS)
  const htc = alpha * 1000 / 24;
  const ci = {
    lower: (alpha - 1.96 * seAlpha) * 1000 / 24,
    upper: (alpha + 1.96 * seAlpha) * 1000 / 24,
  };

  // Check 4C: R² quality (runs before 4B so 4B can override to 'poor')
  let validation_status;
  if (r2 === null || r2 < 0.5) {
    validation_status = 'poor';
    warnings.push(`Your heating demand doesn't fit the temperature model well (R² = ${r2 !== null ? r2.toFixed(2) : 'n/a'}). This usually means unusual patterns — variable occupancy, supplementary heating sources, or solar thermal. The HTC estimate may be unreliable.`);
  } else if (r2 < 0.7) {
    validation_status = 'acceptable';
  } else {
    validation_status = 'good';
  }

  // Check 4B: HTC plausibility — overrides 4C if out of range
  let htc_low_plausibility = false;
  if (htc < 50 || htc > 1500) {
    if (htc < 50) htc_low_plausibility = true;
    validation_status = 'poor';
    warnings.push(`The calculated heat transfer coefficient (${htc.toFixed(0)} W/K) is outside the plausible UK range (50–1500). This could indicate a wood burner, unusual fuel mix, or data issues. Treat results with caution.`);
  }

  // CI width warning
  if ((ci.upper - ci.lower) > 0.5 * htc) {
    warnings.push(`The uncertainty range on your heat loss estimate is wide (±${((ci.upper - ci.lower) / 2).toFixed(0)} W/K). More heating data would improve this.`);
  }

  // Step 6: ratings (on fitted htc — rating is a fabric property; rescale is setpoint-anchoring)
  const rating = buildRating(htc);
  let solar_rating = null;
  let cooling_consideration = null;
  if (solar_correction_applied && solar_aperture !== null) {
    solar_rating = buildSolarRating(solar_aperture);
    cooling_consideration = buildCoolingConsideration(htc, solar_aperture);
  }

  // Step 7: ±20%-bounded HTC rescale → htc_used (first pass: payload = null → htc_used = htc)
  const { htc_used, htc_rescale_rejected } = applyHtcRescale(htc, setpointRescalePayload);

  return {
    htc_w_per_k:                htc,
    htc_used,
    htc_confidence_interval_95: ci,
    boiler_efficiency_used:     boilerEfficiency,
    thermal_heat_delivered_kwh,
    solar_aperture,
    solar_correction_applied,
    rating,
    solar_rating,
    cooling_consideration,
    htc_low_plausibility,
    htc_rescale_rejected,
    regression_r2:              r2,
    days_used_in_fit:           filtered.length,
    days_excluded:              excluded,
    degree_day_base_c:          HDD_BASE_TEMP,
    validation_status,
    warnings,
  };
}
