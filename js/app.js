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
  fetchAgileCalibration,
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

import {
  estimateHeatPumpModel,
  setHeatPumpModelResult,
  getHeatPumpModelResult,
} from './heatpump-model.js';

import {
  estimateScenarioConsumption,
  setScenarioConsumptionResult,
  getScenarioConsumptionResult,
} from './scenario-consumption.js';

import {
  prepareRates, computeCosts,
  setRateMetadata, getRateMetadata,
  setPricingResult, getPricingResult,
  PE_CONFIG,
} from './pricing-engine.js';

import {
  analyseFinancials,
  setFinancialResult,
  getFinancialResult,
  FA_CONFIG,
} from './financial.js';

// ===== Ofgem cap constants (Q2 2026) =====
const OFGEM_CAP_ELEC_P_KWH  = 24.67;
const OFGEM_CAP_GAS_P_KWH   = 5.70;
const OFGEM_CAP_VALID_FROM  = '2026-04-01';

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

let verdictChart = null;

// ===== DOM References =====
const apiKeyInput = document.getElementById('api-key');
const accountInput = document.getElementById('account-number');
const btnFetch = document.getElementById('btn-fetch');
const progressArea = document.getElementById('progress-area');
const progressText = document.getElementById('progress-text');
const progressBar = document.getElementById('progress-bar');
const statusArea       = document.getElementById('status-area');
const statusDetails    = document.getElementById('status-details');
const statusSummary    = document.getElementById('status-summary');
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
const csvStatusArea    = document.getElementById('csv-status-area');
const csvStatusDetails = document.getElementById('csv-status-details');
const csvStatusSummary = document.getElementById('csv-status-summary');

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
const tAtRestartInput       = document.getElementById('t-at-restart');
const tauBucketSelect       = document.getElementById('tau-bucket');
const btnRecalcThermalChar  = document.getElementById('btn-recalculate-thermal-char');

// Heat pump model DOM references
const hpModelCard        = document.getElementById('hp-model-card');
const hpModelResults     = document.getElementById('hp-model-results');
const hpModelStatus      = document.getElementById('hp-model-status');
const hpModelSummary     = document.getElementById('hp-model-summary');
const hpCopTableBody     = document.querySelector('#hp-cop-table tbody');
const copScalarInput     = document.getElementById('cop-scalar');
const copScalarValue     = document.getElementById('cop-scalar-value');
const btnRecalcHpModel   = document.getElementById('btn-recalculate-hp-model');

// Scenario consumption DOM references
const scenarioCard            = document.getElementById('scenario-card');
const scenarioResults         = document.getElementById('scenario-results');
const scenarioStatus          = document.getElementById('scenario-status');
const scenarioSummary         = document.getElementById('scenario-summary');
const btnRecalcScenario       = document.getElementById('btn-recalculate-scenario');

// Financial analysis DOM references
const financialParamsCard  = document.getElementById('financial-params-card');
const financialCard        = document.getElementById('financial-card');
const financialResults     = document.getElementById('financial-results');
const financialStatus      = document.getElementById('financial-status');
const financialSummary     = document.getElementById('financial-summary');
const installFullHpInput   = document.getElementById('install-full-hp');
const busGrantInput        = document.getElementById('bus-grant');
const avoidedAcInput       = document.getElementById('avoided-ac');
const btnRecalcFinancial   = document.getElementById('btn-recalculate-financial');

// Pricing engine DOM references
const pricingParamsCard  = document.getElementById('pricing-params-card');
const pricingCard        = document.getElementById('pricing-card');
const pricingResults     = document.getElementById('pricing-results');
const pricingStatus      = document.getElementById('pricing-status');
const pricingSummary     = document.getElementById('pricing-summary');
const svtRateInput       = document.getElementById('svt-rate');
const elecStandingInput  = document.getElementById('elec-standing-charge');
const gasStandingInput   = document.getElementById('gas-standing-charge');
const btnRecalcPricing   = document.getElementById('btn-recalculate-pricing');

// Verdict card DOM references
const verdictCard      = document.getElementById('verdict-card');
const verdictHeadline  = document.getElementById('verdict-headline');
const verdictStatus    = document.getElementById('verdict-status');
const verdictQuality   = document.getElementById('verdict-quality');

// Section banner DOM references
const bannerYourHome    = document.getElementById('section-banner-your-home');
const bannerVerdict     = document.getElementById('section-banner-verdict');
const bannerAssumptions = document.getElementById('section-banner-assumptions');

// Methodology disclosure DOM reference
const methodologyDisclosure = document.getElementById('methodology-disclosure');

// ===== Module 6: Live slider value display =====

copScalarInput.addEventListener('input', () => {
  copScalarValue.textContent = parseFloat(copScalarInput.value).toFixed(2);
});

// ===== Heat to Comfort slider =====

const heatToComfortSlider = document.getElementById('heat-to-comfort');
const heatToComfortOutput = document.getElementById('heat-to-comfort-value');

heatToComfortSlider.addEventListener('input', () => {
  heatToComfortOutput.value = heatToComfortSlider.value;
});

heatToComfortSlider.addEventListener('change', async () => {
  await runScenarioConsumption(() => {}, () => {});
  await runPricingEngine(() => {}, () => {});
  await runFinancialAnalysis(() => {}, () => {});
});

// ===== Module 8: Rate param helpers =====

function parseRate(input, fallback) {
  const v = parseFloat(input.value);
  return isNaN(v) ? fallback : v;
}

function readRateParams() {
  return {
    svt_rate_p_per_kwh:    parseRate(svtRateInput,      PE_CONFIG.SVT_RATE_DEFAULT_P),
    svt_standing_charge_p: parseRate(elecStandingInput, PE_CONFIG.ELEC_STANDING_DEFAULT_P_DAY),
    gas_standing_charge_p: parseRate(gasStandingInput,  PE_CONFIG.GAS_STANDING_DEFAULT_P_DAY),
    ofgem_cap_elec_p_kwh:  OFGEM_CAP_ELEC_P_KWH,
  };
}

function readCapitalParams() {
  return {
    installation_cost_full_hp_gbp: parseRate(installFullHpInput, FA_CONFIG.INSTALLATION_FULL_HP_DEFAULT_GBP),
    bus_grant_gbp:                 parseRate(busGrantInput,       FA_CONFIG.BUS_GRANT_DEFAULT_GBP),
    avoided_ac_cost_gbp:           parseRate(avoidedAcInput,      FA_CONFIG.AVOIDED_AC_DEFAULT_GBP),
  };
}

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
  const count = statusArea.children.length;
  statusSummary.textContent = `${count} notice${count === 1 ? '' : 's'}`;
  statusDetails.classList.remove('hidden');
}

function clearStatus() {
  statusArea.innerHTML = '';
  statusSummary.textContent = '0 notices';
  statusDetails.classList.add('hidden');
  statusDetails.removeAttribute('open');
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
      if (gasResult.detectedUnit === 'm3') {
        gasM3Toggle.checked = true;
      } else if (gasResult.detectedUnit === 'kwh') {
        gasM3Toggle.checked = false;
      }
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

  const GSP_NAMES = {
    A: 'Eastern England',        B: 'East Midlands',         C: 'London',
    D: 'North Wales & Merseyside', E: 'West Midlands',       F: 'North East England',
    G: 'North West England',     H: 'Southern England',      J: 'South East England',
    K: 'South West England',     L: 'South Wales',           M: 'Yorkshire',
    N: 'South Scotland',         P: 'North Scotland',
  };
  const gspDisplayEl = document.getElementById('gsp-region-display');
  if (gspDisplayEl) gspDisplayEl.textContent = GSP_NAMES[prop.gsp_region] ?? prop.gsp_region ?? 'Unknown';
  const gspReadonly = document.getElementById('gsp-region-readonly');
  if (gspReadonly && prop.gsp_region) gspReadonly.classList.remove('hidden');

  setIngestionResult({
    consumption: normalised.consumption,
    tariff_rates: tariffRates,
    metadata: fullMetadata,
    gsp_region: prop.gsp_region ?? null,
  });
  prefillRateInputs(tariffRates);

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

  // Step 13: Trigger Module 6 — Heat Pump Model
  await runHeatPumpModel(
    (text) => showProgress(text, undefined),
    (msg, type) => showStatus(msg, type)
  );

  // Step 14: Trigger Module 7 — Scenario Consumption
  await runScenarioConsumption(
    (text) => showProgress(text, undefined),
    (msg, type) => showStatus(msg, type)
  );

  // Step 15: Trigger Module 8 — Pricing Engine
  await runPricingEngine(
    (text) => showProgress(text, undefined),
    (msg, type) => showStatus(msg, type)
  );

  // Step 16: Trigger Module 9 — Financial Analysis
  await runFinancialAnalysis(
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

  bannerYourHome.classList.remove('hidden');
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
      (pct) => showProgress(`Fetching price data… ${pct}%`, pct)),
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

  // Step 6: Agile calibration
  const ingestion = getIngestionResult();
  const agileCalibration = await fetchAgileCalibration(ingestion?.gsp_region ?? null);

  // Step 7: Build metadata
  const externalMetadata = buildExternalMetadata(
    latitude, longitude, elevation_m, weatherSource, priceSource, priceWarnings, agileCalibration
  );

  // Step 8: Store result
  setExternalResult({ external, external_metadata: externalMetadata });

  // Step 9: Show summary
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
    <p class="card-intro">Here's how your annual energy use breaks down. Gas heating is
    what a heat pump would replace.</p>
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

  rows.push(['Heat loss rate', `${fmt(result.htc_w_per_k)} W/K`]);
  if (result.htc_confidence_interval_95) {
    const ci = result.htc_confidence_interval_95;
    rows.push(['Confidence range (95%)', `${fmt(ci.lower)} – ${fmt(ci.upper)} W/K`]);
  }
  if (result.htc_w_per_k_adjusted !== null) {
    rows.push(['Adjusted heat loss rate (includes electric heating)', `${fmt(result.htc_w_per_k_adjusted)} W/K`]);
  }
  rows.push(['Insulation rating', HEAT_LOSS_RATING_DISPLAY[result.rating] ?? result.rating ?? '—']);
  if (result.hlp_w_per_m2_k !== null) {
    rows.push(['Heat loss per m² (HLP)', `${result.hlp_w_per_m2_k.toFixed(2)} W/m²K`]);
  }
  if (result.solar_correction_applied && result.solar_aperture_m2 !== null) {
    rows.push(['Solar aperture (free heat from the sun)', `${fmt(result.solar_aperture_m2, 1)} m²`]);
    rows.push(['Solar gain rating', SOLAR_RATING_DISPLAY[result.solar_rating] ?? result.solar_rating ?? '—']);
    if (result.cooling_consideration) {
      const coolingLabel = result.cooling_consideration.replace(/_/g, ' ');
      rows.push(['Summer cooling consideration', coolingLabel]);
    }
  }
  if (result.regression_r2 !== null) {
    rows.push(['Fit quality (R²)', result.regression_r2.toFixed(2)]);
  }

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
  methodologyDisclosure.classList.remove('hidden');
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

// ===== Underheat diagnostic panel =====

function displayUnderheatPanel(tc) {
  const card = document.getElementById('underheat-card');
  if (!tc || tc.underheat_status === 'insufficient_data') {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  const fmtKwh = v => (Math.round(v / 100) * 100).toLocaleString('en-GB');
  document.getElementById('underheat-observed').textContent = fmtKwh(tc.annual_observed_demand_kwh);
  document.getElementById('underheat-modelled').textContent = fmtKwh(tc.annual_modelled_demand_kwh);
  document.getElementById('underheat-setpoint').textContent = tc.setpoint_c.toFixed(1);
  document.getElementById('underheat-ratio-value').textContent = `${Math.round(tc.underheat_ratio * 100)}%`;

  const light = document.getElementById('underheat-light');
  light.className = 'underheat-light ' + (tc.underheat_status === 'match' ? 'green' : 'amber');

  document.getElementById('underheat-narrative').textContent = tc.underheat_narrative;
}

function setupHeatToComfortSlider(tc) {
  const group  = document.getElementById('heat-to-comfort-group');
  const ratio  = tc?.underheat_ratio;
  if (ratio == null) {
    group.classList.add('hidden');
    return;
  }
  group.classList.remove('hidden');
  const defaultPct = Math.min(150, Math.max(0, Math.round(ratio * 100)));
  heatToComfortSlider.value = defaultPct;
  heatToComfortOutput.value = defaultPct;
}

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
    rows.push(['Estimated thermostat setpoint', `${fmt(result.setpoint_c, 1)}°C`]);
  }
  if (result.thermal_mass_kj_per_k !== null) {
    rows.push(['Thermal mass (kJ/K)', `${Math.round(result.thermal_mass_kj_per_k).toLocaleString()} kJ/K`]);
  }
  if (result.thermal_mass_source !== null) {
    const sourceLabel = ({
      measured_cold_soak: 'Measured from your heating data',
      user_tau:           'Estimated from your description',
    })[result.thermal_mass_source];
    rows.push(['Thermal mass source', sourceLabel]);
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
  rows.push(['Occupancy model', occupancyLabel]);

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

  const tAtRestartRaw = tAtRestartInput.value.trim();
  let tAtRestart = null;
  if (tAtRestartRaw !== '') {
    const parsed = parseFloat(tAtRestartRaw);
    tAtRestart = isNaN(parsed) ? null : parsed;
  }

  const tauBucket = tauBucketSelect.value || null;

  let result;
  try {
    result = estimateThermalCharacter(
      baseloadResult.heating,
      externalResult.external,
      heatLossResult,
      baseloadResult.baseload_metadata.method,
      wallConstruction,
      tAtRestart,
      tauBucket,
    );
  } catch (err) {
    showStatusFn('Thermal character estimation failed: ' + err.message, 'error');
    console.error('runThermalCharacter error:', err);
    return;
  }

  setThermalCharacterResult(result);
  thermalCharCard.classList.remove('hidden');
  displayThermalCharacterResults(result);
  displayUnderheatPanel(result);
  setupHeatToComfortSlider(result);
}

btnRecalcThermalChar.addEventListener('click', async () => {
  btnRecalcThermalChar.disabled = true;
  thermalCharStatus.innerHTML  = '';
  thermalCharSummary.innerHTML = '';
  thermalCharResults.classList.add('hidden');

  const showStatus = (msg, type) => {
    const div = document.createElement('div');
    div.className = `status-msg ${type}`;
    div.textContent = msg;
    thermalCharStatus.appendChild(div);
  };

  await runThermalCharacter(() => {}, showStatus);
  // Thermal-mass change flips smart scenarios from null ↔ values; chain downstream
  await runScenarioConsumption(() => {}, () => {});
  await runPricingEngine(() => {}, () => {});
  await runFinancialAnalysis(() => {}, () => {});

  btnRecalcThermalChar.disabled = false;
});

// ===== Module 6: Heat Pump Model Orchestration =====

function renderHpCopTable(copCurvePoints) {
  hpCopTableBody.innerHTML = copCurvePoints
    .map(p => `<tr><td>${p.temp_c}°C</td><td>${p.cop.toFixed(2)}</td></tr>`)
    .join('');
}

function displayHeatPumpModelResults(result) {
  hpModelStatus.innerHTML  = '';
  hpModelSummary.innerHTML = '';
  hpCopTableBody.innerHTML = '';
  hpModelResults.classList.remove('hidden');

  for (const warning of result.warnings) {
    const div = document.createElement('div');
    div.className = 'status-msg warning';
    div.textContent = warning;
    hpModelStatus.appendChild(div);
  }

  if (result.validation_status === 'no_temp_data') {
    const div = document.createElement('div');
    div.className = 'status-msg info';
    div.textContent = 'Temperature data unavailable — heat pump COP cannot be modelled.';
    hpModelStatus.appendChild(div);
    renderHpCopTable(result.cop_curve_points);
    return;
  }

  if (result.validation_status === 'no_gas') {
    const div = document.createElement('div');
    div.className = 'status-msg info';
    div.textContent = 'No gas supply detected. COP curve shown for reference; HP sizing unavailable without a gas-derived heat loss measurement.';
    hpModelStatus.appendChild(div);
  } else if (result.validation_status === 'no_htc') {
    const div = document.createElement('div');
    div.className = 'status-msg info';
    div.textContent = 'Heat loss data unavailable — HP sizing requires a heat loss result. COP curve shown for reference.';
    hpModelStatus.appendChild(div);
  } else if (result.validation_status === 'no_setpoint') {
    const div = document.createElement('div');
    div.className = 'status-msg info';
    div.textContent = 'Thermostat setpoint not available — HP sizing requires a setpoint estimate. COP curve shown for reference.';
    hpModelStatus.appendChild(div);
  }

  const fmt = (v, dp = 2) => v !== null && v !== undefined ? v.toFixed(dp) : '—';
  const rows = [];

  if (result.hp_capacity_kw !== null) {
    rows.push(['Required heat output at −3°C', `${fmt(result.hp_capacity_kw, 1)} kW`]);
  }
  if (result.annual_mean_cop !== null) {
    rows.push(['Estimated mean annual COP', fmt(result.annual_mean_cop)]);
  }
  if (result.cop_range !== null) {
    rows.push(['COP range (coldest to warmest days)', `${fmt(result.cop_range.min)} — ${fmt(result.cop_range.max)}`]);
  }

  hpModelSummary.innerHTML = rows
    .map(([dt, dd]) => `<dt>${escapeHtml(String(dt))}</dt><dd>${escapeHtml(String(dd))}</dd>`)
    .join('');

  renderHpCopTable(result.cop_curve_points);
}

async function runHeatPumpModel(showProgressFn, showStatusFn) {
  const externalResult = getExternalResult();
  const baseloadResult = getBaseloadResult();
  const heatLossResult = getHeatLossResult();
  const thermalChar    = getThermalCharacterResult();
  if (!externalResult || !baseloadResult) return;

  showProgressFn('Modelling heat pump performance…');

  const scalar = parseFloat(copScalarInput.value) || 1.0;

  let result;
  try {
    result = estimateHeatPumpModel(
      externalResult.external,
      baseloadResult.heating,
      heatLossResult,
      thermalChar,
      baseloadResult.baseload_metadata.method,
      scalar,
    );
  } catch (err) {
    showStatusFn('Heat pump modelling failed: ' + err.message, 'error');
    console.error('runHeatPumpModel error:', err);
    return;
  }

  setHeatPumpModelResult(result);
  hpModelCard.classList.remove('hidden');
  displayHeatPumpModelResults(result);
}

btnRecalcHpModel.addEventListener('click', async () => {
  btnRecalcHpModel.disabled = true;
  hpModelStatus.innerHTML  = '';
  hpModelSummary.innerHTML = '';
  hpCopTableBody.innerHTML = '';
  hpModelResults.classList.add('hidden');
  await runHeatPumpModel(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      hpModelStatus.appendChild(div);
    }
  );
  btnRecalcHpModel.disabled = false;
});

// ===== Module 7: Scenario Consumption =====

function buildRateArrays(consumption, external, tariffRates) {
  const n = consumption.length;
  const gasRateByHh    = new Array(n);
  const elecHhRateByHh = new Array(n);

  const gasWindows = [...tariffRates.gas].sort((a, b) =>
    new Date(a.valid_from) - new Date(b.valid_from));

  for (let i = 0; i < n; i++) {
    const tsDate = new Date(consumption[i].timestamp);

    let gasRate = null;
    for (const w of gasWindows) {
      if (new Date(w.valid_from) > tsDate) break;
      if (!w.valid_to || new Date(w.valid_to) > tsDate) gasRate = w.rate_p_kwh;
    }
    gasRateByHh[i]    = gasRate;
    elecHhRateByHh[i] = external[i]?.wholesale_p_kwh ?? null;
  }

  return { gasRateByHh, elecHhRateByHh };
}

const SCENARIO_LABELS = {
  current:     'Your current boiler',
  dumb_hp_svt: 'Heat pump — flat-rate tariff',
  dumb_hp_hh:  'Heat pump — half-hourly tariff',
  smart_hp_hh: 'Smart heat pump — half-hourly tariff',
};

function displayScenarioResults(result) {
  scenarioStatus.innerHTML = '';
  scenarioSummary.querySelector('tbody').innerHTML = '';
  scenarioResults.classList.remove('hidden');

  for (const warning of result.warnings) {
    const div = document.createElement('div');
    div.className = 'status-msg warning';
    div.textContent = warning;
    scenarioStatus.appendChild(div);
  }

  if (result.validation_status.dumb === 'no_data') {
    const div = document.createElement('div');
    div.className = 'status-msg info';
    div.textContent = 'No gas heating detected — heat pump scenarios cannot be modelled.';
    scenarioStatus.appendChild(div);
    return;
  }

  function totalKwh(arr) {
    let s = 0;
    for (const v of arr) if (v !== null) s += v;
    return s;
  }

  const { scenarios, validation_status } = result;
  const tbody = scenarioSummary.querySelector('tbody');

  for (const [key, label] of Object.entries(SCENARIO_LABELS)) {
    const sc      = scenarios[key];
    const gasKwh  = totalKwh(sc.gas_kwh);
    const elecKwh = totalKwh(sc.elec_kwh);
    let notes = '';

    if (key === 'smart_hp_hh') {
      if (validation_status.smart === 'hp_undersized') {
        notes = 'HP undersized — resistive backup applied';
      } else if (validation_status.smart !== 'ok') {
        notes = validation_status.smart.replace(/_/g, ' ');
      }
    } else if (key === 'dumb_hp_svt' || key === 'dumb_hp_hh') {
      if (validation_status.dumb === 'partial') {
        notes = 'partial (some HP COP data missing)';
      }
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(label)}</td>
      <td>${Math.round(gasKwh).toLocaleString()}</td>
      <td>${Math.round(elecKwh).toLocaleString()}</td>
      <td>${escapeHtml(notes)}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function runScenarioConsumption(showProgressFn, showStatusFn) {
  const ingestion      = getIngestionResult();
  const externalResult = getExternalResult();
  const baseloadResult = getBaseloadResult();
  const heatLossResult = getHeatLossResult();
  const thermalChar    = getThermalCharacterResult();
  const hpModel        = getHeatPumpModelResult();
  if (!ingestion || !externalResult || !baseloadResult || !hpModel) return;

  showProgressFn('Computing scenarios (this is the longest step)…');

  // Yield to the browser so the progress message paints before the greedy LP runs
  await new Promise(r => setTimeout(r, 0));

  const { gasRateByHh, elecHhRateByHh } = buildRateArrays(
    ingestion.consumption, externalResult.external, ingestion.tariff_rates);

  const comfortScale = (thermalChar?.underheat_ratio != null)
    ? parseFloat(heatToComfortSlider.value)
    : undefined;

  let result;
  try {
    result = estimateScenarioConsumption({
      heating:         baseloadResult.heating,
      external:        externalResult.external,
      heatLoss:        heatLossResult,
      thermalCharacter: thermalChar,
      heatPumpModel:   hpModel,
      baseloadMethod:  baseloadResult.baseload_metadata.method,
      gasRateByHh, elecHhRateByHh,
      comfort_demand_scale: comfortScale,
    });
  } catch (err) {
    showStatusFn('Scenario computation failed: ' + err.message, 'error');
    console.error('runScenarioConsumption error:', err);
    return;
  }

  setScenarioConsumptionResult(result);
  scenarioCard.classList.remove('hidden');
  displayScenarioResults(result);
}

btnRecalcScenario.addEventListener('click', async () => {
  btnRecalcScenario.disabled = true;
  scenarioStatus.innerHTML = '';
  scenarioSummary.querySelector('tbody').innerHTML = '';
  scenarioResults.classList.add('hidden');
  await runScenarioConsumption(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      scenarioStatus.appendChild(div);
    }
  );
  btnRecalcScenario.disabled = false;
});

// ===== Module 8: Pricing Engine =====

const SCENARIO_DISPLAY_NAMES = {
  current:     'Your current boiler',
  dumb_hp_svt: 'Heat pump — flat-rate tariff',
  dumb_hp_hh:  'Heat pump — half-hourly tariff',
  smart_hp_hh: 'Smart heat pump — half-hourly tariff',
};

function prefillRateInputs(tariffRates) {
  const gasArr  = tariffRates.gas;
  const elecArr = tariffRates.electricity;
  if (gasArr.length)  gasStandingInput.value  = gasArr[gasArr.length - 1].standing_p_day.toFixed(2);
  if (elecArr.length) elecStandingInput.value = elecArr[elecArr.length - 1].standing_p_day.toFixed(2);
}

function displayPricingResults(pricingResult) {
  pricingSummary.innerHTML = '';
  pricingStatus.innerHTML  = '';

  const rateMetadata = getRateMetadata();

  const fmtGbp = (v) => {
    if (v === null || v === undefined || v === 0) return '—';
    return '£' + Math.round(v).toLocaleString('en-GB');
  };

  let hasNullSmart = false;
  const rows = ['current', 'dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh'].map(key => {
    const sc     = pricingResult.scenarios[key];
    const isNull = sc.annual_cost_gbp === null;
    if (isNull) hasNullSmart = true;
    const total = isNull ? null
                : (sc.heating_gas_gbp     ?? 0)
                + (sc.heating_elec_gbp    ?? 0)
                + (sc.non_heating_gas_gbp  ?? 0)
                + (sc.non_heating_elec_gbp ?? 0);
    return `<tr>
      <td>${escapeHtml(SCENARIO_DISPLAY_NAMES[key])}</td>
      <td>${fmtGbp(sc.heating_gas_gbp)}</td>
      <td>${fmtGbp(sc.heating_elec_gbp)}</td>
      <td>${fmtGbp(sc.non_heating_gas_gbp)}</td>
      <td>${fmtGbp(sc.non_heating_elec_gbp)}</td>
      <td>${fmtGbp(total)}</td>
    </tr>`;
  }).join('');

  const calibrationWarning = rateMetadata?.calibration_source === 'default'
    ? `<p class="status-msg warning">Couldn't fetch live Agile rates for your region — using typical UK averages (D=2.2, P=12p/kWh peak). Numbers are indicative; your actual Agile rate will differ.</p>`
    : '';

  pricingSummary.innerHTML = `
    ${calibrationWarning}
    <div class="table-scroll-wrap">
      <table class="energy-summary-table">
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Heating gas (£/yr)</th>
            <th>Heating elec (£/yr)</th>
            <th>Non-heating gas (£/yr)</th>
            <th>Non-heating elec (£/yr)</th>
            <th>Total (£/yr)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="field-note">All heat pump scenarios retain the gas connection. Non-heating gas includes the gas standing charge and any baseload gas use.</p>
    <p class="field-note">Heat pump scenario electricity costs use the current Ofgem price cap rate (electricity: ${OFGEM_CAP_ELEC_P_KWH}p/kWh). Gas costs (for the retained connection and baseload) and your current boiler costs use your actual historical tariff rates.</p>
    ${hasNullSmart ? '<p class="status-msg info" style="margin-top:0.75rem;">Smart HP scenario unavailable — insufficient heat loss or heat pump capacity data.</p>' : ''}
  `;

  for (const w of (rateMetadata?.warnings ?? [])) {
    const div = document.createElement('div');
    div.className = 'status-msg warning';
    div.textContent = w;
    pricingStatus.appendChild(div);
  }
  for (const w of pricingResult.warnings) {
    const div = document.createElement('div');
    div.className = 'status-msg warning';
    div.textContent = w;
    pricingStatus.appendChild(div);
  }

  pricingResults.classList.remove('hidden');
  pricingCard.classList.remove('hidden');
  pricingParamsCard.classList.remove('hidden');
  btnRecalcPricing.classList.remove('hidden');
  bannerVerdict.classList.remove('hidden');
  bannerAssumptions.classList.remove('hidden');
}

async function runPricingEngine(showProgressFn, showStatusFn) {
  const ingestion      = getIngestionResult();
  const external       = getExternalResult();
  const scenarioResult = getScenarioConsumptionResult();

  if (!ingestion || !external) {
    showStatusFn('Ingestion or external data not available.', 'error');
    return;
  }
  if (!scenarioResult) {
    showStatusFn('Scenario consumption not yet computed.', 'error');
    return;
  }

  showProgressFn('Computing tariff rates…');
  const baseloadResult   = getBaseloadResult();
  const agileCalibration = getExternalResult()?.external_metadata?.agile_calibration ?? null;
  const params = {
    ...readRateParams(),
    agile_calibration: agileCalibration,
  };
  const rateMetadata = prepareRates(ingestion, external.external, params);
  setRateMetadata(rateMetadata);

  showProgressFn('Computing scenario costs…');
  const pricingResult = computeCosts(
    rateMetadata, scenarioResult, params,
    baseloadResult?.heating ?? null,
  );
  setPricingResult(pricingResult);

  displayPricingResults(pricingResult);

  for (const w of rateMetadata.warnings)  showStatusFn(w, 'warning');
  for (const w of pricingResult.warnings) showStatusFn(w, 'warning');
}

btnRecalcPricing.addEventListener('click', async () => {
  btnRecalcPricing.disabled = true;
  pricingStatus.innerHTML   = '';
  pricingSummary.innerHTML  = '';
  pricingResults.classList.add('hidden');
  await runPricingEngine(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      pricingStatus.appendChild(div);
    }
  );
  btnRecalcPricing.disabled = false;
});

// ===== Module 9: Financial Analysis =====

const FINANCIAL_DISPLAY_NAMES = {
  current:     'Your current boiler',
  dumb_hp_svt: 'Heat pump — flat-rate tariff',
  dumb_hp_hh:  'Heat pump — half-hourly tariff',
  smart_hp_hh: 'Smart heat pump — half-hourly tariff',
};

const FINANCIAL_DISPLAY_ORDER = ['current', 'dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh'];

function fmtGbpSaving(v) {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v > 0) return `£${abs}`;
  if (v < 0) return `−£${abs}`;
  return '£0.00';
}

function fmtPayback(status, years) {
  if (status === 'no_data')   return '—';
  if (status === 'no_saving') return 'No saving';
  if (years === 0)            return 'Immediate';
  if (years > 40)             return '>40 years';
  return `${years.toFixed(1)} years`;
}

function displayFinancialResults(result) {
  financialSummary.innerHTML = '';
  financialStatus.innerHTML  = '';

  const fmtGbp = (v) => {
    if (v === null || v === undefined) return '—';
    return '£' + v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const rows = FINANCIAL_DISPLAY_ORDER.map(key => {
    const sc = result.scenarios[key];
    const isBaseline = key === 'current';
    return `<tr>
      <td>${escapeHtml(FINANCIAL_DISPLAY_NAMES[key])}</td>
      <td>${fmtGbp(sc.annual_cost_gbp)}</td>
      <td>${isBaseline ? '—' : fmtGbpSaving(sc.annual_saving_gbp)}</td>
      <td>${isBaseline ? '—' : fmtGbp(sc.net_investment_gbp)}</td>
      <td>${isBaseline ? '—' : fmtPayback(sc.payback_status, sc.payback_years)}</td>
    </tr>`;
  }).join('');

  const breakEvenHtml = result.break_even.break_even_interpretation
    ? `<p class="break-even-text">${escapeHtml(result.break_even.break_even_interpretation)}</p>`
    : '';

  financialSummary.innerHTML = `
    <table class="energy-summary-table">
      <thead>
        <tr>
          <th>Scenario</th>
          <th>Annual cost</th>
          <th>Annual saving</th>
          <th>Net cost (after grant)</th>
          <th>Payback period</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${breakEvenHtml}
    <p class="card-intro" style="margin-top:0.75rem;">
      Note: the Boiler Upgrade Scheme grant (£7,500) applies to standalone heat pump
      installations only.
    </p>
  `;

  for (const w of result.warnings) {
    const div = document.createElement('div');
    div.className = 'status-msg warning';
    div.textContent = w;
    financialStatus.appendChild(div);
  }

  financialResults.classList.remove('hidden');
  financialCard.classList.remove('hidden');
  financialParamsCard.classList.remove('hidden');
  btnRecalcFinancial.classList.remove('hidden');

  const heatLossRes = getHeatLossResult();
  const rateMeta    = getRateMetadata();
  if (rateMeta) {
    buildAndDisplayVerdict(result, heatLossRes, rateMeta);
  }
}

// ===== Module 10a: Verdict Block =====

const VERDICT_CHART_LABELS = {
  current:     'Current boiler',
  dumb_hp_svt: 'HP — flat rate',
  dumb_hp_hh:  'HP — half-hourly',
  smart_hp_hh: 'Smart HP — HH',
};

function buildVerdictStatusMessage(financialResult) {
  const sc = k => financialResult.scenarios[k];

  // Condition A — smart HP unavailable but dumb HH available (thermal-mass data missing)
  const smart  = sc('smart_hp_hh');
  const dumbHh = sc('dumb_hp_hh');
  if (smart?.payback_status === 'no_data'
      && dumbHh != null
      && dumbHh.payback_status !== 'no_data') {
    return {
      html: `Smart heat pump results are unavailable — thermal mass data is needed.
        <button class="fix-link">Provide that input ↓</button>`,
      fixHandler: () => {
        const disclosure = document.getElementById('methodology-disclosure');
        disclosure.open = true;
        const targetCard = document.getElementById('thermal-char-card');
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
          const tauBucket  = document.getElementById('tau-bucket');
          const tAtRestart = document.getElementById('t-at-restart');
          let target = null;
          if (tauBucket && tauBucket.value === '') target = tauBucket;
          else if (tAtRestart && tAtRestart.value === '') target = tAtRestart;
          else target = tauBucket || tAtRestart;
          if (target) {
            target.focus();
            target.classList.add('highlight-flash');
            setTimeout(() => target.classList.remove('highlight-flash'), 1500);
          }
        }, 400);
      },
    };
  }

  // Condition B — all HH scenarios unavailable (price data missing); SVT still available
  const hhKeys = ['dumb_hp_hh', 'smart_hp_hh'];
  const allHhMissing = hhKeys.every(k => sc(k)?.payback_status === 'no_data');
  const svtAvailable = sc('dumb_hp_svt')?.payback_status !== 'no_data';
  if (allHhMissing && svtAvailable) {
    return {
      html: `Half-hourly price data could not be loaded — results use flat-rate tariff figures only.`,
      fixHandler: null,
    };
  }

  return null;
}

function buildAndDisplayVerdict(financialResult, heatLossResult, rateMetadata) {
  const sc = (key) => financialResult.scenarios[key];

  // Step 16a — identify primary scenario
  const priority = ['smart_hp_hh', 'dumb_hp_hh', 'dumb_hp_svt'];
  const primaryKey = priority.find(k => sc(k).payback_status !== 'no_data') ?? null;

  // Step 16b — determine verdict type (clarification 4: simplified marginal condition)
  let verdictType;
  if (!primaryKey) {
    verdictType = 'insufficient';
  } else {
    const ps = sc(primaryKey);
    if (ps.payback_status === 'positive' && ps.annual_saving_gbp > 50) {
      verdictType = 'positive';
    } else if (ps.payback_status === 'positive' && ps.annual_saving_gbp > 0) {
      verdictType = 'marginal';
    } else {
      verdictType = 'negative';
    }
  }

  // Step 16c — format helpers
  const fmtGbpVerdict = (v) => `£${Math.abs(Math.round(v)).toLocaleString('en-GB')}`;
  const fmtPaybackYears = (years) => {
    if (years > 30) return 'well beyond a 30-year planning horizon';
    const y = Math.round(years);
    return `${y} year${y === 1 ? '' : 's'}`;
  };

  // Step 16d — build headline HTML
  const currentCost = fmtGbpVerdict(sc('current').annual_cost_gbp ?? 0);
  let headlineHtml = '';

  if (verdictType === 'positive' && primaryKey === 'smart_hp_hh') {
    const saving  = fmtGbpVerdict(sc('smart_hp_hh').annual_saving_gbp);
    const hpCost  = fmtGbpVerdict(sc('smart_hp_hh').annual_cost_gbp);
    const payback = fmtPaybackYears(sc('smart_hp_hh').payback_years);
    const svtAvailable = sc('dumb_hp_svt').payback_status !== 'no_data';

    headlineHtml = `Based on your ${rateMetadata.data_period_days} days of data, a smart heat pump on a
half-hourly tariff would cut your annual heating bill by around <strong>${saving}</strong> — from
<strong>${currentCost}</strong> to <strong>${hpCost}</strong> per year.
At current installation costs, payback would be roughly <strong>${payback}</strong>.`;

    if (svtAvailable) {
      const svtSaving = sc('dumb_hp_svt').annual_saving_gbp;
      if (svtSaving <= 0) {
        headlineHtml += `<br><br>On a standard flat-rate tariff, however, the picture is different — a heat pump
would cost slightly more than your current boiler at current rates. The savings
above depend on switching to a half-hourly tariff.`;
      } else {
        headlineHtml += `<br><br>On a standard flat-rate tariff, the saving falls to about
<strong>${fmtGbpVerdict(svtSaving)}</strong> per year — close to break-even. The additional saving from a half-hourly tariff comes from shifting heating to cheaper overnight periods.`;
      }
    }

  } else if (verdictType === 'positive' && primaryKey === 'dumb_hp_hh') {
    const saving  = fmtGbpVerdict(sc('dumb_hp_hh').annual_saving_gbp);
    const hpCost  = fmtGbpVerdict(sc('dumb_hp_hh').annual_cost_gbp);
    const payback = fmtPaybackYears(sc('dumb_hp_hh').payback_years);
    const svtAvailable = sc('dumb_hp_svt').payback_status !== 'no_data';

    headlineHtml = `Based on your ${rateMetadata.data_period_days} days of data, a heat pump on a
half-hourly tariff would cut your annual heating bill by around <strong>${saving}</strong> — from
<strong>${currentCost}</strong> to <strong>${hpCost}</strong> per year.
Payback is roughly <strong>${payback}</strong> at current installation costs.`;

    if (svtAvailable) {
      headlineHtml += `<br><br>On a flat-rate tariff, the saving falls to about
<strong>${fmtGbpVerdict(sc('dumb_hp_svt').annual_saving_gbp)}</strong> per year.`;
    }

  } else if (verdictType === 'positive' && primaryKey === 'dumb_hp_svt') {
    const saving  = fmtGbpVerdict(sc('dumb_hp_svt').annual_saving_gbp);
    const hpCost  = fmtGbpVerdict(sc('dumb_hp_svt').annual_cost_gbp);
    const payback = fmtPaybackYears(sc('dumb_hp_svt').payback_years);

    headlineHtml = `Based on your ${rateMetadata.data_period_days} days of data, a heat pump on a
flat-rate tariff would cut your annual heating bill by around <strong>${saving}</strong> — from
<strong>${currentCost}</strong> to <strong>${hpCost}</strong> per year.
Payback is roughly <strong>${payback}</strong> at current installation costs.`;

  } else if (verdictType === 'marginal') {
    const saving = fmtGbpVerdict(sc(primaryKey).annual_saving_gbp);
    headlineHtml = `Based on your data, the best heat pump scenario saves around <strong>${saving}</strong>
per year — roughly break-even against your current boiler. Whether it makes sense depends on
factors beyond running costs: the reliability of your existing boiler and future energy prices. Use the assumptions panel below to explore.`;

  } else if (verdictType === 'negative') {
    const absSaving = fmtGbpVerdict(Math.abs(sc(primaryKey).annual_saving_gbp ?? 0));
    headlineHtml = `On your data, our modelling suggests a heat pump would cost slightly more to run
than your current boiler — by about <strong>${absSaving}</strong> per year on the best scenario.
This can shift significantly with tariff choice, installation quality, and future gas prices.
Use the assumptions panel below to explore.`;

  } else {
    headlineHtml = `We couldn't get a confident picture from your data — you'll see why in the
methodology section below. The figures in the tables are rough estimates only.`;
  }

  verdictHeadline.innerHTML = headlineHtml;

  // Step 16e — data-quality footnote
  const r2      = heatLossResult?.regression_r2;
  const vstatus = heatLossResult?.validation_status;
  const n       = rateMetadata.data_period_days;
  let qualityText;

  if (r2 === null || r2 === undefined || !['good', 'acceptable'].includes(vstatus)) {
    qualityText = 'Heat-loss estimation was not possible from your data — running cost figures are rough estimates only.';
  } else if (r2 >= 0.80) {
    qualityText = `Analysis based on ${n} days of smart meter data. Fit quality: good (R²=${r2.toFixed(2)}) — accuracy is typically ±15–20% on the heat-loss estimate.`;
  } else if (r2 >= 0.60) {
    qualityText = `Fit quality: fair (R²=${r2.toFixed(2)}) — treat these figures as a rough guide rather than a precise prediction.`;
  } else {
    qualityText = `Fit quality: poor (R²=${r2.toFixed(2)}) — the heat-loss estimate is unreliable. Consider a professional survey before making a decision.`;
  }
  verdictQuality.textContent = qualityText;

  // Step 16e-ii — verdict status line
  const statusMsg = buildVerdictStatusMessage(financialResult);
  if (statusMsg) {
    verdictStatus.innerHTML = statusMsg.html;
    verdictStatus.classList.remove('hidden');
    if (statusMsg.fixHandler) {
      const link = verdictStatus.querySelector('.fix-link');
      if (link) link.addEventListener('click', statusMsg.fixHandler);
    }
  } else {
    verdictStatus.classList.add('hidden');
    verdictStatus.innerHTML = '';
  }

  // Step 16g — scenario bar chart
  if (verdictChart) verdictChart.destroy();

  const scenarioOrder = ['current', 'dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh'];
  const chartData = scenarioOrder
    .filter(k => financialResult.scenarios[k].annual_cost_gbp !== null)
    .map(k => ({
      key:    k,
      label:  VERDICT_CHART_LABELS[k],
      cost:   financialResult.scenarios[k].annual_cost_gbp,
      saving: financialResult.scenarios[k].annual_saving_gbp,
    }));

  const bgColors = chartData.map(d =>
    d.key === 'current' ? '#26588D' : (d.saving > 0 ? '#3B8284' : '#FD7A7F')
  );

  const ctx = document.getElementById('verdict-chart').getContext('2d');
  verdictChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: chartData.map(d => d.label),
      datasets: [{ data: chartData.map(d => d.cost), backgroundColor: bgColors }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `£${Math.round(ctx.parsed.x).toLocaleString('en-GB')}/yr`,
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: 'Annual cost (£/yr)' },
          ticks: { callback: v => `£${Math.round(v).toLocaleString('en-GB')}` },
        },
        y: { ticks: { font: { size: 12 } } },
      },
    },
  });

  // Step 16h — reveal verdict card
  verdictCard.classList.remove('hidden');
}

async function runFinancialAnalysis(showProgressFn, showStatusFn) {
  const pricingResult  = getPricingResult();
  const rateMetadata   = getRateMetadata();
  const scenarioResult = getScenarioConsumptionResult();

  if (!pricingResult || !rateMetadata) {
    showStatusFn('Pricing data not yet computed.', 'error');
    return;
  }
  if (!scenarioResult) {
    showStatusFn('Scenario consumption not available.', 'error');
    return;
  }

  showProgressFn('Computing financial analysis…');
  const params = readCapitalParams();
  const result = analyseFinancials(pricingResult, rateMetadata, scenarioResult, params);
  setFinancialResult(result);

  displayFinancialResults(result);

  for (const w of result.warnings) showStatusFn(w, 'warning');
}

btnRecalcFinancial.addEventListener('click', async () => {
  btnRecalcFinancial.disabled = true;
  financialStatus.innerHTML   = '';
  financialSummary.innerHTML  = '';
  financialResults.classList.add('hidden');
  await runFinancialAnalysis(
    () => {},
    (msg, type) => {
      const div = document.createElement('div');
      div.className = `status-msg ${type}`;
      div.textContent = msg;
      financialStatus.appendChild(div);
    }
  );
  btnRecalcFinancial.disabled = false;
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
  const count = csvStatusArea.children.length;
  csvStatusSummary.textContent = `${count} notice${count === 1 ? '' : 's'}`;
  csvStatusDetails.classList.remove('hidden');
}

function clearCsvStatus() {
  csvStatusArea.innerHTML = '';
  csvStatusSummary.textContent = '0 notices';
  csvStatusDetails.classList.add('hidden');
  csvStatusDetails.removeAttribute('open');
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
      gsp_region: document.getElementById('gsp-region')?.value || null,
    });
    prefillRateInputs(tariffRates);

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

    // Step 13: Trigger Module 6 — Heat Pump Model
    await runHeatPumpModel(
      (text) => showCsvProgress(text),
      (msg, type) => showCsvStatus(msg, type)
    );

    // Step 14: Trigger Module 7 — Scenario Consumption
    await runScenarioConsumption(
      (text) => showCsvProgress(text),
      (msg, type) => showCsvStatus(msg, type)
    );

    // Step 15: Trigger Module 8 — Pricing Engine
    await runPricingEngine(
      (text) => showCsvProgress(text),
      (msg, type) => showCsvStatus(msg, type)
    );

    // Step 16: Trigger Module 9 — Financial Analysis
    await runFinancialAnalysis(
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
window.__getIngestionResult           = () => getIngestionResult();
window.__getExternalResult            = () => getExternalResult();
window.__getBaseloadResult            = () => getBaseloadResult();
window.__getHeatLossResult            = () => getHeatLossResult();
window.__getThermalCharacterResult    = () => getThermalCharacterResult();
window.__getHeatPumpModelResult       = () => getHeatPumpModelResult();
window.__getScenarioConsumptionResult = () => getScenarioConsumptionResult();
window.__buildRateArrays              = (cs, ex, tr) => buildRateArrays(cs, ex, tr);
window.__getRateMetadata              = () => getRateMetadata();
window.__getPricingResult             = () => getPricingResult();
window.__getFinancialResult           = () => getFinancialResult();
