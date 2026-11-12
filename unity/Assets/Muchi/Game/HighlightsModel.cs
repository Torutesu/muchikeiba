using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Game
{
    // REQ-HL-001..020 (contracts/protocol.md §72, docs/handoff-codex-round23-highlights.md): レースの見どころ, the game layer.
    // Pure C#: Codex's reel screen, captions and share sheet bind to the public members. Detection is the engine's
    // HighlightDetector (the same answer as the verifier); nothing is stored — the list is computed when the reel opens
    // and dropped with the model (no per-account device state, so AccountChangeReset has nothing to clear).

    /// <summary>One moment as the reel screen shows it.</summary>
    public sealed class HighlightMomentView
    {
        public int Index, Rank;
        public string Kind;
        /// <summary>The headline in the current locale (「最後の直線で3頭抜き」).</summary>
        public string Caption;
        /// <summary>The horse's name (「（あなた）」 for the viewer's own). Horse names only — never a player name.</summary>
        public string Subject;
        public int StartMs, EndMs, Slot;
        public bool Top => Rank == 1;
    }

    /// <summary>What the share sheet needs to create a replay link (ApiClient in the game; a fake in checks).</summary>
    public interface IHighlightLinkApi
    {
        Task<CreatedLink> CreateReplayLinkAsync(string raceId, int? startTick, CancellationToken ct = default);
    }

    public sealed class ApiHighlightLinks : IHighlightLinkApi
    {
        private readonly ApiClient _api;
        public ApiHighlightLinks(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<CreatedLink> CreateReplayLinkAsync(string raceId, int? startTick, CancellationToken ct = default) => _api.CreateReplayLinkAsync(raceId, startTick, ct);
    }

    /// <summary>
    /// 見どころ: opened from the result screen (any race but the tutorial; offline too) or from a replay (§37 my replays, a
    /// friend's public replay, a §63 link). Plays up to three moments back to back at 1× (<see cref="Advance"/>), 「次へ」 /
    /// 「スキップ」, one caption per moment, the commentary lines inside each window (the equipped §36 pack), and the share
    /// sheet: an image card (always) and a replay link that opens at the top moment (only for an own public saved replay,
    /// online). KPI: highlight_view once per opened reel, highlight_share when the OS sheet takes it.
    /// </summary>
    public sealed class HighlightsModel
    {
        public const string TextTitle = "見どころ";
        public const string TextUnplayable = "見どころを再生できません";
        public const string TextNone = "見どころはありません";
        public const string TextLinkNote = "保存して公開すると、リンクで送れます";
        public const string TextLinkOffline = "リンクはオンラインで送れます";
        public const string TextShare = "見どころを共有";
        public const string TextShareCard = "画像で共有";
        public const string TextShareLink = "リンクで送る";
        public const string TextNext = "次へ";
        public const string TextSkip = "スキップ";
        /// <summary>The cut between moments (Codex): a wipe normally, a plain cut with reduce motion (§41).</summary>
        public const string TransitionWipe = "wipe", TransitionCut = "cut";

        private readonly string _surface;
        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;
        private readonly List<CommentaryLine> _lines;
        private bool _viewed;

        public ReplayPlayer Player { get; }
        public HighlightReel Reel { get; }
        public HighlightSet Set { get; }
        public bool Available => Reel != null && Set.Moments.Count > 0;
        /// <summary>Why the reel cannot play (null when it can).</summary>
        public string UnavailableText { get; }
        public List<HighlightMomentView> Moments { get; } = new List<HighlightMomentView>();
        public bool ReduceMotion { get; set; }
        public string Transition => ReduceMotion ? TransitionCut : TransitionWipe;
        /// <summary>The race id of a saved replay (null on a result screen of a race that is not saved).</summary>
        public string RaceId { get; set; }
        /// <summary>The replay is the player's own, saved and public: a link can be made.</summary>
        public bool LinkAllowed { get; set; }

        private HighlightsModel(string surface, ReplayPlayer player, CommentaryTemplates templates, Action<AnalyticsEvent> track, NowMs now)
        {
            if (Array.IndexOf(AnalyticsEvent.HighlightSurfaces, surface) < 0) throw new ArgumentException("unknown surface");
            _surface = surface; _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Player = player;
            if (player == null || !player.Playable) { UnavailableText = Loc.T(TextUnplayable); Set = new HighlightSet(); return; }
            Set = ReplayHighlights.Detect(player);
            if (Set.Moments.Count == 0) { UnavailableText = Loc.T(TextNone); return; }
            Reel = new HighlightReel(player, Set);
            int ms = 1000 / player.Config.Net.TickHz;
            for (int i = 0; i < Set.Moments.Count; i++)
            {
                var m = Set.Moments[i];
                Moments.Add(new HighlightMomentView
                {
                    Index = i, Rank = m.Rank, Kind = m.Kind, Slot = m.Slot, StartMs = m.StartTick * ms, EndMs = m.EndTick * ms,
                    Caption = HighlightCaptions.Text(m, player.Config), Subject = SubjectText(m, player),
                });
            }
            _lines = templates == null ? new List<CommentaryLine>() : HighlightReel.Commentary(templates, player.Config, player.Data.Log.Inputs, player.OwnSlot);
        }

        private static string SubjectText(HighlightMoment m, ReplayPlayer p)
        {
            string name = m.Slot >= 0 && m.Slot < p.Config.Entrants.Count ? p.Config.Entrants[m.Slot].Horse?.Name ?? "" : "";
            name = Loc.T(name);
            return m.Slot == p.OwnSlot ? name + Loc.T("（あなた）") : name;
        }

        /// <summary>REQ-HL-011: the result screen shows 「見どころ」 for every race but the tutorial (the FTUE flow stays as it is).</summary>
        public static bool ShowOnResult(RaceMode mode) => mode != RaceMode.Tutorial;

        /// <summary>From a replay (my replays, a friend's public replay, a link): the player must be playable (hash checked).</summary>
        public static HighlightsModel ForReplay(ReplayPlayer player, string surface, CommentaryTemplates templates = null, Action<AnalyticsEvent> track = null, NowMs now = null)
            => new HighlightsModel(surface, player, templates, track, now);

        /// <summary>
        /// From the result screen: the race that just ran (its config, confirmed inputs and hash; works offline). The
        /// re-simulation must reproduce <paramref name="resultHash"/> or no reel is shown.
        /// </summary>
        public static HighlightsModel ForResult(RaceConfig config, IList<InputRecord> inputs, string resultHash, int ownSlot, CommentaryTemplates templates = null,
            Action<AnalyticsEvent> track = null, NowMs now = null)
        {
            var data = new ReplayData
            {
                RaceId = config?.RaceId, Owner = "me", ResultHash = resultHash, FocusSlot = ownSlot, Playable = true, RulesetVersion = config?.Ruleset?.RulesetVersion,
                Log = config == null ? null : new ReplayLog { Config = config, EndTick = -1, Inputs = new List<InputRecord>(inputs ?? new List<InputRecord>()) },
            };
            return new HighlightsModel("result", ReplayPlayer.Open(data), templates, track, now);
        }

        /// <summary>From the result screen's finished race driver (offline or online: the inputs that reproduce what the device showed). Null when the race cannot be shared (void, failed, tutorial).</summary>
        public static HighlightsModel ForDriver(IRaceDriver driver, CommentaryTemplates templates = null, Action<AnalyticsEvent> track = null, NowMs now = null)
        {
            if (!ReplayShareModel.CanShare(driver) || !ShowOnResult(driver.Config.Mode)) return null;
            return ForResult(driver.Config, ReplayShareModel.InputsOf(driver), driver.Final?.Hash ?? driver.Sim.Result?.Hash, driver.PlayerSlot, templates, track, now);
        }

        public HighlightMomentView Current => Reel == null || Reel.Done ? null : Moments[Reel.Index];
        public bool Done => Reel == null || Reel.Done;
        /// <summary>「見どころ 1 / 3」.</summary>
        public string CounterText => Current == null ? null : Loc.T("見どころ " + N(Current.Index + 1) + " / " + N(Moments.Count));
        /// <summary>0..1000 of the whole reel (the progress bar).</summary>
        public int ProgressPermille => Reel == null || Reel.TotalMs <= 0 ? 0 : (int)Math.Min(1000L, (long)Reel.ElapsedMs * 1000 / Reel.TotalMs);
        private static string N(int n) => n.ToString(CultureInfo.InvariantCulture);

        /// <summary>The reel starts playing (highlight_view once per model).</summary>
        public void Start()
        {
            if (!Available || _viewed) return;
            _viewed = true;
            _track?.Invoke(AnalyticsEvent.HighlightView(_now(), _surface, Set.Top.Kind, Set.Moments.Count));
        }

        public void Advance(double realMs) { if (Available) { Start(); Reel.Advance(realMs); } }
        public void Next() { if (Available) Reel.Next(); }
        public void Skip() { if (Available) Reel.Skip(); }
        public ReplayPlayerFrame Frame() => Available ? Reel.Frame() : null;

        /// <summary>REQ-HL-010: the commentary lines that start inside the current moment (none outside the windows).</summary>
        public List<CommentaryLine> CurrentLines => Reel?.Current == null ? new List<CommentaryLine>() : HighlightReel.LinesIn(_lines, Reel.Current);

        // ------------------------------------------------------------------ share sheet

        /// <summary>The card (the replay card with the top caption). Null when there is nothing to share.</summary>
        public ShareCard Card(string courseName = null) => Available ? HighlightShare.Card(Player, Set, courseName) : null;

        /// <summary>The link row: enabled only for an own public saved replay and online; otherwise the note to show.</summary>
        public string LinkNote(bool online) => !LinkAllowed || string.IsNullOrEmpty(RaceId) ? Loc.T(TextLinkNote) : !online ? Loc.T(TextLinkOffline) : null;

        /// <summary>The still for the card: the top moment's key tick, posed like the reel (the recorder captures it).</summary>
        public ReplayClipFrame StillFrame()
        {
            if (!Available) return null;
            var top = Set.Top;
            int ms = 1000 / Player.Config.Net.TickHz;
            var f = Player.FrameAt(top.KeyTick * ms);
            return new ReplayClipFrame { Index = 0, TimeMs = 0, Tick = f.Tick, AlphaPermille = f.AlphaPermille, From = f.From, To = f.To, Camera = f.Camera, FocusRemainingM = f.RemainingM };
        }

        /// <summary>画像で共有: capture the still with the card and hand it to the OS sheet (highlight_share only when it takes it).</summary>
        public async Task<bool> ShareCardAsync(IClipRecorder recorder, IShareSheet sheet, string courseName = null, CancellationToken ct = default)
        {
            if (!Available) return false;
            if (recorder == null) throw new ArgumentNullException(nameof(recorder));
            if (sheet == null) throw new ArgumentNullException(nameof(sheet));
            var card = Card(courseName);
            string path;
            try { path = await recorder.CaptureStillAsync(StillFrame(), card, ct); }
            catch (OperationCanceledException) { recorder.Cancel(); return false; }
            if (string.IsNullOrEmpty(path)) return false;
            bool ok;
            try { ok = await sheet.ShareAsync(path, card.ShareText, ct); }
            catch (OperationCanceledException) { ok = false; }
            if (ok) _track?.Invoke(AnalyticsEvent.HighlightShare(_now(), _surface, false));
            return ok;
        }

        /// <summary>リンクで送る: a §63 replay link opening at the top moment (own public saved replay only), into the OS sheet.</summary>
        public async Task<ActionResult> ShareLinkAsync(IHighlightLinkApi api, IShareSheet sheet, bool online, CancellationToken ct = default)
        {
            var note = LinkNote(online);
            if (note != null) return ActionResult.Error(note);
            if (api == null) throw new ArgumentNullException(nameof(api));
            if (sheet == null) throw new ArgumentNullException(nameof(sheet));
            CreatedLink link;
            try { link = await api.CreateReplayLinkAsync(RaceId, HighlightShare.StartTick(Set), ct); }
            catch (NotFoundException) { LinkAllowed = false; return ActionResult.Error(TextLinkNote); } // made private / deleted meanwhile
            catch (ApiException e) { return ActionResult.Error(e.Message); }
            bool ok;
            try { ok = await sheet.ShareAsync(null, link.ShareText, ct); }
            catch (OperationCanceledException) { ok = false; }
            if (ok) _track?.Invoke(AnalyticsEvent.HighlightShare(_now(), _surface, true));
            return ok ? ActionResult.Success() : ActionResult.Error(null);
        }

        /// <summary>A §63 replay link was opened: the time the player should start at (its startTick, clamped).</summary>
        public static int LinkStartMs(ResolvedLink link, ReplayPlayer player) => HighlightShare.StartTimeMs(link, player);
    }
}
