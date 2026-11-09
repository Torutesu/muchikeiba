// Node check of the round 14 hall-of-fame paths used by index.html (REQ-HOF-*, contracts/protocol.md §34), on the real server
// code bundled into site/js/logic.js: the career kept from confirmed races (with the horse id), the retirement ceremony once
// (fixed-order highlights, idempotent acknowledgement), 殿堂入り and the frame once, paging, a friend's hall and visibility.
// usage: node tools/figma-prototype/test/round14-hall.test.mjs
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

// the partner's career from confirmed races (the horse id comes from the race entrant)
assert.ok((await L.hall.demoRaces(partnerId, 3, 2)).ok);
let c = await L.hall.career(partnerId);
assert.ok(c.ok);
assert.deepStrictEqual([c.value.career.races, c.value.career.wins, c.value.partner], [5, 3, true]);
assert.deepStrictEqual(c.value.progress.partnerRaces, { have: 5, need: 30 });
assert.strictEqual(c.value.qualifies, false);

// an empty hall, then a retirement that qualifies (wins), the frame once
let h = await L.hall.mine();
assert.ok(h.ok && h.value.total === 0 && h.value.frame.owned === false);
const cer = await L.hall.demoRetire('ソラノカナタ', 10, 4, null);
assert.ok(cer.ok && cer.value.inducted, 'ten wins: inducted');
assert.deepStrictEqual(cer.value.reasons, ['wins']);
assert.strictEqual(cer.value.rewardItemId, 'decor_hall_plaque_frame');
assert.strictEqual(cer.value.highlights[0].text, '通算14戦10勝', 'highlights in the fixed order, from the server');
assert.strictEqual(L.l10n.translate(cer.value.highlights[0].text), '14 races, 10 wins');
h = await L.hall.mine();
assert.strictEqual(h.value.pendingCeremonies.length, 1, 'the ceremony waits until acknowledged');
const a1 = await L.hall.ack(cer.value.horseId);
const a2 = await L.hall.ack(cer.value.horseId);
assert.ok(a1.ok && !a1.value.already && a2.value.already && a2.value.ackedAt === a1.value.ackedAt, 'ack is idempotent');
const cer2 = await L.hall.demoRetire('ミナモノヒカリ', 2, 3, 'オータムカップ');
assert.deepStrictEqual(cer2.value.reasons, ['tournament']);
assert.strictEqual(cer2.value.rewardItemId, null, 'the frame only once');
assert.strictEqual(cer2.value.highlights[0].kind, 'tournament_win');
assert.strictEqual(L.l10n.translate(cer2.value.highlights[0].text), 'Won the tournament "Autumn Cup"');
const cer3 = await L.hall.demoRetire('カゼノシルベ', 1, 2, null);
assert.strictEqual(cer3.value.inducted, false, 'one win: a ceremony, no plaque');
const items = (await L.view()).items ?? {};
assert.strictEqual(items.decor_hall_plaque_frame, 1);

// paging (newest first)
const p1 = await L.hall.mine(null, 1);
assert.strictEqual(p1.value.total, 2);
assert.strictEqual(p1.value.entries[0].horseName, 'ミナモノヒカリ');
const p2 = await L.hall.mine(p1.value.nextCursor, 1);
assert.strictEqual(p2.value.entries[0].horseName, 'ソラノカナタ');
assert.strictEqual(p2.value.nextCursor, null);

// a friend's hall; friends-only / private
const f = await L.hall.demoFriend();
assert.ok(f.ok);
const v = await L.hall.visit(f.value);
assert.ok(v.ok && v.value.relation === 'friend' && v.value.total === 3 && v.value.owner.displayName === 'アオバ');
assert.ok(!JSON.stringify(v.value).includes('blocked'), 'the block list never leaves the server');
assert.ok((await L.hall.setVisibility('private')).ok);
assert.strictEqual((await L.hall.mine()).value.visibility, 'private');
assert.strictEqual((await L.hall.visit('nobody')).code, 'NOT_FOUND');
console.log('round14 hall checks ok');
