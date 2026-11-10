# Codex handoff — Round 17: 通報とブロック (report a player, manage blocks)

Spec: `contracts/protocol.md` §47, `docs/spec/requirements.md` §47 (REQ-RPT-001〜020), UX rules: `docs/planning/06-ux-experience-spec.md` 「通報とブロック」, legal: `docs/planning/03-legal-risk.md` 「通報とブロック」.
Reference layout: the web prototype (`tools/figma-prototype`, index.html → その他 › 通報とブロック; デモ: `index.html?demo=safety`). Screens in `.screens/u-*-blocks*.png`, `u-*-report-sheet.png`, `en-*-blocks*.png`, `a11y-*-blocks*.png`, `a11y-*-report-sheet*.png` after `node tools/figma-prototype/test/e2e.cjs`.

All logic is done: bind the Canvas to the public fields of the two models. Japanese in the models is the source; draw `Loc.T(model.X)`. Player names and the note are never translated (do not pass them through `Loc.T`).

## Models (unity/Assets/Muchi/Game)

| Model | File | Construct with |
|---|---|---|
| `ReportModel` — the report sheet | `ReportModel.cs` | `new ReportModel(new ApiReports(api), new ReportTarget(playerId, ReportContentKinds.X, ref), ReportSources.Y, () => online) { TargetName = name }` |
| `BlockListModel` — 通報とブロック | `BlockListModel.cs` | `new BlockListModel(new ApiReports(api), () => online)` |

`ActivityModel` now knows `ActivityKinds.OpsNotice` (label 「運営」, icon key `notice`) and `ActivityScreens.Safety`: route `safety` to the 通報とブロック screen.

## 1. The report sheet (右からのシート, 700 px wide in the prototype)

Open it from every place another player is visible: profile card, friend list row, team feed row (`通報` next to `ブロック`), a visited stable, a visited hall (「通報する」 under the owner name), a friend's replay card (title → `ReplayTitle` with the race id; no title → `Player`), a photo (`PhotoCaption` with the photo id), the cup lobby entrant row. Pass the matching `ReportSources` value.

Draw, top to bottom:
1. Kicker 「通報　/　{対象}」, title `ReportModel.Title`, the lead `ReportModel.Lead` (muted, 15 px, two lines max).
2. A card with what is reported: the kind label (small letter-spaced cyan), `TargetName` (white, bold) and, when there is text (title / caption), the text in gold quotes, one line with ellipsis.
3. Kicker `ReasonLabel`, then `Reasons` as two-column choice buttons (`Label` from the server, already English in English mode). Tap → `model.Select(row.Id)`; `row.Selected` = the cyan outline state.
4. `NoteLabel` + an input (placeholder `NotePlaceholder`, the player's own text: no translation, IME on). Right-aligned `NoteCounter` ("12/100"); turn it `status.danger` when `NoteOver`. Hide the note row when `NotesOff`.
5. A toggle `AlsoBlockLabel` → `AlsoBlock` (off by default).
6. One skewed cyan CTA `SendCta` », enabled only when `CanSend`. Tap → `await model.SendAsync()`. While `Sending`, keep it disabled (the model ignores a second tap anyway).
7. `Message` under the CTA (warning colour for errors; after a success, close the sheet and toast `Message`).

Rules to keep:
- Never show how many others reported, whether the report was merged, or anything about the reported player's side.
- Errors are already worded per case (`LimitText` daily limit, `GoneText` content changed / deleted, `NotInRaceText` cheating outside your races, `OfflineText`). A failed send keeps the choices: offer `ResendCta`.
- Text size (`AccessibilityModel.TextScale`): the sheet must fit at 「特大」 in Japanese and English (the prototype's a11y-flow checks it). Reason buttons wrap to one line; shrink to the standard size before overflowing.
- Reduce motion: the sheet slides in ≤150 ms or fades.

## 2. 通報とブロック (その他 › 通報とブロック, also the target of `ops_notice`)

Left panel (navy glass): kicker `ListLabel`, `CountText` ("2/100") right-aligned, then `Rows` (newest first): the player's name (as written; a deleted player arrives as 「プレイヤー」) and a small outline button `UnblockCta`. Empty → `EmptyText`. Under the list, `GuidelinesNote` (small, soft).

Right panel: kicker `EffectsLabel`, then `Effects` — one row per feature: a small cyan label (or the icon by `BlockEffectRow.Icon`: bell / stamp / rival / stable / trophy / replay / cup) and `Text` from the server. Footer line: 「相手には、ブロックしたことも通報したことも知らされません。」 (prototype text; add it to the Canvas as a static label with `Loc.T`).

Unblock: `AskUnblock(row)` opens a centred dialog — `ConfirmTitle`, the name (gold, as written), `ConfirmBody`, CTA `ConfirmCta` » (`await ConfirmUnblockAsync()`), outline `CancelCta` (`CancelUnblock()`). `row.Busy` = disable that row while its call runs. `Message` → toast.

Blocking from elsewhere (profile, feed): `await BlockAsync(playerId, name)`; a full list returns `FullText`.

Offline: `OfflineText`, no list (blocking needs the server).

## 3. What Codex must draw (new assets / prefabs)

- `ReportSheet` prefab (right drawer): kind card, 2-column reason chips (selected = cyan 2 px outline + 16 % cyan fill), note field with counter, block toggle, skewed CTA ».
- `BlockListScreen` prefab: two navy panels as above, row prefab (name + small outline button, hairline under each row), effect row prefab (label/icon + one line).
- `UnblockDialog` prefab (centred navy dialog over a dimmed scene).
- 7 small line icons for the effect rows (bell, stamp, rival, stable, trophy, replay, cup) in the existing cyan line style, and a `notice` icon for the activity row of `ops_notice`.
- A small 「通報する」 outline button style for the entry points (same size as other secondary buttons; never red, never the primary CTA).

## 4. Checks

- `dotnet run --project 'unity/Checks~/GameChecks'` → section 「round 17: 通報とブロック」 and the L10n check (every Japanese literal of the game layer has English in `ui-en.json`).
- Prototype: `bash tools/figma-prototype/build.sh && node tools/figma-prototype/test/e2e.cjs` (unity-flow 「通報とブロック」, en-flow, a11y-flow).
