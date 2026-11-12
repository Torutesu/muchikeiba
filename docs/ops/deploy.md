# デプロイ手順書（ステージング・本番）

この手順書は、まだアカウントがない状態から最初のデプロイまでを順に書いたものです。リポジトリ側の準備（設定ファイル・CI・コンテナ）は済んでおり、**`REPLACE_ME` を埋めてシークレットを登録すれば動く**状態にしてあります。

## 0. 全体像

```
アプリ（Unity） ──HTTPS/WebSocket──▶ Cloudflare Worker（muchi-server-<env>）
                                      ├─ Durable Objects（レース部屋・プレイヤー・マッチング…）
                                      ├─ R2（リプレイ・ランキングのスナップショット）
                                      ├─ Analytics Engine（KPI）
                                      └─ HTTPS + Bearer ──▶ Cloud Run（muchi-verifier-<env>、C#の再計算）
Firebase：認証（IDトークン）・FCM（プッシュ）
Apple / Google：レシート検証・サーバー通知
```

| 環境 | Worker | 検証サーバー | 使い方 |
|---|---|---|---|
| local | `wrangler dev`（`DEV_MODE=1`） | `dotnet … serve` | 開発・`scripts/integration.sh` |
| staging | `muchi-server-staging` | `muchi-verifier-staging` | `main` に入ると自動デプロイ（有効化後） |
| production | `muchi-server-production` | `muchi-verifier-production` | 手動・承認制 |

- 環境ごとに **Cloudflareのリソース（Durable Object・R2・Analytics）とGCPプロジェクト、Firebaseプロジェクトを完全に分けます**。
- `DEV_MODE`（偽ストア・`x-dev-user`）は local 専用です。`wrangler.toml` に書くと `lint:deploy` が止め、staging/production の Worker は `DEV_MODE` が付いていると全リクエストを拒否します。

## 1. Cloudflare

1. **Workers 有料プラン**に加入する（Durable Objects に必要）。
2. **R2 バケット**を作る（環境ごとに別）。
   ```bash
   npx wrangler r2 bucket create muchi-replays-staging
   ```
   ```bash
   npx wrangler r2 bucket create muchi-public-staging
   ```
   ```bash
   npx wrangler r2 bucket create muchi-replays-production
   ```
   ```bash
   npx wrangler r2 bucket create muchi-public-production
   ```
   - `muchi-public-*` はランキングのスナップショット置き場です。CDNから配る場合は、R2 のカスタムドメインを割り当てます。
   - **個人データのダウンロード（Round 18、protocol §51）**：`muchi-replays-*` の `private/data-export/` に置く。このバケットには公開のカスタムドメイン・r2.dev の公開 URL を付けない。予備の削除として、接頭辞 `private/data-export/` に「作成から 8 日で削除」のライフサイクルルールを付ける（アプリは `keepDays`（7日）で消す。`keepDays` を変えたら `keepDays + 1` 日に合わせる）：
     ```bash
     npx wrangler r2 bucket lifecycle add muchi-replays-production data-export-expiry private/data-export/ --expire-days 8
     ```
3. **Analytics Engine** を有効にする。データセット（`muchi_kpi_staging` / `muchi_kpi_production`）は最初の書き込み時に自動で作られます。
4. **カスタムドメイン**：`wrangler.toml` の `routes`（`api-staging.<ドメイン>` / `api.<ドメイン>`）を、Cloudflare で管理しているゾーンに合わせて書き換えます。
5. **APIトークン**（GitHub Actions用）：権限は「Workers Scripts: Edit」「Workers R2 Storage: Edit」「Account Analytics: Read」「Workers Routes: Edit（対象ゾーン）」。アカウントIDと一緒に GitHub の環境シークレットに入れます（§6）。
6. **費用の上限**：Cloudflare ダッシュボード → Notifications で「Usage Based Billing」の通知を設定する（Durable Objects のリクエスト数・時間、R2 の容量）。

## 2. Firebase（環境ごとに別プロジェクト）

1. プロジェクトを作る（例：`muchi-staging` / `muchi-production`）。このIDを `wrangler.toml` の `FIREBASE_PROJECT_ID` と `FCM_PROJECT_ID` に入れます。
2. **Authentication**：匿名ログインを有効にし、引き継ぎ用に Apple と Google のログインも有効にします。
   - 匿名ユーザーの自動削除は有効にしておきます（MAU の節約）。
3. **Cloud Messaging**：iOS は APNs 認証キー（.p8）をアップロードします。Android は特に設定不要です。
4. **Webアプリ**を1つ登録し、その **Web API キー**を GitHub の環境変数 `FIREBASE_WEB_API_KEY` に入れます（デプロイ後のスモークテストで、匿名ユーザーを作るために使います。公開されても問題ない値です）。
5. **FCM用のサービスアカウント**：「Firebase Cloud Messaging API 管理者」ロールを付けて鍵JSONを発行し、Worker のシークレット `FCM_SERVICE_ACCOUNT_JSON` に入れます（設定しない場合は `GOOGLE_SERVICE_ACCOUNT_JSON` が使われます）。
6. **Unityアプリ**（REQ-API-005）：
   - iOS／Android アプリを登録し、`GoogleService-Info.plist` と `google-services.json` を `unity/Assets/` に置く（環境ごとに別ファイル。リポジトリには入れない）。
   - Firebase Unity SDK の `FirebaseAuth.unitypackage` を取り込み、Player Settings の Scripting Define Symbols に `MUCHI_FIREBASE` を追加する。
   - 起動時に `await MuchiFirebase.InitializeAsync()` を呼んでから `MuchiServices.Create()` を呼ぶ（匿名ログインまで済ませ、`MuchiServices.FirebaseTokens` を設定する）。
   - Sign in with Apple はランダムな nonce を作り、SHA-256 したものを Apple に、元の値を `FederatedCredential.FromApple(idToken, rawNonce)` に渡す。Google は Google Sign-In の ID トークンを `FromGoogle(idToken)` に渡す。
   - 引き継ぎ：`LinkAsync` が `CredentialInUse` を返したら、プレイヤーに「この端末の進行は残りません」と確認してから `SwitchToExistingAccountAsync` を呼ぶ。
   - 引き継ぎコード（REQ-TRF-*、§54）：入力の応答の `customToken` を `FirebaseAuthTokenProvider.SignInWithCustomTokenAsync` に渡す。`401 SESSION_REPLACED` を受けたら `SignOutReplacedSession()` で案内の画面へ。
7. **引き継ぎコードのカスタムトークンの鍵**（REQ-TRF-011、§54.7）：手順は §9.6。Worker のシークレット `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON`。入れない環境では引き継ぎコードが出ない（Apple／Google だけ）。

## 3. GCP（検証サーバー：Cloud Run）

環境ごとに1プロジェクト（Firebase のプロジェクトと同じものでよい）。

1. API を有効にする：Cloud Run、Artifact Registry、Secret Manager、IAM Credentials。
2. **Artifact Registry**：Docker リポジトリ `muchi` を作る（リージョンは `asia-northeast1` を推奨）。
3. **実行用サービスアカウント** `verifier-runtime@<project>.iam.gserviceaccount.com`：付けるロールは `verifier-auth-secret` に対する「Secret Manager のシークレット アクセサー」だけです。
4. **共有シークレット**：Secret Manager に `verifier-auth-secret` を作り、32文字以上のランダム値を入れます。**同じ値を Worker の `VERIFIER_TOKEN` にも入れます**（§5）。
   ```bash
   openssl rand -base64 48
   ```
5. **デプロイ用サービスアカウント** `github-deployer@<project>.iam.gserviceaccount.com`：ロールは「Cloud Run 管理者」「Artifact Registry 書き込み」と、実行用サービスアカウントに対する「サービス アカウント ユーザー」。
6. **Workload Identity Federation**（GitHub Actions から鍵なしで GCP に入るため）：
   - Workload Identity プールと、GitHub OIDC のプロバイダ（`https://token.actions.githubusercontent.com`）を作る。
   - 属性条件で `assertion.repository == "Torutesu/muchikeiba"` に限定する。
   - デプロイ用サービスアカウントに、そのプロバイダからの「Workload Identity ユーザー」を付与する。
   - プロバイダのリソース名（`projects/<番号>/locations/global/workloadIdentityPools/<プール>/providers/<プロバイダ>`）を GitHub の `GCP_WIF_PROVIDER` に入れる。
7. 初回デプロイ後、Cloud Run の URL（`https://muchi-verifier-<env>-xxxx.a.run.app`）を `wrangler.toml` の `VERIFIER_URL` に入れてコミットします。デプロイ時、CI がこの2つの一致を確認します。

### 検証サーバーの認証について
- `/verify` は `Authorization: Bearer <VERIFIER_AUTH_SECRET>` がないと 401 を返します（`engine/Muchi.Verifier/VerifierAuth.cs`、比較は一定時間）。
- コンテナには `VERIFIER_REQUIRE_AUTH=1` が入っているので、シークレットなしでは**起動しません**（設定漏れで公開状態になることはありません）。
- ネットワーク上は公開（`allUsers` に起動権限）で、アプリ側で鍵を確認する方式です。より強くしたい場合は、Cloud Run を「認証が必要」にし、Worker から Google 署名の ID トークンを付けて呼ぶ方式に切り替えられます（その場合、Worker にサービスアカウント鍵を持たせて ID トークンを作る処理を `HttpVerifierClient` に足します）。

### 設定値（`deploy/verifier/service.yaml`）
| 項目 | 値 | 理由 |
|---|---|---|
| 最小インスタンス | 0 | 検証が必要なとき以外は費用ゼロ |
| 最大インスタンス | staging 3 / production 20（`VERIFIER_MAX_INSTANCES`） | 費用の上限 |
| 同時リクエスト | 40 | 1回の再計算は数十ms |
| CPU / メモリ | 1 / 512Mi | |
| タイムアウト | 30秒 | Worker 側は10秒で諦める |
| 起動ブースト | 有効 | コールドスタート短縮 |

## 4. Apple / Google ストア

| 項目 | Apple（App Store Connect） | Google（Play Console） |
|---|---|---|
| アプリID | バンドルID → `APPLE_BUNDLE_ID` | パッケージ名 → `GOOGLE_PACKAGE_NAME` |
| サーバー通知 | App Store Server Notifications **Version 2**、URL `https://<api>/v1/store/notifications/apple`（本番とサンドボックスの両方） | RTDN：Pub/Sub トピックを作り、Play Console に登録。push サブスクリプションのエンドポイントは `https://<api>/v1/store/notifications/google`、「認証を有効化」して、そのサービスアカウントを `GOOGLE_PUBSUB_SERVICE_ACCOUNT`、オーディエンスを `GOOGLE_PUBSUB_AUDIENCE` に入れる |
| API用の鍵 | （任意）App Store Server API：Issuer ID・Key ID・.p8 | サービスアカウントを Play Console に招待し、「注文の管理」権限を付けて、鍵JSONを `GOOGLE_SERVICE_ACCOUNT_JSON` に入れる |
| テスト購入 | `APPLE_ACCEPT_SANDBOX` は明示が必要（未設定＝拒否）。本番は審査中だけ `1`、承認後は `0`。サンドボックス購入は**無償コインとしてのみ付与**（有償ロット・負債の精算・初回ボーナスなし、資金決済法の集計外）。TestFlight はステージングに向ける | `GOOGLE_ACCEPT_TEST`：staging は 1、**production は 0**（lint が確認します） |

## 5. 変数とシークレットの一覧（環境ごと）

**変数**は `wrangler.toml` の `[env.<env>.vars]` に書きます（gitに入ります）。**シークレット**は書かずに、次のコマンドで1つずつ入れます（値はCIに渡さない）。

```bash
npx wrangler secret put TICKET_SECRET --env staging
```

| 名前 | 種類 | staging | production | 内容 |
|---|---|---|---|---|
| `ENVIRONMENT` | 変数 | `staging` | `production` | 環境名。`DEV_MODE` の拒否に使う |
| `VERIFIER_URL` | 変数 | Cloud Run の URL | Cloud Run の URL | https 必須 |
| `FIREBASE_PROJECT_ID` | 変数 | 必須 | 必須 | IDトークンの `aud` |
| `VERIFY_SAMPLE_RATE` | 変数 | `0.2` | `0.05` | 抜き取りで検証するレースの割合 |
| `APPLE_BUNDLE_ID` / `APPLE_ACCEPT_SANDBOX` | 変数 | 必須 / `1` | 必須 / `1` | |
| `GOOGLE_PACKAGE_NAME` / `GOOGLE_ACCEPT_TEST` | 変数 | 必須 / `1` | 必須 / **`0`** | |
| `GOOGLE_PUBSUB_AUDIENCE` / `GOOGLE_PUBSUB_SERVICE_ACCOUNT` | 変数 | 必須 | 必須 | RTDN の認証 |
| `FCM_PROJECT_ID` | 変数 | 必須 | 必須 | |
| `REPLAY_RETENTION_DAYS` | 変数（任意） | | | 指定時はマスターの保存日数を上書き |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` / `ACCESS_ROLES` | 変数（任意） | | | 管理APIを Cloudflare Access で守る場合 |
| `ADMIN_CONSOLE_ORIGINS` | 変数（任意） | | | 運用コンソールのオリジン（カンマ区切り、例 `https://ops-staging.example.com`）。未設定なら CORS なし（`docs/ops/console.md`） |
| `TICKET_SECRET` | シークレット | 必須 | 必須 | レース入場チケットのHMAC鍵（32バイト以上のランダム値） |
| `VERIFIER_TOKEN` | シークレット | 必須 | 必須 | Cloud Run の `verifier-auth-secret` と**同じ値** |
| `ADMIN_TOKENS` | シークレット | 必須 | 必須 | `[{"name","role","sha256"}]`。トークンそのものではなくSHA-256を入れる |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | シークレット | 必須 | 必須 | Play Developer API（とFCMの代わり） |
| `KPI_SALT` | シークレット | 必須 | 必須 | 分析用のプレイヤーIDハッシュの塩。**途中で変えると継続率が途切れる** |
| `FCM_SERVICE_ACCOUNT_JSON` | シークレット（任意） | | | 未設定なら `GOOGLE_SERVICE_ACCOUNT_JSON` |
| `KPI_SQL_ACCOUNT_ID` | 変数（任意） | | | Round 18（§51）：個人データのダウンロードに、そのプレイヤーの分析イベント（Analytics Engine）を入れるためのアカウント ID。シークレットではない |
| `KPI_SQL_TOKEN` | シークレット（任意） | | | 同上。権限「Account Analytics: Read」だけの API トークン。2つとも無ければダウンロードの分析イベントは「取得できませんでした」 |
| `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON` | シークレット（任意） | 推奨 | 推奨 | 引き継ぎコード（§54）のカスタムトークンに署名する、その環境の Firebase プロジェクトのサービスアカウントの鍵 JSON。未設定なら引き継ぎコードは `enabled: false`。入れ替えは §9.6 |
| `CHEERS` | 変数（任意） | | | Round 19（§55）：`off` で観戦中の応援を止める（部屋が案内を出さない）。未設定ならオン |
| `DEV_MODE` | — | **禁止** | **禁止** | local の `--var DEV_MODE:1` だけ |

管理トークンのハッシュは次で作ります（トークン本体はパスワード管理ツールに保管）。

```bash
printf '%s' '<管理トークン>' | sha256sum
```

## 6. GitHub の設定

1. **Settings → Environments** に `staging` と `production` を作る。
   - `production`：**Required reviewers** を設定し、Deployment branches を `main`（とリリースタグ）に限定する。
2. 各環境に設定する値：

| 種類 | 名前 | 内容 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` | §1-5 |
| Variable | `GCP_PROJECT`、`GCP_REGION` | 例：`muchi-staging`、`asia-northeast1` |
| Variable | `GCP_WIF_PROVIDER`、`GCP_DEPLOY_SA` | §3-5, 6 |
| Variable | `VERIFIER_RUNTIME_SA`、`VERIFIER_MAX_INSTANCES` | §3-3、`3` / `20` |
| Variable | `API_BASE_URL` | `https://api-staging.<ドメイン>` |
| Variable | `FIREBASE_WEB_API_KEY` | §2-4 |
| Variable | `SMOKE_ENABLED` | staging は `true`、production は通常 `false`（本番にテスト用プレイヤーを作らないため） |

3. **リポジトリ変数** `DEPLOY_STAGING_ENABLED=true` を設定すると、`main` への push で CI が通ったあとに staging へ自動デプロイされます。それまでは自動デプロイは動きません（`REPLACE_ME` が残っていると lint で止まるため）。

## 7. デプロイの流れ

| ワークフロー | きっかけ | 内容 |
|---|---|---|
| `deploy-staging` | CI 成功後（`main` への push）・手動 | 下の4段階を staging に |
| `deploy-production` | 手動（コミットSHAかタグを指定）＋承認 | 同じ4段階を production に |

1. **gate**：C#とサーバーのテスト、ゴールデンファイルの差分確認（C#とTSの共有仕様のズレ検知）、`npm run lint:deploy -- --env <env>`。
2. **verifier**：コンテナをビルドして Artifact Registry に push（ダイジェスト固定）、Cloud Run に反映、`/healthz` が通ることと、認証なしの `/verify` が 401 になることを確認。
3. **worker**：`wrangler.toml` の `VERIFIER_URL` と Cloud Run の URL の一致を確認、`wrangler secret list` で必要なシークレットが揃っていることを確認、`wrangler deploy --env <env>`。
4. **smoke**：`/v1/health` と `/v1/config` を確認。`SMOKE_ENABLED=true` なら、匿名の Firebase ユーザーでボット（`engine/Muchi.Bot`）がチュートリアルレースと1人のランク戦（検証サーバーで確定）を走らせる。

### 7.1 検証サーバーと Worker の順番（Round 13 で一本化）

**いつも「検証サーバー（verifier）→ Worker」の順**。ワークフローの `worker` は `needs: verifier` なので、この順は自動で守られる。手で出す時・切り戻す時もこの順を守る。

| 変更 | 新しい側が古い側と組んだ時 | この順で安全な理由（コード） |
|---|---|---|
| Round 11 `skillsFired`（検証サーバーの出力に足したキー） | 新しい検証サーバー × 古い Worker：古い Worker の出力スキーマは厳密（`verifierOutputSchema` は `.strict()`）なので、知らないキーが来るとすべての検証が失敗する | **`skillsFired` は頼まれた時だけ返す**（Round 13）。Worker の `HttpVerifierClient` がヘッダー `X-Muchi-Verify-Skills: 1` を付けた時だけ、検証サーバー（`VerifyService.WantsSkills`）が `skillsFired` を足す。古い Worker は頼まないので、検証サーバーを先に出しても壊れない。新しい Worker × 古い検証サーバーでは `skillsFired` が来ないだけ（スキーマで任意、スキルの実績は数えない） |
| Round 13 週替わりチャレンジのレースの種類 `challenge` | 新しい Worker × 古い検証サーバー：古い検証サーバーは `mode: "challenge"` を知らず 400 を返す → 送信は `VERIFIER_UNAVAILABLE`（セッションは `wchAbort` で戻り、もう一度送れる） | 検証サーバーが先なので、Worker が `challenge` を送る時には検証サーバーはもう知っている |
| Round 14（殿堂 §34・勝負服エディタ §35・実況パック §36・マイリプレイ §37） | 組み合わせの問題なし：4つとも検証サーバー（`engine/Muchi.Verifier`・`Muchi.Engine`）とその入出力を変えない（変わるのは Worker・`Muchi.Client`・プロトタイプ・Unity のゲーム層だけ）。マイリプレイの保存は既存の R2 `REPLAYS` バインディングの別の接頭辞 `myreplays/`、殿堂の写しは既存の DirectoryDO の新しい表（起動時に `CREATE TABLE IF NOT EXISTS`）で、新しいバインディング・シークレット・マイグレーションは無い | いつもの「検証サーバー → Worker」の順のまま。特別な順番は要らない（4つのブランチのどれも別の順を求めていない、Round 14 の統合で確認） |
| Round 15（フォトモード §38・出走前アドバイス §39・アクティビティ §40・アクセシビリティ §41） | 組み合わせの問題なし：4つとも検証サーバー（`engine/Muchi.Verifier`・`Muchi.Engine`・`Muchi.Net`）とその入出力・ゴールデンを変えない（Round 15 の統合で差分なしを確認）。新しいのは Worker の API（`/v1/photo/catalog`・`/v1/photos`・`/v1/races/advice`・`/v1/activity`・`/v1/settings/accessibility`）と、プレイヤーのオブジェクトの状態のキー（`photos`・`activity`・`accessibility`、無ければ既定値）、同梱のマスター `server/master/photo.json`、任意のリモート設定 `progression.activity`。wrangler のバインディング・シークレット・マイグレーションは増えない（マイリプレイの公開で各フレンドに書くアクティビティも既存の PlayerDO 呼び出し） | いつもの「検証サーバー → Worker」の順のまま（検証サーバーは出し直さなくてよい）。古いアプリは新しいキー（`accessibility`・`activity` のバッジ、写真の `replaySaved`）を読み飛ばすだけ。切り戻しで Worker を戻すと保存済みの写真の記録・アクティビティ・アクセシビリティ設定は状態に残り、出し直すとまた見える |
| Round 16（プレイヤー主催カップ §42・シーズンの振り返り §43・厩舎の整理 §44・次にやること §45） | **カップだけが組み合わせを持つ**：レースの種類 `cup`（`RaceMode.Cup = 7`、`Muchi.Net.ProtocolCodec` が `"cup"` を読む）。新しい Worker × 古い検証サーバー：古い検証サーバーは `mode: "cup"` を知らず検証を断る → カップのレースが無効（`raceTimeoutMinutes` の後に無効として次へ）になる。Worker 側は新しい Durable Object **`CupDO`（マイグレーション `v6`、`new_sqlite_classes`）とバインディング `CUPS`**（`wrangler.toml` の既定・`env.staging`・`env.production` の3つすべてにある。`npm run lint:deploy` が確かめる）。振り返り・厩舎の整理・次にやることは検証サーバーもバインディングも変えない（プレイヤーのオブジェクトの状態のキー `seasonRecap`・`roster`・`nextAction`、任意のリモート設定 `progression.seasonRecap`・`nextActions`・`hostedCups`、プッシュの型 `cup_invite`）。既存のモードの結果・ゴールデンは変わらない（Round 16 の統合で差分なしを確認） | **検証サーバー → Worker（マイグレーション `v6` 付き）**：`wrangler deploy` がマイグレーションを当てるので、Worker を出した時に `CupDO` ができる。検証サーバーが先なので、最初のカップのレースの時には検証サーバーはもう `cup` を知っている。切り戻し：Worker のコードを `CupDO` の無い版に戻すと、当たったマイグレーションのクラスが見つからず `wrangler deploy` が断る。カップを止めたい時は `progression.hostedCups.enabled: false` をリモート設定で出す（作成・参加は `NOT_FOUND`、走っているカップは締め切りで終わる）。`CupDO` を本当に消す時は `deleted_classes` のマイグレーション（`v7`）を足して出す |
| Round 17（メンテナンス・強制アップデート §46・通報とブロック §47・ヘルプセンター §48・おすすめフレンド §49） | 検証サーバー（`engine/Muchi.Verifier`・`Muchi.Engine`・`Muchi.Net` のレースの計算）とその入出力・ゴールデンは変わらない（Round 17 の統合で差分なしを確認）。**組み合わせがあるのはレースの `hello` の `engine`（§46、REQ-MNT-008）だけ**：新しいアプリは `hello` に `engine` を付けるが、古い Worker の部屋のスキーマは厳密なので `BAD_MESSAGE` で断られる（古いアプリ × 新しい Worker は問題なし：`engine` は任意、ヘッダー `x-client-*` の無い要求は検査を通る）。**マイグレーションは無い**：Durable Object のクラス・バインディング・シークレットは増えない。新しい表は最初の呼び出しで `CREATE TABLE IF NOT EXISTS`：IntegrityDO（`global`）の `player_reports`・`player_report_reporters`・`player_report_seq`（§47）、OpsDO の `inquiries`（§48、本文は持たない索引）、DirectoryDO の `fsug_cards`（§49）。アカウント削除の段 `reports`・`inquiries`（`cups` の後、`finalize` の前。途中の削除は再開時にその段から続く）。任意のリモート設定 `maintenance`（§46）・`help`（§48）・`progression.reports`・`progression.friendSuggest`。サポートサイトのホスト `help.config.supportSiteHost` は仮の値（`support.muchi-issen.example`）のまま：本番の前に実際のホストへ差し替える。古いアプリは新しいアクティビティの種類 `ops_notice`（行き先 `safety`）・`inquiry_answered`（行き先 `help_inquiry`）を知らない種類として表示するだけ | **検証サーバー → Worker → ストアのアプリ**の順（検証サーバーは出し直さなくてよいが、順は変えない。`hello.engine` を知る Worker が先、`engine` を送るアプリが最後）。**切り戻し**：Worker を Round 17 より前に戻すときは、**先に `maintenance`（と `help`）を含まない版へリモート設定を切り戻してから** Worker を戻す（古い Worker のリモート設定のスキーマは厳密なので、その版を読めず `CONFIG_INVALID` になり、最後に読めた版か同梱の既定に戻ってしまう）。メンテナンスの窓の取り消しは ops コンソール（§46.6、窓の `cancelledAtMs`）で、Worker の出し直しは要らない。Round 17 のアプリが出た後は Worker を Round 17 より前に戻さない。戻した Worker では通報・問い合わせの索引・おすすめのカードの表は残り（読まれないだけ）、出し直すとそのまま続く |
| Round 18（練習レース §50・個人データの開示 §51・支部の定型チャット §52・馬ごとの目標 §53） | 検証サーバーのレースの計算・入出力・ゴールデンは変わらない（Round 18 の統合で差分なしを確認）。練習は端末の中だけで走り、サーバーに結果を送る経路も新しいレースの種類も無い（`Muchi.Net.ProtocolCodec` は読み取りの関数を分けただけで、読む形は同じ）。**マイグレーション・Durable Object のクラス・バインディングは増えない**。§51 のファイルは既存のバケット `REPLAYS`（`muchi-replays-*`）の非公開の接頭辞 `private/data-export/<playerId>/` に置く：**リリースの前に R2 のライフサイクルルール**（接頭辞 `private/data-export/`、作成から `keepDays + 1` 日 = 8 日で削除。§2 の手順）を staging・production の両方に付ける（アプリはプレイヤーのアラームで `keepDays` に消すので、ルールは予備）。ダウンロードのリンクの HMAC は既存の `TICKET_SECRET` に目的の文字列を足した鍵で署名する：**新しい必須のシークレットは無い**（`TICKET_SECRET` を変えると出ているリンクが切れるだけ）。任意で `KPI_SQL_ACCOUNT_ID`（変数）・`KPI_SQL_TOKEN`（`wrangler secret put KPI_SQL_TOKEN --env …`、権限は Account Analytics: Read だけ。値はリポジトリに書かない）：無ければエクスポートの分析イベントは「取得できませんでした」。新しいプレイヤーの状態のキー `horseGoals`・`dataExport`（無ければ既定）、TeamDO のフィードに `qchat` の項目と `qchat` の数・ブロックの写し、同梱のマスター `server/master/practice.json`・`quick-chat.json`（起動時に検査）、任意のリモート設定 `progression.horseGoals`・`progression.dataExport`・`quickChat`。アカウント削除の段 `data_export`（`inquiries` の後、`finalize` の前）。§51 の要求・状態・ダウンロードはメンテナンスの窓でも止まらない（§46.2）。古いアプリは新しいアクティビティの種類 `qchat_mention`（行き先 `team_feed`）・`data_export_ready`（行き先 `privacy`）と、フィードの `qchat` の項目を知らない種類として読み飛ばす | **検証サーバー → Worker → ストアのアプリ**（検証サーバーは出し直さなくてよい）。順番の前に R2 のライフサイクルルールを付ける。**切り戻し**：Worker を Round 18 より前に戻すときは、先に `quickChat`・`progression.dataExport`・`progression.horseGoals` を含まない版へリモート設定を切り戻す（古い Worker のスキーマは厳密）。戻した Worker では `private/data-export/` のファイルを誰も消さないので、ライフサイクルルールが消す（8 日）。フィードの `qchat` の項目は古い TeamDO が知らない種類として残り、出し直すとまた見える |
| Round 19（引き継ぎコード §54・観戦中の応援 §55・画質・通信量 §56・ヒント §57） | 検証サーバーのレースの計算・入出力・ゴールデンは変わらない（`Muchi.Engine` は変わらず、`Muchi.Net` には観戦者の部屋の応援のメッセージ（`CheerWire`・`LockstepClient.SendCheer`）を足しただけで検証サーバーは使わない。Round 19 の統合でゴールデンの差分なしを確認）。**部屋の組み合わせ（§55.3）**：新しいアプリ × 古い Worker：古い部屋は観戦者の `start.spectator.cheer` を出さないので、アプリは `cheer` を送らない（ボタンを出さない）。古いアプリ × 新しい Worker：選手・観戦者に届く `{"t":"cheers"}` は古い `LockstepClient` が `UNKNOWN_MESSAGE` として記録するだけ（致命的なエラーの一覧 `FatalRoomErrors` に無い、切断しない）。応援は環境変数 `CHEERS = "off"` で止められる（部屋が案内を出さなくなる）。**マイグレーション・Durable Object のクラス・バインディングは増えない**：DirectoryDO の新しい表 `transfer_codes`・`transfer_limits`・`transfer_audit`（最初の呼び出しで `CREATE TABLE IF NOT EXISTS`）、応援の集計は既存の R2 `REPLAYS` の `replays/<raceId>.cheers.json`（リプレイのログの隣、数だけ・id なし）。**任意のシークレット `FIREBASE_AUTH_SERVICE_ACCOUNT_JSON`**（環境ごとにその環境の Firebase プロジェクトの鍵、§9.6。`wrangler secret put FIREBASE_AUTH_SERVICE_ACCOUNT_JSON --env …`。値はリポジトリに書かない）：無ければ引き継ぎコードは `enabled: false`（Apple／Google の引き継ぎだけ）。新しいプレイヤーの状態のキー `tips`・`transfer`（無ければ既定）、同梱のマスター `server/master/tips.json`（起動時に検査）、任意のリモート設定 `tips`・`progression.transfer`、アセットのカタログの任意の `low`（軽量版、古いアプリは読み飛ばす）。§56 の設定は端末だけでサーバーの状態は無い。引き継ぎコードの API（`/v1/transfer/*`）はメンテナンスの窓でも止まらない（§46.2、サインイン・削除と同じ）。アカウント削除は既存の段 `stud`（DirectoryDO の `forget`）が引き継ぎコードと記録も消す（新しい段は無い）。古い端末の締め出し `401 SESSION_REPLACED`（§54.6）：古いアプリはトークンを取り直して1回だけ再試行し、そのあと `UNAUTHORIZED` として扱う（引き継ぎは新しい端末で新しいアプリが使うので、古い端末のアプリが古くても締め出し自体は効く） | **検証サーバー → Worker → ストアのアプリ**（検証サーバーは出し直さなくてよい。応援の部屋のメッセージは Worker が先に知っていればよく、検証サーバーとの順は関係しない）。シークレットは Worker を出す前に入れる（入れなくても出せる：引き継ぎコードが出ないだけ）。**切り戻し**：Worker を Round 19 より前に戻すときは、先に `tips`・`progression.transfer` を含まない版へリモート設定を切り戻す（古い Worker のスキーマは厳密）。戻した Worker では発行済みの引き継ぎコードは使えない（表は残り、出し直すとまた使える。期限は変わらず進む）。古い端末の締め出しも効かなくなるので、引き継ぎの直後に戻すことは避ける |
| Round 20（広告・分析の同意 §58・レビュー依頼 §59・クライアントのエラー報告 §60・端末のローカル通知 §61） | 検証サーバーのレースの計算・入出力・ゴールデンは**変わらない**（`LockstepClient` に足したのはズレを知らせるイベントと `RaceId` だけ）→ **検証サーバーは出し直さなくてよい**。Worker 側で増えるもの：Durable Object **`ClientErrorsDO`（マイグレーション `v7`、`new_sqlite_classes`）とバインディング `CLIENT_ERRORS`**（`wrangler.toml` の既定・`env.staging`・`env.production` の3つすべて。`npm run lint:deploy` で確認）。新しい経路：`GET`／`PUT /v1/privacy/choices`・`PUT /v1/privacy/platform`・`POST /v1/privacy/prompt-shown`・`POST /v1/client-errors`（どれも門で止めない、§46）、`/v1/review-prompt*`（`core`）。状態のキー `privacyChoices`・`reviewPrompt`（無ければ既定）、プッシュの種類 `reminders`（既定オフ）、同梱の規則 `progression.reviewPrompt`・`progression.clientErrors`・`progression.localNotifications`（起動時と各リモート設定の版で検査）。シークレットは増えない。**組み合わせ**：新しいアプリ × 古い Worker：プライバシー・レビューの経路が 404 → 端末は事前の画面・レビューを出さず、広告は非パーソナライズ（安全な側）、`CLIENT_ERRORS` が無ければエラー報告は `{ accepted: 0, enabled: false }` で送るのをやめる、`localReminders` が無ければローカル通知を予約しない。古いアプリ × 新しい Worker：古いアプリは `attachPlayer: true` を送るが、サーバーが分析の選択を確かめて id を残さないことがある（§60.6）。`PUT /v1/push/preferences` に知らない種類を送ると 400（古いアプリは知っている種類だけ送る）。 | **`v7` のマイグレーションは、それを使う Worker と同じ `wrangler deploy` で先に当たる**（マイグレーションを含む版の Worker を出すこと。`CLIENT_ERRORS` を参照する Worker を `v7` の無い設定で出してはいけない）。順番：**（検証サーバーはそのまま）→ Worker（`v7` 付き、staging → production）→ ストアのアプリ**。**アラート**：`client_error_spike` は Worker のログの1行（`{"alert":"client_error_spike",…}`）。環境ごと（staging・production）に Cloudflare の Workers Logs（または Logpush 先）でこの文字列の通知を作る（staging は運用チャンネル、production は当番）。閾値は `progression.clientErrors.spikeMinCount`・`spikeWindowHours`（リモート設定）で変える。**止めるだけ**：`progression.clientErrors.enabled: false`・`progression.reviewPrompt.enabled: false`・`progression.localNotifications.enabled: false`（端末は予約を全部取り消す）をリモート設定で。**切り戻し**：Worker を Round 20 より前に戻す時は、先にリモート設定を `progression.reviewPrompt`・`clientErrors`・`localNotifications` を含まない版へ戻す（古い Worker は知らない `progression` のキーで落ちる）。`ClientErrorsDO` の無い版へは `wrangler deploy` が断る（クラスの削除には別のマイグレーション `v8` が要る）ので、戻すなら `ClientErrorsDO` を残したまま。状態の `privacyChoices`・`reviewPrompt`・`reminders` は古い Worker では使われずに残るだけ（古い Worker は KPI を分析の選択で絞らないので、戻した間はオフの人の任意の KPI も書かれる。長く戻すなら運用に知らせる）。上のカップの行で「`v7`」と書いた `CupDO` の削除のマイグレーションは、今後足すなら `v8` |
| Round 21（トレーナーカード §62・ディープリンクと再戦 §63・アップデートのお知らせ §64・予定表 §65） | 検証サーバーのレースの計算・入出力・ゴールデンは**変わらない**（再戦は既存のフレンド部屋の作り方で新しい部屋を作るだけで、レースの種類は増えない。R21 の統合でゴールデンの差分なしを確認）→ **検証サーバーは出し直さなくてよい**。**マイグレーションは無い**（`v8` は使わず予約のまま。Durable Object のクラス・バインディング・シークレットは増えない）：§63 のリンクと参照の上限は DirectoryDO の新しい表 `links`・`link_limits`、再戦の申し出は MatchmakerDO の既存の表 `mm_rows` の行（新しい表は最初の呼び出しで `CREATE TABLE IF NOT EXISTS`）。新しいプレイヤーの状態のキー `showcase`・`releaseNotes`・`calendar`（無ければ既定。§51 の分類済み）、同梱のマスター `server/master/showcase.json`・`release-notes.json`（起動時と各リモート設定の版で検査）、任意のリモート設定 `showcase`・`releaseNotes`・`progression.links`、§61 のローカル通知の新しい種類 `calendar_mark`（`progression.localNotifications.kinds`・`leadHours.calendar_mark`）。新しい経路：`/v1/showcase*`・`/v1/links`（`social`）、`/v1/friend-rooms/rematch/:raceId`（`ranked`）、`/v1/release-notes*`・`/v1/calendar*`（`core`）、`POST /v1/links/resolve`（止めない）、`/v1` の外の `GET /l/:token`・`/.well-known/apple-app-site-association`・`/.well-known/assetlinks.json`（門の外）。アカウント削除は既存の段 `stud`（DirectoryDO の `forget`）がリンクも消す（新しい段は無い）。**組み合わせ**：新しいアプリ × 古い Worker：新しい経路が 404 → カード・予定表・アップデート情報は出さない（オフラインと同じ文）、リンクは「開けません」、再戦のボタンは出ない。古いアプリ × 新しい Worker：古いアプリは `calendarMarks`・新しいローカルの種類・`showcase` の写しを読み飛ばす（`localReminders.config.kinds` の知らない種類は予約しない）。 | **（検証サーバーはそのまま）→ Worker（staging → production）→ ストアのアプリ**。**本番の前に**（docs/ops/deep-links.md）：① リンクの本物のホストを決め、`progression.links.baseUrl` をリモート設定で差し替え、`wrangler.toml` の `routes` にそのホストを足す（仮の `link.muchi-issen.example` のまま出さない）。② Apple のチーム ID と Bundle ID（`progression.links.apple.appIds`、仮の `ABCDE12345.com.example.muchi` を置き換える）。③ Android のパッケージ名と、Play のアプリ署名鍵とアップロード鍵の SHA-256 の指紋（`progression.links.android.sha256CertFingerprints`）。値はリポジトリに書かずリモート設定で入れ、`/.well-known/*` を本番のホストで開いて確かめる（Apple の CDN はキャッシュするので、アプリの提出より前に）。④ **Codex のネイティブの設定**（docs/handoff-codex-round21-deep-links.md §1）：iOS の Associated Domains（`applinks:<LINK_HOST>`）とスキーム `muchi`、Android の `intent-filter`（`autoVerify`）とインストールリファラー。これが入るまでアプリはリンクを受け取れない（Web の案内のページとコードの手入力だけ）。**止めるだけ**：`progression.links.enabled: false`（作成は止まり、開くと `unavailable`）、`showcase.config.enabled`・`releaseNotes.config.enabled: false`、予定表の通知は `progression.localNotifications.kinds` から `calendar_mark` を外す。**切り戻し**：Worker を Round 21 より前に戻す時は、先にリモート設定を `showcase`・`releaseNotes`・`progression.links` と `localNotifications` の `calendar_mark` を含まない版へ戻す（古い Worker のスキーマは厳密）。戻した Worker では出したリンクは開かず（表は残り、出し直すとまた開く。期限は進む）、`/.well-known/*` が 404 になるので、ユニバーサルリンクは Web の案内に落ちる。状態の `showcase`・`releaseNotes`・`calendar` は使われずに残るだけ |
| Round 23（ログイン中の端末とセキュリティ §70・血統図と系統 §71・レースの見どころ §72・お問い合わせ履歴 §73。R23 統合で1行に） | 検証サーバーのレースの計算・入出力・ゴールデンは**変わらない**（R23 の統合でゴールデンと `contracts/highlights.vectors.json` の差分なしを確認）。§72 は `Muchi.Engine` に見どころの検出（`Highlights.cs`、リプレイのログを端末で再計算して選ぶだけ）と検証サーバーに `highlights` のベクトルの書き出しを足したが、`/verify` の計算・入出力は同じ → **検証サーバーは出し直さなくてよい**（出し直しても同じ結果）。**マイグレーションは無い**（`v10` は使わない。`v9` は Round 22 の予約。Durable Object のクラス・バインディング・シークレットは増えない）：§73 の運営のデスクは OpsDO の新しい表 `inquiry_desk`・`inquiry_notes`（最初の呼び出しで `CREATE TABLE IF NOT EXISTS`）。新しいプレイヤーの状態のキー `devices`（無ければ空。§51 の `account`）、馬の `lineage`（§71、生まれた時の親の写し。新しく生まれた仔だけに書く。§51 の `horses` の中、移行なし）、チケットの欄（`help.tickets` の状態・返信・`reopens`・`compensation`、無ければ既定）。同梱のマスター `server/master/bloodlines.json`（起動時に検査）、`help.json` の `config.tickets`・`replyTemplates`、push.json のテンプレート `inquiry_reply`（カテゴリ `gifts`）、同梱の規則 `progression.devices`（起動時と各リモート設定の版で検査）。新しい経路：`/v1/account/devices*`・`GET /v1/account/security-log`・`POST /v1/help/inquiries/:ticketId/messages`（どれも門で止めない、§46）、`GET /v1/horses/:horseId/pedigree` の欄の追加・`GET /v1/breeding/pedigree`・`GET /v1/bloodlines`（`core`）、§63 のリプレイのリンクの任意の `startTick`、運営の `/v1/admin/players/:playerId/devices*` と問い合わせのデスク。**セッションの検査が PlayerDO の新しいメソッド `sessionState` を読む**（Worker と PlayerDO は同じスクリプトなので同じ `wrangler deploy` で入れ替わる。`transferCutoff` は残してある）。アカウント削除は既存の段 `inquiries` がデスクの担当・内部メモも消し、既存の段 `stud`（DirectoryDO の `forget`）が `startTick` 付きのリンクも消す（新しい段は無い）。**組み合わせ**：新しいアプリ × 古い Worker：新しい経路が 404 → 端末・血統図の追加の欄・系統・返信の入口を出さない、リンクの `startTick` は 400 になるので付けずに作り直す（見どころの再生とカードは端末だけで動く）、`SESSION_REVOKED` は来ない。古いアプリ × 新しい Worker：古いアプリはチェックインしないので一覧に出ない（「この端末以外をすべてログアウト」は一覧に無い古いセッションも無効にする）。**古いアプリは `SESSION_REVOKED` を知らない**：知らない 401 としてトークンを1回取り直し、同じ 401 で止まる（遊べない・説明の画面も出ない）。古いアプリはリンクの `startTick` を読み飛ばして最初から再生し、チケットの知らない状態 `in_progress`・`resolved` を `received`・`closed` として見せるだけ（§73.1）。 | **（検証サーバーはそのまま）→ Worker（staging → production）→ ストアのアプリ**。**`SESSION_REVOKED` は遅らせて案内する**：ストアのアプリ（`SESSION_REVOKED` の画面を持つ版）が行き渡るまで、ログイン中の端末の入口（設定・ヘルプ・ヒント）を案内しない／`progression.devices.enabled: false` で出しておき、行き渡ってから true にする（古いアプリの端末をログアウトすると、その端末は説明なしに止まるため）。**止めるだけ**：`progression.devices.enabled: false`（一覧は `enabled: false`、ログアウトは 404。**出したログアウトは効き続ける**＝無効化の判定は設定に関係しない）、`help.config.tickets.pushOnReply: false`（返信のプッシュ）、`progression.links.enabled: false`（リンク全体）。**切り戻し**：Worker を Round 23 より前に戻す時は、先にリモート設定を `progression.devices`・`help` の `config.tickets`／`replyTemplates` を含まない版へ戻す（古い Worker のスキーマは厳密）。戻した Worker は無効化を見ないので、**ログアウトした端末がまた使えるようになる**（運用に知らせ、乗っ取りの対応中のアカウントは BAN や引き継ぎの取り消しで守る）。状態の `devices`・馬の `lineage`・チケットの新しい欄と OpsDO の `inquiry_desk`・`inquiry_notes` は使われずに残るだけ（出し直すとまた見える） |
- **切り戻しは逆の順**：Worker を先に戻し、そのあと必要なら検証サーバーを戻す。検証サーバーだけを Round 13 より前に戻すと、週替わりチャレンジの送信が `VERIFIER_UNAVAILABLE` になる（その間は `progression.weeklyChallenge.enabled: false` をリモート設定で出しておく）。
- Round 11 より前の Worker が動いている環境（Round 11 を一度も出していない環境）でも、この順で出せる（上のとおり `skillsFired` は頼まれた時だけ）。Round 11 の時点の検証サーバー（いつも `skillsFired` を返す版）が動いている環境で Worker を Round 11 より前に戻すことはしない。
- 確認：`bash scripts/integration.sh`（C# のボット ⇄ TS のサーバー ⇄ C# の検証サーバー）が、ヘッダーの往復と `challenge` を含めて通ること。`integration.sh` は `server/wrangler.toml` の既定の設定で `wrangler dev` を起こすので、`CupDO`（`v6`）と `CUPS` も一緒に立ち上がる（Round 16）。

手元での確認：

```bash
cd server && npm run lint:deploy -- --env production --allow-placeholders
```

```bash
docker build -f engine/Muchi.Verifier/Dockerfile -t muchi-verifier engine
```

### 7.2 メンテナンスの窓を使うデプロイ（Round 17、contracts/protocol.md §46.7）

ふつうのデプロイ（§7.1 の順）は**メンテナンスを入れずに**出す。古い Worker と新しい Worker が数十秒混ざっても壊れない変更がほとんどだから。窓を使うのは、混ざると困る変更だけ：

- DO のデータの形を変える移行で、古い Worker が新しい形を読めないもの（wrangler のマイグレーションで新しいクラスを足すだけなら不要）
- ストアの設定・商品 ID の切り替えなど、途中の購入の扱いが変わるもの
- ルールセットのエンジンの水準（`ENGINE_LEVEL` / `EngineInfo.Level`）を上げる変更（ランク戦の待ち行列を空にしてから出す）

手順：
1. 運用コンソールの「メンテナンス」で窓を予定する（範囲はその変更が触るグループだけ。全部止める時だけ「すべて」）。お知らせはふつう24時間前から自動で出る。日英のメッセージが必須。
2. 窓が始まったら（`GET /v1/maintenance` の `active` を確認）、§7.1 の順に「検証サーバー → Worker」で出す。購入レシート・ストア通知・退会・進行中のレースの確定は窓の中でも通るので、止める必要はない。
3. smoke（`/v1/health`・`/v1/config`）を確認し、窓を「今すぐ終える」で閉じる（または終わりの時刻を待つ）。
4. 切り戻しも窓の中で逆の順（Worker → 検証サーバー）。必要なら窓を延ばすのではなく、新しい窓を続けて予定する（窓は重ねられない）。
5. お詫びを配る時は「補填の承認」から、題名「メンテナンスのお詫び」（`ops_compensation_maintenance`）で。無償コイン・アイテムだけ（有償コインは配らない）、既存の上限と2人ルールのまま。

強制アップデート（対応バージョンの最低）を上げるのは、新しいアプリがストアの審査を通って配信が始まった**後**。先に上げると、まだ更新できない人が締め出される。

## 8. 初回デプロイのチェックリスト

- [ ] §1〜§4 のアカウントとリソースを作った（staging から）
- [ ] `wrangler.toml` の `REPLACE_ME` を全部埋めた（`npm run lint:deploy -- --env staging` がエラーなし）
- [ ] Worker のシークレットを全部入れた（§5）。`VERIFIER_TOKEN` と Cloud Run の `verifier-auth-secret` が同じ値
- [ ] GitHub の環境・変数・シークレットを設定した（§6）
- [ ] `deploy-staging` を手動実行 → 4段階すべて成功
- [ ] 初回の Cloud Run URL を `VERIFIER_URL` に入れてコミット → 再実行で一致確認が通る
- [ ] Apple/Google のサーバー通知のテスト送信が 200 で返る
- [ ] 管理APIで `GET /v1/admin/config` が見える（`ADMIN_TOKENS`）
- [ ] KPI：数分後に Analytics Engine に行が入っている（`docs/ops/kpi-queries.md`）
- [ ] 費用アラート（Cloudflare 通知、GCP 予算アラート）を設定した
- [ ] 本番も同じ手順。`GOOGLE_ACCEPT_TEST=0`、`SMOKE_ENABLED=false`、`production` 環境に承認者を設定
- [ ] 本番の初回デプロイ前に、弁護士レビュー（規約・特商法・資金決済法・ガチャ表示）が済んでいる

## 9. 切り戻し

| 何を戻すか | 方法 | 速さ |
|---|---|---|
| ゲームの調整値・ガチャ・マスター | 管理APIでリモート設定を前の版に戻す（`POST /v1/admin/config/rollback`）。アプリ更新もデプロイも不要 | 数十秒（キャッシュ30秒） |
| Worker のコード | `npx wrangler rollback --env production`（直前のバージョンへ）。または `deploy-production` を前のSHAで実行 | 1分程度 |
| 検証サーバー | Cloud Run の前のリビジョンにトラフィックを100%戻す | 1分程度 |

```bash
gcloud run services update-traffic muchi-verifier-production --to-revisions=<前のリビジョン>=100 --region asia-northeast1
```

注意：
- Durable Object の**マイグレーション（`[[migrations]]`）は戻せません**。新しいクラスを追加するデプロイは、staging で十分確認してから本番に出してください。
- ルールセットを変えた場合でも、過去のレースはリプレイログに含まれるルールセットで検証されるので、検証サーバーを戻しても古いレースの検証は壊れません。
- C#エンジンの計算を変える変更は、**新しいルールセットのバージョンと組で**出す（同じバージョンで計算結果が変わると、既存のリプレイの検証が失敗する）。

## 9.5 失敗リスト・禁止勝負服の運用

- **失敗リスト**（REQ-OPS-041）：シーズン締め・支部の報酬・イベント報酬・レース精算・隔離の反映で、自動の再試行を使い切った項目は `GET /v1/admin/dead-letters` に出る。原因を直したら `POST …/:itemId/retry`（operator）、手作業で対応したら `POST …/:itemId/dismiss`（admin、メモ必須）。シーズン締めのあとは `GET /v1/admin/dead-letters/season/<YYYY-MM>` と `…/team/<YYYY-MM>` を確認する。
- **禁止勝負服**（REQ-OPS-040）：公開されている登録服色と照合した一覧を `POST /v1/admin/silks/banned/import` で取り込む（設定の新しい版として登録されるので、`/v1/admin/config/activations` で有効化）。`server/master/banned-silks.json` も同じ内容に更新しておく。
- **リプレイの保存**：「検証で確定」の保留は既定90日で削除される（`progression.replayHoldDays`）。通報・不一致・無効は残る。

## 9.6 引き継ぎコードの鍵（`FIREBASE_AUTH_SERVICE_ACCOUNT_JSON`、REQ-TRF-011、contracts/protocol.md §54.7）

この鍵があると、**どのアカウントにでもサインインできるトークン**を作れる。リポジトリ・CI・チャット・問い合わせのメモに貼らない。パスワード管理ツールと Worker のシークレットにだけ置く。

**最初に入れる**（環境ごと。staging と production で別の Firebase プロジェクト・別の鍵）
1. Google Cloud コンソール（Firebase と同じプロジェクト）→ IAM → サービスアカウントで、引き継ぎ専用のサービスアカウント（例 `muchi-transfer-signer@<project>.iam.gserviceaccount.com`、ロールなし）を作る。カスタムトークンは Worker の中で鍵で署名するだけなので、IAM のロールは要らない（Firebase の管理者 SDK のサービスアカウントの鍵でも動くが、漏れた時の被害が大きいので専用のものを使う）。
2. そのサービスアカウントの「鍵」→「鍵を追加」→ JSON。ダウンロードしたファイルを次で入れ、**ファイルはすぐ消す**：
   ```bash
   npx wrangler secret put FIREBASE_AUTH_SERVICE_ACCOUNT_JSON --env staging < key.json && shred -u key.json
   ```
3. 確かめる：テスト用のアカウントで `GET /v1/transfer/code` が `"enabled": true`。staging で発行 → 別の匿名アカウントで入力 → 返った `customToken` で Firebase にサインインでき、`uid` が元のアカウントになること（Unity の開発ビルド、または curl で発行 → 入力 → Identity Toolkit の `accounts:signInWithCustomToken`（Web API キー）で ID トークンを取り、その `sub` を見る）。

**入れ替え**（90日ごと、担当者が抜けた時、漏れた疑いがある時はすぐ）
1. 同じサービスアカウントに**新しい鍵**を作る（古い鍵はまだ消さない）。
2. `npx wrangler secret put FIREBASE_AUTH_SERVICE_ACCOUNT_JSON --env <env>` で新しい鍵を入れる（Worker の新しい版としてすぐ効く。デプロイの順番 §7.1 には関係しない）。
3. 上の 3 と同じ確認をする。
4. Google Cloud で**古い鍵を削除**する。古い鍵で署名され、まだ使われていないカスタムトークン（有効1時間）はその時点で使えなくなる（入力の途中だった人は「引き継ぐ」をもう一度押せば、同じキーの再送で新しい鍵のトークンを受け取れる）。
5. 監査のため、入れ替えた日と鍵の ID（JSON の `private_key_id`）を運用の記録に残す（鍵そのものは残さない）。

**漏れた時**：すぐに古い鍵を削除（4）→ 新しい鍵（1〜3）。その後、`transfer_redeem` の KPI（`docs/ops/kpi-queries.md`「引き継ぎコード」）とディレクトリの監査で、漏れた期間の `redeemed` を確認する。鍵だけで作ったトークンは引き継ぎコードを通らないので監査に残らない — Firebase の Authentication のログ（カスタムトークンでのサインイン）を期間で確認する。

**止めたい時**：鍵を消さなくても、リモート設定で `progression.transfer.enabled = false` にすれば発行・入力の口が `404` になる（30秒以内に反映、§22）。古い端末の無効化（`cutoffAt`）はそのまま効く。

**Firebase の匿名ユーザーの自動削除**（§2）との関係：カスタムトークンのサインインは、Firebase 側でユーザーが消されていても同じ `uid` で作り直す。ゲームのデータは `uid` の Durable Object にあるので、引き継ぎの後も変わらない。引き継いだ後のユーザーは匿名ではない（自動削除の対象外）。

## 10. 費用のガードレール

- **Cloud Run**：最大インスタンス（staging 3 / production 20）、最小0、リクエスト時のみCPU課金。GCP の予算アラートを月額で設定する。
- **Cloudflare**：Usage Based Billing の通知。Durable Objects は WebSocket 休止で待機中の時間課金がかからない設計。R2 はリプレイの保存期限（日次の削除処理）で容量を抑える。
- **Firebase Auth**：匿名ユーザーの自動削除を有効にする（MAU の節約）。
- **Analytics Engine**：アプリからのイベントは1人あたり毎分30バッチ・1日2,000件まで（サーバー側で制限済み）。
- **マイリプレイ**（REQ-MYRP-*）の保存は `myreplays/<playerId>/<raceId>.json`（1件 ≤ `maxBytes` 256 KiB、1人 ≤ 20件）で、保存期限の削除の対象外。アカウント削除の手順（`replays`）とプレイヤーの削除操作で消える。
- **ゴースト**（タイムアタック）は保存期限の削除対象外なので、シーズンが溜まったら別途整理する（未実装・要対応）。
