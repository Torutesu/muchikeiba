import {
  collection,
  roster,
  collectionMaster,
  scout,
  lastScout,
  odds,
  pityExchange,
  previewPair,
  breedPair,
  retireOwned,
  awakenOwned,
  renameOwned,
  validateHorseName,
  horsePedigree,
  styleLabel,
  surfaceLabel,
} from "./collection.ts";
import { readClub, freeBalance } from "./club-state.js";
import { effectiveStats, BREED } from "../../server/src/domain/horses";
import { STAT_KEYS } from "../../contracts/master-values";
import "./paddock.css";
const safe = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = {
  speed: "スピード",
  stamina: "スタミナ",
  burst: "瞬発力",
  guts: "勝負根性",
  temper: "折り合い",
};
const sex = (h) => (h.sex === "male" ? "牡馬" : "牝馬");
const jpError = (e) =>
  ({
    INSUFFICIENT_COINS: "必要なコイン・覚醒素材が足りません。",
    INSUFFICIENT_ITEMS:
      "チケットがありません。受取済みの所持品を確認してください。",
    HORSE_NOT_RETIRED: "父馬・母馬には引退した相棒を選んでください。",
    BREEDING_INVALID_PAIR: "父馬と母馬の組合せを確認してください。",
    BREEDING_DAILY_LIMIT:
      "本日の配合は完了しています。次の日本時間0:00から再開できます。",
    TUTORIAL_GACHA_USED:
      "初回スカウトは受取済みです。前回の結果から確認できます。",
    PITY_INSUFFICIENT: "交換に必要なポイントが足りません。",
    AWAKENING_MAX: "最大覚醒に到達しています。",
    INVALID_NAME:
      "カタカナ2〜9文字で入力してください。先頭の「ー」は使えません。",
    NG_NAME: "この名前は使用できません。別の名前を入力してください。",
    LAST_ACTIVE:
      "最後の現役馬は残してください。新しい相棒を迎えてから引退できます。",
  })[e.code] ||
  "操作を完了できませんでした。状態を確認して、もう一度お試しください。";
const jst = () =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
function frame(d, extra = "") {
  d.classList.add("paddock-dialog");
  if (extra) d.classList.add(extra);
  const h = document.createElement("div");
  h.className = "campaign-top";
  h.append(...Array.from(d.children).slice(0, 3));
  d.prepend(h);
  d.querySelector(".close").focus({ preventScroll: true });
  d.scrollTop = 0;
  return d;
}
const announce = (d, error) => {
  let p = d.querySelector("[data-operation-error]");
  if (!p) {
    p = document.createElement("p");
    p.dataset.operationError = "";
    p.className = "operation-error";
    p.setAttribute("role", "alert");
    d.append(p);
  }
  p.textContent = jpError(error);
};
function currentHorse(id) {
  return collection().horses.find((h) => h.id === id);
}
export function openOdds(ctx, banner = "standard") {
  const info = odds(banner);
  let mode = "normal",
    filter = "all";
  const d = frame(
    ctx.dialog(
      "提供内容を、ひとつずつ。",
      `<div class="odds-intro"><span class="journey-kicker">SCOUT DISCLOSURE / ${safe(info.bannerId)}</span><h3>${safe(info.name)}</h3><p>相棒ごとの提供割合と確定枠の条件を確認できます。数値は体験版の設定です。</p></div><div class="odds-summary">${Object.entries(
        info.rarityTotals,
      )
        .map(([r, v]) => `<div><span>${r}</span><b>${v.rate}</b></div>`)
        .join(
          "",
        )}</div><div class="paddock-controls"><div><button data-odds-mode="normal" aria-pressed="true">通常枠</button><button data-odds-mode="guarantee" aria-pressed="false">SR以上確定枠</button></div><label>レアリティ <select id="odds-filter"><option value="all">すべて</option><option>SSR</option><option>SR</option><option>R</option></select></label></div><p id="odds-condition" class="quiet"></p><div class="odds-scroll"><table class="odds-table"><thead><tr><th>相棒</th><th>レアリティ</th><th>提供割合</th></tr></thead><tbody></tbody></table></div><div class="product-note">10連は1〜9枠目にSR以上が出なかった場合だけ、10枠目を確定枠で抽選します。重複は覚醒素材へ変換：R ×${info.duplicates.R} / SR ×${info.duplicates.SR} / SSR ×${info.duplicates.SSR}。</div>`,
    ),
  );
  const paint = () => {
    const rows = mode === "normal" ? info.items : info.guarantee.items;
    d.querySelector("tbody").innerHTML = rows
      .filter((r) => filter === "all" || r.rarity === filter)
      .map(
        (r) =>
          `<tr><td>${safe(r.name)}</td><td><span class="rarity-label">${r.rarity}</span></td><td>${r.rate}</td></tr>`,
      )
      .join("");
    d.querySelector("#odds-condition").textContent =
      mode === "guarantee"
        ? info.guarantee.appliesTo
        : "各相棒の割合を合算すると100%です。";
    d.querySelectorAll("[data-odds-mode]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.oddsMode === mode)),
    );
  };
  d.querySelectorAll("[data-odds-mode]").forEach(
    (b) =>
      (b.onclick = () => {
        mode = b.dataset.oddsMode;
        paint();
      }),
  );
  d.querySelector("#odds-filter").onchange = (e) => {
    filter = e.target.value;
    paint();
  };
  paint();
}
export function openScoutResults(ctx, order) {
  if (!order) return;
  const open = new Set();
  const d = frame(
    ctx.dialog(
      "出会いの続きを、ここから。",
      `<div class="reveal-heading"><div><span class="journey-kicker">YOUR PADDOCK / SCOUT RESULT</span><h3>${order.count}頭の、新しい可能性。</h3><p>カードを選んで開封できます。結果と所持は保存済みです。</p></div><button class="secondary" id="reveal-all">すべて開く</button></div><div class="scout-results reveal-grid"></div><div class="reveal-summary" role="status"></div><div class="reveal-actions"><button class="secondary" id="scout-stable">厩舎で会う →</button><button class="primary" id="finish-scout">ホームへ（あとで確認） →</button></div><p class="quiet">重複は覚醒素材に変換済みです。閉じても、次回のスカウトまで結果を確認できます。</p>`,
    ),
    "reveal-dialog",
  );
  const paint = () => {
    d.querySelector(".reveal-grid").innerHTML = order.results
      .map((r, i) => {
        const t = collectionMaster.templateById.get(r.templateId);
        const model = collectionMaster.templates.indexOf(t) % 3;
        return `<button class="pull-card reveal-card ${open.has(i) ? "revealed" : ""} ${r.rarity === "R" ? "" : "rare"}" data-reveal="${i}" aria-label="${open.has(i) ? safe(t.name) : `${i + 1}枚目を開く`}" aria-pressed="${open.has(i)}">${open.has(i) ? `<small>${r.rarity}${r.guaranteed ? " / 確定枠" : ""}</small><img src="/art/partner-${model}.webp" alt="" width="180" height="140"><b>${safe(t.name)}</b><em>${r.duplicate ? "覚醒素材 ＋" + r.material : "NEW / 厩舎に追加"}</em><span>${styleLabel[t.style]} · ${sex(t)}</span>` : `<div class="sealed-card"><img src="/creative/brand/crest-forest.svg" alt="" width="70" height="70"><span>PARTNER ${String(i + 1).padStart(2, "0")}</span><b>開いて出会う</b></div>`}</button>`;
      })
      .join("");
    d.querySelectorAll("[data-reveal]").forEach(
      (b) =>
        (b.onclick = () => {
          const i = Number(b.dataset.reveal);
          if (open.has(i)) return;
          open.add(i);
          paint();
          d.querySelector(`[data-reveal="${i}"]`).focus({
            preventScroll: true,
          });
        }),
    );
    const n = order.results.filter((r) => !r.duplicate).length,
      material = order.results.reduce((n, r) => n + r.material, 0);
    d.querySelector(".reveal-summary").textContent =
      `開封 ${open.size} / ${order.count}　新しい相棒 ${n}頭 · 覚醒素材 ＋${material}`;
    d.querySelector("#finish-scout").textContent =
      open.size === order.count ? "ホームへ戻る →" : "ホームへ（あとで確認） →";
  };
  d.querySelector("#reveal-all").onclick = () => {
    order.results.forEach((_, i) => open.add(i));
    paint();
    d.querySelector("#reveal-all").disabled = true;
  };
  d.querySelector("#finish-scout").onclick = () => {
    d.close();
    ctx.go(4);
  };
  d.querySelector("#scout-stable").onclick = () => {
    d.close();
    ctx.go(5);
  };
  d.addEventListener("close", () => ctx.refresh());
  paint();
}
export function openScoutConfirm(
  ctx,
  { count = 1, ticket = null, tutorial = false, banner = "standard" } = {},
) {
  const b = collectionMaster.gacha.banners.find((b) => b.id === banner),
    price = tutorial || ticket ? 0 : count === 10 ? b.priceTen : b.priceSingle,
    c = readClub(),
    paid = Math.min(price, c.paid),
    free = price - paid,
    can = tutorial
      ? !collection().flags.tutorialGachaUsed
      : ticket
        ? (c.items[ticket] || 0) > 0
        : c.paid + freeBalance() >= price;
  const key = crypto.randomUUID();
  const d = frame(
    ctx.dialog(
      "出会いの前に、内容を確認。",
      `<div class="scout-order-art"><img src="/campaign/art/ticket-sr.svg" alt="" width="140" height="110"><div><span class="journey-kicker">YOUR NEXT PARTNER</span><h3>${ticket === "ticket_sr_plus" ? "SR以上チケット" : ticket ? "スカウトチケット" : tutorial ? "初回無料10連" : count + "回スカウト"}</h3><p>${count === 10 ? "SR以上が1頭以上。重複は覚醒素材へ。" : "1頭との出会い。重複は覚醒素材へ。"}</p></div></div><dl class="spec-list"><div><dt>使用するもの</dt><dd>${ticket ? "チケット ×1" : price ? "有償 " + paid + " / 無償 " + free + " コイン" : "コイン消費なし"}</dd></div><div><dt>現在の残高</dt><dd>体験有償 ${c.paid.toLocaleString()} / 無償 ${freeBalance().toLocaleString()}</dd></div>${!ticket ? `<div><dt>スカウト後</dt><dd>体験有償 ${Math.max(0, c.paid - paid)} / 無償 ${Math.max(0, freeBalance() - free)}</dd></div>` : ""}</dl><p class="scout-order-note">有償コインから先に使用します。チケット・コインの消費と結果の保存は、この先のボタンを押した時に行います。</p>${!can ? '<p class="operation-error" role="status">必要なコインまたはチケットが足りません。無料ギフトや所持品を確認してください。</p>' : ""}<div class="checkout-actions"><button class="secondary" id="draw-cancel">戻る</button><button class="primary" id="draw-confirm" ${can ? "" : "disabled"}>${ticket ? "チケットを使って出会う" : price ? price + "コインで出会う" : "無料で10頭に出会う"} →</button></div><p class="quiet">ブラウザ内の体験です。消費内容と提供割合を確認して進めてください。</p>`,
    ),
  );
  d.querySelector("#draw-cancel").onclick = () => d.close();
  d.querySelector("#draw-confirm").onclick = () => {
    if (!d.open) return;
    const btn = d.querySelector("#draw-confirm");
    btn.disabled = true;
    try {
      const result = scout({ banner, count, ticket, tutorial, key });
      if (tutorial) ctx.markScouted?.();
      d.close();
      openScoutResults(ctx, result);
    } catch (e) {
      announce(d, e);
      btn.disabled = false;
    }
  };
}
function parentCard(ctx, h, label) {
  const index = collection().horses.findIndex((x) => x.id === h.id);
  return `<article class="parent-card"><span>${label} / ${sex(h)}</span><img src="/art/partner-${index % 3}.webp" alt="" width="200" height="150"><h4>${safe(h.name)}</h4><p>${h.rarity} · ${styleLabel[h.style]} · 引退済み</p><small>${safe(h.line)}系</small></article>`;
}
export function openBreeding(ctx, initial = {}) {
  let sire = initial.sire || null,
    dam = initial.dam || null;
  const d = frame(
    ctx.dialog("次の世代へ、物語をつなぐ。", '<div id="breeding-body"></div>'),
    "breeding-dialog",
  );
  function paint() {
    const s = collection(),
      body = d.querySelector("#breeding-body"),
      dad = s.horses.find((h) => h.id === sire),
      mom = s.horses.find((h) => h.id === dam),
      limited =
        s.breeding.date === jst() &&
        s.breeding.count >= collectionMaster.progression.breedingPerDay;
    let forecast = null;
    if (dad && mom)
      try {
        forecast = previewPair(sire, dam);
      } catch {}
    body.innerHTML = `<div class="breeding-intro"><span class="journey-kicker">BLOODLINES / THE NEXT CHAPTER</span><h3>受け継ぐ個性。<br>生まれる、新しい可能性。</h3><p>引退した父馬と母馬の個性から、次の相棒へ。</p></div><ol class="breeding-steps"><li class="${sire && dam ? "complete" : "current"}">01 親を選ぶ</li><li class="${forecast ? "current" : ""}">02 予測を確かめる</li><li>03 新しい相棒へ</li></ol><div class="parent-pair"><button id="choose-sire" aria-label="父馬を選ぶ">${dad ? parentCard(ctx, dad, "SIRE") : '<span class="parent-placeholder">♂<b>父馬を選ぶ</b><small>引退した牡馬</small></span>'}</button><span class="pair-link">×</span><button id="choose-dam" aria-label="母馬を選ぶ">${mom ? parentCard(ctx, mom, "DAM") : '<span class="parent-placeholder">♀<b>母馬を選ぶ</b><small>引退した牝馬</small></span>'}</button></div>${forecast ? `<section class="breeding-forecast"><div class="forecast-heading"><h4>相棒の可能性を、先に知る。</h4><span>${forecast.nick ? "系統の相性良好" : "標準の組合せ"}</span></div><div class="forecast-stats">${STAT_KEYS.map((k) => `<div><span>${labels[k]}</span><div class="forecast-track"><i style="left:${forecast.stats[k].min / 10}%;width:${(forecast.stats[k].max - forecast.stats[k].min) / 10}%"></i></div><b>${forecast.stats[k].min}–${forecast.stats[k].max}</b></div>`).join("")}</div><div class="forecast-facts"><span>得意距離<b>${forecast.distance.minM.toLocaleString()}–${forecast.distance.maxM.toLocaleString()}m</b></span><span>系統相性<b>${forecast.nick ? "ニックス ＋" + collectionMaster.nicks.bonus : "補正なし"}</b></span><span>共通祖先<b>${forecast.inbreedingCount}件${forecast.inbreedingCount ? " / 近親補正あり" : ""}</b></span></div><p class="quiet">能力の変動幅は±${BREED.variation}。実際の結果には個体差があります。</p></section>` : '<div class="forecast-empty"><img src="/creative/states/breeding-locked.svg" alt="" width="140" height="110"><p>父馬と母馬を選ぶと、能力の範囲と相性が見えます。</p></div>'}<div class="breeding-footer"><div><b>${limited ? "本日の配合は完了しています" : "1日" + collectionMaster.progression.breedingPerDay + "回 / 日本時間で更新"}</b><p>親は引退状態のまま残ります。この配合は素材・コインを消費しません。</p></div><button class="primary" id="breed-review" ${forecast && !limited ? "" : "disabled"}>この組合せを確認する →</button></div>`;
    body.querySelector("#choose-sire").onclick = () => picker("male");
    body.querySelector("#choose-dam").onclick = () => picker("female");
    body.querySelector("#breed-review").onclick = () => {
      const key = crypto.randomUUID();
      const confirm = frame(
        ctx.dialog(
          "このふたりから、次の物語へ。",
          `<div class="breeding-confirm-pair">${parentCard(ctx, dad, "SIRE")}${parentCard(ctx, mom, "DAM")}</div><dl class="spec-list"><div><dt>本日の配合回数</dt><dd>${s.breeding.date === jst() ? s.breeding.count : 0} / ${collectionMaster.progression.breedingPerDay}</dd></div><div><dt>消費コイン・素材</dt><dd>なし</dd></div><div><dt>親の扱い</dt><dd>引退状態で残ります</dd></div></dl><p class="product-note">確定すると本日分の配合を1回使用し、新しい相棒が厩舎に加わります。能力と性別は誕生時に決まります。</p><div class="checkout-actions"><button class="secondary" id="breed-back">組合せに戻る</button><button class="primary" id="breed-confirm">この組合せで配合する →</button></div>`,
        ),
      );
      confirm.querySelector("#breed-back").onclick = () => {
        confirm.close();
        openBreeding(ctx, { sire, dam });
      };
      confirm.querySelector("#breed-confirm").onclick = () => {
        if (!confirm.open) return;
        confirm.querySelector("#breed-confirm").disabled = true;
        try {
          const result = breedPair(sire, dam, key);
          confirm.close();
          openFoal(ctx, result.foal);
        } catch (e) {
          announce(confirm, e);
        }
      };
    };
  }
  function picker(gender) {
    const eligible = collection().horses.filter(
      (h) => h.sex === gender && h.status === "retired",
    );
    const p = frame(
      ctx.dialog(
        gender === "male"
          ? "物語を受け継ぐ、父馬を。"
          : "物語を受け継ぐ、母馬を。",
        `<p class="parent-picker-note">引退した${gender === "male" ? "牡馬" : "牝馬"}を選べます。現役馬は馬詳細から引退できます。</p>${eligible.length ? `<div class="parent-picker">${eligible.map((h) => `<button data-parent="${h.id}">${parentCard(ctx, h, gender === "male" ? "SIRE" : "DAM")}<span>この相棒を選ぶ →</span></button>`).join("")}</div>` : '<div class="inventory-empty"><img src="/creative/states/stable-empty.svg" alt="" width="180" height="140"><h3>選べる相棒がまだいません。</h3><p>厩舎で相棒の詳細を確認し、引退した相棒を選びましょう。</p></div>'}<button class="secondary" id="parent-back">配合へ戻る</button>`,
      ),
    );
    p.querySelectorAll("[data-parent]").forEach(
      (b) =>
        (b.onclick = () => {
          if (gender === "male") sire = b.dataset.parent;
          else dam = b.dataset.parent;
          p.close();
          openBreeding(ctx, { sire, dam });
        }),
    );
    p.querySelector("#parent-back").onclick = () => {
      p.close();
      openBreeding(ctx, { sire, dam });
    };
  }
  paint();
}
function openFoal(ctx, foal) {
  const index = collection().horses.findIndex((h) => h.id === foal.id),
    d = frame(
      ctx.dialog(
        "はじめまして、新しい相棒。",
        `<div class="foal-hero"><span class="journey-kicker">A NEW LIFE / YOUR NEXT PARTNER</span><span class="foal-image-note">誕生イメージ</span><div><span>${foal.rarity} / ${sex(foal)}</span><h3>ふたつの物語が、<br>ひとつの未来に。</h3></div></div><div class="foal-parents"><span>父 <b>${safe(foal.sireName)}</b></span><span>母 <b>${safe(foal.damName)}</b></span></div><label class="field-label" for="foal-name">相棒の名前 <span>カタカナ2〜9文字</span></label><input class="name-input" id="foal-name" value="ミメイ" maxlength="18" aria-describedby="foal-name-help"><p class="quiet" id="foal-name-help">あとから変更できます。</p><div class="checkout-actions"><button class="secondary" id="foal-later">名前はあとで</button><button class="primary" id="name-foal">名前を贈って厩舎へ →</button></div>`,
      ),
      "foal-dialog",
    );
  const input = d.querySelector("#foal-name"),
    btn = d.querySelector("#name-foal");
  const validate = () => {
    try {
      const value = validateHorseName(input.value);
      d.querySelector("#foal-name-help").textContent =
        `${value} / ${Array.from(value).length}文字`;
      input.setAttribute("aria-invalid", "false");
      btn.disabled = false;
    } catch (e) {
      d.querySelector("#foal-name-help").textContent = jpError(e);
      input.setAttribute("aria-invalid", "true");
      btn.disabled = true;
    }
  };
  input.oninput = validate;
  btn.onclick = () => {
    try {
      const h = renameOwned(foal.id, input.value);
      d.close();
      ctx.go(5);
      ctx.toast(h.name + " が厩舎に加わりました");
    } catch (e) {
      announce(d, e);
    }
  };
  d.querySelector("#foal-later").onclick = () => {
    d.close();
    ctx.go(5);
  };
  validate();
}
export function openHorseRecord(ctx, id) {
  const h = currentHorse(id),
    s = collection(),
    index = s.horses.findIndex((x) => x.id === id),
    stats = effectiveStats(collectionMaster, h),
    cost = collectionMaster.progression.awakeningCost[h.awakening];
  const d = frame(
    ctx.dialog(
      safe(h.name) + " の記録",
      `<div class="horse-record-head">${ctx.horseArt("variant-" + index)}<div><span class="journey-kicker">PARTNER RECORD / ${safe(id)}</span><h3>${safe(h.name)}</h3><p>${h.rarity} · ${sex(h)} · ${styleLabel[h.style]}</p><span class="status-pill">${h.status === "active" ? "現役" : "引退済み"} / 覚醒 ${h.awakening}</span></div></div><div class="record-actions"><button class="secondary" id="record-name">名前を変更</button><button class="secondary" id="record-pedigree">血統を見る</button></div><section class="awakening-panel"><div><span class="journey-kicker">AWAKENING</span><h4>重ねた出会いを、力に。</h4><p>所持する覚醒素材 ${s.materials.awakening} / 必要 ${cost ?? "最大到達"}</p></div><div class="awakening-stats">${STAT_KEYS.map((k) => `<div><span>${labels[k]}</span><b>${stats[k]} <i>→</i> ${cost ? Math.min(1000, Math.floor((h.base[k] * (1000 + (h.awakening + 1) * collectionMaster.progression.awakeningStatPermillePerLevel)) / 1000)) : stats[k]}</b></div>`).join("")}</div><button class="primary" id="awaken-confirm" ${cost && s.materials.awakening >= cost ? "" : "disabled"}>${!cost ? "最大覚醒に到達" : s.materials.awakening < cost ? "覚醒素材があと" + (cost - s.materials.awakening) + "必要" : "素材 " + cost + " 個で覚醒する"} →</button></section><div class="retirement-section"><div><b>次の世代へつなぐ、引退。</b><p>引退すると出走できなくなります。配合の親として選べるようになります。</p></div><button class="text-button" id="retire-review" ${h.status === "retired" ? "disabled" : ""}>${h.status === "retired" ? "引退済み" : "引退について確認する"} →</button></div>`,
    ),
  );
  d.querySelector("#record-name").onclick = () => {
    const n = frame(
      ctx.dialog(
        "この名前と、これからも。",
        `<label class="field-label" for="record-name-input">相棒の名前 <span>カタカナ2〜9文字</span></label><input id="record-name-input" class="name-input" maxlength="18" value="${safe(h.name)}" aria-describedby="record-name-help"><p id="record-name-help" class="quiet"></p><button class="primary" id="record-name-save">この名前にする →</button>`,
      ),
    );
    const input = n.querySelector("input"),
      btn = n.querySelector("#record-name-save");
    input.oninput = () => {
      try {
        validateHorseName(input.value);
        btn.disabled = false;
        n.querySelector("p").textContent =
          "ひらがな・半角カナはカタカナに整えます。";
      } catch (e) {
        btn.disabled = true;
        n.querySelector("p").textContent = jpError(e);
      }
    };
    input.oninput();
    btn.onclick = () => {
      try {
        renameOwned(id, input.value);
        n.close();
        ctx.refresh();
        ctx.toast("相棒の名前を保存しました");
      } catch (e) {
        announce(n, e);
      }
    };
  };
  d.querySelector("#record-pedigree").onclick = () => openPedigree(ctx, id);
  d.querySelector("#awaken-confirm").onclick = () => {
    try {
      awakenOwned(id);
      d.close();
      ctx.refresh();
      openHorseRecord(ctx, id);
    } catch (e) {
      announce(d, e);
    }
  };
  d.querySelector("#retire-review").onclick = () => {
    const confirm = frame(
      ctx.dialog(
        "引退の前に、確かめてください。",
        `<h3 class="retire-horse-name">${safe(h.name)}</h3><p>引退した相棒はレースに出走できません。厩舎と血統の記録は残り、配合の親として選べます。現役には戻せません。</p><label class="purchase-consent"><input type="checkbox" id="retire-consent">出走できなくなることを確認しました</label><div class="checkout-actions"><button class="secondary" id="retire-back">現役のまま戻る</button><button class="primary" id="retire-confirm" disabled>この相棒を引退する</button></div>`,
      ),
    );
    confirm.querySelector("#retire-back").onclick = () => {
      confirm.close();
      openHorseRecord(ctx, id);
    };
    confirm.querySelector("#retire-consent").onchange = (e) =>
      (confirm.querySelector("#retire-confirm").disabled = !e.target.checked);
    confirm.querySelector("#retire-confirm").onclick = () => {
      try {
        retireOwned(id);
        confirm.close();
        ctx.refresh();
        ctx.toast("相棒の記録を引退済みに更新しました");
      } catch (e) {
        announce(confirm, e);
      }
    };
  };
}
export function openPedigree(ctx, id) {
  const root = horsePedigree(id),
    levels = [[root]];
  for (let i = 0; i < 3; i++)
    levels.push(levels[i].flatMap((n) => (n ? [n.sire, n.dam] : [null, null])));
  const d = frame(
    ctx.dialog(
      "受け継いだ名前を、たどる。",
      `<div class="pedigree-intro"><span class="journey-kicker">BLOODLINE ARCHIVE / FIVE GENERATIONS</span><h3>${safe(root.name)} の血統</h3><p>名前が分かる祖先のみ表示しています。横にスクロールして確認できます。</p></div><div class="pedigree-scroll" tabindex="0" role="region" aria-label="血統図"><div class="pedigree-tree">${levels.map((level, i) => `<div class="pedigree-generation"><span>${i === 0 ? "相棒" : i + "代前"}</span>${level.map((n) => `<div class="pedigree-node ${n ? "" : "unknown"}"><b>${safe(n?.name || "記録なし")}</b><small>${n?.horseId ? "厩舎の記録" : n ? "名前の記録" : "—"}</small></div>`).join("")}</div>`).join("")}</div></div><details class="campaign-conditions"><summary>5代の記録について</summary><p>父母・祖父母など、記録された血統から最大5代まで表示します。分からない血統を補って表示することはありません。</p></details>`,
    ),
  );
  return d;
}
export function mountPaddock(ctx) {
  if (ctx.current === 3) {
    const s = collection(),
      club = readClub(),
      b = collectionMaster.gacha.banners[0];
    if (s.flags.tutorialGachaUsed || ctx.profile?.scouted) {
      const welcome = ctx.app.querySelector(".scout-panel");
      welcome.classList.add("scout-welcome-complete");
      welcome.querySelector("h2").textContent =
        "次の出会いを、あなたのクラブへ。";
      welcome.querySelector(".scout-copy>p").textContent =
        "初回無料10連は受取済みです。常設スカウトやチケットから、次の相棒に出会えます。";
      const note = ctx.app.querySelector(".scout-notes>div:last-child p");
      if (note)
        note.innerHTML =
          "<b>出会いを重ねる</b>重複は覚醒素材へ。相棒の記録から活用できます。";
    }

    const panel = document.createElement("section");
    panel.className = "scout-lounge";
    panel.innerHTML = `<div class="scout-lounge-head"><div><span class="journey-kicker">THE PADDOCK / ALWAYS A NEW STORY</span><h2>次に惹かれるのは、どんな個性だろう。</h2><p>常設スカウト。出会った相棒は厩舎へ、重複は覚醒素材に。</p></div><span class="pity-count">${s.pity.standard || 0}<small> / ${collectionMaster.gacha.pityGroups.standard.cost} pt</small></span></div><div class="scout-options"><button class="scout-option" data-scout-count="1"><span>SINGLE SCOUT</span><b>一頭との出会い</b><small>${b.priceSingle} コイン →</small></button><button class="scout-option ten" data-scout-count="10"><span>TEN PARTNERS</span><b>十頭の可能性</b><small>${b.priceTen.toLocaleString()} コイン / SR以上1頭以上 →</small></button><button class="scout-option" id="ticket-scout"><span>YOUR TICKETS</span><b>チケットで出会う</b><small>通常 ${club.items.gacha_ticket || 0} / SR以上 ${club.items.ticket_sr_plus || 0} →</small></button></div><div class="scout-lounge-foot"><span>重複による覚醒素材 <b>${s.materials.awakening}</b> 個</span><button class="text-button" id="last-scout" ${lastScout() ? "" : "disabled"}>前回の結果を見る →</button><button class="text-button" id="scout-odds">提供割合と確定枠 →</button><button class="text-button" id="scout-pity">ポイント交換 →</button></div>`;
    ctx.app.querySelector(".scout-panel").after(panel);
    panel
      .querySelectorAll("[data-scout-count]")
      .forEach(
        (btn) =>
          (btn.onclick = () =>
            openScoutConfirm(ctx, { count: Number(btn.dataset.scoutCount) })),
      );
    panel.querySelector("#scout-odds").onclick = () => openOdds(ctx);
    panel.querySelector("#last-scout").onclick = () =>
      openScoutResults(ctx, lastScout());
    panel.querySelector("#ticket-scout").onclick = () => {
      const c = readClub(),
        d = frame(
          ctx.dialog(
            "預かったチケットを、出会いへ。",
            `<div class="ticket-choice"><button id="ticket-standard" ${c.items.gacha_ticket ? "" : "disabled"}><img src="/campaign/art/ticket-sr.svg" alt="" width="100" height="80"><b>スカウトチケット</b><span>所持 ${c.items.gacha_ticket || 0}枚 / 1枚使用</span></button><button id="ticket-sr" ${c.items.ticket_sr_plus ? "" : "disabled"}><img src="/campaign/art/ticket-sr.svg" alt="" width="100" height="80"><b>SR以上チケット</b><span>所持 ${c.items.ticket_sr_plus || 0}枚 / 1枚使用</span></button></div><p class="product-note">SR以上チケットは常設スカウトの確定枠の割合で抽選します。コインは消費しません。チケット利用では交換ポイントは増えません。</p>`,
          ),
        );
      d.querySelector("#ticket-standard").onclick = () =>
        openScoutConfirm(ctx, { ticket: "gacha_ticket" });
      d.querySelector("#ticket-sr").onclick = () =>
        openScoutConfirm(ctx, { ticket: "ticket_sr_plus" });
    };
    panel.querySelector("#scout-pity").onclick = () => {
      const d = frame(
        ctx.dialog(
          "重ねた出会いを、次の一頭へ。",
          `<p class="pity-balance">所持 <b>${collection().pity.standard || 0}</b> pt / 交換 ${collectionMaster.gacha.pityGroups.standard.cost} pt</p><div class="pity-targets">${b.pityTargets.map((id) => `<button data-pity="${id}" ${(collection().pity.standard || 0) >= collectionMaster.gacha.pityGroups.standard.cost ? "" : "disabled"}><b>${safe(collectionMaster.templateById.get(id).name)}</b><small>${collectionMaster.templateById.get(id).rarity} / ${collectionMaster.gacha.pityGroups.standard.cost}ptで交換</small></button>`).join("")}</div><p class="quiet">重複の場合は、同じレアリティの覚醒素材に変換されます。</p>`,
        ),
      );
      d.querySelectorAll("[data-pity]").forEach(
        (btn) =>
          (btn.onclick = () => {
            const id = btn.dataset.pity,
              t = collectionMaster.templateById.get(id),
              owned = collection().horses.some((h) => h.templateId === id),
              cost = collectionMaster.gacha.pityGroups.standard.cost;
            const confirm = frame(
              ctx.dialog(
                "この相棒との出会いを、確かめる。",
                `<div class="product-story"><span class="journey-kicker">PADDOCK POINT EXCHANGE</span><h3>${safe(t.name)} / ${t.rarity}</h3></div><dl class="spec-list"><div><dt>消費ポイント</dt><dd>${cost} pt</dd></div><div><dt>交換後</dt><dd>${Math.max(0, (collection().pity.standard || 0) - cost)} pt</dd></div><div><dt>受取内容</dt><dd>${owned ? "重複のため覚醒素材 ×" + collectionMaster.gacha.duplicateMaterial[t.rarity] : "新しい相棒 1頭"}</dd></div></dl><div class="checkout-actions"><button class="secondary" id="pity-back">戻る</button><button class="primary" id="pity-confirm">${cost}ptで交換する →</button></div>`,
              ),
            );
            confirm.querySelector("#pity-back").onclick = () => {
              confirm.close();
              ctx.app.querySelector("#scout-pity").click();
            };
            confirm.querySelector("#pity-confirm").onclick = () => {
              if (!confirm.open) return;
              confirm.querySelector("#pity-confirm").disabled = true;
              try {
                pityExchange(id);
                confirm.close();
                ctx.refresh();
                ctx.toast("ポイント交換を反映しました");
              } catch (e) {
                announce(confirm, e);
              }
            };
          }),
      );
    };
  }
}
