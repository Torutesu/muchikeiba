// End-to-end walkthrough of the web prototype in the preinstalled Chromium.
//   1. club UI (club.html): Codex's 25 detailed screens on the real logic and engine, desktop and mobile
//      (club-flow.cjs; club-<screen>.png, named after frontend/design/screens)
//   2. ムチ一閃 UI (index.html, the site root): the round 8 FTUE measured with a simulated new player (unity-flow.cjs, ftue.json) and
//      every screen and state on a landscape phone (844×390 @2x, u-<nn>-<name>.png)
//   3. round 11 (REQ-L10N-013): a short pass in English (en-flow.cjs; en-<nn>-<name>.png): no Japanese left, no overflow
//   4. round 15 (REQ-A11Y-*): the アクセシビリティ settings applied across the prototype, and the overflow check of key
//      screens at the largest text size in Japanese and English (a11y-flow.cjs; a11y-<nn>-<name>.png)
//   5. the quality integration (quality-flow.cjs; q-<name>.png): the four quality passes working together
//   E2E_ONLY=club | unity | en | a11y | quality runs one part.
// Fails on any console error / page error. Screenshots go to <outDir> (default: tools/figma-prototype/.screens), plus
// contact-sheet.png of every ムチ一閃 screen (contact-sheet.py).
// usage: node tools/figma-prototype/test/e2e.cjs [outDir]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const clubFlow = require('./club-flow.cjs');
const unityFlow = require('./unity-flow.cjs');
const enFlow = require('./en-flow.cjs');
const a11yFlow = require('./a11y-flow.cjs');
const qualityFlow = require('./quality-flow.cjs'); // quality integration (claude/quality-1)
const firstWeekFlow = require('./first-week-flow.cjs'); // quality pass 2: the first week (docs/quality/first-week.md)

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
  const url = base + 'index.html';
  const browser = await chromium.launch();
  const errors = [];
  const a11yLine = (a) => {
    const body = a.report.reduce((x, r) => x + r.body, 0), grown = a.report.reduce((x, r) => x + r.grown, 0);
    return `${a.shots.length} screenshots at the largest text size, ${a.report.length} screens audited (JA + EN), ${grown}/${body} body texts larger, ${a.report.reduce((x, r) => x + r.overflow.length, 0)} overflowing`;
  };
  if (process.env.E2E_ONLY === 'a11y') {
    const a = await a11yFlow(browser, base, OUT, errors);
    console.log('Accessibility: ' + a11yLine(a));
    await browser.close(); server.close();
    if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
    console.log('E2E OK (a11y)'); return;
  }
  if (process.env.E2E_ONLY === 'quality') {
    const q = await qualityFlow(browser, base, OUT, errors);
    console.log(`Quality integration: place ${q.res.place}, lesson "${q.res.lesson}", peaks ${[...new Set(q.race.fx)].join('/')}`);
    await browser.close(); server.close();
    if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
    console.log('E2E OK (quality)'); return;
  }
  if (process.env.E2E_ONLY === 'week') {
    const w = await firstWeekFlow(browser, base, OUT, errors);
    console.log(`First week: ${w.shots.length} screenshots`);
    await browser.close(); server.close();
    if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
    console.log('E2E OK (week)'); return;
  }
  if (process.env.E2E_ONLY === 'en') {
    const en = await enFlow(browser, base, OUT, errors);
    console.log(`English: ${en.shots.length} screenshots, ${en.report.reduce((a, r) => a + r.shrunk, 0)} texts shrunk to fit, ${en.misses.length} texts without English`);
    await browser.close(); server.close();
    if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
    console.log('E2E OK (en)'); return;
  }
  const clubShots = process.env.E2E_ONLY === 'unity' ? [] : await clubFlow(browser, base, OUT, errors);
  console.log(`club UI: ${clubShots.length} screenshots`);
  if (process.env.E2E_ONLY === 'club') { await browser.close(); server.close(); if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); } return; }
  const { shots, ftue } = await unityFlow(browser, base, OUT, errors);
  fs.writeFileSync(path.join(OUT, 'ftue.json'), JSON.stringify(ftue, null, 2));
  console.log('FTUE (simulated new player, 844×390):');
  for (const m of ftue.marks) console.log(`  ${(m.ms / 1000).toFixed(1).padStart(6)} s  ${String(m.taps).padStart(2)} taps  ${m.step}   (wall ${(m.wallMs / 1000).toFixed(1)} s − capture ${(m.captureMs / 1000).toFixed(1)} − render lag ${(m.lagMs / 1000).toFixed(1)})`);
  console.log(`  taps to home ${ftue.taps} (navigation ${ftue.navTaps} + race ${ftue.raceTaps}); targets: aha ≤ 30 s, gacha ≤ 100 s, home ≤ 240 s, ≤ 15 taps; ${ftue.thinkMs} ms think time before each navigation tap`);
  console.log('  2nd race debrief: ' + ftue.resultLine);
  const n = shots.length;
  const q = await qualityFlow(browser, base, OUT, errors);
  console.log(`Quality integration: place ${q.res.place}, lesson "${q.res.lesson}", peaks ${[...new Set(q.race.fx)].join('/')}`);
  const wk = await firstWeekFlow(browser, base, OUT, errors);
  console.log(`First week (docs/quality/first-week.md): ${wk.shots.length} screenshots`);
  const en = await enFlow(browser, base, OUT, errors);
  console.log(`English (REQ-L10N-013): ${en.shots.length} screenshots, ${en.report.reduce((a, r) => a + r.shrunk, 0)} texts shrunk to fit, ${en.misses.length} texts without English`);
  const a11y = await a11yFlow(browser, base, OUT, errors);
  console.log('Accessibility (REQ-A11Y-005): ' + a11yLine(a11y));
  await browser.close(); server.close();
  if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
  const cs = require('child_process').spawnSync('python3', [path.join(__dirname, 'contact-sheet.py'), OUT], { encoding: 'utf8' });
  if (cs.status === 0) process.stdout.write(cs.stdout);
  console.log(`E2E OK — club ${clubShots.length} + ムチ一閃 ${n} + English ${en.shots.length} + accessibility ${a11y.shots.length} screenshots in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
