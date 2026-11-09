// Node check of the round 13 history paths used by index.html (REQ-HIST-*, contracts/protocol.md §33), on the real server
// code bundled into site/js/logic.js: the demo month (age-limited player, two packs, one refunded, scouts), the balance
// header with 有償 / 無償 apart, each tab, paging by the cursor, the 問い合わせ draft, and English with nothing left in Japanese.
// usage: node tools/figma-prototype/test/round13-history.test.mjs
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
const JP = /[぀-ヿ㐀-鿿]/;

await L.bootstrap();
await L.seedHistory();
const v = await L.view();

const sum = await L.history('summary');
assert.ok(sum.ok, 'summary loads');
assert.deepStrictEqual([sum.value.wallet.paid, sum.value.wallet.free], [v.wallet.paid, v.wallet.free], 'header: paid and free apart, same as the wallet');
assert.strictEqual(sum.value.ageLimited, true, 'the demo player has an age limit');
assert.strictEqual(sum.value.monthlyLimitYen, 5000);
assert.match(sum.value.limitText, /^今月の購入 ¥[\d,]+ ／ 上限 ¥5,000/);

const pur = await L.history('purchases', { limit: 7 });
assert.ok(pur.ok);
assert.deepStrictEqual(pur.value.items.map((p) => p.status), ['completed', 'refunded'], 'the refunded pack reads as 返金済み');
assert.ok(pur.value.items.every((p) => /^P-[0-9A-F]{8}$/.test(p.ref)), 'purchase references never show the transaction id');
assert.ok(!JSON.stringify(pur.value).includes('proto_h_'), 'no store transaction id in the list');

const paid = await L.history('coins', { currency: 'paid', limit: 3 });
assert.ok(paid.ok && paid.value.items.every((r) => r.currency === 'paid'), 'paid tab: paid coins only');
assert.ok(paid.value.items.some((r) => r.category === 'gacha' && r.direction === 'spent'), 'the scout spent paid coins first');
assert.ok(paid.value.nextCursor, 'more than one page of paid rows');
const paid2 = await L.history('coins', { currency: 'paid', limit: 3, cursor: paid.value.nextCursor });
assert.ok(paid2.ok && paid2.value.items.length > 0 && paid2.value.items.every((r) => !paid.value.items.some((x) => x.ref === r.ref)), 'the next page has new rows only');
const free = await L.history('coins', { currency: 'free', limit: 50 });
assert.ok(free.ok && free.value.items.every((r) => r.currency === 'free'), 'free tab: free coins only');
assert.ok(free.value.items.some((r) => r.category === 'refund'), 'the first-purchase extra was taken back on the refund');

const g = await L.history('gacha');
assert.ok(g.ok && g.value.items.length >= 2, 'gacha tab: the scouts');
assert.ok(g.value.items.some((x) => x.count === 10 && x.coins.paid + x.coins.free === 1000 && x.results.length === 10), 'a 10-scout with its results and coins used');

const t = await L.historyTicket([pur.value.items[1].ref, paid.value.items[0].ref], 'refund');
assert.ok(t.ok, 'the 問い合わせ draft');
assert.deepStrictEqual(Object.keys(t.value).sort(), ['body', 'createdAt', 'format', 'items', 'playerId', 'topic', 'topicText']);
assert.strictEqual((await L.historyTicket(['P-00000000'], 'refund')).code, 'NOT_FOUND', 'an unknown reference is refused');

// English: every text of the lists is translated by the same catalog the EN toggle uses
const texts = [sum.value.limitText, sum.value.notice, pur.value.note, ...pur.value.items.flatMap((p) => [p.product, p.statusText, p.storeName]),
  ...paid.value.items.map((r) => r.title), ...free.value.items.map((r) => r.title), ...g.value.items.flatMap((x) => [x.banner, x.viaText, x.summary]), t.value.topicText, t.value.body,
  ...t.value.items.flatMap((i) => [i.title, i.detail])];
const missing = texts.filter((s) => s && JP.test(L.l10n.translate(s) ?? s));
assert.deepStrictEqual(missing, [], 'every history text has English');
console.log(`round 13 history: ${pur.value.items.length} purchases, ${paid.value.items.length + paid2.value.items.length}+ paid rows, ${free.value.items.length} free rows, ${g.value.items.length} scouts, ticket ${t.value.items.length} refs — OK`);
