using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>What the device is connected through (Unity: Application.internetReachability).</summary>
    public enum NetworkReach { None, Cellular, Wifi }

    public enum PreloadPhase { Idle, Checking, Downloading, Ready, Offline }

    public enum BackgroundState { Idle, Deferred, Running, Done }

    /// <summary>
    /// Boot / FTUE download screen (REQ-DLV-009, docs/planning/06 §2): fetch the asset catalog (cached copy offline),
    /// evict stale files, then
    /// <list type="bullet">
    /// <item>download the <b>blocking</b> set — required boot/ftue entries not bundled in the app (small: the server caps it
    ///   at policy.ftueBlockingMaxBytes) — and let the tutorial start as soon as it is done, failed, offline, or after
    ///   policy.tutorialMaxWaitMs (≤ 5 s) whatever happens: <see cref="CanStartTutorial"/>. Optional assets never gate it,
    ///   so the first race starts within the 06 §2 budget and the aha (≤ 30 s) never waits for art;</item>
    /// <item>download the <b>background</b> set (everything else in boot/ftue/home/race/shop, not ondemand) without blocking.
    ///   On cellular above policy.cellularWarnBytes it waits for the player's choice (<see cref="NeedsConsent"/>,
    ///   <see cref="AcceptCellular"/> / <see cref="DeferToWifi"/>) and resumes by itself on Wi-Fi (<see cref="OnNetworkChanged"/>).</item>
    /// </list>
    /// Keys that are not on the device resolve to their kind's placeholder through <see cref="Resolver"/>.
    /// Pure C#: the scene calls <see cref="PrepareAsync"/> once, reads the properties every frame and shows
    /// <see cref="StatusLine"/>, the sizes and the cellular dialog.
    /// </summary>
    public sealed class AssetPreloadModel
    {
        public static readonly string[] BlockingGroups = { AssetGroups.Boot, AssetGroups.Ftue };
        public static readonly string[] BackgroundGroups = { AssetGroups.Boot, AssetGroups.Ftue, AssetGroups.Home, AssetGroups.Race, AssetGroups.Shop };

        public const string TextChecking = "データを確認しています…";
        public const string TextDownloading = "ダウンロード中";
        public const string TextReady = "準備ができました";
        public const string TextOffline = "オフラインのため、一部の絵や音は仮の表示で進みます";
        public const string TextPartial = "一部のデータを取得できませんでした。仮の表示で進みます";
        public const string TextDiskFull = "端末の空き容量が足りません。一部のデータは仮の表示で進みます";

        private readonly AssetCatalogStore _catalogs;
        private readonly AssetDownloader _downloader;
        private readonly Func<NetworkReach> _network;
        private readonly Func<string, bool> _bundled;
        private readonly Func<long> _clockMs;
        private readonly Dictionary<string, AssetGroupProgress> _progress = new Dictionary<string, AssetGroupProgress>();
        private readonly object _lock = new object();
        private long _shownAtMs;
        private long _blockingDoneBytes;
        private bool _decided;
        private CancellationToken _ct;

        public AssetPreloadModel(AssetCatalogStore catalogs, AssetDownloader downloader, Func<NetworkReach> network, Func<string, bool> bundled, Func<long> clockMs = null)
        {
            _catalogs = catalogs ?? throw new ArgumentNullException(nameof(catalogs));
            _downloader = downloader ?? throw new ArgumentNullException(nameof(downloader));
            _network = network ?? (() => NetworkReach.Wifi);
            _bundled = bundled ?? (_ => false);
            _clockMs = clockMs ?? (() => Environment.TickCount);
        }

        // ------------------------------------------------------------------ state for the screen

        public PreloadPhase Phase { get; private set; } = PreloadPhase.Idle;
        public BackgroundState Background { get; private set; } = BackgroundState.Idle;
        public AssetCatalog Catalog { get; private set; }
        public AssetPolicy Policy => Catalog?.Policy ?? new AssetPolicy();
        public AssetResolver Resolver { get; private set; } = new AssetResolver(null, null, null);
        public AssetDownloadReport BlockingReport { get; private set; }
        public AssetDownloadReport BackgroundReport { get; private set; }

        /// <summary>Bytes the tutorial may wait for (required boot/ftue, not bundled, not cached).</summary>
        public long BlockingBytes { get; private set; }
        /// <summary>Bytes fetched later without blocking.</summary>
        public long BackgroundBytes { get; private set; }
        public long TotalBytes => BlockingBytes + BackgroundBytes;
        public string BlockingSizeLabel => FormatBytes(BlockingBytes);
        public string BackgroundSizeLabel => FormatBytes(BackgroundBytes);
        public string TotalSizeLabel => FormatBytes(TotalBytes);

        /// <summary>Cellular and the background download is over policy.cellularWarnBytes: show the dialog with the size.</summary>
        public bool ShowCellularWarning => _network() == NetworkReach.Cellular && BackgroundBytes > Policy.CellularWarnBytes;
        /// <summary>The dialog is waiting for an answer (the blocking set downloads meanwhile; the tutorial is not held).</summary>
        public bool NeedsConsent => Background == BackgroundState.Deferred && ShowCellularWarning && !_decided && Phase != PreloadPhase.Offline;
        public string CellularWarningText => "モバイル通信で約" + FormatBytes(BackgroundBytes) + "のデータをダウンロードします。Wi-Fi への接続をおすすめします。";

        public bool BlockingDone { get; private set; }
        public float BlockingFraction => BlockingBytes <= 0 ? 1f : Math.Min(1f, (float)Interlocked.Read(ref _blockingDoneBytes) / BlockingBytes);
        public long ElapsedMs => Phase == PreloadPhase.Idle ? 0 : _clockMs() - _shownAtMs;

        /// <summary>
        /// The first tutorial race may start: the blocking set is done (or failed), we are offline, or the wait budget ran out
        /// (policy.tutorialMaxWaitMs, capped at 5 s). Never depends on optional assets.
        /// </summary>
        public bool CanStartTutorial
            => Phase == PreloadPhase.Ready || Phase == PreloadPhase.Offline || BlockingDone
               || Phase != PreloadPhase.Idle && ElapsedMs >= Math.Min(Policy.TutorialMaxWaitMs, AssetPolicy.TutorialMaxWaitHardMs);

        /// <summary>The tutorial started before the blocking set finished: those keys show placeholders until it does.</summary>
        public bool StartedWithPlaceholders => CanStartTutorial && !BlockingDone && Phase == PreloadPhase.Downloading;

        public string StatusLine
        {
            get
            {
                switch (Phase)
                {
                    case PreloadPhase.Idle:
                    case PreloadPhase.Checking: return TextChecking;
                    case PreloadPhase.Offline: return TextOffline;
                    case PreloadPhase.Downloading: return TextDownloading + " " + (int)Math.Round(BlockingFraction * 100) + "%（" + BlockingSizeLabel + "）";
                    default:
                        if (BlockingReport != null && BlockingReport.QuotaExceeded) return TextDiskFull;
                        if (BlockingReport != null && !BlockingReport.AllOk) return BlockingReport.Offline ? TextOffline : TextPartial;
                        return TextReady;
                }
            }
        }

        public AssetGroupProgress GroupProgress(string group)
        {
            lock (_lock) return _progress.TryGetValue(group, out var p) ? p.Clone() : null;
        }

        /// <summary>Completes when the blocking set is done (tests and scenes that prefer to await).</summary>
        public Task BlockingTask { get; private set; } = Task.CompletedTask;
        public Task BackgroundTask { get; private set; } = Task.CompletedTask;

        // ------------------------------------------------------------------ flow

        /// <summary>
        /// Call when the download screen appears. Returns once the catalog is known and the downloads are started; the
        /// screen then polls <see cref="CanStartTutorial"/> (the blocking download continues in <see cref="BlockingTask"/>).
        /// </summary>
        public async Task PrepareAsync(CancellationToken ct = default)
        {
            _ct = ct;
            _shownAtMs = _clockMs();
            Phase = PreloadPhase.Checking;
            Catalog = await _catalogs.RefreshAsync(ct);
            Resolver = new AssetResolver(Catalog, _downloader.Cache, _bundled);
            if (_catalogs.Source == CatalogSource.Network) _downloader.EvictStale(Catalog); // a new version replaces old files

            var blocking = Catalog.InGroups(BlockingGroups, true).Where(e => !_bundled(e.Key)).ToList();
            var blockingShas = new HashSet<string>(blocking.Select(e => e.Sha256));
            var background = Catalog.InGroups(BackgroundGroups).Where(e => !_bundled(e.Key) && !blockingShas.Contains(e.Sha256)).ToList();
            BlockingBytes = _downloader.PendingBytes(blocking);
            BackgroundBytes = _downloader.PendingBytes(background);

            bool offline = _catalogs.Offline || !Catalog.HasCdn || _network() == NetworkReach.None;
            if (offline && BlockingBytes + BackgroundBytes > 0 || _catalogs.Source == CatalogSource.Empty)
            {
                Phase = PreloadPhase.Offline;
                BlockingDone = true;
                Background = BackgroundState.Deferred;
                _pendingBackground = background;
                return;
            }

            if (BlockingBytes > 0)
            {
                Phase = PreloadPhase.Downloading;
                BlockingTask = RunBlocking(blocking, ct);
            }
            else
            {
                BlockingDone = true;
                Phase = PreloadPhase.Ready;
            }

            _pendingBackground = background;
            if (BackgroundBytes == 0) Background = BackgroundState.Done;
            else if (ShowCellularWarning) Background = BackgroundState.Deferred;
            else StartBackground();
        }

        private List<AssetEntry> _pendingBackground = new List<AssetEntry>();

        private async Task RunBlocking(List<AssetEntry> blocking, CancellationToken ct)
        {
            long baseline = BlockingBytes;
            try
            {
                BlockingReport = await _downloader.DownloadAsync(Catalog, blocking, p =>
                {
                    Track(p);
                    long done = 0;
                    lock (_lock) foreach (var g in BlockingGroups) if (_progress.TryGetValue(g, out var x)) done += x.DoneBytes;
                    Interlocked.Exchange(ref _blockingDoneBytes, Math.Min(baseline, done));
                }, ct);
            }
            catch (OperationCanceledException) { BlockingReport = new AssetDownloadReport(); }
            Interlocked.Exchange(ref _blockingDoneBytes, BlockingBytes);
            BlockingDone = true;
            Phase = BlockingReport.Offline ? PreloadPhase.Offline : PreloadPhase.Ready;
        }

        private void Track(AssetGroupProgress p) { lock (_lock) _progress[p.Group] = p; }

        private void StartBackground()
        {
            if (Background == BackgroundState.Running || Background == BackgroundState.Done) return;
            Background = BackgroundState.Running;
            BackgroundTask = RunBackground(_pendingBackground);
        }

        // Stays on the caller's context (Unity main thread): UnityWebRequest must not be used from the thread pool.
        private async Task RunBackground(List<AssetEntry> list)
        {
            await BlockingTask; // the blocking set gets the bandwidth first
            try { BackgroundReport = await _downloader.DownloadAsync(Catalog, list, Track, _ct); }
            catch (OperationCanceledException) { BackgroundReport = new AssetDownloadReport(); }
            Background = BackgroundState.Done;
        }

        /// <summary>"Download now" in the cellular dialog.</summary>
        public void AcceptCellular()
        {
            _decided = true;
            if (Background == BackgroundState.Deferred && Phase != PreloadPhase.Offline) StartBackground();
        }

        /// <summary>"Later (on Wi-Fi)": keep the background set deferred; the tutorial goes on with placeholders.</summary>
        public void DeferToWifi() { _decided = true; }

        /// <summary>Call when reachability changes: a deferred background download starts on Wi-Fi.</summary>
        public void OnNetworkChanged()
        {
            if (Background == BackgroundState.Deferred && Phase != PreloadPhase.Offline && _network() == NetworkReach.Wifi) StartBackground();
        }

        /// <summary>"12.3MB" / "850KB" (decimal units, like the stores show sizes).</summary>
        public static string FormatBytes(long n)
        {
            if (n <= 0) return "0MB";
            if (n < 1_000_000) return Math.Max(1, (int)Math.Round(n / 1000.0)).ToString(CultureInfo.InvariantCulture) + "KB";
            if (n < 1_000_000_000) return (n / 1_000_000.0).ToString("0.0", CultureInfo.InvariantCulture) + "MB";
            return (n / 1_000_000_000.0).ToString("0.00", CultureInfo.InvariantCulture) + "GB";
        }
    }
}
