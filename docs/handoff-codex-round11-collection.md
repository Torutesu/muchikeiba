# Round 11 Codex 向け引き継ぎ：図鑑・実績・称号（REQ-COL-001〜005・REQ-ACH-001〜011）

更新：2026-11-07　基準ブランチ：`feat/r11-collection`（`claude/round10` ＋ `main` から）　前提：`docs/handoff-codex-round9.md`（アセット配信の置き場とスキャナ）
仕様：`contracts/protocol.md` §24、`contracts/assets.md`、`docs/spec/requirements.md` §24、法務 `docs/planning/03-legal-risk.md`「図鑑・実績でコンプガチャを作らない理由」

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API・画面のビューモデル）／Codex＝見た目（図鑑の絵・バッジを作って置く・画面を描く）**。

## 0. 画面で守ること（法務。描き方で崩れるので最初に）
- 図鑑の**達成率は数字の表示だけ**。「コンプリートで◯◯」「あと1体」「もらえる」などの文言・演出（コンプ時の特別演出・報酬の宝箱）を**描かない**。サーバーの `notice`（「図鑑の達成率は記録の表示だけです。そろえても報酬はありません。」）を画面に出す。
- 未発見の馬は**シルエットと「？？？」だけ**。図鑑の画面から**スカウト（ガチャ）へのボタン・リンクを置かない**（「この馬を探す」等も不可）。
- 実績の画面には「課金やガチャの回数では達成しません」（サーバーの `notice`）を出す。報酬は「無償コイン◯枚」と事実だけ。「倍」「お得」は使わない。
- 称号は買えない。称号の一覧に購入の導線を置かない。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/collection`、`GET /v1/achievements`、`POST /v1/achievements/:id/tiers/:tier/claim`、`POST /v1/achievements/claim-all`、`GET /v1/titles`（`source`・`achievementId`・`tier` 付き）、`PUT /v1/player/title` |
| マスター | ✅ `server/master/collection.json`（説明文 `lore`・実績21個/71段・上限）、`titles.json` に実績の称号7つ |
| C# | ✅ `engine/Muchi.Client/Collection.cs`（`GetCollectionAsync`・`GetAchievementsAsync`・`ClaimAchievementAsync`・`ClaimAllAchievementsAsync`）、`AssetKeys.CollectionPortrait/CollectionSilhouette/Badge`、`TitleInfo.Source`、`StableTrophies.Badges`、`LockstepClient` が結果に `skills` を付ける |
| 画面のモデル | ✅ `unity/Assets/Muchi/Game/CollectionModels.cs`：`CollectionModel`（`Tabs`・`Cells`・`Selected`・`TotalText`・`TabCountsText`・`TabProgress`・`HideUnknown`・`Notice`）、`AchievementModel`（`Rows`・`ClaimAsync`・`ClaimAllAsync`・`Toast`・`Blocked`/`BlockedText`・カテゴリの絞り込み）、`TitleShowcaseModel`（`Unlocked`/`Locked`・`HintFor`・`EquipAsync`）。GameChecks `CollectionChecks.cs` |
| アセット | マニフェストに **128件**（下の §2）。ファイルは **0件**（プロトタイプは相棒の絵で代用、シルエットは同じ絵を黒くしたもの） |
| 画面 | **Codex**：図鑑・実績・称号（§3）。見本はプロトタイプ `tools/figma-prototype/site/index.html` の「機能・イベント → 図鑑 / 実績・称号」（デモ状態 `__muchi.demo('collection')`） |

## 2. 絵（Codex への依頼）
キーは `npm run gen:assets`（`server/`）で `contracts/assets.manifest.json` に入る。先読みグループは `home`（`contracts/assets.groups.json` の `collection/**`・`badge/*`）。ファイルを `unity/AssetDelivery~/` に置いて `npm run scan:assets` でカタログを作る（round 9 の手順のまま）。

| 種類 | キー | 数 | 絵の方向 |
|---|---|---|---|
| 図鑑の馬の絵 | `collection/portrait/<templateId>` | 27 | 写真のようなリアルな馬の立ち姿（ムチ一閃のキーアートと同じ光・色調）。馬の毛色・流星はテンプレートの見た目（サーバーの `templateAppearance`、ガチャの提供割合の行と同じ）に合わせる。背景は透過か暗い紺のグラデーション。正方形 1024×1024、表示は 200〜400 pt |
| 未発見のシルエット | `collection/silhouette/<templateId>` | 27 | 同じ構図の**真っ黒なシルエット**（輪郭に細いシアンの縁取り 1〜2 px）。毛色・模様が分からないこと。季節限定の馬も同じ扱い（ラベルはサーバーの文字を重ねる） |
| 実績のバッジ | `badge/<achievementId>_<tier>` | 71 | 六角形のメダル。段で地金を変える：1 銅・2 銀・3 金・4 白金（シアンの光）・5 黒金。中の図柄はカテゴリ（下）。文字は入れない（段の数字と名前はサーバーの文字を重ねる） |
| 既定 | `collection/portrait/default`・`collection/silhouette/default`・`badge/default` | 3 | 絵が届くまでの代わり（boot 同梱） |

バッジの図柄（`category`）：race 蹄跡と決勝線／course 競馬場の楕円（コースごとの実績は同じ図柄、地名の文字は重ねる）／skill シアンの閃光／breeding 2頭の横顔と系統線／time_attack ストップウォッチ／tournament トロフィー／stable 厩舎の屋根とハート／team 支部の旗と拍手。

## 3. 画面（モデルのフィールドに結ぶ）
- **図鑑**：タブ4つ（競走馬・固有スキル・コース・見た目＝`CollectionModel.Tabs`）。上に `TotalText`、タブの `TabCountsText` と `TabProgress` のメーター。格子は `Cells`（`Art`・`Title`・`StateLabel`・`Rarity`・`Badge`＝季節限定のラベル）。`Unknown` はシルエット＋「？？？」、`Seen` は絵（彩度を少し落とす）＋名前、`Obtained` は絵＋名前＋シアンの上辺。タップで右に詳細（`Selected`：`Lore`・`StatLines`）。「未発見を隠す」トグル＝`SetHideUnknown`。
- **実績**：カテゴリの切り替え（`CategoryLabels`）、行は `Rows`（`Name`・`Description`・`ProgressText`・`Meter`・`Badges`・`ClaimText`・`TitleTexts`）。受け取れる行が先頭。行の「受け取る」＝`ClaimAsync(id)`、右上の CTA は1つだけ「まとめて受け取る」＝`ClaimAllAsync`（`ClaimAllText`）。`Blocked` の時はボタンを出さず `BlockedText`。
- **称号**：`TitleShowcaseModel`。装備中（`EquippedName`）を大きく、`Unlocked` に「つける」、`Locked` は灰色で `HintFor(t, achievements)`（「実績『大会の覇者』1段で獲得」）。装備した称号はプロフィールとマイ厩舎の表札に出る（`StableSnapshot.TitleId`）。マイ厩舎のトロフィー棚に `Trophies.Badges`（最大6つ）を並べる。
- 入口：ホームの「機能・イベント」に「図鑑」「実績・称号」。実績の段が受け取れる時は、そのメニュー行に金の点（ミッションと同じ）。
- 演出：段の解放はレースの結果画面の後にトースト（`AchievementModel.Toast` の文言）。紙吹雪などの大きな演出は図鑑のコンプリートには付けない（§0）。

## 4. 確かめ方
- `dotnet run --project unity/Checks~/GameChecks`（`== round 11: 図鑑, 実績 and titles` の行が全て ok）
- `bash tools/figma-prototype/build.sh` → `node tools/figma-prototype/test/e2e.cjs`（`u-NN-collection-*`・`u-NN-achievements*` のスクリーンショット）
- 絵を置いたら `npm run scan:assets` と `server/test/visuals.test.ts`・`asset-delivery.test.ts`
