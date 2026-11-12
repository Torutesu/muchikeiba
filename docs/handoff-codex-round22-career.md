# Round 22 Codex 向け引き継ぎ：騎手の道（REQ-CAREER-001〜024）

更新：2026-11-11　基準ブランチ：`feat/r22-career`（`origin/claude/round20` から）
仕様：`contracts/protocol.md` §66、`docs/spec/requirements.md` 66章、経済 E20（`docs/spec/balance-targets.md` 4.20）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・レースの組み立て・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/career`・`POST /v1/career/races/:raceId/start`（鍵つき）・`POST /v1/career/submit`。`server/master/career.json`（5章・17戦・物語は日本語と英語を並べて持つ）。週替わりチャレンジと同じ検証の道（端末は入力だけを送り、検証サーバーが計算し直し、サーバーが星を決める）。報酬は初クリアと星ごとに一度だけ（配合素材。出荷の表は無償コイン 0） |
| C# | ✅ `engine/Muchi.Client/Career.cs`：`CareerView`・`CareerChapter`・`CareerRace`・`CareerObjective`・`CareerProgress`・`CareerSession`・`CareerResult`・`CareerGrant`・`CareerRun`（`ChallengeRun` + 星の目標、`StarsNow`、`IsCareer`、`ModeLabel`「騎手の道」）、`ApiClient.GetCareerAsync`・`StartCareerRaceAsync`・`SubmitCareerRaceAsync`、エラーコード `CAREER_*`。見本の設定 `contracts/career-configs.sample.json` |
| ゲーム層 | ✅ `Muchi.Game.CareerModel`（`unity/Assets/Muchi/Game/CareerModel.cs`、チェック `unity/Checks~/GameChecks/CareerChecks.cs`）。英語は `ui-en.json`（物語・題はサーバーが要求の言語で返す） |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → レース（出走登録）→「騎手の道」。地図 → 出走前 → レース（本物の WASM エンジン）→ 結果 |
| **Codex** | 入口（§2）、地図（§3）、レースの詳細（§4）、出走前（§5）、レース中（§6）、結果（§7）、絵（§8）、アクセシビリティ（§9） |

## 2. 入口

- レースの出走登録画面の下、「練習レース」の隣に小さめのゴーストボタン「騎手の道」。`CareerModel.EntryVisible(inFtue)` が false の間（FTUE の途中）は出さない。
- **その他（設定）の一覧には足さない**（2ページとも8行で満杯）。次にやること（§45）のカード・ポップアップで勧めない（§58.11 の「一度に1つの割り込み」を使わない）。
- オフライン：`LoadAsync` が `Offline(...)` を返したら「騎手の道はオンラインで遊べます。練習レースはオフラインでも遊べます」と練習への導線。

## 3. 地図（`CareerModel.LoadAsync` → `Map()`）

**章を写真の縦の道として描く**：下が第1章、上が最後の章（頂へ登る道）。背景は写真（見本は `Art/title-screen`）、左に紺のパネル（見本 760×676）、右に選んだレースの詳細（748×676）。

- 道：章の帯（`CareerChapterRow`）を縦に積み、その後ろを1本の細い道（金→シアンのグラデーション）が通る。帯の左に章の写真（`Art` → §8）、右に `Kicker`「第1章」（小さな字間のシアン）・`Title`・`StarsText`「星 4/9」（右寄せ）・`CapText`「能力の上限 2,800」。
- レースのノード（`CareerNode`）：帯の中に横に並ぶ丸いボタン。表示は `StarGlyphs`「★★☆」、読み上げは `Index`＋`Title`＋`StarsText`。`Next` は金の縁、選んだものはシアンの縁と光、`Unlocked == false` は鍵の印と灰色。
- 開いていない章（`Unlocked == false`）：写真を白黒で暗く、ノードは出さず「前の章をクリアすると開きます」。
- 見出し：`HeaderStars`「星 12/51」・`HeaderClears`「クリア 4/17」。
- 星は**形と文字の両方**で示す（色だけに頼らない）。点滅・きらめきのループは作らない。

## 4. レースの詳細（`Select(raceId)` → `Selected`・`DetailLines()`）

- 見出し `第1章　はじめての一閃　/　第1戦`、題（大きく）、右上に「★★☆　星 2/3」。
- `CourseText`（「芝2400m・重・ナイター」、金）・`FieldText`（「7頭立て・CPU Lv2・相手は逃げ・先行」）。
- 物語（`Selected.StoryBefore`）：左に金の縦線、行間を広めに。**プレイヤーの名前・翻訳の通しはしない**（サーバーが言語ごとに返す）。
- 目標の行（`DetailLines`）：「☆ 星1　3着以内でゴール」＋右に報酬（`RewardText`「報酬：配合素材×1」／「受け取り済み」）。取った星は ★ と金。
- `ProgressText`「挑戦 2回・最高 2着」、`LockedText`（開いていない時、CTA は押せない）。
- CTA「出走前へ »」（`CanStart`）。小さなリンク「騎手の道とは（ヘルプ）」（ヘルプの文脈 `career`）。下に `RulesText`（固有スキルなし・相棒でも上限・報酬は一度だけ・何度でも無料）。
- **スタミナ・行動力・回数・残り時間・有料のコンティニュー／スキップの表示は作らない**（無い）。

## 5. 出走前

- 章の写真を全面に、左に紺のパネル。見出し「騎手の道　/　第1章　第1戦」、題、**物語（前）を大きく**、コース・頭数、「出走馬　アイボウ（差し）」（**馬の名前は翻訳しない**）、「能力は章の上限 2,800 にそろえます　·　固有スキルなし」、目標の3行。
- CTA「ゲートへ »」→ `StartAsync(horseId)`（鍵を覚えて再送するので、二度押し・通信の失敗で2回始まらない）。リンク「地図に戻る」。
- 馬は自分の現役の馬なら何でもよい（見本は相棒）。馬の選び方は練習（§50）の ‹ › と同じでよい。

## 6. レース中（`Run`：`CareerRun`、中身は `ChallengeRun` の `OfflineRace`）

- **普通のレースの HUD をそのまま使う**（週替わりチャレンジと同じ）。その上に `HudLines()`（クリアの目標1行、`Value` に「現在 2位」など、`Ok == false` で赤）。
- バナーの種類の表示は「騎手の道」（`CareerRun.ModeLabel`）。写真（§38）は止めて撮れる（ひとりのレース）。写真・共有のカードの種類も「騎手の道」（`PhotoMode`・`ReplayClip` は対応済み）。マイリプレイには保存しない。
- ゴールしたら `SubmitAsync()`。`Phase == Submitting` の間は「判定中」の控えめな表示（失敗したら同じ走りを送り直せる：`Message` とボタン「もう一度送る」）。

## 7. 結果（`Phase == Result`）

- 左のパネル：`Headline`「クリア」（金）／「あと一歩」（白。**負けの演出・有料の続きは出さない**）、大きな `ResultGlyphs`「★★☆」と `ResultStarsText`「星 2/3」（読み上げはこちら）、着順・タイム・ムチの回数、`ResultLines()`（○／×＋目標、`Newly` は「NEW」の札）、`RewardLines`（金）、`UnlockLine`「次のレース「長い直線」が開きました」、`ChapterLine`「第1章 クリア」、`RetryNote`「何度でも無料でやり直せます」。
- 新しい星（`Newly`）は1つずつ置かれる短い演出（0.3秒程度、**動きを減らす設定では演出なしで最終の形**）。
- 右下：クリアした時だけ物語（後）`StoryAfter` の帯（「その後」）。
- CTA「騎手の道へ »」（開いたレースを選んだ地図へ）。リンク「もう一度」（`Continue()` → 詳細 → 出走前）。
- 判定は必ずサーバーの答え（`Result`）を出す。来るまでは端末の判定（`DeviceStars`）で仮に出してよい。

## 8. 絵（章の写真）

`CareerChapterRow.Art`（`server/master/career.json` の `art`）ごとに1枚、写真の質感（今の `Art/` と同じトーン）。見本は今ある絵で代用している：

| art | 章 | 見本の代用 | 描いてほしいもの |
|---|---|---|---|
| `dawn` | はじめての一閃 | `Art/Courses/spring-course` | 夜明けの調教コース、朝もや |
| `rain` | 雨の日の手綱 | `Art/Weather/rain` | 雨の芝コース、水たまり |
| `night` | ナイターの灯 | `Art/Weather/cloudy` | 照明の灯ったナイターのスタンド |
| `north` | 遠征・北の競馬場 | `Art/Weather/fog` | 北の競馬場（ノルトハーフェン）、冷たい風 |
| `summit` | 一閃の頂へ | `Art/Courses/autumn-course` | フルゲートの大舞台、満員のスタンド |
| `coast`・`snow`・`derby` | （将来の章のための予約） | — | 今は不要 |

ヒント集（§57）のカード `career_stars` の絵 `career`（地図の道と星の小さな挿絵）も1枚。

## 9. アクセシビリティ（§41）

- 文字の大きさ（`TextScale`）：地図・詳細・出走前・結果の文字は全部従う。最大でもはみ出さない（見本の a11y-flow で確認）。
- 星は形（★☆）と文字（「星 2/3」）の両方。ノードの読み上げは「第1戦 デビュー戦　星 2/3」。色だけで開いた・閉じたを示さない（鍵の印と文字）。
- 動きを減らす：星の演出・道のスクロールの演出を止める。点滅はしない（`FlashLimiter` の対象の演出を作らない）。

## 10. 法務・言葉

- 物語・題に賭けの言葉（共通の一覧）・ショップの言葉（倍・お得・今だけ・残りわずか・通常価格）を使わない（サーバーの検査で落ちる）。英語も同じ。
- 報酬の表示は「無償コイン」「配合素材」だけ（りんごのおやつはデイリーミッションだけで、ここでは出ない）。有償コイン・ガチャ券の表示は出ない。
