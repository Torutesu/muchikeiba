# Round 19 Codex 向け引き継ぎ：チュートリアルのやり直しとヒント集（REQ-TUT-001〜018）

更新：2026-11-11　基準ブランチ：`feat/r19-tutorial-replay`（`origin/claude/round17` から）
仕様：`contracts/protocol.md` §57、`docs/spec/requirements.md` 57章。経済の目標（E）は無し（**何も配らない**。やり直しでは最初のチュートリアルの報酬をもう一度受け取れない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音・絵）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/tips`（話題・カード・やり直し・「？」の行き先。数字はデータから）・`POST /v1/tips/seen`（見た印、何度でも同じ）、`GET /v1/player` の `tips.newCount`。カードは `server/master/tips.json`（日本語と英語）。ヘルプに記事 `tips_replay`（画面リンク `tips`）を追加 |
| C# | ✅ `engine/Muchi.Client/Tips.cs`：`ApiClient.GetTipsAsync` / `MarkTipsSeenAsync`、`TipsIndex`（`Card(id)`・`Tutorial(id)`・`InTopic(topic)`）、`PlayerView.Tips`、`AnalyticsEvent.TutorialReplay` / `TipView` / `TipContextOpen`、定数 `TipContexts` / `RaceLessons` / `TipTopics` |
| ゲーム層 | ✅ `Muchi.Game.TipsModel`（`unity/Assets/Muchi/Game/TipsModel.cs`）と `Muchi.Game.TutorialReplayModel`（`TutorialReplayModel.cs`）。チェックは `unity/Checks~/GameChecks/TipsChecks.cs`。`new TipsModel(new ApiTips(backend.Api), backend.Store, () => backend.Online, analytics.Track)`、`new TutorialReplayModel(backend, analytics.Track)` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：その他（設定）→「ヒント」。提供割合・調教・厩舎（配合）・まとめて引退の「？」。レースのレッスンは本物の WASM エンジンで走る |
| **Codex** | 入口（§2）、ヒントのトップ（§3）、カード（§4）、ツアー（§5）、レースのレッスン（§6）、「？」（§7）、絵（§8）、状態・英語・文字の大きさ（§9） |

## 2. 入口
- **設定（その他）の一覧の2行目**（「ヘルプ・お問い合わせ」の次）に行「ヒント」。未読のカードがあれば右に「NEW n」（`player.Tips.NewCount`、または `TipsModel.NewCount`）。
- ヘルプ記事の画面リンク `tips`・`tutorial` もヒントのトップを開く。
- 画面を開いたら `TipsModel.LoadAsync()`（オフラインで読んだ印もここで送られる）。

## 3. ヒントのトップ（「ムチ一閃」のトーン）
見本と同じ1600×900の構図。**背景 `Art/home-paddock`、左を暗くする影、紺の半透明パネル2枚、字間の広い小さなシアンのキッカー**。主ボタン（斜めのシアン »）はこの画面には置かない（カードを開くのが主操作）。
- 上の帯：題「ヒント」、小さな説明「レースのレッスン　·　機能のツアー　·　ヒント集」。
- 左パネル（560×676）：キッカー「レースのレッスン」と4枚（2×2、`TipsModel.Lessons`）。各カードは題（`Title`）と小さなシアンの「端末で練習」。下にキッカー「機能のツアー」と6枚（2×3、`TipsModel.Tours`）。開いていないツアー（`Unlocked == false`）は文字を薄くし「機能が開くと見られます」、押すと `TourLockedText` のトースト。一番下に小さく `TutorialReplayModel.PracticeNote`（「レッスンは練習です。成績・ミッション・報酬には数えません」）。
- 右パネル（948×676）：キッカー「ヒント集」、未読があれば金の小さなピル「NEW n」。話題のタブ5つ（`Index.Topics`、選択中はシアンの枠。未読のある話題は右上に金の点）。下にその話題のカード（2列×4、`TipsModel.Cards`）：左に絵のサムネイル（120×88、角丸3）、右に題（太字2行まで）、未読なら金の「NEW」、開いていなければ薄い文字「機能が開くと読めます」（`LockedText`）。**開いていないカードは本文を出さない**（サーバーも `Body = null`）。
- 戻るで設定へ。

## 4. カード
- 中央に紺の大きなパネル（1208×640）。左に絵（520×568、cover、`Art` の種類ごと：§8）。右にキッカー＝話題名、大きな題（34px 太字）、本文（22px、行間1.75、**3〜4行で収まる長さ**。文字を大きくしたら縮めず折り返す）。
- 本文の数字（天井の回数・提供割合・ムチの数）は**サーバーがデータから入れたもの。画面で書き足さない・書き換えない**。
- 本文の下に文字リンク「くわしく：<記事のタイトル> ›」（`HelpArticleId` があるとき）。押すとヘルプの記事（`HelpCenterModel.OpenArticleAsync(id, "link")`）。**カードは短く、くわしい説明はヘルプ**：カードに長文を足さない。
- 下に主ボタン「閉じる »」（ツアー中は「次へ »」／最後のページは「おわり »」）。開いたら `TipsModel.OpenCard(id, source)`（`tip_view` と見た印は中で済む）。

## 5. ツアー
- `TipsModel.StartTour(id)` が true のとき、`TourPages[TourPage]` をカードの画面で出す。左下に「1 / 3」のページ数（`TourPage + 1` / `TourPages.Count`）。
- 「次へ」で `NextPage()`。false が返ったらツアーは終わり（`tutorial_replay` の finish は中で送られる）→ トップに戻り、トースト「ツアーを最後まで見ました」。途中で戻るなら `EndTour()`（finish は送らない）。
- 開いていないカードはページに入らない（`StartTour` が外す）。

## 6. レースのレッスン
- トップのレッスンを押す → **説明の画面**：左パネルにそのレッスンのカード2枚（`Tips` の順、絵480×200・題・本文）、右パネルにキッカー＝レッスン名、遊び方の1〜2行（見本：ムチ「最後の直線だけの短いレース。合図が出たら、ムチを2回。」・位置取り「練習のレース。前の馬の後ろについて、直線で外へ。」・スタミナ「練習のレース。スタミナの帯を見ながら、前半は抑えて。」・手綱「練習のレース。掛かったら手綱を長押し。」）、`PracticeNote`、主ボタン「レッスンを始める »」。カードは `TipsModel.MarkRead(id, "lesson")`。
- 「レッスンを始める」→ `TutorialReplayModel.Open(entry)` → `StartRace()` が返す `IRaceDriver` を**いつものレース画面**で走らせる：
  - ムチ（`whip`）：**最初のチュートリアルのレースそのもの**（400mの直線、ムチだけの HUD、「最後の直線。前に7頭。」の出だし）。左下のキャプションだけ「はじめてのレース　/　チュートリアル」ではなく「レッスン　/　ムチのタイミング」。
  - 位置取り・スタミナ・手綱：端末の練習レース（2000m、いつもの HUD：内へ／外へ・手綱・スタミナの帯）。帯の上のレース名は「レッスン名」。
  - **かんたん操作は付かない**（モデルが付けない。HUD のチップも出さない）。「中断」でヒントのトップへ。フォトは押すと既存のトースト。
  - レース中の案内はいつもの1行（`RaceFeel`）。`TutorialReplayModel.Highlights(cue)` が true の案内は、そのレッスンの見どころなので**少しだけ目立たせてよい**（同じ金の枠を太く、など。点滅の回数は §41 の上限のまま）。
- 結果：`FinishRace(result)` の後、**結果の画面の左パネル（`ResultPanel` と同じ）**：キッカー「レッスン　/　<レッスン名>」、大きな見出し（ムチは勝ち「差し切った！」／負け「おしい！」、他は「レッスン完了」）、1行（ムチの負けは `WhipLostText`「あと少し。残り300mからムチを2回」、ほかは着順とタイム）、キッカー「ヒント」とそのレッスンの1枚目のカードの題、`PracticeNote`、主ボタン「もう一度 »」（`StartRace()` をもう一度）、文字リンク「ヒントに戻る」（`Close()`）。
- **出さないもの**：コイン・シーズンpt・パスXP・ミッションの進み・相棒に名前をつける・入厩祝い・通知の許可・引き継ぎの案内・広告。レッスンはオンボーディングの段（`OnboardingFlow`）にも、チュートリアルの回数にも触れない（チェック済み）。

## 7. 「？」ボタン（`TipContexts`）
- 提供割合（`gacha_odds` → 交換ptのカード）、配合（`breeding` → 配合のきほん）、調教（`training` → 調教はタイミング）、厩舎の整理のまとめて引退（`roster_bulk_retire` → まとめて引退の前に）。
- 見た目：**右上の小さな丸い「？」**（52×52、紺に細いシアンの縁、太字の「？」）。主ボタンにしない。押したら `TipsModel.OpenContext(context)`（`tip_context_open` と `tip_view`）でカードを開き、「閉じる」で元の画面に戻る。null が返ったら（オフライン・開いていない）トースト「ヒントはオンラインで見られます」。
- ヘルプの「（ヘルプ）」の文字リンク（§48）はそのまま残す。「？」は短いカード、文字リンクは長い記事。
- 見本では配合の画面が無いので、厩舎の画面（配合へ進む場所）の右上に置いている。Unity では配合の画面の右上に置く。

## 8. 絵（`TipCard.Art`、新しく描くもの）
カードの絵は写真のようなアート（既存の `Art/` と同じ調子）。横長（520×568 で cover、サムネイルは 120×88 に切り抜き）で、中央に被写体。文字は絵に入れない（言語ごとに差し替えないため）。

| `art` | 描くもの | 見本で代わりに使っている絵 |
|---|---|---|
| `whip` | 最後の直線でムチを入れる騎手の背中越し、光るムチのボタンの気配 | `Art/first-ride` |
| `slipstream` | 前の馬の真後ろにつく相棒、うっすら風の線 | `Art/race-result` |
| `lanes` | 馬群の外へ持ち出す瞬間を上から | `Art/Courses/spring-course` |
| `stamina` | 息の上がった馬の横顔、夕方のコース | `Art/Courses/autumn-course` |
| `reins` | 手綱を引いて馬を落ち着かせる手元 | `Art/Cosmetics/bridle` |
| `breeding` | 牧場で並ぶ牡馬と牝馬 | `Art/3DPreviews/Partner_Chestnut_Azure` |
| `stud` | フレンドの厩舎の種牡馬 | `Art/3DPreviews/Partner_Black_Emerald` |
| `training` | 朝の調教コースを走る相棒 | `Art/home-paddock` |
| `roster` | 厩舎の名札が並ぶ通路 | `Art/Cosmetics/stable-plaque` |
| `scout` | スカウトの光（レア度は形と色の両方で） | `Art/scout-reveal` |
| `pity` | 交換ptのメーターがたまる光の帯 | `Art/scout-reveal` |
| `coins` | 有償と無償、2種類のコイン（**色だけでなく形でも区別**） | `Art/Cosmetics/silk-jacket` |
| `branch` | 支部の仲間の勝負服が並ぶ | `Art/Cosmetics/jockey-cyan` |
| `cups` | 小さなトロフィーとゴール前 | `Art/race-result` |

## 9. 状態・英語・文字の大きさ
- オフライン：`LoadAsync` が `Message = OfflineText`（「ヒントはオンラインで見られます」）。前に読んだ一覧があればそれを出してよい。読んだ印は端末に貯まり（`KeyPendingSeen`）、次に読み込んだときに送られる。**レースのレッスンはオフラインでも走れる**（端末のエンジン）。説明のカードが無いときはレッスン名と遊び方の1行だけで始めてよい。
- 英語：カードと話題・レッスン名はサーバーが英語で返す（`?lang=en`）。画面の固定の文字は `Loc.T`（`ui-en.json` に追加済み）。英語は長いので、題は2行まで折り返し、本文は高さを固定しない。
- 文字の大きさ（§41）：本文・題は大きくなる。カードの本文は折り返して、パネルの下にはみ出さない（はみ出すならパネルの中でスクロール）。サムネイルのカードは題を2行で切って「…」。
- 動きを減らす設定：カードの出入りはフェードだけ。
- 読み上げ：「？」のラベルは「ヒント」、NEW のピルは「未読」。

## 10. 確認のしかた
- `dotnet run --project 'unity/Checks~/GameChecks'` の「round 19」の行が全部 ok。
- `bash tools/figma-prototype/build.sh && node tools/figma-prototype/test/e2e.cjs`：`u-..-tips.png`・`tip-card`・`tip-tour`・`tip-context-roster`・`tip-lesson`・`lesson-result`・`lesson-reins-hud`、英語 `en-..-tips.png` ほか、アクセシビリティの最大サイズ `a11y-..-tips.png` ほか。
