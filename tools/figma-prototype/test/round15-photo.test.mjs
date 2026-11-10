// Node check of the round 15 フォトモード paths used by index.html (REQ-PHOTO-*, contracts/protocol.md §38): a time attack
// run in WASM pauses for a photo (PhotoModeModel / PhotoSnapshot: the same state as the live race, the race does not move,
// then resumes and finishes with the same hash as an untouched run), the camera stays in the limits and above the course,
// a ranked race is never paused, the result / replay entries, the card (no player id), and on the real server rules: the
// catalog unlocks, a fixed-price purchase through the cosmetics shop, the keyed photo record, captions, the KPI schema.
// usage: node tools/figma-prototype/test/round15-photo.test.mjs
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

/** Ride with the engine clock (16 ms frames) until `until(frame)` or the end; returns the last frame and the clock. */
function ride(t0, until = () => false) {
  let t = t0, last = null, started = false, whips = 0;
  for (let i = 0; i < 40000; i++) {
    if (last && last.gateOpen && !last.departed && !started) { ex.Spur(); started = true; }
    if (last && last.departed && whips < 3 && last.remainingM <= 380 - whips * 80) { ex.Spur(); whips++; }
    last = JSON.parse(ex.Frame(t));
    t += 16;
    if (last.done || until(last)) break;
  }
  return { last, t };
}

await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');
let v = await L.view();
const partner = v.horses.find((h) => h.id === v.flags.partnerHorseId);
const ta = await L.taConfig(partner.id, 'aoba_turf_1600');

// ---- an untouched run for the hash
ex.StartTimeAttack(JSON.stringify(ta.config), '');
const plain = ride(1000).last;
assert.ok(plain.done && plain.hash, 'reference run finished');

// ---- the same run paused for a photo midway
ex.StartTimeAttack(JSON.stringify(ta.config), '');
let r = ride(1000, (f) => f.departed && f.remainingM < 900);
const tickAt = r.last.tick;
const open = JSON.parse(ex.PhotoOpen('paused', r.t, ta.config.raceId, false, 0));
assert.ok(open.ok && open.paused, 'a solo race pauses for a photo');
assert.strictEqual(open.fingerprint, open.liveChecksum, 'the snapshot is the live race state (same checksum)');
assert.strictEqual(open.tick, tickAt);
assert.deepStrictEqual([open.source.kind, open.source.mode], ['paused', 'time_attack']);
for (let i = 0; i < 50; i++) r.t += 16;
assert.strictEqual(JSON.parse(ex.Frame(r.t)).tick, tickAt, 'paused: the race does not move');
// camera limits
let cam = JSON.parse(ex.PhotoCamera('raise', -500));
assert.ok(cam.heightDm === 3 && cam.heightM >= 0.3, 'never under the course');
cam = JSON.parse(ex.PhotoCamera('zoom', 9999));
assert.strictEqual(cam.distanceDm, 200);
cam = JSON.parse(ex.PhotoCamera('orbit', 200));
assert.ok(cam.orbitDeg >= -180 && cam.orbitDeg <= 180, 'orbit wraps around');
cam = JSON.parse(ex.PhotoCamera('reset', 0));
assert.ok(cam.inFrame, 'the reset camera frames the partner');
const pf = JSON.parse(ex.PhotoFrame());
assert.ok(pf.horses.length >= 1 && pf.cam[7] === 'Photo', 'a posed frame for the 3D view');
// caption + card
assert.strictEqual(JSON.parse(ex.PhotoCaption('馬券が当たった', 24)).ok, false, 'betting words are refused');
const cap = JSON.parse(ex.PhotoCaption('  ゴール前の一閃 ', 24));
assert.ok(cap.ok && cap.caption === 'ゴール前の一閃');
const card = JSON.parse(ex.PhotoCard('film', 'plain', 'hoof:880:200', cap.caption, 'masked'));
assert.strictEqual(card.kind, 'photo_image');
assert.strictEqual(card.watermark, 'ムチ一閃');
assert.ok(card.shareText.includes('ゴール前の一閃') && card.shareText.endsWith('#ムチ一閃'));
assert.ok(!JSON.stringify(card).includes('"local"'), 'no player id on the card');
assert.strictEqual(card.plates[0].rider, 'あなた');
assert.strictEqual(JSON.parse(ex.PhotoCard('film', '', '', '', 'hidden')).plates.length, 0, 'names can be hidden');
// close → resume → finishes with the reference hash
ex.PhotoClose(r.t);
const fin = ride(r.t).last;
assert.ok(fin.done && fin.hash === plain.hash, 'the photographed race finishes with the same hash');
console.log(`paused photo at tick ${tickAt}: checksum ${open.fingerprint.slice(0, 10)}, hash ${fin.hash.slice(0, 12)} = reference`);

// ---- result and replay entries; the ranked-looking race never pauses
const res = JSON.parse(ex.PhotoOpen('result', r.t, ta.config.raceId, false, 0));
assert.ok(res.ok && res.source.kind === 'result');
ex.PhotoClose(r.t);
const rep = JSON.parse(ex.PhotoOpen('replay', r.t, ta.config.raceId, true, 300));
assert.ok(rep.ok && rep.source.kind === 'replay' && rep.source.mode === 'ranked' && rep.tick === 300, 'the replay player photographs any race at its tick');
ex.PhotoClose(r.t);
const { config } = await L.raceConfig(partner.id, 'kirameki_turf_2000');
ex.StartConfig(JSON.stringify(config), 'local');
const mid = ride(1000, (f) => f.departed);
const refused = JSON.parse(ex.PhotoOpen('paused', mid.t, config.raceId, true, 0));
assert.ok(!refused.ok && refused.message.includes('結果画面かリプレイ'), 'a race with other people is never paused');

// ---- server rules: catalog, purchase, record, KPI
let c = await L.photoCatalog();
assert.ok(c.ok && c.value.enabled && c.value.looks.every((x) => x.unlocked), 'every look is free');
const sakura = c.value.frames.find((x) => x.id === 'sakura');
assert.ok(!sakura.unlocked && sakura.price === 150 && sakura.unlock.itemId === 'photo_frame_sakura');
const victory = c.value.frames.find((x) => x.id === 'victory');
assert.ok(!victory.unlocked && victory.unlockText.startsWith('実績「'));
const spec = card; // the record the screen sends is the card's spec
let save = await L.photoSave({ ...spec.spec, frameId: 'sakura' }, 'k-locked');
assert.ok(!save.ok && save.code === 'PHOTO_LOCKED', 'a locked frame cannot be saved: ' + JSON.stringify(save));
await L.seedDemo(2, [2, 2]); // earns free coins
const buy = await L.buyCosmetic('photo_frame_sakura');
assert.ok(buy.ok, 'bought at its fixed price: ' + (buy.ok ? '' : buy.message));
c = await L.photoCatalog();
assert.ok(c.value.frames.find((x) => x.id === 'sakura').unlocked, 'unlocked after the purchase');
save = await L.photoSave({ ...spec.spec, frameId: 'sakura' }, 'k1');
const again = await L.photoSave({ ...spec.spec, frameId: 'sakura' }, 'k1');
assert.ok(save.ok && again.ok && save.value.photo.id === again.value.photo.id && save.value.count === 1, 'keyed: a retry stores one record');
const bad = await L.photoSave({ ...spec.spec, source: { ...spec.spec.source, kind: 'paused', mode: 'ranked' } }, 'k2');
assert.ok(!bad.ok && bad.code === 'PHOTO_SOURCE_INVALID', 'the server refuses a paused ranked race too');
const list = await L.photos();
assert.ok(list.ok && list.value.photos.length === 1 && list.value.max === 30);
assert.ok((await L.photoDelete(save.value.photo.id)).ok);
const k1 = await L.photoKpi('photo_take', { source: 'paused', look: 'film' });
const k2 = await L.photoKpi('photo_share', { source: 'replay', framed: true });
assert.deepStrictEqual([k1.value, k2.value], [{ name: 'photo_take', s1: 'paused', s2: 'film' }, { name: 'photo_share', s1: 'replay', s2: 'framed' }]);
console.log(`catalog: ${c.value.looks.length} looks, ${c.value.frames.length} frames, ${c.value.stamps.length} stamps; record ${save.value.photo.id} saved and deleted`);
console.log('round 15 photo mode OK');
process.exit(0);
