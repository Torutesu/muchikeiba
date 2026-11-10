// Node check of the round 16 roster organiser paths used by index.html (REQ-ORG-*, contracts/protocol.md §44), on the real server
// code bundled into site/js/logic.js: the rows, the shared sort / filters / search, lock and favourite, a locked horse refused by
// the single retire, the bulk preview (every horse, reasons, nothing back), all or nothing, keyed, and the stale token.
// usage: node tools/figma-prototype/test/round16-roster.test.mjs
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

await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');
const partnerId = (await L.view()).flags.partnerHorseId;
assert.ok((await L.roster.demoHorses(6)).ok);

let v = (await L.roster.view()).value;
assert.strictEqual(v.total, 7);
assert.deepStrictEqual(v.actions, ['retire']);
assert.strictEqual(v.horses.find((h) => h.horseId === partnerId).blocks[0], 'partner');
assert.match(v.notice, /返ってきません/);

// the shared rules: rating high to low, dirt only, search folds hiragana
const byRating = L.roster.apply(v.horses, { sort: 'rating', favoritesFirst: false }).map((h) => h.rating);
assert.deepStrictEqual([...byRating].sort((a, b) => b - a), byRating);
assert.ok(L.roster.apply(v.horses, { surface: 'dirt' }).every((h) => h.surface !== 'turf'));
const name = v.horses[2].name;
const hira = name.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
assert.ok(L.roster.apply(v.horses, { q: hira }).some((h) => h.horseId === v.horses[2].horseId), 'search folds hiragana');
const course = L.roster.course('aoba_turf_1600');
assert.ok(['◎', '○', '△', '×'].includes(L.roster.aptitude(v.horses[0], course).mark));

// lock / favourite; a locked horse cannot be retired, even one at a time
const ids = v.horses.filter((h) => h.horseId !== partnerId).map((h) => h.horseId);
assert.deepStrictEqual((await L.roster.lock(ids[0], true)).value, { horseId: ids[0], locked: true });
assert.strictEqual((await L.roster.retire(ids[0])).code, 'HORSE_LOCKED');
assert.ok((await L.roster.favorite(ids[1], true)).ok);
v = (await L.roster.view()).value;
assert.strictEqual(L.roster.apply(v.horses, {})[0].horseId, ids[1], 'favourites first');

// preview: every horse, reasons, nothing back; refused → nothing retired
let p = (await L.roster.preview([ids[0], ids[1], ids[2], partnerId])).value;
assert.deepStrictEqual(p.horses.map((h) => h.reasons), [['locked'], [], [], ['partner']]);
assert.deepStrictEqual(p.refund, { paidCoins: 0, freeCoins: 0, materials: {}, items: {} });
assert.strictEqual(p.canConfirm, false);
const refused = await L.roster.bulk([ids[0], ids[1]], p.confirmToken, L.roster.newKey());
assert.strictEqual(refused.code, 'ROSTER_BULK_REFUSED');
assert.deepStrictEqual(refused.details.horses.map((h) => h.horseId), [ids[0]]);
assert.ok((await L.view()).horses.every((h) => h.status === 'active'), 'all or nothing');

// a stale token, then the keyed run (a repeat returns the first result)
p = (await L.roster.preview([ids[1], ids[2]])).value;
assert.strictEqual((await L.roster.bulk([ids[1], ids[2]], 'r1-00000000', L.roster.newKey())).code, 'ROSTER_BULK_STALE');
const key = L.roster.newKey();
const done = await L.roster.bulk([ids[1], ids[2]], p.confirmToken, key);
assert.ok(done.ok && done.value.count === 2);
assert.deepStrictEqual(await L.roster.bulk([ids[1], ids[2]], p.confirmToken, key), done);
const st = await L.view();
assert.deepStrictEqual(st.horses.filter((h) => h.status === 'retired').map((h) => h.id).sort(), [ids[1], ids[2]].sort());
console.log('round 16 roster organiser: OK');
