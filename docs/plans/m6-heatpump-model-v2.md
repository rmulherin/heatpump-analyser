# m6-heatpump-model-v2 — 4-anchor EoH curve, clamp, cop_dhw, per-anchor overrides

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the M6 v2 delta as specified in `design/m6-heatpump-model-v2.md`. Three focused
changes to `js/heatpump-model.js`: (1) replace the v1 2-anchor COP curve `{−15, −3, 10, 20}`
with the 4-anchor EoH curve at MCS standard reference temperatures `{−7, 2, 7, 12}` and
replace slope-extrapolation past the outer anchors with clamp; (2) extend the user-adjustable
parameter set to include per-anchor overrides (`user_anchor_overrides`) with master-reset
semantics enforced at the UI boundary (m6 consumes, does not encode them); (3) add a new
`cop_dhw` output (flat `2.0 × user_cop_scalar`, clamped [1.0, 4.0]) for use by M7-v2 in
disconnect-gas scenarios. HP sizing formula, diagnostic outputs (`annual_mean_cop`,
`fraction_below_design_temp`, `cop_range`), validation_status flags, and null-passthrough
carry through unchanged.

---

## Research findings

**Existing code reviewed:**

- `js/heatpump-model.js` — well-structured module. `copBaseAt()` already implements
  clamp-at-outer-anchor + linear interpolation on `COP_ANCHORS_BASE`; the logic is correct
  and carries through to v2 once the anchor data changes. `buildScaledCopCurvePoints(scalar)`
  and `copScaledAt(tempC, scalar)` handle the current single-scalar mechanic — both become
  dead code in v2 and are removed. `estimateHeatPumpModel()` accepts 6 positional args;
  `userAnchorOverrides` is added as a 7th (default `null`). `USER_SCALAR_MAX` is 1.5 —
  needs widening to 2.0.

- `test-m6.mjs` — 24 `assert()` calls across 12 test blocks. T1–T5, T8, T12 use v1 anchor
  values (`2.37` at −3°C, `3.37` at 10°C, clamp at `1.44`/`4.14`) and must be rewritten
  with new expected values. T6 expects `cop_at_design_temp = 2.37` (v1 direct −3°C anchor);
  v2 interpolates between −7 and 2 anchors giving ≈ 2.459. T7, T9, T10, T11 test null
  passthrough and validation — logic unchanged, tests updated for new signature and the
  addition of `cop_dhw` in return object.

- `app.js` — `estimateHeatPumpModel` called once at line 1517 with 6 positional args
  (`scalar` is the 6th). Needs a 7th `null` arg for `userAnchorOverrides` until the
  UI v2 phase (what-if-v2) wires up per-anchor sliders.

- `copBaseAt()` is a private helper (not exported). In v2 it is superseded by
  `copFromCurve()` operating on pre-built effective points — removed in Step 3.

**Computed expected values for tests:**

- Interpolation at 5°C (between 2°C and 7°C anchors):
  `2.72 + (5−2)/(7−2) × (3.20−2.72) = 2.72 + 0.6 × 0.48 = 3.008`
- `cop_at_design_temp` at −3°C (between −7 and 2 anchors, scalar=1.0):
  `2.25 + (4/9) × 0.47 ≈ 2.459`
- Demand-weighted SCOP test (2.0 kWh at −3°C, 0.5 kWh at 10°C):
  COP(−3) ≈ 2.459; COP(10) = `3.20 + (3/5) × 0.15 = 3.29`
  SCOP = `(2.0×2.459 + 0.5×3.29) / 2.5 ≈ 2.625`

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/heatpump-model.js` | v2 anchor table, clamp, per-anchor overrides, cop_dhw |
| MODIFY | `test-m6.mjs` | Rewrite expected values; add v2 override + cop_dhw tests |
| MODIFY | `js/app.js` | Add `null` 7th arg to `estimateHeatPumpModel` call |

---

## Implementation steps

### Step 1 — Update `HP_CONFIG` constants

In `js/heatpump-model.js`, `HP_CONFIG` block:

- `USER_SCALAR_MAX`: `1.5` → `2.0`
- Add `COP_DHW_BASE: 2.0` (EoH H2 at 65°C+ flow ≈ 2.02)
- Add `COP_DHW_CLAMP_MAX: 4.0` (DHW COP > 4 is implausible)

### Step 2 — Replace `COP_ANCHORS_BASE` with v2 anchors

```js
const COP_ANCHORS_BASE = Object.freeze([
  { temp_c: -7, cop: 2.25 },  // EoH H4 cold-end plateau; honest — sparsest data
  { temp_c:  2, cop: 2.72 },  // EoH H4 through defrost zone
  { temp_c:  7, cop: 3.20 },  // EoH H4 on the steep rise
  { temp_c: 12, cop: 3.35 },  // EoH H4 at/just past curve peak
]);
```

`copBaseAt()` logic (clamp at outer anchors + linear interpolation between adjacent pairs)
is correct for any ascending anchor array — **no logic change needed**. However, `copBaseAt()`
is superseded by `copFromCurve()` in Step 3 and removed there.

### Step 3 — Add `copFromCurve(tempC, curvePoints)` and remove dead helpers

Add `copFromCurve` — same clamp + interpolate logic as `copBaseAt()` but operates on
pre-built effective curve points (anchors already have scalar/overrides applied):

```js
function copFromCurve(tempC, curvePoints) {
  if (tempC <= curvePoints[0].temp_c) return curvePoints[0].cop;
  const last = curvePoints[curvePoints.length - 1];
  if (tempC >= last.temp_c) return last.cop;
  for (let i = 0; i < curvePoints.length - 1; i++) {
    const lo = curvePoints[i], hi = curvePoints[i + 1];
    if (tempC >= lo.temp_c && tempC < hi.temp_c) {
      const f = (tempC - lo.temp_c) / (hi.temp_c - lo.temp_c);
      return lo.cop + f * (hi.cop - lo.cop);
    }
  }
  return last.cop;
}
```

Points are clamped to [1.0, 6.0] when built (Step 4), so no re-clamping inside this
function.

Remove `copBaseAt()` and `copScaledAt()` — both are superseded.

### Step 4 — Replace `buildScaledCopCurvePoints` with `buildEffectiveCurvePoints`

```js
function buildEffectiveCurvePoints(scalar, overrides) {
  return COP_ANCHORS_BASE.map(a => {
    const key    = String(a.temp_c);
    const pinned = overrides != null ? (overrides[key] ?? null) : null;
    const raw    = pinned !== null ? pinned : a.cop * scalar;
    return { temp_c: a.temp_c, cop: clamp(raw, HP_CONFIG.COP_CLAMP_MIN, HP_CONFIG.COP_CLAMP_MAX) };
  });
}
```

Per-anchor override wins over `base × scalar`; other anchors continue to scale by master.
Override values and `base × scalar` both clamped to [1.0, 6.0] at this point.

Remove `buildScaledCopCurvePoints`.

### Step 5 — Add `computeCopDhw(scalar, warnings)`

```js
function computeCopDhw(scalar, warnings) {
  const raw = HP_CONFIG.COP_DHW_BASE * scalar;
  if (raw > HP_CONFIG.COP_DHW_CLAMP_MAX) {
    warnings.push(
      `DHW COP of ${raw.toFixed(2)} before clamping is implausible — clamped to ${HP_CONFIG.COP_DHW_CLAMP_MAX}.`
    );
  }
  return clamp(raw, 1.0, HP_CONFIG.COP_DHW_CLAMP_MAX);
}
```

### Step 6 — Update `computeHpCapacity` to accept `effectivePoints`

Replace `scalar` parameter with `effectivePoints`. Replace `copScaledAt(T_DESIGN_C, scalar)`
with `copFromCurve(HP_CONFIG.T_DESIGN_C, effectivePoints)`.

```diff
-function computeHpCapacity(htc, setpointC, scalar, warnings) {
+function computeHpCapacity(htc, setpointC, effectivePoints, warnings) {
   ...
-  const copDesign            = copScaledAt(HP_CONFIG.T_DESIGN_C, scalar);
+  const copDesign            = copFromCurve(HP_CONFIG.T_DESIGN_C, effectivePoints);
   ...
 }
```

### Step 7 — Update `computeCopByHh` to accept `effectivePoints`

```diff
-function computeCopByHh(external, scalar) {
-  return external.map(e => e.temp_c === null ? null : copScaledAt(e.temp_c, scalar));
+function computeCopByHh(external, effectivePoints) {
+  return external.map(e => e.temp_c === null ? null : copFromCurve(e.temp_c, effectivePoints));
 }
```

### Step 8 — Update `estimateHeatPumpModel` main function

Add `userAnchorOverrides` as 7th parameter. Build `effectivePoints` once, pass to all
consumers. Add `cop_dhw` and `user_anchor_overrides` to the return object.

```diff
-export function estimateHeatPumpModel(external, heating, heatLoss, thermalCharacter, baseloadMethod, userCopScalar) {
+export function estimateHeatPumpModel(external, heating, heatLoss, thermalCharacter, baseloadMethod, userCopScalar, userAnchorOverrides) {
   const warnings  = [];
   const scalar    = clampScalar(userCopScalar ?? HP_CONFIG.USER_SCALAR_DEFAULT);
+  const overrides = userAnchorOverrides ?? null;

   const validation_status = computeValidationStatus(external, baseloadMethod, htc, setpointC);

-  const cop_curve_points   = buildScaledCopCurvePoints(scalar);
-  const cop_at_design_temp = copScaledAt(HP_CONFIG.T_DESIGN_C, scalar);
-  const cop_by_hh          = computeCopByHh(external, scalar);
+  const effectivePoints    = buildEffectiveCurvePoints(scalar, overrides);
+  const cop_curve_points   = effectivePoints;
+  const cop_at_design_temp = copFromCurve(HP_CONFIG.T_DESIGN_C, effectivePoints);
+  const cop_by_hh          = computeCopByHh(external, effectivePoints);
+  const cop_dhw            = computeCopDhw(scalar, warnings);

   const { hp_capacity_kw, hp_capacity_kw_elec } =
-    computeHpCapacity(htc, setpointC, scalar, warnings);
+    computeHpCapacity(htc, setpointC, effectivePoints, warnings);

   ...

   return {
     cop_by_hh,
+    cop_dhw,
     cop_curve_points,
     cop_at_design_temp,
     user_cop_scalar: scalar,
+    user_anchor_overrides: overrides,
     ...
   };
 }
```

### Step 9 — Update `app.js` call site

At line 1523 in `app.js`, add `null` as 7th argument:

```diff
     result = estimateHeatPumpModel(
       externalResult.external,
       baseloadResult.heating,
       heatLossResult,
       thermalChar,
       baseloadResult.baseload_metadata.method,
       scalar,
+      null,
     );
```

### Step 10 — Rewrite `test-m6.mjs`

Rewrite all 12 test blocks. Update `copAt()` helper to accept an optional `overrides`
argument (default `null`). New expected values from computed anchor data above:

| Test | Design doc | What it asserts |
|------|-----------|-----------------|
| T1 | §7.1 | Anchor regression: exact `{−7:2.25, 2:2.72, 7:3.20, 12:3.35}` at scalar=1.0 |
| T2 | §7.2 | Interpolation at 5°C → 3.008 (within 0.001) |
| T3 | §7.3 | Cold clamp: `copAt(−15, 1.0) === 2.25` (v1's 1.44 must not appear) |
| T4 | §7.4 | Warm clamp: `copAt(25, 1.0) === 3.35` (v1's 4.14 must not appear) |
| T5 | §7.5 | HP sizing: `cop_at_design ≈ 2.459`; `hp_capacity_kw = 4.896`; `hp_capacity_kw_elec ≈ 1.991` (htc=204, setpoint=21) |
| T6 | §7.6 | Scalar ×1.2: all 4 anchor cops + `cop_dhw` correct (5 assertions) |
| T7 | §7.7 | Override pin: scalar=1.2, `overrides={'7':4.5}` — anchors −7/2/12 scale by master; anchor 7 pinned at 4.5 (4 assertions) |
| T8 | §7.9 | Demand-weighted SCOP ≈ 2.625 (2.0 kWh @ −3°C, 0.5 kWh @ 10°C) |
| T9 | §7.10 | `cop_dhw = 2.0` at scalar=1.0, independent of temperature |
| T10 | §7.11 | `cop_dhw` scales: scalar=1.5 → 3.0; programmatic scalar=2.5 → clamp 4.0 + warning |
| T11 | §7.12 | `cop_dhw` unchanged when overrides present (`overrides={'7':5.0}` → `cop_dhw = 2.0`) |
| T12 | (carry) | Override value < 1.0 → clamped to 1.0 in `cop_curve_points` |
| T13 | (carry) | `cop_by_hh` sparse null passthrough |
| T14 | (carry) | `htc=null` → `hp_capacity_kw/elec` null; `cop_by_hh` + `cop_dhw` still computed; `validation_status='no_htc'` |
| T15 | (carry) | Setpoint ≤ design temp → `hp_capacity_kw` null + warning |
| T16 | (carry) | `design_temp_c === −3.0`; formula uses it correctly |
| T17 | (carry) | `validation_status` flags: `no_gas`, `no_temp_data`, `no_htc`, `no_setpoint`, `ok` |

Target ~24 `assert()` calls total.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Old tests reference v1 anchor values (1.44, 2.37, 3.37, 4.14) — all will fail against new data | All expected values recomputed from v2 anchors before writing tests |
| `clampScalar()` uses `HP_CONFIG.USER_SCALAR_MAX` — widening to 2.0 could permit scalar > 1.5 being passed from existing UI code | Existing UI sliders are capped at 1.5 in HTML; widening the JS constant is forward-compatible. New `cop_dhw` clamp [1.0, 4.0] is tighter than the space-heating clamp [1.0, 6.0] — `2.0 × 2.0 = 4.0` exactly at the boundary, no spurious warnings from valid UI input |
| `copFromCurve` uses `< hi.temp_c` (not `≤`) in the loop — exact anchor-temperature inputs fall to the next segment | The final `return last.cop` after the loop is unreachable in practice (handled by the outer clamp checks); all intermediate exact-anchor queries are captured by `tempC >= lo.temp_c && tempC < hi.temp_c` except the last anchor which is handled by `tempC >= last.temp_c` above the loop. Test T1 anchor regression catches any regression here |
| `cop_dhw` warning path unreachable via valid UI input (scalar capped at 2.0 → `2.0 × 2.0 = 4.0`, no warning) | Warning tested via programmatic call with scalar=2.5 in T10 |

---

## Success criteria

- [ ] `node test-m6.mjs` — all tests pass, 0 failures
- [ ] T1 anchor regression: `cop_curve_points` returns exactly `{−7:2.25, 2:2.72, 7:3.20, 12:3.35}` at scalar=1.0, no overrides
- [ ] T3/T4 clamp: cold-clamp returns 2.25, warm-clamp returns 3.35; v1 values 1.44/4.14 do not appear anywhere
- [ ] T5 HP sizing: `cop_at_design_temp ≈ 2.459` (within 0.01); `hp_capacity_kw = 4.896 kW`
- [ ] T7 override pinning: pinned anchor returns exact override; other anchors scale by master
- [ ] T9/T10/T11: `cop_dhw` correct at base, scaled, and independent of overrides
- [ ] `app.js` pipeline runs without error (null overrides wired)
- [ ] No API keys or user data in committed code

---

## Implementation Deviations

None.
