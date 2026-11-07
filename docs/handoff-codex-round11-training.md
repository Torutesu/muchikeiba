# Round 11 Codex 向け引き継ぎ：調教の画面とアニメーション（REQ-TRAIN-001〜014）

更新：2026-11-07　基準ブランチ：`feat/r11-training`（`claude/round10` ＋ `main`）
仕様：`contracts/protocol.md` §25、`docs/spec/requirements.md` 25章、経済：`docs/spec/balance-targets.md` 4.12（E15）

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/training`・`POST /v1/training/start`・`POST /v1/training/:sessionId/finish`・`POST /v1/training/items/:itemId/use`、デイリーミッション `train1`、KPI `training_start` / `training_done`、設定の検証 |
| C# | ✅ `ApiClient.GetTrainingAsync` / `StartTrainingAsync` / `FinishTrainingAsync` / `UseTrainingItemAsync`、`TrainingScorer`（サーバーと同じ採点）、`Horse.Trained`、エラーコード `Training*` |
| ゲーム層 | ✅ `Muchi.Game.TrainingModel`（`unity/Assets/Muchi/Game/TrainingModel.cs`、チェックは `unity/Checks~/GameChecks/TrainingChecks.cs`）。ホームのタイル `training`、ミッションの種類 `training`、機能の解放 `training`（ランク戦3戦） |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → ホームのメニュー「調教」（または厩舎の「調教」）。ミニゲームはスペースキーでも押せる |
| **Codex** | 画面（§2）、ミニゲームの入力と表示（§3）、調教のアニメーション（§4）、結果の演出（§5）、音・触覚（§6） |

## 2. 画面の構成（「ムチ一閃」のトーン）

見本と同じ1600×900の構図。**写真の背景を全面に、紺のパネルは2枚、主ボタン（斜めのシアン »）は1つ**。

- 背景：選ぶ画面は `Art/home-paddock`、ミニゲームは `Art/first-ride`（どちらも `unity/design/figma-optimized-art`）。調教コース（坂路・ウッドチップ・プール）の写真を足す場合も同じ明るさ・色味にそろえる（プロンプトと類似チェックの記録は `docs/planning/03` の AI 生成素材の方針どおり）。
- 左パネル（馬）：名前・レア度・`ConditionText`（好調／ふつう／お疲れ）・絆Lv、疲れのゲージ（`FatigueProgress`、`FatigueWarning` で警告色）、素質のゲージ（`PotentialProgress`、金）、5能力の伸び（`Horse.Trained`）、りんごのボタン（`CanUseItem`）、**`TrainingModel.RulesText` を必ず小さく表示**（ランク戦は上限にそろえる・疲れはレースに影響しない・伸びは受け継がれない）。馬の切り替え（`SelectHorse`）。
- 右パネル（メニュー）：`Cards` の4枚（2×2）。各カード：`Name`・`FocusText`（伸びる能力）・`FatigueText`・`BondText`（併せ馬だけ）。`Enabled == false` のカードは暗くして `BlockedText` を出す（タップしたら同じ文をトースト）。選んだカードはシアンの枠。主ボタン「◯◯で調教 »」→ `StartAsync(menuId)`。その下に `SlotsText`。
- **ショップ・課金への導線は置かない**（調教を早める商品は無い。REQ-TRAIN-010）。「倍」「お得」も使わない。

## 3. ミニゲーム（ムチと同じ「押す瞬間」）

`Phase`：`Choose` → `Ready` → `Playing` → `Submitting` → `Result`。

1. `StartAsync` が成功すると `Ready`。「READY」を0.9秒ほど見せてから、**その瞬間の単調増加の時計**（`Time.realtimeSinceStartupAsDouble * 1000` など。`Time.time` はポーズで止まるので使わない）で `BeginMiniGame(nowMs)` を呼ぶ。
2. `Playing` の間、毎フレーム `Elapsed(nowMs)` でビートの位置を描く。`Session.Beats`（ms）がビートの時刻。見本は右から左へ流れる菱形が金の線に重なる形（`SPEED` 0.22px/ms）。ビートが判定の幅（`View.Timing.GoodMs`）に入ったら光らせる。
3. 入力：画面右下の金の輪の丸ボタン「追う」（レースの「仕掛ける」と同じ部品）と、画面のどこでもタップ（ボタンの外のタップも受けてよい）。押した瞬間の時計で `Tap(nowMs)` を呼ぶ。戻り値 `"perfect"` / `"good"` / `"miss"` で◎○×を一瞬出す。**`null` は記録されなかったタップ**（速すぎる連打など）なので何も出さない。入力は **押した瞬間**（タッチの `began`）で取る。指を離した時ではない。
4. `MiniGameOver(nowMs)` が true になったら `FinishAsync()`。「スキップ」は `Skip()` → `FinishAsync()`（伸びそのものは変わらず、上乗せが無いだけ）。
5. `LiveScore`（◎・○の数）は画面の隅に出してよい。数字はサーバーの採点と同じ（`TrainingScorer`）。
6. アプリがバックグラウンドに回った・電話が来た：そのまま放置でよい。次に開いた時 `LoadAsync` が開いたままのセッションをミニゲームなしで仕上げる。**一時停止してから再開する作りにはしない**（サーバーの時計が進むため、再開後のタップは不正として弾かれることがある）。

## 4. 調教のアニメーション（お願いしたいこと）

| メニュー | 場面 | 動き | 長さ |
|---|---|---|---|
| 坂路 `hill` | 上り坂のウッドチップ。カメラは横から少し前 | 力強い踏み込み、首を低く。ビートごとに騎手の扶助（ムチは使わない・見せない） | ミニゲームの6秒にそろえてループ |
| ウッド `wood` | 平坦なウッドチップの周回コース | 伸びのあるストライド。ビートで加速の気配 | 同上 |
| プール `pool` | 屋内プール。水しぶき | ゆっくり泳ぐ。疲れが取れていく（ゲージが減る演出） | 同上 |
| 併せ馬 `awase` | 2頭が並んで走る（相手は厩舎の別の馬の見た目、いなければ汎用の馬） | 並走して競り合う。絆が効く表現（相棒が相手を見て気合が入る） | 同上 |

- 3D の馬は `PartnerGallop` と同じモデル・同じ見た目（`AssetKeys.HorseKeys(Appearance)`）を使う。新しい骨格は要らない。速度だけメニューで変える。
- **動物福祉**（03）：ムチで叩く・痛がる・転ぶ・故障・汗だくで苦しそう、は描かない。疲れは「少し息が上がる」「首を下げて歩く」程度。`Condition == "tired"` の馬はメニューの選択画面で厩舎で休んでいる姿。
- ◎の瞬間：馬の足元に金の光、カメラが少し寄る（0.2秒）。○はシアンの小さな光。×は何も起きない（責めない）。
- 演出は飛ばせること（タップでスキップ）。リザルトまで最短2タップ（メニュー→「◯◯で調教」）＋ミニゲーム6秒。

## 5. 結果の演出（`Phase == Result`）

- `GradeText`（◎ 会心の追い切り／○ いい動き／△ まずまず）を大きく、`ResultHeadline`（+6）を金の数字でカウントアップ、`GainText`（瞬発+3・スタミナ+2・根性+1）を能力ごとに順に出す。素質のゲージが伸びる。
- `TimingText`（ミニゲーム ◎5 ○0 ×0（+10%））は小さく。`Result.Capped` なら「素質いっぱいまで伸びました」。
- 伸びが0（端数が次回へ持ち越し）の時は `ResultHeadline` が「伸びは次回へ持ち越し」。がっかりさせない静かな演出に。
- 「つづける »」→ `Continue()`。デイリーミッション「調教を1回」が達成なら、ミッション画面と同じ受け取り（`MissionBoardModel.ClaimAsync("train1")`）を案内してよい。
- 実況・ボイスは無し（v1）。入れる場合も実在のアナウンサーに寄せない（03）。

## 6. 音・触覚

- ビートの手前で小さな拍の音（メトロノーム程度）。◎で高い音、○で中くらい、×は無音。
- 触覚：◎で `navigator.vibrate(30)` 相当の短い振動（iOS は `UIImpactFeedbackGenerator.light`）。設定の触覚オフに従う（`GameSettings`）。
- 音が出せない環境でも視覚だけで遊べること（アクセシビリティ、06 §9.3）。ビートは色と形の両方で見せる。

## 7. 確認の手順

- `dotnet run --project unity/Checks~/GameChecks`（`== 調教` の行がすべて ok）。
- 見本：`bash tools/figma-prototype/build.sh` のあと `index.html` → ホーム「調教」。`node tools/figma-prototype/test/e2e.cjs` で `u-*-training*.png` が出る。
- 実機で、6秒のミニゲームの判定がずれないこと（タッチの遅延が大きい端末では `perfectMs` 60ms が厳しいことがある。その場合は数字をサーバーの設定 `progression.training.timing` で変えられる。クライアントのコードは変えない）。
