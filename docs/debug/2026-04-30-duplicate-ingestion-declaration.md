# Bug: SyntaxError on page load — API step non-functional

**Date:** 2026-04-30
**Reporter:** Rhiannon
**Status:** Investigating

## Symptom

`Uncaught SyntaxError: Identifier 'ingestion' has already been declared` thrown on page
load. All JS execution halted. API step non-functional. Secondary console error:
`favicon.ico:1 Failed to load resource: 404` (unrelated — GitHub Pages serving).

## Environment

- Vanilla JS, no build step — browser parses modules directly
- Served from GitHub Pages / local file open
- No library versions applicable (plain JS)

---

## Phase 1 — Observations

Grep for all `const/let/var ingestion` declarations across `js/`:

| File | Line | Context |
|------|------|---------|
| app.js | 809 | `const ingestion = getIngestionResult();` — top of `runExternalData()` |
| app.js | 890 | `const ingestion = getIngestionResult();` — Step 6 inside same function |
| app.js | 916 | inside a different function |
| app.js | 980 | inside a different function |
| app.js | 1154 | inside a different function |
| app.js | 1559 | inside a different function |
| app.js | 1716 | inside a different function |
| app.js | 2195 | inside a different nested block |

Lines 809 and 890 are both at the same indentation level inside `async function
runExternalData(showProgressFn, showStatusFn)` (function opens at line 808). There is
no nested block (`if`, `try`, `for`, etc.) enclosing line 890 that would create a
separate scope. Both declarations are in the function body scope.

All other occurrences are in separate functions — no conflict.

**Code path that executes when bug manifests:** module parse time. The browser's JS
engine hoists all `const`/`let` bindings within a scope before any code runs, detects
the duplicate at parse time, and throws before a single line executes.

**Minimal trigger:** loading `index.html`. Consistent, not intermittent.

---

## Phase 2 — Hypotheses

1. **[HIGH] Duplicate `const ingestion` in the same function scope** — Step 6 of
   `runExternalData` (line 890) re-declares a variable already declared at line 809.
   Evidence: confirmed by reading lines 808–891. Both are in the function body, same
   scope. This is the only pair with two declarations in the same scope.

2. **[LOW] Cross-file module-level duplicate** — `ingestion` declared at the top level
   in two separate JS modules. Evidence against: grep shows all occurrences are inside
   functions, none at module top level.

3. **[LOW] `var` hoisting conflict with `const`/`let`** — a `var ingestion` somewhere
   conflicting. Evidence against: no `var ingestion` found in grep results.

Hypothesis 1 is almost certainly correct based on direct code inspection.

---

## Phase 3 — Narrowing

**Minimal failing case:** the browser parses `app.js` and encounters `runExternalData`.
Within that function body, `const ingestion` appears at lines 809 and 890. `const` is
not re-declarable in the same scope — this is a hard parse error regardless of control
flow.

**Binary elimination:** the bug is isolated to `runExternalData()`, lines 809 vs 890.
All other `const ingestion` occurrences are in separate functions and cannot conflict.

**Origin of line 890:** introduced by the `patch-agile-region-calibration` commit (Step
6 Agile calibration block), which needed `ingestion.gsp_region`. The author added a new
`const ingestion = getIngestionResult()` for that step without noticing the identical
declaration already existed at line 809 at the top of the same function.

---

## Phase 4 — Root Cause

The `ingestion` variable declared at line 809 is in scope for the entire body of
`runExternalData`, including the Step 6 block at line 890. The Step 6 re-declaration
(`const ingestion = getIngestionResult()` at line 890) is redundant and illegal.
JavaScript `const` does not allow re-declaration in the same scope. The engine throws
at parse time, halting all module execution.

**Evidence:**
- app.js:808 — `async function runExternalData(` — function open
- app.js:809 — `const ingestion = getIngestionResult();` — first declaration
- app.js:890 — `const ingestion = getIngestionResult();` — duplicate in same function body
- No intervening block that would isolate 890 into a child scope

**Category A** — application logic error. Fix is direct: remove line 890's declaration;
the `ingestion` variable from line 809 is already in scope for the Step 6 block.

---

## Fix

Remove `const ingestion = getIngestionResult();` at line 890. The `ingestion?.gsp_region`
reference on line 891 resolves correctly using the declaration from line 809.

No other occurrences require changes.

## Verification

- [ ] Page loads without SyntaxError
- [ ] API step completes successfully (Agile calibration runs, `gsp_region` resolves)
- [ ] No regression in Agile calibration path

## Status: Fix pending
