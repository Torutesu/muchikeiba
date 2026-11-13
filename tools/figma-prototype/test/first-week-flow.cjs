// Quality pass 2 — the first week (docs/quality/first-week.md, REQ-GOAL-013..015) in the browser, on the real rules:
//  a) day 1, a diligent new player (login bonus, 3 races, the partner trained twice): one 「まとめて受け取る」 ends on what
//     tomorrow brings; home's 今日 rung then says 「明日：…」 (no 5/5 figure); the partner plate shows its stage pips, 「調教 +N」,
//     「今日 +N」 and how far the next stage is; the はじめの10歩 rung opens where the step is done (never the shop);
//  b) day 2: the login bonus toast, the plate says 「昨日 +N」; 目標 shows the tomorrow line and 「やってみる ›」;
//  c) day 3 opens on home (no account-link prompt on opening; it waits for a closed result);
//  d) English and the largest text size: home and 目標 with no Japanese left and nothing overflowing.
// usage: from e2e.cjs (E2E_ONLY=week or the full run). Screenshots: <out>/w-<name>.png
const path = require('path');
const assert = require('assert/strict');

module.exports = async function firstWeekFlow(browser, base, out, errors) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('week pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('week console: ' + m.text()); });
  const shots = [];
  const shot = async (name, wait = 400) => { await page.waitForTimeout(wait); const f = path.join(out, `w-${name}.png`); await page.screenshot({ path: f }); shots.push(f); };
  const scr = () => page.evaluate(() => globalThis.__muchi?.screen ?? '');
  const waitScreen = (n, timeout = 30000) => page.waitForFunction((x) => [].concat(x).includes(globalThis.__muchi?.screen), n, { timeout, polling: 50 });
  const show = async (name) => { await page.evaluate((n) => globalThis.__muchi.show(n), name); await page.waitForTimeout(1500); };
  const txt = (sel) => page.evaluate((s) => document.querySelector('.screen.in ' + s)?.textContent ?? null, sel);
  await page.goto(base + 'index.html?demo=new');
  await page.waitForFunction(() => globalThis.__muchi?.ready === true, null, { timeout: 120000 });

  // a) day 1
  await page.evaluate(async () => {
    const M = globalThis.__muchi; const L = M.logic;
    L.reset(); await L.bootstrap(); await L.recordConsent(); await L.grantPartner('アカツキ'); await L.tutorialDraw(); M.prompts.ftue(false);
    await L.claimLogin();
    for (const [i, p] of [2, 1, 4].entries()) await L.applyRace(`wk_1_${i}`, p, 12, { trackId: 'aoba_turf_1600', style: 'sashi', finishTick: 1900, whips: 3 });
    const pid = (await L.view()).flags.partnerHorseId;
    for (const menu of ['hill', 'wood']) { const st = await L.trainingStart(pid, menu); await L.trainingFinish(st.value.session.sessionId, [], true); }
  });
  await show('Goals'); await waitScreen('goals');
  assert.ok(await page.locator('.screen.in .gl-claim').count(), 'week a: something to claim on day 1');
  await page.locator('.screen.in .gl-claim').click();
  await page.waitForSelector('.screen.in .gl-moment .gl-tomorrow-block', { timeout: 10000 });
  const moment = await page.evaluate(() => [...document.querySelectorAll('.screen.in .gl-moment .gl-tomorrow-block .label')].map((e) => e.textContent));
  assert.ok(moment.some((l) => /ログインボーナス 2日目：繁殖牝馬1頭/.test(l)), 'week a: the claim moment ends on tomorrow\'s login bonus: ' + moment);
  assert.ok(moment.some((l) => /配合/.test(l) && /開きます/.test(l)), 'week a: …and what opens tomorrow: ' + moment);
  await shot('d1-claim-moment', 900);
  await page.locator('.screen.in [data-action="gl-ok"]').click(); await waitScreen('goals');
  await show('Home'); await waitScreen('home');
  const today = await page.evaluate(() => { const r = document.querySelector('.screen.in [data-rung="today"]'); return { main: r?.querySelector('.gl-main')?.textContent ?? '', figure: r?.querySelector('.num')?.textContent ?? null }; });
  assert.ok(today.main.startsWith('明日：繁殖牝馬1頭') && today.figure === null, 'week a: the done today rung says tomorrow on its whole width: ' + JSON.stringify(today));
  const plate = { growth: await txt('.pp-growth'), delta: await txt('.pp-delta'), next: await txt('.pp-next'), pips: await page.locator('.screen.in .pp-stage i').count() };
  assert.ok(/新馬　調教 \+\d+/.test(plate.growth ?? '') && /^今日 \+\d+$/.test(plate.delta ?? '') && /成長期まで あと\d+/.test(plate.next ?? '') && plate.pips === 5, 'week a: the partner plate shows its growth: ' + JSON.stringify(plate));
  await shot('d1-home');
  const go = await page.evaluate(() => document.querySelector('.screen.in [data-rung="path"]')?.dataset.go ?? null);
  assert.ok(go && !['shop', 'store', 'season_pass'].includes(go), 'week a: the path rung opens the step\'s screen: ' + go);
  await page.locator('.screen.in [data-rung="path"]').click(); await page.waitForTimeout(1200);
  assert.ok(!['home', 'goals', 'shop', 'store'].includes(await scr()), 'week a: one tap to where the step is done (' + (await scr()) + ')');

  // b) day 2
  await page.evaluate(async () => { const L = globalThis.__muchi.logic; L.setDayOffset(1); await L.bootstrap(); globalThis.__muchi.prompts.reset(); });
  await show('Home'); await waitScreen(['home']);
  assert.match((await txt('.pp-delta')) ?? '', /^昨日 \+\d+$/, 'week b: the next morning the plate says yesterday\'s growth');
  await shot('d2-home', 200);
  await page.evaluate(async () => { const L = globalThis.__muchi.logic; for (let i = 0; i < 3; i++) await L.applyRace(`wk_2_${i}`, [1, 3, 2][i], 12, { trackId: 'aoba_turf_1600', style: 'sashi', finishTick: 1900, whips: 3 }); });
  await show('Goals'); await waitScreen('goals');
  assert.ok(await page.locator('.screen.in .gl-tomorrow').count(), 'week b: 目標 shows the tomorrow line');
  assert.ok(await page.locator('.screen.in [data-action="gl-step"]').count(), 'week b: 「やってみる ›」 for the current step');
  await shot('d2-goals');

  // c) day 3 opens on home (the account-link prompt waits for a closed result)
  await page.evaluate(async () => { const L = globalThis.__muchi.logic; L.setDayOffset(2); await L.bootstrap(); globalThis.__muchi.prompts.reset(); });
  await show('Home');
  assert.equal(await scr(), 'home', 'week c: day 3 opens on home, not on the account-link prompt');

  // d) English and the largest text size: nothing Japanese left, nothing overflowing on home and 目標
  await page.evaluate(() => { globalThis.__muchi.a11y.set('textSize', 'largest'); globalThis.__muchi.l10n.set('en'); });
  for (const name of ['Home', 'Goals']) {
    await show(name);
    await page.evaluate(() => globalThis.__muchi.l10n.fit()); await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const JP = /[぀-ヿ㐀-鿿]/, root = document.querySelector('.screen.in'), stage = document.getElementById('stage').getBoundingClientRect();
      const jp = [], over = [];
      const walk = (n) => { if (n.nodeType === 3) { const e = n.parentElement; if (JP.test(n.nodeValue) && !e.closest('.keep-ja') && e.offsetParent !== null) jp.push(n.nodeValue.trim().slice(0, 40)); } else if (n.nodeType === 1 && !n.classList.contains('keep-ja')) n.childNodes.forEach(walk); };
      walk(root);
      for (const e of root.querySelectorAll('.gl-panel .label, .partner-plate .label, .gl-col .label, .gl-tomorrow-block .label, [data-action="gl-step"]')) {
        if (e.offsetParent === null || !e.textContent.trim()) continue;
        const rg = document.createRange(); rg.selectNodeContents(e); const b = rg.getBoundingClientRect();
        if (e.scrollWidth > e.clientWidth + 2 || b.right > stage.right + 2 || e.dataset.fit === 'overflow') over.push(e.textContent.trim().slice(0, 40));
      }
      return { jp: [...new Set(jp)], over };
    });
    if (r.jp.length) errors.push(`week ${name} (en): Japanese left: ${r.jp.slice(0, 8).join(' | ')}`);
    if (r.over.length) errors.push(`week ${name} (en, largest): overflows: ${r.over.slice(0, 8).join(' | ')}`);
    await shot(`${name.toLowerCase()}-en-largest`, 200);
  }
  await page.evaluate(() => { globalThis.__muchi.a11y.set('textSize', 'standard'); globalThis.__muchi.l10n.set('ja'); });
  await ctx.close();
  return { shots };
};
