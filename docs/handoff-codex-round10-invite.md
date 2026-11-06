# Round 10 Codex 向け引き継ぎ：友達招待と深いリンク（REQ-INV-001〜012）

更新：2026-11-06　基準ブランチ：`feat/r10-invite`（`claude/round9` から）
仕様：`contracts/protocol.md` §18、`docs/spec/requirements.md` 18章、法務：`docs/planning/03-legal-risk.md`「友達招待」、経済：`docs/spec/balance-targets.md` 4.7

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目と OS の設定（深いリンク・共有シート・画面）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/invite`（`x-install-id`）・`POST /v1/invite/redeem`、到達報酬の送信箱（アラームで配達）、アカウント削除の手順 `invites`、KPI |
| C# | ✅ `ApiClient.GetInviteAsync` / `RedeemInviteAsync`、`InviteCodes`（`Normalize`・`Display`・`FromLink`）、`AnalyticsEvent.InviteShare`、エラーコード `Invite*` |
| ゲーム層 | ✅ `Muchi.Game.InviteModel`（`unity/Assets/Muchi/Game/InviteModel.cs`、チェックは `unity/Checks~/GameChecks/InviteChecks.cs`） |
| 見本 | ✅ `tools/figma-prototype/site/unity.html` →「その他」→「友達招待」（`unity.html?invite=<コード>` で深いリンクの代わり） |
| **Codex** | 深いリンクの OS 設定（§2）、共有シート（§3）、インストール ID の保存（§4）、画面（§5） |

## 2. 深いリンク（iOS / Android）

リンクは2種類。どちらも **コードを入力欄に入れるだけ**（自動で引き換えない。`InviteModel.HandleLink(url)`）。

| 形 | 使う場面 |
|---|---|
| `muchi://invite/<code>` | アプリが入っている端末（カスタム URL スキーム） |
| `https://invite.muchi-issen.example/i/<code>` | 共有の文に入るリンク。アプリが無ければストア／ランディングページへ。Universal Links / App Links を設定するとアプリが直接開く |

`invite.muchi-issen.example` は**仮のドメイン**。本番のドメインが決まったらサーバーの `progression.invite.shareBaseUrl` と下の設定を同時に変える（クライアントのコードは変更不要。`InviteCodes.FromLink` は https なら `/i/<code>` を見るだけ）。

**Unity 共通**：`Application.deepLinkActivated` と、起動時の `Application.absoluteURL` の両方を `InviteModel.HandleLink` に渡す。

```csharp
// 例（Integration 層、MonoBehaviour）
void Awake()
{
    Application.deepLinkActivated += url => invite.HandleLink(url);
    if (!string.IsNullOrEmpty(Application.absoluteURL)) invite.HandleLink(Application.absoluteURL);
}
```

- `HandleLink` はコードを `IKeyValueStore`（PlayerPrefs）の `muchi.invite.linkCode` に覚える。チュートリアル中に開かれた場合も、入力できるようになって `LoadAsync` した時に入力欄へ入る。引き換えが済むと消える。
- 入力できない状態（チュートリアル前・期間後・入力済み）でもリンクで落ちない。チュートリアル前なら「チュートリアルを終えると入力できます」を出すだけ。

**iOS**
- Player Settings → Other Settings → **Supported URL schemes** に `muchi` を追加（Info.plist の `CFBundleURLTypes`）。
- Universal Links：Xcode の Signing & Capabilities で **Associated Domains** に `applinks:invite.muchi-issen.example`。ドメイン側に `/.well-known/apple-app-site-association`（`"paths": ["/i/*"]`、Team ID とバンドル ID）を置く（運営側の作業。サーバーの Workers に置いてもよい）。
- Unity の iOS ビルドは Universal Links も `Application.deepLinkActivated` に届く。

**Android**
- `Assets/Plugins/Android/AndroidManifest.xml`（無ければ Unity の Custom Main Manifest を有効にする）の起動 Activity に intent-filter を2つ：

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="muchi" android:host="invite" />
</intent-filter>
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="invite.muchi-issen.example" android:pathPrefix="/i/" />
</intent-filter>
```

- App Links の検証用に、ドメイン側に `/.well-known/assetlinks.json`（パッケージ名と署名証明書の SHA-256）を置く（運営側）。
- インストール前にリンクを踏んだ人は、ストア経由ではコードが渡らない（Play Install Referrer / iOS は仕組み無し）。v1 は**手入力**が前提（共有の文にコードが書いてある）。Install Referrer での自動入力は後続（入れる場合も `HandleLink` に渡すだけ）。

## 3. 共有シート

- `InviteModel.ShareAsync(IShareSheet)` が `share.text`（サーバーが作る固定文：コードと https のリンク）を渡す。`IShareSheet` はリプレイ共有（`ReplayShare.cs`）と同じインターフェース。**文は書き換えない**（報酬の額・「無料」などを足さない。景品表示法の表示の注意、03-legal-risk.md）。
- `filePath` は null（画像なし）。画像を付けたい場合はロゴ程度にして、報酬や金額を画像に入れない。
- 実際に共有された時だけ `invite_share` が送られる（キャンセルは送らない）。コピーは `InviteModel.Copy()` / `Copy(link: true)` が返す文字をクリップボードへ（`GUIUtility.systemCopyBuffer`）。

## 4. インストール ID

- `InviteModel.InstallId` が PlayerPrefs の `muchi.installId` に乱数を1回だけ作る。**再インストールで変わってほしくない**ので、可能なら iOS は Keychain、Android は Keystore で暗号化した保存先に移す（`IKeyValueStore` を差し替えるだけ）。サーバーはハッシュしか保存しない。
- この ID は広告 ID（IDFA / AAID）ではない。ATT の許可は要らない。

## 5. 画面（「ムチ一閃」のトーン）

見本は `unity.html` の「友達招待」。左上：自分のコード（大きく字間を広げる）と「招待コードを送る »」（斜めのシアンの CTA）・コピー・規約。左下：招待ボーナスの表（`MilestoneRows`）と「対象 2 / 10人」（`CapText`）。右上：招待した仲間（`Rows`：到達＝✓、上限外は「対象外」、削除された人は「退会したプレイヤー」）。右下：入力欄（`EntryVisible` のときだけ。`CanSubmit` で送信ボタン、`EntryHint` に残り日数とギフト）。

- エラーの文は `InviteModel.Errors`（`INVITE_REFUSED` は理由を出さない中立の文）。
- 入口は「その他」とフレンド画面（REQ-SOCIAL-*）の2か所を想定。ホームのバナーなどで招待を促すときも金額は出さない。
- 規約のボタンは `TermsKey`（`terms.invite`）の条項を開く。条項の本文は運営が用意する（弁護士レビュー対象）。
