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
        /// <summary>REQ-GOAL-015 (the current first step only): the screen where it is done (fixed in code on the server:
        /// scout | silks | care | race | breeding | friends | teams | time_attack | collection), and whether it is open yet.</summary>
        public string Screen;
        public bool Open = true;
        /// <summary>REQ-GOAL-017 (the current first step only): the solo way of a social step (null = none / an older server).</summary>
        public GoalAlt Alt;
        /// <summary>REQ-GOAL-017: the player day the step opens (null = no day). <see cref="DayOk"/> false = it waits for that day.</summary>
        public int? FromDay;
        public bool DayOk = true;
        /// <summary>Its own target or its alternative's is met (from an older server: <see cref="Done"/>).</summary>
        public bool Reached;
        public bool Done => Progress >= Target;
        internal static GoalItem Parse(JsonNode o) => o == null ? null : new GoalItem
        {
            Id = J.Str(o, "id"), Table = J.Str(o, "table"), Kind = J.Str(o, "kind"), Progress = J.Int(o, "progress"), Target = J.Int(o, "target"),
            Reward = Reward.Parse(J.Opt(o, "reward")), Claimed = J.Bool(o, "claimed"), Claimable = J.Bool(o, "claimable"),
            Screen = J.Str(o, "screen"), Open = J.Opt(o, "open") == null || J.Bool(o, "open"),
            Alt = GoalAlt.Parse(J.Opt(o, "alt")), FromDay = J.IntN(o, "fromDay"), DayOk = J.Opt(o, "dayOk") == null || J.Bool(o, "dayOk"),
            Reached = J.Opt(o, "reached") == null ? J.Int(o, "progress") >= J.Int(o, "target") : J.Bool(o, "reached"),
        };
    }

    /// <summary>REQ-GOAL-017: the either/or of a first step — another kind that reaches it too (a solo way for a social step).</summary>
    public sealed class GoalAlt
    {
        public string Kind, Screen;
        public int Progress, Target;
        public bool Open = true;
        public bool Done => Progress >= Target;
        internal static GoalAlt Parse(JsonNode o) => o == null ? null : new GoalAlt
        {
            Kind = J.Str(o, "kind"), Progress = J.Int(o, "progress"), Target = J.Int(o, "target"), Screen = J.Str(o, "screen"), Open = J.Opt(o, "open") == null || J.Bool(o, "open"),
        };
    }

    /// <summary>REQ-GOAL-020 / REQ-ITEM-010: a training item would help (training.treatHint): before → after, from the training numbers.</summary>
    public sealed class TreatHint
    {
        public string ItemId, Name;
        public int Owned, Fatigue, FatigueAfter, EfficiencyPermille, EfficiencyAfterPermille;
        /// <summary>The horse is too tired to train; <see cref="Unblocks"/> = the treat lets it train again.</summary>
        public bool Tired, Unblocks;
        public static TreatHint Parse(JsonNode o) => o == null ? null : new TreatHint
        {
            ItemId = J.Str(o, "itemId"), Name = J.Str(o, "name"), Owned = J.Int(o, "owned"), Fatigue = J.Int(o, "fatigue"), FatigueAfter = J.Int(o, "fatigueAfter"),
            EfficiencyPermille = J.Int(o, "efficiencyPermille"), EfficiencyAfterPermille = J.Int(o, "efficiencyAfterPermille"), Tired = J.Bool(o, "tired"), Unblocks = J.Bool(o, "unblocks"),
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
        /// <summary>1 on the install day, 2 the next game day, … (0 from an older server).</summary>
        public int PlayerDay;
        /// <summary>REQ-GOAL-013: what tomorrow brings, facts only (null from an older server).</summary>
        public GoalTomorrow Tomorrow;
        internal static GoalToday Parse(JsonNode o)
        {
            var lb = J.Opt(o, "loginBonus"); var nx = J.Opt(lb, "next");
            return new GoalToday
            {
                PlayerDay = J.Int(o, "playerDay"), Tomorrow = GoalTomorrow.Parse(J.Opt(o, "tomorrow")),
                Open = J.Bool(o, "open"), Complete = J.Bool(o, "complete"), Items = J.List(o, "items", GoalItem.Parse), Done = J.Int(o, "done"), Total = J.Int(o, "total"),
                Claimable = J.Int(o, "claimable"), ResetAt = J.Long(o, "resetAt"), LoginBonusOpen = J.Bool(lb, "open"), LoginBonusClaimedToday = J.Bool(lb, "claimedToday"),
                LoginNextTrack = J.Str(nx, "track"), LoginNextDay = J.Int(nx, "day"), LoginNextDays = J.Int(nx, "days"), LoginNextReward = nx == null ? null : Reward.Parse(J.Opt(nx, "reward")),
            };
        }
    }

    /// <summary>REQ-GOAL-013: tomorrow on the ladder — the login bonus (once today's is received), the features whose day
    /// count is reached tomorrow, the training slots that refill. No countdown: <see cref="At"/> is the game day start.</summary>
    public sealed class GoalTomorrow
    {
        public int PlayerDay;
        public long At;
        /// <summary>beginner | normal, null when today's bonus is not received yet.</summary>
        public string LoginTrack;
        public int LoginDay, LoginDays;
        public Reward LoginReward;
        /// <summary>Feature keys (progression.unlocks) that open tomorrow by day count, in the unlock table's order.</summary>
        public List<string> Opens = new List<string>();
        /// <summary>Training slots tomorrow (null when training is not open by then).</summary>
        public int? TrainingSlots;
        /// <summary>REQ-GOAL-018: はじめの10歩 graduates tomorrow (the last step opens on that day): its reward (null = not tomorrow).</summary>
        public Reward GraduateReward;
        /// <summary>Every earlier step is done and the target met (claimable when the day starts); false = it is still the goal.</summary>
        public bool GraduateReady;
        internal static GoalTomorrow Parse(JsonNode o)
        {
            if (o == null) return null;
            var lb = J.Opt(o, "loginBonus"); var gr = J.Opt(o, "graduate");
            return new GoalTomorrow
            {
                PlayerDay = J.Int(o, "playerDay"), At = J.Long(o, "at"), LoginTrack = J.Str(lb, "track"), LoginDay = J.Int(lb, "day"), LoginDays = J.Int(lb, "days"),
                LoginReward = lb == null ? null : Reward.Parse(J.Opt(lb, "reward")), Opens = new List<string>(J.Strs(o, "opens") ?? new string[0]), TrainingSlots = J.IntN(o, "trainingSlots"),
                GraduateReward = gr == null ? null : Reward.Parse(J.Opt(gr, "reward")), GraduateReady = J.Bool(gr, "ready"),
            };
        }
    }

    /// <summary>REQ-GOAL-019: one day of the week-2 arc (player days 8..14): the login bonus it brings if the player comes every
    /// day (projected from the same tables), and graduation on its day.</summary>
    public sealed class GoalWeek2Day
    {
        public int PlayerDay;
        public bool Today, Past;
        public string LoginTrack;
        public int LoginDay, LoginDays;
        public Reward LoginReward, GraduateReward;
        public bool GraduateReady;
        internal static GoalWeek2Day Parse(JsonNode o)
        {
            var lb = J.Opt(o, "loginBonus"); var gr = J.Opt(o, "graduate");
            return new GoalWeek2Day
            {
                PlayerDay = J.Int(o, "playerDay"), Today = J.Bool(o, "today"), Past = J.Bool(o, "past"), LoginTrack = J.Str(lb, "track"), LoginDay = J.Int(lb, "day"), LoginDays = J.Int(lb, "days"),
                LoginReward = lb == null ? null : Reward.Parse(J.Opt(lb, "reward")), GraduateReward = gr == null ? null : Reward.Parse(J.Opt(gr, "reward")), GraduateReady = J.Bool(gr, "ready"),
            };
        }
    }

    /// <summary>REQ-GOAL-019: the week-2 arc (shown from day 7 to day 14; null otherwise or from an older server).</summary>
    public sealed class GoalWeek2
    {
        public int FromDay, ToDay;
        /// <summary>0 on the preview day (day 7), 1..7 inside the week.</summary>
        public int Day;
        public List<GoalWeek2Day> Days = new List<GoalWeek2Day>();
        /// <summary>The strongest login reward still ahead (null when none).</summary>
        public int? PeakDay;
        public Reward PeakReward;
        /// <summary>Graduation while the list is unfinished: its day (null = no day) and reward; null reward = graduated.</summary>
        public int? GraduateDay;
        public Reward GraduateReward;
        internal static GoalWeek2 Parse(JsonNode o)
        {
            if (o == null) return null;
            var pk = J.Opt(o, "peak"); var gr = J.Opt(o, "graduate");
            return new GoalWeek2
            {
                FromDay = J.Int(o, "fromDay"), ToDay = J.Int(o, "toDay"), Day = J.Int(o, "day"), Days = J.List(o, "days", GoalWeek2Day.Parse),
                PeakDay = J.IntN(pk, "playerDay"), PeakReward = pk == null ? null : Reward.Parse(J.Opt(pk, "reward")),
                GraduateDay = J.IntN(gr, "playerDay"), GraduateReward = gr == null ? null : Reward.Parse(J.Opt(gr, "reward")),
            };
        }
    }

    /// <summary>REQ-GOAL-014: the partner's growth on home (the 馬カード stage function: 0 新馬 … 4 完成).</summary>
    public sealed class GoalPartner
    {
        public string HorseId, Name, StageKey;
        public int Stage, Stages, StageFrom, TrainedTotal, Potential, GainedToday, GainedYesterday, SessionsLeft;
        /// <summary>The trained total where the next stage starts (null at the last stage).</summary>
        public int? NextStageAt;
        public bool TrainingOpen, Full;
        /// <summary>REQ-GOAL-020: a treat would help the partner train today (null = it does not matter now).</summary>
        public TreatHint Treat;
        internal static GoalPartner Parse(JsonNode o) => o == null ? null : new GoalPartner
        {
            Treat = TreatHint.Parse(J.Opt(o, "treat")),
            HorseId = J.Str(o, "horseId"), Name = J.Str(o, "name"), StageKey = J.Str(o, "stageKey"), Stage = J.Int(o, "stage"), Stages = J.Int(o, "stages"),
            StageFrom = J.Int(o, "stageFrom"), NextStageAt = J.IntN(o, "nextStageAt"), TrainedTotal = J.Int(o, "trainedTotal"), Potential = J.Int(o, "potential"),
            GainedToday = J.Int(o, "gainedToday"), GainedYesterday = J.Int(o, "gainedYesterday"), SessionsLeft = J.Int(o, "sessionsLeft"),
            TrainingOpen = J.Bool(o, "trainingOpen"), Full = J.Bool(o, "full"),
        };
    }

    public sealed class GoalPath
    {
        public int Step, Steps, Done;
        public GoalItem Current;
        public Reward FinalReward;
        /// <summary>REQ-GOAL-017: the day the last step opens (null = no day / an older server).</summary>
        public int? FinalFromDay;
        internal static GoalPath Parse(JsonNode o) => o == null ? null : new GoalPath
        {
            Step = J.Int(o, "step"), Steps = J.Int(o, "steps"), Done = J.Int(o, "done"), Current = GoalItem.Parse(J.Opt(o, "current")), FinalReward = Reward.Parse(J.Opt(o, "finalReward")),
            FinalFromDay = J.IntN(o, "finalFromDay"),
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
        // last week's rival result, while unseen (null = nothing new)
        public bool HasRivalResult;
        public string RivalResultOutcome;
        public int RivalResultMe, RivalResultThem, RivalResultCoins;
        internal static GoalWeek Parse(JsonNode o)
        {
            if (o == null) return null;
            var c = J.Opt(o, "challenge"); var r = J.Opt(o, "rival"); var t = J.Opt(o, "teamGoal"); var rr = J.Opt(o, "rivalResult");
            return new GoalWeek
            {
                EndsAt = J.Long(o, "endsAt"),
                HasChallenge = c != null, ChallengeCleared = J.Int(c, "cleared"), ChallengeTotal = J.Int(c, "total"), ChallengeReward = Reward.Parse(J.Opt(c, "reward")),
                BadgeName = J.Str(c, "badgeName"), BadgeEarned = J.Bool(c, "badgeEarned"),
                HasRival = r != null, RivalKind = J.Str(r, "kind"), RivalMe = J.Int(r, "me"), RivalThem = J.Int(r, "them"), RivalRankedRaces = J.Int(r, "rankedRaces"),
                RivalMinRaces = J.Int(r, "minRaces"), RivalWinCoins = J.Int(J.Opt(r, "winReward"), "freeCoins"),
                HasTeamGoal = t != null, TeamProgress = J.Int(t, "progress"), TeamReached = J.Int(t, "reached"), TeamTiers = J.Int(t, "tiers"), TeamNextTarget = J.IntN(t, "nextTarget"),
                HasRivalResult = rr != null, RivalResultOutcome = J.Str(rr, "outcome"), RivalResultMe = J.Int(rr, "me"), RivalResultThem = J.Int(rr, "them"), RivalResultCoins = J.Int(rr, "freeCoins"),
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
        /// <summary>REQ-GOAL-019: the week-2 arc (days 8..14, shown from day 7; null otherwise).</summary>
        public GoalWeek2 Week2;
        public GoalSeason Season;
        /// <summary>REQ-GOAL-014: the partner's growth (null without a partner, training off, or an older server).</summary>
        public GoalPartner Partner;
        /// <summary>Missions ready to claim across the ladder (one claim takes them all).</summary>
        public int Claimable;
        internal static GoalLadderView Parse(JsonNode o) => o == null ? null : new GoalLadderView
        {
            Day = J.Str(o, "day"), Now = J.Long(o, "now"), Today = GoalToday.Parse(J.Opt(o, "today")), Path = GoalPath.Parse(J.Opt(o, "path")), Week = GoalWeek.Parse(J.Opt(o, "week")),
            Season = GoalSeason.Parse(J.Opt(o, "season")), Partner = GoalPartner.Parse(J.Opt(o, "partner")), Claimable = J.Int(o, "claimable"),
            Week2 = GoalWeek2.Parse(J.Opt(o, "week2")),
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
