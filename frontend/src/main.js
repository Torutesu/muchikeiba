import "./style.css";
import "./details.css";
import "./atelier.css";
import { enhance } from "./details.js";
import { icon } from "./icons.js";
import { mountPresentation, disposePresentation } from "./presentation.js";
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const app = document.querySelector("#app");
const screens = [
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
];
const route = Number(location.hash.slice(1)),
  savedCoins = Number(localStorage.getItem("muchi-coins"));
let current = Number.isInteger(route) && route >= 0 && route < 10 ? route : 0,
  horse = escapeHtml(localStorage.getItem("muchi-horse") || "アカツキ"),
  coins =
    localStorage.getItem("muchi-coins") !== null &&
    Number.isFinite(savedCoins) &&
    savedCoins >= 0
      ? savedCoins
      : 1200,
  selected = Number(localStorage.getItem("muchi-selected")) || 0,
  hits = 0,
  timer;
if (selected < 0 || selected > 2 || !Number.isInteger(selected)) selected = 0;
const horses = [
  ["アカツキ", "SSR", "差し", "芝 / 中距離", "94"],
  ["コハク", "SR", "先行", "芝 / 短距離", "88"],
  ["シラナミ", "SR", "追込", "芝 / 長距離", "86"],
];
const navigation = [
  ["home", "ホーム", 4],
  ["stable", "厩舎", 5],
  ["flag", "レース", 6],
  ["spark", "スカウト", 3],
  ["shop", "ショップ", 9],
];
const horseArt = (cls = "") => {
  const i = Number(cls.match(/variant-(\d)/)?.[1] ?? selected);
  return `<div class="horse-art ${cls}" data-partner="${i}"><div class="model-halo"></div><img src="/art/partner-${i}.webp" alt="${["鹿毛・クリムゾンの勝負服", "栗毛・アズールの勝負服", "芦毛・ヴァイオレットの勝負服"][i]}の相棒" width="1100" height="900" draggable="false"><span class="art-caption">THOROUGHBRED COLLECTION / ${String(i + 1).padStart(2, "0")}</span></div>`;
};
function go(n) {
  clearTimeout(timer);
  current = n;
  location.hash = n;
  render();
}
const button = (label, n, kind = "primary") =>
  `<button class="${kind}" data-go="${n}">${label}<span>${icon("arrow")}</span></button>`;
const eyebrow = (t) => `<div class="eyebrow"><span></span>${t}</div>`;
const head = (en, ja, sub) =>
  `<div class="page-head"><div>${eyebrow(en)}<h1>${ja}</h1><p>${sub}</p></div><span class="edition">THE RACING CLUB<br><b>EST. MMXXVI</b></span></div>`;
const nav = () =>
  `<nav aria-label="メインナビゲーション">${navigation.map(([symbol, label, id]) => `<button class="${current === id ? "active" : ""}" data-go="${id}" ${current === id ? 'aria-current="page"' : ""}>${icon(symbol)}<span>${label}</span>${icon("chevron", "nav-chevron")}</button>`).join("")}</nav>`;
function shell(content) {
  return `<aside class="rail"><a class="brand" href="#4" aria-label="ムチ一閃 ホーム"><span class="brand-crest">M<i>一閃</i></span></a><span class="rail-caption">RACING CLUB</span>${nav()}<div class="rail-membership">${icon("laurel")}<span>YOUR NEXT<br>GREAT STORY.</span></div><div class="rail-foot">JAPAN · 2026</div></aside><div class="workspace"><header><div class="wordmark">ムチ一閃 <small>THE JOCKEY RACING CLUB</small></div><div class="header-path"><span>CLUB</span><i>/</i>${screens[current]}</div><div class="wallet"><span>${icon("coin")}<b>${coins.toLocaleString()}</b><small>無償</small></span><span class="club-money">◎ <b>24,800</b></span><button class="header-icon" id="club-guide" aria-label="クラブガイド">${icon("help")}</button><button class="avatar" data-go="4" aria-label="ホーム">Y</button></div></header><main>${content}</main><div class="mobile-nav">${nav()}</div><footer><span>MUCHI ISSEN <i>®</i> <b>RIDE YOUR OWN STORY.</b></span><span><i class="status-dot"></i> LOCAL PREVIEW <span class="footer-divider">/</span> JAPAN · TURF · 2,000m</span></footer></div>`;
}
function render() {
  document.querySelectorAll("dialog[open]").forEach((d) => {
    d.close();
    d.remove();
  });
  disposePresentation();
  let content = "";
  if (current === 0)
    content = `<section class="landing"><div class="landing-photo"></div><div class="intro"><span class="capsule">THE FIRST CHAPTER</span>${eyebrow("A MOMENT THAT CHANGES EVERYTHING.")}<h1>その一瞬に、<br>すべてを<span>懸ける。</span></h1><p>ゲートの向こうに、あなただけの物語がある。<br>相棒と駆ける、90秒のジョッキーレーシング。</p><label class="consent"><input id="consent" type="checkbox"> 利用規約・プライバシーポリシーに同意する</label>${button("はじめてのレースへ", 1)}<small class="quiet">アカウント登録不要 · まずは最後の直線から</small></div><div class="landing-note"><span>01 — THE BEGINNING</span><b>最後の直線、あなたの一手で。</b></div></section>`;
  if (current === 1 || current === 7)
    content = `<section class="race"><div class="race-top"><div>${eyebrow(current === 1 ? "FIRST RIDE / TUTORIAL" : "GREENFIELD CUP / RANKED")}<h1>${current === 1 ? "はじめての、最後の直線。" : "グリーンフィールド杯"}</h1></div><div class="position-display"><span>POSITION</span><b><span id="position">3</span><small> / 12</small></b></div><div class="race-condition">${icon("sun")}<b>芝 2,000m</b><span>左回り · 良</span></div></div><div class="track" data-race-model="${selected}"><img class="race-backdrop" src="/art/spring-course.webp" alt="グリーンフィールドのターフの直線">${horseArt()}<div class="track-vignette"></div><div class="distance"><span>TO FINISH</span><b id="distance">200</b><small>m</small></div><div class="race-message" role="status">${current === 1 ? "最後の直線。脚をためて、ここで仕掛けよう。" : "仕掛けどころは、あなたが決める。"}</div></div><div class="race-controls"><button class="secondary" id="rein">${icon("rotate")} 手綱を引く</button><div><span>STAMINA / 残り脚</span><div class="stamina"><i></i></div><small>折り合い GOOD</small></div><button class="primary whip" id="whip">仕掛ける <span>${icon("bolt")} <b id="whips">6</b><small>回</small></span></button></div></section>`;
  if (current === 2)
    content = `<section class="split"><div class="naming-stage"><div class="chapter-number">02</div><span class="capsule">YOUR FIRST PARTNER</span>${horseArt()}<div class="stage-description"><span>THOROUGHBRED / BAY</span><b>ひとつの名前から、始まる。</b></div></div><div class="form-panel">${eyebrow("A NAME. A BOND. A NEW CHAPTER.")}<h1>その出会いに、<br>名前をつけよう。</h1><p>初めての直線を、一緒に駆け抜けた相棒。<br>これからの物語を、その名前とともに。</p><div class="partner-line"><span class="rarity">SSR</span><span>鹿毛 / 差し / 中距離</span><span class="status-pill">あなたの最初の相棒</span></div><label class="field-label" for="horse-name">相棒の名前 <span>2〜12文字</span></label><input class="name-input" id="horse-name" maxlength="12" value="${horse}" placeholder="名前を入力"><p class="input-help" id="name-help">あとから変更できます。</p><button class="primary" id="save-name">この名前で、一緒に走る <span>${icon("arrow")}</span></button><div class="form-note">${icon("laurel")}<span>名前をつけた日が、あなたたちの記念日。</span></div></div></section>`;
  if (current === 3)
    content = `${head("THE PADDOCK / SCOUT", "まだ見ぬ才能に、出会う。", "走り方も、個性も、一頭ずつ。次の物語がここから始まる。")}<section class="scout-panel"><div class="scout-copy"><span class="capsule">WELCOME TO THE CLUB</span>${eyebrow("YOUR FIRST SCOUT")}<h2>十頭の出会い。<br>無限の<span>可能性。</span></h2><p>チュートリアル限定・初回10連無料<br>新しい相棒と、次のゲートへ。</p><div class="scout-guarantee">${icon("spark")}<span><b>SR以上 1頭確定</b><small>初回限定のウェルカムギフト</small></span></div><button class="primary" id="scout">無料で10連スカウト <span>${icon("spark")}</span></button><button class="text-button" id="rates">提供内容・スカウトについて ${icon("arrow")}</button></div><div class="scout-visual">${horseArt()}<div class="scout-seal">10<small>PARTNERS</small></div></div></section><div class="scout-notes"><div><span>01</span><p><b>一頭ずつ、違う個性</b>脚質や距離適性を知って、相棒を選ぼう。</p></div><div><span>02</span><p><b>レースで、才能が開く</b>能力と操作を組み合わせて、自分の走りへ。</p></div><div><span>03</span><p><b>出会いは、一度きり</b>初回無料スカウトは1回だけ受け取れます。</p></div></div>${nav()}`;
  if (current === 4)
    content = `<div class="home-heading"><div>${eyebrow("YOUR CLUB. YOUR NEXT CHAPTER.")}<h1>おかえり、ジョッキー。</h1></div><div class="season"><span>SEASON 01 <i>·</i> NOVEMBER</span><b>${icon("laurel")} ブロンズ II</b><span>次のクラスまで 240 pt</span></div></div><section class="home-hero"><div class="hero-copy"><span class="tag">YOUR PARTNER · ${horses[selected][1]}</span><div class="hero-pretitle">今日も、相棒と。</div><h2>${horse}</h2><p>調子は良好。次の一戦に備えよう。</p><div class="horse-meta"><span>差し</span><span>芝適性 A</span><span>中距離</span></div>${button("レースへ向かう", 6)}<button class="hero-inspect text-button" id="home-inspect">${icon("rotate")} 相棒を3Dで見る</button></div>${horseArt()}<div class="hero-condition"><i></i> CONDITION <b>GOOD</b></div><div class="hero-index"><b>${icon("laurel")}</b> THE THOROUGHBRED COLLECTION <span>01 / ${horses[selected][1]}</span></div></section><div class="home-cards"><button data-go="5">${icon("stable")}<span>YOUR STABLE<b>相棒たちに会いにいく</b></span><i>${icon("arrow")}</i></button><button id="daily">${icon("flag")}<span>DAILY MISSIONS<b>今日の報酬を確認する</b></span><i>0 / 2</i></button><button data-go="3">${icon("spark")}<span>WELCOME SCOUT<b>次の才能と、出会う</b></span><i>${icon("arrow")}</i></button></div>${nav()}`;
  if (current === 5)
    content = `${head("YOUR STABLE / COLLECTION", "一頭ずつ、ひとつの物語。", "個性を知ることが、勝利への近道。今日の相棒を選ぼう。")}<div class="tabs"><button class="selected" id="stable-tab">${icon("stable")} 所属馬 <b>3</b></button><button id="breed-tab">${icon("spark")} 配合 <span class="lock-label">クラブ2日目</span></button><span>STABLE CAPACITY <b>3 / 20</b></span></div><div class="horse-grid"></div><div class="stable-bottom-note">${icon("help")} レアリティだけでなく、脚質とコース適性を組み合わせて出走馬を選びましょう。</div>${nav()}`;
  if (current === 6)
    content = `${head("RACE ENTRY / GREENFIELD", "次の一戦が、待っている。", "相棒を選び、コースを読み、ゲートへ。あなたの走りを見せよう。")}<div class="entry-grid"><section class="rank-card"><div class="entry-photo"></div><div class="rank-card-content"><span class="tag">RANKED RACE / SEASON 01</span><h2>グリーンフィールド杯</h2><p>GREENFIELD TURF CHAMPIONSHIP</p><div class="course"><svg viewBox="0 0 400 140" aria-label="左回りの芝コース"><rect x="25" y="20" width="350" height="100" rx="50" fill="none" stroke="currentColor" stroke-width="12"/><path d="M210 110h60" stroke="#fff" stroke-width="3"/><circle cx="270" cy="110" r="6" fill="#e2be71"/><text x="260" y="92" font-size="10" fill="#fff">FINISH</text></svg></div><div class="course-facts"><span>芝<b>2,000<small>m</small></b></span><span>左回り<b>良</b></span><span>天候<b>${icon("sun")} 晴れ</b></span></div><div class="race-spec"><span>最大12頭<small>空き枠はCPUが参加</small></span><span>能力上限あり<small>操作で差がつくランク戦</small></span></div>${button("このレースに出走", 7)}</div></section><section class="entry-side"><div class="section-caption"><span class="eyebrow">SELECTED PARTNER</span><span class="status-pill">出走馬</span></div><h2>${selected === 0 ? horse : horses[selected][0]}</h2>${horseArt()}${button("出走馬を変更する", 5, "secondary")}<button class="friend" id="friend">${icon("globe")} フレンドルーム <span>${icon("arrow")}</span></button></section></div>${nav()}`;
  if (current === 8)
    content = `<section class="result"><div class="result-title">${eyebrow("GREENFIELD CUP / OFFICIAL RESULT")}<div class="winner-label">${icon("laurel")} VICTORY</div><h1><em>1</em><span>ST<br>PLACE</span></h1><h2>その一瞬が、勝利になった。</h2><p>${horse} とつかんだ、最高の直線。</p></div>${horseArt()}<div class="result-ribbon">${icon("laurel")} GREENFIELD TURF CHAMPIONSHIP <span>芝 2,000m / 良</span></div><div class="result-bottom"><div><small>RACE TIME</small><b>1:58.4</b><span>自己ベスト更新</span></div><div><small>RANK POINT</small><b>＋120 <span>pt</span></b><span>ブロンズ II</span></div><div><small>TOTAL REWARD</small><b>800 <span>coin</span></b><span>出走 ＋ 1着ボーナス</span></div>${button("ホームへ戻る", 4)}</div></section>`;
  if (current === 9)
    content = `${head("CLUB STORE / MEMBERS COLLECTION", "走る日々を、あなたらしく。", "出会いも、勝負服も。相棒との時間を、少し特別に。")}<div class="store-banner"><div class="pass-visual">${icon("laurel")}<span>SEASON<br><b>01</b></span><small>THE NOVEMBER COLLECTION</small></div><div class="pass-copy">${eyebrow("SEASON 01 / NOVEMBER")}<h2>次の季節も、相棒と。</h2><p>シーズンパス · 限定勝負服と毎日の報酬</p><div class="pass-perks"><span>${icon("check")} 限定勝負服</span><span>${icon("check")} 毎日の報酬</span><span>${icon("check")} クラブ特典</span></div></div><button class="secondary purchase" data-price="1000">¥1,000 <span>${icon("arrow")}</span></button></div><div class="shop-grid">${[
      [160, 100],
      [480, 310],
      [800, 530],
      [1500, 1020],
    ]
      .map(
        ([p, c], i) =>
          `<button class="coin-card purchase ${i === 2 ? "recommended" : ""}" data-price="${p}">${i === 2 ? '<div class="recommend-badge">CLUB SELECTION</div>' : ""}<span>COIN COLLECTION / 0${i + 1}</span><div class="coin-emblem"><img src="/creative/currency/${i > 1 ? "coin-reward" : "coin-paid"}.svg" alt="" width="128" height="128"></div><h2>${c.toLocaleString()} <small>有償コイン</small></h2><p>新しい出会いを、クラブから。</p><b>¥${p.toLocaleString()} <span>税込 ${icon("arrow")}</span></b></button>`,
      )
      .join(
        "",
      )}</div><p class="quiet store-balance">現在の残高 <b>有償 0</b><b>無償 ${coins.toLocaleString()}</b> · 購入前に年齢と月額上限を確認します。</p>${nav()}`;
  app.innerHTML = `<div class="design-toolbar"><span>MUCHI ISSEN <b>DESIGN EDITION / 02</b></span><select id="screen-select" aria-label="画面を選択">${screens.map((s, i) => `<option value="${i}" ${current === i ? "selected" : ""}>${String(i + 1).padStart(2, "0")} / ${s}</option>`).join("")}</select><a class="creative-link" href="/creative/index.html" target="_blank" rel="noopener">素材一覧 ${icon("arrow")}</a><a href="/design/screens.svg" download>Figma SVG ${icon("arrow")}</a></div><div class="app-frame screen-${current}" data-screen="${current}">${shell(content)}</div><div class="prototype-note"><span class="status-dot"></span>INTERACTIVE DESIGN PREVIEW <span>対戦・抽選・購入はローカルのデモです。</span><button id="reset">はじめから ${icon("arrow")}</button></div>`;
  app.querySelectorAll("[data-go]").forEach(
    (b) =>
      (b.onclick = () => {
        if (current === 0 && !document.querySelector("#consent").checked)
          return toast("利用規約への同意を確認してください");
        go(Number(b.dataset.go));
      }),
  );
  document.querySelector("#screen-select").onchange = (e) =>
    go(Number(e.target.value));
  document.querySelector("#reset").onclick = () => go(0);
  app.querySelectorAll("[data-horse]").forEach(
    (b) =>
      (b.onclick = () => {
        selected = Number(b.dataset.horse);
        render();
      }),
  );
  const on = (id, fn) => {
    const e = document.getElementById(id);
    if (e) e.onclick = fn;
  };
  on("save-name", () => {
    const value = document.querySelector("#horse-name").value.trim();
    if (value.length < 2 || /[<>]/.test(value))
      return toast("2〜12文字で名前を入力してください");
    horse = escapeHtml(value);
    localStorage.setItem("muchi-horse", value);
    go(3);
  });
  if (current === 1 || current === 7) {
    hits = 0;
    on("whip", () => {
      hits++;
      document.querySelector("#whips").textContent = 6 - hits;
      document.querySelector("#position").textContent = Math.max(1, 3 - hits);
      document.querySelector("#distance").textContent = Math.max(
        0,
        200 - hits * 50,
      );
      document.querySelector(".track").classList.remove("spur-flash");
      requestAnimationFrame(() =>
        document.querySelector(".track")?.classList.add("spur-flash"),
      );
      if (hits >= 4) {
        document.querySelector("#whip").disabled = true;
        timer = setTimeout(() => go(current === 1 ? 2 : 8), 600);
      }
    });
  }
  enhance({
    app,
    current,
    horses,
    selected,
    horse: new DOMParser().parseFromString(horse, "text/html").body.textContent,
    coins,
    horseArt,
    go,
    toast,
    refresh: render,
    selectHorse: (i) => {
      selected = i;
      localStorage.setItem("muchi-selected", i);
      render();
    },
    addCoins: (n) => {
      coins += n;
      localStorage.setItem("muchi-coins", coins);
      render();
    },
  });
  mountPresentation({ app, current, selected, horseArt, icon });
  const guide = app.querySelector("#club-guide");
  if (guide)
    guide.onclick = () => {
      const d = document.createElement("dialog");
      d.className = "detail-dialog";
      d.setAttribute("aria-label", "クラブガイド");
      d.innerHTML = `<button class="close" aria-label="閉じる">${icon("close")}</button>${eyebrow("WELCOME TO THE CLUB")}<h2>相棒と、自分の走りを見つけよう。</h2><p>厩舎で相棒の能力と適性を確認し、レースへ。直線では残り脚を見ながら仕掛けましょう。</p><p class="quiet">このプレビューでは、対戦・抽選・購入は実行されません。</p>`;
      document.body.append(d);
      d.querySelector(".close").onclick = () => d.close();
      d.addEventListener("close", () => d.remove());
      d.showModal();
    };
}
function toast(t) {
  document.querySelector(".toast")?.remove();
  const e = document.createElement("div");
  e.className = "toast";
  e.setAttribute("role", "status");
  e.textContent = t;
  document.body.append(e);
  setTimeout(() => e.remove(), 3500);
}
window.addEventListener("hashchange", () => {
  let n = Number(location.hash.slice(1));
  if (Number.isInteger(n) && n !== current && n >= 0 && n < screens.length) {
    current = n;
    render();
  }
});
render();
