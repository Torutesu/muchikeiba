using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // 画質・省電力・通信量の設定 (REQ-PERF-001..018, contracts/protocol.md §56, docs/handoff-codex-round19-performance-settings.md).
    // Pure C# (no UnityEngine). The settings live on this device only (§56.6): no server call. Codex binds RenderProfile to
    // QualitySettings / Application.targetFrameRate / the URP asset and calls SetInRace / OnLowPowerModeChanged; nothing here
    // reaches the race engine (PerformanceSettingsTests.RaceHashIsTheSameForEverySetting).

    public sealed class PerformanceChoice
    {
        /// <summary>The wire value ("auto", "medium", "30", "on"…), passed back to <see cref="PerformanceSettingsModel.Set"/>.</summary>
        public string Value;
        public string Label;
        public bool Selected;
    }

    public sealed class PerformanceRow
    {
        /// <summary>graphics | frameRate | batterySaver | dataSaver.</summary>
        public string Key;
        public string Label, Description;
        public List<PerformanceChoice> Choices = new List<PerformanceChoice>();
        /// <summary>What "auto" currently means on this device ("自動：中"), or null.</summary>
        public string AutoNote;
    }

    public sealed class PerformanceSettingsModel
    {
        /// <summary>The device copy (PerformanceSettings.ToJson). Never sent to the server.</summary>
        public const string KeyBlob = "muchi.perf.settings";

        public const string TextTitle = "画質・通信量";
        public const string TextSubtitle = "この端末だけの設定です。レースの結果は変わりません";
        public const string TextGroupDisplay = "表示";
        public const string TextGroupData = "電池・通信";
        public const string TextGraphics = "画質";
        public const string TextGraphicsDesc = "影・解像度・エフェクトの細かさ";
        public const string TextFrameRate = "フレームレート";
        public const string TextFrameRateDesc = "1秒に描く枚数の上限";
        public const string TextBattery = "省電力";
        public const string TextBatteryDesc = "レースの外は30fps、演出を控えめにします";
        public const string TextDataSaver = "データセーバー";
        public const string TextDataSaverDesc = "必須でないデータは Wi-Fi のときだけ。軽い版を使います";
        public const string TextAuto = "自動";
        public const string TextLow = "低";
        public const string TextMedium = "中";
        public const string TextHigh = "高";
        public const string TextOn = "オン";
        public const string TextOff = "オフ";
        public const string TextAutoIs = "自動：{value}";
        public const string TextNow = "いまの表示：画質 {tier}・{fps}fps・描画 {scale}%";
        public const string TextNowSaver = "いまの表示：画質 {tier}・{fps}fps・描画 {scale}%・省電力";
        public const string TextOsLowPower = "端末の省電力モード中のため、省電力で表示しています";
        public const string TextFairness = "どの設定もレースの計算には関係しません。結果や公平さは同じです。";
        public const string TextStorage = "ストレージ";

        private readonly IKeyValueStore _kv;
        private readonly IDeviceInfo _device;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clockMs;
        private readonly Func<bool> _reduceMotion;

        public PerformanceSettingsModel(IKeyValueStore store, IDeviceInfo device, Action<AnalyticsEvent> track = null, Func<long> clockMs = null, Func<bool> reduceMotion = null)
        {
            _kv = store ?? new MemoryKeyValueStore();
            _device = device ?? new StaticDeviceInfo();
            _track = track;
            _clockMs = clockMs ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _reduceMotion = reduceMotion ?? (() => false);
            DeviceClass = DeviceClassifier.Classify(_device.Profile);
            LowPowerMode = _device.LowPowerMode;
            Settings = PerformanceSettings.Parse(_kv.Get(KeyBlob)); // REQ-PERF-011: from the first frame, offline too
            Profile = Resolve();
        }

        // ---------------------------------------------------------------- what screens bind
        public PerformanceSettings Settings { get; private set; }
        /// <summary>Decided once at start-up (REQ-PERF-002).</summary>
        public DeviceClass DeviceClass { get; }
        public bool LowPowerMode { get; private set; }
        public bool InRace { get; private set; }
        /// <summary>The values to apply now (QualitySettings level, targetFrameRate, renderScale, MSAA, shadows, budgets, effects).</summary>
        public RenderProfile Profile { get; private set; }
        /// <summary>Raised when <see cref="Profile"/> changes (a setting, entering / leaving a race, the OS low-power switch).</summary>
        public event Action<RenderProfile> Changed;
        /// <summary>Raised when the data saver changes (AssetPreloadModel.OnDownloadPolicyChanged, the storage screen).</summary>
        public event Action DownloadPolicyChanged;
        /// <summary>The asset download policy of the current data saver (§56.4).</summary>
        public AssetDownloadPolicy DownloadPolicy => AssetDownloadPolicy.For(Settings);

        public int UrpQualityLevel => Profile.UrpQualityLevel;
        public int TargetFrameRate => Profile.TargetFrameRate;
        public float RenderScale => Profile.RenderScale;

        private RenderProfile Resolve() => RenderProfile.Resolve(Settings, new PerformanceContext
        {
            DeviceClass = DeviceClass, InRace = InRace, OsLowPowerMode = LowPowerMode, ReduceMotion = _reduceMotion(),
            MaxRefreshHz = _device.Profile?.MaxRefreshHz ?? 60,
        });

        private void Recompute()
        {
            var next = Resolve();
            bool same = next.Tier == Profile.Tier && next.TargetFrameRate == Profile.TargetFrameRate && next.RenderScale == Profile.RenderScale && next.Shadows == Profile.Shadows
                && next.Msaa == Profile.Msaa && next.ParticleScale == Profile.ParticleScale && next.PostProcessing == Profile.PostProcessing && next.SpeedLines == Profile.SpeedLines
                && next.FovKick == Profile.FovKick && next.AmbientMotion == Profile.AmbientMotion && next.BatterySaverActive == Profile.BatterySaverActive;
            Profile = next;
            if (!same) Changed?.Invoke(next);
        }

        /// <summary>Call when a race screen opens (true) and closes (false): the battery saver's 30 fps is for menus only.</summary>
        public void SetInRace(bool inRace) { if (InRace == inRace) return; InRace = inRace; Recompute(); }
        /// <summary>The OS low-power mode switched (it counts as the battery saver; the setting is left as it is).</summary>
        public void OnLowPowerModeChanged(bool on) { if (LowPowerMode == on) return; LowPowerMode = on; Recompute(); }
        /// <summary>The accessibility setting changed (AccessibilityModel.Changed): speed lines / FOV kick / drift follow it.</summary>
        public void OnReduceMotionChanged() => Recompute();

        /// <summary>
        /// A settings-screen button. Applied and stored at once; perf_setting_change only when the value really changed.
        /// False for an unknown key / value or the same value.
        /// </summary>
        public bool Set(string key, string value)
        {
            var next = Settings.Clone();
            if (!next.Apply(key, value) || next.SameValues(Settings)) return false;
            bool dataSaver = next.DataSaver != Settings.DataSaver;
            Settings = next;
            _kv.Set(KeyBlob, next.ToJson());
            _track?.Invoke(AnalyticsEvent.PerfSettingChange(_clockMs(), key, value, DeviceClass));
            Recompute();
            if (dataSaver) DownloadPolicyChanged?.Invoke();
            return true;
        }

        // ---------------------------------------------------------------- the settings screen
        public static string TierLabel(QualityTier t) => Loc.T(t == QualityTier.Low ? TextLow : t == QualityTier.High ? TextHigh : TextMedium);

        /// <summary>The four rows (display: graphics, frame rate; battery and data: battery saver, data saver), the current choice selected.</summary>
        public List<PerformanceRow> Rows()
        {
            var s = Settings;
            PerformanceRow Row(string key, string label, string desc, string current, string autoNote, params (string v, string l)[] choices)
            {
                var r = new PerformanceRow { Key = key, Label = Loc.T(label), Description = Loc.T(desc), AutoNote = autoNote };
                foreach (var (v, l) in choices) r.Choices.Add(new PerformanceChoice { Value = v, Label = Loc.T(l), Selected = v == current });
                return r;
            }
            var auto = RenderProfile.Resolve(new PerformanceSettings(), new PerformanceContext { DeviceClass = DeviceClass, InRace = true, MaxRefreshHz = _device.Profile?.MaxRefreshHz ?? 60 });
            string AutoIs(string v) => Loc.T(TextAutoIs).Replace("{value}", v);
            return new List<PerformanceRow>
            {
                Row(PerformanceSettings.KeyGraphics, TextGraphics, TextGraphicsDesc, s.Value(PerformanceSettings.KeyGraphics), AutoIs(TierLabel(auto.Tier)),
                    ("auto", TextAuto), ("low", TextLow), ("medium", TextMedium), ("high", TextHigh)),
                Row(PerformanceSettings.KeyFrameRate, TextFrameRate, TextFrameRateDesc, s.Value(PerformanceSettings.KeyFrameRate), AutoIs(auto.TargetFrameRate.ToString(CultureInfo.InvariantCulture) + "fps"),
                    ("auto", TextAuto), ("30", "30"), ("60", "60")),
                Row(PerformanceSettings.KeyBatterySaver, TextBattery, TextBatteryDesc, s.Value(PerformanceSettings.KeyBatterySaver), null, ("off", TextOff), ("on", TextOn)),
                Row(PerformanceSettings.KeyDataSaver, TextDataSaver, TextDataSaverDesc, s.Value(PerformanceSettings.KeyDataSaver), null, ("off", TextOff), ("on", TextOn)),
            };
        }

        /// <summary>"いまの表示：画質 中・60fps・描画 85%" (what is in force now, menus).</summary>
        public string NowLine
        {
            get
            {
                var p = Profile;
                return Loc.T(p.BatterySaverActive ? TextNowSaver : TextNow).Replace("{tier}", TierLabel(p.Tier))
                    .Replace("{fps}", p.TargetFrameRate.ToString(CultureInfo.InvariantCulture)).Replace("{scale}", ((int)Math.Round(p.RenderScale * 100)).ToString(CultureInfo.InvariantCulture));
            }
        }

        /// <summary>Shown while the OS low-power mode makes the battery saver apply with the setting off (null otherwise).</summary>
        public string LowPowerNote => LowPowerMode && !Settings.BatterySaver ? Loc.T(TextOsLowPower) : null;
    }

    // ==================================================================================== storage screen (§56.8)

    public sealed class StorageLine
    {
        /// <summary>required | screens | ondemand | low | partial | stale.</summary>
        public string Kind;
        public string Label;
        public long Bytes;
        public string SizeLabel;
    }

    public enum PredownloadState { Idle, NeedsConfirm, Running, Done }

    /// <summary>
    /// The storage screen (REQ-PERF-008/013/014): usage by row, 「すべてダウンロード」 with its size first (a confirmation on
    /// cellular; not available on cellular with the data saver on), progress, and 「キャッシュを削除」 behind a confirmation
    /// that never removes a required or in-flight file. Device only.
    /// </summary>
    public sealed class StorageModel
    {
        public const string TextTitle = "ストレージ";
        public const string TextSubtitle = "ダウンロードしたデータの容量。アカウントや進み具合は消えません";
        public const string TextRequired = "必須データ";
        public const string TextScreens = "画面のデータ";
        public const string TextOnDemand = "都度のデータ（実況の馬名など）";
        public const string TextLowRows = "軽量版";
        public const string TextPartial = "途中のダウンロード";
        public const string TextStale = "古いデータ";
        public const string TextTotal = "合計 {size}";
        public const string TextPredownload = "すべてダウンロード";
        public const string TextPredownloadSize = "あと {size}";
        public const string TextAllDownloaded = "すべてダウンロード済みです";
        public const string TextNeedsWifi = "データセーバー中は Wi-Fi に接続すると実行できます";
        public const string TextOffline = "オフラインのためダウンロードできません";
        public const string TextCellularConfirm = "モバイル通信で約{size}のデータをダウンロードします。Wi-Fi への接続をおすすめします。";
        public const string TextDownloadNow = "ダウンロードする";
        public const string TextCancel = "やめる";
        public const string TextDone = "ダウンロードが終わりました";
        public const string TextQuota = "空き容量が足りないため、一部はダウンロードしていません";
        public const string TextFailed = "一部のデータを取得できませんでした。あとでもう一度お試しください";
        public const string TextClear = "キャッシュを削除";
        public const string TextClearConfirm = "ダウンロードしたデータを削除します（{size}）。遊ぶのに必要なデータとアカウント・進み具合は消えません。";
        public const string TextClearDo = "削除する";
        public const string TextCleared = "{size} を削除しました";
        public const string TextNothingToClear = "削除できるデータはありません";
        public const string TextLowVariant = "データセーバー：軽量版をダウンロードします";

        private readonly AssetDownloader _downloader;
        private readonly Func<AssetCatalog> _catalog;
        private readonly Func<NetworkReach> _network;
        private readonly Func<AssetDownloadPolicy> _policy;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clockMs;
        private long _doneBytes;

        public StorageModel(AssetDownloader downloader, Func<AssetCatalog> catalog, Func<NetworkReach> network, Func<AssetDownloadPolicy> policy, Action<AnalyticsEvent> track = null, Func<long> clockMs = null)
        {
            _downloader = downloader ?? throw new ArgumentNullException(nameof(downloader));
            _catalog = catalog ?? (() => null);
            _network = network ?? (() => NetworkReach.Wifi);
            _policy = policy ?? (() => AssetDownloadPolicy.Default);
            _track = track;
            _clockMs = clockMs ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Refresh();
        }

        public StorageReport Report { get; private set; }
        public PredownloadState State { get; private set; } = PredownloadState.Idle;
        /// <summary>The last toast (done / quota / cleared…), or null.</summary>
        public string Message { get; private set; }
        public Task PredownloadTask { get; private set; } = Task.CompletedTask;
        private AssetCatalog Catalog => _catalog() ?? AssetCatalog.Empty("");

        public void Refresh() => Report = AssetStorage.Measure(Catalog, _downloader.Cache, _policy());

        public static string Size(long n) => AssetStorage.FormatBytes(n);

        public List<StorageLine> Lines()
        {
            string LabelOf(string k) => Loc.T(k == "required" ? TextRequired : k == "screens" ? TextScreens : k == "ondemand" ? TextOnDemand : k == "low" ? TextLowRows : k == "partial" ? TextPartial : TextStale);
            return Report.Rows.Select(r => new StorageLine { Kind = r.Kind, Label = LabelOf(r.Kind), Bytes = r.Bytes, SizeLabel = Size(r.Bytes) }).ToList();
        }

        public string TotalLabel => Loc.T(TextTotal).Replace("{size}", Size(Report.TotalBytes));
        public long PredownloadBytes => Report.PredownloadBytes;
        /// <summary>"あと 123.4MB" under the button, or 「すべてダウンロード済みです」.</summary>
        public string PredownloadLabel => PredownloadBytes > 0 ? Loc.T(TextPredownloadSize).Replace("{size}", Size(PredownloadBytes)) : Loc.T(TextAllDownloaded);
        /// <summary>The data saver picks low variants (a line under the size).</summary>
        public string VariantNote => _policy().DataSaver ? Loc.T(TextLowVariant) : null;

        /// <summary>Why the button is disabled now (null = it can be pressed).</summary>
        public string PredownloadBlockedReason
        {
            get
            {
                if (State == PredownloadState.Running) return null;
                if (PredownloadBytes <= 0) return Loc.T(TextAllDownloaded);
                var net = _network();
                if (net == NetworkReach.None || !Catalog.HasCdn) return Loc.T(TextOffline);
                if (net == NetworkReach.Cellular && _policy().DataSaver) return Loc.T(TextNeedsWifi);
                return null;
            }
        }
        public bool CanPredownload => State != PredownloadState.Running && PredownloadBlockedReason == null;
        public string CellularConfirmText => Loc.T(TextCellularConfirm).Replace("{size}", Size(PredownloadBytes));
        public float Progress => State == PredownloadState.Done ? 1f : _startBytes <= 0 ? 0f : Math.Min(1f, (float)Interlocked.Read(ref _doneBytes) / _startBytes);
        private long _startBytes;

        /// <summary>
        /// The button. On cellular the first call only asks (<see cref="PredownloadState.NeedsConfirm"/>; show
        /// <see cref="CellularConfirmText"/>, then call again with <paramref name="confirmed"/> = true). asset_predownload once per start.
        /// </summary>
        public Task StartPredownloadAsync(bool confirmed = false, CancellationToken ct = default)
        {
            if (!CanPredownload) return PredownloadTask;
            if (_network() == NetworkReach.Cellular && !confirmed) { State = PredownloadState.NeedsConfirm; return Task.CompletedTask; }
            var policy = _policy();
            var set = AssetStorage.PredownloadSet(Catalog, policy);
            _startBytes = PredownloadBytes;
            Interlocked.Exchange(ref _doneBytes, 0);
            State = PredownloadState.Running;
            Message = null;
            _track?.Invoke(AnalyticsEvent.AssetPredownload(_clockMs(), _startBytes, policy.DataSaver));
            PredownloadTask = Run(set, ct);
            return PredownloadTask;
        }

        /// <summary>「やめる」 in the cellular confirmation.</summary>
        public void CancelConfirm() { if (State == PredownloadState.NeedsConfirm) State = PredownloadState.Idle; }

        private async Task Run(List<AssetEntry> set, CancellationToken ct)
        {
            var groups = new Dictionary<string, long>();
            AssetDownloadReport r;
            try
            {
                r = await _downloader.DownloadAsync(Catalog, set, p =>
                {
                    lock (groups) { groups[p.Group] = p.DoneBytes; }
                    long done; lock (groups) done = groups.Values.Sum();
                    Interlocked.Exchange(ref _doneBytes, done);
                }, ct);
            }
            catch (OperationCanceledException) { r = null; }
            Refresh();
            State = PredownloadState.Done;
            Message = r == null ? null : r.QuotaExceeded ? Loc.T(TextQuota) : !r.AllOk ? Loc.T(TextFailed) : Loc.T(TextDone);
        }

        /// <summary>The confirmation of 「キャッシュを削除」 (with what it frees), or null when there is nothing to delete.</summary>
        public string ClearConfirmText => Report.ClearableBytes > 0 ? Loc.T(TextClearConfirm).Replace("{size}", Size(Report.ClearableBytes)) : null;

        /// <summary>Confirmed 「削除する」: optional, low, partial and stale files go; required and in-flight files stay (REQ-PERF-014).</summary>
        public EvictionResult ClearCache()
        {
            var r = _downloader.ClearOptional(Catalog);
            Refresh();
            Message = r.Bytes > 0 ? Loc.T(TextCleared).Replace("{size}", Size(r.Bytes)) : Loc.T(TextNothingToClear);
            return r;
        }
    }
}
