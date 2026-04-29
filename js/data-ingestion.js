// ===== Data Ingestion Module =====
// Octopus Energy API client, CSV parser, normalisation, validation.
// All timestamps are ISO 8601 UTC internally.

export const CONFIG = {
  OCTOPUS_BASE_URL: 'https://api.octopus.energy/v1',
  POSTCODES_BASE_URL: 'https://api.postcodes.io/postcodes',
  DEFAULT_POSTCODE: 'CV35 0AA',
  DEFAULT_GAS_RATE_P_KWH: 5.7,
  DEFAULT_ELEC_RATE_P_KWH: 24.5,
  DEFAULT_GAS_STANDING_P_DAY: 31.4,
  DEFAULT_ELEC_STANDING_P_DAY: 61.6,
  GAS_VOLUME_CORRECTION: 1.02264,
  GAS_CALORIFIC_VALUE_MJ: 39.5,
  GAS_M3_TO_KWH: 11.19,
  CONSUMPTION_PAGE_SIZE: 25000,
  TARIFF_PAGE_SIZE: 1500,
  LOOKBACK_MS: 365 * 24 * 60 * 60 * 1000,
  MIN_DAYS_FOR_ANALYSIS: 30,
  WARNING_DAYS_THRESHOLD: 90,
  GAP_WARNING_PERCENTAGE: 10,
  HH_INTERVAL_MS: 30 * 60 * 1000,
};

const VALID_GSP_REGIONS = ['A','B','C','D','E','F','G','H','J','K','L','M','N','P'];

// ===== Shared state =====
let _ingestionResult = null;
export function setIngestionResult(result) { _ingestionResult = result; }
export function getIngestionResult() { return _ingestionResult; }


// ===== Helpers =====

function authHeader(apiKey) {
  return 'Basic ' + btoa(apiKey + ':');
}

async function fetchAllPages(url, headers = {}, onProgress = null) {
  const results = [];
  let nextUrl = url;
  let page = 0;
  while (nextUrl) {
    page++;
    if (onProgress) onProgress(page);
    const resp = await fetch(nextUrl, { headers });
    if (!resp.ok) {
      throw { status: resp.status, response: resp };
    }
    const data = await resp.json();
    results.push(...data.results);
    nextUrl = data.next;
  }
  return { results, pages: page };
}


function selectNewestMeter(meters) {
  return [...meters].sort((a, b) => {
    const aDate = new Date(a.install_date || a.effective_from || 0).getTime();
    const bDate = new Date(b.install_date || b.effective_from || 0).getTime();
    return bDate - aDate;
  })[0];
}


// ===== Step 3: Account Discovery =====

export async function fetchAccount(apiKey, accountNumber) {
  const url = `${CONFIG.OCTOPUS_BASE_URL}/accounts/${accountNumber}/`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: { 'Authorization': authHeader(apiKey) }
    });
  } catch (e) {
    throw new Error('Could not reach the Octopus API. Check your internet connection and try again.');
  }

  if (resp.status === 401) {
    throw new Error('API key not recognised. Check your key at octopus.energy/dashboard.');
  }
  if (resp.status === 404) {
    throw new Error('Account not found. Check the format: A-XXXXABCD.');
  }
  if (resp.status === 429) {
    throw new Error('Octopus API is busy. Wait a moment and try again.');
  }
  if (!resp.ok) {
    throw new Error(`Unexpected error from Octopus API (${resp.status}). Try again later.`);
  }

  const account = await resp.json();
  const properties = [];

  for (const prop of account.properties) {
    const elecPoints = prop.electricity_meter_points || [];
    const gasPoints = prop.gas_meter_points || [];

    const elecPoint = elecPoints[0];
    const gasPoint = gasPoints[0];

    let mpan = null, elecSerial = null, elecMeters = [], elecAgreements = [];
    if (elecPoint) {
      mpan = elecPoint.mpan;
      elecMeters = elecPoint.meters || [];
      if (elecMeters.length > 1) {
        console.log('Multiple electricity meters found:', elecMeters.map(m => m.serial_number));
      }
      elecSerial = elecMeters.length > 0 ? selectNewestMeter(elecMeters).serial_number : null;
      elecAgreements = elecPoint.agreements || [];
    }

    let gsp_region = null;
    if (elecAgreements.length > 0) {
      const latestAgreement = elecAgreements.reduce((best, a) =>
        (new Date(a.valid_from) > new Date(best.valid_from)) ? a : best
      );
      const lastChar = (latestAgreement.tariff_code ?? '').slice(-1).toUpperCase();
      gsp_region = VALID_GSP_REGIONS.includes(lastChar) ? lastChar : null;
    }

    let mprn = null, gasSerial = null, gasMeters = [], gasAgreements = [];
    if (gasPoint) {
      mprn = gasPoint.mprn;
      gasMeters = gasPoint.meters || [];
      if (gasMeters.length > 1) {
        console.log('Multiple gas meters found:', gasMeters.map(m => m.serial_number));
      }
      gasSerial = gasMeters.length > 0 ? selectNewestMeter(gasMeters).serial_number : null;
      gasAgreements = gasPoint.agreements || [];
    }

    properties.push({
      mpan,
      mprn,
      elecSerial,
      gasSerial,
      elecMeters,
      gasMeters,
      postcode: prop.postcode || null,
      address: prop.address_line_1 || prop.postcode || 'Unknown address',
      elecAgreements,
      gasAgreements,
      gsp_region,
    });
  }

  if (properties.length === 0) {
    throw new Error('No properties found on this account.');
  }

  return { properties };
}


// ===== Step 4: Consumption Retrieval =====

export async function fetchConsumption(apiKey, mpan, mprn, elecSerial, gasSerial) {
  const periodTo = new Date();
  const periodFrom = new Date(Date.now() - CONFIG.LOOKBACK_MS);
  periodFrom.setUTCHours(0, 0, 0, 0);

  const fromStr = periodFrom.toISOString();
  const toStr = periodTo.toISOString();
  const headers = { 'Authorization': authHeader(apiKey) };

  const fetches = [];

  if (mpan && elecSerial) {
    const elecUrl = `${CONFIG.OCTOPUS_BASE_URL}/electricity-meter-points/${mpan}/meters/${elecSerial}/consumption/?period_from=${fromStr}&period_to=${toStr}&page_size=${CONFIG.CONSUMPTION_PAGE_SIZE}&order_by=period`;
    fetches.push(fetchAllPages(elecUrl, headers).then(r => r.results));
  } else {
    fetches.push(Promise.resolve([]));
  }

  if (mprn && gasSerial) {
    const gasUrl = `${CONFIG.OCTOPUS_BASE_URL}/gas-meter-points/${mprn}/meters/${gasSerial}/consumption/?period_from=${fromStr}&period_to=${toStr}&page_size=${CONFIG.CONSUMPTION_PAGE_SIZE}&order_by=period`;
    fetches.push(fetchAllPages(gasUrl, headers).then(r => r.results));
  } else {
    fetches.push(Promise.resolve([]));
  }

  const [elecRecords, gasRecords] = await Promise.all(fetches);

  if (elecRecords.length === 0 && gasRecords.length === 0) {
    throw new Error('No half-hourly data found. This tool requires a smart meter (SMETS1 or SMETS2).');
  }

  return { elecRecords, gasRecords };
}


// ===== Step 5: Gas Unit Sanity Check =====

export function buildGasUnitCheck(gasRecords, gasRatePKwh) {
  if (!gasRecords || gasRecords.length === 0) {
    return null;
  }

  // Group by month
  const byMonth = new Map();
  for (const rec of gasRecords) {
    const d = new Date(rec.interval_start);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(rec.consumption);
  }

  // Find a summer month (Jul=7, Aug=8) and a winter month (Jan=1, Dec=12)
  const summerMonths = [];
  const winterMonths = [];
  for (const [key, values] of byMonth) {
    const month = parseInt(key.split('-')[1], 10);
    if (month === 7 || month === 8) summerMonths.push({ key, values });
    if (month === 1 || month === 12) winterMonths.push({ key, values });
  }

  function calcDailyStats(monthData) {
    if (!monthData || monthData.values.length === 0) return null;
    const totalKwh = monthData.values.reduce((sum, v) => sum + v, 0);
    const days = monthData.values.length / 48;
    if (days < 1) return null;
    const dailyKwh = totalKwh / days;
    const dailyCost = gasRatePKwh != null ? (dailyKwh * gasRatePKwh) / 100 : null;
    return { dailyKwh, dailyCost };
  }

  const summer = summerMonths.length > 0 ? summerMonths[summerMonths.length - 1] : null;
  const winter = winterMonths.length > 0 ? winterMonths[winterMonths.length - 1] : null;

  const summerStats = calcDailyStats(summer);
  const winterStats = calcDailyStats(winter);

  function monthName(key) {
    if (!key) return '—';
    const [y, m] = key.split('-');
    const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${names[parseInt(m, 10)]} ${y}`;
  }

  return {
    summerDailyKwh: summerStats?.dailyKwh ?? null,
    summerDailyCost: summerStats?.dailyCost ?? null,
    winterDailyKwh: winterStats?.dailyKwh ?? null,
    winterDailyCost: winterStats?.dailyCost ?? null,
    summerMonth: monthName(summer?.key),
    winterMonth: monthName(winter?.key),
  };
}

export function convertM3ToKwh(records) {
  return records.map(rec => ({
    ...rec,
    consumption: rec.consumption * CONFIG.GAS_M3_TO_KWH,
  }));
}


// ===== Step 6: Tariff Rate Extraction =====

const PRODUCT_CODE_RE = /^[EG]-1R-(.+)-[A-P]$/;

function deriveProductCode(tariffCode) {
  const match = tariffCode.match(PRODUCT_CODE_RE);
  if (!match) {
    console.warn('Could not derive product code from tariff code:', tariffCode);
    return null;
  }
  return match[1];
}

function classifyTariffType(productCode) {
  if (!productCode) return 'other';
  if (productCode.startsWith('VAR-')) return 'svt';
  if (productCode.startsWith('FIX-')) return 'fixed';
  if (productCode.startsWith('AGILE-')) return 'agile';
  if (productCode.startsWith('TRACKER-')) return 'tracker';
  if (productCode.startsWith('GO-')) return 'go';
  if (productCode.startsWith('COSY-')) return 'cosy';
  console.log('Unknown tariff product code prefix:', productCode);
  return 'other';
}

export async function buildTariffTimeline(agreements, fuelType, paymentMethod, dataStart, dataEnd, onProgress) {
  // fuelType: 'electricity' or 'gas'
  // paymentMethod: 'DIRECT_DEBIT' or 'NON_DIRECT_DEBIT'
  // dataStart/dataEnd: clamp query window to actual data span to avoid 400 on dated products
  const tariffPrefix = fuelType === 'electricity' ? 'electricity-tariffs' : 'gas-tariffs';
  const allRates = [];

  for (const agreement of agreements) {
    const tariffCode = agreement.tariff_code;
    const productCode = deriveProductCode(tariffCode);
    if (!productCode) continue;

    const tariffType = classifyTariffType(productCode);
    const validFrom = agreement.valid_from;
    const validTo = agreement.valid_to || new Date().toISOString();

    // Clamp query window to data span so dated SVT products don't return 400
    const qFrom = new Date(Math.max(new Date(validFrom).getTime(), new Date(dataStart).getTime())).toISOString();
    const qTo   = new Date(Math.min(new Date(validTo).getTime(), new Date(dataEnd).getTime())).toISOString();
    if (new Date(qFrom) >= new Date(qTo)) continue;

    // Fetch unit rates
    const ratesUrl = `${CONFIG.OCTOPUS_BASE_URL}/products/${productCode}/${tariffPrefix}/${tariffCode}/standard-unit-rates/?period_from=${qFrom}&period_to=${qTo}&page_size=${CONFIG.TARIFF_PAGE_SIZE}`;
    let rateResults;
    try {
      const rateData = await fetchAllPages(ratesUrl, {}, onProgress);
      rateResults = rateData.results;
    } catch (e) {
      // If direct debit returns empty/error, retry with non-direct-debit
      if (paymentMethod === 'DIRECT_DEBIT') {
        return buildTariffTimeline(agreements, fuelType, 'NON_DIRECT_DEBIT', dataStart, dataEnd, onProgress);
      }
      console.error('Failed to fetch tariff rates for', tariffCode, e);
      throw new Error('Could not retrieve tariff rates for this agreement. This may be a tariff type the tool does not yet support.');
    }

    // Filter by payment method
    let filteredRates = rateResults.filter(r => r.payment_method === paymentMethod || !r.payment_method);
    if (filteredRates.length === 0 && paymentMethod === 'DIRECT_DEBIT') {
      // Retry with NON_DIRECT_DEBIT
      return buildTariffTimeline(agreements, fuelType, 'NON_DIRECT_DEBIT', dataStart, dataEnd, onProgress);
    }
    if (filteredRates.length === 0) {
      console.warn('No rates after payment method filter for', tariffCode);
      continue;
    }

    // Fetch standing charges
    const standingUrl = `${CONFIG.OCTOPUS_BASE_URL}/products/${productCode}/${tariffPrefix}/${tariffCode}/standing-charges/?period_from=${qFrom}&period_to=${qTo}&page_size=${CONFIG.TARIFF_PAGE_SIZE}`;
    let standingResults = [];
    try {
      const standingData = await fetchAllPages(standingUrl);
      standingResults = standingData.results.filter(r => r.payment_method === paymentMethod || !r.payment_method);
      if (standingResults.length === 0) {
        // Try without payment method filter
        standingResults = (await fetchAllPages(standingUrl)).results;
      }
    } catch (e) {
      console.warn('Failed to fetch standing charges for', tariffCode, '— using 0');
    }

    // Pair each unit rate with the overlapping standing charge
    for (const rate of filteredRates) {
      const rateFrom = new Date(rate.valid_from);
      const rateTo = rate.valid_to ? new Date(rate.valid_to) : new Date();

      // Find standing charge whose window overlaps this rate
      let standingPDay = 0;
      for (const sc of standingResults) {
        const scFrom = new Date(sc.valid_from);
        const scTo = sc.valid_to ? new Date(sc.valid_to) : new Date();
        if (scFrom < rateTo && scTo > rateFrom) {
          standingPDay = sc.value_inc_vat;
          break;
        }
      }

      allRates.push({
        valid_from: rate.valid_from,
        valid_to: rate.valid_to,
        rate_p_kwh: rate.value_inc_vat,
        standing_p_day: standingPDay,
        tariff_type: tariffType,
        product_code: productCode,
      });
    }
  }

  // Sort chronologically
  allRates.sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));

  // Log any gaps
  for (let i = 1; i < allRates.length; i++) {
    const prevTo = allRates[i - 1].valid_to;
    const currFrom = allRates[i].valid_from;
    if (prevTo && currFrom && new Date(prevTo) < new Date(currFrom)) {
      console.warn('Tariff rate gap:', prevTo, 'to', currFrom);
    }
  }

  return allRates;
}


// ===== Step 10: CSV Parsing =====

function londonToUtc(dateStr) {
  // Parse a naive datetime string as Europe/London and return UTC ISO string.
  // Uses Intl to detect the offset for the given date in Europe/London.
  const parts = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!parts) return null;

  const [, year, month, day, hour, minute, second] = parts;
  const sec = second || '00';

  // Build a Date assuming UTC, then use Intl to find London's offset at that moment
  const utcGuess = new Date(`${year}-${month}-${day}T${hour}:${minute}:${sec}Z`);

  // Get London's UTC offset at this moment
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const londonParts = formatter.formatToParts(utcGuess);
  const lp = {};
  for (const p of londonParts) lp[p.type] = p.value;
  const londonDate = new Date(`${lp.year}-${lp.month}-${lp.day}T${lp.hour}:${lp.minute}:${lp.second}Z`);
  const offsetMs = londonDate.getTime() - utcGuess.getTime();

  // The actual UTC time = naive time - offset
  const actualUtc = new Date(utcGuess.getTime() - offsetMs);

  // Verify round-trip: converting actualUtc back to London should give us the original values
  const checkParts = formatter.formatToParts(actualUtc);
  const cp = {};
  for (const p of checkParts) cp[p.type] = p.value;

  if (cp.hour !== hour || cp.minute !== minute || cp.day !== day) {
    // Spring gap: the local time doesn't exist
    return { error: 'spring_gap' };
  }

  return actualUtc.toISOString();
}

export function parseCSV(fileContent) {
  const lines = fileContent.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const errors = [];

  if (lines.length === 0) {
    errors.push("CSV file is empty.");
    return { records: [], errors };
  }

  // Validate header
  const headerLine = lines[0].toLowerCase().replace(/\s/g, '');
  if (headerLine !== 'datetime,gas_kwh,electricity_kwh') {
    errors.push("CSV format doesn't match the template. Expected columns: datetime, gas_kwh, electricity_kwh.");
    return { records: [], errors };
  }

  const records = [];
  const utcTimestampMap = new Map(); // track duplicates for autumn clock change

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1;
    const fields = lines[i].split(',');

    if (fields.length !== 3) {
      errors.push(`Row ${rowNum}: expected 3 columns, found ${fields.length}.`);
      continue;
    }

    const rawTimestamp = fields[0].trim();
    const rawGas = fields[1].trim();
    const rawElec = fields[2].trim();

    // Parse timestamp
    let utcIso;
    if (rawTimestamp.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(rawTimestamp)) {
      // Explicit timezone — honour it
      const d = new Date(rawTimestamp);
      if (isNaN(d.getTime())) {
        errors.push(`Row ${rowNum}: timestamp "${rawTimestamp}" is not a valid date.`);
        continue;
      }
      utcIso = d.toISOString();
    } else {
      // Assume Europe/London
      const result = londonToUtc(rawTimestamp);
      if (result === null) {
        errors.push(`Row ${rowNum}: timestamp "${rawTimestamp}" is not a valid date format. Use YYYY-MM-DD HH:MM.`);
        continue;
      }
      if (result.error === 'spring_gap') {
        errors.push(`Timestamp at row ${rowNum} falls in the spring clock-forward gap and is invalid.`);
        continue;
      }
      utcIso = result;
    }

    // Validate HH interval (00 or 30 minutes)
    const mins = new Date(utcIso).getUTCMinutes();
    if (mins !== 0 && mins !== 30) {
      errors.push("Timestamps must be at half-hour intervals (e.g. 09:00, 09:30, 10:00).");
      continue;
    }

    // Check for autumn clock-change duplicates — reject both rows
    if (utcTimestampMap.has(utcIso)) {
      const prevRow = utcTimestampMap.get(utcIso);
      errors.push(`Rows ${prevRow} and ${rowNum} resolve to the same UTC timestamp (autumn clock change). Please resolve the ambiguity in your CSV.`);
      // Remove the first row's record too
      const idx = records.findIndex(r => r.interval_start === utcIso);
      if (idx !== -1) records.splice(idx, 1);
      continue;
    }
    utcTimestampMap.set(utcIso, rowNum);

    // Parse consumption values
    const gasKwh = parseFloat(rawGas);
    const elecKwh = parseFloat(rawElec);

    if (isNaN(gasKwh) || isNaN(elecKwh)) {
      errors.push(`Row ${rowNum}: gas_kwh and electricity_kwh must be numbers.`);
      continue;
    }

    if (gasKwh < 0) {
      errors.push(`Negative consumption value at row ${rowNum}. Check your data — consumption should be ≥ 0.`);
      continue;
    }
    if (elecKwh < 0) {
      errors.push(`Negative consumption value at row ${rowNum}. Check your data — consumption should be ≥ 0.`);
      continue;
    }

    records.push({
      interval_start: utcIso,
      gas_kwh: gasKwh,
      elec_kwh: elecKwh,
    });
  }

  // Minimum data check
  if (records.length > 0 && errors.length === 0) {
    const timestamps = records.map(r => new Date(r.interval_start).getTime());
    const rangeMs = Math.max(...timestamps) - Math.min(...timestamps);
    const rangeDays = rangeMs / (24 * 60 * 60 * 1000);
    if (rangeDays < CONFIG.MIN_DAYS_FOR_ANALYSIS) {
      errors.push(`Only ${Math.round(rangeDays)} days of data. At least ${CONFIG.MIN_DAYS_FOR_ANALYSIS} days needed for a meaningful analysis.`);
    }
  }

  return { records, errors };
}


// ===== Step 11: Postcode Validation =====

export async function validatePostcode(postcode) {
  const trimmed = postcode.trim().replace(/\s+/g, '+');
  const url = `${CONFIG.POSTCODES_BASE_URL}/${trimmed}`;

  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    return { valid: false, error: 'Could not reach the postcode lookup service. Check your internet connection.' };
  }

  if (resp.status === 404) {
    return { valid: false, error: 'Postcode not recognised. Check the format (e.g. SW1A 1AA) and try again.' };
  }

  if (!resp.ok) {
    return { valid: false, error: 'Postcode lookup failed. Try again.' };
  }

  const data = await resp.json();
  return {
    valid: true,
    lat: data.result.latitude,
    lon: data.result.longitude,
  };
}


// ===== Step 13: Meter Replacement Stitching =====

function inferGasUnit(records) {
  const summerRecs = records.filter(r => {
    const m = new Date(r.interval_start).getUTCMonth() + 1;
    return m === 7 || m === 8;
  });
  if (summerRecs.length < 48) return { unit: 'kwh', summerMedian: null, summerMaxDay: null };
  const byDay = new Map();
  for (const r of summerRecs) {
    const d = r.interval_start.slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + r.consumption);
  }
  const vals = [...byDay.values()];
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const maxDay = Math.max(...vals);
  // Two-point rule: both median < 2.5 AND max-day < 5 required to classify as m³.
  // Prevents misclassifying gas-cooking-only or small-flat kWh households.
  return { unit: (median < 2.5 && maxDay < 5) ? 'm3' : 'kwh', summerMedian: median, summerMaxDay: maxDay };
}

export async function fetchConsumptionStitched(apiKey, mpan, mprn, meters, fuelType) {
  const periodTo = new Date();
  const periodFrom = new Date(Date.now() - CONFIG.LOOKBACK_MS);
  periodFrom.setUTCHours(0, 0, 0, 0);

  const fromStr = periodFrom.toISOString();
  const toStr = periodTo.toISOString();
  const headers = { 'Authorization': authHeader(apiKey) };

  const buildMeterUrl = (serial) => {
    const meterPoint = fuelType === 'electricity'
      ? `electricity-meter-points/${mpan}`
      : `gas-meter-points/${mprn}`;
    return `${CONFIG.OCTOPUS_BASE_URL}/${meterPoint}/meters/${serial}/consumption/?period_from=${fromStr}&period_to=${toStr}&page_size=${CONFIG.CONSUMPTION_PAGE_SIZE}&order_by=period`;
  };

  // Tier 1: Check if newest meter alone covers ≥90% of the lookback window
  const newestMeter = selectNewestMeter(meters);
  let newestData = { results: [] };
  try {
    newestData = await fetchAllPages(buildMeterUrl(newestMeter.serial_number), headers);
  } catch (e) {
    console.warn(`No data from newest meter ${newestMeter.serial_number} (${fuelType})`);
  }

  if (newestData.results.length > 0) {
    const ts = newestData.results.map(r => new Date(r.interval_start).getTime());
    const spanMs = Math.max(...ts) - Math.min(...ts);
    if (spanMs >= 0.9 * CONFIG.LOOKBACK_MS) {
      const sorted = [...newestData.results].sort(
        (a, b) => new Date(a.interval_start) - new Date(b.interval_start)
      );
      if (fuelType === 'gas') {
        const { unit } = inferGasUnit(sorted);
        console.info(`Tier 1 meter (gas): unit=${unit}`);
        return {
          records: sorted,
          serialsUsed: [newestMeter.serial_number],
          metersStitched: false,
          gasUnitSource: null,
          detectedUnit: unit,
        };
      }
      return {
        records: sorted,
        serialsUsed: [newestMeter.serial_number],
        metersStitched: false,
        gasUnitSource: null,
        detectedUnit: null,
      };
    }
  }

  // Tier 2: Stitch all meters with per-meter unit detection for gas
  const allRecords = [];
  const serialsUsed = [];
  let anyM3Detected = false;

  for (const meter of meters) {
    try {
      const data = await fetchAllPages(buildMeterUrl(meter.serial_number), headers);
      if (data.results.length > 0) {
        if (fuelType === 'gas') {
          const { unit, summerMedian, summerMaxDay } = inferGasUnit(data.results);
          console.info(`Meter ${meter.serial_number} (gas): unit=${unit}, summer median=${summerMedian?.toFixed(2)}, summer max-day=${summerMaxDay?.toFixed(2)}`);
          const converted = unit === 'm3' ? convertM3ToKwh(data.results) : data.results;
          if (unit === 'm3') anyM3Detected = true;
          allRecords.push(...converted);
        } else {
          allRecords.push(...data.results);
        }
        serialsUsed.push(meter.serial_number);
      }
    } catch (e) {
      console.warn(`No data from meter ${meter.serial_number} (${fuelType})`);
    }
  }

  // Deduplicate by interval_start (prefer later meter's data)
  const byTimestamp = new Map();
  for (const rec of allRecords) {
    byTimestamp.set(rec.interval_start, rec);
  }

  const stitched = [...byTimestamp.values()].sort(
    (a, b) => new Date(a.interval_start) - new Date(b.interval_start)
  );

  return {
    records: stitched,
    serialsUsed,
    metersStitched: serialsUsed.length > 1,
    gasUnitSource: fuelType === 'gas' && anyM3Detected ? 'm3_converted_per_meter' : null,
  };
}


// ===== Step 7: Normalisation =====

export function normaliseConsumption(elecRecords, gasRecords, dataStart, dataEnd) {
  const startMs = new Date(dataStart).getTime();
  const endMs = new Date(dataEnd).getTime();

  // Build Maps for O(1) lookup
  const elecMap = new Map();
  for (const rec of elecRecords) {
    elecMap.set(new Date(rec.interval_start).toISOString(), rec.consumption);
  }
  const gasMap = new Map();
  for (const rec of gasRecords) {
    gasMap.set(new Date(rec.interval_start).toISOString(), rec.consumption);
  }

  const consumption = [];
  let gapCount = 0;
  let expectedPeriods = 0;

  for (let ts = startMs; ts < endMs; ts += CONFIG.HH_INTERVAL_MS) {
    expectedPeriods++;
    const isoStr = new Date(ts).toISOString();

    const elecVal = elecMap.has(isoStr) ? elecMap.get(isoStr) : null;
    const gasVal = gasMap.has(isoStr) ? gasMap.get(isoStr) : null;

    if (elecVal === null && gasVal === null) gapCount++;

    consumption.push({
      timestamp: isoStr,
      gas_kwh: gasVal,
      elec_kwh: elecVal,
    });
  }

  const totalDays = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000));
  const gapPercentage = expectedPeriods > 0
    ? Math.round((gapCount / expectedPeriods) * 1000) / 10
    : 0;

  return {
    consumption,
    metadata: {
      data_start: new Date(startMs).toISOString(),
      data_end: new Date(endMs).toISOString(),
      total_days: totalDays,
      gap_count: gapCount,
      gap_percentage: gapPercentage,
      expected_periods: expectedPeriods,
    },
  };
}
