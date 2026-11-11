# Codex への引き継ぎ（Round 21）：ディープリンク・招待リンクと再戦

contracts/protocol.md §63（REQ-LINK-001〜024）。ロジックは済み：サーバー（`server/src/domain/deepLinks.ts`・`linkService.ts`・`rematch.ts`）、C#（`engine/Muchi.Client/DeepLinks.cs`）、Unity のゲーム層（`unity/Assets/Muchi/Game/DeepLinkModel.cs` の `DeepLinkModel`・`RematchModel`）、プロトタイプ（`tools/figma-prototype/site/app.js` の `Links`・`ShareSheet`・`OpenLink`・`LinkConfirm`・`RoomLobby`・`FriendRoomResult`）。Codex にお願いするのは **ネイティブの設定と画面**。

## 1. ネイティブの設定（ユニバーサルリンク／App Links）

値はすべて仮。本物は docs/ops/deep-links.md の手順でリモート設定に入れる（リポジトリに置かない）。

### iOS
1. Xcode の Signing & Capabilities に **Associated Domains** を足し、`applinks:<LINK_HOST>` を入れる（Unity の iOS ビルドの後処理 `PostProcessBuild` で `.entitlements` に `com.apple.developer.associated-domains` を書く）。
2. カスタムスキーム `muchi` を Info.plist の `CFBundleURLTypes` に足す。
3. 受け取り：Unity の `Application.deepLinkActivated`（起動中）と、起動時の `Application.absoluteURL`（コールドスタート）を `DeepLinkModel.Receive(url)` に渡す。
4. iOS には deferred deep link がない：クリップボードは**読まない**。「リンクを開く」画面（§2.3）でコードを入れてもらう。

### Android
1. `AndroidManifest.xml`（`Assets/Plugins/Android`）のメインの Activity に：
   ```xml
   <intent-filter android:autoVerify="true">
     <action android:name="android.intent.action.VIEW" />
     <category android:name="android.intent.category.DEFAULT" />
     <category android:name="android.intent.category.BROWSABLE" />
     <data android:scheme="https" android:host="LINK_HOST_PLACEHOLDER" android:pathPrefix="/l/" />
   </intent-filter>
   <intent-filter>
     <action android:name="android.intent.action.VIEW" />
     <category android:name="android.intent.category.DEFAULT" />
     <category android:name="android.intent.category.BROWSABLE" />
     <data android:scheme="muchi" android:host="l" />
   </intent-filter>
   ```
2. 受け取りは iOS と同じ（`Application.deepLinkActivated`・`Application.absoluteURL` → `DeepLinkModel.Receive`）。
3. **Install Referrer**：`com.android.installreferrer:installreferrer` を足し、初回起動で `InstallReferrerClient` の `getInstallReferrer()` の文字列を `DeepLinkModel.ReceiveInstallReferrer(referrer)` に渡す（モデルが1回だけにする）。

### 呼ぶところ（call sites）
| いつ | 呼ぶもの |
|---|---|
| OS からリンクが来た | `DeepLinkModel.Receive(url)`（入口は URL から自動：`universal`／`scheme`） |
| 初回起動（Android） | `DeepLinkModel.ReceiveInstallReferrer(referrer)` |
| ホームに戻るたび・オンラインに戻った時・FTUE が終わった時 | `await DeepLinkModel.TryOpenAsync(online)` → `DeepLinkRoute` があれば `Screen` の画面を**確認から**開く。null なら `Notice` をトーストで |
| 「リンクを開く」で入力 | `Receive(text, DeepLinkEntries.Typed)` → `TryOpenAsync(true)` |
| 共有ボタン | `DeepLinkModel.ShareAsync(shareSheet, type, target)`（OS の共有シート。文はサーバーの `shareText` をそのまま） |
| フレンド部屋の結果 | `RematchModel`（`PressAsync(horseId)`・`ShouldPoll` の間は1秒ごとに `PollAsync()`・`DeclineAsync()`・`RoomPassphrase` で部屋へ） |
| 分析 | `AnalyticsEvent.DeepLinkOpen` はモデルが送る（トークンは入れない） |

`ApiDeepLinkApi(ApiClient)`・`ApiRematchApi(ApiClient)` が本物のつなぎ。`FtueDone` は `AccountLinkPrompt.FtueDone(player)` を渡す。

## 2. 画面（ムチ一閃のトーン：写真のアート、半透明の紺のパネル、字間の広いシアンの小見出し、斜めのシアンの CTA »、余白を広く）

### 2.1 共有シート（`ShareSheet`）
- 小見出し「共有」、サーバーの `shareText` の1行目、リンク（シアン、1行、はみ出しは省略）、「リンクにあなたのIDや名前は入りません。期限は…までです。」、CTA「共有する »」、「閉じる」。
- 入口：フレンド画面（フレンド申請＝自分のプロフィール）、友達招待（招待コード）、フレンド部屋のロビー、主催カップのロビー、公開したリプレイ、支部、ヘルプの記事の「共有」。
- 報酬・額・「今だけ」などの煽りは出さない（文はサーバーのまま）。

### 2.2 リンクで招待・共有（`Links`、その他 › 見た目・お世話・仲間 の8行目）
- 左：「リンクを送る」のボタン、「共有したリンク」（種類・期限・取り消す）、「今日作ったリンク n / 30」。
- 右：「リンクを開く »」の入口。

### 2.3 リンクを開く（`OpenLink`）
- 入力欄（URL または 22文字のコード、4文字ずつのハイフンは任意）・CTA「開く »」・案内の行（下の表）。
- 「iPhoneでストアから入れた時は、リンクのページに出ているコードをここに入れてください（自動では開きません）」。

| 状態 | 文 |
|---|---|
| `unavailable`（知らない・期限切れ・取り消し・ブロック・相手が退会など、**理由は分けない**） | このリンクは開けません |
| `friends_only` | このリプレイはフレンドだけが見られます |
| `maintenance` | メンテナンス中です。終わってからもう一度開いてください |
| `update_required` | このリンクを開くにはアプリの更新が必要です（ストアへのボタン） |
| 429 | しばらくしてからお試しください |
| FTUE 中 | チュートリアルの後で開きます |

### 2.4 確認（`LinkConfirm`）— **リンクだけでは何も起きない**
- 種類の小見出し、行き先（部屋の番号・フレンドの名前（入力のまま、訳さない）・招待コード・カップ名・支部名・記事の題）、「まだ何もしていません。どうするかを選んでください」、CTA（参加する・申請の画面へ・招待コードの入力へ…）と「やめる」。
- 招待コードは入力欄に入れるだけ。入力の条件・特典は §19 のまま（「招待コードの特典は、これまでどおり入力した時だけです」）。

### 2.5 フレンド部屋の結果の「再戦」（`FriendRoomResult`）
- 右のパネル：小見出し「再戦」、説明「押した人どうしで、同じ条件の新しい部屋に入ります。最初に押されてから20秒で締め切ります」、CTA「再戦 »」（押した後は「待っています」で無効）、「やめる」。
- 待っている間：「再戦を待っています（2/3人・あと12秒）」— サーバーの締め切り（`deadlineAt`）からの**本当の残り秒**。偽のタイマーや点滅の煽りはしない。動きを減らす設定（§41）なら数字だけ更新。
- 開いた：「新しい部屋ができました」・CTA「新しい部屋へ »」→ ロビー（「前のレースと同じ条件・新しいレース」）。
- 入れなかった：「この再戦には入れませんでした」（理由は言わない）／「人数がそろわず、再戦は開きませんでした」。
- ランク戦の点・レートに入らないことを TopBar の副題で言う。

### 2.6 最大の文字の大きさ・英語
- すべての文に英語がある（`engine/Muchi.Client/Resources/Muchi/ui-en.json` の `_links`）。名前は訳さない。
- 最大の文字の大きさではみ出さない（プロトタイプの a11y-flow で確認済みの配置を目安に）。

## 3. 描くもの（アセット）
新しい絵は要らない（既存のパドックの背景・パネル・CTA）。アイコンが欲しければ「リンク」（鎖）と「再戦」（循環の矢印）の2つ、シアンの線画。ブロック管理（§47）の「ブロックするとどうなる？」に8行目 `links`（アイコンキー `link`、`BlockListModel.Icons`）が増える：8行が最大の文字でも収まる間隔にする（プロトタイプは 64px 間隔）。
