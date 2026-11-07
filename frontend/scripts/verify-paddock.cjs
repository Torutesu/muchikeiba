const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
(async () => {
  const b = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  try {
    const p = await b.newPage({
        viewport: { width: 1440, height: 1300 },
        reducedMotion: "reduce",
      }),
      errors = [],
      bad = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("response", (r) => {
      if (r.status() >= 400) bad.push(r.url());
    });
    await p.clock.install({ time: new Date("2026-11-07T14:59:00Z") });
    await p.clock.setFixedTime(new Date("2026-11-07T14:59:00Z"));
    await p.goto("http://localhost:5173/#3");
    await p.evaluate(() => localStorage.clear());
    await p.reload();
    const state = () =>
      p.evaluate(() => JSON.parse(localStorage.getItem("muchi-collection-v1")));
    const screen = (n) => p.selectOption("#screen-select", String(n));
    const close = async () => {
      await p.locator("dialog .close").click();
      await p.locator("dialog").waitFor({ state: "detached" });
    };
    await p.locator("#scout").click();
    await p.locator("#draw-cancel").click();
    assert.equal(await p.locator(".wallet b").first().innerText(), "1,200");
    await p.locator("#scout").click();
    await p.locator("#draw-confirm").click();
    assert.equal(await p.locator(".pull-card").count(), 10);
    assert.equal((await state()).flags.tutorialGachaUsed, true);
    assert((await state()).lastScout.results.some((r) => r.rarity !== "R"));
    await p.locator('[data-reveal="0"]').click();
    assert.equal(await p.locator(".reveal-card.revealed").count(), 1);
    await p.locator("#reveal-all").click();
    assert.equal(await p.locator(".reveal-card.revealed").count(), 10);
    const length = (await state()).horses.length;
    await p.locator("#scout-stable").click();
    assert.equal(await p.locator(".horse-card").count(), length);
    await screen(3);
    await p.locator("#last-scout").click();
    assert.equal((await state()).horses.length, length);
    await close();
    await p.evaluate(async () => {
      (await import("/src/club-state.js")).grantReward("qa-ticket", {
        items: [{ itemId: "ticket_sr_plus", qty: 1 }],
      });
    });
    await p.reload();
    await p.locator("#ticket-scout").click();
    await p.locator("#ticket-sr").click();
    await p.locator("#draw-cancel").click();
    assert.equal(
      await p.evaluate(
        async () =>
          (await import("/src/club-state.js")).readClub().items.ticket_sr_plus,
      ),
      1,
    );
    await p.locator("#ticket-scout").click();
    await p.locator("#ticket-sr").click();
    await p.locator("#draw-confirm").click();
    assert.notEqual((await state()).lastScout.results[0].rarity, "R");
    assert.equal(
      await p.evaluate(
        async () =>
          (await import("/src/club-state.js")).readClub().items
            .ticket_sr_plus || 0,
      ),
      0,
    );
    const order = (await state()).lastScout;
    await p.evaluate(async (id) => {
      (await import("/src/collection.ts")).scout({
        key: id,
        ticket: "ticket_sr_plus",
      });
    }, order.id);
    assert.equal((await state()).lastScout.id, order.id);
    await close();
    await p.evaluate(async () => {
      const c = await import("/src/club-state.js");
      c.replaceDemoWallet(25, 100, c.readClub().items);
    });
    await p.reload();
    await p.locator('[data-scout-count="1"]').click();
    assert.match(
      await p.locator("dialog .spec-list").innerText(),
      /有償 25 \/ 無償 75/,
    );
    await p.locator("#draw-confirm").click();
    await close();
    assert.equal(await p.locator(".wallet b").first().innerText(), "25");
    assert.equal(await p.locator(".club-money b").innerText(), "0");
    await p.locator('[data-scout-count="10"]').click();
    assert(await p.locator("#draw-confirm").isDisabled());
    await close();
    await p.locator("#scout-odds").click();
    assert.equal(
      await p.locator(".odds-table tbody tr").count(),
      require("../../server/master/horses.json").templates.length,
    );
    await p.locator('[data-odds-mode="guarantee"]').click();
    assert(
      (await p.locator(".odds-table .rarity-label").allTextContents()).every(
        (r) => r !== "R",
      ),
    );
    await close();
    // Fixture grants only awakening material. All consumption, retirement and birth below use real UI.
    await p.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("muchi-collection-v1"));
      s.materials.awakening = 5;
      localStorage.setItem("muchi-collection-v1", JSON.stringify(s));
    });
    await screen(5);
    await p.locator('[data-detail="0"]').click();
    await p.locator("#horse-record").click();
    await p.locator("#awaken-confirm").click();
    assert.equal((await state()).horses[0].awakening, 1);
    assert.equal((await state()).materials.awakening, 0);
    assert(await p.locator("#awaken-confirm").isDisabled());
    await close();
    for (const index of [0, 2]) {
      await p.locator(`[data-detail="${index}"]`).click();
      await p.locator("#horse-record").click();
      await p.locator("#retire-review").click();
      assert(await p.locator("#retire-confirm").isDisabled());
      await p.locator("#retire-consent").check();
      await p.locator("#retire-confirm").click();
      assert(await p.locator(`[data-pick="${index}"]`).isDisabled());
    }
    const pair = async () => {
      await p.locator("#breed-tab").click();
      await p.locator("#choose-sire").click();
      await p.locator('[data-parent="h1"]').click();
      await p.locator("#choose-dam").click();
      await p.locator('[data-parent="h3"]').click();
    };
    await pair();
    assert.equal(await p.locator(".forecast-stats > div").count(), 5);
    const forecast = await p.evaluate(async () =>
      (await import("/src/collection.ts")).previewPair("h1", "h3"),
    );
    await p.locator("#breed-review").click();
    await p.locator("#breed-back").click();
    assert.equal(await p.locator(".parent-card").count(), 2);
    await p.locator("#breed-review").click();
    await p.locator("#breed-confirm").click();
    const foal = (await state()).horses.at(-1);
    for (const k of Object.keys(forecast.stats)) {
      assert(foal.base[k] >= forecast.stats[k].min);
      assert(foal.base[k] <= forecast.stats[k].max);
    }
    await p.locator("#foal-name").fill("a");
    assert(await p.locator("#name-foal").isDisabled());
    await p.locator("#foal-name").fill("こもれび");
    await p.locator("#name-foal").click();
    assert.equal((await state()).horses.at(-1).name, "コモレビ");
    await pair();
    assert(await p.locator("#breed-review").isDisabled());
    await close();
    await p.reload();
    assert.equal((await state()).horses.at(-1).name, "コモレビ");
    const childIndex = (await state()).horses.length - 1;
    await p.locator(`[data-detail="${childIndex}"]`).click();
    await p.locator("#detail-select").click();
    await screen(6);
    assert.equal(await p.locator(".entry-side h2").innerText(), "コモレビ");
    await screen(5);
    await p.locator(`[data-detail="${childIndex}"]`).click();
    await p.locator("#horse-record").click();
    await p.locator("#record-pedigree").click();
    assert.match(await p.locator(".pedigree-tree").innerText(), /アカツキ/);
    assert.match(await p.locator(".pedigree-tree").innerText(), /シラナミ/);
    await close();
    await p.clock.setFixedTime(new Date("2026-11-07T15:00:00Z"));
    await pair();
    assert(await p.locator("#breed-review").isEnabled());
    await close();
    fs.mkdirSync("design/campaign/review", { recursive: true });
    for (const width of [1440, 844, 390]) {
      await p.setViewportSize({ width, height: 1100 });
      await screen(3);
      await p.locator("#last-scout").click();
      await p.locator("#reveal-all").click();
      await p.locator("dialog").evaluate((d) => (d.scrollTop = 0));
      assert(
        await p
          .locator("dialog")
          .evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
      );
      await p
        .locator("dialog")
        .screenshot({ path: `design/campaign/review/reveal-${width}.png` });
      await close();
      await screen(5);
      await pair();
      await p.locator("dialog").evaluate((d) => (d.scrollTop = 0));
      assert(
        await p
          .locator("dialog")
          .evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
      );
      await p
        .locator("dialog")
        .screenshot({ path: `design/campaign/review/breeding-${width}.png` });
      await close();
      await p.locator(`[data-detail="${childIndex}"]`).click();
      await p.locator("#horse-record").click();
      await p.locator("dialog").evaluate((d) => (d.scrollTop = 0));
      assert(
        await p
          .locator("dialog")
          .evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
      );
      await p
        .locator("dialog")
        .screenshot({ path: `design/campaign/review/record-${width}.png` });
      await close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(bad, []);
    console.log(
      "PASS: scout confirmation/cancel/reveal/history/guarantee, ticket once-only, paid-first spending and shortage, odds, awakening, retirement, breeding preview/back/birth/name/pedigree/JST limit, new partner selection and 9 responsive views; no JS/resource errors.",
    );
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
