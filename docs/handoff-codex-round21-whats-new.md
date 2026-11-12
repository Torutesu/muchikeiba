# Round 21 Codex 向け引き継ぎ：アップデートのお知らせ（新機能の紹介、What's New、REQ-NEW-001〜020）

更新：2026-11-11　基準ブランチ：`feat/r21-whats-new`（`origin/claude/round19` から）
仕様：`contracts/protocol.md` §64、`docs/spec/requirements.md` 64章、`docs/planning/06-ux-experience-spec.md` 補足（Round 21）。経済の目標（E）は無し（**何も配らない**。お詫びや記念の配布はプレゼントボックスの補填 §26 で、この画面とは別）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音・絵）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `POST /v1/release-notes/check`（ホームに来たたび。出す版か、出さない理由）・`POST /v1/release-notes/seen`（シートを出した印、何度でも同じ）・`GET /v1/release-notes`（過去の一覧）。原稿は `server/master/release-notes.json`（日本語と英語、リモート設定 `releaseNotes` で置き換え）。運用コンソールに「アップデート情報」（日本語・英語のプレビュー） |
| C# | ✅ `engine/Muchi.Client/ReleaseNotes.cs`：`ApiClient.CheckReleaseNotesAsync` / `MarkReleaseNotesSeenAsync` / `GetReleaseNotesAsync`、`ReleaseNotesCheck`・`ReleaseNote`・`ReleaseNotePage`・`ReleaseNoteTarget`・`ReleaseNotesHistory`、**`SessionPrompts`**（1セッションに1つのシステムの案内）、`AnalyticsEvent.ReleaseNotesView` / `ReleaseNotesTarget` / `ReleaseNotesHistory` |
| ゲーム層 | ✅ `Muchi.Game.ReleaseNotesModel`（`unity/Assets/Muchi/Game/ReleaseNotesModel.cs`）。チェックは `unity/Checks~/GameChecks/ReleaseNotesChecks.cs`。`new ReleaseNotesModel(new ApiReleaseNotes(backend.Api), sessionPrompts, () => backend.Online, analytics.Track)`（`sessionPrompts = new SessionPrompts(() => backend.Api.Outage)` をアプリで1つだけ作り、他の案内と共有する） |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：`__muchi.show('ReleaseNotes')`（デモ：この端末を「更新した人」にしてシートを出す）、`show('ReleaseNotesHistory')`。アクティビティの右の欄・ヒントの右下に「アップデート情報」 |
| **Codex** | シート（§2）、一覧（§3）、入口（§4）、案内の順番（§5）、絵（§6）、状態・英語・文字の大きさ（§7） |

**ApiClientOptions.AppVersion を必ず入れる**（`x-client-version`、§46 と同じ）。入っていないとサーバーは `reason: "unknown_version"` で何も出さない。

## 2. シート（ホームの上、更新後に1回だけ）
- **いつ**：ホームを描いた後に `await model.OnHomeArrivedAsync(alsoDue)`。`alsoDue` は同じ瞬間に出せる他の案内の種類（`SessionPrompts.AccountLink` など）。true が返ったらシートを出す。false なら何もしない（FTUE・新しい人・見た版・オフライン・メンテナンス中・他の案内がこのセッションを取った、のどれか。理由は `LastReason`）。
- **構図**（見本と同じ1600×900）：背景はページの絵（暗くする影を濃く）。中央に**紺の半透明パネル**（1328×708）。左にページの絵（560×636、cover、角丸4）。右に：
  - 字間を空けた小さな**シアンのキッカー「アップデート情報」**（`ReleaseNotesModel.Title`）。
  - 小さな灰色の数字「Ver. 1.2.0　·　2026.11.05」（`VersionLabel(Sheet.AppVersion)`・`Sheet.ReleasedOn`）。右端にページの点（`Sheet.Pages.Count` 個、今のページだけシアン）。
  - 題（34px 太字、2行まで）＝`CurrentPage.Title`。本文（20px、行間1.75）＝`CurrentPage.Body`。**数字はサーバーがデータから入れたもの。画面で書き足さない**。
  - 行き先があれば（`CurrentPage.Target != null`）本文の下に文字リンク「`Target.Label` ›」。押したら `var t = model.OpenTarget();` で閉じてから `t.Kind` ごとに開く：`screen` → その画面（§48.1 の画面 id。ヘルプの画面リンクと同じ対応表）、`help` → `HelpCenterModel.OpenArticleAsync(t.Id, "link")`、`tip` → `TipsModel.OpenCard(t.Id, "list")`。**ショップ・スカウトへは行かない**（サーバーの検査でそういう原稿は出せない。画面側でも作らない）。
  - 最後のページで `ShowPastLink` なら文字リンク「過去のアップデート情報 ›」（`Sheet.Skipped > 0` なら「過去のアップデート情報（ほかn件） ›」）。押したら `OpenPastFromSheet()` → `LoadHistoryAsync("sheet")` → 一覧（§3）。
  - 下に**小さなゴーストのボタン「スキップ」**（`Skip()`）と、**斜めのシアンの主ボタン「次へ »」**（最後のページは「はじめる »」、`CtaLabel`）。押したら `Next()`（false が返ったら閉じてホームへ）。
- 出たら閉じるまで他の案内を重ねない。ホームのカード（次にやること等）はシートの下に隠れてよい。
- 見た印・KPI はモデルの中で済む（画面で送らない）。

## 3. 「お知らせ › アップデート情報」（一覧）
- 題「アップデート情報」、小さな説明「アプリの版ごとの新しい機能　·　お知らせから、いつでも読めます」。背景 `Art/home-paddock`、左を暗く。
- 左パネル（400×676）：キッカー「新しい順」、版の行（`History.Notes`、「Ver. 1.2.0」と日付、未読（`Seen == false`）なら金の小さな「NEW」）。選んだ版はシアンの左線。
- 右パネル（1108×676）：選んだ版のページを縦に（最大5枚）。各行は絵のサムネイル（128×80）・題（太字1行）・本文（2行まで、はみ出したら省略せず高さを広げる）・行き先があれば右にゴーストのボタン（`Target.Label`）。
- 空なら `EmptyText`、オフラインなら `OfflineText`（`Message`）。
- 開くとき `await model.LoadHistoryAsync(source)`：source は入口（`"notices"`＝アクティビティ、`"tips"`＝ヒント、`"sheet"`＝シートの最後のページ）。

## 4. 入口
- **アクティビティ（お知らせの一覧、§40）の右の欄**：「新着情報があります」の下に文字リンク「アップデート情報 ›」。**アクティビティの行（種類）には足さない**。
- **設定 › ヒント（§57）**：右下にゴーストのボタン「アップデート情報」。

## 5. 案内の順番（1セッションに1つ）
アプリのセッション（起動から次の起動まで）ごとに「システムの案内」は1つだけ。**全部の案内が同じ `SessionPrompts` を使う**：
1. メンテナンス・強制アップデートの画面（§46）：案内ではなく画面。`Outage` が `None` 以外の間は `TryClaim` がいつも false（シートは出ない）。推奨の更新の案内は `SessionPrompts.RecommendedUpdate`。
2. 広告・分析の同意の事前案内（§58、Round 20）：`ConsentPrePrompt`。
3. 復帰キャンペーンの歓迎画面（§20）：`ComebackWelcome`。
4. アップデートのお知らせ：`ReleaseNotes`（このモデルが取る）。
5. 端末の通知の前置き（§61、Round 20）：`RemindersPrePermission`（R21 統合で表に入った）。
6. 引き継ぎの案内（REQ-UXS-073）：`AccountLink`。
7. ストアのレビューの依頼（§59、Round 20）：`ReviewPrompt`。
（R21 統合：この表は protocol §58.11 が唯一の正。R20 の `SessionPromptGate` は無くなり、全部のモデルが同じ `SessionPrompts` を `Prompts` に持つ。FTUE の間はどれも出ない＝`new SessionPrompts(outage, inFtue)`。）
出す前に `sessionPrompts.TryClaim(kind, 同じ瞬間に出せる他の種類)` が true のときだけ出す。コールドスタートで `NewSession()`（`ReleaseNotesModel.NewSession()` は中で呼ぶ）。

## 6. 絵
**新しい絵は要らない**。ページの `Art` は §57 のヒントのカードの絵のキー（`whip`・`slipstream`・`lanes`・`stamina`・`reins`・`breeding`・`stud`・`training`・`roster`・`scout`・`pity`・`coins`・`branch`・`cups`）。ヒントのカードと同じ絵を使う（docs/handoff-codex-round19-tutorial-replay.md §8）。写真の絵・紺の半透明・シアンの見出し・斜めのシアン »、余白は広く。

## 7. 状態・英語・文字の大きさ
- 英語：文はサーバーが英語で返す（`Accept-Language`）。画面の固定の文言は `ReleaseNotesModel` の定数と `engine/Muchi.Client/Resources/Muchi/ui-en.json`（「アップデート情報」→ What's new、「はじめる」→ Let's go、「過去のアップデート情報」→ Past updates など）。版の数字と日付は訳さない。
- 文字の大きさ（§41）：最大でもはみ出さない（題は2行、本文は折り返す。縮めない）。見本の a11y-flow でシートの最初と最後のページ・一覧を確かめている。
- 動きを減らす：ページの切り替えは即時（スライドしない）。
- 音・振動：なし。
- 値段・割引・期限・「今だけ」などの言葉、カウントダウンは置かない。
