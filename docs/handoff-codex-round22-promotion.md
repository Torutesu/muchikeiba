# Round 22 Codex 向け引き継ぎ：昇級戦と降級の猶予（ranked promotion series & demotion protection、REQ-PROMO-001〜020）

更新：2026-11-11　基準ブランチ：`feat/r22-promotion`（`origin/claude/round20` から）
仕様：`contracts/protocol.md` §68、`docs/spec/requirements.md` 68章、UX `docs/planning/06-ux-experience-spec.md` 補足（Round 22）。経済の目標なし（**昇級戦は何も配らない**。E 番号・balance-targets の節なし）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/promotion`（規則・今の昇級戦・猶予）・`POST /v1/promotion/ack`（結果のシートを見た印、冪等）。判定はプレイヤーの Durable Object が確定したランク戦の結果から行う（`server/src/domain/promotion.ts`）。規則は `server/master/progression.json` の `promotion`（`promotionProblems` で検証、`enabled: false` で前の動き） |
| C# | ✅ `engine/Muchi.Client/Promotion.cs`：`PromotionView`・`PromotionSeries`・`PromotionGrace`・`PromotionRules`、言葉と印の `PromotionPips`（`HomeLabel`・`Marks`・`RuleLine`・`GraceLabel`・`OutcomeTitle`・`OutcomeBody`）、`ApiClient.GetPromotionAsync` / `AckPromotionAsync`。活動の種類 `ActivityKinds.ClassPromoted` |
| ゲーム層 | ✅ `Muchi.Game.PromotionModel`（`unity/Assets/Muchi/Game/PromotionModel.cs`、チェック `unity/Checks~/GameChecks/PromotionChecks.cs`）。`SessionPromptKind.PromotionOutcome` を追加。英語は `ui-en.json` の `_promotion` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：`__muchi.show('PromotionResult', 'start' | 'one' | 'passed' | 'failed')`（本物の規則で作ったデモの状態の結果画面）、ホームの「昇級戦 2/3」 |
| **Codex** | 結果画面のカード（§3）・突破／届かずのシート（§4）・ホーム（§5）・活動の行（§6）・文字の大きさ・英語（§7） |

## 2. モデルを呼ぶ場所

アプリ起動ごとに `PromotionModel` を1つ作り、`Prompts` にそのセッションの `SessionPromptGate`（同意・通知・レビューと同じもの）を渡す。

| いつ | 呼ぶもの |
|---|---|
| ホームを開いた | `await RefreshAsync()` → `HomeLabel`・`GraceLabel`。続けて `TryShowSheet()` が true なら結果のシート（前のセッションで出せなかった分） |
| **ランク戦**の結果画面を開いた（チュートリアル・練習・タイムアタック・カップ・フレンド戦では呼ばない） | `await AfterRankedResultAsync()` → `ResultBanner`・`Marks`・`OutcomeInline`・`OutcomeSheetVisible` |
| シートを閉じた | `await CloseOutcomeAsync()`（見た印。オフラインなら次にまた出る） |
| 「昇級戦のルール」 | ヘルプの記事 `promotion_series`（§48） |

## 3. 結果画面のカード（ランク戦の結果の右上、結果のパネルと重ねない）

- 紺の半透明の面、水色の小さな見出し「昇級戦　/　C級 → B級」（字間をあける）。
- 題：`ResultBanner` があれば **「昇級戦 開始」を金色で大きく**＋一言「昇級ラインに到達。ここからが本番だ」。無ければ進行中は「昇級戦 2/3」（`HomeLabel`）、決まったら `OutcomeTitle`（突破は金色）。
- **印**（`View.Series.Pips`、長さ `Races`）：`top` = 金色の塗りの丸（弱い光）、`miss` = 灰色の塗りの丸、`open` = 水色の線だけの丸、`skip` = 点線の薄い丸（決まって走らなかった分）。文字で出す所は `Marks`（○●·–。どれも日本語の文字ではないので英語でもそのまま）。光は「動きを減らす」（§41）で消す。
- その下に `RuleLine`（「3戦で3着以内が2回で突破」）、最後に小さく：進行中「ライン 300pt　·　いま 320pt」、突破「クラスが上がるのはシーズンの締め」、届かず「ポイントは260ptに戻りました」。
- 切断して CPU が走ったレースは `miss`（サーバーが決める。端末で直さない）。

## 4. 突破／届かずのシート（1セッション1つの案内を通す）

- **`OutcomeSheetVisible` が true の時だけ出す**（モデルが `SessionPromptGate` を取った時）。取れなかった時は結果画面のカードの中の題だけ（`OutcomeInline`）で、シートは次のセッションのホームで出る。
- 中央のダイアログ、後ろを暗く。見出し「昇級戦　/　突破」（突破は線を金色）または「昇級戦　/　届かず」。
- 題：突破「B級へ昇級確定」（金色・大）、届かず「昇級ならず」（白・大）。その下にムチ一閃の一言：突破「一閃、届いた。」、届かず「次の一閃で取り返せ。」。
- 大きめの印（§3 と同じ）。
- 本文：突破「シーズンの締めでB級に上がります。上がった後の最初の10戦は、締めで一度だけ降級しません。」、届かず「ポイントは260ptに戻りました。あと40ptでもう一度挑めます。」（数はモデルの値）。
- 主ボタン（水色の斜め「つづける »」）1つ＋文字のリンク「昇級戦のルール」。購入・ショップ・パック・ガチャへの導線は置かない（昇級記念パック §UXS-019 のお知らせもこのシートには出さない）。
- 煽らない：「今だけ」・残り時間・「あと少しで…課金」などは書かない。カウントダウンなし。

## 5. ホーム

- 昇級戦の間：レースのボタンの上に金色で「昇級戦 2/3　○··」（`HomeLabel`＋`Marks`）。シーズンの面の行も「320pt　·　昇級戦 2/3」。
- 猶予の間（昇級した後）：同じ場所に水色で「降級の猶予 残り7戦」（`GraceLabel`）。
- オフラインでは最後の写し（モデルが保存）で「昇級戦 2/3」を出す。押してもレースはオンラインで。
- プッシュ・ローカル通知は足さない（§61 の表に無い）。

## 6. アクティビティ（§40）

新しい種類 `class_promoted`（締めで昇級した時、`Category` = `season`、`Screen` = `recap`、`LinkId` = `season:2026-11`）。ラベル「昇級」、アイコン `promotion`（`ActivityModel.Icons`）。文はサーバーから（「昇級戦を突破してB級に昇級しました」／「C級からB級に昇級しました」）。押すとその月の振り返り（§43）。振り返りの名場面にも「昇級戦を突破してB級へ昇格」が出る。

## 7. 文字の大きさ・英語

- 文字の大きさ（§41）の一番大きい設定で、カード・シートの文が枠からはみ出さないこと（見本の a11y-flow で確認済み）。
- 英語：`ui-en.json` の `_promotion`（「Promotion series 2/3」「Promotion to Class B confirmed」「Not promoted this time」「Demotion protection: 7 races left」…）。
- 見本のスクリーンショット：`u-*-promotion-start.png`・`promotion-home`・`promotion-pass`・`promotion-fail`（日本語）、`en-*-promotion-*`、`a11y-*-promotion-*`。
