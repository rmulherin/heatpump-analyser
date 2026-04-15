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

---

## Project Identity

**Project:** Heat Pump Analyser
**Owner:** Rhiannon (Praxis Insight)
**Classification:** GREEN — full Claude assistance permitted.
**Language:** HTML + vanilla JavaScript + Chart.js
**Status:** Pre-implementation. Design docs in progress. Repo just created.

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
| **Document+Learn** | GATE: load `doc-updater.md`. Update README, CLAUDE.md status. |
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
    ├── thermal-simulation.md
    ├── heatpump-model.md
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

## Current Sequencing Position

### Module Implementation Order
(Determined by data flow — each module depends on the one above it)

- [ ] Module 1: Data Ingestion (Octopus API + CSV)
- [ ] Module 2: External Data (weather + wholesale prices)
- [ ] Module 3: Baseload Separation
- [ ] Module 4: Heat Loss Estimation (Siviour regression)
- [ ] Module 5: Thermal Simulation (RC model + pre-heating)
- [ ] Module 6: Heat Pump Model (COP curves)
- [ ] Module 7: Pricing Engine (6 scenarios)
- [ ] Module 8: Financial Analysis (payback, sensitivity)
- [ ] Module 9: UI & Presentation (charts, heatmap, sliders)

Update this checklist as modules complete.
