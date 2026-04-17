// ===== Baseload Separation Module =====
// Gas separation: 48-slot HH profile (Methods A–E), absence detection (Step F),
// validation against degree-days (Step G). Step H added by module-3a-step-h plan.

import { HDD_BASE_TEMP, CDD_BASE_TEMP } from './constants.js'; // CDD_BASE_TEMP imported pre-emptively for the step-h extension.

const { DateTime } = luxon;

// ===== Configuration =====

const BASELOAD_CONFIG = {
  SUMMER_MONTHS: [6, 7, 8],
  METHOD_A_MIN_SUMMER_DAYS: 60,
  METHOD_A_MIN_WEEKDAY_DAYS: 20,
  METHOD_A_MIN_WEEKEND_DAYS: 20,
  METHOD_B_MIN_SUMMER_DAYS: 30,
  METHOD_C_MIN_SUMMER_DAYS: 14,
  ABSENCE_THRESHOLD_FRACTION: 0.20,
  ABSENCE_MIN_CONSECUTIVE_DAYS: 3,
  HIGH_ABSENCE_WARNING_DAYS: 30,
  EXCESSIVE_ABSENCE_DAYS: 300,
  LITERATURE_BASELOAD_KWH_PER_DAY: 8,
  VALIDATION_MIN_HEATING_DAYS: 14,
  R2_GOOD_THRESHOLD: 0.7,
  R2_ACCEPTABLE_THRESHOLD: 0.5,
  BALANCE_POINT_FLATNESS_FRACTION: 0.20,
  BALANCE_POINT_MIN_DAYS_PER_BIN: 3,
};

// ===== Shared state =====

let _baseloadResult = null;
export function setBaseloadResult(result) { _baseloadResult = result; }
export function getBaseloadResult() { return _baseloadResult; }

// ===== Helpers =====

function median(arr) {
  const vals = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

function hhOfDay(timestamp) {
  const dt = DateTime.fromISO(timestamp, { zone: 'utc' });
  return dt.hour * 2 + Math.floor(dt.minute / 30);
}

function isWeekday(timestamp) {
  return DateTime.fromISO(timestamp, { zone: 'utc' }).weekday <= 5; // Luxon: 1=Mon, 7=Sun
}

function groupByDay(records) {
  const map = new Map();
  for (const rec of records) {
    const day = DateTime.fromISO(rec.timestamp, { zone: 'utc' }).toISODate();
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(rec);
  }
  return map;
}

function isWholeDay(dayRecords, field) {
  return dayRecords.length === 48 && dayRecords.every(r => r[field] !== null && r[field] !== undefined);
}

function computeOlsR2(xs, ys) {
  if (xs.length < 2) return null;
  const n = xs.length;
  const xMean = xs.reduce((s, x) => s + x, 0) / n;
  const yMean = ys.reduce((s, y) => s + y, 0) / n;
  const ssXX = xs.reduce((s, x) => s + (x - xMean) ** 2, 0);
  if (ssXX === 0) return null;
  const ssXY = xs.reduce((s, x, i) => s + (x - xMean) * (ys[i] - yMean), 0);
  const slope = ssXY / ssXX;
  const intercept = yMean - slope * xMean;
  const ssTot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
  if (ssTot === 0) return null;
  const ssRes = ys.reduce((s, y, i) => s + (y - (slope * xs[i] + intercept)) ** 2, 0);
  return 1 - ssRes / ssTot;
}

// Builds a Map from day string (yyyy-mm-dd) to array of indices into the consumption/heating arrays.
function buildDayIndexMap(consumption) {
  const map = new Map();
  for (let i = 0; i < consumption.length; i++) {
    const day = DateTime.fromISO(consumption[i].timestamp, { zone: 'utc' }).toISODate();
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(i);
  }
  return map;
}

// ===== Pre-flight =====

export function checkNoGas(consumption) {
  return consumption.every(rec => rec.gas_kwh === null || rec.gas_kwh === 0);
}

// ===== Method A: Summer HH-profile with weekday/weekend split =====

export function methodA(consumption) {
  const summerWholeDays = new Map(); // day → records[]
  for (const [day, records] of groupByDay(consumption)) {
    const month = DateTime.fromISO(day, { zone: 'utc' }).month;
    if (BASELOAD_CONFIG.SUMMER_MONTHS.includes(month) && isWholeDay(records, 'gas_kwh')) {
      summerWholeDays.set(day, records);
    }
  }

  const days = [...summerWholeDays.keys()].sort();
  const summer_days_used = days.length;
  const weekdayDays = days.filter(d => isWeekday(summerWholeDays.get(d)[0].timestamp)).length;
  const weekendDays = summer_days_used - weekdayDays;

  if (
    summer_days_used < BASELOAD_CONFIG.METHOD_A_MIN_SUMMER_DAYS ||
    weekdayDays < BASELOAD_CONFIG.METHOD_A_MIN_WEEKDAY_DAYS ||
    weekendDays < BASELOAD_CONFIG.METHOD_A_MIN_WEEKEND_DAYS
  ) return null;

  const weekdaySlots = Array.from({ length: 48 }, () => []);
  const weekendSlots = Array.from({ length: 48 }, () => []);
  for (const [, records] of summerWholeDays) {
    for (const rec of records) {
      const slot = hhOfDay(rec.timestamp);
      if (isWeekday(rec.timestamp)) weekdaySlots[slot].push(rec.gas_kwh);
      else weekendSlots[slot].push(rec.gas_kwh);
    }
  }
  const weekdayProfile = weekdaySlots.map(vals => median(vals) ?? 0);
  const weekendProfile = weekendSlots.map(vals => median(vals) ?? 0);

  const summer_window = { start: days[0], end: days[days.length - 1] };

  const heatingSlots = consumption.map(rec => {
    if (rec.gas_kwh === null) return null;
    const profile = isWeekday(rec.timestamp) ? weekdayProfile[hhOfDay(rec.timestamp)] : weekendProfile[hhOfDay(rec.timestamp)];
    const baseload_kwh = Math.min(profile, rec.gas_kwh);
    return { heating_kwh: rec.gas_kwh - baseload_kwh, baseload_kwh };
  });

  return { heatingSlots, method: 'summer-hh-profile-weekday-split', summer_window, summer_days_used };
}

// ===== Method B: Summer HH-profile (no weekday/weekend split) =====

export function methodB(consumption) {
  const summerWholeDays = new Map();
  for (const [day, records] of groupByDay(consumption)) {
    const month = DateTime.fromISO(day, { zone: 'utc' }).month;
    if (BASELOAD_CONFIG.SUMMER_MONTHS.includes(month) && isWholeDay(records, 'gas_kwh')) {
      summerWholeDays.set(day, records);
    }
  }

  const days = [...summerWholeDays.keys()].sort();
  const summer_days_used = days.length;
  if (summer_days_used < BASELOAD_CONFIG.METHOD_B_MIN_SUMMER_DAYS) return null;

  const slots = Array.from({ length: 48 }, () => []);
  for (const [, records] of summerWholeDays) {
    for (const rec of records) slots[hhOfDay(rec.timestamp)].push(rec.gas_kwh);
  }
  const profile = slots.map(vals => median(vals) ?? 0);
  const summer_window = { start: days[0], end: days[days.length - 1] };

  const heatingSlots = consumption.map(rec => {
    if (rec.gas_kwh === null) return null;
    const baseload_kwh = Math.min(profile[hhOfDay(rec.timestamp)], rec.gas_kwh);
    return { heating_kwh: rec.gas_kwh - baseload_kwh, baseload_kwh };
  });

  return { heatingSlots, method: 'summer-hh-profile-flat', summer_window, summer_days_used };
}

// ===== Method C: Summer daily flat median =====

export function methodC(consumption, warnings) {
  const summerWholeDays = new Map();
  for (const [day, records] of groupByDay(consumption)) {
    const month = DateTime.fromISO(day, { zone: 'utc' }).month;
    if (BASELOAD_CONFIG.SUMMER_MONTHS.includes(month) && isWholeDay(records, 'gas_kwh')) {
      summerWholeDays.set(day, records);
    }
  }

  const days = [...summerWholeDays.keys()].sort();
  const summer_days_used = days.length;
  if (summer_days_used < BASELOAD_CONFIG.METHOD_C_MIN_SUMMER_DAYS) return null;

  const dailyTotals = days.map(d => summerWholeDays.get(d).reduce((s, r) => s + r.gas_kwh, 0));
  const baseload_per_hh = (median(dailyTotals) ?? 0) / 48;
  const summer_window = { start: days[0], end: days[days.length - 1] };

  warnings.push(`Limited summer data (${summer_days_used} days). Baseload estimated as flat daily average — HH heating pattern may be less distinct.`);

  const heatingSlots = consumption.map(rec => {
    if (rec.gas_kwh === null) return null;
    const baseload_kwh = Math.min(baseload_per_hh, rec.gas_kwh);
    return { heating_kwh: rec.gas_kwh - baseload_kwh, baseload_kwh };
  });

  return { heatingSlots, method: 'summer-daily-flat', summer_window, summer_days_used };
}

// ===== Method D: Balance-point estimation =====

export function methodD(consumption, external, warnings) {
  // Build daily aggregates indexed in parallel with consumption/external
  const dayIndexMap = buildDayIndexMap(consumption);
  const dailyData = [];
  for (const [, indices] of dayIndexMap) {
    if (indices.length !== 48) continue;
    if (indices.some(i => consumption[i].gas_kwh === null)) continue;
    const tempVals = indices.map(i => external?.[i]?.temp_c).filter(v => v !== null && v !== undefined);
    if (tempVals.length < 48) continue;
    dailyData.push({
      daily_gas_kwh: indices.reduce((s, i) => s + consumption[i].gas_kwh, 0),
      daily_mean_temp_c: tempVals.reduce((s, v) => s + v, 0) / 48,
    });
  }

  if (dailyData.length === 0) return null;

  // Bin by 1°C; require minimum days per bin
  const bins = new Map();
  for (const { daily_gas_kwh, daily_mean_temp_c } of dailyData) {
    const bin = Math.floor(daily_mean_temp_c);
    if (!bins.has(bin)) bins.set(bin, []);
    bins.get(bin).push(daily_gas_kwh);
  }

  const qualifyingBins = [...bins.entries()]
    .filter(([, vals]) => vals.length >= BASELOAD_CONFIG.BALANCE_POINT_MIN_DAYS_PER_BIN)
    .map(([bin, vals]) => ({ bin, medianGas: median(vals) }))
    .sort((a, b) => a.bin - b.bin);

  if (qualifyingBins.length === 0) return null;

  const warmestMedian = qualifyingBins[qualifyingBins.length - 1].medianGas;
  const flatThreshold = warmestMedian * (1 + BASELOAD_CONFIG.BALANCE_POINT_FLATNESS_FRACTION);

  // Balance point: lowest-temperature bin where gas use is within the flat threshold
  let balancePoint = null;
  for (const { bin, medianGas } of qualifyingBins) {
    if (medianGas <= flatThreshold) { balancePoint = bin; break; }
  }
  if (balancePoint === null) return null;

  const warmDayGas = dailyData
    .filter(d => d.daily_mean_temp_c >= balancePoint)
    .map(d => d.daily_gas_kwh);
  if (warmDayGas.length === 0) return null;

  const baseload_per_hh = (median(warmDayGas) ?? 0) / 48;
  warnings.push(`Insufficient summer data. Baseload estimated from warm-weather days (>${balancePoint}°C). Heatmap will not show non-heating pattern detail.`);

  const heatingSlots = consumption.map(rec => {
    if (rec.gas_kwh === null) return null;
    const baseload_kwh = Math.min(baseload_per_hh, rec.gas_kwh);
    return { heating_kwh: rec.gas_kwh - baseload_kwh, baseload_kwh };
  });

  return { heatingSlots, method: 'balance-point', summer_window: null, summer_days_used: 0 };
}

// ===== Method E: Literature default =====

export function methodE(consumption, warnings) {
  const baseload_per_hh = BASELOAD_CONFIG.LITERATURE_BASELOAD_KWH_PER_DAY / 48;
  warnings.push(`Not enough data to estimate your household's non-heating gas use. Using UK average (8 kWh/day). Results should be treated as indicative only.`);

  const heatingSlots = consumption.map(rec => {
    if (rec.gas_kwh === null) return null;
    const baseload_kwh = Math.min(baseload_per_hh, rec.gas_kwh);
    return { heating_kwh: rec.gas_kwh - baseload_kwh, baseload_kwh };
  });

  return {
    heatingSlots,
    method: 'literature-default',
    summer_window: null,
    summer_days_used: 0,
    validation_status: 'insufficient_data',
  };
}

// ===== Step F: Absence detection =====

export function detectAbsences(consumption, heating, baseloadMedianKwhPerDay, warnings) {
  const threshold = BASELOAD_CONFIG.ABSENCE_THRESHOLD_FRACTION * baseloadMedianKwhPerDay;
  const byDay = groupByDay(consumption);
  const sortedDays = [...byDay.keys()].sort();

  const lowGasDays = new Set();
  for (const day of sortedDays) {
    const records = byDay.get(day);
    if (!isWholeDay(records, 'gas_kwh')) continue;
    if (records.reduce((s, r) => s + r.gas_kwh, 0) < threshold) lowGasDays.add(day);
  }

  // Find runs of ≥3 calendar-consecutive low-gas whole days
  const absence_periods = [];
  let i = 0;
  while (i < sortedDays.length) {
    if (!lowGasDays.has(sortedDays[i])) { i++; continue; }
    let j = i + 1;
    while (
      j < sortedDays.length &&
      lowGasDays.has(sortedDays[j]) &&
      DateTime.fromISO(sortedDays[j], { zone: 'utc' }).diff(DateTime.fromISO(sortedDays[j - 1], { zone: 'utc' }), 'days').days === 1
    ) j++;
    const runLength = j - i;
    if (runLength >= BASELOAD_CONFIG.ABSENCE_MIN_CONSECUTIVE_DAYS) {
      absence_periods.push({ start: sortedDays[i], end: sortedDays[j - 1], days: runLength });
    }
    i = j;
  }

  const absence_days_total = absence_periods.reduce((s, p) => s + p.days, 0);

  // Build set of all dates within absence periods for O(1) lookup
  const absenceDateSet = new Set();
  for (const { start, end } of absence_periods) {
    let cur = DateTime.fromISO(start, { zone: 'utc' });
    const endDt = DateTime.fromISO(end, { zone: 'utc' });
    while (cur <= endDt) {
      absenceDateSet.add(cur.toISODate());
      cur = cur.plus({ days: 1 });
    }
  }

  for (const slot of heating) {
    slot.is_absence = absenceDateSet.has(DateTime.fromISO(slot.timestamp, { zone: 'utc' }).toISODate());
  }

  if (absence_days_total > BASELOAD_CONFIG.HIGH_ABSENCE_WARNING_DAYS) {
    warnings.push(`Detected ${absence_days_total} days when your boiler appears to have been off (likely holidays). These are excluded from the heat loss calculation. Note: extended periods where heating was left on a low setting (e.g. frost-protection / de-icing mode) are NOT detected — if you know you did this, treat your HTC estimate as a lower bound.`);
  }
  if (absence_days_total > BASELOAD_CONFIG.EXCESSIVE_ABSENCE_DAYS) {
    warnings.push(`Most of your data shows very low gas use — results not meaningful.`);
  }

  return { absence_periods, absence_days_total };
}

// ===== Step G: Validation (degree-day regression) =====

export function validateSeparation(heating, external, warnings) {
  const byDay = new Map();
  for (let i = 0; i < heating.length; i++) {
    if (heating[i].heating_kwh === null) continue;
    const day = DateTime.fromISO(heating[i].timestamp, { zone: 'utc' }).toISODate();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(i);
  }

  const degDays = [];
  const heatKwh = [];

  for (const [, indices] of byDay) {
    if (indices.length !== 48) continue; // whole-gas day (L16)
    if (indices.some(i => heating[i].is_absence)) continue;
    const tempVals = indices.map(i => external?.[i]?.temp_c).filter(v => v !== null && v !== undefined);
    if (tempVals.length < 48) continue;
    const daily_mean_temp_c = tempVals.reduce((s, v) => s + v, 0) / 48;
    const degree_days = Math.max(0, HDD_BASE_TEMP - daily_mean_temp_c);
    if (degree_days === 0) continue;
    degDays.push(degree_days);
    heatKwh.push(indices.reduce((s, i) => s + heating[i].heating_kwh, 0));
  }

  if (degDays.length < BASELOAD_CONFIG.VALIDATION_MIN_HEATING_DAYS) {
    return { r2: null, validation_status: 'insufficient_data' };
  }

  const r2 = computeOlsR2(degDays, heatKwh);
  let validation_status;
  if (r2 === null || r2 < BASELOAD_CONFIG.R2_ACCEPTABLE_THRESHOLD) {
    validation_status = 'poor';
  } else if (r2 < BASELOAD_CONFIG.R2_GOOD_THRESHOLD) {
    validation_status = 'acceptable';
  } else {
    validation_status = 'good';
  }

  if (validation_status === 'poor') {
    warnings.push(`Your heating demand doesn't correlate strongly with outdoor temperature (R² = ${r2 !== null ? r2.toFixed(2) : 'n/a'}). This can happen if you use a wood burner, have variable occupancy, or have very good solar gains. Results may be less accurate.`);
  }

  return { r2, validation_status };
}

// ===== Main orchestrator (gas-separation stub — extended by step-h plan) =====

export function separateBaseload(consumption, external) {
  const warnings = [];

  const heating = consumption.map(rec => ({
    timestamp: rec.timestamp,
    heating_kwh: rec.gas_kwh === null ? null : 0,
    baseload_kwh: rec.gas_kwh === null ? null : 0,
    is_absence: false,
  }));

  // No-gas case
  if (checkNoGas(consumption)) {
    warnings.push(`No gas consumption detected. This household appears to be all-electric. The heat pump comparison will be against existing electric heating rather than gas.`);
    const baseload_metadata = {
      method: 'no-gas',
      summer_window: null,
      summer_days_used: 0,
      baseload_mean_kwh_per_day: 0,
      baseload_median_kwh_per_day: 0,
      absence_periods: [],
      absence_days_total: 0,
      heating_vs_degree_days_r2: null,
      validation_status: 'no_gas',
      warnings,
    };
    // step-h plan extends here before return
    return { heating, baseload_metadata };
  }

  // Method cascade: A → B → C → D → E
  let methodResult = methodA(consumption);
  if (!methodResult) methodResult = methodB(consumption);
  if (!methodResult) methodResult = methodC(consumption, warnings);
  if (!methodResult) methodResult = methodD(consumption, external, warnings);
  if (!methodResult) methodResult = methodE(consumption, warnings);

  methodResult.heatingSlots.forEach((slot, i) => {
    if (slot !== null) {
      heating[i].heating_kwh = slot.heating_kwh;
      heating[i].baseload_kwh = slot.baseload_kwh;
    }
  });

  // 4c: Compute baseload mean/median from full-dataset whole-gas days
  const dayIndexMap = buildDayIndexMap(consumption);
  const dailyBaseloadTotals = [];
  for (const [, indices] of dayIndexMap) {
    if (indices.length !== 48) continue;
    if (indices.some(i => consumption[i].gas_kwh === null)) continue;
    dailyBaseloadTotals.push(indices.reduce((s, i) => s + (heating[i].baseload_kwh ?? 0), 0));
  }
  const baseload_mean_kwh_per_day = dailyBaseloadTotals.length > 0
    ? dailyBaseloadTotals.reduce((s, v) => s + v, 0) / dailyBaseloadTotals.length
    : 0;
  const baseload_median_kwh_per_day = median(dailyBaseloadTotals) ?? 0;

  // 4b: Absence detection (depends on baseload_median_kwh_per_day from 4c above)
  const { absence_periods, absence_days_total } = detectAbsences(
    consumption, heating, baseload_median_kwh_per_day, warnings
  );

  // Method E sets insufficient_data; excessive absences also force it
  let forced_status = methodResult.validation_status ?? null;
  if (absence_days_total > BASELOAD_CONFIG.EXCESSIVE_ABSENCE_DAYS) forced_status = 'insufficient_data';

  // 4d: Validate separation against degree-days
  const { r2, validation_status: step_g_status } = validateSeparation(heating, external, warnings);
  const validation_status = forced_status === 'insufficient_data' ? 'insufficient_data' : step_g_status;

  const baseload_metadata = {
    method: methodResult.method,
    summer_window: methodResult.summer_window ?? null,
    summer_days_used: methodResult.summer_days_used ?? 0,
    baseload_mean_kwh_per_day,
    baseload_median_kwh_per_day,
    absence_periods,
    absence_days_total,
    heating_vs_degree_days_r2: r2,
    validation_status,
    warnings,
  };

  // step-h plan extends this to: return { heating, baseload_metadata, supplementary_loads }
  return { heating, baseload_metadata };
}
