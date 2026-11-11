// Node check of the round 19 引き継ぎコード paths used by index.html (REQ-TRF-*, contracts/protocol.md §54), on the real
// server code bundled into site/js/logic.js: issue (custom with the rules, generated once), the stored record holds no
// password, redeem from this device (confirm first: it has progress; one idempotency key; replay after a lost response),
// single use, the old device's cut-off, one answer for a wrong password and an unknown id, KPI with reason categories, English.
// usage: node tools/figma-prototype/test/round19-transfer-code.test.mjs
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
const T = L.transfer;

await L.bootstrap();
await L.seedDemo?.(1, [1]); // the local player has progress (horses, races)

// issue screen
const s0 = await T.status();
assert.ok(s0.ok && s0.value.enabled && s0.value.code === null, 'no code yet');
assert.deepStrictEqual(s0.value.rules.map((r) => r.id), ['length', 'charset', 'mix', 'common']);
assert.deepStrictEqual(T.problems('abc'), ['length', 'mix']);
assert.deepStrictEqual(T.problems('Ｈａｎｅｄａ２０２６！'), [], 'full-width typing is the same password');
const weak = await T.issue('Password1');
assert.ok(!weak.ok && weak.code === 'TRANSFER_PASSWORD_WEAK' && weak.details.rules[0] === 'common');
const gen = await T.issue(null);
assert.ok(gen.ok && /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(gen.value.password), 'generated password shown once');
const s1 = await T.status();
assert.strictEqual(s1.value.code.codeId, gen.value.codeId);
assert.ok(!JSON.stringify(s1.value).includes(gen.value.password), 'the status never returns the password');
assert.ok(!T.storedRecords().includes(gen.value.password) && !T.storedRecords().includes(gen.value.password.replace(/-/g, '')), 'the directory keeps only the hash');
assert.ok((await T.revoke()).value.revoked);

// redeem: the previous phone's code (another account) on this device
const old = await T.demoOld();
assert.ok(old.ok, old.message);
const again = await T.demoOld();
assert.strictEqual(again.value.codeId, old.value.codeId, 'the demo reuses its live code');
const wrong = await T.redeem(old.value.codeId, 'Wrong2026!', true, 'k-wrong');
const unknown = await T.redeem('ZZZ-ZZZ-ZZZ', 'Wrong2026!', true, 'k-unknown');
assert.strictEqual(wrong.code, 'TRANSFER_INVALID');
assert.deepStrictEqual({ code: wrong.code, message: wrong.message }, { code: unknown.code, message: unknown.message }, 'no oracle');
const c = await T.redeem(old.value.codeId.toLowerCase(), old.value.password, false, 'k-1');
assert.strictEqual(c.code, 'TRANSFER_CONFIRM_REQUIRED', 'this device has progress: confirm first');
assert.ok(c.details.horses >= 1);
assert.strictEqual(await T.oldDeviceCutoff(), null);
const ok = await T.redeem(old.value.codeId, old.value.password, true, 'k-1');
assert.ok(ok.ok, ok.message);
assert.strictEqual(ok.value.displayName, 'ハヤテ');
assert.match(ok.value.customToken, /^proto-custom-token\.demo_trf_old\./);
assert.ok(typeof (await T.oldDeviceCutoff()) === 'number', 'the old device is cut off');
const replay = await T.redeem(old.value.codeId, old.value.password, true, 'k-1');
assert.ok(replay.ok, 'a retry with the same key after a lost response gets a token again');
const used = await T.redeem(old.value.codeId, old.value.password, true, 'k-2');
assert.strictEqual(used.code, 'TRANSFER_INVALID', 'single use');
const kpi = T.kpi().map((k) => [k.name, k.s1, k.s2 ?? null]);
assert.deepStrictEqual(kpi.filter((k) => k[0] === 'transfer_redeem').map((k) => k[1] + ':' + (k[2] ?? '')), ['fail:invalid', 'fail:invalid', 'ok:', 'fail:invalid']);
assert.ok(kpi.some((k) => k[0] === 'transfer_issue' && k[1] === 'generated'));
const auditJson = JSON.stringify(T.audit());
assert.ok(!auditJson.includes(old.value.codeId.replace(/-/g, '')) && !auditJson.includes(old.value.password), 'the audit has no id or password');

// English (the rule lines come from the server)
const en = L.l10n.translate;
for (const t of ['8〜32文字', '半角の英数字と記号', '英字と数字を両方使う', 'よく使われるパスワードは使えません', 'IDまたはパスワードが違います', '別の端末に引き継がれました', 'データを引き継ぎました',
  'この端末のデータ（有償コイン310枚・馬3頭）は、引き継ぎの後に使えなくなります。', '発行は1日5回まで（今日 1回）。有効期限は発行から30日です。何度も間違えると、しばらく入力できなくなります。']) {
  const x = en(t);
  assert.ok(x && !/[぀-ヿ一-鿿]/.test(x), `English for ${t}: ${x}`);
}
console.log('round 19 transfer code: OK');
