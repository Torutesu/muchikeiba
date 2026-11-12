// Node check of the round 22 self limits used by index.html (REQ-LIMIT-*, contracts/protocol.md §67), on the real server code bundled
// into site/js/logic.js: nothing set at first (read-only), a lower amount at once, a raise waiting with its cancel, the purchase
// confirmation refused with its details, the shortfall never offering a pack over the limit, the play-time settings and the shared
// reminder rule (never mid-race, the calm sheet at a safe point), and no shop / urgency words.
// usage: node tools/figma-prototype/test/round22-self-limits.test.mjs
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
const S = L.selfLimits;

await L.bootstrap();
let v = (await S.view()).value;
assert.strictEqual(v.spending.limitYen, null);
assert.strictEqual(v.playtime.enabled, false, 'the reminder is off by default');
await L.setAge(1990, 1, false);
let r = await S.setSpending(1000);
assert.strictEqual(r.value.applied, 'now');
r = await S.setSpending(5000);
assert.strictEqual(r.value.applied, 'pending');
assert.match(r.value.view.spending.pendingText, /から効きます（取り消せます）/);
assert.strictEqual(r.value.view.spending.limitYen, 1000);
assert.strictEqual((await S.cancel()).value.applied, 'cancelled');
assert.strictEqual((await S.setSpending(2550)).code, 'BAD_REQUEST');

// the refused confirmation (own ¥3,000, ¥2,400 spent)
await S.seedDemo();
const pi = await L.purchaseIntent('coin_800');
assert.strictEqual(pi.ok, false);
assert.strictEqual(pi.code, 'SELF_LIMIT_EXCEEDED');
assert.deepStrictEqual({ ...pi.details, month: undefined }, { selfLimitYen: 3000, monthSpentYen: 2400, priceYen: 800, month: undefined, settings: 'self_limits' });
assert.strictEqual((await L.purchaseIntent('coin_480')).ok, true);
const sf = (await L.coinShortfall({ for: 'coins', coins: 99999, kind: 'any' })).value;
assert.ok(!sf.offer || sf.offer.priceYen <= 600, 'the shortfall never offers a pack over the own limit: ' + sf.offer?.productId);

// play-time
assert.ok((await S.setPlaytime({ sessionMin: 60 })).ok);
assert.strictEqual((await S.setPlaytime({ sessionMin: 45 })).code, 'BAD_REQUEST');
const snap = (o) => ({ now: Date.UTC(2026, 10, 10, 11), localOffsetMin: 540, locale: 'ja', settings: { sessionMin: 60, dailyMin: null, quietAfterHour: null }, sessionPlayedMin: 61, dayPlayedMin: 61, marks: { sessionMark: null, dayKey: null, dailyShown: false, quietShown: false }, place: 'home', ...o });
assert.strictEqual(S.decide(snap({ place: 'race' })).show, false, 'never mid-race');
const d = S.decide(snap());
assert.strictEqual(d.show, true);
assert.strictEqual(d.title, 'ひと息つきませんか');
assert.ok(!/今だけ|残りわずか|お得|倍|ショップ|あと1回|もう少し/.test([d.title, ...d.lines, d.note].join('')), 'calm wording');
assert.strictEqual(S.decide(snap({ locale: 'en' })).buttons.stop, 'Done for today');
await S.setPlaytime({ sessionMin: null });
console.log('round 22 self limits: OK');
