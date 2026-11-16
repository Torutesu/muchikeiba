// Quality pass 3 — week 2 and using what you have (docs/quality/week2.md, REQ-GOAL-017..020, REQ-ITEM-010/011) in the browser,
// on the real rules, for a player who plays alone (no friend, no branch):
//  a) day 2 at the friend step: home names the solo way on the path rung; 目標 offers 「ひとりでも：… ›」 to the training screen;
//     the training screen suggests the treat with what it changes; giving it reaches the step (claimed in one claim);
//  b) the 支部 step by one more breeding with material — offered on the foal reveal;
//  c) day 7: today's 明日 line is graduation; the 2週目 rung takes the path's place; 目標 shows the seven days with the peak;
//     day 8: graduation (the 10-pull ticket) is claimed; day 10: 3/7;
//  d) English and the largest text size on home and 目標 with the arc: nothing Japanese left, nothing overflowing.
// usage: from e2e.cjs (E2E_ONLY=week or the full run). Screenshots: <out>/w2-<name>.png
const path = require('path');
const assert = require('assert/strict');

module.exports = async function week2Flow(browser, base, out, errors) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('week2 pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('week2 console: ' + m.text()); });
  const shots = [];
  const shot = async (name, wait = 400) => { await page.waitForTimeout(wait); const f = path.join(out, `w2-${name}.png`); await page.screenshot({ path: f }); shots.push(f); };
  const scr = () => page.evaluate(() => globalThis.__muchi?.screen ?? '');
  const waitScreen = async (n, timeout = 30000) => { try { await page.waitForFunction((x) => [].concat(x).includes(globalThis.__muchi?.screen), n, { timeout, polling: 50 }); } catch (e) { throw new Error(`week2: waited for ${n}, on ${await scr()}; ${errors.slice(-3).join(' / ')}`); } };
  const show = async (name) => { await page.evaluate((n) => globalThis.__muchi.show(n), name); await page.waitForTimeout(1500); };
  const txt = (sel) => page.evaluate((s) => document.querySelector('.screen.in ' + s)?.textContent ?? null, sel);
  const day = (d) => page.evaluate(async (d) => {
    const M = globalThis.__muchi; const L = M.logic;
    L.setDayOffset(d - 1); await L.bootstrap(); M.prompts.reset(); await L.claimLogin().catch(() => undefined);
    for (let i = 0; i < 3; i++) await L.applyRace(`w2_${d}_${i}`, [2, 1, 4][i], 12, { trackId: 'aoba_turf_1600', style: 'sashi', finishTick: 1900, whips: 3 });
    if (d !== 2) { const pid = (await L.view()).flags.partnerHorseId; const st = await L.trainingStart(pid, 'pool'); if (st.ok) await L.trainingFinish(st.value.session.sessionId, [], true); } // the daily 「調教を1回」 (day 2 trains in a) )
  }, d);
  const claimAll = () => page.evaluate(async () => { const L = globalThis.__muchi.logic; const g = await L.goals(); return g.value.claimable ? (await L.claimGoals()).value.claimed.map((c) => c.id) : []; });
  await page.goto(base + 'index.html?demo=new');
  await page.waitForFunction(() => globalThis.__muchi?.ready === true, null, { timeout: 120000 });

  // a) day 1: the first five steps (silks in the editor, a 飼い葉 recorded like the economy sim), day 2: breeding opens
  await page.evaluate(async () => {
    const M = globalThis.__muchi; const L = M.logic;
    L.reset(); await L.bootstrap(); await L.recordConsent(); await L.grantPartner('アカツキ'); await L.tutorialDraw(); M.prompts.ftue(false);
    const ed = await L.silksEditor(); await L.saveSilks({ design: ed.current.design }); await L.seedStepActions(['care']);
  });
  await day(1); await claimAll();
  await day(2);
  await page.evaluate(async () => {
    const L = globalThis.__muchi.logic; const v = await L.view();
    const male = v.horses.find((h) => h.status === 'active' && h.sex === 'male' && h.id !== v.flags.partnerHorseId);
    await L.retire(male.id);
    const v2 = await L.view();
    await L.breed(v2.horses.find((h) => h.status === 'retired' && h.sex === 'male').id, v2.horses.find((h) => h.status === 'retired' && h.sex === 'female').id, false);
  });
  await claimAll();
  let g = (await page.evaluate(() => globalThis.__muchi.logic.goals())).value;
  assert.equal(g.path.current.id, 'bm_friend', 'week2 a: at the friend step');
  assert.equal(g.path.current.alt?.kind, 'treat', 'week2 a: its solo way is a treat');
  await show('Home'); if ((await scr()) === 'link-prompt') await show('Home'); await waitScreen('home'); // the account-link prompt (once, day 4+)
  const rung = await page.evaluate(() => { const r = document.querySelector('.screen.in [data-rung="path"]'); return { main: r?.querySelector('.gl-main')?.textContent ?? '', go: r?.dataset.go ?? null }; });
  assert.ok(/フレンドを追加 か 相棒におやつ/.test(rung.main) && rung.go === null, 'week2 a: the path rung names both ways (and opens 目標): ' + JSON.stringify(rung));
  await shot('d2-home');
  await show('Goals'); await waitScreen('goals');
  const alt = page.locator('.screen.in [data-action="gl-step-alt"]');
  assert.equal(await alt.count(), 1, 'week2 a: 目標 offers the solo way');
  assert.equal(await alt.getAttribute('data-go'), 'training', 'week2 a: …to the training screen');
  await shot('d2-goals');
  // train twice (tired), receive the mission apple, then the training screen suggests the treat
  await page.evaluate(async () => {
    const L = globalThis.__muchi.logic; const pid = (await L.view()).flags.partnerHorseId;
    const st = await L.trainingStart(pid, 'hill'); await L.trainingFinish(st.value.session.sessionId, [], true);
    await L.claimMission('train1');
  });
  await alt.click(); await waitScreen('training'); await page.waitForSelector('.screen.in .tr-treat', { timeout: 15000 });
  const treat = await txt('.tr-treat-line');
  assert.match(treat ?? '', /りんごのおやつで伸び \d+% → \d+%/, 'week2 a: the treat says what it changes: ' + treat);
  await shot('d2-training-treat');
  await page.locator('.screen.in .tr-treat .tr-item').click(); await page.waitForTimeout(1200);
  assert.equal(await page.locator('.screen.in .tr-treat').count(), 0, 'week2 a: the suggestion is gone once given');
  assert.deepEqual((await claimAll()).filter((x) => x.startsWith('bm_')), ['bm_friend'], 'week2 a: the friend step is reached without a friend');

  // b) day 3: the 支部 step by one more breeding with material, offered on the foal reveal
  await day(3);
  await page.evaluate(() => globalThis.__muchi.show('Breeding')); await waitScreen(['breeding']); await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const v = await globalThis.__muchi.logic.view();
    const s = v.horses.find((h) => h.status === 'retired' && h.sex === 'male'), d = v.horses.find((h) => h.status === 'retired' && h.sex === 'female');
    document.querySelector(`.screen.in .qr-parent[data-horse="${s.id}"]`)?.click();
    await new Promise((r) => setTimeout(r, 800));
    document.querySelector(`.screen.in .qr-parent[data-horse="${d.id}"]`)?.click();
  });
  await page.waitForSelector('.screen.in .qr-breed', { timeout: 15000 }); await page.waitForTimeout(800);
  await page.locator('.screen.in .qr-breed').click();
  await page.waitForSelector('.screen.in .qr-reveal', { timeout: 15000 });
  await page.evaluate(() => { const all = [...document.querySelectorAll('.screen.in .btn')].find((b) => /すべて見る/.test(b.textContent)); all?.click(); });
  await page.waitForSelector('.screen.in .qr-again', { timeout: 15000 });
  assert.match((await txt('.qr-again-line')) ?? '', /配合素材を1個使って、もう1回（残り \d+個）/, 'week2 b: the reveal offers one more with material');
  await shot('d3-reveal-again', 900);
  await page.locator('.screen.in .qr-again').click();
  await page.waitForSelector('.screen.in .qr-reveal', { timeout: 15000 }); await page.waitForTimeout(800);
  assert.deepEqual((await claimAll()).filter((x) => x.startsWith('bm_')), ['bm_team'], 'week2 b: the 支部 step is reached without a branch');

  // c) day 4: a time attack finish (recorded), steps 8–9; graduation waits for day 8
  await day(4);
  await page.evaluate(() => globalThis.__muchi.logic.seedStepActions(['ta_finish']));
  await claimAll();
  for (let d = 5; d <= 7; d++) { await day(d); await claimAll(); }
  g = (await page.evaluate(() => globalThis.__muchi.logic.goals())).value;
  assert.ok(g.path.current.id === 'bm_graduate' && g.path.current.dayOk === false && g.today.tomorrow.graduate?.ready, 'week2 c: day 7 — graduation tomorrow');
  await show('Home'); if ((await scr()) === 'link-prompt') await show('Home'); await waitScreen('home'); // the account-link prompt (once, day 4+)
  const d7 = await page.evaluate(() => ({ rungs: document.querySelector('.screen.in .gl-panel')?.dataset.rungs, today: document.querySelector('.screen.in [data-rung="today"] .gl-main')?.textContent, arc: document.querySelector('.screen.in [data-rung="week2"] .gl-main')?.textContent }));
  assert.ok(/week2/.test(d7.rungs) && !/path/.test(d7.rungs), 'week2 c: the 2週目 rung takes the path\'s place: ' + d7.rungs);
  assert.equal(d7.today, '明日：はじめの10歩 卒業（10連スカウト券×1）', 'week2 c: day 7\'s 明日 line is graduation');
  assert.equal(d7.arc, '14日目 SR以上確定券', 'week2 c: the arc names the week\'s peak');
  await shot('d7-home');
  await show('Goals'); await waitScreen('goals');
  assert.equal(await page.locator('.screen.in .gl-week2 .gl-w2-day').count(), 7, 'week2 c: seven days');
  assert.equal(await page.locator('.screen.in .gl-week2 .gl-w2-day.peak').getAttribute('data-day'), '14', 'week2 c: the peak is day 14');
  assert.equal(await page.locator('.screen.in .gl-week2 .gl-w2-day.grad').getAttribute('data-day'), '8', 'week2 c: graduation on day 8');
  await shot('d7-goals');
  await day(8);
  const c8 = await claimAll();
  assert.ok(c8.includes('bm_graduate'), 'week2 c: day 8 — graduation claimed: ' + c8);
  for (let d = 9; d <= 10; d++) { await day(d); await claimAll(); }
  await show('Home'); if ((await scr()) === 'link-prompt') await show('Home'); await waitScreen('home'); // the account-link prompt (once, day 4+)
  assert.equal(await txt('[data-rung="week2"] .num'), '3/7', 'week2 c: day 10 is 3/7');
  await shot('d10-home');

  // d) English and the largest text size with the arc on home and 目標
  await page.evaluate(() => { globalThis.__muchi.a11y.set('textSize', 'largest'); globalThis.__muchi.l10n.set('en'); });
  for (const name of ['Home', 'Goals']) {
    await show(name);
    await page.evaluate(() => globalThis.__muchi.l10n.fit()); await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const JP = /[぀-ヿ㐀-鿿]/, root = document.querySelector('.screen.in'), stage = document.getElementById('stage').getBoundingClientRect();
      const jp = [], over = [];
      const walk = (n) => { if (n.nodeType === 3) { const e = n.parentElement; if (JP.test(n.nodeValue) && !e.closest('.keep-ja') && e.offsetParent !== null) jp.push(n.nodeValue.trim().slice(0, 40)); } else if (n.nodeType === 1 && !n.classList.contains('keep-ja')) n.childNodes.forEach(walk); };
      walk(root);
      for (const e of root.querySelectorAll('.gl-panel .label, .partner-plate .label, .gl-col .label, .gl-week2 .label')) {
        if (e.offsetParent === null || !e.textContent.trim()) continue;
        const rg = document.createRange(); rg.selectNodeContents(e); const b = rg.getBoundingClientRect();
        if (e.scrollWidth > e.clientWidth + 2 || b.right > stage.right + 2 || e.dataset.fit === 'overflow') over.push(e.textContent.trim().slice(0, 40));
      }
      return { jp: [...new Set(jp)], over };
    });
    if (r.jp.length) errors.push(`week2 ${name} (en): Japanese left: ${r.jp.slice(0, 8).join(' | ')}`);
    if (r.over.length) errors.push(`week2 ${name} (en, largest): overflows: ${r.over.slice(0, 8).join(' | ')}`);
    await shot(`${name.toLowerCase()}-en-largest`, 200);
  }
  await page.evaluate(() => { globalThis.__muchi.a11y.set('textSize', 'standard'); globalThis.__muchi.l10n.set('ja'); });
  void scr;
  await ctx.close();
  return { shots };
};
