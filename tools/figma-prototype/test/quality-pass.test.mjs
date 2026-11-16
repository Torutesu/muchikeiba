// Node check of quality pass 3 (docs/quality/pass.md): the season pass standout tiers on the real server code bundled into
// site/js/logic.js — the pass screen's standouts / next standout, a standout claim granting the part (the silks editor unlocks it,
// the source line names the tier), and the track totals unchanged.
// usage: node tools/figma-prototype/test/quality-pass.test.mjs
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

// a season close in the middle would reset the pass: near a month end, run on the 2nd of the next month
{
  const DAY = 86_400_000, jst = new Date(L.now() + 9 * 3_600_000);
  const dim = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 0)).getUTCDate();
  if (jst.getUTCDate() > dim - 2) L.setClockMs(L.now() + (dim - jst.getUTCDate() + 2) * DAY);
}
await L.seedDemo(1, [3]);
assert.ok((await L.demoPassXp(1740)).ok, 'demo: stand at level 17');
let v = await L.passView();
assert.strictEqual(v.level, 17);
assert.deepStrictEqual(v.standouts.map((x) => `${x.track}:${x.level}:${x.look.part}`), ['premium:10:color', 'free:15:cap', 'premium:20:sleeve', 'premium:30:pattern']);
assert.deepStrictEqual({ ...v.nextStandout }, { track: 'premium', level: 20, itemId: 'silkpart_sleeve_comet', label: '勝負服の袖「流星」', levelsAway: 3, racesAway: 13 }); // (2000 − 1740) XP at 20 XP a race
assert.strictEqual(v.totals.premium.freeCoins, 1500, 'the premium total is unchanged');
assert.strictEqual(v.totals.free.freeCoins, 300, 'the free total is unchanged');
// the free standout is claimable without the pass; the premium one after buying it
const free = v.standouts.find((x) => x.track === 'free');
assert.ok(free.claimable && !v.standouts.find((x) => x.level === 10).claimable);
let r = await L.claimPass('free', 15);
assert.ok(r.ok, 'claim free 15');
assert.deepStrictEqual(r.value.items.map((x) => x.itemId), ['silkpart_cap_comet']);
const buy = await L.demoPurchase('season_pass');
assert.ok(buy.ok, 'demo purchase of the pass: ' + (buy.message ?? ''));
r = await L.claimPass('premium', 10);
assert.ok(r.ok, 'claim premium 10');
assert.strictEqual(r.value.freeCoins, 50, 'the usual coins');
assert.deepStrictEqual(r.value.items.map((x) => x.itemId), ['breeding_material', 'silkpart_color_shokou'], 'the usual material plus the part');
const ed = await L.silksEditor();
assert.strictEqual(ed.parts.colors.find((x) => x.id === 'shokou').owned, true, 'the editor unlocks the colour');
assert.strictEqual(ed.parts.patterns.find((x) => x.id === 'comet').sourceLabel, 'シーズンパス 有料ライン ティア30で入手', 'the source line names the tier');
v = await L.passView();
assert.ok(v.standouts.find((x) => x.level === 10).claimed);
// English for the new server lines
assert.strictEqual(L.l10n.translate('シーズンパス 有料ライン ティア30で入手'), 'Season Pass premium track, tier 30');
console.log('quality pass 3 (season pass standouts): OK —', v.standouts.length, 'standouts, next', v.nextStandout?.level ?? '-', ', totals 1,500 + 300 free coins');
