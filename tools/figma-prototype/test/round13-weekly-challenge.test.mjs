// Node check of the round 13 weekly challenge paths used by index.html (REQ-WCH-*, contracts/protocol.md §31), on the real
// server code bundled into site/js/logic.js: this week's view, a start with the loan horse (challenge config, the cap, no
// skills), the submit path (the logic builds the replay log from the ISSUED config and asks `verify` to re-simulate it —
// in the page that is the WASM verifier), a verdict that comes only from the verified result, the reward once a week, a
// hash mismatch, and a style the own horse does not have.
// usage: node tools/figma-prototype/test/round13-weekly-challenge.test.mjs
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
const partner = (await L.view()).horses[0];

const v = await L.weeklyChallenges();
assert.ok(v.ok && v.value.enabled, 'the week loads');
assert.strictEqual(v.value.challenges.length, 3);
assert.deepStrictEqual(v.value.rules, { statCap: 3200, normalized: true, skills: false, loanAtCap: true, paidBoosts: false, rewardOncePerWeek: true });
assert.ok(v.value.endsAt > v.value.serverNow && v.value.next && v.value.next.challenges.length === 3, 'a real week end and next week\'s preview');
for (const c of v.value.challenges) assert.ok(c.labels.length > 0 && c.loan && c.loan.statTotal === 3200, 'condition lines and a loan horse at the cap');

// the challenge with a place condition (the verdict below depends on the verified place)
const ch = v.value.challenges.find((c) => c.conditions.maxPlace !== undefined) ?? v.value.challenges[0];
const st = await L.weeklyChallengeStart(ch.id, null);
assert.ok(st.ok, 'start with the loan horse');
const s = st.value;
assert.strictEqual(s.config.mode, 'challenge');
const me = s.config.entrants[s.playerSlot];
assert.strictEqual(me.kind, 'human');
assert.strictEqual(['speed', 'stamina', 'burst', 'guts', 'temper'].reduce((a, k) => a + me.horse[k], 0), 3200, 'the loan horse races exactly at the cap');
assert.ok(s.config.entrants.every((e) => !e.horse.skill), 'no skills in a challenge');

// a verifier stand-in that re-simulates "the log it is given": the player finishes at `place`; it checks the log is the
// one built from the issued config of that session
const verifier = (session, place, hash = 'c'.repeat(64)) => (logJson) => {
  const log = JSON.parse(logJson);
  assert.deepStrictEqual(log.config, session.config, 'the log is built from the issued config');
  const slot = log.config.entrants.findIndex((e) => e.kind === 'human');
  const others = log.config.entrants.map((e) => e.slot).filter((x) => x !== slot);
  const order = [...others.slice(0, place - 1), slot, ...others.slice(place - 1)];
  return JSON.stringify({ resultHash: hash, order, finishTicks: order.map((_, i) => 1200 + i * 4), finishFracs: order.map(() => 0), checksums: {} });
};
const gate = (x) => [[Number(x.config.ruleset.gateOpenTick), x.playerSlot, 1]];
// the device claims a clear, but the server's re-simulation puts the horse last: failed
const lost = await L.weeklyChallengeSubmit(s.sessionId, gate(s), 'c'.repeat(64), verifier(s, s.config.entrants.length));
assert.ok(lost.ok && !lost.value.cleared && lost.value.reward === null, 'the verdict comes from the verified result only');

const material0 = (await L.view()).items.breeding_material ?? 0;
const s2 = (await L.weeklyChallengeStart(ch.id, null)).value;
const won = await L.weeklyChallengeSubmit(s2.sessionId, gate(s2), 'c'.repeat(64), verifier(s2, 1));
assert.ok(won.ok, 'submit ' + JSON.stringify(won));
if (ch.conditions.maxTimeMs === undefined) {
  assert.ok(won.value.cleared && won.value.firstClear, 'a verified win clears');
  const pays = (ch.reward.items ?? []).reduce((a, i) => a + i.qty, 0);
  assert.strictEqual(((await L.view()).items.breeding_material ?? 0) - material0, pays, 'the reward once');
}
// the same session again returns the stored result (idempotent, no second verification)
const again = await L.weeklyChallengeSubmit(s2.sessionId, gate(s2), 'c'.repeat(64), () => { throw new Error('must not verify again'); });
assert.ok(again.ok && again.value.sessionId === s2.sessionId);

// a hash the server cannot reproduce
const s3 = (await L.weeklyChallengeStart(ch.id, null)).value;
const bad = await L.weeklyChallengeSubmit(s3.sessionId, gate(s3), 'd'.repeat(64), verifier(s3, 1, 'e'.repeat(64)));
assert.strictEqual(bad.code, 'CHALLENGE_RESULT_MISMATCH');

// a style condition the partner does not meet
const styled = v.value.challenges.find((c) => c.conditions.style && c.conditions.style !== partner.style);
if (styled) assert.strictEqual((await L.weeklyChallengeStart(styled.id, partner.id)).code, 'CHALLENGE_HORSE_INELIGIBLE');
console.log('round 13 weekly challenge: OK');
