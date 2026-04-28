# Module 3 Patch — Step F: Remove run-length filter from absence detection

**Date:** 2026-04-24
**Status:** ✅ Approved — 2026-04-24

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

- [x] **Test 13 (inverted):** A 2-day period where both whole days have `gas_kwh = 0` → `absence_periods` contains one entry `{ days: 2 }`; both days have `is_absence = true`; both excluded from Step G and Step H regressions. (Was: not flagged under ≥3 run-length rule.)
  ✅ Node test-m3-step-f.mjs T13a–T13d — 2026-04-28.
- [x] **Test 15 (inverted):** A single whole day with `gas_kwh = 0` mid-winter → `absence_periods` contains one entry `{ days: 1 }`; that day has `is_absence = true`; excluded from Step G and Step H. (Was: not flagged.)
  ✅ Node test-m3-step-f.mjs T15a–T15d — 2026-04-28.
- [x] **Test 15a (new):** A day where some HH periods are null (simulating meter-read failure) with near-zero recorded gas → NOT flagged as absence. `isWholeDay` returns false, so the day is not evaluated for the low-gas condition.
  ✅ Node test-m3-step-f.mjs T15a-a–T15a-c — 2026-04-28.
- [x] **Test 11 (unchanged):** A 10-day period with `gas_kwh = 0` → `absence_periods` contains one entry `{ days: 10 }`; all 10 days excluded; R² computed on remaining days is higher than with absence included.
  ✅ Node test-m3-step-f.mjs T11a–T11d — 2026-04-28.
- [x] **Test 14 (unchanged):** A 10-day period at 30% of normal gas (above 20% threshold) → NOT flagged as absence.
  ✅ Node test-m3-step-f.mjs T14a–T14c — 2026-04-28.
- [x] `ABSENCE_MIN_CONSECUTIVE_DAYS` removed: `grep -r "ABSENCE_MIN_CONSECUTIVE_DAYS" js/` returns no results.
  ✅ Confirmed 2026-04-28.
- [ ] No syntax errors in `baseload.js` (open in browser, console clean).

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-24
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `praxis-claude-hub/projects/tools/heatpump-analyser/design/baseload-separation.md` (commit `199d67a`)

### Context

Step F was amended on 2026-04-24 after user-testing on Rhiannon's 12-month real data showed R² = 0.49 and spurious regression signals caused by 1–2 day low-gas events (boiler faults, short trips) not being excluded. Design doc amended in `199d67a` to remove the ≥3-day run-length minimum; `isWholeDay` (all 48 HH non-null) is now the sole meter-misread guard.

### Required changes for implementation

None.

### Minor observations (not blockers)

None. Plan is minimal, targeted, and complete.

### Resolution of review changes

No changes required. Plan approved as submitted.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | ✓ pass |
| HIGH     | 0     | ✓ pass |
| MEDIUM   | 0     | ✓ pass |
| LOW      | 0     | — |

**Approach challenge confirmed:** root cause addressed (outlier days removed from regression); plan removes code rather than adding it; `absenceDateSet` loop verified to handle single-day periods correctly; no shared infrastructure affected; Step G/H day-count guards unchanged.

**No items deferred — all functionality specified in this plan is delivered.**

Verdict: APPROVE — targeted removal, complete test coverage, no regressions.

---

## Approval

**Status:** ✅ Approved — 2026-04-24
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** Option B selected (remove run-length minimum); isWholeDay is the misread guard; Test 13 and 15 inverted; Test 15a added.

---

## Implementation Deviations

None.
