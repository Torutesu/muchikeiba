// Node check of the round 20 review prompt paths used by index.html (REQ-REV-*, contracts/protocol.md §59), on the real server
// code bundled into site/js/logic.js: not asked during the FTUE / too early; asked once at a happy moment (native by default),
// never twice in a session, the cool-down across a "reinstall" (new session); the soft pre-question (demo on): はい → the store,
// いまいち → the help inquiry, never the store; no reward anywhere; English for the sheet texts.
// usage: node tools/figma-prototype/test/round20-review-prompt.test.mjs
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
const facts = { inFtue: false, minutesSinceLoss: null, minutesSinceError: null, minutesSinceMaintenanceNotice: null };

await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');

// a new player: the FTUE (welcome pulls not drawn) and too early
let c = (await L.reviewPrompt.check('first_win', 'sess_proto_01', facts)).value;
assert.strictEqual(c.show, false);
assert.strictEqual(c.reason, 'ftue');
const s0 = (await L.reviewPrompt.status()).value;
assert.strictEqual(s0.rules.softAsk.android, false, 'android never has the pre-question');
assert.strictEqual(s0.rules.softAsk.ios, false, 'the shipped rules keep the pre-question off');

// settled (demo): native, once per session, the cool-down after a reinstall
const before = await L.view();
assert.ok((await L.reviewPrompt.demo(false)).ok);
c = (await L.reviewPrompt.check('first_win', 'sess_proto_02', facts)).value;
assert.deepStrictEqual([c.show, c.style], [true, 'native']);
assert.strictEqual((await L.reviewPrompt.check('hall_induction', 'sess_proto_02', facts)).value.reason, 'session');
assert.strictEqual((await L.reviewPrompt.check('hall_induction', 'sess_proto_03', facts)).value.reason, 'cool_down');
assert.strictEqual((await L.reviewPrompt.check('first_win', 'sess_proto_04', { ...facts, minutesSinceLoss: 1 })).value.reason, 'loss', 'a loss beats the cool-down in the order');
assert.deepStrictEqual((await L.reviewPrompt.answer(c.promptId, 'native_requested')).value, { promptId: c.promptId, next: 'none', helpCategory: null });
const after = await L.view();
assert.deepStrictEqual(after.wallet, before.wallet, 'no coins for a review');
assert.deepStrictEqual(after.items, before.items, 'no items for a review');

// soft (demo on, iOS): いまいち → the inquiry form, never the store
assert.ok((await L.reviewPrompt.demo(true)).ok);
assert.strictEqual((await L.reviewPrompt.check('first_win', 'sess_proto_05', { ...facts, minutesSinceLoss: 3 })).value.reason, 'loss');
c = (await L.reviewPrompt.check('first_win', 'sess_proto_05', facts)).value;
assert.deepStrictEqual([c.show, c.style], [true, 'soft']);
assert.deepStrictEqual((await L.reviewPrompt.answer(c.promptId, 'soft_no')).value, { promptId: c.promptId, next: 'help_inquiry', helpCategory: 'other' });
assert.strictEqual((await L.reviewPrompt.answer(c.promptId, 'native_requested')).code, 'NOT_ELIGIBLE');
assert.ok((await L.reviewPrompt.demo(true)).ok);
c = (await L.reviewPrompt.check('horse_goal_chain', 'sess_proto_06', facts)).value;
assert.strictEqual((await L.reviewPrompt.answer(c.promptId, 'soft_yes')).value.next, 'store_review');
assert.ok((await L.reviewPrompt.answer(c.promptId, 'native_requested')).ok);
const kpi = L.serverKpiLog().filter((k) => k.name.startsWith('review_')).map((k) => `${k.name}:${k.s1}`);
assert.deepStrictEqual(kpi, ['review_prompt_eligible:first_win', 'review_prompt_shown:first_win', 'review_prompt_eligible:first_win', 'review_soft_answer:not_really',
  'review_prompt_eligible:horse_goal_chain', 'review_soft_answer:yes', 'review_prompt_shown:horse_goal_chain']);
await L.reviewPrompt.demo(false);

for (const t of ['ムチ一閃を楽しんでいますか？', 'はい', 'いまいち', 'ひとこと', 'ご意見をお聞かせください。お問い合わせの画面を開きます。', '答えなくてもかまいません。ゲームの内容は何も変わりません。',
  '「ムチ一閃」を気に入っていますか？', 'App Store で評価するには、星をタップしてください。', '今はしない', '大会の初優勝', '目標の物語を走りきった']) {
  const en = L.l10n.translate(t);
  assert.ok(en && !/[぀-ヿ一-鿿]/.test(en), 'English: ' + t + ' → ' + en);
}
console.log('round20 review prompt: ok');
