using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-GOAL-001..012 目標の階段 — the goal ladder (server/src/domain/goals.ts, contracts/protocol.md「目標の階段」).
    // today (daily missions + the first-win bonus) → the beginner path while it lasts → this week (weekly challenge, rival,
    // team goal) → this season (class line, own pace, how much of the partner the class lets race, the class ladder, the
    // season missions, the pass level), and one claim for every claimable mission on it. The server decides; the client
    // draws. Nothing here is purchasable or moves paid coins.

    /// <summary>One goal row (a daily / beginner / season mission or today's first-win bonus).</summary>
    public sealed class GoalItem
    {
        public string Id, Table, Kind;
        public int Progress, Target;
        public Reward Reward;
        public bool Claimed, Claimable;
        public bool Done => Progress >= Target;
        internal static GoalItem Parse(JsonNode o) => o == null ? null : new GoalItem
        {
            Id = J.Str(o, "id"), Table = J.Str(o, "table"), Kind = J.Str(o, "kind"), Progress = J.Int(o, "progress"), Target = J.Int(o, "target"),
            Reward = Reward.Parse(J.Opt(o, "reward")), Claimed = J.Bool(o, "claimed"), Claimable = J.Bool(o, "claimable"),
        };
    }

    public sealed class GoalToday
    {
        public bool Open, Complete, LoginBonusOpen, LoginBonusClaimedToday;
        /// <summary>REQ-GOAL-011: the next login bonus claim (today's if not claimed, else tomorrow's): beginner | normal, its day of Days, its reward. Null when none.</summary>
        public string LoginNextTrack;
        public int LoginNextDay, LoginNextDays;
        public Reward LoginNextReward;
        public List<GoalItem> Items = new List<GoalItem>();
        public int Done, Total, Claimable;
        /// <summary>Start of the next game day (the daily set renews). A real time, shown as a time of day, never a countdown.</summary>
        public long ResetAt;
        internal static GoalToday Parse(JsonNode o)
        {
            var lb = J.Opt(o, "loginBonus"); var nx = J.Opt(lb, "next");
            return new GoalToday
            {
                Open = J.Bool(o, "open"), Complete = J.Bool(o, "complete"), Items = J.List(o, "items", GoalItem.Parse), Done = J.Int(o, "done"), Total = J.Int(o, "total"),
                Claimable = J.Int(o, "claimable"), ResetAt = J.Long(o, "resetAt"), LoginBonusOpen = J.Bool(lb, "open"), LoginBonusClaimedToday = J.Bool(lb, "claimedToday"),
                LoginNextTrack = J.Str(nx, "track"), LoginNextDay = J.Int(nx, "day"), LoginNextDays = J.Int(nx, "days"), LoginNextReward = nx == null ? null : Reward.Parse(J.Opt(nx, "reward")),
            };
        }
    }

    public sealed class GoalPath
    {
        public int Step, Steps, Done;
        public GoalItem Current;
        public Reward FinalReward;
        internal static GoalPath Parse(JsonNode o) => o == null ? null : new GoalPath
        {
            Step = J.Int(o, "step"), Steps = J.Int(o, "steps"), Done = J.Int(o, "done"), Current = GoalItem.Parse(J.Opt(o, "current")), FinalReward = Reward.Parse(J.Opt(o, "finalReward")),
        };
    }

    public sealed class GoalWeek
    {
        public long EndsAt;
        // weekly challenge (null = not open)
        public bool HasChallenge, BadgeEarned;
        public int ChallengeCleared, ChallengeTotal;
        public Reward ChallengeReward;
        public string BadgeName;
        // rival (null = none this week)
        public bool HasRival;
        public string RivalKind;
        public int RivalMe, RivalThem, RivalRankedRaces, RivalMinRaces, RivalWinCoins;
        // team goal (null = not in a team)
        public bool HasTeamGoal;
        public int TeamProgress, TeamReached, TeamTiers;
        public int? TeamNextTarget;
        internal static GoalWeek Parse(JsonNode o)
        {
            if (o == null) return null;
            var c = J.Opt(o, "challenge"); var r = J.Opt(o, "rival"); var t = J.Opt(o, "teamGoal");
            return new GoalWeek
            {
                EndsAt = J.Long(o, "endsAt"),
                HasChallenge = c != null, ChallengeCleared = J.Int(c, "cleared"), ChallengeTotal = J.Int(c, "total"), ChallengeReward = Reward.Parse(J.Opt(c, "reward")),
                BadgeName = J.Str(c, "badgeName"), BadgeEarned = J.Bool(c, "badgeEarned"),
                HasRival = r != null, RivalKind = J.Str(r, "kind"), RivalMe = J.Int(r, "me"), RivalThem = J.Int(r, "them"), RivalRankedRaces = J.Int(r, "rankedRaces"),
                RivalMinRaces = J.Int(r, "minRaces"), RivalWinCoins = J.Int(J.Opt(r, "winReward"), "freeCoins"),
                HasTeamGoal = t != null, TeamProgress = J.Int(t, "progress"), TeamReached = J.Int(t, "reached"), TeamTiers = J.Int(t, "tiers"), TeamNextTarget = J.IntN(t, "nextTarget"),
            };
        }
    }

    /// <summary>One class of the ranked ladder (C → B → A → S) with its cap and season rewards.</summary>
    public sealed class GoalClassRow
    {
        public string ClassId;
        public int StatCap;
        public int? PromotePoints, DemoteBelowPoints, TopMaxRank;
        public bool Current, Reached;
        public Reward TopReward, FloorReward;
        internal static GoalClassRow Parse(JsonNode o)
        {
            var rw = J.Opt(o, "rewards"); var top = J.Opt(rw, "top");
            return new GoalClassRow
            {
                ClassId = J.Str(o, "classId"), StatCap = J.Int(o, "statCap"), PromotePoints = J.IntN(o, "promotePoints"), DemoteBelowPoints = J.IntN(o, "demoteBelowPoints"),
                Current = J.Bool(o, "current"), Reached = J.Bool(o, "reached"), TopMaxRank = J.IntN(top, "maxRank"),
                TopReward = top == null ? null : Reward.Parse(J.Opt(top, "reward")), FloorReward = J.Opt(rw, "floor") == null ? null : Reward.Parse(J.Opt(rw, "floor")),
            };
        }
    }

    public sealed class GoalSeason
    {
        public bool Open;
        public string SeasonId, ClassId, NextClassId;
        /// <summary>rookie | climbing | line_reached | top</summary>
        public string Status;
        public long EndsAt;
        public int Points, Races;
        public int? Line, Left, DemoteBelow;
        /// <summary>The player's own points per ranked race × 10 this season (null below <see cref="PaceMinRaces"/> races).</summary>
        public int? Pace10, RacesToLine;
        public int PaceMinRaces;
        // the partner's strength against the class cap (REQ-GOAL-006); HasPower false = no horse
        public bool HasPower, PowerIsPartner;
        public string PowerHorseId;
        public int PowerTotal, PowerCap, PowerUsable, PowerHeld;
        public int? PowerNextCap, PowerNextUsable;
        public List<GoalClassRow> Ladder = new List<GoalClassRow>();
        public List<GoalItem> Missions = new List<GoalItem>();
        public int PassLevel, PassMaxLevel, PassFreeClaimable;
        /// <summary>§68 (Round 22) promotion series brief when the server has it: active | passed | failed | season_end, or null.</summary>
        public string PromotionStatus;
        public int? PromotionNext;
        public int PromotionRaces, PromotionTops, PromotionMisses, PromotionNeedTop;
        internal static GoalSeason Parse(JsonNode o)
        {
            var pace = J.Opt(o, "pace"); var pw = J.Opt(o, "power"); var pass = J.Opt(o, "pass"); var pr = J.Opt(o, "promotion");
            return new GoalSeason
            {
                Open = J.Bool(o, "open"), SeasonId = J.Str(o, "seasonId"), ClassId = J.Str(o, "classId"), NextClassId = J.Str(o, "nextClassId"), Status = J.Str(o, "status"),
                EndsAt = J.Long(o, "endsAt"), Points = J.Int(o, "points"), Races = J.Int(o, "races"), Line = J.IntN(o, "line"), Left = J.IntN(o, "left"), DemoteBelow = J.IntN(o, "demoteBelow"),
                Pace10 = J.IntN(pace, "pace10"), RacesToLine = J.IntN(pace, "racesToLine"), PaceMinRaces = J.Int(pace, "minRaces"),
                HasPower = pw != null, PowerIsPartner = J.Bool(pw, "partner"), PowerHorseId = J.Str(pw, "horseId"), PowerTotal = J.Int(pw, "total"), PowerCap = J.Int(pw, "cap"),
                PowerUsable = J.Int(pw, "usable"), PowerHeld = J.Int(pw, "held"), PowerNextCap = J.IntN(pw, "nextCap"), PowerNextUsable = J.IntN(pw, "nextUsable"),
                Ladder = J.List(o, "ladder", GoalClassRow.Parse), Missions = J.List(o, "missions", GoalItem.Parse),
                PassLevel = J.Int(pass, "level"), PassMaxLevel = J.Int(pass, "maxLevel"), PassFreeClaimable = J.Int(pass, "freeClaimable"),
                PromotionStatus = J.Str(pr, "status"), PromotionNext = J.IntN(pr, "next"), PromotionRaces = J.Int(pr, "races"), PromotionTops = J.Int(pr, "tops"),
                PromotionMisses = J.Int(pr, "misses"), PromotionNeedTop = J.Int(pr, "needTop"),
            };
        }
    }

    /// <summary>GET /v1/home/goals.</summary>
    public sealed class GoalLadderView
    {
        public string Day;
        public long Now;
        public GoalToday Today;
        public GoalPath Path;
        public GoalWeek Week;
        public GoalSeason Season;
        /// <summary>Missions ready to claim across the ladder (one claim takes them all).</summary>
        public int Claimable;
        internal static GoalLadderView Parse(JsonNode o) => o == null ? null : new GoalLadderView
        {
            Day = J.Str(o, "day"), Now = J.Long(o, "now"), Today = GoalToday.Parse(J.Opt(o, "today")), Path = GoalPath.Parse(J.Opt(o, "path")), Week = GoalWeek.Parse(J.Opt(o, "week")),
            Season = GoalSeason.Parse(J.Opt(o, "season")), Claimable = J.Int(o, "claimable"),
        };
        public static GoalLadderView FromJson(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            try { return Parse(JsonNode.Parse(json)); } catch (FormatException) { return null; }
        }
    }

    /// <summary>POST /v1/home/goals/claim: what was claimed, the sum, and the ladder after.</summary>
    public sealed class GoalClaimResult
    {
        public sealed class Row { public string Id, Table; public Reward Reward; }
        public List<Row> Claimed = new List<Row>();
        public Reward Total;
        public GoalLadderView Ladder;
        internal static GoalClaimResult Parse(JsonNode o) => o == null ? null : new GoalClaimResult
        {
            Claimed = J.List(o, "claimed", x => new Row { Id = J.Str(x, "id"), Table = J.Str(x, "table"), Reward = Reward.Parse(J.Opt(x, "reward")) }),
            Total = Reward.Parse(J.Opt(o, "total")), Ladder = GoalLadderView.Parse(J.Opt(o, "ladder")),
        };
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-GOAL-001: today → this week → this season (reads only).</summary>
        public Task<GoalLadderView> GetGoalsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/home/goals", null, true, null, true, GoalLadderView.Parse, ct);

        /// <summary>
        /// REQ-GOAL-009: claim every claimable mission on the ladder at once (keyed: keep the key until the server answers so a
        /// retry never pays twice). ConflictException NOT_ELIGIBLE when nothing is claimable.
        /// </summary>
        public Task<GoalClaimResult> ClaimGoalsAsync(string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/home/goals/claim", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, GoalClaimResult.Parse, ct);
    }
}
