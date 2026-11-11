# Round 18 Codex 向け引き継ぎ：馬ごとの目標（per-horse goals、REQ-HGOAL-001〜016）

更新：2026-11-10　基準ブランチ：`feat/r18-horse-goals`（`origin/claude/round16` から）
仕様：`contracts/protocol.md` §53（§45.1 に `horse_goal_near` の行）、`docs/spec/requirements.md` 53章。経済の目標なし（報酬は見た目だけ。コイン・素材・アイテム・能力は動かない、E 番号・balance-targets の節なし）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/horses/:horseId/goals`・`PUT /v1/horse-goals/pin {horseId\|null}`・`GET /v1/horse-goals/pinned`、ブートストラップ／`GET /v1/player` の `horseGoalPin`。列は `server/src/domain/horseGoals.ts` の純粋関数（馬の芝ダ・距離・脚質・スキルの有無とコースの一覧から）、進みは §34 の戦績（確定したレースだけ）。戦績の画面 `GET /v1/horses/:horseId/career` に `goals`（達成数・全部達成）、殿堂の銘板に `goalsComplete`。次にやること（§45）に `horse_goal_near` |
| C# | ✅ `ApiClient.GetHorseGoalsAsync` / `PinHorseGoalAsync` / `GetPinnedHorseGoalAsync`、`HorseGoalsView` / `HorseGoal` / `HorseGoalPin`、`HorseGoalChain.Build` / `Evaluate`（サーバーと同じ、`contracts/horse-goals.vectors.json`）、`PlayerView.HorseGoalPin`、`AnalyticsEvent.HorseGoalView`、`NextKinds` に `horse_goal_near`（`engine/Muchi.Client/HorseGoals.cs`） |
| ゲーム層 | ✅ `Muchi.Game.HorseGoalsModel`（`unity/Assets/Muchi/Game/HorseGoalsModel.cs`、チェック `unity/Checks~/GameChecks/HorseGoalsChecks.cs`）。`NextActionModel.Row` に `horse_goal_near` の文言。英語は `ui-en.json`（面の文言）と `server-en.json`（目標の行） |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：厩舎（馬の詳細）の左下の「この馬の目標」パネル、「目標をすべて見る」の画面（`__muchi.show('HorseGoals', horseId)`）、ホームのピン（デモ「次にやること」= `__muchi.demo('next')` で相棒の目標をピン留め） |
| **Codex** | 馬の詳細のパネル（§2）、目標の画面（§3）、ホームのピン（§4）、次にやることのカード（§5）、殿堂・戦績の印（§6）、文字の大きさ・英語（§7） |

## 2. 馬の詳細の「この馬の目標」パネル

**場所**：馬の詳細（厩舎）の画面の左下、馬の写真の上。見本では 1600×900 の舞台で x=40, y=560, 600×250。右の能力パネルと重ねない。

**形**（紺の半透明パネル `box()`、不透明度 .86、ムチ一閃のトーン）：
- 左上：字間の広い小さなシアンのラベル「この馬の目標」（`HorseGoalsModel.Title`）。右上：金色で `SummaryText`（「目標 1 / 7」）。
- 今の目標（`Rows` のうち `Current`）：上にシアンの小さな章の名前（`ChapterText`：はじまり／場数／得意の馬場／コースの記録／得意の外へ／勝ち星／ランク戦／頂点）、その下に白い太字の1行（`Text`、`Loc.T` を通す）、細いゲージ（`Ratio`）と右に `ProgressText`（「7 / 10」、数字は等幅）。
- その下に列の印（達成 ■・今 ▣・まだ □。絵にしてよい：小さな菱形やリボンの点でもよい）。
- 下：線のボタン2つを同じ大きさで横に並べる「目標をすべて見る」→ §3、「ホームに出す」／「ホームから外す」（`CanPin` か `IsPinned` の時だけ。`TogglePinAsync`）。**塗りの CTA にしない**（馬の詳細の主ボタンは「この馬で出走」のまま）。
- 全部達成（`ChainComplete`）：今の目標の代わりに金色で「物語を走りきった」（`RibbonText`）と小さく「達成の印は見た目だけです」。リボンの小さな絵（金・紺）を添えてよい。**光る・点滅する演出はしない**（§41 の点滅の上限。動かすなら一度だけ、減らす設定では止める）。

## 3. 目標の画面（全部の列）

- 上：`TopBar`「この馬の目標」＋「確定したレースで進む、この馬だけの物語　·　達成の印は見た目だけ」。財布は出さない（ショップへの道を作らない）。
- 左パネル（x=36, y=134, 420×676）：馬の名前（**プレイヤーが付けたまま、訳さない**）、脚質・芝ダ・距離、大きな金色の数字で達成数「3 / 7 達成」、全部達成ならリボン、引退した馬なら「引退した馬の目標は、達成したまま残ります」、ルールの文（`RulesText`）。下に塗りの CTA「ホームに出す」／「ホームから外す」（この画面の主ボタンはこれだけ。出せない馬では出さない）。
- 右パネル（x=476, y=134, 1088×676）：列の行（6〜8行）。各行：番号（01〜08、達成は金・今はシアン・まだは暗い色）、章の名前（小さなシアン）、目標の1行、ゲージ（達成は金）、右に「7 / 10」か「達成」。行の間は細い線（`Hair`）。今の行だけ太字。
- 戻る：左下の BACK（馬の詳細へ）。

## 4. ホームのピン（`HorseGoalsModel.Pinned`）

- 場所：ホームの**下の中央、次にやることのカードのすぐ上**。見本では x=520, y=470, 560×76（次にやることのカードは y=560）。上のバーには何も足さない。
- 形：紺の半透明の細い帯。左上に小さなシアンの「ピン留めした目標」、右上に馬の名前（灰色、訳さない）、2行目に目標の1行（白・太字）と右に「7 / 10」（金）。帯ごと押せる → その馬の §3 の画面。
- 出し方：ホームの他の要素の後に下から少し上がる（`rise`）。ピンが無い（`Pinned == null`）時は何も描かない（空の枠を出さない）。
- 帯が画面に出たら `ReportHomeView()`（KPI `hgoal_view` home、1ゲーム日に1回はモデルが守る）。

## 5. 次にやること（§45）のカード `horse_goal_near`

`NextActionModel.Row` が文言を作る：主カード「馬の目標まで あと2」／「ピン留めした目標（確定したレースで進みます）」／「目標を見る」、チップ「馬の目標 あと2」。開く画面 `horse_goals`（`RefId` = 馬ID）→ §3。期限は無い（日付も出さない）。ピンの帯と同じ画面に出てもよい（カードは「あと少し」の時だけ出る）。

## 6. 殿堂・戦績の印

- 戦績の画面（`HallModel.Career` の元の `GET /v1/horses/:horseId/career`）の `goals.chainComplete` が true なら、馬の名前の横に小さな金のリボン。
- 殿堂の銘板（`Plaque.goalsComplete`、友達の殿堂にも出る）：銘板の右下に小さな金のリボン（額縁 `frame` とは別。両方付くことがある）。**印は見た目だけ**：説明の文に「強くなる」「有利」などを書かない。

## 7. 文字の大きさ・英語・法務

- §41 の文字の大きさ（最大）で、パネル・帯・行が箱からはみ出さないこと（見本の a11y-flow で確かめている：馬の詳細・目標の画面・ホームの帯）。1行の目標は `fitText` で縮めてよい（日本語は標準より小さくしない）。
- 英語：面の文言は `ui-en.json`、目標の行は `server-en.json`（`Loc.T`）。馬の名前は訳さない（ホームの相棒のパネルと同じ扱い：英語ではカタカナの名前をローマ字にするだけ、`Loc` の名前の規則）。
- 賭けの言葉（`server/src/domain/bettingWords.ts`）・煽り（「今だけ」「残りわずか」「倍」）・カウントダウンを使わない。リボンや達成の演出に「当たり」「大当たり」などの言葉も使わない。
- ショップ・購入への導線を置かない（目標は買えない・近道できない）。

## 8. 描くもの一覧（絵・部品）

| 部品 | 使う場所 | 備考 |
|---|---|---|
| 小さな金のリボン（16〜24px） | パネルの全部達成・目標の画面・戦績・殿堂の銘板 | 金（`--gold`）と紺。光らせない |
| 列の印（達成・今・まだ の3状態） | パネル | 見本は ■ ▣ □ |
| 章の名前のラベル | パネル・目標の画面 | シアンの字間の広い小さな字 |
| ピンの帯 | ホーム | 紺の半透明、押せる |
