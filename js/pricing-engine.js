// ===== M8: Pricing Engine =====
// Applies tariff rates to M7 scenario consumption to produce annual costs and monthly breakdowns.

export const PE_CONFIG = {
  SVT_RATE_DEFAULT_P:          24.50,   // Ofgem Q2 2026 price cap
  ELEC_STANDING_DEFAULT_P_DAY: 61.64,
  GAS_STANDING_DEFAULT_P_DAY:  31.66,
  HH_OVERHEAD_DEFAULT_P:       13.00,   // retained for backward compat; no longer used in HH rate
  EXTREME_NEG_WHOLESALE_P:    -20.0,    // warn threshold (p/kWh)
  PARTIAL_MONTH_DAY_THRESHOLD: 20,      // < this days in month → partial: true
  MIN_DAYS_WARN:               90,      // < 90 days → annual estimate reliability warning
};

const D_DEFAULT            = 2.2;   // mid of typical UK regional D range (2.0–2.4)
const P_DEFAULT_PEAK_P_KWH = 12;    // mid of typical UK P range (8–16 p/kWh)

function isPeakHour(tsDate) {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: 'numeric', hour12: false,
    }).format(tsDate), 10);
  return hour >= 16 && hour < 19;
}

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

export function prepareRates(ingestion, external, params) {
  const warnings = [];

  const gasWindows = [...ingestion.tariff_rates.gas]
    .sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));

  const n = ingestion.consumption.length;
  const gas_rate_by_hh     = new Array(n);
  const elec_hh_rate_by_hh = new Array(n);
  let warnedNullWholesale = false;
  let warnedGapTariff     = false;
  let hasExtremeNeg       = false;

  // Agile D×W+P calibration — use fetched values or safe defaults
  const calibration = params.agile_calibration ?? {
    D: D_DEFAULT,
    P_peak_p_kwh: P_DEFAULT_PEAK_P_KWH,
    source: 'default',
  };
  const { D, P_peak_p_kwh } = calibration;
  const calibration_source = calibration.source ?? 'fetched';

  for (let i = 0; i < n; i++) {
    const ts     = ingestion.consumption[i].timestamp;
    const tsDate = new Date(ts);

    // Gas rate — use override if provided (Policy Reform what-if), else tariff windowing
    let gasRate;
    if (params.gas_rate_override_p_kwh != null) {
      gasRate = params.gas_rate_override_p_kwh;
    } else {
      // Forward scan through sorted windows
      gasRate = null;
      for (const w of gasWindows) {
        if (new Date(w.valid_from) > tsDate) break;
        if (!w.valid_to || new Date(w.valid_to) > tsDate) { gasRate = w.rate_p_kwh; break; }
      }
      if (gasRate === null) {
        gasRate = gasWindows.findLast(w => new Date(w.valid_from) <= tsDate)?.rate_p_kwh
               ?? gasWindows[0]?.rate_p_kwh ?? 0;
        if (!warnedGapTariff) {
          warnings.push('Gap in gas tariff history — using nearest rate for affected periods.');
          warnedGapTariff = true;
        }
      }
    }
    gas_rate_by_hh[i] = gasRate;

    // HH electricity rate — Agile D×W+P formula
    const wholesale = external[i]?.wholesale_p_kwh;
    const peak      = isPeakHour(tsDate);
    if (wholesale === null || wholesale === undefined) {
      elec_hh_rate_by_hh[i] = peak ? P_peak_p_kwh : 0;
      if (!warnedNullWholesale) {
        warnings.push('Some HH periods have no wholesale price data — using peak uplift only for affected periods.');
        warnedNullWholesale = true;
      }
    } else {
      elec_hh_rate_by_hh[i] = Math.min(
        peak ? D * wholesale + P_peak_p_kwh : D * wholesale,
        100,
      );
      if (wholesale < PE_CONFIG.EXTREME_NEG_WHOLESALE_P && !hasExtremeNeg) {
        warnings.push('Extreme negative wholesale prices found — check Elexon data quality.');
        hasExtremeNeg = true;
      }
    }
  }

  // Standing charges — most recent tariff period, fall back to params then PE_CONFIG
  const gasArr  = ingestion.tariff_rates.gas;
  const elecArr = ingestion.tariff_rates.electricity;
  const gas_standing_p_day  = gasArr[gasArr.length - 1]?.standing_p_day
                            ?? (params.gas_standing_charge_p  ?? PE_CONFIG.GAS_STANDING_DEFAULT_P_DAY);
  const elec_standing_p_day = elecArr[elecArr.length - 1]?.standing_p_day
                            ?? (params.svt_standing_charge_p ?? PE_CONFIG.ELEC_STANDING_DEFAULT_P_DAY);

  const data_period_days = new Set(
    ingestion.consumption.map(r => r.timestamp.slice(0, 10))
  ).size;

  if (data_period_days === 0) {
    warnings.push('No consumption data found — cannot compute costs.');
    return {
      gas_rate_by_hh: [],
      elec_hh_rate_by_hh: [],
      svt_rate_p_per_kwh:             params.svt_rate_p_per_kwh ?? PE_CONFIG.SVT_RATE_DEFAULT_P,
      ofgem_cap_elec_p_kwh:           params.ofgem_cap_elec_p_kwh ?? null,
      gas_standing_charge_p_per_day:  gas_standing_p_day,
      elec_standing_charge_p_per_day: elec_standing_p_day,
      data_period_days: 0,
      calibration_source,
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
    svt_rate_p_per_kwh:             params.svt_rate_p_per_kwh ?? PE_CONFIG.SVT_RATE_DEFAULT_P,
    ofgem_cap_elec_p_kwh:           params.ofgem_cap_elec_p_kwh ?? null,
    gas_standing_charge_p_per_day:  gas_standing_p_day,
    elec_standing_charge_p_per_day: elec_standing_p_day,
    data_period_days,
    calibration_source,
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

function electricityRateForHH(scenario, i, rateMetadata, svtRate) {
  if (scenario === 'current')     return 0;
  if (scenario === 'dumb_hp_svt') return rateMetadata.ofgem_cap_elec_p_kwh ?? svtRate;
  return rateMetadata.elec_hh_rate_by_hh[i];
}

// ===== Phase B: computeCosts =====

export function computeCosts(rateMetadata, scenarioResult, params, baseloadHeating = null) {
  const pricingWarnings = [];

  const gasSc   = params.gas_standing_charge_p  ?? rateMetadata.gas_standing_charge_p_per_day;
  const elecSc  = params.svt_standing_charge_p  ?? rateMetadata.elec_standing_charge_p_per_day;
  const svtRate = params.svt_rate_p_per_kwh     ?? rateMetadata.svt_rate_p_per_kwh;

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
      elec_pence += e * electricityRateForHH(name, i, rateMetadata, svtRate);
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
                              + e * electricityRateForHH(name, i, rateMetadata, svtRate);
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
