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
| `npm run lint:deploy -- --env <staging\|production>` | デプロイ前の設定チェック（`DEV_MODE`禁止・`REPLACE_ME`残り・バインディング漏れ・環境間のストレージ共有・シークレットの[vars]混入）。`--allow-placeholders` で構造だけ確認、`--secrets <wrangler secret list の出力>` で必須シークレットの有無も確認 |

デプロイ（staging / production の環境、シークレット、CI、切り戻し）は [../docs/ops/deploy.md](../docs/ops/deploy.md)。

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
  collection.ts   図鑑（入手・出会った・未発見）、実績（遊びだけを数える段・無償コイン・称号）、組の実績のコンプガチャ検出
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
src/do/         Durable Objects（PlayerDO / RaceRoomDO / MatchmakerDO / AccountingDO / LeaderboardDO / DirectoryDO / … / TournamentDO）
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
| GET | `/v1/shop/products` | なし | | 商品一覧と表示データ（中身・数量・初回の無償上乗せ・1回限り・期間・説明キー。`contracts/protocol.md` §13.1） |
| GET | `/v1/shop/products?mine=1` | 要 | | 同じ一覧＋そのプレイヤーの所持（`owned`・`ownedReason`・`purchasedThisSeason`。今シーズンのパス購入済みなど、§18.1） |
| GET | `/v1/shop/offers` | 要 | | オファーの状態（スターター・パス・昇級記念・手当、初回購入ボーナスの残り。§13.3） |
| POST | `/v1/shop/offers/:offerId/view` | 要 | | 1回だけの案内を表示した記録（§13.4） |
| GET | `/v1/shop/allowance` | 要 | | 厩舎手当（30日）の状態（§13.5） |
| POST | `/v1/shop/allowance/claim` | 要 | 必須 | 今日の厩舎手当を受け取る（`ALREADY_CLAIMED` / `NOT_ELIGIBLE`） |
| GET | `/v1/ads` | 要 | | リワード広告のカード・今日の残り・出さない理由（protocol §21） |
| PUT | `/v1/ads/preferences` | 要 | | `{mode: auto|on|off}` 動画広告の設定 |
| POST | `/v1/ads/:placementId/start` | 要 | 必須 | 視聴セッションを開く（付与しない。`AD_LIMIT_REACHED` / `NOT_ELIGIBLE` / `RATE_LIMITED`） |
| GET | `/v1/ads/sessions/:sessionId` | 要 | | セッションの状態（`open`/`rewarded`/`rejected`/`expired`）とウォレット |
| GET | `/v1/ads/ssv/admob` | 署名 | | 広告ネットワークのサーバー検証コールバック（ECDSA 署名、env `ADS_SSV_KEYS_URL`/`ADS_SSV_KEYS`/`ADS_AD_UNITS`。未設定なら 404） |
| GET | `/v1/training` | 要 | | 調教：今日の回数・メニュー・馬ごとの伸び／素質／疲れ・開いたままのセッション（期限切れはここでミニゲームなしとして記録）（protocol §25） |
| POST | `/v1/training/start` | 要 | 必須 | `{horseId, menuId}` 回数を1つ使い、ミニゲームのビートを返す（`TRAINING_LIMIT` / `TRAINING_TIRED` / `TRAINING_POTENTIAL_FULL`） |
| POST | `/v1/training/:sessionId/finish` | 要 | 必須 | `{taps:[ms…], skipped?}` サーバーが採点し直して伸びを付ける（`TRAINING_INPUT_INVALID` 422 / `TRAINING_SESSION_EXPIRED`） |
| POST | `/v1/training/items/:itemId/use` | 要 | 必須 | `{horseId}` 疲れを回復するアイテム（デイリーミッションでだけ入手） |
| GET | `/v1/challenges/weekly` | 要 | | 週替わりチャレンジ：今週の3つ（条件・報酬・貸し出し馬）・自分の進み具合・バッジ・来週の条件（protocol §31） |
| POST | `/v1/challenges/weekly/:challengeId/start` | 要 | 必須 | `{horseId}` か `{loan:true}` 設定（CPU・馬場・正規化）とトークンを発行（`CHALLENGE_HORSE_INELIGIBLE` / `CHALLENGE_LIMIT_REACHED` 429） |
| POST | `/v1/challenges/weekly/submit` | 要 | | `{sessionId, token, inputs, resultHash, config?}` 検証器で再シミュレーションしてサーバーが条件を判定（セッション単位で冪等、`CHALLENGE_RESULT_MISMATCH` 422 / `VERIFIER_UNAVAILABLE` 503） |
| GET | `/v1/teams/me/goal` | 要 | | 支部の共同目標：今週の目標・段と報酬・自分の貢献と今日の数・上位の貢献者・先週の結果。貢献は確定したレース結果と検証済みのタイムアタックだけ（クライアントから送る経路は無い）。週の締めと配布は TeamDO のアラーム（protocol §32） |
| POST | `/v1/shop/purchase-intent` | 要 | | `{productId}` ストア購入を始めてよいか（`AGE_REQUIRED` / `GUARDIAN_CONSENT_REQUIRED` / `AGE_LIMIT_EXCEEDED` / `ALREADY_PURCHASED` / `UNSETTLED_DEBT` / `NOT_ELIGIBLE`）。パスは残り日数、コインは初回の無償上乗せも返す（§13.2） |
| GET | `/v1/shop/store-account` | 要 | | `{appleAppAccountToken, googleObfuscatedAccountId}` 購入時にストアへ渡す値（下記「ストア連携」） |
| POST | `/v1/shop/purchase` | 要 | （取引IDで自動） | `{platform: apple\|google\|fake, productId, receipt}`。apple＝`Transaction.jwsRepresentation`、google＝`{"purchaseToken":"…"}` |
| POST | `/v1/store/notifications/:platform` | 署名 | | `apple`：App Store Server Notifications V2、`google`：RTDN（Pub/Sub push、OIDC）、`fake`：開発用 |
| GET | `/v1/gacha/banners` | なし | | 開催中・予告中のバナー（並び順、実際の終了時刻、`serverNowMs`）。REQ-GACHA-011 |
| GET | `/v1/gacha/status` | 要 | | 天井の表示（グループごとの交換pt・残り・交換までのコイン・期間終了時の移り先）とステップアップの進み具合。REQ-GACHA-012〜014 |
| GET | `/v1/gacha/:bannerId/odds` | なし | | 提供割合（抽選と同じ定義から生成）、保証枠、ピックアップの割合、ステップごとの表、天井と移り先。予告前は404 |
| POST | `/v1/gacha/:bannerId/draw` | 要 | 必須 | `{count: 1\|10}` |
| POST | `/v1/gacha/tutorial` | 要 | 必須 | 初回無料10連（1回限り） |
| POST | `/v1/gacha/:bannerId/pity-exchange` | 要 | 必須 | `{templateId}` 天井100で交換 |
| GET | `/v1/horses` | 要 | | |
| PUT | `/v1/horses/:horseId/name` | 要 | | `{name}` カタカナ2〜9文字、NGリスト |
| POST | `/v1/horses/:horseId/awaken` | 要 | 必須 | |
| POST | `/v1/horses/:horseId/retire` | 要 | | |
| GET | `/v1/horses/:horseId/pedigree` | 要 | | 5代血統表 |
| GET | `/v1/horses/:horseId/bond` | 要 | | 絆（レベル・ポイント・ケアごとの残りクールダウン）。REQ-BOND-* |
| POST | `/v1/horses/:horseId/care` | 要 | 必須 | `{action}` ケア。クールダウン中・1日上限は `409 COOLDOWN`。レベル報酬・称号を返す |
| GET | `/v1/bond` | 要 | | `{levels: {horseId: level}}` |
| GET | `/v1/presets` | 要 | | コースの見た目・フレンドルームの条件。REQ-ROOM-* |
| PUT | `/v1/presets/course-look` | 要 | | `{lookId \| null}` 持っている見た目だけ |
| PUT | `/v1/presets/room` | 要 | | `{trackId?, going?, night?, weather, temperatureC, windKmh}` 自分がホストのフレンドルームに使う |
| DELETE | `/v1/presets/room` | 要 | | 条件を消す（自動に戻す） |
| POST | `/v1/breeding/preview` | 要 | | `{sireId, damId}` 能力の範囲・脚質・距離・ニックス・近親 |
| POST | `/v1/breeding` | 要 | 必須 | `{sireId, damId, useMaterial?}` 1日1回。`useMaterial: true` なら通常分を使い切った後、配合素材で1日1回まで追加（REQ-ITEM-003）。予想（preview）は `today` に残り回数を返す |
| GET | `/v1/stable` | 要 | | マイ厩舎：自分の配置（未保存なら装備中の飾りから）・テーマ（解放状態）・飾り（所持）・いいね数・訪問者に見える写し（REQ-STABLE-*） |
| PUT | `/v1/stable` | 要 | | `{theme, name\|null, slots[], featuredHorseIds[]}` 持っている飾り・自分の現役馬だけ。公開用の写しを DirectoryDO に書く |
| GET | `/v1/stable/visits` | 要 | | フレンドの厩舎とおすすめ（いいねの多い順） |
| GET | `/v1/stable/:playerId` | 要 | | 公開用の写し＋自分のいいね状況（持ち主のDOは読まない） |
| POST | `/v1/stable/:playerId/like` | 要 | 必須 | いいね（1日5回・同じ相手は1日1回・自分は不可）。**コインは付かない** |
| GET | `/v1/stud/mine` | 要 | | 自分の登録種牡馬（今日の貸出数）・今日の受取額と上限・借りた回数・履歴（貸し/借り） |
| PUT | `/v1/stud/listings/:horseId` | 要 | | `{visibility: friends\|public, fee, dailyLimit}` 引退牡馬を登録・更新。料金は無償コイン（REQ-BREED-010） |
| DELETE | `/v1/stud/listings/:horseId` | 要 | | 登録を取り下げる |
| GET | `/v1/stud/browse?scope=friends\|public` | 要 | | フレンドの登録馬／全体公開の登録馬 |
| POST | `/v1/stud/preview` | 要 | | `{ownerId, horseId, damId}` 通常の予想＋`stud`（料金・残り枠・支払えるか） |
| POST | `/v1/stud/breed` | 要 | 必須 | `{ownerId, horseId, damId, useMaterial?}` 借りた種牡馬で配合。`feeStatus: paid\|pending`（pending＝持ち主への支払いを再送中。二重請求なし） |
| GET | `/v1/items/tickets` | なし | | 券の一覧と提供割合（REQ-ITEM-001/002） |
| GET | `/v1/items/tickets/:itemId/odds` | なし | | 券1種の提供割合（SR以上確定券は券専用の表） |
| POST | `/v1/items/tickets/:itemId/use` | 要 | 必須 | `{bannerId?}` ガチャ券は `bannerId` 必須（対象ガチャのみ、天井+1）。SR以上確定券は不要 |
| GET | `/v1/shop/cosmetics` | 要 | | 見た目アイテム（勝負服の模様・馬具・厩舎の飾り）の一覧、価格、所持・装備中、アセットキー |
| POST | `/v1/shop/cosmetics/:itemId/buy` | 要 | 必須 | コインで購入（各1回。有償限定はペイドのみ） |
| PUT | `/v1/player/equipment` | 要 | | `{tack?: {bridle?, saddlecloth?}, decor?: [itemId\|null…]}` 装備（`null` で外す） |
| POST | `/v1/rewards/login-bonus` | 要 | 必須 | |
| GET | `/v1/missions` | 要 | | デイリーミッションと今日の初勝利ボーナスの残り（`firstWinBonus`） |
| POST | `/v1/missions/:missionId/claim` | 要 | 必須 | |
| GET | `/v1/comeback` | 要 | | 復帰キャンペーンの期間（REQ-CB-*、contracts/protocol.md「復帰キャンペーン・お知らせ」）。活動日として数える |
| POST | `/v1/comeback/login` | 要 | 必須 | 復帰ログインボーナス（1ゲーム日1回） |
| POST | `/v1/comeback/missions/:missionId/claim` | 要 | 必須 | 復帰ミッション |
| POST | `/v1/comeback/welcome` | 要 | | 歓迎画面を出した（1回） |
| GET | `/v1/collection` | 要 | | 図鑑（REQ-COL-*、contracts/protocol.md §24）。入手・出会った・未発見と数。達成率に報酬は無い |
| GET | `/v1/achievements` | 要 | | 実績（REQ-ACH-*）：進み具合・段・バッジ・称号 |
| POST | `/v1/achievements/:achievementId/tiers/:tier/claim` | 要 | 必須 | 実績の段の無償コイン |
| POST | `/v1/achievements/claim-all` | 要 | 必須 | 受け取れる段を全部 |
| GET | `/v1/whats-new` | 要 | | 前回見た後に始まったもの（ホームのカード） |
| POST | `/v1/whats-new/seen` | 要 | | 本文 `{ upTo }`。見た位置を進める |
| GET | `/v1/home/next` | 要 | | 次にやること（REQ-NEXT-010、protocol §45）：主カード1枚＋チップ最大2つ。支部に入っていれば共同目標も見る |
| POST | `/v1/home/next/dismiss` | 要 | | 本文 `{ kind }`。その種類を今日のゲーム日だけ閉じる（冪等。`first_race`／`race` は 409 NOT_ELIGIBLE） |
| GET | `/v1/season-pass` | 要 | | シーズン（暦月）限りのパス：レベル・30段の報酬・期間・残り日数・前シーズンの自動付与（§13.6） |
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
| PUT | `/v1/player/silks` | 要 | | `{pattern, colors[2〜3], cap}` 勝負服。解放アイテムが無い模様は `NOT_ELIGIBLE`、不明な色・同色のみ・禁止の組み合わせは `BAD_REQUEST`（`contracts/assets.md` §3.2） |
| GET | `/v1/visuals` | なし | | 見た目のカタログ（パレット・毛色・模様・帽子・枠色・競馬場と回り・テンプレート馬の見た目・各アイコンのキー）。`version` ごとにキャッシュ（`contracts/assets.md`） |
| GET | `/v1/stats` | 要 | | 戦績（脚質別・コース別ベスト・スタート・ムチ） |
| GET | `/v1/leaderboards/:seasonId/:board` | なし | | `seasonId`=`YYYY-MM`\|`current`、`board`=`class-C`等\|`rating`\|`index`\|`ta-<trackId>`（タイムアタック）\|`league-<divisionId>`（支部対抗シーズンの部の順位表と週ごとの対戦）。R2の集計ファイル（5分ごと更新） |
| POST | `/v1/time-attack/start` | 要 | | `{trackId, horseId}` → `{sessionId, token, config, expiresAt, attemptsLeft}`。1日の回数を消費（`TA_LIMIT_REACHED`） |
| POST | `/v1/time-attack/submit` | 要 | | `{sessionId, token, inputs:[[tick,0,cmd]…], resultHash, config?}` → 検証サーバーで再計算して記録。`{finished, timeMs, seasonBest, allTimeBest, milestones, published…}`。`TA_RESULT_MISMATCH`(422) / `TA_SESSION_USED` / `TA_SESSION_EXPIRED` / `TA_CONFIG_MISMATCH`(400) / `VERIFIER_UNAVAILABLE`(503, 同じセッションで再提出可) |
| GET | `/v1/time-attack/:trackId/me` | 要 | | シーズン／通算ベスト、今日の残り回数、節目報酬、順位（直近集計） |
| GET | `/v1/time-attack/:trackId/ghosts` | 要 | | `?kind=top\|friends\|me&seasonId=` ゴースト候補（名前・タイム・ダウンロード `path`） |
| GET | `/v1/time-attack/ghosts/:seasonId/:trackId/:playerId` | 要 | | ゴースト本体 `{meta, log}`（検証済みリプレイログ） |
| GET | `/v1/leaderboards/me` | 要 | | 今シーズンの自分の順位（直近集計）と現在の成績 |
| GET | `/v1/teams/me` | 要 | | 所属支部（メンバー・役職・貢献ポイント・申請一覧はリーダー/幹部のみ）、再加入できる時刻、送信中の申請、支部の順位 |
| POST | `/v1/teams` | 要 | | `{name, joinPolicy: open\|approval, announcement?}` 支部を作る（作成者がリーダー）。`ALREADY_IN_TEAM` / `TEAM_COOLDOWN` / `INVALID_NAME` / `NG_NAME` |
| PUT | `/v1/teams/me` | 要 | | `{announcement?, joinPolicy?}` お知らせ（リーダー/幹部）・加入方針（リーダー） |
| DELETE | `/v1/teams/me` | 要 | | 解散（リーダーが最後の1人のときだけ） |
| POST | `/v1/teams/me/leave` | 要 | | 脱退。再加入の待ち時間が始まる。リーダーは `TEAM_LEADER_MUST_TRANSFER`（1人なら解散） |
| POST | `/v1/teams/me/kick` | 要 | | `{playerId}` 除名（幹部はメンバーのみ）。除名された側に待ち時間は無い |
| PUT | `/v1/teams/me/roles` | 要 | | `{playerId, role: officer\|member}` 役職の変更（リーダーのみ、幹部は上限あり `TEAM_LIMIT`） |
| POST | `/v1/teams/me/transfer` | 要 | | `{playerId}` リーダー譲渡（元リーダーは幹部に） |
| POST | `/v1/teams/me/requests/:playerId/approve` | 要 | | 加入申請の承認（リーダー/幹部）。申請者が他所に入っていれば申請は消える |
| POST | `/v1/teams/me/requests/:playerId/decline` | 要 | | 加入申請の却下 |
| GET | `/v1/stamps` | 要 | | 応援スタンプの一覧と解放状況（REQ-TEAMFEED-001/002、`contracts/protocol.md` §18） |
| GET | `/v1/teams/me/feed` | 要 | | 支部フィード（最新100件のリングバッファ、新しい順、`?before=&limit=`）。ミュートした人は除く |
| POST | `/v1/teams/me/feed/stamps` | 要 | | `{stampId}` スタンプを投稿（10秒に1回・1日50回、未解放は `STAMP_LOCKED`、削除予定中は `DELETION_PENDING`） |
| PUT | `/v1/teams/me/feed/:seq/reaction` | 要 | | `{stampId\|null}` 項目への応援（1人1つ、null で取り消し） |
| POST | `/v1/teams/me/feed/:seq/report` | 要 | | `{reason: spam\|harassment\|other}` 報告（自分の画面から消え、投稿者にサポート用フラグ） |
| GET / PUT | `/v1/teams/me/feed/mutes` | 要 | | ミュート（ブロック）の一覧 / `{playerId, muted}` |
| GET | `/v1/league/me` | 要 | | 支部対抗シーズン（REQ-LEAGUE-*）：自分の支部の部・順位表・週ごとの対戦（相手・得点＝その週のシーズンポイントの伸び・勝敗）・シーズン後の最終順位と報酬と次の部。支部に入っていなければ `teamId: null` と部の一覧 |
| GET | `/v1/teams/search` | 要 | | `?q=` 支部名の部分一致（または支部ID）。空なら今シーズン活発な支部 |
| GET | `/v1/teams/leaderboard/:seasonId` | なし | | 支部ランキングのスナップショット（R2、`current` 可） |
| GET | `/v1/teams/:teamId` | 要 | | 支部の公開情報 |
| POST | `/v1/teams/:teamId/join` | 要 | | 自由加入なら `{status:"joined"}`、承認制なら `{status:"requested"}`（リーダー/幹部へ通知）。`TEAM_FULL` / `TEAM_COOLDOWN` / `TEAM_LIMIT` |
| DELETE | `/v1/teams/:teamId/request` | 要 | | 自分の加入申請を取り下げる |
| GET | `/v1/events` | 要 | | 開催中・予定のイベント（参加条件・参加できない理由・自分の成績） |
| POST | `/v1/events/:eventId/enqueue` | 要 | 要 | `{horseId}` 参加費（無償コインかチケット）を預かってイベントの待ち行列へ。マッチ後の席は `/v1/match/status`。`EVENT_CLOSED` / `NOT_ELIGIBLE` / `INSUFFICIENT_COINS` / `INSUFFICIENT_ITEMS` |
| POST | `/v1/events/:eventId/cancel` | 要 | | 待ち行列から抜けて参加費を返す（レース中は `ALREADY_IN_RACE`） |
| GET | `/v1/events/:eventId/leaderboard` | なし | | イベントランキングのスナップショット（R2） |
| GET | `/v1/events/:eventId/me` | 要 | | 自分のイベント成績と順位（直近集計） |
| GET | `/v1/races/live` | 要 | | 観戦できるレース（REQ-SPEC-001）：`friends`＝自分・フレンドが走っている（フレンド部屋を含む）、`featured`＝公開レース（大会のヒート→レート順、最大20件） |
| POST | `/v1/race/:raceId/spectate` | 要 | | 観戦チケット（slot = -1、`{raceId, ticket, wsPath, startAtMs, delayMs, …}`）。フレンド部屋は出走者かそのフレンドだけ（`FORBIDDEN`）。WebSocket の流れは `contracts/protocol.md` §8.4 |
| GET | `/v1/tournaments` | なし | | 大会一覧（受付前・受付中・開催中→最近の結果） |
| GET | `/v1/tournaments/:tournamentId` | なし | | ルール・組み合わせ（ラウンド→ヒート→結果）・最終順位。終わった大会は R2 `tournaments/<id>.json` にも公開 |
| GET | `/v1/tournaments/:tournamentId/me` | 要 | | 自分のエントリー・今のヒート（走行中はチケット付き。`/v1/match/status` にも出る）・敗退・順位・賞品 |
| POST | `/v1/tournaments/:tournamentId/register` | 要 | | `{horseId}` エントリー（受付期間中は何度でも、馬の変更も）。`EVENT_CLOSED` / `NOT_ELIGIBLE`（理由：`class`,`ranked_races`,`style`,`moderation`,`horse_not_active`）/ `ROOM_FULL` |
| POST | `/v1/tournaments/:tournamentId/unregister` | 要 | | エントリー取り消し（受付期間中のみ） |
| GET | `/v1/tournaments/history/me` | 要 | | 自分の大会成績（新しい順、最大50件） |
| GET | `/v1/friends` | 要 | | フレンド・受信/送信中の申請・招待（公開プロフィール付き） |
| GET | `/v1/friends/code` | 要 | | 自分のフレンドコード（9桁） |
| POST | `/v1/friends/requests` | 要 | | `{code}` 申請（相互申請なら即フレンド） |
| POST | `/v1/friends/requests/:fromId/accept` | 要 | | 承認 |
| POST | `/v1/friends/requests/:fromId/decline` | 要 | | 拒否 |
| DELETE | `/v1/friends/requests/:toId` | 要 | | 自分の申請を取り消し |
| DELETE | `/v1/friends/:friendId` | 要 | | フレンド解除（双方） |
| POST | `/v1/friend-rooms/:passphrase/invite` | 要 | | `{friendId}` 部屋のメンバーがフレンドを招待 |
| GET | `/v1/invite` | 要 | | 友達招待：自分の招待コード（8文字）・共有リンク・入力できるか・招待した仲間・到達報酬の表。任意ヘッダー `x-install-id`（REQ-INV-*、protocol.md §19） |
| POST | `/v1/invite/redeem` | 要 | | `{code, installId}` 招待コードを1回だけ入力（チュートリアル後・7ゲーム日以内）。ウェルカムギフトとフレンド |
| GET | `/v1/config` | なし | | 有効な設定の版 `{versionId, hash, rulesetVersion, activatedAt, visualsVersion}`。アプリはhashごとにマスターデータ、visualsVersion ごとに `/v1/visuals` をキャッシュ（REQ-OPS-007） |
| PUT | `/v1/push/devices` | 要 | | `{token, platform: ios\|android}` FCMトークンを登録（1人最大5台。古い順に外れる） |
| POST | `/v1/push/devices/unregister` | 要 | | `{token}` ログアウト・通知オフ時に外す |
| GET | `/v1/push/preferences` | 要 | | 種類別の受信設定・静かな時間帯・1日の上限・登録台数・購読するFCMトピック |
| PUT | `/v1/push/preferences` | 要 | | `{categories?: {season,friends,invites,events}, quietHours?: {startHour,endHour}\|null}` → 上と同じ形。返ってきた `topics.subscribe/unsubscribe` をアプリがFCMで購読・解除する |
| POST | `/v1/analytics/events` | 要 | | `{platform, appVersion, events: [{name, at, props}]}`（最大50件）。クライアントでしか分からないイベントだけ受け付ける（`docs/ops/kpi-queries.md`）。1人あたり30回/分・2,000件/日まで（`RATE_LIMITED`=429） |
| GET | `/v1/admin/paid-balance` | 管理 | | 有償コイン未使用残高の集計（資金決済法） |
| GET | `/v1/admin/replays/:raceId` | 管理 | | リプレイログ |

レース中のメッセージは `contracts/protocol.md` §4。BAN中のプレイヤーはランク戦・フレンド部屋・購入前チェックで `403 BANNED`。

見た目（REQ-ASSET-*）：所持馬・ガチャ結果は `appearance`、プロフィール（自分・フレンド）は `silks`、支部は `emblem`（`PUT /v1/teams/me` の `{emblem: {shape, symbol, colors[2]}}` で変更、支部長・副長）、称号一覧は `icon`、イベントは `banner`、レースの `start` は `visuals` を含む。キーの規則と一覧は `contracts/assets.md` と `contracts/assets.manifest.json`（`npm run gen:assets` で再生成）。

## 管理API（`src/http/admin.ts`、REQ-OPS-*）

認証は `Authorization: Bearer <管理トークン>`（`ADMIN_TOKENS` にはトークンのSHA-256だけを置く）か、Cloudflare Access の `Cf-Access-Jwt-Assertion`。
権限は viewer ＜ operator ＜ admin。**書き込みは本文に `reason`（3〜500文字）が必須**。全ての呼び出し（閲覧・失敗・権限不足も）が監査ログに残る。操作者ごとのレート制限（閲覧／書き込み別、超過は `429 RATE_LIMITED`）。

| メソッド | パス | 権限 | 本文 / 説明 |
|---|---|---|---|
| GET | `/v1/admin/whoami` | viewer | 自分のIDと権限 |
| GET | `/v1/admin/paid-balance` | viewer | 有償コイン未使用残高の集計（資金決済法） |
| GET | `/v1/admin/replays/:raceId` | viewer | リプレイログ |
| GET | `/v1/admin/audit` | viewer | `?actor=&target=&action=&beforeSeq=&limit=` 監査ログ（新しい順） |
| GET | `/v1/admin/config` | viewer | 有効な版・予約・全版（本体なし）・有効化履歴 |
| GET | `/v1/admin/config/versions/:id` | viewer | 版の本体 |
| POST | `/v1/admin/config/validate` | viewer | `{bundle}` 検証だけ（`{problems}`） |
| POST | `/v1/admin/config/versions` | operator | `{bundle, note, reason}` 版を登録（同じ内容なら既存の版） |
| POST | `/v1/admin/config/activations` | admin | `{versionId, at?, reason}` 今すぐ／予約で有効化 |
| POST | `/v1/admin/config/activations/:id/cancel` | admin | `{reason}` 効果が出る前の予約を取り消し |
| POST | `/v1/admin/config/rollback` | admin | `{versionId?, reason}` 1つ前／指定の版／`base` に即時に戻す |
| GET | `/v1/admin/players/:playerId` | viewer | サポート用の詳細（財布・ロット・台帳・購入・年齢・印・不正対策の状態） |
| POST | `/v1/admin/players/:playerId/grants` | operator | `{grant:{freeCoins?, items?}, opKey, reason}` お詫び配布（opKeyで冪等、権限ごとの上限） |
| POST | `/v1/admin/grants/bulk` | operator | `{grant, opKey, reason, playerIds? \| segment?}` 一括配布（1回200人・合計100万コインまで。`segment`＝`{kind:'leaderboard', seasonId, board, offset, limit}`、続きは `nextOffset`） |
| POST | `/v1/admin/players/:playerId/debt/settle` | operator | `{coins?, items?, opKey, reason}` 返金負債の免除 |
| PUT | `/v1/admin/players/:playerId/age` | operator | `{birthYear, birthMonth, guardianConsent, reason}` 年齢の訂正 |
| POST | `/v1/admin/players/:playerId/name-reset` | operator | `{target: display\|horse, horseId?, reason}` 名前を既定に戻す |
| GET | `/v1/admin/integrity/players` | viewer | `?status=quarantined\|banned\|flagged&limit=` |
| GET | `/v1/admin/integrity/players/:playerId` | viewer | 点数・記録・状態・メモ |
| POST | `/v1/admin/integrity/players/:playerId/release` | operator | `{reason}` 隔離の解除 |
| POST | `/v1/admin/integrity/players/:playerId/ban` | admin | `{until?: epochMs\|null, reason}` BAN（null＝無期限） |
| POST | `/v1/admin/integrity/players/:playerId/unban` | admin | `{reason}` |
| GET | `/v1/admin/reports` | viewer | `?status=open\|resolved` 通報の列 |
| POST | `/v1/admin/reports/:reportId/resolve` | operator | `{resolution, reason}` |
| POST | `/v1/admin/tournaments` | operator | `{tournament:{id, name, trackIds, registrationOpensAtMs, registrationClosesAtMs, startsAtMs, heatSize, fieldSize, advancePerHeat, maxEntrants, minEntrants?, entry?, statCap?, cpuLevel?, roundGapMs?, notifyBeforeMs?, prizes?}, reason}` 大会を作る（REQ-TOUR-001。同じ内容の再送は既存を返す） |
| GET | `/v1/admin/tournaments/:id` | viewer | 大会の詳細（組み合わせ・順位） |
| POST | `/v1/admin/tournaments/:id/cancel` | operator | `{reason}` 中止（表彰前のみ。賞品なし） |
| GET | `/v1/admin/dead-letters` | viewer | `?status=open\|resolved\|dismissed\|all&source=&limit=` 失敗リストの索引（REQ-OPS-041） |
| GET | `/v1/admin/dead-letters/:source/:scope` | viewer | 持ち主の現在の失敗リスト（索引も更新）。`source`＝`season`（scope＝シーズン）／`team`（シーズン）／`event`（イベントID）／`settlement`（レースID）／`moderation`（`global`）／`tournament`（大会ID：賞品の付与） |
| POST | `/v1/admin/dead-letters/:source/:scope/:itemId/retry` | operator | `{reason}` 再試行（冪等。成功で `resolved`、失敗ならエラーと回数を更新） |
| POST | `/v1/admin/dead-letters/:source/:scope/:itemId/dismiss` | admin | `{note, reason}` 手作業で対応済みとして取り下げ |
| GET | `/v1/admin/silks/banned` | viewer | 有効な禁止勝負服の一覧（REQ-OPS-040） |
| POST | `/v1/admin/silks/banned/check` | viewer | `{silks:{pattern, colors, cap}}` 当たるか確認 |
| POST | `/v1/admin/silks/banned/import` | admin | `{list, reason}` 一覧を丸ごと取り込み、設定の新しい版として登録（有効化は `/v1/admin/config/activations`） |
| POST | `/v1/admin/config/dry-run` | viewer | `{op:{kind:'activate', versionId, at?} \| {kind:'rollback', versionId?} \| {kind:'cancel', activationId}}` 本番と同じ検証を保存せずに実行（REQ-OPS-008）→ `{ok, problems, groups, effect}` |
| GET | `/v1/admin/config/diff` | viewer | `?from=&to=`（版IDか `base`）パスごとの差分（REQ-OPS-009） |
| GET | `/v1/admin/gacha/calendar` | viewer | `?versionId=active\|base\|cfg_N` バナーの日程（ゲーム日）・天井グループと引き継ぎの連鎖・ステップアップの価格（REQ-OPS-027） |
| GET | `/v1/admin/gacha/:bannerId/odds` | viewer | `?versionId=` プレイヤー向けと同じ提供割合ページ（公開前・終了後も） |
| GET | `/v1/admin/events` | viewer | `?versionId=` イベントの一覧と状態、コース一覧 |
| GET | `/v1/admin/tournaments` | viewer | 大会の一覧と状態 |
| GET | `/v1/admin/players/lookup` | viewer | `?inviteCode=XXXX-XXXX` 招待コードからプレイヤーID（REQ-OPS-020a） |
| GET | `/v1/admin/compensations` | viewer | `?status=pending\|approved\|executed\|rejected\|expired&playerId=&limit=` 補填の依頼（REQ-OPS-026） |
| POST | `/v1/admin/compensations` | operator | `{playerId, grant:{freeCoins?, items?}, opKey, reason}` 閾値（1万コイン・100個）以下は即付与、超えると承認待ち（上限10万・1000個） |
| POST | `/v1/admin/compensations/:id/approve` | admin | `{note?, reason}` 依頼者以外の admin が承認して付与（2人ルール。付与失敗後は再承認で再試行） |
| POST | `/v1/admin/compensations/:id/reject` | operator | `{note?, reason}` 承認待ちを却下（依頼者の取り下げも可） |

`GET /v1/admin/players/:playerId` は `{state, integrity, flags, compensations}`（`state` に `exists`・`accountDeleted`・`deletion`・`referral` を含む）。`/players/:id/grants` と一括配布の1人あたりは補填の閾値（1万コイン・100個）まで。運用コンソールからの呼び出しは `ADMIN_CONSOLE_ORIGINS`（wrangler の変数、カンマ区切りのオリジン）に載せたオリジンだけ CORS で許可（資格情報なし）。書き込みは `content-type: application/json` 必須。手順は `docs/ops/console.md`。

### 設定配信（リモートコンフィグ）
- バンドルで変えられるもの：`ruleset`（一部でも全部でも可。キー集合は固定）、`gacha.banners`（一覧ごと置き換え。開催日程は `startDay`/`endDay`（ゲーム日）か `startAtMs`/`endAtMs`、予告は `announceDays`/`announceAtMs`、ステップアップは `stepUp`）、`gacha.pityGroups`（`endDay`/`endAtMs`・`convertTo`・`label`）、`tracks`、`progression`（浅いマージ）、`ng`。
- 値を変えたら `ruleset.rulesetVersion` も変える。同じ `rulesetVersion` を別の値で使い回すことはできない（過去のレースの検証のため）。
- 各Worker・Durable Objectは有効な設定を30秒（または次の予約時刻まで）キャッシュする。有効化から反映まで最大30秒。
- 設定は `OpsDO`（`global`）に保存。配信元に障害があっても最後に知っている設定で動く。

### 不正対策
- レース確定後、結果が食い違った人（容疑者、1点）とチェックサムがズレた人（0.5点）を `IntegrityDO`（`global`）に送る。7日間で3点以上なら自動で14日間の隔離（ランク戦は隔離中の人同士かCPUとだけ）。
- BANは管理者の判断のみ。状態はプレイヤー本人のオブジェクトに反映され、マッチングと購入前チェックで使われる。
- 通報（`/v1/race/:raceId/report`）はレビュー用の列に入る。通報だけで隔離・BANにはならない。

## 設計メモ
- お金・抽選・配合の乱数はすべてサーバー（`crypto.getRandomValues`）。端末の値は信用しない。
- PlayerService の各操作は状態のコピーに対して実行し、最後まで成功したときだけ保存（ガチャ途中の失敗で巻き戻る）。
- 有償コインは購入ごとの「ロット」で管理し、購入単価で円換算できる（基準日の未使用残高）。
- レース部屋は計算しない。tickを確定して入力を配り、結果ハッシュの合意を取るだけ。合意できない／人間1人のランク戦／通報／抜き取りは検証サーバーで再計算。検証サーバーに届かなければ3回まで再試行してから無効。検証と精算はアラームからだけ実行（`src/race/settlement.ts`）。
- 1件の結果で部屋は止まらない。ありえない早さの結果は拒否、合意は人間スロットの2/3が必要（REQ-NET-012）。
- ランキングは1シーズン＝1オブジェクト（`LeaderboardDO`、`lb:YYYY-MM`）。フレンドコードと公開プロフィールは16シャード（`DirectoryDO`、`dir:n`）。
- ゴールデン `contracts/golden/ts-config-*.json` はルールセットのファイルを埋め込むので、ルールセットを変えたら `npm run gen:golden`。

## 支部対抗シーズン（`src/domain/league.ts`、REQ-LEAGUE-*）
- シーズン（JSTの月）ごとに1つ。状態はそのシーズンの `LeaderboardDO`（`lb:<seasonId>`）の kv `league`。設定は `master/progression.json league`（部・週の数・参加の最低人数・遅れて参加できる時間・勝ち点・昇格/降格の数・報酬）。
- 定期実行（`leagueStep`）：最初の実行で前シーズンの結果（`leagueCarry`、前シーズンの締めが先に確定させる。確定していなければ最大1日待つ）から部を決めて作る。週の始まりに組み合わせ、`lateEntryHours` 以内に条件を満たした支部を追加、終わった週を集計。対戦の得点は支部のシーズンポイント（REQ-TEAM-005 の上限・加入時点の差し引き込み）の週のあいだの伸び。
- 締め：支部の締め（`teamRolloverStep`）が `closing` に入った時に最終順位・昇格・降格を確定し、各支部の `closeSeasonStep` に順位を渡す。リーグ報酬は支部のシーズン報酬と同じ支払い（在籍日数ルール・プレイヤー側の「シーズンごとに1回」の記録・失敗リスト `dlRetry`）。
- 公開：部ごとに `leaderboards/<season>/league-<divisionId>.json`（スナップショットと一緒に書き、index にも載る）。

## 馬場状態・ダート・ナイター（`src/domain/ground.ts`、REQ-RACE-034〜038）
- ランク戦・フレンド戦の設定には `track.going`（その日の馬場）と `track.night` が入る。チュートリアルとタイムアタックには入らない（良・昼）。
- その日の馬場：`fnv1a32(salt|JSTの日付|コースID)` で `master/progression.json` の `weather.turf` / `weather.dirt` の重みから選ぶ。同じ日・同じコースは誰が走っても同じ。
- 運営の上書き：`weather.overrides` に `{trackId?, fromMs, toMs, going, night?}`。コース指定が全体指定より優先。リモート設定（`progression.weather`）でも変えられ、登録時に `weatherProblems` で検証する。
- コースごとの気候：`weather.byTrack.<trackId>` があるコースはその重み（そのコースの馬場面の名前だけ）。海外風の3場（ノルトハーフェン＝渋りやすい、サンタルチェラ＝軽い、ベルムーア＝やや渋る）に設定。起動時・リモート設定の登録時に検証。
- ナイター：`master/tracks.json` で `lights: true` の競馬場（みなと競馬場・サンタルチェラ競馬場）で、JST の `nightFromHourJst`〜`nightToHourJst`（既定 18〜4時）のレース。`lights` はマスター専用でレース設定には入らない。
- 馬の `goingAptitude`（any / fast / heavy）はテンプレートから引き継ぎ、配合では `goingAptitudeOdds` の確率で受け継ぐ（配合予想も同じ関数）。any の馬はレース設定に項目を書かない。
- ルールセットの馬場キー18個は「全部あるか全部ないか」。全部ない古いリプレイも検証できる（`OPTIONAL_RULESET_KEYS`）。

## ストア連携（`src/stores/`）

| | Apple（StoreKit 2） | Google Play |
|---|---|---|
| アプリが送る `receipt` | `Transaction.jwsRepresentation` | `{"purchaseToken":"…"}` |
| 検証 | x5c 証明書チェーンを Apple Root CA - G3 まで検証（Apple独自のOID・有効期限・ECDSA署名）、ES256署名、bundleId・環境・商品ID・取り消し | Play Developer API（サービスアカウントJWT→OAuth、トークンはキャッシュ）の purchases.products / subscriptionsv2 で状態・商品・アカウントを確認 |
| 本人との紐付け | 購入時に `appAccountToken` = `/v1/shop/store-account` の `appleAppAccountToken` | `setObfuscatedAccountId` = `googleObfuscatedAccountId` |
| 商品の種類（`products.json` の `storeType`） | コイン・厩舎手当＝消耗型、シーズンパス／パス＋＝**自動更新しない**期間商品（非更新サブスクリプション、または消耗型）、スターター・昇級記念＝非消耗型 | コイン・厩舎手当・シーズンパス／パス＋＝消費型のアプリ内アイテム、スターター・昇級記念＝消費しないアプリ内アイテム。自動更新の定期購入は登録しない（REQ-UXS-020） |
| 付与後 | — | 消費型は consume、1回限りの商品（`non_consumable`）と旧来の定期購入は acknowledge（3日以内に必要。失敗してもアプリが再送すれば再試行） |
| サーバー通知 | V2 の `signedPayload` を同じ方法で検証。REFUND/REVOKE→返金、SUBSCRIBED/DID_RENEW→期間延長、EXPIRED/GRACE_PERIOD_EXPIRED→終了、DID_FAIL_TO_RENEW→猶予/再試行、CONSUMPTION_REQUEST・TEST→受領のみ | Pub/Sub の OIDC トークン（発行者・audience・サービスアカウントのメール）を検証。voided→返金、RENEWED等→期間延長、EXPIRED/REVOKED/ON_HOLD/PAUSED→終了、IN_GRACE_PERIOD→猶予 |
| テスト購入 | Sandbox/Xcode は `APPLE_ACCEPT_SANDBOX=1` のときだけ受け付け（未設定は拒否）。金額0円で記録し、コインは**無償コイン**として付与（有償ロット・負債精算・初回ボーナスなし） | ライセンステストは既定で受け付け、0円。`GOOGLE_ACCEPT_TEST=0` で拒否 |

- 取引IDは `apple:<transactionId>` / `google:<orderId>` で保存し、プラットフォーム間で衝突しない。
- **1つのレシートは1人にしか付与されない**：全体の取引インデックス（AccountingDO の `store_tx`）に「取引ID・サブスクIDの持ち主」を先着で記録。サーバー通知もここで持ち主を探す。見つからない通知は 200 で受領して無視（アプリ側の購入処理が後で付与する）。
- 返金では、付与した有償コイン・初回ボーナス（無償／有償）・同梱アイテム、さらに購入の後にその購入で付与した分（厩舎手当の受け取り済みコイン、パスの有料ラインの報酬、パス＋の10段で届いた報酬）をすべて回収。使ってしまった分はコインの負債（`debt`）／アイテムの負債（`itemDebt`）になり、精算までガチャと購入が止まる。1回限りの商品は返金後も「購入済み」。
- 年齢は一度登録したら「若くなる方向」にしか変えられない（保護者同意の追加は可）。月額上限を超えた購入が記録された月は、以降の購入前チェックが `AGE_LIMIT_EXCEEDED` になり、`supportFlags` にサポート用の印が付く。

### 本番で必要な設定（`wrangler.toml` の vars / `wrangler secret put`）

| 名前 | 種別 | 内容 |
|---|---|---|
| `APPLE_BUNDLE_ID` | var | iOS の bundle id。未設定なら Apple は全て拒否 |
| `APPLE_ACCEPT_SANDBOX` | var | `1` で Sandbox を受け付け（無償コインとして付与）。未設定・`0` は拒否。本番は審査中のみ `1` |
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
| `*/5 * * * *` | 今シーズンのランキング集計（個人・タイムアタック・支部）をR2（`SNAPSHOTS`）へ（変化があった時だけ）＋前シーズンの締め（個人・支部報酬・支部対抗シーズンの最終順位と報酬）を1段階ずつ進める＋今シーズンの支部対抗シーズン（週の組み合わせ・遅れて来た支部の参加・終わった週の集計）＋イベント（開催中は集計、開始時に1回だけ通知、終了後は順位報酬を1段階ずつ配布） |
| `23 18 * * *`（03:23 JST） | リプレイログの保存期限切れを削除（保留中は残す） |
| `7 3 * * *`（12:07 JST） | シーズンのお知らせ（開幕・終了2日前・最終日）をFCMトピックへ1回だけ送る |

ローカルでは `wrangler dev --test-scheduled` で `/__scheduled?cron=*/5+*+*+*+*` を叩いて確認できる。

## プッシュ通知（`src/domain/push.ts`、`src/push/`）

- **送り方**：FCM HTTP v1。サービスアカウントのJWTからOAuthトークンを取り（`google/serviceAuth.ts`、Google Playと共通）、キャッシュする。
- **個別通知**（フレンド申請・フレンド成立・フレンド部屋への招待）はプレイヤーごとの送信待ち（outbox）に積み、**そのプレイヤーのDurable Objectのアラーム**で送る。リクエスト処理はFCMを待たない。
  - Cloudflare Queues を使わない理由：送信待ちはプレイヤーの保存領域にあり、アラームは退避・デプロイをまたいで確実に動く。再試行は次のアラームで済み、追加の有料バインディングが要らない。
  - 失敗時：`UNREGISTERED`・`INVALID_ARGUMENT`・`SENDER_ID_MISMATCH`（404/400/403）はその端末を削除。429/5xx/401 は `retry.backoffMs`（30秒→2分→10分→1時間、`Retry-After` が長ければそちら）で再送し、`maxAttempts` 回で諦める。TTLを過ぎたものは捨てる。
- **受信設定**：種類（season / friends / invites / events）ごとのオン・オフ、静かな時間帯（JST、既定22〜8時）、1日の上限（既定5件）。
  - 静かな時間帯：急ぎの通知（招待）は送らない。それ以外は静かな時間帯が明けるまで遅らせる。
- **一斉通知**（シーズンのお知らせ）はFCMトピック（`season_ja` など）に1回送るだけ。プレイヤー全員に個別に送らないので、人数が増えても費用が増えない。購読・解除はアプリ側（設定画面の結果 `topics` に従う）。
- 文言はすべて `master/push.json`（日本語テンプレート）。
- 設定：`FCM_PROJECT_ID`（var、省略時はサービスアカウントの `project_id`）、`FCM_SERVICE_ACCOUNT_JSON`（secret、省略時は `GOOGLE_SERVICE_ACCOUNT_JSON`）。未設定なら通知は積まれても送られずに捨てられる。
- 未対応：ランク戦の検証結果の通知（任意項目）。

## KPI計測（`src/domain/kpi.ts`）

- サーバーで分かるイベント（初回起動・購入・返金・ガチャ・レース結果・シーズン締め・フレンド・パスの更新）は、プレイヤーの処理が保存されたあとに Workers Analytics Engine（バインディング `ANALYTICS`、データセット `muchi_kpi`）へ書く。保存に失敗した処理のイベントは出ない。
- クライアントでしか分からないイベント（セッション・チュートリアルの各ステップ・画面・購入画面の操作・通知の開封など）は `POST /v1/analytics/events` で受ける。種類ごとにスキーマで検証し、時刻が7日より古いか5分より未来のものは捨てる。
- 個人情報は送らない。プレイヤーIDはソルト（secret `KPI_SALT`）付きSHA-256の先頭16桁に置き換える。`KPI_SALT` が無ければ何も書かない。
- 列の並びとクエリ（継続率・チュートリアル・初回課金・ARPDAU・課金率・パス継続・課金者と無課金者の勝率差）は `docs/ops/kpi-queries.md`。

## リワード広告（`src/domain/ads.ts`・`src/ads/ssv.ts`、REQ-AD-*）

- 任意の動画広告だけ（強制広告なし）。報酬は無償コインかタイムアタック+1回で、付与は広告ネットワークの SSV コールバック（ECDSA P-256 署名）からだけ。冪等（取引ID）・セッション・時刻のずれ・1日の上限（ゲーム日）で検証し、弾いたものは KPI `ad_reject` とサポート用の印。
- 鍵の組：`ADS_SSV_KEYS_URL`（ネットワークの公開鍵 JSON。isolate ごとに1日キャッシュ）か `ADS_SSV_KEYS`（固定、開発・結合テスト）。広告ユニットID は `ADS_AD_UNITS`。どれもリポジトリに本番の値を書かない。
- 設定は `master/progression.json` の `ads`（リモート設定で変更可、`adsProblems` で検証、上限は `ADS_HARD_LIMITS`）。経済の目標 E13 は docs/spec/balance-targets.md 4.9。

## 配合の拡張（`src/domain/stud.ts`・`studService.ts`・`horses.ts`、REQ-BREED-*）
- **種牡馬の貸し借り**：2人のPlayerDOにまたがる取引を、同じ操作IDで ①持ち主が確保 → ②借り手が支払い＋配合＋未送金記録（1トランザクション）→ ③持ち主が受取 → ④借り手が未送金を消す、の順に進める。どの段階も繰り返して安全。②失敗で①を戻し、③④が届かなければ借り手のアラームが再送（`retryMs` から倍々、最大1時間）。確保だけ残った枠は `reserveTtlMs` で失効。検索用の写しは DirectoryDO の `studs` 表（持ち主のシャード、公開一覧は全シャードから集める）。
- **料金は無償コインのみ**・1回 `feeMax`・持ち主の1日受取 `dailyEarnCap`・1頭1日 `dailyLimitMax`・借り手1日 `borrowPerDay`（`master/progression.json` の `stud`。リモート設定でも `STUD_HARD_LIMITS` は超えない）。理由は `docs/planning/03-legal-risk.md`。
- **隔世遺伝**：祖父母の脚質・馬場適性を `atavismPermille` で1つ継ぐ（能力値は変えない）。候補なしなら乱数の使い方は従来と同じ。予想の `atavism` は同じ関数から。
- **季節限定の馬**：`horses.json` の `seasonal`（期間）、バナーの `seasonal`（その馬を入れる）、閉じる天井グループ（期間後は恒常へ）。イベント報酬の `horse`。恒常バナー・券・CPUには出ない。期間後も所持は続く。

## 大会と観戦（`src/domain/tournaments.ts`・`spectate.ts`、`src/do/tournament.ts`、REQ-TOUR-* / REQ-SPEC-*）

- **大会**：1大会＝1つの TournamentDO（`tour:<id>`、一覧は `index`）。アラームで「受付締切→1回戦の組み分け（レート順のスネーク）→開始5分前の通知（`tournament_heat_soon`）→開始30秒前にヒートのレース部屋を作成→結果をポーリング→勝ち上がり→…→決勝→順位→賞品」を進める。cron（5分ごと）は開催中の大会を起こすだけの保険。
- ヒートは `mode: "tournament"`（ranked と同じ合意・検証、レートは動かない、能力上限は大会の `statCap`）。来なかった選手（一度も接続しない）はCPUが走り、勝ち上がれない。無効・消えたヒートは来た選手をシード順で勝ち上げる。同じラウンド・同じ着順で敗退した選手は同順位。
- 賞品は選手ごとに1回だけ（`tournamentClose`、プレイヤー側で大会IDごとに記録）。5回失敗したら失敗リスト（`tournament`）へ。
- **観戦**：レースを作ると MatchmakerDO の「ライブ一覧」（`l|<raceId>` 行、15分で消える）に載る。観戦者は slot -1 のチケットで同じ部屋の WebSocket に入り、選手に送信済みの確定入力だけを受け取る（ranked・イベント・大会は10秒遅れ、フレンド部屋はライブ）。部屋は観戦者を休止状態のまま保持し、アラームのたびに同じtick位置の観戦者へ同じ文字列を一括送信する。1部屋200人まで（`SPECTATOR_LIMIT`）。

## 未実装・要対応
- Apple / Google の実機・本番の認証情報での疎通確認（コードとテストは自前の証明書チェーン・偽APIで検証済み）
- 年齢帯ごとの月額上限の金額（`master/age-limits.json` は仮値・未確定）
- NGリストの本番版（`master/ng-names.json` は仮）
- マッチングは1シャード（`ranked-jp`）。規模に応じて地域・レート帯で分割する
