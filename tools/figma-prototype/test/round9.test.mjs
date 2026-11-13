// Node check of the round 9 paths used by unity.html (docs/planning/06 §7 item 12 / §7.3, REQ-UXS-070..074):
//  1) replay share: a race built by the server's buildRaceConfig runs in WASM, ReplayShareModel re-simulates it to the same
//     hash, cuts the last 200 m (≤ 10 s) and builds the card (no player id); clip frames are posed with the camera rig
//  2) account-link prompt: day 3 after the FTUE, once only; after the first purchase; `account_link` once when linked
//  3) time attack: server-issued configs, ghost runs timed by the engine, the picker opens on フレンド and falls back to
//     上位; a run with a friend ghost alongside finishes and returns its replay log
// usage: node tools/figma-prototype/test/round9.test.mjs
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

function ride() {
  let t = 1000, last = null, started = false, whips = 0;
  for (let i = 0; i < 40000; i++) {
    if (last && last.gateOpen && !last.departed && !started) { ex.Spur(); started = true; }
    if (last && last.departed && whips < 3 && last.remainingM <= 380 - whips * 80) { ex.Spur(); whips++; }
    last = JSON.parse(ex.Frame(t));
    t += 16;
    if (last.done) break;
  }
  return last;
}

// ---- 1) replay share
await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');
let v = await L.view();
const partner = v.horses.find((h) => h.id === v.flags.partnerHorseId);
const { config, trackName } = await L.raceConfig(partner.id, 'kirameki_turf_2000');
ex.StartConfig(JSON.stringify(config), 'local');
const done = ride();
assert.ok(done.done && done.hash, 'race finished');
const sh = JSON.parse(ex.ShareClip(trackName));
assert.ok(sh.ok, 'race can be shared');
assert.strictEqual(sh.clip.hash, done.hash, 'the clip re-simulates to the live hash');
assert.ok(sh.clip.durationMs <= 10000 && sh.clip.startRemainingM <= 200.01 && sh.clip.finishAtMs > 0, 'last 200 m, ≤ 10 s, finish inside');
assert.strictEqual(sh.card.watermark, 'ムチ一閃');
assert.strictEqual(sh.card.horse, 'アカツキ');
assert.strictEqual(sh.card.course, trackName);
assert.strictEqual(sh.card.placeText, `${done.result.place}着 / 12頭`);
assert.strictEqual(sh.card.time, done.result.time);
assert.ok(!JSON.stringify(sh.card).includes('local'), 'no player id on the card');
assert.ok(sh.clip.modes.includes('Finish'), 'the camera ends side-on at the line');
const f0 = JSON.parse(ex.ClipFrame(0)), f1 = JSON.parse(ex.ClipFrame(sh.clip.durationMs));
assert.strictEqual(f0.horses.length, 12);
assert.ok(f0.remainingM > f1.remainingM && f1.remainingM === 0 && f0.cam.length === 8);
console.log(`share: ${sh.card.placeText} ${sh.card.time} ${sh.card.horse} / ${sh.clip.durationMs} ms from ${Math.round(sh.clip.startRemainingM)} m, cameras ${sh.clip.modes.join('→')}`);

// ---- 2) account-link prompt
let lstore = {};
const op = (o, a = {}) => { const r = JSON.parse(ex.LinkPrompt(o, JSON.stringify(lstore), JSON.stringify(a))); lstore = r.store; return r; };
const args = (day, ranked, context = 'Home') => ({ context, anonymous: true, day, online: true, deletion: false, partner: true, gacha: true, rankedRaces: ranked });
assert.strictEqual(op('eval', args(2, 3)).show, false, 'day 2: no');
assert.strictEqual(op('eval', args(3, 0)).show, false, 'day 3 inside the FTUE: no');
assert.strictEqual(op('eval', args(3, 3, 'Race')).show, false, 'never in a race');
// quality pass 2 (docs/quality/first-week.md): day 3 opens on its login bonus and goals — the prompt waits for a closed result
assert.strictEqual(op('eval', args(3, 3)).show, false, 'day 3: not on opening home');
const e3 = op('eval', args(3, 3, 'ResultClosed'));
assert.ok(e3.show && e3.trigger === 'Day3' && e3.ftueDone, 'day 3 after the FTUE: shown after a closed result');
assert.ok(op('eval', args(4, 3)).show, 'day 4: home may show it (a player who did not race on day 3)');
const sv = op('show', { trigger: 'Day3', ios: true }).view;
assert.strictEqual(sv.title, '機種変更でも相棒を引き継げます');
assert.strictEqual(op('eval', args(4, 3)).show, false, 'once only');
op('dismiss');
assert.strictEqual(lstore['muchi.link.prompt'], 'dismissed');
lstore = {};
assert.strictEqual(op('eval', args(1, 1, 'PurchaseComplete')).show, false, 'day 1, no purchase');
op('purchase');
assert.strictEqual(op('eval', args(1, 1, 'PurchaseComplete')).trigger, 'FirstPurchase');
assert.ok(op('eval', args(1, 1, 'PurchaseComplete')).show, 'after the first purchase: shown');
assert.strictEqual(op('linked', { provider: 'apple', at: 1 }).event.name, 'account_link');
assert.strictEqual(op('linked', { provider: 'apple', at: 2 }).event, undefined, 'account_link once');
console.log('link prompt: day 3 / first purchase, once only, account_link once');

// ---- 3) time attack ghosts
const ta = await L.taConfig(partner.id, 'aoba_turf_1600');
assert.strictEqual(ta.config.mode, 'timeattack');
assert.strictEqual(ta.config.entrants.length, 1);
const seeds = L.taGhostSeeds('aoba_turf_1600');
assert.strictEqual(seeds.filter((s) => s.kind === 'friends').length, 3);
const times = JSON.parse(ex.TaGhosts(JSON.stringify(seeds)));
assert.ok(times.every((t) => t.timeMs > 60000 && t.timeMs < 200000), 'every ghost finishes with an engine time');
const list = seeds.map((s) => ({ id: s.id, name: s.name, horse: s.horse, kind: s.kind, timeMs: times.find((t) => t.id === s.id).timeMs }));
const pk = JSON.parse(ex.PickGhosts(JSON.stringify(list), 'local', 0, '', ''));
assert.strictEqual(pk.tab, 'friends', 'opens on フレンド');
assert.ok(!pk.fellBack && pk.list.length === 3 && pk.selected === pk.list[0].id, 'fastest friend picked without a best');
const pkNone = JSON.parse(ex.PickGhosts(JSON.stringify(list.filter((g) => g.kind !== 'friends')), 'local', 0, '', ''));
assert.ok(pkNone.tab === 'top' && pkNone.fellBack && pkNone.note.length > 0, 'no friend ghosts → 上位');
const info = JSON.parse(ex.StartTimeAttack(JSON.stringify(ta.config), pk.selected));
assert.strictEqual(info.ghosts.length, 1);
const tr = ride();
assert.ok(tr.done && tr.ta && tr.ta.timeMs > 0 && tr.ta.ghostTimes[0] === list.find((g) => g.id === pk.selected).timeMs, 'the ghost replays to its recorded time beside the run');
assert.ok(Array.isArray(tr.ghostPoses) && tr.ghostPoses.length === 1, 'ghost poses come with every frame');
const mine = JSON.parse(ex.TaGhosts(JSON.stringify([{ id: 'local', name: '自分', horse: 'アカツキ', kind: 'me', log: tr.ta.log }])));
assert.strictEqual(mine[0].timeMs, tr.ta.timeMs, 'my run replays from its log to the same time (the 自分 ghost)');
const pkBest = JSON.parse(ex.PickGhosts(JSON.stringify([...list, { id: 'local', name: '自分', horse: 'アカツキ', kind: 'me', timeMs: tr.ta.timeMs }]), 'local', tr.ta.timeMs, '', ''));
assert.strictEqual(pkBest.tab, 'friends');
const tshare = JSON.parse(ex.ShareClip(ta.trackName));
assert.ok(tshare.ok && tshare.card.placeText === '完走' && tshare.card.mode === 'タイムアタック', 'time attack card: no place');
console.log(`time attack: ${tr.result.time} vs ${pk.list[0].name} ${pk.list[0].time}; picker opens on ${pk.tab}, without friends on ${pkNone.tab}`);
console.log('ROUND9 OK');
process.exit(0);
