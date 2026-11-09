// Node check of the round 13 team goal paths used by index.html (REQ-TGOAL-*, contracts/protocol.md §32), on the real
// server code bundled into site/js/logic.js: the demo team's week (goal from the table, milestones, my contribution),
// contributions only from settled races with the per-member daily cap, a milestone item in the team feed, the week close
// on the clock paying the reached tier once, and the English of the label (names are never translated).
// usage: node tools/figma-prototype/test/round13-team-goal.test.mjs
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
const team = await L.teamDemo();
assert.ok(team.teamId, 'joined the demo team');

let v = await L.teamGoal();
assert.ok(v.ok && v.value.current, 'the week is open');
const w0 = v.value.current;
assert.ok(['races_sum', 'wins_sum', 'ta_pb_sum'].includes(w0.goalId));
assert.strictEqual(w0.milestones.length, 3);
assert.ok(w0.milestones[0].target < w0.milestones[1].target && w0.milestones[1].target < w0.milestones[2].target, 'ascending milestones');
assert.strictEqual(v.value.teamName, team.name);

// my settled races count (for a races goal: 1 each, at most the daily cap; nothing for a TA goal)
await L.teamGoalMyRaces(12);
v = await L.teamGoal();
const w1 = v.value.current;
if (w1.kind === 'races') {
  assert.strictEqual(w1.my.contribution, 10, 'the per-member daily cap (10 races)');
  assert.strictEqual(w1.my.today, 10);
  assert.ok(w1.my.qualified);
}
assert.ok(w1.my.contribution <= w1.my.dailyCap);

// teammates play until a milestone is reached → one goal item in the team feed
for (let d = 0; d < 6 && (await L.teamGoal()).value.current.tier < 1; d++) {
  L.setClockMs(L.now() + 86_400_000);
  await L.teamGoalActivity(10);
  await L.teamGoalMyRaces(10);
}
v = await L.teamGoal();
assert.ok(v.value.current.tier >= 1, 'a milestone was reached: ' + JSON.stringify(v.value.current.progress));
const feed = await L.teamFeed();
const goals = feed.value.items.filter((x) => x.kind === 'goal');
assert.ok(goals.length >= 1 && goals[0].goal.tier >= 1 && goals[0].playerId === '', 'a goal item (team item, no author) is in the feed');
assert.strictEqual(new Set(goals.map((x) => x.goal.tier)).size, goals.length, 'each tier once');
const report = await L.reportFeed(goals[0].seq, 'spam');
assert.strictEqual(report.ok, false, 'a goal item cannot be reported');

// the week closes on the clock: the reached tier's fixed reward, once
const tier = v.value.current.tier;
const before = (await L.view()).wallet.free;
v = await L.teamGoalCloseWeek();
assert.ok(v.ok && v.value.lastWeek, 'last week result');
assert.strictEqual(v.value.lastWeek.tier, tier);
const mine = v.value.lastWeek;
const after = (await L.view()).wallet.free;
if (mine.eligible) {
  assert.ok(mine.paid, 'paid');
  assert.strictEqual(after - before, mine.reward.freeCoins, 'free coins of the tier');
}
const again = await L.teamGoalCloseWeek();
assert.strictEqual((await L.view()).wallet.free, after, 'closing again pays nothing more');
assert.ok(again.value.current && again.value.current.week > mine.week, 'the next week is open');

// English: the label translates (master template); the team name stays as typed
assert.match(L.l10n.translate(w0.label) ?? '', /as a branch$/);
assert.strictEqual(L.l10n.translate('支部の共同目標が2段目に到達しました'), 'Your branch reached milestone 2 of the weekly goal');
console.log(`round 13 team goal: OK (${w0.label} → tier ${tier}, reward ${JSON.stringify(mine.reward)})`);
