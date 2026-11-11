// Node check of the round 21 what's-new paths used by index.html (REQ-NEW-*, contracts/protocol.md §64), on the real server
// code bundled into site/js/logic.js: a new install never sees the sheet, the demo updater sees the newest note once
// (skipped count, numbers from data, a target that is never the shop), seen is idempotent and survives (server side), the
// past list in both languages (no Japanese left in English), the KPI rows on the server's schema, nothing granted.
// usage: node tools/figma-prototype/test/round21-release-notes.test.mjs
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
const JP = /[぀-ヿ㐀-鿿]/;

await L.bootstrap();
// a brand-new install (created after both releases, still in the FTUE) never gets the sheet
const fresh = (await L.releaseNotesCheck('1.2.0', 'ja')).value;
assert.strictEqual(fresh.show, null, 'a new install gets no sheet');
assert.ok(['ftue', 'new_install'].includes(fresh.reason), `reason ${fresh.reason}`);
assert.strictEqual((await L.releaseNotesCheck(null, 'ja')).value.reason, 'unknown_version', 'no app version → nothing');

// the demo updater: past the FTUE (partner + two races), the builds come out after the account was created; the FTUE check
// above moved the baseline, which the demo clears
await L.seedDemo(1, [2]);
L.setDayOffset(0);
const facts0 = (await L.releaseNotesFacts()).value;
assert.strictEqual(facts0.baseline, '1.2.0', 'the FTUE check moved the baseline');
await L.releaseNotesDemo();
const c = (await L.releaseNotesCheck('1.2.0', 'ja')).value;
assert.ok(c.show, `the updater sees the sheet (${c.reason})`);
assert.strictEqual(c.show.appVersion, '1.2.0');
assert.strictEqual(c.show.skipped, 1, '1.1.0 was skipped');
assert.ok(c.show.pages[0].body.includes('2秒ごと'), 'the cheer interval comes from data');
assert.ok(c.show.pages.every((p) => !p.target || !['shop', 'gacha', 'gacha_odds'].includes(p.target.id)), 'no page leads to the shop');
assert.deepStrictEqual((await L.releaseNotesSeen('1.2.0')).value, { marked: true, seen: ['1.2.0'] });
assert.strictEqual((await L.releaseNotesSeen('1.2.0')).value.marked, false, 'seen is idempotent');
assert.strictEqual((await L.releaseNotesCheck('1.2.0', 'ja')).value.reason, 'seen', 'never twice');
assert.strictEqual((await L.releaseNotesSeen('9.9.9')).ok, false, 'an unknown version is refused');

const ja = (await L.releaseNotes('1.2.0', 'ja')).value;
const en = (await L.releaseNotes('1.2.0', 'en')).value;
assert.deepStrictEqual(ja.notes.map((n) => n.appVersion), ['1.2.0', '1.1.0'], 'newest first');
assert.deepStrictEqual((await L.releaseNotes('1.1.0', 'ja')).value.notes.map((n) => n.appVersion), ['1.1.0'], 'only up to the app version');
assert.ok(!JP.test(JSON.stringify(en)), 'the English list has no Japanese');
assert.ok(!/今だけ|残りわずか|倍|お得|通常価格|オッズ/.test(JSON.stringify(ja)), 'no urgency, multiplier or betting wording');

for (const [name, props, row] of [
  ['release_notes_view', { appVersion: '1.2.0', stage: 'finished', page: 3, pages: 3 }, { name: 'release_notes_view', s1: '1.2.0', s2: 'finished', value: 3, count: 3 }],
  ['release_notes_target', { appVersion: '1.2.0', page: 1, kind: 'help', target: 'spectator_cheer' }, { name: 'release_notes_target', s1: '1.2.0', s2: 'help', s3: 'spectator_cheer', value: 1 }],
  ['release_notes_history', { source: 'tips' }, { name: 'release_notes_history', s1: 'tips' }],
]) assert.deepStrictEqual((await L.releaseNotesKpi(name, props)).value, row, name);
assert.strictEqual((await L.releaseNotesKpi('release_notes_history', { source: 'push' })).ok, false, 'an unknown source is refused');

const facts1 = (await L.releaseNotesFacts()).value;
assert.deepStrictEqual([facts1.free, facts1.paid, facts1.items], [facts0.free, facts0.paid, facts0.items], 'nothing is granted');
console.log(`round21-release-notes OK — ${ja.notes.length} versions, sheet ${c.show.appVersion} (${c.show.pages.length} pages)`);
