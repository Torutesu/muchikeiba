# KPIクエリ集（Workers Analytics Engine SQL）

イベントはサーバー（`server/src/domain/kpi.ts`）が Analytics Engine のデータセット `muchi_kpi` に書き込みます。
クエリは Analytics Engine の SQL API（`POST https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql`、本文がSQL、`Authorization: Bearer <Account Analytics:Read 権限のトークン>`）に投げます。

## 前提

- **JOINは使えません**（1テーブルのみ。`FROM` のサブクエリは可）。そのため、どの行にも「インストール日（コホート）」「インストールからの日数」「課金者かどうか」を書き込んであります。
- **サンプリング**：大量の書き込みは間引かれることがあります。件数は `count()` ではなく `sum(_sample_interval)` で数えます。プレイヤーIDのハッシュを `index1` にしているので、間引きはプレイヤー単位で行われ、同じプレイヤーの行はまとまって残ります。ユニーク人数（`count(DISTINCT blob2)`）は、間引きが起きている期間は下振れします。
- **個人情報なし**：`blob2` はプレイヤーIDをソルト付きSHA-256でハッシュした値（16桁）です。ソルトはシークレット `KPI_SALT` で、これが無いと何も書き込まれません。
- 日付はすべて**日本時間（JST）**です。`blob5`/`blob6` は `YYYY-MM-DD` 形式の文字列です。
- **日の境目は暦（JST 0:00）**です。ゲームの日次リセット（ログボ・デイリーミッション・初勝利ボーナス・いいねの上限など）は 2026-12-01 04:00 JST から **4:00 JST** で切り替わります（`progression.dayRollover`、REQ-DAY-001〜004）。KPI の `blob5`/`blob6`/`double7`（D1・D7 継続率、ARPDAU、日別の課金率）は暦の日のままで、ストアや他のダッシュボードの数字と比べられます。そのため 0:00〜3:59 のプレイは「暦では翌日・ゲームでは前日」になります：
  - 「1日あたりのログボ受け取り数」「デイリーミッション完了率」など**ゲーム日で数えたい**指標は、`timestamp` を UTC+5時間（= JST − 4時間）ずらして日付にします：`formatDateTime(timestamp + INTERVAL '5' HOUR, '%Y-%m-%d') AS game_day`（2026-12-01 04:00 JST より前は `+ INTERVAL '9' HOUR`）。`timestamp` は書き込み時刻なので、クライアントイベントは端末時刻（`at`）と数秒ずれることがあります。
  - 切り替えの日（2026-12-01）はゲーム日が28時間あります。日別の指標でこの日だけ約17%多く見えるのは仕様です（12-01 と 12-02 を比べる時は注意）。
  - 0:00〜3:59 のプレイの割合（深夜の取りこぼしがどれだけ減ったか）は `toHour(timestamp + INTERVAL '9' HOUR) < 4` で数えます。

## 列の対応（並び替え禁止）

| 列 | 内容 |
|---|---|
| `index1` | プレイヤー（ハッシュ） |
| `blob1` | イベント名 |
| `blob2` | プレイヤー（ハッシュ） |
| `blob3` | プラットフォーム（クライアントイベントのみ：`ios`/`android`/`editor`） |
| `blob4` | アプリのバージョン（クライアントイベントのみ） |
| `blob5` | インストール日（コホート、JST） |
| `blob6` | イベント日（JST） |
| `blob7` | `payer` / `nonpayer`（イベント時点で返金されていない実課金があるか） |
| `blob8`〜`blob10` | イベントごとの文字列 s1〜s3（下表） |
| `blob11` | `server` / `client` |
| `double1` | 金額（円、返金はマイナス） |
| `double2` / `double3` | 有償コイン / 無償コイン |
| `double4` | 着順・順位 |
| `double5` | 件数（ガチャ回数・出走頭数など） |
| `double6` | 時間（ミリ秒） |
| `double7` | インストールからの日数（JST、0 = インストール当日） |
| `double8` | 初回フラグ（1 = 初めての実課金） |
| `double9` | 汎用の値 |

## イベント一覧

| イベント（`blob1`） | 送り元 | s1（`blob8`） | s2（`blob9`） | s3（`blob10`） | 数値 |
|---|---|---|---|---|---|
| `first_open` | サーバー（初回の bootstrap） | | | | |
| `login_bonus` | サーバー | | | | `double9` = 連続日数 |
| `purchase` | サーバー（レシート検証後） | 商品ID | ストア | `real`/`sandbox` | `double1` 円、`double2`/`double3` 付与コイン、`double8` 初回 |
| `refund` | サーバー | 商品ID | ストア | | `double1` = −円 |
| `pass_renew` | サーバー（ストア通知） | 商品ID | ストア | | `double1` 円 |
| `pass_status` | サーバー（ストア通知） | 状態（`expired`/`grace`/`canceled` など） | ストア | | |
| `gacha_draw` | サーバー | バナーID | | | `double5` 回数、`double2`/`double3` 消費、`double9` SSR数 |
| `stud_breed` | サーバー | 種牡馬の持ち主ID | 種牡馬ID | | `double5` 回数、`double3` 種付け料（無償コイン）、`double9` 隔世遺伝が出たら1 |
| `tutorial_gacha` | サーバー | | | | |
| `race_finish` | サーバー（レース確定時） | モード | 脚質 | コースID | `double4` 着順、`double5` 頭数、`double9` 人間の数、`double6` ゴールタイム |
| `season_close` | サーバー | シーズン | 前のクラス | 次のクラス | `double4` 順位 |
| `friend_request` / `friend_accept` | サーバー | | | | |
| `stable_save` | サーバー（マイ厩舎の保存、REQ-STABLE-010） | テーマID | | | `double5` 飾りの数、`double9` 選んだ馬の数 |
| `stable_visit` | サーバー（他人の厩舎を見た。書き込みなし） | `friend`/`other` | | | |
| `stable_like` | サーバー（いいね。コインは付かない） | `friend`/`other` | | | `double9` 今日の残り回数 |
| `session_start` / `session_end` | クライアント | | | | `double6` セッションの長さ |
| `tutorial_step` | クライアント | ステップ名（固定の8つ：`consent` 1, `race1_start` 2, `race1_whip` 3, `race1_win` 4, `named` 5, `gacha_done` 6, `race2_done` 7, `home` 8） | | | `double9` ステップ番号、`double5` 任意の数値（`race1_win` はやり直し回数）。REQ-UXS-030 |
| `feature_unlock` | クライアント | 機能キー（`unlocks` のキー） | | | |
| `offer_view` / `offer_click` | クライアント | オファーID | きっかけ `T1`〜`T8`（docs/planning/06 §5.1） | | |
| `race_quit` | クライアント | モード | | | `double9` 残り距離(m) |
| `account_link` | クライアント | `apple`/`google` | | | |
| `share` | クライアント（リプレイをOSの共有に渡した。キャンセルは送らない、REQ-UXS-072） | `replay_video`/`replay_image` | | | |
| `ad_offer_view` | クライアント（リワード広告のカードを出した。画面ごとに1回、REQ-AD-010） | 枠ID | 画面 `home`/`result`/`time_attack`/`shop` | | |
| `ad_start` | クライアント（カードを押した後の SDK の結果） | 枠ID | 画面 | `shown`/`no_fill`/`failed`/`closed_early` | |
| `ad_reward` | サーバー（SSV コールバックで付与した。クライアントからは送れない） | 枠ID | ネットワーク（`admob`） | 画面 | `double3` 無償コイン、`double9` タイムアタックの回数、`double5` その日の回数 |
| `ad_reject` | サーバー（コールバックを弾いた） | 理由（`user_mismatch`/`unknown_session`/`session_used`/`expired`/`clock_skew`/`ad_unit_mismatch`/`cap`/`deleting`） | 枠ID | ネットワーク | `double5` その日の弾いた数 |
| `consent` | サーバー | 規約の版 | プライバシーポリシーの版 | | |
| `partner_granted` | サーバー | テンプレートID（`t_partner`） | | | |
| `ab_assign` | サーバー（初回の bootstrap、実験ごとに1回） | 実験ID | バケットID | | |
| `account_delete` | サーバー | `requested`/`cancelled`/`deleted` | | | `deleted` は `double2`/`double3` 放棄したコイン |
| `screen_view` | クライアント | 画面名 | | | |
| `client_race_start` | クライアント | モード | | | |
| `purchase_flow` | クライアント | `open`/`cancel`/`fail`/`store_success` | 商品ID | | |
| `push_open` | クライアント | テンプレートID | | | |
| `push_permission` | クライアント | | | | `double9` 1 = 許可 |

## リワード広告（REQ-AD-010、contracts/protocol.md §18）

カードの表示 → 再生 → 付与の流れを枠ごとに見ます（7日間）。`ad_start` の `shown` に対して `ad_reward` が少ないときは、SSV コールバックが届いていない（設定・鍵・ネットワーク側の遅れ）か、弾かれています（下の `ad_reject`）。

```sql
SELECT blob8 AS placement,
  sumIf(_sample_interval, blob1 = 'ad_offer_view') AS offer_views,
  sumIf(_sample_interval, blob1 = 'ad_start') AS starts,
  sumIf(_sample_interval, blob1 = 'ad_start' AND blob10 = 'shown') AS shown,
  sumIf(_sample_interval, blob1 = 'ad_start' AND blob10 = 'no_fill') AS no_fill,
  sumIf(_sample_interval, blob1 = 'ad_reward') AS rewarded,
  round(sumIf(_sample_interval, blob1 = 'ad_reward') / sumIf(_sample_interval, blob1 = 'ad_start' AND blob10 = 'shown'), 3) AS reward_per_shown,
  round(sumIf(_sample_interval, blob1 = 'ad_start') / sumIf(_sample_interval, blob1 = 'ad_offer_view'), 3) AS start_rate
FROM muchi_kpi
WHERE blob1 IN ('ad_offer_view', 'ad_start', 'ad_reward') AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY placement
ORDER BY placement
```

弾いた理由の内訳（不正の兆候：`user_mismatch`・`session_used`・`clock_skew` が急に増えたら調べる。1日に5件を超えたプレイヤーにはサポート用の印 `ads_anomaly:<ゲーム日>` が付きます）：

```sql
SELECT blob8 AS reason, sum(_sample_interval) AS n, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'ad_reject' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY reason
ORDER BY n DESC
```

広告を見る人の割合と1人あたりの無償コイン（課金者は既定で30日間広告が出ないので、`blob7` で分けて確かめる。課金者の行が多いなら設定でオンにした人です）：

```sql
SELECT blob6 AS day, blob7 AS payer,
  count(DISTINCT blob2) AS watchers,
  sum(_sample_interval * double3) / count(DISTINCT blob2) AS free_coins_per_watcher
FROM muchi_kpi
WHERE blob1 = 'ad_reward' AND timestamp > NOW() - INTERVAL '14' DAY
GROUP BY day, payer
ORDER BY day DESC, payer
```

ゲーム日で数えたいとき（1日の上限はゲーム日）は「前提」の `formatDateTime(timestamp + INTERVAL '5' HOUR, '%Y-%m-%d')` を使います。

## 継続率（D1 / D7 / D30）

内側で「プレイヤー×インストールからの日数」に1行ずつまとめ、外側でコホートごとに数えます。

```sql
SELECT
  cohort,
  countIf(d = 0)  AS installs,
  countIf(d = 1)  AS d1,
  countIf(d = 7)  AS d7,
  countIf(d = 30) AS d30,
  round(countIf(d = 1)  / countIf(d = 0), 3) AS d1_rate,
  round(countIf(d = 7)  / countIf(d = 0), 3) AS d7_rate,
  round(countIf(d = 30) / countIf(d = 0), 3) AS d30_rate
FROM (
  SELECT blob5 AS cohort, blob2 AS player, double7 AS d
  FROM muchi_kpi
  WHERE timestamp > NOW() - INTERVAL '45' DAY
    AND double7 IN (0, 1, 7, 30)
  GROUP BY cohort, player, d
)
GROUP BY cohort
ORDER BY cohort DESC
```

インストール当日は `first_open` が必ず出るので、0日目の分母が欠けることはありません。何かしらのイベントがあれば「その日に来た」とみなします。

## チュートリアルの通過率

```sql
SELECT blob8 AS step, double9 AS idx, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'tutorial_step' AND timestamp > NOW() - INTERVAL '14' DAY
GROUP BY step, idx
ORDER BY idx
```

各ステップの人数を、同じ期間の `first_open` の人数で割ると通過率になります。

```sql
SELECT count(DISTINCT blob2) AS installs FROM muchi_kpi
WHERE blob1 = 'first_open' AND timestamp > NOW() - INTERVAL '14' DAY
```

## FTUE の段階別通過率（REQ-UXS-031、docs/planning/06 §8.1 (a)）

段階2（同意）〜10（ホーム）。各段の人数を前の段で割ると段ごとの通過率（目標：各段95%以上、全体85%以上）。
2戦目は `race_finish`（ranked）でも数えられるので、`race2_done` と並べて確認できます。

```sql
SELECT
  blob5 AS cohort,
  count(DISTINCT if(blob1 = 'first_open', blob2, NULL)) AS installs,
  count(DISTINCT if(blob1 = 'tutorial_step' AND blob8 = 'consent', blob2, NULL)) AS s2_consent,
  count(DISTINCT if(blob1 = 'tutorial_step' AND blob8 = 'race1_start', blob2, NULL)) AS s3_race1_start,
  count(DISTINCT if(blob1 = 'tutorial_step' AND blob8 = 'race1_whip', blob2, NULL)) AS s4_race1_whip,
  count(DISTINCT if(blob1 = 'tutorial_step' AND blob8 = 'race1_win', blob2, NULL)) AS s5_race1_win,
  count(DISTINCT if(blob1 = 'tutorial_step' AND blob8 = 'named', blob2, NULL)) AS s6_named,
  count(DISTINCT if(blob1 = 'tutorial_step' AND blob8 = 'gacha_done', blob2, NULL)) AS s7_gacha_done,
  count(DISTINCT if(blob1 = 'tutorial_step' AND blob8 = 'race2_done', blob2, NULL)) AS s8_race2_done,
  count(DISTINCT if(blob1 = 'push_permission', blob2, NULL)) AS s9_push_asked,
  count(DISTINCT if(blob1 = 'tutorial_step' AND blob8 = 'home', blob2, NULL)) AS s10_home
FROM muchi_kpi
WHERE timestamp > NOW() - INTERVAL '14' DAY AND double7 = 0
GROUP BY cohort
ORDER BY cohort DESC
```

## オファー別の表示→購入（REQ-UXS-031 (b)）

表示・押した人数はクライアントイベント、購入はサーバーの `purchase`（同じ期間）。オファーIDが商品IDと同じものは購入率まで並びます。

```sql
SELECT
  blob8 AS offer, blob9 AS trigger,
  sumIf(_sample_interval, blob1 = 'offer_view') AS views,
  sumIf(_sample_interval, blob1 = 'offer_click') AS clicks,
  round(sumIf(_sample_interval, blob1 = 'offer_click') / sumIf(_sample_interval, blob1 = 'offer_view'), 3) AS ctr
FROM muchi_kpi
WHERE blob1 IN ('offer_view', 'offer_click') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY offer, trigger
ORDER BY views DESC
```

```sql
SELECT blob8 AS product, sum(_sample_interval) AS purchases, sumIf(_sample_interval, double8 = 1) AS first_purchases
FROM muchi_kpi
WHERE blob1 = 'purchase' AND blob10 = 'real' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY product
ORDER BY purchases DESC
```

## 初レースのやり直し回数の分布（REQ-UXS-031 (c)）

```sql
SELECT double5 AS retries, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'tutorial_step' AND blob8 = 'race1_win' AND timestamp > NOW() - INTERVAL '14' DAY
GROUP BY retries
ORDER BY retries
```

## 2戦目の着順分布（REQ-UXS-031 (d)、目標：3着以内70%以上 = balance-targets R10）

インストール当日の最初のランク戦を見るため、ランク戦の着順を人ごとに最小の時刻で取ります。

```sql
SELECT place, count() AS players, round(count() / sum(count()) OVER (), 3) AS share
FROM (
  SELECT blob2 AS player, argMin(double4, timestamp) AS place
  FROM muchi_kpi
  WHERE blob1 = 'race_finish' AND blob8 = 'ranked' AND double7 <= 1 AND timestamp > NOW() - INTERVAL '14' DAY
  GROUP BY player
)
GROUP BY place
ORDER BY place
```

`argMin` や窓関数が使えない場合は、`tutorial_step`/`race2_done` の直前の `race_finish` を見る代わりに `countIf(double4 <= 3) / count()` を `double7 = 0` の ranked で出します（初日のランク戦はほぼ初心者マッチ）。

```sql
SELECT round(countIf(double4 <= 3) / count(), 3) AS top3_rate, count() AS races
FROM muchi_kpi
WHERE blob1 = 'race_finish' AND blob8 = 'ranked' AND double7 = 0 AND timestamp > NOW() - INTERVAL '14' DAY
```

## A/B のバケット別（REQ-UXS-032）

`ab_assign` は実験ごとに1人1行。JOIN が使えないので、内側で人ごとに「どのバケットか」と「指標」を同時に集め、外側でバケット別に数えます（例：実験 `ab_home_button` のD1継続）。

```sql
SELECT bucket_b, count() AS players, countIf(came_d1) AS d1, round(countIf(came_d1) / count(), 3) AS d1_rate
FROM (
  SELECT blob2 AS player,
    countIf(blob1 = 'ab_assign' AND blob8 = 'ab_home_button' AND blob9 = 'b') > 0 AS bucket_b,
    countIf(blob1 = 'ab_assign' AND blob8 = 'ab_home_button') > 0 AS assigned,
    countIf(double7 = 1) > 0 AS came_d1
  FROM muchi_kpi
  WHERE timestamp > NOW() - INTERVAL '30' DAY
  GROUP BY player
)
WHERE assigned
GROUP BY bucket_b
```

価格・中身はA/Bにしない（設定の検証で拒否される）ので、売上の差はきっかけ・順番・文言の差です。

## 初回課金の転換率と、課金までの日数

```sql
SELECT
  blob5 AS cohort,
  sumIf(_sample_interval, blob1 = 'first_open') AS installs,
  sumIf(_sample_interval, blob1 = 'purchase' AND double8 = 1) AS first_purchasers,
  round(sumIf(_sample_interval, blob1 = 'purchase' AND double8 = 1) / sumIf(_sample_interval, blob1 = 'first_open'), 4) AS conversion
FROM muchi_kpi
WHERE timestamp > NOW() - INTERVAL '60' DAY
GROUP BY cohort
ORDER BY cohort DESC
```

```sql
SELECT
  quantileExactWeighted(0.5)(double7, _sample_interval) AS median_days,
  quantileExactWeighted(0.9)(double7, _sample_interval) AS p90_days,
  sum(_sample_interval) AS first_purchasers
FROM muchi_kpi
WHERE blob1 = 'purchase' AND double8 = 1 AND timestamp > NOW() - INTERVAL '90' DAY
```

## ARPDAU と課金率（日別）

内側で「日×プレイヤー」に1行ずつまとめ（その日の売上と、課金者かどうか）、外側で日ごとに集計します。

```sql
SELECT
  day,
  count() AS dau,
  countIf(payer = 'payer') AS payers_active,
  round(countIf(payer = 'payer') / count(), 4) AS payer_rate,
  sum(rev) AS revenue_yen,
  round(sum(rev) / count(), 1) AS arpdau_yen
FROM (
  SELECT
    blob6 AS day, blob2 AS player,
    max(blob7) AS payer,  -- 'payer' > 'nonpayer'（文字列比較）なので、その日に一度でも課金者なら payer
    sumIf(double1 * _sample_interval, blob1 IN ('purchase', 'pass_renew', 'refund') AND blob10 != 'sandbox') AS rev
  FROM muchi_kpi
  WHERE timestamp > NOW() - INTERVAL '30' DAY
  GROUP BY day, player
)
GROUP BY day
ORDER BY day DESC
```

`payers_active` は、その日に来た課金者（過去に課金した人）の人数です。その日に課金した人数を見たい場合は、内側で `sumIf(_sample_interval, blob1 = 'purchase') > 0` を数えます。

## シーズンパスの継続

`pass_renew` は2回目以降の更新、`purchase` の `blob8 = 'season_pass'` は初回購入です。

```sql
SELECT
  substring(blob6, 1, 7) AS month,
  sumIf(_sample_interval, blob1 = 'purchase' AND blob8 = 'season_pass') AS new_subs,
  sumIf(_sample_interval, blob1 = 'pass_renew') AS renewals,
  sumIf(_sample_interval, blob1 = 'pass_status' AND blob8 = 'expired') AS expirations,
  sumIf(_sample_interval, blob1 = 'pass_status' AND blob8 = 'canceled') AS auto_renew_off
FROM muchi_kpi
WHERE timestamp > NOW() - INTERVAL '180' DAY
GROUP BY month
ORDER BY month DESC
```

月ごとの継続率は、`renewals(当月) / (new_subs + renewals)(前月)` で出します。

## 課金者と無課金者のランク戦勝率の差（バランスのガードレール）

企画書の約束は「課金で勝ちは買えない」です。週ごとに見て、差が [目標] を超えたら正規化の上限を見直します。

```sql
SELECT
  blob7 AS segment,
  sum(_sample_interval) AS races,
  sumIf(_sample_interval, double4 = 1) AS wins,
  round(sumIf(_sample_interval, double4 = 1) / sum(_sample_interval), 4) AS win_rate,
  round(sumIf(_sample_interval, double4 <= 3) / sum(_sample_interval), 4) AS top3_rate,
  round(avg(double4), 2) AS avg_place
FROM muchi_kpi
WHERE blob1 = 'race_finish' AND blob8 = 'ranked' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY segment
```

頭数（`double5`）が違うレースが混ざるので、頭数でも分けて見るなら `GROUP BY segment, double5` にします。

## 脚質ごとの勝率（調整の監視）

```sql
SELECT blob9 AS style, sum(_sample_interval) AS rides,
  round(sumIf(_sample_interval, double4 = 1) / sum(_sample_interval), 4) AS win_rate
FROM muchi_kpi
WHERE blob1 = 'race_finish' AND blob8 = 'ranked' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY style
ORDER BY win_rate DESC
```

## 離脱の兆候

最後に来た日が7日以上前の人数を、コホートごとに数えます。サブクエリでプレイヤーごとの最終日を出しています。

```sql
SELECT cohort, count() AS players, countIf(last_seen < NOW() - INTERVAL '7' DAY) AS inactive_7d
FROM (
  SELECT blob5 AS cohort, blob2 AS player, max(timestamp) AS last_seen
  FROM muchi_kpi
  WHERE timestamp > NOW() - INTERVAL '60' DAY
  GROUP BY cohort, player
)
GROUP BY cohort
ORDER BY cohort DESC
```

あわせて見る指標：`session_end` の `double6`（セッションの長さ）の中央値の推移、`push_permission` で拒否した割合、`purchase_flow` の `cancel`/`fail` の割合。

## 注意

- Analytics Engine のデータ保持期間は有限（現時点で約3か月）です。長期の推移はこのクエリ結果を毎月どこかに書き出して残します。
- サンドボックスとテスト購入は `blob10 = 'sandbox'` で、金額は0円です。売上の計算では除外しています。
- 関数の対応は [SQL reference](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/) を参照してください。`countIf`/`sumIf`/`quantileExactWeighted`/`if`/`count(DISTINCT …)`/`FROM` のサブクエリは使えます。`JOIN`/`UNION` は使えません。
