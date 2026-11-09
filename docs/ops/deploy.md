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

- **切り戻しは逆の順**：Worker を先に戻し、そのあと必要なら検証サーバーを戻す。検証サーバーだけを Round 13 より前に戻すと、週替わりチャレンジの送信が `VERIFIER_UNAVAILABLE` になる（その間は `progression.weeklyChallenge.enabled: false` をリモート設定で出しておく）。
- Round 11 より前の Worker が動いている環境（Round 11 を一度も出していない環境）でも、この順で出せる（上のとおり `skillsFired` は頼まれた時だけ）。Round 11 の時点の検証サーバー（いつも `skillsFired` を返す版）が動いている環境で Worker を Round 11 より前に戻すことはしない。
- 確認：`bash scripts/integration.sh`（C# のボット ⇄ TS のサーバー ⇄ C# の検証サーバー）が、ヘッダーの往復と `challenge` を含めて通ること。

手元での確認：

```bash
cd server && npm run lint:deploy -- --env production --allow-placeholders
```

```bash
docker build -f engine/Muchi.Verifier/Dockerfile -t muchi-verifier engine
```

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

## 10. 費用のガードレール

- **Cloud Run**：最大インスタンス（staging 3 / production 20）、最小0、リクエスト時のみCPU課金。GCP の予算アラートを月額で設定する。
- **Cloudflare**：Usage Based Billing の通知。Durable Objects は WebSocket 休止で待機中の時間課金がかからない設計。R2 はリプレイの保存期限（日次の削除処理）で容量を抑える。
- **Firebase Auth**：匿名ユーザーの自動削除を有効にする（MAU の節約）。
- **Analytics Engine**：アプリからのイベントは1人あたり毎分30バッチ・1日2,000件まで（サーバー側で制限済み）。
- **マイリプレイ**（REQ-MYRP-*）の保存は `myreplays/<playerId>/<raceId>.json`（1件 ≤ `maxBytes` 256 KiB、1人 ≤ 20件）で、保存期限の削除の対象外。アカウント削除の手順（`replays`）とプレイヤーの削除操作で消える。
- **ゴースト**（タイムアタック）は保存期限の削除対象外なので、シーズンが溜まったら別途整理する（未実装・要対応）。
