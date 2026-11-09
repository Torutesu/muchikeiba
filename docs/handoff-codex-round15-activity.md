# Round 15 Codex 向け引き継ぎ：アクティビティ（お知らせ一覧とホームのベル、REQ-ACT-001〜016）

更新：2026-11-09　基準ブランチ：`feat/r15-activity`（`main` = Round 13 統合後）
仕様：`contracts/protocol.md` §40、`docs/spec/requirements.md` 40章。経済の目標（E）は無し（表示とリンクだけでコイン・アイテムは動かない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/activity`（カーソル式、新しい順）、`POST /v1/activity/read`（何度送っても同じ）、`GET /v1/player` の `activity.unread`（ベルの数）。書き込みはプッシュと同じ箇所（フレンド申請・成立、ライバルの週の結果・記録更新、マイ厩舎のいいね、応援スタンプ、大会の結果、プレゼントの到着、支部の共同目標の段・週の結果） |
| C# | ✅ `ApiClient.GetActivityAsync` / `MarkActivityReadAsync`、`PlayerView.Activity`、`AnalyticsEvent.ActivityOpen` / `ActivityTap`、`ActivityKinds` / `ActivityScreens`（`engine/Muchi.Client/Activity.cs`） |
| ゲーム層 | ✅ `Muchi.Game.ActivityModel`（`unity/Assets/Muchi/Game/ActivityModel.cs`、チェックは `unity/Checks~/GameChecks/ActivityChecks.cs`）。`new ActivityModel(new ApiActivity(backend.Api), () => backend.Online, analytics.Track)`、ホームでは `SetBadge(player.Activity)` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` のホーム（封筒の下のベル）→ アクティビティ。デモは その他 →「アクティビティ（デモ）」 |
| **Codex** | ホームのベル（§2）、アクティビティの画面（§3）、行（§4）、行き先（§5）、空・読み込み中・オフライン・英語（§6） |

## 2. ホームのベル

上の帯の**プレゼントの封筒のすぐ下**（ライバルの帯と重ならない位置。見本は x=1088, y=122, 80×56、封筒と同じ紺のガラスにシアンの線のベルのアイコン）。
- バッジ：`ActivityModel.BadgeText`（null なら出さない、"1"〜"98"、上限なら "99+"）。封筒のバッジと同じ形だが色は**シアン系にしない**（封筒の金と同じ金の丸で可。見本は金）。
- タップで `OpenAsync()` を呼んで画面へ。ホームに戻ったら `GET /v1/player` の `Activity` で `SetBadge` しなおす（開いた後は 0 になる）。
- アニメーション：新しく数が増えたときだけ、ベルを小さく1回揺らす程度（点滅し続けない・音は鳴らさない）。

## 3. アクティビティの画面（「ムチ一閃」のトーン）

見本と同じ1600×900の構図。**背景は `Art/home-paddock` を全面に、左を暗くする影（`Shade('left')` 相当）、紺の半透明パネル2枚、主ボタン（斜めのシアン »）は1つ（「ホームへ」）**。
- 上の帯（`TopBar`）：題「アクティビティ」、小さな説明「留守の間のできごと　·　タップでその画面へ」、右に財布と EN。
- **左パネル（一覧）**：キッカー「新しい順」。行（§4）を縦に。下に「前へ」「次へ」（見本）または無限スクロールで `MoreAsync()`（`HasMore` の間だけ、`Loading` 中は何もしない）。
- **右パネル（まとめ）**：キッカー「未読」と大きな数（開いたときの数）、`WhatsNew > 0` なら文字リンク「新着情報があります」（おかえり・新着情報の画面へ。項目としては出さない）、細い線、キッカー「お知らせのきまり」と3行（まとめて1件で表示／受け取りはプレゼントボックス／プッシュの設定はプッシュだけ）、一番下に主ボタン「ホームへ »」。

## 4. 行（`ActivityLine`）

1行の高さ 64〜72。左から：
1. 未読の点（`Unread`、シアンの小さな丸に弱い光）。
2. 上の段：小さく字間を空けたラベル `Label`（フレンド／ライバル／マイ厩舎／支部／大会／プレゼント／リプレイ、**プレゼントだけ金**、他はシアン）と時刻 `When`（"11/09 12:00"、灰）。
3. 下の段：文 `Text`（白・太字・1行。読んだ行は少し暗く）。英語は長いので収まらなければ縮小（`fitText` と同じ考え方）。
4. 右端：控えめなゴーストボタン `Cta`（「見る」、プレゼントの行は「プレゼントボックスへ」）。**受け取るボタン・数量・中身は出さない**。
- アイコン：`Icon`（friend / rival / like / cheer / trophy / gift / team / replay）に合わせたシアンの線のアイコンをラベルの左に置いてよい（任意）。
- まとめた行（`Count > 1`）は文がすでに「マイ厩舎に12件のいいねが届きました」になっている。送り主の顔（`Source.Actors`、最大3人）を小さく重ねて出してもよい（任意。名前は訳さない）。

## 5. 行き先（`Tap(line)` が返す screen / id）

| `screen` | 開く画面 |
|---|---|
| `friends` | フレンド（申請の一覧） |
| `rival` | ライバル（週の結果のシート・詳細） |
| `stable` | マイ厩舎（自分の厩舎） |
| `team_feed` | 支部フィード |
| `tournaments` | 大会（`id` = 大会 id、結果・履歴） |
| `gift_box` | プレゼントボックス（受け取りはここで） |
| `team_goal` | 支部の共同目標 |
| `replay` | リプレイ（Round 14 のマイリプレイが入ったら。今は書かれない） |
| `whats_new` | おかえり・新着情報 |

`Tap` が `activity_tap` を送るので、画面側は返ってきた行き先を開くだけ。

## 6. 空・読み込み中・オフライン・英語

- 項目なし：`Message == ActivityModel.EmptyText`（まだお知らせはありません）を一覧の中央に。
- 読み込み中（`Loading`）：一覧の上に細いシアンのバー。
- オフライン：`Message == ActivityModel.OfflineText`（アクティビティはオンラインで確認できます）だけ。ベルは最後に知っている数のまま。
- 英語：モデルの文字列（ラベル・ボタン・メッセージ）は日本語なので `Loc.T(...)` で表示（`ui-en.json` に全部ある）。行の `Text` はサーバーが英語のリクエストなら英語で返す（プレイヤーの名前は訳さない）。
- 既読：開いて最初のページが出たら、モデルが見えている一番新しい id まで既読にする（この回は未読の点を残してよい。次に開いたとき消える）。失敗したら次に開いたときに送り直す。
- KPI：開くたびに `activity_open` を1回、行を押すと `activity_tap`（どちらもモデルが送る）。

## 7. 見た目の確認用スクリーンショット（見本）

`node tools/figma-prototype/test/e2e.cjs` の出力：`u-NN-activity.png`（デモの一覧）・`u-NN-home-bell.png`（ベルのバッジ）、英語は `en-NN-activity.png`。
