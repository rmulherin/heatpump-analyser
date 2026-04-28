// ===== Module 7 — Scenario Consumption =====
// Produces per-HH gas and electricity arrays for six comparison scenarios.

const SC_CONFIG = {
  PARTIAL_DUMB_THRESHOLD: 0.05,   // ≥5% gas-fallback → "partial"
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

function allocateGreedyDay({
  scenario, dayIndices, heating, eta, copByHh, gasRateByHh, elecHhRateByHh,
  hpCapKw, isAbsence, demandScale = 1.0,
}) {
  const n = dayIndices.length;
  const cap = hpCapKw * 0.5;        // thermal kWh per HH at HP capacity

  // 1. Daily thermal budget B_d from observed gas heating × η, excluding absence HH
  let B_d = 0;
  for (const i of dayIndices) {
    const h = heating[i].heating_kwh;
    if (h != null && h > 0 && !isAbsence[i]) B_d += h * eta;
  }
  B_d *= demandScale;

  const elec_kwh_alloc = new Array(n).fill(0);
  const gas_kwh_alloc  = new Array(n).fill(0);
  const q_delivered    = new Array(n).fill(0);
  const fuel_mode      = new Array(n).fill('none');

  if (B_d <= 0) {
    return { q_delivered_thermal_kwh: q_delivered, fuel_mode,
             elec_kwh_alloc, gas_kwh_alloc, hpUndersized: false };
  }

  // 2. Per-HH unit cost + cap
  const isHybrid = scenario === 'hybrid_smart';
  const slots = [];
  for (let t = 0; t < n; t++) {
    const i        = dayIndices[t];
    const cop      = copByHh[i];
    const elecRate = elecHhRateByHh[i];
    const gasRate  = gasRateByHh[i];

    const hpCost  = (cop != null && elecRate != null) ? elecRate / cop : Infinity;
    const gasCost = (isHybrid && gasRate != null)     ? gasRate / eta  : Infinity;

    if (!isHybrid) {
      if (hpCost === Infinity) continue;                       // ineligible
      slots.push({ t, i, fuel: 'hp',  unitCost: hpCost,  capI: cap });
    } else {
      if (hpCost === Infinity && gasCost === Infinity) continue;
      if (hpCost <= gasCost) slots.push({ t, i, fuel: 'hp',  unitCost: hpCost,  capI: cap });
      else                   slots.push({ t, i, fuel: 'gas', unitCost: gasCost, capI: Infinity });
    }
  }

  // 3. Sort cheapest first, deterministic tiebreak by HH index
  slots.sort((a, b) => a.unitCost - b.unitCost || a.t - b.t);

  // 4. Greedy fill until B_d met
  let remaining = B_d;
  for (const s of slots) {
    if (remaining <= 0) break;
    const Q = Math.min(s.capI, remaining);
    q_delivered[s.t] = Q;
    fuel_mode[s.t]   = s.fuel;
    if (s.fuel === 'hp')  elec_kwh_alloc[s.t] = Q / copByHh[s.i];
    else                  gas_kwh_alloc[s.t]  = Q / eta;
    remaining -= Q;
  }

  // 5. Undersized fallback (smart_hp_hh only — hybrid gas pool has no cap)
  let hpUndersized = false;
  if (remaining > 1e-9 && !isHybrid) {
    hpUndersized = true;
    // Resistive backup at COP=1 in cheapest eligible HH
    const target = slots[0];
    if (target) {
      elec_kwh_alloc[target.t] += remaining;
      q_delivered[target.t]    += remaining;     // 1 kWh elec → 1 kWh heat at COP=1
      fuel_mode[target.t]       = 'hp';
    }
  }

  return { q_delivered_thermal_kwh: q_delivered, fuel_mode,
           elec_kwh_alloc, gas_kwh_alloc, hpUndersized };
}

function simulatePostHocTIndoor({
  q_delivered_per_hh, external, heatLoss, thermalChar, T_init,
}) {
  const htc = heatLoss?.htc_w_per_k;
  const C   = thermalChar?.thermal_mass_kj_per_k;
  if (htc == null || C == null || thermalChar?.setpoint_c == null) {
    return { indoor_temp_c: q_delivered_per_hh.map(() => null), T_init_next: T_init };
  }

  const aperture = (heatLoss?.solar_correction_applied && heatLoss?.solar_aperture_m2 != null)
    ? heatLoss.solar_aperture_m2 : 0;

  const out = new Array(q_delivered_per_hh.length);
  let T = T_init;
  for (let i = 0; i < q_delivered_per_hh.length; i++) {
    const tc = external[i]?.temp_c;
    const sw = external[i]?.solar_w_m2 ?? 0;
    if (tc == null) { out[i] = T; continue; }   // carry forward at unknown outdoor temp

    const lossKwh  = htc * (T - tc) * 0.5 / 1000;
    const solarKwh = aperture * sw * 0.5 / 1000;
    const dT = (q_delivered_per_hh[i] + solarKwh - lossKwh) * 3600 / C;
    T += dT;
    out[i] = T;
  }
  return { indoor_temp_c: out, T_init_next: T };
}

function buildSmartScenario({
  scenario, heating, external, copByHh, hpCapKw,
  gasRateByHh, elecHhRateByHh, eta, isAbsence, demandScale = 1.0,
}) {
  const days = buildDayHhIndices(heating);
  const gas_kwh   = new Array(heating.length).fill(0);
  const elec_kwh  = new Array(heating.length).fill(0);
  const q_thermal = new Array(heating.length).fill(0);
  let anyHpUndersized = false;

  for (const { indices, skipDp } of days) {
    if (skipDp) {
      // Non-48-HH day (DST transition) — arrays remain at 0 per design § 1.4.
      // Do NOT null these — M8 expects numeric arrays and design specifies zero.
      continue;
    }
    const day = allocateGreedyDay({
      scenario, dayIndices: indices, heating, eta,
      copByHh, gasRateByHh, elecHhRateByHh, hpCapKw, isAbsence, demandScale,
    });
    if (day.hpUndersized) anyHpUndersized = true;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      gas_kwh[i]   = day.gas_kwh_alloc[k];
      elec_kwh[i]  = day.elec_kwh_alloc[k];
      q_thermal[i] = day.q_delivered_thermal_kwh[k];
    }
  }

  return { gas_kwh, elec_kwh, q_thermal, hpUndersized: anyHpUndersized };
}

function computeValidationStatusDumb(dumbDiagnostics, baseloadMethod) {
  if (baseloadMethod === 'no-gas' || dumbDiagnostics.nHeatingHh === 0) return 'no_data';
  const fallbackFrac = dumbDiagnostics.nFallbackHh / dumbDiagnostics.nHeatingHh;
  return fallbackFrac >= SC_CONFIG.PARTIAL_DUMB_THRESHOLD ? 'partial' : 'ok';
}

function computeValidationStatusSmart(heatLoss, heatPumpModel) {
  if (heatLoss?.htc_w_per_k == null)         return 'insufficient_data';
  if (heatPumpModel?.hp_capacity_kw == null) return 'insufficient_data';
  return 'ok';
}

export function estimateScenarioConsumption({
  heating, external, heatLoss, thermalCharacter, heatPumpModel,
  baseloadMethod, gasRateByHh, elecHhRateByHh,
  comfort_demand_scale,   // optional; slider value in % (e.g. 80 = 80%); undefined → scale=1
}) {
  const warnings = [];
  const eta      = heatLoss?.boiler_efficiency_used ?? 0.9;
  const copByHh  = heatPumpModel?.cop_by_hh ?? new Array(heating.length).fill(null);
  const isAbsence = heating.map(h => !!h.is_absence);

  // Step 0 — early no_data
  if (baseloadMethod === 'no-gas' || heating.every(h => h.heating_kwh === null)) {
    const nullArr = () => heating.map(() => null);
    const nullScenario = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
    return {
      scenarios: {
        current: nullScenario, dumb_hp_svt: nullScenario, dumb_hp_hh: nullScenario,
        hybrid_dumb: nullScenario, smart_hp_hh: nullScenario, hybrid_smart: nullScenario,
      },
      validation_status: { dumb: 'no_data', smart: computeValidationStatusSmart(heatLoss, heatPumpModel) },
      warnings: ['No gas heating detected — heat pump scenarios cannot be modelled against an existing gas baseline.'],
    };
  }

  // Steps 1–3: dumb scenarios (unchanged)
  const current    = buildCurrentScenario(heating);
  const dumbHp     = buildDumbHpScenario(heating, copByHh, eta);
  const hybridDumb = buildHybridDumbScenario(heating, copByHh, eta, gasRateByHh, elecHhRateByHh);
  const dumbDiagnostics = dumbHp._diagnostics; delete dumbHp._diagnostics;

  // Step 4: smart scenarios (greedy LP)
  let smartStatus = computeValidationStatusSmart(heatLoss, heatPumpModel);
  let smartHpHh, hybridSmart;

  if (smartStatus === 'ok') {
    // hp_capacity_kw is guaranteed non-null here by computeValidationStatusSmart's
    // guard above. Do not fall back to Infinity — that would silently disable the
    // per-HH cap and let the greedy dump a day's heat into a single half-hour.
    const hpCap = heatPumpModel.hp_capacity_kw;

    // comfort_demand_scale: slider % relative to modelled comfort demand.
    // scale = (pct/100) / ratio converts "% of comfort demand" → "multiplier on observed B_d".
    // Defensive: when ratio is null the slider is hidden so scale should be 1; double-guard here.
    const ratio = thermalCharacter?.underheat_ratio;
    const demandScale = (comfort_demand_scale != null && ratio != null)
      ? (comfort_demand_scale / 100) / Math.max(ratio, 0.001)
      : 1.0;

    const sm = buildSmartScenario({
      scenario: 'smart_hp_hh', heating, external, copByHh, hpCapKw: hpCap,
      gasRateByHh, elecHhRateByHh, eta, isAbsence, demandScale,
    });
    const hb = buildSmartScenario({
      scenario: 'hybrid_smart', heating, external, copByHh, hpCapKw: hpCap,
      gasRateByHh, elecHhRateByHh, eta, isAbsence, demandScale,
    });

    if (sm.hpUndersized) {
      smartStatus = 'hp_undersized';
      warnings.push('Heat pump capacity insufficient on some days at your current heating pattern; resistive backup applied at COP = 1.');
    }

    // Post-hoc T_indoor sims (chronological, day-chained implicitly)
    const smTinSim = simulatePostHocTIndoor({
      q_delivered_per_hh: sm.q_thermal, external, heatLoss,
      thermalChar: thermalCharacter, T_init: thermalCharacter?.setpoint_c ?? 20,
    });
    const hbTinSim = simulatePostHocTIndoor({
      q_delivered_per_hh: hb.q_thermal, external, heatLoss,
      thermalChar: thermalCharacter, T_init: thermalCharacter?.setpoint_c ?? 20,
    });

    smartHpHh   = { gas_kwh: sm.gas_kwh, elec_kwh: sm.elec_kwh, indoor_temp_c: smTinSim.indoor_temp_c };
    hybridSmart = { gas_kwh: hb.gas_kwh, elec_kwh: hb.elec_kwh, indoor_temp_c: hbTinSim.indoor_temp_c };

    // Concentrated-heating note (design § 1.5): inspect post-hoc indoor for overshoot.
    // Filter to HH where heat was actually delivered. Without this filter, summer days
    // where the building naturally tracks 22–28°C outdoor temperatures would trigger
    // the warning despite no smart-schedule activity, making the warning text
    // ("schedule concentrates heating into low-cost periods") misleading.
    const overshoot = sm.q_thermal.some((q, idx) => {
      if (q == null || q <= 0) return false;
      const t = smTinSim.indoor_temp_c[idx];
      if (t == null || thermalCharacter?.setpoint_c == null) return false;
      return t > thermalCharacter.setpoint_c + 3.0;
    });
    if (overshoot) {
      warnings.push('Smart-HP schedule concentrates heating into low-cost periods; in practice your thermostat would moderate this.');
    }
  } else {
    const nullArr = () => heating.map(() => null);
    smartHpHh   = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
    hybridSmart = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
  }

  return {
    scenarios: {
      current,
      dumb_hp_svt: dumbHp,
      dumb_hp_hh:  dumbHp,        // shared ref preserved (T13)
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
