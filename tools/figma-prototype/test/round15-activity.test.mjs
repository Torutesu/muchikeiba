// Node check of the round 15 activity paths used by index.html (REQ-ACT-*, contracts/protocol.md §40), on the real server
// code bundled into site/js/logic.js: the demo (written by the real event sources), collapsed likes, links (a gift row
// leads to the box, no claim), the bell in the player view, mark read, paging, and English with only player names left.
// usage: node tools/figma-prototype/test/round15-activity.test.mjs
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
const v = await L.seedActivity();
assert.ok(v.activity.unread >= 7, `the bell counts the unread entries (${v.activity.unread})`);

const r = await L.activity(null, 20);
assert.ok(r.ok, 'the list loads');
const P = r.value;
const kinds = P.items.map((i) => i.kind);
assert.strictEqual(kinds[0], 'friend_request', 'newest first');
for (const k of ['stable_like', 'team_cheer', 'team_goal_tier', 'rival_record', 'gift_arrived', 'tournament_result', 'friend_accepted', 'team_goal_week']) assert.ok(kinds.includes(k), `entry ${k}`);
const like = P.items.find((i) => i.kind === 'stable_like');
assert.strictEqual(like.count, 12, '12 likes → one entry');
assert.strictEqual(like.text, 'マイ厩舎に12件のいいねが届きました');
// the demo's earlier days may have put gifts in the box (seen before); since then only the compensation arrived
const fresh = P.items.filter((i) => i.kind === 'gift_arrived' && i.unread);
assert.deepStrictEqual(fresh.map((g) => g.count), [1], 'the tournament prize writes no second gift entry');
const gift = fresh[0];
assert.deepStrictEqual(gift.link, { screen: 'gift_box', id: null }, 'a gift row links to the box');
assert.ok(!('claim' in gift) && !('contents' in gift), 'nothing to claim on the activity list');
assert.strictEqual(P.items[0].text, 'アサヒさんからフレンド申請が届きました', 'the sender name from the public profile');
assert.ok(P.items.filter((i) => !i.unread).map((i) => i.kind).includes('friend_accepted'), 'entries seen on an earlier visit are read');

// paging by the server cursor
const p1 = (await L.activity(null, 3)).value;
const p2 = (await L.activity(p1.nextCursor, 3)).value;
assert.ok(p1.nextCursor && p2.items.every((i) => Number(i.id) < Number(p1.items[2].id)), 'the next page continues below the cursor');

// mark read (idempotent)
const m1 = await L.activityRead(P.items[0].id);
const m2 = await L.activityRead(P.items[0].id);
assert.ok(m1.ok && m2.ok && m1.value.unread === 0 && m2.value.readUpTo === m1.value.readUpTo, 'mark read twice: the same answer');
assert.strictEqual((await L.view()).activity.unread, 0, 'the bell clears');

// English: only player names stay in Japanese
const JP = /[぀-ヿ㐀-鿿]/;
const names = new Set(['アサヒ', 'カエデ', 'シノノメ', 'ミドリカワ']);
for (const it of P.items) {
  let en = L.l10n.translate(it.text);
  for (const n of names) en = en.split(n).join('');
  assert.ok(!JP.test(en), `English: ${it.text} → ${L.l10n.translate(it.text)}`);
}
console.log(`round15-activity OK — ${P.items.length} entries, ${kinds.join(', ')}`);
