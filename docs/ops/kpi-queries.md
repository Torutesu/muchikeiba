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
| `hof_induct` | サーバー（引退で殿堂入り、REQ-HOF-016） | 理由（`wins`/`tournament`/`partner` を `+` でつなぐ） | `partner`/空 | | `double5` 戦数、`double9` 勝数 |
| `hof_view` | サーバー（殿堂を見た。書き込みなし） | `self`/`friend`/`team` | | | `double9` そのページの銘板の数 |
| `stamp_post` | サーバー（支部フィードにスタンプを投稿・応援した、REQ-TEAMFEED-009） | スタンプID | `post`/`reaction` | 支部ID | |
| `team_feed_view` | サーバー（支部フィードの1ページ目を開いた） | 支部ID | | | `double5` ミュートしている人数 |
| `qchat_post` | サーバー（支部の定型チャットを投稿した、REQ-QCHAT-011） | 文ID | 支部ID | `mention`/空 | `double5` スロットの数 |
| `qchat_react` | サーバー（定型チャットに新しくスタンプで応援した） | スタンプID | 文ID | 支部ID | |
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
| `training_start` | サーバー（調教を始めた、REQ-TRAIN-014） | メニュー（`hill`/`wood`/`pool`/`awase`） | 馬のレア度 | | `double9` 開始時の疲れ、`double5` 今日の回数 |
| `training_done` | サーバー（調教を記録した） | メニュー | 評価 `great`/`good`/`normal` | `done`/`skipped`/`expired` | `double9` 伸びの合計、`double5` ミニゲームの点数、`double8` そのアカウントの初回 |
| `assist_enable` | サーバー（かんたん操作をオンにした・レベルを変えた、REQ-ASSIST-011） | `whip`/`full` | `settings`/`prompt` | 前のレベル | `double9` その時の最下位の連続、`double8` 初めてオンにした |
| `assist_disable` | サーバー（かんたん操作をオフにした） | 前のレベル | `settings`/`prompt` | | |
| `assist_prompt_view` | サーバー（一度だけの提案シートが出た） | | | | `double9` 最下位の連続 |
| `race_assisted` | サーバー（かんたん操作ありで精算されたレース。本人の申告、KPI専用） | `whip`/`full` | モード | | `double4` 着順、`double5` 頭数 |
| `a11y_setting_change` | サーバー（アクセシビリティ設定の PUT で値が変わったキーごとに1行、REQ-A11Y-014） | キー `textSize`/`colorMode`/`reduceMotion`/`haptics`/`subtitles`/`oneHanded`/`whipInput` | 新しい値（真偽は `on`/`off`） | `settings` | |
| `event_point_earn` | サーバー（イベントのレースでイベントポイントを得た、REQ-EXCH-010） | イベントID | `full` / `capped`（1日の上限で削られた） | | `double4` 着順、`double9` 得たポイント、`double5` 所持ポイント |
| `exchange_buy` | サーバー（イベント交換所で交換した） | イベントID | 行のID | 種類 `coins`/`material`/`ticket`/`cosmetic`/`horse` | `double5` 個数、`double9` 使ったポイント |
| `challenge_start` | サーバー（週替わりチャレンジを始めた、REQ-WCH-014） | チャレンジ id | 週 id | `loan`/`own` | `double5` 今週そのチャレンジを始めた回数 |
| `challenge_clear` | サーバー（検証済みの走りでクリア） | チャレンジ id | 週 id | `loan`/`own` | `double4` 着順、`double6` タイム（ms）、`double5` 今週のクリア数、`double8` 今週の初クリア、`double9` 1 = この回でバッジ、`double3` 付与した無償コイン |
| `silks_edit` | サーバー（勝負服エディタで装備が変わった：`PUT /v1/silks`・プリセットの適用、REQ-SILK-014） | コード | `editor`/`preset` | | `double9` 無料でないパーツの数、`double5` プリセットの数 |
| `silks_part_buy` | サーバー（勝負服のパーツを買った：エディタ・ショップの見た目タブのどちらでも） | itemId | パーツの種類 `pattern`/`color`/`sleeve`/`cap` | `any`/`paidOnly` | `double2` 有償コイン、`double3` 無償コイン、`double9` 価格 |
| `commentary_pack_equip` | サーバー（実況パックを装備した、REQ-CMT-012） | パック | 前のパック | `settings`/`shop`/`buy` | `double8` 初めて標準以外を装備 |
| `commentary_pack_buy` | サーバー（実況パックをコインで買った） | パック | 通貨 `any`/`paidOnly` | | `double2` 有償コイン、`double3` 無償コイン、`double9` 値段 |
| `commentary_pack_sample` | クライアント（試聴を始めた） | パック | `owned`/`not_owned` | | |
| `consent` | サーバー | 規約の版 | プライバシーポリシーの版 | | |
| `consent_change` | サーバー（広告・分析の同意が変わった項目ごとに1行、必須のイベント、REQ-CNS-014） | `personalized_ads`／`analytics`／`att`／`cmp` | 新しい値 | `prompt`／`settings`／`platform` | |
| `partner_granted` | サーバー | テンプレートID（`t_partner`） | | | |
| `ab_assign` | サーバー（初回の bootstrap、実験ごとに1回） | 実験ID | バケットID | | |
| `account_delete` | サーバー | `requested`/`cancelled`/`deleted` | | | `deleted` は `double2`/`double3` 放棄したコイン |
| `comeback_start` | サーバー（休眠からの復帰で期間が始まった、REQ-CB-002） | 段階 `short`/`mid`/`long` | | | `double9` 休眠したゲーム日数、`double5` そのプレイヤーの何回目の期間か |
| `comeback_day` | サーバー（復帰ログボの受け取り、REQ-CB-004） | 段階 | | | `double9` 何日目（1〜7） |
| `comeback_complete` | サーバー（復帰ログボ7日とミッションを全部受け取った、REQ-CB-005） | 段階 | | | `double9` 期間の何日目に完了したか |
| `achievement_unlock` | サーバー（実績の段に届いた、1段1回、REQ-ACH-003） | 実績ID | カテゴリ（race/course/skill/breeding/time_attack/tournament/stable/team） | metric | `double9` 段、`double5` その時の進み具合 |
| `achievement_claim` | サーバー（実績の段の無償コインを受け取った、REQ-ACH-005） | 実績ID | カテゴリ | | `double9` 段、`double3` 無償コイン |
| `screen_view` | クライアント | 画面名 | | | |
| `client_race_start` | クライアント | モード | | | |
| `purchase_flow` | クライアント | `open`/`cancel`/`fail`/`store_success` | 商品ID | | |
| `push_open` | クライアント | テンプレートID | | | |
| `push_permission` | クライアント | | | | `double9` 1 = 許可 |
| `invite_share` | クライアント（招待コードを共有シートに渡した／コピーした。キャンセルは送らない、REQ-INV-011） | `os_share`/`copy_code`/`copy_link` | | | |
| `invite_redeem` | サーバー（招待コードの引き換え。1回で2行） | | `inviter`/`invitee` | | 招待した人の行：`double9` 1 = 報酬の対象（上限内）。招待された人の行：`double3` ギフトの無償コイン、`double5` ギフトの券の枚数 |
| `invite_milestone` | サーバー（招待された人の到達。双方に1行） | マイルストーンID | `invitee`/`inviter` | | 招待した人の行：`double3` 無償コイン、`double5` 券の枚数（上限外は行が出ない） |

## リワード広告（REQ-AD-010、contracts/protocol.md §21）

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

## 復帰者のコホート（REQ-CB-012）

`comeback_start` の日を「復帰日」として、復帰者ごとに復帰日からの経過日数で継続を数えます。JOIN もウィンドウ関数も無いので2段階にします。

1. 復帰者と復帰日（段階・休眠日数つき）を出す：

```sql
SELECT blob2 AS player, blob8 AS tier, min(timestamp) AS returned_at, max(double9) AS lapse_days
FROM muchi_kpi
WHERE blob1 = 'comeback_start' AND timestamp > NOW() - INTERVAL '75' DAY
GROUP BY player, tier
```

2. 同じ復帰日の人をまとめて（例：段階 `mid`、復帰日 `2026-11-17`）、その人たちの活動日を数える。`blob2 IN (…)` に 1 の結果の `player` を入れる（多い時は分割）。R1 / R7 / R14 / R30 は復帰日の翌日・7日後・期間の終わり（14日後）・30日後に何かのイベントがあった割合：

```sql
SELECT
  count() AS returners,
  round(countIf(d1)  / count(), 3) AS r1_rate,
  round(countIf(d7)  / count(), 3) AS r7_rate,
  round(countIf(d14) / count(), 3) AS r14_rate,
  round(countIf(d30) / count(), 3) AS r30_rate,
  round(countIf(done) / count(), 3) AS complete_rate
FROM (
  SELECT blob2 AS player,
    max(blob6 = '2026-11-18') AS d1, max(blob6 = '2026-11-24') AS d7, max(blob6 = '2026-12-01') AS d14, max(blob6 = '2026-12-17') AS d30,
    max(blob1 = 'comeback_complete') AS done
  FROM muchi_kpi
  WHERE timestamp >= toDateTime('2026-11-17 00:00:00') AND blob2 IN ('<player>', '<player>')
  GROUP BY player
)
```

比較の対照には、同じ日に休眠明けで来たが期間が始まらなかった人（`comeback_start` が無い人：クールダウン中・休眠前のレース不足）を同じ式で数えます。

復帰ログボの何日目まで受け取ったかの分布（期間中の離脱の場所）：

```sql
SELECT blob8 AS tier, double9 AS day, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'comeback_day' AND timestamp > NOW() - INTERVAL '45' DAY
GROUP BY tier, day
ORDER BY tier, day
```

あわせて見る指標：`push_open` の `blob8 = 'lapse_3d'` / `'lapse_7d'`（呼び戻しの通知からの起動。種類 `comeback` はオプトイン）、復帰者の `purchase`（`comeback_<期間ID>` のオファーは通常のパスの案内なので売上の上乗せではなく、復帰後の課金率として見る）。

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

## 友達招待：バイラル係数（REQ-INV-011、contracts/protocol.md §19）

`invite_redeem` は1回の引き換えで2行出ます（`blob9` = `inviter`：招待した人の行、`invitee`：招待された人の行）。招待した人の行には **招待した人のコホート** が入るので、JOIN なしで「コホートの1人が何人を呼んだか」を数えられます。

**バイラル係数 K**（コホートごと、インストールから30日以内に呼んだ人数 ÷ コホートの人数）。招待した人の行の `double9` は報酬の対象（上限10人以内）なら1。

```sql
SELECT
  cohort,
  countIf(ev = 'first_open') AS installs,
  countIf(ev = 'invite_redeem' AND role = 'inviter' AND d <= 30) AS invited_30d,
  round(countIf(ev = 'invite_redeem' AND role = 'inviter' AND d <= 30) / countIf(ev = 'first_open'), 3) AS k_30d,
  countIf(ev = 'invite_share' AND d <= 30) AS shares_30d,
  round(countIf(ev = 'invite_redeem' AND role = 'inviter' AND d <= 30) / countIf(ev = 'invite_share' AND d <= 30), 3) AS redeem_per_share
FROM (
  SELECT blob5 AS cohort, blob1 AS ev, blob9 AS role, double7 AS d, _sample_interval AS w
  FROM muchi_kpi
  WHERE timestamp > NOW() - INTERVAL '75' DAY
    AND blob1 IN ('first_open', 'invite_redeem', 'invite_share')
)
GROUP BY cohort
ORDER BY cohort DESC
```

- サンプリングが起きている期間は `countIf(…)` を `sumIf(w, …)` にします。
- K < 1 が普通です（招待だけでは増え続けない）。インストールのうち招待経由の割合は `invite_redeem` の `invitee` の行 ÷ `first_open`（同じコホート、`double7 <= 7`）。
- 招待経由の人の継続率は、`invite_redeem`（`invitee`）を出したプレイヤーだけで「継続率」のクエリを回します（内側のサブクエリで `blob2 IN (SELECT …)` は使えないので、先にプレイヤーの一覧を取り出して `blob2 IN ('…', …)` で絞る）。

**到達率**（招待された人が本当に遊んだか。報酬はこの行でだけ出る）：

```sql
SELECT
  blob8 AS milestone,
  countIf(blob9 = 'invitee') AS reached,
  countIf(blob9 = 'inviter' AND double3 + double5 > 0) AS rewarded
FROM muchi_kpi
WHERE blob1 = 'invite_milestone' AND timestamp > NOW() - INTERVAL '60' DAY
GROUP BY milestone
```

`reached` と `rewarded` の差は、上限を超えた招待（報酬なし）・削除された招待した人・配達待ち。

**不正の監視**：サーバーのサポート用フラグ（`supportFlags`：`invite_burst:<日>`、`invite_install_reuse:…`、`invite_same_device:…`、`invite_loop:…`、`invite_rate_limited:<日>`）は管理画面のプレイヤー表示に出ます。KPI では「1人の招待した人の1日の引き換え数」の上位を見ます：

```sql
SELECT blob2 AS inviter, blob6 AS day, count() AS redeems
FROM muchi_kpi
WHERE blob1 = 'invite_redeem' AND blob9 = 'inviter' AND timestamp > NOW() - INTERVAL '14' DAY
GROUP BY inviter, day
HAVING redeems >= 5
ORDER BY redeems DESC
LIMIT 50
```

## 調教：毎日のループと公平性（REQ-TRAIN-014、contracts/protocol.md §25）

**1日の調教の回数とミニゲームの遊ばれ方**（日ごと、課金者／無課金で分ける）。`blob7` は課金者の印。スキップ率が高いならミニゲームが面倒に感じられている、`expired` が多いならアプリが途中で閉じられている。

```sql
SELECT
  blob6 AS day, blob7 AS payer,
  sumIf(_sample_interval, blob1 = 'training_start') AS starts,
  sumIf(_sample_interval, blob1 = 'training_done') AS done,
  round(sumIf(_sample_interval, blob1 = 'training_done' AND blob10 = 'skipped') / sumIf(_sample_interval, blob1 = 'training_done'), 3) AS skip_rate,
  round(sumIf(_sample_interval, blob1 = 'training_done' AND blob10 = 'expired') / sumIf(_sample_interval, blob1 = 'training_done'), 3) AS expired_rate,
  round(sumIf(_sample_interval * double9, blob1 = 'training_done') / sumIf(_sample_interval, blob1 = 'training_done'), 2) AS avg_gain,
  round(sumIf(_sample_interval * double5, blob1 = 'training_done' AND blob10 = 'done') / sumIf(_sample_interval, blob1 = 'training_done' AND blob10 = 'done'), 2) AS avg_score
FROM muchi_kpi
WHERE blob1 IN ('training_start', 'training_done') AND timestamp > NOW() - INTERVAL '14' DAY
GROUP BY day, payer
ORDER BY day DESC, payer
```

- **公平性の監視**：`avg_gain` が課金者で無課金より大きいなら、課金者の馬に伸びしろが多い（素質の順 R ≥ SR ≥ SSR が崩れている）か、回数の上限が破られている。どちらも設定の検証で起きない前提なので、差が出たら調べる。ランク戦の勝率の差（「無課金と課金者のランク戦勝率の差」のクエリ）が調教の開始後に広がっていないかも合わせて見る（E15 の実測）。
- **満点の多さ**（機械の疑い）：`double5` が満点（10）の割合がプレイヤーごとに極端に高い（例：50回以上で95%超）なら、自動化の可能性。上乗せは最大 +10% なので急ぎではないが、`blob2` で上位を出してサポートに回す。

```sql
SELECT blob2 AS player, count() AS runs, round(countIf(double5 >= 10) / count(), 3) AS perfect_rate
FROM muchi_kpi
WHERE blob1 = 'training_done' AND blob10 = 'done' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY player
HAVING runs >= 50 AND perfect_rate > 0.95
ORDER BY runs DESC
LIMIT 50
```

## ライバル：表示・対戦・週の結果（REQ-RIVAL-015、contracts/protocol.md §28）

**週ごとの結果の内訳**（課金者／無課金で分ける）。`blob10` は週ID、`blob8` は結果、`blob9` は人間のライバルか CPU か。`not_enough` が多いなら3戦の条件が重い、`no_contest` が多いならブロック・オプトアウトが多い（組み合わせの質の問題）。

```sql
SELECT
  blob10 AS week, blob7 AS payer, blob9 AS kind,
  sumIf(_sample_interval, blob8 = 'win') AS win, sumIf(_sample_interval, blob8 = 'lose') AS lose, sumIf(_sample_interval, blob8 = 'draw') AS draw,
  sumIf(_sample_interval, blob8 = 'no_contest') AS no_contest, sumIf(_sample_interval, blob8 = 'not_enough') AS not_enough,
  round(sumIf(_sample_interval * double3, blob1 = 'rival_week_result') / sum(_sample_interval), 1) AS avg_free_coins
FROM muchi_kpi
WHERE blob1 = 'rival_week_result' AND timestamp > NOW() - INTERVAL '60' DAY
GROUP BY week, payer, kind
ORDER BY week DESC, payer, kind
```

**直接対決が起きているか**（人間のライバルと同じランク戦になった回数／日）。少ないなら同時接続が多くて同じ部屋になりにくい（タイムアタックの比較が実質の勝負になっている）。挑戦状のレース（`challenge`）の数も見る。

```sql
SELECT blob6 AS day, blob8 AS kind, sum(_sample_interval) AS races, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'rival_race' AND timestamp > NOW() - INTERVAL '14' DAY
GROUP BY day, kind
ORDER BY day DESC, kind
```

**見られているか**（1日1回の `rival_view` を出したプレイヤー ÷ その日ランク戦を走ったプレイヤー）と、オプトアウトの推移（`rival_opt`）。

```sql
SELECT blob6 AS day,
  count(DISTINCT if(blob1 = 'rival_view', blob2, NULL)) AS viewers,
  count(DISTINCT if(blob1 = 'race_finish' AND blob8 = 'ranked', blob2, NULL)) AS ranked_players,
  sumIf(_sample_interval, blob1 = 'rival_opt' AND blob8 = 'out') AS opt_out, sumIf(_sample_interval, blob1 = 'rival_opt' AND blob8 = 'in') AS opt_in
FROM muchi_kpi
WHERE blob1 IN ('rival_view', 'race_finish', 'rival_opt') AND timestamp > NOW() - INTERVAL '14' DAY
GROUP BY day
ORDER BY day DESC
```

- **公平性の監視**：`avg_free_coins` が課金者と無課金で大きく違うなら、どちらかの結果が偏っている（ライバルの報酬は課金で増えない前提）。勝ちの率が人間のライバルで50%から大きく外れる週は、組み合わせのレーティング差（`maxRatingGap`・`jitter`）を見直す。

## イベント交換所：ポイントと交換（REQ-EXCH-010、contracts/protocol.md §30）

**1日のポイントの貯まり方と上限に届いた割合**（イベントごと・課金者／無課金で分ける）。`capped` の割合が高いなら `dailyCap` が低すぎて遊んだ分が報われていない、低すぎる（ほぼ0）なら上限が意味を持っていない。課金者と無課金の平均が大きく違うなら調べる（ポイントは買えないので、差は遊んだ量の差だけのはず：E17）。

```sql
SELECT
  blob8 AS event_id, blob6 AS day, blob7 AS payer,
  sumIf(_sample_interval, blob1 = 'event_point_earn') AS races,
  round(sumIf(_sample_interval, blob1 = 'event_point_earn' AND blob9 = 'capped') / sumIf(_sample_interval, blob1 = 'event_point_earn'), 3) AS capped_rate,
  round(sumIf(_sample_interval * double9, blob1 = 'event_point_earn') / sumIf(_sample_interval, blob1 = 'event_point_earn'), 1) AS avg_points
FROM muchi_kpi
WHERE blob1 = 'event_point_earn' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY event_id, day, payer
ORDER BY event_id, day DESC, payer
```

**何が交換されているか**（行ごと）。在庫まで交換された行・ほとんど交換されない行を見て、次のイベントの価格と在庫を決める（ランダムな行は作らない・全交換の報酬は作らない）。

```sql
SELECT blob8 AS event_id, blob9 AS item_id, blob10 AS kind,
  sum(_sample_interval * double5) AS units, sum(_sample_interval * double9) AS points_spent,
  count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'exchange_buy' AND timestamp > NOW() - INTERVAL '45' DAY
GROUP BY event_id, item_id, kind
ORDER BY event_id, points_spent DESC
```

- 残りのポイントの換算（閉じた後）は KPI ではなくアイテム台帳（理由 `exchange <イベント> leftover <n>pt`）に残る。サポートで「ポイントが消えた」と言われたら台帳を見る。

## 注意

- Analytics Engine のデータ保持期間は有限（現時点で約3か月）です。長期の推移はこのクエリ結果を毎月どこかに書き出して残します。
- サンドボックスとテスト購入は `blob10 = 'sandbox'` で、金額は0円です。売上の計算では除外しています。
- 関数の対応は [SQL reference](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/) を参照してください。`countIf`/`sumIf`/`quantileExactWeighted`/`if`/`count(DISTINCT …)`/`FROM` のサブクエリは使えます。`JOIN`/`UNION` は使えません。

## 実績の解放と受け取り（REQ-ACH-003/005、Round 11）
段ごとの到達者数と、解放から受け取りまでの率（受け取られない段は、画面の導線か報酬の小ささの問題）。

```sql
SELECT blob8 AS achievement, double9 AS tier,
       SUM(IF(blob1 = 'achievement_unlock', _sample_interval, 0)) AS unlocked,
       SUM(IF(blob1 = 'achievement_claim', _sample_interval, 0)) AS claimed
FROM muchi_kpi
WHERE blob1 IN ('achievement_unlock', 'achievement_claim') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY achievement, tier
ORDER BY achievement, tier
```
- 実績は課金・ガチャでは進まない（REQ-ACH-007）ので、課金者と無課金者（`blob7`）で解放の速さに差が出たら、遊び方の違いとして読む（支払いの効果ではない）。

## プレゼントボックス：届いた・受け取った・期限切れ（REQ-BOX-013、Round 12、contracts/protocol.md §26）
出どころ（`blob8`）ごとに、届いた件数・受け取った件数・期限切れの件数と無償コイン（`double3`）。`gift_claim` の `blob9` は `one` / `all` / `overflow`（満杯で自動受け取り）、`double9` は届いてから受け取るまでの時間（時間）。

```sql
SELECT blob8 AS source,
       SUM(IF(blob1 = 'gift_receive', _sample_interval, 0)) AS received,
       SUM(IF(blob1 = 'gift_claim', _sample_interval, 0)) AS claimed,
       SUM(IF(blob1 = 'gift_expire', _sample_interval, 0)) AS expired,
       SUM(IF(blob1 = 'gift_expire', double3 * _sample_interval, 0)) AS expired_free_coins,
       SUM(IF(blob1 = 'gift_claim' AND blob9 = 'overflow', _sample_interval, 0)) AS overflow_claims
FROM muchi_kpi
WHERE blob1 IN ('gift_receive', 'gift_claim', 'gift_expire') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY source
ORDER BY received DESC
```

- **補填の期限切れ**（`source = 'ops_compensation'` の `expired`）が出ていたら、通知（`gift_arrived`）が届いていないか、90日では短い。補填の告知と合わせて見る。
- **overflow** が出るのはボックスが `maxUnclaimed`（500）に達したプレイヤーだけ。多いなら一括配布の頻度が高すぎる。
- 受け取りまでの時間（中央値）：

```sql
SELECT blob8 AS source, quantileExactWeighted(0.5)(double9, _sample_interval) AS median_hours
FROM muchi_kpi
WHERE blob1 = 'gift_claim' AND blob9 != 'overflow' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY source
```

## かんたん操作：提案から使い始めるまでと公平性（REQ-ASSIST-011、contracts/protocol.md §27）

**提案の効き目**（週ごと）：最下位が3回続いて提案が出た人のうち、その場でオンにした人（`assist_enable` の `blob9 = 'prompt'`）と、設定から自分でオンにした人。

```sql
SELECT
  toStartOfWeek(timestamp) AS week,
  sumIf(_sample_interval, blob1 = 'assist_prompt_view') AS prompts,
  sumIf(_sample_interval, blob1 = 'assist_enable' AND blob9 = 'prompt') AS enabled_from_prompt,
  sumIf(_sample_interval, blob1 = 'assist_enable' AND blob9 = 'settings' AND double8 = 1) AS first_enable_from_settings,
  sumIf(_sample_interval, blob1 = 'assist_disable') AS disabled,
  round(sumIf(_sample_interval, blob1 = 'assist_enable' AND blob9 = 'prompt') / sumIf(_sample_interval, blob1 = 'assist_prompt_view'), 3) AS prompt_conversion
FROM muchi_kpi
WHERE blob1 IN ('assist_prompt_view', 'assist_enable', 'assist_disable') AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week
ORDER BY week DESC
```

**補助ありのレースの着順**（モード・レベルごと）。`race_assisted` の平均着順がランク戦で補助なしの上手な層（例：勝率上位10%）より良くなっていたら、R11（balance-targets §2.3）の前提が崩れている。補助の定数を見直す。

```sql
SELECT blob8 AS level, blob9 AS mode, sum(_sample_interval) AS races,
  round(sum(_sample_interval * double4) / sum(_sample_interval), 2) AS avg_place,
  round(sumIf(_sample_interval, double4 = 1) / sum(_sample_interval), 3) AS win_rate
FROM muchi_kpi
WHERE blob1 = 'race_assisted' AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY level, mode
ORDER BY races DESC
```

- 補助を使った人の継続（D7）は、`assist_enable` を出した人の `blob2` で「リテンション」のクエリを絞って比べる。
- `client_race_start` の `blob9` にもレベルが入る（オフラインのレース・タイムアタックを含めた使われ方）。
## 履歴：購入・コイン・ガチャ履歴の閲覧（REQ-HIST-011、contracts/protocol.md §33）

**どのタブがどれだけ開かれているか**（日ごと、課金者／無課金で分ける）。`history_view` はクライアントのイベント（`blob8` = `purchases` / `coins_paid` / `coins_free` / `gacha`）。問い合わせの件数（運営の窓口側）が減ったか、`purchases` の閲覧が返金・ストア障害の日に跳ねていないかと合わせて見る。

```sql
SELECT
  blob6 AS day, blob7 AS payer, blob8 AS tab,
  sum(_sample_interval) AS views,
  count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'history_view' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, payer, tab
ORDER BY day DESC, payer, tab
```

- **購入直後の確認**：同じ日に `purchase`（サーバー）と `history_view`（`purchases`）がある課金者の割合が高いなら、購入完了の表示が分かりにくい（届いたか不安で履歴を見に行っている）。

## 週替わりチャレンジ：挑戦と達成（REQ-WCH-014、contracts/protocol.md §31）

**チャレンジごとの挑戦人数・達成率・平均挑戦回数**（週ごと）。達成率が極端に低い（< 10%）なら条件が厳しすぎる、高すぎる（> 90%）なら簡単すぎる。`blob11` = `server`。

```sql
SELECT blob9 AS week, blob8 AS challenge,
  countIf(blob1 = 'challenge_start') AS starts,
  count(DISTINCT if(blob1 = 'challenge_start', blob2, NULL)) AS players,
  count(DISTINCT if(blob1 = 'challenge_clear' AND double8 = 1, blob2, NULL)) AS cleared_players,
  cleared_players / players AS clear_rate,
  starts / players AS tries_per_player
FROM muchi_kpi
WHERE blob1 IN ('challenge_start', 'challenge_clear') AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY week, challenge ORDER BY week, challenge
```

**貸し出し馬と自分の馬**（公平性の監視）：`blob10`（`loan`/`own`）ごとの達成率を課金者（`blob7`）で分ける。自分の馬の課金者の達成率が貸し出し馬の無課金より大きく上回るなら、正規化・スキルなしの前提が崩れていないか（設定・ルールセット）を調べる。

```sql
SELECT blob10 AS horse, blob7 AS payer,
  count(DISTINCT if(blob1 = 'challenge_start', blob2, NULL)) AS players,
  count(DISTINCT if(blob1 = 'challenge_clear', blob2, NULL)) AS cleared
FROM muchi_kpi
WHERE blob1 IN ('challenge_start', 'challenge_clear') AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY horse, payer
```

**週のバッジ**：`challenge_clear` の `double9 = 1` の人数 ÷ その週に挑戦した人数。


## 支部の共同目標（REQ-TGOAL-011、contracts/protocol.md §32、Round 13）
**週ごとの参加と到達**：貢献した人数（送った人）、段に届けた回数、受け取った人数と段。`blob8` = 支部ID、`blob9` = 週（`team_goal_milestone` / `team_goal_reward`）、`double9` = 段。

```sql
SELECT
  blob9 AS week,
  count(DISTINCT IF(blob1 = 'team_goal_reward', blob2, NULL)) AS rewarded_players,
  sumIf(_sample_interval, blob1 = 'team_goal_milestone') AS milestones,
  round(sumIf(_sample_interval * double9, blob1 = 'team_goal_reward') / sumIf(_sample_interval, blob1 = 'team_goal_reward'), 2) AS avg_tier,
  count(DISTINCT IF(blob1 = 'team_goal_reward', blob8, NULL)) AS teams_paid
FROM muchi_kpi
WHERE blob1 IN ('team_goal_milestone', 'team_goal_reward') AND timestamp > NOW() - INTERVAL '60' DAY
GROUP BY week
ORDER BY week DESC
```

**1人で運んでいないか**（1日の上限が効いているか）：プレイヤーごとの1日の貢献（送った単位）。上限（レース10・勝利3・自己ベスト2）を超える値が出たら上限の実装を調べる。

```sql
SELECT blob6 AS day, blob2 AS player, blob9 AS kind, sum(_sample_interval * double5) AS units
FROM muchi_kpi
WHERE blob1 = 'team_goal_contribute' AND timestamp > NOW() - INTERVAL '14' DAY
GROUP BY day, player, kind
HAVING (kind IN ('race', 'win') AND units > 13) OR (kind = 'ta_pb' AND units > 2)
ORDER BY units DESC
LIMIT 100
```
- `team_goal_contribute` はプレイヤーのオブジェクトが送った時の行（支部がその週の種類でない・上限で数えないこともある）。`race` と `win` は1レースで1行（1着なら `s2 = 'win'`、`count` 2）。
- 課金者と無課金者（`blob7`）で受け取りの段に差が出ても、支払いの効果ではない（共同目標は課金で進まない、REQ-TGOAL-012）。支部の活発さの違いとして読む。
- 継続への効果：`team_goal_reward` を受け取った人と、支部にいるが受け取っていない人の翌週の `race_finish` の数を比べる（支部の共同目標の目的は週の継続）。

## 勝負服エディタ：編集とパーツの購入（REQ-SILK-014、Round 14、contracts/protocol.md §35）

**編集した人とパーツを買った人**（週ごと）。パーツは抽選ではないので、買った人の割合と1人あたりの額だけを見る（無料のパーツだけで作る人の割合も `double9 = 0` で分かる）。

```sql
SELECT toStartOfWeek(timestamp) AS week,
  count(DISTINCT if(blob1 = 'silks_edit', blob2, NULL)) AS editors,
  count(DISTINCT if(blob1 = 'silks_edit' AND double9 = 0, blob2, NULL)) AS free_parts_only,
  count(DISTINCT if(blob1 = 'silks_part_buy', blob2, NULL)) AS buyers,
  sumIf(_sample_interval * double2, blob1 = 'silks_part_buy') AS paid_coins,
  sumIf(_sample_interval * double3, blob1 = 'silks_part_buy') AS free_coins
FROM muchi_kpi
WHERE blob1 IN ('silks_edit', 'silks_part_buy') AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week
ORDER BY week DESC
```

**売れているパーツ**（直近28日）。

```sql
SELECT blob8 AS item, blob9 AS part, blob10 AS currency, sum(_sample_interval) AS buys
FROM muchi_kpi
WHERE blob1 = 'silks_part_buy' AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY item, part, currency
ORDER BY buys DESC
```

## 実況パック：試聴から購入・装備まで（REQ-CMT-012、contracts/protocol.md §36）

**試聴→購入の流れ**（パックごと、28日）：持っていない人の試聴、そのパックの購入、購入の有償コインの割合。

```sql
SELECT blob8 AS pack,
  sumIf(_sample_interval, blob1 = 'commentary_pack_sample' AND blob9 = 'not_owned') AS samples_not_owned,
  sumIf(_sample_interval, blob1 = 'commentary_pack_buy') AS buys,
  round(sumIf(_sample_interval, blob1 = 'commentary_pack_buy') / sumIf(_sample_interval, blob1 = 'commentary_pack_sample' AND blob9 = 'not_owned'), 3) AS sample_to_buy,
  round(sumIf(_sample_interval * double2, blob1 = 'commentary_pack_buy') / sumIf(_sample_interval * double9, blob1 = 'commentary_pack_buy'), 3) AS paid_share
FROM muchi_kpi
WHERE blob1 IN ('commentary_pack_sample', 'commentary_pack_buy') AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY pack
ORDER BY buys DESC
```

**装備の状態**（パックごと、28日）：初めて標準以外を装備した人（`double8 = 1`）、標準に戻した数。実績のパック（熱血）は購入なしで装備されるので、入手の目安は `commentary_pack_equip` の `blob8 = 'nekketsu'` で見る。

```sql
SELECT blob8 AS pack, blob10 AS source, sum(_sample_interval) AS equips, sumIf(_sample_interval, double8 = 1) AS first_non_standard
FROM muchi_kpi
WHERE blob1 = 'commentary_pack_equip' AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY pack, source
ORDER BY equips DESC
```

- 実況パックはレースに効かないので、勝率の比較はしない（買える要素がランク戦に効かないことは REQ-CMT-004 で保証）。

## マイリプレイ：保存・再生・共有（REQ-MYRP-014、Round 14、contracts/protocol.md §37）
列：`replay_save`（サーバー）`blob8` = `moment`／`recent`、`blob9` = モード、`blob10` = 名場面の種類（win／photo／pb）、`double4` = 着順、`double9` = 保存した大きさ（バイト）。`replay_view`（サーバー、再生データを渡した時）`blob8` = `own`／`friend`、`blob9` = `playable` または再生できない理由、`blob10` = モード。`replay_share`（クライアント）`blob8` = `my_replays`／`friend_replay`。

**使われ方**（週ごと）：保存した人・保存数・名場面からの保存の割合、再生（自分／フレンド）、共有。

```sql
SELECT
  toStartOfWeek(timestamp) AS week,
  count(DISTINCT if(blob1 = 'replay_save', blob2, NULL)) AS savers,
  sumIf(_sample_interval, blob1 = 'replay_save') AS saves,
  round(sumIf(_sample_interval, blob1 = 'replay_save' AND blob8 = 'moment') / sumIf(_sample_interval, blob1 = 'replay_save'), 3) AS from_moments,
  sumIf(_sample_interval, blob1 = 'replay_view' AND blob8 = 'own') AS own_views,
  sumIf(_sample_interval, blob1 = 'replay_view' AND blob8 = 'friend') AS friend_views,
  sumIf(_sample_interval, blob1 = 'replay_share') AS shares
FROM muchi_kpi
WHERE blob1 IN ('replay_save', 'replay_view', 'replay_share') AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week
ORDER BY week DESC
```

**再生できない割合**（理由ごと）：`ruleset_retired` が増えたら引退させた版の告知を、`ruleset_unknown` が増えたらアプリの更新の案内を見直す。端末の `hash_mismatch` はサーバーに届かない（クライアントの不具合報告で見る）。

```sql
SELECT blob9 AS status, sum(_sample_interval) AS views
FROM muchi_kpi
WHERE blob1 = 'replay_view' AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY status
ORDER BY views DESC
```

**保存の大きさ**（R2 の費用の見積もり）：平均 × 保存数。`maxBytes`（既定 256 KiB）に近い物が多ければ上限を見直す。

```sql
SELECT round(sum(_sample_interval * double9) / sum(_sample_interval)) AS avg_bytes, max(double9) AS max_bytes, sum(_sample_interval) AS saves
FROM muchi_kpi
WHERE blob1 = 'replay_save' AND timestamp > NOW() - INTERVAL '28' DAY
```

## アクセシビリティ：どの設定が使われているか（REQ-A11Y-014、contracts/protocol.md §41）

**変更の数と値の分布**（週ごと、キーと新しい値ごと）。行はキーごとなので、1回の保存で2つ変えれば2行。人数は `blob2`（ハッシュ化したプレイヤー）の重複を除く。

```sql
SELECT
  toStartOfWeek(timestamp) AS week, blob8 AS setting, blob9 AS value,
  sum(_sample_interval) AS changes,
  count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'a11y_setting_change' AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY week, setting, value
ORDER BY week, setting, changes DESC
LIMIT 200
```
- 個人の情報は入らない（どの設定・どの値かだけ）。今オンになっている人の割合は、最後の行がオンの人を数える必要があるので、プレイヤーごとの最新の行（`argMax(blob9, timestamp)`）で出す。
- 長押し（`whipInput = hold`）の人の勝率がタップの人より高くならないこと（REQ-A11Y-012）は設計とテスト（`AccessibilityTests.HoldIsCappedBelowSkilledPlay`）で担保している。KPI は使い方の分布を見るためで、強さの判定には使わない。


## 出走前アドバイス：表示と「おすすめどおり」（REQ-ADV-011、contracts/protocol.md §39.7）

**どれだけ見られ、おすすめの馬で出走した割合**（コンテキストごと、週ごと）。どちらもクライアントのイベント：`advice_view`（`blob8` = コンテキスト `ranked` / `friend` / `event` / `challenge` / `timeattack` / `tutorial`、`double5` = 並べた馬の数、`double9` = 1 ならおすすめあり）、`advice_follow`（`blob8` = コンテキスト、`double9` = 1 ならおすすめの馬で出走）。アドバイスを切っている人は送らない。

```sql
SELECT toStartOfWeek(timestamp) AS week, blob8 AS context,
  sumIf(_sample_interval, blob1 = 'advice_view') AS views,
  count(DISTINCT if(blob1 = 'advice_view', blob2, NULL)) AS players,
  sumIf(_sample_interval, blob1 = 'advice_follow') AS entries,
  sumIf(_sample_interval, blob1 = 'advice_follow' AND double9 = 1) AS followed,
  followed / entries AS follow_rate
FROM muchi_kpi
WHERE blob1 IN ('advice_view', 'advice_follow') AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY week, context ORDER BY week, context
```

- 課金者と無課金者（`blob7`）で数字を分けても、アドバイスはどちらにも同じ（無料・全員同じ情報、REQ-ADV-006）。差は遊び方の違いとして読む。
- 「おすすめどおり」の人の着順が良いかは、同じ日の `race_finish`（サーバー）と突き合わせる。アドバイスは勝ちやすさを約束しない（確率は出さない）ので、効果は着順の平均で見る。

## フォトモード（REQ-PHOTO-014、contracts/protocol.md §38、Round 15）
**撮った・共有した・保存した**：`photo_take`（クライアント、`blob8` = source：paused／result／replay、`blob9` = ルック）、`photo_share`（クライアント、OS の共有シートで共有した時だけ、`blob8` = source、`blob9` = framed／plain）、`photo_save`（サーバー、`blob8` = source、`blob9` = モード、`double5` = 保存後の件数）。

```sql
SELECT
  blob6 AS day,
  sumIf(_sample_interval, blob1 = 'photo_take') AS takes,
  sumIf(_sample_interval, blob1 = 'photo_share') AS shares,
  sumIf(_sample_interval, blob1 = 'photo_save') AS saves,
  round(sumIf(_sample_interval, blob1 = 'photo_share') / sumIf(_sample_interval, blob1 = 'photo_take'), 3) AS share_rate,
  count(DISTINCT IF(blob1 = 'photo_take', blob2, NULL)) AS players
FROM muchi_kpi
WHERE blob1 IN ('photo_take', 'photo_share', 'photo_save') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day DESC
```

**どこから撮るか・どのルックが使われるか**：

```sql
SELECT blob8 AS source, blob9 AS look, sum(_sample_interval) AS takes
FROM muchi_kpi
WHERE blob1 = 'photo_take' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY source, look
ORDER BY takes DESC
```
- `photo_save` の `blob9` に `ranked` などがあっても、`blob8` は `result`／`replay` だけのはず（`paused` はサーバーが拒む）。`paused` × 共有レースの行が出たら REQ-PHOTO-001 の実装を調べる。
- フレーム・スタンプの購入は既存の見た目ショップの購入（台帳 `cosmetic photo_*`）で見る。写真の品の売上がランク戦の勝率と関係しないこと（能力に影響しない）は設計上の前提。

## アクティビティ：開いた・押した（REQ-ACT-015、contracts/protocol.md §40、Round 15）

**ベルから一覧を開く人の割合と、どの種類の項目が押されるか**。`activity_open`（`double9` = 開いたときの未読の数）と `activity_tap`（`blob8` = 種類、`blob9` = 行き先の画面）はクライアントのイベント。一覧は読むだけの GET なので、開いた・押したはアプリが送る。

```sql
-- 日ごとの開いた人数と、開いたときの未読の平均（未読 0 で開く人が多いなら、ベルが目に入っていない）
SELECT blob6 AS day, blob7 AS payer,
  sum(_sample_interval) AS opens, count(DISTINCT blob2) AS players,
  sum(_sample_interval * double9) / sum(_sample_interval) AS avg_unread
FROM muchi_kpi
WHERE blob1 = 'activity_open' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, payer ORDER BY day DESC, payer
```

```sql
-- 押された項目（種類 × 行き先）：押されない種類は文言か並びを見直す
SELECT blob8 AS kind, blob9 AS screen, sum(_sample_interval) AS taps, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'activity_tap' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY kind, screen ORDER BY taps DESC
```

- **戻ってきた人に効いているか**：`session_start` の日に `activity_open` もある人の割合を、ライバル・支部・フレンドを使っている人とそれ以外で分けて見る。
- プレゼント（`gift_arrived` → `gift_box`）を押した人のうち、同じ日に `gift_claim` がある割合が低ければ、プレゼントボックスへの導線（ボタンの文言）を見直す。受け取りボタンを一覧に置くことはしない（§40）。

## 厩舎の整理：並び替え・まとめて操作（REQ-ORG-013、Round 16、contracts/protocol.md §44）
列：`roster_sort`（クライアント、並びか絞り込みを変えた時）`blob8` = 並びのキー（rating／aptitude／age／acquired／races／rarity／name）、`double9` = 使っている絞り込みの数。`roster_bulk_action`（サーバー、まとめて操作が実行できた時だけ）`blob8` = action（今は `retire` だけ）、`double5` = 頭数。

**よく使われる並び**（週ごと）：どの並びが使われているか、絞り込みを使う割合。

```sql
SELECT toStartOfWeek(timestamp) AS week, blob8 AS sort, sum(_sample_interval) AS changes,
  round(sumIf(_sample_interval, double9 > 0) / sum(_sample_interval), 3) AS with_filters
FROM muchi_kpi
WHERE blob1 = 'roster_sort' AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week, sort
ORDER BY week DESC, changes DESC
```

**まとめて操作**（週ごと）：使った人・回数・平均の頭数。

```sql
SELECT toStartOfWeek(timestamp) AS week, blob8 AS action, count(DISTINCT blob2) AS players, sum(_sample_interval) AS runs,
  round(sum(_sample_interval * double5) / sum(_sample_interval), 1) AS avg_horses
FROM muchi_kpi
WHERE blob1 = 'roster_bulk_action' AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week, action
ORDER BY week DESC
```

## 次にやること：カードの表示・タップ・閉じる（REQ-NEXT-012、Round 16、contracts/protocol.md §45）
列：`next_card_view`（クライアント、同じ種類は1ゲーム日に1回）`blob8` = 種類（`gift_expiring` など）、`blob9` = `primary`／`chip`。`next_card_tap`（クライアント）は同じ列。`next_card_dismiss`（サーバー、閉じた時に1回）`blob8` = 種類。

**種類ごとのタップ率と閉じる率**（週ごと）：タップが少なく閉じるが多い種類は、優先度（`progression.nextActions.rules[].priority`）を下げるか条件（`threshold`）を見直す。

```sql
SELECT
  toStartOfWeek(timestamp) AS week,
  blob8 AS kind,
  sumIf(_sample_interval, blob1 = 'next_card_view') AS views,
  sumIf(_sample_interval, blob1 = 'next_card_tap') AS taps,
  sumIf(_sample_interval, blob1 = 'next_card_dismiss') AS dismisses,
  round(sumIf(_sample_interval, blob1 = 'next_card_tap') / sumIf(_sample_interval, blob1 = 'next_card_view'), 3) AS tap_rate,
  round(sumIf(_sample_interval, blob1 = 'next_card_dismiss') / sumIf(_sample_interval, blob1 = 'next_card_view'), 3) AS dismiss_rate
FROM muchi_kpi
WHERE blob1 IN ('next_card_view', 'next_card_tap', 'next_card_dismiss') AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week, kind
ORDER BY week DESC, views DESC
```

**主カードとチップ**：主カードのタップ率がチップより十分高いこと（低ければ主カードの選び方が合っていない）。

```sql
SELECT blob9 AS slot, sumIf(_sample_interval, blob1 = 'next_card_view') AS views, sumIf(_sample_interval, blob1 = 'next_card_tap') AS taps
FROM muchi_kpi
WHERE blob1 IN ('next_card_view', 'next_card_tap') AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY slot
```

**新規の人の2日目**：カードをタップした人の D1 残存を見る（`cohortDay` と `daysSinceInstall` で、タップあり／なしに分ける）。


## シーズンの振り返り：開いた・最後まで見た・共有した（REQ-RECAP-015、Round 16、contracts/protocol.md §43）
列：`recap_open`・`recap_complete`（サーバー）`blob8` = `season`／`year`、`blob9` = 期間（`2026-11`／`2026`）、`blob10` = `short`／`full`、`double8` = 1 なら最初の1回（`isFirst`）。`recap_share`（クライアント）`blob8` = `season`／`year`、`blob9` = カード（`summary`／`horse`／`moment`／`rank`）、`blob10` = `hide_rank`／`show_rank`。

**期間ごとの漏斗**：開いた人 → 最後まで見た人 → 共有した人（最初の1回だけ数える）。短い版と通常版で分けて見る。

```sql
SELECT
  blob9 AS period, blob10 AS version,
  count(DISTINCT if(blob1 = 'recap_open' AND double8 = 1, blob2, NULL)) AS opened,
  count(DISTINCT if(blob1 = 'recap_complete' AND double8 = 1, blob2, NULL)) AS completed,
  round(count(DISTINCT if(blob1 = 'recap_complete' AND double8 = 1, blob2, NULL)) / count(DISTINCT if(blob1 = 'recap_open' AND double8 = 1, blob2, NULL)), 3) AS complete_rate
FROM muchi_kpi
WHERE blob1 IN ('recap_open', 'recap_complete') AND timestamp > NOW() - INTERVAL '90' DAY
GROUP BY period, version
ORDER BY period DESC, version
```

**共有**（カードごと・順位を隠した割合）：`rank` のカードが少なく `hide_rank` が多ければ、順位の見せ方を見直す。

```sql
SELECT blob8 AS kind, blob9 AS card, sum(_sample_interval) AS shares,
  round(sumIf(_sample_interval, blob10 = 'hide_rank') / sum(_sample_interval), 3) AS hide_rank_share
FROM muchi_kpi
WHERE blob1 = 'recap_share' AND timestamp > NOW() - INTERVAL '90' DAY
GROUP BY kind, card
ORDER BY shares DESC
```

## プレイヤー主催カップ：作成・参加・終了（REQ-CUP-017、Round 16、contracts/protocol.md §42）
列：`cup_create`（サーバー、主催者）`blob8` = 形式（`single`／`best_of_3`）、`blob9` = `team`（支部に入っている主催者）／`solo`、`double5` = 人数（定員）。`cup_join`（サーバー、参加者）`blob8` = `code`／`invite`、`blob9` = 形式。`cup_finish`（サーバー、各参加者に1行）`blob8` = `finished`／`cancelled`、`blob9` = 形式、`blob10` = 中止の理由（`host_left`／`host_deleted`／`ops_deleted`／`expired`）または `partial`、`double4` = 順位（中止は 0）、`double5` = 参加者数。

**使われ方**（週ごと）：作ったカップ、参加（コード／招待）、最後まで走ったカップの割合、中止の理由。

```sql
SELECT
  toStartOfWeek(timestamp) AS week,
  sumIf(_sample_interval, blob1 = 'cup_create') AS cups_created,
  count(DISTINCT if(blob1 = 'cup_create', blob2, NULL)) AS hosts,
  sumIf(_sample_interval, blob1 = 'cup_join' AND blob8 = 'code') AS joins_by_code,
  sumIf(_sample_interval, blob1 = 'cup_join' AND blob8 = 'invite') AS joins_by_invite,
  sumIf(_sample_interval, blob1 = 'cup_finish' AND blob8 = 'finished' AND double4 = 1) AS cups_finished,
  sumIf(_sample_interval, blob1 = 'cup_finish' AND blob8 = 'cancelled' AND blob10 = 'expired') AS expired_entries,
  sumIf(_sample_interval, blob1 = 'cup_finish' AND blob8 = 'cancelled' AND blob10 = 'host_left') AS host_left_entries
FROM muchi_kpi
WHERE blob1 IN ('cup_create', 'cup_join', 'cup_finish') AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week
ORDER BY week DESC
```
## 通報とブロック（REQ-RPT-017、contracts/protocol.md §47、Round 17）

**どこから・何の理由で通報されるか、ブロックがどれだけ使われ戻されるか**。3つともサーバーのイベント（受け付けた通報・一覧が本当に変わった時だけ）。相手の id と補足の文は入れない。

| イベント | blob8 | blob9 | blob10 | double5 |
|---|---|---|---|---|
| `report_submit` | 理由（`name`・`text`・`cheating`・`harassment`・`other`） | 対象（`display_name` など） | 入口（`profile`・`team_feed`・`hall`・`replay` …） | — |
| `block_add` | どこから（`blocks`・`report`・`team_feed`・`rival`） | — | — | 一覧の人数 |
| `block_remove` | どこから（`blocks`・`team_feed`） | — | — | 一覧の人数 |

```sql
-- 日ごとの通報（理由 × 入口）：ある入口だけ急に増えたら、その画面の名前・文の確認を見直す
SELECT blob6 AS day, blob8 AS category, blob10 AS source, sum(_sample_interval) AS reports, count(DISTINCT blob2) AS reporters
FROM muchi_kpi
WHERE blob1 = 'report_submit' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, category, source ORDER BY day DESC, reports DESC
```

```sql
-- ブロックの追加と解除（どこから）：解除が多い入口は、ブロックの説明が足りないかもしれない
SELECT blob1 AS event, blob8 AS origin, sum(_sample_interval) AS n, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 IN ('block_add', 'block_remove') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY event, origin ORDER BY n DESC
```

- 通報の中身（誰が誰を・写し・補足）は KPI ではなく運営コンソールの通報の列（`/v1/admin/player-reports`）で見る。1人が1日に出せる数は `reports.perDay` までなので、通報者ごとの数が多い日は「重み」（§47.7）と合わせて確認する。
- 「通報したらブロックもする」の割合 = `block_add`（`blob8 = 'report'`）÷ `report_submit`。

## メンテナンス・強制アップデート（REQ-MNT-013、contracts/protocol.md §46.8、Round 17）

**メンテナンスで止まった人の数（グループごと）と、更新の案内から実際にストアへ行った割合**。`maintenance_block`（`blob8` = グループ、`blob9` = 窓の id、窓 × グループごとにアプリの起動で1回）と `upgrade_prompt`（`blob8` = `required`/`recommended`/`engine`、`blob9` = `shown`/`store`/`later`、`blob10` = OS）はクライアントのイベント。止められた要求そのものはサーバーで数えない（再読み込みで同じ人が何度も数えられないように）。

```sql
-- 窓ごと・グループごとに止まった人数
SELECT blob9 AS window_id, blob8 AS grp, count(DISTINCT blob2) AS players, sum(_sample_interval) AS blocks
FROM muchi_kpi
WHERE blob1 = 'maintenance_block' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY window_id, grp ORDER BY window_id DESC, players DESC
```

```sql
-- 更新の案内：出した数とストアへ進んだ割合（種類・OS ごと）
SELECT blob8 AS kind, blob10 AS os,
  sumIf(_sample_interval, blob9 = 'shown') AS shown,
  sumIf(_sample_interval, blob9 = 'store') AS to_store,
  sumIf(_sample_interval, blob9 = 'later') AS later
FROM muchi_kpi
WHERE blob1 = 'upgrade_prompt' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY kind, os ORDER BY kind, os
```

## ヘルプセンター：検索・記事・役に立った・問い合わせ（REQ-HELP-021、contracts/protocol.md §48.9、Round 17）

**自分で解決できているか**。`help_search`（`blob8` = カテゴリか `all`、`double9` = 正規化した検索語の長さ、`double5` = 件数）と `help_article_view`（`blob8` = 記事、`blob9` = 入口 `list`・`search`・`context`・`link`・`related`）はクライアントのイベント。**検索語そのものはどこにも残らない**（個人情報が入りうるため）。`help_feedback`（`blob8` = 記事、`blob9` = カテゴリ、`double9` = 1 役に立った／0）・`inquiry_submit`（`blob8` = 種類、`double5` = 添えた記録の数、`double9` = 置き換えた個人情報の数）・`inquiry_answered`（`blob8` = 種類、`double6` = 受付から最初の返信までの ms）はサーバーのイベント。

```sql
-- 0件の検索の割合（カテゴリ別）：多ければ記事やキーワードを足す
SELECT blob8 AS category, sum(_sample_interval) AS searches,
  sum(if(double5 = 0, _sample_interval, 0)) / sum(_sample_interval) AS zero_rate
FROM muchi_kpi
WHERE blob1 = 'help_search' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY category ORDER BY searches DESC
```

```sql
-- 記事ごとの表示と入口
SELECT blob8 AS article, blob9 AS source, sum(_sample_interval) AS views
FROM muchi_kpi
WHERE blob1 = 'help_article_view' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY article, source ORDER BY views DESC
```

```sql
-- 問い合わせの最初の返信までの時間（種類別、時間）
SELECT blob8 AS category, sum(_sample_interval) AS answered,
  sum(_sample_interval * double6) / sum(_sample_interval) / 3600000 AS avg_hours_to_first_reply
FROM muchi_kpi
WHERE blob1 = 'inquiry_answered' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY category ORDER BY answered DESC
```

- 画面からの案内（`source = context`）の後に同じ日の `inquiry_submit` が少ないほど、案内が効いている。
- `inquiry_submit` の `double9`（置き換えた個人情報の数）が多い種類は、フォームの注意書きを見直す。

## おすすめフレンド：見た・申請した・消した（REQ-FSUG-014、contracts/protocol.md §49、Round 17）

**おすすめからフレンドができているか、どの理由が効いているか**。`fsug_view`（クライアント、`double9` = 出ていた数）、`fsug_request`（サーバー、`blob8` = いちばん大きい理由、`blob9` = `requested` / `friends`）、`fsug_dismiss`（サーバー、`blob8` = 理由、分からなければ `none`）。相手の id は入れていない。

```sql
-- 日ごとの見た人数・申請した人数・消した数（見た人のうち申請した割合が低いなら、理由の行か並びを見直す）
SELECT blob6 AS day,
  count(DISTINCT if(blob1 = 'fsug_view', blob2, NULL)) AS viewers,
  count(DISTINCT if(blob1 = 'fsug_request', blob2, NULL)) AS requesters,
  sum(if(blob1 = 'fsug_dismiss', _sample_interval, 0)) AS dismisses
FROM muchi_kpi
WHERE blob1 IN ('fsug_view', 'fsug_request', 'fsug_dismiss') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day ORDER BY day DESC
```

```sql
-- 理由ごとの申請と消した数：消される方が多い理由は重みを下げる（progression.friendSuggest.weights、リモート設定）
SELECT blob1 AS event, blob8 AS reason, sum(_sample_interval) AS n
FROM muchi_kpi
WHERE blob1 IN ('fsug_request', 'fsug_dismiss') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY event, reason ORDER BY event, n DESC
```

- **フレンドができたか**：相手の id を入れていないので、申請と承認を人単位では結ばない。日ごとの `friend_accept`（承認した側のサーバーイベント）の数が、おすすめを出してから増えたかで見る。


## 馬ごとの目標：見た・達成・ピン留め（REQ-HGOAL-012、Round 18、contracts/protocol.md §53）
列：`hgoal_view`（クライアント）`blob8` = `detail`（馬の目標の面を開いた）／`home`（ホームのピンを見た、1ゲーム日に1回）、`double9` = その時の達成数。`hgoal_complete`（サーバー、目標を達成した時に1回）`blob8` = 目標の種類（`first_win`・`races`・`surface_win`・`ta_course`・`stretch_win`・`wins`・`ranked_top3`・`tournament_win`）、`blob9` = `chain`（列を全部達成した最後の1つ）／空、`double5` = その馬の達成数。`hgoal_pin`（サーバー、ピン留めが変わった時だけ）`blob8` = `pin`／`unpin`、`blob9` = その時の目標の種類。

**種類ごとの達成数**（週ごと）：極端に少ない種類（`stretch_win`・`tournament_win` など）は物語の終わりとして妥当か、多すぎる種類は簡単すぎないかを見る。`need` はコードの版（v1）と共有ベクター `contracts/horse-goals.vectors.json` で決まるので、変える時は版を上げる。

```sql
SELECT toStartOfWeek(timestamp) AS week, blob8 AS kind, sum(_sample_interval) AS completes,
  sumIf(_sample_interval, blob9 = 'chain') AS chains_done
FROM muchi_kpi
WHERE blob1 = 'hgoal_complete' AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week, kind
ORDER BY week DESC, completes DESC
```

**面を開いた人・ピン留めした人**：

```sql
SELECT blob1 AS name, blob8 AS what, sum(_sample_interval) AS n, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 IN ('hgoal_view', 'hgoal_pin') AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY name, what
ORDER BY name, n DESC
```

## 練習レース：始めた・ゴールした（REQ-PRAC-015、Round 18、contracts/protocol.md §50）
列：`practice_start`（クライアント）`blob8` = コース（trackId）、`blob9` = 強さ（`easy`／`normal`／`strong`／`top`）、`blob10` = やり直しの種類（`none`／`same_seed`／`new_seed`）、`double5` = 頭数（2〜12）。`practice_finish`（クライアント）`blob8` = コース、`blob9` = 強さ、`double5` = 頭数、`double4` = 着順（ゴールしなければ 0）。入力・seed・タイムは送らない。練習は何も配らないので、この行は報酬の集計（コイン・XP・ミッション）には出てこない。

**使われ方**（週ごと）：練習した人、試走の数、やり直しの割合、強さの分布、ゴールまで走った割合。

```sql
SELECT
  toStartOfWeek(timestamp) AS week,
  count(DISTINCT if(blob1 = 'practice_start', blob2, NULL)) AS players,
  sumIf(_sample_interval, blob1 = 'practice_start') AS runs,
  sumIf(_sample_interval, blob1 = 'practice_start' AND blob10 != 'none') AS restarts,
  sumIf(_sample_interval, blob1 = 'practice_finish' AND double4 > 0) AS finished,
  sumIf(_sample_interval, blob1 = 'practice_start' AND blob9 = 'easy') AS easy,
  sumIf(_sample_interval, blob1 = 'practice_start' AND blob9 = 'top') AS top
FROM muchi_kpi
WHERE blob1 IN ('practice_start', 'practice_finish') AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week
ORDER BY week DESC
```

**練習のあとのランク戦**（練習した週に、ランク戦の着順が上がるか。相関で、因果ではない）：

```sql
SELECT blob9 AS strength, avg(double4) AS avg_place, sum(_sample_interval) AS finishes
FROM muchi_kpi
WHERE blob1 = 'practice_finish' AND double4 > 0 AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY strength
ORDER BY strength
```

## 個人データの開示・ダウンロード：リクエスト・準備・ダウンロード（REQ-DEX-017、Round 18、contracts/protocol.md §51）
列：`dex_request`（サーバー）`blob8` = 言語（`ja`／`en`）。`dex_ready`（サーバー）`blob8` = 言語、`double9` = JSON のバイト数、`double6` = リクエストから準備までのミリ秒、`double5` = 大きさの上限で省略したコインの履歴の行（ふつう 0）。`dex_download`（サーバー）`blob8` = `json`／`summary`、`double8` = 1 ならそのリクエストで最初のダウンロード。中身・リンクは記録しない。

**届いているか**（週ごと）：リクエスト・準備できた数・ダウンロードされた割合・準備までの時間（中央値）・省略が起きた数。準備できた割合が下がる、時間が延びる、省略が増えるときは `GET /v1/admin/players/:id/data-export` の `failReason` と Worker のログ（`data export build failed`）を見る。

```sql
SELECT
  toStartOfWeek(timestamp) AS week,
  sumIf(_sample_interval, blob1 = 'dex_request') AS requests,
  sumIf(_sample_interval, blob1 = 'dex_ready') AS ready,
  sumIf(_sample_interval, blob1 = 'dex_download' AND double8 = 1) AS downloaded,
  round(sumIf(_sample_interval, blob1 = 'dex_download' AND double8 = 1) / sumIf(_sample_interval, blob1 = 'dex_ready'), 3) AS download_rate,
  quantileWeighted(0.5)(if(blob1 = 'dex_ready', double6, NULL), _sample_interval) AS median_ready_ms,
  sumIf(_sample_interval, blob1 = 'dex_ready' AND double5 > 0) AS truncated_exports
FROM muchi_kpi
WHERE blob1 IN ('dex_request', 'dex_ready', 'dex_download') AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week
ORDER BY week DESC
```

## 引き継ぎコード：発行・成功・失敗の分類（REQ-TRF-014、contracts/protocol.md §54.9、Round 19）

**IDとパスワードで機種変更できているか、失敗は何が多いか**。どちらもサーバーのイベント。`transfer_issue`（発行した人、`blob8` = `custom` / `generated`）、`transfer_redeem`（成功は移ったアカウント、失敗は入力した新しい端末のアカウント。`blob8` = `ok` / `fail`、`blob9` = 失敗の分類 `invalid`・`expired`・`locked`・`refused_banned`・`refused_deletion`・`same_account`）。**ID・パスワード・IP は入れていない**（分類だけ）。

```sql
-- 日ごとの発行・成功・失敗（失敗の分類つき）
SELECT blob6 AS day, blob1 AS event, blob8 AS kind, blob9 AS reason, sum(_sample_interval) AS n
FROM muchi_kpi
WHERE blob1 IN ('transfer_issue', 'transfer_redeem') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, event, kind, reason ORDER BY day DESC, event, n DESC
```

- **`invalid` が急に増えた**：総当たりの疑い。IP・端末のロック（`TRANSFER_LOCKED` = `locked`）が一緒に増えていれば制限が効いている。運用コンソールの監査（`GET /v1/admin/players/:id/transfer`）で特定のアカウントに `failed`・`locked` が集中していないか見る。上限は `progression.transfer`（リモート設定）。
- **`expired` が多い**：発行から入力までが長い。`expiryDays` を延ばすか、発行の画面の期限の表示を目立たせる。
- **発行に対する成功の割合**：発行しても使わない人（機種変更の準備だけ）がいるので低くてよい。`custom` と `generated` の差が大きいなら、作ったパスワードのメモの案内を見直す。

## 観戦中の応援：送った・見た（REQ-CHEER-013、contracts/protocol.md §55、Round 19）

**観戦が「見るだけ」から「一緒に盛り上がる」になっているか**。どちらもクライアントのイベントで、**1レースに1行**（押すたびには送らない）。`cheer_send`（観戦者、`blob8` = モード、`double5` = そのレースで送った応援の数）、`cheer_seen`（`blob8` = モード、`blob9` = `racer`（表示オンの選手）/ `spectator`、`double5` = そのレースで見た応援の数）。馬・相手・送った人の id は入れていない。

```sql
-- モードごとの、応援したレース数と1レースあたりの応援の数
SELECT blob8 AS mode, sum(_sample_interval) AS races, sum(double5 * _sample_interval) / sum(_sample_interval) AS per_race
FROM muchi_kpi
WHERE blob1 = 'cheer_send' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY mode ORDER BY races DESC
```

```sql
-- 選手が応援を見たレース（表示オフの選手は行が出ない）
SELECT blob6 AS day, blob8 AS mode, sum(_sample_interval) AS races, sum(double5 * _sample_interval) AS cheers
FROM muchi_kpi
WHERE blob1 = 'cheer_seen' AND blob9 = 'racer' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, mode ORDER BY day DESC
```

- 1レースあたりの応援が上限（2秒に1回）にいつも張り付くなら、ボタン連打の遊びになっている。演出（Codex）を控えめにする。

## 画質・省電力・通信量：設定の変更・まとめてダウンロード（REQ-PERF-015、contracts/protocol.md §56.9、Round 19）

**自動の既定値が合っているか、どの区分の端末が何を変えているか、まとめてダウンロードがどのくらいの大きさで使われているか**。どちらもクライアントのイベント（設定は端末だけに保存されるため）。`perf_setting_change`（`blob8` = 設定、`blob9` = 新しい値、`blob10` = 端末の区分 `low`/`mid`/`high`。プレイヤーが変えた時だけ、自動の既定値では出ない）、`asset_predownload`（`blob8` = 残りのサイズの区分、`blob9` = `full`/`low`）。機種名・容量の実数は入れていない。

```sql
-- 区分ごとに、画質・fps を自動から変えた人の数（low 区分で high に上げる人が多ければ区分の境目を見直す：DeviceClassifier）
SELECT blob10 AS device_class, blob8 AS setting, blob9 AS value, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'perf_setting_change' AND blob8 IN ('graphics', 'frameRate') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY device_class, setting, value ORDER BY device_class, setting, players DESC
```

```sql
-- 省電力・データセーバーをオンにした人の数（日ごと）と、まとめてダウンロードを始めた人の数
SELECT blob6 AS day,
  count(DISTINCT if(blob1 = 'perf_setting_change' AND blob8 = 'batterySaver' AND blob9 = 'on', blob2, NULL)) AS battery_saver_on,
  count(DISTINCT if(blob1 = 'perf_setting_change' AND blob8 = 'dataSaver' AND blob9 = 'on', blob2, NULL)) AS data_saver_on,
  count(DISTINCT if(blob1 = 'asset_predownload', blob2, NULL)) AS predownloaders
FROM muchi_kpi
WHERE blob1 IN ('perf_setting_change', 'asset_predownload') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day ORDER BY day DESC
```

```sql
-- まとめてダウンロードの大きさの分布（gte_1gb が多いなら軽量版を用意するキーを増やす）
SELECT blob8 AS bucket, blob9 AS variant, sum(_sample_interval) AS starts
FROM muchi_kpi
WHERE blob1 = 'asset_predownload' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY bucket, variant ORDER BY bucket, variant
```

- **見方**：オンにした人の数は、その後オフに戻した人を引いていない（今の値は端末にしかない）。

## ヒント：やり直し・カード・「？」（REQ-TUT-015、contracts/protocol.md §57.6、Round 19）

**やり直しとカードが使われているか、どの画面の「？」が押されているか**。どれもクライアントのイベント（やり直しは端末の中だけで、サーバーには結果が来ない）。`tutorial_replay`（`blob8` = レッスン／ツアーの id、`blob9` = `race` / `tour`、`blob10` = `start` / `finish`）、`tip_view`（`blob8` = カード、`blob9` = 入口 `list`・`context`・`tour`・`lesson`）、`tip_context_open`（`blob8` = 画面 `gacha_odds`・`breeding`・`training`・`roster_bulk_retire`、`blob9` = カード）。

```sql
-- やり直しごとの開始・完了と完了率（完了率が低いレッスンは短くする）
SELECT blob8 AS tutorial, blob9 AS kind,
  sum(if(blob10 = 'start', _sample_interval, 0)) AS starts,
  sum(if(blob10 = 'finish', _sample_interval, 0)) AS finishes
FROM muchi_kpi
WHERE blob1 = 'tutorial_replay' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY tutorial, kind ORDER BY starts DESC
```

```sql
-- 画面ごとの「？」の回数（多い画面は画面そのものの説明を見直す）
SELECT blob8 AS screen, blob9 AS tip, sum(_sample_interval) AS opens
FROM muchi_kpi
WHERE blob1 = 'tip_context_open' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY screen, tip ORDER BY opens DESC
```

- `tip_view` の入口が `context` のカードの後に同じ日の `help_article_view`（`source = link`）が多いなら、カードが短すぎる。

## 広告・分析の同意：選択の変化（REQ-CNS-014、Round 20、contracts/protocol.md §58）
列：`consent_change`（サーバー、**必須**のイベント＝分析がオフの人でも書く）`blob8` = 項目（`personalized_ads`／`analytics`／`att`／`cmp`）、`blob9` = 新しい値（`on`／`off`、ATT は `not_determined`／`restricted`／`denied`／`authorized`／`unavailable`、CMP は `not_required`／`required`／`obtained`／`unknown`）、`blob10` = 入口（`prompt` 事前の画面／`settings` 設定／`platform` 端末の報告）。

**注意（§58.7）**：分析がオフのプレイヤーの任意のイベント（セッション・画面・レースの結果など、`server/src/domain/kpiConsent.ts` の `optional`）はこの表に**書かれない**。継続率・ファネルのクエリは「分析に協力している人」の数字になる（偏りの目安として下のオフの割合を一緒に見る）。購入・返金・ガチャ・広告の報酬・同意・削除・開示・通報は `essential` で全員の分が残る。

**事前の画面の結果と ATT の許可率**（週ごと）：

```sql
SELECT
  toStartOfWeek(timestamp) AS week,
  sumIf(_sample_interval, blob8 = 'analytics' AND blob9 = 'off') AS analytics_off,
  sumIf(_sample_interval, blob8 = 'analytics' AND blob9 = 'on') AS analytics_on,
  sumIf(_sample_interval, blob8 = 'personalized_ads' AND blob9 = 'on') AS personalized_on,
  sumIf(_sample_interval, blob8 = 'att' AND blob9 = 'authorized') AS att_authorized,
  sumIf(_sample_interval, blob8 = 'att' AND blob9 IN ('denied', 'restricted')) AS att_denied,
  round(sumIf(_sample_interval, blob8 = 'att' AND blob9 = 'authorized') / sumIf(_sample_interval, blob8 = 'att' AND blob9 IN ('authorized', 'denied', 'restricted')), 3) AS att_rate
FROM muchi_kpi
WHERE blob1 = 'consent_change' AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week
ORDER BY week DESC
```

## レビュー依頼：頼めた・OS の API を呼んだ・前置きの答え（REQ-REV-012、Round 20、contracts/protocol.md §59）
列（すべてサーバー）：`review_prompt_eligible`（check が頼むと決めた時に1回）`blob8` = 瞬間（`first_win`・`first_tournament_win`・`hall_induction`・`horse_goal_chain`）、`blob9` = platform（`ios`・`android`・`editor`）、`blob10` = `native`／`soft`。`review_prompt_shown`（端末が OS の API を呼んだ時に1回）`blob8` = 瞬間、`blob9` = platform、`blob10` = style。`review_soft_answer`（前置きの答え、1回）`blob8` = `yes`／`not_really`／`dismissed`、`blob9` = 瞬間、`blob10` = platform。星の数・レビューの本文は取れない（OS が返さない）。

**瞬間ごとに頼めた数と OS の API を呼んだ数**（週ごと。`shown / eligible` が低ければ端末が落ちている・OS の上限に当たっている）：

```sql
SELECT toStartOfWeek(timestamp) AS week, blob8 AS moment, blob9 AS platform,
  sumIf(_sample_interval, blob1 = 'review_prompt_eligible') AS eligible,
  sumIf(_sample_interval, blob1 = 'review_prompt_shown') AS shown
FROM muchi_kpi
WHERE blob1 IN ('review_prompt_eligible', 'review_prompt_shown') AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week, moment, platform
ORDER BY week DESC, eligible DESC
```

**前置きの答え**（前置きを ON にした時だけ。`not_really` はお問い合わせの「その他」と合わせて読む）：

```sql
SELECT blob8 AS answer, blob9 AS moment, sum(_sample_interval) AS n, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'review_soft_answer' AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY answer, moment
ORDER BY n DESC
```

## 端末のローカル通知：予約・開いた・許可（REQ-LNOTIF-013、Round 20、contracts/protocol.md §61）
列：`lnotif_scheduled`（クライアント、その出来事の id を新しく予約した時だけ。時刻・文言の付け替えでは送らない）`blob8` = 種類（`training_session`・`daily_bonus`・`weekly_challenge_closing`・`rival_week_closing`・`exchange_closing`・`gift_expiring`）。`lnotif_opened`（クライアント、通知から開いた時）`blob8` = 種類。`lnotif_permission`（クライアント、前置きの答え）`blob8` = `granted`／`provisional`／`denied`／`later`（前置きで「今はしない」）。予定の時刻・文言・馬の名前は送らない。

**種類ごとの開封率**（週ごと）：予約した数に対して開いた数。低い種類（例：ライバルの週の締め）は `leadHours`・`kinds`（リモート設定 `progression.localNotifications`）で弱める・外す。1日の上限（`dailyCap`）を上げる前に、ここで余計な通知になっていないかを見る。

```sql
SELECT toStartOfWeek(timestamp) AS week, blob8 AS kind,
  sumIf(_sample_interval, blob1 = 'lnotif_scheduled') AS scheduled,
  sumIf(_sample_interval, blob1 = 'lnotif_opened') AS opened,
  round(sumIf(_sample_interval, blob1 = 'lnotif_opened') / greatest(1, sumIf(_sample_interval, blob1 = 'lnotif_scheduled')), 3) AS open_rate
FROM muchi_kpi
WHERE blob1 IN ('lnotif_scheduled', 'lnotif_opened') AND timestamp > NOW() - INTERVAL '56' DAY
GROUP BY week, kind
ORDER BY week DESC, scheduled DESC
```

**前置きの答え**：OS の許可・仮の許可・拒否・あとで。拒否が多ければ前置きの時期（最初の調教の後）か文言を見直す。

```sql
SELECT blob8 AS result, sum(_sample_interval) AS n, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'lnotif_permission' AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY result
ORDER BY n DESC
```

## トレーナーカード：保存・閲覧・共有（REQ-SHOW-015、contracts/protocol.md §62.9、Round 21）

**カードを飾る人がいるか、どこから開かれているか、画像が共有されているか**。`showcase_save`（サーバー、選んだものが変わった保存のときだけ。`blob8` = 背景 id、`blob9` = `horse` / `none`、`blob10` = `phrase` / `none`、`double5`（count）= ピン留めの数、`double9`（value）= タイムアタックのコースの数）、`showcase_view`（クライアント、カードを開いたとき。`blob8` = 入口 `settings`・`friends`・`rival`・`activity`・`cup_lobby`・`spectate`・`hall`・`stable`・`leaderboard`・`team`、`blob9` = `self` / `friend` / `other`、`blob10` = `card` / `neutral`）、`showcase_share`（クライアント、画像を共有シートに渡したとき。`double5` = ピン留めの数、`double9` = 記録の数、`blob8` = `horse` / `none`）。どれも相手のプレイヤー ID を持たない。

```sql
-- 入口ごとの閲覧（自分・フレンド・その他）と、空のカード（ブロック・削除・停止）の割合
SELECT blob8 AS source, blob9 AS relation,
  sum(_sample_interval) AS views,
  sum(if(blob10 = 'neutral', _sample_interval, 0)) AS neutral
FROM muchi_kpi
WHERE blob1 = 'showcase_view' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY source, relation ORDER BY views DESC
```

```sql
-- 保存で選ばれた背景とピン留めの数（背景が既定のままの人が多いなら、解放の条件を見直す）
SELECT blob8 AS background, avg(double5) AS avg_pins, sum(_sample_interval) AS saves
FROM muchi_kpi
WHERE blob1 = 'showcase_save' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY background ORDER BY saves DESC
```

- `showcase_share` ÷ `showcase_view`（`relation = self`）が共有の割合。共有は何も配らない（報酬なし）。

## ディープリンク・再戦：作った・開いた・開けなかった・再戦（REQ-LINK-021、contracts/protocol.md §63.9、Round 21）

**リンクで人が来ているか、開けないリンクが多くないか、再戦が使われているか**。サーバーのイベント：`link_create`（作った人、`blob8` = 種類 `room`・`cup`・`replay`・`invite`・`friend`・`team`・`help`、`blob9` = `new` / `existing`）、`link_resolve`（開いた人、`blob8` = 種類（開けなかった時は `none`）、`blob9` = `ok`・`unavailable`・`friends_only`・`maintenance`・`update_required`）、`link_revoke`（`blob8` = 種類）、`rematch`（`blob8` = `press`・`decline`・`opened`・`too_few`、`double5` = 部屋の人数。`opened`／`too_few` は窓を締めた要求の人に1行）。クライアントのイベント：`deep_link_open`（`blob8` = 入口 `universal`・`scheme`・`referrer`・`typed`、`blob9` = 種類か `none`）。**トークン・行き先・プレイヤー ID は入れていない**。

```sql
-- 種類ごとの、作ったリンクと開いた結果（30日）
SELECT blob1 AS event, blob8 AS kind, blob9 AS outcome, sum(_sample_interval) AS n
FROM muchi_kpi
WHERE blob1 IN ('link_create', 'link_resolve', 'link_revoke') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY event, kind, outcome ORDER BY event, n DESC
```

```sql
-- アプリへの入口（あとから開く＝referrer / typed がどれだけあるか）
SELECT blob8 AS entry, blob9 AS kind, sum(_sample_interval) AS n
FROM muchi_kpi
WHERE blob1 = 'deep_link_open' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY entry, kind ORDER BY n DESC
```

```sql
-- 再戦：押した・やめた・開いた（部屋の平均の人数）・人数不足
SELECT blob8 AS step, sum(_sample_interval) AS n, sum(double5 * _sample_interval) / sum(_sample_interval) AS avg_members
FROM muchi_kpi
WHERE blob1 = 'rematch' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY step ORDER BY n DESC
```

- **`unavailable` が急に増えた**：総当たりか、期限の短い部屋のリンクが遅れて開かれている。`link_resolve` の `none` を IP の制限（`429 RATE_LIMITED`、KPI には出ない）と合わせて見る。部屋のリンクの期限は `progression.links.roomMinutes`。
- **`update_required` が多い**：`minClientVersion` を上げすぎ。ストアの審査が終わる前に上げていないか。
- **`referrer` が少なく `typed` が多い**：iOS の人がコードを入れている（期待どおり）。Android で `referrer` が 0 なら、案内のページの Google Play の URL（`storeUrl`）を確かめる。
- **再戦の `too_few` が `opened` より多い**：窓が短い。`rematchWindowSec` を延ばす（最大120秒）。

## アップデートのお知らせ：出した・最後まで見た・行き先・一覧（REQ-NEW-019、contracts/protocol.md §64.9、Round 21）

**更新した人にシートが届いているか、最後まで読まれているか、どのページの行き先が押されるか**。どれもクライアントのイベント。`release_notes_view`（`blob8` = 版、`blob9` = 段 `shown`・`finished`・`skipped`、`double9` = 閉じたページ、`double5` = ページ数）、`release_notes_target`（`blob8` = 版、`blob9` = `screen`・`help`・`tip`、`blob10` = 行き先の id、`double9` = ページ）、`release_notes_history`（`blob8` = 入口 `notices`・`tips`・`sheet`）。個人を特定する情報は入れない。§58 の必須／任意の分類は Round 20 の統合で付ける（3つとも任意の想定）。

```sql
-- 版ごとに、出した・最後まで見た・途中で閉じた（最後まで見た率が低い版はページを減らす）
SELECT blob8 AS version,
  sum(if(blob9 = 'shown', _sample_interval, 0)) AS shown,
  sum(if(blob9 = 'finished', _sample_interval, 0)) AS finished,
  sum(if(blob9 = 'skipped', _sample_interval, 0)) AS skipped
FROM muchi_kpi
WHERE blob1 = 'release_notes_view' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY version ORDER BY version DESC
```

```sql
-- 途中で閉じたページ（同じページで閉じる人が多いなら、そのページを短くするか外す）
SELECT blob8 AS version, double9 AS page, sum(_sample_interval) AS closes
FROM muchi_kpi
WHERE blob1 = 'release_notes_view' AND blob9 = 'skipped' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY version, page ORDER BY version DESC, page
```

```sql
-- 行き先ごとの押された回数と、一覧の入口
SELECT blob1 AS event, blob8, blob9, blob10, sum(_sample_interval) AS n
FROM muchi_kpi
WHERE blob1 IN ('release_notes_target', 'release_notes_history') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY event, blob8, blob9, blob10 ORDER BY n DESC
```

- `shown` に比べて `finished`＋`skipped` が少ない版は、シートが他の案内に押し出されたか、アプリが落ちている（§64.6 の優先順位と §60 のエラー報告を見る）。

## 予定表：見た・開いた・印（REQ-CAL-015、contracts/protocol.md §65.6、Round 21）

**予定表が見られているか、どの種類の行から画面へ進むか、印が使われているか**。`calendar_view`（クライアント、`blob8` = `month` / `week`、`double9` = 行の数）、`calendar_entry_open`（クライアント、`blob8` = 種類：`event`・`event_exchange`・`weekly_challenge`・`team_goal`・`league_season`・`season`・`season_pass`・`banner`・`tournament_registration`・`tournament`・`cup`・`maintenance`・`comeback`）、`calendar_mark`（サーバー、`blob8` = 種類、`blob9` = `on` / `off`、印が実際に変わった時だけ）。印でサーバーが通知を送ることは無い（§65.2）。

```sql
-- 表示の種類ごとの回数と平均の行の数（行が多すぎる表示は分ける）
SELECT blob8 AS view, sum(_sample_interval) AS views, sum(double9 * _sample_interval) / sum(_sample_interval) AS avg_entries
FROM muchi_kpi
WHERE blob1 = 'calendar_view' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY view
```

```sql
-- 種類ごとの「行を開いた」と「印を付けた」
SELECT blob8 AS kind,
  sum(if(blob1 = 'calendar_entry_open', _sample_interval, 0)) AS opens,
  sum(if(blob1 = 'calendar_mark' AND blob9 = 'on', _sample_interval, 0)) AS marks_on,
  sum(if(blob1 = 'calendar_mark' AND blob9 = 'off', _sample_interval, 0)) AS marks_off
FROM muchi_kpi
WHERE blob1 IN ('calendar_entry_open', 'calendar_mark') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY kind ORDER BY opens DESC
```

- `banner` の行を開いた先は提供割合の画面（購入の画面ではない）。`season_pass` の行には行き先が無いので `calendar_entry_open` は来ない。

## 騎手の道：挑戦・クリア・星（REQ-CAREER-013、Round 22、contracts/protocol.md §66.8）
列（どれもサーバーのイベント、§58 の分類は `optional`）：`career_start` `blob8` = レース id、`blob9` = 章 id、`double5` = そのレースの挑戦回数。`career_clear` `blob8` = レース id、`blob9` = 章 id、`double4` = 着順、`double6` = タイム（ms）、`double8` = 1 で初クリア、`double5` = そのレースの星の数、`double9` = 1 でこの初クリアで章が終わった、`double3` = 払った無償コイン。`career_star` `blob8` = レース id、`blob9` = 章 id、`double9` = 星の番号（1〜3）、`double5` = 全体の星の数。入力・tick・seed は送らない。

**レースごとの詰まり**（どこでやめるか）：挑戦した人・初クリアした人・1人あたりの挑戦回数。初クリアの率が低く挑戦回数が多いレースは、CPU の段・能力（`cpuStatPermille`）・クリアの着順を見直す（`server/master/career.json`、balance-targets 4.20）。

```sql
SELECT blob9 AS chapter, blob8 AS race,
  count(DISTINCT if(blob1 = 'career_start', blob2, NULL)) AS players,
  count(DISTINCT if(blob1 = 'career_clear' AND double8 = 1, blob2, NULL)) AS cleared_players,
  cleared_players / players AS clear_rate,
  countIf(blob1 = 'career_start') / players AS tries_per_player
FROM muchi_kpi
WHERE blob1 IN ('career_start', 'career_clear') AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY chapter, race ORDER BY chapter, race
```

**星の集め方**：星2・星3（`career_star` の `double9` = 2・3）を取った人の割合。星3がほとんど取れないレースは目標（ムチの回数・着順）がきつすぎる。

```sql
SELECT blob8 AS race, double9 AS star, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'career_star' AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY race, star ORDER BY race, star
```

**公平性の監視**：課金者（`blob7`）と無課金で初クリアまでの挑戦回数が大きく違うなら、章の上限（`statCap`）と相棒の能力合計の前提（§66.1）を調べる。報酬は一度ずつなので、`double3`（無償コイン）の合計は表の一生分（E20）を超えない。

## 使いすぎ・遊びすぎの防止：自分の上限・遊ぶ時間のお知らせ（REQ-LIMIT-016、Round 22、contracts/protocol.md §67）
列：`self_limit_set`（サーバー、**essential**＝分析をオフにしても書く。本人が決めた支払いの上限の記録）`blob8` = 変更（`set`＝すぐ効いた変更・`raise_requested`・`remove_requested`・`raise_cancelled`）、`double1` = 新しい額（上限なしは 0）、`double9` = 前の額（無しは 0）。`self_limit_block`（サーバー、optional）`blob8` = 商品、`double1` = 価格（購入の確認が自分の上限で断られた）。`playtime_setting_change`（サーバー、optional）`blob8` = 変えた項目（`session`・`daily`・`quiet_after`、複数は `,`）、`blob9` = `on`／`off`（変更後にどれか有効か）。`playtime_reminder_shown`（クライアント、optional）`blob8` = 理由（`quiet_after,daily,session` のシートの順）、`blob9` = 答え（`continue`／`stop`／`settings`）、`double9` = セッションの分（5分に丸め）、`double5` = その日の分（5分に丸め）。正確な遊んだ時間・時刻は送らない。

**上限を決めた人と変更の種類**（下げる・上げる・外す・取り消し。引き上げの取り消しが多いのは冷却期間が働いているしるし）：

```sql
SELECT toStartOfWeek(timestamp) AS week, blob8 AS change, sum(_sample_interval) AS n, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'self_limit_set' AND timestamp > NOW() - INTERVAL '84' DAY
GROUP BY week, change
ORDER BY week DESC, n DESC
```

**自分の上限で断られた購入**（売上の目標にしない。断られた後にサポートへの問い合わせが増えていないかを見る）：

```sql
SELECT blob8 AS product, sum(_sample_interval) AS n, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'self_limit_block' AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY product
ORDER BY n DESC
```

**遊ぶ時間のお知らせ：理由と答え**（「今日はここまで」の割合は目標にしない。シートが区切りで出ているか・設定を見直す人がいるかを見る）：

```sql
SELECT blob8 AS reasons, blob9 AS choice, sum(_sample_interval) AS n, count(DISTINCT blob2) AS players
FROM muchi_kpi
WHERE blob1 = 'playtime_reminder_shown' AND timestamp > NOW() - INTERVAL '28' DAY
GROUP BY reasons, choice
ORDER BY n DESC
```

## 昇級戦：始まり・結果・盾（REQ-PROMO-015、Round 22、contracts/protocol.md §68）
列（すべてサーバー、§58 の分類は optional）：`promo_series_start` `blob8` = クラス、`blob9` = 次のクラス、`blob10` = 昇級戦 ID（`2026-11:C:1`）、`double5`（count）= そのシーズン・クラスで何回目、`double9`（value）= 始まった時のポイント。`promo_series_end` `blob8` = `pass`／`fail`／`season_end`、`blob9` = クラス、`blob10` = 次のクラス、`double5` = 上位の数、`double9` = 走った数。`demotion_shield_used` `blob8` = クラス、`blob9` = シーズン、`double9` = 締めのポイント、`double5` = 猶予で走った数。

**突破率と再挑戦**（月ごと、クラスごと。突破率が極端なら `needTop`・`topPlace` を見直す。`fail` の後の `start` の回数が多ければ `setbackPoints` が小さすぎる）：

```sql
SELECT toStartOfMonth(timestamp) AS month, if(blob1 = 'promo_series_start', blob8, blob9) AS class,
  sumIf(_sample_interval, blob1 = 'promo_series_start') AS started,
  sumIf(_sample_interval, blob1 = 'promo_series_start' AND double5 > 1) AS retries,
  sumIf(_sample_interval, blob1 = 'promo_series_end' AND blob8 = 'pass') AS passed,
  sumIf(_sample_interval, blob1 = 'promo_series_end' AND blob8 = 'fail') AS failed,
  sumIf(_sample_interval, blob1 = 'promo_series_end' AND blob8 = 'season_end') AS open_at_close
FROM muchi_kpi
WHERE blob1 IN ('promo_series_start', 'promo_series_end') AND timestamp > NOW() - INTERVAL '120' DAY
GROUP BY month, class
ORDER BY month DESC, class
```

**盾を使った数**（締めのたびに。多ければ昇級したての人が上のクラスで勝てていない＝`classStatCap` の差かマッチングを見る）：

```sql
SELECT blob9 AS season, blob8 AS class, sum(_sample_interval) AS shields, avg(double9) AS avg_points
FROM muchi_kpi
WHERE blob1 = 'demotion_shield_used' AND timestamp > NOW() - INTERVAL '120' DAY
GROUP BY season, class
ORDER BY season DESC, class
```

## ゲーム内アンケート：出した・スキップ・答えた（REQ-SURVEY-019、Round 22、contracts/protocol.md §69.9。R22 統合で追加）
列（すべてサーバー、§58 の分類は optional：分析がオフの人の行は書かない）：`survey_shown` `blob8` = アンケート id、`blob9` = `inbox`（お知らせの中の行。R22 統合でホームのカード・結果の後のシートは無くなった）、`double5`（count）= その人に出した回数。`survey_skip` `blob8` = id、`blob9` = 場所。`survey_answer` `blob8` = id、`blob9` = 場所、`double5` = 答えた問いの数。**答えの中身は KPI に無い**（結果は運営の画面 §69.7 と CSV で、プレイヤー ID なしで見る）。

**答えた率・スキップ率**（アンケート・場所ごと。スキップが多い場所・題は、出す場所か前置きを見直す。答えた人の数は運営の画面の件数と同じくらいのはず。差は分析をオフにした人）：

```sql
SELECT blob8 AS survey, blob9 AS placement,
  sumIf(_sample_interval, blob1 = 'survey_shown') AS shown,
  sumIf(_sample_interval, blob1 = 'survey_skip') AS skipped,
  sumIf(_sample_interval, blob1 = 'survey_answer') AS answered,
  avgIf(double5, blob1 = 'survey_answer') AS avg_questions
FROM muchi_kpi
WHERE blob1 IN ('survey_shown', 'survey_skip', 'survey_answer') AND timestamp > NOW() - INTERVAL '60' DAY
GROUP BY survey, placement
ORDER BY survey, placement
```

- 2回目に出した行（`double5 = 2`）が多いのに答えも スキップもしない人が多いなら、`maxShowsPerSurvey` を下げる。報酬が無いので、答えた人の偏りは「答えたい人」だけ（景品で増やさない、§69）。

## ログイン中の端末：お知らせ・ログアウト・一覧（REQ-DEV-016、contracts/protocol.md §70.9、Round 23）

**新しい端末のお知らせがどれだけ出て、どれだけログアウトにつながるか、乗っ取りの波が無いか**。`new_device_notice`（サーバー、essential、`blob8` = `ios` / `android` / `other`）、`device_signout`（サーバー、essential、`blob8` = `one` / `others` / `support`、`double5` = ログアウトした数、実際にログアウトした時だけ）、`device_list_view`（クライアント、optional、`blob8` = `devices` / `log`、`double9` = 行の数）。端末のハッシュ・セッションの ID・地域・機種は入らない（§70.9）。

```sql
-- 日ごとの新しい端末のお知らせと、プレイヤー自身・サポートのログアウト（急に増えた日は乗っ取りの波を疑う）
SELECT toDate(timestamp) AS day,
  sum(if(blob1 = 'new_device_notice', _sample_interval, 0)) AS new_devices,
  sum(if(blob1 = 'device_signout' AND blob8 = 'one', _sample_interval, 0)) AS signout_one,
  sum(if(blob1 = 'device_signout' AND blob8 = 'others', _sample_interval, 0)) AS signout_others,
  sum(if(blob1 = 'device_signout' AND blob8 = 'support', _sample_interval, 0)) AS signout_support,
  sum(if(blob1 = 'device_signout', double5 * _sample_interval, 0)) AS sessions_signed_out
FROM muchi_kpi
WHERE blob1 IN ('new_device_notice', 'device_signout') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day ORDER BY day
```

```sql
-- 一覧と記録が開かれた回数と、平均の行の数
SELECT blob8 AS screen, sum(_sample_interval) AS views, sum(double9 * _sample_interval) / sum(_sample_interval) AS avg_rows
FROM muchi_kpi
WHERE blob1 = 'device_list_view' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY screen
```

- `device_list_view` は分析がオフのプレイヤーからは来ない（optional）。`new_device_notice`・`device_signout` は分析の選択に関係なく残る（アカウントへの入口の監査、§58.7）。
- お知らせ（`new_device_notice`）のあと24時間以内の `device_signout` の割合が高い日は、知らない端末からのログインが増えている。運用はヘルプのお問い合わせ（カテゴリ「アカウント」）と合わせて見る。

## 血統図と系統：見た・系統の一覧（REQ-PED-016、contracts/protocol.md §71.6、Round 23）

**血統図がどこから開かれ、近親の強調がどれくらい出ているか、系統の一覧が見られているか**。`pedigree_view`（クライアント、`blob8` = 入口：`horse`・`breeding`・`stable`・`showcase`・`bloodlines`、`blob9` = `self` / `friend` / `other`、`double5` = 強調した共通の祖先の数 0〜14）、`bloodline_view`（クライアント、`blob8` = 入口：`breeding`・`pedigree`・`help`、`double9` = 系統の数）。どちらもプレイヤー・馬の ID を持たない。§58 では `optional`。

```sql
-- 入口と関係ごとの血統図の回数、共通の祖先が出ていた割合
SELECT blob8 AS source, blob9 AS relation, sum(_sample_interval) AS views,
  sum(if(double5 > 0, _sample_interval, 0)) / sum(_sample_interval) AS with_shared
FROM muchi_kpi
WHERE blob1 = 'pedigree_view' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY source, relation ORDER BY views DESC
```

```sql
-- 系統の一覧の入口
SELECT blob8 AS source, sum(_sample_interval) AS views
FROM muchi_kpi
WHERE blob1 = 'bloodline_view' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY source ORDER BY views DESC
```

- 配合（`breeding`）から開いた図で `with_shared` が高いのに配合の数が変わらないなら、近親の罰の説明（ヘルプ `pedigree`）が届いているかを見る。系統の数は目標にしない（報酬・達成の表示は無い）。

## レースの見どころ：見た・共有した（REQ-HL-015、contracts/protocol.md §72.5、Round 23）

**見どころがどこから見られているか、どの瞬間がいちばんに選ばれているか、共有につながるか**。どちらもクライアントのイベントで §58 の `optional`（分析をオフにした人の行は無い）。`highlight_view`（`blob8` = 入口：`result`・`my_replays`・`friend_replay`・`link`、`blob9` = 1位の瞬間の種類：`photo_finish`・`near_miss`・`lead_change`・`whip_burst`・`comeback`・`unique_skill`・`finish`、`double9` = 瞬間の数 1〜3）、`highlight_share`（`blob8` = 入口、`blob9` = `card`（画像）／`link`（§63 のリプレイのリンク））。レース・プレイヤー・tick は入らない。

```sql
-- 入口ごとの再生と共有（共有率）
SELECT blob8 AS surface,
  sum(if(blob1 = 'highlight_view', _sample_interval, 0)) AS views,
  sum(if(blob1 = 'highlight_share', _sample_interval, 0)) AS shares
FROM muchi_kpi
WHERE blob1 IN ('highlight_view', 'highlight_share') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY surface ORDER BY views DESC
```

```sql
-- 1位に選ばれた瞬間の種類（`finish` ばかりなら判定の版を見直す目安）
SELECT blob9 AS top, sum(_sample_interval) AS views, sum(double9 * _sample_interval) / sum(_sample_interval) AS avg_moments
FROM muchi_kpi
WHERE blob1 = 'highlight_view' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY top ORDER BY views DESC
```

- リンクで送れるのは公開した保存リプレイだけ（§72.4）。`link` の共有が少なく `card` が多いのは、保存・公開の前に共有しているため。リンクを開いた側は §63 の `link_resolve`（`s1 = replay`）と、ここの `highlight_view`（`link`）。

## お問い合わせの状況：返信・再開・解決（REQ-TKT-012、contracts/protocol.md §73.8、Round 23）

**サポートがどれだけ早く・何回のやりとりで解決しているか**。どれもサーバーのイベントで本文は入らない。`ticket_player_reply`（`blob8` = 種類、`blob9` = 返信の前の状態、`double9` = 置き換えた数）・`ticket_reopen`（`blob8` = 種類、`blob9` = `resolved` / `closed`）・`ticket_resolved`（`blob8` = 種類、`blob9` = `resolved` / `closed` / `auto_closed`、`double6` = 受付からの ms）は **essential**（サポートの記録、同意に関係なく残る）。`ticket_reply_view`（`blob8` = 種類、運営の返信を開いた）は optional。チケットを作る・最初の返信は §48 の `inquiry_submit`・`inquiry_answered`。

```sql
-- 種類ごとの解決までの時間（中央値）と、閉じ方の内訳
SELECT blob8 AS category, blob9 AS how, sum(_sample_interval) AS n, quantileWeighted(0.5)(double6, _sample_interval) / 3600000 AS median_hours
FROM muchi_kpi
WHERE blob1 = 'ticket_resolved' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY category, how ORDER BY n DESC
```

```sql
-- 再開の割合（解決・クローズにしたのにプレイヤーが戻ってきた）
SELECT blob8 AS category,
  sum(if(blob1 = 'ticket_reopen', _sample_interval, 0)) AS reopens,
  sum(if(blob1 = 'ticket_resolved', _sample_interval, 0)) AS resolved
FROM muchi_kpi
WHERE blob1 IN ('ticket_reopen', 'ticket_resolved') AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY category ORDER BY reopens DESC
```

- `auto_closed` が多い種類は、返信の文がそのまま答えになっているか（追加の質問が要らないか）を見直す。
- `ticket_reopen` の多い種類はひな形（`help.replyTemplates`）か記事を見直す。
