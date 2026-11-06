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
  // ------------------------------------------------------------------ 4. round 10: 友達招待 (REQ-INV-*)
  // my code + share, demo friends redeeming it (real InviteService), milestone rewards via the outbox, entering a code
  await demo('day1');
  await page.evaluate(() => globalThis.__muchi.show('Settings')); await waitScreen('settings');
  await page.locator('.screen.in [data-action="invite"]').click(); await waitScreen('invite'); await page.waitForTimeout(400);
  const myCode = await page.locator('.screen.in [data-code]').getAttribute('data-code');
  assert.match(myCode, /^[23456789BCDFGHJKMNPQRSTVWXZ]{8}$/, 'my invite code');
  assert.equal(await page.locator('.screen.in [data-cap]').getAttribute('data-cap'), '0/10');
  assert.equal(await page.locator('.screen.in [data-milestone]').count(), 2, 'milestone table');
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
