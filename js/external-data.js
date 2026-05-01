// ===== External Data Module =====
// Weather (Open-Meteo), wholesale prices (Elexon MID), postcode coordinates.
// Aligns all external series to the unified HH UTC timeline from data-ingestion.

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


// ===== Step 8: Alignment =====

export function alignExternalData(consumption, weatherMap, priceLookup) {
  return consumption.map(({ timestamp }) => {
    const tsCanonical = canonicaliseTs(timestamp);
    const hourCanonical = DateTime.fromISO(tsCanonical, { zone: 'utc' })
      .startOf('hour')
      .toISO({ suppressMilliseconds: true });

    const weather = weatherMap.get(hourCanonical);
    return {
      timestamp: tsCanonical,
      temp_c: weather?.temperature_2m ?? null,
      solar_w_m2: weather?.shortwave_radiation ?? null,
      wholesale_p_kwh: priceLookup.get(tsCanonical) ?? null,
    };
  });
}


// ===== Step 8b: Agile calibration =====

export async function fetchAgileCalibration(gsp_region) {
  if (!gsp_region) return null;

  const now            = new Date();
  const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const calibStart     = prevMonthStart >= AGILE_REFORM_DATE ? prevMonthStart : AGILE_REFORM_DATE;
  const calibEnd       = prevMonthStart >= AGILE_REFORM_DATE ? thisMonthStart : now;
  const isPartial      = prevMonthStart < AGILE_REFORM_DATE;

  if (calibEnd <= calibStart) return null;

  try {
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
    if (agileRates.length === 0) return null;

    const agileMap = new Map();
    for (const r of agileRates) {
      agileMap.set(new Date(r.valid_from).toISOString(), r.value_inc_vat);
    }

    const { priceLookup } = await fetchWholesalePrices(
      calibStart.toISOString(), calibEnd.toISOString(), () => {}
    );

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
    if (D_samples.length === 0) return null;

    const D = median(D_samples);
    const P_computed = P_samples.map(s => s.agile - D * s.wholesale);
    const P = P_computed.length > 0 ? median(P_computed) : 0;

    if (D < 1.5 || D > 3.0) console.warn(`Agile calibration D=${D.toFixed(3)} outside expected range 1.5–3.0`);
    if (P < 5 || P > 20)    console.warn(`Agile calibration P=${P.toFixed(2)} outside expected range 5–20 p/kWh`);

    const monthNames = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
    const calibPeriod = isPartial
      ? `${monthNames[calibStart.getUTCMonth()]} ${calibStart.getUTCFullYear()} (partial)`
      : `${monthNames[calibStart.getUTCMonth()]} ${calibStart.getUTCFullYear()}`;

    return { D, P_peak_p_kwh: P, calibration_period: calibPeriod, gsp_region };

  } catch (err) {
    console.error('Agile calibration fetch failed:', err);
    return null;
  }
}

// ===== Step 9: Metadata assembly =====

export function buildExternalMetadata(latitude, longitude, elevation, weatherSource, priceSource, priceWarnings, agile_calibration) {
  return {
    latitude,
    longitude,
    elevation_m: elevation,
    weather_source: weatherSource,
    price_source: priceSource,
    price_alignment_warnings: priceWarnings,
    fetch_timestamp: new Date().toISOString(),
    agile_calibration,
  };
}
