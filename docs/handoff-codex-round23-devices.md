# Round 23 Codex 向け引き継ぎ：ログイン中の端末とセキュリティ（REQ-DEV-001〜020）

更新：2026-11-12　基準ブランチ：`feat/r23-devices`（`origin/main` の上）
仕様：`contracts/protocol.md` §70、`docs/spec/requirements.md` 70章、法務の決まり `docs/planning/03-legal-risk.md`「ログイン中の端末」。経済の目標（E）は無し（何も配らない・何も売らない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `POST /v1/account/devices/checkin`・`GET /v1/account/devices`・`POST /v1/account/devices/:sessionId/signout`・`POST /v1/account/devices/signout-others`・`GET /v1/account/security-log`。ログアウトされた端末の次の要求は `401 SESSION_REVOKED`。メンテナンスでも古いアプリからでも止まらない |
| C# | ✅ `engine/Muchi.Client/Devices.cs`：`ApiClient.CheckinDeviceAsync` / `GetDevicesAsync` / `SignOutDeviceAsync` / `SignOutOtherDevicesAsync` / `GetSecurityLogAsync`、`DeviceSessionList` / `DeviceSession` / `SecurityLog`、`DeviceLabel`（名前・地域）、`DeviceCheckin`（機種の系統・OS の番号）、`SessionRevokedException` と `ApiClient.SessionRevoked` イベント、`DeviceSignOutException`（`AvailableAt`） |
| ゲーム層 | ✅ `Muchi.Game.DeviceSessionsModel`（`unity/Assets/Muchi/Game/DeviceSessionsModel.cs`、チェックは `unity/Checks~/GameChecks/DevicesChecks.cs`）。`new DeviceSessionsModel(new ApiDeviceSessions(backend.Api), () => backend.Online, clock, track)`。`MaintenanceModel` に `MaintenanceScreen.SessionRevoked`、`AccountChangeReset.Devices` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：その他 → 設定（左の「設定」パネル）の「引き継ぎ」の下「ログイン中の端末 ›」。一覧・確認のシート・セキュリティの記録・ログアウトされた端末の画面。一覧の右下のデモで「新しい端末でログインする」「ログアウトされた端末の画面」 |
| **Codex** | 入口（§2）、一覧（§3）、確認のシート（§4）、記録（§5）、ログアウトされた端末（§6）、チェックインの配線（§7）、英語・文字の大きさ・オフライン（§8） |

## 2. 入口（その他 › 設定のアカウントのパネル）

- **その他のページの行は増やさない**（8行のまま）。左の「設定」パネルの「引き継ぎ（Apple・Google）」の段の下に、文字リンク「ログイン中の端末 ›」（`DeviceSessionsModel.EntryLabel`）。`Visible == false`（サーバーで切ってある）なら出さない。
- アクティビティの `new_device`（ラベル「アカウント」、アイコン `device`）を押すと一覧が開く（`ActivityScreens.Devices`）。ヘルプの記事 `signed_in_devices`（コンテキスト `devices`）、ヒントのカード `devices_tip` からも開く。

## 3. 一覧（「ムチ一閃」のトーン）

見本と同じ 1600×900 の構図。**背景 `Art/home-paddock` 全面、左を暗くする影、紺の半透明パネル2枚。この画面には斜めのシアンの主ボタンを置かない**（ログアウトは「静かな」操作。主ボタン » は確認のシートの「ログアウトする」だけ）。
- 上の帯：題「ログイン中の端末」、説明「このアカウントでログインしている端末とセキュリティの記録」（財布は出さない）。
- **左パネル**：キッカー「この端末」と1行（`RowTitle(Current)` を白の太字、`RowDetail` を灰の小さな字、右端にシアンの字間の広いラベル「この端末」。ログアウトのボタンは無い）。細い線、キッカー「ほかの端末」と行（最大5行、それ以上は「ほか◯台」）。各行：名前（白の太字）、地域・最後の利用（灰）、右にゴースト「ログアウト」。`CanSignOut == false` の行もボタンは出し、押すと `AskSignOut` が理由を `Message` に入れる（「この端末でログインしてから24時間たつと、前からある端末もログアウトできます」）→ 短いトースト。
  - 名前の組み立ては必ず `DeviceLabel`（「iPhone（iOS 18）」「Androidの端末」）。**機種名は訳さない**。
  - 時刻は日付だけ（サーバーが1時間に切り捨てている）。カウントダウン・「◯分前」は出さない。
  - 一番下に小さく「ログアウトは1日◯回まで（今日 ◯回）」（`RevokesPerDay` / `RevokesToday`）。
- **右パネル**：キッカー「まとめて」、ゴースト「この端末以外をすべてログアウト」（`AskSignOutOthers`）、その下に灰の説明（後からの端末はすぐ、前からの端末は24時間後）。細い線、文字リンク「セキュリティの記録 ›」「ログイン中の端末について（ヘルプ）」。最後に小さく「名前は機種の種類とOSの大きな番号、地域は国だけです。IPアドレスは記録しません。」
- 開いた時に `LoadAsync`（KPI `device_list_view` はモデルが送る）。

## 4. 確認のシート（ログアウトの前に必ず）

- 中央のダイアログ（920×460 目安、紺、下は暗く）。キッカー「確認」、題 `Confirm.Title`（「Pixel（Android 15）をログアウトしますか？」／「この端末以外をすべてログアウトしますか？」）、本文 `Confirm.Body`（灰）、`Confirm.AnonymousNote` がある時は**金**で（連携も引き継ぎコードも無いアカウント：「その端末ではこのアカウントに戻れなくなります…」）。
- 主ボタン「ログアウトする »」（`ConfirmSignOutAsync`）、ゴースト「やめる」（`CancelConfirm`、何も送らない）。
- 結果は `Message`（「ログアウトしました」「今日はこれ以上ログアウトできません」など）を短いトーストで。**再試行のボタンは作らない**（サーバーが同じ答えを返すだけ）。
- **怖がらせる言葉を使わない**：「不正」「危険」「今すぐ」「乗っ取り」は画面に出さない。赤い警告色も使わない（金の注意まで）。

## 5. セキュリティの記録

- 1枚の大きなパネル。キッカー「直近◯日」（`Log.LogDays`）。行（最大8、それ以上は「ほか◯件」）：日時（灰、等幅の数字）、文 `Item.Text`（白の太字、サーバーの文をそのまま。英語は応答の言語）、端末のある行は `DeviceLabel.Name(Item.Device)`・地域（灰）。
- **見るだけ**：行から何かを実行するボタンは無い。戻ると一覧。
- 開いた時に `LoadLogAsync`。

## 6. ログアウトされた端末（`401 SESSION_REVOKED`）

- `MaintenanceModel.Screen == MaintenanceScreen.SessionRevoked` の時、ゲームの代わりに全画面で（§54.6 の「別の端末に引き継がれました」と同じ構図）。キッカー「ログアウト」、題 `DeviceSessionsModel.RevokedTitle`（「この端末はログアウトされました」）、本文 `RevokedBody`（中立。理由を推測しない）。
- ボタン：主ボタン「ログインする »」（**Apple・Google の連携がある時だけ**。サインインし直す → 成功で `LeaveSessionRevoked()`）、ゴースト「新しく始める」（Firebase からサインアウトして新しい匿名アカウント → `LeaveSessionRevoked()`）、文字リンク「お問い合わせ」（ヘルプのお問い合わせ。オフラインでも開ける）。
- メンテナンス・強制アップデート・オフライン・再読み込みはこの画面を置き換えない。`SESSION_REPLACED`（データが別の端末に移った）が来たらそちらが勝つ（`OnSessionRevoked` は何もしない）。
- 画面が出た時に `AccountChangeReset` が端末の状態（ローカル通知・エラーの束・お願いの画面・保留のリンク・アップデートのお知らせ・端末の一覧の写し）を1回だけ消す。配線は `reset.Watch(maintenance)`（`SessionReplacedShown` と `SessionRevokedShown` の両方を受ける）。

## 7. チェックインの配線（見た目は無し）

- **起動・アプリの復帰（前回から1時間以上）・サインインの直後・Apple／Google の連携の追加と解除の直後**に `DeviceSessionsModel.CheckinAsync(new DeviceCheckin { Platform, OsMajor = DeviceCheckin.MajorOf(SystemInfo.operatingSystem の版), Model = SystemInfo.deviceModel, AppVersion = Application.version }, installId)`。
  - `Model` は生の値を入れてよい（`DeviceCheckin.ModelFamily` が数字と記号を落とす：`iPhone15,2` → `iPhone`）。**端末の名前（ユーザーが付けた名前、`SystemInfo.deviceName`）は送らない**。
  - `installId` は §54 と同じインストール ID（`x-install-id`）。サーバーはアカウントごとのハッシュだけを持つ。
  - 失敗しても何も出さない（次の起動でまた送る）。
- 連携の追加・解除の後は Firebase の ID トークンを更新してから送る（`firebase.identities` が新しくなる。記録の `link_added`／`link_removed` はトークンから決まる）。

## 8. 英語・文字の大きさ・オフライン

- 文言は全部 `Loc.T`（`ui-en.json` に英語あり）。サーバーの文（記録の行・エラー）は要求の言語で来る。`DeviceLabel` は英語の時に「iPhone (iOS 18)」「iOS 18 device」「Japan」を作る。
- 最大の文字（§41）で：一覧の行は名前と地域の2行、ボタンは行の右で縮めずに折り返さない（見本の a11y-flow で確認済み）。確認のシートの本文は折り返してよい。
- オフライン：一覧と記録は `OfflineText` を出して空のまま。確認のシートの「ログアウトする」は送らずに `OfflineText`。

## 9. 確認したこと（見本）

- e2e（`tools/figma-prototype/test/unity-flow.cjs`）：入口 → 一覧（この端末が先）→ 新しい端末のデモ（アクティビティに1件、リンク先が一覧）→ 確認のシート（やめるは何も送らない）→ ログアウト（その端末の次の要求が `SESSION_REVOKED`）→ すべて → 記録の順 → ログアウトされた画面（端末の状態が1回だけ消える、怖がらせる言葉なし）。
- 英語（`en-flow.cjs`）・最大の文字（`a11y-flow.cjs`）：一覧・確認のシート・記録・ログアウトされた画面で、日本語の残りなし・はみ出しなし。
