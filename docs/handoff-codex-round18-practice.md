# Round 18 Codex 向け引き継ぎ：練習レース（REQ-PRAC-001〜018）

更新：2026-11-10　基準ブランチ：`feat/r18-practice`（`origin/claude/round16` から）
仕様：`contracts/protocol.md` §50、`docs/spec/requirements.md` 50章。**E 番号なし：練習は何も配らない**（コイン・ミッション・パス XP・戦績・レート・殿堂・振り返り・ライバル・共同目標のどれも動かない）。報酬の欄・演出は一切描かない。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・レースの組み立て・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/practice/catalog`（読み取りだけ：頭数・CPU の強さ・全コースと馬場・ナイター・その日の馬場・CPU の馬・自分の現役の馬・有効なルールセット）。`server/master/practice.json`（強さは既存の CPU の定義から：初心者マッチ／レートの段）。KPI `practice_start`・`practice_finish`（クライアント）。**練習の結果を受け取る API は無い** |
| C# | ✅ `engine/Muchi.Client/Practice.cs`：`PracticeCatalog`（`Parse`・`Fallback`）、`PracticeSetup`（`Problem`・`Encode`/`Decode`）、`PracticeOptions`、`PracticeSession`（`BuildConfig`・`Start`・`Restart`・`ChangeSetup`・`Ghost`・`Advice`・`WhipWindow`・`RaceNow`・`Result`）、`PracticeClock`、`PracticeResult`、`PracticeTexts`、`ApiClient.GetPracticeCatalogAsync`、`AnalyticsEvent.PracticeStart/PracticeFinish`。共通の見本 `contracts/practice-catalog.sample.json` |
| ゲーム層 | ✅ `Muchi.Game.PracticeModel`（`unity/Assets/Muchi/Game/PracticeModel.cs`、チェック `unity/Checks~/GameChecks/PracticeChecks.cs`）。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → レース（出走登録）→「練習レース」、または ホーム →「機能・イベント」→「練習レース」。本物の WASM エンジンで走る |
| **Codex** | 入口（§2）、設定画面（§3）、レース中の追加表示（§4）、結果画面（§5）、写真（§6）、アクセシビリティ（§7） |

## 2. 入口

- `PracticeModel.Available`（FTUE が終わったら true）が false の間は入口を出さない（FTUE の初レース→命名→無料10連→ホームと競わない）。
- 置く場所：レースの出走登録画面の下に小さめのゴーストボタン「練習レース」、「機能・イベント」の一覧の最後の行。オフラインのエラー（「オフラインです。練習レースは遊べます」）のボタンからも開く。
- **次にやること（§45）のカードにはしない。ポップアップで勧めない。**

## 3. 設定画面（`PracticeModel.LoadAsync` → 選択肢）

背景はコースの写真（芝 `Art/first-ride`、ダート `Art/race-result`）、紺のパネル2枚（見本：左 900×676 設定、右 604×676 オプション）。小さな字間のシアンの見出し「01 / 馬」「02 / コース・馬場」「03 / 頭数・相手の強さ」。

- 馬：`Horses`（`Label` = **プレイヤーが付けた名前。翻訳しない・Loc.T に通さない**、`Detail` = 脚質と距離、`Partner` = 相棒の印）。‹ › で切り替え（`SelectHorse`）。
- コース：`Courses`（`Label` = コース名、`Detail` = 「ナイターあり」）。‹ ›（`SelectCourse`：その日の馬場に戻る、照明の無いコースは昼に戻る）。
- 馬場：`Goings`（4つ、`Detail` に「今日の馬場」）→ `SelectGoing`。
- 昼／ナイター：`NightAvailable` の時だけトグル（`SelectNight`）。照明が無ければ「照明なし（昼だけ）」の文字。
- 頭数：`FieldSizes`（2〜12、− n + のステッパー）→ `SelectFieldSize`。
- 強さ：`Strengths`（`Label`「やさしい／ふつう／つよい／いちばん強い」、`Detail` に説明「初心者マッチと同じ相手」など）→ `SelectStrength`。選んだものの説明を下に1行。
- オプション（右）：`OptionWhip`・`OptionSlow`・`OptionGhost` の3つのトグル（`SetOptions`）。
- 右の下に必ず金の1行「報酬はありません（練習）」と、「何回でも走れます。端末の中だけで走るので、オフラインでも遊べます。」「練習のリプレイはマイリプレイに保存されません。写真は撮れます。」
- CTA「練習を始める »」（スキューのシアン）→ `StartRace()`。`Problem` が null でない時は押せない（理由を WARN 色で1行）。

## 4. レース中（`StartRace`/`Restart` → `OfflineRaceDriver`、毎フレーム `Frame(realMs)`）

**普通のレースの HUD をそのまま使う**（残り距離・順位・スタミナ・ムチ・手綱・内外・実況・字幕・かんたん操作・ムチの長押し）。`Driver.Update` は呼ばずに `PracticeModel.Frame(realMs)` を呼ぶこと（練習の時計で進める）。その上に足すもの：

- **ムチの目安の帯**（`PracticeFrame.BandFromM`〜`BandToM`）：残り距離のバー（見本：左上の残り距離チップの下、250×46）に帯を重ね、自分の位置の目盛りを動かす。`InBand` の間は帯を明るく（**点滅させない**）。色は `PracticeFrame.BandColor`（§41 のトークン `cue.whipChance`、色覚の設定で変わる）。帯の横に「ムチの目安」の文字（色だけに頼らない）。オプション OFF なら `BandFromM` が null → 帯を出さず「残り距離」のバーだけ。
- **スロー**（`PracticeFrame.Slow`）：最後の400mで true。画面に小さなチップ「スロー 0.5×」。カメラ・音のピッチを落とすのは任意（音は 0.5× に合わせる、ピッチは変えない方が良い）。**切り替えはその場で**（`TransitionMs(normal)` が動きを減らす設定で 0 を返す）。
- **ゴースト**（`GhostLabel`・`GhostGapM`）：前回の自分の馬を半透明で（タイムアタックのゴーストと同じ描き方、`Session.Ghost.Horse` / `PreviousHorse` を `CourseFrame` で置く）。名札「前回　アカツキ　1:12.4」、HUD の上の中央に「前 3.2m／後ろ 1.0m」。色は位置のトークン `position.other` を半透明で。
- 「やり直す」ボタン（中断・フォトの横）→ `Restart(PracticeRestart.SameSeed)`。確認は出さない（何も失わないので）。
- 「フォト」ボタンは練習では押せる（ひとりで走るレース）。§6。

## 5. 結果画面（`Result()` → `PracticeResultView`）

背景 `Art/race-result`、左に紺のパネル（見本 603×804、`ResultPanel` と同じ）。見出し「練習レース　/　コース名」。

- 大きな着順 `PlaceText`（「3着 / 8頭」）・タイム `TimeText`。
- `Lines`（順番どおり）：振り返り（Round 8 の勝因・敗因の1行）、ヒント、アドバイスとの比べ（「ムチはアドバイスどおり残り400mから」）、前回との差（「前回より0.42秒速い」）、**最後に必ず「報酬はありません（練習）」（金）**。コイン・XP・ミッション・シーズンpt の欄は描かない。
- ボタン `Buttons`：`same_seed`「同じ展開でもう一度 »」（CTA）、`new_seed`「新しい相手で」、`change`「条件を変える」、`photo`「この瞬間を撮る」（`ButtonText(id)`）。**「リプレイを保存」「リプレイを共有」は出さない**（§50.7：練習はサーバーに無いのでマイリプレイに入らない／着順入りの共有カードは本物のレースに見える）。
- 勝った時の派手な演出（紙吹雪・ファンファーレ）は控えめに：練習なので普通のレースの勝利演出は出さない（「1着」の文字だけ）。

## 6. 写真（§38）

- レース中：`PhotoModeModel.OpenPaused(model.Driver, api, …, clock: () => model.Session.RaceNow(now))` — **時計は練習の時計を渡す**（スローの間に止めても再開がずれない）。閉じる時も同じ時計で `Close`。
- 結果画面：`PhotoModeModel.OpenFromResult(model.Driver, …)`。写真の記録の `source.mode` は `practice`、写真のカードの種類の表示は「練習レース」（「フレンド戦」とは出ない）。

## 7. アクセシビリティ（§41）

- 文字の大きさ：設定画面・結果画面の文字は全部 `AccessibilityModel.Px` に従う（最大でもはみ出さないこと。見本の a11y-flow で確認済み）。
- ムチの長押し：`PracticeModel.ApplyAccessibility(raceInput)`。かんたん操作：`PracticeModel.Assist` にサーバーの設定を入れてから `StartRace`。
- 動きを減らす：スロー・帯の切り替え・画面の遷移は `TransitionMs` に従う。帯は点滅しない。
- 色：帯 `cue.whipChance`、ゴースト `position.other`（半透明）、自分の目盛り `position.self`。

## 8. KPI（モデルが送る、Codex は何もしなくてよい）

`practice_start`（開始・やり直しのたび：コース・頭数・強さ・やり直しの種類）、`practice_finish`（1回の試走につき1回：着順、ゴールしなければ 0）。入力・seed・タイムは送らない。

## 9. 英語

`ui-en.json` に全部ある（`l10n:missing` 0、GameChecks の L10n で確認）。馬の名前（プレイヤーが付けた名前）は訳さない。
