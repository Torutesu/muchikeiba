// Node check of the round 17 help center paths used by index.html (REQ-HELP-*, contracts/protocol.md §48), on the real
// server code bundled into site/js/logic.js: the index in both languages, contextual links, an article with numbers from
// the same data as the rates screen, search with the Japanese fold, a vote, an inquiry kept to one ticket per form key,
// the ops reply (answered, unread, the activity entry) and English with only typed text left in Japanese.
// usage: node tools/figma-prototype/test/round17-help.test.mjs
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
const ja = (await L.help('ja')).value;
const en = (await L.help('en')).value;
assert.strictEqual(ja.categories.length, 8, 'eight categories');
assert.ok(!JP.test(JSON.stringify(en)), 'the English index has no Japanese');
assert.strictEqual(L.helpContext('gacha_odds'), 'pity', 'rates screen → pity');
assert.strictEqual(L.helpContext('coin_shortfall'), 'buy_coins', 'coin shortfall → buying coins');

const odds = L.odds('standard');
const pity = (await L.helpArticle('pity', 'ja')).value;
assert.ok(pity.body.includes(`${odds.pity.pullsRequired}回分`), 'the pity count comes from the rates data');
const rates = (await L.helpArticle('scout_rates', 'en')).value;
assert.ok(rates.body.includes(odds.rarityTotals.SSR.rate), 'the SSR rate comes from the rates data');
assert.ok(!/今だけ|残りわずか|倍|お得/.test(JSON.stringify((await L.helpArticle('buy_coins', 'ja')).value)), 'no urgency or multiplier wording');

for (const q of ['てんじょう', 'ﾃﾝｼﾞｮｳ', 'テンジョウ']) assert.strictEqual((await L.helpSearch(q)).value.items[0].id, 'pity', `search ${q}`);
const kpi = await L.helpKpi('help_search', { length: L.helpFoldLength('てんじょう'), category: 'all', results: 1 });
assert.deepStrictEqual(kpi.value, { name: 'help_search', s1: 'all', value: 5, count: 1 }, 'help_search: length / category / count only');

assert.strictEqual((await L.helpFeedback('pity', true)).value.changed, true);
assert.strictEqual((await L.helpFeedback('pity', true)).value.changed, false, 'the same vote twice changes nothing');

const form = { category: 'bug', description: 'レースの結果画面が表示されないことがあります。', refs: [] };
const t1 = await L.submitInquiry(form, 'form-1');
const t2 = await L.submitInquiry(form, 'form-1');
assert.ok(t1.ok && t2.ok && t1.value.ticketId === t2.value.ticketId, 'the same form key → one inquiry');
assert.strictEqual((await L.inquiries()).value.items.length, 1);

await L.seedInquiries();
const list = (await L.inquiries()).value;
const answered = list.items.find((x) => x.status === 'answered');
assert.ok(answered && answered.unread, 'the ops reply answers the ticket (unread)');
assert.strictEqual((await L.view()).help.unreadReplies, 1, 'the settings badge');
const act = (await L.activity()).value.items.find((x) => x.kind === 'inquiry_answered');
assert.deepStrictEqual(act.link, { screen: 'help_inquiry', id: answered.ticketId }, 'the activity entry links to the inquiry');
const d = (await L.inquiry(answered.ticketId, 'en')).value;
assert.strictEqual(d.statusText, 'Answered');
assert.ok(JP.test(d.messages[0].messageText), 'support wrote in Japanese and it stays as written');
await L.inquiryRead(answered.ticketId);
assert.strictEqual((await L.view()).help.unreadReplies, 0, 'read on opening');
console.log(`round17-help OK — ${ja.articles.length} articles, ${list.items.length} inquiries`);
