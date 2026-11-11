// Node check of the round 21 calendar paths used by index.html (REQ-CAL-*, contracts/protocol.md §65), on the real server
// code bundled into site/js/logic.js: the rows come from each feature's own data (seasons and the pass month, weekly
// challenge weeks, announced banners, the demo tournaments standing in for the tournament index), paid rows carry dates
// only (no price, the pass has no link, a banner links to its rates page), every row's English through the prototype's
// catalog, marks (idempotent, the server's calendar_mark row once per change, no push queued) and the KPI rows on the
// server's client-event schema.
// usage: node tools/figma-prototype/test/round21-calendar.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const store = {};
Object.defineProperties(store, {
  getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
  setItem: { value: (k, v) => { store[k] = String(v); } },
  removeItem: { value: (k) => { delete store[k]; } },
});
globalThis.localStorage = store;
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;
const JP = /[぀-ヿ㐀-鿿]/;

await L.bootstrap();
// a fresh player: scout is open from the start, events / tournaments / seasons are not yet
const fresh = (await L.calendar({})).value;
assert.ok(fresh.entries.every((e) => !['event', 'tournament', 'tournament_registration', 'season', 'weekly_challenge'].includes(e.kind)), 'a new player sees only what is open to them');
// a week of play (28 races): events, tournaments, the weekly challenge, seasons and the pass month are open
await L.seedDemo(7, [4, 4, 4, 4, 4, 4, 4]);
const v = (await L.calendar({})).value;
assert.strictEqual(v.timeZone, '日本時間');
const kinds = new Set(v.entries.map((e) => e.kind));
for (const k of ['season', 'season_pass', 'weekly_challenge', 'tournament_registration', 'tournament']) assert.ok(kinds.has(k), `rows of kind ${k}`);
for (const e of v.entries) {
  assert.ok(!Object.keys(e).some((k) => /price|coin|cost|left|remaining|countdown/i.test(k)), `${e.id}: dates only`);
  assert.ok(e.firstDay <= e.lastDay, `${e.id}: days in order`);
}
const pass = v.entries.find((e) => e.kind === 'season_pass');
assert.ok(pass.paid && pass.link === null && pass.rule === 'calendar_month', 'the pass row: dates only, no link, calendar month');
for (const b of v.entries.filter((e) => e.kind === 'banner')) assert.deepStrictEqual(b.link, { screen: 'gacha_rates', id: b.link.id }, 'a banner row links to its rates page');
const season = v.entries.find((e) => e.kind === 'season');
assert.ok(season.firstDay.endsWith('-01') && season.rule === 'calendar_month', 'seasons start on the 1st at 00:00 JST');
const week = v.entries.find((e) => e.kind === 'weekly_challenge' && e.status === 'upcoming');
if (week) assert.strictEqual(new Date(week.firstDay + 'T00:00:00Z').getUTCDay(), 1, 'weeks start on Monday (game days)');
assert.ok(!/今だけ|残りわずか|お得|倍|通常価格|オッズ|賭/.test(JSON.stringify(v)), 'no urgency, shop or betting wording');
// English: every server text of a row through the prototype's catalog (cup names are the player's)
for (const e of v.entries) {
  for (const t of [e.title, e.name].filter(Boolean)) assert.ok(!JP.test(L.l10n.translate(t) ?? t), `${e.id}: English for 「${t}」`);
  const line = e.endAt <= e.startAt ? `${e.startJst}（日本時間）` : `${e.startJst}〜${e.endJst}（日本時間）`;
  assert.ok(/ JST$/.test(L.l10n.translate(line) ?? ''), `${e.id}: the time line stays JST in English`);
}
assert.strictEqual(L.l10n.translate('日本時間'), 'JST');
assert.strictEqual(L.l10n.translate('11/14（土）'), 'Sat 11/14');
// marks: idempotent, the server row once per change, nothing pushed
const reg = v.entries.find((e) => e.kind === 'tournament_registration' && e.markable);
const outbox0 = (await L.calendarFacts()).value.outbox;
assert.strictEqual((await L.calendarMark(reg.id, true)).value.marked, true);
assert.strictEqual((await L.calendarMark(reg.id, true)).value.count, 1, 'marking twice changes nothing');
assert.ok((await L.calendar({})).value.entries.find((e) => e.id === reg.id).marked, 'the row shows its mark');
assert.strictEqual((await L.calendarMark(reg.id, false)).value.marked, false);
const facts = (await L.calendarFacts()).value;
assert.deepStrictEqual(facts.kpi.map((k) => k.s2), ['on', 'off'], 'calendar_mark once per change');
assert.strictEqual(facts.outbox, outbox0, 'no push is queued for a mark');
assert.strictEqual((await L.calendarMark('event:nope', true)).code, 'NOT_FOUND');
// KPI rows on the server's client schema
assert.deepStrictEqual((await L.calendarKpi('calendar_view', { view: 'week', entries: 9 })).value, { name: 'calendar_view', s1: 'week', value: 9 });
assert.deepStrictEqual((await L.calendarKpi('calendar_entry_open', { kind: 'banner' })).value, { name: 'calendar_entry_open', s1: 'banner' });
assert.strictEqual((await L.calendarKpi('calendar_view', { view: 'year', entries: 1 })).ok, false);
console.log(`round 21 calendar OK (${v.entries.length} rows, ${kinds.size} kinds)`);
