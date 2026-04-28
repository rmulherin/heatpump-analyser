// test-m3-step-f.mjs — Step F patch: absence detection without run-length minimum
// Run: node test-m3-step-f.mjs  (from repo root)
//
// Tests T11, T13, T14, T15, T15a from the module-3-step-f-patch plan.
// baseload.js uses Luxon as a browser global; the minimal stub below covers
// exactly the DateTime API surface used by detectAbsences.

// ── Luxon stub (must precede the dynamic import of baseload.js) ────────────────

class FakeDateTime {
  constructor(ms) { this._ms = ms; }
  valueOf()              { return this._ms; }
  toISODate()            { return new Date(this._ms).toISOString().slice(0, 10); }
  diff(other, _unit)     { return { days: (this._ms - other._ms) / 86400000 }; }
  plus({ days })         { return new FakeDateTime(this._ms + days * 86400000); }
  static fromISO(str)    { return new FakeDateTime(new Date(str).getTime()); }
}
global.luxon = { DateTime: FakeDateTime };

// ── Import under test ─────────────────────────────────────────────────────────

const { detectAbsences } = await import('./js/baseload.js');

// ── Infrastructure ────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else       { console.error(`  FAIL  ${name}`); failed++; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate(dateStr, offsetDays) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Build 48 HH records for one calendar day (UTC). nullFirstSlot simulates a
// meter-read gap — isWholeDay will return false for such a day.
function makeDay(dateStr, gasKwhPerHh, nullFirstSlot = false) {
  const records = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const ts = `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`;
      const gas = (nullFirstSlot && records.length === 0) ? null : gasKwhPerHh;
      records.push({ timestamp: ts, gas_kwh: gas });
    }
  }
  return records;
}

// Build consecutive whole days (48 HH each) starting from startDateStr.
function makeDays(startDateStr, numDays, gasKwhPerHh) {
  const records = [];
  for (let i = 0; i < numDays; i++) {
    records.push(...makeDay(isoDate(startDateStr, i), gasKwhPerHh));
  }
  return records;
}

const BASELOAD = 10; // kWh/day — threshold = 20% × 10 = 2 kWh/day

// ── T11 — 10-day absence period (behaviour unchanged from pre-patch) ───────────

console.log('\nT11 — 10-day absence (unchanged):');
{
  const consumption = makeDays('2025-01-01', 10, 0);
  const heating     = consumption.map(r => ({ timestamp: r.timestamp }));
  const warnings    = [];
  const { absence_periods, absence_days_total } = detectAbsences(consumption, heating, BASELOAD, warnings);

  assert(absence_periods.length === 1,    'T11a: one absence period');
  assert(absence_periods[0].days === 10,  'T11b: period.days = 10');
  assert(absence_days_total === 10,       'T11c: absence_days_total = 10');
  assert(heating.every(s => s.is_absence === true), 'T11d: all slots is_absence = true');
}

// ── T13 — 2-day absence (newly flagged; previously blocked by ≥3-day gate) ────

console.log('\nT13 — 2-day absence (inverted — now flagged):');
{
  const consumption = makeDays('2025-02-01', 2, 0);
  const heating     = consumption.map(r => ({ timestamp: r.timestamp }));
  const warnings    = [];
  const { absence_periods, absence_days_total } = detectAbsences(consumption, heating, BASELOAD, warnings);

  assert(absence_periods.length === 1,   'T13a: one absence period');
  assert(absence_periods[0].days === 2,  'T13b: period.days = 2');
  assert(absence_days_total === 2,       'T13c: absence_days_total = 2');
  assert(heating.every(s => s.is_absence === true), 'T13d: all slots is_absence = true');
}

// ── T14 — 10-day period at 30% baseload (above threshold — NOT flagged) ────────

console.log('\nT14 — 30% baseload (above threshold, unchanged):');
{
  const gasPerHh    = 3 / 48; // 3 kWh/day > 2 kWh/day threshold
  const consumption = makeDays('2025-03-01', 10, gasPerHh);
  const heating     = consumption.map(r => ({ timestamp: r.timestamp }));
  const warnings    = [];
  const { absence_periods, absence_days_total } = detectAbsences(consumption, heating, BASELOAD, warnings);

  assert(absence_periods.length === 0,    'T14a: no absence periods');
  assert(absence_days_total === 0,        'T14b: absence_days_total = 0');
  assert(heating.every(s => s.is_absence === false), 'T14c: no slots is_absence = true');
}

// ── T15 — single-day absence (newly flagged; previously blocked by ≥3-day gate) ─

console.log('\nT15 — single-day absence (inverted — now flagged):');
{
  const consumption = makeDay('2025-04-15', 0);
  const heating     = consumption.map(r => ({ timestamp: r.timestamp }));
  const warnings    = [];
  const { absence_periods, absence_days_total } = detectAbsences(consumption, heating, BASELOAD, warnings);

  assert(absence_periods.length === 1,   'T15a: one absence period');
  assert(absence_periods[0].days === 1,  'T15b: period.days = 1');
  assert(absence_days_total === 1,       'T15c: absence_days_total = 1');
  assert(heating.every(s => s.is_absence === true), 'T15d: all slots is_absence = true');
}

// ── T15a — partial day (one null HH): isWholeDay guard prevents flagging ───────

console.log('\nT15a — null HH slot (isWholeDay guard):');
{
  const consumption = makeDay('2025-05-10', 0, true); // first slot gas_kwh = null
  const heating     = consumption.map(r => ({ timestamp: r.timestamp }));
  const warnings    = [];
  const { absence_periods, absence_days_total } = detectAbsences(consumption, heating, BASELOAD, warnings);

  assert(absence_periods.length === 0,    'T15a-a: null HH — no absence periods');
  assert(absence_days_total === 0,        'T15a-b: null HH — absence_days_total = 0');
  assert(heating.every(s => s.is_absence === false), 'T15a-c: null HH — no slots is_absence = true');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
