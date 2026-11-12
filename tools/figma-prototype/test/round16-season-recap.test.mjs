// Node check of the round 16 season recap paths used by index.html (REQ-RECAP-*, contracts/protocol.md §43), on the real server
// code bundled into site/js/logic.js: the demo history (Oct 2026 → Jan 2027) gives a short October recap, a full November one
// (promotion, a horse into the hall, final rank from the rollover job), December and the 2026 year recap; open / complete are
// kept once; the share cards never carry a player name; every line has English; recap_share passes the server's batch check.
// usage: node tools/figma-prototype/test/round16-season-recap.test.mjs
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

const list = await L.recap.list();
assert.ok(list.ok && list.value.enabled);
assert.deepStrictEqual(list.value.recaps.map((r) => r.id), ['year:2026', 'season:2026-12', 'season:2026-11', 'season:2026-10']);
assert.strictEqual(list.value.unseen, 'year:2026');
assert.strictEqual(list.value.recaps.find((r) => r.id === 'season:2026-10').short, true);

// the short October recap: never empty
const oct = (await L.recap.view('season:2026-10')).value;
assert.deepStrictEqual(oct.steps.map((s) => s.key), ['races', 'best_finish', 'horse', 'end']);
assert.strictEqual(oct.steps.find((s) => s.key === 'horse').horseName, 'アカツキ', 'the local partner\'s name, as typed');

// November: promotion (14 wins), the hall, the final rank from the rollover job
const nov = (await L.recap.view('season:2026-11')).value;
const step = (k) => nov.steps.find((s) => s.key === k);
assert.strictEqual(step('races').value, '20');
assert.strictEqual(step('rank').value, 'B級');
assert.deepStrictEqual(step('rank').notes, ['最終順位 4位', 'C級からB級へ昇格', '昇級戦を突破']); // round 22 (§68): the line, then the promotion series
assert.strictEqual(step('horse').horseName, 'ソラノカナタ', 'the horse with the most races');
assert.deepStrictEqual(step('hall').horses, [{ horseName: 'ソラノカナタ' }]);
assert.deepStrictEqual(step('moments').moments.map((m) => m.kind), ['promotion', 'hall', 'first_win']);
assert.strictEqual(nov.sinceNote, null);
assert.deepStrictEqual(nov.shareCards.map((c) => [c.card, c.rank]), [['summary', false], ['horse', false], ['moment', false], ['rank', true]]);
assert.ok(!JSON.stringify(nov).includes('demo_recap'), 'no player id');
assert.ok(!/倍|お得|今だけ|賭|配当|オッズ|購入|課金|コイン/.test(JSON.stringify(nov)), 'no spending, betting or urgency words');

// the year: closed at 04:00 JST on 1 January, December's races included
const year = (await L.recap.view('year:2026')).value;
assert.strictEqual(year.title, '2026年の振り返り');
assert.strictEqual(year.steps.find((s) => s.key === 'races').value, '26');
assert.strictEqual(year.steps.find((s) => s.key === 'rank').value, 'B級');

// open / complete: the first time is kept
const a = (await L.recap.progress('season:2026-11', 'open')).value;
const b = (await L.recap.progress('season:2026-11', 'open')).value;
assert.strictEqual(a.openedAt, b.openedAt);
assert.ok((await L.recap.progress('season:2026-11', 'complete')).value.completedAt);
assert.strictEqual((await L.recap.view('nope')).ok, false);

// English for every server line (horse names stay as typed)
const tr = (s) => L.l10n.translate(s);
for (const s of nov.steps) {
  for (const t of [s.label, s.value, s.unit, ...(s.notes ?? []), ...(s.moments ?? []).map((m) => m.text)].filter((x) => x && /[぀-ヿ一-鿿]/.test(x))) {
    assert.ok(tr(t) && !/[぀-ヿ一-鿿]/.test(tr(t)), `English for 「${t}」 (${tr(t)})`);
  }
}
assert.strictEqual(tr('2026年11月シーズン'), 'Season 11/2026');

// recap_share passes the server's client batch check
const k = await L.kpi([{ name: 'recap_share', at: L.now(), props: { kind: 'season', card: 'horse', hideRank: true } }]);
assert.ok(k.ok, JSON.stringify(k));
console.log('round 16 season recap: ok');
