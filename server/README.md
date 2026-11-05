# muchi-server（Cloudflare Workers + Durable Objects）

ロジックとサーバー。仕様は [../docs/spec/requirements.md](../docs/spec/requirements.md)、C#との境界は [../contracts/protocol.md](../contracts/protocol.md)。

## コマンド

| コマンド | 内容 |
|---|---|
| `npm test` | vitest（ドメインロジック・HTTP・認証・ゴールデン） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | `wrangler deploy --dry-run`（バンドル確認） |
| `npm run dev` | ローカル実行（`DEV_MODE=1`：偽ストア＋`x-dev-user`ヘッダー） |
| `npm run smoke` | `npm run dev` 中に実行する通しテスト（購入→ガチャ→チュートリアルレース→WebSocket→ランク戦→検証） |
| `npm run gen:golden` | `contracts/golden/ts-config-*.json` を再生成（ルールセット・マスター変更時に必須） |

## 構成

```
src/domain/     純粋ロジック（I/Oなし・時刻と乱数は注入）
  raceRoom.ts     ロックステップ中継（tick確定、遅延入力、切断→CPU、再接続、チェックサム、結果の合意、検証）
  raceConfig.ts   レース設定の生成（シード、コース、ゲート抽選、ランク戦の正規化、ルールセット）
  schemas.ts      zod スキーマ（RaceStartConfig / メッセージ / リプレイログ / 検証結果）
  ruleset.ts      contracts/ruleset-params.default.json のキー集合で検証
  matchmaker.ts   レート幅の拡大・CPU補完・初心者分離、フレンド部屋
  rating.ts       Glicko-2（多人数レースは人間同士のペアに分解）
  season.ts       クラス・昇降級・正規化
  wallet.ts       有償/無償コイン、台帳、有償から先に消費、返金→未精算
  purchase.ts     購入前チェック（年齢・保護者同意・月額上限）、レシート反映、初回ボーナス、パス、返金
  accounting.ts   資金決済法の基準日判定・未使用残高の集計
  gacha.ts        ppmテーブル、検証、提供割合の自動生成、10連保証、天井、ダブり→素材、コンプガチャ検出
  horses.ts       覚醒、命名（正規化＋NG）、引退、配合、ニックス、5代血統、近親ペナルティ、予想
  rewards.ts      ログボ、デイリーミッション、シーズンパス、レース報酬
  service.ts      PlayerService（ドラフト上で実行→成功時のみ保存、冪等キー）
  stats.ts        戦績（入力ログからスタート反応・ムチ）、称号の判定と装備、表示名、公開プロフィール
  leaderboard.ts  ランキングの集計ファイル・順位、シーズン締めの再開可能な処理
  friends.ts      フレンドコード、申請〜解除の各段階、招待、FriendsService（2人の更新を順番に＋取り消し）
  retention.ts    リプレイログの保存期限（保留は残す）
  scheduled.ts    cronの振り分け
src/race/       レース作成（チケット発行）、精算（着順→報酬・レート・戦績）、settlement.ts（検証と精算をアラームから再試行つきで実行）
src/http/       ルーター、Firebase IDトークン検証、レース入場チケット、ストアアダプタ
src/do/         Durable Objects（PlayerDO / RaceRoomDO / MatchmakerDO / AccountingDO / LeaderboardDO / DirectoryDO）
master/         マスターデータ（全て架空。金額・確率は暫定）
```

## 認証
- 通常：`Authorization: Bearer <Firebase ID トークン>`（匿名ログイン可）
- 開発：`DEV_MODE=1` のとき `x-dev-user: <任意のID>`
- 書き込み系は `Idempotency-Key: <一意な文字列>` ヘッダーが必須（同じキーの再送は同じ結果を返す）

エラーは `{"error":{"code":"INSUFFICIENT_COINS","message":"…"}}`。コード一覧は `src/domain/errors.ts`。

## API 一覧

| メソッド | パス | 認証 | 冪等キー | 本文 / 説明 |
|---|---|---|---|---|
| GET | `/v1/health` | なし | | |
| POST | `/v1/player/bootstrap` | 要 | | 初回作成＋状態 |
| GET | `/v1/player` | 要 | | 財布・所持馬・アイテム・天井・パス・レート |
| PUT | `/v1/player/age` | 要 | | `{birthYear, birthMonth, guardianConsent}` → 年齢帯と月額上限 |
| GET | `/v1/shop/products` | なし | | 商品一覧 |
| POST | `/v1/shop/purchase-intent` | 要 | | `{productId}` ストア購入を始めてよいか（`AGE_REQUIRED` / `GUARDIAN_CONSENT_REQUIRED` / `AGE_LIMIT_EXCEEDED` / `ALREADY_PURCHASED` / `UNSETTLED_DEBT`） |
| GET | `/v1/shop/store-account` | 要 | | `{appleAppAccountToken, googleObfuscatedAccountId}` 購入時にストアへ渡す値（下記「ストア連携」） |
| POST | `/v1/shop/purchase` | 要 | （取引IDで自動） | `{platform: apple\|google\|fake, productId, receipt}`。apple＝`Transaction.jwsRepresentation`、google＝`{"purchaseToken":"…"}` |
| POST | `/v1/store/notifications/:platform` | 署名 | | `apple`：App Store Server Notifications V2、`google`：RTDN（Pub/Sub push、OIDC）、`fake`：開発用 |
| GET | `/v1/gacha/banners` | なし | | |
| GET | `/v1/gacha/:bannerId/odds` | なし | | 提供割合（抽選と同じ定義から生成）、保証枠、天井 |
| POST | `/v1/gacha/:bannerId/draw` | 要 | 必須 | `{count: 1\|10}` |
| POST | `/v1/gacha/tutorial` | 要 | 必須 | 初回無料10連（1回限り） |
| POST | `/v1/gacha/:bannerId/pity-exchange` | 要 | 必須 | `{templateId}` 天井100で交換 |
| GET | `/v1/horses` | 要 | | |
| PUT | `/v1/horses/:horseId/name` | 要 | | `{name}` カタカナ2〜9文字、NGリスト |
| POST | `/v1/horses/:horseId/awaken` | 要 | 必須 | |
| POST | `/v1/horses/:horseId/retire` | 要 | | |
| GET | `/v1/horses/:horseId/pedigree` | 要 | | 5代血統表 |
| POST | `/v1/breeding/preview` | 要 | | `{sireId, damId}` 能力の範囲・脚質・距離・ニックス・近親 |
| POST | `/v1/breeding` | 要 | 必須 | `{sireId, damId}` 1日1回 |
| POST | `/v1/rewards/login-bonus` | 要 | 必須 | |
| GET | `/v1/missions` | 要 | | |
| POST | `/v1/missions/:missionId/claim` | 要 | 必須 | |
| GET | `/v1/season-pass` | 要 | | |
| POST | `/v1/season-pass/claim` | 要 | 必須 | `{track: free\|premium, level}` |
| POST | `/v1/match/enqueue` | 要 | | `{horseId}` ランク戦の待ち行列へ |
| POST | `/v1/match/cancel` | 要 | | |
| GET | `/v1/match/status` | 要 | | `{state: none\|queued\|matched, raceId, slot, ticket, startAtMs, wsPath}` |
| POST | `/v1/friend-rooms` | 要 | | `{horseId}` → `{passphrase}` |
| POST | `/v1/friend-rooms/:passphrase/join` | 要 | | `{horseId}` |
| POST | `/v1/friend-rooms/:passphrase/start` | 要 | | ホストのみ。→ 割り当て |
| POST | `/v1/race/tutorial` | 要 | | `{horseId}` → 割り当て（CPU11頭・弱め） |
| GET | `/v1/race/:raceId/ws` | チケット | | WebSocket。最初に `{"t":"hello","raceId","token":<ticket>,"lastTick":-1}` |
| POST | `/v1/race/:raceId/report` | 要 | | 不正の通報（サーバー検証を強制） |
| PUT | `/v1/player/profile` | 要 | | `{displayName}` 1〜12文字、NGリスト |
| GET | `/v1/titles` | 要 | | 称号一覧（解放済みか）と装備中 |
| PUT | `/v1/player/title` | 要 | | `{titleId \| null}` 解放済みのみ |
| GET | `/v1/stats` | 要 | | 戦績（脚質別・コース別ベスト・スタート・ムチ） |
| GET | `/v1/leaderboards/:seasonId/:board` | なし | | `seasonId`=`YYYY-MM`\|`current`、`board`=`class-C`等\|`rating`\|`index`\|`ta-<trackId>`（タイムアタック）。R2の集計ファイル（5分ごと更新） |
| POST | `/v1/time-attack/start` | 要 | | `{trackId, horseId}` → `{sessionId, token, config, expiresAt, attemptsLeft}`。1日の回数を消費（`TA_LIMIT_REACHED`） |
| POST | `/v1/time-attack/submit` | 要 | | `{sessionId, token, inputs:[[tick,0,cmd]…], resultHash, config?}` → 検証サーバーで再計算して記録。`{finished, timeMs, seasonBest, allTimeBest, milestones, published…}`。`TA_RESULT_MISMATCH`(422) / `TA_SESSION_USED` / `TA_SESSION_EXPIRED` / `TA_CONFIG_MISMATCH`(400) / `VERIFIER_UNAVAILABLE`(503, 同じセッションで再提出可) |
| GET | `/v1/time-attack/:trackId/me` | 要 | | シーズン／通算ベスト、今日の残り回数、節目報酬、順位（直近集計） |
| GET | `/v1/time-attack/:trackId/ghosts` | 要 | | `?kind=top\|friends\|me&seasonId=` ゴースト候補（名前・タイム・ダウンロード `path`） |
| GET | `/v1/time-attack/ghosts/:seasonId/:trackId/:playerId` | 要 | | ゴースト本体 `{meta, log}`（検証済みリプレイログ） |
| GET | `/v1/leaderboards/me` | 要 | | 今シーズンの自分の順位（直近集計）と現在の成績 |
| GET | `/v1/friends` | 要 | | フレンド・受信/送信中の申請・招待（公開プロフィール付き） |
| GET | `/v1/friends/code` | 要 | | 自分のフレンドコード（9桁） |
| POST | `/v1/friends/requests` | 要 | | `{code}` 申請（相互申請なら即フレンド） |
| POST | `/v1/friends/requests/:fromId/accept` | 要 | | 承認 |
| POST | `/v1/friends/requests/:fromId/decline` | 要 | | 拒否 |
| DELETE | `/v1/friends/requests/:toId` | 要 | | 自分の申請を取り消し |
| DELETE | `/v1/friends/:friendId` | 要 | | フレンド解除（双方） |
| POST | `/v1/friend-rooms/:passphrase/invite` | 要 | | `{friendId}` 部屋のメンバーがフレンドを招待 |
| GET | `/v1/admin/paid-balance` | 管理 | | 有償コイン未使用残高の集計（資金決済法） |
| GET | `/v1/admin/replays/:raceId` | 管理 | | リプレイログ |

レース中のメッセージは `contracts/protocol.md` §4。

## 設計メモ
- お金・抽選・配合の乱数はすべてサーバー（`crypto.getRandomValues`）。端末の値は信用しない。
- PlayerService の各操作は状態のコピーに対して実行し、最後まで成功したときだけ保存（ガチャ途中の失敗で巻き戻る）。
- 有償コインは購入ごとの「ロット」で管理し、購入単価で円換算できる（基準日の未使用残高）。
- レース部屋は計算しない。tickを確定して入力を配り、結果ハッシュの合意を取るだけ。合意できない／人間1人のランク戦／通報／抜き取りは検証サーバーで再計算。検証サーバーに届かなければ3回まで再試行してから無効。検証と精算はアラームからだけ実行（`src/race/settlement.ts`）。
- 1件の結果で部屋は止まらない。ありえない早さの結果は拒否、合意は人間スロットの2/3が必要（REQ-NET-012）。
- ランキングは1シーズン＝1オブジェクト（`LeaderboardDO`、`lb:YYYY-MM`）。フレンドコードと公開プロフィールは16シャード（`DirectoryDO`、`dir:n`）。
- ゴールデン `contracts/golden/ts-config-*.json` はルールセットのファイルを埋め込むので、ルールセットを変えたら `npm run gen:golden`。

## ストア連携（`src/stores/`）

| | Apple（StoreKit 2） | Google Play |
|---|---|---|
| アプリが送る `receipt` | `Transaction.jwsRepresentation` | `{"purchaseToken":"…"}` |
| 検証 | x5c 証明書チェーンを Apple Root CA - G3 まで検証（Apple独自のOID・有効期限・ECDSA署名）、ES256署名、bundleId・環境・商品ID・取り消し | Play Developer API（サービスアカウントJWT→OAuth、トークンはキャッシュ）の purchases.products / subscriptionsv2 で状態・商品・アカウントを確認 |
| 本人との紐付け | 購入時に `appAccountToken` = `/v1/shop/store-account` の `appleAppAccountToken` | `setObfuscatedAccountId` = `googleObfuscatedAccountId` |
| 付与後 | — | コインは consume、パスは acknowledge（3日以内に必要。失敗してもアプリが再送すれば再試行） |
| サーバー通知 | V2 の `signedPayload` を同じ方法で検証。REFUND/REVOKE→返金、SUBSCRIBED/DID_RENEW→期間延長、EXPIRED/GRACE_PERIOD_EXPIRED→終了、DID_FAIL_TO_RENEW→猶予/再試行、CONSUMPTION_REQUEST・TEST→受領のみ | Pub/Sub の OIDC トークン（発行者・audience・サービスアカウントのメール）を検証。voided→返金、RENEWED等→期間延長、EXPIRED/REVOKED/ON_HOLD/PAUSED→終了、IN_GRACE_PERIOD→猶予 |
| テスト購入 | Sandbox/Xcode は既定で受け付け（App Review が Sandbox を使うため）、金額0円として記録。`APPLE_ACCEPT_SANDBOX=0` で拒否 | ライセンステストは既定で受け付け、0円。`GOOGLE_ACCEPT_TEST=0` で拒否 |

- 取引IDは `apple:<transactionId>` / `google:<orderId>` で保存し、プラットフォーム間で衝突しない。
- **1つのレシートは1人にしか付与されない**：全体の取引インデックス（AccountingDO の `store_tx`）に「取引ID・サブスクIDの持ち主」を先着で記録。サーバー通知もここで持ち主を探す。見つからない通知は 200 で受領して無視（アプリ側の購入処理が後で付与する）。
- 返金では、付与した有償コイン・初回ボーナス（無償／有償）・同梱アイテムをすべて回収。使ってしまった分はコインの負債（`debt`）／アイテムの負債（`itemDebt`）になり、精算までガチャと購入が止まる。1回限りの商品は返金後も「購入済み」。
- 年齢は一度登録したら「若くなる方向」にしか変えられない（保護者同意の追加は可）。月額上限を超えた購入が記録された月は、以降の購入前チェックが `AGE_LIMIT_EXCEEDED` になり、`supportFlags` にサポート用の印が付く。

### 本番で必要な設定（`wrangler.toml` の vars / `wrangler secret put`）

| 名前 | 種別 | 内容 |
|---|---|---|
| `APPLE_BUNDLE_ID` | var | iOS の bundle id。未設定なら Apple は全て拒否 |
| `APPLE_ACCEPT_SANDBOX` | var | `0` で Sandbox を拒否（既定は受け付け） |
| `GOOGLE_PACKAGE_NAME` | var | Android のパッケージ名 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | secret | Play Console で注文の閲覧・管理権限を付けたサービスアカウントの鍵JSON |
| `GOOGLE_ACCEPT_TEST` | var | `0` でライセンステスト購入を拒否 |
| `GOOGLE_PUBSUB_AUDIENCE` | var | RTDN の Pub/Sub push サブスクリプションに設定した audience |
| `GOOGLE_PUBSUB_SERVICE_ACCOUNT` | var | push が認証に使うサービスアカウントのメール |

App Store Connect では通知URLに `https://<host>/v1/store/notifications/apple`（Version 2）を設定。Google は RTDN のトピックに push サブスクリプション（エンドポイント `https://<host>/v1/store/notifications/google`、認証あり）を作る。
App Store Server API（`AppStoreServerApi`、ES256 JWT）はアプリが報告し損ねた取引の照会用に用意してあるが、まだルートには繋いでいない（鍵：Issuer ID・Key ID・.p8）。

## 定期実行（wrangler.toml `[triggers]`）
| cron (UTC) | 内容 |
|---|---|
| `*/5 * * * *` | 今シーズンのランキング集計をR2（`SNAPSHOTS`）へ（変化があった時だけ）＋前シーズンの締めを1段階進める（完了後は何もしない） |
| `23 18 * * *`（03:23 JST） | リプレイログの保存期限切れを削除（保留中は残す） |

ローカルでは `wrangler dev --test-scheduled` で `/__scheduled?cron=*/5+*+*+*+*` を叩いて確認できる。

## 未実装・要対応
- Apple / Google の実機・本番の認証情報での疎通確認（コードとテストは自前の証明書チェーン・偽APIで検証済み）
- 年齢帯ごとの月額上限の金額（`master/age-limits.json` は仮値・未確定）
- NGリストの本番版（`master/ng-names.json` は仮）
- マッチングは1シャード（`ranked-jp`）。規模に応じて地域・レート帯で分割する
