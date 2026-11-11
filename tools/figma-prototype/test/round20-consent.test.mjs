// Node check of the round 20 ad / analytics consent paths used by index.html (REQ-CNS-*, contracts/protocol.md §58), on the real
// server code bundled into site/js/logic.js: no pre-prompt in the FTUE, the ad_offer moment after it, once per version, the ATT
// answer as the personalised-ads choice, npa in the ad request, analytics off withholding optional client events (the
// essential consent_change still written), a policy update asking again on the home, and English for every prototype line.
// usage: node tools/figma-prototype/test/round20-consent.test.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
const V = L.consentVersions.privacyVersion;

await L.bootstrap();
await L.recordConsent();
let v = await L.privacy.view();
assert.strictEqual(v.prompt, null, 'no pre-prompt in the FTUE');
assert.strictEqual(v.required, true);
await L.seedDemo(3, [2, 2, 2]);
v = await L.privacy.view();
assert.strictEqual(v.prompt, 'ad_offer', 'after the FTUE: before the first ad offer');
assert.strictEqual(v.adRequest.npa, 1, 'non-personalised until chosen');

// 「続ける」 with ATT allowed (age unknown → still non-personalised, REQ-AD-009 kept)
assert.ok((await L.privacy.shown(V)).ok);
assert.ok((await L.privacy.platform({ os: 'ios', att: 'authorized' })).ok);
v = (await L.privacy.set({ privacyVersion: V, source: 'prompt', personalizedAds: true, analytics: true })).value;
assert.strictEqual(v.required, false);
assert.strictEqual(v.prompt, null);
assert.deepStrictEqual(v.personalizedAds, { value: true, effective: false, locked: 'age_unknown' });
assert.strictEqual((await L.ads()).adRequest.npa, 1);

// analytics off: optional client events withheld; consent_change is essential (written)
const before = L.serverKpiLog().length;
v = (await L.privacy.set({ privacyVersion: V, source: 'settings', analytics: false })).value;
assert.strictEqual(v.kpi.optional, false);
const k = await L.kpi([{ name: 'screen_view', at: L.now(), props: { screen: 'home' } }]);
assert.ok(k.ok && k.value.withheld === 1 && k.value.accepted === 1, JSON.stringify(k));
assert.ok(L.serverKpiLog().slice(before).some((r) => r.name === 'consent_change' && r.s1 === 'analytics' && r.s2 === 'off'));

// a new privacy policy version: asked again (home); the choices keep applying; reset restores the shipped version
v = await L.privacy.publishPolicy('2027-01-01');
assert.strictEqual(v.prompt, 'next_home');
assert.strictEqual(v.analytics.effective, false);
L.reset();
await L.bootstrap();
assert.strictEqual((await L.privacy.view()).policyVersion, V);

// English for the prototype's consent lines (proto-en.json + ui-en.json)
const app = readFileSync(join(here, '..', 'site', 'app.js'), 'utf8');
const start = app.indexOf('// ================================================================= round 20: 広告・分析の同意');
const end = app.indexOf('\n// =================================================================', start + 10);
const block = app.slice(start, end);
const ja = [...block.matchAll(/'([^'\n]*[぀-ヿ一-鿿][^'\n]*)'/g)].map((m) => m[1]).filter((t) => !t.includes('${'));
assert.ok(ja.length > 25, 'found the consent texts: ' + ja.length);
const missing = ja.filter((t) => { const en = L.l10n.translate(t); return !en || /[぀-ヿ一-鿿]/.test(en); });
assert.deepStrictEqual(missing, [], 'every consent line has English');
console.log(`round20 consent: ok (${ja.length} lines in English)`);
