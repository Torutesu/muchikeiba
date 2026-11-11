# Round 17 Codex 向け引き継ぎ：ヘルプセンター（よくある質問・問い合わせ、REQ-HELP-001〜024）

更新：2026-11-10　基準ブランチ：`feat/r17-help-center`（`origin/claude/round15` から）
仕様：`contracts/protocol.md` §48、`docs/spec/requirements.md` 48章。経済の目標（E）は無し（表示と問い合わせだけで、コイン・アイテムは動かない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/help`（目次）・`GET /v1/help/articles/:id`（本文。数字はデータから）・`GET /v1/help/search`（日本語の正規化つき）・`POST /v1/help/articles/:id/feedback`・`GET/POST /v1/help/inquiries`・`GET /v1/help/inquiries/:id`・`POST /v1/help/inquiries/:id/read`、`GET /v1/player` の `help.unreadReplies`、アクティビティの `inquiry_answered`。記事は `server/master/help.json`（日本語と英語） |
| C# | ✅ `engine/Muchi.Client/Help.cs`：`ApiClient.GetHelpAsync` / `GetHelpArticleAsync` / `SearchHelpAsync` / `SendHelpFeedbackAsync` / `GetInquiriesAsync` / `GetInquiryAsync` / `SubmitInquiryAsync` / `MarkInquiryReadAsync`、`HelpText.Fold`（サーバーと同じ正規化、`contracts/help-fold.vectors.json` で一致を確認）、`PlayerView.Help`、`AnalyticsEvent.HelpSearch` / `HelpArticleView`、定数 `HelpCategories` / `HelpContexts` / `InquiryCategories` / `InquiryStatuses` |
| ゲーム層 | ✅ `Muchi.Game.HelpCenterModel`（`unity/Assets/Muchi/Game/HelpCenterModel.cs`、チェックは `unity/Checks~/GameChecks/HelpCenterChecks.cs`）。`new HelpCenterModel(new ApiHelp(backend.Api), Application.version, platform, () => backend.Online, analytics.Track)`、設定画面では `SetBadge(player.Help)` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：その他（設定）→「ヘルプ・お問い合わせ」。提供割合の画面の「天井のしくみ（ヘルプ）」、コイン不足の案内の「コインの購入について（ヘルプ）」。デモ状態は `__muchi.demo('help')`（返信のある問い合わせと返信待ちの問い合わせ） |
| 運営 | ✅ ops コンソール「問い合わせ」（一覧・詳細・返信） |
| **Codex** | 入口（§2）、ヘルプのトップ（§3）、カテゴリ・検索結果（§4）、記事（§5）、問い合わせのフォーム（§6）、自分の問い合わせ（§7）、状態・英語・文字の大きさ（§8） |

## 2. 入口
- **設定（その他）の一覧の一番上**に行「ヘルプ・お問い合わせ」。未読の返信があれば右に「未読 n」（`HelpCenterModel.BadgeText` は 1〜9、「9+」）。
- **画面ごとの「？」**（`HelpContexts`）：提供割合の画面（`gacha_odds` → 天井の記事）、コイン不足の案内（`coin_shortfall` → コインの購入）、購入確認（`purchase`）、レース中のムチの説明・結果（`race_whip`・`race_result`）、調教・配合・履歴・プレゼントボックス・引き継ぎ・削除・アクセシビリティ。押したら `OpenContextAsync(context)` で記事の画面を開き、戻るで元の画面へ。見た目は小さな文字リンク（下線なしのシアン、「…（ヘルプ）」）か、右上の丸い「？」アイコン。**主ボタンにしない**。
- アクティビティの `inquiry_answered`（リンク `help_inquiry`、`LinkId` = 問い合わせ id）→ 自分の問い合わせのその行を開く。

## 3. ヘルプのトップ（「ムチ一閃」のトーン）
見本と同じ1600×900の構図。**背景 `Art/home-paddock`、左を暗くする影、紺の半透明パネル2枚、主ボタン（斜めのシアン »）は1つ（「問い合わせる」）**。
- 上の帯：題「ヘルプ・お問い合わせ」、小さな説明「よくある質問　·　キーワード検索　·　運営への問い合わせ」。
- 左パネル：キッカー「キーワードで探す」、入力欄（プレースホルダ「ひらがな・カタカナ・半角どれでも」）と「検索」。入力中は `TitleMatches(q)` でタイトルの候補をすぐ出してよい（同じ正規化）。決定で `SearchAsync(q)`。下にキッカー「カテゴリ」と8枚のカード（2列×4、`Index.Categories` の `Title` と「n件」、アイコンは `CategoryIcons`）。
- 右パネル：キッカー「問い合わせ」、説明2行、行「自分の問い合わせ」（未読バッジ）、自動で添える情報の1行、文字リンク「公式サポートサイト」（`Index.SupportSite`、外部ブラウザ）、主ボタン「問い合わせる »」。
- オフライン：`OpenAsync()` が false → `Message`（「ヘルプはオンラインで見られます」）だけを中央に。

## 4. カテゴリ・検索結果
- 行：タイトル（太字1行）、検索結果は下に `Snippet`（1行、はみ出しは…）、右に「›」。押すと `OpenArticleAsync(id, "list" | "search")`。
- 検索結果のキッカー「検索結果　n件」と、打った言葉（**訳さない**）。0件は `NoResults`（「見つかりませんでした。言葉を変えるか、問い合わせてください」）と「問い合わせる」。
- 右パネルは問い合わせへの導線（トップと同じ）。

## 5. 記事
- 左パネル：キッカー＝カテゴリ名、大きなタイトル、本文（`Body`、空行で段落、`・`／`•` で始まる行は箇条書き。`Paragraphs()` を使える）。**本文の数字（提供割合・天井・価格・上限・日数）はサーバーがデータから入れたもの。画面で数字を書き足さない・書き換えない**。
- 下に細い線と「この記事は役に立ちましたか？」、ボタン2つ「役に立った」「役に立たなかった」（同じ大きさのゴースト。押した方を選択状態に。`VoteAsync(bool)`、その後「ご意見ありがとうございます」のトースト）。
- 右パネル：キッカー「関連する画面・ページ」と `Links`（`Label` の文字リンク）：`screen` はアプリの画面へ（`ScreenId`、§48.1 の一覧）、`legal` は既存の法定表示の画面（`tokushoho` 特定商取引法に基づく表記・`shikin` 資金決済法に基づく表示・`terms`・`privacy`。英語でも法定表示の本文は日本語＋英語の参考訳のまま）、`article` は別の記事（source=`link`）、`url` は公式サポートサイト（外部ブラウザ）。続いて「関連する記事」（source=`related`）。一番下に主ボタン「問い合わせる »」（購入の記事からは種類「購入したのに届かない」、スカウトの記事からは「スカウトの結果について」を選んだ状態で開く）。

## 6. 問い合わせのフォーム
- 左パネル：キッカー「種類」と10個の選択ボタン（3列、`Index.InquiryCategories`）、キッカー「内容」と複数行の入力欄（`SetDescription`、下に `Counter`「12 / 1000」）、その下に `Index.PrivacyNote`（メール・電話・パスワード・カード番号を書かない旨。小さな文字）。
- 「添える記録（任意）」：§33 の購入・コイン・ガチャの履歴から行を選ぶ（`ToggleRef(ref)`、最大 `AttachMax`）。種類が購入・返金・コイン・スカウトのとき（`OffersHistory`）は見出しを「（任意・おすすめ）」にして、直近の記録を最初から見せる。履歴画面の問い合わせ番号（P- / C- / G-）と同じ表記。
- 右パネル：キッカー「自動で添える情報」と `DiagnosticsRows()`（アプリの版／端末の種類／プレイヤーID／直近のレースID の4行）、その下に `Index.DiagnosticsNote`（名前・メール・機種名・位置は送らない旨）。**この説明は省略しない**。返信待ちと今日の件数（`Inquiries.Limits`）。主ボタン「送信する »」。
- 送信：`SubmitAsync()`。`Problem()` が null でないときはボタンを押せない見た目にして理由を出す（短すぎる・長すぎる・上限）。送信中は `Sending` でボタンを無効に。**タイムアウト後の再送は同じキーのまま**（モデルが持っている。画面でキーを作り直さない）。オフラインでは送らず下書きを残す（`OfflineDraftText`）。成功したら「問い合わせを受け付けました…」のトーストと自分の問い合わせへ。

## 7. 自分の問い合わせ
- 左パネル（狭め）：新しい順の行。上に状態（受付済み＝金、回答済み＝シアン、完了＝薄い色。文字は `StatusText`）と日時、下に種類。未読の返信がある行にシアンの点。
- 右パネル：選んだ問い合わせ。キッカー「種類　·　id」、右に状態、「送った内容」（`InquiryText`）、添えた記録の番号、細い線、やりとり（「運営からの返信」と日時、`MessageText`）。**送った内容と返信は人の書いた文なので訳さない**（英語表示でもそのまま）。返信待ちは「運営が確認しています。返信が届くとアクティビティでお知らせします。」。主ボタン「新しく問い合わせる »」。
- 開いたら `OpenInquiryAsync(id)`（未読なら既読にしてバッジを更新）。

## 8. 状態・英語・文字の大きさ・音
- 読み込み中は `Loading`／`Sending`。エラーは `Message`（`UxText`）。
- 英語：記事・カテゴリ・状態・注意書きはサーバーが英語で返す（`ApiClient.Locale`）。画面の固定の文は `Loc.T`（`ui-en.json` に追加済み）。打った言葉・送った内容・返信だけ日本語のまま。
- 文字の大きさ（§41、`AccessibilityModel.TextScale`）を本文・行・フォームに当てる。最大の大きさでも本文はスクロールで全部読める・ボタンははみ出さない（見本の a11y の通しで確認済み）。動きを減らす設定ではパネルのスライドをやめる。
- 音：送信成功で控えめな確認音だけ。「今だけ」「お得」などの言葉・点滅・急かす演出は使わない。

## 9. 確認のしかた
- `dotnet run --project 'unity/Checks~/GameChecks'`（`HelpCenterChecks`）、`dotnet test engine/Muchi.Engine.Tests --filter ApiClientHelpTests`、`cd server && npx vitest run test/help.test.ts`。
- 見本：`bash tools/figma-prototype/build.sh && node tools/figma-prototype/test/e2e.cjs`（u-*-help-*.png、en-*-help-*.png、a11y-*-help-*.png）。
