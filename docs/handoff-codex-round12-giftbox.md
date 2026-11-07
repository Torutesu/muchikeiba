# Round 12 Codex 向け引き継ぎ：プレゼントボックスの画面（REQ-BOX-001〜014）

更新：2026-11-07　基準ブランチ：`feat/r12-giftbox`（`claude/round11`）
仕様：`contracts/protocol.md` §26、`docs/spec/requirements.md` 26章、UX：`docs/planning/06-ux-experience-spec.md` §6.15、法務：`docs/planning/03-legal-risk.md`「プレゼントボックス」、経済：`docs/spec/balance-targets.md` 4.13

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/gift-box`・`POST /v1/gift-box/:giftId/claim`・`POST /v1/gift-box/claim-all`、`GET /v1/player` と bootstrap の `giftBox`（バッジ）、期限・上限・保留、KPI `gift_receive` / `gift_claim` / `gift_expire`、通知 `gift_arrived` |
| 届くもの | 運営のお詫び・配布、招待ボーナス（招待した側）、イベントの順位報酬、大会の賞品、支部・支部対抗・シーズンの報酬（protocol §26.1 の表）。ログボ・ミッション・パス・実績などはこれまでどおりその場の画面で受け取る |
| C# | ✅ `ApiClient.GetGiftBoxAsync` / `ClaimGiftAsync` / `ClaimAllGiftsAsync`、`GiftEntry.DaysLeft(nowMs)`、`PlayerView.GiftBox`、`PushPreferences.Gifts`、エラー `GiftExpired` / `GiftHoldCap` |
| ゲーム層 | ✅ `Muchi.Game.GiftBoxModel`（`unity/Assets/Muchi/Game/GiftBoxModel.cs`、チェック `unity/Checks~/GameChecks/GiftBoxChecks.cs`）、`HomeModel.GiftBadge` |
| 見本 | ✅ `tools/figma-prototype/site/index.html?demo=gifts`（その他 → デモでも可）。ホームの封筒 → ボックス |
| **Codex** | ホームの封筒とバッジ（§2）、ボックスの画面（§3）、受け取り結果（§4）、履歴（§5）、音・触覚（§6） |

## 2. ホームの封筒とバッジ

- 位置：ホームの上の財布の**左**（見本は x 1088・y 33・80×77、財布と同じ紺のガラス）。封筒は**シアンの線画**（塗らない）。
- バッジ：`HomeModel.GiftBadge`（= `PlayerView.GiftBox.Unclaimed`）。0 ならバッジなし。1〜99 は数字、100 以上は「99+」。**金色の丸に紺の数字**（ミッションの「受け取れます」の金の点と同じ色）。
- バッジを点滅させたり揺らしたりしない（急かす演出はしない。03「プレゼントボックス」）。新しく届いた時に一度だけ小さく弾む（0.2秒・1回）は可。
- 押したら `GiftBoxModel.LoadAsync("box")` でボックスの画面へ。

## 3. ボックスの画面（「ムチ一閃」のトーン）

見本と同じ1600×900の構図。**写真の背景（`Art/home-paddock`）を全面に、紺のパネルは2枚、主ボタン（斜めのシアン »）は1つ**。

- 上：タイトル帯「プレゼントボックス」＋1行の説明、財布、EN。
- 左パネル（一覧）：タブ「ボックス」「履歴」（`Tab`）。1行＝`GiftRow`：
  - 小さな字間の広いラベル `SourceLabels[Source]`（お詫びは**金**、それ以外は**シアン**）
  - 表示名 `Title`（＋ `RankText`「2位」があれば「　·　2位」）
  - 中身 `Lines`（「無償コイン300枚　·　スカウト券×1」）。アイテムのアイコン（`AssetKeys` の item）を左に小さく並べてもよい
  - 右：期限 `ExpiryText`（「あと3日」）と日付。**`ExpiryText == null` の行には何も出さない**（期限なし）。`ExpiringSoon` は金色にするだけ（赤・点滅・「急いで」などは不可）
  - `HeldText`（保留の理由）は黄色の小さい字で行の下に
  - 右端に「受け取る」（`CanClaim` の時だけ、紺にシアン枠の小ボタン）→ `ClaimAsync(giftId)`
  - 6行ずつ。`HasMore` なら「次へ」で `LoadMoreAsync()`（見本はページ送り）
- 右パネル：「受け取り待ち」と件数（`Badge`）、3日以内の件数、主ボタン **「まとめて受け取る »」**（`CanClaimAll` の時だけ）→ `ClaimAllAsync()`。その下に `Notice`（期限・上限・有償コインは入らない）。
- 空：`EmptyText`（「プレゼントはありません」）。主ボタンは出さない。
- 削除の予約中（`Blocked`）：ボタンを全部消して `BlockedText` を赤で（実績の画面と同じ）。
- オフライン：`LoadAsync` の `Message` を出す（「プレゼントボックスはオンラインで表示されます」）。

## 4. 受け取り結果

- `ClaimAsync` / `ClaimAllAsync` が成功したら、中央のダイアログ（紺のガラス）で `LastResult` を出す：
  - 見出し `Toast`（「3件のプレゼントを受け取りました」）
  - `ResultLines`（「無償コイン450枚」「スカウト券×1」、保留があれば「アイテムの持てる上限のため、1件はボックスに残しました」）
  - 主ボタン「つづける »」で一覧へ（モデルは一覧を読み直し済み）
- 演出：封筒が開いて中身（コイン・券のアイコン）が財布の方へ飛ぶ 0.6〜0.8秒。**数字は `LastResult.TotalFreeCoins` / `TotalItems` のとおり**（演出で数字を増やして見せない）。コインの枚数で演出の量を変えない（大きく見せない）。
- 失敗：`Message` をトースト（`GIFT_HOLD_CAP`「持てる上限に達しているため、受け取れません。」・`GIFT_EXPIRED`）。通信の失敗のあとに同じボタンを押すと、モデルが同じ冪等キーで送り直す（二重に受け取らない）ので、ボタンはすぐ押せる状態に戻してよい。

## 5. 履歴

- タブ「履歴」：直近90日の受け取り済み・期限切れ。各行は `StatusText`（受け取り済み＝緑、期限切れ＝灰）と日付。ボタンは無い。
- 期限切れの行を目立たせない（灰色のまま）。

## 6. 音・触覚

- 封筒を開く：軽い紙の音。受け取り：コインの小さな音1回（枚数で長くしない）。触覚は弱い1回。
- 保留・失敗：音なし（トーストだけ）。

## 7. 文言・言語

- 画面の日本語はモデルとサーバーから来る（`Loc.T` を通す）。英語は `engine/Muchi.Client/Resources/Muchi/ui-en.json` と `server-en.json` にある（`GiftBoxChecks`・`L10nChecks` で確認済み）。英語では長くなる（「Apology for the maintenance」）ので、表示名は1行に収まらなければ縮める（見本の fitText と同じ）。
- 使わない言葉：「今だけ」「残りわずか」「お得」「倍」、偽の残り時間。期限は実際の `expiresAt` だけ。

## 8. 確認

- `dotnet run --project 'unity/Checks~/GameChecks'` の「プレゼントボックス」が全部 ok。
- 見本：`node tools/figma-prototype/test/e2e.cjs` の `u-*-gift-*` と `en-*-gift-*` のスクリーンショット。
