// Node check of the round 23 support thread paths used by index.html (REQ-TKT-*, contracts/protocol.md §73), on the real
// server code bundled into site/js/logic.js: the demo threads (返信あり / 確認中 / 解決 with an apology gift), a reply kept to
// one entry per key that reopens the resolved ticket, the auto-close clock, diagnostics only with consent, the KPI rows
// without text, and English with only typed text left in Japanese.
// usage: node tools/figma-prototype/test/round23-support-tickets.test.mjs
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
await L.seedInquiries();
const list = (await L.inquiries('ja')).value;
const by = (st) => list.items.find((x) => x.status === st);
assert.deepStrictEqual(['answered', 'in_progress', 'resolved'].map((s) => by(s)?.statusText), ['返信あり', '確認中', '解決'], 'the demo chips');
const res = by('resolved');
const t = (await L.inquiry(res.ticketId, 'ja')).value;
assert.strictEqual(t.compensation[0].screen, 'gift_box', 'the apology gift links to the gift box');
assert.ok(t.autoCloseAt > Date.now(), 'a resolved ticket carries its auto-close time');
assert.strictEqual(t.diagnostics.appVersion, null, 'no diagnostics without consent');
const r1 = await L.inquiryReply(res.ticketId, 'もう一度確認してください。', 'k1', 'ja');
assert.ok(r1.ok, r1.message);
assert.strictEqual(r1.value.status, 'received', 'a reply reopens a resolved ticket');
const r2 = await L.inquiryReply(res.ticketId, 'もう一度確認してください。', 'k1', 'ja');
assert.strictEqual(r2.value.messages.filter((m) => m.from === 'player').length, 1, 'the same key never adds a second reply');
const fast = await L.inquiryReply(res.ticketId, '追記です。', 'k2', 'ja');
assert.strictEqual(fast.code, 'RATE_LIMITED', 'replies keep their interval');
const kpi = L.ticketKpi();
assert.ok(kpi.some((k) => k.name === 'ticket_reopen' && k.s2 === 'resolved'), 'ticket_reopen');
assert.ok(!JSON.stringify(kpi).includes('確認してください'), 'KPI rows carry no text');
const en = (await L.inquiry(res.ticketId, 'en')).value;
assert.strictEqual(en.statusText, 'Received');
assert.ok(JP.test(en.messages.at(-1).messageText), 'typed text stays as written');
assert.ok(!JP.test(JSON.stringify({ ...en, inquiryText: '', messages: [] })), 'nothing else is Japanese in English');
console.log(`round23-support-tickets OK — ${list.items.length} threads, ${kpi.length} support KPI rows`);
