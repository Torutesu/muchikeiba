// Node check of the round 12 かんたん操作 paths used by index.html (REQ-ASSIST-*, contracts/protocol.md §27):
//  1) the real Muchi.Client.InputAssistant in the WASM engine rides a practice race with no tap at all (start, rein,
//     whips go through OfflineRace's normal input path) and places far better than not touching the screen;
//  2) the tutorial is never assisted;
//  3) the real server rules bundled in site/js/logic.js: default off, three last places → the one-time suggestion, once.
// usage: node tools/figma-prototype/test/round12-assist.test.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const ex = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;
ex.Init(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'), readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8'));

function run(mode, level, seed) {
  assert.strictEqual(ex.SetAssist(level), level);
  ex.Start(mode, 'テストホース', '', seed);
  let t = 1000, last;
  for (let i = 0; i < 40000; i++) { last = JSON.parse(ex.Frame(t)); t += 50; if (last.done) break; }
  return last;
}

// 1) full auto vs no input, same seeds (the practice preset auto-starts both on the gate)
let placeFull = 0, placeNone = 0;
const seeds = [11, 12, 13, 14, 15, 16];
for (const s of seeds) {
  const full = run('practice', 'full', s);
  assert.ok(full.done && full.assist === 'full' && full.assistLabel === 'かんたん操作 ON', 'the assist rides and the HUD says so');
  assert.ok(full.assistCmds >= 3, 'start, rein and whips were sent: ' + full.assistCmds);
  assert.ok(full.whips < full.maxWhips, 'the assistant whipped');
  const none = run('practice', 'off', s);
  assert.strictEqual(none.assist, 'off'); assert.strictEqual(none.assistLabel, '');
  placeFull += full.finishPlace; placeNone += none.finishPlace;
}
placeFull /= seeds.length; placeNone /= seeds.length;
console.log(`practice avg place: full auto ${placeFull.toFixed(2)}, no input ${placeNone.toFixed(2)}`);
assert.ok(placeNone - placeFull >= 1, 'full auto places well above no input');
const w = run('practice', 'whip', 21);
assert.ok(w.done && w.assist === 'whip' && w.whips < w.maxWhips, 'the whip assist whips');

// 2) the tutorial: never assisted, even with the level set
ex.SetAssist('full');
ex.StartTutorial(1);
let tf, t = 1000;
for (let i = 0; i < 20000; i++) { tf = JSON.parse(ex.Frame(t)); t += 50; if (tf.done) break; }
assert.ok(tf.done && tf.assist === 'off' && tf.assistCmds === 0, 'the tutorial ignores the assist (REQ-ASSIST-006)');
assert.strictEqual(tf.finishPlace, 2, 'no whip in attempt 1 → a close 2nd, as without the assist');

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
assert.strictEqual((await L.assist()).level, 'off', 'default off');
assert.strictEqual((await L.view()).assist.level, 'off', 'in GET /v1/player');
let a = await L.demoLastPlaces(2);
assert.strictEqual(a.promptDue, false);
a = await L.demoLastPlaces(1);
assert.strictEqual(a.promptDue, true, 'three last places in a row');
const seen = await L.assistPromptSeen();
assert.ok(seen.ok && seen.value.promptShown && !seen.value.promptDue);
await L.demoLastPlaces(3);
assert.strictEqual((await L.assist()).promptDue, false, 'once only');
const set = await L.setAssist('whip', 'prompt');
assert.ok(set.ok && set.value.level === 'whip');
assert.strictEqual((await L.setAssist('turbo')).ok, false, 'unknown levels are refused');
console.log('ROUND 12 ASSIST OK');
process.exit(0);
