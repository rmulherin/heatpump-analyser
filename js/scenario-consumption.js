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
    const baseload = heating[i].baseload_kwh ?? 0;
    if (h === null) { gas_kwh[i] = null; elec_kwh[i] = null; continue; }
    if (h === 0)    { gas_kwh[i] = baseload; elec_kwh[i] = 0; continue; }
    nHeatingHh += 1;
    if (cop === null) {
      gas_kwh[i] = h + baseload; elec_kwh[i] = 0;
      nFallbackHh += 1;
    } else {
      gas_kwh[i]  = baseload;
      elec_kwh[i] = h * eta / cop;
    }
  }

  return {
    gas_kwh, elec_kwh,
    indoor_temp_c: heating.map(() => null),
    _diagnostics: { nHeatingHh, nFallbackHh },
  };
}

function allocateGreedyDay({
  dayIndices, heating, eta, copByHh, gasRateByHh, elecHhRateByHh,
  hpCapKw, isAbsence, demandScale = 1.0,
  tau,       // hours — thermal time constant; non-null when smart runs
  S_max_kwh, // kWh — max pre-heat storage budget above setpoint
}) {
  const n   = dayIndices.length;
  const cap = hpCapKw * 0.5;  // thermal kWh per HH at HP capacity

  // 1. Demand array and B_d (observed heating × η, absence excluded)
  const demand = new Array(n);
  for (let t = 0; t < n; t++) {
    const i = dayIndices[t];
    const h = heating[i].heating_kwh;
    demand[t] = (!isAbsence[i] && h != null && h > 0) ? h * eta * demandScale : 0;
  }
  let B_d = 0;
  for (const d of demand) B_d += d;

  const elec_kwh_alloc = new Array(n).fill(0);
  const gas_kwh_alloc  = new Array(n).fill(0);
  const q_delivered    = new Array(n).fill(0);
  const fuel_mode      = new Array(n).fill('none');

  if (B_d <= 0) {
    return { q_delivered_thermal_kwh: q_delivered, fuel_mode,
             elec_kwh_alloc, gas_kwh_alloc, hpUndersized: false };
  }

  // 2. Survival filter: d_next and survivalEligible
  // d_next[t] = local index of nearest subsequent demand slot (Infinity if none)
  const d_next = new Array(n).fill(Infinity);
  for (let t = n - 2; t >= 0; t--) {
    d_next[t] = (demand[t + 1] > 0) ? t + 1 : d_next[t + 1];
  }

  // survivalEligible[t]: non-demand slot t can reach next demand within 2τ HH
  // condition: n_gap × 0.5 / τ ≤ 1  ↔  exp(−n_gap×0.5/τ) ≥ exp(−1)
  const survivalEligible = new Array(n).fill(false);
  for (let t = 0; t < n; t++) {
    if (demand[t] > 0) continue;
    const n_gap = d_next[t] - t;
    if (n_gap === Infinity) continue;
    survivalEligible[t] = (n_gap * 0.5 / tau) <= 1;
  }

  // 3. max_addable_at: storage headroom at slot s given current q_delivered
  // O(n) forward scan; O(n²) per day — acceptable (n=48, ≤365 days)
  function max_addable_at(s) {
    let cum = 0;
    for (let t = 0; t <= s; t++) cum += q_delivered[t] - demand[t];
    let headroom = S_max_kwh - cum;
    for (let t = s + 1; t < n; t++) {
      cum += q_delivered[t] - demand[t];
      headroom = Math.min(headroom, S_max_kwh - cum);
    }
    return Math.max(0, headroom);
  }

  // 4. Eligible slots: demand slots + survival-eligible non-demand slots
  const slots = [];
  for (let t = 0; t < n; t++) {
    const i       = dayIndices[t];
    const cop     = copByHh[i];
    const elecRate = elecHhRateByHh[i];
    if (cop == null || elecRate == null) continue;
    if (demand[t] === 0 && !survivalEligible[t]) continue;
    if (isAbsence[i]) continue;
    slots.push({ t, i, unitCost: elecRate / cop });
  }

  // 5. Sort cheapest first, deterministic tiebreak by HH index
  slots.sort((a, b) => a.unitCost - b.unitCost || a.t - b.t);

  // 6. Greedy fill with storage headroom constraint
  let remaining = B_d;
  for (const s of slots) {
    if (remaining <= 0) break;
    const cap_headroom     = cap - q_delivered[s.t];
    const storage_headroom = max_addable_at(s.t);
    const add = Math.min(remaining, cap_headroom, storage_headroom);
    if (add > 0) {
      q_delivered[s.t]     += add;
      elec_kwh_alloc[s.t]   = q_delivered[s.t] / copByHh[s.i];
      fuel_mode[s.t]         = 'hp';
      remaining             -= add;
    }
  }

  // 7. Undersized fallback — resistive backup at COP=1
  let hpUndersized = false;
  if (remaining > 1e-9) {
    hpUndersized = true;
    const target = slots[0];
    if (target) {
      elec_kwh_alloc[target.t] += remaining;
      q_delivered[target.t]    += remaining;
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

// RC temperature trace for the current (boiler) scenario — display only.
// Resets T to setpoint on data gaps (null heating or null temp) rather than
// carrying T forward, because a null entry means a metering gap where the
// building's true state is unknown; setpoint is the least-bad assumption.
function simulateCurrentRcTrace({ heating, external, heatLoss, thermalChar }) {
  const htc = heatLoss?.htc_w_per_k;
  const C   = thermalChar?.thermal_mass_kj_per_k;
  const eta = heatLoss?.boiler_efficiency_used ?? 0.9;
  const sp  = thermalChar?.setpoint_c;
  if (htc == null || C == null || sp == null) return heating.map(() => null);

  const R = (heatLoss?.solar_correction_applied && heatLoss?.solar_aperture_m2 != null)
    ? heatLoss.solar_aperture_m2 : 0;
  const out = new Array(heating.length);
  let T = sp;
  for (let i = 0; i < heating.length; i++) {
    const h  = heating[i].heating_kwh;
    const tc = external[i]?.temp_c;
    if (h == null || tc == null) {
      out[i] = null;
      T = sp;
      continue;
    }
    const Q_current    = h * eta;
    const heatLossKwh  = htc * (T - tc) * 0.5 / 1000;
    const solarGainKwh = R * (external[i]?.solar_w_m2 ?? 0) * 0.5 / 1000;
    const dT = (Q_current + solarGainKwh - heatLossKwh) * 3600 / C;
    T += dT;
    out[i] = T;
  }
  return out;
}

function buildSmartScenario({
  heating, external, copByHh, hpCapKw,
  gasRateByHh, elecHhRateByHh, eta, isAbsence, demandScale = 1.0,
  htc,         // W/K — required; non-null when called (computeValidationStatusSmart guards)
  thermalMass, // kJ/K — required; same guard
  tMaxPreheat, // °C — maximum pre-heat above setpoint
}) {
  const tau     = thermalMass * 1000 / (htc * 3600);  // hours
  const S_max   = thermalMass * tMaxPreheat / 3600;   // kWh

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
      dayIndices: indices, heating, eta,
      copByHh, gasRateByHh, elecHhRateByHh, hpCapKw, isAbsence, demandScale,
      tau, S_max_kwh: S_max,
    });
    if (day.hpUndersized) anyHpUndersized = true;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      gas_kwh[i]   = day.gas_kwh_alloc[k] + (heating[i].baseload_kwh ?? 0);
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

function computeValidationStatusSmart(heatLoss, heatPumpModel, thermalCharacter) {
  if (heatLoss?.htc_w_per_k == null)                   return 'no_htc';
  if (heatPumpModel?.hp_capacity_kw == null)           return 'insufficient_data';
  if (thermalCharacter?.thermal_mass_kj_per_k == null) return 'no_thermal_mass';
  return 'ok';
}

export function estimateScenarioConsumption({
  heating, external, heatLoss, thermalCharacter, heatPumpModel,
  baseloadMethod, gasRateByHh, elecHhRateByHh,
  comfort_demand_scale,         // optional; slider value in % (e.g. 80 = 80%); undefined → scale=1
  t_max_preheat_offset_c = 3.0, // °C above setpoint the smart HP may pre-heat to
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
        smart_hp_hh: nullScenario,
      },
      validation_status: { dumb: 'no_data', smart: computeValidationStatusSmart(heatLoss, heatPumpModel, thermalCharacter) },
      warnings: ['No gas heating detected — heat pump scenarios cannot be modelled against an existing gas baseline.'],
    };
  }

  // Steps 1–2: current + dumb scenarios
  const current = buildCurrentScenario(heating);
  current.indoor_temp_c = simulateCurrentRcTrace({
    heating, external, heatLoss, thermalChar: thermalCharacter,
  });
  const dumbHp  = buildDumbHpScenario(heating, copByHh, eta);
  const dumbDiagnostics = dumbHp._diagnostics; delete dumbHp._diagnostics;

  // Step 4: smart scenario (greedy LP)
  let smartStatus = computeValidationStatusSmart(heatLoss, heatPumpModel, thermalCharacter);
  let smartHpHh;

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
      heating, external, copByHh, hpCapKw: hpCap,
      gasRateByHh, elecHhRateByHh, eta, isAbsence, demandScale,
      htc:         heatLoss.htc_w_per_k,
      thermalMass: thermalCharacter.thermal_mass_kj_per_k,
      tMaxPreheat: t_max_preheat_offset_c,
    });

    if (sm.hpUndersized) {
      smartStatus = 'hp_undersized';
      warnings.push('Heat pump capacity insufficient on some days at your current heating pattern; resistive backup applied at COP = 1.');
    }

    // Post-hoc T_indoor sim (chronological, day-chained implicitly)
    const smTinSim = simulatePostHocTIndoor({
      q_delivered_per_hh: sm.q_thermal, external, heatLoss,
      thermalChar: thermalCharacter, T_init: thermalCharacter?.setpoint_c ?? 20,
    });

    smartHpHh = { gas_kwh: sm.gas_kwh, elec_kwh: sm.elec_kwh, indoor_temp_c: smTinSim.indoor_temp_c };

    // Concentrated-heating note (design § 1.5): inspect post-hoc indoor for overshoot.
    // Filter to HH where heat was actually delivered. Without this filter, summer days
    // where the building naturally tracks 22–28°C outdoor temperatures would trigger
    // the warning despite no smart-schedule activity, making the warning text
    // ("schedule concentrates heating into low-cost periods") misleading.
    const overshoot = sm.q_thermal.some((q, idx) => {
      if (q == null || q <= 0) return false;
      const t = smTinSim.indoor_temp_c[idx];
      if (t == null || thermalCharacter?.setpoint_c == null) return false;
      return t > thermalCharacter.setpoint_c + t_max_preheat_offset_c;
    });
    if (overshoot) {
      warnings.push('Smart-HP schedule concentrates heating into low-cost periods; in practice your thermostat would moderate this.');
    }
  } else {
    const nullArr = () => heating.map(() => null);
    smartHpHh = { gas_kwh: nullArr(), elec_kwh: nullArr(), indoor_temp_c: nullArr() };
  }

  return {
    scenarios: {
      current,
      dumb_hp_svt: dumbHp,
      dumb_hp_hh:  dumbHp,        // shared ref preserved (T13)
      smart_hp_hh: smartHpHh,
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
