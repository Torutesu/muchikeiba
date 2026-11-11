// Round 11 (REQ-L10N-013): a short pass of the ムチ一閃 UI in English on the landscape phone (844×390 @2x).
// EN on from the start, the day-7 demo player: home, shop (recommended / coins / looks), the legal page (Japanese text
// with the English courtesy note), purchase confirmation, season pass, scout calendar and odds, the stable, settings,
// the coin shortfall sheet (round 12), a ranked race (HUD) and its result, 調教 (cards, mini-game, result, skip), ライバル (detail, races, week result), 殿堂 (gallery, ceremony, plaque, a friend's hall, round 14), then the 図鑑 (every tab, details), 実績 (claim one / all) and the title chooser,
// the プレゼントボックス (box, claim one / all, history), the かんたん操作 suggestion, the 実況パック (list, sample, confirm), the weekly challenge (list, next week, a race with the condition in the HUD, the verified result),
// フォトモード from the result (round 15: tabs, a locked frame, the caption rule, the card); 厩舎の整理 (round 16).
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
  // round 12: the coin shortfall sheet (T6) — server texts translated at the response boundary, the pack card, the buttons
  await show('Shortfall', 'paid'); await waitScreen('shortfall'); await shot('shortfall-paid', 500);
  assert.match(await page.locator('.screen.in').innerText(), /You need 500 more paid coins/, 'the shortfall headline in English');
  await show('Shortfall', 'any'); await waitScreen('shortfall'); await shot('shortfall-any', 500);
  await show('Shortfall', 'free'); await waitScreen('shortfall'); await shot('shortfall-free', 400);
  await show('Stable'); await shot('stable', 600);
  await show('Settings'); await waitScreen('settings'); await shot('settings', 400);
  assert.equal(await page.locator('.screen.in [data-label="English"].on').count(), 1, 'settings: English is selected');

  // round 12: かんたん操作 in English — the options screen; the ranked race below rides with the whip assist (the HUD chip)
  await show('AssistSettings'); await waitScreen('assist-settings'); await shot('assist-settings', 400);
  assert.match(await page.locator('.screen.in').innerText(), /never rides better than skilled play/i, 'assist: the fairness rule in English');
  await page.evaluate(() => globalThis.__muchi.logic.setAssist('whip'));
  // round 15: アクセシビリティ in English at the standard size (a11y-flow.cjs audits the largest size in both languages)
  await show('A11ySettings'); await waitScreen('a11y-settings'); await shot('a11y-settings', 400);
  assert.match(await page.locator('.screen.in').innerText(), /does not make you stronger in ranked races/, 'a11y: the fairness line in English');
  assert.match(await page.locator('.screen.in').innerText(), /Flashing is kept to 3 times a second or less/, 'a11y: the flash line in English');

  // a ranked race in English: HUD, then the result
  await show('Home'); await waitScreen('home');
  await click('レースへ'); await waitScreen('lobby');
  await page.waitForSelector('.screen.in .adv-panel .adv-row', { timeout: 15000 });
  await shot('lobby', 400);
  assert.match(await page.locator('.screen.in .adv-panel').innerText(), /Pre-race advice[\s\S]*It does not promise a win/i, 'advice: the panel and the footnote in English');
  assert.ok(!/odds|chance|%|\bbuy\b|gacha/i.test(await page.locator('.screen.in .adv-panel').innerText()), 'advice: clean English');
  await click('ランク戦に出る'); await waitScreen('race', 20000);
  let started = false, whips = 0, lastW = 0, hudShot = false;
  for (let i = 0; i < 4000; i++) {
    const f = await page.evaluate(() => globalThis.__muchi.state().lastFrame);
    if ((await screen()) !== 'race') break;
    if (!f) { await page.waitForTimeout(60); continue; }
    if (f.done) break;
    if (!started && f.gateOpen && !f.departed) { await page.locator('.screen.in .btn.whip').click({ force: true }); started = true; }
    if (!hudShot && f.departed && f.remainingM < f.distanceM * .6) {
      hudShot = true;
      assert.equal(await page.locator('.screen.in .chip.assist').textContent(), 'Easy Controls ON', 'assist: the HUD chip in English');
      await shot('race-hud', 0);
    }
    if (f.departed && whips < 2 && f.remainingM <= (whips === 0 ? 380 : 220) && f.whips > 0 && Date.now() - lastW > 1500) { await page.locator('.screen.in .btn.whip').click({ force: true }); whips++; lastW = Date.now(); }
    await page.waitForTimeout(40);
  }
  await waitScreen(['result'], 40000); await shot('result', 1200);
  const commentary = await page.evaluate(() => globalThis.__muchi.state().lastFrame?.subtitle ?? '');
  assert.ok(!/[぀-ヿ一-鿿]/.test(commentary), 'the race commentary is in English: ' + commentary);

  // round 15: フォトモード in English (REQ-PHOTO-017) from the result: every tab, a locked frame, a caption, the card
  await page.locator('.screen.in [data-action="photo-result"]').click(); await waitScreen('photo'); await page.waitForTimeout(500);
  await shot('photo-camera', 400);
  for (const tab of ['look', 'frame', 'stamp', 'caption']) {
    await page.locator(`.screen.in [data-tab="${tab}"]`).click(); await page.waitForTimeout(300);
    if (tab === 'stamp') await page.locator('.screen.in .btn[data-stamp="star"]').click();
    if (tab === 'caption') {
      await page.locator('.screen.in .ph-input').fill('https://example.com'); await page.locator('.screen.in [data-action="ph-caption"]').click(); await page.waitForTimeout(300);
      assert.match(await page.locator('.screen.in [data-problem]').textContent(), /URL/, 'photo: the caption rule in English');
      await page.locator('.screen.in .ph-input').fill('Final stretch!'); await page.locator('.screen.in [data-action="ph-caption"]').click(); await page.waitForTimeout(300);
    }
    await shot('photo-' + tab, 300);
  }
  await page.locator('.screen.in [data-tab="frame"]').click(); await page.waitForTimeout(300);
  await page.locator('.screen.in .btn[data-frame][data-unlocked="false"]:not([data-frame="sakura"]):not([data-frame="gold_leaf"])').first().click(); await page.waitForTimeout(500);
  assert.match(await page.locator('.screen.in .sheet [data-unlock-text]').textContent(), /^Unlocked at tier \d of the achievement/, 'photo: the unlock text in English');
  await shot('photo-frame-locked', 300);
  await page.locator('.screen.in .sheet [data-label="閉じる"]').click(); await page.waitForTimeout(300);
  await page.locator('.screen.in [data-action="ph-shoot"]').click(); await page.waitForTimeout(600);
  await shot('photo-card', 300);
  await page.locator('.screen.in .sheet [data-label="閉じる"]').click(); await page.waitForTimeout(300);
  await page.locator('.screen.in [data-action="ph-back"]').click(); await waitScreen('result');
  await page.evaluate(() => globalThis.__muchi.logic.setAssist('off'));

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

  // round 12: ライバル in English (REQ-RIVAL-*): the detail, a race together and a time attack each, the week-result sheet
  await show('Rival'); await waitScreen('rival'); await waitIn('.rv-card');
  // the demo days crossed a week boundary: an earlier week's result sheet comes first (once)
  if (await page.locator('.screen.in .rv-result').count()) { await shot('rival-earlier-week', 400); await page.locator('.screen.in .rv-result .rv-continue').click(); await page.waitForTimeout(400); }
  await shot('rival', 500);
  assert.match(await page.locator('.screen.in').innerText(), /Challenge races never score/, 'rival: the rules in English');
  await click('デモ：同じレース'); await waitIn('.rv-race');
  await click('デモ：タイム'); await waitIn('.rv-ta');
  await shot('rival-races', 400);
  await click('デモ：週を終える'); await waitIn('.rv-result');
  await shot('rival-week-result', 500);
  await page.locator('.screen.in .rv-result .rv-continue').click(); await page.waitForTimeout(300);
  await page.evaluate(() => globalThis.__muchi.logic.setClockMs(null));

  // round 13: イベント交換所 in English (REQ-EXCH-*): the event top, the grid, the confirm sheet, the grace notice
  await page.evaluate(() => globalThis.__muchi.logic.exchangeDemo('open'));
  await show('EventTop'); await waitScreen('event-top'); await waitIn('.ev-points');
  await click('デモ：イベントレースを1回'); await waitScreen('event-top'); await waitIn('.ev-points');
  await page.evaluate(async () => { const L = globalThis.__muchi.logic; for (let i = 0; i < 3; i++) await L.eventDemoRace(L.exchangeEventId(), 1); });
  await show('EventTop'); await waitScreen('event-top'); await waitIn('.ev-points');
  await shot('event-top', 500);
  assert.match(await page.locator('.screen.in').innerText(), /cannot be bought/, 'exchange: the rules in English');
  await click('交換所へ'); await waitScreen('exchange'); await waitIn('.ex-card[data-item="ex_material"]'); await shot('exchange', 500);
  await page.locator('.screen.in .ex-card[data-item="ex_material"] [data-label="交換する"]').click(); await waitIn('.ex-sheet'); await shot('exchange-confirm', 400);
  await page.locator('.screen.in .ex-sheet [data-label="交換する"]').click(); await page.waitForTimeout(600); await waitScreen('exchange'); await shot('exchange-after', 500);
  await page.evaluate(() => globalThis.__muchi.logic.exchangeDemo('grace'));
  await show('EventTop'); await waitScreen('event-top'); await waitIn('.ev-grace'); await shot('event-top-grace', 500);
  await page.evaluate(() => globalThis.__muchi.logic.exchangeDemo('closed'));
  await show('Exchange'); await waitScreen('exchange'); await waitIn('.ex-grace[data-status="closed"]'); await shot('exchange-closed', 500);
  await page.evaluate(() => globalThis.__muchi.logic.exchangeDemo(null));

  // round 13: 週替わりチャレンジ in English (REQ-WCH-015): the list, next week's preview, a loan-horse race with the HUD
  // condition, the verified result
  await show('WeeklyChallenge'); await waitScreen('weekly-challenge'); await waitIn('.wch-card');
  await shot('weekly-challenge', 500);
  assert.match(await page.locator('.screen.in').innerText(), /class B stat cap/, 'challenge: the fairness rules in English');
  await page.locator('.screen.in .wch-next').click(); await page.waitForTimeout(400); await shot('weekly-challenge-next', 300);
  await click('閉じる'); await page.waitForTimeout(300);
  await click('貸し出し馬で挑戦'); await waitScreen('race', 30000); await waitIn('.wch-hud');
  const chWhips = await page.evaluate(() => globalThis.__muchi.challengeSession.challenge.conditions.maxWhips ?? 2);
  let chStarted = false, chW = 0, chLast = 0, chShot = false;
  for (let i = 0; i < 4000; i++) {
    const f = await page.evaluate(() => globalThis.__muchi.state().lastFrame);
    if ((await screen()) !== 'race') break;
    if (!f) { await page.waitForTimeout(60); continue; }
    if (f.done) break;
    if (!chStarted && f.gateOpen && !f.departed) { await page.locator('.screen.in .btn.whip').click({ force: true }); chStarted = true; }
    if (!chShot && f.departed && f.remainingM < f.distanceM * .6) { chShot = true; await shot('challenge-race-hud', 0); }
    if (f.departed && chW < Math.min(2, chWhips) && f.remainingM <= (chW === 0 ? 380 : 220) && f.whips > 0 && Date.now() - chLast > 1500) { await page.locator('.screen.in .btn.whip').click({ force: true }); chW++; chLast = Date.now(); }
    await page.waitForTimeout(40);
  }
  await waitScreen('challenge-result', 60000); await waitIn('.wch-verdict'); await shot('challenge-result', 600);
  assert.match(await page.locator('.screen.in .wch-verdict').innerText(), /^Challenge (cleared|failed)$/, 'challenge: the verdict in English');
  await click('一覧へ'); await waitScreen('weekly-challenge'); await waitIn('.wch-card'); await shot('weekly-challenge-after', 400);

  // round 14: 殿堂 in English (REQ-HOF-*): the gallery, a retirement ceremony, the plaque detail, a friend's hall
  await show('Hall'); await waitScreen(['hall', 'hall-ceremony']);
  if (await screen() === 'hall-ceremony') { await page.locator('.screen.in .hof-continue').click(); await waitScreen('hall'); }
  await waitIn('.hof-summary'); await shot('hall', 400);
  await click('デモ：引退式'); await waitScreen('hall-ceremony'); await waitIn('.hof-ceremony');
  await shot('hall-ceremony', 900);
  assert.match(await page.locator('.screen.in').innerText(), /Career highlights/, 'hall: the ceremony in English');
  await page.locator('.screen.in .hof-continue').click(); await waitScreen('hall'); await waitIn('.hof-plaque');
  await shot('hall-gallery', 400);
  await page.locator('.screen.in .hof-plaque').first().click(); await waitIn('.hof-detail');
  await shot('hall-plaque', 500);
  await page.locator('.screen.in .hof-detail [data-label="閉じる"]').click(); await page.waitForTimeout(300);
  await click('デモ：友達の殿堂'); await waitScreen('hall-friend'); await waitIn('.hof-plaque');
  await shot('hall-friend', 400);

  // round 14: マイリプレイ in English (REQ-MYRP-*): the list, the sheet, the rename sheet, the player, the unplayable state
  await show('MyReplays'); await waitScreen('my-replays'); await waitIn('.rp-saved');
  await click('デモ：レースを走る'); await waitIn('.rp-row');
  await page.locator('.screen.in .rp-keep:not(.disabled)').first().click(); await page.waitForTimeout(500); await waitIn('.rp-card');
  await shot('my-replays', 500);
  assert.match(await page.locator('.screen.in').innerText(), /My Replays/i, 'my replays: the title in English');
  await page.locator('.screen.in .rp-card').first().click(); await waitIn('.rp-sheet'); await shot('my-replays-sheet', 400);
  await page.locator('.screen.in .rp-sheet .rp-rename').click(); await waitIn('.rp-rename-sheet'); await shot('my-replays-rename', 400);
  await page.locator('.screen.in .rp-rename-sheet input.field').fill('1着'); await page.locator('.screen.in .rp-rename-save').click(); await page.waitForTimeout(500);
  await waitScreen('my-replays'); await waitIn('.rp-card .typed');
  assert.equal(await page.locator('.screen.in .rp-card .rp-title.typed').first().textContent(), '1着', 'a typed title stays as typed in English');
  await page.locator('.screen.in .rp-card').first().click(); await waitIn('.rp-sheet');
  await page.locator('.screen.in .rp-sheet .rp-play').click(); await waitScreen('replay-player', 30000);
  await page.waitForFunction(() => (globalThis.__muchi.replay?.t ?? 0) > 300, null, { timeout: 20000 });
  await page.locator('.screen.in .rp-pause').click(); await page.waitForTimeout(300);
  await shot('replay-player', 300);
  await page.locator('.screen.in .rp-share').click(); await waitIn('.rp-share-sheet'); await shot('replay-share', 400);
  await page.evaluate(() => globalThis.__muchi.logic.replays.demoRetired(true));
  await page.evaluate(async () => { const v = (await globalThis.__muchi.logic.replays.view()).value; return globalThis.__muchi.show('ReplayPlayer', v.saved[0].raceId, {}); });
  await waitScreen('replay-unplayable'); await shot('replay-unplayable', 400);
  await page.evaluate(() => globalThis.__muchi.logic.replays.demoRetired(false));

  // round 18: 馬ごとの目標 in English (REQ-HGOAL-013): the panel on the horse detail, the full chain, the home strip; names as typed
  {
    const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
    const pid = await page.evaluate(async () => { const L = globalThis.__muchi.logic; const v = await L.view(); await L.horseGoals.demoRaces(v.flags.partnerHorseId, [1, 2, 4]); return v.flags.partnerHorseId; });
    await show('Stable'); await waitIn('.hg-panel'); await shot('stable-goals', 500);
    await show('HorseGoals', pid); await waitScreen('horse-goals'); await waitIn('.hg-row'); await shot('horse-goals', 500);
    assert.match(await page.locator('.screen.in').innerText(), /Win a first race/, 'goals: the goal lines in English');
    await page.evaluate((id) => globalThis.__muchi.logic.horseGoals.pin(id), pid);
    await show('Home'); await waitScreen('home'); await waitIn('.hg-pin-strip'); await shot('home-goal-pin', 600);
    await page.evaluate(() => globalThis.__muchi.logic.horseGoals.pin(null));
  }

  // round 16: 厩舎の整理 in English (REQ-ORG-015): the list, the sort and filter sheets, selection, the confirmation; names as typed
  {
    const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
    await show('Roster'); await waitScreen('roster'); await waitIn('.org-list');
    await click('デモ：馬を増やす'); await page.waitForTimeout(800); await waitIn('.org-row');
    await shot('roster', 500);
    assert.match(await page.locator('.screen.in').innerText(), /gives back no coins or materials/, 'roster: the notice in English');
    await page.locator('.screen.in .org-sort').click(); await waitIn('.org-sort-sheet'); await shot('roster-sort', 400);
    await page.locator('.screen.in .org-sort-sheet .org-track').first().click(); await page.waitForTimeout(600); await waitIn('.org-apt');
    await shot('roster-aptitude', 300);
    await page.locator('.screen.in .org-filter').click(); await waitIn('.org-filter-sheet'); await shot('roster-filter', 400);
    await page.locator('.screen.in .org-filter-sheet [data-label="閉じる"]').click(); await page.waitForTimeout(300);
    await click('まとめて選ぶ'); await waitIn('.org-check');
    await page.locator('.screen.in .org-row[data-blocks=""]').first().click(); await page.waitForTimeout(400);
    await page.locator('.screen.in .org-row[data-blocks=""]:has(.org-check[data-on="false"])').first().click(); await page.waitForTimeout(400);
    await shot('roster-select', 300);
    await click('確認へ'); await waitScreen('roster-confirm'); await waitIn('.org-confirm');
    await shot('roster-confirm', 400);
    assert.match(await page.locator('.screen.in .org-refund').innerText(), /nothing/, 'roster: nothing comes back (English)');
    await page.locator('.screen.in .org-cancel').click(); await waitScreen('roster');
    await page.evaluate(() => localStorage.removeItem('muchi.roster.view'));
  }

  // round 18: 練習レース in English (REQ-PRAC-018): the setup (a lit course at night, strengths, options), a short race on the
  // device, the result lines (debrief, advice, no reward) — horse names as typed
  {
    const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
    await page.evaluate(() => { localStorage.removeItem('muchi.practice.setup'); localStorage.removeItem('muchi.practice.options'); });
    await show('Practice'); await waitScreen('practice'); await waitIn('.pr-setup');
    for (let i = 0; i < 8 && !(await page.locator('.screen.in .pr-night').count()); i++) { await page.locator('.screen.in .pr-course-next').click(); await page.waitForTimeout(350); }
    await page.locator('.screen.in .pr-night').click(); await page.waitForTimeout(350);
    await page.locator('.screen.in .pr-strength[data-strength="top"]').click(); await page.waitForTimeout(350);
    await shot('practice-setup', 400);
    assert.match(await page.locator('.screen.in').innerText(), /No rewards \(practice\)/, 'practice: the no-reward line in English');
    // the shortest course with 2 runners for the race
    for (let i = 0; i < 8 && (await page.locator('.screen.in .pr-course').getAttribute('data-track')) !== 'bellmoor_turf_1200'; i++) { await page.locator('.screen.in .pr-course-next').click(); await page.waitForTimeout(300); }
    for (let i = 0; i < 10; i++) { await page.locator('.screen.in .pr-field-minus').click(); await page.waitForTimeout(120); }
    await page.locator('.screen.in .pr-start').click(); await waitScreen('race', 20000);
    let started = false, lastW = 0, raceShot = false;
    for (let i = 0; i < 6000; i++) {
      const f = await page.evaluate(() => globalThis.__muchi.state().lastFrame);
      if (!f) { await page.waitForTimeout(50); continue; }
      if (f.done || (await page.evaluate(() => globalThis.__muchi.screen)) !== 'race') break;
      if (!started && f.gateOpen && !f.departed) { await page.locator('.screen.in .btn.whip').click({ force: true }); started = true; }
      if (f.departed && f.remainingM <= 420 && f.whips > 0 && Date.now() - lastW > 1400) { await page.locator('.screen.in .btn.whip').click({ force: true }); lastW = Date.now(); }
      if (!raceShot && f.departed && f.remainingM < 700) { raceShot = true; await shot('practice-race', 0); }
      await page.waitForTimeout(40);
    }
    await waitScreen('practice-result', 40000); await waitIn('.pr-result');
    await shot('practice-result', 500);
    assert.match(await page.locator('.screen.in .pr-no-reward').innerText(), /No rewards/, 'practice result: no reward (English)');
    assert.equal(await page.locator('.screen.in [data-label="リプレイを保存"], .screen.in [data-label="リプレイを共有"]').count(), 0, 'practice result: no replay save / share');
  }

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

  // round 14: 勝負服エディタ in English (REQ-SILK-015): parts, locked lines, the try-on, the parts sheet and the purchase confirmation
  await show('SilksEditor', 'silkpart_sleeve_stars'); await waitScreen('silks'); await page.waitForTimeout(700); await shot('silks-editor', 300);
  assert.match(await page.locator('.screen.in').innerText(), /Trying on/, 'silks: 試着中 in English');
  await page.locator('.screen.in [data-silks-tab="color"]').click(); await page.waitForTimeout(500); await shot('silks-colours', 300);
  await page.locator('.screen.in [data-silks-tab="cap"]').click(); await page.waitForTimeout(500); await shot('silks-caps', 300);
  await page.locator('.screen.in [data-silks-save]').click(); await page.waitForSelector('.screen.in .sheet [data-need]'); await shot('silks-need-parts', 400);
  await page.locator('.screen.in .sheet [data-label="購入を確認"]').first().click(); await waitScreen('silks-buy'); await shot('silks-buy-confirm', 400);
  await click('キャンセル'); await waitScreen('silks');
  // round 12: プレゼントボックス in English (REQ-BOX-*): the box, the home envelope, a claim, claim all, the history
  await page.evaluate(() => globalThis.__muchi.demo('gifts')); await waitScreen('gift-box', 60000);
  await shot('gift-box', 600);
  assert.match(await page.locator('.screen.in').innerText(), /Paid coins never go into the gift box/, 'the box rule in English');
  await page.locator('.screen.in [data-gift-claim]').first().click(); await waitScreen('gift-result'); await shot('gift-result-one', 400);
  await click('つづける'); await waitScreen('gift-box');
  await click('まとめて受け取る'); await waitScreen('gift-result'); await shot('gift-result-all', 400);
  await click('つづける'); await waitScreen('gift-box'); await shot('gift-box-empty', 400);
  await page.locator('.screen.in [data-tab="history"]').click(); await waitScreen('gift-history'); await shot('gift-history', 500);
  // round 12: the one-time かんたん操作 suggestion in English (three last places on the real rules)
  await page.evaluate(() => globalThis.__muchi.demo('assist')); await waitScreen('assist-prompt', 60000); await shot('assist-prompt', 500);
  assert.match(await page.locator('.screen.in').innerText(), /Not now/, 'assist: 「今はいい」 in English');
  await page.locator('.screen.in [data-assist-choice="later"]').click(); await waitScreen(['home', 'link-prompt'], 10000);
  // round 13: 購入・コイン・ガチャ履歴 in English (REQ-HIST-008): every tab, a detail, the 問い合わせ sheet and its draft
  await page.evaluate(() => globalThis.__muchi.demo('history')); await waitScreen('history', 60000);
  await shot('history-purchases', 600);
  assert.match(await page.locator('.screen.in').innerText(), /monthly limit for your age/, 'history: the age limit line in English');
  for (const tab of ['coins_paid', 'coins_free', 'gacha']) {
    await page.locator(`.screen.in [data-tab="${tab}"]`).click(); await page.waitForTimeout(500);
    await shot('history-' + tab, 300);
  }
  await page.locator('.screen.in .hi-pick').first().click(); await page.waitForTimeout(400);
  await page.locator('.screen.in [data-action="history-contact"]').click(); await page.waitForTimeout(500);
  await shot('history-contact', 300);
  await page.locator('.screen.in [data-action="history-ticket"]').click(); await page.waitForTimeout(600);
  await shot('history-ticket', 300);

  // round 15: アクティビティ in English (REQ-ACT-014): the list (server texts, player names as written) and the home bell
  await page.evaluate(() => globalThis.__muchi.demo('activity')); await waitScreen('activity', 60000);
  await shot('activity', 600);
  assert.match(await page.locator('.screen.in').innerText(), /My Stable got 12 likes/, 'activity: collapsed likes in English');
  await click('ホームへ'); await waitScreen(['home', 'link-prompt'], 20000);
  if ((await screen()) === 'link-prompt') { await click('あとで'); await waitScreen('home', 10000); }
  await shot('home-bell', 400);
  // round 17: おすすめフレンド in English (REQ-FSUG-015): reasons from the server, player names as written
  await page.evaluate(() => globalThis.__muchi.demo('friends')); await waitScreen('friends', 60000);
  await shot('friends-suggestions', 600);
  assert.match(await page.locator('.screen.in').innerText(), /Raced you recently, 2 mutual friends/, 'friend suggestions: the reason line in English');

  // round 17: 通報とブロック in English (REQ-RPT-018): the block list (player names as written, the effects from the server),
  // the unblock confirmation and the report sheet (reasons from the server, the note counter)
  await page.evaluate(() => globalThis.__muchi.demo('safety')); await waitScreen('blocks', 60000);
  await shot('blocks', 600);
  const blEn = await page.locator('.screen.in').innerText();
  assert.match(blEn, /What does blocking do\?/, 'blocks: the effects title in English');
  assert.match(blEn, /You get no activity notices from them/, 'blocks: a server effect line in English');
  await page.locator('.screen.in .bl-unblock').first().click(); await page.waitForTimeout(500);
  await shot('blocks-unblock-confirm', 300);
  await page.locator('.screen.in .bl-no').click(); await waitScreen('blocks'); await page.waitForTimeout(400);
  await page.evaluate(() => globalThis.__muchi.show('Report', { playerId: 'demo_bl_1', name: 'ヨルノカラス', kind: 'display_name', source: 'profile' })); await page.waitForTimeout(800);
  await shot('report-sheet', 300);
  const rpEn = await page.locator('.screen.in .rpt-sheet').innerText();
  assert.match(rpEn, /Inappropriate name/, 'report: the reasons in English');
  assert.match(rpEn, /never told who reported them/, 'report: the lead in English');

  // round 17: ヘルプセンター in English (REQ-HELP-020): articles come in English from the master, typed text and replies stay as written
  await page.evaluate(() => globalThis.__muchi.demo('help')); await waitScreen('my-inquiries', 60000);
  await shot('help-my-inquiries', 500);
  assert.match(await page.locator('.screen.in').innerText(), /Answered/, 'my inquiries: the status in English');
  await show('HelpCenter'); await waitScreen('help'); await shot('help-center', 500);
  assert.match(await page.locator('.screen.in').innerText(), /Scout \(rates & pity\)/, 'help: the categories in English');
  await page.locator('.screen.in input.field').fill('pity'); await click('検索'); await waitScreen('help-search'); await shot('help-search', 400);
  await page.locator('.screen.in [data-help-article="pity"]').click(); await waitScreen('help-article'); await shot('help-article', 500);
  assert.match(await page.locator('.screen.in .help-body').innerText(), /pulls' worth/, 'help: the article body in English');
  await show('HelpArticle', 'buy_coins', 'list'); await waitScreen('help-article'); await shot('help-article-coins', 400);
  await show('InquiryForm'); await waitScreen('inquiry-form'); await shot('inquiry-form', 500);

  // round 13: 支部の共同目標 in English (REQ-TGOAL-*): the week, after the demo races, the week result sheet
  await show('TeamGoal'); await waitScreen('team-goal', 20000); await shot('team-goal', 600);
  assert.match(await page.locator('.screen.in').innerText(), /as a branch/, 'team goal: the goal label in English');
  await click('みんなでレース（デモ）'); await waitScreen('team-goal'); await shot('team-goal-progress', 700);
  await click('週の締め（デモ）'); await waitScreen('team-goal'); await page.waitForTimeout(600); await shot('team-goal-result', 500);
  await page.evaluate(() => globalThis.__muchi.logic.setClockMs(null));
  // round 14: 実況パック in English (REQ-CMT-011): the list, the sample ticker, the purchase confirm
  await page.evaluate(() => globalThis.__muchi.demo('packs')); await waitScreen(['commentary-packs', 'link-prompt'], 60000);
  if (await screen() === 'link-prompt') { await click('あとで'); await show('CommentaryPacks'); await waitScreen('commentary-packs'); }
  await shot('commentary-packs', 600);
  assert.match(await page.locator('.screen.in').innerText(), /Race results and abilities are not affected/, 'packs: the rule in English');
  await page.locator('.screen.in [data-sample="nekketsu"]').click(); await page.waitForTimeout(700);
  await page.waitForFunction(() => (document.querySelector('.screen.in [data-ticker]')?.textContent ?? '').length > 4, null, { timeout: 5000 });
  await page.waitForSelector('.screen.in [data-ticker][data-done="1"]', { timeout: 15000 });
  await shot('commentary-pack-sample', 300);
  await page.locator('.screen.in [data-buy="ochitsuki"]').click(); await waitScreen(['commentary-pack-buy', 'shortfall'], 10000);
  await shot('commentary-pack-buy', 400);
  await page.locator('.screen.in [data-confirm="cancel"]').click(); await waitScreen('commentary-packs');

  // round 16: 次にやること in English (REQ-NEXT-014): the home's next card and chips, then after 「今日は閉じる」
  await page.evaluate(() => globalThis.__muchi.demo('next')); await waitScreen(['home', 'link-prompt'], 60000);
  if (await screen() === 'link-prompt') { await click('あとで'); await waitScreen('home', 10000); }
  await page.waitForSelector('.screen.in .next-card', { timeout: 10000 });
  await shot('home-next', 700);
  assert.match(await page.locator('.screen.in .next-card').innerText(), /Next up/, 'next card: the kicker in English');
  await page.locator('.screen.in [data-next-dismiss]').click(); await page.waitForTimeout(800);
  await shot('home-next-dismissed', 500);

  // round 16: シーズンの振り返り in English (REQ-RECAP-012): the list, every page of a full recap, the share set, the short version
  {
    const waitRc = (sel) => page.waitForSelector(`.screen.in ${sel}`, { timeout: 30000 });
    await show('Recaps'); await waitScreen('recaps', 30000); await waitRc('.rc-card'); await shot('recaps', 400);
    await show('Recap', 'season:2026-11', 0); await waitScreen('recap'); await waitRc('.rc-big');
    const rcSteps = await page.evaluate(() => globalThis.__muchi.recap.steps);
    for (let k = 0; k < rcSteps; k++) {
      if (k > 0) { await page.locator('.screen.in .rc-next').click(); await page.waitForSelector(`.screen.in[data-index="${k}"]`, { timeout: 10000 }); }
      await shot('recap-' + (await page.evaluate(() => globalThis.__muchi.recap.key)), 950);
    }
    assert.match(await page.locator('.screen.in').innerText(), /Well ridden/, 'recap: the last page in English');
    await page.locator('.screen.in .rc-share').click(); await waitRc('.rc-share-sheet'); await shot('recap-share', 400);
    await show('Recap', 'season:2026-10', 0); await waitScreen('recap'); await waitRc('.rc-big'); await shot('recap-short', 950);
  }

  // round 16: プレイヤー主催カップ in English (REQ-CUP-*): the list, create, the lobby (host), standings, the result card,
  // join by code. Cup and player names stay as typed.
  await show('HostedCups'); await waitScreen('hosted-cups', 30000); await shot('cups', 600);
  await page.locator('.screen.in .cup-make').click(); await waitScreen('cup-create'); await shot('cup-create', 400);
  await page.locator('.screen.in .cup-create').click(); await waitScreen('cup-lobby', 20000); await shot('cup-lobby', 500);
  assert.match(await page.locator('.screen.in').innerText(), /unranked/i, 'cups: the unranked note in English');
  await page.locator('.screen.in .cup-demo-fill').click(); await page.waitForTimeout(700);
  await page.locator('.screen.in .cup-start').click(); await waitScreen(['cup-lobby', 'cup-standings'], 30000); await page.waitForTimeout(500);
  await page.locator('.screen.in .cup-standings-open').click(); await waitScreen('cup-standings'); await shot('cup-standings', 500);
  await show('CupJoin'); await waitScreen('cup-join'); await shot('cup-join', 400);

  // round 17: メンテナンス・強制アップデート in English (REQ-MNT-012): the maintenance screen, the update screen, the notice
  await page.evaluate(() => globalThis.__muchi.demo('maintenance')); await waitScreen('maintenance', 60000);
  await shot('maintenance', 600);
  assert.match(await page.locator('.screen.in').innerText(), /Under maintenance[\s\S]*We are upgrading our servers/, 'maintenance: title and the window message in English');
  await page.evaluate(() => globalThis.__muchi.demo('update')); await waitScreen('update-required', 60000);
  await shot('update-required', 600);
  assert.match(await page.locator('.screen.in').innerText(), /Update required/, 'update screen in English');
  await show('MaintenanceNotice'); await waitScreen('maintenance-notice'); await shot('maintenance-notice', 600);
  await page.evaluate(() => globalThis.__muchi.logic.maintenanceDemo('off'));
  const misses = await page.evaluate(() => globalThis.__muchi.l10n.misses());
  fs.writeFileSync(path.join(out, 'en-report.json'), JSON.stringify({ report, misses }, null, 2));
  await ctx.close();
  return { shots, report, misses };
};
