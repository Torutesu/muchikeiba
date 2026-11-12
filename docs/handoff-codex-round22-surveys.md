# Round 22 Codex 向け引き継ぎ：ゲーム内アンケート（ops-run in-app surveys、REQ-SURVEY-001〜024）

更新：2026-11-11　基準ブランチ：`feat/r22-surveys`（`origin/claude/round20` から）
仕様：`contracts/protocol.md` §69、`docs/spec/requirements.md` 69章、法務 `docs/planning/03-legal-risk.md`「ゲーム内アンケート」、UX `docs/planning/06-ux-experience-spec.md` 補足（Round 22）、運営 `docs/ops/console.md`「アンケート」。経済の目標なし（**答えても何も配らない**。E 番号なし）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/surveys/current?placement=home\|result`・`POST /v1/surveys/:id/shown`・`POST /v1/surveys/:id/skip`・`POST /v1/surveys/:id/answers`（冪等キー必須）。定義は運営の画面（`/v1/admin/surveys`、OpsDO の表。**新しい Durable Object・wrangler の移行は無い**）。設定は `progression.surveys` |
| C# | ✅ `engine/Muchi.Client/Surveys.cs`：`SurveyView`・`SurveyQuestion`・`SurveyOffer`・`SurveyAnswerBuilder`（サーバーと同じ検査）・`SurveyRules`・`ApiClient.GetSurveyAsync` / `SurveyShownAsync` / `SkipSurveyAsync` / `AnswerSurveyAsync`。エラー `ApiErrorCode.SurveyClosed` |
| ゲーム層 | ✅ `Muchi.Game.SurveyModel`（`unity/Assets/Muchi/Game/SurveyModel.cs`、チェック `unity/Checks~/GameChecks/SurveyChecks.cs`）。`SessionPromptGate` に `SessionPromptKind.Survey`（**最も低い優先度**）、`AccountChangeReset.Surveys`。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：`__muchi.show('Survey', 'home')`（ホームのカード）・`'result'`（結果の後のシート）・`'thanks'`。デモの状態（運営が公開したアンケート1本、落ち着いたプレイヤー） |
| **Codex** | モデルを呼ぶ場所（§2）、ホームのカード（§3）、シートと4種類の問い（§4）、ありがとう（§5）、文字の大きさ・英語（§6） |

## 2. モデルを呼ぶ場所

アプリ起動ごとに `SurveyModel` を1つ作り、`Prompts` に同意・通知・レビューと**同じ** `Muchi.Client.SessionPrompts` を渡す（R22 統合）。`inFtue` には `OnboardingFlow.InFtue` を渡す。アカウントが変わった時の `AccountChangeReset` の `Surveys` にも入れる。

| いつ | 呼ぶもの |
|---|---|
| ホームが表示されて落ち着いた時（ホームのカードの枠：お知らせ・復帰のカードが出ない時だけ） | `await CheckAsync(SurveyPlacements.Home)` → true なら `CardVisible` |
| レースの結果画面を「ホーム」で閉じた所（広告のオファー・かんたん操作の提案の後） | `await CheckAsync(SurveyPlacements.Result)` → true なら `SheetVisible`（シートをそのまま出す）、false ならホームへ |
| カードの「答える」 | `Open()` |
| シートの「次へ」「とばす」 | `Next()`（最後のページは `SubmitAsync()`） |
| シートの「戻る」 | `Back()` |
| カード・シートの「スキップ」（**1タップ**、確認ダイアログを出さない） | `await SkipAsync()` |
| 「送る」 | `await SubmitAsync()` → 成功なら `ThanksVisible`。`SURVEY_CLOSED` などは `Message`（「このアンケートは終了しました」）をトーストで出してシートを閉じる |
| ありがとうの「閉じる」 | `CloseThanks()` → 元の画面（ホーム／結果の後の行き先） |
| Android の戻るボタン（スキップではない） | `Later()`（また出ることがある。サーバーが出す回数に上限を持つ） |

**出さない所**：レース中・ゲートの演出・ガチャの演出・購入の途中・チュートリアル（FTUE）の間。オフラインでは出さない（モデルが判断）。1セッションに1本だけ（モデルが判断）。

## 3. ホームのカード（`CardVisible`）

- 置き場所はホームのカードの枠（左上、シーズンの下。プロトタイプ `HOME_CARD` 450×214）。**カードは1枚だけ**（お知らせ・復帰キャンペーン > アンケート > 広告のオファー）。
- 紺の半透明のパネル、上に水色の小さな字間を空けた見出し `SurveyModel.Kicker`「アンケート」、題 `Survey.Title`（太字、1行、はみ出す時は縮める）、`SurveyModel.NoRewardNote`（小さな灰色）。
- 主ボタン（水色の斜めの CTA「»」）`AnswerLabel`「答える」と、副ボタン（紺に水色の線）`SkipLabel`「スキップ」を**横に並べる**（スキップを隠さない・小さくしすぎない）。
- 赤い点・バッジ・カウントダウン・「今だけ」は付けない。終了日を出すなら日付だけ（`Survey.EndAt`、JST）。

## 4. シート（`SheetVisible`）

- 画面の中央の紺のダイアログ（プロトタイプ 1040×700）。背景は直前の画面のアート（ホーム or レース結果）を暗くしたもの。
- 上：`Kicker`、題（小さく灰色）、右上に `Progress`（「2 / 4」、水色、数字の字体）。
- 問い `Current.Text`（大きく太字、2行まで折り返す）。任意の問いには `OptionalNote`「任意」の小さなラベル。
- 種類ごと（`Current.Kind`）：
  - `single`：選択肢を縦（4つ以上は2列）に並べたチップ（`.choice`）。押すと `Answers.Choose(id, optionId)`、選んだものは水色の枠。
  - `multi`：同じチップで `Answers.Toggle(id, optionId)`。上に `string.Format(Loc.T(ChoicesFormat), MaxChoices)`。上限を超えて押したら何も変えず小さなトースト。
  - `scale`：1〜5 の5つの四角いボタン（同じ大きさ、数字は大きく）。左下に `LowLabel`、右下に `HighLabel`。`Answers.Scale(id, n)`。
  - `text`：複数行の入力欄（`TouchScreenKeyboard`）。下に `TextHint`（個人情報を書かない）と `string.Format(Loc.T(RemainingFormat), Answers.Remaining(id))`、0未満なら赤く、主ボタンを押せなくする（`CanNext`）。入力は `Answers.Text(id, text)`。**送る前にプレイヤーの文を端末で直さない**（スクラブはサーバーがする）。
- 下：左に `SkipLabel`（テキストリンク、1タップ）、真ん中に `BackLabel`（2ページ目から）、右に主ボタン `NextButton`（「次へ」／「とばす」／「送る」）。必須の問いに答えるまで主ボタンは押せない（`CanNext`）。
- **報酬・コイン・アイテム・プレゼントの言葉、演出（紙吹雪など）は出さない。**

## 5. ありがとう（`ThanksVisible`）

小さなダイアログに `Kicker`、`ThanksTitle`「ありがとうございました」（大きく）、`ThanksBody`、副ボタン `CloseLabel`「閉じる」だけ。報酬の表示・効果音のファンファーレは無し。

## 6. 文字の大きさ（§41）・英語

- 文字の大きさの最大でも問い・選択肢が切れないこと（選択肢は2列→1列へ、問いは3行まで）。チップと 1〜5 のボタンは 44pt 以上。
- アンケートの文言（題・問い・選択肢・両端の言葉）は**サーバーが端末の言語で返す**（`Accept-Language`）。英語の時に `Loc.T` を通さなくてよい（通しても変わらない）。言語を切り替えたら `CheckAsync` からやり直さず、次の起動で反映でよい。
- モデルの固定の文言は `ui-en.json` に英語がある（`アンケート` … `あと{0}文字`）。

## 7. KPI・プライバシー（Codex は何もしない）

KPI（`survey_shown`・`survey_skip`・`survey_answer`）はサーバーが書く（§58 の分析がオフなら書かれない）。端末から KPI を送らない。答えの中身をログ・クラッシュ報告に入れない。
