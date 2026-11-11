using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-TUT-001..018: チュートリアルのやり直しとヒント集 (server/src/domain/tips.ts, contracts/protocol.md §57).
    // Short illustrated cards (the server answers in the request's language; Japanese and English side by side in
    // master/tips.json) that open with the §4.3 unlock keys, the race lessons and feature tours built from those cards, and
    // the "?" contexts of complex screens. Display only: nothing here moves coins or items, and a replay never reaches the
    // server (it runs on the device like practice; only the KPI rows say it happened).

    /// <summary>GET /v1/player `tips`: the settings badge (new cards).</summary>
    public sealed class TipsBadge
    {
        public int NewCount;
        internal static TipsBadge Parse(JsonNode o) => o == null ? new TipsBadge() : new TipsBadge { NewCount = J.Int(o, "newCount") };
    }

    /// <summary>Screens with a "?" button (`contexts`, REQ-TUT-008).</summary>
    public static class TipContexts
    {
        public const string GachaOdds = "gacha_odds", Breeding = "breeding", Training = "training", RosterBulkRetire = "roster_bulk_retire";
        public static readonly string[] All = { GachaOdds, Breeding, Training, RosterBulkRetire };
    }

    /// <summary>The four race lessons (REQ-TUT-002).</summary>
    public static class RaceLessons
    {
        public const string Whip = "whip", Position = "position", Stamina = "stamina", Reins = "reins";
        public static readonly string[] All = { Whip, Position, Stamina, Reins };
    }

    public static class TipTopics
    {
        public const string Race = "race", Horses = "horses", Scout = "scout", Shop = "shop", Social = "social";
        public static readonly string[] All = { Race, Horses, Scout, Shop, Social };
    }

    public sealed class TipTopicInfo
    {
        public string Id, Title;
        public int Count, Unlocked, NewCount;
        internal static TipTopicInfo Parse(JsonNode o) => new TipTopicInfo { Id = J.Str(o, "id"), Title = J.Str(o, "title"), Count = J.Int(o, "count"), Unlocked = J.Int(o, "unlocked"), NewCount = J.Int(o, "newCount") };
    }

    /// <summary>One card. A closed card has its title and the unlock key that opens it, never its text (<see cref="Body"/> null).</summary>
    public sealed class TipCard
    {
        public string Id, Topic, Art, Unlock, Title, Body;
        public bool Unlocked, New;
        /// <summary>The help article for depth (null = none). Open it with ApiClient.GetHelpArticleAsync.</summary>
        public string HelpArticleId, HelpTitle;
        internal static TipCard Parse(JsonNode o)
        {
            var h = J.Opt(o, "help");
            return new TipCard
            {
                Id = J.Str(o, "id"), Topic = J.Str(o, "topic"), Art = J.Str(o, "art"), Unlock = J.Str(o, "unlock"), Title = J.Str(o, "title"), Body = J.Str(o, "body"),
                Unlocked = J.Bool(o, "unlocked"), New = J.Bool(o, "new"), HelpArticleId = J.Str(h, "articleId"), HelpTitle = J.Str(h, "title"),
            };
        }
    }

    /// <summary>A replay: a race lesson (<see cref="Lesson"/> set) or a feature tour (pages = <see cref="Tips"/>).</summary>
    public sealed class TutorialEntry
    {
        public const string KindRace = "race", KindTour = "tour";
        public string Id, Kind, Lesson, Unlock, Title;
        public bool Unlocked;
        public List<string> Tips = new List<string>();
        internal static TutorialEntry Parse(JsonNode o) => new TutorialEntry
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), Lesson = J.Str(o, "lesson"), Unlock = J.Str(o, "unlock"), Title = J.Str(o, "title"), Unlocked = J.Bool(o, "unlocked"),
            Tips = J.List(o, "tips", v => v.AsString()),
        };
    }

    /// <summary>GET /v1/tips: topics, cards (numbers already filled from data), replays and the "?" contexts.</summary>
    public sealed class TipsIndex
    {
        public bool Enabled;
        public int Version, NewCount;
        public string Lang;
        public List<TipTopicInfo> Topics = new List<TipTopicInfo>();
        public List<TipCard> Tips = new List<TipCard>();
        public List<TutorialEntry> Tutorials = new List<TutorialEntry>();
        public Dictionary<string, string> Contexts = new Dictionary<string, string>();

        public TipCard Card(string id) => Tips.FirstOrDefault(t => t.Id == id);
        public TutorialEntry Tutorial(string id) => Tutorials.FirstOrDefault(t => t.Id == id);
        public IEnumerable<TipCard> InTopic(string topic) => Tips.Where(t => t.Topic == topic);

        public static TipsIndex Parse(JsonNode o) => new TipsIndex
        {
            Enabled = J.Bool(o, "enabled"), Version = J.Int(o, "version"), NewCount = J.Int(o, "newCount"), Lang = J.Str(o, "lang"),
            Topics = J.List(o, "topics", TipTopicInfo.Parse), Tips = J.List(o, "tips", TipCard.Parse), Tutorials = J.List(o, "tutorials", TutorialEntry.Parse),
            Contexts = J.Map(o, "contexts", v => v.AsString()),
        };
    }

    /// <summary>POST /v1/tips/seen: what was marked now, what was skipped (closed cards) and the new badge count.</summary>
    public sealed class TipsSeenResult
    {
        public List<string> Marked = new List<string>(), Skipped = new List<string>();
        public int NewCount;
        internal static TipsSeenResult Parse(JsonNode o) => new TipsSeenResult { Marked = J.List(o, "marked", v => v.AsString()), Skipped = J.List(o, "skipped", v => v.AsString()), NewCount = J.Int(o, "newCount") };
    }

    public sealed partial class ApiClient
    {
        private static readonly System.Text.RegularExpressions.Regex TipIdRe = new System.Text.RegularExpressions.Regex("^[a-z0-9_]{2,40}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        /// <summary>A well-formed tip / tutorial id (^[a-z0-9_]{2,40}$).</summary>
        public static bool IsTipId(string id) => id != null && TipIdRe.IsMatch(id);
        /// <summary>The most ids one POST /v1/tips/seen carries (the server's config may lower it; the default is 20).</summary>
        public const int TipsSeenMaxPerRequest = 20;

        /// <summary>REQ-TUT-005: the tips index for this player (the request's language).</summary>
        public Task<TipsIndex> GetTipsAsync(CancellationToken ct = default) => Call("GET", "/v1/tips", null, true, null, true, TipsIndex.Parse, ct);

        /// <summary>REQ-TUT-007: mark cards seen (idempotent: sending the same ids again changes nothing).</summary>
        public Task<TipsSeenResult> MarkTipsSeenAsync(IReadOnlyCollection<string> ids, CancellationToken ct = default)
        {
            if (ids == null || ids.Count < 1 || ids.Count > TipsSeenMaxPerRequest) throw new ArgumentException("1.." + TipsSeenMaxPerRequest + " ids", nameof(ids));
            var arr = JsonNode.Arr();
            foreach (var id in ids)
            {
                if (!IsTipId(id)) throw new ArgumentException("bad tip id " + id, nameof(ids));
                arr.Add(JsonNode.Str(id));
            }
            return Call("POST", "/v1/tips/seen", JsonNode.Obj().Set("ids", arr), true, null, true, TipsSeenResult.Parse, ct);
        }
    }
}
