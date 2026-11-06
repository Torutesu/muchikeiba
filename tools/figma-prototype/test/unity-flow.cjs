// Unity UI walkthrough (site/unity.html) for the round 8 experience (docs/planning/06, REQ-UXP-001..005).
//  1. FTUE as a new player on a landscape phone (844×390), driven like a person would: one tap per step, the whip only
//     when the button lights up. Measures the time and the taps to each milestone and checks the §2.3 targets:
//     aha (the tutorial win) ≤ 30 s, first gacha reveal ≤ 1:40, home ≤ 4:00 and ≤ 15 taps (text entry excluded).
//  2. Every new screen and state: home on day 1 / 3 / 7, shop tabs, the purchase confirmation in its four states
//     (unregistered, registered, under 18, over the monthly limit), the starter offer, the deletion-pending block,
//     the season pass (free / paid / plus lines), settings and the legacy screens.
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
  const url = base + 'unity.html';
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

  // a full race as a player rides it: START on the gate, two spaced whips in the final straight; HUD shots when asked
  async function rideRace(withShots) {
    let started = false, w2 = 0, lastW = 0, wall = Date.now(), last = null;
    const raceShots = new Set();
    for (let i = 0; i < 4000; i++) {
      const s = await state();
      if (!s.f) { await page.waitForTimeout(50); continue; }
      last = s.f;
      if (s.f.done || (await screen()) !== 'race') break;
      if (!started && s.f.gateOpen && !s.f.departed) { await tapWhip(); started = true; }
      if (withShots && !raceShots.has('gate')) { raceShots.add('gate'); await shot('race-hud-gate', 0, true); }
      if (withShots && !raceShots.has('mid') && s.f.remainingM < s.f.distanceM * .55) { raceShots.add('mid'); await shot('race-hud-mid', 0, true); }
      if (withShots && !raceShots.has('cutin') && await page.locator('.screen.in .cutin').count() > 0) { raceShots.add('cutin'); await shot('race-hud-skill-cutin', 0, true); }
      if (s.f.departed && w2 < 2 && s.f.remainingM <= (w2 === 0 ? 380 : 220) && s.f.whips > 0 && Date.now() - lastW > 1500) {
        await tapWhip(); w2++; lastW = Date.now();
        if (withShots && w2 === 1) await shot('race-hud-straight-whip', 120, true);
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

  // ------------------------------------------------------------------ 2. other screens and states
  const demo = async (k) => { await page.evaluate((x) => globalThis.__muchi.demo(x), k); await waitScreen('home', 20000); await page.waitForTimeout(500); };
  await demo('day3');
  await shot('home-day3', 600);
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

  // a reload on a named player goes straight home
  await page.evaluate(() => globalThis.__muchi.demo('day3')); await waitScreen('home', 20000);
  await page.goto(url); await ready(); await waitScreen('home'); await shot('home-reload', 500);
  await ctx.close();
  // the §2.3 targets (checked last so every screenshot is written even when a target is missed)
  assert.ok(ms('aha①') <= TARGET.ahaMs, `aha ${ms('aha①')} ms > ${TARGET.ahaMs}`);
  assert.ok(ms('aha②') <= TARGET.gachaMs, `first gacha ${ms('aha②')} ms > ${TARGET.gachaMs}`);
  assert.ok(ms('ホーム') <= TARGET.homeMs, `home ${ms('ホーム')} ms > ${TARGET.homeMs}`);
  assert.ok(ftue.taps <= TARGET.taps, `taps to home ${ftue.taps} > ${TARGET.taps}`);
  return { shots, ftue };
};
