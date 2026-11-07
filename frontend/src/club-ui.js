import { openScoutConfirm, openBreeding } from "./paddock.js";
import { collection } from "./collection.ts";
import { icon } from "./icons.js";
import { itemLabels } from "./commerce.js";
import { readClub, equipped, outfits, equip } from "./club-state.js";
import "./club.css";
const safe = value => String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const initialArts = ["crimson", "azure", "violet"];
const itemArt = id => outfits[id]?.art || (/ticket/.test(id) ? "/campaign/art/ticket-sr.svg" : "/creative/items/premium-feed.svg");
function frame(d) {
  d.classList.add("club-dialog");
  const header = document.createElement("div"); header.className = "campaign-top";
  header.append(...Array.from(d.children).slice(0,3)); d.prepend(header);
  d.querySelector(".close").focus({preventScroll:true}); d.scrollTop=0;
}
export function openWardrobe(ctx, index = ctx.selected) {
  const { dialog, horseArt, app } = ctx;
  let preview = equipped(index), tab = "outfits";
  const d = dialog("相棒と、好きな装いで。", `<div class="club-tabs"><button data-club-tab="outfits" aria-pressed="true">勝負服</button><button data-club-tab="items" aria-pressed="false">アイテム</button><label>相棒 <select id="wardrobe-partner">${ctx.horses.map((h,i)=>`<option value="${i}" ${index===i?"selected":""}>${safe(i===0 ? ctx.horse : h[0])} / ${h[1]}</option>`).join("")}</select></label></div><div id="club-body"></div>`);
  frame(d);
  const stageArt = () => horseArt("variant-"+index).replace(/data-outfit="[^"]*"/, `data-outfit="${preview}"`);
  function paint() {
    const s = readClub(), body = d.querySelector("#club-body");
    d.querySelectorAll("[data-club-tab]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.clubTab===tab)));
    if(tab==="items") {
      const entries = Object.entries(s.items).filter(([,n])=>n>0);
      if(collection().materials.awakening>0)entries.push(["awakening_material",collection().materials.awakening]);
      body.innerHTML = `<div class="inventory-heading"><span class="journey-kicker">YOUR CLUB / INVENTORY</span><h3>受け取った楽しみが、ここに。</h3><p>このブラウザ内の体験用アイテムです。</p></div>${entries.length ? `<div class="inventory-grid">${entries.map(([id,n])=>`<article class="inventory-item"><img src="${itemArt(id)}" alt="" width="100" height="100"><div><h4>${itemLabels[id] || id}</h4><span>デモ所持 <b>×${n}</b></span><button class="text-button" data-item-info="${id}">用途を見る ${icon("arrow")}</button></div></article>`).join("")}</div>` : '<div class="inventory-empty"><img src="/creative/states/reward-claimed.svg" alt="" width="180" height="140"><h3>最初のギフトを、クラブへ。</h3><p>クラブ特典から無料ギフトを受け取れます。</p><button class="secondary" id="inventory-gifts">無料ギフトを見る</button></div>'}<div class="demo-wallet">体験用有償コイン <b>${s.paid.toLocaleString()}</b><span>実際の有償残高ではありません。</span></div>`;
      body.querySelector("#inventory-gifts")?.addEventListener("click",()=>{d.close(); app.querySelector("#campaign-menu").click();});
      body.querySelectorAll("[data-item-info]").forEach(b=>b.onclick=()=>{
        const id=b.dataset.itemInfo;
        const info=dialog(itemLabels[id] || id, `<div class="item-info-art"><img src="${itemArt(id)}" alt="" width="128" height="128"></div><p>${outfits[id] ? "勝負服タブで選び、相棒の配色プレビューに反映できます。能力値は変わりません。" : /ticket/.test(id) ? "スカウトで相棒と出会うためのチケットです。確認画面から使用できます。コインは消費しません。" : "相棒にまつわる素材です。覚醒素材は馬詳細で使えます。現在の配合計算は配合素材を消費しません。"}</p><p class="quiet">デモ所持数 ×${id==="awakening_material"?collection().materials.awakening:s.items[id]}</p>`);
        if(/ticket/.test(id)){const b=document.createElement("button");b.className="primary";b.id="inventory-ticket-use";b.textContent="このチケットを使う →";info.append(b);b.onclick=()=>openScoutConfirm(ctx,{ticket:id});}
        if(id==="breeding_material"){const b=document.createElement("button");b.className="secondary";b.textContent="配合を見る →";info.append(b);b.onclick=()=>openBreeding(ctx);}
        if(id==="awakening_material"){const b=document.createElement("button");b.className="secondary";b.textContent="厩舎で覚醒する →";info.append(b);b.onclick=()=>{info.close();ctx.go(5);};}
      });
      return;
    }
    const owned = preview==="default" || s.items[preview]>0, same=equipped(index)===preview;
    body.innerHTML = `<div class="wardrobe-layout"><section class="wardrobe-model"><span class="journey-kicker">THOROUGHBRED / FITTING ROOM</span>${stageArt()}<p>3Dは配色プレビュー。柄は衣装カードで確認できます。</p></section><section class="wardrobe-choice"><div class="wardrobe-title"><span class="journey-kicker">YOUR RACING COLORS</span><h3>ゲートの先にも、<br>自分らしさを。</h3><p>好きな一着を選んで、相棒に。</p></div><div class="outfit-grid">${Object.entries(outfits).map(([id,o])=>`<button class="outfit-option" data-costume="${id}" aria-pressed="${preview===id}"><img src="${o.art || '/creative/items/silks-'+initialArts[index % 3]+'.svg'}" alt="" width="90" height="90"><b>${o.label}</b><small>${id===equipped(index) ? "装備中" : id==="default" || s.items[id]>0 ? "デモ所持" : "未所持・試着できます"}</small></button>`).join("")}</div><div class="wardrobe-summary" role="status"><b>${outfits[preview].label}</b><span>${owned ? same ? "この相棒に装備中です。" : "この相棒に保存できます。" : preview==="costume_login" ? "無料ギフトの3回目で入手できます。" : "商品の内容確認後、任意でデモ体験できます。"}</span></div><button class="primary" id="equip-outfit" ${!owned || same ? "disabled" : ""}>${same ? "装備中" : owned ? "この勝負服にする" : "未所持・試着のみ"} ${icon("check")}</button><button class="text-button" id="wardrobe-source">${preview==="costume_login" ? "無料ギフトを見る" : "コレクションを見る"} ${icon("arrow")}</button></section></div>`;
    body.querySelectorAll("[data-costume]").forEach(b=>b.onclick=()=>{preview=b.dataset.costume;paint();});
    body.querySelector("#equip-outfit").onclick=()=>{
      if(!equip(index,preview)) return;
      d.close();ctx.refresh();ctx.toast("勝負服を保存しました。3Dには配色を反映します。");
    };
    body.querySelector("#wardrobe-source").onclick=()=>{d.close();if(preview==="costume_login")app.querySelector("#campaign-menu").click();else ctx.go(9);};
  }
  d.querySelectorAll("[data-club-tab]").forEach(b=>b.onclick=()=>{tab=b.dataset.clubTab;paint();});
  d.querySelector("#wardrobe-partner").onchange=e=>{index=Number(e.target.value);preview=equipped(index);paint();};
  paint();
}
export function mountClub(ctx) {
  const button=document.createElement("button");button.id="club-open";button.className="campaign-menu";button.setAttribute("aria-label","所持品と勝負服");button.innerHTML=`${icon("stable")}<span>所持品</span>`;
  ctx.app.querySelector(".wallet").prepend(button);button.onclick=()=>openWardrobe(ctx);
  const money=ctx.app.querySelector(".club-money");money.innerHTML=`体験有償 <b>${readClub().paid.toLocaleString()}</b>`;
  const storePaid=ctx.app.querySelector(".store-balance b");if(storePaid)storePaid.textContent="体験有償 "+readClub().paid.toLocaleString();
  if(ctx.current===4){const b=document.createElement("button");b.className="text-button home-wardrobe";b.id="wardrobe-open";b.innerHTML=`${icon("spark")} 勝負服を選ぶ`;ctx.app.querySelector(".hero-copy").append(b);b.onclick=()=>openWardrobe(ctx);}
}
