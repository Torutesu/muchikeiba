# Round 15 Codex 向け引き継ぎ：出走前アドバイスのパネル（REQ-ADV-001〜016）

更新：2026-11-09　基準ブランチ：`feat/r15-race-advice`（`main` ＝ Round 13 の統合）
仕様：`contracts/protocol.md` §39、`docs/spec/requirements.md` 39章、法令：`docs/planning/03-legal-risk.md`「出走前アドバイス」、KPI：`docs/ops/kpi-queries.md`「出走前アドバイス」

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/races/advice?context=…`（読み取りだけ・無料・全員同じ）。計算は純粋な関数 `computeRaceAdvice`（`server/src/domain/raceAdvice.ts`）。KPI はクライアントのイベント `advice_view` / `advice_follow` |
| 共有ベクター | ✅ `contracts/race-advice.vectors.json`（16ケース）。サーバー（TS）・C#（`RaceAdvice.Compute`）・プロトタイプの WASM が全部同じ出力（日本語の文まで）になることをテストしている |
| C# | ✅ `ApiClient.GetRaceAdviceAsync(RaceAdviceQuery)`、`RaceAdvice.Compute` / `Rules(RulesetParams)` / `Course(TrackSpec, …)` / `CheckWhipTip` / `WhipTipText`、`AnalyticsEvent.AdviceView` / `AdviceFollow` |
| ゲーム層 | ✅ `Muchi.Game.RaceAdviceModel`（`unity/Assets/Muchi/Game/RaceAdviceModel.cs`、チェックは `unity/Checks~/GameChecks/RaceAdviceChecks.cs`）。英語は `ui-en.json`（パネルの言葉）と `server-en.json`（サーバーの文、生成） |
| エンジン・検証器 | 変更なし（アドバイスは表示だけ。レースの設定にも結果にも関わらない）。デプロイはサーバーだけ |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → 「レースへ」（出走登録）の左のパネル、週替わりチャレンジの右パネルの「アドバイス」ボタン → シート、設定 →「出走前アドバイス オン／オフ」、レース結果の「アドバイス：…」の1行 |
| **Codex** | 出走登録のパネル（§2）、チャレンジのシート（§3）、設定のスイッチ（§4）、結果の1行（§5）、演出と音（§6） |

## 2. 出走登録（馬を選ぶ画面）のパネル

見本と同じ1600×900の構図。**写真の背景を全面に、右に出走登録のパネル（今まで通り）、左に紺の半透明パネル「出走前アドバイス」を1枚**。主ボタン（斜めのシアン »）は右の「ランク戦に出る」だけ。パネルの中にボタンを増やさない。

- 開く：画面に入ったら `OpenAsync(new RaceAdviceQuery { Context = "ranked" })`（部屋なら `Context = "friend", TrackId, Going, Night, Field = 部屋のメンバーの脚質`、イベントなら `"event", EventId`）。`Visible == false` の時はパネルを出さない（設定でオフ・オフライン）。オフの時は小さな板に `OffText` と「アドバイスを見る」（押すと `Enabled = true` → 開き直す）。
- 上：小さなシアンのラベル `Title`（出走前アドバイス）、右上に「アドバイスを隠す」（`Enabled = false`）。その下に細い文：ランク戦は「コースは出走時に決まります · 今日の8コースで計算」（`Result.CourseCount > 1`）、コースが決まっていれば「このコース・馬場で計算」。
- 馬の行（`Rows`、上から3頭まで。並びはサーバーの順＝合い方の順）：カード1枚ずつ。左に馬の名前（太字）、右に `GradeText`（よく合う＝金／合う＝シアン／条件外あり＝薄いグレー）。`Suggested` の行は右に「おすすめ · 」を前に付ける。2行目に理由を1つ（`Reasons` の `minus` があればそれ、無ければ `plus`、無ければ最初）。**◎○▲△ や数字の点数・％は出さない**（予想・賭けに見えるため。`FitPermille` は表示しない）。行を押す → `Select(horseId)`（その馬で出走する。ヒントがその馬について計算し直される。サーバーには聞き直さない）。選んだ行はシアンの枠で少し浮かせる。
- ヒント（`Lines`）：細い線の下に1行ずつ。`pick`（おすすめの文）は金の太字、`whip`（ムチ）はシアン、他は白。入りきらない分は省いてよい（最大6行程度）。
- 一番下に `Footnote`（「アドバイスは馬の適性とルールから計算しています。勝ちを約束するものではありません。」）を**必ず小さく表示**。
- 出走する時（「ランク戦に出る »」・部屋に入る・チャレンジを始める）に `OnEnter(horseId)` を1回（KPI。おすすめが無い時・オフの時は何も送らない）。
- **ショップ・ガチャへの導線を置かない**（「この馬を買えば」等）。候補は持っている馬だけ。

## 3. 週替わりチャレンジのシート

- 右パネル（選んだチャレンジ）の右上に小さな「アドバイス」ボタン（ゴースト）。押すと `OpenAsync(new RaceAdviceQuery { Context = "challenge", ChallengeId = id })` → シート。
- シート：大きくチャレンジ名、上に小さなラベル「出走前アドバイス」。馬の行は §2 と同じ（貸し出し馬も1頭として並ぶ。自分の馬は脚質の条件に合う馬だけ）、ヒント（`pick` 以外）、`Footnote`。閉じるボタンだけ。
- 「貸し出し馬で挑戦」→ `OnEnter("loan_<templateId>")`、「相棒で挑戦」→ `OnEnter(horseId)`。

## 4. 設定

- 設定 → 「見た目・お世話・仲間」の一覧の最後に「出走前アドバイス」の行。右に「オン」／「オフ」（`RaceAdviceModel.Enabled`、端末に保存、既定オン）。押すたびに切り替え。文言は `SettingLabel`（アドバイスを表示する）でもよい。
- チュートリアルは設定にかかわらず決まった短い版（`Context = "tutorial"`：「合図が出たら、ムチ」「ムチは間隔をあけて打つと伸びる」）。チュートリアルの画面で出すなら、レース前の暗転に1行ずつ。

## 5. 結果画面の1行（Round 8 の振り返りの下）

- ムチのアドバイス（`Result.Whip`）を見てから走ったレースだけ：`DebriefLine(recorder)`（`RaceDebriefRecorder` は結果画面の振り返りと同じもの）。例「ムチはアドバイスどおり残り400mから」「ムチがアドバイス（残り400m）より早かった」。
- 見本では敗因／勝因のヒントの下に、シアンの小さな文字で「アドバイス：…」。ランク戦はコースが出走時に決まるのでムチの数字が無く、この行は出ない（部屋・チャレンジ・コースが決まっている初めてのランク戦で出る）。

## 6. 演出・音

- パネルはふわっと出す（他の紺のパネルと同じ `rise`）。行を選んだ時だけ小さなクリック音。アドバイスで特別な効果音・きらめきは付けない（「当たり」に見せない）。
- 英語：全部の文は `Loc.T` 済み（`Lines` / `Rows` / `Footnote`）。英語は日本語より長いので、行は1行に収まらなければ縮める（`fitText` と同じ考え方）。

## 7. テスト・確認

- `dotnet test engine/Muchi.Engine.Tests --filter RaceAdvice`（ベクター・ルールセット・ムチの答え合わせ・英語）
- `dotnet run --project 'unity/Checks~/GameChecks'`（「round 15: 出走前アドバイス」の節）
- `cd server && npx vitest run test/race-advice.test.ts`（API・lint・公平性）
- プロトタイプ：`node tools/figma-prototype/test/round15-race-advice.test.mjs`、e2e の `u-*-race-lobby-advice.png`・`u-*-challenge-advice.png`・`en-*-lobby.png`
