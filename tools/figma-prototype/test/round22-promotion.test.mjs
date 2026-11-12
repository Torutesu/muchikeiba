// Node check of the round 22 promotion series paths used by index.html (REQ-PROMO-*, contracts/protocol.md §68), on the real
// server code bundled into site/js/logic.js: the series starts on the race that reaches the line (not counted), two top-3
// pass it (pips, no further series), two misses fail it (setback), the ack is idempotent, the kill switch hides it, nothing is
// granted, and the prototype's English covers the sheet texts.
// usage: node tools/figma-prototype/test/round22-promotion.test.mjs
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

await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');
const wallet = (await L.view()).wallet;

// just below the line: no series yet
assert.ok((await L.promotion.demo('near')).ok);
let v = (await L.promotion.view()).value;
assert.strictEqual(v.enabled, true);
assert.strictEqual(v.series, null);
assert.deepStrictEqual(v.rules, { races: 3, needTop: 2, topPlace: 3, setbackPoints: 40, graceRaces: 10 });

// the race that reaches the line starts it (not counted)
await L.promotion.demo('start');
v = (await L.promotion.view()).value;
assert.deepStrictEqual([v.series.status, v.series.pips, v.series.next], ['active', ['open', 'open', 'open'], 1]);

// one top-3 → 「昇級戦 2/3」
await L.promotion.demo('one');
v = (await L.promotion.view()).value;
assert.deepStrictEqual([v.series.pips, v.series.next], [['top', 'open', 'open'], 2]);

// passed: two top-3, decided early, then the ack (idempotent)
await L.promotion.demo('passed');
v = (await L.promotion.view()).value;
assert.deepStrictEqual([v.series.status, v.series.pips, v.passedThisSeason, v.series.seen], ['passed', ['top', 'top', 'skip'], true, false]);
assert.ok((await L.promotion.ack(v.series.id)).ok);
assert.ok((await L.promotion.ack(v.series.id)).ok);
assert.strictEqual((await L.promotion.view()).value.series.seen, true);

// failed: two misses → the setback to line − 40
await L.promotion.demo('failed');
v = (await L.promotion.view()).value;
assert.strictEqual(v.series.status, 'failed');
assert.strictEqual(v.series.setbackTo, v.line - 40);
assert.strictEqual(v.points, v.line - 40);
assert.ok(v.earned > v.points, 'the season missions still count the points earned');

// the grace window and the kill switch
await L.promotion.demo('grace');
assert.deepStrictEqual((await L.promotion.view()).value.grace, { classId: v.classId, racesLeft: 7 });
await L.promotion.demo('off');
v = (await L.promotion.view()).value;
assert.deepStrictEqual([v.enabled, v.series, v.grace], [false, null, null]);
await L.promotion.demo('near');

// nothing is granted by the series (the demo races are ranked results: their coins are the race's own, not the series')
const after = (await L.view()).wallet;
assert.strictEqual(after.paid, wallet.paid, 'no paid coins');

// English for the prototype's sheet texts
const en = JSON.parse(readFileSync(join(here, '..', 'logic', 'proto-en.json'), 'utf8')).strings;
for (const k of ['昇級戦　/　突破', '昇級戦　/　届かず', '一閃、届いた。', '次の一閃で取り返せ。']) assert.ok(en[k], 'English for ' + k);
console.log('round22 promotion: OK');
