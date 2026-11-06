# KPIクエリ集（Workers Analytics Engine SQL）

イベントはサーバー（`server/src/domain/kpi.ts`）が Analytics Engine のデータセット `muchi_kpi` に書き込みます。
クエリは Analytics Engine の SQL API（`POST https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql`、本文がSQL、`Authorization: Bearer <Account Analytics:Read 権限のトークン>`）に投げます。

## 前提

- **JOINは使えません**（1テーブルのみ。`FROM` のサブクエリは可）。そのため、どの行にも「インストール日（コホート）」「インストールからの日数」「課金者かどうか」を書き込んであります。
- **サンプリング**：大量の書き込みは間引かれることがあります。件数は `count()` ではなく `sum(_sample_interval)` で数えます。プレイヤーIDのハッシュを `index1` にしているので、間引きはプレイヤー単位で行われ、同じプレイヤーの行はまとまって残ります。ユニーク人数（`count(DISTINCT blob2)`）は、間引きが起きている期間は下振れします。
- **個人情報なし**：`blob2` はプレイヤーIDをソルト付きSHA-256でハッシュした値（16桁）です。ソルトはシークレット `KPI_SALT` で、これが無いと何も書き込まれません。
- 日付はすべて**日本時間（JST）**です。`blob5`/`blob6` は `YYYY-MM-DD` 形式の文字列です。

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
| `session_start` / `session_end` | クライアント | | | | `double6` セッションの長さ |
| `tutorial_step` | クライアント | ステップ名 | | | `double9` ステップ番号 |
| `screen_view` | クライアント | 画面名 | | | |
| `client_race_start` | クライアント | モード | | | |
| `purchase_flow` | クライアント | `open`/`cancel`/`fail`/`store_success` | 商品ID | | |
| `push_open` | クライアント | テンプレートID | | | |
| `push_permission` | クライアント | | | | `double9` 1 = 許可 |

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
