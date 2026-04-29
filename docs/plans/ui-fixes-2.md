# ui-fixes-2 — Post-launch corrections (batch 2)

**Date:** 2026-04-29
**Status:** ✅ Approved — 2026-04-29
**Design doc:** `design/ui-fixes-2.md`

---

## Task description

Four targeted corrections from user testing. All localised to existing files
(`index.html`, `js/app.js`, `js/data-ingestion.js`, `css/styles.css`). No new modules,
no data-pipeline changes. Implements after ui-fixes-1 (shares files; avoids conflicts);
must be implemented before M10b (M10b assumes the cooling note is already removed).

---

## Research findings

**Fix 1 — Field order:** In `index.html`, `#tab-octopus` panel (line 33): the API Key
`<div class="form-group">` (lines 34-41) appears before Account Number (lines 42-45).
Fields bind by id not position — swap is safe, no JS changes needed.

**Fix 2 — Gas unit Tier 1:** `fetchConsumptionStitched` in data-ingestion.js:586. The
Tier 1 early return at lines 618-623 currently returns `{ records, serialsUsed,
metersStitched: false, gasUnitSource: null }` with no `detectedUnit` field. `inferGasUnit`
is defined at line 566 and already used in Tier 2 at line 637. The pattern for Tier 1
mirrors Tier 2 exactly: call `inferGasUnit(sorted)` for gas, return `detectedUnit: unit`.
In `app.js`, the `continueWithProperty` function at ~line 437 processes the gas stitched
result; Tier 2 sets `gasM3Toggle.disabled = true` when pre-converting; Tier 1 must NOT
disable the toggle — it pre-sets only. The `gasM3Toggle` DOM reference already exists.

**Fix 3 — Status collapse:** `addStatus` at app.js:313 and `clearStatus` at app.js:316
manage `statusArea` (DOM ref at line 130). `addCsvStatus`/`clearCsvStatus` manage
`csvStatusArea` (DOM ref at line 155). The `<details>`/`<summary>` pattern is native
HTML with full browser support — no libraries required. The `.hidden` class
(`display: none`) already exists in styles.css and applies to `<details>` elements.

**Fix 4 — Cooling note removal:** `verdictCooling` DOM ref at app.js:224. Step 16f
block at app.js:1939-1946. The element in index.html is at line 144:
`<p class="verdict-cooling hidden" id="verdict-cooling"></p>`.
The marginal verdict copy at app.js:1905-1906 includes "the cooling capability a heat
pump adds" — this sentence must be updated per the design doc. Search styles.css for
`.verdict-cooling` rule — remove if found.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | Fixes 1, 2, 3, 4 (field swap, gas-check text, status wrapping, cooling removal) |
| MODIFY | `js/app.js` | Fixes 2, 3, 4 (toggle pre-set, status functions, cooling removal) |
| MODIFY | `js/data-ingestion.js` | Fix 2 (Tier 1 unit detection) |
| MODIFY | `css/styles.css` | Fix 3, 4 (status-details rules; remove verdict-cooling rule if present) |

---

## Implementation steps

### Step 1 — Fix 4: Remove cooling note (do first — reduces verdict-card surface area for M10b)

**index.html line 144:** Delete the element entirely:
```html
<!-- remove: <p class="verdict-cooling hidden" id="verdict-cooling"></p> -->
```

**app.js line 224:** Delete DOM reference:
```js
// remove: const verdictCooling = document.getElementById('verdict-cooling');
```

**app.js lines 1939-1946:** Delete entire Step 16f block:
```js
// remove:
// Step 16f — cooling note
// const avoidedAc = ...
// if (avoidedAc === 0) { ... } else { ... }
```

**app.js marginal verdict (line 1905-1906):** Replace:
```
"...the reliability of your existing boiler, the cooling capability a heat pump
adds, and future energy prices..."
```
With:
```
"...the reliability of your existing boiler and future energy prices..."
```

**css/styles.css:** Search for `.verdict-cooling` — delete the rule block if found.

### Step 2 — Fix 1: Account number before API key

**index.html:** Inside `#tab-octopus`, swap the two `<div class="form-group">` blocks
so Account Number (lines 42-45) appears before API Key (lines 34-41). No other changes.

### Step 3 — Fix 2: Gas unit Tier 1 detection

**data-ingestion.js — Tier 1 early return (lines 618-623):** Replace:
```js
return {
  records: sorted,
  serialsUsed: [newestMeter.serial_number],
  metersStitched: false,
  gasUnitSource: null,
};
```
With:
```js
if (fuelType === 'gas') {
  const { unit } = inferGasUnit(sorted);
  console.info(`Tier 1 meter (gas): unit=${unit}`);
  return {
    records: sorted,
    serialsUsed: [newestMeter.serial_number],
    metersStitched: false,
    gasUnitSource: null,
    detectedUnit: unit,
  };
}
return {
  records: sorted,
  serialsUsed: [newestMeter.serial_number],
  metersStitched: false,
  gasUnitSource: null,
  detectedUnit: null,
};
```

Note: records are NOT pre-converted in Tier 1. `gasUnitSource` remains null. The
`detectedUnit` field is for UI pre-set only — conversion happens via toggle +
`waitForGasConfirmation` as before.

**app.js — `continueWithProperty`:** After the block that processes `gasResult.gasUnitSource`,
add:
```js
if (gasResult.detectedUnit === 'm3') {
  gasM3Toggle.checked = true;
} else if (gasResult.detectedUnit === 'kwh') {
  gasM3Toggle.checked = false;
}
// detectedUnit null → leave toggle at default (false/kWh)
// Toggle remains enabled — user can override
```

Do NOT add `gasM3Toggle.disabled = true` — Tier 1 does not pre-convert.

**index.html — `#gas-check-area` instructional text:** Replace the existing
"If these values look wrong" paragraph with:
```html
<p>We've estimated your meter unit from your data. Check the values above look
   reasonable and adjust the toggle below if needed.</p>
```

### Step 4 — Fix 3: Status notices collapse

**index.html — Octopus tab:** Replace:
```html
<div class="status-area" id="status-area"></div>
```
With:
```html
<details class="status-details hidden" id="status-details">
  <summary class="status-summary" id="status-summary">0 notices</summary>
  <div class="status-area" id="status-area"></div>
</details>
```

**index.html — CSV tab:** Replace:
```html
<div class="status-area" id="csv-status-area"></div>
```
With:
```html
<details class="status-details hidden" id="csv-status-details">
  <summary class="status-summary" id="csv-status-summary">0 notices</summary>
  <div class="status-area" id="csv-status-area"></div>
</details>
```

**app.js — new DOM references** (add near existing statusArea ref at line 130):
```js
const statusDetails    = document.getElementById('status-details');
const statusSummary    = document.getElementById('status-summary');
const csvStatusDetails = document.getElementById('csv-status-details');
const csvStatusSummary = document.getElementById('csv-status-summary');
```

**app.js — update `addStatus`** (currently at line 313):
```js
function addStatus(message, type) {
  const div = document.createElement('div');
  div.className = `status-msg ${type}`;
  div.textContent = message;
  statusArea.appendChild(div);
  const count = statusArea.children.length;
  statusSummary.textContent = `${count} notice${count === 1 ? '' : 's'}`;
  statusDetails.classList.remove('hidden');
}
```

**app.js — update `clearStatus`** (currently at line 316):
```js
function clearStatus() {
  statusArea.innerHTML = '';
  statusSummary.textContent = '0 notices';
  statusDetails.classList.add('hidden');
  statusDetails.removeAttribute('open');
}
```

**app.js — apply equivalent changes to `addCsvStatus` and `clearCsvStatus`** using
`csvStatusDetails` and `csvStatusSummary`.

**css/styles.css — append:**
```css
/* ===== Status notices collapse ===== */
.status-details { margin-top: 0.75rem; }
.status-summary {
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--colour-navy);
  list-style: none;
  padding: 0.4rem 0;
}
.status-summary::-webkit-details-marker { display: none; }
.status-summary::before { content: '▶ '; font-size: 0.75rem; }
details[open] .status-summary::before { content: '▼ '; }
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Fix 2: `inferGasUnit` needs summer data to be reliable; Tier 1 with no summer records returns `unit: 'kwh'` | `inferGasUnit` at data-ingestion.js:571 already returns `{ unit: 'kwh', ... }` when `summerRecs < 48` — toggle defaults to unchecked (kWh), same as current behaviour; no regression |
| Fix 3: `<details>` wrapping `statusArea` changes DOM structure — JS code referencing `statusArea.parentElement` or CSS rules using adjacent/sibling selectors against `.status-area` may break | Grep `js/app.js` for `statusArea.parentElement` and `csvStatusArea.parentElement`; grep `css/styles.css` for `.status-area +` and `.status-area ~` adjacent/sibling selectors. Expect none in either; if found, audit individually before implementing. |
| Fix 4: Removing `verdictCooling` DOM ref — if any other function references it after removal, runtime error | `verdictCooling` referenced only at lines 224 (ref), 1942 (text), 1943 (classList.remove), 1945 (classList.add); all four must be removed together |
| Fix 4: ui-fixes-1 Fix 6 adds `buildVerdictStatusMessage` which is called after Step 16f — the cooling note removal (Step 16f) happens in this plan; if ui-fixes-2 is applied before ui-fixes-1, Step 16g chart construction references may shift | Implement ui-fixes-1 first, then ui-fixes-2 — confirmed order |

---

## Success criteria

- [ ] Octopus tab shows Account Number field above API Key field (Fix 1)
- [ ] After single-meter fetch, gas toggle is pre-checked to m³ if meter reported m³ values, or pre-unchecked for kWh; toggle remains interactive (Fix 2)
- [ ] Console shows `Tier 1 meter (gas): unit=m3` or `unit=kwh` log line (Fix 2)
- [ ] Status notices area is hidden on page load; shows "N notices" summary when notices added; expands on click (Fix 3)
- [ ] Clearing and re-running resets notices to closed and hidden (Fix 3)
- [ ] No cooling note text appears anywhere in the verdict block under any scenario (Fix 4)
- [ ] Break-even verdict copy does not mention cooling (Fix 4)
- [ ] No console errors after any combination of interactions

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-29
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `design/ui-fixes-2.md` (praxis-claude-hub commit `8476c58`)

### Context

Plan reviewed against `design/ui-fixes-2.md` (committed 2026-04-29 in
praxis-claude-hub, `8476c58`). All four fixes (Account-No-before-API-Key
order, Tier-1 gas-unit detection, status-notice collapse, cooling note
removal) are correctly mapped to the design. Dependencies are well-stated:
must follow ui-fixes-1 (shared verdict-card edits — ui-fixes-1 inserts
`buildVerdictStatusMessage` above Step 16f; ui-fixes-2 deletes Step 16f);
must precede m10b (m10b assumes cooling note removed); parallel-safe with
the agile + m8-patch streams. No CRITICAL, HIGH, or MEDIUM findings.

### Required changes for implementation

None — implementation steps are unchanged.

### Plan-internal cleanup applied at amend time

**1. Risk 2 strengthened (LOW).**

Original mitigation only flagged JS-level references to
`statusArea.parentElement`. Wrapping `#status-area` in `<details>` also
reparents it for CSS adjacent/sibling-selector purposes
(`.status-area + h2`, `.status-area ~ section`). Mitigation expanded to
include a grep of `css/styles.css` for these patterns before implementing.

**2. Section heading renamed (LOW).**

`## Claude.ai Review` → `## Design Review` per the heatpump CLAUDE.md
substitution table for the FX EA review template.

### Note for future plans (not applied)

Plan's Research findings and Implementation steps reference specific line
numbers (e.g. `data-ingestion.js:618-623`, `app.js:1939-1946`). The
heatpump architect brief explicitly says plans should reference function
names rather than line numbers because files drift between sessions.
Acceptable here because implementation is imminent and most line refs
are paired with surrounding function names so Sonnet can find the right
locations even if numbers shift. Worth discouraging in future plans.

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | — |
| HIGH     | 0     | — |
| MEDIUM   | 0     | — |
| LOW      | 3     | 1 + 2 ✅ resolved; 3 noted for future |

Verdict: ✅ APPROVED — implementation steps unchanged; Risk 2 strengthened to include CSS sibling-selector grep; section heading renamed.

---

## Approval

**Status:** ✅ Approved — 2026-04-29
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** None substantive — implementation matches design as written.

---

## Implementation Deviations

D1: Plan referred to functions `addStatus`/`clearStatus`/`addCsvStatus`/`clearCsvStatus` but actual function names in app.js are `showStatus`/`clearStatus`/`showCsvStatus`/`clearCsvStatus`. Changes applied to the correct existing function names.
