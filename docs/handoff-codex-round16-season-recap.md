# Round 16 Codex 向け引き継ぎ：シーズンの振り返りの画面（REQ-RECAP-001〜016）

更新：2026-11-09　基準ブランチ：`feat/r16-season-recap`（`origin/claude/round14` から）
仕様：`contracts/protocol.md` §43、`docs/spec/requirements.md` 43章、法務：`docs/planning/03-legal-risk.md`「シーズンの振り返り」、UX：`docs/planning/06-ux-experience-spec.md`（解放の表）、経済：コインもアイテムも動かない（E 番号なし）

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ シーズン（JST の暦月）とゲーム年（04:00 JST で切り替わる年）の記録を確定したデータだけから集め、締めの最初のトランザクションで1つだけスナップショットにする。`GET /v1/recaps`・`GET /v1/recaps/:id`・`POST /v1/recaps/:id/progress`（冪等）。KPI `recap_open`・`recap_complete`（サーバー）、`recap_share`（クライアント） |
| C# | ✅ `ApiClient.GetRecapsAsync` / `GetRecapAsync` / `RecapProgressAsync`、`RecapList`・`RecapView`・`RecapStep`・`RecapShare`（`engine/Muchi.Client/SeasonRecap.cs`）。`ShareCard` に `Lines` を追加、`AnalyticsEvent.RecapShare` |
| ゲーム層 | ✅ `Muchi.Game.SeasonRecapModel`（`unity/Assets/Muchi/Game/SeasonRecapModel.cs`、チェックは `unity/Checks~/GameChecks/SeasonRecapChecks.cs`）。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → 厩舎 → 左上「振り返り」。デモの歴史（2026年10月〜2027年1月、本物のサーバーのコードで走らせたもの）で短い版・通常版・1年の振り返りが見られる |
| **Codex** | 一覧（§2）、全画面のめくる振り返り（§3）、ページごとの絵（§4）、共有カード（§5）、入口とバッジ（§6）、動きを減らす（§7）、音（§8） |

## 2. 振り返りの一覧（`SeasonRecapModel.LoadListAsync` → `Rows`）

- プロフィール（厩舎）から開く。`Rows` は新しい順。1枚のカードに `Title`（「2026年11月シーズン」「2026年の振り返り」）、1年の物は金の縁（`IsYear`、ラベル `TextYearBadge`）、短い版は小さく「短い版」、未読は右上にシアンの `TextNew`（NEW）。
- 何も無い時は `Message`（= `TextEmpty`「振り返りは、シーズンが終わるとここに届きます」）。
- 見本：`Art/title-screen` の上に紺のパネル2枚（左に一覧、右に説明）。

## 3. 全画面でめくる振り返り（`OpenAsync(id)` → `Pages` / `Current` / `NextAsync` / `Back` / `SkipToEndAsync`）

いちばん大事な画面。**1ページに1つの数字**。ムチ一閃の調子：写真風の絵を全面に、左に暗いシェード、小さな字間の広いシアンのラベル、大きな数字、数行のメモ、右下に斜めのシアンの CTA「次へ »」1つ。

- 上：ページ数ぶんの細いバー（見ているところまでシアン）。その下に小さなシアンの見出し「{Title}　/　RECAP」。右上に小さく「最後まで」（`SkipToEndAsync`）。
- `Current.Label`：字間 0.3em 前後のシアン、22px 相当。
- `Current.BigText`：金の数字、見本は 168px（数字・「1着」「B級」「2:01.0」）。**`BigTextIsName` の時は馬の名前**（白、96px 相当）。**プレイヤーが付けた名前なので翻訳しない**（`Loc.T` を通さない）。
- `Current.Unit`：数字のすぐ右に 34px の白（「戦」/ 英語は「races」）。
- `Current.Notes`：数字の下に 22px の淡い文字で1〜3行（「3着以内 6回」「最終順位 4位」「C級からB級へ昇格」）。
- 殿堂のページ：`HorseNames` を大きめの白で縦に（名前はそのまま）。
- 名場面のページ（`Key == "moments"`）：`Moments` を1行ずつ、行頭に短いシアンの線、下に金の馬の名前。0.4 秒おきにフェードイン。
- 最後のページ（`IsEnd`）：ラベルだけを大きく（「おつかれさまでした」/ 短い版は「次のシーズンも、あなたのペースで。」）。CTA は「共有する »」、横に「一覧へ」。
- `View.SinceNote` があれば左下に小さく（「2026-11-09からの記録です」）。**消さない**：記録が途中からであることを正直に伝えるための行。
- 「戻る」は2ページ目から。`PositionText`（「3 / 8」）は好みで。
- 開いた時の「open」、最後のページに着いた時の「complete」はモデルが送る（1回だけ、サーバーも最初の時刻だけ残す）。画面は呼ぶだけでよい。
- **入れない物**：ショップ・購入・コインへの導線、カウントダウン、「もっと遊ぼう」などの煽り。

## 4. ページごとの絵（見本の割り当て、`RC_ART` in `site/app.js`）

| Key | 絵 | 演出の案 |
|---|---|---|
| races | `Art/first-ride` | 馬群が奥から走ってくるループ |
| wins | `Art/race-result` | ゴール板、紙吹雪は控えめに |
| best_finish | `Art/race-result` | 着順掲示板 |
| rank | `Art/title-screen` | クラスの紋章（C/B/A/S）が光る。昇格ならひとつ上の紋章へ |
| horse | `Art/partner-naming` ＋ 右半分にその馬の写真風の絵（`Appearance` は `GET /v1/player` の馬から引く） | ゆっくり寄るカメラ |
| time_attack | `Art/first-ride` | ストップウォッチの数字 |
| style | `Art/home-paddock` | 脚質の位置取りの図（逃げ・先行・差し・追込） |
| rival / team | `Art/race-result` / `Art/home-paddock` | 二頭の並走 / 支部の旗 |
| hall | `Art/scout-reveal` | 銘板が並ぶ廊下（§34 の銘板と同じ絵） |
| replays / moments | `Art/first-ride` / `Art/race-result` | フィルムのコマ |
| end | `Art/title-screen` | 夕焼け、ロゴ |

新しい絵が描ければ、`Art/recap-*`（1920×1080、写真風、人物の顔は出さない）で差し替えてよい。

## 5. 共有カード（`ShareCards()` → `List<ShareCard>`、`Shared(card)`）

- 既存の `ShareCard`（REQ-UXS-071、リプレイ共有と同じ経路）。`Kind` は `recap_summary`・`recap_horse`・`recap_moment`・`recap_rank`。`ModeLabel` = 振り返りの題、`PlaceText` = 大きな数字＋単位、`HorseName`、`Lines`（追加したフィールド：数行の文）、`Watermark` = 「ムチ一閃」、`ShareText` は `#ムチ一閃` で終わる。
- 1枚の絵（1080×1350 か 1080×1920）：上にウォーターマーク、中央に大きな数字か馬の名前、下に `Lines`、写真風の絵を背景に。`IClipRecorder.CaptureStillAsync(frame, card, ct)` で静止画にしてよい（フレームはタイトル画面の絵で）。
- シートの上に「順位を隠す」（`TextHideRank`）のトグル。`HideRank` は端末に残る（`muchi.recap.hideRank`）。オンにすると `recap_rank` のカード（昇格だけの名場面のカードも）が消える。
- 注意書き `TextPrivacy`：「共有カードに入るのは、あなたの馬の名前と数字だけです」。**他のプレイヤーの名前・ID・表示名は入らない**（サーバーが持っていない）。
- OS の共有シートに渡したら `Shared(card)`（KPI `recap_share`）。キャンセルは送らない。

## 6. 入口とバッジ

- プロフィール（厩舎の画面の上）に「振り返り」。`HasNew` の時は小さなシアンの点。
- 新しいシーズンの最初の起動で、ホームに1回だけ静かなカード「2026年11月シーズンの振り返りが届きました」を出してよい（閉じられる、押すと `OpenAsync`）。**通知・プッシュはこのラウンドでは無し**。
- アクティビティ（§40、Round 15）が入ったら、振り返りができた時にそこへ1件（サーバー `rollRecaps` の位置、本ラウンドでは書かない）。

## 7. 動きを減らす（§41 のフック）

- `SeasonRecapModel.ReducedMotion`（`Func<bool>`）が true の時：`TransitionMs` = 0（ページはスライドせず切り替える）、`CountUpMs` = 0（数字は数えずに最後の値を出す）、背景の絵の寄り（drift）も止める。
- §41（アクセシビリティ設定、Round 15）が入るまでは OS の設定（iOS「視差効果を減らす」/ Android「アニメーションを削除」）をこの関数につないでおく。§41 が入ったらその設定に置き換える。
- 通常時：ページの切り替え 0.42 秒（左から右へ少しスライド＋フェード）、数字のカウントアップ 0.9 秒（ease-out）。

## 8. 音

- ページ送り：軽い「シュッ」。数字が止まる時に小さな「カン」。最後のページはファンファーレではなく、短い弦の和音で静かに。
- 動きを減らす時も音は鳴らしてよい（音量は全体の設定に従う）。

## 9. 英語

- サーバーの文（ラベル・単位・メモ・名場面・題）は英語の応答で訳されて届く（`?lang=en` / `Accept-Language`）。画面は届いた文をそのまま出す。
- ゲーム層の文（`TextTitle` ほか）は `ui-en.json` にある。GameChecks の L10n チェックで全部の和文に英語があることを確認済み。
- 英語は長い：大きな数字の右の単位（「races」）とメモは、はみ出す時に字を小さくする（見本 `fitText`）。馬の名前は訳さない。

## 10. 確認の手順

```
cd server && npm test -- season-recap
dotnet test engine/Muchi.Engine.Tests --filter SeasonRecap
dotnet run --project "unity/Checks~/GameChecks"          # 「recap:」の行がすべて ok
bash tools/figma-prototype/build.sh && node tools/figma-prototype/test/e2e.cjs   # recap-*.png / en-*-recap-*.png
```

## Round 16 の統合で入ったもの
- 動きを減らす：`SeasonRecapModel.Reduced` は §41 の設定（`GameBackend.Accessibility` の「動きを減らす」）か OS の設定（静的な `ReducedMotion` フック）のどちらかがオンなら true。画面は `TransitionMs`／`CountUpMs` だけを見ればよい。
- アクティビティ：振り返りができると `recap_ready` の行（ラベル「振り返り」、アイコン名 `recap`、リンク先 `ActivityScreens.Recap`、`LinkId` = 振り返りの id）。
- 大きな数字の上のラベルは、数字の行の高さに重ならない位置に置く（プロトタイプで最大の文字サイズの時にぶつかっていた）。

