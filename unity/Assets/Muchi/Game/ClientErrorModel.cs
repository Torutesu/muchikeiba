using System;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Game
{
    // クライアントのエラー報告 (REQ-CERR-002/013/020, contracts/protocol.md §60, docs/handoff-codex-round20-client-errors.md),
    // the game layer. Pure C# (no UnityEngine): the app's bootstrap forwards Unity's log callback, the frame tick, pause,
    // asset failures and the race to this model; ErrorReporter (Muchi.Client) scrubs, samples, queues and sends. Nothing is
    // drawn: the player never sees a screen for this. The §58 consent hook is ErrorReporter.AllowsDiagnostics.

    /// <summary>The same values as UnityEngine.LogType (cast it: <c>(GameLogType)type</c>).</summary>
    public enum GameLogType { Error = 0, Assert = 1, Warning = 2, Log = 3, Exception = 4 }

    public sealed class ClientErrorModel
    {
        private readonly Func<long> _clock;
        [ThreadStatic] private static bool _reporting;

        public ErrorReporter Reporter { get; }
        public StallDetector Stalls { get; } = new StallDetector();
        /// <summary>The screen on show (an identifier such as "home" or "gacha_reveal"); tags exceptions and stalls.</summary>
        public string Screen { get; set; } = "boot";
        /// <summary>Also report Debug.LogError lines (off: they are noisy; exceptions and asserts are always reported).</summary>
        public bool ReportLogErrors { get; set; }
        /// <summary>Stall detection runs only while a screen is interactive (off during loading screens and scene changes).</summary>
        public bool WatchStalls { get; set; } = true;

        public ClientErrorModel(ErrorReporter reporter, Func<long> clock)
        {
            Reporter = reporter ?? throw new ArgumentNullException(nameof(reporter));
            _clock = clock ?? throw new ArgumentNullException(nameof(clock));
        }

        /// <summary>
        /// Unity's <c>Application.logMessageReceivedThreaded</c> (any thread). Exception and Assert are reported (Error only
        /// when <see cref="ReportLogErrors"/>); a message logged while a report is being made is ignored (no loop).
        /// </summary>
        public void OnLogMessage(string condition, string stackTrace, GameLogType type)
        {
            if (type == GameLogType.Warning || type == GameLogType.Log) return;
            if (type == GameLogType.Error && !ReportLogErrors) return;
            Guarded(() =>
            {
                var (t, message) = SplitCondition(condition, type);
                Reporter.Report(ClientErrorItem.Exception(_clock(), t, message, stackTrace, false, Screen));
            });
        }

        /// <summary>AppDomain.UnhandledException / TaskScheduler.UnobservedTaskException (and a caught exception worth a report: handled = true).</summary>
        public void OnException(Exception e, bool handled = false)
        {
            if (e == null) return;
            Guarded(() => Reporter.Report(ClientErrorItem.FromException(_clock(), e is AggregateException a && a.InnerException != null ? a.InnerException : e, handled, Screen)));
        }

        /// <summary>Every frame (main thread): stall detection and the reporter's send timer.</summary>
        public void OnFrame()
        {
            long now = _clock();
            if (WatchStalls)
            {
                var stall = Stalls.Frame(now, Screen);
                if (stall != null) Guarded(() => Reporter.Report(stall));
            }
            else Stalls.Pause();
            Reporter.Update(now);
        }

        /// <summary>OnApplicationPause / focus loss: the time away is not a stall, and the queue is sent while we can.</summary>
        public Task OnPause(bool paused)
        {
            Stalls.Pause();
            if (!paused) return Task.CompletedTask;
            return SafeFlush();
        }

        private async Task SafeFlush()
        {
            try { await Reporter.FlushAllAsync(_clock(), CancellationToken.None); }
            catch (Exception) { /* kept for the next run */ }
        }

        /// <summary>An asset download that failed for good (AssetDownloader). reason: http | hash | disk | timeout | network | other.</summary>
        public void OnAssetFailure(string assetKey, string reason, int? status = null) => Guarded(() => Reporter.ReportAsset(_clock(), assetKey, reason, status));

        /// <summary>The report of a finished AssetDownloader run (failed / missing / corrupt / disk-full files; an offline run reports nothing).</summary>
        public void OnAssetReport(AssetDownloadReport report) => Guarded(() => Reporter.ReportAssetDownload(_clock(), report));

        /// <summary>Reports the client's failed API calls (ApiClient.RequestFailed; business answers are skipped).</summary>
        public void Attach(ApiClient api) => Reporter.AttachTo(api, _clock);

        /// <summary>R20 integration (§58.10): the player id goes with a report only while the §58 analytics choice is effective.</summary>
        public void FollowConsent(ConsentModel consent)
        {
            if (consent == null) throw new ArgumentNullException(nameof(consent));
            Reporter.FollowConsent(() => consent.State);
        }

        /// <summary>Reports the room's desync messages for an online race (race id and tick; never inputs).</summary>
        public void WatchRace(LockstepClient race, string mode) => Reporter.WatchRace(race, mode, _clock);

        private static void Guarded(Action a)
        {
            if (_reporting) return;
            _reporting = true;
            try { a(); }
            catch (Exception) { /* reporting must never throw into the game */ }
            finally { _reporting = false; }
        }

        /// <summary>"NullReferenceException: Object reference…" → (type, message). Other lines keep the whole text as the message.</summary>
        public static (string Type, string Message) SplitCondition(string condition, GameLogType type)
        {
            var c = condition ?? "";
            int i = c.IndexOf(": ", StringComparison.Ordinal);
            if (i > 0 && i <= 80)
            {
                var head = c.Substring(0, i);
                bool ident = true;
                foreach (var ch in head) if (!(char.IsLetterOrDigit(ch) && ch < 128) && ch != '.' && ch != '_' && ch != '`') { ident = false; break; }
                if (ident && (head.EndsWith("Exception", StringComparison.Ordinal) || head.EndsWith("Error", StringComparison.Ordinal))) return (head, c.Substring(i + 2));
            }
            return (type == GameLogType.Assert ? "Assert" : type == GameLogType.Error ? "LogError" : "Exception", c);
        }
    }
}
