// Node check of the round 13 event exchange paths used by index.html (REQ-EXCH-*, contracts/protocol.md §30), on the real
// server code bundled into site/js/logic.js: event races earn points (place + participation, daily cap), the view, a keyed
// exchange with stock, the grace days after the event and the leftover conversion at the close.
// usage: node tools/figma-prototype/test/round13-exchange.test.mjs
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
const ev = L.exchangeEventId();
assert.ok(ev, 'an event with an exchange exists');

// during the event
assert.strictEqual(L.exchangeDemo('open'), ev);
let v = await L.exchange(ev);
assert.ok(v.ok && v.value.status === 'open' && v.value.points === 0, 'the exchange is open with no points');
assert.deepStrictEqual(v.value.rules, { purchasable: false, random: false, completionReward: false, sources: ['event_race'] });
const win = v.value.earn.byPlace[0] + v.value.earn.participation;
const r1 = await L.eventDemoRace(ev, 1);
assert.ok(r1.ok && r1.value.gained === win, 'a win earns byPlace[0] + participation');
for (let i = 0; i < 6; i++) await L.eventDemoRace(ev, 1);
v = await L.exchange(ev);
assert.strictEqual(v.value.points, v.value.earn.dailyCap, 'the daily cap holds');
assert.strictEqual(v.value.earn.remainingToday, 0);
const list = await L.events();
assert.strictEqual(list.value.find((e) => e.id === ev).exchange.points, v.value.earn.dailyCap, 'the event list carries the point counter');

// a keyed exchange: price and stock
const mat = v.value.items.find((x) => x.kind === 'material');
const b = await L.exchangeBuy(ev, mat.id, 1);
assert.ok(b.ok && b.value.spent === mat.price && b.value.remaining === mat.stock - 1, 'exchange spends the price and takes one from the stock');
const horse = v.value.items.find((x) => x.kind === 'horse');
const nope = await L.exchangeBuy(ev, horse.id, 1);
assert.strictEqual(nope.ok, false);
assert.strictEqual(nope.code, 'INSUFFICIENT_POINTS');

// after the event: grace (exchange only), then closed with the leftover converted into material
L.exchangeDemo('grace');
v = await L.exchange(ev);
assert.strictEqual(v.value.status, 'grace');
assert.strictEqual(v.value.earn.remainingToday, 0, 'no points after the event');
const left = v.value.points;
assert.strictEqual(v.value.leftover.preview, Math.ceil(left / v.value.leftover.pointsPerUnit));
L.exchangeDemo('closed');
v = await L.exchange(ev);
assert.strictEqual(v.value.status, 'closed');
assert.deepStrictEqual({ points: v.value.leftover.converted.points, qty: v.value.leftover.converted.qty }, { points: left, qty: Math.ceil(left / v.value.leftover.pointsPerUnit) });
assert.strictEqual(v.value.points, 0);
const closed = await L.exchangeBuy(ev, mat.id, 1);
assert.strictEqual(closed.code, 'EXCHANGE_CLOSED');
L.exchangeDemo(null);
console.log('round 13 exchange: points by race with the daily cap, keyed exchange with stock, grace and the leftover conversion OK');
