const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
(async () => {
  const root = path.resolve(__dirname, "../public/creative"),
    manifest = JSON.parse(
      fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
    );
  fs.mkdirSync(path.join(root, "raster"), { recursive: true });
  const cacheFile = path.join(root, "raster/index.json"),
    cache = fs.existsSync(cacheFile)
      ? JSON.parse(fs.readFileSync(cacheFile, "utf8"))
      : {};
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    const contexts = await Promise.all(
      [1, 2].map((deviceScaleFactor) =>
        browser.newContext({ deviceScaleFactor }),
      ),
    );
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    for (const asset of manifest.assets) {
      if (!asset.file.endsWith(".svg")) continue;
      if (
        cache[asset.id]?.sourceSha256 === asset.sha256 &&
        fs.existsSync(path.join(root, cache[asset.id].file))
      ) {
        asset.raster = cache[asset.id];
        continue;
      }
      const scale = Math.max(asset.width, asset.height) > 512 ? 1 : 2,
        page = pages[scale - 1];
      await page.setViewportSize({ width: asset.width, height: asset.height });
      await page.setContent(
        `<html><head><style>*{box-sizing:border-box}html,body{margin:0;background:transparent;width:100%;height:100%}img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><img src="http://127.0.0.1:5173/creative/${asset.file}"></body></html>`,
      );
      await page.locator("img").evaluate((i) => i.decode());
      const file = `raster/${asset.id}${scale === 2 ? "@2x" : ""}.png`;
      await page.screenshot({
        path: path.join(root, file),
        omitBackground: true,
      });
      asset.raster = {
        file,
        width: asset.width * scale,
        height: asset.height * scale,
        pixelRatio: scale,
        sourceSha256: asset.sha256,
      };
      cache[asset.id] = asset.raster;
    }
    const atlas = pages[1];
    await atlas.setViewportSize({ width: 512, height: 320 });
    await atlas.setContent(
      '<html><head><style>html,body{margin:0;background:transparent}img{display:block;width:512px;height:320px}</style></head><body><img src="http://127.0.0.1:5173/creative/atlas/ui-icons.svg"></body></html>',
    );
    await atlas.locator("img").evaluate((i) => i.decode());
    await atlas.screenshot({
      path: path.join(root, "atlas/ui-icons@2x.png"),
      omitBackground: true,
    });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    fs.writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    const template = fs.readFileSync(
      path.join(__dirname, "creative-catalog.html"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "index.html"),
      template
        .replace("__COUNT__", String(manifest.assets.length))
        .replace(
          "__MANIFEST__",
          JSON.stringify(manifest).replaceAll("</", "<\\/"),
        ),
    );
    console.log(
      `Rendered ${manifest.assets.filter((a) => a.raster).length} PNG derivatives + 1024×640 white-alpha atlas.`,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
