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
        "goingAptitude": "heavy"    // 省略可。"any"|"fast"|"heavy"（得意な馬場）。省略 = any
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
- `track.going` / `track.night` / `horse.goingAptitude` は**値があるときだけ書く**（省略と既定値は同じ計算結果。省略した設定を読み書きしても1バイトも変わらない）。

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
- 1部屋の観戦者数の上限は既定 200（`SPECTATOR_LIMIT`）。超えると `err` `SPECTATORS_FULL` で閉じる（close code 4003）。観戦の接続はプレイヤーごとに1本：同じプレイヤーの新しい観戦接続が来ると古い接続は close code 4000（`replaced`）で閉じる（選手の席と同じ）。観戦チケットの発行は1人あたり連続10回・その後6秒に1回まで（超過は `429 RATE_LIMITED`）。
- 描画：観戦クライアントは `delayMs` だけ遅れて描く（`LockstepClient.RenderTickPermille` が自動で引く）。

## 8.5 種牡馬の貸し借り（REQ-BREED-012）
- `POST /v1/stud/breed` の本文 `{ "ownerId", "horseId", "damId", "useMaterial"?, "expectedFee"? }`（`Idempotency-Key` 必須）。
- `expectedFee`（任意・0以上の整数）：借り手がプレビューで見た料金。持ち主の今の料金と違えば `409 {"error":{"code":"FEE_CHANGED"}}` で、何も確保・請求しない。クライアントはプレビューを取り直して確認し直す。省略した古いクライアントは確認なし。
- 同じ `Idempotency-Key` を別の種牡馬・別の持ち主の馬で使うと `409 CONFLICT`（最初の操作の馬のまま）。
- 購入で付いた無償コイン（初回購入ボーナス）は購入から90日は料金に使えない。足りなければ `409 INSUFFICIENT_COINS`。プレビューの `stud.heldFree` がその額、`stud.canPay` はそれを除いて判定する。

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
- **タイムアタック**：サーバーは調子を 0 にしたルールセットで発行し、`rulesetVersion` に `+ta` を付ける（例：`1.1.0+ta`）。チュートリアル（端末内）も調子 0・癖なし。
