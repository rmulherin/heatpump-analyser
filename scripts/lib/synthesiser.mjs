import fs from 'node:fs';
import path from 'node:path';
import { HDD_BASE_TEMP } from '../../js/constants.js';

// --- Step 11 constants ---
const ELEC_NIGHT_FACTOR          = 0.6;
const ELEC_EVENING_FACTOR        = 1.3;
const ELEC_LIGHTING_FRACTION     = 0.35;
const SOLAR_LIGHTING_THRESHOLD_WM2 = 50;

// --- Step 10 constants (HW/cooking pulse timing) ---
const HW_MORNING_PEAK_MINS  = 7  * 60;
const HW_MORNING_SD_MINS    = 0.6 * 60;
const HW_EVENING_PEAK_MINS  = 18 * 60;
const HW_EVENING_SD_MINS    = 1.1 * 60;
const HW_MORNING_FRACTION   = 0.35;

// ─────────────────────────────────────────────
// Step 4 — PRNG and config reading
// ─────────────────────────────────────────────

export function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(prng) {
  let u1 = prng();
  while (u1 === 0) u1 = prng();
  const u2 = prng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function readConfigs(archetypeConfigPath, noiseConfigPath) {
  const archetype = JSON.parse(fs.readFileSync(archetypeConfigPath, 'utf8'));
  const noiseRaw  = JSON.parse(fs.readFileSync(noiseConfigPath, 'utf8'));

  const requiredArchetype = [
    'slug', 'label',
    'building.htc_w_per_k', 'building.thermal_mass_kj_per_k',
    'building.boiler_efficiency', 'building.solar_aperture_m2', 'building.setpoint_c',
    'schedule.kind',
    'baseload.gas_hot_water_kwh_per_day', 'baseload.gas_cooking_kwh_per_day',
    'baseload.elec_baseload_kwh_per_day', 'baseload.elec_appliance_events_per_week',
    'location.postcode',
    'time_window.start', 'time_window.end',
    'prng_seed',
    'annual_gas_target_kwh', 'annual_elec_target_kwh',
  ];
  for (const field of requiredArchetype) {
    const val = field.split('.').reduce((o, k) => (o != null ? o[k] : undefined), archetype);
    if (val === undefined || val === null) throw new Error(`Missing required field: ${field}`);
  }

  const requiredNoise = [
    'measurement_noise.smart_meter_relative_sd',
    'behavioural_noise.hh_residual_autocorr_lag1',
    'behavioural_noise.daily_residual_cv',
    'schedule_jitter.boiler_start_sd_minutes',
    'holiday_weeks.events_per_year',
    'holiday_weeks.mean_duration_days',
  ];
  for (const field of requiredNoise) {
    const val = field.split('.').reduce((o, k) => (o != null ? o[k] : undefined), noiseRaw);
    if (val === undefined || val === null) throw new Error(`Missing required noise field: ${field}`);
  }

  // Deep-clone noise and merge archetype overrides
  const noise = JSON.parse(JSON.stringify(noiseRaw));
  if (archetype.noise_overrides) {
    for (const [k, v] of Object.entries(archetype.noise_overrides)) {
      if (k === 'hh_residual_autocorr_lag1') {
        noise.behavioural_noise.hh_residual_autocorr_lag1 = v;
      } else {
        noise[k] = v;
      }
    }
  }

  return { archetype, noise };
}

// ─────────────────────────────────────────────
// Step 5 — Weather fetching with caching
// ─────────────────────────────────────────────

async function resolvePostcode(postcode) {
  const stripped = postcode.replace(/\s+/g, '');
  const url = `https://api.postcodes.io/postcodes/${encodeURIComponent(stripped)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Postcode ${postcode} not found (${resp.status}). Check the archetype config.`);
  const data = await resp.json();
  return { lat: data.result.latitude, lon: data.result.longitude };
}

export async function fetchWeatherCached(postcode, timeWindow, cacheDir, verbose = false) {
  const startDate = timeWindow.start;
  const endDate   = timeWindow.end;
  const key       = postcode.replace(/\s+/g, '').toLowerCase() + '-' + startDate + '-' + endDate + '.json';
  const cachePath = path.join(cacheDir, key);

  if (fs.existsSync(cachePath)) {
    if (verbose) console.log(`  Weather cache hit: ${key}`);
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }

  if (verbose) console.log(`  Fetching weather for ${postcode} (${startDate}→${endDate})…`);
  const { lat, lon } = await resolvePostcode(postcode);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&hourly=temperature_2m,shortwave_radiation&timezone=UTC`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Open-Meteo fetch failed (${resp.status})`);
  const data = await resp.json();

  const times  = data.hourly.time;
  const temps  = data.hourly.temperature_2m;
  const solar  = data.hourly.shortwave_radiation;

  // Forward-fill nulls (≤2 consecutive; abort if larger gap)
  let nullRun = 0;
  for (let i = 0; i < temps.length; i++) {
    if (temps[i] === null || solar[i] === null) {
      nullRun++;
      if (nullRun > 2) throw new Error(`Weather data gap > 2 hours at index ${i} (${times[i]})`);
      if (i > 0) {
        if (temps[i]  === null) temps[i]  = temps[i - 1];
        if (solar[i]  === null) solar[i]  = solar[i - 1];
      }
    } else {
      nullRun = 0;
    }
  }

  // Convert hourly → half-hourly
  const result = [];
  for (let h = 0; h < times.length; h++) {
    const base = times[h]; // 'YYYY-MM-DDTHH:00'
    const datePart = base.slice(0, 10);
    const hourPart = base.slice(11, 13);
    result.push({ timestamp: `${datePart} ${hourPart}:00`, temp_c: temps[h], solar_w_m2: solar[h] });
    result.push({ timestamp: `${datePart} ${hourPart}:30`, temp_c: temps[h], solar_w_m2: solar[h] });
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(result));
  if (verbose) console.log(`  Weather cached: ${cachePath}`);
  return result;
}

// ─────────────────────────────────────────────
// Step 6 — HH timestamp array
// ─────────────────────────────────────────────

function formatTs(ms) {
  const d   = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function generateTimestamps(timeWindow) {
  const [sy, sm, sd] = timeWindow.start.split('-').map(Number);
  const [ey, em, ed] = timeWindow.end.split('-').map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd, 0, 0, 0);
  const endMs   = Date.UTC(ey, em - 1, ed, 23, 30, 0);
  const step    = 30 * 60 * 1000;
  const timestamps  = [];
  const timestampMs = [];
  for (let ms = startMs; ms <= endMs; ms += step) {
    timestamps.push(formatTs(ms));
    timestampMs.push(ms);
  }
  return { timestamps, timestampMs };
}

// ─────────────────────────────────────────────
// Step 7 — Schedule generation
// ─────────────────────────────────────────────

export function generateSchedule(scheduleConfig, timestampMs, noiseConfig, prng) {
  const heatingOn = new Uint8Array(timestampMs.length);
  const jitterSd  = noiseConfig.schedule_jitter.boiler_start_sd_minutes;

  // Group by UTC date
  const byDay = new Map();
  for (let i = 0; i < timestampMs.length; i++) {
    const d     = new Date(timestampMs[i]);
    const dateKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (!byDay.has(dateKey)) byDay.set(dateKey, []);
    byDay.get(dateKey).push(i);
  }

  for (const [, indices] of byDay) {
    const dow = new Date(timestampMs[indices[0]]).getUTCDay();
    const isWeekend = (dow === 0 || dow === 6);
    const windows   = isWeekend
      ? scheduleConfig.weekend_windows
      : scheduleConfig.weekday_windows;

    for (const win of windows) {
      // Draw jitter once per window per day; clip to ±2 SD
      let j = boxMuller(prng) * jitterSd;
      j = Math.max(-2 * jitterSd, Math.min(2 * jitterSd, j));
      const start = win.start_mins + j;
      const end   = win.end_mins   + j;

      for (const idx of indices) {
        const minsSinceMidnight = (new Date(timestampMs[idx]).getUTCHours() * 60)
          + new Date(timestampMs[idx]).getUTCMinutes();
        if (minsSinceMidnight >= start && minsSinceMidnight < end) {
          heatingOn[idx] = 1;
        }
      }
    }
  }

  return heatingOn;
}

// ─────────────────────────────────────────────
// Step 8 — Holiday week injection
// ─────────────────────────────────────────────

export function generateHolidayWeeks(timestampMs, noiseConfig, prng) {
  const isAbsence = new Uint8Array(timestampMs.length);
  const nEvents   = Math.round(noiseConfig.holiday_weeks.events_per_year);
  const durDays   = noiseConfig.holiday_weeks.mean_duration_days;

  // Build a list of day-start indices (index of HH 00:00 for each day)
  const dayStarts = [];
  for (let i = 0; i < timestampMs.length; i++) {
    const d = new Date(timestampMs[i]);
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) dayStarts.push(i);
  }
  const totalDays = dayStarts.length;
  if (totalDays < 15) return { isAbsence, injectedEvents: 0 };

  // Pick non-overlapping absence windows; candidate start restricted to days 14–330
  const selected = [];
  for (let e = 0; e < nEvents; e++) {
    let placed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      // Sample a start day in [14, 330)
      const startDay = 14 + Math.floor(prng() * (Math.min(330, totalDays - 14) - 14));
      const dur      = Math.max(1, Math.round(durDays));
      const endDay   = startDay + dur - 1;
      // Check no overlap
      const overlap  = selected.some(([s, e2]) => startDay <= e2 && endDay >= s);
      if (!overlap) {
        selected.push([startDay, endDay]);
        placed = true;
        break;
      }
    }
    // If placement fails after 100 attempts, silently skip (bake report will note fewer events)
  }

  for (const [startDay, endDay] of selected) {
    for (let d = startDay; d <= endDay && d < dayStarts.length; d++) {
      const base = dayStarts[d];
      for (let hh = 0; hh < 48 && base + hh < timestampMs.length; hh++) {
        isAbsence[base + hh] = 1;
      }
    }
  }

  return { isAbsence, injectedEvents: selected.length };
}

// ─────────────────────────────────────────────
// Step 9 — Forward model
// ─────────────────────────────────────────────

export function computeForwardModel(archetypeConfig, timestampMs, weather, heatingOn, isAbsence) {
  const n          = timestampMs.length;
  const gasHeating = new Float64Array(n);
  const heatDemand = new Float64Array(n);
  const htc        = archetypeConfig.building.htc_w_per_k;
  const setpoint   = archetypeConfig.building.setpoint_c;
  const aperture   = archetypeConfig.building.solar_aperture_m2;
  const efficiency = archetypeConfig.building.boiler_efficiency;

  for (let i = 0; i < n; i++) {
    if (isAbsence[i] || !heatingOn[i]) continue;
    const dT        = Math.max(0, setpoint - weather[i].temp_c);
    const heatLoss  = htc * dT * 0.5 * 0.001;
    const solarGain = aperture * weather[i].solar_w_m2 * 0.5 * 0.001;
    heatDemand[i]   = Math.max(0, heatLoss - solarGain);
    gasHeating[i]   = heatDemand[i] / efficiency;
  }

  return { gasHeating, heatDemand };
}

// ─────────────────────────────────────────────
// Step 10 — HW and cooking gas baseload
// ─────────────────────────────────────────────

function gaussianPulse(nHH, centreMins, sdMins, totalKwhPerDay) {
  const weights = new Float64Array(nHH);
  let sum = 0;
  for (let hh = 0; hh < nHH; hh++) {
    const midMins = hh * 30 + 15;
    const diff    = midMins - centreMins;
    weights[hh]   = Math.exp(-(diff * diff) / (2 * sdMins * sdMins));
    sum += weights[hh];
  }
  const result = new Float64Array(nHH);
  if (sum === 0) return result;
  for (let hh = 0; hh < nHH; hh++) result[hh] = (weights[hh] / sum) * totalKwhPerDay;
  return result;
}

export function computeHWandCooking(archetypeConfig, timestampMs, noiseConfig, prng) {
  const output = new Float64Array(timestampMs.length);
  const hwKwh  = archetypeConfig.baseload.gas_hot_water_kwh_per_day;
  const cookKwh = archetypeConfig.baseload.gas_cooking_kwh_per_day;
  const cv     = noiseConfig.behavioural_noise.daily_residual_cv;

  // Group by day
  const byDay = [];
  let currentDay = null;
  for (let i = 0; i < timestampMs.length; i++) {
    const d = new Date(timestampMs[i]);
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
      currentDay = [];
      byDay.push(currentDay);
    }
    if (currentDay) currentDay.push(i);
  }

  for (const dayIndices of byDay) {
    const n = dayIndices.length;
    let dailyFactor = 1 + boxMuller(prng) * cv;
    dailyFactor = Math.max(0.1, Math.min(3.0, dailyFactor));
    const totalDay = (hwKwh + cookKwh) * dailyFactor;

    // Morning centre jitter
    let morningCentre = HW_MORNING_PEAK_MINS + boxMuller(prng) * HW_MORNING_SD_MINS;
    morningCentre = Math.max(0, Math.min(1439, morningCentre));
    let eveningCentre = HW_EVENING_PEAK_MINS + boxMuller(prng) * HW_EVENING_SD_MINS;
    eveningCentre = Math.max(0, Math.min(1439, eveningCentre));

    const morningKwh = totalDay * HW_MORNING_FRACTION;
    const eveningKwh = totalDay * (1 - HW_MORNING_FRACTION);

    const morningPulse = gaussianPulse(n, morningCentre, HW_MORNING_SD_MINS, morningKwh);
    const eveningPulse = gaussianPulse(n, eveningCentre, HW_EVENING_SD_MINS, eveningKwh);

    for (let j = 0; j < n; j++) {
      output[dayIndices[j]] = morningPulse[j] + eveningPulse[j];
    }
  }

  return output;
}

// ─────────────────────────────────────────────
// Step 11 — Electricity baseload
// ─────────────────────────────────────────────

export function computeElecBaseload(archetypeConfig, timestamps, timestampMs, weather, noiseConfig, prng) {
  const n      = timestampMs.length;
  const output = new Float64Array(n);
  const baseDayKwh  = archetypeConfig.baseload.elec_baseload_kwh_per_day;
  const eventsPerWeek = archetypeConfig.baseload.elec_appliance_events_per_week;
  const wwRatio = archetypeConfig.noise_overrides?.weekday_weekend_elec_ratio
    ?? noiseConfig.weekday_weekend_elec_ratio_calibration_household?.ratio
    ?? 1.0;
  // R = weekday_mean / weekend_mean; factors preserve annual mean (5R+2 denominator)
  const weekdayFactor = (7 * wwRatio) / (5 * wwRatio + 2);
  const weekendFactor = 7             / (5 * wwRatio + 2);

  const lightingKwhPerHh = (baseDayKwh * ELEC_LIGHTING_FRACTION) / 48;
  const otherKwhPerHh    = (baseDayKwh * (1 - ELEC_LIGHTING_FRACTION)) / 48;

  for (let i = 0; i < n; i++) {
    const solarFactor = 1 - Math.min(1, (weather[i]?.solar_w_m2 ?? 0) / SOLAR_LIGHTING_THRESHOLD_WM2);
    const lighting    = lightingKwhPerHh * solarFactor;

    const hour    = new Date(timestampMs[i]).getUTCHours();
    const occFactor = (hour >= 2 && hour < 8)  ? ELEC_NIGHT_FACTOR
                    : (hour >= 18 && hour < 22) ? ELEC_EVENING_FACTOR
                    : 1.0;
    const other = otherKwhPerHh * occFactor;

    output[i] = lighting + other;

    // Weekday/weekend scaling: R = weekday/weekend, preserves annual mean
    const dow = new Date(timestampMs[i]).getUTCDay();
    output[i] *= (dow === 0 || dow === 6) ? weekendFactor : weekdayFactor;
  }

  // Renormalise pre-event baseload to match nominal annual mean (kWh/day × days).
  // Hour-of-day and solar shaping are distribution shapes, not scaling parameters.
  const daysInWindow = n / 48;
  const targetTotal  = baseDayKwh * daysInWindow;
  let actualTotal    = 0;
  for (let i = 0; i < n; i++) actualTotal += output[i];
  if (actualTotal > 0) {
    const k = targetTotal / actualTotal;
    for (let i = 0; i < n; i++) output[i] *= k;
  }

  // Discrete appliance events: per week, sample eventsPerWeek start-HH indices
  const hhPerWeek = 48 * 7;
  const totalWeeks = Math.ceil(n / hhPerWeek);
  for (let w = 0; w < totalWeeks; w++) {
    const weekStart = w * hhPerWeek;
    const weekEnd   = Math.min(weekStart + hhPerWeek, n);
    const weekLen   = weekEnd - weekStart;
    for (let e = 0; e < eventsPerWeek; e++) {
      const startIdx = weekStart + Math.floor(prng() * weekLen);
      const kwh      = 0.5 + prng() * 1.5;
      const dur      = 1 + Math.round(prng());
      for (let d = 0; d < dur; d++) {
        const idx = startIdx + d;
        if (idx < n) output[idx] += kwh / dur;
      }
    }
  }

  return output;
}

// ─────────────────────────────────────────────
// Step 12 — Noise injection
// ─────────────────────────────────────────────

export function injectNoise(gasArr, elecArr, noiseConfig, archetypeConfig, prng) {
  const phi = archetypeConfig.noise_overrides?.hh_residual_autocorr_lag1
    ?? noiseConfig.behavioural_noise.hh_residual_autocorr_lag1;
  const cv  = noiseConfig.behavioural_noise.daily_residual_cv;
  const sd  = noiseConfig.measurement_noise.smart_meter_relative_sd;
  const n   = gasArr.length;

  // Pass 1: measurement noise (multiplicative, HH-independent)
  for (let i = 0; i < n; i++) {
    gasArr[i]  *= (1 + boxMuller(prng) * sd);
    elecArr[i] *= (1 + boxMuller(prng) * sd);
  }

  // Pass 2: AR(1) behavioural residual scaled per-HH against local signal magnitude.
  // Below-floor HHs reset AR(1) state and don't receive residual. Floor at 10 Wh
  // distinguishes "active pulse / heating window" from Gaussian pulse deep tails
  // (which are mathematically positive but operationally zero).
  const SIGNAL_FLOOR_KWH = 0.01;
  const ar1Factor = Math.sqrt(2 * (1 - phi * phi) / (48 * Math.pow(1 - phi, 2)));
  let rGas = 0, rElec = 0;
  for (let i = 0; i < n; i++) {
    if (gasArr[i] > SIGNAL_FLOOR_KWH) {
      const sigmaGasLocal = gasArr[i] * cv * ar1Factor;
      rGas = phi * rGas + sigmaGasLocal * boxMuller(prng);
      gasArr[i] += rGas;
    } else {
      rGas = 0; // reset state during quiet periods
    }
    if (elecArr[i] > SIGNAL_FLOOR_KWH) {
      const sigmaElecLocal = elecArr[i] * cv * ar1Factor;
      rElec = phi * rElec + sigmaElecLocal * boxMuller(prng);
      elecArr[i] += rElec;
    } else {
      rElec = 0;
    }
  }
}

// ─────────────────────────────────────────────
// Step 13 — Clamp and stats
// ─────────────────────────────────────────────

export function clampNonNeg(arr) {
  let clamps = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < 0) { arr[i] = 0; clamps++; }
  }
  return clamps;
}

export function computeStats(gasArr, elecArr, weather, timestamps, timestampMs, heatingOn, isAbsence, archetypeConfig, noiseConfig, injectedEvents) {
  const n = gasArr.length;
  const gasKwh  = gasArr.reduce((a, b)  => a + b, 0);
  const elecKwh = elecArr.reduce((a, b) => a + b, 0);
  const gasTarget  = archetypeConfig.annual_gas_target_kwh;
  const elecTarget = archetypeConfig.annual_elec_target_kwh;
  const gasDeltaPct  = ((gasKwh  - gasTarget)  / gasTarget)  * 100;
  const elecDeltaPct = ((elecKwh - elecTarget) / elecTarget) * 100;

  // Group by date for daily aggregates
  const dailyGas  = new Map();
  const dailyElec = new Map();
  const dailyTemps = new Map();
  const dailyAbsence = new Map();
  for (let i = 0; i < n; i++) {
    const date = timestamps[i].slice(0, 10);
    dailyGas.set(date,     (dailyGas.get(date)     ?? 0) + gasArr[i]);
    dailyElec.set(date,    (dailyElec.get(date)    ?? 0) + elecArr[i]);
    if (!dailyTemps.has(date)) dailyTemps.set(date, []);
    dailyTemps.get(date).push(weather[i].temp_c);
    if (isAbsence[i]) dailyAbsence.set(date, true);
  }

  // Daily HDD and R² for gas vs HDD (heating months only, non-absence)
  // Linear regression with intercept: gas = α + β × HDD
  const HEATING_MONTHS = new Set([10, 11, 12, 1, 2, 3]);
  const hddDays = [], gasDays = [];
  for (const [date, temps] of dailyTemps) {
    if (dailyAbsence.get(date)) continue;
    const month = parseInt(date.slice(5, 7), 10);
    if (!HEATING_MONTHS.has(month)) continue;
    const meanTemp = temps.reduce((a, b) => a + b, 0) / temps.length;
    const hdd = Math.max(0, HDD_BASE_TEMP - meanTemp);
    if (hdd <= 0) continue;
    gasDays.push(dailyGas.get(date) ?? 0);
    hddDays.push(hdd);
  }
  const nPts = gasDays.length;
  const meanG = nPts > 0 ? gasDays.reduce((a, b) => a + b, 0) / nPts : 0;
  const meanH = nPts > 0 ? hddDays.reduce((a, b) => a + b, 0) / nPts : 0;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < nPts; i++) {
    const dx = hddDays[i] - meanH;
    sxx += dx * dx;
    sxy += dx * (gasDays[i] - meanG);
  }
  const beta  = sxx > 0 ? sxy / sxx : 0;
  const alpha = meanG - beta * meanH;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < nPts; i++) {
    const pred = alpha + beta * hddDays[i];
    ssRes += Math.pow(gasDays[i] - pred, 2);
    ssTot += Math.pow(gasDays[i] - meanG, 2);
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;

  // Weekday/weekend elec ratio
  const wdElec = [], weElec = [];
  for (const [date, kwh] of dailyElec) {
    const dow = new Date(date).getUTCDay();
    if (dow >= 1 && dow <= 5) wdElec.push(kwh);
    else weElec.push(kwh);
  }
  const wdMean = wdElec.length > 0 ? wdElec.reduce((a, b) => a + b, 0) / wdElec.length : 0;
  const weMean = weElec.length > 0 ? weElec.reduce((a, b) => a + b, 0) / weElec.length : 0;
  const wwElecRatio = weMean > 0 ? wdMean / weMean : null;

  // Summer/winter elec ratio
  const summerElec = [], winterElec = [];
  for (const [date, kwh] of dailyElec) {
    const month = parseInt(date.slice(5, 7), 10);
    if (month >= 6 && month <= 8)  summerElec.push(kwh);
    if (month === 12 || month <= 2) winterElec.push(kwh);
  }
  const summerMean = summerElec.length > 0 ? summerElec.reduce((a, b) => a + b, 0) / summerElec.length : 0;
  const winterMean = winterElec.length > 0 ? winterElec.reduce((a, b) => a + b, 0) / winterElec.length : 0;
  const swElecRatio = summerMean > 0 ? winterMean / summerMean : null;

  // Summer baseload (median Jun-Aug daily gas)
  const summerGas = [];
  for (const [date, kwh] of dailyGas) {
    const month = parseInt(date.slice(5, 7), 10);
    if (month >= 6 && month <= 8) summerGas.push(kwh);
  }
  summerGas.sort((a, b) => a - b);
  const summerBaseload = summerGas.length > 0
    ? summerGas[Math.floor(summerGas.length / 2)]
    : null;

  // Holiday events
  const holidayWeeksInjected = noiseConfig.holiday_weeks.mean_duration_days > 0
    ? injectedEvents
    : 0;

  // Face validity pass/fail
  const fv = {
    gas_hdd_r2:           { value: r2,              expected: [0.70, 0.97], pass: r2 != null && r2 >= 0.70 && r2 <= 0.97 },
    weekday_weekend_ratio: { value: wwElecRatio,     expected: [0.80, 1.20], pass: wwElecRatio != null && wwElecRatio >= 0.80 && wwElecRatio <= 1.20 },
    summer_winter_ratio:   { value: swElecRatio,     expected: [1.05, 1.80], pass: swElecRatio != null && swElecRatio >= 1.05 && swElecRatio <= 1.80 },
    holiday_weeks_injected:{ value: holidayWeeksInjected, expected: [noiseConfig.holiday_weeks.events_per_year - 1, noiseConfig.holiday_weeks.events_per_year + 1], pass: holidayWeeksInjected >= noiseConfig.holiday_weeks.events_per_year - 1 && holidayWeeksInjected <= noiseConfig.holiday_weeks.events_per_year + 1 },
  };

  // Warnings
  const warnings = [];
  if (Math.abs(gasDeltaPct) > 30)  warnings.push(`Gas annual total off target by ${gasDeltaPct.toFixed(1)}% (|delta| > 30%)`);
  if (Math.abs(elecDeltaPct) > 30) warnings.push(`Elec annual total off target by ${elecDeltaPct.toFixed(1)}% (|delta| > 30%)`);

  return {
    slug: archetypeConfig.slug,
    bake_timestamp: new Date().toISOString(),
    prng_seed: archetypeConfig.prng_seed,
    annual_totals: {
      gas_kwh:         gasKwh,
      gas_target_kwh:  gasTarget,
      gas_delta_pct:   gasDeltaPct,
      elec_kwh:        elecKwh,
      elec_target_kwh: elecTarget,
      elec_delta_pct:  elecDeltaPct,
    },
    face_validity: fv,
    input_parameters_for_audit: {
      building:  archetypeConfig.building,
      schedule:  archetypeConfig.schedule,
      baseload:  archetypeConfig.baseload,
      location:  archetypeConfig.location,
      time_window: archetypeConfig.time_window,
      noise_overrides: archetypeConfig.noise_overrides ?? null,
    },
    warnings,
  };
}

// ─────────────────────────────────────────────
// Step 14 — Output writing
// ─────────────────────────────────────────────

export function writeOutputs(timestamps, gasArr, elecArr, stats, archetypeConfig, noiseConfigPath, opts) {
  const slug      = archetypeConfig.slug;
  const outputDir = opts.outputDir;
  fs.mkdirSync(outputDir, { recursive: true });

  // CSV (atomic: tmp → rename)
  const csvPath = path.join(outputDir, `${slug}.csv`);
  const tmpPath = csvPath + '.tmp';
  const lines   = ['datetime,gas_kwh,electricity_kwh'];
  for (let i = 0; i < timestamps.length; i++) {
    lines.push(`${timestamps[i]},${gasArr[i].toFixed(4)},${elecArr[i].toFixed(4)}`);
  }
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
  fs.renameSync(tmpPath, csvPath);

  // Stats JSON
  const statsPath = path.join(outputDir, `${slug}-stats.json`);
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));

  // Bake report MD
  const reportPath = path.join(outputDir, `${slug}-bake-report.md`);
  const at         = stats.annual_totals;
  const fv         = stats.face_validity;

  const fvTable = Object.entries(fv).map(([k, v]) => {
    const pass = v.pass ? '✅' : '❌';
    const val  = v.value != null ? (typeof v.value === 'number' ? v.value.toFixed(3) : v.value) : 'n/a';
    return `| ${k} | ${val} | [${v.expected[0]}, ${v.expected[1]}] | ${pass} |`;
  }).join('\n');

  const report = `# Bake Report — ${slug}

**Baked:** ${stats.bake_timestamp}
**Config:** ${archetypeConfig.slug}
**Noise config:** ${noiseConfigPath}
**Output:** ${outputDir}

## Annual Totals

| Fuel | Synthesised (kWh) | Target (kWh) | Delta |
|------|-------------------|--------------|-------|
| Gas  | ${at.gas_kwh.toFixed(0)} | ${at.gas_target_kwh} | ${at.gas_delta_pct > 0 ? '+' : ''}${at.gas_delta_pct.toFixed(1)}% |
| Elec | ${at.elec_kwh.toFixed(0)} | ${at.elec_target_kwh} | ${at.elec_delta_pct > 0 ? '+' : ''}${at.elec_delta_pct.toFixed(1)}% |

## Face Validity

| Metric | Value | Expected range | Pass |
|--------|-------|----------------|------|
${fvTable}

## Warnings

${stats.warnings.length === 0 ? '_None_' : stats.warnings.map(w => `- ${w}`).join('\n')}

## Console Snippet

To inspect in the browser after manual upload, open DevTools and run:

\`\`\`js
// Note: variable names depend on current app.js structure
window.__getScenarioDiagnostics?.()
window.__getPricingResult?.()
window.__getFinancialResult?.()
\`\`\`

## Next Steps

1. Upload \`${slug}.csv\` via the tool's CSV upload path
2. Run through the full pipeline to completion
3. Review face validity metrics against the expected ranges above
4. Check bake report warnings (if any)
`;

  fs.writeFileSync(reportPath, report);

  return { csvPath, statsPath, reportPath };
}

// ─────────────────────────────────────────────
// Step 15 — Optional runToolModules
// ─────────────────────────────────────────────

async function runModuleSanityCheck(csvPath, archetypeConfig, opts) {
  let parseCSV;
  try {
    const mod = await import('../../js/data-ingestion.js');
    parseCSV  = mod.parseCSV;
  } catch (e) {
    console.warn(`  runToolModules: import of data-ingestion.js failed — ${e.message}`);
    return { error: 'import_failed' };
  }

  const csvContent  = fs.readFileSync(csvPath, 'utf8');
  const { records, errors } = parseCSV(csvContent);
  if (errors && errors.length > 0) {
    console.warn(`  runToolModules: parseCSV reported errors:`, errors);
    return { error: 'parse_errors', errors };
  }
  const expectedRows = 17520; // full 2025
  const result = { record_count: records.length, expected: expectedRows, ok: records.length === expectedRows };
  if (!result.ok) {
    console.warn(`  runToolModules: record count mismatch — got ${records.length}, expected ${expectedRows}`);
  }

  const outPath = path.join(opts.outputDir, `${archetypeConfig.slug}-tool-modules.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  return result;
}

// ─────────────────────────────────────────────
// Step 16 — Main synthesise()
// ─────────────────────────────────────────────

export async function synthesise(archetypeConfigPath, noiseConfigPath, opts = {}) {
  const { archetype, noise } = readConfigs(archetypeConfigPath, noiseConfigPath);
  const slug = archetype.slug;

  const resolvedOpts = {
    outputDir:      opts.outputDir      ?? `./bake-output/${slug}`,
    weatherCacheDir: opts.weatherCacheDir ?? './bake-input/weather',
    runToolModules: opts.runToolModules  ?? false,
    verbose:        opts.verbose         ?? false,
  };

  if (resolvedOpts.verbose) console.log(`[synthesise] ${slug} — starting`);

  const prng = mulberry32(archetype.prng_seed);

  const weather = await fetchWeatherCached(
    archetype.location.postcode,
    archetype.time_window,
    resolvedOpts.weatherCacheDir,
    resolvedOpts.verbose
  );

  const { timestamps, timestampMs } = generateTimestamps(archetype.time_window);

  const weatherMap     = new Map(weather.map(e => [e.timestamp, e]));
  const weatherAligned = timestamps.map(ts => {
    const w = weatherMap.get(ts);
    if (!w) throw new Error(`No weather entry for timestamp ${ts}`);
    return w;
  });

  const heatingOn = generateSchedule(archetype.schedule, timestampMs, noise, prng);
  const { isAbsence, injectedEvents } = generateHolidayWeeks(timestampMs, noise, prng);
  const { gasHeating } = computeForwardModel(archetype, timestampMs, weatherAligned, heatingOn, isAbsence);
  const gasBaseload   = computeHWandCooking(archetype, timestampMs, noise, prng);
  const elec          = computeElecBaseload(archetype, timestamps, timestampMs, weatherAligned, noise, prng);

  const gasArr  = new Float64Array(timestamps.length);
  const elecArr = new Float64Array(timestamps.length);
  for (let i = 0; i < timestamps.length; i++) {
    gasArr[i]  = isAbsence[i] ? 0 : gasHeating[i] + gasBaseload[i];
    elecArr[i] = isAbsence[i] ? 0 : elec[i];
  }

  injectNoise(gasArr, elecArr, noise, archetype, prng);
  const gasClamps  = clampNonNeg(gasArr);
  const elecClamps = clampNonNeg(elecArr);

  if (gasClamps  > timestamps.length * 0.005) console.warn(`  ${slug}: ${gasClamps} gas clamps (>${(0.005 * 100).toFixed(1)}%)`);
  if (elecClamps > timestamps.length * 0.005) console.warn(`  ${slug}: ${elecClamps} elec clamps (>${(0.005 * 100).toFixed(1)}%)`);

  const stats = computeStats(
    gasArr, elecArr, weatherAligned, timestamps, timestampMs,
    heatingOn, isAbsence, archetype, noise, injectedEvents
  );

  const { csvPath, statsPath, reportPath } = writeOutputs(
    timestamps, gasArr, elecArr, stats, archetype, noiseConfigPath, resolvedOpts
  );

  if (resolvedOpts.verbose) {
    console.log(`  Gas:  ${stats.annual_totals.gas_kwh.toFixed(0)} kWh (${stats.annual_totals.gas_delta_pct > 0 ? '+' : ''}${stats.annual_totals.gas_delta_pct.toFixed(1)}%)`);
    console.log(`  Elec: ${stats.annual_totals.elec_kwh.toFixed(0)} kWh (${stats.annual_totals.elec_delta_pct > 0 ? '+' : ''}${stats.annual_totals.elec_delta_pct.toFixed(1)}%)`);
  }

  if (resolvedOpts.runToolModules) {
    await runModuleSanityCheck(csvPath, archetype, resolvedOpts);
  }

  return { slug, outputDir: resolvedOpts.outputDir, stats, csvPath, statsPath, reportPath };
}
