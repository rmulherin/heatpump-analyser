# Bug: m³ detection fires but conversion not applied — cost estimate unchanged

**Date:** 2026-04-30
**Reporter:** Rhiannon
**Status:** Investigating

## Symptom

Gas meter unit detection now correctly identifies Rhiannon's meter as m³ (checkbox is
pre-filled/ticked on load). However, the cost estimate is unchanged from before — the
same wrong figure that was produced when no conversion was applied.

## Secondary concern (possible design issue)

The checkbox is pre-filled with a message like "My meter reads in m³" (ticked). The
expected UX was: checkbox says "My meter reads in kWh" and is *unticked*, with
conversion auto-applied, so the user can simply continue without interacting with
the checkbox. This may be a design deviation rather than a runtime bug — to be
confirmed during investigation.

## Environment

- Vanilla JS, no build step
- GitHub Pages / local file open
- Gas meter in m³ (Rhiannon's real data)

## Initial hypotheses

[To be filled — see Phase 2]
