# Bug: CSV upload halts on spring-gap; M1 assumes Europe/London unconditionally

**Date:** 2026-06-02
**Reporter:** Rhiannon (encountered during Demo 1 verdict-coherence step)
**Status:** Root cause identified — scoped fixes proposed
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
