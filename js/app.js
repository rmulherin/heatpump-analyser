// ===== App Orchestration =====
// Wires UI events to data-ingestion functions.

import {
  CONFIG,
  fetchAccount,
  fetchConsumption,
  fetchConsumptionStitched,
  buildGasUnitCheck,
  convertM3ToKwh,
  buildTariffTimeline,
  normaliseConsumption,
  parseCSV,
  validatePostcode,
  setIngestionResult,
  getIngestionResult,
} from './data-ingestion.js';

import {
  lookupPostcode,
  fetchWeather,
  fetchWeatherFallback,
  fetchWholesalePrices,
  needsFallback,
  buildExpectedHours,
  alignExternalData,
  buildExternalMetadata,
  setExternalResult,
  getExternalResult,
} from './external-data.js';

import {
  separateBaseload,
  setBaseloadResult,
  getBaseloadResult,
} from './baseload.js';

import {
  estimateHeatLoss,
  setHeatLossResult,
  getHeatLossResult,
} from './heat-loss.js';

import {
  estimateThermalCharacter,
  setThermalCharacterResult,
  getThermalCharacterResult,
} from './thermal-character.js';

// ===== Module 3 — Label maps =====

const BASELOAD_METHOD_LABELS = {
  'summer-hh-profile-weekday-split': 'Summer weekday/weekend profile (best)',
  'summer-hh-profile-flat': 'Summer profile (no weekday/weekend split)',
  'summer-daily-flat': 'Summer daily average (limited summer data)',
  'balance-point': 'Warm-weather estimation (no summer data)',
  'literature-default': 'UK average estimate (insufficient data)',
  'no-gas': 'No gas supply detected',
};

const CONFIDENCE_LABELS = {
  'high': 'high confidence',
  'moderate': 'moderate confidence',
  'low': 'low confidence — treat with caution',
  'none': '',
};

// ===== Module 4 — Label maps =====

const HEAT_LOSS_RATING_DISPLAY = {
  'excellent': 'Excellent (very well insulated)',
  'good': 'Good',
  'average': 'Average',
  'poor': 'Poor',
  'very_poor': 'Very poor (poorly insulated)',
};

const SOLAR_RATING_DISPLAY = {
  'minimal': 'Minimal',
  'moderate': 'Moderate',
  'good': 'Good',
  'high': 'High',
  'very_high': 'Very high',
};

// ===== Module 5 — Label maps =====

const THERMAL_MASS_RATING_LABELS = {
  low:       'Low (lightweight — timber frame or thin construction)',
  medium:    'Medium (typical cavity-brick semi-detached)',
  high:      'High (solid brick — 1930s–1950s terrace or semi)',
  very_high: 'Very high (solid stone, large Victorian, concrete)',
};

// ===== DOM References =====
const apiKeyInput = document.getElementById('api-key');
const accountInput = document.getElementById('account-number');
const btnFetch = document.getElementById('btn-fetch');
const progressArea = document.getElementById('progress-area');
const progressText = document.getElementById('progress-text');
const progressBar = document.getElementById('progress-bar');
const statusArea = document.getElementById('status-area');
const propertySelection = document.getElementById('property-selection');
const propertyList = document.getElementById('property-list');
const btnConfirmProperty = document.getElementById('btn-confirm-property');
const gasCheckArea = document.getElementById('gas-check-area');
const gasCheckSummer = document.getElementById('gas-check-summer');
const gasCheckWinter = document.getElementById('gas-check-winter');
const gasCheckSummerMonth = document.getElementById('gas-check-summer-month');
const gasCheckWinterMonth = document.getElementById('gas-check-winter-month');
const gasM3Toggle = document.getElementById('gas-m3-toggle');
const btnGasConfirm = document.getElementById('btn-gas-confirm');
const resultsCard = document.getElementById('results-card');
const resultsSummary = document.getElementById('results-summary');

// CSV DOM references
const csvFileInput = document.getElementById('csv-file');
const csvPostcodeInput = document.getElementById('csv-postcode');
const csvGasRateInput = document.getElementById('csv-gas-rate');
const csvElecRateInput = document.getElementById('csv-elec-rate');
const csvGasStandingInput = document.getElementById('csv-gas-standing');
const csvElecStandingInput = document.getElementById('csv-elec-standing');
const btnCsvAnalyse = document.getElementById('btn-csv-analyse');
const csvPostcodeNote = document.getElementById('csv-postcode-note');
const csvProgressArea = document.getElementById('csv-progress-area');
const csvProgressText = document.getElementById('csv-progress-text');
const csvStatusArea = document.getElementById('csv-status-area');

// Energy summary DOM references
const energySummaryCard = document.getElementById('energy-summary-card');
const energySummaryContent = document.getElementById('energy-summary-content');

// Heat loss DOM references
const heatLossCard = document.getElementById('heat-loss-card');
const heatLossResults = document.getElementById('heat-loss-results');
const heatLossSummary = document.getElementById('heat-loss-summary');
const heatLossStatus = document.getElementById('heat-loss-status');
const boilerEfficiencyInput = document.getElementById('boiler-efficiency');
const floorAreaInput = document.getElementById('floor-area');
const btnRecalculateHeatLoss = document.getElementById('btn-recalculate-heat-loss');

// Thermal character DOM references
const thermalCharCard       = document.getElementById('thermal-char-card');
const thermalCharResults    = document.getElementById('thermal-char-results');
const thermalCharStatus     = document.getElementById('thermal-char-status');
const thermalCharSummary    = document.getElementById('thermal-char-summary');
const wallConstructionInput = document.getElementById('wall-construction');
const btnRecalcThermalChar  = document.getElementById('btn-recalculate-thermal-char');

// ===== Tab Switching =====
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabPanels.forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ===== UI Helpers =====

function showProgress(text, percent) {
  progressArea.classList.remove('hidden');
  progressText.textContent = text;
  if (percent !== undefined) {
    progressBar.style.width = `${percent}%`;
  }
}

function hideProgress() {
  progressArea.classList.add('hidden');
  progressBar.style.width = '0%';
}

function showStatus(message, type) {
  const div = document.createElement('div');
  div.className = `status-msg ${type}`;
  div.textContent = message;
  statusArea.appendChild(div);
}

function clearStatus() {
  statusArea.innerHTML = '';
}

function setFetchEnabled(enabled) {
  btnFetch.disabled = !enabled;
}

function formatPounds(value) {
  if (value === null || value === undefined) return '—';
  return `£${value.toFixed(2)}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== State =====
let fetchedProperties = null;
let selectedPropertyIndex = 0;
let fetchedElecRecords = null;
let fetchedGasRecords = null;
let currentGasRecords = null; // may be converted from m³
let detectedGasUnitSource = null; // set by Tier 2 per-meter detection; suppresses toggle

// ===== Main Fetch Flow =====

btnFetch.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const accountNumber = accountInput.value.trim();

  // Validation
  if (!apiKey) {
    showStatus('Please enter your API key.', 'error');
    return;
  }
  if (!accountNumber || !accountNumber.startsWith('A-')) {
    showStatus('Account number should start with A- (e.g. A-1234ABCD).', 'error');
    return;
  }

  clearStatus();
  hideProgress();
  propertySelection.classList.add('hidden');
  gasCheckArea.classList.add('hidden');
  resultsCard.classList.add('hidden');
  setFetchEnabled(false);

  try {
    // Step 1: Account discovery
    showProgress('Contacting Octopus…', 10);
    const accountData = await fetchAccount(apiKey, accountNumber);
    fetchedProperties = accountData.properties;

    if (fetchedProperties.length > 1) {
      // Show property selection UI
      showProgress('Select a property to continue.', 20);
      renderPropertySelection(fetchedProperties);
      setFetchEnabled(true);
      return; // Flow continues from btnConfirmProperty handler
    }

    // Single property — auto-select
    selectedPropertyIndex = 0;
    await continueWithProperty(apiKey);

  } catch (err) {
    hideProgress();
    showStatus(err.message, 'error');
    setFetchEnabled(true);
  }
});

// ===== Property Selection =====

function renderPropertySelection(properties) {
  propertyList.innerHTML = '';
  properties.forEach((prop, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <input type="radio" name="property" value="${i}" ${i === 0 ? 'checked' : ''}>
      <span>${escapeHtml(prop.address)} — ${escapeHtml(prop.postcode || 'No postcode')}</span>
    `;
    li.addEventListener('click', () => {
      li.querySelector('input').checked = true;
      propertyList.querySelectorAll('li').forEach(el => el.classList.remove('selected'));
      li.classList.add('selected');
    });
    if (i === 0) li.classList.add('selected');
    propertyList.appendChild(li);
  });
  propertySelection.classList.remove('hidden');
}

btnConfirmProperty.addEventListener('click', async () => {
  const selected = propertyList.querySelector('input[name="property"]:checked');
  selectedPropertyIndex = selected ? parseInt(selected.value, 10) : 0;
  propertySelection.classList.add('hidden');
  setFetchEnabled(false);

  try {
    await continueWithProperty(apiKeyInput.value.trim());
  } catch (err) {
    hideProgress();
    showStatus(err.message, 'error');
    setFetchEnabled(true);
  }
});

// ===== Continue After Property Selection =====

async function continueWithProperty(apiKey) {
  const prop = fetchedProperties[selectedPropertyIndex];

  detectedGasUnitSource = null;
  gasM3Toggle.checked = false;
  gasM3Toggle.disabled = false;

  // Step 2: Fetch consumption (with meter stitching if multiple meters)
  showProgress('Fetching consumption data…', 30);

  let elecRecords, gasRecords;
  let metersStitched = false;
  let serialsUsed = [];

  const hasMultipleElecMeters = prop.elecMeters.length > 1;
  const hasMultipleGasMeters = prop.gasMeters.length > 1;

  if (hasMultipleElecMeters || hasMultipleGasMeters) {
    // Meter stitching path
    const elecResult = hasMultipleElecMeters && prop.mpan
      ? await fetchConsumptionStitched(apiKey, prop.mpan, prop.mprn, prop.elecMeters, 'electricity')
      : null;
    const gasResult = hasMultipleGasMeters && prop.mprn
      ? await fetchConsumptionStitched(apiKey, prop.mpan, prop.mprn, prop.gasMeters, 'gas')
      : null;

    if (elecResult) {
      elecRecords = elecResult.records;
      if (elecResult.metersStitched) metersStitched = true;
      serialsUsed.push(...elecResult.serialsUsed);
    }
    if (gasResult) {
      gasRecords = gasResult.records;
      if (gasResult.metersStitched) metersStitched = true;
      serialsUsed.push(...gasResult.serialsUsed);
      if (gasResult.gasUnitSource) detectedGasUnitSource = gasResult.gasUnitSource;
    }

    // Fall back to single-meter fetch for fuels that didn't need stitching
    if (!elecResult && prop.mpan && prop.elecSerial) {
      const single = await fetchConsumption(apiKey, prop.mpan, null, prop.elecSerial, null);
      elecRecords = single.elecRecords;
    }
    if (!gasResult && prop.mprn && prop.gasSerial) {
      const single = await fetchConsumption(apiKey, null, prop.mprn, null, prop.gasSerial);
      gasRecords = single.gasRecords;
    }

    elecRecords = elecRecords || [];
    gasRecords = gasRecords || [];

    if (elecRecords.length === 0 && gasRecords.length === 0) {
      throw new Error('No half-hourly data found. This tool requires a smart meter (SMETS1 or SMETS2).');
    }
  } else {
    // Standard single-meter path
    const result = await fetchConsumption(
      apiKey, prop.mpan, prop.mprn, prop.elecSerial, prop.gasSerial
    );
    elecRecords = result.elecRecords;
    gasRecords = result.gasRecords;
  }

  fetchedElecRecords = elecRecords;
  fetchedGasRecords = gasRecords;
  currentGasRecords = gasRecords;

  // Step 3: Gas unit sanity check
  if (gasRecords.length > 0) {
    showProgress('Checking gas units…', 45);
    // Use the first available gas rate from their tariff, or fallback to default
    const gasRate = CONFIG.DEFAULT_GAS_RATE_P_KWH;
    const check = buildGasUnitCheck(gasRecords, gasRate);

    if (check) {
      gasCheckSummerMonth.textContent = check.summerMonth;
      gasCheckWinterMonth.textContent = check.winterMonth;
      if (check.summerDailyKwh !== null) {
        const costPart = check.summerDailyCost !== null ? ` ≈ ${formatPounds(check.summerDailyCost)}/day` : '/day';
        gasCheckSummer.textContent = `${check.summerDailyKwh.toFixed(1)} kWh${costPart}`;
      } else {
        gasCheckSummer.textContent = 'no summer data';
      }
      if (check.winterDailyKwh !== null) {
        const costPart = check.winterDailyCost !== null ? ` ≈ ${formatPounds(check.winterDailyCost)}/day` : '/day';
        gasCheckWinter.textContent = `${check.winterDailyKwh.toFixed(1)} kWh${costPart}`;
      } else {
        gasCheckWinter.textContent = 'no winter data';
      }
      if (detectedGasUnitSource === 'm3_converted_per_meter') {
        gasM3Toggle.checked = false;
        gasM3Toggle.disabled = true;
      }
      gasCheckArea.classList.remove('hidden');

      // Wait for user confirmation
      await waitForGasConfirmation();
    }
  }

  // Step 4: Fetch tariff rates (clamped to actual data span to avoid 400 on dated SVT products)
  showProgress('Fetching tariff rates…', 55);

  const allTimestampsForBounds = [
    ...fetchedElecRecords.map(r => r.interval_start),
    ...currentGasRecords.map(r => r.interval_start),
  ].sort();
  const dataStartBound = allTimestampsForBounds[0];
  const dataEndBound   = allTimestampsForBounds[allTimestampsForBounds.length - 1];

  let elecTariffRates = [];
  let gasTariffRates = [];

  if (prop.elecAgreements.length > 0) {
    showProgress('Fetching electricity tariff rates…', 60);
    elecTariffRates = await buildTariffTimeline(
      prop.elecAgreements, 'electricity', 'DIRECT_DEBIT', dataStartBound, dataEndBound,
      (page) => showProgress(`Fetching electricity tariff rates (page ${page})…`, 60)
    );
  }

  if (prop.gasAgreements.length > 0) {
    showProgress('Fetching gas tariff rates…', 75);
    gasTariffRates = await buildTariffTimeline(
      prop.gasAgreements, 'gas', 'DIRECT_DEBIT', dataStartBound, dataEndBound,
      (page) => showProgress(`Fetching gas tariff rates (page ${page})…`, 75)
    );
  }

  // Step 5: Normalise
  showProgress('Normalising data…', 90);

  const allTimestamps = [
    ...fetchedElecRecords.map(r => r.interval_start),
    ...currentGasRecords.map(r => r.interval_start),
  ].sort();

  if (allTimestamps.length === 0) {
    throw new Error('No consumption data to normalise.');
  }

  const dataStart = allTimestamps[0];
  const dataEnd = allTimestamps[allTimestamps.length - 1];

  const normalised = normaliseConsumption(
    fetchedElecRecords, currentGasRecords, dataStart, dataEnd
  );

  // Step 6: Data quality gate
  const meta = normalised.metadata;

  if (meta.total_days < CONFIG.MIN_DAYS_FOR_ANALYSIS) {
    hideProgress();
    showStatus(
      'At least 30 days of data needed for a meaningful analysis.',
      'error'
    );
    setFetchEnabled(true);
    return;
  }

  if (meta.total_days < CONFIG.WARNING_DAYS_THRESHOLD) {
    showStatus(
      'Less than 3 months of data. Seasonal analysis will be limited.',
      'warning'
    );
  }

  if (meta.gap_percentage > CONFIG.GAP_WARNING_PERCENTAGE) {
    showStatus(
      `Your data has significant gaps (${meta.gap_percentage}%). Results may be less accurate.`,
      'warning'
    );
  }

  // Step 7: Store result
  const tariffRates = {
    electricity: elecTariffRates,
    gas: gasTariffRates,
  };

  const fullMetadata = {
    ...meta,
    postcode: prop.postcode,
    postcode_source: 'octopus',
    mpan: prop.mpan,
    mprn: prop.mprn,
    gas_unit_source: detectedGasUnitSource || (gasM3Toggle.checked ? 'm3_converted' : 'kwh_native'),
    input_path: 'octopus',
    meters_stitched: metersStitched,
    serials_used: serialsUsed.length > 0 ? serialsUsed : undefined,
  };

  setIngestionResult({
    consumption: normalised.consumption,
    tariff_rates: tariffRates,
    metadata: fullMetadata,
  });

  // Step 8: Show success
  hideProgress();
  showSuccessSummary(normalised, tariffRates, fullMetadata);

  // Step 9: Trigger Module 2 — External Data
  await runExternalData(
    (text) => showProgress(text, undefined),
    (msg, type) => showStatus(msg, type)
  );

  // Step 10: Trigger Module 3 — Baseload Separation
  await runBaseloadSeparation(
    (text) => showProgress(text, undefined),
    (msg, type) => showStatus(msg, type)
  );

  // Step 11: Trigger Module 4 — Heat Loss Estimation
  await runHeatLoss(
    (text) => showProgress(text, undefined),
    (msg, type) => showStatus(msg, type)
  );

  // Step 12: Trigger Module 5 — Thermal Character
  await runThermalCharacter(
    (text) => showProgress(text, undefined),
    (msg, type) => showStatus(msg, type)
  );

  hideProgress();
  setFetchEnabled(true);
}

// ===== Gas Confirmation =====

function waitForGasConfirmation() {
  return new Promise((resolve) => {
    const handler = () => {
      if (detectedGasUnitSource === 'm3_converted_per_meter') {
        // Records already converted per-meter — toggle has no effect
        currentGasRecords = fetchedGasRecords;
      } else if (gasM3Toggle.checked) {
        currentGasRecords = convertM3ToKwh(fetchedGasRecords);
      } else {
        currentGasRecords = fetchedGasRecords;
      }
      gasCheckArea.classList.add('hidden');
      btnGasConfirm.removeEventListener('click', handler);
      resolve();
    };
    btnGasConfirm.addEventListener('click', handler);
  });
}

// ===== Success Summary =====

function showSuccessSummary(normalised, tariffRates, metadata) {
  const meta = metadata;
  const elecCount = normalised.consumption.filter(r => r.elec_kwh !== null).length;
  const gasCount = normalised.consumption.filter(r => r.gas_kwh !== null).length;
  const totalGasKwh = normalised.consumption.reduce((sum, r) => sum + (r.gas_kwh ?? 0), 0);

  // Detect tariff types
  const elecTypes = [...new Set(tariffRates.electricity.map(r => r.tariff_type))];
  const gasTypes = [...new Set(tariffRates.gas.map(r => r.tariff_type))];

  const formatDate = (iso) => {
    const d = new Date(iso);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };

  resultsSummary.innerHTML = `
    <dl>
      <dt>Date range</dt>
      <dd>${formatDate(meta.data_start)} — ${formatDate(meta.data_end)} (${meta.total_days} days)</dd>
      <dt>Electricity records</dt>
      <dd>${elecCount.toLocaleString()} half-hourly periods</dd>
      <dt>Gas records</dt>
      <dd>${gasCount.toLocaleString()} half-hourly periods</dd>
      <dt>Data gaps</dt>
      <dd>${meta.gap_count} missing periods (${meta.gap_percentage}%)</dd>
      <dt>Electricity tariff</dt>
      <dd>${elecTypes.length > 0 ? elecTypes.join(', ') : 'none detected'} (${tariffRates.electricity.length} rate windows)</dd>
      <dt>Gas tariff</dt>
      <dd>${gasTypes.length > 0 ? gasTypes.join(', ') : 'none detected'} (${tariffRates.gas.length} rate windows)</dd>
      <dt>Postcode</dt>
      <dd>${escapeHtml(meta.postcode || 'not available')}</dd>
      <dt>Total gas consumption</dt>
      <dd>${Math.round(totalGasKwh).toLocaleString()} kWh over ${meta.total_days} days
        <span style="display:block;font-size:0.85em;color:#666;margin-top:0.2em;">Compare to your annual figure in the Octopus app. Should be within ~5%. If the figure looks wrong, use the unit override above.</span></dd>
      <dt>Gas units</dt>
      <dd>${
        meta.gas_unit_source === 'm3_converted_per_meter'
          ? 'Converted from m³ (per-meter detection)'
          : meta.gas_unit_source === 'm3_converted'
          ? 'Converted from m³'
          : 'Native kWh'
      }</dd>
    </dl>
  `;

  resultsCard.classList.remove('hidden');
  showStatus('Data loaded successfully.', 'success');
}


// ===== Module 2: External Data Orchestration =====

async function runExternalData(showProgressFn, showStatusFn) {
  const ingestion = getIngestionResult();
  if (!ingestion) return;

  const { consumption, metadata } = ingestion;

  // Step 1: Determine coordinates — always via lookupPostcode
  showProgressFn('Looking up postcode coordinates…');
  let coords;
  try {
    coords = await lookupPostcode(metadata.postcode);
  } catch (e) {
    showStatusFn(e.message, 'error');
    return;
  }

  const { latitude, longitude, elevation_m } = coords;

  // Step 2: Fetch weather and prices in parallel
  showProgressFn('Fetching weather data and wholesale prices…');

  const [weatherResult, priceResult] = await Promise.allSettled([
    fetchWeather(latitude, longitude, metadata.data_start, metadata.data_end),
    fetchWholesalePrices(metadata.data_start, metadata.data_end,
      (pct) => showProgressFn(`Fetching price data… ${pct}%`)),
  ]);

  // Step 3: Handle results with asymmetric rejection
  // Weather failure blocks — it's essential for heat loss regression
  if (weatherResult.status === 'rejected') {
    showStatusFn(weatherResult.reason?.message || 'Weather data fetch failed. Cannot proceed with analysis.', 'error');
    return;
  }

  // Price failure warns — wholesale scenarios degrade gracefully
  let priceLookup = new Map();
  let priceSource = 'elexon-mid-n2ex';
  let priceWarnings = [];

  if (priceResult.status === 'rejected') {
    const msg = priceResult.reason?.message || 'Wholesale price fetch failed.';
    showStatusFn(msg + ' Wholesale price scenarios will be incomplete.', 'warning');
    priceWarnings.push(msg);
  } else {
    priceLookup = priceResult.value.priceLookup;
    priceSource = priceResult.value.source;
    priceWarnings = priceResult.value.warnings;
    const spCountWarnings = priceWarnings.filter(w => w.startsWith('Unexpected SP count'));
    const otherPriceWarnings = priceWarnings.filter(w => !w.startsWith('Unexpected SP count'));
    for (const w of otherPriceWarnings) {
      showStatusFn(w, 'warning');
    }
    if (spCountWarnings.length > 0) {
      for (const w of spCountWarnings) console.warn(w);
      showStatusFn(
        `Wholesale price data incomplete on ${spCountWarnings.length} date${spCountWarnings.length === 1 ? '' : 's'} — affected periods will use null prices.`,
        'warning'
      );
    }
  }

  // Step 4: Check weather fallback for recent days
  let { weatherMap } = weatherResult.value;
  const expectedHours = buildExpectedHours(metadata.data_start, metadata.data_end);
  let weatherSource = 'open-meteo-archive';

  if (needsFallback(weatherMap, expectedHours, metadata.data_end)) {
    showProgressFn('Fetching recent weather data…');
    const fallbackResult = await fetchWeatherFallback(
      latitude, longitude, weatherMap, expectedHours, metadata.data_end
    );
    weatherMap = fallbackResult.weatherMap;
    if (fallbackResult.usedFallback) {
      weatherSource = 'open-meteo-forecast';
    }
  }

  // Step 5: Align external data to consumption timeline
  showProgressFn('Aligning external data…');
  const external = alignExternalData(consumption, weatherMap, priceLookup);

  // Step 6: Build metadata
  const externalMetadata = buildExternalMetadata(
    latitude, longitude, elevation_m, weatherSource, priceSource, priceWarnings
  );

  // Step 7: Store result
  setExternalResult({ external, external_metadata: externalMetadata });

  // Step 8: Show summary
  const weatherCount = external.filter(e => e.temp_c !== null).length;
  const priceCount = external.filter(e => e.wholesale_p_kwh !== null).length;
  const gapCount = external.filter(e => e.temp_c === null).length;

  showStatusFn(
    `External data loaded. Weather: ${weatherCount} periods. Wholesale prices: ${priceCount} periods (${priceSource}). Gaps: ${gapCount}.`,
    'success'
  );
}

// ===== Module 3: Energy Summary Table =====

function renderEnergySummaryTable() {
  const baseload = getBaseloadResult();
  const ingestion = getIngestionResult();
  if (!baseload || !ingestion) return;

  const { heating, supplementary_loads: sl } = baseload;
  const { consumption } = ingestion;

  let gasHeating = 0;
  let gasBaseload = 0;
  for (const slot of heating) {
    if (slot.heating_kwh !== null) gasHeating += slot.heating_kwh;
    if (slot.baseload_kwh !== null) gasBaseload += slot.baseload_kwh;
  }

  let elecTotal = 0;
  for (const rec of consumption) {
    if (rec.elec_kwh !== null) elecTotal += rec.elec_kwh;
  }

  const elecHeating = sl.electric_heating_kwh_estimate ?? 0;
  const elecCooling = Math.max(0, (sl.cdd_coefficient_kwh_per_dd ?? 0) * (sl.sum_cdd_k_day ?? 0));
  const elecBaseline = Math.max(0, elecTotal - elecHeating - elecCooling);

  const grandTotal = gasBaseload + elecBaseline + gasHeating + elecHeating + elecCooling;
  const pct = (v) => grandTotal > 0 ? `${Math.round((v / grandTotal) * 100)}%` : '—';
  const kwh = (v) => `${Math.round(v).toLocaleString()} kWh`;

  const rows = [
    ['Gas baseload',                    gasBaseload],
    ['Electricity baseline',            elecBaseline],
    ['Gas heating',                     gasHeating],
    ['Electricity cold-weather uplift', elecHeating],
    ['Electricity warm-weather uplift', elecCooling],
  ];

  energySummaryContent.innerHTML = `
    <table class="energy-summary-table">
      <thead>
        <tr><th>Category</th><th>kWh</th><th>% of total</th></tr>
      </thead>
      <tbody>
        ${rows.map(([label, value]) => `
          <tr>
            <td>${escapeHtml(label)}</td>
            <td>${kwh(value)}</td>
            <td>${pct(value)}</td>
          </tr>`).join('')}
      </tbody>
      <tfoot>
        <tr class="total-row">
          <td>Total</td>
          <td>${kwh(grandTotal)}</td>
          <td>100%</td>
        </tr>
      </tfoot>
    </table>`;

  energySummaryCard.classList.remove('hidden');
}

// ===== Module 3: Baseload Separation Orchestration =====

async function runBaseloadSeparation(showProgressFn, showStatusFn) {
  const ingestion = getIngestionResult();
  const externalResult = getExternalResult();
  if (!ingestion || !externalResult) return;

  showProgressFn('Separating heating demand from baseload…');

  let result;
  try {
    result = separateBaseload(ingestion.consumption, externalResult.external);
  } catch (err) {
    showStatusFn('Baseload separation failed: ' + err.message, 'error');
    console.error('runBaseloadSeparation error:', err);
    return;
  }

  setBaseloadResult(result);

  const meta = result.baseload_metadata;
  const sl = result.supplementary_loads;

  // Primary separation summary
  const methodLabel = BASELOAD_METHOD_LABELS[meta.method] ?? meta.method;
  const meanStr = meta.baseload_mean_kwh_per_day.toFixed(1);
  const medianStr = meta.baseload_median_kwh_per_day.toFixed(1);
  let validationStr = '';
  if (meta.validation_status === 'good' || meta.validation_status === 'acceptable' || meta.validation_status === 'poor') {
    const r2Str = meta.heating_vs_degree_days_r2 !== null ? ` (R² = ${meta.heating_vs_degree_days_r2.toFixed(2)})` : '';
    validationStr = ` Validation: ${meta.validation_status}${r2Str}.`;
  } else if (meta.validation_status === 'insufficient_data') {
    validationStr = ' Validation: insufficient data.';
  }
  const absenceStr = meta.absence_days_total > 0 ? ` Absences detected: ${meta.absence_days_total} days.` : '';

  let gasPKwh = null;
  if (ingestion?.tariff_rates?.gas?.length > 0) {
    const rates = ingestion.tariff_rates.gas;
    gasPKwh = rates[rates.length - 1].rate_p_kwh;
  }
  const costStr = (gasPKwh !== null && !isNaN(gasPKwh))
    ? ` (≈ £${((meta.baseload_mean_kwh_per_day * gasPKwh) / 100).toFixed(2)}/day)`
    : '';

  showStatusFn(
    `Baseload separation complete. Method: ${methodLabel}. Daily non-heating gas: mean ${meanStr} kWh/day${costStr}, median ${medianStr} kWh/day.${validationStr}${absenceStr}`,
    'info'
  );

  // Warnings from gas separation
  for (const warning of meta.warnings) {
    showStatusFn(warning, 'warning');
  }

  // Supplementary load messages
  const ehConf = sl.electric_heating_confidence;
  if (sl.electric_heating_detected && !sl.electric_heating_is_primary) {
    const confLabel = CONFIDENCE_LABELS[ehConf] ?? ehConf;
    const est = sl.electric_heating_kwh_estimate !== null ? sl.electric_heating_kwh_estimate.toFixed(0) : '—';
    const perDd = sl.electric_heating_kwh_per_dd !== null ? sl.electric_heating_kwh_per_dd.toFixed(2) : '—';
    showStatusFn(
      `Supplementary electric heating detected (${confLabel}). Estimated ${est} kWh over the data period (${perDd} kWh per degree-day). Your gas-derived heat loss may underestimate your home's true heating demand.`,
      'warning'
    );
  } else if (sl.electric_heating_is_primary) {
    const confLabel = CONFIDENCE_LABELS[ehConf] ?? ehConf;
    const est = sl.electric_heating_kwh_estimate !== null ? sl.electric_heating_kwh_estimate.toFixed(0) : '—';
    showStatusFn(
      `Electric heating detected (${confLabel}). Estimated ${est} kWh over the data period. Your home appears to heat with electricity rather than gas.`,
      'info'
    );
  } else if (ehConf === 'low') {
    showStatusFn(
      'Weak signal for supplementary electric heating (low confidence) — not included in heat loss adjustment.',
      'info'
    );
  }

  // Warm-weather electricity uplift messages
  if (sl.air_conditioning_detected) {
    const acConf = CONFIDENCE_LABELS[sl.air_conditioning_confidence] ?? sl.air_conditioning_confidence;
    const estKwh = sl.air_conditioning_kwh_estimate !== null
      ? ` (estimated ${sl.air_conditioning_kwh_estimate.toFixed(0)} kWh)` : '';
    showStatusFn(
      `Warm-weather electricity uplift detected${estKwh} (${acConf}). Your electricity use rises in warm weather — this may reflect cooling equipment, but could also be fans, refrigeration, or increased summer activity.`,
      'info'
    );
  } else if (sl.ac_detection_note === 'insufficient_cdd_data') {
    showStatusFn(
      'Not enough warm-weather data to assess warm-weather electricity uplift.',
      'info'
    );
  }

  // Limitations (only when regression ran)
  if (sl.method === 'regression') {
    showStatusFn('Note: supplementary load detection has limitations — see details below.', 'info');
    for (const limitation of sl.limitations) {
      showStatusFn(limitation, 'info');
    }
  }

  renderEnergySummaryTable();
}

// ===== Module 4: Heat Loss Estimation Orchestration =====

function displayHeatLossResults(result) {
  heatLossStatus.innerHTML = '';
  heatLossSummary.innerHTML = '';

  for (const warning of result.warnings) {
    const div = document.createElement('div');
    div.className = 'status-msg warning';
    div.textContent = warning;
    heatLossStatus.appendChild(div);
  }

  if (result.validation_status === 'no_gas') {
    const div = document.createElement('div');
    div.className = 'status-msg info';
    div.textContent = 'No gas supply detected — heat loss estimation requires gas consumption data.';
    heatLossStatus.appendChild(div);
    heatLossResults.classList.remove('hidden');
    return;
  }

  if (result.validation_status === 'insufficient_data') {
    heatLossResults.classList.remove('hidden');
    return;
  }

  if (result.htc_w_per_k === null) {
    const div = document.createElement('div');
    div.className = 'status-msg error';
    div.textContent = 'Heat loss could not be calculated. See warnings above.';
    heatLossStatus.appendChild(div);
    heatLossResults.classList.remove('hidden');
    return;
  }

  const fmt = (v, dp = 0) => v !== null && v !== undefined ? v.toFixed(dp) : '—';
  const rows = [];

  rows.push(['Heat transfer coefficient (HTC)', `${fmt(result.htc_w_per_k)} W/K`]);
  if (result.htc_confidence_interval_95) {
    const ci = result.htc_confidence_interval_95;
    rows.push(['95% confidence interval', `${fmt(ci.lower)} – ${fmt(ci.upper)} W/K`]);
  }
  if (result.htc_w_per_k_adjusted !== null) {
    rows.push(['Adjusted HTC (incl. electric heating)', `${fmt(result.htc_w_per_k_adjusted)} W/K`]);
  }
  rows.push(['Insulation rating', HEAT_LOSS_RATING_DISPLAY[result.rating] ?? result.rating ?? '—']);
  if (result.hlp_w_per_m2_k !== null) {
    rows.push(['Heat loss parameter (HLP)', `${result.hlp_w_per_m2_k.toFixed(2)} W/m²K`]);
  }
  if (result.solar_correction_applied && result.solar_aperture_m2 !== null) {
    rows.push(['Effective solar aperture', `${fmt(result.solar_aperture_m2, 1)} m²`]);
    rows.push(['Solar gain rating', SOLAR_RATING_DISPLAY[result.solar_rating] ?? result.solar_rating ?? '—']);
    if (result.cooling_consideration) {
      const coolingLabel = result.cooling_consideration.replace(/_/g, ' ');
      rows.push(['Summer cooling consideration', coolingLabel]);
    }
  }
  rows.push(['Degree-day base temperature', `${result.degree_day_base_c}°C`]);
  rows.push(['Boiler efficiency used', result.boiler_efficiency_used.toFixed(2)]);
  rows.push(['Days used in fit', result.days_used_in_fit]);
  if (result.regression_r2 !== null) {
    rows.push(['Fit quality (R²)', result.regression_r2.toFixed(2)]);
  }
  rows.push(['Validation status', result.validation_status]);

  heatLossSummary.innerHTML = rows
    .map(([dt, dd]) => `<dt>${escapeHtml(String(dt))}</dt><dd>${escapeHtml(String(dd))}</dd>`)
    .join('');

  heatLossResults.classList.remove('hidden');
}

async function runHeatLoss(showProgressFn, showStatusFn) {
  const ingestion = getIngestionResult();
  const externalResult = getExternalResult();
  const baseloadResult = getBaseloadResult();
  if (!ingestion || !externalResult || !baseloadResult) return;

  showProgressFn('Estimating heat loss…');

  const boilerEfficiency = parseFloat(boilerEfficiencyInput.value) || 0.90;
  const floorAreaRaw = parseFloat(floorAreaInput.value);
  const floorAreaM2 = isNaN(floorAreaRaw) ? null : floorAreaRaw;

  let result;
  try {
    result = estimateHeatLoss(
      baseloadResult.heating,
      externalResult.external,
      baseloadResult.baseload_metadata,
      baseloadResult.supplementary_loads,
      boilerEfficiency,
      floorAreaM2,
    );
  } catch (err) {
    showStatusFn('Heat loss estimation failed: ' + err.message, 'error');
    console.error('runHeatLoss error:', err);
    return;
  }

  setHeatLossResult(result);
  heatLossCard.classList.remove('hidden');
  displayHeatLossResults(result);
}

btnRecalculateHeatLoss.addEventListener('click', async () => {
  btnRecalculateHeatLoss.disabled = true;
  heatLossStatus.innerHTML = '';
  heatLossSummary.innerHTML = '';
  heatLossResults.classList.add('hidden');
  await runHeatLoss(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      heatLossStatus.appendChild(div);
    }
  );
  btnRecalculateHeatLoss.disabled = false;
});

// ===== Module 5: Thermal Character Orchestration =====

function displayThermalCharacterResults(result) {
  thermalCharStatus.innerHTML  = '';
  thermalCharSummary.innerHTML = '';
  thermalCharResults.classList.remove('hidden');

  for (const warning of result.warnings) {
    const div = document.createElement('div');
    div.className = 'status-msg warning';
    div.textContent = warning;
    thermalCharStatus.appendChild(div);
  }

  if (result.validation_status === 'no_htc') {
    const div = document.createElement('div');
    div.className = 'status-msg info';
    div.textContent = 'Heat loss data not available — thermal character estimation requires a heat loss result.';
    thermalCharStatus.appendChild(div);
    return;
  }

  if (result.validation_status === 'no_gas') {
    const div = document.createElement('div');
    div.className = 'status-msg info';
    div.textContent = 'No gas supply — thermal character estimation requires gas data.';
    thermalCharStatus.appendChild(div);
    return;
  }

  if (result.validation_status === 'insufficient_data') return;

  const fmt = (v, dp = 0) => v !== null && v !== undefined ? v.toFixed(dp) : '—';
  const rows = [];

  if (result.setpoint_c !== null) {
    rows.push(['Inferred thermostat setpoint', `${fmt(result.setpoint_c, 1)}°C`]);
  }
  if (result.thermal_mass_kj_per_k !== null) {
    rows.push(['Thermal mass', `${Math.round(result.thermal_mass_kj_per_k).toLocaleString()} kJ/K`]);
  }
  if (result.time_constant_hours !== null) {
    rows.push(['Thermal time constant', `${fmt(result.time_constant_hours, 1)} hours`]);
  }
  if (result.thermal_mass_rating !== null) {
    rows.push(['Thermal mass rating', THERMAL_MASS_RATING_LABELS[result.thermal_mass_rating] ?? result.thermal_mass_rating]);
  }

  const occupancyLabel = result.occupancy_weights !== null
    ? 'Available (feeds pre-heating optimiser)'
    : 'Insufficient data';
  rows.push(['Occupancy pattern', occupancyLabel]);

  rows.push(['Half-hourly periods used (setpoint fit)', result.setpoint_days_used]);
  rows.push(['Warm-up events used (thermal mass)', result.thermal_mass_events_used]);
  rows.push(['Validation status', result.validation_status]);

  thermalCharSummary.innerHTML = rows
    .map(([dt, dd]) => `<dt>${escapeHtml(String(dt))}</dt><dd>${escapeHtml(String(dd))}</dd>`)
    .join('');
}

async function runThermalCharacter(showProgressFn, showStatusFn) {
  const baseloadResult = getBaseloadResult();
  const externalResult = getExternalResult();
  const heatLossResult = getHeatLossResult();
  if (!baseloadResult || !externalResult) return;

  showProgressFn('Estimating thermal character…');

  const wallConstruction = wallConstructionInput.value || null;

  let result;
  try {
    result = estimateThermalCharacter(
      baseloadResult.heating,
      externalResult.external,
      heatLossResult,
      baseloadResult.baseload_metadata.method,
      wallConstruction,
    );
  } catch (err) {
    showStatusFn('Thermal character estimation failed: ' + err.message, 'error');
    console.error('runThermalCharacter error:', err);
    return;
  }

  setThermalCharacterResult(result);
  thermalCharCard.classList.remove('hidden');
  displayThermalCharacterResults(result);
}

btnRecalcThermalChar.addEventListener('click', async () => {
  btnRecalcThermalChar.disabled = true;
  thermalCharStatus.innerHTML  = '';
  thermalCharSummary.innerHTML = '';
  thermalCharResults.classList.add('hidden');
  await runThermalCharacter(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      thermalCharStatus.appendChild(div);
    }
  );
  btnRecalcThermalChar.disabled = false;
});

// ===== CSV Helpers =====

function showCsvProgress(text) {
  csvProgressArea.classList.remove('hidden');
  csvProgressText.textContent = text;
}

function hideCsvProgress() {
  csvProgressArea.classList.add('hidden');
}

function showCsvStatus(message, type) {
  const div = document.createElement('div');
  div.className = `status-msg ${type}`;
  div.textContent = message;
  csvStatusArea.appendChild(div);
}

function clearCsvStatus() {
  csvStatusArea.innerHTML = '';
}

// ===== CSV Orchestration (Step 12) =====

// Postcode touched detection (state-based, not value-based)
csvPostcodeInput.addEventListener('input', () => {
  csvPostcodeInput.dataset.touched = 'true';
}, { once: true });

btnCsvAnalyse.addEventListener('click', async () => {
  clearCsvStatus();
  hideCsvProgress();
  csvPostcodeNote.classList.add('hidden');
  resultsCard.classList.add('hidden');
  btnCsvAnalyse.disabled = true;

  try {
    // Step 1: Read file
    const file = csvFileInput.files[0];
    if (!file) {
      showCsvStatus('Please select a CSV file.', 'error');
      btnCsvAnalyse.disabled = false;
      return;
    }

    showCsvProgress('Reading file…');
    const fileContent = await readFileAsText(file);

    // Step 2: Parse CSV
    showCsvProgress('Parsing CSV…');
    const { records, errors } = parseCSV(fileContent);

    if (errors.length > 0) {
      hideCsvProgress();
      for (const err of errors) {
        showCsvStatus(err, 'error');
      }
      btnCsvAnalyse.disabled = false;
      return;
    }

    // Step 3: Determine postcode
    showCsvProgress('Validating postcode…');
    const postcodeValue = csvPostcodeInput.value.trim();
    const postcodeTouched = csvPostcodeInput.dataset.touched === 'true';

    let postcode;
    let postcodeSource;

    if (!postcodeValue) {
      // Empty field — use default
      postcode = CONFIG.DEFAULT_POSTCODE;
      postcodeSource = 'default';
      csvPostcodeNote.classList.remove('hidden');
    } else if (postcodeTouched) {
      // User-entered value — validate
      const result = await validatePostcode(postcodeValue);
      if (!result.valid) {
        hideCsvProgress();
        showCsvStatus(result.error, 'error');
        btnCsvAnalyse.disabled = false;
        return;
      }
      postcode = postcodeValue;
      postcodeSource = 'user';
    } else {
      // Placeholder still showing, field empty — shouldn't reach here but handle
      postcode = CONFIG.DEFAULT_POSTCODE;
      postcodeSource = 'default';
      csvPostcodeNote.classList.remove('hidden');
    }

    // Step 4: Build tariff rates from form fields
    const gasRate = parseFloat(csvGasRateInput.value) || CONFIG.DEFAULT_GAS_RATE_P_KWH;
    const elecRate = parseFloat(csvElecRateInput.value) || CONFIG.DEFAULT_ELEC_RATE_P_KWH;
    const gasStanding = parseFloat(csvGasStandingInput.value) || CONFIG.DEFAULT_GAS_STANDING_P_DAY;
    const elecStanding = parseFloat(csvElecStandingInput.value) || CONFIG.DEFAULT_ELEC_STANDING_P_DAY;

    const timestamps = records.map(r => r.interval_start).sort();
    const dataStart = timestamps[0];
    const dataEnd = timestamps[timestamps.length - 1];

    const tariffRates = {
      electricity: [{
        valid_from: dataStart,
        valid_to: null,
        rate_p_kwh: elecRate,
        standing_p_day: elecStanding,
        tariff_type: 'csv_manual',
        product_code: null,
      }],
      gas: [{
        valid_from: dataStart,
        valid_to: null,
        rate_p_kwh: gasRate,
        standing_p_day: gasStanding,
        tariff_type: 'csv_manual',
        product_code: null,
      }],
    };

    // Step 5: Normalise
    showCsvProgress('Normalising data…');

    // Convert CSV records to the format normaliseConsumption expects
    const elecRecords = records.map(r => ({
      interval_start: r.interval_start,
      consumption: r.elec_kwh,
    }));
    const gasRecords = records.map(r => ({
      interval_start: r.interval_start,
      consumption: r.gas_kwh,
    }));

    const normalised = normaliseConsumption(elecRecords, gasRecords, dataStart, dataEnd);

    // Step 6: Data quality gate
    const meta = normalised.metadata;

    if (meta.total_days < CONFIG.MIN_DAYS_FOR_ANALYSIS) {
      hideCsvProgress();
      showCsvStatus(
        'At least 30 days of data needed for a meaningful analysis.',
        'error'
      );
      btnCsvAnalyse.disabled = false;
      return;
    }

    if (meta.total_days < CONFIG.WARNING_DAYS_THRESHOLD) {
      showCsvStatus(
        'Less than 3 months of data. Seasonal analysis will be limited.',
        'warning'
      );
    }

    if (meta.gap_percentage > CONFIG.GAP_WARNING_PERCENTAGE) {
      showCsvStatus(
        `Your data has significant gaps (${meta.gap_percentage}%). Results may be less accurate.`,
        'warning'
      );
    }

    // Step 7: Store result
    const fullMetadata = {
      ...meta,
      postcode,
      postcode_source: postcodeSource,
      mpan: null,
      mprn: null,
      gas_unit_source: 'csv',
      input_path: 'csv',
    };

    setIngestionResult({
      consumption: normalised.consumption,
      tariff_rates: tariffRates,
      metadata: fullMetadata,
    });

    // Step 8: Show success
    hideCsvProgress();
    showSuccessSummary(normalised, tariffRates, fullMetadata);
    showCsvStatus('Data loaded successfully.', 'success');

    // Step 9: Trigger Module 2 — External Data
    await runExternalData(
      (text) => showCsvProgress(text),
      (msg, type) => showCsvStatus(msg, type)
    );

    // Step 10: Trigger Module 3 — Baseload Separation
    await runBaseloadSeparation(
      (text) => showCsvProgress(text),
      (msg, type) => showCsvStatus(msg, type)
    );

    // Step 11: Trigger Module 4 — Heat Loss Estimation
    await runHeatLoss(
      (text) => showCsvProgress(text),
      (msg, type) => showCsvStatus(msg, type)
    );

    // Step 12: Trigger Module 5 — Thermal Character
    await runThermalCharacter(
      (text) => showCsvProgress(text),
      (msg, type) => showCsvStatus(msg, type)
    );

    hideCsvProgress();

  } catch (err) {
    hideCsvProgress();
    showCsvStatus(err.message || 'An unexpected error occurred.', 'error');
  }

  btnCsvAnalyse.disabled = false;
});

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}

// debug-only — remove in post-launch cleanup (after 28-Apr-2026 launch)
window.__getIngestionResult        = () => getIngestionResult();
window.__getExternalResult         = () => getExternalResult();
window.__getBaseloadResult         = () => getBaseloadResult();
window.__getHeatLossResult         = () => getHeatLossResult();
window.__getThermalCharacterResult = () => getThermalCharacterResult();
