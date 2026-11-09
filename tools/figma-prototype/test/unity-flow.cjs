// ムチ一閃 UI walkthrough (site/index.html) for the round 8 experience (docs/planning/06, REQ-UXP-001..005).
//  1. FTUE as a new player on a landscape phone (844×390), driven like a person would: one tap per step, the whip only
//     when the button lights up. Measures the time and the taps to each milestone and checks the §2.3 targets:
//     aha (the tutorial win) ≤ 30 s, first gacha reveal ≤ 1:40, home ≤ 4:00 and ≤ 15 taps (text entry excluded).
//  2. Every new screen and state: home on day 1 / 3 / 7, shop tabs, the purchase confirmation in its four states
//     (unregistered, registered, under 18, over the monthly limit), the starter offer, the deletion-pending block,
//     the season pass (free / paid / plus lines), settings and the legacy screens.
//  3. Round 9 (06 §7 item 12 / §7.3): the replay share card from a result (re-simulated on the device, same hash), the
//     account-link prompt (day 3 once; right after the first purchase; linking sends account_link), and the time attack
//     ghost picker (opens on フレンド, falls back to 上位 without friend ghosts) with a run beside the friend's ghost.
//  4. Round 10: the 支部 cheer-stamp feed (no text field; locked stamps say how they unlock; a stamp sent with the 10 s
//     rule on the CTA; cheering a teammate's race result; mute and report) and this season's pass shown as 購入済み.
//  5. Returning players (REQ-CB-*, 06 §4.5): the comeback welcome (once), the 7-day comeback login track and missions, the
//     lapse-reminder opt-in (asked once), the home chip and the one-time what's-new card.
//  7. Round 12 (REQ-RIVAL-*): the rival strip on home, the rival detail, a race together, the week-result sheet.
//  7. Round 13 (REQ-WCH-*): the weekly challenge — the home card, the list (server condition lines, loan horse, badge, rules,
//     next week), a race on the real engine with the condition in the HUD, the server's verdict on the result screen.
//  8. Round 14 (REQ-MYRP-*): マイリプレイ — list, 残す, rename (NG refused), favourite, public, the WASM player (2×, camera,
//     last 200 m, share), a friend's public replay, 「再生できません」.
//  6. Round 11 (REQ-COL-*, REQ-ACH-*): the 図鑑 (obtained / seen / unknown silhouettes, completion with no reward and no scout
//     link), achievements (claim one tier, claim all) and equipping an achievement title.
//  7. Round 12 (REQ-SHORT-*): the coin shortfall sheet (T6) from the paid step-up → the purchase confirmation → back to the
//     pull; the free-only state; bought packs drawn as 購入済み in the shop.
//  7. Round 13 (REQ-EXCH-*): the event exchange — point counter, event races up to the daily cap, the grid with the stock
//     fact, the confirm sheet, a keyed exchange, the grace notice and the closed state with the leftover converted.
// Screenshots: <out>/u-<nn>-<name>.png. Returns { shots, ftue }.
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');

const TARGET = { ahaMs: 30_000, gachaMs: 100_000, homeMs: 240_000, taps: 15 };

module.exports = async function unityFlow(browser, base, out, errors) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: false, locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('unity pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('unity console: ' + m.text()); });
  const url = base + 'index.html';
  const shots = [];
  for (const f of fs.readdirSync(out)) if (/^u-\d+-.*\.png$/.test(f)) fs.unlinkSync(path.join(out, f));
  let n = 0;
  // time spent capturing screenshots outside races is not the player's time: it is left out of the FTUE timings
  // (inside a race the engine runs in real time, so a capture there cannot shorten anything and is not subtracted)
  let captureMs = 0;
  const shot = async (name, wait = 420, inRace = false) => {
    const a = Date.now();
    await page.waitForTimeout(wait);
    // toasts from the previous step would cover the screen being captured (the "toast" shots keep theirs)
    if (!name.includes('toast')) await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    const f = path.join(out, `u-${String(++n).padStart(2, '0')}-${name}.png`); await page.screenshot({ path: f }); shots.push(f);
    if (!inRace) captureMs += Date.now() - a;
  };
  const screen = () => page.evaluate(() => globalThis.__muchi?.screen ?? '');
  const waitScreen = (name, timeout = 30000) => page.waitForFunction((x) => { const s = globalThis.__muchi?.screen ?? ''; return Array.isArray(x) ? x.includes(s) : s === x; }, name, { timeout, polling: 50 });
  const state = () => page.evaluate(() => { const s = globalThis.__muchi.state(); const f = s.lastFrame; return { active: s.raceActive, f: f && { tick: f.tick, distanceM: f.distanceM, departed: f.departed, gateOpen: f.gateOpen, remainingM: f.remainingM, whips: f.whips, done: f.done, chance: f.feel?.whipChance, rank: f.rank } }; });
  const btn = (label) => page.locator(`.screen.in [data-label="${label}"]`).first();
  const click = async (label) => { await btn(label).click(); await page.waitForTimeout(350); };
  const ready = () => page.waitForFunction(() => globalThis.__muchi?.ready === true, null, { timeout: 90000 });

  // round 11 (REQ-TRAIN-*): 調教 from the home row → the menu cards (fairness wording, no shop link) → 坂路 with the timing
  // mini-game (taps scheduled on the server's beats, re-scored by the real server rules) → the result and the mission's apple
  // → プール skipped (no mini-game line) → the apple on the horse → the horse's daily limit on every card
  async function trainingFlow() {
    const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
    await click('調教'); await waitScreen('training'); await waitIn('.tr-menu[data-menu="hill"]');
    const text = await page.locator('.screen.in').innerText();
    assert.ok(text.includes('クラスの上限') && text.includes('疲れはどのレースにも影響しません'), 'training: the fairness rules are on the screen');
    assert.ok(!/ショップ|倍/.test(text.replace(/ホーム ・ 厩舎 ・ スカウト ・ ショップ ・ その他/, '')), 'training: no shop link, no 「倍」');
    assert.equal(await page.locator('.screen.in .tr-menu').count(), 4);
    await shot('training', 400);
    await page.locator('.screen.in .tr-menu[data-menu="hill"]').click(); await waitIn('.tr-menu.sel[data-menu="hill"]');
    await click('坂路で調教'); await waitScreen('training-play');
    await page.waitForFunction(() => typeof globalThis.__muchi.trainingStartedAt === 'number' && globalThis.__muchi.screen === 'training-play', null, { timeout: 10000 });
    // tap on every beat (scheduled against the mini-game's own clock, like a precise player)
    await page.evaluate(() => {
      const m = globalThis.__muchi;
      for (const b of m.trainingBeats) setTimeout(() => m.trainingTap(), Math.max(0, b - m.trainingElapsed()));
    });
    await page.waitForTimeout(2600); await shot('training-play', 0);
    await waitScreen('training-result', 20000);
    const r = await page.evaluate(() => globalThis.__muchi.lastTraining);
    assert.equal(r.settled, 'done');
    assert.ok(r.timing.perfect + r.timing.good === 5 && r.grade !== 'normal', `every beat hit (${JSON.stringify(r.timing)})`);
    assert.ok(r.total > 0 && r.trainedTotal >= r.total, 'growth applied');
    await shot('training-result', 400);
    await click('ミッション報酬を受け取る'); await waitScreen('training-result');
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => globalThis.__muchi.state().player.items.training_apple), 1, 'the daily mission gave the apple');
    await click('つづける'); await waitScreen('training'); await waitIn('.tr-menu[data-menu="pool"]');
    await page.locator('.screen.in .tr-menu[data-menu="pool"]').click(); await waitIn('.tr-menu.sel[data-menu="pool"]');
    await click('プールで調教'); await waitScreen('training-play'); await page.waitForTimeout(300);
    await click('スキップ'); await waitScreen('training-result', 20000);
    assert.equal((await page.evaluate(() => globalThis.__muchi.lastTraining)).settled, 'skipped');
    await shot('training-result-skipped', 300);
    await click('つづける'); await waitScreen('training'); await waitIn('.tr-item');
    await page.locator('.screen.in .tr-item').click(); await waitScreen('training'); await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => globalThis.__muchi.state().player.items.training_apple ?? 0), 0, 'the apple was given');
    assert.equal(await page.locator('.screen.in .tr-menu[data-state="blocked"]').count(), 4, 'the horse is done for today: every card says why');
    await shot('training-horse-done', 300);
    await click('BACK'); await waitScreen('home');
  }

  // round 14 (REQ-HOF-*): 殿堂 — the stable's 殿堂 button → the gallery → a retirement (the ceremony: horse art, highlight
  // lines, the 殿堂入り stamp, the frame once) → acknowledged → the plaque detail → a friend's hall
  async function hallFlow() {
    const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
    await page.evaluate(() => globalThis.__muchi.show('Stable')); await waitScreen('stable');
    await page.locator('.screen.in .hof-entry').click(); await waitScreen('hall'); await waitIn('.hof-summary');
    await shot('hall-empty', 400);
    await click('デモ：引退式'); await waitScreen('hall-ceremony'); await waitIn('.hof-ceremony');
    const text = await page.locator('.screen.in').innerText();
    assert.ok(text.includes('引退式') && text.includes('戦績の見どころ'), 'hall: the ceremony with its highlight lines');
    assert.ok(!/倍|ショップ|購入する/.test(text), 'hall: no 「倍」, no shop link on the ceremony');
    if (await page.locator('.screen.in .hof-ceremony[data-inducted="true"]').count()) {
      await waitIn('.hof-stamp');
      assert.ok(await page.locator('.screen.in .hof-reward').count(), 'hall: the frame at the first induction');
    }
    await shot('hall-ceremony', 900);
    await page.locator('.screen.in .hof-continue').click(); await waitScreen('hall'); await waitIn('.hof-plaque');
    await shot('hall-gallery', 400);
    await page.locator('.screen.in .hof-plaque').first().click(); await waitIn('.hof-detail');
    await shot('hall-plaque', 500);
    await page.locator('.screen.in .hof-detail [data-label="閉じる"]').click(); await page.waitForTimeout(300);
    await click('デモ：友達の殿堂'); await waitScreen('hall-friend'); await waitIn('.hof-plaque');
    assert.equal(await page.locator('.screen.in .hof-summary').getAttribute('data-relation'), 'friend', 'hall: a friend\'s hall');
    assert.equal(await page.locator('.screen.in .hof-vis').count(), 0, 'hall: no settings on a friend\'s hall');
    await shot('hall-friend', 400);
    await click('BACK'); await waitScreen('hall'); await click('BACK'); await waitScreen('stable');
  }

  // round 12 (REQ-RIVAL-*): ライバル — the home strip → the detail (public card, score, races, time attack, rules) → a race
  // together, a time attack each, a challenge (no point) → the week ends → the result sheet once (fixed reward, title)
  async function rivalFlow() {
    const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
    await waitScreen('home'); await waitIn('.rv-strip');
    assert.equal(await page.locator('.screen.in .rv-strip').getAttribute('data-home-rival'), 'human', 'rival: paired with last week\'s candidate');
    await shot('rival-home-strip', 300);
    await page.locator('.screen.in .rv-strip').click(); await waitScreen('rival'); await waitIn('.rv-card[data-state="human"]');
    // the demo days crossed a week boundary: an earlier week's result sheet comes first (once)
    if (await page.locator('.screen.in .rv-result').count()) { await shot('rival-earlier-week', 400); await page.locator('.screen.in .rv-result .rv-continue').click(); await page.waitForTimeout(400); }
    const text = await page.locator('.screen.in').innerText();
    assert.ok(text.includes('点になりません') && text.includes('連勝の上乗せはありません') && text.includes('相棒'), 'rival: public card and the rules on the screen');
    assert.ok(!/倍|ショップ/.test(text.replace(/ホーム ・ 厩舎 ・ スカウト ・ ショップ ・ その他/, '')), 'rival: no 「倍」, no shop link');
    await shot('rival-detail', 400);
    await click('デモ：同じレース'); await waitIn('.rv-race');
    await click('デモ：タイム'); await waitIn('.rv-ta');
    await page.locator('.screen.in .rv-challenge').click(); await page.waitForTimeout(600); await waitIn('.rv-card');
    await shot('rival-detail-races', 400);
    const free0 = await page.evaluate(() => globalThis.__muchi.state().player.wallet.free);
    await click('デモ：週を終える'); await waitIn('.rv-result');
    await shot('rival-week-result', 500);
    const sheet = await page.locator('.screen.in .rv-result').innerText();
    assert.ok(/報酬/.test(sheet) && !/倍/.test(sheet), 'rival: the week result states the fixed reward');
    await page.locator('.screen.in .rv-result .rv-continue').click(); await page.waitForTimeout(300);
    const free1 = await page.evaluate(async () => (await globalThis.__muchi.logic.view()).wallet.free);
    assert.ok(free1 - free0 <= 20, 'rival: at most the fixed reward');
    await click('BACK'); await waitScreen('home');
    await page.evaluate(() => globalThis.__muchi.logic.setClockMs(null)); // back to the demo day for the next flows
  }

  // round 13 (REQ-EXCH-*): イベント交換所 — the event top's point counter on the real rules (demo clock inside the event), event
  // races earning points up to the daily cap, the exchange grid with the stock fact, the confirm sheet, a keyed exchange, the
  // post-event grace notice (exchange only) and the closed state with the leftover converted into material
  async function exchangeFlow() {
    const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
    await page.evaluate(() => globalThis.__muchi.logic.exchangeDemo('open'));
    await page.evaluate(() => globalThis.__muchi.show('EventTop')); await waitScreen('event-top'); await waitIn('.ev-points');
    const text = await page.locator('.screen.in').innerText();
    assert.ok(text.includes('購入はできません') && text.includes('ランダムなものはありません'), 'exchange: points cannot be bought, nothing random');
    assert.ok(!/倍|今だけ|残りわずか|お得|通常価格/.test(text), 'exchange: no multipliers or urgency words');
    await shot('event-top', 400);
    await click('デモ：イベントレースを1回'); await waitScreen('event-top'); await waitIn('.ev-points');
    // three wins on the real result path (the demo button uses a random place) so the material line is affordable
    await page.evaluate(async () => { const L = globalThis.__muchi.logic; for (let i = 0; i < 3; i++) await L.eventDemoRace(L.exchangeEventId(), 1); });
    await page.evaluate(() => globalThis.__muchi.show('EventTop')); await waitScreen('event-top'); await waitIn('.ev-points');
    const pts = Number(await page.locator('.screen.in .ev-points').getAttribute('data-points'));
    assert.ok(pts > 0, 'event races earned points');
    await shot('event-top-points', 400);
    await click('交換所へ'); await waitScreen('exchange'); await waitIn('.ex-card[data-item="ex_material"]');
    assert.equal(await page.locator('.screen.in .ex-card').count(), 5);
    assert.match(await page.locator('.screen.in .ex-card[data-item="ex_material"] .ex-stock').innerText(), /残り 3 \/ 3/);
    await shot('exchange', 400);
    await page.locator('.screen.in .ex-card[data-item="ex_material"] [data-label="交換する"]').click(); await waitIn('.ex-sheet');
    await shot('exchange-confirm', 400);
    await page.locator('.screen.in .ex-sheet [data-label="交換する"]').click();
    await page.waitForTimeout(500); await waitScreen('exchange'); await waitIn('.ex-card[data-item="ex_material"] .ex-stock[data-remaining="2"]');
    assert.equal(Number(await page.locator('.screen.in .ex-points').getAttribute('data-points')), pts - 120, 'the price was taken');
    await shot('exchange-after', 400);
    await page.evaluate(() => globalThis.__muchi.logic.exchangeDemo('grace'));
    await page.evaluate(() => globalThis.__muchi.show('EventTop')); await waitScreen('event-top'); await waitIn('.ev-grace[data-status="grace"]');
    assert.match(await page.locator('.screen.in .ev-grace').innerText(), /イベントは終了しました。交換は \d+月\d+日 \d\d:\d\dまで/);
    await shot('event-top-grace', 400);
    await click('交換所へ'); await waitScreen('exchange'); await waitIn('.ex-grace'); await shot('exchange-grace', 400);
    await page.evaluate(() => globalThis.__muchi.logic.exchangeDemo('closed'));
    await page.evaluate(() => globalThis.__muchi.show('Exchange')); await waitScreen('exchange'); await waitIn('.ex-grace[data-status="closed"]');
    assert.equal(await page.locator('.screen.in .ex-card[data-state="ok"]').count(), 0, 'closed: nothing can be exchanged');
    assert.match(await page.locator('.screen.in').innerText(), /配合素材 \d+個になりました/);
    await shot('exchange-closed', 400);
    await page.evaluate(() => globalThis.__muchi.logic.exchangeDemo(null));
    await page.evaluate(() => globalThis.__muchi.show('Home')); await waitScreen('home');
  }

  // round 13 (REQ-WCH-*): 週替わりチャレンジ from the home card → this week's three (condition lines from the server, the loan
  // horse at the cap, the cosmetic badge, the fairness rules, no shop link) → next week's preview → a race with the loan horse
  // on the real engine, the condition live in the HUD → the result decided by the logic's re-simulation of the issued config
  async function challengeFlow() {
    const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
    await waitIn('.wch-home');
    await shot('home-weekly-challenge', 300);
    await page.locator('.screen.in .wch-open').click(); await waitScreen('weekly-challenge'); await waitIn('.wch-card');
    const text = await page.locator('.screen.in').innerText();
    assert.ok(text.includes('クラスBの上限') && text.includes('見た目だけ') && text.includes('週1回'), 'challenge: the fairness rules, the cosmetic badge and once a week are on the screen');
    assert.ok(!/倍|今だけ|残りわずか|お得|通常価格/.test(text), 'challenge: no banned wording');
    assert.ok(!/ショップ/.test(text.replace(/ホーム ・ 厩舎 ・ スカウト ・ ショップ ・ その他/, '')), 'challenge: no shop link');
    assert.equal(await page.locator('.screen.in .wch-card').count(), 3, 'three challenges this week');
    await shot('weekly-challenge', 400);
    await page.locator('.screen.in .wch-next').click(); await page.waitForTimeout(400); await shot('weekly-challenge-next', 300);
    await click('閉じる'); await page.waitForTimeout(300);
    // the challenge with a place condition and the most whips allowed (the scripted rider whips twice)
    const pick = await page.evaluate(async () => {
      const v = (await globalThis.__muchi.logic.weeklyChallenges()).value;
      const ok = v.challenges.filter((c) => c.conditions.maxWhips === undefined || c.conditions.maxWhips >= 2);
      return (ok.find((c) => c.conditions.maxPlace !== undefined) ?? ok[0] ?? v.challenges[0]).id;
    });
    await page.locator(`.screen.in .wch-card[data-challenge="${pick}"]`).click(); await waitIn(`.glass[data-challenge="${pick}"]`);
    await click('貸し出し馬で挑戦'); await waitScreen('race', 30000); await waitIn('.wch-hud');
    const maxWhips = await page.evaluate(() => globalThis.__muchi.challengeSession.challenge.conditions.maxWhips ?? 2);
    let started = false, w = 0, lastW = 0, hudShot = false;
    for (let i = 0; i < 4000; i++) {
      const s = await state();
      if (!s.f) { await page.waitForTimeout(50); continue; }
      if (s.f.done || (await screen()) !== 'race') break;
      if (!started && s.f.gateOpen && !s.f.departed) { await page.locator('.screen.in .btn.whip').click({ force: true }); started = true; }
      if (!hudShot && s.f.departed && s.f.remainingM < s.f.distanceM * .55) { hudShot = true; await shot('challenge-race-hud', 0, true); }
      if (s.f.departed && w < Math.min(2, maxWhips) && s.f.remainingM <= (w === 0 ? 380 : 220) && s.f.whips > 0 && Date.now() - lastW > 1500) { await page.locator('.screen.in .btn.whip').click({ force: true }); w++; lastW = Date.now(); }
      await page.waitForTimeout(40);
    }
    await waitScreen('challenge-result', 60000); await waitIn('.wch-verdict');
    const res = await page.evaluate(() => globalThis.__muchi.lastChallenge);
    const dev = await page.evaluate(() => globalThis.__muchi.state().lastFrame.challengeRun);
    assert.ok(res && res.evaluation && !res.error, 'challenge: the logic verified the run');
    assert.equal(res.cleared, dev.cleared, 'challenge: the device verdict (ChallengeEvaluator) equals the verified one');
    assert.equal(res.evaluation.place, dev.place, 'challenge: the same place on both sides');
    assert.equal(res.evaluation.whips, dev.whips, 'challenge: the same whip count on both sides');
    const nLabels = await page.evaluate(() => globalThis.__muchi.challengeSession.challenge.labels.length);
    assert.equal(await page.locator('.screen.in .wch-check').count(), nLabels, 'challenge: one ○/× line per condition');
    await shot('challenge-result', 500);
    await click('一覧へ'); await waitScreen('weekly-challenge'); await waitIn('.wch-card');
    await shot('weekly-challenge-after', 300);
    await click('BACK'); await waitScreen('home');
  }

  // round 14 (REQ-SILK-*, protocol §35): 勝負服エディタ from the wardrobe — try on a locked sleeve (試着中, live recolour of the
  // photoreal jockey), save refused until owned → the parts sheet → the purchase confirmation (paid coins first) → bought →
  // saved; a paid-only colour goes to the coin shortfall sheet (T6); readability dimming; a preset; the shop's parts card
  async function silksFlow() {
    const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
    await page.evaluate(() => globalThis.__muchi.show('Wardrobe')); await page.waitForTimeout(450);
    await click('勝負服エディタ'); await waitScreen('silks'); await waitIn('.silks-canvas');
    await page.waitForTimeout(700);
    await shot('silks-editor', 300);
    await page.locator('.screen.in [data-silks-tab="sleeve"]').click(); await waitIn('[data-silks-tab="sleeve"].on');
    await page.locator('.screen.in .silks-part[data-part="stars"]').click(); await waitIn('.silks-part.on[data-part="stars"]');
    assert.equal(await page.locator('.screen.in [data-name="Silks preview"]').getAttribute('data-trying'), '1', 'silks: the locked sleeve is tried on');
    assert.ok((await page.locator('.screen.in').innerText()).includes('試着中'), 'silks: 試着中 label');
    await shot('silks-try-on', 600);
    assert.equal(await page.locator('.screen.in [data-silks-save]').getAttribute('data-silks-save'), 'needs-parts');
    await page.locator('.screen.in [data-silks-save]').click(); await page.waitForSelector('.screen.in .sheet [data-need="stars"]');
    await shot('silks-need-parts', 400);
    await page.locator('.screen.in .sheet [data-need="stars"] [data-label="購入を確認"]').click(); await waitScreen('silks-buy');
    const conf = await page.locator('.screen.in').innerText();
    assert.ok(conf.includes('有償コインから先に使われます') && conf.includes('確率なし') && !/倍|お得|今だけ|残りわずか|通常価格/.test(conf), 'silks: the purchase confirmation states the split, no random, no pressure words');
    await shot('silks-buy-confirm', 400);
    const free0 = await page.evaluate(async () => (await globalThis.__muchi.logic.view()).wallet.free);
    await click('購入する'); await waitScreen('silks'); await waitIn('[data-silks-save="ready"]');
    const free1 = await page.evaluate(async () => (await globalThis.__muchi.logic.view()).wallet.free);
    assert.equal(free0 - free1, 200, 'silks: the fixed price, free coins (no paid coins in the demo wallet)');
    await page.locator('.screen.in [data-silks-save]').click(); await page.waitForTimeout(600); await waitScreen('silks');
    const cur = await page.evaluate(async () => (await globalThis.__muchi.logic.silksEditor()).current);
    assert.equal(cur.design.sleeve, 'stars', 'silks: saved on the server rules');
    assert.match(cur.code, /^1[0-9a-z]{16}$/, 'silks: the shared code');
    await shot('silks-saved', 400);
    // readability: the colour paired with a near shade is dimmed; a paid-only colour → the shortfall sheet
    await page.locator('.screen.in [data-silks-tab="color"]').click(); await waitIn('[data-silks-tab="color"].on');
    await page.locator('.screen.in [data-silks-slot="1"]').click(); await waitIn('[data-silks-slot="1"].on');
    await page.locator('.screen.in .silks-part[data-part="white"]').click(); await waitIn('.silks-part.on[data-part="white"]');
    await page.locator('.screen.in [data-silks-slot="0"]').click(); await waitIn('[data-silks-slot="0"].on');
    assert.equal(await page.locator('.screen.in .silks-part[data-part="platinum"]').getAttribute('data-low'), 'true', 'silks: platinum next to white is dimmed');
    await shot('silks-colours', 400);
    await page.locator('.screen.in .silks-part[data-part="platinum"]').click(); await waitIn('.silks-part.on[data-part="platinum"]');
    await page.locator('.screen.in [data-silks-slot="1"]').click(); await waitIn('[data-silks-slot="1"].on');
    await page.locator('.screen.in .silks-part[data-part="navy"]').click(); await waitIn('.silks-part.on[data-part="navy"]');
    await page.locator('.screen.in [data-silks-save]').click(); await page.waitForSelector('.screen.in .sheet [data-need="platinum"]');
    await page.locator('.screen.in .sheet [data-need="platinum"] [data-label="購入を確認"]').click(); await waitScreen('silks-buy');
    assert.ok((await page.locator('.screen.in').innerText()).includes('有償限定'), 'silks: paid-only part says so');
    await click('購入する'); await waitScreen('shortfall');
    assert.equal(await page.locator('.screen.in [data-coin-kind]').getAttribute('data-coin-kind'), 'paid', 'silks: the shortfall counts paid coins only');
    await shot('silks-paid-only-shortfall', 400);
    await click('閉じる'); await waitScreen('silks');
    await click('元に戻す'); await waitIn('[data-silks-save]');
    // a preset in the first slot
    await page.locator('.screen.in [data-preset="0"]').click(); await page.waitForTimeout(500); await waitScreen('silks');
    assert.equal((await page.evaluate(async () => (await globalThis.__muchi.logic.silksEditor()).presets)).length, 1, 'silks: preset saved');
    await shot('silks-preset', 400);
    // the shop's 見た目 tab: the parts card opens the editor
    await page.evaluate(() => globalThis.__muchi.show('Store', 'looks')); await waitScreen('shop-looks');
    await waitIn('[data-item="silks_parts"]'); await shot('shop-looks-silks-parts', 500);
    await page.locator('.screen.in [data-item="silks_parts"] [data-label="エディタで試着"]').click(); await waitScreen('silks');
    await click('BACK'); await page.waitForTimeout(400);
    await page.evaluate(() => globalThis.__muchi.show('Home')); await waitScreen('home');
  }

  // round 14 (REQ-MYRP-*): マイリプレイ — two demo races on the real engine → the list (best moments / recent) → 残す → the
  // replay sheet → rename (typed, NG word refused) → favourite, public → the player (WASM re-simulation: 2×, camera on
  // another horse, the last 200 m, share card + replay_share) → a friend's public replay → 「再生できません」 (retired ruleset)
  async function myReplaysFlow() {
    const waitIn = (sel, timeout = 15000) => page.waitForSelector(`.screen.in ${sel}`, { timeout });
    await page.evaluate(() => globalThis.__muchi.show('MyReplays')); await waitScreen('my-replays'); await waitIn('.rp-saved');
    await shot('my-replays-empty', 300);
    await click('デモ：レースを走る'); await waitIn('.rp-row');
    await click('デモ：レースを走る'); await page.waitForFunction(() => document.querySelectorAll('.screen.in .rp-row').length >= 2, null, { timeout: 15000 });
    await shot('my-replays-moments', 400);
    await page.locator('.screen.in .rp-keep:not(.disabled)').first().click(); await page.waitForTimeout(400); await waitIn('.rp-card');
    await page.locator('.screen.in .rp-keep:not(.disabled)').first().click(); await page.waitForTimeout(400);
    await page.waitForFunction(() => document.querySelectorAll('.screen.in .rp-card').length >= 2, null, { timeout: 15000 });
    assert.match(await page.locator('.screen.in .rp-count').textContent(), /2 \/ 20/, 'my replays: two saved of 20');
    await shot('my-replays-saved', 400);
    await page.locator('.screen.in .rp-card').first().click(); await waitIn('.rp-sheet');
    await shot('my-replays-sheet', 400);
    await page.locator('.screen.in .rp-sheet .rp-rename').click(); await waitIn('.rp-rename-sheet');
    const input = page.locator('.screen.in .rp-rename-sheet input.field');
    const ng = await page.evaluate(() => globalThis.__muchi.logic.replays.ngSample());
    await input.fill(ng); await page.locator('.screen.in .rp-rename-save').click(); await page.waitForTimeout(400);
    assert.match(await page.locator('.screen.in .rp-rename-error').textContent(), /使えません/, 'my replays: an NG title is refused');
    await shot('my-replays-rename-ng', 300);
    await input.fill('差し切った日'); await page.locator('.screen.in .rp-rename-save').click(); await page.waitForTimeout(500);
    await waitScreen('my-replays'); await waitIn('.rp-card .typed');
    assert.equal(await page.locator('.screen.in .rp-card .rp-title.typed').first().textContent(), '差し切った日');
    await page.locator('.screen.in .rp-card[data-favorite="false"]').first().click(); await waitIn('.rp-sheet');
    await page.locator('.screen.in .rp-sheet .rp-fav').click(); await page.waitForTimeout(500); await waitIn('.rp-card[data-favorite="true"]');
    await page.locator('.screen.in .rp-card').first().click(); await waitIn('.rp-sheet');
    await page.locator('.screen.in .rp-sheet .rp-public').click(); await page.waitForTimeout(500); await waitIn('.rp-card[data-public="true"]');
    await shot('my-replays-favourite-public', 400);
    // the player
    await page.locator('.screen.in .rp-card').first().click(); await waitIn('.rp-sheet');
    await page.locator('.screen.in .rp-sheet .rp-play').click(); await waitScreen('replay-player', 30000);
    await page.waitForFunction(() => (globalThis.__muchi.replay?.t ?? 0) > 500, null, { timeout: 20000 });
    await shot('replay-player', 300);
    await page.locator('.screen.in .rp-speed').click(); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => globalThis.__muchi.replay.speed), 2, 'replay: 2×');
    const cam0 = await page.evaluate(() => globalThis.__muchi.replay.camera);
    await page.locator('.screen.in .rp-cam-next').click(); await page.locator('.screen.in .rp-cam-next').click(); await page.waitForTimeout(200);
    assert.notEqual(await page.evaluate(() => globalThis.__muchi.replay.camera), cam0, 'replay: the camera follows another horse');
    await page.locator('.screen.in .rp-jump').click();
    await page.waitForFunction(() => globalThis.__muchi.replay.remainingM <= 200, null, { timeout: 5000 });
    await page.locator('.screen.in .rp-pause').click(); await page.waitForTimeout(400);
    await shot('replay-player-last200', 300);
    await page.locator('.screen.in .rp-share').click(); await waitIn('.rp-share-sheet');
    await shot('replay-share', 400);
    await page.locator('.screen.in .rp-share-go').click(); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => globalThis.__muchi.lastKpi), 'replay_share');
    await click('BACK'); await waitScreen('my-replays');
    // a friend's public replay
    await page.locator('.screen.in .rp-friend').click(); await waitScreen('friend-replays', 30000); await waitIn('.rp-card');
    await shot('friend-replays', 400);
    await page.locator('.screen.in .rp-card').first().click(); await waitScreen('replay-player', 30000);
    await page.waitForFunction(() => (globalThis.__muchi.replay?.t ?? 0) > 300, null, { timeout: 20000 });
    await shot('friend-replay-player', 300);
    await click('BACK'); await waitScreen('friend-replays'); await click('BACK'); await waitScreen('my-replays');
    // a retired ruleset: never played
    await page.evaluate(() => globalThis.__muchi.logic.replays.demoRetired(true));
    await page.evaluate(() => globalThis.__muchi.show('MyReplays')); await waitScreen('my-replays'); await waitIn('.rp-card[data-playable="false"]');
    await page.locator('.screen.in .rp-card').first().click(); await waitIn('.rp-sheet .rp-unplayable');
    await shot('my-replays-unplayable-sheet', 300);
    await page.evaluate(async () => { const v = (await globalThis.__muchi.logic.replays.view()).value; return globalThis.__muchi.show('ReplayPlayer', v.saved[0].raceId, {}); });
    await waitScreen('replay-unplayable'); await shot('replay-unplayable', 400);
    assert.match(await page.locator('.screen.in').innerText(), /再生できません/);
    await page.evaluate(() => globalThis.__muchi.logic.replays.demoRetired(false));
    await page.evaluate(() => globalThis.__muchi.show('Home')); await waitScreen('home');
  }

  // round 9 (06 §6.5 / §7 item 7): banner calendar with real end times, pity meter, step-up, reveal → summary, the end
  // of a limited banner. The logic clock is set to 2026-11-06 12:00 JST so pickup_ginga (11/1–11/30) is open.
  async function scoutLiveOps() {
    const NOW = Date.UTC(2026, 10, 6, 3), END = Date.UTC(2026, 10, 30, 15);
    // screens fade in (two frames) and re-render under the same name: wait for the element of the new one
    const waitIn = (sel) => page.waitForSelector(`.screen.in ${sel}`, { timeout: 15000 });
    const sel = (id) => waitIn(`.banner-row.sel[data-banner="${id}"]`);
    const rowIds = () => page.locator('.screen.in .banner-row').evaluateAll((els) => els.map((e) => e.dataset.banner));
    const text = (s) => page.locator(`.screen.in ${s}`).first().textContent();
    await page.evaluate((t) => globalThis.__muchi.logic.setClockMs(t), NOW);
    await page.evaluate(() => globalThis.__muchi.show('Scout', 'pickup_ginga')); await sel('pickup_ginga');
    assert.deepEqual(await rowIds(), ['pickup_ginga', 'pickup_akatsuki', 'stepup_paid', 'standard'], 'calendar: limited first, standard last, winter not announced yet');
    await page.waitForTimeout(1100); // the countdown ticks on the corrected clock
    assert.match(await text('[data-countdown="pickup_ginga"]'), /^残り 2\d日 /);
    assert.equal(await text('[data-countdown="standard"]'), '', 'no timer on a permanent banner');
    assert.match(await text('[data-pity-line]'), /^交換pt \d+ \/ 100/);
    assert.equal(await page.locator('.screen.in [data-carry-over]').count(), 1, 'the closing pity group shows its carry-over rule');
    await shot('scout-calendar', 300);
    await page.locator('.screen.in .banner-row[data-banner="stepup_paid"]').click(); await sel('stepup_paid');
    assert.match(await text('[data-step-line]'), /^ステップ 1 \/ 5 ・ 10連 500コイン/);
    await shot('scout-stepup', 400);
    await click('提供割合'); await waitIn('[data-step]');
    assert.equal(await page.locator('.screen.in [data-step]').count(), 5);
    await shot('scout-rates-stepup', 400); await click('BACK'); await sel('stepup_paid');
    await page.locator('.screen.in .banner-row[data-banner="pickup_ginga"]').click(); await sel('pickup_ginga');
    await click('提供割合'); await waitIn('[data-pickup-rate]');
    assert.equal(await page.locator('.screen.in [data-pickup-rate]').getAttribute('data-pickup-rate'), '1.5000%');
    await shot('scout-rates-pickup', 400); await click('BACK'); await sel('pickup_ginga');
    // a 10-pull: the card back glows first, one card per tap, then all-skip → the summary lists all ten
    await page.locator('.screen.in .btn[data-label^="10回引く"]').click(); await waitScreen('scout-reveal');
    await shot('scout-reveal-back', 120);
    await shot('scout-reveal-face', 600);
    await click('タップでめくる'); await shot('scout-reveal-2', 600);
    await click('すべてめくる'); await waitIn('[data-summary]');
    assert.equal(await page.locator('.screen.in .rcard').count(), 10, 'every result is on the summary after a skip');
    const order = await page.evaluate(() => globalThis.__muchi.reveal.order.map((c) => c.tier));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'rarest card flips last');
    assert.match(await page.locator('.screen.in [data-summary]').getAttribute('data-summary'), /^新規 \d+頭/);
    await shot('scout-summary', 600);
    // the last minute of the banner, then a pull after the real end: the server clock refuses it and the list reloads
    await page.evaluate((t) => globalThis.__muchi.logic.setClockMs(t), END - 60_000);
    await page.evaluate(() => globalThis.__muchi.show('Scout', 'pickup_ginga')); await sel('pickup_ginga');
    await page.waitForTimeout(1100);
    assert.match(await text('[data-countdown="pickup_ginga"]'), /^残り 00:0[01]:\d\d$/);
    await shot('scout-last-minute', 300);
    await page.evaluate((t) => globalThis.__muchi.logic.setClockMs(t), END + 1);
    await page.locator('.screen.in .btn[data-label^="10回引く"]').click(); await waitScreen('info');
    await shot('scout-banner-closed', 400);
    await click('OK'); await waitIn('.banner-row.sel');
    assert.ok(!(await rowIds()).includes('pickup_ginga'), 'the ended banner is gone from the list');
    await shot('scout-after-end', 400);
    await page.evaluate(() => globalThis.__muchi.logic.setClockMs(null));
    await page.evaluate(() => globalThis.__muchi.show('Home')); await waitScreen('home');
  }

  // a full race as a player rides it: START on the gate, two spaced whips in the final straight; HUD shots when asked
  async function rideRace(withShots, prefix = 'race-hud') {
    let started = false, w2 = 0, lastW = 0, wall = Date.now(), last = null;
    const raceShots = new Set();
    for (let i = 0; i < 4000; i++) {
      const s = await state();
      if (!s.f) { await page.waitForTimeout(50); continue; }
      last = s.f;
      if (s.f.done || (await screen()) !== 'race') break;
      if (!started && s.f.gateOpen && !s.f.departed) { await tapWhip(); started = true; }
      if (withShots && !raceShots.has('gate')) { raceShots.add('gate'); await shot(prefix + '-gate', 0, true); }
      if (withShots && !raceShots.has('mid') && s.f.remainingM < s.f.distanceM * .55) { raceShots.add('mid'); await shot(prefix + '-mid', 0, true); }
      if (withShots && !raceShots.has('cutin') && await page.locator('.screen.in .cutin').count() > 0) { raceShots.add('cutin'); await shot(prefix + '-skill-cutin', 0, true); }
      if (s.f.departed && w2 < 2 && s.f.remainingM <= (w2 === 0 ? 380 : 220) && s.f.whips > 0 && Date.now() - lastW > 1500) {
        await tapWhip(); w2++; lastW = Date.now();
        if (withShots && w2 === 1) await shot(prefix + '-straight-whip', 120, true);
      }
      await page.waitForTimeout(40);
    }
    return { started, wall, last };
  }

  // ------------------------------------------------------------------ 1. FTUE with a simulated new player
  await page.goto(url); await page.evaluate(() => localStorage.clear());
  const t0 = Date.now();
  let taps = 0, raceTaps = 0;
  const marks = [];
  // lagMs: wall time a race took beyond its engine time (the renderer fell behind real time on a CPU-starved headless
  // machine; a phone at 30–60 fps has none). Measured as wall duration − engine ticks × 50 ms per race.
  let lagMs = 0;
  const mark = (name) => { marks.push({ step: name, ms: Date.now() - t0 - captureMs - lagMs, wallMs: Date.now() - t0, lagMs, captureMs, taps }); };
  const raceLag = (startWall, f) => { if (f?.tick) lagMs += Math.max(0, Date.now() - startWall - f.tick * 50); };
  const THINK_MS = 800;
  const tap = async (label) => { await page.waitForTimeout(THINK_MS); await btn(label).click(); taps++; };
  const tapWhip = async () => { await page.locator('.screen.in .btn.whip').click({ timeout: 5000, force: true }); taps++; raceTaps++; };
  await page.goto(url); await ready();
  await waitScreen('title'); mark('タイトル表示');
  await shot('title', 300);
  await tap('同意してはじめる');
  await waitScreen('race-tutorial'); mark('初レース開始');
  // the tutorial: the whip button only; whip twice once it lights up (REQ-UXS-004)
  let whipped = 0, lastWhip = 0, tutStart = Date.now(), tutLast = null;
  for (let i = 0; i < 600; i++) {
    const s = await state();
    if (s.f) tutLast = s.f;
    if (s.f?.done || (await screen()) !== 'race-tutorial') break;
    if (s.f && s.f.departed && whipped < 2 && (s.f.chance || s.f.remainingM <= 280) && Date.now() - lastWhip > 700) {
      await tapWhip(); whipped++; lastWhip = Date.now();
    }
    await page.waitForTimeout(60);
  }
  raceLag(tutStart, tutLast);
  await waitScreen(['victory', 'tutorial-retry'], 20000);
  assert.equal(await screen(), 'victory', 'two whips in the last 300 m win the tutorial');
  mark('aha①：差し切り（勝利画面）');
  await shot('tutorial-victory', 900);
  await tap('相棒に名前をつける');
  await waitScreen('naming'); mark('命名画面');
  await shot('naming', 300);
  await tap('イッセン');
  await tap('この名前にする');
  await waitScreen('partner-arrive'); mark('相棒の確定');
  await shot('partner-arrive', 1800);
  await waitScreen('free-scout', 8000); mark('無料10連の案内');
  await shot('free-scout', 300);
  await tap('10頭スカウトする（無料）');
  await waitScreen('scout-reveal'); mark('aha②：初ガチャのめくり');
  await shot('scout-reveal-card', 700);
  await tap('すべてめくる');
  await waitScreen('scout-list');
  await shot('scout-list', 700);
  await tap('つづける');
  await waitScreen('second-race'); mark('2戦目の案内');
  await shot('second-race-intro', 300);
  await tap('出走する');
  await waitScreen('race'); mark('2戦目スタート');
  // the second race: start on the gate, whip twice in the final straight (spaced, not mashed)
  { const r2 = await rideRace(false); raceLag(r2.wall, r2.last); }
  await waitScreen('result', 30000); mark('2戦目の結果');
  await shot('race-result-debrief', 900);
  const resultLine = await page.locator('.screen.in [data-debrief]').first().textContent();
  await tap('つづける');
  await waitScreen(['notify', 'home'], 15000);
  if (await screen() === 'notify') { await shot('notify-primer', 300); await tap('あとで'); await waitScreen('home', 15000); }
  mark('ホーム');
  await shot('home-day1', 900);
  const ms = (k) => marks.find((m) => m.step.startsWith(k))?.ms;
  const ftue = { marks, taps, raceTaps, navTaps: taps - raceTaps, resultLine, target: TARGET, thinkMs: THINK_MS };

  // home day 1: only race / partner / scout / stable open; the rest shows its key
  const v = await page.evaluate(() => globalThis.__muchi.state().player.unlocks);
  assert.equal(v.day, 1); assert.equal(v.races, 1);
  assert.ok(await page.locator('.screen.in .btn.tab.locked').count() >= 1, 'shop tab is locked on day 1');
  await btn('ショップ　🔒').click(); await shot('home-day1-locked-toast', 250);
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.screen.in .ad-card').count(), 0, 'no rewarded-ad card in the first session (REQ-AD-001)');

  // ------------------------------------------------------------------ 2. other screens and states
  // the account-link prompt (REQ-UXS-073) comes up once on the first home of day 3+ after the FTUE: shot once, then 「あとで」
  let linkShots = 0;
  // REQ-CB-008: a demo day can cross a dated what's-new entry; the one-time card is closed like a player would
  const closeWhatsNew = async () => {
    const c = page.locator('.screen.in [data-whatsnew-close]');
    if (await c.count()) { await c.first().click(); await page.waitForTimeout(250); }
  };
  const demo = async (k) => {
    await page.evaluate((x) => globalThis.__muchi.demo(x), k); await waitScreen(['home', 'link-prompt'], 20000); await page.waitForTimeout(500);
    await closeWhatsNew();
    if (await screen() === 'link-prompt') {
      assert.notEqual(k, 'day1', 'no account-link prompt on day 1');
      assert.equal(await page.locator('.screen.in [data-trigger]').getAttribute('data-trigger'), 'Day3');
      if (!linkShots++) await shot('link-prompt-day3', 300);
      await click('あとで'); await waitScreen('home', 10000); await page.waitForTimeout(300);
    }
  };
  await demo('day3');
  await shot('home-day3', 600);
  // rewarded ads (REQ-AD-*): the opt-in card on home from day 2 → the simulated ad → the server's verdict from the
  // signed SSV callback → the watched state → the card says today's view is done
  await page.waitForSelector('.screen.in .ad-card[data-placement="daily_coins"][data-state="offer"]', { timeout: 10000 });
  assert.ok(!/倍/.test(await page.locator('.screen.in .ad-card').innerText()), 'ad card: fixed amounts, no 「倍」');
  await shot('ad-offer-home', 200);
  const free0 = await page.evaluate(() => globalThis.__muchi.state().player.wallet.free);
  const paid0 = await page.evaluate(() => globalThis.__muchi.state().player.wallet.paid);
  await click('動画を見る'); await waitScreen('ad-player'); await shot('ad-player-simulated', 300);
  await waitScreen('ad-watched', 30000);
  assert.equal(await page.evaluate(() => globalThis.__muchi.lastAd), 'rewarded');
  await shot('ad-watched', 300);
  const w1 = await page.evaluate(() => globalThis.__muchi.state().player.wallet);
  assert.equal(w1.free - free0, 10, 'the SSV callback granted 10 free coins');
  assert.equal(w1.paid, paid0, 'never paid coins');
  await click('つづける'); await waitScreen('home');
  await page.waitForSelector('.screen.in .ad-card[data-state="done"]', { timeout: 10000 });
  await shot('ad-offer-done', 200);
  assert.equal(await page.locator('.screen.in .btn.tab.locked').count(), 0, 'shop open on day 3');
  await click('ショップ'); await waitScreen('shop-recommended'); await shot('shop-recommended', 600);
  assert.ok(await page.locator('.screen.in .countdown').count() === 1, 'pass offer shows the real season-end countdown');
  const shopText = await page.locator('.screen.in').innerText();
  assert.ok(!/倍/.test(shopText), 'no 「倍」 wording in the shop');
  await click('コイン'); await waitScreen('shop-coins'); await shot('shop-coins', 500);
  await click('見た目'); await waitScreen('shop-looks'); await shot('shop-looks', 500);
  await click('特定商取引法に基づく表記'); await waitScreen('legal'); await shot('legal-tokushoho', 300); await click('閉じる');
  // purchase confirmation: unregistered → registered (adult) → under 18 (guardian) → over the monthly limit
  await click('コイン'); await waitScreen('shop-coins');
  await page.locator('.screen.in [data-product="coin_10000"] [data-label="購入を確認"]').click(); await waitScreen('purchase');
  assert.equal(await page.locator('.screen.in .pstate').getAttribute('data-state'), 'unregistered');
  await shot('purchase-unregistered', 400);
  const year = new Date().getFullYear();
  await page.selectOption('.screen.in select[aria-label="年"]', String(year - 31)); await page.selectOption('.screen.in select[aria-label="月"]', '1');
  await click('登録して確認する');
  await page.waitForFunction(() => document.querySelector('.screen.in .pstate')?.dataset.state === 'registered');
  await shot('purchase-registered', 400);
  await click('年齢を訂正する');
  await page.selectOption('.screen.in select[aria-label="年"]', String(year - 15)); await page.selectOption('.screen.in select[aria-label="月"]', '1');
  await shot('purchase-under18-guardian', 400);
  await page.locator('.screen.in .btn.check').click(); await page.waitForTimeout(200);
  await click('登録して確認する');
  await page.waitForFunction(() => document.querySelector('.screen.in .pstate')?.dataset.state === 'limit');
  await shot('purchase-over-limit', 400);
  await click('閉じる');
  await page.evaluate(() => globalThis.__muchi.show('PurchaseConfirm', 'starter_pack'));
  await page.waitForFunction(() => document.querySelector('.screen.in .pstate')?.dataset.state === 'registered');
  await shot('purchase-starter-under18', 400);
  await click('閉じる');
  // T2 starter sheet (shown once after a result screen; triggered by the 5th ranked race here)
  await page.evaluate(() => globalThis.__muchi.offer());
  await waitScreen(['offer', 'home'], 10000);
  if (await screen() === 'offer') { await shot('offer-starter', 400); await click('閉じる'); }
  // season pass: free / paid / plus lines, claim the free tiers
  await page.evaluate(() => globalThis.__muchi.show('SeasonPass')); await waitScreen('pass'); await shot('season-pass', 700);
  const claimAll = page.locator('.screen.in .btn[data-label^="まとめて受け取る"]');
  if (await claimAll.count()) { await claimAll.click(); await waitScreen('pass'); await shot('season-pass-claimed', 700); }
  await page.locator('.screen.in .btn[data-label="有料ラインを開ける"]').click(); await waitScreen('purchase'); await shot('purchase-season-pass', 400); await click('閉じる');
  // account deletion: request → confirm → shop blocked → cancel
  await page.evaluate(() => globalThis.__muchi.show('Settings')); await waitScreen('settings'); await shot('settings', 500);
  await click('アカウントを削除する'); await waitScreen('delete-confirm'); await shot('delete-confirm', 300);
  await click('削除を確定（14日後）'); await waitScreen('settings');
  await shot('settings-deletion-pending', 500);
  await page.evaluate(() => globalThis.__muchi.show('Store', 'coins')); await waitScreen('shop-coins'); await shot('shop-deletion-blocked', 500);
  await page.locator('.screen.in [data-product="coin_160"] [data-label="購入を確認"]').click({ force: true }).catch(() => {});
  await page.evaluate(() => globalThis.__muchi.show('PurchaseConfirm', 'coin_160')); await waitScreen('purchase');
  assert.equal(await page.locator('.screen.in .pstate').getAttribute('data-state'), 'deletion');
  await shot('purchase-deletion-blocked', 400); await click('閉じる');
  await page.evaluate(() => globalThis.__muchi.show('Settings')); await waitScreen('settings');
  await click('アカウント削除の取り消し'); await waitScreen('settings');
  // day 7 home; scout (paid) and its reveal; legacy screens
  await demo('day7'); await shot('home-day7', 600);
  await trainingFlow();
  await rivalFlow();
  await exchangeFlow();
  await challengeFlow();
  await hallFlow();
  await silksFlow();
  await myReplaysFlow();
  await page.evaluate(() => globalThis.__muchi.show('Scout')); await waitScreen('scout'); await shot('scout', 500);
  await click('提供割合'); await shot('scout-rates', 400); await click('BACK');
  await waitScreen('scout'); await page.locator('.screen.in .btn[data-label^="10回引く"]').click(); await waitScreen('scout-reveal'); await shot('scout-paid-reveal', 700);
  await click('すべてめくる'); await waitScreen('scout-list'); await shot('scout-paid-list', 500); await click('ホームへ');
  await waitScreen('home');
  await scoutLiveOps();
  await click('厩舎'); await shot('stable', 400); await click('BACK');
  await waitScreen('home');
  await click('レースへ'); await waitScreen('lobby'); await shot('race-lobby', 400); await click('戻る');
  await waitScreen('home');
  for (const [name, fn] of [['wardrobe', 'Wardrobe'], ['course-looks', 'CourseThemes'], ['conditions', 'Conditions'], ['care', 'Care']]) {
    await page.evaluate((f) => globalThis.__muchi.show(f), fn); await shot(name, 450);
  }
  // the race HUD (full layout) and the result screen in a race from the lobby
  await page.evaluate(() => globalThis.__muchi.show('Home')); await waitScreen('home');
  await click('レースへ'); await waitScreen('lobby'); await click('ランク戦に出る'); await waitScreen('race', 20000);
  await rideRace(true);
  await waitScreen(['result'], 30000); await shot('race-result-day7', 900);

  // ------------------------------------------------------------------ 3. round 9
  // replay share card: the last 200 m re-simulated by ReplayClip (same hash as the live race), looping on the 3D view
  await click('リプレイを共有'); await waitScreen('share'); await page.waitForTimeout(1600);
  assert.equal(await page.locator('.screen.in [data-hash]').getAttribute('data-hash'), 'match', 'the re-simulated clip reproduces the race');
  assert.ok((await page.locator('.screen.in [data-share="horse"]').textContent()).length > 0);
  assert.ok(!(await page.locator('.screen.in [data-card]').innerText()).includes('local'), 'no player id on the card');
  await shot('share-card', 200);
  await click('戻る'); await waitScreen('result');
  // time attack ghost picker: friends first, the top list without friend ghosts, a run beside the friend's ghost
  await page.evaluate(() => globalThis.__muchi.show('TimeAttack')); await waitScreen('time-attack', 30000); await page.waitForTimeout(400);
  const picker = page.locator('.screen.in [data-name="Ghost picker"]');
  assert.equal(await picker.getAttribute('data-tab'), 'friends', 'the picker opens on フレンド');
  await shot('ta-picker-friends', 300);
  await page.locator('.screen.in .ghosttab[data-kind="top"]').click(); await page.waitForTimeout(400);
  assert.equal(await page.locator('.screen.in [data-name="Ghost picker"]').getAttribute('data-tab'), 'top');
  await shot('ta-picker-top', 300);
  await page.locator('.screen.in .ta-friends-toggle').click(); await page.waitForTimeout(500);
  assert.equal(await page.locator('.screen.in [data-name="Ghost picker"]').getAttribute('data-fellback'), 'true', 'no friend ghosts → falls back to 上位');
  assert.equal(await page.locator('.screen.in [data-note]').getAttribute('data-note'), 'fallback');
  await shot('ta-picker-no-friends', 300);
  await page.locator('.screen.in .ta-friends-toggle').click(); await page.waitForTimeout(500);
  assert.equal(await page.locator('.screen.in [data-name="Ghost picker"]').getAttribute('data-tab'), 'friends');
  await page.locator('.screen.in .ta-start').click(); await waitScreen('race', 20000);
  await rideRace(true, 'ta-hud');
  await waitScreen('ta-result', 30000); await shot('ta-result', 700);
  assert.equal(await page.locator('.screen.in [data-vs-ghost]').count(), 1, 'the result compares with the friend ghost');
  await click('リプレイを共有'); await waitScreen('share'); await page.waitForTimeout(1600);
  assert.equal(await page.locator('.screen.in [data-hash]').getAttribute('data-hash'), 'match');
  assert.equal(await page.locator('.screen.in [data-share="place"]').textContent(), '完走');
  await shot('share-card-time-attack', 200);
  await click('戻る'); await waitScreen('ta-result');
  // account-link prompt right after the first purchase (day 1 after the FTUE), then linking (account_link KPI)
  await demo('day1');
  await page.evaluate(() => globalThis.__muchi.show('Settings')); await waitScreen('settings');
  await click('初回購入の直後'); await waitScreen('link-prompt');
  assert.equal(await page.locator('.screen.in [data-trigger]').getAttribute('data-trigger'), 'FirstPurchase');
  await shot('link-prompt-first-purchase', 300);
  await click('Appleで引き継ぎ登録'); await waitScreen('settings');
  assert.equal(await page.evaluate(() => globalThis.__muchi.lastKpi), 'account_link');
  await shot('settings-linked', 400);
  await click('初回購入の直後'); await page.waitForTimeout(300);
  assert.equal(await screen(), 'settings', 'linked: the prompt never comes back');
  // ------------------------------------------------------------------ 4. round 10
  // 支部の応援スタンプ (REQ-TEAMFEED-*): the demo team's feed on the real TeamsService / TeamCore
  await page.evaluate(() => globalThis.__muchi.show('TeamFeed')); await waitScreen('team-feed', 20000); await page.waitForTimeout(500);
  assert.ok(await page.locator('.screen.in .tf-row[data-kind="race"]').count() >= 1, 'a teammate race result is in the feed');
  assert.equal(await page.locator('.screen.in input, .screen.in textarea, .screen.in [contenteditable]').count(), 0, 'no free text anywhere in the feed');
  assert.ok(await page.locator('.screen.in .tf-stamp.locked').count() >= 1, 'locked stamps are shown with their unlock text');
  await shot('team-feed', 300);
  await page.locator('.screen.in .tf-stamp.locked[data-stamp="whip"]').click(); await page.waitForTimeout(250);
  assert.match(await page.locator('.toast').last().textContent(), /レースに10回出走で解放/);
  await shot('team-feed-locked-toast', 100);
  await page.locator('.screen.in .tf-stamp[data-stamp="nice"]').click(); await page.waitForTimeout(400);
  await page.locator('.screen.in .btn.tf-cta').click(); await page.waitForTimeout(700);
  const first = page.locator('.screen.in .tf-row').first();
  assert.equal(await first.getAttribute('data-kind'), 'stamp'); assert.match(await first.getAttribute('class'), /mine/);
  assert.match(await page.locator('.screen.in .btn.tf-cta').getAttribute('class'), /disabled/, '10 s cooldown on the CTA');
  await shot('team-feed-sent', 300);
  await click('支部員のデモ'); await page.waitForTimeout(700); // teammates act (the demo clock moves past the 10 s rule)
  await page.locator('.screen.in .tf-row.race:not(.mine) .tf-cheer').first().click(); await page.waitForTimeout(700);
  assert.ok(await page.locator('.screen.in .tf-cheer.on').count() >= 1, 'my cheer is on the teammate race result');
  await shot('team-feed-cheered', 300);
  const victim = await page.locator('.screen.in .tf-row.race:not(.mine)').first().getAttribute('data-player');
  await page.locator(`.screen.in .tf-row[data-player="${victim}"] .tf-link`, { hasText: '非表示' }).first().click(); await page.waitForTimeout(700);
  assert.equal(await page.locator(`.screen.in .tf-row[data-player="${victim}"]`).count(), 0, 'a muted member disappears from my feed');
  const before = Number(await page.locator('.screen.in .tf-list').getAttribute('data-count'));
  await page.locator('.screen.in .tf-row:not(.mine) .tf-link', { hasText: '報告' }).first().click(); await page.waitForTimeout(700);
  assert.equal(Number(await page.locator('.screen.in .tf-list').getAttribute('data-count')), before - 1, 'a reported item is hidden for me');
  await shot('team-feed-muted-reported', 300);
  // r10 fix: this season's pass bought (demo receipt, no billing) → 購入済み in the shop and on the pass screen
  assert.ok((await page.evaluate(() => globalThis.__muchi.logic.demoPurchase('season_pass'))).ok);
  await page.evaluate(() => globalThis.__muchi.show('Store', 'recommended')); await waitScreen('shop-recommended'); await page.waitForTimeout(400);
  assert.match(await page.locator('.screen.in [data-product="season_pass"]').innerText(), /購入済み/);
  await shot('shop-pass-owned', 300);
  await page.evaluate(() => globalThis.__muchi.show('SeasonPass')); await waitScreen('pass'); await page.waitForTimeout(400);
  assert.equal(await page.locator('.screen.in .btn[data-label="購入済み"].disabled').count(), 1, 'the bought pass is not buyable');
  assert.equal(await page.locator('.screen.in .btn[data-label="今シーズンは購入済み"].disabled').count(), 1, 'Pass+ is closed too (one per season)');
  await shot('season-pass-owned', 500);
  // ------------------------------------------------------------------ 4. round 13: 支部の共同目標 (REQ-TGOAL-*)
  // the demo team's week on the real TeamCore / PlayerService rules: milestone bar, contributors, the week result sheet
  await page.evaluate(() => globalThis.__muchi.show('TeamFeed')); await waitScreen('team-feed', 20000); await page.waitForTimeout(400);
  await click('共同目標'); await waitScreen('team-goal'); await page.waitForTimeout(500);
  assert.equal(await page.locator('.screen.in .tg-mark').count(), 3, 'team goal: three milestones on the bar');
  assert.equal(await page.locator('.screen.in input, .screen.in textarea, .screen.in [contenteditable]').count(), 0, 'team goal: nothing to type, no button adds to the goal');
  assert.match(await page.locator('.screen.in').innerText(), /無償・抽選なし/, 'team goal: the reward is free and not a lottery');
  await shot('team-goal', 300);
  const p0 = Number(await page.locator('.screen.in .tg-panel').getAttribute('data-progress'));
  await click('みんなでレース（デモ）'); await waitScreen('team-goal'); await page.waitForTimeout(900);
  const p1 = Number(await page.locator('.screen.in .tg-panel').getAttribute('data-progress'));
  assert.ok(p1 > p0, `team goal: settled races moved the goal (${p0} → ${p1})`);
  assert.ok(await page.locator('.screen.in .tg-row').count() >= 1, 'team goal: top contributors listed');
  assert.ok(await page.locator('.screen.in .tg-name.keep-ja').count() >= 1, 'team goal: names are shown as typed');
  await shot('team-goal-progress', 300);
  await click('週の締め（デモ）'); await waitScreen('team-goal'); await page.waitForTimeout(1000);
  assert.equal(await page.locator('.screen.in .sheet.tg-result').count(), 1, 'team goal: the week result sheet');
  await shot('team-goal-result', 400);
  await page.locator('.screen.in .sheet [data-label="閉じる"]').click(); await page.waitForTimeout(400);
  await page.evaluate(() => globalThis.__muchi.show('TeamGoal')); await waitScreen('team-goal'); await page.waitForTimeout(500);
  assert.equal(await page.locator('.screen.in .sheet.tg-result').count(), 0, 'team goal: the result sheet is shown once per week');
  await page.evaluate(() => globalThis.__muchi.logic.setClockMs(null));
  // ------------------------------------------------------------------ 4. round 10: 友達招待 (REQ-INV-*)
  // my code + share, demo friends redeeming it (real InviteService), milestone rewards via the outbox, entering a code
  await demo('day1');
  await page.evaluate(() => globalThis.__muchi.show('Settings')); await waitScreen('settings');
  await page.locator('.screen.in [data-action="invite"]').click(); await waitScreen('invite'); await page.waitForTimeout(400);
  const myCode = await page.locator('.screen.in [data-code]').getAttribute('data-code');
  assert.match(myCode, /^[23456789BCDFGHJKMNPQRSTVWXZ]{8}$/, 'my invite code');
  assert.equal(await page.locator('.screen.in [data-cap]').getAttribute('data-cap'), '0/10');
  assert.equal(await page.locator('.screen.in [data-milestone]').count(), 3, 'milestone table');
  assert.equal(await page.locator('.screen.in [data-eligible]').getAttribute('data-eligible'), 'true', 'day 1 after the FTUE: entry open');
  assert.equal(await page.locator('.screen.in [data-action="redeem"]').evaluate((e) => e.classList.contains('disabled')), true, 'empty input: redeem disabled');
  await page.waitForSelector('.screen.in [data-demo-code]');
  await shot('invite-mine', 300);
  await click('デモ：友達が参加'); await waitScreen('invite'); await page.waitForTimeout(300);
  await click('デモ：友達が参加'); await waitScreen('invite'); await page.waitForTimeout(300);
  await click('デモ：初心者卒業'); await waitScreen('invite'); await page.waitForTimeout(400);
  assert.equal(await page.locator('.screen.in [data-invitee]').count(), 2, 'two friends joined with my code');
  assert.equal(await page.locator('.screen.in [data-cap]').getAttribute('data-cap'), '2/10');
  assert.equal(await page.locator('.screen.in [data-reached="rewarded"]').count(), 1, 'one milestone paid');
  await page.waitForSelector('.screen.in [data-demo-code]');
  await shot('invite-crew', 300);
  // enter the demo friend's code: a typo keeps the button disabled, the real code redeems (welcome gift + friend)
  const demoCode = await page.locator('.screen.in [data-demo-code]').getAttribute('data-demo-code');
  const field = page.locator('.screen.in .invite-input');
  await field.fill(demoCode.slice(0, -1) + (demoCode.endsWith('B') ? 'C' : 'B'));
  assert.equal(await page.locator('.screen.in [data-action="redeem"]').evaluate((e) => e.classList.contains('disabled')), true, 'typo: redeem disabled');
  await shot('invite-typo', 200);
  await field.fill(demoCode.toLowerCase());
  assert.equal(await page.locator('.screen.in [data-action="redeem"]').evaluate((e) => e.classList.contains('disabled')), false);
  await page.locator('.screen.in [data-action="redeem"]').click(); await page.waitForTimeout(600); await waitScreen('invite');
  assert.equal(await page.locator('.screen.in [data-eligible]').getAttribute('data-eligible'), 'false');
  assert.equal(await page.locator('.screen.in [data-reason]').getAttribute('data-reason'), 'already_redeemed');
  await shot('invite-redeemed', 300);
  // a deep link (unity.html?invite=<code> stands in for muchi://invite/<code>) pre-fills the entry of a fresh player
  await demo('day1');
  const linkCode = await page.evaluate(() => globalThis.__muchi.logic.invite.demoInviterCode());
  await page.goto(url + '?invite=' + encodeURIComponent(linkCode.replace('-', ''))); await ready(); await waitScreen('invite'); await page.waitForTimeout(400);
  assert.equal(await page.locator('.screen.in .invite-input').inputValue(), linkCode, 'deep link pre-fills the code');
  assert.equal(await page.locator('.screen.in [data-action="redeem"]').evaluate((e) => e.classList.contains('disabled')), false, '…ready to redeem (never automatic)');
  await shot('invite-deeplink', 300);
  await page.evaluate(() => localStorage.removeItem('muchi.invite.linkCode'));
  await page.goto(url); await ready();

  // the tutorial screens: the whip-only HUD, the whip cue, and the close-2nd retry when the player never whips
  await page.evaluate(() => globalThis.__muchi.demo('new')); await waitScreen('title', 20000);
  await click('同意してはじめる'); await waitScreen('race-tutorial');
  let introShot = false, chanceShot = false;
  for (let i = 0; i < 600; i++) {
    const s = await state();
    if (s.f?.done || (await screen()) !== 'race-tutorial') break;
    if (!introShot) { introShot = true; await shot('tutorial-intro', 0, true); }
    if (!chanceShot && s.f?.chance) { chanceShot = true; await shot('tutorial-whip-chance', 0, true); }
    await page.waitForTimeout(60);
  }
  await waitScreen(['tutorial-retry', 'victory'], 20000);
  assert.equal(await screen(), 'tutorial-retry', 'no whip → close 2nd and a retry');
  await shot('tutorial-retry', 600);

  // ------------------------------------------------------------------ 4. returning players (REQ-CB-001..012)
  // 3 days of play, 14 days away, back: the server rules start a mid-tier window; the welcome is shown once
  await page.evaluate(() => globalThis.__muchi.demo('comeback')); await waitScreen('comeback-welcome', 30000); await page.waitForTimeout(300);
  const welcome = await page.locator('.screen.in').innerText();
  assert.match(welcome, /14日ぶりのご来場です/);
  assert.match(welcome, /\d+月\d+日まで、復帰キャンペーン/, 'the real window end as a date');
  assert.ok(!/倍/.test(welcome), 'no 「倍」 wording');
  await shot('comeback-welcome', 500);
  await click('受け取りにいく'); await waitScreen('comeback'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.screen.in .cb-cell').count(), 7, '7-day comeback login track');
  assert.equal(await page.locator('.screen.in .cb-cell.today').count(), 1);
  assert.match(await page.locator('.screen.in [data-cb-end]').textContent(), /^\d+月\d+日まで　·　残り14日$/, 'end date + game days left, no timer');
  assert.equal(await page.locator('.screen.in [data-mission]').count(), 5);
  assert.equal(await page.locator('.screen.in [data-optin]').count(), 1, 'the lapse-reminder opt-in is offered');
  await shot('comeback-track', 500);
  await click('今日の分を受け取る'); await page.waitForTimeout(700); await waitScreen('comeback');
  await page.waitForSelector('.screen.in .cb-cell.claimed', { timeout: 10000 });
  assert.equal(await page.locator('.screen.in .cb-cell.claimed').count(), 1);
  assert.equal(await page.locator('.screen.in .btn[data-label="今日の分を受け取る"]').count(), 0, 'one comeback login day per game day');
  await shot('comeback-claimed-toast', 250);
  await click('いいえ'); await page.waitForTimeout(500);
  assert.equal(await page.locator('.screen.in [data-optin]').count(), 0, 'the opt-in is asked once');
  await click('ホームへ'); await waitScreen(['home', 'link-prompt'], 10000); await page.waitForTimeout(500);
  if (await screen() === 'link-prompt') { await click('あとで'); await waitScreen('home', 10000); await page.waitForTimeout(500); }
  await page.waitForSelector('.screen.in [data-whatsnew]', { timeout: 10000 });
  const items = await page.locator('.screen.in [data-item]').evaluateAll((els) => els.map((e) => e.dataset.item));
  assert.ok(items.includes('skills_v1') || items.length >= 1, 'what\'s new lists what went live while away');
  await shot('home-whats-new', 400);
  await page.locator('.screen.in [data-whatsnew-close]').click(); await page.waitForTimeout(400);
  assert.equal(await page.locator('.screen.in [data-whatsnew]').count(), 0);
  assert.equal(await page.locator('.screen.in [data-comeback="mid"]').count(), 1, 'the home chip leads back to the campaign');
  await shot('home-comeback-chip', 300);
  await page.evaluate(() => globalThis.__muchi.show('Home')); await waitScreen(['home', 'link-prompt'], 10000); await page.waitForTimeout(500);
  if (await screen() === 'link-prompt') { await click('あとで'); await waitScreen('home', 10000); await page.waitForTimeout(500); }
  assert.equal(await screen(), 'home', 'the welcome is not shown again');
  assert.equal(await page.locator('.screen.in [data-whatsnew]').count(), 0, 'the what\'s-new card is shown once');

  // ------------------------------------------------------------------ 5. round 11: 図鑑・実績・称号 (REQ-COL-*, REQ-ACH-*)
  // a week of play on the real rules (races on 5 courses against CPU fields, a fired skill every other race, a cup win,
  // stable likes): the book, the achievements and the titles all come from the server code
  await page.evaluate(() => globalThis.__muchi.demo('collection')); await waitScreen('collection', 60000); await page.waitForTimeout(400);
  const colText = await page.locator('.screen.in').innerText();
  assert.match(colText, /達成率 \d+%（\d+ \/ \d+）/, 'completion shown as a number');
  assert.match(colText, /そろえても報酬はありません/, 'the book says completing it pays nothing');
  assert.ok(!/スカウト|ガチャ|あと\d+体|もらえる/.test(colText), 'no scout / gacha / 「あと◯体」 wording in the book');
  const cells = page.locator('.screen.in [data-col-cell]');
  assert.ok((await cells.count()) >= 20, 'every horse template has a cell');
  for (const st of ['obtained', 'seen', 'unknown']) assert.ok((await page.locator(`.screen.in [data-col-cell][data-state="${st}"]`).count()) > 0, `some ${st} horses`);
  const unknownCell = page.locator('.screen.in [data-col-cell][data-state="unknown"]').first();
  assert.match(await unknownCell.innerText(), /？？？/, 'an unknown horse is a silhouette with ？？？');
  assert.equal(await unknownCell.locator('img.col-sil').count(), 1);
  await shot('collection-horses', 500);
  await unknownCell.click(); await page.waitForTimeout(500);
  assert.match(await page.locator('.screen.in [data-col-detail]').innerText(), /？？？[\s\S]*まだ出会っていません/, 'detail of an unknown horse: no name, no stats, no scout link');
  assert.equal(await page.locator('.screen.in [data-col-detail] .btn').count(), 0, 'nothing to buy from the book');
  const seenCell = page.locator('.screen.in [data-col-cell][data-state="seen"]').first();
  await seenCell.click(); await page.waitForTimeout(500);
  assert.match(await page.locator('.screen.in [data-col-detail]').innerText(), /出会った/, 'a horse met in a race');
  await shot('collection-seen-detail', 400);
  await page.locator('.screen.in [data-tab="courses"]').click(); await page.waitForTimeout(500);
  assert.equal(await page.locator('.screen.in [data-col-cell][data-state="obtained"]').count(), 5, 'the five courses raced');
  await shot('collection-courses', 400);
  await click('実績'); await waitScreen('achievements'); await page.waitForTimeout(400);
  const achText = await page.locator('.screen.in').innerText();
  assert.match(achText, /課金やガチャの回数では達成しません/);
  const claims = page.locator('.screen.in [data-claim]');
  assert.ok((await claims.count()) > 0, 'unlocked tiers can be claimed');
  const achFree0 = Number(await page.locator('.screen.in [data-free]').first().getAttribute('data-free'));
  await shot('achievements', 500);
  await claims.first().click(); await page.waitForTimeout(800); await waitScreen('achievements');
  const achFree1 = Number(await page.locator('.screen.in [data-free]').first().getAttribute('data-free'));
  assert.ok(achFree1 > achFree0 && achFree1 - achFree0 <= 50, 'one tier pays a few free coins');
  await shot('achievement-claimed-toast', 250);
  await click('まとめて受け取る'); await page.waitForTimeout(800); await waitScreen('achievements');
  assert.equal(await page.locator('.screen.in [data-claim]').count(), 0, 'claim-all pays every unlocked tier once');
  assert.equal(await page.locator('.screen.in .btn[data-label="まとめて受け取る"]').count(), 0);
  await click('称号を変える'); await page.waitForTimeout(500);
  await page.locator('.screen.in [data-equip="ach_champion"]').click(); await page.waitForTimeout(800); await waitScreen('achievements');
  assert.equal(await page.locator('.screen.in [data-title-equipped]').getAttribute('data-title-equipped'), 'ach_champion', 'an achievement title is equipped (profile and stable)');
  await shot('achievements-title', 400);

  // ------------------------------------------------------------------ 6. round 12: コイン不足の案内 (T6, REQ-SHORT-*, protocol §29)
  // the paid step-up with free coins only: the pull is not tried, the sheet says how many PAID coins are missing and shows ONE
  // pack (閉じる is the big button) → the normal purchase confirmation (birth month asked first) → a demo purchase → back to
  // the same pull, which now goes through. KPI offer_view / offer_click (shortfall, T6). Then the R8 gap: bought packs in the shop.
  await demo('day3');
  await page.evaluate(() => globalThis.__muchi.show('Scout', 'stepup_paid')); await waitScreen('scout'); await page.waitForTimeout(500);
  const kpi0 = (await page.evaluate(() => globalThis.__muchi.logic.kpiLog())).length;
  await page.locator('.screen.in .btn[data-label^="10回引く"]').first().click();
  await waitScreen('shortfall').catch(async (e) => { await shot('shortfall-FAILED', 0); throw new Error(`no shortfall sheet (screen ${await screen()}, ftue ${await page.evaluate(() => globalThis.__muchi.state().ftue)}, wallet ${JSON.stringify(await page.evaluate(() => globalThis.__muchi.state().player.wallet))}): ${e.message}`); });
  const sheet = page.locator('.screen.in [data-name="Coin shortfall"]');
  assert.equal(await sheet.getAttribute('data-coin-kind'), 'paid', 'the paid step-up counts paid coins only');
  assert.equal(await sheet.getAttribute('data-shortfall'), '500');
  const sheetText = await sheet.innerText();
  assert.match(sheetText, /有償コインが500枚足りません/);
  assert.ok(!/倍|お得|今だけ|残りわずか|通常価格/.test(sheetText), 'shortfall sheet: no multiplier / deal / urgency wording');
  assert.equal(await sheet.locator('[data-product]').count(), 1, 'exactly one pack card');
  assert.equal(await sheet.locator('[data-product="coin_800"]').count(), 1, 'the smallest pack that covers 500 paid coins');
  assert.match(await sheet.locator('[data-bonus]').innerText(), /^はじめての購入時のみ：無償コイン530枚をプレゼント$/, 'the first-purchase line exactly as the shop says it');
  await shot('shortfall-paid', 400);
  await sheet.locator('[data-label="購入を確認"]').click(); await waitScreen('purchase');
  const kpis = await page.evaluate(() => globalThis.__muchi.logic.kpiLog().map((e) => e.name + ':' + e.props.offerId + ':' + e.props.trigger));
  assert.deepEqual(kpis.slice(kpi0), ['offer_view:shortfall:T6', 'offer_click:shortfall:T6'], 'KPI once each');
  if (await page.locator('.screen.in .pstate').getAttribute('data-state') === 'unregistered') {
    const y = new Date().getFullYear();
    await page.selectOption('.screen.in select[aria-label="年"]', String(y - 31)); await page.selectOption('.screen.in select[aria-label="月"]', '1');
    await click('登録して確認する');
  }
  await page.waitForFunction(() => document.querySelector('.screen.in .pstate')?.dataset.state === 'registered');
  await shot('shortfall-purchase-confirm', 400);
  await page.locator('.screen.in [data-demo-buy]').click();
  await waitScreen('scout-reveal', 20000);
  assert.ok((await page.evaluate(() => globalThis.__muchi.reveal?.order?.length)) === 10, 'back to the original pull: the 10-pull ran');
  await shot('shortfall-back-to-pull', 600);
  // free-only payments: the shortfall is said, nothing is sold
  await page.evaluate(() => globalThis.__muchi.show('Shortfall', 'free')); await waitScreen('shortfall');
  assert.equal(await page.locator('.screen.in [data-name="Coin shortfall"] [data-product]').count(), 0, 'free-only: no pack');
  await shot('shortfall-free-only', 300);
  await click('閉じる'); await waitScreen(['home', 'link-prompt']);
  // R8 gap: a bought season pass is 購入済み on the shop's おすすめ (and Pass+ is closed), never a buy button
  await page.evaluate(() => globalThis.__muchi.logic.demoPurchase('season_pass'));
  await page.evaluate(() => globalThis.__muchi.logic.demoPurchase('starter_pack'));
  await page.evaluate(() => globalThis.__muchi.show('Store', 'recommended')); await waitScreen('shop-recommended'); await page.waitForTimeout(400);
  assert.match(await page.locator('.screen.in [data-product="season_pass"]').innerText(), /購入済み/);
  assert.match(await page.locator('.screen.in [data-product="starter_pack"]').innerText(), /購入済み/);
  assert.equal(await page.locator('.screen.in [data-product="starter_pack"] .btn[data-label="購入を確認"]').count(), 0, 'a bought starter pack has no buy button');
  await shot('shop-bought-packs', 400);
  // ------------------------------------------------------------------ 6. round 12: プレゼントボックス (REQ-BOX-*)
  // a compensation, a tournament prize, a grant with no expiry and one expiring in 3 days arrive through the real routes;
  // one gift was received earlier and one expired (history)
  await page.evaluate(() => globalThis.__muchi.demo('gifts')); await waitScreen('gift-box', 60000); await page.waitForTimeout(400);
  const gbText = await page.locator('.screen.in').innerText();
  assert.match(gbText, /メンテナンスのお詫び/, 'the compensation title');
  assert.match(gbText, /大会の賞品/, 'the tournament prize');
  assert.match(gbText, /有償コインはプレゼントボックスに入りません/, 'paid coins never go into the box');
  assert.ok(!/今だけ|残りわずか|倍|お得/.test(gbText), 'no urgency or multiplier wording in the box');
  assert.equal(await page.locator('.screen.in [data-gift]').count(), 4, 'four gifts waiting');
  assert.equal(await page.locator('.screen.in [data-expiry]').count(), 3, 'an expiry text only where the gift really expires (not on the no-expiry grant)');
  assert.equal(await page.locator('.screen.in [data-gift]').first().locator('[data-expiry]').getAttribute('data-expiry'), '3', 'the soonest first: 「あと3日」');
  await shot('gift-box', 400);
  await click('ホームへ'); await waitScreen(['home', 'link-prompt'], 20000);
  if (await screen() === 'link-prompt') { await click('あとで'); await waitScreen('home', 10000); }
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.screen.in .btn.envelope').getAttribute('data-badge'), '4', 'the home envelope shows 4');
  await shot('home-envelope', 300);
  await click('プレゼント'); await waitScreen('gift-box'); await page.waitForTimeout(300);
  const gFree0 = Number(await page.locator('.screen.in [data-free]').first().getAttribute('data-free'));
  await page.locator('.screen.in [data-gift-claim]').first().click(); await waitScreen('gift-result'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.screen.in [data-gift-claimed]').getAttribute('data-gift-claimed'), '1');
  await shot('gift-result-one', 300);
  await click('つづける'); await waitScreen('gift-box'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.screen.in [data-gift]').count(), 3);
  await click('まとめて受け取る'); await waitScreen('gift-result'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.screen.in [data-gift-claimed]').getAttribute('data-gift-claimed'), '3', 'claim all receives the rest');
  await shot('gift-result-all', 300);
  await click('つづける'); await waitScreen('gift-box'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.screen.in [data-gift-empty]').count(), 1, 'the box is empty');
  assert.equal(await page.locator('.screen.in .btn[data-label="まとめて受け取る"]').count(), 0);
  const gFree1 = Number(await page.locator('.screen.in [data-free]').first().getAttribute('data-free'));
  assert.equal(gFree1 - gFree0, 300 + 150 + 50, 'free coins of the four gifts (300 + 150 + 50; the ticket is an item)');
  await page.locator('.screen.in [data-tab="history"]').click(); await waitScreen('gift-history'); await page.waitForTimeout(300);
  assert.ok((await page.locator('.screen.in [data-gift][data-status="expired"]').count()) === 1, 'the expired gift is in the history');
  assert.ok((await page.locator('.screen.in [data-gift][data-status="claimed"]').count()) >= 5, 'received gifts are in the history');
  await shot('gift-history', 300);
  // ------------------------------------------------------------------ 6. round 12: かんたん操作 (REQ-ASSIST-*)
  // a week of play, then three last places settled by the real applyRace → the one-time suggestion (calm: 「今はいい」 as big
  // as the rest) → ぜんぶおまかせ → the settings row and the options screen → a ranked race the real InputAssistant rides with
  // no tap at all (HUD chip 「かんたん操作 ON」), and the suggestion never comes back
  await page.evaluate(() => globalThis.__muchi.demo('assist')); await waitScreen('assist-prompt', 60000); await page.waitForTimeout(400);
  const promptText = await page.locator('.screen.in').innerText();
  assert.match(promptText, /かんたん操作を試してみませんか？/);
  assert.match(promptText, /いつでも設定で戻せます/);
  assert.match(promptText, /相手には表示されません/, 'the sheet states the fairness rule');
  assert.ok(!/倍|今だけ|残りわずか|お得/.test(promptText), 'no pressure words on the suggestion');
  const sizes = await page.locator('.screen.in [data-assist-choice]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  assert.equal(sizes.length, 3); assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, '「今はいい」 is as big as the choices');
  assert.equal((await page.evaluate(() => globalThis.__muchi.logic.assist())).promptShown, true, 'shown once (prompt-seen on the real rules)');
  await shot('assist-prompt', 300);
  await page.locator('.screen.in [data-assist-choice="full"]').click(); await waitScreen(['home', 'link-prompt'], 10000); await page.waitForTimeout(400);
  if (await screen() === 'link-prompt') { await click('あとで'); await waitScreen('home', 10000); }
  assert.equal((await page.evaluate(() => globalThis.__muchi.logic.assist())).level, 'full');
  await page.evaluate(() => globalThis.__muchi.show('Settings')); await waitScreen('settings'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.screen.in [data-assist-level]').getAttribute('data-assist-level'), 'full');
  await shot('settings-assist', 300);
  await page.locator('.screen.in [data-action="assist"]').click(); await waitScreen('assist-settings'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.screen.in [data-assist-option]').count(), 3, 'three levels');
  assert.equal(await page.locator('.screen.in .as-opt.on').getAttribute('data-assist-option'), 'full');
  await shot('assist-settings', 300);
  await page.locator('.screen.in [data-assist-option="whip"] [data-label="これにする"]').click(); await page.waitForTimeout(700); await waitScreen('assist-settings');
  assert.equal(await page.locator('.screen.in .as-opt.on').getAttribute('data-assist-option'), 'whip');
  await page.locator('.screen.in [data-assist-option="full"] [data-label="これにする"]').click(); await page.waitForTimeout(700); await waitScreen('assist-settings');
  // the race: nothing is tapped — the assistant starts, reins, steers and whips through the normal input path
  await page.evaluate(() => globalThis.__muchi.show('Home')); await waitScreen(['home', 'link-prompt'], 10000);
  if (await screen() === 'link-prompt') { await click('あとで'); await waitScreen('home', 10000); }
  await click('レースへ'); await waitScreen('lobby'); await click('ランク戦に出る'); await waitScreen('race', 20000);
  let assistShot = false, lastAf = null;
  for (let i = 0; i < 6000; i++) {
    const af = await page.evaluate(() => { const f = globalThis.__muchi.state().lastFrame; return f && { done: f.done, departed: f.departed, remainingM: f.remainingM, distanceM: f.distanceM, whips: f.whips, maxWhips: f.maxWhips, assist: f.assist, label: f.assistLabel, cmds: f.assistCmds }; });
    if ((await screen()) !== 'race') break;
    if (af) lastAf = af;
    if (af?.done) break;
    if (!assistShot && af?.departed && af.remainingM < af.distanceM * .5) {
      assistShot = true;
      assert.equal(af.assist, 'full'); assert.equal(af.label, 'かんたん操作 ON');
      assert.equal(await page.locator('.screen.in .chip.assist').isVisible(), true, 'the HUD chip is on');
      assert.equal(await page.locator('.screen.in .chip.assist').textContent(), 'かんたん操作 ON');
      await shot('race-assist-hud', 0, true);
    }
    await page.waitForTimeout(50);
  }
  assert.ok(assistShot, 'the assisted race was captured');
  assert.ok(lastAf.cmds >= 3, 'the assistant sent inputs (start, rein, whips): ' + lastAf.cmds);
  assert.ok(lastAf.whips < lastAf.maxWhips, 'the assistant whipped in the last stretch');
  await waitScreen(['result'], 40000); await shot('race-result-assisted', 900);
  assert.equal((await page.evaluate(() => globalThis.__muchi.logic.assist())).promptDue, false, 'the suggestion never comes back');
  await page.evaluate(() => globalThis.__muchi.logic.setAssist('off'));
  // ------------------------------------------------------------------ 6. round 13: 購入・コイン・ガチャ履歴 (REQ-HIST-*)
  // a 14-year-old's month on the real rules (two packs, one refunded by the store, scouts): settings → the history, each
  // tab, paging by the server's cursor, the detail of a row, and the 問い合わせ sheet that sends reference numbers only
  await page.evaluate(() => globalThis.__muchi.demo('history')); await waitScreen('history', 60000); await page.waitForTimeout(400);
  await page.evaluate(() => globalThis.__muchi.show('Settings')); await waitScreen('settings');
  await page.locator('.screen.in [data-action="history"]').click(); await waitScreen('history'); await page.waitForTimeout(400);
  const hiText = await page.locator('.screen.in').innerText();
  assert.match(hiText, /有償コイン[\s\S]*無償コイン/, 'history: the header keeps paid and free coins apart');
  assert.match(hiText, /今月の購入 ¥[\d,]+ ／ 上限 ¥5,000/, 'history: this month against the age limit');
  assert.match(hiText, /返金済み/, 'history: the refunded pack');
  assert.ok(!/proto_h_|fake:|coin_480|support grant/.test(hiText), 'history: no internal id or raw reason on screen');
  const bal = page.locator('.screen.in .hi-balance');
  const pst = await page.evaluate(() => globalThis.__muchi.state().player.wallet);
  assert.equal(Number(await bal.getAttribute('data-paid')), pst.paid); assert.equal(Number(await bal.getAttribute('data-free')), pst.free);
  await shot('history-purchases', 400);
  await page.locator('.screen.in [data-tab="coins_paid"]').click(); await page.waitForTimeout(500);
  assert.match(await page.locator('.screen.in .hi-list').innerText(), /スカウト10回/, 'paid coins: the scout');
  await shot('history-coins-paid', 300);
  if ((await page.locator('.screen.in [data-more="1"]').count()) > 0) {
    const first = await page.locator('.screen.in .hi-row').first().getAttribute('data-ref');
    await click('次へ'); await page.waitForTimeout(400);
    assert.notEqual(await page.locator('.screen.in .hi-row').first().getAttribute('data-ref'), first, 'next page: older rows');
    await click('前へ'); await page.waitForTimeout(400);
    assert.equal(await page.locator('.screen.in .hi-row').first().getAttribute('data-ref'), first, 'back to the first page');
  }
  await page.locator('.screen.in [data-tab="coins_free"]').click(); await page.waitForTimeout(500);
  await shot('history-coins-free', 300);
  await page.locator('.screen.in [data-tab="gacha"]').click(); await page.waitForTimeout(500);
  await page.locator('.screen.in .hi-row').first().click(); await page.waitForTimeout(400);
  assert.match(await page.locator('.screen.in .hi-balance').innerText(), /問い合わせ番号\s+G-\d+/, 'gacha detail: the reference number');
  await shot('history-gacha', 300);
  await page.locator('.screen.in .hi-pick').first().click(); await page.waitForTimeout(400);
  await page.locator('.screen.in [data-action="history-contact"]').click(); await page.waitForTimeout(500);
  assert.match(await page.locator('.screen.in .hi-contact').innerText(), /問い合わせ番号だけを送ります/, 'the sheet says only reference numbers are sent');
  await page.locator('.screen.in .hi-contact [data-topic="gacha"]').click(); await page.waitForTimeout(500);
  await page.locator('.screen.in [data-action="history-ticket"]').click(); await page.waitForTimeout(600);
  assert.equal(await page.locator('.screen.in .hi-ticket').getAttribute('data-ticket'), 'muchi.support-ticket.v1', 'the draft came back from the server');
  assert.match(await page.locator('.screen.in .hi-ticket').innerText(), /問い合わせ番号：G-\d+/);
  await shot('history-contact', 300);
  assert.deepEqual(await page.evaluate(() => (globalThis.__muchiKpi ?? []).map((e) => e.tab)), ['purchases', 'coins_paid', 'coins_free', 'gacha'], 'history_view once per tab');

  // ------------------------------------------------------------------ 7. round 14: 実況パック (REQ-CMT-*)
  // a week of play (21 races: the 「出走の記録」 pack is owned) → the list (owned / price / achievement), the 10-second sample
  // of a pack not owned (text ticker on the real CommentarySample), equip the achievement pack, the calm purchase confirm
  // (buy and cancel the same size), buy + equip, then a ranked race whose commentary speaks the bought pack
  await page.evaluate(() => globalThis.__muchi.demo('packs')); await waitScreen(['commentary-packs', 'link-prompt'], 60000);
  if (await screen() === 'link-prompt') { await click('あとで'); await page.evaluate(() => globalThis.__muchi.show('CommentaryPacks')); await waitScreen('commentary-packs'); }
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.screen.in .cp-card').count(), 4, 'four packs');
  assert.equal(await page.locator('.screen.in .cp-card[data-pack="nekketsu"]').getAttribute('data-owned'), 'true', 'the achievement pack is owned after 10 races');
  assert.equal(await page.locator('.screen.in .cp-card[data-pack="ochitsuki"] [data-pack-status]').getAttribute('data-pack-status'), 'price');
  const packText = await page.locator('.screen.in').innerText();
  assert.ok(!/倍|今だけ|残りわずか|お得|馬券|オッズ/.test(packText), 'no pressure or betting words on the pack screen');
  assert.match(packText, /レースの結果・能力には影響しません/);
  await shot('commentary-packs', 300);
  await page.locator('.screen.in [data-sample="kofuu"]').click(); await page.waitForTimeout(600);
  assert.equal(await page.locator('.screen.in [data-ticker]').getAttribute('data-pack-id'), 'kofuu', 'the sample of a pack not owned plays');
  await page.waitForFunction(() => (document.querySelector('.screen.in [data-ticker]')?.textContent ?? '').length > 2, null, { timeout: 5000 });
  await shot('commentary-pack-sample', 900);
  await page.waitForSelector('.screen.in [data-ticker][data-done="1"]', { timeout: 15000 });
  const sample = await page.evaluate(() => globalThis.__muchi.lastSample);
  assert.ok(sample.lines.length >= 3 && sample.totalTicks <= 200 && sample.lines.some((l) => l.variant.startsWith('kofuu_')), 'the sample is ≤ 10 s of the pack\'s own lines');
  await page.locator('.screen.in [data-equip="nekketsu"]').click(); await page.waitForTimeout(700); await waitScreen('commentary-packs');
  assert.equal(await page.locator('.screen.in [data-equipped]').getAttribute('data-equipped'), 'nekketsu', 'the achievement pack is equipped');
  await page.locator('.screen.in [data-buy="kofuu"]').click(); await waitScreen(['commentary-pack-buy', 'shortfall'], 10000); await page.waitForTimeout(400);
  assert.equal(await screen(), 'commentary-pack-buy', 'the day-7 player has the coins for a 300-coin pack');
  const buyText = await page.locator('.screen.in').innerText();
  assert.match(buyText, /古風な名調子を購入しますか？/); assert.match(buyText, /300コインを使います。有償コインから先に使われます。/);
  assert.ok(!/倍|今だけ|残りわずか|お得/.test(buyText), 'no pressure words on the confirm');
  const hs = await page.locator('.screen.in [data-confirm]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  assert.equal(hs.length, 2); assert.ok(Math.abs(hs[0] - hs[1]) <= 1, 'buy and cancel are the same size');
  await shot('commentary-pack-buy', 300);
  const cpW0 = await page.evaluate(() => globalThis.__muchi.state().player.wallet);
  await page.locator('.screen.in [data-confirm="buy"]').click(); await waitScreen('commentary-packs', 10000); await page.waitForTimeout(500);
  const cpW1 = await page.evaluate(() => globalThis.__muchi.state().player.wallet);
  assert.equal(cpW0.paid + cpW0.free - cpW1.paid - cpW1.free, 300, '300 coins spent (paid first)');
  assert.equal(await page.locator('.screen.in [data-equipped]').getAttribute('data-equipped'), 'kofuu', 'bought and equipped');
  await shot('commentary-packs-bought', 300);
  await page.evaluate(() => globalThis.__muchi.logic.setAssist('full')); // nobody taps: the assistant rides, the pack calls it
  await page.evaluate(() => globalThis.__muchi.show('Home')); await waitScreen(['home', 'link-prompt'], 10000);
  if (await screen() === 'link-prompt') { await click('あとで'); await waitScreen('home', 10000); }
  await click('レースへ'); await waitScreen('lobby'); await click('ランク戦に出る'); await waitScreen('race', 20000);
  assert.equal(await page.locator('.screen.in [data-commentary-pack]').getAttribute('data-commentary-pack'), 'kofuu', 'the HUD says which pack calls the race');
  const subs = new Set(); let packShot = false;
  for (let i = 0; i < 6000; i++) {
    const f = await page.evaluate(() => { const x = globalThis.__muchi.state().lastFrame; return x && { done: x.done, subtitle: x.subtitle, departed: x.departed }; });
    if ((await screen()) !== 'race') break;
    if (f?.subtitle) subs.add(f.subtitle);
    if (!packShot && f?.departed && f.subtitle && /であります|いざ発走|ゲートは開かれた|ハナを奪うは/.test(f.subtitle)) { packShot = true; await shot('race-commentary-pack', 0, true); }
    if (f?.done) break;
    await page.waitForTimeout(50);
  }
  assert.ok([...subs].some((t) => /であります|いざ発走|ゲートは開かれた|ハナを奪うは|鞭|名調子/.test(t)), 'the race commentary speaks the equipped pack: ' + [...subs].slice(0, 4).join(' | '));
  await waitScreen(['result'], 60000); await page.waitForTimeout(600);
  await page.evaluate(() => globalThis.__muchi.logic.equipCommentaryPack('standard'));
  await page.evaluate(() => globalThis.__muchi.logic.setAssist('off'));

  // a reload on a named player goes straight home
  await demo('day3');
  await page.goto(url); await ready(); await waitScreen('home'); await shot('home-reload', 500);
  await ctx.close();
  // the §2.3 targets (checked last so every screenshot is written even when a target is missed)
  assert.ok(ms('aha①') <= TARGET.ahaMs, `aha ${ms('aha①')} ms > ${TARGET.ahaMs}`);
  assert.ok(ms('aha②') <= TARGET.gachaMs, `first gacha ${ms('aha②')} ms > ${TARGET.gachaMs}`);
  assert.ok(ms('ホーム') <= TARGET.homeMs, `home ${ms('ホーム')} ms > ${TARGET.homeMs}`);
  assert.ok(ftue.taps <= TARGET.taps, `taps to home ${ftue.taps} > ${TARGET.taps}`);
  return { shots, ftue };
};
