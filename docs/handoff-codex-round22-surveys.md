# Round 22 Codex 向け引き継ぎ：ゲーム内アンケート（ops-run in-app surveys、REQ-SURVEY-001〜024）

更新：2026-11-11　基準ブランチ：`feat/r22-surveys`（`origin/claude/round20` から）
仕様：`contracts/protocol.md` §69、`docs/spec/requirements.md` 69章、法務 `docs/planning/03-legal-risk.md`「ゲーム内アンケート」、UX `docs/planning/06-ux-experience-spec.md` 補足（Round 22）、運営 `docs/ops/console.md`「アンケート」。経済の目標なし（**答えても何も配らない**。E 番号なし）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目**。

> **R22 統合での変更（必読）**：アンケートは**目立つ場所に出さず、割り込まない**。ホームのカードとレース結果の後のシートは**無くなった**。入口は「お知らせ（ホームのベル）」の画面の中の静かな1行「アンケートにご協力ください ›」だけ。未読ならその画面で行の横に小さな点だけ（**ホームのバッジ・ベルの数には足さない**）。§58.11 の「1セッションに1つ」の表にも入らない（`SessionPrompts` を渡さない）。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/surveys/current?placement=inbox`（応答に `unread`）・`POST /v1/surveys/:id/shown`・`POST /v1/surveys/:id/skip`・`POST /v1/surveys/:id/answers`（冪等キー必須）。定義は運営の画面（`/v1/admin/surveys`、OpsDO の表。**新しい Durable Object・wrangler の移行は無い**）。設定は `progression.surveys` |
| C# | ✅ `engine/Muchi.Client/Surveys.cs`：`SurveyView`・`SurveyQuestion`・`SurveyOffer`・`SurveyAnswerBuilder`（サーバーと同じ検査）・`SurveyRules`・`ApiClient.GetSurveyAsync` / `SurveyShownAsync` / `SkipSurveyAsync` / `AnswerSurveyAsync`。エラー `ApiErrorCode.SurveyClosed` |
| ゲーム層 | ✅ `Muchi.Game.SurveyModel`（`unity/Assets/Muchi/Game/SurveyModel.cs`、チェック `unity/Checks~/GameChecks/SurveyChecks.cs`）。`SessionPrompts` は使わない（割り込まない）、`AccountChangeReset.Surveys`。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：`__muchi.show('Survey', 'inbox')`（お知らせの中の行）・`'sheet'`（行を押した後のシート）・`'thanks'`。デモの状態（運営が公開したアンケート1本、落ち着いたプレイヤー） |
| **Codex** | モデルを呼ぶ場所（§2）、お知らせの中の行（§3）、シートと4種類の問い（§4）、ありがとう（§5）、文字の大きさ・英語（§6） |

## 2. モデルを呼ぶ場所

アプリ起動ごとに `SurveyModel` を1つ作る（`Prompts` は無い：割り込まないので §58.11 の表に入らない）。`inFtue` には `OnboardingFlow.InFtue` を渡す。アカウントが変わった時の `AccountChangeReset` の `Surveys` にも入れる。

| いつ | 呼ぶもの |
|---|---|
| お知らせ（ホームのベル）の画面を開いた時 | `await CheckAsync()` → true なら `RowVisible`（行を出す）。`Unread` なら行の横に小さな点 |
| 行「アンケートにご協力ください ›」を押した時 | `await OpenAsync()` → `SheetVisible`（ここで初めて「出した」を数える） |
| シートの「次へ」「とばす」 | `Next()`（最後のページは `SubmitAsync()`） |
| シートの「戻る」 | `Back()` |
| シートの「あとで」・Android の戻るボタン（スキップではない） | `Later()` → お知らせに戻る。行は残る（サーバーが開いた回数に上限を持つ） |
| シートの「スキップ」（**1タップ**、確認ダイアログを出さない） | `await SkipAsync()` → お知らせに戻る。行は消える |
| 「送る」 | `await SubmitAsync()` → 成功なら `ThanksVisible`。`SURVEY_CLOSED` などは `Message`（「このアンケートは終了しました」）をトーストで出してシートを閉じる |
| ありがとうの「閉じる」 | `CloseThanks()` → お知らせへ（行は消えている） |

**出さない所**：ホーム（カード・バッジ・ベルの数）・レースの前後・ガチャ・購入・チュートリアル（FTUE）の間・プッシュ・ローカル通知。オフラインでは行を出さない（モデルが判断）。

## 3. お知らせの中の行（`RowVisible`）

- お知らせの画面の右の面、「予定表 ›」の下に、同じテキストリンクの形で `SurveyModel.RowLabel`「アンケートにご協力ください ›」。目立つ色・アイコン・アニメーションは付けない。
- `Unread` の時だけ、行の左に小さな点（お知らせの一覧の未読の点と同じもの、10px）。**ホームのベルの数字・バッジには足さない**。
- 赤い点の明滅・カウントダウン・「今だけ」・報酬の言葉は付けない。

## 4. シート（`SheetVisible`）

- 画面の中央の紺のダイアログ（プロトタイプ 1040×700）。背景はお知らせの画面のアートを暗くしたもの。
- 上：`Kicker`、題（小さく灰色）、右上に `Progress`（「2 / 4」、水色、数字の字体）。
- 問い `Current.Text`（大きく太字、2行まで折り返す）。任意の問いには `OptionalNote`「任意」の小さなラベル。
- 種類ごと（`Current.Kind`）：
  - `single`：選択肢を縦（4つ以上は2列）に並べたチップ（`.choice`）。押すと `Answers.Choose(id, optionId)`、選んだものは水色の枠。
  - `multi`：同じチップで `Answers.Toggle(id, optionId)`。上に `string.Format(Loc.T(ChoicesFormat), MaxChoices)`。上限を超えて押したら何も変えず小さなトースト。
  - `scale`：1〜5 の5つの四角いボタン（同じ大きさ、数字は大きく）。左下に `LowLabel`、右下に `HighLabel`。`Answers.Scale(id, n)`。
  - `text`：複数行の入力欄（`TouchScreenKeyboard`）。下に `TextHint`（個人情報を書かない）と `string.Format(Loc.T(RemainingFormat), Answers.Remaining(id))`、0未満なら赤く、主ボタンを押せなくする（`CanNext`）。入力は `Answers.Text(id, text)`。**送る前にプレイヤーの文を端末で直さない**（スクラブはサーバーがする）。
- 下：左に「あとで」と `SkipLabel`（どちらもテキストリンク、1タップ）、真ん中に `BackLabel`（2ページ目から）、右に主ボタン `NextButton`（「次へ」／「とばす」／「送る」）。必須の問いに答えるまで主ボタンは押せない（`CanNext`）。
- **報酬・コイン・アイテム・プレゼントの言葉、演出（紙吹雪など）は出さない。**

## 5. ありがとう（`ThanksVisible`）

小さなダイアログに `Kicker`、`ThanksTitle`「ありがとうございました」（大きく）、`ThanksBody`、副ボタン `CloseLabel`「閉じる」だけ。報酬の表示・効果音のファンファーレは無し。

## 6. 文字の大きさ（§41）・英語

- 文字の大きさの最大でも問い・選択肢が切れないこと（選択肢は2列→1列へ、問いは3行まで）。チップと 1〜5 のボタンは 44pt 以上。
- アンケートの文言（題・問い・選択肢・両端の言葉）は**サーバーが端末の言語で返す**（`Accept-Language`）。英語の時に `Loc.T` を通さなくてよい（通しても変わらない）。言語を切り替えたら `CheckAsync` からやり直さず、次の起動で反映でよい。
- モデルの固定の文言は `ui-en.json` に英語がある（`アンケート` … `あと{0}文字`）。

## 7. KPI・プライバシー（Codex は何もしない）

KPI（`survey_shown`・`survey_skip`・`survey_answer`）はサーバーが書く（§58 の分析がオフなら書かれない）。端末から KPI を送らない。答えの中身をログ・クラッシュ報告に入れない。
