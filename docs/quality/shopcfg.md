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

（数字は下の表。前＝このブランチのコードで同梱の設定を元に戻した時、後＝このブランチ）

ECONOMY_TABLE

## 5. 出し方

`docs/ops/deploy.md` §7.3。先にリモート設定で5つのパックを止めて手当をパスへ（今の Worker で効く）、そのあと Worker を出す（昇級の記念とログボの差し替え）。

## 6. 残り・オーナーに聞くこと

- 配合素材がさらに余る（上の数字）。balance-targets の「使い切れない」はそのまま。使い道を増やすか配布を減らすかは前からの宿題。
- Unity の画面：昇級の記念の瞬間と突破のシートの1行はストリーム C（結果画面）とホームの担当が `PromotionModel` の新しいプロパティで描く。ログボのトーストの下の1行（`LoginBonusModel.SwapNote`）はストリーム A。
- 柄の絵（`promo_b/a/s`）は前からある物を使う。
