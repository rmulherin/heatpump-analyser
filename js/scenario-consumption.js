// ===== Module 7 — Scenario Consumption =====
// Produces per-HH gas and electricity arrays for six comparison scenarios.

const SC_CONFIG = {
  T_MAX_PREHEAT_OFFSET_DEFAULT: 2.0,    // °C above setpoint
  OCCUPANCY_THRESHOLD_DEFAULT:  0.5,    // weight ≥ this → occupied
  N_STATES:                     15,     // DP state grid resolution
  T_RANGE_BELOW_SETPOINT:       1.0,    // grid extends 1°C below setpoint
  NON_HEATING_DAY_DD_HOURS:     0.5,    // < this → skip DP for the day
  PARTIAL_DUMB_THRESHOLD:       0.05,   // ≥5% gas-fallback → "partial"
  PREHEAT_OFFSET_HIGH_WARN_C:   4.0,    // warn if user offset > this
};

function buildDayHhIndices(heating) {
  const dayMap = new Map();
  for (let i = 0; i < heating.length; i++) {
    const date = heating[i].timestamp.slice(0, 10);
    if (!dayMap.has(date)) dayMap.set(date, []);
    dayMap.get(date).push(i);
  }
  return Array.from(dayMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, indices]) => ({ date, indices, skipDp: indices.length !== 48 }));
}

function discretiseStates(setpointC, tMaxPreheatC, nStates) {
  const T_states = new Float64Array(nStates);
  const low  = setpointC - SC_CONFIG.T_RANGE_BELOW_SETPOINT;
  const high = tMaxPreheatC;
  const step = (high - low) / (nStates - 1);
  for (let k = 0; k < nStates; k++) T_states[k] = low + k * step;
  return T_states;
}

function nearestStateIndex(value, T_states) {
  let best = 0;
  let bestDist = Math.abs(value - T_states[0]);
  for (let k = 1; k < T_states.length; k++) {
    const d = Math.abs(value - T_states[k]);
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return best;
}

function computeStepEnergetics(tCur, tempC, htc, C, R, solarWm2) {
  const heatLossKwh  = htc * (tCur - tempC) * 0.5 / 1000;
  const solarGainKwh = R * (solarWm2 ?? 0) * 0.5 / 1000;  // null solar data → 0 gain (conservative)
  return { heatLossKwh, solarGainKwh };
}

function requiredQDelivered(tCur, tNext, C, heatLossKwh, solarGainKwh) {
  const delta_T = tNext - tCur;
  // × C/3600 converts kJ/K × K → kWh; missing /3600 gives kJ (factor 3,600 error)
  return delta_T * C / 3600 + heatLossKwh - solarGainKwh;
}

function buildCurrentScenario(heating) {
  return {
    gas_kwh:       heating.map(h => h.heating_kwh),
    elec_kwh:      heating.map(h => h.heating_kwh === null ? null : 0),
    indoor_temp_c: heating.map(() => null),
  };
}

function buildDumbHpScenario(heating, copByHh, eta) {
  let nHeatingHh = 0;
  let nFallbackHh = 0;
  const gas_kwh  = new Array(heating.length);
  const elec_kwh = new Array(heating.length);

  for (let i = 0; i < heating.length; i++) {
    const h   = heating[i].heating_kwh;
    const cop = copByHh[i];
    if (h === null) { gas_kwh[i] = null; elec_kwh[i] = null; continue; }
    if (h === 0)    { gas_kwh[i] = 0;    elec_kwh[i] = 0;    continue; }
    nHeatingHh += 1;
    if (cop === null) {
      gas_kwh[i] = h; elec_kwh[i] = 0;
      nFallbackHh += 1;
    } else {
      gas_kwh[i]  = 0;
      elec_kwh[i] = h * eta / cop;
    }
  }

  return {
    gas_kwh, elec_kwh,
    indoor_temp_c: heating.map(() => null),
    _diagnostics: { nHeatingHh, nFallbackHh },
  };
}

function buildHybridDumbScenario(heating, copByHh, eta, gasRateByHh, elecHhRateByHh) {
  const gas_kwh  = new Array(heating.length);
  const elec_kwh = new Array(heating.length);

  for (let i = 0; i < heating.length; i++) {
    const h = heating[i].heating_kwh;
    if (h === null) { gas_kwh[i] = null; elec_kwh[i] = null; continue; }
    if (h === 0)    { gas_kwh[i] = 0;    elec_kwh[i] = 0;    continue; }

    const cop      = copByHh[i];
    const gasRate  = gasRateByHh[i];
    const elecRate = elecHhRateByHh[i];

    if (cop === null || elecRate === null || gasRate === null) {
      gas_kwh[i] = h; elec_kwh[i] = 0;
      continue;
    }

    const hpUnitCost  = elecRate / cop;  // p per kWh of heat via HP
    const gasUnitCost = gasRate  / eta;  // p per kWh of heat via gas

    if (hpUnitCost < gasUnitCost) {
      gas_kwh[i]  = 0;
      elec_kwh[i] = h * eta / cop;
    } else {
      gas_kwh[i]  = h;
      elec_kwh[i] = 0;
    }
  }

  return { gas_kwh, elec_kwh, indoor_temp_c: heating.map(() => null) };
}

function runDpForDay({ dayIndices, params, scenario, T_init }) {
  const {
    T_setpoint, T_max_preheat, htc, C, R, eta, hp_capacity_kw,
    occupied, external, copByHh, gasRateByHh, elecHhRateByHh, T_states,
  } = params;

  const nStates = T_states.length;
  const n       = dayIndices.length;
  const isHybrid = scenario === 'hybrid_smart';

  const dpCost = Array.from({ length: n + 1 }, () => new Float64Array(nStates).fill(Infinity));
  const dpPrev = Array.from({ length: n + 1 }, () => new Int8Array(nStates).fill(-1));
  const dpFuel = isHybrid
    ? Array.from({ length: n + 1 }, () => new Array(nStates).fill(null))
    : null;

  const initState = nearestStateIndex(T_init, T_states);

  function runForwardPass(relaxComfort) {
    for (let t = 0; t <= n; t++) {
      dpCost[t].fill(Infinity);
      dpPrev[t].fill(-1);
      if (dpFuel) {
        for (let s = 0; s < nStates; s++) dpFuel[t][s] = null;
      }
    }
    dpCost[0][initState] = 0;

    for (let t = 0; t < n; t++) {
      const i     = dayIndices[t];
      const tempC = external[i].temp_c;

      for (let s = 0; s < nStates; s++) {
        if (dpCost[t][s] === Infinity) continue;
        const T_cur = T_states[s];

        if (tempC === null) {
          // No RC step possible — carry this state forward at zero cost
          if (dpCost[t][s] < dpCost[t + 1][s]) {
            dpCost[t + 1][s] = dpCost[t][s];
            dpPrev[t + 1][s] = s;
            if (dpFuel) dpFuel[t + 1][s] = dpFuel[t][s] ?? 'hp';
          }
          continue; // skip s_next loop for this HH period
        }

        const { heatLossKwh, solarGainKwh } = computeStepEnergetics(
          T_cur, tempC, htc, C, R, external[i].solar_w_m2
        );

        for (let sNext = 0; sNext < nStates; sNext++) {
          const T_next = T_states[sNext];
          const Q = requiredQDelivered(T_cur, T_next, C, heatLossKwh, solarGainKwh);
          if (Q < 0) continue;                                // can't actively cool
          if (Q > hp_capacity_kw * 0.5) continue;            // capacity gate
          if (!relaxComfort && occupied[t] && T_next < T_setpoint) continue; // comfort gate
          if (T_next > T_max_preheat) continue;              // upper thermal gate

          let stepCost, fuel;
          if (scenario === 'smart_hp_hh') {
            const cop      = copByHh[i];
            const elecRate = elecHhRateByHh[i];
            if (cop === null || elecRate === null) continue;
            stepCost = (Q / cop) * elecRate;
            fuel = 'hp';
          } else { // hybrid_smart
            const cop      = copByHh[i];
            const elecRate = elecHhRateByHh[i];
            const gasRate  = gasRateByHh[i];
            const hpCost   = (cop !== null && elecRate !== null) ? (Q / cop) * elecRate : Infinity;
            const gasCost  = gasRate !== null ? (Q / eta) * gasRate : Infinity;
            if (hpCost === Infinity && gasCost === Infinity) continue;
            if (hpCost <= gasCost) { stepCost = hpCost; fuel = 'hp'; }
            else                   { stepCost = gasCost; fuel = 'gas'; }
          }

          const candidate = dpCost[t][s] + stepCost;
          if (candidate < dpCost[t + 1][sNext]) {
            dpCost[t + 1][sNext] = candidate;
            dpPrev[t + 1][sNext] = s;
            if (dpFuel) dpFuel[t + 1][sNext] = fuel;
          }
        }
      }
    }
  }

  runForwardPass(false);

  let sFinal = 0;
  for (let s = 1; s < nStates; s++) {
    if (dpCost[n][s] < dpCost[n][sFinal]) sFinal = s;
  }

  let feasible = true;
  if (dpCost[n][sFinal] === Infinity) {
    feasible = false;
    runForwardPass(true);
    sFinal = 0;
    for (let s = 1; s < nStates; s++) {
      if (dpCost[n][s] < dpCost[n][sFinal]) sFinal = s;
    }
    // Extreme edge case: even relaxed DP is infeasible (severely undersized HP)
    if (dpCost[n][sFinal] === Infinity) {
      return {
        q_delivered_kwh: new Array(n).fill(0),
        fuel_mode:       new Array(n).fill('hp'),
        indoor_temp_c:   new Array(n).fill(T_init),
        T_init_next:     T_init,
        feasible:        false,
      };
    }
  }

  // Backtrack: path[t] = state index at time step t
  const path = new Int8Array(n + 1);
  path[n] = sFinal;
  for (let t = n; t > 0; t--) path[t - 1] = dpPrev[t][path[t]];

  const q_delivered_kwh = new Array(n);
  const fuel_mode       = new Array(n);
  const indoor_temp_c   = new Array(n);

  for (let t = 0; t < n; t++) {
    const s  = path[t];
    const sN = path[t + 1]; // dpFuel[t+1][sN] is the fuel for this transition
    const i  = dayIndices[t];
    const tempC = external[i].temp_c;

    indoor_temp_c[t] = T_states[sN];

    if (tempC === null) {
      q_delivered_kwh[t] = 0;
      fuel_mode[t] = isHybrid ? (dpFuel[t + 1][sN] ?? 'hp') : 'hp';
    } else {
      const { heatLossKwh, solarGainKwh } = computeStepEnergetics(
        T_states[s], tempC, htc, C, R, external[i].solar_w_m2
      );
      const Q = requiredQDelivered(T_states[s], T_states[sN], C, heatLossKwh, solarGainKwh);
      q_delivered_kwh[t] = Math.max(0, Q);
      fuel_mode[t] = isHybrid ? (dpFuel[t + 1][sN] ?? 'hp') : 'hp';
    }
  }

  return { q_delivered_kwh, fuel_mode, indoor_temp_c, T_init_next: T_states[sFinal], feasible };
}

function buildSmartScenario(scenario, heating, external, copByHh, hpCapKw, ratesContext, smartParams) {
  const { gasRateByHh, elecHhRateByHh } = ratesContext;

  const gas_kwh       = new Array(heating.length).fill(null);
  const elec_kwh      = new Array(heating.length).fill(null);
  const indoor_temp_c = new Array(heating.length).fill(null);

  const T_states = discretiseStates(
    smartParams.T_setpoint, smartParams.T_max_preheat, SC_CONFIG.N_STATES
  );

  const params = {
    T_setpoint:    smartParams.T_setpoint,
    T_max_preheat: smartParams.T_max_preheat,
    htc:           smartParams.htc,
    C:             smartParams.C,
    R:             smartParams.R,
    eta:           smartParams.eta,
    hp_capacity_kw: hpCapKw,
    occupied:      smartParams.occupied,
    external,
    copByHh, gasRateByHh, elecHhRateByHh,
    T_states,
  };

  const days = buildDayHhIndices(heating);
  let T_init = smartParams.T_setpoint;
  let infeasibleDays = 0;

  for (const { indices, skipDp } of days) {
    if (skipDp) {
      // Non-48-HH day (DST transition) — null-fill, T_init unchanged
      for (const i of indices) { gas_kwh[i] = null; elec_kwh[i] = null; }
      continue;
    }

    // Null-safe daily degree-hours check
    let dailyDdHours = 0;
    for (const i of indices) {
      const tc = external[i].temp_c;
      if (tc !== null) dailyDdHours += Math.max(0, smartParams.T_setpoint - tc) * 0.5;
    }

    if (dailyDdHours < SC_CONFIG.NON_HEATING_DAY_DD_HOURS) {
      for (const i of indices) { gas_kwh[i] = 0; elec_kwh[i] = 0; }
      continue;
    }

    const dayResult = runDpForDay({ dayIndices: indices, params, scenario, T_init });

    if (!dayResult.feasible) infeasibleDays += 1;

    // Convert q_delivered_kwh + fuel_mode → consumed energy (kWh of input fuel)
    for (let k = 0; k < indices.length; k++) {
      const i  = indices[k];
      const q  = dayResult.q_delivered_kwh[k];
      const fm = dayResult.fuel_mode[k];
      indoor_temp_c[i] = dayResult.indoor_temp_c[k];

      if (q === 0) {
        gas_kwh[i] = 0; elec_kwh[i] = 0;
      } else if (fm === 'hp') {
        const cop = copByHh[i];
        gas_kwh[i]  = 0;
        elec_kwh[i] = cop !== null ? q / cop : 0;
      } else { // 'gas'
        gas_kwh[i]  = q / smartParams.eta;
        elec_kwh[i] = 0;
      }
    }

    T_init = dayResult.T_init_next;
  }

  return { gas_kwh, elec_kwh, indoor_temp_c, infeasibleDays };
}

function computeValidationStatusDumb(dumbDiagnostics, baseloadMethod) {
  if (baseloadMethod === 'no-gas' || dumbDiagnostics.nHeatingHh === 0) return 'no_data';
  const fallbackFrac = dumbDiagnostics.nFallbackHh / dumbDiagnostics.nHeatingHh;
  return fallbackFrac >= SC_CONFIG.PARTIAL_DUMB_THRESHOLD ? 'partial' : 'ok';
}

function computeValidationStatusSmart(heatLoss, thermalChar) {
  if (heatLoss?.htc_w_per_k == null)              return 'no_htc';
  if (thermalChar?.thermal_mass_kj_per_k == null) return 'no_thermal_mass';
  if (thermalChar?.setpoint_c == null)            return 'no_setpoint';
  if (thermalChar?.occupancy_weights == null)     return 'insufficient_data';
  return 'ok';
}

export function estimateScenarioConsumption({
  heating, external, heatLoss, thermalCharacter, heatPumpModel,
  baseloadMethod, gasRateByHh, elecHhRateByHh,
  tMaxPreheatOffsetC = SC_CONFIG.T_MAX_PREHEAT_OFFSET_DEFAULT,
  occupancyThreshold = SC_CONFIG.OCCUPANCY_THRESHOLD_DEFAULT,
}) {
  const warnings = [];
  const eta     = heatLoss?.boiler_efficiency_used ?? 0.9;
  const copByHh = heatPumpModel?.cop_by_hh ?? new Array(heating.length).fill(null);

  // Step 0 — early "no_data" path
  if (baseloadMethod === 'no-gas' || heating.every(h => h.heating_kwh === null)) {
    const nullArr = () => heating.map(() => null);
    const nullScenario = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
    return {
      scenarios: {
        current: nullScenario, dumb_hp_svt: nullScenario, dumb_hp_hh: nullScenario,
        hybrid_dumb: nullScenario, smart_hp_hh: nullScenario, hybrid_smart: nullScenario,
      },
      validation_status: {
        dumb:  'no_data',
        smart: computeValidationStatusSmart(heatLoss, thermalCharacter),
      },
      warnings: ['No gas heating detected — heat pump scenarios cannot be modelled against an existing gas baseline.'],
    };
  }

  // Steps 2–4: dumb scenarios
  const current    = buildCurrentScenario(heating);
  const dumbHp     = buildDumbHpScenario(heating, copByHh, eta);
  const hybridDumb = buildHybridDumbScenario(heating, copByHh, eta, gasRateByHh, elecHhRateByHh);

  const dumbDiagnostics = dumbHp._diagnostics;
  delete dumbHp._diagnostics;

  // Step 5: smart scenarios (skipped if validation not OK)
  const smartStatus = computeValidationStatusSmart(heatLoss, thermalCharacter);
  let smartHpHh, hybridSmart;

  if (smartStatus === 'ok') {
    const smartParams = {
      T_setpoint:    thermalCharacter.setpoint_c,
      T_max_preheat: thermalCharacter.setpoint_c + tMaxPreheatOffsetC,
      htc:           heatLoss.htc_w_per_k,
      C:             thermalCharacter.thermal_mass_kj_per_k,
      R:             heatLoss.solar_correction_applied ? (heatLoss.solar_aperture_m2 ?? 0) : 0,
      eta,
      hp_capacity_kw: heatPumpModel?.hp_capacity_kw ?? Infinity,
      occupied:      thermalCharacter.occupancy_weights.map(w => w >= occupancyThreshold),
    };

    if (tMaxPreheatOffsetC > SC_CONFIG.PREHEAT_OFFSET_HIGH_WARN_C) {
      warnings.push(`Pre-heat offset of ${tMaxPreheatOffsetC.toFixed(1)} °C is unusually wide; the DP grid resolution becomes coarser.`);
    }

    smartHpHh   = buildSmartScenario('smart_hp_hh',  heating, external, copByHh,
                                     smartParams.hp_capacity_kw, { gasRateByHh, elecHhRateByHh }, smartParams);
    hybridSmart = buildSmartScenario('hybrid_smart', heating, external, copByHh,
                                     smartParams.hp_capacity_kw, { gasRateByHh, elecHhRateByHh }, smartParams);

    if (smartHpHh.infeasibleDays > 0 || hybridSmart.infeasibleDays > 0) {
      warnings.push(`HP appears undersized for ${Math.max(smartHpHh.infeasibleDays, hybridSmart.infeasibleDays)} day(s) of extreme cold — comfort constraint relaxed for those days.`);
    }
    delete smartHpHh.infeasibleDays;
    delete hybridSmart.infeasibleDays;
  } else {
    const nullArr = () => heating.map(() => null);
    smartHpHh   = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
    hybridSmart = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
  }

  return {
    scenarios: {
      current,
      dumb_hp_svt: dumbHp,
      dumb_hp_hh:  dumbHp,   // SAME reference — intentional (T13)
      hybrid_dumb: hybridDumb,
      smart_hp_hh: smartHpHh,
      hybrid_smart: hybridSmart,
    },
    validation_status: {
      dumb:  computeValidationStatusDumb(dumbDiagnostics, baseloadMethod),
      smart: smartStatus,
    },
    warnings,
  };
}

let _scenarioConsumptionResult = null;
export function setScenarioConsumptionResult(r) { _scenarioConsumptionResult = r; }
export function getScenarioConsumptionResult()  { return _scenarioConsumptionResult; }
