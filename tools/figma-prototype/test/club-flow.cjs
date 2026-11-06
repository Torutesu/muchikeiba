// Club UI walkthrough (site/index.html, Codex's 25 detailed screens wired to the real logic and engine).
// Captures every screen with the same element and state as Codex's frontend/scripts/export-design.cjs, so the
// shots line up 1:1 with frontend/design/screens/<name>.png for compare.py. Used by e2e.cjs.
const path = require('path');
const assert = require('assert/strict');

module.exports = async function clubFlow(browser, base, out, errors) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
  page.on('pageerror', (e) => errors.push('club pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('club console: ' + m.text()); });
  const shots = [];
  const settle = () => page.waitForTimeout(350);
  async function capture(name, selector = '.app-frame') {
    await settle();
    await page.locator('.toast').evaluateAll((els) => els.forEach((el) => el.remove()));
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    const file = path.join(out, `club-${name}.png`);
    await target.screenshot({ path: file });
    shots.push(file);
  }
  const ready = () => page.waitForFunction(() => globalThis.__club?.ready === true, null, { timeout: 90000 });
  const screen = async (n) => { await page.selectOption('#screen-select', String(n)); await settle(); };
  const close = async () => { await page.locator('dialog .close').click(); await page.locator('dialog').waitFor({ state: 'detached' }); };
  const state = () => page.evaluate(() => { const s = globalThis.__club.state(); return { current: s.current, active: s.raceActive, f: s.frame && { departed: s.frame.departed, remainingM: s.frame.remainingM, whips: s.frame.whips, done: s.frame.done, rank: s.frame.rank } }; });
  const frameJson = () => page.evaluate(() => JSON.stringify(globalThis.__club.state().frame));
  // QA r7: coming back to a race screen via the hash (Back) must start a live race, not show a frozen one
  async function reenterRace(n, away) {
    await page.evaluate((x) => { location.hash = String(x); }, n);
    await page.waitForFunction((x) => { const s = globalThis.__club.state(); return s.current === x && s.raceActive && s.frame && !s.frame.done; }, n, { timeout: 30000 });
    const a = await frameJson(); await page.waitForTimeout(1200);
    assert.notEqual(await frameJson(), a, `race screen ${n} re-entered via the hash is running`);
    await page.evaluate((x) => { location.hash = String(x); }, away);
    await page.waitForFunction((x) => globalThis.__club.state().current === x && !globalThis.__club.state().raceActive, away);
  }
  async function ride(name, leaveScreen) { // real engine race: start, spur in the straight, wait for the result screen
    let mid = false;
    for (let i = 0; i < 600; i++) {
      const s = await state();
      if (s.current === leaveScreen) break;
      const f = s.f;
      if (f && !f.done && (!f.departed || (f.remainingM < 420 && f.whips > 0 && i % 3 === 0))) await page.locator('#whip').click().catch(() => {});
      if (!mid && f && f.departed && f.remainingM < 300 && name) { mid = true; await capture(name); }
      await page.waitForTimeout(250);
    }
    await page.waitForFunction((n) => globalThis.__club.state().current === n, leaveScreen, { timeout: 120000 });
  }

  await page.goto(base + 'index.html?speed=4'); await page.evaluate(() => localStorage.clear()); await page.goto(base + 'index.html?speed=4'); await ready();
  // 01 はじめに → 02 初めての直線 (tutorial race, real engine) → 03 相棒の命名
  await capture('01');
  assert(await page.locator('[data-go="1"]').isDisabled(), 'start needs consent');
  await page.locator('#consent').check(); await page.locator('[data-go="1"]').click();
  await page.waitForFunction(() => globalThis.__club.state().frame?.departed === false || globalThis.__club.state().frame?.departed === true);
  await ride('02', 2);
  await reenterRace(1, 2); // Back from naming into the tutorial
  // 22 name error (format, real rule) → NG word (server NG list) → valid name
  await page.locator('#horse-name').fill('a'); await capture('22-name-error');
  assert(await page.locator('#save-name').isDisabled());
  // QA r7: a failed first scout (which brings the partner) leaves the naming button usable for a retry
  await page.evaluate(() => { const L = globalThis.MuchiLogic; L.__draw = L.tutorialDraw; L.tutorialDraw = async () => ({ ok: false, code: 'INTERNAL', message: 'scout failed (test)' }); });
  await page.locator('#horse-name').fill('ハルカゼ'); await page.locator('#save-name').click();
  await page.waitForFunction(() => document.querySelector('#name-help')?.textContent.includes('scout failed (test)'));
  assert(await page.locator('#save-name').isEnabled(), 'naming button re-enabled after a first-scout failure');
  await page.evaluate(() => { const L = globalThis.MuchiLogic; L.tutorialDraw = L.__draw; delete L.__draw; });
  await page.locator('#horse-name').fill('だーびーおう'); await page.locator('#save-name').click(); // hiragana → katakana, then the NG list
  await page.waitForFunction(() => document.querySelector('#name-help').textContent.includes('使用できません'));
  await capture('22b-name-ng');
  await page.locator('#horse-name').fill('ハルカゼ'); await capture('03');
  await page.locator('#save-name').click();
  await page.waitForFunction(() => globalThis.__club.state().current === 3);
  // 04 無料スカウト → 17 結果 (the real tutorial draw) → home; 18 提供内容 (real odds)
  await capture('04');
  await page.locator('#scout').click(); await page.locator('.pull-card').first().waitFor();
  assert.equal(await page.locator('.pull-card').count(), 10);
  await capture('17-scout-results', 'dialog');
  await page.locator('#finish-scout').click(); await page.locator('dialog').waitFor({ state: 'detached' });
  await screen(3); assert(await page.locator('#scout').isDisabled(), 'free scout is used once');
  await page.locator('#rates').click(); await capture('18-scout-info', 'dialog'); await close();
  // 05 ホーム → 21 ログインボーナス受取後 (real login bonus)
  await screen(4); await capture('05');
  const before = await page.locator('.wallet b').first().innerText();
  await page.locator('#claim-login').click(); await page.waitForFunction(() => document.querySelector('#claim-login')?.disabled === true);
  assert.notEqual(await page.locator('.wallet b').first().innerText(), before, 'login bonus adds free coins');
  await capture('21-home-claimed');
  // 06 厩舎 → 11/12 馬詳細 → 13 検索結果なし → 14 配合（開放条件）
  await screen(5); await capture('06');
  await page.locator('[data-detail]').first().click(); await capture('11-horse-stats', 'dialog');
  await page.locator('[data-tab="skill"]').click(); await capture('12-horse-skill', 'dialog'); await close();
  await page.locator('#horse-search').fill('該当なし'); await capture('13-stable-empty'); await page.locator('#clear-filter').click();
  await page.locator('#breed-tab').click(); await capture('14-breeding', 'dialog'); await close();
  // 07 出走登録 → 15 出走確認 → 16 フレンドルーム（部屋の条件はサーバーと同じ検証）
  await screen(6); await capture('07');
  await page.locator('.rank-card [data-go="7"]').click(); await capture('15-race-ready', 'dialog'); await page.locator('#match-cancel').click(); await page.locator('dialog').waitFor({ state: 'detached' });
  await page.locator('#friend').click(); await capture('16-friend-room', 'dialog');
  await page.locator('#room-code').fill('123456'); assert(await page.locator('#join-room').isEnabled());
  await page.locator('.room-conditions summary').click(); await page.selectOption('#room-track', 'aoba_dirt_1400'); await page.selectOption('#room-going', 'soft');
  await page.locator('#save-room').click(); await page.waitForFunction(() => document.querySelector('#room-error').classList.contains('field-error'));
  await page.selectOption('#room-going', 'muddy'); await page.locator('#save-room').click();
  await page.waitForFunction(() => document.querySelector('#room-error').textContent.includes('保存しました'));
  await capture('16b-friend-room-conditions', 'dialog'); await close();
  // 08 レース (2000m, 12 runners, real engine) → 09 リザルト → reward settled by the real tables
  const wallet = () => page.evaluate(() => { const p = globalThis.__club.state().player; return { free: p.wallet.free, points: p.season?.points ?? 0 }; });
  const coinsBefore = await wallet();
  await page.locator('.rank-card [data-go="7"]').click(); await page.locator('#match-start').click();
  await page.waitForFunction(() => globalThis.__club.state().current === 7);
  await page.locator('#lane-out').click();
  await ride('08', 8);
  // QA r7: the reward is applied when the race settles, without pressing anything; the button only shows it
  await page.waitForFunction(() => globalThis.__club.state().lastRace?.claimed === true && document.querySelector('#claim-race')?.disabled === true);
  await capture('09');
  const first = await page.evaluate(() => globalThis.__club.state().lastRace);
  const afterFirst = await wallet();
  assert.equal(afterFirst.free - coinsBefore.free, first.coins, 'race reward (free coins) applied at settle');
  assert.equal(afterFirst.points - coinsBefore.points, first.seasonPoints, 'season points applied at settle');
  await page.locator('#claim-race').click({ force: true }).catch(() => {}); await page.waitForTimeout(300);
  assert.equal((await wallet()).free, afterFirst.free, 'the result button never pays twice');
  await capture('09b-result-claimed');
  // a race left mid-way and re-entered via the hash restarts live; the next finished race pays on top of the first
  await reenterRace(7, 4);
  await page.evaluate(() => { location.hash = '7'; });
  await ride(null, 8);
  await page.waitForFunction((id) => { const r = globalThis.__club.state().lastRace; return r && r.raceId !== id && r.claimed === true; }, first.raceId);
  const second = await page.evaluate(() => globalThis.__club.state().lastRace);
  assert.equal((await wallet()).free - afterFirst.free, second.coins, 'a second race adds its own reward (the first is not lost)');
  // 10 ショップ → 19 購入確認 → 20 確認完了 (age rules; no billing)
  await screen(9); await capture('10');
  await page.locator('.coin-card').first().click(); await capture('19-purchase-review', 'dialog');
  await page.locator('#birth-detail').fill('2000-01'); await page.locator('#purchase-consent').check();
  await page.locator('#purchase-review').click(); await page.locator('.confirmation-mark').waitFor();
  await capture('20-purchase-complete', 'dialog'); await close();
  // breeding with the real preview/breed: retire a stallion and a mare, then breed
  await screen(5);
  const pair = await page.evaluate(() => { const h = globalThis.__club.state().player.horses.filter((x) => x.status === 'active'); return [h.find((x) => x.sex === 'male' && !x.named)?.id, h.find((x) => x.sex === 'female' && !x.named)?.id]; });
  for (const id of pair) { if (!id) continue; await page.locator(`[data-detail="${id}"]`).click(); await page.locator('#detail-retire').click(); await page.locator('dialog').waitFor({ state: 'detached' }); }
  if (pair[0] && pair[1]) {
    await page.locator('#breed-tab').click(); await page.locator('#breed-preview .spec-list').waitFor();
    await capture('14b-breeding-preview', 'dialog');
    await page.locator('#breed-run').click(); await page.locator('.confirmation-mark').waitFor();
    await capture('14c-breeding-foal', 'dialog'); await close();
  }
  // 23–25 mobile layouts: Codex's 390px frame (viewport), then the toolbar toggle at desktop size
  await page.setViewportSize({ width: 390, height: 1000 });
  for (const [n, name] of [[4, '23-mobile-home'], [5, '24-mobile-stable']]) { await screen(n); await capture(name); }
  await screen(6); await page.locator('.rank-card [data-go="7"]').click(); await page.locator('#match-start').click();
  await page.waitForFunction(() => globalThis.__club.state().frame?.departed === true || globalThis.__club.state().frame?.gateOpen === true, null, { timeout: 30000 });
  await page.waitForTimeout(1500); await capture('25-mobile-race');
  assert(await page.evaluate(() => document.documentElement.classList.contains('layout-mobile')), 'portrait window picks the mobile layout');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.selectOption('#layout-select', 'mobile'); await screen(4); await capture('23b-mobile-toggle-desktop-window');
  assert(await page.evaluate(() => document.documentElement.classList.contains('layout-mobile')));
  await page.selectOption('#layout-select', 'auto'); await screen(4);
  assert(!(await page.evaluate(() => document.documentElement.classList.contains('layout-mobile'))), 'landscape window goes back to desktop');
  // no horizontal overflow at Codex's three widths
  for (const width of [1440, 844, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const n of [0, 2, 3, 4, 5, 6, 8, 9]) { await screen(n); assert(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `overflow ${width} screen ${n}`); }
  }
  // 13 empty stable when nobody is in the stable yet (fresh player)
  await page.evaluate(() => localStorage.clear()); await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(base + 'index.html#5'); await ready(); await capture('13b-stable-empty-new-player');
  await page.close();
  return shots;
};
