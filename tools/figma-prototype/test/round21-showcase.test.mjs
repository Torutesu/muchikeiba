// Node check of the round 21 トレーナーカード paths used by index.html (REQ-SHOW-*, contracts/protocol.md §62), on the real server
// code bundled into site/js/logic.js and the real C# ShowcaseShare in WASM: the demo players' cards (a friend, an under-13
// player without player-typed names, one who blocked you → the neutral card), the editor (only earned things, the strict
// save, a refused locked background), the card of my own state, the share image without a player id, and the KPI rows on
// the server's strict schema.
// usage: node tools/figma-prototype/test/round21-showcase.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
await L.grantPartner('ミドリ');
const demo = (await L.showcase.demo()).value;
assert.deepStrictEqual(demo.map((d) => d.playerId), ['demo_sc_1', 'demo_sc_kid', 'demo_sc_blk']);

// a friend's card, in the viewer's language
const ja = (await L.showcase.card('demo_sc_1', 'ja')).value;
assert.strictEqual(ja.state, 'ok');
assert.strictEqual(ja.relation, 'friend', 'the demo friend is a friend');
assert.strictEqual(ja.horse.horseName, 'サクラフブキ');
assert.deepStrictEqual(ja.pins.map((p) => p.kind), ['tournament', 'cup_trophy', 'title']);
assert.strictEqual(ja.phrase.phraseText, 'タイムアタックに夢中');
assert.ok(ja.reportable && ja.reportableHorseId, 'report entry with the horse name');
const en = (await L.showcase.card('demo_sc_1', 'en')).value;
assert.strictEqual(en.phrase.phraseText, 'Hooked on time attack');
assert.strictEqual(en.background.backgroundName, 'Turf stretch');
assert.strictEqual(en.horse.horseName, 'サクラフブキ', 'a horse name is never translated');

// under 13: no player-typed names
const kid = (await L.showcase.card('demo_sc_kid', 'ja')).value;
assert.strictEqual(kid.young, true);
assert.strictEqual(kid.horse.horseName, null);
assert.ok(!JSON.stringify(kid).includes('ハルカゼ') && !JSON.stringify(kid).includes('春の小さな杯'), 'no horse or cup name on an under-13 card');

// blocked either way → the neutral card
const blk = (await L.showcase.card('demo_sc_blk', 'ja')).value;
assert.strictEqual(blk.state, 'neutral');
assert.strictEqual(blk.displayName, 'プレイヤー');
assert.ok(!blk.pins.length && !blk.horse && !blk.reportable, 'nothing on a neutral card');
await L.showcase.block('demo_sc_1', true);
assert.strictEqual((await L.showcase.card('demo_sc_1', 'ja')).value.state, 'neutral', 'my block → neutral');
await L.showcase.block('demo_sc_1', false);
assert.strictEqual((await L.showcase.card('demo_sc_1', 'ja')).value.state, 'ok', 'unblocked → the card again');
assert.strictEqual((await L.showcase.card('nobody_here', 'en')).value.displayName, 'Player', 'an unknown / deleted player: the neutral name');

// the editor: only what I have; the strict save
const me = (await L.showcase.mine('ja')).value;
assert.strictEqual(me.saved, false);
assert.ok(me.horses.length >= 1, 'my partner can be featured');
assert.ok(me.backgrounds.some((b) => !b.unlocked), 'some backgrounds are locked');
const locked = me.backgrounds.find((b) => !b.unlocked);
const bad = await L.showcase.save({ ...me.selection, backgroundId: locked.id }, 'ja');
assert.strictEqual(bad.ok, false); assert.strictEqual(bad.code, 'NOT_ELIGIBLE');
const ok = await L.showcase.save({ ...me.selection, horseId: me.horses[0].horseId, phraseId: 'hello' }, 'ja');
assert.ok(ok.ok, 'a save of owned things');
assert.strictEqual(ok.value.preview.horse.horseId, me.horses[0].horseId);
assert.ok(L.showcase.serverKpi().some((k) => k.name === 'showcase_save'), 'showcase_save on the server');
const self = (await L.showcase.card('local', 'ja')).value;
assert.strictEqual(self.relation, 'self'); assert.strictEqual(self.reportable, false);
assert.ok(!JP.test(JSON.stringify((await L.showcase.mine('en')).value.phrases)), 'the phrase list in English');

// KPI rows on the server's strict schema
assert.deepStrictEqual((await L.showcase.kpi('showcase_view', { source: 'cup_lobby', relation: 'other', neutral: false })).value, { name: 'showcase_view', s1: 'cup_lobby', s2: 'other', s3: 'card' });
assert.strictEqual((await L.showcase.kpi('showcase_view', { source: 'cup_lobby', relation: 'other', neutral: false, playerId: 'x' })).ok, false, 'no player id in the KPI');

// the share image by the real C# ShowcaseShare (WASM)
const root = join(here, '..', '..', '..');
const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const E = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;
E.Init(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'), readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8'));
const share = JSON.parse(E.ShowcaseShareCard(JSON.stringify(ja)));
assert.ok(share.ok);
assert.strictEqual(share.kind, 'showcase_card');
assert.strictEqual(share.name, ja.displayName);
assert.ok(share.shareText.endsWith('#ムチ一閃'));
const all = JSON.stringify(share);
assert.ok(!all.includes('demo_sc_1'), 'no player id in the share image');
assert.strictEqual(JSON.parse(E.ShowcaseShareCard(JSON.stringify(blk))).ok, false, 'a neutral card is not shared');
console.log(`round21-showcase OK — ${demo.length} demo players, ${me.backgrounds.length} backgrounds, ${me.phrases.length} phrases, share ${share.lines.length} lines`);
