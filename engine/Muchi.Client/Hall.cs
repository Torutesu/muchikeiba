using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-HOF-001..016: 殿堂・引退式 (server/src/domain/hallOfFame.ts, contracts/protocol.md §34).
    // The server keeps each horse's career from confirmed results only, freezes the retirement ceremony (highlight lines picked by
    // fixed rules, no randomness) and decides 殿堂入り. The client shows it. Horse and player names are what players typed: never
    // translated. Visiting another player's hall answers NOT_FOUND for every refusal (no hall, not a friend / branch member, blocked).

    /// <summary>One highlight line. Kind: tournament_win | partner | wins | biggest_win | rival_wins | ta_best | places | career_span.</summary>
    public sealed class HallHighlight
    {
        public string Kind, Text;
        public Dictionary<string, string> Params = new Dictionary<string, string>();
        internal static HallHighlight Parse(JsonNode o)
        {
            var h = new HallHighlight { Kind = J.Str(o, "kind"), Text = J.Str(o, "text") };
            var p = J.Opt(o, "params");
            if (p != null && p.Kind == JsonKind.Object) foreach (var kv in p.Props) h.Params[kv.Key] = kv.Value.Kind == JsonKind.String ? kv.Value.AsString() : kv.Value.ToString();
            return h;
        }
    }

    /// <summary>The career line on a plaque / ceremony.</summary>
    public sealed class CareerLine
    {
        public int Races, Wins, Places, TournamentWins;
        public long? FirstRaceAt, LastRaceAt;
        internal static CareerLine Parse(JsonNode o) => o == null ? new CareerLine() : new CareerLine
        {
            Races = J.Int(o, "races"), Wins = J.Int(o, "wins"), Places = J.Int(o, "places"), TournamentWins = J.Int(o, "tournamentWins"),
            FirstRaceAt = J.LongN(o, "firstRaceAt"), LastRaceAt = J.LongN(o, "lastRaceAt"),
        };
    }

    /// <summary>REQ-HOF-003: the retirement ceremony, produced once per horse. Show it, then <see cref="ApiClient.AcknowledgeCeremonyAsync"/>.</summary>
    public sealed class HallCeremony
    {
        public string HorseId, HorseName;
        public long RetiredAt;
        public long? AckedAt;
        public bool Partner, Inducted;
        public CareerLine Career = new CareerLine();
        public List<HallHighlight> Highlights = new List<HallHighlight>();
        /// <summary>wins | tournament | partner (empty = not inducted).</summary>
        public string[] Reasons = new string[0];
        /// <summary>The cosmetic granted with this ceremony (the account's first induction only), or null.</summary>
        public string RewardItemId;
        public bool Seen => AckedAt.HasValue;
        internal static HallCeremony Parse(JsonNode o) => o == null ? null : new HallCeremony
        {
            HorseId = J.Str(o, "horseId"), HorseName = J.Str(o, "horseName"), RetiredAt = J.Long(o, "retiredAt"), AckedAt = J.LongN(o, "ackedAt"),
            Partner = J.Bool(o, "partner"), Inducted = J.Bool(o, "inducted"), Career = CareerLine.Parse(J.Opt(o, "career")),
            Highlights = J.List(o, "highlights", HallHighlight.Parse), Reasons = J.Strs(o, "reasons") ?? new string[0], RewardItemId = J.Str(o, "rewardItemId"),
        };
    }

    /// <summary>REQ-HOF-006: a permanent plaque. Appearance is the horse's look (coat, face…); Frame = the owner has the 殿堂の額縁.</summary>
    public sealed class HallPlaque
    {
        public string HorseId, HorseName, Rarity, Sex;
        public Appearance Appearance = new Appearance();
        public bool Partner, Frame;
        public string[] Reasons = new string[0];
        public long InductedAt;
        public CareerLine Career = new CareerLine();
        public List<HallHighlight> Highlights = new List<HallHighlight>();
        internal static HallPlaque Parse(JsonNode o) => new HallPlaque
        {
            HorseId = J.Str(o, "horseId"), HorseName = J.Str(o, "horseName"), Rarity = J.Str(o, "rarity"), Sex = J.Str(o, "sex"),
            Appearance = Appearance.Parse(J.Opt(o, "appearance")) ?? new Appearance(), Partner = J.Bool(o, "partner"), Frame = J.Bool(o, "frame"),
            Reasons = J.Strs(o, "reasons") ?? new string[0], InductedAt = J.Long(o, "inductedAt"), Career = CareerLine.Parse(J.Opt(o, "career")),
            Highlights = J.List(o, "highlights", HallHighlight.Parse),
        };
    }

    public sealed class HallCriteria
    {
        public int WinsMin, PartnerRacesMin;
        public bool TournamentWin;
        internal static HallCriteria Parse(JsonNode o) => o == null ? new HallCriteria() : new HallCriteria
        {
            WinsMin = J.Int(o, "winsMin"), PartnerRacesMin = J.Int(o, "partnerRacesMin"), TournamentWin = J.Bool(o, "tournamentWin"),
        };
    }

    /// <summary>The hall's owner as visitors see them (public profile copy).</summary>
    public sealed class HallOwner
    {
        public string PlayerId, DisplayName, TitleId;
        public Silks Silks;
        internal static HallOwner Parse(JsonNode o) => o == null ? null : new HallOwner
        {
            PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), TitleId = J.Str(o, "titleId"), Silks = Silks.Parse(J.Opt(o, "silks")),
        };
    }

    /// <summary>
    /// REQ-HOF-009/012: one page of a hall (mine or a friend's / branch member's). Relation: self | friend | team.
    /// NextCursor null = last page. Owner is null for my own hall; Visibility, Criteria and PendingCeremonies only for my own.
    /// </summary>
    public sealed class HallPage
    {
        public string Relation, Visibility, NextCursor, FrameItemId, Notice;
        public bool FrameOwned;
        public int Total;
        public HallOwner Owner;
        public List<HallPlaque> Entries = new List<HallPlaque>();
        public HallCriteria Criteria;
        public List<HallCeremony> PendingCeremonies = new List<HallCeremony>();
        public bool IsMine => Relation == "self";
        internal static HallPage Parse(JsonNode o)
        {
            var f = J.Opt(o, "frame");
            return new HallPage
            {
                Relation = J.Str(o, "relation"), Visibility = J.Str(o, "visibility"), NextCursor = J.Str(o, "nextCursor"), Notice = J.Str(o, "notice"),
                FrameItemId = J.Str(f, "itemId"), FrameOwned = J.Bool(f, "owned"), Total = J.Int(o, "total"), Owner = HallOwner.Parse(J.Opt(o, "owner")),
                Entries = J.List(o, "entries", HallPlaque.Parse), Criteria = J.Opt(o, "criteria") == null ? null : HallCriteria.Parse(J.Opt(o, "criteria")),
                PendingCeremonies = J.List(o, "pendingCeremonies", HallCeremony.Parse),
            };
        }
    }

    public sealed class HallProgress
    {
        public int Have, Need;
        public bool Met => Have >= Need;
        internal static HallProgress Parse(JsonNode o) => o == null ? null : new HallProgress { Have = J.Int(o, "have"), Need = J.Int(o, "need") };
    }

    /// <summary>REQ-HOF-010: GET /v1/horses/:horseId/career.</summary>
    public sealed class HorseCareer
    {
        public string HorseId, HorseName, Status;
        public bool Partner, Qualifies;
        public string[] Reasons = new string[0];
        public CareerLine Career = new CareerLine();
        public int RivalWins;
        /// <summary>Fastest verified time attack per course (ms).</summary>
        public Dictionary<string, int> BestTaMs = new Dictionary<string, int>();
        public HallProgress WinsProgress, PartnerRacesProgress;
        /// <summary>Null when the tournament rule is off.</summary>
        public bool? TournamentWin;
        /// <summary>What the ceremony would show if the horse retired now (null once retired).</summary>
        public List<HallHighlight> Preview;
        public HallCeremony Ceremony;
        public HallPlaque Entry;
        internal static HorseCareer Parse(JsonNode o)
        {
            var c = J.Opt(o, "career");
            var p = J.Opt(o, "progress");
            var hc = new HorseCareer
            {
                HorseId = J.Str(o, "horseId"), HorseName = J.Str(o, "horseName"), Status = J.Str(o, "status"), Partner = J.Bool(o, "partner"),
                Qualifies = J.Bool(o, "qualifies"), Reasons = J.Strs(o, "reasons") ?? new string[0], Career = CareerLine.Parse(c), RivalWins = J.Int(c, "rivalWins"),
                WinsProgress = HallProgress.Parse(J.Opt(p, "wins")), PartnerRacesProgress = HallProgress.Parse(J.Opt(p, "partnerRaces")),
                TournamentWin = J.Opt(p, "tournamentWin") == null ? (bool?)null : J.Bool(p, "tournamentWin"),
                Preview = J.Opt(o, "preview") == null ? null : J.List(o, "preview", HallHighlight.Parse),
                Ceremony = HallCeremony.Parse(J.Opt(o, "ceremony")),
                Entry = J.Opt(o, "entry") == null ? null : HallPlaque.Parse(J.Opt(o, "entry")),
            };
            foreach (var kv in J.Map(c, "bestTa", x => J.Int(x, "timeMs"))) hc.BestTaMs[kv.Key] = kv.Value;
            return hc;
        }
    }

    /// <summary>POST /v1/horses/:horseId/retire: the retired horse and its ceremony (null when the hall is disabled).</summary>
    public sealed class RetireResult
    {
        public Horse Horse;
        public HallCeremony Ceremony;
        internal static RetireResult Parse(JsonNode o) => new RetireResult { Horse = Horse.Parse(o), Ceremony = HallCeremony.Parse(J.Opt(o, "ceremony")) };
    }

    public sealed partial class ApiClient
    {
        private static string HallQuery(string cursor, int? limit)
        {
            var q = new List<string>();
            if (!string.IsNullOrEmpty(cursor)) q.Add("cursor=" + Uri.EscapeDataString(cursor));
            if (limit.HasValue) q.Add("limit=" + limit.Value);
            return q.Count > 0 ? "?" + string.Join("&", q) : "";
        }

        /// <summary>REQ-HOF-009: my hall (newest first), ceremonies not yet shown, the criteria, the frame and my visibility.</summary>
        public Task<HallPage> GetMyHallAsync(string cursor = null, int? limit = null, CancellationToken ct = default)
            => Call("GET", "/v1/hall" + HallQuery(cursor, limit), null, true, null, true, HallPage.Parse, ct);

        /// <summary>REQ-HOF-012: a friend's or branch member's hall. NotFound for every refusal (never says why).</summary>
        public Task<HallPage> GetHallAsync(string playerId, string cursor = null, int? limit = null, CancellationToken ct = default)
            => Call("GET", "/v1/hall/" + Seg(playerId) + HallQuery(cursor, limit), null, true, null, true, HallPage.Parse, ct);

        /// <summary>REQ-HOF-010: a horse's career record, progress toward 殿堂入り, its ceremony and plaque.</summary>
        public Task<HorseCareer> GetHorseCareerAsync(string horseId, CancellationToken ct = default)
            => Call("GET", "/v1/horses/" + Seg(horseId) + "/career", null, true, null, true, HorseCareer.Parse, ct);

        /// <summary>REQ-HOF-004: the ceremony was shown. Idempotent, so it is retried safely.</summary>
        public Task<long> AcknowledgeCeremonyAsync(string horseId, CancellationToken ct = default)
            => Call("POST", "/v1/hall/ceremonies/" + Seg(horseId) + "/ack", JsonNode.Obj(), true, null, true, o => J.Long(o, "ackedAt"), ct);

        /// <summary>REQ-HOF-009: friends_team (default) | friends | private.</summary>
        public Task<string> SetHallVisibilityAsync(string visibility, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("visibility", visibility);
            return Call("PUT", "/v1/hall/settings", b, true, null, true, o => J.Str(o, "visibility"), ct);
        }

        /// <summary>REQ-HOF-003: retire and get the ceremony. Not retried automatically (a resend would report HORSE_NOT_ACTIVE);
        /// a lost response is recovered from <see cref="GetMyHallAsync"/>'s PendingCeremonies.</summary>
        public Task<RetireResult> RetireHorseAsync(string horseId, CancellationToken ct = default)
            => Call("POST", "/v1/horses/" + Seg(horseId) + "/retire", JsonNode.Obj(), true, null, false, RetireResult.Parse, ct);
    }
}
