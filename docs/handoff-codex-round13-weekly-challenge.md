# Round 13 Codex 向け引き継ぎ：週替わりチャレンジの画面と演出（REQ-WCH-001〜016）

更新：2026-11-09　基準ブランチ：`feat/r13-weekly-challenge`（`main` ＝ Round 11 から）
仕様：`contracts/protocol.md` §31、`docs/spec/requirements.md` 31章、経済：`docs/spec/balance-targets.md` 4.16（E18）、法令：`docs/planning/03-legal-risk.md`「週替わりチャレンジ」

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/challenges/weekly`・`POST /v1/challenges/weekly/:challengeId/start`（冪等キー必須）・`POST /v1/challenges/weekly/submit`（検証器で再シミュレーション、セッション単位で冪等）。KPI `challenge_start` / `challenge_clear`、設定 `progression.weeklyChallenge` の検証、レースのモード `challenge` |
| エンジン | ✅ `RaceMode.Challenge`（シミュレーションは変わらない。ラベルだけ）。**検証器を先にデプロイ**してからサーバーを出す（`ParseMode("challenge")`） |
| C# | ✅ `ApiClient.GetWeeklyChallengesAsync` / `StartWeeklyChallengeAsync` / `SubmitWeeklyChallengeAsync`、`ChallengeRun`（`OfflineRace` を自分の枠で走らせる・ムチの数・条件が破れたか）、`ChallengeEvaluator`（サーバーと同じ判定）、エラーコード `Challenge*` |
| ゲーム層 | ✅ `Muchi.Game.WeeklyChallengeModel`（`unity/Assets/Muchi/Game/WeeklyChallengeModel.cs`、チェックは `unity/Checks~/GameChecks/WeeklyChallengeChecks.cs`）、エラー文 `UxText.Errors["CHALLENGE_*"]`、英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → ホームのカード「週替わりチャレンジ」（タイムアタックの解放後）→ 一覧 → 「貸し出し馬で挑戦」→ レース（左上に条件）→ 結果 |
| **Codex** | ホームのカード（§2）、一覧（§3）、レースの HUD の条件の行（§4）、結果とバッジの演出（§5）、バッジの絵（§6）、音（§7） |

## 2. ホームのカード

- 置き場所：ホームのカードの枠（左、お知らせ／復帰／広告のカードの下）。お知らせのカード（縦長）が出ている時は出さない。
- 中身：`HomeTitle`（今週のチャレンジ 1/3）、`HomeSubtitle`（あと4日で入れ替え — サーバーの週の終わりから。**カウントダウンの秒は出さない**）、ボタン「挑戦する」（`BadgeEarned` なら「バッジ獲得済み」）。
- 解放：タイムアタック（`time_attack`）が解放されたら出す。サーバーは解放で制限しない。

## 3. 一覧（`LoadAsync` → `Cards` / `NextCards`）

見本と同じ1600×900の構図。**写真の背景を全面に（`Art/first-ride`）、紺のパネルは2枚、主ボタン（斜めのシアン »）は1つ**。

- 左パネル：今週の3枚（`Cards`）。各カード：`Title`、`CourseText`（芝2000m・重・ナイター。コース名は `tracks.json` の名前）、`Conditions[].Text`（サーバーの条件の文）を金の太字で、`RewardText`（配合素材×1）、右上に `Cleared` なら「CLEAR」（金）／`ProgressText`（挑戦 2回・最高 2着）。クリア済みのカードは上の線を金に。選んだカードはシアンの枠で少し浮かせる。
- 右パネル（選んだチャレンジ）：タイトル（大）、コースと馬場、`FieldText`（8頭立て・CPU Lv3）、条件の行（◇の印＋文）、`LoanText`（貸し出し馬：ヒノデエクスプレス（逃げ））。主ボタン「貸し出し馬で挑戦 »」→ `StartAsync(id)`。副ボタン「相棒で挑戦」→ `StartAsync(id, horseId)`（脚質の条件に合わない馬は押せない。理由を小さく）。今週のバッジ（名前・あといくつ）と `BadgeNote`（見た目だけ）、`RulesText`（能力は上限にそろえる・スキルなし・貸し出し馬は上限ちょうど・報酬は週1回）を**必ず小さく表示**。「来週のチャレンジ」ボタン → `NextCards` をシートで（条件だけ）。
- **ショップ・課金への導線は置かない**（挑戦を有利にする商品は無い）。「倍」「お得」「今だけ」も使わない。

## 4. レース（`Phase == Racing`）

- レースは普段のレース画面（`RaceWorld` / HUD）をそのまま使い、`Run.Race`（`OfflineRace`）を `OfflineRaceDriver` に渡す。自分の馬は `Run.PlayerSlot`（枠順は抽選なので 0 とは限らない）。
- 条件の行：距離のチップの下に小さな紺の板。`HudLines()` を毎フレーム（または 5Hz で）読む。各行 `Text`（ムチ3回以内）＋ `Value`（ムチ 1/3、現在 3位、1:02.3）。**`Ok == false` になった行は赤**（もう満たせない）。脚質の行は開始時に確定しているので値なし。
- 上のバナーは「週替わりチャレンジ／レース中」。
- 中断ボタンはそのまま（中断したレースは送らない。回数は使ったまま）。

## 5. 結果（`SubmitAsync` → `Phase == Result`）

- ゴールしたら `SubmitAsync()`。送信中は端末の判定（`DeviceVerdict`）をうっすら出してよいが、**確定はサーバーの判定**（`Result`）。
- 大きく `ResultHeadline`（チャレンジ達成＝金／チャレンジ失敗＝白）。その下に着順・タイム・ムチの数。
- `ResultLines()`：条件ごとに ○（緑）/ ×（赤）＋文＋何が起きたか（2着、ムチ 4回）。行を順に（0.15秒ずつ）出す。
- `RewardLine`（報酬：配合素材×1 ／ 今週の報酬は受け取り済み）、`BadgeLine`（バッジ「青葉の一閃章」を獲得 — この回で3つそろった時だけ）、`WeekLine`（今週 3/3 クリア）。
- 「一覧へ »」→ `Continue()` → 一覧。「もう一度」→ 同じチャレンジを `StartAsync`。
- 送信が 5xx で失敗した時は `Phase` が `Submitting` のまま：同じ送信を再送してよい（サーバーはセッションごとに結果を保存している）。

## 6. バッジの絵（お願いしたいこと）

| バッジ id | 名前 | イメージ |
|---|---|---|
| `wch_badge_aoba` | 青葉の一閃章 | 青葉競馬場の若葉と一閃の光。シアンと金 |
| `wch_badge_minato` | みなとの夜章 | 港の夜景とナイターの照明。紺と金 |
| `wch_badge_bellmoor` | 直線の覇者章 | まっすぐな直線コースと風。白と金 |

- 丸いメダル型、128×128 と 512×512。`Art/badges/<id>` として `assets-catalog` に追加（ローテーションに週が増えたら同じ形で増やす）。
- **見た目だけ**：能力・報酬・ランダムの演出（ガチャ風の開封など）は付けない。獲得演出は金の光がさっと走る程度（1秒以内、タップで飛ばせる）。
- プロフィール／厩舎に獲得したバッジを並べる場所は今後（`View.Badges`・`BadgeCount` はもうある）。

## 7. 音・触覚

- 条件の行が赤になった瞬間に小さな低い音（責めない音量）。達成の結果で短いファンファーレ、失敗は静かに。
- 触覚：達成で短い振動。設定の触覚オフに従う（`GameSettings`）。

## 8. 確認の手順

- `dotnet run --project unity/Checks~/GameChecks`（`== 週替わりチャレンジ` の行がすべて ok）。
- `dotnet test engine/Muchi.Engine.Tests --filter WeeklyChallengeTests`（9つのチャレンジの設定が端末で走り、検証器と同じハッシュ・同じ判定になる）。
- 見本：`bash tools/figma-prototype/build.sh` のあと `index.html` → ホームのカード。`node tools/figma-prototype/test/e2e.cjs` で `u-*-weekly-challenge*.png` / `u-*-challenge-*.png` / `en-*-challenge-*.png` が出る。
