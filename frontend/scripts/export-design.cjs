const { chromium } = require("playwright");
const fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1400 },
        reducedMotion: "reduce",
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:5173");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const titles = [
        "はじめに",
        "初めての直線",
        "相棒の命名",
        "無料スカウト",
        "ホーム",
        "厩舎",
        "出走登録",
        "レース",
        "リザルト",
        "ショップ",
      ],
      outputs = [];
    fs.mkdirSync("design/screens", { recursive: true });
    async function capture(name, title, selector = ".app-frame") {
      const target = page.locator(selector);
      await page.evaluate(() => document.fonts.ready);
      await target
        .locator("img")
        .evaluateAll((imgs) =>
          Promise.all(imgs.map((i) => i.decode().catch(() => {}))),
        );
      await target.evaluate(el => { if (el.tagName === "DIALOG") el.scrollTop = 0; });
      await target.scrollIntoViewIfNeeded();
      if (await target.locator(".model-canvas").count())
        await page.waitForFunction(() =>
          [...document.querySelectorAll(".showroom-container")].every(
            (el) => el.dataset.modelReady,
          ),
        );
      const out = await target.evaluate(async (root) => {
        const box = root.getBoundingClientRect(),
          shapes = [];
        let serial = 0;
        const imageData = new Map();
        const dataFor = async (src) => {
          if (!imageData.has(src)) {
            const blob = await (await fetch(src)).blob();
            const data = await new Promise((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result);
              r.readAsDataURL(blob);
            });
            imageData.set(src, data);
          }
          return imageData.get(src);
        };
        const all = [root, ...root.querySelectorAll("*")];
        await Promise.all(
          all.flatMap((el) => {
            const urls = [];
            if (el.tagName === "IMG") urls.push(el.src);
            for (const pseudo of [null, "::before", "::after"]) {
              const s = getComputedStyle(el, pseudo);
              for (const match of s.backgroundImage.matchAll(
                /url\(["']?([^"')]+)["']?\)/g,
              ))
                urls.push(match[1]);
            }
            return urls.map(dataFor);
          }),
        );
        const splitArgs = (text) => {
          const args = [];
          let level = 0,
            last = 0;
          for (let i = 0; i < text.length; i++) {
            if (text[i] === "(") level++;
            if (text[i] === ")") level--;
            if (text[i] === "," && level === 0) {
              args.push(text.slice(last, i).trim());
              last = i + 1;
            }
          }
          args.push(text.slice(last).trim());
          return args;
        };
        const background = (s, x, y, w, h) => {
          if (s.backgroundImage === "none") return;
          const layers = splitArgs(s.backgroundImage);
          for (const layer of layers.reverse()) {
            const url = layer.match(/url\(["']?([^"')]+)["']?\)/);
            if (url) {
              shapes.push(
                `<image href="${imageData.get(url[1])}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" opacity="${s.opacity}"/>`,
              );
              continue;
            }
            if (!layer.includes("gradient(")) continue;
            const radial = layer.startsWith("radial"),
              args = splitArgs(layer.slice(layer.indexOf("(") + 1, -1));
            let angle = 180;
            if (!/^(rgb|#|transparent|[a-z]+$)/.test(args[0])) {
              angle = parseFloat(args.shift()) || 180;
            } else if (
              args[0].startsWith("ellipse") ||
              args[0].startsWith("circle")
            )
              args.shift();
            const colors = args.filter((c) => /^(rgb|#|transparent)/.test(c));
            if (!colors.length) continue;
            const id = "bg-" + ++serial,
              rad = (angle * Math.PI) / 180;
            const stops = colors
              .map((c, i) => {
                const pos = c.match(/\s([\d.]+)%$/),
                  color = c.replace(/\s[\d.]+%$/, "");
                return `<stop offset="${pos ? pos[1] : (i / Math.max(1, colors.length - 1)) * 100}%" stop-color="${color}"/>`;
              })
              .join("");
            const tag = radial ? "radialGradient" : "linearGradient",
              attrs = radial
                ? 'cx="50%" cy="50%" r="75%"'
                : `x1="${50 - Math.sin(rad) * 50}%" y1="${50 + Math.cos(rad) * 50}%" x2="${50 + Math.sin(rad) * 50}%" y2="${50 - Math.cos(rad) * 50}%"`;
            shapes.push(
              `<defs><${tag} id="${id}" ${attrs}>${stops}</${tag}></defs><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id})" opacity="${s.opacity}"/>`,
            );
          }
        };

        const esc = (s) =>
          String(s).replace(
            /[&<>"']/g,
            (c) =>
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              })[c],
          );
        const visible = (s) => s !== "rgba(0, 0, 0, 0)" && s !== "transparent";
        function walk(el) {
          const s = getComputedStyle(el),
            r = el.getBoundingClientRect(),
            x = r.x - box.x,
            y = r.y - box.y;
          if (
            s.display === "none" ||
            s.visibility === "hidden" ||
            !r.width ||
            !r.height
          )
            return;
          if (el.tagName === "IMG") {
            shapes.push(
              `<image href="${imageData.get(el.src)}" x="${x}" y="${y}" width="${r.width}" height="${r.height}" preserveAspectRatio="xMidYMid ${s.objectFit === "cover" ? "slice" : "meet"}" opacity="${s.opacity}"/>`,
            );
            return;
          }
          if (el.tagName === "CANVAS") {
            try {
              shapes.push(
                `<image href="${el.toDataURL("image/png")}" x="${x}" y="${y}" width="${r.width}" height="${r.height}"/>`,
              );
            } catch {}
            return;
          }
          if (el.tagName.toLowerCase() === "svg") {
            let markup = el.innerHTML;
            const suffix = "-export-" + ++serial,
              ids = [...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
            for (const id of ids)
              markup = markup
                .replaceAll(`id="${id}"`, `id="${id + suffix}"`)
                .replaceAll(`url(#${id})`, `url(#${id + suffix})`);
            shapes.push(
              `<svg x="${x}" y="${y}" width="${r.width}" height="${r.height}" viewBox="${el.getAttribute("viewBox") || "0 0 640 440"}" color="${s.color}" fill="${el.getAttribute("fill") || "none"}" stroke="${el.getAttribute("stroke") || "none"}" stroke-width="${el.getAttribute("stroke-width") || 1}">${markup}</svg>`,
            );
            return;
          }
          const clipped = s.overflow === "hidden" || s.overflow === "clip";
          if (clipped) {
            const id = "clip-" + ++serial;
            shapes.push(
              `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${r.width}" height="${r.height}" rx="${Math.min(parseFloat(s.borderRadius) || 0, r.width / 2, r.height / 2)}"/></clipPath></defs><g clip-path="url(#${id})">`,
            );
          }
          if (visible(s.backgroundColor) || parseFloat(s.borderWidth) > 0)
            shapes.push(
              `<rect x="${x}" y="${y}" width="${r.width}" height="${r.height}" rx="${Math.min(parseFloat(s.borderRadius) || 0, r.width / 2, r.height / 2)}" fill="${visible(s.backgroundColor) ? s.backgroundColor : "none"}" stroke="${parseFloat(s.borderWidth) > 0 ? s.borderColor : "none"}" stroke-width="${parseFloat(s.borderWidth) || 0}" opacity="${s.opacity}"/>`,
            );
          background(s, x, y, r.width, r.height);
          const before = getComputedStyle(el, "::before");
          if (before.content !== "none")
            background(before, x, y, r.width, r.height);
          for (const node of el.childNodes) {
            if (node.nodeType === 1) walk(node);
            else if (node.nodeType === 3 && node.textContent.trim()) {
              const lines = [];
              let line = null;
              for (let i = 0; i < node.textContent.length; i++) {
                const range = document.createRange();
                range.setStart(node, i);
                range.setEnd(node, i + 1);
                const q = range.getBoundingClientRect();
                if (!q.width && !q.height) continue;
                if (!line || Math.abs(q.y - line.y) > 2) {
                  line = { x: q.x, y: q.y, text: "" };
                  lines.push(line);
                }
                line.text += node.textContent[i];
              }
              for (const l of lines)
                shapes.push(
                  `<text x="${l.x - box.x}" y="${l.y - box.y + parseFloat(s.fontSize) * 0.86}" fill="${s.color}" font-family="${esc(s.fontFamily)}" font-size="${s.fontSize}" font-weight="${s.fontWeight}" font-style="${s.fontStyle}" letter-spacing="${s.letterSpacing === "normal" ? 0 : s.letterSpacing}" opacity="${s.opacity}">${esc(l.text)}</text>`,
                );
            }
          }
          if (["INPUT", "SELECT"].includes(el.tagName)) {
            const t =
              el.tagName === "SELECT"
                ? el.selectedOptions[0]?.text
                : el.type === "checkbox"
                  ? el.checked
                    ? "✓"
                    : "□"
                  : el.value || el.placeholder;
            shapes.push(
              `<text x="${x + parseFloat(s.paddingLeft) + 4}" y="${y + r.height / 2 + parseFloat(s.fontSize) * 0.35}" fill="${s.color}" font-size="${s.fontSize}" font-family="sans-serif">${esc(t || "")}</text>`,
            );
          }
          if (clipped) shapes.push("</g>");
        }
        walk(root);
        return {
          body: shapes.join("\n"),
          w: Math.ceil(box.width),
          h: Math.ceil(box.height),
        };
      });
      for (const id of [...out.body.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
        out.body = out.body
          .replaceAll(`id="${id}"`, `id="${name}-${id}"`)
          .replaceAll(`url(#${id})`, `url(#${name}-${id})`);
      fs.writeFileSync(
        `design/screens/${name}.svg`,
        `<svg xmlns="http://www.w3.org/2000/svg" width="${out.w}" height="${out.h}" viewBox="0 0 ${out.w} ${out.h}"><title>${title}</title>${out.body}</svg>`,
      );
      await target.screenshot({ path: `design/screens/${name}.png` });
      outputs.push({ name, title, ...out });
    }
    const screen = (n) => page.selectOption("#screen-select", String(n));
    for (let i = 0; i < 10; i++) {
      await screen(i);
      await capture(String(i + 1).padStart(2, "0"), titles[i]);
    }
    const close = async () => {
      await page.locator("dialog .close").click();
      await page.locator("dialog").waitFor({ state: "detached" });
    };
    await screen(5);
    await page.locator('[data-detail="0"]').click();
    await capture("11-horse-stats", "馬詳細・能力", "dialog");
    await page.locator('[data-tab="skill"]').click();
    await capture("12-horse-skill", "馬詳細・スキルと適性", "dialog");
    await close();
    await page.locator("#horse-search").fill("該当なし");
    await capture("13-stable-empty", "厩舎・検索結果なし");
    await page.locator("#clear-filter").click();
    await page.locator("#breed-tab").click();
    await capture("14-breeding", "配合・開放条件", "dialog");
    await close();
    await screen(6);
    await page.locator('.rank-card [data-go="7"]').click();
    await capture("15-race-ready", "出走確認", "dialog");
    await close();
    await page.locator("#friend").click();
    await capture("16-friend-room", "フレンドルーム", "dialog");
    await close();
    await screen(3);
    await page.locator("#scout").click();
    await capture("17-scout-results", "スカウト10頭結果", "dialog");
    await page.locator("#finish-scout").click();
    await page.locator("dialog").waitFor({ state: "detached" });
    await screen(3);
    await page.locator("#rates").click();
    await capture("18-scout-info", "提供内容", "dialog");
    await close();
    await screen(9);
    await page.locator(".coin-card").first().click();
    await capture("19-purchase-review", "商品・年齢確認", "dialog");
    await page.locator("#birth-detail").fill("2000-01");
    await page.locator("#purchase-consent").check();
    await page.locator("#purchase-review").click();
    await capture("20-purchase-complete", "購入確認完了", "dialog");
    await close();
    await screen(4);
    await page.locator("#claim-login").click();
    await page
      .locator(".toast")
      .evaluateAll((els) => els.forEach((el) => el.remove()));
    await capture("21-home-claimed", "ホーム・報酬受取済み");
    await screen(2);
    await page.locator("#horse-name").fill("a");
    await capture("22-name-error", "命名・入力エラー");
    await page.setViewportSize({ width: 390, height: 1000 });
    for (const [i, name] of [
      [4, "23-mobile-home"],
      [5, "24-mobile-stable"],
      [7, "25-mobile-race"],
    ]) {
      await screen(i);
      await capture(name, titles[i] + "・モバイル");
    }
    await page.setViewportSize({ width: 1440, height: 1400 });
    await screen(4);
    await page.locator("#home-inspect").click();
    await page.waitForSelector('[data-model-ready="true"]', { timeout: 60000 });
    await capture("26-3d-showroom", "相棒・3Dショールーム", "dialog");
    await close();
    await page.locator("#club-guide").click();
    await capture("27-club-guide", "クラブガイド", "dialog");
    await close();
    await page.setViewportSize({ width: 390, height: 1000 });
    await screen(5);
    await page.locator('[data-detail="1"]').click();
    await capture("28-mobile-partner", "馬詳細・モバイル", "dialog");
    await close();
    await page.setViewportSize({ width: 1440, height: 1400 });
    await screen(3);
    await capture("29-scout-received", "スカウト・初回受取済み");
    await screen(9);
    await page.locator("#collection-preview").click();
    await capture("30-season-collection", "シーズン衣装・コレクション", "dialog");
    await close();
    await page.evaluate(() => localStorage.setItem("muchi-journey-v1", JSON.stringify({ steps: ["ride", "name", "scout", "win"], days: [] })));
    await screen(4);
    await capture("31-journey-complete", "初回4章完了・ホーム");
    await page.locator("#campaign-open").click();
    await capture("32-welcome-gifts", "7日間の無料ギフト", "dialog");
    await page.locator("#claim-welcome").click();
    await page.locator(".toast").evaluateAll(els => els.forEach(e => e.remove()));
    await capture("33-welcome-claimed", "無料ギフト・本日受取済み", "dialog");
    await page.locator('[data-campaign-tab="event"]').click();
    await capture("34-event-campaign", "イベント・条件と目標", "dialog");
    await page.locator('[data-campaign-tab="pass"]').click();
    await capture("35-club-pass", "30日クラブパス・比較", "dialog");
    await close();
    await screen(9);
    await page.locator('[data-buy-starter]').click();
    await capture("36-starter-product", "スターター・商品詳細", "dialog");
    await page.locator("#starter-checkout").click();
    await capture("37-starter-checkout", "スターター・価格確認", "dialog");
    await close();
    await page.setViewportSize({ width: 390, height: 1100 });
    await page.locator("#campaign-menu").click();
    await capture("38-mobile-welcome", "無料ギフト・モバイル", "dialog");
    await page.locator('[data-campaign-tab="pass"]').click();
    await capture("39-mobile-pass", "クラブパス・モバイル", "dialog");
    await close();
    await page.locator('[data-buy-starter]').click();
    await capture("40-mobile-starter", "スターター・モバイル", "dialog");
    await close();
    await page.setViewportSize({ width: 1440, height: 1400 });
    // Explicit design fixtures in an isolated browser context for earned-state variants.
    await page.evaluate(async () => {
      const { readClub } = await import("/src/club-state.js");
      const s = readClub();
      Object.assign(s, { items: { ...s.items, costume_login: 1, costume_starter: 1, costume_season_limited: 1, breeding_material: 4, ticket_sr_plus: 1 }, paid: 300, xp: 100, completed: 8, passUntil: Date.now() + 30*86400000, outfits: { 0: "costume_starter" }, freeLevels: [1], premiumLevels: [], eventPoints: { sprint_cup_2026_11: 330 } });
      localStorage.setItem("muchi-club-v1", JSON.stringify(s));
    });
    await screen(4);
    await page.locator("#club-open").click();
    await page.locator("#wardrobe-partner").selectOption("0");
    await page.waitForSelector('.wardrobe-model [data-model-ready="true"]', { timeout: 60000 });
    await capture("41-wardrobe", "勝負服・3D配色プレビュー", "dialog");
    await page.locator('[data-club-tab="items"]').click();
    await capture("42-inventory", "所持品・デモ受取一覧", "dialog");
    await close();
    await page.locator("#campaign-menu").click();
    await page.locator('[data-campaign-tab="pass"]').click();
    await capture("43-pass-progress", "完走XP・パス報酬の受取", "dialog");
    await page.locator('[data-campaign-tab="event"]').click();
    await capture("44-event-progress", "イベント累積・目標報酬", "dialog");
    await page.locator("#event-enter").click();
    await capture("45-event-entry", "イベント出走登録・参加費");
    await page.setViewportSize({ width: 390, height: 1100 });
    await page.locator("#club-open").click();
    await page.locator("#wardrobe-partner").selectOption("0");
    await page.waitForSelector('.wardrobe-model [data-model-ready="true"]', { timeout: 60000 });
    await capture("46-mobile-wardrobe", "勝負服・モバイル", "dialog");
    await page.locator('[data-club-tab="items"]').click();
    await capture("47-mobile-inventory", "所持品・モバイル", "dialog");
    await close();
    await page.locator("#campaign-menu").click();
    await page.locator('[data-campaign-tab="pass"]').click();
    await capture("48-mobile-pass-progress", "パス進行・モバイル", "dialog");
    await close();
    await page.setViewportSize({ width: 1440, height: 1400 });
    let y = 80;
    const groups = [];
    for (let i = 0; i < outputs.length; i += 2) {
      for (let j = i; j < Math.min(i + 2, outputs.length); j++) {
        const s = outputs[j];
        groups.push(
          `<g transform="translate(${40 + (j % 2) * 1460},${y})"><text y="-20" fill="#183b30" font-family="sans-serif" font-size="20">${s.name} / ${s.title}</text><svg width="${s.w}" height="${s.h}">${s.body}</svg></g>`,
        );
      }
      y += Math.max(...outputs.slice(i, i + 2).map((s) => s.h)) + 100;
    }
    fs.writeFileSync(
      "design/screens.svg",
      `<svg xmlns="http://www.w3.org/2000/svg" width="2960" height="${y}"><rect width="2960" height="${y}" fill="#e5e6df"/>${groups.join("\n")}</svg>`,
    );
    fs.mkdirSync("public/design", { recursive: true });
    fs.copyFileSync("design/screens.svg", "public/design/screens.svg");
    fs.writeFileSync(
      "design/screens/manifest.json",
      JSON.stringify(
        outputs.map(({ name, title, w, h }) => ({
          name,
          title,
          width: w,
          height: h,
        })),
        null,
        2,
      ),
    );
    if (errors.length) throw Error(errors.join("\n"));
    console.log(
      `Exported ${outputs.length} SVG + PNG screens; no browser errors.`,
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
