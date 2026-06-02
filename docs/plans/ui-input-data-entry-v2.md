# ui-input-data-entry-v2 — §2 Your Energy Data (Octopus + CSV tabs)

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the live-data-entry half of the §2 Your Energy Data section: the
three-tab structure (Demo Profiles · Octopus Energy API · CSV Upload), the two
live-data tabs' surface fixes and new behaviours, and the cross-tab elements
(notice summary, gas-unit toggle, timezone surface, privacy notices). The Demo
Profiles tab and the `loadDemo()` mechanic are covered by the companion plan
`ui-input-demos-and-template-v2`.

Design doc: `ui-overhaul-input.md`. Required read: `ui-overhaul-conventions-v2.md`.

**Specific items covered:**
- Three-tab structure; Demo tab as default.
- Cross-tab: severity-aware split-count notice summary (2a); grouped electric-heating
  notice (2d); gas-unit sanity check + reference text on both paths (2j/2k); gas-unit
  toggle always interactive (2i); post-load re-confirm units path (2n) in §5.
- Octopus tab: region as name not GSP code (2c/G4); pre-fetch validation trim + format
  check (2e); privacy notice (2o-octopus).
- CSV tab: postcode-only, no region dropdown (2h); CSV template download link (2l);
  labelled rate defaults (2m); timezone detection surface (INV-19, §5.2); privacy notice
  (2o-csv); 90-day gate display.

---

## Research findings

**Existing tab structure:** The live tool has two tabs (Octopus / CSV). A third
"Demo Profiles" tab is new; it must be tab 1 (default). The tab-switching
mechanism already exists in `app.js` — extend with a third tab button and content panel.

**Notice summary (2a):** The current implementation shows a bare count. Update
`displayNotices` (or equivalent in `app.js`) to compose a severity-aware split-count
string: *"N notices — M fetch · P calibration · Q coverage"* using the existing notice
`kind` and severity metadata.

**Region display (G4):** `app.js` already has a `gsp_code` → region-name mapping used in
the `drove-card` (`populateDroveTile`). Reuse / extract this mapping for §5 and the
Octopus path display.

**Pre-fetch validation (2e):** Account number `A-XXXXXXXX` regex = `/^A-[A-Z0-9]{8}$/i`;
whitespace trim with `.trim()`. In-form error display (not a toast / alert).

**CSV template file:** Created as a separate Sonnet build artefact; this plan adds the
`<a href="heatpump-analyser-template.csv" download>` link to the CSV tab.

**Timezone surface (INV-19):** m1-v2 will emit `timezone_detection` on the ingestion
result. This plan wires the display logic (§5.2 table); it references m1-v2's warning
strings directly rather than authoring new ones.

**Gas-unit toggle (2i):** The v1 implementation disables the toggle when detection
confidence is high. Remove that disable-on-high-confidence logic; always interactive.

**Post-load re-confirm units (2n):** Add a "Re-confirm units" control to §5 Your Data
card (in the companion plan `ui-your-home-v2`). This plan wires the Recalculate
handler that fires when the toggle is flipped post-load.

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | Three-tab structure; Octopus/CSV tab content updates; privacy notices |
| MODIFY | `app.js` | Notice summary; pre-fetch validation; region name display; timezone surface; gas-unit always-active; tab default |
| CREATE | `heatpump-analyser-template.csv` | CSV template artefact (3 cols + example row with explicit offset) |

---

## Implementation steps

### Step 1 — Three-tab structure with Demo as default

In `index.html`, update the §2 tab bar from 2 tabs to 3:
```html
<button class="tab-btn active" data-tab="demo">Demo Profiles</button>
<button class="tab-btn" data-tab="octopus">Octopus Energy API</button>
<button class="tab-btn" data-tab="csv">CSV Upload</button>
```
Add the demo tab content panel (empty placeholder — filled by `ui-input-demos-and-template-v2`). The `active` class on Demo makes it the default.

In `app.js`, update the tab-switch handler to handle all three tabs. On DOMContentLoaded,
activate the demo tab. The Octopus and CSV tab content panels remain as-is structurally.

### Step 2 — Severity-aware split-count notice summary (2a)

In `app.js`, update the function that renders the notice count (find the current bare
count display — likely in `displayIngestionResult` or a `displayNotices` helper):

```js
function buildNoticeSummary(notices) {
  if (!notices?.length) return '';
  const bySeverity = notices.reduce((acc, n) => {
    acc[n.kind] = (acc[n.kind] || 0) + 1; return acc;
  }, {});
  const highestSev = notices.some(n => n.severity === 'error')   ? 'error'
                   : notices.some(n => n.severity === 'warning')  ? 'warning' : 'informational';
  const parts = Object.entries(bySeverity).map(([k, v]) => `${v} ${k}`);
  return `${notices.length} notices — ${parts.join(' · ')}`;
}
```

Render with a severity-class CSS prefix (informational / warning / error lead colour).

### Step 3 — Grouped electric-heating notice (2d)

When both the electric-heating-detection notice and its caveat notice are present,
render them as a single merged notice entry. In the notice-rendering logic, detect the
pair by `kind === 'electric_heating'` (or whatever kind the two notices share) and
concatenate into one DOM element with the merged wording from design-changes §2 2d.

### Step 4 — Pre-fetch validation (2e) — Octopus tab

Before the Fetch button submits, add client-side validation:
```js
const accountInput = document.getElementById('octopus-account');
const apiKeyInput  = document.getElementById('octopus-api-key');

function validateOctopusInputs() {
  const acct = accountInput.value.trim();
  const key  = apiKeyInput.value.trim();
  if (!/^A-[A-Z0-9]{8}$/i.test(acct)) {
    showInFormError(accountInput, 'Account number should look like A-1234ABCD');
    return false;
  }
  // silently normalise whitespace without rewriting displayed value
  return true;
}
```
Show the error inline below the field (a `<p class="field-error">` that is cleared on next keypress). Do not alert.

### Step 5 — Region name display (G4)

Extract the `gsp_code` → region-name map from `populateDroveTile` into a shared helper
`gspCodeToRegionName(code)`. Use it wherever region is displayed on both paths:
- Octopus tab: after fetch, show "Region: London" (not "C").
- CSV tab: after postcode lookup, show the derived region name (§2h).
- §5 Your Data card (wired when that plan lands).

### Step 6 — Remove region dropdown from CSV tab (2h)

In `index.html`, delete the `<select id="gsp-region">` dropdown from the CSV section.
In `app.js`, remove all reads of that select. Postcode → region derivation (§2h) is
now the sole path for the CSV tab. Add boundary-postcode fallback text: *"If your
region is wrong, override here"* with an advanced-override `<details>` element revealing
a minimal region override (one field, collapsed by default).

### Step 7 — Gas-unit toggle always interactive (2i)

Find the code in `app.js` that disables the m³/kWh toggle on high-confidence
detection — typically a `toggle.disabled = true` or `.classList.add('disabled')` call.
Remove it. The toggle must remain enabled regardless of detection confidence.

### Step 8 — Gas-unit sanity check reference text (2j/2k)

After the existing summer/winter daily-cost sanity display is rendered, append a
`<p class="sanity-reference">` with:
> *"Average UK household uses ~5–8 kWh/day gas in summer and ~25–60 kWh/day in
> winter. Source: Ofgem TDCV, medium-usage tier (~11,500 kWh/yr)."*

Render on both Octopus and CSV paths (after M1 completes). Use "average", not "typical".

### Step 9 — Timezone detection surface (INV-19, §5.2)

After M1 ingestion completes, read `ingestionResult.timezone_detection`:

```js
function displayTimezoneDetection(tz) {
  const el = document.getElementById('timezone-notice');
  if (!tz?.warnings?.length) { el.hidden = true; return; }
  // Render m1's warning strings directly — no new copy authored here
  el.innerHTML = tz.warnings.map(w => `<p class="notice notice-warning">${w}</p>`).join('');
  el.hidden = false;
}
```

Add `<div id="timezone-notice" hidden></div>` to the CSV section in `index.html`.
High/medium confidence (no warning) → element stays hidden.

### Step 10 — CSV template artefact + download link

Create `heatpump-analyser-template.csv` at the repo root with:
```
datetime,gas_kwh,electricity_kwh
2025-04-01T00:00:00+01:00,0.50,0.30
```
Add a download link in the CSV tab:
```html
<a href="heatpump-analyser-template.csv" download class="template-link">
  Download CSV template
</a>
```
Add the 90-day minimum note alongside the upload control:
*"Your file must cover at least 90 days of data (days with readings — not calendar span)."*

### Step 11 — Labelled rate defaults (2m)

On the CSV tab rate inputs, add a `<p class="rate-note">` subtitle:
*"Defaults: April 2026 Ofgem cap. Override with your actual rates for accuracy."*

### Step 12 — Privacy notices (2o)

Add two hidden `<details>` or visible `<p class="privacy-notice">` elements:

**Octopus tab** (below the API-key field):
> *"Your account number and API key are sent only to octopus.energy to fetch your
> consumption data. Not stored on our server (we don't have one) and not retained
> in your browser between sessions."*

**CSV tab** (below the postcode field):
> *"Used to look up local weather and your electricity region for half-hourly tariff
> scenarios. Sent only to postcodes.io (region + coordinates) and open-meteo.com
> (temperature). Both public services — no account, no tracking. Not stored on our
> server (we don't have one) and not retained in your browser between sessions."*

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `timezone_detection` field absent from m1-v2 until m1-v2 is implemented | Guard with `?.warnings?.length` — silently hides the notice when the field is absent |
| Three-tab restructure shifts existing event listener registration order | Read all `DOMContentLoaded` + tab-btn listener setup in app.js before writing; update systematically |
| Region-name map duplicated between drove-card and new helper | Extraction step (Step 5) removes the duplication — test that drove-card still works after extraction |
| 90-day gate on CSV path is a count of days-with-data, not calendar span | The gate check lives in m1-v2; this plan only renders the stated minimum in copy — no gate logic here |

---

## Success criteria

- [ ] Three tabs rendered; Demo Profiles active on first load
- [ ] Notice summary shows severity + split-count, never bare number
- [ ] Region shown as name ("London") on both Octopus and CSV paths
- [ ] Pre-fetch validation blocks on bad account number format with in-form message; whitespace trimmed
- [ ] Gas-unit toggle usable even on high-confidence m³ detection
- [ ] Sanity check shows reference text on both paths (Ofgem TDCV wording)
- [ ] Timezone warning from m1-v2 rendered on CSV path; high-confidence → hidden
- [ ] Template download link present; file has 3 columns + explicit-offset example row
- [ ] Rate default subtitle present on CSV tab
- [ ] Privacy notices present on both tabs
- [ ] No region dropdown on CSV tab

---

## Implementation Deviations

*To be completed after implementation.*

<!--
Status values:
- Awaiting review — Opus architect review pending.
- ✅ Approved — yyyy-mm-dd. Implementation may begin.
- ⚠ Approved with edits — yyyy-mm-dd. Implementation may begin [once <prereq>].
- ⏸ Blocked — yyyy-mm-dd. See Design Review below; rewrite required.
- Implemented — yyyy-mm-dd, commit <hash>.
-->
