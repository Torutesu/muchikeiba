# Round 20 Codex 向け引き継ぎ：レビュー依頼のタイミング（in-app store review prompt、REQ-REV-001〜016）

更新：2026-11-11　基準ブランチ：`feat/r20-review-prompt`（`origin/claude/round18` から）
仕様：`contracts/protocol.md` §59、`docs/spec/requirements.md` 59章、法務 `docs/planning/03-legal-risk.md`「レビュー依頼」、UX `docs/planning/06-ux-experience-spec.md` 補足（Round 20）。経済の目標なし（**レビューには何も配らない**。E 番号・balance-targets の節なし）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目と OS の SDK のつなぎ込み**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/review-prompt`（規則とサーバーの要約）・`POST /v1/review-prompt/check`（冪等キー必須。頼む時だけ記録）・`POST /v1/review-prompt/:promptId/answer`（`soft_yes`／`soft_no`／`soft_dismiss`／`native_requested`）。規則は `server/master/progression.json` の `reviewPrompt`（`reviewPromptProblems` で検証）、判断は `server/src/domain/reviewPrompt.ts` の純粋関数 `decideReviewPrompt` |
| C# | ✅ `engine/Muchi.Client/ReviewPrompt.cs`：`ReviewPromptPolicy.Decide`（サーバーと同じ、`contracts/review-prompt.vectors.json`）、`ReviewPromptRules`・`ReviewPromptSummary`・`ReviewPromptStatus`・`ReviewPromptCheck`・`ReviewPromptAnswer`、`ApiClient.GetReviewPromptAsync` / `CheckReviewPromptAsync` / `AnswerReviewPromptAsync`、**`IStoreReview`**（`NullStoreReview` はエディター用） |
| ゲーム層 | ✅ `Muchi.Game.ReviewPromptModel`（`unity/Assets/Muchi/Game/ReviewPromptModel.cs`、チェック `unity/Checks~/GameChecks/ReviewPromptChecks.cs`）。英語は `ui-en.json` の `_review` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：`__muchi.show('ReviewPrompt', 'soft')`（前置きのシート）・`__muchi.show('ReviewPrompt', 'native')`（OS のシートのシミュレーション）。どちらもデモの状態（落ち着いたプレイヤーの初勝利の直後） |
| **Codex** | `IStoreReview` の iOS / Android 実装（§2）、モデルを呼ぶ場所（§3）、前置きのシート（§4）、文字の大きさ・英語（§5） |

## 2. `IStoreReview` の実装（Codex がつなぐ）

```csharp
public interface IStoreReview { bool Available { get; } string Platform { get; } Task RequestReviewAsync(CancellationToken ct = default); }
```
- **iOS**：`Platform = "ios"`。iOS 16+ は StoreKit の `AppStore.requestReview(in: windowScene)`、それより前は `SKStoreReviewController.requestReview(in:)`。Unity からはネイティブのプラグイン（`[DllImport("__Internal")]`）か、Unity の `UnityEngine.iOS.Device.RequestStoreReview()` を使ってよい。`Available` は iOS 10.3 以上で true。
- **Android**：`Platform = "android"`。Google Play Core の In-App Review（`com.google.android.play:review`、Unity は `Google.Play.Review` パッケージ）：`ReviewManager.RequestReviewFlow()` → 成功したら `LaunchReviewFlow(reviewInfo)`。`RequestReviewFlow` が失敗したら何もしない（エラーの画面を出さない、`NoteError` も呼ばない）。`Available` は Play ストアから入れた端末で true（サイドロード・エミュレーターは false でよい）。
- **エディター**：`NullStoreReview`（`Available = false` → 一度も頼まない）。
- **結果は受け取らない**：`RequestReviewAsync` は「OS に渡した」で終わる。OS は出したか・何点かを教えないので、待たない・推測しない・ログにも書かない。**何も配らない**（報酬・トースト「ありがとう！コインを…」などは絶対に出さない）。
- 独自の「★を付けてください」の画面は作らない（Apple 5.6.1）。設定の「アプリを評価する」（ストアのページを開くリンク）を置くなら、プレイヤーが押した時だけで、自動では開かない。

## 3. モデルを呼ぶ場所

アプリ起動ごとに `ReviewPromptModel` を1つ作る（`sessionId` は自動。1セッション1回を守る）。`inFtue` には `OnboardingFlow.InFtue` を渡す。

| いつ | 呼ぶもの |
|---|---|
| レースの結果で負けた（1着でない） | `NoteLoss()` |
| エラーのダイアログを出した | `NoteError()` |
| メンテナンスのお知らせ・バナー（§46）を出した | `NoteMaintenanceNotice()` |
| 初めての1着（チュートリアル以外）の**結果画面を閉じてホームに戻った所** | `await OnMomentAsync(ReviewMoments.FirstWin)` |
| 大会（§20）の初優勝の表彰を閉じた所 | `OnMomentAsync(ReviewMoments.FirstTournamentWin)` |
| 殿堂入り（§34 の引退の式）を閉じた所 | `OnMomentAsync(ReviewMoments.HallInduction)` |
| 馬の目標の列を全部達成した印（§53）の演出を閉じた所 | `OnMomentAsync(ReviewMoments.HorseGoalChain)` |

- 「初めて」かどうかはゲーム側で判断してよい（戦績の勝ち数が 1 になった結果、大会の初優勝、など）。サーバーは数え直さない（報酬が無いので偽っても得が無い）。
- **演出の途中・レース中・購入の途中・ダイアログの上では呼ばない**。画面が落ち着いてから。
- 戻り値：`NativeRequested`（OS のシートが出たかもしれない。何もしない）、`SoftShown`（§4 のシートを出す）、`Skipped`（何もしない。理由は `LastReason`、ログだけ）。
- `OpenInquiryCategory` が null でなくなったら（いまいちの後）お問い合わせの画面（§48 `HelpCenterModel` のフォーム、分類 `other`）を開き、`InquiryOpened()` を呼ぶ。

## 4. 前置きのシート（運用で ON の時だけ。既定 OFF、iOS だけ）

`SoftSheetVisible` が true の間だけ出す。見本：`__muchi.show('ReviewPrompt', 'soft')`（舞台 1600×900 の真ん中に 720×400）。

- **背景**：その瞬間の画面（結果・表彰の写真）を暗くして、ほかの面は出さない。左上に小さくシアンでその瞬間の名前（見本は「初勝利」）。
- **面**：紺の半透明パネル（`box()`、不透明度 .93）。上にシアンの短い線と字間の広い小さなラベル「ひとこと」（`SoftKicker`）。
- 白い太字の1行「ムチ一閃を楽しんでいますか？」（`SoftQuestion`）。その下に小さく「答えなくてもかまいません。ゲームの内容は何も変わりません。」（見本の文。モデルには無いので Codex の画面の定数にしてよい。英語は `proto-en.json` にある：*You don't have to answer. Nothing in the game changes either way.*）
- **2つの答えは同じ大きさ・同じ強さの線のボタン**（`compact_btn()`、紺に 2px のシアンの線）を横に並べる：「はい」（`YesLabel`）→ `AnswerSoftAsync("soft_yes")`、「いまいち」（`NoLabel`）→ `AnswerSoftAsync("soft_no")`。**水色の塗りの主ボタン（» の CTA）にしない**（はいだけを目立たせると振り分けに見える）。
- 左下に小さな文字のリンク「閉じる」（`CloseLabel`）→ `AnswerSoftAsync("soft_dismiss")`。背景のタップも同じ。
- いまいちの後は短いトースト「ご意見をお聞かせください。お問い合わせの画面を開きます。」（`FeedbackLead`）を出してからお問い合わせへ。
- アニメーションは出る時に下から少し上がる（`rise`）だけ。点滅・揺れ・紙吹雪・★の絵は使わない。

## 5. 文字の大きさ・英語・アクセシビリティ

- 文字の大きさ（§41 `TextScale`）に全部従う。最大でもはみ出さない（見本の a11y-flow で確認済み：`review-soft`・`review-native`、日本語・英語）。
- 英語（`Loc.T`）：Are you enjoying Muchi Issen? / Yes / Not really / Close / A quick question / We'd love to hear what we can do better. Opening the inquiry form.
- 読み上げ：シートの見出しを最初に読む。2つのボタンに同じ重みのラベル。
- 色だけに頼らない（ボタンの文字で区別）。

## 6. やってはいけないこと（審査・法務）

- レビュー・評価に結び付く報酬・プレゼント・ミッション・称号を作らない（Apple 5.6.1・Google Play のポリシー）。
- 独自の★の画面を作らない。OS の標準のシートだけ。
- Android で前置きの質問を出さない（サーバーの検証で `softAsk.android` は ON にできない。クライアントでも `style == "soft"` は iOS の時しか来ない）。
- 負け・購入・エラー・返金・メンテナンスのお知らせの直後、FTUE の途中、レース・演出・購入の途中に `OnMomentAsync` を呼ばない。
- OS の結果（出た・出ない・点数）を推測して何かを変えない。
