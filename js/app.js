// ===== App Orchestration =====
// Wires UI events to data-ingestion functions.

import {
  CONFIG,
  fetchAccount,
  fetchConsumption,
  buildGasUnitCheck,
  convertM3ToKwh,
  buildTariffTimeline,
  normaliseConsumption,
  setIngestionResult,
  getIngestionResult,
} from './data-ingestion.js';

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

  // Step 2: Fetch consumption
  showProgress('Fetching consumption data…', 30);
  const { elecRecords, gasRecords } = await fetchConsumption(
    apiKey, prop.mpan, prop.mprn, prop.elecSerial, prop.gasSerial
  );
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
      gasCheckSummer.textContent = check.summerDailyCost !== null
        ? formatPounds(check.summerDailyCost) + '/day'
        : 'no summer data';
      gasCheckWinter.textContent = check.winterDailyCost !== null
        ? formatPounds(check.winterDailyCost) + '/day'
        : 'no winter data';
      gasM3Toggle.checked = false;
      gasCheckArea.classList.remove('hidden');

      // Wait for user confirmation
      await waitForGasConfirmation();
    }
  }

  // Step 4: Fetch tariff rates
  showProgress('Fetching tariff rates…', 55);

  let elecTariffRates = [];
  let gasTariffRates = [];

  if (prop.elecAgreements.length > 0) {
    showProgress('Fetching electricity tariff rates…', 60);
    elecTariffRates = await buildTariffTimeline(
      prop.elecAgreements, 'electricity', 'DIRECT_DEBIT',
      (page) => showProgress(`Fetching electricity tariff rates (page ${page})…`, 60)
    );
  }

  if (prop.gasAgreements.length > 0) {
    showProgress('Fetching gas tariff rates…', 75);
    gasTariffRates = await buildTariffTimeline(
      prop.gasAgreements, 'gas', 'DIRECT_DEBIT',
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
    gas_unit_source: gasM3Toggle.checked ? 'm3_converted' : 'kwh_native',
    input_path: 'octopus',
  };

  setIngestionResult({
    consumption: normalised.consumption,
    tariff_rates: tariffRates,
    metadata: fullMetadata,
  });

  // Step 8: Show success
  hideProgress();
  showSuccessSummary(normalised, tariffRates, fullMetadata);
  setFetchEnabled(true);
}

// ===== Gas Confirmation =====

function waitForGasConfirmation() {
  return new Promise((resolve) => {
    const handler = () => {
      if (gasM3Toggle.checked) {
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
      <dt>Gas units</dt>
      <dd>${meta.gas_unit_source === 'm3_converted' ? 'Converted from m³' : 'Native kWh'}</dd>
    </dl>
  `;

  resultsCard.classList.remove('hidden');
  showStatus('Data loaded successfully.', 'success');
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  // Nothing else needed at init for Phase 1
});
