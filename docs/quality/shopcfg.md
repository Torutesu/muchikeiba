# 品質・ストリーム D：ショップの設定と、昇級の記念・ログボの差し替え

ブランチ：`quality/shopcfg`（`origin/claude/unity-screens-base` から）
前提：`docs/quality/pass.md` §4（オーナーが決めること）。オーナーは4つとも決めた。この文書はその実装の記録。

---

## 1. やったこと（4つ）

| # | オーナーの決定 | 実装 | どこで効くか |
|---|---|---|---|
| 1 | 厩舎手当をパスの画面の下へ | `progression.shopLayout.allowanceUnderPass: true`（同梱のマスター） | 一覧で `stable_allowance_30d` の `tab` が `pass`、おすすめの案内から外れる。レシートの手当の行に「毎日の分はシーズンパスの画面で受け取れます」（英語あり） |
| 2 | コインのパック ¥800・¥2,400 をやめる（8 → 6） | `shopLayout.retiredProducts` に `coin_800`・`coin_2400` | 一覧・初回購入・コイン不足のシートから消える。新しい購入の意図は `NOT_ELIGIBLE`、決済中のものは付与される |
| 3 | 昇級記念パックをやめ、柄を昇級の無料の報酬に（pass.md §4-3 案 A） | `retiredProducts` に `promo_pack_B/A/S`。新しい `progression.promotionRewards`（B/A/S → `costume_promo_b/a/s`）と付与のコード | シーズンの締めで、**初めて**上がったクラスの柄を1回だけ渡す。`GET /v1/promotion` の `reward`・`nextReward`、`POST /v1/promotion/ack { rewardClassId }`。突破のシートに「B級に上がると：…」、締めの後のホームで瞬間（`Moment`）を1回 |
| 4 | ログボの周期の3日目（10日目）の「翼」が重なる | 新しい `progression.loginBonusOwnedSwap`（`costume_login` → 配合素材2） | 持っている人には配合素材2個、持っていない人には「翼」。応答に `swappedFrom`。先の見通し（目標の階段の明日・2週目）も同じ答え |

### 1.1 決めた細かい点（コードの規則）

- **昇級の記念**（`server/src/domain/promotion.ts` の `grantPromotionReward`、`season.ts` の `rollSeason` から呼ぶ）
  - 付与は**シーズンの締め**（そのプレイヤーの月の最初のトランザクション）。昇級戦の突破の時ではない（クラスが変わるのは締めなので）。昇級戦のスイッチ（`progression.promotion.enabled`）に関係なく、上がったクラスで決まる。
  - **クラスごとに一生1回**（状態 `promotion.rewards` にクラスを記録）。降級してもう一度上がっても2回目は無い。冪等（締めは1プレイヤー1か月に1回）。
  - 旧・昇級記念パックを買って柄を持っている人には重ねて渡さない。その記録は「見た」扱いで、瞬間は出ない。
  - **売り物にしない**：`promotionRewardsProblems` が、柄を含む商品がまだ売られている設定（`retiredProducts` に入っていない）・見た目だけの品でない物・コイン・数が1でない物・知らないクラス・いちばん下のクラスを断る（起動時とリモート設定のたび）。
  - 見た目だけで、コイン・券・素材は出さない → E1〜E20 に影響なし。
- **ログボの差し替え**（`server/src/domain/rewards.ts` の `loginRewardFor`）
  - その日の報酬に入っている見た目だけの品を、持っていれば表の品に替える。表は配合素材だけ・1〜5個（`loginBonusSwapProblems`）。
  - 初心者の7日間も同じ規則（3日目の「翼」は新しい人は持っていないので、そのまま「翼」）。
  - 受け取った日の差し替えは `loginBonus.swappedFrom` に残し、その日の目標の階段の表示も実際に渡した物を言う。
- **戻せるように**：リモート設定で `retiredProducts: []` を許す（`shapeProblems` の例外 `MAY_BE_EMPTIED`）。パックを売りに戻す時は `promotionRewards: {}` も一緒に（同じ柄を無料と有料の両方に置かない）。

## 2. テスト（先に書いた）

- サーバー：`server/test/shopcfg.test.ts`（15件）。同梱の設定（6パック・昇級記念パック無し・手当はパス）、レシートの1行と英語、リモート設定での取り消し、昇級の記念（1回だけ・再昇級で無し・旧パックを持つ人・昇級戦オフでも・サービス経由の締めと ack・売り物の検査）、ログボの差し替え（新しい人は10日目に素材2・持っていない人は「翼」・見通しと受け取りが同じ・規則）。
- 既存のテストで、全部の商品を売る前提の仕組みのテスト（コイン不足・使いすぎの上限・品の表示・スカウトの確認）は `mAllProducts`（`test/helpers.ts`：レイアウトをオフにしたリモート設定と同じマスター）で走らせる。2週目の見通しのテストは、10日目が素材2になったことを確かめるように直した。
- C#：`PromotionTests.PromotionRewardViewLinesAndAck`、`ApiClientRound8Tests`（`SwappedFrom`）、`ApiClientGoalsWeek2Tests`（10日目の `LoginSwappedFrom`）。
- Unity のゲーム層：`GameChecks/PromotionChecks`（突破のシートの1行、瞬間は1回・閉じると ack、ログボの説明の1行、英語）。

## 3. クライアント（C#・Unity のゲーム層・見本）

| 場所 | 足したもの |
|---|---|
| `engine/Muchi.Client/Promotion.cs` | `PromotionReward { ClassId, SeasonId, Items }`、`PromotionView.Reward`（瞬間を出す物、null＝無し）・`PromotionView.NextReward`（次のクラスで届く物）、`PromotionPips.RewardMomentTitle`・`RewardItems(r, itemName)`・`NextRewardLine(v, itemName)`、`ApiClient.AckPromotionRewardAsync(classId)` |
| `engine/Muchi.Client/Models.cs` | `LoginBonusResult.SwappedFrom`・`Swapped` |
| `engine/Muchi.Client/Goals.cs` | `GoalToday.LoginNextSwappedFrom`・`GoalTomorrow.LoginSwappedFrom`・`GoalWeek2Day.LoginSwappedFrom` |
| `unity/Assets/Muchi/Game/PromotionModel.cs` | `ItemName`、`OutcomeRewardLine`、`TryShowRewardMoment`・`RewardMomentVisible`・`RewardMomentTitle/Kicker/Items/Sub`、`CloseRewardMomentAsync` |
| `unity/Assets/Muchi/Game/HomeModels.cs` | `LoginBonusModel.SwapNoteFor`・`SwapNote` |
| 見本 `tools/figma-prototype` | 突破のシートに金の1行、ホームで昇級の記念の `Moment`（`promotion_reward`）と ack、ログボのトーストに説明の1行。`L.promotion.ackReward`・`L.promotion.demoReward`（本物の締めで B 級へ） |

レシート：手当の行の説明だけが変わる（次の一歩は「今日の分を受け取る」のまま）。ショップの画面は、サーバーの一覧と `tab` をそのまま使うので変更なし（ストリーム B が読む）。

## 4. 経済（`npm run economy`、90日・3シード）

前＝このブランチのコードで、同梱の設定を元に戻したマスター（`shopLayout` オフ・`promotionRewards: {}`・`loginBonusOwnedSwap: {}`）。後＝このブランチ。前の数字は、元の `main` の設定で走らせた結果（E17〜E20 の行）とも同じ。**変わったのは配合素材の数だけ**で、目標の行は全部同じ値。

| 目標 | 範囲 | 前 | 後 |
|---|---|---|---|
| E1（主・ランク戦の実際の着順、average） | 40〜65 | 62.0 | **62.0** |
| E2 SSR/月 | 1.2〜2.8 | 2.56 | 2.56 |
| E3 天井到達 | 40〜75 日目 | 44 | 44 |
| E4 週4日（一様の着順） | — | 31.1 | 31.1 |
| E5 パス ÷ 無課金 | — | 1.24 | 1.24 |
| E10 厩舎手当 ÷ 無課金 | — | 1.18 | 1.18 |
| E11 招待上限 ÷ 無課金（SSR/月） | ≤2.8 | 1.02（2.67） | 1.02（2.67） |
| E12 復帰の受け取り ≤ 毎日の人の14日分 | ≤ | 1,810 ≤ 2,066 | 1,810 ≤ 2,066 |
| E13 広告 ÷ 無課金 | — | 1.10 | 1.10 |
| E14 実績（段・無償コイン） | ≤180 | 23.0・170 | 23.0・170 |
| **E15** 中課金−無課金のランク戦の能力差（調教なし→あり）、伸び/日の比 | 差が広がらない・≤1.05 | C 0→0・B 0→−1・A 0→0・S 0→0、0.95 | **同じ**（C 0→0・B 0→−1・A 0→0・S 0→0、0.95） |
| E16 ライバル（90日） | ≤180 | 170 | 170 |
| E17 イベントあり E1・E2 | — | 54.4・2.22 | 54.4・2.22 |
| E18〜E20 E1・E2・招待上限 SSR | 40〜65・1.2〜2.8・≤2.8 | 55.3・2.56・2.67 | 55.3・2.56・2.67 |

**品物の数（90日）**：配合素材だけが増える。ログボの周期の3日目（10・17・…・87日目の12回）に2個ずつ＝**+24個**。

| persona | 配合素材 前 | 後 |
|---|---|---|
| 無課金（毎日） | 188 | 212 |
| 無課金（週4日） | 142 | 155 |
| パス・中課金 | 278 | 302 |
| 復帰（14日休み） | 175 | 195 |

- E15：配合素材はランク戦の能力に効かない（配合の回数が1日1回増えるだけで、仔の能力の抽選は変わらない。正規化後の差は変わらない）。課金で増える物でもない（無課金もパスも +24 で同じ）。
- 品物の目標：balance-targets 4.x の「配合素材は 90日で約85個たまり、使い切れない」（今の実測は 188 個）がさらに +13%。新しい問題ではなく、前からある「使い道を増やすか配布を減らす」の宿題が少し重くなる。オーナーは「2個」と決めたので、そのまま入れた（設定 `loginBonusOwnedSwap` の数で 1〜5 に変えられる）。
- 昇級の記念は見た目だけなので数字に出ない。コインのパックを6つにしても、どの想定も ¥800・¥2,400 を買わない（中課金は ¥5,000）ので数字は同じ。初回購入の無償コインの合計（全パックを1回ずつ）は 17,300 → 15,110（pass.md §4-4 のとおり）。

## 5. 出し方

`docs/ops/deploy.md` §7.3。先にリモート設定で5つのパックを止めて手当をパスへ（今の Worker で効く）、そのあと Worker を出す（昇級の記念とログボの差し替え）。

## 6. 残り・オーナーに聞くこと

- 配合素材がさらに余る（上の数字）。balance-targets の「使い切れない」はそのまま。使い道を増やすか配布を減らすかは前からの宿題。
- Unity の画面：昇級の記念の瞬間と突破のシートの1行はストリーム C（結果画面）とホームの担当が `PromotionModel` の新しいプロパティで描く。ログボのトーストの下の1行（`LoginBonusModel.SwapNote`）はストリーム A。
- 柄の絵（`promo_b/a/s`）は前からある物を使う。
