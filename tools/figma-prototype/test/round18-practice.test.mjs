// Node check of the round 18 練習レース paths used by index.html (REQ-PRAC-*, contracts/protocol.md §50): the catalog from the
// real server rules (MuchiLogic.practiceCatalog = GET /v1/practice/catalog), a practice race in the WASM PracticeSession (the
// config built on the device, the whip band = the advice check range, 0.5× in the last 400 m without changing the race), a
// same-seed restart that replays the same race with the ghost of the first attempt, a new seed, the result (debrief, advice
// line, ghost delta, no reward), photo pause on the practice clock, the KPI schema — and that the player state is unchanged.
// usage: node tools/figma-prototype/test/round18-practice.test.mjs
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

/** Ride on the practice clock (25 ms frames): START at the gate, whips from `whipFromM` out every 1.3 s of race time. */
function ride(t0, whipFromM = 400, until = () => false) {
  let t = t0, last = null, started = false, lastWhipTick = -1000;
  const frames = [];
  for (let i = 0; i < 60000; i++) {
    if (last && last.gateOpen && !last.departed && !started) { ex.Spur(); started = true; }
    if (last && last.departed && last.whips > 0 && last.remainingM <= whipFromM && last.tick - lastWhipTick >= 26) { ex.Spur(); lastWhipTick = last.tick; }
    last = JSON.parse(ex.PracticeFrame(t));
    frames.push(last);
    t += 25;
    if (last.done || until(last)) break;
  }
  return { last, t, frames };
}

await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');
const before = JSON.stringify(await L.view());

// ---- the catalog (read-only, REQ-PRAC-002)
const cat = await L.practiceCatalog();
assert.ok(cat.ok, 'catalog');
const c = cat.value;
assert.strictEqual(c.courses.length, L.master.tracks.length, 'every course');
assert.deepStrictEqual(c.strengths.map((s) => [s.id, s.cpuLevel, s.cpuStatPermille]), [['easy', 1, 780], ['normal', 3, 1000], ['strong', 4, 1000], ['top', 5, 1000]], 'strengths from the existing CPU definitions');
assert.ok(c.horses.length >= 1 && c.horses.some((h) => h.partner), 'own horses with the partner');
const cj = JSON.stringify(c);
const partner = c.horses.find((h) => h.partner);
const setup = { horseId: partner.id, trackId: 'bellmoor_turf_1200', going: 'firm', night: false, fieldSize: 6, strengthId: 'strong' };

// ---- the device refuses what cannot be raced
assert.strictEqual(ex.PracticeProblem(cj, JSON.stringify({ ...setup, fieldSize: 13 })), '頭数は2〜12頭です');
assert.strictEqual(ex.PracticeProblem(cj, JSON.stringify({ ...setup, going: 'sloppy' })), 'この馬場はこのコースにありません');
assert.strictEqual(ex.PracticeProblem(cj, JSON.stringify({ ...setup, night: true })), 'ナイターは照明のある競馬場だけです');
assert.strictEqual(ex.PracticeProblem(cj, JSON.stringify(setup)), '');
assert.strictEqual(JSON.parse(ex.PracticeBegin(cj, JSON.stringify({ ...setup, fieldSize: 1 }), '{}', 1, 'start')).ok, false);

// ---- attempt 1 (slow motion on, the whip band on)
const opts = JSON.stringify({ whipWindow: true, slowFinal: true, ghost: true });
const b1 = JSON.parse(ex.PracticeBegin(cj, JSON.stringify(setup), opts, 4242, 'start'));
assert.ok(b1.ok && b1.mode === 'practice' && b1.names.length === 6, 'a 6-runner practice race');
assert.ok(b1.practice.raceId.startsWith('practice_') && b1.practice.ghost === null && b1.practice.attempt === 1 && b1.practice.restart === 'none');
const band = b1.practice.band;
assert.ok(band && band.from === band.start + 50 && band.to === Math.max(0, band.start - 150), 'the whip band = the advice check range (+50 / −150 m)');
const r1 = ride(1_000_000, band.start);
assert.ok(r1.last.done, 'attempt 1 finished');
assert.ok(r1.frames.some((f) => f.practice.inBand) && r1.frames.some((f) => !f.practice.inBand), 'inside / outside the band');
assert.ok(r1.frames.some((f) => f.practice.slow), 'slow motion ran');
const slowFrames = r1.frames.filter((f) => f.practice.slow);
assert.ok(slowFrames.every((f) => f.remainingM <= 400), 'only in the last 400 m');
const res1 = JSON.parse(ex.PracticeResultJson());
assert.ok(res1.ok && res1.finished && res1.place >= 1 && res1.runners === 6);
assert.strictEqual(res1.noReward, '報酬はありません（練習）');
assert.strictEqual(res1.lines[res1.lines.length - 1], '報酬はありません（練習）', 'the no-reward line is last');
assert.strictEqual(res1.verdict, 'Followed', 'the advice comparison: whip from the advised point');
assert.ok(res1.adviceLine.startsWith('ムチはアドバイスどおり'));
assert.strictEqual(res1.ghostLine, '', 'no ghost line on attempt 1');

// ---- the same race at 1× gives the same hash (slow motion is only the clock)
const b1x = JSON.parse(ex.PracticeBegin(cj, JSON.stringify(setup), JSON.stringify({ whipWindow: true, slowFinal: false, ghost: false }), 4242, 'start'));
assert.strictEqual(b1x.practice.attempt, 2);
const r1x = ride(5_000_000, band.start);
assert.strictEqual(r1x.last.hash, r1.last.hash, 'slow motion does not change the race');
assert.ok(r1x.frames.every((f) => !f.practice.slow));
assert.ok(r1x.t - 5_000_000 < r1.t - 1_000_000, 'and 1× takes less real time');

// ---- same seed again with the ghost: the same race, the ghost replays the remembered finished attempt
const b2 = JSON.parse(ex.PracticeBegin(cj, JSON.stringify(setup), opts, 0, 'same_seed'));
assert.strictEqual(b2.practice.restart, 'same_seed');
assert.ok(b2.practice.ghost && b2.practice.ghost.timeMs > 0, 'the ghost of the last finished attempt');
const r2 = ride(9_000_000, band.start);
assert.strictEqual(r2.last.hash, r1.last.hash, 'same seed + same rider = the same race (the ghost changes nothing)');
assert.ok(r2.frames.some((f) => Array.isArray(f.ghostPoses) && f.ghostPoses.length === 1), 'the ghost pose is drawn');
const res2 = JSON.parse(ex.PracticeResultJson());
assert.strictEqual(res2.deltaMs, 0);
assert.strictEqual(res2.ghostLine, '前回と同じタイム');

// ---- a new seed: other rivals and gates; mid-race restart keeps the ghost
const b3 = JSON.parse(ex.PracticeBegin(cj, JSON.stringify(setup), opts, 0, 'new_seed'));
assert.strictEqual(b3.practice.restart, 'new_seed');
assert.notStrictEqual(b3.practice.seed, b1.practice.seed);
ride(13_000_000, 400, (f) => f.departed && f.remainingM < 900);
const b4 = JSON.parse(ex.PracticeBegin(cj, JSON.stringify(setup), opts, 0, 'same_seed'));
assert.ok(b4.practice.ghost, 'restarting mid-race keeps the last finished ghost');
// a new course drops the ghost
const b5 = JSON.parse(ex.PracticeBegin(cj, JSON.stringify({ ...setup, trackId: 'aoba_turf_1600', going: 'good' }), opts, 0, 'start'));
assert.strictEqual(b5.practice.ghost, null, 'another course: no ghost');

// ---- photo mode pauses a practice race on its own clock (§50.7)
let r = ride(20_000_000, 400, (f) => f.departed && f.remainingM < 1000);
const open = JSON.parse(ex.PhotoOpen('paused', ex.PracticeNow(r.t), b5.practice.raceId, false, 0));
assert.ok(open.ok && open.paused, 'a practice race pauses for a photo');
assert.deepStrictEqual([open.source.kind, open.source.mode], ['paused', 'practice']);
const tickAt = open.tick;
assert.strictEqual(JSON.parse(ex.PracticeFrame(r.t + 2000)).tick, tickAt, 'paused: the race does not move');
ex.PhotoClose(ex.PracticeNow(r.t + 2000));
r = ride(r.t + 2000);
assert.ok(r.last.done, 'the race resumes and finishes');

// ---- KPI: only course / field / strength / restart / place
const k = L.kpiLog().length;
const ok = await L.kpi([
  { name: 'practice_start', at: L.now(), props: { trackId: 'bellmoor_turf_1200', fieldSize: 6, strength: 'strong', restart: 'same_seed' } },
  { name: 'practice_finish', at: L.now(), props: { trackId: 'bellmoor_turf_1200', fieldSize: 6, strength: 'strong', place: res1.place } },
]);
assert.ok(ok.ok && L.kpiLog().length === k + 2, 'both KPI events accepted');
// (the strict props refusing inputs / seed / times are checked on the server schema: server/test/practice.test.ts)

// ---- practice granted nothing
const after = await L.view();
const strip = (v) => { const o = JSON.parse(typeof v === 'string' ? v : JSON.stringify(v)); delete o.serverNow; return JSON.stringify({ wallet: o.wallet, items: o.items, horses: o.horses, rating: o.rating, season: o.season, stats: o.stats, missions: o.missions, pass: o.seasonPass }); };
assert.strictEqual(strip(after), strip(before), 'wallet, items, horses, rating, season, stats, missions and pass are unchanged');
console.log('round 18 practice OK');
