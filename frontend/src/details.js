import { readClub } from "./club-state.js";
import { mountClub, openWardrobe } from "./club-ui.js";
import { icon } from "./icons.js";
import { openCheckout } from "./commerce.js";
import { mountJourney, track } from "./journey.js";
// Detailed UI interactions are local previews; no server, payment or random draw is invoked.
const safe = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const stored = read("muchi-detail-v1", {});
const profile = {
  claimed: Array.isArray(stored.claimed) ? stored.claimed : [],
  scouted: stored.scouted === true,
  raced: stored.raced === true,
  day: stored.day,
};
if (profile.day !== today) {
  profile.day = today;
  profile.claimed = [];
  profile.raced = false;
}
const save = () =>
  localStorage.setItem("muchi-detail-v1", JSON.stringify(profile));
let filter = "all",
  query = "",
  sort = "rating",
  lane = 2,
  stamina = 80,
  raceReward = read("muchi-race-reward", false) === true;
const stats = [
  [94, 86, 91, 88],
  [88, 94, 76, 90],
  [86, 79, 96, 82],
];
const skills = [
  ["直線の一閃", "最後の直線で伸びる、差し脚が持ち味。"],
  ["好位のリズム", "序盤から好位置を取りやすい先行タイプ。"],
  ["ラストスパート", "脚をためて、後方から長い末脚を使う。"],
];
const meter = (label, value) =>
  `<div class="stat-line"><span>${label}</span><div class="meter"><i style="width:${value}%"></i></div><b>${value}</b></div>`;
const creative = (file, cls = "", alt = "") =>
  `<img class="creative-art ${cls}" src="/creative/${file}" alt="${alt}" width="128" height="128" draggable="false">`;
const silks = ["crimson", "azure", "violet"];
const badge = (text) => `<span class="status-pill">${text}</span>`;
const bind = (root, selector, fn) =>
  root.querySelectorAll(selector).forEach((el) => (el.onclick = () => fn(el)));
function dialog(title, body) {
  document.querySelectorAll("dialog").forEach((previous) => {
    previous.close();
    previous.remove();
  });
  const d = document.createElement("dialog");
  d.className = "detail-dialog";
  d.setAttribute("aria-label", title);
  d.innerHTML = `<button class="close" aria-label="閉じる">${icon("close")}</button><div class="eyebrow"><span></span>MUCHI ISSEN / CLUB GUIDE</div><h2>${title}</h2>${body}`;
  document.body.append(d);
  d.querySelector(".close").onclick = () => d.close();
  d.addEventListener("close", () => d.remove());
  d.showModal();
  return d;
}
export function enhance(ctx) {
  const {
    app,
    current,
    horses,
    selected,
    horse,
    coins,
    horseArt,
    go,
    toast,
    selectHorse,
  } = ctx;
  const names = horses.map((h, i) => (i === 0 ? horse : h[0])),
    chosen = names[selected],
    rivals = names.filter((_, i) => i !== selected),
    content = app.querySelector("main");
  if (current === 0) {
    const consent = app.querySelector("#consent"),
      start = app.querySelector('[data-go="1"]');
    consent.checked = false;
    start.disabled = true;
    consent.onchange = () => (start.disabled = !consent.checked);
    app
      .querySelector(".intro .quiet")
      .insertAdjacentHTML(
        "afterend",
        '<div class="intro-steps"><span><b>01</b> 走ってみる</span><span><b>02</b> 相棒に出会う</span><span><b>03</b> クラブへ</span></div>',
      );
  }
  if (current === 2) {
    const input = app.querySelector("#horse-name"),
      help = app.querySelector("#name-help"),
      button = app.querySelector("#save-name");
    input.setAttribute("aria-describedby", "name-help");
    const validate = () => {
      const n = Array.from(input.value.trim()).length,
        invalid = n < 2 || n > 12 || /[<>]/.test(input.value);
      help.textContent = invalid
        ? "2〜12文字で入力してください。記号 < > は使用できません。"
        : `${n} / 12文字 · あとから変更できます。`;
      help.classList.toggle("field-error", invalid);
      input.setAttribute("aria-invalid", String(invalid));
      button.disabled = invalid;
    };
    input.oninput = validate;
    validate();
  }
  if (current === 4) {
    app.querySelector(".home-hero h2").textContent = chosen;
    app.querySelector(".home-hero .tag").textContent =
      "YOUR PARTNER · " + horses[selected][1];
    app
      .querySelector(".home-hero>.horse-art")
      .classList.add("variant-" + selected);
    app.querySelector(".home-hero p").textContent =
      "調子は良好。次の一戦に備えよう。";
    app.querySelector(".horse-meta").innerHTML =
      `<span>${horses[selected][2]}</span><span>${horses[selected][3]}</span><span>総合 ${horses[selected][4]}</span>`;
    const completed = profile.claimed.length;
    app.querySelector("#daily b").textContent =
      completed === 2 ? "今日の報酬は受取済み" : "今日の報酬を確認する";
    app.querySelector("#daily i").textContent = completed + " / 2";
    content
      .querySelector("nav")
      .insertAdjacentHTML(
        "beforebegin",
        `<section class="club-dashboard"><div class="panel"><div class="section-caption"><h2>今日のクラブノート</h2>${badge("デイリー")}</div><div class="mission-row"><div><b>ログインする</b><small>無償コイン ×100</small></div><button class="small-button" id="claim-login" ${profile.claimed.includes("login") ? "disabled" : ""}>${profile.claimed.includes("login") ? "受取済み" : "受け取る"}</button></div><div class="mission-row"><div><b>レースに1回出走する</b><small>無償コイン ×200 · ${profile.raced ? "1" : "0"} / 1</small></div><button class="small-button" id="claim-daily" ${!profile.raced || profile.claimed.includes("daily") ? "disabled" : ""}>${profile.claimed.includes("daily") ? "受取済み" : profile.raced ? "受け取る" : "挑戦中"}</button></div></div><div class="panel season-panel"><div class="section-caption"><h2>シーズンの記録</h2><span>01 / NOVEMBER</span></div><strong>ブロンズ II <small>→ ブロンズ I</small></strong><div class="meter"><i style="width:60%"></i></div><p>360 / 600 pt <span>あと240 ptで昇級</span></p><div class="season-summary"><span>出走 <b>12</b></span><span>勝利 <b>4</b></span><span>最高着順 <b>1位</b></span></div></div></section>`,
      );
    const claim = (key, amount) => {
      if (profile.claimed.includes(key)) return;
      profile.claimed.push(key);
      save();
      ctx.addCoins(amount);
      toast(`無償コイン ${amount} を受け取りました`);
    };
    app.querySelector("#claim-login").onclick = () => claim("login", 100);
    app.querySelector("#claim-daily").onclick = () => {
      if (profile.raced) claim("daily", 200);
    };
    app.querySelector("#daily").onclick = () =>
      app
        .querySelector(".club-dashboard")
        .scrollIntoView({ behavior: "smooth", block: "center" });
  }
  if (current === 5) {
    const grid = app.querySelector(".horse-grid");
    grid.insertAdjacentHTML(
      "beforebegin",
      `<div class="stable-tools"><label class="search-field">${icon("search")}<input id="horse-search" type="search" placeholder="相棒の名前で検索" aria-label="相棒の名前で検索" value="${safe(query)}"></label><div class="filter-group" aria-label="レアリティで絞り込み">${[
        ["all", "すべて"],
        ["SSR", "SSR"],
        ["SR", "SR"],
      ]
        .map(
          ([v, l]) =>
            `<button data-filter="${v}" aria-pressed="${filter === v}">${l}</button>`,
        )
        .join(
          "",
        )}</div><label class="sort-field">並び順 <select id="horse-sort"><option value="rating">総合評価順</option><option value="name">名前順</option></select></label></div>`,
    );
    const paint = () => {
      const list = horses
        .map((h, i) => ({ h, i }))
        .filter(
          ({ h, i }) =>
            (filter === "all" || h[1] === filter) && names[i].includes(query),
        )
        .sort((a, b) =>
          sort === "name"
            ? names[a.i].localeCompare(names[b.i], "ja")
            : Number(b.h[4]) - Number(a.h[4]),
        );
      grid.innerHTML =
        list
          .map(
            ({ h, i }) =>
              `<article class="horse-card rarity-${h[1].toLowerCase()} ${i === selected ? "chosen" : ""}"><div class="card-top"><span>${h[1]}</span><small>${i === selected ? "● 出走馬に選択中" : "PARTNER / 0" + (i + 1)}</small></div>${horseArt("variant-" + i)}<h2>${safe(names[i])}</h2><p>${h[2]}<span>${h[3]}</span></p>${meter("スピード", stats[i][0])}${meter("スタミナ", stats[i][2])}<div class="rating">TOTAL RATING <b>${h[4]}</b></div><div class="card-actions"><button class="small-button" data-detail="${i}">能力・スキル</button><button class="small-button filled" data-pick="${i}" ${selected === i ? "disabled" : ""}>${selected === i ? "選択中" : "出走馬にする"}</button></div></article>`,
          )
          .join("") ||
        `<div class="empty-state">${creative("states/search-empty.svg", "state-art")}<h2>相棒が見つかりません</h2><p>名前や絞り込み条件を変えてみてください。</p><button class="small-button" id="clear-filter">条件をクリア</button></div>`;
      bind(grid, "[data-pick]", (el) => selectHorse(Number(el.dataset.pick)));
      bind(grid, "[data-detail]", (el) =>
        horseDetail(Number(el.dataset.detail)),
      );
      if (grid.querySelector("#clear-filter"))
        grid.querySelector("#clear-filter").onclick = () => {
          query = "";
          filter = "all";
          ctx.refresh();
        };
    };
    app.querySelector("#horse-search").oninput = (e) => {
      query = e.target.value;
      paint();
    };
    app.querySelector("#horse-sort").value = sort;
    app.querySelector("#horse-sort").onchange = (e) => {
      sort = e.target.value;
      paint();
    };
    bind(app, "[data-filter]", (el) => {
      filter = el.dataset.filter;
      app
        .querySelectorAll("[data-filter]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
      paint();
    });
    paint();
    app.querySelector("#breed-tab").onclick = () =>
      dialog(
        "次の世代へ、物語をつなぐ。",
        '<div class="locked-feature"><img class="state-art" src="/creative/states/breeding-locked.svg" alt="" width="180" height="140"><h3>配合は、クラブ2日目に開放</h3><p>引退した父馬と母馬から、適性や個性を引き継ぎます。</p></div><ol class="guide-list"><li>父馬と母馬を選ぶ</li><li>血統と相性を確認する</li><li>新しい相棒を迎える</li></ol><p class="quiet">現在は画面プレビューです。配合処理は行いません。</p>',
      );
  }
  function horseDetail(i) {
    const d = dialog(
      safe(names[i]),
      `<div class="detail-summary">${horseArt("variant-" + i)}<div>${badge(horses[i][1] + " / " + horses[i][2])}<p>${horses[i][3]} · 総合評価 ${horses[i][4]}</p><div class="detail-tabs"><button data-tab="stats" aria-pressed="true">能力</button><button data-tab="skill" aria-pressed="false">スキル・適性</button></div><div id="detail-body"></div></div></div><section class="partner-kit" aria-label="相棒の装い"><div>${creative("items/silks-" + silks[i] + ".svg")}<span>RACING SILKS<b>${["クリムゾン", "アズール", "ヴァイオレット"][i]}</b><small>モデルに合わせた勝負服</small></span></div><div>${creative("items/saddlecloth-ivory.svg")}<span>SADDLECLOTH<b>アイボリー</b><small>クラブ共通のゼッケン</small></span></div></section><button class="primary" id="detail-select" ${i === selected ? "disabled" : ""}>${i === selected ? "出走馬に選択中" : "この相棒で出走する"}<span>↗</span></button>`,
    );
    const paint = (t) => {
      d.querySelector("#detail-body").innerHTML =
        t === "stats"
          ? ["スピード", "加速", "スタミナ", "折り合い"]
              .map((l, j) => meter(l, stats[i][j]))
              .join("")
          : `<div class="skill-note"><b>✧ ${skills[i][0]}</b><p>${skills[i][1]}</p></div><dl class="spec-list"><div><dt>芝適性</dt><dd>A</dd></div><div><dt>得意距離</dt><dd>${horses[i][3].split(" / ")[1]}</dd></div><div><dt>脚質</dt><dd>${horses[i][2]}</dd></div></dl>`;
    };
    const wardrobe = document.createElement("button");
    wardrobe.className = "text-button"; wardrobe.id = "detail-wardrobe"; wardrobe.textContent = "勝負服を選ぶ →";
    d.querySelector(".partner-kit").after(wardrobe);
    wardrobe.onclick = () => { d.close(); openWardrobe({ ...ctx, dialog }, i); };
    paint("stats");
    bind(d, "[data-tab]", (el) => {
      d.querySelectorAll("[data-tab]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === el)),
      );
      paint(el.dataset.tab);
    });
    d.querySelector("#detail-select").onclick = () => {
      d.close();
      selectHorse(i);
    };
  }
  if (current === 6) {
    app
      .querySelector(".entry-side")
      .insertAdjacentHTML(
        "beforeend",
        '<div class="entry-check"><span>✓ 芝適性 A</span><span>✓ 出走条件を満たしています</span></div>',
      );
    app
      .querySelector(".rank-card")
      .insertAdjacentHTML(
        "beforeend",
        '<p class="entry-footnote">参加費なし · ランクポイント対象<br>操作や能力の一部はデモの固定値です。</p>',
      );
    app.querySelector('.rank-card [data-go="7"]').onclick = () => {
      const d = dialog(
        "出走の準備ができました",
        `<div class="match-course">${badge("RANKED / 2,000m")}<h3>グリーンフィールド杯</h3><p>出走馬：${safe(chosen)} · ${horses[selected][2]}</p></div><dl class="spec-list"><div><dt>馬場</dt><dd>芝 / 良</dd></div><div><dt>参加枠</dt><dd>12頭（CPU補完）</dd></div><div><dt>通信</dt><dd>ローカルデモ</dd></div></dl><p class="quiet" id="match-status" role="status">準備完了。デモレースを開始できます。</p><div class="dialog-actions"><button class="secondary" id="match-cancel">キャンセル</button><button class="primary" id="match-start">レース開始 <span>↗</span></button></div>`,
      );
      d.querySelector("#match-cancel").onclick = () => d.close();
      d.querySelector("#match-start").onclick = () => {
        d.close();
        raceReward = false;
        localStorage.setItem("muchi-race-reward", "false");
        go(7);
      };
    };
    app.querySelector("#friend").onclick = () => {
      const d = dialog(
        "フレンドと、同じゲートへ。",
        '<label class="field-label" for="room-code">ルームコード <span>数字6桁</span></label><input class="name-input" id="room-code" inputmode="numeric" maxlength="6" placeholder="例：123456" aria-describedby="room-error"><p id="room-error" class="quiet" role="status">招待されたルームコードを入力してください。</p><button class="primary" id="join-room" disabled>ルームを確認する <span>↗</span></button>',
      );
      const input = d.querySelector("input"),
        btn = d.querySelector("#join-room");
      input.oninput = () => (btn.disabled = !/^\d{6}$/.test(input.value));
      btn.onclick = () =>
        (d.querySelector("#room-error").textContent =
          "オンライン接続は未実装です。コードは送信されていません。");
    };
  }
  if (current === 1 || current === 7) {
    lane = 2;
    stamina = 80;
    app
      .querySelector(".track")
      .insertAdjacentHTML(
        "beforeend",
        `<div class="race-leaderboard"><span>LIVE POSITION</span><b>1　${safe(rivals[0])}</b><b>2　${safe(rivals[1])}</b><b class="is-you">3　${safe(chosen)} <small>YOU</small></b></div><div class="lane-indicator">LANE <b id="lane-number">2</b> / 4</div>`,
      );
    app
      .querySelector(".race-controls")
      .insertAdjacentHTML(
        "beforebegin",
        '<div class="race-telemetry"><div><span>残り脚</span><b id="stamina-value">80%</b></div><div><span>折り合い</span><b id="temper-value">良好</b></div><div><span>ムチの使いどころ</span><b>直線で脚を使う</b></div><div class="lane-buttons"><button id="lane-in" aria-label="内側へ移動">← 内へ</button><button id="lane-out" aria-label="外側へ移動">外へ →</button></div></div>',
      );
    const updateLane = () => {
      app.querySelector("#lane-number").textContent = lane;
      app.querySelector("#lane-in").disabled = lane === 1;
      app.querySelector("#lane-out").disabled = lane === 4;
      app.querySelector(".track .horse-art").dataset.lane = String(lane);
    };
    app.querySelector("#lane-in").onclick = () => {
      lane = Math.max(1, lane - 1);
      updateLane();
    };
    app.querySelector("#lane-out").onclick = () => {
      lane = Math.min(4, lane + 1);
      updateLane();
    };
    updateLane();
    const update = () => {
      app.querySelector("#stamina-value").textContent = stamina + "%";
      app.querySelector(".stamina i").style.width = stamina + "%";
    };
    app.querySelector("#rein").onclick = () => {
      stamina = Math.min(100, stamina + 5);
      update();
      app.querySelector("#temper-value").textContent = "脚を温存";
      app.querySelector(".race-message").textContent =
        "手綱を引いて、折り合いを整えています。";
    };
    const whip = app.querySelector("#whip"),
      base = whip.onclick;
    whip.onclick = () => {
      stamina = Math.max(0, stamina - 12);
      update();
      app.querySelector("#temper-value").textContent = "スパート";
      app.querySelector(".race-message").textContent =
        "今だ、相棒を信じて。最後まで伸ばそう！";
      base();
      const rank = Number(app.querySelector("#position").textContent),
        order = [...rivals];
      order.splice(rank - 1, 0, chosen);
      app.querySelector(".race-leaderboard").innerHTML =
        "<span>LIVE POSITION</span>" +
        order
          .map(
            (name, i) =>
              `<b class="${i === rank - 1 ? "is-you" : ""}">${i + 1}　${safe(name)} ${i === rank - 1 ? "<small>YOU</small>" : ""}</b>`,
          )
          .join("");
    };
  }
  if (current === 8) {
    if (["finished", "settled"].includes(readClub().race?.status)) profile.raced = true;
    save();
    app.querySelector(".result-title p").textContent =
      chosen + " とつかんだ、最高の直線。";
    content.insertAdjacentHTML(
      "beforeend",
      `<section class="result-details"><div class="panel"><div class="section-caption"><h2>着順・タイム</h2>${badge("グリーンフィールド杯")}</div><table class="standings"><thead><tr><th>着順</th><th>馬名</th><th>タイム</th><th>着差</th></tr></thead><tbody>${[
        [chosen, "1:58.4", "—"],
        [rivals[0], "1:58.6", "1馬身"],
        [rivals[1], "1:58.9", "1½馬身"],
        ["ミナモ", "1:59.2", "2馬身"],
      ]
        .map(
          ([n, t, d], i) =>
            `<tr class="${i === 0 ? "you-row" : ""}"><td>${i + 1}</td><td>${safe(n)} ${i === 0 ? "<small>YOU</small>" : ""}</td><td>${t}</td><td>${d}</td></tr>`,
        )
        .join(
          "",
        )}</tbody></table><p class="quiet">上位4頭のデモ結果です。</p></div><div class="panel"><div class="section-caption"><h2>今回の報酬</h2>${badge("1ST PLACE")}</div><div class="reward-showcase">${creative("keyart/victory-trophy.png", "reward-trophy")}<div><small>RACE REWARD</small><strong>800 <span>無償コイン</span></strong><p>出走報酬と1着ボーナス</p></div></div><dl class="spec-list"><div><dt>出走報酬</dt><dd>無償コイン 300</dd></div><div><dt>1着ボーナス</dt><dd>無償コイン 500</dd></div><div><dt>ランクポイント</dt><dd>＋120 pt（表示デモ）</dd></div></dl><button class="primary" id="claim-race" ${raceReward ? "disabled" : ""}>${raceReward ? "報酬受取済み" : "800コインを受け取る"}<span>✓</span></button><button class="text-button" id="race-again">もう一度出走する ↗</button></div></section>`,
    );
    app.querySelector("#claim-race").onclick = () => {
      if (raceReward) return;
      raceReward = true;
      localStorage.setItem("muchi-race-reward", "true");
      profile.raced = true;
      save();
      ctx.addCoins(800);
      toast("出走報酬と1着ボーナスを受け取りました");
    };
    app.querySelector("#race-again").onclick = () => go(6);
  }
  if (current === 3) {
    const button = app.querySelector("#scout");
    if (profile.scouted) {
      button.textContent = "ホームへ戻る";
      button.insertAdjacentHTML(
        "beforebegin",
        '<p class="scout-received">✓ 初回無料スカウト受取済み</p>',
      );
    }
    button.onclick = () => {
      if (profile.scouted) {
        go(4);
        return;
      }
      profile.scouted = true;
      save();
      const pulls = [
        "コハク",
        "シラナミ",
        "ハルヒ",
        "カゲロウ",
        "フブキ",
        "アサギ",
        "ユウナギ",
        "ホタル",
        "サツキ",
        "アオバ",
      ];
      const d = dialog(
        "新しい仲間を、迎えよう。",
        `<p>初回無料10連スカウト ${badge("SR以上確定枠 ×1")}</p><div class="scout-results">${pulls.map((n, i) => `<div class="pull-card ${i < 2 ? "rare" : ""}"><small>${i < 2 ? "SR" : "R"}</small><img src="/art/partner-${i % 3}.webp" alt="${n}の相棒プレビュー" width="110" height="90"><b>${n}</b><em>NEW</em></div>`).join("")}</div><p class="quiet">固定結果の画面デモです。所属馬への追加・抽選処理は未接続です。</p><button class="primary" id="finish-scout">ホームへ <span>↗</span></button>`,
      );
      d.querySelector("#finish-scout").onclick = () => {
        d.close();
        go(4);
      };
      d.addEventListener("close", () => ctx.refresh());
    };
    app.querySelector("#rates").onclick = () =>
      dialog(
        "スカウトの提供内容",
        `<dl class="spec-list"><div><dt>対象</dt><dd>チュートリアル初回限定</dd></div><div><dt>消費コイン</dt><dd>0</dd></div><div><dt>内容</dt><dd>10頭 / SR以上1頭確定</dd></div></dl><div class="notice"><b>提供割合は未確定です</b><p>現在の画面は固定結果です。実際の確率・個別提供割合・重複時の交換条件は、本提供前にここへ掲載します。</p></div>`,
      );
  }
  if (current === 9) {
    app
      .querySelector(".shop-grid")
      .insertAdjacentHTML(
        "beforebegin",
        '<div class="store-heading"><h2>コインパック</h2><span>すべて税込 / 一回購入</span></div>',
      );
    app
      .querySelector(".shop-grid")
      .insertAdjacentHTML(
        "afterend",
        '<div class="notice store-notice"><b>購入前にご確認ください</b><p>コインの内訳・価格・年齢に応じた購入条件を、確認画面でご案内します。現在のプロトタイプでは決済されません。</p></div>',
      );
    const preview = document.createElement("button");
    preview.className = "text-button collection-preview";
    preview.id = "collection-preview";
    preview.innerHTML = `コレクションを見る ${icon("arrow")}`;
    app.querySelector(".pass-copy").append(preview);
    preview.onclick = () => {
      const d = dialog("クラブの色を、まとう。", `<div class="collection-cover"><img src="/creative/keyart/season-collection.webp" alt="深緑とアイボリーのシーズン勝負服"></div><div class="collection-heading"><span>THE NOVEMBER COLLECTION</span><h3>走る日にも、あなたらしさを。</h3><p>シーズン衣装のアートプレビューです。</p></div><div class="collection-items">${silks.map((color, i) => `<button class="silks-option" data-silks="${i}" aria-pressed="${i === 0}">${creative("items/silks-" + color + ".svg")}<b>${["クリムゾン", "アズール", "ヴァイオレット"][i]}</b><span>${i === 0 ? "表示中" : "プレビュー"}</span></button>`).join("")}</div><p class="collection-selection" role="status">クリムゾン · 勝負服の配色サンプル</p><p class="quiet">色違いは制作見本です。販売内容・装備・所持状態を変更するものではありません。</p>`);
      bind(d, "[data-silks]", (el) => {
        d.querySelectorAll("[data-silks]").forEach((b) => {
          b.setAttribute("aria-pressed", String(b === el));
          b.querySelector("span").textContent = b === el ? "表示中" : "プレビュー";
        });
        d.querySelector(".collection-selection").textContent = ["クリムゾン", "アズール", "ヴァイオレット"][Number(el.dataset.silks)] + " · 勝負服の配色サンプル";
      });
    };
    bind(app, ".purchase", (el) => {
      const id = el.dataset.product || (el.closest(".store-banner") ? "season_pass" : "coin_" + el.dataset.price);
      openCheckout(id, { dialog, coins, track, refresh: ctx.refresh });
    });
  }
  mountJourney({ ...ctx, dialog, profile });
  mountClub({ ...ctx, dialog });
}
