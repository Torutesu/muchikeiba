const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
(async () => {
  const root = path.resolve(__dirname, "../public/creative"),
    m = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(m.assets.length, 112);
  assert.equal(new Set(m.assets.map((a) => a.id)).size, 112);
  for (const a of m.assets) {
    assert(fs.existsSync(path.join(root, a.file)), a.id);
    assert.equal(
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(root, a.file)))
        .digest("hex"),
      a.sha256,
    );
    if (a.file.endsWith(".svg"))
      assert(a.raster && fs.existsSync(path.join(root, a.raster.file)), a.id);
  }
  const b = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    const p = await b.newPage({ viewport: { width: 1440, height: 1200 } }),
      errors = [],
      bad = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("response", (r) => {
      if (r.status() >= 400) bad.push(r.url());
    });
    await p.goto("http://127.0.0.1:5173/creative/index.html");
    await p.evaluate(() => document.fonts.ready);
    assert.equal(await p.locator("article").count(), 112);
    await p.locator('[data-filter="keyart"]').click();
    assert.equal(await p.locator("article").count(), 4);
    await p.locator("#search").fill("greenfield");
    assert.equal(await p.locator("article").count(), 1);
    await p.locator('[data-inspect="greenfield-dawn"]').click();
    assert(await p.locator(".safe").isVisible());
    assert.equal(
      await p.locator(".path input").inputValue(),
      "/creative/keyart/greenfield-dawn.webp",
    );
    await p.keyboard.press("Escape");
    await p.locator("dialog").waitFor({ state: "hidden" });
    await p.locator("#search").fill("");
    await p.locator('[data-filter="frames"]').click();
    await p.locator('[data-inspect="frame-SSR"]').click();
    assert(await p.getByText("44 px", { exact: true }).isVisible());
    assert.equal(
      await p.locator('a[href="raster/frame-SSR@2x.png"]').count(),
      1,
    );
    await p.locator(".dialog-close").click();
    await p.locator('[data-filter="materials"]').click();
    assert.equal(await p.locator("article").count(), 17);
    await p.locator('[data-inspect="material-coat-bay"]').click();
    assert.equal(
      (
        await p.request.get(
          "http://127.0.0.1:5173/creative/materials/club-materials.blend",
        )
      ).status(),
      200,
    );
    assert(await p.getByText("0.46 / 0", { exact: true }).isVisible());
    await p.locator(".dialog-close").click();
    await p.locator('[data-filter="audio"]').click();
    assert.equal(await p.locator("article").count(), 7);
    await p.locator('[data-audio="audio-finish"]').click();
    await p.waitForFunction(
      () =>
        typeof playing !== "undefined" && playing && playing.currentTime > 0,
    );
    await p.locator('[data-inspect="audio-confirm"]').click();
    assert.equal(
      await p.locator("dialog audio").evaluate((a) => a.volume),
      0.18,
    );
    await p.locator(".dialog-close").click();
    await p.locator('[data-filter="motion"]').click();
    await p.locator('[data-motion="motion-loading"]').click();
    assert(await p.locator(".mi-motion-loading").isVisible());
    await p.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await p
        .locator(".mi-motion-loading")
        .evaluate((el) => getComputedStyle(el).animationName),
      "none",
    );
    await p.locator('[data-motion="motion-loading"]').click();
    assert.equal(await p.locator(".mi-motion-loading").count(), 0);
    await p.locator("#search").fill("存在しない素材");
    assert(await p.locator(".empty").isVisible());
    await p.locator("#clear-search").click();
    assert.equal(await p.locator("article").count(), 112);
    for (const width of [1440, 844, 390]) {
      await p.setViewportSize({ width, height: 1200 });
      for (const category of [...new Set(m.assets.map((a) => a.category))]) {
        await p.locator(`[data-filter="${category}"]`).click();
        assert(
          !(await p.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          )),
          `overflow ${width}/${category}`,
        );
        const images = p.locator("article:first-child img");
        if (await images.count())
          await images.first().evaluate((i) => i.decode());
      }
    }
    await p.setViewportSize({ width: 1440, height: 1200 });
    await p.locator('[data-filter="keyart"]').click();
    await p
      .locator("article img")
      .evaluateAll((images) =>
        Promise.all(images.map((image) => image.decode())),
      );
    await p.screenshot({
      path: path.resolve(__dirname, "../design/creative/keyart-review.png"),
      fullPage: true,
    });
    await p.locator('[data-filter="emblems"]').click();
    await p.screenshot({
      path: path.resolve(__dirname, "../design/creative/emblems-review.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(bad, []);
    console.log(
      "PASS: 112 asset hashes, category/search/reset, safe-area inspector, PNG and Blender delivery, audio, motion/reduced-motion, 39 responsive category views; no failed resources or JS errors.",
    );
  } finally {
    await b.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
