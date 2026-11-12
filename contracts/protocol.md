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
  "mode": "ranked",                 // "ranked" | "friend" | "tutorial" | "timeattack" | "event" | "tournament" | "challenge"（§31） | "cup"（§42）
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
| `hello` | `{"t":"hello","raceId":"…","token":"…","lastTick":-1,"engine":1}` | 参加・再接続。`lastTick`は計算済みの最後のtick（初回は-1）。`engine`は任意（エンジンの水準、Round 17、§46.4） |
| `in` | `{"t":"in","tick":123,"cmd":32}` | 入力。`tick`は宛先tick |
| `chk` | `{"t":"chk","tick":120,"h":"0123456789abcdef"}` | チェックサム（`tick`は`checksumIntervalTicks`の倍数） |
| `res` | `{"t":"res","h":"<64hex>","order":[3,0,…],"finishTicks":[1830,1835,…],"skills":[0,5],"assist":"whip"}` | 結果ハッシュと着順。`finishTicks`は任意（`order`と同じ並び、未完走は-1）。合意した全員が同じ値を送った時だけ戦績のベストタイムに使う。`skills`は任意（固有スキルが発動した枠、§24.4）。合意した2人以上が同じ一覧の時だけ実績に使う（検証に回ったレースは検証サービスの `skillsFired`）。`assist`は任意（`"whip"`/`"full"`、自分の枠のかんたん操作、§27。KPIだけに使い誰にも送らない）。最も速い馬でもゴールできないtickより前の`res`は`err` `RESULT_TOO_EARLY`、2回目以降の`res`は無視 |
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
| `cheers` | `{"t":"cheers","n":[[3,"go",2]]}` | Round 19（§55）：観戦者の応援の1秒ごとの集計。**入力でもハッシュの材料でもない**（リプレイログ・チェックサム・結果に入らない） |

互換性の注意（Round 19、§55）
- 部屋 → 端末の**知らない `t` は無視する**こと（C# `LockstepClient` は `Errors` に `UNKNOWN_MESSAGE` を足すだけで、致命的ではない。Round 19 より前の端末も `cheers` を受け取って困らない）。
- 端末 → 部屋の新しい `t`（`cheer`）は、部屋が `start` で案内した時（`spectator.cheer`）だけ送る。古い部屋は厳格なスキーマで知らない `t` を `BAD_MESSAGE` にする。`hello` に新しいフィールドを足さない（古い部屋が拒むため）。

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
| 4026 | `version mismatch` | `hello.engine` がそのレースに要るエンジンの水準より小さい（直前に `err` `VERSION_MISMATCH`、§46.4） | 再接続しない。`VERSION_MISMATCH`（更新画面へ） |
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
- `skillsFired`（追加・任意、Round 11）：再シミュレーションで固有スキルが発動した枠（昇順）。HTTP の `POST /verify` だけが付ける（`VerifyService.Verify(json, withSkills: true)`。golden ファイル・`replay` コマンドの出力は今までどおり無し）。サーバーはこれで実績の「固有スキルの発動」を数える（§24.4）。サーバーのスキーマは厳格なので、**サーバーを先に更新してから検証サービスを更新する**こと（古いサーバーはこの欄を拒否する）。
  - Round 13：**頼まれた時だけ**付ける。サーバーはリクエストヘッダー `X-Muchi-Verify-Skills: 1` で頼む（`HttpVerifierClient` は常に付ける）。ヘッダーの無いリクエスト（Round 11 より前のサーバー）には付けないので、検証サーバーをいつも先にデプロイできる（`docs/ops/deploy.md` §7.1）。
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
- 応援（Round 19、§55）：観戦者は `cheer` を送れ、観戦者と選手に `cheers`（1秒の集計）が届く。`start.spectator.cheer` が案内。レースの結果には入らない。

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
`?mine=1`（要認証）を付けると、プレイヤーごとの所持（`owned` / `ownedReason` / `purchasedThisSeason`）が加わる（§18.1）。
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
  "banners": [ { "id": "pickup_ginga", "name": "ピックアップ：ギンガノカナタ", "currency": "any", "singleAllowed": true, "priceSingle": 100 | null, "priceTen": 1000 | null,
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

**ステップアップ**：10連のみ（1回は `BAD_REQUEST`）。一覧と提供割合では `singleAllowed: false`・`priceSingle: null`・`priceTen: null`（使える価格はステップの価格だけ。古いサーバーは `singleAllowed` を送らない＝true）。ステップの表を持たないステップの10枠目は「1〜9枠目にSR以上が出なかった場合は保証の表、それ以外は上の表」と書く。価格は今のステップの `priceTen`。`finalSlotPool` を持つステップは10枠目を必ずその表で引く（SR以上だけ。`guaranteed: true`）。チケットは使えない（`NOT_ELIGIBLE`、設定の検証でも弾く）。`POST /v1/gacha/:id/draw` の応答に `"stepUp": { "drawnStep": 5, "next": { …上の stepUp… } }` が加わる。

**`GET /v1/gacha/:id/odds` の追加**：`period.lastDay`、`pickup: { templateId, name, rarity, ppm, rate, guaranteePpm, guaranteeRate } | null`（抽選表の行そのもの）、`stepUp: { afterLast, notice, steps: [ { step, priceTen, finalSlot: { appliesTo, items | null, rarityTotals | null } } ] } | null`、`pity.label`・`pity.costCoins`（交換までの最大コイン、ステップアップは各ステップの価格から）・`pity.closesAtMs`・`pity.carryOver`（上と同じ形）。`estimatedMaxCostYen` は `costCoins` から計算する。

**期間外の操作**：引く・チケット・天井交換は `BANNER_CLOSED`（409）。`message` は `banner <id> ended at 2026-12-01 00:00 JST` / `banner <id> opens at …` / `banner <id> is not open`（予告前）。判定はその取引でサーバーが読んだ時刻（Durable Object の中で1回）。


## 18. 支部の応援スタンプ・支部フィード（REQ-TEAMFEED-001〜009、`server/src/domain/teamFeed.ts`、C# `TeamFeed.cs`・`Muchi.Game` `TeamFeedModel`）
支部の中だけで使う、**定型スタンプだけ**のやりとり。自由入力の文字はどこにも無い（本文に `text` などを付けると `BAD_REQUEST`）。そのため利用者の文章を審査する仕組みは要らない（docs/planning/03）。スタンプの絵はアセットキー `stamp/<id>`（`contracts/assets.md`、`npm run gen:assets` でマニフェストに載る。絵が届くまでは `stamp/default`）。

**マスターデータ** `server/master/stamps.json`：
```json
{ "version": 1,
  "config": { "postIntervalMs": 10000, "postsPerDay": 50, "feedSize": 100, "pageDefault": 20, "pageMax": 50, "reportsPerDay": 10, "muteMax": 100, "racePlaceMax": 3 },
  "stamps": [ { "id": "cheer", "label": "がんばれ！", "unlock": { "kind": "default" } },
              { "id": "whip", "label": "ムチ一閃！", "unlock": { "kind": "races", "count": 10 } },
              { "id": "pass_crown", "label": "王者の風格", "unlock": { "kind": "pass" } },
              { "id": "carrot", "label": "にんじん！", "unlock": { "kind": "cosmetic", "itemId": "stamp_carrot" } } ] }
```
- 解放の条件（REQ-TEAMFEED-002）：`default` 最初から／`races` 通算出走回数（`stats.races`、遊んで解放）／`pass` シーズンパス（パス・パス＋）を一度でも購入（返金済みは除く。一度買えばずっと使える）／`cosmetic` 見た目ショップでコインで直接買う（`items.json` の `kind: "stamp"`・`asset: "stamp/<id>"`。決まった価格、ガチャ・ランダムからは出ない）。スタンプの見た目以外の効果は無い。
- 起動時とリモートコンフィグで `stampsProblems` が検証する（無料のスタンプが1つ以上、`cosmetic` は直販の `kind: "stamp"` の品と1対1、ラベル1〜12文字、上限値の範囲）。

**エンドポイント**（全て要認証。支部に入っていないと `NOT_IN_TEAM`（404））：

| メソッド・パス | 本文 | 応答 | エラー |
|---|---|---|---|
| `GET /v1/stamps` | — | `{ "version", "limits": { "postIntervalMs", "postsPerDay", "feedSize", "pageMax" }, "stamps": [ { "id", "label", "asset": "stamp/<id>", "unlock": { "kind", "count"?, "itemId"? }, "unlockText": "レースに10回出走で解放", "unlocked": true } ] }` | — |
| `GET /v1/teams/me/feed?before=<seq>&limit=<n>` | — | 下の `FeedPage`（新しい順） | `before`/`limit` が数字でない・0 は `BAD_REQUEST` |
| `POST /v1/teams/me/feed/stamps` | `{ "stampId": "cheer" }` | `{ "teamId", "seq", "at", "stampId" }` | `STAMP_LOCKED`（409、未解放。`message` は解放条件）、`RATE_LIMITED`（429、10秒に1回・ゲーム日ごとに50回）、`DELETION_PENDING`（削除予定中）、`NOT_FOUND`（無いスタンプ） |
| `PUT /v1/teams/me/feed/:seq/reaction` | `{ "stampId": "nice" \| null }` | `{ "teamId", "seq", "myReaction" }` | 1つの項目に1人1つ（新しいスタンプで置き換え、null で取り消し）。同じ人の操作は2秒あける（`RATE_LIMITED`）。項目が古くて消えていれば `NOT_FOUND` |
| `POST /v1/teams/me/feed/:seq/report` | `{ "reason": "spam" \| "harassment" \| "other" }` | `{ "reported": true, "seq" }` | 自分の項目は `BAD_REQUEST`、1日10件まで（`RATE_LIMITED`）。同じ項目の2回目は何もしない |
| `GET /v1/teams/me/feed/mutes` | — | `{ "muted": ["<playerId>"] }` | — |
| `PUT /v1/teams/me/feed/mutes` | `{ "playerId", "muted": true \| false }` | `{ "muted": [...] }` | 自分は `BAD_REQUEST`、100人まで（`TEAM_LIMIT`） |

```json
FeedPage = { "teamId": "tabc123456", "latestSeq": 130, "nextBefore": 111 | null, "muted": ["p9"],
  "items": [ { "seq": 130, "at": 1795575600000, "kind": "stamp" | "race", "playerId": "p1", "displayName": "ミドリカワ", "mine": false,
               "stampId": "cheer" | null, "stampAsset": "stamp/cheer" | null,
               "race": { "raceId": "r_…", "mode": "ranked" | "tournament", "place": 1, "fieldSize": 12, "trackId": "kirameki_turf_2000" | null } | null,
               "reactions": [ { "stampId": "nice", "count": 2, "mine": true } ], "myReaction": "nice" | null } ] }
```
- **リングバッファ**（REQ-TEAMFEED-004）：支部ごとに最新 `feedSize`（100）件だけを TeamDO が持つ（キー `feed`、支部の状態とは別）。`seq` は支部の中で増え続ける番号。ページは `nextBefore` を次の `before` に渡す。古い項目は消えるので、その `seq` への応援・報告は `NOT_FOUND`。
- **レース結果の自動項目**（REQ-TEAMFEED-004）：支部員がランク戦か大会で `racePlaceMax`（3）着以内に入ると、レースの精算（プレイヤーのDurable Object）の後に支部へ1件届く（同じレース・同じ人は1件。無効レース・フレンド戦・4着以下は出ない）。届かなくても精算は失敗にしない（ベストエフォート）。
- **名前**：支部員の項目は今の支部の名前（メンバー一覧の `displayName`）で表示。抜けた人の項目は投稿時の名前のまま。
- **ミュート（ブロック）**（REQ-TEAMFEED-006）：見る人ごと。ミュートした人の項目とリアクションは自分のページから消え、その人の応援の通知も来ない。端末はすぐに自分の一覧に反映し（`TeamFeedModel`）、サーバーの一覧へ送る（失敗したら次に開いたときに送り直す）。
- **報告**（REQ-TEAMFEED-007）：報告した人のページからはその項目が消え、投稿者のプレイヤー状態にサポート用のフラグ `team_feed_report:<teamId>:<seq>:<reporter>:<reason>` が付く（運営の `GET /v1/admin/players/:id` の `supportFlags` で見える）。
- **通知**（任意）：自分のレース結果に支部員が新しく応援スタンプを付けると、push テンプレート `team_cheer`（カテゴリ `friends`、1日の上限・静かな時間帯は通常どおり）。ミュートした相手からは来ない。支部全体への呼びかけ（メンション）は無い。
- **アカウント削除**（REQ-TEAMFEED-008）：削除予定中（`scheduled`）は投稿・応援が `DELETION_PENDING`（見ることはできる）。削除の処理の「支部」の段で、その人が投稿・応援した全ての支部（今の支部と、最近抜けた支部。プレイヤー状態の `teamFeed.postedIn`、最大10）から、その人の項目・リアクション・報告・投稿の回数を消す。
- **KPI**（REQ-TEAMFEED-009、サーバーが書く。クライアントイベントは無い）：`stamp_post`（`s1` スタンプID、`s2` `post` | `reaction`、`s3` 支部ID）、`team_feed_view`（フィードの1ページ目を開いたとき。`s1` 支部ID、`count` ミュート人数）。docs/ops/kpi-queries.md。

### 18.1 関連する小さな修正（ラウンド10）
- **`GET /v1/shop/products?mine=1`**（要認証、§13.1）：同じ一覧に、そのプレイヤーの所持を加える。各商品に `owned`（今は買えない：1回限りの商品を購入済み／今シーズンのパス（パス・パス＋のどちらか）を購入済み／厩舎手当の受け取り中か予約中。`purchase-intent` が `ALREADY_PURCHASED` を返す条件と全く同じ）、`ownedReason`（`"once"` | `"season_pass"` | `"allowance"` | null）、`purchasedThisSeason`（シーズンパスだけ：その商品を今シーズン買ったか。他は null）。最上位に `"personalized": true, "seasonId": "2026-11"`。`mine` なしは従来どおり（`"personalized": false`、所持の項目は無い）。C# `ApiClient.GetMyProductsAsync`、`ShopModel` はこちらを使い、買ったパスのカードを「購入済み」にする。
- **削除の処理中のレース結果**（§8.7）：アカウント削除の処理が始まった（`deleting`）プレイヤーへのレース結果は、何も変えずに成功で返す（`{ "skipped": "deletion_pending" }`）。部屋はそのプレイヤーを済みとして他の人を通常どおり精算し、再試行もデッドレターもしない。
- **削除が済んだ後のレース結果**（ラウンド10の統合で追加）：削除の最後の段（`wipe`）はプレイヤーのストレージを消した後に墓標（`deleted` 表：プレイヤーIDと時刻だけ）を残す。状態が無く墓標があるプレイヤーへのレース結果は、プレイヤーを作り直さずに成功で返す（`{ "skipped": "deleted" }`）。状態がまだ無いだけの新しいプレイヤー（墓標なし）は従来どおり反映する。

## 19. 友達招待（招待コード、REQ-INV-001〜012、`server/src/domain/invite.ts`、C# `Invite.cs`・`InviteModel`）

**招待コード**：プレイヤーごとに1つ、変わらない8文字。文字は `23456789BCDFGHJKMNPQRSTVWXZ`（母音なし＝単語にならない、0/O・1/I/L などの見間違いなし）。1文字目はディレクトリのシャード（0〜15）、2〜7文字目は乱数、8文字目は検査文字（各文字の (位置+1)×(位置+2) の重み付き和を27で割った余り。C# `InviteCodes.Check` と同じ）。表示は `92W6-5BGF`。入力は大文字小文字・空白・ハイフンを無視する。禁止の並び（`INVITE_BLOCKLIST`）を含むコードは作らない。重複は DirectoryDO が作り直す。アカウント削除でコードは**引退**（行を残し二度と配らない）。

**`GET /v1/invite`**（要認証。任意ヘッダー `x-install-id`：アプリのインストールごとの乱数 ID。サーバーはハッシュ（SHA-256 の先頭16バイト）だけを保存し、このプレイヤーのコードを同じ端末から使うことを断るのに使う）
```json
{ "code": "92W65BGF", "displayCode": "92W6-5BGF",
  "share": { "deepLink": "muchi://invite/92W65BGF", "url": "https://invite.muchi-issen.example/i/92W65BGF", "text": "…さんから「ムチ一閃」への招待です。招待コード 92W6-5BGF を入力すると、はじめてのプレゼントがもらえます。\nhttps://…" },
  "redeem": { "eligible": true, "reason": null | "ftue" | "window_closed" | "already_redeemed" | "deletion", "windowDays": 7, "daysLeft": 7,
    "invitedBy": { "playerId": "alice" | null, "displayName": "…" | null, "at": 1793934000000, "milestones": ["im_graduate"] } | null,
    "welcomeGift": { "items": [ { "itemId": "gacha_ticket", "qty": 1 } ] } },
  "invitees": [ { "playerId": "bob" | "deleted:2", "displayName": "ボブ" | null, "at": 1793934000000, "counted": true, "deleted": true?,
    "milestones": [ { "id": "im_graduate", "at": 1793937600000, "rewarded": true } ] } ],
  "counted": 2, "cap": 10,
  "milestones": [ { "id": "im_graduate", "kind": "beginner_complete" | "class" | "ranked_races", "classId": "B" | null, "target": null, "reward": { "freeCoins": 100 }, "rewardYen": 160 } ],
  "termsKey": "terms.invite" }
```
- `share.text` はそのまま OS の共有シートに渡す（報酬の額は入れない。03-legal-risk.md「友達招待」）。`share.url` の https は仮のドメイン（本番のドメインが決まったら `progression.invite.shareBaseUrl` を変える）。
- `redeem.daysLeft` は今日を1と数えるゲーム日（§15）。`eligible` が false のときは入力欄を出さない。
- `counted: false` の招待（上限を超えた分）は参加・フレンドにはなるが、到達しても招待した人に報酬は出ない（`rewarded: false`）。
- `rewardYen` は景品表示法のチェックに使う円換算（最小パックの単価）。画面には出さなくてよい（規約・ヘルプ用）。

**`POST /v1/invite/redeem`**（要認証）`{ "code": "92w6-5bgf", "installId": "i-…" }` → `{ "status": "redeemed" | "already", "inviter": { "playerId", "displayName" | null }, "welcomeGift": {…}, "friended": true }`
- 1アカウント1回。条件：チュートリアルの相棒を迎えた後（`NOT_ELIGIBLE`）・始めてから `redeemWindowDays`（7）ゲーム日以内（`INVITE_WINDOW_CLOSED`）・アカウント削除の予定がない（`DELETION_PENDING`）・まだ入力していない（`INVITE_ALREADY_REDEEMED`）。
- 誤り：形が違う・検査文字が合わない `INVITE_CODE_INVALID`（400）／存在しない・引退したコード `NOT_FOUND`／自分のコード `INVITE_SELF`／不正対策で断る `INVITE_REFUSED`（同じ端末・同じインストールで2回目・招待の輪・招待した人が削除予定や停止中。**理由は画面に出さない**）／入力しすぎ `RATE_LIMITED`（429。1時間5回・1日10回、失敗も数える）。
- 成功すると、招待された人にウェルカムギフト（無償のみ）、両者がフレンドになる（どちらかのフレンドが上限なら `friended: false`、招待は有効）。招待した人には**この時点では何も付与しない**（インストールだけでは報酬なし）。プッシュ `invite_joined`。
- 手順（`InviteService.redeem`）：試行の記録 → コードの検証と検索 → インストールの確保（DirectoryDO、1インストール1回） → 招待した人の記録（冪等） → 招待された人の記録とギフト。後半が失敗したら招待した人の記録とインストールの確保を戻す。自動で再送しない（再送しても `already` になるだけだが、試行回数に数える）。

**到達報酬（マイルストーン）**：招待された人の取引の終わりで到達を調べ（`noteInviteMilestones`）、届け先を本人の送信箱に入れる。Durable Object のアラームが招待した人へ届ける（失敗したら 2分・4分…最大6時間の間隔で再送。受け取り側は「招待された人＋マイルストーン」で冪等）。対象は引き換えから `milestoneWindowDays`（90）日以内。既定：
| id | 条件 | 招待した人への報酬 | 円換算 |
|---|---|---|---|
| im_graduate | 初心者ミッションをすべて受け取った | 無償コイン20 | ¥32 |
| im_class_a | A級に昇級（シーズン履歴の昇級も含む） | 無償コイン40 | ¥64 |
| im_class_s | S級に昇級（同上） | スカウト券1枚 | ¥160 |

（Round 10 の統合で変更：以前の「初心者完了で無償コイン100・B級でスカウト券1枚」は、招待上限の人の SSR/月 が E2 の上限を超えたため、小さく・遅く（深く遊んだ時点へ）分けた。docs/spec/balance-targets.md 4.10）
- 上限：招待した人1人につき `maxCountedInvitees`（10）人まで。到達時にプッシュ `invite_milestone`。KPI は双方に `invite_milestone`。

**アカウント削除（REQ-UXS-040 の手順 `invites`）**：本人の送信箱（届いていない到達報酬）は放棄、コードは引退、インストールの確保はハッシュだけ残す（同じ端末で作り直して再び使うことはできない）。招待した人の側の記録は `deleted:<n>` に匿名化（上限の枠は空かない）、招待された人の側は `invitedBy.playerId` を null にして、その人宛ての送信箱を捨てる。

**設定**（`progression.invite`、リモート設定でも同じ検証）：報酬は無償コインとスカウト券（1回・10連）だけ、1回の付与は ¥200 以下（`INVITE_HARD_LIMITS.maxRewardYen`、最小パックの単価で換算）。上限は人数20・入力期間14日・マイルストーン5個まで。マイルストーンの種類は `beginner_complete` / `class` / `ranked_races` のみ（購入を条件にする種類はない）。設定が無ければ招待のルートは `NOT_FOUND`。

**深いリンク**：`muchi://invite/<code>`（アプリが入っているとき）と `https://<招待ドメイン>/i/<code>`（入っていないときはストアへ。Universal Links / App Links にすればアプリが開く）。アプリはコードを入力欄に入れるだけで、自動では引き換えない。チュートリアル前に開いた場合はコードを端末に覚えておき、入力できるようになったら入れる（C# `InviteCodes.FromLink`・`InviteModel.HandleLink`）。iOS / Android の設定は `docs/handoff-codex-round10-invite.md`。

**KPI**：クライアント `invite_share`（`props.channel`: `os_share` | `copy_code` | `copy_link`、共有シートで実際に共有したときだけ）。サーバー `invite_redeem`（s2 = `inviter` / `invitee`）・`invite_milestone`（s1 = マイルストーン id、s2 = `invitee` / `inviter`）。クエリは docs/ops/kpi-queries.md。

## 20. 復帰キャンペーン・お知らせ（What's new）（REQ-CB-001〜012、`server/src/domain/comeback.ts`、C# `Comeback.cs`・`Muchi.Game` `ComebackModel`/`WhatsNewModel`、docs/planning/06 §4.5）

**活動日と休眠**：サーバーは「最後に遊んだゲーム日」（`lastActiveDay`、§15 の切り替え時刻で数える）を持つ。更新するのはプレイヤーからの呼び出しだけ（`POST /v1/player/bootstrap`・`POST /v1/rewards/login-bonus`・`GET /v1/missions`・`GET /v1/comeback`）。通知の配信・フレンド申請・種付け料などサーバー側の処理では更新しない。その日に初めて遊んだ時、前の活動日から `progression.comeback.tiers[].minLapseDays`（既定 7 / 14 / 30）以上あいていれば、期間を1回だけ始める（条件は REQ-CB-002）。

**`GET /v1/comeback`**（要認証。活動日として数える＝ここで期間が始まることもある）：
```json
{ "active": true,
  "push": { "category": "comeback", "enabled": false },
  "window": { "id": "cb1_20261117", "tier": "short" | "mid" | "long", "lapseDays": 7,
    "startDay": "2026-11-17", "endDay": "2026-11-30", "endsAt": 1796050800000, "remainingDays": 14, "day": 1, "days": 14,
    "showWelcome": true, "completed": false, "blocked": false,
    "login": { "claimed": 0, "total": 7, "claimableToday": true, "days": [ { "day": 1, "reward": { "freeCoins": 100 }, "claimed": false } ] },
    "missions": [ { "id": "cb_race", "kind": "races", "feature": "skills", "title": "まずは1レース", "guide": "…", "target": 1, "progress": 0,
      "reward": { "freeCoins": 50 }, "claimed": false, "claimable": false } ],
    "catchUp": { "seasonId": "2026-11", "targetXp": 1020, "capXp": 700, "grantedXp": 0, "remainingXp": 700, "bonusPerRace": 20, "active": true } } }
```
- 期間が無い時は `{ "active": false, "window": null, "push": … }`。`endsAt` は期間の最後のゲーム日の次の切り替え時刻（含まない）。画面は**日付**で「11月30日まで」と出し、カウントダウンは出さない（06 §5.5）。`remainingDays` は今日を1と数えるゲーム日。
- `blocked: true`：アカウント削除の予約中（REQ-UXS-040）。受け取りは全て `DELETION_PENDING`（取り消せば戻る）。`claimable`・`claimableToday` も false で返る。
- `missions[].progress` は期間の開始時からの増分（`kind`：`races`・`ranked_races`・`wins`・`gacha`（券を含むスカウト）・`care`・`stable`（マイ厩舎の保存）・`breed`・`silks`）。`feature` はミッションが案内する画面のキー（`skills`・`scout`・`bond`・`my_stable`・`race` など、クライアントの対応表）。
- `catchUp`：期間中、報酬の出るレースごとにパスXPを `bonusPerRace`（＝`passXpPerRace` × `bonusPermille`）上乗せする。上限は `capXp`（開始時に `min(maxBonusXp, lapseDays × perLapseDayXp, targetXp − その時のXP)`）と、シーズンの中央値の目安 `targetXp`（`medianXpPerSeasonDay` × シーズンの何日目か、暦の月）。シーズンが変わったら止まる。レース結果の `comebackXp` に上乗せ分が入る。

**`POST /v1/comeback/login`**（要認証・冪等キー必須）：今日の分を受け取る。`{ "day": 2, "reward": {…}, "window": {…上と同じ…} }`。1ゲーム日に1回、とぎれても日数は進む（失わない）。期間外は `NOT_ELIGIBLE`、受け取り済み／7日分済みは `ALREADY_CLAIMED`、削除予約中は `DELETION_PENDING`。通常のログインボーナス（REQ-REW-002）とは別に受け取れる。

**`POST /v1/comeback/missions/:missionId/claim`**（要認証・冪等キー必須、`missionId` は `[a-z0-9_]{1,40}`）：`{ "missionId", "reward", "window" }`。未達は `NOT_ELIGIBLE`、存在しない ID は `NOT_FOUND`。

**`POST /v1/comeback/welcome`**（要認証）：歓迎画面を出した。`{ "windowId", "welcomedAt" }`（最初の時刻のまま）。以後 `showWelcome` は false。

**報酬**：無償コイン・スカウト券・10連券・SR以上確定券・配合素材だけ（設定の検証で、有償コイン・見た目のアイテム・馬・パスXP の報酬、`collect` のミッション、上限を超える価値を拒否。REQ-CB-009/010）。

**`GET /v1/whats-new`**（要認証）：前回見た位置より後に始まったもの（新しい順、最大10件、残りは `more`）。
```json
{ "since": 1793199600000, "upTo": 1795316400000, "showCard": true, "more": 0,
  "items": [ { "id": "banner_pickup_ginga", "kind": "feature" | "banner" | "event" | "balance", "title": "…", "body": "…", "at": 1793458800000,
    "feature": "scout" | null, "bannerId": "pickup_ginga" | null, "eventId": null, "endsAt": 1796050800000 | null } ] }
```
- 元は `server/master/changelog.json`（機能・調整。`day` はゲーム日の切り替え時刻から、または `atMs`。リモート設定の `changelog` で丸ごと差し替え）と、その間に開いて今も開いているバナー、始まって今も開催中のイベント。`endsAt` は実在の終わり（バナー・イベント）だけ。
- 新規プレイヤーは登録時点から数える（過去の一覧は出ない）。

**`POST /v1/whats-new/seen`**（要認証）：本文 `{ "upTo": <GET の upTo> }`。`{ "seenUpTo" }`。戻らない・今より先へは進まない。カードは1回だけ出す。

**通知**：プッシュの種類 `comeback`（既定で受け取らない。`PUT /v1/push/preferences` の `categories.comeback`、06 §3.5 の「新しい種類と同意」）。最後の活動日から `pushes[].afterDays`（3日目・7日目）の `pushHourJst`（19時 JST）に、1日の上限・静かな時間帯（push.json）の中で1回ずつ。7日目の文面（「おかえりボーナスを用意しています」）は、戻れば期間が始まる人にだけ送る。削除予約中・停止中は送らない。

**ショップ**（`GET /v1/shop/offers`、§13.3 の追加）：期間中で今シーズンのパス未購入なら、`touchpoint: "comeback"`・`id: "comeback_<windowId>"`・`productId: "season_pass"` のオファーを1件（ポップアップは1回、§13.4 で記録）。価格・中身は通常のパスと同じ、`endsAt` はパスの実在の販売終了（シーズン末）。その間 T3 のパスのポップアップは出さない（ショップの「おすすめ」には並ぶ）。新しい商品・割引は作らない（REQ-CB-011）。

## 21. リワード広告（任意の動画広告、REQ-AD-001〜012、`server/src/domain/ads.ts`・`server/src/ads/ssv.ts`、C# `Ads.cs`・`Muchi.Game.RewardedAdModel`）
無課金の人が、自分で選んだ時だけ動画を見て少しの報酬を受け取る。**全画面の強制広告（インタースティシャル）は無い**。報酬は**無償コイン**（有償コインには絶対にならない＝資金決済法の有償残高に入らない）か**タイムアタック1回**だけ。文言はサーバーが作る固定額（「無償コイン10枚」）で、「倍」「お得」「今だけ」は使わない（設定の検証で弾く）。報酬は**広告ネットワークのサーバー検証（SSV）コールバックでだけ**付与し、クライアントの報告では付与しない。

### 21.1 設定（`progression.ads`、リモート設定で変更可・`adsProblems` で検証）
| キー | 既定 | 意味 |
|---|---|---|
| `enabled` / `network` | true / `admob` | |
| `globalDailyCap` | 3 | 1ゲーム日（§15）に受け取れる回数（全部の枠で） |
| `startsPerDay` / `maxOpenSessions` | 12 / 3 | 1日に開ける視聴セッション数・同時に開いておける数（乱用の制限） |
| `sessionTtlMs` / `maxClockSkewMs` | 1時間 / 10分 | セッションの有効期限・コールバックの時刻のずれの許容 |
| `minRankedRaces` / `minGameDay` | 3 / 2 | FTUE（ランク戦3戦まで）とインストール当日（最初のセッション）は出さない |
| `payerQuietDays` | 30 | 直近30日に実際の支払いがある人には、自分でオンにしない限り出さない |
| `minAge` | 13 | 登録済みの年齢が13歳未満なら出さない |
| `anomalyFlagAt` | 5 | 1日に弾いたコールバックがこの数に届くとサポート用の印 `ads_anomaly:<日>` |
| `placements[]` | 下表 | `id`・`surface`（home/result/time_attack/shop）・`title`・`dailyCap`・`reward`（`freeCoins` か `taAttempts` のどちらか1つ）・`adUnitKey`（広告ユニットIDの**キー名**。IDそのものは env） |

| 枠 | 画面 | 報酬 | 1日 |
|---|---|---|---|
| `daily_coins` | ホーム | 無償コイン10枚 | 1回 |
| `result_coins` | ランク戦の結果（**3着以内の時だけ**。4着以下の結果画面には出さない） | 無償コイン10枚 | 1回 |
| `ta_attempt` | タイムアタック | その日の挑戦 +1回 | 1回 |

コード側の上限（`ADS_HARD_LIMITS`、リモート設定でも超えられない）：全体6回/日、枠ごと3回/日、1回の無償コイン20枚、**1日の広告の無償コイン40枚**（上限の組み合わせで計算）、タイムアタック+1回、`minGameDay ≥ 2`、`minRankedRaces ≥ 1`、`minAge ≥ 13`、`payerQuietDays ≤ 90`。

### 21.2 `GET /v1/ads`（要認証）
```json
{ "enabled": true, "eligible": true, "reason": null, "pref": "auto", "payerQuietUntil": null, "day": "2026-12-11",
  "globalCap": 3, "globalUsed": 0, "globalLeft": 3, "startsLeft": 12, "network": "admob",
  "placements": [ { "id": "daily_coins", "surface": "home", "title": "動画を見て、無償コインを受け取る", "rewardLabel": "無償コイン10枚",
    "reward": { "freeCoins": 10 }, "dailyCap": 1, "used": 0, "left": 1, "adUnitKey": "REWARDED_HOME", "available": true } ],
  "adRequest": { "nonPersonalized": true, "underAgeOfConsent": false, "ageKnown": false },
  "open": [ { "sessionId", "placementId", "expiresAt" } ] }
```
- `reason`（出さない理由）：`disabled` / `opted_out`（設定でオフ）/ `deleting`（削除の予約中）/ `moderation`（BAN）/ `ftue` / `first_day` / `age` / `payer_quiet`（`payerQuietUntil` まで）。
- `adRequest`：登録済みの成人でなければ**パーソナライズしない**広告を要求（年齢未登録も含む）。16歳未満は「同意年齢未満」の印を付けて要求する。
- 何も書き込まない（日の切り替えは表示用に計算するだけ）。

### 21.3 `PUT /v1/ads/preferences`・`POST /v1/ads/:placementId/start`・`GET /v1/ads/sessions/:sessionId`（要認証）
- `PUT /v1/ads/preferences` `{ "mode": "auto" | "on" | "off" }` → §21.2 の形。`auto`（既定：支払いから30日は出さない）、`on`（支払った人も見る）、`off`（誰でも出さない）。
- `POST /v1/ads/:placementId/start`（`Idempotency-Key` 必須。再送は同じセッション）→
  `{ "sessionId": "ad_<16桁hex>", "placementId", "network": "admob", "adUnitKey", "customData": "<sessionId>", "userId": "<プレイヤーID>", "expiresAt", "rewardLabel", "adRequest" }`。
  **ここでは何も付与しない**。SDK のサーバー検証オプションに `customData`（セッションID）と `userId`（プレイヤーID）を渡して広告を出す。エラー：`NOT_ELIGIBLE`（§21.2 の理由）、`DELETION_PENDING`、`AD_LIMIT_REACHED`（409、今日の分を使い切った）、`RATE_LIMITED`（開始回数・同時セッション）、`NOT_FOUND`（枠が無い）。
- `GET /v1/ads/sessions/:sessionId` → `{ "sessionId", "placementId", "status": "open" | "rewarded" | "rejected" | "expired", "expiresAt", "reward" | null, "rewardLabel" | null, "reason" | null, "wallet" }`。広告を閉じた後、`status` が `open` でなくなるまで1秒ごとに数回確かめる（`RewardedAdModel`：8回）。間に合わなければ「確認に時間がかかっています。届きしだい反映されます」。

### 21.4 SSV コールバック `GET /v1/ads/ssv/admob`（認証なし、署名で認証）
AdMob の形：`?ad_network=…&ad_unit=…&custom_data=…&reward_amount=…&reward_item=…&timestamp=<ms>&transaction_id=…&user_id=…&signature=…&key_id=…`。
1. **署名**（`ssv.ts` `verifyAdMobCallback`）：`&signature=` より前のクエリ文字列（受け取ったまま。URL として解釈し直さず、リクエストの URL の `?` から `#` までをそのまま使う：`app.ts` `rawQuery`）を、`key_id` の公開鍵（ECDSA P-256 / SHA-256、署名は DER の base64url）で検証。鍵の組は差し替え可能（`SsvKeySource`）：env `ADS_SSV_KEYS_URL`（ネットワークが公開する鍵の JSON。1日キャッシュ、知らない `key_id` の時だけ最短1分おきに取り直す。取り直しに失敗した時は最後に取れた鍵の組で検証を続け（最大7日、`maxStaleMs`。使うたびにログ）、それより古ければ失敗を返す）か `ADS_SSV_KEYS`（固定の鍵、開発・結合テスト用）。署名より後ろに付け足された値は読まない。署名が無い・違う・知らない鍵・必須の値が無い → **401**（ネットワーク側で失敗として見える）。鍵の組が設定されていなければ **404**（どの報酬も付与されない）。
2. **広告ユニット**：env `ADS_AD_UNITS`（`{"REWARDED_HOME":"<ID>",…}`）があれば、知らないユニット・枠と違うユニットは弾く。
3. **プレイヤーのオブジェクト**（`user_id` の Durable Object、`ads.ts` `applyAdCallback`）で判定：
   - 同じ `transaction_id` は `duplicate`（冪等。直近200件を覚え、さらに取引の冪等キー `ad:admob:<tx>` で同じ結果を返す）。署名が `user_id` を含むので、別のプレイヤーへの再送は起こらない（全体の索引は不要）。
   - 弾く理由：`user_mismatch`・`unknown_session`（`custom_data` がこのプレイヤーのセッションでない）・`session_used`（同じセッションに別の取引）・`expired`・`clock_skew`（サーバーの時刻と `maxClockSkewMs` 以上ずれる、またはセッションより前）・`ad_unit_mismatch`・`cap`（1日の上限）・`deleting`、それに広告を見ている間に変わった資格：`opted_out`（`pref: off`）・`age`（登録した年齢が `minAge` 未満）・`moderation`（利用停止）。広告の途中で課金した場合は弾かない（支払った人の30日の非表示は新しい案内を出さないためのもので、課金前に自分で選んで見始めた広告の報酬までは取り上げない）。弾いた時も **200** `{ "ok": true, "status": "rejected" }` を返す（ネットワークが再送しない）。KPI `ad_reject` と、多い日はサポート用の印。
   - 付与：無償コイン（台帳の参照 `ad:admob:<tx>`）か、タイムアタックのその日の挑戦回数 +1。回数を数え、セッションを `rewarded` にし、KPI `ad_reward`。応答 `{ "ok": true, "status": "rewarded" }`。
4. **乱用の制限**：検証に失敗したコールバックは送り元IPごと、検証に通ったものはプレイヤーごとにトークンバケット（Worker のインスタンスごと、30回・毎秒1回）。正しいコールバックは広告ネットワークの少数のサーバーから来るので、IPごとの上限は失敗にだけかける（正しい報酬を止めない）。プレイヤーのオブジェクトでも開始回数・同時セッション・1日の上限で止まる。

### 21.5 クライアント（`RewardedAdModel`、`IAdProvider` はネイティブ側）
- カードを出すのは：サーバーが `eligible` で、その画面の枠に今日の残りがあり、SDK が広告を用意できている時だけ。**チュートリアル・マッチング・レース中・4着以下の結果画面・オフラインには出さない**。再生はカードのボタンからだけ（自動で始めない）。1回に1つ。
- KPI（クライアント）：`ad_offer_view {placementId, surface}`（画面に出した時、画面ごとに1回）、`ad_start {placementId, surface, outcome: shown|no_fill|failed|closed_early}`。報酬（`ad_reward`）はサーバーのイベントだけで、クライアントからは送れない。
- 同意：iOS の ATT は 06 §2.3 のとおり（2日目以降の2回目の起動で1回だけ、FTUE では聞かない）。許可が無ければパーソナライズしない広告。GDPR/UMP は日本だけの配信では不要だが、`IAdConsent` の差し込み口を残す。

### 21.6 広告なしパス（`ad_free_pass`）は作らない
強制広告が無く、広告は自分で選んだ時だけ再生されるので、「広告を消す」商品には消すものが無い（払っても何も変わらない商品は誤認のおそれ）。代わりに、支払った人には既定で広告を出さない（`payerQuietDays` 30日、`pref: on` で自分から見ることはできる）。経済の目標 E13（balance-targets 4.9）も、広告の価値を一番安い有料商品より小さく保つ。

## 22. 運用コンソール向けの管理API（REQ-OPS-008/009/015/020a/026/027、`server/src/http/admin.ts`、`tools/ops-console`、`docs/ops/console.md`）
管理APIは端末（Unity）からは呼ばない。認証は `Authorization: Bearer <管理トークン>`（Cookie なし）。書き込みは `content-type: application/json` と本文の `reason`（3〜500文字）が必須で、全呼び出しが監査ログに残る。ブラウザからは `ADMIN_CONSOLE_ORIGINS` のオリジンだけ CORS で許可（`OPTIONS` は認証前に 204、資格情報は不可。未許可のオリジンは 403）。

| メソッド | パス | 権限 | 本文 → 応答 |
|---|---|---|---|
| POST | `/v1/admin/config/validate` | viewer | `{bundle}` → `{ok, problems: string[], groups: {dayRule, assetCatalog, gacha, ruleset, other}}`（`groups` は追加） |
| POST | `/v1/admin/config/dry-run` | viewer | `{op}`（`{kind:'activate', versionId, at?}`／`{kind:'rollback', versionId: string\|null}`／`{kind:'cancel', activationId}`）→ `{ok, problems, groups, effect: Activation\|null}`。何も保存しない（`effect.id` は `"(dry run)"`） |
| GET | `/v1/admin/config/diff?from=&to=` | viewer | → `{from, to, changes: [{path, before, after}], total, truncated}`。`base`＝空のバンドル。`id` 付きの一覧は `path[<id>]` |
| GET | `/v1/admin/gacha/calendar?versionId=` | viewer | → `{versionId, serverNowMs, today, dayRollover, banners: [{id, name, currency, priceSingle, priceTen, status, startAtMs, endAtMs, announceAtMs, firstDay, lastDay, pityGroup, pityLabel, pityCost, pityTargets, pickup, stepUp: {afterLast, prices, finalSlotSteps}\|null}], pityGroups: [{id, label, cost, endAtMs, lastDay, convertTo, finalGroup, chain, banners, carryOver}]}` |
| GET | `/v1/admin/gacha/:bannerId/odds?versionId=` | viewer | → `{versionId, odds}`。`odds` は `GET /v1/gacha/:bannerId/odds` と同じ形（公開前・終了後も） |
| GET | `/v1/admin/events?versionId=` | viewer | → `{versionId, serverNowMs, events: [{id, name, startAtMs, endAtMs, status, trackIds, fee, maxPlayers, entry}], tracks: [{id, surface, distanceM}]}` |
| GET | `/v1/admin/tournaments` | viewer | → `GET /v1/tournaments` と同じ |
| GET | `/v1/admin/players/lookup?inviteCode=` | viewer | → `{playerId, inviteCode}`（形式違いは400、該当なしは404） |
| GET | `/v1/admin/players/:playerId` | viewer | → `{state, integrity, flags: [{raw, kind, group, detail}], compensations}`。`state` に `exists`・`accountDeleted`・`deletion: {status, requestedAt, deleteAt, steps, attempts, retryAt}\|null`・`referral: {invitedBy, invitees, installs}\|null` |
| GET | `/v1/admin/compensations?status=&playerId=&limit=` | viewer | → `{requests: CompensationRequest[], threshold: {freeCoins, itemQty}, hardCap}` |
| POST | `/v1/admin/compensations` | operator | `{playerId, grant: {freeCoins?, items?: [{itemId, qty}]}, opKey, reason}` → `{request, created, payment: {before, after}\|null}`。閾値以下は `status: executed`、超えると `pending`。閾値以下でも、そのプレイヤーへの1人で決めた付与（直接配布・一括配布・閾値以下の補填）の直近24時間の合計が閾値を超えるなら `pending`（`needsApproval: true`、`payment: null`。分けて2人目を省けない、QA R11） |
| POST | `/v1/admin/compensations/:id/approve` | admin | `{note?, reason}` → `{request, payment}`。依頼者本人は403、期限切れ・却下済み・付与済みは409 |
| POST | `/v1/admin/compensations/:id/reject` | operator | `{note?, reason}` → `{request}` |

`POST /v1/admin/players/:playerId/grants`・`POST /v1/admin/grants/bulk` も同じ24時間の合計に数え、超える分は `403 FORBIDDEN`（`two-person approval required: …`、一括配布は `failed[]` に入る）。失敗した書き込みの監査ログの対象は、パスに `:id` があれば `<種類>:<id>`（例 `compensation:comp_3`）。

`CompensationRequest`：`{id, opKey, playerId, grant, reason, requestedBy, requestedRole, requestedAt, expiresAt, needsApproval, status: pending|approved|executed|rejected|expired, decidedBy, decidedAt, decisionNote, executedAt, error}`。

## 23. ローカライズ（英語、REQ-L10N-001〜013、`server/src/i18n/*`、C# `Localization.cs`（`Loc`・`LocaleCatalog`・`Romaji`）、`Muchi.Game` `UxText`）
文言の元は**日本語**（ドメインのコード・マスター・ゴールデンファイルは変えない）。英語は日本語の文をキーにした**文字列表**で訳す。対応言語は `ja`（既定）と `en`。

### 23.1 リクエストの言語
- `?lang=ja|en`（`en-US` などは `en`）を最優先。無ければ `Accept-Language`（q値の高い順、同じなら書いた順に最初の対応言語。`*`・`q=0` は選ばない）。どちらも無ければ `ja`。対応していない言語は無視する。
- 応答に `content-language: ja|en` と `vary: accept-language`。`?lang=` の無い同じURLでも言語で中身が変わるので、キャッシュは `vary` に従うこと。
- C# の `ApiClient` は毎回 `accept-language` を送る（`ApiClientOptions.Locale`、実行中は `ApiClient.Locale` で切り替え）。Unity は `MuchiServices.SetLanguage(locale)`（PlayerPrefs `muchi.language`、Runtime の `LocaleService` と同じキー）。

### 23.2 サーバーの訳し方（`http/app.ts` の応答の出口、`i18n/catalog.ts`）
- ドメインは日本語で作る。`en` の時だけ、応答の JSON の**全ての文字列の値**を表で訳してから返す（キー・数値・ID はそのまま）。エラーの `message` も同じ。管理API（`/v1/admin/*`）と `GET /v1/assets/catalog` は対象外。
- 訳さないもの：ID の欄（`id`・`key`・`voiceName`・`asset`・`assetKey`・`icon`・`templateId`）と、`name:…` `voice/…` のような識別子の形の文字列。**プレイヤーが書いた文字**（表示名・支部名・表札・自分で付けた馬名）はそのまま返る：表示名・支部名・表札とその写しの欄（`displayName`・`teamName`・`plateName`・`ownerName`・`opponentName`・`inviterName`・`inviteeName`・`fromName`・`byName`・`anonName`、`PLAYER_TEXT_KEYS`）は表を引かない（「決勝」という名前の人は「決勝」のまま）。馬名は表に無いカタカナなのでそのまま。クライアントがカタカナの馬名をローマ字で表示する（§23.6）。
- 表は2つで、どちらも日本語の文そのものがキー：
  - `server/master/locale-en.json`（`Master.locale.en`）：マスターの**プレイヤーに見える日本語すべて**（商品名・注記・法定表示のリンク名・スカウトのバナーと天井の名前・馬名と血統名・称号・スキル名・スタンプ・イベント名・アイテム名・支部リーグの部・復帰ミッション・広告の枠の文言・お知らせ（What's new）・プッシュの文・競馬場名・厩舎テーマ）。
  - `server/src/i18n/en.ts`（`CODE_EN`）：ドメインのコードが組み立てる文（商品の中身の行・はじめての購入の行・提供割合のページの注記と各表の説明・券の説明・天井の移行・スキルの発動条件と効果・スタンプの解放条件・削除の確認・招待の共有文・名前の既定値・大会の回戦名・選手に見えるエラーの詳細）。
- **テンプレート**：キーに `{名前}` があれば型として照合する。`n` `m` `v` `p` `a` `b` `i` `y` `days` `levels` `qty` `minutes` `points` は数字だけ（`1,020`・`2.5%`）、`hm` は時刻（`4:00`）、`id` `code` `url` はその形、ほかは任意の文字列（取り込んだ部分が日本語なら、さらに表で訳す。例：「スカウト券×1」は `{item}×{qty}` で `item` を訳す）。`name` `team` は訳せなくてもそのまま入れる（プレイヤーの名前）。英語側の `{n:ord}` は序数（「3着」→ `3rd`）。
- **組み立てた文**：表に無ければ文（「。」）ごと、それでも無ければ区切り（`  /  `・` / `・改行・` または `・` ・ `・`＋`・`・`・`、`・全角空白）で分けて訳す。どれでも訳せなければ**日本語のまま返す**（欠けても空にはしない）。
- 1つの日本語に英語は1つ（文脈で訳し分けが要るなら日本語の文を変える）。

### 23.3 検証（起動時・リモート設定）
- 起動時（`index.ts` `validateLocale`）とリモート設定の各版（`resolveBundle` の `localeProblems`）で、マスターの**プレイヤーに見える日本語の全ての文**に英語があることを確かめる。内部だけのもの（NG語・実在の服色の禁止リスト・アセットカタログ・ニックス・年齢上限の状態・`_note` などの `_` で始まるキー）は対象外。英語が無い・英語に日本語が残っている・`{…}` の名前が日本語と違う・下の禁止表現、のどれかで**起動しない／その版を有効にしない**。
- リモート設定は `locale: { en: { "<日本語>": "<英語>" } }` を持てる（`master/locale-en.json` に足す。同じキーは上書き）。新しいバナー・イベント・お知らせを出す版は、その英語も一緒に入れる（無ければ `CONFIG_INVALID`：`locale.en: no English for gacha.banners[pickup_kohaku].name「…」`）。
- **英語の禁止表現**（`EN_BANNED`、景品表示法・REQ-UXS-022 の日本語の規則と同じ考え）：倍率（`2x`・`x2`・`×2`・`double`・`twice`・`triple`）、偽の急かし（`limited time`・`today only`・`ends soon`・`hurry`・`last chance`・`act now`・`don't miss`・`while supplies last`・`only N left`）、参考価格・割引（`% off`・`regular/usual/original price`・`best deal/value`・`bargain`・`save N`）、`free gacha`・`rate up`・`odds up`。広告の枠の文言はさらに `guarantee`・`bonus`・`deal` も使わない（`EN_AD_BANNED`、REQ-AD-004）。季節のものは `Seasonal`、限定の柄は `Exclusive` と書き、期間は実際の終了日時だけを示す。
- `npm run l10n:missing` が英語の無いマスターの文を一覧にする。

### 23.4 法定表示
特定商取引法に基づく表記・資金決済法に基づく表示は**日本語のまま**表示する（日本の法令に基づく表示で、日本語の本文が効力を持つ）。英語ではリンク名を `Specified Commercial Transactions Act notice (Japanese)` / `Payment Services Act notice (Japanese)` とし、ページでは日本語の本文の下に**参考訳であることの注記**（「日本の法令が求める表示で、適用される日本語で掲載している。以下の英語は参考訳で法的効力は無く、日本国外に条件を広げるものではない」）と参考訳を付ける。日本国外での法的な有効性はうたわない。

### 23.5 プッシュ通知
- `PUT /v1/push/devices` の本文に `locale`（`ja`|`en`、省略時はリクエストの言語）。端末ごとに記録し（`PushDevice.locale`、無い古い記録は `ja`）、送る時に端末ごとの言語で文を作る（`DueDelivery.messages[locale]`・`tokenLocales`、送り側は `messageFor(d, token)`）。英語の文はプッシュの型（`{name}さんから…`）を表で訳し、サーバーが作った値（「決勝」「2026年11月」・マスターの名前）も訳す。プレイヤーの名前はそのまま。
- 一斉配信の FCM トピックは言語ごと：`push.json` `topicsByLocale.en`（`season_en`・`events_en`）。`GET/PUT /v1/push/preferences` はリクエストの言語のトピックを `subscribe`、他の言語の同じ種類を `unsubscribe` に入れる（言語を切り替えても二重に届かない）。シーズンの知らせ・イベント開始は言語ごとのトピックへそれぞれの言語で送る。

### 23.6 クライアント（C# `Muchi.Client` / Unity `Muchi.Game` / Web プロトタイプ）
- サーバーの文は要求した言語で届くので、クライアントは訳し直さない。**クライアントが作る文**（`UxText`・各画面のモデル・`RaceDebrief`・`RaceFeel`・`ReplayClip`）は日本語のまま作り、画面に出す時に `Loc.T(text)` を通す（`ja` では何もしない）。`UxText.For`・`UxText.Reward`・`ActionResult` のメッセージは `Loc.T` 済みで返す。
- 表：`engine/Muchi.Client/Resources/Muchi/ui-en.json`（クライアントが作る文）と `server-en.json`（サーバーの2つの表をまとめたもの。`npm run gen:client-locale` で生成、サーバーのテストが古いと失敗する。レースの設定に入っている馬名・スキル名、オフラインのキャッシュの文に使う）。照合の規則はサーバーと同じ（`LocaleCatalog`）。
- 馬名：表にある馬（テンプレート馬）は英語名（`Shinsei Akatsuki`）、無いカタカナの名前（プレイヤーが付けた馬・CPUの馬）は**ヘボン式のローマ字**で表示（`Romaji.Name`、「ミドリカワ」→ `Midorikawa`、長音は付けない）。保存する名前は変えない（命名の規則はカタカナのまま、REQ-HORSE-004）。
- 実況：`Resources/Muchi/commentary-en.json`（全ての種類・変種・特化（`kind@mode`・`kind@venue`）が日本語と同じID・同じ `{…}`）。`{place}` は序数（`3rd`）、馬名・スキル名は英語の表から。`ticksPerChar` は 1（英語は1秒あたりの文字数が多い）。
- Web プロトタイプ（`tools/figma-prototype`）：EN の切り替えで、画面の全ての文字を同じ表（サーバーの2つ＋`ui-en.json`＋`logic/proto-en.json`）で訳す。英語は長いので、枠に収まらない文字は小さくして収める（66%まで）。`test/en-flow.cjs` が主な画面で日本語の残りとはみ出しを調べる。
- フォント：Noto Sans JP（400/500）・Noto Sans CJK JP（700）は Latin の字形を持つので英語も同じ書体。プロトタイプの字形の絞り込みには ASCII・Latin-1・英語の約物（‘’“”–—…）と英語の表の全ての文字を入れる。英語では字間を詰め、単語の区切りで改行する。

## 24. 図鑑・実績・称号（REQ-COL-001〜005、REQ-ACH-001〜009、`server/src/domain/collection.ts`、C# `Collection.cs`・`Muchi.Game` `CollectionModel`/`AchievementModel`/`TitleShowcaseModel`）
図鑑は「集めた・出会った記録」を見るだけの画面で、**そろえても何も貰えない**（達成率は数字の表示だけ）。実績は**遊んだこと**（出走・勝利・コース・固有スキルの発動・配合の世代・タイムアタックのメダル・大会・マイ厩舎のいいね・支部の応援）に段を付け、段ごとに**無償コイン**を少し払う。**課金・購入額・ガチャの回数を数える実績は無い**。称号は従来の一覧（§13 `GET /v1/titles`）に一本化し、実績の段で解放される称号もそこに並ぶ（docs/planning/03「図鑑・実績でコンプガチャを作らない理由」）。

### 24.1 マスターデータ（`server/master/collection.json`、起動時と各リモート設定の版で検証）
| キー | 意味 |
|---|---|
| `caps.maxFreeCoinsPerTier` / `caps.maxTotalFreeCoins` | 1段の上限 50 / 全段の合計の上限 2,000（今の合計 **1,235**）。コード上の上限 `COLLECTION_HARD_LIMITS`：1段100（最小パック ¥1.6/コインで ¥160 ≤ 総付景品の ¥200）、合計5,000、5段まで |
| `lore.horses` / `lore.skills` / `lore.courses` | 図鑑の説明文（全て架空）。テンプレート馬・スキル・コースのIDごと |
| `achievements[]` | `id`・`category`（race / course / skill / breeding / time_attack / tournament / stable / team）・`name`・`description`・`metric`・`tiers[]`（`tier` 1〜5 の連番、`target` は増加、`reward` は `{ "freeCoins": n }` だけ） |

`metric`（これ以外は拒否。`purchases`・`yenSpent`・`gachaPulls`・`collectionPercent` などは「課金・ガチャへの報酬」として専用のエラー）：

| metric | 数えるもの（どこから） |
|---|---|
| `races` / `wins` / `top3` | 出走・1着・3着以内（`stats`、確定したレースだけ。チュートリアルは数えない） |
| `trackWins`（`trackId`） | そのコースでの1着（`stats.byTrack`） |
| `collect`（`section`、`ids` 省略時は全部） | その一覧で「入手」したものの数。**`horses`・`skills` は1つでもガチャで出るものを含むと拒否、`cosmetics` は売り物なので拒否**（コンプガチャ・購入への報酬）。今は `courses`（走ったコース）だけ |
| `skillsActivated` | 自分の馬の固有スキルがレースで発動した回数（§24.4。CPU が代わりに乗った時は数えない） |
| `breedingGeneration` | 自分の厩舎で配合した仔の最も深い世代（テンプレートの馬 = 0、仔 = 1 + 親の大きい方） |
| `taMedals`（`medal`: bronze/silver/gold） | タイムアタックのメダル（`progression.timeAttack.milestones` の `_<medal>` で終わるもの） |
| `tournamentPodiums` / `tournamentWins` | 大会の3位以内・優勝（大会の結果は1大会に1回だけ反映） |
| `stableLikes` | マイ厩舎がもらった「いいね」（§マイ厩舎の数そのもの） |
| `teamCheers` | 支部フィードで送ったスタンプ（投稿・新しい応援。同じ投稿・応援は1回だけ） |

称号：`master/titles.json` の `condition: { "kind": "achievement", "achievementId", "tier" }` が実績の段に結び付く（存在しない実績・段は検証で拒否）。今は7つ（全場制覇・スキルの使い手・血統の守り人・時計の支配者・大会の覇者・人気厩舎・応援団長）。

### 24.2 `GET /v1/collection`（要認証）
```json
{ "sections": {
    "horses":   { "total": 27, "obtained": 3, "seen": 9, "unknown": 15, "completionPermille": 111, "entries": [
      { "id": "t_partner", "state": "obtained", "rarity": "SR", "name": "アイボウ", "style": "sashi", "surface": "turf",
        "distance": { "minM": 1600, "maxM": 2400 }, "skillId": "sk_sueashi", "lore": "はじめての相棒。…",
        "stats": { "speed": 600, "stamina": 550, "burst": 650, "guts": 500, "temper": 500 }, "seasonal": null, "art": "collection/portrait/t_partner" },
      { "id": "t_seiya", "state": "unknown", "rarity": "SSR", "name": null, "style": null, "surface": null, "distance": null,
        "skillId": null, "lore": null, "stats": null, "seasonal": { "label": "冬季限定" }, "art": "collection/silhouette/t_seiya" } ] },
    "skills":    { …, "entries": [ { "id", "state", "rarity", "name", "styles", "condition", "effect", "lore" } ] },
    "courses":   { …, "entries": [ { "id", "state": "obtained|unknown", "name", "surface", "distanceM", "lore", "races", "wins", "bestFinishTick", "timeAttackBestMs" } ] },
    "cosmetics": { …, "entries": [ { "id", "state": "obtained|unknown", "kind", "name", "lore", "icon" } ] } },
  "totals": { "total": 63, "obtained": 9, "seen": 12, "unknown": 42, "completionPermille": 142 },
  "completionRewards": false,
  "notice": "図鑑の達成率は記録の表示だけです。そろえても報酬はありません。" }
```
- `state`：`obtained`（持っている・持っていた。馬は引退しても残る）/ `seen`（確定したレースで同じ場を走った：CPU の馬のテンプレートと、場の全ての馬の固有スキル。§24.4）/ `unknown`。
- `unknown` の馬・スキルは**名前・説明・能力を返さない**（並び順とレア度とシルエットのキーだけ）。`seen` は名前・説明まで、能力は `obtained` だけ。
- `completionPermille` = `obtained × 1000 / total`（切り捨て）。`completionRewards` は常に `false`（達成率に報酬を付ける設定は作れない）。
- 何も書き込まない。

### 24.3 `GET /v1/achievements`・`POST /v1/achievements/:achievementId/tiers/:tier/claim`・`POST /v1/achievements/claim-all`（要認証）
```json
{ "achievements": [ { "id": "races", "category": "race", "name": "出走の記録", "description": "…", "metric": "races",
    "progress": 120, "nextTarget": 300, "tier": 2, "maxTier": 5, "badge": "badge/races_2",
    "tiers": [ { "tier": 1, "target": 10, "reward": { "freeCoins": 5 }, "unlocked": true, "unlockedAt": 1795…, "claimed": true, "claimable": false, "badge": "badge/races_1" }, … ],
    "titles": [ { "id": "ach_champion", "name": "大会の覇者", "tier": 1, "unlocked": false, "icon": "title/ach_champion" } ] } ],
  "blocked": false,
  "totals": { "tiers": 71, "unlocked": 12, "claimed": 10, "claimable": 2, "claimableCoins": 15, "earnedCoins": 85, "totalCoins": 1235 },
  "notice": "実績はレースや育成などのプレイで達成します。課金やガチャの回数では達成しません。報酬は無償コインです。" }
```
- 段の解放はサーバーが自動で行う（§24.4）。受け取りは段ごと（`…/tiers/:tier/claim`、`Idempotency-Key` 必須）か全部（`claim-all`、同じく必須）。
  応答：1段 `{ "achievementId", "tier", "reward": { "freeCoins" }, "wallet": { "free", "paid" } }`、全部 `{ "claimed": [ {achievementId, tier, reward} ], "freeCoins", "wallet" }`。
- エラー：`NOT_FOUND`（実績・段が無い）、`NOT_ELIGIBLE`（まだ届いていない）、`ALREADY_CLAIMED`（409）、`DELETION_PENDING`（削除の予約中。`blocked: true` で `claimable` は全て false）、`BAD_REQUEST`（段が 1〜5 でない）、`IDEMPOTENCY_KEY_REQUIRED`。
- `GET` は読むだけに見えるが、マスターの変更で届いた段があればここでも解放する（トランザクションの最後の手順、§24.4）。
- 台帳：`grant` / `free`、理由 `achievement <id> tier <n>`、参照 `ach:<id>:<n>`。

### 24.4 進み具合（イベントで・冪等）
- **全てのプレイヤーのトランザクションの最後**に `syncCollection` が走り、条件に届いた段を1回だけ解放する（KPI `achievement_unlock`：s1 実績ID・s2 カテゴリ・s3 metric・value 段・count 進み具合）。解放された段は取り消さない。続けて称号を評価する（実績の称号）。削除の予約中は解放しない。
- 数のほとんどは既存の状態から計算する（`stats`・タイムアタックのメダル・いいね・持っている馬）。状態に無いものだけ、その処理のトランザクションの中で数える：
  - レースの結果（`applyRace`、レースIDごとに1回だけ）：`RaceResultForPlayer.seen`（`settleRace` がレースの設定から作る：CPU の `cpu_<templateId>` と場の全てのスキルID）と `details.skillFired`。
  - 大会の結果（`tournamentClose`、1大会に1回）：3位以内・優勝。
  - 支部のスタンプ（`stampPosted`、参照 `post:<teamId>:<seq>` / `react:<teamId>:<seq>` ごとに1回）。
  - 配合：持っている馬の血統から世代を計算し、最大値を覚える。
- **固有スキルの発動**（`skillsActivated`）：クライアントは結果の報告（§4 `res`）に任意の `"skills": [slot…]`（そのレースで固有スキルが発動した枠）を付ける。結果のハッシュには入らない情報なので、**同じハッシュを報告した2人以上の全員が同じ一覧を送った時だけ**採る（スキルを持たない枠は除く。1人だけの報告は採らない：1台の端末が毎レース「発動した」と書けてしまう）。検証に回ったレース（ランク戦で人間が1人のレースは必ず回る）では、**検証サービスの再シミュレーションの `skillsFired`** を使う（§8。古い検証サービスで無い時は、検証と同じハッシュを報告した2人以上のクライアントの一致した一覧）。一覧が無い・食い違う時は数えない。
- 削除：アカウント削除（REQ-UXS-040）で状態ごと消える。予約中は受け取り・解放とも止まり、取り消せば次のトランザクションで届いた段が解放される。マイ厩舎の公開コピーのバッジも削除の手順で消える。

### 24.5 称号・マイ厩舎
- `GET /v1/titles` の各行に `source`（`record` / `achievement`）、実績の称号は `achievementId`・`tier` が付く。装備は従来どおり `PUT /v1/player/title`（解放済みだけ、`NOT_ELIGIBLE`）。プロフィール・ランキング・マイ厩舎の表札に同じ `titleId` が出る。
- マイ厩舎の公開コピー（`StableSnapshot.trophies`）に `badges`（実績ごとの最も高い段、高い順に6つまで：`{ achievementId, tier, badge }`）。無い時は項目ごと省く（古いコピーと同じ形）。

### 24.6 アセットキー（`npm run gen:assets` で `contracts/assets.manifest.json` に入る、先読みグループ home）
| 種類 | キー | 既定 |
|---|---|---|
| `collection/portrait` | `collection/portrait/<templateId>`（入手・出会った馬の絵） | `collection/portrait/default` |
| `collection/silhouette` | `collection/silhouette/<templateId>`（未発見のシルエット） | `collection/silhouette/default` |
| `badge` | `badge/<achievementId>_<tier>` | `badge/default` |

## 25. 調教（REQ-TRAIN-001〜014、`server/src/domain/training.ts`、C# `Training.cs`・`Muchi.Game.TrainingModel`）
自分の馬を毎日少しずつ鍛える短いループ。1ゲーム日（§15）に **アカウントで `slotsPerDay` 回**（馬の数では増えない）、1頭は `perHorsePerDay` 回まで。メニュー（坂路・ウッド・プール・併せ馬）を選び、任意のタイミングのミニゲーム（ムチと同じ「押す瞬間」）で結果が**少しだけ**良くなる。結果はすべて決定論：開始時の馬の状態（疲れ・絆・これまでの伸び）・メニュー・ミニゲームの点数だけで決まり、点数はサーバーが**送られたタップの時刻を自分で採点し直して**出す。サーバーの乱数はビートの並び（とステータスの分け方の同点の順）にしか使わない。

**ランク戦の公平性（決定事項）**
| 項目 | 決めたこと |
|---|---|
| 伸び | 馬に残る小さな能力の上乗せ `HorseInstance.trained`（5能力）。馬ごとの素質 `potentialByRarity`（R 300 ≥ SR 240 ≥ SSR 180、検証で R ≥ SR ≥ SSR を強制）まで、1能力は素質の `perStatCapPermille`（40%）まで、各能力 1000 まで。伸びるほど遅くなる（残りの素質の割合、下限 `softFloorPermille`）。 |
| レースへの入り方 | `toRaceHorse` = 基礎 + 覚醒 + 伸び（`raceStats`）。ランク戦・大会・タイムアタックは**これまでどおりクラスの上限に正規化**（`normalizeStats`）するので、上限に届いている馬は伸びてもランク戦では変わらない。伸びは「上限までの距離」を縮めるだけ＝はじめの馬（無課金の馬）ほど効き、課金と無課金の差は**縮むことはあっても広がらない**（経済 E15、balance-targets 4.12）。固定能力のイベントは伸びを使わない。フレンド部屋（上限なし）はそのまま。 |
| 疲れ・調子 | **調教の効率にだけ効く**（`penaltyPermillePerPoint` 5‰/点、下限 50%）。どのレース（ランク戦・フレンド・イベント・大会・タイムアタック）の設定にも入らない。 |
| 課金 | 調教の回数・伸び・素質を増やす商品は無い。伸びに効くアイテム（`affectsGrowth: true`）は**商品・コインショップ・パス（無料ラインも：パス＋がレベルを売るため）・イベント報酬・ガチャ**に入れられない（`trainingProblems` が起動時・リモート設定で拒否）。入手はデイリーミッション「調教を1回」（`train1`）だけ。伸びに効かないアイテムなら直販してよい。 |
| 遺伝 | 伸びは仔に受け継がれない（配合は基礎＋覚醒の `effectiveStats` だけを使う）。 |
| リプレイ・ゴールデン | 能力は RaceStartConfig の入力。ルールセットとエンジンは変わらないので、保存済みのリプレイ・ゴースト・ゴールデンレースはそのまま。 |

### 25.1 設定（`progression.training`、リモート設定で変更可・`trainingProblems` で検証）
| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | true | false で画面ごと隠す（`GET` は `{ "enabled": false }`） |
| `slotsPerDay` / `perHorsePerDay` | 3 / 2 | 1ゲーム日の回数（アカウント）／1頭の回数 |
| `sessionTtlMs` | 10分 | 始めたセッションを仕上げられる時間。過ぎたらミニゲームなし（点数0）で記録 |
| `potentialByRarity` | R 300 / SR 240 / SSR 180 | 素質（伸びの合計の上限） |
| `perStatCapPermille` / `softFloorPermille` | 400 / 150 | 1能力の上限（素質の割合）／伸びの遅くなり方の下限 |
| `fatigue` | max 100・1日 40 回復・80 で休養・1点 5‰・効率の下限 500‰ | 疲れ（ゲーム日ごとに自動で回復） |
| `bond` | 1レベル 10‰・上限 90‰ | 絆の上乗せ（`bondMultiplier` のメニューは倍） |
| `menus[]` | 下表 | `id`・`name`・`baseGain`（1回の伸び、整数）・`fatigue`（負は回復）・`weights`（能力の配分）・`bondMultiplier` |
| `timing` | 下記 | ミニゲーム |
| `items[]` | `training_apple`（疲れ −30、`affectsGrowth: true`） | 調教のアイテム |
| `logKeep` | 10 | 馬ごとの調教日誌の件数 |

| メニュー | 伸び | 疲れ | 伸びる能力（重み） |
|---|---|---|---|
| `hill` 坂路 | 6 | +30 | 瞬発2・根性1・スタミナ1 |
| `wood` ウッド | 6 | +25 | スピード2・スタミナ1・気性1 |
| `pool` プール | 3 | −20（回復） | スタミナ2・気性1 |
| `awase` 併せ馬 | 7 | +35 | 根性2・スピード1・瞬発1（絆 ×2） |

コード側の上限（`TRAINING_HARD_LIMITS`）：1日5回・1頭3回、`baseGain ≤ 15`、素質 ≤ 400、絆 ≤ 120‰、アイテムの疲れの回復 ≤ 50、**ミニゲームの上乗せ ≤ 150‰**（既定は 100‰ = +10%）。

**1回の伸び**（千分の1点で計算、端数は馬ごとに持ち越す `carry`）：
`milli = baseGain × (効率 + 絆 + ミニゲーム) × 伸びしろ / 1000`。効率 = max(下限, 1000 − 疲れ × 5)、絆 = min(上限×倍率, (絆Lv−1) × 10 × 倍率)、ミニゲーム = 点数 × `permillePerPoint`、伸びしろ = max(下限, 1000 × 残りの素質 / 素質)。整数部分（`carry` と合わせて）を `weights` で最大剰余法により分け（同点はセッションの seed の順）、上限に届いた能力の分は同じメニューの別の能力へ回し、それも無ければ与えない。

### 25.2 ミニゲーム（`timing`）と採点（サーバー `scoreTiming`・C# `TrainingScorer`）
既定：`beats` 5・`durationMs` 6000・`leadMs` 800・`tailMs` 200・`perfectMs` 60・`goodMs` 150・`perfectPoints` 2・`goodPoints` 1・`strayPenalty` 1・`permillePerPoint` 10・`maxTaps` 10・`minTapGapMs` 80。
- **ビート**：`beatSchedule(timing, seed)`。`leadMs`〜`durationMs − tailMs` を `beats` 等分し、各区間の先頭から区間の半分までのどこか（seed の乱数）に1つ。サーバーが開始時に返す。
- **タップ**：ミニゲームが始まってからの ms（整数、増えていく）。
- **採点**（同じ手順をクライアントも持つ。共有の検算例：ビート `[1000,2000,3000,4000,5000]`、タップ `[1010,2100,3200,4950,5000]` → ◎2 ○1 ×2・空振り2・点数3・上乗せ30‰）：ビートを順に、まだ使っていないタップのうち `goodMs` 以内で一番近いもの（同じ距離なら先のタップ）を割り当てる。`perfectMs` 以内は◎（2点）、それ以外は○（1点）。どのビートにも当たらないタップは1つにつき −1点。0〜`beats × perfectPoints` に収める。
- **評価**：点数が満点の 90% 以上 `great`（◎ 会心の追い切り）、50% 以上 `good`、それ未満とスキップ `normal`。
- **不正の防止**（`validateTaps`、違反は 422 `TRAINING_INPUT_INVALID`）：タップは `maxTaps` まで・0〜`durationMs` の整数・`minTapGapMs` 以上の間隔で増える。**サーバーの時計で開始から経った時間より後のタップは受けない**（一瞬で満点を送れない）。タップがあるのに最後のビートより前に終えた送信も受けない。上乗せは最大 +10% なので、機械で完璧に押しても伸びは1割しか増えない。

### 25.3 `GET /v1/training`（要認証）
```json
{ "enabled": true, "slotsPerDay": 3, "usedToday": 1, "slotsLeft": 2, "perHorsePerDay": 2,
  "menus": [ { "id": "hill", "name": "坂路", "baseGain": 6, "fatigue": 30, "weights": { "burst": 2, "guts": 1, "stamina": 1 }, "bondMultiplier": 1 } ],
  "timing": { "beats": 5, "durationMs": 6000, "…": "…", "maxScore": 10 },
  "fatigue": { "max": 100, "restAt": 80, "recoveryPerDay": 40 },
  "items": [ { "itemId": "training_apple", "name": "りんごのおやつ", "fatigueRelief": 30, "owned": 0 } ],
  "horses": [ { "horseId": "h1", "name": "アイボウ", "rarity": "SR", "trained": { "speed": 0, "stamina": 2, "burst": 3, "guts": 1, "temper": 0 },
    "trainedTotal": 6, "potential": 240, "perStatCap": 96, "fatigue": 30, "condition": "fresh", "bondLevel": 1, "todayCount": 1, "sessions": 1,
    "log": [ { "at": 1796871607000, "menuId": "hill", "grade": "great", "gain": 6, "score": 10 } ],
    "blocked": null, "menus": [ { "id": "hill", "blocked": null } ] } ],
  "open": null,
  "rules": { "rankedNormalized": true, "fatigueAffectsRaces": false, "inherited": false, "paidBoosts": false } }
```
- `horses` は現役の馬だけ。`blocked`（馬）・`menus[].blocked`（メニュー）：`null` / `no_slots` / `horse_daily_limit` / `potential_full` / `tired`（疲れを足すメニューだけ）/ `retired`。`condition`：`fresh`（疲れ < 40）/ `normal` / `tired`（≥ `restAt`）。
- `open`：仕上げていないセッション（`sessionId`・`horseId`・`menuId`・`startedAt`・`expiresAt`・`beats`・`durationMs`）。期限を過ぎたものはこの GET で**ミニゲームなしとして記録**される（その時だけ取引で書き込む。普段は読み取りだけ）。
- `rules` は画面に「ランク戦はクラスの上限にそろえる」「疲れはレースに影響しない」と書くための値（いつも上の値）。
- プレイヤー（`GET /v1/player` などの `horses[]`）にも `trained` が載る（無ければ伸びなし）。

### 25.4 `POST /v1/training/start`・`POST /v1/training/:sessionId/finish`・`POST /v1/training/items/:itemId/use`（要認証・`Idempotency-Key` 必須）
- 3つとも応答の `training` は**差分**（`partial: true`）：`enabled`・`slotsPerDay`・`usedToday`・`slotsLeft`・`perHorsePerDay`・`items`・`open` と、対象の馬1頭だけの `horses`（`log` は含まない）。`menus`・`timing`・`fatigue`・`rules` は含まない。クライアントは手元の §25.3 に重ねる（C# `TrainingView.MergeInto`：その馬を差し替え、回数が0なら他の馬も `no_slots`）。応答はプレイヤーの状態に冪等の記録として残るので小さくしている。
- **start** `{ "horseId", "menuId" }`（他のキーは 400）→ `{ "session": { … §25.3 の open の形 }, "preview": { "min", "max", "minMilli", "maxMilli" }, "slotsLeft", "training": 差分 }`。ここで**回数を1つ使い、メニューの疲れを足す**（伸びは finish で、開始時の状態から決める）。`preview` はミニゲームなし／満点の時の伸び（整数部分と千分の1点）。開いたままの前のセッションがあれば、先にミニゲームなしで記録する（アプリが落ちても止まらない）。エラー：`TRAINING_LIMIT`（`no_slots` / `horse_daily_limit`）、`TRAINING_TIRED`、`TRAINING_POTENTIAL_FULL`、`HORSE_NOT_ACTIVE`、`NOT_FOUND`（メニュー・馬・調教が無効）、`DELETION_PENDING`（削除の実行中）。
- **finish** `{ "taps": [int…], "skipped"?: true }`（`skipped` なら `taps` は無視して点数0）→
  `{ "sessionId", "horseId", "menuId", "grade", "timing": { "perfect", "good", "miss", "stray", "score", "bonusPermille" }, "gain": {5能力}, "total", "capped",
     "breakdown": { "efficiencyPermille", "bondPermille", "timingPermille", "softPermille" }, "trained", "trainedTotal", "potential", "fatigue", "settled": "done" | "skipped" | "expired", "void": false, "training": 差分 }`。
  エラー：422 `TRAINING_INPUT_INVALID`（§25.2）、`TRAINING_SESSION_EXPIRED`（期限切れ。次の調教の呼び出しでミニゲームなしとして記録）、`TRAINING_SESSION_USED`（その id の開いたセッションが無い）。再送は同じキーで同じ結果。
- **items/:itemId/use** `{ "horseId" }` → `{ "itemId", "horseId", "fatigueBefore", "fatigue", "remaining", "training": 差分 }`。疲れが0なら `NOT_ELIGIBLE`、持っていなければ `INSUFFICIENT_ITEMS`。
- デイリーミッションの種類 `training`（`train1`：調教を1回 → `training_apple` ×1）は finish（期限切れの記録も含む）で進む。

### 25.5 KPI（サーバーのイベント）
| イベント | s1 | s2 | s3 | 数値 |
|---|---|---|---|---|
| `training_start` | メニュー | 馬のレア度 | — | `value` 開始時の疲れ、`count` 今日の回数 |
| `training_done` | メニュー | 評価 `great`/`good`/`normal` | `done`/`skipped`/`expired` | `value` 伸びの合計、`count` 点数、`isFirst` そのアカウントの初回 |
クエリは `docs/ops/kpi-queries.md`「調教」。

### 25.6 クライアント（`TrainingModel`）
- タップは `BeginMiniGame(now)` からの ms で、サーバーが受け付ける形（間隔・回数・範囲）のものだけを記録する。画面の◎○×は `TrainingScorer.Judge`、合計は `TrainingScorer.Score`（サーバーと同じ）。
- start / finish は応答が来るまで同じ冪等キーを使う（タイムアウト後の再送で回数を2回使わない）。読み込んだ時に開いたセッションがあれば、ミニゲームなしで仕上げる（時間が経っているため）。
- 画面に `TrainingModel.RulesText`（ランク戦は上限にそろえる・疲れはレースに影響しない・伸びは受け継がれない）を出す。調教の画面からショップへの導線は作らない。

## 26. プレゼントボックス（REQ-BOX-001〜014、`server/src/domain/giftBox.ts`、C# `GiftBox.cs`・`Muchi.Game.GiftBoxModel`）
その場で受け取る画面が無い**無料の**報酬（運営の補填・配布、招待ボーナス、イベント・大会・支部・リーグ・シーズンの報酬）は、財布に直接入れず**プレゼントボックス**に届く。プレイヤーは好きな時に「受け取る」「まとめて受け取る」で財布・持ち物に移す。ボックスは**届け方を変えるだけで額は変えない**（経済 E1〜E15 は同じ範囲、balance-targets 4.13）。

**入れられるもの**：無償コイン・アイテム（券を含む）だけ。**有償コインは決して入らない**（資金決済法：有償は期限で消えない・無料で配らない）。報酬に馬・繁殖牝馬・パス経験値が付いている場合は、その部分だけこれまでどおりその場で付与し、コインとアイテムをボックスへ入れる。

### 26.1 どの報酬がボックスに届くか（決定事項）
| 出どころ（`source`） | これまで | これから | 理由 |
|---|---|---|---|
| 運営の補填 `ops_compensation`（`POST /v1/admin/compensations`、2人承認を含む） | 即時に財布へ | **ボックス**（期限 90日） | 本人が見ていない時に届く。お知らせの通知（§26.6） |
| 運営の個別・一括配布 `ops_grant`（`/v1/admin/players/:id/grants`・`/v1/admin/grants/bulk`） | 即時に財布へ | **ボックス**（期限 30日） | 同上 |
| 招待ボーナス（招待した側）`invite` | マイルストーンの配達時に財布へ | **ボックス** | 招待された人の進み具合で、招待した人の知らない時に届く |
| イベントの順位報酬 `event`（イベント終了の処理） | 財布へ | **ボックス** | 終了後のバッチで届く |
| 大会の賞品 `tournament` | 財布へ | **ボックス** | 同上 |
| 支部のシーズン報酬 `team`・支部対抗リーグ `league` | 財布へ | **ボックス** | 月替わりのバッチで届く |
| シーズン（クラス順位）の報酬 `season` | 財布へ | **ボックス** | 同上 |
| 支部の共同目標の週の報酬 `team_goal`（§32、Round 13 の統合で決定） | — | **ボックス** | 週の締めに支部のオブジェクトが裏で払う（本人がその場にいない）。週の結果シートは結果を見せるだけで受け取りの画面ではない |
| イベント交換所の残りポイントの変換 `exchange`（§30、Round 13 の統合で決定） | — | **ボックス**（配合素材） | 交換所が閉じた後の最初の取引で裏で変換される。交換所の画面には「変換した」と出すが、閉じた交換所を開かない人もいるのでボックスで知らせる |
| 週替わりチャレンジのクリア報酬（§31、Round 13 の統合で決定） | — | **そのまま（直接）** | 結果画面（`POST /v1/challenges/weekly/submit` の `reward`）がその場の受け取りの画面 |
| イベント交換所での交換（§30） | — | **そのまま（直接）** | 交換の確認・結果がその場の画面（本人の操作） |
| シーズンパスの受け取り忘れの自動付与（シーズン終了時） | 財布へ | **そのまま（直接）** | パスの返金の取り消し（REQ-PUR-006）と購入に結び付く無償コインの扱い（REQ-UXS-018/021）が財布の付与に結び付いているため。パス画面の「シーズン終了時に自動で受け取り」の記録（`passHistory`）で見える |
| 招待された側の歓迎ギフト | コード入力の画面で付与 | **そのまま** | その場の画面がある |
| ライバルの週の結果（§28、Round 12 の統合で決定） | — | **そのまま（直接）** | 週の結果シート（`GET /v1/rival` の `result`）がその場の受け取り画面。精算は本人がライバルの画面を開いた時（またはオプトアウトの前）だけ行い、台帳の参照は `rival:<weekId>` |
| ログインボーナス・デイリー/初心者/シーズンミッション・パスの受け取り・実績・絆・復帰キャンペーン・広告・イベントのポイント報酬・タイムアタック | 各画面で受け取り | **そのまま** | その場で受け取る画面がある（実績は自動付与ではなく受け取り式） |
| 購入（有償コイン・おまけ・デイリーパック）・種付け料 | — | **そのまま** | 報酬ではない（購入・売上）。有償コインは入らない |

`progression.giftBox` が無い（または `enabled: false`）時は、すべて従来どおり直接付与する。

### 26.2 設定（`progression.giftBox`、リモート設定で変更可・`giftBoxProblems` で検証）
| キー | 既定 | 意味（コード上の範囲） |
|---|---|---|
| `enabled` | true | false で従来どおりの直接付与（届いている分は受け取れる） |
| `expiryDays.default` | 30 | 期限（日、7〜180） |
| `expiryDays.bySource` | `{ "ops_compensation": 90 }` | 出どころごとの期限（7〜365、`null` = 期限なし）。補填は `default` より短くできない |
| `maxUnclaimed` | 500 | 未受け取りの上限（50〜1000、§26.5） |
| `historyDays` / `historyKeep` | 90 / 300 | 履歴に残す日数（30〜180）／件数（50〜1000） |
| `holdCaps` | `{ "freeCoins": 9999999, "itemQty": 9999 }` | 持てる上限（無償コインの残高、アイテム1種類の個数）。超える受け取りは保留（§26.4） |
| `expiringSoonDays` | 3 | 「期限が近い」の数え方（1〜7） |
| `pushSources` | `["ops_compensation"]` | 届いた時に通知する出どころ（テンプレート `gift_arrived`、§26.6） |

運営の配布では、`titleKey`（下の表のうち `ops_*`）と `expiryDays`（1〜365 または `null` = 期限なし）を指定できる（省略時は上の既定）。

| `titleKey` | 表示（日本語／英語） |
|---|---|
| `ops_compensation` | お詫びの品 / An apology gift |
| `ops_compensation_maintenance` | メンテナンスのお詫び / Apology for the maintenance |
| `ops_compensation_bug` | 不具合のお詫び / Apology for a bug |
| `ops_grant` | 運営からの贈り物 / A gift from the team |
| `invite` | 招待ボーナス / Invite reward |
| `event` | イベントの順位報酬 / Event ranking reward |
| `tournament` | 大会の賞品 / Tournament prize |
| `team` | 支部のシーズン報酬 / Branch season reward |
| `league` | 支部対抗シーズンの報酬 / Branch league reward |
| `season` | シーズンの報酬 / Season reward |
| `team_goal` | 支部の共同目標の報酬 / Branch weekly goal reward |
| `exchange` | イベント交換所の残りポイント / Event exchange: leftover points |

### 26.3 `GET /v1/gift-box?tab=box|history&offset=0&limit=50`（要認証）
```json
{ "enabled": true, "tab": "box", "badge": { "unclaimed": 2, "expiringSoon": 1 }, "maxUnclaimed": 500,
  "total": 2, "offset": 0, "limit": 50, "nextOffset": null,
  "rules": { "defaultExpiryDays": 30, "historyDays": 90, "paidCoins": false },
  "entries": [ { "giftId": "gift_3", "source": "ops_compensation", "titleKey": "ops_compensation_maintenance", "title": "メンテナンスのお詫び",
    "rank": null, "contents": { "freeCoins": 300, "items": [ { "itemId": "gacha_ticket", "name": "スカウト券", "qty": 1 } ] },
    "lines": ["無償コイン300枚", "スカウト券×1"], "createdAt": 1796871607000, "expiresAt": 1804647607000,
    "status": "unclaimed", "doneAt": null, "how": null, "held": null } ] }
```
- `tab=box`：未受け取り。期限の近い順（期限なしは最後）、同じなら新しい順。`tab=history`：受け取り済み・期限切れ（直近 `historyDays` 日、新しい順）。`limit` 1〜100。
- `status`：`unclaimed` / `claimed` / `expired`。`doneAt`：受け取り・期限切れの時刻。`how`：`one` / `all` / `overflow`（§26.5）。`held`：直前の受け取りで保留になった理由（`{ "reason": "item_cap" | "coin_cap", "itemId" }`）。
- 期限の表示（「あと3日」）は `expiresAt` から出す。`expiresAt: null` は期限なし（表示しない）。**実際の期限が無いものに期限の表示を付けない**。
- 期限切れは読んだ時に処理する（その時だけ取引で書き込む。普段は読み取りだけ）。プレイヤーの Durable Object のアラームも一番早い期限で起きて処理する。
- `GET /v1/player`・`POST /v1/player/bootstrap` に `giftBox: { "unclaimed": n, "expiringSoon": n }`（ホームの封筒のバッジ。期限の過ぎたものは数えない）。

### 26.4 `POST /v1/gift-box/:giftId/claim`・`POST /v1/gift-box/claim-all`（要認証・`Idempotency-Key` 必須）
- 応答 `{ "claimed": [ { "giftId", "source", "freeCoins", "items" } ], "held": [ { "giftId", "reason", "itemId" } ], "totals": { "freeCoins", "items": { "gacha_ticket": 1 } }, "badge": {…}, "wallet": {…}, "items": { 変わったアイテムの今の数 } }`。
- 1つの取引で、1件ずつ丸ごと受け取る（1件の中を分けない）。**まとめて受け取る**は期限の近い順。持てる上限（`holdCaps`）を超える1件はボックスに残り `held` に理由が載る（他は受け取る）。
- 1件の受け取りで上限を超える時は `GIFT_HOLD_CAP`（409）。受け取り済みは `ALREADY_CLAIMED`、期限切れは `GIFT_EXPIRED`、無い id は `NOT_FOUND`、削除の予約中は `DELETION_PENDING`（受け取りは止める。届いた分はアカウントの削除で消える）。同じキーの再送は同じ結果。
- 台帳：無償コインは `gift <source>: <title>`・参照 `gift:<giftId>` で付与（ボックスに届いた時点では財布は変わらない）。アイテムは持ち物に足す（返金による負債があれば先に相殺）。

### 26.5 上限（`maxUnclaimed`）を超えた時（決定事項）
- 未受け取りが `maxUnclaimed` 件の時に新しいものが届いたら、**補填以外で一番期限の近いもの**を自動で受け取る（財布・持ち物へ移し、履歴に `how: "overflow"`）。何も消さない。
- 自動で受け取れるもの（補填以外で持てる上限に収まるもの）が無い時は、そのまま上限を超えて入れる（補填は**決して捨てない**、黙って消すことはしない）。サポート用の印 `gift_box_over_cap` を付ける。

### 26.6 削除・通知・KPI
- アカウントの削除：削除の実行（`deleting`）に入ったら新しく届けない（`ops` の配布は `DELETION_IN_PROGRESS`）。消去の時にボックスも一緒に消え、未受け取りの件数を削除の記録の `forfeited.gifts` に残す。消去済み（トゥームストーン）の id への運営の配布は `NOT_FOUND`（新しいプレイヤーを作らない）。大会・イベント・シーズンなどの配達は今までどおり何もしない。
- 通知：`pushSources` の出どころ（既定は補填だけ）が届いたら `gift_arrived`（カテゴリ `gifts`、既定オン）を送る。1日の上限・静かな時間帯はほかの通知と同じ。
- KPI（サーバー）：`gift_receive`（s1 出どころ、s2 `titleKey`、`freeCoins`、`count` アイテムの数、`value` 期限の日数（なしは0））、`gift_claim`（s1 出どころ、s2 `one`/`all`/`overflow`、`freeCoins`、`count`、`value` 届いてから受け取るまでの時間（時間））、`gift_expire`（s1 出どころ、`freeCoins`、`count`）。クエリは `docs/ops/kpi-queries.md`「プレゼントボックス」。

### 26.7 運用コンソール
- `GET /v1/admin/players/:playerId` の `state.giftBox`：未受け取り（全件）と直近の履歴（50件）、件数。
- 配布・補填のフォームでボックスに入れる（`titleKey`・`expiryDays` を選べる）。2人承認の閾値・24時間の1人あたりの上限（REQ-OPS-026）はこれまでどおり（ボックスに入れる時点で数える）。

## 27. かんたん操作（easy controls、REQ-ASSIST-001〜012、`server/src/domain/assist.ts`、C# `InputAssist.cs`（`InputAssistant`・`AssistLevels`）・`Assist.cs`・`Muchi.Game.AssistModel`）
操作が苦手なプレイヤー向けの任意の補助（docs/planning/06 REQ-UXU-030、P2）。**補助はクライアントの中だけで動き、プレイヤーが送るのと同じ入力バイト（§3 の Cmd）を作るだけ**。エンジン・ルールセット・検証器・結果ハッシュ・リプレイの形式は変わらない（ゴールデンも同じ）。

| レベル | 線の値 | 何をするか | プレイヤーの操作 |
|---|---|---|---|
| オフ（既定） | `off` | 何もしない | 全部自分 |
| ムチだけおまかせ | `whip` | 最後の直線でムチを間隔をあけて打つ | スタート・手綱・進路は自分。発走後の自分のムチは無視（無駄打ちを防ぐ） |
| ぜんぶおまかせ | `full` | スタート（ゲートが開いて2tick後）・スタミナを見た手綱・遅い馬の後ろから外へ出す進路・ムチ | 無視（補助と取り合わない） |

### 27.1 決定論と入力の経路（REQ-ASSIST-002）
- `InputAssistant.Decide(sim)` はクライアントが持っているレースの状態（`RaceSim`）だけを読む。乱数・時計は使わない。1tickに1回だけ決める（毎フレーム呼んでよい）。
- オフライン（`OfflineRace.Assistant`）：補助のコマンドはプレイヤーの入力と合わせてから記録される＝ `RecordedInputs` に普通の入力として残る（タイムアタックはそのまま送れる。サーバーは今までどおり再シミュレーションで確かめる）。
- オンライン（`RaceSession.Assistant`）：確定した tick が進むたびに補助のコマンドを普通の `in`（§4）で送る。部屋は入力遅延を足すので、指で押した時と同じく少し遅れて効く。補助は送った手綱の向き・最後のムチの tick を自分で覚え、届く前の自分のコマンドを状態から読み直さない。送った手綱が40tick（`ResyncTicks`）たっても馬に表れない時だけ（切断で `in` が失われた時）もう一度送る。
- 補助の作り方（定数、`InputAssistant`）：スタート `StartReactionTicks` 2、ムチの間隔 = max(`whipEffectTicks`, `whipDiminishWindowTicks`) + 6 tick、残りのムチが最後に打ち終わる地点より 60m 手前から（スパート区間の中だけ）、手綱は「スタミナ‰ − 180 < 残り距離‰」または折り合いが悪い・掛かっている時（スパート区間では引かない）、進路は8tickごとに前の遅い馬（スパート区間では前の馬すべて）を外→内の順でかわす。風よけは探さない。値を変えたら R11（balance-targets §2.3）を測り直す。

### 27.2 公平性の決まり（REQ-ASSIST-005〜007）
| 項目 | 決めたこと |
|---|---|
| ランク戦 | **使ってよい**。補助は上手な手動操作より弱く作り、テストで確かめる（R11：勝率比 < 1.0、同じ能力の一騎打ちで上手い人に勝つのは5割未満、何もしない人よりはっきり上）。課金で買えるものではない。 |
| 印 | 乗り手が自分の `res` に `assist: "whip" \| "full"`（任意）を付ける。部屋は**その乗り手の分だけ**覚え（`FinalOutcome.assisted`）、精算で `RaceDetails.assist` に入れ、KPI `race_assisted` にだけ使う。`final` やスペクテーター・相手に送るメッセージ、リプレイのログには入らない（相手には見せない）。自己申告だが報酬・着順・レートには一切効かないので検証は要らない。 |
| チュートリアル | **使わない**。`AssistLevels.AllowedIn(Tutorial)` は false で、`OfflineRace` も `RaceSession` もチュートリアルでは補助を無視する。REQ-UXS-004（2発以上で勝ち・0〜1発は僅差の2着・3回目から勝ち）は補助オフの前提のまま。設定に出すのは FTUE が終わってから、提案はオンラインのレースの結果からだけ出る（＝最初の勝利の後）。 |
| タイムアタック・フレンド・イベント・大会 | 使ってよい（同じ入力の経路なので記録・検証は変わらない）。 |

### 27.3 `GET /v1/player/assist`・`PUT /v1/player/assist`・`POST /v1/player/assist/prompt-seen`（要認証）
```json
{ "level": "off", "promptDue": false, "lastPlaceStreak": 0, "promptShown": false, "levels": ["off", "whip", "full"],
  "rules": { "ranked": "allowed", "cappedBelowSkilled": true, "shownToOpponents": false, "tutorial": "off" } }
```
- `GET /v1/player`（bootstrap も）にも同じ形で `assist` が入る。読み取りは状態を作らない。
- **PUT** `{ "level": "off" | "whip" | "full", "source"?: "settings" | "prompt" }`（他のキーは 400、`source` の既定は `settings`）→ 上の形。同じレベルを送り直しても何も変わらない（冪等キー不要）。`source: "prompt"` は提案シートが出たことも記録する。
- **prompt-seen** → 上の形。提案が出る条件を満たしている時だけ1回記録する（条件の前に呼んでも何も起きない＝早く呼んで提案を消すことはできない）。
- 端末はオフラインの間、最後に選んだレベルを端末に残し、オフラインのレースに使う（`AssistModel.KeyLevel`）。

### 27.4 一度だけの提案（REQ-ASSIST-010）
- 部屋で精算されたレース（ランク戦・フレンド・イベント・大会。無効・チュートリアル・タイムアタック・1頭立ては数えない）で**最下位（`place == fieldSize`）が3回続いたら** `promptDue = true`。最下位以外で連続は0に戻る。`applyRace` のレースごとの重複防止に乗るので、精算の再送で二重に数えない。
- 補助がオンの時・アカウント削除の手続き中は出さない。出したら（`prompt-seen` か `source: "prompt"` の PUT）二度と出さない。
- 画面：結果画面からホームへ戻る時のシート。急かさない（タイマー・「今だけ」・強調色の押し付けなし）。「ムチだけおまかせ」「ぜんぶおまかせ」「今はいい」を同じ大きさで並べ、「いつでも設定で戻せます」と公平性の一文を出す。

### 27.5 KPI
| イベント | 送り手 | s1 | s2 | s3 | 数値 |
|---|---|---|---|---|---|
| `assist_enable` | サーバー（PUT でオンにした・レベルを変えた） | `whip`/`full` | `settings`/`prompt` | 前のレベル | `value` その時の最下位の連続、`isFirst` 初めてオンにした |
| `assist_disable` | サーバー（PUT でオフにした） | 前のレベル | `settings`/`prompt` | | |
| `assist_prompt_view` | サーバー（提案シートが出た、1回だけ） | | | | `value` 最下位の連続 |
| `race_assisted` | サーバー（補助ありで精算されたレース） | `whip`/`full` | モード | | `double4` 着順、`double5` 頭数 |
| `client_race_start` | クライアント（既存） | モード | 補助のレベル（オフは空） | | |
クエリは `docs/ops/kpi-queries.md`「かんたん操作」。

### 27.6 クライアント
- `Muchi.Client`：`InputAssistant`（`Decide`・`Apply`・`FilterPlayer`）、`AssistLevel`・`AssistLevels`（`Wire`・`Parse`・`AllowedIn`・`HudLabel`）、`OfflineRace.Assistant`／`EffectiveAssist`、`RaceSession.Assistant`／`EffectiveAssist`、`LockstepClient.AssistLevel`（`res.assist`）、`ApiClient.GetAssistAsync`・`SetAssistAsync`・`MarkAssistPromptSeenAsync`、`PlayerView.Assist`、`Analytics.RaceStart(at, mode, assist)`。
- `Muchi.Game`：`AssistModel`（3つの選択肢と説明、`ShouldShowPrompt(inFtue)`、`Prompt()`、`SetAsync`、`MarkPromptShownAsync`、`Attach(driver, level)`、`RidingLevel`）、`GameBackend.AssistLevel`（練習・ランク戦の作成時に付ける。チュートリアルには付けない）、`HudSnapshot.Assist`／`AssistLabel`（「かんたん操作 ON」）／`WhipAuto`／`SteeringAuto`。

## 28. ライバル（週ごとのライバル、REQ-RIVAL-001〜016、`server/src/domain/rival.ts`・`rivalService.ts`・`server/src/do/rivalStore.ts`、C# `Rival.cs`・`Muchi.Game.RivalModel`）
毎週ひとり、同じクラスでレーティングの近いライバルが決まる。同じランク戦で走れば直接対決、タイムアタックでは今週のベストを比べる。週の終わりに結果と小さな固定の報酬。

**決めたこと**
| 項目 | 決めたこと |
|---|---|
| 週 | ゲーム日（§15、`progression.dayRollover`、既定 4:00 JST）で数えて **`weekStartsOn`（既定 1 = 月曜）から7ゲーム日**。週ID = その週の最初のゲーム日（`"2026-12-07"`）。週の終わり = 次の週の最初のゲーム日の切り替え（`weekEndMs`）。 |
| 誰と組むか | **先週ランク戦を走った人**（週 W にランク戦を1回でも確定させた人が、W+1 の候補として週 W の登録簿に載る）。同じクラス・レーティング差 `maxRatingGap`（200）以内・お互いにブロックしていない・オプトアウト／BAN／削除予定でない・隔離中（REQ-OPS-032）でない。登録はトランザクションの後に送り、届かなかった時は次の `GET /v1/rival` で送り直す（最新が勝つ）。 |
| 決定論 | `pairWeek(config, weekId, 候補)`：クラスごとに「レーティング＋（週IDとプレイヤーIDの FNV-1a から決まる ±`jitter`）」の降順（同点はプレイヤーID）に並べ、上から順に、まだ組んでいない人を `pairWindow`（3）人先まで見て最初に条件を満たす人と組む。**入力の順番に依らず、同じ週・同じ候補なら同じ組み合わせ**（再現できる）。 |
| CPU のライバル | 組めなかった人（奇数の余り・候補がいない・差が大きい・週の途中から来た人）は `cpuRivals` から「週ID＋プレイヤーID」のハッシュで決まる名前と性格のある CPU（堅実のアサギ・強気のクレナイ・気まぐれのヒスイ・粘りのコガネ）。その週の間は同じ CPU。 |
| どこに置くか | 週ごとの登録簿 = **LeaderboardDO のインスタンス `rival:<weekId>`**（専用の `rv_*` テーブル。DO クラスとマイグレーションは増やさない）。週 W の登録簿は「W の組み合わせ（初回の問い合わせか cron で、W−1 の登録簿の候補を読んで1回だけ作る）」「W+1 の候補」「W の両者のタイムアタックのベスト」を持つ。プレイヤーの DO は自分の集計を自分で持ち、登録簿とは**常に一致していることを前提にしない**（登録簿が落ちても画面は手元の値で出る）。 |
| 直接対決 | **確定したランク戦**（精算と同じ信頼のルール：合意か検証サービス、無効のレースは数えない）で、2人とも走っていれば**先着した方に1点**。レースは**結果を受け取った時の週**に数える（精算は終わってから数秒なので、週の切り替えの瞬間をまたぐレースだけは2人の週がずれることがある）。確定結果に全員の着順（`field`）が入り、2人の DO が同じ結果を受け取るので、点数は互いに話さなくても一致する。CPU のライバルとは**全てのランク戦**で：自分が `targetPlace`（性格ごと、既定 5〜7）以内なら自分に、それ以外は CPU に1点。 |
| タイムアタック | 今週の各コースの自分のベスト（検証済みの記録だけ）を登録簿に送り、ライバルのものと並べる。**直接対決が同点の時だけ**、相手より速いコースの数で勝敗を決める（それも同点なら引き分け）。CPU のタイムは性格のメダル（銅・銀・金）の秒数。 |
| ライバルと走る | **ランク戦のマッチングは変えない**（同じ部屋に入りやすくすると、待ち時間・公平性の目標を崩し、2人で示し合わせた勝ち負けの譲り合いでレーティングを動かせるため）。代わりに**フレンド部屋への挑戦状**：自分の部屋にライバルを招く（フレンドでなくてよい、1日 `challengesPerDay` 回まで）。**順位は表示するが点にはならない**（レーティング・報酬はフレンド戦の通常のルールのまま）。 |
| 報酬 | （財布へ直接。プレゼントボックスには入れない：精算は本人がライバルの画面を開いた時で、週の結果シートがその場の受け取り画面、§26.1）週の結果で決まる**固定の無償コイン**（勝ち 20・引き分け 10・負け 10・解除 10）。週の自分のランク戦が `minRacesForResult`（3）未満なら報酬なし（`not_enough`）。乱数なし・連勝の上乗せなし・有償コインは出さない。1回 ≤ `RIVAL_HARD_LIMITS.freeCoinsPerWeek` 100（¥160 相当、¥200 未満）。 |
| 称号 | `titles.json` の条件 `rivalWeeksWon`（勝った週の**通算**、連続ではない）：1週「好敵手」・5週「宿命の対決」・20週「ライバルキラー」。見た目だけ。 |
| プライバシー | ライバルに見えるのは**公開カード**だけ（表示名・称号・クラス・勝負服・相棒の馬の名前/レア度/脚質/見た目＝公開プロフィールの写し＋相棒）。ブロック（支部フィードのミュートと同じ1つのブロック一覧）・オプトアウト・BAN・削除予定の人は組まれず、今週の組は**両方とも解除**（`no_contest`、カードは消える）。 |

### 28.1 設定（`progression.rival`、リモート設定で変更可・`rivalProblems` で検証）
| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | true | false で `GET /v1/rival` は `{ "enabled": false }` |
| `weekStartsOn` | 1 | 週の始まりの曜日（0 = 日曜） |
| `maxRatingGap` / `jitter` / `pairWindow` | 200 / 40 / 3 | 組み合わせ（上記） |
| `minRacesForResult` | 3 | 結果の報酬に要る自分のランク戦の数 |
| `rewards` | win 20 / draw 10 / lose 10 / no_contest 10 | `{ freeCoins }` だけ（他のキーは拒否） |
| `challengesPerDay` | 3 | 挑戦状の1日の回数 |
| `recentKeep` | 10 | 「最近のレース」に残す数 |
| `cpuRivals[]` | 4人 | `id`・`name`・`personality`・`line`（ひとこと）・`style`・`targetPlace`・`taMedal` |
コード側の上限（`RIVAL_HARD_LIMITS`）：報酬 ≤ 100、`challengesPerDay` ≤ 10、`maxRatingGap` ≤ 600、`jitter` ≤ 200、`pairWindow` ≤ 8、`recentKeep` ≤ 30、CPU ≤ 20 人。報酬の順は **勝ち ≥ 引き分け ≥ 負け**、解除 ≤ 引き分け（組を解除しても得をしない）。

### 28.2 `GET /v1/rival`（要認証）
サーバーが未精算の週（今週と、終わったがまだ精算していない週）ごとに登録簿へ問い合わせ、プレイヤーの DO で反映・精算してから返す（その日最初の表示で KPI `rival_view`）。
```json
{ "enabled": true, "optOut": false, "weekId": "2026-12-14", "weekEndsAt": 1797447600000,
  "rival": { "kind": "human", "playerId": "u_123", "dissolved": false,
    "card": { "displayName": "ハヤテ乗り", "titleId": "first_win", "classId": "B", "silks": { "…": "…" },
      "partner": { "name": "ハヤテ", "rarity": "SR", "style": "senko", "appearance": { "…": "…" } } } },
  "score": { "me": 2, "them": 1, "rankedRaces": 7, "minRaces": 3, "taMe": 1, "taThem": 0 },
  "recent": [ { "raceId": "r_…", "at": 1797…, "mode": "ranked", "me": 2, "them": 5, "point": "me" } ],
  "timeAttack": [ { "trackId": "aoba_turf_1600", "trackName": "青葉競馬場 芝1600m", "me": 70210, "rival": 71004, "faster": "me" } ],
  "result": null,
  "history": [ { "weekId": "2026-12-07", "outcome": "win", "kind": "cpu", "rivalName": null, "cpuId": "cpu_asagi", "cpuName": "堅実のアサギ", "me": 5, "them": 3, "taMe": 0, "taThem": 0, "freeCoins": 20, "settledAt": 1797…, "newTitles": ["rival_first"] } ],
  "record": { "weeksWon": 1, "weeksPlayed": 1, "titles": [ { "titleId": "rival_first", "name": "好敵手", "weeksWon": 1, "unlocked": true } ], "nextTitle": { "titleId": "rival_5", "…": "…" } },
  "rewards": { "win": 20, "draw": 10, "lose": 10, "noContest": 10, "minRaces": 3 },
  "challenge": { "left": 3, "perDay": 3 },
  "rules": { "rankedOnly": true, "challengeUnranked": true, "fixedRewards": true, "noStreakRewards": true, "taBreaksTies": true } }
```
- `rival`：`{ kind: "human", playerId, card, dissolved }`（解除後は `playerId`・`card` が `null`）／`{ kind: "cpu", cpuId, name, personality, line, style, targetPlace, taMedal }`／`null`（オプトアウト）。
- `recent`：今週の新しい順。`mode: "friend"` は挑戦状のレース（`point: null`、点にならない）。CPU の時 `them` は `null`。
- `result` / `history[]` の名前：人間の週は `rivalName`（相手が付けた表示名、英語でも**翻訳しない**：`PLAYER_TEXT_KEYS`）、CPU の週は `cpuName`（設定の名前、英語では英語）。
- `result`：まだ見ていない週の結果（週の結果シート）。`outcome`：`win` / `lose` / `draw` / `no_contest`（解除）/ `not_enough`（ランク戦が足りない、報酬0）。`freeCoins` は実際に付与した額。
- 登録簿が答えない時は、その週は手元の値で返す（精算はしない＝次の表示で）。

### 28.3 `PUT /v1/rival/settings`・`POST /v1/rival/block`・`POST /v1/rival/challenge`・`POST /v1/rival/results/:weekId/seen`（要認証）
- **settings** `{ "optOut": boolean }`（他のキーは 400）→ `{ "optOut" }`。オプトアウトの前に終わった週を精算する（報酬は払う）。オプトアウトで今週の組は両方とも解除、今週の記録は結果なしで捨てる、来週から組まれない。戻すと次の週の候補から（今週は解除のまま）。
- **block** → `{ "blocked": "<playerId>", "dissolved": true }`。今週の人間のライバルをブロック一覧（支部フィードのミュートと同じ、`PUT /v1/teams/me/feed/mutes` でも見える）に入れ、組を解除。人間のライバルがいなければ `NOT_ELIGIBLE`。
- **challenge** `{ "passphrase" }`（`Idempotency-Key` 必須、Round 13 で追加：同じキーの再送は同じ答えを返し、1日の回数を使わず、招待とプッシュも送り直さない）→ `{ "ok": true, "rivalId" }`。自分がその部屋のメンバー（でなければ `NOT_ELIGIBLE`）、今週の解除されていない人間のライバルがいる、1日の回数内（超えたら 409 `RIVAL_CHALLENGE_LIMIT`）。相手の招待一覧（`GET /v1/friends` の `invites`）に入り、`room_invite` のプッシュ（上限・設定の中）。相手が自分をブロックしていれば `NOT_ELIGIBLE`。
- **results/:weekId/seen** → `{ "unseen": null }`（結果シートを閉じた）。

### 28.4 プッシュ「ライバルが記録を更新」（`rival_record`、種類 `friends`）
ライバルが今週のタイムアタックで、**自分の今週のベストより前にいたコースで自分を上回った**時に1回（組・コース・週ごとに1回、登録簿が覚える）。受け取る側では**1ゲーム日に1回まで**、さらにプッシュの1日の上限（`dailyCap`）・静かな時間帯・種類の設定の中で送る。

### 28.5 KPI（サーバーのイベント）
| イベント | s1 | s2 | s3 | 数値 |
|---|---|---|---|---|
| `rival_view` | `human` / `cpu` / `none` | — | — | `count` 自分の点、`value` 相手の点（1ゲーム日に1回） |
| `rival_race` | `human` / `cpu` / `challenge` | 点を取った側 `me` / `them` | — | `place` 自分の着順、`value` 相手の着順（CPU は目標の着順） |
| `rival_week_result` | `win` / `lose` / `draw` / `no_contest` / `not_enough` | `human` / `cpu` | 週ID | `count` 自分の点、`value` 相手の点、`freeCoins` 報酬、`place` 週のランク戦の数 |
| `rival_opt` | `out` / `in` | — | — | — |
クエリは `docs/ops/kpi-queries.md`「ライバル」。

### 28.6 クライアント（`Muchi.Client` `Rival.cs`、`Muchi.Game.RivalModel`）
- `ApiClient.GetRivalAsync`・`SetRivalOptOutAsync`・`BlockRivalAsync`・`ChallengeRivalAsync`・`MarkRivalResultSeenAsync`。
- `RivalModel`：ホームのライバルカード（名前・クラス・相棒・今週の点・残り日数）、詳細（今週の点・最近のレース・タイムアタックの比較）、週の結果シート（`result` があれば一度だけ、閉じたら seen）、オプトアウト・ブロック、挑戦状（フレンド部屋を作ってから）。文言に「ランク戦の点」「挑戦状は点にならない」「報酬は結果で決まる固定の額」を出す。ショップへの導線は作らない。

## 29. コイン不足の案内（T6、REQ-SHORT-001〜010、`server/src/domain/shortfall.ts`、C# `Shortfall.cs`・`Muchi.Game.CoinShortfallModel`、docs/planning/06 §5.1 T6）
ガチャ・見た目の直販・その他コインで払う操作が**コイン不足**で失敗した時（または失敗する前の確認画面で）、「何コインが・何枚足りないか」と「それを満たす一番小さいパック1つだけ」をサーバーが返す。クライアントは文言を組み立てない（§13 と同じ）。

### 29.1 足りないコインの種類（`coinKind`）
| `coinKind` | どこで | 数えるコイン |
|---|---|---|
| `any` | 通常のガチャ・見た目（`currency: "any"`） | 有償＋無償 |
| `paid` | 有償限定のガチャ（ステップアップなど `currency: "paidOnly"`）・有償限定の見た目 | **有償だけ**（無償コインは数えない） |
| `free` | イベントの参加費・種付け料（無償コインのみで払う、REQ-EVENT-004・REQ-BREED-012） | 無償だけ。**購入の案内は出さない**（`status: "free_only"`、お金を払って賞品の機会を買う形にしないため） |

### 29.2 パックの選び方（`coinShortfall`）
- 候補：有償コインがすぐ入る商品（`kind` が `coins`・`starter`・`promotion`、`paidCoins > 0`）。パス・厩舎手当は候補にしない（コインの商品ではない）。
- **今この人が買えるものだけ**：購入の確認（REQ-PUR-001 `checkPurchaseIntent`）と同じ判定を商品ごとに行う ― 1回限りで購入済み、昇級記念パックのクラスに未到達、今月の上限（年齢帯、`age-limits.json`）を超える、今月すでに上限超過の購入がある、は除く。年齢が未登録なら上限は判定せず（購入の確認で生年月を聞く）`ageCheck: true`。
- 「足りる」は**そのパックの有償コインだけ**で数える（初回購入ボーナスの無償コインは数えない。`paid` のときは無償コインは使えないため、`any` のときも案内を控えめにするため）。
- 足りるもののうち価格の安い順（同じ価格ならコインのパック `kind: "coins"` を先、次に有償コインの少ない順）で**1つ**。`status: "covered"`。
- 足りるものが無ければ、買えるもののうち有償コインが一番多いもの（同じなら安い方）を返し `covers: false`・`status: "largest_only"`（「いちばん大きい〜でも、あと◯枚足りません」）。
- 買えるものが1つも無ければ `offer: null`・`status: "none_buyable"`・`blockedCode`（`AGE_LIMIT_EXCEEDED` / `UNSETTLED_DEBT` / `DELETION_PENDING` / `BANNED`）。
- 初回購入ボーナスは**ショップと同じ表示**（§13 `firstPurchaseBonus.label`「はじめての購入時のみ：無償コイン◯枚をプレゼント」）を、そのパックでまだ受け取っていない時だけ付ける。「倍」「お得」「今だけ」「残りわずか」・残り時間は使わない（テストで確認）。

### 29.3 形（`CoinShortfall`）
```json
{ "short": true, "coinKind": "paid", "need": 1500, "have": 300, "shortfall": 1200,
  "headline": "有償コインが1,200枚足りません",
  "status": "covered", "blockedCode": null, "ageCheck": false,
  "line": "コイン1,660（¥2,400）で足ります",
  "notes": ["有償コインだけで支払います（無償コインは使えません）"],
  "offer": { "offerId": "shortfall", "touchpoint": "T6", "productId": "coin_2400", "name": "コイン1,660", "priceYen": 2400, "paidCoins": 1660,
             "covers": true, "contents": [ { "type": "paid_coins", "qty": 1660, "label": "有償コイン1,660枚" } ],
             "firstPurchaseBonus": { "coins": 1660, "currency": "free", "label": "はじめての購入時のみ：無償コイン1,660枚をプレゼント" }, "oneTime": false } }
```
- `short: false`（足りている）なら `status: "not_short"`・`shortfall: 0`・`offer: null`・`headline`/`line` は null。
- `headline`：`コインが{n}枚足りません`（any）／`有償コインが{n}枚足りません`（paid）／`無償コインが{n}枚足りません`（free）。
- `line`：covered `{product}（¥{p}）で足ります`／largest_only `いちばん大きい{product}（¥{p}）でも、あと{n}枚足りません`／none_buyable は `blockedCode` ごとの1文／free_only `無償コインだけで支払う項目です（購入したコインでは支払えません）`。
- 英語（`Accept-Language: en`、§23）はほかのサーバー文言と同じく応答の境界で訳す。
- プレゼントボックス（§26）との関係（Round 12 の統合で決定、REQ-SHORT-011）：ボックスの中の無償コインは**受け取るまで持っていない**ものとして数える（`have` に入れない）。`coinKind` が `any` / `free` で、期限内の未受け取りの無償コインがある時だけ `notes` に `プレゼントボックスに受け取っていない無償コインが{n}枚あります（受け取ると使えます）` を足す（`paid` では無償コインで払えないので出さない。削除の予約中は受け取れないので出さない）。パックの選び方は変えない。

### 29.4 失敗した時（エラーの `details`）
コインで払う操作（`POST /v1/gacha/draw`・`POST /v1/shop/cosmetics/:itemId/buy`・イベントの参加・種付け など、`wallet.spend` / `spendFree` を通るもの全部）がコイン不足で失敗すると、409 `INSUFFICIENT_COINS` に `details.shortfall`（29.3 の形）が付く。何も変わらない（取引ごと取り消し、冪等の記録にも残らない）。
```json
{ "error": { "code": "INSUFFICIENT_COINS", "message": "need 1500, have 300", "details": { "shortfall": { "…": "29.3" } } } }
```
`details` はこのエラーにだけ付く（ほかのエラーの形は変わらない）。古いクライアントは無視してよい。

### 29.5 `GET /v1/shop/shortfall`（要認証、読み取りのみ）
試す前（ガチャの確認シートなど）に同じ答えを出す。クエリ：
- `for=gacha&bannerId=<id>&count=1|10`：そのバナーの今の価格（ステップアップは今の段の価格、`currency` で `any`/`paid`）。
- `for=cosmetic&itemId=<id>`：その見た目の価格（`currency` で `any`/`paid`）。直販でない品は `NOT_ELIGIBLE`、所持済みは `ALREADY_PURCHASED`。
- `for=coins&coins=<1..1000000>&kind=any|paid`：任意の金額。
→ 29.3 の `CoinShortfall`。ほかの値は 400、無いバナー・品は 404。

### 29.6 表示のルール（06 §5.1、クライアントが守る）
- 出してよいのは**ガチャの確認・見た目の購入・ショップ**の中だけ。**レース中・マッチング中・チュートリアル中・負けた直後の結果画面には出さない**（`CoinShortfallModel.Allowed`）。
- シートは「◯コインが◯枚足りません」＋パックのカード1枚＋閉じる（閉じるが一番目立つ）。パックを押すと既存の購入確認（§13、REQ-UXU-010）へ。購入が完了したら元の操作（そのガチャ・その見た目）に戻る。
- KPI：シートを出した時 `offer_view`、パックを押した時 `offer_click`（`offerId: "shortfall"`・`trigger: "T6"`、§13 の KPI と同じイベント）。1回の失敗（1回のプレビュー）につき1回。

## 30. イベント交換所（REQ-EXCH-001〜012、`server/src/domain/exchange.ts`、C# `Exchange.cs`・`Muchi.Game.ExchangeModel`）
イベントレース（§8.2、REQ-EVENT-*）に「交換所」を付ける。イベントを走るとそのイベントだけの**イベントポイント**が貯まり、終了後もしばらく交換できる。ランキングのポイント（`points`）とは別の数で、ランキングは変わらない。

**決めたこと（法務・公平性）**
| 項目 | 決めたこと |
|---|---|
| ポイントの入手 | **そのイベントのレース（確定・無効でないもの）だけ**。`byPlace[着順-1] + participation`（固定）、1ゲーム日（§15、04:00 JST）に `dailyCap` まで。購入・有償/無償ガチャ・商品・パス・ミッション・運営の付与からは入らない（報酬の型にポイントの欄が無く、`eventPointSourceProblems` が商品・ガチャ・進行・報酬に `eventPoints` などのキーや `event_point*` のアイテムを見つけたら起動時・リモート設定で拒否）。無効レースは0。 |
| 交換 | 固定価格・固定の中身・**1人あたりの個数制限**（そのイベントの間ずっと、補充なし）。ランダムなものは無い（スキーマが strict：`rates` などは書けない）。**全部交換した報酬は無い**（コンプガチャにならない。「全交換ボーナス」の欄も書けない）。 |
| 中身 | `coins`（無償コイン、1個 ≤ 100・1個 ≤ ¥200（最も高い単価で換算）、1個ずつ別の付与）・`material`（配合素材）・`ticket`（スカウト券1回分・イベントの参加券。10連券・SR以上確定券は不可）・`cosmetic`（コインで買える見た目、在庫1。有償限定・非売品は不可）・`horse`（テンプレートを指定した馬、在庫1、季節限定なら交換が閉じるまで期間内）。有償コインは出さない。 |
| ランク戦 | 交換の馬もランク戦ではクラス上限に正規化（REQ-RATE-003）。ポイントは買えないので課金で勝率は上がらない。 |
| 終了後 | 終了したゲーム日の翌日から `graceDays` ゲーム日（既定 3）交換できる。閉じる時刻 `closesAtMs` = 終了の最後のゲーム日 + `graceDays` + 1 日の 04:00 JST。閉じた後の最初の取引で、残りのポイントを **`ceil(残り / pointsPerUnit)` 個の `leftover.itemId`（配合素材）** に換える（1ポイントでも1個、失われない）。換算の率と見込み数は閉じる前から GET で見せる。 |
| 時刻の表示 | 画面の時刻・残り日数はすべて GET の実データ（`endAtMs`・`closesAtMs`・`resetsAtMs`）から。カウントダウンの演出・「残りわずか」などは出さない（在庫の「残り 3 / 5」は事実の表示）。 |

### 30.1 定義（`master/events.json` の `events[].exchange`、リモート設定の `events` で差し替え）
```json
"exchange": {
  "earn": { "byPlace": [30, 25, 21, 18, 16, 14, 12, 10, 8, 6, 5, 4], "participation": 10, "dailyCap": 150 },
  "graceDays": 3,
  "leftover": { "itemId": "breeding_material", "pointsPerUnit": 100 },
  "items": [
    { "id": "ex_hatsuyuki", "name": "ハツユキソウ", "kind": "horse", "price": 800, "stock": 1, "reward": { "horse": "t_hatsuyuki" } },
    { "id": "ex_scout_ticket", "name": "スカウト券", "kind": "ticket", "price": 300, "stock": 1, "reward": { "items": [{ "itemId": "gacha_ticket", "qty": 1 }] } },
    { "id": "ex_coins_50", "name": "無償コイン 50", "kind": "coins", "price": 150, "stock": 2, "reward": { "freeCoins": 50 } },
    { "id": "ex_material", "name": "配合素材", "kind": "material", "price": 120, "stock": 3, "reward": { "items": [{ "itemId": "breeding_material", "qty": 1 }] } },
    { "id": "ex_flower_box", "name": "花かご（厩舎の飾り）", "kind": "cosmetic", "price": 200, "stock": 1, "reward": { "items": [{ "itemId": "decor_flower_box", "qty": 1 }] } }
  ]
}
```
検証（`exchangeProblems`、`eventProblems` の中で起動時・リモート設定・テスト）：strict な形、コード側の上限 `EXCHANGE_HARD_LIMITS`（24行・価格 ≤ 100,000・在庫 ≤ 99・`graceDays` 1〜7・`dailyCap` ≤ 5,000・`pointsPerUnit` ≤ 1,000・1行のアイテム数 ≤ 10・コイン ≤ 100/個・¥200/個）、`dailyCap` ≥ 1着1回分、id の重複、`reward` はちょうど1種類で `kind` と合うこと、上の「中身」の規則、`leftover.itemId` は配合素材。英語は `locale.en`（REQ-L10N-005、`name` も対象）。

- **Round 14 の統合**：勝負服エディタのパーツ（§35、`kind: "silks_part"` の見た目アイテム、`currency: "any"` のもの）はそのまま `kind: "cosmetic"` の行にできる（交換で得たパーツはエディタで持っている扱い）。実況パック（§36）は `kind: "commentary_pack"`・`reward.items: [{ "itemId": "<packId>", "qty": 1 }]`・`stock: 1` の行にでき、コインで売っているパック（有償限定でない）だけ（標準・実績のパックは不可）。パックはアイテムではなくプレイヤーの `commentaryPack.owned`（`via: "exchange"`）に入り、もう持っていれば `ALREADY_PURCHASED`（ショップの購入も同じ）。`icon` は `null`（クライアントはパックの絵）。出荷の設定にはまだどちらの行も入れていない（テストのみ、`server/test/r14-integration.test.ts`）。

### 30.2 `GET /v1/events/:eventId/exchange`（要認証）
```json
{ "eventId": "newyear_cup_2027_01", "name": "新春交換祭杯", "status": "open",
  "startAtMs": 1798729200000, "endAtMs": 1799679600000, "closesAtMs": 1800000000000, "graceDays": 3,
  "points": 120, "earned": 240, "spent": 120,
  "earn": { "byPlace": [30, "…"], "participation": 10, "dailyCap": 150, "earnedToday": 40, "remainingToday": 110, "resetsAtMs": 1798772400000 },
  "leftover": { "itemId": "breeding_material", "pointsPerUnit": 100, "rounding": "up", "preview": 2, "converted": null },
  "items": [ { "id": "ex_material", "name": "配合素材", "kind": "material", "price": 120, "stock": 3, "bought": 1, "remaining": 2, "owned": false,
               "reward": { "items": [{ "itemId": "breeding_material", "qty": 1 }] }, "icon": "item/breeding_material", "affordable": true, "maxQty": 1 } ],
  "rules": { "purchasable": false, "random": false, "completionReward": false, "sources": ["event_race"] } }
```
- `status`：`upcoming`（開始前・交換不可）/ `open`（開催中・貯まる・交換可）/ `grace`（終了後・交換だけ可）/ `closed`（閉じた・残りは換算済み）。
- `earn.remainingToday` は `open` の時だけ（それ以外は0）。`resetsAtMs` は次のゲーム日の開始。
- `leftover.preview` は今のポイントを換算した時の個数、`converted` は換算の記録（`{ at, points, itemId, qty }`）。
- `items[].icon`：アイテムの絵のキー（馬は `collection/portrait/<templateId>`、コインは `null` = クライアントのコインの絵）。`owned`：見た目アイテムを持っている（交換できない）。`maxQty`：今のポイントと在庫で交換できる最大数。
- 閉じた交換所に残りのポイントがあれば、この GET が取引として換算してから返す（普段は読み取りだけ）。
- 交換所の無いイベントは 404 `NOT_FOUND`、id の形が違えば 400。
- `GET /v1/events` の各イベントに `exchange`（交換所が無ければ `null`）：`{ status, closesAtMs, graceDays, points, leftover, converted }`。交換所が開いている間は、終了から7日を過ぎても一覧に残る。レース結果（`applyRace`）の `event.exchange` は `{ gained, capped, points, remainingToday }`。

### 30.3 `POST /v1/events/:eventId/exchange`（要認証・`Idempotency-Key` 必須）
本文 `{ "itemId": "ex_material", "qty"?: 1 }`（`qty` 1〜99、既定 1、他のキーは 400）→
`{ "eventId", "itemId", "kind", "qty", "spent", "points", "bought", "remaining", "granted": { "freeCoins", "items": [...], "horse": "t_hatsuyuki" | null }, "exchange": §30.2 の形, "wallet" }`
- プレイヤーの Durable Object の1つの取引：期間・在庫・所持・ポイントを確かめてから、ポイントを減らし、中身を渡す（全部か何もしないか）。同じキーの再送は同じ応答（2回払わない）。
- エラー：`EXCHANGE_NOT_OPEN`（開始前）・`EXCHANGE_CLOSED`（閉じた後）・`OUT_OF_STOCK`（在庫を超える）・`INSUFFICIENT_POINTS`・`ALREADY_PURCHASED`（見た目アイテムを持っている）・`NOT_FOUND`（交換所・行が無い）・`DELETION_PENDING`（削除の実行中）。どれも 409（`NOT_FOUND` 404）。
- コインは1個ずつ別の台帳の記録（`<キー>:<n>`）、アイテムはアイテム台帳に記録。

### 30.4 KPI（サーバーのイベント）
| イベント | s1 | s2 | s3 | 数値 |
|---|---|---|---|---|
| `event_point_earn` | イベント id | `full` / `capped`（1日の上限で削られた） | — | `place` 着順、`value` 得たポイント、`count` 所持ポイント |
| `exchange_buy` | イベント id | 行の id | 種類 `coins`/`material`/`ticket`/`cosmetic`/`horse` | `count` 個数、`value` 使ったポイント |
クエリは `docs/ops/kpi-queries.md`「イベント交換所」。

### 30.5 クライアント（`ApiClient.GetExchangeAsync`・`ExchangeAsync`、`Muchi.Game.ExchangeModel`）
- 交換の確認シート：中身・価格・交換後のポイント・在庫（「残り 2 / 3」）を出し、確定まで同じ冪等キーを保持（タイムアウト後の再送で2回払わない）。
- 終了後（`grace`）は「交換は ◯月◯日 4:00 まで」と、残りのポイントが換わる素材の数（`leftover.preview`）を出す。日時は `closesAtMs` から作る（演出の残り時間は出さない）。
- 交換所からショップ（課金）への導線は作らない。

## 31. 週替わりチャレンジ（REQ-WCH-001〜016、`server/src/domain/weeklyChallenge.ts`・`server/src/race/weeklyChallenge.ts`、C# `WeeklyChallenge.cs`（`ChallengeEvaluator`・`ChallengeRun`）・`Muchi.Game.WeeklyChallengeModel`）
毎ゲーム週、CPU と走る1人用のチャレンジが **3つ** 出る。コース・距離・馬場（重・ダート・ナイター）・相手の強さ（CPU の頭数・レベル・能力の倍率）を既存のレース設定で固定し、条件（「逃げ馬で勝つ」「ムチ3回以内で3着以内」「雨の重馬場で X 以内に完走」など）を付ける。レースは端末で走り（`OfflineRace`）、送るのは入力だけ。**サーバーは発行した設定と送られた入力を C# 検証器で再シミュレーションし**（タイムアタックと同じ §8 の経路）、条件の判定も検証済みの結果からサーバー自身が行う。クライアントの申告だけで達成になることはない。

### 31.1 週（REQ-WCH-001）
- 週は `weekStartsOn`（既定 1 = 月曜）の **ゲーム日の切り替わり**（§15 `progression.dayRollover`、04:00 JST）に始まる。週 id はその週の最初のゲーム日のキー（`"YYYY-MM-DD"`）。`time.ts` の `gameWeekId`・`gameWeekStartMs`・`gameWeekEndMs`・`gameWeeksBetween`（週単位の機能はこれを共有する。ライバル §28 と同じ定義：月曜のゲーム日の切り替わり）。
- その週のセット = `rotation[(anchorWeekId から数えた週数) mod rotation.length]`。翌週のセットは条件だけ先に見せてよい（`previewNext`）。
- 週をまたいだ場合：週の終わりの直前に始めたレースは、セッションの期限内なら**始めた週**の分として数える（今週と先週の進み具合だけを保持）。新しい週は何もクリアしていない状態から始まり、先週のチャレンジはもう始められない（`NOT_FOUND`）。

### 31.2 設定（`progression.weeklyChallenge`、リモート設定で変更可・`weeklyChallengeProblems` で検証）
| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | true | false で画面ごと隠す（`GET` は `{ "enabled": false }`、操作は `NOT_FOUND`） |
| `weekStartsOn` / `anchorWeekId` | 1 / `2026-11-02` | 週の始まりの曜日／`rotation[0]` を出す週（その曜日であること） |
| `statCap` | 3200 | 全員の能力合計の上限（ランク戦B級と同じ正規化）。貸し出し馬はちょうどこの値に引き上げる |
| `sessionTtlMs` / `maxInputs` | 15分 / 400 | セッションの期限／1回の送信の入力の上限 |
| `startsPerDay` / `keepSessions` | 30 / 20 | 1ゲーム日に始められる回数（乱用防止。再挑戦は自由）／保持するセッション数 |
| `previewNext` | true | 翌週のセットを見せる |
| `rotation[]` | 3週分 | `{ id, badge: { id, name }, challenges: [3つ] }` |

チャレンジ：`{ id, title, trackId, going?, night?, cpuCount, cpuLevel, cpuStatPermille?, conditions, loanTemplateId, reward }`。
- `going`：コースの面に合う馬場（芝 `firm`/`good`/`yielding`/`soft`、ダート `fast`/`muddy`/`sloppy`）。無ければ良（`good`/`fast`）。`night`：照明のある競馬場だけ。
- `conditions`（すべて満たし、かつ**完走**でクリア）：`maxPlace`（N着以内、1 = 勝利。頭数より小さいこと）、`style`（その脚質の馬で出走。単独では不可）、`maxWhips`（ムチの入力 N 回以内。ムチのビットを含む入力レコードの数で、端末とサーバーで同じ数え方）、`maxTimeMs`（ゲートが開いてからのタイム、タイムアタックと同じ式）。
- `loanTemplateId`：誰でも使える**貸し出し馬**。季節限定でない、コースの面と距離に合う、`style` があればその脚質であること。
- `reward`：**無償コイン（≤ 100枚、最も高いパックの単価で ¥200 以下）と配合素材（≤ 2）だけ**。有償コイン・券・ガチャ・馬は不可。1週の無償コインの合計 ≤ 150（E18）。
- `badge`：3つクリアした週に付く**見た目だけのバッジ**（`id`・`name` のみ。報酬のキーは付けられない。販売中のアイテムと同じ id は不可）。

コード側の上限 `WCH_HARD_LIMITS`：1週3つ・無償コイン ≤ 100/チャレンジ・≤ 150/週・素材 ≤ 2・¥200・`startsPerDay` ≤ 50・`rotation` ≤ 52週・バッジの記録 ≤ 520。

既定のローテーション：
| 週 | バッジ | チャレンジ（コース・馬場・相手・条件 → 報酬） |
|---|---|---|
| `w_aoba` | 青葉の一閃章 | 逃げ切りの一閃（青葉 芝1600・良・CPU 7頭 Lv3・**逃げ馬で1着** → 素材1）／ムチは3発まで（きらめき 芝2000・CPU 7頭 Lv3・**ムチ3回以内で3着以内** → 素材1）／雨の重馬場（きらめき 芝2000・**重（soft）**・CPU 5頭 Lv2・**タイム以内に完走** → 素材1） |
| `w_minato` | みなとの夜章 | ナイターの先行策（みなと ダート1800・**ナイター**・**先行馬で2着以内** → 素材1）／ムチなしの末脚（みなと 芝2400・CPU Lv2・**ムチなしで5着以内** → 素材1）／不良馬場を走り切れ（サンタルチェラ ダート1700・**不良（sloppy）・ナイター**・**タイム以内に完走** → 素材1） |
| `w_bellmoor` | 直線の覇者章 | 直線一気（ベルムーア 芝1200直線・**ムチ2回以内で1着** → 素材1）／砂の先行争い（青葉 ダート1400・**稍重（muddy）**・**先行馬で3着以内** → 素材1）／長距離の我慢（ノルトハーフェン 芝2400・**ムチ2回以内で3着以内** → 素材1） |

既定の表の報酬は配合素材だけにした：E1 に余裕がなく（Round 12 時点で 64.2 / 上限 65）、各週の1つに無償コイン10枚を付けただけで E1 65.3・招待された人 65.7・招待上限の人の SSR 3.00（上限 2.8）と範囲を外れたため（balance-targets E18）。無償コインは設定で付けられる（1回 ≤ 100・1週 ≤ 150、¥200 以下）が、付ける時は経済シミュレーションで E1/E2 を確かめること。

タイムの条件の値は、貸し出し馬で素直に乗った時（ゲートでスタート・中盤で手綱・残り400mからムチ3回）に届き、何もしない乗り方（スタートを押さない・手綱もムチもなし）では届かない値にした：雨の重馬場 1:34.0（素直 1:31.9／何もしない 1:37.1）、不良馬場を走り切れ 1:19.0（1:16.8／1:23.7）（`engine/Muchi.Engine.Tests/WeeklyChallengeTests.cs` の測定、balance-targets E18）。

### 31.3 公平性（REQ-WCH-007）
| 項目 | 決めたこと |
|---|---|
| 能力 | 全員（自分の馬・CPU）を `statCap` に正規化（ランク戦と同じ `normalizeStats`）。調教の伸びも上限まで |
| スキル | 使わない（タイムアタックと同じ「乗り方の勝負」。`raceConfig.ts` の `raceSkill` がモード `challenge` を除く）。買った馬のスキルは効かない |
| 調子 | ルールセットの調子の揺らぎを切る（`timeAttackRuleset`：`conditionVariancePermille` 0、`rulesetVersion` に `+ta`）。発行時の設定に埋め込むので、途中でルールセットが変わってもそのレースは変わらない |
| 貸し出し馬 | どのチャレンジにも貸し出し馬があり、**能力合計はちょうど `statCap`**（テンプレートの比率のまま最大剰余で引き上げ）、コースの面と距離・脚質の条件に合う。正規化後のどの馬も合計は `statCap` 以下なので、無課金でも**課金で手に入る最強の馬に合計で劣らない**馬で挑める |
| 課金 | 挑戦の回数・条件を緩める商品は作らない。報酬に有償コインは無い |

### 31.4 `GET /v1/challenges/weekly`（要認証）
```json
{ "enabled": true, "weekId": "2026-11-02", "startsAt": 1793804400000, "endsAt": 1794409200000, "serverNow": 1794020400000,
  "challenges": [ { "id": "wa_nige", "title": "逃げ切りの一閃", "trackId": "aoba_turf_1600", "surface": "turf", "distanceM": 1600,
      "going": "good", "night": false, "cpuCount": 7, "cpuLevel": 3, "cpuStatPermille": 1000,
      "conditions": { "style": "nige", "maxPlace": 1 }, "labels": [ { "kind": "style", "text": "逃げの馬で出走" }, { "kind": "place", "text": "1着でゴール" } ],
      "reward": { "items": [ { "itemId": "breeding_material", "qty": 1 } ] }, "loan": { "templateId": "t_hinode", "name": "ヒノデエクスプレス", "style": "nige", "statTotal": 3200 },
      "progress": { "cleared": false, "clearedAt": null, "attempts": 0, "bestPlace": null, "bestTimeMs": null } } ],
  "clearedCount": 0, "badge": { "id": "wch_badge_aoba", "name": "青葉の一閃章", "earned": false, "earnedAt": null },
  "startsLeftToday": 30,
  "next": { "weekId": "2026-11-09", "startsAt": 1794409200000, "badge": { "id": "wch_badge_minato", "name": "みなとの夜章" }, "challenges": [ "…progress なし…" ] },
  "badges": [ { "weekId": "2026-10-26", "badgeId": "wch_badge_bellmoor", "at": 1793500000000 } ], "badgeCount": 1,
  "rules": { "statCap": 3200, "normalized": true, "skills": false, "loanAtCap": true, "paidBoosts": false, "rewardOncePerWeek": true } }
```
- コースの表示名はクライアントのコース名（`tracks.json` / visuals）から出す（サーバーの応答には id だけ）。
- `labels[].text` は条件ごとの短い文（`conditionLabels`）。`?lang=en` / `Accept-Language` で英語（§23。条件の文は `i18n/en.ts` のテンプレート、タイトルとバッジ名は `master/locale-en.json`）。
- `next` は `previewNext` が false なら null。`badges` は新しい順に最大20件。残り日数は `endsAt` と `serverNow` から出す（偽の締め切りは作らない）。

### 31.5 `POST /v1/challenges/weekly/:challengeId/start`（要認証・**冪等キー必須**）
- 本文：`{ "horseId": "h1" }`（自分の現役の馬）か `{ "loan": true }`（貸し出し馬）のどちらか一方。他のキーは 400。
- 応答：`{ "sessionId", "weekId", "challengeId", "playerSlot", "config": RaceStartConfig（mode "challenge"）, "expiresAt", "startsLeftToday", "challenge": {31.4 のカード}, "token" }`。同じ冪等キーの再送は同じセッションを返す（回数は1回だけ）。
- エラー：`NOT_FOUND`（今週のセットに無い・無効）、`CHALLENGE_HORSE_INELIGIBLE`（409、脚質の条件に合わない馬。貸し出し馬は必ず合う）、`CHALLENGE_LIMIT_REACHED`（429、今日の回数）、`HORSE_NOT_ACTIVE`、`HORSE_NOT_FOUND`、`DELETION_PENDING`、`BAD_REQUEST`。
- 設定はサーバーが決める：seed・CPU の馬と枠（`buildRaceConfig`）、`statCap` での正規化、スキルなし、`going`/`night`、調子なしのルールセット。`playerSlot` は人の馬の枠（枠順は抽選）。`token` は `{ raceId: "wch_<sessionId>", slot: playerSlot, playerId, exp: expiresAt }` の署名（レースのチケットと同じ形式）。

### 31.6 `POST /v1/challenges/weekly/submit`（要認証・セッション単位で冪等）
- 本文：`{ "sessionId", "token", "inputs": [[tick, slot, cmd], …], "resultHash", "config"? }`（他のキーは 400）。入力は**自分の枠だけ**・クライアントのビットだけ（`CPU_TAKEOVER`/`HUMAN_RESUME` 不可）・tick は増えていく・`maxTicks` より前・`maxInputs` 件まで。`config` を付けた場合は発行したものと一致すること（`TA_CONFIG_MISMATCH`）。
- サーバー：発行した設定＋入力で検証器を呼ぶ（§8）。ハッシュが端末の `resultHash` と違えば `CHALLENGE_RESULT_MISMATCH`（422、何も記録しない）。検証器が落ちていれば `VERIFIER_UNAVAILABLE`（503、セッションは開いたまま。期限内なら再送できる）。同じセッション・同じハッシュの再送は保存した結果を返す。
- 応答：
```json
{ "sessionId": "w…", "weekId": "2026-11-02", "challengeId": "wa_nige", "resultHash": "…",
  "evaluation": { "finished": true, "place": 1, "timeMs": 98500, "whips": 2, "style": "nige", "cleared": true,
    "checks": [ { "kind": "finish", "target": null, "actual": 1, "ok": true }, { "kind": "place", "target": 1, "actual": 1, "ok": true }, { "kind": "style", "target": "nige", "actual": "nige", "ok": true } ] },
  "cleared": true, "firstClear": true, "reward": { "items": [ { "itemId": "breeding_material", "qty": 1 } ] }, "clearedCount": 1,
  "badge": { "id": "wch_badge_aoba", "name": "青葉の一閃章", "earned": false, "newlyEarned": false }, "credited": true }
```
- 判定と報酬は**開始時に見せた条件・報酬**で行う（遊んでいる途中にリモート設定でローテーションが変わっても、そのレースのルールは変わらない）。
- 報酬は**チャレンジごとに1週1回**（`firstClear`）。2回目以降のクリアも記録・判定はするが報酬は無い（`reward: null`）。3つそろった時に `badge.newlyEarned: true`（1週1回）。
- エラー：`CHALLENGE_SESSION_EXPIRED`（期限切れ・トークン不正）、`CHALLENGE_SESSION_USED`（送信済み・却下済み）、`UNAUTHORIZED`（他人のトークン）、`NOT_FOUND`、`DELETION_PENDING`。

### 31.7 判定（REQ-WCH-005、サーバー `evaluateChallenge`・C# `ChallengeEvaluator`、同じ手順）
- 着順：検証器の `order` の中の `playerSlot` の位置 + 1。`finishTicks` が −1 なら完走していない（`place: null`）。
- タイム：`raceTimeMs`（`(finishTick − gateOpenTick) × ⌊1000/tickHz⌋ + ⌊finishFrac × ⌊1000/tickHz⌋ / 65536⌋`、タイムアタックと同じ）。
- ムチ：送られた（＝検証した）入力のうち、`playerSlot` でムチのビット（32）を含むレコードの数。スタートと同時に押したムチも1回、他の枠の入力は数えない。
- 脚質：発行した設定の自分の馬の `style`。
- `checks` は `finish` ＋条件の順（place → style → whips → time）。すべて `ok` で `cleared`。

### 31.8 KPI（サーバーのイベント）
| イベント | s1 | s2 | s3 | 数値 |
|---|---|---|---|---|
| `challenge_start` | チャレンジ id | 週 id | `loan`/`own` | `count` 今週そのチャレンジを始めた回数 |
| `challenge_clear` | チャレンジ id | 週 id | `loan`/`own` | `place`、`durationMs` タイム、`count` 今週のクリア数、`isFirst` 今週の初クリア（報酬あり）、`value` 1 = この回でバッジ、`freeCoins` 付与したコイン |

クエリは `docs/ops/kpi-queries.md`「週替わりチャレンジ」。

### 31.9 景品表示法・コンプガチャでないこと（REQ-WCH-010）
- 報酬は固定・少額で、1つのチャレンジにつき1週1回（無償コイン ≤ 100枚 ≈ ¥160、総付景品の ¥200 を下回る。配合素材は販売していない）。
- 3つクリアのバッジは**見た目だけ**（能力・報酬なし、販売なし、全員同じ）。チャレンジは誰でも同じ条件で挑め、**ランダムに出るアイテムが一切関わらない**。コンプガチャ（有償のガチャで出る特定の組み合わせをそろえると別の景品が出る）は「ランダムに提供されるアイテムをそろえる」ことが要件なので、これに当たらない。

### 31.10 クライアント
- `Muchi.Client`：`ApiClient.GetWeeklyChallengesAsync`・`StartWeeklyChallengeAsync`（冪等キーは応答まで保持）・`SubmitWeeklyChallengeAsync`（再送安全）、`ChallengeRun`（`OfflineRace` を `playerSlot` で走らせ、入力を `maxInputs` までに抑え、ムチの入力数を数える）、`ChallengeEvaluator`（31.7 と同じ判定。結果画面は送信前に端末の判定を出し、サーバーの判定で確定する）。
- Unity ゲーム層 `WeeklyChallengeModel`：ホームのカード（今週のクリア数・残り日数）、一覧（条件の文・報酬・貸し出し馬）、レース中の HUD の条件の行（「ムチ 2/3」など、満たせなくなったら赤）、結果（クリア／失敗、条件ごとの○×、初クリアの報酬、バッジ）。ホームのカードはタイムアタックの解放（`time_attack`）と同時に出す（サーバーは解放で制限しない）。
- 解放（Round 13 の統合）：解放キー `weekly_challenge`（`progression.unlocks`、タイムアタックと同じ「4日目 or 20戦」、docs/planning/06 §4.3）。表示だけの解放で、サーバーの API は解放前でも答える（他の解放キーと同じ）。ホームのカードは解放後に出す。
- デプロイ：モード `challenge` を知っている検証器（`Muchi.Net` の `ParseMode`）を先に出してから、サーバーを出す。

## 32. 支部の共同目標（REQ-TGOAL-001〜012、`server/src/domain/teamGoal.ts`、C# `TeamGoal.cs`・`Muchi.Game` `TeamGoalModel`）
支部ごとに**週1つの共同目標**（例：「支部で合計60レース」）。支部員みんなのレース結果で段（マイルストーン、3段）が進み、週の終わりに、届いた一番上の段の決まった報酬を、最低限貢献した支部員全員に配る。報酬は無償・ランダムなし・1回 ¥200 以内（景品表示法 総付景品）。課金は関係しない（買って進むものは何も無い）。

**週**（REQ-TGOAL-001）：月曜のゲーム日の切り替え（4:00 JST、`progression.dayRollover`）から7ゲーム日。週のキーはその月曜のゲーム日 `"YYYY-MM-DD"`。終わり＝次の月曜 4:00 JST（`endsAt`）。

**目標の選び方**（REQ-TGOAL-002）：週が始まると、`progression.teamGoal.goals` から **支部IDと週のハッシュ**（FNV-1a）で1つ選ぶ（どのオブジェクトでも同じ）。段の目標値 = `perMember[i] × scale`。`scale` = 先週に貢献した人数（先週が無い・誰も貢献しなかった週は支部の人数）を `scale.min..scale.max`（3..20）に収めた値で、週の間は変わらない。ただし人数で決めた週は、その週に加入があると上にだけ合わせる（小さく始めて人を集める抜け道を作らない）。

**マスターデータ** `progression.teamGoal`（リモート設定で変更可）：
```json
{ "goals": [ { "id": "races_sum", "kind": "races", "label": "支部で合計{n}レース", "perMember": [6, 12, 20], "minContribution": 3 },
             { "id": "wins_sum", "kind": "wins", "label": "支部で合計{n}勝", "perMember": [1, 2, 4], "minContribution": 1 },
             { "id": "ta_pb_sum", "kind": "ta_pb", "label": "支部でタイムアタック自己ベスト更新 合計{n}回", "perMember": [1, 2, 3], "minContribution": 1 } ],
  "tiers": [ { "reward": { "freeCoins": 5 } }, { "reward": { "freeCoins": 8, "items": [{ "itemId": "breeding_material", "qty": 1 }] } },
             { "reward": { "freeCoins": 12, "items": [{ "itemId": "breeding_material", "qty": 1 }] } } ],
  "dailyCap": { "races": 10, "wins": 3, "ta_pb": 2 }, "scale": { "min": 3, "max": 20 },
  "modes": ["ranked", "event", "tournament"], "topN": 5, "payBatch": 50 }
```
- `label` の `{n}` は最後の段の目標値（表示は「支部で合計60レース」。英語は `{n} races as a branch`）。
- 起動時とリモート設定で `teamGoalProblems` が検証する（REQ-TGOAL-010）：形、`perMember` は段の数と同じ長さで昇順、`minContribution ≤ dailyCap × 7`、`scale.max ≤ teams.maxMembers`、報酬は無償コイン・スカウト券（1回・10連）・配合素材（3個まで）だけで、1回の価値 ≤ ¥200（最も高いコイン単価で換算、`inviteRewardYen`）、上の段ほどコインが少なくならない。コード側の上限 `TEAM_GOAL_HARD_LIMITS`。

**貢献**（REQ-TGOAL-003/004）：サーバーが確定した出来事だけ。クライアントから貢献を送るエンドポイントは無い。
- レース：レースの精算（`applyRace`、`modes` のどれか、無効レースは除く）。1レース = `races` 1、1着なら `wins` も 1。
- タイムアタック：検証済みの走りがそのコースの今シーズンの自己ベストを更新した時（`taRecord` の `seasonBest`）= `ta_pb` 1。同じセッションの再送は数えない。
- プレイヤーのオブジェクトが種類ごとの **1日の上限**（`dailyCap`、アカウント全体：支部を移っても戻らない）まで数えて支部へ送る（`GoalContribution { teamId, playerId, displayName, ref: "race:<raceId>" | "ta:<sessionId>", at, races, wins, taPb }`）。届かなければプレイヤーに残し（最大20件・8日）、次の貢献と一緒に送り直す。
- 支部（TeamDO）は、その週の `kind` の分だけを、**今の支部員で `at` の時点で加入済み**の人について、`ref` ごとに1回、**1人1日の上限**（同じ `dailyCap`）まで数える。`at` が今の週でなければ数えない（前の週の遅れた再送は新しい週に入らない）。
- 途中で加入した人は加入から数える。**抜けると本人の貢献は0に戻る**（それまでの分は支部の進み具合に残るが、その週の報酬の対象ではなくなる。同じ週に戻っても0から）。
- 削除予定中・隔離（quarantined）・BAN 中のプレイヤーは送らない。隔離・BAN になった時（`setModeration`）と、アカウント削除の「支部」の段（`feedForget`）で、その人の貢献を今の週と未払いの週から消す（進み具合が下がる。告知済みの段は再告知しない）。

**エンドポイント**（要認証）：

| メソッド・パス | 応答 |
|---|---|
| `GET /v1/teams/me/goal` | 下の `TeamGoalView`。支部に入っていなければ `{ "teamId": null, "teamName": null, "enabled": true, "current": null, "lastWeek": null, "player": {…} }` |

```json
TeamGoalView = { "teamId": "tabc123456", "teamName": "あおばRC", "enabled": true,
  "current": { "week": "2026-12-07", "endsAt": 1797188400000, "goalId": "races_sum", "kind": "races", "label": "支部で合計60レース",
    "scale": 3, "progress": 38, "tier": 2, "minContribution": 3,
    "milestones": [ { "tier": 1, "target": 18, "reached": true, "reward": { "freeCoins": 5 } }, … ],
    "my": { "contribution": 20, "today": 10, "dailyCap": 10, "qualified": true },
    "top": [ { "playerId": "p1", "displayName": "ミドリカワ", "n": 20 } ], "contributors": 3 } | null,
  "lastWeek": { "week": "2026-11-30", "goalId": "wins_sum", "kind": "wins", "label": "支部で合計12勝", "targets": [3, 6, 12], "progress": 7, "tier": 2,
    "reward": { "freeCoins": 10, "items": [ … ] } | null, "top": [ … ], "eligible": true, "paid": true } | null,
  "player": { "enabled": true, "sentToday": { "races": 6, "wins": 1, "ta_pb": 0 }, "pending": 0,
    "lastReward": { "week": "2026-11-30", "teamId": "tabc123456", "tier": 2, "contribution": 9, "reward": { … } } | null } }
```
- `top` は今の支部員で貢献の多い順（同じなら先に積んだ人）に `topN`（5）人。`displayName`・`teamName` はプレイヤーが付けた名前で、英語でも翻訳しない（§23 `PLAYER_TEXT_KEYS`）。
- `?lang=en` では `label` が英語になる（`master/locale-en.json` のテンプレート）。

**週の締めと報酬**（REQ-TGOAL-007/009）：
- 週の締めは、その週が終わった後の最初の支部の操作（貢献・表示・加入・脱退など）か、TeamDO の **アラーム**（週の終わりに鳴る。定期ジョブ）で行う。締めの時点で届いた段（`progress ≥ target` の数）と、**その時の支部員で本人の貢献が `minContribution` 以上の人**の一覧を固定する。加入・脱退の前には必ず締めるので、週の終わりの支部員で決まる。
- アラームが一覧を `payBatch` 人ずつプレイヤーのオブジェクトへ払う（`teamGoalReward(week, teamId, tier, contribution)`、途中で止まっても続きから）。プレイヤーは**週ごとに1回だけ**受け取る（`teamGoal.rewarded`、支部が変わっても同じ週は2回目を受け取らない）。削除予定中・隔離中の人は受け取らない（その週は受け取り済みとして記録し、後から払わない）。
- 届いた段が0なら誰にも払わない。報酬は台帳に `team_goal:<week>` で記録（無償コイン。有償コインは出さない）。

**支部フィード**（REQ-TGOAL-008、§18 のフィードに追加）：段に初めて届いた時、支部の項目 `kind: "goal"` を1件（同じ週・同じ段は1件）。
```json
{ "seq": 131, "kind": "goal", "playerId": "", "displayName": "", "mine": false, "stampId": null, "race": null,
  "goal": { "week": "2026-12-07", "goalId": "races_sum", "label": "支部で合計60レース", "tier": 1, "target": 18, "tiers": 3 }, "reactions": [], "myReaction": null }
```
投稿者の無い項目なので、報告は `BAD_REQUEST`、ミュートでは消えない。応援スタンプは付けられる（通知は無い）。

**通知**：段に届いた時、貢献した本人以外の支部員へ push テンプレート `team_goal`（カテゴリ `friends`、「支部の共同目標が{n}段目に到達しました」。1日の上限・静かな時間帯は通常どおり）。

**KPI**（REQ-TGOAL-011、サーバーが書く）：`team_goal_contribute`（送った貢献。`s1` 支部ID、`s2` `race` | `win` | `ta_pb`、`s3` ref、`count` 単位）、`team_goal_milestone`（段に届けた貢献の本人。`s1` 支部ID、`s2` 週、`value` 段）、`team_goal_reward`（受け取り。`s1` 支部ID、`s2` 週、`value` 段、`count` 本人の貢献）。docs/ops/kpi-queries.md。

## 33. 購入履歴・コイン履歴・ガチャ履歴（REQ-HIST-001〜014、`server/src/domain/history.ts`、C# `History.cs`・`Muchi.Game.HistoryModel`）
プレイヤーが自分で「いつ・何に・いくら」を確かめられる画面（設定 → 購入履歴／コイン履歴／ガチャ履歴）。資金決済法（有償・無償を分けた残高と増減）・特商法（購入の記録）・ガチャの履歴開示（業界の自主基準で求められる直近90日の結果）に応え、問い合わせの手間を減らす。**表示だけ**：この API はコイン・アイテムを動かさない（経済の E は変わらない）。

**データの出どころ（新しい台帳は作らない）**
| 画面 | 元データ | 期間 |
|---|---|---|
| 購入履歴 | `PlayerState.purchases`（`applyVerifiedPurchase` の記録、返金は `refunded`） | 法定の保存期間 `progression.accountDeletion.ledgerRetentionDays`（既定 2557日 = 7年） |
| コイン履歴 | 台帳（REQ-WAL-001）。状態の JSON は直近100行だけなので、Durable Object では `ledger` テーブル（`SqlPlayerRepo.ledgerPage`）から読む | 直近 365日（`HISTORY_LIMITS.coinDays`） |
| ガチャ履歴 | 新設のガチャ記録 `PlayerState.gachaLog`（コイン・券・チュートリアルの1回ごと）。Durable Object では `gacha_log` テーブルへ移し、状態には直近20件だけ残す | 直近 90日（`gachaDays`）。保存も90日で消す（`put` ごと）。状態の中は最大 `gachaKeep`（300件） |
| 残高ヘッダー | `wallet`（有償・無償・未精算）、`monthlySpendYen`、年齢区分の月額上限 | 今月（JST） |

**見せないもの（決定事項）**
- 削除済みアカウント：削除の最後に Durable Object の保存領域ごと消え、法定保存の記録は AccountingDO に**ランダムな匿名 id** で残る（REQ-UXS-040）。この API はプレイヤー id でしか引かないので、匿名の記録には**誰も（本人・運用コンソールも）届かない**。削除済み（墓標あり）の id は 404 `NOT_FOUND`（`account deleted`）。
- 内部 id を文に入れない：取引 id（ストアの注文番号）・商品 id・バナー id・台帳の理由文（運用者名を含む「support grant by …」など）は**表示文に出さない**。各行は問い合わせ番号 `ref` を持つ：購入 `P-` + 取引 id の FNV-1a 32bit（16進8桁）、コイン `C-` + 台帳の連番、ガチャ `G-` + 記録の連番。
- 理由は分類（`category`）とその日本語の文（`title`）で返し、英語は応答の境界で訳す（§23、`i18n/en.ts`）。

### 33.1 `GET /v1/history/summary`（要認証）
```json
{ "wallet": { "paid": 1200, "free": 340, "total": 1540, "debt": 0 },
  "month": "2026-11", "monthSpentYen": 3000, "monthlyLimitYen": 5000, "remainingYen": 2000, "ageLimited": true,
  "limitText": "今月の購入 ¥3,000 ／ 上限 ¥5,000（年齢に応じた月額上限）",
  "notice": "有償コインに有効期限はありません。使うときは有償コインから先に使われます。無償コインはゲーム内で受け取ったコインです。",
  "windows": { "purchasesDays": 2557, "coinsDays": 365, "gachaDays": 90 } }
```
- `monthlyLimitYen` は年齢区分（`ageLimits`）の月額上限。上限なし（20歳以上）・年齢未登録は `null`、`ageLimited` は上限がある区分（16歳未満・16〜17歳・18〜19歳）のとき true、`limitText` は上限があるときだけ（無ければ `null`）。

### 33.2 一覧（要認証、カーソル式）
`GET /v1/history/purchases` ・ `GET /v1/history/coins?currency=paid|free` ・ `GET /v1/history/gacha`。共通のクエリ：`cursor`（前の応答の `nextCursor`、そのまま渡す不透明な文字列）・`limit`（1〜50、既定20）。新しい順。応答 `{ "items": [...], "nextCursor": string | null, "windowDays": n }`。おかしい `cursor`／`limit`／`currency` は 400。
- **購入**：`{ "ref": "P-1A2B3C4D", "at", "product": "コイン 480枚", "productId", "priceYen", "store": "apple"|"google"|"fake", "storeName": "App Store"|"Google Play"|"テスト", "status": "completed"|"refunded"|"pending"|"test", "statusText", "paidCoins", "bonusCoins", "bonusPaid": bool }`。`pending` = 自動更新のパスのストア側の状態が猶予期間・請求の再試行中（`grace`／`billing_retry`）。ストアで保留中（Google の purchaseState 2）の購入はサーバーが受け付けていないので一覧に無い（ストアの購入履歴で確認：`statusText` の説明に書く）。`test` はサンドボックス（請求なし、¥0）。
- **コイン**：`{ "ref": "C-123", "at", "currency": "paid"|"free", "direction": "earned"|"spent"|"note", "amount"（絶対値）, "balanceAfter", "category", "title", "purchaseRef"?: "P-…" }`。`note` は枚数が動かない行（未精算の返金の記録など）。`category`：`purchase`・`purchase_bonus`・`purchase_test`・`daily_pack`・`gacha`・`shop`・`ad_reward`・`compensation`・`login`・`mission`・`achievement`・`race`・`time_attack`・`pass`・`season`・`team`・`event_fee`・`event_fee_refund`・`event`・`tournament`・`stud`・`invite`・`bond`・`comeback`・`refund`・`debt`・`debt_settle`・`forfeit`・`rival`・`team_goal`・`weekly_challenge`・`exchange`（Round 13 の統合）・`commentary_pack`（実況パックの購入、§36、Round 14 の統合）・`other`。勝負服エディタのパーツ（§35）は見た目の直販と同じ `shop`（「ショップで購入（勝負服の色「クリムゾン」）」）。`currency` を付けないと両方（画面は有償・無償を別のタブで出す）。
- **ガチャ**：`{ "ref": "G-7", "at", "banner": "恒常スカウト", "bannerId": string|null, "via": "coins"|"ticket"|"tutorial", "viaText", "count", "coins": { "paid", "free" }, "results": [ { "templateId", "name", "rarity", "duplicate" } ], "summary": "SSR 1・SR 2・R 7" }`。SR以上確定券は `bannerId: null`・`banner` は券の名前。

### 33.3 `POST /v1/history/support-ticket`（要認証、状態を変えない）
`{ "refs": ["P-1A2B3C4D", "C-123"], "topic": "purchase_missing"|"refund"|"coins"|"gacha"|"other" }（`topicText`：購入したのに届かない／返金について／コインの増減について／スカウトの結果について／その他の問い合わせ）`（他のキーは 400、`refs` は1〜10個・重複なし）→
```json
{ "format": "muchi.support-ticket.v1", "playerId": "…", "topic": "purchase_missing", "topicText": "購入したのに届かない", "createdAt": 1796871600000,
  "items": [ { "ref": "P-1A2B3C4D", "kind": "purchase", "at": 1796870000000, "title": "コイン 480枚", "detail": "¥480・App Store・購入済み" } ],
  "body": "問い合わせ番号：P-1A2B3C4D、C-123" }
```
- 期間の外・自分のものでない `ref` は 404 `NOT_FOUND`（他人の取引を確かめる道具にしない）。
- 中身は運用コンソールのプレイヤー画面（§22、`GET /v1/admin/players/:playerId`）がすでに受け付ける**プレイヤー id と問い合わせ番号だけ**。名前・メール・端末の情報は入れない。アプリはこれを問い合わせ窓口（運営のフォーム／メール）に添える。運用は `GET /v1/admin/players/:playerId/history?refs=…` で同じ行を引く。

### 33.4 運用コンソール `GET /v1/admin/players/:playerId/history`（viewer、読み取り、監査ログに残る）
`?kind=summary|purchases|coins|gacha`（＋ `currency`・`cursor`・`limit`）でプレイヤーと同じ一覧、各行に `internal`（購入：`txId`・`platform`・`limitBreach`、コイン：台帳の `reason`・`ref`・`kind`、ガチャ：なし）を足したもの。`?refs=P-…,C-…`（1〜10個）は問い合わせ番号の行だけ（`{ "items": [{ "ref", "kind", "row" | null }] }`）。削除済みは 404。書き込みは無い（読み取り専用）。

### 33.5 KPI
クライアントのイベント `history_view`（`props.tab`：`purchases`|`coins_paid`|`coins_free`|`gacha`）→ s1 = タブ。クエリは `docs/ops/kpi-queries.md`「履歴」。

### 33.6 クライアント（`HistoryModel`）
- タブ（購入／有償コイン／無償コイン／ガチャ）、残高ヘッダー（有償・無償を分けて）、月の購入額と上限（未成年のみ）、`nextCursor` で続きを読む（同じタブで2回同時に読まない）、行の詳細、問い合わせシート（行を最大10件選ぶ → `support-ticket`）。オフラインは「オンラインで確認できます」。タブを開くたびに `history_view` を1回。

## 34. 殿堂・引退式（REQ-HOF-001〜016、`server/src/domain/hallOfFame.ts`・`server/src/http/hallPorts.ts`、C# `Hall.cs`・`Muchi.Game.HallModel`）
馬ごとの**戦績**をサーバーが確定した結果だけから記録し、引退（`POST /v1/horses/:horseId/retire`、REQ-HORSE / 種付け用の既存の引退）のときに**引退式**（決まったルールで選んだ戦績の見どころ）を1回だけ作る。条件を満たした馬は**殿堂入り**し、銘板（プレート）が永久に残る。友達・同じ支部の人は公開用の写しから殿堂を見に行ける（§24 の公開プロフィール・REQ-STABLE-003 のマイ厩舎と同じ仕組み）。報酬は見た目だけ（コインは出ない）。設定は `progression.hall`（`hallProblems` で検証、無い／`enabled: false` なら機能ごと無し）。

### 34.1 戦績（`CareerRecord`、REQ-HOF-001/002）
プレイヤーの部屋（PlayerDO）の `hall.careers[horseId]` に持つ。書くのは次の3か所だけ（クライアントの申告・購入・アイテムでは増えない）：
| 出どころ | 何を数える |
|---|---|
| `applyRace`（レースID ごとに1回のガード内） | `races`・`wins`（1着）・`places`（3着以内）・`byMode`・`biggestWin`・`rivalWins`・`firstRaceAt`/`lastRaceAt`。数えるのはプレイヤー統計（REQ-STAT-001）と同じ：ランク戦・イベント・大会、人間2人以上のフレンド戦。無効レース・チュートリアル・馬IDの無い結果（古い部屋）は数えない。馬は `settleRace` が出走表から付ける `horseId`（`RaceResultForPlayer` に追加、任意） |
| `taRecord`（検証済みのタイムアタック、セッションごとに1回） | `bestTa[trackId]`：コースごとの最速タイム（ms） |
| `tournamentClose`（大会ごとに1回のガード内） | `tournaments[]`（大会名・最終順位）・`tournamentWins`。馬は大会に登録した馬（`award` に `horseId` を追加、任意） |
- `biggestWin`：モードの重み（大会＞イベント＞ランク戦＞フレンド戦）→ 頭数 → 人間の騎手の数 → 先に勝った方。
- `rivalWins`：その週の人間のライバル（§28）がその時点で分かっていて、そのランク戦でライバルより先着した回数。
- **週替わりチャレンジ（§31、`mode: "challenge"`）は数えない**（Round 14 統合で決定）：能力値を上限にそろえた CPU だけのレースで、タイムアタックと同じ検証の経路（`wchRecord`）を通り `applyRace` を通らない。プレイヤー統計（REQ-STAT-001）も数えないので、戦績と統計は同じレースの集合のまま。`applyRace` のレースIDガードがあるので、同じ結果が2回届いても1回だけ数える（`server/test/r14-integration.test.ts`）。週の区切りは使わない（`rivalWins` はライバルの週の記録（§28、time.ts の共通の週）をそのまま見る）。
- 相棒（`flags.partnerHorseId`、REQ-UXS-002）かどうかは記録ではなく毎回判定する。
- 記録はこの機能の公開後のレースから（それ以前の結果はさかのぼらない）。

### 34.2 引退式（`Ceremony`、REQ-HOF-003/004）
`POST /v1/horses/:horseId/retire` の応答に `ceremony` が付く（既存のフィールドはそのまま）。引退は現役の馬にしかできないので、引退式は**1頭に1回**。報酬の繁殖牝馬など最初から引退している馬には無い。
見どころ（`highlights[]`、最大 `highlightsMax`、乱数なし）は次の順に、データがあるものだけ：
| 順 | `kind` | 文言（サーバーが作る、英語は §23 の境界で訳す） |
|---|---|---|
| 1 | `tournament_win` | `大会「{tournament}」優勝`／`大会優勝{n}回（初優勝「{tournament}」）` |
| 2 | `partner` | `最初の相棒として{n}戦をともに走った` |
| 3 | `wins` | `通算{races}戦{wins}勝` |
| 4 | `biggest_win` | `最大の勝利：{course}の{mode}（{n}頭立て）` |
| 5 | `rival_wins` | `ライバルに{n}回先着` |
| 6 | `ta_best` | `タイムアタック {course} {time}`（いちばん最近更新したコース、同時ならコースID順） |
| 7 | `places` | `3着以内{n}回`（勝ちが無い時だけ） |
| 8 | `career_span` | `現役{days}日・{n}戦` |
```json
{ "horseId": "h_12", "horseName": "ミドリノカゼ", "retiredAt": 1793000000000, "partner": true,
  "career": { "races": 34, "wins": 11, "places": 20, "tournamentWins": 1, "firstRaceAt": 1790000000000, "lastRaceAt": 1792990000000 },
  "highlights": [ { "kind": "tournament_win", "text": "大会「秋の陣」優勝", "params": { "tournament": "秋の陣", "n": 1 } }, "…" ],
  "inducted": true, "reasons": ["wins", "tournament", "partner"], "rewardItemId": "decor_hall_plaque_frame", "ackedAt": null }
```
- `POST /v1/hall/ceremonies/:horseId/ack`（要認証）：見たことを記録。**冪等**（2回目以降は最初の `ackedAt` と `already: true`）。引退式の無い馬は 404。
- `GET /v1/hall` の `pendingCeremonies` に、まだ見ていない引退式（新しい順、最大20）が並ぶ。オフラインで見逃しても次に開いた時に出せる。

### 34.3 殿堂入り（REQ-HOF-005〜008）
引退式を作る時に、記録が次の**どれか**を満たせば殿堂入り（`reasons`）：
| `reason` | 条件（`progression.hall.criteria`） | 既定 |
|---|---|---|
| `wins` | `wins ≥ winsMin` | 10勝 |
| `tournament` | 大会で優勝（`tournamentWin: true`） | あり |
| `partner` | 相棒の馬で `races ≥ partnerRacesMin` | 30戦 |
- 数えるのは 34.1 の確定した結果だけ。レアリティ・能力値・課金・アイテムは条件に入らない（お金で近道できない、REQ-HOF-007）。
- 殿堂の銘板（`Plaque`）：`horseName`（プレイヤーが付けた名前、**訳さない**。サポートの名前リセットは反映）・`rarity`・`sex`・`appearance`（毛色など）・`partner`・`reasons`・`inductedAt`・`career`（戦績の1行）・`highlights`・`frame`。
- **永久**：種付け・種牡馬の貸し出し・名前の変更では消えない。消えるのはアカウント削除の時だけ。枠の上限は無い（一覧はページ分け）。
- 報酬（REQ-HOF-008）：アカウントで最初の殿堂入りの時に1回だけ、飾り「殿堂の額縁」（`decor_hall_plaque_frame`、非売品・価格0、マイ厩舎に置ける）。持っていれば銘板に額縁が付く（`frame: true`）。プレゼントボックスを通さず直接（§26.1 の「見た目は直接」）。コインは出ない。
- KPI `hof_induct`（s1=reasons を `+` でつないだもの、s2=`partner`|空、count=戦数、value=勝数）。

### 34.4 自分の殿堂・馬の戦績（REQ-HOF-009/010）
- `GET /v1/hall?cursor=&limit=`：`{ entries: Plaque[], nextCursor, total, relation: "self", visibility, frame: { itemId, owned }, criteria, pendingCeremonies, notice }`。新しい順。`cursor` は前のページの最後の `"<inductedAt>_<horseId>"`（キーセット。新しい殿堂入りがあってもページがずれない）。`limit` は 1〜`pageSizeMax`（既定 `pageSize`）。
- `GET /v1/horses/:horseId/career`：`{ horseId, horseName, status, partner, career, progress: { wins: {have,need}|null, tournamentWin: bool|null, partnerRaces: {have,need}|null }, qualifies, reasons, preview, ceremony, entry }`。`preview` は現役の馬が今引退したら出る見どころ（引退後は null、引退式は固定）。
- `PUT /v1/hall/settings` `{ "visibility": "friends_team" | "friends" | "private" }`：見に来られる範囲（既定 `friends_team`）。

### 34.5 見に行く（REQ-HOF-011〜013）
- 公開用の写し（`HallSnapshot`）を DirectoryDO（`halls` テーブル、プレイヤーIDでシャード）に置き、持ち主の取引の後に変わっていれば書き直す（REQ-STABLE-003 と同じ）。見に行っても持ち主の部屋には触れない。
- 写しを置かない：殿堂入りが0、`private`、BAN 中、アカウント削除の予約中・実行中。削除されたアカウントはディレクトリから消える（`forget`）。
- `GET /v1/hall/:playerId?cursor=&limit=`：見られるのは
  - 友達（自分のフレンドに相手がいる）、または
  - 同じ支部のメンバー（自分の支部IDが相手の写しの支部IDと同じ、`visibility: "friends_team"` の時だけ）。
  - どちらかがブロックしている（支部フィードのミュート＝唯一のブロックリスト、REQ-RIVAL-011）なら見られない。
  - 見られない時はすべて **404 `NOT_FOUND`**（殿堂が無い時と同じ。理由は言わない）。
  → `{ owner: { playerId, displayName, titleId, silks }, relation: "friend"|"team", entries, nextCursor, total, frame }`。支部ID・公開範囲・ブロックリストは返さない。自分のIDなら `GET /v1/hall` と同じ。
- KPI `hof_view`（s1=`self`|`friend`|`team`、value=そのページの件数）。書き込みはしない。

### 34.6 クライアント（REQ-HOF-014/015）
- `Muchi.Client` `ApiClient.GetMyHallAsync(cursor, limit)`・`GetHallAsync(playerId, cursor, limit)`・`GetHorseCareerAsync(horseId)`・`AcknowledgeCeremonyAsync(horseId)`・`SetHallVisibilityAsync(visibility)`。`RetireHorseAsync` の応答の `Ceremony`。
- Unity のゲーム層 `HallModel`：引退式の画面（馬の写真・見どころの行・殿堂入りの印）・殿堂の一覧（ページ送り）・銘板の詳細・友達の殿堂。名前はそのまま（訳さない）。
- 文言・形の英語は §23 と同じ（`server-en.json`・`ui-en.json`）。

## 35. 勝負服エディタ（REQ-SILK-001〜016、`server/src/domain/silksEditor.ts`・`server/master/silks-editor.json`、C# `SilksEditor.cs`（`SilksCode`・`SilksDesign`）・`Muchi.Game.SilksEditorModel`）
勝負服を**パーツの組み合わせ**で作る。抽選は一切ない（**確率なし**）。パーツは「最初から使える」「遊んで解放（実績・レース数など固定の条件）」「コインで直販（固定価格）」「アイテムで解放（商品・パス・交換所の固定報酬）」のどれか。見た目だけで、レースの能力・結果ハッシュ・ゴールデンには関係しない（ランク戦の公平性 REQ-RATE-003）。

### 35.1 デザイン（`SilksDesign`）
| キー | 中身 | 規則 |
|---|---|---|
| `pattern` | 胴の模様（`visuals.json` `silks.patterns` の id：plain・hoops・stripes・sash・cross_sashes・chevrons・diamonds・quartered・halves・stars・spots・braces・…） | 模様ごとの色数（2 または 3） |
| `colors` | 胴の色（`[1色目（地）, 2色目（模様）, 3色目?]`） | 色数は模様と同じ。エディタの色（基本16色＋特別色） |
| `sleeve` | 袖の模様（`match`＝胴と同じ・plain＝2色目の無地・hoops・stripes・armlets・chevrons・stars・diamonds） | 袖は胴の1色目／2色目で塗る |
| `cap` | 帽子の模様（plain・quartered・star・hooped・peak・spots・checks・diamond） | |
| `capColors` | 帽子の色 `[地, 模様]` | 2色 |

- **旧い勝負服**（`{ pattern, colors, cap }`、REQ-ASSET-005）はそのままデザインとして読める：`sleeve: "match"`、`capColors: [colors[0], colors[1]]`（今までの帽子の塗り方と同じ）。
- 特別色は `base`（基本16色のどれか）を持つ。旧いクライアントへは `base` の色で送り、禁止リストの照合も `base` の色の系統で行う。

### 35.2 コード（`code`、全員が同じ見た目を描くための短い文字列）
- 形：`"1"`（版）＋ 2桁の36進数（`0-9a-z`、小文字）×8 ＝ **17文字**。順に `pattern`・`colors[0]`・`colors[1]`・`colors[2]`（2色の模様は `zz`）・`sleeve`・`cap`・`capColors[0]`・`capColors[1]`。正規表現 `^1[0-9a-z]{16}$`。
- 数はパーツごとの**固定の番号**（`silks-editor.json` の `code`。並べ替え・削除しても番号は再利用しない）。同じデザインは必ず同じコード、コード→デザイン→コードで同じ文字列（TS `encodeSilksCode`/`decodeSilksCode`、C# `SilksCode.Encode`/`Decode`。テストベクタ `contracts/silks-code.vectors.json` を両方の言語で確かめる）。
- 旧い勝負服にもコードがある（35.1 の読み替えをしてから符号化。`silksCodeOf(silks)`）。旧い id・旧いクライアントはそのまま動く。
- レースの `start.visuals.entrants[].silks`（§4・REQ-ASSET-006）・公開プロフィール・厩舎の写し・ライバルのカードの `silks` に、今までのキーに加えて `code`（エディタで作った時だけ）が入る。今までのキー（`pattern`・`colors`・`cap`）は旧いクライアント向けの近い形（特別色は `base`、新しい帽子は `plain`）。新しいクライアントは `code` があれば `code` を、無ければ今までのキーから作ったコードを描く。ハッシュされるレースの設定には入らない。

### 35.3 検証（サーバー、保存・プリセット・装備の時）
1. 形：知らない id・色数の違い・同じ色だけ（胴の色が全部同じ）は 400 `BAD_REQUEST`。
2. 所持：使うパーツを全部持っていること（無ければ 409 `NOT_ELIGIBLE`、`details.locked` に足りないパーツ）。試着（35.6 の `preview`）だけは持っていなくてよい。
3. 読みやすさ：胴の1色目と2色目、帽子の2色は**色の差（CIE76 ΔE）が `contrast.minDeltaE`（20）以上**。足りなければ 400 `BAD_REQUEST`（`details.problem: "LOW_CONTRAST"`）。どの組が足りないかはカタログの `lowContrastPairs` に全部載せる（クライアントは計算しない）。
4. 実在の勝負服（REQ-ASSET-010）：胴の模様＋色の系統で禁止リストと照合（今までと同じ。特別色は `base`）。項目は任意で `sleeve`・`capColors` も持てる（書いてあれば一致する時だけ、書いていなければ袖・帽子の色が何でも一致）＝**袖や帽子を変えただけでは避けられない**。当たれば 400 `BAD_REQUEST`（`details.problem: "RESERVED"`）。リストが後から増えた時は、表示の時点で当たる勝負服を既定の勝負服に置き換える（今までと同じ `effectiveSilks`）。
5. 旧い `PUT /v1/player/silks` は今までどおり（読みやすさの検査はしない）。保存すると `code` は消え、35.1 の読み替えになる。

### 35.4 パーツの入手（`silks-editor.json`、REQ-SILK-004）
| `source.kind` | 持っている条件 | 例 |
|---|---|---|
| `free`（既定） | いつでも | 胴の無料の模様・基本16色・袖 match/plain/hoops/stripes・帽子の今までの5種 |
| `item` | `items[itemId] > 0`（直販の見た目 `kind: "silks_part"`・商品・パス・交換所の固定報酬） | 特別色 crimson（200コイン）・袖 stars・帽子 spots |
| `achievement` | 実績のその段に届いた（`tierReached`。報酬を受け取ったかは問わない） | 特別色 royal（勝利数の2段目） |
| `races` | 確定したレースの数（`stats.races`）が `count` 以上 | 特別色 sakura（50戦） |
- 胴の模様の解放は今までどおり `visuals.json` の `unlockItem`（勝負服の柄の見た目 `kind: "silks"`・昇級記念パック）。
- 直販のパーツは**見た目の直販**（§13・REQ-ITEM-005）そのもの：`items.json` `cosmetics[]` の `kind: "silks_part"`（`part: "color"|"sleeve"|"cap"`、`ref`、`asset`）。ショップの見た目タブにも並び、`POST /v1/shop/cosmetics/:itemId/buy`・コイン不足の案内（§29 `for=cosmetic`）・有償/無償の分け方（有償から先、`paidOnly` は有償だけ）がそのまま使える。1回買えばずっと持つ（期限なし）。
- 遊んで解放するパーツは報酬として**配らない**（条件を満たすと持っている扱い）。コイン・ガチャの経済（E1〜E16）は変わらない。セットを集めると何かもらえる仕組みは無い（コンプガチャにならない）。

### 35.5 返金で失ったパーツ（REQ-SILK-010）
- ストアの返金（REQ-PUR-006）でパーツのアイテムが取り消された時（商品の中身・パスの報酬）：
  - **装備中の勝負服**がそのパーツを使っていたら、同じ取引の中で**既定の勝負服**（`defaultSilks`、その人の最初の勝負服）に戻し、`resetNotice`（`{ at, reason: "refund" }`）を残す。エディタは「返金によりパーツが取り消されたため、勝負服を初期の柄に戻しました」を1回出して消す（`POST /v1/silks/notice-seen`）。
  - **プリセット**は消さない。`usable: false`・`missing`（足りないパーツ）を付け、適用は 409 `NOT_ELIGIBLE`。パーツを買い直す・条件を満たすとまた使える。
- コインで買ったパーツはコインの取引なので個別の返金は無い（コインの元になった購入が返金されると、今までどおりコインの借り（debt）になり、パーツは残る）。

### 35.6 API（要認証。英語は §23 のとおり境界で訳す）
- **`GET /v1/silks/editor`** → カタログ＋自分の状態（読み取りのみ、状態を作らない）
```json
{ "version": 1, "codeVersion": 1, "notice": "見た目のみ。ランク戦の能力には影響しません。パーツは抽選ではありません（固定の価格・条件）。",
  "contrast": { "minDeltaE": 20 }, "lowContrastPairs": [["white", "platinum"], ["red", "crimson"]],
  "parts": {
    "patterns": [ { "id": "stars", "code": 9, "colors": 3, "name": "星", "owned": true, "source": { "kind": "free" }, "sourceLabel": "最初から使える", "asset": "silks/pattern/stars" } ],
    "colors":   [ { "id": "crimson", "code": 16, "hex": "#B3122E", "base": "red", "name": "クリムゾン", "owned": false,
                    "source": { "kind": "item", "itemId": "silkpart_color_crimson" }, "sourceLabel": "コイン200で購入",
                    "shop": { "itemId": "silkpart_color_crimson", "price": 200, "currency": "any", "forSale": true } } ],
    "sleeves":  [ { "id": "stars", "code": 6, "name": "星", "owned": false, "source": { "kind": "item", "itemId": "silkpart_sleeve_stars" }, "sourceLabel": "コイン200で購入", "shop": { "…": "…" }, "asset": "silks/sleeve/stars" } ],
    "caps":     [ { "id": "diamond", "code": 7, "name": "ダイヤ", "owned": false, "source": { "kind": "achievement", "achievementId": "podiums", "tier": 3 }, "sourceLabel": "実績「3着以内」の3段目で解放", "asset": "silks/cap/diamond" } ] },
  "current": { "design": { "pattern": "hoops", "colors": ["navy", "white"], "sleeve": "match", "cap": "plain", "capColors": ["navy", "white"] },
               "code": "1010a00zz00000a00", "silks": { "pattern": "hoops", "colors": ["navy", "white"], "cap": "plain" }, "resetNotice": null },
  "presets": [ { "slot": 0, "name": "本番用", "code": "1…", "design": { "…": "…" }, "savedAt": 0, "usable": true, "missing": [], "problems": [] } ],
  "maxPresets": 5, "presetNameMax": 12, "wallet": { "free": 120, "paid": 0 } }
```
  - プリセットの `usable` は「全部持っている（`missing` が空）かつ今の禁止リスト・読みやすさに当たらない（`problems` が空）」。
  - `sourceLabel`：`最初から使える`／`コイン{n}で購入`／`有償コイン{n}で購入`／`実績「{name}」の{tier}段目で解放`／`レースを{n}回走ると解放`／`商品・報酬で入手`（直販でないアイテム）。
- **`POST /v1/silks/preview`** `{ design } | { code }` → 試着（何も変わらない、持っていなくてよい）：`{ design, code, owned: bool, locked: [{ type, id, name, sourceLabel, shop? }], totalPrice: { any, paidOnly }, problems: [{ problem: "LOW_CONTRAST"|"RESERVED", message }], savable }`。`savable` は「全部持っていて問題が無い」。
- **`PUT /v1/silks`** `{ design } | { code }`（どちらか一方、他のキーは 400）→ 35.3 で検証して装備：`{ design, code, silks }`。同じデザインを送り直しても結果は同じ（冪等キー不要。KPI は変わった時だけ）。初心者・復帰ミッションの `silks` を数える（旧い PUT と同じ）。
- **プリセット**（最大 `maxPresets` = 5、名前は自分にしか見えない・1〜12文字・制御文字不可・前後の空白は削る。名前を省くと「プリセット{n}」）：
  - `POST /v1/silks/presets` `{ name?, design | code }` → 空いている一番小さい `slot` に保存（35.3 の検証。満杯は 409 `CONFLICT`）→ `{ presets }`。
  - `PUT /v1/silks/presets/:slot` `{ name?, design? | code? }` → 上書き（名前だけの変更も可）。無い slot は 404。
  - `DELETE /v1/silks/presets/:slot` → `{ presets }`（無い slot は 404）。
  - `POST /v1/silks/presets/:slot/apply` → 装備（`PUT /v1/silks` と同じ検証・同じ応答。`usable: false` は 409 `NOT_ELIGIBLE`）。
- **`POST /v1/silks/parts/:itemId/buy`**（冪等キー必須）→ パーツの直販（`kind: "silks_part"` か勝負服の柄 `kind: "silks"` だけ。ほかは 404）。中身は `POST /v1/shop/cosmetics/:itemId/buy` と同じ（所持済み 409 `ALREADY_PURCHASED`、コイン不足 409 `INSUFFICIENT_COINS`＋§29 の `details.shortfall`、未精算の返金 `UNSETTLED_DEBT`）→ `{ itemId, spent: { paid, free }, wallet, part: { type, id, owned: true } }`。
- **`POST /v1/silks/notice-seen`** → `resetNotice` を消す。

### 35.7 画面（プロトタイプ `silks` 画面、Unity は handoff 文書）
- 上半分：騎手と馬の写真の上に、**色を塗り替えるレイヤー**（胴・袖・帽子のマスク）でライブプレビュー。下半分：タブ（胴の模様・色・袖・帽子）とパーツの一覧、プリセットの枠（5つ）。
- 持っていないパーツも選べる（**試着中**のラベル＋鍵＋入手方法／価格）。試着のまま「保存」すると、足りないパーツと合計の価格を出す。買うのはパーツ1つずつ、既存の購入確認（価格・有償/無償の内訳・`有償限定`）を通す。
- 読みやすさが足りない組・実在の勝負服に当たる組は、保存の前にサーバーの文言で知らせる（色の一覧では `lowContrastPairs` の相手を薄く表示）。
- 急かさない：「今だけ」「残りわずか」「お得」「倍」・残り時間・通常価格は出さない。

### 35.8 KPI
| イベント | 送り手 | s1 | s2 | s3 | 数値 |
|---|---|---|---|---|---|
| `silks_edit` | サーバー（装備が変わった：`PUT /v1/silks`・プリセットの適用） | コード | `editor`/`preset` | | `value` 無料でないパーツの数、`count` プリセットの数 |
| `silks_part_buy` | サーバー（パーツを買った：どちらの購入 API でも） | itemId | パーツの種類（`pattern`/`color`/`sleeve`/`cap`） | `any`/`paidOnly` | `paidCoins`・`freeCoins`、`value` 価格 |
クエリは `docs/ops/kpi-queries.md`「勝負服エディタ」。

### 35.9 クライアント
- `Muchi.Client`：`SilksCode`（`Encode`・`Decode`・`IsValid`・`OfSilks`）、`SilksDesign`（`FromLegacy`）、`SilksCodeTables`、`SilksEditorView`・`SilksPart`・`SilksPreset`・`SilksPreview`、`ApiClient.GetSilksEditorAsync`・`PreviewSilksAsync`・`SaveSilksAsync`・`SaveSilksPresetAsync`・`UpdateSilksPresetAsync`・`DeleteSilksPresetAsync`・`ApplySilksPresetAsync`・`BuySilksPartAsync`・`MarkSilksNoticeSeenAsync`、`Silks.Code`。
- `Muchi.Game`：`SilksEditorModel`（タブ・選択・試着中の判定・保存の前の確認・購入確認の行・プリセットの枠）。

## 36. 実況パック（commentary packs、REQ-CMT-001〜014、`server/src/domain/commentaryPacks.ts`・`server/master/commentary-packs.json`、C# `CommentaryPacks.cs`（`CommentaryPackCatalog`・`CommentaryPackLint`・`CommentarySample`）・`Muchi.Game.CommentaryPackModel`）
実況の**話し方だけ**を変える見た目（耳で聞く見た目）の品。パックは「標準」の実況（`commentary-ja.json` / `commentary-en.json`）の上に、出来事（phrase kind）ごとの言い回しを重ねる。**実況はクライアントの中だけで作られ、レースの設定・結果・ハッシュ・リプレイの形式・ランク戦の勝率には一切関わらない**（ゴールデンも同じ）。

| id | 名前 | 入手 |
|---|---|---|
| `standard` | 標準 | 最初から（全員） |
| `nekketsu` | 熱血 | 実績「出走の記録」1段目（10戦）に届くと持ち物になる（無料・決まった報酬。抽選なし・売らない） |
| `ochitsuki` | 落ち着いた解説 | コインで直販 300（有償コインから先に使う） |
| `kofuu` | 古風な名調子 | コインで直販 300（同上） |

### 36.1 データ（`server/master/commentary-packs.json`）
サーバーの正本。`npm run gen:client-locale` がクライアント用に `engine/Muchi.Client/Resources/Muchi/commentary-packs.json` へ同じ内容を書く（差があるとテストが落ちる）。
```json
{ "version": 1, "standardPackId": "standard",
  "sample": { "seed": 3614, "seconds": 10,
              "track": { "id": "aoba_turf_1600", "surface": "turf", "distanceM": 1600, "segments": [ "…master/tracks.json と同じ…" ] },
              "entrants": [ { "templateId": "t_kohaku", "name": "コハクノヒカリ", "style": "nige", "surface": "turf", "distMinM": 1400, "distMaxM": 2000,
                              "stats": { "speed": 860, "stamina": 640, "burst": 700, "guts": 780, "temper": 480 } }, "…8頭…" ] },
  "packs": [
    { "id": "standard", "name": "標準", "description": "…", "order": 0, "acquire": { "kind": "default" } },
    { "id": "nekketsu", "name": "熱血", "description": "…", "order": 1,
      "acquire": { "kind": "achievement", "achievementId": "races", "tier": 1 },
      "fallback": ["ground_*", "going_call_*", "result_two", "result_solo"],
      "phrases": { "ja": { "gate_open": { "variants": [ { "id": "nekketsu_gate_open_1", "text": "…" } ] } },
                   "en": { "gate_open": { "variants": [ { "id": "nekketsu_gate_open_1", "text": "…" } ] } } } },
    { "id": "ochitsuki", "acquire": { "kind": "coins", "price": 300, "currency": "any" }, "…": "…" } ] }
```
- `acquire.kind`：`default`（標準、1つだけ）／`achievement`（`achievementId`・`tier` に届いたら持ち物。値段なし・売らない）／`coins`（`price` 正の整数、`currency` `any` | `paidOnly`）。抽選・期間限定・セットを揃えた報酬は**作れない**（形にない）。
- 名前・説明は日本語。英語は `master/locale-en.json`（§23、応答の境界で訳す）。
- `sample`：試聴のストックのレース。コースは `master/tracks.json` と同じ形・同じ値、出走馬はテンプレート馬（名前の声 `voice/ja/name/*` がある）で、起動時に一致を確かめる。

### 36.2 重ね方（REQ-CMT-002）
- パックの `phrases.<lang>` にある phrase key（`spurt`、`spurt@bellmoor`、`gate_open@ranked` …）は、標準のその key の言い回しを**置き換える**（足すのではない）。`priority`・`mustSay` は標準のまま（パックは文だけを持つ）。
- パックが元の種類（`spurt`）を置き換えた時、標準のその種類の特化（`spurt@<venue>`・`spurt@<mode>`）は使わない（パックの声のまま）。パックが自分で特化を持てばそれを使う。
- **明示のフォールバック**：標準にある元の種類（`@` なし）は全部、パックの `phrases.ja` にあるか、`fallback` に書いてある（完全一致、または `ground_*` のような接頭辞＋`*`）。書いていない種類が1つでもあればパックは読み込めない（`CommentaryPackLint`）。フォールバックした種類は標準の言い回しで話す。
- 英語（`phrases.en`）は任意。パックに英語が無い種類は**標準の英語**で話す（英語の時だけの暗黙のフォールバック）。
- チュートリアル（`RaceMode.Tutorial`）は装備に関係なく標準で話す（教える口調 `@tutorial` を崩さない）。

### 36.3 決定論（REQ-CMT-003）
言い回しの選び方は今までと同じ `SeedMix.Derive(seed, salt, n)`。`salt` は FNV-1a 64 で、標準は phrase key だけ（今までと同じ値＝標準の実況は1文字も変わらない）、パックは `"<packId>/<phrase key>"`。同じレース・同じパックなら同じ文になる（リプレイ・共有クリップ・観戦で同じに聞こえる）。

### 36.4 文の検査（REQ-CMT-005、起動時とテスト）
- サーバーの起動時（`validateCommentaryPacks`）とリモート設定は使わない（パックは配信物と一緒に出す）。検査：id の重複・`standard` が1つ・値段と通貨・実績と段が存在する・`achievement` のパックは売らない・言い回しの id は `<packId>_` で始まり全パック＋標準で重複なし・空の文なし・プレースホルダーは `{name}` `{name2}` `{name3}` `{place}` `{skill}` だけ・**禁止語**：法務の語（「倍」「お得」「今だけ」「残りわずか」「通常価格」）、**公営競技の賭けの語**（馬券・オッズ・配当・払い戻し・的中・万馬券・儲・賭・単勝・複勝・馬連・馬単・三連単・三連複・枠連・ワイド・投票券・予想屋・ギャンブル）、NG 名（`ng-names.json` の実在の馬名・レース名）。英語は `EN_BANNED`（§23）に加え bet / odds / wager / payout / gamble / jackpot / bookmaker / bookie / punter / trifecta / exacta / quinella / each-way、日本語が混ざらないこと。
- クライアントの読み込み時（`CommentaryTemplates.WithPack`）とサーバーのテスト：上の明示のフォールバック、プレースホルダーが標準のその種類の言い回しが使うものの部分集合（`result` は `{name}{name2}{name3}` まで、`gate_open` はなし…）、言語ごと。
- 標準の `commentary-ja.json` / `commentary-en.json` 自身も同じ禁止語の検査を通る（テスト）。

### 36.5 声（REQ-CMT-006）
- 固定の断片は標準と同じ切り方（`<variantId>#<n>`）で `voice/ja/phrase/<variantId>_p<n>`。アセットの一覧（`contracts/assets.manifest.json`、`npm run gen:assets`）に全パックの断片が載る。馬名・数字・スキル名の声は全パック共通（`voice/ja/name/*`・`voice/ja/num/*`）。
- 1行の断片が1つでも端末に無ければ、その行は**文字だけ**（字幕）で出す（途中まで話して黙ることはしない）。英語の実況は文字だけ（今までと同じ）。

### 36.6 `GET /v1/commentary/packs`（要認証、読み取りのみ）
```json
{ "equipped": "standard", "standardPackId": "standard",
  "sample": { "seed": 3614, "seconds": 10, "trackId": "aoba_turf_1600", "fieldSize": 8 },
  "notice": "実況の話し方だけが変わります。レースの結果・能力には影響しません。",
  "packs": [
    { "id": "standard", "name": "標準", "description": "…", "acquire": "default", "price": null, "currency": null, "forSale": false,
      "owned": true, "equipped": true, "unlock": null },
    { "id": "nekketsu", "name": "熱血", "description": "…", "acquire": "achievement", "price": null, "currency": null, "forSale": false,
      "owned": false, "equipped": false,
      "unlock": { "achievementId": "races", "tier": 1, "label": "実績「出走の記録」1段目で入手", "progress": 3, "target": 10 } },
    { "id": "ochitsuki", "name": "落ち着いた解説", "acquire": "coins", "price": 300, "currency": "any", "forSale": true, "owned": false, "equipped": false, "unlock": null } ] }
```
- `sample` は表示用の要約（`seed`・`seconds`・`trackId`・`fieldSize`）。走らせる中身はクライアントの `commentary-packs.json`。
- `english`：`own`（パックの英語がある）／`standard`（英語では標準の実況、`englishNote`「英語では標準の実況で話します」）。
- `equipped` は持っているパックだけ（装備していたパックを持たなくなった時・パックが無くなった時は `standard`）。`GET /v1/player`（bootstrap も）にも `commentaryPack: { "equipped": "…" }` が入る。
- 値段はこのデータからだけ（クライアントは値段を持たない）。足りない時の案内は §29 の `GET /v1/shop/shortfall?for=coins&coins=<price>&kind=any|paid`。

### 36.7 `PUT /v1/commentary/equipped`（要認証）
`{ "packId": "<id>", "source"?: "settings" | "shop" }`（他のキーは 400、`source` の既定 `settings`）→ 36.6 の形。持っていないパックは 409 `NOT_ELIGIBLE`、無い id は 404。同じパックの再送は何も変えない（冪等キー不要、KPI も出さない）。実績のパックは装備した時に持ち物として記録する（以後、実績の定義が変わっても持ち続ける）。

### 36.8 `POST /v1/commentary/packs/:packId/buy`（要認証・`Idempotency-Key` 必須）
`{ "equip"?: boolean }`（任意、省略は false）→ `{ "packId", "spent": { "paid", "free" }, "wallet", "view": <36.6> }`。
- `acquire.kind` が `coins` のパックだけ（ほかは 409 `NOT_ELIGIBLE`）。持っていれば 409 `ALREADY_PURCHASED`。削除の予約中は 409 `DELETION_PENDING`。
- 支払いは見た目の直販と同じ `wallet.spend`（有償から先、`paidOnly` は有償だけ、未精算の返金は `UNSETTLED_DEBT`、コイン不足は 409 `INSUFFICIENT_COINS` に §29 の `details.shortfall`）。台帳の理由は `commentary pack <id>`。同じ冪等キーの再送は最初の答えを返す（二重に払わない）。

### 36.9 試聴（REQ-CMT-008）
- サーバーに問い合わせない。クライアントが `sample` の**ストックのレース**（決まったコース・シード・テンプレート馬8頭、プレイヤーなし・CPU だけ、`RaceMode.Friend`）を手元で走らせ、そのパックの実況から要所の行を大事な順（勝ち馬・最後の直線・ゲート・着順・叩き合い／写真判定・最初の先頭）に `seconds` 秒（20Hz × 10 = 200 tick）に収まるだけ選び、レースの順に**続けて**流す（`CommentarySample.Build` → `Lines`・`Offsets`・`TotalTicks`・`At(tick)`）。持っていないパックでも聞ける。何度でも同じ文。
- KPI `commentary_pack_sample` は試聴を始めた時に1回（クライアント）。
- 声の断片が端末にあれば声、無ければ字幕だけ（36.5）。

### 36.10 観戦・リプレイ・オフライン
- 観戦・リプレイ・共有クリップの再生は**見ている人が装備しているパック**で話す（クライアントだけのことで、送る・保存するものは変わらない）。
- 端末は最後に装備したパックを覚え（`CommentaryPackModel.KeyEquipped`）、オフラインのレースに使う。オフラインでの装備の変更は端末にだけ残り、次の成功した呼び出しで保存する。

### 36.11 KPI
| イベント | 送り手 | s1 | s2 | s3 | 数値 |
|---|---|---|---|---|---|
| `commentary_pack_equip` | サーバー（PUT・購入して装備） | パック | 前のパック | `settings`/`shop`/`buy` | `isFirst` 初めて標準以外を装備 |
| `commentary_pack_buy` | サーバー（購入） | パック | 通貨（`any`/`paidOnly`） | | `paidCoins`・`freeCoins`、`value` 値段 |
| `commentary_pack_sample` | クライアント（試聴を始めた） | パック | 持っているか（`owned`/`not_owned`） | | |
クエリは `docs/ops/kpi-queries.md`「実況パック」。

## 37. マイリプレイ（保存したリプレイの一覧、REQ-MYRP-001〜016、`server/src/domain/myReplays.ts`・`myReplaysService.ts`、C# `MyReplays.cs`（`ReplayPlayer`）・`Muchi.Game.MyReplaysModel`）
自分が走ったレースのリプレイを、通常の保存期限（§7・REQ-OPS-001 の `replayRetentionDays`）を越えて残す。保存するのは **§7 のリプレイログ（設定＋確定入力）と結果ハッシュだけ**で、動画も状態も保存しない。見る時は端末で再計算する（REQ-RACE-073、REQ-UXS-070 と同じ）。コインもアイテムも動かない（経済の目標なし）。

### 37.1 しくみ
- **最近のレース**（`recent`）：確定した（無効・チュートリアル・タイムアタック・週替わりチャレンジを除く）レースを、プレイヤーの状態に `{raceId, at, mode, trackId, place, fieldSize, slot, resultHash, rulesetVersion, moment}` で覚える（`applyRace`、同じレースは1回）。元のログが R2 の `replays/<raceId>.json` に残っている間（`momentDays` 日、既定 28 < `replayRetentionDays`）だけ保存できる。
- **名場面**（`moment`）：自動で選ぶ ― `win`（1着）・`photo`（隣の着順の馬とゴールの tick の差が `photoFinishTicks` 以下）・`pb`（そのコースの自己ベストの更新、`stats.byTrack.bestFinishTick`、CPU が乗った回は除く）。優先は `win` > `photo` > `pb`。名場面は `momentsKeep`（既定10）件まで・`momentDays` 日で入れ替わる（古い順に消える）。残したければ保存する。名場面でない最近のレースは `recentKeep`（既定30）件まで。
- **保存**（`saved`）：`maxSaved`（既定 20、無料）件まで。保存するとサーバーが元のログを `myreplays/<playerId>/<raceId>.json` に写す（本文 `{ "v":1, "log": §7 のログ, "resultHash": "<64hex>" }`、`maxBytes`（既定 256 KiB）を超えるものは `413 REPLAY_TOO_LARGE`）。この接頭辞は保存期限の削除（`replays/` だけを見る）の対象外。一覧の記録（タイトル・お気に入り・公開）はプレイヤーの状態に持つ。
- ルールセットの固定：ログの設定にはルールセットの値がすべて入っている（§2）。保存の記録に `rulesetVersion` を残し、見る時に「今のエンジンで再生できるか」を判定する（37.4）。

- **週替わりチャレンジ（§31）は保存できない**（Round 14 の統合で決定）：チャレンジは部屋で確定するレースではなく、端末の走りを検証サーバーで確かめる（タイムアタックと同じ `wchRecord` の経路、`applyRace` を通らない）。「確定したレースだけ」の決まりのとおり一覧に出さず、`mode: "challenge"` の結果が届いても覚えない（`noteRaceForReplays`）。チャレンジは保存しないので `retiredRulesets` との関係も起きない（引退させた版の判定は保存済みの部屋のレースだけ）。
- **解放キーは使わない**（Round 14 の統合で決定）：最初のレースから自分のレースがあり、保存は無料なので、§4.3 の解放（R13 の `weekly_challenge` のような「4日目 or 20戦」）では隠さない。プロトタイプの「機能・イベント」の行（`my_replays`）はサーバーの解放キーではなく、いつも開いている（勝負服エディタ §35・殿堂 §34・実況パック §36 も同じ：見た目の着せ替え・厩舎・設定の中にあり、解放の対象の画面から開く）。

### 37.2 API（すべて要認証）
| メソッド | パス | 冪等キー | 本文 → 応答 |
|---|---|---|---|
| GET | `/v1/replays` | | → `MyReplaysView`（37.3） |
| POST | `/v1/replays` | 必須 | `{ "raceId", "replayTitle"? }` → `{ "saved": SavedReplay, "alreadySaved": bool, "view": MyReplaysView }`。同じレースをもう一度保存しても1件のまま（`alreadySaved: true`、タイトルは変えない）。`404 NOT_FOUND`（最近のレースに無い・自分のレースでない）／`410 REPLAY_EXPIRED`（元のログが消えた。最近のレースから外す）／`409 REPLAY_LIMIT`（`maxSaved` 件ある）／`413 REPLAY_TOO_LARGE`／`400 INVALID_NAME`・`NG_NAME`（タイトル） |
| PATCH | `/v1/replays/:raceId` | | `{ "replayTitle"?: string\|null, "favorite"?: bool, "public"?: bool }`（1つ以上）→ `{ "saved": SavedReplay }`。値を置き換えるだけなので何度送っても同じ（冪等）。保存していない id は `404` |
| DELETE | `/v1/replays/:raceId` | | → `{ "deleted": bool, "view": MyReplaysView }`。無い id は `deleted: false`（冪等）。R2 の写しも消す |
| GET | `/v1/replays/:raceId/data` | | 自分の保存・名場面・最近のレース → `ReplayData`（37.4）。保存も最近のレースも無ければ `404`、元のログが消えていれば `410 REPLAY_EXPIRED` |
| GET | `/v1/friends/:playerId/replays` | | フレンドの**公開**した保存だけ → `{ "playerId", "displayName", "replays": SavedReplay[] }`（`public` だけ、`favorite` は出さない） |
| GET | `/v1/friends/:playerId/replays/:raceId/data` | | フレンドの公開リプレイ → `ReplayData`（`owner: "friend"`） |

- タイトル（`replayTitle`）：プレイヤーが入力した文字列。NFKC・前後の空白を除く・1〜`titleMaxChars`（既定 24）文字・制御文字と URL は不可・NG 語は表示名と同じ一覧（`master.ng`）で `NG_NAME`。`null` は「タイトルなし」（画面はコース・着順から作る）。**訳さない**（英語の応答でもそのまま、`PLAYER_TEXT_KEYS`）。
- フレンドの閲覧（`/v1/friends/...`）は、お互いにフレンド・どちらもブロック（支部フィードのミュート、§28 と同じ一覧）していない・持ち主が BAN でも削除の予約中・実行中でもない・その保存が `public` の時だけ。どれかに当たれば `404 NOT_FOUND`（理由は言わない）。
- 削除の予約中（REQ-UXS-040）は保存・公開にできない（`409 DELETION_PENDING`）。一覧・自分の再生・非公開・削除はできる。

### 37.3 形
```json
{ "enabled": true, "maxSaved": 20, "used": 2, "titleMaxChars": 24,
  "saved": [ { "raceId": "r-1", "replayTitle": "差し切った日", "favorite": true, "public": false, "savedAt": 1794279600000,
               "at": 1794270000000, "mode": "ranked", "trackId": "aoba_turf_1600", "place": 1, "fieldSize": 12, "slot": 3,
               "moment": "win", "rulesetVersion": "1.3.0", "resultHash": "…", "sizeBytes": 18234, "playable": true, "reason": null } ],
  "moments": [ { "raceId": "r-7", "at": …, "mode": "ranked", "trackId": "…", "place": 2, "fieldSize": 12, "slot": 0, "moment": "photo",
                 "rulesetVersion": "1.3.0", "saved": false, "expiresAt": 1796690000000 } ],
  "recent":  [ 同じ形（名場面でないもの、新しい順） ] }
```
- 並び：`saved` はお気に入り → 保存の新しい順。`moments`・`recent` は新しい順。`expiresAt` は保存できなくなる時刻（`at + momentDays`、本物の時刻だけ。「あと◯日」の煽りは出さない）。

### 37.4 再生データ（`ReplayData`）と再生できない時
```json
{ "raceId": "r-1", "owner": "me", "replayTitle": "差し切った日", "resultHash": "…", "focusSlot": 3, "rulesetVersion": "1.3.0",
  "playable": true, "reason": null,
  "entrants": [ { "slot": 0, "horseName": "シンセイアカツキ", "owner": "cpu" }, { "slot": 3, "horseName": "アイボウ", "owner": "you" }, { "slot": 5, "horseName": "ハヤテ", "owner": "player" } ],
  "replayLog": { "v": 1, "config": { … }, "endTick": 1834, "inputs": [ … ] } }
```
- `replayLog` は保存したログそのもの（英語の応答でも訳さない、`ID_KEYS`）。ただし**持ち主以外の人間の `playerId` は `p<slot>` に置き換える**（再計算に `playerId` は使わないので結果ハッシュは同じ。テストで確認）。他の人間のプレイヤーの名前は出さない（観戦 §8.4 と同じく、馬の名前だけ。`owner`: `you`／`player`／`cpu`、フレンドが見る時は持ち主が `owner_player`）。
- `playable: false` の理由（`reason`）：`ruleset_retired`（`progression.myReplays.retiredRulesets` に入っている版。`+ev.…` を除いた元の版で比べる）・`ruleset_unknown`（今のエンジンが知らないキーの組、`rulesetKeyProblems`）。端末はさらに再計算の結果ハッシュを `resultHash` と比べ、違えば再生しない（`hash_mismatch`）。どの場合も**違うレースを流さず**「再生できません」と出す（一覧では保存は残り、削除できる）。
- 端末の再生（`ReplayPlayer`）：全馬を最初から最後まで再計算して結果ハッシュを確かめてから再生する。速度 0.5×・1×・2×、カメラは任意の馬（既定は自分の馬）、「最後の200mへ」は選んでいる馬の残り 200m の tick へ飛ぶ。共有カードは REQ-UXS-071 と同じ `ShareCard`（`ReplayClip.Build` の最後の200m）。

### 37.5 設定 `progression.myReplays`（リモート設定で変更可）
`{ enabled, maxSaved, titleMaxChars, maxBytes, recentKeep, momentsKeep, momentDays, photoFinishTicks, retiredRulesets[] }`。上限（`MY_REPLAYS_HARD_LIMITS`、R2 の費用と保存期限から）：`maxSaved` 1..50、`titleMaxChars` 1..30、`maxBytes` 16 KiB..1 MiB、`recentKeep` 1..50、`momentsKeep` 0..20、`momentDays` 1..(`replayRetentionDays` − 1)、`photoFinishTicks` 0..5。起動時と各版で検証。

### 37.6 KPI
`replay_save`（サーバー、`s1` = `moment`／`recent`、`s2` = mode）・`replay_view`（サーバー、再生データを渡した時、`s1` = `own`／`friend`、`s2` = `playable`／理由）・`replay_share`（クライアント、`props.surface` = `my_replays`／`friend_replay`、OS の共有シートに渡した時）。

### 37.7 アカウント削除
削除の手順に `replays` を足す（`rival` の後）：スナップショットの `replayKeys`（保存した写し `myreplays/<playerId>/<raceId>.json`）を R2 から消す。状態の一覧は最後の `wipe` で消える。

## 38. フォトモード（REQ-PHOTO-001〜018、`server/src/domain/photoMode.ts`・`server/master/photo.json`、C# `PhotoMode.cs`（`PhotoCamera`・`PhotoSnapshot`・`PhotoNames`・`PhotoShareCard`）・`Muchi.Game.PhotoModeModel`）
レースを一時停止（オフライン・練習・タイムアタック・チュートリアル・週替わりチャレンジ＝**ひとりで走るレースだけ**）するか、終わったレース（結果画面）・リプレイを止めて、1枚の写真を撮る。カメラを動かし（制限つき）、見た目（ルック）・フレーム・スタンプ・ひとことを重ねて、既存のリプレイ共有（Round 9、`ShareCard`・`IClipRecorder.CaptureStillAsync`・`IShareSheet`）で画像として共有する。**表示だけ**：コイン・アイテムを配らない（E は無い）。購入できる品は既存の見た目ショップ（§13・REQ-ITEM-005）の決まった価格だけ。

**決まりごと**
- **ランク戦・フレンド戦・イベント・大会・プレイヤー主催カップ（§42 の `cup`、Round 16 統合）のレース中は止めない**（他の人のレースに影響するため）。この5つは結果画面（レースが終わった後）とリプレイからだけ撮れる。クライアントは `PhotoModeModel.CanPause(driver)` が false のときポーズのフォトボタンを出さない。サーバーは写真の記録で `source.kind: "paused"` にこれらの `mode` が来たら 400 `PHOTO_SOURCE_INVALID`。
- **決定論**：写真は `(raceId, tick)` とカメラ・重ねる物の値で決まる。端末はレースの設定＋確定入力をその tick まで**もう一度計算**して馬の位置を出す（`PhotoSnapshot.Capture`、走っているレースの `RaceSim` には触らない）。レースの状態・結果ハッシュ・ゴールデンは変わらない。同じ値なら何度でも同じ写真を作り直せる（`PhotoSnapshot.Fingerprint` が一致する）。
- **プライバシー**：写真の名札は馬の名前と、乗り手の表示。自分は「あなた」、フレンドはそのプレイヤーの表示名、**フレンドでない他の人間は `p<slot>`**（マイリプレイ §37 と同じ置き換え。1始まりの枠番ではなく 0 始まりの slot）、CPU は「CPU」。`names: "hidden"` で名札をすべて消せる（既定は `masked`）。共有のテキスト（`ShareCard.ShareText`）には他の人の名前を入れない。
- **ひとこと（caption）**：0〜`captionMaxChars`（既定 24）文字。表示名と同じ規則（NFKC・制御文字なし・URL なし・NG 名リスト、§8 REQ-SOCIAL-006）に加えて、ショップの言葉の規則（「倍」「お得」「今だけ」「残りわずか」「通常価格」）と賭けを思わせる言葉（「馬券」「賭け」「賭博」「ベット」「オッズ」「配当」「払戻」「払い戻し」「的中」「予想」）を使えない（400 `INVALID_NAME`／`NG_NAME`）。**翻訳しない**（英語の応答でも打ったまま、`PLAYER_TEXT_KEYS` の `caption`）。
- 生成する文（解放の条件・注意書き）も同じ言葉の規則を守る（`photoProblems` が検査）。

### 38.1 カタログ（`server/master/photo.json`）
```json
{ "version": 1,
  "config": { "enabled": true, "maxSaved": 30, "captionMaxChars": 24, "stampsMax": 3,
              "camera": { "orbitDeg": [-180, 180], "distanceDm": [20, 200], "heightDm": [3, 100], "fovDeg": [20, 70], "dof": [0, 3] } },
  "looks":  [ { "id": "natural", "name": "ナチュラル", "unlock": { "kind": "default" } } ],
  "frames": [ { "id": "victory", "name": "勝利の額縁", "unlock": { "kind": "achievement", "achievementId": "wins", "tier": 1 } } ],
  "stamps": [ { "id": "carrot_pop", "name": "にんじんポップ", "unlock": { "kind": "cosmetic", "itemId": "photo_stamp_carrot_pop" } } ] }
```
- 種類：`looks`（色味・フィルター。**すべて無料**＝`default` だけ）、`frames`（写真の枠）、`stamps`（写真に置く絵）。id は `[a-z0-9_]{1,32}`、名前は 1〜16 文字。
- 解放 `unlock.kind`：`default` 最初から／`achievement` 実績（§24）のその段に届いた（`tierReached`、遊んで解放）／`cosmetic` 見た目ショップでコインで直接買う（`items.json` の `kind: "photo"`・`asset` がその品のアセットキー。決まった価格、`notForSale` 不可、ガチャ・ランダムからは出ない）。購入は既存の `POST /v1/shop/cosmetics/:itemId/buy`（冪等キー、1回だけ）。
- アセットキー：`photo/look/<id>`・`photo/frame/<id>`・`photo/stamp/<id>`（`contracts/assets.md`、未着は各 kind の `default`）。ゲームのロゴ（ウォーターマーク）は既存の共有画像のもの（`ShareCard.Watermark`）。
- 検査（起動時・リモート設定）：`photoProblems` — 形・範囲、重複 id、ルックは全部 `default`、フレームとスタンプにそれぞれ `default` が1つ以上、実績と段が実在、`cosmetic` は `kind: "photo"` で asset が一致し直販、写真の品はどれもちょうど1つを解放、文の言葉の規則。

### 38.2 `GET /v1/photo/catalog`（要認証）
```json
{ "enabled": true, "version": 1,
  "limits": { "maxSaved": 30, "captionMaxChars": 24, "stampsMax": 3, "camera": { "orbitDeg": [-180, 180], "distanceDm": [20, 200], "heightDm": [3, 100], "fovDeg": [20, 70], "dof": [0, 3] } },
  "looks":  [ { "id": "natural", "name": "ナチュラル", "asset": "photo/look/natural", "unlock": { "kind": "default" }, "unlockText": "最初から使える", "unlocked": true } ],
  "frames": [ { "id": "victory", "name": "勝利の額縁", "asset": "photo/frame/victory", "unlock": { "kind": "achievement", "achievementId": "wins", "tier": 1 }, "unlockText": "実績「勝利の記録」の1段目で解放", "unlocked": false } ],
  "stamps": [ { "id": "carrot_pop", "name": "にんじんポップ", "asset": "photo/stamp/carrot_pop", "unlock": { "kind": "cosmetic", "itemId": "photo_stamp_carrot_pop" },
                "price": 100, "currency": "any", "unlockText": "見た目ショップで購入（100コイン）", "unlocked": false } ],
  "notice": "フォトモードの見た目は写真だけに使われ、レースの能力には影響しません。" }
```
- `price`／`currency` は `cosmetic` の品だけ。無効（`enabled: false`）のときは `{ "enabled": false }` だけ。

### 38.3 写真の記録（要認証）
写真そのもの（画像）はサーバーに置かない。作り直すための小さな記録だけを最大 `maxSaved` 件（既定 30、購入で増えない）。
| メソッド | パス | 本文 | 応答 |
|---|---|---|---|
| GET | `/v1/photos` | — | `{ "photos": PhotoRecord[]（新しい順）, "count", "max" }` |
| POST | `/v1/photos` | `PhotoInput`（`Idempotency-Key` 必須） | `{ "photo": PhotoRecord, "count", "max" }` |
| DELETE | `/v1/photos/:photoId` | — | `{ "deleted": true, "count", "max" }`（無い id は 404） |

```json
PhotoInput = {
  "source": { "kind": "paused" | "result" | "replay", "mode": "ranked"|"friend"|"tutorial"|"time_attack"|"event"|"tournament"|"challenge"|"practice",
              "raceId": "r_…"（1〜128、[A-Za-z0-9_:.-]、オフラインはクライアントが付けた id）, "tick": 0〜72000 },
  "camera": { "focusSlot": 0〜17, "orbitDeg": -180〜180, "distanceDm": 20〜200, "heightDm": 3〜100, "fovDeg": 20〜70, "dof": 0〜3 },
  "lookId": "natural", "frameId": "plain" | null, "stamps": [ { "id", "xPermille": 0〜1000, "yPermille": 0〜1000, "scalePermille": 250〜2000, "rotDeg": -180〜180 } ]（0〜stampsMax）,
  "caption": string | null, "names": "masked" | "hidden", "hideUi": true }
PhotoRecord = PhotoInput ＋ { "id": "ph_12", "createdAt": ms }（一覧では `source.replayId` のある記録に `"replaySaved": boolean` を足す）
```
- `source.replayId`（任意、Round 15 統合）：§37 のマイリプレイの再生から撮った写真が、**自分の保存したリプレイ**を指す（保存は raceId で引くので `replayId` = `raceId`）。`kind: "replay"` 以外・`raceId` と違う値は 400、保存していないレースは 404。あとでリプレイを消しても写真は残り、一覧の `replaySaved` が false になる（アプリは「リプレイを見る」を出さない）。フレンドの公開リプレイから撮った写真は `replayId` なし。
- 名札の伏せ方は §37 と同じ一つの規則（`p<slot>`：サーバー `maskedPlayerId`、C# `ReplayPrivacy.MaskedId`。`PhotoNames.Masked` はそれを呼ぶだけ）。
- カメラの値は整数（dm・度）。範囲は `limits.camera`（範囲外は 400）。高さの下限（0.3 m）は**コースの下にカメラが入らない**ための値で、クライアントの `PhotoCamera` も同じ値で止める。
- 使ったルック・フレーム・スタンプは**解放済みであること**（未解放は 409 `PHOTO_LOCKED`）。上限に達していたら 409 `PHOTO_LIMIT`（古い記録を消してから）。同じ冪等キーの再送は最初の答え。
- 削除の予約中も保存・削除はできる（状態の中にあり、アカウント削除で状態ごと消える）。記録は本人だけが読める（他人に公開する API は無い）。
- 無効（`enabled: false`）のときはどれも 404 `NOT_FOUND`。

### 38.4 KPI
クライアントのイベント `photo_take`（撮った時。`props.source`：`paused`|`result`|`replay`、`props.look`：ルックの id）→ s1 = source、s2 = look。`photo_share`（OS の共有シートに渡した時だけ。`props.source`、`props.framed`：フレームを付けたか）→ s1 = source、s2 = `framed`|`plain`。サーバーのイベント `photo_save`（記録を保存した時）→ s1 = source.kind、s2 = mode。クエリは `docs/ops/kpi-queries.md`「フォトモード」。

### 38.5 クライアント（`PhotoModeModel`）
- 入口：レースのポーズ（`CanPause` が true のときだけ）・結果画面（終わったレースはどのモードでも）・リプレイ再生（結果画面の「共有」の `ReplayShareModel`、および §37 マイリプレイの再生画面の「この瞬間を撮る」＝ `OpenFromSavedReplay(ReplayPlayer)`：画面のフレームの tick、自分の保存なら `replayId` 付き）。
- `PhotoSnapshot.Capture(config, inputs, tick)` で止めた瞬間の全馬を作る。止めたレースの `Sim.Tick` と同じ tick なら、走っているレースの馬と同じ状態になる（テストで確認）。
- `PhotoCamera`：注目の馬を中心に回る（orbit）・寄る（distance／fov）・高さ。値は `limits.camera` で止め、カメラは常にコース面（Y=0）より 0.3 m 以上上。結果は `RaceCameraShot`（`CourseFrame.ToWorld` で置く）。
- UI を隠す（`HideUi`）：撮影画面の操作パネルを消して構図を確かめる。写真に HUD（着順・タイム）は入れない。
- 共有：`PhotoShareCard`（`ShareCard` にひとこと・フレーム・スタンプ・ルックを足したもの、`Kind = "photo_image"`）を `IClipRecorder.CaptureStillAsync` に渡し、`IShareSheet` へ。共有した時だけ `photo_share`。
- 未解放の品は鍵付きで `unlockText` を出し、`cosmetic` は見た目ショップの購入（既存の `BuyCosmeticAsync`、コイン不足は §29 の案内）。オフラインでもルック（すべて無料）と `default` の品で撮って共有できる（保存だけオンライン）。

## 39. 出走前アドバイス（REQ-ADV-001〜016、`server/src/domain/raceAdvice.ts`・`raceAdviceService.ts`、C# `RaceAdvice.cs`・`Muchi.Game.RaceAdviceModel`、共有ベクター `contracts/race-advice.vectors.json`）
レースの前（馬を選ぶ画面）に、**データから計算した短いアドバイス**を出す：持っている馬のうちこのコース・距離・馬場に合う馬、その馬の乗り方（位置取りの目安・ムチの打ち始め・手綱）、わかっている範囲の相手の脚質。**勝つ確率・オッズ・印（◎○▲△）は出さない**。購入を勧めない。無料で、全員が同じ情報（プレイヤーが既に見られる情報だけ）から同じアドバイスを受け取る。

### 39.1 計算（REQ-ADV-001〜003、純粋な関数 `computeRaceAdvice`）
入力は普通のデータだけ（時計・乱数・マスター参照なし）。同じ入力から必ず同じ出力。サーバー（TS）とクライアント（C# `RaceAdvice.Compute`）は同じ手順で、`contracts/race-advice.vectors.json` の全ケースで一致すること（`server/test/race-advice.test.ts`・`engine/Muchi.Engine.Tests/RaceAdviceTests.cs`。ファイルは `npm run gen:advice-vectors` が書き、違えばテストが落ちる）。

入力 `AdviceInput`：
| キー | 中身 |
|---|---|
| `mode` | `ranked`/`friend`/`event`/`tournament`/`challenge`/`timeattack`/`tutorial` |
| `courses[]` | `{ trackId, surface, distanceM, going, night, corners, finalStraightM }`。1件 = コースが決まっている。複数 = レースがその中から1つを選ぶ（ランク戦：全コース、その日の馬場） |
| `horses[]` | 候補の馬（自分の現役の馬・貸し出し馬）：能力5つ（調教込み）・脚質・距離適性・芝ダート・得意馬場・固有スキル `{ id, name, trigger }` |
| `field` | わかっている相手 `{ nige, senko, sashi, oikomi, unknown }`、わからなければ null |
| `rules` | ルールセットから読む値（`adviceRules`）：`aptitudeOutPenaltyPermille`、`goingSpecialistPermille`、馬場ごとの消耗（芝・ダート各4）、`spurtDistanceM` と距離のキー（1.2）、`maxWhips`・`whipDiminishWindowTicks`、CPU の脚質ごとの目標位置、スキルのキーの有無（1.3）。無い任意キー群は中立の値 |
| `statCap` / `fixedStats` | 能力の正規化（ランク戦のクラス上限・チャレンジ・タイムアタック）／全員同じ能力（イベント） |
| `focusHorseId` | 画面で選んでいる馬（乗り方のヒントはこの馬について）。無ければおすすめの馬 |

馬ごとの「合い方」`fitPermille`（コースごとに足し、複数コースなら合計）：
| 要素 | 値 | 根拠 |
|---|---|---|
| 距離が適性外 | −`aptitudeOutPenaltyPermille`（50） | エンジンが最高速とスタミナを5%下げる（RaceSim） |
| 芝ダートが合わない | −同じ | 同上 |
| 得意馬場 | エンジンの `GoingSpecialistPermille` そのもの（±8、稍重は±4。0 へ切り捨て） | REQ-RACE-035 |
| 固有スキルがこのコースで出せる | +3（`cornerRail` はコーナーの無いコース、`finalStraight` は最後が直線でないコースでは出ない → 0）。スキルを使わないレース（チャレンジ・タイムアタック・チュートリアル・能力固定・1.3 未満のルールセット）では 0 | 1.3、balance-targets R9（スキルは理由になるが決め手にしない） |
| 消耗の多い馬場でスタミナの比率 | 比率（能力合計に対する‰）≥220 で +2、<180 で −2。「消耗が多い」= その面の良馬場より 1.5%以上多い（距離のキーが無いルールセットでは 芝2400m・ダート2000m 以上も） | 馬場ごとの消耗（1.1） |
並べ方：`fitPermille` の大きい順 → 実効の能力合計（`statCap` があればそこで頭打ち、能力固定なら 0）の大きい順 → id の順。評価 `grade`：1コースなら 適性外か合計が負 → `poor`、正 → `good`、0 → `ok`。複数コースなら 全部合う → `good`、半分未満 → `poor`、他 → `ok`。

おすすめ `suggestedHorseId` と理由 `suggestReason`：1頭だけ → `only`。1位の合い方が2位より上 → `aptitude`。同じで能力合計が上 → `stats`。どちらも同じ → `even`（おすすめなし、「どの馬も条件は互角。乗り方で差がつく」）。

行 `lines[]`（`kind`：`pick`/`going`/`night`/`field`/`style`/`rein`/`skill`/`whip`/`rules`）。日本語の文はサーバーとクライアントが同じに作り、英語は応答の境界で訳す（§23、`i18n/en.ts`）：
- `going`：その面の良馬場との消耗の比が ≥1015‰ なら「◯の馬場：脚が減りやすい。手綱で脚をためる」、≤985‰ なら「脚が残りやすい」。`night`：「ナイター：走りは昼と同じ（見た目だけ）」（エンジンはナイターで何も変えない）。
- `field`：わかっている相手の脚質の数と頭数、わからない頭数は「出走時に決まる」。ランク戦・イベントは常に「最大12頭。相手は出走時に決まる」。
- `style`：距離のキーがあるルールセット（1.2+）では「この距離で脚質の有利不利はない」（balance-targets T2：全コース×全馬場で脚質別勝率が一様の±25%）。無い場合は短い距離（基準 −400m 以下）で「前の馬が残りやすい」、長い距離（+400m 以上）で「後ろの馬が伸びやすい」（1.1.0 の表）。脚質ごとの位置の目安 = CPU の目標位置 `1 + ⌊(頭数−1)×cpuTargetRank‰/1000⌋`（2番手以上、逃げは「先頭」、1頭で走るときは出さない）。逃げの馬で、わかっている相手に逃げが2頭以上 → 「無理に競らず2番手からでもいい」、相手が全部わかっていて逃げが0 → 「楽に先頭に立てる形」。
- `rein`：気性 < 400（掛かりの起きやすさは 1000 − 気性に比例）→「かかったら手綱を長押し」。`skill`：`goodStart` のスキルが使えるとき「ゲートが開いた瞬間にスタート」。
- `whip`：スパート区間 = `spurtDistanceM` × 距離の係数（1.2 の `DistanceFactorPermille`）。打ち始め = min(400, スパート区間) を 50m 単位で切り捨て（balance-targets R4d：「残り400mから」はムチなしより速い）、間隔 = `whipDiminishWindowTicks`（秒に切り上げ）、本数 = `maxWhips`。`whip` オブジェクトにも同じ数（`startRemainingM`・`spurtM`・`intervalTicks`・`count`）。コースが決まっていなければ「ムチは最後の直線で、間隔をあけて」だけ。
- `rules`：正規化（「能力は合計N までにそろえて走る」）、能力固定、スキルを使わないレース。

### 39.2 チュートリアル（REQ-ADV-010）
`mode: tutorial` は入力に関係なく**決まった短い版**：「合図が出たら、ムチ」「ムチは間隔をあけて打つと伸びる」。馬の並べ替え・おすすめは無い（最初のレースの操作はムチだけ、docs/planning/06 F4）。

### 39.3 正直さ（REQ-ADV-003/004、lint `adviceTextProblems`）
- 生成する文に使わない言葉：勝率・確率・オッズ・本命・対抗・大穴・穴馬・単勝・複勝・馬券・予想・必勝・勝てる・絶対・確実・%・倍・買・購入・課金・ガチャ・スカウト・ショップ・有償・今だけ・残りわずか・お得・通常価格・◎○▲△☆。英語も同じ（odds・win rate・chance・probability・favourite・long shot・bet・buy・purchase・shop・scout・gacha・guarantee・sure win・%・double・limited time・paid）。テストは全コース×全馬場×昼夜×全モード×マスターの全馬の組み合わせで出る文の全部を日英で検査する（馬の名前はプレイヤーが付けた文なので除く）。
- 「順位」は並べ方で、予想ではない。出すのは適性・ルールセットの数字から言えることだけ。
- 公営競技の賭けの語（馬券・オッズ・配当・的中・単勝… / bet・odds・wager・payout・favourite…）は実況パック（§36）の lint と**同じ一つの一覧**（`server/src/domain/bettingWords.ts`）を読む。上の一覧はそれに足すアドバイスだけの語。`bet` は語の境目で見る（better・between は対象外）。

### 39.4 `GET /v1/races/advice`（要認証、読み取りだけ）
クエリ：
| キー | 意味 |
|---|---|
| `context` | `ranked`（既定）/`friend`/`event`/`challenge`/`timeattack`/`tutorial`/`cup`（Round 16 統合：プレイヤー主催カップ §42） |
| `trackId` | コース（`friend`・`timeattack` で使う。`event` は開催のコースの1つなら使う） |
| `going` / `night` | 部屋の条件など、画面に出ている馬場・ナイター（コースの面に合わない馬場は 400。ナイターは照明のある競馬場だけ）。無ければその日の馬場（REQ-RACE-037） |
| `challengeId` | `challenge`：今週のチャレンジ（無ければ 404） |
| `eventId` | `event`：イベント（無ければ 404） |
| `horseId` | 選んでいる馬（ヒントの対象） |
| `field` | `friend`：部屋の他のメンバーの脚質（`nige,sashi`…、最大11） |

コンテキストごとの入力：
| context | コース | 候補の馬 | 相手 | 正規化・スキル |
|---|---|---|---|---|
| `ranked` | 全コース（その日の馬場）。初めてのランク戦でコースが決まっている場合（REQ-UXS-003）はそのコース | 現役の馬 | null（`field` は受け取らない） | クラスの上限、スキルあり |
| `friend` | `trackId` があればそのコース、無ければ全コース | 現役の馬 | `field` の脚質 | なし、スキルあり |
| `event` | 開催のコース（`trackId` が開催のコースならそれ） | 現役の馬（脚質の制限があれば合う馬だけ） | null | イベントの上限・能力固定・イベントのルールセット |
| `challenge` | チャレンジのコース・馬場・ナイター | **貸し出し馬**＋脚質の条件に合う自分の馬 | CPU の頭数（脚質は不明） | `statCap`、スキルなし |
| `timeattack` | `trackId`（必須、馬場は良、昼） | 現役の馬 | 1頭 | `statCap`、スキルなし |
| `tutorial` | — | — | — | 39.2 の決まった版 |
| `cup` | `trackId`（必須）・`going`・`night` はカップの条件（§42、出走前に決まっている） | 現役の馬 | フレンド部屋と同じ（`field` 任意） | 上限なし（入力の `mode` は `friend`：端末の再計算もフレンド部屋のルール） |

応答 = `AdviceOutput` ＋ `context` ＋ `input`（計算に使った `AdviceInput`。端末は選ぶ馬が変わったら `focusHorseId` だけ変えて `RaceAdvice.Compute` で計算し直す。中身は自分の馬とルールセットの値だけ）：
```json
{ "v": 1, "context": "friend", "mode": "friend", "tutorial": false, "courseCount": 1,
  "horses": [ { "horseId": "h2", "name": "ギンガノカナタ", "rank": 1, "fitPermille": 13, "grade": "good", "fits": 1,
      "checks": [ { "kind": "distance", "mark": "ok", "text": "距離2,400mは適性内（1,800〜2,600m）" }, { "kind": "going", "mark": "plus", "text": "重の馬場が得意" } ] } ],
  "suggestedHorseId": "h2", "suggestReason": "aptitude", "focusHorseId": "h2",
  "lines": [ { "kind": "pick", "text": "おすすめはギンガノカナタ。距離・芝ダート・馬場の条件がいちばん合う" }, { "kind": "whip", "text": "ムチは残り400mから、1秒以上あけて6発まで" } ],
  "whip": { "startRemainingM": 400, "spurtM": 840, "intervalTicks": 20, "count": 6 },
  "field": { "nige": 3, "senko": 1, "sashi": 0, "oikomi": 0, "unknown": 0, "size": 5 } }
```
- `checks[].mark`：`plus`/`ok`/`minus`/`off`。複数コースのときは `kind: "pool"` の1行（「今日の8コースのうち5コースで距離と芝・ダートが合う」）。数は**コースの数**で、確率ではない。
- ルールセットはリモート設定の有効なもの（`activeRuleset`、§15）。状態は変えない（冪等キー不要）。削除予定中のアカウントも読める。
- エラー：`BAD_REQUEST`（context・going・field の形）、`NOT_FOUND`（チャレンジ・イベント）、`CONFIG_INVALID`（無いコース）。

### 39.5 公平性（REQ-ADV-006）
- 無料・回数制限なし・全員同じ。課金や持ち物で内容が変わらない（同じ馬なら課金者も無課金者も同じ応答、テストで確認）。
- 使う情報はプレイヤーが既に見られるものだけ：自分の馬・コースとその日の馬場（REQ-DAY-001 で全員同じ）・チャレンジのカード・部屋のメンバーの脚質（クライアントが部屋の画面から渡す）。ランク戦の相手（マッチング前）は使わない。
- アドバイスはレースの結果に一切関わらない（エンジン・設定は変わらない、表示だけ）。ゴールデンは変わらない。

### 39.6 設定・デバッグ（REQ-ADV-009/014）
- 端末の設定「出走前アドバイス」（既定 ON）。OFF ならパネルを出さず、API も呼ばず、KPI も送らない（`RaceAdviceModel.Enabled`、キー `muchi.advice.enabled`）。チュートリアルは設定にかかわらず決まった版を出す。
- 結果画面（Round 8 の振り返り）：ムチのアドバイスを見たレースでは、ムチの打ち始めがアドバイスどおりだったかを1行出す（端末の `RaceDebriefRecorder` の最初のスパート区間のムチの残り距離と比べる：最初のムチが残り（打ち始め＋50m）〜（打ち始め−150m）の間なら「アドバイスどおり」、それより前なら早すぎ、後なら遅すぎ、打たなかった）。C# `RaceAdvice.CheckWhipTip`、`RaceAdviceModel.DebriefLine`。

### 39.7 KPI（クライアントのイベント）
| イベント | props | 列 |
|---|---|---|
| `advice_view` | `context`（39.4 の値）、`horses`（並べた馬の数 0〜30）、`suggested`（おすすめがあったか） | s1 = context、count = horses、value = 1/0 |
| `advice_follow` | `context`、`followed`（出走した馬 = おすすめの馬か） | s1 = context、value = 1/0 |
`advice_view` はパネルを出した画面ごとに1回、`advice_follow` は出走（ランク戦の登録・部屋への参加・チャレンジの開始など）ごとに1回、おすすめがあった時だけ。クエリは `docs/ops/kpi-queries.md`「出走前アドバイス」。

### 39.8 クライアント
- `Muchi.Client`：`ApiClient.GetRaceAdviceAsync(RaceAdviceQuery)`、`RaceAdvice.Compute(AdviceInput)`（39.1 と同じ。オフラインのレース・チュートリアル用）、`RaceAdvice.Rules(RulesetParams)`、`RaceAdvice.CheckWhipTip`、`AnalyticsEvents.AdviceView`・`AdviceFollow`。
- Unity ゲーム層 `RaceAdviceModel`：パネルの行（おすすめ・馬ごとの○△のかわりに「よく合う／合う／条件外あり」の言葉と理由）、選んだ馬が変わったらヒントを計算し直す（サーバーに聞き直さず、受け取った馬の情報から端末で計算。結果はサーバーと同じ）、設定の ON/OFF、KPI、結果画面の1行。オフラインでは端末で計算。
- デプロイ：新しい GET だけ（検証器は変わらない）。サーバーだけ出せばよい（§7.1 の順番に影響なし）。
- 大会（§13 のトーナメント）のエントリー画面にはまだアドバイスを出さない（Round 15 統合で確認）：大会の定義（コース・`statCap`）は TournamentDO にあり、アドバイスを計算するプレイヤーのオブジェクトからは引けない。足すときは `context: "tournament"` に大会 id を渡し、ルーターが大会の定義を添えて呼ぶ形にする（`AdviceMode` には `tournament` が既にある）。

## 40. アクティビティ（お知らせ一覧、REQ-ACT-001〜016、`server/src/domain/activity.ts`、C# `Activity.cs`・`Muchi.Game.ActivityModel`）
留守の間に**自分に起きたこと**を1か所にまとめる一覧と、ホームのベル（未読の数のバッジ）。**表示とリンクだけ**：この一覧はコイン・アイテムを動かさない（受け取りボタンは出さない。プレゼントはプレゼントボックスで受け取る）。E番号なし（経済は変わらない）。

**書く場所（プッシュと同じ箇所、送り元のイベント id ごとに1回）**
| 種類 `kind` | 書く箇所（プッシュ） | 送り元 id（重複は無視） | まとめる | プッシュの種類 `category` | リンク `link.screen` |
|---|---|---|---|---|---|
| `friend_request` | `friendReceive`（`friend_request`） | `friend_request:{from}:{at}` | しない | `friends` | `friends` |
| `friend_accepted` | `friendAccepted`（`friend_accepted`） | `friend_accepted:{by}:{ゲーム日}` | しない | `friends` | `friends` |
| `rival_week` | ライバルの週の結果（`settleWeek`、REQ-RIVAL-006） | `rival_week:{weekId}` | しない | `friends` | `rival` |
| `rival_record` | `rivalPush`（`rival_record`） | `rival_record:{相手}:{ゲーム日}` | しない | `friends` | `rival` |
| `stable_like` | マイ厩舎のいいね（`stableLikeReceive`、数えたものだけ） | `stable_like:{likeId}` | する | `friends` | `stable` |
| `team_cheer` | 応援スタンプ（`cheerPush`、`team_cheer`） | `react:{teamId}:{seq}` + 送り主 | する | `friends` | `team_feed` |
| `tournament_result` | 大会の最終順位（`tournamentClose`） | `tournament:{tournamentId}` | しない | `events` | `tournaments`（`id` = 大会 id） |
| `gift_arrived` | プレゼントボックスに入ったとき（`deliverGift`、`gift_arrived` は REQ-BOX-011 の送り元だけ） | `gift:{ref}` | する | `gifts` | `gift_box` |
| `team_goal_tier` | 支部の共同目標の段に到達（`teamGoalMilestone`、`team_goal`） | `team_goal_tier:{teamId}:{週}:{段}` | しない | `friends` | `team_goal` |
| `team_goal_week` | 共同目標の週の結果（`teamGoalReward`） | `team_goal_week:{週}` | しない | `friends` | `team_goal` |
| `replay_share` | フレンドがマイリプレイ（§37）の保存を公開にしたとき（`MyReplaysService.update` が非公開→公開の時だけ各フレンドへ `activityReplayShare`、Round 15 統合） | `replay_share:{owner}:{raceId}`（公開を外してまた公開しても1件） | しない | `friends` | `replay`（`id` = 公開した人。フレンドのリプレイ一覧へ） |
| `cup_invited` | カップへの招待（`cupInvited`、`cup_invite`。§42、Round 16 統合） | `cup_invited:{cupId}` | しない | `invites` | `cups`（`id` = カップ id）。`{cup}` はカップ名（訳さない） |
| `cup_started` | カップの最初のレースが始まった（`CupRunner.start` → 主催者以外の各参加者へ `cupStarted`、ポート `notifyStarted`。参加中の人だけ） | `cup_started:{cupId}` | しない | `friends` | `cups` |
| `cup_finished` / `cup_cancelled` | カップが終わった（順位 `{n}`）／中止になった（`cupClosed`、参加していた人だけ。招待されただけの人には書かない） | `cup_closed:{cupId}` | しない | `friends` | `cups` |
| `recap_ready` | 振り返りができた（§43、`rollRecaps` が作ったものごと。`vars.kind` = `season`／`year`） | `recap_ready:{recapId}` | しない | `season` | `recap`（`id` = `season:2026-11` など） |
| `new_device`（Round 23） | 新しい端末でログインがあった（§70.4、`devicesCheckin`。プッシュは送らない） | `new_device:{sessionId}` | しない | `account`（プッシュの種類ではない） | `devices`（`id` = sessionId） |

- 大会（`tournament`）と共同目標（`team_goal`）の賞品はプレゼントボックスにも入るが、`gift_arrived` は書かない（同じことを2回書かない。各行のリンクから見られる）。
- おかえり・新着情報（REQ-CB-*）は**項目にしない**：一覧の `links.whatsNew`（新着の数）でその画面へ案内するだけ。週替わりチャレンジ（§31）の結果は自分で走った直後に結果画面で出るので、留守の間の出来事にならない（項目なし）。
- プッシュの設定（§10 の `categories`・静かな時間帯）は**プッシュだけ**に効く。一覧はいつでも全部見られる。各項目の `category` はプッシュと同じ種類（設定画面と一覧で同じ分け方）。
- ブロック（支部フィードのミュート＝ブロックの一覧、REQ-RIVAL-011）している相手からは項目を作らない。あとからブロックした相手の分も一覧と未読の数から外す（まとめた項目は、その相手の分だけ数を減らす）。
- 退会・BAN された相手の名前は出さない：一覧を返すときに公開プロフィール（ディレクトリ）を引き、無い（退会）・BAN（`banned: true`）なら中立の名前「プレイヤー」。名前はプレイヤーが付けたものなので訳さない。
- 削除が進行中（`deletion.status = deleting`）のアカウントには書かない。アカウント削除で一覧ごと消える（状態の一部）。

**保存（`progression.activity`、起動時とリモート設定で検査、REQ-ACT-010）**
`{ "maxEntries": 100, "maxDays": 30, "collapseHours": 24, "pageSize": 20, "pageMax": 50, "badgeMax": 99 }`。範囲：`maxEntries` 10〜500、`maxDays` 1〜90、`collapseHours` 0〜168（0 = まとめない）、`pageMax` 1〜100、`pageSize` 1〜`pageMax`、`badgeMax` 9〜999。無ければこの既定値。書くたびに `maxDays` より古い項目を消し、新しい順に `maxEntries` 件だけ残す。送り元 id は直近500件を覚える。
- **まとめる**：同じ種類のまだ読んでいない項目が `collapseHours` 以内に始まっていれば、新しく作らずに数を足し（`count`）、送り主を先頭に（最大20人、人ごとの数も）、時刻と id を新しくして一覧の先頭へ動かす（未読に戻る）。読んだ後の分は新しい項目になる。

### 40.1 `GET /v1/activity?cursor=&limit=`（要認証、読むだけ）
```json
{ "items": [
    { "id": "42", "kind": "stable_like", "category": "friends", "at": 1796871600000, "count": 12, "unread": true,
      "actors": [ { "playerId": "p_9", "name": "ハヤテ" } ],
      "text": "マイ厩舎に12件のいいねが届きました", "link": { "screen": "stable", "id": null } } ],
  "nextCursor": "17", "unread": 3, "readUpTo": "39",
  "links": { "whatsNew": 2 } }
```
- 新しい順。`cursor` は前の応答の `nextCursor`（不透明な文字列、数字だけ）、`limit` は 1〜`pageMax`（既定 `pageSize`）。おかしい値は 400。
- `text` は日本語で作り、英語は応答の境界で訳す（§23、`i18n/en.ts`）。1件のときは名前入り（「{name}さんがマイ厩舎にいいねしました」）、まとめたときは数（「マイ厩舎に{n}件のいいねが届きました」）。
- `unread` は見える項目のうち `readUpTo` より新しいものの数（`badgeMax` で頭打ち）。`links.whatsNew` は新着情報（REQ-CB-008）のまだ見ていない数。

### 40.2 `POST /v1/activity/read`（要認証、何度送っても同じ）
`{ "upTo": "42" }`（省略 = 今ある全部）。`readUpTo` を `upTo` まで進める（戻さない。今の最新より先は最新まで）。→ `{ "readUpTo": "42", "unread": 0 }`。他のキーは 400。

### 40.3 バッジ
`GET /v1/player`（と bootstrap）の `activity: { "unread": 3 }`（`badgeMax` で頭打ち）。ホームのベルはこの数を出し、0 なら出さない。

### 40.4 KPI
クライアントのイベント `activity_open`（`props.unread`：開いたときの未読の数 0〜999）→ value、`activity_tap`（`props.kind`・`props.screen`）→ s1 = 種類、s2 = 行き先。クエリは `docs/ops/kpi-queries.md`「アクティビティ」。

### 40.5 クライアント（`ActivityModel`）
- ホームのベルとバッジ（0 は非表示、サーバーは `badgeMax` で頭打ちにするので、その数なら「99+」）、一覧（新しい順・`nextCursor` で続き・同時に2回読まない）、項目を押すと `link.screen` の画面へ（`activity_tap`）、一覧を開いたら `activity_open` を1回、見えている一番新しい id まで既読（`POST /v1/activity/read`、失敗しても次に開いたとき送り直す）。オフラインは「オンラインで確認できます」。受け取りボタンは出さない（プレゼントは「プレゼントボックスへ」のリンク）。

## 41. アクセシビリティ設定（REQ-A11Y-001〜016、`server/src/domain/accessibility.ts`、C# `Accessibility.cs`（`AccessibilitySettings`・`AccessibilityTokens`・`TextScale`・`MotionPolicy`・`FlashLimiter`・`WhipHold`）・`Muchi.Game.AccessibilityModel`、色のトークン `contracts/a11y-tokens.json`、docs/planning/06 §11）
より多くの人が遊べるようにする表示・操作の設定。**アカウントに保存**し（機種変更・再インストールでも残る）、端末にも写しを持ってオフラインでも効く。**どの設定もレースの計算・ルールセット・検証・結果ハッシュ・リプレイを変えない**（ゴールデンも同じ）。

### 41.1 設定と既定値（REQ-A11Y-001）
| キー | 値（線の値） | 既定 | 効くところ |
|---|---|---|---|
| `textSize` | `standard` \| `large` \| `largest` | `standard` | 本文（28px 未満）の文字を ×1.00 / ×1.15 / ×1.30（見出し・大きな数字はそのまま）。§41.4 |
| `colorMode` | `standard` \| `cvd` | `standard` | 色覚サポート：ゲージ・順位・状態の色をトークンの `cvd` に替える（シアン／紺の基調は同じ）。§41.5 |
| `reduceMotion` | `true` \| `false` | `false` | 画面の揺れ・FOV キック・スピード線・背景のゆっくりしたズーム・ゲージの点滅をやめ、画面の切り替えとガチャの演出を短くする。§41.6 |
| `haptics` | `true` \| `false` | `true` | 振動（ムチ・追い抜き・スタミナ警告・固有スキル）。オフなら一切振動しない |
| `subtitles` | `true` \| `false` | `true` | 実況の字幕（レース・観戦・リプレイ）。既定でオン（音を消しても遊べる） |
| `oneHanded` | `off` \| `left` \| `right` | `off` | 片手レイアウトの案内：レースの操作（ムチ・手綱・内／外）を片側の親指の届く範囲にまとめる。見た目の配置だけ |
| `whipInput` | `tap` \| `hold` | `tap` | ムチの入力：長押しの間、決まった間隔でムチを入れる。§41.7 |

### 41.2 `GET /v1/settings/accessibility`・`PUT /v1/settings/accessibility`（要認証）
```json
{ "textSize": "standard", "colorMode": "standard", "reduceMotion": false, "haptics": true, "subtitles": true, "oneHanded": "off", "whipInput": "tap",
  "rev": 0, "updatedAt": null,
  "textScale": { "standard": 1, "large": 1.15, "largest": 1.3 },
  "rules": { "affectsRace": false, "whipHold": "same_as_tap", "maxFlashesPerSecond": 3 } }
```
- **GET** は保存されている値（無ければ既定値）。読むだけでは状態を作らない。`GET /v1/player` と `POST /v1/player/bootstrap` にも同じ形で `accessibility` が入る（起動1回で揃う）。
- **PUT** は**全体の置き換え**（冪等）：本文は上の7つのキーのオブジェクト。**送らなかったキーは既定値に戻る**（端末はいつも全部送る）。知らないキー・知らない値・型違いは 400 `BAD_REQUEST`。同じ本文を何度送っても `rev` は変わらず、KPI も出ない（冪等キー不要）。値が1つでも変わると `rev` を1増やし `updatedAt` を更新する。応答は GET と同じ形。
- 削除予定中のアカウントでも変えられる（見た目だけ）。削除されると他のデータと一緒に消える（墓標のある id は今までどおり 404）。

### 41.3 端末の写しとオフライン（REQ-A11Y-004）
- 端末は最後の設定を写し（`AccessibilityModel.KeyBlob`）に持ち、起動直後・オフラインでもそれを当てる（サーバーを待たない）。
- 変えたらすぐ画面に当て、写しに保存し、PUT する。届かなかった時は写しに「未送信」の印を付け、次にオンラインになった時（起動・画面を開いた時）にまとめて PUT する。
- 起動時：写しが未送信ならサーバーへ PUT（端末が勝つ）。未送信でなければサーバーの値（bootstrap の `accessibility`）を写しに入れる（別の端末で変えた値が届く）。同時に2台で変えた時は後から届いた方（最後の書き込み）が残る。

### 41.4 文字の大きさ（REQ-A11Y-005）
- 倍率は本文（28px 未満の文字・ボタン・字幕・HUD の小さな文字）だけ。見出し・大きな数字（28px 以上）はすでに大きいので変えない。
- **どの画面もはみ出さない**：箱に入りきらない文字だけ、標準の大きさまで戻してよい（日本語は標準より小さくしない。英語は従来どおり 66% まで、REQ-L10N-013）。プロトタイプの e2e（`test/a11y-flow.cjs`）が主要な画面を「特大」で日本語・英語の両方で調べ、はみ出し0件と、本文の多くが実際に大きくなったこと（各画面で文字の 60% 以上）を確かめる。

### 41.5 色覚サポート（REQ-A11Y-006、`contracts/a11y-tokens.json`）
| トークン | standard | cvd | 使うところ |
|---|---|---|---|
| `gauge.ok` | `#00d2ed` | `#00d2ed` | スタミナ・ミニゲージ（30%より多い） |
| `gauge.low` | `#ffd34f` | `#ffff33` | 30% 以下 |
| `gauge.critical` | `#ff5a4a` | `#cc6633` | 10% 以下・空（cvd では斜線の模様も付ける） |
| `position.self` | `#ffd34f` | `#ffff33` | ミニマップ・頭上の印の自分 |
| `position.other` | `#00d2ed` | `#5f8fb3` | ミニマップの他の馬 |
| `status.ok` | `#8fe3a8` | `#00d2ed` | 登録済み・成功の文字 |
| `status.danger` | `#ff7a6b` | `#ff9a3d` | 警告・削除・エラーの文字 |
| `cue.whipChance` | `#ffe661` | `#ffff33` | 「今だ」のムチの光 |

- 検査（`server/test/a11y-tokens.test.ts`、C# `AccessibilityTests`）：どのトークンも紺の背景 `#08182a` に対してコントラスト比 3:1 以上（図形、WCAG 1.4.11）、文字に使う `status.*` は 4.5:1 以上。`cvd` のグループ（ゲージの3色・順位の2色・状態の2色）は、通常の見え方と1型・2型・3型の2色覚の見え方（Machado 2009、強さ 1.0）のどれでも、組の色差 ΔE*ab（CIE76）が 40 以上。`standard` は今の見た目のまま（2型でゲージの黄と赤が 28.7 まで近づく。それを補うのが `cvd`）。
- 色だけで伝えない（docs/planning/06 §9.3）：スタミナは文字（「脚が残り少ない」等）、自分の馬は大きな印と名前、レア度は形と文字を色と一緒に出す。

### 41.6 動きを減らす・点滅（REQ-A11Y-007/008）
- `reduceMotion`（`MotionPolicy`）：カメラの揺れ ×0、ムチの FOV キック ×0、スピード線なし、背景のドリフトなし、ゲージの点滅は止めて色と文字だけ、画面の切り替え・シートは 150ms 以下のフェード、ガチャの演出は光の待ち（380ms）なしで表が出てめくりも 150ms 以下。**ガチャの提供割合・抽選・結果・めくる順（`GachaRevealModel`）は同じ**（演出の時間だけ）。
- 点滅は設定に関係なく常に**1秒間に3回まで**（REQ-A11Y-008）：繰り返す点滅（CSS の `infinite` なアニメーションでコントラストが変わるもの）は周期から数え、1回ずつの光（「伸びる！」・追い抜き・ムチの当たり）は `FlashLimiter`（どの1秒の窓でも3回まで、超えた分は光らせずに文字だけ）を通す。プロトタイプの点滅はすべて 2.5 回/秒以下（`test/a11y-flash.test.cjs`）。

### 41.7 ムチの長押し（REQ-A11Y-012、§27 との関係）
- `whipInput: "hold"`：押した瞬間はタップと同じ（発走前は START、発走後は WHIP）。押し続けている間は `WhipHold.Spacing` = max(`whipEffectTicks`, `whipDiminishWindowTicks`) + `InputAssistant.WhipSpacingExtraTicks`（§27.1 のムチだけおまかせと同じ間隔、既定 26tick）ごとに WHIP を1回。**自動で入るのは1レースに `WhipHold.MaxRepeats` = ムチの数 ÷ 2 − 1 回まで**（6本なら2回：一度押し続けると3本、残りはタップ）。離すと止まる。1tickに1回まで。チュートリアルではタップと同じ（押した瞬間だけ。REQ-UXS-004 はタップの前提、§27.2 と同じ扱い）。まったくタップできない人には §27 のムチだけおまかせがある。
- 送るのは普通の入力バイト（§3 の Cmd）だけ。長押しが作る入力の並びは、指でタップすれば必ず作れる並び（テストで、同じムチをタップした乗り手と 240/240 レースで同じ着順）。
- **自動の回数に上限がある理由**（作りながら測って分かったこと）：ムチの効く範囲は広く、決まった間隔で6本すべてを自動にすると、うまく押し始めた長押しは上手なタップと互角になった（一騎打ち 51.7%、§27.2 の「5割未満」を満たさない）。半分（3本）にすると、R11 と同じ道具で、最も上手に押し始めた長押しでも最良のタップの 0.77 倍の勝率、一騎打ち 43.8%、R11 の上手な乗り手との一騎打ち 48.7%、何もしない人には 99.2%（`AccessibilityTests.HoldIsCappedBelowSkilledPlay`）。課金で買えるものでもない。
- 同じテストで分かったこと：R11 の基準の `SkilledRider`（ムチの間隔＝減衰の窓 20tick）は最良のタップではなく、もっと広い間隔（約32tick）の方が勝つ（240レースで 48 → 57 勝）。R11 の比はやや弱い基準に対するもの（ぜんぶおまかせは最良のタップに対しても 27/57 で上限の内）。
- かんたん操作（§27）とは別の設定。補助がムチを持っている時（`whip`/`full`）は長押しも無視される（補助が捨てる）。相手には見えず、`res` の印も付けない（入力の種類は報告しない）。

### 41.8 KPI
| イベント | 送り手 | s1 | s2 | s3 |
|---|---|---|---|---|
| `a11y_setting_change` | サーバー（PUT で値が変わったキーごとに1行） | キー（`textSize` 等） | 新しい値（真偽は `on`/`off`） | `settings` |
個人を特定する情報は入れない（どの設定か・どの値かだけ）。同じ値の PUT では出ない。クエリは `docs/ops/kpi-queries.md`「アクセシビリティ」。

### 41.9 クライアント
- `Muchi.Client`：`AccessibilitySettings`（`Parse`・`ToJson`・`Defaults`、知らない値は既定値）、`ApiClient.GetAccessibilityAsync`・`SetAccessibilityAsync`、`PlayerView.Accessibility`、`AccessibilityTokens`（トークンの表、`Color(mode, token)`）、`TextScale`（`Factor`・`Px`）、`MotionPolicy`、`FlashLimiter`、`WhipHold`。
- `Muchi.Game`：`AccessibilityModel`（端末の写し・未送信の再送・`Changed` イベント・画面が結ぶ値 `TextScale`／`Palette`／`Motion`／`Haptics`／`Subtitles`／`OneHanded`／`WhipInput`・設定画面の行 `Rows()`・`ApplyTo(RaceInput)`）、`RaceInput.WhipMode`・`SetWhipHeld`・`Collect(RaceSim, slot)`。
- 画面が守ること：docs/handoff-codex-round15-accessibility.md。

## 42. プレイヤー主催カップ（player-hosted cups、REQ-CUP-001〜018、`server/src/domain/hostedCups.ts`・`hostedCupService.ts`・`server/src/do/cup.ts`、C# `HostedCups.cs`・`Muchi.Game.HostedCupModel`）
フレンドや支部の仲間と小さなカップを開く。主催者がコース・距離・馬場（フレンド部屋の条件 §REQ-ROOM-002 と同じ `RoomConditions`）・人数（`minCapacity`〜`maxCapacity`、既定 4〜8）・形式（1レース／3レースのポイント制）・開催の時間帯を選び、招待（フレンド・支部・参加コード）で集める。レースは**フレンド部屋の仕組み**（マッチメイカーの部屋作り、`RaceRoomDO`、`/v1/match/status` の割り当て、観戦）で走る。**ランク外**：レーティング・シーズン・ライバルの記録・デイリーミッション・パス・コイン・アイテムは一切動かない（経済の目標なし、E 番号なし）。報酬は見た目だけのトロフィー（プロフィールの棚）。

### 42.1 しくみ
- **レースのモード `cup`**（§2 の `mode` に追加、エンジンの `RaceMode.Cup = 7`）。既存のモードの設定・結果は変わらない（ゴールデンは不変）。設定は部屋の条件（`roomPreset` と同じ `roomGround`／`roomScene`）。人間だけ（CPU なし）、能力の上限なし、絆の補正なし（`friendBond` は使わない：主催者の有利をなくす）。`applyRace` は `mode: "cup"` を**記録だけ**にする（`appliedRaces`・マイリプレイ・`race_finish` の KPI だけ。報酬・ミッション・パス・統計・ライバル・殿堂・支部フィード・共同目標・かんたん操作の連敗は数えない）。
- **カップの状態**は1カップ1オブジェクト（`CupDO` `cup:<cupId>`）。参加コードの索引は同じクラスの `cupcode:<先頭の1文字>`。プレイヤーの状態（`cups`）には「参加中のカップ」（上限の判定）・招待・結果の履歴・トロフィーを持つ。
- **形式**：`single`（1レース）・`best_of_3`（3レース、着順のポイント `pointsByPlace`、既定 10/7/5/4/3/2/1/1）。順位はポイント → 最高着順 → 最終レースの着順 → 参加の早い順。1レースの時はそのレースの着順。来なかった人（no-show）・途中で抜けた人は以降 0 点。
- **主催者に有利をなくす**：主催者は他の人の馬を選べない（馬は各自が参加の時に選ぶ）。条件・人数・形式は**最初のレースの後は変えられない**（そもそも作った後に変える API はない。最初のレースの後は参加・招待もできない）。主催者が決めるのは「出走」の時刻だけ（開催の時間帯の中、参加者が `minEntrants` 人以上）。
- **締め切り**：`closesAt` を過ぎると、1レースも走っていなければ中止（`expired`）、走ったレースがあればその時点の順位で終わる（`partial: true`）。走っているレースは結果（か `raceTimeoutMinutes` の無効）を待ってから。終わった・中止のカップは `keepDays` 日後に消える（参加コードは終わった時に無効になる）。
- **主催者が抜ける** = カップを中止（`host_left`）。参加者は最初のレースの前なら抜けられる（枠が空く）。後は「棄権」（以降 0 点、順位には残る）。
- **解放**：新しい解放キーは作らない。フレンド部屋と同じ `friend_rooms`（2日目 or 10戦、§4.3）の解放で画面に出す（カップはフレンド部屋の延長）。
- **最後の1枠の取り合い**：参加は1つのオブジェクトの中で順に処理するので、同時に来た2人の片方だけが入り、もう片方は `409 CUP_FULL`（予約した枠はプレイヤー側で戻す）。

### 42.2 API（すべて要認証。冪等キーは `Idempotency-Key`）
| メソッド | パス | 冪等キー | 本文 → 応答 |
|---|---|---|---|
| GET | `/v1/cups` | | → `{ enabled, limits, active: CupView[], invites: CupInvite[], history: CupResult[], trophies }` |
| POST | `/v1/cups` | 必須 | `{ cupName, capacity, format, opensAt, closesAt, conditions?: RoomConditions, usePreset?: bool, horseId }` → `{ cup: CupView, created: bool }`。同じキーの再送は同じカップ（`created: false`）。主催者も参加者の1人（自分の馬 `horseId`）。`400 INVALID_NAME`／`NG_NAME`（名前）・`BAD_REQUEST`（人数・時間帯・条件）・`409 CUP_LIMIT`（主催中が `maxActivePerHost`、参加中が `maxEntriesPerPlayer`）・`409 DELETION_PENDING`・`403 BANNED` |
| GET | `/v1/cups/:cupId` | | 主催者・参加者・招待された人 → `CupView`。他は `404` |
| POST | `/v1/cups/lookup` | | `{ code }` → `CupPreview`（参加前の確認）。試行の回数を数える（`joinCodeAttemptsPerHour`、超えると `429 RATE_LIMITED`）。無い・終わったコードは `404 CUP_CODE_INVALID` |
| POST | `/v1/cups/join` | 必須 | `{ code?, cupId?, horseId }`（どちらか一方）→ `{ cup: CupView, joined: bool }`。コードは試行を数える。`cupId` は招待された人だけ。同じ人の再送は `joined: false`。`409 CUP_FULL`／`CUP_CLOSED`（締め切り・最初のレースの後・終わった）／`CUP_LIMIT`、ブロックの関係（どちらかがミュート、§28 の一覧）・BAN は `404 CUP_CODE_INVALID`（理由は言わない） |
| POST | `/v1/cups/:cupId/leave` | 必須 | → `{ left: bool, cancelled: bool, cup: CupView \| null }`。主催者なら中止。参加していなければ `left: false`（冪等） |
| POST | `/v1/cups/:cupId/invite` | | 主催者だけ、最初のレースの前。`{ friendIds?: string[], team?: true }` → `{ invited: number, skipped: number }`。フレンドでない人・ブロックの関係の人は数えずに飛ばす。`team: true` は主催者の支部の仲間全員。1カップ `invitesPerCup` 人まで。招待された人にはプッシュ `cup_invite` と招待の一覧 |
| POST | `/v1/cups/:cupId/start` | | 主催者だけ → `{ raceId, raceIndex, startAtMs }`。各参加者は `/v1/match/status` で部屋の割り当てを受け取る（フレンド部屋と同じ）。`409 CUP_NOT_READY`（時間帯の外・人数不足・前のレースが確定していない・全部走った）・`409 ALREADY_IN_RACE`（参加者の誰かが他のレース中）・`403 NOT_HOST` |
| POST | `/v1/admin/cups/:cupId/delete` | | 運用（operator 以上、監査ログ）`{ reason }` → カップを中止（`ops_deleted`）。参加者の一覧から消える |

### 42.3 形
```json
{ "cupId": "cup_k3m9…", "cupName": "金曜の夜カップ", "hostId": "p_1", "hostName": "トオル", "role": "host",
  "code": "K7PM-Q2XD", "format": "best_of_3", "capacity": 6, "racesTotal": 3, "racesDone": 1,
  "conditions": { "trackId": "aoba_turf_1600", "going": "good", "night": false, "weather": "sunny", "temperatureC": 18, "windKmh": 0 },
  "opensAt": 1794279600000, "closesAt": 1794290400000, "status": "running", "partial": false, "cancelReason": null,
  "entrants": [ { "playerId": "p_1", "displayName": "トオル", "horseName": "アイボウ", "withdrawn": false } ],
  "races": [ { "index": 0, "raceId": "cup-cup_k3m9-0-0", "status": "done", "places": { "p_1": 1 } } ],
  "standings": [ { "playerId": "p_1", "displayName": "トオル", "rank": 1, "points": 10, "places": [1] } ],
  "canStart": true, "minEntrants": 2 }
```
- `code` は主催者と参加者にだけ出す（`XXXX-XXXX`、`ABCDEFGHJKMNPQRSTUVWXYZ23456789` の8文字＝31^8 通り、暗号の乱数）。入力は大文字・小文字・ハイフンを問わない。
- `cupName`（プレイヤーが入力、1〜`nameMaxChars` 文字、NFKC、制御文字・URL 不可、NG 語は表示名と同じ一覧で `NG_NAME`）・`displayName`・`hostName`・`horseName` は**訳さない**（`PLAYER_TEXT_KEYS`）。
- `CupPreview` = `{ cupId, cupName, hostName, format, capacity, entrants: number, conditions, opensAt, closesAt }`（参加前なので他の人の名前は出さない）。
- `CupResult`（履歴）= `{ cupId, cupName, format, rank, points, entrants, at, status: "finished" | "cancelled", partial, trophy: "gold" | "silver" | "bronze" | null }`。トロフィーは順位 1〜3（参加者がその人数以上の時）。トロフィーは見た目だけで、何にも効かない。
- プロフィール（`publicProfile`）に `cupTrophies: { gold, silver, bronze }` を足す（数だけ、カップ名は出さない）。

### 42.4 設定 `progression.hostedCups`（リモート設定で変更可）
`{ enabled, minCapacity, maxCapacity, minEntrants, maxActivePerHost, maxEntriesPerPlayer, nameMaxChars, minWindowMinutes, maxWindowHours, maxLeadHours, joinCodeAttemptsPerHour, invitesPerCup, pointsByPlace[], raceTimeoutMinutes, keepDays, historyKeep }`。上限（`HOSTED_CUP_HARD_LIMITS`）：capacity 2..12、maxActivePerHost 1..5、maxEntriesPerPlayer 1..10、nameMaxChars 1..30、joinCodeAttemptsPerHour 1..60、invitesPerCup 1..50、pointsByPlace は 1..12 個の非増加の 0..100。起動時と各版で検証。

### 42.5 KPI
`cup_create`（サーバー、主催者、`s1` = format、`count` = capacity、`s2` = 支部に招待できるか `team`／`solo`）・`cup_join`（サーバー、参加者、`s1` = `code`／`invite`、`s2` = format）・`cup_finish`（サーバー、各参加者、`s1` = `finished`／`cancelled`、`s2` = format、`place` = 順位、`count` = 参加者数、`s3` = 中止の理由）。

### 42.6 アカウント削除
削除の手順に `cups` を足す（`replays` の後）：主催中のカップは中止（`host_deleted`）、参加中のカップは最初のレースの前なら外し、後なら名前を `DELETED_PLAYER_NAME` にして棄権にする。状態の一覧は最後の `wipe` で消える。

### 42.7 活動（§40）に書くところ（Round 16 の統合で実装：§40 の表の `cup_invited`・`cup_started`・`cup_finished`／`cup_cancelled`）
招待を受けた（`cupInvited`）・カップが始まった（最初のレースの割り当て）・カップが終わった／中止になった（`cupClosed`、順位とトロフィー）の3つ。

## 43. シーズンの振り返り（season recap、REQ-RECAP-001〜016、`server/src/domain/seasonRecap.ts`、C# `SeasonRecap.cs`（`RecapShare`）・`Muchi.Game.SeasonRecapModel`）
ランク戦のシーズン（JST の暦月、§13 `seasonIdFor`）が終わるたびに1回、さらにゲームの1年（`time.ts` のゲーム日、`progression.dayRollover` の 04:00 JST で切り替わる年）が終わるたびに1回、プレイヤーの**振り返り**を作る。1画面ずつめくって見られ、共有カードにできる。中身は**サーバーが確定させたデータだけ**から作る（推定・乱数・端末の申告は使わない）。コイン・アイテムは動かない（経済の目標なし、E 番号なし）。課金・支出の数字は一切出さない。

### 43.1 記録（`seasonRecap.acc`）とスナップショット
- プレイヤーの状態に**集計中の記録**を2つ持つ：`acc.season`（今のシーズン）・`acc.year`（今のゲーム年）。形 `RecapAcc`：`{ periodId, since, races, wins, top3, bestPlace, bestPlaceField, byHorse{horseId:{horseName,races,wins,first}}, byStyle{style:races}, streak, bestStreak, firstWin, bigWin, rival{win,lose,draw}, teamGoal, replaysSaved }`。
- 書くのは次の場所だけ（どれも1回だけのガードの内側）：
| 出どころ | 何を数える |
|---|---|
| `applyRace`（レースIDのガード内） | `races`・`wins`・`top3`・`bestPlace`（同じ着順なら頭数の多い方）・`byHorse`（`horseId` のある結果だけ）・`byStyle`（`details.style`）・連勝・`firstWin`・`bigWin`（頭数→先に勝った方）。数えるレースは殿堂の戦績（§34.1）・プレイヤー統計と同じ：ランク戦・イベント・大会、人間2人以上のフレンド戦。無効・チュートリアル・タイムアタック・週替わりチャレンジは数えない |
| `applyRace`／`taRecord` の支部の共同目標（§32 `playerGoalRace`・`playerGoalTa` が数えた時だけ） | `teamGoal`（`races + wins + taPb`） |
| ライバルの週の確定（§28 `settleWeek`、週ごとに1回） | `rival.win/lose/draw`（`not_enough`・`no_contest` は数えない） |
| マイリプレイの保存（§37 `commitSave`、同じレースは1回） | `replaysSaved` |
- 次のものは記録を使わず、もともと時刻つきで残っている確定データから期間で数える：タイムアタックの記録（`timeAttack.seasonBest`、シーズンは `seasonId`、年は記録の時刻 `at`）・殿堂入り（`hall.entries[].inductedAt`）・到達したクラス（`seasonHistory`）。
- **締め**：プレイヤーのトランザクションの最初（`rollSeason` の直後、`rollRecaps`）で、`acc.season.periodId` が今のシーズンと違えばそのシーズンの、`acc.year.periodId` が今のゲーム年と違えばその年のスナップショットを作り、新しい記録を始める。シーズンの終わりの集計ジョブ（REQ-SEASON-002 の `closeSeason`）もトランザクションなので、ランク戦を走った人は集計ジョブの時点で必ず作られる。ほかの人は次に開いた時に作られる（その間はレースが無いので中身は同じ）。
- **1プレイヤー・1期間に1つ**（`id` = `season:<YYYY-MM>`／`year:<YYYY>`）。同じ `id` があれば作らない（再試行・二重の締めでも1つ）。何も記録の無い期間（レース 0・ほかの数字も 0）は作らない。
- 集計ジョブが届けたクラス内の最終順位（`closeSeason` の `rank`）は、まだ `null` の時だけスナップショットに書く（1回）。その年のスナップショットがもう有れば、その年のクラスの行も選び直す。
- **「〜から」の正直な表示**：記録が期間の途中から始まった（この機能の公開日・その期間の途中で作ったアカウントではない時）なら `since`（記録を始めた時刻）を持ち、画面は「{date}からの記録です」と出す。締めの後に始める次の記録は期間の最初から（`since` なし）。
- **ゲーム年**：`gameDayKey(now, dayRule).slice(0, 4)`。1月1日の 04:00 JST（日付の切り替えの時刻）に切り替わる。シーズンは暦月（00:00）なので、1月1日 00:00〜04:00 のレースは新しいシーズン・前の年に入る（それぞれの決まりどおり）。
- 保存：スナップショットは小さく（数字・id・馬の名前だけ、1件 2 KB 未満）、シーズンは新しい方から `keepSeasons` 件・年は `keepYears` 件だけ残す。

### 43.2 中身（`RecapSnapshot`）
`{ id, kind: "season"|"year", periodId, from, to, builtAt, since|null, short, races, wins, top3, bestFinish{place,fieldSize}|null, rank{classId,nextClassId,finalRank|null,promoted}|null, horse{horseId,horseName,races,wins}|null, timeAttack{trackId,timeMs,horseName,courseBest}|null, style{style,races}|null, rival{win,lose,draw}|null, teamGoal, hall{count,horses[{horseName}]}, replaysSaved, moments[{kind,horseName|null,trackId|null,n|null,from|null,to|null,at}], openedAt|null, completedAt|null }`
- いちばん一緒に走った馬：`byHorse` のレース数 → 勝ち数 → 先に走った方。
- タイムアタック：期間の記録のうち、そのコースの自分の歴代最速（`allTimeBest` と同じセッション）を優先 → 新しい記録。コースどうしのタイムは比べない。
- よく使った脚質：レース数 → 脚質の順（逃げ・先行・差し・追込）。
- 到達したクラス：シーズンはそのシーズンのクラス・次のクラス（昇格なら `promoted`）・最終順位。年は期間のシーズンのうち最も上のクラス（昇格先も含む）→ その中の最もよい最終順位。
- 名場面（`moments`、最大 `momentsMax` 件、決まった優先順）：`promotion`（昇格）→ `hall`（殿堂入り、最初の1頭）→ `first_win`（期間の初勝利）→ `big_win`（いちばん頭数の多い勝利、8頭以上）→ `streak`（2連勝以上の最長）→ `ta_best`（歴代最速の更新）。無いものは作らない（足りなければ少ないまま、作り話はしない）。
- **短い版**：レースが `shortBelowRaces` 戦未満なら `short: true`。画面は「走ったレース」と（あれば）最高着順・いちばん一緒に走った馬・最後の一言だけ（空の画面は出さない）。
- 他のプレイヤーの名前は持たない（ライバルは勝敗の数だけ、支部は貢献の数だけ）。プレイヤー・馬の名前は訳さない（`horseName` は `PLAYER_TEXT_KEYS`）。

### 43.3 API（すべて要認証）
| メソッド | パス | 本文 → 応答 |
|---|---|---|
| GET | `/v1/recaps` | → `{ "enabled", "recaps": [ { "id", "kind", "periodId", "title", "short", "builtAt", "opened", "completed" } ], "unseen": id\|null }`（新しい順。`unseen` = まだ開いていない一番新しいもの） |
| GET | `/v1/recaps/:id` | → `RecapView`（43.4）。無い id は `404 NOT_FOUND` |
| POST | `/v1/recaps/:id/progress` | `{ "step": "open"\|"complete" }` → `{ "openedAt", "completedAt" }`。最初の時刻だけ残す（何度送っても同じ、冪等）。KPI `recap_open`／`recap_complete`（`isFirst`） |

### 43.4 画面の形（`RecapView`）
```json
{ "id": "season:2026-11", "kind": "season", "periodId": "2026-11", "title": "2026年11月シーズン", "short": false,
  "sinceNote": "2026-11-09からの記録です",
  "steps": [ { "key": "races", "label": "走ったレース", "value": "24", "unit": "戦", "notes": ["3着以内 9回"] },
             { "key": "horse", "label": "いちばん一緒に走った馬", "value": null, "horseName": "アイボウ", "notes": ["18戦5勝"] },
             { "key": "moments", "label": "名場面", "moments": [ { "kind": "first_win", "text": "シーズン初勝利（青葉競馬場 芝1600m）", "horseName": "アイボウ" } ] },
             { "key": "end", "label": "おつかれさまでした", "value": null } ],
  "shareCards": [ { "card": "summary", "title": "…", "headline": "24", "unit": "戦", "lines": ["…"], "horseName": null, "rank": false } ],
  "openedAt": null, "completedAt": null }
```
- `steps[].key`：`races`・`wins`・`best_finish`・`rank`・`horse`・`time_attack`・`style`・`rival`・`team`・`hall`・`replays`・`moments`・`end`。数字の無いものは出さない。文はサーバーが作り、英語の応答は境界で訳す（REQ-L10N）。
- 共有カード（`shareCards[].card`）：`summary`（レース・勝利）・`horse`（いちばん一緒に走った馬）・`moment`（最初の名場面）・`rank`（クラス・順位、`rank: true`）。端末は既存の `ShareCard`（REQ-UXS-071、ウォーターマーク「ムチ一閃」・`#ムチ一閃`）で絵にする。**順位を隠す**を選ぶと `rank: true` のカードと順位の行を外す。カードに入るのは自分の馬の名前と自分の数字だけ（プレイヤーID・表示名・他のプレイヤーの名前は入れない）。
- 文言の決まり：「倍」「お得」「今だけ」など煽り・賭けごとの言葉（賭け・配当・オッズ）・課金を促す言葉は使わない（テストで確認、英語も同じ）。購入・コインの数字は出さない。

### 43.5 設定 `progression.seasonRecap`（リモート設定で変更可）
`{ enabled, keepSeasons, keepYears, shortBelowRaces, momentsMax }`。範囲（`SEASON_RECAP_LIMITS`）：`keepSeasons` 1..24（`SEASON_HISTORY_KEEP` 以下）、`keepYears` 1..10、`shortBelowRaces` 1..20、`momentsMax` 2..3。起動時と各版で検証。無い／`enabled: false` なら作らず、`GET /v1/recaps` は `enabled: false` と空の一覧。

### 43.6 KPI
`recap_open`・`recap_complete`（サーバー、`s1` = kind、`s2` = periodId、`s3` = `short`／`full`、`isFirst`）・`recap_share`（クライアント、`props.kind` = `season`／`year`、`props.card` = `summary`／`horse`／`moment`／`rank`、`props.hideRank`）。

### 43.7 アカウント削除・その他
- 振り返りはプレイヤーの状態の中だけにある（R2・ディレクトリの写しなし）。アカウント削除の `wipe` で消える。削除の実行中（`deleting`）は新しく作らない。削除後に届いた `closeSeason` は何も作らない（`wiped`）。
- 解放キーは使わない（最初のシーズンが終わった後に出る）。プロフィールから過去の振り返りを開ける。
- アクティビティ（§40、Round 15）：スナップショットを作った時（`rollRecaps`）に「振り返りができました」の1件を書く場所（本ラウンドでは書かない）。

## 44. 厩舎の整理（horse roster organiser、REQ-ORG-001〜016、`server/src/domain/roster.ts`、C# `Roster.cs`（`RosterQuery`・`RosterSorter`）・`Muchi.Game.RosterOrganiserModel`）
所属馬が増えても目当ての馬をすぐ見つけ、まとめて片づけられるようにする。**並び替え・絞り込み・名前の検索・端末ごとに覚える表示・お気に入り・ロック・まとめて操作**。コインも素材も動かさない（経済の目標なし、balance-targets の新しい節も E 番号も使わない）。

### 44.1 まとめて操作できること（既存の1頭の決まりのまま）
- 今のゲームで馬を手放す操作は **引退（`POST /v1/horses/:horseId/retire`、REQ-HORSE-004）だけ**。引退は返金も素材も無い（繁殖馬になる、§34 の引退式が1回だけできる）。まとめて操作の `action` は **`retire` だけ**で、1頭の引退と同じ関数（`horses.ts` `retire` → `hallOfFame.ts` `noteHallRetire`）をそのまま順に呼ぶ。返金の合計はいつも **0**（`refund: { paidCoins: 0, freeCoins: 0, materials: {} , items: {} }`）で、確認画面にもそのまま「返ってくるもの：なし」と出す。
- **放出・変換（release / convert）は出さない**：1頭の放出・変換の決まり（返金の額）が今のゲームに無いので、まとめて操作だけに新しいコイン・素材の流れを作らない（作るなら経済の目標 E20・balance-targets 4.19 から決める別の仕事）。`action` は列挙なので後から足せる形にしておく（知らない値は `400 BAD_REQUEST`）。
- **所属馬の上限は今のゲームに無い**（「厩舎がいっぱい」の流れも無い）。上限ができたら、その案内からこの画面（絞り込み「現役」・並び「能力」の低い順）へつなぐ（44.7）。

### 44.2 ロックとお気に入り（REQ-ORG-004/005）
- `PUT /v1/horses/:horseId/lock` `{ "locked": bool }` → `{ "horseId", "locked" }`。`PUT /v1/horses/:horseId/favorite` `{ "favorite": bool }` → `{ "horseId", "favorite" }`。値を置き換えるだけなので何度送っても同じ（冪等、キー不要）。持っていない馬は `404 HORSE_NOT_FOUND`。現役でも引退でも付けられる。
- **ロックはサーバーで守る**：ロックした馬は **1頭の引退（`POST /v1/horses/:horseId/retire`）も `409 HORSE_LOCKED`**、まとめて操作でも断る（44.4 の `locked`）。配合・種付けは馬を消費しない（両親は残る）ので、ロックしていても使える。これから馬を消費する操作を足す時は `assertNotLocked` を通す（REQ-ORG-005）。
- 状態はプレイヤーの部屋の `roster.locked[]`・`roster.favorites[]`（馬IDの一覧、上限なし＝所属馬の数まで）。持っていない馬のIDは読む時に無視する。アカウント削除では状態ごと消える（手順の追加なし）。

### 44.3 一覧 `GET /v1/roster`（REQ-ORG-001〜003）
```json
{ "total": 42, "active": 30, "retired": 12, "locked": 3, "favorites": 5, "bulkMax": 50, "actions": ["retire"],
  "partnerHorseId": "h1",
  "horses": [ { "horseId": "h7", "name": "ミドリノカゼ", "templateId": "t_ssr_1", "rarity": "SSR", "sex": "male", "style": "sashi",
                "surface": "turf", "distMinM": 1600, "distMaxM": 2400, "goingAptitude": "any", "status": "active",
                "rating": 2880, "skillId": "sk_kirameki", "partner": false, "locked": true, "favorite": true,
                "acquiredSeq": 7, "bornAt": 1794000000000, "ageDays": 12, "races": 34, "wins": 11,
                "blocks": [], "appearance": { … } } ],
  "notice": "まとめて引退しても、コインや素材は返ってきません" }
```
- `rating`＝能力の合計（覚醒込みの能力 `effectiveStats` ＋調教の上乗せ `trained`、ランク戦の正規化の前）。`races`・`wins`＝§34 の戦績（確定したレースだけ、記録の無い馬は0）。`acquiredSeq`＝馬IDの通し番号（手に入れた順）。`ageDays`＝生まれてからのゲーム日数（04:00 JST 区切り）。
- `blocks[]`＝今まとめて引退すると断られる理由（44.4 と同じ値・同じ順）。画面はこれで選べない馬を最初から灰色にする。
- 並び替え・絞り込み・検索は **クエリでサーバーでも、端末でも同じ結果**（`server/src/domain/roster.ts` `applyRosterQuery` と C# `RosterSorter.Apply`、共通のテストベクタ `contracts/roster-query.vectors.json`）。クエリ（すべて任意）：
  | キー | 値 | 既定 |
  |---|---|---|
  | `sort` | `rating`・`aptitude`・`age`・`acquired`・`races`・`rarity`・`name` | `acquired` |
  | `dir` | `desc`・`asc` | `desc` |
  | `trackId`・`going` | `aptitude` の基準のコースと馬場（`going` は任意） | なし（`aptitude` は `trackId` が要る。無ければ `400`） |
  | `surface` | `turf`・`dirt`（`both` の馬はどちらにも入る） | すべて |
  | `band` | `sprint`（〜1400m）・`mile`（1401〜1800m）・`intermediate`（1801〜2400m）・`long`（2401m〜）。馬の距離適性の範囲が帯と重なれば入る | すべて |
  | `style` | `nige`・`senko`・`sashi`・`oikomi` | すべて |
  | `status` | `active`・`retired`・`all` | `all` |
  | `skill`・`partner`・`locked`・`favorite` | `1`（ある・そう）／`0`（無い・違う） | すべて |
  | `q` | 名前の一部（NFKC・ひらがな→カタカナ・長音の揺れをそろえて部分一致、最大 20 文字） | なし |
  | `favoritesFirst` | `1`・`0`：お気に入りを先頭にまとめる | `1` |
- **適性（`aptitude`）**：エンジンと同じ条件（RaceSim の適性外の罰・馬場の得意）から作る点数 `surface 一致（または both）200 ＋ 距離（範囲内 200、外は 200 − 外れたm ÷ 2、0 未満は 0）＋ 馬場 25 ×（fast の馬：−wet、heavy の馬：+wet、any：0）`。wet は 良/firm/fast＝−2・good＝0・稍重/yielding/muddy＝1・重/soft/sloppy＝2（`going` が無ければ馬場の項は 0）。印は ◎（芝ダ・距離とも合い、馬場の項 ≥ 0）／○（芝ダ・距離とも合う）／△（片方だけ）／×（どちらも合わない）。
- 並びの同点は `acquiredSeq` の小さい順（いつも同じ順）。名前の並びは馬の名前の文字コード順（読みの辞書は使わない）。
- **端末ごとに覚える**：選んだ並び・絞り込みはサーバーに保存しない。`RosterQuery.Encode()`（`v1;sort=rating;dir=desc;…`）を端末の設定（Unity の PlayerPrefs、プロトタイプは localStorage）に置き、知らないキー・値は既定に戻す（`Decode`）。

### 44.4 まとめて操作（REQ-ORG-006〜011）
1. **確認** `POST /v1/roster/bulk/preview` `{ "action": "retire", "horseIds": ["h7", "h9"] }` → 何も変えない。
```json
{ "action": "retire", "count": 2, "eligible": 1, "refused": 1,
  "horses": [ { "horseId": "h7", "name": "ミドリノカゼ", "ok": true, "reasons": [] },
              { "horseId": "h9", "name": "ハヤテ", "ok": false, "reasons": ["locked"] } ],
  "refund": { "paidCoins": 0, "freeCoins": 0, "materials": {}, "items": {} },
  "canConfirm": false, "confirmToken": "r1-6f3a9c01" }
```
2. **実行** `POST /v1/roster/bulk`（**冪等キー必須**）`{ "action", "horseIds", "confirmToken" }` → `{ "action", "count", "horses": [ { "horseId", "name", "ceremony" } ], "refund" }`。
- **全部か何もしないか**：1頭でも断る理由があれば `409 ROSTER_BULK_REFUSED`（`error.details.horses` に断った馬と理由、44.4 の形）で、**1頭も引退しない**（PlayerDO の1回の取引の中で全部を確かめてから順に引退する。途中で失敗すれば取引ごと捨てる）。
- `confirmToken`：確認の時の中身（action・馬IDの並び・各馬の状態・返金の合計）から作る短いハッシュ。実行の時に作り直して違えば `409 ROSTER_BULK_STALE`（確認の後に何か変わった。もう一度確認から）。安全のための鍵ではなく、「見せた一覧と違うものを実行しない」ための印。
- 同じ冪等キーの再送は最初の応答をそのまま返す（2回引退しない）。`horseIds` は 1〜`bulkMax`（50）頭・重複不可（`400 BAD_REQUEST`）。
- 断る理由（`reasons`、この順に全部並べる）：
  | 理由 | いつ |
  |---|---|
  | `not_found` | 持っていない馬 |
  | `locked` | ロックしている（44.2） |
  | `partner` | 最初の相棒（`flags.partnerHorseId`）。まとめては引退させない（1頭の引退の画面からなら今までどおりできる） |
  | `not_active` | もう引退している（引退は現役だけ） |
  | `on_loan` | 種牡馬として貸し出しに登録中か、貸し出しの手続き中（§ REQ-BREED-010） |
  | `in_training` | 調教の途中（開いているセッションの馬、期限内） |
  | `tournament_entry` | 大会に登録中（登録・登録の取り消し・大会の確定でプレイヤーの部屋に書く。記録が残っても大会の開始から 24 時間で外れる） |
  | `cup_entry` | プレイヤー主催カップ（§42）に参加中（作った・参加した時にプレイヤーの部屋の参加中の一覧 `cups.active` に馬を書く。カップが終わる・中止・抜けると外れる。Round 16 統合） |
  | `hall_pending` | §34 の引退式をまだ見ていない |
- アカウント削除の予約中も1頭の引退と同じく止めない（ルールを変えない）。
- KPI：`roster_bulk_action`（サーバー、実行できた時だけ、`s1` = action、`count` = 頭数）。

### 44.5 確認画面の決まり（クライアントが守る、REQ-ORG-010）
- 2段階：選ぶ → 確認シート（**選んだ馬を全部**名前・レア度・理由つきで並べ、返ってくるものの合計（引退は「なし」）を出す）→ 実行。元に戻す（undo）は無いので、シートに「元に戻せません」と書く。
- 「やめる」と「引退させる」は**同じ大きさ**で並べ、どちらも既定の選択にしない。断られる馬が1頭でもいれば実行のボタンは押せず、その馬を外すボタンを出す。
- 馬の名前はプレイヤーが付けたもの（英語でも訳さない）。

### 44.6 KPI（REQ-ORG-013）
- `roster_sort`（クライアント、`props: { sort, filters }`：並びのキーと使っている絞り込みの数 0〜10。並びか絞り込みを変えた時、1秒に1回まで）→ `s1` = sort、`value` = filters。
- `roster_bulk_action`（サーバー、44.4）。

### 44.7 クライアント（REQ-ORG-014/015）
- `Muchi.Client` `ApiClient.GetRosterAsync(RosterQuery)`・`SetHorseLockAsync`・`SetHorseFavoriteAsync`・`PreviewBulkAsync`・`RunBulkAsync`、`RosterQuery`（Encode/Decode）・`RosterSorter`（並び・絞り込み・検索・適性、サーバーと同じ）、`AnalyticsEvent.RosterSort`。
- Unity のゲーム層 `RosterOrganiserModel`：一覧の行、並び・絞り込みのシート、検索、ロック・お気に入りの切り替え、まとめて選ぶ、確認シート。端末の設定は `IPrefs`（PlayerPrefs）に `muchi.roster.view`。
- 大会の登録（`TournamentPlayers.noteEntry`/`clearEntry`）：`TournamentsService.register`/`unregister` が成功した後に呼ぶ（任意のポート、失敗しても登録は成功のまま）。
- §40 の活動の一覧には書かない（Round 16 統合の決定）：一覧は「留守の間に起きたこと」で、まとめての引退は自分がその場で確かめた操作（確認シートと結果で見えている）。

## 45. 次にやること（ホームの案内カード、REQ-NEXT-001〜014、`server/src/domain/nextAction.ts`、C# `NextAction.cs`・`Muchi.Game.NextActionModel`、docs/planning/06 §6.1）
ホームに「次にやること」を**主カード1枚＋小さなチップ最大2つ**で出す。戻ってきた人も始めたばかりの人も、ホームを開けば次の1手が分かるようにする（06 §2.2 F10「次にやることが分からない」）。何を出すかはプレイヤーの状態の要約からの**純粋な関数**で決まり（同じ状態・同じ時刻なら同じ結果）、優先順位はデータ（`progression.nextActions`、起動時と各版で検証）にある。コイン・アイテムは動かない（経済の目標なし、E 番号なし）。

### 45.1 種類（`kind`）と開く画面（`screen`）
開く画面はコードで種類ごとに決まっていて、設定では変えられない（設定から「ショップへ」のカードは作れない）。

| kind | 出る条件（要約から） | screen | 期限 `deadlineAt`（データの本物の時刻だけ） |
|---|---|---|---|
| `first_race` | オンボーディング中（45.3）。これだけを出す | `race` | なし |
| `login_bonus` | `login_bonus` が解放済みで、今日のゲーム日の分が未受け取り | `login_bonus` | なし |
| `missions_claim` | 達成して未受け取りのデイリーミッションがある（`count` = 本数） | `missions` | なし |
| `pass_claim` | シーズンパスの受け取れる段がある（無料の列、プレミアムは有効な時だけ。`count` = 段数）。購入の案内ではない | `season_pass` | なし |
| `gift_expiring` | プレゼントボックスに `threshold` 日以内に期限の来る物がある（`count` = 件数）。**開くだけ**（カードから受け取らない） | `gift_box` | 一番早い `expiresAt` |
| `training_open` | 調教の途中のセッションがある | `training` | セッションの `expiresAt` |
| `missions_close` | 未達成のデイリーミッションのうち、残りが `threshold` 以下のものがある（`count` = 一番近いものの残り） | `missions` | なし |
| `exchange_closing` | 交換所のポイントが残っていて、交換所が `threshold` 日以内に閉まる（`refId` = イベントID、`count` = ポイント）。残りは閉まる時に素材になる（§30、失われない） | `event_exchange` | `closesAtMs` |
| `feature_unlocked` | `features` に挙げた解放キーが今日のゲーム日に開いた（`featureKey`） | `feature` | なし |
| `rival_week` | 今週のライバルがいて、今週のランク戦がまだ0回 | `rival` | `weekEndsAt` |
| `weekly_challenge` | 週替わりチャレンジが解放済みで、今週の未クリアがあり、今日の挑戦回数が残っている（`count` = 未クリア数） | `weekly_challenge` | 週の `endsAt` |
| `team_goal_near` | 支部の共同目標の次の段まで `threshold` 単位以下（`count` = 残り）。`GET /v1/home/next` だけ（支部の値は TeamDO にある） | `team_goal` | 週の `endsAt` |
| `horse_goal_near` | ピン留めした馬（§53.3）の今の目標が `have ≥ 1` で残りが `threshold` 以下（`count` = 残り、`refId` = 馬ID）。Round 18、§53.4 | `horse_goals` | なし |
| `training_slots` | 調教の今日の回数が残っている（`count`） | `training` | なし |
| `first_win` | 今日の初勝利ボーナスが残っていて、今日まだ1着がない | `race` | なし |
| `scout_ticket` | スカウト券を持っている（`count` = 枚数）。**チップだけ**（主カードにはならない）。持っている券を使う案内で、購入・有償のスカウトの案内ではない | `scout` | なし |
| `race` | いつでも（最後の受け皿。主カードが他に無い時） | `race` | なし |

- 主カードにしてはいけないもの：購入（ショップ・パスの購入・有償スカウト）。`scout_ticket` はチップだけ（コードで固定）。有償の商品・価格・割引を出す種類は無い。
- 文言はクライアントが種類と数から作る（日本語＋英語、`ui-en.json`／`proto-en.json`）。期限は「11月12日 4:00まで」のように**日付と時刻**で出し、カウントダウン・「今だけ」「残りわずか」などの煽りは出さない。
- **アクティビティ（§40）の未読はカードにしない**（Round 16 統合の決定）：未読の数はホームのベル（`activity.unread`）がいつも出しているので、カードやチップに同じことを重ねない（新しい種類はクライアント3つ・設定・KPI に広がり、安くない）。カップの招待・結果・振り返りの知らせはアクティビティの項目（§40 の表）から開く。

### 45.2 選び方（`computeNextActions`、純粋関数）
1. 要約から当てはまる候補を作る（45.1）。
2. 今日のゲーム日に閉じた種類（45.4）を除く。
3. `priority` の大きい順、同じなら 45.1 の表の順で並べる（`priority` は設定で重複不可なので、実際には表の順は使わない）。
4. 先頭のうちチップだけの種類でない最初の1つが主カード。残りの先頭から `maxChips`（0〜2）個がチップ。`race` は主カードの時だけ出す（チップにはしない）。
5. 削除の予約中（REQ-UXS-040）は `race` だけ。

### 45.3 オンボーディングとの関係（06 §2.3 FTUE）
- 相棒がまだいない（`flags.partnerHorseId` なし）か、チュートリアル以外のレースが `onboardingRaces`（既定 2 = デイリーミッションの解放と同じ）回未満の間は、`first_race`（「相棒で、本番のコースへ」）だけを出す。チップは出さず、閉じることもできない。FTUE の流れ（命名 → 無料10連 → 2戦目）と競わない。
- 解放されていない機能の種類は出さない（`unlock` が無い機能、§4.3 の表のとおり）。
- 復帰キャンペーンの歓迎画面（§20）とお知らせのカードは今までどおり先に出る（ホームの左のカード枠）。次にやることのカードは別の場所（ホームの下の中央）に出す。

### 45.4 今日は閉じる
- `POST /v1/home/next/dismiss` `{ "kind" }` → `NextActionsView`。その種類を**今日のゲーム日（既定 4:00 JST 切り替え、REQ-DAY-001）の間**出さない。翌ゲーム日に戻る。値を足すだけなので何度送っても同じ（冪等、冪等キー不要）。
- `first_race`・`race` は閉じられない（`409 NOT_ELIGIBLE`）。知らない種類は `400 BAD_REQUEST`。
- `feature_unlocked` は解放を最初に見たゲーム日だけ出る（翌日には消える）。解放を見た日は状態の `nextAction.features` に覚える（ブートストラップ・`GET /v1/home/next`・閉じる時）。この仕組みより前からの状態は、最初に見た時点で開いている機能を「前から開いていた」とみなす（古いプレイヤーに全部の機能を「新しく開いた」と出さない）。

### 45.5 API（要認証）
| メソッド | パス | 本文 → 応答 |
|---|---|---|
| GET | `/v1/home/next` | → `NextActionsView`（支部に入っていれば共同目標も見る） |
| POST | `/v1/home/next/dismiss` | `{ "kind": NextKind }` → `NextActionsView` |

`/v1/player/bootstrap`・`GET /v1/player` の `nextActions` にも同じ形が入る（共同目標を除く。ホームの最初の描画用）。

```json
{ "enabled": true, "day": "2026-11-09", "onboarding": false,
  "primary": { "kind": "gift_expiring", "screen": "gift_box", "count": 2, "deadlineAt": 1794614400000, "featureKey": null, "refId": null, "dismissible": true },
  "chips": [ { "kind": "rival_week", "screen": "rival", "count": null, "deadlineAt": 1794880800000, "featureKey": null, "refId": null, "dismissible": true } ],
  "dismissed": ["missions_close"], "nextDayAt": 1794697200000 }
```
- `nextDayAt` = 次のゲーム日の始まり（クライアントの予備の計算で、閉じた種類を戻す時刻。画面には出さない）。
- `enabled: false`（設定なし・無効）の時は `primary: null`, `chips: []`。

### 45.6 クライアントの予備（オフライン）
サーバーが計算する。クライアントは最後に受け取った `NextActionsView` を覚えておき、取れない時（オフライン・エラー）はそれを使う：`deadlineAt` を過ぎた物を外し、端末で閉じた種類（同じゲーム日の間、`Muchi.Game.GameDay`）を外し、覚えた `day` が今日のゲーム日と違えば（日をまたいだ）`race` だけにする。何も無ければ `race`。オフラインのレース（練習）はいつでも押せる（06 §6.1）。

### 45.7 設定 `progression.nextActions`（リモート設定で変更可）
`{ enabled, maxChips (0..2), onboardingRaces (0..20), rules: [{ kind, priority (0..1000、重複不可), threshold?, features? }] }`。
- `kind` は 45.1 の種類だけ・重複不可。`race` は必須（受け皿）。`first_race` は書かない（オンボーディングはコードで決まる）。
- `threshold`：`gift_expiring`（日 1..14）・`exchange_closing`（日 1..7）・`missions_close`（残り 1..10）・`team_goal_near`（残り 1..100）・`horse_goal_near`（残り 1..10、§53.4）だけが持ち、他の種類には書けない。
- `features`：`feature_unlocked` だけ。§4.3 の解放キーのうち、`shop`・`season_pass`・`scout`（購入・ガチャの画面）は書けない。

### 45.8 KPI
`next_card_view`（クライアント、`props.kind`・`props.slot` = `primary`／`chip`。同じ種類は1ゲーム日に1回）・`next_card_tap`（クライアント、`props.kind`・`props.slot`）・`next_card_dismiss`（サーバー、`s1` = kind、閉じた時に1回）。クエリは `docs/ops/kpi-queries.md`。

### 45.9 アカウント削除
状態の `nextAction`（今日閉じた種類・機能を見た日）は最後の `wipe` で消える。他の場所に写しは無い。

## 46. メンテナンス・強制アップデート（REQ-MNT-001〜016、`server/src/domain/maintenance.ts`、C# `Maintenance.cs`（`MaintenanceInfo`・`UpgradeInfo`・`MaintenanceStatus`・`ClientVersion`）・`Muchi.Net.EngineInfo`・`Muchi.Game.MaintenanceModel`、docs/handoff-codex-round17-maintenance.md）
運用が**時間を決めて機能を止める**（メンテナンス）仕組みと、**古いアプリを止めて更新へ案内する**仕組み。どちらもリモート設定（§22 の版・有効化・切り戻し・監査）の1区画 `maintenance` で動き、アプリの更新もデプロイも要らない。E番号なし（経済は変わらない。お詫びの補填は既存のプレゼントボックスの補填 §26・REQ-OPS-026 の上限のまま、題名 `ops_compensation_maintenance`「メンテナンスのお詫び」。有償コインはプレゼントボックスに入らない）。

### 46.1 リモート設定 `maintenance`（REQ-MNT-001/002、`ops/config.ts` で他の区画と同じく検査）
```json
{ "maintenance": {
    "windows": [
      { "id": "m-1112", "startAtMs": 1794416400000, "endAtMs": 1794430800000, "announceAtMs": 1794330000000,
        "scope": "all",
        "message": { "ja": "11/12 2:00〜6:00 にメンテナンスを行います。", "en": "Maintenance on 11/12 from 2:00 to 6:00 (JST)." } },
      { "id": "m-gacha", "startAtMs": 1794500000000, "endAtMs": 1794503600000, "scope": ["gacha", "shop"], "message": { "ja": "…", "en": "…" }, "cancelledAtMs": 1794400000000 }
    ],
    "clientVersions": {
      "ios":     { "min": "1.2.0", "recommended": "1.3.0", "storeUrl": "https://apps.apple.com/jp/app/id…" },
      "android": { "min": "1.2.0", "recommended": "1.3.0", "storeUrl": "https://play.google.com/store/apps/details?id=…" } },
    "minEngineLevel": 1 } }
```
- 無ければ既定（窓なし、両 OS とも `0.0.0`・`storeUrl: null`、`minEngineLevel: 1`）＝何も止めない。区画を出すと**全体の置き換え**。
- 時刻は epoch ms で持ち、運用コンソールでは日本時間（`YYYY-MM-DDTHH:mm`）で入れて見る。`announceAtMs` 省略＝開始の24時間前。
- `scope`：`"all"`、または止めるグループの配列（§46.2 の表。`core` は `"all"` でだけ止まる）。
- 検査（どれか1つでも版ごと `CONFIG_INVALID`）：`id` は `[a-z0-9_-]{1,40}` で重複なし、`endAtMs > startAtMs`、長さ 5分〜24時間、`announceAtMs` は開始より後でなく14日より前でない、**窓どうしは重ならない**（取り消した窓は取り消した時刻で終わる）、窓は20個まで、`message` は日本語・英語とも必須（日本語 200 字・英語 400 字まで）。メッセージにはショップの表現の決まり（「倍」「お得」「今だけ」「残りわずか」「通常価格」）と公営競技の言葉（`bettingWords.ts`）を使わない。英語は他の文と同じ英語の表現チェック（REQ-L10N-008）。
- 各窓の英語は、日本語のメッセージをキーにして言語表（`locale.en`）へ足す（応答の境界で英語になる、§23）。
- `clientVersions`：`x.y.z`、`recommended ≥ min`。どちらかが `0.0.0` より上なら `storeUrl` 必須。`storeUrl` は https で、iOS は `apps.apple.com` / `itunes.apple.com`、Android は `play.google.com` だけ（更新ボタンが他所へ飛ばないように）。
- `minEngineLevel`：1〜1000。ランク戦などのレースに入れる最低のエンジン（§46.4）。

### 46.2 止まるもの・止まらないもの（REQ-MNT-003）
| グループ | パス |
|---|---|
| `gacha` | `/v1/gacha/*`・`/v1/items/*`（チケット） |
| `shop` | `/v1/shop/*`・`/v1/silks/parts/*`・`/v1/commentary/packs/*` |
| `ranked` | `/v1/match/*`・`/v1/friend-rooms/*`（フレンド部屋の再戦 `/v1/friend-rooms/rematch/:raceId` §63 を含む：レースを始める口。R21 統合）・`/v1/race/*`・`/v1/races/*` |
| `teams` | `/v1/teams/*`（定型チャット §52 の候補・投稿を含む：投稿先の支部フィードと同じグループ。Round 18 統合）・`/v1/league/*`・`/v1/stamps` |
| `events` / `tournaments` / `training` | `/v1/events/*` / `/v1/tournaments/*` / `/v1/training/*` |
| `time_attack` | `/v1/time-attack/*`・`/v1/challenges/*` |
| `social` | `/v1/friends/*`（おすすめフレンド §49 を含む）・`/v1/invite*`・`/v1/stable*`・`/v1/rival*`・`/v1/showcase*`（§62、Round 21）・`/v1/links`（リンクを作る・一覧・取り消す `GET`／`POST /v1/links`・`DELETE /v1/links/:token`、§63） |
| `cups` | `/v1/cups*`（主催カップ §42、Round 17 統合で追加。レースのグループ） |
| `core` | それ以外のすべて（アップデートのお知らせ `/v1/release-notes*` §64・予定表 `/v1/calendar*` §65（R21 統合）・プレイヤー・馬・ミッション・プレゼントボックス・振り返り §43・厩舎の整理 §44・次にやること §45・馬ごとの目標 §53・練習レースのカタログ §50（止まっても端末の写しで練習できる）…） |

**どの窓でも・どのバージョンでも止まらない**（`EXEMPT_ROUTES`）：
- 状態を見る口：`GET /v1/health`・`/v1/config`・`/v1/maintenance`・`/v1/assets/catalog`・`/v1/visuals`。
- **購入レシート `POST /v1/shop/purchase`・ストアのサーバー通知 `POST /v1/store/notifications/:platform`・`GET /v1/shop/store-account`**：ストアで支払いが済んだ購入は必ず付与する（資金決済法：有償コインの購入を失わない）。メンテナンス中でも、古いアプリからでも受け付ける。新しい購入の始まり（`purchase-intent`）は `shop` の窓で止まる。
- リワード広告のサーバー通知 `GET /v1/ads/ssv/admob`（視聴はもう済んでいる）。
- 退会 `DELETE /v1/player`・取り消し `POST /v1/player/deletion/cancel`（権利なので止めない）。
- **アカウントとプライバシーの口**（Round 19・20 統合）：引き継ぎコード（§54）`GET`／`POST`／`DELETE /v1/transfer/code`・`POST /v1/transfer/redeem`、規約・プライバシーポリシーへの同意 `POST /v1/player/consent`（REQ-UXS-001。R20 統合で `core` から外した：ポリシーの版が上がった後の再同意を窓で閉じ込めない）、広告・分析の選択（§58）`GET`／`PUT /v1/privacy/choices`・`PUT /v1/privacy/platform`・`POST /v1/privacy/prompt-shown`、クライアントのエラー報告（§60）`POST /v1/client-errors`、ログイン中の端末とセキュリティ（§70、Round 23）`GET /v1/account/devices`・`POST /v1/account/devices/checkin`・`POST /v1/account/devices/:sessionId/signout`・`POST /v1/account/devices/signout-others`・`GET /v1/account/security-log`（乗っ取りへの対応はどの窓でも・古いアプリからでも止めない。コインを動かさない。止めるのは `progression.devices.enabled`）。レビュー依頼（§59）`/v1/review-prompt*` と通知の設定 `/v1/push/preferences`（§61 の `reminders` を含む）は `core`（`all` の窓で止まる）。
- **個人データの開示・ダウンロード**（§51、Round 18 統合）：`GET`／`POST /v1/player/data-export`・`GET /v1/data-export/file`。退会と同じく法律上の権利なので、どの窓でも・古いアプリからでも止めない（準備はプレイヤーのアラームで動き、ダウンロードは署名つきリンク）。
- **進行中のものの確定**：レースのソケット `GET /v1/race/:raceId/ws`（始まったレースは最後まで走り、`final` まで確定する）、`POST /v1/time-attack/submit`・`/v1/challenges/weekly/submit`・`/v1/training/:sessionId/finish`、待ち行列から抜ける `POST /v1/match/cancel`・`/v1/events/:eventId/cancel`。
- KPI の送信 `POST /v1/analytics/events`（`maintenance_block`・`upgrade_prompt` はここを通る）と購入履歴 `GET /v1/history/*`・`POST /v1/history/support-ticket`。
- 管理API `/v1/admin/*`（運用はメンテナンス中に作業する）。cron（`scheduled`）も止まらない。
- **リンクを開く口**（§63、R21 統合）：`POST /v1/links/resolve` は止めない。窓の間・古いアプリからは、行き先の状態（`maintenance`／`update_required`）を答えの `state` で返し、リンクは捨てない（その画面がいつ開けるかを言う）。`/v1` の外にある Web の代わりのページ `GET /l/:token` と、ユニバーサルリンク・App Links の検証ファイル `GET /.well-known/apple-app-site-association`・`/.well-known/assetlinks.json` は入口の検査の外（窓の間も OS の検証が切れない）。
- **サポートへの道**（Round 17 統合で決めたこと）：ヘルプセンター（§48）の `GET /v1/help`・`/v1/help/articles/:articleId`・`/v1/help/search`・お問い合わせ `GET/POST /v1/help/inquiries`・`GET /v1/help/inquiries/:ticketId`・`POST /v1/help/inquiries/:ticketId/read`、通報（§47）`GET /v1/reports/options`・`POST /v1/reports`、ブロック `GET/PUT/DELETE /v1/blocks*`。メンテナンス中も古いアプリからも、運営に知らせる・相手を避ける手段は閉じない（記事の「役に立った」`POST /v1/help/articles/:id/feedback` はサポートではないので止まる）。
- **主催カップ**（§42）：窓が `cups`（か `all`）を含む間は作成・参加・次のレースの出走が止まる。走っているカップのレースはソケットと結果の確定（Durable Object の中の通知）で最後まで確定し、順位に入る。窓の間に `closesAt` を過ぎたカップは §42 のとおり走ったところまでで終わる（`partial`）。

### 46.3 1回だけの入口の検査と応答（REQ-MNT-006/007）
Worker の `handle` が、ルートを探す前に1回だけ調べる（`gateRequest`）。**入口を通った要求は最後まで動く**：窓が始まっても途中で切らない（ガチャ・購入・受け取りは DO の1つのトランザクションで終わる）。順番：
1. 止まらない口 → そのまま。
2. **バージョン**：`x-client-platform`（`ios` / `android`）と `x-client-version`（`x.y.z`）が両方あり、`min` より古い → **426 `UPGRADE_REQUIRED`**（待っても直らないので窓より先）。
3. **エンジン**：レースのグループ（`ranked`・`events`・`tournaments`・`time_attack`・`cups`）で `x-engine-level` が `max(minEngineLevel, ENGINE_LEVEL)` より小さい → 426 `UPGRADE_REQUIRED`（`reason: "engine"`）。
4. **窓**：開いている窓（`startAtMs ≤ 今 < 終わり`、終わり＝`endAtMs` か `cancelledAtMs` の早い方）がそのグループを含む → **503 `MAINTENANCE`**。

ヘッダーの無い要求（Round 17 より前のアプリ、ボット、サーバー間）はバージョンとエンジンの検査を通る（窓は効く）。

```json
503  Retry-After: 12600   Cache-Control: no-store
{ "error": { "code": "MAINTENANCE", "message": "メンテナンス中です",
  "details": { "windowId": "m-1112", "group": "gacha", "scope": "all", "startAt": 1794416400000, "endAt": 1794430800000,
               "endsAtJst": "11/12 06:00", "retryAfterSec": 12600, "message": "11/12 2:00〜6:00 にメンテナンスを行います。" } } }

426
{ "error": { "code": "UPGRADE_REQUIRED", "message": "アプリを最新版に更新してください",
  "details": { "reason": "version", "platform": "ios", "version": "1.1.0", "minVersion": "1.2.0", "recommendedVersion": "1.3.0",
               "storeUrl": "https://apps.apple.com/jp/app/id…" } } }
```
- `?lang=en` / `Accept-Language: en` なら `message` と `details.message` は英語（"Under maintenance"、窓の英語）。`reason: "engine"` の時は「レースに参加するにはアプリの更新が必要です」と `engineLevel`・`minEngineLevel`。
- 503 の他の原因（`VERIFIER_UNAVAILABLE` など）と区別できるのは `code` だけ。クライアントは `MAINTENANCE` を**再試行しない**（`Retry-After` まで待つ）。

### 46.4 レースの握手（REQ-MNT-008、§4 の後方互換な拡張）
- `hello` に任意の `engine`（整数 1〜1000、C# `Muchi.Net.EngineInfo.Level`、今は 1）。新しいアプリは必ず送る。
- 部屋はチケットを確かめた後、`engine` がそのレースに要る水準（`ENGINE_LEVEL`）より小さければ `{"t":"err","code":"VERSION_MISMATCH"}` を送り、close **4026 `version mismatch`** で閉じる（席に着かない）。`engine` の無い `hello`（古いアプリ・ボット・検証）は今までどおり。
- §4.1 の close code に 4026 を足す：クライアントは再接続しない。`Failed`、`FailureReason` = `VERSION_MISMATCH`、更新画面へ。
- 待ち行列に入る前の HTTP（§46.3 の 3）で同じ水準を先に調べるので、ふつうは部屋まで来ない。部屋の検査は抜け道を塞ぐ二重の守り。エンジンの水準は、レースの計算の形が変わる時に C# と TS で一緒に上げる（今のルールセットの結果は変わらない。ゴールデンも同じ）。
- 新しいキー `engine` は部屋の厳密なスキーマ（`clientMessageSchema`）に足した。**Worker を先に出し、そのあとアプリ**（古い Worker は知らないキーの `hello` を `BAD_MESSAGE` で断る）。いつもの「検証サーバー → Worker → ストアのアプリ」の順なので特別な手順は無い。

### 46.5 `GET /v1/maintenance`（認証なし、止まらない、REQ-MNT-004/005）
```json
{ "serverNowMs": 1794330000000,
  "active":   [],
  "upcoming": [ { "id": "m-1112", "scope": "all", "startAt": 1794416400000, "endAt": 1794430800000, "announceAt": 1794330000000,
                  "startJst": "11/12 02:00", "endJst": "11/12 06:00", "message": "11/12 2:00〜6:00 にメンテナンスを行います。", "status": "announced" } ],
  "client": { "platform": "ios", "version": "1.2.1", "status": "recommended", "minVersion": "1.2.0", "recommendedVersion": "1.3.0",
              "storeUrl": "https://apps.apple.com/jp/app/id…", "minEngineLevel": 1 } }
```
- `active`：今開いている窓。`upcoming`：お知らせの時刻を過ぎ、まだ始まっていない窓（取り消した窓は出ない）。早い順。
- `client.status`：`ok` / `recommended`（推奨より古い。任意の更新の案内）/ `required`（最低より古い）/ `unknown`（ヘッダーが無い・他の OS・読めない番号）。
- アプリは起動時・ホームに戻った時にこれを読み、ホームのお知らせ帯（予定の窓）と推奨の更新の案内を出す。
- **新着情報（§20）**：お知らせの時刻を過ぎた窓は、終わるまで `GET /v1/whats-new` に `kind: "maintenance"`・`feature: "maintenance"`・題名「メンテナンスのお知らせ」・本文＝窓のメッセージ・`endsAt`＝終わりの項目として出る（見た後は出ない）。押すとメンテナンスのお知らせを開く。アクティビティ（§40）には書かない（自分に起きたことではない）。

### 46.6 運用コンソール（REQ-MNT-011、`/v1/admin/maintenance*`、`tools/ops-console` の「メンテナンス」）
| メソッド・パス | 役割 | 内容 |
|---|---|---|
| `GET /v1/admin/maintenance` | viewer | 有効な版の窓（状態 `scheduled`・`announced`・`active`・`ended`・`ended_early`・`cancelled`、JST の時刻、止まるグループ）と対応バージョン |
| `POST /v1/admin/maintenance/preview` | viewer | `{ window }` の検査結果と、プレイヤーに見えるお知らせ帯（日本語・英語）。何も保存しない |
| `POST /v1/admin/maintenance/windows` | admin | `{ window: { id, startJst, endJst, announceJst?, scope, message }, reason }`。過去に始まる窓は 400（緊急は開始＝今） |
| `POST /v1/admin/maintenance/windows/:id/cancel` | admin | 始まる前なら取り消し、実施中なら今で終わり（`cancelledAtMs` = 今）。終わった窓は 409 |
| `PUT /v1/admin/maintenance/client-versions` | admin | `{ clientVersions, minEngineLevel?, reason }` |

- 変更はどれも**有効な版から `maintenance` だけを置き換えた新しい版**を作って今すぐ有効にする（他の区画は変わらない。§22 の検査・監査ログ・切り戻しがそのまま効く）。他の版の有効化が予約されている時は 409（その版が後で効くとこの変更が消えるため。先に取り消すか有効にする）。各 isolate はリモート設定を30秒持つので、反映は30秒以内。
- 書き込みは理由（3〜500字）が必須で、監査ログに前後の値と一緒に残る（`maintenance.schedule`・`maintenance.cancel`・`maintenance.versions`）。

### 46.7 デプロイとの関係（REQ-MNT-010、docs/ops/deploy.md §7.2）
- ふつうのデプロイ（「検証サーバー → Worker」、§7.1）は止めずに出せる。止める必要があるのは、出している間に古い Worker と新しい Worker が混ざると困る変更（DO のデータの形を変える移行、ストアの設定の切り替え など）だけで、その時は**先にメンテナンスの窓を予定してから**、窓の中で「検証サーバー → Worker」の順に出す。窓の範囲はその変更が触るグループだけにする（購入レシートはいつも通る）。
- 切り戻しも同じ窓の中で逆の順（Worker → 検証サーバー）。終わったら窓を「今すぐ終える」で閉じる。

### 46.8 KPI（REQ-MNT-013、クライアントのイベント）
| イベント | いつ | s1 | s2 | s3 |
|---|---|---|---|---|
| `maintenance_block` | 503 `MAINTENANCE` を受けた（窓 × グループごとに1回、アプリの起動ごと） | グループ | 窓の id | — |
| `upgrade_prompt` | 更新の案内を出した／押した | `required` / `recommended` / `engine` | `shown` / `store` / `later` | `ios` / `android` / `other` |

個人を特定する情報は入れない。クエリは `docs/ops/kpi-queries.md`「メンテナンス・強制アップデート」。

### 46.9 クライアント
- `Muchi.Client`：`ApiClientOptions.AppVersion`・`Platform`（`ios`/`android`）を設定すると全要求に `x-client-platform`・`x-client-version` を、`x-engine-level` はいつも付ける。`ApiClient.Call` の**1か所**で 503 `MAINTENANCE` と 426 `UPGRADE_REQUIRED` を扱う：再試行しない、`MaintenanceException`（`Info`：`MaintenanceInfo`）／`UpgradeRequiredException`（`Info`：`UpgradeInfo`）を投げ、イベント `MaintenanceDetected`／`UpgradeRequired` を出し、`ApiClient.Outage`（`None`／`Offline`／`Maintenance`／`UpgradeRequired`）を更新する（応答が無い＝`Offline`、成功の応答＝`None`）。`GetMaintenanceAsync`（`MaintenanceStatus`）。`ClientVersion.Compare`。`CloseCodes.VersionMismatch`（4026）。
- `Muchi.Net`：`EngineInfo.Level`。`LockstepClient` の `hello` に `engine`。
- `Muchi.Game`：`MaintenanceModel`（画面の状態 `None`／`Maintenance`／`UpdateRequired`／`Offline`、メンテナンス画面と更新画面の文、ホームのお知らせ帯、推奨の更新の案内（バージョンごとに1回）、再読み込み、KPI）。画面が守ること：docs/handoff-codex-round17-maintenance.md。

## 47. 通報とブロック管理（REQ-RPT-001〜020、`server/src/domain/reports.ts`・`server/src/domain/blocks.ts`・`server/src/ops/playerReports.ts`、C# `Reports.cs`・`Muchi.Game.ReportModel`・`Muchi.Game.BlockListModel`）
ほかのプレイヤーの名前・文・ふるまいを運営に知らせる「通報」と、自分で相手を見えなくする「ブロック」の管理。**通報は運営の審査の列に入るだけ**で、通報の数だけで誰かを隠したり罰したりはしない（REQ-OPS-034 と同じ考え方。通報を武器にできない）。コイン・アイテムは動かない（E番号なし）。

### 47.1 ブロックの一覧は1つ（REQ-RPT-010）
- ブロックの一覧は**支部フィードのミュートの一覧**（`PlayerState.teamFeed.muted`、REQ-TEAMFEED-006、REQ-RIVAL-011）そのもの。2つ目の一覧は作らない。支部フィードのミュート（`PUT /v1/teams/me/feed/mutes`）、ライバルのブロック（`POST /v1/rival/block`）、通報の「ブロックもする」、ブロック管理の画面はどれも同じ一覧を変える。上限は `stamps.config.muteMax`（既定 100）。上限を超えると 409 `TEAM_LIMIT`（既存のコード）。
- ブロックが効くところ（ブロックした人から見て、相手を）：

| 機能 | ブロックしたとき |
|---|---|
| アクティビティ（§40） | 相手からの項目を作らない。前の項目も一覧と未読の数から外す |
| 支部フィード（§17） | 相手のスタンプ・応援が見えない。相手の応援で通知が来ない |
| ライバル（§28） | 組まれない。今週の組は解除 |
| マイ厩舎（§25） | 相手の厩舎を開けない・いいねできない（おすすめにも出ない）。相手も自分の厩舎を開けない・いいねできない（**Round 17 で追加**） |
| 殿堂（§34） | お互いに見られない |
| リプレイ（§37） | 相手の公開リプレイを見られない。相手も自分のを見られない |
| 大会・カップ（§20） | 同じレースに出ることはある（公平のため、組み合わせはブロックで変えない）。相手の名前は出るが、相手からの通知・応援は来ない |
| 主催カップ（§42、Round 17 統合） | どちらかがブロックしていれば同じカップに入れない（参加の時に双方向で確かめる、REQ-CUP-006）。招待もしない。理由は言わない |
| トレーナーカード（§62、R21 統合） | どちらかがブロックしていればお互いのカードは中立のカード（中立の名前だけ。開く・通報する物が無い）。退会・BAN と同じ見た目で、理由は言わない |
| 共有リンク・再戦（§63、R21 統合） | 作った人と開いた人のどちらかがブロックしていればリンクは `unavailable`（見つからない時と同じ答え）。再戦では押した順に、もう入った人とどちらかがブロックしている人は入らない |

- 相手には**ブロックしたことを知らせない**（見えない理由はいつも「見られません」・404 で、ブロックとは言わない）。

### 47.2 `GET /v1/blocks`（要認証、読むだけ）
```json
{ "blocked": [ { "playerId": "p_9", "name": "ハヤテ" } ], "count": 1, "max": 100,
  "effects": [ { "feature": "activity", "text": "相手からのお知らせが届かなくなります" } ] }
```
- 新しくブロックした順。名前は公開プロフィール（ディレクトリ）から今の名前を引く。退会・BAN・見つからない相手は中立の名前「プレイヤー」（§40 と同じ）。プレイヤーが付けた名前なので訳さない。
- `effects` は上の表の各行の短い説明（日本語で作り、英語は応答の境界で訳す）。`feature` は `activity`・`team_feed`・`rival`・`stable`・`hall`・`replays`・`cups`・`links`（§63）・`showcase`（§62、R21 統合）。

### 47.3 `PUT /v1/blocks/:playerId`・`DELETE /v1/blocks/:playerId`（要認証、何度送っても同じ）
- PUT でブロック、DELETE で解除。本文なし。→ `{ "playerId": "p_9", "blocked": true, "count": 1, "max": 100 }`。
- 自分自身は 400。すでにその状態なら何も変えず同じ応答（KPI も出ない）。ライバルの組の解除は次の同期（`rivalSync`）で起きる（REQ-RIVAL-011 のとおり）。

### 47.4 `POST /v1/reports`（要認証）
```json
{ "targetId": "p_9", "category": "name", "source": "profile",
  "content": { "kind": "display_name" }, "note": "（任意・短い補足）", "alsoBlock": true }
```
- `category`：`name`（不適切な名前）・`text`（不適切なキャプション・文）・`cheating`（不正の疑い）・`harassment`（嫌がらせ）・`other`（その他）。
- `source`（どこから通報したか）：`profile`・`friends`・`team_feed`・`stable`・`hall`・`replay`・`photo`・`cup_lobby`。
- `content.kind` と組み合わせ：

| kind | 何を写すか（スナップショット） | 必要なキー | 使える category |
|---|---|---|---|
| `player` | 表示名 | — | `harassment`・`other` |
| `display_name` | 表示名 | — | `name`・`harassment`・`other` |
| `horse_name` | その馬の名前 | `horseId` | `name`・`harassment`・`other` |
| `stable_name` | マイ厩舎の名前 | — | `name`・`harassment`・`other` |
| `replay_title` | 公開しているリプレイのタイトル | `raceId` | `text`・`harassment`・`other` |
| `photo_caption` | 写真のキャプション | `photoId` | `text`・`harassment`・`other` |
| `qchat` | 支部の定型チャットの1件（§52、Round 18 統合） | `feedRef`（`"<teamId>:<seq>"` = フィードの `qchat.report`） | `text`・`harassment`・`other` |
| `race` | 表示名とレース id | `raceId` | `cheating`・`harassment`・`other` |

- `note`：任意。NFKC・前後の空白を落として `reports.noteMaxChars`（既定 100）文字まで、制御文字は不可（超えたら 400）。**訳さない**（運営だけが読む。プレイヤーの文と同じ扱い）。
- **スナップショット**：サーバーが**通報を受けた時点で**相手の状態から写す（端末が送る文は信じない）：表示名・対象の文（名前・タイトル・キャプション）・レース id・写した時刻。あとで相手が名前を変えても、運営は通報された文を見られる。対象が無い（馬がいない・リプレイが非公開・写真が無い・相手が退会）なら 404。
- `cheating` は、通報した人がそのレースに出ていたときだけ（レースの部屋に問い合わせる、`POST /v1/race/:raceId/report` と同じ確認）。出ていなければ 409 `NOT_ELIGIBLE`。受け付けるとそのレースのリプレイは保留（`reported`、REQ-OPS-001）になり、運営は §47.7 からリプレイと検証の結果を開ける。
- **回数の制限**：1人1ゲーム日（04:00 JST）に `reports.perDay`（既定 10）件、同じ相手へは `reports.perTargetPerDay`（既定 2）件まで。超えたら 429 `RATE_LIMITED`。削除予定中のアカウントからは 409 `DELETION_PENDING`。自分自身は 400。
- **まとめる**：同じ相手・同じ対象（kind と horseId／raceId／photoId）・同じ写しの文で、まだ審査中の通報があれば、新しく作らずにその通報に通報者を足す（数と重みを足す）。同じ人が同じものをもう一度通報しても1回と数える（回数の制限は使う）。
- `alsoBlock: true` なら同じ処理でブロックも行う（§47.3 と同じ一覧）。
- 応答：`{ "received": true, "blocked": true, "remainingToday": 9 }`。**まとめたかどうか・何人が通報したかは返さない**。
- **通報した人は相手に知らされない**：相手の画面・API・通知のどこにも通報者・通報の有無を出さない。運営の注意（§47.7 `warn`）も「報告がありました」とだけ言い、誰からかは言わない。

### 47.5 `GET /v1/reports/options`（要認証、読むだけ）
通報シートの中身：`{ "categories": [ { "id": "name", "label": "不適切な名前", "kinds": ["display_name", "horse_name", "stable_name"] } ], "noteMaxChars": 100, "remainingToday": 10, "enabled": true }`。`label` は英語で訳す。

### 47.6 設定（`progression.reports`、起動時とリモート設定で検査、REQ-RPT-015）
`{ "enabled": true, "perDay": 10, "perTargetPerDay": 2, "noteMaxChars": 100, "minResolved": 5, "lowSharePermille": 500, "lowWeight": 500, "veryLowSharePermille": 800, "veryLowWeight": 250, "resolvedKeepDays": 365 }`。範囲：`perDay` 1〜50、`perTargetPerDay` 1〜`perDay`、`noteMaxChars` 0〜200（0 = 補足なし）、`minResolved` 1〜100、`lowSharePermille` 1〜1000 で `veryLowSharePermille` 以下、重み 1〜1000 で `veryLowWeight` ≤ `lowWeight`、`resolvedKeepDays` 30〜3650。無ければこの既定値。

### 47.7 運営の審査（ops console、`/v1/admin/player-reports`、監査つき）
- `GET /v1/admin/player-reports?status=open|resolved&category=&kind=&targetId=&limit=`（viewer）：審査中は**重みの合計**（`score`、千分率）の大きい順、次に新しい順。各行：id・相手・category ごとの数・kind・写し・通報者の数・重みの合計・最初と最後の時刻・状態。
- `GET /v1/admin/player-reports/:id`（viewer）：写し（通報された時点の文）、通報者ごとの時刻・category・source・重み・補足、相手の今の不正対策の状態。`cheating` は `race: { raceId, replay: "/v1/admin/replays/<raceId>", integrity: { status, events } }`（そのレースの容疑者・ズレの記録＝検証の結果）。
- `POST /v1/admin/player-reports/:id/action`（operator、`ban` は admin）`{ "action": "dismiss|warn|rename|hide|ban", "reason": "…", "until": null }`：
  - `dismiss`：問題なしで閉じる。
  - `warn`：相手のアクティビティに「運営からのお願い」（`ops_notice`、§40、通報者は出さない）を1件。
  - `rename`：既存の名前のリセット（`/v1/admin/players/:id/name-reset` と同じ処理、NG リストの名前に戻す流れ）。`display_name`→表示名、`horse_name`→その馬、`stable_name`→厩舎名。ほかの kind は 400。
  - `hide`：`replay_title` はそのリプレイを非公開にしてタイトルを消し、運営の印（`opsHidden`）で再公開できなくする。`photo_caption` はキャプションを消す。`qchat` はその1件を支部のフィードから消す（全員に見えなくなる、Round 18 統合）。ほかの kind は 400。
  - `qchat` の写し（Round 18 統合）：対象のプレイヤーの状態ではなく**通報した人の支部の TeamDO** から、表示された文（日本語）とスロットごとの値（`snapshot.qchat = {teamId, seq, phraseId, slots:[{name, value}], postedAt}`）を写す。通報した人がその支部の仲間でない・その項目が無い・`targetId` が書いた人でない時は 404（数えない）。抜けた人の文（`anon`）は書いた人の ID を出さないので、§18 のフィードの通報だけを使う。
  - `ban`：既存の BAN（`integrity.ban`、`until` = null で無期限）。
  - どれも1回だけ（閉じた通報に送ると 409 `CONFLICT`）。監査ログに前後の状態を残す（REQ-OPS-010）。
- **通報者の重み**（悪用対策、簡単で説明できる決まり）：通報者ごとに審査済みの数（`dismiss` と、それ以外の対応）を数える。審査済みが `minResolved` 件以上で、`dismiss` の割合が `veryLowSharePermille`（80%）以上なら重み `veryLowWeight`（0.25）、`lowSharePermille`（50%）以上なら `lowWeight`（0.5）、それ以外は 1。重みは通報を受けた時点のものを記録し、並び順（`score`）にだけ使う。**重みが低くても通報は消さない**し、重みが高くても自動で処罰しない。

### 47.8 アカウント削除と保存（REQ-RPT-016）
- 削除の手順に `reports` の段を足す（`replays` の後、`finalize` の前）。**削除した人が出した通報**は通報者を `deleted` に置き換えて補足を消し（匿名化）、重みの記録も消す。通報そのもの（写し・数）は残す。
- **削除した人についての通報**は残す：既存の決まり（通報されたレースのリプレイは運営が対応するまで残す REQ-OPS-001a、不正対策の記録と通報の列は削除の手順で消さない REQ-OPS-034）と同じく、審査中のものは運営が閉じるまで残り、相手に `targetDeleted` の印が付く（`rename`・`warn`・`hide` は 409、`dismiss`・`ban` は可）。閉じた通報は `resolvedKeepDays`（既定 365 日）後に消す（通報を受けるたびに古いものを少しずつ）。docs/planning/03-legal-risk.md「通報とブロック」。

### 47.9 KPI
| イベント | 送り手 | s1 | s2 | s3 |
|---|---|---|---|---|
| `report_submit` | サーバー（受け付けた通報ごと） | category | kind | source |
| `block_add` | サーバー（一覧に増えたとき） | どこから（`blocks`・`report`・`team_feed`・`rival`） | — | — |
| `block_remove` | サーバー（一覧から消えたとき） | どこから（`blocks`・`team_feed`） | — | — |
相手の id・補足は入れない。クエリは `docs/ops/kpi-queries.md`「通報とブロック」。

### 47.10 クライアント
- `Muchi.Client`：`ReportCategories`・`ReportContentKinds`・`ReportSources`、`ReportOptions`・`ReportResult`・`BlockList`、`ApiClient.GetReportOptionsAsync`・`SubmitReportAsync`・`GetBlocksAsync`・`BlockAsync`・`UnblockAsync`。
- `Muchi.Game`：`ReportModel`（通報シート：理由の選択・補足の文字数・ブロックもする・送信中の二重送信を防ぐ・オフライン・結果の文）、`BlockListModel`（一覧・解除の確認・効く機能の説明・オフライン）。
- 画面が守ること：docs/handoff-codex-round17-reports.md。

## 48. ヘルプセンター（よくある質問・問い合わせ、REQ-HELP-001〜024、`server/src/domain/help.ts`・`server/master/help.json`、C# `Help.cs`・`Muchi.Game.HelpCenterModel`）
アプリの中で読めるよくある質問（日本語・英語）と、アプリから送る問い合わせ。**表示と問い合わせだけ**：コイン・アイテムを動かさない（E番号なし、経済は変わらない）。

**決まりごと**
- 記事は `server/master/help.json`（リモート設定の `help` で丸ごと置き換えられる）に**日本語と英語の両方**を持つ。応答は要求の言語（§23 の `?lang=`・Accept-Language）の方を返す（境界の翻訳表は使わない）。起動時とリモート設定で検査する（§48.1）。
- 提供割合・天井・価格・月額上限・削除までの日数など**数字は記事に書かない**。本文の `{{トークン}}` を返すときにデータ（ガチャの表は提供割合の画面と同じ `oddsDisclosure` の計算、年齢の上限は `ageLimits`、削除は `progression.accountDeletion`、ムチの数は有効なルールセット）から埋める。スカウトと購入のカテゴリの記事はトークンの外に数字を置けない（「10連」「10-pull」だけ例外）。どの記事も数字の直後の `%`・`％`・`pt`・`ポイント` は使えない。
- 言葉：日本語は「倍」「お得」「今だけ」「残りわずか」「通常価格」と賭けの言葉（`bettingWords.ts`）を使わない。英語は §23 の `EN_BANNED` と賭けの言葉を使わない（英語では提供割合を "rates" と書き、"odds" は使わない）。
- リンクは**アプリ内の画面**（`screen`）・**法定表示**（`legal`：`terms`・`privacy`・`tokushoho`（特定商取引法に基づく表記）・`shikin`（資金決済法に基づく表示）。既存の法定表示の画面を開く）・**別の記事**（`article`）・**公式サポートサイト**（`url`：`https://` で、ホストが `config.supportSiteHost` と一致するものだけ）。それ以外の URL は検査で落とす。
- 問い合わせは**アカウントに保存**し、本人が状態（受付済み・回答済み・完了）と運営の返信を見られる。返信はアクティビティ（§40）の項目 `inquiry_answered` で知らせる（プッシュは送らない）。
- 個人情報：自動で添える診断情報は**アプリの版・端末の種類（ios / android / editor）・プレイヤー ID・直近のレース ID（最大3件、サーバーが自分の記録から入れる）**だけ。名前・メール・端末の機種名・OS の版・広告 ID・位置は送らない。フォームにこのことを書く（`diagnosticsNote`）。本文のメールアドレス・電話番号・カード番号らしい並びは保存の前に「［削除しました］」に置き換える。
- 本文と返信は人が書いた文なので**翻訳しない**（応答のキーは `inquiryText`・`messageText`。`PLAYER_TEXT_KEYS` に入れてある）。問い合わせを送った言語 `lang` を保存し、運営はその言語で返す。

### 48.1 マスター（`server/master/help.json`）
```json
{ "version": 1,
  "config": { "enabled": true, "supportSiteHost": "support.muchi-issen.example", "titleMaxChars": 40, "bodyMaxChars": 1200,
              "searchMaxChars": 40, "searchMaxResults": 20, "feedbackPerDay": 50,
              "inquiry": { "descriptionMin": 10, "descriptionMax": 1000, "attachMax": 10, "openMax": 3, "perDay": 5, "minIntervalSec": 60, "keepMax": 30, "replyMax": 2000 } },
  "categories": [ { "id": "scout", "title": { "ja": "スカウト（提供割合・天井）", "en": "Scout (rates & pity)" }, "icon": "scout" } ],
  "articles": [ { "id": "pity", "category": "scout", "title": { "ja": "…", "en": "…" }, "body": { "ja": "…{{pity_pulls:standard}}…", "en": "…" },
                  "keywords": { "ja": ["てんじょう"], "en": ["pity"] }, "links": [ { "type": "screen", "screen": "gacha_odds" } ], "related": ["scout_rates"] } ],
  "contexts": { "gacha_odds": "pity", "coin_shortfall": "buy_coins" } }
```
- カテゴリ `id` は8つ：`getting_started`（はじめに）・`races`（レース・ムチ）・`horses`（馬・配合）・`scout`（スカウト・提供割合・天井）・`purchases`（購入・返金）・`account`（アカウント・引き継ぎ）・`deletion`（アカウント削除）・`accessibility`（アクセシビリティ）。全部そろっていて、それぞれ記事が1件以上。
- 記事 `id` は `^[a-z0-9_]{2,40}$` で重ならない。`title` は1〜`titleMaxChars` 文字、`body` は1〜`bodyMaxChars` 文字（トークンを埋める前）、`keywords` は各言語20個まで・各20文字まで。日本語と英語でトークンの組が同じ。`related` は存在する別の記事。
- 画面 `screen`：`home`・`settings`・`race_lobby`・`tutorial`・`training`・`breeding`・`stable`・`collection`・`gacha`・`gacha_odds`・`shop`・`history`・`gift_box`・`activity`・`accessibility`・`account_link`・`deletion`・`inquiry`・`my_inquiries`・`privacy`・`team_feed`・`practice`（この3つは Round 18 統合）・`performance`・`storage`（§56）。
- トークン：`pity_pulls:<バナー>`（天井までの回数）・`pity_coins:<バナー>`（天井までのコイン）・`pity_cost:<天井グループ>`・`rate:<バナー>:<レア度>`・`guarantee_rate:<バナー>:<レア度>`（10枠目の保証の表）・`price_single:<バナー>`・`price_ten:<バナー>`・`monthly_limit:<年齢帯>`（上限のある帯だけ）・`guardian_age`・`deletion_days`・`purchase_keep_days`・`coin_history_days`・`gacha_history_days`・`max_whips`・`cheer_interval_sec`（Round 19、§55 の応援の間隔の秒）。知らないトークン・無いバナー／グループ／帯は検査で落とす（リモート設定でバナーを外して記事が壊れる版は有効にできない）。
- `contexts`（画面からの案内、REQ-HELP-008）：`gacha_odds`・`coin_shortfall`・`purchase`・`race_whip`・`race_result`・`training`・`breeding`・`history`・`gift_box`・`account_link`・`deletion`・`accessibility`・`privacy`（Round 18 統合：プライバシーの画面 → `data_export`）・`storage`（§56）・`practice`（Round 19 統合：練習の条件の画面 → `practice_races`） → 記事 id。Round 18 統合で記事 `data_export`・`quick_chat`・`practice_races`・`horse_goals` を足した（数字はトークン `export_cooldown_days`・`export_keep_days`・`export_link_minutes`・`qchat_interval_sec`・`qchat_per_day` から）。全部そろっていて、存在する記事を指す。

### 48.2 `GET /v1/help`（要認証、読むだけ・プレイヤーの状態に触れない）
```json
{ "enabled": true, "version": 1, "lang": "ja",
  "categories": [ { "id": "scout", "title": "スカウト（提供割合・天井）", "icon": "scout", "count": 2 } ],
  "articles": [ { "id": "pity", "category": "scout", "title": "天井（交換pt）のしくみ" } ],
  "contexts": { "gacha_odds": "pity" },
  "supportSite": "https://support.muchi-issen.example/",
  "inquiry": { "categories": [ { "id": "purchase_missing", "title": "購入したのに届かない", "history": true } ],
               "descriptionMin": 10, "descriptionMax": 1000, "attachMax": 10,
               "diagnosticsNote": "…", "privacyNote": "…" } }
```
`enabled: false` のときは `categories`・`articles` が空（問い合わせの一覧と詳細は見られる）。

### 48.3 `GET /v1/help/articles/:articleId`（要認証）
`{ id, category, categoryTitle, title, body, links: [ { type, label, screen? | doc? | articleId? | url? } ], related: [ { id, title } ], version }`。`body` はトークンを埋めた文（段落は空行、`・` で始まる行は箇条書き）。無い id は 404。

### 48.4 `GET /v1/help/search?q=&category=&limit=`（要認証）
- `q`：前後の空白を除いて1〜`searchMaxChars` 文字（それ以外は 400）。`category` は省略か8つのどれか、`limit` は1〜`searchMaxResults`。
- 比べ方（日本語の正規化、REQ-HELP-006）：NFKC（半角カナ → 全角、全角英数 → 半角）→ ひらがな → カタカナ → 小さいカナ → 大きいカナ・長音を除く・ヴ → ブ（名前の NG 判定と同じ `foldForCompare`）→ 英字は小文字。`q` を空白で語に分け、**全部の語**がタイトル・キーワード・本文（その言語、トークンを埋めた後）のどれかに入る記事を返す。点数はタイトル3・キーワード2・本文1の合計の高い順、同点は master の順。
- `{ "items": [ { "id", "category", "title", "snippet" } ], "total": 3, "query": { "length": 4 } }`。`snippet` は最初に当たった本文の前後（最大60文字）。**検索語は保存もログもしない**（KPI は正規化した長さとカテゴリだけ、§48.9）。

### 48.5 `POST /v1/help/articles/:articleId/feedback`（要認証）
`{ "helpful": true }` → `{ "articleId": "pity", "helpful": true, "changed": true }`。記事ごとに1票（あとから変えられる。同じ値なら `changed: false` で何も起きない）。1ゲーム日（§15 の日の切り替え `progression.dayRollover`）に `feedbackPerDay` 回まで（超えたら 429 `RATE_LIMITED`）。無い記事は 404、他のキーは 400。票はアカウントの状態に入り、アカウント削除で消える。

### 48.6 問い合わせ（要認証）
**`POST /v1/help/inquiries`**（`Idempotency-Key` 必須。同じキーの再送は最初の応答をそのまま返し、2件にならない）
```json
{ "category": "purchase_missing", "description": "コイン1,020を買ったのに増えていません。",
  "refs": ["P-1A2B3C4D", "C-120"],
  "diagnostics": { "appVersion": "1.4.0", "platform": "ios" } }
```
- `category`：`purchase_missing`・`refund`・`coins`・`gacha`（§33 の問い合わせ番号の種類と同じ）・`race`・`account`・`deletion`・`accessibility`・`bug`・`other`。
- `description`：制御文字なし、`descriptionMin`〜`descriptionMax` 文字。メール・電話・カード番号らしい並びは置き換えて保存（`redacted: n` で数を返す）。
- `refs`：§33 の問い合わせ番号（購入 `P-`・コイン `C-`・ガチャ `G-`）0〜`attachMax` 件、重複なし。§33 の一覧と同じ期間の**自分の**記録だけ（無い・期間外は 404 `NOT_FOUND`）。その時点の行（タイトル・内容、内部の id なし）を写して保存する（`buildSupportTicket` と同じ形）。
- `diagnostics`：`appVersion`（`^[0-9A-Za-z.+-]{1,32}$`）と `platform`（`ios`・`android`・`editor`）だけ。それ以外のキーは 400。サーバーが `playerId` と直近のレース ID（確定した自分のレース、新しい順に最大3件）を足す。
- 回数の上限（超えたら 429 `RATE_LIMITED`、`details.retryAt` 付き）：返信待ち（`received`）は `openMax` 件まで・1ゲーム日に `perDay` 件まで・前の送信から `minIntervalSec` 秒。削除の手続き中（`deletion.status = deleting`）は 403 `FORBIDDEN`。
- 応答：下の詳細の形（`status: "received"`）。保存は新しい順に `keepMax` 件（古い完了・回答済みから消す。返信待ちは消さない）。

**`GET /v1/help/inquiries`** → `{ "items": [ { "ticketId": "q_3", "category", "categoryTitle", "status": "answered", "statusText": "回答済み", "createdAt", "updatedAt", "unread": true } ], "unread": 1, "limits": { "openMax": 3, "open": 1, "perDay": 5, "today": 1, "retryAt": null } }`（新しい順）。

**`GET /v1/help/inquiries/:ticketId`** → `{ ticketId, category, categoryTitle, status, statusText, createdAt, updatedAt, lang, inquiryText, redacted, attachments: [ { ref, kind, at, title, detail } ], diagnostics: { appVersion, platform, playerId, lastRaceIds }, messages: [ { from: "player" | "support", messageText, at } ], unread }`（`inquiryText` は送った本文（置き換えの後））。他人の・無い id は 404。

**`POST /v1/help/inquiries/:ticketId/read`** → `{ ticketId, unread: false, unreadTotal }`（何度送っても同じ）。

- 状態 `status`：`received`（受付済み・返信待ち）→ `answered`（回答済み）→ `closed`（完了）。運営が返すと `answered`（`close: true` なら `closed`）。`statusText` は「受付済み」「回答済み」「完了」。
- `GET /v1/player`・bootstrap に `help: { "unreadReplies": n }`（設定画面の「ヘルプ・お問い合わせ」のバッジ）。

### 48.7 運営（管理 API・ops コンソール、REQ-HELP-015〜017）
- 一覧の索引（`OpsApi.inquiries`、OpsDO の SQLite `inquiries` 表、ワーカーは問い合わせを受け付けた後と返信の後に書く）：`ticketId`・`playerId`・`category`・`status`・`lang`・`attachments`（件数）・`createdAt`・`updatedAt` だけ。**本文は索引に入れない**（開くときにプレイヤーのオブジェクトから読み、閲覧は監査ログに残る）。索引に書けなかった問い合わせは `indexed: false` のまま残り、本人が一覧を開いたときにもう一度書く（同じ id は上書き）。
- `GET /v1/admin/inquiries?status=received|answered|closed&category=&limit=`（viewer）：新しい順。
- `GET /v1/admin/players/:playerId/inquiries/:ticketId`（viewer）：詳細（本文・添えた行・診断情報・やりとり、運営の返信には書いた人）。削除済みのアカウントは 404（`account deleted`）で、索引からそのプレイヤーの行を消す。Round 17 統合から、アカウント削除の手順にも `inquiries` の段（`reports` の後、`finalize` の前）があり、索引の行はその時に消える（ここでの削除は取り残しの掃除）。
- `POST /v1/admin/players/:playerId/inquiries/:ticketId/reply`（operator、`reason` 必須）`{ "opKey": "reply-q3-1", "content": "…", "close": false }`：返信を足して `answered`（`close` で `closed`）。`opKey` ごとに1回（再送は同じ結果）。`content` は1〜`replyMax` 文字。アクティビティに `inquiry_answered`（送り元 `inquiry:{ticketId}:{返信の番号}`、リンク `help_inquiry`・`id` = ticketId）を書く。完了した問い合わせには返せない（409 `CONFLICT`）。
- 返信は人が書いた文で、運営は問い合わせの `lang` の言語で書く（翻訳しない）。

### 48.8 アクティビティ（§40 への追加）
| 種類 `kind` | 書く箇所 | 送り元 id | まとめる | `category` | `link.screen` |
|---|---|---|---|---|---|
| `inquiry_answered` | 運営の返信（`adminInquiryReply`） | `inquiry:{ticketId}:{n}` | しない | `support`（プッシュの種類ではない：プッシュは送らない） | `help_inquiry`（`id` = ticketId） |
文：「お問い合わせに運営から返信がありました」。

### 48.9 KPI
- クライアント：`help_search`（`props.length`：正規化した検索語の長さ 1〜64、`props.category`：カテゴリ id か `all`、`props.results`：0〜100）→ s1 = カテゴリ、value = 長さ、count = 件数（**検索語そのものは送らない**）。`help_article_view`（`props.articleId`、`props.source`：`list`・`search`・`context`・`link`・`related`）→ s1 = 記事、s2 = 入口。
- サーバー：`help_feedback`（票が変わったとき、s1 = 記事、s2 = カテゴリ、value = 1／0）・`inquiry_submit`（s1 = 種類、count = 添えた行の数、value = 置き換えた数）・`inquiry_answered`（s1 = 種類、durationMs = 受付から最初の返信まで）。
- クエリは `docs/ops/kpi-queries.md`「ヘルプセンター」。

### 48.10 クライアント
- `Muchi.Client`：`ApiClient.GetHelpAsync`・`GetHelpArticleAsync`・`SearchHelpAsync`・`SendHelpFeedbackAsync`・`GetInquiriesAsync`・`GetInquiryAsync`・`SubmitInquiryAsync`（キーは呼び出しごとに1つ、再送で同じキー）・`MarkInquiryReadAsync`、`HelpText.Fold`（サーバーと同じ正規化）、`PlayerView.Help`、`AnalyticsEvent.HelpSearch`・`HelpArticleView`。
- `Muchi.Game`：`HelpCenterModel`（カテゴリ・記事・検索（端末でも同じ正規化）・画面からの案内 `OpenContext`・「役に立った」・問い合わせのフォーム（種類・本文・添える履歴の行・診断情報の説明）・送信（同じキーで再送、オフラインは送らない）・自分の問い合わせ一覧と詳細・既読）。
- 画面が守ること：docs/handoff-codex-round17-help-center.md。

## 49. おすすめフレンド（friend suggestions、REQ-FSUG-001〜016、`server/src/domain/friendSuggest.ts`、C# `FriendSuggestions.cs`・`Muchi.Game.FriendSuggestionsModel`）
**もうゲームの中で出会った人**の中から、フレンドになれそうな人を並べる。フレンド画面の一区画。**何も配らない**（E番号なし。フレンドの数に応じた報酬は作らない。招待の報酬は §19 のまま）。申請は今のフレンド申請（REQ-SOCIAL-002 の `friendSend`・`friendReceive`）をそのまま通るので、上限（`maxFriends`・`maxOutgoing`・`maxIncoming`）とアクティビティ（§40 の `friend_request`・`friend_accepted`）とプッシュはそのまま効く。

### 49.1 理由（シグナル）と並べ方
| `kind` | どこから（自分の状態か、もう見えているものだけ） | 日本語（理由の行） | English | 重み（既定） |
|---|---|---|---|---|
| `opponent` | 最近 `opponentDays`（30日）のフレンド部屋・イベント・大会・主催カップ（§42、Round 17 統合）のレースで同じレースを走った人（確定した結果の `field`。**ランク戦は使わない**） | 最近のレースで対戦 | Raced you recently | 40 |
| `team` | 同じ支部のメンバー（支部の画面で見えている一覧） | 同じ支部 | Same branch | 30 |
| `liked` | マイ厩舎にいいねをくれた人（アクティビティ §40 の `stable_like` に名前が出た人） | マイ厩舎にいいねをくれた | Liked your stable | 25 |
| `cheered` | 応援スタンプをくれた人（§40 の `team_cheer`） | 応援スタンプをくれた | Cheered your race | 25 |
| `mutual` | 共通のフレンドの**数だけ**（`fofMin` = 2 人以上のときだけ。誰かは言わない） | 共通のフレンド{n}人 | {n} mutual friends | 1人あたり 10（`mutualCap` = 5 人まで） |

- 点 = 当てはまる理由の重みの合計（`mutual` は重み × min(人数, `mutualCap`)）。並びは点の高い順 → いちばん新しいシグナルの時刻の新しい順 → `playerId` の昇順（同じデータなら必ず同じ並び。乱数なし）。
- 理由の行 `text` は点への寄与の大きい順に最大2つを「・」でつなぐ（例「同じ支部・共通のフレンド3人」。英語は「, 」で「Same branch, 3 mutual friends」）。データにある事実だけで、作った言葉・急かす言葉は使わない。
- **ランク戦の相手は使わない**（決めたこと）：ランク戦は知らない人と自動で組まれ、名前を出さない作り（観戦・リプレイは馬の名前と `p<枠>`、§37）なので、相手を名前付きで出すと「ランク戦で当たった人を後から探せる」ことになる。オプトインの設定も置かない（設定を増やすより、使わない方が分かりやすい）。フレンド部屋・イベント・大会は相手が名前付きで見える場なので使う。

### 49.2 出さない人（REQ-FSUG-004〜007）
- 自分・もうフレンド・申請中（どちら向きでも）・自分が消した人（`dismissed`、§49.4）・自分がおすすめから申請した人（断られても二度と出さない）。
- **ブロック**：自分がブロックした人、自分をブロックした人（どちらも支部フィードのミュート＝ブロックの1つの一覧、REQ-RIVAL-011）。
- **BAN・退会**：BAN 中、削除の予約中・手続き中、退会済み（公開プロフィールが無い）。
- **「おすすめに表示しない」をオンにした人**、登録した年齢が `minAgeShown`（13）歳未満の人（設定に関係なく他の人のおすすめに出ない。自分のおすすめは見られる）。この人たちは「共通のフレンド」の数え方にも使わない（その人のフレンド一覧を橋にしない）。
- 公開の写し（§49.5 のカード）がまだ無い人（しばらくゲームを開いていない人。ブロックと設定を確かめられないので出さない）。

### 49.3 `GET /v1/friends/suggestions`（要認証、読むだけ）
```json
{ "enabled": true,
  "items": [
    { "playerId": "p_9", "displayName": "ハヤテ", "titleId": null, "classId": "B",
      "reasons": [ { "kind": "team" }, { "kind": "mutual", "n": 3 } ],
      "text": "同じ支部・共通のフレンド3人" } ],
  "settings": { "hidden": false } }
```
- 最大 `maxShown`（10）件。名前はプレイヤーが付けたものなので訳さない。`text` は日本語で作り、英語は応答の境界で訳す（§23、`i18n/en.ts`）。レーティング・戦績・支部名・共通のフレンドの名前は返さない。
- 自分のアカウントが削除の予約中なら `items` は空。`enabled: false`（`progression.friendSuggest.enabled` が false）なら `items` は空で、フレンド画面は区画を出さない。

### 49.4 申請・消す・設定（要認証）
- `POST /v1/friends/suggestions/:playerId/request` → `{ "status": "requested" | "friends", "playerId": "p_9" }`（フレンドコードの申請 `POST /v1/friends/requests` と同じ形。相手が先にこちらへ申請していれば `friends`）。**その時点でおすすめに出る人だけ**（キャッシュを使わずに確かめ直す）。出ない人は理由を言わず 404 `NOT_FOUND`（id を当てずっぽうに送っても誰にでも申請できる道にしない）。上限はフレンド申請のまま（`FRIEND_LIMIT`）。送れたら相手を `dismissed`（`why: requested`）に入れる。何度送っても2件にならない（`friendSend` の `already_sent`）。
- `POST /v1/friends/suggestions/:playerId/dismiss` → `{ "ok": true }`。何度送っても同じ。覚えるのは新しい順に `dismissKeep`（200）人まで（あふれた古い人はまた出ることがある）。
- `PUT /v1/friends/suggestions/settings` 本文 `{ "hidden": true }` → `{ "hidden": true }`。プロフィール画面の「おすすめに表示しない」。**既定はオフ（表示する）**：出る相手は同じ支部・同じレース・いいね・応援でもう名前を見ている人と、共通のフレンドが2人以上いる人だけで、外の情報（電話帳・SNS）は使わないため。オンにすると、次にカードが書き換わったとき（すぐ）から誰のおすすめにも出ず、共通のフレンドの橋にもならない。他のキーは 400。

### 49.5 保存と計算（REQ-FSUG-010）
- 自分の状態 `friendSuggest`：`{ hidden, dismissed: [{ id, at, why }]（最大 dismissKeep）, opponents: [{ id, at, mode, n }]（最大 opponentKeep = 50、opponentDays より古いものは数えない）, cardKey }`。アカウント削除で状態と一緒に消える。
- **カード**（ディレクトリの写し、他のプレイヤーには返さない）：`{ playerId, blocked（ブロックの一覧）, friends（フレンドの id）, updatedAt }`。プレイヤーのトランザクションのたびに作り直し、変わったときだけ書く（`fsug_cards`、DirectoryDO の表。wrangler の移行は不要）。表示しない設定・13歳未満・BAN・削除の予約中はカードを**消す**。アカウント削除でも消す（`forget`）。
- 計算は読むときに行う：①自分の状態（PlayerDO 1回）②支部のメンバー（TeamDO 1回）③フレンドのカード（新しく加わった順に `fofFriendsMax` = 20 人分、シャードごとにまとめて最大16回）④候補（点の高い順に `candidateMax` = 60 人まで）のカードと公開プロフィール（シャードごとにまとめて最大16回）。結果はプレイヤーごとに `cacheTtlMs`（5分）だけワーカーのメモリに持つ（最大1000人分）。キャッシュを使うときも、自分のフレンド・申請・ブロック・消した人はその場の状態で外す。相手側の変化（相手がブロックした・設定をオンにした）がキャッシュに届くのは最長 `cacheTtlMs` 後（申請のときは確かめ直す）。
- 設定 `progression.friendSuggest`（起動時とリモート設定で検査、無ければ既定値）：`{ "enabled": true, "maxShown": 10, "candidateMax": 60, "fofFriendsMax": 20, "fofMin": 2, "mutualCap": 5, "opponentDays": 30, "opponentKeep": 50, "dismissKeep": 200, "cacheTtlMs": 300000, "minAgeShown": 13, "weights": { "opponent": 40, "team": 30, "liked": 25, "cheered": 25, "mutual": 10 } }`。範囲：`maxShown` 1〜30、`candidateMax` 10〜200（`maxShown` 以上）、`fofFriendsMax` 0〜50、`fofMin` 1〜10、`mutualCap` 1〜20、`opponentDays` 1〜90、`opponentKeep` 10〜200、`dismissKeep` 10〜1000、`cacheTtlMs` 0〜3600000、`minAgeShown` 0〜18、重みは 0〜100 の整数。

### 49.6 KPI
| イベント | 送り手 | s1 | s2 | value |
|---|---|---|---|---|
| `fsug_view` | クライアント（区画が見えたとき1回、`props.shown` 0〜30） | | | 出ていた数 |
| `fsug_request` | サーバー（おすすめからの申請が通ったとき） | いちばん大きい理由の `kind` | `requested` / `friends` | |
| `fsug_dismiss` | サーバー（新しく消したときだけ） | いちばん大きい理由の `kind`（分からなければ `none`） | | |
相手の id は入れない。クエリは `docs/ops/kpi-queries.md`「おすすめフレンド」。

### 49.7 クライアント
- `Muchi.Client`：`FriendSuggestions`（`Parse`）、`ApiClient.GetFriendSuggestionsAsync`・`RequestSuggestedFriendAsync`・`DismissSuggestionAsync`・`SetSuggestionsHiddenAsync`、analytics `fsug_view`。
- `Muchi.Game`：`FriendSuggestionsModel`（読み込み・同時に2回読まない・申請／消すは押した行をすぐ一覧から外す（失敗したら戻す）・同じ人に2回送らない・`fsug_view` は1画面1回・オフラインは「オンラインで表示できます」・空のときの文言・「おすすめに表示しない」の切り替え）。
- 画面が守ること：docs/handoff-codex-round17-friend-suggestions.md。

## 50. 練習レース（practice races、REQ-PRAC-001〜018、`server/src/domain/practice.ts`、C# `Practice.cs`（`PracticeCatalog`・`PracticeSession`・`PracticeClock`）・`Muchi.Game.PracticeModel`、`server/master/practice.json`）
自分の馬で、好きなコース・距離・馬場・昼夜・頭数（2〜12）・CPU の強さを選び、**端末の中だけで**CPU 相手に本物のエンジンで走る。ムチのタイミングと脚質の乗り方を練習するための場所。サーバーに結果を送る経路は無い（オフラインでも遊べる）。

**練習は何も配らない**（E 番号なし）：コイン・アイテム・素材・デイリーミッション・シーズンパスの XP・シーズンpt・レート・戦績（`stats`）・殿堂の成績（§34）・振り返り（§43）・ライバルの点（§28）・支部の共同目標（§32）・交換所のポイント（§30）・図鑑の「見た」（§24）・絆・実績、どれも動かない。サーバーには練習の結果を受け取る API が無く、レースの確定（`applyRace`）を通らないので構造的に動かせない（`server/test/practice.test.ts` で全部の値が変わらないことを確かめる）。

### 50.1 カタログ `GET /v1/practice/catalog`（要認証、読み取りだけ）
端末がレースを組み立てるのに要るものを1回で返す。端末はこれを覚えておき（`muchi.practice.catalog`）、オフラインでは覚えた物を、一度も取れていなければ内蔵の予備（50.6）を使う。状態は変えない（冪等キー不要）。削除予約中のアカウントも読める。
```json
{ "v": 1, "rulesetVersion": "1.3.0",
  "fieldSize": { "min": 2, "max": 12, "default": 8 },
  "strengths": [ { "id": "easy", "name": "やさしい", "note": "初心者マッチと同じ相手", "cpuLevel": 1, "cpuStatPermille": 780 },
                 { "id": "normal", "name": "ふつう", "note": "ランク戦（レート1400〜1600）の相手", "cpuLevel": 3, "cpuStatPermille": 1000 } ],
  "defaultStrength": "normal",
  "courses": [ { "trackId": "minato_turf_2400", "name": "みなと競馬場 芝2400m", "surface": "turf", "distanceM": 2400, "segments": [ … ],
                 "lights": true, "goings": ["firm", "good", "yielding", "soft"], "today": { "going": "good", "night": false } } ],
  "cpuHorses": [ { "id": "cpu_t_kohaku", "name": "コハクノヒカリ", "speed": 600, …, "style": "nige", "distMinM": 1400, "distMaxM": 2000, "surface": "turf", "skill": { … } } ],
  "horses": [ { "id": "h_1", "name": "アイボウ", …, "partner": true } ],
  "ruleset": { … } }
```
- `courses`：今のゲームのコース全部（`server/master/tracks.json`。プレイヤーごとのコースの鍵は今のゲームに無いので、全部が「解放済み」）。`goings` はその面の4つ（芝 firm/good/yielding/soft、ダート fast/good/muddy/sloppy）。ナイターは `lights: true` のコースだけ。`today` はその日の馬場（REQ-RACE-037、フレンド部屋と同じ）で、画面の初期値。
- `strengths`：既存の CPU の定義から（`server/master/practice.json`、起動時に検査）。`easy` = 初心者マッチ（`progression.beginnerMatch` の `cpuLevel`・`cpuStatPermille`）、`normal` / `strong` / `top` = マッチングがレートで選ぶ CPU の段（`cpuLevelFor`：レート1400〜1600 → 3、1600〜1800 → 4、1800以上 → 5）、能力はそのまま。CPU の段は**乗り方の正確さだけ**を変え（CpuBrain）、`cpuStatPermille` は CPU の能力だけを下げる（1000 以下）。
- `cpuHorses`：CPU になれる馬（`templates` のうち期間限定・プレゼント専用でないもの。`buildRaceConfig` の CPU と同じ範囲）を `RaceHorse` の形で。固有スキルはルールセットの上限で切る（フレンド部屋と同じ）。
- `horses`：自分の現役の馬（最大 30）を `RaceHorse` の形で（能力は調教込み `raceStats`、スキルはルールセットの上限で切る。上限 `statCap` はかけない＝フレンド部屋と同じ）。`partner: true` は相棒。
- `ruleset`：リモート設定の有効なルールセット（`activeRuleset`、§15）。端末はこのルールセットでエンジンを動かす。

### 50.2 レースの組み立て（端末、`PracticeSession.BuildConfig`、純粋）
入力：カタログ・`PracticeSetup { horseId, trackId, going, night, fieldSize, strengthId }`・`seed`（uint64）。同じ入力から必ず同じ `RaceConfig`（テストで確認）。
1. 検査：馬・コース・強さがカタログにある、`going` がそのコースの面の値、`night` は照明のあるコースだけ、`fieldSize` は 2〜12（かつルールセットのレーン数以下）。違えば組み立てない（理由の1文）。
2. CPU：`cpuHorses` から自分の馬と同じ名前の馬を除き、`Pcg32(seed, 0x50524143)` で `fieldSize − 1` 頭を重複なしで選ぶ。能力は `⌊能力 × cpuStatPermille / 1000⌋`、`cpuLevel` は強さの値。
3. ゲート：同じ乱数で全員を並べ替える（Fisher–Yates）。自分の枠は乱数で決まる。
4. `RaceConfig`：`raceId` = `practice_<seed 16進>`、`mode` = `friend`（エンジンには新しいモードを足さない。オフラインの練習は今までも `friend` の設定で走っていた。ゴールデンは変わらない）、`track` = コース＋`going`・`night`、`net` = 既定、`ruleset` = カタログのもの、自分は `kind: human`・`playerId: "local"`。
- 練習の判定は `PracticeSession.IsPractice(config)`（`raceId` が `practice_` で始まるか、今までのオフライン練習 `offline_practice`）。写真のカード・共有カードの種類の表示は「練習レース」になる（「フレンド戦」と書かない）。

### 50.3 走る・やり直す・ゴースト
- `PracticeSession.Start()` → `OfflineRace`（`Muchi.Game.OfflineRaceDriver` で既存の HUD・実況・かんたん操作・ムチの長押しがそのまま乗る）。開始の押しどきは普通のレースと同じ（遅れれば出遅れ）。
- **すぐやり直す**：`Restart(PracticeRestart.SameSeed)`（同じ相手・同じ枠・同じ展開でもう一度）／`Restart(PracticeRestart.NewSeed)`（新しい相手と枠。次の seed は `SeedMix.Mix(seed)`、端末の時計に頼らない）。レース中でも結果画面でも押せる。確認は出さない（何も失わないので）。
- **ゴースト**：前の試走（同じセッションで、ゴールまで走ったもの）を半透明で並べて走らせる（タイムアタックの `GhostPlayer`：その試走の設定＋自分の入力を別のシミュレーションで再生。今の試走には一切触れない）。コースが変わったら消す（距離・形が違うと比べられない）。馬・馬場・頭数・強さを変えても残す（ラベルに馬の名前と前のタイム）。オプションで消せる。ゴーストは端末の中だけ（サーバーに送らない、他の人に見せない）。
- 何回でも走れる（回数制限・スタミナ・待ち時間なし）。

### 50.4 練習のための表示（オプション、端末の設定 `muchi.practice.options`）
| オプション | 既定 | 中身 |
|---|---|---|
| ムチの目安を出す（`whipWindow`） | ON | 残り距離のバーに、出走前アドバイス（§39）のムチの打ち始めの帯を出す：残り（打ち始め＋50m）〜（打ち始め−150m）＝ `RaceAdvice.CheckWhipTip` が「アドバイスどおり」と数える範囲と同じ。帯の中にいる間は帯が明るくなる（点滅はしない）。色は §41 のトークン `cue.whipChance`（色覚の設定で変わる） |
| 最後の400mをスロー（`slowFinal`） | OFF | 自分の馬の残りが 400m 以下でゴールするまで、時間の進みを 0.5 倍にする（`PracticeClock`）。**表示の時計だけ**が遅くなる：エンジンは同じ 20Hz の tick で進み、入力は tick に乗るので、同じ入力なら結果は同じ。動きを減らす設定（§41）ではスローへの切り替えをなめらかにしない（その場で切り替わる） |
| ゴーストを出す（`ghost`） | ON | 50.3 |

### 50.5 結果画面
- Round 8 の振り返り（`RaceDebrief.FromInputs`：勝因・敗因の1行とヒント）。
- 出走前アドバイスとの比べ（§39.6 と同じ `RaceAdvice.CheckWhipTip`）：「ムチはアドバイスどおり残り400mから」など1行。アドバイスは練習の設定（`mode: friend`、1コース、相手の脚質はわかっている）で端末が `RaceAdvice.Compute` する。§39.6 の設定「出走前アドバイス」が OFF でも練習の結果画面の1行は出す（練習画面のオプション「ムチの目安」が OFF のときは出さない）。
- 前の試走との差（ゴーストがあれば）：「前回より0.42秒速い」。
- 「報酬はありません（練習）」の1行を必ず出す。コイン・XP・ミッションの欄は出さない。
- ボタン：「同じ展開でもう一度」「新しい相手で」「条件を変える」「この瞬間を撮る」（フォトモード §38、`source.mode: "practice"`）。**「リプレイを保存」は出さない**（50.7）。

### 50.6 オフライン・内蔵の予備
- カタログが一度も取れていない端末（初回起動からずっとオフライン）は内蔵の予備で走る：コース = 練習コース `kirameki_turf_2000`（芝・良・昼）、強さ = `easy`/`normal`/`strong`/`top`（50.1 と同じ値）、CPU = 内蔵の CPU 11頭（`RaceFactory` の練習の馬）、馬 = 相棒（端末にあれば）か既定の相棒、ルールセット = アプリに入っている既定のもの。
- 覚えたカタログの馬は古いことがある（オフラインの間に引退した馬など）。それでも練習は何も配らないので困らない。オンラインに戻れば取り直す。

### 50.7 リプレイ・写真・共有（決めたこと）
- **マイリプレイ（§37）には保存できない**。マイリプレイは「確定したレース」をサーバーが持つ元のログで保存する仕組みで、練習はサーバーに無い（`POST /v1/replays` は練習の `raceId` を知らない → 404）。練習の見返し用の再生も作らない（すぐやり直せて、前の試走はゴーストで並べて見られるので）。
- **フォトモード（§38）は使える**：ひとりで走るレースなので、走っている途中でも止めて撮れる（`PhotoModeModel.CanPause` は練習で true）。写真の記録の `source.mode` は `practice`（§38 に既にある値）。
- **リプレイ共有（Round 9 の動画・画像カード）は練習では出さない**：着順と頭数の入ったカードは本物のレースに見えるため。写真のカードには「練習レース」と出る（50.2）。

### 50.8 解放・FTUE（docs/planning/06 §2.3・§4.3）
- サーバーの解放キーは使わない（マイリプレイ §37 と同じ：端末の中だけの機能）。**チュートリアル（FTUE の流れ：初レース → 命名 → 無料10連 → ホーム）が終わったら**いつでも開ける（`PracticeModel.Available` = `OnboardingFlow.InFtue == false`）。FTUE の途中では出さない。
- FTUE と競わない：次にやること（§45）のカードにはしない、ホームの大きな「レースへ」の行き先は変えない、自分から「練習しませんか」と案内しない。入口はレースの画面の「練習」と「機能・イベント」の一覧。オフラインのエラー（06 §5.3「オフラインです。練習レースは遊べます」）からも開ける。

### 50.9 アクセシビリティ（§41）
- 文字の大きさ（`TextScale`）：設定画面・結果画面の文字は全部従う（最大でもはみ出さない。a11y-flow に入れる）。
- ムチの入力（タップ／長押し、`WhipHold`）・かんたん操作（§27）・字幕・片手の配置は普通のレースと同じに効く。
- 動きを減らす：スローの切り替え・帯の明るさの変化をその場で切り替える（アニメーションしない）。帯は点滅しない（`FlashLimiter` の対象外の静的な表示）。
- 色：ムチの目安の帯は `cue.whipChance`、ゴーストは位置の色 `position.other` を半透明で。色だけに頼らない（帯には「ムチの目安」の文字、ゴーストには名前の札）。

### 50.10 KPI（クライアントのイベント、任意）
| イベント | props | 列 |
|---|---|---|
| `practice_start` | `trackId`、`fieldSize`（2〜12）、`strength`（50.1 の id）、`restart`（`none`/`same_seed`/`new_seed`） | s1 = trackId、s2 = strength、s3 = restart、count = fieldSize |
| `practice_finish` | `trackId`、`fieldSize`、`strength`、`place`（1〜12、ゴールしなければ 0） | s1 = trackId、s2 = strength、count = fieldSize、place = place |
入力・tick・seed・タイムの細かい値は送らない（props は `strict`）。送るのはオンラインの時だけ（既存の送信キュー）。このイベントは何も配らない（KPI の取り込みは状態の報酬に触れない）。クエリは `docs/ops/kpi-queries.md`「練習レース」。

### 50.11 クライアント
- `Muchi.Client`：`ApiClient.GetPracticeCatalogAsync`、`PracticeCatalog`（`Parse`・`Fallback`）、`PracticeSetup`、`PracticeSession`（`BuildConfig`・`Start`・`Restart`・`Ghost`・`Advice`・`WhipWindow`・`Finish` → `PracticeResult`）、`PracticeClock`、`AnalyticsEvents.PracticeStart`・`PracticeFinish`。`ProtocolCodec.ParseHorse`・`HorseToJson`（設定の馬の読み書きを1か所に。結果は今までと同じ）。
- Unity ゲーム層 `PracticeModel`：入口の可否（FTUE）、カタログの取得と端末の写し・予備、設定の選択肢（馬・コース・馬場・昼夜・頭数・強さ）と既定、オプション、`OfflineRaceDriver`＋`RaceObserver` でのレース、時計（スロー）、ムチの目安の帯、ゴーストの位置、やり直し、結果の行、写真の可否、KPI。描画は `docs/handoff-codex-round18-practice.md`。
- デプロイ：新しい GET と KPI の2種類だけ（検証器は変わらない、マイグレーションなし）。サーバーだけ出せばよい。

## 51. 個人データの開示・ダウンロード（personal data export / disclosure request、REQ-DEX-001〜020、`server/src/domain/dataExport.ts`・`dataExportService.ts`・`server/src/do/dataExportPorts.ts`、C# `DataExport.cs`・`Muchi.Game.DataExportModel`）
個人情報保護法の**保有個人データの開示請求**（法33条、電磁的記録での提供を含む）と、海外のプレイヤーが期待する「データのダウンロード」（GDPR 15条・20条の水準）に応える。設定 › プライバシーからプレイヤー本人だけがリクエストでき、サーバーが**非同期に**、機械で読める JSON と人が読める概要（テキスト）を作り、非公開の R2 に置いて、短い時間だけ有効な署名つきリンクで渡す。メールアドレスは集めない（本人確認 = ログイン中のプレイヤー）。コイン・アイテムは動かない（E 番号なし）。

### 51.1 流れ
1. `POST /v1/player/data-export`（要認証・`Idempotency-Key` 必須・本文なし）→ プレイヤーの状態に `queued` のリクエストを1件作る。KPI `dex_request`。言語は `Accept-Language`／`?lang=`（`ja`／`en`、概要と履歴の文の言語）。
2. プレイヤーの Durable Object の**アラーム**が作る（リクエストの経路では作らない）：状態・SQL の履歴（コインの台帳は法定保存期間内、ガチャの記録は 90 日以内）・ディレクトリの公開名・自分が送った通報・分析イベントを集め、JSON と概要を R2 の `private/data-export/<playerId>/<requestId>.json`／`.txt`（非公開バケット `REPLAYS`、公開の `SNAPSHOTS` には置かない）に書き、`ready` にする。
3. `ready` になった時、アクティビティ（§40）に1件（`data_export_ready`、`category: "account"`、リンク先 `privacy`、`linkId` = requestId）。KPI `dex_ready`。プッシュは送らない。
4. `GET /v1/player/data-export` が `ready` の間、JSON と概要それぞれの**署名つきリンク**（`linkTtlMinutes` 分、ただしエクスポートの期限を超えない）を返す。画面を開くたびに新しいリンク。
5. `keepDays` 日後にファイルを削除（アラーム。R2 のライフサイクルルール（接頭辞 `private/data-export/`、`keepDays + 1` 日）を予備に設定する、`docs/ops/deploy.md`）。状態は `expired`。

### 51.2 状態とルール
- 状態 `dataExport`：`{ current: DexRequest|null, lastReadyRequestAt, audit[], pendingDeletes[], deletesTriedAt? }`。`DexRequest`：`{ requestId, status: queued|building|ready|failed|expired, lang, requestedAt, nextAt, attempts, readyAt?, expiresAt?, sizeBytes?, summaryBytes?, sha256?, failReason?, downloads, filesDeleted? }`。
- **1件ずつ・冪等**：`queued`／`building`／`ready`（期限内）の間にもう一度リクエストすると、新しく作らずに今のものを返す（`created: false`）。同じ `Idempotency-Key` は最初の応答。
- **回数の制限**：新しいリクエストは、最後に `ready` になったリクエストの `requestedAt` から `cooldownDays` 日後から（`429 DATA_EXPORT_COOLDOWN`、`details.availableAt`）。`failed` は数えない（すぐにもう一度リクエストできる）。`keepDays ≤ cooldownDays`（同時に2つのファイルが残らない）。
- **作成の再試行**：アラームが取ると `building`（リース 5 分。アラームが途中で止まっても5分後に取り直す）。失敗は 1分・10分・1時間・6時間の間隔で `maxAttempts` 回まで、その後 `failed`（途中まで書いたファイルは削除の予定に入る）。遅れて届いた古いリクエストの完了は無視し、そのファイルを削除の予定に入れる。R2 の削除に失敗したキーは `pendingDeletes` に残り、10分ごとに再試行する。
- **アカウント削除の予定中**（§9.4 `scheduled`）もリクエスト・ダウンロードできる（画面に「削除が終わるまではダウンロードできます」）。削除の実行が始まったら（`deleting`）新しいリクエストは `DELETION_PENDING`、作成も止まる。削除の手順に `data_export` の段（`finalize` の前）を足し、R2 のファイル（今のものと削除待ちのもの）を消す。削除後のリンクは `404`、アラームの掃除は何も作らない（`wiped`）。
- **監査ログ**：`requested`・`building`・`ready`・`retry`・`failed`・`downloaded`・`expired`・`files_deleted`（時刻・requestId・短い詳細、`auditKeep` 件）。中身は書かない。

### 51.3 API
| メソッド | パス | 認証 | 本文 → 応答 |
|---|---|---|---|
| GET | `/v1/player/data-export` | プレイヤー | → `DataExportView` |
| POST | `/v1/player/data-export` | プレイヤー（`Idempotency-Key`） | なし → `DataExportView` ＋ `created` |
| GET | `/v1/data-export/file?p&r&f&e&s` | なし（署名） | → ファイル本体（`content-disposition: attachment`、`cache-control: private, no-store`、JSON は `x-content-sha256`） |
| GET | `/v1/admin/players/:playerId/data-export` | 運用（viewer、監査あり） | → 状態・時刻・大きさ・試行回数・ダウンロード回数・監査ログ（**中身・リンク・R2 のキーは返さない**） |

```json
{ "enabled": true, "status": "ready", "statusText": "ダウンロードできます", "requestId": "dex_…", "requestedAt": 1794790800000,
  "readyAt": 1794790860000, "expiresAt": 1795395660000, "sizeBytes": 48211, "canRequest": false, "nextAvailableAt": null, "keepDays": 7,
  "deletionScheduled": false, "deletionNote": null, "notice": "アカウントに保存されているあなたのデータ（…）をまとめてダウンロードできます。…",
  "download": { "json": { "url": "/v1/data-export/file?p=…&r=dex_…&f=json&e=…&s=…" }, "summary": { "url": "…&f=summary&…" }, "linkExpiresAt": 1794791460000 } }
```
- `status`：`none`・`queued`・`building`・`ready`・`failed`・`expired`（`ready` で期限を過ぎたものはアラームの前でも `expired`）。`download` は `ready` の時だけ。`url` は API のベースからの相対パス。
- 署名：`s = base64url(HMAC-SHA256(TICKET_SECRET + "|data-export", "dex1|p|r|f|e"))`。リンクは1人・1リクエスト・1ファイルに結び付き、`e` を過ぎると `410 LINK_EXPIRED`、形・署名が違えば `403 LINK_INVALID`、今の `ready` のリクエストでなければ `404`。
- `progression.dataExport` が無い／`enabled: false` なら `404 NOT_FOUND`。

### 51.4 JSON の形（`format: "muchi-issen/personal-data-export"`, `version: 1`、フィールド名は固定。足す時は後ろに足し、意味を変える時は `version` を上げる）
時刻はすべて Unix ミリ秒（UTC、`timeUnit: "unix_ms_utc"`）。先頭にヘッダー、その後に下の順で1行ずつの区切り（大きな一覧は1要素1行）で、行単位のツール・ストリームのパーサーで読める。
| キー | 中身 |
|---|---|
| `format` `version` `requestId` `playerId` `generatedAt` `language` `timeUnit` `sections` `truncated` `notIncluded` `unclassified` | ヘッダー。`truncated` = `[{section, omitted}]`、`notIncluded` = 持っているが入れていないもの `[{key, reason}]`、`unclassified` = 分類されていないキー（常に空、テストで確認） |
| `account` | `playerId`・`createdAt`・`lastSeenAt`・`age`（生年月・保護者の同意）・`consent`（規約・プライバシーポリシーの版と履歴）・`flags`・`deletion`（予定の状態・日時、確認トークンなし）・`moderation`（状態・期限・日時。検知の理由は入れない）・`transfer`（§54 引き継ぎコード、Round 19 統合：今のコードの種類・発行日時・期限・期限切れか、今日の発行数、前の端末の締め出しの時刻、発行・取り消し・引き継ぎの履歴。**コードの ID・パスワード・ハッシュ・塩・引き継ぎの再送用の記録は入れない**） |
| `profile` | 表示名・称号・勝負服・勝負服エディタのプリセット・統計・レーティング（丸め）・シーズン・シーズンの記録・`showcase`（§62 トレーナーカードの選択：自分の馬・ピン・コース・一言・背景の ID、Round 21） |
| `settings` | アクセシビリティ（§41）・かんたん操作・実況パック・コース／部屋の条件・装備・厩舎の整理・プッシュの設定・広告の設定と視聴の記録（広告ネットワークの取引 ID なし）・殿堂の公開範囲・ライバルの不参加 |
| `horses` | 馬（`studSire` は他のプレイヤーの ID を外し、馬の名前だけ）・絆・調教・`goals`（§53 馬ごとの目標の達成日時とホームのピン、Round 18 統合） |
| `items` | アイテム・素材・アイテムの未精算・アイテムの記録 |
| `wallet` | **有償・無償を分けた**残高・未精算・有償コインのロット（付与・残り・日時・購入の参照）。有償コインに有効期限はない旨の表示 |
| `coinHistory` | `paid`／`free` を**別の一覧**で（§33 の `CoinRow`：参照・日時・増減・残高・分類・文）。法定保存期間内の全行（大きさの上限を超えた時だけ古い行から省略し `truncated` に書く） |
| `purchases` | 購入（§33 の `PurchaseRow` ＋ `storeTransactionId`＝ストアのレシートの番号）・月ごとの購入額・初回購入・定期購入・厩舎手当・オファーの表示記録 |
| `gacha` | ガチャの記録（90 日以内、§33 の `GachaRow`）・天井のポイント・ステップアップ |
| `giftBox` | 受け取り前・履歴（運営の内部メモ `note` は外す） |
| `social` | フレンド（ID と今の公開名だけ）・送ったフレンド申請（ID・名前・日時）・受けた申請／部屋の招待（数だけ）・**ブロック**（`teamFeed.muted`、ID と名前）・支部（ID・加入日・申請）・スタンプを送った支部・マイ厩舎（配置・いいねの数）・招待（使ったコード・日時・端末のハッシュ・招待した人の到達。相手の ID なし）・`friendSuggest`（§49：「おすすめに表示しない」・自分が消した人の ID・今の公開名・日時・理由、最近の対戦相手は**数だけ**。Round 18 統合）・`namesAvailable` |
| `reportsMade` | **自分が送った**通報：レースの通報（`kind: "race"`、レース・日時・未対応／対応済み）と §47 のプレイヤーの通報（`kind: "player"`、日時・理由・入口・対象の種類・**自分の補足**・`open`／`resolved`。Round 18 統合）。**通報した相手の ID・写し・対応の内容・担当者は入れない**。`today` = 今日の通報の数（相手ごとの数は相手の ID なので入れない）。どちらかが読めない時は `available: false` |
| `activity` | お知らせ（日時・種類・件数・文。送った人の ID なし） |
| `replays` | マイリプレイの保存・最近のレース（メタデータ。リプレイ本体は入れない） |
| `photos` | 保存した写真の記録（§38、画像は元から保存しない） |
| `cups` | 参加中・履歴・トロフィー・受けた招待（主催者の ID なし） |
| `recaps` | 振り返りのスナップショット（§43） |
| `play` | シーズンパス・ログインボーナス・ミッション・オンボーディング・配合・タイムアタック（記録・走行）・週替わりチャレンジ・イベント・大会・ライバル（**結果だけ**、相手の ID・名前なし）・種付け（自分の出品と記録、相手の ID なし）・殿堂・図鑑・支部の共同目標・復帰・次にやること・プッシュの予定・`tips`（§57 読んだヒントのカードの ID、Round 19 統合） |
| `devices` | 登録した端末（OS・登録日・最終利用・言語・プッシュトークンの末尾6文字だけ） |
| `analytics` | KPI の状態・実験の割り当て、`events`：仮名の分析 ID（塩つきハッシュ）に結び付いた KPI の行（Analytics Engine の保存期間 90 日以内、`KPI_SQL_ACCOUNT_ID`／`KPI_SQL_TOKEN` が無ければ `available: false`） |
| `helpInquiries` | ゲーム内のお問い合わせ（§48、Round 18 統合）：`items` = 問い合わせごとに種類・状態・言語・日時・**自分が書いた内容**（個人情報を置き換えた後の文と置き換えた数）・添えた記録・自動で添えた情報・メッセージ（`from: player/support`・本文・日時。**返信した運営の ID は入れない**＝運営のメモ）、`articleVotes` = 記事の「役に立った」 |

### 51.5 入れないもの（`notIncluded[].reason`）
- `internal_idempotency`：`idem`・`appliedRaces`（再試行の防止。結果は他のセクションにある）
- `internal_counter`：`v`・`ledgerSeq`・`counters`
- `internal_queue`：`pendingEventPushes`（配信待ち。届いた結果は他のセクション）
- `operator_notes`：`supportFlags`（通報した人の ID を含みうる）・`supportGrants`・`adminOps`（運営の操作の記録。付与されたものはコインの履歴・プレゼント・アイテムにある）
- `export_meta`：`dataExport`（このエクスポート自身の記録）
- `third_party`：他のプレイヤーについての情報（申請・招待を送ってきた人、ライバル・種付けの相手、お知らせを送った人の ID）。**他のプレイヤーが自分について送った通報**は入れない（通報した人を特定できてしまい、第三者の権利利益を害するおそれ（法33条2項1号）と、モデレーションの業務に著しい支障（同2号）。弁護士の確認待ち、`docs/planning/03-legal-risk.md`）。
- Round 19 統合：§55 の応援は誰が送ったかを保存しない（部屋の中で数えるだけ、`replays/<raceId>.cheers.json` も時間の区切りごとの数だけ）ので、エクスポートに入れるものは無い。§56 の画質・通信量の設定は端末だけに保存され、サーバーには無い。
- Round 20 統合：§58 の `privacyChoices` は `account` に全部（選んだ値・版・時刻・端末の状態・履歴）。§59 の `reviewPrompt` は `analytics.reviewPrompts`（頼んだ時刻・瞬間・プラットフォーム・形・答え。セッション id は入れない）。§60 のエラー報告は状態のキーを足さず、自分の id が付いた見本を `analytics.clientErrors` に出す（読めない時は `available: false`）。§61 の端末のリマインダーは**端末の中だけ**（予約・前に予約した id・「ロック画面に詳しく表示」・前置きを出した回数はどれもサーバーに無い）ので出すものは無い（`reminders` の選択は既存の `push.prefs` と一緒に出る）。§58.11 の「1セッションに1つ」の記録も端末の中だけ。
- Round 21 統合：§62 の `showcase` は `profile.showcase`（自分の馬・ピン・コース・一言・背景の id だけ）。§64 の `releaseNotes` は `play.releaseNotes`（見た版と `baseline`）、§65 の `calendar` は `play.calendar`（印の id・種類・期限）。§63 のリンクは状態のキーではないが、**自分が作ってまだ開くリンク**をディレクトリから読んで `social.links`（種類・作った時刻・期限。トークンは入れない＝リンクは行き先の鍵なので、ファイルが人に渡っても開けない。読めない時は `available: false`）。§64 の「このセッションで見た」・§63 の待っているリンク・§65 の印から作る端末の通知（§61）は**端末の中だけ**なので出すものは無い。
- 新しい状態のキーは `DEX_CLASSIFICATION`（`Record<keyof PlayerState | 拡張キー, …>`）にどちらかを書かないと型チェックとテスト（`test/data-export.test.ts`：インターフェース・`PlayerState & { … }` の拡張・実際の状態）が失敗する。Round 18 統合で分類したキー：`friendSuggest`→`social`、`horseGoals`→`horses`、拡張キー `help`→`helpInquiries`、`reports`（通報の1日の数）→`reportsMade`。§46 メンテナンス・§50 練習レースはプレイヤーの状態に何も置かない。§52 定型チャットの投稿は支部のフィード（TeamDO）にあり、プレイヤーの状態には無い：支部のフィードは支部員の共有の場で、決まった文と選んだ値だけ・保存は `retainDays` 日と件数まで（§52.6）なので、エクスポートには入れない（`docs/planning/03-legal-risk.md` の確認事項）。

### 51.6 人が読める概要（`.txt`）
タイトル・説明・作成日時・プレイヤー ID・表示名・作成日・有償／無償の残高・馬・購入・コインの履歴・ガチャ・フレンド・ブロック・通報・お知らせ・リプレイ・写真・振り返り・端末・分析イベントの件数、省略した行（あれば）、入れていないもの、問い合わせ先。ラベルはプレイヤーの言語（英語はカタログで訳す）、値（名前など）は訳さない。

### 51.7 設定 `progression.dataExport`（リモート設定で変更可）
`{ enabled, cooldownDays (1..30), keepDays (1..30, ≤ cooldownDays), linkTtlMinutes (1..60), maxBytes (1,000,000..50,000,000), maxAttempts (1..10), auditKeep (10..200) }`。起動時と各版で検証（`dataExportProblems`）。既定 `{ true, 7, 7, 10, 20000000, 5, 50 }`。

### 51.8 KPI
`dex_request`（`s1` = 言語）・`dex_ready`（`s1` = 言語、`value` = バイト数、`durationMs` = リクエストから準備まで、`count` = 省略した行）・`dex_download`（`s1` = `json`／`summary`、`isFirst` = そのリクエストで最初のダウンロード）。すべてサーバー。クエリは `docs/ops/kpi-queries.md`。

### 51.9 クライアント
`Muchi.Client` `ApiClient.GetDataExportAsync`・`RequestDataExportAsync`・`DataExportFileUrl`、`DataExportStatus`（`DataExport.cs`）。リンクは API のベースにつないで OS のブラウザ／共有シートで開く（アプリの中に保存しない）。Unity のゲーム層 `Muchi.Game.DataExportModel`（状態ごとの文・ボタン・次に申し込める日・削除の予定の注意・期限の表示）。

## 52. 支部の定型チャット（branch quick chat、REQ-QCHAT-001〜016、`server/src/domain/quickChat.ts`・`server/master/quick-chat.json`・§18 の `teamFeed.ts` を拡張、C# `QuickChat.cs`・`Muchi.Game.QuickChatModel`）
支部の中で、**決まった文（定型文）だけ**で話せるようにする。自由入力は無い（安全のための設計。docs/planning/03「支部の定型チャット」）。文の中の空欄（スロット）には、**サーバーが本人の状態から確かめた安全な値だけ**が入る：自分の馬の名前・コース名・自分のレース結果・タイムアタックの記録・自分が出ているカップ・同じ支部の仲間。§18 の支部フィードに新しい種類 `qchat` として入る（別のフィードは作らない）。応援は §18 のスタンプのリアクションをそのまま使う。コイン・アイテムは動かない（E 番号なし）。

### 52.1 定型文のマスター `server/master/quick-chat.json`
```json
{ "version": 1,
  "config": { "enabled": true, "postIntervalMs": 15000, "postsPerDay": 30, "repeatWindowMs": 600000, "mentionsPerDay": 10, "retainMax": 60, "retainDays": 14 },
  "phrases": [
    { "id": "otsukare", "category": "greet", "ja": "おつかれさま！", "en": "Good work today!" },
    { "id": "run_together", "category": "invite", "ja": "{course}で一緒に走ろう", "en": "Let's race together at {course}" },
    { "id": "nice_player", "category": "cheer", "ja": "{player}さんナイス！", "en": "Nice one, {player}!" } ] }
```
- 1つの文は **日本語と英語の組**（`ja`・`en`）。保存するのは文の `id` とスロットの値だけで、文字列は保存しない。読む人それぞれの言語（`?lang=` / `Accept-Language`、§23）で組み立てる。
- スロット（`{name}`）は `course`・`horse`・`race`・`time`・`cup`・`player` だけ。1文に最大2つ、同じスロットは1回。`ja` と `en` のスロットは同じ組であること。`{player}` を含む文は「声かけ」（`mention`）。
- 検証（起動時・リモート設定の各版、REQ-QCHAT-002）：`id` は `^[a-z0-9_]{1,32}$` で重複不可／`category` は `greet`・`cheer`・`team`・`race`・`invite`／`ja` 1〜30 文字・`en` 1〜60 文字／共有の賭け言葉リスト（`bettingWords.ts`）に当たらない（`ja`・`en` とも）／`ja` に「倍」「お得」「今だけ」「残りわずか」「通常価格」が無い／`en` は §23 の英語の文言チェック（`enWordingProblems`）を通る／`ja` に英字の URL・`http`・`www` が無い。`config` の範囲：`postIntervalMs` 3,000..3,600,000、`postsPerDay` 1..200、`repeatWindowMs` 0..86,400,000、`mentionsPerDay` 0..100、`retainMax` 10..§18 の `feedSize`、`retainDays` 1..90。
- 定型文の英語はマスターの中にあるので、`locale-en.json` には書かない（`npm run l10n:missing` の対象外。§36 の実況パックの文と同じ扱い）。

### 52.2 スロットの値（サーバーが確かめる、REQ-QCHAT-004）
| スロット | 送る値 | 確かめること（投稿する人の状態） | 表示（ja ／ en） |
|---|---|---|---|
| `course` | コースID | `tracks.json` にある | マスターのコース名（英語は §23 の表） |
| `horse` | 馬ID | 自分の馬（現役・引退どちらも） | 馬の名前（投稿の時点の写し。**翻訳しない**） |
| `race` | レースID | 自分の最近のレース（マイリプレイ §37 の `recent` にある、確定したレース） | 「{コース}で{n}着」／「{n:ord} at {course}」 |
| `time` | コースID | そのコースのタイムアタックの自己ベスト（通算）がある | 「{コース} 1:59.8」（同じ形） |
| `cup` | カップID | 自分が出ている（主催・参加）カップで、名前が分かるもの | カップ名（主催者が付けた名前の写し。**翻訳しない**） |
| `player` | プレイヤーID | 同じ支部の仲間で、自分ではなく、**どちらかがもう一方をブロックしていない** | その人の今の表示名（**翻訳しない**）。支部を抜けた・消えた人は「元メンバー」／「Former member」 |
- 足りないスロット・余分なスロット・知らない値は `400 BAD_REQUEST`、確かめられない値（自分の馬でない・記録が無い・カップに出ていない）は `409 NOT_ELIGIBLE`、ブロックの関係にある人の名前は `409 NOT_ELIGIBLE`（理由は言わない）。

### 52.3 投稿（REQ-QCHAT-003/005）
- `POST /v1/teams/me/feed/quick-chat` `{ "phraseId": "run_together", "slots": { "course": "kirameki_turf_2000" } }` → `{ teamId, seq, at, phraseId }`。本文にはこの2つだけ（`text` などを付けると `BAD_REQUEST`）。`slots` の値はそれぞれ `^[A-Za-z0-9_:\-]{1,64}$`。
- 支部の仲間だけ（`NOT_IN_TEAM`）。削除の予約中は `DELETION_PENDING`。`config.enabled = false` の間は `404 NOT_FOUND`。
- 上限（1人ずつ、§18 のスタンプとは別に数える）：`postIntervalMs` に1回、ゲーム日（REQ-DAY-001）ごとに `postsPerDay` 回、同じ文・同じ値を `repeatWindowMs` の間に続けて送らない、声かけ（`{player}` の文）はゲーム日ごとに `mentionsPerDay` 回。超えたら `429 RATE_LIMITED`。
- 再送で二重に載らないように、クライアントは自動の再試行をしない（スタンプと同じ）。同じ文の連投は上の「同じ文」の決まりでも止まる。

### 52.4 フィードの項目（`GET /v1/teams/me/feed`、§18）
`kind: "qchat"` の項目が加わる（`qchat` 以外の項目には `qchat: null`）：
```json
{ "seq": 41, "at": 1794614400000, "kind": "qchat", "playerId": "p_abc", "displayName": "アオバ", "mine": false,
  "stampId": null, "stampAsset": null, "race": null, "goal": null,
  "qchat": { "phraseId": "nice_player", "category": "cheer", "mention": true, "mentionsMe": true, "anon": false,
             "qchatText": "シノノメさんナイス！",
             "slots": [ { "name": "player", "ref": "p_me", "qchatValue": "シノノメ" } ],
             "report": { "kind": "team_feed", "teamId": "t123", "seq": 41 } },
  "reactions": [ { "stampId": "nice", "count": 2, "mine": true } ], "myReaction": "nice" }
```
- `qchatText` は読む人の言語で組み立てた文。`qchatText`・`qchatTemplate`・`qchatValue` は**組み立て済み**なので、応答の境目の翻訳（§23）は触らない（プレイヤーの名前・馬の名前・カップ名が辞書の言葉と同じでも訳されない）。
- 表示名は §18 と同じく今の名簿から。`anon: true`（抜けた人の投稿、52.6）は `playerId: ""`・`displayName` 「元メンバー」／「Former member」・`mine: false`。
- **ブロックは両方向**（REQ-QCHAT-007、ブロックの一覧は1つ = §18 のミュート）：私がブロックした人の `qchat` 項目は私に見えない（§18 と同じ）うえに、**私をブロックした人の `qchat` 項目も私に見えない**。そういう項目へのリアクションは `404 NOT_FOUND`。名前のスロットにも選べない（52.2）。TeamDO は仲間ごとのブロックの写しを持ち、フィードを開いた時・ミュートを変えた時・投稿の時に本人の一覧で更新する。Round 18 統合：§47 のブロックの画面（`PUT`／`DELETE /v1/blocks/:playerId`）・通報の「ブロックもする」・ライバルのブロック（`POST /v1/rival/block`）の後も、すぐに写しを更新する（`TeamsService.syncBlocks`、失敗しても次にフィードを開いた時に直る）。
- 応援（リアクション）は §18 の `PUT /v1/teams/me/feed/:seq/reaction` をそのまま使う（スタンプで1人1つ）。応援の通知（プッシュ）は出さない。
- 通報：§47 の `POST /v1/reports` に `content: {kind: "qchat", feedRef: "<teamId>:<seq>"}`（`qchat.report` から作る、Round 18 統合。§47.4）。受け付けた後は §18 の `POST /v1/teams/me/feed/:seq/report` で自分のフィードから隠す（§47 の支部フィードの通報と同じ流れ）。抜けた人の文（`anon`）は §18 の通報だけ。

### 52.5 定型文と選べる値（`GET /v1/teams/me/quick-chat`、REQ-QCHAT-008）
```json
{ "enabled": true, "teamId": "t123",
  "limits": { "postIntervalMs": 15000, "postsPerDay": 30, "mentionsPerDay": 10, "repeatWindowMs": 600000 },
  "usage": { "postsToday": 3, "mentionsToday": 1, "nextPostAt": 1794614415000 },
  "phrases": [ { "id": "run_together", "category": "invite", "slots": ["course"], "mention": false, "qchatTemplate": "{course}で一緒に走ろう" } ],
  "options": {
    "course": [ { "ref": "kirameki_turf_2000", "qchatValue": "きらめき競馬場 芝2000m" } ],
    "horse":  [ { "ref": "h12", "qchatValue": "シンセイアカツキ" } ],
    "race":   [ { "ref": "r9f", "qchatValue": "きらめき競馬場 芝2000mで2着" } ],
    "time":   [ { "ref": "kirameki_turf_2000", "qchatValue": "きらめき競馬場 芝2000m 2:01.3" } ],
    "cup":    [ { "ref": "c77", "qchatValue": "夜の芝カップ" } ],
    "player": [ { "ref": "p_abc", "qchatValue": "アオバ" } ] } }
```
- `qchatTemplate` は読む人の言語の文で、スロットは `{course}` のまま（クライアントが選んだ値で埋める。選ぶ前は空欄で見せる）。
- `options` は投稿の時に受け付ける値だけ（自分の馬は現役から最大 20、最近のレース最大 10、タイムアタックの記録のあるコース、出ているカップ、ブロックの関係にない仲間）。値の並びは名前・新しい順。支部に入っていなければ `teamId: null`・`phrases` はそのまま・`options` は空・`usage` は 0。

### 52.6 支部を抜けた時・アカウント削除（REQ-QCHAT-010、docs/planning/03 の決定）
- **支部を抜けた・外された**：その人の `qchat` 項目は残し、**名前を出さない**（`anon: true`、「元メンバー」）。文は定型でスロットの値も確かめた安全な値なので、仲間の会話の流れ（返事・応援）を壊さないために消さない。ブロックの写しと上限の数はその時に消す。他の人の文の中でその人を指す名前のスロットも「元メンバー」になる（名簿に居ないので）。§18 のスタンプ・レースの項目は今までどおり。
- **アカウント削除**：その人の `qchat` 項目は**消す**（§18 の削除の手順 `feedForget` と同じ。投稿した支部と今の支部の全部）。他の人の文の中でその人を指すスロットは値を消して「元メンバー」と出す。ブロックの写し・上限の数も消す。削除の予約中は投稿できない。

### 52.7 保存の量（REQ-QCHAT-006）
支部ごとに `qchat` 項目は新しい方から `retainMax` 件まで、`retainDays` 日まで（投稿の時と読む時に古い物を落とす）。§18 の `feedSize`（全部の種類で100件）はそのまま上限。チャットでレース・共同目標の項目が押し出されすぎないように `retainMax` は `feedSize` より小さくする。

### 52.8 アクティビティ（§40）と通知
- 新しいプッシュの種類は**作らない**。声かけ（`{player}` の文）で名前を出された人にだけ、§40 のアクティビティに `qchat_mention` を書く（カテゴリ `friends`、開く画面 `team_feed`、まとめる＝24時間・未読の間は1件にまとめる。文：「{name}さんが支部のチャットであなたに声をかけました」／「支部のチャットで{n}件の声がかかりました」）。
- 数を抑える：声かけは送る人ごとに1日 `mentionsPerDay` 回（52.3）、受ける側はまとめて1件、ブロックしている相手からは書かない（§40 の決まり）、削除の予約中・削除の手順中の人には書かない。投稿の項目の ID ごとに1回（`qchat:{teamId}:{seq}`）。

### 52.9 KPI（サーバーが書く、REQ-QCHAT-011）
`qchat_post`（`s1` 文ID、`s2` 支部ID、`s3` `mention`／空、`count` スロットの数）・`qchat_react`（`s1` スタンプID、`s2` 文ID、`s3` 支部ID。新しいリアクションの時だけ）。docs/ops/kpi-queries.md。

### 52.10 API（要認証）
| メソッド | パス | 本文 → 応答 |
|---|---|---|
| GET | `/v1/teams/me/quick-chat` | → 52.5 |
| POST | `/v1/teams/me/feed/quick-chat` | `{ phraseId, slots }` → `{ teamId, seq, at, phraseId }` |
| GET | `/v1/teams/me/feed` | §18 の応答に `qchat` 項目（52.4） |
| PUT | `/v1/teams/me/feed/:seq/reaction` | §18 のまま（`qchat` 項目にも使える） |

## 53. 馬ごとの目標（per-horse goals、REQ-HGOAL-001〜016、`server/src/domain/horseGoals.ts`、C# `HorseGoals.cs`（`HorseGoalChain`）・`Muchi.Game.HorseGoalsModel`、共有ベクター `contracts/horse-goals.vectors.json`）
馬ごとに**短い目標の列（チェーン）**を出し、その馬の物語にする（初勝利 → 10戦 → 得意の馬場で勝つ → コースで記録 → 得意の距離の外で勝つ → ランク戦で上位 → 大会優勝）。目標は馬の適性（芝ダ・距離・脚質）と固有スキルの有無から**純粋な関数**で決まり、進み具合は §34 の戦績（確定した結果だけ）から数える。報酬は**見た目だけ**（リボン・殿堂の銘板の飾り）。コイン・素材・アイテム・能力は何も動かない（経済の目標なし、E 番号・balance-targets の節なし。ランク戦の強さは変わらない）。設定は `progression.horseGoals`（`horseGoalsProblems` で検証。無い／`enabled: false` なら機能ごと無し。§34 の殿堂が無効なら有効にできない）。

### 53.1 目標の列（`horseGoalChain`、REQ-HGOAL-001/002）
入力は馬（`surface`・`distMinM`・`distMaxM`・`style`・`skillId`）とコースの一覧（`id`・`name`・`surface`・`distanceM`、master tracks.json）だけ。同じ入力なら同じ列（乱数・時刻・レア度・能力値・課金を見ない）。版 `v: 1`。並びはこの順で、条件の無いものは飛ばす（6〜8個）：
| 順 | `kind` | `id` | 条件 | `need` | 数えるもの |
|---|---|---|---|---|---|
| 1 | `first_win` | `first_win` | いつも | 1 | 戦績の `wins` |
| 2 | `races` | `races:10` | いつも | 10 | 戦績の `races` |
| 3 | `surface_win` | `surface_win:{surface}` | いつも。`surface` は馬の芝ダ（`both` は距離の範囲に入るコースが多い方、同数なら芝） | 3 | その馬場での勝ち（`goal.surfaceWins`） |
| 4 | `ta_course` | `ta_course:{trackId}` | 走れるコース（芝ダが合う）がある。距離の外れが小さい順 → 範囲の真ん中に近い順 → コースID順の先頭 | 1 | そのコースの検証済みタイムアタックの記録（`bestTa[trackId]`）がある |
| 5 | `stretch_win` | `stretch_win:{band}` | 距離の帯（§44.3 と同じ：`sprint`〜1400m・`mile`1401〜1800m・`intermediate`1801〜2400m・`long`2401m〜）のうち、馬の距離の範囲と重ならず、馬が走れる馬場のコースがある帯。逃げ・先行は短い側の近い帯から、差し・追込は長い側の近い帯から。その側に無ければ反対側。どちらにも無ければこの目標は無い | 1 | その帯の距離のレースでの勝ち（`goal.bandWins`） |
| 6 | `wins` | `wins:5` | 固有スキルを持つ馬だけ | 5 | 戦績の `wins` |
| 7 | `ranked_top3` | `ranked_top3:5` | いつも | 5 | ランク戦の3着以内（`goal.rankedPlaces`） |
| 8 | `tournament_win` | `tournament_win` | いつも | 1 | 戦績の `tournamentWins` |

文言（サーバー・C# が同じものを作る。英語は §23 の境界で訳す。馬の名前は文言に入れない）：
`初勝利をあげる`／`{n}戦を走る`／`芝で{n}勝する`・`ダートで{n}勝する`／`タイムアタック {course} で記録を残す`／`短距離（1400m以下）で勝つ`・`マイル（1401〜1800m）で勝つ`・`中距離（1801〜2400m）で勝つ`・`長距離（2401m以上）で勝つ`／`{n}勝する`／`ランク戦で3着以内に{n}回入る`／`大会で優勝する`。
サーバー（TS）とクライアント（C#）は共有ベクター `contracts/horse-goals.vectors.json` で同じ列・文言・進み具合になることを確かめる。

### 53.2 進み具合（REQ-HGOAL-003〜005）
- 数えるのは **§34.1 の戦績と同じレースだけ**（`noteHallRace`：ランク戦・イベント・大会、人間2人以上のフレンド戦。レースIDごとに1回のガードの中。無効・チュートリアル・週替わりチャレンジ・プレイヤー主催カップ・馬IDの無い結果は数えない）。新しく数えるもの（`career.goal`：`surfaceWins`・`bandWins`・`rankedPlaces`）も `noteHallRace` の同じ場所で書く。コースの芝ダ・距離はレースの `details.trackId` から master で引く（無い結果は芝ダ・帯の勝ちに数えない）。タイムアタックは `noteHallTa`、大会は `noteHallTournament`（どちらも §34 のガードのまま）。
- **ミッションとは別に数える**：目標はミッション・パス・コインに何も足さず、ミッションの進みは目標に入らない（同じレースが両方に1回ずつ数えられるだけで、報酬が2回出ることは無い。目標の報酬は見た目だけ）。
- `have = min(数えた値, need)`、`done` は達成の記録（`completedAt`）があるか `have ≥ need`。列のどの目標からでも達成できる（順番は物語の並び）。`current` は並びで最初のまだの目標（全部終われば無し）。
- `races`・`wins`・タイムアタック・大会は §34 の戦績の公開から、`surfaceWins`・`bandWins`・`rankedPlaces` はこの機能の公開から数える（さかのぼらない）。
- **達成の記録**：数える場所（レース・タイムアタック・大会）のすぐ後に、その馬の列を見て新しく満たした目標に `completedAt` を書き、KPI `hgoal_complete` を1回送る。同じ目標は2回記録しない。読むだけの画面（GET）は書かない（記録が無くても `have ≥ need` なら `done` で見せる）。
- **引退した馬**：達成した目標と列はそのまま見られる（戦績は引退で消えない）。引退した馬はもう走らないので進まない。
- 列の全部を達成すると **`chainComplete: true`**（`chainCompletedAt`）：馬の詳細・戦績（`GET /v1/horses/:horseId/career` の `goals`）・殿堂の銘板（`goalsComplete: true`、友達が見る写しにも出る）に印（リボン）が付く。印は見た目だけで、能力・レース・報酬に何も影響しない。

### 53.3 API（要認証）
| メソッド | パス | 本文 → 応答 |
|---|---|---|
| GET | `/v1/horses/:horseId/goals` | → `HorseGoalsView`（持っていない馬は `404 HORSE_NOT_FOUND`、機能が無効なら `404 NOT_FOUND`） |
| PUT | `/v1/horse-goals/pin` | `{ "horseId": string \| null }` → `{ "pinned": HorseGoalPin \| null }` |
| GET | `/v1/horse-goals/pinned` | → `{ "pinned": HorseGoalPin \| null }` |
```json
{ "v": 1, "horseId": "h7", "horseName": "ミドリノカゼ", "status": "active", "pinned": true,
  "goals": [ { "id": "first_win", "kind": "first_win", "params": {}, "text": "初勝利をあげる", "have": 1, "need": 1, "done": true, "completedAt": 1794000000000, "current": false },
             { "id": "races:10", "kind": "races", "params": { "n": 10 }, "text": "10戦を走る", "have": 7, "need": 10, "done": false, "completedAt": null, "current": true }, "…" ],
  "doneCount": 1, "total": 7, "chainComplete": false, "chainCompletedAt": null,
  "notice": "目標は確定したレースの成績だけで進みます。達成の印は見た目だけです。" }
```
- `HorseGoalPin` = `{ horseId, horseName, goal: <current の目標>, doneCount, total }`。
- **ピン留め**（REQ-HGOAL-007）：1頭だけホームに出せる。置き換えるだけなので冪等（キー不要）。`null` で外す。持っていない馬は `404 HORSE_NOT_FOUND`。引退した馬・列を全部達成した馬は `409 NOT_ELIGIBLE`。ピン留めした馬が後で引退・全部達成・手元から消えた時は、読む時に `pinned: null` とみなす（KPI は送らない。新しくピン留めすれば置き換わる）。
- ブートストラップ・`GET /v1/player` の `horseGoalPin` にも同じ形（ホームの最初の描画用）。

### 53.4 ホームとの関係（§45、REQ-HGOAL-008）
- ホームに**ピン留めした目標**（馬の名前・目標の文言・`have/need`）を小さく出す。押すとその馬の詳細の目標の面へ。
- 次にやること（§45）に種類 **`horse_goal_near`** を足す（データの `progression.nextActions.rules` に書く。`threshold` = 残り 1..10）：ピン留めした馬の `current` の目標が、`have ≥ 1` かつ残り（`need − have`）が `threshold` 以下の時。`count` = 残り、`refId` = 馬ID、開く画面は `horse_goals`（コードで固定）。解放の条件なし、期限なし（`deadlineAt: null`）。ショップ・購入には一切つながらない。

### 53.5 KPI（REQ-HGOAL-012）
- `hgoal_view`（クライアント、`props: { surface: "detail" | "home", done: 0..8 }`。目標の面を開いた／ホームのピンを見た時。ホームは1ゲーム日に1回）→ `s1` = surface、`value` = done。
- `hgoal_complete`（サーバー、目標を達成した時に1回）→ `s1` = goal kind、`s2` = `chain`（列の最後の1つで全部達成した時）| 空、`count` = 達成した数。
- `hgoal_pin`（サーバー、ピン留めが変わった時だけ）→ `s1` = `pin` | `unpin`、`s2` = current の goal kind | 空。

### 53.6 文言・法務（REQ-HGOAL-013/014）
- すべての文言に英語がある（`server-en.json`・`ui-en.json`・`proto-en.json`、`l10n:missing` 0）。馬の名前はプレイヤーが付けたもの（英語でも訳さない）。
- 賭けを思わせる言葉（`server/src/domain/bettingWords.ts` の共通の一覧）を目標の文言に使わない（テストで全部の文言を確かめる）。「倍」「今だけ」「残りわずか」などの煽り・期限・カウントダウンは無い。
- コンプガチャではない：目標は確定したレースの成績で進み、ランダムな品の収集を条件にしない。報酬は見た目だけで、購入で近道できない。

### 53.7 クライアント（REQ-HGOAL-010/011）
- `Muchi.Client` `ApiClient.GetHorseGoalsAsync(horseId)`・`PinHorseGoalAsync(horseId | null)`・`GetPinnedHorseGoalAsync()`、`HorseGoalsView`・`HorseGoalPin`、`HorseGoalChain.Build(horse, tracks)`・`HorseGoalChain.Evaluate(chain, record)`（サーバーと同じ、共有ベクター）、`AnalyticsEvent.HorseGoalView`。`NextKinds` に `horse_goal_near`。
- Unity のゲーム層 `HorseGoalsModel`：馬の詳細の目標の面（列の行・進み・今の目標・達成の印・ピン留め）、ホームのピン、文言（日本語＋英語）、KPI の1日1回。描画は `docs/handoff-codex-round18-horse-goals.md`。

### 53.8 設定 `progression.horseGoals`
`{ enabled: bool }`。`enabled: true` は `progression.hall` が有効な時だけ（戦績が無いと数えられない）。目標の数・`need` はコードの版 `v: 1` で決まり（共有ベクターと同じ）、設定では変えない。

### 53.9 アカウント削除
状態の `horseGoals`（達成の記録・ピン）と戦績の `goal` は最後の `wipe` で消える。殿堂の写し（§34.5）は既存の手順で消える。他の場所に写しは無い。

## 54. 引き継ぎコード（ID＋パスワード、REQ-TRF-001〜020、`server/src/domain/transferCode.ts`・`transferService.ts`・`server/src/http/customToken.ts`、C# `TransferCode.cs`（`TransferCodeRules`）・`Muchi.Game.TransferCodeModel`、docs/handoff-codex-round19-transfer-code.md）
Apple／Google の連携（REQ-API-005）に加えて、日本のゲームでおなじみの **ID＋パスワード** で機種変更できるようにする。古い端末の設定で引き継ぎコードを発行し、新しい端末でIDとパスワードを入れると、サーバーが確かめて **元のアカウント（同じ uid）の Firebase カスタムトークン** を返す。新しい端末はそのトークンで Firebase にサインインし、元のアカウントとして遊ぶ。**コインもアイテムも動かさない**（E番号なし）：アカウントそのもの（uid）が新しい端末に移るので、有償コイン・購入記録・ストアのレシートの紐付けは uid のまま変わらない（資金決済法：有償コインは失われない）。

**決まりごと**
- コードは **1回だけ**使える。使ったら消える（次の機種変更には新しく発行する）。発行し直すと前のコードは使えなくなる。**有効期限**は `expiryDays`（既定30日、1〜90）。
- パスワードは**サーバーに保存しない**。保存するのは PBKDF2-HMAC-SHA256（WebCrypto、反復 100,000 回＝Workers の上限、記録ごとに16バイトのソルト、32バイト）の結果だけ。反復回数とアルゴリズムは記録ごとに持つ（後で上げられる）。比較は定数時間。
- **どの口でも ID が有るか無いかを教えない**（オラクルを作らない）：知らない ID・違うパスワード・ロック中のコード・使用済み・取り消し済みは**同じ** `TRANSFER_INVALID`。知らない ID でも同じ計算（ダミーの PBKDF2）をして時間でも区別できないようにする。期限切れはパスワードが合っていた時だけ `TRANSFER_EXPIRED` と言う。
- **回数の制限**：コードごと（`maxAttemptsPerCode` 回で `codeLockMinutes` 分ロック。ロックは外からは `TRANSFER_INVALID` と同じに見える）、IP ごと・端末ごと（失敗が1時間に `ipFailuresPerHour`／`deviceFailuresPerHour` 回で `limitLockMinutes` 分、`429 TRANSFER_LOCKED`。こちらはコードに関係しないのでオラクルにならない）。IP（`cf-connecting-ip`）と端末（インストール ID `x-install-id`、無ければ要求したアカウント）は SHA-256 にしてから数える。
- **ID とパスワードはログ・KPI・監査に残さない**。監査はコードの参照（ID の SHA-256 の先頭8桁）と、IP・端末のハッシュの先頭8桁だけ。
- 新しい端末に移った後、**古い端末のセッションは次の要求で無効**になる（§54.6）。
- 認証やアカウント削除と同じく、**メンテナンスの窓でも古いアプリからでも止めない**（§46 の `EXEMPT_ROUTES`。決めたこと：機種変更の途中で閉じ込めない。経済に触れない）。止めたい時は運用がリモート設定の `progression.transfer.enabled` を false にする。

### 54.1 コードの形（REQ-TRF-002/003）
- **ID**：9文字、`23456789ABCDEFGHJKMNPQRSTUVWXYZ`（0・1・O・I・L を使わない31文字）。表示は `ABC-DEF-GHJ`。1文字目がディレクトリのシャード（文字の位置 mod 16 ＝ プレイヤーのシャード）。
- **入力の正規化**（ID・パスワードとも、発行と入力で同じ）：NFKC（全角→半角）、空白とハイフン（`-`・`ー`・`－` は NFKC 後の `-`）を取り除く。ID は大文字にする。
- **自分で決めるパスワード**（`mode: "custom"`）の決まり（どれか1つでも破れば `400 TRANSFER_PASSWORD_WEAK`、`details.rules` に破った規則の id）：

| id | 規則 | 画面の文（English） |
|---|---|---|
| `length` | 正規化した後で `passwordMin`〜`passwordMax` 文字（既定 8〜32） | 8〜32文字（8–32 characters） |
| `charset` | 半角の英字・数字・記号だけ（`!`〜`~`、空白なし） | 半角の英数字と記号（Letters, numbers and symbols） |
| `mix` | 英字と数字を両方ふくむ | 英字と数字を両方使う（Use both letters and numbers） |
| `common` | よくあるパスワード（`password1`・`qwerty123`・`abcd1234` など、`COMMON_PASSWORDS`）でない（大文字小文字を区別しない） | よく使われるパスワードは使えません（No common passwords） |

- **サーバーが作るパスワード**（`mode: "generated"`）：12文字、`23456789abcdefghjkmnpqrstuvwxyz`。表示は `abcd-efgh-jkmn`。**発行の応答で1回だけ**返す（もう一度見る口は無い。忘れたら発行し直す）。

### 54.2 `GET /v1/transfer/code`（要認証、読むだけ）
```json
{ "enabled": true,
  "code": { "codeId": "K7M-Q3X-PHR", "mode": "custom", "issuedAt": 1794279600000, "expiresAt": 1796871600000, "expired": false },
  "lastTransferredAt": null,
  "issuesToday": 1, "issuesPerDay": 5,
  "rules": [ { "id": "length", "text": "8〜32文字" }, { "id": "charset", "text": "半角の英数字と記号" }, { "id": "mix", "text": "英字と数字を両方使う" }, { "id": "common", "text": "よく使われるパスワードは使えません" } ],
  "passwordMin": 8, "passwordMax": 32, "expiryDays": 30 }
```
- `code` は今使えるコード（無ければ null）。ID は秘密ではないので全部見せる。パスワードは返さない。
- `enabled: false`（設定で切った、またはカスタムトークンの鍵が無い）なら発行・入力の画面は出さない（Apple／Google だけ）。

### 54.3 `POST /v1/transfer/code`（要認証）・`DELETE /v1/transfer/code`
- 本文 `{ "mode": "custom", "password": "…" }` または `{ "mode": "generated" }`。
- 応答 `{ "codeId": "K7M-Q3X-PHR", "mode": "generated", "password": "abcd-efgh-jkmn", "issuedAt": …, "expiresAt": … }`（`password` は `generated` の時だけ。`custom` は返さない）。
- 前のコードは取り消される。発行はゲーム日（§DAY、04:00 JST 区切り）ごとに `issuesPerDay`（既定5）回まで → 超えたら `429 TRANSFER_ISSUE_LIMIT`。BAN 中は `403 BANNED`、削除の予約中は `409 DELETION_PENDING`。
- `DELETE` は今のコードを取り消す（`{ "revoked": true | false }`、何度送っても同じ）。

### 54.4 `POST /v1/transfer/redeem`（要認証＝新しい端末の匿名アカウント）
本文 `{ "codeId": "K7M-Q3X-PHR", "password": "…", "confirmDiscard": false, "installId": "…"? }`。順番：
1. `progression.transfer.enabled` とカスタムトークンの鍵（§54.7）が無ければ `404 NOT_FOUND`。
2. **この端末のデータの確認**：要求したアカウントに進行（馬・購入の記録・コイン（有償・無償）・レース・プレゼントボックスの中身のどれか）があり、`confirmDiscard` が true でなければ `409 TRANSFER_CONFIRM_REQUIRED`、`details: { paidCoins, freeCoins, horses, races, purchases }`（確認画面に出す：「この端末のデータ（馬3頭・有償コイン120枚）は引き継ぎ後に使えなくなります」。Apple／Google でアカウントを切り替える時と同じ扱い）。
3. IP・端末がロック中 → `429 TRANSFER_LOCKED`（`details.retryAfterSec`、`Retry-After`）。
4. コードを引き、パスワードを確かめる。合わない・無い → `400 TRANSFER_INVALID`（IP と端末の失敗に数える）。期限切れでパスワードが合った → `410 TRANSFER_EXPIRED`。
5. 自分のコードを自分の端末で入れた → `409 TRANSFER_SAME_ACCOUNT`。
6. 元のアカウントの検査（PlayerDO の1トランザクション）：BAN 中 → `403 TRANSFER_REFUSED`（`details.reason: "banned"`）、削除の予約中・手続き中 → `403 TRANSFER_REFUSED`（`"deletion_pending"`。元の端末で削除を取り消すか、お問い合わせへ）、コードがもう違う（取り消し・発行し直し・同時の入力の2回目）→ `TRANSFER_INVALID`。通れば**コードを消費**し、`cutoffAt`（§54.6）を今にする。
7. 応答 `{ "customToken": "<JWT>", "expiresInSec": 3600, "displayName": "ハヤテ" }`。新しい端末は `signInWithCustomToken` する（Unity：`FirebaseAuthTokenProvider.SignInWithCustomTokenAsync`）。

- 鍵の署名（ネットワークを使わない）はコードを消費する**前**に行う：署名できなければ何も消費しない。
- **応答が届かなかった時の再送**：`Idempotency-Key`（任意、1〜128文字）を付けると、同じアカウントから同じキーで1時間以内に送り直した要求には、同じ元のアカウントのカスタムトークンを**署名し直して**返す（コードはもう使われているが `TRANSFER_INVALID` にしない。トークンそのものは保存しない。記録は要求したアカウントの `transfer.redeemedAs`）。違うキー・違うアカウントからは `TRANSFER_INVALID`。クライアントはサインインが終わるまで同じキーを使う。
- 同じコードを2台で同時に入れても、消費できるのは PlayerDO の直列化で1回だけ。

### 54.5 保存
- **プレイヤーの状態** `transfer`（新しいトップレベルのキー）：`{ code: { id, mode, issuedAt, expiresAt } | null, issues: { day, count }, cutoffAt: number | null, lastRedeemedAt: number | null, history: [{ at, event: "issued" | "revoked" | "redeemed" | "ops_revoked", mode? }]（新しい20件）, redeemedAs?: { key, playerId, displayName, at } }`（`redeemedAs` は**入力した側**＝新しい端末のアカウントにだけ、再送のための記録、1時間）。パスワードもハッシュもトークンも持たない。
- **ディレクトリ**（`DirectoryDO` のシャード、ID の1文字目＝プレイヤーのシャード。wrangler の移行は不要：既存の SQLite に表を足すだけ）：
  - `transfer_codes`：`code_id`・`player_id`・`salt`・`hash`・`kdf`（`pbkdf2-sha256`）・`iterations`・`issued_at`・`expires_at`・`attempts`・`locked_until`。消費・取り消しで行を消す。期限切れから7日で消す。
  - `transfer_limits`：`key`（`ip:<hash>`／`dev:<hash>`、ハッシュの先頭でシャード）・`window_start`・`failures`・`locked_until`。
  - `transfer_audit`：`player_id`・`at`・`event`（`issued`・`revoked`・`ops_revoked`・`redeemed`・`failed`・`locked`・`expired`・`refused`）・`code_ref`・`ip_ref`・`dev_ref`。プレイヤーごとに新しい100件、180日で消す。
- **アカウント削除**（§UXS-040）：状態と一緒に `transfer` が消え、ディレクトリの `forget` がそのプレイヤーのコード・監査の行を消す。

### 54.6 古い端末の無効化（REQ-TRF-010）
- Worker は ID トークンの `auth_time`（Firebase にサインインした時刻）を読み、そのアカウントの `cutoffAt` より前（時計のずれ30秒を見込む）なら **`401 SESSION_REPLACED`**（「この端末のデータは別の端末に引き継がれました」）を返す。全てのプレイヤーの口（`auth: player`）で、メンテナンスの検査の後・ルートの前に1回。
- `cutoffAt` は PlayerDO から読み、Worker の isolate ごとに30秒持つ（引き継いだ isolate はすぐ覚える）。引き継ぎの無いアカウントは `null` を持つ。
- クライアントは `SESSION_REPLACED` を再試行しない（トークンを取り直しても同じ）。Firebase からサインアウトして「別の端末に引き継がれました」の画面を出す。そこから新しく始めるか、引き継ぎコードを入れる。

- Round 19 統合：503／426 と同じ `ApiClient` の1か所（`Send`）で判定し、`ApiClient.SessionReplaced` を出す。Unity では `MaintenanceModel` が受けて全画面の案内（`MaintenanceScreen.SessionReplaced`）にし、メンテナンス・強制アップデート・オフライン・再読み込みはそれを置き換えない。

### 54.7 カスタムトークンの鍵（REQ-TRF-011、docs/ops/deploy.md §9.6）
- Worker のシークレット **`FIREBASE_AUTH_SERVICE_ACCOUNT_JSON`**（Firebase プロジェクトのサービスアカウントの JSON 鍵）。リポジトリに鍵を置かない。無ければ引き継ぎコードは `enabled: false`（Apple／Google の連携だけ）。
- JWT：RS256、`iss` = `sub` = サービスアカウントのメール、`aud` = `https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit`、`iat`、`exp` = `iat` + 3600、`uid` = 元のアカウント。追加のクレームは入れない。
- 鍵の入れ替え：新しい鍵を作る → `wrangler secret put` → 確認 → 古い鍵を Google Cloud で削除する（手順は docs/ops/deploy.md §9.6。90日ごと・漏れた疑いがあればすぐ）。

### 54.8 運用（REQ-TRF-013、`/v1/admin/players/:playerId/transfer*`）
| メソッド・パス | 役割 | 内容 |
|---|---|---|
| `GET /v1/admin/players/:playerId/transfer` | viewer | 今のコード（ID・発行日時・期限・種類）、`cutoffAt`、状態の履歴、ディレクトリの監査（新しい100件） |
| `POST /v1/admin/players/:playerId/transfer/revoke` | operator | `{ reason }`。今のコードを取り消す（盗まれた・本人からの依頼）。監査ログ `player.transfer.revoke` |

### 54.9 KPI（REQ-TRF-014）
| イベント | 送り手 | s1 | s2 |
|---|---|---|---|
| `transfer_issue` | サーバー（発行した人） | `custom` / `generated` | |
| `transfer_redeem` | サーバー（成功＝移ったアカウント、失敗＝要求したアカウント） | `ok` / `fail` | 失敗の分類：`invalid`・`expired`・`locked`・`refused_banned`・`refused_deletion`・`same_account` |
ID・パスワード・IP は入れない。クエリは `docs/ops/kpi-queries.md`「引き継ぎコード」。

### 54.10 クライアント
- `Muchi.Client`：`TransferCodeStatus`・`IssuedTransferCode`・`TransferRedeemResult`・`TransferConfirm`、`ApiClient.GetTransferCodeAsync`・`IssueTransferCodeAsync`・`RevokeTransferCodeAsync`・`RedeemTransferCodeAsync`、`TransferCodeRules`（正規化・表示の形・パスワードの規則をサーバーと同じに）、`ApiErrorCode.SessionReplaced` と `ApiClient.SessionReplaced` イベント（再試行しない）。
- `Muchi.Game`：`TransferCodeModel`（発行の画面：ID・規則のチェック表示・コピー・作ったパスワードは1回だけ；入力の画面：ID とパスワード・確認の画面・ロック・期限切れ・成功で `FirebaseAuthTokenProvider.SignInWithCustomTokenAsync`）。`IFirebaseAuthBackend` はそのまま、カスタムトークンは別のインターフェース `ICustomTokenAuthBackend`（`MUCHI_FIREBASE` の時の `FirebaseSdkAuthBackend` が実装）。
- 画面が守ること：docs/handoff-codex-round19-transfer-code.md。

## 55. 観戦中の応援（spectator cheering、REQ-CHEER-001〜016、`server/src/domain/cheer.ts`・`server/src/do/raceRoom.ts`、C# `Muchi.Net.CheerWire`（`CheerOffer`・`CheerCount`）・`LockstepClient.SendCheer`/`CheersReceived`・`Muchi.Client.Cheer`（`CheerKinds`・`CheerThrottle`・`CheerIndicator`・`CheerBurst`・`CheerRaceTally`・`CheerMoment`）・`Muchi.Game.CheerModel`）
観戦者（§8.4）が、レース中に決まった応援（「いけ！」「差せ！」「粘れ！」）を**馬番を選んで**送れる。観戦者には応援の盛り上がり（その1秒の集計）が、選手には自分の馬への応援の数（「応援 ×12」）が、邪魔にならない形で出る。**レースには一切影響しない**：応援はロックステップの入力の流れ（§4 の `in`・`b`）の外を通り、入力・リプレイログ（§7）・チェックサム（§5）・結果ハッシュ（§6）に入らない。部屋の中でも応援は `RaceRoomCore`（入力と結果の芯）に渡らない。**何も配らない・何も売らない**（E番号なし。有料の応援・投げ銭・ギフトは作らない、docs/planning/03）。自由な文字は送れない（決まった3種類だけ）。新しい HTTP の口は無い（観戦チケット `POST /v1/race/:raceId/spectate` は §8.4 のまま、§46 の口の組もそのまま `ranked`（`/v1/race`・`/v1/races` の接頭辞。WebSocket の `GET /v1/race/:raceId/ws` はレース中に止めない口のまま））。

### 55.1 応援の種類（REQ-CHEER-002、`CHEER_KINDS`・`CHEER_TEXT`）
| `kind` | 日本語 | English |
|---|---|---|
| `go` | いけ！ | Go! |
| `close` | 差せ！ | Close in! |
| `hold` | 粘れ！ | Hang on! |

- 並びはボタンの並び。文は共有の賭けの言葉の一覧（`domain/bettingWords.ts`）に当たらない（`cheerTextProblems`、テスト）。クライアントの文（`CheerKinds.Label*`）と `ui-en.json` は同じ表（テストで照合）。

### 55.2 どのレースで・誰が（REQ-CHEER-001/003/006）
- 観戦できるレースすべて：フレンド部屋・主催カップ（`cup`）・ランク戦・イベント・大会のヒート（ランク戦の観戦は Round 7 からあるので含める。チュートリアル・タイムアタックは観戦が無いので無し）。環境変数 `CHEERS = "off"` で全部止まる（部屋が応援を案内しなくなり、`cheer` は `err` `CHEER_OFF`）。
- 部屋は観戦者の `start` の `spectator` に `cheer` を足して案内する：`"spectator":{"delayMs":0,"cheer":{"kinds":["go","close","hold"],"minIntervalMs":2000,"windowMs":1000}}`。**`cheer` が無い部屋（古いサーバー・止めてある）には、クライアントは `cheer` を送らない**（古い部屋のスキーマは厳格で、知らない `t` は `BAD_MESSAGE` になるため）。選手の `start` は変わらない。
- 送れるのは観戦の接続だけ（チケットの slot = -1）。選手の接続からの `cheer` は `err` `NOT_SPECTATOR`（芯は何も記録しない）。

### 55.3 メッセージ（§4 の後方互換な拡張）
| 向き | 形 | 意味 |
|---|---|---|
| 観戦者 → 部屋 | `{"t":"cheer","slot":3,"kind":"go"}` | 応援1回。`slot` は出走馬の枠（0〜出走数−1、画面の馬番は slot+1）、`kind` は §55.1 のどれか。ほかのフィールドは付けられない（厳格、自由な文字なし） |
| 部屋 → 観戦者・選手 | `{"t":"cheers","n":[[1,"hold",1],[3,"go",2],[3,"close",1]]}` | 1つの窓（1秒）の集計。`[slot, kind, 数]` を slot → kind の並びの順。**送った人の id は無い**。窓に見せるものが無い接続には送らない |

- 断る時は `err`：`CHEER_OFF`（止めてある・観戦できないモード）、`NOT_SPECTATOR`、`CHEER_NOT_LIVE`（その観戦者にまだレースが始まっていない・`final` を受け取った後）、`CHEER_RATE_LIMITED`（2秒に1回より速い）、`CHEER_UNAVAILABLE`（ブロックの一覧が読めない）、`BAD_MESSAGE`（形違い・出走数を超える枠）。**どれも切断しない・致命的でない**（`RaceSession.FatalRoomErrors` に入れない。テストで確認）。

### 55.4 間隔と窓（REQ-CHEER-004/005、帯域の上限）
- 観戦者ごとに **2秒に1回**（`CHEER_MIN_INTERVAL_MS`）。最後に受け付けた時刻は観戦の接続の attachment（`spec.lc`）に持ち、休止（hibernation）をまたいでも効く。部屋のメモリにもプレイヤーごとに持つので、つなぎ直しても間隔は戻らない。時計が戻った時は止めない。間隔は `await` の前に取るので、同時に来た2つが両方通ることはない。クライアントは `CheerThrottle` で同じ間隔だけボタンを灰色にする（押して断られることがない）。
- 部屋は受け付けた応援を **1秒の窓**（`CHEER_WINDOW_MS`）にためて、窓が閉じたら各接続に**多くて1通**の `cheers` を送る（部屋のアラームで閉じる。ほかに用が無くても窓を閉じる時刻にアラームを置く）。受け取るのは：まだ見ている観戦者（`final` 前・tick を1つ以上受け取った）と、レースが `running` の間の選手。
- 1通の大きさは最大で 出走数 × 3 行（12頭で36行）。観戦者の上限は 200（§8.4）なので、1部屋の応援は多くて毎秒100回、送るのは1接続毎秒1通まで。ブロックが無ければ全員に同じ文字列を1回だけ作る。
- 窓はメモリだけ（追い出されたら、その窓は出ないだけ）。応援はタイミングを競わないので遅れても困らない。ランク戦・イベント・大会は観戦が10秒遅れなので、観戦者の応援は10秒前の場面への応援として選手に届く（未来の情報は含まない）。

### 55.5 ブロック（REQ-CHEER-008、§47 の1つのブロックの一覧）
- 部屋は観戦者の `hello` の時に、その人のブロックの一覧（支部フィードのミュート＝`feedMutes`）を読む（選手は席の準備を遅らせないよう待たずに読む）。
- 窓を送る時、受け取る人 R ごとに、R がブロックした人と R をブロックした人からの応援を数えない（両向き）。一覧がまだ読めていない R には何も送らない（安全側）。送った人の一覧が分からない応援は隠す。自分の応援は自分には必ず見える。
- Round 19 統合：部屋の一覧の写しは `CHEER_BLOCK_REFRESH_MS`（10秒）より古ければ窓を送る時に読み直す（裏で読み、届くまでは前の写し。読み直しに失敗したら前の写しのまま）。ブロックの画面・通報の「ブロックもする」・ライバルのブロックはどれも同じ PlayerDO の一覧に書くので、レースの途中のブロックも10秒ほどで効く（Round 18 の定型チャットの写しの更新と同じ考え）。集計しか届かないので、誰が応援したかはそもそも分からない。

### 55.6 リプレイの「応援の多かった瞬間」（REQ-CHEER-011/012）
- 部屋はレースごとに応援の**数だけ**を数える：送った人が見ていた tick（`spec.sent`）を 40 tick（20Hz で2秒、`CHEER_BUCKET_TICKS`）ごとの区切りに入れる。送った人の id・誰がどの馬に、は残さない。部屋のストレージの別のキー `cheer` に置き、芯のスナップショット（`core`）には入れない。
- 応援があったレースは、最後の観戦者が見終わり結果が出た後に1回だけ、R2 の `replays/<raceId>.cheers.json` に書く：`{"v":1,"bucketTicks":40,"total":18,"buckets":[[10,5],[20,4]]}`（数百バイト）。リプレイのログ（`replays/<raceId>.json`）とは別のファイルで、同じ接頭辞なので保存期間（REQ-OPS-001）と一緒に消える。
- マイリプレイ（§37）：保存する時にこのファイルがあれば写しの中（`SavedReplayFile.cheers`）に入れ、`GET /v1/replays/:raceId`・フレンドの公開リプレイの応答に `cheerMoments` を付ける：`[{"tick":400,"count":5}]`。応援が3回以上の区切りのうち多い順に最大3つ（同数は早い方）を、レースの順に並べる。無い時は `[]`。古いクライアントは知らないフィールドを無視する。リプレイのログ・結果ハッシュは変わらない。

### 55.7 KPI（REQ-CHEER-013、クライアントのイベント）
- `cheer_send`：`props {mode, count}` — そのレースで送った応援の数。**1レースに1行**（押すたびには送らない）。
- `cheer_seen`：`props {mode, role, count}` — そのレースで画面に出た応援の数。`role` = `racer`（表示オンの選手だけ。オフの選手は行が無い）/ `spectator`。
- `mode` は `friend` / `cup` / `ranked` / `event` / `tournament`。馬・相手・送った人の id は入れない。クエリは docs/ops/kpi-queries.md。

### 55.8 表示（REQ-CHEER-007/010、docs/planning/06、docs/handoff-codex-round19-spectator-cheer.md）
- 観戦画面：馬番のチップ（1つ選ぶ）と3つのボタン。2秒の間は灰色。下に「応援は2秒に1回まで」「応援はレースの結果に影響しません」。窓が届いたら、多い順に最大3行の小さなバースト（「3番 粘れ！ ×9」）を2.5秒。
- 選手：自分の馬への応援があった時だけ、操作の邪魔にならない隅に「応援 ×12」（レース中の合計）を4秒。設定「レース中の応援表示」（既定オン、端末に保存、レース中でもすぐ効く）でオフにできる。オフの間は出さない（数は数えておくので、オンに戻すと合計が出る）。
- 動きを減らす（§41）がオンなら、文字だけで光・脈打ちは無し。光は `FlashLimiter`（1秒に3回まで）を通す。
- 英語・文字の大きさ（特大）ではみ出さない（プロトタイプの `test/en-flow.cjs`・`test/a11y-flow.cjs`）。

### 55.9 クライアント
- `Muchi.Net`：`LockstepClient.CheerOffer`（`start.spectator.cheer`、無ければ null）・`CanCheer`・`SendCheer(slot, kind)`（案内された種類・枠の範囲・観戦者・`final` 前のときだけ送る）・`CheersReceived`（`cheers` の窓。`Sim`・確定入力・チェックサムには触れない）。
- `Muchi.Client`：`CheerKinds`（文・モード名）、`CheerThrottle`、`CheerIndicator`（選手）、`CheerBurst`（観戦者）、`CheerRaceTally`（KPI を1レース1回）、`CheerMoment`（`ReplayData.CheerMoments`）、`AnalyticsEvent.CheerSend`・`CheerSeen`。
- `Muchi.Game`：`CheerModel`（チップ・ボタン・間隔・トースト・バースト・選手の表示と設定・動きを減らす・`Finish` で KPI・`MomentMarkers`）。

### 55.10 ヘルプ（§48）
- 記事 `spectator_cheer`（カテゴリ `races`）：応援の送り方・無料で何ももらえないこと・間隔（トークン `cheer_interval_sec`）・自由な文字なし・匿名・ブロック・選手の表示のオフ・動きを減らす。設定画面へのリンク。

## 56. 画質・省電力・通信量の設定（REQ-PERF-001〜018、C# `PerformanceSettings.cs`（`PerformanceSettings`・`DeviceClassifier`・`RenderProfile`・`AssetDownloadPolicy`・`AssetStorage`）・`Muchi.Game.PerformanceSettingsModel`／`StorageModel`、§16 のアセット配信に追加、docs/handoff-codex-round19-performance-settings.md）
端末ごとの「見た目の重さ」と「通信量・容量」の設定。**端末にだけ保存し、アカウントには保存しない**（§56.6）。**どの設定もレースの計算・ルールセット・検証・結果ハッシュ・リプレイを変えない**：エンジンは 20Hz の固定ステップで時計に合わせて進み、設定が変えるのは描画（1秒に何枚描くか・どの細かさで描くか）とダウンロードだけ（§56.5）。アクセシビリティの「動きを減らす」（§41.6）とは別の設定で、両方オンにできる（効果は重なるだけで打ち消し合わない）。

### 56.1 設定と既定値（REQ-PERF-001）
| キー | 値（線の値） | 既定 | 効くところ |
|---|---|---|---|
| `graphics` | `auto` \| `low` \| `medium` \| `high` | `auto` | 画質の段（§56.3）。`auto` は端末の区分（§56.2）で決まる |
| `frameRate` | `auto` \| `30` \| `60` | `auto` | 1秒に描く枚数の上限。`auto` は区分 `low` で 30、それ以外 60（画面の最大リフレッシュレートが 60 未満なら 30） |
| `batterySaver` | `true` \| `false` | `false` | 省電力：**レースの外**は 30fps、演出を減らす（§56.3）。レース中の fps は `frameRate` のまま（操作の手触りを落とさない） |
| `dataSaver` | `true` \| `false` | `false` | データセーバー：必須でないアセットは Wi-Fi のときだけ取得し、軽量版があれば軽量版を使う（§56.4） |

- 端末の「省電力モード」（iOS の低電力モード・Android のバッテリーセーバー）が入っている間は、`batterySaver` がオフでもオンと同じに扱う（設定の値は変えない。画面には「端末の省電力モード中」と出す）。
- 知らない値・壊れた保存値は既定値に戻す（`PerformanceSettings.Parse`）。

### 56.2 端末の区分（REQ-PERF-002、`DeviceClassifier`）
起動時に1回、端末の情報（`DeviceProfile`：メモリ MB・CPU コア数・GPU メモリ MB（不明は 0）・ソフトウェア描画か・最大リフレッシュレート）から `low` / `mid` / `high` を決める。Unity では `IDeviceInfo` を `SystemInfo`・`Screen.currentResolution.refreshRateRatio`・OS の省電力の通知で実装する（docs/handoff-codex-round19-performance-settings.md）。
| 区分 | 条件（上から順に） |
|---|---|
| `low` | ソフトウェア描画、またはメモリ < 3000MB、または CPU < 4 コア、または GPU メモリが分かっていて < 512MB |
| `high` | メモリ ≥ 6000MB かつ CPU ≥ 6 コア かつ（GPU メモリが不明、または ≥ 2048MB） |
| `mid` | それ以外 |
- 区分は表示の既定値を選ぶためだけに使い、マッチング・レーティング・報酬には使わない。KPI の `perf_setting_change` には付ける（どの区分の人が何を変えるか）。

### 56.3 画質の段と描画の値（REQ-PERF-003/004、`RenderProfile.Resolve`）
`auto` は区分 `low` → 低、`mid` → 中、`high` → 高。

| 段 | URP の品質レベル | レンダースケール | 影 | MSAA | パーティクル | ポストエフェクト | 観客の密度 |
|---|---|---|---|---|---|---|---|
| 低 `low` | 0 | 0.70 | なし | なし | ×0.35 | なし | ×0.3 |
| 中 `medium` | 1 | 0.85 | くっきり（hard） | 2x | ×0.70 | あり | ×0.6 |
| 高 `high` | 2 | 1.00 | やわらか（soft） | 4x | ×1.00 | あり | ×1.0 |

- **省電力が効いている間**（設定オン、または端末の省電力モード）：レースの外の fps は 30、パーティクル ×0.5（段の値に掛ける）、ポストエフェクトなし、影は hard まで、レンダースケールは 0.85 まで、スピード線・背景のゆっくりした動き（ホームのアートのドリフト）なし。レース中の fps は `frameRate` のまま。
- **動きを減らす（§41.6）との関係**：スピード線・FOV キック・背景のドリフトは「動きを減らす」オンでも消える（`MotionPolicy`）。省電力は fps と描画の重さ、動きを減らすは揺れと動きを決め、どちらも相手の値を変えない（両方オンなら両方の効果）。カメラの揺れは `MotionPolicy` だけが決める。
- スピード線は段が低でも出さない（重いので）。FOV キックは描画の重さに関係しないので、動きを減らすときだけ消える。
- 値は `RenderProfile`（`UrpQualityLevel`・`TargetFrameRate`・`RenderScale`・`Shadows`・`Msaa`・`ParticleScale`・`PostProcessing`・`CrowdDensity`・`SpeedLines`・`FovKick`・`AmbientMotion`・`BatterySaverActive`）。Unity は `QualitySettings.SetQualityLevel(UrpQualityLevel)`・`Application.targetFrameRate = TargetFrameRate`（`QualitySettings.vSyncCount = 0`）・URP アセットの `renderScale`・`msaaSampleCount`・影の設定に結ぶ。レースの出入りで `PerformanceSettingsModel.SetInRace` を呼ぶ。

### 56.4 データセーバーとアセット配信（REQ-PERF-005〜009、§16 に追加）
- **必須（`required: true`、boot・ftue）はいつでも取得する**（モバイル通信でも。チュートリアルを止めない §16.2 は同じ）。
- **必須でないもの**：データセーバーがオンでモバイル通信のときは取得しない（裏の先読みも `ondemand` も）。Wi-Fi につながったら取得を再開する。取得しないものはいつもどおり同梱 → `<kind>/default` で表示する（§16.4）。このときモバイル通信の確認（`cellularWarnBytes`）は出さない（何もモバイル通信で落とさないため）。データセーバーがオフなら今までどおり（§16.2 の確認つき）。
- **軽量版（low）**：カタログのエントリーは任意で `low: { "file", "sha256", "size" }` を持てる（§56.7）。データセーバーがオンなら、必須でないエントリーは軽量版があれば軽量版を取得して使う（Wi-Fi でも：容量も節約する）。オフなら通常版。端末に軽量版だけがあるときは通常版が届くまで軽量版を表示する（`AssetResolver` は「通常版 → 軽量版 → 同梱 → `<kind>/default`」）。
- **まとめてダウンロード**（ストレージ画面の「すべてダウンロード」）：必須でないエントリー全部（`ondemand` も含む）を今のデータセーバーの版で取得する。**押す前に残りのサイズを出す**（`AssetStorage.PredownloadBytes`）。モバイル通信では：データセーバーがオンなら押せない（「Wi-Fi に接続すると実行できます」）、オフなら必ずサイズを出して確認する。空き容量が足りない分は §16.4 のとおり取得しない（途中まで書かない）。何度押しても、取得済みのものは取り直さない（同じファイルは1回の転送）。
- データセーバーを切り替えたときは、次の先読み（起動時・ストレージ画面・Wi-Fi への切り替わり）から新しい版で取得する。もう端末にある版は消さない（キャッシュの削除か、カタログから外れたときに消える）。

### 56.5 レースの決定性（REQ-PERF-010）
- 設定は `Muchi.Engine` に一切届かない（`RaceConfig`・`RulesetParams`・`TickHz` = 20 は同じ）。fps が変えるのは `OfflineRace.Update`／`RaceSession` を呼ぶ回数だけで、シミュレーションは時計から決まる tick 数だけ固定ステップで進む。入力は「次の tick」に入るので、同じ tick に同じ入力なら結果ハッシュは同じ。
- テスト：`PerformanceSettingsTests.RaceHashIsTheSameForEverySetting`（全設定の組み合わせ × 区分 × 省電力モードで、決まった入力のレースを各設定の `RenderProfile.FrameIntervalMs` ごとの描画ループで走らせ、ハッシュがすべて同じ）。プロトタイプでも 30fps と 60fps の描画ループで同じハッシュ（`test/round19-performance.test.mjs`）。ゴールデンも変わらない。

### 56.6 保存（端末だけ、REQ-PERF-011）
- 4つの設定はすべて**端末にだけ**保存する（`PerformanceSettingsModel.KeyBlob` = `muchi.perf.settings`）。アカウントには保存しない、サーバーの API も `PlayerState` のキーもない。
- 理由：画質と fps は端末の性能、省電力は端末の電池、データセーバーはその端末の回線（Wi-Fi だけのタブレットと、モバイル通信のスマホ）で決まり、別の端末に持ち込むと逆効果になりやすい。データセーバーだけは同期も考えたが、同じ理由で端末ごとにする（機種変更・再インストールでは既定値の `auto`・オフから始まる）。§41 のアクセシビリティ（体の事情なのでアカウントに保存）とはここが違う。
- 起動直後から保存値を当てる（サーバーを待たない、オフラインでも同じ）。

### 56.7 カタログの軽量版（REQ-PERF-012、§16.1・§16.3 に追加、後方互換）
```json
{ "key": "scene/venue/aoba", "file": "scene/venue/aoba.bundle", "sha256": "<64 hex>", "size": 18342211, "group": "race", "required": false,
  "low": { "file": "scene/venue/aoba.low.bundle", "sha256": "<64 hex>", "size": 6120400 } }
```
- `low` は**任意**で、無いエントリーは今までとまったく同じ形（`low` を持つエントリーが1つも無いカタログは `hash`・ETag も今までと同じ）。古いクライアントは `low` を読まずに通常版を使う。新しい経路は無い（`GET /v1/assets/catalog` のまま、ゲートのグループも今まで通り）。
- 検証（§16.3 に追加）：`low` は `required: false` のエントリーだけ、`low.size` < `size`、`low.sha256` ≠ `sha256`、`low.file` ≠ `file`、`low.file` も同じ形式（小文字の相対パス）、同じ `file`・同じ `sha256` は同じ内容（通常版と軽量版をまたいで）。
- スキャナ（`npm run scan:assets`）：`<key>.low.<ext>`（例 `scene/venue/aoba.low.bundle`）を `<key>` の軽量版として付ける。通常版が無い軽量版・必須のキーの軽量版・`bundles.json` の中のファイルの軽量版は孤児として報告する。
- 端末：`AssetEntry.Low`、`AssetCatalog.ReferencedHashes` は軽量版も含む（古い版の削除で軽量版を消さない）。

### 56.8 ストレージ画面とキャッシュの削除（REQ-PERF-013/014、`AssetStorage`・`StorageModel`）
- 表示：端末のアセットの使用量を行ごとに（必須データ・画面のデータ（boot/ftue の必須でないもの・home・race・shop）・都度のデータ（ondemand）・軽量版・途中のダウンロード・古いデータ（カタログに無いもの））と合計、「すべてダウンロードするとあと何 MB」。サイズは 10 進（1MB = 1,000,000 バイト、ストアと同じ）。
- **キャッシュを削除**：確認（消えるサイズを出す）のあと、必須でないファイル・軽量版・途中のファイル・古いデータを消す。**今のカタログの必須のファイルと、取得中のファイルは消さない**（遊んでいる途中で必須のアセットが消えることはない）。消したものは次の先読みで設定どおり取り直す。消してもアカウント・進み具合・設定は消えない（アセットだけ）。
- どちらも端末の中だけ（サーバーへの送信なし）。

### 56.9 KPI（REQ-PERF-015）
| イベント | 送り手 | s1 | s2 | s3 |
|---|---|---|---|---|
| `perf_setting_change` | クライアント（プレイヤーが値を変えたときだけ。同じ値・起動時の自動の既定値では出さない） | 設定（`graphics` / `frameRate` / `batterySaver` / `dataSaver`） | 新しい値（`auto`・`low`・`medium`・`high`・`30`・`60`・`on`・`off`） | 端末の区分（`low` / `mid` / `high`） |
| `asset_predownload` | クライアント（「すべてダウンロード」を始めたとき1回） | 残りのサイズの区分（`lt_10mb` / `10_50mb` / `50_200mb` / `200mb_1gb` / `gte_1gb`） | 版（`full` / `low`） | |
- 値の組み合わせはサーバーで検査する（`graphics` に `30` は 400）。個人を特定する情報・機種名は入れない。クエリは `docs/ops/kpi-queries.md`「画質・省電力・通信量」。

### 56.10 クライアント（REQ-PERF-016〜018）
- `Muchi.Client`：`PerformanceSettings`（`Parse`・`ToJson`・`Defaults`・`Wire`）、`DeviceProfile`・`IDeviceInfo`・`DeviceClassifier`、`RenderProfile.Resolve(settings, context)`（`PerformanceContext`：区分・レース中か・端末の省電力モード・動きを減らす・最大リフレッシュレート）、`AssetDownloadPolicy`（必須・データセーバー・回線から「取得する／Wi-Fi を待つ」と版を決める）、`AssetStorage`（使用量・まとめてダウンロードの残り・キャッシュの削除）、`AssetEntry.Low`・`AssetResolver` の軽量版、analytics `perf_setting_change`・`asset_predownload`。
- `Muchi.Game`：`PerformanceSettingsModel`（端末の保存・`Changed` イベント・画面が結ぶ値・設定画面の行 `Rows()`・`SetInRace`・`OnLowPowerModeChanged`）、`StorageModel`（行・合計・まとめてダウンロード（サイズ・確認・Wi-Fi 待ち・進み具合）・キャッシュの削除（確認））、`AssetPreloadModel` にデータセーバーの方針を渡せる（無ければ今まで通り）。
- プロトタイプ：設定の「画質・通信量」と「ストレージ」画面。画質・fps・省電力は実際にレースの 3D 表示（ピクセル比・影・FOV キック・スピード線）と描画ループの fps、ホームの背景の動きを変える。日英・文字の大きさ。
- ヘルプ（§48）：記事 `data_storage`（データ通信量と容量、端末ごとの設定であること、レースの結果は変わらないこと）。画面のリンク `storage`。

## 57. チュートリアルのやり直しとヒント集（replay tutorials & tips library、REQ-TUT-001〜018、`server/src/domain/tips.ts`・`server/master/tips.json`、C# `Tips.cs`・`Muchi.Game.TipsModel`／`TutorialReplayModel`、docs/handoff-codex-round19-tutorial-replay.md）
設定の「ヒント」から、レースのチュートリアル（ムチのタイミング・位置取り・スタミナ・手綱）と機能のツアー（配合・調教・スカウトの提供割合と天井・ショップとコインの種類（有償・無償）・支部・カップ）をいつでもやり直せる。あわせて、機能が開くと読めるようになる短い絵付きのカード（日本語・英語）と、複雑な画面の「？」ボタン。**何も配らない**（E番号なし、経済は変わらない）。

**決まりごと**
- やり直しは**端末の中だけ**：レースのレッスンは練習と同じく端末のエンジンで走る（ムチは FTUE のチュートリアルのレース（`OfflinePresets.TutorialRace`、`TutorialDirector` 付き）そのもの、位置取り・スタミナ・手綱は端末の練習レース（`RaceFactory.Practice`）。どちらも既存の部品を使い、写しを作らない）。**サーバーに結果を送らない・レースに数えない・オンボーディングの状態（FTUE の段・チュートリアルの回数・KPI の `tutorial_step`）に触れない・報酬なし**。最初のチュートリアルの報酬（相棒 `PARTNER_ALREADY_GRANTED`・入厩祝いの10連 `TUTORIAL_GACHA_USED`・初心者ミッション `ALREADY_CLAIMED`）は一度だけのまま。
- ツアーはカードのページ送り（同じカードを使う。文を二重に持たない）。開放前の機能のツアーは開けない。
- カードは `server/master/tips.json`（リモート設定の `tips` で丸ごと置き換え）に**日本語と英語の両方**を持ち、要求の言語で返す。**数字はカードに書かない**：ヘルプセンター（§48.1）の `{{トークン}}` を同じ仕組み（`fillTokens`）で埋める（天井・提供割合は提供割合の画面と同じ計算）。
- **ヒントは短く、ヘルプは長く**：カードは `bodyMaxChars` 文字まで。くわしい説明はカードの `help`（ヘルプ記事 id）へのリンクで、**カードはヘルプ記事の文をそのまま繰り返さない**（12文字以上の文が一致したら検査で落とす）。
- 言葉：§48 と同じ（日本語の「倍」「お得」「今だけ」「残りわずか」「通常価格」・賭けの言葉（`bettingWords.ts`）・英語の `EN_BANNED`）。スカウトとショップの話題のカードはトークンの外に数字を置けない（「10連」だけ例外）。
- 見たカードは**アカウントに保存**（`tips.seen`、開いているカードの id だけ、`seenMax` 件まで、マスターから消えた id は落とす）。端末をまたいでも「NEW」がそろう。

### 57.1 マスター（`server/master/tips.json`）
```json
{ "version": 1,
  "config": { "enabled": true, "titleMaxChars": 24, "bodyMaxChars": 160, "seenMax": 200, "seenPerRequest": 20 },
  "topics": [ { "id": "race", "title": { "ja": "レース", "en": "Racing" } } ],
  "tips": [ { "id": "scout_pity_tip", "topic": "scout", "unlock": null, "art": "pity", "help": "pity",
              "title": { "ja": "交換ptで選べる", "en": "Exchange points" },
              "body": { "ja": "…常設では{{pity_pulls:standard}}回分で…", "en": "…{{pity_pulls:standard}} pulls' worth…" } } ],
  "contexts": { "gacha_odds": "scout_pity_tip", "breeding": "breeding_pair", "training": "training_timing", "roster_bulk_retire": "roster_retire" },
  "tutorials": [ { "id": "race_whip", "kind": "race", "lesson": "whip", "unlock": null, "title": { "ja": "ムチのタイミング", "en": "Whip timing" }, "tips": ["whip_window", "whip_spacing"] },
                 { "id": "tour_scout", "kind": "tour", "unlock": "scout", "title": { "ja": "スカウトのツアー", "en": "Scout tour" }, "tips": ["scout_rates_tip", "scout_pity_tip", "scout_guarantee"] } ] }
```
- `config`：`titleMaxChars` 8〜40、`bodyMaxChars` 40〜240、`seenMax` 20〜500、`seenPerRequest` 20〜50（クライアントは20件ずつ送るので、それより下げない）。
- 話題 `topics` は5つ：`race`（レース）・`horses`（馬を育てる）・`scout`（スカウト）・`shop`（ショップ・コイン）・`social`（支部・カップ）。全部そろって重ならない。
- カード `tips`（120枚まで）：`id` は `^[a-z0-9_]{2,40}$` で重ならない（ツアーの id とも）。`unlock` は §4.3 の開放キー（`UNLOCK_KEYS`）か `null`（最初から）。`art` は絵の種類（`whip`・`slipstream`・`lanes`・`stamina`・`reins`・`breeding`・`stud`・`training`・`roster`・`scout`・`pity`・`coins`・`branch`・`cups`、Codex が描く）。`help` は存在するヘルプ記事（リモート設定でヘルプからその記事を外す版は有効にできない）。日本語と英語でトークンの組が同じ。英語に日本語を入れない。
- `contexts`（「？」の画面 → カード）：`gacha_odds`（提供割合）・`breeding`（配合）・`training`（調教）・`roster_bulk_retire`（まとめて引退）。全部そろって、存在するカードを指す。
- `tutorials`（30件まで）：`kind` は `race`（レッスン）か `tour`（ツアー）。レッスン `lesson` は `whip`・`position`・`stamina`・`reins` が1つずつ、`unlock: null`（最初から）。`tips` は存在するカード1〜6枚（重ならない）。

- Round 19 統合：Round 18／19 の機能のカードを足した（`practice_tip` → 記事 `practice_races`、`goals_tip` → `horse_goals`、`qchat_tip` → `quick_chat`（`teams` で開く）、`cheer_tip` → `spectator_cheer`（`friend_rooms` で開く））。絵は既存の `art` キーだけを使う（Codex の追加の絵なし）。データのダウンロード（§51）はどの話題にも合わないのでカードを作らず、プライバシーの画面の「？」（ヘルプの文脈 `privacy`）から読む。

### 57.2 `GET /v1/tips`（要認証、読むだけ）
```json
{ "enabled": true, "version": 1, "lang": "ja", "newCount": 9,
  "topics": [ { "id": "scout", "title": "スカウト", "count": 3, "unlocked": 3, "newCount": 3 } ],
  "tips": [ { "id": "scout_pity_tip", "topic": "scout", "art": "pity", "unlock": null, "unlocked": true, "new": true,
              "title": "交換ptで選べる", "body": "…常設では200回分で…", "help": { "articleId": "pity", "title": "天井（交換pt）のしくみ" } },
            { "id": "breeding_pair", "topic": "horses", "art": "breeding", "unlock": "breeding", "unlocked": false, "new": false,
              "title": "配合のきほん", "body": null, "help": { "articleId": "breeding", "title": "配合と種付け" } } ],
  "tutorials": [ { "id": "race_whip", "kind": "race", "lesson": "whip", "unlock": null, "unlocked": true, "title": "ムチのタイミング", "tips": ["whip_window", "whip_spacing"] } ],
  "contexts": { "gacha_odds": "scout_pity_tip" } }
```
- 開放は `GET /v1/player` の `unlocks`（§4.3）と同じ判定。表にないキーは最初から開いている（ホームと同じ）。
- 開いていないカードはタイトルと開放キーだけ（`body: null`）。`new` = 開いていて、まだ見ていない。
- `enabled: false` のときは `topics`・`tips`・`tutorials`・`contexts` が空、`newCount: 0`。
- `GET /v1/player`・bootstrap に `tips: { "newCount": n }`（設定の「ヒント」のバッジ）。

### 57.3 `POST /v1/tips/seen`（要認証）
`{ "ids": ["whip_window", "whip_spacing"] }`（1〜`seenPerRequest` 件、`^[a-z0-9_]{2,40}$`、他のキーは 400）→ `{ "marked": ["whip_window"], "skipped": [], "newCount": 8 }`。何度送っても同じ（見たものは見たまま）。開いていないカードは `skipped`（見たことにしない）。無い id が1つでもあれば 404 `NOT_FOUND` で何も記録しない。ライブラリが止まっているときは 404。

### 57.4 やり直し（端末）
- レッスンの流れ：カード（そのレッスンの `tips`）→ レース → 結果（「もう一度」「ヒントに戻る」）。ムチのレッスンは FTUE と同じ勝ち方（最後の300mでムチ2回以上で差し切り）。やり直しの回数は FTUE のチュートリアルの回数（`muchi.tutorial.attempts`）とは別で、補正（3回目で勝つ）も使わない。
- レース中の案内は既存の `RaceFeel` の1行（「今だ、ムチ！」「掛かっている：手綱を長押し」「脚が上がった」など）。レッスンごとに見せたい案内の種類を `TutorialReplayModel.FocusOf` が決める。
- かんたん操作（§30）はレッスンでも付けない（チュートリアルと同じ）。
- Round 19 統合（§50 との関係）：位置取り・スタミナ・手綱のレッスンは §50 の練習レースそのもの（`PracticeSession` が練習のカタログ（無ければ §50.6 の内蔵のカタログと相棒）と既定の条件から組む。Unity は `GameBackend.CreateLessonRace`、プロトタイプは WASM の `LessonBegin`）。練習のオプション（ムチの目安・スロー・ゴースト）は付けず、プレイヤーの練習のセッション（回数・ゴースト）には触れない。練習のレースを組む経路は1つ（§57 が別の組み方を足さない）。`practice_start`／`practice_finish` の KPI は送らない（`tutorial_replay` だけ）。

### 57.5 ゲートのグループ
`/v1/tips*` はエンドポイントのグループ `core`（`all` のメンテナンスだけが閉じる）。サポート（§48 のヘルプ・問い合わせ）ではないので、免除のルートには入れない。

### 57.6 KPI（クライアントのイベント）
- `tutorial_replay`（`props.tutorialId`、`props.kind`：`race`・`tour`、`props.stage`：`start`・`finish`）→ s1 = id、s2 = 種類、s3 = 段。
- `tip_view`（`props.tipId`、`props.source`：`list`・`context`・`tour`・`lesson`）→ s1 = カード、s2 = 入口。
- `tip_context_open`（`props.context`：§57.1 の4つ、`props.tipId`）→ s1 = 画面、s2 = カード。
- クエリは `docs/ops/kpi-queries.md`「ヒント」。

### 57.7 クライアント
- `Muchi.Client`：`TipsIndex`（`Parse`）・`TipsSeenResult`・`TipsBadge`（`PlayerView.Tips`）、`ApiClient.GetTipsAsync`・`MarkTipsSeenAsync`、`TipContexts`・`RaceLessons`、analytics `AnalyticsEvent.TutorialReplay`・`TipView`・`TipContextOpen`。
- `Muchi.Game`：`TipsModel`（話題ごとの一覧・NEW・見た印をまとめて送る（オフラインは端末に貯めて後で送る）・「？」の `OpenContext`・ツアーのページ送り・開いていない機能のツアーは開けない）、`TutorialReplayModel`（レッスンのレースを `GameBackend` の既存の部品で作る（ムチ = `OfflinePresets.TutorialRace`、他 = 練習レース）・FTUE の段・回数・KPI に触れない・`tutorial_replay` を送る）。
- 画面が守ること：docs/handoff-codex-round19-tutorial-replay.md。

## 58. 広告・分析の同意管理（ad tracking & analytics consent、REQ-CNS-001〜020、`server/src/domain/privacyChoices.ts`・`server/src/domain/kpiConsent.ts`、C# `Consent.cs`（`ConsentState`・`IConsentPlatform`・`AdRequestConfig`）・`Muchi.Game.ConsentModel`、docs/handoff-codex-round20-consent.md）
利用規約・プライバシーポリシーへの同意（REQ-UXS-001、`POST /v1/player/consent`）とは**別に**、プレイヤーが**パーソナライズ広告**と**分析（KPI）**を自分で選べるようにする。iOS は App Tracking Transparency（ATT）のシステムの確認の前に**理由を説明する事前の画面**を出し、Android／EEA は Google UMP 型の同意管理（CMP）を**インターフェースの後ろ**に置く（本物の SDK の呼び出しは Codex、docs/handoff-codex-round20-consent.md）。選んだ結果・版・日時はプレイヤーごとにサーバーに保存し、リワード広告（§21）の広告リクエストと KPI の受け付け（REQ-KPI-003）がそれに従う。コイン・アイテムは動かない（E 番号なし）。断っても報酬・機能は何も減らない（Apple 5.1.1(iv)・GDPR の「自由な同意」）。

### 58.1 状態 `privacyChoices`（PlayerState のトップレベルのキー、§51 の分類は `account`）
```ts
{ personalizedAds: boolean | null, analytics: boolean | null,   // null = まだ選んでいない（58.3 の既定が効く）
  decidedVersion: string | null, decidedAt: number | null,      // 最後に選んだ時のプライバシーポリシーの版と時刻
  updatedAt: number, rev: number,                               // 値が変わるたびに +1
  promptShownAt: number | null, promptShownVersion: string | null, // 事前の画面を出した時刻と版（同じ版では二度出さない）
  platform: { os: 'ios'|'android'|'other', att: AttStatus | null, gdprApplies: boolean | null, cmp: CmpStatus | null, at: number } | null,
  history: { at, key: 'personalized_ads'|'analytics'|'att'|'cmp'|'prompt', value: string, source: 'prompt'|'settings'|'platform', version: string }[] } // 新しい50件
```
`AttStatus` = `not_determined`・`restricted`・`denied`・`authorized`・`unavailable`（iOS 14 未満・ATT の無い OS）。`CmpStatus` = `not_required`・`required`・`obtained`・`unknown`（UMP の `ConsentStatus` と同じ）。

### 58.2 子ども（REQ-CNS-006）
既存の年齢（REQ-PUR-002 `age`、`ageBand` と同じ数え方）で **13歳未満**、または **EEA（`platform.gdprApplies = true`）で16歳未満** を「子ども」とする（GDPR 8条の上限、地域が分からない時は 13歳）。子どもは
- パーソナライズ広告：**常にオフ**（変えられない、`locked: "minor"`）。広告は非パーソナライズで出る（§21 の `minAge` 未満はそもそも出ない）。
- 分析：**既定でオフ（最小限）**。保護者の同意（`age.guardianConsent`）がある時だけオンにできる（無い時は `locked: "minor"`、PUT で `true` を送ると `403 NOT_ELIGIBLE`）。
- 既存の REQ-AD-009 はそのまま：年齢が分からない・18歳未満はパーソナライズ広告を出さない（`locked: "age_unknown"`／`"under18"`）。

### 58.3 既定と「効いている値」（REQ-CNS-003/004）
| 項目 | まだ選んでいない時の既定 | 効いている値（`effective`） |
|---|---|---|
| パーソナライズ広告 | **オフ**（オプトイン） | 選んだ値 かつ 子どもでない かつ 18歳以上の年齢が登録済み（REQ-AD-009）かつ（iOS なら `att = authorized`）かつ（`gdprApplies` なら `cmp = obtained` か `not_required`） |
| 分析 | オン。ただし子ども・`gdprApplies = true` はオフ | 選んだ値（子どもは保護者の同意がある時だけオン） |
`locked`（スイッチを変えても効かない理由、画面に出す）：`minor`・`under18`・`age_unknown`・`att`・`cmp`・`null`。強い順に1つ。

### 58.4 事前の画面と再確認（REQ-CNS-007/008）
- `required` = 今のプライバシーポリシーの版（`progression.consent.privacyVersion`）で選んでいない（`decidedVersion ≠ 今の版`）。
- `prompt`（端末が事前の画面を出す時）：
  - **FTUE 中は出さない**：§21 の `minRankedRaces` 戦（既定 3）と `minGameDay` 日目（既定 2 = インストール当日は出さない、06 §2.3 の「2日目以降」）を満たすまで `null`。
  - 一度も選んでいない → `"ad_offer"`：**最初のリワード広告のカードを出す直前**に1回（`GET /v1/ads` が `eligible` の時）。広告が出ない人（広告が無効・オフ・年齢など）は `"next_home"`。
  - 前の版で選んだ人（ポリシーの版が上がった）→ `"next_home"`：規約の再同意（REQ-UXS-001）の後、次にホームを開いた時に1回。選んでいた値はそのまま効き続ける（勝手にオフ・オンにしない）。
  - 同じ版で事前の画面を一度出したら（`promptShownVersion = 今の版`）`null`。設定からはいつでも変えられる。
- iOS：事前の画面で「続ける」→ ATT のシステムの確認（`not_determined` の時だけ、OS が1回しか出さない）→ 結果を `PUT /v1/privacy/platform` で送る。「あとで」は ATT を出さない（次は設定から）。ATT を断った・制限中の時、設定の「パーソナライズ広告」は iOS の設定アプリを開く案内になる。
- Android／EEA：`gdprApplies` の時は UMP の同意フォーム（CMP）を出し、結果（`cmp`）を送る。設定の「広告の同意を見直す」は UMP の privacy options フォームを開く（`privacyOptionsRequired` の時）。

### 58.5 API（要認証、メンテナンス・強制アップデートで**閉じない**（規約の同意と同じ、§46 `EXEMPT_ROUTES`））
| メソッド | パス | 本文 → 応答 |
|---|---|---|
| GET | `/v1/privacy/choices` | → `PrivacyChoicesView`（読むだけ、状態を作らない） |
| PUT | `/v1/privacy/choices` | `{ privacyVersion, source: "prompt"\|"settings", personalizedAds?: bool, analytics?: bool }` → `PrivacyChoicesView` |
| PUT | `/v1/privacy/platform` | `{ os: "ios"\|"android"\|"other", att?: AttStatus, gdprApplies?: bool\|null, cmp?: CmpStatus }` → `PrivacyChoicesView` |
| POST | `/v1/privacy/prompt-shown` | `{ privacyVersion }` → `PrivacyChoicesView`（事前の画面を出した記録。同じ版は1回だけ書く） |
- `privacyVersion` が今の版でなければ `409 CONSENT_VERSION_MISMATCH`（端末は取り直す）。送らなかった項目は今の効いている値のまま（既定を確定させる）。PUT は選んだ記録になる（`decidedVersion`・`decidedAt`）。
- 同じ内容をもう一度送っても何も変わらない（`rev` も KPI も増えない）→ 冪等キー不要。
- 余分な項目・不正な値は `400 BAD_REQUEST`。削除の手続き中（`deleting`）は `DELETION_PENDING`（予定中は変えられる：法的な権利）。
- `privacyChoices` は `GET /v1/player`・ブートストラップの `extra` にも入る（`required`・`prompt`・`personalizedAds`・`analytics`・`adRequest`）。

```json
{ "policyVersion": "2026-11-01", "decidedVersion": "2026-11-01", "decidedAt": 1794790800000, "updatedAt": 1794790800000, "rev": 2,
  "required": false, "prompt": null, "minor": false,
  "personalizedAds": { "value": true, "effective": false, "locked": "age_unknown" },
  "analytics": { "value": true, "effective": true, "locked": null },
  "platform": { "os": "ios", "att": "authorized", "gdprApplies": false, "cmp": "not_required", "at": 1794790700000 },
  "adRequest": { "npa": 1, "nonPersonalized": true, "underAgeOfConsent": false, "ageKnown": false, "tagForChildDirected": false, "extras": { "npa": "1" } },
  "kpi": { "optional": true } }
```

### 58.6 リワード広告（§21）との関係（REQ-CNS-010/011）
- `GET /v1/ads` と `POST /v1/ads/:placementId/start` の `adRequest` は **58.3 の効いている値**から作る：`nonPersonalized = REQ-AD-009 の判定 || パーソナライズ広告が効いていない`、`npa = nonPersonalized ? 1 : 0`、`extras.npa = "1"`（AdMob のネットワーク追加パラメータ）、子どもは `tagForChildDirected: true`。
- セッションに開いた時の `npa` を記録する（`AdSession.npa`、`GET /v1/ads/sessions/:id` にも出す）。SSV のコールバック（§21.4）は `npa` で**報酬を変えない・弾かない**：非パーソナライズでも同じ無償コイン・同じ上限（断っても損をしない）。
- 同意を後から変えても、すでに開いたセッションはそのまま（次のリクエストから効く）。

### 58.7 KPI の分類（REQ-CNS-012〜014、`server/src/domain/kpiConsent.ts`）
- すべての KPI イベント名を **`essential`（必須：法定の記録・不正対策・同意の証跡）** か **`optional`（任意：分析）** に分類する（`KPI_EVENT_CLASS`）。分類の無い名前は `optional` として扱う（迷ったら送らない）。テストがサーバーのコードから出すイベント名・クライアントのイベント名を全部集め、分類が無ければ失敗する。
- `essential`：`purchase`・`refund`・`pass_renew`・`pass_status`（資金決済法・返金の記録）、有償コインを使ったかもしれないもの `gacha_draw`・`silks_part_buy`・`commentary_pack_buy`（前払式支払手段の使用の記録）、`ad_reward`・`ad_reject`（広告ネットワークとの照合・不正対策）、`consent`・`consent_change`（同意の証跡）、`account_delete`・`dex_request`・`dex_ready`・`dex_download`（本人の権利の記録）、`report_submit`・`block_add`・`block_remove`・`inquiry_submit`・`inquiry_answered`（安全・サポートの記録）。それ以外はすべて `optional`（クライアントのイベントは全部 `optional`）。
- **Round 19〜21 のイベント（R20・R21 統合で決めたこと）**：
  | イベント | 送り手 | 分類 | 理由 |
  |---|---|---|---|
  | `transfer_issue`・`transfer_redeem`（§54.9） | サーバー | `essential` | アカウントへの入口の監査（サインインと同じ扱い）。失敗の分類で総当たり・乗っ取りを見つける。ID・パスワード・IP は元から入れない |
  | `review_prompt_eligible`・`review_prompt_shown`・`review_soft_answer`（§59） | サーバー | `optional` | 頼む時の調整のための分析。分析がオフでもレビュー依頼の規則（間隔・回数）は状態 `reviewPrompt` で守られ、KPI に頼らない |
  | `cheer_send`・`cheer_seen`（§55）、`perf_setting_change`・`asset_predownload`（§56）、`tutorial_replay`・`tip_view`・`tip_context_open`（§57）、`lnotif_scheduled`・`lnotif_opened`・`lnotif_permission`（§61） | クライアント | `optional` | 遊び方・設定の分析だけ。端末の `ConsentState.AllowsClientEvent` が捨て、サーバーも捨てる |
  | `showcase_save`（サーバー）・`showcase_view`・`showcase_share`（§62）、`link_create`・`link_resolve`・`link_revoke`・`rematch`（サーバー）・`deep_link_open`（§63）、`release_notes_view`・`release_notes_target`・`release_notes_history`（§64）、`calendar_view`・`calendar_entry_open`・`calendar_mark`（サーバー、§65）（R21 統合） | サーバー／クライアント | `optional` | カード・リンク・お知らせ・予定表の使われ方の分析だけ。支払い・法定・アカウントの入口の記録は無い。リンクの行はトークン・行き先・相手の id を元から入れない（§63.9）。分析がオフなら書かない（リンク・再戦・カードの見た目はそのまま動く） |
  | `device_signout`・`new_device_notice`（§70.9、Round 23） | サーバー | `essential` | アカウントへの入口の監査（`transfer_*` と同じ扱い）。ログアウトの操作と新しい端末の増え方で乗っ取りを見つける。端末のハッシュ・セッションの ID・地域・機種は入れない |
  | `device_list_view`（§70.9、Round 23） | クライアント | `optional` | 一覧と記録の使われ方の分析 |
  - クライアントのエラー報告（§60）は KPI ではない（別の口 `POST /v1/client-errors`）。急増の知らせ `client_error_spike` は Worker のログのアラートで、KPI のイベントではない。§60 との関係は 58.10。
- **サーバーで強制**：分析が効いていない（`analytics.effective = false`）プレイヤーの `optional` のイベントは、サーバーのトランザクションのイベントもクライアントの `POST /v1/analytics/events` も **Analytics Engine に書かない**。クライアントのバッチの応答は `{ accepted, dropped, withheld }`（`withheld` = 同意が無いので書かなかった数。レート制限の数には入れる）。
- `consent_change`（サーバー、essential）：`s1` = `personalized_ads`／`analytics`／`att`／`cmp`、`s2` = 新しい値（`on`／`off`、ATT・CMP は状態の名前）、`s3` = `prompt`／`settings`／`platform`。変わった項目ごとに1行。

### 58.8 個人データの開示（§51）・アカウント削除
- `privacyChoices` は `account` セクションに全部入る（選んだ値・版・時刻・端末の状態・履歴）。
- アカウント削除の最後の `wipe` で消える。他の場所に写しは無い（KPI の行は §51 の分析イベントと同じ扱い）。

### 58.9 クライアント
- `Muchi.Client`：`ConsentState`（ビューの読み取り・`AllowsClientEvent(name)`・`AdRequestConfig`）、`IConsentPlatform`（`AttStatus`・`RequestAttAsync`・`GatherCmpAsync`・`PrivacyOptionsRequired`・`ShowPrivacyOptionsAsync`・`OpenAppSettings`）、`ApiClient.GetPrivacyChoicesAsync`・`SetPrivacyChoicesAsync`・`ReportPrivacyPlatformAsync`・`NotePrivacyPromptShownAsync`、`AnalyticsClient.Gate`（同意の無い時に任意のイベントを端末で捨てる。サーバーも捨てる）。
- `Muchi.Game.ConsentModel`：事前の画面を出すかどうか（FTUE・広告の直前・ホーム）、ATT・CMP の流れ、設定の行、`IAdConsent` の実装（§21 の `RewardedAdModel` に渡す）。

### 58.10 クライアントのエラー報告（§60）との関係（R20 統合）
- §60 のエラー報告の「診断データの同意」（`ErrorReporter.AllowsDiagnostics`）は **分析（`analytics`）の選択**で決める（パーソナライズ広告ではない）。分析が効いている（`analytics.effective`）時だけ、エラーの見本にプレイヤー ID を付ける。子ども（保護者の同意なし）・EEA の既定・オフにした人の報告は匿名で届く。報告そのもの（個人情報を落とした種類・版・機種）は分析をオフにしても送る（不具合の修正は運営の正当な目的で、ID の無い報告は個人データにならない。§60.3）。
- 端末：`ErrorReporter.FollowConsent(() => ConsentState)`、Unity は `ClientErrorModel.FollowConsent(ConsentModel)`。`ConsentState.AllowsDiagnostics` = `analytics.effective && kpi.optional`。ビューがまだ無い時は true（その束は認証が無いか、サーバーが判定する）。
- サーバー：`POST /v1/client-errors` は認証された束でもプレイヤーの `analytics.effective` を確かめ、true でなければ playerId を残さない（§60.6）。
- 設定の画面では「プライバシー」の中に「広告と分析」と「エラーの自動送信」を並べ、エラーの自動送信の画面は「プレイヤーIDを添えるかは『分析への協力』に従います」と案内する。

### 58.11 お願いの画面は1セッションに1つ（§20・§46.9・§59・§61・§64 との関係、R20 統合・R21 統合で1つの表に）
- **1セッション（アプリの起動から終了まで、またはアカウントが変わるまで）に出す「お願いの画面」は1つだけ**。最初に出たものがそのセッションを取り、ほかは次のセッションに回る（それぞれの規則で「まだ出していない」ままなので、失われない）。**FTUE の間はどれも出さない**。§46 のメンテナンス・強制アップデートの画面（`ApiClient.Outage` が `None` 以外）の上にも出さない（それは案内ではなく画面で、その間は判定もしない）。
- **同じ時に2つ以上が出せる時の順（この表が唯一の決まり。§64.6 もこの表を指す。R21 統合）**：

  | 順 | 種類の id（`SessionPrompts`） | 画面 | 理由 |
  |---|---|---|---|
  | 1 | `recommended_update` | 推奨の更新の案内（§46.9、版ごとに1回） | 古いアプリのままだと他の案内の行き先が開けないことがある |
  | 2 | `consent_pre_prompt` | 広告・分析の同意の事前の画面（§58、続く ATT・CMP を含む） | 法令・ストアの決まり。パーソナライズ広告・分析を使う前に決めてもらう |
  | 3 | `comeback_welcome` | 復帰キャンペーンの歓迎画面（§20、ホームの代わり） | 期間のあるキャンペーンの入口 |
  | 4 | `release_notes` | アップデートのお知らせ（§64） | 新しい版の最初のホーム |
  | 5 | `reminders_pre_permission` | 端末の通知の前置き（§61.4、続く OS の通知の許可を含む） | 調教の直後に役に立つ |
  | 6 | `account_link` | 引き継ぎの案内（REQ-UXS-073） | 3日目・初めての購入の後 |
  | 7 | `review_prompt` | レビュー依頼（§59、前置きの質問・OS のシート） | お願いだけ。いちばん低い |

  だから ATT・同意の画面と通知の画面が続けて出ることは無く、レビューが他のどれかのすぐ後に出ることも無い。
- 同意の事前の画面がこの規則で出せなかった時、最初の広告は今の効いている値（まだ選んでいなければ非パーソナライズ）で出る。報酬は同じ（58.6）。
- 端末：**1つの仕組み** `Muchi.Client.SessionPrompts`（`Priority`・`CanShow`・`TryClaim(kind, alsoDue)`・`Pick(due)`・`NewSession`。作る時に `ApiClient.Outage` と FTUE かどうかを渡す）。Unity は同じ1つを `MaintenanceModel.Prompts`・`ConsentModel.Prompts`・`ComebackModel.Prompts`・`ReleaseNotesModel`（コンストラクタ）・`LocalNotificationModel.Prompts`・`AccountLinkPrompt.Prompts`・`ReviewPromptModel.Prompts` に渡す。プロトタイプは `sessionPrompt`（`PROMPT_PRIORITY` は上の表と同じ）。R20 の `SessionPromptGate` と R21 の `SessionPrompts.TryClaim` の2つの仕組みは R21 統合でこの1つにした。サーバーには状態を足さない（セッションは端末のもの）。テスト：`server/test/r21-integration.test.ts` が表・C#・プロトタイプの一致を確かめる。
- **アカウントが変わった時（§54）**：`SESSION_REPLACED`・引き継ぎコードの入力で `AccountChangeReset` がローカル通知を全部取り消し（§61.5。§65 の予定表の印から作った通知も含む）、エラー報告の溜まった分を ID なしにし（§60.6）、レビューのセッション（id と「このセッションで頼んだ」）を新しくし、端末で待っているディープリンク（§63）を捨て（前のアカウントに届いたもの）、アップデートのお知らせの「このセッションで出した」（§64。見た印はサーバーのアカウントごと）を戻し、この1つの規則を最初に戻す（R21 統合）。
- **`reminders`（§61）と同意**：呼び戻しの種類なので既定オフで、前置きで選んだ人だけ（§3.5 の「新しい種類と同意」）。トラッキング・広告には使わず、パーソナライズ広告の選択とは関係しない。`lnotif_*` の KPI は `optional`（分析がオフなら送らない・書かない、58.7）。子どもにも同じ規則（購入・広告への誘いは無い、§61.1）。

## 59. レビュー依頼のタイミング（in-app store review prompt、REQ-REV-001〜016、`server/src/domain/reviewPrompt.ts`・`progression.reviewPrompt`、C# `ReviewPrompt.cs`（`ReviewPromptPolicy`・`IStoreReview`）・`Muchi.Game.ReviewPromptModel`、共有ベクター `contracts/review-prompt.vectors.json`）
App Store / Google Play の評価を、**OS の標準のアプリ内レビュー API**（iOS `SKStoreReviewController` / `AppStore.requestReview`、Android Play In-App Review）でだけ頼む。頼むのは**うれしい瞬間**（初勝利・大会の初優勝・殿堂入り・馬の目標の列を全部達成）だけで、負けた直後・購入・エラー・返金・メンテナンスのお知らせの直後・チュートリアル（FTUE）の途中には頼まない。決めるのはデータの規則（`progression.reviewPrompt`、起動時と各リモート設定の版で検証）と**純粋な関数**（`decideReviewPrompt`、C# `ReviewPromptPolicy.Decide`、共有ベクター）。頼んだ記録はサーバーが持つ（新しい状態のキー `reviewPrompt`）ので、入れ直しても繰り返し頼まない。

**レビューには何も配らない**（E 番号なし、balance-targets の節なし）。Apple（App Store Review Guidelines 5.6.1：レビューは標準の API で、報酬と引き換えにしない）と Google（Play のユーザー評価のポリシー：インセンティブを付けたレビューの禁止）の決まり。コイン・アイテム・XP・称号・ミッションの進み、どれもレビューに結び付かない。サーバーは端末が本当にレビューを書いたかを知らない（OS は結果を返さない）し、知る経路も作らない。規則に報酬の項目を書くと検証で落ちる（`reward`・`rewards`・`coins`・`items`・`freeCoins` は知らないキー、テストで確認）。

### 59.1 うれしい瞬間（`moment`）
| `moment` | いつ（端末が判断して送る） |
|---|---|
| `first_win` | 初めての1着（チュートリアルを除く確定したレース。結果画面を閉じた後） |
| `first_tournament_win` | 大会（§20）の初めての優勝（表彰の後） |
| `hall_induction` | 殿堂入り（§34 の引退の式の後） |
| `horse_goal_chain` | 馬の目標の列を全部達成（§53 の印が付いた後） |
- 瞬間は端末の言葉をそのまま使う（サーバーは数え直さない）。レビュー依頼は何も配らないので、偽っても得をする物が無い。規則の `moments` に無い瞬間は頼まない（運用で1つずつ止められる）。
- 画面の途中（レース中・演出の途中・購入の途中）では出さない。端末は結果・表彰・式の画面を閉じてホームに戻った所で1回だけ聞く。

### 59.2 規則 `progression.reviewPrompt`（`reviewPromptProblems`、起動時と各版）
```json
{ "enabled": true,
  "moments": ["first_win", "first_tournament_win", "hall_induction", "horse_goal_chain"],
  "minDaysSinceInstall": 3, "minRacesPlayed": 10,
  "maxPerYear": 3, "coolDownDays": 120,
  "quietMinutes": { "loss": 30, "purchase": 1440, "refund": 43200, "error": 30, "maintenanceNotice": 60 },
  "softAsk": { "ios": false, "android": false } }
```
| キー | 検証 |
|---|---|
| `enabled` | bool。`false` なら誰にも頼まない（止めるスイッチ） |
| `moments` | 59.1 の値だけ、重複なし（`enabled: true` なら1つ以上） |
| `minDaysSinceInstall` | 整数 0〜365（インストール＝アカウントを作った時から） |
| `minRacesPlayed` | 整数 0〜1000（戦績 `stats.races`） |
| `maxPerYear` | 整数 1〜3（直近 365 日に頼んだ回数の上限。Apple は1年に3回までしか出さないので、それより多くは書けない） |
| `coolDownDays` | 整数 30〜365（前に頼んでから空ける日数） |
| `quietMinutes` | `loss`・`purchase`・`refund`・`error`・`maintenanceNotice` の5つ全部、整数 0〜525600（365日） |
| `softAsk` | `{ ios: bool, android: bool }`。**`android: true` は検証で落ちる**（59.6）。既定は両方 `false` |
知らないキーは落ちる（報酬の項目を足せない）。

### 59.3 判断（`decideReviewPrompt(rules, summary)`、純粋、REQ-REV-003）
入力の要約（`ReviewPromptSummary`）：
```json
{ "platform": "ios", "moment": "first_win", "now": 1796698800000,
  "installedAt": 1795000000000, "racesPlayed": 14, "inFtue": false, "accountClosing": false,
  "sessionPrompted": false, "maintenanceVisible": false, "coinDebt": false,
  "minutesSince": { "loss": null, "purchase": 9000, "refund": null, "error": null, "maintenanceNotice": null },
  "history": [1780000000000] }
```
`minutesSince.*` は「最後のその出来事から何分たったか」（`null` = 無い・知らない）。上から順に見て、最初に当たった理由で頼まない：
| 順 | `reason` | 条件 |
|---|---|---|
| 1 | `disabled` | `enabled: false` |
| 2 | `moment` | `moment` が `moments` に無い |
| 3 | `account_closing` | アカウント削除の予約中 |
| 4 | `ftue` | FTUE の途中（端末の `inFtue`、またはサーバーで無料10連がまだ） |
| 5 | `session` | このセッションで既に頼んだ（端末の旗、またはサーバーの最後の `sessionId` と同じ） |
| 6 | `maintenance` | メンテナンスのお知らせが今見えている（§46 の `visibleWindows`）、または `minutesSince.maintenanceNotice < quietMinutes.maintenanceNotice` |
| 7 | `refund` | コインの借り（`coinDebt`）がある、または `minutesSince.refund < quietMinutes.refund` |
| 8 | `purchase` | `minutesSince.purchase < quietMinutes.purchase` |
| 9 | `error` | `minutesSince.error < quietMinutes.error` |
| 10 | `loss` | `minutesSince.loss < quietMinutes.loss` |
| 11 | `too_new` | `⌊(now − installedAt) / 1日⌋ < minDaysSinceInstall` |
| 12 | `too_few_races` | `racesPlayed < minRacesPlayed` |
| 13 | `year_cap` | `history` のうち `now − at < 365日` の数 ≥ `maxPerYear` |
| 14 | `cool_down` | `history` の最新が `now − at < coolDownDays 日` |
どれにも当たらなければ頼む：`style` = `softAsk[platform]` が true なら `soft`（59.6 の前置きの質問）、でなければ `native`（`editor` は `ios` の値）。出力 `{ show, reason, style }`（頼まない時 `style: null`、頼む時 `reason: null`）。サーバー（TS）とクライアント（C#）は `contracts/review-prompt.vectors.json` で同じ答えになることを確かめる。

### 59.4 API（要認証、メンテナンスの区分 `core`）
| メソッド | パス | 本文 → 応答 |
|---|---|---|
| GET | `/v1/review-prompt` | → `{ v: 1, rules, history: { count365, lastAt }, serverSummary }`（端末の事前の判断用。状態を変えない） |
| POST | `/v1/review-prompt/check` | `Idempotency-Key` 必須。`{ moment, platform, sessionId, client: { inFtue, minutesSinceLoss, minutesSinceError, minutesSinceMaintenanceNotice } }` → `ReviewPromptCheck` |
| POST | `/v1/review-prompt/:promptId/answer` | `{ step: "soft_yes" \| "soft_no" \| "soft_dismiss" \| "native_requested" }` → `{ promptId, next: "store_review" \| "help_inquiry" \| "none", helpCategory: "other" \| null }` |
```json
{ "v": 1, "show": true, "style": "native", "reason": null, "promptId": "rp_3" }
```
- **check**：サーバーが自分の知っていること（インストール日・戦績・削除の予約・無料10連・最後の購入・返金とコインの借り・メンテナンスのお知らせ・頼んだ記録・最後の `sessionId`）と端末の言うこと（FTUE・負け・エラー・メンテナンスのお知らせを見てからの分）を合わせて 59.3 で決める。端末の FTUE とサーバーの FTUE は **どちらかが途中なら途中**（安全な側）。
- 頼むと決めた時だけ記録する：`history` に `{ id, at, moment, platform, style, sessionId, answer: null, nativeAt: null }`（最新 10 件、400 日より古いものは消す）と KPI `review_prompt_eligible`。**頼んだ時点で回数に数える**（端末が落ちても、OS が実際には出さなくても、繰り返し頼まないため）。同じ冪等キーの再送は同じ答え（記録も KPI も1回）。頼まない時は状態を変えない（理由を返すだけ）。
- **answer**：`soft_yes` → `next: store_review`（端末はそのまま標準の API を呼ぶ）、`soft_no` → `next: help_inquiry`・`helpCategory: other`（§48 のお問い合わせの画面を開く。ストアには送らない）、`soft_dismiss` → `none`。前置きの答えは1回だけ書く（同じ答えの再送はそのまま、違う答えは `409 CONFLICT`）。`native_requested` は `style: native` か、`soft_yes` の後だけ（それ以外 `409 NOT_ELIGIBLE`）。標準の API を呼んだ時刻 `nativeAt` を1回だけ書き、KPI `review_prompt_shown` を1回。知らない `promptId` は `404 NOT_FOUND`。
- 削除の予約中は check がいつも `account_closing` を返す。オフラインの端末は頼まない（サーバーの記録が無いと回数を守れないため）。
- 応答にもどこにも報酬の欄は無い（ウォレット・アイテム・ミッションを変えないことをテストで確かめる）。

### 59.5 端末（`IStoreReview`）
- `IStoreReview.RequestReviewAsync()` が OS の標準 API を呼ぶ（中身は Codex が SDK でつなぐ。iOS は `AppStore.requestReview(in:)`、Android は `ReviewManager.requestReviewFlow` → `launchReviewFlow`）。**結果は「呼んだ」だけ**：OS は出したかどうか・何点かを教えない（教えてもらおうとしない）。呼んだら `native_requested` を送る。
- `IStoreReview.Available` が false（エディター・未対応の端末）なら check を呼ばない。
- R20 統合（§58.11）：同じセッションで同意の事前の画面か通知の前置きが出ていたら頼まない（理由 `session_prompt`、check を呼ばない）。アカウントが変わったら（§54）セッションを新しくする（`ReviewPromptModel.ResetSession`）。
- 標準の API の外で「★を付けてください」の独自の画面は作らない（Apple 5.6.1）。ストアのページへのリンク（設定の「アプリを評価する」）は、プレイヤーが自分で押す時だけ（自動では出さない）。
- 端末の事前の判断（`ReviewPromptPolicy.Decide`）は GET の規則とサーバーの要約で同じ関数を回し、明らかに頼めない時はサーバーを呼ばない。最後に決めるのはサーバー。

### 59.6 前置きの質問（ソフト質問）とストアの決まり（決めたこと）
- 前置き：「ムチ一閃を楽しんでいますか？」［はい］［いまいち］（閉じる＝答えない）。はい → 標準の API。いまいち → 「ご意見をお聞かせください」でお問い合わせ（§48、`other`）を開く。
- **既定は OFF**（`softAsk.ios: false`・`softAsk.android: false`）。理由：
  - Google Play の In-App Review API のガイドラインは、評価のカードの前やその最中に「アプリを気に入っていますか？」のような意見を聞く質問をすることを禁じている → **`android: true` は検証で落ちる**（運用でも入れられない）。
  - Apple は前置きの質問そのものは禁じていないが、満足した人だけをストアに送る「振り分け（ゲーティング）」を嫌う（5.6.1 は独自のレビューの画面を禁止）。いまいちの人をストアに送らない形はゲーティングに当たりうる → iOS は運用で入れられるが、入れるのは法務とストアの担当の確認の後（docs/planning/03「レビュー依頼」）。
- 前置きを OFF にしても、いまいちの声の受け皿は今までどおりヘルプセンターのお問い合わせ（設定・ヘルプから）。

### 59.7 KPI（REQ-REV-012、すべてサーバー）
| イベント | いつ | 列 |
|---|---|---|
| `review_prompt_eligible` | check が頼むと決めた時（1回） | `s1` = moment、`s2` = platform、`s3` = style |
| `review_prompt_shown` | `native_requested` を受けた時（1回） | `s1` = moment、`s2` = platform、`s3` = style（soft の後なら `soft`） |
| `review_soft_answer` | 前置きの答え（1回） | `s1` = `yes` \| `not_really` \| `dismissed`、`s2` = moment、`s3` = platform |
クエリは `docs/ops/kpi-queries.md`「レビュー依頼」。星の数・レビューの本文は取れない（OS が返さない）。

### 59.8 状態・個人データ・削除
- 状態の `reviewPrompt`：`{ v: 1, history: [...], lastSessionId }`。§51 の個人データの開示では `analytics` の欄に入れる（`DEX_CLASSIFICATION.reviewPrompt = analytics`、頼んだ時刻・瞬間・前置きの答え）。
- アカウント削除の最後の `wipe` で消える。他に写しは無い。

### 59.9 文言・アクセシビリティ
- 前置きの文言は端末（`ui-en.json`・`proto-en.json`）に日本語と英語がある。サーバーは理由のコードだけを返す（文言は返さない）。
- 煽り・期限・「★5で」などの点数の誘導は書かない（「倍」「今だけ」「残りわずか」「お得」無し、テスト）。報酬を約束する言葉（「もらえる」「プレゼント」「報酬」）を書かない。
- 前置きのシートは文字の大きさ（§41 `TextScale`）に従う（最大でもはみ出さない、a11y-flow）。ボタンは2つとも同じ大きさ・同じ強さ（「はい」だけを目立たせない）。

### 59.10 クライアント
- `Muchi.Client`：`ReviewPromptRules`・`ReviewPromptSummary`・`ReviewPromptPolicy.Decide`（共有ベクター）、`IStoreReview`（`NullStoreReview` はエディター用）、`ApiClient.GetReviewPromptAsync`・`CheckReviewPromptAsync`・`AnswerReviewPromptAsync`、`ReviewPromptCheck`・`ReviewPromptStatus`。
- Unity のゲーム層 `ReviewPromptModel`：セッションの旗（1セッション1回）、負け・エラー・メンテナンスのお知らせの時刻を覚える、瞬間を受けて check → 前置き or 標準の API → answer。描画は `docs/handoff-codex-round20-review-prompt.md`。
- デプロイ：新しい GET 1つ・POST 2つと KPI 3種類、状態のキー1つ（マイグレーションなし、検証器は変わらない）。サーバーを先に出し、アプリは後（古いサーバーには 404 → 端末は頼まない）。

## 60. クライアントのエラー報告（client error & crash reporting、REQ-CERR-001〜020、`server/src/domain/clientErrors.ts`・`server/src/ops/clientErrors.ts`・`server/src/do/clientErrors.ts`、C# `ClientErrors.cs`（`ErrorReporter`・`ErrorScrubber`・`ErrorFingerprint`・`StallDetector`）・`Muchi.Game.ClientErrorModel`、共有ベクター `contracts/client-errors.vectors.json`、docs/handoff-codex-round20-client-errors.md）
外部の SDK を入れずに、端末で起きた問題を運営が見られるようにする小さな自前の経路。端末は**捕まえなかった例外・API の失敗（種類ごと）・ロックステップのズレ（チェックサムの不一致）・アセットのダウンロード失敗・長いフレーム／固まり（ANR に近いもの）**を小さな列にためて（オフラインでも保存）、種類ごとの抽出率で間引いて `POST /v1/client-errors` にまとめて送る。サーバーは**まとめた数（集計）**と少数の見本だけを、上限と保存期間のある表に持ち、運営の画面（ops console）に「多いエラー」を出す。コイン・アイテムは動かない（E番号なし）。KPI は増やさない（この経路そのものが計測）。Crashlytics などのネイティブのクラッシュ収集は後で Codex が足せる（§60.10）。

### 60.1 種類（`category`）と送る中身（REQ-CERR-002）
| category | いつ | 端末が送るキー（これ以外は 400） |
|---|---|---|
| `exception` | 捕まえなかった例外（Unity `Application.logMessageReceivedThreaded` の Exception／Assert、C# の未処理例外） | `type`（例外のクラス名）・`message`・`stack`・`handled`（bool）・`screen`（任意） |
| `api` | API の失敗（通信できない・タイムアウト・5xx・400/401/403/413/422）。業務のエラー（409 `INSUFFICIENT_COINS` など、404、429）は送らない | `method`・`route`（id を `:id` にした形）・`status`（0 = 応答なし）・`code`（任意）・`reason`（`network`・`timeout`・`http`） |
| `desync` | ロックステップのズレ（部屋からの `desync`、§4。エンジンが既に見つけている） | `raceId`・`tick`・`mode`・`engineLevel`（任意）。**入力（コマンド列）・チェックサム・状態は送らない**（キーがあれば 400） |
| `asset` | アセットのダウンロード失敗（§16） | `assetKey`・`reason`（`http`・`hash`・`disk`・`timeout`・`network`・`other`）・`status`（任意） |
| `stall` | 長いフレーム（既定 700 ms 以上）・固まり（5,000 ms 以上） | `kind`（`long_frame`・`anr`）・`durationMs`・`screen` |

どの項目にも `at`（端末の時刻 ms）・`count`（端末で同じ指紋をまとめた数、1〜10,000）・`sampleRate`（その時の抽出率‰、1〜1000）。

### 60.2 `POST /v1/client-errors`（REQ-CERR-003〜007）
```json
{ "batchId": "b_1f0c9a7e4d2b", "platform": "ios", "appVersion": "1.4.0", "osVersion": "iOS 18.1", "deviceModel": "iPhone15,2",
  "installId": "6c1f0b9e2a7d4c3b", "attachPlayer": true,
  "items": [ { "category": "exception", "at": 1793000000000, "count": 2, "sampleRate": 1000,
               "type": "NullReferenceException", "message": "Object reference not set to an instance of an object",
               "stack": "Muchi.Game.HudModel.Update () (at Assets/Muchi/Game/HudModel.cs:120)", "handled": false } ] }
```
- **認証は任意**：`Authorization` があり有効ならそのプレイヤーとして数える。無い・無効なら匿名（401 にはしない：報告がサインインの失敗で回り続けないため）。
- **門（§46）**：メンテナンスの窓・アップデート必須でも**閉じない**（`EXEMPT_ROUTES`）。古い版のクラッシュこそ見たい。KPI の送信と同じ扱い。
- **何度送っても同じ**：`installId` + `batchId` を 48 時間覚える。同じ組がもう一度来たら何も足さず `{ "accepted": 0, "duplicate": true, … }`（端末は送れたものとして列から消す）。端末は列の束ごとに `batchId` を1回作り、再送でも同じ id を使う。
- **大きさの上限**：本文 `maxBodyBytes`（既定 32 KB、超えたら 413）、項目 `maxItems`（既定 20）、`message` 300 字、`stack` 4,000 字・40 行、そのほかの文字列は表のとおり短い。
- **回数の制限**：プレイヤーごと（認証あり）に `perPlayerPerHour`（既定 20 束）、端末（`installId`）ごとに `perDevicePerHour`（既定 20 束）、匿名の束は全体で `anonymousPerMinute`（既定 120）。超えたら 429 `RATE_LIMITED`（端末は列を残して待つ）。
- **設定で止める**：`enabled: false` なら何も保存せず `{ "accepted": 0, "enabled": false }`（200。端末はその起動の間は送らない）。保存先が無い環境（ローカルの最小構成）も同じ。
- 応答：`{ "accepted": 3, "dropped": 0, "duplicate": false, "enabled": true, "sampling": { "exception": 1000, "api": 200, "desync": 1000, "asset": 500, "stall": 100 }, "flushIntervalSec": 60 }`。`sampling` は端末が次から使う抽出率。`GET /v1/config` にも同じ `clientErrors: { enabled, sampling, flushIntervalSec }` を載せる。

### 60.3 個人情報を落とす（スクラブ、REQ-CERR-008）
端末で落とし、**サーバーでも同じ規則でもう一度落とす**（端末を信じない）。TS と C# は共有ベクター `contracts/client-errors.vectors.json` で同じ結果。
1. メールアドレス → `<email>`、`Bearer …`・JWT（`eyJ….….…`）→ `<token>`、URL → `<url>`。
2. ファイルのパスはファイル名だけ（`/Users/alice/proj/Assets/Muchi/Game/HudModel.cs:120` → `HudModel.cs:120`、`C:\Users\…\x.cs` も同じ）。
3. 引用符の中（`"…"`・`'…'`・`「…」`）は自由な文やプレイヤーが付けた名前なので `"…"` に置き換える。
4. ASCII 以外の文字の並び（日本語の文・名前）は `…` に置き換える。
5. 長い id・トークンらしい並び（数字を含む 20 字以上の英数字、12 字以上の16進）→ `<id>`、共有リンクのトークン（§63 の字（`2-9a-hjkmnp-z`）の 22 字ちょうど。数字を含まないこともあるので別の規則、R21 統合）→ `<token>`、`p_…`・`h_…` のような id → `<id>`、5 桁以上の数字 → `<n>`。
6. 空白をまとめ、上限の長さで切る。
**送ってよいもの**：端末の機種（`deviceModel`）と OS の版（`osVersion`、英数字と ` ,._()-` の 40 字まで。ほかの文字は `other`）、アプリの版、プラットフォーム。**送らないもの**：メール・トークン・プレイヤー名・馬の名前・自由な文・入力の列・位置・広告 id。`installId` はアプリが最初の起動で作る乱数（端末の識別子・広告 id から作らない）で、回数の制限と重複の判定にだけ使い、見本には残さない。

### 60.4 指紋（`fingerprint`、REQ-CERR-009）
同じ原因のエラーを1行にまとめる鍵。**サーバーが**スクラブした中身から計算する（端末も同じ計算で列の中をまとめる）。FNV-1a 64 bit（UTF-8）の16進16字。元の文字列：
- `exception|<type>|<message の型>|<上から5つのフレーム>`：message の型 = スクラブ後の数字を `#` に。フレーム = スタックの各行からアドレス（`[0x…]`・`<…>`）と行番号（`:120`）を消したもの。行番号は入れない（小さな修正で指紋が変わらないように）。
- `api|<METHOD>|<route>|<status>|<code または ->`：`route` の id らしい部分（数字を含む 6 字以上・`x_…` の形・共有リンクのトークン（§63、R21 統合））は `:id`。
- `desync|<mode>`（ズレはモードごとに1行。どのレースかは見本で見る）。
- `asset|<reason>|<assetKey の先頭2段>`、`stall|<kind>|<screen>`。

### 60.5 保存（集計と見本、上限と保存期間、REQ-CERR-010〜012）
保存先は専用の Durable Object `ClientErrorsDO`（シングルトン `global`、SQLite、**wrangler の移行 v7**）。プレイヤーの状態（PlayerState）には何も足さない（§51 の分類に新しいキーは無い）。
- `groups`：指紋ごとに1行 — category・題（例外の型と message の型／route と status など）・合計の数・推定の数（`count × 1000 / sampleRate` の合計）・最初と最後の時刻・最初と最後のアプリの版・版ごとの数（多い順に 20 まで）・プラットフォームごとの数・通知の記録。上限 `maxGroups`（既定 2,000）。超えた新しい指紋は category ごとの `overflow:<category>` の行に足す。
- `days`：指紋 × 日（UTC）× アプリの版 × プラットフォームの数。
- `samples`：指紋ごとに新しい `samplesPerGroup`（既定 5）件だけ — 時刻・版・機種・OS・スクラブ済みの message／stack・種類ごとの中身（desync なら `raceId`・`tick`・`mode`）・**`playerId`（認証あり かつ `attachPlayer: true` の時だけ、そうでなければ null）**。
- `retentionDays`（既定 30）を過ぎた日の行・見本と、最後に見てから過ぎた指紋の行は、受け付けるたびに少しずつ消す。重複の判定は 48 時間、回数の行は 1 時間で消える。

### 60.6 同意のフック（REQ-CERR-013）
端末の `ErrorReporter.AllowsDiagnostics`（`Func<bool>`、既定 `true`）が false の時は `attachPlayer: false` で送る（サーバーは playerId を残さない。報告そのものは匿名で届く）。`attachPlayer` は束ごとの値で、過去に送った見本は変えない。
- **R20 統合で決めたこと（§58.10）**：このフックの同意は §58 の **分析（`analytics`）** の選択。端末は `ErrorReporter.FollowConsent(() => ConsentState)` で `ConsentState.AllowsDiagnostics`（= `analytics.effective`）を束ごとに読む。**サーバーも同じ規則を守る**：認証された束で `attachPlayer: true` でも、そのプレイヤーの `analytics.effective` が true でなければ playerId を残さない（`POST /v1/client-errors` が PlayerDO のビューを読む。読めない時も残さない＝閉じる側に倒す）。古いアプリ・選択を変える前に作った束でも id は付かない。報告と回数の制限（端末ごと）はそのまま。
- **アカウントが変わった時（§54、R20 統合）**：`401 SESSION_REPLACED`・引き継ぎコードの入力・サインアウト（新しく始める）の時、端末は `ErrorReporter.AccountChanged()` を呼ぶ。まだ返事の無い束は同じ id のまま `attachPlayer: false` になり、それまでに溜めた項目は自分たちだけの束で `attachPlayer: false` で送る（再起動しても続く）。古いアカウントのエラーが新しいアカウントの id で残ることは無い。

### 60.7 運営の画面（ops console、`/v1/admin/client-errors`、REQ-CERR-014〜016）
- `GET /v1/admin/client-errors?category=&platform=&appVersion=&sort=count|last|new&limit=`（viewer）：`{ groups: [ { fingerprint, category, title, count, estimated, firstSeen, lastSeen, firstVersion, lastVersion, versions: [{ appVersion, count }], platforms: { ios, android, editor }, alert } ], alerts: [ … 直近の通知 ], totals: { groups, byCategory } }`。`sort=count`（既定）は数の多い順、`last` は最後に見た順、`new` は最初に見た順。
- `GET /v1/admin/client-errors/:fingerprint`（viewer）：その行・直近 14 日の `days`・見本。`desync` の見本には `race: { raceId, tick, replay: "/v1/admin/replays/<raceId>", integrity: { status, events } | null }`（`integrity` は見本に playerId がある時だけ、§47.7 と同じ不正対策の記録＝検証の結果）。ズレは公平さに関わるので、画面は desync を一番上の絞り込みに出す。
- 読むだけ（書き込みの操作は無い）。プレイヤーの API からはこの表を読めない。

### 60.8 通知のフック（新しい指紋の急増、REQ-CERR-017）
最初に見てから `spikeWindowHours`（既定 24）時間以内の指紋の推定の数が `spikeMinCount`（既定 50）に届いた時、その指紋に1回だけ `alert: { at, appVersion, estimated }` を記録し、構造化ログ `{"alert":"client_error_spike","fingerprint":…,"category":…,"appVersion":…,"estimated":…,"title":…}` を `console.warn` に出す（Workers Logs／Logpush の通知の規則でつかまえる。docs/ops/console.md「クライアントのエラー」）。リリース直後に新しく出たエラーが増えた時に気づくため。外への通知（Slack など）は Logpush の規則側で行い、サーバーは外へ送らない。

### 60.9 アカウント削除・開示（REQ-CERR-018〜019）
- 削除の手順に `client_errors` の段（`inquiries` の後、`data_export` の前）。見本の `playerId` が削除した人のものは **null に置き換える**（匿名化。エラーそのものは運営のデータとして残す）。回数の行（`p:<playerId>`）は消す。集計の行（groups・days）にはもともとプレイヤーが入らない。
- §51 の開示では `analytics.clientErrors`（そのプレイヤーの id が付いた見本：時刻・category・題・版・プラットフォーム・機種・OS）を出す。読めない時は `available: false`。

### 60.10 設定（`progression.clientErrors`、起動時とリモート設定で検査、REQ-CERR-001）
`{ "enabled": true, "sampling": { "exception": 1000, "api": 200, "desync": 1000, "asset": 500, "stall": 100 }, "maxItems": 20, "maxBodyBytes": 32768, "perPlayerPerHour": 20, "perDevicePerHour": 20, "anonymousPerMinute": 120, "flushIntervalSec": 60, "maxGroups": 2000, "samplesPerGroup": 5, "retentionDays": 30, "spikeMinCount": 50, "spikeWindowHours": 24 }`。範囲：`sampling` の各値は 0〜1000 の整数（‰）で 5 種類すべて必要、**`desync` は 1000 のみ**（公平さのため間引かない）、`maxItems` 1〜50、`maxBodyBytes` 4096〜65536、`perPlayerPerHour`・`perDevicePerHour` 1〜600、`anonymousPerMinute` 1〜6000、`flushIntervalSec` 10〜3600、`maxGroups` 100〜20000、`samplesPerGroup` 1〜20、`retentionDays` 7〜90、`spikeMinCount` 1〜100000、`spikeWindowHours` 1〜168。知らないキーは問題。無ければこの既定値。

### 60.11 クライアント（REQ-CERR-020）
- `Muchi.Client`：`ClientErrorCategories`・`ClientErrorItem`（`Exception`・`Api`・`Desync`・`Asset`・`Stall`）・`ErrorScrubber`・`ErrorFingerprint`・`ClientErrorSampling`・`IClientErrorStore`・`ClientErrorOptions`・`ErrorReporter`（指紋で列の中をまとめる・抽出・オフラインで保存・束ごとの `batchId`・待ち時間を延ばす再送・429 で待つ・400 は捨てる・`enabled: false` で止まる・自分の送信の失敗は報告しない）・`StallDetector`・`ApiClient.SendClientErrorsAsync`・`ApiClient.RequestFailed`（API の失敗のイベント）・`LockstepClient.Desync`（ズレのイベント、`RaceId`）。
- `Muchi.Game`：`ClientErrorModel`（Unity のログ・フレーム・API・ズレ・アセットをつなぐ。報告の中で起きた例外を報告しない）。Unity での取り付け（`Application.logMessageReceivedThreaded`・`OnApplicationPause`）は docs/handoff-codex-round20-client-errors.md。
- ネイティブのクラッシュ（Crashlytics）：後で Codex が足すなら、同じ `AllowsDiagnostics` で止め、プレイヤー名・自由な文を送らない（§60.3）。この経路とは別に動く。

## 61. 端末のローカル通知（on-device local notifications、REQ-LNOTIF-001〜020、`server/src/domain/localNotify.ts`、C# `LocalNotifications.cs`（`LocalNotificationPlanner`・`ILocalNotificationPlatform`）・`Muchi.Game.LocalNotificationModel`、共有ベクター `contracts/local-notifications.vectors.json`、docs/handoff-codex-round20-local-notifications.md）
端末が**もう知っている時刻**（調教のセッションの期限・次のゲーム日・週替わりチャレンジ／ライバルの週／交換所の締め・プレゼントの受け取り期限）を、サーバーを待たずに**端末の中で予約する通知**。サーバーのプッシュ（REQ-PUSH-*、§3.5 の表・push.json）はそのまま。ローカル通知は**プッシュと同じ種類（カテゴリ）と静かな時間帯**に従い、設定画面の「通知」1か所で両方を切り替える。何を予約するかはスナップショットからの**純粋な関数**（`planLocalNotifications`、TS と C# は共有ベクターで同じ結果）。コイン・アイテムは動かない（経済の目標なし、E 番号・balance-targets の節なし）。購入・ショップ・ガチャへ誘う通知は作らない。

### 61.1 種類と持ち主（REQ-LNOTIF-001/002）
同じ出来事をプッシュとローカルの両方で知らせない。出来事ごとに**持ち主を1つ**に決める（コードの表 `LNOTIF_OWNERSHIP`。push.json のテンプレートは全部 `server`、テストで全テンプレートが表にあることを確かめる＝新しいテンプレートを足す時に持ち主を決めないと落ちる）。
| ローカルの種類 `kind` | 出来事 | 種類（カテゴリ） | 予約する時刻 | 条件（スナップショットから） | 開く画面 |
|---|---|---|---|---|---|
| `training_session` | 始めた調教（§25）の仕上げの期限 | `reminders` | `expiresAt − trainingLeadMin` 分 | 開いたセッションがある。静かな時間帯なら**送らない**（遅れて届く意味がない） | `training` |
| `daily_bonus` | 次のゲーム日（既定 4:00 JST 切り替え）のログインボーナス | `reminders` | 次のゲーム日の `dailyHourJst` 時（既定 12 時 JST） | ログインボーナスが解放済み。**1日1回まで**・予約は次の1日分だけ（何日も開かなくても1回しか届かない） | `home` |
| `weekly_challenge_closing` | 週替わりチャレンジ（§31）の週の終わり | `events` | `endsAt − leadHours` | 解放済みで、今週の未クリアがある | `weekly_challenge` |
| `rival_week_closing` | ライバル（§28）の週の終わり | `friends` | `weekEndsAt − leadHours` | 今週のライバルがいて、今週のランク戦がまだ0回 | `rival` |
| `exchange_closing` | イベント交換所（§30）が閉まる | `events` | `closesAt − leadHours`（イベントごとに1つ） | ポイントが残っている。文言は「残ったポイントは素材になります」（§30、失われない） | `event_exchange` |
| `gift_expiring` | プレゼント（§26）の受け取り期限 | `gifts` | 一番早い `expiresAt − leadHours` | 期限のある未受け取りの品がある。**開くだけ**（通知から受け取らない） | `gift_box` |
| `calendar_mark`（R21 統合） | 予定表（§65）で印を付けた行の**始まり** | `reminders`（自分で付けた印なので呼び戻しと同じ種類、既定オフ） | `startAt − leadHours.calendar_mark`（既定 2 時間） | 印があり、まだ始まっていない（始まった行・印を外した行・`until` を過ぎた行は予約しない）。名前は文言に入れない（「印を付けた予定が{date}に始まります」） | `calendar` |

- 持ち主が `server` の出来事（ローカルでは作らない）：push.json の全テンプレート（フレンド・支部・招待・シーズン開幕／終了・昇級まであと1勝・イベント開始・大会の締切／まもなく・TA記録・ライバルの記録・おかえり（`comeback`）・プレゼントが届いた（`gift_arrived`））。今の6つのローカルの種類と同じ出来事を送るテンプレートは無い。今後サーバーが同じ出来事を送るなら、ローカルの種類の方を外す。
- 呼び戻しの通知（「調教ができます」「ログインボーナス」）は 06 §3.5 のとおり**新しい種類と同意**が要る：新しい種類 **`reminders`**（「リマインダー」、**既定オフ**、push.json `defaults.categories.reminders: false`）。サーバーはこの種類のプッシュを送らない（テンプレートが無い、テストで確かめる）。受け取るには 61.4 の前置きで本人が選ぶ。
- 期限の知らせ（週替わりチャレンジ・ライバル・交換所・プレゼント）は**データの本当の期限**だけ。作った時計・カウントダウン・「今だけ」「残りわずか」「お得」などは無い。購入・ショップ・ガチャ・パスの購入へ誘う種類は無い（開く画面はコードで固定、設定で変えられない）。厩舎手当（§13.5）の受け取りはショップの画面にあるので知らせない。

### 61.2 スナップショットと計画（`planLocalNotifications`、REQ-LNOTIF-003〜007）
入力（端末が持っているものだけ）：`now`・`locale`（端末の言語 `ja`|`en`）・`permission`（`unknown`|`granted`|`provisional`|`denied`）・`showDetails`（ロック画面に詳しく出す、端末の設定、既定オフ）・`signedIn`・`digest`（61.3、サーバーのブートストラップ）・`horseNames`（端末の馬の名前、`showDetails` の時だけ使う）。
1. `signedIn: false`・`digest.enabled: false`・削除の予約中・オンボーディング中 → 何も予約しない（`status` = `signed_out`／`off`）。`permission` が `unknown`／`denied` でも計画は作る（設定画面に「次の予定」を見せる）が、予約は `granted`／`provisional` の時だけ（`status` = `no_permission`）。
2. 61.1 の条件から候補を作る。種類の**カテゴリがオフ**なら外す（`category_off`）。設定 `kinds` に無い種類も外す。
3. 時刻が `now` 以前なら外す（`past`。アプリを開いている間に期限の前の時刻が過ぎたら、もう知らせない）。`now + horizonDays` より後も外す（`horizon`）。
4. **静かな時間帯**（プッシュと同じ JST の `quietHours`）：`training_session` は外す。`daily_bonus` は静かな時間帯の終わりへ遅らせる（次のゲーム日を越えるなら外す）。期限の種類は終わりへ遅らせ、それが期限の1時間前を過ぎるなら外す（`quiet_hours`）。
5. **1日の上限** `dailyCap`（既定2、プッシュの上限とは別に数える）：予約する時刻のゲーム日ごとに、優先の高い順（`training_session` > `gift_expiring` > `exchange_closing` > `weekly_challenge_closing` > `rival_week_closing` > `calendar_mark` > `daily_bonus`、同じなら早い時刻）に残す（`daily_cap`）。全体で `maxPending` 件まで（早い順、iOS の上限 64 より十分小さい）。
6. 出力 `items[]`：`id`（`lnotif.{kind}.{ref}`、出来事ごとに変わらない。ref = セッションID／ゲーム日／`endsAt`／イベントID／一番早い期限）・`kind`・`category`・`fireAt`・`screen`・`refId`・`title`・`body`。並びは時刻の順。外したものは `dropped[]`（`kind`・`reason`）。
- **文言**（日本語・英語、端末の言語で選ぶ。両方の言語を planner が持つ）：時刻は JST で「11月16日 4:00」／“11/16 at 4:00”。プレイヤーが付けた名前（馬・支部・相手）は**既定で文言に入れない**（ロック画面の覗き見）。`showDetails: true` の時だけ件数・ポイント・調教の馬の名前を入れる（名前は訳さない）。共通の賭けの言葉（`bettingWords.ts`）と煽りの言葉を使わない（テストで全部の文言を確かめる）。

### 61.3 サーバーの digest（`localRemindersView`、REQ-LNOTIF-008）
`/v1/player/bootstrap`・`GET /v1/player` の **`localReminders`**（読むだけ、状態に書かない。§45 の `nextActionSummary` と同じ読み方）。新しいエンドポイント・新しい状態のキーは無い。
```json
{ "v": 1, "enabled": true, "now": 1794880800000, "nextDayAt": 1794891600000, "nextDay": "2026-11-12",
  "config": { "kinds": ["training_session","daily_bonus","weekly_challenge_closing","rival_week_closing","exchange_closing","gift_expiring"],
              "dailyCap": 2, "dailyHourJst": 12, "horizonDays": 7, "maxPending": 8, "trainingLeadMin": 3,
              "leadHours": { "weekly_challenge_closing": 24, "rival_week_closing": 24, "exchange_closing": 24, "gift_expiring": 24, "calendar_mark": 2 },
              "prePrompt": { "maxAsks": 2, "retryDays": 14 } },
  "categories": { "season": true, "friends": true, "invites": true, "events": true, "comeback": false, "gifts": true, "reminders": false },
  "quietHours": { "startHour": 22, "endHour": 8 },
  "deleting": false, "onboarding": false,
  "loginBonus": { "unlocked": true },
  "training": { "sessionId": "t1", "horseId": "h1", "expiresAt": 1794881400000, "trainedEver": true },
  "weeklyChallenge": { "unlocked": true, "endsAt": 1795136400000, "uncleared": 2 },
  "rival": { "weekEndsAt": 1795136400000, "rankedRaces": 0 },
  "exchanges": [ { "eventId": "ev_autumn", "points": 120, "closesAt": 1795050000000 } ],
  "gifts": [ 1795000000000, 1795003600000 ] }
```
- R21 統合：`calendarMarks`（`[{ id, startAt }]`）＝予定表（§65）の印のうち、まだ始まっていない行（始まりの早い順、30件まで）。R21 統合の前に付けた印は始まりを持たないので入らない。
- `training` は開いたセッションが無ければ `{ sessionId: null, horseId: null, expiresAt: null, trainedEver }`（`trainedEver` = これまでに調教をしたか、61.4 の前置きのきっかけ）。`weeklyChallenge`・`rival` は無ければ `null`。`gifts` は期限のある未受け取りの品の `expiresAt`（早い順、20件まで）。
- `enabled: false`（設定なし・無効）の時は `{ "v": 1, "enabled": false }` だけ。

### 61.4 OS の許可と前置き（REQ-LNOTIF-009/010）
- 初回起動では聞かない。**最初の調教を始めた後**（`POST /v1/training/start` が通った後、または `training.trainedEver`）に、`reminders` がオフで、前置きをまだ `maxAsks` 回出しておらず、前回から `retryDays` 日たっている時だけ、前置きのシートを1回出す：「調教の仕上げや、ログインボーナスを受け取れる日を、この端末からお知らせします。1日{n}件まで・静かな時間帯は送りません。あとから設定で変えられます」。最初からチェックの入った選択は無い。
- `PUT /v1/push/preferences` の `categories` は `season`・`friends`・`invites`・`events`・`comeback`・`gifts`・`reminders` の7つ（`PUSH_CATEGORIES` から作る。R20 統合：知らない種類は今までの「黙って捨てる」ではなく `400 BAD_REQUEST`。古いアプリは知っている種類だけ送るので影響しない）。
- 「お知らせを受け取る」→ `PUT /v1/push/preferences { categories: { reminders: true } }`、OS の許可が `unknown` なら OS のダイアログ（結果を KPI `lnotif_permission`）。「今はしない」→ 何も変えない（KPI `later`）。
- OS で**拒否**（`denied`）なら OS のダイアログは二度と出さない。設定画面に「端末の設定で通知がオフになっています」と OS の設定を開くボタン。**仮の許可**（iOS provisional）は予約する（通知センターに静かに届く）。
- 既存のプッシュの前置き（REQ-UXU-015、2戦目の3着以内）で OS が許可済みなら、前置きは `reminders` を選ぶだけ（OS のダイアログは出ない）。
- R20 統合（§58.11）：同じセッションで §58 の事前の画面（ATT）か §59 のレビューが出ていたら、前置きは出さない（次のセッションの調教の後）。

### 61.5 予約の付け替え（REQ-LNOTIF-011/012）
- 端末は前回予約した `id → 指紋`（時刻・文言）を覚え、計画との差だけを取り消し・予約する（`LocalNotificationPlanner.Diff`）。起動・前面に戻った時・調教の開始／仕上げ・ログインボーナス・チャレンジのクリア・ランク戦の後・交換・プレゼントの受け取り・設定の変更で計画し直す（早く仕上げた調教の通知は消える）。
- **ログアウト・アカウントの切り替え・引き継ぎ・アカウント削除（予約・実行）**：このアプリが予約したローカル通知を**全部取り消し**、覚えた予約を消す（別の人の予定が残らない）。覚えた予約にはアカウントIDを付け、違うアカウントのものは使わない。
- 通知を開いたら `screen` の画面へ（ショップは無い）。開いた時に計画し直す。

### 61.6 KPI（REQ-LNOTIF-013）
- `lnotif_scheduled`（クライアント、`props: { kind }`。その `id` を新しく予約した時だけ。時刻の付け替えでは送らない）→ `s1` = kind。
- `lnotif_opened`（クライアント、`props: { kind }`。通知から開いた時）→ `s1` = kind。
- `lnotif_permission`（クライアント、`props: { result: granted | provisional | denied | later }`）→ `s1` = result。
クエリは `docs/ops/kpi-queries.md`「端末のローカル通知」。

### 61.7 設定 `progression.localNotifications`（リモート設定で変更可、`localNotificationsProblems` で検証）
`{ enabled, kinds[], dailyCap (1..4), dailyHourJst (8..21), horizonDays (1..14), maxPending (1..32), trainingLeadMin (1..9、§25 の sessionTtlMs より短い), leadHours { 種類: 1..72 }, prePrompt { maxAsks (1..3), retryDays (1..90) } }`。`kinds` は 61.1 の6つのうち（重複不可）。`leadHours` は期限の4種類だけ。`enabled: false` で端末は全部取り消す（停止スイッチ）。

### 61.8 クライアント（REQ-LNOTIF-014〜016）
- `Muchi.Client`：`LocalRemindersDigest.Parse`（`PlayerView.LocalReminders`）、`LocalNotificationSnapshot`、`LocalNotificationPlanner.Plan(snapshot)`・`Diff(previous, planned)`・`KindCategory`、`ILocalNotificationPlatform`（`Permission`・`RequestPermissionAsync`・`Schedule`・`Cancel`・`CancelAll`）、`PushPreferences.Reminders`、`AnalyticsEvent.LocalNotificationScheduled/Opened/Permission`。
- Unity のゲーム層 `LocalNotificationModel`：計画と付け替え、アカウントの切り替え・ログアウト・削除での全取り消し、前置きの判断と回数、設定画面の「端末のリマインダー」の行（種類ごとのオン／オフ＝カテゴリ、ロック画面に詳しく出す、OS の許可の状態）、次の予定の一覧、開いた時の画面、KPI。OS の通知パッケージ（Unity Mobile Notifications）への接続は Codex（`docs/handoff-codex-round20-local-notifications.md`）。
- プロトタイプ：設定の「通知」（プッシュの種類・静かな時間帯・端末のリマインダー・ロック画面の表示）、前置きのシート、次の予定の一覧（デモ）。日本語・英語・文字の大きさ（§41）。
- ヒント（§57、R20 統合）：調教が開くと読めるカード `training_reminder`（「仕上げを知らせる」）がヘルプの `local_reminders` へつなぐ。広告と分析・エラーの自動送信の記事（`ads_analytics_privacy`）は合うヒントの話題が無いので、設定 › プライバシーの「？」からだけ開く。

### 61.9 法務・プライバシー（REQ-LNOTIF-017/018）
- 煽りの言葉・作った期限・購入への誘いは無い（61.1）。賭けの言葉は共通の一覧でテスト。
- ロック画面に出す文言にプレイヤーが付けた名前を既定で入れない（`showDetails` 既定オフ、端末ごとの設定でサーバーに送らない）。
- ローカル通知は端末の中だけで作られ、サーバーに予定を送らない（KPI の種類だけ）。データの開示（§51）に新しい項目は無い（状態のキーを足さない。`reminders` は既存の `push.prefs` の中）。

### 61.10 アカウント削除
サーバーに新しい状態は無い（`push.prefs.categories.reminders` は既存の `push` と一緒に消える）。端末は削除の予約・実行を見たら全部取り消す（61.5）。

## 62. プロフィールのショーケース（トレーナーカード、REQ-SHOW-001〜018、`server/src/domain/showcase.ts`・`server/master/showcase.json`、C# `Showcase.cs`（`ShowcaseCard`・`ShowcaseEditor`・`ShowcaseSelection`・`ShowcaseShare`）・`Muchi.Game.ShowcaseCardModel`／`ShowcaseEditorModel`、docs/handoff-codex-round21-profile-showcase.md）
公開プロフィール（REQ-SOCIAL-004：名前・称号・クラス・レート・戦績の要約・最終ログイン）に**トレーナーカード**を足す。カードには愛馬・自分で手に入れたもののピン留め・ベスト記録・決まった文の一言・実績で解放した背景を飾れる。**何も配らず、何も売らない**（E 番号なし、balance-targets の節なし。背景・ピン留めは見た目だけで、能力・レース・ランク戦の勝率に影響しない）。設定は `master/showcase.json`（リモート設定 `showcase` で置き換え可、`showcaseProblems` で検証。`config.enabled: false` なら機能ごと無し：API は `404 NOT_FOUND`、公開プロフィールにカードは載らない）。

### 62.1 カードの中身（REQ-SHOW-001）
| 欄 | 中身 | 出せる条件 |
|---|---|---|
| 愛馬 | 自分の馬 1 頭（名前・レア度・性別・見た目 §17、勝負服 §35 はプロフィールの `silks`） | 持っていて現役（`status: active`）で、種牡馬として**貸し出し中でない**（§44 厩舎の整理の `on_loan` と同じ：種付けの募集中・予約中）。引退・貸し出し・手元から消えた馬は外れる |
| ピン留め | 最大 `pinsMax`（3）つ。種類 `title`（称号 §24）・`achievement`（実績 §24、到達した一番上の段）・`cup_trophy`（主催カップのトロフィー §42、終わったカップの結果に `trophy` があるもの）・`hall`（殿堂入りの馬 §34）・`goal_ribbon`（目標をすべて達成した馬 §53）・`tournament`（大会の 1〜3 位） | 自分の状態に今あるもの（`resolvePin`）。称号の取り消し・カードの結果の整理などで無くなれば外れる |
| ベスト記録 | タイムアタックの全期間ベストを選んだコースごとに最大 `taMax`（2）つ（コース名・タイム・その時の馬の名前）、と**今シーズンのランク戦のクラス**（今シーズンにランク戦を 1 回以上走った時だけ。自動） | 記録があるコース（`timeAttack.allTimeBest`）。マスターから消えたコースは外れる |
| 一言 | `phrases` の決まった文 1 つ（日本語と英語の組。§52 の定型チャットと同じく自由入力なし・スロットなし） | 一覧にある id |
| 背景 | `backgrounds` の 1 つ。`unlock` は `default`（1 つだけ）か `achievement`（実績の段）。**購入で解放するものは無い**（検証で拒否） | 解放済み。解放されていない・消えた背景は既定の背景になる |

### 62.2 保存と検証（REQ-SHOW-003/004）
- `PUT /v1/showcase` は本文の id をプレイヤーの状態と照らし、**全部が今持っている／手に入れたもの**の時だけ保存する（置き換えなので冪等。キー不要）。持っていない馬 `404 HORSE_NOT_FOUND`、引退した馬 `409 HORSE_NOT_ACTIVE`、貸し出し中の馬・手に入れていないピン・記録の無いコース・解放されていない背景 `409 NOT_ELIGIBLE`、無いコース・一言・背景 `404 NOT_FOUND`、上限超え・重複 `400 BAD_REQUEST`、停止中のアカウント `403 BANNED`、削除の予約中 `409 DELETION_PENDING`。拒否された保存は何も残さない。
- 同じ選択をもう一度送っても何も変わらない（`updatedAt` も KPI も変わらない）。
- 本文は `{ horseId: string|null, pins: [{kind, id}] (≤3), taTrackIds: string[] (≤3), phraseId: string|null, backgroundId: string }`（strict。文字を書く欄は無い）。

### 62.3 公開の写しと、読むときの再確認（REQ-SHOW-005〜007）
- 他のプレイヤーが見るのは、状態から作る**言語によらない写し** `ShowcaseCopy`（id・数・プレイヤーが付けた名前だけ）で、公開プロフィールの `showcase` としてディレクトリに送る（REQ-SOCIAL-004 の送り方そのまま。新しい DO・表は無い）。写しはプレイヤーの**取引ごとに作り直し**、公開プロフィールの変更の判定（`profileKey`）に入れるので、引退・手放した馬・取り消された称号・整理されたカップの結果は（貸し出し中の馬も）次の送信で**黙って外れる**（選択そのものは残り、取り戻せばまた出る）。
- 停止中のアカウント・削除の予約中／実行中は写しを作らない（`showcase` なし）。
- `GET /v1/showcase/:playerId` はディレクトリの写しを読み（相手の状態は見ない。ブロックの一覧だけ相手から読む、厩舎の訪問 REQ-STABLE と同じ）、**今のマスターでもう一度確かめる**：消えた称号・実績・コース・一言は外れ、消えた背景は既定の背景になる。文言は**見る人の言語**で返す（一言と背景の名前は組から選んで返す＝境界で訳さない `phraseText`・`backgroundName`、他の文言は §23 の境界で訳す。プレイヤーが付けた名前 `displayName`・`horseName`・`cupName` は訳さない）。
- 自分のカード（`:playerId` = 自分）は自分の状態から作る（保存前は既定の背景・ピン留めなしで基本の欄だけ）。
- フレンドの一覧（`GET /v1/friends`）はカードを運ばない（`showcase` を落とす）。カードは開いた時に 1 枚ずつ読む。

### 62.4 プライバシー（REQ-SHOW-009〜012）
- **ブロック**（§47.1 の 1 つの一覧）：見る人が相手をブロックしている・相手が見る人をブロックしている、どちらでも**空のカード**（`state: "neutral"`）。空のカードは中立の名前（「プレイヤー」／"Player"、REQ-ACT-012 と同じ）と既定の背景だけで、称号・クラス・戦績・愛馬・ピン・一言・記録・通報・共有は無い。どちらがブロックしたか・削除か停止かは区別できない。
- **削除・停止**：公開プロフィールが無い（削除済み・知らない id）・`banned` のプロフィールも同じ空のカード（エラーにしない）。
- **13 歳未満**（登録した年齢が `minAgeFreeText` 未満）：写しに**表示名以外のプレイヤーが付けた文字を入れない**（愛馬・殿堂・目標のリボン・タイムアタックの馬の名前、カップの名前は `null`。カードは「愛馬」「殿堂入りの馬」「プレイヤー主催カップ」などの決まった名前を出す）。一言は決まった文なのでそのまま。`young: true`。
- **通報**（§47）：他の人のカード（空でない）に通報の入口（`reportable: true`、`source: profile`）。内容は `display_name`・`player`、愛馬の名前を出している時だけ `horse_name`（`reportableHorseId`）。新しい通報の種類は足さない。

### 62.5 API（要認証、ゲートのグループ `social`）
| メソッド | パス | 本文 → 応答 |
|---|---|---|
| GET | `/v1/showcase` | → `ShowcaseEditor`（自分の選択・選べるもの・プレビュー） |
| PUT | `/v1/showcase` | 62.2 の本文 → `ShowcaseEditor` |
| GET | `/v1/showcase/:playerId` | → `ShowcaseCard` |
```json
{ "playerId": "a", "state": "ok", "displayName": "はやて", "titleId": "debut", "titleName": "デビュー", "classId": "C", "rating": 1500,
  "stats": { "races": 12, "wins": 3, "top3": 0 }, "lastSeenAt": 1794366000000, "silks": { "pattern": "cross_sashes", "colors": ["green", "blue"], "cap": "star" },
  "background": { "id": "turf_stretch", "key": "showcase/bg/turf_stretch", "backgroundName": "芝の直線" },
  "phrase": { "id": "race_anytime", "phraseText": "いつでもレースしよう！" },
  "horse": { "horseId": "h1", "horseName": "ミドリノカゼ", "rarity": "SR", "sex": "male", "appearance": { "coat": "chestnut", "face": "blaze", "legs": ["none", "none", "sock", "none"], "mane": "normal", "build": "standard" } },
  "pins": [ { "kind": "title", "id": "debut", "label": "デビュー", "sub": "称号", "icon": "title/debut" },
            { "kind": "cup_trophy", "id": "cup_aaaaaaaaaaaaaaaa", "label": "プレイヤー主催カップ", "sub": "金トロフィー", "icon": null, "cupName": "春の小さな杯" },
            { "kind": "achievement", "id": "wins", "label": "勝利の記録", "sub": "実績 1段目", "icon": "badge/wins_1" } ],
  "timeAttack": [ { "trackId": "aoba_turf_1600", "course": "青葉競馬場 芝1600m", "time": "1:35.4", "timeMs": 95400, "horseName": "ミドリノカゼ" } ],
  "seasonClass": { "seasonId": "2026-11", "classId": "C", "label": "今シーズン Cクラス" }, "cupTrophies": { "gold": 1, "silver": 0, "bronze": 0 },
  "relation": "other", "reportable": true, "reportableHorseId": "h1", "young": false }
```
- `ShowcaseEditor` = `{ saved, selection, limits: { pinsMax, taMax }, horses[] (現役の馬), pins[] (今ピン留めできるもの、`ShowcasePin` と同じ形), courses[] (記録のあるコース), phrases[] ({id, phraseText}), backgrounds[] ({id, key, backgroundName, unlocked, unlockText}), young, preview: ShowcaseCard, notice }`。
- `icon`：称号は `title/<id>`、実績は `badge/<id>_<段>`（既存のキー）。それ以外は `null`（クライアントが種類の印を描く）。背景のアセットキーは新しい種類 **`showcase/bg/<id>`**（contracts/assets.md、未着は `showcase/bg/default`）。

### 62.6 画面と開く場所（REQ-SHOW-008）
- 編集：プロフィール＝「フレンド › 自分のトレーナーカード › カードを編集」（R21 統合：その他の2ページはどちらも8行で埋まっているので行を足さない。06 の「その他 のページ」）。愛馬・ピン留め・コース・一言・背景を選び、プレビューを見て保存。文字を書く欄は無い。
- 開く：フレンド一覧・ライバル・お知らせ（§40）・カップの待合室（§42）・観戦（§55）・殿堂（§34）・厩舎の訪問・ランキング・支部から、名前を押すとカード（KPI の入口 `friends`・`rival`・`activity`・`cup_lobby`・`spectate`・`hall`・`stable`・`leaderboard`・`team`、自分の編集は `settings`）。
- カードから：通報（§47 のシート、`source: profile`）、画像で共有（62.7）。空のカードには何も無い。

### 62.7 共有の画像（REQ-SHOW-013）
- 既存の共有の経路（§17 のリプレイの共有カード `ShareCard`・§38 のフォトモードと同じ。ウォーターマーク「ムチ一閃」、`#ムチ一閃`）で、`ShowcaseShare.Build(card)` → `Kind = "showcase_card"`。
- 画像と共有の文に入るのは**表示名**と、カードの文言（称号・今シーズンのクラス・一言・ピン・記録。**見る人の言語**、サーバーが返したまま）と本人の馬の名前だけ。**プレイヤー ID・フレンドコード・他のプレイヤーの情報は入れない**。空のカードは共有できない。

### 62.8 マスター `master/showcase.json`（REQ-SHOW-002）
`{ version, config: { enabled, pinsMax (0..3), taMax (0..3), minAgeFreeText (13..18) }, phrases: [{ id, ja (1..20), en (1..40) }] (1..60), backgrounds: [{ id, ja (1..12), en (1..24), unlock }] (1..40) }`。検証：id の形・重複、既定の背景がちょうど 1 つ、実績と段が存在する、**購入の解放は無い**、文に `{スロット}`・URL を入れない、賭けの言葉（`bettingWords.ts`）・「倍」「お得」「今だけ」「残りわずか」「通常価格」・英語の禁止語を使わない、英語に日本語が残らない。上限は `SHOWCASE_HARD_LIMITS` を超えられない。

### 62.9 KPI（REQ-SHOW-015）
- `showcase_save`（サーバー、選択が変わった保存だけ）→ `s1` = 背景 id、`s2` = `horse` | `none`、`s3` = `phrase` | `none`、`count` = ピン留めの数、`value` = コースの数。
- `showcase_view`（クライアント、`props: { source, relation: "self"|"friend"|"other", neutral: bool }`）→ `s1` = source、`s2` = relation、`s3` = `card` | `neutral`。
- `showcase_share`（クライアント、`props: { pins: 0..3, records: 0..4, horse: bool }`）→ `count` = pins、`value` = records、`s1` = `horse` | `none`。
- どれも相手のプレイヤー ID を持たない（strict）。§58 の必須／任意の分類は Round 20 の統合で決める。

### 62.10 ゲート・データの開示・アカウント削除（REQ-SHOW-016〜018）
- メンテナンスのゲート（§46）：`/v1/showcase*` はグループ **`social`**（フレンド・厩舎と同じ。例外にしない）。
- 個人データの開示（§51）：状態の新しいキー `showcase` は **`profile`** の節（自分の馬・ピン・コース・一言・背景の id だけ。他のプレイヤーのことは無い）。
- アカウント削除：状態の `showcase` は最後の `wipe` で消え、写しは公開プロフィールの行と一緒に `forget` で消える（他に写しは無い）。削除の予約中から写しは送らない。`PlayerService.showcaseForget` は明示の手順（冪等）。

### 62.11 文言・法務（REQ-SHOW-014）
- すべての文言に英語（`server-en.json`・`ui-en.json`・`proto-en.json`、`l10n:missing` 0）。一言と背景の名前はマスターに日英の組で持つ。
- コンプガチャではない：ピン・背景はランダムな品の収集を条件にしない（実績の段・確定した成績だけ）。何も売らず、購入で近道できない。カードは能力・マッチング・ランク戦に影響しない。
- 自由入力は無い（一言は決まった文、本文 strict）。英語の "favourite" は競馬の賭けの言葉に当たるので使わない（「愛馬」は "featured horse"）。

### 62.12 クライアント
- `Muchi.Client`：`ApiClient.GetShowcaseAsync`・`SaveShowcaseAsync(ShowcaseSelection)`・`GetShowcaseCardAsync(playerId)`、`ShowcaseCard`（`IsNeutral`）・`ShowcaseEditor`・`ShowcaseSelection`（`Problem`・`ToJson`）・`ShowcasePinKinds`・`ShowcaseSources`、`ShowcaseShare.Build`、`AnalyticsEvent.ShowcaseView`・`ShowcaseShared`、`AssetKeys.ShowcaseBg`。
- `Muchi.Game`：`ShowcaseCardModel`（開く・行・空のカード・通報の対象・共有・KPI）、`ShowcaseEditorModel`（下書き・上限・解放されていない背景・保存）。描画は docs/handoff-codex-round21-profile-showcase.md。

## 63. ディープリンク・招待リンクと再戦（deep links, invite links & rematch、REQ-LINK-001〜024、`server/src/domain/deepLinks.ts`・`linkService.ts`・`rematch.ts`・`server/src/do/matchmaker.ts`・`server/src/do/directory.ts`、C# `DeepLinks.cs`（`DeepLinkParser`・`DeepLinkRoutes`・`ResolvedLink`・`RematchView`）・`Muchi.Game.DeepLinkModel`／`RematchModel`、docs/handoff-codex-round21-deep-links.md、docs/ops/deep-links.md）
共有できるもの（フレンド部屋・主催カップ・リプレイ・招待コード・フレンド申請（プロフィール）・支部への招待・ヘルプ記事）を、**1つの形のリンク**で送れるようにする。リンクは**短い不透明なトークン**で、中身はサーバーが引く。**リンクそのものは何も配らない**（E番号なし）。招待コードの報酬（§19）は今までどおり招待コードの入力（`POST /v1/invite/redeem`）でだけ動き、リンクは入力画面にコードを入れて開くだけ（自動で入力しない）。

**決まりごと**
- URL：`https://<リンクのホスト>/l/<token>`（ユニバーサルリンク／App Links）とアプリのスキーム `muchi://l/<token>`。ホストは `progression.links.baseUrl`（既定は仮の `https://link.muchi-issen.example`）。**URL にプレイヤー ID・表示名・部屋の合言葉・カップのコードなどを入れない**。
- トークン：22文字、`23456789abcdefghjkmnpqrstuvwxyz`（31文字、0・1・o・i・l を使わない）。1文字目は作った人のディレクトリのシャード（文字の位置 mod 16）、残り21文字は暗号論的な乱数（約104ビット）。推測して当てられない。入力は NFKC・空白とハイフンを除く・小文字にする（手で入れても同じ）。
- **オラクルを作らない**：知らない・期限切れ・取り消し・作った人が BAN／削除済み・ブロックの関係・行き先が無くなった（部屋が閉じた・カップが終わった・記事が消えた）は、どれも同じ `200 { "state": "unavailable" }`。形が違う文字列も同じ。
- **引く回数の制限**：見る人ごと・IP ごと（SHA-256 にして数える）に1時間 `resolvesPerHour` 回（既定60）、`unavailable` の答えは失敗として1時間 `failuresPerHour` 回（既定10）。超えると `429 RATE_LIMITED`（`details.retryAfterSec`、`Retry-After`）で `lockMinutes` 分。トークンに関係しない制限なのでオラクルにならない。
- **期限**：部屋のリンクは `roomMinutes`（既定30分＝部屋の寿命）、カップのリンクはカップの締め切り（`closesAt`）か `cupDaysMax` 日の早い方、他は `defaultDays`（既定30日）。

### 63.1 種類と行き先（REQ-LINK-002/007）
| `type` | 作る時の本文 `target` | 作れる人 | 開いた時の `target`（見る人に返す） | 画面（`screen`） | メンテナンスのグループ（§46） |
|---|---|---|---|---|---|
| `room` | `{ "passphrase": "123456" }` | その部屋の参加者 | `{ "passphrase" }`（参加は見る人が馬を選んで `POST /v1/friend-rooms/:passphrase/join`） | `friend_room_join` | `ranked` |
| `cup` | `{ "cupId": "…" }` | 主催者・参加者（コードが見える人） | `{ "code", "preview": CupPreview }`（参加は `POST /v1/cups/join`、§42。コードの試行回数に数える） | `cup_join` | `cups` |
| `replay` | `{ "raceId": "…" }` | 自分の**公開**した保存リプレイ（§37） | `{ "ownerId", "raceId", "replayTitle" }`（フレンドだけ。フレンドでなければ `state: "friends_only"`） | `friend_replay` | `social` |
| `invite` | `{}` | 誰でも（自分の招待コード） | `{ "code" }`（§19 の入力画面に入れるだけ。入力の条件・報酬は §19 のまま） | `invite_redeem` | `social` |
| `friend` | `{}` | 誰でも（自分のフレンドコード） | `{ "friendCode", "displayName" }`（申請は見る人が押す。自分のリンクは `self: true`） | `friend_request` | `social` |
| `team` | `{}` | 支部の仲間 | `{ "teamId", "teamName" }`（参加の申請は §18 のまま） | `team_view` | `teams` |
| `help` | `{ "articleId": "…" }` | 誰でも | `{ "articleId" }` | `help_article` | （止めない：ヘルプは §46 の EXEMPT） |

### 63.2 `POST /v1/links`（要認証、グループ `social`）
- 本文 `{ "type": "room", "target": { … } }` → `{ "token", "url": "https://…/l/<token>", "appUrl": "muchi://l/<token>", "type", "createdAt", "expiresAt", "created": true | false, "shareText" }`。
- **冪等**：同じ人・同じ種類・同じ行き先で、期限内の取り消していないリンクがあれば、それを返す（`created: false`、日の回数に数えない）。
- 作れるのはゲーム日（04:00 JST）ごとに `createsPerDay` 本（既定30）まで → 超えたら `429 LINK_LIMIT`。BAN 中は `403 BANNED`、削除の予約中は `409 DELETION_PENDING`。行き先を共有できない（部屋の参加者でない・公開していない・支部にいない・記事が無いなど）→ `404 NOT_FOUND`。`progression.links.enabled` が false → `404 NOT_FOUND`。
- `shareText`：OS の共有シートにそのまま渡す文（例「ムチ一閃のフレンド部屋に招待します」＋改行＋URL）。報酬・額・煽り（「今だけ」など）を入れない。プレイヤーの名前を入れない。

### 63.3 `POST /v1/links/resolve`（要認証、**メンテナンスの窓でも古いアプリからでも止めない**＝§46 の EXEMPT。代わりに答えの `state` で言う）
本文 `{ "token": "…" }` または `{ "url": "https://…/l/…" | "muchi://l/…" }`。順番：
1. 制限（63 の決まりごと）→ `429 RATE_LIMITED`。
2. トークンを引く。無い・期限切れ・取り消し・作った人が退会済み／BAN・見る人と作った人のどちらかがブロック（§47 の1つの一覧）・見る人が BAN（ヘルプ以外）→ `{ "state": "unavailable" }`。
3. 種類が新しいアプリを要る（`minClientVersion[type]` より `x-client-version` が古い）→ `{ "state": "update_required", "type", "minVersion", "storeUrl" }`（§46 のストアの URL）。版の分からない要求は止めない。
4. その種類のグループにメンテナンスの窓がある → `{ "state": "maintenance", "type", "endAt", "endsAtJst", "message" }`（§46 と同じ窓。リンクは消えない。終わったらもう一度開く）。
5. 行き先を確かめる（63.1）。無くなっていれば `unavailable`。
6. `{ "state": "ok", "type", "screen", "target": { … }, "expiresAt" }`。自分のリンクも開ける。
- 答えに作った人のプレイヤー ID を入れない（例外：`replay` はフレンドにだけ、既存のフレンドのリプレイの口に要る `ownerId`）。

### 63.4 `GET /v1/links`・`DELETE /v1/links/:token`（要認証、グループ `social`）
- `GET` → `{ "enabled", "links": [ { "token", "url", "type", "createdAt", "expiresAt" } ]（期限内・取り消していないもの、新しい順）, "createsToday", "createsPerDay" }`。
- `DELETE` は自分のリンクを取り消す → `{ "revoked": true | false }`（無い・他人の・もう取り消したものは `false`、何度送っても同じ）。取り消したリンクは `unavailable`。

### 63.5 アプリが入っていない時（REQ-LINK-010/011、docs/ops/deep-links.md）
- `GET /l/:token`（認証なし、Worker の最小のテンプレート）：静的な案内の文（日英）・アプリで開くボタン（`muchi://l/<token>`）・App Store／Google Play への案内。**トークンを引かない**（どの文字列でも同じページ＝オラクルなし、個人のデータなし）。`x-robots-tag: noindex`、`referrer-policy: no-referrer`。
- **あとから開く（deferred deep link、クリップボードを使わない）**：
  - Android：Google Play の URL に `referrer=link%3D<token>` を付ける。初回起動で Install Referrer を読み、`DeepLinkParser.FromInstallReferrer` がトークンを取り出して `DeepLinkModel` に渡す。
  - iOS：App Store はインストールに値を運べない。ページにトークンを区切って見せ、インストール後に「リンクを開く」に入れてもらう（正直に書く：自動では開かない。クリップボードは読まない）。
- `GET /.well-known/apple-app-site-association`・`GET /.well-known/assetlinks.json`：`progression.links.apple.appIds`／`progression.links.android`（`packageName`・`sha256CertFingerprints`）が設定されている時だけ返す（無ければ 404）。リポジトリに置くのは仮の値だけ。

### 63.6 再戦（REQ-LINK-014〜019）
フレンド部屋のレースが終わったら、参加者は全員「再戦」を押せる。
- `POST /v1/friend-rooms/rematch/:raceId`（本文 `{ "horseId" }`）・`GET /v1/friend-rooms/rematch/:raceId`・`DELETE /v1/friend-rooms/rematch/:raceId`（やめる）→ `RematchView`：
```json
{ "raceId": "r-…", "state": "waiting" | "opened" | "closed", "reason": null | "too_few" | "not_included" | "expired",
  "you": "pressed" | "declined" | "none", "pressed": 2, "eligible": 4, "windowSec": 20, "deadlineAt": 1794279620000,
  "room": { "passphrase": "123456", "members": 3, "host": true } | null }
```
- フレンド部屋のレースが始まった時、マッチメーカーが**再戦の受付**（参加者・主催者・部屋の条件の写し）を `rematchOfferMinutes`（既定15分）だけ覚える。参加者でない・知らない `raceId` は `404 NOT_FOUND`。
- **最初に押した時から `rematchWindowSec` 秒**（既定20、5〜120）の間に押した人が入る。全員（やめた人を除く）が押したらすぐ締める。締めた時に2人以上なら、**同じ条件**（前のレースの部屋の条件の写し。主催者がその後に条件を変えても前のまま）で**新しいフレンド部屋**を開き、押した人を全員入れる。主催者は前の主催者（入っていて、他の部屋を主催していなければ）、いなければ最初に押した人。シードは新しく引く（`createRace` の乱数、同じレースにならない）。始めるのは主催者の「出走」（今のフレンド部屋のまま、2人以上）。
- **入れない人**：押していない・やめた（抜けた）・BAN 中（押せない、`403 BANNED`）・削除の手続き中（押せない、`409 DELETION_PENDING`。予約中はフレンド部屋と同じく遊べる）・締めた時に他のレース中／キュー中・**お互いのどちらかがブロック**している人（押した順に入れ、先に入った人とブロックの関係がある人を飛ばす。誰が誰をかは言わない：`not_included`）。
- **安全**：押すのは何度でも同じ（馬を選び直すだけ）。2人が同時に押しても、マッチメーカーの1つのオブジェクトで順に処理する。締め切りはアラームでも、次の要求でも処理する（オフラインの人は戻った時に `GET` で見る。部屋は通常の寿命30分）。締めた後に押した人は `closed`（`not_included`）。
- **ランクに関係しない**：フレンド部屋のレース（`mode: "friend"`）のまま。レート・報酬の扱いはフレンド部屋と同じ。何も買わない・何も配らない。

### 63.7 保存
- **ディレクトリ**（`DirectoryDO` のシャード＝トークンの1文字目＝作った人のシャード。新しい表を足すだけで wrangler の移行は不要）：
  - `links`：`token`・`owner_id`・`type`・`target_key`・`data`（行き先の JSON：部屋の合言葉・カップの ID とコード・リプレイの raceId・招待コード・フレンドコード・支部の ID・記事の ID）・`day`・`created_at`・`expires_at`・`revoked_at`。期限から7日で消す。
  - `link_limits`：`key`（`lu:<hash>`／`lip:<hash>`、ハッシュの先頭でシャード）・`window_start`・`lookups`・`failures`・`locked_until`。
- **再戦**：マッチメーカーの行 `m|<raceId>`（受付・押した人・締めた結果）。
- **プレイヤーの状態に新しいキーは足さない**（§51 の分類の追加なし）。
- **個人データの開示（§51、R21 統合）**：自分が作ってまだ開くリンクを `social.links` に出す（種類・作った時刻・期限。トークンは出さない）。ディレクトリが読めない時は `available: false` で、エクスポートは止めない。
- **アカウント削除**：ディレクトリの `forget` がその人の `links` の行を消す（＝全部のリンクが `unavailable` になる）。

### 63.8 設定 `progression.links`（起動時とリモート設定の版ごとに検査）
`{ enabled, baseUrl（https）, appScheme, createsPerDay 1..200, roomMinutes 5..120, cupDaysMax 1..30, defaultDays 1..90, resolvesPerHour 10..600, failuresPerHour 3..100（≤ resolvesPerHour）, lockMinutes 5..1440, minClientVersion: { <type>: "x.y.z" }, rematchWindowSec 5..120, rematchOfferMinutes 5..60, apple?: { appIds: string[] }, android?: { packageName, sha256CertFingerprints: string[] } }`。

### 63.9 KPI（REQ-LINK-021）
| イベント | 送り手 | s1 | s2 | count |
|---|---|---|---|---|
| `link_create` | サーバー（作った人） | 種類 | `new` / `existing` | |
| `link_resolve` | サーバー（見た人） | 種類（`unavailable` は `none`） | `ok`・`unavailable`・`friends_only`・`maintenance`・`update_required` | |
| `link_revoke` | サーバー | 種類 | | |
| `rematch` | サーバー | `press`・`decline`・`opened`（主催者に1行）・`too_few` | | 部屋の人数 |
| `deep_link_open` | クライアント | 入口 `universal`・`scheme`・`referrer`・`typed` | 種類 | |

トークン・行き先・プレイヤー ID は入れない。クエリは docs/ops/kpi-queries.md「ディープリンク・再戦」。

### 63.10 クライアント
- `Muchi.Client`：`DeepLinkParser`（URL・スキーム・手入力・Install Referrer → トークン。サーバーと同じ正規化）、`DeepLinkRoutes`（種類 → 画面）、`CreatedLink`・`ResolvedLink`・`LinkList`・`RematchView`、`ApiClient.CreateLinkAsync`・`ResolveLinkAsync`・`ListLinksAsync`・`RevokeLinkAsync`・`RematchPressAsync`・`RematchStatusAsync`・`RematchDeclineAsync`。
- `Muchi.Game`：`DeepLinkModel`（受け取ったトークンを引いて画面へ。**FTUE の間は1つだけ貯めて、終わってから開く**。オフラインも貯める。メンテナンス・更新・`unavailable` は案内の文。**何も自動で使わない・入力しない・参加しない**：開く画面は確認から始まる）、`RematchModel`（押す・待つ・締め切りの表示・部屋へ）。
- 画面が守ること：docs/handoff-codex-round21-deep-links.md。

## 64. アップデートのお知らせ（新機能の紹介、What's New、REQ-NEW-001〜020、`server/src/domain/releaseNotes.ts`・`server/master/release-notes.json`、C# `ReleaseNotes.cs`（`ReleaseNotesCheck`・`ReleaseNotesHistory`・`SessionPrompts`）・`Muchi.Game.ReleaseNotesModel`、docs/handoff-codex-round21-whats-new.md）
アプリを**更新した人**が、更新後はじめてホームに来たときに1回だけ、その版の新しい機能を絵付きのページ（1〜5枚）で紹介する。過去の版の紹介は「お知らせ › アップデート情報」でいつでも読める。**何も配らない**（E番号なし、経済は変わらない。お詫びや記念の配布を付けたいときは既存のプレゼントボックスの補填 §26 を使い、この節の外）。

§20 の「新着情報」（`GET /v1/whats-new`、バナー・イベント・調整など**サーバーの中身**が変わったこと）とは別物：こちらは**アプリの版**ごとの紹介で、元はアプリの版と結びついた運営の原稿だけ。

**決まりごと**
- 原稿は運営がデータで書く：`server/master/release-notes.json`（リモート設定の `releaseNotes` で丸ごと置き換え）。版（`x.y.z`）ごとに1〜5ページ。各ページは**既にある絵のキー**（§57 のヒントの絵 `TIP_ARTS`。新しい絵は作らない）・短い題と本文（日本語と英語の両方）・任意の行き先（アプリの画面・ヘルプ記事 §48・ヒントのカード §57）。
- **数字は書かない**：ヘルプセンター（§48.1）の `{{トークン}}` を同じ仕組み（`fillTokens`）で埋める。トークンの外に数字を置けない（「10連」だけ例外、§48 と同じ）。
- 言葉：§48 と同じ（日本語の「倍」「今だけ」「残りわずか」「お得」「通常価格」・賭けの言葉（`bettingWords.ts`）・英語の `EN_BANNED`）。
- **ショップへ連れていかない**：ページの行き先はそのページの**ただ1つの CTA**なので、ショップ・スカウト（`shop`・`gacha`・`gacha_odds`）や有償の商品の画面は行き先にできない（検査で落とす）。
- 出す相手：**更新した人だけ**。FTUE の途中の人・その版から始めた新しい人（FTUE が代わりに案内する）には出さない。古いアプリ（版のヘッダーが無い）・オフラインでは何も出さない。
- 見た記録は**アカウントに保存**（`releaseNotes.seen`、版の文字列の有限のリスト）。入れ直しても同じ版は二度と出ない。
- 1つのアプリのセッションで出す「システムの案内」は1つだけ（§64.6 の優先順位）。メンテナンス・更新の画面（§46）の上には決して出さない。

### 64.1 マスター（`server/master/release-notes.json`）
```json
{ "version": 1,
  "config": { "enabled": true, "titleMaxChars": 24, "bodyMaxChars": 140, "seenMax": 30, "historyMax": 20 },
  "notes": [
    { "appVersion": "1.2.0", "releasedOn": "2026-11-05",
      "pages": [
        { "art": "cups", "title": { "ja": "観戦中に応援できる", "en": "Cheer while you watch" },
          "body": { "ja": "フレンドのレースを見ながらスタンプで応援。{{cheer_interval_sec}}秒ごとに送れます。", "en": "Send a stamp while you watch a friend race, once every {{cheer_interval_sec}} seconds." },
          "target": { "kind": "help", "id": "spectator_cheer" } } ] } ] }
```
- `config`：`titleMaxChars` 8〜40、`bodyMaxChars` 40〜240、`seenMax` 10〜100、`historyMax` 5〜50。
- `notes`（50件まで）：`appVersion` は `x.y.z`（§46 の `parseVersion`）で重ならない。`releasedOn` はストアに出した日（`YYYY-MM-DD`、日本時間）。版の順に並べたとき `releasedOn` は戻らない。
- `pages`（1〜5枚）：`art` は `TIP_ARTS` のどれか。`title`・`body` は日本語・英語とも必須（`titleMaxChars`・`bodyMaxChars` 文字まで、制御文字なし、英語に日本語を入れない、日本語と英語でトークンの組が同じ、トークンは埋められる）。
- `target`（任意）：`{ "kind": "screen", "id": <§48.1 の画面のうち shop・gacha・gacha_odds 以外> }`・`{ "kind": "help", "id": <存在するヘルプ記事> }`・`{ "kind": "tip", "id": <存在するヒントのカード> }`。リモート設定でヘルプやヒントから記事・カードを外す版は、それを指すページがある限り有効にできない。
- 検査は起動時（`index.ts`）とリモート設定の版ごと（`ops/config.ts`、`CONFIG_INVALID`）。

### 64.2 `POST /v1/release-notes/check`（要認証。ホームに来たたびに呼ぶ。本文なし）
アプリの版は `x-client-version`（§46.3 のヘッダー）。
```json
{ "enabled": true, "appVersion": "1.2.0", "reason": null,
  "show": { "appVersion": "1.2.0", "releasedOn": "2026-11-05", "skipped": 1, "hasPast": true,
    "pages": [ { "art": "cups", "title": "観戦中に応援できる", "body": "…2秒ごとに送れます。",
                 "target": { "kind": "help", "id": "spectator_cheer", "label": "観戦中の応援" } } ] } }
```
- `show` は次の全部を満たす版のうち**いちばん新しい1つ**（無ければ `null` と `reason`）：
  1. 版 ≤ アプリの版（新しいサーバーと古いアプリの組み合わせで、まだ持っていない機能を紹介しない）。
  2. 版 > `baseline`（そのアカウントがはじめて紹介の判定を受けた版。下の 4）と、版 > 見た版のいちばん新しいもの（一度見たら、それより古い版は出ない）。
  3. アカウントの作成時刻 < その版の `releasedOn`（日本時間 0:00）。その版の後に始めた人には「新しくなったこと」は無い。
- `reason`：`disabled`（止まっている）・`unknown_version`（ヘッダーが無い・読めない：Round 21 より前のアプリ・ボット）・`ftue`（FTUE の途中：相棒がまだいない、または `nextActions.onboardingRaces` 回のレースが済んでいない。§45 と同じ判定）・`new_install`（3 で外れた）・`seen`（見た）・`none`（紹介のある版が無い）。
- **FTUE の途中の呼び出しだけが書き込む**：`baseline` = max(`baseline`, アプリの版)。だから FTUE の途中で更新した人にも、FTUE を終えた後にその版は出ない。
- `skipped`：同じ条件を満たすが、それより古い版の数（いくつか飛ばして更新した人）。`hasPast`：アプリの版以下の紹介が他にもある（最後のページに「過去のアップデート情報」へのリンク）。
- `target` はその人が開けるものだけ（閉じているヒントのカード・止まっているヘルプやヒントは `null`）。`label` は行き先の名前（画面は §48.1 の画面のラベル、ヘルプは記事の題、ヒントはカードの題）。
- 見た印はここでは付けない（アプリが他の案内を先に出すことがあるため）。

### 64.3 `POST /v1/release-notes/seen`（要認証）
`{ "appVersion": "1.2.0" }` → `{ "marked": true, "seen": ["1.1.0", "1.2.0"] }`。シートを出したら（1ページ目が見えたら）送る。何度送っても同じ（2回目は `marked: false`）。マスターに無い版は 404 `NOT_FOUND`（何も記録しない）、止まっているときも 404。リストは版の順で、いちばん古いものから落として `seenMax` 件まで。

### 64.4 `GET /v1/release-notes`（要認証、読むだけ）
「お知らせ › アップデート情報」の一覧。`{ "enabled": true, "appVersion": "1.2.0", "notes": [ { "appVersion", "releasedOn", "seen", "pages": [ …64.2 と同じ… ] } ] }`。新しい順、`historyMax` 件まで。アプリの版以下だけ（ヘッダーが無いときは全部）。一覧には FTUE・作成時刻の条件をかけない（読みたい人はいつでも読める）。止まっているときは `notes: []`。

### 64.5 ゲート・削除・データの開示
- `/v1/release-notes*` はエンドポイントのグループ `core`（`all` のメンテナンスだけが閉じる）。サポートではないので免除のルートには入れない。
- 新しい PlayerState のキー `releaseNotes`（`{ seen: string[], baseline?: string }`）。データの開示（§51）では `play`（見た版と `baseline`）。アカウント削除で状態ごと消える。

### 64.6 1セッションに1つの案内
クライアントは**アプリのセッション（起動から次の起動まで、またはアカウントが変わるまで）ごとに「お願いの画面」を1つだけ**出す。**順と決まりは §58.11 の表が唯一の正**（R21 統合：R20 の `SessionPromptGate` とこの節の `SessionPrompts.TryClaim` の一覧を1つの `Muchi.Client.SessionPrompts` にした）。アップデートのお知らせは表の4番目 `release_notes`：推奨の更新・同意の事前の画面・復帰の歓迎が同じ時に出せるならそれらが先、通知の前置き・引き継ぎの案内・レビューより先。

出せなかった案内は次のセッションに回る（§64 は見た印を付けていないので、次のホームでまた `show` が返る）。FTUE の間・§46 の画面の間はどれも出さない。

### 64.7 画面
- **シート**（ホームの上、1回だけ）：ページ送り（絵・題・本文・行き先のリンク「〇〇を開く ›」）。「次へ »」、最後のページは「はじめる »」。いつでも「スキップ」で閉じられる。行き先を押すとシートを閉じてその画面へ。飛ばした版があれば最後のページに「過去のアップデート情報 ›」。
- **「お知らせ › アップデート情報」**：アクティビティ（§40、お知らせの一覧）の右の欄のリンクから開く一覧。版ごとに日付とページ。アクティビティに新しい種類は足さない（自分に起きたことではない、§46.5 と同じ考え）。
- **設定 › ヒント（§57）** からも同じ一覧へリンクする。
- 文字の大きさの設定（§41）の最大でもはみ出さない。日本語・英語。

### 64.8 運用コンソール（`/v1/admin/release-notes*`、`tools/ops-console` の「アップデート情報」）
| メソッド・パス | 役割 | 内容 |
|---|---|---|
| `GET /v1/admin/release-notes` | viewer | 有効な版の原稿：版ごとのページを日本語・英語で（トークンを埋めた形）、行き先の名前、検査の結果 |
| `POST /v1/admin/release-notes/preview` | viewer | `{ releaseNotes }`（下書きの区画まるごと）を有効な版のヘルプ・ヒント・ガチャで検査し、同じ形で返す。何も保存しない |

変更は §22 のリモート設定の版（`releaseNotes` の区画）で出す（検査・監査ログ・切り戻しがそのまま効く）。

### 64.9 KPI（クライアントのイベント）
| イベント | いつ | s1 | s2 | s3 | value | count |
|---|---|---|---|---|---|---|
| `release_notes_view` | シートを出した（`shown`）・最後まで見た（`finished`）・途中で閉じた（`skipped`） | 版 | 段 | — | 閉じたときのページ（1〜5） | ページ数 |
| `release_notes_target` | ページの行き先を押した | 版 | `screen`・`help`・`tip` | 行き先の id | ページ | — |
| `release_notes_history` | アップデート情報の一覧を開いた | 入口 `notices`・`tips`・`sheet` | — | — | — | — |

個人を特定する情報は入れない。§58 の必須／任意の分類は Round 20 の統合で付ける（3つとも「任意」の想定）。クエリは `docs/ops/kpi-queries.md`「アップデートのお知らせ」。

### 64.10 クライアント
- `Muchi.Client`：`ReleaseNotesCheck`・`ReleaseNotesHistory`・`ReleaseNotePage`・`ReleaseNoteTarget`、`ApiClient.CheckReleaseNotesAsync`・`MarkReleaseNotesSeenAsync`・`GetReleaseNotesAsync`、`SessionPrompts`（1セッション1つ・優先順位・`Outage` で止める）、analytics `AnalyticsEvent.ReleaseNotesView`・`ReleaseNotesTarget`・`ReleaseNotesHistory`。
- `Muchi.Game`：`ReleaseNotesModel`（ホームに来たら判定 → `SessionPrompts` を取れたらシート・ページ送り・スキップ・行き先・見た印（出した時に送る。失敗しても出し直さない＝同じセッションで二度出さない）・オフライン／メンテナンス中は何もしない・一覧の読み込み）。
- 画面が守ること：docs/handoff-codex-round21-whats-new.md。

## 65. イベントカレンダー（予定表、REQ-CAL-001〜020、`server/src/domain/calendar.ts`、C# `Calendar.cs`・`Muchi.Game.CalendarModel`、docs/handoff-codex-round21-event-calendar.md）
プレイヤーが参加できる予定を1つの読むだけの予定表にまとめる。**予定のデータは写さない**：どの行も、その機能が持っている唯一の正（マスター・リモート設定・プレイヤーの状態・大会やカップのオブジェクト）を読んだ時に組み立てる。**何も配らない・何も売らない**（E番号なし、経済は変わらない）。

**集める予定（`kind`）**
| kind | 正（読むだけ） | 時刻の決まり（`rule`） | 見える人 |
|---|---|---|---|
| `event` | `master.events`（§ イベント）の `startAtMs`〜`endAtMs` | `exact`（ms で指定、REQ-DAY-004） | 開放キー `events` |
| `event_exchange` | 交換所のある イベント の開始〜 `exchangeClosesAt`（§30、REQ-EXCH-005） | `game_day`（締めはゲーム日の切り替え） | `events` |
| `weekly_challenge` | `weekAt`（§31）の週（`gameWeekId`、月曜 04:00） | `game_day` | `weekly_challenge` |
| `team_goal` | 支部の共同目標の週（§32 `weekKeyOf`） | `game_day` | 支部のメンバーだけ（`team.teamId`）・`teams` |
| `league_season` | 支部対抗シーズン（league、暦の月 `seasonStartMs`〜月末） | `calendar_month` | 支部のメンバーだけ・`teams` |
| `season` | ランク戦のシーズン（暦の月、`seasonIdFor`） | `calendar_month` | `season` |
| `season_pass` | シーズンパスを買える月（`passPurchaseInfo` と同じ暦の月）。期間だけ | `calendar_month` | `season_pass`・パスの商品があるとき（その月のパスを買った人には出さない） |
| `banner` | スカウトのバナーのうち **予告中・開催中** のもの（`bannerStatus` が `upcoming`／`active`、期間のあるものだけ）。予告前は出さない | `exact`（`startDay`/`endDay` のバナーは読み込み時にゲーム日の切り替えの ms になっている） | `scout` |
| `tournament_registration` | 大会の受付（`TournamentSummary` の `registrationOpensAtMs`〜`registrationClosesAtMs`） | `exact` | `tournaments` |
| `tournament` | 大会の開始（`startsAtMs`、終わりの時刻は決まっていないので時刻1点）。観戦できるとき（`spectate`）は `spectate: true` | `exact` | `tournaments` または `spectate` |
| `cup` | 参加しているプレイヤー主催カップ（§42、`GET /v1/cups` と同じ：自分が出走者の開いているカップ）の `opensAt`〜`closesAt` | `exact` | 参加者だけ |
| `maintenance` | プレイヤーに見えるメンテナンス（§46 `visibleWindows`：予告中・実施中。予告前・取り消しは出さない） | `exact` | 全員 |
| `comeback` | 復帰キャンペーン（§20 `comebackView` が `active` のときだけ、`startDay`〜`endDay`） | `game_day` | その期間を持つ本人だけ |

**決まりごと**
- 時刻は全部 JST。行は `startAt`（含む）・`endAt`（含まない、ms）と、画面に出す `startJst`／`endJst`（`MM/DD HH:mm`、§46 の `shortJst` と同じ）、行が触れる日 `firstDay`〜`lastDay` を持つ。`game_day` と `exact` の日はゲーム日（`gameDayKey`、04:00 の切り替え、REQ-DAY-001）、`calendar_month` の日は暦の日（`jstDateKey`、0:00、REQ-DAY-004）。時刻1点の行（`tournament`）は `endAt = startAt`。
- 英語でも時刻は JST のまま。応答の `timeZone`（「日本時間」→ 英語は "JST"）を時刻の横に出す。
- **偽の急かしをしない**：「今だけ」「残りわずか」「お得」「倍」「通常価格」・賭けの言葉（`bettingWords.ts`）・英語の `EN_BANNED` を使わない（検査あり）。残り時間のカウントダウンは出さない（行は日付と時刻だけ。終わりは実際のデータの `endAt`）。
- **有料のもの（パス・バナー）は日付だけ**：価格・コイン・「買う」の導線を持たない（`paid: true`、`link` はパスは `null`、バナーはスカウトの提供割合の画面 `{ "screen": "gacha_rates", "id": "<bannerId>" }`）。
- 行の名前：マスターの名前（イベント・バナー）は応答の境界で訳す。大会の名前は運営の書いたまま。カップの名前はプレイヤーの書いたもので訳さない（`cupName`）。
- 見える範囲：開放キーは `unlocksView`（§4.3）と同じ判定（表にないキーは最初から開いている）。支部の行はメンバーだけ、カップは参加者だけ、復帰キャンペーンは本人の期間だけ。
- 大会・カップは別のオブジェクトにある。読めなかったとき（落ちている・無い）はその種類を飛ばして `partial: ["tournaments"]` のように返す（予定表そのものは失敗しない）。

### 65.1 `GET /v1/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`（要認証、読むだけ）
- `from`・`to` はゲーム日（含む）。省略時は `from` = 今日のゲーム日、`to` = `from` + 34 日。期間は **35日まで**（`to - from + 1 ≤ 35`）、`from` は今日の35日前より後、`to` は今日の90日後まで。形がおかしい・逆・長すぎ・範囲外は 400 `BAD_REQUEST`。
- 範囲 = `gameDayStartMs(from)`〜`gameDayStartMs(to + 1)`。`endAt > 範囲の始まり` かつ `startAt < 範囲の終わり` の行（時刻1点は `startAt` が範囲の中）。`startAt`・種類の順で最大200行。
```json
{ "from": "2026-11-11", "to": "2026-12-15", "today": "2026-11-11", "serverNow": 1794380400000, "timeZone": "日本時間",
  "partial": [], "marks": { "count": 1, "max": 30 },
  "entries": [ { "id": "event:sprint_cup_2026_11", "kind": "event", "title": "イベントレース", "name": "青葉スプリント杯",
                 "startAt": 1793458800000, "endAt": 1796050800000, "startJst": "11/01 00:00", "endJst": "12/01 00:00",
                 "firstDay": "2026-10-31", "lastDay": "2026-11-30", "rule": "exact", "status": "open",
                 "paid": false, "link": { "screen": "event", "id": "sprint_cup_2026_11" }, "spectate": false, "groups": null,
                 "markable": true, "marked": true },
               { "id": "banner:winter_2026", "kind": "banner", "title": "スカウト", "name": "季節限定：聖夜のセイヤノカネ", "paid": true,
                 "link": { "screen": "gacha_rates", "id": "winter_2026" }, "…": "…" },
               { "id": "cup:cup_abcdefghijklmnop", "kind": "cup", "title": "主催カップ", "name": null, "cupName": "週末カップ", "…": "…" } ] }
```
- `status`：`upcoming`・`open`・`ended`（`now` と `startAt`／`endAt`）。`groups`：`maintenance` の行だけ、閉じる機能のグループ（§46、`all` は全部）。
- 行の `id` は `<kind の短い名>:<正の id>`：`event:<eventId>`・`exch:<eventId>`・`wch:<weekId>`・`tgoal:<weekId>`・`league:<YYYY-MM>`・`season:<YYYY-MM>`・`pass:<YYYY-MM>`・`banner:<bannerId>`・`treg:<tournamentId>`・`tour:<tournamentId>`・`cup:<cupId>`・`mnt:<windowId>`・`comeback:<windowId>`（`^[a-z]{3,8}:[A-Za-z0-9_-]{1,64}$`）。

### 65.2 印（リマインダーの準備、`PUT`／`DELETE /v1/calendar/marks/:entryId`、要認証）
- 行に「印」を付けられる（`markable` = まだ終わっていない行）。サーバーは **印だけ** を持つ：`calendar.marks`（`{ id, kind, until }`、`until` = 行の `endAt`（時刻1点は `startAt`）、30件まで、`until` を過ぎた印は読む・書くたびに落とす）。
- `PUT`：今日から `GET` が見せられる最も先の日（90日後）までの予定表を同じ組み立てで（200行の上限なしで）作り、その `id` の行があって終わっていなければ付ける（何度でも同じ、`{ "marked": true, "id": "…", "count": n, "max": 30 }`）。行が無い・見えない → 404 `NOT_FOUND`、終わっている → 409 `CONFLICT`（`details.reason: "ended"`）、30件ある → 409 `CONFLICT`（`details.reason: "limit"`）。
- `DELETE`：外す（無い印でも 200、`{ "marked": false, … }`）。
- **サーバーからは通知を送らない**（プッシュもメールも無し）。
- **§61（端末の通知）との結び方（R21 統合で実装）**：印は `startAt`（行の始まり）も持つ（`{ id, kind, until, startAt }`）。端末は §61 の1つの計画（`planLocalNotifications`／C# `LocalNotificationPlanner`）で、まだ始まっていない印の行に種類 `calendar_mark` の通知を `startAt − leadHours.calendar_mark` に予約する。種類（カテゴリ）は `reminders`（既定オフ）、静かな時間帯・1日の上限・`horizonDays`・止めるスイッチ（`kinds`）は §61 のまま。持ち主は端末（`LNOTIF_OWNERSHIP.local`、サーバーのプッシュのテンプレートは無い）。印を外す・行が終わる・始まる → 次の計画で予約が消える。アカウントが変わる・削除の予約・サインアウト → §61.5 のとおり全部取り消す。開催中の行の終わりは知らせない（交換所・週替わりチャレンジの締めは §61 の他の種類が受け持つ）。KPI の `calendar_mark` は `optional`（§58.7）。

### 65.3 運営コンソール（`GET /v1/admin/calendar?from&to&versionId`、viewer）
- 指定の版（省略時は有効な版）の **全体の** 予定表：イベント・交換所・週替わりチャレンジ・支部の共同目標とリーグ・シーズン・パス・**予告前を含む** バナー（`announced: false` を付ける）・大会・**予告前を含む** メンテナンス（取り消しは出さない）。プレイヤーだけのもの（カップ・復帰キャンペーン）は出さない。期間は 35 日まで。
- `overlaps`：重なりの一覧。`maintenance_closes`（メンテナンスが閉じるグループの行と重なる：event/exchange → `events`、tournament → `tournaments`、banner → `gacha`、weekly_challenge → `time_attack`、team_goal/league → `teams`、season_pass → `shop`）と `same_kind`（同じ種類の期間のある行どうし：イベント・バナー・大会）。コンソールの「予定表」の画面で表と重なりを見る。

### 65.4 ゲートのグループ
`/v1/calendar*` はグループ `core`（`all` のメンテナンスだけが閉じる）。予定表は読むだけで、ガチャやイベントのメンテナンス中にも「いつ戻るか」を見られるようにする。

### 65.5 次にやること（§45）との関係
新しいカードは足さない。終わりの近い予定のうちホームに出す価値のあるものは既存のカード（`exchange_closing`・`weekly_challenge`・`team_goal_near`）が同じ正を読んで出している。予定表は「次にやること」に何も足さない（二重の呼びかけにしない）。

### 65.6 KPI
- クライアント：`calendar_view`（`props.view`：`month`・`week`、`props.entries`：0〜200）→ s1 = 表示、value = 行の数。`calendar_entry_open`（`props.kind`：65 の13種類）→ s1 = 種類。
- サーバー：`calendar_mark`（s1 = 種類、s2 = `on`／`off`）。印が実際に変わった時だけ。
- クエリは `docs/ops/kpi-queries.md`「予定表」。

### 65.7 データのダウンロード（§51）・アカウント削除
- `calendar`（印）は `play` に分類し、印の一覧（`id`・`kind`・`until`）を出す。アカウント削除の wipe で消える。

### 65.8 クライアント
- `Muchi.Client`：`CalendarView`（`Parse`）・`CalendarEntry`・`CalendarMarkResult`・`CalendarKinds`、`ApiClient.GetCalendarAsync(from, to)`・`MarkCalendarAsync(id, on)`、analytics `AnalyticsEvent.CalendarView`・`CalendarEntryOpen`。
- `Muchi.Game`：`CalendarModel`（月・週の切り替え、日ごとの行、時刻の文字（日本時間／JST）、印の切り替え（オフラインは端末に貯めて後で送る）、行から画面へ（バナーは提供割合、パスは行き先なし））。
- 画面が守ること：docs/handoff-codex-round21-event-calendar.md。

## 70. ログイン中の端末とセキュリティ（signed-in devices & account security、REQ-DEV-001〜020、`server/src/domain/devices.ts`・`server/src/domain/sessionRevocation.ts`、C# `Devices.cs`（`DeviceSessionList`・`SecurityLog`・`DeviceLabel`）・`Muchi.Game.DeviceSessionsModel`、docs/handoff-codex-round23-devices.md）
課金しているプレイヤーが期待する「アカウントの安全」：**このアカウントでログインしている端末の一覧**、**ほかの端末のログアウト**（1台ずつ・この端末以外すべて）、**新しい端末でログインがあった時のお知らせ**、**セキュリティの記録**（新しい端末・ログアウト・引き継ぎコード・連携の追加と解除）。何も配らない・何も売らない（E番号なし、経済の目標なし）。入口は その他 › 設定（アカウントのパネル）の「ログイン中の端末」（その他の行は増やさない）。

**決まりごと**
- **セッション**＝Firebase の1回のサインイン。ID トークンの `auth_time`（サインインした時刻、秒。トークンの更新では変わらない）で見分ける。端末は `x-install-id`（インストール ID）を **アカウントごとの塩で SHA-256** にした先頭16桁（`device:<uid>:<installId>`）だけを持つ。**IP は保存しない**（ハッシュも持たない）。地域は Cloudflare の `cf-ipcountry`（国の2文字、`XX`・`T1` は持たない）だけ。
- 端末の名前は**クライアントが送る粗い情報だけ**：`platform`（`ios`・`android`・`other`）、OS の大きい番号（`osMajor`、0〜99）、機種の系統（`model`。サーバーは英字と空白だけを残して24文字まで＝`iPhone15,2` → `iPhone`）、アプリの版（`x.y.z`）。最初に見た時刻・最後に見た時刻は **1時間に切り捨て**（`lastSeenRoundMin`、既定60分）。トークン・IP・端末の ID そのものは一覧にも記録にも出さない。
- **ログアウトはサーバー側の無効化**：ログアウトされたセッションの次の要求は **`401 SESSION_REVOKED`**（「この端末はログアウトされました」）。§54.6 の `SESSION_REPLACED`（データが別の端末に移った）とは意味が違うので別のコード・別の画面（中立の文言、70.6）。同じ1か所（`authenticateSession` の後、ルートの前、`sessionGuard`）で判定し、`SESSION_REPLACED` を先に見る。Worker の isolate ごとに30秒持つ（ログアウトした isolate はすぐ覚える。ほかの isolate では最大30秒で効く）。
- **何度送っても同じ**：もうログアウトしたセッションをもう一度ログアウトしても 200（`signedOut: 0`）、数にも数えない。
- **確認と「新しい端末から古い端末はすぐには追い出せない」**（決めたこと：再認証の代わり）。匿名のアカウントは再認証できない（パスワードが無い）ので、Firebase の「最近のログイン」は使わない。代わりに：
  1. 本文の `confirm: true`（画面の確認シート）が無ければ `400 BAD_REQUEST`。
  2. **自分より後にログインした端末は、いつでもすぐログアウトできる**（持ち主の古い端末が、知らない新しい端末を追い出す場合）。
  3. **自分より前からある端末をログアウトするには、この端末でログインしてから `trustAfterHours`（既定24時間）たっていること**。足りなければ `403 DEVICE_SIGNOUT_TOO_SOON`（`details.availableAt`）。乗っ取った側が、すぐに持ち主の端末を締め出せないようにする。持ち主は新しい端末のお知らせを見て、先に相手をログアウトできる。急ぐ時（端末をなくした等）はサポートが確かめてログアウトする（70.7）。
- **この端末は「ほかの端末」に入らない**：一覧の「この端末」を指定したログアウトは `409 DEVICE_IS_CURRENT`。この端末のログアウトはアプリのサインアウト（端末の中）で、サーバーの無効化はしない。
- **回数**：ログアウトはゲーム日（§DAY、04:00 JST）ごとに `revokesPerDay`（既定10）回まで（何かを実際にログアウトした操作だけ数える）→ 超えたら `429 RATE_LIMITED`（再試行しない）。チェックインは変化がなければ書かない（読むだけ）。
- **匿名だけのアカウントの注意**：Apple・Google の連携も引き継ぎコードも無いアカウントでは、ログアウトされた端末は**同じアカウントに戻れない**（新しく始めることになる）。確認シートでそう言う（70.6）。
- **引き継ぎ（§54）との関係**：引き継ぎコードで新しい端末に移ると、古いセッションは全部 `SESSION_REPLACED` になる（今まで通り）。その時に一覧・覚えている端末・ログアウトの記録を空にし、記録に `transfer_redeemed` を残す（一覧は移った後の端末だけになる。移った後の最初の端末は「最初の端末」なのでお知らせは出さない）。
- **メンテナンス**：`/v1/account/devices*`・`/v1/account/security-log` は §46 の `EXEMPT_ROUTES`（決めたこと：ログアウトは乗っ取りへの対応で、どの窓でも古いアプリからでも止めない。コインを動かさない）。止めたい時は運用がリモート設定の `progression.devices.enabled` を false にする（一覧は `enabled: false`、ログアウトは 404。**無効化の判定（`SESSION_REVOKED`）は設定に関係なく効き続ける**）。
- **削除の手続き中**（`deleting`）・消えたアカウントでは何も書かない（一覧は空、ログアウトは `409 DELETION_PENDING`）。削除の予約中（取り消せる期間）は一覧もログアウトも使える（乗っ取りへの対応は取り消し期間にも要る）。

### 70.1 チェックイン `POST /v1/account/devices/checkin`（要認証）
アプリの起動・復帰・サインインの直後（連携の追加・解除の後も）に送る。本文 `{ "platform": "ios", "osMajor": 18, "model": "iPhone", "appVersion": "1.4.0" }`（`platform` だけ必須）、ヘッダー `x-install-id`。
1. `enabled: false`、トークンに `auth_time` が無い、アカウントがまだ無い（ブートストラップ前・削除で消えた）、削除の手続き中（`deleting`）→ 何も書かずに 70.2 と同じ形を返す（`recorded: false`）。
2. 同じ `auth_time` と同じ端末のセッションがあれば、名前と最後に見た時刻（1時間単位）を更新する。何も変わらなければ書かない。
3. 無ければ新しいセッションを足す（`sessionId` = `s_` + SHA-256(`session:<uid>:<auth_time>:<端末のハッシュ>`) の先頭16桁）。`maxSessions`（既定20）を超えたら最後に見た時刻の古いものから落とす。
4. **新しい端末のお知らせ**（70.4）：覚えている端末（`knownDevicesMax`、既定50）に無い端末で、覚えている端末が1台以上あり、そのセッションのログインがこのアカウントの記録の始まり（`since`）より後のとき。**最初の端末には出さない**（記録が始まる前からあったセッション＝この機能の前から使っていた2台目にも出さない）。`x-install-id` が無い時は、同じ `platform`・`model` のセッションが無い時だけ新しい端末とみなす。
5. **連携の変化**：ID トークンの `firebase.identities` にある `apple.com`・`google.com` を前回と比べ、増えたら `link_added`、減ったら `link_removed` を記録する（初めて見た時は記録しない。クライアントの申告は使わない）。
6. 引き継ぎの `cutoffAt` より前のセッションは一覧から落とす。

応答は 70.2 と同じ形に `recorded`（true／false）と `newDevice`（true／false）を足したもの。

### 70.2 一覧 `GET /v1/account/devices`（要認証、読むだけ）
```json
{ "enabled": true, "current": "s_3f9a0c1d2e4b5a69",
  "sessions": [ { "sessionId": "s_3f9a0c1d2e4b5a69", "current": true, "platform": "ios", "osMajor": 18, "model": "iPhone", "appVersion": "1.4.0",
                  "region": "JP", "firstSeenAt": 1794376800000, "lastSeenAt": 1794380400000, "canSignOut": false, "availableAt": null },
                { "sessionId": "s_7b21e0aa94c3d5f1", "current": false, "platform": "android", "osMajor": 15, "model": "Pixel", "appVersion": "1.3.2",
                  "region": "JP", "firstSeenAt": 1793000000000, "lastSeenAt": 1794200000000, "canSignOut": true, "availableAt": null } ],
  "signOutOthers": { "allowed": true, "availableAt": null, "count": 1 },
  "revokesToday": 0, "revokesPerDay": 10, "trustAfterHours": 24, "anonymousOnly": false, "lastTransferredAt": null }
```
- 並びは「この端末」が先、あとは最後に見た時刻の新しい順。`canSignOut` は 70.3 の規則で今ログアウトできるか（できない時の `availableAt`）。`anonymousOnly`：連携が1つも見えていない（70 の注意を確認シートに出す）。
- 名前の組み立てはクライアント（`DeviceLabel`）：「iPhone（iOS 18）」「Pixel（Android 15）」、機種が無ければ「iOS の端末」。地域は国の名前（`JP` → 日本、それ以外は2文字のまま）。

### 70.3 ログアウト `POST /v1/account/devices/:sessionId/signout`・`POST /v1/account/devices/signout-others`（要認証）
- 本文 `{ "confirm": true }`。応答 `{ "signedOut": 1, "devices": <70.2> }`。
- 1台：無い `sessionId` → `404 NOT_FOUND`、この端末 → `409 DEVICE_IS_CURRENT`、もうログアウト済み → 200 `signedOut: 0`、自分より前からある端末で `trustAfterHours` に足りない → `403 DEVICE_SIGNOUT_TOO_SOON`。
- この端末以外すべて：一覧のこの端末以外を全部ログアウトし、さらに **今より前にログインした、この端末以外のすべてのセッション**（一覧にまだ出ていない端末も）を無効にする（`othersBefore = { at: 今, keep: この端末の auth_time }`）。一覧に自分より前からある端末があり `trustAfterHours` に足りなければ `403 DEVICE_SIGNOUT_TOO_SOON`。一覧にログアウトする相手がいなくても 200（`signedOut: 0`、回数に数えない、記録にも残さない。`trustAfterHours` たったこの端末なら、一覧に無い前のセッションのための `othersBefore` だけは今に動かす）。`trustAfterHours` に足りないこの端末は、一覧にある自分より後の端末だけをログアウトし、`othersBefore` は動かさない（一覧に出ていない古いセッション＝チェックインしない古いアプリの持ち主の端末には届かない）。
- 無効化の記録 `devices.revoked`：`{ authTime, at }` の新しい `revokedKeep`（既定200）件。Firebase の匿名のセッションは期限が無いので、件数で切る（1日 `revokesPerDay` 回の上限があるので、200件は20日以上の連続の操作でしか溢れない）。
- この端末の `auth_time` が分からない要求（トークンに無い）は `400 BAD_REQUEST`（「この端末」を決められない）。

### 70.4 新しい端末のお知らせ（§40 のアクティビティ）
- アクティビティの種類 **`new_device`**（`category: "account"`＝プッシュの種類ではない、`screen: "devices"`、まとめない、`source` = `new_device:<sessionId>`、`linkId` = `sessionId`）。文言：「新しい端末でログインがありました。心当たりがなければ「ログイン中の端末」で確かめられます」。怖がらせる言葉（「不正」「危険」「すぐに」）を使わない。新しい端末の名前は文言に入れない（一覧で見る）。
- **プッシュは送らない**（決めたこと）：今のプッシュの種類（`season`・`friends`・`invites`・`events`・`comeback`・`gifts`・`reminders`）に合うものが無く、新しい種類を足すと通知の設定（§61、一画面の種類の数）と同意（06 §3.5）が変わる。「セキュリティのお知らせ」を装うプッシュは釣りの形でもある。お知らせは全ての端末のアクティビティ（ベルの数）とセキュリティの記録に残る。後でプッシュを足す時は新しい種類 `account`（既定オン）と §61.1 の持ち主の表に行を足す。
- 割り込みのシートは出さない（§58.11 の表に行は足さない）。

### 70.5 セキュリティの記録 `GET /v1/account/security-log`（要認証、読むだけ）
```json
{ "enabled": true, "logDays": 180,
  "items": [ { "at": 1794380400000, "kind": "new_device", "text": "新しい端末でログインがありました",
               "device": { "platform": "android", "osMajor": 15, "model": "Pixel", "region": "JP" } },
             { "at": 1794300000000, "kind": "transfer_issued", "text": "引き継ぎコードを発行しました（パスワードを設定）", "mode": "custom" } ] }
```
| kind | いつ | 付くもの |
|---|---|---|
| `new_device` | 70.4 のお知らせを出した時 | `device` |
| `signout_device` | 1台をログアウトした | `device` |
| `signout_others` | この端末以外をすべてログアウトした | `count` |
| `signout_support` | サポートがログアウトした（70.7） | `count` |
| `transfer_issued` | 引き継ぎコードを発行した（`mode`：`custom`＝パスワードを設定、`generated`） | `mode` |
| `transfer_revoked` | 引き継ぎコードを取り消した（`by`：`player`・`ops`） | `by` |
| `transfer_redeemed` | 引き継ぎコードでこのアカウントが新しい端末に移った | |
| `link_added`／`link_removed` | Apple・Google の連携が増えた・減った（70.1 の5） | `provider` |
- 新しい `logMax`（既定50）件、`logDays`（既定180日）より古いものは読む・書くたびに落とす。文言は日本語で組み立て、英語は応答の境界（i18n/en.ts）。
- 何かを配ったり、ボタンで何かを実行したりしない（見るだけ。一覧へのリンクだけ）。

### 70.6 クライアントの画面（ムチ一閃の調子、日英、最大の文字）
- **入口**：その他 › 設定（アカウントのパネル）の「引き継ぎ」の下の「ログイン中の端末 ›」。その他のページの行は増やさない（8行のまま）。アクティビティの `new_device` とヘルプの記事・ヒントのカードからも開く。
- **ログイン中の端末**：「この端末」の行（シアンのラベル）と、ほかの端末の行（名前・地域・最後に見た日・「ログアウト」）。下に「この端末以外をすべてログアウト」（斜めのシアンの CTA ではなく、静かな枠のボタン）と「セキュリティの記録 ›」「ヘルプ」。
- **確認シート**：「〇〇をログアウトしますか？」「その端末は次に通信した時にログアウトされます。」連携が無い時（`anonymousOnly`）は「その端末ではこのアカウントに戻れなくなります（Apple・Google の連携か引き継ぎコードがあれば戻れます）」を足す。「ログアウトする」「やめる」。
- **ログアウトされた端末**（`401 SESSION_REVOKED`）：全画面の中立の案内「この端末はログアウトされました」「別の端末かサポートからログアウトの操作がありました。Apple・Google で連携している場合は、もう一度ログインすると続きから遊べます。心当たりがない場合はお問い合わせください。」ボタン「ログインする」（連携がある時）・「新しく始める」・「お問い合わせ」。`MaintenanceModel` が §54.6 と同じ1か所で受け、メンテナンス・強制アップデート・オフラインはそれを置き換えない。表示した時に `AccountChangeReset` が端末の状態（ローカル通知・エラーの束・お願いの画面・保留のリンク・アップデートのお知らせ・**端末の一覧の写し**）を消す。
- 文言は「不正」「危険」「今すぐ」を使わない。

### 70.7 運用（`/v1/admin/players/:playerId/devices*`）
| メソッド・パス | 役割 | 内容 |
|---|---|---|
| `GET /v1/admin/players/:playerId/devices` | viewer | 一覧（名前・地域・時刻。トークン・端末のハッシュ・`auth_time` は出さない）、ログアウトの記録の件数・`othersBefore` の時刻、セキュリティの記録 |
| `POST /v1/admin/players/:playerId/devices/revoke` | **admin** | `{ "sessionId": "s_…" }` か `{ "all": true }` と `reason`。本人からの依頼（端末をなくした・乗っ取られた）を確かめてからログアウトする。`all` は今より前のすべてのセッション（この端末の例外なし）。監査ログ `player.devices.revoke`、記録に `signout_support`。`trustAfterHours`・1日の回数の制限は掛からない |

### 70.8 保存
- **プレイヤーの状態** `devices`（新しいトップレベルのキー、`devices.ts`）：`{ since, sessions: [{ id, authTime, device, platform, osMajor, model, appVersion, region, firstSeenAt, lastSeenAt }], known: [端末のハッシュ], revoked: [{ authTime, at }], othersBefore: { at, keep } | null, revokes: { day, count }, providers: string[] | null, log: [{ at, kind, … }] }`。
- **§51（データの開示）**：`account` に分類。`account.signedInDevices`（名前・地域・時刻だけ）と `account.securityLog` を出す。`auth_time`・端末のハッシュ・無効化の記録・覚えている端末のハッシュは出さない（それだけでは本人にとって意味の無い内部の値で、端末を結びつける鍵になるため）。アカウント削除の `wipe` で消える（ほかに写しは無い）。
- wrangler の移行は不要（PlayerDO の状態に足すだけ）。

### 70.9 KPI
| イベント | 送り手 | s1 | 分類（§58.7） |
|---|---|---|---|
| `device_list_view` | クライアント（`props.screen`：`devices`・`log`、`props.count`：0〜50 → value） | 画面 | `optional`（使われ方の分析） |
| `device_signout` | サーバー（実際にログアウトした時だけ、count = 数） | `one`・`others`・`support` | `essential`（アカウントへの入口の監査：§54 の `transfer_*` と同じ。乗っ取りへの対応を見つける） |
| `new_device_notice` | サーバー（70.4 のお知らせを出した時） | `ios`・`android`・`other` | `essential`（同じ理由。新しい端末の増え方で乗っ取りの波を見つける） |

端末のハッシュ・`sessionId`・地域・機種は入れない。クエリは `docs/ops/kpi-queries.md`「ログイン中の端末」。

### 70.10 設定 `progression.devices`
`{ "enabled": true, "maxSessions": 20, "knownDevicesMax": 50, "logMax": 50, "logDays": 180, "revokesPerDay": 10, "trustAfterHours": 24, "revokedKeep": 200, "lastSeenRoundMin": 60 }`。範囲：`maxSessions` 5〜50、`knownDevicesMax` 10〜200（`maxSessions` 以上）、`logMax` 10〜200、`logDays` 30〜400、`revokesPerDay` 1〜50、`trustAfterHours` 0〜168、`revokedKeep` 50〜1000、`lastSeenRoundMin` 15〜1440。起動時とリモート設定の版ごとに検査（`devicesProblems`）。

### 70.11 クライアント
- `Muchi.Client`：`DeviceSessionList`（`Parse`）・`DeviceSession`・`SignOutOthersInfo`・`SecurityLog`・`SecurityLogItem`・`DeviceLabel`（名前・地域の組み立て、日英）・`DeviceCheckin`、`ApiClient.CheckinDeviceAsync`・`GetDevicesAsync`・`SignOutDeviceAsync`・`SignOutOtherDevicesAsync`（再試行しない）・`GetSecurityLogAsync`、`ApiErrorCode.SessionRevoked`・`DeviceSignoutTooSoon`・`DeviceIsCurrent`、`SessionRevokedException` と `ApiClient.SessionRevoked` イベント（再試行しない）、analytics `AnalyticsEvent.DeviceListView`。
- `Muchi.Game`：`DeviceSessionsModel`（一覧・確認シート・ログアウト・記録・`ForgetAll`）、`MaintenanceModel` の `MaintenanceScreen.SessionRevoked`（`SessionReplacedShown` と同じく `AccountChangeReset` を呼ぶ）、`AccountChangeReset.Devices`。
- 画面が守ること：docs/handoff-codex-round23-devices.md。
