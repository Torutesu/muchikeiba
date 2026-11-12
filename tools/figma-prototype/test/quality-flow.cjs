// Quality integration (claude/quality-1) in the browser: the four quality passes on one build.
//  a) home: 次にやること says only what nothing else on home says (never the pass / mission rewards the ladder's
//     「受け取れる報酬があります」 already says), one link at most; the ladder's season rung carries the pass rewards;
//  b) a ruleset 1.4 race (the prototype previews 1.4 in ranked): the gate count and the finish stamp still fire; the coaching
//     line never repeats the pop; in the final straight the 仕掛けバー (after the go), the banner, the mini-map and the marker's
//     words fade while the whip button stays at full strength;
//  c) the result: the post-race lesson sits in the staggered celebration (fx-stat), above the CTA, the quiet keepsake row intact;
//  d) the raising screens: readable text ≥ 16 px (footnotes 14 px), the foal reveal under reduce motion shows its end state;
//  e) 目標: the cap line links to the horse card of the ladder's horse.
// usage: from e2e.cjs (E2E_ONLY=quality or the full run). Screenshots: <out>/q-<name>.png
const path = require('path');
const assert = require('assert/strict');

module.exports = async function qualityFlow(browser, base, out, errors) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('quality pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('quality console: ' + m.text()); });
  const shots = [];
  const shot = async (name, wait = 400) => { await page.waitForTimeout(wait); const f = path.join(out, `q-${name}.png`); await page.screenshot({ path: f }); shots.push(f); };
  const scr = () => page.evaluate(() => globalThis.__muchi?.screen ?? '');
  const waitScreen = (n, timeout = 30000) => page.waitForFunction((x) => [].concat(x).includes(globalThis.__muchi?.screen), n, { timeout, polling: 50 });
  const toHome = async () => {
    for (let i = 0; i < 6; i++) {
      if ((await scr()) === 'home') return;
      const later = page.locator('.screen.in [data-label="あとで"], .screen.in [data-label="閉じる"]').first();
      if (await later.count()) await later.click(); else await page.evaluate(() => globalThis.__muchi.show('Home'));
      await page.waitForTimeout(700);
    }
    assert.equal(await scr(), 'home', 'quality: home reached');
  };
  await page.goto(base + 'index.html');
  await page.waitForFunction(() => globalThis.__muchi?.ready === true, null, { timeout: 120000 });

  // a) day 3: the server lists missions_claim, pass_claim, feature_unlocked
  await page.evaluate(() => globalThis.__muchi.demo('day3')); await page.waitForTimeout(2500); await toHome(); await page.waitForTimeout(1200);
  const home = await page.evaluate(async () => {
    const c = document.querySelector('.screen.in .next-card');
    const v = (await globalThis.__muchi.logic.nextActions()).value;
    return { next: c?.dataset.next ?? null, links: c ? c.querySelectorAll('.btn.link').length : 0, text: c?.innerText ?? '', server: [v.primary, ...v.chips].filter(Boolean).map((i) => i.kind),
      seasonReady: document.querySelector('.screen.in [data-rung="season"]')?.dataset.ready ?? null, claimLine: !!document.querySelector('.screen.in .gl-home-claim') };
  });
  assert.ok(home.server.includes('pass_claim'), 'quality a: the server lists the pass rewards: ' + home.server);
  assert.ok(!['pass_claim', 'missions_claim'].includes(home.next), 'quality a: the next line never repeats the ladder\'s rewards: ' + home.next);
  assert.ok(!/シーズンパスの報酬を受け取れます|ミッションの報酬を受け取れます|受け取りにいく/.test(home.text), 'quality a: no 「受け取りにいく」 line on home: ' + home.text);
  assert.ok(home.links <= 1, 'quality a: one link at most (' + home.links + ')');
  assert.ok(home.seasonReady === '1' && home.claimLine, 'quality a: the ladder\'s season rung says the pass rewards');
  await shot('home');
  // e) 目標 → the cap → the horse card
  await page.locator('.screen.in .gl-panel').click(); await waitScreen('goals');
  assert.ok(await page.locator('.screen.in [data-action="goals-pass"]').count(), 'quality a: 目標 names the pass rewards');
  await page.locator('.screen.in [data-action="cap-horse-card"]').click(); await waitScreen('horse-card');
  const capOk = await page.evaluate(async () => { const g = (await globalThis.__muchi.logic.goals()).value; return document.querySelector('.screen.in .qr-card')?.dataset.horse === g.season.power.horseId && document.querySelector('.screen.in .qr-ranked')?.textContent.includes(g.season.power.cap.toLocaleString('en-US')); });
  assert.ok(capOk, 'quality e: the cap link opens the ladder horse\'s card with the same cap');
  await page.locator('.screen.in [data-label="BACK"]').click(); await waitScreen('goals');

  // b) a 1.4 race on the trained partner: START on the gate, hold at the gold line, release (the go), whips on the ring
  await page.evaluate(() => globalThis.__muchi.demo('raising')); await page.waitForTimeout(2500); await toHome();
  await page.locator('.screen.in [data-label="レースへ"]').first().click(); await waitScreen('lobby');
  await page.locator('.screen.in [data-label="ランク戦に出る"]').click(); await waitScreen('race', 30000);
  await page.evaluate(() => {
    const q = globalThis.__qf = { fx: [], dups: [], straight: null, go: null };
    const key = (type) => document.dispatchEvent(new KeyboardEvent(type, { key: 'e', bubbles: true }));
    const tap = () => { key('keydown'); setTimeout(() => key('keyup'), 60); };
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.dataset?.fx) q.fx.push(n.dataset.fx); }).observe(document.body, { childList: true, subtree: true });
    const op = (sel) => { const n = document.querySelector('.screen.in ' + sel); return n && !n.hidden ? Number(getComputedStyle(n).opacity) : null; };
    q.iv = setInterval(() => {
      const f = globalThis.__muchi.state().lastFrame; if (!f) return; const t = f.feel?.tactics;
      if (f.gateOpen && !q.started) { q.started = true; tap(); }
      if (t) {
        if (t.goNow && !q.held && !t.committed) { key('keydown'); q.held = f.tick; }
        if (q.held && !q.released && t.gathering && f.tick - q.held >= 24) { key('keyup'); q.released = f.tick; }
        if (t.committed && q.released && f.whips > 0 && ((t.rhythm === 'gold' && f.tick - (q.lastWhip ?? 0) > 8) || f.tick - (q.lastWhip ?? 0) > 26)) { tap(); q.lastWhip = f.tick; }
        if (q.released && !q.go && f.tick - q.released > 4) q.go = { gobar: op('.gobar'), whip: op('.btn.whip') };
      }
      const hint = document.querySelector('.screen.in .hintbox:not(.empty) .hint')?.textContent, pop = document.querySelector('.screen.in .pop.flash')?.textContent;
      if (hint && pop && hint.replace(/[！!]$/, '') === pop.replace(/[！!]$/, '')) q.dups.push(hint);
      // sampled once the straight's fade has run (the --dur-slow transition)
      if (document.querySelector('.screen.in.fx-straight') && !q.straight && f.remainingM < 250 && f.remainingM > 60) {
        q.straight = { gobar: op('.gobar'), phase: document.querySelector('.screen.in .gobar')?.dataset.phase, banner: op('.chip.banner'), minimap: op('.minimap'), wind: op('.marker .wind'), whip: op('.btn.whip'), hint: op('.hintbox') };
      }
      if (f.done) clearInterval(q.iv);
    }, 50);
  });
  await waitScreen('result', 240000);
  const race = await page.evaluate(() => globalThis.__qf);
  assert.ok(race.fx.includes('count') && race.fx.includes('finish'), 'quality b: the gate count and the finish stamp fire on a 1.4 race: ' + race.fx);
  assert.ok(race.fx.includes('straight'), 'quality b: the final straight cut-in fires on a 1.4 race');
  assert.deepEqual(race.dups, [], 'quality b: the coaching line never repeats the pop');
  assert.ok(race.go && race.go.whip === 1, 'quality b: the whip button at full strength at the go');
  assert.ok(race.straight, 'quality b: the final straight sampled');
  assert.ok(race.straight.whip === 1, 'quality b: the whip button stays at full strength in the straight');
  assert.ok(race.straight.banner === 0 && race.straight.minimap === 0 && race.straight.wind === 0, 'quality b: banner / mini-map / the marker\'s words fade in the straight: ' + JSON.stringify(race.straight));
  if (race.straight.phase === 'go') assert.ok(race.straight.gobar === null || race.straight.gobar === 0, 'quality b: the 仕掛けバー fades once the go is made: ' + JSON.stringify(race.straight));

  // c) the result: the lesson in the celebration
  await page.waitForTimeout(400);
  const res = await page.evaluate(() => {
    const box = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
    const l = document.querySelector('.screen.in .go-lesson');
    const labels = [...document.querySelectorAll('.screen.in .glass .label')].filter((n) => n !== l && n.textContent.trim());
    const overlaps = l ? labels.filter((n) => { const a = box(n), b = box(l); return n.offsetParent && a.top < b.bottom - 2 && a.bottom > b.top + 2 && Math.abs(n.getBoundingClientRect().left - l.getBoundingClientRect().left) < 300; }).map((n) => n.textContent) : [];
    return { lesson: l?.textContent ?? null, stagger: !!l && l.classList.contains('fx-stat') && parseFloat(l.style.animationDelay) > parseFloat(document.querySelectorAll('.screen.in .fx-stat')[2]?.style.animationDelay ?? '0'),
      lessonBox: box(l), cta: box(document.querySelector('.screen.in .btn.cta')), overlaps, quiet: document.querySelectorAll('.screen.in .btn.quiet').length, place: document.querySelector('.screen.in').dataset.place };
  });
  assert.ok(res.lesson && /^振り返り：/.test(res.lesson), 'quality c: the 1.4 lesson on the result: ' + res.lesson);
  assert.ok(res.stagger, 'quality c: the lesson arrives in the stagger, after the numbers');
  assert.ok(res.lessonBox.bottom <= res.cta.top, 'quality c: the lesson sits above the CTA');
  assert.deepEqual(res.overlaps, [], 'quality c: the lesson overlaps no other line');
  assert.equal(res.quiet, 3, 'quality c: the quiet keepsake row (photo, keep, share) is intact');
  await shot('result', 2200);

  // d) the raising screens: the type floor; the reveal under reduce motion
  const minFont = () => page.evaluate(() => {
    const ns = [...document.querySelectorAll('.screen.in .label')].filter((n) => n.textContent.trim() && !n.closest('.btn'));
    const read = ns.filter((n) => !n.classList.contains('qr-rules') && !n.classList.contains('qr-legal'));
    const size = (n) => parseFloat(n.dataset.ts || n.style.fontSize) || 99;
    return { read: Math.min(...read.map(size)), all: Math.min(...ns.map(size)), small: read.filter((n) => size(n) < 16).map((n) => n.textContent.slice(0, 20)).slice(0, 6) };
  });
  await page.evaluate(() => globalThis.__muchi.demo('raising')); await waitScreen('horse-card', 60000); await page.waitForTimeout(600);
  const card = await minFont();
  assert.ok(card.read >= 16 && card.all >= 14, 'quality d: horse card text floor 16 px (footnotes 14): ' + JSON.stringify(card));
  await page.evaluate(() => globalThis.__muchi.demo('breeding')); await waitScreen('breeding', 60000); await page.waitForTimeout(600);
  const br = await minFont();
  assert.ok(br.read >= 16 && br.all >= 14, 'quality d: breeding text floor 16 px (footnotes 14): ' + JSON.stringify(br));
  const shadows = await page.evaluate(() => [...document.querySelectorAll('.screen.in .card.qr-parent.sel')].map((n) => getComputedStyle(n).boxShadow.split(/,(?![^(]*\))/).filter((s) => !/inset/.test(s)).length));
  assert.ok(shadows.every((n) => n <= 1), 'quality d: one drop shadow on a selected parent card: ' + shadows);
  await page.evaluate(() => globalThis.__muchi.a11y.set('reduceMotion', true)); await page.waitForTimeout(200);
  await page.evaluate(() => globalThis.__muchi.show('Breeding')); await waitScreen('breeding');
  await page.locator('.screen.in .qr-breed').click(); await waitScreen('breeding-reveal', 20000); await page.waitForTimeout(150);
  const rv = await page.evaluate(() => ({ hidden: document.querySelectorAll('.screen.in .qr-hide:not(.qr-show)').length, toCard: !!document.querySelector('.screen.in .qr-to-card'), font: Math.min(...[...document.querySelectorAll('.screen.in .qr-reveal .label')].filter((n) => n.textContent.trim()).map((n) => parseFloat(n.dataset.ts || n.style.fontSize) || 99)) }));
  assert.ok(rv.hidden === 0 && rv.toCard, 'quality d: reduce motion — the reveal shows its end state at once: ' + JSON.stringify(rv));
  assert.ok(rv.font >= 16, 'quality d: the reveal text floor 16 px');
  await shot('breeding-reveal-reduced', 300);
  await page.evaluate(() => globalThis.__muchi.a11y.set('reduceMotion', false));
  await ctx.close();
  return { shots, race, res };
};
