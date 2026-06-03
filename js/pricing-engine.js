// ===== M8: Pricing Engine =====
// Applies tariff rates to M7 scenario consumption to produce annual costs and monthly breakdowns.

export const PE_CONFIG = {
  EXTREME_NEG_WHOLESALE_P:    -20.0,    // warn threshold (p/kWh)
  PARTIAL_MONTH_DAY_THRESHOLD: 20,      // < this days in month → partial: true
  MIN_DAYS_WARN:               90,      // < 90 days → annual estimate reliability warning
};


const SCENARIO_FUELS = {
  current:     ['gas', 'electricity'],
  dumb_hp_svt: ['gas', 'electricity'],
  dumb_hp_hh:  ['gas', 'electricity'],
  smart_hp_hh: ['gas', 'electricity'],
};

const SCENARIO_ELEC_RATE_TYPE = {
  current:     'none',
  dumb_hp_svt: 'svt',
  dumb_hp_hh:  'hh',
  smart_hp_hh: 'hh',
};

const SCENARIO_ORDER = ['current', 'dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh'];

// ===== State =====

let _rateMetadata  = null;
let _pricingResult = null;

export function setRateMetadata(r)  { _rateMetadata  = r; }
export function getRateMetadata()   { return _rateMetadata; }
export function setPricingResult(r) { _pricingResult = r; }
export function getPricingResult()  { return _pricingResult; }

// ===== Phase A: prepareRates =====

export function prepareRates(ingestion, m2Result, params) {
  const warnings = [];

  const n = ingestion.consumption.length;
  const data_period_days = new Set(
    ingestion.consumption.map(r => r.timestamp.slice(0, 10))
  ).size;

  const agile_calibration = m2Result.agile_calibration;
  const calibration_source = agile_calibration?.source ?? 'unknown';

  // §14 overrides — uniform fill if provided; otherwise use m2Result per-HH arrays
  const gas_rate_by_hh = params.gas_rate_override_p_kwh != null
    ? new Array(n).fill(params.gas_rate_override_p_kwh)
    : m2Result.gas_rate;

  const flat_rate_by_hh = params.svt_rate_p_per_kwh != null
    ? new Array(n).fill(params.svt_rate_p_per_kwh)
    : m2Result.flat_rate;

  const elec_hh_rate_by_hh = m2Result.hh_rate;

  // Standing charges — §14 override, else m2Result
  const gas_standing_p_day  = params.gas_standing_charge_p ?? m2Result.standing_charge.gas;
  const elec_standing_p_day = params.svt_standing_charge_p ?? m2Result.standing_charge.elec;

  if (data_period_days === 0) {
    warnings.push('No consumption data found — cannot compute costs.');
    return {
      gas_rate_by_hh: [],
      elec_hh_rate_by_hh: [],
      flat_rate_by_hh: [],
      gas_standing_charge_p_per_day:  gas_standing_p_day,
      elec_standing_charge_p_per_day: elec_standing_p_day,
      data_period_days: 0,
      calibration_source,
      agile_calibration,
      consumption: ingestion.consumption,
      warnings,
    };
  }

  if (data_period_days < PE_CONFIG.MIN_DAYS_WARN) {
    warnings.push('Less than 3 months of data — annual cost estimates may be unreliable.');
  }

  return {
    gas_rate_by_hh,
    elec_hh_rate_by_hh,
    flat_rate_by_hh,
    gas_standing_charge_p_per_day:  gas_standing_p_day,
    elec_standing_charge_p_per_day: elec_standing_p_day,
    data_period_days,
    calibration_source,
    agile_calibration,
    consumption: ingestion.consumption,
    warnings,
  };
}

// ===== Helpers =====

function buildMonthGroups(consumption) {
  const map = new Map();
  for (let i = 0; i < consumption.length; i++) {
    const ts    = consumption[i].timestamp;
    const month = ts.slice(0, 7);
    if (!map.has(month)) map.set(month, { indices: [], dates: new Set() });
    const entry = map.get(month);
    entry.indices.push(i);
    entry.dates.add(ts.slice(0, 10));
  }
  const result = new Map();
  for (const [month, { indices, dates }] of map) {
    result.set(month, {
      indices,
      distinctDates: dates.size,
      partial: dates.size < PE_CONFIG.PARTIAL_MONTH_DAY_THRESHOLD,
    });
  }
  return result;
}

function electricityRateForHH(scenario, i, rateMetadata) {
  if (scenario === 'current')     return 0;
  if (scenario === 'dumb_hp_svt') return rateMetadata.flat_rate_by_hh[i];
  return rateMetadata.elec_hh_rate_by_hh[i];
}

// ===== Phase B: computeCosts =====

export function computeCosts(rateMetadata, scenarioResult, params, baseloadHeating = null) {
  const pricingWarnings = [];

  const gasSc  = params.gas_standing_charge_p ?? rateMetadata.gas_standing_charge_p_per_day;
  const elecSc = params.svt_standing_charge_p ?? rateMetadata.elec_standing_charge_p_per_day;

  const monthGroups = buildMonthGroups(rateMetadata.consumption);
  const { scenarios, validation_status } = scenarioResult;
  const scenarioCosts = {};

  // Cost decomposition — non-heating components (identical across scenarios)
  // non_heating_gas = baseload gas energy + gas standing charge (annualised)
  // non_heating_elec = electricity standing charge only (annualised)
  const scale = 365 / (rateMetadata.data_period_days || 365);
  let non_heating_gas_pence = 0;
  if (baseloadHeating) {
    for (let i = 0; i < baseloadHeating.length; i++) {
      const bl = baseloadHeating[i]?.baseload_kwh ?? 0;
      non_heating_gas_pence += bl * (rateMetadata.gas_rate_by_hh[i] ?? 0);
    }
  }
  const gas_sc_period_gbp  = gasSc  * rateMetadata.data_period_days / 100;
  const elec_sc_period_gbp = elecSc * rateMetadata.data_period_days / 100;
  const non_heating_gas_gbp_annual  = (non_heating_gas_pence / 100 + gas_sc_period_gbp)  * scale;
  const non_heating_elec_gbp_annual = elec_sc_period_gbp * scale;

  for (const name of SCENARIO_ORDER) {
    if (name === 'smart_hp_hh' && validation_status.smart !== 'ok') {
      scenarioCosts[name] = {
        annual_cost_gbp:       null,
        energy_cost_gbp:       null,
        gas_energy_cost_gbp:   null,
        elec_energy_cost_gbp:  null,
        standing_charge_gbp:   null,
        monthly_breakdown:     null,
        fuels_supplied:        SCENARIO_FUELS[name],
        electricity_rate_type: SCENARIO_ELEC_RATE_TYPE[name],
        heating_gas_gbp:       null,
        heating_elec_gbp:      null,
        non_heating_gas_gbp:   null,
        non_heating_elec_gbp:  null,
      };
      continue;
    }

    const { gas_kwh, elec_kwh } = scenarios[name];
    let gas_pence  = 0;
    let elec_pence = 0;
    for (let i = 0; i < gas_kwh.length; i++) {
      const g = gas_kwh[i]  ?? 0;
      const e = elec_kwh[i] ?? 0;
      gas_pence  += g * rateMetadata.gas_rate_by_hh[i];
      elec_pence += e * electricityRateForHH(name, i, rateMetadata);
    }
    const gas_energy_cost_gbp  = gas_pence  / 100;
    const elec_energy_cost_gbp = elec_pence / 100;
    const energy_cost_gbp      = gas_energy_cost_gbp + elec_energy_cost_gbp;

    const fuels = SCENARIO_FUELS[name];
    const sc_pence_per_day = (fuels.includes('gas') ? gasSc : 0)
                           + (fuels.includes('electricity') ? elecSc : 0);
    const standing_charge_gbp = sc_pence_per_day * rateMetadata.data_period_days / 100;

    const annual_cost_gbp = (energy_cost_gbp + standing_charge_gbp) * scale;

    // Monthly breakdown — same rate logic as annual loop for structural consistency
    const monthly_breakdown = [];
    for (const [month, group] of monthGroups) {
      let monthly_energy_pence = 0;
      for (const i of group.indices) {
        const g = gas_kwh[i]  ?? 0;
        const e = elec_kwh[i] ?? 0;
        monthly_energy_pence += g * rateMetadata.gas_rate_by_hh[i]
                              + e * electricityRateForHH(name, i, rateMetadata);
      }
      const monthly_sc_gbp = sc_pence_per_day * group.distinctDates / 100;
      monthly_breakdown.push({
        month,
        energy_cost_gbp:     monthly_energy_pence / 100,
        standing_charge_gbp: monthly_sc_gbp,
        total_gbp:           monthly_energy_pence / 100 + monthly_sc_gbp,
        partial:             group.partial,
      });
    }

    // Four-component cost decomposition (all annualised)
    // Current: heating gas = gas_energy (heating_kwh only), non-heating gas = baseload + gas_SC
    // HP scenarios: heating gas = 0, heating elec = elec_energy, non-heating gas = baseload_gas + gas_SC
    const isCurrentScenario = name === 'current';
    const heating_gas_gbp  = isCurrentScenario ? gas_energy_cost_gbp  * scale : 0;
    const heating_elec_gbp = isCurrentScenario ? 0                             : elec_energy_cost_gbp * scale;

    scenarioCosts[name] = {
      annual_cost_gbp,
      energy_cost_gbp,
      gas_energy_cost_gbp,
      elec_energy_cost_gbp,
      standing_charge_gbp,
      monthly_breakdown,
      fuels_supplied:          SCENARIO_FUELS[name],
      electricity_rate_type:   SCENARIO_ELEC_RATE_TYPE[name],
      heating_gas_gbp,
      heating_elec_gbp,
      non_heating_gas_gbp:  non_heating_gas_gbp_annual,
      non_heating_elec_gbp: non_heating_elec_gbp_annual,
    };
  }

  return {
    scenarios: scenarioCosts,
    warnings:  pricingWarnings,
  };
}
