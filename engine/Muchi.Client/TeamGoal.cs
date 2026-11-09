using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-TGOAL-*: 支部の共同目標 (team weekly co-op goal). server/src/domain/teamGoal.ts, contracts/protocol.md §32.
    // Read-only for the client: contributions come only from server-confirmed events (settled races, verified time attack),
    // so there is no call that adds to the goal. Display names and the team name are what players typed: never translated.

    /// <summary>One milestone (段) of the week's goal.</summary>
    public sealed class TeamGoalMilestone
    {
        public int Tier, Target;
        public bool Reached;
        public Reward Reward;
        internal static TeamGoalMilestone Parse(JsonNode o) => new TeamGoalMilestone
        {
            Tier = J.Int(o, "tier"), Target = J.Int(o, "target"), Reached = J.Bool(o, "reached"), Reward = Reward.Parse(J.Opt(o, "reward")),
        };
    }

    /// <summary>A member's contribution (player-typed display name: shown as written in every language).</summary>
    public sealed class TeamGoalContributor
    {
        public string PlayerId, DisplayName;
        public int N;
        internal static TeamGoalContributor Parse(JsonNode o) => new TeamGoalContributor { PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), N = J.Int(o, "n") };
    }

    /// <summary>The running week.</summary>
    public sealed class TeamGoalWeek
    {
        /// <summary>Monday's game day "YYYY-MM-DD" (the week starts at the 04:00 JST rollover).</summary>
        public string Week, GoalId;
        /// <summary>"races" | "wins" | "ta_pb".</summary>
        public string Kind;
        /// <summary>Server-built (and server-translated) text, e.g. 「支部で合計60レース」 / "60 races as a branch".</summary>
        public string Label;
        public long EndsAt;
        public int Scale, Progress, Tier, MinContribution, Contributors;
        public List<TeamGoalMilestone> Milestones = new List<TeamGoalMilestone>();
        public int MyContribution, MyToday, DailyCap;
        public bool Qualified;
        public List<TeamGoalContributor> Top = new List<TeamGoalContributor>();
        public int FinalTarget => Milestones.Count > 0 ? Milestones[Milestones.Count - 1].Target : 0;
        public bool TodayCapped => DailyCap > 0 && MyToday >= DailyCap;
        internal static TeamGoalWeek Parse(JsonNode o)
        {
            if (o == null) return null;
            var my = J.Opt(o, "my");
            return new TeamGoalWeek
            {
                Week = J.Str(o, "week"), GoalId = J.Str(o, "goalId"), Kind = J.Str(o, "kind"), Label = J.Str(o, "label"), EndsAt = J.Long(o, "endsAt"),
                Scale = J.Int(o, "scale"), Progress = J.Int(o, "progress"), Tier = J.Int(o, "tier"), MinContribution = J.Int(o, "minContribution"), Contributors = J.Int(o, "contributors"),
                Milestones = J.List(o, "milestones", TeamGoalMilestone.Parse),
                MyContribution = J.Int(my, "contribution"), MyToday = J.Int(my, "today"), DailyCap = J.Int(my, "dailyCap"), Qualified = J.Bool(my, "qualified"),
                Top = J.List(o, "top", TeamGoalContributor.Parse),
            };
        }
    }

    /// <summary>The last closed week (the week result sheet).</summary>
    public sealed class TeamGoalResult
    {
        public string Week, GoalId, Kind, Label;
        public int[] Targets = new int[0];
        public int Progress, Tier;
        /// <summary>The reached tier's reward, or null when no milestone was reached.</summary>
        public Reward Reward;
        public List<TeamGoalContributor> Top = new List<TeamGoalContributor>();
        /// <summary>I was in the team at the close with at least the minimum contribution.</summary>
        public bool Eligible, Paid;
        internal static TeamGoalResult Parse(JsonNode o) => o == null ? null : new TeamGoalResult
        {
            Week = J.Str(o, "week"), GoalId = J.Str(o, "goalId"), Kind = J.Str(o, "kind"), Label = J.Str(o, "label"), Targets = J.Ints(o, "targets"),
            Progress = J.Int(o, "progress"), Tier = J.Int(o, "tier"), Reward = J.Opt(o, "reward") == null ? null : Reward.Parse(J.Opt(o, "reward")),
            Top = J.List(o, "top", TeamGoalContributor.Parse), Eligible = J.Bool(o, "eligible"), Paid = J.Bool(o, "paid"),
        };
    }

    public sealed class TeamGoalLastReward
    {
        public string Week, TeamId;
        public int Tier, Contribution;
        public Reward Reward;
        internal static TeamGoalLastReward Parse(JsonNode o) => o == null ? null : new TeamGoalLastReward
        {
            Week = J.Str(o, "week"), TeamId = J.Str(o, "teamId"), Tier = J.Int(o, "tier"), Contribution = J.Int(o, "contribution"), Reward = Reward.Parse(J.Opt(o, "reward")),
        };
    }

    /// <summary>GET /v1/teams/me/goal.</summary>
    public sealed class TeamGoalView
    {
        /// <summary>null = not in a team.</summary>
        public string TeamId, TeamName;
        public bool Enabled;
        public TeamGoalWeek Current;
        public TeamGoalResult LastWeek;
        /// <summary>Units I sent today (account-wide daily cap), by kind.</summary>
        public int SentRaces, SentWins, SentTaPb, Pending;
        public TeamGoalLastReward LastReward;
        public bool InTeam => TeamId != null;
        internal static TeamGoalView Parse(JsonNode o)
        {
            var p = J.Opt(o, "player");
            var sent = J.Opt(p, "sentToday");
            return new TeamGoalView
            {
                TeamId = J.Str(o, "teamId"), TeamName = J.Str(o, "teamName"), Enabled = J.Bool(o, "enabled", true),
                Current = TeamGoalWeek.Parse(J.Opt(o, "current")), LastWeek = TeamGoalResult.Parse(J.Opt(o, "lastWeek")),
                SentRaces = J.Int(sent, "races"), SentWins = J.Int(sent, "wins"), SentTaPb = J.Int(sent, "ta_pb"), Pending = J.Int(p, "pending"),
                LastReward = TeamGoalLastReward.Parse(J.Opt(p, "lastReward")),
            };
        }
    }

    /// <summary>The goal of a team feed item of kind "goal" (a milestone was reached).</summary>
    public sealed class FeedGoalInfo
    {
        public string Week, GoalId, Label;
        public int Tier, Target, Tiers;
        internal static FeedGoalInfo Parse(JsonNode o) => o == null ? null : new FeedGoalInfo
        {
            Week = J.Str(o, "week"), GoalId = J.Str(o, "goalId"), Label = J.Str(o, "label"), Tier = J.Int(o, "tier"), Target = J.Int(o, "target"), Tiers = J.Int(o, "tiers"),
        };
    }

    public sealed partial class ApiClient
    {
        // ------------------------------------------------------------------ 支部の共同目標 (REQ-TGOAL-*)

        /// <summary>My team's weekly goal: progress, milestones, my contribution, top contributors and last week's result. Safe to retry.</summary>
        public Task<TeamGoalView> GetTeamGoalAsync(CancellationToken ct = default)
            => Call("GET", "/v1/teams/me/goal", null, true, null, true, TeamGoalView.Parse, ct);
    }
}
