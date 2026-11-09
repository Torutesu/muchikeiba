// Node check of the round 15 pre-race advice used by index.html (REQ-ADV-*, contracts/protocol.md §39), on the real server code
// bundled into site/js/logic.js and the C# mirror in WebAssembly: every shared vector gives the same answer in TS and in the
// WASM RaceAdvice.Compute, the lobby advice over today's courses (counts, never chances), a weekly challenge with the loan
// horse, the tutorial's fixed version, the KPI events through the server's batch check, and the lint on every line.
// usage: node tools/figma-prototype/test/round15-race-advice.test.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const store = {};
Object.defineProperties(store, {
  getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
  setItem: { value: (k, v) => { store[k] = String(v); } },
  removeItem: { value: (k) => { delete store[k]; } },
});
globalThis.localStorage = store;
createRequire(import.meta.url)(join(here, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;
const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const ex = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;
ex.Init(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'), readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8'));

// 1. the shared vectors: TS (server code) = C# (WASM) = the committed output
const vectors = JSON.parse(readFileSync(join(root, 'contracts', 'race-advice.vectors.json'), 'utf8')).cases;
const norm = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === undefined ? null : v)));
for (const c of vectors) {
  const ts = norm(L.computeAdvice(c.input));
  const cs = norm(JSON.parse(ex.AdviceCompute(JSON.stringify(c.input))));
  assert.deepStrictEqual(ts, norm(c.output), `${c.name}: TS`);
  assert.deepStrictEqual(cs, norm(c.output), `${c.name}: C# (WASM)`);
}
console.log(`advice vectors identical in TS and C#: ${vectors.length}`);

// 2. the lobby (ranked): today's courses, counted; then a focus change recomputed in C# equals the server for that focus
await L.bootstrap();
await L.recordConsent();
await L.grantPartner('アカツキ');
const r = await L.raceAdvice({ context: 'ranked' });
assert.ok(r.ok, 'ranked advice');
const a = r.value;
assert.ok(a.courseCount > 1 && a.whip === null && a.field === null, 'ranked: the course is drawn at the start, no field');
assert.ok(a.horses.every((h) => /^今日の\d+コースのうち\d+コースで/.test(h.checks[0].text)), 'ranked: counts of courses, not chances');
assert.ok(a.input && a.input.horses.length === a.horses.length, 'the input comes with the advice');
const other = await L.raceAdvice({ context: 'ranked', horseId: a.horses[0].horseId });
const device = JSON.parse(ex.AdviceCompute(JSON.stringify({ ...a.input, focusHorseId: a.horses[0].horseId })));
assert.deepStrictEqual(norm(device.lines), norm(other.value.lines), 'a focus change recomputed on the device = the server');
assert.deepStrictEqual(L.adviceLint(L.adviceTexts(a).map((t) => a.horses.reduce((x, h) => x.split(h.name).join(''), t))), [], 'no banned word');

// 3. weekly challenge: the loan horse is a candidate, CPUs counted, skills off
const v = await L.weeklyChallenges();
const ch = v.value.challenges[0];
const cr = await L.raceAdvice({ context: 'challenge', challengeId: ch.id });
assert.ok(cr.ok, 'challenge advice');
assert.ok(cr.value.horses.some((h) => h.horseId === `loan_${ch.loan.templateId}`), 'the loan horse is listed');
assert.strictEqual(cr.value.field.unknown, ch.cpuCount);
assert.ok(cr.value.whip && cr.value.whip.startRemainingM > 0, 'a known course gives the whip tip');
assert.ok(cr.value.horses.every((h) => h.checks.filter((k) => k.kind === 'skill').every((k) => k.mark === 'off')), 'no skills in a challenge');

// 4. tutorial: fixed
const t = await L.raceAdvice({ context: 'tutorial' });
assert.deepStrictEqual(t.value.lines.map((l) => l.text), ['合図が出たら、ムチ', 'ムチは間隔をあけて打つと伸びる']);

// 5. KPI through the server's ingestion (the batch schema itself is checked by server/test/race-advice.test.ts)
const k = await L.kpi([{ name: 'advice_view', at: L.now(), props: { context: 'ranked', horses: a.horses.length, suggested: !!a.suggestedHorseId } }, { name: 'advice_follow', at: L.now(), props: { context: 'ranked', followed: true } }]);
assert.ok(k.ok, 'advice_view / advice_follow accepted');
assert.deepStrictEqual(L.kpiLog().map((e) => e.name).slice(-2), ['advice_view', 'advice_follow'], 'kept in the KPI log');

// 6. English: every line of the lobby advice translates with the one catalog
const miss = L.adviceTexts(a).filter((s) => /[぀-ヿ一-鿿]/.test(a.horses.reduce((x, h) => x.split(h.name).join(''), L.l10n.translate(s) ?? s)));
assert.deepStrictEqual(miss, [], 'English for every advice line');
console.log('round 15 race advice OK');
process.exit(0);
