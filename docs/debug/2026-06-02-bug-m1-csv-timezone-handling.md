# Bug: CSV upload halts on spring-gap; M1 assumes Europe/London unconditionally

**Date:** 2026-06-02
**Reporter:** Rhiannon (encountered during Demo 1 verdict-coherence step)
**Status:** **RESOLVED** — CSV upload now proceeds past M1 into the analysis pipeline; M5b thermal-mass prompt surfaced as a separate sibling issue (see follow-on debug doc)
**Investigator:** Opus architect window
**Related:** [`2026-06-02-bug-synthesiser-face-validity.md`](./2026-06-02-bug-synthesiser-face-validity.md) (RESOLVED; this is a sibling issue surfaced during the round-4 verdict-coherence handoff, not a continuation)

## Symptom

Uploading the round-4-baked `modern-out-for-work.csv` via the tool's CSV upload path:

1. Two notices appear on screen: `Timestamp at row 4228 falls in the spring clock-forward gap and is invalid.` and the same for row 4229.
2. The "Analyse" button visually re-enables after each click but no analysis proceeds.
3. Network tab is blank — no Postcodes.io, no Open-Meteo, no Elexon requests fire.
4. All read-only diagnostic getters return `{ available: false }`:
   ```
   window.__getThermalDiagnostics?.() → { available: false }
   window.__getScenarioDiagnostics?.() → { available: false }
   window.__getPricingResult?.()       → { available: false }
   window.__getFinancialResult?.()     → { available: false }
   window.__reconcileCosts?.()         → { available: false }
   ```

The bake CSV itself is structurally clean: 17,520 rows, 48 HHs every day (including 2025-03-30 spring-forward and 2025-10-26 autumn-fall-back), zero duplicate naive timestamps.

## Environment

- **Repo:** `heatpump-analyser`, branch main
- **Synthesiser commit:** 707c512 (round 4 closing, RESOLVED face-validity)
- **CSV under test:** `bake-output/modern-out-for-work/modern-out-for-work.csv` from Demo 1 parameter iteration round 1
- **Browser:** confirmed in user's session (no JS errors in console, just two row-numbered warning notices)

## Root cause

Two intersecting issues caused by an unvalidated developer assumption that was never tested against the only actual CSV producer in the project.

### RC8 — M1 fatals on spring-gap rows

[js/data-ingestion.js:482-484](../../js/data-ingestion.js):

```js
if (result.error === 'spring_gap') {
  errors.push(`Timestamp at row ${rowNum} falls in the spring clock-forward gap and is invalid.`);
  continue;
}
```

Pushes the spring-gap message to **`errors[]`**, not a separate notices/warnings array.

[js/app.js:2952-2958](../../js/app.js):

```js
if (errors.length > 0) {
  hideCsvProgress();
  for (const err of errors) showCsvStatus(err, 'error');
  btnCsvAnalyse.disabled = false;
  return;   // ← halts here, never reaches M2 onwards
}
```

App.js treats any non-empty `errors[]` as fatal. The pipeline halts after M1 ingestion, never triggering M2's external-data fetch, so no result cards render and the diagnostic getters stay at `{ available: false }`.

### RC9 — M1 assumes Europe/London for all naive timestamps, with no provision for explicit timezone

[js/data-ingestion.js:475-486](../../js/data-ingestion.js):

```js
} else {
  // Assume Europe/London
  const result = londonToUtc(rawTimestamp);
  // ...
}
```

M1 unconditionally calls `londonToUtc(rawTimestamp)` on every naive timestamp. The synthesiser produces naive UTC timestamps (no timezone marker). M1 interprets `"2025-03-30 01:00"` as `01:00 Europe/London local`, which doesn't exist on the spring-forward day → `spring_gap` error.

The "Assume Europe/London" comment reflects a design choice that was never validated:

- **The tool has never seen a real Octopus CSV** through the CSV upload path. (Confirmed by Rhiannon.) Real Octopus exports use ISO 8601 with explicit `+00:00` / `+01:00` offsets, 5 columns, single fuel per file — none of which match M1's expected 3-column naive-timestamp schema.
- **No converter script exists** to normalise Octopus → M1's expected format. Step 0a in `test-data-strategy.md` was scoped but never built.
- **The synthesiser was the first and only actual CSV producer** to flow through M1's CSV path. Its naive-UTC output was never round-tripped against M1's assumed-local interpretation before Demo 1 verdict-coherence.

The mismatch is purely internal: synthesiser writes UTC, M1 reads it as Europe/London local. Each piece was internally consistent in isolation; neither party validated the contract.

## Fix scope

The robust design (per Rhiannon's spec): M1 honours explicit timezone markers (`Z` or `±HH:MM` offset) when present; falls back to Europe/London for naive timestamps. The synthesiser declares its UTC choice explicitly by emitting `Z`-suffixed ISO 8601 timestamps.

Two paired commits, each cleanly separable for review:

### F14a — Synthesiser emits ISO 8601 with `Z` suffix in CSV output

**File:** [scripts/lib/synthesiser.mjs:602-606](../../scripts/lib/synthesiser.mjs) (`writeOutputs`)

```diff
   const lines = ['datetime,gas_kwh,electricity_kwh'];
   for (let i = 0; i < timestamps.length; i++) {
-    lines.push(`${timestamps[i]},${gasArr[i].toFixed(4)},${elecArr[i].toFixed(4)}`);
+    const isoTs = timestamps[i].replace(' ', 'T') + ':00Z';
+    lines.push(`${isoTs},${gasArr[i].toFixed(4)},${elecArr[i].toFixed(4)}`);
   }
```

Internal `timestamps[]` array (and the weather-alignment map keys) stay as `"YYYY-MM-DD HH:MM"` — unchanged. Only the CSV output writes the ISO-with-Z form (`"2025-03-30T00:00:00Z"`).

**Effort:** 2 lines.

### F14b — M1 honours explicit timezone, falls back to Europe/London for naive

**File:** [js/data-ingestion.js:475-487](../../js/data-ingestion.js)

```diff
   } else {
-    // Assume Europe/London
-    const result = londonToUtc(rawTimestamp);
-    if (result === null) {
-      errors.push(`Row ${rowNum}: timestamp "${rawTimestamp}" is not a valid date format. Use YYYY-MM-DD HH:MM.`);
-      continue;
-    }
-    if (result.error === 'spring_gap') {
-      errors.push(`Timestamp at row ${rowNum} falls in the spring clock-forward gap and is invalid.`);
-      continue;
-    }
-    utcIso = result;
+    // Honour explicit timezone (Z or ±HH:MM offset); otherwise assume Europe/London local.
+    const hasExplicitTz = /Z$|[+-]\d{2}:?\d{2}$/i.test(rawTimestamp);
+    if (hasExplicitTz) {
+      const parsed = new Date(rawTimestamp.replace(' ', 'T'));
+      if (isNaN(parsed.getTime())) {
+        errors.push(`Row ${rowNum}: timestamp "${rawTimestamp}" is not a valid date format.`);
+        continue;
+      }
+      utcIso = parsed.toISOString();
+    } else {
+      const result = londonToUtc(rawTimestamp);
+      if (result === null) {
+        errors.push(`Row ${rowNum}: timestamp "${rawTimestamp}" is not a valid date format. Use YYYY-MM-DD HH:MM or ISO 8601 with timezone.`);
+        continue;
+      }
+      if (result.error === 'spring_gap') {
+        errors.push(`Timestamp at row ${rowNum} falls in the spring clock-forward gap and is invalid.`);
+        continue;
+      }
+      utcIso = result;
+    }
   }
```

**Detection regex:** `/Z$|[+-]\d{2}:?\d{2}$/i` matches:
- Trailing `Z` (UTC marker, case-insensitive)
- Trailing `+HH:MM` / `-HH:MM` (with or without colon — `+00:00`, `+0000`, `-01:30` all match)

**Effort:** ~15 lines.

## Resulting producer-consumer contract

| Producer | CSV timestamp form | M1 interprets as | Works |
|---|---|---|---|
| Our synthesiser (post-F14a) | `2025-03-30T00:00:00Z` | Honoured UTC | ✓ |
| Hand-typed UK local-time CSV | `2025-03-30 06:00` | Europe/London (DST-aware) | ✓ |
| Real Octopus export (future, if normalised to 3 columns by a converter) | `2025-12-29T00:00:00+00:00` | Honoured offset | ✓ |
| Pre-F14a synthesiser CSVs (already baked) | `2025-03-30 00:00` | Europe/London (existing path) — **will fatal on spring-gap** | ✗ |

The last row matters operationally: any CSV baked **before** F14a lands will fail on M1 even **after** F14b lands, because the producer still wrote naive. Solution: re-bake all four demos with the F14a synthesiser before any verdict-coherence step. Trivial — 30 s per archetype.

## Verification plan

1. Apply F14a (synthesiser). Re-bake `modern-out-for-work`; spot-check the first few CSV rows show `2025-01-01T00:00:00Z` form.
2. Apply F14b (M1). Upload the freshly-baked `modern-out-for-work.csv` via the tool's CSV upload path with postcode CB1 2BX.
3. Confirm:
   - No "spring clock-forward gap" notices (or any other fatal errors)
   - Network requests fire to Postcodes.io → Open-Meteo → Elexon
   - Result cards render through to the verdict card
   - The diagnostic getters return populated objects (`available: true` or substantive data)
4. As a sanity check, hand-type a naive CSV like `datetime,gas_kwh,electricity_kwh\n2025-04-15 06:00,0.5,0.1\n...` (a few rows, no Z suffix) and confirm M1 still reads it via the Europe/London path. This verifies F14b's fallback didn't break the existing implicit-local-time path.

## Secondary concerns (not blocking, follow-up scope)

- **Real-Octopus-CSV ingestion is still unsupported.** Real exports are 5 columns (single fuel) with ISO+offset timestamps. The CSV upload path expects 3 columns (combined fuels). F14a/F14b don't address the schema mismatch — only the timezone interpretation. Either a converter (originally scoped as `test-data-strategy.md` Step 0a, never built) or an extended M1 path that natively accepts Octopus's format is needed for real users to upload raw Octopus CSVs. Defer to a vNext design discussion.

- **Strategy-doc amendment.** `test-data-strategy.md` edge-cases table cites "Match the tool's existing CSV ingestion handling (DST aware)" — this referenced a behaviour that was never validated against real data. Architect-side follow-up: amend that line to specify the post-F14 contract explicitly:
  > Synthesiser emits ISO 8601 with `Z` suffix (UTC). M1 honours explicit timezone; falls back to Europe/London for naive timestamps. Spring-gap and autumn-duplicate detection apply only on the Europe/London fallback path.

- **All four demos need re-baking** after F14a lands. The four CSVs in `bake-output/` are pre-F14a (naive UTC) and would fail M1 even after F14b. Sonnet should re-bake all four as part of the F14a verification step rather than just modern-out-for-work.

## Process note

Catching this required Rhiannon to:
- Push back on the assumption that "real Octopus CSVs use local time" (which I had inferred from M1's comment without verifying)
- Provide the real Octopus CSV format (5 columns, ISO+offset)
- Clarify that the tool has never actually consumed an Octopus CSV through the CSV upload path

Each of those was a domain-context correction that the architect window missed despite reading the strategy doc. Lesson for the architect window's discipline: when code contains an "Assume X" comment without a test or contract that validates X, treat X as unvalidated rather than as established fact.

A second process miss in this round: the architect's Sonnet handoff prompt for F14 bundled the browser-side verification (upload, DevTools inspection, paste-back) into Sonnet's work order. That's user-test work — Sonnet can't open browsers, click UI, or paste console output back. The implementer-window scope must end at "code change + CLI verification" (re-bakes, file checks, test runs). Browser verification is the user's role and belongs in a separate "ready for user test" handoff to Rhiannon.

---

## Phase 13 — Verification (round 1, partial)

**Date:** 2026-06-02
**Implementer:** Sonnet
**Commits applied:** 45e5cd4 (F14a), d9412a9 (F14b)

### Code-side verification — complete

**F14a (synthesiser ISO 8601 with Z suffix):**

- Commit 45e5cd4 applied to [scripts/lib/synthesiser.mjs](../../scripts/lib/synthesiser.mjs) `writeOutputs` function.
- All four archetype CSVs re-baked. Spot-check of first three data rows of each:

```
average-in-all-day.csv:    2025-01-01T00:00:00Z, ...
big-old-draughty.csv:      2025-01-01T00:00:00Z, ...
modern-out-for-work.csv:   2025-01-01T00:00:00Z, ...
small-and-efficient.csv:   2025-01-01T00:00:00Z, ...
```

All four match the expected `YYYY-MM-DDTHH:MM:00Z` form. ✓

**F14b (M1 honour explicit timezone, fall back to Europe/London):**

- Commit d9412a9 applied to [js/data-ingestion.js:464-487](../../js/data-ingestion.js).
- Branch logic verified against the scoped diff:
  - Explicit-tz regex `/Z$|[+-]\d{2}:?\d{2}$/i` present
  - Explicit-tz path uses `new Date(rawTimestamp.replace(' ', 'T'))` and `parsed.toISOString()`
  - Europe/London fallback path preserves the existing `londonToUtc` call, spring-gap detection, and error messaging
  - Error message for naive-timestamp failures updated to mention ISO 8601 alternative
- Code review pass: F14b applied as specified, no scope creep.

### Browser-side verification — pending user-test step

Sonnet's implementer phase ends here. The remaining verification is a user-test step that Rhiannon performs in the browser:

1. Open the tool in browser → CSV upload tab
2. Upload `bake-output/modern-out-for-work/modern-out-for-work.csv`
3. Enter postcode CB1 2BX (auto-fills region Eastern England)
4. Click Analyse
5. Expected:
   - No spring-gap notices
   - Network tab fires requests to Postcodes.io → Open-Meteo → Elexon
   - Result cards render progressively through to the verdict card
6. Once verdict card is visible, open DevTools console and run:
   ```js
   console.log(JSON.stringify({
     thermal:   window.__getThermalDiagnostics?.(),
     scenario:  window.__getScenarioDiagnostics?.(),
     pricing:   window.__getPricingResult?.(),
     financial: window.__getFinancialResult?.(),
     reconcile: window.__reconcileCosts?.(),
   }, null, 2))
   ```
7. Confirm getters return populated objects (not `{ available: false }`)
8. Paste output back to architect window for verdict-coherence assessment

**On success:** update this doc's Status to `RESOLVED — Demo 1 CSV upload works end-to-end through to verdict card`; proceed to V1 §V1 step 5 (DISCUSS verdict coherence) in the architect window.

**On any issue** (notices reappear, network blank, missing cards, getters still `available: false`): return to architect with the specific failure mode for further diagnosis.

### User-test result (2026-06-02)

Rhiannon ran the upload + analysis flow. **CSV ingestion succeeded** — no spring-gap notices, M1 proceeded into the analysis pipeline. F14a + F14b validated end-to-end at the timezone-handling layer.

A separate issue surfaced downstream: **M5b thermal-mass estimation prompts the user for input rather than auto-estimating from the demo CSV**. The expected behaviour for a synthesised demo is automatic thermal-mass estimation via M5b's Path A (cold-soak) or Path B (tau bucket fallback). User-input request implies both auto-paths failed.

This is a sibling issue, not a regression of F14. Opening a separate debug doc to investigate.

**Status:** RESOLVED — timezone handling fix validated. M5b auto-estimation failure tracked separately.


