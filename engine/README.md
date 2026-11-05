# engine/ — レースエンジン・ロックステップ・検証サーバー（C#）

要件：[docs/spec/requirements.md](../docs/spec/requirements.md)（REQ-RACE / REQ-NET / REQ-VER）、境界：[contracts/protocol.md](../contracts/protocol.md)。

## 構成

| プロジェクト | TFM | 依存 | 役割 |
|---|---|---|---|
| `Muchi.Engine/` | netstandard2.1 / C# 9 | なし | 決定論レースエンジン。Unityにそのまま入れる（`Muchi.Engine.asmdef` 同梱） |
| `Muchi.Net/` | netstandard2.1 / C# 9 | Engine | ロックステップのクライアント、ミニJSON、プロトコルのコーデック（`Muchi.Net.asmdef` 同梱） |
| `Muchi.Verifier/` | net8.0 | Engine, Net, ASP.NET | 検証サーバー（CLI/HTTP）、ゴールデン生成、バランス計測 |
| `Muchi.Engine.Tests/` | net8.0 | xUnit | 81テスト |

```bash
export PATH=/opt/dotnet:$PATH          # この環境の .NET 8 SDK
dotnet test engine/Muchi.Engine.Tests
dotnet run --project engine/Muchi.Verifier -- replay "$PWD/contracts/golden/race-turf1600-mixed.json"   # リプレイログ（ゴールデンファイルも可）
dotnet run --project engine/Muchi.Verifier -- serve --urls http://0.0.0.0:8080                 # POST /verify, GET /healthz
dotnet run --project engine/Muchi.Verifier -- golden "$PWD/contracts/golden" "$PWD/contracts/ruleset-params.default.json"   # パスは絶対パスで（Web SDKは実行時の作業ディレクトリをプロジェクトに変えるため）
dotnet run --project engine/Muchi.Verifier -- balance contracts/ruleset-params.default.json 1000 [key=value ...]
```

ルールセットや物理を変えたら `golden` を再生成してコミットする（`GoldenGeneratorIsStable` テストが差分を検出する）。

## Unity / Codex 向け API

Unity には `Muchi.Engine/*.cs + .asmdef` と `Muchi.Net/*.cs + .asmdef` だけをコピーする（`bin/` `obj/` は入れない）。

### 対戦の流れ
```csharp
var client = new LockstepClient(transport, raceId, firebaseIdToken);   // transport: ITransport（WebSocket実装はUnity側）
client.RaceStarted += c => { /* c.Sim, c.Slot, c.Config, c.StartAtMs が使える */ };
client.RaceFinal   += (c, f) => { /* f.Status: Confirmed / Verifying / Void, f.Order */ };
client.Connect();                       // 接続・再接続のたびに呼ぶ（hello）
// WebSocket の受信ごとに:
client.HandleMessage(text, localNowMs);
// 操作:
client.QueueInput(Cmd.Whip);            // Start / LaneIn / LaneOut / ReinPress / ReinRelease / Whip
// 時計合わせ（数秒ごと）:
client.SendPing(localNowMs);
```
- エンジンは部屋が確定したtickだけ進む。描画は `GetPreviousHorse(slot)` と `GetHorse(slot)` を `client.InterpolationAlphaPermille(localNowMs)`（0〜1000）で補間する。
- 再接続：同じ `LockstepClient` で `Connect()` → 続きから。アプリ再起動なら新しい `LockstepClient` で `Connect()` → 全tickを早送り。

### 描画用の読み取り API（`RaceSim`）
| API | 内容 |
|---|---|
| `GetHorse(slot)` / `GetPreviousHorse(slot)` | `HorseState`（値型のスナップショット）：`Distance`（m）、`Lane`（レーン、小数あり）、`Speed`（m/s）、`StaminaPermille`、`Composure`（0〜100）、`WhipsLeft`、`IsWhipActive`、`Reining`、`IsKakari`、`InSpurt`、`Blocked`、`Rank`（0=先頭）、`Finished`、`CpuControlled` |
| `SlotAtRank(r)` | r番手のスロット |
| `Track` | `TrackLayout`：`SegmentCount`、`Segment(i)`（Kind/LengthM/RadiusM）、`SegmentStart(i)`。距離→3D座標の変換は表示側 |
| `Events` | `RaceEvent{Tick, Type, Slot, Value}`。`GateOpen / Start / LateStart / LeaderChanged / Kakari / Whip / SpurtStart / Finish / CpuTakeover / HumanResume / RaceEnd / LaneChange`。実況・SE用。前回読んだ件数から差分を読む |
| `Result` | `Order`、`FinishTicks`、`Margins`（m）、`Hash` |
| `TopSpeed(slot)` | 適性補正後の最高速（HUD用） |
| `Fx` | Q16.16。表示には `ToMilli()`（×1000の整数）を使い、`float` へは表示層でだけ変換する |

### オフライン（チュートリアル・タイムアタック）
`new RaceSim(config)` を作り、毎tick `Step(cmdsBySlot)` を呼ぶだけ。`RaceReplay.Run(config, inputs)` でリプレイ。

## 決定論の担保
- 浮動小数点ゼロ（`NoFloatTests` がソースとIL両方を検査）。乱数は PCG32＋SplitMix64（参照値テストあり）。
- 他馬の位置・速度は「そのtickの開始時点のスナップショット」から読む。処理順は常にスロット順、レーン変更の競合はスロットの若い方が優先。
- 文字列化は `InvariantCulture`。

## ルールセットのキー（contracts/ruleset-params.default.json）

当初案からの変更：`drainPer1000MmPerSecSquaredPerTick` → **`drainMicroPerSpeedSqPerTick`**（整数では粒度が足りないため百万分率に）。追加：**`startBoostTicks`、`cruiseSpeedPermille`、`decelMmPerSec2`、`minGapMm`、`blockedComposureLossIntervalTicks`、`cpuDecisionIntervalTicks`、`cpuWhipIntervalTicks`、`cpuWhipStartDistanceM`、`cpuTargetRank{Nige,Senko,Sashi,Oikomi}Permille`**。`rulesetVersion` と `maxTicks` は不変。

| キー | 既定 | 意味 |
|---|---|---|
| rulesetVersion | 1.0.0 | 結果ハッシュに含まれるバージョン文字列 |
| maxTicks | 4800 | これに達したらレース終了（240秒） |
| gateOpenTick | 60 | ゲートが開くtick（3秒のカウントダウン） |
| startReactionWindowTicks | 4 | 開いてからこのtick数以内のSTARTで好スタート |
| startBoostPermille | 500 | 好スタート時の加速ボーナス（千分率） |
| startBoostTicks | 40 | 加速ボーナスの継続tick |
| autoStartDelayTicks | 10 | STARTしない馬が自動で出るまでのtick（出遅れ） |
| laneCount | 12 | レーン数（0=最内） |
| laneWidthMm | 1200 | 1レーンの幅。コーナーで外を回る距離の計算に使う |
| laneChangeTicks | 6 | 1レーン移動にかかるtick |
| laneChangeClearanceMm | 2500 | 移動先の前後この距離に馬がいたら移動できない |
| blockRangeMm | 2000 | 同レーン前方この距離内の遅い馬は抜けない |
| minGapMm | 1000 | 前の馬との最小車間（すり抜け防止の硬い制約） |
| slipstreamRangeMm | 6000 | 同レーン前方この距離内に馬がいると風よけ |
| slipstreamSavePermille | 300 | 風よけ中の脚の消費減（千分率） |
| baseCruiseSpeedMmPerSec | 21000 | 能力0の馬の最高速 |
| speedStatBonusMmPerSecPer1000 | 5000 | speed 1000 での最高速の上乗せ |
| cruiseSpeedPermille | 940 | 道中の巡航速度（最高速比） |
| accelMmPerSec2 / decelMmPerSec2 | 3500 / 2500 | 加速・減速の上限 |
| reinSpeedPermille | 950 | 手綱中の目標速度（比） |
| reinDrainPermille | 450 | 手綱中の脚の消費（比） |
| spurtDistanceM | 800 | 残りこの距離からスパート区間 |
| spurtSpeedBonusMaxMmPerSec | 6000 | スパートの上乗せ上限（×burst/1000×残り脚の割合） |
| staminaBase / staminaPerStatPoint | 4000 / 10 | 脚の量 = base + stamina × per |
| drainMicroPerSpeedSqPerTick | 11300 | 1tickの消費 = 速度²(m²/s²) × 値 / 1,000,000 |
| gutsFloorMinPermille / MaxPermille | 600 / 850 | 脚が尽きたときの速度下限（根性0〜1000で補間） |
| aptitudeOutPenaltyPermille | 50 | 距離・馬場の適性外1つごとに最高速と脚の量を減らす |
| badComposureThreshold | 40 | 折り合いがこれ未満で消費増 |
| badComposureExtraDrainPermille | 300 | そのときの消費増 |
| kakariChancePer100000PerTickAtTemper0 | 60 | 気性0の馬が1tickにかかる確率（10万分率、気性で線形に減る） |
| kakariDurationTicks | 40 | かかりの継続（手綱中は2倍速で収まる） |
| kakariComposureLossPerTick | 2 | かかり中の折り合い低下 |
| reinComposureRecoverPerTick | 2 | 手綱中の折り合い回復 |
| naturalComposureRecoverPerTick | 0 | 自然回復（0=手綱でしか戻らない） |
| blockedComposureLossIntervalTicks | 20 | 逃げ馬が前を塞がれているとこの間隔で折り合い-1 |
| maxWhips | 6 | ムチの上限 |
| whipEffectTicks | 20 | 1発の効果時間 |
| whipAccelBonusMmPerSec2 / whipSpeedBonusMmPerSec | 2000 / 2000 | ムチの加速・速度ボーナス |
| whipDiminishWindowTicks / whipDiminishPermille | 20 / 500 | この間隔内の連打は効果が半分ずつに |
| earlyWhipEffectPermille / earlyWhipComposurePenalty | 300 / 10 | スパート前のムチは効果30%、折り合い-10 |
| whipStaminaCost | 20 | ムチ1発の脚の消費 |
| cpuDecisionIntervalTicks | 4 | CPUの判断間隔 |
| cpuWhipIntervalTicks / cpuWhipStartDistanceM | 24 / 400 | CPUのムチ間隔と開始地点（残り距離） |
| cpuTargetRank*Permille | 0 / 400 / 550 / 800 | 脚質ごとの道中の目標位置（0=先頭、1000=最後方） |

## 計測したバランス（既定ルールセット、2000m芝、平均能力±150のCPU12頭×1000レース）

| 指標 | 値 |
|---|---|
| 勝ち時計の平均 | 89.2秒（最速86.8秒） |
| 最下位の平均 | 96.1秒（最遅99.8秒）、未完走 0 |
| 脚質別の1頭あたり勝率（均等なら8.3%） | 逃げ 9.2% / 先行 9.1% / 差し 8.2% / 追込 6.8% |
| 能力合計が最も高い馬の勝率 / 3着内率 | 31.7% / 67.0% |
| 脚を使い切ってゴールした馬 | 52.3% |

性質テスト：間隔をあけて残り400mからムチ6発 → ムチなしより速い。残り400m内の連打 → 間隔をあけるより遅い。風よけで後ろの馬の脚が残る。コーナーで外を回ると遅い（直線では差なし）。レベル5のCPUがレベル1より勝つ。
