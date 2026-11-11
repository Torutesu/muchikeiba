# Round 20 Codex 向け引き継ぎ：端末のローカル通知（on-device local notifications、REQ-LNOTIF-001〜020）

更新：2026-11-11　基準ブランチ：`feat/r20-local-notifications`（`origin/claude/round18` から）
仕様：`contracts/protocol.md` §61、`docs/spec/requirements.md` 61章、`docs/planning/06-ux-experience-spec.md` 末尾「補足（Round 20）」、`docs/planning/03-legal-risk.md` 末尾。経済の目標なし（コイン・アイテムは動かない、E 番号・balance-targets の節なし）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル・予約の計画）／Codex＝見た目と OS の接続（画面・Unity Mobile Notifications・アプリの起動経路）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ ブートストラップ／`GET /v1/player` の `localReminders`（読むだけの digest：設定・プッシュの種類と静かな時間帯・調教の開いたセッション・ログインボーナスの解放・週替わりチャレンジ／ライバル／交換所の期限・プレゼントの期限）。新しいプッシュの種類 `reminders`（既定オフ、サーバーは送らない）。`PUT /v1/push/preferences` が `reminders`・`gifts` を受ける。設定 `progression.localNotifications`（リモート設定、`enabled: false` で停止） |
| C# | ✅ `engine/Muchi.Client/LocalNotifications.cs`：`LocalRemindersDigest`（`PlayerView.LocalReminders`）、`LocalNotificationSnapshot`、`LocalNotificationPlanner.Plan` / `Diff`（サーバーと同じ、`contracts/local-notifications.vectors.json`）、`ILocalNotificationPlatform`、`LocalNotificationPermission`、`PushPreferences.Reminders`、`AnalyticsEvent.LocalNotificationScheduled / Opened / PermissionResult` |
| ゲーム層 | ✅ `Muchi.Game.LocalNotificationModel`（`unity/Assets/Muchi/Game/LocalNotificationModel.cs`、チェック `unity/Checks~/GameChecks/LocalNotificationChecks.cs`）。英語は `ui-en.json`。通知の文そのものは planner が日本語・英語の両方を持つ（**端末の言語**で選ぶ） |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：設定 › 通知（`__muchi.show('NotifySettings')`）、前置き（調教の結果の右のパネル／`__muchi.show('LnotifPrePrompt')`）、次の予定の一覧（設定の右下の「デモの予定」）。OS の許可は見本では localStorage の疑似（未確認・許可・拒否のボタン） |
| ヘルプ | ✅ 記事 `local_reminders`（`server/master/help.json`、文脈 `notifications`、画面 `notifications`） |
| **Codex** | OS への接続（§2）、起動・前面・ログアウト等の呼び出し（§3）、設定 › 通知（§4）、前置きのパネル（§5）、通知を開いた時（§6）、文字の大きさ・英語（§7） |

## 2. OS への接続：`ILocalNotificationPlatform` を Unity Mobile Notifications で実装する

`com.unity.mobile.notifications` を入れ、`Muchi.Client.ILocalNotificationPlatform` を実装するクラス（例：`UnityLocalNotifications`、`unity/Assets/Muchi/Runtime/` 側。ゲーム層 `Assets/Muchi/Game` は UnityEngine を参照しない）を作り、`LocalNotificationModel` に渡す。

| メンバー | iOS（`iOSNotificationCenter`） | Android（`AndroidNotificationCenter`） |
|---|---|---|
| `Permission` | `AuthorizationRequest` の結果・`iOSNotificationCenter.GetNotificationSettings().AuthorizationStatus`（`Provisional` は `Provisional`） | API 33 以上は `PermissionRequest`／`AndroidNotificationCenter.UserPermissionToPost`、33 未満は `Granted` |
| `RequestPermissionAsync()` | `new AuthorizationRequest(Alert \| Badge \| Sound, registerForRemote: false)`。**初回起動で呼ばない**（モデルが前置きの後にだけ呼ぶ） | `PermissionRequest`（POST_NOTIFICATIONS）。拒否なら `Denied` |
| `Schedule(item)` | `iOSNotification { Identifier = item.Id, Title, Body, ThreadIdentifier = "muchi.lnotif." + item.Kind, Data = kind\|screen\|refId, Trigger = iOSNotificationCalendarTrigger(fireAt を JST から端末時刻へ) or TimeIntervalTrigger }`。同じ Identifier を予約し直すと置き換わる | チャンネル `muchi_reminders`（「リマインダー」、重要度 Default、バッジなし）。`SendNotificationWithExplicitID(n, "muchi_reminders", id)`。id は `item.Id` の安定したハッシュ（int）にし、`id → int` の表を `PlayerPrefs` に置く。`IntentData` = kind\|screen\|refId |
| `Cancel(id)` | `RemoveScheduledNotification(id)` | 表の int で `CancelScheduledNotification` |
| `CancelAll()` | **このアプリの id（`lnotif.` で始まる）だけ**を消す（`GetScheduledNotifications` から絞る）。プッシュ（FCM）の表示中の通知は消さない | `muchi_reminders` チャンネルの予約を全部 |
| `OpenSettings()` | `UIApplication.openSettingsURLString` 相当（`Application.OpenURL("app-settings:")`） | アプリの通知設定のインテント |

- `item.FireAt` は Unix ms（UTC）。そのまま絶対時刻で予約する（端末のタイムゾーンで換算しない。静かな時間帯の判断は planner が JST で済ませている）。
- 文字列は planner が作ったものをそのまま使う（`Loc.T` を通さない。端末の言語で作ってある）。サウンドは既定、バイブなし、バッジは付けない。
- **購入・ショップの通知は作らない**（planner に種類が無い）。プッシュ（FCM）のトークン登録・トピックの処理は今のまま。

## 3. 呼び出す場所（`LocalNotificationModel`）

| いつ | 呼ぶもの |
|---|---|
| 起動（ブートストラップの後）・前面に戻った時・`GameBackend.RefreshAsync` の後 | `Refresh()` |
| 調教の開始が成功した直後（`POST /v1/training/start`） | `OnTrainingStarted()` → `true` なら §5 のパネルを出す（調教のミニゲームは止めない。結果の画面で出すのがよい） |
| 調教の仕上げ・ログインボーナス・チャレンジのクリア・ランク戦の結果・交換・プレゼントの受け取り・通知の設定の変更の後 | `Refresh()`（早く仕上げた調教の通知は消える） |
| **ログアウト・アカウントの切り替え・引き継ぎ（別の端末へ移した／この端末に別のアカウントを入れた）・アカウント削除の実行** | `ForgetAll()`（このアプリの予約を全部取り消す）。削除の**予約**は digest の `deleting` で `Refresh()` が自分で取り消す。別のアカウントが入った時も `Refresh()` が気づいて取り消すが、ログアウトの画面では必ず `ForgetAll()` を呼ぶ |
| 端末の言語が変わった時 | `Refresh()`（同じ id のまま文言だけ付け替える） |
| オフライン | 何もしない（今の予約を残す。`Refresh()` はプレイヤーが無ければ予約を変えない） |

コンストラクタの `deviceLanguage` には `Application.systemLanguage == SystemLanguage.Japanese ? "ja" : "en"` を渡す（アプリの言語設定ではなく**端末の言語**）。

## 4. 設定 › 通知（1つの画面でプッシュと端末のリマインダー）

**入口**：設定の「その他」の一覧の「通知」（見本では「ヘルプ・お問い合わせ」の次）。

**形**（見本：`NotifySettings()`、1600×900 の舞台）：
- 上：`TopBar`「その他　/　通知」＋「プッシュ通知と端末のリマインダーを、ここでまとめて切り替えます」。財布は出さない。
- 左パネル（x=36, y=134, 600×676、紺の半透明 .9）：小さなシアンのラベル「通知の種類」。7行（シーズン・イベント・フレンド・招待・プレゼント・お知らせ（復帰）・**リマインダー**）、各行に「オン／オフ」の選択ボタン（`PUT /v1/push/preferences`、リマインダーは `SetRemindersAsync`）。線の下に「静かな時間帯」と3択（22時〜8時／23時〜7時／なし）。小さく「プッシュは1日2件まで。静かな時間帯は端末のリマインダーにも使われます。」
- 右パネル（x=656, y=134, 908×676）：ラベル「端末のリマインダー」（`SectionTitle`）と説明（`SectionNote`）。OS の許可の1行（`PermissionText`。拒否なら金色＋線のボタン「端末の設定を開く」＝`OpenSettings()`）。
  - 左の列：6行（`Rows`）。行の名前（`Label`）・下に小さくカテゴリ（`CategoryLabel`）・右に「オン／オフ」（**表示だけ**。切り替えは左パネルのカテゴリで。行ごとのスイッチは作らない）。
  - その下に「ロック画面に詳しく表示」のオン／オフ（`SetShowDetails`、端末の設定・既定オフ）と説明（`DetailsNote`）。
  - 右の列：「次の予定」（`UpcomingTitle`）。`Upcoming` の上から5件：シアンの小さな日時（`WhenText`、数字は等幅）・白い太字のタイトル・灰色の本文1行。無ければ「予定はありません」。許可が無い時は下に小さく「通知が許可されると、この予定で届きます」。
  - 左下にヘルプへのリンク「端末のお知らせについて（ヘルプ）」（`HelpContexts.Notifications`）。
- **カウントダウン・赤い強調・点滅は使わない**。日時は「11月16日 4:00」のように日付と時刻だけ。

## 5. 前置きのパネル（`PrePromptDue`）

- **モーダルにしない**。調教の結果の画面の右（見本：x=836, y=134, 640×420）に紺のパネルを1枚、下から少し上がる。結果の主ボタン（「つづける」）は左パネルのまま。
- 中身：シアンの小さなラベル「リマインダー」、白い太字「調教とログインボーナスのお知らせ」（`PrePromptTitle`）、本文（`PrePromptBody`）、小さく「購入やスカウトを勧めるお知らせはありません」。下に塗りの CTA「お知らせを受け取る »」（`AcceptPrePromptAsync`：リマインダーをオンにして、OS が未確認なら OS のダイアログ）と線のボタン「今はしない」（`DeclinePrePrompt`）。**最初からチェックの入った選択は置かない**。
- 出る条件はモデルが決める：リマインダーがオフ・最初の調教の後・OS が拒否でない・`maxAsks`（2）回まで・前回から `retryDays`（14）日。初回起動・FTUE の中では出ない。

## 6. 通知を開いた時

- iOS の `iOSNotificationCenter.GetLastRespondedNotification()`／Android の `GetLastNotificationIntent()` の id を `OnOpened(id)` に渡す → 返った画面へ（`training`・`home`・`weekly_challenge`・`rival`・`event_exchange`・`gift_box`。ショップは無い）。`null` なら何もしない（このアプリの予約ではない）。KPI `lnotif_opened` はモデルが送る。開いた後に `Refresh()`。
- プレゼントボックスは**開くだけ**（通知から受け取らない）。

## 7. 文字の大きさ・英語・アクセシビリティ

- §41 の文字の大きさ（特大）で、設定の2つのパネル・前置きのパネルの文字がはみ出さないこと（見本の a11y-flow で日英とも 0 件）。1行に収まらない本文は2行まで折り返してよい（見本は1行で縮める）。
- 画面の文言は `Loc.T`（`ui-en.json` に全部ある）。**通知の文と「次の予定」の行は planner がもう訳してあるので `Loc.T` を通さない**。馬の名前は詳しく表示の時だけ、プレイヤーが付けたまま（訳さない・ローマ字にしない）。
- スクリーンリーダー：オン／オフの選択ボタンに「リマインダー オン」のように行の名前を含めたラベルを付ける。

## 8. 確認すること（QA）

- 調教を始めてアプリを閉じる → 期限の3分前に「調教の仕上げ」。仕上げてから閉じる → 来ない。
- 静かな時間帯（22時〜8時）に始めた調教 → 来ない。週替わりチャレンジ（月曜 4:00 で入れ替わり）→ 日曜 8:00 に1回。
- 1日に3件以上候補がある日 → 2件だけ（優先：調教 > プレゼント > 交換所 > チャレンジ > ライバル > ログインボーナス）。
- 設定でプレゼントをオフ → プレゼントの期限の通知も来ない（プッシュと同じスイッチ）。
- ログアウト → 予約が全部消える。別のアカウントでログイン → 前の人の予定が来ない。
- OS で拒否 → 前置きは出ない、設定に「端末の設定を開く」。
- 英語の端末 → 通知は英語、アプリの言語が日本語でも。
