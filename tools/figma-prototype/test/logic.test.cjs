// Node check of the browser logic bundle (site/js/logic.js = real server domain code).
// usage: node tools/figma-prototype/test/logic.test.cjs
const path = require('path');
const assert = require('assert');
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
require(path.join(__dirname, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;

(async () => {
  assert.ok((await L.bootstrap()).ok);
  let v = await L.view();
  assert.strictEqual(v.wallet.free, 1200, 'starting free coins');
  assert.strictEqual(v.wallet.paid, 0);

  const t = await L.tutorialDraw();
  assert.ok(t.ok, 'tutorial draw');
  assert.strictEqual(t.value.results.length, 10);
  assert.ok(t.value.results.some((r) => r.rarity === 'SR' || r.rarity === 'SSR'), '10-pull guarantees SR+');
  const t2 = await L.tutorialDraw();
  assert.ok(!t2.ok && t2.code === 'TUTORIAL_GACHA_USED', 'tutorial draw is once-only');

  v = await L.view();
  const h = v.horses[0];
  const bad = await L.nameHorse(h.id, 'abc');
  assert.ok(!bad.ok && bad.code === 'INVALID_NAME', 'non-katakana rejected');
  const ok = await L.nameHorse(h.id, 'しんせいあかつき');
  assert.ok(ok.ok, 'hiragana normalised to katakana');
  assert.strictEqual((await L.view()).horses.find((x) => x.id === h.id).name, 'シンセイアカツキ');

  const d = await L.draw('standard', 10);
  assert.ok(d.ok, 'paid-or-free 10-pull with local coins');
  assert.strictEqual(d.value.pityPoints, 20, 'tutorial + 10 pulls count toward pity');
  assert.strictEqual((await L.view()).wallet.free, 200, '1000 coins spent');
  const poor = await L.draw('standard', 10);
  assert.ok(!poor.ok && poor.code === 'INSUFFICIENT_COINS');

  const odds = L.odds('standard');
  const sum = odds.items.reduce((a, r) => a + r.ppm, 0);
  assert.strictEqual(sum, 1000000, 'odds disclosure sums to 100%');

  const intent = await L.purchaseIntent('coin_160');
  assert.ok(!intent.ok && intent.code === 'AGE_REQUIRED', 'purchase needs age first');

  await L.bootstrap();
  assert.strictEqual((await L.view()).wallet.free, 200, 'starting grant is idempotent');
  console.log('LOGIC OK');
})().catch((e) => { console.error(e); process.exit(1); });
