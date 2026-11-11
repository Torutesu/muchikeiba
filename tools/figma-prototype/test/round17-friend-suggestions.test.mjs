// Node check of the round 17 おすすめフレンド paths used by index.html (REQ-FSUG-*, contracts/protocol.md §49), on the real
// server code bundled into site/js/logic.js: the demo (people met through the real race / like / cheer / friends paths), the
// reasons and order, who never appears (opt-out, ranked-only), a request through the friend request flow (the other side's
// activity entry), dismiss, the 「おすすめに表示しない」 switch, KPI, and English with only player names left.
// usage: node tools/figma-prototype/test/round17-friend-suggestions.test.mjs
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
await L.seedFriendSuggest();
const r = await L.friendSuggestions();
assert.ok(r.ok, r.message);
const S = r.value;
assert.strictEqual(S.enabled, true);
assert.deepStrictEqual(S.settings, { hidden: false });
const byName = Object.fromEntries(S.items.map((x) => [x.displayName, x.text]));
// event opponent with 2 mutual friends first; then the friend room, the 3-mutual stranger, the cheer (newer) and the like (equal points)
assert.deepStrictEqual(S.items.map((x) => x.displayName), ['アサギ', 'ツバメ', 'ミナト', 'ヒナタ', 'コハル'], JSON.stringify(S.items.map((x) => [x.displayName, x.text])));
assert.strictEqual(byName['アサギ'], '最近のレースで対戦・共通のフレンド2人');
assert.strictEqual(byName['ミナト'], '共通のフレンド3人');
assert.strictEqual(byName['コハル'], 'マイ厩舎にいいねをくれた');
assert.strictEqual(byName['ヒナタ'], '応援スタンプをくれた');
assert.ok(!('カゲロウ' in byName), 'opted out: never suggested');
assert.ok(!('ランクノヒト' in byName), 'ranked opponents are not used');
for (const it of S.items) for (const k of ['rating', 'stats', 'blocked', 'friends', 'score']) assert.ok(!(k in it), `no ${k} in a suggestion`);
assert.ok(!S.items.some((x) => /今だけ|残りわずか|倍|お得/.test(x.text)), 'no urgency wording');

// request through the friend request flow: the other side gets the activity entry; the card does not come back
const req = await L.fsugRequest('demo_fs_2');
assert.ok(req.ok, req.message);
assert.deepStrictEqual(req.value, { status: 'requested', playerId: 'demo_fs_2' });
const theirs = await L.fsugActivityOf('demo_fs_2');
assert.strictEqual(theirs[0].kind, 'friend_request', 'activity (§40) for free through friendReceive');
assert.ok(!(await L.friendSuggestions()).value.items.some((x) => x.playerId === 'demo_fs_2'));
assert.ok((await L.friendsList()).value.outgoing.some((x) => x.playerId === 'demo_fs_2'), 'the request is pending');
// a stranger (not suggested) cannot be asked through this path
assert.strictEqual((await L.fsugRequest('demo_fs_7')).code, 'NOT_FOUND');

// dismiss: idempotent, remembered
assert.ok((await L.fsugDismiss('demo_fs_4')).ok);
assert.ok((await L.fsugDismiss('demo_fs_4')).ok);
assert.ok(!(await L.friendSuggestions()).value.items.some((x) => x.playerId === 'demo_fs_4'));
const kpi = L.serverKpiLog();
assert.strictEqual(kpi.filter((k) => k.name === 'fsug_request').length, 1);
assert.strictEqual(kpi.filter((k) => k.name === 'fsug_dismiss').length, 1);
assert.deepStrictEqual((await L.fsugKpi(3)).value, { name: 'fsug_view', value: 3 });

// the setting
assert.deepStrictEqual((await L.fsugSetHidden(true)).value, { hidden: true });
assert.strictEqual((await L.friendSuggestions()).value.settings.hidden, true);
await L.fsugSetHidden(false);

// English: only the player names stay Japanese
const en = (await L.friendSuggestions()).value.items.map((x) => L.l10n.translate(x.text));
{
  assert.ok(en.includes('Raced you recently, 2 mutual friends'), JSON.stringify(en));
  assert.ok(en.every((t) => !/[぀-ヿ一-鿿]/.test(t)), JSON.stringify(en));
}
console.log(`round 17 friend suggestions OK — ${S.items.length} suggestions, request via the friend flow, dismiss, setting, KPI`);
