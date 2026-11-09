// Node check of the round 14 マイリプレイ paths used by index.html (REQ-MYRP-*, contracts/protocol.md §37) on the real server
// code (site/js/logic.js) and the real engine in WebAssembly (site/engine/_framework):
//  1) a race built by the server's buildRaceConfig is ridden in WASM; its inputs + hash settle like a room → it shows as a
//     best moment / recent race; saving copies the log; rename (typed, moderated), favourite, public, delete
//  2) the replay data re-simulates in WASM (ReplayPlayer) to the same hash: speeds, camera on another horse, the last 200 m,
//     the share card; other players' ids are redacted and the hash still matches
//  3) a retired ruleset and a wrong hash say 「再生できません」 instead of playing; a friend's public replay plays
// usage: node tools/figma-prototype/test/round14-my-replays.test.mjs
import { readFileSync } from 'node:fs';
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
ex.Init(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'), readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8'));

await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');
const me = (await L.view()).horses[0];

async function race(whipFromM, trackId = 'aoba_turf_1600') {
  const { config } = await L.raceConfig(me.id, trackId);
  const sim = JSON.parse(ex.SimulateConfig(JSON.stringify(config), 'local', whipFromM));
  const ft = sim.finishTicks[sim.place - 1];
  const r = await L.applyRace(config.raceId, sim.place, config.entrants.length, { trackId, style: me.style, finishTick: ft >= 0 ? ft : null, whips: 0 }, config,
    { slot: sim.slot, hash: sim.hash, endTick: sim.endTick, inputs: sim.inputs, marginTicks: L.replays.marginTicks(sim.order, sim.finishTicks, sim.slot) });
  assert.ok(r.ok, JSON.stringify(r));
  return { config, sim };
}

// 1) races → recent / moments
const a = await race(400);
const b = await race(700, 'kirameki_turf_2000');
let v = (await L.replays.view()).value;
assert.strictEqual(v.enabled, true);
assert.strictEqual(v.used, 0);
const listed = [...v.moments, ...v.recent];
assert.deepStrictEqual(listed.map((x) => x.raceId).sort(), [a.config.raceId, b.config.raceId].sort(), 'both races can be saved');
assert.ok(listed.every((x) => x.expiresAt > L.now()), 'a real keep-until time');
const win = listed.find((x) => x.place === 1);
if (win) assert.strictEqual(win.moment, 'win', 'a win is a best moment');

const s = await L.replays.save(a.config.raceId, '差し切った日');
assert.ok(s.ok && !s.value.alreadySaved && s.value.view.used === 1, JSON.stringify(s));
assert.ok(L.replays.files().some((k) => k === `myreplays/local/${a.config.raceId}.json`), 'the copy is outside the swept replays/ prefix');
assert.strictEqual((await L.replays.save(a.config.raceId)).value.alreadySaved, true, 'saving twice keeps one');
assert.strictEqual((await L.replays.update(a.config.raceId, { replayTitle: 'http://spam.example' })).code, 'INVALID_NAME');
assert.strictEqual((await L.replays.update(a.config.raceId, { replayTitle: L.replays.ngSample() })).code, 'NG_NAME');
const fav = await L.replays.update(a.config.raceId, { favorite: true, public: true });
assert.ok(fav.ok && fav.value.saved.favorite && fav.value.saved.public);

// 2) the player in WASM: the same race, speeds, camera, last 200 m, share card
const d = (await L.replays.data(a.config.raceId)).value;
assert.strictEqual(d.replayTitle, '差し切った日');
assert.strictEqual(d.resultHash, a.sim.hash);
const info = JSON.parse(ex.ReplayOpen(JSON.stringify(d)));
assert.strictEqual(info.playable, true, JSON.stringify(info).slice(0, 200));
assert.strictEqual(info.hash, a.sim.hash, 're-simulated on the device to the same hash');
assert.strictEqual(info.ownSlot, a.sim.slot);
assert.ok(info.labels[info.ownSlot].includes('（あなた）'), 'camera labels: horse names, mine marked');
let f = JSON.parse(ex.ReplayFrame(1000));
assert.strictEqual(f.t, 1000);
assert.strictEqual(JSON.parse(ex.ReplayControl('cycle', 0)).speedLabel, '2×');
f = JSON.parse(ex.ReplayFrame(1000));
assert.strictEqual(f.t, 3000, '2× plays twice as fast');
JSON.parse(ex.ReplayControl('speed', 0.5)); f = JSON.parse(ex.ReplayFrame(1000));
assert.strictEqual(f.t, 3500);
const other = (info.ownSlot + 3) % info.names.length;
assert.strictEqual(JSON.parse(ex.ReplayControl('camera', other)).camera, other);
ex.ReplayControl('jump', 0);
f = JSON.parse(ex.ReplayFrame(0));
assert.ok(f.camera === other && f.remainingM <= 200.01 && f.remainingM > 150, `jump to the camera horse's last 200 m (${f.remainingM})`);
assert.strictEqual(f.horses.length, info.names.length);
assert.strictEqual(f.cam.length, 8);
ex.ReplayControl('seek', 1e9); f = JSON.parse(ex.ReplayFrame(16));
assert.ok(f.atEnd && f.t === f.durationMs);
const card = JSON.parse(ex.ReplayShareCard(''));
assert.ok(card.ok && card.watermark === 'ムチ一閃' && !card.shareText.includes('local'), 'the share card has no player id');

// 3) never a different race
const wrong = JSON.parse(ex.ReplayOpen(JSON.stringify({ ...d, resultHash: '0'.repeat(64) })));
assert.deepStrictEqual([wrong.playable, wrong.reason], [false, 'hash_mismatch']);
assert.ok(wrong.message.includes('再生できません'));
L.replays.demoRetired(true);
const retired = (await L.replays.data(a.config.raceId)).value;
assert.deepStrictEqual([retired.playable, retired.reason], [false, 'ruleset_retired']);
assert.strictEqual(JSON.parse(ex.ReplayOpen(JSON.stringify(retired))).message, '古いルールのレースのため、再生できません');
assert.strictEqual((await L.replays.view()).value.saved[0].playable, false, 'the list says it cannot be played');
L.replays.demoRetired(false);

// a friend's public replay (the demo friend's object, privacy rules on the owner's side)
const fc = await L.replays.friendConfig();
const fsim = JSON.parse(ex.SimulateConfig(JSON.stringify(fc.config), fc.playerId, 600));
assert.ok((await L.replays.demoFriendSave(fc.config, fsim)).ok);
const fl = (await L.replays.friendList()).value;
assert.strictEqual(fl.displayName, 'ハヤテ乗り');
assert.strictEqual(fl.replays.length, 1);
assert.strictEqual(fl.replays[0].favorite, undefined, 'no favourite flag for friends');
const fd = (await L.replays.friendData(fl.replays[0].raceId)).value;
assert.strictEqual(fd.owner, 'friend');
const fi = JSON.parse(ex.ReplayOpen(JSON.stringify(fd)));
assert.ok(fi.playable && fi.labels[fi.ownSlot].includes('（フレンド）'), 'friend replay plays; the owner\'s horse is marked');

// KPI: replay_share is accepted from the client
assert.ok((await L.kpi([{ name: 'replay_share', at: L.now(), props: { surface: 'my_replays' } }])).ok);
// delete removes the copy
assert.ok((await L.replays.remove(a.config.raceId)).value.deleted);
assert.ok(!L.replays.files().includes(`myreplays/local/${a.config.raceId}.json`));
console.log('round 14 マイリプレイ OK: list, save, rename, favourite, public, delete; WASM ReplayPlayer (speed, camera, last 200 m, share card); 再生できません; friend replay');
