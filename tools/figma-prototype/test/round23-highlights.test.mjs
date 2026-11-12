// Node check of the round 23 レースの見どころ paths used by index.html (REQ-HL-*, contracts/protocol.md §72) on the real server code
// (site/js/logic.js) and the real engine + Muchi.Game HighlightsModel in WebAssembly (site/engine/_framework):
//  1) the golden replays re-simulated in WASM give exactly the shared vectors (= Muchi.Verifier highlights): device = verifier
//  2) a race ridden in WASM, settled and saved: its reel (1×, cuts, next / skip, 15–30 s), captions, commentary inside windows
//  3) the model's KPI rows go through the real ingest (highlight_view / highlight_share, optional, no race / player / tick)
//  4) share: the card; a replay link at the top moment (own public saved replay only, a bad tick refused), resolved with startTick
//  5) a wrong hash shows no reel; English captions
// usage: node tools/figma-prototype/test/round23-highlights.test.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const store = {};
Object.defineProperties(store, {
  getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
  setItem: { value: (k, v) => { store[k] = String(v); } },
  removeItem: { value: (k) => { delete store[k]; } },
});
globalThis.localStorage = store;
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;
const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const ex = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;
const res = (f) => readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', f), 'utf8');
ex.Init(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'), res('commentary-ja.json'));

// 1) device (WASM) = verifier on the golden replays
const vectors = JSON.parse(readFileSync(join(root, 'contracts', 'highlights.vectors.json'), 'utf8'));
let checked = 0;
for (const c of vectors.cases.filter((x) => x.focusSlot >= 0)) {
  const g = JSON.parse(readFileSync(join(root, 'contracts', 'golden', c.golden), 'utf8'));
  const data = { raceId: 'g', owner: 'me', resultHash: c.resultHash, focusSlot: c.focusSlot, rulesetVersion: g.log.config.ruleset?.rulesetVersion ?? '1.3.0', playable: true, reason: null, entrants: [], replayLog: g.log };
  const info = JSON.parse(ex.HighlightsOpenReplay(JSON.stringify(data), 'my_replays', false, 1, false));
  assert.strictEqual(info.available, true, c.golden);
  assert.deepStrictEqual(info.set, c.expected, `${c.golden} focus ${c.focusSlot}: WASM = the verifier's vectors`);
  checked++;
}
assert.ok(checked >= 10, 'every golden, own slot 0 and the last');
assert.strictEqual(readdirSync(join(root, 'contracts', 'golden')).filter((f) => /^race-.*\.json$/.test(f)).length * 3, vectors.cases.length, 'the vectors cover every golden');

// 2) a race ridden in WASM, settled like a room, saved and made public
await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');
const me = (await L.view()).horses[0];
const { config } = await L.raceConfig(me.id, 'aoba_turf_1600');
const sim = JSON.parse(ex.SimulateConfig(JSON.stringify(config), 'local', 450));
const ft = sim.finishTicks[sim.place - 1];
const applied = await L.applyRace(config.raceId, sim.place, config.entrants.length, { trackId: 'aoba_turf_1600', style: me.style, finishTick: ft >= 0 ? ft : null, whips: 0 }, config,
  { slot: sim.slot, hash: sim.hash, endTick: sim.endTick, inputs: sim.inputs, marginTicks: L.replays.marginTicks(sim.order, sim.finishTicks, sim.slot) });
assert.ok(applied.ok, JSON.stringify(applied));
assert.ok((await L.replays.save(config.raceId)).ok);
const d = (await L.replays.data(config.raceId)).value;
const info = JSON.parse(ex.HighlightsOpenReplay(JSON.stringify(d), 'my_replays', false, 1000, false));
assert.strictEqual(info.available, true);
assert.strictEqual(info.hash, sim.hash, 'the reel re-simulates to the race the room confirmed');
assert.ok(info.moments.length >= 1 && info.moments.length <= 3);
assert.ok(info.totalMs >= 15000 && info.totalMs <= 30000, 'a 15–30 s reel: ' + info.totalMs);
assert.strictEqual(info.moments.filter((m) => m.rank === 1).length, 1);
assert.strictEqual(info.transition, 'wipe');
assert.ok(info.moments.every((m) => m.caption && !/local/.test(m.subject)), 'captions, horse names only');
assert.ok(info.moments.filter((m) => m.slot === sim.slot).every((m) => m.subject.endsWith('（あなた）')));
assert.strictEqual(JSON.parse(ex.HighlightsOpenReplay(JSON.stringify(d), 'my_replays', false, 1000, true)).transition, 'cut', 'reduce motion: a plain cut');
JSON.parse(ex.HighlightsOpenReplay(JSON.stringify(d), 'my_replays', false, 1000, false));
let f = JSON.parse(ex.HighlightsFrame(0, 1000));
assert.strictEqual(f.index, 0);
assert.strictEqual(f.t, info.moments[0].startMs, 'the reel starts at the first window');
assert.strictEqual(f.camera, info.moments[0].slot, 'the camera on its horse');
assert.match(f.counter, new RegExp(`^見どころ 1 / ${info.moments.length}$`));
f = JSON.parse(ex.HighlightsFrame(1000, 2000));
assert.strictEqual(f.t, info.moments[0].startMs + 1000, '1× (never the replay speed)');
if (info.moments.length > 1) {
  ex.HighlightsControl('next');
  f = JSON.parse(ex.HighlightsFrame(0, 3000));
  assert.strictEqual(f.index, 1);
  assert.strictEqual(f.t, info.moments[1].startMs, '次へ: a cut to the next window');
}
ex.HighlightsControl('skip');
f = JSON.parse(ex.HighlightsFrame(0, 3000));
assert.strictEqual(f.done, true);
assert.strictEqual(f.progress, 1000);

// 3) KPI: the model's rows, accepted by the real ingest
const rows = JSON.parse(ex.HighlightsKpi());
assert.deepStrictEqual(rows.map((r) => r.name), ['highlight_view']);
assert.deepStrictEqual(rows[0].props, { surface: 'my_replays', top: info.set.moments.find((m) => m.rank === 1).kind, moments: info.moments.length });
assert.strictEqual(JSON.parse(ex.HighlightsKpi()).length, 0, 'drained once');
const ing = await L.kpi(rows);
assert.ok(ing.ok, JSON.stringify(ing));

// 4) share: the card always; the link only for an own public saved replay, at the top moment
let sh = JSON.parse(ex.HighlightsShare('', true));
assert.strictEqual(sh.kind, 'highlight_image');
assert.ok(sh.lines[0] && sh.shareText.startsWith(sh.lines[0]), 'the card carries the top caption');
assert.ok(!sh.shareText.includes('local'), 'no player id');
assert.strictEqual(sh.linkNote, '保存して公開すると、リンクで送れます', 'not public yet: the note');
const card = JSON.parse(ex.HighlightsShareCard('', 4000));
assert.strictEqual(card.ok, true);
const cardKpi = JSON.parse(ex.HighlightsKpi());
assert.deepStrictEqual(cardKpi.map((r) => [r.name, r.props.via]), [['highlight_share', 'card']]);
assert.ok((await L.kpi(cardKpi)).ok);
assert.strictEqual((await L.links.create('replay', { raceId: config.raceId, startTick: sh.startTick })).code, 'NOT_FOUND', 'a private replay has no link');
assert.ok((await L.replays.update(config.raceId, { public: true })).ok);
JSON.parse(ex.HighlightsOpenReplay(JSON.stringify(d), 'my_replays', true, 5000, false));
ex.HighlightsFrame(0, 5000); ex.HighlightsKpi();
sh = JSON.parse(ex.HighlightsShare('', true));
assert.strictEqual(sh.linkNote, '', 'public: the link row is open');
assert.strictEqual(JSON.parse(ex.HighlightsShare('', false)).linkNote, 'リンクはオンラインで送れます', 'offline: wait for the network');
assert.strictEqual(sh.startTick, info.set.moments.find((m) => m.rank === 1).startTick, 'the link opens at the top moment');
for (const bad of [-1, 72001, 1.5, '10']) assert.strictEqual((await L.links.create('replay', { raceId: config.raceId, startTick: bad })).code, 'BAD_REQUEST', String(bad));
const made = await L.links.create('replay', { raceId: config.raceId, startTick: sh.startTick });
assert.ok(made.ok, JSON.stringify(made));
assert.ok(!made.value.url.includes(String(sh.startTick)) && !made.value.url.includes('local'), 'the URL is only the token');
const linked = JSON.parse(ex.HighlightsShareLink(JSON.stringify(made.value), 6000));
assert.strictEqual(linked.ok, true);
assert.ok(linked.shareText.includes('/l/'));
assert.deepStrictEqual(JSON.parse(ex.HighlightsKpi()).map((r) => [r.name, r.props.via]), [['highlight_share', 'link']]);
const opened = await L.links.resolve(made.value.url);
assert.strictEqual(opened.value.state, 'ok');
assert.strictEqual(opened.value.target.startTick, sh.startTick, 'the resolved link says where to start');
assert.strictEqual((await L.links.create('replay', { raceId: config.raceId, startTick: sh.startTick })).value.created, false, 'the same tick: the same link');

// 5) a wrong hash: no reel; English
const bad = JSON.parse(ex.HighlightsOpenReplay(JSON.stringify({ ...d, resultHash: '0'.repeat(64) }), 'my_replays', false, 1, false));
assert.strictEqual(bad.available, false);
assert.strictEqual(bad.message, '見どころを再生できません');
ex.SetLanguage('en', res('commentary-en.json'), res('server-en.json'), res('ui-en.json'));
const en = JSON.parse(ex.HighlightsOpenReplay(JSON.stringify(d), 'my_replays', false, 1, false));
assert.ok(en.moments.every((m) => !/[぀-ヿ一-鿿]/.test(m.caption)), 'English captions: ' + en.moments.map((m) => m.caption).join(' | '));
assert.ok(en.moments.filter((m) => m.slot === sim.slot).every((m) => m.subject.endsWith(' (you)')));
assert.match(JSON.parse(ex.HighlightsFrame(0, 1)).counter, /^Highlight 1 \/ \d$/);
ex.SetLanguage('ja', res('commentary-ja.json'), '', '');
console.log(`round 23 highlights OK — ${checked} golden rows = the verifier's vectors in WASM, reel of ${info.moments.length} moments (${info.totalMs} ms), card + link at tick ${sh.startTick}`);
process.exit(0);
