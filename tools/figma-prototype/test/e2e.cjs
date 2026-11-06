// End-to-end walkthrough of the web prototype in the preinstalled Chromium.
//   1. club UI (index.html): Codex's 25 detailed screens on the real logic and engine, desktop and mobile
//      (club-flow.cjs; club-<screen>.png, named after frontend/design/screens)
//   2. Unity UI (unity.html): the whole app flow, a 1280×720 screenshot of every screen
// Fails on any console error / page error. Screenshots go to <outDir> (default: tools/figma-prototype/.screens).
// usage: node tools/figma-prototype/test/e2e.cjs [outDir]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const clubFlow = require('./club-flow.cjs');

const SITE = path.join(__dirname, '..', 'site');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', '.screens'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain', '.fbx': 'application/octet-stream' };

function serve() {
  return new Promise((ok) => {
    const s = http.createServer((req, res) => {
      const p = path.join(SITE, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
      if (!p.startsWith(SITE) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const url = base + 'unity.html';
  const browser = await chromium.launch();
  const errors = [];
  const clubShots = await clubFlow(browser, base, OUT, errors);
  console.log(`club UI: ${clubShots.length} screenshots`);
  if (process.env.E2E_ONLY === 'club') { await browser.close(); server.close(); if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); } return; }
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  let n = 0;
  const shot = async (name) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) }); };
  const click = async (label) => { await page.locator(`.screen.in [data-label="${label}"]`).first().click(); await page.waitForTimeout(380); };
  const ready = () => page.waitForFunction(() => globalThis.__muchi?.ready === true, null, { timeout: 60000 });
  const runRace = async (name) => {
    await shot(name + '-start');
    let midShot = false;
    for (let i = 0; i < 400; i++) {
      const s = await page.evaluate(() => globalThis.__muchi.state());
      const f = s.lastFrame;
      if (!s.raceActive && f?.done) break;
      if (f && (!f.departed || (f.remainingM < 420 && f.whips > 0 && i % 3 === 0))) await page.locator('.screen.in [data-label="SPUR"]').click().catch(() => {});
      if (!midShot && f && f.departed && f.remainingM < 300) { midShot = true; await shot(name + '-straight'); }
      await page.waitForTimeout(450);
    }
    await page.waitForSelector('.screen.in [data-label="CONTINUE  >>"], .screen.in [data-label="MEET YOUR PARTNER"]', { timeout: 120000 });
    await shot(name + '-result');
  };

  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url); await ready();
  await shot('title');
  await click('RACE  /  START');
  await runRace('first-ride');
  await click('MEET YOUR PARTNER');
  await shot('partner-naming');
  await page.fill('.screen.in input.field', 'Muchi');
  await click('CONFIRM  >>');
  await shot('name-rejected');
  await click('CONTINUE  >>');
  await page.fill('.screen.in input.field', 'はやてまる');
  await click('CONFIRM  >>');
  await shot('scout-free');
  await click('FREE 10-HORSE SCOUT');
  await shot('scout-results');
  await click('GO TO HOME  >>');
  await shot('home');
  await click('STABLE'); await shot('stable'); await click('BACK');
  await click('SCOUT'); await shot('scout-paid');
  await click('VIEW RATES'); await shot('scout-rates'); await click('BACK');
  await click('10 PULLS  ◎1,000'); await shot('scout-paid-results'); await click('GO TO HOME  >>');
  await click('WARDROBE'); await shot('wardrobe');
  await page.locator('.screen.in [data-label="EQUIP PARTNER"]').nth(1).click(); await page.waitForTimeout(380); await shot('wardrobe-equipped'); await click('BACK');
  await click('COURSE'); await click('PREVIEW'); await shot('course-looks'); await click('BACK');
  await click('CONDITIONS'); await shot('conditions'); await click('BACK');
  await click('CARE / FEED'); await shot('care-feed'); await click('BACK');
  await click('SHOP'); await shot('store-coins');
  await page.locator('.screen.in [data-label="VIEW"]').first().click(); await page.waitForTimeout(500); await shot('purchase-review');
  await click('18+'); await page.waitForTimeout(400); await shot('purchase-review-age'); await click('BACK');
  await click('COSMETICS'); await shot('store-cosmetics');
  await click('COURSE THEMES'); await shot('store-course-themes');
  await click('SEASON PASS'); await shot('season-pass'); await click('BACK');
  await click('日本語').catch(() => {}); // language toggle (if currently English)
  await click('English'); await shot('home-english'); await click('日本語');
  await click('RACE  >>'); await shot('race-entry');
  await click('ENTER THE RACE  >>');
  await runRace('ranked-race');
  await click('CONTINUE  >>'); await shot('home-after-race');

  await browser.close(); server.close();
  if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log(`E2E OK — club ${clubShots.length} + Unity ${n} screenshots in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
