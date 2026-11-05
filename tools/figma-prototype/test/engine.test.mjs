// Node check of the WebAssembly engine used by the web prototype (site/engine/_framework = the real C# engine).
//  1) every golden race in contracts/golden re-simulates in WASM to its recorded result hash
//  2) a full tutorial race and a 12-runner practice race run to the end through the same driver/HUD path as MuchiApp
// usage: node tools/figma-prototype/test/engine.test.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const ex = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;

const ruleset = readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8');
const commentary = readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8');
console.log('ruleset', ex.Init(ruleset, commentary));

const goldenDir = join(root, 'contracts', 'golden');
let n = 0;
for (const f of readdirSync(goldenDir).filter((x) => x.startsWith('race-') && x.endsWith('.json'))) {
  const g = JSON.parse(readFileSync(join(goldenDir, f), 'utf8'));
  const h = ex.ReplayGolden(JSON.stringify(g));
  assert.strictEqual(h, g.expected.resultHash, `${f}: WASM hash differs from native`);
  n++;
}
console.log(`golden races identical in WASM: ${n}`);

function run(mode, rider) {
  const info = JSON.parse(ex.Start(mode, 'テストホース', '', 12345));
  let t = 1000, last;
  for (let i = 0; i < 20000; i++) {
    rider(last);
    last = JSON.parse(ex.Frame(t));
    t += 16;
    if (last.done) break;
  }
  return { info, last };
}

const tut = run('tutorial', (s) => { if (s && (!s.departed || (s.remainingM < 300 && s.whips > 0 && Math.random() < 0.05))) ex.Spur(); });
assert.ok(tut.last.done, 'tutorial finishes');
assert.ok(tut.last.order.length >= 2 && tut.last.hash.length === 64);
console.log('tutorial', tut.info.distanceM + 'm', 'place', tut.last.finishPlace, 'of', tut.last.runners, 'time', tut.last.time, 'subtitle', JSON.stringify(tut.last.subtitle));

const pr = run('practice', (s) => { if (s && !s.departed) ex.Spur(); });
assert.ok(pr.last.done, 'practice finishes');
assert.strictEqual(pr.info.names.length, 12);
assert.ok(!pr.info.world.straight && pr.info.world.inner.length > 100 && pr.info.world.outer.length > 100);
assert.ok(tut.info.world.straight && tut.info.world.xShift < 0);
// CourseFrame: finish line at z=420 facing +Z — every finisher is past it with a near-zero yaw
for (const h of pr.last.horses) assert.ok(h[1] > 419 && (h[2] < 2 || h[2] > 358), 'finisher past z=420: ' + h);
console.log('practice', pr.info.distanceM + 'm', 'place', pr.last.finishPlace, 'of', pr.last.runners, 'time', pr.last.time);
console.log('ENGINE OK');
process.exit(0);
