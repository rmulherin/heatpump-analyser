// ===== Thermal Character Module (Module 5) =====
// Infers setpoint, thermal mass, time constant, and occupancy weights
// from observed heating pattern and M4 heat loss estimate.

// ===== Shared state =====

let _thermalCharacterResult = null;
export function setThermalCharacterResult(r) { _thermalCharacterResult = r; }
export function getThermalCharacterResult()   { return _thermalCharacterResult; }

// ===== Constants =====

const TC_CONFIG = {
  SUSTAINED_BLOCK_MIN_HH:   4,
  SETPOINT_SKIP_INITIAL_HH: 2,
  SETPOINT_CLIP_MIN_C:      14,
  SETPOINT_CLIP_MAX_C:      25,
  SETPOINT_MIN_HH:          20,
  SETPOINT_LOW_WARN_C:      16,
  SETPOINT_HIGH_WARN_C:     23,
  OFF_PERIOD_MIN_HH:        4,
  OFF_PERIOD_THRESHOLD_KWH: 0.05,
  WINTER_TEMP_MAX_C:        10,
  SETTLED_RATIO:            1.2,
  MIN_EVENTS_FOR_MASS:      5,
  OUTLIER_PCTILE_LOW:       0.05,
  OUTLIER_PCTILE_HIGH:      0.95,
  TAU_SEED_HOURS:           5.0,
  ITERATIONS:               3,
  MIN_DAYS_OCCUPANCY:       14,
  MASS_RATING_MEDIUM_KJ:    6000,
  MASS_RATING_HIGH_KJ:      15000,
  MASS_RATING_VERY_HIGH_KJ: 30000,
  TAU_HIGH_WARN_HOURS:      30,
  TAU_LOW_WARN_HOURS:       2,
  T_AT_RESTART_MIN_C:       5,
  T_AT_RESTART_MAX_C:       19,
  LONG_EVENT_OFF_HH:        48,
  TAU_SANITY_HIGH_RATIO:    2.0,
  TAU_SANITY_LOW_RATIO:     0.5,
  UNDERHEAT_RATIO_LOW:      0.85,   // < this → "underheat"
  UNDERHEAT_RATIO_HIGH:     1.15,   // > this → "overheat"
};

const WALL_CONSTRUCTION_RANGES = {
  solid_masonry: { min: 15000, max: 45000 },
  cavity_wall:   { min:  6000, max: 20000 },
  timber_frame:  { min:  2000, max:  8000 },
};

const TAU_BUCKET_HOURS_MAP = {
  fast:            4,
  evening:        10,
  all_day:        20,
  stays_for_days: 40,
};

// ===== Helpers =====

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return null;
  const idx = p * (sortedArr.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] * (hi - idx) + sortedArr[hi] * (idx - lo);
}

function computeC(T_at_restart, E_warmup_kwh, warmup_hh_count, T_outdoor_warmup,
                  htc, eta, setpointC) {
  const E_warmup_kj   = E_warmup_kwh * 3600;
  const T_mean_warmup = (T_at_restart + setpointC) / 2;
  const t_warmup_h    = warmup_hh_count * 0.5;
  const E_heatloss_kj = htc * (T_mean_warmup - T_outdoor_warmup) * t_warmup_h * 3.6;
  const E_net_kj      = E_warmup_kj * eta - E_heatloss_kj;
  const delta_T       = setpointC - T_at_restart;
  if (E_net_kj > 0 && delta_T > 0.5) return E_net_kj / delta_T;
  return null;
}

// ===== Comfort-demand diagnostic helpers (Phase 1, smart-scenario-fixes-1) =====

function computeModelledHeatingByHh(heating, external, heatLoss, setpointC) {
  const htc = heatLoss?.htc_w_per_k;
  const aperture = (heatLoss?.solar_correction_applied && heatLoss?.solar_aperture_m2 != null)
    ? heatLoss.solar_aperture_m2 : 0;

  const out = new Array(heating.length).fill(null);
  if (htc == null || setpointC == null) return out;

  for (let i = 0; i < heating.length; i++) {
    const tc = external[i]?.temp_c;
    if (tc == null) continue;
    const lossKwh  = htc * Math.max(0, setpointC - tc) * 0.5 / 1000;
    const solarKwh = aperture * (external[i]?.solar_w_m2 ?? 0) * 0.5 / 1000;
    out[i] = Math.max(0, lossKwh - solarKwh);
  }
  return out;
}

function computeUnderheatStatus(modelledByHh, heating, eta) {
  const annualModelled = modelledByHh.reduce((s, v) => v == null ? s : s + v, 0);
  const annualObserved = heating.reduce(
    (s, h) => (h.heating_kwh != null && !h.is_absence) ? s + h.heating_kwh * eta : s,
    0,
  );

  // Insufficient_data covers: no modelled demand (null/0 — missing HTC/setpoint or no
  // weather), AND no observed demand (null/0 — baseload separation found no heating
  // signal). Either edge produces a degenerate ratio that should not surface narrative.
  if (!annualModelled || annualModelled === 0 || !annualObserved || annualObserved === 0) {
    return {
      annual_modelled_demand_kwh: annualModelled || null,
      annual_observed_demand_kwh: annualObserved || null,
      underheat_ratio:  null,
      underheat_status: 'insufficient_data',
    };
  }
  const ratio = annualObserved / annualModelled;
  const status = ratio < TC_CONFIG.UNDERHEAT_RATIO_LOW  ? 'underheat'
               : ratio > TC_CONFIG.UNDERHEAT_RATIO_HIGH ? 'overheat'
               : 'match';
  return {
    annual_modelled_demand_kwh: annualModelled,
    annual_observed_demand_kwh: annualObserved,
    underheat_ratio:  ratio,
    underheat_status: status,
  };
}

function buildUnderheatNarrative(underheat, setpointC) {
  if (underheat.underheat_status === 'insufficient_data' || setpointC == null) return '';
  const fmtKwh = v => (Math.round(v / 100) * 100).toLocaleString('en-GB');
  const sp = setpointC.toFixed(1);
  const { underheat_status: status, annual_modelled_demand_kwh: Y,
          annual_observed_demand_kwh: X, underheat_ratio: ratio } = underheat;
  if (status === 'underheat') {
    const pctLess = Math.round((1 - ratio) * 100);
    return `You appear to be underheating. To keep your home at ${sp}°C year-round `
         + `you'd need around ${fmtKwh(Y)} kWh of heat. Your data shows you used around `
         + `${fmtKwh(X)} kWh — about ${pctLess}% less. Many UK households underheat to `
         + `manage gas bills; the cost figures below assume you continue your current `
         + `heating pattern. To see what proper comfort would cost, use the Heat to Comfort `
         + `slider in What If.`;
  }
  if (status === 'overheat') {
    return `Your heating exceeds the modelled demand for ${sp}°C. Possible causes include `
         + `open windows, heat lost to unoccupied spaces, or an HTC estimate that `
         + `underestimates your true heat loss. The cost figures below reflect your actual usage.`;
  }
  return `Your heating matches the modelled comfort demand for ${sp}°C — your setpoint and your usage are consistent.`;
}

// ===== Step 1: Per-day summaries =====

function buildDaySummaries(heating, external) {
  const dayMap = new Map();
  for (let i = 0; i < heating.length; i++) {
    const day = heating[i].timestamp.slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day).push(i);
  }

  const result = new Map();
  for (const [dateStr, indices] of dayMap) {
    if (indices.length !== 48) continue;

    let valid = true;
    let dailyHeatingKwh = 0;
    let isAbsence = false;
    let tempSum = 0;

    for (const i of indices) {
      const h = heating[i];
      const e = external[i];
      if (h.heating_kwh === null || h.heating_kwh === undefined ||
          !e || e.temp_c === null || e.temp_c === undefined) {
        valid = false;
        break;
      }
      dailyHeatingKwh += h.heating_kwh;
      if (h.is_absence) isAbsence = true;
      tempSum += e.temp_c;
    }

    if (!valid) continue;

    result.set(dateStr, {
      dailyMeanTempC: tempSum / 48,
      dailyHeatingKwh,
      isAbsence,
      isHeatingDay: dailyHeatingKwh > 0.5,
      hhIndices: indices,
    });
  }

  return result;
}

// ===== Step 2: Occupancy weights =====

function computeOccupancyWeights(heating, daySummaries) {
  const nonAbsenceDays = [];
  for (const [, summary] of daySummaries) {
    if (!summary.isAbsence) nonAbsenceDays.push(summary.hhIndices);
  }

  const countTotal = nonAbsenceDays.length;
  if (countTotal < TC_CONFIG.MIN_DAYS_OCCUPANCY) {
    return { occupancy_weights: null, warning: 'Not enough data to estimate heating pattern.' };
  }

  const countHeated = new Array(48).fill(0);
  for (const indices of nonAbsenceDays) {
    for (let h = 0; h < 48; h++) {
      if (heating[indices[h]].heating_kwh > 0) countHeated[h]++;
    }
  }

  return {
    occupancy_weights: countHeated.map(c => c / countTotal),
    warning: null,
  };
}

// ===== Step 3: Setpoint inference =====

function estimateSetpoint(heating, external, htc, eta) {
  const estimates = [];
  const n = heating.length;
  let i = 0;

  while (i < n) {
    if (!heating[i] || heating[i].heating_kwh === null || heating[i].heating_kwh <= 0) {
      i++;
      continue;
    }

    // Measure length of this sustained heating block
    const blockStart = i;
    while (i < n && heating[i].heating_kwh !== null && heating[i].heating_kwh > 0) i++;
    const blockEnd = i;

    if (blockEnd - blockStart < TC_CONFIG.SUSTAINED_BLOCK_MIN_HH) continue;

    // Skip first SETPOINT_SKIP_INITIAL_HH periods (transient warm-up)
    for (let j = blockStart + TC_CONFIG.SETPOINT_SKIP_INITIAL_HH; j < blockEnd; j++) {
      const h = heating[j];
      const e = external[j];
      if (h.is_absence) continue;
      if (!e || e.temp_c === null) continue;
      const est = e.temp_c + (h.heating_kwh * 2000 * eta) / htc;
      if (est < TC_CONFIG.SETPOINT_CLIP_MIN_C || est > TC_CONFIG.SETPOINT_CLIP_MAX_C) continue;
      estimates.push(est);
    }
  }

  const warnings = [];
  const setpoint_days_used = estimates.length;

  if (setpoint_days_used < TC_CONFIG.SETPOINT_MIN_HH) {
    warnings.push('Insufficient sustained heating data to infer thermostat setpoint.');
    return { setpoint_c: null, setpoint_days_used, warnings };
  }

  if (setpoint_days_used < 50) {
    warnings.push('Setpoint estimate uses fewer than 50 sustained heating periods — treat with moderate confidence.');
  }

  const setpoint_c = median(estimates);

  if (setpoint_c < TC_CONFIG.SETPOINT_LOW_WARN_C) {
    warnings.push(`Inferred setpoint of ${setpoint_c.toFixed(1)}°C is low — this may reflect daytime setback or an unusual heating pattern.`);
  } else if (setpoint_c > TC_CONFIG.SETPOINT_HIGH_WARN_C) {
    warnings.push(`Inferred setpoint of ${setpoint_c.toFixed(1)}°C is high — this may reflect a particularly warm household preference.`);
  }

  return { setpoint_c, setpoint_days_used, warnings };
}

// ===== Step 4: Thermal mass inference =====

function estimateThermalMass(heating, external, htc, eta, setpointC, tAtRestartWinterC) {
  const n = heating.length;
  const validEvents = [];
  let anyOffPeriodFound = false;
  let longEventDiscardedForMissingUserTemp = false;
  let i = 0;

  while (i < n) {
    if (!heating[i] || heating[i].heating_kwh === null ||
        heating[i].heating_kwh >= TC_CONFIG.OFF_PERIOD_THRESHOLD_KWH) {
      i++;
      continue;
    }

    const offStart = i;
    while (i < n && heating[i].heating_kwh !== null &&
           heating[i].heating_kwh < TC_CONFIG.OFF_PERIOD_THRESHOLD_KWH) i++;
    const offEnd = i;

    if (offEnd - offStart < TC_CONFIG.OFF_PERIOD_MIN_HH) continue;
    anyOffPeriodFound = true;

    // Anchor check: preceding HH must have positive non-absent heating
    if (offStart === 0) continue;
    const prev = heating[offStart - 1];
    if (prev.heating_kwh == null || prev.heating_kwh <= 0 || prev.is_absence === true) continue;

    // Restart HH valid check
    if (i >= n || heating[i].heating_kwh === null ||
        heating[i].heating_kwh < TC_CONFIG.OFF_PERIOD_THRESHOLD_KWH) continue;
    const restartIdx = i;

    // T_outdoor_off mean
    let offTempSum = 0, offTempCount = 0;
    for (let j = offStart; j < offEnd; j++) {
      if (external[j] && external[j].temp_c !== null) {
        offTempSum += external[j].temp_c;
        offTempCount++;
      }
    }
    if (offTempCount === 0) continue;
    const T_outdoor_off = offTempSum / offTempCount;
    const t_off_hours   = (offEnd - offStart) * 0.5;

    // Winter filter
    if (T_outdoor_off >= TC_CONFIG.WINTER_TEMP_MAX_C) continue;

    // Warm-up phase scan
    const warmup_indices = [];
    let E_warmup_kwh = 0;
    let wuTempSum = 0, wuTempCount = 0;
    const scanEnd = Math.min(restartIdx + 48, n);

    for (let j = restartIdx; j < scanEnd; j++) {
      if (!heating[j] || heating[j].heating_kwh === null) break;
      const e = external[j];

      if (e && e.temp_c !== null) {
        const ss_kwh = htc * (setpointC - e.temp_c) * 0.5 / (eta * 1000);
        if (ss_kwh > 0 && heating[j].heating_kwh <= TC_CONFIG.SETTLED_RATIO * ss_kwh) break;
      }

      warmup_indices.push(j);
      E_warmup_kwh += heating[j].heating_kwh;
      if (e && e.temp_c !== null) { wuTempSum += e.temp_c; wuTempCount++; }
    }

    if (wuTempCount === 0) continue;
    const T_outdoor_warmup = wuTempSum / wuTempCount;
    const warmup_hh_count  = warmup_indices.length;

    // Relaxed absence check: warm-up must be absence-free; off period may contain absence
    let warmupHasAbsence = false;
    for (const j of warmup_indices) {
      if (heating[j].is_absence) { warmupHasAbsence = true; break; }
    }
    if (warmupHasAbsence) continue;

    let containsAbsenceInOff = false;
    for (let j = offStart; j < offEnd; j++) {
      if (heating[j].is_absence) { containsAbsenceInOff = true; break; }
    }

    // Classify: long if off-period > LONG_EVENT_OFF_HH or contains absence
    const isLongEvent = (offEnd - offStart > TC_CONFIG.LONG_EVENT_OFF_HH) || containsAbsenceInOff;

    if (isLongEvent) {
      if (tAtRestartWinterC === null) {
        longEventDiscardedForMissingUserTemp = true;
        continue;
      }
      validEvents.push({ kind: 'long', T_at_restart: tAtRestartWinterC,
                         warmup_hh_count, E_warmup_kwh, T_outdoor_warmup });
    } else {
      validEvents.push({ kind: 'short', T_outdoor_off, t_off_hours,
                         warmup_hh_count, E_warmup_kwh, T_outdoor_warmup });
    }
  }

  // Long-event C estimates — independent of τ_seed, computed once
  const longC = [];
  for (const ev of validEvents.filter(ev => ev.kind === 'long')) {
    const c = computeC(ev.T_at_restart, ev.E_warmup_kwh, ev.warmup_hh_count,
                       ev.T_outdoor_warmup, htc, eta, setpointC);
    if (c !== null) longC.push(c);
  }

  // Short-event C estimates — iterative with carry-over (mirrors original last_good_estimates)
  let tauSeed = TC_CONFIG.TAU_SEED_HOURS;
  let lastGoodShortFinal = [];

  for (let iter = 0; iter < TC_CONFIG.ITERATIONS; iter++) {
    const shortFinal = [];
    for (const ev of validEvents.filter(ev => ev.kind === 'short')) {
      const T_at_restart = ev.T_outdoor_off + (setpointC - ev.T_outdoor_off)
                                            * Math.exp(-ev.t_off_hours / tauSeed);
      const c = computeC(T_at_restart, ev.E_warmup_kwh, ev.warmup_hh_count,
                         ev.T_outdoor_warmup, htc, eta, setpointC);
      if (c !== null) shortFinal.push(c);
    }
    if (shortFinal.length > 0) {
      lastGoodShortFinal = shortFinal;
      tauSeed = median(shortFinal) / (htc * 3.6);
    }
  }

  // Pool: last good short estimates + all long estimates
  // Note: events_used reflects count before percentile filter; the 5-event gate checks this count
  const allEstimates = [...lastGoodShortFinal, ...longC];
  const events_used = allEstimates.length;

  let thermal_mass_kj_per_k = null;
  let thermal_mass_source = null;

  if (events_used >= TC_CONFIG.MIN_EVENTS_FOR_MASS) {
    const sorted = [...allEstimates].sort((a, b) => a - b);
    const lo = percentile(sorted, TC_CONFIG.OUTLIER_PCTILE_LOW);
    const hi = percentile(sorted, TC_CONFIG.OUTLIER_PCTILE_HIGH);
    thermal_mass_kj_per_k = median(sorted.filter(v => v >= lo && v <= hi));
    thermal_mass_source = 'measured_cold_soak';
  }

  return {
    thermal_mass_kj_per_k,
    thermal_mass_source,
    events_used,
    warnings: [],
    any_off_period_found: anyOffPeriodFound,
    long_event_discarded_for_missing_user_temp: longEventDiscardedForMissingUserTemp,
  };
}

// ===== Step 5: Time constant and thermal mass rating =====

function computeRatingAndTimeConstant(thermalMassKjPerK, htcWPerK) {
  const tcWarns = [];
  let time_constant_hours = null;
  let thermal_mass_rating = null;

  if (thermalMassKjPerK !== null && htcWPerK !== null) {
    time_constant_hours = thermalMassKjPerK / (htcWPerK * 3.6);
    if (time_constant_hours > TC_CONFIG.TAU_HIGH_WARN_HOURS) {
      tcWarns.push('Very high thermal time constant suggests very heavy construction or low heat loss.');
    } else if (time_constant_hours < TC_CONFIG.TAU_LOW_WARN_HOURS) {
      tcWarns.push('Very short thermal time constant suggests lightweight construction or high heat loss.');
    }
  }

  if (thermalMassKjPerK !== null) {
    if      (thermalMassKjPerK < TC_CONFIG.MASS_RATING_MEDIUM_KJ)    thermal_mass_rating = 'low';
    else if (thermalMassKjPerK < TC_CONFIG.MASS_RATING_HIGH_KJ)      thermal_mass_rating = 'medium';
    else if (thermalMassKjPerK < TC_CONFIG.MASS_RATING_VERY_HIGH_KJ) thermal_mass_rating = 'high';
    else                                                               thermal_mass_rating = 'very_high';
  }

  return { time_constant_hours, thermal_mass_rating, tcWarns };
}

// ===== Tau-bucket sanity check =====

function checkTauBucketSanity(time_constant_hours, tauBucket, source) {
  if (source !== 'measured_cold_soak') return null;
  if (!tauBucket || time_constant_hours == null) return null;
  const midpoint = TAU_BUCKET_HOURS_MAP[tauBucket];
  if (midpoint === undefined) return null;
  const ratio = time_constant_hours / midpoint;
  if (ratio > TC_CONFIG.TAU_SANITY_HIGH_RATIO || ratio < TC_CONFIG.TAU_SANITY_LOW_RATIO) {
    // Lower-cased forms of the UI <option> text — appear inside a sentence
    const labels = {
      fast:           'cools noticeably within a few hours',
      evening:        'stays warm into the evening, cooler by morning',
      all_day:        'holds its warmth for most of a day',
      stays_for_days: 'stays warm for days — takes ages to cool',
    };
    return `Your data suggests a thermal time constant of ${time_constant_hours.toFixed(1)} h, `
         + `but your description (${labels[tauBucket]}) implies around ${midpoint} h. `
         + 'The data-driven figure is used — a large gap can indicate measurement noise, '
         + "irregular heating patterns, or that the lived-experience description didn't "
         + 'match the data.';
  }
  return null;
}

// ===== Wall construction validation =====

function checkWallConstruction(thermalMassKjPerK, wallConstructionType) {
  if (!wallConstructionType || thermalMassKjPerK === null) return { warning: null };
  const range = WALL_CONSTRUCTION_RANGES[wallConstructionType];
  if (!range) return { warning: null };
  if (thermalMassKjPerK >= range.min && thermalMassKjPerK <= range.max) return { warning: null };

  const direction = thermalMassKjPerK < range.min ? 'lower' : 'higher';
  const typeLabel  = wallConstructionType.replace(/_/g, ' ');
  return {
    warning: `Measured thermal mass (${Math.round(thermalMassKjPerK).toLocaleString()} kJ/K) is ${direction} than typical for ${typeLabel} construction (expected ${range.min.toLocaleString()}–${range.max.toLocaleString()} kJ/K). This could indicate heavier internal structure, significant mass from a wood burner or water tank, or a data issue.`,
  };
}

// ===== Step 6: Validation status =====

function computeValidationStatus(setpointC, thermalMassKjPerK, source, setpointDaysUsed, eventsUsed) {
  if (setpointC === null && thermalMassKjPerK === null) return 'insufficient_data';
  if (setpointC !== null && thermalMassKjPerK !== null
      && source === 'measured_cold_soak'
      && setpointDaysUsed >= 50 && eventsUsed >= 10) return 'good';
  return 'acceptable';
}

// ===== Main export =====

export function estimateThermalCharacter(heating, external, heatLoss, baseloadMethod,
                                          wallConstructionType,
                                          tAtRestartWinterC, tauBucket) {
  const nullResult = (validation_status) => ({
    setpoint_c: null,
    thermal_mass_kj_per_k: null,
    thermal_mass_source: null,
    time_constant_hours: null,
    thermal_mass_rating: null,
    occupancy_weights: null,
    setpoint_days_used: 0,
    thermal_mass_events_used: 0,
    validation_status,
    long_event_discarded_for_missing_user_temp: false,
    warnings: [],
    modelled_heating_kwh_by_hh: null,
    annual_modelled_demand_kwh: null,
    annual_observed_demand_kwh: null,
    underheat_ratio: null,
    underheat_status: 'insufficient_data',
    underheat_narrative: '',
  });

  if (baseloadMethod === 'no-gas') return nullResult('no_gas');
  if (!heatLoss || heatLoss.htc_w_per_k === null) return nullResult('no_htc');

  const htc = heatLoss.htc_w_per_k;
  const eta = heatLoss.boiler_efficiency_used;

  // Plausibility check on tAtRestartWinterC (range gate, before setpoint is known)
  const inputWarnings = [];
  let validatedTAtRestart = (tAtRestartWinterC == null) ? null : tAtRestartWinterC;
  if (validatedTAtRestart !== null) {
    if (validatedTAtRestart < TC_CONFIG.T_AT_RESTART_MIN_C
        || validatedTAtRestart > TC_CONFIG.T_AT_RESTART_MAX_C) {
      inputWarnings.push(
        `Provided indoor temperature on return (${validatedTAtRestart}°C) is outside the `
        + 'plausible range — value ignored.'
      );
      validatedTAtRestart = null;
    }
  }

  const daySummaries = buildDaySummaries(heating, external);

  const { occupancy_weights, warning: owWarn } = computeOccupancyWeights(heating, daySummaries);

  const { setpoint_c, setpoint_days_used, warnings: spWarns } =
    estimateSetpoint(heating, external, htc, eta);

  // Setpoint comparison: reject tAtRestart if at or above the inferred setpoint
  if (validatedTAtRestart !== null && setpoint_c !== null
      && validatedTAtRestart >= setpoint_c) {
    inputWarnings.push(
      `Provided indoor temperature on return (${validatedTAtRestart}°C) is at or above `
      + `your inferred setpoint (${setpoint_c.toFixed(1)}°C) — value ignored.`
    );
    validatedTAtRestart = null;
  }

  // Defaults for fields from estimateThermalMass (used in Step 4c warnings even if not called)
  let thermal_mass_kj_per_k = null;
  let thermal_mass_source = null;
  let thermal_mass_events_used = 0;
  let massWarns = [];
  let any_off_period_found = false;
  let long_event_discarded_for_missing_user_temp = false;

  if (setpoint_c !== null) {
    const massResult = estimateThermalMass(
      heating, external, htc, eta, setpoint_c, validatedTAtRestart
    );
    ({ thermal_mass_kj_per_k, thermal_mass_source,
       events_used: thermal_mass_events_used,
       warnings: massWarns,
       any_off_period_found,
       long_event_discarded_for_missing_user_temp } = massResult);
  }

  // Capture Path A value before Path B block — must precede the Path B override
  const path_a_kj_per_k = thermal_mass_kj_per_k;
  const path_a_tau_h    = (path_a_kj_per_k !== null && htc !== null)
    ? path_a_kj_per_k / (htc * 3.6) : null;

  // Path B: lived-experience τ_bucket fallback when Path A produced insufficient events
  let pathBWarning = null;
  if (thermal_mass_source === null && tauBucket && htc !== null) {
    const tauHours = TAU_BUCKET_HOURS_MAP[tauBucket];
    if (tauHours !== undefined) {
      thermal_mass_kj_per_k = tauHours * htc * 3.6;
      thermal_mass_source   = 'user_tau';
      pathBWarning = 'Thermal mass estimated from your description of how the home holds '
                   + 'its warmth (insufficient cold-soak events were found in your data). '
                   + 'For pre-heating analysis this is indicative — a data-driven estimate '
                   + 'would normally be more precise.';
    }
  }

  const path_b_kj_per_k = (thermal_mass_source === 'user_tau') ? thermal_mass_kj_per_k : null;
  const path_b_tau_h    = (path_b_kj_per_k !== null && htc !== null)
    ? path_b_kj_per_k / (htc * 3.6) : null;

  // Step 4c: failure-path warnings (only when both paths failed)
  // thermal_mass_events_used reflects Path A's data-driven count even when Path B supplied the value
  const stepCWarnings = [];
  if (thermal_mass_source === null) {
    if (!any_off_period_found && !tauBucket) {
      stepCWarnings.push(
        'Heating appears to run continuously overnight — not enough cold-soak data '
        + 'to estimate thermal mass. Describing how your home holds its warmth would '
        + 'unlock smart pre-heating analysis.'
      );
    } else if (any_off_period_found && !tauBucket) {
      stepCWarnings.push(
        'Not enough overnight cold-soak events to estimate thermal mass. Either more '
        + 'winter data is needed, or you can describe how your home holds its warmth '
        + 'to enable smart pre-heating analysis.'
      );
    }
    if (long_event_discarded_for_missing_user_temp) {
      stepCWarnings.push(
        "If you've returned home from being away during winter, providing the indoor "
        + 'temperature you typically find on return would unlock additional events from '
        + 'your data.'
      );
    }
  }

  const { time_constant_hours, thermal_mass_rating, tcWarns } =
    computeRatingAndTimeConstant(thermal_mass_kj_per_k, htc);

  const sanityWarning = checkTauBucketSanity(time_constant_hours, tauBucket, thermal_mass_source);

  const { warning: wcWarn } = checkWallConstruction(thermal_mass_kj_per_k, wallConstructionType);

  const validation_status = computeValidationStatus(
    setpoint_c, thermal_mass_kj_per_k, thermal_mass_source, setpoint_days_used, thermal_mass_events_used
  );

  const modelledByHh      = computeModelledHeatingByHh(heating, external, heatLoss, setpoint_c);
  const underheat         = computeUnderheatStatus(modelledByHh, heating, eta);
  const underheatNarrative = buildUnderheatNarrative(underheat, setpoint_c);

  return {
    setpoint_c,
    thermal_mass_kj_per_k,
    thermal_mass_source,
    time_constant_hours,
    thermal_mass_rating,
    occupancy_weights,
    setpoint_days_used,
    thermal_mass_events_used,
    validation_status,
    long_event_discarded_for_missing_user_temp,
    warnings: [
      ...spWarns,
      ...massWarns,
      ...tcWarns,
      ...inputWarnings,
      ...(pathBWarning ? [pathBWarning] : []),
      ...stepCWarnings,
      ...(sanityWarning ? [sanityWarning] : []),
      ...(owWarn ? [owWarn] : []),
      ...(wcWarn ? [wcWarn] : []),
    ],
    modelled_heating_kwh_by_hh: modelledByHh,
    annual_modelled_demand_kwh: underheat.annual_modelled_demand_kwh,
    annual_observed_demand_kwh: underheat.annual_observed_demand_kwh,
    underheat_ratio:            underheat.underheat_ratio,
    underheat_status:           underheat.underheat_status,
    underheat_narrative:        underheatNarrative,
    _path_diagnostics: {
      path_a_kj_per_k,
      path_a_tau_h,
      path_b_kj_per_k,
      path_b_tau_h,
    },
  };
}
