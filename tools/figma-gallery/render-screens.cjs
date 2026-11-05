// Renders Codex's Figma screen SVGs (unity/design/figma-screens/*.svg) to JPEG with the preinstalled Chromium.
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const [src, out] = process.argv.slice(2);
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const files = fs.readdirSync(src).filter((f) => f.endsWith('.svg')).sort();
  for (const f of files) {
    await page.goto('file://' + path.resolve(src, f));
    await page.waitForTimeout(150);
    await page.evaluate(() => { const s = document.querySelector('svg'); if (s) { s.setAttribute('width', '1280'); s.setAttribute('height', '720'); } document.body && (document.body.style.margin = '0'); });
    await page.screenshot({ path: path.join(out, f.replace('.svg', '.jpg')), type: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: 1280, height: 720 } });
  }
  await browser.close();
  console.log('rendered', files.length);
})();
