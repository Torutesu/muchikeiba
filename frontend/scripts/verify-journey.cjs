const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { events } = require('../../server/master/events.json');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
    const errors = [], bad = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400) bad.push(r.url()); });
    await page.clock.install({ time: new Date('2026-11-06T14:59:59Z') });
    await page.clock.setFixedTime(new Date('2026-11-06T14:59:59Z')); 
    await page.goto('http://127.0.0.1:5173/#4');
    await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.locator('#campaign-open').click(); await page.locator('#claim-welcome').click();
    assert(await page.locator('#claim-welcome').isDisabled());
    assert.equal(await page.locator('.wallet b').first().innerText(), '1,250');
    await page.reload(); await page.locator('#campaign-menu').click();
    assert(await page.locator('#claim-welcome').isDisabled(), 'reload cannot duplicate rewards');
    for (let day = 2; day <= 7; day++) {
      await page.clock.setFixedTime(new Date(Date.parse('2026-11-06T15:00:00Z') + (day - 2) * 2 * 86400000));
      await page.reload(); await page.locator('#campaign-menu').click();
      assert(await page.locator('#claim-welcome').isEnabled());
      await page.locator('#claim-welcome').click();
      assert(await page.locator('#claim-welcome').isDisabled());
      assert.equal(await page.locator('.welcome-days .claimed').count(), day);
    }
    assert.equal(await page.locator('.wallet b').first().innerText(), '1,450');
    for (const [when, expected] of [[events[0].endAtMs, '開催終了'], [events[0].startAtMs-1, '開催予定'], [events[0].startAtMs, '開催期間中']]) {
      await page.clock.setFixedTime(new Date(when)); await page.reload(); await page.locator('#campaign-menu').click();
      assert(await page.locator('#claim-welcome').isDisabled(), 'all seven stay complete');
      await page.locator('[data-campaign-tab="event"]').click();
      assert.equal(await page.locator('.event-status').innerText(), expected);
    }
    await page.locator('dialog .close').click(); await page.selectOption('#screen-select', '9');
    await page.locator('[data-buy-starter]').click();
    assert.match(await page.locator('dialog .spec-list').innerText(), /300/);
    assert.match(await page.locator('dialog .spec-list').innerText(), /SR以上スカウトチケット/);
    await page.locator('#starter-checkout').click();
    assert.match(await page.locator('.checkout-product').innerText(), /480/);
    assert(await page.locator('#purchase-review').isDisabled());
    await page.locator('#birth-detail').fill('2999-01'); await page.locator('#purchase-consent').check();
    assert(await page.locator('#purchase-review').isDisabled());
    await page.locator('#birth-detail').fill('1991-02'); await page.locator('#purchase-review').click();
    assert(await page.locator('.confirmation-mark').isVisible());
    assert.equal(await page.locator('.wallet b').first().innerText(), '1,450');
    assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('1991-02'));
    await page.locator('dialog .close').click(); await page.locator('.coin-card').first().click();
    assert.match(await page.locator('dialog .spec-list').innerText(), /初回購入ボーナス（無償）\s*100 コイン/);
    await page.locator('dialog .close').click();
    fs.mkdirSync('design/campaign/review', { recursive: true });
    for (const width of [1440, 844, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const screen of [0, 2, 4, 8, 9]) {
        await page.selectOption('#screen-select', String(screen));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow ${width}/${screen}`);
      }
      await page.locator('.app-frame').screenshot({ path: `design/campaign/review/store-${width}.png` });
      for (const tab of ['welcome', 'event', 'pass']) {
        await page.locator('#campaign-menu').click(); await page.locator(`[data-campaign-tab="${tab}"]`).click();
        await page.locator('dialog img').evaluateAll(imgs => Promise.all(imgs.map(i => i.decode())));
        if (tab === 'pass') assert(await page.locator('.pass-detail-hero h3').evaluate(el => el.scrollHeight <= parseFloat(getComputedStyle(el).lineHeight) * 2.2), 'pass headline remains two readable lines');
        assert(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `dialog overflow ${width}/${tab}`);
        await page.locator('dialog').screenshot({ path: `design/campaign/review/${tab}-${width}.png` });
        await page.locator('dialog .close').click();
      }
      await page.locator('[data-buy-starter]').click();
      assert(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await page.locator('dialog').evaluate(d => d.scrollTop = d.scrollHeight);
      assert(await page.locator('dialog .close').evaluate(el => { const r=el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'exit remains visible while reading');
      await page.locator('dialog').evaluate(d => d.scrollTop = 0);
      await page.locator('dialog').screenshot({ path: `design/campaign/review/starter-${width}.png` });
      await page.locator('#starter-checkout').click();
      assert(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await page.locator('dialog .close').click();
    }
    const journal = await page.evaluate(() => JSON.parse(localStorage.getItem('muchi-experience-events')));
    assert(journal.some(x => x.event === 'checkout_preview_complete' && x.product === 'starter_pack'));
    assert(journal.every(x => Object.keys(x).every(k => ['event','at','source','product','step','day'].includes(k))));
    assert.deepEqual(errors, []); assert.deepEqual(bad, []);
    console.log('PASS: seven visits/JST midnight/missed days/reload, campaign boundaries, product masters and bonuses, checkout validation/privacy/no grants, 15 pages and 15 dialogs at three sizes; no JS/resource errors.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
