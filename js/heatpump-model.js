// ===== Heat Pump Model (Module 6) =====
// Converts heating demand into per-HH COP array and HP sizing parameters for M7.

// ===== Shared state =====

let _heatPumpModelResult = null;
export function setHeatPumpModelResult(r) { _heatPumpModelResult = r; }
export function getHeatPumpModelResult()   { return _heatPumpModelResult; }

// ===== Constants =====

const HP_CONFIG = {
  T_DESIGN_C:             -3.0,   // BS EN 12831 / CIBSE TM55 UK design temperature
  COP_CLAMP_MIN:           1.0,   // physically below 1.0 means worse than resistance heating
  COP_CLAMP_MAX:           6.0,   // beyond commercial ASHP at H4 boundary
  USER_SCALAR_MIN:         0.5,
  USER_SCALAR_MAX:         1.5,
  USER_SCALAR_DEFAULT:     1.0,
  MEAN_COP_LOW_WARN:       2.0,
  BELOW_DESIGN_WARN:       0.05,
  COP_AT_DESIGN_LOW_WARN:  1.5,
};

// EoH field trial H4 anchor points (base — pre-scaling). Ascending by temp_c.
const COP_ANCHORS_BASE = Object.freeze([
  { temp_c: -15, cop: 1.44 },  // extrapolated from EoH slope
  { temp_c:  -3, cop: 2.37 },  // EoH field trial H4 median
  { temp_c:  10, cop: 3.37 },  // EoH field trial H4 median
  { temp_c:  20, cop: 4.14 },  // extrapolated from EoH slope
]);

// ===== Helpers =====

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function clampScalar(value) {
  return clamp(value, HP_CONFIG.USER_SCALAR_MIN, HP_CONFIG.USER_SCALAR_MAX);
}

function copBaseAt(tempC) {
  if (tempC <= COP_ANCHORS_BASE[0].temp_c) return COP_ANCHORS_BASE[0].cop;
  const last = COP_ANCHORS_BASE[COP_ANCHORS_BASE.length - 1];
  if (tempC >= last.temp_c) return last.cop;
  for (let i = 0; i < COP_ANCHORS_BASE.length - 1; i++) {
    const lo = COP_ANCHORS_BASE[i];
    const hi = COP_ANCHORS_BASE[i + 1];
    if (tempC >= lo.temp_c && tempC < hi.temp_c) {
      const f = (tempC - lo.temp_c) / (hi.temp_c - lo.temp_c);
      return lo.cop + f * (hi.cop - lo.cop);
    }
  }
  return last.cop;
}

function copScaledAt(tempC, scalar) {
  // Clamp AFTER scaling — plan §1d, anti-pattern guard T5
  return clamp(copBaseAt(tempC) * scalar, HP_CONFIG.COP_CLAMP_MIN, HP_CONFIG.COP_CLAMP_MAX);
}

function buildScaledCopCurvePoints(scalar) {
  return COP_ANCHORS_BASE.map(a => ({
    temp_c: a.temp_c,
    cop: clamp(a.cop * scalar, HP_CONFIG.COP_CLAMP_MIN, HP_CONFIG.COP_CLAMP_MAX),
  }));
}

function computeCopByHh(external, scalar) {
  return external.map(e => e.temp_c === null ? null : copScaledAt(e.temp_c, scalar));
}

function computeHpCapacity(htc, setpointC, scalar, warnings) {
  if (htc === null || setpointC === null) {
    return { hp_capacity_kw: null, hp_capacity_kw_elec: null };
  }
  if (setpointC <= HP_CONFIG.T_DESIGN_C) {
    warnings.push(
      `Inferred setpoint (${setpointC.toFixed(1)}°C) is at or below the design outdoor temperature (−3°C). ` +
      'Check the thermostat setpoint.'
    );
    return { hp_capacity_kw: null, hp_capacity_kw_elec: null };
  }
  const hp_capacity_kw      = htc * (setpointC - HP_CONFIG.T_DESIGN_C) / 1000;
  const copDesign            = copScaledAt(HP_CONFIG.T_DESIGN_C, scalar);
  const hp_capacity_kw_elec = hp_capacity_kw / copDesign;
  return { hp_capacity_kw, hp_capacity_kw_elec };
}

function computeDiagnostics(external, heating, copByHh) {
  let weightedSum = 0;
  let totalWeight = 0;
  let heatingHhCount = 0;
  let belowDesignHeatingCount = 0;
  let copMin = +Infinity;
  let copMax = -Infinity;
  let nonNullCopExists = false;

  for (let i = 0; i < external.length; i++) {
    const cop    = copByHh[i];
    const temp   = external[i].temp_c;
    const hkwh   = heating[i].heating_kwh;
    const absent = heating[i].is_absence;

    if (cop !== null) {
      nonNullCopExists = true;
      if (cop < copMin) copMin = cop;
      if (cop > copMax) copMax = cop;
    }

    // annual_mean_cop and fraction_below_design_temp exclude absence days
    if (cop !== null && hkwh !== null && hkwh > 0 && !absent) {
      weightedSum += hkwh * cop;
      totalWeight += hkwh;
      heatingHhCount++;
      if (temp !== null && temp < HP_CONFIG.T_DESIGN_C) belowDesignHeatingCount++;
    }
  }

  return {
    annual_mean_cop:           totalWeight > 0 ? weightedSum / totalWeight : null,
    fraction_below_design_temp: heatingHhCount > 0 ? belowDesignHeatingCount / heatingHhCount : null,
    cop_range:                 nonNullCopExists ? { min: copMin, max: copMax } : null,
  };
}

function buildWarnings(annualMeanCop, fractionBelow, scalar, copAtDesign, warnings) {
  if (annualMeanCop !== null && annualMeanCop < HP_CONFIG.MEAN_COP_LOW_WARN) {
    warnings.push(
      `Estimated average COP of ${annualMeanCop.toFixed(2)} is low for an air-source heat pump. ` +
      'This may reflect a very cold climate, an inefficient installation, or an unusual heating pattern. ' +
      'Check the COP setting or consider a ground-source heat pump.'
    );
  }
  if (fractionBelow !== null && fractionBelow > HP_CONFIG.BELOW_DESIGN_WARN) {
    const pct = (fractionBelow * 100).toFixed(1);
    warnings.push(
      'Your heating data includes periods when the outdoor temperature drops below −3°C ' +
      `on ${pct}% of heating hours. At these temperatures your heat pump may need backup ` +
      'heating — factor this into sizing and cost estimates.'
    );
  }
  if (scalar !== 1.0 && copAtDesign < HP_CONFIG.COP_AT_DESIGN_LOW_WARN) {
    warnings.push(
      'With the current COP setting, the heat pump operates near or below COP = 1.5 ' +
      'in cold weather — comparable to a direct electric heater. Consider whether the ' +
      'heating economics still make sense at this efficiency level.'
    );
  }
}

function computeValidationStatus(external, baseloadMethod, htc, setpointC) {
  if (baseloadMethod === 'no-gas') return 'no_gas';
  if (external.every(e => e.temp_c === null)) return 'no_temp_data';
  if (htc === null) return 'no_htc';
  if (setpointC === null) return 'no_setpoint';
  return 'ok';
}

// ===== Main export =====

export function estimateHeatPumpModel(external, heating, heatLoss, thermalCharacter, baseloadMethod, userCopScalar) {
  const warnings  = [];
  const scalar    = clampScalar(userCopScalar ?? HP_CONFIG.USER_SCALAR_DEFAULT);
  const htc       = heatLoss?.htc_w_per_k ?? null;
  const setpointC = thermalCharacter?.setpoint_c ?? null;

  const validation_status = computeValidationStatus(external, baseloadMethod, htc, setpointC);

  const cop_curve_points   = buildScaledCopCurvePoints(scalar);
  const cop_at_design_temp = copScaledAt(HP_CONFIG.T_DESIGN_C, scalar);
  const cop_by_hh          = computeCopByHh(external, scalar);

  const { hp_capacity_kw, hp_capacity_kw_elec } =
    computeHpCapacity(htc, setpointC, scalar, warnings);

  const { annual_mean_cop, fraction_below_design_temp, cop_range } =
    computeDiagnostics(external, heating, cop_by_hh);

  buildWarnings(annual_mean_cop, fraction_below_design_temp, scalar, cop_at_design_temp, warnings);

  return {
    cop_by_hh,
    hp_capacity_kw,
    hp_capacity_kw_elec,
    cop_curve_points,
    cop_at_design_temp,
    user_cop_scalar: scalar,
    annual_mean_cop,
    fraction_below_design_temp,
    cop_range,
    design_temp_c: HP_CONFIG.T_DESIGN_C,
    validation_status,
    warnings,
  };
}
