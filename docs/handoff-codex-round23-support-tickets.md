# Round 23 Codex 向け引き継ぎ：お問い合わせの状況確認（support tickets & replies、REQ-TKT-001〜020）

更新：2026-11-12　基準ブランチ：`feat/r23-support-tickets`（`origin/main` から）
仕様：`contracts/protocol.md` §73、`docs/spec/requirements.md` 73章。経済の目標（E）は無し（**何も配らない**：お詫びの品は既存の補填 §22 → プレゼントボックス §26 で配られ、チケットにはその id が結ばれるだけ）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音・絵）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ §48 の問い合わせを拡張：状態5つ（受付済み・確認中・返信あり・解決・クローズ）、プレイヤーの返信 `POST /v1/help/inquiries/:id/messages`（キー必須・間隔・1日の数）、自動クローズ・再開・保存期間、診断情報は同意したときだけ、本文の秘密の置き換え、プッシュ `inquiry_reply`（カテゴリ `gifts`）。運営：一覧の絞り込み・待ち時間（SLA）・CSV（本文なし）・担当・内部メモ・状態・ひな形・補填を結ぶ |
| C# | ✅ `engine/Muchi.Client/Help.cs`：`ApiClient.SendInquiryMessageAsync(ticketId, content, key)`、`InquiryStatuses`（5つ・`TextOf`・`IsOpen`）、`Inquiry.CanReply`／`ReplyUntil`／`AutoCloseAt`／`ShareDiagnostics`／`Compensation`、`InquiryDraft.ShareDiagnostics`、`InquiryLimits.RepliesPerDay`／`RepliesToday` |
| ゲーム層 | ✅ `Muchi.Game.HelpCenterModel`（スレッド・返信）。返信は別のインターフェース `IInquiryThreadApi`（`ApiHelp` が実装。既存の `IHelpApi` の実装はそのまま動く）。チェックは `unity/Checks~/GameChecks/HelpCenterChecks.cs` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：その他 › 設定・サポート › ヘルプ・お問い合わせ › **お問い合わせ履歴**。デモは `__muchi.demo('help')`（返信あり・確認中・解決＋お詫びの品の3件） |
| **Codex** | 入口（§2）、一覧（§3）、スレッド（§4）、返信の欄（§5）、フォームの同意（§6）、状態・英語・文字の大きさ（§7） |

## 2. 入口
- **その他には行を足さない**（2ページとも8行で満杯）。入口は今までの「ヘルプ・お問い合わせ」の画面の右の欄のボタン「お問い合わせ履歴」（旧「自分の問い合わせ」。`HelpCenterModel.MyInquiriesTitle`）。
- **未読のバッジ**は今までどおり設定の「ヘルプ・お問い合わせ」の行（`HelpCenterModel.BadgeText`、`player.help.unreadReplies`）と、ヘルプの画面の「お問い合わせ履歴」の右の「未読 n」。
- アクティビティの `inquiry_answered`（リンク `help_inquiry`、`id` = ticketId）とプッシュ `inquiry_reply`（`data.ticketId`）は、そのチケットのスレッドを開く（`OpenInquiryAsync(ticketId)`）。
- 通報（§47）はチケットではない。通報の受付の画面から問い合わせへは案内しない。

## 3. 一覧（「ムチ一閃」のトーン）
見本と同じ1600×900の構図。**背景はパドックの写真（`Art/home-paddock`）、左を暗くする影、紺の半透明パネル2枚、字間の広い小さなシアンのキッカー**。
- 上の帯：題「お問い合わせ履歴」、小さな説明「受付済み → 確認中 → 返信あり → 解決 → クローズ　·　返信はアクティビティでもお知らせします」。
- 左パネル（560×676）：キッカー「新しい順」、行（最大7、`Inquiries.Items`）。行は紺の半透明の帯：左上に**状態のチップ**、右上に受付の日時（日本時間）、2行目に種類の名前。未読の返信がある行は左にシアンの点。選んでいる行はシアンの内枠。
- **状態のチップ**（`HelpCenterModel.StatusChip(t)` → 文字と色の種類）：`warn`＝金の枠（受付済み）、`info`＝シアンの枠（確認中）、`ok`＝シアンの塗りに紺の字（返信あり）、`muted`＝灰の字（解決・クローズ）。12px・太字・字間 .14em・角3px。**点滅させない**。

## 4. スレッド（右パネル 948×676）
- 上：キッカー「種類の名前 · q_3」、右上に状態のチップ。
- 中：**パネルの中でスクロールするやりとり**（`HelpCenterModel.Thread()`：最初は自分の本文、その後は時刻の順）。1件ずつ紺の半透明の帯：上に「あなた」／「運営からの返信」（運営はシアン、左に3pxのシアンの線）と日時、下に本文（16px・行間1.6）。**本文は人が書いた文：英語でも訳さない・ローマ字にしない**。文字を大きくしても縮めず、帯が伸びてスクロールが長くなる。開いたら一番下（新しい発言）まで送る。
- やりとりの後に、あるときだけ：
  - 添えた記録の番号（`P-`・`C-`・`G-`、薄いシアンの数字）。
  - お詫びの品（`HasCompensation`）：金の細い枠の帯「お詫びの品をプレゼントボックスに入れました ›」→ プレゼントボックスを開く（**受け取りはプレゼントボックスで**。ここで受け取らせない、数や中身を書かない）。
  - `AutoCloseNote`（返信あり・解決のとき「返信がないまま 11/19 12:00 を過ぎると自動でクローズします」）・`ReopenNote`（クローズの後の再開の期限）・返信できないとき `ReplyClosedText`。灰色の小さな文。**カウントダウン・残り時間・赤い強調にしない**（データの時刻だけ）。
- まだ運営の返信が無いとき：「運営が確認しています。返信が届くとアクティビティでお知らせします。」

## 5. 返信の欄
- `CanReply` のときだけ、スレッドの下に入力欄（876×118、`ReplyPlaceholder`、`ReplyCounter`）と、右下に**斜めのシアンの » ボタン「返信する」**（`SendReplyAsync`、画面に1つの主ボタン）。左下に枠だけのボタン「新しく問い合わせる」。
- 送信中はボタンを押せなくする（`Replying`）。成功で欄を空にし `ReplySentText`。オフライン・時間切れは文を残す（同じキーで再送されるので、押し直しても2件にならない）。間隔・1日の数は `ReplyLimitText`、期限を過ぎたクローズは `ReplyClosedText` を出して欄を閉じる。
- `CanReply` でないとき：欄を出さず、主ボタンは「新しく問い合わせる」。

## 6. フォームの同意（REQ-TKT-003）
- 右の「自動で添える情報」の上に「診断情報を添える」とオン／オフの2つのボタン（既定オン、`SetShareDiagnostics`）。オフにすると表の値が「送りません」になる（`DiagnosticsRows()`）。プレイヤーIDはアカウントの問い合わせなので常に「自動で添えます」。
- 本文の下の注意（パスワード・メールアドレスを書かない）はそのまま。サーバーはそれらしい部分を「［削除しました］」に置き換える。

## 7. 状態・英語・文字の大きさ
- 英語：画面の文字は `ui-en.json`（「お問い合わせ履歴」→ "Your inquiries"、チップ "Received / Checking / Replied / Resolved / Closed"）。サーバーの `statusText`・`categoryTitle` は要求の言語で届く。**本文と返信は訳さない**。
- 文字「特大」：一覧の行・チップ・スレッドの文は大きくなり、スレッドはスクロールで受ける（はみ出さない・縮めない）。見本の a11y-flow でスクリーンショット `ticket-thread` を確かめている。
- アカウントが変わった（`SESSION_REPLACED`・引き継ぎ）ときは画面を閉じ、`HelpCenterModel` を作り直す（返信の下書きは端末に保存しない＝新しいアカウントに持ち越さない）。

## 8. 絵
- 新しい絵は要らない（パドックの写真・既存のパネル・チップは CSS／UI の部品）。プレゼントボックスへの帯は既存の金の線の色（`--gold`）。
