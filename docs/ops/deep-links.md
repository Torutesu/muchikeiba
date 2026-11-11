# ディープリンクの運用（ユニバーサルリンク・App Links・Web の案内）

contracts/protocol.md §63（REQ-LINK-010〜012）の運用メモ。**ここに書くのは仮の値だけ**。本物のチーム ID・証明書の指紋・ドメインはリポジトリに置かず、リモート設定（`progression.links`）で入れる。

## 1. リンクの形

| 形 | 例 | どこで開く |
|---|---|---|
| ユニバーサルリンク／App Links | `https://<LINK_HOST>/l/<token>` | アプリが入っていれば OS がアプリに渡す。入っていなければ Worker の案内のページ（§3） |
| アプリのスキーム | `muchi://l/<token>` | 案内のページの「アプリで開く」、アプリ内のテスト |
| 手で入れる | `abcd-efgh-jkmn-pqrs-tuvw-xy`（22文字を4文字ずつ） | アプリの「リンクを開く」（iOS であとから開く時） |

- `<token>`：22文字、`23456789abcdefghjkmnpqrstuvwxyz`。**プレイヤー ID・名前・部屋の合言葉は入らない**。中身はサーバーが引く（`POST /v1/links/resolve`）。
- `<LINK_HOST>`：`progression.links.baseUrl`（既定は仮の `https://link.muchi-issen.example`）。本番のドメインが決まったらリモート設定で変える。既存の招待リンク（§19 `progression.invite.shareBaseUrl`、`/i/<code>`）はそのまま残る。

## 2. アプリの関連付けのファイル

Worker が `progression.links` の設定から返す（設定が無ければ 404）。リンクのホストを Worker のルートに向ける（`wrangler.toml` の `routes` に `<LINK_HOST>/*` を足す。API のホストと同じ Worker でよい）。

### 2.1 `GET /.well-known/apple-app-site-association`
設定：
```json
"links": { "apple": { "appIds": ["ABCDE12345.com.example.muchi"] } }
```
返す内容（`Content-Type: application/json`、リダイレクトしない）：
```json
{ "applinks": { "apps": [], "details": [
  { "appID": "ABCDE12345.com.example.muchi", "appIDs": ["ABCDE12345.com.example.muchi"], "paths": ["/l/*"], "components": [{ "/": "/l/*" }] } ] } }
```
- `ABCDE12345` は**仮のチーム ID**。本物は Apple Developer のチーム ID（10文字）。`com.example.muchi` は仮の Bundle ID。
- Xcode（Unity の iOS ビルドの後処理）で Associated Domains に `applinks:<LINK_HOST>` を足す（docs/handoff-codex-round21-deep-links.md）。

### 2.2 `GET /.well-known/assetlinks.json`
設定：
```json
"links": { "android": { "packageName": "com.example.muchi", "sha256CertFingerprints": ["AA:BB:…:FF"] } }
```
返す内容：
```json
[ { "relation": ["delegate_permission/common.handle_all_urls"],
    "target": { "namespace": "android_app", "package_name": "com.example.muchi", "sha256_cert_fingerprints": ["AA:BB:…:FF"] } } ]
```
- 指紋は **Play アプリ署名鍵**（Play Console › アプリの完全性）の SHA-256。アップロード鍵ではない。ここに書いた `AA:BB:…:FF` は仮。
- AndroidManifest の intent-filter に `android:autoVerify="true"`・`https`・`<LINK_HOST>`・`pathPrefix="/l/"` を足す。

## 3. アプリが入っていない時の案内のページ（`GET /l/:token`）

- Worker の最小のテンプレート（`server/src/domain/deepLinks.ts` `fallbackPage`）。**トークンを引かない**：どの文字列でも同じページ（知らないトークンと本物の区別がつかない＝オラクルなし）。個人のデータを出さない。`x-robots-tag: noindex`・`referrer-policy: no-referrer`。
- 内容：短い説明（日英）、「アプリで開く」（`muchi://l/<token>`）、App Store と Google Play へのボタン（URL は §46 の `maintenance.clientVersions.<platform>.storeUrl`）、iPhone 向けのコードの表示。

## 4. あとから開く（deferred deep link）

クリップボードは**使わない**（iOS 16 以降は貼り付けの許可のダイアログが出る。勝手に読まない）。

| OS | しくみ | できること |
|---|---|---|
| Android | Google Play の URL に `&referrer=link%3D<token>` を付ける（案内のページが付ける）。初回起動で Play Install Referrer API を読み、`DeepLinkParser.FromInstallReferrer` がトークンを取り出す | インストールの後の最初の起動で、FTUE が終わってから自動で開く（`DeepLinkModel.ReceiveInstallReferrer`。読むのは1回だけ） |
| iOS | App Store はインストールに値を運ばない | **自動では開けない**（正直にそう書く）。案内のページにコードを見せ、インストールの後に「リンクを開く」に入れてもらう。インストールの前にリンクを開いた人は、インストール後にもう一度リンクを押せばユニバーサルリンクで開く |

- どちらも、開いた画面は確認から始まる（参加・申請・招待コードの入力は本人が押す）。招待コードの特典（§19）はリンクでは変わらない。

## 5. 止めたい時・数字を変えたい時

- 全部止める：`progression.links.enabled = false`（作る・一覧・取り消しは 404、開くは `unavailable`。案内のページは出る）。
- 種類ごとに新しいアプリを求める：`progression.links.minClientVersion.<type> = "x.y.z"`（古いアプリには `update_required`）。
- 引く回数の上限：`resolvesPerHour`・`failuresPerHour`・`lockMinutes`。総当たりの疑いは KPI `link_resolve` の `unavailable`（docs/ops/kpi-queries.md「ディープリンク・再戦」）。
- 再戦の窓：`rematchWindowSec`（既定20秒）・`rematchOfferMinutes`（既定15分）。
- wrangler の移行は不要（DirectoryDO の SQLite に `links`・`link_limits` の表を足すだけ、マッチメーカーは既存の行の表に `m|<raceId>` を足すだけ）。
