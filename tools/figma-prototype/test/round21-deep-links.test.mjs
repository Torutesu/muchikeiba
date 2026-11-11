// Node check of the round 21 ディープリンク・再戦 paths used by index.html (REQ-LINK-*, contracts/protocol.md §63), on the real
// server code bundled into site/js/logic.js: share links (one link per target, the share text, no id in the URL), opening a link
// (routes by type, one neutral answer for a closed room or a made-up token), revoke, KPI without tokens, and the rematch
// (the window, someone who left, everyone in → a new room on the same conditions).
// usage: node tools/figma-prototype/test/round21-deep-links.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const store = {};
Object.defineProperties(store, {
  getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
  setItem: { value: (k, v) => { store[k] = String(v); } },
  removeItem: { value: (k) => { delete store[k]; } },
});
globalThis.localStorage = store;
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;
const K = L.links;

await L.bootstrap();

// share: friend / help / my room
const f = await K.create('friend');
assert.ok(f.ok, f.message);
assert.match(f.value.url, /^https:\/\/link\.muchi-issen\.example\/l\/[2-9a-hj-km-np-z]{22}$/);
assert.ok(!f.value.url.includes('local'), 'no player id in the URL');
assert.strictEqual(f.value.shareText, `ムチ一閃でフレンドになりませんか\n${f.value.url}`);
const f2 = await K.create('friend');
assert.strictEqual(f2.value.token, f.value.token, 'one link per target');
assert.strictEqual(f2.value.created, false);
const pass = K.demoMyRoom();
const room = await K.create('room', { passphrase: pass });
assert.ok(room.ok && room.value.expiresAt - Date.now() <= 30 * 60_000 + 5000, 'room links expire with the room');
assert.ok(!room.value.url.includes(pass), 'the passphrase is not in the URL');
const list = await K.list();
assert.strictEqual(list.value.links.length, 2);
assert.ok((await K.revoke(room.value.token)).value.revoked);

// open: the friend's links route by type; a closed room and a made-up token answer the same
assert.deepStrictEqual((await K.resolve((await K.demoIncoming('expired')).value)).value, { state: 'unavailable' }, 'a closed room (first demo, no room yet)');
const inRoom = await K.demoIncoming('room');
const r = await K.resolve(inRoom.value);
assert.deepStrictEqual([r.value.state, r.value.type, r.value.screen], ['ok', 'room', 'friend_room_join']);
assert.match(r.value.target.passphrase, /^\d{6}$/);
const joined = await K.joinRoom(r.value.target.passphrase);
assert.deepStrictEqual(joined.value.members, ['ミドリカワ', 'あなた'], 'joining is a separate, confirmed step');
const help = await K.resolve((await K.demoIncoming('help')).value);
assert.deepStrictEqual(help.value.target, { articleId: 'share_links' });
const fr = await K.resolve((await K.demoIncoming('friend')).value);
assert.strictEqual(fr.value.target.displayName, 'ミドリカワ');
const gone = await K.resolve((await K.demoIncoming('expired')).value);
const fake = await K.resolve('https://link.muchi-issen.example/l/k7mq3xphr2abcdefghjkmn');
assert.deepStrictEqual(gone.value, { state: 'unavailable' });
assert.deepStrictEqual(fake.value, gone.value, 'no oracle');
assert.strictEqual(K.parse(K.format(f.value.token).toUpperCase()), f.value.token, 'typed codes work');
const kpi = K.kpi();
assert.ok(kpi.some((k) => k.name === 'link_resolve' && k.s1 === 'room' && k.s2 === 'ok'));
assert.ok(!JSON.stringify(kpi).includes(f.value.token), 'no token in KPI');

// rematch
const R = L.rematch;
const fin = R.demoFinish();
assert.strictEqual(fin.places[0].name, 'あなた');
const w = await R.press();
assert.strictEqual(w.value.state, 'waiting');
assert.deepStrictEqual([w.value.pressed, w.value.eligible, w.value.you], [2, 3, 'pressed'], 'クロサキ left: 3 still in, 2 pressed');
assert.strictEqual((await R.press()).value.pressed, 2, 'double press is one press');
const o = await R.demoOthers();
assert.strictEqual(o.value.state, 'opened');
const rm = R.room(o.value.room.passphrase);
assert.deepStrictEqual(rm.members, ['ハヤテ', 'あなた', 'ナギサ']);
assert.strictEqual(rm.host, 'ハヤテ', 'the previous host');
assert.strictEqual(rm.conditions.trackId, 'aoba_turf_1600', 'same conditions');
console.log('round 21 deep links OK');
