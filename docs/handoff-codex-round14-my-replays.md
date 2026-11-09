# Round 14 Codex 向け引き継ぎ：マイリプレイ（REQ-MYRP-001〜016）

更新：2026-11-09　基準ブランチ：`feat/r14-my-replays`（`origin/main` = Round 12）
仕様：`contracts/protocol.md` §37、`docs/spec/requirements.md` 37章、法務：`docs/planning/03-legal-risk.md`「マイリプレイ」。経済の目標なし（コイン・アイテムは動かない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・再生エンジン・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/replays`・`POST /v1/replays`（冪等キー）・`PATCH /v1/replays/:raceId`（名前・お気に入り・公開）・`DELETE /v1/replays/:raceId`・`GET /v1/replays/:raceId/data`・`GET /v1/friends/:playerId/replays(/:raceId/data)`。最近のレースと名場面（勝利・写真判定・自己ベスト）を `applyRace` で自動で覚える。保存は R2 `myreplays/<playerId>/<raceId>.json` に写す（保存期限の削除の対象外）。アカウント削除の手順 `replays`。KPI `replay_save` / `replay_view`（サーバー）、`replay_share`（クライアント） |
| C# | ✅ `ApiClient.GetMyReplaysAsync` / `SaveReplayAsync` / `UpdateReplayAsync` / `DeleteReplayAsync` / `GetReplayDataAsync` / `GetFriendReplaysAsync` / `GetFriendReplayDataAsync`、**`ReplayPlayer`**（全部を端末で再計算してハッシュを確かめてから再生、`engine/Muchi.Client/MyReplays.cs`）、エラーコード `ReplayLimit` / `ReplayExpired` / `ReplayTooLarge`、`AnalyticsEvent.ReplayShare` |
| ゲーム層 | ✅ `Muchi.Game.MyReplaysModel`（`unity/Assets/Muchi/Game/MyReplaysModel.cs`、チェック `unity/Checks~/GameChecks/MyReplaysChecks.cs`）。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → ホームの「機能・イベント」→「マイリプレイ」。「デモ：レースを走る」で本物のエンジンのレースが名場面・最近のレースに並ぶ。結果画面の「マイリプレイに残す」でも保存できる |
| **Codex** | 一覧（§2）、リプレイのシート（§3）、名前の変更シート（§4）、プレイヤー（§5）、再生できない時（§6）、フレンドの公開リプレイ（§7）、入口（§8） |

## 2. 一覧（`MyReplaysModel.LoadAsync`）

背景 `Art/race-result`、紺のパネル2枚。見本の画面と同じ構図（左 820×676：保存、右 684×676：名場面と最近のレース）。

**左パネル「保存したリプレイ　/　2 / 20」**（`CountText`）
- カード `SavedCards`（お気に入り → 保存の新しい順、1画面4枚・ページ送り）。各カード：
  - タイトル `Title`。`TitleIsTyped == true` は**プレイヤーが入力した文字列：翻訳しない・ローマ字にしない・Loc.T に通さない**（英語でもそのまま）。false はコース名（＋着順）。
  - `ResultText`（`1着 / 12頭`、1着は金）、`DateText`（`12/8`）、`CourseText`。
  - 小さなタグ：`MomentText`（勝利・写真判定・自己ベスト、金）、公開中なら「公開」（シアン）、再生できない時は「再生できません」（警告色）。
  - 右に ☆／★（`Favorite`）。
  - タップでリプレイのシート（§3）。
- 空：`MyReplaysModel.TextEmpty`。上限：`Full` の時は「残す」を押せない、`TextFull`。**購入・ショップへの導線は置かない**（枠は売らない）。

**右パネル「名場面と最近のレース　/　自動で入れ替わります」**
- `MomentCards` → `RecentCards` の順（新しい順、最大6行）。行：種類（勝利／写真判定／自己ベスト は金、最近のレース はシアン）・`ResultText`・コース・`KeepUntilText`（`12/30まで保存できます`、**本物の日付だけ**。カウントダウン・点滅・「急いで」は禁止）・「残す」ボタン（保存済みは無効で「保存済み」）。
- 行のタップで保存しないまま再生できる（元のログが残っている間）。
- 「残す」→ `SaveAsync(raceId)`（冪等キー付き。二重に押しても1件）。

## 3. リプレイのシート（右から出るシート）

- 見出し：タイトル（入力された物はそのまま）、`ResultText`・コース・日付、名場面。
- 主ボタン「再生する »」（`Playable == false` なら無効で `UnplayableText` を警告色で表示）。
- 「名前を変える」（§4）、「☆ お気に入り」（`SetFavoriteAsync`、オンで ★ と金）。
- チェック「フレンドに公開する」（`SetPublicAsync`）と、すぐ下に**必ず** `MyReplaysModel.TextPublicNote`（ほかのプレイヤーは馬の名前だけ）。
- 小さなリンク「このリプレイを削除」（`DeleteAsync`。確認ダイアログを1回挟んでよい）。

## 4. 名前の変更シート

- 入力欄1つ（最大 `TitleMaxChars` = 24 文字、プレースホルダーはコース名）。
- 端末での長さチェックは `TitleProblem(text)`、最後の判定はサーバー（NG 語 → `NG_NAME`「この言葉は使えません。別のタイトルにしてください。」、URL・制御文字 → `INVALID_NAME`）。エラーは入力欄の下に警告色で1行。
- 「保存する »」、リンク「タイトルを消す」（`RenameAsync(raceId, "")` → コース名に戻る）。
- 公開した時にほかの人に見える名前であることを1行で添える。

## 5. プレイヤー（`MyReplaysModel.OpenAsync` → `ReplayPlayer`）

`OpenAsync` は保存データを取って `ReplayPlayer.Open` を呼ぶ。**レース全体を端末で再計算し、結果ハッシュがサーバーの物と一致した時だけ** `Playable == true`。違うレースは絶対に流さない。

- 3D はライブのレースと同じ `RaceWorld` を使う：毎フレーム `player.Advance(Time.unscaledDeltaTime * 1000)` → `var f = player.Frame()` → 各馬 `CourseFrame.Horse(f.From[s], f.To[s], f.AlphaPermille)`、カメラは `CourseFrame.ToWorld(f.Camera)`（`RaceCameraRig` が `CameraSlot` の馬を追う：追走 → 直線 → ゴール横）。見本の `ReplayFrame`（`tools/figma-prototype/engine-wasm/Program.cs`）が同じ変換。
- HUD（左上）：`残り 200 m`（`f.RemainingM`、0 で「ゴール」）、`3位 / 12頭`（`f.Rank`）、`カメラ：アイボウ（あなた）`。
- 下の操作バー（紺の帯 1528×120、見本の位置）：
  - 再生／一時停止（`player.Paused`）。
  - 速度ボタン `0.5× → 1× → 2×`（`CycleSpeed()`、表示は `MyReplaysModel.SpeedLabel`。「倍」の字は使わない）。
  - カメラの馬：‹ 名前 ›（`SetCamera(slot)`、名前は `MyReplaysModel.CameraLabels(data)`＝**馬の名前だけ**。自分の馬は「（あなた）」、フレンドのリプレイの持ち主の馬は「（フレンド）」。ほかのプレイヤーの名前・ID は出さない）。
  - 主ボタン「最後の200mへ »」（`JumpToFinalStretch()`、選んでいる馬の残り200m）。
  - シークバー（`Seek(ms)`、`TimeMs` / `DurationMs`）と `0:42.1 / 1:31.3`。
  - 「共有」→ 共有カード（§5.1）。
- 演出：ムチ・固有スキルのエフェクトは `f.To[s].IsWhipActive` / `IsSkillActive` でライブと同じ物を出す。実況の字幕・効果音は 1× の時だけ（0.5×/2× では無し）でよい。

### 5.1 共有カード
`player.BuildShareCard(courseName)` は結果画面の共有（REQ-UXS-071）と**同じ `ShareCard`**（自分の馬の最後の200m）。動画は既存の `IClipRecorder` で `player.BuildClip()` を録る。OS の共有シートに渡したら `MyReplaysModel.Shared(friendReplay)`（KPI `replay_share`）。キャンセルは送らない。

## 6. 再生できない時

`Playable == false`（`Reason`）：`ruleset_retired`（運営が古いルールセットを引退させた）・`ruleset_unknown`（アプリが古い）・`hash_mismatch`（このアプリでは同じレースを再現できない）・`broken`。
- 画面中央のダイアログ：「このリプレイは再生できません」＋ `MyReplaysModel.Unplayable(reason)` ＋「違うレースを流さないため、再生しません。保存はそのまま残り、削除できます」＋「もどる »」。
- 一覧のカードは警告色の縁とタグ「再生できません」。削除はできる。

## 7. フレンドの公開リプレイ

- 入口：フレンドのプロフィール（既存のフレンド一覧）に「公開リプレイ」。`GetFriendReplaysAsync(playerId)` → 一覧（お気に入りの印は出さない）→ タップで `OpenFriendAsync`。
- 見られない時（フレンドでない・どちらかがブロック・持ち主が退会手続き中・BAN・非公開）は理由を言わず `Message`「このリプレイは見られません」。
- 持ち主の表示名はプレイヤーが付けた名前：翻訳しない。

## 8. 入口

- ホームの「機能・イベント」の一覧に「マイリプレイ」（見本と同じ）。
- 結果画面の「リプレイを共有」の隣に「マイリプレイに残す」（`SaveAsync`、トースト「リプレイを保存しました」）。名場面は自動で並ぶので、押さなくても `momentDays`（既定28日）は見返せる。

## 9. 守ること（03・06）

- 枠（20件）は無料で、**買えない**。上限の文言に購入・ショップを出さない。
- 期限は本物の日付だけ（`12/30まで保存できます`）。「残りわずか」「今だけ」・カウントダウンは無し。
- 英語の時：システムの文言は `ui-en.json` から（`Loc.T`）、**タイトルと表示名は入力されたまま**。
- 他人の情報：ほかのプレイヤーは馬の名前だけ。プレイヤー ID は保存データの中でも `p<slot>` に置き換えて届く。
