# m1-data-ingestion-v2 — Full v2 delta (re-cut 2026-06-03)

**Date:** 2026-06-03
**Status:** ⚠ Approved with edits — 2026-06-03. Implementation may begin.

---

## Task description

Re-cut of the m1 v2 plan against the **realigned** `m1-data-ingestion-v2.md` design doc
(committed `62f4fc0`, updated `eb538da`, `20a7d99`). The prior plan (2026-06-02) was
rejected — it covered only DST detection + `days_with_data`, predating the architecture-v2
alignment pass.

This plan implements the **full v2 delta** across five areas:

1. **DST auto-detection + UTC default (INV-19)** — two-pass `parseCSV()`, autumn-back
   disambiguation, classification table, `timezone_detection` output.
2. **`days_with_data` load gate** — single `<90` block on both CSV and Octopus paths
   (data-density, not calendar span), replacing v1's scattered 30-day and 90-day checks.
   Design decision confirmed: both paths block identically.
3. **Region as first-class M1 output** — Octopus path already done (verify only); CSV path:
   no change needed (plain user-selected dropdown, no default); demo: baked in asset.
4. **Demo-archetype source path** — `loadDemoArchetype(archetypeId)` + baked JSON assets
   in `data/demos/`; emitted by synthesiser (no parseCSV); runtime uses `fetch()` relative
   path; visual selector UI is NOT in m1 scope.
5. **CSV rate fields removed** — `csv-gas-rate/elec-rate/gas-standing/elec-standing`
   deleted (relocated to m2 §14).

**Implementation note (from design doc):** reproduced v1 mechanics are descriptive only;
only §10 deltas are mandates. Defer to working code where v2 describes unchanged behaviour;
flag any change-from-design in the deviations section.

---

## Research findings

### Existing code baseline

**`parseCSV()` (`data-ingestion.js:433`):**
- Single-pass. Naive timestamps passed straight to `londonToUtc()` — assumes Europe/London.
- Autumn-back duplicates: both rows rejected.
- Sufficiency: `rangeDays < CONFIG.MIN_DAYS_FOR_ANALYSIS` (30) — calendar span, not data
  density.

**`normaliseConsumption()` (`data-ingestion.js:697`):**
- Returns `metadata.total_days` (calendar span). No `days_with_data` field.

**Seven sufficiency checks to remove:**

| Location | Code | Action |
|----------|------|--------|
| `data-ingestion.js:433` (`parseCSV()`) | `rangeDays < MIN_DAYS_FOR_ANALYSIS` (30-day block) | Replace with `days_with_data < 90` block (Step 9) |
| `app.js:643` (Octopus path) | `meta.total_days < CONFIG.MIN_DAYS_FOR_ANALYSIS` → error + return | Remove (Step 11) |
| `app.js:3039` (CSV path) | `meta.total_days < CONFIG.MIN_DAYS_FOR_ANALYSIS` → error + return | Remove (Step 11) |
| `app.js` line ~653 (Octopus) | `meta.total_days < WARNING_DAYS_THRESHOLD` | Delete (Step 11) |
| `app.js` line ~660 (Octopus) | `meta.gap_percentage > GAP_WARNING_PERCENTAGE` | Delete (Step 11) |
| `app.js` line ~3049 (CSV) | `meta.total_days < WARNING_DAYS_THRESHOLD` | Delete (Step 11) |
| `app.js` line ~3056 (CSV) | `meta.gap_percentage > GAP_WARNING_PERCENTAGE` | Delete (Step 11) |

**CONFIG constants (`data-ingestion.js`):**
- `MIN_DAYS_FOR_ANALYSIS: 30` — three uses: `parseCSV():433` (replaced by Step 9),
  `app.js:643` (removed by Step 11), `app.js:3039` (removed by Step 11). Remove from
  CONFIG once all three uses are gone — Step 11.
- `WARNING_DAYS_THRESHOLD: 90` — two app.js warning blocks (to remove, Step 11).
- `GAP_WARNING_PERCENTAGE: 10` — two app.js warning blocks (to remove, Step 11).
- `DEFAULT_GAS_RATE_P_KWH/ELEC_RATE_P_KWH/GAS_STANDING_P_DAY/ELEC_STANDING_P_DAY` —
  defaults for CSV form fields. **Defer removal to m2 plan** (m2 inherits these constants).

**Region — Octopus path (`data-ingestion.js` line ~120, `app.js` line ~701):**
- `gsp_region` already extracted from tariff code last letter, validated against
  `VALID_GSP_REGIONS`, placed in `setIngestionResult()` via `gsp_region: prop.gsp_region ?? null`.
- ✅ No changes needed. Verify only in Step 19.

**Region — CSV path (`index.html` line ~111):**
- `gsp-region` `<select>` already exists with all 15 options (A–P) and a blank
  "— select your region —" first option. This is the correct v2 behaviour — plain
  user-selected, no default, no postcode interaction.
- ✅ No changes needed to the dropdown or to app.js region handling.

**CSV rate fields (`index.html` lines ~134–153):**
- 4 inputs across 2 `.form-row` blocks: `csv-gas-rate` (5.7), `csv-elec-rate` (24.5),
  `csv-gas-standing` (31.4), `csv-elec-standing` (61.6).
- ✅ Removal **confirmed** (Opus review 2026-06-03): the design now states m1 collects no rates
  (reference rates are m2's Ofgem-cap defaults). Steps 14–15 proceed.

**Demo path:**
- No demo function or wire-up exists in the tool.
- 4 archetype configs: `demo-configs/*.json` — each has `slug`, `label`, `bio`,
  `location.postcode`. No `gsp_region` field yet — must be added (Step 16a).
- Bake outputs (`bake-output/`) exist for all 4 archetypes but are gitignored.
- `data/demos/` directory exists; `data/demos/*.json` files are gitignore-exempt and
  ready to commit.
- The synthesiser generates UTC-aligned HH consumption data and will be extended to emit
  m1-contract JSON to `data/demos/` directly (Step 16b). No parseCSV invocation needed.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/data-ingestion.js` | DST helpers; revised `parseCSV()`; `days_with_data` in `normaliseConsumption()`; new CONFIG constant; `loadDemoArchetype()` + `DEMO_ARCHETYPES` export |
| MODIFY | `js/app.js` | Octopus `timezone_detection` stub + `days_with_data` block (not popup); remove 7 scattered check blocks; remove reads of CSV rate fields; demo pipeline wire-up |
| MODIFY | `index.html` | Remove CSV rate fields; minimal demo test trigger |
| MODIFY | `demo-configs/*.json` (×4) | Add `gsp_region` field to each archetype config |
| MODIFY | `scripts/lib/synthesiser.mjs` | Extend to emit m1-contract JSON to `data/demos/{slug}.json` as part of archetype generation |
| MODIFY | `scripts/synthesise.mjs` | Call new synthesiser m1-contract output per archetype |
| CREATE | `data/demos/*.json` (×4) | Baked normalised demo datasets (generated by synthesiser; committed) |
| MODIFY | `CLAUDE.md` | Update status block |

---

## Implementation steps

### Group A — DST detection + timezone overhaul (`data-ingestion.js`)

#### Step 1 — Add CONFIG constant

In `data-ingestion.js` CONFIG, add:
```js
MIN_DAYS_WITH_DATA: 90,   // non-blank days required; replaces the MIN_DAYS_FOR_ANALYSIS gate
```
Keep `MIN_DAYS_FOR_ANALYSIS`, `WARNING_DAYS_THRESHOLD`, `GAP_WARNING_PERCENTAGE` until
their removal steps in Group B. Do **not** remove `DEFAULT_GAS_RATE_P_KWH` etc. —
deferred to m2.

#### Step 2 — `lastSundayOf(year, month)` helper

Private function in `data-ingestion.js`. Returns `YYYY-MM-DD` of the last Sunday in the
given year/month (1-indexed). Locates autumn-back (October) and spring-forward (March)
DST transition dates.

```js
function lastSundayOf(year, month) {
  const last = new Date(Date.UTC(year, month, 0)); // day 0 = last day of (month - 1)
  const dow = last.getUTCDay();
  last.setUTCDate(last.getUTCDate() - dow);
  return last.toISOString().slice(0, 10);
}
```

#### Step 3 — `findTransitionDatesInRange(naiveDateSet)` helper

Takes a `Set<string>` of `YYYY-MM-DD` dates present in the data. Checks every year
spanning the data range for October and March last-Sunday dates. Returns
`{ autumnDate, springDate }` — each a date string if it falls within the data range,
`null` otherwise.

#### Step 4 — `detectAutumnBack(naiveTimestamps, autumnDate)` helper

Checks whether `01:00` and `01:30` appear more than once on the given autumn-back date
in the array of naive timestamp strings. Returns `true` / `false` / `null` (not in range).

#### Step 5 — `detectSpringForward(naiveTimestamps, springDate)` helper

Checks whether `01:00` and `01:30` are absent on the spring date, given that `00:30` and
`02:00` are both present on that date (confirms real DST gap, not a meter outage).
Returns `true` / `false` / `null`.

#### Step 6 — `detectCsvTimezone(naiveTimestamps)` function

Orchestrates Steps 3–5. Implements the 9-case classification table from design doc §2.5.7
Step 3 as a decision tree. Returns:

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

Warning strings per design doc §2.5.7 Step 5.

#### Step 7 — Revise `parseCSV()` — two-pass structure

**Pass 1:** iterate all data rows:
- Explicit timezone (regex `/Z$|[+-]\d{2}:?\d{2}$/i`): parse immediately to UTC ISO;
  store in `explicitRows`.
- Naive: store raw timestamp string + row index + values in `naiveRows`.

After Pass 1:
- If `naiveRows.length > 0`: call `detectCsvTimezone(naiveRows.map(r => r.ts))`.
- If all explicit: `timezone_detection = { source: 'csv_utc_assumed', detection_signals:
  { ..., confidence: 'high' }, warnings: [] }`.

**Pass 2:** resolve naive rows using `timezone_detection`:
- `source === 'csv_local_detected'`: call `londonToUtc(ts)` for each. Spring-gap error →
  skip with warning. Autumn-back → Step 8.
- UTC or assumed UTC: treat naive timestamp as UTC (`ts + 'Z'`).

Merge explicit + converted-naive rows; sort by `interval_start`.

#### Step 8 — Autumn-back disambiguation in Pass 2

When `source === 'csv_local_detected'`, on the autumn-back date:
- First `01:00` naive → UTC `00:00` (BST); second `01:00` naive → UTC `01:00` (GMT).
- Implement using direct UTC offset arithmetic, tracking first/second occurrence explicitly —
  not relying on `londonToUtc()` return value alone.

For UTC-assumed paths: naive duplicate not on a known autumn-back date → warn and skip
second row.

---

### Group B — `days_with_data` gate

#### Step 9 — Replace `parseCSV()` sufficiency check

Replace the `rangeDays < CONFIG.MIN_DAYS_FOR_ANALYSIS` block at `data-ingestion.js:433`
with:

```js
const daysPresent = new Set(records.map(r => r.interval_start.slice(0, 10))).size;
if (daysPresent < CONFIG.MIN_DAYS_WITH_DATA) {
  errors.push(
    `Only ${daysPresent} days of data found. ` +
    `At least ${CONFIG.MIN_DAYS_WITH_DATA} days with readings are needed for a reliable analysis.`
  );
}
```

Return `{ records, errors, timezone_detection, days_with_data: daysPresent }`.

#### Step 10 — Add `days_with_data` to `normaliseConsumption()`

In the HH iteration loop at `data-ingestion.js:697`, accumulate a `Set` of date strings
for slots with ≥1 non-null reading; add `days_with_data: daysWithDataSet.size` to the
returned `metadata`.

#### Step 11 — Remove all scattered sufficiency checks

Remove all seven blocks listed in the research table:

1. **Two `MIN_DAYS_FOR_ANALYSIS` hard blocks** — `app.js:643` (Octopus path) and
   `app.js:3039` (CSV path). Each is a `meta.total_days < CONFIG.MIN_DAYS_FOR_ANALYSIS`
   guard that errors and returns; delete both.
2. **Four warning blocks** — `WARNING_DAYS_THRESHOLD` and `GAP_WARNING_PERCENTAGE` checks
   at approximately app.js:653, :660, :3049, :3056.

Then remove CONFIG constants from `data-ingestion.js`:
- `WARNING_DAYS_THRESHOLD` and `GAP_WARNING_PERCENTAGE` — grep all `js/` files first to
  confirm no other consumers.
- `MIN_DAYS_FOR_ANALYSIS` — grep `js/` and `scripts/` to confirm all three consumers
  (parseCSV:433 replaced in Step 9, app.js:643 removed above, app.js:3039 removed above)
  are gone before deleting.

#### Step 12 — Octopus path: `timezone_detection` stub + `days_with_data` block

In `app.js`, after `normaliseConsumption()`, add the `timezone_detection` stub:

```js
const timezone_detection = {
  source: 'octopus',
  detection_signals: { autumn_back_observed: null, spring_forward_observed: null, confidence: 'high' },
  warnings: [],
};
```

Then block the pipeline when data is insufficient — using the same error display pattern
as the CSV path:

```js
if (normResult.metadata.days_with_data < CONFIG.MIN_DAYS_WITH_DATA) {
  // display error + return; do not continue pipeline
}
```

The Octopus pipeline must **not** continue past this gate. Use the existing error display
mechanism (same as CSV path errors) — no new HTML element required. Design decision
confirmed: both paths block identically.

---

### Group C — Region

#### Step 13 — No change needed

CSV `gsp-region` dropdown is already correct — plain user-selected list with blank first
option, no default, no postcode interaction. Verify only; no code changes.

---

### Group D — CSV rate field removal

#### Step 14 — Remove CSV rate field reads from `app.js`

Before touching the HTML, audit all reads of `csv-gas-rate`, `csv-elec-rate`,
`csv-gas-standing`, `csv-elec-standing` in `app.js`. Remove each read and any downstream
usage that would break when the elements are absent (values passed to m2 via the M1
result envelope, or used in `prefillRateInputs()`). In v2, m2 owns these rates.

**Interim fallback (review clarification):** until m2 ships, CSV pricing must fall back to the
CONFIG Ofgem-cap defaults (`DEFAULT_GAS_RATE_P_KWH` etc., retained per Step 1) — removing the
field reads degrades to defaults, **not** an empty/broken rate.

#### Step 15 — Remove CSV rate form fields from `index.html`

After Step 14, remove the two `.form-row` blocks containing the four rate inputs.

✅ **Confirmed at review (2026-06-03)** — proceed. The design has m1 collecting no rates; m2 owns them.

---

### Group E — Demo-archetype source path

#### Step 16a — Add `gsp_region` to each archetype config

Add a `"gsp_region": "<letter>"` field to each `demo-configs/*.json`. GSP letters are
chosen values appropriate to the archetype's postcode for the synthetic data — there is
no postcode→GSP lookup.

| Archetype | Postcode | Expected region |
|-----------|----------|-----------------|
| `modern-out-for-work` | CB1 2BX (Cambridge) | A — Eastern England |
| `average-in-all-day` | TBD — read config | TBD |
| `small-and-efficient` | TBD — read config | TBD |
| `big-old-draughty` | TBD — read config | TBD |

Read each config to confirm postcodes and assign correct GSP letters before writing.

#### Step 16b — Extend synthesiser to emit m1-contract JSON

Extend `scripts/lib/synthesiser.mjs` to emit a normalised m1-contract JSON to
`data/demos/{slug}.json` as part of each archetype's output. The synthesiser generates
UTC-aligned HH consumption data — no parseCSV invocation is needed.

The JSON output must match the shape expected by `loadDemoArchetype()` (Step 17):

```json
{
  "slug": "...",
  "postcode": "...",
  "region": "<gsp_region from config>",
  "days_with_data": <count of unique dates with non-null readings>,
  "consumption": [ /* HH records in normaliseConsumption() output format */ ],
  "metadata": { /* same fields as normaliseConsumption() metadata */ }
}
```

Before implementing: cross-check the `consumption[]` array field names and types against
the actual output of `normaliseConsumption()` from a live path to confirm the shapes match
exactly.

Also extend `scripts/synthesise.mjs` to log confirmation that `data/demos/*.json` files
are written per archetype run.

#### Step 16c — Re-run synthesiser and commit demo JSON outputs

Re-run `node scripts/synthesise.mjs` for all 4 archetypes. The PRNG-seeded synthesiser
is deterministic — re-running produces identical synthetic data and now also writes
`data/demos/*.json`.

Confirm all 4 `data/demos/*.json` files are generated without errors. Commit them to
the repo (already gitignore-exempt).

#### Step 17 — `loadDemoArchetype(archetypeId)` + archetype ID list (`data-ingestion.js`)

Export a canonical archetype list:
```js
export const DEMO_ARCHETYPES = [
  { id: 'modern-out-for-work',  label: 'Modern home, out for work' },
  { id: 'average-in-all-day',   label: 'Average home, in all day' },
  { id: 'small-and-efficient',  label: 'Small and efficient home' },
  { id: 'big-old-draughty',     label: 'Big old draughty house' },
];
```

Export a load function:
```js
export async function loadDemoArchetype(archetypeId) {
  const resp = await fetch(`data/demos/${archetypeId}.json`);
  if (!resp.ok) throw new Error(`Demo dataset not found: ${archetypeId}`);
  const data = await resp.json();
  return {
    consumption: data.consumption,
    postcode: data.postcode,
    gsp_region: data.region,
    days_with_data: data.days_with_data,
    metadata: data.metadata,
    tariff_rates: null,
    timezone_detection: {
      source: 'demo',
      detection_signals: { autumn_back_observed: null, spring_forward_observed: null, confidence: 'high' },
      warnings: [],
    },
  };
}
```

Note: the design doc uses `region` as the JSON field name; `loadDemoArchetype()` maps
`data.region → gsp_region` in its return object. This mapping is correct and intentional —
do not change it.

#### Step 18 — Demo pipeline wire-up in `app.js` + minimal test trigger

In `app.js`: add a `runDemoPipeline(archetypeId)` function that calls
`loadDemoArchetype(archetypeId)` → passes result to `setIngestionResult()` → proceeds to
analysis (same path as Octopus/CSV after `setIngestionResult()`).

In `index.html`: add a minimal bare test trigger — a hidden `<div id="demo-triggers">` with
one button per archetype (e.g. `<button class="demo-btn" data-id="modern-out-for-work">`).
Wire buttons to `runDemoPipeline()` in app.js. These are **not the visual "Demo Profiles"
tab** — that ships with the UI plan. This is a functional scaffold for CLI/browser
verification only; the UI plan will replace it with the designed tab.

---

### Group F — M1 result envelope + final wiring

#### Step 19 — Verify Octopus region in M1 result envelope

Confirm `gsp_region` from `prop.gsp_region` flows through `setIngestionResult()`. No code
change expected; flag any deviation in the deviations section.

#### Step 20 — Wire `timezone_detection` and `days_with_data` into all path envelopes

- **CSV path:** include `timezone_detection` + `days_with_data` (returned from `parseCSV()`)
  in the `setIngestionResult()` call.
- **Octopus path:** include `timezone_detection` stub from Step 12 + `days_with_data` from
  `normaliseConsumption()` metadata.
- **Demo path:** `loadDemoArchetype()` returns both directly — pass through to
  `setIngestionResult()`.

`timezone_detection` is display-only on the input card; no downstream module consumes it.

#### Step 21 — Update CLAUDE.md status block

Add entry for `m1-data-ingestion-v2` to the Current Sequencing Position checklist.

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Two-pass `parseCSV()` restructure introduces regression on explicit-timezone rows | Explicit-tz path logic unchanged (same regex, same `new Date()` parse). Pass 1 only separates them into a different array. |
| Autumn-back disambiguation — row-order dependency is subtle | Implement via direct UTC offset arithmetic on the transition date, tracking first/second occurrence explicitly. |
| Spring-forward false-positive when a meter gap coincides with 01:00–01:30 | Step 5 requires `00:30` and `02:00` present before confirming the gap. Real meter gaps typically extend beyond 01:00–01:30. |
| `WARNING_DAYS_THRESHOLD` / `GAP_WARNING_PERCENTAGE` may have undiscovered consumers | Grep all `js/` files for both constant names before removing from CONFIG. |
| `MIN_DAYS_FOR_ANALYSIS` may have consumers beyond the three known uses | Grep `js/` and `scripts/` before removing from CONFIG (Step 11). |
| CSV rate field removal breaks downstream code that still reads those element IDs | Step 14 audits and removes all reads before Step 15 removes the HTML. Rate CONFIG defaults remain until m2. |
| Synthesiser `consumption[]` JSON shape may not match `normaliseConsumption()` output exactly | Cross-check field names and types against a live `normaliseConsumption()` call before writing the synthesiser extension (Step 16b). |
| Demo JSON `region` field must match what `setIngestionResult()` expects (`gsp_region`) | `loadDemoArchetype()` maps `data.region → gsp_region` explicitly (Step 17). |
| Labels for `average-in-all-day`, `small-and-efficient`, `big-old-draughty` in `DEMO_ARCHETYPES` — confirm exact wording from config `label` fields | Read each `demo-configs/*.json` for canonical label text before hardcoding in Step 17. |

---

## Success criteria

- [ ] `parseCSV()` with `Z`-suffixed timestamps: `timezone_detection.source = 'csv_utc_assumed'`; no warning; timestamps unchanged.
- [ ] CSV with naive timestamps spanning 2025-10-26 + 2026-03-29 (both transitions): `source = 'csv_local_detected'`; `confidence = 'high'`; converted to UTC.
- [ ] CSV, autumn-only naive: `confidence = 'medium'`; `spring_forward_observed = null`; converted; medium-confidence warning shown.
- [ ] CSV, summer-only naive: `source = 'csv_uncertain_assumed_utc'`; `confidence = 'low'`; verbose warning shown.
- [ ] Contradictory signals: `source = 'csv_uncertain_assumed_utc'`; `confidence = 'low'`; pipeline not blocked.
- [ ] Autumn-back row-order: first `01:00` → UTC `00:00`; second `01:00` → UTC `01:00`.
- [ ] CSV with `days_with_data < 90` non-blank days: blocked with 90-day message; no calendar-span check fires.
- [ ] `days_with_data ≥ 90`: proceeds; old `<90` warning and gap-percentage warning absent.
- [ ] Octopus path: `timezone_detection.source = 'octopus'`; `days_with_data` on metadata; pipeline **blocked** (not warned) if `< 90`.
- [ ] CSV `gsp-region` dropdown unchanged — blank first option, no pre-selection.
- [ ] CSV rate form fields absent from UI (once confirmed at plan review).
- [ ] `DEMO_ARCHETYPES` exported constant lists all 4 archetype IDs.
- [ ] `loadDemoArchetype('modern-out-for-work')` returns correct consumption[], postcode, gsp_region, days_with_data, timezone_detection.
- [ ] `data/demos/*.json` files produced by synthesiser match the shape expected by `loadDemoArchetype()` (field names and types verified).
- [ ] Demo minimal test trigger: clicking a demo button loads the archetype, calls setIngestionResult(), and proceeds to analysis.
- [ ] All existing module test suites (M3, M5, M5b, M6, M7, M8, M9) still green.

---

## Implementation Deviations

**D1 — `runDemoPipeline` omits `showSuccessSummary`**
Plan says to proceed "same path as Octopus/CSV after `setIngestionResult()`", which technically includes `showSuccessSummary`. Omitted intentionally: plan also says "functional scaffold for CLI/browser verification only; UI plan will replace it with the designed tab." No analysis output is affected.

**D2 — `findTransitionDatesInRange` called twice in `parseCSV`**
Called once inside `detectCsvTimezone()` and a second time directly in `parseCSV()` to obtain `autumnDate` for Pass 2 disambiguation. Minor double-work; no functional impact.

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-06-03
**Review type:** Plan review (pre-implementation) — re-cut after the first cut was blocked.
**Authoritative design:** `praxis-claude-hub/projects/tools/heatpump-analyser/design/m1-data-ingestion-v2.md`

### Context

Re-cut m1 plan reviewed against the realigned m1-v2 design. Codebase claims verified by read-only
Grep against `heatpump-analyser/js/` + `index.html` (parseCSV:433, normaliseConsumption:697, the
seven sufficiency checks incl. `app.js:643`/`:3039`, the `gsp-region` blank-first dropdown, the CSV
rate fields, the CONFIG constants — all confirmed). The first cut was **Blocked** on three findings;
this re-cut resolves all three.

### Required changes for implementation

1. **Missing 30-day removals** — the first cut omitted `app.js:643` + `:3039`.
2. **Demo bake mechanism** — the first cut ran the browser `parseCSV` in Node (unresolved).
3. **API `<90` block vs warn** — the first cut continued; architecture says block both paths.

### Resolution of review changes

1. **Missing removals** — RESOLVED: the research table now lists all **seven** checks (incl.
   `:643`/`:3039`); Step 11 removes them + the `MIN_DAYS_FOR_ANALYSIS` constant (grep-first).
2. **Demo bake** — RESOLVED: Step 16b extends the **synthesiser to emit the m1-contract JSON
   directly** (no `parseCSV` in Node); runtime served-fetch (relative path) retained; shape
   cross-check flagged.
3. **API `<90`** — RESOLVED: Step 12 **blocks** the Octopus path (both paths block identically);
   success criterion updated.

### Items noted / clarifications

- **Hygiene (applied):** cleared the stale "⚠ confirm CSV rate removal" flag — the design has
  resolved it (m1 collects no rates; rates are m2's Ofgem-cap defaults).
- **MEDIUM (clarified inline, Step 14):** interim CSV pricing falls back to the CONFIG Ofgem-cap
  defaults until m2 ships — removing the rate-field reads degrades to defaults, not a broken rate.
- **LOW:** design `region` = code `gsp_region` (the plan maps correctly).

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0 | ✓ pass |
| HIGH | 3 | ✅ resolved (re-cut) |
| MEDIUM | 1 | ℹ clarified inline |
| LOW | 2 | — noted |

Verdict: ⚠ APPROVED WITH EDITS — re-cut resolves the three blocking findings; hygiene + two clarifications applied.

---

## Approval

**Status:** ⚠ Approved with edits — 2026-06-03
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:**
- API `<90` days **blocks** both paths (CSV + Octopus) — not warn-and-continue.
- Demo data: the synthesiser emits the normalised m1-contract JSON to `data/demos/`; runtime
  served-fetch (relative path); **no `parseCSV` in Node**.
- CSV rate fields removed from m1 (m1 collects no rates); **interim CSV pricing uses the CONFIG
  Ofgem-cap defaults until m2** lands.
- `region` = the CSV dropdown value, no postcode interaction; code field is `gsp_region`.
