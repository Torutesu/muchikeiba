// Node check of the round 18 quick chat paths used by index.html (REQ-QCHAT-*, contracts/protocol.md §52), on the real server
// code bundled into site/js/logic.js: the picker in both languages, a post with a checked value, the 15 s rule, phrases in
// the shared feed, a mention of the player from a demo teammate, and the both-way block.
// usage: node tools/figma-prototype/test/round18-quick-chat.test.mjs
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
await L.teamDemo();

// the picker: phrases (JA / EN pairs), the values of my own state, members to name
let p = (await L.quickChat('ja')).value;
assert.ok(p.enabled && p.teamId, 'in the demo branch');
assert.ok(p.phrases.length >= 15);
assert.equal(p.phrases.find((x) => x.id === 'run_together').qchatTemplate, '{course}で一緒に走ろう');
assert.ok(p.options.player.length >= 2, 'demo teammates can be named');
assert.ok(p.options.course.length >= 4);
const en = (await L.quickChat('en')).value;
assert.equal(en.phrases.find((x) => x.id === 'run_together').qchatTemplate, "Let's race together at {course}");
assert.ok(en.options.course.every((o) => !/[ぁ-ヿ一-鿿]/.test(o.qchatValue)), 'course names in English');

// a post with a checked value; the 15 s rule; free text never accepted
let r = await L.postQuickChat('run_together', { course: 'kirameki_turf_2000' });
assert.ok(r.ok, JSON.stringify(r));
r = await L.postQuickChat('otsukare', {});
assert.equal(r.code, 'RATE_LIMITED');
r = await L.postQuickChat('run_together', {});
assert.equal(r.code, 'BAD_REQUEST', 'a missing value');
L.setClockMs(L.now() + 16_000);
r = await L.postQuickChat('time_report', { time: 'aoba_turf_1600' });
assert.equal(r.code, 'NOT_ELIGIBLE', 'no time-attack record of mine');

// the shared feed: my phrase in my language; a teammate names me (mention → my activity)
let feed = (await L.teamFeed(null, 'ja')).value;
const mine = feed.items.find((x) => x.kind === 'qchat' && x.mine);
assert.equal(mine.qchat.qchatText, 'きらめき競馬場 芝2000mで一緒に走ろう');
feed = (await L.teamFeed(null, 'en')).value;
assert.equal(feed.items.find((x) => x.kind === 'qchat' && x.mine).qchat.qchatText, "Let's race together at Kirameki Racecourse, Turf 2000 m");
for (let i = 0; i < 3; i++) { L.setClockMs(L.now() + 11_000); await L.teamActivity(); }
feed = (await L.teamFeed(null, 'ja')).value;
const toMe = feed.items.find((x) => x.kind === 'qchat' && x.qchat.mentionsMe);
assert.ok(toMe, 'a teammate named me');
assert.match(toMe.qchat.qchatText, /さん(ナイス！|、ありがとう！|、おめでとう！)$/);

// a stamp reaction on a phrase
r = await L.reactToFeed(toMe.seq, 'nice');
assert.ok(r.ok, JSON.stringify(r));

// the one block list hides phrases both ways: after I block the teammate, they cannot be named and their phrases are gone
r = await L.muteMember(toMe.playerId, true);
assert.ok(r.ok);
feed = (await L.teamFeed(null, 'ja')).value;
assert.ok(!feed.items.some((x) => x.kind === 'qchat' && x.playerId === toMe.playerId));
p = (await L.quickChat('ja')).value;
assert.ok(!p.options.player.some((o) => o.ref === toMe.playerId));
await L.muteMember(toMe.playerId, false);
console.log('round 18 quick chat: ok');
