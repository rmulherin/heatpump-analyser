# Module 3 Patch — Step F: Remove run-length filter from absence detection

**Date:** 2026-04-24
**Status:** Awaiting approval — review via claude.ai before implementation begins.

---

## Task description

Amend `detectAbsences()` in `js/baseload.js` to remove the ≥3-consecutive-day run-length gate. Design doc amendment in commit `199d67a` (praxis-claude-hub, 2026-04-24) establishes that any whole day with `daily_gas < 20% × baseload_median` is now an absence regardless of run length. The `isWholeDay` check (requiring all 48 HH periods non-null) provides the meter-misread guard; the run-length minimum was a noise filter that user testing on Rhiannon's 12-month rolling window showed is harmful for households with frequent short trips or intermittent boiler faults.

---

## Research findings

- `ABSENCE_MIN_CONSECUTIVE_DAYS` is referenced in exactly two files: `js/baseload.js` (definition + usage) and `docs/plans/module-3a-gas-separation.md` (historical plan). The constant can be removed cleanly; no other code depends on it.
- `detectAbsences()` already groups calendar-contiguous low-gas dates into `absence_periods` entries. That grouping logic is retained unchanged; only the minimum-run gate at the end of the inner loop is removed. Single-day periods (`start === end`) are a valid new output.
- The `absenceDateSet` building loop iterates `absence_periods` using a date range walk — it handles single-day periods correctly (`start === end` adds one day). No change needed there.
- Step G and Step H consume `is_absence` from the `heating` array, not `absence_periods` directly. Their day-count guards (Step G: ≥14 heating days; Step H: ≥30 usable days) protect against over-flagging. No changes to those steps.
- No new vanilla JS patterns required. The change is a targeted removal.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/baseload.js` | Remove run-length constant and gate from `detectAbsences()` |

---

## Implementation steps

### Step 1 — Remove `ABSENCE_MIN_CONSECUTIVE_DAYS` from `BASELOAD_CONFIG` (Low)

In `BASELOAD_CONFIG` (lines 11–28), delete this line:

```js
  ABSENCE_MIN_CONSECUTIVE_DAYS: 3,
```

### Step 2 — Remove run-length gate from `detectAbsences()` (Low)

In `detectAbsences()`, the inner while-loop ends at `j` (the day after the last consecutive low-gas day). Replace the existing gate-and-push block:

**Before:**
```js
    const runLength = j - i;
    if (runLength >= BASELOAD_CONFIG.ABSENCE_MIN_CONSECUTIVE_DAYS) {
      absence_periods.push({ start: sortedDays[i], end: sortedDays[j - 1], days: runLength });
    }
    i = j;
```

**After:**
```js
    absence_periods.push({ start: sortedDays[i], end: sortedDays[j - 1], days: j - i });
    i = j;
```

Every low-gas whole day now enters `absence_periods`, including singletons and 2-day runs.

### Step 3 — Update inline comment (Low)

Update the comment above the grouping loop in `detectAbsences()`:

**Before:**
```js
  // Find runs of ≥3 calendar-consecutive low-gas whole days
```

**After:**
```js
  // Group calendar-consecutive low-gas whole days into periods; no minimum run — isWholeDay is the misread guard
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| More days flagged as absence reduces days available for Step G / Step H | Design intent: those days carry no heating signal. Step G guards on < 14 heating days; Step H guards on < 30 usable days. Both unchanged. |
| Households with many 1–2 day absences produce many small `absence_periods` entries | The warning and excessive-absence checks operate on `absence_days_total` (unchanged), not period count. No UX regression. |
| `absence_days_total > 300` excessive-absence check now triggers for more edge-case datasets | By design — more low-gas days are flagged. Threshold (300) is unchanged. |
| Partial-day meter reads are no longer protected by run-length filter | Protected instead by `isWholeDay` (all 48 HH non-null) — this was always the correct guard. Test 15a explicitly verifies this. |

---

## Success criteria

- [ ] **Test 13 (inverted):** A 2-day period where both whole days have `gas_kwh = 0` → `absence_periods` contains one entry `{ days: 2 }`; both days have `is_absence = true`; both excluded from Step G and Step H regressions. (Was: not flagged under ≥3 run-length rule.)
- [ ] **Test 15 (inverted):** A single whole day with `gas_kwh = 0` mid-winter → `absence_periods` contains one entry `{ days: 1 }`; that day has `is_absence = true`; excluded from Step G and Step H. (Was: not flagged.)
- [ ] **Test 15a (new):** A day where some HH periods are null (simulating meter-read failure) with near-zero recorded gas → NOT flagged as absence. `isWholeDay` returns false, so the day is not evaluated for the low-gas condition.
- [ ] **Test 11 (unchanged):** A 10-day period with `gas_kwh = 0` → `absence_periods` contains one entry `{ days: 10 }`; all 10 days excluded; R² computed on remaining days is higher than with absence included.
- [ ] **Test 14 (unchanged):** A 10-day period at 30% of normal gas (above 20% threshold) → NOT flagged as absence.
- [ ] `ABSENCE_MIN_CONSECUTIVE_DAYS` removed: `grep -r "ABSENCE_MIN_CONSECUTIVE_DAYS" js/` returns no results.
- [ ] No syntax errors in `baseload.js` (open in browser, console clean).

---

## Claude.ai Review — yyyy-mm-dd

**Reviewer:** Claude (Praxis Insight — Opus architect window)

**Overall verdict:** [Approved / Approved with clarifications / Revise and resubmit]

### What is solid
[What the plan gets right. Be specific.]

### Clarifications required before implementation
[Any ambiguity, missing specification, or underdefined behaviour that would force
Claude Code to make an undocumented decision mid-build. Each item must include
the resolution — not just the problem.]

### Minor observations (not blockers)
[Optional. Suggestions for V2, style notes, things to keep in mind.]

---

## Approval

**Status:** Awaiting approval — review via claude.ai before implementation begins.
**Approved by:** —
**Clarifications confirmed:** —

---

## Implementation Deviations

None.
