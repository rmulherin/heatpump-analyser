// ===== Heat Loss Estimation Module (Module 4) =====
// Siviour regression: derives HTC (W/K) and solar aperture (m²) from daily
// heating demand vs degree-days and solar radiation. Through-origin OLS only —
// zero DD + zero sun ⇒ zero space-heating gas (opposite of baseload.js Step H).

import { HDD_BASE_TEMP } from './constants.js';

// ===== Shared state =====

let _heatLossResult = null;
export function setHeatLossResult(r) { _heatLossResult = r; }
export function getHeatLossResult() { return _heatLossResult; }

// ===== Private: daily aggregation =====

function aggregateToDays(heating, external) {
  const dayMap = new Map();
  for (let i = 0; i < heating.length; i++) {
    const day = heating[i].timestamp.slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day).push(i);
  }

  const days = [];
  for (const [dateStr, indices] of dayMap) {
    if (indices.length !== 48) continue;

    let daily_heating_kwh = 0;
    let missing_heating = false;
    let has_absence = false;
    for (const i of indices) {
      const h = heating[i];
      if (h.heating_kwh === null || h.heating_kwh === undefined) {
        missing_heating = true;
        break;
      }
      daily_heating_kwh += h.heating_kwh;
      if (h.is_absence) has_absence = true;
    }
    if (missing_heating) daily_heating_kwh = NaN;

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
      daily_heating_kwh,
      daily_solar_kwh_per_m2,
      daily_degree_days,
      has_absence,
      missing_heating,
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
    if (day.has_absence)             { excluded.absence++;                 continue; }
    if (day.daily_degree_days === 0) { excluded.zero_degree_days++;        continue; }
    if (day.missing_heating)         { excluded.missing_heating++;          continue; }
    if (day.missing_weather)         { excluded.missing_weather++;          continue; }
    if (day.daily_heating_kwh < 2.0) { excluded.below_heating_threshold++; continue; }
    filtered.push(day);
  }

  return { filtered, excluded };
}

// ===== Private: 2-predictor through-origin OLS =====
// Fits: y = α·x1 + β·x2  (no intercept)
// x1 = degree-days, x2 = solar kWh/m², y = daily heating kWh

function runOLSTwoPredictor(filtered) {
  const n = filtered.length;
  let sx1sq = 0, sx2sq = 0, sx1x2 = 0, sx1y = 0, sx2y = 0, sy2 = 0;
  for (const d of filtered) {
    const x1 = d.daily_degree_days;
    const x2 = d.daily_solar_kwh_per_m2;
    const y  = d.daily_heating_kwh;
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
    ss_res += (d.daily_heating_kwh - yhat) ** 2;
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
    const y  = d.daily_heating_kwh;
    sx1sq += x1 * x1;
    sx1y  += x1 * y;
    sy2   += y  * y;
  }

  if (sx1sq === 0) return null;

  const alpha = sx1y / sx1sq;

  let ss_res = 0;
  for (const d of filtered) {
    ss_res += (d.daily_heating_kwh - alpha * d.daily_degree_days) ** 2;
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

// ===== Main: estimateHeatLoss =====

export function estimateHeatLoss(heating, external, baseloadMetadata, supplementaryLoads, boilerEfficiency, floorAreaM2) {
  const zeroExcluded = { absence: 0, zero_degree_days: 0, missing_heating: 0, missing_weather: 0, below_heating_threshold: 0 };

  // Pre-flight: no-gas case — skip silently (Module 3 already surfaced it)
  if (baseloadMetadata.method === 'no-gas') {
    return {
      htc_w_per_k: null, htc_confidence_interval_95: null,
      htc_correction_w_per_k: null, htc_w_per_k_adjusted: null,
      rating: null,
      solar_aperture_m2: null, solar_rating: null, solar_correction_applied: false,
      cooling_consideration: null,
      hlp_w_per_m2_k: null,
      boiler_efficiency_used: boilerEfficiency,
      degree_day_base_c: HDD_BASE_TEMP,
      regression_r2: null, days_used_in_fit: 0,
      days_excluded: zeroExcluded,
      validation_status: 'no_gas',
      warnings: [],
    };
  }

  const days = aggregateToDays(heating, external);
  const { filtered, excluded } = filterForRegression(days);

  function insufficientDataResult() {
    return {
      htc_w_per_k: null, htc_confidence_interval_95: null,
      htc_correction_w_per_k: null, htc_w_per_k_adjusted: null,
      rating: null,
      solar_aperture_m2: null, solar_rating: null, solar_correction_applied: false,
      cooling_consideration: null,
      hlp_w_per_m2_k: null,
      boiler_efficiency_used: boilerEfficiency,
      degree_day_base_c: HDD_BASE_TEMP,
      regression_r2: null, days_used_in_fit: 0,
      days_excluded: excluded,
      validation_status: 'insufficient_data',
      warnings: ["Not enough heating data to calculate your home's heat loss. We need at least 20 days of heating (below 15.5°C outside). Come back in winter or with more data."],
    };
  }

  if (filtered.length < 20) return insufficientDataResult();

  const fit2 = runOLSTwoPredictor(filtered);

  let alpha, seAlpha, r2;
  let solar_correction_applied = true;
  let solar_aperture_m2 = null;
  const warnings = [];

  if (fit2.singular) {
    // Inspect cause: solar column near-zero variance → one-predictor fallback;
    // other singularity (degenerate data) → insufficient_data
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
    // Inverted relationship — physically impossible
    return {
      htc_w_per_k: null, htc_confidence_interval_95: null,
      htc_correction_w_per_k: null, htc_w_per_k_adjusted: null,
      rating: null,
      solar_aperture_m2: null, solar_rating: null, solar_correction_applied: false,
      cooling_consideration: null,
      hlp_w_per_m2_k: null,
      boiler_efficiency_used: boilerEfficiency,
      degree_day_base_c: HDD_BASE_TEMP,
      regression_r2: fit2.r2,
      days_used_in_fit: filtered.length,
      days_excluded: excluded,
      validation_status: 'poor',
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
      solar_aperture_m2 = R;
    }
  }

  // Recover physical parameters
  const htc = alpha * 1000 * boilerEfficiency / 24;
  const ci = {
    lower: (alpha - 1.96 * seAlpha) * 1000 * boilerEfficiency / 24,
    upper: (alpha + 1.96 * seAlpha) * 1000 * boilerEfficiency / 24,
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
  if (htc < 50 || htc > 1500) {
    validation_status = 'poor';
    warnings.push(`The calculated heat transfer coefficient (${htc.toFixed(0)} W/K) is outside the plausible UK range (50–1500). This could indicate a wood burner, unusual fuel mix, or data issues. Treat results with caution.`);
  }

  // Check 4D: supplementary electric heating correction
  let htc_correction = null;
  let htc_adjusted = null;
  if (
    supplementaryLoads?.electric_heating_detected &&
    (supplementaryLoads.electric_heating_confidence === 'high' ||
     supplementaryLoads.electric_heating_confidence === 'moderate') &&
    supplementaryLoads.electric_heating_kwh_per_dd !== null
  ) {
    htc_correction = (1000 / 24) * supplementaryLoads.electric_heating_kwh_per_dd;
    htc_adjusted = htc + htc_correction;
    const estKwh = supplementaryLoads.electric_heating_kwh_estimate != null
      ? `${supplementaryLoads.electric_heating_kwh_estimate.toFixed(0)} kWh`
      : 'some kWh';
    warnings.push(
      `Your home appears to use some electric heating (estimated ${estKwh}). Your heat loss may be underestimated by up to ${htc_correction.toFixed(0)} W/K — an adjusted estimate is ${htc_adjusted.toFixed(0)} W/K.`
    );
  }

  // CI width warning
  if ((ci.upper - ci.lower) > 0.5 * htc) {
    warnings.push(`The uncertainty range on your heat loss estimate is wide (±${((ci.upper - ci.lower) / 2).toFixed(0)} W/K). More heating data would improve this.`);
  }

  // Floor area plausibility warning
  if (floorAreaM2 !== null && (floorAreaM2 < 30 || floorAreaM2 > 500)) {
    warnings.push(`Floor area of ${floorAreaM2} m² seems unusual. Check this is in square metres, not square feet (1 m² = 10.76 ft²).`);
  }

  // Step 6: ratings and HLP
  const rating = buildRating(htc);
  let solar_rating = null;
  let cooling_consideration = null;
  if (solar_correction_applied && solar_aperture_m2 !== null) {
    solar_rating = buildSolarRating(solar_aperture_m2);
    cooling_consideration = buildCoolingConsideration(htc, solar_aperture_m2);
  }
  const hlp = (floorAreaM2 !== null && floorAreaM2 > 0) ? htc / floorAreaM2 : null;

  return {
    htc_w_per_k: htc,
    htc_confidence_interval_95: ci,
    htc_correction_w_per_k: htc_correction,
    htc_w_per_k_adjusted: htc_adjusted,
    rating,
    solar_aperture_m2,
    solar_rating,
    solar_correction_applied,
    cooling_consideration,
    hlp_w_per_m2_k: hlp,
    boiler_efficiency_used: boilerEfficiency,
    degree_day_base_c: HDD_BASE_TEMP,
    regression_r2: r2,
    days_used_in_fit: filtered.length,
    days_excluded: excluded,
    validation_status,
    warnings,
  };
}
