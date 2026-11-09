# Round 14 Codex 向け引き継ぎ：殿堂・引退式の画面（REQ-HOF-001〜016）

更新：2026-11-09　基準ブランチ：`feat/r14-hall-of-fame`（`origin/main`、Round 12 統合済み）
仕様：`contracts/protocol.md` §34、`docs/spec/requirements.md` 34章、法務：`docs/planning/03-legal-risk.md`「殿堂」、経済：コインは出ない（E の目標なし。報酬は非売品の飾り1つ）

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ 馬ごとの戦績（確定したレース・検証済みのタイムアタック・大会の確定順位だけから）、`POST /v1/horses/:horseId/retire` の応答に引退式 `ceremony`、`GET /v1/hall`・`GET /v1/hall/:playerId`・`GET /v1/horses/:horseId/career`・`POST /v1/hall/ceremonies/:horseId/ack`（冪等）・`PUT /v1/hall/settings`、公開用の写し（DirectoryDO `halls`）、KPI `hof_induct` / `hof_view` |
| C# | ✅ `ApiClient.GetMyHallAsync` / `GetHallAsync` / `GetHorseCareerAsync` / `AcknowledgeCeremonyAsync` / `SetHallVisibilityAsync` / `RetireHorseAsync`、`HallPage`・`HallPlaque`・`HallCeremony`・`HorseCareer`（`engine/Muchi.Client/Hall.cs`） |
| ゲーム層 | ✅ `Muchi.Game.HallModel`（`unity/Assets/Muchi/Game/HallModel.cs`、チェックは `unity/Checks~/GameChecks/HallChecks.cs`）。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → 厩舎 → 左上「殿堂」。「デモ：引退式」で引退式、「デモ：友達の殿堂」で友達の殿堂（中身は本物のサーバーのコード） |
| **Codex** | 引退式（§2）、殿堂の一覧（§3）、銘板の詳細（§4）、友達の殿堂（§5）、厩舎・馬の詳細からの入口（§6）、新しい絵（§7） |

## 2. 引退式（`HallModel.Ceremony` = `CeremonySheet`）

いちばん大事な画面。引退した直後（`RetireAsync` の後）か、見逃した引退式がある時（`LoadMineAsync` の後、`Ceremony != null`）に全画面で出す。**1頭に1回**：閉じたら `DismissCeremonyAsync`（サーバーで既読、何度呼んでもよい）。次の未読があれば続けて出る。

- 背景：`Art/race-result` を暗めに、左に紺のパネル（見本：x 36・y 60・700×780）。
- 右半分に**その馬の写真風の絵を大きく**（`HorseCareer` / プレートの `Appearance` → `AssetKeys.HorseKeys`。見本は相棒のプレビュー絵で代用）。ゆっくり寄るカメラ、夕方の光。
- パネルの中：小さなシアンの見出し「引退式　/　RETIREMENT」、馬の名前（**プレイヤーが付けた名前をそのまま。翻訳しない**）、金の文字で `CareerText`（`34戦11勝・3着以内20回`、相棒なら「· 最初の相棒」）。
- 「戦績の見どころ」：`Highlights`（サーバーが決まった順で作った最大5行）を1行ずつ、0.4秒おきにフェードイン。行頭に短いシアンの線。
- 殿堂入り（`Inducted`）：右上に**「殿堂入り」の判子**（赤い二重丸、−14°、上から押されて少し跳ねる。見本 `.hof-stamp`）。SE は「ポン」と重めの和太鼓1打。下に `ReasonText`（`10勝・大会優勝`）。
- 最初の殿堂入りなら `RewardText`（「殿堂の額縁を受け取りました（マイ厩舎に飾れます）」）。額縁のアイコンを添える。
- 殿堂入りでない時：判子は出さず `FarewellText`（「おつかれさま。これからは配合で血をつなぎます」）。**残念がらせない**、静かな演出。
- 主ボタン「つづける »」1つだけ。ショップ・購入への導線は置かない。

## 3. 殿堂の一覧（`HallModel.LoadMineAsync` / `Cards`）

- 背景 `Art/home-paddock`、上に `TopBar`（「殿堂　/　HALL OF FAME」と `RulesText` を小さく）。
- 左のパネル：`CountText`（大きな金の数字）、`CriteriaText`、額縁を持っているか、相棒の進み具合（`LoadCareerAsync(相棒)` → `ProgressText`）、公開範囲の3択（`VisibilityTexts`、`SetVisibilityAsync`）。
- 右：銘板のカード 3列×2段（`PlaqueCard`）。絵（`Appearance`）・名前・`CareerText`・`ReasonText`（シアン）・`InductedText`。額縁を持っていれば（`Frame`）金の細い縁取り。
- ページ送り：「次へ」で `LoadMoreAsync`（キーセットなので新しい殿堂入りがあってもずれない）。見本は「前へ／次へ」。
- 空の時：`EmptyText` と「引退の時に条件を満たした馬が、ここに銘板として残ります」。

## 4. 銘板の詳細

カードをタップ → 右から引き出し（見本 `PlaqueDetail`）。大きな絵（額縁があれば金の縁）、レア度・戦績の1行、殿堂入りの理由、見どころの行、殿堂入りの日付。将来は銘板の3D（真鍮の板に名前を刻む）にしてよい。

## 5. 友達の殿堂（`HallModel.VisitAsync(playerId)`）

- 入口：フレンド一覧・支部のメンバーのプロフィールに「殿堂を見る」。
- 一覧と同じ見た目で、タイトルは `TitleText`（「アオバの殿堂」）。設定（公開範囲）は出さない。持ち主の勝負服（`Page.Owner.Silks`）を左のパネルに。
- 見られない時（殿堂が無い・友達でも支部の仲間でもない・ブロック・非公開）は**全部同じ一文**「この殿堂は見られません」（`Message`）。理由は出さない。

## 6. 入口

- 厩舎の画面：左上に「殿堂」（見本は BACK の右の小さなボタン）。
- 馬の詳細：「戦績」タブ（`LoadCareerAsync` → `Career.Career`・`ProgressText`）。引退ボタンの確認文は `RetireConfirmText(name)`。
- ホームのバッジ：未読の引退式があれば厩舎に小さな点（`PendingCeremonies.Count > 0`）。

## 7. 新しい絵・音（Codex）

| キー | 内容 |
|---|---|
| `decor/hall_plaque_frame`（`item/decor_hall_plaque_frame`） | 飾り「殿堂の額縁」：マイ厩舎の飾り枠に置く金の額。アイコンも |
| 引退式の背景 | 夕方の競馬場、観客席のシルエット（既存 `Art/race-result` の別ライティングでよい） |
| 判子 | 「殿堂入り」赤い朱肉の判子（スプライト、英語は「HALL OF FAME」） |
| 銘板 | 真鍮のプレート（名前・戦績を刻む。名前は実行時に描く） |
| SE | 判子（和太鼓1打）、見どころ1行ごとの小さな「チン」 |

## 8. 守ること（03「殿堂」）

- 名前はプレイヤーが付けたまま（英語でも訳さない。カタカナは既存どおりローマ字表示）。
- 殿堂入りは確定したレースの成績だけ。**購入・アイテム・ガチャへの導線を置かない**。「倍」「今だけ」「残りわずか」などは使わない。
- 友達の殿堂で、持ち主の支部・公開範囲・ブロックは出さない。
