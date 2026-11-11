using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // メンテナンス・強制アップデート (REQ-MNT-004..016, contracts/protocol.md §46, docs/handoff-codex-round17-maintenance.md),
    // the game layer. Pure C#: Codex's maintenance screen, update screen, home notice strip and the recommended-update sheet
    // bind to the public fields. ApiClient already turns 503 MAINTENANCE / 426 UPGRADE_REQUIRED into events (one place);
    // this model decides which screen shows. Nothing here buys, grants or retries a purchase (receipts are never gated).

    /// <summary>The server call the model needs (ApiClient in the app, a fake in the checks).</summary>
    public interface IMaintenanceApi
    {
        Task<MaintenanceStatus> GetMaintenanceAsync(CancellationToken ct = default);
    }

    /// <summary><see cref="IMaintenanceApi"/> over the real client.</summary>
    public sealed class ApiMaintenance : IMaintenanceApi
    {
        private readonly ApiClient _api;
        public ApiMaintenance(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<MaintenanceStatus> GetMaintenanceAsync(CancellationToken ct = default) => _api.GetMaintenanceAsync(ct);
    }

    /// <summary>Which full screen covers the game. Offline and maintenance are different screens (REQ-MNT-014).</summary>
    public enum MaintenanceScreen { None, Maintenance, UpdateRequired, Offline, /** R19 integration (§54.6): 401 SESSION_REPLACED. */ SessionReplaced }

    /// <summary>
    /// Rules the model keeps:
    ///  - update required (426, or GET /v1/maintenance client.status = required) wins over everything: the update screen
    ///    with the store button; it does not go away by itself;
    ///  - a window with scope "all" covers the game with the maintenance screen (title, message, the end time in JST — no
    ///    countdown, no urgency); a scoped window only closes that feature: <see cref="PartialNotice"/> for the screen
    ///    that was opened, the rest of the game keeps working;
    ///  - offline (no answer at all) shows the offline notice, never the maintenance screen;
    ///  - "再読み込み" asks GET /v1/maintenance (never gated) and leaves the screen when the window is over;
    ///  - an announced window shows the home notice strip (<see cref="Banner"/>); a recommended update shows a sheet once
    ///    per recommended version (<see cref="DismissedVersion"/> is what the app keeps between launches);
    ///  - KPI: maintenance_block once per window × group, upgrade_prompt shown once per kind per run, store / later on tap.
    /// </summary>
    public sealed class MaintenanceModel
    {
        public const string MaintenanceTitle = "メンテナンス中です";
        public const string MaintenanceBody = "ただいまメンテナンスを行っています。終了までしばらくお待ちください。";
        public const string PartialTitle = "この機能はメンテナンス中です";
        public const string PartialBody = "ほかの機能はいつもどおり遊べます。";
        public const string EndsLabel = "終了予定（日本時間）";
        public const string ClosedLabel = "止まっている機能";
        public const string PurchaseNote = "購入済みのコインは、メンテナンス中でも必ず受け取れます。";
        public const string ReloadCta = "再読み込み";
        public const string HomeCta = "ホームへ";
        public const string UpdateTitle = "アップデートのお願い";
        public const string UpdateBody = "新しいバージョンのアプリが公開されています。ストアから更新してください。";
        public const string EngineBody = "レースに参加するには、アプリを最新版に更新してください。";
        public const string StoreCta = "ストアへ";
        public const string VersionLabel = "お使いのバージョン";
        public const string RequiredLabel = "必要なバージョン";
        public const string RecommendTitle = "新しいバージョンがあります";
        public const string RecommendBody = "ストアから更新すると、最新の内容で遊べます。";
        public const string LaterCta = "あとで";
        public const string BannerLabel = "メンテナンスのお知らせ";
        public const string BannerActiveLabel = "メンテナンス中";

        /// <summary>Feature names for a scoped window (the screen joins them with 「・」).</summary>
        public static readonly IReadOnlyDictionary<string, string> GroupNames = new Dictionary<string, string>
        {
            ["gacha"] = "スカウト", ["shop"] = "ショップ", ["ranked"] = "ランク戦", ["teams"] = "支部", ["events"] = "イベント",
            ["tournaments"] = "大会", ["training"] = "調教", ["time_attack"] = "タイムアタック", ["social"] = "フレンド", ["cups"] = "主催カップ", ["core"] = "ゲーム全体",
        };

        private readonly IMaintenanceApi _api;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;
        private readonly string _platform;
        private readonly HashSet<string> _blockSent = new HashSet<string>();
        private readonly HashSet<string> _promptSent = new HashSet<string>();
        private int _generation;

        public MaintenanceModel(IMaintenanceApi api, string platform = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            _api = api;
            _platform = platform;
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public MaintenanceScreen Screen { get; private set; } = MaintenanceScreen.None;
        /// <summary>The window that closed the game (scope all), for the maintenance screen.</summary>
        public MaintenanceInfo Info { get; private set; }
        /// <summary>A scoped window that closed the feature just opened (a sheet over that screen, not the full screen).</summary>
        public MaintenanceInfo PartialNotice { get; private set; }
        public UpgradeInfo Upgrade { get; private set; }
        /// <summary>The next announced (or running) window for the home strip; null = no strip.</summary>
        public MaintenanceWindowView Banner { get; private set; }
        /// <summary>Show the recommended-update sheet (once per recommended version).</summary>
        public bool ShowRecommend { get; private set; }
        public ClientVersionStatus Client { get; private set; }
        /// <summary>The recommended version the player said "あとで" to (the app stores it between launches).</summary>
        public string DismissedVersion { get; set; }
        public bool Loading { get; private set; }

        // ------------------------------------------------------------------ texts the screens bind (Japanese; show Loc.T)

        public string Title => Screen == MaintenanceScreen.SessionReplaced ? TransferCodeModel.ReplacedTitle : Screen == MaintenanceScreen.UpdateRequired ? UpdateTitle : Screen == MaintenanceScreen.Offline ? UxText.Offline : MaintenanceTitle;
        public string Body => Screen == MaintenanceScreen.SessionReplaced ? TransferCodeModel.ReplacedBody : Screen == MaintenanceScreen.UpdateRequired ? (Upgrade?.Reason == "engine" ? EngineBody : UpdateBody) : Screen == MaintenanceScreen.Maintenance ? (Info?.Message ?? MaintenanceBody) : null;
        /// <summary>"11/12 06:00" — the end time (JST) under <see cref="EndsLabel"/>. Not a countdown.</summary>
        public string EndsAt => (Screen == MaintenanceScreen.Maintenance ? Info : PartialNotice)?.EndsAtJst;
        public string StoreUrl => Upgrade?.StoreUrl ?? Client?.StoreUrl;
        public string BannerTimes => Banner == null ? null : Banner.StartJst + (Muchi.Client.Loc.IsEnglish ? " – " : "〜") + Banner.EndJst;
        public string BannerTitle => Banner == null ? null : Banner.Active ? BannerActiveLabel : BannerLabel;
        /// <summary>The closed features of a scoped window, in Japanese (「スカウト・ショップ」).</summary>
        public static string GroupsText(IEnumerable<string> scope) => string.Join("・", (scope ?? Enumerable.Empty<string>()).Select(g => GroupNames.TryGetValue(g, out var n) ? n : g));

        // ------------------------------------------------------------------ wiring

        /// <summary>Listen to the client's one place for 503 / 426 (REQ-MNT-014).</summary>
        public void Attach(ApiClient api)
        {
            if (api == null) throw new ArgumentNullException(nameof(api));
            api.MaintenanceDetected += OnMaintenance;
            api.UpgradeRequired += OnUpgrade;
            api.SessionReplaced += OnSessionReplaced; // R19 integration: §54.6 through the same one place
        }

        /// <summary>
        /// R19 integration (REQ-TRF-010): a request met 401 SESSION_REPLACED — this account now lives on another device. The
        /// strongest screen: maintenance, update, offline and a reload never replace it (the session cannot come back). The
        /// screen offers 「新しく始める」 / 「引き継ぎコードを入力」 (TransferCodeModel); either calls <see cref="LeaveSessionReplaced"/>.
        /// </summary>
        public void OnSessionReplaced()
        {
            bool first = Screen != MaintenanceScreen.SessionReplaced;
            Screen = MaintenanceScreen.SessionReplaced;
            Info = null; PartialNotice = null; ShowRecommend = false;
            if (first) SessionReplacedShown?.Invoke(); // R20 integration: AccountChangeReset (reminders, error queue, prompts)
        }

        /// <summary>R20 integration (§54 × §59–§61): raised once when the SESSION_REPLACED screen appears (see AccountChangeReset).</summary>
        public event Action SessionReplacedShown;

        /// <summary>The player started new or redeemed a code on this device: back to the game (a fresh session).</summary>
        public void LeaveSessionReplaced() { if (Screen == MaintenanceScreen.SessionReplaced) Screen = MaintenanceScreen.None; }

        /// <summary>A request met 503 MAINTENANCE.</summary>
        public void OnMaintenance(MaintenanceInfo info)
        {
            if (info == null) return;
            if (!string.IsNullOrEmpty(info.WindowId) && Array.IndexOf(AnalyticsEvent.MaintenanceGroups, info.Group) >= 0 && _blockSent.Add(info.WindowId + "/" + info.Group))
                _track?.Invoke(AnalyticsEvent.MaintenanceBlock(_clock(), info.Group, info.WindowId));
            if (Screen == MaintenanceScreen.UpdateRequired || Screen == MaintenanceScreen.SessionReplaced) return;
            if (info.All || info.Scope.Count == 0) { Info = info; PartialNotice = null; Screen = MaintenanceScreen.Maintenance; }
            else PartialNotice = info;
        }

        /// <summary>A request met 426 UPGRADE_REQUIRED.</summary>
        public void OnUpgrade(UpgradeInfo info)
        {
            Upgrade = info ?? new UpgradeInfo { Reason = "version" };
            if (Screen == MaintenanceScreen.SessionReplaced) return;
            Screen = MaintenanceScreen.UpdateRequired;
            PromptShown(Upgrade.Reason == "engine" ? "engine" : "required");
        }

        /// <summary>A request got no answer at all (NetworkException). Never replaces the maintenance or update screen.</summary>
        public void OnOffline()
        {
            if (Screen == MaintenanceScreen.None) Screen = MaintenanceScreen.Offline;
        }

        /// <summary>The scoped notice was closed (back to home); the feature stays closed until the window ends.</summary>
        public void DismissPartial() => PartialNotice = null;

        /// <summary>
        /// Launch, home and the 「再読み込み」 button: GET /v1/maintenance. Leaves the maintenance / offline screen when nothing
        /// covers the game any more; never leaves the update screen for a version that is still below the minimum.
        /// </summary>
        public async Task RefreshAsync(CancellationToken ct = default)
        {
            if (Screen == MaintenanceScreen.SessionReplaced) return; // nothing a reload can change
            int gen = ++_generation;
            Loading = true;
            try
            {
                MaintenanceStatus s;
                try { s = await _api.GetMaintenanceAsync(ct); }
                catch (NetworkException)
                {
                    if (gen == _generation) OnOffline();
                    return;
                }
                if (gen != _generation) return; // a newer refresh is on its way
                Client = s.Client;
                Banner = s.Active.FirstOrDefault() ?? s.Upcoming.FirstOrDefault();
                var all = s.Active.FirstOrDefault(w => w.All);
                if (s.Client.Required)
                {
                    if (Screen != MaintenanceScreen.UpdateRequired)
                        OnUpgrade(new UpgradeInfo { Reason = "version", Platform = s.Client.Platform, Version = s.Client.Version, MinVersion = s.Client.MinVersion, RecommendedVersion = s.Client.RecommendedVersion, StoreUrl = s.Client.StoreUrl });
                }
                else if (Screen == MaintenanceScreen.UpdateRequired && Upgrade?.Reason != "engine")
                {
                    Screen = MaintenanceScreen.None; Upgrade = null; // the minimum was lowered (or the app was updated)
                }
                if (Screen != MaintenanceScreen.UpdateRequired)
                {
                    if (all != null)
                    {
                        Info = new MaintenanceInfo { WindowId = all.Id, Group = "core", Scope = all.Scope, StartAt = all.StartAt, EndAt = all.EndAt, EndsAtJst = all.EndJst, Message = all.Message };
                        Screen = MaintenanceScreen.Maintenance;
                    }
                    else if (Screen == MaintenanceScreen.Maintenance || Screen == MaintenanceScreen.Offline)
                    {
                        Screen = MaintenanceScreen.None; Info = null;
                    }
                    if (PartialNotice != null && !s.Active.Any(w => w.Id == PartialNotice.WindowId)) PartialNotice = null;
                }
                bool recommend = s.Client.Recommended && s.Client.RecommendedVersion != null && s.Client.RecommendedVersion != DismissedVersion && Screen == MaintenanceScreen.None;
                if (recommend && !ShowRecommend) PromptShown("recommended");
                ShowRecommend = recommend;
            }
            finally { if (gen == _generation) Loading = false; }
        }

        /// <summary>The store button (update screen or recommended sheet): the URL to open, and upgrade_prompt store.</summary>
        public string OpenStore()
        {
            string kind = Screen == MaintenanceScreen.UpdateRequired ? (Upgrade?.Reason == "engine" ? "engine" : "required") : "recommended";
            _track?.Invoke(AnalyticsEvent.UpgradePrompt(_clock(), kind, "store", _platform));
            return StoreUrl;
        }

        /// <summary>「あとで」 on the recommended sheet: hidden until a newer recommended version (keep <see cref="DismissedVersion"/>).</summary>
        public void Later()
        {
            if (!ShowRecommend) return;
            DismissedVersion = Client?.RecommendedVersion;
            ShowRecommend = false;
            _track?.Invoke(AnalyticsEvent.UpgradePrompt(_clock(), "recommended", "later", _platform));
        }

        private void PromptShown(string kind)
        {
            if (_promptSent.Add(kind)) _track?.Invoke(AnalyticsEvent.UpgradePrompt(_clock(), kind, "shown", _platform));
        }
    }
}
