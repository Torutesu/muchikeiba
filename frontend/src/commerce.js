import productMaster from "../../server/master/products.json";

export const products = Object.fromEntries(productMaster.products.map(p => [p.id, p]));
export const itemLabels = {
  ticket_sr_plus: "SR以上スカウトチケット",
  gacha_ticket: "スカウトチケット",
  breeding_material: "配合素材",
  costume_starter: "スターター勝負服・稲妻",
  costume_season_limited: "シーズン勝負服・炎",
  costume_login: "ログイン勝負服・翼",
};
export function productName(p) {
  return p.kind === "starter" ? "ファーストパートナーセット" : p.kind === "season_pass" ? "30日クラブパス" : `${p.paidCoins.toLocaleString()}有償コイン`;
}
export function productContents(p) {
  const rows = [];
  if (p.paidCoins) rows.push(["有償コイン", `${p.paidCoins.toLocaleString()} コイン`]);
  if (p.kind === "coins") rows.push(["初回購入ボーナス（無償）", `${p.paidCoins.toLocaleString()} コイン`]);
  for (const item of p.items || []) rows.push([itemLabels[item.itemId] || item.itemId, `×${item.qty}`]);
  return rows;
}
export function openCheckout(id, { dialog, coins, track = () => {} }) {
  const p = products[id];
  if (!p) return;
  track("checkout_open", { product: id });
  const maxMonth = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(new Date());
  const d = dialog("購入内容の確認", `<div class="checkout-product"><span>YOUR CLUB COLLECTION</span><h3>${productName(p)}</h3><strong>¥${p.priceYen.toLocaleString()}<small>税込・一回購入</small></strong></div><dl class="spec-list">${productContents(p).map(([k,v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}<div><dt>現在の無償残高</dt><dd>${coins.toLocaleString()} コイン</dd></div></dl>${p.kind === "season_pass" ? '<p class="checkout-terms">購入から30日間。自動更新なし。レースでパスレベルを上げると追加報酬を受け取れます。</p>' : p.once ? '<p class="checkout-terms">1アカウント1回。セット内容は確定。チケット利用時の個別の馬は抽選です。</p>' : '<p class="checkout-terms">初回購入時のボーナスは無償コインです。通常分とボーナスを分けて表示しています。</p>'}<label class="field-label" for="birth-detail">生年月 <span>年齢確認</span></label><input class="name-input" id="birth-detail" type="month" max="${maxMonth}" aria-describedby="purchase-help"><p id="purchase-help" class="quiet" role="status">生年月は保存・送信されません。年齢別上限は正式提供前に確定します。</p><label class="purchase-consent"><input id="purchase-consent" type="checkbox"> 内容・税込価格と、決済されないデモであることを確認しました</label><div class="checkout-actions"><button class="secondary" id="purchase-cancel">戻る</button><button class="primary" id="purchase-review" disabled>¥${p.priceYen.toLocaleString()} の内容を確認 <span>✓</span></button></div><p class="quiet checkout-caption">この操作で決済・購入・アイテム付与は行いません。</p>`);
  const birth = d.querySelector("#birth-detail"), check = d.querySelector("#purchase-consent"), btn = d.querySelector("#purchase-review");
  const validate = () => {
    const valid = !!birth.value && birth.checkValidity();
    birth.setAttribute("aria-invalid", String(!!birth.value && !valid));
    btn.disabled = !(valid && check.checked);
    d.querySelector("#purchase-help").textContent = birth.value && !valid ? "現在以前の生年月を入力してください。" : "生年月は保存・送信されません。年齢別上限は正式提供前に確定します。";
  };
  birth.oninput = validate;
  check.onchange = validate;
  d.querySelector("#purchase-cancel").onclick = () => d.close();
  btn.onclick = () => {
    if (btn.disabled) return;
    track("checkout_preview_complete", { product: id });
    dialog("購入内容を確認しました", '<div class="confirmation-mark">✓</div><h3>ご確認ありがとうございます。</h3><p>決済・コインの追加・生年月の保存は行っていません。</p>');
  };
}
