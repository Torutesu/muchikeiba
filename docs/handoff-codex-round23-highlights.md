# Round 23 Codex 向け引き継ぎ：レースの見どころ（REQ-HL-001〜020）

更新：2026-11-12　基準ブランチ：`feat/r23-highlights`（`origin/main` から）
仕様：`contracts/protocol.md` §72、`docs/spec/requirements.md` 72章。経済の目標（E）は無し（**表示だけ。何も配らない・何も売らない**）。

分担はこれまでと同じ：**Claude＝ロジック（エンジンの判定・API クライアント・画面のビューモデル）／Codex＝見た目（画面・カメラのつなぎ・字幕・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| エンジン | ✅ `engine/Muchi.Engine/Highlights.cs`：`HighlightDetector.Detect(config, inputs, focusSlot, expectedHash?)`（リプレイログを再計算して3つまで選ぶ、整数だけ、結果・ハッシュ・ゴールデンは変わらない）、`HighlightRules`（定数・版 1）、`HighlightKinds`、`HighlightMoment`・`HighlightSet`。JSON は `Muchi.Net.HighlightJson`。検証サーバーの `Muchi.Verifier highlights` と共有ベクター `contracts/highlights.vectors.json` が同じ答えを確かめる |
| C# | ✅ `engine/Muchi.Client/Highlights.cs`：`ReplayHighlights.Detect(ReplayPlayer)`、`HighlightReel`（`ReplayPlayer` の上で窓を続けて再生：`Advance`・`Next`・`Skip`・`MomentStarted`・`Commentary`・`LinesIn`）、`HighlightCaptions`（字幕）、`HighlightShare`（カード・リンクの開始 tick）、`ApiClient.CreateReplayLinkAsync(raceId, startTick)`、`ResolvedLink.StartTick`、`AnalyticsEvent.HighlightView`／`HighlightShare` |
| サーバー | ✅ 新しい口なし。§63 の `replay` リンクに任意の `startTick`（0〜72000）。ヘルプ記事 `race_highlights`・ヒント `highlights_tip`。KPI `highlight_view`／`highlight_share`（§58 optional） |
| ゲーム層 | ✅ `Muchi.Game.HighlightsModel`（`unity/Assets/Muchi/Game/HighlightsModel.cs`）。チェックは `unity/Checks~/GameChecks/HighlightsChecks.cs` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：結果画面の「見どころ」、マイリプレイのシートの「見どころを見る ›」と再生画面の「見どころ」。デモは `__muchi.demo('highlights')`（保存して公開したリプレイの見どころ、リンクの行が使える） |
| **Codex** | 入口（§2）、再生画面（§3）、つなぎのカメラ（§4）、字幕（§5）、終わりの画面と共有（§6）、状態・英語・文字の大きさ・動き（§7） |

## 2. 入口（その他には行を足さない）
- **結果画面**：「写真を撮る」の左に「見どころ」（チュートリアルの結果には出さない：`HighlightsModel.ShowOnResult(mode)`）。`HighlightsModel.ForDriver(driver, templates, analytics.Track)`。オフラインでも動く（端末のログから計算）。null なら出さない（無効・失敗のレース）。
- **マイリプレイ**：行のシートの「見どころを見る ›」と、再生画面の「この瞬間を撮る」の左の「見どころ」。`MyReplaysModel.OpenAsync` で開いた `ReplayPlayer` から `HighlightsModel.ForReplay(player, "my_replays", templates, track)`。保存して公開している自分のリプレイなら `RaceId` と `LinkAllowed = true` を入れる。フレンドの公開リプレイは `"friend_replay"`、§63 のリンクから開いたものは `"link"`。
- **リンクを開いた時**：`ResolvedLink.StartTick` があればそのリプレイを `HighlightsModel.LinkStartMs(link, player)` から**再生したまま**始める（一時停止しない）。

## 3. 再生画面（「ムチ一閃」のトーン）
見本と同じ1600×900の構図。**後ろは本物のレースの3D（リプレイと同じ `RaceCameraRig`）、紺の半透明パネル、字間の広い小さなシアンのキッカー**。主ボタン（斜めのシアン »）は再生中は置かない。
- 左上の帯：題「レースの見どころ」、小さな説明（結果画面から：「いまのレースから自動で選んだ場面」、リプレイから：タイトル。**プレイヤーの付けたタイトルは打ったまま**）。
- 字幕のパネル（左下、980×168）：キッカー `CounterText`（「見どころ 1 / 3」）、大きな字幕 `Current.Caption`（32px 太字、1行）、金色の `Current.Subject`（馬の名前、自分の馬は「（あなた）」）。
- 実況の行：字幕のパネルの上に影つきの白い字で `CurrentLines` のうち今流れている行（窓の外の行は流さない）。音声も同じ行だけ。
- 下の帯：進み具合のバー（`ProgressPermille`）と場面の区切りの番号（1・2・3、今の場面をシアン）、「次へ」（`Next`）、「スキップ」（`Skip`、薄い枠）。速度・カメラの切り替えは無い（1×・主役の馬）。
- 毎フレーム `Advance(realMs)` → `Frame()` を `PoseOf` で置く（リプレイ再生と同じ）。

## 4. つなぎのカメラ（Codex に任せるところ）
- 窓が替わる瞬間に `HighlightReel.MomentStarted` が来る。カメラはその場面の主役の馬（`Slot`）に**切り替える**（前の馬から飛ばして追いかけない）。
- `Transition == "wipe"`：0.4 秒くらいの紺の斜めのスイープを画面に重ねる（見本：`.hl-wipe`）。光・白の点滅は使わない（§41 の点滅の上限に数えない形）。
- `Transition == "cut"`（動きを減らす §41）：重ねずに切り替えるだけ。
- 種類ごとの寄り方（目安。カメラの値は `RaceCameraRig` の既定のままでもよい）：
  - `photo_finish`／`near_miss`：最後の 1.5 秒はゴールの横からの画（`RaceCameraRig` の Finish）。
  - `lead_change`：先頭の2頭が入る少し引いた画。
  - `whip_burst`：ムチの瞬間の少し後ろから、抜いていく馬を追う。
  - `comeback`：後ろからの画で始め、最後は横。
  - `unique_skill`：既存のスキルのカットイン（§ ruleset 1.3）をそのまま出す。
  - `finish`：1着の馬のゴール。
- 同じ場面を何度見ても同じ画になること（カメラは時刻と主役だけから決める。乱数を使わない）。

## 5. 字幕
- 文字は `HighlightCaptions.Text`（日本語の元の文は `Headline`）。英語は `Loc.T`（ui-en.json）。例：「最後の直線で3頭抜き」→ "Passed 3 in the final straight"、「10番手から追い込んで2着」→ "Charged from 10th to finish 2nd"。
- **名前は馬の名前だけ**。乗り手の名前・プレイヤー ID・フレンドの表示名は出さない（§37 と同じ）。
- 文字「特大」で2行まで（見本は1行で入るように縮める：`fitText`）。

## 6. 終わりの画面と共有
- 最後の場面の後（または「スキップ」）：左に選ばれた3つの場面（番号・字幕・馬の名前、1位の場面に金の「いちばんの場面」）、右に主ボタン「見どころを共有 »」、「もう一度見る」、文字リンク「もどる」。
- 共有シート：1位の字幕（金）、馬・着順・タイム、コース、「名前・IDは入りません（馬の名前だけ）」。
  - 「画像で共有」（主）：`ShareCardAsync(recorder, sheet)`。写真は1位の場面の鍵の tick（`StillFrame()`）、カードは `ShareCard`（`Kind = "highlight_image"`、`Lines[0]` が字幕、透かし「ムチ一閃」）。
  - 「リンクで送る」：`ShareLinkAsync(new ApiHighlightLinks(api), sheet, online)`。**保存して公開した自分のリプレイだけ**。そうでなければボタンを押せない形にして `LinkNote(online)`（「保存して公開すると、リンクで送れます」／「リンクはオンラインで送れます」）を下に出す。途中で非公開にされていたら `LinkAllowed` が false に戻り、同じ案内。
- KPI はモデルが送る（`highlight_view` は再生が始まった時に1回、`highlight_share` は OS の共有シートが受け取った時だけ）。画面からは送らない。

## 7. 状態・英語・文字の大きさ・動き
- 再生できない（ハッシュが合わない・壊れたログ・古いルール）：`UnavailableText`（「見どころを再生できません」）だけのダイアログと「もどる」。違うレースを流さない。
- 英語：画面の文字は `Loc.T`。時刻・数字は字幕の中だけ。
- 文字「特大」：字幕のパネルと終わりの画面の行ははみ出さない（見本は a11y-flow で確認）。
- 動きを減らす：つなぎのスイープ無し、背景の絵の漂いも無し。
- アカウントの切り替え（`AccountChangeReset`）：見どころは端末に何も保存しないので、消すものは無い。画面が開いていれば閉じる。

## 8. 絵・音
- 新しい絵は要らない（3D のレースそのもの）。場面の番号の小さなアイコンを付けるならシアン1色の線画。
- 音：場面の切り替えに短い「シュッ」（既存の UI 音から）。実況の音声は窓の中の行だけ。
