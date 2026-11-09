// Node check of the round 12 rival paths used by index.html (REQ-RIVAL-*, contracts/protocol.md §28), on the real server code
// bundled into site/js/logic.js: this week's pairing with the demo rival (public card only), head to head from the same
// confirmed race on both sides, a challenge race that never scores, the time-attack tiebreak, the week result with its fixed
// reward and title (once), opt-out and block.
// usage: node tools/figma-prototype/test/round12-rival.test.mjs
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

await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');
// a Tuesday noon JST, after the 04:00 rollover switch
L.setClockMs(Date.UTC(2026, 11, 8, 3));

let v = await L.rival.view();
assert.ok(v.ok && v.value.enabled, 'rival view loads');
assert.strictEqual(v.value.rival.kind, 'human', 'paired with the demo candidate of last week');
assert.strictEqual(v.value.rival.card.displayName, 'ミドリカワ');
assert.deepStrictEqual(Object.keys(v.value.rival.card).sort(), ['classId', 'displayName', 'partner', 'silks', 'titleId'], 'the public card only');
assert.deepStrictEqual(v.value.score, { me: 0, them: 0, rankedRaces: 0, minRaces: 3, taMe: 0, taThem: 0 });

for (const [a, b] of [[1, 3], [2, 5], [6, 4]]) assert.ok((await L.rival.demoRace(a, b)).ok);
await L.rival.demoRace(1, 2, 'friend'); // ライバルと走る: shown, never scores
v = await L.rival.view();
assert.deepStrictEqual([v.value.score.me, v.value.score.them, v.value.score.rankedRaces], [2, 1, 3]);
assert.strictEqual(v.value.recent[0].mode, 'friend');
assert.strictEqual(v.value.recent[0].point, null);

const c = await L.rival.challenge();
assert.ok(c.ok && c.value.rivalId === 'demo_rv_1', 'challenge goes to this week\'s rival');

await L.rival.demoTa('aoba_turf_1600', 70_000, 70_800);
v = await L.rival.view();
assert.deepStrictEqual(v.value.timeAttack.map((t) => [t.trackId, t.faster]), [['aoba_turf_1600', 'me']]);

// the week ends: a fixed reward once, the first rival title, the sheet until seen
const free0 = (await L.view()).wallet.free;
L.rival.demoWeekEnd();
v = await L.rival.view();
assert.strictEqual(v.value.result.outcome, 'win');
assert.strictEqual(v.value.result.freeCoins, 20);
assert.deepStrictEqual(v.value.result.newTitles, ['rival_first']);
assert.strictEqual((await L.view()).wallet.free - free0, 20, 'paid in free coins');
await L.rival.view();
assert.strictEqual((await L.view()).wallet.free - free0, 20, 'never paid twice');
await L.rival.seen(v.value.result.weekId);
assert.strictEqual((await L.rival.view()).value.result, null, 'the sheet is shown once');

// block → dissolved; opt out → no rival
assert.ok((await L.rival.block()).ok);
v = await L.rival.view();
assert.strictEqual(v.value.rival.dissolved, true);
assert.strictEqual(v.value.rival.card, null);
assert.ok((await L.rival.optOut(true)).ok);
v = await L.rival.view();
assert.strictEqual(v.value.optOut, true);
assert.strictEqual(v.value.rival, null);
console.log('round12 rival checks ok');
