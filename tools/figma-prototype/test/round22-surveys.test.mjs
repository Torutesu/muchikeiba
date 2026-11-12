// Node check of the round 22 survey paths used by index.html (REQ-SURVEY-*, contracts/protocol.md §69), on the real server
// code bundled into site/js/logic.js: none during the FTUE / without a live survey; the demo survey offered in the お知らせ row
// (R22 integration: placement inbox only, unread until opened; home / result are refused), one per player (answer once, a second key refused), the strict check (unknown question → BAD_REQUEST), the
// free-text scrub, skip → the cool-down, results for ops without the player's id, nothing granted, English for the sheet texts.
// usage: node tools/figma-prototype/test/round22-surveys.test.mjs
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

// no live survey yet; then the FTUE
assert.strictEqual((await L.surveys.offer('inbox', 'ja')).value.reason, 'ftue', 'a new player is in the FTUE');
assert.ok((await L.surveys.demo()).ok);
let o = (await L.surveys.offer('inbox', 'ja')).value;
assert.strictEqual(o.survey?.id, 'sv_whip_feel', 'the demo survey in the お知らせ row');
assert.strictEqual(o.unread, true, 'unread until opened (a small dot in お知らせ)');
assert.strictEqual((await L.surveys.offer('home', 'ja')).ok, false, 'no home placement any more');
assert.deepStrictEqual(o.survey.questions.map((q) => q.kind), ['scale', 'single', 'multi', 'text']);
const en = (await L.surveys.offer('inbox', 'en')).value.survey;
assert.ok(!/[぀-ヿ一-鿿]/.test(JSON.stringify(en)), 'the English view has no Japanese');

const before = await L.view();
assert.ok((await L.surveys.shown('sv_whip_feel', 'inbox')).ok);
assert.strictEqual((await L.surveys.offer('inbox', 'ja')).value.unread, false, 'opened → no dot');
assert.strictEqual((await L.surveys.answer('sv_whip_feel', 'inbox', { feel: 4, mode: 'ranked', nope: 1 }, 'c:k1')).code, 'BAD_REQUEST', 'unknown question → 400');
assert.strictEqual((await L.surveys.answer('sv_whip_feel', 'inbox', { feel: 9, mode: 'ranked' }, 'c:k1')).code, 'BAD_REQUEST');
const a = await L.surveys.answer('sv_whip_feel', 'inbox', { feel: 4, mode: 'ranked', wish: ['silks'], free: '連絡は taro@example.com まで' }, 'c:k2');
assert.ok(a.ok, a.message);
assert.deepStrictEqual((await L.surveys.answer('sv_whip_feel', 'inbox', { feel: 4, mode: 'ranked' }, 'c:k2')).value, a.value, 'same key → same answer');
assert.strictEqual((await L.surveys.answer('sv_whip_feel', 'inbox', { feel: 4, mode: 'ranked' }, 'c:k3')).code, 'CONFLICT', 'once per player');
const after = await L.view();
assert.deepStrictEqual(after.wallet, before.wallet, 'no coins for answering');
assert.deepStrictEqual(after.items, before.items, 'no items for answering');
assert.strictEqual((await L.surveys.offer('inbox', 'ja')).value.reason, 'cool_down');
const res = (await L.surveys.results('sv_whip_feel')).value;
assert.strictEqual(res.total, 1);
const free = res.questions.find((q) => q.id === 'free');
assert.strictEqual(free.texts[0].text, '連絡は <email> まで', 'free text scrubbed');
assert.ok(!JSON.stringify(res).includes('"local"'), 'no player id in the results');

// skip: one tap, never again; a closed survey
assert.ok((await L.surveys.demo()).ok);
assert.strictEqual((await L.surveys.skip('sv_whip_feel', 'inbox')).value.outcome, 'skipped');
assert.strictEqual((await L.surveys.answer('sv_whip_feel', 'inbox', { feel: 1, mode: 'events' }, 'c:k4')).code, 'CONFLICT');
assert.ok((await L.surveys.demo()).ok);
await L.surveys.close('sv_whip_feel');
assert.strictEqual((await L.surveys.answer('sv_whip_feel', 'inbox', { feel: 1, mode: 'events' }, 'c:k5')).code, 'SURVEY_CLOSED');
const kpi = L.serverKpiLog().filter((k) => k.name.startsWith('survey_')).map((k) => `${k.name}:${k.s2}`);
assert.deepStrictEqual(kpi, ['survey_shown:inbox', 'survey_answer:inbox', 'survey_skip:inbox']);
L.surveys.clear();

for (const t of ['アンケート', 'アンケートにご協力ください', '答える', 'スキップ', 'とばす', '送る', '次へ', '戻る', '任意', '答えても何ももらえません。ゲームの内容も変わりません。', 'ありがとうございました',
  'いただいた声は、これからのムチ一閃づくりに使います。', 'このアンケートは終了しました', '名前やメールアドレスなどは書かないでください', '2つまで選べます']) {
  const e = L.l10n.translate(t);
  assert.ok(e && !/[぀-ヿ一-鿿]/.test(e), 'English: ' + t + ' → ' + e);
}
console.log('round22 surveys: ok');
