// Node check of the round 19 観戦中の応援 paths used by index.html (REQ-CHEER-*, contracts/protocol.md §55), on the real server
// code bundled into site/js/logic.js: the 2 s pace (cheerAdmit), the window fanned out with the block list (the blocked demo
// spectator never reaches you), counts per horse and kind with no ids, the replay moments, one KPI row per race, English.
// usage: node tools/figma-prototype/test/round19-cheer.test.mjs
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

const offer = L.cheer.start(12);
assert.deepStrictEqual(offer, { kinds: ['go', 'close', 'hold'], minIntervalMs: 2000, windowMs: 1000 });
assert.deepStrictEqual(L.cheer.text.go, { ja: 'いけ！', en: 'Go!' });

// the pace: one cheer, then refused until 2 s passed; bad kinds / slots refused
assert.deepStrictEqual(L.cheer.send(3, 'go', 40), { ok: true });
assert.deepStrictEqual(L.cheer.send(3, 'go', 41), { ok: false, code: 'CHEER_RATE_LIMITED' });
assert.strictEqual(L.cheer.send(3, 'boo', 41).code, 'BAD_MESSAGE');
assert.strictEqual(L.cheer.send(12, 'go', 41).code, 'BAD_MESSAGE');

// windows: counts only, sorted, my own cheer included, the blocked spectator's never
const blocked = L.cheer.blockedSpectator();
let total = 0, mine = false;
for (let i = 0; i < 30; i++) {
  const rows = L.cheer.window(60 + i * 20, 6);
  for (const r of rows) { assert.strictEqual(r.length, 3); assert.ok(r[0] >= 0 && r[0] < 12 && ['go', 'close', 'hold'].includes(r[1]) && r[2] > 0); total += r[2]; if (i === 0 && r[0] === 3 && r[1] === 'go') mine = true; }
  for (let j = 1; j < rows.length; j++) assert.ok(rows[j - 1][0] < rows[j][0] || (rows[j - 1][0] === rows[j][0] && ['go', 'close', 'hold'].indexOf(rows[j - 1][1]) < ['go', 'close', 'hold'].indexOf(rows[j][1])), 'sorted by slot, then kind');
  assert.ok(!JSON.stringify(rows).includes('demo_cheer'), 'no sender ids');
}
assert.ok(mine, 'my own cheer is in the first window');
assert.ok(total > 30, 'the crowd cheers');
// the blocked spectator: at most the other five crowd members per window (+ mine in the first)
const again = L.cheer.start(12);
let max = 0;
for (let i = 0; i < 40; i++) max = Math.max(max, L.cheer.window(i * 20, -1).reduce((a, r) => a + r[2], 0));
assert.ok(max <= 5, `the blocked spectator never counts (max ${max} per window from 5 others)`);
assert.ok(again && blocked.startsWith('demo_cheer'));

// moments: in race order, at most 3
const ms = L.cheer.moments();
assert.ok(ms.length <= 3);
for (let i = 1; i < ms.length; i++) assert.ok(ms[i - 1].tick < ms[i].tick);
for (const m of ms) assert.ok(m.count >= 3 && m.tick % 40 === 0);

// KPI: one row per race
assert.deepStrictEqual((await L.cheer.kpi('cheer_send', { mode: 'friend', count: 4 })).value, { name: 'cheer_send', s1: 'friend', count: 4 });
assert.deepStrictEqual((await L.cheer.kpi('cheer_seen', { mode: 'ranked', role: 'racer', count: 9 })).value, { name: 'cheer_seen', s1: 'ranked', s2: 'racer', count: 9 });
assert.strictEqual((await L.cheer.kpi('cheer_send', { mode: 'friend', count: 4, slot: 2 })).ok, false, 'no horse / player in the row');

// English for every text the screens draw
for (const ja of ['いけ！', '差せ！', '粘れ！', '応援 ×12', '3番', '応援する馬', '応援は2秒に1回まで', '応援はレースの結果に影響しません', '応援の多かった瞬間', 'レース中の応援表示', '観戦', 'いまの応援', '応援が届くと、ここに出ます', '観戦して応援する', 'フレンド部屋　·　ライブ', '出走馬　/　ライブ']) {
  const en = L.l10n.translate(ja);
  assert.ok(en && !/[぀-ヿ㐀-鿿]/.test(en), `English for ${ja}: ${en}`);
}
console.log('round 19 cheer: OK');
