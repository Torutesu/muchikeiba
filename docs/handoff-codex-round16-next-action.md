# Round 16 Codex 向け引き継ぎ：次にやること（ホームの案内カード、REQ-NEXT-001〜014）

更新：2026-11-09　基準ブランチ：`feat/r16-next-action`（`origin/claude/round14` から）
仕様：`contracts/protocol.md` §45、`docs/spec/requirements.md` 45章、UX：`docs/planning/06-ux-experience-spec.md` §6.1、法務：`docs/planning/03-legal-risk.md`「次にやること」。経済の目標なし（コイン・アイテムは動かない、E 番号なし）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/home/next`（支部に入っていれば共同目標も見る）・`POST /v1/home/next/dismiss {kind}`（今日のゲーム日だけ閉じる、冪等）。ブートストラップと `GET /v1/player` の `nextActions`（共同目標なし、最初の描画用）。選び方は `server/src/domain/nextAction.ts` の純粋関数、優先度は `server/master/progression.json` の `nextActions`（起動時と各版で検証）。KPI `next_card_dismiss`（サーバー） |
| C# | ✅ `ApiClient.GetNextActionsAsync` / `DismissNextActionAsync`、`NextActionsView` / `NextItem` / `NextKinds`、オフラインの予備 `NextActionFallback.Offline`、`PlayerView.NextActions`、`AnalyticsEvent.NextCardView` / `NextCardTap`（`engine/Muchi.Client/NextAction.cs`） |
| ゲーム層 | ✅ `Muchi.Game.NextActionModel`（`unity/Assets/Muchi/Game/NextActionModel.cs`、チェック `unity/Checks~/GameChecks/NextActionChecks.cs`）。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` のホーム（デモ「次にやること」= `__muchi.demo('next')`：3日分のプレイ＋2日で期限の来るプレゼント＋スカウト券2枚） |
| **Codex** | ホームのカード（§2）、チップ（§3）、閉じる（§4）、遷移（§5）、オフライン（§6） |

## 2. 主カード（`NextActionModel.Primary`）

**場所**：ホームの**下の中央**、相棒のパネル（左下）と「レースへ」（右下）の間、パドックの絵の上。見本では 1600×900 の舞台で x=520, y=560, 560×142。**上のバーには何も足さない**（シーズン・ライバルの帯・プレゼントの封筒・財布・EN。§40 のベルが後でこの並びに入るので、そこを空けておく）。左の「お知らせ／復帰／広告」のカード枠と週替わりチャレンジのカードは今までどおり。

**形**：紺の半透明パネル（`box()`、不透明度 .84）1枚、上に 4px のシアンの線は不要。
- 左上：小さな字間の広いシアンのラベル `Kicker`（「次にやること」）。
- 右上：文字だけのリンク「今日は閉じる」（`Primary.Dismissible` の時だけ。§4）。
- 1行目：`Title`（白・太字・21px 相当・1行）。
- 2行目：`Detail`（灰色・14px）。`DeadlineText` があれば「　·　」でつないで後ろに（`12月10日 11:59まで`）。**カウントダウン・点滅・赤字・「急いで」は禁止**。期限が近くても色を変えない（変えるなら金色まで）。
- 右下：線のボタン（`compact_btn()`、シアンの 2px の線）に `CtaText`。**塗りの CTA にしない**（ホームの塗りの CTA は「レースへ」だけ。06 §6「1画面に主ボタンは1つ」）。
- 出し方：ホームの他の要素の後に、下から 12px 上がる（`rise`、200ms）。種類が変わった時だけ動かす。

**描かない時**：`Hidden`（サーバーで無効）、`Primary == null`、主カードが `race` でチップも無い時（大きな「レースへ」と同じことを言うだけなので）。

## 3. チップ（`NextActionModel.Chips`、0〜2個）

主カードの下（見本では y=712、204×42、間隔 10px）に横並び。線のボタン（小）に `ChipText`（`プレゼント 1件`・`スカウト券 2枚` など）。期限は書かない（主カードになった時に出る）。タップで §5 の遷移。`scout_ticket` は**チップにしかならない**（サーバーとモデルで保証済み）。

## 4. 今日は閉じる

`DismissAsync(kind)` → サーバーの次の一覧に入れ替わる（オフラインでも端末に覚えて閉じたまま）。トースト「今日はこのお知らせを閉じました」（`Hidden for today`）。翌ゲーム日（4:00 JST）に戻る。`first_race` / `race` は閉じられない（リンクを出さない）。

## 5. 遷移（`Tap(row)` が KPI を送り、開く画面の id を返す）

| screen | 開く画面 |
|---|---|
| `race` | レースロビー（`first_race`・`first_win`・`race`） |
| `login_bonus` | ログインボーナスの受け取り（自動で受け取る作りなら受け取ってトースト） |
| `missions` | ミッションのシート |
| `season_pass` | シーズンパス（**受け取りの段**へスクロール。購入の欄に飛ばさない） |
| `gift_box` | プレゼントボックス（**開くだけ**。カードから受け取らない） |
| `training` | 調教 |
| `event_exchange` | 交換所（`RefId` = イベントID） |
| `feature` | `FeatureKey` の機能（週替わりチャレンジ・ライバル・調教・タイムアタック・イベント・支部…、無ければ「機能・イベント」の一覧）。開いた時の1画面の案内（`UnlockGate.Guides`）があれば先に |
| `rival` | ライバルの詳細 |
| `weekly_challenge` | 週替わりチャレンジ |
| `team_goal` | 支部の共同目標 |
| `scout` | スカウト（券を使う。有償の10連を先に見せない） |

**ショップへ行く遷移は無い**（作らないこと）。

## 6. オフライン・読み込み

- ホームを開いたら `LoadAsync()`。300ms 以内は前回のカードをそのまま出す（`PlayerView.NextActions` か端末の保存）。取れなければ `NextActionFallback`（期限を過ぎた物・今日閉じた物を外す、日をまたいだら `race` だけ＝描かない）。エラーの文は出さない（ホームは静かに）。
- `ReportViews()` をカードが画面に出た時に呼ぶ（同じ種類は1ゲーム日に1回だけ `next_card_view`）。

## 7. 文言（日本語＝`NextActionModel.Row`、英語＝`ui-en.json`）

煽りの言葉（「今だけ」「残りわずか」「お得」「倍」）と購入・ショップの語は使わない（GameChecks と e2e が検査）。プレイヤーの入力した名前は出ない。新しい文言を足す時は `ui-en.json` にも足す（`L10nChecks` が落ちる）。

## 8. 素材

新しい絵は不要（パドックの絵の上のパネルとボタンだけ）。アイコンを付けるなら種類ごとの単色の線画（封筒・旗・蹄鉄など、24px）で、色だけで意味を持たせない。
