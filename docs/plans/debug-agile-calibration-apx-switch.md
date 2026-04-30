# Debug: Agile Calibration — Switch N2EX → APX, graceful degradation

**Date:** 2026-04-30
**Status:** 🔵 Draft — awaiting Opus review
**Debug doc:** `docs/debug/2026-04-30-agile-calibration-p-zero.md`
**Related files:** `js/external-data.js`, `js/pricing-engine.js`, `js/app.js`

---

## Bug summary

Three related symptoms reported 2026-04-30:

1. `external-data.js:431 Agile calibration P=0.00 outside expected range 5–20 p/kWh`
2. UI shows `Electricity (half-hourly) 0.0 p/kWh average`
3. Implausibly large HH saving: dumb_hp_hh = £384 vs flat rate = £890 — a margin that
   should only arise on a smart tariff

---

## Investigation findings

### Root cause A — N2EX has structurally withdrawn from UK peak-hour electricity trading

The Elexon MID dataset (`/bmrs/api/v1/datasets/MID`) provides two market index data
providers: `N2EXMIDP` (N2EX) and `APXMIDP` (APX/EEX).

The code has always filtered to `N2EXMIDP` only. Console testing of live Elexon data
on 2026-04-30 showed:

| Date range | N2EX total | N2EX non-zero | N2EX peak SPs (33–38) | N2EX peak non-zero |
|------------|-----------|--------------|----------------------|-------------------|
| Apr 1      | 1         | 0            | 0                    | 0                 |
| Apr 2–3    | 49        | 1            | 6                    | 0                 |
| Apr 15     | 1         | 0            | 0                    | 0                 |

N2EX settlement periods exist (volume=0, price=0) — N2EX is registered but not
executing trades. Peak SPs in particular show zero across the calibration window.

APX over the same period:

| Date range | APX total | APX non-zero | APX peak SPs (33–38) | APX peak non-zero | Sample peak prices |
|------------|----------|-------------|---------------------|------------------|--------------------|
| Apr 2–3    | 49       | 49          | 6                   | 6                | 8.2–11.6 p/kWh     |

APX has complete, non-zero data for all SPs including peak hours with plausible prices.

**Conclusion:** N2EX has withdrawn from UK market-index trading in April 2026. APX
(now EEX) is the active exchange. Switching the data provider from `N2EXMIDP` to
`APXMIDP` restores the calibration.

### Why P_samples was empty

`fetchWholesalePrices` builds `priceLookup` from N2EX records. All N2EX prices for
peak SPs (16:00–19:00 London) are 0 p/kWh in April 2026. The calibration loop filters
`wholesale <= 1.0`, so every peak-hour entry is discarded → `P_samples` is empty →
`P = 0` (line 428 ternary default).

Non-peak SPs have at most 1–2 N2EX records per day with non-zero prices (e.g. SP16 at
14.0 p/kWh on Apr 2). These produce a thin but non-empty `D_samples`, so `D` is
computed and the function returns a non-null result — `{ D, P_peak_p_kwh: 0, ... }`.

### Root cause B — graceful degradation does not catch P=0

In `pricing-engine.js`:

```javascript
const calibration = params.agile_calibration ?? {
  D: D_DEFAULT, P_peak_p_kwh: P_DEFAULT_PEAK_P_KWH, source: 'default',
};
```

`??` only fires for `null`/`undefined`. When calibration returns a valid non-null
object `{ P_peak_p_kwh: 0, ... }`, the fallback never applies. P=0 propagates into
the HH rate formula `D × wholesale + P` (peak becomes just `D × wholesale` — no
uplift), making Agile look like a pure wholesale-tracking tariff with no peak premium.
This inflates the apparent saving of dumb_hp_hh vs SVT.

### Root cause C — display average includes zero-rate periods

`app.js:1942` filters `elec_hh_rate_by_hh` with `r => r !== null`. When wholesale
data is missing, null-wholesale periods get rate=0. Zeros pass the `!== null` filter
and drag the displayed average toward zero — showing `0.0 p/kWh`.

---

## Proposed solution

### Fix 1 — Switch N2EXMIDP → APXMIDP (external-data.js)

Two changes in `fetchWholesalePrices` / `convertSpToUtc`:

```javascript
// Line 285-286 — filter
const apxRecords = allRecords.filter(r => r.dataProvider === 'APXMIDP');

// Line 323 — SP conversion guard
if (dataProvider !== 'APXMIDP') continue;
```

Also update the `source` tag in both return paths:
- Line 282: `source: 'elexon-mid-apx'`
- Line 308: `source: 'elexon-mid-apx'`

And rename the local variable from `n2exRecords` to `apxRecords` for clarity.

No change to the URL, pagination, SP→UTC conversion, or dedup logic — those are
provider-agnostic. `convertSpToUtc` receives pre-filtered records and does not
re-filter by provider — the guard at line 323 is the only other reference.

### Fix 2 — Graceful degradation (pricing-engine.js)

Replace `??` fallback with explicit validation of P:

```javascript
const raw = params.agile_calibration;
const calibration = (raw && raw.P_peak_p_kwh >= 5)
  ? raw
  : { D: D_DEFAULT, P_peak_p_kwh: P_DEFAULT_PEAK_P_KWH, source: 'default' };
```

This covers:
- `raw` is null/undefined (calibration failed entirely) → use defaults
- `raw.P_peak_p_kwh < 5` (N2EX-style sparse data, returns P=0) → use defaults
- `raw.P_peak_p_kwh >= 5` (APX data, plausible) → use fetched values

D is not separately validated here; a bad D would produce a console warn from
external-data.js and an implausible rate, but not a silent P=0 failure. Add D
validation as a separate concern if desired — out of scope here.

### Fix 3 — Display average excludes zero-rate periods (app.js)

```javascript
// Line 1942 — was: filter(r => r !== null)
const hhRates = rateMetadata?.elec_hh_rate_by_hh?.filter(r => r > 0) ?? [];
```

Zero-rate periods (null wholesale → no D×W contribution) should not dilute the
displayed average. This is a display-only change; the underlying rate array is
unchanged.

---

## Files to modify

| File | Change |
|------|--------|
| `js/external-data.js` | `N2EXMIDP` → `APXMIDP` (×3: filter, guard, source ×2); rename `n2exRecords` → `apxRecords` |
| `js/pricing-engine.js` | Replace `??` fallback with P-validated conditional |
| `js/app.js` | `filter(r => r !== null)` → `filter(r => r > 0)` at line 1942 |
| `docs/debug/2026-04-30-agile-calibration-p-zero.md` | Update Phase 5 and Verification with resolution |
| `CLAUDE.md` (heatpump-analyser) | No status update needed (bug fix, not module) |
| `~/Documents/git-repos/claude-coding-hub/context/heatpump-memory.md` | Update session memory after commit |

Note: the design doc `external-data.md` in praxis-claude-hub references `'N2EX'`
(wrong even before this fix — noted in `docs/debug/2026-04-24-bug-elexon-wholesale-price-400.md`).
Updating that doc is Opus scope.

---

## Implementation steps

### Step 1 — external-data.js: switch provider

1. Line 285: change comment to `// Filter to APXMIDP only`
2. Line 286: `allRecords.filter(r => r.dataProvider === 'N2EXMIDP')` →
   `allRecords.filter(r => r.dataProvider === 'APXMIDP')`; rename `n2exRecords` → `apxRecords`
3. Line 290: rename `n2exRecords.filter(...)` → `apxRecords.filter(...)`
4. Line 282 (error return): `source: 'elexon-mid-n2ex'` → `source: 'elexon-mid-apx'`
5. Line 308 (success return): same rename
6. Line 323 (`convertSpToUtc`): `if (dataProvider !== 'N2EXMIDP')` → `if (dataProvider !== 'APXMIDP')`

### Step 2 — pricing-engine.js: graceful degradation

Replace lines 66–72 with the `raw`/`calibration` conditional above.

### Step 3 — app.js: display average

Line 1942: `filter(r => r !== null)` → `filter(r => r > 0)`.

### Step 4 — debug doc

Update `docs/debug/2026-04-30-agile-calibration-p-zero.md`:
- Root cause section: confirm N2EX withdrawal + APX fix
- Phase 5 fixes: update to reflect all three fixes
- Verification: tick off items once confirmed

### Step 5 — commit

Single commit: `fix: switch Elexon wholesale data provider N2EX→APX; add calibration fallback; fix HH rate display average`

---

## Test criteria

- [ ] Console: no `P=0.00` warning on load
- [ ] Console: no uncaught errors
- [ ] UI: Electricity (HH) average shows plausible value (~15–25 p/kWh)
- [ ] UI: dumb_hp_hh cost is between flat-rate and smart_hp_hh (not implausibly cheap)
- [ ] UI: smart_hp_hh saving > dumb_hp_hh saving (Smart ≤ Dumb invariant holds)
- [ ] Manual: load with no Octopus data (CSV path) → calibration skipped, no console errors

---

## Open question for Opus review

Should we prefer APX unconditionally, or should the code try N2EX first and fall back
to APX if N2EX has < N non-zero records? APX-only is simpler and correct today; a
fallback is more robust if N2EX re-enters the market. Recommend APX-only given N2EX
has been absent for the entire post-reform period — simpler and less code.
