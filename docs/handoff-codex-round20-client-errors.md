# Codex handoff — Round 20: クライアントのエラー報告 (client error & crash reporting)

Spec: `contracts/protocol.md` §60, `docs/spec/requirements.md` §60 (REQ-CERR-001〜020). Legal: `docs/planning/03-legal-risk.md` 「クライアントのエラー報告」. Ops: `docs/ops/console.md` 「クライアントのエラー」.
Reference: the web prototype hooks the page's `window.onerror` / `unhandledrejection` into the same reporter in WASM (`index.html?demo=errors`, その他 › プライバシー › エラーの自動送信). Screens: `.screens/u-*-diagnostics*.png`, `en-*-diagnostics.png`, `a11y-*-diagnostics*.png` after `node tools/figma-prototype/test/e2e.cjs`.

All logic is done in `Muchi.Client` (`ClientErrors.cs`: `ErrorReporter`, `ErrorScrubber`, `ErrorFingerprint`, `StallDetector`, `ApiClient.RequestFailed`, `ApiClient.SendClientErrorsAsync`) and the game layer (`unity/Assets/Muchi/Game/ClientErrorModel.cs`). **There is nothing to draw for players.** Codex only wires the Unity callbacks below (Integration / Runtime), and may add one optional settings row.

## 1. Create it once, at start-up (Integration: `MuchiServices`)

```csharp
var store = new FileClientErrorStore(Path.Combine(Application.persistentDataPath, "client-errors.json")); // IClientErrorStore: Load() / Save(json), ≤ ~100 KB
var reporter = new ErrorReporter(api, new ClientErrorOptions
{
    Platform = Application.platform == RuntimePlatform.Android ? "android" : Application.isEditor ? "editor" : "ios",
    AppVersion = Application.version,
    DeviceModel = SystemInfo.deviceModel,          // allowed (§60.3); anything outside [A-Za-z0-9 ,._()-] becomes "other"
    OsVersion = ShortOs(SystemInfo.operatingSystem), // e.g. "iOS 18.1" / "Android 14 (API 34)"; keep it short
    // InstallId: leave null — the reporter makes a random id and keeps it in the store. NEVER use SystemInfo.deviceUniqueIdentifier or an ad id.
}, store, NowMs());
var errors = new ClientErrorModel(reporter, NowMs);
errors.FollowConsent(consentModel);      // R20 integration (§58.10): the player id only while the §58 analytics choice is effective
errors.Attach(api);                       // ApiClient.RequestFailed → api items (business answers and its own endpoint are skipped)
```

`FileClientErrorStore`: a tiny class in Integration (write to a temp file then `File.Replace`, catch IO errors — the reporter keeps the queue in memory if saving fails). PlayerPrefs is acceptable too (`PlayerPrefsStore` pattern), but the JSON can reach ~100 KB offline.

## 2. Unity callbacks (Runtime: `MuchiApp` or a `DontDestroyOnLoad` MonoBehaviour)

| Unity | Call | Notes |
|---|---|---|
| `Application.logMessageReceivedThreaded += (c, st, t) => errors.OnLogMessage(c, st, (GameLogType)t);` in `Awake`, `-=` in `OnDestroy` | `OnLogMessage` | Any thread. Exception and Assert are reported; `Debug.LogError` only if `errors.ReportLogErrors = true` (keep off for release). A log line raised while a report is being made is ignored (no loop). Use the **Threaded** variant so background-thread exceptions are seen. |
| `AppDomain.CurrentDomain.UnhandledException += (s, e) => errors.OnException(e.ExceptionObject as Exception);` | `OnException` | Plus `TaskScheduler.UnobservedTaskException += (s, e) => { errors.OnException(e.Exception); e.SetObserved(); };` |
| `Update()` | `errors.OnFrame()` | Main thread, every frame: stall detection (≥ 700 ms long frame, ≥ 5 s ANR-like) and the send timer. |
| `OnApplicationPause(bool paused)` / `OnApplicationFocus(false)` | `_ = errors.OnPause(paused)` | Pausing sends the queue (fire and forget) and the time away is never counted as a stall. |
| scene loads / loading screens | `errors.WatchStalls = false` while loading, `true` after | A loading hitch is not a stall. |
| every screen change | `errors.Screen = "home"` (the screen id used in `ScreenModels`, `[A-Za-z0-9_.:-]`, ≤ 40) | Tags exceptions and stalls. |
| `AssetDownloader` run finished | `errors.OnAssetReport(report)` | Failed / NotFound / Corrupt / DiskFull files; an offline run reports nothing. |
| online race: right after `new RaceSession(...)` | `errors.WatchRace(session.Client, mode)` (`"ranked"`, `"event"`, `"tournament"`, `"cup"`, `"friend"`) | Reports the room's `desync` (race id + tick only — never inputs). Desyncs are never sampled out (fairness). |

Do not wrap game code in try/catch just to report: unhandled exceptions arrive through the log callback. For a caught exception worth knowing about, `errors.OnException(e, handled: true)`.

## 3. Rules to keep

- Never put player names, emails, tokens or typed text into exception messages on purpose; the scrubber removes quoted text, non-ASCII runs, emails, tokens, URLs, long ids and paths anyway (`contracts/client-errors.vectors.json`).
- Do not show any UI for sending; no toast on failure. The reporter retries with backoff, keeps the same batch id, waits after 429 and stops for the run when the server answers `enabled: false`.
- IL2CPP builds: keep **"Script Debugging" off** in release but enable **"IL2CPP Stacktrace Information: Method Name, File Name and Line Number"** (Player Settings) so stacks have method names; the server ignores line numbers for the fingerprint.
- Optional settings row (その他 › プライバシー): 「エラーの自動送信」 → a static page with the texts of the prototype (`Diagnostics()` in `tools/figma-prototype/site/app.js`; the strings already have English in `proto-en.json` — move them to `ui-en.json` if drawn). The 「プレイヤーIDを添える」 toggle belongs to §58; until §58 lands do not draw it.

## 4. Crashlytics (later, optional)

Native crashes (signals, OOM kills) are outside this pipeline. If Firebase Crashlytics is added: call `FirebaseCrashlytics.SetCrashlyticsCollectionEnabled(reporter.AllowsDiagnostics())` at start and whenever consent changes, never call `SetUserId` with the player id unless consent allows it, and never log custom keys with names or free text. Add it to the external-transmission notice (docs/planning/03 「クライアントのエラー報告」). Keep `ClientErrorModel` installed too: the ops console's fingerprints, desync links and alerts come from this pipeline.

## 5. Checks

`dotnet run --project 'unity/Checks~/GameChecks'` → 「round 20: クライアントのエラー報告」 (log lines, the type split, no loop, stall / pause, API failure, desync, asset, consent hook, send on pause). The Unity hooks themselves (callbacks, file store) need an Editor / device run.
