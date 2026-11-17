# Unity daily loop (U1-A)

Branch `unity/daily`. The daily loop's screens in the Unity runtime, built on the existing game-layer models and laid out from the
web prototype (`tools/figma-prototype/site/app.js`), in the ムチ一閃 kit (`MuchiApp.Kit.cs`).

## How it is built

- `unity/Assets/Muchi/Game/DailyLayout.cs` (pure C#, Muchi.Game): each screen as a list of boxes on the 1600×900 canvas — kind
  (Card, Kicker, Text, Link, Gauge, Pips, Rule, Cta, Ghost, Hit), position, font size, tone, the Japanese text and the action id.
  It places what the models say; it decides nothing.
- `unity/Assets/Muchi/Runtime/MuchiApp.Daily.cs`: draws those boxes with the kit (`Card`, `Kicker`, `Body`, `Cta`, `Ghost`,
  `Moment`) and maps action ids to screens. It holds no text of its own (a check fails if a Japanese literal appears there).
- Texts are Japanese; the screen shows `Loc.T(text)`. English is in `engine/Muchi.Client/Resources/Muchi/ui-en.json` (section
  `_u1daily`). The kit's language button switches `LocaleService`; the daily screens bring `Loc` along (`DailyLocale`).
- Edit to `MuchiApp.cs`: the old `Home()` body was removed (one comment marks the hook). Everything else is in the new partial file.

## Screens and models

| Screen | What it shows | Models |
|---|---|---|
| Home | goal ladder (今日 / 2週目 or はじめの10歩 / 今週 / シーズン, one 「受け取れる報酬があります ›」 line), wallet (free / paid apart), menu (厩舎 / 調教 / スカウト / 機能), partner plate (name, stage of five, 調教 +N, today's growth, the treat line → 調教), 次にやること (one line, its date, at most one link 「今日は閉じる」), race CTA 「レースへ」, tab crumbs | `GoalLadderModel` (Rungs, Partner, TomorrowLine), `NextActionModel.HomeLine` / `HomeLinks`, `HomeModel` (login bonus auto-claim → toast, unlocks), `TrainingModel.SlotsLeft`, `ProfileModel` |
| 目標 | three columns: 今日 (rows with reward and what it does; tomorrow line once done), 2週目 day cells / はじめの10歩 (step, 「やってみる ›」 or why not yet, 「ひとりでも：…」 solo line) / 今週 rows, シーズン (class, points, pace, why climb, links, season missions); one CTA 「まとめて受け取る（n件）」 | `GoalLadderModel` (Today, PathStep, PathScreen, PathLockText, PathAltLine, PathWaitText, Week2Days, Week2Goal, PowerLine, WhyClimbLine, PaceLine, SeasonMissions, PassLine, ClaimText) |
| Claim moment | the kit's `Moment`: 「4件受け取りました」, what arrived in one headline, tomorrow's reason once today is done (else 「今日の目標 4/5」) | `GoalLadderModel.ClaimAllAsync` + `ClaimMomentKicker / Headline / Line` (new) |
| クラスの階段 | each class: cap, line, top reward, the current one outlined | `GoalLadderModel.Ladder` |
| 調教 | horse panel (condition, bond, fatigue gauge, potential and stage, trained stats, the treat line with its numbers and 「おやつをあげる」, fairness rules), 2×2 menus (focus, fatigue, outlook, why blocked), CTA 「◯◯で調教」 | `TrainingModel` (Cards, FatigueText/Progress, PotentialProgress, TreatLine, TreatFatigueLine, RulesText) |
| Treat moment | `Moment`: the treat's name, 「りんごのおやつで伸び 85% → 100%」, the fatigue change | `TrainingModel.TreatLine` (captured before `UseItemAsync`) |
| 調教 play | head (menu, how, preview), beat lane, judge flash, live count, CTA 「追う」 (touch-down) or Space, スキップ | `TrainingModel` (BeginMiniGame, Tap, Elapsed, MiniGameOver, LiveScore, Skip, FinishAsync) |
| 調教 result | grade, total, gains, timing, stage line, per-stat bars against the cap, potential, CTA 「つづける」, 「目標の報酬を受け取る」 when the ladder has claims (the same claim moment); a stage up plays a `Moment` once | `TrainingModel` (GradeText, GainText, TimingText, StageUp, StageText, StageMomentLine / StageFromText / StageNextText new) |
| 機能 | the Unity screens with no home slot: 着せ替え, コース, コンディション, 飼い葉, シーズンパス | — |

## Model changes (checks first, `unity/Checks~/GameChecks/DailyScreensChecks.cs`)

- `GoalLadderModel.LastClaimCount`, `ClaimMomentKicker`, `ClaimMomentHeadline`, `ClaimMomentLine`: the one claim moment. Checked:
  nothing before a claim; 「4件受け取りました」; 「無償コイン 45枚　ほか2つ」 (two kinds or fewer: both named); today not done → 「今日の目標 4/5」;
  today done → `TomorrowLine`; fits the kit's Moment; English.
- `TrainingModel.StageFromText`, `StageMomentLine` (「新馬　→　成長期」), `StageNextText` (「充実期まで あと30」). Checked with and
  without a stage up, and in English.

## Verification

- `dotnet build` of `unity/Checks~/Muchi.Game`, `UnityRuntime`, `UnityFirebase`, and `dotnet run --project unity/Checks~/GameChecks`: pass.
- Layout audit (GameChecks, the boxes the screens draw): 42 screen states — home in 8 states (new player, day 1 / 1 done / 3 / 7 / 10,
  a busy ladder, offline) with four kinds of 次にやること, 目標 and クラスの階段 in the same 7–8, 調教 fresh / with the treat / tired /
  out of slots / offline × no menu / two menus chosen, play, result (stage up, plain, skipped), 機能. Every box inside 1600×900, no
  two text / button / gauge boxes overlapping (the language button included), text ≥ 16 px, each text fits its box (width estimate:
  CJK 1 em, Latin ≈ .6 em; wrapped text gets the lines it needs), at most one CTA. The audit is itself checked against a bad layout.
- English: every line drawn in those states translates (`Loc.T`), and buttons and kickers fit in English too. The game layer's
  literal check (L10nChecks) covers DailyLayout.cs. `npm run l10n:missing` (server): 0.
- Prototype cross-check: `bash tools/figma-prototype/build.sh`, then `E2E_ONLY=week` and `E2E_ONLY=unity` for the reference shots
  (w2-d7-home, w2-d7-goals, w2-d2-training-treat, u-39-training…). `MUCHI_LAYOUT_DUMP=<dir>` makes GameChecks write the audited
  boxes, and `tools/figma-prototype/test/render-unity-layout.py <dir> <png-dir>` draws them over the Unity art for a side-by-side look.
  Home, 目標 and 調教 match the prototype's structure and positions; differences are listed below.

## Differences from the prototype (on purpose)

- Body text is 16 px everywhere (the prototype has 12–15 px lines); the goal ladder is 540 wide (469), rows are a little taller.
- The language button keeps MuchiApp's place (1370,132) on home; the menu card starts at y 222 (190) to clear it. On the list
  screens it moves into the title row, like the prototype's EN toggle.
- The home menu's 4th row 「機能」 opens a small Unity screen with the five older screens; the crumbs are ホーム・厩舎・スカウト・ショップ・パス
  (the prototype's その他 has no Unity screen yet).
- No gift envelope, activity bell, comeback card, rival strip, promotion pips or account-link prompt on home (not Unity screens yet).

## Not done

- The horse card (stream C, `MuchiApp.Raising.cs`): the partner plate and 「馬カードで見る」 open 厩舎 for now (`DailyOpen`, TODO
  marked). After merging `unity/raising`, add the body the raising stream asked for:
  `partial void RaisingOpenTraining(string horseId, ref bool opened) { DailyTrainingFor(horseId); opened = true; }`
  (it cannot be added here: the defining declaration is on that branch).
- Links to screens Unity does not have (週替わりチャレンジ, ライバル, 支部, 配合 / フレンド steps, gift box) show a short note
  「この画面はUnity版でまだ準備中です」 instead of doing nothing.
- Not seen on a device: the boxes are audited, the kit's look is approximated by the renderer script.

## Owner / Codex decisions

- The bundled `NotoSansCJKjp-Bold.ttf` is a subset without ◎ ◈ ○ ★ ✓ − (U+2212). The models and the old screens already use
  ◎ / ◈ / ○ / −; the daily screens add ★ (the week-2 peak) and ✓ (claimed rows). On device these rely on the OS font fallback.
  Either add the glyphs to the font or swap the symbols — a font decision, not changed here.
- English labels that are much longer than the Japanese stay on one line (no wrap into the row below) and may run past their box;
  buttons and kickers are checked to fit.
