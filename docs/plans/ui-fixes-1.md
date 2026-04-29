# ui-fixes-1 — Post-launch corrections (batch 1)

**Date:** 2026-04-29
**Status:** Awaiting approval — review via claude.ai before implementation begins.
**Design doc:** `design/ui-fixes-1.md`

---

## Task description

Six targeted corrections raised by user testing immediately after M10a launched. All
fixes are localised to existing files (`index.html`, `css/styles.css`, `js/app.js`,
`js/financial.js`). No new modules, no data-pipeline changes, no new external
dependencies.

---

## Research findings

**Fix 1 — SVT sub-note:** The two strings requiring replacement are in
`buildAndDisplayVerdict` at app.js:1866-1872, inside the
`verdictType === 'positive' && primaryKey === 'smart_hp_hh'` branch.

**Fix 2 — Progress bar:** `showProgress(text, percent)` is defined at app.js:296. It
sets `progressBar.style.width = \`${percent}%\`` only when `percent` is non-undefined.
`runExternalData` (app.js:763) accepts `showProgressFn` as a parameter. All callers wrap
it as `(text) => showProgress(text, undefined)`, so the `percent` argument is always
dropped. Line 787 passes `pct` to `showProgressFn` as text only, never as the second
arg. Fix: call `showProgress` directly (same file, module-level scope) for this one
callback rather than through the wrapper.

**Fix 3 — Methodology DL layout:** `heat-loss-summary` (index.html:199),
`thermal-char-summary` (index.html:238), `hp-model-summary` (index.html:273) are bare
`<dl>` elements with no ancestor `.results-summary`. The existing
`.results-summary dl { display: grid }` rule never applies to them. Need a standalone
`.summary-dl` class with the same grid rule.

**Fix 4 — BUS note:** `financial.js:44-46` already distinguishes full HP from hybrid
via `netInvestmentFor` using scenario name matching. No code change to grant
calculations is needed — design doc confirms this. The fix is adding an informational
`<p>` below the financial table in `displayPricingResults` (app.js).

**Fix 5 — Savings format:** `fmtGbpSaving` at app.js:1734 returns `` `+£${abs}` `` for
positive values. One-character change.

**Fix 6 — Verdict status line:** `verdict-card` in index.html:139-145 currently has
`verdict-headline → verdict-chart-wrap → verdict-cooling → verdict-quality`. The new
`verdict-status` div inserts between `verdict-headline` and `verdict-chart-wrap`. M5b
inputs in the thermal char card are `#t-at-restart` (number, index.html:216) and
`#tau-bucket` (select, index.html:226). The fix handler should target `#t-at-restart`
(the temperature-on-return input that enables the cold-soak path) — it is a number
input and can receive `.focus()`. Note: `#tau-bucket` is a `<select>` and is also a
valid alternate target if `#t-at-restart` is deemed less actionable; confirm at
implementation time which better matches the "provide more information" intent.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/app.js` | Fixes 1, 2, 4, 5, 6 (string changes, progress wiring, BUS note, savings format, verdict status logic) |
| MODIFY | `index.html` | Fixes 3, 6 (DL classes, verdict-status div) |
| MODIFY | `css/styles.css` | Fixes 3, 6 (summary-dl rule, verdict-status rules) |
| MODIFY | `js/financial.js` | No change needed (confirmed) |

---

## Implementation steps

### Step 1 — Fix 5: Drop '+' from savings format (app.js:1734)

Change:
```js
if (v > 0) return `+£${abs}`;
```
To:
```js
if (v > 0) return `£${abs}`;
```

### Step 2 — Fix 1: SVT sub-note rewording (app.js:1866-1872)

Inside `buildAndDisplayVerdict`, in the `smart_hp_hh` positive branch, replace:

When `svtSaving <= 0` (app.js:1866-1867):
```
On a standard flat-rate tariff, a heat pump would cost slightly more to
run than your current boiler. The economics depend heavily on switching to a half-hourly tariff.
```
With:
```
On a standard flat-rate tariff, however, the picture is different — a heat pump
would cost slightly more than your current boiler at current rates. The savings
above depend on switching to a half-hourly tariff.
```

When `svtSaving > 0` (app.js:1870-1871), replace the second sentence only:
```
The difference comes down largely to tariff choice and how well your home holds heat.
```
With:
```
The additional saving from a half-hourly tariff comes from shifting heating to cheaper overnight periods.
```

### Step 3 — Fix 2: Progress bar wiring (app.js:787)

Change:
```js
(pct) => showProgressFn(`Fetching price data… ${pct}%`)),
```
To:
```js
(pct) => showProgress(`Fetching price data… ${pct}%`, pct)),
```

Note: `showProgress` is module-level in the same file. The `await new Promise(r => setTimeout(r, 0))` between Elexon chunks already exists and provides repaint opportunity — no other changes needed.

### Step 4 — Fix 3: Methodology DL grid layout

**index.html** — add `class="summary-dl"` to all three DL elements:
```html
<dl id="heat-loss-summary" class="summary-dl"></dl>   <!-- line 199 -->
<dl id="thermal-char-summary" class="summary-dl"></dl> <!-- line 238 -->
<dl id="hp-model-summary" class="summary-dl"></dl>     <!-- line 273 -->
```

**css/styles.css** — append new rule block:
```css
/* ===== Summary DL (methodology cards) ===== */
.summary-dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1rem;
  font-size: 0.9rem;
  margin-top: 0.5rem;
}
.summary-dl dt { font-weight: 600; color: var(--colour-navy); }
.summary-dl dd { color: var(--colour-dark); }
```

### Step 5 — Fix 4: BUS eligibility note (app.js, `displayPricingResults`)

After the `breakEvenHtml` block and before the closing of the innerHTML template in
`displayPricingResults`, append:
```html
<p class="card-intro" style="margin-top:0.75rem;">
  Note: the Boiler Upgrade Scheme grant (£7,500) applies to standalone heat pump
  installations only.
</p>
```

### Step 6 — Fix 6: Verdict status line

**Step 6a — index.html:** Insert new div between `verdict-headline` and
`verdict-chart-wrap` (after line 140):
```html
<div class="verdict-status hidden" id="verdict-status"></div>
```

**Step 6b — css/styles.css:** Append:
```css
/* ===== Verdict status line ===== */
.verdict-status {
  margin: 0.75rem 0 0.25rem;
  padding: 0.65rem 0.9rem;
  background: #FFF8E1;
  color: #8B5A00;
  border-left: 3px solid #F57F17;
  border-radius: 0 var(--radius) var(--radius) 0;
  font-size: 0.9rem;
  line-height: 1.5;
}
.verdict-status .fix-link {
  color: var(--colour-teal);
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  font-size: inherit;
  font-family: inherit;
  margin-left: 0.25rem;
}
.verdict-status .fix-link:hover { color: #2A6566; }
.highlight-flash {
  outline: 2px solid var(--colour-coral);
  outline-offset: 2px;
  transition: outline 0.3s ease;
}
```

**Step 6c — app.js:** Add DOM reference near the other verdict refs (around line 223):
```js
const verdictStatus = document.getElementById('verdict-status');
```

**Step 6d — app.js:** Add `buildVerdictStatusMessage(financialResult)` helper function.
Implement Conditions A and B as specified in the design doc. Fix handler for Condition A:
- Open `#methodology-disclosure` by setting `disclosure.open = true`
- `scrollIntoView` on `#thermal-char-card`
- After 400ms delay: focus `#t-at-restart`, add `.highlight-flash`, remove after 1500ms

**Step 6e — app.js:** In `buildAndDisplayVerdict`, after the `verdictQuality.textContent`
assignment (app.js:1937) and before Step 16f (cooling note, which is removed in
ui-fixes-2), add the status line logic:
```js
const statusMsg = buildVerdictStatusMessage(financialResult);
if (statusMsg) {
  verdictStatus.innerHTML = statusMsg.html;
  verdictStatus.classList.remove('hidden');
  if (statusMsg.fixHandler) {
    const link = verdictStatus.querySelector('.fix-link');
    if (link) link.addEventListener('click', statusMsg.fixHandler);
  }
} else {
  verdictStatus.classList.add('hidden');
  verdictStatus.innerHTML = '';
}
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Fix 2: `showProgress` called directly — if `runExternalData` is ever called from a context without `showProgress` in scope, this breaks | `runExternalData` is defined in app.js and `showProgress` is module-level in the same file; there is no other caller context |
| Fix 6: Fix handler targets `#t-at-restart` but the thermal mass failure may not be caused by missing temp input | Condition A trigger is specific (smart scenarios absent, dumb HH present); the handler opens the disclosure and highlights the most actionable input; user retains full control |
| Fix 6: `buildVerdictStatusMessage` receives `financialResult` which may have different scenario keys after m8-patch removes hybrid scenarios | The conditions only reference `smart_hp_hh`, `hybrid_smart`, `dumb_hp_hh`, `dumb_hp_svt` — `hybrid_smart` appears in Condition A trigger. After m8-patch removes hybrids, Condition A trigger should be updated: check `smart_hp_hh` and `dumb_hp_hh` absence instead of `hybrid_smart`. Flag this as a known forward dependency. |

---

## Success criteria

- [ ] Verdict SVT sub-note no longer reads as the overall conclusion when smart HP wins on HH but loses on flat rate (Fix 1)
- [ ] Progress bar fill animates as Elexon chunks complete — visual bar moves, not just text (Fix 2)
- [ ] Methodology DLs render in two columns (label left, value right) (Fix 3)
- [ ] BUS-eligibility note appears below the financial table; no change to grant calculation figures (Fix 4)
- [ ] Savings column shows "£X" without the '+' prefix; negative savings still show "−£X" (Fix 5)
- [ ] When smart scenarios are unavailable but HH dumb scenarios run: amber status line appears with "Provide that input ↓" link (Fix 6)
- [ ] Clicking the link opens methodology disclosure, scrolls to thermal char card, focuses `#t-at-restart`, applies 1.5s outline highlight (Fix 6)
- [ ] When all data is good: no status line appears (Fix 6)
- [ ] No console errors after any of the above interactions

---

## Claude.ai Review — yyyy-mm-dd

**Reviewer:** Claude (Praxis Insight — Opus architect window)

**Overall verdict:** [Approved / Approved with clarifications / Revise and resubmit]

### What is solid

### Clarifications required before implementation

### Minor observations (not blockers)

---

## Approval

**Status:** [pending]
**Approved by:**
**Clarifications confirmed:**

---

## Implementation Deviations

[To be completed post-implementation]
