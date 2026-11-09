// Node check of the round 15 アクセシビリティ設定 paths used by index.html (REQ-A11Y-*, contracts/protocol.md §41):
//  1) the real Muchi.Game RaceInput + Muchi.Client WhipHold in the WASM engine: holding the whip button from the final
//     straight gives the press + WhipHold.MaxRepeats spaced whips (normal input bytes through OfflineRace), tap mode is
//     unchanged, and the same race ridden with taps at the same ticks finishes in the same place (a hold is taps);
//  2) the tutorial: the hold is a tap there (no repeats);
//  3) the real server rules bundled in site/js/logic.js: defaults, full replace, strict values, one KPI row per change.
// usage: node tools/figma-prototype/test/round15-a11y.test.mjs
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
ex.SetAssist('off');

/** One practice race: hold the whip from `holdFromM` metres out (hold mode), or tap at the given ticks (tap mode). */
function ride(mode, seed, { holdFromM = 0, tapTicks = null } = {}) {
  assert.strictEqual(ex.SetWhipInput(mode), mode);
  ex.Start('practice', 'テストホース', '', seed);
  let t = 1000, f = JSON.parse(ex.Frame(t)), whipTicks = [], held = false, prev = f.whips;
  for (let i = 0; i < 40000 && !f.done; i++) {
    if (mode === 'hold') {
      const want = f.departed && f.remainingM <= holdFromM;
      if (want !== held) { ex.WhipHold(want); held = want; }
    } else if (tapTicks && tapTicks.includes(f.tick + 1)) ex.Spur();
    t += 50;
    f = JSON.parse(ex.Frame(t));
    if (f.whips < prev) whipTicks.push(f.tick);
    prev = f.whips;
  }
  if (held) ex.WhipHold(false);
  return { f, whipTicks };
}

// 1) hold vs tap on the same race
const rules = JSON.parse(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'));
const spacing = Math.max(rules.whipEffectTicks, rules.whipDiminishWindowTicks) + 6;
const maxRepeats = Math.floor(rules.maxWhips / 2) - 1;
const hold = ride('hold', 31, { holdFromM: 450 });
assert.ok(hold.f.done, 'the held race finished');
assert.strictEqual(hold.f.whipInput, 'hold');
assert.strictEqual(hold.whipTicks.length, 1 + maxRepeats, `one hold = the press + ${maxRepeats} repeats: ${hold.whipTicks}`);
for (let i = 1; i < hold.whipTicks.length; i++) assert.ok(hold.whipTicks[i] - hold.whipTicks[i - 1] >= spacing - 1, 'spaced like the §27 whip assist');
assert.strictEqual(hold.f.holdLeft, 0, 'the automatic whips of this race are used up');
const none = ride('tap', 31);
assert.strictEqual(none.whipTicks.length, 0, 'tap mode: nothing without a tap');
assert.strictEqual(none.f.whipInput, 'tap');
const tapped = ride('tap', 31, { tapTicks: hold.whipTicks });
assert.deepStrictEqual(tapped.whipTicks, hold.whipTicks, 'tapping at the same ticks gives the same whips');
assert.strictEqual(tapped.f.finishPlace, hold.f.finishPlace, 'a hold is taps: the same race ends in the same place');
console.log(`hold: whips at ticks ${hold.whipTicks.join(', ')} → place ${hold.f.finishPlace}; no input → place ${none.f.finishPlace}`);

// 2) the tutorial: the press is a tap, no repeats
ex.SetWhipInput('hold');
ex.StartTutorial(3);
let tf, t = 1000, held = false, n = 0, prev = null;
for (let i = 0; i < 20000; i++) {
  tf = JSON.parse(ex.Frame(t)); t += 50;
  if (prev != null && tf.whips < prev) n++;
  prev = tf.whips;
  if (!held && tf.departed && tf.remainingM <= 300) { ex.WhipHold(true); held = true; }
  if (tf.done) break;
}
ex.WhipHold(false);
assert.ok(tf.done && n === 1, 'tutorial: holding gives the one whip of the press only: ' + n);
ex.SetWhipInput('tap');

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
const d = await L.accessibility();
assert.deepStrictEqual({ textSize: d.textSize, colorMode: d.colorMode, reduceMotion: d.reduceMotion, haptics: d.haptics, subtitles: d.subtitles, oneHanded: d.oneHanded, whipInput: d.whipInput, rev: d.rev },
  { textSize: 'standard', colorMode: 'standard', reduceMotion: false, haptics: true, subtitles: true, oneHanded: 'off', whipInput: 'tap', rev: 0 }, 'defaults');
assert.strictEqual((await L.view()).accessibility.textSize, 'standard', 'in GET /v1/player');
const full = { textSize: 'largest', colorMode: 'cvd', reduceMotion: true, haptics: false, subtitles: true, oneHanded: 'left', whipInput: 'hold' };
const r = await L.setAccessibility(full);
assert.ok(r.ok && r.value.rev === 1 && r.value.textSize === 'largest');
const again = await L.setAccessibility(full);
assert.ok(again.ok && again.value.rev === 1, 'the same body changes nothing');
const kpi = L.serverKpiLog().filter((k) => k.name === 'a11y_setting_change');
assert.deepStrictEqual(kpi.map((k) => k.s1), ['textSize', 'colorMode', 'reduceMotion', 'haptics', 'oneHanded', 'whipInput'], 'one row per changed key');
assert.ok(kpi.every((k) => k.s3 === 'settings') && kpi.find((k) => k.s1 === 'haptics').s2 === 'off');
const partial = await L.setAccessibility({ textSize: 'large' });
assert.ok(partial.ok && partial.value.whipInput === 'tap' && partial.value.haptics === true, 'keys left out go back to the defaults');
assert.strictEqual((await L.setAccessibility({ textSize: 'huge' })).ok, false, 'unknown values are refused');
assert.strictEqual((await L.setAccessibility({ volume: 3 })).ok, false, 'unknown keys are refused');
console.log('ROUND 15 A11Y OK');
process.exit(0);
