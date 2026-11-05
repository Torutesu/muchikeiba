# engine/ — レースエンジン・ロックステップ・検証サーバー（C#）

要件：[docs/spec/requirements.md](../docs/spec/requirements.md)（REQ-RACE / REQ-NET / REQ-VER）、境界：[contracts/protocol.md](../contracts/protocol.md)。

## 構成

| プロジェクト | TFM | 依存 | 役割 |
|---|---|---|---|
| `Muchi.Engine/` | netstandard2.1 / C# 9 | なし | 決定論レースエンジン。Unityにそのまま入れる（`Muchi.Engine.asmdef` 同梱） |
| `Muchi.Net/` | netstandard2.1 / C# 9 | Engine | ロックステップのクライアント、ミニJSON、プロトコルのコーデック（`Muchi.Net.asmdef` 同梱） |
| `Muchi.Client/` | netstandard2.1 / C# 9 | Engine, Net | Unity向けクライアントSDK：API呼び出し、オンラインレースの接続管理、オフラインレース、実況テキスト（`Muchi.Client.asmdef` 同梱） |
| `Muchi.Verifier/` | net8.0 | Engine, Net, ASP.NET | 検証サーバー（CLI/HTTP）、ゴールデン生成、バランス計測 |
| `Muchi.Bot/` | net8.0 | Engine, Net | 結合テスト用のヘッドレスプレイヤー |
| `Muchi.Engine.Tests/` | net8.0 | xUnit | 144テスト |

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

Unity には `Muchi.Engine/`、`Muchi.Net/`、`Muchi.Client/` の `*.cs + .asmdef` と `Muchi.Client/Data/commentary-ja.json` をコピーする（`bin/` `obj/` は入れない）。
通常は下の **Muchi.Client（推奨）** だけを使えばよい。`LockstepClient` を直接使うのは独自の接続管理をしたい場合のみ。

## Muchi.Client（Unity 統合ガイド）

Codex（見た目）側で実装するのは次の3つのアダプタだけ。ロジックはすべてSDK側にある。

| インターフェイス | Unity 側の実装例 | 役割 |
|---|---|---|
| `IHttp` | `UnityWebRequest` | `SendAsync(HttpRequest)` → `HttpResponse(status, body)`。応答が無い（DNS・タイムアウト・切断）ときは例外を投げる |
| `IAuthTokenProvider` | Firebase Auth SDK | `GetTokenAsync(forceRefresh)` → IDトークン（匿名ログイン可） |
| `ITransportFactory` | 任意の WebSocket ライブラリ | `Open(url, onOpen, onMessage, onClosed)` → `IConnection`（`Send` / `Close`）。コールバックはどのスレッドから呼んでもよい |

### 1. API（`ApiClient`）
```csharp
var api = new ApiClient(new UnityHttp(), new FirebaseTokens(), new ApiClientOptions { BaseUrl = "https://api.example.com" });
var me = await api.BootstrapAsync();                       // 起動ごとに呼んでよい
var draw = await api.DrawAsync("standard", 10);            // 冪等キーは自動（リトライでも同じキー）
try { await api.PurchaseIntentAsync("coin_1500"); }        // ストアを開く前に必ず確認
catch (PurchaseBlockedException e) { /* e.Code: AgeRequired / GuardianConsentRequired / AgeLimitExceeded / AlreadyPurchased / UnsettledDebt */ }
```
- `server/README.md` のプレイヤー向けAPIをすべて型付きで持つ（管理API・ストア通知・WebSocketは除く）。
- **冪等キー**：ガチャ・覚醒・配合・報酬受け取りなどは呼び出しごとにキーを1つ作り、リトライでも同じキーを送る。アプリ再起動をまたいで再送したいときは `NewIdempotencyKey()` で作ったキーを保存し、引数で渡す。
- **リトライ**：安全なリクエスト（GET、冪等な書き込み、キー付きの書き込み）だけを、通信失敗・5xx・429のときに指数バックオフ（300ms→600ms→1200ms＋ゆらぎ、最大3回）で再送する。`EnqueueRankedAsync` / `RetireAsync` / フレンド部屋の作成・参加・開始 / チュートリアルレース開始は再送しない。
- **401**：トークンを強制更新して1回だけ再送。
- **購入**：`PurchaseAsync` はサーバーが取引IDで重複を弾くので、ストアのトランザクションを finish する前にクラッシュしても、起動時に同じレシートを再送すればよい（`Duplicate=true` が返る）。
- **エラー**：`ApiException`（`Code`=型付きコード、`WireCode`=生の文字列、`Status`）。サブクラスで画面を分ける：`AuthException`（再ログイン）、`ValidationException`（入力を直す。`NG_NAME` など）、`NotFoundException`、`PurchaseBlockedException`、`InsufficientCoinsException`（ショップへ）、`ConflictException`（`ALREADY_CLAIMED` などゲームルール）、`ServerException`、`NetworkException`（通信不可）。
- 開発時（サーバー `DEV_MODE=1`）は `ApiClientOptions.DevUserId` を入れるとトークン無しで動く。
- **プロフィール・称号・戦績**：`SetDisplayNameAsync`（NGリスト判定）、`GetTitlesAsync` / `EquipTitleAsync(null で外す)`、`GetStatsAsync`（コース別ベストは `BestFinishTick × 50ms`）。
- **ランキング**：`GetMyRankAsync`（スナップショット前は `Rank=null`）、`GetLeaderboardAsync("current" または "yyyy-mm", "class-A" / "rating" / "index")`。ランキングは認証不要の公開スナップショット（数分おきに更新）。
- **フレンド**：`GetFriendCodeAsync`、`SendFriendRequestAsync(9桁コード)`（相手からも申請済みなら即フレンド）、`AcceptFriendRequestAsync` / `DeclineFriendRequestAsync` / `CancelFriendRequestAsync` / `RemoveFriendAsync`、`GetFriendsAsync`（フレンド・受信・送信中・部屋への招待）、`InviteToFriendRoomAsync`。サーバー側で重複操作は無害なので、すべて再送対象。
- **新しいエラー**：`FRIEND_LIMIT`、`ALREADY_IN_RACE`（ランク戦は同時に1レースまで）、`ROOM_TOO_SMALL`（フレンド部屋は2人から）はいずれも `ConflictException`。

### 2. オンラインレース（`RaceSession`）
```csharp
var a = (await api.GetMatchStatusAsync()).Assignment;      // または StartTutorialRaceAsync / StartFriendRoomAsync
var race = new RaceSession(new UnityWebSocketFactory(), api.RaceWebSocketUrl(a), a.RaceId, a.Ticket);
race.StateChanged += (from, to) => ShowState(to);
race.Start(NowMs());
// 毎フレーム（メインスレッド）:
race.Update(NowMs());                                      // 受信処理・ping・再接続はすべてここで
race.Input(Cmd.Whip);                                      // ボタン
int alpha = race.InterpolationAlphaPermille(NowMs());      // GetPreviousHorse→GetHorse の補間
```
- 状態：`Connecting → Waiting → Racing → Finished → (Verifying →) Confirmed / Void`。通信が切れると `Reconnecting`（0.5秒→1秒→2秒…最大8秒、8回まで）。諦めると `Failed`（`FailureReason`）。
- 再接続すると hello で最後のtickを伝え、部屋から届いた分を早送りして追いつく。切れている間の入力は捨てる（部屋がCPUに引き継いでいる）。
- `NowMs()` は単調増加の時計（`Time.realtimeSinceStartupAsDouble * 1000` を long にしたもの等）。
- ゴールすると `res`（結果ハッシュ・着順・`finishTicks`）を自動で送る。`finishTicks` があると、合意で確定したレースでもベストタイムが記録される。
- 部屋は一定時間何も届かない端末をCPUに引き継ぐ。`Update` を毎フレーム呼んでいれば ping が2秒ごとに出るので問題ない（バックグラウンドに回ると引き継がれ、戻ると操作が戻る）。

### 3. オフラインレース（`OfflineRace` / `OfflinePresets`）
```csharp
var race = new OfflineRace(OfflinePresets.Tutorial(ruleset), OfflinePresets.TutorialPlayerSlot) { AutoStart = true };
race.Start(NowMs());
race.Update(NowMs());     // 毎フレーム。固定ステップ（50ms）、1フレームの追いつきは最大10tick
race.Input(Cmd.Whip);
race.Pause(NowMs()); race.Resume(NowMs());
```
- **チュートリアル**（いきなり本番）：400mの直線だけ。スタートは自動、操作はムチだけ。残り200〜400mからムチを入れればほぼ必ず勝ち（60シード中58以上）、ムチ無し・残り60mからのムチではほぼ負ける（テストで固定）。
- **練習用タイムアタック**（記録なし）：`OfflinePresets.TimeAttack(track, horse, ruleset)`、`FinishTimeMs(slot)` でタイム。
- `ruleset` はサーバーから受け取ったもの（オンラインと同じ値）を使う。
- `OfflineRace.RecordedInputs` に、自分の馬に実際に適用した入力（tickごとに1つ）が残る。設定＋この入力でレースを完全に再現できる（タイムアタックの提出に使う）。

### 3.1 タイムアタックとゴースト（記録あり、REQ-TA-*）
```csharp
var session = await api.StartTimeAttackAsync(trackId, horseId);   // サーバーが設定（シード・コース・正規化した馬）を発行。1日の回数を消費、自動再試行しない
var run = new TimeAttackRun(session);                              // 自分の OfflineRace（slot 0）
var list = await api.GetGhostsAsync(trackId, GhostKind.Top);       // Top / Friends / Me
run.AddGhost(await api.GetGhostAsync(list.Ghosts[0]));             // 何体でも
run.Race.Start(nowMs);
// 毎フレーム: run.Race.Update(nowMs) — ゴーストは自動で同じtickまで進む。入力は run.Race.Input(Cmd.Whip) など
// 描画: run.Race.Sim.GetHorse(0) と run.Ghosts[i].Horse / PreviousHorse（半透明で）
// ゴール後:
var result = await api.SubmitTimeAttackAsync(session, run.Race);   // 入力と結果ハッシュだけ送る。安全に再試行される
// result.TimeMs, SeasonBest, AllTimeBest, Milestones（報酬）, Published（ランキングとゴーストに載った）
```
- **ゴーストは別のシミュレーション**：ゴーストごとに自分の設定（馬・シード）で `RaceSim` を作り、記録された入力で同じtick数だけ進める。プレイヤーの馬とは干渉しない（スリップストリーム・進路妨害なし）ので、プレイヤーの走りは「発行された設定＋自分の入力」だけで決まり、サーバーの再計算と必ず一致する。ゴーストも記録どおりのゴールtickで終わる（テストで確認）。
- タイムは `run.Race.FinishTimeMs(0)` / `GhostPlayer.FinishTimeMs`。サーバーの式と同一（`contracts/protocol.md` §8.1）。
- 改ざん（入力の書き換え、強い馬への差し替え）は再計算のハッシュが合わず `TA_RESULT_MISMATCH`（ConflictException）。検証サーバー停止中は `VERIFIER_UNAVAILABLE`（ServerException）で、セッションの期限内なら同じ `SubmitTimeAttackAsync` をもう一度呼べばよい。
- ゴーストは `Ghost.Parse(JsonNode)` で読み込めるので、ダウンロードしたものを端末に保存しておける。
- 計測（上限いっぱいの馬を上手く乗った場合、`TimeAttackTests.MeasureTypicalTimesPerTrack`）：1600m≈67.3秒、2000m≈85.6秒、2400m≈106.3秒。節目報酬の秒数（`server/master/progression.json` の `timeAttack.milestones`）はこれを基準にした暫定値。

### 4. 実況（`Commentator`）
```csharp
var templates = CommentaryTemplates.Parse(commentaryJsonTextAsset.text);
var commentator = new Commentator(templates, race.Sim.Config, focusSlot: mySlot);
// tickが進むたび:
foreach (var line in commentator.Process(race.Sim)) PlayLine(line); // line.Text（字幕）, line.ClipKeys（音声）
```
- 行は重ならない（`DurationTicks` の間は次を出さない）。重要な場面（ゲート、先頭交代、最後の直線、1着、着順）は捨てずに遅らせて必ず言う。
- 言い回しはレースのシードから決定的に選ぶ（同じリプレイは同じ実況）。
- **音声は作り置き**：`templates.AllFixedClips()` が「固定フレーズID→文」を返すので一度だけ音声合成しておく。馬名は `name:<horseId>`（命名時に1回生成）、数字は `num:<n>`。`ClipKeys` を順に再生すれば `Text` と同じ文になる。
- 文面は `Data/commentary-ja.json` を編集する（`{name}` `{name2}` `{name3}` `{place}` が使える）。

### 5. プッシュ通知（`ApiClient` の push 系）
```csharp
// 起動時とFCMトークンが変わった時（Firebase Messaging の TokenReceived）
await api.RegisterPushDeviceAsync(fcmToken, PushPlatform.Android);
// 設定画面
var prefs = await api.SetPushPreferencesAsync(new PushPreferencesPatch { Invites = false, QuietStartHour = 23, QuietEndHour = 7 });
// 返ってきたトピックを必ず反映する（シーズンのお知らせなどの一斉通知はトピック宛て）
foreach (var t in prefs.SubscribeTopics) FirebaseMessaging.SubscribeAsync(t);
foreach (var t in prefs.UnsubscribeTopics) FirebaseMessaging.UnsubscribeAsync(t);
// ログアウト時
await api.UnregisterPushDeviceAsync(fcmToken);
```
- 個別通知（フレンド申請・フレンド成立・フレンド部屋への招待）はサーバーが送る。通知の `data` に `templateId` と `category` が入っているので、開いた時の遷移先を決めるのに使う（招待の合言葉は通知に載らない。`GetFriendsAsync()` の `Invites` から取る）。
- 静かな時間帯（JST）・種類ごとのオン・オフ・1日の上限はサーバー側で判定する。

### 6. 分析（`AnalyticsClient`）
```csharp
var analytics = new AnalyticsClient(api, new AnalyticsOptions { Platform = "android", AppVersion = Application.version }, new FileAnalyticsStore(path), NowMs());
analytics.Track(AnalyticsEvent.SessionStart(NowMs()));
analytics.Track(AnalyticsEvent.TutorialStep(NowMs(), "first_whip", 2));
// 毎フレーム（数秒おきでも可）
analytics.Update(NowMs());
// バックグラウンドへ行く時
analytics.Track(AnalyticsEvent.SessionEnd(NowMs(), sessionMs));
_ = analytics.FlushAllAsync(NowMs());
```
- 送れるのは「クライアントでしか分からないイベント」だけ（セッション・チュートリアルの各ステップ・画面・購入画面の操作・通知の開封・通知の許可）。購入・ガチャ・レース結果などはサーバーが自分で記録するので送らない。
- 50件ごと、または30秒ごとにまとめて送る。通信に失敗したら残して指数的に間隔をあけて再送（429なら1分以上待つ）。サーバーが400で拒否したまとまりは捨てる（同じ失敗を繰り返さないため）。
- `IAnalyticsStore`（`Load()`/`Save(json)`）を渡すと、未送信分がアプリ再起動後も残る。7日より古いものは送らずに捨てる。
- `NowMs()` は Unix 時間のミリ秒（`DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()`）。

### 対戦の流れ（LockstepClient を直接使う場合）
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
通常は `Muchi.Client.OfflineRace` を使う。低レベルには `new RaceSim(config)` を作り、毎tick `Step(cmdsBySlot)` を呼ぶだけ。`RaceReplay.Run(config, inputs)` でリプレイ。

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
