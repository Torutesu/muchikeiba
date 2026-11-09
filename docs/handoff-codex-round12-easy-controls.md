# Round 12 Codex 向け引き継ぎ：かんたん操作（REQ-ASSIST-001〜012）

更新：2026-11-07　基準ブランチ：`feat/r12-easy-controls`（`claude/round11` から）
仕様：`contracts/protocol.md` §27、`docs/spec/requirements.md` 27章、バランス：`docs/spec/balance-targets.md` §2.3（R11）、UX：docs/planning/06 REQ-UXU-030

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・補助そのもの・画面のビューモデル）／Codex＝見た目（画面・HUD・アニメーション・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| 補助（エンジンの外） | ✅ `Muchi.Client.InputAssistant`（`engine/Muchi.Client/InputAssist.cs`）。レベル `Off` / `Whip`（ムチだけおまかせ）/ `Full`（ぜんぶおまかせ）。**普通の入力バイトを作るだけ**：エンジン・ルールセット・検証・結果ハッシュ・リプレイ・ゴールデンは変わらない |
| つなぎ込み | ✅ オフライン `OfflineRace.Assistant`、オンライン `RaceSession.Assistant`（確定した tick ごとに `in` を送る。部屋の入力遅延が乗る）。`res` に自分のレベル（KPI専用、誰にも送られない） |
| サーバー | ✅ `GET`/`PUT /v1/player/assist`、`POST /v1/player/assist/prompt-seen`、`GET /v1/player` の `assist`。最下位3連続で一度だけの提案（`promptDue`）、KPI `assist_enable` / `assist_disable` / `assist_prompt_view` / `race_assisted` |
| C# クライアント | ✅ `ApiClient.GetAssistAsync` / `SetAssistAsync` / `MarkAssistPromptSeenAsync`、`PlayerView.Assist`（`AssistSettings`）、`Analytics.RaceStart(at, mode, assist)` |
| ゲーム層 | ✅ `Muchi.Game.AssistModel`（`unity/Assets/Muchi/Game/AssistModel.cs`、チェック `unity/Checks~/GameChecks/AssistChecks.cs`）。`GameBackend.AssistLevel` を練習・ランク戦の作成時に自動で付ける（チュートリアルには付けない）。`HudSnapshot.Assist` / `AssistLabel` / `WhipAuto` / `SteeringAuto` |
| 公平性 | ✅ R11：おまかせの勝率は上手い手動操作の 0.60 倍（必ず 1.0 未満）、一騎打ち 41%、何もしない人より平均6着以上よい（全8コースでも成立）。`engine/Muchi.Engine.Tests/InputAssistTests.cs` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → その他（設定）の「かんたん操作」→「変更する」。レースは本物のエンジンで補助が走る（何も押さなくてもスタート・手綱・ムチ）。提案シートは設定のデモ「最下位が3回続いた（デモ）」 |
| **Codex** | 設定の画面（§2）、提案シート（§3）、HUD の表示（§4）、自動のボタンの見せ方（§5）、音・触覚（§6） |

## 2. 設定：「かんたん操作」の画面

見本と同じ1600×900の構図（`AssistSettings`）。背景 `Art/first-ride`（レースの写真）、紺のパネル1枚、カード3枚。

- 入口：設定（その他）のアカウントの欄に1行「かんたん操作」＋今のレベル（オフは灰、オンはシアン）＋「変更する」。**FTUE 中は出さない**（`GameBackend` の FTUE フラグ、見本は `ftue`）。
- 3枚のカード（`AssistModel.Options`、左からオフ・ムチだけおまかせ・ぜんぶおまかせ）：
  - 小さな英字の飾り（`MANUAL` / `AUTO WHIP` / `FULL AUTO`、文字間を広く、シアン。全部おまかせは金）→ 名前（`Label`、30px 太字）→ 説明（`Description`、2行まで）。
  - 選ばれているカード（`Selected`）はシアンの枠＋「設定中」（押せない）。他は主ボタン「これにする »」→ `SetAsync(level, AssistSource.Settings)`。
- カードの下に細いパネル「公平性」：`AssistModel.TextPolicy`（ランク戦でも使える・上手な操作より強くならない・相手には見えない）と `TextTutorial`（はじめてのレースでは使えない）。**この文は必ず出す**。
- 保存は即時。レース中は変えられない（変えても次のレースから）。オフラインでは端末に残す（`TextOffline` をトースト）。

## 3. 一度だけの提案シート

- 条件は全部サーバーが決める：`AssistModel.ShouldShowPrompt(inFtue)` が true の時だけ（最下位が3回続いた・補助がオフ・まだ出していない・FTUE ではない・削除の手続き中でない）。
- **出す場所**：結果画面から「ホーム」「もう一度」で離れる時。同じタイミングで課金の案内（T2/T4）が出る時は**出さない**（次の機会に回る。1回に2枚の割り込みを作らない）。
- 出したらすぐ `MarkPromptShownAsync()`（二度と出ない）。
- 構図（`AssistModel.Prompt()`）：暗くした `Art/first-ride` の上に中央の紺のダイアログ（1000×560）。キッカー「かんたん操作」→ 見出し `Title`「かんたん操作を試してみませんか？」→ 本文 `Body`（いつでも設定で戻せる）→ 3つのボタン **同じ大きさ・同じ強さ**（「ムチだけおまかせ」「ぜんぶおまかせ」「今はいい」。主ボタンの斜めシアンは使わない＝押し付けない）→ 細い線 → `Note`（公平性の一文）。各おまかせボタンの下に説明1行。
- **急かさない**：タイマー・「今だけ」・点滅・効果音のファンファーレは使わない。負けが続いたことを責める言葉も出さない（「3回最下位」とは書かない）。
- 選んだら `SetAsync(level, AssistSource.Prompt)` → トースト `TextSaved` → 元の行き先へ。「今はいい」は何も保存せず元の行き先へ。

## 4. レースの HUD：「かんたん操作 ON」

- `HudSnapshot.AssistLabel` が null でない間だけ、小さなチップを出す（見本：残り距離のチップの右、上端から50px、228×44。紺の半透明＋シアンの細い枠、シアンの文字 15px、文字間 .16em）。動かない・光らない・点滅しない。
- **自分の画面だけ**。相手・観戦者・リプレイ共有のカードには出さない（サーバーも相手に送らない）。結果画面にも出さない（着順・報酬は補助なしと同じ）。
- チュートリアルでは出ない（`Assist` は常に Off）。
- 英語は `Easy Controls ON`（`Loc.T` 経由。長さが倍近いのでチップは文字に合わせて伸ばす）。

## 5. 自動のボタンの見せ方

| | ムチのボタン（右下の金の輪） | 手綱・内／外 |
|---|---|---|
| オフ | 今まで通り | 今まで通り |
| ムチだけ（`WhipAuto`） | 発走前は「スタート」で押せる。発走後は「おまかせ」（シアンの文字、輪をシアン寄りに）。押しても何もしない（補助が捨てる）ので、押した演出（「伸びる！」・FOV キック・触覚）は出さない | 今まで通り |
| ぜんぶ（`SteeringAuto`） | 最初から「おまかせ」 | 半透明（45%）にして押せなくする |

- 補助のムチが入った瞬間は、プレイヤーが押した時と同じ演出を出してよい（ムチの効果 `IsWhipActive` が立つ tick を見る）。補助の手綱・進路変更の演出も普段と同じ。
- 「今だ、ムチ！」（`WhipChance`）の光らせは補助中は控えめに（光らせても押す必要がない）。

## 6. 音・触覚

- 提案シート・設定：普段のボタン音だけ。
- 補助のムチ：普段のムチの音と触覚（強1回）。端末の触覚の設定に従う。
- 新しい音は要らない。

## 7. Codex が触らないもの（ロジック側の決まり）

- 補助の作り（定数）は R11 のテストで固定している。見た目の都合で変えない（変える時は Claude 側で `InputAssistTests` を測り直す）。
- 補助のコマンドは `RaceInput.Collect` と同じ `IRaceDriver.Input` の経路を通らない（ドライバーの中の `OfflineRace` / `RaceSession` が入れる）。画面側は `RaceInput` を今まで通り毎フレーム渡すだけでよい（補助が要らないビットを捨てる）。
- `AssistModel.Attach` は `GameBackend.CreatePracticeRace` / `Connect` が呼ぶ。独自にレースを作る画面がある場合は、作った直後に `AssistModel.Attach(driver, backend.AssistLevel)` を呼ぶ（チュートリアルでは呼ばない。呼んでも無視される）。
- KPI：画面側で送るのは既存の `race_start` に `Analytics.RaceStart(at, mode, backend.AssistLevel)` を使うことだけ。他はサーバーが出す。
