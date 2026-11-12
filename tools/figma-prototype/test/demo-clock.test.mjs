// Node check of the prototype's demo clock (logic/entry.ts `now` / `setDayOffset`): a day offset is counted in game days
// (progression.dayRollover, protocol §15), not in 24 h steps of the wall clock, so the demo hooks and the tests on them do not
// depend on the time of day they run at. Regression: between 00:00 and 04:00 JST, offsets that crossed the 2026-12-01 switch
// from a 00:00 to a 04:00 rollover (a 28 h game day) landed twice on the same game day, and 「育成」's "next day" found its
// training slots used (quality-raising.test.mjs failed from 15:00 to 19:00 UTC). The wall clock is pinned here (Date is
// shifted, still running) to boundary-adjacent instants, so this runs the same at any real time.
// usage: node tools/figma-prototype/test/demo-clock.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const RealDate = Date;
let shift = 0;
class ShiftedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + shift); }
  static now() { return RealDate.now() + shift; }
}
globalThis.Date = ShiftedDate;
/** Pins the wall clock to `iso` (JST given as +09:00); it keeps running from there. */
const at = (iso) => { shift = RealDate.parse(iso) - RealDate.now(); };

const store = {};
Object.defineProperties(store, {
  getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
  setItem: { value: (k, v) => { store[k] = String(v); } },
  removeItem: { value: (k) => { delete store[k]; } },
});
globalThis.localStorage = store;
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;

// the game day by the shipped rule (server/src/domain/time.ts gameDayKey), read from the master
const rule = JSON.parse(readFileSync(join(here, '..', '..', '..', 'server', 'master', 'progression.json'), 'utf8')).dayRollover;
const H = 3_600_000;
const dayKey = (ms) => new RealDate(ms + 9 * H - (ms < rule.effectiveAtMs ? rule.previousHourJst : rule.hourJst) * H).toISOString().slice(0, 10);
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new RealDate(RealDate.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

// 1) every offset is exactly that many game days after today's, whatever the time of day (around the rule switch too)
const instants = ['2026-11-13T01:30:00+09:00', '2026-11-13T03:59:00+09:00', '2026-11-13T04:00:00+09:00', '2026-11-13T13:00:00+09:00',
  '2026-11-30T23:59:00+09:00', '2026-12-01T01:30:00+09:00', '2026-12-01T03:59:00+09:00', '2026-12-02T01:30:00+09:00',
  '2026-12-02T03:59:00+09:00', '2026-12-02T04:00:00+09:00', '2026-12-31T23:59:00+09:00'];
for (const iso of instants) {
  at(iso);
  L.reset();
  const real = Date.now();
  assert.ok(Math.abs(L.now() - real) < 1000, `${iso}: offset 0 is the real clock`);
  const today = dayKey(real);
  for (let d = 1; d <= 40; d++) {
    L.setDayOffset(d);
    assert.strictEqual(dayKey(L.now()), addDays(today, d), `${iso}: offset ${d} is game day ${addDays(today, d)}`);
  }
  L.setDayOffset(0);
  assert.ok(Math.abs(L.now() - Date.now()) < 1000, `${iso}: back to the real clock`);
}
// the clock runs on from the offset day; re-setting the same offset keeps it; the extra shift still adds on top
at('2026-11-13T01:30:00+09:00');
L.reset();
L.setDayOffset(5);
const t0 = L.now();
L.setDayOffset(5);
assert.ok(L.now() >= t0, 're-setting the same offset never moves the clock back');
L.setClockMs(t0 + 6 * H);
assert.ok(Math.abs(L.now() - (t0 + 6 * H)) < 1000, 'setClockMs stands at the given instant on an offset day');
L.setClockMs(null);
assert.strictEqual(dayKey(L.now()), dayKey(t0));

// 2) 「育成」 at the worst wall-clock times trains on every demo day (the same growth as at midday), and the next game day has
// fresh training slots
let noon = null;
for (const iso of ['2026-11-13T13:00:00+09:00', '2026-11-13T01:30:00+09:00', '2026-11-13T03:59:00+09:00', '2026-12-01T01:30:00+09:00']) {
  at(iso);
  L.reset();
  await L.seedRaising(12);
  const p = (await L.horseProfile((await L.view()).flags.partnerHorseId)).value;
  assert.ok(p.career.races >= 12, `${iso}: a race on each raising day`);
  noon ??= p.growth.trainedTotal;
  assert.strictEqual(p.growth.trainedTotal, noon, `${iso}: every raising day trained (the same growth as at 13:00)`);
  L.setDayOffset(7 + 12);
  const tv = (await L.training()).value;
  assert.ok(tv.horses.some((x) => !x.blocked), `${iso}: the next game day has a horse that can still train`);
}
L.reset();
console.log(`demo clock OK — ${instants.length} wall-clock instants × 40 offsets on game days, 「育成」 at 3 boundary times = midday (trained ${noon})`);
