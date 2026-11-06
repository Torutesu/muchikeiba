# 共有仕様（C# と TypeScript の境界）

C#（端末・検証サーバー）とTypeScript（Cloudflareサーバー）の間で受け渡すデータの**唯一の正**。
変更するときは両側の実装とテスト、`contracts/golden/` を同時に更新すること。

## 1. 数値の表し方
- JSONで64bit整数を扱うときは**10進文字列**（例：`"seed": "12345678901234567890"`）。JSの`number`は53bitまでしか正確でないため。
- それ以外の整数はJSONの数値（32bitに収まる値のみ）。
- 固定小数点（Q16.16）の生値をJSONに出すときは10進文字列。

## 2. RaceStartConfig（サーバー → 端末・検証サーバー）

```json
{
  "v": 1,
  "raceId": "r_01JC...",
  "mode": "ranked",                 // "ranked" | "friend" | "tutorial" | "timeattack" | "event" | "tournament"
  "seed": "9876543210123456789",    // uint64（10進文字列）
  "track": {
    "id": "tokyo_like_turf_2000",
    "surface": "turf",              // "turf" | "dirt"
    "distanceM": 2000,
    "segments": [                   // スタートから順に。lengthMの合計 = distanceM
      { "kind": "straight", "lengthM": 350 },
      { "kind": "corner", "lengthM": 600, "radiusM": 120 },
      { "kind": "straight", "lengthM": 450 },
      { "kind": "straight", "lengthM": 600 }
    ],
    "going": "soft",                // 省略可。芝 "firm"|"good"|"yielding"|"soft"、ダート "fast"|"good"|"muddy"|"sloppy"。省略 = good
    "night": true                   // 省略可。ナイター（演出と実況だけ。計算には影響しない）。省略 = 昼
  },
  "net": {
    "tickHz": 20,
    "inputDelayTicks": 3,
    "bundleIntervalTicks": 2,
    "checksumIntervalTicks": 20,
    "disconnectGraceMs": 3000
  },
  "ruleset": { "rulesetVersion": "1.0.0", "maxTicks": 4800, "...": "contracts/ruleset-params.default.json の全キー" },
  "entrants": [
    {
      "slot": 0,                    // 0..11。ゲート番号 = slot + 1
      "kind": "human",              // "human" | "cpu"
      "playerId": "p_abc",          // cpu のときは null
      "cpuLevel": 3,                // 1..5。human のときも切断時の引き継ぎに使う
      "horse": {
        "id": "h_123",
        "name": "シンセイアカツキ",
        "speed": 720, "stamina": 650, "burst": 800, "guts": 600, "temper": 500,   // 0..1000（ランク戦は正規化済み）
        "style": "sashi",           // "nige" | "senko" | "sashi" | "oikomi"
        "distMinM": 1600, "distMaxM": 2400,
        "surface": "turf",          // "turf" | "dirt" | "both"
        "goingAptitude": "heavy",   // 省略可。"any"|"fast"|"heavy"（得意な馬場）。省略 = any
        "skill": {                  // 省略可（ルールセット 1.3、§14）。固有スキル。省略 = なし
          "id": "sk_nukedashi", "name": "先行抜け出し", "trigger": "finalStraight", "value": 2,
          "speedPermille": 18, "accelPermille": 0, "drainSavePermille": 0, "recoverPermille": 0, "durationTicks": 80
        }
      }
    }
  ]
}
```

規則
- `entrants` はスロット昇順、スロットは0から連番（欠番なし）、1〜12頭。
- `segments` の `lengthM` は1以上、`corner` の `radiusM` は1以上。合計が `distanceM` と一致。
- `ruleset` のキーは `contracts/ruleset-params.default.json` と同じ集合でなければならない（多い・少ないはエラー）。値は全て整数。サーバー（TS）が必ず読むキーは `rulesetVersion`（文字列）と `maxTicks` のみ。それ以外はTSにとって不透明な値として素通しする。
  - **例外（後から追加したキー）**：馬場状態のキー（`going*`、`dirtSpeedPermille`、`goingSpecialistPermille` の18個。一覧は `RulesetParams.OptionalIntKeys` と `server/src/domain/ruleset.ts` の `OPTIONAL_RULESET_KEYS`、両者の一致はテストで保証）は**全部あるか、全部ないか**のどちらか。全部ない＝追加前のリプレイで、中立値（1000‰、専門0）として計算し、当時と同じ結果になる。一部だけはエラー。
- `track.going` は `track.surface` に合った名前でなければエラー（芝に "sloppy" など）。
- `track.going` / `track.night` / `horse.goingAptitude` / `horse.skill` は**値があるときだけ書く**（省略と既定値は同じ計算結果。省略した設定を読み書きしても1バイトも変わらない）。

## 3. 入力（1バイトのビットフラグ）

| bit | 名前 | 発行者 |
|---|---|---|
| 0 | START | 端末 |
| 1 | LANE_IN | 端末 |
| 2 | LANE_OUT | 端末 |
| 3 | REIN_PRESS | 端末 |
| 4 | REIN_RELEASE | 端末 |
| 5 | WHIP | 端末 |
| 6 | CPU_TAKEOVER | 部屋のみ |
| 7 | HUMAN_RESUME | 部屋のみ |

- 端末が bit6/bit7 を送ってきたら部屋はその2bitを落とす。
- 同じtick・同じスロットに複数の入力が来たら部屋はビットORで合成する。

## 4. ロックステップのメッセージ（WebSocket、JSON、1メッセージ1オブジェクト）

### 端末 → 部屋
| `t` | 形 | 意味 |
|---|---|---|
| `hello` | `{"t":"hello","raceId":"…","token":"…","lastTick":-1}` | 参加・再接続。`lastTick`は計算済みの最後のtick（初回は-1） |
| `in` | `{"t":"in","tick":123,"cmd":32}` | 入力。`tick`は宛先tick |
| `chk` | `{"t":"chk","tick":120,"h":"0123456789abcdef"}` | チェックサム（`tick`は`checksumIntervalTicks`の倍数） |
| `res` | `{"t":"res","h":"<64hex>","order":[3,0,…],"finishTicks":[1830,1835,…]}` | 結果ハッシュと着順。`finishTicks`は任意（`order`と同じ並び、未完走は-1）。合意した全員が同じ値を送った時だけ戦績のベストタイムに使う。最も速い馬でもゴールできないtickより前の`res`は`err` `RESULT_TOO_EARLY`、2回目以降の`res`は無視 |
| `ping` | `{"t":"ping","c":1730000000000}` | 時刻合わせ |

### 部屋 → 端末
| `t` | 形 | 意味 |
|---|---|---|
| `start` | `{"t":"start","you":0,"startAtMs":1730000000000,"config":{RaceStartConfig},"visuals":{…}}` | 開始。tick 0 の時刻が `startAtMs`。`visuals`（任意）は全馬の見た目とコースのシーン（`contracts/assets.md` §4）。**ハッシュ・リプレイログ・検証には一切入らない**。無い場合（古いサーバー）はクライアントが既定の見た目を使う。フレンドルームの演出条件 `visuals.scene`・絆レベル `entrants[].bondLevel` も同じ扱い（REQ-ROOM-004 / REQ-BOND-004） |
| `b` | `{"t":"b","from":10,"to":11,"in":[[10,3,32],[11,0,2]]}` | `from`〜`to`（両端含む）のtickが確定。`in`は0でない入力だけ `[tick, slot, cmd]`、tick→slot昇順 |
| `desync` | `{"t":"desync","tick":120}` | あなたのチェックサムが多数派と違う |
| `final` | `{"t":"final","status":"confirmed","order":[3,0,…],"h":"<64hex>"}` | `status`: `confirmed` / `verifying` / `void` |
| `pong` | `{"t":"pong","c":…,"s":…}` | `s`はサーバー時刻 |
| `err` | `{"t":"err","code":"…"}` | `BAD_MESSAGE` / `NOT_IN_RACE` / `RACE_OVER` / `TOO_EARLY` / `RESULT_TOO_EARLY` など |

確定の規則
- tick `n` は、部屋の時計が `startAtMs + (n + 1) * 1000 / tickHz` を過ぎた時点で確定。
- 宛先tickが既に確定済みの入力は、次に未確定の最初のtickに回す（遅延入力のシフト）。
- 宛先tickが「最新の確定tick + `inputDelayTicks` × 4」より先の入力は拒否（`err` `TOO_EARLY`）。
- `b` は `bundleIntervalTicks` ごとに送る。再接続時は `lastTick+1` から現在までを1つの `b` で送る。
- 全頭ゴール、または `maxTicks` に達したら部屋はtickを進めるのをやめ、結果を待つ。

### 4.1 close code（部屋 → 端末）
部屋がソケットを閉じるときの WebSocket close code と、クライアント（`RaceSession` / `CloseCodes`）の扱い。

| code | reason | いつ | クライアント |
|---|---|---|---|
| 4000 | `replaced` | 同じ選手の席（または同じプレイヤーの観戦接続）に新しい接続が `hello` した。古い方を閉じる | 再接続しない。`Failed`、`FailureReason` = `REPLACED`（再接続すると新しい方を閉じ返し、2台の端末が席を奪い合い続ける） |
| 4001 | `unauthorized` | チケットが無効・期限切れ（直前に `err` `UNAUTHORIZED`） | 再接続しない。`UNAUTHORIZED` |
| 4003 | `spectators full` | 観戦者が上限（直前に `err` `SPECTATORS_FULL`） | 再接続しない。`SPECTATORS_FULL` |
| 1011 | `no race` | 部屋にレースが無い（ランタイム自身の内部エラーも同じ code） | 切断扱いで再接続（回数上限あり。レースが無ければ接続が 404 で失敗し続けて `Failed`） |
| その他 | — | close フレーム無しの切断・接続失敗（1006）、1000 / 1001 / 1005 / 1012 など | 切断扱いで再接続（指数バックオフ、回数上限あり） |

## 5. チェックサム（REQ-RACE-070）
- FNV-1a 64bit（offset basis `0xcbf29ce484222325`、prime `0x100000001b3`）。
- 入力バイト列：スロット昇順に、各馬について以下を **int64 リトルエンディアン8バイト** で連結：
  `distanceRaw, laneRaw, speedRaw, staminaRaw, composure, whipsLeft, finishTick(未完走は-1)`
- `tick` の計算を終えた直後の状態で取る。出力は16桁の小文字16進。

## 6. 結果ハッシュ（REQ-RACE-072）
正規化文字列（UTF-8）：

```
v1|{raceId}|{rulesetVersion}|{entry};{entry};…
```

- `entry` は着順に並べ、完走馬は `{slot}:{finishTick}:{finishFracRaw}`、未完走馬は `{slot}:-1:{distanceRaw}`（未完走同士は距離の大きい順）。
- `finishFracRaw`：ゴールしたtickの中で、ゴール線を越えた時点の割合（Q16.16の小数部、0〜65535）。
- 数値は10進、符号は負のときだけ `-`。
- ハッシュはこの文字列のSHA-256、64桁の小文字16進。

## 7. リプレイログ（部屋 → 保存 → 検証サーバー）

```json
{ "v": 1, "config": { RaceStartConfig }, "endTick": 1834, "inputs": [[60,0,1],[60,3,1],[75,0,2]] }
```
- `inputs` は部屋が配った確定入力そのもの（`CPU_TAKEOVER`/`HUMAN_RESUME`を含む）、tick→slot昇順。

## 8. 検証サーバー API
- CLI：`Muchi.Verifier replay <log.json>` → 標準出力にJSON
- HTTP：`POST /verify`（本文＝リプレイログ）→ `200`

```json
{ "resultHash": "<64hex>", "order": [3,0,…], "finishTicks": [1790,1795,…], "finishFracs": [21000,4410,…], "checksums": { "20": "…", "40": "…" } }
```
- `finishTicks` は `order` と同じ並び。未完走は -1。
- `finishFracs`（追加・任意）：同じ並びで、ゴールしたtick内の割合（Q16.16の小数部 0〜65535）。未完走は -1。タイムアタックの正確なタイム計算に使う。古い検証サーバーは出さないので、受け手は無い場合を0として扱う。
- 形式違反・ルールセットのキー不一致は `400 {"error":"…"}`。

## 8.1 タイムアタック（REQ-TA-*）
- 設定は §2 の RaceStartConfig そのもの。`mode`=`"timeattack"`、`entrants` は人間1頭（slot 0、CPUなし）。
- 提出はHTTP（`POST /v1/time-attack/submit`）で、本文は `{ "sessionId", "token", "inputs": [[tick,0,cmd],…], "resultHash", "config"? }`。`inputs` は §7 と同じ三つ組で、スロット0・クライアントのビット（bit0〜5）のみ・tick は厳密に増加。サーバーは発行した設定と `inputs` からリプレイログ（§7、`endTick` = -1）を作って §8 で検証する。
- タイム（ms）＝`(finishTick − gateOpenTick) × ⌊1000 / tickHz⌋ + ⌊finishFrac × ⌊1000 / tickHz⌋ / 65536⌋`。
- ゴースト本体は `{ "meta": {…}, "log": リプレイログ }`。端末ではゴーストごとに別の RaceSim で再生し、プレイヤーの馬と干渉させない。

## 8.2 イベントレース（REQ-EVENT-*）
- 設定は §2 の RaceStartConfig そのもの。`mode`=`"event"`。ロックステップ・結果の合意・検証は ranked と同じ規則（人間1人なら必ず検証）。
- イベントのルール変更は `ruleset` の値として設定に入る（キー集合は変わらない）。変更があるときは `rulesetVersion` が `"<元の版>+ev.<eventId>"` になる（例：`"1.0.0+ev.no_whip_cup_2026_12"`、`maxWhips` = 0）。検証サーバーは設定に書かれた値で再計算するだけでよい。
- 能力固定のイベントでは、全出走馬（CPUを含む）の5能力が同じ値で設定に入る。
- ゴールデン：`contracts/golden/ts-config-event.json`。

## 8.3 大会（REQ-TOUR-*）
- 各ヒート（予選・決勝）は §2 の RaceStartConfig そのもの。`mode`=`"tournament"`（C# の `RaceMode.Tournament` = 5）。ロックステップ・結果の合意・検証は ranked と同じ規則（人間1人なら必ず検証、レートは変わらない）。
- 大会の能力上限は `statCap` として設定に入る（上限なしなら null）。検証サーバーは設定の値で再計算するだけでよい。
- ヒートの `raceId` は `t-<大会ID>-<ヒートID>-<試行回数>`（例 `t-cup_2026_12-0-3-1`）。クライアントは中身を解釈せず、そのまま使う。`/v1/tournaments/:id/me` の `heat.assignment` は `{ raceId, slot, ticket, startAtMs, wsPath }`（形は従来どおり、チケットはリクエストのたびに本人の分だけ作られる）。

## 8.4 観戦（REQ-SPEC-*、§4 の後方互換な拡張）
- 観戦者は `POST /v1/race/:raceId/spectate` で **slot = -1** のチケットを受け取り、選手と同じ `wsPath` に `hello` を送る（形は §4 と同じ）。
- 部屋は `start` を `"you":-1` と `"spectator":{"delayMs":10000}` 付きで返す。`spectator` を知らない古いクライアントは無視してよい（選手には付かない）。
- その後は選手と同じ `b`（確定入力）と、最後の tick まで受け取った後に確定した `final`（`confirmed` / `void` のみ。`verifying` は送らない）が届く。観戦者は端末でシミュレーションするので、最終ハッシュは選手と同じになる。
- 遅延：フレンドルームは 0（ライブ）、ranked・イベント・大会は 10 秒（ゴースティング対策）。観戦者に届くのは選手に送信済み（＝保存済み）の tick だけで、遅延分は部屋の時計で刻まれる（選手のレースが終わっても通常速度で最後まで流れる）。
- 観戦者は `in` / `chk` / `res` を送らない（送ると `err` `SPECTATOR_READ_ONLY`）。`ping` には `pong` を返す。
- 1部屋の観戦者数の上限は既定 200（`SPECTATOR_LIMIT`）。超えると `err` `SPECTATORS_FULL` で閉じる（close code 4003）。観戦の接続はプレイヤーごとに1本：同じプレイヤーの新しい観戦接続が来ると古い接続は close code 4000（`replaced`）で閉じる（選手の席と同じ。閉じられた側は再接続しない、§4.1）。観戦チケットの発行は1人あたり連続10回・その後6秒に1回まで（超過は `429 RATE_LIMITED`）。
- 描画：観戦クライアントは `delayMs` だけ遅れて描く（`LockstepClient.RenderTickPermille` が自動で引く）。

## 8.5 種牡馬の貸し借り（REQ-BREED-012）
- `POST /v1/stud/breed` の本文 `{ "ownerId", "horseId", "damId", "useMaterial"?, "expectedFee"? }`（`Idempotency-Key` 必須）。
- `expectedFee`（任意・0以上の整数）：借り手がプレビューで見た料金。持ち主の今の料金と違えば `409 {"error":{"code":"FEE_CHANGED"}}` で、何も確保・請求しない。クライアントはプレビューを取り直して確認し直す。省略した古いクライアントは確認なし。
- 同じ `Idempotency-Key` を別の種牡馬・別の持ち主の馬で使うと `409 CONFLICT`（最初の操作の馬のまま）。
- 購入で付いた無償コイン（初回購入ボーナス）は購入から90日は料金に使えない。足りなければ `409 INSUFFICIENT_COINS`。プレビューの `stud.heldFree` がその額、`stud.canPay` はそれを除いて判定する。

## 8.6 マイ厩舎（REQ-STABLE-*、`server/src/domain/stable.ts`）
すべて要認証（`Authorization: Bearer`）。エラーは共通の `{"error":{"code","message"}}`。
| メソッド | パス | 冪等キー | 本文 → 応答 |
|---|---|---|---|
| GET | `/v1/stable` | | → `{ saved, layout:{theme,name,slots[],featuredHorseIds[],updatedAt}, themes:[{id,name,key,slots,unlocked,unlockLikes,unlockItem}], decor:[{itemId,name,key,owned,price,currency}], featuredMax, nameMaxChars, likes:{received,givenToday,perDay,perTargetPerDay}, preview: StableSnapshot\|null, notice }`。未保存なら `layout` は既定テーマ＋装備中の飾り（`PUT /v1/player/equipment` の `decor`）から作る |
| PUT | `/v1/stable` | | `{ theme, name: string\|null, slots: (itemId\|null)[], featuredHorseIds: string[] }`（余分なキーは 400）→ `{ layout, snapshot }` |
| GET | `/v1/stable/visits` | | → `{ friends: StableSummary[], recommended: StableSummary[] }` |
| GET | `/v1/stable/:playerId` | | → `{ stable: StableSnapshot, viewer:{ relation: self\|friend\|other, likedToday, likesLeftToday, canLike } }`。未公開・利用停止中は `404 NOT_FOUND` |
| POST | `/v1/stable/:playerId/like` | 必須 | → `{ playerId, likes, remainingToday }` |

- `StableSnapshot`（訪問者が見る写し。財布・所持品・購入は含まない）：`{ v:1, playerId, displayName, titleId, classId, silks, name, theme:{id,name,key}, slots:({itemId,name,key}|null)[]（テーマの枠数ぶん）, horses:[{horseId,name,rarity,style,appearance,bondLevel}], autoHorses, trophies:{titleIds[],races,wins,top3,tournamentWins,tournamentPodiums}, likes, updatedAt }`。`name` が null なら「<displayName>の厩舎」と表示する。`horses` は選んだ現役馬、選んでいなければ現役馬の上位（`autoHorses: true`）。
- `StableSummary`：`{ playerId, displayName, titleId, name, themeKey, likes, decorCount, horseCount, updatedAt }`。
- 保存の検証：テーマが存在し解放済み（`NOT_ELIGIBLE`）、`slots` はテーマの枠数以下（`BAD_REQUEST`）、各飾りは厩舎の飾り（`decor`）で所持済み・重複なし（REQ-ITEM-006 と同じ：所持なし `NOT_ELIGIBLE`、種類違い・重複 `BAD_REQUEST`、不明 `NOT_FOUND`）、`featuredHorseIds` は `featuredMax` 以下・重複なし・自分の現役馬（`HORSE_NOT_FOUND` / `HORSE_NOT_ACTIVE`）、表札は表示名と同じ規則（`INVALID_NAME` / `NG_NAME`、1〜`nameMaxChars` 字）。利用停止中は `403 BANNED`。
- いいね：自分には押せない（`NOT_ELIGIBLE`）、同じ相手には1日 `likesPerTargetPerDay` 回（`409 ALREADY_LIKED`）、1日 `likesPerDay` 回まで（`409 LIKE_LIMIT`）。日付はゲーム日（`gameDayKey`、切り替えは `progression.dayRollover`、§15・REQ-DAY-001）。押した側・押された側とも**コインは一切付かない**（累計いいねで解放されるのはテーマだけ）。同じ冪等キーの再送は1回分しか数えない。途中で失敗した場合も同じキーで再送すれば完了する。
- C# の `ApiErrorCode`：`LikeLimit` / `AlreadyLiked`。
- アカウント削除（§8.7）では公開の写し・レイアウト・いいねの状態を消す。削除済みのプレイヤーの厩舎は `404 NOT_FOUND`、その人が過去に押したいいねの数はそのまま残る（個人と結び付く情報は持たない）。

## 8.7 オンボーディング・アカウント削除（REQ-UXS-*、docs/planning/06）
エラーは全て `{"error":{"code","message"}}`。下の新しいコードは全て HTTP 409。

**`GET /v1/player` と `POST /v1/player/bootstrap`** に次の項目が加わる（既存の項目は変わらない）：
```json
{
  "consent": { "termsVersion": "2026-11-01" | null, "privacyVersion": "2026-11-01" | null, "consentedAt": 1762398000000 | null,
               "current": { "termsVersion": "2026-11-01", "privacyVersion": "2026-11-01" }, "required": true },
  "unlocks": { "day": 1, "races": 0, "rankedRaces": 0, "breedings": 0,
               "features": [ { "key": "missions", "unlocked": false, "by": null, "races": 2, "days": null, "rankedRaces": null, "breedings": null } ] },
  "experiments": { "assignments": { "ab_home_button": "b" }, "values": { "homePrimaryButton": "ranked_promotion" } },
  "deletion": { "status": "none" | "scheduled", "requestedAt": null, "deleteAt": null },
  "flags": { "tutorialGachaUsed": false, "partnerHorseId": "h3" }
}
```
- `unlocks.features[].by`：開放した条件（`"always"` / `"races"` / `"days"` / `"rankedRaces"` / `"breedings"`）、未開放は null。条件は「どれか1つ」を満たせば開く（§4.3）。**表示だけの制御**で、未開放の機能のAPIもそのまま使える。`day` はインストール日を1とするゲーム日（日付の切り替えは `progression.dayRollover`、§15）。キーは `race, partner, scout, stable, missions, login_bonus, shop, season_pass, bond, season, breeding, friends, friend_rooms, teams, spectate, time_attack, events, tournaments, my_stable, stud`。
- `experiments.values` のキーは `tutorialDistanceM`（整数）、`firstRankedTrackId`（コースID or null、サーバーが初めてのランク戦で使う）、`pushPermissionTiming`（`race2_top3`|`day2_launch`）、`starterOfferTrigger`（`first_bottom_half`|`fifth_race`）、`homePrimaryButton`（`race`|`ranked_promotion`）、`firstWinBonus`（bool）だけ。価格・中身はA/Bにしない。

| メソッド・パス | 本文 | 応答 | エラー |
|---|---|---|---|
| `POST /v1/player/consent` | `{ "termsVersion", "privacyVersion" }`（1〜32文字） | 上の `consent` と同じ形（`required: false`） | `CONSENT_VERSION_MISMATCH`（今の版でない：`GET /v1/player` の `consent.current` を取り直す）、`BAD_REQUEST` |
| `POST /v1/player/partner`（`Idempotency-Key` 必須） | `{ "name": "アイボウ" }` | `{ "horse": Horse }`（`templateId: "t_partner"`、`named: true`） | `PARTNER_ALREADY_GRANTED`（2回目。同じキーの再送は同じ応答）、`INVALID_NAME`、`NG_NAME`、`IDEMPOTENCY_KEY_REQUIRED` |
| `DELETE /v1/player`（1回目：本文なし or `{}`） | — | `{ "status": "confirm_required", "confirmToken": "del_…", "expiresAt", "cancelWindowDays": 14, "forfeit": { "paidCoins", "freeCoins", "horses", "items", "allowanceDays", "seasonPass" }, "notice": "…" }` | — |
| `DELETE /v1/player`（2回目） | `{ "confirmToken": "del_…" }`（または `?confirmToken=`） | `{ "status": "scheduled", "requestedAt", "deleteAt" }`（予定済みなら何度でも同じ） | `DELETION_CONFIRM_INVALID`（違う・期限切れ（10分）：1回目からやり直す）、`BAD_REQUEST` |
| `POST /v1/player/deletion/cancel` | — | `{ "status": "none", "requestedAt": null, "deleteAt": null }` | `NOT_FOUND`（予定がない）、`DELETION_IN_PROGRESS`（削除の処理が始まっている。始まった削除は取り消せない） |
| `GET /v1/missions` | — | `{ "missions": [デイリー（従来）], "beginner": { "completed", "steps": [ { "id", "step", "kind", "target", "progress", "reward", "claimed", "locked", "claimable" } ] }, "season": { "seasonId", "missions": [ { "id", "kind", "target" (null＝S級で対象なし), "progress", "reward": { "passXp" }, "claimed", "available", "claimable" } ] }, "firstWinBonus": { "modes", "byWin", "winsToday", "remaining", "next" } }`（`firstWinBonus` は §13・REQ-UXS-010） | — |
| `POST /v1/missions/:id/claim` | — | 報酬（`Reward`）。デイリー・初心者・シーズンのIDは一意 | 初心者ミッションは前の段階が未受け取りなら `NOT_ELIGIBLE`。他は従来どおり |
| `POST /v1/rewards/login-bonus` | — | `{ "day", "track": "beginner" | "normal", "reward", "beginnerDaysLeft" }` | 従来どおり |
| `POST /v1/items/tickets/gacha_ticket_10/use` | `{ "bannerId" }` | 従来の形＋ `"results": [10件]`（`result` は1件目） | 従来どおり |
| `POST /v1/shop/purchase-intent` | 従来どおり | 従来どおり | 削除予定中は `DELETION_PENDING`（§13 の全商品：コイン・スターター・シーズンパス／パス＋・厩舎手当・昇級記念パック。取り消せば買える。ストアで支払い済みのレシートは付与し、サポート用の印を付ける） |
| `GET /v1/shop/offers`・`POST /v1/shop/offers/:offerId/view`・`POST /v1/shop/allowance/claim`（§13） | 従来どおり | 従来どおり | 削除予定中は `DELETION_PENDING`（オファーを出さない・手当を受け取らない。取り消せば戻る） |

- 削除の処理が始まった後（予定時刻にアラームが最初に「開始」を記録してから。14日の予約期間中ではない）は取り消せず（`DELETION_IN_PROGRESS`）、そのプレイヤーからのフレンド申請・承認・招待、ランク戦・大会・タイムアタック（開始・提出）・イベントへの参加、マイ厩舎のいいね（自分の回数も増えない）は `DELETION_PENDING` で断る。予約期間中は購入前チェック・オファー・厩舎手当（上の表）以外はそのまま使える。開始の前に取り消された削除は、処理が何もせずに止まる。
- 削除後に届いたストアの返金：取引の索引は匿名IDに付け替わっているので、返金は AccountingDO の保存記録に付ける（その購入を返金済みにし、`refundsAfterDeletion` に追記、台帳に `refund` 行（コインは放棄済みなので delta 0）を足して `rev` を上げる。同じ返金は1回だけ）。応答は `{ "retained": true, "anonId", "transactionId", "alreadyRefunded", "priceYen", "paidCoins", "bonusCoins" }`。
- 削除の流れ：予定時刻にプレイヤーのDurable Objectのアラームが、フレンド（相手側の一覧・申請）→ 支部（リーダーなら幹部→古参の順に譲ってから脱退、申請の取り消し）→ ディレクトリ（フレンドコード・公開プロフィール・種牡馬の登録）→ マイ厩舎の公開の写し（あれば）→ ランキング（今シーズンは削除、過去シーズンは名前を「退会したプレイヤー」に）とゴースト → イベントの順位表 → 大会（受付中は登録取り消し、以降は名前だけ匿名化）→ 残高の放棄（有償・無償コインに加え、厩舎手当の残りと予約分、シーズンパスの状態）と匿名の記録の作成 → 記録の保存（AccountingDO、ランダムID、法定の保存期間）→ プレイヤーの全データ削除、の順に進める。失敗したら続きから再試行（1分・10分・1時間・以後6時間ごと）。
- クライアントイベント（`POST /v1/analytics/events`）：`tutorial_step` の `step` は `consent, race1_start, race1_whip, race1_win, named, gacha_done, race2_done, home` だけ。`index` は省略可（送るならこの順の番号）、任意の `value`（整数、`race1_win` ではやり直し回数）。追加：`feature_unlock {feature}`、`offer_view` / `offer_click {offerId, trigger: T1..T8}`、`race_quit {mode, remainingM}`、`account_link {provider: apple|google}`、`share {kind: replay_video|replay_image}`（REQ-UXS-072）。

## 9. ゴールデンファイル（`contracts/golden/`）
- `race-*.json`：`{ "log": リプレイログ, "expected": 検証APIの出力 }`。C#側が生成し、C#テストで再計算一致を、TSテストでスキーマ適合を確認する。
- `ts-config-*.json`：TSのレース設定ビルダーが生成した設定。C#テストで読み込み・完走できることを確認する。

## 10. 馬場状態とナイター（REQ-RACE-034〜037）
- 馬場の名前は湿り具合の段階 0〜3 に対応する：芝 firm=0 / good=1 / yielding=2 / soft=3、ダート fast=0 / good=1 / muddy=2 / sloppy=3。
- 最高速 ×= `goingTurf{X}SpeedPermille`（ダートは `dirtSpeedPermille` × `goingDirt{X}SpeedPermille` / 1000）。脚の消費 ×= `going{Turf|Dirt}{X}DrainPermille`。
- 得意馬場：`goingAptitude` が fast の馬は段階0で +`goingSpecialistPermille`、段階2で −半分、段階3で −全部。heavy の馬はその逆。any は0。
- `night` は計算に使わない（チェックサム・結果ハッシュにも入らない）。表示と実況（ゲート前の一言）だけに使う。
- サーバーは、ランク戦・フレンド戦で「その日（JST）のそのコースの馬場」を決めて送る（同じ日・同じコースは誰でも同じ）。照明のある競馬場では、JSTの夜の時間帯のレースが night になる。チュートリアルとタイムアタックは送らない（＝良馬場・昼）。


## 11. ルールセット 1.1 のバランスキー（docs/spec/balance-targets.md）
- 追加キー：`conditionVariancePermille`、`cpuStaminaReinMinLevel`、`cpuRailMinLevel`、`autoRailIntervalTicks`、`autoRailHoldTicks`、`cpuSloppyMaxLevel`。**全部あるか全部ないか**（馬場のキー群とは独立）。ない場合の中立値は 0 / 1 / 3 / 0 / 0 / 0 で、1.0.x と同じ結果になる。C# `RulesetParams.BalanceIntKeys` と TS `BALANCE_RULESET_KEYS` は一致させる（テストで確認）。
- **その日の調子**：`conditionVariancePermille` > 0 のとき、各馬の最高速（適性・馬場・得意馬場を掛けた後）に `(1000 + r) / 1000` を掛ける。`r` は `Pcg32(SeedMix.Derive(seed, 0x464F524D, slot), slot + 200).Range(-v, v)`（他の乱数列は消費しない）。
- **騎手の自動の内寄せ**：`autoRailIntervalTicks` > 0 のとき、そのtickに内外の入力がなく、レーン移動中でなく、`(tick + slot) % interval == 0`、最後に内外を入力してから `autoRailHoldTicks` 以上経ち、スパート区間の外で、内側のレーンが空いていて（通常のレーン変更と同じ判定）、その内側レーンの前方 `blockRangeMm × 3` 以内に自分より遅い馬がいなければ、1レーン内へ寄る（`LaneChange` イベントあり）。CPUの入力も「内外の入力」に数える。
- **CPUの癖**：レベル ≤ `cpuSloppyMaxLevel` のCPUは、スタート反応の最大遅れ +3tick、ムチは残り `250 + Range(0,350)` m から間隔 `6 + Range(0,30)` tick、脚の温存のための手綱を使わない（乱数はそのCPUの乱数列から、癖があるときだけ引く）。
- **タイムアタック**：サーバーは調子を 0 にしたルールセットで発行し、`rulesetVersion` に `+ta` を付ける（例：`1.2.0+ta`）。チュートリアル（端末内）も調子 0・癖なし。

## 12. ルールセット 1.2 の距離キー（docs/spec/balance-targets.md 2章）
- 追加キー：`distanceRefM`、`distanceRefDirtM`、`staminaDistanceScalePermille`、`spurtDistanceScalePermille`。**全部あるか全部ないか**（他のキー群とは独立）。ない場合の中立値は全て 0 で、1.1.x 以前と同じ結果になる（何も距離で変わらない）。C# `RulesetParams.DistanceIntKeys` と TS `DISTANCE_RULESET_KEYS` は一致させる（テストで確認）。
- 係数（‰）：`ref` = ダートなら `distanceRefDirtM`、それ以外は `distanceRefM`。`ref` ≤ 0 か `scale` = 0 なら 1000。それ以外は `1000 + scale × (distanceM − ref) / ref`（整数の割り算は0方向への切り捨て、結果を 200..5000 に収める）。
- **スタミナ**：各馬のスタミナ量（適性の減算の後）に `係数(staminaDistanceScalePermille) / 1000` を掛ける（整数の切り捨て）。
- **スパート区間**：長さ = `spurtDistanceM × 係数(spurtDistanceScalePermille) / 1000` m（整数の切り捨て）。スパートの判定・ムチの早打ち判定・自動の内寄せの停止はこの長さを使う。
- 既定値（1.2.0）：芝 2000m・ダート 1850m を基準に、どちらも 1000‰（距離に比例）。2000mの芝・1850mのダートは 1.1.0 と同じ量・同じ長さ。
- **チュートリアル**（端末内、400mの直線で全部がスパート区間）は `staminaDistanceScalePermille` と `spurtDistanceScalePermille` を 0 にして走る（1.1.0 と同じ量・長さ）。

## 13. ショップ・課金体験の API（REQ-UXS-010/017〜022、docs/planning/06 §5・§6.8・§6.9）
表示の文言・数量・期間は全てサーバーが作る。クライアントは組み立てない（「2倍」などの倍率表現は使わない。初回購入ボーナスは「無償コイン◯枚」）。時刻は ms（UTC エポック）、日付はゲーム日の `YYYY-MM-DD`（`gameDayKey`、切り替えは `progression.dayRollover`、§15。2026-12-01 04:00 JST から 4:00 JST、それまでは 0:00 JST）、残り日数（`remainingDays`）もゲーム日で数える。シーズンは JST の暦月 `YYYY-MM`（暦のまま）。**このセクションで新しいエラーコードは無い**（既存のコードの意味を下に追記。アカウント削除の予約中は §8.7 の `DELETION_PENDING`）。

### 13.1 `GET /v1/shop/products`（認証なし、REQ-UXS-022）
従来のフィールド（`id, kind, priceYen, paidCoins, once?, items?`）はそのまま。追加は表示用：
```json
{ "products": [
  { "id": "coin_480", "kind": "coins", "name": "コイン310", "tab": "coins", "storeType": "consumable", "priceYen": 480, "paidCoins": 310,
    "autoRenew": false, "contents": [{ "type": "paid_coins", "qty": 310, "label": "有償コイン310枚" }],
    "firstPurchaseBonus": { "coins": 310, "currency": "free", "label": "はじめての購入時のみ：無償コイン310枚をプレゼント" },
    "oneTime": false, "oneTimeScope": null, "period": null,
    "noticeKeys": ["shop.paid_first", "shop.first_purchase_bonus", "legal.tokushoho", "legal.shikin_kessai"] },
  { "id": "season_pass_plus", "kind": "season_pass", "name": "シーズンパス＋", "tab": "pass", "storeType": "consumable", "priceYen": 2400, "paidCoins": 0, "pass": { "levels": 10 },
    "contents": [
      { "type": "pass_premium", "levels": 30, "reward": { "freeCoins": 50, "items": [{ "itemId": "breeding_material", "qty": 1 }] }, "label": "シーズンパス有料ライン 全30段（各段：無償コイン50枚＋配合素材×1）" },
      { "type": "pass_levels", "qty": 10, "label": "パスのレベル＋10（購入時）" },
      { "type": "item", "itemId": "tack_bridle_pass_plus", "qty": 1, "label": "限定馬具「シーズンパス＋の頭絡」×1" } ],
    "firstPurchaseBonus": null, "oneTime": false, "oneTimeScope": null, "period": { "kind": "season" }, "autoRenew": false,
    "noticeKeys": ["shop.paid_first", "shop.no_auto_renew", "shop.pass_season_only", "shop.pass_auto_grant", "legal.tokushoho", "legal.shikin_kessai"] },
  { "id": "stable_allowance_30d", "kind": "allowance", "allowance": { "days": 30, "dailyFreeCoins": 30 }, "period": { "kind": "days", "days": 30 },
    "contents": [{ "type": "paid_coins", "qty": 100, "label": "有償コイン100枚" }, { "type": "daily_free_coins", "qty": 30, "days": 30, "total": 900, "label": "30日間、毎日 無償コイン30枚（1日1回受け取り）" }], "…": "…" } ],
  "notices": { "shop.paid_first": "有償コインから先に使われます", "legal.tokushoho": "特定商取引法に基づく表記", "…": "…" },
  "legalLinks": [{ "key": "legal.tokushoho", "title": "特定商取引法に基づく表記" }, { "key": "legal.shikin_kessai", "title": "資金決済法に基づく表示" }, { "key": "shop.paid_first", "title": "有償コインの使用順" }],
  "notice": "有償コインから先に使われます" }
```
- `contents[].type`：`paid_coins` / `daily_free_coins`（`qty`・`days`・`total`）/ `pass_premium`（`levels`・`reward`）/ `pass_levels` / `item`（`itemId`・`qty`）。表示順のまま並べる。
- `tab`：`recommended` / `coins` / `pass`。`oneTimeScope`：`account`（スターター）/ `class`（昇級記念、各クラス1回）/ null。`storeType`：`consumable`（コイン・パス・手当。Google は consume）/ `non_consumable`（1回限りの商品。Google は acknowledge）。自動更新の商品は無い。
- `noticeKeys` の文言は `notices`。`legal.*` は法定ページへのリンクのキー。

### 13.2 `POST /v1/shop/purchase-intent`（追加フィールド）
```json
{ "product": { … }, "monthSpentYen": 0, "monthlyLimitYen": null, "remainingYen": null,
  "firstPurchaseBonus": { "coins": 310, "currency": "free", "label": "はじめての購入時のみ：無償コイン310枚をプレゼント" },
  "pass": { "seasonId": "2026-11", "endsAt": 1796050800000, "remainingDays": 6, "lastWeek": true, "autoRenew": false, "levels": 0 },
  "allowance": { "days": 30, "dailyFreeCoins": 30, "autoRenew": false } }
```
- `firstPurchaseBonus` はこのプレイヤーにまだ残っている時だけ（コインのパック）。`pass` はシーズンパス／パス＋、`allowance` は厩舎手当の時だけ。`lastWeek`（残り7日以内）の時は購入確認に「このパスは◯日（`remainingDays`）で終わります」を出す。
- 既存コードの追加の意味：`ALREADY_PURCHASED` ＝ このシーズンのパス（パス・パス＋のどちらか）を持っている／厩舎手当の期間中（予約分を含む）／1回限りの商品を購入済み。`NOT_ELIGIBLE` ＝ 昇級記念パックのクラスに未到達。

- 旧来の自動更新の購読（`storeType: "auto_renewing"`）の経路はテスト用に残っているだけで、リリース前なので購読は一度も販売していない（`season_pass` はシーズンごとの消費型）。旧購読の更新通知を扱う必要はない。

### 13.3 `GET /v1/shop/offers`（要認証、REQ-UXS-017）
```json
{ "offers": [
    { "id": "starter_pack", "productId": "starter_pack", "touchpoint": "T2", "placement": "popup", "reason": "first_4th_or_worse", "triggeredAt": 1795568400000, "viewedAt": null, "showPopup": true, "endsAt": null, "remainingDays": null },
    { "id": "season_pass_2026_11", "productId": "season_pass", "touchpoint": "T3", "placement": "popup", "reason": "pass_unlock", "triggeredAt": 1795568400000, "viewedAt": null, "showPopup": true, "endsAt": 1796050800000, "remainingDays": 6 },
    { "id": "season_pass_2026_11_plus", "productId": "season_pass_plus", "touchpoint": "T3", "placement": "recommended", "showPopup": false, "…": "…" },
    { "id": "promo_pack_B", "productId": "promo_pack_B", "touchpoint": "T4", "placement": "popup", "reason": "class_B", "…": "…" },
    { "id": "stable_allowance_30d", "productId": "stable_allowance_30d", "touchpoint": "shop", "placement": "recommended", "reason": null, "triggeredAt": null, "viewedAt": null, "showPopup": false, "endsAt": null, "remainingDays": null } ],
  "firstPurchase": { "available": true, "productIds": ["coin_160", "…"], "noticeKey": "shop.first_purchase_bonus" },
  "allowance": { "active": false, "claimedToday": false, "queued": null } }
```
- `showPopup` が true のオファーだけ、決まった場面（06 §5.1：T2＝結果画面を閉じた後、T3＝パス画面・開幕の初回起動、T4＝昇級演出の後）で1枚だけ出す。出したら 13.4 で記録する。その後もショップの「おすすめ」には `placement` に関係なく並べてよい。
- `reason`：T2 は `first_4th_or_worse`（ランク戦で初めて4着以下）か `race5`（ランク戦5戦目の後）、T3 は `pass_unlock` / `pass_level_up` / `season_start`、T4 は `class_<クラス>`。
- 買った商品は返らない（1回限りの商品は返金後も）。`endsAt` は実在の期間（シーズンの終わり）だけ。

### 13.4 `POST /v1/shop/offers/:offerId/view`（要認証）
本文なし。`{ "offerId": "starter_pack", "viewedAt": 1795568400000 }`。何度送っても最初の時刻のまま。今返っていないオファーは `404 NOT_FOUND`、`offerId` が `[A-Za-z0-9_]{1,64}` でなければ `400 BAD_REQUEST`。パス＋の id（`…_plus`）を送るとそのシーズンのパスの案内として記録する。

### 13.5 厩舎手当（REQ-UXS-018）
- `GET /v1/shop/allowance`（要認証）：期間中は `{ "active": true, "productId": "stable_allowance_30d", "startDate": "2026-11-25", "endDate": "2026-12-24", "day": 1, "days": 30, "daysLeft": 30, "dailyFreeCoins": 30, "claimedToday": false, "claimedDays": 0, "queued": null }`、期間外は `{ "active": false, "claimedToday": false, "queued": { "startDate", "endDate" } | null }`。
- `POST /v1/shop/allowance/claim`（要認証・`Idempotency-Key` 必須）：上の形に `freeCoins`（今回付与した無償コイン）と `wallet` を足したもの。今日は受け取り済み → `409 ALREADY_CLAIMED`、期間外 → `409 NOT_ELIGIBLE`。受け取らなかった日の分は後から受け取れない。

### 13.6 `GET /v1/season-pass`（要認証、REQ-UXS-020/021。従来のフィールドは残る）
```json
{ "seasonId": "2026-11", "level": 0, "xp": 80, "xpPerLevel": 100, "maxLevel": 30, "xpToNextLevel": 20, "racesToNextLevel": 1,
  "active": true, "expiresAt": 1796050800000, "seasonEndsAt": 1796050800000, "remainingDays": 6, "lastWeek": true, "autoRenew": false,
  "boostLevels": 0, "owned": ["season_pass"], "purchasable": [], "claimed": { "free": [], "premium": [] },
  "rewards": { "free": { "every": 1, "reward": { "freeCoins": 10 } }, "premium": { "every": 1, "reward": { "freeCoins": 50, "items": [{ "itemId": "breeding_material", "qty": 1 }] } } },
  "autoGrantAtSeasonEnd": true,
  "lastSeason": { "seasonId": "2026-10", "xp": 3000, "level": 30, "premium": true, "boostXp": 0, "granted": { "free": [1, "…"], "premium": [1, "…"] }, "autoGranted": { "free": [29, 30], "premium": [29, 30] }, "autoFreeCoins": 120, "at": 1793467800000 } }
```
- `active` は有料ラインを受け取れるか（＝このシーズンのパスを持っている）。`lastSeason` は前のシーズンの締めで自動付与した分（無ければ null）。締めの処理（`closeSeason`）の結果にも同じ形の `pass` が入る。

### 13.7 `GET /v1/missions`（追加フィールド、REQ-UXS-010）
`{ "missions": [ … ], "firstWinBonus": { "modes": ["ranked"], "byWin": [30, 20, 10], "winsToday": 1, "remaining": 2, "next": 20 } }`。レース結果（`applyRace` の戻り値）には `firstWinBonus`（そのレースで付いた無償コイン、0 なら無し）が入る。

### 13.8 返金（REQ-PUR-006 の拡張）
ストアの返金通知の結果に `linkedClawback: { "freeCoins": n, "items": { "<itemId>": n } }` が加わる：購入の後にその購入のおかげで付与した分（厩舎手当の受け取り済みの無償コイン、パスの有料ラインの報酬、パス＋の10段でだけ届いた無料ラインの報酬）。足りない分は従来どおり未精算（`debt` / `itemDebt`）になり、精算までガチャと購入が止まる。

## 14. ルールセット 1.3 の固有スキル（REQ-UXS-050/051、docs/planning/06-ux-experience-spec.md §7.1）
- 追加キー：`skillMaxSpeedPermille`、`skillMaxAccelPermille`、`skillMaxDrainSavePermille`、`skillMaxRecoverPermille`、`skillMaxDurationTicks`。**全部あるか全部ないか**（他のキー群とは独立）。**ない場合は `horse.skill` を無視**し、1.2.x 以前と同じ結果になる。C# `RulesetParams.SkillIntKeys` と TS `SKILL_RULESET_KEYS` は一致させる（テストで確認）。既定値（1.3.0）は 30 / 400 / 400 / 80 / 160。キーがあってもスキルを持つ馬がいなければ 1.2.0 と同じ計算（結果ハッシュはバージョン文字列の分だけ変わる）。
- `horse.skill`：`id`・`name`（表示用。計算には使わない）・`trigger`・`value`・効果5つ（全て整数）。1頭1スキル。
- **発動は条件だけ**（乱数を使わない）。1レースに1回まで。条件は**そのtickの開始時の状態**（前のtickの結果：距離・レーン・順位・スタミナ）で判定するので、スロットの順番に依存しない。出走していない（ゲート前）・ゴール後の馬は判定しない。
  | trigger | value | 条件 |
  |---|---|---|
  | `finalStraight` | 0..11 | 最後の区間が直線で、残り ≤ min(最後の直線の長さ, スパート区間) かつ 前の馬が value 頭以下（順位 ≤ value、0 = 先頭） |
  | `cornerRail` | 0..11 | 今いる区間がコーナーで、レーン ≤ value（0 = 内ラチ沿い） |
  | `lowStamina` | 0..1000 | 残りスタミナ ≤ value ‰ |
  | `spurtBehind` | 0..11 | スパート区間の中で、順位 ≥ value |
  | `remaining` | 0..4000 | 残り ≤ value m |
  | `leading` | 0..4000 | 残り ≤ value m かつ 先頭 |
  | `slipstream` | 1..1200 | 前のtickまでに value tick 続けて風よけ（スリップストリーム）の中 |
  | `goodStart` | 0..60 | ゲートが開いて value tick 以内にスタートした（スタートしたtickに発動） |
- **効果**（各値はまずルールセットの上限 `skillMax*` で頭打ち）：発動したtickから `durationTicks` の間、目標速度 ×(1000 + `speedPermille`)/1000（手綱の後、スタミナ切れの頭打ちの前）、加速 ×(1000 + `accelPermille`)/1000（スタートダッシュの後）、脚の消費 ×(1000 − `drainSavePermille`)/1000（馬場の係数の後）。`recoverPermille` は発動の瞬間に スタミナ += 最大値 × recover / 1000（最大値まで）。
- イベント `Skill`（値12）：Slot = 発動した馬、Value = 発動した時の順位（前のtickの順位、0 = 先頭）。表示・実況用で、チェックサムと結果ハッシュには入らない（スキルの影響は速度・スタミナとしてチェックサムに現れる）。
- **サーバーが送る値**：`server/master/skills.json` の値を、ステータスを正規化するレース（ランク戦・大会・クラス上限のあるイベント）では `rankedCaps` で頭打ちにして送る。タイムアタック・チュートリアル・能力固定のイベントでは送らない。CPU の馬はテンプレートのスキルを持つ（乱数なし）。
- ゴールデン：`contracts/golden/race-turf2000-skills.json`（8種類の条件すべてが発動する）。1.2.0 のゴールデンは `contracts/golden/legacy/*.ruleset-1.2.0.json` に残し、今も同じ結果で検証できることをテストしている。

## 15. ゲーム日（REQ-DAY-001〜006、`server/src/domain/time.ts`）
- **ゲーム日**＝ JST の切り替え時刻からの24時間。キーは `YYYY-MM-DD`＝「JST の時刻から切り替え時刻を引いた日付」（例：4:00 切り替えなら 12月5日 03:59 JST は `2026-12-04`、04:00 は `2026-12-05`）。JST に夏時間は無い。
- 規則はマスター／リモート設定の `progression.dayRollover`：`{ "hourJst": 4, "previousHourJst": 0, "effectiveAtMs": 1796065200000 }`。`effectiveAtMs`（2026-12-01 04:00 JST）より前は `previousHourJst`、以後は `hourJst`。`GET /v1/config` が同じ形で `dayRollover` を返す（認証なし）。端末は日付・残り日数の表示にこの規則を使い、サーバーが返す `remainingDays`・`endsAt`・`lastClaimDate` などを正とする。
  ```json
  { "versionId": "base", "hash": "base", "rulesetVersion": "1.3.0", "activatedAt": null, "visualsVersion": "…",
    "dayRollover": { "hourJst": 4, "previousHourJst": 0, "effectiveAtMs": 1796065200000 } }
  ```
- 端末の計算（C# は TS と同じ式）：`hour = now < effectiveAtMs ? previousHourJst : hourJst`、`index = floor((now + 9h − hour·1h) / 24h)`、`key = UTC日付(now + 9h − hour·1h)`、残り日数 `= index(endsAt − 1) − index(now) + 1`（終わっていれば0）。
- 切り替えの日：0→4 を 4:00 で切り替えると `2026-12-01` が 00:00〜翌 04:00 の28時間になる（二重リセットも欠ける日も無い）。規則の変更は効く時刻の1時間以上前に配信され、切り替えの瞬間に日の番号が戻らない時刻しか受け付けない（REQ-DAY-002）。
- **ゲーム日で決まるもの**：ログインボーナス（`lastClaimDate`）・初心者ログボの日数・デイリーミッション（`missions.date`）・初勝利ボーナス（`dailyWins`）・フレンド戦報酬の上限・世話・配合（追加の配合を含む）・TA の回数・種牡馬の貸し借り・マイ厩舎のいいね（`likeId` の日付部分）・厩舎手当の受け取り日（`startDate`〜`endDate` もゲーム日）・通知の1日上限・その日の馬場・プレイヤーの「n日目」（機能の開放）・シーズンパスとオファーの `remainingDays`。
- **暦（0:00 JST）で決まるもの**：シーズン（月）・ランキング・支部リーグ・シーズンパスの終了（`endsAt` = 翌月1日 00:00 JST）と購入できる月・オファーの `endsAt`・月額の課金上限・有償残高の基準日・KPI の日付・シーズンのお知らせ・ナイターの時間帯。月初の 0:00〜3:59 は新しいシーズンで、ゲーム日はまだ前月末。

## 16. アセット配信（REQ-DLV-001〜010、`server/src/domain/assetCatalog.ts`、C# `AssetCatalog.cs`・`AssetDownloader.cs`）

キー（`contracts/assets.md`）ごとに「CDN のどのファイルか」を返すカタログ。サーバーは絵や音を持たず、ファイルは CDN（R2）に置く。

### 16.1 `GET /v1/assets/catalog?platform=ios|android`（認証なし）

```json
{
  "catalogVersion": 2, "manifestVersion": 2, "platform": "ios",
  "hash": "<sha256 hex>", "baseUrl": "https://assets.example.com",
  "urlTemplate": "{base}/{platform}/{sha256}/{file}",
  "policy": { "ftueBlockingMaxBytes": 3000000, "cellularWarnBytes": 50000000, "tutorialMaxWaitMs": 3000, "maxParallel": 4 },
  "groups": ["boot", "ftue", "home", "race", "shop", "ondemand"],
  "entries": [
    { "key": "horse/coat/bay", "file": "horse/coat/bay.bundle", "sha256": "<64 hex>", "size": 183422, "group": "race", "required": false }
  ]
}
```

- `platform` が無い・不正 → 400 `BAD_REQUEST`。`entries` はキー順。複数のキーが同じ `file` を指してよい（1つの AssetBundle に複数キー）。
- **ETag** = `"<hash>"`（`hash` は `hash` 以外の全フィールドの正規化 JSON の SHA-256。CDN の基点も含む）。`If-None-Match` が一致すれば **304**（本文なし）。`Cache-Control: public, max-age=60, must-revalidate`。
- URL = `urlTemplate` の `{base}`・`{platform}`・`{sha256}`・`{file}` を置き換えたもの（TS `assetUrl`、C# `AssetCatalog.UrlFor`）。既定はハッシュ入りのパスなので **CDN 上のファイルは不変**（長期キャッシュ可、作り直しは別パス）。
- `baseUrl` は wrangler の変数 `ASSET_CDN_BASE`（秘密ではない）。**カタログやリモート設定には CDN のホスト・トークン・署名を書けない**（`urlTemplate` は `{base}/` で始まり、`?`・`#` を含まない）。未設定なら `""` で、クライアントは何も取得せずアプリ同梱のアセットと `<kind>/default` で動く。
- `GET /v1/config` に `assetCatalogVersion` が付く。クライアントは手元のカタログの `catalogVersion` と違えば取り直す（`AssetCatalogStore.IsStale`）。
- 古いサーバー（この経路が無い＝404）・通信できない場合、クライアントは保存済みのカタログ、それも無ければ空のカタログで続行する（落とさない）。

### 16.2 グループと required（REQ-DLV-003）

| group | いつ取得するか |
|---|---|
| `boot` | 起動時。全 kind の `<kind>/default` は必ずここで `required: true`（REQ-ASSET-002） |
| `ftue` | チュートリアル前。`required` のものだけ待つ（合計は `policy.ftueBlockingMaxBytes` 以下、上限 5MB） |
| `home` / `race` / `shop` | チュートリアルの裏・後で先読み（待たない） |
| `ondemand` | 画面が必要になった時（`AssetDownloader.EnsureAsync`）。馬名の音声など |

- `required: true` は `boot`・`ftue` のみ。それ以外は**どの画面も待たない**（無ければフォールバック）。
- **チュートリアルは最大 `policy.tutorialMaxWaitMs`（上限 5000ms、クライアントでも頭打ち）しか待たない**。超えたら仮の表示で始める（docs/planning/06 §2：初レース開始5秒以内・aha① 30秒以内）。
- モバイル通信で裏の取得が `policy.cellularWarnBytes` を超えるときは、サイズを出して確認する（Wi-Fi 推奨）。待たせるのは裏の取得だけ。

### 16.3 カタログの元と検証（REQ-DLV-004/005/008）

- 元：`server/master/assets-catalog.json`（`npm run scan:assets` が `unity/AssetDelivery~/` から生成。手で編集しない）。リモート設定のバンドルに `assets`（同じ形）を入れると置き換わる。
- 検証（起動時・スキャナ・リモート設定の各版）：キーの形式と kind、`file` は小文字の相対パスで `..` なし、`sha256` は64桁、`size` ≥ 1、同じ `file`・同じ `sha256` は同じ内容、`<kind>/default` は boot かつ required、required は boot/ftue のみ、required の合計 ≤ `ftueBlockingMaxBytes`、`policy` の上限、`urlTemplate` の規則。
- **内容を変えたら `catalogVersion` を上げる**：基準（同梱のカタログ）と同じ番号で内容が違う、基準より古い番号、他の保存済みの版と同じ番号で内容が違う、はすべて `CONFIG_INVALID`。

### 16.4 クライアントの保存とダウンロード（REQ-DLV-006/007）

- 保存先（Unity は `Application.persistentDataPath/muchi-assets`）：`blobs/<sha[0..2]>/<sha256>`（検証済み・完全なファイルだけ。原子的な rename でのみ作る）、`partial/<sha256>.part`（途中）、`catalog-<platform>.json`（最後に取得できたカタログ。`.tmp` に書いてから置き換え）。
- 取得：同時数は `maxParallel`。途中で切れたら `Range: bytes=<n>-` で再開（206 なら追記、200 なら最初から、416 なら捨てて最初から）。ネットワーク・5xx・429・途中切れはバックオフで再試行、404/403/410 は再試行しない。完了後に SHA-256 を照合し、違えば捨てて取り直す（規定回数で `Corrupt`）。同じファイルへの同時の要求は1回の転送にまとめる。
- 容量：空き容量（予備を残す）と `MaxCacheBytes` の範囲で、required → グループ順 → 小さい順に入るだけ取得し、残りは `SkippedQuota`（途中まで書かない）。足りなければ先に古い版を消す。書き込み失敗は `DiskFull`（再試行しない）。
- 古い版の削除：新しいカタログを受け取ったら、参照されなくなった `sha256` のファイルを消す（`AssetDownloader.EvictStale`）。読み込む前に行う。
- 表示：`AssetResolver.Resolve(key)` が「ダウンロード済み（優先）→ アプリ同梱 → `<kind>/default` → 何も出さない」を返す（`AssetKeys.Resolve` と同じ順）。

## 17. ガチャの開催カレンダー・天井・ステップアップ（REQ-GACHA-011〜015、docs/planning/06 §6.5・§7 7位）
時刻はすべてサーバーの時計で決まる。クライアントの残り時間は `serverNowMs` で端末の時計を補正して数える（C# `BannerListModel`）。

**`GET /v1/gacha/banners`**（認証なし）：開催中と予告中のバナーだけ。並びは「終わりがあるもの（早く終わる順）→ 常設（マスターの順、恒常ガチャは最後）→ 予告（早く始まる順）」。
```json
{ "serverNowMs": 1793934000000,
  "banners": [ { "id": "pickup_ginga", "name": "ピックアップ：ギンガノカナタ", "currency": "any", "priceSingle": 100, "priceTen": 1000,
    "status": "active" | "upcoming", "startAtMs": 1793458800000, "endAtMs": 1796050800000, "announceAtMs": 1793199600000,
    "lastDay": "2026-11-30", "daysLeft": 25, "pityGroup": "pickup_ginga", "pityLabel": "ピックアップ（ギンガノカナタ）", "pityCost": 100,
    "pityTargets": ["t_ginga"], "pickup": { "templateId", "name", "rarity" } | null, "limited": false,
    "stepUp": { "steps": 5, "afterLast": "loop" | "repeatLast", "prices": [500, 1000, 1000, 1000, 1000], "finalSlotSteps": [5] } | null } ] }
```
- `endAtMs` は終わりを含まない（その1 ms 前まで引ける）。常設は `startAtMs`/`endAtMs`/`daysLeft`/`lastDay` が null で、**残り時間を出さない**。`daysLeft` は今日を1と数えるゲーム日（`progression.dayRollover`、§15）。
- 予告前（`announceAtMs` より前）のバナーは一覧に出ず、`GET /v1/gacha/:id/odds` も `NOT_FOUND`。予告中は提供割合を見られるが引けない。

**`GET /v1/gacha/status`**（要認証）：
```json
{ "serverNowMs": 1793934000000,
  "groups": [ { "group": "pickup_ginga", "label": "…", "points": 37, "cost": 100, "remaining": 63, "exchangeable": 0, "banners": ["pickup_ginga"],
    "targets": [ { "templateId", "name", "owned" } ], "closesAtMs": 1796050800000 | null,
    "carryOver": { "atMs", "toGroup": "standard", "toLabel": "恒常", "rate": "1:1", "expires": false, "toTargets": [ { "templateId", "name" } ], "notice": "…" } | null } ],
  "banners": [ { "bannerId", "pityGroup", "points", "cost", "remaining", "coinsToExchange",
    "stepUp": { "completed", "steps", "afterLast", "step", "round", "priceTen", "finalSlotMinRarity": "SSR" | null } | null } ] }
```
- 期間が終わったグループは、次の取引で行う変換（1:1・失効なし）を済ませた値で返す（表示が実際と食い違わない）。`exchangeable` はそのグループの開いているバナーで今交換できる回数。
- `coinsToExchange`：交換まで最も安く引いた場合のコイン（10連優先、ステップアップはこの先のステップの価格の合計）。

**ステップアップ**：10連のみ（1回は `BAD_REQUEST`）。価格は今のステップの `priceTen`。`finalSlotPool` を持つステップは10枠目を必ずその表で引く（SR以上だけ。`guaranteed: true`）。チケットは使えない（`NOT_ELIGIBLE`、設定の検証でも弾く）。`POST /v1/gacha/:id/draw` の応答に `"stepUp": { "drawnStep": 5, "next": { …上の stepUp… } }` が加わる。

**`GET /v1/gacha/:id/odds` の追加**：`period.lastDay`、`pickup: { templateId, name, rarity, ppm, rate, guaranteePpm, guaranteeRate } | null`（抽選表の行そのもの）、`stepUp: { afterLast, notice, steps: [ { step, priceTen, finalSlot: { appliesTo, items | null, rarityTotals | null } } ] } | null`、`pity.label`・`pity.costCoins`（交換までの最大コイン、ステップアップは各ステップの価格から）・`pity.closesAtMs`・`pity.carryOver`（上と同じ形）。`estimatedMaxCostYen` は `costCoins` から計算する。

**期間外の操作**：引く・チケット・天井交換は `BANNER_CLOSED`（409）。`message` は `banner <id> ended at 2026-12-01 00:00 JST` / `banner <id> opens at …` / `banner <id> is not open`（予告前）。判定はその取引でサーバーが読んだ時刻（Durable Object の中で1回）。
