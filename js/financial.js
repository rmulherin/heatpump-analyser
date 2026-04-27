// ===== M9: Financial Analysis =====
// Converts M8 per-scenario annual costs into investment decision metrics.

export const FA_CONFIG = {
  INSTALLATION_FULL_HP_DEFAULT_GBP: 12_500,
  INSTALLATION_HYBRID_DEFAULT_GBP:  10_000,
  BUS_GRANT_DEFAULT_GBP:             7_500,
  AVOIDED_AC_DEFAULT_GBP:                0,
  GAS_MULTIPLIERS:  [0.7, 0.85, 1.0, 1.2, 1.5],
  ELEC_MULTIPLIERS: [0.7, 0.85, 1.0, 1.2, 1.5],
  COP_MULTIPLIERS:  [0.7, 0.85, 1.0, 1.15, 1.3],
  AVOIDED_AC_LARGE_FRACTION: 0.5,
};

const HP_SCENARIOS    = ['dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh', 'hybrid_dumb', 'hybrid_smart'];
const FULL_HP_SCENARIOS = ['dumb_hp_svt', 'dumb_hp_hh', 'smart_hp_hh'];

// ===== State =====

let _financialResult = null;
export function setFinancialResult(r) { _financialResult = r; }
export function getFinancialResult()  { return _financialResult; }

// ===== Main function =====

export function analyseFinancials(pricingResult, rateMetadata, scenarioResult, params) {
  const warnings = [];

  // Step A — Net investment
  const { installation_cost_full_hp_gbp, installation_cost_hybrid_gbp,
          bus_grant_gbp, avoided_ac_cost_gbp } = params;

  const deductions  = bus_grant_gbp + avoided_ac_cost_gbp;
  const net_full_hp = Math.max(0, installation_cost_full_hp_gbp - deductions);
  const net_hybrid  = Math.max(0, installation_cost_hybrid_gbp  - deductions);

  if (avoided_ac_cost_gbp > installation_cost_full_hp_gbp * FA_CONFIG.AVOIDED_AC_LARGE_FRACTION) {
    warnings.push(
      `Avoided AC cost of £${avoided_ac_cost_gbp.toLocaleString('en-GB')} is large relative to `
      + `the heat pump installation. Double-check this figure.`
    );
  }

  function netInvestmentFor(scenario) {
    return FULL_HP_SCENARIOS.includes(scenario) ? net_full_hp : net_hybrid;
  }

  // Step B — Per-scenario saving and payback
  const current       = pricingResult.scenarios.current;
  const currentAnnual = current?.annual_cost_gbp ?? null;

  const scenarioResults = {};

  for (const name of HP_SCENARIOS) {
    const s       = pricingResult.scenarios[name];
    const sAnnual = s?.annual_cost_gbp ?? null;
    const netInv  = netInvestmentFor(name);

    let annual_saving_gbp, payback_years, payback_status;

    if (currentAnnual === null || sAnnual === null) {
      annual_saving_gbp = null;
      payback_years     = null;
      payback_status    = 'no_data';
    } else {
      annual_saving_gbp = currentAnnual - sAnnual;
      if (annual_saving_gbp <= 0) {
        payback_years  = null;
        payback_status = 'no_saving';
      } else if (netInv === 0) {
        payback_years  = 0;
        payback_status = 'positive';
      } else {
        payback_years  = netInv / annual_saving_gbp;
        payback_status = 'positive';
      }
    }

    scenarioResults[name] = {
      annual_cost_gbp:    sAnnual,
      annual_saving_gbp,
      net_investment_gbp: netInv,
      payback_years,
      payback_status,
    };
  }

  scenarioResults.current = {
    annual_cost_gbp:    currentAnnual,
    annual_saving_gbp:  0,
    net_investment_gbp: 0,
    payback_years:      null,
    payback_status:     'no_data',
  };

  const allNoSaving = HP_SCENARIOS.every(
    n => scenarioResults[n].payback_status !== 'positive'
      && scenarioResults[n].payback_status !== 'no_data'
  );
  if (allNoSaving) {
    warnings.push(
      'Based on current rates and your heating profile, none of the heat pump scenarios saves '
      + 'money compared to your boiler. This may improve if gas prices rise or electricity prices fall.'
    );
  }

  // Step C — Sensitivity grid
  const scale = 365 / rateMetadata.data_period_days;

  function annualComponents(scenarioCost) {
    if (!scenarioCost || scenarioCost.annual_cost_gbp === null) return null;
    return {
      gas:      (scenarioCost.gas_energy_cost_gbp  ?? 0) * scale,
      elec:     (scenarioCost.elec_energy_cost_gbp ?? 0) * scale,
      standing: (scenarioCost.standing_charge_gbp  ?? 0) * scale,
    };
  }

  const components = {};
  for (const name of ['current', ...HP_SCENARIOS]) {
    components[name] = annualComponents(pricingResult.scenarios[name]);
  }

  const grid = [];

  if (components.current === null) {
    warnings.push('Price sensitivity grid unavailable — current scenario cost is missing.');
  } else {
    for (const gas_mult of FA_CONFIG.GAS_MULTIPLIERS) {
      for (const elec_mult of FA_CONFIG.ELEC_MULTIPLIERS) {
        const cc = components.current;
        const currentScaled = cc.gas * gas_mult + cc.elec * elec_mult + cc.standing;

        let best_payback  = null;
        let best_scenario = null;

        for (const name of HP_SCENARIOS) {
          const c = components[name];
          if (!c) continue;
          const scenarioScaled = c.gas * gas_mult + c.elec * elec_mult + c.standing;
          const saving = currentScaled - scenarioScaled;
          if (saving <= 0) continue;
          const payback = netInvestmentFor(name) / saving;
          if (best_payback === null || payback < best_payback) {
            best_payback  = payback;
            best_scenario = name;
          }
        }

        grid.push({ gas_multiplier: gas_mult, elec_multiplier: elec_mult,
                    payback_years: best_payback, best_scenario });
      }
    }
  }

  // 5-point COP sensitivity axis
  const cop_axis = [];

  for (const cop_mult of FA_CONFIG.COP_MULTIPLIERS) {
    let best_payback = null;

    if (components.current !== null) {
      const currentBase = components.current.gas + components.current.elec + components.current.standing;

      for (const name of HP_SCENARIOS) {
        const c = components[name];
        if (!c) continue;
        const scenarioScaled = c.gas + c.elec * (1.0 / cop_mult) + c.standing;
        const saving = currentBase - scenarioScaled;
        if (saving <= 0) continue;
        const payback = netInvestmentFor(name) / saving;
        if (best_payback === null || payback < best_payback) best_payback = payback;
      }
    }

    cop_axis.push({ cop_multiplier: cop_mult, payback_years: best_payback });
  }

  // Step D — Break-even analysis
  const currentM8   = pricingResult.scenarios.current;
  const dumbHpSvtM7 = scenarioResult?.scenarios?.dumb_hp_svt;
  const currentM7   = scenarioResult?.scenarios?.current;

  let break_even = {
    dumb_hp_svt_break_even_elec_p_per_kwh: null,
    gas_to_elec_ratio_at_break_even:        null,
    current_gas_to_elec_ratio:              null,
    break_even_interpretation:              null,
  };

  if (currentM8?.gas_energy_cost_gbp != null && dumbHpSvtM7 && currentM7) {
    const gas_energy_dp_pence = currentM8.gas_energy_cost_gbp * 100;
    const gas_sc_dp_pence     = rateMetadata.gas_standing_charge_p_per_day * rateMetadata.data_period_days;

    const elec_kwh_total_hp       = dumbHpSvtM7.elec_kwh.reduce((s, v) => s + (v ?? 0), 0);
    const gas_kwh_total_heating   = currentM7.gas_kwh.reduce((s, v) => s + (v ?? 0), 0);

    if (elec_kwh_total_hp > 0 && gas_kwh_total_heating > 0) {
      const svt_be_p       = (gas_energy_dp_pence + gas_sc_dp_pence) / elec_kwh_total_hp;
      const mean_gas_rate_p = gas_energy_dp_pence / gas_kwh_total_heating;
      const current_svt_p  = rateMetadata.svt_rate_p_per_kwh;

      const gas_be_p_raw = (elec_kwh_total_hp * current_svt_p - gas_sc_dp_pence) / gas_kwh_total_heating;
      const gas_be_p     = gas_be_p_raw > 0 ? gas_be_p_raw : null;

      const ratio_be      = svt_be_p > 0       ? mean_gas_rate_p / svt_be_p   : null;
      const ratio_current = current_svt_p > 0  ? mean_gas_rate_p / current_svt_p : null;

      let interpretation = null;
      if (svt_be_p > 0) {
        interpretation =
          `On a standard flat electricity tariff, the heat pump breaks even when electricity `
          + `costs less than ${svt_be_p.toFixed(1)}p/kWh (currently ${current_svt_p.toFixed(1)}p/kWh)`;
        if (gas_be_p !== null) {
          interpretation += ` or when gas costs more than ${gas_be_p.toFixed(1)}p/kWh `
            + `(currently ${mean_gas_rate_p.toFixed(1)}p/kWh).`;
        } else {
          interpretation += '.';
        }
      }

      break_even = {
        dumb_hp_svt_break_even_elec_p_per_kwh: svt_be_p,
        gas_to_elec_ratio_at_break_even:        ratio_be,
        current_gas_to_elec_ratio:              ratio_current,
        break_even_interpretation:              interpretation,
      };
    }
  }

  // Step E — Assemble and return
  return {
    scenarios: scenarioResults,
    sensitivity: {
      grid,
      gas_multipliers:  FA_CONFIG.GAS_MULTIPLIERS,
      elec_multipliers: FA_CONFIG.ELEC_MULTIPLIERS,
      cop_axis,
      cop_multipliers:  FA_CONFIG.COP_MULTIPLIERS,
    },
    break_even,
    inputs_used: {
      installation_cost_full_hp_gbp,
      installation_cost_hybrid_gbp,
      bus_grant_gbp,
      avoided_ac_cost_gbp,
    },
    warnings,
  };
}
