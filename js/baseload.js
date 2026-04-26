// ===== Baseload Separation Module =====
// Gas separation: 48-slot HH profile (Methods A–E), absence detection (Step F),
// validation against degree-days (Step G). Step H added by module-3a-step-h plan.

import { HDD_BASE_TEMP, CDD_BASE_TEMP } from './constants.js';

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
  HIGH_ABSENCE_WARNING_DAYS: 30,
  EXCESSIVE_ABSENCE_DAYS: 300,
  LITERATURE_BASELOAD_KWH_PER_DAY: 8,
  VALIDATION_MIN_HEATING_DAYS: 14,
  R2_GOOD_THRESHOLD: 0.7,
  R2_ACCEPTABLE_THRESHOLD: 0.5,
  BALANCE_POINT_FLATNESS_FRACTION: 0.20,
  BALANCE_POINT_MIN_DAYS_PER_BIN: 3,
};

// ===== Step H configuration =====

const STEP_H_CONFIG = {
  MIN_DAYS: 30,
  ELECTRIC_HEATING_COEFF_THRESHOLD: 0.2,  // kWh/K·day
  AC_COEFF_THRESHOLD: 0.2,                 // kWh/K·day
  P_VALUE_DETECT: 0.05,
  P_VALUE_HIGH: 0.01,
  COEFF_HIGH: 0.5,
  COEFF_LOW: 0.1,
  P_VALUE_LOW_UPPER: 0.20,
  MIN_SUM_CDD_FOR_AC: 20,                  // K·day
};

const STEP_H_LIMITATIONS = [
  'Solar PV generation is not modelled. If your electricity consumption excludes generation (net metering) or exported energy, the fitted baseline may be distorted. Slope coefficients (HDD, CDD) are less affected because they measure gradient, not level.',
  "If you already have a heat pump or electric immersion tied to heating, it will show here as 'electric heating'. The tool cannot distinguish an existing heat pump from supplementary resistance heating.",
  'Electric water heating (e.g. immersion on a timer) is typically weather-independent and appears in the baseline rather than as heating. Usually acceptable but may inflate the baseline estimate.',
  'Electricity use that correlates with temperature may reflect occupancy patterns — households tend to spend more time at home in very cold or very hot weather, increasing electricity use from always-on appliances and lighting. This is indistinguishable from heating or cooling equipment in aggregate daily data.',
];

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

// ===== Step H math: exact t-distribution p-value via incomplete beta =====

function lgamma(z) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 0.001208650973866179, -0.000005395239384953];
  let y = z;
  let tmp = z + 5.5;
  tmp -= (z + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += c[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / z);
}

function betaCF(x, a, b) {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1.0;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return h;
}

function incompleteBeta(x, a, b) {
  if (x === 0) return 0;
  if (x === 1) return 1;
  const logBetaNorm = lgamma(a) + lgamma(b) - lgamma(a + b);
  if (x < (a + 1) / (a + b + 2)) {
    return Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBetaNorm) * betaCF(x, a, b) / a;
  }
  return 1 - Math.exp(b * Math.log(1 - x) + a * Math.log(x) - logBetaNorm) * betaCF(1 - x, b, a) / b;
}

function tDistPValue(t, df) {
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

// ===== Step H math: multi-variable OLS via Gauss-Jordan with partial pivoting =====

function computeMultiOls(ys, xMatrix) {
  const n = ys.length;
  const p = xMatrix[0].length;
  if (n < p + 1) return null;

  // Build XtX (p×p) and Xty (p-vector)
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      Xty[j] += xMatrix[i][j] * ys[i];
      for (let k = 0; k < p; k++) XtX[j][k] += xMatrix[i][j] * xMatrix[i][k];
    }
  }

  // Augment [XtX | I] for Gauss-Jordan inversion
  const aug = XtX.map((row, i) => {
    const id = new Array(p).fill(0);
    id[i] = 1;
    return [...row, ...id];
  });

  for (let col = 0; col < p; col++) {
    let maxVal = Math.abs(aug[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < p; row++) {
      if (Math.abs(aug[row][col]) > maxVal) { maxVal = Math.abs(aug[row][col]); maxRow = row; }
    }
    const rowMax = aug[maxRow].slice(0, p).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (rowMax === 0 || maxVal / rowMax < 1e-10) return null;
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    for (let k = 0; k < 2 * p; k++) aug[col][k] /= pivot;
    for (let row = 0; row < p; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let k = 0; k < 2 * p; k++) aug[row][k] -= factor * aug[col][k];
    }
  }

  const invXtX = aug.map(row => row.slice(p));
  const coefficients = invXtX.map(row => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const yhat = xMatrix.map(row => row.reduce((s, v, j) => s + v * coefficients[j], 0));
  const rss = ys.reduce((s, y, i) => s + (y - yhat[i]) ** 2, 0);
  const residualVariance = rss / (n - p);
  const standardErrors = invXtX.map((row, j) => Math.sqrt(residualVariance * row[j]));
  const tStatistics = coefficients.map((b, j) => b / standardErrors[j]);
  const pValues = tStatistics.map(t => tDistPValue(Math.abs(t), n - p));

  return { coefficients, standardErrors, tStatistics, pValues, residualVariance };
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

  // Group calendar-consecutive low-gas whole days into periods; no minimum run — isWholeDay is the misread guard
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
    absence_periods.push({ start: sortedDays[i], end: sortedDays[j - 1], days: j - i });
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

// ===== Step H: Supplementary electric load detection =====

export function detectSupplementaryLoads(consumption, external, heating, baseloadMethod) {
  const noGasCase = baseloadMethod === 'no-gas';

  function skipped(method, days_used_in_fit) {
    return {
      method, days_used_in_fit,
      baseline_kwh_per_day: null,
      hdd_coefficient_kwh_per_dd: null, cdd_coefficient_kwh_per_dd: null,
      hdd_p_value: null, cdd_p_value: null,
      sum_hdd_k_day: null, sum_cdd_k_day: null,
      electric_heating_detected: false, electric_heating_kwh_per_dd: null,
      electric_heating_kwh_estimate: null, electric_heating_confidence: 'none',
      electric_heating_is_primary: false,
      air_conditioning_detected: false, air_conditioning_kwh_per_dd: null,
      air_conditioning_kwh_estimate: null, air_conditioning_confidence: 'none',
      ac_detection_note: null,
      warnings: [], limitations: STEP_H_LIMITATIONS,
    };
  }

  // H0 — No electricity data at all
  if (consumption.every(rec => rec.elec_kwh === null || rec.elec_kwh === undefined)) {
    return skipped('skipped_no_electricity', 0);
  }

  // H0 — Build daily regression dataset
  const dayIndexMap = buildDayIndexMap(consumption);
  const dailyData = [];

  for (const [, indices] of dayIndexMap) {
    if (indices.length !== 48) continue;
    if (indices.some(i => consumption[i].elec_kwh === null || consumption[i].elec_kwh === undefined)) continue;
    if (indices.some(i => heating[i].is_absence)) continue;
    const tempVals = indices.map(i => external?.[i]?.temp_c);
    if (tempVals.some(v => v === null || v === undefined)) continue;
    // M1: in normal (non-no-gas) case, also require all 48 gas HH periods non-null
    if (!noGasCase && indices.some(i => consumption[i].gas_kwh === null || consumption[i].gas_kwh === undefined)) continue;

    const daily_mean_temp_c = tempVals.reduce((s, v) => s + v, 0) / 48;
    dailyData.push({
      daily_elec_kwh: indices.reduce((s, i) => s + consumption[i].elec_kwh, 0),
      daily_hdd: Math.max(0, HDD_BASE_TEMP - daily_mean_temp_c),
      daily_cdd: Math.max(0, daily_mean_temp_c - CDD_BASE_TEMP),
    });
  }

  if (dailyData.length < STEP_H_CONFIG.MIN_DAYS) {
    return skipped('skipped_insufficient_data', dailyData.length);
  }

  // H1 — OLS regression: design matrix [HDD, CDD, 1]
  const ys = dailyData.map(d => d.daily_elec_kwh);
  const xMatrix = dailyData.map(d => [d.daily_hdd, d.daily_cdd, 1]);
  const olsResult = computeMultiOls(ys, xMatrix);
  if (!olsResult) return skipped('skipped_insufficient_data', dailyData.length);

  const a = olsResult.coefficients[0]; // HDD slope
  const b = olsResult.coefficients[1]; // CDD slope
  const c = olsResult.coefficients[2]; // intercept — baseline
  const p_a = olsResult.pValues[0];
  const p_b = olsResult.pValues[1];
  const sum_hdd = dailyData.reduce((s, d) => s + d.daily_hdd, 0);
  const sum_cdd = dailyData.reduce((s, d) => s + d.daily_cdd, 0);

  // H2 — Electric heating detection
  const electric_heating_detected = a > STEP_H_CONFIG.ELECTRIC_HEATING_COEFF_THRESHOLD && p_a < STEP_H_CONFIG.P_VALUE_DETECT;
  let electric_heating_confidence;
  if (electric_heating_detected) {
    electric_heating_confidence = (a >= STEP_H_CONFIG.COEFF_HIGH && p_a < STEP_H_CONFIG.P_VALUE_HIGH) ? 'high' : 'moderate';
  } else {
    electric_heating_confidence = (a > STEP_H_CONFIG.COEFF_LOW && p_a >= STEP_H_CONFIG.P_VALUE_DETECT && p_a < STEP_H_CONFIG.P_VALUE_LOW_UPPER) ? 'low' : 'none';
  }

  // H3 — AC detection
  let air_conditioning_detected = false;
  let air_conditioning_confidence = 'none';
  let air_conditioning_kwh_per_dd = null;
  let air_conditioning_kwh_estimate = null;
  let ac_detection_note = null;

  if (sum_cdd < STEP_H_CONFIG.MIN_SUM_CDD_FOR_AC) {
    ac_detection_note = 'insufficient_cdd_data';
  } else {
    air_conditioning_detected = b > STEP_H_CONFIG.AC_COEFF_THRESHOLD && p_b < STEP_H_CONFIG.P_VALUE_DETECT;
    if (air_conditioning_detected) {
      air_conditioning_kwh_per_dd = b;
      air_conditioning_kwh_estimate = b * sum_cdd;
      air_conditioning_confidence = (b >= STEP_H_CONFIG.COEFF_HIGH && p_b < STEP_H_CONFIG.P_VALUE_HIGH) ? 'high' : 'moderate';
    } else {
      air_conditioning_confidence = (b > STEP_H_CONFIG.COEFF_LOW && p_b >= STEP_H_CONFIG.P_VALUE_DETECT && p_b < STEP_H_CONFIG.P_VALUE_LOW_UPPER) ? 'low' : 'none';
    }
  }

  // H4 — No-gas framing
  const electric_heating_is_primary = noGasCase && electric_heating_detected;

  return {
    method: 'regression',
    days_used_in_fit: dailyData.length,
    baseline_kwh_per_day: c,
    hdd_coefficient_kwh_per_dd: a,
    cdd_coefficient_kwh_per_dd: b,
    hdd_p_value: p_a,
    cdd_p_value: p_b,
    sum_hdd_k_day: sum_hdd,
    sum_cdd_k_day: sum_cdd,
    electric_heating_detected,
    electric_heating_kwh_per_dd: electric_heating_detected ? a : null,
    electric_heating_kwh_estimate: electric_heating_detected ? a * sum_hdd : null,
    electric_heating_confidence,
    electric_heating_is_primary,
    air_conditioning_detected,
    air_conditioning_kwh_per_dd,
    air_conditioning_kwh_estimate,
    air_conditioning_confidence,
    ac_detection_note,
    warnings: [],
    limitations: STEP_H_LIMITATIONS,
  };
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
    const supplementary_loads = detectSupplementaryLoads(consumption, external, heating, baseload_metadata.method);
    return { heating, baseload_metadata, supplementary_loads };
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

  const supplementary_loads = detectSupplementaryLoads(consumption, external, heating, baseload_metadata.method);
  return { heating, baseload_metadata, supplementary_loads };
}
