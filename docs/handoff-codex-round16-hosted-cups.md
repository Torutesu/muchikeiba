# Round 16 Codex 向け引き継ぎ：プレイヤー主催カップ（REQ-CUP-001〜018）

更新：2026-11-09　基準ブランチ：`feat/r16-hosted-cups`（`origin/claude/round14` = Round 14 統合）
仕様：`contracts/protocol.md` §42、`docs/spec/requirements.md` 42章、法務：`docs/planning/03-legal-risk.md`「プレイヤー主催カップ」、UX：`docs/planning/06-ux-experience-spec.md`（機能の一覧）。経済の目標なし（コイン・アイテムは動かない、E 番号なし）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/cups`・`POST /v1/cups`（冪等キー、同じキーは同じカップ）・`GET /v1/cups/:cupId`・`POST /v1/cups/lookup`（コードの確認）・`POST /v1/cups/join`（コード／招待）・`POST /v1/cups/:cupId/leave`・`/invite`（フレンド・支部）・`/start`（主催者が次のレース）、運用 `GET /v1/admin/cups/:id`・`POST /v1/admin/cups/:id/delete`。1カップ1オブジェクト（`CupDO` `cup:<id>`）、コードの索引 `cupcode:<先頭の文字>`。レースは**フレンド部屋と同じ手順**（マッチメイカー `cupStart` → `RaceRoomDO`、各参加者は `/v1/match/status` で席を受け取る）、モード `cup`（ランク外：結果は記録だけ）。アカウント削除の手順 `cups`。KPI `cup_create`・`cup_join`・`cup_finish` |
| C# | ✅ `ApiClient.GetCupsAsync` / `CreateCupAsync` / `GetCupAsync` / `LookupCupCodeAsync` / `JoinCupAsync` / `LeaveCupAsync` / `InviteToCupAsync` / `StartCupRaceAsync`、`CupCode`（入力の正規化と `XXXX-XXXX` 表示）、`CupResultCard`（既存の `ShareCard` の上に作る結果カード）、エラー `CupLimit` / `CupFull` / `CupClosed` / `CupCodeInvalid` / `CupNotReady`、`RaceMode.Cup`（`engine/Muchi.Client/HostedCups.cs`） |
| ゲーム層 | ✅ `Muchi.Game.HostedCupModel`（`unity/Assets/Muchi/Game/HostedCupModel.cs`、チェック `unity/Checks~/GameChecks/HostedCupChecks.cs`）。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → ホームの「機能・イベント」→「主催カップ」。作成 → ロビー → 「デモ：フレンドが参加」→「出走する」で本物の `createRace`（cup モード）をエンジンで走らせて順位表まで。「デモ：招待が届く」「コードで参加」も |
| **Codex** | 一覧（§2）、作成（§3）、コードで参加（§4）、ロビー（§5）、順位表と結果カード（§6）、プロフィールの棚（§7）、入口（§8） |

ムチ一閃のトーン：本物の写真のアート（`Art/race-result`・`Art/first-ride`・`Art/home-paddock`）、半透明の紺のパネル2枚、文字間を空けた小さなシアンの見出し、斜めのシアンの主ボタン（»）を1画面に1つ、余白を多めに。見本の配置（1600×900 の座標）をそのまま使ってよい。

## 2. 一覧（`HostedCupModel.LoadAsync` → `Mine`）

- 左パネル 820×676「参加中のカップ　/　主催 1/2・参加 2/4」（`LimitsText`）。カード（最大4枚）：カップ名（**プレイヤーの入力：翻訳しない・Loc.T に通さない**）、`FormatText`・`4/6人`、条件（`RulesText`）、タグ「主催」（金）／「参加」（シアン）と状態（受付中・レース中・終了・中止）、開催の時間（`WindowText`）。タップでロビー。空：`TextEmpty`。
- 右パネル 684×676：トロフィーの棚（金・銀・銅の数、`TrophyShelfText`。**見た目だけ**の記念、効果の説明を付けない）、届いた招待（`Mine.Invites`：カップ名と主催者名はそのまま、「参加する」→ `JoinAsync(horseId, cupId: …)`）、最近の結果（`Mine.History`）、主ボタン「カップを作る »」（`CanHost == false` なら無効）、「コードで参加」、下に `TextUnranked`。

## 3. 作成（`CreateProblem` → `CreateAsync`）

- 入力：カップ名（最大 `Limits.NameMaxChars` = 20 文字）、人数（`MinCapacity`〜`MaxCapacity`、− / ＋）、形式（1レース／3レースのポイント制）、コース（‹ 名前 ›、全コース）、馬場（そのコースの面の4つ）、開催の時間（いまから1・3・24時間。見本と同じ。開始時刻を選ばせてもよい：`MaxLeadHours` 以内、長さ `MinWindowMinutes`〜`MaxWindowHours`）。「フレンド部屋の条件を使う」（`UsePreset`）を置いてもよい。
- 右の確認パネル：入力した名前、形式・人数、条件、**`TextHostFair`**（主催者も他の人の馬は選べない／条件は後から変えられない）と `TextUnranked` を必ず出す。出走する馬は自分の相棒（馬の選択 UI があれば `HorseId` を差し替え）。
- エラーは名前の下に警告色で1行（NG 語 `NG_NAME`、URL `INVALID_NAME`、上限 `TextLimit`）。成功でロビーへ。

## 4. コードで参加（`CodeForButton` → `LookupAsync` → `JoinAsync`）

- 大きな入力欄1つ（等幅に近い字間、プレースホルダー `K7PM-Q2XD`）。`CodeForButton(text)` が null の間は「確認する」を押せない。大文字・小文字・ハイフンは問わない。
- 確認すると右パネルに `Preview`：カップ名・主催者名（そのまま）・形式・人数・条件・時間。**ほかの参加者の名前は出さない**。主ボタン「参加する »」（満員は無効）。
- エラーは理由を言わない：`TextCodeInvalid`（無いコード・ブロックの関係も同じ文）、`TextCodeLimit`（1時間に10回まで）、`TextFull`（最後の1枠を他の人が取った）、`TextClosed`。

## 5. ロビー（`OpenAsync` → `Cup`）

- 左パネル：カップ名、「参加者　/　4/6人」（`SeatsText`）、参加者の行（`EntrantRows`：名前・馬名はそのまま、バッジ「主催」金・「あなた」シアン・「棄権」警告色）、参加コード（大きくシアン、字間広め。主催者と参加者にだけ届く）、主催者で最初のレースの前なら「フレンドを招待」（フレンド一覧のチェック → `InviteAsync(ids, false)`）と、支部に入っていれば「支部を招待」（`InviteAsync(null, true)`）、下に小さく「カップから抜ける」→ 確認シート（`LeaveConfirmText`：主催者は**中止になる**ことを警告色で）。
- 右パネル：`ProgressText`（第2レース / 全3レース、終了・中止の文）、時間、条件、途中の順位（上位4行）、主催者には主ボタン「出走する »」（`StartAsync`。押せない時は `StartHint` を下に）、参加者には「主催者の出走を待っています」。出走後は各参加者のアプリが **`/v1/match/status` の割り当て**（フレンド部屋と同じ）でレース画面に入る。ロビーを開いている間は数秒おきに `OpenAsync` で更新してよい。
- 最後に `TextUnranked` を小さく。

## 6. 順位表と結果カード

- 左パネル 960×676：`StandingRows`（順位・名前（そのまま）・各レースの着順 `2-1-1`・合計 `27pt`／1レースは着順・トロフィーのタグ）。自分の行はシアン。
- 右パネル：「あなたの結果」`1位 / 4人`、`TrophyText`、「トロフィーはプロフィールの棚に飾られます（見た目だけ）」、主ボタン「結果カード »」。
- 結果カードは**既存の共有カード**（`ShareCard`、リプレイと同じレイアウト・透かし「ムチ一閃」・OS の共有シート）：`HostedCupModel.ResultCard(horseName)` → `PlaceText`（`1位 / 4人`）、`ModeLabel`（主催カップ）、`SkillLines[0]`（`27pt（3レース）`）、馬名・コース、`ShareText`。**ほかのプレイヤーの名前とカップ名は載せない**（カップ名は主催者が入力した文字列のため）。`Kind = "cup_result"`。

## 7. プロフィールの棚（殿堂の棚の横）

- `publicProfile.cupTrophies`（`{ gold, silver, bronze }`、1つ以上ある時だけ）を自分とフレンドのプロフィールに小さなトロフィー3種と数で出す。カップ名は出さない。殿堂（§34）の棚に並べる場合も見た目だけ。

## 8. 入口・解放

- ホームの「機能・イベント」に「主催カップ」。解放はフレンド部屋と同じ `friend_rooms`（2日目 or 10戦）。新しい解放キーはない。
- プッシュ `cup_invite`（「{name}さんが主催するカップに招待されました」）から一覧の招待へ。

## 9. 守ること（画面の文言）

- ランク外：レーティング・シーズン・ライバル・報酬に関係しないことを一覧・作成・ロビーで1行ずつ（`TextUnranked`）。報酬を煽らない（トロフィーは記念）。
- 急かさない：締め切りは本物の時刻だけ。「残りわずか」「今だけ」・カウントダウン・点滅は使わない。満員の文は事実だけ。
- 入力された名前（カップ・プレイヤー・馬）は英語でもそのまま。

## 10. 活動（§40、Round 15）に書くところ（このブランチでは書いていない）

1. 招待を受けた：`PlayerService.cupInvited`（`receiveCupInvite` が true の時）。
2. カップが始まった：参加者の最初のレースの割り当て（`MatchmakerDO.cupStart` で `assignments` を書く所。各参加者に1件）。
3. カップが終わった／中止になった：`PlayerService.cupClosed`（`receiveCupClosed` が履歴を書いた時、順位とトロフィー・中止の理由）。
