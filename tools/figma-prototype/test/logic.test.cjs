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

  // club UI additions: race settlement, missions, login bonus, room conditions, breeding
  const raced = await L.applyRace('web:test:1', 1, 12, { trackId: 'kirameki_turf_2000', style: 'sashi', finishTick: 1800, whips: 3 });
  assert.ok(raced.ok && raced.value.coins === L.master.raceFreeCoinsByPlace.ranked[0], 'race reward from the real table');
  const coinsAfter = (await L.view()).wallet.free;
  await L.applyRace('web:test:1', 1, 12, { trackId: 'kirameki_turf_2000', style: 'sashi', finishTick: 1800, whips: 3 });
  assert.strictEqual((await L.view()).wallet.free, coinsAfter, 'a race settles once');
  const ms = (await L.missions()).value;
  assert.strictEqual(ms.find((m) => m.id === 'win1').progress, 1, 'win counted for the mission');
  assert.ok((await L.claimMission('win1')).ok); assert.strictEqual((await L.claimMission('win1')).code, 'ALREADY_CLAIMED');
  assert.strictEqual((await L.claimMission('race3')).code, 'NOT_ELIGIBLE');
  assert.ok((await L.claimLogin()).ok); assert.strictEqual((await L.claimLogin()).code, 'ALREADY_CLAIMED');
  const room = { trackId: 'aoba_dirt_1400', going: 'soft', night: null, weather: 'rain', temperatureC: 18, windKmh: 5 };
  assert.strictEqual((await L.setRoomConditions(room)).code, 'BAD_REQUEST', 'turf going on a dirt course is rejected');
  assert.ok((await L.setRoomConditions({ ...room, going: 'muddy' })).ok);
  const act = (await L.view()).horses.filter((x) => x.status === 'active');
  const sire = act.find((x) => x.sex === 'male'), dam = act.find((x) => x.sex === 'female');
  assert.strictEqual((await L.breedingPreview(sire.id, dam.id)).code, 'HORSE_NOT_RETIRED');
  assert.ok((await L.retire(sire.id)).ok && (await L.retire(dam.id)).ok);
  const pv = await L.breedingPreview(sire.id, dam.id);
  assert.ok(pv.ok && pv.value.stats.speed.max >= pv.value.stats.speed.min, 'breeding preview');
  const foal = await L.breed(sire.id, dam.id);
  assert.ok(foal.ok && foal.value.foal.sireId === sire.id, 'breeding makes a foal');
  console.log('LOGIC OK');
})().catch((e) => { console.error(e); process.exit(1); });
