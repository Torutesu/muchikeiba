# Round 17 Codex 向け引き継ぎ：おすすめフレンド（フレンド画面の一区画、REQ-FSUG-001〜016）

更新：2026-11-10　基準ブランチ：`feat/r17-friend-suggestions`（`claude/round15` の上）
仕様：`contracts/protocol.md` §49、`docs/spec/requirements.md` 49章、法務の決まり `docs/planning/03-legal-risk.md`「おすすめフレンド」。経済の目標（E）は無し（何も配らない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/friends/suggestions`（最大10人、理由の行つき）、`POST /v1/friends/suggestions/:playerId/request`（今のフレンド申請をそのまま通る）、`POST …/:playerId/dismiss`、`PUT /v1/friends/suggestions/settings`（「おすすめに表示しない」） |
| C# | ✅ `ApiClient.GetFriendSuggestionsAsync` / `RequestSuggestedFriendAsync` / `DismissSuggestionAsync` / `SetSuggestionsHiddenAsync`、`FriendSuggestions` / `FriendSuggestion` / `FriendSuggestionKinds`、`AnalyticsEvent.FsugView`（`engine/Muchi.Client/FriendSuggestions.cs`） |
| ゲーム層 | ✅ `Muchi.Game.FriendSuggestionsModel`（`unity/Assets/Muchi/Game/FriendSuggestionsModel.cs`、チェックは `unity/Checks~/GameChecks/FriendSuggestionsChecks.cs`）。`new FriendSuggestionsModel(new ApiFriendSuggestions(backend.Api), () => backend.Online, analytics.Track)` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：メニュー（機能・イベント）→「フレンド」。デモは `index.html?demo=friends`（イベント・フレンド部屋の相手、いいね、応援、共通のフレンド。表示しない設定の人とランク戦だけの相手は出ない） |
| **Codex** | フレンド画面の区画（§2）、カード（§3）、操作（§4）、プロフィールの設定（§5）、空・読み込み中・オフライン・英語・文字の大きさ（§6） |

## 2. フレンド画面の「おすすめフレンド」区画（「ムチ一閃」のトーン）

見本と同じ 1600×900 の構図。**背景は `Art/home-paddock` を全面に、左を暗くする影、紺の半透明パネル2枚、主ボタン（斜めのシアン »）は1つ（「ホームへ」）**。
- 上の帯（`TopBar`）：題「フレンド」、小さな説明「ゲームの中で出会った人を、おすすめに表示します」、右に財布と EN。
- **左パネル**：キッカー「おすすめフレンド」（小さく字間を空けたシアン）。カード（§3）を縦に最大6枚、それ以上は「ほか◯人」（または縦スクロール）。
- **右パネル**：キッカー「フレンド」と大きな人数、フレンドの名前を3人まで、申請中があれば「申請中 ◯人」（シアン）、文字リンク「フレンドコード・友達招待」（友達招待の画面へ）、細い線、キッカー「おすすめのきまり」と説明（見本の文）、「おすすめに表示しない」の切り替え（§5）、一番下に主ボタン「ホームへ »」。
- `Visible == false`（サーバーで機能が切られている）なら区画ごと出さない（右パネルの切り替えも出さない）。
- 画面に区画が見えたら `Shown()` を1回呼ぶ（`fsug_view` は1回の訪問で1回だけ、モデルが数える）。画面を開くたびに `OpenAsync()`（引っ張って更新は `OpenAsync(newVisit: false)`）。

## 3. カード（`SuggestionLine`）

1枚の高さ 80 前後。左から：
1. 上の段：理由の種類の小さなラベル（`Source.Reasons[0].Kind` → 対戦／支部／いいね／応援／共通のフレンド、シアン・字間あり）。アイコン `Icon`（opponent / team / like / cheer / mutual）のシアンの線のアイコンを左に置いてよい。
2. 中の段：名前 `Name`（白・太字・1行・**訳さない**、長ければ「…」）と小さく「クラス B」（`ClassId`）。勝負服 `Source.Silks` があれば小さな丸いバッジで出してよい（任意）。
3. 下の段：理由の行 `Reason`（「同じ支部・共通のフレンド3人」。サーバーの文。英語では「Same branch, 3 mutual friends」。灰・1行・長ければ「…」）。
4. 右端：ゴーストボタン2つ「申請する」（`RequestAsync`）と、控えめな「表示しない」（`DismissAsync`）。同じ大きさ・同じ強さに近く（「表示しない」を小さくしすぎない）。
- **出さないもの**：レーティング・戦績・支部名・共通のフレンドの名前（サーバーも返さない）。「今だけ」「おすすめ度◯%」のような数字や急かす言葉。

## 4. 操作

- 「申請する」：押したカードはすぐ消える（モデルが消す）。成功で `Toast`（「フレンド申請を送りました」／相手が先に申請していた時は「フレンドになりました」）を短く出す。失敗（通信など）ならカードが元の位置に戻り、`Toast` にエラーの文。**404（もうおすすめに出ない人）は理由を言わずに消えたまま**。上限（`FRIEND_LIMIT`）は `UxText` の文。
- 「表示しない」：押したカードはすぐ消える。確認のダイアログは出さない（サーバーが覚える。取り消しの UI は無し）。
- 送っている間は同じカードを2回送らない（モデルが止める）。ボタンは押した瞬間に消えるので、二度押しの見た目の対策は不要。
- 申請は今のフレンド申請と同じ道なので、相手にはアクティビティ（「◯◯さんからフレンド申請が届きました」）とプッシュが届く。こちらの申請中の一覧（`GET /v1/friends` の `outgoing`）にも出る。

## 5. プロフィールの設定「おすすめに表示しない」

- フレンド画面の右パネル（見本）と、プロフィール／設定の画面の両方に同じ切り替えを置いてよい。ラベル `HiddenLabel`、説明 `HiddenNote`（「オンにすると、ほかのプレイヤーのおすすめにあなたが出なくなります」）。
- `SetHiddenAsync(bool)`：押した瞬間に見た目を切り替え、保存できなければ元に戻る（戻り値 false、`Toast` にエラー）。既定はオフ。

## 6. 空・読み込み中・オフライン・英語・文字の大きさ

- 空：`Message == EmptyText`（「いまはおすすめできる人がいません」）を左パネルの上に。
- 読み込み中（`Loading`）：カードの形の薄い枠を3つ（点滅させない。`reduceMotion` では静止）。
- オフライン：`Message == OfflineText`（「おすすめフレンドはオンラインで表示できます」）。カード・切り替えは出さない。
- 英語：画面の文は `Loc.T`（`ui-en.json` に入れた）。理由の行はサーバーが英語で返す。名前は訳さない。
- 文字の大きさ（§41）：本文（28px 未満）に倍率をかけ、はみ出す文字だけ戻す。名前と理由の行は1行のまま「…」で切る。プロトタイプの `a11y-flow` が「特大」の日本語・英語でこの画面を調べている。

## 7. 見本との対応

| 見本（`site/app.js` `Friends()`） | Unity |
|---|---|
| `L.friendSuggestions()` | `FriendSuggestionsModel.OpenAsync()` → `Lines`・`Visible`・`Hidden`・`Message` |
| `.fsug-row`（`data-fsug-id`、`data-reason`） | `SuggestionLine`（`PlayerId`、`Source.Reasons[0].Kind`） |
| 「申請する」／「表示しない」 | `RequestAsync(line)`／`DismissAsync(line)`、`Toast` |
| 「おすすめに表示しない：オン／オフ」 | `SetHiddenAsync(bool)`、`Hidden` |
| `__muchiKpi` の `fsug_view` | `Shown()`（`AnalyticsEvent.FsugView`） |
