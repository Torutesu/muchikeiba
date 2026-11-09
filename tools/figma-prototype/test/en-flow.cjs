// Round 11 (REQ-L10N-013): a short pass of the ムチ一閃 UI in English on the landscape phone (844×390 @2x).
// EN on from the start, the day-7 demo player: home, shop (recommended / coins / looks), the legal page (Japanese text
// with the English courtesy note), purchase confirmation, season pass, scout calendar and odds, the stable, settings,
// a ranked race (HUD) and its result, 調教 (cards, mini-game, result, skip), then the 図鑑 (every tab, details), 実績 (claim one / all) and the title chooser.
// On every screen:
//   - no Japanese is left on the stage (outside the .keep-ja legal text and the 日本語 language button);
//   - no text overflows: nothing is still too wide / too tall for its box after fitText, nothing leaves the stage.
// Screenshots: <out>/en-<nn>-<name>.png. Returns { shots, report }.
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');

module.exports = async function enFlow(browser, base, out, errors) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, locale: 'en-US' });
  await ctx.addInitScript(() => { try { localStorage.setItem('muchi.language', 'en'); } catch { /* */ } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('en pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('en console: ' + m.text()); });
  for (const f of fs.readdirSync(out)) if (/^en-\d+-.*\.png$/.test(f)) fs.unlinkSync(path.join(out, f));
  const shots = [];
  const report = [];
  let n = 0;
  const screen = () => page.evaluate(() => globalThis.__muchi?.screen ?? '');
  const waitScreen = (name, timeout = 30000) => page.waitForFunction((x) => { const s = globalThis.__muchi?.screen ?? ''; return Array.isArray(x) ? x.includes(s) : s === x; }, name, { timeout, polling: 50 });
  const btn = (label) => page.locator(`.screen.in [data-label="${label}"]`).first();
  const click = async (label) => { await btn(label).click(); await page.waitForTimeout(350); };
  const show = async (fn, ...a) => { await page.evaluate(([f, args]) => globalThis.__muchi.show(f, ...args), [fn, a]); await page.waitForTimeout(450); };

  /** Japanese left on the stage and text that does not fit, after the screen settled. */
  async function audit(name) {
    await page.evaluate(() => globalThis.__muchi.l10n.fit());
    await page.waitForTimeout(120);
    const r = await page.evaluate(() => {
      const JP = /[぀-ヿ㐀-鿿]/;
      const stage = document.getElementById('stage').getBoundingClientRect();
      const scale = stage.width / 1600;
      const root = document.querySelector('.screen.in');
      const japanese = [];
      const walk = (n) => {
        if (n.nodeType === 3) {
          const el = n.parentElement;
          if (JP.test(n.nodeValue) && !el.closest('.keep-ja') && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden') japanese.push(n.nodeValue.trim().slice(0, 60));
        } else if (n.nodeType === 1 && !n.classList.contains('keep-ja')) n.childNodes.forEach(walk);
      };
      walk(root);
      const overflow = [];
      for (const e of root.querySelectorAll('.label, .kicker, .caption, .btn, .pill, .tag')) {
        if (e.offsetParent === null || !e.textContent.trim()) continue;
        // the text itself (an element box may be wider than its text, e.g. a 900 px caption near the right edge)
        const rg = document.createRange(); rg.selectNodeContents(e);
        const b = rg.getBoundingClientRect();
        const wide = e.scrollWidth > e.clientWidth + 2;
        const tall = e.style.height && e.scrollHeight > e.clientHeight + 2;
        const out = b.right > stage.right + 2 || b.left < stage.left - 2 || b.bottom > stage.bottom + 2;
        const host = e.classList.contains('btn') ? null : e.parentElement.closest('.glass, .card, .sheet');
        const below = host && b.bottom > host.getBoundingClientRect().bottom + 2 * scale;
        if (wide || tall || out || below || e.dataset.fit === 'overflow') overflow.push(`${e.className.split(' ').slice(0, 2).join('.')} "${e.textContent.trim().slice(0, 50)}"${wide ? ' wide' : ''}${tall ? ' tall' : ''}${out ? ' off-stage' : ''}${below ? ' below-panel' : ''}`);
      }
      const shrunk = root.querySelectorAll('[data-fit="shrunk"]').length;
      return { japanese: [...new Set(japanese)], overflow, shrunk, screen: globalThis.__muchi.screen };
    });
    report.push({ name, ...r });
    if (r.japanese.length) errors.push(`en ${name}: Japanese left: ${r.japanese.slice(0, 8).join(' | ')}`);
    if (r.overflow.length) errors.push(`en ${name}: text overflows: ${r.overflow.slice(0, 6).join(' | ')}`);
    return r;
  }
  const shot = async (name, wait = 450) => {
    await page.waitForTimeout(wait);
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await audit(name);
    const f = path.join(out, `en-${String(++n).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: f }); shots.push(f);
  };

  await page.goto(base + 'index.html?demo=day7');
  await page.waitForFunction(() => globalThis.__muchi?.ready === true, null, { timeout: 90000 });
  // the day-7 player first sees the one-time account-link prompt (day 3, once): audit it in English, then later
  await waitScreen(['home', 'link-prompt']);
  if ((await screen()) === 'link-prompt') { await shot('link-prompt', 500); await click('あとで'); }
  await waitScreen('home');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  await shot('home', 800);
  assert.match(await page.locator('.screen.in').innerText(), /Race/, 'the home CTA is in English');

  await click('ショップ'); await waitScreen('shop-recommended'); await shot('shop-recommended', 600);
  const shopText = await page.locator('.screen.in').innerText();
  assert.ok(!/\b(double|2x|x2|limited time|hurry|% off)\b/i.test(shopText), 'no multiplier or urgency wording in the English shop');
  await click('コイン'); await waitScreen('shop-coins'); await shot('shop-coins', 500);
  assert.match(await page.locator('.screen.in').innerText(), /free coins/i, 'the first-purchase bonus is stated as free coins');
  await click('見た目'); await waitScreen('shop-looks'); await shot('shop-looks', 500);
  await click('特定商取引法に基づく表記'); await waitScreen('legal'); await shot('legal-tokushoho', 300);
  assert.equal(await page.locator('.screen.in .keep-ja').count() >= 1, true, 'the legal text stays in Japanese');
  assert.match(await page.locator('.screen.in [data-courtesy="en"]').innerText(), /courtesy translation only; it has no legal effect/);
  await click('閉じる');
  await click('コイン'); await waitScreen('shop-coins');
  await page.locator('.screen.in [data-product="coin_480"] [data-label="購入を確認"]').click(); await waitScreen('purchase');
  await shot('purchase', 400);

  await show('SeasonPass'); await waitScreen('pass'); await shot('season-pass', 600);
  await show('Scout'); await waitScreen('scout'); await shot('scout', 900);
  await show('Odds', 'standard'); await shot('odds', 500);
  await show('Stable'); await shot('stable', 600);
  await show('Settings'); await waitScreen('settings'); await shot('settings', 400);
  assert.equal(await page.locator('.screen.in [data-label="English"].on').count(), 1, 'settings: English is selected');

  // a ranked race in English: HUD, then the result
  await show('Home'); await waitScreen('home');
  await click('レースへ'); await waitScreen('lobby'); await shot('lobby', 400);
  await click('ランク戦に出る'); await waitScreen('race', 20000);
  let started = false, whips = 0, lastW = 0, hudShot = false;
  for (let i = 0; i < 4000; i++) {
    const f = await page.evaluate(() => globalThis.__muchi.state().lastFrame);
    if ((await screen()) !== 'race') break;
    if (!f) { await page.waitForTimeout(60); continue; }
    if (f.done) break;
    if (!started && f.gateOpen && !f.departed) { await page.locator('.screen.in .btn.whip').click({ force: true }); started = true; }
    if (!hudShot && f.departed && f.remainingM < f.distanceM * .6) { hudShot = true; await shot('race-hud', 0); }
    if (f.departed && whips < 2 && f.remainingM <= (whips === 0 ? 380 : 220) && f.whips > 0 && Date.now() - lastW > 1500) { await page.locator('.screen.in .btn.whip').click({ force: true }); whips++; lastW = Date.now(); }
    await page.waitForTimeout(40);
  }
  await waitScreen(['result'], 40000); await shot('result', 1200);
  const commentary = await page.evaluate(() => globalThis.__muchi.state().lastFrame?.subtitle ?? '');
  assert.ok(!/[぀-ヿ一-鿿]/.test(commentary), 'the race commentary is in English: ' + commentary);

  // round 11: 調教 in English (REQ-TRAIN-*): the menu cards, the timing mini-game, the result, the skipped result, the apple
  const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
  await show('Training'); await waitScreen('training'); await waitIn('.tr-menu[data-menu="hill"]');
  await shot('training', 500);
  assert.match(await page.locator('.screen.in').innerText(), /Fatigue never affects any race/, 'training: the fairness rules in English');
  await page.locator('.screen.in .tr-menu[data-menu="hill"]').click(); await waitIn('.tr-menu.sel[data-menu="hill"]');
  await click('坂路で調教'); await waitScreen('training-play');
  await page.waitForFunction(() => typeof globalThis.__muchi.trainingStartedAt === 'number' && globalThis.__muchi.screen === 'training-play', null, { timeout: 10000 });
  await page.evaluate(() => { const m = globalThis.__muchi; for (const b of m.trainingBeats) setTimeout(() => m.trainingTap(), Math.max(0, b - m.trainingElapsed())); });
  await page.waitForTimeout(2600); await shot('training-play', 0);
  await waitScreen('training-result', 20000); await shot('training-result', 500);
  const mission = page.locator('.screen.in [data-label="ミッション報酬を受け取る"]');
  if (await mission.count()) { await mission.first().click(); await waitScreen('training-result'); await shot('training-mission', 300); }
  await click('つづける'); await waitScreen('training'); await waitIn('.tr-menu[data-menu="pool"]');
  await page.locator('.screen.in .tr-menu[data-menu="pool"]').click(); await waitIn('.tr-menu.sel[data-menu="pool"]');
  await click('プールで調教'); await waitScreen('training-play'); await page.waitForTimeout(300);
  await click('スキップ'); await waitScreen('training-result', 20000); await shot('training-result-skipped', 400);
  await click('つづける'); await waitScreen('training'); await page.waitForTimeout(400); await shot('training-after', 400);

  // round 11: 図鑑・実績・称号 in English (REQ-COL-*, REQ-ACH-*): a week of play on the real rules, every tab, a detail,
  // the achievement list (claim one, claim all), the title chooser
  await page.evaluate(() => globalThis.__muchi.demo('collection')); await waitScreen('collection', 60000);
  await shot('collection-horses', 600);
  assert.match(await page.locator('.screen.in').innerText(), /pays no reward/i, 'the book says completing it pays nothing (English)');
  await page.locator('.screen.in [data-col-cell][data-state="seen"]').first().click(); await shot('collection-seen-detail', 500);
  await page.locator('.screen.in [data-col-cell][data-state="unknown"]').first().click(); await shot('collection-unknown-detail', 500);
  for (const tab of ['skills', 'courses', 'cosmetics']) {
    await page.locator(`.screen.in [data-tab="${tab}"]`).click(); await page.waitForTimeout(400);
    const cell = page.locator('.screen.in [data-col-cell][data-state="obtained"]').first();
    if (await cell.count()) await cell.click();
    await shot('collection-' + tab, 400);
  }
  await click('実績'); await waitScreen('achievements'); await shot('achievements', 600);
  await page.locator('.screen.in [data-claim]').first().click(); await page.waitForTimeout(800); await waitScreen('achievements');
  await shot('achievement-claimed', 300);
  await click('まとめて受け取る'); await page.waitForTimeout(800); await waitScreen('achievements');
  await click('称号を変える'); await shot('achievement-titles', 500);

  // round 13: 支部の共同目標 in English (REQ-TGOAL-*): the week, after the demo races, the week result sheet
  await show('TeamGoal'); await waitScreen('team-goal', 20000); await shot('team-goal', 600);
  assert.match(await page.locator('.screen.in').innerText(), /as a branch/, 'team goal: the goal label in English');
  await click('みんなでレース（デモ）'); await waitScreen('team-goal'); await shot('team-goal-progress', 700);
  await click('週の締め（デモ）'); await waitScreen('team-goal'); await page.waitForTimeout(600); await shot('team-goal-result', 500);
  await page.evaluate(() => globalThis.__muchi.logic.setClockMs(null));

  const misses = await page.evaluate(() => globalThis.__muchi.l10n.misses());
  fs.writeFileSync(path.join(out, 'en-report.json'), JSON.stringify({ report, misses }, null, 2));
  await ctx.close();
  return { shots, report, misses };
};
