# Round 18 Codex 向け引き継ぎ：個人データの開示・ダウンロード（REQ-DEX-001〜020）

更新：2026-11-10　基準ブランチ：`feat/r18-data-export`（`origin/claude/round16` から）
仕様：`contracts/protocol.md` §51、`docs/spec/requirements.md` 51章、法務 `docs/planning/03-legal-risk.md`「個人データの開示・ダウンロード」（**弁護士レビュー待ち**）。経済の目標なし（コイン・アイテムは動かない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・OS への受け渡し）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET`／`POST /v1/player/data-export`（`POST` は冪等キー必須・本文なし）、署名つきの `GET /v1/data-export/file`（10分）、運用の `GET /v1/admin/players/:id/data-export`（中身は返さない）。作成はプレイヤーのオブジェクトのアラーム（非同期）。準備できたらアクティビティ `data_export_ready`（`category: "account"`、`link.screen: "privacy"`）。7日に1回、ファイルは7日で削除。KPI `dex_request`・`dex_ready`・`dex_download`（すべてサーバー） |
| C# | ✅ `engine/Muchi.Client/DataExport.cs`：`ApiClient.GetDataExportAsync`・`RequestDataExportAsync`・`DataExportFileUrl`、`DataExportStatus`、`DataExportStatuses`、`DataExportCooldownException`（`AvailableAt`）、エラーコード `DataExportCooldown`・`LinkInvalid`・`LinkExpired`。`ActivityKinds.DataExportReady`・`ActivityScreens.Privacy` |
| ゲーム層 | ✅ `Muchi.Game.DataExportModel`（`unity/Assets/Muchi/Game/DataExportModel.cs`、チェック `unity/Checks~/GameChecks/DataExportChecks.cs`）。英語は `ui-en.json`（サーバーの文は `server-en.json`） |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → その他 → 「プライバシー」 |
| **Codex** | 入口（§2）、プライバシーの画面（§3）、ダウンロードの受け渡し（§4）、アクティビティの行（§5）、文字の大きさ・英語（§6） |

## 2. 入口
- 設定（その他）の「見た目・お世話・仲間」の一覧で、**アクセシビリティのすぐ下**に「プライバシー ›」の行（見本は10行・各36px）。
- アクティビティの `data_export_ready` の行の「見る」→ 同じ画面（`ActivityScreens.Privacy`、`LinkId` = requestId は使わなくてよい：画面は今の状態を読み直す）。

## 3. プライバシーの画面（`DataExportModel.LoadAsync`）
背景 `Art/home-paddock` に暗いシェード、上のバー「その他 / プライバシー」（財布なし）。紺の半透明のパネル2枚（見本：左 940×676、右 568×676）。ムチ一閃のトーン：字間を空けた小さなシアンのラベル、斜めのシアンの CTA（»）、余白多め。

左のパネル「データのダウンロード」：
1. `Notice`（サーバーの文、2〜3行、MUTED）。
2. 細い線、小さなシアンのラベル「状態」、**大きな白い文字で `StatusText`**（「まだリクエストしていません」「準備しています」「ダウンロードできます」「ダウンロードの期限が過ぎました」…）。
3. `DateText`（シアン）：準備できた時「11月18日まで」、回数の制限中は「次のリクエストは11月18日から」。**日付だけ。カウントダウン・残り時間の表示はしない**（法務の決まり、「今だけ」等も使わない）。準備できた時は右に `SizeText`（「48 KB」）。
4. 主ボタン（`ButtonText`／`ButtonEnabled`）：
   - 未リクエスト・失敗・期限切れ（申し込める時）→ 斜めのシアンの CTA「データをリクエスト »」／「もう一度リクエスト »」→ `RequestAsync()`。押した後は `Preparing` になり、ボタンは「準備しています」の無効の表示（半透明、押すと「準備ができるとお知らせに届きます」のトースト）。
   - 準備できた → CTA「データ（JSON）をダウンロード »」と、その右に枠だけのボタン「概要（テキスト）をダウンロード」。
   - 回数の制限中 → 無効の表示（`DateText` で開く日を出す）。
5. 下の注意（順に、短い行）：`Note`（準備中・失敗）、`LinkNote`（「リンクは10分で切れます。リンクを他の人に送らないでください。」）、`DeletionNote`（**金色**、アカウント削除の予定中だけ「削除が終わるまではダウンロードできます」）、最後に「メールアドレスは使いません。ログイン中のあなただけがリクエストできます。」（SOFT）。

右のパネル「含まれるもの」：7行（プロフィール・設定（アクセシビリティ含む）／馬・アイテム・プレゼント／有償コインと無償コインの残高と履歴（別々に記載）／購入とスカウトの記録／フレンド・ブロック・自分が送った通報／お知らせ・リプレイと写真の記録・カップ・振り返り／登録した端末・分析イベント）、細い線、小さなラベル「含めないもの」と「他のプレイヤーの情報・運営のメモ・処理用の内部記録」、「JSON は機械で読める形式、概要は人が読めるテキストです。」。文は見本（`site/app.js` `DEX_INCLUDED`）と `proto-en.json` の英語を使う。

画面を開いている間に準備ができたら（準備中なら10〜15秒ごとに `LoadAsync` を呼び直す、またはアクティビティの更新で）ボタンが切り替わる。

## 4. ダウンロードの受け渡し
- `DownloadUrl("json")`／`DownloadUrl("summary")` が返す絶対 URL を **OS のブラウザで開く**（`Application.OpenURL`）。アプリの中に保存しない・表示しない。リンクは10分で切れるので、押す直前に `LoadAsync()` で新しいリンクを取る（`LinksStale` が true なら必ず）。null なら「ダウンロードの期限が過ぎました」。
- ファイル名はサーバーが付ける（`muchi-issen-data-YYYY-MM-DD.json`／`…-summary.txt`）。

## 5. アクティビティの行
`data_export_ready`：ラベル「データ」（見本の `ACT_LABEL`）、文はサーバー（「データのダウンロードの準備ができました」／“Your data download is ready”）、ボタン「見る」→ §3。プッシュは来ない。

## 6. 文字の大きさ・英語・その他
- 文字の大きさ（§41）の「特大」でも、状態の行・ボタン・注意が重ならない（見本の a11y-flow に `privacy` を追加済み）。注意は折り返す。
- 英語：`StatusText`・`Notice`・注意はサーバーが英語で返す（`Accept-Language`）。モデルの文は `Loc.T`（`ui-en.json`）。プレイヤー名は出さない。
- オフライン：リクエストできない（`TextOffline`）。最後の状態は覚えない（リンクが古くなるため）。
- 操作の音・アニメーションは最小限（設定の画面と同じ）。動きを減らす設定で動きなし。
