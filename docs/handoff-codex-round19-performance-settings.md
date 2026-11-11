# Round 19 Codex 向け引き継ぎ：画質・省電力・通信量の設定（REQ-PERF-001〜018）

更新：2026-11-11　基準ブランチ：`feat/r19-performance-settings`（`origin/claude/round17` から）
仕様：`contracts/protocol.md` §56、`docs/spec/requirements.md` 56章、アセット配信：§16・`contracts/assets.md` §6.1

分担はこれまでと同じ：**Claude＝ロジック（設定・端末の区分・描画の値・配信の方針・ストレージの計算）／Codex＝見た目（設定画面・ストレージ画面・URP の品質レベルと描画への結び付け・OS の通知の受け取り）**。
このラウンドは**画面2枚**に加えて、**描画のパラメーターを結ぶ作業**（§3）と**端末の情報の取り込み**（§4）がある。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ 新しい経路なし（設定は端末だけ）。カタログのエントリーに任意の `low`（軽量版、§5）、スキャナが `<key>.low.<ext>` を拾う。KPI `perf_setting_change`・`asset_predownload`（クライアントのイベント、組み合わせはサーバーで検査）。ヘルプ記事 `data_storage`、画面のリンク `performance`・`storage`、文脈 `storage` |
| C# クライアント | ✅ `engine/Muchi.Client/PerformanceSettings.cs`：`PerformanceSettings`・`DeviceProfile`／`IDeviceInfo`／`StaticDeviceInfo`・`DeviceClassifier`・`PerformanceContext`・`RenderProfile`・`AssetDownloadPolicy`・`AssetStorage`、analytics。`AssetEntry.Low`・`AssetResolver`（軽量版）・`AssetDownloader.ClearOptional`／`EnsureAsync(…, policy, network)`・`AssetCache.ListBlobs`／`ListPartials` |
| ゲーム層 | ✅ `unity/Assets/Muchi/Game/PerformanceSettingsModel.cs`（`PerformanceSettingsModel`・`StorageModel`）、`AssetPreloadModel.DownloadPolicy`／`OnDownloadPolicyChanged`。チェック `unity/Checks~/GameChecks/PerformanceChecks.cs` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → その他 → 「画質・通信量」→「ストレージを開く」。画質・fps・省電力は**見本の 3D レース表示（ピクセル比・影）・描画ループの fps・スピード線・FOV キック・ホームの背景のドリフトを実際に変える**（値は C# の `RenderProfile` を WASM で計算） |
| **Codex** | 設定画面（§2.1）、ストレージ画面（§2.2）、描画への結び付け（§3）、端末の情報（§4）、起動時の配信（§5） |

## 2. 画面

### 2.1 「画質・通信量」（見本の `PerfSettings`）
見本と同じ 1600×900 の構図。背景 `Art/home-paddock`＋暗いシェード、上の帯（`TopBar`、財布なし、題「その他 / 画質・通信量」、副題 `TextSubtitle`）、紺のパネル1枚に2列。

- 入口：その他（設定）の「見た目・お世話・仲間」の列、「アクセシビリティ」のすぐ下に1行「画質・通信量 ›」。ヘルプ記事のリンク `performance` もここへ。
- 行は `PerformanceSettingsModel.Rows()` の順。左列（表示 `TextGroupDisplay`）：画質（自動・低・中・高）・フレームレート（自動・30・60）。右列（電池・通信 `TextGroupData`）：省電力（オフ・オン）・データセーバー（オフ・オン）。
- 1行：名前（21px、白、500）→ 説明（14px、灰、2行まで）→ 右に選択ボタン（アクセシビリティと同じ `choice`：紺＋細い灰の枠、選ばれているものはシアンの 2px 枠＋薄いシアン）。画質・フレームレートの行は説明の下にシアン 14px で `AutoNote`（「自動：中」「自動：60fps」＝この端末で自動が何になるか）。主ボタン（斜めのシアン）は使わない。保存ボタンも無い。
- 押したら `Set(row.Key, choice.Value)`。**その場で当たる**（`Changed` で §3 を結び直す）。トーストは出さない（見た目がすぐ変わるので）。
- パネルの中段に細い線、左に `NowLine`（「いまの表示：画質 中・60fps・描画 85%」、省電力中は「・省電力」）と「レース中：60fps」（`RenderProfile.Resolve(settings, InRace = true)`）、右に `TextFairness`（「どの設定もレースの計算には関係しません。結果や公平さは同じです。」）。**必ず出す**。
- 端末の省電力モード中で設定がオフのときは `LowPowerNote`（「端末の省電力モード中のため、省電力で表示しています」、金 14px）を `NowLine` の下に。
- 下段：「ストレージ」の見出し、合計（`StorageModel.TotalLabel`、24px 太字）、「ストレージを開く」（ゴースト）、右に「データ通信量と容量について」のリンク（ヘルプの文脈 `storage` → 記事 `data_storage`）。
- 英語：全部 `Loc.T` 経由（`ui-en.json`）。英語・文字「特大」でもはみ出さない（見本 `en-104..105`・`a11y-37/80` で確認済み）。

### 2.2 「ストレージ」（見本の `Storage`）
- 左パネル「使っている容量」：合計（36px 太字）→ 6行（`StorageModel.Lines()`：必須データ・画面のデータ・都度のデータ（実況の馬名など）・軽量版・途中のダウンロード・古いデータ）。1行は名前（18px）＋右寄せのサイズ（22px 太字、0 は暗く）＋細いゲージ（最大の行に対する割合。必須は金、他はシアン）。
- 右パネル上「すべてダウンロード」：`PredownloadLabel`（「あと 82.9MB」／「すべてダウンロード済みです」）→ データセーバー中は `VariantNote`（シアン）→ 主ボタン（斜めのシアン »、ここで唯一）。
  - 押せない時は `PredownloadBlockedReason` を金 14px でボタンの下に（データセーバー中のモバイル通信「Wi-Fi に接続すると実行できます」、オフライン）。
  - モバイル通信では最初に `StartPredownloadAsync()` が `State = NeedsConfirm` にするだけ：中央のダイアログで `CellularConfirmText`（「モバイル通信で約○MBのデータをダウンロードします。Wi-Fi への接続をおすすめします。」）、「ダウンロードする」（主ボタン）→ `StartPredownloadAsync(confirmed: true)`、「やめる」→ `CancelConfirm()`。**両方同じ大きさの近さで並べる**（押させる演出にしない）。
  - 実行中は太いゲージ（`Progress`）。終わったら `Message` をトースト（終わりました／空き容量が足りない分は取得していない／一部取得できなかった）。
- 右パネル中「キャッシュを削除」：説明（「ダウンロードした絵や音を消します。遊ぶのに必要なデータとアカウント・進み具合は消えません。」）→ ゴースト（危険の色の枠）「キャッシュを削除」→ ダイアログ `ClearConfirmText`（消えるサイズ入り）→「削除する」で `ClearCache()`、トースト `Message`。消せるものが無い時（`ClearConfirmText == null`）はボタンを無効に。
- 見本の右下の「デモ：回線」は見本専用（Unity では出さない。回線は `Application.internetReachability`）。

## 3. 描画への結び付け（`PerformanceSettingsModel.Profile` = `RenderProfile`）

起動時と `Changed` のたびに当てる。値はすべて表示だけで、**レースのシミュレーション（`OfflineRace`／`RaceSession`、20Hz 固定）には何も渡さない**。

| 値 | Unity での結び先 |
|---|---|
| `UrpQualityLevel`（0 低／1 中／2 高） | `QualitySettings.SetQualityLevel(level, applyExpensiveChanges: true)`。Project Settings の Quality に URP アセットを3つ（Low/Medium/High）この順で用意する |
| `TargetFrameRate`（30／60） | `QualitySettings.vSyncCount = 0; Application.targetFrameRate = TargetFrameRate;` |
| `RenderScale`（0.70／0.85／1.00、省電力は 0.85 まで） | 今の URP アセットの `renderScale` |
| `Msaa`（0／2／4） | URP アセットの `msaaSampleCount`（0 は 1） |
| `Shadows`（Off／Hard／Soft） | 主光源の `shadows`（`LightShadows.None/Hard/Soft`）、URP アセットの `supportsMainLightShadows`。Off なら馬の下の丸い影（ブロブ）だけ残す |
| `ParticleScale`（×0.35／×0.70／×1.00、省電力は ×0.5） | 土煙・芝の飛び散り・紙吹雪の `emission.rateOverTimeMultiplier` と `maxParticles` に掛ける |
| `PostProcessing` | URP の Volume（ブルーム・色調補正）の `weight` を 0／1 |
| `CrowdDensity`（×0.3／×0.6／×1.0） | スタンドの観客のインスタンス数（ビルボードの間引き） |
| `SpeedLines` | ムチの時のスピード線（**`MotionPolicy.SpeedLines` も false なら出さない**：結果はこの値に入っている） |
| `FovKick` | ムチの FOV キック（動きを減らす §41.6 が決める。この値が false なら ×0） |
| `AmbientMotion` | メニューのキーアートのゆっくりしたズーム・ドリフト（動きを減らす・省電力のどちらでも止まる） |

- **レースに入る時 `SetInRace(true)`、出る時 `SetInRace(false)`**（省電力の 30fps はメニューだけ。レース中は `frameRate` の設定のまま）。
- アクセシビリティの「動きを減らす」が変わったら `OnReduceMotionChanged()`（`GameBackend.AccessibilityChanged` から）。カメラの揺れ・ゲージの点滅は今まで通り `MotionPolicy` だけが決める（省電力では変えない）。両方オンでも打ち消し合わない。
- データセーバーが変わると `DownloadPolicyChanged` が来る：起動時の `AssetPreloadModel.OnDownloadPolicyChanged()` を呼ぶ（まだ始まっていない先読みを軽量版／通常版で組み直し、モバイル通信中に走っていれば止めて Wi-Fi で再開）。
- KPI：`PerformanceSettingsModel` に `Action<AnalyticsEvent>`（`AnalyticsQueue.Enqueue`）を渡す。プレイヤーが値を変えた時だけ `perf_setting_change`。`StorageModel` は「すべてダウンロード」を始めた時に `asset_predownload`。画面側で送らない。

## 4. 端末の情報（`IDeviceInfo`）

`Muchi.Client.IDeviceInfo` を Unity で実装して `PerformanceSettingsModel` に渡す（起動時に1回 `DeviceClassifier.Classify`）。

| フィールド | Unity |
|---|---|
| `SystemMemoryMb` | `SystemInfo.systemMemorySize` |
| `ProcessorCount` | `SystemInfo.processorCount` |
| `GraphicsMemoryMb` | `SystemInfo.graphicsMemorySize`（モバイルで当てにならない値は 0 にしてよい＝不明） |
| `SoftwareRenderer` | `SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null` か `graphicsDeviceName` に SwiftShader 等 |
| `MaxRefreshHz` | `Screen.currentResolution.refreshRateRatio.value`（四捨五入） |
| `LowPowerMode` | iOS：`NSProcessInfo.processInfo.isLowPowerModeEnabled`（ネイティブプラグイン）、Android：`PowerManager.isPowerSaveMode()`。**変わった時に `OnLowPowerModeChanged(bool)`**（iOS `NSProcessInfoPowerStateDidChangeNotification`、Android `ACTION_POWER_SAVE_MODE_CHANGED`、またはアプリ復帰時に読み直す） |

保存は `PlayerPrefsStore`（`IKeyValueStore`）の `muchi.perf.settings`。**サーバーには送らない・アカウントに保存しない**（§56.6：端末の性能・電池・回線で決まるため）。再インストール・機種変更では自動から始まる。

## 5. 起動時の配信（`AssetPreloadModel`、§16 の画面）

- `new AssetPreloadModel(...) { DownloadPolicy = () => perf.DownloadPolicy }` と渡すだけ。渡さなければ今まで通り。
- データセーバー中のモバイル通信：必須（boot・ftue の required）は今まで通り取得、チュートリアルも止めない。必須でないものは **Wi-Fi を待ち、モバイル通信の確認ダイアログは出さない**（`NeedsConsent` は false、`DataSaverHolds` が true）。ステータスの1行は `TextDataSaverWaiting`（「データセーバー：残りのデータは Wi-Fi につながったときに取得します」）。
- 回線が変わったら今まで通り `OnNetworkChanged()`（Wi-Fi で再開、データセーバー中に Wi-Fi が切れたら一時停止。途中のファイルは残り、続きから）。
- 都度のアセット（馬名の音声など）は `AssetDownloader.EnsureAsync(catalog, key, perf.DownloadPolicy, network)` を使う（データセーバー中のモバイル通信では取りに行かず、端末にある版を返す）。
- 表示は今まで通り `AssetResolver.Resolve(key)`。軽量版しか無いときは `LowRes = true` で軽量版のパスが返る（そのまま読み込めばよい。通常版が届けば次からそちら）。

## 6. 見本で確かめたこと

- `test/unity-flow.cjs`（「6. round 19」）：4行、自動の意味、画質の切り替えで 3D 表示の影とピクセル比が変わる、同じ値では KPI が出ない、省電力でメニュー 30fps・背景のドリフトなし・レースは 60fps、端末だけに保存、ストレージの6行、サイズを先に出す、データセーバー中のモバイル通信は押せない、モバイル通信の確認・やめる、ダウンロード後は残り 0、キャッシュの削除は必須の容量だけ残す、ヘルプ記事。
- `test/en-flow.cjs`：英語で未訳 0・はみ出し 0。`test/a11y-flow.cjs`：文字「特大」で日英ともはみ出し 0。
- `test/round19-performance.test.mjs`：同じレースを 60fps・30fps・揺れのあるループで走らせて**結果ハッシュが同じ**（§56.5）。C# では `PerformanceSettingsTests.RaceHashIsTheSameForEverySetting` が全設定 × 区分 × 省電力モードで確かめている。

## 7. やらないこと

- 設定をサーバーに送る・アカウントに保存する。
- 区分をマッチング・レーティング・報酬に使う。
- 省電力・画質でレースの tick やエンジンの入力の扱いを変える（描画のフレームだけ）。
- 「すべてダウンロード」を押させる演出（急がせる文言・残り時間・おすすめの強調）。
