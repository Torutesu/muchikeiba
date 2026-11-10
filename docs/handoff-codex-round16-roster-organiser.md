# Round 16 Codex 向け引き継ぎ：厩舎の整理（REQ-ORG-001〜016）

更新：2026-11-09　基準ブランチ：`feat/r16-roster-organiser`（`origin/claude/round14` から）
仕様：`contracts/protocol.md` §44、`docs/spec/requirements.md` 44章。経済の目標なし（まとめて引退は1頭の引退をそのまま繰り返すだけで、コインも素材も返らない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・並びのルール・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/roster`（並び・絞り込み・検索のクエリも可）・`PUT /v1/horses/:horseId/lock`・`PUT /v1/horses/:horseId/favorite`・`POST /v1/roster/bulk/preview`・`POST /v1/roster/bulk`（冪等キー＋`confirmToken`、全部か何もしないか）。**ロックした馬は1頭の引退（`POST /v1/horses/:horseId/retire`）も `409 HORSE_LOCKED`**。大会の登録・取り消しをプレイヤーの部屋に記録（まとめて引退の「大会に登録中」）。KPI `roster_bulk_action`（サーバー）、`roster_sort`（クライアント） |
| C# | ✅ `engine/Muchi.Client/Roster.cs`：`ApiClient.GetRosterAsync` / `SetHorseLockAsync` / `SetHorseFavoriteAsync` / `PreviewBulkAsync` / `RunBulkAsync`、**`RosterSorter`**（サーバーと同じ並び・絞り込み・検索・適性。共通のテストベクタ `contracts/roster-query.vectors.json`）、`RosterQuery`（端末に覚える `Encode`/`Decode`）、`BulkRefusedException`（断った馬と理由）、エラーコード `HorseLocked` / `RosterBulkRefused` / `RosterBulkStale`、`AnalyticsEvent.RosterSort` |
| ゲーム層 | ✅ `Muchi.Game.RosterOrganiserModel`（`unity/Assets/Muchi/Game/RosterOrganiserModel.cs`、チェック `unity/Checks~/GameChecks/RosterChecks.cs`）。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → 厩舎 → 「所属馬の一覧（N頭）」。「デモ：馬を増やす」で本物の馬が増える |
| **Codex** | 一覧（§2）、並びのシート（§3）、絞り込みのシート（§4）、まとめて選ぶ（§5）、確認（§6）、入口（§7） |

## 2. 一覧（`RosterOrganiserModel.LoadAsync` → `Lines`）

背景 `Art/partner-naming`、紺のパネル2枚（見本：左 1080×676 一覧、右 424×676 まとめて引退）。

- 上の段：名前の検索欄（`SetSearch`、最大20文字。ひらがなでもカタカナの名前に当たる）・「並び：能力（高い順）」（`SortText`、§3 を開く）・「絞り込み（n）」（`Query.FilterCount`、§4 を開く）・「まとめて選ぶ」（§5）。
- 件数 `CountText`（`42頭（現役30・引退12）`、字間を空けたシアンの小見出し）。
- 行 `Lines`（1画面7行・ページ送り）：
  - レア度（SSR 金・SR シアン・R 灰）、**馬の名前 `Name`：プレイヤーが付けた名前。翻訳しない・ローマ字にしない・Loc.T に通さない**。
  - `Meta`（`差し / 芝 1,600–2,400m`）、`RatingText`（`能力 2,880`、金）、`RecordText`（`34戦11勝`）。
  - 適性のコースを選んでいる時だけ `AptitudeMark`（◎ ○ △ ×、シアンの大きめの記号）。
  - タグ：相棒（シアン）、引退（灰）。
  - 右端に ☆／★（`ToggleFavoriteAsync`）と「ロック」ボタン（`ToggleLockAsync`、ロック中は枠が光る「ロック中」）。ロックの意味は右パネルに一文で書く（「ロックした馬は、1頭ずつの引退でもまとめての引退でも断られます」）。
- 空：`RosterOrganiserModel.TextEmpty`。
- 並び・絞り込みは**端末の中で**並べ替える（`RosterSorter`）。画面を開き直しても同じ並び（`muchi.roster.view` に保存済み）。オフラインでも最後に読んだ一覧を並べ替えられる。

## 3. 並びのシート（右から出るシート）

- キー：能力・年齢・入手順・出走数・レア度・名前（`SortLabels`）。同じキーをもう一度押すと高い順／低い順が入れ替わる（`SetSort`）。選んでいるキーは枠を光らせる。
- 「適性　/　コースを選ぶ」：コースのボタン（tracks.json の名前）。選ぶと `SetSort("aptitude", new RosterCourse { Surface, DistanceM, Going, TrackId })`。馬場（良・稍重・重…）は任意。
- 「お気に入りを先頭に：オン／オフ」（`Query.FavoritesFirst`、既定オン）。

## 4. 絞り込みのシート

段ごとにチップ（押すとオン、もう一度でオフ）：芝・ダート（両方走れる馬はどちらにも入る）／距離（短距離・マイル・中距離・長距離）／脚質／状態（現役・引退）／スキル（あり・なし）／ロック／お気に入り（★のみ）／相棒（相棒のみ）。下に「すべて解除」（`ClearFilters`）。`SetFilters(q => q.Surface = "dirt")` の形で渡す（知らない値は無視される）。

## 5. まとめて選ぶ

- 「まとめて選ぶ」で各行の左にチェック ☐／☑ が出る（`EnterSelectMode`／`ToggleSelect`）。
- **選べない馬**（`Selectable == false`）はチェックを薄く、タグに理由 `BlockText`（警告色）：ロック中・最初の相棒はまとめて引退できません・もう引退しています・種牡馬として貸し出し中・調教中・大会に登録中・引退式をまだ見ていません。タップしても選ばれない（理由を短く出す）。
- 右パネル：`SelectedText`（`2頭を選択中`、大きく白）、「表示中を全部選ぶ」（`SelectAllShown`、最大50頭）、主ボタン「確認へ »」（0頭の時は無効）→ `PreviewAsync()`。

## 6. 確認（`Sheet`、2段階目）

中央のダイアログ（見本 1040×720）。**元に戻せないので、ここだけは決まりが多い**：
- 見出し `Sheet.Title`（`2頭をまとめて引退させますか？`）。
- **選んだ馬を全部**並べる（`Sheet.Lines`：レア度・名前（入力どおり）・可否。断られる馬は理由 `ReasonText` を警告色で）。多い時はページ送り（2列×5行）で、省略しない。
- 金の一行 `Sheet.RefundText`（「返ってくるもの：なし（コイン・素材は返ってきません）」）、警告色の一行 `Sheet.Warning`（「引退は元に戻せません。…」）。
- ボタン：**「やめる」と「まとめて引退させる」は同じ大きさ・同じ形**で横に並べる（`ButtonsSameSize == true`、`HasDefaultButton == false`：どちらにもフォーカス・光・既定の選択を付けない。主ボタンのシアンの平行四辺形はここでは使わない）。断られる馬がいる時（`CanConfirm == false`）は実行を無効にし、「引退できない馬を外す」（`RemoveRefusedAsync`）を出す。
- 実行 `ConfirmAsync()`：成功 → 「2頭を引退させました」のトースト、一覧を読み直す。`Ceremonies` に引退式があれば §34 の引退式の画面を1頭ずつ（`HallModel` と同じ見せ方、見終わったら ack）。
  - `ROSTER_BULK_REFUSED`（全部か何もしないか。1頭も引退していない）→ シートを理由つきで出し直す。
  - `ROSTER_BULK_STALE`（確認の後に厩舎が変わった）→ `TextStale` を出し、もう一度「確認へ」から。
- 冪等キーは確認1回につき1つ（モデルが持つ）。通信が切れて押し直しても2回引退しない。
- **undo は無い**。演出（馬が厩舎を出ていくなど）は付けてよいが、取り消しボタンは置かない。

## 7. 入口・つながり

- 厩舎の画面の「所属馬の一覧（N頭）」からこの画面へ（見本と同じ）。
- 所属馬の上限は今のゲームに無い（「厩舎がいっぱい」の流れも無い）。上限ができたら、その案内からこの画面（状態「現役」・並び「能力」の低い順）へ。
- §40 の活動の一覧（Round 15）ができたら、まとめて引退した時の1行はそちらに出す（Claude 側でサーバーが書く。この画面では何もしない）。

## 8. 英語

モデルの文字列はすべて `ui-en.json` にある（`Loc.T(model.X)` で表示）。馬の名前だけは訳さない（`.keep-ja` 相当：Loc.T に通さない）。見本の英語の流れ（`test/en-flow.cjs`）で、一覧・並び・絞り込み・選択・確認に日本語が残らず、はみ出しも無いことを確認している。

## 9. 描くものの一覧

| 画面 | 部品 |
|---|---|
| 一覧 | 検索欄、並び・絞り込み・まとめて選ぶの副ボタン、件数の小見出し、行（レア度・名前・脚質/馬場/距離・能力・戦績・適性の印・タグ・☆/★・ロック）、ページ送り、右パネル（選択数・全部選ぶ・確認へ・注意書き2行・ロック数/お気に入り数） |
| 並びのシート | キーのチップ6つ（オンの枠）、コースのボタン、お気に入りを先頭に |
| 絞り込みのシート | 8段のチップ、すべて解除 |
| 選択中 | 各行のチェック（選べない馬は薄く＋理由のタグ） |
| 確認 | 見出し、馬の一覧（2列×5行・ページ送り）、返ってくるもの（金）、元に戻せません（警告色）、同じ大きさの2つのボタン、引退できない馬を外す |
