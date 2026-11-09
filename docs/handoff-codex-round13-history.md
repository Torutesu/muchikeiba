# Round 13 Codex 向け引き継ぎ：購入履歴・コイン履歴・ガチャ履歴の画面（REQ-HIST-001〜014）

更新：2026-11-09　基準ブランチ：`feat/r13-history`（`main` = Round 11 統合後）
仕様：`contracts/protocol.md` §33、`docs/spec/requirements.md` 33章。経済の目標（E）は無し（表示だけでコインは動かない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/history/summary`・`/v1/history/purchases`・`/v1/history/coins?currency=paid\|free`・`/v1/history/gacha`（カーソル式）、`POST /v1/history/support-ticket`（問い合わせの下書き、状態は変えない）、ガチャ記録 `gachaLog`（90日）、運用コンソール `GET /v1/admin/players/:playerId/history`（読み取り・監査ログ） |
| C# | ✅ `ApiClient.GetHistorySummaryAsync` / `GetPurchaseHistoryAsync` / `GetCoinHistoryAsync` / `GetGachaHistoryAsync` / `CreateSupportTicketAsync`、`AnalyticsEvent.HistoryView`（`engine/Muchi.Client/History.cs`） |
| ゲーム層 | ✅ `Muchi.Game.HistoryModel`（`unity/Assets/Muchi/Game/HistoryModel.cs`、チェックは `unity/Checks~/GameChecks/HistoryChecks.cs`）。`new HistoryModel(new ApiHistory(backend.Api), () => backend.Online, analytics.Track)` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → その他（設定）→「購入・コイン・ガチャ履歴」。デモは `index.html?demo=history`（14歳・月の上限 ¥5,000、2パック購入・1つ返金・スカウト） |
| **Codex** | 設定からの入口（§2）、履歴の画面（§3）、行の詳細（§4）、問い合わせシート（§5）、空・読み込み中・オフライン（§6） |

## 2. 入口

設定（その他）の左パネル「アカウント削除」の下に、細い線で区切って1行：**「購入・コイン・ガチャ履歴 ›」**（行の部品は設定の他の行と同じ）。タップで `HistoryModel.OpenAsync(HistoryTab.Purchases)`。ショップの「資金決済法に基づく表示」の近くから同じ画面へのリンクを足してもよい（任意）。

## 3. 履歴の画面（「ムチ一閃」のトーン）

見本と同じ1600×900の構図。**背景は `Art/home-paddock` を全面に、左を暗くする影（`Shade('left')` 相当）、紺の半透明パネル2枚、主ボタン（斜めのシアン »）は1つ（「問い合わせ」）**。

- 上の帯（他の一覧画面と同じ `TopBar`）：題「購入・コイン・ガチャ履歴」、小さな説明「有償と無償は分けて記録しています　·　問い合わせ番号で運営に確認できます」、右に財布と EN。
- **左パネル（一覧）**：
  - タブ4つ（`HistoryModel.TabNames`：購入履歴／有償コイン／無償コイン／ガチャ履歴）。選択中はシアンの枠（設定の「日本語／English」と同じ choice 部品）。右端に小さく「直近◯日」（`HistoryPage.WindowDays`）。
  - 行（`Lines`、新しい順、1行の高さ64前後）：左にチェック枠（問い合わせに添える行を選ぶ、`ToggleSelect(line.Ref)`。10件まで）、日時 `When`（小さく・灰）、題 `Title`（白・太字）、右寄せの小さな補足 `Sub`、いちばん右に金の数字 `Amount`。
    - `Negative`（使用）は警告色（見本は `--warn`）、`Muted`（返金済み・テスト購入・枚数が動かない記録）は文字を暗く。**有償と無償の数字を1つの合計にまとめた表示はしない**。
    - タップした行がシアンの枠になり、右パネルに詳細（§4）。
  - 下に「前へ」「次へ」（見本）または無限スクロールで `MoreAsync()`（`HasMore` の間だけ。`Loading` 中は何もしない）。購入タブだけ `Note`（ストアで保留中の購入は支払い後に表示）を小さく出す。
- **右パネル（残高と詳細）**：
  - キッカー「残高」、**有償コイン・無償コインを2列で並べた金の大きな数字**（`Summary.Paid` / `Summary.Free`）。未精算があれば警告色で「未精算の返金 ◯枚」（`Summary.Debt`）。
  - 年齢の上限がある時だけ（`Summary.AgeLimited`）：`LimitText`（今月の購入 ¥◯ ／ 上限 ¥◯）と金のゲージ（`LimitProgress`）。上限の無い人には何も出さない。
  - `Summary.Notice`（有償コインは無期限・有償から先に使う・無償の説明）を小さく。
  - 細い線の下に選んだ行の詳細（§4）。
  - 一番下に主ボタン「問い合わせ »」（選んだ行が無ければ、いま詳細を出している行を自動で1件選ぶ）。

## 4. 行の詳細

`ShowDetail(ref)` → `DetailLines()`：日時、**「問い合わせ番号 P-1A2B3C4D」**（コピーできると親切：長押しでコピー）、購入はストア・状態・付与されたコイン（有償／無償を書き分ける）、コインは通貨と枚数、ガチャは結果の一覧（レア度＋馬の名前。SR以上を色付きで、R は省略してよい）。
- 取引 id（ストアの注文番号）・商品 id・バナー id は**どこにも出さない**（サーバーも送らない）。問い合わせ番号だけで運営は引ける。

## 5. 問い合わせシート

右から出るシート（他の Sheet と同じ部品）。キッカー「履歴」、題「問い合わせ」。
1. `HistoryModel.SupportNote`（選んだ記録の問い合わせ番号だけを送ります。お名前や連絡先は含みません）を必ず表示。
2. 「選んだ記録」：`Selected` の番号を並べる。
3. 「内容」：`TopicNames` の5つ（choice 部品、2列）。
4. 主ボタン「下書きを作る »」→ `CreateTicketAsync(topic)`。成功したら `Ticket`（`TopicText`、各行の番号と題、`Body`「問い合わせ番号：P-… / C-…」）を枠の中に出し、主ボタンを「コピー »」に替える（`Ticket.Raw` をクリップボードへ。運営の問い合わせフォーム／メールを開く場合は `Body` を本文に入れる）。
5. 「選択を外す」（文字リンク）、「閉じる」。
- エラー：`NOT_FOUND` は「期間外の記録が含まれています」、オフラインは `OfflineText`。

## 6. 空・読み込み中・オフライン・英語

- 記録なし：`Message == HistoryModel.EmptyText`（まだ記録がありません）を一覧の中央に。
- 読み込み中（`Loading`）：一覧の上に細いシアンのバー。タブの連打は無視される（モデルが捨てる）。
- オフライン：`Message == HistoryModel.OfflineText`（履歴はオンラインで確認できます）だけを出し、一覧と残高は出さない。
- 英語：モデルの文字列は日本語なので `Loc.T(...)` で表示（`ui-en.json` / `server-en.json` に全部ある）。サーバーの題（`Title`・`StatusText` など）は英語のリクエストなら英語で来る。英語は長いので題は1行に収まらなければ縮小（見本の `fitText` と同じ考え方）。
- KPI：タブを開くたびにモデルが `history_view` を1回送る（画面側は何もしなくてよい）。

## 7. 見た目の確認用スクリーンショット（見本）

`node tools/figma-prototype/test/e2e.cjs` の出力：`u-NN-history-purchases.png`・`history-coins-paid`・`history-coins-free`・`history-gacha`・`history-contact`、英語は `en-NN-history-*.png`。
