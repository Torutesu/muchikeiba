# Round 10 Codex 向け引き継ぎ：支部の応援スタンプ（REQ-TEAMFEED-001〜011）

更新：2026-11-06　基準ブランチ：`feat/r10-team-stamps`（`claude/round9` から）　前提：`docs/handoff-codex-round9.md`（アセット配信の置き場とスキャナ）
仕様：`contracts/protocol.md` §18、`contracts/assets.md`（kind `stamp`）、`docs/spec/requirements.md` §18

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API・画面のビューモデル）／Codex＝見た目（スタンプの絵を作って置く・画面を描く）**。
支部フィードには**自由入力の文字が一切無い**（スタンプと自動のレース結果だけ）。画面にテキスト入力欄を置かないこと。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/stamps`、`GET /v1/teams/me/feed`、`POST /v1/teams/me/feed/stamps`、`PUT …/feed/:seq/reaction`、`POST …/feed/:seq/report`、`GET|PUT …/feed/mutes`（protocol.md §18） |
| マスター | ✅ `server/master/stamps.json`（12種）、直販の2種は `items.json` の `kind: "stamp"`（見た目ショップの一覧に `kind: "stamp"` で並ぶ。装備はしない） |
| C# | ✅ `engine/Muchi.Client/TeamFeed.cs`（`GetStampsAsync`・`GetTeamFeedAsync`・`PostStampAsync`・`ReactToFeedItemAsync`・`ReportFeedItemAsync`・`SetFeedMuteAsync`）、`AssetKeys.Stamp(id)`、エラー `ApiErrorCode.StampLocked` |
| 画面のモデル | ✅ `unity/Assets/Muchi/Game/TeamFeedModel.cs`（`Palette`・`Rows`・`PostDisabledReason`・`CooldownMs`・`PostAsync`・`CheerAsync`・`SetMutedAsync`・`ReportAsync`・`LoadOlderAsync`）。GameChecks `Round10Checks.cs` |
| アセット | マニフェストに `stamp/*` 13件（12種＋`stamp/default`）。ファイルは **0件**（スタンプはラベルの文字だけで表示されている） |
| 画面 | **Codex**：支部画面の中にフィードとスタンプのパレット（§3）。見本はプロトタイプ `tools/figma-prototype/site/unity.html` の「その他 → 支部の応援」 |

## 2. スタンプの絵（Codex への依頼）

| キー | ラベル | 解放 | 絵の方向 |
|---|---|---|---|
| `stamp/cheer` | がんばれ！ | 最初から | 拳を上げる騎手（シルエット寄り）＋文字 |
| `stamp/nice` | ナイス！ | 最初から | 親指を立てる手袋 |
| `stamp/thanks` | ありがとう | 最初から | 帽子を取って一礼する騎手 |
| `stamp/gg` | おつかれ！ | 最初から | タオルと水桶、湯気 |
| `stamp/lets_go` | いくぞ！ | 最初から | ゲートが開く瞬間 |
| `stamp/clap` | パチパチ | 最初から | 拍手の手と小さな紙吹雪 |
| `stamp/whip` | ムチ一閃！ | 10戦 | シアンの閃光の斜線（タイトルロゴの「閃」の意匠）。ムチで馬を叩く描写はしない |
| `stamp/photo_finish` | ハナ差！ | 50戦 | 決勝写真の縦線と2頭の鼻先 |
| `stamp/legend` | 伝説の走り | 200戦 | 金の月桂冠と蹄跡 |
| `stamp/pass_crown` | 王者の風格 | シーズンパス購入 | 金の王冠（パスの金色に合わせる） |
| `stamp/carrot` | にんじん！ | 見た目ショップ 200コイン | にんじんをくわえた馬の顔（デフォルメ控えめ） |
| `stamp/horseshoe` | 幸運の蹄鉄 | 見た目ショップ 300コイン | 光る蹄鉄 |
| `stamp/default` | — | 同梱（boot） | 無地のスタンプ枠（絵が届くまでの代わり） |

- サイズ：正方形 256×256 px（表示は 96〜128 pt）。透過 PNG。文字（ラベル）は絵に入れない（ラベルはサーバーの文字を重ねる。ローカライズのため）。
- トーン：「ムチ一閃」の実写寄りの背景に乗る前提で、紺の半透明パネルの上で読める明度。シアン `#00CCF2`・金 `#FFD414` をアクセントに。擬人化しない、実在の人物・馬・団体に寄せない（docs/planning/03）。動物福祉：痛がる・叩かれる描写はしない。
- 置き場：`unity/AssetDelivery~/common/stamp/<id>.png` → キー `stamp/<id>`（round9 引き継ぎ §2 の規則のまま）。`stamp/default` はアプリに同梱（Resources）。置いたら `cd server && npm run scan:assets`。
- 先読みグループは `home`（`contracts/assets.groups.json` に `stamp/*` を追加済み）。チュートリアルは待たない。

## 3. 画面（Codex）

`TeamFeedModel` の値だけで描く（文言はモデルとサーバーが作る）。

1. **フィード**（左・大きく）：`Rows`（新しい順）。スタンプの行は `StampAsset` の絵＋`StampLabel`、レース結果の行は `Line`（「ミドリカワさんがランク戦で1着！」）を金色で。`When`（「2分前」）。リアクションは `Reactions`（スタンプとその数、自分のものは強調）。下までスクロールしたら `LoadOlderAsync()`（`HasOlder` の間）。
2. **応援**：`CanCheer` の行（支部員のレース結果）だけに「応援」ボタン。押すと選択中のスタンプで `CheerAsync(seq, stampId)`。同じスタンプなら取り消し（`MyReaction`）。
3. **パレット**（右）：`Palette` の全スタンプ。`Unlocked == false` は鍵＋`LockText`、`ShopItemId` があれば見た目ショップのその品へ。選んで送るボタン（1画面に塗りのボタンは1つ。「ムチ一閃」の斜めのシアン CTA ＋ »）。`PostDisabledReason` が null でなければボタンを無効にしてその文を出す（「あと8秒で送れます」・削除予定中のバナー・支部に未加入）。
4. **行のメニュー**（長押し or …）：「非表示（ミュート）」→ `SetMutedAsync(playerId, true)`（すぐ消える。設定から戻せる一覧は `Muted`）、「報告」→ `ReportAsync(seq, reason)`（理由は 迷惑・嫌がらせ・その他 の3択。すぐ消える）。自分の行には出さない。
5. エラーは `Message`（日本語の1文）をトーストで。`RATE_LIMITED` は「スタンプは10秒に1回、1日50回までです。」。

## 4. ショップ（ラウンド10の修正）

`ShopModel` は `GET /v1/shop/products?mine=1` を使うようになった。`ProductCard.Owned` が true なら購入ボタンの代わりに「購入済み」、`DisabledReason`（「今シーズンのパスは購入済みです」／パス＋は「今シーズンはパスを購入済みです（パス・パス＋はどちらか1つ）」）を表示する。

## 5. 確認の手順

```bash
dotnet run --project "unity/Checks~/GameChecks"          # round 10 の行が全て ok
cd server && npm test && npm run scan:assets              # stamp/* が 13 件として数えられる
bash tools/figma-prototype/build.sh                       # round10.test.mjs
node tools/figma-prototype/test/e2e.cjs                   # u-*-team-feed*.png, shop-pass-owned, season-pass-owned
```
