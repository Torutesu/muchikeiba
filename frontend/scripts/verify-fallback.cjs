const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  const b = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-webgl"],
  });
  try {
    const p = await b.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto("http://127.0.0.1:5173/#4");
    await p.locator("#home-inspect").click();
    await p.waitForSelector('[data-model-ready="fallback"]');
    assert(await p.locator("dialog .horse-art img").isVisible());
    assert.equal(await p.locator("dialog canvas").count(), 0);
    assert(
      (await p.locator("dialog .model-status").textContent()).includes(
        "静止画",
      ),
    );
    await p.locator("dialog .close").click();
    await p.locator("dialog").waitFor({ state: "detached" });
    await p.selectOption("#screen-select", "7");
    await p.waitForSelector('[data-model-ready="fallback"]');
    await p.locator("#lane-out").click();
    assert.equal(await p.locator("#lane-number").textContent(), "3");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: WebGL unavailable uses visible static art and retains controls; no JS errors.",
    );
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
