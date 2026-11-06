// Node check of the round 10 invite paths used by unity.html (REQ-INV-*, contracts/protocol.md §18), on the real server
// code bundled into site/js/logic.js: my code and share links, demo friends redeeming it (directory lookup, device claim,
// inviter + invitee steps), milestone rewards through the invitee's outbox, entering another player's code, reset.
// usage: node tools/figma-prototype/test/round10-invite.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
// like the browser's Storage: Object.keys(localStorage) lists the stored keys (reset() walks them)
const store = {};
Object.defineProperties(store, {
  getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
  setItem: { value: (k, v) => { store[k] = String(v); } },
  removeItem: { value: (k) => { delete store[k]; } },
});
globalThis.localStorage = store;
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;
const I = L.invite;

await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');

let v = await I.view();
assert.ok(v.ok, 'invite view loads');
const code = v.value.code;
assert.match(code, /^[23456789BCDFGHJKMNPQRSTVWXZ]{8}$/);
assert.strictEqual(v.value.displayCode, I.display(code));
assert.strictEqual(v.value.share.deepLink, `muchi://invite/${code}`);
assert.ok(v.value.share.text.includes(v.value.displayCode) && !/コイン|円/.test(v.value.share.text), 'share text: code, link, no amounts');
assert.strictEqual((await I.view()).value.code, code, 'the code is stable');
assert.deepStrictEqual(v.value.milestones.map((m) => [m.id, m.rewardYen]), [['im_graduate', 160], ['im_class_b', 160]]);
assert.ok(v.value.milestones.every((m) => m.rewardYen <= 200), '景品表示法: each grant ≤ ¥200');
assert.strictEqual(v.value.cap, 10);
assert.strictEqual(I.normalize(v.value.displayCode.toLowerCase()), code);
assert.strictEqual(I.normalize('ABCDEFGH'), null);

// demo friends join with my code: they become friends, nothing is paid for the install
const before = (await L.view()).wallet.free;
const j1 = await I.demoFriendJoins();
assert.ok(j1.ok && j1.value.result.status === 'redeemed' && j1.value.result.friended, 'friend 1 redeemed my code');
const j2 = await I.demoFriendJoins();
assert.ok(j2.ok && j2.value.id === 'demo_inv_2');
v = await I.view();
assert.deepStrictEqual(v.value.invitees.map((x) => x.displayName), ['ハヤテ', 'サクラ']);
assert.strictEqual(v.value.counted, 2);
assert.strictEqual((await L.view()).wallet.free, before, 'no reward for installs');

// milestones: paid once each through the outbox
const g = await I.demoMilestone('im_graduate');
assert.ok(g.ok && g.value.delivered === 1 && g.value.freeCoinsGained === 100, 'beginner missions done → +100 free coins');
const tickets = (await L.view()).items.gacha_ticket ?? 0;
const b = await I.demoMilestone('im_class_b');
assert.ok(b.ok && b.value.delivered === 1, 'class B → delivered');
assert.strictEqual((await L.view()).items.gacha_ticket, tickets + 1, '…a scout ticket');
v = await I.view();
assert.deepStrictEqual(v.value.invitees[0].milestones.map((m) => [m.id, m.rewarded]), [['im_graduate', true], ['im_class_b', true]]);
assert.strictEqual((await L.view()).wallet.paid, 0, 'never paid coins');

// entering another player's code (the local player is on day 1, after the FTUE)
assert.strictEqual(v.value.redeem.eligible, true);
const other = await I.demoInviterCode();
const bad = await I.redeem(other.slice(0, -1) + (other.endsWith('B') ? 'C' : 'B'));
assert.ok(!bad.ok && bad.code === 'INVITE_CODE_INVALID', 'typo → INVITE_CODE_INVALID');
const self = await I.redeem(v.value.displayCode);
assert.ok(!self.ok && self.code === 'INVITE_SELF', 'own code refused');
const t0 = (await L.view()).items.gacha_ticket ?? 0;
const r = await I.redeem(other.toLowerCase());
assert.ok(r.ok && r.value.status === 'redeemed' && r.value.inviter.displayName === 'ミナトの騎手', 'redeemed the demo inviter code');
assert.strictEqual((await L.view()).items.gacha_ticket, t0 + 1, 'welcome gift: 1 scout ticket');
v = await I.view();
assert.strictEqual(v.value.redeem.reason, 'already_redeemed');
const again = await I.redeem(other);
assert.ok(!again.ok && again.code === 'INVITE_ALREADY_REDEEMED');

// reset clears the demo players and the directory
L.reset();
assert.ok(!Object.keys(store).some((k) => k.startsWith('muchi.proto.player:demo_')), 'demo players removed');
await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');
v = await I.view();
assert.ok(v.ok && v.value.invitees.length === 0 && v.value.redeem.eligible, 'fresh after reset');
assert.ok((await I.demoFriendJoins()).ok, 'demo friends can join again after reset');
console.log('round 10 invite: ok');
