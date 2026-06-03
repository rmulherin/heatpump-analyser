// ===== External Data Module =====
// Weather (Open-Meteo), wholesale prices (Elexon MID), postcode coordinates.
// Aligns all external series to the unified HH UTC timeline from data-ingestion.
// M2 is the single source of all operative base tariffs (HH Agile, flat/SVT elec,
// gas, standing charges). Wholesale prices are M2-internal; external[] is weather-only.

const { DateTime } = luxon;

// ===== Configuration =====

const EXTERNAL_CONFIG = {
  POSTCODES_BASE_URL: 'https://api.postcodes.io/postcodes',
  OPEN_METEO_ARCHIVE_URL: 'https://archive-api.open-meteo.com/v1/archive',
  OPEN_METEO_FORECAST_URL: 'https://api.open-meteo.com/v1/forecast',
  ELEXON_MID_URL: 'https://data.elexon.co.uk/bmrs/api/v1/datasets/MID',
  COORDINATE_PRECISION: 4,
  WEATHER_VARIABLES: 'temperature_2m,shortwave_radiation',
  RECENT_DAY_BUFFER: 5,
  RETRY_DELAY_MS: 2000,
};

const AGILE_REFORM_DATE  = new Date('2026-04-01T00:00:00Z');
const AGILE_PRODUCT_CODE = 'AGILE-24-10-01';

// ===== Ofgem price cap constants (M2-owned; relocated from PE_CONFIG) =====
// Unit rates (p/kWh, national, quarterly). Used on CSV/demo path only;
// API path uses m1's actual tariff timeline.
// TO POPULATE: source the full quarterly schedule (Q1 2024→Q4 2026+) from
// https://www.ofgem.gov.uk/check-if-energy-price-cap-affects-you before v2 launch.
// Out-of-range quarters fall back to the nearest known value.
const OFGEM_CAP_ELEC_BY_QUARTER = {
  '2024-Q1': 24.50,  // PROVISIONAL — to source
  '2024-Q2': 24.50,  // PROVISIONAL
  '2024-Q3': 24.50,  // PROVISIONAL
  '2024-Q4': 24.50,  // PROVISIONAL
  '2025-Q1': 24.50,  // PROVISIONAL — to source
  '2025-Q2': 24.50,  // PROVISIONAL
  '2025-Q3': 24.50,  // PROVISIONAL
  '2025-Q4': 24.50,  // PROVISIONAL
  '2026-Q1': 24.50,  // PROVISIONAL (to source)
  '2026-Q2': 24.50,  // confirmed (was PE_CONFIG.SVT_RATE_DEFAULT_P)
  '2026-Q3': 24.50,  // PROVISIONAL
  '2026-Q4': 24.50,  // PROVISIONAL
};

const OFGEM_CAP_GAS_BY_QUARTER = {
  '2024-Q1': 5.90,   // PROVISIONAL
  '2024-Q2': 5.90,   // PROVISIONAL
  '2024-Q3': 5.90,   // PROVISIONAL
  '2024-Q4': 5.90,   // PROVISIONAL
  '2025-Q1': 5.90,   // PROVISIONAL
  '2025-Q2': 5.90,   // PROVISIONAL
  '2025-Q3': 5.90,   // PROVISIONAL
  '2025-Q4': 5.90,   // PROVISIONAL
  '2026-Q1': 5.90,   // design doc: "5.9→5.7 across quarters"
  '2026-Q2': 5.70,   // design doc confirmed
  '2026-Q3': 5.70,   // PROVISIONAL
  '2026-Q4': 5.70,   // PROVISIONAL
};

// 14-region Agile D/P table (VAT-exclusive; Octopus blog post, April 2026 update).
// Canonical source: data/agile-regional-rates.csv
const AGILE_REGIONAL_RATES = {
  'A': { D: 2.10, P: 13 }, 'B': { D: 2.00, P: 14 }, 'C': { D: 2.00, P: 12 },
  'D': { D: 2.20, P: 13 }, 'E': { D: 2.10, P: 12 }, 'F': { D: 2.10, P: 12 },
  'G': { D: 2.10, P: 12 }, 'H': { D: 2.10, P: 12 }, 'J': { D: 2.20, P: 12 },
  'K': { D: 2.20, P: 12 }, 'L': { D: 2.30, P: 11 }, 'M': { D: 2.00, P: 13 },
  'N': { D: 2.10, P: 13 }, 'P': { D: 2.40, P: 12 },
};

// 14-region standing charges (p/day, Ofgem-cap basis).
// PENDING_SOURCE — provisional national estimates for all regions.
// Northern Scotland (P) is materially wrong; source genuine regional values.
// Canonical source: data/regional-standing-charges.csv
const REGIONAL_STANDING_CHARGES = {
  'A': { gas: 31.66, elec: 61.64 }, 'B': { gas: 31.66, elec: 61.64 },
  'C': { gas: 31.66, elec: 61.64 }, 'D': { gas: 31.66, elec: 61.64 },
  'E': { gas: 31.66, elec: 61.64 }, 'F': { gas: 31.66, elec: 61.64 },
  'G': { gas: 31.66, elec: 61.64 }, 'H': { gas: 31.66, elec: 61.64 },
  'J': { gas: 31.66, elec: 61.64 }, 'K': { gas: 31.66, elec: 61.64 },
  'L': { gas: 31.66, elec: 61.64 }, 'M': { gas: 31.66, elec: 61.64 },
  'N': { gas: 31.66, elec: 61.64 }, 'P': { gas: 31.66, elec: 61.64 },
};

const NATIONAL_GAS_STANDING_DEFAULT  = 31.66; // p/day — fallback when region null
const NATIONAL_ELEC_STANDING_DEFAULT = 61.64;
const D_DEFAULT_NATIONAL             = 2.2;
const P_DEFAULT_NATIONAL             = 12;
const IMPUTE_MIN_WINDOW_SAMPLES      = 50;    // min non-null slots in 7-day window

// ===== Shared state =====

let _externalResult = null;
export function setExternalResult(result) { _externalResult = result; }
export function getExternalResult() { return _externalResult; }


// ===== Helpers =====

function canonicaliseTs(ts) {
  return DateTime.fromISO(ts, { zone: 'utc' }).toISO({ suppressMilliseconds: true });
}

function dateOnly(isoString) {
  return isoString.slice(0, 10);
}

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function isUkPeakHour(ts) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: 'numeric', hour12: false
  });
  const hour = parseInt(fmt.format(ts), 10);
  return hour >= 16 && hour < 19;
}

async function fetchWithRetry(url, label) {
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    // Retry once after delay
    await new Promise(r => setTimeout(r, EXTERNAL_CONFIG.RETRY_DELAY_MS));
    try {
      resp = await fetch(url);
    } catch (e2) {
      throw new Error(`${label} is down. Try again shortly.`);
    }
  }
  if (!resp.ok) {
    if (resp.status >= 500) {
      // Retry once for server errors
      await new Promise(r => setTimeout(r, EXTERNAL_CONFIG.RETRY_DELAY_MS));
      resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`${label} returned an error (${resp.status}). Try again later.`);
      }
    } else {
      throw { status: resp.status, response: resp };
    }
  }
  return resp;
}

// Returns the Ofgem-cap quarter key for a given date.
// Falls back to the nearest known quarter if out-of-range.
function quarterKey(tsDate) {
  const d    = tsDate instanceof Date ? tsDate : new Date(tsDate);
  const year = d.getUTCFullYear();
  const q    = Math.floor(d.getUTCMonth() / 3) + 1;
  const key  = `${year}-Q${q}`;
  if (OFGEM_CAP_ELEC_BY_QUARTER[key] !== undefined) return key;
  const keys     = Object.keys(OFGEM_CAP_ELEC_BY_QUARTER).sort();
  const before   = [...keys].filter(k => k <= key).pop();
  const after    = keys.find(k => k > key);
  const fallback = before ?? after ?? keys[0];
  console.warn(`Ofgem cap: quarter ${key} not in table — using ${fallback}`);
  return fallback;
}

// Forward-scan tariff windowing: returns the rate_p_kwh active at tsDate,
// or null if no window covers it (caller applies quarterly default).
function getRateForTs(tsDate, sortedWindows) {
  if (!sortedWindows || sortedWindows.length === 0) return null;
  let rate = null;
  for (const w of sortedWindows) {
    if (new Date(w.valid_from) > tsDate) break;
    if (!w.valid_to || new Date(w.valid_to) > tsDate) { rate = w.rate_p_kwh; break; }
  }
  if (rate === null) {
    rate = sortedWindows.findLast(w => new Date(w.valid_from) <= tsDate)?.rate_p_kwh
        ?? sortedWindows[0]?.rate_p_kwh ?? null;
  }
  return rate;
}

// Null-wholesale imputation: 7-day preceding-window mean → global mean → last-resort cap/D.
// Relocated from pricing-engine.js (identical logic).
function imputeWholesaleForSlot(i, wholesale_array, global_mean_known, D, ofgem_cap) {
  const window_start = Math.max(0, i - 336); // preceding 7 days × 48 HHs
  const window_slots = wholesale_array.slice(window_start, i).filter(w => w !== null);
  if (window_slots.length >= IMPUTE_MIN_WINDOW_SAMPLES) {
    return window_slots.reduce((s, w) => s + w, 0) / window_slots.length;
  }
  if (global_mean_known !== null) return global_mean_known;
  return ofgem_cap / D;
}


// ===== Step 2: Postcode → coordinates =====

export async function lookupPostcode(postcode) {
  const stripped = postcode.replace(/\s+/g, '');
  const url = `${EXTERNAL_CONFIG.POSTCODES_BASE_URL}/${encodeURIComponent(stripped)}`;

  let resp;
  try {
    resp = await fetchWithRetry(url, 'Postcode lookup service');
  } catch (e) {
    if (e.status === 404) {
      throw new Error('Postcode not recognised.');
    }
    throw e instanceof Error ? e : new Error('Postcode lookup service is down. Try again shortly.');
  }

  const data = await resp.json();
  return {
    latitude: roundCoord(data.result.latitude),
    longitude: roundCoord(data.result.longitude),
    elevation_m: data.result.elevation ?? null,
  };
}


// ===== Step 3: Weather fetch =====

export async function fetchWeather(latitude, longitude, dataStart, dataEnd) {
  const startDate = dateOnly(dataStart);
  const endDate = dateOnly(dataEnd);
  const url = `${EXTERNAL_CONFIG.OPEN_METEO_ARCHIVE_URL}?latitude=${latitude}&longitude=${longitude}&start_date=${startDate}&end_date=${endDate}&hourly=${EXTERNAL_CONFIG.WEATHER_VARIABLES}&timezone=UTC`;

  let resp;
  try {
    resp = await fetchWithRetry(url, 'Weather data service');
  } catch (e) {
    if (e.status === 400) {
      throw new Error('Weather data request failed. Check the date range.');
    }
    throw e instanceof Error ? e : new Error('Weather data service is down. Try again shortly.');
  }

  const data = await resp.json();
  const weatherMap = new Map();

  const times = data.hourly.time;
  const temps = data.hourly.temperature_2m;
  const solar = data.hourly.shortwave_radiation;

  for (let i = 0; i < times.length; i++) {
    // Open-Meteo returns "2025-04-01T14:00" without Z — treat as UTC
    const hourKey = DateTime.fromISO(times[i], { zone: 'utc' })
      .startOf('hour')
      .toISO({ suppressMilliseconds: true });
    weatherMap.set(hourKey, {
      temperature_2m: temps[i],
      shortwave_radiation: solar[i],
    });
  }

  return { weatherMap, rawResponse: data };
}


// ===== Step 4: Recent-day weather fallback =====

export function buildExpectedHours(dataStart, dataEnd) {
  const start = DateTime.fromISO(dataStart, { zone: 'utc' }).startOf('hour');
  const end = DateTime.fromISO(dataEnd, { zone: 'utc' }).startOf('hour');
  const hours = [];
  let current = start;
  while (current <= end) {
    hours.push(current.toISO({ suppressMilliseconds: true }));
    current = current.plus({ hours: 1 });
  }
  return hours;
}

export function needsFallback(weatherMap, expectedHours, dataEnd) {
  const cutoff = DateTime.fromISO(dataEnd, { zone: 'utc' })
    .minus({ days: EXTERNAL_CONFIG.RECENT_DAY_BUFFER });
  return expectedHours.some(hourKey => {
    if (DateTime.fromISO(hourKey, { zone: 'utc' }) < cutoff) return false;
    const entry = weatherMap.get(hourKey);
    return !entry || entry.temperature_2m == null;
  });
}

export async function fetchWeatherFallback(latitude, longitude, weatherMap, expectedHours, dataEnd) {
  const url = `${EXTERNAL_CONFIG.OPEN_METEO_FORECAST_URL}?latitude=${latitude}&longitude=${longitude}&past_days=7&hourly=${EXTERNAL_CONFIG.WEATHER_VARIABLES}&timezone=UTC`;

  let resp;
  try {
    resp = await fetchWithRetry(url, 'Weather forecast service');
  } catch (e) {
    // Fallback is best-effort — if it fails, proceed with gaps
    return { weatherMap, usedFallback: false };
  }

  const data = await resp.json();
  const times = data.hourly.time;
  const temps = data.hourly.temperature_2m;
  const solar = data.hourly.shortwave_radiation;

  let filled = false;
  for (let i = 0; i < times.length; i++) {
    const hourKey = DateTime.fromISO(times[i], { zone: 'utc' })
      .startOf('hour')
      .toISO({ suppressMilliseconds: true });
    const existing = weatherMap.get(hourKey);
    if (!existing || existing.temperature_2m == null) {
      if (temps[i] != null) {
        weatherMap.set(hourKey, {
          temperature_2m: temps[i],
          shortwave_radiation: solar[i],
        });
        filled = true;
      }
    }
  }

  return { weatherMap, usedFallback: filled };
}


// ===== Step 5: Weather → HH lookup helper =====

export function buildWeatherLookup(weatherMap) {
  return function lookupWeather(timestamp) {
    const hourKey = DateTime.fromISO(timestamp, { zone: 'utc' })
      .startOf('hour')
      .toISO({ suppressMilliseconds: true });
    return weatherMap.get(hourKey) ?? null;
  };
}


// ===== Step 6: Elexon MID fetch =====

export async function fetchWholesalePrices(dataStart, dataEnd, onProgress) {
  const warnings = [];
  // API limit: max 8 days per request (filtered by startTime UTC, not settlementDate).
  // Stride 7 days and extend `to` by 1 day so BST settlement dates at chunk boundaries
  // don't lose SPs 4-48 (which have startTimes after UTC midnight of the settlement date).
  const MAX_CHUNK_DAYS = 7;

  const startDate = new Date(dateOnly(dataStart) + 'T00:00:00Z');
  const endDate = new Date(dateOnly(dataEnd) + 'T00:00:00Z');
  let allRecords = [];

  const totalChunks = Math.ceil((endDate - startDate) / (MAX_CHUNK_DAYS * 86400000)) + 1;
  let chunksDone = 0;

  try {
    let cursor = new Date(startDate);
    while (cursor <= endDate) {
      const chunkEnd = new Date(cursor);
      chunkEnd.setUTCDate(chunkEnd.getUTCDate() + MAX_CHUNK_DAYS - 1);
      if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());

      // Extend to by 1 day: captures SPs whose startTime falls after UTC midnight
      // of the last settlement date (all BST SPs 4-48, all GMT SPs 2-48).
      const toDate = new Date(chunkEnd);
      toDate.setUTCDate(toDate.getUTCDate() + 1);

      const from = dateOnly(cursor.toISOString());
      const to = dateOnly(toDate.toISOString());
      let pageUrl = `${EXTERNAL_CONFIG.ELEXON_MID_URL}?from=${from}&to=${to}&format=json`;

      while (pageUrl) {
        const resp = await fetchWithRetry(pageUrl, 'Wholesale price service');
        const data = await resp.json();
        const records = data.data || [];
        allRecords.push(...records);

        pageUrl = null;
        if (data.links) {
          const nextLink = data.links.find(l => l.rel === 'next');
          if (nextLink && nextLink.href) {
            pageUrl = nextLink.href;
          }
        }
      }

      chunksDone++;
      onProgress?.(Math.round((chunksDone / totalChunks) * 100));
      await new Promise(r => setTimeout(r, 0));
      cursor.setUTCDate(cursor.getUTCDate() + MAX_CHUNK_DAYS);
    }
  } catch (e) {
    // Price failure is non-blocking — warn and continue with null prices
    const msg = e instanceof Error ? e.message : `Wholesale price fetch failed (${e.status}).`;
    warnings.push(msg + ' Wholesale price scenarios will be incomplete.');
    return { priceLookup: new Map(), source: 'elexon-mid-apx', warnings };
  }

  // Filter to APXMIDP only (N2EX has structurally withdrawn from UK MID peak-hour trading)
  const apxRecords = allRecords.filter(r => r.dataProvider === 'APXMIDP');

  // Deduplicate: chunk `to` overlap causes one boundary SP per chunk to appear twice
  const seen = new Set();
  const uniqueRecords = apxRecords.filter(r => {
    const key = `${r.settlementDate}|${r.settlementPeriod}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Convert SP→UTC and £/MWh→p/kWh
  const converted = uniqueRecords.map(r => ({
    settlementDate: r.settlementDate,
    settlementPeriod: r.settlementPeriod,
    price: r.price / 10, // £/MWh → p/kWh
    dataProvider: r.dataProvider,
  }));

  const { priceLookup, warnings: spWarnings } = convertSpToUtc(converted);
  warnings.push(...spWarnings);

  return { priceLookup, source: 'elexon-mid-apx', warnings };
}


// ===== Step 6a: SP→UTC conversion =====
// Settlement Period 1 begins at 00:00 LOCAL TIME on Settlement Day D.
// Confirmed from Elexon BSC documentation. Uses Luxon Europe/London zone
// for automatic DST handling.

export function convertSpToUtc(midRecords) {
  const priceLookup = new Map();
  const warnings = [];
  const spCountsByDate = new Map();

  for (const { settlementDate, settlementPeriod, price, dataProvider } of midRecords) {
    if (dataProvider !== 'APXMIDP') continue;

    // Base: 00:00 LOCAL on settlementDate (Europe/London)
    const baseDate = DateTime.fromISO(settlementDate, { zone: 'Europe/London' });

    // Add (sp-1) × 30 minutes of ABSOLUTE time.
    // Luxon's .plus() operates on the absolute timeline, so DST transitions
    // are handled by construction.
    const localStart = baseDate.plus({ minutes: (settlementPeriod - 1) * 30 });

    const utcKey = localStart.toUTC().toISO({ suppressMilliseconds: true });

    if (priceLookup.has(utcKey)) {
      warnings.push(`Duplicate UTC key ${utcKey} from ${settlementDate} SP ${settlementPeriod}`);
    }
    priceLookup.set(utcKey, price);

    spCountsByDate.set(settlementDate, (spCountsByDate.get(settlementDate) || 0) + 1);
  }

  // Validate SP counts per date (46/48/50 only)
  for (const [date, count] of spCountsByDate) {
    if (![46, 48, 50].includes(count)) {
      warnings.push(`Unexpected SP count ${count} for ${date}`);
    }
  }

  return { priceLookup, warnings };
}


// ===== Step 6b: Agile calibration — 3-path source hierarchy =====

export async function fetchAgileCalibration(gsp_region) {
  // Path 3 short-circuit: no region
  if (!gsp_region) {
    return {
      D: D_DEFAULT_NATIONAL, P_peak_p_kwh: P_DEFAULT_NATIONAL,
      D_sample_count: 0, P_sample_count: 0,
      calibration_period: null, gsp_region: null,
      null_wholesale_fraction: null,
      source: 'national_default',
    };
  }

  const now            = new Date();
  const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const calibStart     = prevMonthStart >= AGILE_REFORM_DATE ? prevMonthStart : AGILE_REFORM_DATE;
  const calibEnd       = prevMonthStart >= AGILE_REFORM_DATE ? thisMonthStart : now;
  const isPartial      = prevMonthStart < AGILE_REFORM_DATE;

  // Path 1: live calibration — attempt
  try {
    if (calibEnd <= calibStart) throw new Error('Calibration window is empty.');

    const tariffPath = `E-1R-${AGILE_PRODUCT_CODE}-${gsp_region}`;
    let url = `https://api.octopus.energy/v1/products/${AGILE_PRODUCT_CODE}`
            + `/electricity-tariffs/${tariffPath}/standard-unit-rates/`
            + `?period_from=${calibStart.toISOString()}&period_to=${calibEnd.toISOString()}&page_size=1500`;
    const agileRates = [];
    while (url) {
      const res  = await fetchWithRetry(url, 'Agile rates');
      const data = await res.json();
      agileRates.push(...(data.results ?? []));
      url = data.next ?? null;
    }
    if (agileRates.length === 0) throw new Error('No Agile rate data returned.');

    const agileMap = new Map();
    for (const r of agileRates) {
      agileMap.set(new Date(r.valid_from).toISOString(), r.value_inc_vat);
    }

    const { priceLookup } = await fetchWholesalePrices(
      calibStart.toISOString(), calibEnd.toISOString(), () => {}
    );

    const D_MIN = 1.5, D_MAX = 3.0;
    const P_MIN = 5,   P_MAX = 20;
    const D_MIN_SAMPLES = 50;
    const P_MIN_SAMPLES = 20;

    const D_samples = [];
    const P_samples = [];
    for (const [ts, wholesale] of priceLookup) {
      if (wholesale === null || wholesale <= 1.0) continue;
      const tsDate   = new Date(ts);
      const agileVal = agileMap.get(tsDate.toISOString());
      if (agileVal === undefined || agileVal === null) continue;
      if (isUkPeakHour(tsDate)) {
        P_samples.push({ agile: agileVal, wholesale });
      } else {
        D_samples.push(agileVal / wholesale);
      }
    }

    const D_sample_count = D_samples.length;
    const P_sample_count = P_samples.length;

    if (D_sample_count === 0) throw new Error('No off-peak calibration samples.');

    const D = median(D_samples);
    const P_computed = P_samples.map(s => s.agile - D * s.wholesale);
    const P = P_computed.length > 0 ? median(P_computed) : 0;

    const D_valid = D >= D_MIN && D <= D_MAX;
    const P_valid = P >= P_MIN && P <= P_MAX;
    const count_valid = D_sample_count >= D_MIN_SAMPLES && P_sample_count >= P_MIN_SAMPLES;

    if (!D_valid || !P_valid || !count_valid) {
      if (!D_valid) console.warn(`Agile calibration D=${D.toFixed(3)} outside expected range 1.5–3.0`);
      if (!P_valid) console.warn(`Agile calibration P=${P.toFixed(2)} outside expected range 5–20 p/kWh`);
      throw new Error('Calibration values outside valid range — falling back to regional table.');
    }

    const monthNames = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
    const calibPeriod = isPartial
      ? `${monthNames[calibStart.getUTCMonth()]} ${calibStart.getUTCFullYear()} (partial)`
      : `${monthNames[calibStart.getUTCMonth()]} ${calibStart.getUTCFullYear()}`;

    return {
      D, P_peak_p_kwh: P,
      D_sample_count, P_sample_count,
      calibration_period: calibPeriod, gsp_region,
      null_wholesale_fraction: null,
      source: 'calibrated',
    };

  } catch (err) {
    console.warn('Agile live calibration failed — using regional table:', err.message);
    // Path 2: regional table fallback (Path 3: national if region not in table)
    const row = AGILE_REGIONAL_RATES[gsp_region];
    return {
      D:              row ? row.D : D_DEFAULT_NATIONAL,
      P_peak_p_kwh:  row ? row.P : P_DEFAULT_NATIONAL,
      D_sample_count: 0, P_sample_count: 0,
      calibration_period: null, gsp_region,
      null_wholesale_fraction: null,
      source: row ? 'regional_table' : 'national_default',
    };
  }
}


// ===== Step 7: Build base tariffs (M2 single tariff source) =====

export function buildBaseTariffs(consumption, priceLookup, agileCalibration, tariff_rates, gsp_region) {
  const n = consumption.length;
  const hh_rate   = new Array(n);
  const gas_rate  = new Array(n);
  const flat_rate = new Array(n);

  const { D, P_peak_p_kwh } = agileCalibration;
  // Calibrated path: D already absorbs VAT. Table/national: D and P are VAT-exclusive.
  const isCalibrated = agileCalibration.source === 'calibrated';

  const gasWindows  = [...(tariff_rates.gas         ?? [])].sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));
  const elecWindows = [...(tariff_rates.electricity ?? [])].sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));

  // Pre-compute wholesale array and global mean for null-slot imputation
  const wholesale_array = consumption.map(({ timestamp }) => {
    const tsCanonical = canonicaliseTs(timestamp);
    return priceLookup.get(tsCanonical) ?? null;
  });
  const known_wholesale = wholesale_array.filter(w => w !== null);
  const global_mean_known = known_wholesale.length > 0
    ? known_wholesale.reduce((s, w) => s + w, 0) / known_wholesale.length
    : null;

  // Ofgem cap for last-resort imputation (calibrated path: VAT-inclusive; use 24.50 VAT-inc equivalent)
  const impute_cap = OFGEM_CAP_ELEC_BY_QUARTER[quarterKey(new Date())];

  let warnedGasGap  = false;
  let warnedElecGap = false;

  for (let i = 0; i < n; i++) {
    const tsDate = new Date(consumption[i].timestamp);

    // HH electricity rate — Agile D×W+P formula
    const wholesale = wholesale_array[i];
    const peak      = isUkPeakHour(tsDate);
    let w;
    if (wholesale === null) {
      w = imputeWholesaleForSlot(i, wholesale_array, global_mean_known, D, impute_cap);
    } else {
      w = wholesale;
    }
    // Math.min(negative, cap) returns the negative unchanged — negatives are preserved.
    // Calibrated: D absorbs VAT, cap 100p. Table/national: VAT-exclusive, cap 95p then ×1.05.
    const rawRate = D * w + (peak ? P_peak_p_kwh : 0);
    hh_rate[i] = isCalibrated
      ? Math.min(rawRate, 100)
      : Math.min(rawRate, 95) * 1.05;

    // Gas rate per HH
    const gasFromTariff = getRateForTs(tsDate, gasWindows);
    if (gasFromTariff !== null) {
      gas_rate[i] = gasFromTariff;
    } else {
      if (gasWindows.length > 0 && !warnedGasGap) {
        console.warn('Gap in gas tariff history — using Ofgem cap quarterly default for affected periods.');
        warnedGasGap = true;
      }
      gas_rate[i] = OFGEM_CAP_GAS_BY_QUARTER[quarterKey(tsDate)];
    }

    // Flat electricity rate per HH (for dumb_hp_svt / §14 base)
    const elecFromTariff = getRateForTs(tsDate, elecWindows);
    if (elecFromTariff !== null) {
      flat_rate[i] = elecFromTariff;
    } else {
      if (elecWindows.length > 0 && !warnedElecGap) {
        console.warn('Gap in electricity tariff history — using Ofgem cap quarterly default for affected periods.');
        warnedElecGap = true;
      }
      flat_rate[i] = OFGEM_CAP_ELEC_BY_QUARTER[quarterKey(tsDate)];
    }
  }

  // Standing charges: m1 actual → regional → national default
  const m1GasStanding  = gasWindows[gasWindows.length - 1]?.standing_p_day  ?? null;
  const m1ElecStanding = elecWindows[elecWindows.length - 1]?.standing_p_day ?? null;
  const regionalRow    = gsp_region ? (REGIONAL_STANDING_CHARGES[gsp_region] ?? null) : null;
  const standing_charge = {
    gas:  m1GasStanding  ?? (regionalRow?.gas  ?? NATIONAL_GAS_STANDING_DEFAULT),
    elec: m1ElecStanding ?? (regionalRow?.elec ?? NATIONAL_ELEC_STANDING_DEFAULT),
  };

  // null_wholesale_fraction and coverage warnings
  const totalSlots = n;
  const nullSlots  = wholesale_array.filter(w => w === null).length;
  const null_wholesale_fraction = totalSlots > 0 ? nullSlots / totalSlots : 1.0;
  const non_null_wholesale_count = totalSlots - nullSlots;

  const coverage_warnings = [];
  if (null_wholesale_fraction > 0.25) {
    coverage_warnings.push(
      `Half-hourly price data was missing for ${(null_wholesale_fraction * 100).toFixed(0)}% of your data period — half-hourly tariff results may be unreliable.`
    );
  } else if (null_wholesale_fraction > 0.05) {
    coverage_warnings.push(
      `Wholesale price data was missing for ${(null_wholesale_fraction * 100).toFixed(0)}% of your data period. Half-hourly tariff scenarios use a typical-rate estimate for those periods.`
    );
  }

  return { hh_rate, gas_rate, flat_rate, standing_charge, null_wholesale_fraction, coverage_warnings, non_null_wholesale_count };
}


// ===== Step 8: Alignment (weather-only; wholesale is M2-internal) =====

export function alignExternalData(consumption, weatherMap) {
  return consumption.map(({ timestamp }) => {
    const tsCanonical = canonicaliseTs(timestamp);
    const hourCanonical = DateTime.fromISO(tsCanonical, { zone: 'utc' })
      .startOf('hour')
      .toISO({ suppressMilliseconds: true });
    const weather = weatherMap.get(hourCanonical);
    return {
      timestamp:  tsCanonical,
      temp_c:     weather?.temperature_2m    ?? null,
      solar_w_m2: weather?.shortwave_radiation ?? null,
      // wholesale_p_kwh removed: M2-internal only (design §2.5.8)
    };
  });
}


// ===== Step 9: Metadata assembly =====

export function buildExternalMetadata(latitude, longitude, elevation, weatherSource, priceSource, priceWarnings, coverage_warnings) {
  return {
    latitude,
    longitude,
    elevation_m: elevation,
    weather_source: weatherSource,
    price_source: priceSource,
    price_alignment_warnings: priceWarnings,
    coverage_warnings: coverage_warnings ?? [],
    fetch_timestamp: new Date().toISOString(),
    // agile_calibration is now a top-level field on the M2 result, not inside metadata
  };
}
