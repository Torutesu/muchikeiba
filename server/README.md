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
src/race/       レース作成（チケット発行）と精算（着順→報酬・レート）
src/http/       ルーター、Firebase IDトークン検証、レース入場チケット、ストアアダプタ
src/do/         Durable Objects（PlayerDO / RaceRoomDO / MatchmakerDO / AccountingDO）
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
| POST | `/v1/shop/purchase` | 要 | （取引IDで自動） | `{platform: apple\|google\|fake, productId, receipt}` |
| POST | `/v1/store/notifications/:platform` | なし | | ストアからの返金通知（Apple/Googleは署名検証の実装待ち、`fake`は開発用） |
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
| GET | `/v1/admin/paid-balance` | 管理 | | 有償コイン未使用残高の集計（資金決済法） |
| GET | `/v1/admin/replays/:raceId` | 管理 | | リプレイログ |

レース中のメッセージは `contracts/protocol.md` §4。

## 設計メモ
- お金・抽選・配合の乱数はすべてサーバー（`crypto.getRandomValues`）。端末の値は信用しない。
- PlayerService の各操作は状態のコピーに対して実行し、最後まで成功したときだけ保存（ガチャ途中の失敗で巻き戻る）。
- 有償コインは購入ごとの「ロット」で管理し、購入単価で円換算できる（基準日の未使用残高）。
- レース部屋は計算しない。tickを確定して入力を配り、結果ハッシュの合意を取るだけ。合意できない／人間1人のランク戦／通報／抜き取りは検証サーバーで再計算。検証サーバーに届かなければ無効。
- ゴールデン `contracts/golden/ts-config-*.json` はルールセットのファイルを埋め込むので、ルールセットを変えたら `npm run gen:golden`。

## 未実装・要対応
- Apple / Google のレシート検証と返金通知の署名検証（認証情報が必要。現状は全て拒否＝何も付与しない安全側）
- 年齢帯ごとの月額上限の金額（`master/age-limits.json` は仮値・未確定）
- NGリストの本番版（`master/ng-names.json` は仮）
- マッチングは1シャード（`ranked-jp`）。規模に応じて地域・レート帯で分割する
