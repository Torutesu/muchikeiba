using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-RIVAL-001..016 (contracts/protocol.md §28, docs/handoff-codex-round12-rival.md): ライバル, the game layer.
    // Pure C#: Codex's home card, detail screen and week-result sheet bind to the public fields. The server decides the rival,
    // the points and the reward; the model formats them, shows the result sheet once and sends the player's choices.

    /// <summary>One line of "最近のレース".</summary>
    public sealed class RivalRaceLine
    {
        public string RaceId;
        /// <summary>"3着 vs 5着" / "4着（目標6着以内）" / "挑戦状 2着 vs 1着".</summary>
        public string Text;
        /// <summary>"me" | "them" | null (challenge races never score).</summary>
        public string Point;
        public bool Challenge;
    }

    /// <summary>One course of the time-attack comparison.</summary>
    public sealed class RivalTaLine
    {
        public string TrackId, TrackName, MeText, RivalText;
        /// <summary>"me" | "rival" | null.</summary>
        public string Faster;
    }

    /// <summary>The week-result sheet (shown once per settled week).</summary>
    public sealed class RivalResultSheet
    {
        public string WeekId, Outcome;
        /// <summary>"勝ち" / "負け" / "引き分け" / "解除" / "記録なし".</summary>
        public string Headline;
        /// <summary>"直接対決 3 - 1" (+ "・タイムアタック 2 - 1" when it broke a tie).</summary>
        public string ScoreText;
        /// <summary>"vs 堅実のアサギ".</summary>
        public string RivalText;
        /// <summary>"無償コイン20枚" or null (nothing paid).</summary>
        public string RewardText;
        /// <summary>Names of titles unlocked by this week ("好敵手").</summary>
        public List<string> NewTitles = new List<string>();
        /// <summary>"ランク戦が3戦に届かなかったため、報酬はありません" etc.</summary>
        public string Note;
    }

    /// <summary>
    /// The rival card on home, the rival detail and the week-result sheet. Rules the model keeps for the screens:
    ///  - a human rival is shown only through the public card (name, class, title, silks, partner horse);
    ///  - the result sheet appears once: <see cref="DismissResultAsync"/> marks it seen;
    ///  - ライバルと走る is a friend-room challenge — create a room, then <see cref="ChallengeAsync"/> with its passphrase;
    ///    it never scores (stated in <see cref="RulesText"/>);
    ///  - opt-out and block are always reachable from the detail screen; there is no shop link anywhere.
    /// </summary>
    public sealed class RivalModel : ScreenModel
    {
        public const string RulesText = "同じランク戦で先着した方に1点。直接対決が同点なら、今週のタイムアタックで速いコースの多い方が勝ち。挑戦状のレースは点になりません。報酬は結果で決まる固定の額で、連勝の上乗せはありません。";

        public static readonly IReadOnlyDictionary<string, string> OutcomeTexts = new Dictionary<string, string>
        {
            ["win"] = "勝ち", ["lose"] = "負け", ["draw"] = "引き分け", ["no_contest"] = "解除", ["not_enough"] = "記録なし",
        };
        public static readonly IReadOnlyDictionary<string, string> StyleTexts = new Dictionary<string, string>
        {
            ["nige"] = "逃げ", ["senko"] = "先行", ["sashi"] = "差し", ["oikomi"] = "追込",
        };

        private readonly NowMs _now;
        public RivalModel(GameBackend backend, IKeyValueStore store = null, NowMs now = null) : base(backend, store ?? backend?.Store)
        {
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public RivalView View { get; private set; }
        public bool Enabled => View != null && View.Enabled;
        public bool OptedOut => View != null && View.OptOut;
        public RivalInfo Rival => View?.Rival;
        public bool HasHuman => Rival != null && Rival.IsHuman && !Rival.Dissolved;
        public bool Dissolved => Rival != null && Rival.IsHuman && Rival.Dissolved;

        /// <summary>The rival's name (player-typed names are never translated; CPU names come from the server).</summary>
        public string RivalName => Rival == null ? null : Dissolved ? "ライバル解除" : Rival.DisplayName;
        /// <summary>"B級・相棒 ハヤテ（差し）" for a human, "先行・目標6着以内" for a CPU.</summary>
        public string RivalSubline
        {
            get
            {
                if (Rival == null || Dissolved) return null;
                if (Rival.IsCpu) return Style(Rival.Style) + "・目標" + N(Rival.TargetPlace) + "着以内";
                var c = Rival.Card;
                if (c == null) return null;
                var partner = c.Partner == null ? null : "相棒 " + c.Partner.Name + "（" + Style(c.Partner.Style) + "）";
                return partner == null ? c.ClassId + "級" : c.ClassId + "級・" + partner;
            }
        }
        /// <summary>The CPU's one line (personality); null for a human.</summary>
        public string RivalLine => Rival != null && Rival.IsCpu ? Rival.Line : null;
        /// <summary>"今週 2 - 1".</summary>
        public string ScoreLine => View?.Score == null ? null : "今週 " + N(View.Score.Me) + " - " + N(View.Score.Them);
        /// <summary>"ランク戦 2/3戦（3戦で週の結果に報酬）" until qualified, then "ランク戦 5戦".</summary>
        public string RacesLine => View?.Score == null ? null : View.Score.Qualified
            ? "ランク戦 " + N(View.Score.RankedRaces) + "戦"
            : "ランク戦 " + N(View.Score.RankedRaces) + "/" + N(View.Score.MinRaces) + "戦（" + N(View.Score.MinRaces) + "戦で週の結果に報酬）";
        /// <summary>"あと3日" until the week ends (game days).</summary>
        public string DaysLeftLine => View == null || View.WeekEndsAt <= 0 ? null : "あと" + N(Math.Max(1, GameDay.DaysUntil(View.WeekEndsAt, _now()))) + "日";
        /// <summary>"勝ち 20・引き分け 10・負け 10（無償コイン）".</summary>
        public string RewardsLine => View == null ? null : "勝ち " + N(View.Rewards.Win) + "・引き分け " + N(View.Rewards.Draw) + "・負け " + N(View.Rewards.Lose) + "（無償コイン）";
        /// <summary>"通算 3勝 / 5週" and the next title.</summary>
        public string RecordLine => View == null ? null : "通算 " + N(View.Record.WeeksWon) + "勝 / " + N(View.Record.WeeksPlayed) + "週";
        public string NextTitleLine => View?.Record?.NextTitle == null ? null : "称号「" + View.Record.NextTitle.Name + "」まで あと" + N(Math.Max(0, View.Record.NextTitle.WeeksWon - View.Record.WeeksWon)) + "勝";

        /// <summary>The home card is shown (feature open, not opted out, a rival known).</summary>
        public bool ShowHomeCard => Enabled && !OptedOut && Rival != null;
        public bool CanChallenge => HasHuman && (View.ChallengesLeft ?? 0) > 0;
        /// <summary>"挑戦状 あと3回".</summary>
        public string ChallengeLine => !HasHuman || View.ChallengesLeft == null ? null : "挑戦状 あと" + N(View.ChallengesLeft.Value) + "回";

        public List<RivalRaceLine> Races => View == null ? new List<RivalRaceLine>() : View.Recent.Select(r => new RivalRaceLine
        {
            RaceId = r.RaceId, Point = r.Point, Challenge = r.Mode == "friend",
            Text = RaceText(r.Mode == "friend", r.Me, r.Them, Rival?.TargetPlace ?? 0),
        }).ToList();

        public List<RivalTaLine> TimeAttack => View == null ? new List<RivalTaLine>() : View.TimeAttack.Select(t => new RivalTaLine
        {
            TrackId = t.TrackId, TrackName = t.TrackName, MeText = Clock(t.Me), RivalText = Clock(t.Rival), Faster = t.Faster,
        }).ToList();

        /// <summary>The sheet for an unseen settled week (null = nothing to show).</summary>
        public RivalResultSheet ResultSheet => View?.Result == null ? null : Sheet(View.Result, View);

        public static RivalResultSheet Sheet(RivalResult r, RivalView v)
        {
            var titles = new List<string>();
            foreach (var id in r.NewTitles) titles.Add(v?.Record?.Titles.FirstOrDefault(t => t.TitleId == id)?.Name ?? id);
            string note = r.Outcome == "not_enough" ? "ランク戦が" + N(v?.Rewards?.MinRaces ?? 3) + "戦に届かなかったため、報酬はありません"
                : r.Outcome == "no_contest" ? "ライバルが解除されたため、今週の勝敗はつきません" : null;
            return new RivalResultSheet
            {
                WeekId = r.WeekId, Outcome = r.Outcome,
                Headline = OutcomeTexts.TryGetValue(r.Outcome ?? "", out var h) ? h : r.Outcome,
                ScoreText = "直接対決 " + N(r.Me) + " - " + N(r.Them) + (r.Me == r.Them && (r.TaMe > 0 || r.TaThem > 0) ? "・タイムアタック " + N(r.TaMe) + " - " + N(r.TaThem) : ""),
                RivalText = string.IsNullOrEmpty(r.RivalName) ? null : "vs " + r.RivalName,
                RewardText = r.FreeCoins > 0 ? "無償コイン" + N(r.FreeCoins) + "枚" : null,
                NewTitles = titles, Note = note,
            };
        }

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { View = null; return Offline("ライバルはオンラインで表示されます"); }
            try
            {
                View = await B.Api.GetRivalAsync(ct);
                Online = true;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>The result sheet was closed: never shown again for that week.</summary>
        public async Task<ActionResult> DismissResultAsync(CancellationToken ct = default)
        {
            var r = View?.Result;
            if (r == null) return ActionResult.Success();
            View.Result = null; // closed on screen even if the request fails (it comes back on the next load)
            try { await B.Api.MarkRivalResultSeenAsync(r.WeekId, ct); return ActionResult.Success(); }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Opt out (this week's pair is dissolved for both; no rival from next week) or back in.</summary>
        public async Task<ActionResult> SetOptOutAsync(bool optOut, CancellationToken ct = default)
        {
            try
            {
                await B.Api.SetRivalOptOutAsync(optOut, ct);
                await LoadAsync(ct);
                return ActionResult.Success(optOut ? "ライバルをお休みにしました。来週から組まれません" : "来週からライバルが決まります");
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>The confirmation line before <see cref="BlockAsync"/>.</summary>
        public string BlockConfirmText => HasHuman ? Rival.DisplayName + "さんをブロックします。今週のライバルは解除され、今後組まれることはありません" : null;

        public async Task<ActionResult> BlockAsync(CancellationToken ct = default)
        {
            if (!HasHuman) return ActionResult.Error("ブロックできるライバルがいません");
            try
            {
                await B.Api.BlockRivalAsync(ct);
                await LoadAsync(ct);
                return ActionResult.Success("ブロックしました");
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>ライバルと走る: invite the rival to the friend room you created (unranked, never scores).</summary>
        public async Task<ActionResult> ChallengeAsync(string passphrase, CancellationToken ct = default)
        {
            if (!CanChallenge) return ActionResult.Error(HasHuman ? UxText.Errors["RIVAL_CHALLENGE_LIMIT"] : "挑戦状を送れるライバルがいません");
            if (string.IsNullOrEmpty(passphrase)) return ActionResult.Error("先にフレンド部屋を作ってください");
            try
            {
                await B.Api.ChallengeRivalAsync(passphrase, ct: ct);
                if (View.ChallengesLeft.HasValue) View.ChallengesLeft = Math.Max(0, View.ChallengesLeft.Value - 1);
                return ActionResult.Success("挑戦状を送りました（このレースは点になりません）");
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>"3着 vs 5着" / "挑戦状 2着 vs 1着" / "4着（目標6着以内）".</summary>
        public static string RaceText(bool challenge, int me, int? them, int target)
        {
            if (!them.HasValue) return N(me) + "着（目標" + N(target) + "着以内）";
            string vs = N(me) + "着 vs " + N(them.Value) + "着";
            return challenge ? "挑戦状 " + vs : vs;
        }

        private static string N(int n) => n.ToString(CultureInfo.InvariantCulture);
        private static string Style(string s) => s != null && StyleTexts.TryGetValue(s, out var t) ? t : s;
        /// <summary>70210 ms → "1:10.2"; null → "—".</summary>
        public static string Clock(long? ms)
        {
            if (ms == null) return "—";
            long tenths = ms.Value / 100;
            return (tenths / 600).ToString(CultureInfo.InvariantCulture) + ":" + (tenths / 10 % 60).ToString("00", CultureInfo.InvariantCulture) + "." + (tenths % 10).ToString(CultureInfo.InvariantCulture);
        }
    }
}
