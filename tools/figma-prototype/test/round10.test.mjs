// Node check of the round 10 paths used by unity.html, on the real server logic bundled for the browser (site/js/logic.js):
//  1) 支部の応援スタンプ (REQ-TEAMFEED-*): the demo team on TeamsService/TeamCore, the stamp palette with unlocks (play / pass /
//     direct-sale cosmetic), posting with the 10 s rule, automatic race items, cheering, mute and report
//  2) the bought season pass in the shop: the per-player product list (owned / purchasedThisSeason) after a demo purchase
// usage: node tools/figma-prototype/test/round10.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;

await L.bootstrap();
await L.recordConsent();

// ---- 1. team feed
const team = await L.teamDemo();
assert.equal(team.name, 'あおばRC');
let feed = await L.teamFeed();
assert.ok(feed.ok, JSON.stringify(feed));
const kinds = feed.value.items.map((x) => x.kind);
assert.ok(kinds.includes('race') && kinds.includes('stamp'), 'demo history: a teammate race result and stamps');
const race = feed.value.items.find((x) => x.kind === 'race');
assert.ok(race.race.place >= 1 && race.race.place <= 3 && !race.mine, 'race item: a teammate placed 1st–3rd');

let cat = await L.stamps();
const by = () => Object.fromEntries(cat.stamps.map((s) => [s.id, s]));
assert.equal(by().cheer.unlocked, true);
assert.equal(by().whip.unlocked, false);
assert.equal(by().whip.unlockText, 'レースに10回出走で解放');
assert.equal(by().pass_crown.unlocked, false);
assert.match(by().carrot.unlockText, /見た目ショップで購入（200コイン）/);
assert.ok(cat.stamps.every((s) => s.asset === 'stamp/' + s.id));

let r = await L.postStamp('whip');
assert.equal(r.code, 'STAMP_LOCKED');
r = await L.postStamp('cheer');
assert.ok(r.ok, JSON.stringify(r));
r = await L.postStamp('nice');
assert.equal(r.code, 'RATE_LIMITED', '1 stamp per 10 s');
feed = await L.teamFeed();
assert.equal(feed.value.items[0].stampId, 'cheer');
assert.equal(feed.value.items[0].mine, true);

// cheer the teammate's race result (actions are at least 2 s apart), then take it back
L.setClockMs(L.now() + 3000);
r = await L.reactToFeed(race.seq, 'nice');
assert.ok(r.ok, JSON.stringify(r));
feed = await L.teamFeed();
assert.equal(feed.value.items.find((x) => x.seq === race.seq).myReaction, 'nice');

// play unlocks: 10 lifetime races
await L.demoRaces(10);
cat = await L.stamps();
assert.equal(by().whip.unlocked, true);

// mute a member: their items and reactions disappear; unmute brings them back
const other = feed.value.items.find((x) => !x.mine && x.kind === 'stamp');
r = await L.muteMember(other.playerId, true);
assert.deepEqual(r.value.muted, [other.playerId]);
feed = await L.teamFeed();
assert.ok(feed.value.items.every((x) => x.playerId !== other.playerId));
await L.muteMember(other.playerId, false);
// report hides the item for me
feed = await L.teamFeed();
const target = feed.value.items.find((x) => !x.mine);
r = await L.reportFeed(target.seq, 'spam');
assert.ok(r.ok);
feed = await L.teamFeed();
assert.ok(feed.value.items.every((x) => x.seq !== target.seq));

// ---- 2. the pass card after the pass was bought (r10 fix)
let mine = await L.myShopProducts();
assert.equal(mine.personalized, true);
assert.equal(mine.products.find((p) => p.id === 'season_pass').owned, false);
r = await L.demoPurchase('season_pass');
assert.ok(r.ok, JSON.stringify(r));
mine = await L.myShopProducts();
const pass = mine.products.find((p) => p.id === 'season_pass');
assert.deepEqual([pass.owned, pass.purchasedThisSeason, pass.ownedReason], [true, true, 'season_pass']);
assert.equal(mine.products.find((p) => p.id === 'season_pass_plus').owned, true, 'one pass per season');
assert.equal((await L.purchaseIntent('season_pass')).code, 'ALREADY_PURCHASED');
cat = await L.stamps();
assert.equal(by().pass_crown.unlocked, true, 'the pass unlocks its stamp');
// a demo reset (new player) joins the same demo team again without errors
L.reset();
await L.bootstrap();
const again = await L.teamDemo();
assert.equal(again.teamId, team.teamId);
console.log('round10 OK — team feed (stamps, race items, cheer, mute, report) and the bought pass in the shop');
