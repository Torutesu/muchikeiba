// Node check of the round 23 ログイン中の端末 paths used by index.html (REQ-DEV-*, contracts/protocol.md §70), on the real server
// code bundled into site/js/logic.js: this device's check-in and the demo tablet (no notice: from before the list began), a new
// phone (one activity entry, the log, an essential KPI row), signing it out (its next request is SESSION_REVOKED, idempotent),
// 「この端末以外をすべてログアウト」 (the tablet too, never this device), the log in order, English without Japanese.
// usage: node tools/figma-prototype/test/round23-devices.test.mjs
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
const D = L.devices;

await L.bootstrap();
const v0 = await D.checkin();
assert.ok(v0.ok && v0.value.enabled, 'the list is on');
assert.strictEqual(v0.value.sessions.length, 2, 'this device and the demo tablet');
assert.strictEqual(v0.value.sessions[0].current, true, 'this device first');
assert.strictEqual(v0.value.sessions[0].model, 'iPhone', 'model family only');
assert.ok(!JSON.stringify(v0.value).includes('proto-install'), 'no install id in the answer');
assert.deepStrictEqual(D.kpi(), [], 'no notice for the first device or a session from before the list began');

// a new phone signs in → one activity entry (account, devices), the log, an essential KPI row
const n = await D.demoNewDevice();
assert.ok(n.ok && n.value.newDevice, 'a new device');
const act = await L.activity();
const e = act.value.items.find((x) => x.kind === 'new_device');
assert.ok(e && e.category === 'account' && e.link.screen === 'devices', 'the activity entry links to the device list');
assert.deepStrictEqual(D.kpi().map((k) => k.name + ':' + k.s1), ['new_device_notice:android']);
const v1 = (await D.view()).value;
const phone = v1.sessions.find((x) => x.model === 'Pixel');
const tablet = v1.sessions.find((x) => x.model === 'iPad');
assert.ok(phone.canSignOut && tablet.canSignOut, 'this device (3 days old) may sign out both');

// sign the phone out: its next request is SESSION_REVOKED; again → 0, not counted
assert.strictEqual((await D.revoked('phone')).value, false);
const s1 = await D.signOut(phone.sessionId);
assert.ok(s1.ok && s1.value.signedOut === 1);
assert.strictEqual((await D.revoked('phone')).value, true, 'the phone is signed out on the server');
const again = await D.signOut(phone.sessionId);
assert.ok(again.ok && again.value.signedOut === 0 && again.value.devices.revokesToday === 1, 'idempotent');
const cur = s1.value.devices.sessions.find((x) => x.current);
const self = await D.signOut(cur.sessionId);
assert.ok(!self.ok && self.code === 'DEVICE_IS_CURRENT', 'this device is not one of the others');

// all the others: the tablet too, never this device
const all = await D.signOutOthers();
assert.ok(all.ok && all.value.signedOut === 1 && all.value.devices.sessions.length === 1 && all.value.devices.sessions[0].current);
assert.strictEqual((await D.revoked('tablet')).value, true);
assert.deepStrictEqual(D.kpi().filter((k) => k.name === 'device_signout').map((k) => k.s1), ['one', 'others']);

// the log, newest first; English carries no Japanese
const log = (await D.log()).value.items.map((x) => x.kind);
assert.deepStrictEqual(log, ['signout_others', 'signout_device', 'new_device']);
const en = L.l10n.translate('新しい端末でログインがありました');
assert.strictEqual(en, 'A new device signed in');
for (const t of ['この端末はログアウトされました', 'この端末以外をすべてログアウトしました', 'Pixel（Android 15）をログアウトしますか？', 'iOSの端末', '最後の利用：11月9日'])
  assert.ok(!/[ぁ-んァ-ヶ一-龠]/.test(L.l10n.translate(t) ?? t), 'English: ' + t + ' → ' + L.l10n.translate(t));
console.log('round 23 devices: ok');
