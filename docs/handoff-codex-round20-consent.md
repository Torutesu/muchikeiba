# Round 20 Codex 向け引き継ぎ：広告・分析の同意管理（REQ-CNS-001〜020）

更新：2026-11-11　基準ブランチ：`feat/r20-consent`（`origin/claude/round18` から）
仕様：`contracts/protocol.md` §58、`docs/spec/requirements.md` 58章、UX `docs/planning/06-ux-experience-spec.md` §6.14・§9.4、法務 `docs/planning/03-legal-risk.md`「広告・分析の同意管理」（**弁護士レビュー待ち**）。経済の目標なし（コイン・アイテムは動かない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目と OS のネイティブ呼び出し（ATT・UMP）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET`／`PUT /v1/privacy/choices`、`PUT /v1/privacy/platform`、`POST /v1/privacy/prompt-shown`（メンテナンス・強制アップデートで閉じない）。`GET /v1/player`・ブートストラップに `privacyChoices`。§21 の `adRequest` に `npa`・`extras.npa`・`tagForChildDirected`。分析がオフの人の任意の KPI はサーバーが書かない。KPI `consent_change`（必須） |
| C# | ✅ `engine/Muchi.Client/Consent.cs`：`ConsentState`・`ConsentChoice`・`AdRequestConfig`・`AttStatus`・`CmpStatus`・`CmpResult`・**`IConsentPlatform`**・`NoConsentPlatform`、`ApiClient.GetPrivacyChoicesAsync`・`SetPrivacyChoicesAsync`・`ReportPrivacyPlatformAsync`・`NotePrivacyPromptShownAsync`、`PlayerView.PrivacyChoices`、`AnalyticsClient.Gate`／`Withheld` |
| ゲーム層 | ✅ `Muchi.Game.ConsentModel`（`unity/Assets/Muchi/Game/ConsentModel.cs`、`IAdConsent` を実装、チェック `unity/Checks~/GameChecks/ConsentChecks.cs`）。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：3日目のホームの広告カード「動画を見る」→ 事前の画面 → ATT のシミュレーション。その他 → プライバシー → 「広告と分析の設定 ›」 |
| **Codex** | ネイティブの ATT（§2）・UMP（§3）、`IConsentPlatform` の実装と組み込み（§4）、事前の画面（§5）、設定の画面（§6）、文字の大きさ・英語（§7） |

## 2. iOS：App Tracking Transparency（ネイティブ）
- `Info.plist` に `NSUserTrackingUsageDescription`：「広告をあなたの興味に合わせるために使います。許可しなくても、受け取れる報酬や遊べる内容は変わりません。」（英語：「Used to match ads to your interests. If you do not allow it, your rewards and everything you can play stay the same.」）。**文言は弁護士レビューの対象**（03）。InfoPlist.strings で日英。
- `IConsentPlatform.AttStatus`：`ATTrackingManager.trackingAuthorizationStatus` を `AttStatus` に（`notDetermined`→`NotDetermined`、`restricted`→`Restricted`、`denied`→`Denied`、`authorized`→`Authorized`）。iOS 14 未満・iOS 以外は `Unavailable`。
- `RequestAttAsync`：`ATTrackingManager.requestTrackingAuthorization` を**メインスレッドで**、アプリが active の時に呼ぶ（起動直後・別のシステムの確認と重ねると出ないことがある：事前の画面を閉じてから 0.3 秒ほど待つ）。結果を返す。`NotDetermined` 以外の時は呼ばずに今の状態を返す。例外を投げない。
- `OpenAppSettings`：`UIApplication.openSettingsURLString`（`Application.OpenURL("app-settings:")`）。
- AdMob SDK の初期化は ATT の結果が出た後（`GADMobileAds.sharedInstance.start` を `ConsentModel.AcceptAsync`／`LaterAsync` の後、または 2回目以降の起動ならすぐ）。
- アプリの復帰（`OnApplicationPause(false)`）で `ConsentModel.SyncPlatformAsync()` を呼ぶ（設定アプリで ATT を変えた人の状態をサーバーへ）。

## 3. Android／EEA：Google UMP（User Messaging Platform、ネイティブ）
- `GatherCmpAsync(underAgeOfConsent)`：`ConsentRequestParameters`（`setTagForUnderAgeOfConsent(underAgeOfConsent)`）で `requestConsentInfoUpdate` → `loadAndShowConsentFormIfRequired`。結果を `CmpResult` に：`GdprApplies`（`privacyOptionsRequirementStatus == REQUIRED` か、TCF の `IABTCF_gdprApplies` = 1）、`Status`（`ConsentInformation.getConsentStatus()`：`NOT_REQUIRED`→`NotRequired`、`REQUIRED`→`Required`、`OBTAINED`→`Obtained`、他→`Unknown`）、`CanRequestAds`、`PrivacyOptionsRequired`。iOS でも UMP を使う（EEA の iPhone）。v1 は日本のみなので、多くは `NotRequired` が返る。
- `PrivacyOptionsRequired`／`ShowPrivacyOptionsAsync`：`showPrivacyOptionsForm`。設定の「広告の同意を見直す」の行（`ConsentRowAction.ReviewAdConsent`）から呼ぶ。
- UMP の `canRequestAds` が false の間は広告を読み込まない（`IAdProvider.IsReady` が false を返す）。
- テスト用：UMP の `ConsentDebugSettings`（EEA の地域のテスト）を開発ビルドだけで。

## 4. 組み込み（`IConsentPlatform` の実装と配線）
- `Assets/Muchi/Integration` に `NativeConsentPlatform : IConsentPlatform`（iOS／Android の分岐、エディタは `NoConsentPlatform`）。
- 起動時：`var consent = new ConsentModel(backend, platform); consent.Attach(analyticsClient);`（分析がオフの間、端末で任意のイベントを捨てる。サーバーも捨てる）。
- `new RewardedAdModel(api, adProvider, analytics, consent)`：`ConsentModel` が `IAdConsent`。広告のリクエストは `AdShowRequest.NonPersonalized` のとおり（AdMob：`npa = "1"` を `AdRequest.Builder().addNetworkExtrasBundle(AdMobAdapter.class, extras)`、iOS は `GADExtras.additionalParameters = ["npa": "1"]`）。`ConsentModel.AdRequest.TagForChildDirected` が true の時は `RequestConfiguration.tagForChildDirectedTreatment = TRUE`、`UnderAgeOfConsent` は `tagForUnderAgeOfConsent = TRUE`（`IAdProvider.Preload` の引数にも渡っている）。
- `ConsentModel.LoadAsync()` をホームに入る時（ブートストラップの `PlayerView.PrivacyChoices` でも足りる）。

## 5. 事前の画面（`ConsentModel.ShouldShowPrePrompt` → `BuildPrePrompt`）
**いつ**：
- 広告のカードの「動画を見る」を押した時、`ShouldShowPrePrompt(ConsentMoment.BeforeAdOffer)` が true なら、広告を始める前にこの画面（閉じたら広告へ進む）。
- ホームに入った時、`ShouldShowPrePrompt(ConsentMoment.Home)` が true なら（ポリシーの版が上がった時。規約の再同意の後）、ホームの前に出す。
- チュートリアル・マッチング・レース中・オフラインでは false（モデルが判定する）。**自分で別の場所に出さない**（06 §2.3：FTUE とインストール当日は出さない）。

**見た目**（見本 `site/app.js` `ConsentPrompt`）：背景 `Art/home-paddock` に暗いシェード、中央に紺の半透明のダイアログ（見本 1040×700）。字間を空けた小さなシアンのラベル「プライバシー」と細いシアンの線、大きな白い見出し `Title`（「広告と分析について」）、`Lines` を順に（1行目は白、ほかは MUTED、行間 1.6）。その下に「分析への協力」の行と［オフ］［オン］の選択（`Analytics`、`AnalyticsLocked` なら押せない表示）。小さな SOFT の文（`AttNext` の時「このあと端末の確認が表示されます。」、いつも「設定 › プライバシー から、いつでも変えられます。」）。斜めのシアンの CTA「続ける »」（→ `AcceptAsync(personalizedAds: sheet.PersonalizedAds, analytics)`、iOS では ATT の答えがパーソナライズ広告になる）と、枠だけの「あとで」（→ `LaterAsync()`、ATT を出さない）。
- **やってはいけない**：報酬・コインの絵や「もらえる」系の文、カウントダウン、システムの ATT の画面に似せたボタン、閉じられない表示。iOS の ATT のシステムの画面は OS が出す（見本のシミュレーションの画面は作らない）。

## 6. 設定 › プライバシー › 広告と分析（`ConsentModel.Rows()`）
- 入口：プライバシーの画面（§51）の右のパネルの下に「広告と分析の設定 ›」（見本）。ヘルプの記事 `ads_analytics_privacy` の画面リンク `privacy_choices` もここへ。
- 左のパネル「広告と分析」：`Rows()` の順に1行ずつ（ラベル 21px 白、説明 14px MUTED、右に［オフ］［オン］、下に `Note`）。`Note` は効かない理由（年齢・18歳未満・年齢が未登録・端末のトラッキング・EEA の同意）が**金色**、ふつうの説明は SOFT。
  - `Action == Toggle` → `SetPersonalizedAdsAsync(on)`／`SetAnalyticsAsync(on)`。
  - `Action == OpenOsSettings` → ボタン `ActionLabel`（「端末の設定を開く」）→ `IConsentPlatform.OpenAppSettings()`。
  - `Action == ReviewAdConsent` → 「広告の同意を見直す」→ `ReviewAdConsentAsync()`。
  - `Enabled == false` の行は押せない表示（半透明）。
  - その下に細い線、「端末のトラッキング許可」と今の状態（許可／許可しない／制限されています／まだ確認していません）。
- 右のパネル「プライバシーポリシー」：「いまの版」と `State.PolicyVersion`（大きな数字）、最後に選んだ日（`State.DecidedAt`、日付だけ）、「プライバシーポリシーを読む」のリンク、細い線、「いつも保存するもの」と説明（購入・返金・同意・アカウント削除・データの開示・通報の記録は法律や安全のために保存）、ヘルプへのリンク（文脈 `privacy_choices`）。
- 保存の結果は `ActionResult.Message` をトースト（「保存しました」）。`TextStale`（ポリシーが更新された）はトーストの後に画面を読み直す。

## 7. 文字の大きさ・英語
- アクセシビリティの文字の大きさ（§41、`TextScale`）にすべての本文が従う。最大の大きさで、ダイアログの文が CTA に重ならないよう、行は折り返し・ダイアログは縦に伸ばす（見本は a11y-flow で確認済み）。
- 英語はモデルの文が `Loc.T` で出る（`ui-en.json` に全部ある）。見本の画面の文は `proto-en.json`。ヘルプの記事は `help.json` の日英。

## 8. 確認の手順（Codex）
1. 新規インストール → チュートリアル → 1日目は事前の画面も ATT も出ない。
2. 2日目・ランク戦3戦の後、ホームの広告カード「動画を見る」→ 事前の画面 → 「続ける」→ ATT（許可／許可しない）→ 広告。ATT を許可しなくても同じ無償コインが付く。
3. 「あとで」→ ATT は出ない。同じ版ではもう出ない。設定からパーソナライズ広告をオン → ATT が出る（初回だけ）。
4. 設定アプリで ATT を変えて復帰 → 設定の行が変わる。
5. 分析をオフ → 端末の `AnalyticsClient.Withheld` が増え、サーバーの応答の `withheld` も数える。
6. サーバーのプライバシーポリシーの版を上げる → 規約の再同意の後、ホームで事前の画面がもう一度。
