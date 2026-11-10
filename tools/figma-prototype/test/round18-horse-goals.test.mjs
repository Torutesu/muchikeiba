// Node check of the round 18 per-horse goals paths used by index.html (REQ-HGOAL-*, contracts/protocol.md §53), on the real server
// code bundled into site/js/logic.js: the chain from the partner's aptitudes, progress from confirmed races only, completion once,
// pin (idempotent; a retired horse refused), the home's pinned goal, the horse_goal_near next card, and English for every line.
// usage: node tools/figma-prototype/test/round18-horse-goals.test.mjs
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
const pid = (await L.view()).flags.partnerHorseId;

let v = (await L.horseGoals.view(pid)).value;
assert.ok(v.total >= 6 && v.total <= 8, 'a chain of 6..8 goals');
assert.deepStrictEqual(v.goals.slice(0, 2).map((g) => g.id), ['first_win', 'races:10']);
assert.strictEqual(v.goals.find((g) => g.current).id, 'first_win');
assert.strictEqual(v.doneCount, 0);
assert.match(v.notice, /確定したレース/);

// confirmed races move it: one win, three thirds
assert.ok((await L.horseGoals.demoRaces(pid, [1, 3, 3, 3])).ok);
v = (await L.horseGoals.view(pid)).value;
assert.strictEqual(v.goals[0].done, true);
assert.strictEqual(v.goals[1].have, 4);
assert.strictEqual(v.goals.find((g) => g.kind === 'ranked_top3').have, 4);
assert.ok(v.goals[0].completedAt !== null, 'the first win was recorded with the race');

// pin: idempotent; the home view; the next card when 2 or fewer remain with progress
const p = (await L.horseGoals.pin(pid)).value.pinned;
assert.strictEqual(p.horseId, pid);
assert.strictEqual((await L.horseGoals.pin(pid)).value.pinned.horseId, pid);
assert.strictEqual((await L.horseGoals.pinned()).value.pinned.goal.id, 'races:10');
assert.ok((await L.horseGoals.demoRaces(pid, [5, 6, 7, 8])).ok); // 8 of 10
// higher-priority kinds are closed for today until the goal card shows (the priorities are data, the choice is the server's)
let nx = (await L.nextActions()).value, cards = [];
for (let i = 0; i < 12; i++) {
  cards = [nx.primary, ...nx.chips].filter(Boolean);
  assert.ok(cards.every((c) => c.screen !== 'shop'));
  if (nx.onboarding || cards.some((c) => c.kind === 'horse_goal_near')) break;
  const other = cards.find((c) => c.dismissible && c.kind !== 'horse_goal_near');
  if (!other) break;
  nx = (await L.dismissNext(other.kind)).value;
}
if (!nx.onboarding) assert.ok(cards.some((c) => c.kind === 'horse_goal_near' && c.count === 2 && c.refId === pid && c.screen === 'horse_goals'), 'horse_goal_near: 2 left: ' + JSON.stringify(cards.map((c) => c.kind)));

// English for every goal line (server catalog)
for (const g of v.goals) { const en = L.l10n.translate(g.text); assert.ok(en && !/[぀-ヿ一-鿿]/.test(en), 'English: ' + g.text + ' → ' + en); }

// unpin; a retired horse cannot be pinned
assert.strictEqual((await L.horseGoals.pin(null)).value.pinned, null);
assert.strictEqual((await L.horseGoals.pinned()).value.pinned, null);
assert.ok((await L.roster.retire(pid)).ok);
assert.strictEqual((await L.horseGoals.pin(pid)).code, 'NOT_ELIGIBLE');
v = (await L.horseGoals.view(pid)).value;
assert.strictEqual(v.status, 'retired');
assert.strictEqual(v.goals[0].done, true, 'a retired horse keeps its goals');
console.log('round 18 horse goals: OK');
