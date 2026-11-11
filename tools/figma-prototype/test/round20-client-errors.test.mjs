// Node check of round 20 クライアントのエラー報告 (REQ-CERR-*, contracts/protocol.md §60) as index.html runs it: the real
// ClientErrorModel / ErrorReporter in WASM (what window.onerror feeds) and the server's ingest in site/js/logic.js. A
// repeated error collapses, names and paths are scrubbed, the queue survives a reload (the saved JSON), a batch keeps its
// id across a failure, the consent stand-in decides attachPlayer, the store aggregates by the same fingerprint as C#.
// usage: node tools/figma-prototype/test/round20-client-errors.test.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;
await L.bootstrap();

const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const ex = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;
ex.Init(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'), readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8'));

const T0 = Date.UTC(2026, 10, 16, 1);
ex.CeInit('editor', 'proto', 'Browser', 'Web', T0, '');
const state = () => JSON.parse(ex.CeState());
const stack = 'TypeError: x\n    at Demo (/Users/alice/proj/site/app.js:120:7)\n    at boot (/Users/alice/proj/site/app.js:9:3)';
ex.CeOnError('TypeError: Cannot read properties of undefined (reading \'horse\') for ハヤテ', stack, 'home', T0);
ex.CeOnError('TypeError: Cannot read properties of undefined (reading \'horse\') for サクラ', stack, 'home', T0 + 10);
ex.CeOnError('RangeError: Invalid array length 4294967296', '', 'gacha_reveal', T0 + 20);
let s = state();
assert.strictEqual(s.items.length, 2, 'two distinct errors');
assert.strictEqual(s.items[0].count, 2, 'the repeat collapsed (the names differ but are scrubbed away)');
assert.ok(!JSON.stringify(s).includes('ハヤテ') && !JSON.stringify(s).includes('/Users/alice'), 'no player name or path in the queue');
assert.match(s.items[0].stack, /at Demo \(app\.js:120:7\)/, 'the path is cut to the file name');
assert.match(s.items[1].title, /RangeError: Invalid array length <n>/);

// a reload: the saved queue comes back (a fresh WASM runtime is not needed: the stored JSON is what the page keeps)
const saved = s.stored;
assert.ok(saved.includes('"queue"'), 'the queue is saved for the next start');

// the first send fails (offline): the batch keeps its id; the second attempt reuses it
ex.CeSetConsent(false);
ex.CeFlush(T0 + 1000);
await new Promise((r) => setTimeout(r, 0));
const b1 = ex.CeTakeOutbox();
assert.ok(b1, 'a batch is waiting');
ex.CeAnswer(0, '');
await new Promise((r) => setTimeout(r, 0));
assert.strictEqual(state().pending, 2, 'nothing lost after a failed send');
ex.CeFlush(T0 + 2_000_000);
await new Promise((r) => setTimeout(r, 0));
const b2 = ex.CeTakeOutbox();
assert.strictEqual(JSON.parse(b2).batchId, JSON.parse(b1).batchId, 'the retry carries the same batch id');
assert.strictEqual(JSON.parse(b2).attachPlayer, false, 'consent off → attachPlayer false');
const res = L.clientErrors.ingest(b2, true);
assert.strictEqual(res.status, 200);
assert.strictEqual(res.body.accepted, 2);
ex.CeAnswer(res.status, JSON.stringify(res.body));
await new Promise((r) => setTimeout(r, 0));
assert.strictEqual(state().pending, 0, 'sent');
assert.strictEqual(L.clientErrors.ingest(b2, true).body.duplicate, true, 'the same batch again is a duplicate');

// the ops view: aggregated by the fingerprint the device computed (the server recomputes the same)
const ops = L.clientErrors.list();
assert.deepStrictEqual(ops.groups.map((g) => g.count).sort(), [1, 2]);
assert.deepStrictEqual(new Set(ops.groups.map((g) => g.fingerprint)), new Set(s.items.map((i) => i.fingerprint)), 'device fingerprint = server fingerprint');
assert.strictEqual(L.clientErrors.samplesOf('local').length, 0, 'no player id kept (consent off)');

// a batch with a desync that carries inputs is refused (strict), and an oversized body is 413
const bad = JSON.parse(b2); bad.batchId = 'b_badbadbad1'; bad.items = [{ category: 'desync', at: T0, raceId: 'r1', tick: 3, mode: 'ranked', inputs: [1] }];
assert.strictEqual(L.clientErrors.ingest(JSON.stringify(bad), true).status, 400);
assert.strictEqual(L.clientErrors.ingest('x'.repeat(40000), true).status, 413);

// R20 integration (§58.10): the server keeps no player id while the analytics choice is off, even for attachPlayer: true
const V = (await L.privacy.view()).policyVersion;
const att = JSON.parse(b2); att.batchId = 'b_r20consent1'; att.attachPlayer = true;
assert.strictEqual(L.clientErrors.ingest(JSON.stringify(att), true).body.accepted, 2);
assert.strictEqual(L.clientErrors.samplesOf('local').length, 2, 'analytics on + attachPlayer → the id is kept');
await L.privacy.set({ privacyVersion: V, source: 'settings', analytics: false });
att.batchId = 'b_r20consent2';
assert.strictEqual(L.clientErrors.ingest(JSON.stringify(att), true).body.accepted, 2, 'the report is still accepted');
assert.strictEqual(L.clientErrors.samplesOf('local').length, 2, 'analytics off → no new sample carries the id');
await L.privacy.set({ privacyVersion: V, source: 'settings', analytics: true });
console.log('round 20 client errors: ok');
process.exit(0);
