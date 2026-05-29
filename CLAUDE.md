# CLAUDE.md — Heat Pump Analyser

This file is auto-loaded by Claude Code. It contains **operational rules only**.
Do not duplicate content that exists in agent files, general-principles.md, or
README.md — reference it instead.

- Project description, tech stack, file structure → `README.md`
- Design documents (module specs) → `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/design/`
- Scope and key decisions → `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/scope.md`
- Architecture and data flow → `~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/architecture.md`
- Agent protocols and formats → `~/Documents/git-repos/claude-coding-hub/coding/agents/`
- Generic coding standards → `~/Documents/git-repos/claude-coding-hub/coding/rules/general-principles.md`
- JS learnings → `~/Documents/git-repos/claude-coding-hub/coding/languages/javascript/learnings.md`
- JS patterns → `~/Documents/git-repos/claude-coding-hub/coding/languages/javascript/patterns.md`
- Session memory → `~/Documents/git-repos/claude-coding-hub/context/heatpump-memory.md`

---

## Model & Role

**Model:** Sonnet. **Role:** Implementer.

This window executes approved plans. Write code per design docs and approved plans.
Flag deviations in the plan file — do not redesign on the fly.

Architecture, design, plan review, **and debug investigation** happen in a parallel
Claude Code window running Opus. That window operates out of
`~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/`.

> **Methodology:** This project follows the role-separated, structurally-enforced
> build methodology in
> `~/Documents/git-repos/claude-coding-hub/coding/rules/build-methodology.md`.
> Read or re-read that file when calibrating role boundaries, debug handoffs,
> or anti-patterns.

**If a request requires architectural judgement or design changes, stop and flag
it to Rhiannon** rather than proceeding. The Opus window is the right place for
that work.

**If a runtime bug surfaces** — wrong output, silent failure, missing UI state,
framework misbehaviour — **do NOT enter fix mode in this window.** Surface the bug
to Rhiannon so the Opus architect window can open a debug investigation, produce
a debug document with a scoped fix, and hand it back to this window for fix
application. Per build-methodology §5, debug is architect-owned. Compile / import
errors remain implementer territory (see `build-error-resolver.md`).

---

## Project Identity

**Project:** Heat Pump Analyser
**Owner:** Rhiannon (Praxis Insight)
**Classification:** GREEN — full Claude assistance permitted.
**Language:** HTML + vanilla JavaScript + Chart.js
**Status:** investigation-instrumentation implemented (2026-05-29): read-only diagnostic console getters added to app.js; __getPricingResult extended with gas_standing_gbp/gas_energy_gbp/elec_standing_gbp per scenario; __getFinancialResult extended with m8_components (M8 components scaled to annual); __reconcileCosts added (verdict + note per scenario routing INV-1 to display logic or effectivePricingResult/financial.js); __getScenarioDiagnostics added (indoor_temp_stats single-pass min/mean/max/fraction_below_setpoint, heat_balance_kwh post-hoc approximation, comfort_demand_inputs, comfort_demand_kwh pass-through from M5 annual_modelled_demand_kwh); __getThermalDiagnostics added (path_a/path_b kj_per_k + tau_h). thermal-character.js: _path_diagnostics added to return object (path_a/path_b kj_per_k + tau_h captured before Path B override). No UI changes, no calculation changes. No deviations. All test suites green: M3 18/18, M5 39/39, M5b 29/29, M6 24/24, M7 39/39, M8 24/24, M9 24/24. ui-day-view-charts implemented (2026-05-07): two-tile day-view chart section between financial-card and What If; left tile dual-axis dispatch+price chart (current gas area + smart HP area + gas rate line + HH elec rate line); right tile temperature chart (outdoor dashed + current estimated + smart HP estimated); date picker defaulting to 60th-percentile winter day; setupDayViewCharts wired into buildAndDisplayVerdict; renderDayViewDay handles no-data days, smart-unavailable dispatch note, current/smart temp availability visibility. Browser tests pending. Deviation D1 in plan. m7-scenario-consumption-revised implemented (2026-05-07): τ-based survival filter + cumulative storage constraint (S_max) in allocateGreedyDay; computeValidationStatusSmart adds thermal_mass check (returns 'no_thermal_mass'); buildRateArrays → prepareRates in runScenarioConsumption (D×W+P rates for smart dispatch); t_max_preheat_offset_c param wired from new slider; simulateCurrentRcTrace added; buildEffectivePricingResult helper (covers HH-insufficient + smart-not-ok, replaces inline block in runFinancialAnalysis); verdict chart includes all 4 scenarios (null → grey bar + 'Data unavailable' tooltip); Bug 3 notices in displayHeatLossResults + displayThermalCharacterResults; btnRecalcScenario chains M7→M8→M9. Tests: M7 39/39, M8 24/24, M9 24/24. Browser tests pending. Deviations D1–D2 in plan. bug-fix-results-display implemented (2026-05-07): verdictCard revealed before Chart.js init (Bug 1 — chart not rendering); `.hidden { display: none !important; }` fixes CSS specificity conflict with `.section-tiles` (Bug 2 — What If visible on page load). No deviations. Browser tests pending. agile-rate-robustness implemented (2026-04-30): commits beea7b6 (APX switch), e13a9a2 (calibration validation + 7-day rolling mean null imputation + coverage metadata), a91ceb7 (coverage warnings + plausibility floor + weighted-mean check), 8140075 (review: module constants + named constants). N2EX→APX provider switch; fetchAgileCalibration returns D_sample_count/P_sample_count/source; null_wholesale_fraction merged in app.js; expanded calibration validation (D 1.5–3.0, P 5–20, sample counts 50/20); imputeWholesaleForSlot (7-day preceding-window mean + global fallback + cap/D last-resort); HH_COVERAGE_WARN/INSUFFICIENT_THRESHOLD module constants; three-tier coverage warning in displayPricingResults; hhScenariosInsufficient suppresses HH rows in pricing table; effectivePricingResult passes null HH costs to analyseFinancials (sensitivity grid + payback exclusion); computeWeightedMeanHhRate + unusual-result-panel; populateDroveTile plausibility floor (0.85×cap); #unusual-result-panel in index.html; border-left CSS. Browser tests pending. Deviations D1–D5 in plan. ui-design-m10c-what-if implemented (2026-04-29): "What If" section replaces "Adjust the assumptions"; two tiles (Policy Reform + Wait for Technology combined; Get Your Quotes); dead event listeners removed (btnRecalcHpModel, btnRecalcPricing, btnRecalcFinancial); COP_BASELINE_AT_7C=2.91 constant; Policy Reform preset buttons (ofgem-apr26, levy-removal, historical) with auto-update M8→M9; Wait for Technology COP slider live display + Recalculate button (M6→M7→M8→M9); threshold COP computation (19 proportional-scaling iterations, exact under uniform scalar); Get Your Quotes grant presets + auto-update M9; disconnect gas toggle + split slider with net benefit computation; updatePolicyOutput/updateQuotesOutput/computeThresholdCop called from runFinancialAnalysis. Browser tests pending. ui-design-m10b implemented (2026-04-29): container 720→1100px, .section-tiles 2-col grid + mobile collapse, drove-card CSS (drove-title/stats/stat/label/value/context), index.html results-tiles wrapper (verdict+drove), your-home tiles wrapper (results+energy-summary), methodology 2×2 grid (heat-loss+thermal-char row 1, underheat full-width, hp-model+scenario row 2), section-banner-verdict→section-banner-cost-breakdown, app.js bannerCostBreakdown, droveCard DOM ref, populateDroveTile (4 stats), called from buildAndDisplayVerdict step 16i. Fixed: externalRes.external_metadata.agile_calibration path. Browser tests pending. m8-patch-gas-connection-retained implemented (2026-04-29): hybrid scenarios removed from all layers (M7/M8/M9/app.js/tests), gas connection retained in HP scenarios (baseload_kwh in dumb+smart), Agile D×W+P HH rates with isPeakHour (Europe/London), Ofgem cap 24.67p for dumb_hp_svt, 4-component cost decomposition (heating_gas/heating_elec/non_heating_gas/non_heating_elec), 5-column pricing table with table-scroll-wrap + field-note CSS, calibration-default warning, hh-overhead input removed. Tests: M7 25/25, M8 24/24, M9 24/24. Browser tests pending. ui-fixes-1, ui-fixes-2, patch-agile-region-calibration implemented (2026-04-29): savings format drop '+', SVT sub-note rewording, progress bar wiring, methodology DL grid layout, BUS eligibility note, verdict status line with fix-handler. Fix 4 cooling note removed, field order swap, Tier 1 gas unit detection, status notices collapse. GSP region extraction from tariff_code (M1), Agile D×W+P calibration step (M2), region select in CSV card, read-only region display in Octopus card. Browser tests pending. smart-scenario-fixes-1 implemented (2026-04-29): M5 comfort-demand diagnostic (underheat ratio, narrative), M7 DP replaced with per-day greedy LP anchored to observed B_d (restores Smart ≤ Dumb invariant), M10 underheat sub-panel + Heat to Comfort slider. Commits: bdc950e (phase 1), 3adcd5a (phase 2), phase 3 pending push. Modules 1–9 + M5b + M10a implemented. CORS probe confirmed PASS (2026-04-23). M1 patch implemented (2026-04-23): tariff windowing clamped, meter-stitching unit detection (Tier 1/2), gas sanity check shows kWh+£, total gas kWh in summary, baseload £/day display. Elexon wholesale price bug resolved (2026-04-24): date-only format, chunked fetch (stride 7 + to+1), boundary-SP dedup — 17,300 price periods, baseload separation passes. M4 implemented (2026-04-26): Siviour regression, sanity checks 4A–4D, ratings, solar aperture, HLP. Feature plan feature-m3-labelling-and-energy-summary implemented (2026-04-26, commit f74c1f1): AC label → warm-weather uplift, energy summary table, occupancy-correlation limitation, softened 4D warning, Elexon progress indicators, SP count warning suppression. M5 implemented (2026-04-27): setpoint inference, thermal mass estimation (iterative 3-pass), time constant, thermal mass rating, occupancy weights, wall construction cross-check. Wired into both Octopus and CSV pipelines. Module 3b user test pending. M6 implemented (2026-04-27): EoH piecewise-linear COP curve, multiplicative user scalar (0.5–1.5), per-HH COP array, HP sizing (htc × ΔT / 1000), demand-weighted mean COP, fraction below design temp (absence-filtered), COP range, validation status, warnings. COP slider with live display; recalculate button. Wired into both pipelines. M7 implemented (2026-04-27): six-scenario consumption arrays (current, dumb HP ×2, hybrid dumb, smart HP, smart hybrid), RC model with DP pre-heating optimiser, per-HH rate arrays, buildRateArrays helper (reusable by M8), scenario summary table, sliders for pre-heat offset and occupancy threshold, recalculate button. Deviations: D1 double-infeasibility guard in DP backtrack; D2 display container revealed early. Wired into both pipelines. M8 implemented (2026-04-27): prepareRates (Phase A: gas rate lookup, HH rate = wholesale + overhead, standing charges from tariff data), computeCosts (Phase B: six-scenario energy + standing + annual scaling + monthly breakdown), prefillRateInputs, displayPricingResults (scenario costs table, annualised £). Deviations: D1 btn-primary used (btn-secondary absent from CSS); D2 params-grid/card-intro/unit CSS added; D3 energy-summary-table reused. Wired into both pipelines. M9 implemented (2026-04-27): analyseFinancials — net investment (floor £0), per-scenario saving + payback, 5×5 price-sensitivity grid (best payback per gas/elec multiplier pair), 5-point COP sensitivity axis, break-even SVT electricity rate, displayFinancialResults (payback table, break-even interpretation). Deviations: D1 btn-primary; D2 parseRate reused; D3 live wiring; D4 break-even-text CSS added; D5 card order after M8 cards. Wired into both pipelines. M5b implemented (2026-04-27): multi-path thermal mass estimation — Path A (cold-soak, relaxed absence filter, long-event branch with t_at_restart_winter_c), Path B (tau_bucket lived-experience fallback), anchor check, plausibility gates on t_at_restart, tau-bucket sanity check, thermal_mass_source discriminator, Step 4c guidance warnings. Recalculate button chains M5→M7→M8→M9. New inputs added to thermal-char-card. test-m5b.mjs 29/29. Deviations: D1 long_event_discarded_for_missing_user_temp exposed in outer return; D2 T14 tests offStart=0 rather than kwh=0 predecessor (unreachable from contiguous scan).

Praxis hub context (in `~/Documents/git-repos/praxis-claude-hub/`):
- `context/about-rhiannon.md`

---

## Non-Negotiable Standards

**Halt-and-flag.** If information is insufficient, stop and state what is
missing. Do not proceed on best efforts.

**Accuracy over speed.** This tool produces financial outputs people may act on.
Plausible-looking but incorrect calculations are worse than no code.

**British English.** All output, all user-facing text. Dates: `dd-mmm-yyyy`.
Time: 24-hour. Currency: `£`.

**No frameworks.** Vanilla JS only. No React, no Vue, no build step, no
bundler. The tool must run as static files served from GitHub Pages.

**Client-side only.** All processing runs in the browser. No server calls
except to the external APIs listed in the design docs (Octopus, Postcodes.io,
Open-Meteo, Elexon).

---

## Security — Non-Negotiable

User API keys and consumption data **never leave the browser**.

- No analytics, no tracking, no telemetry
- No server-side endpoints
- API keys stored only in browser memory (not localStorage)
- All external API calls made directly from client JS
- User data is not persisted between sessions unless the user explicitly exports

**Review every commit** for accidental data exfiltration paths.

---

## Session Start Routine

Execute in order. Read only — do not write or modify files.

**Step 1.** This file is auto-loaded. Confirm you have read it.

**Step 2.** Read `README.md` for project context (tech stack, file structure).

**Step 3.** Identify the session task and determine which pipeline phase you
are entering. Load the required agent file(s) per the Phase Gates below.

**Step 4.** If implementing, list `docs/plans/` and read the current plan.
Confirm its Status field shows `✅ Approved` before proceeding.

**Step 5.** Output the session opening summary:

```
## Session Ready

### Current position
[What was last completed. Plan filename if one exists.]

### Phase and agents loaded
[Which pipeline phase you are entering. Which agent files you loaded.
GATE confirmation line.]

### Proposed first actions
[First three concrete actions with specific file names.]

### Blockers
[Infrastructure issues, missing files, ambiguity. Or: None.]
```

---

## Phase Gates — Mandatory

**You MUST NOT skip these.** Before entering any pipeline phase:
1. Read the agent file(s) listed below
2. Output a gate confirmation: `GATE: [phase] — loaded [files]`
3. Only then proceed

| Phase | Required files | Location |
|-------|---------------|----------|
| **Plan** | `planner.md` + `research.md` | `~/Documents/git-repos/claude-coding-hub/coding/agents/` |
| **Implement** | Plan file (must show ✅ Approved) — also applies to debug docs handed off from architect | `docs/plans/` and `docs/debug/` |
| **Review** | `code-reviewer.md` + `general-principles.md` | `~/Documents/git-repos/claude-coding-hub/coding/agents/` + `coding/rules/` |
| **Debug** | **Not loaded in this window.** Debug investigation is architect-owned (build-methodology §5). Surface bugs to Rhiannon; architect window opens investigation. Compile/import errors → `build-error-resolver.md`. |  |
| **Document** | `doc-updater.md` | `~/Documents/git-repos/claude-coding-hub/coding/agents/` |

---

## Coding Agent Pipeline

```
PLAN+RESEARCH → PLAN-SAVE → IMPLEMENT → REVIEW → VERIFY → DEVIATIONS → COMMIT → DOCUMENT+LEARN → USER-TEST
```

**Plan format, status values, four-stage lifecycle, and approval detection:**
→ `~/Documents/git-repos/claude-coding-hub/coding/agents/planner.md`. Do not
duplicate here.

**Never use `EnterPlanMode` or `ExitPlanMode`.** Use `docs/plans/` with async
review via claude.ai. → See planner.md Completion Protocol.

### Pipeline phases

| Phase | What happens |
|-------|-------------|
| **Plan+Research** | Read design doc for the module. Output: plan in `docs/plans/`. |
| **Plan-Save** | Commit plan, push, STOP. Review is async via claude.ai. |
| **Implement** | GATE: plan must show ✅ Approved. Write code per plan. |
| **Review** | GATE: load `code-reviewer.md` + `general-principles.md`. |
| **Verify** | Browser testing — see Verification below. |
| **Deviations** | Append to plan file immediately — requires implementation context. |
| **Commit** | Code + deviations + CLAUDE.md status update. Push. |
| **Document+Learn** | GATE: load `doc-updater.md`. Update README, CLAUDE.md status. Write learnings to `~/Documents/git-repos/claude-coding-hub/coding/languages/javascript/learnings.md`. |
| **User-Test** | Rhiannon tests in browser. Approved when she says so. |

### Continuous flow: Verify → Commit → Document

Do not pause between Verify and Document+Learn. Proceed continuously.

1. Implement
2. Review
3. Verify
4. **Deviations** — append to plan file
5. **CLAUDE.md status** — update Status line
6. **Commit and push**
7. **README updates** if file structure changed
8. Report completion

**Do not ask "shall I proceed?" — just do it.**

---

## Verification

No build tools. Verification is manual + structural:

1. **HTML validation** — well-formed, no broken references
2. **Console clean** — no errors in browser dev tools
3. **Cross-check calculations** — spot-check one HH period end-to-end against
   hand calculation in the design doc's test criteria
4. **Responsive check** — works at mobile (375px), tablet (768px), desktop (1280px)
5. **Security check** — no API keys in committed code, no external data
   exfiltration, no localStorage of sensitive data

---

## GitHub Pages Deployment

The `main` branch deploys to GitHub Pages automatically.

- Entry point: `index.html` at repo root
- All assets referenced with relative paths
- No build step — what's in the repo is what's served
- Test locally by opening `index.html` in a browser

---

## Design Documents — Where to Find Them

Design docs live in praxis-claude-hub, NOT in this repo:

```
~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/
├── scope.md               ← high-level scope and key decisions
├── architecture.md        ← data flow, modules, tech stack
├── process-notes.md       ← blog material and design process log
└── design/                ← module design docs (your build specs)
    ├── data-ingestion.md
    ├── external-data.md
    ├── baseload-separation.md
    ├── heat-loss.md
    ├── thermal-character.md
    ├── heatpump-model.md
    ├── scenario-consumption.md
    ├── pricing-engine.md
    ├── financial-analysis.md
    └── ui-design.md
```

Each design doc specifies inputs, outputs, method, assumptions, edge cases,
test criteria, and dependencies. **These are your build specs.** Read the
relevant design doc before planning any module.

---

## Design Tokens

| Token | Value | Usage |
|-------|-------|-------|
| Teal | `#3B8284` | Primary accent, interactive elements |
| Coral | `#FD7A7F` | Secondary accent, warnings, highlights |
| Navy | `#26588D` | Headers, strong text |
| Dark | `#2A3439` | Body text, backgrounds |

---

## Review Checklist

→ Generic code quality checks: load `code-reviewer.md` at Review phase (see
Phase Gates). The items below are **project-specific only:**

- [ ] No API keys, tokens, or user data in committed code
- [ ] All external API calls use HTTPS
- [ ] No localStorage/sessionStorage of API keys or consumption data
- [ ] Calculations cross-checked against design doc test criteria
- [ ] All user-facing text in British English
- [ ] Currency displayed as `£` with 2 decimal places
- [ ] Energy units consistent (kWh throughout)
- [ ] Chart.js charts responsive and readable at mobile width
- [ ] No hardcoded Octopus account data (Rhiannon's or anyone's)
- [ ] CLAUDE.md status current in same commit
- [ ] Design doc deviations recorded in plan file

---

## Learnings

**Language stack:** JavaScript (vanilla). Learnings go to the JS-specific file, NOT
the Python learnings file.

- **Learnings file:** `~/Documents/git-repos/claude-coding-hub/coding/languages/javascript/learnings.md`
- **Patterns file:** `~/Documents/git-repos/claude-coding-hub/coding/languages/javascript/patterns.md`

**When to write:** During the Document+Learn pipeline phase. Any reusable insight about
vanilla JS, Chart.js, browser APIs, GitHub Pages, or client-side architecture that would
help a future session.

**Do NOT load** Python or C#/F# learnings files. They are for other projects and will
waste context.

---

## Session Memory

Lightweight session state for recovery. Since this project runs locally (not EC2),
there is no spot-instance risk, but mid-session context exhaustion is still possible.

**Memory file:** `~/Documents/git-repos/claude-coding-hub/context/heatpump-memory.md`

**After every commit:** Update the memory file with:
1. Which module/plan was just completed
2. What is in progress
3. What remains

**Priority order when context pressure is high:**
1. Commit and push code
2. Update memory file
3. Documentation tasks

---

## Current Sequencing Position

### Module Implementation Order
(Determined by data flow — each module depends on the one above it)

- [x] Module 1: Data Ingestion (Octopus API + CSV + meter stitching)
- [x] Module 2: External Data (weather + wholesale prices)
- [x] Module 3: Baseload Separation
- [x] Module 4: Heat Loss Estimation (Siviour regression)
- [x] Module 5: Thermal Character (setpoint, thermal mass, time constant, occupancy weights)
- [x] Module 6: Heat Pump Model (COP curves)
- [x] Module 7: Scenario Consumption (RC model + pre-heating optimiser + dumb scenarios)
- [x] Module 8: Pricing Engine (tariff application)
- [x] Module 9: Financial Analysis (payback, sensitivity)
- [x] Module 10a: UI & Presentation v1 (verdict block, section structure, copy rewrite, methodology disclosure)

Update this checklist as modules complete.
