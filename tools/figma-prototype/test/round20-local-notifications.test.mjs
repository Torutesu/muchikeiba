// Node check of the round 20 device reminders used by index.html (REQ-LNOTIF-*, contracts/protocol.md §61), on the real server code
// bundled into site/js/logic.js: the digest in the player view (read-only), the shared planner over it (training session, daily bonus,
// weekly challenge, gift expiry), the push categories and quiet hours switching the local kinds, the daily cap, details off by
// default, English by the device language, the diff after a finished training, and no shop / urgency words.
// usage: node tools/figma-prototype/test/round20-local-notifications.test.mjs
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
const N = L.localNotify;

// a new player: onboarding, nothing planned, reminders off
await L.bootstrap();
let d = await N.digest();
assert.strictEqual(d.enabled, true);
assert.strictEqual(d.onboarding, true);
assert.strictEqual(d.categories.reminders, false, 'reminders is opt-in');
const snap = (o = {}) => ({ now: L.now(), locale: 'ja', permission: 'granted', showDetails: false, signedIn: true, digest: d, horseNames: {}, ...o });
assert.deepStrictEqual(N.plan(snap()).items, []);

// four days of play, a gift that expires in 2 days and a training session left open on the partner
d = await N.seedDemo();
assert.strictEqual(d.onboarding, false);
assert.ok(d.training.sessionId && d.training.trainedEver, 'the open session is in the digest');
assert.ok(d.gifts.length >= 1, 'the expiring gift is in the digest');
assert.strictEqual(d.loginBonus.unlocked, true);
let p = N.plan(snap());
let kinds = p.items.map((i) => i.kind);
assert.ok(kinds.includes('gift_expiring'), 'gift reminder: ' + kinds);
assert.ok(!kinds.includes('training_session') && !kinds.includes('daily_bonus'), 'reminders off → no training / daily bonus');
assert.ok(p.dropped.some((x) => x.kind === 'training_session' && x.reason === 'category_off'));
for (const r of N.rows(d)) assert.strictEqual(r.on, !!d.categories[r.category] && d.config.kinds.includes(r.kind));

// the pre-prompt's yes: reminders on (the push preferences, one screen for both)
assert.ok((await N.setCategory('reminders', true)).ok);
d = await N.digest();
assert.strictEqual(d.categories.reminders, true);
p = N.plan(snap());
kinds = p.items.map((i) => i.kind);
// the session may be inside quiet hours on the wall clock this runs at: then it is dropped for that reason
const tr = p.dropped.find((x) => x.kind === 'training_session');
assert.ok(kinds.includes('training_session') || ['quiet_hours', 'past'].includes(tr?.reason), 'training reminder or a stated reason: ' + JSON.stringify(p.dropped));
assert.ok(kinds.includes('daily_bonus') || p.dropped.some((x) => x.kind === 'daily_bonus'), 'daily bonus planned (or capped)');
const perDay = {};
for (const i of p.items) { const k = Math.floor((i.fireAt - d.nextDayAt) / 86_400_000); perDay[k] = (perDay[k] ?? 0) + 1; }
assert.ok(Object.values(perDay).every((n) => n <= d.config.dailyCap), 'the daily cap holds');
for (const i of p.items) {
  assert.ok(!/今だけ|残りわずか|お得|倍|ショップ/.test(i.title + i.body), 'no urgency or shop words: ' + i.body);
  assert.ok(!['shop', 'season_pass', 'scout'].includes(i.screen));
}

// switching the gifts category off in the push settings removes the local gift reminder
assert.ok((await N.setCategory('gifts', false)).ok);
d = await N.digest();
assert.ok(!N.plan(snap()).items.some((i) => i.kind === 'gift_expiring'));
assert.ok((await N.setCategory('gifts', true)).ok);
// quiet hours off / on are the push ones
assert.ok((await N.setQuietHours(null)).ok);
assert.strictEqual((await N.digest()).quietHours, null);
assert.ok((await N.setQuietHours({ startHour: 22, endHour: 8 })).ok);
d = await N.digest();

// details: off by default (no horse name); English by the device language
const names = Object.fromEntries((await L.view()).horses.map((h) => [h.id, h.name]));
const ja = N.plan(snap({ horseNames: names }));
for (const i of ja.items) for (const n of Object.values(names)) assert.ok(!i.body.includes(n), 'no player-typed name by default');
const en = N.plan(snap({ locale: 'en' }));
for (const i of en.items) assert.ok(!/[぀-ヿ一-鿿]/.test(i.title + i.body), 'English texts: ' + i.body);
assert.deepStrictEqual(en.items.map((i) => i.id), ja.items.map((i) => i.id), 'the same events in both languages');

// the training is finished: the next plan drops its reminder (the diff cancels it)
const prev = Object.fromEntries(ja.items.map((i) => [i.id, `${i.fireAt}|${i.title}|${i.body}`]));
assert.ok((await L.trainingFinish(d.training.sessionId, [], true)).ok);
d = await N.digest();
assert.strictEqual(d.training.sessionId, null);
const diff = N.diff(prev, N.plan(snap()).items);
assert.ok(ja.items.some((i) => i.kind === 'training_session') ? diff.cancel.some((id) => id.startsWith('lnotif.training_session.')) : true);
assert.deepStrictEqual(diff.added, []);

// KPI events pass the server's client schema
assert.ok((await L.kpi([{ name: 'lnotif_scheduled', at: L.now(), props: { kind: 'gift_expiring' } }, { name: 'lnotif_permission', at: L.now(), props: { result: 'later' } }])).ok !== false);
console.log(`round 20 local notifications OK — ${ja.items.length} planned (${ja.items.map((i) => i.kind).join(', ')})`);
