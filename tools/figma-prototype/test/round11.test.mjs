// Node check of the round 11 paths used by index.html, on the real server logic bundled for the browser (site/js/logic.js):
// 図鑑 (obtained / seen / unknown with no name for unknown, counts, completion pays nothing), achievements unlocked by the
// demo week (races, courses, fired skills, a cup win, stable likes), claiming one tier and the rest, and equipping an
// achievement title — REQ-COL-*, REQ-ACH-*, contracts/protocol.md §22.
// usage: node tools/figma-prototype/test/round11.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;

await L.seedCollection();
let r = await L.collection();
assert.ok(r.ok, JSON.stringify(r));
const book = r.value;
assert.equal(book.completionRewards, false);
assert.match(book.notice, /報酬はありません/);
const horses = book.sections.horses;
assert.equal(horses.entries.length, horses.total);
assert.ok(horses.obtained >= 1 && horses.seen >= 1 && horses.unknown >= 1, JSON.stringify({ o: horses.obtained, s: horses.seen, u: horses.unknown }));
for (const e of horses.entries) {
  if (e.state === 'unknown') { assert.equal(e.name, null); assert.equal(e.stats, null); assert.ok(e.art.startsWith('collection/silhouette/')); }
  else { assert.ok(e.name); assert.ok(e.art.startsWith('collection/portrait/')); }
  if (e.state === 'seen') assert.equal(e.stats, null);
}
assert.equal(book.sections.courses.obtained, 5, 'five courses raced');
assert.equal(book.totals.completionPermille, Math.floor((book.totals.obtained * 1000) / book.totals.total));

r = await L.achievements();
assert.ok(r.ok);
const a = r.value;
const get = (id) => a.achievements.find((x) => x.id === id);
assert.ok(get('races').tier >= 1 && get('courses_all').progress === 5 && get('skills').progress >= 1);
assert.equal(get('tournament_win').tier, 1);
assert.equal(get('stable_likes').tier, 1);
assert.ok(a.totals.claimable >= 5);
assert.ok(a.achievements.every((x) => !/gacha|purchase|spend/i.test(x.metric)), 'no metric counts gacha or spending');
const v0 = await L.view();
const one = await L.claimAchievement('races', 1);
assert.ok(one.ok, JSON.stringify(one));
assert.equal((await L.view()).wallet.free, v0.wallet.free + one.value.reward.freeCoins);
assert.equal((await L.claimAchievement('races', 1)).code, 'ALREADY_CLAIMED');
const all = await L.claimAllAchievements();
assert.ok(all.ok && all.value.claimed.length === a.totals.claimable - 1);
assert.equal((await L.achievements()).value.totals.claimable, 0);

const tl = await L.titles();
const champ = tl.titles.find((t) => t.id === 'ach_champion');
assert.ok(champ.unlocked && champ.source === 'achievement' && champ.achievementId === 'tournament_win');
assert.ok((await L.equipTitle('ach_champion')).ok);
assert.equal((await L.titles()).equipped, 'ach_champion');
assert.equal((await L.equipTitle('ach_clockwork')).code, 'NOT_ELIGIBLE');
console.log('round 11 logic OK (collection, achievements, titles)');
