// Node check of the round 19 画質・省電力・通信量 paths used by index.html (REQ-PERF-*, contracts/protocol.md §56), on the real
// C# (WASM) and the real server schema (site/js/logic.js): the device class and RenderProfile (auto by class, battery saver
// in menus only, reduce motion composes), the storage report over a catalog with low variants (rows, what 「すべてダウンロード」
// still fetches in each version, what clearing keeps), the KPI events through clientBatchSchema, the help article, and —
// the point of §56.5 — the same race driven at 60 fps and at 30 fps (and with stutter) ends with the same result hash.
// usage: node tools/figma-prototype/test/round19-performance.test.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;

const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const ex = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;
ex.Init(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'), readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8'));

// ---- device class and render profile
assert.strictEqual(ex.PerfClassify(JSON.stringify({ memoryMb: 2048, cores: 8 })), 'low');
assert.strictEqual(ex.PerfClassify(JSON.stringify({ memoryMb: 8192, cores: 8, software: true })), 'low', 'software GL is low');
assert.strictEqual(ex.PerfClassify(JSON.stringify({ memoryMb: 4096, cores: 6 })), 'mid');
assert.strictEqual(ex.PerfClassify(JSON.stringify({ memoryMb: 8192, cores: 8 })), 'high');
const R = (settings, ctx) => JSON.parse(ex.PerfResolve(JSON.stringify(settings), JSON.stringify({ deviceClass: 'mid', refreshHz: 60, ...ctx })));
const auto = R({}, {});
assert.deepStrictEqual([auto.tier, auto.targetFrameRate, auto.renderScale, auto.shadows, auto.urpQualityLevel], ['medium', 60, 0.85, 'hard', 1]);
assert.deepStrictEqual([R({}, { deviceClass: 'low' }).targetFrameRate, R({}, { deviceClass: 'high' }).shadows], [30, 'soft']);
const saverMenu = R({ batterySaver: true }, { inRace: false }), saverRace = R({ batterySaver: true }, { inRace: true });
assert.deepStrictEqual([saverMenu.targetFrameRate, saverRace.targetFrameRate], [30, 60], 'battery saver: 30 fps in menus, the race keeps 60');
assert.ok(!saverMenu.speedLines && !saverMenu.ambientMotion && !saverMenu.postProcessing && saverMenu.fovKick);
const reduced = R({}, { reduceMotion: true });
assert.ok(!reduced.speedLines && !reduced.fovKick && reduced.targetFrameRate === 60 && reduced.renderScale === 0.85, 'reduce motion removes motion, not weight');
assert.deepStrictEqual(R({ graphics: 'ultra', frameRate: 120 }, {}).settings, { graphics: 'auto', frameRate: 'auto', batterySaver: false, dataSaver: false }, 'corrupt values → defaults');

// ---- storage over a catalog with low variants
const sha = (s) => [...Array(64)].map((_, i) => '0123456789abcdef'[(s.charCodeAt(i % s.length) * 31 + i * 7) % 16]).join('');
const catalog = JSON.stringify({
  catalogVersion: 5, manifestVersion: 2, platform: 'ios', hash: 'x', baseUrl: 'https://cdn.test', urlTemplate: '{base}/{platform}/{sha256}/{file}',
  entries: [
    { key: 'horse/coat/default', file: 'horse/coat/default.bundle', sha256: sha('default'), size: 100, group: 'boot', required: true },
    { key: 'scene/venue/minato', file: 'scene/venue/minato.bundle', sha256: sha('minato'), size: 9000, group: 'race', required: false, low: { file: 'scene/venue/minato.low.bundle', sha256: sha('minato-low'), size: 3000 } },
    { key: 'voice/ja/name/n0000000000000001', file: 'voice/ja/name/n0000000000000001.bundle', sha256: sha('voice'), size: 50, group: 'ondemand', required: false },
  ],
});
const onDevice = { [sha('default')]: 100, [sha('minato-low')]: 3000, [sha('stale-old')]: 7 };
let rep = JSON.parse(ex.StorageReport(catalog, JSON.stringify(onDevice), 11, false));
const row = (k) => rep.rows.find((r) => r.kind === k).bytes;
assert.deepStrictEqual([row('required'), row('screens'), row('ondemand'), row('low'), row('partial'), row('stale')], [100, 0, 0, 3000, 11, 7]);
assert.strictEqual(rep.totalBytes, 3118);
assert.strictEqual(rep.clearableBytes, 3018);
assert.deepStrictEqual(rep.keep, [sha('default')], 'clearing keeps the required file only');
assert.strictEqual(rep.predownloadBytes, 9050, 'data saver off: the normal venue and the voice name are still missing');
rep = JSON.parse(ex.StorageReport(catalog, JSON.stringify(onDevice), 11, true));
assert.strictEqual(rep.predownloadBytes, 50, 'data saver on: only the voice name (the low venue is already here)');
assert.strictEqual(rep.bucket, 'lt_10mb');

// ---- KPI through the real schema, help article
assert.deepStrictEqual((await L.perfKpi('perf_setting_change', { setting: 'frameRate', value: '30', deviceClass: 'low' })).value, { name: 'perf_setting_change', s1: 'frameRate', s2: '30', s3: 'low' });
assert.strictEqual((await L.perfKpi('perf_setting_change', { setting: 'graphics', value: '30', deviceClass: 'low' })).ok, false, 'a value of another setting is refused');
assert.deepStrictEqual((await L.perfKpi('asset_predownload', { bucket: '50_200mb', variant: 'low' })).value, { name: 'asset_predownload', s1: '50_200mb', s2: 'low' });
await L.bootstrap();
const art = await L.helpArticle('data_storage', 'ja', 'context');
assert.ok(art.ok, art.message);
assert.match(art.value.body, /この端末にだけ/);
assert.ok(!/今だけ|残りわずか|倍|お得/.test(art.value.body));
assert.deepStrictEqual(art.value.links.map((l) => l.screen), ['storage', 'performance']);

// ---- REQ-PERF-010: the same race at 60 fps, 30 fps and with stutter → the same hash (inputs on the same ticks)
await L.recordConsent();
await L.grantPartner('アカツキ');
const v = await L.view();
const ta = await L.taConfig(v.flags.partnerHorseId, 'aoba_turf_1600');
/** Ride with frames every `stepMs` (+ jitter); inputs go in when the engine reaches fixed ticks, whatever the frame rate. */
function ride(stepMs, jitter = 0) {
  ex.StartTimeAttack(JSON.stringify(ta.config), '');
  let t = 1000, last = null, seed = 7;
  const plan = [['start', 0], ['whip', 520], ['whip', 600], ['whip', 680]];
  let k = 0, frames = 0;
  for (let i = 0; i < 60000; i++) {
    if (last && k < plan.length) {
      const [what, tick] = plan[k];
      if (what === 'start' ? last.gateOpen && !last.departed : last.tick >= tick) { ex.Spur(); k++; }
    }
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    t += stepMs + (jitter ? (seed % (2 * jitter + 1)) - jitter : 0);
    last = JSON.parse(ex.Frame(t)); frames++;
    if (last.done) break;
  }
  return { hash: last.hash, frames };
}
const f60 = ride(16), f30 = ride(33), stutter = ride(16, 9);
assert.ok(f60.hash && f30.frames < f60.frames * 0.6, `the 30 fps loop drew fewer frames (${f30.frames} vs ${f60.frames})`);
console.log(`same race: 60 fps ${f60.frames} frames, 30 fps ${f30.frames} frames, stutter ${stutter.frames} frames`);
assert.strictEqual(f30.hash, f60.hash, 'REQ-PERF-010: 30 fps = 60 fps');
assert.strictEqual(stutter.hash, f60.hash, 'REQ-PERF-010: a stuttering loop = 60 fps');
console.log('round 19 performance settings OK');
process.exit(0);
