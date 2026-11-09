# Round 12 Codex 向け引き継ぎ：コイン不足の案内（T6、REQ-SHORT-001〜010）

更新：2026-11-07　基準ブランチ：`feat/r12-coin-shortfall`（`claude/round11` から）
仕様：`contracts/protocol.md` §29、`docs/spec/requirements.md` 29章、`docs/planning/06-ux-experience-spec.md` §5.1 T6

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。経済の目標（E 番号）は増えていない（コインを配る機能ではない）。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ コインで払う操作がコイン不足で失敗すると 409 `INSUFFICIENT_COINS` に `details.shortfall`。試す前は `GET /v1/shop/shortfall?for=gacha|cosmetic|coins`。文言（見出し・1文・注意）はサーバーが作り、英語は応答の境界で訳す |
| C# | ✅ `InsufficientCoinsException.Shortfall`（`CoinShortfall`）、`ApiClient.GetCoinShortfallForGachaAsync` / `GetCoinShortfallForCosmeticAsync` / `GetCoinShortfallAsync`（`engine/Muchi.Client/Shortfall.cs`） |
| ゲーム層 | ✅ `Muchi.Game.CoinShortfallModel`（`unity/Assets/Muchi/Game/ShortfallModel.cs`）、`GachaBackend.LastShortfall`・`ItemsBackend.LastShortfall`。チェックは `unity/Checks~/GameChecks/ShortfallChecks.cs` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → スカウト →「有償限定のステップアップ」→「10回引く（500）」（無償コインしか無いデモの人）。`__muchi.show('Shortfall', 'paid' | 'any' | 'free')` で3つの状態。英語は EN ボタン |
| **Codex** | シート（§2）、パックのカード（§3）、つなぎ方（§4）、出さない場面の配線（§5）、演出（§6） |

## 2. シートの構成（「ムチ一閃」のトーン）

見本と同じ1600×900の構図。前の画面の写真（スカウトなら `Art/scout-reveal`、見た目なら `Art/home-paddock`）を暗くした上に、**紺の半透明のダイアログ1枚**（約1080×660）。

- 上：小さな字間の広いシアンのラベル（`有償コイン　/　足りない枚数`。`CoinShortfall.CoinKind` が `any` なら `コイン`、`free` なら `無償コイン`）とシアンの短い罫。
- 見出し：`CoinShortfallModel.Headline`（例「有償コインが1,200枚足りません」）を白・太字・大きく1行。**数字はサーバーの文のまま**（クライアントで組み立てない）。
- その下に小さく `必要 {Need}　·　使えるコイン {Have}`、`Notes`（例「有償コインだけで支払います（無償コインは使えません）」「購入の前に、生年月を確認します」）。
- パックのカード（§3）を**1枚だけ**。
- 一番下に **「閉じる」を主ボタン（斜めのシアン »）**。06 §5.1：閉じるが一番目立つ。パックのカードのボタンは小さいシアン（`購入を確認`）。
- 補足の1行（小さく）：「購入するとこの画面の前の操作に戻ります　·　有償コインから先に使われます」。
- **使わない**：「倍」「お得」「今だけ」「残りわずか」「通常価格」、残り時間・カウントダウン、点滅・揺れで急がせる演出、値引きの見せ方。

## 3. パックのカード（`CoinShortfallModel.Pack`、`ProductCard`）

| 表示 | 値 |
|---|---|
| 左の写真 | ショップのコインのパックと同じ素材（見本は `Art/Cosmetics/stable-plaque`） |
| 名前・価格 | `Name`（「コイン1,660」）・`PriceText`（「¥2,400」、金色・右寄せ） |
| 中身 | `Lines`（「有償コイン1,660枚」） |
| 初回購入ボーナス | `BonusLabel`（ある時だけ。**ショップと同じ文**「はじめての購入時のみ：無償コイン1,660枚をプレゼント」。シアン） |
| 足りるか | `CoinShortfallModel.Line`。足りる時（`Shortfall.Offer.Covers`）は緑の小さな文、足りない時（一番大きいパックでも足りない）は金の文「いちばん大きいコイン7,400（¥10,000）でも、あと◯枚足りません」 |
| ボタン | `購入を確認`（`Pack.Purchasable == false` なら暗くして `DisabledReason`） |

`Pack == null`（無償コインのみの支払い・今月の上限・未精算の返金・削除の手続き中）の時はカードの代わりに `Line` の1文だけを出す。**パックを出さない**。

## 4. つなぎ方（画面の配線）

1. **スカウトの確認**：引く前に `await sheet.PreviewAsync(ShortfallOrigin.Gacha(bannerId, count), ShortfallContext.ScoutConfirm)`。true ならシートを出し、引かない。false なら `GachaBackend.DrawAsync`。
2. それでも失敗した（別の端末で使った等）時：`DrawAsync` の答えが `InsufficientCoins` なら `sheet.FromError(gacha.LastShortfall, ShortfallContext.ScoutConfirm, origin)`。見た目は `ItemsBackend.BuyAsync` の後に `items.LastShortfall`（`ShortfallContext.CosmeticShop`、`ShortfallOrigin.Cosmetic(itemId)`）。
3. シートを描いたら `sheet.Shown()`（KPI `offer_view`、`offerId: "shortfall"`、`trigger: "T6"`。同じシートで何度呼んでも1回）。
4. カードのボタン：`var productId = sheet.Choose()`（KPI `offer_click`）→ **既存の購入確認** `PurchaseConfirmModel.OpenAsync(productId)`（生年月・保護者の同意・今月の上限の手順はそのまま）。
5. 購入確認が終わったら `var back = sheet.AfterPurchase(stage)`。`Completed` なら `back` に元の操作（`Kind` が `gacha` なら `BannerId`/`Count`、`cosmetic` なら `ItemId`）が入るので、**その操作をもう一度行う**（スカウトはもう一度確認から）。キャンセル・確認中・失敗ではシートに戻る。
6. 「閉じる」：`sheet.Close()` して元の画面へ。

## 5. 出さない場面（必ず守る、06 §5.1）

`CoinShortfallModel.Allowed(ctx)` が true なのは `ScoutConfirm`・`CosmeticShop`・`Shop` だけ。**レース中（観戦・リプレイも）・マッチング中・チュートリアル中・負けた直後の結果画面**では、`FromError` / `PreviewAsync` を呼んでもシートは出ない（`Visible == false`、KPI も送らない）。画面側でも該当の `ShortfallContext`（`Race` / `Matchmaking` / `Tutorial` / `AfterLoss`）を正しく渡すこと。チュートリアルの無料スカウトはコインを使わないので対象外。

## 6. 演出（お願いしたいこと）

- 開く：ダイアログが下から 16px ほど上がりながらフェードイン（0.2秒、他のダイアログと同じ `rise`）。背景の写真は 0.2秒で暗く。
- 見出しの数字だけ、0.3秒で 0 → 足りない枚数へカウントアップしてよい（**点滅・赤い警告色・揺れは使わない**）。
- 購入が完了して元の操作へ戻る時は、シートを閉じるのと同じ動き（0.15秒のフェードアウト）→ 元の画面。スカウトはいつもの演出へ。
- 音：開く時は通常のダイアログ音。購入を急がせる効果音は付けない。

## 7. 一緒に直したこと（Round 8 / Round 11 の残り）

- R11：初心者・シーズンの「集める」ミッションの コンプガチャ防止（2つ以上のルール）が、SR以上確定券（スターターパック）の抽選表も数えるようになった。有償の抽選の一覧は `server/src/domain/paidRandom.ts` の `paidRandomTemplates` 1つだけ（図鑑・実績の検査も同じ関数）。
- R8：購入済みの表示。Unity の `ShopModel` は購入済みのパス・1回限りのパック・受け取り中の厩舎手当を買えるようには描かない（GameChecks で確認）。見本の「おすすめ」タブで、**購入済みの昇級記念パックが「昇級すると購入できます」と出ていた**のを「購入済み」に直し、購入済みのスターターパックの注記も「購入済みです（1回限り）」にした。
