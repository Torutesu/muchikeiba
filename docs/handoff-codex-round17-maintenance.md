# Round 17 Codex 向け引き継ぎ：メンテナンス・強制アップデート（REQ-MNT-001〜016）

更新：2026-11-10　基準ブランチ：`feat/r17-maintenance`（`origin/claude/round15` から）
仕様：`contracts/protocol.md` §46（と §4 の `hello.engine`・close 4026）、`docs/spec/requirements.md` 46章、運用は `docs/ops/console.md`「メンテナンス」と `docs/ops/deploy.md` §7.2。経済の目標（E）は無し。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ リモート設定の区画 `maintenance`（窓・対応バージョン・最低のエンジン）。Worker の入口で1回だけ調べ、503 `MAINTENANCE` / 426 `UPGRADE_REQUIRED`。購入レシート・ストア通知・退会・進行中のレースの確定は止めない。`GET /v1/maintenance`（認証なし）。新着情報に `kind: "maintenance"` |
| C# | ✅ `ApiClientOptions.Platform`・`AppVersion`（全要求にヘッダー）、`ApiClient` の1か所で 503/426（再試行しない・`MaintenanceException`／`UpgradeRequiredException`・イベント `MaintenanceDetected`／`UpgradeRequired`・`Outage`）、`GetMaintenanceAsync`、`MaintenanceInfo`・`UpgradeInfo`・`MaintenanceStatus`・`ClientVersion`（`engine/Muchi.Client/Maintenance.cs`）。`EngineInfo.Level`（`engine/Muchi.Net/EngineInfo.cs`）を `hello` に、`CloseCodes.VersionMismatch`（4026）。`AnalyticsEvent.MaintenanceBlock`・`UpgradePrompt` |
| ゲーム層 | ✅ `Muchi.Game.MaintenanceModel`（`unity/Assets/Muchi/Game/MaintenanceModel.cs`、チェックは `unity/Checks~/GameChecks/MaintenanceChecks.cs`） |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：`__muchi.demo('maintenance')`（メンテナンス画面）、`demo('maintenance-scoped')`（機能だけ止まった時の案内）、`demo('maintenance-news')`（ホームの新着情報 → お知らせ）、`demo('update')`（更新が必要な画面） |
| **Codex** | 起動の配線（§2）、メンテナンス画面（§3）、機能だけ止まった時の案内（§4）、更新が必要な画面（§5）、推奨の更新のシート（§6）、ホームのお知らせ（§7）、レースの 4026（§8）、英語・文字の大きさ・動き（§9） |

## 2. 配線（1回だけ）

```csharp
var api = new ApiClient(http, auth, new ApiClientOptions {
    BaseUrl = …, Platform = Application.platform == RuntimePlatform.IPhonePlayer ? "ios" : "android",
    AppVersion = Application.version });           // x.y.z のまま（"1.2.0"）。エディタでは null のままでよい
var maintenance = new MaintenanceModel(new ApiMaintenance(api), options.Platform, analytics.Track);
maintenance.Attach(api);                           // 503 / 426 はどの要求で来てもここに届く
maintenance.DismissedVersion = PlayerPrefs.GetString("muchi.update.later", null);
await maintenance.RefreshAsync();                  // 起動時とホームに戻った時
```
- **各画面で 503/426 を個別に処理しない**。`MaintenanceException`／`UpgradeRequiredException` は「画面はモデルが出すので何もしない」で握りつぶしてよい（`UxText.For` も文は返す）。
- `NetworkException`（応答なし）では `maintenance.OnOffline()`。メンテナンス・更新の画面が出ている時はオフラインの表示に替わらない。
- `Screen` が変わったら全画面を出し替える：`Maintenance` → §3、`UpdateRequired` → §5、`Offline` → 既存のオフラインの帯（`UxText.Offline`）。`None` → 元のゲーム。
- `Later()` の後は `DismissedVersion` を `PlayerPrefs` に保存する。

## 3. メンテナンス画面（`Screen == Maintenance`、範囲が「すべて」の窓）

見本 `maintenance`。1600×900、**背景 `Art/home-paddock` を全面（ゆっくりしたズームは無し）、左を暗くする影、紺の半透明パネル1枚、主ボタン（斜めのシアン »）は1つ**。まばらに。
- 左上：小さく字間を空けたシアンのキッカー「メンテナンス」（86×3 のシアンの線つき）。
- 大きな題 `Title`（「メンテナンス中です」、64px 前後、白、影）。
- その下に本文 `Body`（窓のメッセージ。サーバーが英語モードでは英語で返す）。
- パネル：キッカー「終了予定（日本時間）」`MaintenanceModel.EndsLabel` と大きな数字 `EndsAt`（"11/12 06:00"、44px、等幅数字）。細い線。キッカー「止まっている機能」と `MaintenanceModel.GroupsText(Info.Scope)`（すべての時は「ゲーム全体」）。
- 主ボタン「再読み込み »」`ReloadCta` → `RefreshAsync()`（`Loading` 中は押せない）。窓が終わっていれば `Screen` が `None` に戻る。
- 一番下に小さく `PurchaseNote`「購入済みのコインは、メンテナンス中でも必ず受け取れます。」
- **出さないもの**：カウントダウン・残り時間・進捗バー・点滅・「まもなく」などの急かす表現（REQ-MNT-015、法務の決まり）。終了の時刻だけ。
- EN トグルは右上（他の画面と同じ）。

## 4. 機能だけ止まった時の案内（`PartialNotice != null`）

範囲がグループ（スカウト・ショップ など）の窓。その機能を開いた時に 503 が来る → **全画面にしない**。見本 `maintenance-scoped`：中央のダイアログ（紺のガラス 760×460、下からの小さな浮き上がり）。
- キッカー「メンテナンス」、題「この機能はメンテナンス中です」`PartialTitle`、左に「終了予定（日本時間）」と `EndsAt`、右に「止まっている機能」と `GroupsText(PartialNotice.Scope)`、細い線、`PartialBody`「ほかの機能はいつもどおり遊べます。」、小さく `PurchaseNote`、主ボタン「ホームへ »」→ `DismissPartial()` してホームへ。
- その機能の入口（スカウトのタブ・ショップ）に小さな印（「メンテナンス中」）を付けてもよい（任意。`maintenance.Banner` が実施中の窓）。

## 5. 更新が必要な画面（`Screen == UpdateRequired`）

見本 `update-required`。背景 `Art/title-screen`、左の影、パネル1枚、主ボタン1つ。**この画面は自分では閉じない**（戻るボタン無し）。
- キッカー「アップデート」、題 `Title`（「アップデートのお願い」）、本文 `Body`（バージョンが古い時は「新しいバージョンのアプリが公開されています。ストアから更新してください。」、レースのエンジンが古い時は `EngineBody`）。
- パネル：「お使いのバージョン」`Upgrade.Version`（無ければ `Application.version`）と「必要なバージョン」`Upgrade.MinVersion`、大きな等幅数字で左右に。
- 主ボタン「ストアへ »」→ `Application.OpenURL(maintenance.OpenStore())`（URL はサーバーが返した App Store / Google Play の https だけ。サーバーが宛先を検査済み）。
- 小さく `PurchaseNote`（購入済みのコインは失われない）。

## 6. 推奨の更新のシート（`ShowRecommend`）

推奨より古い時（最低よりは新しい）。ホームの上に右からのシート（既存の `Sheet` と同じ）：題「新しいバージョンがあります」`RecommendTitle`、本文 `RecommendBody`、主ボタン「ストアへ »」→ `OpenStore()`、ゴースト「あとで」→ `Later()`。**同じ推奨バージョンでは二度と出さない**（モデルが管理）。他のカード（新着・復帰）と同時には出さず、ホームのカードの順番の最後でよい。

## 7. ホームのお知らせ（予定の窓）

- **新着情報のカード**（既存）：`kind == "maintenance"` の行はラベル「メンテナンス」、押すとお知らせの画面（見本 `maintenance-notice`）。
- **お知らせの画面**：`TopBar`「メンテナンスのお知らせ」、パネル1枚：キッカー「予定」（実施中は「メンテナンス中」）、大きく `BannerTimes`（"11/12 02:00〜11/12 06:00"、英語では "–"）、窓のメッセージ、細い線、「止まっている機能」、`PurchaseNote`、主ボタン「ホームへ »」。
- ホームの帯（任意）：`maintenance.Banner` があればホームの上の帯に小さく `BannerTitle` と `BannerTimes`。押すとお知らせの画面。点滅させない。

## 8. レースの 4026（エンジンが古い）

`RaceSession` が close 4026 で `Failed`、`FailureReason == "VERSION_MISMATCH"` になったら、レースの画面を閉じて `maintenance.OnUpgrade(new UpgradeInfo { Reason = "engine" })` を呼ぶ（更新が必要な画面へ）。再接続はしない（`CloseCodes.FatalReason` が止める）。ふつうは待ち行列に入る前の HTTP で 426（`reason: "engine"`）になるので、ここに来るのは抜け道だけ。

## 9. 英語・文字の大きさ・動き

- 画面の文はモデルの日本語の定数を `Loc.T(…)` で出す（英語は `ui-en.json` に入れた）。窓のメッセージと 503/426 の `message` はサーバーが言語に合わせて返す。
- **文字の大きさ（§41）**：本文（28px 未満）は設定の倍率で大きくする。収まらない時だけ標準まで戻す（日本語は標準より小さくしない）。見本の a11y の通し（`test/a11y-flow.cjs`）で、3画面とも「特大」の日本語・英語ではみ出し0件。
- 動きを減らす：背景のズーム無し、ダイアログは 150ms 以下のフェード。点滅は使わない。
- 色だけで伝えない：止まっている機能は文字で書く。

## 10. 触らないもの

- 購入の流れ：メンテナンス中でも、古いアプリでも、レシートの送信（`POST /v1/shop/purchase`）とストア通知はそのまま通る。**メンテナンス中にストアの購入の続き（未完了のトランザクションの再送）を止めない**。
- KPI：`maintenance_block`・`upgrade_prompt` はモデルが送る。画面から別に送らない。
