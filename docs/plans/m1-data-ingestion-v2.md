# m1-data-ingestion-v2 — CSV timezone detection + days_with_data load gate

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the M1 v2 delta as specified in `design/m1-data-ingestion-v2.md`. Two changes to
`data-ingestion.js`: (1) flip the CSV naive-timestamp default from assume-Europe/London to
assume-UTC, adding DST artefact auto-detection to identify UK-local data; (2) add a
`days_with_data` load gate (≥ 90 non-blank days) on both the CSV and Octopus paths. A new
`timezone_detection` field is added to the M1 result envelope and wired into app.js.
All other M1 behaviour (Octopus path, gas-unit detection, meter stitching, tariff timeline,
normalisation, postcode validation) is unchanged.

---

## Research findings

**Existing code reviewed:**

- `parseCSV()` — single-pass parser. Naive timestamps go straight to `londonToUtc()` (assumes
  Europe/London). Autumn-back duplicates are detected post-UTC-conversion and both rows are
  rejected. Min-days check uses calendar span (`rangeDays < 30`), not non-blank-day count.
- `londonToUtc()` — converts a naive datetime string assuming Europe/London. Returns UTC ISO
  string or `{error: 'spring_gap'}`. Kept as-is; used only in the convert step once
  timezone is confirmed as Europe/London.
- `normaliseConsumption()` — returns `metadata.total_days` (calendar span). Needs additive
  `days_with_data` field (non-blank days count).
- `CONFIG.MIN_DAYS_FOR_ANALYSIS` — currently 30. The 90-day gate is a separate concept
  (`days_with_data`, not span); a new constant is added rather than changing this one.
- No existing DST detection logic. New helpers required.
- Octopus path (`fetchConsumptionStitched`, `normaliseConsumption`) assembles the result
  object in `app.js`; `timezone_detection` must be added there for the Octopus path.

**Design doc:** `praxis-claude-hub/projects/tools/heatpump-analyser/design/m1-data-ingestion-v2.md`

**Key decisions:**
- Two-pass approach in `parseCSV()`: collect all rows first (storing raw timestamp strings for
  naive rows), run detection on the full set, then convert. Required because detection needs
  the full date range before committing to a timezone.
- Autumn-back handling changes: v1 rejects both duplicate rows; v2 keeps both and uses row
  order to disambiguate (first occurrence = BST → UTC 00:00; second = GMT → UTC 01:00). This
  is correct per design doc §4.2 Step 4 and §5 (row order preserved).
- `days_with_data` counted in `normaliseConsumption()` — it already iterates every HH slot,
  making it the natural place to count non-blank days. Additive field; no downstream impact.
- No new test file: design doc §7 test criteria are Rhiannon's browser/integration tests
  (require real CSVs and API), not unit tests. Code-level correctness verified via the
  implementation steps and success criteria below.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/data-ingestion.js` | DST detection helpers, revised `parseCSV()`, `days_with_data` in `normaliseConsumption()`, Octopus-path `timezone_detection` |
| MODIFY | `js/app.js` | Wire `timezone_detection` + `days_with_data` into M1 result; Octopus-path `< 90` pop-up |
| MODIFY | `CLAUDE.md` | Update status block |

---

## Implementation steps

### Step 1 — Add CONFIG constants

In `data-ingestion.js` `CONFIG` object, add:

```js
MIN_DAYS_WITH_DATA: 90,   // non-blank days required for reliable analysis
```

Keep `MIN_DAYS_FOR_ANALYSIS: 30` and `WARNING_DAYS_THRESHOLD: 90` unchanged (used elsewhere).

### Step 2 — Add `lastSundayOf(year, month)` helper

New private helper in `data-ingestion.js`. Returns the date string (`YYYY-MM-DD`) of the
last Sunday of the given month/year. Used to locate the autumn-back (October) and
spring-forward (March) transition dates.

```js
function lastSundayOf(year, month) {
  // month is 1-indexed. Find last day of month, walk back to Sunday.
  const last = new Date(Date.UTC(year, month, 0)); // day 0 = last day of prev month+1
  const dow = last.getUTCDay(); // 0=Sun
  last.setUTCDate(last.getUTCDate() - dow);
  return last.toISOString().slice(0, 10);
}
```

### Step 3 — Add `findTransitionDatesInRange(naiveDates)` helper

Takes a `Set` of date strings (`YYYY-MM-DD`) present in the naive-timestamp data.
Returns `{ autumnDate, springDate }` — the transition date if it falls within the data
range, or `null` if not.

Checks every year spanning the data range for both October (autumn-back) and March
(spring-forward) transitions.

### Step 4 — Add `detectAutumnBack(naiveTimestamps, autumnDate)` helper

Given the full array of naive timestamp strings and the candidate autumn-back date,
checks whether `HH:MM` values `01:00` and `01:30` appear more than once on that date.
Returns `true` (duplicates found = UK local), `false` (no duplicates = UTC), `null`
(date not in range).

### Step 5 — Add `detectSpringForward(naiveTimestamps, springDate)` helper

Given the full array of naive timestamp strings and the candidate spring-forward date,
checks whether `01:00` and `01:30` are **absent** on that date despite adjacent HH slots
being present (verifies a real gap, not just a meter outage — checks that `00:30` and
`02:00` are present on the same date before concluding the gap is a DST signal).
Returns `true` (gap confirmed = UK local), `false` (contiguous = UTC), `null` (date not
in range or insufficient data to confirm).

### Step 6 — Add `detectCsvTimezone(naiveTimestamps)` function

Orchestrates Steps 3–5. Returns the full `timezone_detection` object:

```js
{
  source: 'csv_local_detected' | 'csv_utc_assumed' | 'csv_uncertain_assumed_utc',
  detection_signals: {
    autumn_back_observed: boolean | null,
    spring_forward_observed: boolean | null,
    confidence: 'high' | 'medium' | 'low',
  },
  warnings: string[],
}
```

Classification table from design doc §4.2 Step 3 (9 cases) implemented as a decision
tree. Contradictory signals (autumn true + spring false, or autumn false + spring true) →
`csv_uncertain_assumed_utc`, confidence `low`, warning emitted.

### Step 7 — Revise `parseCSV()` — two-pass structure

**Pass 1:** iterate all data rows; for each row:
- If explicit timezone (regex `/Z$|[+-]\d{2}:?\d{2}$/i`) → parse immediately to UTC ISO,
  store in `explicitRows` map keyed by row index.
- If naive → store raw timestamp string in `naiveRows` array (with row index + values).

After Pass 1, if `naiveRows.length > 0`, call `detectCsvTimezone(naiveRows.map(r => r.ts))`
to get `timezone_detection`. If all rows have explicit timezone, set
`timezone_detection.source = 'csv_utc_assumed'` (explicit offsets, no detection needed).

**Pass 2:** resolve naive rows using `timezone_detection`:
- If `source === 'csv_local_detected'`: call `londonToUtc(ts)` for each naive timestamp.
  Spring-gap error → skip row with warning (same as v1).
  Autumn-back duplicate handling (see Step 8).
- If UTC or assumed UTC: treat naive timestamp as UTC directly (`ts + 'Z'` after basic
  validation).

Merge explicit and converted-naive rows into `records` array, sorted by `interval_start`.

### Step 8 — Autumn-back disambiguation in `parseCSV()`

During Pass 2, when `source === 'csv_local_detected'`, track UTC timestamps in
`utcTimestampMap` as before, but on collision:
- **Do not reject.** Instead: first occurrence maps to UTC 00:00 (BST), second to UTC 01:00
  (GMT). Achieves this by checking which of the two `londonToUtc()` results would apply —
  the function already handles this correctly via the round-trip check for the first
  occurrence (BST reads back as 01:00 local; GMT reads back as 01:00 local too, but at
  different UTC). Implement by tracking autumn-back date explicitly: on that date, first
  `01:00` row → UTC 00:00, second → UTC 01:00 via direct UTC offset arithmetic.

For UTC-assumed paths: if a naive duplicate occurs (not on a known autumn-back date), emit
a warning and skip the second row (ambiguous, not a known DST transition).

### Step 9 — Update `days_with_data` check in `parseCSV()`

Replace the existing calendar-span check:

```js
// OLD
const rangeDays = rangeMs / (24 * 60 * 60 * 1000);
if (rangeDays < CONFIG.MIN_DAYS_FOR_ANALYSIS) { ... }
```

With a non-blank-day count:

```js
// NEW — count distinct days that have at least one row present
const daysPresent = new Set(records.map(r => r.interval_start.slice(0, 10))).size;
if (daysPresent < CONFIG.MIN_DAYS_WITH_DATA) {
  errors.push(`Only ${daysPresent} days of data found. At least ${CONFIG.MIN_DAYS_WITH_DATA} days are needed for a reliable analysis. See the instructions above for the minimum data requirements.`);
}
```

Return `timezone_detection` and `days_with_data` (= `daysPresent`) on the `parseCSV()`
result alongside `records` and `errors`:

```js
return { records, errors, timezone_detection, days_with_data: daysPresent };
```

### Step 10 — Add `days_with_data` to `normaliseConsumption()`

In the loop that builds `consumption[]`, count distinct days with at least one non-null
reading:

```js
const daysWithDataSet = new Set();
for (let ts = startMs; ts < endMs; ts += CONFIG.HH_INTERVAL_MS) {
  const isoStr = new Date(ts).toISOString();
  const elecVal = elecMap.has(isoStr) ? elecMap.get(isoStr) : null;
  const gasVal  = gasMap.has(isoStr)  ? gasMap.get(isoStr)  : null;
  if (elecVal !== null || gasVal !== null) {
    daysWithDataSet.add(isoStr.slice(0, 10));
  }
  // ... existing gapCount logic unchanged
}
```

Add to `metadata` return: `days_with_data: daysWithDataSet.size`.

### Step 11 — Octopus path `timezone_detection` + `days_with_data` check

In `app.js`, where the Octopus ingestion result is assembled (after `normaliseConsumption()`
is called), add:

```js
const timezone_detection = {
  source: 'octopus',
  detection_signals: { autumn_back_observed: null, spring_forward_observed: null, confidence: 'high' },
  warnings: [],
};
```

After `normaliseConsumption()` returns, check `metadata.days_with_data`:

```js
if (normResult.metadata.days_with_data < CONFIG.MIN_DAYS_WITH_DATA) {
  // Surface pop-up / inline warning to user
  showInsufficientDataWarning(normResult.metadata.days_with_data);
  // Do not block — allow pipeline to continue with warning visible
}
```

`showInsufficientDataWarning()` is a new minimal helper in app.js that reveals an existing
or new `#insufficient-data-warning` element in index.html, pre-filled with the day count.
Add the element to index.html in the CSV/Octopus input section.

### Step 12 — Wire into M1 result envelope

Wherever `setIngestionResult()` is called in `app.js`, include `timezone_detection` and
`days_with_data` in the result object stored. These are consumed by:
- The CSV input card UI (warnings surfaced to user)
- Integration-v2 §6.1 (data-sufficiency gate)

No downstream module (M2–M9) consumes `timezone_detection` — it is display-only on the
input card.

### Step 13 — Update `CLAUDE.md` status block

Add entry for `m1-data-ingestion-v2` to the Current Sequencing Position checklist once
implemented.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Two-pass restructure of `parseCSV()` introduces regression in explicit-tz rows | Explicit-tz path is unchanged from v1 (same regex, same `new Date()` parse). Pass 1 just stores them separately. |
| Autumn-back disambiguation logic is subtle | Design doc §4.2 Step 4 + §5 specifies row-order preservation. Implement by tracking first/second occurrence on the exact transition date, not by relying on `londonToUtc()` return values alone. Cover with test criterion 7. |
| Spring-forward gap check false-positive when meter gap coincides with 01:00–01:30 | Step 5 requires `00:30` and `02:00` present on the same date to confirm the gap is a DST signal. Meter gaps typically extend beyond 01:00–01:30. |
| `days_with_data < 90` reject breaks users who previously passed the `< 30` span check | Intentional per design doc §4.4 — the 90-day gate is a tighter, more correct threshold. Copy explains the requirement up front. |
| Octopus pop-up for `< 90` days — no existing UI element | Step 11 adds a minimal `#insufficient-data-warning` element. Full UI treatment is a UI plan concern; this plan only wires the logic and reveals the element. |

---

## Success criteria

- [ ] `parseCSV()` with a CSV containing `Z`-suffixed timestamps: `timezone_detection.source`
      = `'csv_utc_assumed'`; no warning; timestamps unchanged.
- [ ] CSV with naive timestamps spanning autumn 2025-10-26 (duplicated 01:00-01:30) and
      spring 2026-03-29 (missing 01:00-01:30): `source = 'csv_local_detected'`;
      `confidence = 'high'`; both signals `true`; timestamps converted to UTC.
- [ ] CSV with naive timestamps, autumn transition only: `confidence = 'medium'`;
      `spring_forward_observed = null`; converted; medium-confidence warning surfaced.
- [ ] CSV with naive timestamps, no DST transitions in range: `source =
      'csv_uncertain_assumed_utc'`; `confidence = 'low'`; verbose warning surfaced.
- [ ] Contradictory signals (autumn true, spring false): `source =
      'csv_uncertain_assumed_utc'`; `confidence = 'low'`; contradiction warning surfaced;
      pipeline not blocked.
- [ ] Autumn-back row-order disambiguation: first `01:00` row on transition date → UTC
      `00:00`; second `01:00` row → UTC `01:00`.
- [ ] CSV with `days_with_data < 90` non-blank days: rejected at load with copy referencing
      the 90-day requirement.
- [ ] Octopus path: `timezone_detection.source = 'octopus'`; no detection logic runs;
      `days_with_data` present on normalised metadata.
- [ ] Octopus path with `days_with_data < 90`: pop-up / warning surfaced; pipeline continues.
- [ ] All existing M1 tests (Octopus path, gas-unit detection, meter stitching) unaffected.
- [ ] All existing module test suites (M3, M5, M5b, M6, M7, M8, M9) still green after change.

---

## Implementation Deviations

None — plan not yet implemented.
