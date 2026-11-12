# Round 22 Codex 向け引き継ぎ：使いすぎ・遊びすぎの防止（自分で決める上限、REQ-LIMIT-001〜022）

更新：2026-11-11　基準ブランチ：`feat/r22-self-limits`（`origin/claude/round20` から）
仕様：`contracts/protocol.md` §67（と §13.2・§29.2・§33.1・§46.2・§58.11・§61.1 の追記）、`docs/spec/requirements.md` 67章、`docs/planning/06-ux-experience-spec.md` 末尾「補足（Round 22）」、`docs/planning/03-legal-risk.md` 末尾。経済の目標なし（コイン・アイテムは動かない、E 番号なし）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル・時間の数え方）／Codex＝見た目と呼び出し（画面・シート・アプリの前面／背面の通知）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/self-limits`・`PUT /v1/self-limits/spending`・`DELETE /v1/self-limits/spending/pending`・`PUT /v1/self-limits/playtime`（メンテナンスでも閉じない）。購入の確認 `POST /v1/shop/purchase-intent` が自分の上限を超えると `409 SELF_LIMIT_EXCEEDED`（`details`：`selfLimitYen`・`monthSpentYen`・`priceYen`・`month`・`settings: "self_limits"`）。確認の応答に `selfLimitYen`・`effectiveLimitYen`・`selfLimitBinding`・`selfLimitPending`。履歴の見出し `GET /v1/history/summary` に `selfLimitText` ほか。ブートストラップ／`GET /v1/player` に `selfLimits`（遊ぶ時間の設定と効いている上限）。コイン不足の案内は上限を超えるパックを出さない（`blockedCode: "SELF_LIMIT_EXCEEDED"`）。1回限りの案内は上限を超える商品で `showPopup: false`・`selfLimitBlocked: true` |
| C# | ✅ `engine/Muchi.Client/SelfLimits.cs`：`SelfLimitsView`・`SpendingLimitView`（`IsValidAmount`・`AppliesNow`）・`PlaytimeView`・`SelfLimitsDigest`（`PlayerView.SelfLimits`）・`PlaytimeReminderPolicy.Decide`（サーバーと同じ、`contracts/self-limits.vectors.json`）・`PlaytimeClock`・`SelfLimitExceededException`（`PurchaseBlockedException` の子）・`ApiClient.GetSelfLimitsAsync / SetSpendingLimitAsync / CancelSpendingRaiseAsync / SetPlaytimeAsync`・`AnalyticsEvent.PlaytimeReminderShown`。`PurchaseIntent.SelfLimit*`、`HistorySummary.SelfLimit*`、`PurchaseRecord.SelfLimitBreach`、`HelpContexts.SelfLimits` |
| ゲーム層 | ✅ `Muchi.Game.SelfLimitsModel`（`unity/Assets/Muchi/Game/SelfLimitsModel.cs`、チェック `unity/Checks~/GameChecks/SelfLimitsChecks.cs`）。`UxText.Errors["SELF_LIMIT_EXCEEDED"]`。英語は `ui-en.json`、シートの文は policy が日本語・英語の両方を持つ |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：その他 › 設定・サポート › 購入・コイン・ガチャ履歴 › 「上限の設定」（`__muchi.show('SelfLimits')`）、購入が断られた状態（`__muchi.show('SelfLimitRefused')`）、遊ぶ時間のシート（`__muchi.show('PlaytimeSheet')`、またはシートの画面の「デモ：60分遊んだことにする」→ ホーム） |
| ヘルプ | ✅ 記事 `self_limits`（文脈 `self_limits`、画面 `self_limits`）、ヒント `self_limits`（ショップの話題） |
| **Codex** | 画面（§2）、購入の確認と断られた時（§3）、遊ぶ時間のシートと呼び出し（§4）、入口（§5）、文字の大きさ・英語（§6） |

## 2. 画面「使いすぎ・遊びすぎの防止」（`SelfLimitsModel`）

ムチ一閃の見た目：パドックの写真の背景を暗くし、紺の半透明の面を左右に2枚、水色の小さな字間の広い見出し（`SpendingKicker`「月の購入上限」／`PlaytimeKicker`「遊ぶ時間のお知らせ」）。主ボタン（水色の斜めの「»」）は**置かない**（どの選択も押し付けない）。

| 部品 | モデル | 描き方 |
|---|---|---|
| いまの状態 | `View.Spending.StatusText`（「自分で決めた上限 ¥3,000（今月の残り ¥600）」／「自分で決めた上限はありません」） | 左の面の最初の行、白・太字 |
| 年齢と効いている上限 | `View.Spending.AgeLimitYen`・`EffectiveLimitYen`・`MonthSpentYen` | 小さな灰色の1行 |
| 金額の選択 | `SpendingRows`（`Label`・`Current`・`WhenText`「すぐに効きます」／「72時間後に効きます」） | 3列の選択ボタン（`choice` の見た目、今の額が `on`）。押す前に `WhenText` を見せる（長押しかボタンの下の小さな字） |
| 自分で入力 | `View.Spending.IsValidAmount(n)`（刻み・範囲・年齢帯の上限） | 数字だけの入力欄＋「この金額にする」（副ボタン）。弾いたら「この金額は選べません」 |
| 待っている変更 | `View.Spending.PendingText`・`CanCancelRaise`・`CancelRaiseAsync()` | 金色の1行＋「変更を取り消す」（副ボタン） |
| 決まり | `View.Spending.RulesText` | 小さな灰色の行（4行） |
| 遊ぶ時間 | `SessionRows`・`DailyRows`・`QuietRows`（先頭が「使わない」） | 3段の選択ボタン。`SetPlaytimeAsync(values, session, daily, quietAfter)` は変えた段だけ送る |
| ヘルプ | `HelpContexts.SelfLimits` | 右下のテキストリンク |

- 保存の結果（`ActionResult.Message`）はトースト。引き上げは `PendingText`（「〜から効きます（取り消せます）」）。
- オフライン：読み込み・保存は「上限の設定はオンラインで変えられます」。

## 3. 購入の確認と断られた時

- **確認のシート**（`PurchaseIntent`）：年齢帯の上限の行の下に、`SelfLimitYen` があれば水色の小さな行「自分で決めた上限 ¥X　·　あと ¥Y」（Y = `SelfLimitYen − MonthSpentYen`）。シートの右下にテキストリンク `SelfLimitsModel.ConfirmLinkLabel`「上限を設定」→ 画面（§2）。
- **断られた時**（`SelfLimitExceededException`）：見出し「自分で決めた今月の上限を超えます」（警告色）、本文 `SelfLimitsModel.RefusedText(e)`、小さな字「上限は翌月1日に戻ります。上限はご自身で決めたもので、いつでも確かめられます。」、テキストリンク `LinkLabel`「上限の設定」。**「上げれば買えます」「あと◯円」のような文やボタンを足さない**。購入ボタンは出さない。
- **コイン不足の案内**（`CoinShortfall.BlockedCode == "SELF_LIMIT_EXCEEDED"`）：パックのカードの代わりの灰色のカードに `Line` と「上限の設定」のリンク。
- ストアから上限を超えて届いた購入（`PurchaseRecord.SelfLimitBreach`）も通常どおり「購入しました」。プレイヤーに特別な表示はしない（履歴の見出しの残りが 0 になる）。

## 4. 遊ぶ時間のシートと呼び出し

| いつ | 呼ぶもの |
|---|---|
| 起動・前面に戻った時（`OnApplicationPause(false)`／`OnApplicationFocus(true)`） | `selfLimits.OnForeground()` |
| 背面に行った時・終了 | `selfLimits.OnBackground()`（時計は `IKeyValueStore` に保存。落ちても余分に数えない） |
| レースの結果の画面を**閉じた後** | `selfLimits.AtPlace(PlaytimePlaces.RaceResult)` |
| ホームを開いた時 | `selfLimits.AtPlace(PlaytimePlaces.Home)` |
| ほか（レース中・マッチング中・購入の途中・チュートリアル） | 呼ばない（呼んでも `null`。来た分は次の区切りへ） |
| アカウントが変わった時（§54 の `AccountChangeReset` と同じ所） | `selfLimits.ForgetClock()` |

- `AtPlace` が `PlaytimeDecision` を返したらシートを出す：暗くした写真の上に紺の面（中くらいの大きさ、中央）。見出し（水色の小さな字）「遊ぶ時間のお知らせ」、タイトル `Title`（白・大きめ）、`Lines`（1行ずつ白）、`Note`（灰色の小さな字）。ボタンは `Buttons.Continue`・`Buttons.Stop` の**同じ大きさ・同じ強さの副ボタン2つ**（主ボタンにしない）、下にテキストリンク `Buttons.Settings`。音・振動・カウントダウン・アニメーションの点滅なし（動きを減らす設定 §41 に従う）。
- 答え：`selfLimits.Answer("continue" | "stop" | "settings")` が KPI を送り、開く画面を返す（stop → `home`、settings → `self_limits`、continue → `null`＝そのまま）。「今日はここまで」はホームに戻るだけで、アプリを閉じたり遊べなくしたりしない。
- **`SessionPromptGate` を通さない**：同意・通知の前置き・レビューと別。`selfLimits.SheetVisible` の間は、それらを**次の区切り**に回す（`ConsentModel`・`LocalNotificationModel`・`ReviewPromptModel` を呼ぶ前に `SheetVisible` を見る）。
- シートの文は policy が `Loc.Current`（アプリの言語）で作る。`Loc.T` を通さない。

## 5. 入口（その他のページに行を足さない）

- その他 › 設定・サポート ページの左の面の「購入・コイン・ガチャ履歴」→ 履歴の右の面の残高の下：`HistorySummary.LimitText`（年齢帯）の下に `SelfLimitText`（水色）、その下にテキストリンク「上限の設定」。
- 購入の確認の「上限を設定」、断られた時・コイン不足の「上限の設定」、シートの「お知らせの設定」。
- ヘルプの記事のリンク（画面 `self_limits`）。

## 6. 文字の大きさ・英語

- 最大の文字の大きさ（§41）で、金額のボタン（3列）・遊ぶ時間のボタン（5つ）がはみ出さないこと：ボタンの文字は `whiteSpace: nowrap` のまま縮める（`fitText` と同じ考え）。
- 英語：画面の文字は `ui-en.json`（`Loc.T`）、サーバーの文（`StatusText`・`PendingText`・`RulesText`）は応答のまま。見本の en-flow・a11y-flow で日本語の残り・はみ出しが0。

## 7. 決めたこと（変えない）

- 下げるのはすぐ・上げる／外すは冷却期間（既定72時間）の後・取り消せる。サポートは上げられない。停止スイッチは無い。
- 断る文は上げることを勧めない。シートの2つの答えは同じ大きさ。どちらにも報酬・罰は無い。
- KPI：`self_limit_set`（サーバー、必須）、`self_limit_block`（サーバー）、`playtime_setting_change`（サーバー）、`playtime_reminder_shown`（クライアント、`SelfLimitsModel.Answer` が送る）。
