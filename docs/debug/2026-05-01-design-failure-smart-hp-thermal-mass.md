# Design Failure: Smart HP dispatch does not use thermal mass

**Date:** 2026-05-01
**Raised by:** Rhiannon (via post-launch observation)
**Status:** Design decision required before any fix can be scoped

---

## The failure in one sentence

The smart HP scenario (Module 7) was designed to require thermal mass as a prerequisite
for dispatching heat. The implementation does not use thermal mass in the dispatch at all.
Users are asked for inputs that have no effect on the results they are shown.

---

## Design contract (what was promised)

From architecture.md, Module 7 smart scenarios:

> "RC simulation + pre-heating optimiser. DP over 48 HH × discretised indoor-temperature
> states per day (~15 temp states between T_comfort − 1°C and T_max_preheat). Minimises
> daily cost subject to comfort (T_indoor ≥ T_comfort during occupied HH), thermal
> (T_indoor ≤ T_max_preheat), and HP capacity constraints at each HH's outdoor temperature."

The DP over temperature states requires thermal mass (C in kJ/K) as the core state
transition parameter: `ΔT = (heat_delivered + solar_gain − heat_loss) × 3600 / C`. The
design therefore explicitly requires thermal mass as a prerequisite for smart HP dispatch.

The UI design was built on this premise: `t_at_restart` and `tau_bucket` inputs exist
specifically to provide thermal mass when cold-soak estimation fails.

---

## What was actually built

During implementation (plan: smart-scenario-fixes-1, 2026-04-27), the DP was replaced
with a per-day greedy LP anchored to observed daily heating demand B_d. This was done to
fix a violated invariant: the DP was producing Smart HP costs > Dumb HP costs on some
days, which is physically wrong.

The greedy LP (scenario-consumption.js `allocateGreedyDay`, lines 69–136) does not take
thermal mass as a parameter. It redistributes the observed daily heating demand B_d to
cheaper HH slots within HP capacity limits, but applies **no thermal constraint**. It
assumes the building can absorb and store any amount of pre-heated energy — i.e., infinite
thermal mass.

Thermal mass (`thermalChar.thermal_mass_kj_per_k`) is consumed only by
`simulatePostHocTIndoor` (lines 138–163), which produces the indoor temperature trace for
display purposes. It has **zero effect** on:
- The heating schedule (kWh per HH slot)
- M8 costs for the smart HP scenario
- M9 payback for the smart HP scenario

The validation gate (`computeValidationStatusSmart`, lines 204–207) requires only `htc_w_per_k`
and `hp_capacity_kw` — not thermal mass. Smart HP results are therefore displayed whenever
M4 and M6 succeed, regardless of whether M5 produced a thermal mass estimate.

---

## Evidence

- **scenario-consumption.js:69–136** — `allocateGreedyDay` signature: no thermal mass parameter
- **scenario-consumption.js:166–196** — `buildSmartScenario` call to `allocateGreedyDay`: no thermal mass passed
- **scenario-consumption.js:204–207** — `computeValidationStatusSmart`: checks HTC + HP capacity only
- **scenario-consumption.js:138–163** — `simulatePostHocTIndoor`: the ONLY use of thermal mass — post-hoc trace only
- **app.js:1384–1388** — M5 Recalculate chains correctly M5→M7→M8→M9
- **Observation:** Switching tau_bucket from "cools within hours" to "takes days to cool" and recalculating changes the displayed thermal mass but produces identical M8 costs and M9 payback for smart HP

---

## Secondary defect (discovered during investigation)

The greedy LP optimises dispatch using **raw wholesale prices** (`buildRateArrays` in
app.js:1596, which returns `wholesale_p_kwh` without D×W+P calibration). M8 then charges
**D×W+P rates** (including the P=12p peak premium for 4pm–7pm slots). Because M7 is
unaware of the peak premium, it does not penalise scheduling heat into 4pm–7pm slots.
This reduces the smart scenario's optimality — it pays peak rates for heat it could have
scheduled to off-peak periods.

This is a secondary defect; it exists regardless of the thermal mass question and should
be fixed whichever design path is chosen.

Fix: in `runScenarioConsumption` (app.js:1596), replace the `buildRateArrays` call with
the calibrated `elec_hh_rate_by_hh` array from the pricing engine's `prepareRates` output
(already computed and stored in `rateMetadata`).

---

## Options

Three paths forward. A design decision is required before any code is written.

---

### Option A — Restore thermally-constrained DP

Reimpose the original design: replace the greedy LP with a DP that uses thermal mass as
the state-transition parameter.

**Requires:**
- Working DP that respects the Smart ≤ Dumb invariant (the reason the greedy LP was
  introduced)
- The violation was likely caused by the DP allowing the building to cool below comfort
  during a day, then "catching up" later — a day-boundary leak. The fix is to initialise
  each day's state from the previous day's final temperature and enforce the comfort
  constraint strictly, not just at HH boundaries
- Thermal mass remains a genuine prerequisite: smart HP is suppressed (null) if
  thermal mass is unavailable

**Pros:** Restores the design intent. Smart HP sensitivity to thermal mass is real and
correct. Results genuinely differ for high vs low thermal mass buildings.

**Cons:** More complex. DP requires careful constraint design. Performance (DP runs 365×
per year) needs validation. Risk of reintroducing the invariant violation.

---

### Option B — Add thermal mass constraint to greedy LP

Keep the greedy LP but add a per-day pre-heat budget derived from thermal mass. Before
scheduling heat into a cheap slot, check whether the building can physically absorb the
pre-heat (capacity = C × ΔT_max, where ΔT_max is the allowable pre-heat above setpoint).

**Requires:**
- Add C (thermal mass) and T_setpoint to `allocateGreedyDay` signature
- Add a running pre-heat budget per day: cap total pre-heated kWh at C × ΔT_max × conv
- Thermal mass becomes a genuine input to dispatch: smart HP suppressed if thermal mass
  null (restoration of the design contract)
- Smart ≤ Dumb invariant preserved because the constraint limits, not increases, heat delivery

**Pros:** Simpler than full DP. Thermal mass meaningfully constrains results. Restores
design contract without the DP complexity. Smart ≤ Dumb guaranteed by construction.

**Cons:** The pre-heat budget approximation is coarser than a full RC simulation. Does not
model the temperature evolution within the day — just caps the total pre-heat.

---

### Option C — Remove smart HP scenario; rename and reframe

Accept that the greedy LP is cost-aware dispatch without thermal simulation. Remove the
"Smart HP" scenario from the results. Replace it with a clearer label if desired (e.g.
"Optimised HP" or remove entirely). Remove the `t_at_restart` and `tau_bucket` inputs
from the UI since they serve no purpose for costing (only for the indoor temperature
trace, which is a secondary display).

**Requires:**
- Remove smart HP row from M7/M8/M9/display
- Remove or clearly label the tau_bucket and t_at_restart inputs as "display only — does
  not affect costs"
- Update scope.md and architecture.md to reflect the simplified model
- Update blog/LinkedIn content if smart HP was a featured scenario

**Pros:** Honest. No misleading inputs. Simpler codebase.

**Cons:** Loses a differentiating scenario. The economic case for smart HP (showing the
benefit of time-of-use optimisation) remains valid even without thermal constraints — the
greedy LP does genuinely shift heat to cheaper periods, which does genuinely reduce cost.
Removing it loses that insight.

---

### Option D — Keep status quo; add explicit caveat

Keep the greedy LP as-is. Add a clearly labelled note to the Smart HP results row:
"Assumes your home can store pre-heated energy. Results are an upper bound — buildings
that cool quickly will see smaller savings." Remove the pretence that tau_bucket affects
costs; add a note to the input: "Used to display the estimated indoor temperature trace.
Does not affect cost calculations."

**Pros:** Fastest. No code change to M7. Honest about the limitation.

**Cons:** Does not fix the design failure — just documents it. The tool still asks users
to provide inputs that do not affect costs. Rhiannon has explicitly rejected this
framing.

---

## Recommendation (architect view)

**Option B** — thermal-constrained greedy LP.

It restores the design contract (thermal mass required for smart HP, suppressed if null)
without the complexity and fragility of the full DP. The pre-heat budget approximation
is a reasonable model: a building with C = 5,000 kJ/K can absorb ~1.4 kWh per °C of
pre-heat — that is a real and meaningful constraint on the greedy LP.

The secondary defect (raw wholesale vs D×W+P in M7) should be fixed in the same
implementation regardless of which option is chosen.

**Decision required from Rhiannon before implementation begins.**

---

## Impact on inputs once fixed (Option B or A)

If thermal mass is restored as a genuine prerequisite:

- Smart HP is **null / suppressed** when M5 cannot determine thermal mass (cold-soak
  fails AND tau_bucket not entered)
- The `t_at_restart` and `tau_bucket` inputs directly affect smart HP costs (not just
  the temperature trace)
- Bug 3 (manual-entry flag not visible) becomes more important: the user needs a clear
  signal that entering these inputs will unlock / improve the smart HP result

This makes Bug 3's fix a dependency of the Option B/A fix.

---

## Files to change (if Option B chosen)

1. **scenario-consumption.js** — `allocateGreedyDay` and `buildSmartScenario`: add
   `thermalMassKjPerK` and `T_setpoint_c` parameters; compute per-day pre-heat budget;
   cap cumulative pre-heat within budget
2. **scenario-consumption.js** — `computeValidationStatusSmart`: add check for
   `thermalChar?.thermal_mass_kj_per_k != null`; return `'insufficient_data'` if null
3. **app.js** — `runScenarioConsumption`: pass `elec_hh_rate_by_hh` from
   `rateMetadata` to `estimateScenarioConsumption` instead of rebuilding from raw
   wholesale (fixes secondary defect)
4. **app.js** — display: suppress smart HP row gracefully if validation_status.smart
   is `'insufficient_data'`

This requires a design doc update (scenario-consumption.md in praxis-hub) before a
plan is written.
