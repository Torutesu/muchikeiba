// Node check of the round 14 実況パック paths used by index.html (REQ-CMT-*, contracts/protocol.md §36):
//  1) the WASM engine lays the equipped pack over the templates: a race speaks the pack's lines, the standard stays the
//     standard (same lines as before), the tutorial always speaks the standard;
//  2) the 10-second sample (the real CommentarySample.Build on the stock race) is the pack's own key lines, the same each time;
//  3) the real server rules bundled in site/js/logic.js: owned / price / equip / buy (paid first), the achievement pack.
// usage: node tools/figma-prototype/test/round14-commentary-packs.test.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const res = (f) => readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', f), 'utf8');
const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const ex = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;
ex.Init(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'), res('commentary-ja.json'));
assert.strictEqual(ex.SetCommentaryPacks(res('commentary-packs.json')), 4);
const packs = JSON.parse(res('commentary-packs.json'));
const textsOf = (id) => new Set(Object.values(packs.packs.find((p) => p.id === id).phrases.ja).flatMap((p) => p.variants.map((v) => v.text.replace(/\{[a-z0-9]+\}/g, ''))));

function race(mode, packId, seed = 7) {
  assert.strictEqual(ex.SetCommentaryPack(packId), packId === 'nope' ? 'standard' : packId);
  if (mode === 'tutorial') ex.StartTutorial(1); else ex.Start('practice', 'テストホース', '', seed);
  const subs = [];
  let t = 1000, f;
  for (let i = 0; i < 40000; i++) { f = JSON.parse(ex.Frame(t)); t += 50; if (f.subtitle && subs.at(-1) !== f.subtitle) subs.push(f.subtitle); if (f.done) break; }
  return subs;
}
// 1) races
const std = race('practice', 'standard');
const std2 = race('practice', 'nope'); // a pack the device does not know: the standard
assert.deepStrictEqual(std2, std, 'unknown pack → the standard, identical lines');
const nek = race('practice', 'nekketsu');
assert.notDeepStrictEqual(nek, std, 'the pack speaks differently');
const fixed = textsOf('nekketsu');
const hit = nek.filter((s) => [...fixed].some((x) => x.length >= 4 && s.includes(x.split('！')[0].slice(0, 4))));
assert.ok(hit.length >= 3, 'the race speaks the pack lines: ' + nek.slice(0, 4).join(' | '));
assert.deepStrictEqual(race('practice', 'nekketsu'), nek, 'the same race in the same pack sounds the same');
assert.deepStrictEqual(race('tutorial', 'kofuu'), race('tutorial', 'standard'), 'the tutorial always speaks the standard');

// 2) the sample
for (const p of packs.packs) {
  const a = JSON.parse(ex.CommentarySampleJson(p.id));
  const b = JSON.parse(ex.CommentarySampleJson(p.id));
  assert.strictEqual(a.packId, p.id);
  assert.ok(a.lines.length >= 3 && a.totalTicks <= 200, `${p.id}: ${a.lines.length} lines in ${a.totalTicks} ticks`);
  assert.deepStrictEqual(a, b, 'the sample is the same every time');
  if (p.id !== 'standard') assert.ok(a.lines.some((l) => l.variant.startsWith(p.id + '_')), 'the sample is the pack\'s own lines');
  console.log(`  sample ${p.id}: ${a.lines.map((l) => l.text).join(' / ')}`);
}

// 3) the server rules
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
let v = await L.commentaryPacks();
assert.strictEqual(v.equipped, 'standard');
assert.deepStrictEqual(v.packs.map((p) => [p.id, p.owned]), [['standard', true], ['nekketsu', false], ['ochitsuki', false], ['kofuu', false]]);
assert.strictEqual((await L.equipCommentaryPack('kofuu')).code, 'NOT_ELIGIBLE');
await L.seedDemo(7, [3, 3, 3, 3, 3, 3, 3]);
v = await L.commentaryPacks();
assert.strictEqual(v.packs[1].owned, true, '21 races: the 「出走の記録」 pack is owned');
assert.ok((await L.equipCommentaryPack('nekketsu')).ok);
assert.strictEqual((await L.view()).commentaryPack.equipped, 'nekketsu');
const before = (await L.view()).wallet;
const buy = await L.buyCommentaryPack('kofuu', true);
if (before.free + before.paid >= 300) {
  assert.ok(buy.ok, buy.message);
  assert.strictEqual(buy.value.view.equipped, 'kofuu');
  const after = (await L.view()).wallet;
  assert.strictEqual(before.free + before.paid - after.free - after.paid, 300);
  assert.strictEqual((await L.buyCommentaryPack('kofuu')).code, 'ALREADY_PURCHASED');
} else {
  assert.strictEqual(buy.code, 'INSUFFICIENT_COINS');
  assert.strictEqual(buy.details?.shortfall?.short, true, 'the refused buy carries the T6 shortfall sheet');
}
// round 14 integration (§29 × §36): the pre-check CommentaryPackBuy runs before its confirm opens the shortfall sheet
// when the pack costs more than the player has (the same query the screen sends, with the pack's currency)
{
  const w = (await L.view()).wallet;
  const sf = await L.coinShortfall({ for: 'coins', coins: w.free + w.paid + 300, kind: 'any' });
  assert.ok(sf.ok, sf.message);
  assert.strictEqual(sf.value.short, true);
  assert.strictEqual(sf.value.shortfall, 300);
  assert.ok(sf.value.offer || sf.value.status !== 'buyable', 'a pack to buy, or a stated reason');
}
assert.strictEqual((await L.buyCommentaryPack('nekketsu')).code, 'NOT_ELIGIBLE', 'the achievement pack is never sold');
assert.strictEqual(L.commentaryPackName('ochitsuki'), '落ち着いた解説');
console.log('ROUND 14 COMMENTARY PACKS OK');
process.exit(0);
