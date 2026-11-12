// Node check of the quality integration (claude/quality-1): the four quality passes working together on the real server code
// bundled into site/js/logic.js.
//  a) home's 次にやること line: only an item no other home element says (the goal ladder already says 「受け取れる報酬があります」
//     for the daily / first-step / season missions and the season pass), else no line; one link at most;
//  e) the goal ladder's class cap and the 馬カード's ranked line are the same numbers for the same horse (the ladder links to the
//     card where it talks about the cap).
// usage: node tools/figma-prototype/test/quality-integration.test.mjs
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

// a) day 3: the server lists missions_claim, pass_claim, feature_unlocked — the first two are on the ladder
assert.strictEqual(typeof L.homeNextLine, 'function', 'MuchiLogic.homeNextLine (the one home rule for 次にやること)');
for (const k of ['missions_claim', 'pass_claim', 'login_bonus', 'race', 'first_win', 'training_slots']) assert.ok(L.homeCoveredKinds.includes(k), `${k} is said by another home element`);
await L.seedDemo(3, [2, 2, 2]);
const next = (await L.nextActions()).value;
const kinds = [next.primary, ...next.chips].filter(Boolean).map((i) => i.kind);
assert.ok(kinds.includes('pass_claim'), 'the server still lists the pass claim: ' + kinds);
const line = L.homeNextLine(next);
assert.ok(line, 'a line for what the ladder does not say');
assert.ok(!L.homeCoveredKinds.includes(line.item.kind), 'not something the ladder says: ' + line.item.kind);
assert.strictEqual(line.item.kind, kinds.find((k) => !L.homeCoveredKinds.includes(k)), 'the first uncovered item in the server order');
assert.ok(line.links.length <= 1, 'one link at most: ' + JSON.stringify(line.links));
// the ladder must actually say the pass claim, or hiding it would lose it
const goals = (await L.goals()).value;
assert.ok(goals.season.pass.freeClaimable > 0 && L.ladderSeasonReady(goals), 'the ladder\'s season rung says the pass rewards');
// only covered items → no line at all
assert.strictEqual(L.homeNextLine({ enabled: true, primary: { kind: 'missions_claim' }, chips: [{ kind: 'pass_claim' }, { kind: 'race' }] }), null, 'nothing uncovered: the line is hidden');
assert.strictEqual(L.homeNextLine({ enabled: false, primary: { kind: 'gift_expiring' }, chips: [] }), null, 'disabled: hidden');
const nd = L.homeNextLine({ enabled: true, primary: { kind: 'gift_expiring', dismissible: false }, chips: [] });
assert.deepStrictEqual(nd.links, [], 'not dismissible: no link (the line itself opens it)');
// quality-2 integration: a feature the ladder / menu already shows is not announced again as 「新しく開きました」 — the daily
// missions are the 今日 rung, the season the シーズン rung, the rival and the weekly challenge the 今週 rung, training the menu's 調教 row
assert.ok(Array.isArray(L.homeCoveredFeatures), 'MuchiLogic.homeCoveredFeatures');
for (const f of ['missions', 'training', 'season', 'rival', 'weekly_challenge']) {
  assert.ok(L.homeCoveredFeatures.includes(f), `${f} has its own home element`);
  assert.strictEqual(L.homeNextLine({ enabled: true, primary: { kind: 'missions_claim' }, chips: [{ kind: 'feature_unlocked', featureKey: f, dismissible: true }] }), null, `feature_unlocked ${f}: the ladder already says it`);
}
for (const f of ['breeding', 'time_attack', 'friends']) assert.strictEqual(L.homeNextLine({ enabled: true, primary: null, chips: [{ kind: 'feature_unlocked', featureKey: f, dismissible: true }] })?.item.featureKey, f, `feature_unlocked ${f}: nothing else on home says it`);
console.log(`a) home next line: server [${kinds}] → "${line.item.kind}", links [${line.links}]`);

// e) the ladder's cap = the horse card's ranked cap for the ladder's horse
await L.seedRaising(6);
const g = (await L.goals()).value;
const pw = g.season.power;
assert.ok(pw && pw.horseId, 'the ladder names the horse its power line is about');
const card = (await L.horseProfile(pw.horseId)).value;
assert.strictEqual(card.totals.cap, pw.cap, 'same class cap on the ladder and the card');
assert.strictEqual(card.totals.classId, g.season.classId, 'same class');
if (card.totals.race > card.totals.cap) assert.ok(card.totals.ranked <= card.totals.cap && card.totals.ranked >= card.totals.cap - 5, 'the card\'s ranked total is the capped total (rounding per stat)');
else assert.strictEqual(card.totals.ranked, card.totals.race, 'under the cap: ranked = race');
console.log(`e) cap link: ladder ${g.season.classId} cap ${pw.cap} = card cap ${card.totals.cap} (ranked ${card.totals.ranked} of ${card.totals.race})`);
console.log('quality integration OK');
