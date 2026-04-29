# ui-fixes-1 — Post-launch corrections (batch 1)

**Date:** 2026-04-29
**Status:** ⚠ Approved with edits — 2026-04-29
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
inputs in the thermal char card are `#tau-bucket` (select, index.html:226) and
`#t-at-restart` (number, index.html:216). Per Opus review: fix handler picks the
**first-empty input** as focus target — `#tau-bucket` first (it appears first in
DOM order; its empty value is the placeholder option `''`), then `#t-at-restart`,
falling back to `#tau-bucket` if both are filled. This routing matches M5's
Step 4c warning rules: continuous-overnight-heating households (the most common
Path A failure mode that prompted the M5 multi-path revision) need `tau_bucket`
to unlock Path B; multi-day-absence households need `t_at_restart_winter_c`.
Both `<select>` and `<input type="number">` accept `.focus()`.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `js/app.js` | Fixes 1, 2, 4, 5, 6 (string changes, progress wiring, BUS note, savings format, verdict status logic) |
| MODIFY | `index.html` | Fixes 3, 6 (DL classes, verdict-status div) |
| MODIFY | `css/styles.css` | Fixes 3, 6 (summary-dl rule, verdict-status rules) |

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

**Condition A trigger** — drops `hybrid_smart` from the design doc's trigger so the
code is forward-compatible with `m8-patch-gas-connection-retained` (sequence 3,
which removes hybrid scenarios). Optional chaining gives defensive null safety:

```js
const smart  = financialResult.scenarios.smart_hp_hh;
const dumbHh = financialResult.scenarios.dumb_hp_hh;
if (smart?.payback_status === 'no_data'
    && dumbHh != null
    && dumbHh.payback_status !== 'no_data') {
  // Smart-only failure — return Condition A message
}
```

**Condition B trigger** — drops `hybrid_dumb` and `hybrid_smart` from `hhKeys` for
the same forward-compat reason:

```js
const hhKeys = ['dumb_hp_hh', 'smart_hp_hh'];
const allHhMissing = hhKeys.every(k =>
  financialResult.scenarios[k]?.payback_status === 'no_data');
const svtAvailable = financialResult.scenarios.dumb_hp_svt?.payback_status !== 'no_data';
if (allHhMissing && svtAvailable) {
  // Price data failure — return Condition B message (no fix link)
}
```

**Fix handler for Condition A** — first-empty-input heuristic. Open the
disclosure, scroll the card into view, then after a 400 ms delay focus the
first empty M5b input (`#tau-bucket` preferred), apply `.highlight-flash`,
remove it after 1500 ms:

```js
fixHandler: () => {
  const disclosure = document.getElementById('methodology-disclosure');
  disclosure.open = true;
  const targetCard = document.getElementById('thermal-char-card');
  targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => {
    const tauBucket  = document.getElementById('tau-bucket');
    const tAtRestart = document.getElementById('t-at-restart');
    // tau-bucket first (DOM order; empty placeholder option has value '').
    // Falls through to t-at-restart, then back to tau-bucket if both are filled.
    let target = null;
    if (tauBucket && tauBucket.value === '') target = tauBucket;
    else if (tAtRestart && tAtRestart.value === '') target = tAtRestart;
    else target = tauBucket || tAtRestart;
    if (target) {
      target.focus();
      target.classList.add('highlight-flash');
      setTimeout(() => target.classList.remove('highlight-flash'), 1500);
    }
  }, 400);
}
```

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
| Fix 6: Fix handler may focus an already-filled input (smart scenarios still failed despite both M5b inputs provided) | First-empty heuristic falls back to `#tau-bucket` even if both inputs are filled; the disclosure-open + scroll + highlight still surfaces the card's warnings, so the user has visibility on why smart scenarios failed despite their input |

---

## Success criteria

- [ ] Verdict SVT sub-note no longer reads as the overall conclusion when smart HP wins on HH but loses on flat rate (Fix 1)
- [ ] Progress bar fill animates as Elexon chunks complete — visual bar moves, not just text (Fix 2)
- [ ] Methodology DLs render in two columns (label left, value right) (Fix 3)
- [ ] BUS-eligibility note appears below the financial table; no change to grant calculation figures (Fix 4)
- [ ] Savings column shows "£X" without the '+' prefix; negative savings still show "−£X" (Fix 5)
- [ ] When smart scenarios are unavailable but HH dumb scenarios run: amber status line appears with "Provide that input ↓" link (Fix 6)
- [ ] Clicking the link opens methodology disclosure, scrolls to thermal char card, focuses the first-empty M5b input (`#tau-bucket` preferred, then `#t-at-restart`), applies 1.5s outline highlight (Fix 6)
- [ ] When all data is good: no status line appears (Fix 6)
- [ ] No console errors after any of the above interactions

---

## Design Review

**Reviewer:** Claude (Praxis Insight — Opus architect window)
**Date:** 2026-04-29
**Review type:** Plan review (pre-implementation)
**Authoritative design:** `design/ui-fixes-1.md` (praxis-claude-hub commit `ec4a19d`)

### Context

Plan reviewed against the post-revision `design/ui-fixes-1.md` (committed
2026-04-29 in praxis-claude-hub, `ec4a19d`). The design revision had dropped
the original "fix BUS grant calc for hybrids" Fix 4 in favour of an
informational eligibility note — itself a downstream consequence of the
broader architectural decision to remove hybrid scenarios entirely (executed
in `m8-patch-gas-connection-retained`, sequence 3). The two HIGH findings
both concerned how Fix 6 interacted with that same hybrid-removal decision.

### Required changes for implementation

**1. Drop hybrid keys from Fix 6 Conditions A and B.**

Design doc Conditions A and B both reference `hybrid_smart` and `hybrid_dumb`.
Once `m8-patch` lands, those scenario keys cease to exist;
`financialResult.scenarios.hybrid_smart` becomes `undefined` and reading
`.payback_status` throws a TypeError, breaking the verdict-block render.
The plan flagged this as a known forward dependency in its risk table but
deferred the fix.

Resolution: Step 6d expanded inline to specify the de-hybridised triggers
explicitly. Condition A: `smart_hp_hh` absent and `dumb_hp_hh` available.
Condition B: `hhKeys = ['dumb_hp_hh', 'smart_hp_hh']`. Both use optional
chaining for defensive null safety. Risk row 3 removed (no longer a deferred
issue). The de-hybridised triggers also work pre-`m8-patch` — when the smart
HP path fails for thermal-mass reasons, `hybrid_smart` almost always fails
too (shared dependency), so requiring both was redundant.

**2. Replace `#t-at-restart` focus target with first-empty-input heuristic.**

Plan picked `#t-at-restart` as the fix-handler focus target with weak
justification (it accepts `.focus()` because it is a number input). Per M5's
Step 4c warning rules in `design/thermal-character.md`, the most common Path A
failure mode (continuous overnight heating, no cold-soak events at all) is
unlocked by `tau_bucket` (Path B), not by `t_at_restart_winter_c`. Focusing
`#t-at-restart` first would be a dead end for those users.

Resolution: Step 6d's fix handler updated to first-empty-input logic. Checks
`#tau-bucket` first (DOM order; empty value is the placeholder `''`), then
`#t-at-restart`, falling back to `#tau-bucket` if both are filled. Risk row 2
mitigation rewritten accordingly.

**3. Plan-internal cleanup.**

- Research finding for Fix 6 (Research findings section) updated to reflect
  resolved focus-target decision.
- Success criterion 6 updated to describe the first-empty behaviour.
- Files-table row for `js/financial.js` removed (a "MODIFY — no change needed"
  contradiction left over from the original Fix 4).
- Section heading at line 250 renamed `Claude.ai Review` → `Design Review`
  per the heatpump CLAUDE.md substitution table.

**4. Design doc cleanup (separate edit, applied alongside this amend).**

Design doc `design/ui-fixes-1.md` had two stale hybrid references that survived
the Fix 4 revision: Scope table row 4 ("BUS grant incorrectly applied to hybrid
scenarios") and test criterion 4 ("Hybrid scenarios show a higher net investment
than full HP scenarios..."). Both are deleted at the same commit as this plan
amend. Design state used during implementation is the cleaned version.

### Resolution of review changes

1. **Drop hybrid keys from Fix 6** — Conditions A and B triggers rewritten in
   Step 6d to reference only `smart_hp_hh`, `dumb_hp_hh`, `dumb_hp_svt`, with
   optional chaining for null safety. Risk row 3 removed.
2. **First-empty-input focus** — fix handler in Step 6d updated; research
   finding for Fix 6 rewritten; success criterion 6 updated; risk row 2
   mitigation rewritten.
3. **Plan-internal cleanup** — applied inline as listed above.
4. **Design doc cleanup** — applied directly to `design/ui-fixes-1.md` in
   praxis-claude-hub (alongside this amend commit).

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | — |
| HIGH     | 2     | ✅ resolved |
| MEDIUM   | 1     | ✅ resolved (design doc edit) |
| LOW      | 1     | ✅ resolved (heading renamed) |

Verdict: ⚠ APPROVED WITH EDITS — Fix 6 made forward-compatible with `m8-patch` and routed to the more universally applicable M5b input.

---

## Approval

**Status:** ⚠ Approved with edits — 2026-04-29
**Approved by:** Rhiannon (via Opus review)
**Clarifications confirmed:** Drop hybrid scenario keys from Fix 6 Conditions A and B for forward compatibility with `m8-patch`; use first-empty-input heuristic for Fix 6 fix-handler focus target (preferring `#tau-bucket` over `#t-at-restart`).

---

## Implementation Deviations

[To be completed post-implementation]
