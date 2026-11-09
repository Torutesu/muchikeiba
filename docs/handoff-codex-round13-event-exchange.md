# Round 13 Codex 向け引き継ぎ：イベント交換所の画面（REQ-EXCH-001〜012）

更新：2026-11-09　基準ブランチ：`feat/r13-event-exchange`（`origin/main` から）
仕様：`contracts/protocol.md` §30、`docs/spec/requirements.md` 30章、経済：`docs/spec/balance-targets.md` 4.13（E17）、法務：`docs/planning/03-legal-risk.md`「イベント交換所」

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/events/:eventId/exchange`・`POST /v1/events/:eventId/exchange`（冪等キー必須）、`GET /v1/events` の各イベントの `exchange`（ポイントの数・締切）、レース結果の `event.exchange`（得たポイント）。KPI `event_point_earn` / `exchange_buy`。設定の検証（`exchangeProblems`・`eventPointSourceProblems`） |
| マスター | ✅ `server/master/events.json` の `newyear_cup_2027_01`（新春交換祭杯、2027-01-01〜01-12 JST）に交換所。行：ハツユキソウ（馬）・スカウト券・無償コイン50・配合素材・花かご |
| C# | ✅ `ApiClient.GetExchangeAsync` / `ExchangeAsync`、`ExchangeView` / `ExchangeLine` / `ExchangeResult`、`EventInfo.Exchange`（`ExchangeSummary`）、エラーコード `ExchangeNotOpen` / `ExchangeClosed` / `OutOfStock` / `InsufficientPoints`（`engine/Muchi.Client/Exchange.cs`） |
| ゲーム層 | ✅ `Muchi.Game.ExchangeModel`（`unity/Assets/Muchi/Game/ExchangeModel.cs`、チェックは `unity/Checks~/GameChecks/ExchangeChecks.cs`）。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` →「その他」→「機能・イベント」→「イベント」（イベントのトップ）→「交換所へ」。デモの時計はイベントの2日目に合わせてある（`__muchi.logic.exchangeDemo('open' / 'grace' / 'closed')`）。e2e のスクリーンショット `u-*-event-top*.png`・`u-*-exchange*.png`・`en-*-exchange*.png` |
| **Codex** | イベントのトップ（§2）、交換所のグリッド（§3）、確認シート（§4）、終了後の案内（§5）、演出・音（§6）、アート（§7） |

## 2. イベントのトップ（ポイントのカウンター）

見本と同じ 1600×900 の構図。**写真の背景を全面に、紺の半透明パネル2枚、主ボタン（斜めのシアン »）は1つ**。

- 上の帯（`TopBar`）：「イベント / {イベント名}」と期間の1行 `ExchangeModel.PeriodText`（例「イベントは 1月11日 23:59まで」）。財布・EN はいつもどおり。
- 左パネル：
  - 小さな字間の広いシアンのラベル「イベントポイント」、その下に**金の大きな数字**（`Points`、`PointsText`）。ポイントが増えた時は数字のカウントアップ（0.4秒）。
  - `EarnTodayText`（「今日あと 30 ポイントまで」／上限なら「今日のポイントは上限です。4:00に戻ります」）と、今日の分のゲージ（`View.Earn.EarnedToday / DailyCap`、金）。`WinPointsText`（「1着 40 ポイント」）は小さく。
  - `LeftoverText`（残りのポイントが何になるか、率と切り上げ）を小さく。
  - **`ExchangeModel.RulesText` を必ず小さく表示**（ポイントはこのイベントのレースでだけ・購入はできない・ランダムなものは無い）。
  - 主ボタン「交換所へ »」。イベントのレースへの導線は既存のイベントの参加ボタン（`EnqueueEventAsync`）。
- 右パネル：日程（イベントの期間、交換の締切 `ClosesAtMs`、残りの換算の率）と、交換所の行の抜粋（名前・価格・「残り n / m」）。
- **ショップ・課金への導線は置かない**（ポイントは買えない）。「倍」「今だけ」「残りわずか」「お得」も使わない。**時刻は必ずサーバーの値から**（`EndAtMs` / `ClosesAtMs` / `Earn.ResetsAtMs`）。秒で減るカウントダウンや点滅する残り時間は作らない。

## 3. 交換所のグリッド

- 上の帯：ポイント（金の数字）・`EarnTodayText`（開催中）または `GraceNotice`（終了後）・`LeftoverText`。
- グリッド：`Cards`（今は5行なので横1列に5枚。行が増えたら 5×2 → 縦スクロール）。各カード：
  - アート（§7）・種類のラベル（シアンの小さな字、`Kind`：無償コイン／素材／券／見た目／馬）・`Name`・`RewardText`
  - `PriceText`（「120 ポイント」、シアン）
  - **`StockText`（「残り 2 / 3」）**：自分があと何個交換できるかの事実。赤くしない・点滅させない。0 になったら「交換済み」の札（グレー）。
  - `Owned`（見た目をすでに持っている）：「所持しています」の札。
  - `Enabled == false` のカードは暗くして `BlockedText` を出す（タップしたら同じ文をトースト）。
  - 馬のカードだけ金の上線（見本の `--accent: gold`）。馬のアートは `ExchangeLine.Icon`（`collection/portrait/t_hatsuyuki`）。
- 「交換する」→ `Select(itemId)` → 確認シート（§4）。

## 4. 確認シート

右から出るシート（見本の `Sheet`、幅 660）。

- タイトル：行の名前。ラベル「交換の確認」。
- 行：中身（`RewardText`）／交換に使うポイント（`PendingCostText`）／交換後のポイント（`PendingAfterText`）／在庫（`PendingStockText`「残り 3 / 3 → 2 / 3」）。
- `ExchangeModel.NoUndoText`（交換は取り消せません）を小さく。終了後なら `GraceNotice` も。
- 主ボタン「交換する »」→ `ConfirmAsync()`。**応答が来るまでボタンを押せなくする**。通信が切れて失敗した時はそのままもう一度押せる（同じ冪等キーで再送されるので2回払わない）。成功したら `LastResult` で受け取りの演出（§6）、グリッドは `View` で更新済み。
- 個数の選択は v1 では1個ずつ（`Select(itemId, qty)` は `MaxQty` までの個数に対応しているので、増減ボタンを付ける場合はそのまま使える）。

## 5. 終了後の案内（猶予期間）

- `View.Status`：`open`（開催中）／`grace`（終了後・交換だけできる）／`closed`（締切後）／`upcoming`（開始前）。
- `grace`：トップとグリッドの上に `GraceNotice`（「イベントは終了しました。交換は 1月15日 3:59まで」）を金の字で。ポイントはもう増えない（今日の残りの表示は消す）。
- `closed`：「交換は終了しました」。全カード無効。`LeftoverText` が「残りの 120 ポイントは配合素材 2個になりました」になる。初めて見た時だけ、配合素材の受け取り演出（§6 の小さい版）を出してよい。
- イベントの一覧（`GetEventsAsync`）の `EventInfo.Exchange` で、ホームやイベント一覧のバナーに「交換所 1月15日 3:59まで」の小さな札を出せる（`Status == "grace"` の時だけ）。

## 6. 演出・音

| 場面 | 演出 | 長さ |
|---|---|---|
| レース後にポイントが入った | リザルト画面の下に「イベントポイント +31」（`RaceResult.event.exchange.gained`）。上限で削られた時（`capped`）は「今日の上限に届きました」を小さく | 0.6秒 |
| 交換した（コイン・素材・券・見た目） | カードからアイコンが財布／持ち物へ飛ぶ。ポイントの数字が減るカウントダウン（0.3秒） | 0.8秒 |
| 交換した（馬） | 図鑑の新しい馬と同じ「お迎え」の演出（シルエット → 姿、名前）。ガチャの演出（虹色・星の数の煽り）は使わない＝くじではないため | 2秒・タップで飛ばせる |
| 締切後の換算 | 配合素材のアイコンが1回光る | 0.5秒 |

- 音：交換の確定は短い「コトッ」。馬は図鑑のお迎えの音。ガチャの当たりの音は使わない。
- **煽りの演出はしない**：在庫・締切の点滅、「あと◯時間！」のポップアップ、閉じる前のプッシュ通知（v1 では無し）。

## 7. アート（お願いしたいもの）

| キー | 中身 | メモ |
|---|---|---|
| `banner/event/newyear_cup_2027_01` | イベントのバナー（新春・正月飾りの競馬場、朝の光） | 既存のイベントバナーと同じ比率。マニフェストに登録済み（今はフォールバック） |
| `item/gacha_ticket`・`item/breeding_material`・`item/decor_flower_box` | 交換のカードのアイコン | 既存のアイテムのアイコンを流用。花かごは厩舎の飾りの絵と同じもの |
| （コイン） | `Icon == null` の行は無償コインのアイコン（財布の ◎ と同じ） | |
| `collection/portrait/t_hatsuyuki` | 馬のカード | 図鑑の絵を流用 |
| 背景 | トップは `Art/race-result`、交換所は `Art/home-paddock`（見本）。正月の装飾を足した版があれば差し替え | 写真のトーンをそろえる |

## 8. 確かめ方

- `dotnet run --project 'unity/Checks~/GameChecks'` の「イベント交換所」（カウンター・在庫・確認シート・5xx の再送で同じキー・終了後の案内・英語）。
- `bash tools/figma-prototype/build.sh && node tools/figma-prototype/test/e2e.cjs`（`u-*-event-top*.png` / `u-*-exchange*.png` / `en-*-exchange*.png`）。
- サーバー：`cd server && npx vitest run test/exchange.test.ts`、経済 `npm run economy` の最後の表（E17）。
