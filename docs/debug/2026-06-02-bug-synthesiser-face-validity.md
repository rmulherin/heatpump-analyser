# Bug: Synthesiser fails 2 of 4 face-validity checks on Demo 1 (modern-out-for-work)

**Date:** 2026-06-02
**Reporter:** Rhiannon (driven by Opus iteration loop on Demo 1)
**Status:** Investigating

## Symptom

First bake run of [modern-out-for-work.json](../../demo-configs/modern-out-for-work.json) (§E-aligned config, prng_seed 1001, Cambridge weather) produces a CSV that:

| Metric | Expected (strategy §F) | Observed | Pass |
|---|---|---|---|
| Annual gas vs Nesta P3 target (7,237 kWh) | within ±10% (TC2) | **6,080 kWh (-16.0%)** | ❌ |
| Annual elec vs Nesta P3 target (1,946 kWh) | within ±10% (TC2) | **1,447 kWh (-25.7%)** | ❌ |
| `gas_hdd_r2` (daily-gas vs HDD R²) | [0.7, 0.97] | **0.367** | ❌ |
| `summer_winter_ratio` (winter÷summer daily-gas) | [1.2, 1.8] | **0.601** | ❌ |
| `weekday_weekend_ratio` (elec) | [0.8, 1.2] | 0.919 | ✅ |
| `holiday_weeks_injected` | [6, 8] | 7 | ✅ |
| Gas HHs clamped to zero | ≤ a few % | **5,559 / 17,520 = 31.7%** | ⚠ |
| Elec HHs clamped to zero | ≤ a few % | 1,359 / 17,520 = 7.8% | ⚠ |

The structural failures (gas_hdd_r², summer_winter_ratio, clamp rate) are config-invariant — bake 1 with diverged config and bake 2 with §E-reverted config produced essentially identical face-validity values, differing only by PRNG noise.

The minor annual-total miss (gas -16%) could plausibly close with parameter tuning, but the structural issues will not be fixable that way: a `summer_winter_ratio < 1` indicates summer daily gas ≥ winter daily gas, which is physically impossible for a heating-driven gas-CH household.

## Environment

- **Repo:** `heatpump-analyser`
- **Branch:** main
- **Synthesiser commit:** 5d5932f (D3 weekday/weekend fix on top of 02b169d feat: implement test-data synthesiser)
- **Demo config commit:** e9934f8 (revert to §E values, this debug session)
- **Node:** see `package.json` engines
- **Weather data:** Open-Meteo, Cambridge (CB1 2BX), 2025-01-01 → 2025-12-31, cached after first fetch
- **Noise config:** [test-data/noise-config.json](../../test-data/noise-config.json) (P50 autocorr 0.735, daily_residual_cv 0.354)

## Bake artefacts referenced in this doc

- [bake-output/modern-out-for-work/modern-out-for-work-stats.json](../../bake-output/modern-out-for-work/modern-out-for-work-stats.json)
- [bake-output/modern-out-for-work/modern-out-for-work-bake-report.md](../../bake-output/modern-out-for-work/modern-out-for-work-bake-report.md)

## Source files to investigate

- [scripts/lib/synthesiser.mjs](../../scripts/lib/synthesiser.mjs) — forward model, noise injection, stats
- [scripts/synthesise.mjs](../../scripts/synthesise.mjs) — CLI wrapper

## Initial hypotheses

To be filled in Phase 2 after reading source.

---

## Phase 1 — Observe and reproduce

Will be populated as source is read.

## Phase 2 — Hypotheses

Will be populated after Phase 1.

## Phase 3 — Narrow

Will be populated after Phase 2.

## Phase 4 — Root cause

Will be populated after Phase 3.

## Phase 5 — Scoped fix

Will be populated after Phase 4.
