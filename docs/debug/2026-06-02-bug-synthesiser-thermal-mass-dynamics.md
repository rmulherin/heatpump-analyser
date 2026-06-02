# Bug: Synthesiser produces gas data consistent with no-thermal-mass building, blocking parameter recovery

**Date:** 2026-06-02
**Reporter:** Rhiannon (surfaced during Demo 1 verdict-coherence step, after F14 unblocked CSV upload)
**Status:** Root cause confirmed — F15 + F16 scoped
**Investigator:** Opus architect window
**Related:** [`2026-06-02-bug-synthesiser-face-validity.md`](./2026-06-02-bug-synthesiser-face-validity.md) (RESOLVED — F1–F9, face-validity); [`2026-06-02-bug-m1-csv-timezone-handling.md`](./2026-06-02-bug-m1-csv-timezone-handling.md) (RESOLVED — F14, M1 timezone)

## Symptom

After F14 unblocked the upload path, Demo 1 (`modern-out-for-work`) round-trips through the full M1–M9 pipeline and produces a verdict card. But the tool's parameter recovery is materially off, in a way that interferes with the intended Profile-3 demo story:

| Parameter | Synthesiser config | Tool's measurement | §F tolerance | Pass |
|---|---|---|---|---|
| HTC | 180 W/K | 105 W/K | ±20% | ❌ (42% off) |
| Thermal mass | 12,000 kJ/K | 1,079 kJ/K | (no numeric gate) | ❌ (91% off) |
| Setpoint | 20.0°C | 20.6°C | ±0.7°C | ✓ |
| Annual gas | 7,237 kWh (target) | 6,346 kWh | ±10% (TC2) | ⚠ (−12%, accepted earlier as climate-realistic) |

Additional symptoms:

- **Underheating diagnostic fires:** M5 reports `underheat_ratio: 0.56`, narrative "you appear to be underheating, ... about 44% less" — visible to the user as a yellow banner on the demo
- **Smart HP scenario suppressed:** M7 returns `validation_status.smart: "hp_undersized"` and the chart shows a blank bar for Smart HP — HH. Driven by the tiny inferred thermal mass (τ = 2.87 h) making smart-tariff pre-heat unhelpful per M7's threshold check
- **Indoor-temperature reconstruction is physically implausible:** M7's RC simulation shows indoor temp swinging from −2.5°C overnight to +41°C during evening heating — visible in the "A typical day" indoor-temp chart as a crash-and-spike pattern rather than the smooth decay-and-recover of a real building

The CSV upload now works end-to-end (per F14). The face-validity metrics from `bug-synthesiser-face-validity.md` round 4 are still passing (gas clamps <100, summer/winter ratio 1.69, etc.). The new issue is at the layer **above** face validity: parameter recovery + verdict narrative.

## Environment

- **Repo:** `heatpump-analyser`, branch main
- **Synthesiser commit:** 45e5cd4 (F14a — ISO 8601 with Z suffix)
- **M1 commit:** d9412a9 (F14b — honour explicit timezone)
- **Demo config commit:** ab7524b (modern-out-for-work iteration round 1: setpoint 20.0, baselines 5.0/2.0, elec 4.6, HTC unchanged at 180)
- **CSV under test:** `bake-output/modern-out-for-work/modern-out-for-work.csv`, 17,520 HHs, ISO 8601 Z-suffix timestamps
- **Tool environment:** browser, postcode CB12BX, Eastern England, manual tariff inputs (gas 5.7 p/kWh, elec 24.5 p/kWh, standing 31.4/61.6 p/day)

## Diagnostic data captured

Console-snippet outputs (full dumps in chat history; key findings summarised here):

**Snippet 1 — module getter dump** revealed:
- M4 fit R² = 0.91 (clean regression — not a noise issue)
- M4 warning: `"Solar correction produced a physically implausible result (likely noisy data). Fell back to temperature-only regression."` — solar coefficient came out negative, fallback to one-predictor OLS
- M5 used 56 cold-soak events; identically matches M3's 56 absence days → M5b is measuring tau from holiday-week cold-soaks, not nightly off-periods
- M7 indoor-temp reconstruction: min −2.5°C, max 41.2°C, mean 16.8°C, fraction below setpoint 0.73

**Snippet 2 — independent CSV analysis** revealed:
- 579 off-periods ≥2h exist in the data (nightly + daytime gaps + 7 holiday weeks); M5b is using only 56 of them
- Seasonal amplitude winter/summer = 5.7× ✓ (gas data shape is correct)
- Annual totals 6,346 gas / 1,856 elec ✓ (matches M4 view, close to Nesta targets within climate-realistic interpretation)

## Root cause

The synthesiser is a **kinematic** forward model. It computes gas during heating windows as `HTC × ΔT × duration / efficiency`, but skips computation entirely during off-windows (`if (isAbsence[i] || !heatingOn[i]) continue;` at [scripts/lib/synthesiser.mjs:287](../../scripts/lib/synthesiser.mjs#L287)).

Real buildings are **thermodynamic** — they store heat in their thermal mass. When heating turns off, indoor temperature decays slowly toward outdoor (per τ = mass / (HTC × 3.6) h). When heating restarts, the boiler has to refill the mass back to setpoint, producing a morning warmup burst that's substantially larger than steady-state maintenance.

The tool's M4 and M5b expect thermodynamic behaviour:

- **M4's Siviour regression** ([js/heat-loss.js:306](../../js/heat-loss.js#L306)): converts daily-gas-vs-HDD slope to HTC via `htc = alpha × 1000 × efficiency / 24`, which implicitly assumes daily heat loss equals `HTC × ΔT × 24h`. That's the integral a real thermal-mass-having building approaches even with intermittent heating (thermal mass keeps T_in near setpoint through brief off-periods, so the heating bursts have to make up most of the 24h heat loss).

- **M5b's Path A cold-soak measurement**: derives τ from morning warmup gas relative to overnight outdoor cooling severity. Real building: bigger morning gas after colder nights → slope reveals thermal mass. Our synthesiser: morning HH gas = `HTC × ΔT(06:00) × 0.5h × 0.001 / η`, identical to subsequent HHs in the window. There's no recovery burst because the model has no cooling debt to refill. So M5b's regression sees ~zero thermal mass signal.

Both modules are correct for real buildings. The synthesiser produces data inconsistent with their assumptions.

### Math check

For Demo 1 at HTC=180, Cambridge weather (annual_HDD ≈ 1900 K·days at base 15.5°C), and our twin-peak schedule (~9.3 h/day average heating window):

- **Kinematic (current synthesiser, no thermal mass):** daily heat loss = HTC × ΔT × heating_hours / 1000 / η. Annual gas ≈ 6,300 kWh ✓ matches our bake. M4 fits this as if `daily heat loss = HTC × HDD × 24h`, derives `HTC = 105`.

- **Thermodynamic (with thermal mass, τ=18h):** building cools modestly during off-windows (drops 4–6 K overnight), recovers in heating windows. Daily heat loss ≈ 0.79 × HTC × HDD × 24h × 0.001 (the intermittent factor reflects the daily-average indoor temp being slightly below setpoint). For HTC=180: annual gas ≈ 9,600 kWh — overshoots Nesta target by 33%.

These constraints are mutually exclusive: HTC=180 + thermal-mass dynamics + Nesta target = mathematically inconsistent at Cambridge weather.

The resolution requires both:
1. Implement thermal-mass dynamics in the synthesiser (so M4/M5b's expected signal exists in the data → parameter recovery works)
2. Recalibrate the §E HTC values to land annual gas back at Nesta targets under the new model (the original §E values implicitly assumed the no-thermal-mass synthesiser; revised values reflect what real households burning the Nesta totals actually have)

## Fix scope

Two paired changes that must land together. F15 enables proper modelling; F16 calibrates configs so totals stay near Nesta targets.

### F15 — Add indoor-temperature state with thermal-mass dynamics to the synthesiser

**File:** [scripts/lib/synthesiser.mjs](../../scripts/lib/synthesiser.mjs), `computeForwardModel` function (currently lines 277–296)

**Replace the current kinematic model with a thermodynamic one.**

Algorithm:

```
Initialise: T_in[0] = setpoint  (steady-state assumption at start of bake window)
            mass_kJ = archetype.building.thermal_mass_kj_per_k
            htc    = archetype.building.htc_w_per_k
            aperture = archetype.building.solar_aperture_m2
            setpoint = archetype.building.setpoint_c
            efficiency = archetype.building.boiler_efficiency

For each HH i = 0..n-1:
  T_out_i  = weather[i].temp_c
  solar_i  = weather[i].solar_w_m2
  
  # Solar gain applies always (warms the indoor air via thermal mass)
  solar_gain_kwh = aperture × solar_i × 0.5h × 0.001
  
  if isAbsence[i]:
    # No heating; passive RC + solar
    heat_loss_kwh = htc × (T_in[i] - T_out_i) × 0.5h × 0.001
    net_thermal_kwh = solar_gain_kwh - heat_loss_kwh
    T_in[i+1] = T_in[i] + net_thermal_kwh × 3600 / mass_kJ
    gas_heating[i] = 0
    
  else if heatingOn[i]:
    # Heating window: thermostat targets setpoint
    if T_in[i] < setpoint:
      # Catch up to setpoint + maintain through this HH
      warmup_kwh   = (setpoint - T_in[i]) × mass_kJ / 3600
      loss_at_set  = htc × (setpoint - T_out_i) × 0.5h × 0.001
      gas_thermal  = max(0, warmup_kwh + loss_at_set - solar_gain_kwh)
      gas_heating[i] = gas_thermal / efficiency
      T_in[i+1] = setpoint
    else:
      # At or above setpoint already (e.g. solar overshoot from previous HH); 
      # just maintain or coast — thermostat does not call for heat
      heat_loss_kwh = htc × (T_in[i] - T_out_i) × 0.5h × 0.001
      net_thermal_kwh = solar_gain_kwh - heat_loss_kwh
      T_in[i+1] = T_in[i] + net_thermal_kwh × 3600 / mass_kJ
      # Clamp at setpoint if drifting back down: thermostat resumes when below
      if T_in[i+1] < setpoint:
        T_in[i+1] = setpoint
        gas_thermal = (setpoint - T_in[i+1]) × mass_kJ / 3600 + htc × (setpoint - T_out_i) × 0.5 × 0.001 - solar_gain_kwh
        gas_heating[i] = max(0, gas_thermal / efficiency)
      else:
        gas_heating[i] = 0
        
  else:
    # Off window (not absence, just outside scheduled heating): passive RC + solar
    heat_loss_kwh = htc × (T_in[i] - T_out_i) × 0.5h × 0.001
    net_thermal_kwh = solar_gain_kwh - heat_loss_kwh
    T_in[i+1] = T_in[i] + net_thermal_kwh × 3600 / mass_kJ
    gas_heating[i] = 0
```

**Notes:**
- `T_in[n]` (final state) is discarded; only `T_in[0..n-1]` used as state before each HH's gas calc.
- Solar gain can drive indoor temp above setpoint during summer/shoulder months — that's realistic (UK homes without AC overheat in sunny weather). Don't clamp.
- Boiler is treated as unlimited-capacity (whatever gas is needed to reach setpoint within one HH, the model delivers). Real boilers have finite kW; for v1 this simplification is OK because well-sized boilers do reach setpoint quickly in winter.
- The `T_in[0] = setpoint` initial condition has a brief settling transient over the first ~5 HHs. Bake report should note this (and tests should ignore the first day).

**Expected behaviour changes:**
- Morning gas peak grows substantially (warmup burst from cooled-overnight state). For Demo 1 modern-out-for-work: morning HH gas rises from ~1.4 kWh to ~5–8 kWh.
- Daytime off-period: indoor temp drops gradually (4–6 K depending on τ and outdoor), not instantly. M7's indoor-temp viz shows realistic decay.
- Summer: heating windows fire but produce minimal gas (T_in already near setpoint from solar gain). No change to summer baseload (HW + cooking from `computeHWandCooking` is unchanged).
- **Solar gain becomes detectable to M4 at daily scale**: in the current synthesiser solar only affects heating-window HHs (when solar is mostly low), so M4's two-predictor regression couldn't extract a clean solar-aperture coefficient and fell back to temperature-only. Under F15, solar warms the building all day — sunny days produce smaller evening warmup → measurable gas-vs-solar correlation at daily scale → M4's solar correction should succeed and recover the configured `solar_aperture_m2`.
- Annual gas total INCREASES significantly at unchanged HTC config because cooling debt is now being made up. F16 corrects for this (with the solar caveat noted below).

### F16 — Recalibrate per-archetype HTC values for thermodynamic synthesiser

**Files:** all four demo configs in `demo-configs/`.

The original §E HTC values were implicitly fitted assuming the no-thermal-mass synthesiser (kinematic model). Under F15's thermodynamic model, the same configs would produce annual gas totals roughly 1.4–2× the Nesta targets. Recalibrate so annual gas lands within §F TC2 (±10% of target).

| Archetype | File | HTC current (§E) | HTC revised (F16) | Reasoning |
|---|---|---|---|---|
| modern-out-for-work | `modern-out-for-work.json` | 180 | **125** | Cambridge (HDD ≈ 1900), twin-peak 9.3 h/day, τ=33h at mass=12000 → ~0.79 intermittent factor; target 7,237 |
| average-in-all-day | `average-in-all-day.json` | 280 | **145** | Sheffield (HDD ≈ 2100), continuous 15.3 h/day, τ=44h at mass=18000 → ~0.92 intermittent factor; target 10,236 |
| small-and-efficient | `small-and-efficient.json` | 110 | **80** | London (HDD ≈ 1800), twin-peak 9 h/day, τ=28h at mass=8000 → ~0.80 intermittent factor; target 4,266 |
| big-old-draughty | `big-old-draughty.json` | 450 | **230** | Dumfries (HDD ≈ 2500), continuous 16.7 h/day, τ=36h at mass=30000 → ~0.92 intermittent factor; target 17,239 |

**Reasoning for the systematic shift down (factor ~0.5–0.75 across archetypes):** §E was implicitly assuming continuous-comfort-equivalent gas burn. Under thermodynamic dynamics with the household's actual occupancy schedule, less gas is burned (because the building drifts below setpoint during off-periods). To match the same Nesta annual totals, the configured HTC needs to come down proportionally.

**Solar offset not explicitly modelled in F16 HTC sizing.** The rough HTC values above used `annual_heating ≈ HTC × HDD × 0.024 × duty_factor / efficiency`. Real annual gas under F15 will be reduced by solar gain (~5–10% of heat-loss budget for these archetypes' aperture values × Cambridge-equivalent annual solar irradiance). So first-bake annual gas may land slightly below target (within ±15% but on the low side). If any archetype lands materially below target (e.g. below −12%), nudge that archetype's HTC up by ~10 W/K and re-bake — typically one iteration converges.

The revised values are still physically defensible for each archetype:
- modern-out-for-work HTC 125: consistent with 1990s semi + retrofit (cavity-fill insulation, double glazing)
- average-in-all-day HTC 145: typical 1960s–80s semi with loft insulation, partial cavity fill
- small-and-efficient HTC 80: modern flat or post-2010 small build
- big-old-draughty HTC 230: solid-wall pre-1930 detached with partial loft insulation only

No other config fields change. Thermal mass values, schedules, postcodes, baselines, noise overrides all stay as currently committed.

### Implementation order (for Sonnet)

1. Apply F15 to `scripts/lib/synthesiser.mjs`. Commit as `fix(synthesiser): F15 — add indoor-temperature state with thermal-mass dynamics`.
2. Apply F16 — update all four `demo-configs/*.json` files with revised HTC values. Commit as `fix(demo-configs): F16 — recalibrate HTC for thermodynamic synthesiser`.
3. Re-bake all four archetypes:
   ```
   node scripts/synthesise.mjs --archetype demo-configs/modern-out-for-work.json   --noise-config test-data/noise-config.json
   node scripts/synthesise.mjs --archetype demo-configs/average-in-all-day.json    --noise-config test-data/noise-config.json
   node scripts/synthesise.mjs --archetype demo-configs/small-and-efficient.json   --noise-config test-data/noise-config.json
   node scripts/synthesise.mjs --archetype demo-configs/big-old-draughty.json      --noise-config test-data/noise-config.json
   ```
4. Inspect each bake report; capture annual gas + face validity metrics.

### Code-side verification (for Sonnet — implementer phase ends here)

After re-baking, confirm:

- All four bakes complete without errors
- Each CSV is still 17,520 HHs with ISO 8601 Z-suffix timestamps (F14a invariant)
- Each archetype's annual gas total lands within **±15%** of its Nesta target (some headroom for first-pass calibration; if any archetype lands outside ±15%, surface back rather than re-tuning):

| Archetype | Target | Acceptable range (±15%) |
|---|---|---|
| modern-out-for-work | 7,237 | [6,151, 8,323] |
| average-in-all-day | 10,236 | [8,701, 11,771] |
| small-and-efficient | 4,266 | [3,626, 4,906] |
| big-old-draughty | 17,239 | [14,653, 19,825] |

- Face-validity metrics still pass for each archetype: gas_hdd_r² ≥ 0.65, summer_winter_ratio ≥ 0.95, weekday_weekend_ratio ∈ [0.8, 1.2], gas clamps ≤ 200, elec clamps ≤ 300

Append a verification block to this debug doc with the metric grid + annual deltas. Update Status to `Code-side verified; awaiting user browser-side verification`. Stop there — do NOT attempt browser verification (that's a user-test step for Rhiannon, per the F14 process lesson).

### Browser-side verification (Rhiannon's user-test step, after Sonnet's code-side verify)

For each archetype's CSV:
1. Upload via the tool's CSV upload path with the archetype's postcode (CB12BX, S10 2HQ, E14 9SH, DG2 7AS respectively)
2. Confirm:
   - No spring-gap notices (regression check on F14)
   - Pipeline runs to verdict card
   - **No "underheating" diagnostic banner** (or if it appears, only as a soft note for small-and-efficient where the household is genuinely modest in absolute consumption)
   - **Indoor-temperature chart shows realistic decay** — building cools 4–6 K during off-periods, recovers in heating windows. No crashes to outdoor or spikes above 30°C.
   - Tool's M4 reports HTC consistent with the archetype's rating:
     - modern-out-for-work: 105–145 W/K → "excellent"
     - average-in-all-day: 120–170 W/K → "excellent" or "good"
     - small-and-efficient: 60–100 W/K → "excellent"
     - big-old-draughty: 200–260 W/K → "good"
   - Tool's M5b reports thermal_mass within ±30% of config value (12k/18k/8k/30k)
   - Tool's M4 reports `solar_correction_applied: true` (no fallback to temperature-only) and `solar_aperture_m2` within ±30% of config value (4.0 / 3.0 / 2.0 / 5.0 m²)
   - Smart HP — HH scenario renders (not suppressed by `hp_undersized`)

If all four archetypes pass this user-test, Demo 1–4 are unblocked for verdict-coherence discussion in the architect window.

## Secondary concerns

- **Strategy doc §E recalibration.** The §E table in `praxis-claude-hub/projects/tools/heatpump-analyser/test-data-strategy.md` currently shows the original HTC values (180/280/110/450). After F16 lands and is verified, the §E table should be amended to reflect the new physics-grounded values (125/145/80/230) plus a note explaining the recalibration. Architect-side follow-up, NOT in this debug doc's scope.

- **M5b's UI flag wording.** Earlier discussion identified that the "Smart heat pump results are unavailable — thermal mass data is needed" banner is misleading (thermal mass IS available; the issue is τ being too low for meaningful pre-heat). After F15+F16 lands and unblocks smart HP, the banner shouldn't fire on demos. But the wording remains a real-user issue for low-tau homes. Separate small ticket — not in this debug doc's scope.

- **M4 continuous-heating assumption.** Discussed and concluded it's acceptable in context: M4 + underheating diagnostic + absence detection together form a complete and correct interpretation for real users. After F15 lands, our synthesiser produces data consistent with M4's assumption, so the issue is moot for our demos.

- **The five status-note paragraphs in this repo's CLAUDE.md should be updated after F15+F16 land** to reflect the new synthesiser state. Process note for Sonnet's Document+Learn phase.
