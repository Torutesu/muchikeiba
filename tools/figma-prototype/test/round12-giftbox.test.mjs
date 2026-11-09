// Node check of the round 12 gift box paths used by index.html (REQ-BOX-*, contracts/protocol.md §26), on the real server
// code bundled into site/js/logic.js: the starting balance received at boot, the demo box (compensation, prize, no-expiry,
// expiring soon; history with a received and an expired gift), claim one, claim all, the badge, no paid coins.
// usage: node tools/figma-prototype/test/round12-giftbox.test.mjs
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
let p = await L.view();
assert.strictEqual(p.wallet.free, 1200, 'the starting balance went through the box and was received at boot');
assert.deepStrictEqual(p.giftBox, { unclaimed: 0, expiringSoon: 0 });
await L.bootstrap(); // a second boot does not pay again
assert.strictEqual((await L.view()).wallet.free, 1200);

L.reset();
const box = await L.seedGifts();
assert.strictEqual(box.total, 4);
assert.deepStrictEqual(box.entries.map((e) => e.source), ['ops_grant', 'tournament', 'ops_compensation', 'ops_grant']);
assert.strictEqual(box.entries[3].expiresAt, null, 'the thank-you gift never expires');
assert.ok(box.entries.every((e) => !('paidCoins' in e.contents)), 'no paid coins in the box');
assert.deepStrictEqual((await L.view()).giftBox, { unclaimed: 4, expiringSoon: 1 });
const hist = await L.giftBox('history');
assert.deepStrictEqual(hist.value.entries.map((e) => e.status).sort(), ['claimed', 'claimed', 'expired']);

const free0 = (await L.view()).wallet.free;
const one = await L.giftClaim(box.entries[1].giftId);
assert.ok(one.ok && one.value.totals.freeCoins === 150 && one.value.totals.items.breeding_material === 2, 'claim one');
assert.strictEqual((await L.giftClaim(box.entries[1].giftId)).code, 'ALREADY_CLAIMED');
const all = await L.giftClaimAll();
assert.ok(all.ok && all.value.claimed.length === 3 && all.value.held.length === 0, 'claim all');
assert.strictEqual((await L.view()).wallet.free - free0, 500);
assert.strictEqual((await L.view()).wallet.paid, 0);
assert.deepStrictEqual((await L.view()).giftBox, { unclaimed: 0, expiringSoon: 0 });
console.log('round 12 gift box: OK');
