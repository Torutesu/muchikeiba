// Node check of the round 9 scout paths used by unity.html (docs/planning/06 §6.5 / §7 item 7, REQ-GACHA-011..015):
//  1) the banner calendar from the server code (active + announced, sorted, real end times) and its rows / countdowns
//     from the Unity game layer's BannerListModel in WASM (no timer on permanent banners)
//  2) a real draw revealed by GachaRevealModel in WASM: rarest card last, the summary lists every result, NEW / duplicate
//     material exact, rarity as shape + text (+ color)
//  3) step-up price per step and its line; the pity meter and the carry-over rule; a pull 1 ms after the end is refused
// usage: node tools/figma-prototype/test/round9-gacha.test.mjs
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
const { dotnet } = await import(join(here, '..', 'site', 'engine', '_framework', 'dotnet.js'));
const { getAssemblyExports, getConfig } = await dotnet.create();
const ex = (await getAssemblyExports(getConfig().mainAssemblyName)).MuchiRace;
ex.Init(readFileSync(join(root, 'contracts', 'ruleset-params.default.json'), 'utf8'), readFileSync(join(root, 'engine', 'Muchi.Client', 'Resources', 'Muchi', 'commentary-ja.json'), 'utf8'));

const gacha = JSON.parse(readFileSync(join(root, 'server', 'master', 'gacha.json'), 'utf8'));
const NOW = Date.UTC(2026, 10, 6, 3); // 2026-11-06 12:00 JST, inside the pickup_ginga period
L.reset();
L.setClockMs(NOW);
await L.bootstrap();

// ---- 1) calendar
const list = L.bannerList();
assert.deepStrictEqual(list.banners.map((b) => b.id), ['pickup_ginga', 'pickup_akatsuki', 'stepup_paid', 'standard']);
const ginga = list.banners[0];
assert.strictEqual(ginga.lastDay, '2026-11-30');
const device = Date.now();
const view = JSON.parse(ex.GachaBanners(JSON.stringify(list), JSON.stringify(await L.gachaStatus()), device));
assert.strictEqual(view.rows[0].periodLine, '11月30日 23:59まで');
assert.ok(view.rows[0].hasCountdown && /^残り 24日 /.test(view.rows[0].countdown), view.rows[0].countdown);
for (const r of view.rows.slice(1)) assert.ok(!r.hasCountdown && r.countdown === null && r.periodLine === '常設', 'no timer without a real end: ' + r.id);
assert.ok(view.rows.every((r) => r.pityLine && r.pityLine.startsWith('交換pt 0 / 100')));
assert.match(view.rows[2].priceLine, /10回 500（10連のみ/);
const cds = JSON.parse(ex.GachaCountdowns(device + 1000));
assert.strictEqual(cds.texts.length, 4);
assert.strictEqual(cds.needsRefresh, false);
assert.strictEqual(JSON.parse(ex.GachaCountdowns(device + (ginga.endAtMs - NOW))).needsRefresh, true, 'reload at the real end');
console.log('calendar:', view.rows.map((r) => `${r.id} ${r.periodLine}${r.countdown ? ' ' + r.countdown : ''}`).join(' | '));

// ---- 2) a real 10-pull revealed by GachaRevealModel
const d = await L.draw('pickup_ginga', 10);
assert.ok(d.ok, d.message);
const names = Object.fromEntries(d.value.results.map((p) => [p.templateId, L.master.templates.find((t) => t.id === p.templateId).name]));
const plan = JSON.parse(ex.GachaReveal(JSON.stringify(d.value), JSON.stringify(names)));
const tier = { R: 1, SR: 2, SSR: 3 };
const tiers = plan.order.map((c) => tier[c.rarity]);
assert.deepStrictEqual(tiers, [...tiers].sort((a, b) => a - b), 'rarest last');
assert.strictEqual(plan.summary.length, 10);
assert.deepStrictEqual(plan.summary.map((c) => c.slot).sort((a, b) => a - b), [...Array(10).keys()], 'every result on the summary');
for (const c of plan.summary) {
  assert.ok(c.shape && c.text === c.rarity && c.color && c.frame, 'rarity by shape + text + color + frame');
  const p = d.value.results[c.slot];
  assert.strictEqual(c.duplicate, p.duplicate);
  assert.strictEqual(c.material, p.material);
  assert.strictEqual(c.badge, p.duplicate ? `ダブり → 覚醒素材 +${p.material}` : 'NEW');
}
assert.strictEqual(plan.newCount + plan.duplicateCount, 10);
assert.ok(plan.summaryLine.startsWith(`新規 ${plan.newCount}頭`));
assert.strictEqual(plan.spentLine, '無償 1,000 コインを使いました');
console.log('reveal:', plan.order.map((c) => c.shape + c.rarity).join(' '), '→', plan.summaryLine);

// ---- 3) pity meter, carry-over, step-up, the boundary
const st = await L.gachaStatus();
const g = st.groups.find((x) => x.group === 'pickup_ginga');
assert.strictEqual(g.points, 10);
assert.strictEqual(g.carryOver.toLabel, '恒常');
assert.strictEqual(g.carryOver.expires, false);
assert.match(g.carryOver.notice, /1:1で移ります。失効しません/);
assert.strictEqual(st.banners.find((x) => x.bannerId === 'pickup_ginga').coinsToExchange, 9000);
const odds = L.odds('stepup_paid');
assert.deepStrictEqual(odds.stepUp.steps.map((s) => s.priceTen), gacha.banners.find((b) => b.id === 'stepup_paid').stepUp.steps.map((s) => s.priceTen));
assert.strictEqual(L.odds('pickup_ginga').pickup.rate, '1.5000%');
// QA r9: the step-up banner shows no single / flat 10-pull price (step prices only); the screen falls back to step 1
const sb = L.bannerList().banners.find((b) => b.id === 'stepup_paid');
assert.deepStrictEqual([sb.singleAllowed, sb.priceSingle, sb.priceTen], [false, null, null]);
assert.deepStrictEqual([odds.singleAllowed, odds.priceSingle, odds.priceTen], [false, null, null]);
assert.match(odds.stepUp.steps[0].finalSlot.appliesTo, /それ以外は上の表/);
const texts = JSON.stringify([list, st, odds, L.odds('pickup_ginga'), view, plan]);
assert.ok(!/倍|通常価格|今だけ|残りわずか/.test(texts), 'no misleading wording');
// the step-up needs paid coins: the free-coin player is refused with INSUFFICIENT_COINS, single pulls with BAD_REQUEST
assert.strictEqual((await L.draw('stepup_paid', 10)).code, 'INSUFFICIENT_COINS');
assert.strictEqual((await L.draw('stepup_paid', 1)).code, 'BAD_REQUEST');
// just before the real end the pull goes through, 1 ms after it is refused with the end time (server clock decides)
// the demo clock keeps running after setClockMs (Date.now() + shift): stand 1 s before the end, not 1 ms (a slow draw crossed it)
L.setClockMs(ginga.endAtMs - 1000);
{ const r = await L.draw('pickup_ginga', 1); assert.ok(r.ok, JSON.stringify(r)); }
L.setClockMs(ginga.endAtMs + 1);
const closed = await L.draw('pickup_ginga', 1);
assert.strictEqual(closed.code, 'BANNER_CLOSED');
assert.strictEqual(closed.message, 'banner pickup_ginga ended at 2026-12-01 00:00 JST');
// …and the meter now shows the points carried over into the permanent group
const after = await L.gachaStatus();
assert.strictEqual(after.groups.find((x) => x.group === 'standard').points, 11);
assert.ok(!L.bannerList().banners.some((b) => b.id === 'pickup_ginga'));
L.setClockMs(null);
console.log('round 9 scout checks OK');
