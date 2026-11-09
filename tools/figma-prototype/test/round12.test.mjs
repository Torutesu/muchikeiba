// Node check of the round 12 paths used by index.html, on the real server logic bundled for the browser (site/js/logic.js):
//  1) T6 コイン不足の案内 (REQ-SHORT-*, contracts/protocol.md §29): the paid step-up with only free coins → the paid shortfall and
//     the one pack; the refused pull carries the same answer; KPI offer_view / offer_click pass the server's client-event check;
//     after the (demo) purchase the original pull goes through; free-only / not-short answers; no 「倍」「お得」 wording
//  2) R8 gap: bought once-only packs and this season's pass are owned in the per-player list
// usage: node tools/figma-prototype/test/round12.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;

await L.bootstrap();
await L.recordConsent();
const v0 = await L.view();
assert.equal(v0.wallet.paid, 0);
assert.ok(v0.wallet.free >= 1000, 'the prototype player starts with free coins only');

// ---- 1. the paid step-up: free coins do not count
const pre = await L.coinShortfall({ for: 'gacha', bannerId: 'stepup_paid', count: 10 });
assert.ok(pre.ok, JSON.stringify(pre));
const sf = pre.value;
assert.deepEqual([sf.short, sf.coinKind, sf.need, sf.have, sf.shortfall, sf.status], [true, 'paid', 500, 0, 500, 'covered']);
assert.equal(sf.headline, '有償コインが500枚足りません');
assert.equal(sf.offer.productId, 'coin_800');
assert.equal(sf.offer.offerId, 'shortfall');
assert.equal(sf.offer.touchpoint, 'T6');
assert.equal(sf.offer.firstPurchaseBonus.label, L.shopProducts().products.find((p) => p.id === 'coin_800').firstPurchaseBonus.label, 'the bonus line is the shop\'s own');
const words = [sf.headline, sf.line, ...sf.notes, sf.offer.name, sf.offer.firstPurchaseBonus.label, ...sf.offer.contents.map((c) => c.label)];
for (const w of ['倍', 'お得', '今だけ', '残りわずか', '通常価格']) assert.ok(words.every((t) => !t.includes(w)), 'no ' + w);
for (const t of words) assert.ok(L.l10n.translate(t), 'English for ' + t);

const refused = await L.draw('stepup_paid', 10);
assert.equal(refused.code, 'INSUFFICIENT_COINS');
assert.deepEqual(refused.details.shortfall, sf, 'the refused pull carries the same shortfall as the preview');
assert.equal((await L.view()).wallet.free, v0.wallet.free, 'nothing was spent');

// KPI: the sheet's events go through the server's client-event schema (offerId shortfall, trigger T6)
let k = await L.kpi([{ name: 'offer_view', at: L.now(), props: { offerId: 'shortfall', trigger: 'T6' } }]);
assert.ok(k.ok && k.value.accepted === 1, JSON.stringify(k));
k = await L.kpi([{ name: 'offer_click', at: L.now(), props: { offerId: 'shortfall', trigger: 'T6' } }]);
assert.ok(k.ok && k.value.accepted === 1);
assert.deepEqual(L.kpiLog().map((e) => e.name), ['offer_view', 'offer_click']);

// the pack through the purchase confirmation (demo receipt), then the original pull
const bought = await L.demoPurchase(sf.offer.productId);
assert.ok(bought.ok, JSON.stringify(bought));
assert.equal((await L.coinShortfall({ for: 'gacha', bannerId: 'stepup_paid', count: 10 })).value.status, 'not_short');
const pulled = await L.draw('stepup_paid', 10);
assert.ok(pulled.ok, JSON.stringify(pulled));
assert.equal(pulled.value.results.length, 10);
assert.equal(pulled.value.spent.paid, 500);
// the pack's first-purchase bonus is used now: the next offer of it says nothing about a bonus
const again = await L.coinShortfall({ for: 'coins', coins: (await L.view()).wallet.paid + 400, kind: 'paid' });
assert.equal(again.value.offer.productId, 'coin_800');
assert.equal(again.value.offer.firstPurchaseBonus, null);

// cosmetics: a paid-only item counts paid coins; enough coins → not short
const gold = await L.coinShortfall({ for: 'cosmetic', itemId: 'decor_golden_horseshoe' });
assert.equal(gold.value.coinKind, 'paid');
assert.equal((await L.coinShortfall({ for: 'cosmetic', itemId: 'decor_flower_box' })).value.short, false);

// ---- 2. R8 gap: what the player bought is owned in the per-player list
await L.demoPurchase('starter_pack');
await L.demoPurchase('season_pass');
const mine = Object.fromEntries((await L.myShopProducts()).products.map((p) => [p.id, p]));
assert.equal(mine.starter_pack.owned, true);
assert.equal(mine.season_pass.owned, true);
assert.equal(mine.season_pass.purchasedThisSeason, true);
assert.equal(mine.season_pass_plus.owned, true, 'one pass per season');
assert.equal(mine.coin_800.owned, false, 'coin packs are never owned');
// a bought once-only bundle is never the shortfall's pack
for (const n of [250, 300, 5000]) assert.notEqual((await L.coinShortfall({ for: 'coins', coins: (await L.view()).wallet.paid + n, kind: 'paid' })).value.offer?.productId, 'starter_pack');
console.log('round 12 logic OK (coin shortfall T6, bought packs owned)');
