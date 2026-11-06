const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1100 },
        reducedMotion: "reduce",
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:5173");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const screen = (n) => page.selectOption("#screen-select", String(n));
    assert(await page.locator('[data-go="1"]').isDisabled());
    await page.locator("#consent").check();
    await page.locator('[data-go="1"]').click();
    for (let i = 0; i < 4; i++) await page.locator("#whip").click();
    await page.waitForSelector("#horse-name");
    await page.locator("#horse-name").fill("a");
    assert(await page.locator("#save-name").isDisabled());
    await page.locator("#horse-name").fill("ハルカゼ");
    await page.locator("#save-name").click();
    await page.locator("#scout").click();
    assert.equal(await page.locator(".pull-card").count(), 10);
    await page.locator("#finish-scout").click();
    await page.locator("#claim-login").click();
    assert(await page.locator("#claim-login").isDisabled());
    assert.equal(await page.locator(".wallet b").first().innerText(), "1,300");
    await screen(5);
    await page.locator('[data-filter="SSR"]').click();
    assert.equal(await page.locator(".horse-card").count(), 1);
    await page.locator('[data-filter="all"]').click();
    await page.locator("#horse-search").fill("存在しない");
    assert(await page.locator(".empty-state").isVisible());
    await page.locator("#clear-filter").click();
    await page.locator('[data-detail="1"]').click();
    assert.equal(await page.locator(".partner-kit .creative-art").count(), 2);
    await page.locator('[data-tab="skill"]').click();
    assert(await page.locator(".skill-note").isVisible());
    await page.locator("#detail-select").click();
    assert(await page.locator('[data-pick="1"]').isDisabled());
    await screen(6);
    assert.equal(await page.locator(".entry-side h2").innerText(), "コハク");
    await page.locator('.rank-card [data-go="7"]').click();
    await page.locator("#match-cancel").click();
    await page.locator("dialog").waitFor({ state: "detached" });
    await page.locator("#friend").click();
    assert(await page.locator("#join-room").isDisabled());
    await page.locator("#room-code").fill("123456");
    assert(await page.locator("#join-room").isEnabled());
    await page.locator("dialog .close").click();
    await page.locator("dialog").waitFor({ state: "detached" });
    await page.locator('.rank-card [data-go="7"]').click();
    await page.locator("#match-start").click();
    await page.locator("#lane-in").click();
    assert(await page.locator("#lane-in").isDisabled());
    await page.locator("#rein").click();
    assert.equal(await page.locator("#stamina-value").innerText(), "85%");
    for (let i = 0; i < 4; i++) await page.locator("#whip").click();
    await page.waitForSelector("#claim-race");
    const resultNames = await page
      .locator(".standings tbody tr td:nth-child(2)")
      .allTextContents();
    assert.equal(
      new Set(resultNames.map((n) => n.replace("YOU", "").trim())).size,
      4,
    );
    await page.locator("#claim-race").click();
    assert(await page.locator("#claim-race").isDisabled());
    assert.equal(await page.locator(".wallet b").first().innerText(), "2,100");
    await page.reload();
    assert(await page.locator("#claim-race").isDisabled());
    assert.equal(await page.locator(".wallet b").first().innerText(), "2,100");
    await screen(4);
    assert(await page.locator("#claim-daily").isEnabled());
    await page.locator("#claim-daily").click();
    assert(await page.locator("#claim-daily").isDisabled());
    assert.equal(await page.locator(".wallet b").first().innerText(), "2,300");
    await screen(9);
    await page.locator("#collection-preview").click();
    await page.locator('[data-silks="2"]').click();
    assert.equal(await page.locator('[data-silks="2"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-silks="0"]').getAttribute("aria-pressed"), "false");
    assert.match(await page.locator(".collection-selection").innerText(), /ヴァイオレット/);
    for (const width of [390, 844, 1440]) {
      await page.setViewportSize({ width, height: 1100 });
      assert(await page.locator("dialog").evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      assert(await page.locator(".collection-items img").evaluateAll(imgs => imgs.every(i => i.complete && i.naturalWidth > 0)));
    }
    await page.locator("dialog .close").click();
    await page.locator("dialog").waitFor({ state: "detached" });

    await page.locator(".coin-card").first().click();
    assert(await page.locator("#purchase-review").isDisabled());
    await page.locator("#birth-detail").fill("2999-01");
    await page.locator("#purchase-consent").check();
    assert(await page.locator("#purchase-review").isDisabled());
    await page.locator("#birth-detail").fill("2000-01");
    assert(await page.locator("#purchase-review").isEnabled());
    await page.locator("#purchase-review").click();
    assert(await page.locator(".confirmation-mark").isVisible());
    assert.equal(await page.locator("dialog").count(), 1);
    await page.locator("dialog .close").click();
    await page.locator("dialog").waitFor({ state: "detached" });
    for (const width of [1440, 844, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      for (let i = 0; i < 10; i++) {
        await screen(i);
        assert(
          !(await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          )),
          `overflow ${width} screen ${i}`,
        );
      }
    }
    // Stored display names must not become HTML on the next visit.
    await page.evaluate(() =>
      localStorage.setItem(
        "muchi-horse",
        '<img src=x onerror="window.injected=true">',
      ),
    );
    await page.reload();
    await screen(5);
    assert.equal(await page.locator('.horse-card img[src="x"]').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: onboarding, validation, scout, rewards/reload, filters, horse details/selection, matching/cancel, friend input, race controls, purchase review, 30 responsive screens, escaped names; no browser errors.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
