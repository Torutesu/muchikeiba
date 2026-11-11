// Node check of the round 19 tips paths used by index.html (REQ-TUT-*, contracts/protocol.md §57), on the real server code
// bundled into site/js/logic.js and the real C# engine in WASM: the index in both languages (numbers from the same data as
// the rates screen), cards opening with the unlocks, seen marks (idempotent, closed cards skipped), the "?" contexts, the
// KPI rows on the server's schema, and the whip lesson = the FTUE tutorial race (attempt 1, the honest rule) — a replay
// changes none of the first-time rewards or counters.
// usage: node tools/figma-prototype/test/round19-tips.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
const ja = (await L.tips('ja')).value;
const en = (await L.tips('en')).value;
assert.strictEqual(ja.topics.length, 5, 'five topics');
assert.ok(!JP.test(JSON.stringify(en)), 'the English index has no Japanese');
assert.deepStrictEqual(ja.tutorials.filter((t) => t.kind === 'race').map((t) => t.lesson), ['whip', 'position', 'stamina', 'reins'], 'four race lessons');
const odds = L.odds('standard');
assert.ok(ja.tips.find((t) => t.id === 'scout_pity_tip').body.includes(`${odds.pity.pullsRequired}回分`), 'the pity count comes from the rates data');
assert.ok(en.tips.find((t) => t.id === 'scout_rates_tip').body.includes(odds.rarityTotals.SSR.rate), 'the SSR rate comes from the rates data');
assert.ok(!/今だけ|残りわずか|倍|お得|オッズ/.test(JSON.stringify(ja)), 'no urgency, multiplier or betting wording');
const breeding = ja.tips.find((t) => t.id === 'breeding_pair');
assert.ok(!breeding.unlocked && breeding.body === null, 'a closed card has no text on a new player');
assert.strictEqual(L.tipContext('gacha_odds'), 'scout_pity_tip');
assert.strictEqual(L.tipContext('roster_bulk_retire'), 'roster_retire');

const s1 = (await L.tipsSeen(['whip_window', 'breeding_pair'])).value;
assert.deepStrictEqual([s1.marked, s1.skipped], [['whip_window'], ['breeding_pair']], 'open card marked, closed card skipped');
assert.deepStrictEqual((await L.tipsSeen(['whip_window'])).value.marked, [], 'idempotent');
assert.strictEqual((await L.view()).tips.newCount, s1.newCount, 'the settings badge follows');

for (const [name, props, row] of [
  ['tutorial_replay', { tutorialId: 'race_whip', kind: 'race', stage: 'finish' }, { name: 'tutorial_replay', s1: 'race_whip', s2: 'race', s3: 'finish' }],
  ['tip_view', { tipId: 'whip_window', source: 'lesson' }, { name: 'tip_view', s1: 'whip_window', s2: 'lesson' }],
  ['tip_context_open', { context: 'training', tipId: 'training_timing' }, { name: 'tip_context_open', s1: 'training', s2: 'training_timing' }],
]) assert.deepStrictEqual((await L.tipsKpi(name, props)).value, row, name);
assert.strictEqual((await L.tipsKpi('tip_view', { tipId: 'whip_window', source: 'push' })).ok, false, 'an unknown source is refused');

// the whip lesson is the FTUE tutorial race in the real engine (attempt 1: 0 whips → a close 2nd, never assisted)
const facts0 = (await L.tutorialFacts()).value;
const root = join(here, '..', '..', '..');
const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const E = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;
E.Init(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'), readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8'));
E.SetAssist('full');
const info = JSON.parse(E.StartTutorial(1));
assert.strictEqual(info.tutorialAttempt, 1, 'attempt 1');
assert.strictEqual(info.trackId, 'tutorial_straight_400', 'the FTUE tutorial straight');
let f = null;
for (let t = 1000, i = 0; i < 40000 && !(f && f.done); i++, t += 50) f = JSON.parse(E.Frame(t));
assert.ok(f.done && f.result && f.result.place === 2 && !f.result.won, `no whips: a close 2nd, not an assisted win (place ${f.result?.place})`);
assert.strictEqual(f.assist ?? 'off', 'off', 'never assisted, even with かんたん操作 set to full');
const facts1 = (await L.tutorialFacts()).value;
assert.deepStrictEqual(facts1, facts0, 'a lesson changes no first-time reward or counter');
console.log(`round19-tips OK — ${ja.tips.length} cards, ${ja.tutorials.length} replays, badge ${s1.newCount}`);
