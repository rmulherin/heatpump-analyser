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
};

const WALL_CONSTRUCTION_RANGES = {
  solid_masonry: { min: 15000, max: 45000 },
  cavity_wall:   { min:  6000, max: 20000 },
  timber_frame:  { min:  2000, max:  8000 },
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

function estimateThermalMass(heating, external, htc, eta, setpointC) {
  const n = heating.length;
  const validEvents = [];
  let anyOffPeriodFound = false;
  let i = 0;

  while (i < n) {
    // Find start of an off period
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

    // Step 1: Restart HH immediately after off period
    if (i >= n || heating[i].heating_kwh === null ||
        heating[i].heating_kwh < TC_CONFIG.OFF_PERIOD_THRESHOLD_KWH) continue;
    const restartIdx = i;

    // Step 2: T_outdoor_off — off period's own mean
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

    // Step 3: Winter filter (off period's mean must be < 10°C)
    if (T_outdoor_off >= TC_CONFIG.WINTER_TEMP_MAX_C) continue;

    // Step 3a: Compute and cache warm-up range (iteration-invariant)
    const warmup_indices = [];
    let E_warmup_kwh = 0;
    let wuTempSum = 0, wuTempCount = 0;
    const scanEnd = Math.min(restartIdx + 48, n);

    for (let j = restartIdx; j < scanEnd; j++) {
      if (!heating[j] || heating[j].heating_kwh === null) break;
      const e = external[j];

      // Evaluate settled criterion where temp_c is available
      if (e && e.temp_c !== null) {
        const ss_kwh = htc * (setpointC - e.temp_c) * 0.5 / (eta * 1000);
        if (ss_kwh > 0 && heating[j].heating_kwh <= TC_CONFIG.SETTLED_RATIO * ss_kwh) break;
      }

      warmup_indices.push(j);
      E_warmup_kwh += heating[j].heating_kwh;
      if (e && e.temp_c !== null) { wuTempSum += e.temp_c; wuTempCount++; }
    }

    if (wuTempCount === 0) continue; // cannot compute T_outdoor_warmup
    const T_outdoor_warmup = wuTempSum / wuTempCount;
    const warmup_hh_count  = warmup_indices.length;

    // Step 4: Absence check — off period and warm-up phase
    let hasAbsence = false;
    for (let j = offStart; j < offEnd && !hasAbsence; j++) {
      if (heating[j].is_absence) hasAbsence = true;
    }
    for (const j of warmup_indices) {
      if (heating[j].is_absence) { hasAbsence = true; break; }
    }
    if (hasAbsence) continue;

    validEvents.push({ T_outdoor_off, t_off_hours, warmup_hh_count, E_warmup_kwh, T_outdoor_warmup });
  }

  // Iterative C estimation (3 passes, cached warm-up values)
  let tauSeed = TC_CONFIG.TAU_SEED_HOURS;
  let last_good_estimates = null;

  for (let iter = 0; iter < TC_CONFIG.ITERATIONS; iter++) {
    const C_estimates = [];

    for (const ev of validEvents) {
      const T_at_restart  = ev.T_outdoor_off + (setpointC - ev.T_outdoor_off) * Math.exp(-ev.t_off_hours / tauSeed);
      const E_warmup_kj   = ev.E_warmup_kwh * 3600;
      const T_mean_warmup = (T_at_restart + setpointC) / 2;
      const t_warmup_h    = ev.warmup_hh_count * 0.5;
      const E_heatloss_kj = htc * (T_mean_warmup - ev.T_outdoor_warmup) * t_warmup_h * 3.6;
      const E_net_kj      = E_warmup_kj * eta - E_heatloss_kj;
      const delta_T       = setpointC - T_at_restart;

      if (E_net_kj > 0 && delta_T > 0.5) C_estimates.push(E_net_kj / delta_T);
    }

    if (C_estimates.length > 0) {
      last_good_estimates = C_estimates;
      tauSeed = median(C_estimates) / (htc * 3.6);
    }
  }

  const warnings = [];

  if (!last_good_estimates || last_good_estimates.length < TC_CONFIG.MIN_EVENTS_FOR_MASS) {
    warnings.push(anyOffPeriodFound
      ? 'Not enough overnight cold-soak events to estimate thermal mass. More winter data needed.'
      : 'Heating appears to run continuously overnight — not enough cold-soak data to estimate thermal mass.');
    return { thermal_mass_kj_per_k: null, events_used: last_good_estimates?.length ?? 0, warnings };
  }

  // 5th–95th percentile outlier filter
  const sorted = [...last_good_estimates].sort((a, b) => a - b);
  const lo = percentile(sorted, TC_CONFIG.OUTLIER_PCTILE_LOW);
  const hi = percentile(sorted, TC_CONFIG.OUTLIER_PCTILE_HIGH);

  return {
    thermal_mass_kj_per_k: median(sorted.filter(v => v >= lo && v <= hi)),
    events_used: last_good_estimates.length,
    warnings,
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

function computeValidationStatus(setpointC, thermalMassKjPerK, setpointDaysUsed, eventsUsed) {
  if (setpointC === null && thermalMassKjPerK === null) return 'insufficient_data';
  if (setpointC !== null && thermalMassKjPerK !== null &&
      setpointDaysUsed >= 50 && eventsUsed >= 10) return 'good';
  return 'acceptable';
}

// ===== Main export =====

export function estimateThermalCharacter(heating, external, heatLoss, baseloadMethod, wallConstructionType) {
  const nullResult = (validation_status) => ({
    setpoint_c: null,
    thermal_mass_kj_per_k: null,
    time_constant_hours: null,
    thermal_mass_rating: null,
    occupancy_weights: null,
    setpoint_days_used: 0,
    thermal_mass_events_used: 0,
    validation_status,
    warnings: [],
  });

  if (baseloadMethod === 'no-gas') return nullResult('no_gas');
  if (!heatLoss || heatLoss.htc_w_per_k === null) return nullResult('no_htc');

  const htc = heatLoss.htc_w_per_k;
  const eta = heatLoss.boiler_efficiency_used;

  const daySummaries = buildDaySummaries(heating, external);

  const { occupancy_weights, warning: owWarn } = computeOccupancyWeights(heating, daySummaries);

  const { setpoint_c, setpoint_days_used, warnings: spWarns } =
    estimateSetpoint(heating, external, htc, eta);

  let thermal_mass_kj_per_k = null;
  let events_used = 0;
  let massWarns = [];

  if (setpoint_c !== null) {
    ({ thermal_mass_kj_per_k, events_used, warnings: massWarns } =
      estimateThermalMass(heating, external, htc, eta, setpoint_c));
  }

  const { time_constant_hours, thermal_mass_rating, tcWarns } =
    computeRatingAndTimeConstant(thermal_mass_kj_per_k, htc);

  const { warning: wcWarn } = checkWallConstruction(thermal_mass_kj_per_k, wallConstructionType);

  const validation_status = computeValidationStatus(
    setpoint_c, thermal_mass_kj_per_k, setpoint_days_used, events_used
  );

  return {
    setpoint_c,
    thermal_mass_kj_per_k,
    time_constant_hours,
    thermal_mass_rating,
    occupancy_weights,
    setpoint_days_used,
    thermal_mass_events_used: events_used,
    validation_status,
    warnings: [
      ...spWarns,
      ...massWarns,
      ...tcWarns,
      ...(owWarn ? [owWarn] : []),
      ...(wcWarn ? [wcWarn] : []),
    ],
  };
}
