const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  const b = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  try {
    const p = await b.newPage({
        viewport: { width: 1440, height: 1100 },
        reducedMotion: "reduce",
      }),
      errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto("http://127.0.0.1:5173/#4");
    await p.evaluate(() => document.fonts.ready);
    await p.locator("#home-inspect").click();
    await p.waitForSelector('[data-model-ready="true"]', { timeout: 60000 });
    await p.locator(".model-canvas").waitFor();
    const before = await p
      .locator(".model-canvas")
      .evaluate((c) => c.toDataURL());
    const box = await p.locator(".model-canvas").boundingBox();
    await p.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, {
      steps: 8,
    });
    await p.mouse.up();
    await p.waitForTimeout(200);
    const after = await p
      .locator(".model-canvas")
      .evaluate((c) => c.toDataURL());
    assert.notEqual(before, after, "drag must change the rendered view");
    await p
      .locator("dialog")
      .screenshot({ path: "/tmp/muchi-showroom-final.png" });
    await p.locator("dialog .close").click();
    await p.locator("dialog").waitFor({ state: "detached" });
    assert.equal(await p.locator(".model-canvas").count(), 0);
    await p.selectOption("#screen-select", "5");
    await p.locator('[data-detail="2"]').click();
    await p.waitForSelector('[data-model-ready="true"]', { timeout: 60000 });
    assert.equal(
      await p
        .locator(".detail-summary .horse-art")
        .getAttribute("data-partner"),
      "2",
    );
    await p.locator("dialog .close").click();
    await p.locator("dialog").waitFor({ state: "detached" });
    await p.emulateMedia({ reducedMotion: "no-preference" });
    await p.selectOption("#screen-select", "7");
    await p.waitForSelector('[data-model-animated="true"]', { timeout: 60000 });
    const first = await p
      .locator(".model-canvas")
      .evaluate((c) => c.toDataURL());
    await p.waitForTimeout(200);
    assert.notEqual(
      first,
      await p.locator(".model-canvas").evaluate((c) => c.toDataURL()),
      "gallop must animate",
    );
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.selectOption("#screen-select", "4");
    await p
      .locator(".app-frame")
      .screenshot({ path: "/tmp/muchi-home-final.png" });
    for (const width of [1440, 844, 390]) {
      await p.setViewportSize({ width, height: 1100 });
      for (let i = 0; i < 10; i++) {
        await p.selectOption("#screen-select", String(i));
        await p
          .locator("img")
          .evaluateAll((images) =>
            Promise.all(images.map((image) => image.decode().catch(() => {}))),
          );
        assert(
          !(await p.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          )),
          `horizontal overflow at ${width}px screen ${i}`,
        );
        const broken = await p
          .locator("img")
          .evaluateAll((images) =>
            images
              .filter((image) => !image.complete || !image.naturalWidth)
              .map((image) => image.src),
          );
        assert.deepEqual(broken, []);
      }
    }
    await p.selectOption("#screen-select", "4");
    await p
      .locator(".app-frame")
      .screenshot({ path: "/tmp/muchi-mobile-final.png" });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: 3D loaded, orbit interaction, animated skinned gallop, variant selection, disposal, all 30 responsive views, all images loaded, no JS errors.",
    );
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
