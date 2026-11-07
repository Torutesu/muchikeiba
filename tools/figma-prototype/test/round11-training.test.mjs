// Node check of the round 11 training paths used by index.html (REQ-TRAIN-*, contracts/protocol.md §25), on the real server
// code bundled into site/js/logic.js: the view, a session with taps on every beat (re-scored on the server rules), the
// anti-cheat refusal of taps "from the future", skip, the daily mission's apple, the item, and the ranked line.
// usage: node tools/figma-prototype/test/round11-training.test.mjs
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
const hid = (await L.view()).horses[0].id;

let v = await L.training();
assert.ok(v.ok && v.value.enabled, 'training view loads');
assert.strictEqual(v.value.slotsLeft, 3);
assert.deepStrictEqual(v.value.menus.map((m) => m.id), ['hill', 'wood', 'pool', 'awase']);
assert.deepStrictEqual(v.value.rules, { rankedNormalized: true, fatigueAffectsRaces: false, inherited: false, paidBoosts: false });

// a session: taps "from the future" are refused (the server knows only ~0 ms passed), then a real run after the duration
const s = await L.trainingStart(hid, 'hill');
assert.ok(s.ok, 'start');
const beats = s.value.session.beats;
const early = await L.trainingFinish(s.value.session.sessionId, beats);
assert.strictEqual(early.ok, false);
assert.strictEqual(early.code, 'TRAINING_INPUT_INVALID');
L.setClockMs(L.now() + 7000);
const f = await L.trainingFinish(s.value.session.sessionId, beats.map((b) => b + 10));
assert.ok(f.ok, 'finish');
assert.strictEqual(f.value.grade, 'great');
assert.strictEqual(f.value.timing.perfect, 5);
assert.ok(f.value.total > 0 && f.value.trainedTotal === f.value.total);
assert.ok((await L.view()).horses[0].trained.burst > 0, 'growth is stored on the horse');

// skip: no mini-game bonus
const s2 = await L.trainingStart(hid, 'pool');
const f2 = await L.trainingFinish(s2.value.session.sessionId, [], true);
assert.ok(f2.ok && f2.value.settled === 'skipped' && f2.value.timing.score === 0);
assert.strictEqual(f2.value.training.slotsLeft, 1);
assert.strictEqual((await L.trainingStart(hid, 'wood')).code, 'TRAINING_LIMIT', 'two sessions per horse a day');

// the daily mission's apple relieves fatigue
const ms = await L.missions();
const m = ms.value.find((x) => x.kind === 'training');
assert.ok(m && m.progress >= 1);
assert.ok((await L.claimMission(m.id)).ok);
const u = await L.trainingUseItem('training_apple', hid);
assert.ok(u.ok && u.value.fatigue < u.value.fatigueBefore);

// the ranked line: total and the class cap
const rs = L.trainingRaceStats(hid);
assert.ok(rs.total > 0 && rs.cap > 0 && rs.ranked === Math.min(rs.total, rs.cap));
console.log('round 11 training: OK');
