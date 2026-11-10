using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-FSUG-001..016 (contracts/protocol.md §49, docs/handoff-codex-round17-friend-suggestions.md): おすすめフレンド, the
    // game layer. Pure C#: Codex's suggestions section on the friends screen binds to the public fields. Nothing is granted;
    // 「申請する」 uses the normal friend request flow on the server (friend limits, activity entries, pushes).

    /// <summary>The server calls the suggestions section needs (ApiClient in the app, a fake in the checks).</summary>
    public interface IFriendSuggestionsApi
    {
        Task<FriendSuggestions> GetFriendSuggestionsAsync(CancellationToken ct = default);
        Task<FriendOpResult> RequestSuggestedFriendAsync(string playerId, CancellationToken ct = default);
        Task<bool> DismissSuggestionAsync(string playerId, CancellationToken ct = default);
        Task<bool> SetSuggestionsHiddenAsync(bool hidden, CancellationToken ct = default);
    }

    /// <summary><see cref="IFriendSuggestionsApi"/> over the real client.</summary>
    public sealed class ApiFriendSuggestions : IFriendSuggestionsApi
    {
        private readonly ApiClient _api;
        public ApiFriendSuggestions(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<FriendSuggestions> GetFriendSuggestionsAsync(CancellationToken ct = default) => _api.GetFriendSuggestionsAsync(ct);
        public Task<FriendOpResult> RequestSuggestedFriendAsync(string playerId, CancellationToken ct = default) => _api.RequestSuggestedFriendAsync(playerId, ct);
        public Task<bool> DismissSuggestionAsync(string playerId, CancellationToken ct = default) => _api.DismissSuggestionAsync(playerId, ct);
        public Task<bool> SetSuggestionsHiddenAsync(bool hidden, CancellationToken ct = default) => _api.SetSuggestionsHiddenAsync(hidden, ct);
    }

    /// <summary>One card as the section draws it. Name is player-typed (never translated); Reason comes from the server.</summary>
    public sealed class SuggestionLine
    {
        public string PlayerId, Name, ClassId, Reason;
        /// <summary>Icon key of the strongest reason (opponent / team / like / cheer / mutual) Codex maps to a sprite.</summary>
        public string Icon;
        public FriendSuggestion Source;
    }

    /// <summary>
    /// The suggestions section. Rules the model keeps:
    ///  - one load at a time; a load that finishes after a newer one started is dropped;
    ///  - 「申請する」 / 「表示しない」 take the card out at once, and put it back if the call fails (with the error message);
    ///  - a card is never sent twice while its call is in flight;
    ///  - fsug_view is sent once per friends-screen visit (<see cref="Shown"/>), with the number of cards then;
    ///  - offline: no cards, <see cref="OfflineText"/>; empty: <see cref="EmptyText"/>; disabled on the server: <see cref="Visible"/> false.
    /// </summary>
    public sealed class FriendSuggestionsModel
    {
        public const string Title = "おすすめフレンド";
        public const string OfflineText = "おすすめフレンドはオンラインで表示できます";
        public const string EmptyText = "いまはおすすめできる人がいません";
        public const string RequestCta = "申請する";
        public const string DismissCta = "表示しない";
        public const string RequestedText = "フレンド申請を送りました";
        public const string BecameFriendsText = "フレンドになりました";
        public const string HiddenLabel = "おすすめに表示しない";
        public const string HiddenNote = "オンにすると、ほかのプレイヤーのおすすめにあなたが出なくなります";
        public static readonly IReadOnlyDictionary<string, string> Icons = new Dictionary<string, string>
        {
            [FriendSuggestionKinds.Opponent] = "opponent", [FriendSuggestionKinds.Team] = "team", [FriendSuggestionKinds.Liked] = "like",
            [FriendSuggestionKinds.Cheered] = "cheer", [FriendSuggestionKinds.Mutual] = "mutual",
        };

        private readonly IFriendSuggestionsApi _api;
        private readonly Func<bool> _online;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;
        private readonly HashSet<string> _busy = new HashSet<string>();
        private int _generation;
        private bool _viewSent;

        public FriendSuggestionsModel(IFriendSuggestionsApi api, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            _api = api;
            _online = online ?? (() => true);
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public List<SuggestionLine> Lines { get; } = new List<SuggestionLine>();
        /// <summary>False when the server has the feature off: the friends screen leaves the section out.</summary>
        public bool Visible { get; private set; } = true;
        public bool Loading { get; private set; }
        /// <summary>Offline / empty / error text under the title (null = cards are shown).</summary>
        public string Message { get; private set; }
        /// <summary>A one-line toast after an action (「フレンド申請を送りました」).</summary>
        public string Toast { get; private set; }
        /// <summary>「おすすめに表示しない」 as stored on the server.</summary>
        public bool Hidden { get; private set; }

        public static SuggestionLine LineOf(FriendSuggestion s) => new SuggestionLine
        {
            PlayerId = s.PlayerId, Name = s.DisplayName, ClassId = s.ClassId, Reason = s.Text, Source = s,
            Icon = s.Reasons.Count > 0 && Icons.TryGetValue(s.Reasons[0].Kind ?? "", out var ic) ? ic : "friend",
        };

        /// <summary>The friends screen opened (or was pulled to refresh). A new visit sends fsug_view again.</summary>
        public async Task OpenAsync(bool newVisit = true, CancellationToken ct = default)
        {
            var gen = ++_generation;
            if (newVisit) _viewSent = false;
            Message = null; Toast = null;
            if (!_online() || _api == null) { Lines.Clear(); Message = OfflineText; return; }
            Loading = true;
            try
            {
                var r = await _api.GetFriendSuggestionsAsync(ct);
                if (gen != _generation) return;
                Visible = r.Enabled;
                Hidden = r.Hidden;
                Lines.Clear();
                Lines.AddRange(r.Items.Select(LineOf));
                if (Visible && Lines.Count == 0) Message = EmptyText;
            }
            catch (ApiException e) { if (gen == _generation) Message = UxText.For(e); }
            finally { if (gen == _generation) Loading = false; }
        }

        /// <summary>The section scrolled into view: fsug_view once per visit (no player ids).</summary>
        public void Shown()
        {
            if (_viewSent || !Visible || Message == OfflineText) return;
            _viewSent = true;
            _track?.Invoke(AnalyticsEvent.FsugView(_clock(), Math.Min(30, Lines.Count)));
        }

        /// <summary>「申請する」: the card leaves at once; on failure it comes back where it was, with the error text.</summary>
        public Task RequestAsync(SuggestionLine line, CancellationToken ct = default) =>
            Act(line, async () =>
            {
                var r = await _api.RequestSuggestedFriendAsync(line.PlayerId, ct);
                Toast = r.Status == "friends" ? BecameFriendsText : RequestedText;
            });

        /// <summary>「表示しない」: the card leaves at once (the server remembers it).</summary>
        public Task DismissAsync(SuggestionLine line, CancellationToken ct = default) => Act(line, () => _api.DismissSuggestionAsync(line.PlayerId, ct));

        private async Task Act(SuggestionLine line, Func<Task> call)
        {
            if (line == null || _api == null || !_online() || !_busy.Add(line.PlayerId)) return;
            var at = Lines.IndexOf(line);
            if (at < 0) { _busy.Remove(line.PlayerId); return; }
            Lines.RemoveAt(at);
            Toast = null;
            try
            {
                await call();
                if (Lines.Count == 0) Message = EmptyText;
            }
            catch (ApiException e)
            {
                // NOT_FOUND = no longer suggestable (they hid themselves, blocked, …): the card stays gone, nothing is said why
                if (e.Status != 404) { Lines.Insert(Math.Min(at, Lines.Count), line); Toast = UxText.For(e); }
                else if (Lines.Count == 0) Message = EmptyText;
            }
            finally { _busy.Remove(line.PlayerId); }
        }

        /// <summary>The profile setting 「おすすめに表示しない」. Returns false when it could not be saved (the switch goes back).</summary>
        public async Task<bool> SetHiddenAsync(bool hidden, CancellationToken ct = default)
        {
            if (_api == null || !_online()) return false;
            var before = Hidden;
            Hidden = hidden;
            try { Hidden = await _api.SetSuggestionsHiddenAsync(hidden, ct); return true; }
            catch (ApiException e) { Hidden = before; Toast = UxText.For(e); return false; }
        }
    }
}
