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

Architecture, design, and plan review happen in a parallel Claude Code window
running Opus. That window operates out of
`~/Documents/git-repos/praxis-claude-hub/projects/tools/heatpump-analyser/`.

If a request requires architectural judgement or design changes, stop and flag it
to Rhiannon rather than proceeding. The Opus window is the right place for that work.

---

## Project Identity

**Project:** Heat Pump Analyser
**Owner:** Rhiannon (Praxis Insight)
**Classification:** GREEN — full Claude assistance permitted.
**Language:** HTML + vanilla JavaScript + Chart.js
**Status:** Modules 1–7 implemented. CORS probe confirmed PASS (2026-04-23). M1 patch implemented (2026-04-23): tariff windowing clamped, meter-stitching unit detection (Tier 1/2), gas sanity check shows kWh+£, total gas kWh in summary, baseload £/day display. Elexon wholesale price bug resolved (2026-04-24): date-only format, chunked fetch (stride 7 + to+1), boundary-SP dedup — 17,300 price periods, baseload separation passes. M4 implemented (2026-04-26): Siviour regression, sanity checks 4A–4D, ratings, solar aperture, HLP. Feature plan feature-m3-labelling-and-energy-summary implemented (2026-04-26, commit f74c1f1): AC label → warm-weather uplift, energy summary table, occupancy-correlation limitation, softened 4D warning, Elexon progress indicators, SP count warning suppression. M5 implemented (2026-04-27): setpoint inference, thermal mass estimation (iterative 3-pass), time constant, thermal mass rating, occupancy weights, wall construction cross-check. Wired into both Octopus and CSV pipelines. Module 3b user test pending. M6 implemented (2026-04-27): EoH piecewise-linear COP curve, multiplicative user scalar (0.5–1.5), per-HH COP array, HP sizing (htc × ΔT / 1000), demand-weighted mean COP, fraction below design temp (absence-filtered), COP range, validation status, warnings. COP slider with live display; recalculate button. Wired into both pipelines. M7 implemented (2026-04-27): six-scenario consumption arrays (current, dumb HP ×2, hybrid dumb, smart HP, smart hybrid), RC model with DP pre-heating optimiser, per-HH rate arrays, buildRateArrays helper (reusable by M8), scenario summary table, sliders for pre-heat offset and occupancy threshold, recalculate button. Deviations: D1 double-infeasibility guard in DP backtrack; D2 display container revealed early. Wired into both pipelines.

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
| **Implement** | Plan file (must show ✅ Approved) | `docs/plans/` |
| **Review** | `code-reviewer.md` + `general-principles.md` | `~/Documents/git-repos/claude-coding-hub/coding/agents/` + `coding/rules/` |
| **Debug** | `debug-investigator.md` + `research.md` | `~/Documents/git-repos/claude-coding-hub/coding/agents/` |
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
- [ ] Module 8: Pricing Engine (tariff application)
- [ ] Module 9: Financial Analysis (payback, sensitivity)
- [ ] Module 10: UI & Presentation (charts, heatmap, sliders)

Update this checklist as modules complete.
