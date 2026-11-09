using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>One milestone marker of the goal bar.</summary>
    public sealed class GoalMilestoneRow
    {
        public int Tier, Target;
        public bool Reached;
        /// <summary>Where the marker sits on the bar (0..1 of the last milestone's target).</summary>
        public float Position;
        /// <summary>"1段目".</summary>
        public string TierText;
        /// <summary>"18レース" / "6勝" / "3回".</summary>
        public string TargetText;
        /// <summary>"無償コイン5枚" (UxText.Reward).</summary>
        public string RewardText;
    }

    /// <summary>One contributor row (the name is what the player typed: screens show it as is, never through Loc.T).</summary>
    public sealed class GoalContributorRow
    {
        public int Rank, N;
        public string PlayerId, Name;
        public bool Mine;
        /// <summary>"20レース".</summary>
        public string CountText;
    }

    /// <summary>The week result sheet (shown once per closed week).</summary>
    public sealed class GoalResultSheet
    {
        public string Week, Label;
        public int Tier;
        /// <summary>"2段目に到達" / "段に届きませんでした".</summary>
        public string TierText;
        /// <summary>The reached tier's reward ("無償コイン10枚・配合素材×1"), or null.</summary>
        public string RewardText;
        /// <summary>"報酬はプレゼントボックスに届きました" / "受け取りの準備中です" / "貢献が最低限に届かず、今回は対象外でした".</summary>
        public string MineText;
        public List<GoalContributorRow> Top = new List<GoalContributorRow>();
    }

    /// <summary>
    /// REQ-TGOAL-*: the 支部 screen's weekly goal panel (pure C#, no UnityEngine).
    /// - Milestone bar: <see cref="ProgressFraction"/> and one marker per milestone (<see cref="Milestones"/>), with each tier's
    ///   fixed reward. Progress comes only from server-confirmed results (there is no button that adds to it).
    /// - Contributions: my contribution against the minimum, today's count against the daily cap, top contributors.
    /// - Week result sheet: after a week closes, <see cref="Result"/> once (dismissed per week, kept on the device).
    /// Texts are Japanese (screens show Loc.T(text)); player names and the team name are shown as typed.
    /// </summary>
    public sealed class TeamGoalModel : ScreenModel
    {
        public const string KeySeenWeek = "muchi.teamgoal.result_seen";
        public const string RulesText = "支部員みんなのレース結果で進みます。1人が1日に積める数には上限があります。週の終わり（月曜4:00）に、最低限貢献した支部員全員へ届いた段の報酬を配ります（無償・抽選なし）。";

        private readonly NowMs _now;
        public TeamGoalModel(GameBackend backend, NowMs now = null) : base(backend, backend?.Store)
        {
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public TeamGoalView View { get; private set; }
        public TeamGoalWeek Week => View?.Current;
        public bool InTeam => View != null && View.InTeam;
        public bool HasGoal => Week != null;

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            if (!ServerAvailable) { View = null; return Offline("共同目標はオンラインで見られます"); }
            try
            {
                View = await B.Api.GetTeamGoalAsync(ct);
                Online = true;
                Message = null;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>The unit of the week's kind ("レース" / "勝" / "回更新").</summary>
        public static string Unit(string kind) => kind == "wins" ? "勝" : kind == "ta_pb" ? "回更新" : "レース";
        private static string Count(int n, string kind) => n.ToString(CultureInfo.InvariantCulture) + Unit(kind);

        /// <summary>Why the panel shows no goal (null when it does).</summary>
        public string EmptyText => !ServerAvailable && View == null ? UxText.Offline : View == null ? null : !View.Enabled ? "共同目標は準備中です" : !InTeam ? "支部に入ると共同目標に参加できます" : null;

        /// <summary>Bar fill 0..1 (of the last milestone).</summary>
        public float ProgressFraction => Week == null || Week.FinalTarget <= 0 ? 0f : Math.Min(1f, Week.Progress / (float)Week.FinalTarget);

        /// <summary>"進み具合 38 / 60レース".</summary>
        public string ProgressText => Week == null ? null : "進み具合 " + Week.Progress.ToString(CultureInfo.InvariantCulture) + " / " + Count(Week.FinalTarget, Week.Kind);

        public List<GoalMilestoneRow> Milestones => Week == null ? new List<GoalMilestoneRow>() : Week.Milestones.Select(x => new GoalMilestoneRow
        {
            Tier = x.Tier, Target = x.Target, Reached = x.Reached,
            Position = Week.FinalTarget <= 0 ? 0f : Math.Min(1f, x.Target / (float)Week.FinalTarget),
            TierText = x.Tier.ToString(CultureInfo.InvariantCulture) + "段目", TargetText = Count(x.Target, Week.Kind), RewardText = UxText.Reward(x.Reward, ItemName),
        }).ToList();

        /// <summary>"次の段まで あと3レース" / "最後の段に到達しました".</summary>
        public string NextText
        {
            get
            {
                if (Week == null) return null;
                var next = Week.Milestones.FirstOrDefault(x => !x.Reached);
                return next == null ? "最後の段に到達しました" : "次の段まで あと" + Count(next.Target - Week.Progress, Week.Kind);
            }
        }

        /// <summary>"あなたの貢献 4レース（報酬は3レースから）".</summary>
        public string MyText => Week == null ? null : "あなたの貢献 " + Count(Week.MyContribution, Week.Kind) + "（報酬は" + Count(Week.MinContribution, Week.Kind) + "から）";

        /// <summary>"報酬の対象です" / "あと2レースで報酬の対象".</summary>
        public string QualifiedText => Week == null ? null : Week.Qualified ? "報酬の対象です" : "あと" + Count(Week.MinContribution - Week.MyContribution, Week.Kind) + "で報酬の対象";

        /// <summary>"今日 6 / 10（1日の上限）" — the cap is per member so one player cannot carry the team.</summary>
        public string TodayText => Week == null ? null : "今日 " + Week.MyToday.ToString(CultureInfo.InvariantCulture) + " / " + Week.DailyCap.ToString(CultureInfo.InvariantCulture) + "（1日の上限）";
        public string CappedText => Week != null && Week.TodayCapped ? "今日の上限に届きました。4:00に戻ります" : null;

        /// <summary>The week is over and the team's result is being counted (the server closes it on its next call / alarm).</summary>
        public bool Closing => Week != null && _now() >= Week.EndsAt;

        /// <summary>"12月14日 4:00 締め".</summary>
        public string EndsText => Week == null ? null : DeletionGuard.JstDate(Week.EndsAt) + " 4:00 締め";

        public List<GoalContributorRow> Contributors => Rows(Week?.Top, Week?.Kind);

        private List<GoalContributorRow> Rows(List<TeamGoalContributor> top, string kind)
        {
            var me = B.Player?.Id;
            return (top ?? new List<TeamGoalContributor>()).Select((x, i) => new GoalContributorRow
            {
                Rank = i + 1, PlayerId = x.PlayerId, Name = x.DisplayName, N = x.N, Mine = me != null && x.PlayerId == me, CountText = Count(x.N, kind),
            }).ToList();
        }

        private string ItemName(string itemId) => itemId == "breeding_material" ? "配合素材" : itemId == "gacha_ticket" ? "スカウト券" : itemId == "gacha_ticket_10" ? "10連スカウト券" : itemId;

        // ------------------------------------------------------------------ week result sheet

        /// <summary>The last closed week's result, until it was dismissed on this device.</summary>
        public GoalResultSheet Result
        {
            get
            {
                var r = View?.LastWeek;
                if (r == null || Kv.Get(KeySeenWeek) == r.Week) return null;
                return new GoalResultSheet
                {
                    Week = r.Week, Label = r.Label, Tier = r.Tier,
                    TierText = r.Tier > 0 ? r.Tier.ToString(CultureInfo.InvariantCulture) + "段目に到達" : "段に届きませんでした",
                    RewardText = r.Reward == null ? null : UxText.Reward(r.Reward, ItemName),
                    MineText = r.Tier == 0 ? "次の週も支部のみんなで挑戦しましょう" : r.Paid ? "報酬はプレゼントボックスに届きました" : r.Eligible ? "受け取りの準備中です" : "貢献が最低限に届かず、今回は対象外でした",
                    Top = Rows(r.Top, r.Kind),
                };
            }
        }

        public void DismissResult()
        {
            var r = View?.LastWeek;
            if (r != null) Kv.Set(KeySeenWeek, r.Week);
        }
    }
}
