# Bug: Results graph not rendering; What If tiles premature; manual-entry flag missing; results incorrect

**Date:** 2026-05-01
**Reporter:** Rhiannon
**Status:** Investigating

---

## Symptoms

### Bug 1 — Results graph not rendering
The results section appears after calculation but the chart/graph is not displayed.
Expected: Chart.js graph renders showing the six-scenario cost comparison.

### Bug 2 — "What If" section visible on page load
The What If controls/tiles are visible when the page first opens, before any data has
been entered or results calculated. They should only appear after results have been
computed.

### Bug 3 — No visible flag for manual-entry fields required
Rhiannon's house requires certain manual entries to calculate correctly (e.g. wall
construction type, or a field that auto-detection cannot resolve). There is no visible
indicator that this is needed; the flag is only visible inside the expanded
"Show Methodology" section, not on the main UI surface.

### Bug 4 — Results do not make sense (BLOCKED — awaiting user detail)
The numerical results are incorrect in some way. Detail cannot be provided until
Bug 1 (graph rendering) is resolved so Rhiannon can see the outputs clearly.
Investigation of this bug is deferred until Bug 1 is fixed.

---

## Environment

- App type: single-page client-side HTML/JS, no server
- Charting library: Chart.js (version to confirm)
- Hosting: GitHub Pages (rmulherin/heatpump-analyser)
- Platform: Windows 11, local browser

---

## Initial hypotheses

*To be filled during investigation.*

---

## Investigation Log

*To be filled during investigation.*
