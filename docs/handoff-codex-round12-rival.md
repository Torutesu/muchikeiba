# Round 12 Codex 向け引き継ぎ：ライバルの画面（REQ-RIVAL-001〜016）

更新：2026-11-07　基準ブランチ：`feat/r12-rival`（`claude/round11`）
仕様：`contracts/protocol.md` §28、`docs/spec/requirements.md` 28章、経済：`docs/spec/balance-targets.md` 4.14（E16）、法務：`docs/planning/03-legal-risk.md`「ライバル」

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/rival`・`PUT /v1/rival/settings`・`POST /v1/rival/block`・`POST /v1/rival/challenge`・`POST /v1/rival/results/:weekId/seen`、週の登録簿（LeaderboardDO `rival:<週ID>`）、決定論の組み合わせと CPU のライバル、直接対決（確定したランク戦の着順）、タイムアタックの比較、週の精算（固定の無償コイン・称号）、プッシュ `rival_record`、KPI `rival_view` / `rival_race` / `rival_week_result` / `rival_opt` |
| C# | ✅ `ApiClient.GetRivalAsync` / `SetRivalOptOutAsync` / `BlockRivalAsync` / `ChallengeRivalAsync` / `MarkRivalResultSeenAsync`、`RivalView` ほか（`engine/Muchi.Client/Rival.cs`）、エラーコード `RivalChallengeLimit` |
| ゲーム層 | ✅ `Muchi.Game.RivalModel`（`unity/Assets/Muchi/Game/RivalModel.cs`、チェックは `unity/Checks~/GameChecks/RivalChecks.cs`）。ホームのタイル `rival`、機能の解放 `rival`（ランク戦5戦）、英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → ホーム上の細いカード「ライバル」→ 詳細。右のパネルの「デモ：同じレース」「デモ：タイム」「デモ：週を終える」で点・タイム・週の結果シートを出せる（中身は本物のサーバーのコード） |
| **Codex** | ホームのカード（§2）、詳細（§3）、週の結果シート（§4）、挑戦状の流れ（§5）、ブロック・お休みの確認（§6）、称号のアイコン（§7） |

## 2. ホームのライバルカード（`RivalModel.ShowHomeCard`）

見本と同じ位置：**シーズンのパネルと財布の間、画面の上の中央**（1600×900 で x 520・y 32・600×100）。お知らせ・復帰・広告のカードの枠（左の列）とは別。

- 左上の小さなシアンの見出し：`ライバル　/　あと5日`（`DaysLeftLine`）。週の結果が出ていれば `ライバル　/　結果が出ました`（`View.Result != null`）。
- 名前：`RivalName`（人間＝相手が付けた表示名、**翻訳しない**／CPU＝サーバーの名前、英語ではサーバーが英語で返す）。
- 右に金の数字で今週の点 `2 - 1`（`View.Score.Me` / `Them`）。
- タップで詳細へ。オプトアウト中・機能が未解放の時はカードを出さない。
- **急かす表現は使わない**：残りは「あと◯日」の事実だけ。点滅・カウントダウンの秒表示・「今すぐ」は無し（03「ライバル」）。

## 3. 詳細の画面

背景 `Art/home-paddock`、紺のパネル2枚、主ボタン（斜めのシアン »）は「挑戦状を送る」1つだけ。

**左パネル（今週のライバル）**
- 人間：`RivalName`（大）、`RivalSubline`（`C級・相棒 ハヤテ（差し）`）。**相棒の馬の3D／立ち絵**を置く（`View.Rival.Card.Partner.Appearance` → `AssetKeys.HorseKeys`、勝負服は `Card.Silks`）。出してよいのは公開カードの項目だけ（表示名・称号・クラス・勝負服・相棒）。レーティングの値・戦績・フレンド・支部は**出さない**。
- CPU：`RivalName`、`RivalSubline`（`先行・目標6着以内`）、`RivalLine`（性格のひとこと、吹き出し）。CPU の立ち絵は性格ごとに1枚（§7）。
- 解除（`Dissolved`）：名前は「ライバル解除」、カードの絵は出さない。説明「ブロック・お休み・退会のため、今週の組は解除されました」。
- 中央に大きく `あなた 2 - 1 ライバル`、その下に `RacesLine`（3戦未満なら「ランク戦 2/3戦（3戦で週の結果に報酬）」）と `DaysLeftLine`。
- 「挑戦状を送る（あと3回）」（`CanChallenge`、§5）、小さなリンク「ブロック」（人間の時だけ、§6）と「お休みにする」（§6）。

**右パネル**
- 最近のレース `Races`（新しい順、最大5行）：`Text`（`3着 vs 5着`／CPU は `4着（目標6着以内）`／挑戦状は `挑戦状 2着 vs 1着`）、右に「あなたに1点」（金）・「ライバルに1点」・「点なし」（挑戦状、`Challenge == true`）。
- タイムアタック `TimeAttack`（今週のベスト）：コース名・`MeText` vs `RivalText`（`1:10.2`）・速い方に印（`Faster`）。「同点の時だけ勝敗に使います」と小さく。
- `RewardsLine`（勝ち 20・引き分け 10・負け 10（無償コイン））、`RecordLine`（通算 3勝 / 5週）、`NextTitleLine`（称号「宿命の対決」まで あと2勝）。
- **`RivalModel.RulesText` を必ず小さく表示**（先着で1点・同点はタイムアタック・挑戦状は点にならない・報酬は固定で連勝の上乗せなし）。
- ショップ・課金への導線は置かない。「倍」「お得」も使わない。

## 4. 週の結果シート（`RivalModel.ResultSheet`）

詳細を開いた時に `ResultSheet != null` なら**1回だけ**シートを出す（閉じたら `DismissResultAsync()`、次からは出ない）。ホームでは自動で出さない（ホームのカードが「結果が出ました」になる）。

- 見出し `Headline`（勝ち／負け／引き分け／解除／記録なし）を大きく。勝ちは金の光、負けは静かに（責めない）、引き分けは中間。
- `ScoreText`（`直接対決 3 - 1`、同点をタイムアタックで決めた時は `直接対決 2 - 2・タイムアタック 2 - 1`）、`RivalText`（`vs 堅実のアサギ`）。
- `RewardText`（`無償コイン20枚`）があればコインが財布へ飛ぶ演出（**無償コインの財布**へ。有償の表示には触れない）。null なら `Note`（3戦未満／解除の理由）。
- `NewTitles` があれば称号の獲得演出（§7 のアイコン）。
- 演出はタップで飛ばせる。最後に「つづける »」。

## 5. ライバルと走る（挑戦状）

ランク戦のマッチングは変えない（決定事項、protocol §28）。挑戦状は**フレンド部屋**を使う：
1. 「挑戦状を送る」→ フレンド部屋を作る（既存の `CreateFriendRoomAsync` の流れ。部屋の条件の画面も既存のまま）。
2. 部屋ができたら `ChallengeAsync(passphrase)`。成功のトースト「挑戦状を送りました（このレースは点になりません）」。
3. 相手には既存の部屋の招待（`GET /v1/friends` の `invites`、プッシュ `room_invite`）として届く。相手がフレンドでなくてよい。
4. 挑戦状のレースはレーティング・ライバルの点にならない。結果は詳細の「最近のレース」に「挑戦状」として出る。
- 1日の回数を使い切ったらボタンを暗く（`ChallengeLine` は「挑戦状 あと0回」）。押したら `UxText.Errors["RIVAL_CHALLENGE_LIMIT"]`。

## 6. ブロック・お休み

- ブロック：確認のダイアログに `BlockConfirmText`（「◯◯さんをブロックします。今週のライバルは解除され、今後組まれることはありません」）→ `BlockAsync()`。ブロックは支部フィードのミュートと同じ一覧（設定の「ミュート中」から解除できる）。
- お休み：確認のダイアログ「ライバルをお休みにします。今週のライバルは解除され、来週から組まれません」→ `SetOptOutAsync(true)`。再開は詳細の「ライバルを再開する »」→ `SetOptOutAsync(false)`（来週から）。
- どちらも理由を聞かない。相手に通知しない（相手の画面では「ライバル解除」になるだけ）。

## 7. 描いてほしいもの（アセット）

| キー | もの | 備考 |
|---|---|---|
| `title/rival_first`・`title/rival_5`・`title/rival_20` | 称号のアイコン（好敵手・宿命の対決・ライバルキラー） | `contracts/assets.manifest.json` に追加済み（無ければ `title/default`）。見た目だけ |
| `rival/cpu/cpu_asagi`・`cpu_kurenai`・`cpu_hisui`・`cpu_kogane` | CPU のライバルの騎手の立ち絵（堅実・強気・気まぐれ・粘り） | 架空の人物。実在の騎手・有名人に寄せない（03）。無ければ汎用の騎手のシルエット |
| （任意）ライバルカードの縁 | 勝ち越し中は金、負け越しはシアン | 点の差で切り替えるだけ。数字を誇張しない |

## 8. 確認の手順

- `dotnet run --project unity/Checks~/GameChecks`（`== round 12: ライバル` の行がすべて ok）。
- 見本：`bash tools/figma-prototype/build.sh` のあと `index.html` → ホーム上の「ライバル」。`node tools/figma-prototype/test/e2e.cjs` で `u-*-rival*.png`（日本語）と `en-*-rival*.png`（英語）が出る。
- 英語：表示名（プレイヤーが付けた名前）は翻訳しない。それ以外の文は `Loc.T`（`ui-en.json`）で英語になる。
