// Node check of the quality pass race play (docs/quality/race-play.md) in the WASM engine the prototype runs:
//  1) ruleset 1.4: the frame carries the tactics HUD (phase, go line, charge, rhythm ring); the press (Spur) in the window is the
//     hold and the release (SpurRelease) the go — 一閃 — then whips on the gold ring are 会心; the result carries the lesson from
//     re-simulated races (GoCounterfactual) and the 会心 count;
//  2) ruleset 1.3: no tactics in the frame, no lesson (the old race exactly);
//  3) the logic bundle: the prototype previews 1.4 in ranked, the shipped switch is practice only.
// usage: node tools/figma-prototype/test/quality-race.test.mjs
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
const commentary = readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8');
ex.SetAssist('off');

function ride(rulesetFile, seed, play) {
  ex.Init(readFileSync(join(root, 'contracts', rulesetFile), 'utf8'), commentary);
  ex.Start('practice', 'テストホース', '', seed);
  let t = 1000, f, holdFrom = -1;
  const phases = [], cues = [], subtitles = new Set();
  for (let i = 0; i < 40000; i++) {
    f = JSON.parse(ex.Frame(t)); t += 50;
    const tac = f.feel?.tactics;
    if (tac && phases[phases.length - 1] !== tac.phase) phases.push(tac.phase);
    for (const c of f.feel?.cues ?? []) cues.push(c.kind);
    if (f.subtitle) subtitles.add(f.subtitle);
    if (play && tac) {
      if (tac.goNow && holdFrom < 0) { ex.Spur(); holdFrom = f.tick; }
      else if (tac.gathering && f.tick - holdFrom >= 30) ex.SpurRelease();
      else if (tac.committed && tac.rhythm === 'gold' && f.whips > 0) ex.Spur();
    }
    if (f.done) break;
  }
  return { f, phases, cues, subtitles: [...subtitles] };
}

// 1) ruleset 1.4
const a = ride('ruleset-params.1.4.0.json', 7, true);
assert.ok(a.f.done, 'the race finished');
for (const p of ['wait', 'window', 'gonow', 'gather', 'go']) assert.ok(a.phases.includes(p), `phase ${p} seen: ${a.phases}`);
assert.ok(a.cues.includes('GoNow') && a.cues.includes('Go'), 'the go line cue and the go cue: ' + a.cues);
assert.ok(a.cues.includes('PerfectWhip'), 'a 会心 whip on the gold ring');
assert.ok(!a.cues.includes('WhipChance'), 'the 1.3 whip cue stays off in 1.4');
assert.ok(a.subtitles.some((s) => /一閃|仕掛けた/.test(s)), 'the commentary calls the go: ' + a.subtitles.slice(0, 8));
const r = a.f.result;
assert.ok(r && r.lesson && r.lesson.sims >= 2, 'the lesson comes from re-simulated races');
assert.ok(r.lesson.goCharge >= 25, 'the go was a held one (一閃): ' + r.lesson.goCharge);
assert.match(r.lesson.perfect, /^会心のムチ \d+\/\d+$/);
assert.ok((r.lesson.line === '仕掛けのタイミングは最善だった' && r.place <= 3) || r.lesson.line === '仕掛けを前後に動かしても、着順は変わらなかった' || /^仕掛けがあと\d\.\d秒(早|遅)ければ/.test(r.lesson.line), 'a data line (「最善」 only for a top-3 finish): ' + r.lesson.line + ' at ' + r.place);
console.log(`1.4: place ${r.place}, lesson "${r.lesson.line}" · ${r.lesson.perfect} (${r.lesson.sims} races)`);

// the same seed without touching the button goes at the auto mark: the lesson says going yourself would have helped, or nothing
const b = ride('ruleset-params.1.4.0.json', 7, false);
assert.ok(b.f.result.lesson && b.f.result.lesson.noDecision, 'no press: the auto go');
assert.ok(b.f.result.place >= r.place, `riding the go places at least as well (${r.place} vs ${b.f.result.place})`);

// 2) ruleset 1.3: the old race, nothing new
const c = ride('ruleset-params.default.json', 7, false);
assert.ok(c.f.done && !c.phases.length && !c.f.result.lesson, '1.3 has no tactics HUD and no lesson');

// 3) the logic bundle
const store = {};
Object.defineProperties(store, {
  getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
  setItem: { value: (k, v) => { store[k] = String(v); } },
  removeItem: { value: (k) => { delete store[k]; } },
});
globalThis.localStorage = store;
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;
assert.strictEqual(L.tactics().modes.ranked, true, 'the prototype previews 1.4 in ranked');
assert.strictEqual(L.tactics(false).modes.ranked, false, 'the shipped switch: ranked off');
assert.strictEqual(L.tactics().modes.practice, true, 'the shipped switch: practice on');
L.tactics(true);
console.log('quality race play OK');
process.exit(0);
