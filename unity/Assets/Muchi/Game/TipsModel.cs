using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-TUT-001..018 (contracts/protocol.md §57, docs/handoff-codex-round19-tutorial-replay.md): ヒント, the game layer.
    // Pure C#: Codex's screens bind to the public fields. Display only — nothing here moves coins or items.

    /// <summary>The server calls the tips library needs (ApiClient in the app, a fake in the checks).</summary>
    public interface ITipsApi
    {
        Task<TipsIndex> GetTipsAsync(CancellationToken ct = default);
        Task<TipsSeenResult> MarkTipsSeenAsync(IReadOnlyCollection<string> ids, CancellationToken ct = default);
    }

    /// <summary><see cref="ITipsApi"/> over the real client.</summary>
    public sealed class ApiTips : ITipsApi
    {
        private readonly ApiClient _api;
        public ApiTips(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<TipsIndex> GetTipsAsync(CancellationToken ct = default) => _api.GetTipsAsync(ct);
        public Task<TipsSeenResult> MarkTipsSeenAsync(IReadOnlyCollection<string> ids, CancellationToken ct = default) => _api.MarkTipsSeenAsync(ids, ct);
    }

    /// <summary>
    /// The ヒント screen: topics and cards, "NEW" badges, the "?" buttons of complex screens and the feature tours.
    /// Rules the model keeps:
    ///  - the cards and their numbers come from the server in the request's language (numbers are data, never in the client);
    ///  - a closed card shows its title and <see cref="LockedText"/>, never opens; a tour of a closed feature never starts;
    ///  - reading a card clears its NEW at once and queues its id; the queue is sent in batches of at most
    ///    <see cref="ApiClient.TipsSeenMaxPerRequest"/> (POST /v1/tips/seen is idempotent, so a retry is harmless). Offline the
    ///    queue is kept on the device (<see cref="KeyPendingSeen"/>) and sent on the next load;
    ///  - KPI: tip_view once per opening with where from (list / context / tour / lesson), tip_context_open for a "?" button,
    ///    tutorial_replay start / finish for a tour (race lessons: <see cref="TutorialReplayModel"/>).
    /// </summary>
    public sealed class TipsModel
    {
        public const string Title = "ヒント";
        public const string OfflineText = "ヒントはオンラインで見られます";
        public const string NewLabel = "NEW";
        public const string LockedText = "機能が開くと読めます";
        public const string MoreLabel = "くわしく";
        public const string LessonsTitle = "レースのレッスン";
        public const string ToursTitle = "機能のツアー";
        public const string NextLabel = "次へ";
        public const string DoneLabel = "おわり";
        public const string TourLockedText = "この機能が開いたら見られます";
        public const string KeyPendingSeen = "muchi.tips.seen.pending";
        /// <summary>The most ids kept on the device while offline (the server's own list is bounded too).</summary>
        public const int PendingMax = 200;

        private readonly ITipsApi _api;
        private readonly IKeyValueStore _kv;
        private readonly Func<bool> _online;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;

        public TipsModel(ITipsApi api, IKeyValueStore store = null, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            _api = api;
            _kv = store ?? new MemoryKeyValueStore();
            _online = online ?? (() => true);
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public TipsIndex Index { get; private set; }
        /// <summary>The topic tab shown (null = the first topic).</summary>
        public string Topic { get; private set; }
        /// <summary>The card open in the reader (null = none).</summary>
        public TipCard Open { get; private set; }
        /// <summary>The running tour and its open pages (closed cards are left out).</summary>
        public TutorialEntry Tour { get; private set; }
        public List<TipCard> TourPages { get; private set; } = new List<TipCard>();
        public int TourPage { get; private set; }
        public string Message { get; private set; }
        public bool Loading { get; private set; }

        /// <summary>The settings badge: new cards not yet read here.</summary>
        public int NewCount => Index == null ? 0 : Index.Tips.Count(t => t.New);
        public IReadOnlyList<string> PendingSeen => Pending();
        public IEnumerable<TutorialEntry> Lessons => Index?.Tutorials.Where(t => t.Kind == TutorialEntry.KindRace) ?? Enumerable.Empty<TutorialEntry>();
        public IEnumerable<TutorialEntry> Tours => Index?.Tutorials.Where(t => t.Kind == TutorialEntry.KindTour) ?? Enumerable.Empty<TutorialEntry>();
        public IEnumerable<TipCard> Cards => Index == null ? Enumerable.Empty<TipCard>() : Index.InTopic(Topic ?? Index.Topics.FirstOrDefault()?.Id);
        public bool TourOnLastPage => Tour != null && TourPage >= TourPages.Count - 1;

        /// <summary>Loads the index (and sends what was read offline). Offline: <see cref="OfflineText"/>, the last index stays.</summary>
        public async Task LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!_online() || _api == null) { Message = OfflineText; return; }
            Loading = true;
            try
            {
                await FlushSeenAsync(ct);
                var idx = await _api.GetTipsAsync(ct);
                // a card read here but not yet confirmed by the server stays read
                var pending = new HashSet<string>(Pending());
                foreach (var t in idx.Tips) if (pending.Contains(t.Id)) t.New = false;
                Index = idx;
                if (Topic == null || !idx.Topics.Any(x => x.Id == Topic)) Topic = idx.Topics.FirstOrDefault()?.Id;
            }
            catch (ApiException e) { Message = e is NetworkException ? OfflineText : UxText.For(e); }
            finally { Loading = false; }
        }

        public void SelectTopic(string topic) { if (Index != null && Index.Topics.Any(x => x.Id == topic)) Topic = topic; }

        /// <summary>Opens a card in the reader. A closed or unknown card does not open (returns false).</summary>
        public bool OpenCard(string tipId, string source = "list")
        {
            var c = Index?.Card(tipId);
            if (c == null || !c.Unlocked) return false;
            Open = c;
            _track?.Invoke(AnalyticsEvent.TipView(_clock(), c.Id, source));
            Read(c);
            return true;
        }

        public void CloseCard() => Open = null;

        /// <summary>REQ-TUT-008: a screen's "?" button (TipContexts). Returns the card opened, or null (unknown context / closed card).</summary>
        public TipCard OpenContext(string context)
        {
            if (Index == null || !Index.Contexts.TryGetValue(context ?? "", out var id)) return null;
            var c = Index.Card(id);
            if (c == null || !c.Unlocked) return null;
            _track?.Invoke(AnalyticsEvent.TipContextOpen(_clock(), context, id));
            OpenCard(id, "context");
            return c;
        }

        /// <summary>REQ-TUT-009: starts a feature tour (only an open one). Pages are its open cards in order.</summary>
        public bool StartTour(string tutorialId)
        {
            var t = Index?.Tutorial(tutorialId);
            if (t == null || t.Kind != TutorialEntry.KindTour || !t.Unlocked) { Message = t != null && !t.Unlocked ? TourLockedText : null; return false; }
            var pages = t.Tips.Select(id => Index.Card(id)).Where(c => c != null && c.Unlocked).ToList();
            if (pages.Count == 0) { Message = TourLockedText; return false; }
            Tour = t; TourPages = pages; TourPage = 0; Message = null;
            _track?.Invoke(AnalyticsEvent.TutorialReplay(_clock(), t.Id, TutorialEntry.KindTour, "start"));
            ShowPage();
            return true;
        }

        /// <summary>Next page; after the last one the tour finishes (tutorial_replay finish) and closes. Returns true while it goes on.</summary>
        public bool NextPage()
        {
            if (Tour == null) return false;
            if (TourOnLastPage)
            {
                _track?.Invoke(AnalyticsEvent.TutorialReplay(_clock(), Tour.Id, TutorialEntry.KindTour, "finish"));
                EndTour();
                return false;
            }
            TourPage++;
            ShowPage();
            return true;
        }

        /// <summary>Leaves the tour early (no finish row).</summary>
        public void EndTour() { Tour = null; TourPages = new List<TipCard>(); TourPage = 0; Open = null; }

        private void ShowPage()
        {
            var c = TourPages[TourPage];
            Open = c;
            _track?.Invoke(AnalyticsEvent.TipView(_clock(), c.Id, "tour"));
            Read(c);
        }

        /// <summary>A card shown elsewhere (the race lesson's briefing): marks it read like the reader does.</summary>
        public void MarkRead(string tipId, string source)
        {
            var c = Index?.Card(tipId);
            if (c == null || !c.Unlocked) return;
            _track?.Invoke(AnalyticsEvent.TipView(_clock(), c.Id, source));
            Read(c);
        }

        private void Read(TipCard c)
        {
            if (!c.New) return;
            c.New = false;
            var p = Pending();
            if (!p.Contains(c.Id)) { p.Add(c.Id); SavePending(p); }
        }

        /// <summary>Sends the read cards (batches of at most 20). A failure keeps the rest for next time; nothing is lost or doubled.</summary>
        public async Task FlushSeenAsync(CancellationToken ct = default)
        {
            if (!_online() || _api == null) return;
            var p = Pending();
            while (p.Count > 0)
            {
                var batch = p.Take(ApiClient.TipsSeenMaxPerRequest).ToList();
                try { await _api.MarkTipsSeenAsync(batch, ct); }
                catch (NotFoundException) { /* a card the server no longer has: drop the batch rather than retry forever */ }
                catch (ApiException) { return; }
                p = p.Skip(batch.Count).ToList();
                SavePending(p);
            }
        }

        private List<string> Pending()
        {
            var raw = _kv.Get(KeyPendingSeen);
            return string.IsNullOrEmpty(raw) ? new List<string>() : raw.Split(',').Where(ApiClient.IsTipId).Distinct().ToList();
        }

        private void SavePending(List<string> ids) => _kv.Set(KeyPendingSeen, string.Join(",", ids.Skip(Math.Max(0, ids.Count - PendingMax))));
    }
}
