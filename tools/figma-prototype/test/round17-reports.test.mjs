// Node check of the round 17 report / block paths used by index.html (REQ-RPT-*, contracts/protocol.md §47), on the real
// server code bundled into site/js/logic.js: the sheet's options, a report with a server-side snapshot (a later rename does
// not change it), merged reports, the daily limit, "also block" on the one block list (the team feed's mute list), the
// block list with current names (a deleted player → 「プレイヤー」), unblock, support's request in the activity list, and
// English with only player names left.
// usage: node tools/figma-prototype/test/round17-reports.test.mjs
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
await L.reports.seedSafety();

// the block list: newest first, current names, the deleted one neutral; effects for every feature
const b = (await L.reports.blocks()).value;
assert.deepStrictEqual(b.blocked.map((x) => x.name), ['プレイヤー', 'ナギサ', 'ヨルノカラス'], 'current names, newest first, a deleted player is neutral');
assert.deepStrictEqual(b.effects.map((e) => e.feature), ['activity', 'team_feed', 'rival', 'stable', 'hall', 'replays', 'cups'], 'what a block does, per feature');
assert.strictEqual(b.count, 3);

// support's request in the activity list (no actor, links to 通報とブロック)
const act = (await L.activity(null, 20)).value;
const notice = act.items.find((i) => i.kind === 'ops_notice');
assert.ok(notice && notice.actors.length === 0 && notice.link.screen === 'safety', 'ops_notice links to 通報とブロック');

// the sheet's options
const o = (await L.reports.options()).value;
assert.deepStrictEqual(o.categories.map((c) => c.id), ['name', 'text', 'cheating', 'harassment', 'other']);
assert.strictEqual(o.remainingToday, 10);

// a report: the snapshot is the server's copy; a later rename leaves it
const target = 'demo_bl_1';
const r1 = await L.reports.submit({ targetId: target, category: 'name', source: 'hall', content: { kind: 'display_name' }, note: ' 気になります ' });
assert.ok(r1.ok && r1.value.received && r1.value.remainingToday === 9, 'received');
assert.deepStrictEqual(Object.keys(r1.value).sort(), ['blocked', 'received', 'remainingToday'], 'never says whether it was merged');
const q = L.reports.queue();
assert.strictEqual(q.length, 1);
assert.strictEqual(q[0].snapshot.text, 'ヨルノカラス');
assert.ok(!('reporters' in q[0]), 'the list never carries reporter ids');

// the same reporter again: merged (still one in the queue), the allowance is used
const r2 = await L.reports.submit({ targetId: target, category: 'harassment', source: 'profile', content: { kind: 'display_name' } });
assert.ok(r2.ok && r2.value.remainingToday === 8);
assert.strictEqual(L.reports.queue().length, 1, 'merged');
assert.strictEqual(L.reports.queue()[0].count, 1, 'the same reporter counts once');

// per-target limit, wrong pairs, yourself
assert.strictEqual((await L.reports.submit({ targetId: target, category: 'other', source: 'profile', content: { kind: 'player' } })).code, 'RATE_LIMITED');
assert.strictEqual((await L.reports.submit({ targetId: 'demo_bl_2', category: 'cheating', source: 'profile', content: { kind: 'display_name' } })).code, 'BAD_REQUEST');
assert.strictEqual((await L.reports.submit({ targetId: 'demo_bl_2', category: 'cheating', source: 'replay', content: { kind: 'race', raceId: 'not_mine' } })).code, 'NOT_ELIGIBLE');
assert.strictEqual((await L.reports.submit({ targetId: 'local', category: 'other', source: 'profile', content: { kind: 'player' } })).code, 'BAD_REQUEST');

// unblock, then report with "also block": the one list again
assert.ok((await L.reports.unblock('demo_bl_2')).ok);
assert.ok(!(await L.reports.blocks()).value.blocked.some((x) => x.playerId === 'demo_bl_2'), 'unblocked');
const r3 = await L.reports.submit({ targetId: 'demo_bl_2', category: 'harassment', source: 'team_feed', content: { kind: 'player' }, alsoBlock: true });
assert.ok(r3.ok && r3.value.blocked, 'also block');
assert.ok((await L.reports.blocks()).value.blocked[0].playerId === 'demo_bl_2', 'back on top of the list');
const kpi = L.serverKpiLog().filter((k) => ['report_submit', 'block_add', 'block_remove'].includes(k.name)).map((k) => k.name);
for (const n of ['report_submit', 'block_add', 'block_remove']) assert.ok(kpi.includes(n), `KPI ${n}`);

// English: only player names stay in Japanese
const JP = /[぀-ヿ㐀-鿿]/;
for (const t of [...o.categories.map((c) => c.label), ...b.effects.map((e) => e.text), notice.text]) {
  const en = L.l10n.translate(t);
  assert.ok(en && !JP.test(en), `English: ${t} → ${en}`);
}
console.log(`round17-reports OK — ${b.count} blocked, ${L.reports.queue().length} reports in the queue, KPI ${[...new Set(kpi)].join(', ')}`);
