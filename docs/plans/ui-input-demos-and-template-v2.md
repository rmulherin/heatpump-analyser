# ui-input-demos-and-template-v2 — Demo Profiles tab (§2.4)

**Date:** 2026-06-02
**Status:** Awaiting review — Opus architect review pending.

---

## Task description

Implement the Demo Profiles tab: the four-card grid UI, the `data/demos/` directory
layout, the `index.json` manifest, the `loadDemo(slug)` orchestrator that threads a
synthetic CSV through the existing ingestion pipeline, and the asset consolidation
(baked CSVs + house SVGs into `data/demos/`).

Design doc: `ui-overhaul-input.md` §3.4. Required reads: `ui-overhaul-conventions-v2.md`.
Companion plan: `ui-input-data-entry-v2` (provides the three-tab structure; Demo tab
panel exists but is empty until this plan).

**Prerequisite:** `ui-input-data-entry-v2` must be implemented first (the three-tab
structure and the Demo tab panel must exist).

**Asset consolidation prerequisite:** the four baked demo CSVs (`{slug}.csv`) from
`bake-output/{slug}/` and the four house SVGs from
`praxis-claude-hub/projects/tools/heatpump-analyser/design/assets/` must be available
to copy into `data/demos/`. Verify these exist before implementation begins.

---

## Research findings

**Existing pipeline reuse:** `parseCSV()` (data-ingestion.js:433) and
`normaliseConsumption()` (:697) are the existing CSV parse + normalise functions.
The `btnCsvAnalyse` handler in `app.js` already wires these into the M2…M9 pipeline.
`loadDemo` wraps these same steps, sourcing CSV text from `fetch()` instead of
`FileReader`. The only new code is the orchestrator + card-grid DOM/handlers.

**`data/demos/` directory:** already exists as a `.gitkeep` placeholder. Contains nothing
other than the placeholder — the consolidation step populates it.

**Demo postcodes** (from `demo-configs/*.json`): `CB1 2BX` (modern-out-for-work),
`S10 2HQ` (average-in-all-day), `E14 9SH` (small-and-efficient),
`DG2 7AS` (big-old-draughty). All non-boundary → region derivation unambiguous.

**Synthetic disclosure:** each demo card must show: *"Synthesised demo — informed by Nesta
GB profiles · [how this was made]"* (linking to the methodology anchor). This is a
non-negotiable label — demos must not be read as real households.

**Verdict-space design:** the four demos span the verdict space deliberately:
modern-out-for-work (clear win), average-in-all-day (mid), small-and-efficient (small
absolute saving), big-old-draughty (HP marginal even on HH). The card order follows
`display_order` in `index.json` (1–4).

---

## Files to create / modify

| Action | File | Purpose |
|--------|------|---------|
| MODIFY | `index.html` | Demo card grid in the Demo tab panel |
| MODIFY | `app.js` | `loadDemo(slug)` orchestrator + card-grid event handlers |
| CREATE | `data/demos/index.json` | Slim manifest: ordered card metadata (slug/label/bio/postcode/csv/svg/disclosure) |
| COPY | `data/demos/{slug}.csv` × 4 | Baked demo CSVs (from `bake-output/{slug}/{slug}.csv`) |
| COPY | `data/demos/{slug}.svg` × 4 | House illustration SVGs (from praxis-hub `design/assets/`) |

---

## Implementation steps

### Step 1 — Create `data/demos/index.json`

Write the slim manifest (UI-facing only, ordered by `display_order`):

```jsonc
[
  {
    "slug": "modern-out-for-work",
    "label": "Modern home, out for work",
    "bio": "A 1990s semi-detached with two working adults. Well-insulated but not a new-build. Empty weekdays, busier at weekends.",
    "display_order": 1,
    "csv": "modern-out-for-work.csv",
    "svg": "modern-out-for-work.svg",
    "postcode": "CB1 2BX",
    "disclosure": {
      "is_synthetic": true,
      "source": "Synthesised demo informed by Nesta GB profiles",
      "methodology_url": "#methodology"
    }
  },
  {
    "slug": "average-in-all-day",
    "label": "Average home, in all day",
    "bio": "A 1970s semi with a retired couple at home most of the day. Mid-range insulation, no major upgrades.",
    "display_order": 2,
    "csv": "average-in-all-day.csv",
    "svg": "average-in-all-day.svg",
    "postcode": "S10 2HQ",
    "disclosure": { "is_synthetic": true, "source": "Synthesised demo informed by Nesta GB profiles", "methodology_url": "#methodology" }
  },
  {
    "slug": "small-and-efficient",
    "label": "Small & efficient",
    "bio": "A modern 2-bed flat, well-insulated, low total energy use. HP works well but the absolute saving is modest.",
    "display_order": 3,
    "csv": "small-and-efficient.csv",
    "svg": "small-and-efficient.svg",
    "postcode": "E14 9SH",
    "disclosure": { "is_synthetic": true, "source": "Synthesised demo informed by Nesta GB profiles", "methodology_url": "#methodology" }
  },
  {
    "slug": "big-old-draughty",
    "label": "Big old draughty",
    "bio": "A Victorian terrace, poorly insulated, high heat loss. The HP case is marginal even on Half-Hourly tariff — the honest demo.",
    "display_order": 4,
    "csv": "big-old-draughty.csv",
    "svg": "big-old-draughty.svg",
    "postcode": "DG2 7AS",
    "disclosure": { "is_synthetic": true, "source": "Synthesised demo informed by Nesta GB profiles", "methodology_url": "#methodology" }
  }
]
```

> If the bios in the fat `demo-configs/*.json` differ from the above, use the
> bake-input bios — they are canonical. Read them before writing.

### Step 2 — Consolidate demo assets

Copy from `bake-output/{slug}/{slug}.csv` → `data/demos/{slug}.csv` for each of the
four slugs. Copy from praxis-hub `design/assets/{Big,Average,Modern,Small}_house.svg`
→ `data/demos/{slug}.svg` with the slug-named filename (map: modern→Modern, average→Average,
small→Small, big→Big). Remove the `.gitkeep` placeholder.

Verify all 8 asset files are present before proceeding to DOM work.

### Step 3 — Demo card grid in `index.html`

In the Demo tab panel (added by `ui-input-data-entry-v2`), add a `<div class="demo-grid">` placeholder:

```html
<div id="demo-grid" class="demo-grid" aria-label="Demo profiles">
  <!-- populated by JS from index.json -->
</div>
```

No card HTML in `index.html` — cards are generated by `app.js` from the manifest so
the grid updates when `index.json` changes without a code edit.

### Step 4 — Card grid renderer in `app.js`

Add `async function renderDemoGrid()`:

```js
async function renderDemoGrid() {
  const res = await fetch('data/demos/index.json');
  const demos = await res.json();
  const grid = document.getElementById('demo-grid');
  grid.innerHTML = demos
    .sort((a, b) => a.display_order - b.display_order)
    .map(d => `
      <button class="demo-card" data-slug="${d.slug}" aria-label="Load ${d.label} demo">
        <img src="data/demos/${d.svg}" alt="${d.label} illustration" class="demo-card__svg">
        <h3 class="demo-card__label">${d.label}</h3>
        <p class="demo-card__bio">${d.bio}</p>
        <p class="demo-card__disclosure">
          Synthesised demo — informed by Nesta GB profiles ·
          <a href="${d.disclosure.methodology_url}" class="disclosure-link" tabindex="-1">how this was made</a>
        </p>
      </button>
    `).join('');
  grid.querySelectorAll('.demo-card').forEach(btn => {
    btn.addEventListener('click', () => loadDemo(btn.dataset.slug, demos));
  });
}
```

Call `renderDemoGrid()` from the DOMContentLoaded handler (or tab-switch handler for the
Demo tab, whichever renders first).

### Step 5 — `loadDemo(slug, demos)` orchestrator in `app.js`

```js
async function loadDemo(slug, demos) {
  const meta = demos.find(d => d.slug === slug);
  if (!meta) return;

  // Visual feedback — disable grid, show loading state
  document.getElementById('demo-grid').querySelectorAll('.demo-card')
    .forEach(b => b.disabled = true);

  try {
    // Step 1: fetch baked CSV
    const csvRes = await fetch(`data/demos/${meta.csv}`);
    if (!csvRes.ok) throw new Error(`Failed to load demo CSV: ${csvRes.status}`);
    const csvText = await csvRes.text();

    // Step 2: parse using existing function
    const records = parseCSV(csvText);   // data-ingestion.js:433 — EXISTING

    // Step 3: set postcode + derive region (same §2h path as manual CSV)
    setPostcode(meta.postcode);           // existing setter or direct DOM set
    const region = await deriveRegionFromPostcode(meta.postcode);  // existing fn

    // Step 4: set rate defaults (Apr 2026 Ofgem cap defaults)
    setRateDefaults();   // existing fn that sets cap-default rate inputs

    // Step 5: normalise + set ingestion result
    const { elecRecords, gasRecords } = splitRecords(records);   // EXISTING
    const normalised = normaliseConsumption(elecRecords, gasRecords, { gsp_region: region });
    setIngestionResult({ ...normalised, gsp_region: region });   // EXISTING setter

    // Step 6: run the pipeline M2 → M9 (same sequence as the CSV handler)
    await runFullPipeline();   // the existing pipeline trigger (find in btnCsvAnalyse handler)

  } catch (err) {
    showDemoLoadError(meta.label, err.message);
  } finally {
    document.getElementById('demo-grid').querySelectorAll('.demo-card')
      .forEach(b => b.disabled = false);
  }
}
```

> **Function names:** `parseCSV`, `normaliseConsumption`, `setIngestionResult`, and the
> M2…M9 pipeline trigger are existing functions in `app.js` / `data-ingestion.js`. Read
> the existing `btnCsvAnalyse` handler before writing `loadDemo` to confirm exact names
> and call sequence.

### Step 6 — Error handling for demo load

`showDemoLoadError(label, message)` renders a `<p class="demo-load-error">` above the
grid: *"Couldn't load '[label]' demo: [message]. Try refreshing."* Single unified
`.catch()` per `loadDemo` — no separate catch per sub-step.

### Step 7 — CSS for demo grid + card

In `css/style.css` (or `index.html` `<style>`):

```css
.demo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
}
.demo-card {
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 1rem;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s;
}
.demo-card:hover { border-color: #3B8284; }
.demo-card__svg { width: 100%; height: 120px; object-fit: contain; }
.demo-card__label { font-weight: 600; margin: 0.5rem 0 0.25rem; }
.demo-card__bio { font-size: 0.875rem; color: #555; margin: 0 0 0.5rem; }
.demo-card__disclosure { font-size: 0.75rem; color: #888; margin: 0; }
```

Mobile: grid collapses to 1 column below 480px (auto-fit handles this).

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Bio strings in `index.json` differ from bake-input `demo-configs/*.json` | Step 1 note: read the fat bake-input bios before writing; they are canonical |
| Baked CSV or SVG assets not in expected locations | Step 2 verification: confirm file existence before proceeding to DOM steps |
| `deriveRegionFromPostcode` function name unknown | Read the existing CSV Fetch handler to find the exact name before calling |
| `runFullPipeline()` may need arguments (postcode, region, rate params) | Read the `btnCsvAnalyse` trigger to understand what state it reads from DOM vs args; mirror exactly |
| Demo card click triggers before `renderDemoGrid` resolves | Buttons are registered inside `renderDemoGrid`'s `.then()`; no race |

---

## Success criteria

- [ ] Demo Profiles tab shows four cards in `display_order` 1–4
- [ ] Each card renders: SVG illustration, label, bio, synthetic-data disclosure line with methodology link
- [ ] Clicking "Big old draughty" loads its CSV, runs the pipeline, and surfaces a result (HP marginal verdict)
- [ ] Synthetic-data disclosure is visible on every card before and after loading
- [ ] Demo CSVs and SVGs committed to `data/demos/`; `.gitkeep` removed
- [ ] `index.json` committed to `data/demos/`; manifest-driven (no hardcoded card HTML in index.html)
- [ ] Error message shown if demo CSV fails to load; cards re-enabled
- [ ] Grid collapses to 1 column on narrow viewport

---

## Implementation Deviations

*To be completed after implementation.*

<!--
Status values:
- Awaiting review — Opus architect review pending.
- ✅ Approved — yyyy-mm-dd. Implementation may begin.
- ⚠ Approved with edits.
- ⏸ Blocked.
- Implemented — yyyy-mm-dd, commit <hash>.
-->
