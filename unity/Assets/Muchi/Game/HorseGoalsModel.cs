using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-HGOAL-001..016 (contracts/protocol.md §53, docs/handoff-codex-round18-horse-goals.md): 馬ごとの目標, the game layer.
    // Pure C#: Codex's goals panel on the horse detail screen and the pinned goal on the home bind to the public members.
    // The server keeps the progress (confirmed results only) and records completions; the model formats rows, pins and reports
    // the KPI. Horse names are what players typed: shown as they are in every language (never through Loc.T). The goal lines
    // are server texts (server-en.json); the panel's own labels are in ui-en.json.

    /// <summary>One goal row of the panel.</summary>
    public sealed class GoalRow
    {
        public string Id, Kind;
        /// <summary>「第3章」-style step label: 「3」 (1-based position in the chain).</summary>
        public string StepText;
        /// <summary>The chapter label of the kind (「得意の馬場」…).</summary>
        public string ChapterText;
        /// <summary>The goal line (Japanese; translate with Loc.T): 「芝で3勝する」.</summary>
        public string Text;
        /// <summary>「2 / 3」, or 「達成」 when done.</summary>
        public string ProgressText;
        /// <summary>0..1 for the bar.</summary>
        public float Ratio;
        public bool Done, Current;
    }

    /// <summary>The home's pinned goal card.</summary>
    public sealed class PinnedGoalCard
    {
        public string HorseId;
        /// <summary>As typed; never translated.</summary>
        public string HorseName;
        public string Label, GoalText, ProgressText, ChainText;
        public float Ratio;
        public int DoneCount;
    }

    /// <summary>
    /// 馬ごとの目標. Rules the model keeps for the screens:
    ///  - progress is only what the server counted (confirmed results); the model never advances a goal locally;
    ///  - the ribbon (chain complete) is for show only: no coins, items or stats, and no shop link anywhere on the panel;
    ///  - one horse can be pinned to the home; a retired horse or a finished chain cannot be pinned (the button is hidden);
    ///  - KPI hgoal_view: "detail" each time the panel opens, "home" once per game day; hgoal_complete / hgoal_pin are server events.
    /// </summary>
    public sealed class HorseGoalsModel : ScreenModel
    {
        public const string KeyHomeViewed = "muchi.hgoal.home_viewed";
        public const string Title = "この馬の目標";
        public const string RibbonText = "物語を走りきった";
        public const string PinLabel = "ホームに出す";
        public const string UnpinLabel = "ホームから外す";
        public const string PinnedLabel = "ピン留めした目標";
        public const string DoneLabel = "達成";
        public const string OfflineText = "馬の目標はオンラインで見られます";
        public const string RulesText = "目標は確定したレースの成績だけで進みます。達成の印は見た目だけで、能力やレースには影響しません。";
        public static readonly IReadOnlyDictionary<string, string> Chapters = new Dictionary<string, string>
        {
            ["first_win"] = "はじまり", ["races"] = "場数", ["surface_win"] = "得意の馬場", ["ta_course"] = "コースの記録",
            ["stretch_win"] = "得意の外へ", ["wins"] = "勝ち星", ["ranked_top3"] = "ランク戦", ["tournament_win"] = "頂点",
        };

        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;

        public HorseGoalsModel(GameBackend backend, Action<AnalyticsEvent> track = null, NowMs now = null, IKeyValueStore store = null) : base(backend, store ?? backend?.Store)
        {
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public HorseGoalsView View { get; private set; }
        public List<GoalRow> Rows { get; private set; } = new List<GoalRow>();
        public PinnedGoalCard Pinned { get; private set; }

        /// <summary>The horse name as typed.</summary>
        public string HorseName => View?.HorseName;
        /// <summary>「目標 3 / 7」.</summary>
        public string SummaryText => View == null ? null : "目標 " + View.DoneCount + " / " + View.Total;
        public bool ChainComplete => View != null && View.ChainComplete;
        public bool IsPinned => View != null && View.Pinned;
        /// <summary>The pin button is shown only for an active horse with goals left.</summary>
        public bool CanPin => View != null && View.Status == "active" && !View.ChainComplete;

        /// <summary>REQ-HGOAL-010: the panel of one horse. Offline keeps what was loaded and says the panel needs the server.</summary>
        public async Task<ActionResult> LoadAsync(string horseId, CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { Online = false; return Offline(OfflineText); }
            try
            {
                Use(await B.Api.GetHorseGoalsAsync(horseId, ct));
                Online = true;
                _track?.Invoke(AnalyticsEvent.HorseGoalView(_now(), "detail", View.DoneCount));
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public void Use(HorseGoalsView v)
        {
            View = v;
            Rows = v == null ? new List<GoalRow>() : v.Goals.Select((g, i) => RowOf(g, i)).ToList();
        }

        public static GoalRow RowOf(HorseGoal g, int index) => new GoalRow
        {
            Id = g.Id, Kind = g.Kind, StepText = (index + 1).ToString(CultureInfo.InvariantCulture),
            ChapterText = Chapters.TryGetValue(g.Kind ?? "", out var c) ? c : "",
            Text = g.Text, ProgressText = g.Done ? DoneLabel : g.Have + " / " + g.Need,
            Ratio = g.Done ? 1f : g.Need <= 0 ? 0f : Math.Min(1f, g.Have / (float)g.Need), Done = g.Done, Current = g.Current,
        };

        /// <summary>REQ-HGOAL-007: pin this horse's goal to the home, or unpin (a value replacement; safe to retry).</summary>
        public async Task<ActionResult> TogglePinAsync(CancellationToken ct = default)
        {
            if (View == null) return ActionResult.Error(OfflineText);
            if (!IsPinned && !CanPin) return ActionResult.Error(UxText.Errors["NOT_ELIGIBLE"]);
            if (!ServerAvailable) return Offline(OfflineText);
            try
            {
                var pin = await B.Api.PinHorseGoalAsync(IsPinned ? null : View.HorseId, ct);
                View.Pinned = pin != null && pin.HorseId == View.HorseId;
                UsePin(pin);
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>The home: the bootstrap's pin first, then GET /v1/horse-goals/pinned when online.</summary>
        public async Task<ActionResult> LoadPinnedAsync(CancellationToken ct = default)
        {
            UsePin(B.Player?.HorseGoalPin);
            if (!ServerAvailable) return ActionResult.Success();
            try { UsePin(await B.Api.GetPinnedHorseGoalAsync(ct)); return ActionResult.Success(); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        public void UsePin(HorseGoalPin p)
        {
            Pinned = p == null || p.Goal == null ? null : new PinnedGoalCard
            {
                HorseId = p.HorseId, HorseName = p.HorseName, Label = PinnedLabel, GoalText = p.Goal.Text,
                ProgressText = p.Goal.Have + " / " + p.Goal.Need, ChainText = "目標 " + p.DoneCount + " / " + p.Total, DoneCount = p.DoneCount,
                Ratio = p.Goal.Need <= 0 ? 0f : Math.Min(1f, p.Goal.Have / (float)p.Goal.Need),
            };
        }

        /// <summary>Call when the pinned card is on the home: hgoal_view "home" once per game day. Returns whether it was sent.</summary>
        public bool ReportHomeView()
        {
            if (_track == null || Pinned == null) return false;
            string day = GameDay.Key(_now());
            if (Kv.Get(KeyHomeViewed) == day) return false;
            Kv.Set(KeyHomeViewed, day);
            _track(AnalyticsEvent.HorseGoalView(_now(), "home", Pinned.DoneCount));
            return true;
        }
    }
}
