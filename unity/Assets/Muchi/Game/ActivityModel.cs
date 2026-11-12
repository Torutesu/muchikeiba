using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-ACT-001..016 (contracts/protocol.md §40, docs/handoff-codex-round15-activity.md): アクティビティ, the game layer.
    // Pure C#: Codex's bell and screen bind to the public fields. Display + deep links only — nothing here claims or grants
    // (a gift entry leads to the gift box, which stays the one place to claim).

    /// <summary>The server calls the activity screen needs (ApiClient in the app, a fake in the checks).</summary>
    public interface IActivityApi
    {
        Task<ActivityPage> GetActivityAsync(string cursor = null, int limit = 20, CancellationToken ct = default);
        Task<ActivityReadResult> MarkActivityReadAsync(string upTo = null, CancellationToken ct = default);
    }

    /// <summary><see cref="IActivityApi"/> over the real client.</summary>
    public sealed class ApiActivity : IActivityApi
    {
        private readonly ApiClient _api;
        public ApiActivity(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<ActivityPage> GetActivityAsync(string cursor = null, int limit = 20, CancellationToken ct = default) => _api.GetActivityAsync(cursor, limit, ct);
        public Task<ActivityReadResult> MarkActivityReadAsync(string upTo = null, CancellationToken ct = default) => _api.MarkActivityReadAsync(upTo, ct);
    }

    /// <summary>One row as the screen draws it. Text comes from the server (already English in English mode).</summary>
    public sealed class ActivityLine
    {
        public string Id, Kind, Text, Screen, LinkId;
        /// <summary>"11/09 12:00" (JST).</summary>
        public string When;
        /// <summary>The small cyan label above the text (「フレンド」「ライバル」「プレゼント」…; show Loc.T).</summary>
        public string Label;
        /// <summary>The icon key Codex maps to a sprite (friend / rival / like / cheer / trophy / gift / team / replay).</summary>
        public string Icon;
        /// <summary>The row's call to action (「見る」 or 「プレゼントボックスへ」); never a claim button.</summary>
        public string Cta;
        public int Count;
        public bool Unread;
        public ActivityItem Source;
    }

    /// <summary>
    /// The home bell and the activity screen. Rules the model keeps:
    ///  - the bell shows <see cref="BadgeText"/> (hidden at 0, 「99+」 above the cap);
    ///  - one load at a time; "more" uses the server's cursor as is; a page that arrives after the screen was reopened is dropped;
    ///  - opening sends activity_open once; a tap sends activity_tap and returns the screen to open (<see cref="Tap"/>);
    ///  - after the first page is shown, everything up to its newest id is marked read; a failed mark is retried on the next open;
    ///  - offline: no list, the message <see cref="OfflineText"/>; the bell keeps the last known number.
    /// </summary>
    public sealed class ActivityModel
    {
        public const int PageSize = 20;
        public const int BadgeCap = 99;
        public const string Title = "アクティビティ";
        public const string OfflineText = "アクティビティはオンラインで確認できます";
        public const string EmptyText = "まだお知らせはありません";
        public const string GiftCta = "プレゼントボックスへ";
        public const string ViewCta = "見る";
        public const string WhatsNewText = "新着情報があります";
        public static readonly IReadOnlyDictionary<string, string> Labels = new Dictionary<string, string>
        {
            [ActivityKinds.FriendRequest] = "フレンド", [ActivityKinds.FriendAccepted] = "フレンド", [ActivityKinds.RivalWeek] = "ライバル", [ActivityKinds.RivalRecord] = "ライバル",
            [ActivityKinds.StableLike] = "マイ厩舎", [ActivityKinds.TeamCheer] = "支部", [ActivityKinds.TournamentResult] = "大会", [ActivityKinds.GiftArrived] = "プレゼント",
            [ActivityKinds.TeamGoalTier] = "支部", [ActivityKinds.TeamGoalWeek] = "支部", [ActivityKinds.ReplayShare] = "リプレイ",
            [ActivityKinds.CupInvited] = "カップ", [ActivityKinds.CupStarted] = "カップ", [ActivityKinds.CupFinished] = "カップ", [ActivityKinds.CupCancelled] = "カップ",
            [ActivityKinds.RecapReady] = "振り返り",
            [ActivityKinds.OpsNotice] = "運営",
            [ActivityKinds.InquiryAnswered] = "お問い合わせ",
            [ActivityKinds.QchatMention] = "支部",
            [ActivityKinds.DataExportReady] = "データ",
            [ActivityKinds.ClassPromoted] = "昇級", // Round 22 (§68)
            [ActivityKinds.NewDevice] = "アカウント",
        };
        public static readonly IReadOnlyDictionary<string, string> Icons = new Dictionary<string, string>
        {
            [ActivityKinds.FriendRequest] = "friend", [ActivityKinds.FriendAccepted] = "friend", [ActivityKinds.RivalWeek] = "rival", [ActivityKinds.RivalRecord] = "rival",
            [ActivityKinds.StableLike] = "like", [ActivityKinds.TeamCheer] = "cheer", [ActivityKinds.TournamentResult] = "trophy", [ActivityKinds.GiftArrived] = "gift",
            [ActivityKinds.TeamGoalTier] = "team", [ActivityKinds.TeamGoalWeek] = "team", [ActivityKinds.ReplayShare] = "replay",
            [ActivityKinds.CupInvited] = "cup", [ActivityKinds.CupStarted] = "cup", [ActivityKinds.CupFinished] = "cup", [ActivityKinds.CupCancelled] = "cup",
            [ActivityKinds.RecapReady] = "recap",
            [ActivityKinds.OpsNotice] = "notice",
            [ActivityKinds.InquiryAnswered] = "support",
            [ActivityKinds.QchatMention] = "chat",
            [ActivityKinds.DataExportReady] = "data",
            [ActivityKinds.ClassPromoted] = "promotion",
            [ActivityKinds.NewDevice] = "device",
        };

        private readonly IActivityApi _api;
        private readonly Func<bool> _online;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;
        private int _generation;
        private string _pendingRead;

        public ActivityModel(IActivityApi api, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            _api = api;
            _online = online ?? (() => true);
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        /// <summary>The bell's number (from GET /v1/player `activity`, then each page).</summary>
        public int Unread { get; private set; }
        public List<ActivityLine> Lines { get; } = new List<ActivityLine>();
        public string NextCursor { get; private set; }
        public bool HasMore => NextCursor != null;
        public bool Loading { get; private set; }
        public string Message { get; private set; }
        /// <summary>Unseen what's-new entries: the screen shows a link row (<see cref="WhatsNewText"/>) to that screen, not entries.</summary>
        public int WhatsNew { get; private set; }

        /// <summary>The bell: null = hidden (0), "1".."98", or "99+" (the server caps the number at badgeMax).</summary>
        public string BadgeText => Unread <= 0 ? null : Unread >= BadgeCap ? BadgeCap + "+" : Unread.ToString(CultureInfo.InvariantCulture);

        /// <summary>The home screen passes the player view's badge (REQ-ACT-009).</summary>
        public void SetBadge(ActivityBadge b) { if (b != null) Unread = Math.Max(0, b.Unread); }

        public static string When(long at) => DateTimeOffset.FromUnixTimeMilliseconds(at).ToOffset(TimeSpan.FromHours(9)).ToString("MM/dd HH:mm", CultureInfo.InvariantCulture);

        public static ActivityLine LineOf(ActivityItem i) => new ActivityLine
        {
            Id = i.Id, Kind = i.Kind, Text = i.Text, Screen = i.Screen, LinkId = i.LinkId, When = When(i.At), Count = i.Count, Unread = i.Unread, Source = i,
            Label = Labels.TryGetValue(i.Kind ?? "", out var l) ? l : "お知らせ", Icon = Icons.TryGetValue(i.Kind ?? "", out var ic) ? ic : "info",
            Cta = i.Screen == ActivityScreens.GiftBox ? GiftCta : ViewCta,
        };

        /// <summary>Opens the screen: first page, activity_open once, then marks it read up to the newest entry.</summary>
        public async Task OpenAsync(CancellationToken ct = default)
        {
            var gen = ++_generation;
            Lines.Clear(); NextCursor = null; Message = null; Loading = false;
            if (!_online() || _api == null) { Message = OfflineText; return; }
            _track?.Invoke(AnalyticsEvent.ActivityOpen(_clock(), Math.Min(999, Unread)));
            await LoadAsync(null, gen, ct);
            if (gen != _generation) return;
            var newest = Lines.Count > 0 ? Lines[0].Id : null;
            if (newest != null) _pendingRead = newest;
            await FlushReadAsync(ct);
        }

        /// <summary>The next page (ignored while loading or at the end).</summary>
        public Task MoreAsync(CancellationToken ct = default) => Loading || NextCursor == null ? Task.CompletedTask : LoadAsync(NextCursor, _generation, ct);

        private async Task LoadAsync(string cursor, int gen, CancellationToken ct)
        {
            Loading = true;
            try
            {
                var p = await _api.GetActivityAsync(cursor, PageSize, ct);
                if (gen != _generation) return; // the screen was reopened meanwhile
                if (cursor == null) Lines.Clear();
                var known = new HashSet<string>(Lines.Select(x => x.Id));
                Lines.AddRange(p.Items.Where(x => !known.Contains(x.Id)).Select(LineOf));
                NextCursor = p.NextCursor;
                Unread = p.Unread;
                WhatsNew = p.WhatsNew;
                if (Lines.Count == 0 && WhatsNew == 0) Message = EmptyText;
            }
            catch (ApiException e) { if (gen == _generation) Message = UxText.For(e); }
            finally { if (gen == _generation) Loading = false; }
        }

        /// <summary>Sends the pending mark-read (idempotent on the server); kept for the next open when it fails.</summary>
        public async Task FlushReadAsync(CancellationToken ct = default)
        {
            var upTo = _pendingRead;
            if (upTo == null || !_online() || _api == null) return;
            try
            {
                var r = await _api.MarkActivityReadAsync(upTo, ct);
                if (_pendingRead == upTo) _pendingRead = null;
                Unread = r.Unread;
            }
            catch (ApiException) { /* retried on the next open */ }
        }

        /// <summary>A row was tapped: activity_tap, and the screen to open (link.screen) with its id.</summary>
        public (string screen, string id) Tap(ActivityLine line)
        {
            if (line == null) return (null, null);
            if (Array.IndexOf(ActivityKinds.All, line.Kind) >= 0 && Array.IndexOf(ActivityScreens.All, line.Screen) >= 0)
                _track?.Invoke(AnalyticsEvent.ActivityTap(_clock(), line.Kind, line.Screen));
            return (line.Screen, line.LinkId);
        }
    }
}
