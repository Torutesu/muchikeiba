import { readClub, grantReward, ensureRace, settleRace, beginRace, selectEvent, freeBalance, claimPass, claimEvent } from "./club-state.js";
import { icon } from "./icons.js";
import { openCheckout, products, productContents, itemLabels } from "./commerce.js";
import progression from "../../server/master/progression.json";
import eventMaster from "../../server/master/events.json";
import trackMaster from "../../server/master/tracks.json";
import "./journey.css";

const KEY = "muchi-journey-v1";
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const dateKey = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
function load() {
  const s = read(KEY, {});
  return {
    steps: Array.isArray(s.steps) ? [...new Set(s.steps.filter(x => ["ride", "name", "scout", "win"].includes(x)))] : [],
    days: Array.isArray(s.days) ? [...new Set(s.days.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)))].slice(0, 7) : [],
  };
}
const save = s => localStorage.setItem(KEY, JSON.stringify(s));
export function track(event, data = {}) {
  // Preview-only journal, no network. Product/source IDs only, never names or birth dates.
  const allowed = Object.fromEntries(Object.entries(data).filter(([k, v]) => ["source", "product", "step", "day"].includes(k) && ["string", "number"].includes(typeof v)));
  const events = read("muchi-experience-events", []);
  localStorage.setItem("muchi-experience-events", JSON.stringify([...(Array.isArray(events) ? events : []).slice(-199), { event, at: Date.now(), ...allowed }]));
}
export function campaignState(event, now = Date.now()) {
  return now < event.startAtMs ? "upcoming" : now >= event.endAtMs ? "ended" : "active";
}
const art = (name, cls = "", alt = "") => `<img class="${cls}" src="/campaign/art/${name}.svg" alt="${alt}" width="128" height="128">`;
const rewardArt = r => r.freeCoins ? '<img src="/creative/currency/coin-free.svg" alt="" width="80" height="80">' : r.items[0].itemId === "costume_login" ? art("silks-wings") : /ticket/.test(r.items[0].itemId) ? art("ticket-sr") : '<img src="/creative/items/premium-feed.svg" alt="" width="80" height="80">';
const rewardLabel = r => r.freeCoins ? `無償コイン ×${r.freeCoins}` : `${itemLabels[r.items[0].itemId]} ×${r.items[0].qty}`;
const steps = [
  { id: "ride", label: "直線を駆ける", sub: "最後の200mで仕掛けよう", route: 1 },
  { id: "name", label: "名前を贈る", sub: "あなただけの相棒に", route: 2 },
  { id: "scout", label: "仲間に出会う", sub: "初回10連を無料で", route: 3 },
  { id: "win", label: "初勝利をつかむ", sub: "次はクラブのレースへ", route: 6 },
];
const campaignDate = ms => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

function prepareCampaignDialog(d, cls) {
  d.classList.add(cls);
  const top = document.createElement("div");
  top.className = "campaign-top";
  top.append(...Array.from(d.children).slice(0, 3));
  d.prepend(top);
  d.querySelector(".close").focus({ preventScroll: true });
  d.scrollTop = 0;
}

export function mountJourney(ctx) {
  const { app, current, dialog, profile, go, coins } = ctx;
  let state = load();
  state.days.forEach((_, i) => grantReward("welcome:" + (i + 1), progression.loginBonus[i], { coins: false }));
  if (current === 7) ensureRace();
  if (current === 8) settleRace(progression, eventMaster.events);
  const mark = id => {
    if (state.steps.includes(id)) return;
    state.steps.push(id); save(state); track("journey_step_complete", { step: id });
  };
  if (localStorage.getItem("muchi-horse")) mark("name");
  if (profile.scouted) mark("scout");
  if (current === 8 && readClub().completed > 0) mark("win");
  const raceEvent = eventMaster.events.find(e => e.id === readClub().race?.event);
  if ((current === 7 || current === 8) && raceEvent) {
    const course = trackMaster.tracks.find(t => t.id === raceEvent.trackIds[0]);
    if (current === 7) {
      app.querySelector(".race-top h1").textContent = raceEvent.name;
      app.querySelector(".race-top .eyebrow").textContent = "EVENT RACE / LOCAL DEMO";
      app.querySelector(".race-condition b").textContent = `芝 ${course.distanceM.toLocaleString()}m`;
    } else {
      const points = raceEvent.points.byPlace[0] + raceEvent.points.participation;
      app.querySelector(".result-title .eyebrow").textContent = raceEvent.name + " / LOCAL RESULT";
      app.querySelector(".result-ribbon").innerHTML = `${icon("laurel")} ${raceEvent.name} <span>芝 ${course.distanceM.toLocaleString()}m / 良</span>`;
      app.querySelector(".result-details .status-pill").textContent = raceEvent.name;
      const reward = app.querySelector(".result-details .panel:last-child");
      reward.querySelector(".reward-showcase strong").innerHTML = `${points} <span>イベントpt</span>`;
      reward.querySelector(".reward-showcase p").textContent = "着順ポイント + 参加ポイント";
      reward.querySelector(".spec-list").innerHTML = `<div><dt>着順ポイント</dt><dd>＋${raceEvent.points.byPlace[0]} pt</dd></div><div><dt>参加ポイント</dt><dd>＋${raceEvent.points.participation} pt</dd></div><div><dt>参加費（開始時に消費済み）</dt><dd>無償コイン ${raceEvent.fee.freeCoins}</dd></div>`;
      const claim = reward.querySelector("#claim-race");claim.disabled = true;claim.textContent = "イベント成績を記録済み";claim.onclick = () => {};
      const resultStats = app.querySelectorAll(".result-bottom > div");
      resultStats[1].innerHTML = `<small>EVENT POINT</small><b>＋${points} <span>pt</span></b><span>イベント累積へ</span>`;
      resultStats[2].innerHTML = `<small>TOTAL EVENT POINT</small><b>${readClub().eventPoints[raceEvent.id] || 0} <span>pt</span></b><span>報酬はイベント画面で受取</span>`;
    }
  }
  const next = steps.find(s => !state.steps.includes(s.id));
  const starter = products.starter_pack;
  const buy = (id, source) => {
    track("offer_details", { product: id, source });
    openCheckout(id, { dialog, coins, track, refresh: ctx.refresh });
  };

  const headerButton = document.createElement("button");
  headerButton.id = "campaign-menu";
  headerButton.className = "campaign-menu";
  headerButton.setAttribute("aria-label", "キャンペーンとクラブ特典");
  headerButton.innerHTML = `${icon("spark")}<span>クラブ特典</span>`;
  app.querySelector(".wallet").prepend(headerButton);
  headerButton.onclick = () => openHub("welcome", "header");

  if (current <= 3) {
    const milestone = document.createElement("section");
    milestone.className = "onboarding-path";
    milestone.setAttribute("aria-label", "初めてのクラブ体験");
    milestone.innerHTML = `<div><small>YOUR FIRST CHAPTER</small><span>相棒との物語を、ひとつずつ。</span></div><ol>${steps.map((s, i) => `<li class="${state.steps.includes(s.id) ? "complete" : next?.id === s.id ? "current" : ""}" ${next?.id === s.id ? 'aria-current="step"' : ""}><b>${state.steps.includes(s.id) ? icon("check") : String(i + 1).padStart(2, "0")}</b><span>${s.label}</span></li>`).join("")}</ol>`;
    app.querySelector("main").prepend(milestone);
    if (current === 1) {
      const whip = app.querySelector("#whip"), base = whip.onclick;
      const coach = document.createElement("div");
      coach.className = "first-ride-coach"; coach.setAttribute("role", "status");
      coach.innerHTML = `<b>01 / 脚をためて、直線で伸ばす</b><span>「仕掛ける」を押して、相棒の伸びを感じよう。</span>`;
      app.querySelector(".race-controls").insertAdjacentElement("beforebegin", coach);
      whip.onclick = () => {
        base();
        const left = Number(app.querySelector("#distance").textContent);
        coach.innerHTML = left > 0 ? `<b>${Math.min(4, 4 - left / 50)} / 4　その調子、もう一度。</b><span>残り脚は仕掛けると減ります。実戦では使いどころが大切。</span>` : "<b>FINISH / 一緒に、駆け抜けた。</b><span>この相棒に、あなたが名前を贈りましょう。</span>";
        if (left === 0) mark("ride");
      };
    }
    if (current === 2) {
      app.querySelector(".form-note span").textContent = "名前を贈れば、この一頭があなたの相棒に。";
      const btn = app.querySelector("#save-name"), base = btn.onclick;
      btn.onclick = () => { if (!btn.disabled) mark("name"); base(); };
    }
  }

  function starterMarkup(source) {
    return `<section class="partner-offer" aria-label="スターターパック"><div class="offer-copy"><span class="journey-kicker">FIRST PARTNER COLLECTION</span><h2>この出会いに、<br>特別な勝負服を。</h2><p>新しい仲間との出会いと、自分らしい装い。<br>最初の一歩を、ひとつのセットに。</p><ul><li>${icon("check")} 有償${starter.paidCoins}コイン</li><li>${icon("check")} SR以上チケット ×1</li><li>${icon("check")} 稲妻の勝負服 ×1</li></ul><div class="offer-purchase"><button class="primary" data-buy-starter="${source}">セット内容を見る <span>¥${starter.priceYen.toLocaleString()}</span></button><small>税込・一回購入 / 1アカウント1回</small></div></div><div class="offer-still"><img class="offer-editorial" src="/campaign/art/first-partner.webp" alt="深緑に金の稲妻をあしらった勝負服とスカウトチケット" width="1536" height="1024"><span>FIRST PARTNER / DESIGN PREVIEW</span></div></section>`;
  }

  function openStarter(source) {
    track("offer_view", { product: "starter_pack", source });
    const d = dialog("相棒に、特別な一着を。", `<img class="starter-editorial" src="/campaign/art/first-partner.webp" alt="稲妻の勝負服とチケットのコレクションイメージ" width="1536" height="1024"><div class="product-story"><span class="journey-kicker">FIRST PARTNER COLLECTION</span><p>稲妻の勝負服で、自分の走りを。<br>SR以上チケットで、次の仲間との出会いも。</p></div><dl class="spec-list">${productContents(starter).map(([k,v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl><div class="product-note">セット内容は確定。チケットで出会う馬は抽選です。勝負服は外観用です。画像内の帽子・ゼッケンはセットに含みません。</div><div class="product-price"><span><b>¥${starter.priceYen.toLocaleString()}</b><small>税込・一回購入</small></span><button class="primary" id="starter-checkout">購入内容の確認へ ${icon("arrow")}</button></div><p class="quiet">1アカウント1回。商品内容は既存マスターの暫定値、絵はデザイン見本です。</p>`);
    prepareCampaignDialog(d, "starter-dialog");
    d.querySelector("#starter-checkout").onclick = () => buy("starter_pack", source);
  }

  if (current === 4) {
    const board = document.createElement("section"); board.className = "journey-home";
    board.innerHTML = `<div class="journey-heading"><div><span class="journey-kicker">YOUR FIRST CHAPTER</span><h2>${next ? "次の一歩も、相棒と。" : "初勝利は、ふたりの始まり。"}</h2></div><span class="journey-count">${state.steps.length}<small> / 4 CHAPTERS</small></span></div><ol class="journey-steps">${steps.map((s,i) => `<li class="${state.steps.includes(s.id) ? "complete" : next?.id === s.id ? "current" : ""}"><span>${state.steps.includes(s.id) ? icon("check") : String(i+1).padStart(2,"0")}</span><div><b>${s.label}</b><small>${s.sub}</small></div></li>`).join("")}</ol><div class="journey-next"><p>${next ? next.sub + "。自分のペースで進められます。" : "初勝利の記録が残りました。次のコースでも、自分の走りを。"}</p><button class="small-button filled" id="journey-next">${next ? next.label : "もう一度レースへ"} ${icon("arrow")}</button></div>`;
    app.querySelector(".home-cards").insertAdjacentElement("afterend", board);
    board.querySelector("#journey-next").onclick = () => { track("journey_continue", { step: next?.id || "win" }); go(next?.route ?? 6); };
    const discovery = document.createElement("div"); discovery.className = "campaign-discovery";
    discovery.innerHTML = `<button class="welcome-discovery" id="campaign-open"><div><span class="journey-kicker">WELCOME TO THE CLUB</span><h2>会うたび、クラブがもっと好きになる。</h2><p>3回目に「翼」の勝負服。7回目にSR以上チケット。</p><span class="discovery-link">${state.days.length === 7 ? "すべて受取済み" : state.days.includes(dateKey()) ? "今日の分は受取済み・内容を見る" : "今日の無料ギフトを見る"} ${icon("arrow")}</span></div>${art("silks-wings")}</button><button class="season-discovery" id="season-open"><span class="journey-kicker">RACE DAYS / CLUB EVENTS</span><h2>次の舞台を、見つけよう。</h2><p>イベントの条件と報酬をチェック。</p><span class="discovery-link">開催情報を見る ${icon("arrow")}</span></button>`;
    board.insertAdjacentElement("afterend", discovery);
    discovery.querySelector("#campaign-open").onclick = () => openHub("welcome", "home");
    discovery.querySelector("#season-open").onclick = () => openHub("event", "home");
  }
  if (current === 8) {
    const n = document.createElement("section"); n.className = "first-win-note";
    n.innerHTML = `<img src="/creative/emblems/first-victory.svg" alt="" width="100" height="100"><div><span class="journey-kicker">A MOMENT TO REMEMBER</span><h2>この勝利を、始まりに。</h2><p>記録はクラブに残ります。次のレースは、自分らしい装いで。</p></div><button class="secondary" id="first-win-collection">相棒との次の一歩 ${icon("arrow")}</button>`;
    app.querySelector("main").append(n);
    n.querySelector("button").onclick = () => openStarter("first_win");
    const club = readClub();
    if (club.race?.status === "settled") {
      const growth = document.createElement("section"); growth.className = "race-growth-note";
      const level = Math.floor(club.xp / progression.passXpPerLevel);
      growth.innerHTML = `<div><span class="journey-kicker">ONE RACE. ANOTHER CHAPTER.</span><h3>完走した時間が、クラブの記録に。</h3><p>今回の完走を記録済み · パス Lv.${level} / ${progression.passMaxLevel} · 累計 ${club.xp} XP${club.race.event ? " · イベント累積 " + club.eventPoints[club.race.event] + " pt" : ""}</p></div><button class="secondary" id="result-pass">パスの報酬を見る ${icon("arrow")}</button>`;
      app.querySelector(".result-details").after(growth);
      growth.querySelector("button").onclick = () => openHub("pass", "result");
    }
  }
  if (current === 9) {
    app.querySelector(".page-head").insertAdjacentHTML("afterend", starterMarkup("store"));
    app.querySelector("[data-buy-starter]").onclick = () => openStarter("store");
    const pass = products.season_pass;
    const passCopy = app.querySelector(".pass-copy");
    passCopy.querySelector("h2").textContent = "走った時間が、コレクションに。";
    passCopy.querySelector("p").textContent = "30日クラブパス · 炎の勝負服と追加報酬";
    const passLink = document.createElement("button"); passLink.id = "pass-benefits"; passLink.className = "text-button"; passLink.innerHTML = `無料・パスの報酬を比べる ${icon("arrow")}`;
    passCopy.append(passLink); passLink.onclick = () => openHub("pass", "store");
    app.querySelector(".pass-perks").innerHTML = `<span>${icon("check")} 購入から${pass.durationDays}日</span><span>${icon("check")} 自動更新なし</span><span>${icon("check")} 外観と追加報酬</span>`;
    app.querySelectorAll(".coin-card").forEach(el => {
      const p = products["coin_" + el.dataset.price];
      el.querySelector("p").innerHTML = readClub().purchases[p.id] ? "初回特典は体験済みです" : `初回は無償 <b>＋${p.paidCoins}</b> コイン`;
    });
    const guide = document.createElement("div"); guide.className = "store-choice-guide";
    guide.innerHTML = `<span>WHAT FITS YOUR CLUB?</span><p><b>最初のひと揃え</b>はスターター。<b>走る日々を楽しむ</b>なら30日パス。コインは必要な分から。</p><button class="text-button" id="store-welcome">まずは無料ギフトを見る ${icon("arrow")}</button>`;
    app.querySelector(".partner-offer").insertAdjacentElement("beforebegin", guide);
    guide.querySelector("button").onclick = () => openHub("welcome", "store");
  }

  if (current === 6) {
    const club = readClub(), event = eventMaster.events.find(e=>e.id===club.pendingEvent);
    const eventCourse = event && trackMaster.tracks.find(t=>t.id===event.trackIds[0]);
    if (event) {
      app.querySelector(".rank-card h2").textContent=event.name;
      app.querySelector(".rank-card .tag").textContent="EVENT RACE / LOCAL DEMO";
      app.querySelector(".rank-card-content>p").textContent=trackMaster.tracks.find(t=>t.id===event.trackIds[0]).name;
      app.querySelector(".course-facts b").innerHTML=eventCourse.distanceM.toLocaleString()+"<small>m</small>";
      app.querySelector(".entry-footnote").textContent=`参加費：無償 ${event.fee.freeCoins} コイン / 開始時に消費。キャンセル時は消費しません。`;
      const normal=document.createElement("button");normal.className="text-button";normal.id="entry-normal";normal.textContent="通常レースに切り替える →";
      app.querySelector(".rank-card-content").append(normal);normal.onclick=()=>{selectEvent(null);ctx.refresh();};
    }
    const entry=app.querySelector('.rank-card [data-go="7"]'), base=entry.onclick;
    entry.onclick=()=>{
      base();const d=document.querySelector("dialog"), start=d.querySelector("#match-start"), original=start.onclick;
      if(event){d.querySelector(".match-course h3").textContent=event.name;d.querySelector(".match-course .status-pill").textContent="EVENT / "+eventCourse.distanceM.toLocaleString()+"m";d.querySelector("#match-status").textContent=`開始時に無償 ${event.fee.freeCoins} コインを消費します。`;start.disabled=campaignState(event)!=="active"||freeBalance()<event.fee.freeCoins;}
      start.onclick=()=>{if(!d.open)return;if(!beginRace(event)){d.querySelector("#match-status").textContent="開催期間または無償残高が変わりました。条件を確認してください。";return;}original();};
    };
  }

  function openHub(tab, source) {
    track("campaign_view", { source });
    const d = dialog("相棒と、毎日を楽しもう。", `<div class="campaign-tabs" aria-label="クラブ特典の種類">${[["welcome","7日間のギフト"],["event","イベント"],["pass","30日クラブパス"]].map(([id,label]) => `<button data-campaign-tab="${id}" aria-pressed="${tab === id}">${label}</button>`).join("")}</div><div id="campaign-body"></div>`);
    prepareCampaignDialog(d, "campaign-dialog");
    const reopen = tab => { d.close();ctx.refresh();app.querySelector("#campaign-menu").click();document.querySelector(`[data-campaign-tab="${tab}"]`).click(); };
    const paint = t => {
      tab = t; state = load();
      d.querySelectorAll("[data-campaign-tab]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.campaignTab === t)));
      const body = d.querySelector("#campaign-body");
      if (t === "welcome") {
        const count = state.days.length, claimed = state.days.includes(dateKey()), done = count === 7;
        body.innerHTML = `<div class="welcome-header"><div><span class="journey-kicker">SEVEN VISITS. YOUR OWN STORY.</span><h3>会いにくるたび、<br>新しい楽しみを。</h3><p>連続ログインは不要。受け取った回数で進みます。</p></div>${art("silks-wings")}</div><div class="welcome-progress"><span>${count} / 7 回受取済み</span><div role="progressbar" aria-label="ギフトの受取回数" aria-valuemin="0" aria-valuemax="7" aria-valuenow="${count}"><i style="width:${count/7*100}%"></i></div><small>日本時間で1日1回</small></div><ol class="welcome-days">${progression.loginBonus.map((r,i) => `<li class="${i < count ? "claimed" : i === count ? "next" : ""}"><span>${i < count ? icon("check") : `DAY ${r.day}`}</span>${rewardArt(r)}<b>${rewardLabel(r)}</b><small>${i < count ? "受取済み" : i === count ? claimed ? "次回のギフト" : "今日受け取れます" : `${i + 1}回目に`}</small></li>`).join("")}</ol><div class="welcome-claim"><div><b>${done ? "すべてのギフトを受け取りました" : claimed ? "今日も、会いにきてくれてありがとう。" : "今日のギフトを、あなたのクラブへ。"}</b><p>${done ? "相棒との物語は、これからも続きます。" : claimed ? "次の日本時間0:00以降に、続きを受け取れます。" : "間が空いても、進み具合は失われません。"}</p></div><button class="primary" id="claim-welcome" ${claimed || done ? "disabled" : ""}>${done ? "全7回 受取済み" : claimed ? "本日受取済み" : "無料で受け取る"} ${icon("check")}</button></div><details class="campaign-conditions"><summary>受取条件・これまでの記録</summary><p>1日1回、日本時間で切り替わります。7回受け取るまで継続。連続日数の条件はありません。現在はこのブラウザ内のデモ受取です。アイテムは所持品に反映されます。</p><ul>${state.days.map((date,i) => `<li>${date} · ${rewardLabel(progression.loginBonus[i])}</li>`).join("") || "<li>まだ受け取りはありません。</li>"}</ul></details>`;
        body.querySelector("#claim-welcome").onclick = () => {
          const fresh = load();
          if (fresh.days.includes(dateKey()) || fresh.days.length >= 7) { paint("welcome"); return; }
          const r = progression.loginBonus[fresh.days.length]; fresh.days.push(dateKey()); save(fresh);
          track("welcome_claim", { day: fresh.days.length });
          d.close();
          if (r.freeCoins) ctx.addCoins(r.freeCoins); else ctx.refresh();
          app.querySelector("#campaign-menu").click();
          ctx.toast(`${rewardLabel(r)} をデモで受け取りました`);
        };
      } else if (t === "event") {
        const event = eventMaster.events[0], status = campaignState(event);
        const course = trackMaster.tracks.find(c => c.id === event.trackIds[0]);
        body.innerHTML = `<div class="event-feature"><span class="journey-kicker">AOBA SPRINT CUP</span><span class="event-status">${{active:"開催期間中",upcoming:"開催予定",ended:"開催終了"}[status]}</span><h3>${event.name}</h3><p>短い直線に、あなたの一手を。</p><span>${campaignDate(event.startAtMs)} — ${campaignDate(event.endAtMs)} JST</span></div><div class="event-facts"><span>コース<b>${course.name}</b></span><span>参加条件<b>クラス制限なし</b></span><span>参加費<b>無償 ${event.fee.freeCoins} コイン / 1走</b></span></div><h4 class="campaign-subhead">走るたび、次の目標が見える。</h4><ol class="event-milestones">${event.milestones.map(m => `<li><b>${m.points.toLocaleString()}<small> pt</small></b><span>${m.reward.freeCoins ? `無償コイン ×${m.reward.freeCoins}` : `配合素材 ×${m.reward.items[0].qty}`}</span></li>`).join("")}</ol><p class="campaign-copy">着順ポイントに参加ポイント＋${event.points.participation}pt。ランキング報酬はイベント終了時の順位に応じて決まります。</p><details class="campaign-conditions"><summary>ランキング報酬と開催条件</summary><ul>${event.rankRewards.map(r => `<li>${r.maxRank === null ? "その他の参加者" : `${r.maxRank}位以内`} · 無償コイン ×${r.reward.freeCoins}</li>`).join("")}</ul><p>日程・条件・報酬はイベントマスターの暫定値。ブラウザデモはイベント対戦に未接続です。</p></details><div class="event-action"><span>${status === "ended" ? "このイベントは終了しました。" : status === "upcoming" ? "開催開始までお待ちください。" : "イベント対戦は準備中。通常レースを体験できます。"}</span><button class="secondary" id="campaign-race">通常のレースへ ${icon("arrow")}</button></div>`;
        const club = readClub(), points = club.eventPoints[event.id] || 0;
        const progress = document.createElement("div"); progress.className = "event-live-progress";
        progress.innerHTML = `<span class="journey-kicker">YOUR EVENT RECORD / LOCAL DEMO</span><b>${points.toLocaleString()} pt</b><p>イベントを選んで完走すると累積します。ランキング報酬は未接続です。</p>`;
        body.querySelector(".event-milestones").before(progress);
        body.querySelectorAll(".event-milestones li").forEach((li, i) => {
          const button = document.createElement("button"), claimed = club.eventClaims[`${event.id}:${i}`];
          button.className = "small-button"; button.dataset.eventClaim = i;
          button.disabled = claimed || points < event.milestones[i].points || status !== "active";
          button.textContent = claimed ? "受取済み" : points >= event.milestones[i].points ? "受け取る" : "目標まであと " + (event.milestones[i].points-points) + " pt";
          li.append(button);
          button.onclick = () => { if (claimEvent(event, i)) reopen("event"); };
        });
        body.querySelector(".event-action > span").textContent = status === "active" ? "ブラウザ内のイベント体験。実際のランキングには反映されません。" : status === "upcoming" ? "開催開始までお待ちください。" : "このイベントは終了しました。";
        const join = document.createElement("button"); join.className="primary";join.id="event-enter";
        join.disabled = status !== "active" || freeBalance() < event.fee.freeCoins;
        join.textContent = status !== "active" ? "受付期間外" : freeBalance() < event.fee.freeCoins ? "無償コインが足りません" : "イベントの出走確認へ";
        body.querySelector(".event-action").append(join);
        join.onclick = () => { selectEvent(event.id);d.close();go(6); };
        body.querySelector("#campaign-race").onclick = () => { selectEvent(null);d.close();go(6); };
      } else {
        body.innerHTML = `<div class="pass-detail-hero"><div><span class="journey-kicker">THIRTY DAYS OF YOUR CLUB</span><h3>一戦ごとに、<br>楽しみが増える。</h3><p>炎の勝負服と、パスレベルごとの追加報酬。</p><strong>¥${products.season_pass.priceYen.toLocaleString()}<small>税込 / 購入から30日・自動更新なし</small></strong></div>${art("silks-flame")}</div><div class="pass-how"><span><b>01</b> レースに出走</span><span><b>02</b> 1走＋${progression.passXpPerRace} XP</span><span><b>03</b> ${progression.passXpPerLevel} XPで1レベル</span></div><table class="pass-comparison"><caption>無料とクラブパスの受取内容</caption><thead><tr><th scope="col">内容</th><th scope="col">無料</th><th scope="col">クラブパス</th></tr></thead><tbody><tr><th scope="row">レベルごと</th><td>無償 ${progression.passRewards.free.reward.freeCoins}</td><td>さらに無償 ${progression.passRewards.premium.reward.freeCoins}<br>配合素材 ×1</td></tr><tr><th scope="row">炎の勝負服</th><td>—</td><td>購入時に1点</td></tr><tr><th scope="row">レベル上限</th><td>${progression.passMaxLevel}</td><td>${progression.passMaxLevel}</td></tr></tbody></table><p class="campaign-copy">追加報酬はパスレベルの到達が条件です。上限までの一括付与ではありません。無料の報酬は購入せず受け取れます。</p><div class="product-price"><span><b>¥${products.season_pass.priceYen.toLocaleString()}</b><small>税込・一回購入</small></span><button class="primary" id="pass-checkout">内容を確認する ${icon("arrow")}</button></div><p class="quiet">販売・報酬の接続前の画面プレビューです。絵はデザイン見本です。</p>`;
        const club = readClub(), level = Math.min(progression.passMaxLevel, Math.floor(club.xp / progression.passXpPerLevel));
        const active = club.passUntil > Date.now();
        const freeCount = Array.from({length:level},(_,i)=>i+1).filter(l=>!club.freeLevels.includes(l)).length;
        const premiumCount = Array.from({length:level},(_,i)=>i+1).filter(l=>!club.premiumLevels.includes(l)).length;
        const panel = document.createElement("section"); panel.className="pass-progress-panel";
        panel.innerHTML=`<div class="pass-progress-title"><h4>あなたのクラブ Lv.${level}</h4><span>${active ? "パス体験中 · " + campaignDate(club.passUntil) + " JSTまで" : club.passUntil ? "パス体験は終了しました" : "無料の報酬から始められます"}</span></div><div class="pass-xp" role="progressbar" aria-label="パス累積XP" aria-valuenow="${club.xp}" aria-valuemin="0" aria-valuemax="${progression.passXpPerLevel*progression.passMaxLevel}"><i style="width:${club.xp/(progression.passXpPerLevel*progression.passMaxLevel)*100}%"></i></div><p>累計 ${club.xp} XP · ${level===progression.passMaxLevel ? "最大レベル到達" : "次のレベルまで " + (progression.passXpPerLevel-club.xp%progression.passXpPerLevel) + " XP"} · 完走 ${club.completed} 回</p><div class="pass-levels">${Array.from({length:5},(_,i)=>Math.max(1,Math.min(level-1,progression.passMaxLevel-4))+i).map(l=>`<div class="pass-level ${l<=level?"reached":""}"><b>Lv.${l}</b><span>無償 ${progression.passRewards.free.reward.freeCoins}</span><small>${club.freeLevels.includes(l)?"無料分受取済み":l<=level?"受取可能":"未到達"}</small></div>`).join("")}</div><div class="pass-claim-actions"><button class="secondary" id="claim-pass-free" ${freeCount?"":"disabled"}>無料分 ${freeCount} 件を受け取る</button><button class="primary" id="claim-pass-premium" ${active&&premiumCount?"":"disabled"}>${active?"パス分 "+premiumCount+" 件を受け取る":"パス体験で追加報酬"}</button></div>`;
        body.querySelector(".pass-how").after(panel);
        panel.querySelector("#claim-pass-free").onclick=()=>{if(claimPass("free",progression))reopen("pass");};
        panel.querySelector("#claim-pass-premium").onclick=()=>{if(claimPass("premium",progression))reopen("pass");};
        body.querySelector("#pass-checkout").onclick = () => buy("season_pass", source);
      }
    };
    d.querySelectorAll("[data-campaign-tab]").forEach(b => b.onclick = () => { paint(b.dataset.campaignTab); track("campaign_tab", { source: b.dataset.campaignTab }); });
    paint(tab);
  }
}
