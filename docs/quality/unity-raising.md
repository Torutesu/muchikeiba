# Unity screens U1 — C. 育成（raising）

ブランチ `unity/raising`（`claude/unity-screens-base` から）。Unity の画面は `unity/Assets/Muchi/Runtime/MuchiApp.Raising.cs`、
画面の矩形と文言の純粋な部分は `unity/Assets/Muchi/Game/RaisingScreens.cs`。見本はプロトタイプ
（`tools/figma-prototype/site/app.js` の HorseCard / Breeding / FoalReveal / Pedigree / ResultScreen / PromoResultCard）。

## 作った画面と使うモデル

| 画面 | 入口 | モデル |
|---|---|---|
| 馬カード（能力・調教の伸び・上限・得意・成長段階・戦績・血統・最近の調教） | 厩舎の「馬カード」、結果画面、仔馬のお披露目 | `HorseProfileModel`、`TrainingModel.GradeTexts` |
| 配合（父母の候補3頭ずつ＋狙いの行「SR以上 x%・◎ ニックス・近親」、仔の見込み、レア度の帯、受け継げるもの、今日の回数、ルール） | 厩舎の「配合」、引退馬の馬カード | `BreedingModel`（追加：`LoadAimsAsync` / `AimLine` / `TodayLine` / `RarityOddsText` / `CompatibilityText` / `DistanceText`） |
| 仔馬のお披露目（4段：性別と脚質 → 5能力が見込みの幅のどこに落ちたか → レア度と見込み → スキル・隔世遺伝・父母。「めくる」「すべて見る」、素材があれば「もう1回配合する」） | 配合する | `BreedingModel.Reveal`（追加：`RevealSexStyleText` / `RevealSummaryText` / `RevealSkillText` / `RevealAtavismText` / `RevealParentsText`、既存の `AgainWithMaterialLine`） |
| 血統（最小版：3代15枠、共通の祖先はシアンの枠と「共通」、記録なし、借りた種牡馬の持ち主、近親の行、自分の祖先はタップで開く） | 馬カードの「血統 ›」、配合の「父の血統 ›」「母の血統 ›」 | `PedigreeModel`（`ApiPedigree`） |
| レース結果（1.4 の HUD ルール） | レース後 | `RaceResultModel`、追加：`ResultRewards` / `ResultLines` / `ResultPromotionPlan`、`PromotionModel` |

結果画面の中身：
- 着順・頭数・タイム。勝因／敗因、振り返りの1行（能力の差 → 1.4 の仕掛けの教訓 → 会心の数。箱に入らなければ会心から落とす。馬が弱いときは「能力の差」を残し、乗り方の差のときは一般の行を先に落とす＝プロトタイプと同じ）。
- 着順コインの行：**サーバーの値**。レース開始時の財布とシーズンpt を控え、結果の確定後に `RefreshAsync` した値との差を出す（着順コイン＋初勝利ボーナスはサーバーが付ける。クライアントは計算しない）。練習・照合中・無効・控えがないときは数字を出さない。
- 昇級戦：結果の確定後に `AfterRankedResultAsync`。**ポップアップ（決着のシート、`Moment`）かカードのどちらか一方だけ**。シートが出たらカードは出さない（閉じた後も同じ決着のカードは出さない）。カードはこのレースが始めた・数えた・決めたシリーズだけ（`PromotionModel.TouchedByLastResult` を追加）。
- 昇級の報酬（stream D：クラスの柄を昇級の無料報酬に）：カードとポップアップの行に出す。受け取り済みなら「昇級の記念「…」を受け取りました（無料）」、まだなら「B級に上がると「…」が届きます（無料）」。

## モデルの変更とチェック（先に落ちるチェックを書いてから実装）

`unity/Checks~/GameChecks/RaisingScreenChecks.cs`（Program.cs に1行）：
- 配合の狙いの行（候補ごとに相手の親とのプレビュー、ニックス・近親）、今日の行、レア度の行、相性・距離の行。
- お披露目の各段の行、「もう1回」の行。
- 昇級：開始カード／触れていないシリーズは何も出さない／2/3 のカード／決着はポップアップでカードなし／報酬の言い方（届く・受け取った・なし）／ゲートが埋まっているときはカードに決着と報酬。
- 着順コイン：確定値、練習、照合中、無効、控えなし。
- 振り返りの行の詰め方（3行に入る／2行なら会心から／乗り方の差なら一般の行から）。
- **レイアウト監査**：7画面・状態すべてで、文字の矩形が重ならない（言語ボタン 1370,132 195×72 も予約）、1600×900 の内側、本文 16px 以上、CTA は各画面ちょうど1つ、実際の長い文言（モデルの出力）が箱に入る（CJK 1em・英数 0.6em・行 1.45em の見積もり）。監査が重なり・はみ出し・小さい文字・CTA 2つ・あふれを見つけることも確認。
- 新しい文言すべてに英語（`ui-en.json` に 87 行、`L10nChecks` の全リテラル検査も通る）。売り・あおり・賭けの言葉なし。

## 確認したこと

| コマンド | 結果 |
|---|---|
| `dotnet build unity/Checks~/Muchi.Game` | OK |
| `dotnet build unity/Checks~/UnityRuntime` | OK |
| `dotnet build unity/Checks~/UnityFirebase` | OK |
| `dotnet run --project unity/Checks~/GameChecks` | GAME CHECKS OK |
| `dotnet test engine/Muchi.Engine.Tests --filter Localization`（ui-en.json の形） | 8/8 |
| `npm run l10n:missing`（server） | 0 |
| `bash tools/figma-prototype/build.sh` ＋ `E2E_ONLY=quality node tools/figma-prototype/test/e2e.cjs` | OK（q-result*, q-breeding-reveal-reduced） |

座標はプロトタイプのパネル（馬カード 36,110 800×700 / 860,110 704×700、配合 3枚、お披露目 36,80 1060×740、結果 33,48 603×804、昇級カード 900,…）から。
Unity の言語ボタン（1370,132）の下に文字が来ないように、右のパネルの上の行と昇級カード（y 230）、血統の木（y 220）をずらした。
プロトタイプの見本（844×390）と並べて、パネルの位置・行の順・CTA の位置が同じことを目で確かめた。Unity は開けないので実機の見た目は未確認。

## やっていないこと

- 馬カードの最近の調教にメニュー名は出さない（評価と伸びだけ。メニュー名は調教の画面のデータ）。「目標 ›」のリンクなし。
- 配合の「見込みを上げるには」（基準 95%・覚醒・ニックス +30 の説明）と「SR は 3,200 以上」の行：数字がクライアントにないので出さない（サーバーの値を送ってもらえば出せる）。借りた種牡馬の一覧・登録の画面、「配合の血統」（父母2本の木）、系統の画面はなし。
- 血統は最小版（サムネイルなし、行表示への切り替えなし）。
- 結果画面の着順表・パスXP・ミッションの詳細シート、リプレイ・写真・見どころの行はなし。オンラインの 1.4 の教訓（確定入力での再計算）は未接続（オフラインは既存どおり出る）。
- 英語では文字が長くなる。監査は日本語の文言で行った（英語のはみ出しは未確認）。
- 演出（帯のピンが動く、SR/SSR の光）はなし。お披露目は段ごとに描き直す。

## 他のストリームとまとめるとき

- **stream D（quality/shopcfg）**：昇級の報酬のフィールドを `PromotionView` に足したら、`MuchiApp.Raising.cs` の `RaisingPromotionReward()`（今は null）でそれを `PromotionRewardInfo { Name, Granted }` に詰める。それだけで結果のカードとポップアップに出る。
- **stream A（調教）**：`partial void RaisingOpenTraining(string horseId, ref bool opened)` を実装すると馬カードの「調教する」が調教の画面を開く（今は世話の画面）。
- アプリ全体の「1セッション1つ」のゲート（`SessionPrompts`）がまだないので、昇級のシートは `raisingPrompts` を使う。共通のものができたら差し替える。
- `MuchiApp.cs` の変更は3か所だけ：`Result()` を1行に、`StartDriver` に `RaisingRaceStarted()`、厩舎に「馬カード」「配合」のボタン。

## オーナーに決めてほしいこと

1. 昇級の報酬を**いつ渡すか**：昇級戦を突破した時か、シーズンの締めでクラスが上がった時か。画面は両方の言い方を持っている（`Granted`）。
2. 色：プロトタイプは「期待以上」「得意」「成長段階」「素質」を金色にしているが、Unity では「金はレア度・順位・お金だけ」に合わせてシアン／白にした。金に戻すかどうか。
3. 着順コインの行は「着順コイン＋初勝利ボーナス」の合計（サーバーの確定値の差）。内訳を分けて見せたいなら、サーバーにレースの報酬を返してもらう必要がある。
