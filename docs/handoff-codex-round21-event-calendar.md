# Round 21 Codex 向け引き継ぎ：イベントカレンダー（予定表、REQ-CAL-001〜020）

更新：2026-11-11　基準ブランチ：`feat/r21-event-calendar`（`origin/claude/round19` から）
仕様：`contracts/protocol.md` §65、`docs/spec/requirements.md` 65章。経済の目標（E）は無し（**読むだけ。何も配らない・何も売らない**）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音・絵）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/calendar?from&to`（35日まで、各機能の正から組み立てる。写しのデータは無い）・`PUT`／`DELETE /v1/calendar/marks/:entryId`（印だけ。通知は送らない）・運営向け `GET /v1/admin/calendar`（重なりの一覧）。ヘルプ記事 `calendar`（画面リンク `calendar`、「？」の文脈 `calendar`）、ヒントのカード `calendar_tip` |
| C# | ✅ `engine/Muchi.Client/Calendar.cs`：`ApiClient.GetCalendarAsync(from, to)` / `MarkCalendarAsync(id, on)`、`CalendarView`（`Entry(id)`・`OnDay(day)`）、`CalendarEntry`（`DisplayName`・`IsPoint`・`OnDay`・`LinkScreen`/`LinkId`・`Paid`）、定数 `CalendarKinds` / `CalendarRules`、`AnalyticsEvent.CalendarView` / `CalendarEntryOpen`、`HelpContexts.Calendar` |
| ゲーム層 | ✅ `Muchi.Game.CalendarModel`（`unity/Assets/Muchi/Game/CalendarModel.cs`）。チェックは `unity/Checks~/GameChecks/CalendarChecks.cs`。`new CalendarModel(new ApiCalendar(backend.Api), backend.Store, () => backend.Online, analytics.Track)` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：その他 →「見た目・お世話・仲間」の8行目「予定表」。月ごと／週ごと、印、ヘルプ。デモは左下「デモ：28戦の厩舎で見る」 |
| **Codex** | 入口（§2）、予定表の画面（§3）、行（§4）、印（§5）、状態・英語・文字の大きさ（§6）、絵（§7） |

## 2. 入口
- **その他 › 見た目・お世話・仲間 の8行目**に行「予定表」（このページの上限は8行。これ以上足さない）。
- ヘルプ記事の画面リンク `calendar` も予定表を開く。画面の右上の「？」は `HelpCenterModel.OpenContext(HelpContexts.Calendar)`（記事 `calendar`）。
- 画面を開いたら `CalendarModel.LoadAsync()`（オフラインで付けた印もここで送られる）。

## 3. 予定表の画面（「ムチ一閃」のトーン）
見本と同じ1600×900の構図。**背景はコースの写真（見本は `Art/Courses/autumn-course`）、左を暗くする影、紺の半透明パネル2枚、字間の広い小さなシアンのキッカー**。主ボタン（斜めのシアン »）は置かない（行を開くのが主操作）。
- 上の帯：題「予定表」、小さな説明「参加できる予定　·　時刻はすべて日本時間」。
- 左パネル（440×676）：キッカー「表示」と切り替え「月ごと」「週ごと」（`SetMode`、選択中はシアンの枠）。表示中の期間（大きな数字「11/11 – 12/15」）と「今日」＋日付。週ごとのときは「前の週」「次の週」（`ShiftWeek`、端では押せない）。キッカー「印」と「1 / 30」（`MarkCount` / `View.MarkMax`）、その下に `MarkNote`（「印を付けても、お知らせは届きません」）と小さく「パスとスカウトは期間だけ。中身はそれぞれの画面で」。読めなかった種類があれば金色で `PartialText`。一番下に文字リンク「予定表のヘルプ ›」。
- 右パネル（1068×676）：キッカー「期間の予定」（月ごと）／「週の予定」（週ごと）。その下が**パネルの中でスクロールする一覧**（文字を大きくしても縮めず、行が伸びてスクロールが長くなる）。
  - 月ごと：一番上に「始まっている予定」（範囲の前から続いているもの）、その後は**始まる日ごと**の見出し（シアンの字間の広い「11/14（土）」、細い線）と行。今日の見出しの右に金の小さな点。
  - 週ごと：7日分の見出しと、**その日にかかる全部の行**（`CalendarModel.RowsOn(day)`）。予定の無い日は薄い字で `EmptyDayText`。
- 戻るで その他（見た目・お世話・仲間のページ）へ。

## 4. 行
紺の半透明の帯（角は直線、薄い枠）。左から：
- 1行目：小さなシアンの種類名（`Title`：イベントレース・イベント交換所・週替わりチャレンジ・支部の共同目標・支部対抗シーズン・ランク戦のシーズン・シーズンパスを買える期間・スカウト・大会の受付・大会の開始・主催カップ・メンテナンス・復帰キャンペーン）と状態の小さなピル（`StatusText`：開催中＝シアンの枠／これから／終了）。
- 2行目：名前（`DisplayName`、21px 太字、折り返し可）。**カップの名前はプレイヤーが書いたもの：英語でも訳さない・ローマ字にしない**。
- 3行目：時刻（`CalendarModel.TimeText(e, english)`：「11/01 00:00〜12/01 00:00（日本時間）」／"11/01 00:00–12/01 00:00 JST"。大会の開始は時刻1つ）。
- 4行目（あるとき）：`NoteText`（有料の行は `PaidNote`「期間だけを載せています」、観戦できる大会は `SpectateLabel`）。
- 右端：印のボタン（斜めの小さなチップ。付いていればシアンの塗り「印を外す」、無ければ枠だけ「印を付ける」）と、開ける行なら「›」。
- **やってはいけないこと**：残り時間・カウントダウン・「まもなく終了」・点滅・赤い強調・「今だけ」「残りわずか」の類。価格・コインの数・「買う」ボタン。パスの行から購入画面へ飛ばすこと。期間の数字を画面で計算し直すこと（サーバーの `StartJst`／`EndJst`／`FirstDay`／`LastDay` だけを使う）。
- 行を押す：`CalendarModel.Open(e)` が `(screen, id)` を返したらその画面へ（`event`・`event_exchange`・`weekly_challenge`・`team_goal`・`league`・`season`・`gacha_rates`（提供割合の画面、`id` = バナー）・`tournament`・`cup`・`comeback`・`maintenance`）。null（パス）のときは何もしない（押せる見た目にしない）。

## 5. 印
- 印のボタンで `ToggleMarkAsync(id)`。**すぐに見た目を変える**（サーバーの返事を待たない）。終わった行（`Markable == false`）には印のボタンを出さない（付いている印を外すボタンだけは出す）。
- 断られたら元に戻り `Message`（`GoneText`／`EndedText`／`LimitText`）をトーストで出す。オフラインでは端末に貯め、次に開いたときに送る（`PendingMarks`）。
- **通知は今は無い**：印はサーバーに「付けた」ことだけを保存する。§61（端末の通知、Round 20）が入ったら、印の行について端末の通知を予約する（§65.2 のメモ）。それまでは印の近くに `MarkNote` を必ず出す。

## 6. 状態・英語・文字の大きさ
- 読み込み中：一覧の場所に細いシアンのバー。オフライン：`OfflineText`（「予定表はオンラインで見られます」）。
- 英語：画面の文字は `Loc.T`（ui-en.json）、行の種類名・イベント名・バナー名・シーズン名はサーバーが英語で返す。時刻は **JST のまま「JST」と書く**（`TimeText(e, Loc.IsEnglish)`）。日付の見出しは英語では「Sat 11/14」。
- 文字「特大」：一覧はスクロールで伸びる。行の文字は縮めない。左パネルの文字は 368px 幅で折り返す（見本は日英とも特大ではみ出さない：e2e の a11y-flow で確認）。
- 動きを減らす：一覧のスクロール以外に動きは無い。

## 7. 絵
- 新しい絵は要らない。背景はコースの写真（季節に合わせて差し替えてよい）。種類ごとのアイコンを付けるなら小さな線画（シアン1色）で、**有料の行（パス・スカウト）にだけ目立つ色を付けない**。

## 8. KPI
- `calendar_view`（表示 `month`／`week` と行の数）はモデルが読み込み・切り替えのたびに1回送る。`calendar_entry_open`（種類）は `Open` が送る。印はサーバーが `calendar_mark` を記録する（画面からは送らない）。
