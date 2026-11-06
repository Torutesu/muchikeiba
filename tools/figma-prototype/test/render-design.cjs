// Renders Codex's design SVGs that have no PNG export (11–18) to <outDir>/_render_<name>.png for compare.py.
// usage: node render-design.cjs <unity/design/figma-screens> <outDir>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const [src, out] = process.argv.slice(2).map((p) => path.resolve(p));
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.svg'))) {
    if (fs.existsSync(path.join(src, f.replace('.svg', '.png')))) continue;
    await p.goto('file://' + path.join(src, f));
    await p.waitForTimeout(200);
    await p.evaluate(() => { const s = document.querySelector('svg'); s.setAttribute('width', '1600'); s.setAttribute('height', '900'); });
    await p.screenshot({ path: path.join(out, '_render_' + f.replace('.svg', '.png')), clip: { x: 0, y: 0, width: 1600, height: 900 } });
  }
  await b.close();
})();
