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

    let mpan = null, elecSerial = null, elecAgreements = [];
    if (elecPoint) {
      mpan = elecPoint.mpan;
      const meters = elecPoint.meters || [];
      if (meters.length > 1) {
        console.log('Multiple electricity meters found:', meters.map(m => m.serial_number));
      }
      elecSerial = meters.length > 0 ? meters[meters.length - 1].serial_number : null;
      elecAgreements = elecPoint.agreements || [];
    }

    let mprn = null, gasSerial = null, gasAgreements = [];
    if (gasPoint) {
      mprn = gasPoint.mprn;
      const meters = gasPoint.meters || [];
      if (meters.length > 1) {
        console.log('Multiple gas meters found:', meters.map(m => m.serial_number));
      }
      gasSerial = meters.length > 0 ? meters[meters.length - 1].serial_number : null;
      gasAgreements = gasPoint.agreements || [];
    }

    properties.push({
      mpan,
      mprn,
      elecSerial,
      gasSerial,
      postcode: prop.postcode || null,
      address: prop.address_line_1 || prop.postcode || 'Unknown address',
      elecAgreements,
      gasAgreements,
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

  function calcDailyCost(monthData) {
    if (!monthData || monthData.values.length === 0) return null;
    const totalKwh = monthData.values.reduce((sum, v) => sum + v, 0);
    const days = monthData.values.length / 48; // 48 HH periods per day
    if (days < 1) return null;
    const dailyKwh = totalKwh / days;
    return (dailyKwh * gasRatePKwh) / 100; // pence to pounds
  }

  const summer = summerMonths.length > 0 ? summerMonths[summerMonths.length - 1] : null;
  const winter = winterMonths.length > 0 ? winterMonths[winterMonths.length - 1] : null;

  const summerDailyCost = calcDailyCost(summer);
  const winterDailyCost = calcDailyCost(winter);

  function monthName(key) {
    if (!key) return '—';
    const [y, m] = key.split('-');
    const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${names[parseInt(m, 10)]} ${y}`;
  }

  return {
    summerDailyCost,
    winterDailyCost,
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

export async function buildTariffTimeline(agreements, fuelType, paymentMethod, onProgress) {
  // fuelType: 'electricity' or 'gas'
  // paymentMethod: 'DIRECT_DEBIT' or 'NON_DIRECT_DEBIT'
  const tariffPrefix = fuelType === 'electricity' ? 'electricity-tariffs' : 'gas-tariffs';
  const allRates = [];

  for (const agreement of agreements) {
    const tariffCode = agreement.tariff_code;
    const productCode = deriveProductCode(tariffCode);
    if (!productCode) continue;

    const tariffType = classifyTariffType(productCode);
    const validFrom = agreement.valid_from;
    const validTo = agreement.valid_to || new Date().toISOString();

    // Fetch unit rates
    const ratesUrl = `${CONFIG.OCTOPUS_BASE_URL}/products/${productCode}/${tariffPrefix}/${tariffCode}/standard-unit-rates/?period_from=${validFrom}&period_to=${validTo}&page_size=${CONFIG.TARIFF_PAGE_SIZE}`;
    let rateResults;
    try {
      const rateData = await fetchAllPages(ratesUrl, {}, onProgress);
      rateResults = rateData.results;
    } catch (e) {
      // If direct debit returns empty/error, retry with non-direct-debit
      if (paymentMethod === 'DIRECT_DEBIT') {
        return buildTariffTimeline(agreements, fuelType, 'NON_DIRECT_DEBIT', onProgress);
      }
      console.error('Failed to fetch tariff rates for', tariffCode, e);
      throw new Error('Could not retrieve tariff rates for this agreement. This may be a tariff type the tool does not yet support.');
    }

    // Filter by payment method
    let filteredRates = rateResults.filter(r => r.payment_method === paymentMethod || !r.payment_method);
    if (filteredRates.length === 0 && paymentMethod === 'DIRECT_DEBIT') {
      // Retry with NON_DIRECT_DEBIT
      return buildTariffTimeline(agreements, fuelType, 'NON_DIRECT_DEBIT', onProgress);
    }
    if (filteredRates.length === 0) {
      console.warn('No rates after payment method filter for', tariffCode);
      continue;
    }

    // Fetch standing charges
    const standingUrl = `${CONFIG.OCTOPUS_BASE_URL}/products/${productCode}/${tariffPrefix}/${tariffCode}/standing-charges/?period_from=${validFrom}&period_to=${validTo}&page_size=${CONFIG.TARIFF_PAGE_SIZE}`;
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


// ===== Step 7: Normalisation =====

export function normaliseConsumption(elecRecords, gasRecords, dataStart, dataEnd) {
  const startMs = new Date(dataStart).getTime();
  const endMs = new Date(dataEnd).getTime();

  // Build Maps for O(1) lookup
  const elecMap = new Map();
  for (const rec of elecRecords) {
    elecMap.set(rec.interval_start, rec.consumption);
  }
  const gasMap = new Map();
  for (const rec of gasRecords) {
    gasMap.set(rec.interval_start, rec.consumption);
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
