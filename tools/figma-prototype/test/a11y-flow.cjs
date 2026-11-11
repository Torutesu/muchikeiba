// Round 15 (REQ-A11Y-001..016, contracts/protocol.md §41): the アクセシビリティ settings on the landscape phone (844×390 @2x).
//  1) その他 → アクセシビリティ: each choice applies to the whole prototype at once (html data-*, the --a11y-* colour
//     tokens, text size) and is saved on the real server rules (rev, one a11y_setting_change per change);
//  2) the overflow check at the largest text size (REQ-A11Y-005): key screens in Japanese, then the same in English —
//     nothing wider / taller than its box, below its panel or off the stage after fitText, and most body text really
//     larger (texts brought back to their standard size to fit are counted, Japanese is never below standard);
//  3) a race with reduce motion, haptics off, the one-handed (right) layout and the whip hold: no speed lines, no
//     vibration, the controls on one side, the 「長押し あと{n}」 hint, the hold's whips through the engine;
//  4) the scout reveal with reduce motion: the face at once, the same plan (every result, the same order).
// Screenshots: <out>/a11y-<nn>-<name>.png. Returns { shots, report }.
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');

module.exports = async function a11yFlow(browser, base, out, errors) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  // count vibrations (haptics off must send none)
  await ctx.addInitScript(() => { globalThis.__vibrations = 0; try { Object.defineProperty(navigator, 'vibrate', { value: () => { globalThis.__vibrations++; return true; }, configurable: true }); } catch { /* */ } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('a11y pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('a11y console: ' + m.text()); });
  for (const f of fs.readdirSync(out)) if (/^a11y-\d+-.*\.png$/.test(f)) fs.unlinkSync(path.join(out, f));
  const shots = [], report = [];
  let n = 0;
  const screen = () => page.evaluate(() => globalThis.__muchi?.screen ?? '');
  const waitScreen = (name, timeout = 30000) => page.waitForFunction((x) => { const s = globalThis.__muchi?.screen ?? ''; return Array.isArray(x) ? x.includes(s) : s === x; }, name, { timeout, polling: 50 });
  const show = async (fn, ...a) => { await page.evaluate(([f, args]) => globalThis.__muchi.show(f, ...args), [fn, a]); await page.waitForTimeout(500); };
  const choose = async (row, value) => { await page.locator(`.screen.in [data-a11y-row="${row}"] [data-a11y-choice="${value}"]`).click(); await page.waitForTimeout(500); await waitScreen('a11y-settings'); };
  const a11y = () => page.evaluate(() => globalThis.__muchi.a11y.get());

  /** Overflow (as en-flow) + Japanese left (English only) + how much body text grew, after the screen settled. */
  async function audit(name, english) {
    await page.evaluate(() => globalThis.__muchi.l10n.fit());
    await page.waitForTimeout(150);
    const r = await page.evaluate((en) => {
      const JP = /[぀-ヿ㐀-鿿]/;
      const stage = document.getElementById('stage').getBoundingClientRect();
      const scale = stage.width / 1600;
      const root = document.querySelector('.screen.in');
      const japanese = [];
      if (en) {
        const walk = (n) => {
          if (n.nodeType === 3) { const el = n.parentElement; if (JP.test(n.nodeValue) && !el.closest('.keep-ja') && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden') japanese.push(n.nodeValue.trim().slice(0, 60)); }
          else if (n.nodeType === 1 && !n.classList.contains('keep-ja')) n.childNodes.forEach(walk);
        };
        walk(root);
      }
      const overflow = [];
      for (const e of root.querySelectorAll('.label, .kicker, .caption, .btn, .pill, .tag')) {
        if (e.offsetParent === null || !e.textContent.trim()) continue;
        const rg = document.createRange(); rg.selectNodeContents(e);
        const b = rg.getBoundingClientRect();
        const wide = e.scrollWidth > e.clientWidth + 2;
        const tall = e.style.height && e.scrollHeight > e.clientHeight + 2;
        const off = b.right > stage.right + 2 || b.left < stage.left - 2 || b.bottom > stage.bottom + 2;
        const host = e.classList.contains('btn') ? null : e.parentElement.closest('.glass, .card, .sheet');
        const below = host && b.bottom > host.getBoundingClientRect().bottom + 2 * scale;
        // a button label that wraps at the larger size but not at the standard one (data-tl: its lines before scaling)
        const lines = (x) => { const rg2 = document.createRange(); rg2.selectNodeContents(x); return new Set([...rg2.getClientRects()].filter((c) => c.width > 0).map((c) => Math.round(c.top))).size; };
        const wraps = e.classList.contains('btn') && [...e.querySelectorAll(':scope > span')].some((x) => x.dataset.tl && lines(x) > +x.dataset.tl);
        if (wraps) overflow.push(`${e.className.split(' ').slice(0, 2).join('.')} "${e.textContent.trim().slice(0, 50)}" wraps`);
        if (wide || tall || off || below || e.dataset.fit === 'overflow') overflow.push(`${e.className.split(' ').slice(0, 2).join('.')} "${e.textContent.trim().slice(0, 50)}"${wide ? ' wide' : ''}${tall ? ' tall' : ''}${off ? ' off-stage' : ''}${below ? ' below-panel' : ''}`);
      }
      // texts running into each other (glyph boxes overlapping, as fitText measures it); not in the race HUD
      const overlap = [];
      if (!root.classList.contains('race')) {
        const texts = [...root.querySelectorAll('.label, .kicker, .caption, .btn, .pill, .tag')].filter((e) => e.offsetParent !== null && e.textContent.trim());
        const rect = (e) => { const rg = document.createRange(); rg.selectNodeContents(e); return rg.getBoundingClientRect(); };
        const rs = texts.map(rect);
        for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
          if (texts[i].contains(texts[j]) || texts[j].contains(texts[i]) || !rs[i].width || !rs[j].width) continue;
          const a = rs[i], b = rs[j];
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 4 * scale && h > .3 * Math.min(a.height, b.height)) overlap.push(`"${texts[i].textContent.trim().slice(0, 24)}" × "${texts[j].textContent.trim().slice(0, 24)}"`);
        }
      }
      // body text (< 28 px at the standard size) that is visible: how much of it got larger, and none below standard in Japanese
      let body = 0, grown = 0;
      const small = [];
      for (const e of root.querySelectorAll('[data-ts]')) {
        if (e.offsetParent === null || !e.textContent.trim()) continue;
        const std = parseFloat(e.dataset.ts);
        if (std >= 28 || std === 0) continue;
        const px = parseFloat(getComputedStyle(e).fontSize);
        body++;
        if (px >= std * 1.05) grown++;
        if (!en && px < std - .2) small.push(`"${e.textContent.trim().slice(0, 30)}" ${px.toFixed(1)} < ${std}`);
      }
      return { japanese: [...new Set(japanese)], overflow, overlap, body, grown, small, screen: globalThis.__muchi.screen };
    }, english);
    report.push({ name, english, ...r });
    if (r.japanese.length) errors.push(`a11y ${name}: Japanese left: ${r.japanese.slice(0, 8).join(' | ')}`);
    if (r.overflow.length) errors.push(`a11y ${name}${english ? ' (en)' : ''}: text overflows at the largest size: ${r.overflow.slice(0, 6).join(' | ')}`);
    if (r.overlap.length) errors.push(`a11y ${name}${english ? ' (en)' : ''}: texts run into each other at the largest size: ${r.overlap.slice(0, 6).join(' | ')}`);
    if (r.small.length) errors.push(`a11y ${name}: Japanese text below its standard size: ${r.small.slice(0, 6).join(' | ')}`);
    if (r.body > 0 && r.grown / r.body < MIN_GROWN) errors.push(`a11y ${name}${english ? ' (en)' : ''}: only ${r.grown}/${r.body} body texts got larger`);
    return r;
  }
  const shot = async (name, english = false, wait = 450) => {
    await page.waitForTimeout(wait);
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await audit(name, english);
    const f = path.join(out, `a11y-${String(++n).padStart(2, '0')}-${name}${english ? '-en' : ''}.png`);
    await page.screenshot({ path: f }); shots.push(f);
  };

  /**
   * Round 15 integration: boxes that must never overlap (each pair of visible matches, > 2 px both ways) — the home top bar
   * (season, rival strip, gift envelope, activity bell, wallet, EN, menu) and the settings lists (rows, kickers, links).
   */
  const boxesClear = async (name, sels, english = false) => {
    const r = await page.evaluate((sels) => {
      // buttons and panels by their box; text labels by their glyphs (a label's box is often wider than its words)
      const rectOf = (e) => { if (e.classList.contains('btn') || e.classList.contains('glass')) return e.getBoundingClientRect(); const rg = document.createRange(); rg.selectNodeContents(e); return rg.getBoundingClientRect(); };
      const bs = sels.flatMap((s) => [...document.querySelectorAll('.screen.in ' + s)].filter((e) => e.offsetParent !== null).map((e) => ({ s: s + ' "' + e.textContent.trim().slice(0, 16) + '"', r: rectOf(e), e })));
      const out = [];
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 2 && h > 2) out.push(`${a.s} × ${b.s}`);
      }
      return { out, n: bs.length };
    }, sels);
    if (r.out.length) errors.push(`a11y ${name}${english ? ' (en)' : ''}: boxes overlap: ${r.out.slice(0, 6).join(' | ')}`);
    return r;
  };
  const HOME_BAR = ['[data-name="Season"]', '.rv-strip', '.btn.envelope', '.btn.bell', '[data-name="Wallet"]', '.btn.lang', '[data-name="Menu"]'];
  // Round 16 integration: the whole home — the top bar plus the 次にやること card and chips, the partner card, the big CTA
  const HOME_ALL = [...HOME_BAR, '[data-name="Partner"]', '.next-card', '.next-chip', '.btn.cta.hero', '.hg-pin-strip']; // round 18: the pinned goal strip (demo('next') pins the partner's goal)
  /** demo('next') = a player with a next card and two chips (a gift expiring, scout tickets); waits for the card. */
  const homeWithNext = async () => {
    await page.evaluate(() => globalThis.__muchi.demo('next')); await waitScreen(['home', 'link-prompt'], 60000);
    if ((await screen()) === 'link-prompt') { await page.locator('.screen.in [data-label="あとで"]').click(); await waitScreen('home'); }
    await page.waitForSelector('.screen.in .next-card', { timeout: 15000 }); await page.waitForTimeout(700);
  };
  const SETTINGS_LISTS = ['[data-name="More"] > .btn', '[data-name="More"] > .kicker', '[data-name="Account"] > .btn', '[data-name="Account"] > .label'];

  await page.goto(base + 'index.html?demo=day7');
  await page.waitForFunction(() => globalThis.__muchi?.ready === true, null, { timeout: 90000 });
  await waitScreen(['home', 'link-prompt']);
  if ((await screen()) === 'link-prompt') await page.locator('.screen.in [data-label="あとで"]').click();
  await waitScreen('home');
  // at the standard size: the home top bar (bell / gift envelope / rival strip) and the settings rows
  await page.waitForTimeout(700);
  const homeBar = await boxesClear('home top bar', HOME_BAR);
  assert.ok(homeBar.n >= 6, 'home top bar: season, rival strip, envelope, bell, wallet, EN and menu are drawn: ' + homeBar.n);
  // the next card and chips do not run into the top bar, the partner card, the menu or the CTA (standard size)
  await homeWithNext();
  const homeNext = await boxesClear('home with the next card', HOME_ALL);
  assert.ok(homeNext.n >= 10, 'home: top bar + next card + chips + partner + CTA are drawn: ' + homeNext.n);
  await page.evaluate(() => globalThis.__muchi.demo('day7')); await waitScreen(['home', 'link-prompt'], 60000);
  if ((await screen()) === 'link-prompt') { await page.locator('.screen.in [data-label="あとで"]').click(); await waitScreen('home'); }
  await show('Settings'); await waitScreen('settings');
  const settingsBoxes = await boxesClear('settings lists', SETTINGS_LISTS);
  assert.ok(settingsBoxes.n >= 12, 'settings: the lists are drawn: ' + settingsBoxes.n);
  await show('Home'); await waitScreen('home');

  // 1) the settings screen applies each choice everywhere and saves it on the server rules
  await show('Settings'); await waitScreen('settings');
  await page.locator('.screen.in [data-action="a11y"]').click(); await waitScreen('a11y-settings'); await page.waitForTimeout(400);
  assert.equal(await page.locator('.screen.in [data-a11y-row]').count(), 7, 'seven rows');
  assert.match(await page.locator('.screen.in [data-a11y-fair]').innerText(), /ランク戦の強さは変わりません/, 'the fairness line is shown');
  assert.match(await page.locator('.screen.in [data-a11y-flash]').innerText(), /1秒に3回まで/, 'the flash line is shown');
  const before = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.screen.in [data-a11y-row="textSize"] .label')).fontSize));
  await choose('textSize', 'largest');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.textSize), 'largest');
  const after = await page.evaluate(() => { const e = document.querySelector('.screen.in [data-a11y-row="textSize"] .label'); return { px: parseFloat(getComputedStyle(e).fontSize), ts: parseFloat(e.dataset.ts) }; });
  assert.ok(after.ts === before && after.px > before * 1.2, `text size applies at once: ${before} → ${after.px}`);
  const critical = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--a11y-gauge-critical').trim());
  assert.equal(await critical(), '#ff5a4a');
  await choose('colorMode', 'cvd');
  assert.equal(await critical(), '#cc6633', 'colour-vision support swaps the tokens');
  await choose('reduceMotion', true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.reduceMotion), 'on');
  await choose('haptics', false); await choose('oneHanded', 'right'); await choose('whipInput', 'hold');
  const saved = await page.evaluate(() => globalThis.__muchi.logic.accessibility());
  assert.deepEqual([saved.textSize, saved.colorMode, saved.reduceMotion, saved.haptics, saved.oneHanded, saved.whipInput, saved.rev], ['largest', 'cvd', true, false, 'right', 'hold', 6], 'saved on the server rules, one rev per change');
  const kpi = (await page.evaluate(() => globalThis.__muchi.logic.serverKpiLog())).filter((k) => k.name === 'a11y_setting_change');
  assert.deepEqual(kpi.map((k) => `${k.s1}=${k.s2}`), ['textSize=largest', 'colorMode=cvd', 'reduceMotion=on', 'haptics=off', 'oneHanded=right', 'whipInput=hold'], 'KPI: which setting and value only');
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('muchi.a11y.settings'))).textSize, 'largest', 'the device copy');
  await shot('settings-largest-cvd');

  // 2) key screens at the largest size, Japanese
  const keyScreens = async (english) => {
    await show('Home'); await waitScreen('home'); await shot('home', english, 700);
    await show('Settings'); await waitScreen('settings'); await shot('settings', english);
    await show('A11ySettings'); await waitScreen('a11y-settings'); await shot('a11y-settings', english);
    await show('Store', 'recommended'); await waitScreen('shop-recommended'); await shot('shop-recommended', english, 600);
    await show('Store', 'coins'); await waitScreen('shop-coins'); await shot('shop-coins', english, 500);
    await show('Scout'); await waitScreen('scout'); await shot('scout', english, 800);
    await show('Odds', 'standard'); await shot('odds', english, 500);
    await show('Stable'); await shot('stable', english, 600);
    await show('SeasonPass'); await waitScreen('pass'); await shot('season-pass', english, 600);
    await show('AssistSettings'); await waitScreen('assist-settings'); await shot('assist-settings', english);
    await show('GiftBox'); await shot('gift-box', english, 600);
    await show('Collection'); await shot('collection', english, 600);
    await show('Training'); await shot('training', english, 600);
    // Round 14 screens (integration): 殿堂, 勝負服エディタ, 実況パック, マイリプレイ
    await show('Hall'); await waitScreen('hall'); await shot('hall', english, 600);
    await show('SilksEditor'); await waitScreen('silks'); await shot('silks-editor', english, 600);
    await show('CommentaryPacks'); await waitScreen('commentary-packs'); await shot('commentary-packs', english, 600);
    await show('MyReplays'); await waitScreen('my-replays'); await shot('my-replays', english, 600);
    // Round 15 screens: the pre-race advice panel (the lobby), アクティビティ; the settings rows again at this size
    await show('RaceAdvice'); await waitScreen('lobby'); await page.waitForSelector('.screen.in .adv-row', { timeout: 15000 }); await shot('race-advice', english, 600);
    await show('Activity'); await waitScreen('activity'); await shot('activity', english, 600);
    // Round 16 screens (integration): 厩舎の整理, シーズンの振り返り (list + a page), プレイヤー主催カップ (list, create, join)
    await show('Roster'); await waitScreen('roster'); await page.waitForSelector('.screen.in .org-list', { timeout: 15000 }); await shot('roster', english, 600);
    await show('Recaps'); await waitScreen('recaps', 30000); await page.waitForSelector('.screen.in .rc-card', { timeout: 30000 }); await shot('recaps', english, 600);
    await show('Recap', 'season:2026-11', 0); await waitScreen('recap'); await page.waitForSelector('.screen.in .rc-big', { timeout: 30000 }); await shot('recap', english, 950);
    await show('HostedCups'); await waitScreen('hosted-cups', 30000); await shot('cups', english, 600);
    // Round 18: 馬ごとの目標 — the panel on the horse detail and the full chain
    await show('Stable'); await page.waitForSelector('.screen.in .hg-panel', { timeout: 15000 }); await shot('stable-goals', english, 500);
    await show('HorseGoals', await page.evaluate(async () => (await globalThis.__muchi.logic.view()).flags.partnerHorseId)); await waitScreen('horse-goals'); await page.waitForSelector('.screen.in .hg-row', { timeout: 15000 }); await shot('horse-goals', english, 500);
    await show('CupCreate'); await waitScreen('cup-create'); await shot('cup-create', english, 500);
    await show('CupJoin'); await waitScreen('cup-join'); await shot('cup-join', english, 500);
    // Round 17: 通報とブロック — the block list and the report sheet at the largest size (REQ-RPT-019)
    await show('BlockList'); await waitScreen('blocks'); await shot('blocks', english, 600);
    // Round 20: エラーの自動送信 (REQ-CERR-*) at the largest size
    await show('Diagnostics'); await waitScreen('diagnostics'); await shot('diagnostics', english, 600);
    await page.evaluate(() => globalThis.__muchi.show('Report', { playerId: 'demo_rpt_x', name: 'ヨルノカラス', kind: 'display_name', source: 'profile' })); await page.waitForTimeout(800);
    await shot('report-sheet', english, 300);
    // Round 17: the maintenance screen, the update-required screen and the maintenance notice (REQ-MNT-015)
    await show('Maintenance'); await waitScreen('maintenance'); await shot('maintenance', english, 600);
    await show('UpdateRequired'); await waitScreen('update-required'); await shot('update-required', english, 600);
    await show('MaintenanceNotice'); await waitScreen('maintenance-notice'); await shot('maintenance-notice', english, 600);
    await page.evaluate(() => globalThis.__muchi.logic.maintenanceDemo('off'));
    // Round 17: ヘルプセンター (the index, an article, the form, my inquiries) at the largest size
    await show('HelpCenter'); await waitScreen('help'); await shot('help-center', english, 500);
    await show('HelpArticle', 'pity', 'list'); await waitScreen('help-article'); await shot('help-article', english, 500);
    await show('InquiryForm'); await waitScreen('inquiry-form'); await shot('inquiry-form', english, 500);
    await show('MyInquiries'); await waitScreen('my-inquiries'); await shot('my-inquiries', english, 500);
    // Round 17: おすすめフレンド (the friends screen's suggestions section)
    await show('Friends'); await waitScreen('friends'); await shot('friends-suggestions', english, 600);
    // Round 18: 練習レース (the setup screen at the largest size)
    await show('Practice'); await waitScreen('practice'); await page.waitForSelector('.screen.in .pr-setup', { timeout: 15000 }); await shot('practice', english, 600);
    // Round 18 integration: a practice race at the largest size (the shortest course, two runners; the whip band and the
    // slow chip on the HUD), run to the practice result
    for (let i = 0; i < 8 && (await page.locator('.screen.in .pr-course').getAttribute('data-track')) !== 'bellmoor_turf_1200'; i++) { await page.locator('.screen.in .pr-course-next').click(); await page.waitForTimeout(300); }
    for (let i = 0; i < 10; i++) { await page.locator('.screen.in .pr-field-minus').click(); await page.waitForTimeout(100); }
    await page.locator('.screen.in .pr-start').click(); await waitScreen('race', 20000);
    for (let i = 0, raceShot = false, kicked = false; i < 6000; i++) {
      const f = await page.evaluate(() => globalThis.__muchi.state().lastFrame);
      if (!f) { await page.waitForTimeout(50); continue; }
      if (f.done || (await screen()) !== 'race') break;
      if (!kicked && f.gateOpen && !f.departed) { await page.locator('.screen.in .btn.whip').click({ force: true }); kicked = true; }
      if (!raceShot && f.departed && f.remainingM < 700) { raceShot = true; await shot('practice-race', english, 0); }
      await page.waitForTimeout(40);
    }
    await waitScreen('practice-result', 40000); await page.waitForSelector('.screen.in .pr-result', { timeout: 15000 }); await shot('practice-result', english, 500);
    // Round 18: 支部の定型チャット (the picker and the feed rows grow with the text size)
    await show('QuickChat'); await waitScreen('team-chat', 30000); await page.waitForSelector('.screen.in .qc-phrase', { timeout: 20000 }); await shot('quick-chat', english, 600);
    // Round 18 integration: a teammate's phrase reported from its row (the §47 sheet with the phrase, kind qchat)
    await page.locator('.screen.in [data-label="支部員のデモ"]').click(); await page.waitForSelector('.screen.in .tf-link[data-report="qchat"]', { timeout: 20000 });
    await page.locator('.screen.in .tf-link[data-report="qchat"]').first().click(); await page.waitForSelector('.sheet.rpt-sheet[data-kind="qchat"]', { timeout: 15000 });
    await shot('qchat-report-sheet', english, 300);
    // Round 18: プライバシー › データのダウンロード, and its help article (context privacy → data_export)
    await show('Privacy'); await waitScreen('privacy'); await page.waitForSelector('.screen.in [data-dex]', { timeout: 15000 }); await shot('privacy', english, 500);
    await page.locator('.screen.in [data-help-context="privacy"]').click(); await waitScreen('help-article'); await shot('help-data-export', english, 500);
    await show('Settings'); await waitScreen('settings'); await boxesClear('settings lists (largest)', SETTINGS_LISTS, english);
    await show('Home'); await waitScreen('home'); await page.waitForTimeout(700); await boxesClear('home top bar (largest)', HOME_BAR, english);
  };
  await keyScreens(false);

  // 3) a race: reduce motion, haptics off, one-handed right, whip hold
  await page.evaluate(() => { globalThis.__vibrations = 0; });
  await show('Home'); await waitScreen('home');
  await page.locator('.screen.in [data-label="レースへ"]').click(); await waitScreen('lobby');
  await page.locator('.screen.in [data-label="ランク戦に出る"]').click(); await waitScreen('race', 20000);
  const pos = await page.evaluate(() => { const g = (s) => { const e = document.querySelector('.screen.in ' + s); return e ? [parseFloat(e.style.left), parseFloat(e.style.top)] : null; }; return { whip: g('.btn.whip'), laneIn: g('[data-label="内へ"]'), laneOut: g('[data-label="外へ"]'), rein: g('.btn.rein') }; });
  assert.ok(pos.laneIn[0] >= 1100 && pos.laneOut[0] >= 1100 && pos.whip[0] > 1300 && pos.rein[0] > 1100, 'one-handed (right): every control on the right: ' + JSON.stringify(pos));
  let held = false, hudShot = false, holdWhips = 0, sawSpeed = false, prevW = null, hint = '';
  for (let i = 0; i < 5000; i++) {
    const f = await page.evaluate(() => globalThis.__muchi.state().lastFrame);
    if ((await screen()) !== 'race') break;
    if (!f) { await page.waitForTimeout(60); continue; }
    if (f.done) break;
    const box = await page.locator('.screen.in .btn.whip').boundingBox();
    if (f.gateOpen && !f.departed && !held) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up(); }
    if (f.departed && !held && f.remainingM <= 450) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); held = true; }
    if (held) { if (prevW != null && f.whips < prevW) holdWhips++; prevW = f.whips; }
    if (held && !hint) hint = (await page.locator('.screen.in .holdhint').textContent()) ?? '';
    sawSpeed ||= (await page.locator('.screen.in .speedlines').count()) > 0;
    if (!hudShot && held && f.remainingM < 300) { hudShot = true; await shot('race-hud-hold', false, 0); }
    await page.waitForTimeout(40);
  }
  if (held) await page.mouse.up();
  await waitScreen(['result'], 40000);
  assert.ok(holdWhips >= 2, 'the held whip button whipped (press + repeats): ' + holdWhips);
  assert.match(hint, /^長押し あと\d$/, 'the hold hint: ' + hint);
  assert.equal(sawSpeed, false, 'reduce motion: no speed lines');
  assert.equal(await page.evaluate(() => globalThis.__vibrations), 0, 'haptics off: no vibration at all');
  await shot('result', false, 1000);
  // Round 15 photo mode at the largest size: Japanese, then English in place (the finished race stays in the engine)
  await page.locator('.screen.in [data-action="photo-result"]').click(); await waitScreen('photo', 20000); await shot('photo', false, 600);
  await page.evaluate(() => globalThis.__muchi.l10n.set('en')); await waitScreen('photo'); await shot('photo', true, 600);
  await page.evaluate(() => globalThis.__muchi.l10n.set('ja'));
  await page.locator('.screen.in [data-action="ph-back"]').click(); await waitScreen('result');

  // 4) the scout reveal with reduce motion: the face at once, every result in the plan
  await show('Scout'); await waitScreen('scout');
  await page.locator('.screen.in .btn[data-label^="10回引く"]').first().click(); await waitScreen('scout-reveal');
  await page.waitForTimeout(60);
  assert.equal(await page.locator('.screen.in .rcard.back').count(), 0, 'reduce motion: the card face shows at once (no glow wait)');
  const plan = await page.evaluate(() => globalThis.__muchi.reveal);
  assert.ok(plan.order.length === 10 && plan.summary.length === 10, 'the reveal plan lists every result of the 10-pull');
  await shot('scout-reveal-reduced', false, 200);
  await page.locator('.screen.in [data-label="すべてめくる"]').click(); await waitScreen('scout-list'); await shot('scout-list', false, 400);

  // 2b) the same key screens in English, still at the largest size
  await page.evaluate(() => localStorage.setItem('muchi.language', 'en'));
  await page.goto(base + 'index.html');
  await page.waitForFunction(() => globalThis.__muchi?.ready === true, null, { timeout: 90000 });
  await waitScreen(['home', 'link-prompt']);
  if ((await screen()) === 'link-prompt') await page.locator('.screen.in [data-label="あとで"]').click();
  assert.equal((await a11y()).textSize, 'largest', 'the device copy survives a reload');
  await keyScreens(true);
  // Round 16 integration: the home with the next card and chips at the largest size, English then Japanese
  await homeWithNext();
  await shot('home-next', true, 300); await boxesClear('home with the next card (largest)', HOME_ALL, true);
  await page.evaluate(() => globalThis.__muchi.l10n.set('ja')); await waitScreen('home');
  await page.waitForSelector('.screen.in .next-card', { timeout: 15000 }); await page.waitForTimeout(700);
  await shot('home-next', false, 300); await boxesClear('home with the next card (largest)', HOME_ALL, false);
  await page.evaluate(() => { localStorage.setItem('muchi.language', 'ja'); });
  await ctx.close();
  return { shots, report };
};
const MIN_GROWN = 0.6;
