using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-RIVAL-001..016: ライバル (server/src/domain/rival.ts, contracts/protocol.md §28).
    // The server decides everything: who the rival is (deterministic weekly pairing, or a named CPU rival), the head-to-head
    // points (confirmed ranked races only), the week result and its fixed reward. The client shows it. A human rival is only
    // a public card (display name, title, class, silks, partner horse) — never anything else about that player.

    /// <summary>The partner horse on a rival's public card.</summary>
    public sealed class RivalPartner
    {
        public string Name, Rarity, Style;
        public Appearance Appearance;
        internal static RivalPartner Parse(JsonNode o) => o == null ? null : new RivalPartner
        {
            Name = J.Str(o, "name"), Rarity = J.Str(o, "rarity"), Style = J.Str(o, "style"), Appearance = Appearance.Parse(J.Opt(o, "appearance")),
        };
    }

    /// <summary>REQ-RIVAL-010: what a player may see of a human rival (the public profile copy plus the partner horse).</summary>
    public sealed class RivalCard
    {
        public string DisplayName, TitleId, ClassId;
        public Silks Silks;
        public RivalPartner Partner;
        internal static RivalCard Parse(JsonNode o) => o == null ? null : new RivalCard
        {
            DisplayName = J.Str(o, "displayName"), TitleId = J.Str(o, "titleId"), ClassId = J.Str(o, "classId"), Silks = Silks.Parse(J.Opt(o, "silks")), Partner = RivalPartner.Parse(J.Opt(o, "partner")),
        };
    }

    /// <summary>This week's rival. Kind: human | cpu. A dissolved human pair (block / opt-out / deletion) has no id and no card.</summary>
    public sealed class RivalInfo
    {
        public string Kind, PlayerId;
        public RivalCard Card;
        public bool Dissolved;
        // CPU rivals: a fixed name, personality and one line; the player scores at TargetPlace or better
        public string CpuId, Name, Personality, Line, Style, TaMedal;
        public int TargetPlace;
        public bool IsHuman => Kind == "human";
        public bool IsCpu => Kind == "cpu";
        /// <summary>The name to show (player-typed names are never translated).</summary>
        public string DisplayName => IsCpu ? Name : Card?.DisplayName;
        internal static RivalInfo Parse(JsonNode o) => o == null ? null : new RivalInfo
        {
            Kind = J.Str(o, "kind"), PlayerId = J.Str(o, "playerId"), Card = RivalCard.Parse(J.Opt(o, "card")), Dissolved = J.Bool(o, "dissolved"),
            CpuId = J.Str(o, "cpuId"), Name = J.Str(o, "name"), Personality = J.Str(o, "personality"), Line = J.Str(o, "line"), Style = J.Str(o, "style"),
            TaMedal = J.Str(o, "taMedal"), TargetPlace = J.Int(o, "targetPlace"),
        };
    }

    public sealed class RivalScore
    {
        public int Me, Them, RankedRaces, MinRaces, TaMe, TaThem;
        /// <summary>Enough own ranked races this week for the week result to pay.</summary>
        public bool Qualified => RankedRaces >= MinRaces;
        internal static RivalScore Parse(JsonNode o) => o == null ? null : new RivalScore
        {
            Me = J.Int(o, "me"), Them = J.Int(o, "them"), RankedRaces = J.Int(o, "rankedRaces"), MinRaces = J.Int(o, "minRaces"), TaMe = J.Int(o, "taMe"), TaThem = J.Int(o, "taThem"),
        };
    }

    /// <summary>One race of the week. Mode ranked scores (Point me | them); mode friend is a challenge race (no point). Them is null against a CPU.</summary>
    public sealed class RivalRace
    {
        public string RaceId, Mode, Point;
        public long At;
        public int Me;
        public int? Them;
        internal static RivalRace Parse(JsonNode o) => new RivalRace
        {
            RaceId = J.Str(o, "raceId"), Mode = J.Str(o, "mode"), Point = J.Str(o, "point"), At = J.Long(o, "at"), Me = J.Int(o, "me"), Them = J.IntN(o, "them"),
        };
    }

    /// <summary>Time attack this week on one course (ms). Faster: me | rival | null.</summary>
    public sealed class RivalTaRow
    {
        public string TrackId, TrackName, Faster;
        public long? Me, Rival;
        internal static RivalTaRow Parse(JsonNode o) => new RivalTaRow
        {
            TrackId = J.Str(o, "trackId"), TrackName = J.Str(o, "trackName"), Faster = J.Str(o, "faster"), Me = J.LongN(o, "me"), Rival = J.LongN(o, "rival"),
        };
    }

    /// <summary>A settled week. Outcome: win | lose | draw | no_contest | not_enough. FreeCoins = what was actually granted. RivalName = the human's display name (never translated) or the CPU's name.</summary>
    public sealed class RivalResult
    {
        public string WeekId, Outcome, Kind, RivalName;
        public int Me, Them, TaMe, TaThem, FreeCoins;
        public long SettledAt;
        public List<string> NewTitles = new List<string>();
        internal static RivalResult Parse(JsonNode o) => o == null ? null : new RivalResult
        {
            WeekId = J.Str(o, "weekId"), Outcome = J.Str(o, "outcome"), Kind = J.Str(o, "kind"), RivalName = J.Str(o, "rivalName") ?? J.Str(o, "cpuName"),
            Me = J.Int(o, "me"), Them = J.Int(o, "them"), TaMe = J.Int(o, "taMe"), TaThem = J.Int(o, "taThem"), FreeCoins = J.Int(o, "freeCoins"), SettledAt = J.Long(o, "settledAt"),
            NewTitles = J.List(o, "newTitles", x => x.AsString()),
        };
    }

    public sealed class RivalTitle
    {
        public string TitleId, Name;
        public int WeeksWon;
        public bool Unlocked;
        internal static RivalTitle Parse(JsonNode o) => o == null ? null : new RivalTitle { TitleId = J.Str(o, "titleId"), Name = J.Str(o, "name"), WeeksWon = J.Int(o, "weeksWon"), Unlocked = J.Bool(o, "unlocked") };
    }

    /// <summary>Weeks won in total (not in a row) and the cosmetic titles they unlock.</summary>
    public sealed class RivalRecord
    {
        public int WeeksWon, WeeksPlayed;
        public List<RivalTitle> Titles = new List<RivalTitle>();
        public RivalTitle NextTitle;
        internal static RivalRecord Parse(JsonNode o) => o == null ? new RivalRecord() : new RivalRecord
        {
            WeeksWon = J.Int(o, "weeksWon"), WeeksPlayed = J.Int(o, "weeksPlayed"), Titles = J.List(o, "titles", RivalTitle.Parse), NextTitle = RivalTitle.Parse(J.Opt(o, "nextTitle")),
        };
    }

    /// <summary>The fixed free coins per result (no randomness, no streak bonus).</summary>
    public sealed class RivalRewards
    {
        public int Win, Draw, Lose, NoContest, MinRaces;
        internal static RivalRewards Parse(JsonNode o) => o == null ? new RivalRewards() : new RivalRewards
        {
            Win = J.Int(o, "win"), Draw = J.Int(o, "draw"), Lose = J.Int(o, "lose"), NoContest = J.Int(o, "noContest"), MinRaces = J.Int(o, "minRaces"),
        };
    }

    public sealed class RivalRules
    {
        public bool RankedOnly = true, ChallengeUnranked = true, FixedRewards = true, NoStreakRewards = true, TaBreaksTies = true;
        internal static RivalRules Parse(JsonNode o) => o == null ? new RivalRules() : new RivalRules
        {
            RankedOnly = J.Bool(o, "rankedOnly", true), ChallengeUnranked = J.Bool(o, "challengeUnranked", true), FixedRewards = J.Bool(o, "fixedRewards", true),
            NoStreakRewards = J.Bool(o, "noStreakRewards", true), TaBreaksTies = J.Bool(o, "taBreaksTies", true),
        };
    }

    /// <summary>GET /v1/rival. Enabled=false → hide the card. OptOut → Rival is null.</summary>
    public sealed class RivalView
    {
        public bool Enabled, OptOut;
        public string WeekId;
        public long WeekEndsAt;
        public RivalInfo Rival;
        public RivalScore Score;
        public List<RivalRace> Recent = new List<RivalRace>();
        public List<RivalTaRow> TimeAttack = new List<RivalTaRow>();
        /// <summary>A settled week the result sheet has not shown yet (show once, then MarkRivalResultSeenAsync).</summary>
        public RivalResult Result;
        public List<RivalResult> History = new List<RivalResult>();
        public RivalRecord Record = new RivalRecord();
        public RivalRewards Rewards = new RivalRewards();
        /// <summary>ライバルと走る: challenges left today (null = no live human rival to challenge).</summary>
        public int? ChallengesLeft;
        public int ChallengesPerDay;
        public RivalRules Rules = new RivalRules();

        internal static RivalView Parse(JsonNode o)
        {
            if (o == null) return null;
            var ch = J.Opt(o, "challenge");
            return new RivalView
            {
                Enabled = J.Bool(o, "enabled"), OptOut = J.Bool(o, "optOut"), WeekId = J.Str(o, "weekId"), WeekEndsAt = J.Long(o, "weekEndsAt"),
                Rival = RivalInfo.Parse(J.Opt(o, "rival")), Score = RivalScore.Parse(J.Opt(o, "score")),
                Recent = J.List(o, "recent", RivalRace.Parse), TimeAttack = J.List(o, "timeAttack", RivalTaRow.Parse),
                Result = RivalResult.Parse(J.Opt(o, "result")), History = J.List(o, "history", RivalResult.Parse),
                Record = RivalRecord.Parse(J.Opt(o, "record")), Rewards = RivalRewards.Parse(J.Opt(o, "rewards")),
                ChallengesLeft = ch == null ? (int?)null : J.Int(ch, "left"), ChallengesPerDay = J.Int(ch, "perDay"), Rules = RivalRules.Parse(J.Opt(o, "rules")),
            };
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-RIVAL-009: this week's rival, score, recent races, time-attack comparison, an unseen week result.</summary>
        public Task<RivalView> GetRivalAsync(CancellationToken ct = default)
            => Call("GET", "/v1/rival", null, true, null, true, RivalView.Parse, ct);

        /// <summary>REQ-RIVAL-011: opt out (this week's pair is dissolved for both; no rival from next week) or back in.</summary>
        public Task<bool> SetRivalOptOutAsync(bool optOut, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("optOut", optOut);
            return Call("PUT", "/v1/rival/settings", b, true, null, true, o => J.Bool(o, "optOut"), ct);
        }

        /// <summary>REQ-RIVAL-011: block this week's human rival (the one block list, shared with the team feed) and dissolve the pair. NOT_ELIGIBLE without a human rival.</summary>
        public Task<string> BlockRivalAsync(CancellationToken ct = default)
            => Call("POST", "/v1/rival/block", null, true, null, true, o => J.Str(o, "blocked"), ct);

        /// <summary>
        /// REQ-RIVAL-008: ライバルと走る — invite this week's rival to a friend room you are in (create it first). Unranked: the race
        /// shows on the rival screen but never scores. ConflictException RIVAL_CHALLENGE_LIMIT, NOT_ELIGIBLE.
        /// Keyed (Round 13): a retry after a timeout reuses the key, so it never uses a second daily challenge or re-sends the invite.
        /// </summary>
        public Task<string> ChallengeRivalAsync(string passphrase, string idempotencyKey = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("passphrase", passphrase);
            return Call("POST", "/v1/rival/challenge", b, true, idempotencyKey ?? NewIdempotencyKey(), true, o => J.Str(o, "rivalId"), ct);
        }

        /// <summary>The week result sheet was shown.</summary>
        public Task<bool> MarkRivalResultSeenAsync(string weekId, CancellationToken ct = default)
            => Call("POST", "/v1/rival/results/" + Seg(weekId) + "/seen", null, true, null, true, o => true, ct);
    }
}
