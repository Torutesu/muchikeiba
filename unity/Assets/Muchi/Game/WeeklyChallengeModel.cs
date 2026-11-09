using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Engine;

namespace Muchi.Game
{
    // REQ-WCH-001..016 (contracts/protocol.md §31, docs/handoff-codex-round13-weekly-challenge.md): 週替わりチャレンジ, the game
    // layer. Pure C#: Codex's screens bind to the public fields and play the animations. The model never decides a clear:
    // the server re-simulates the run with the verifier and evaluates the conditions; the device shows the same verdict
    // (ChallengeEvaluator) while the answer is on its way, then the server's.

    /// <summary>One line of a challenge's conditions (list, HUD, result).</summary>
    public sealed class ChallengeConditionLine
    {
        /// <summary>finish / place / style / whips / time</summary>
        public string Kind;
        /// <summary>The server's sentence ("ムチ3回以内").</summary>
        public string Text;
        /// <summary>HUD: the live value ("ムチ 1/3", "現在 3位", "0:58.2"); result: what happened ("2着", "ムチ 4回"). Null when none.</summary>
        public string Value;
        /// <summary>Result: met. HUD: still possible.</summary>
        public bool Ok;
    }

    /// <summary>One card of the challenge list.</summary>
    public sealed class ChallengeCard
    {
        public string Id, Title;
        /// <summary>"芝2000m・重・ナイター".</summary>
        public string CourseText;
        /// <summary>"8頭立て・CPU Lv3".</summary>
        public string FieldText;
        public List<ChallengeConditionLine> Conditions = new List<ChallengeConditionLine>();
        /// <summary>"無償コイン10枚" / "配合素材×1" (once this week).</summary>
        public string RewardText;
        /// <summary>"貸し出し馬：ヒノデエクスプレス（逃げ）".</summary>
        public string LoanText;
        public bool Cleared;
        /// <summary>"挑戦 2回・最高 2着" or null before the first try.</summary>
        public string ProgressText;
        public string Going;
        public bool Night;
    }

    public enum ChallengePhase { List, Racing, Submitting, Result }

    public sealed class WeeklyChallengeModel : ScreenModel
    {
        public const string KeyPendingStart = "muchi.challenge.start";

        public static readonly IReadOnlyDictionary<string, string> GoingTexts = new Dictionary<string, string>
        {
            ["firm"] = "良（硬め）", ["good"] = "良", ["yielding"] = "稍重", ["soft"] = "重", ["fast"] = "良", ["muddy"] = "稍重", ["sloppy"] = "不良",
        };
        public static readonly IReadOnlyDictionary<string, string> StyleTexts = new Dictionary<string, string>
        {
            ["nige"] = "逃げ", ["senko"] = "先行", ["sashi"] = "差し", ["oikomi"] = "追込",
        };

        /// <summary>The fairness rules as they are (shown on the list).</summary>
        public const string RulesText = "どの馬も能力はクラスBの上限にそろえ、スキルは使いません。貸し出し馬はいつでも上限ちょうどの能力で走れます。報酬はチャレンジごとに週1回です。";
        /// <summary>The badge is only a badge.</summary>
        public const string BadgeNote = "3つクリアした週のバッジ（見た目だけ）";

        public WeeklyChallengeModel(GameBackend backend, IKeyValueStore store = null) : base(backend, store ?? backend?.Store) { }

        public WeeklyChallengeView View { get; private set; }
        public ChallengePhase Phase { get; private set; } = ChallengePhase.List;
        public WeeklyChallengeSession Session { get; private set; }
        public ChallengeRun Run { get; private set; }
        /// <summary>The device's verdict once the race has finished (before the server answers).</summary>
        public ChallengeEvaluation DeviceVerdict { get; private set; }
        public WeeklyChallengeResult Result { get; private set; }

        public bool Enabled => View != null && View.Enabled;

        // ------------------------------------------------------------------------------------------- home card

        /// <summary>"今週のチャレンジ 1/3".</summary>
        public string HomeTitle => Enabled ? "今週のチャレンジ " + View.ClearedCount.ToString(CultureInfo.InvariantCulture) + "/" + View.Challenges.Count.ToString(CultureInfo.InvariantCulture) : null;
        /// <summary>"あと4日で入れ替え" (from the server's week end; never a fake timer).</summary>
        public string HomeSubtitle => Enabled ? (View.DaysLeft <= 1 ? "今日で入れ替え" : "あと" + View.DaysLeft.ToString(CultureInfo.InvariantCulture) + "日で入れ替え") : null;
        public bool BadgeEarned => Enabled && View.Badge != null && View.Badge.Earned;

        // ------------------------------------------------------------------------------------------- list

        public List<ChallengeCard> Cards => Enabled ? View.Challenges.Select(Card).ToList() : new List<ChallengeCard>();
        public List<ChallengeCard> NextCards => Enabled && View.Next != null ? View.Next.Challenges.Select(Card).ToList() : new List<ChallengeCard>();

        public static string CourseText(WeeklyChallenge c)
        {
            var s = (c.Surface == "dirt" ? "ダート" : "芝") + c.DistanceM.ToString(CultureInfo.InvariantCulture) + "m・" + (GoingTexts.TryGetValue(c.Going ?? "good", out var g) ? g : "良");
            return c.Night ? s + "・ナイター" : s;
        }

        public static string RewardText(Reward r)
        {
            if (r == null) return null;
            var parts = new List<string>();
            if (r.FreeCoins > 0) parts.Add("無償コイン" + r.FreeCoins.ToString(CultureInfo.InvariantCulture) + "枚");
            foreach (var it in r.Items) parts.Add((it.ItemId == "breeding_material" ? "配合素材" : it.ItemId) + "×" + it.Qty.ToString(CultureInfo.InvariantCulture));
            return string.Join("・", parts);
        }

        public static ChallengeCard Card(WeeklyChallenge c) => new ChallengeCard
        {
            Id = c.Id, Title = c.Title, CourseText = CourseText(c), Going = c.Going, Night = c.Night,
            FieldText = (c.CpuCount + 1).ToString(CultureInfo.InvariantCulture) + "頭立て・CPU Lv" + c.CpuLevel.ToString(CultureInfo.InvariantCulture),
            Conditions = c.Labels.Select(l => new ChallengeConditionLine { Kind = l.Kind, Text = l.Text, Ok = true }).ToList(),
            RewardText = RewardText(c.Reward),
            LoanText = c.Loan == null ? null : "貸し出し馬：" + c.Loan.Name + "（" + (StyleTexts.TryGetValue(c.Loan.Style ?? "", out var st) ? st : c.Loan.Style) + "）",
            Cleared = c.Progress != null && c.Progress.Cleared,
            ProgressText = c.Progress == null || c.Progress.Attempts == 0 ? null
                : "挑戦 " + c.Progress.Attempts.ToString(CultureInfo.InvariantCulture) + "回" + (c.Progress.BestPlace.HasValue ? "・最高 " + c.Progress.BestPlace.Value.ToString(CultureInfo.InvariantCulture) + "着" : ""),
        };

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) { View = null; return Offline("週替わりチャレンジはオンラインで遊べます"); }
            try
            {
                View = await B.Api.GetWeeklyChallengesAsync(ct);
                Online = true;
                if (Phase == ChallengePhase.Result || Phase == ChallengePhase.List) Phase = ChallengePhase.List;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        // ------------------------------------------------------------------------------------------- race

        /// <summary>Starts a challenge with the loan horse (<paramref name="horseId"/> null) or an own horse; then race <see cref="Run"/>.</summary>
        public async Task<ActionResult> StartAsync(string challengeId, string horseId = null, CancellationToken ct = default)
        {
            var c = View?.Challenge(challengeId);
            if (c == null) return ActionResult.Error("このチャレンジは今週のものではありません");
            if (horseId == null && c.Loan == null) return ActionResult.Error("馬を選んでください");
            int attempts = c.Progress?.Attempts ?? 0;
            string key = PendingKey(challengeId + ":" + (horseId ?? "loan") + ":" + attempts.ToString(CultureInfo.InvariantCulture));
            try
            {
                Session = await B.Api.StartWeeklyChallengeAsync(challengeId, horseId, horseId == null, key, ct);
                Kv.Set(KeyPendingStart, "");
                Run = new ChallengeRun(Session);
                DeviceVerdict = null; Result = null;
                Phase = ChallengePhase.Racing;
                return ActionResult.Success();
            }
            catch (ApiException e)
            {
                if (!GameBackend.IsTransient(e)) Kv.Set(KeyPendingStart, "");
                Message = UxText.For(e);
                return ActionResult.Error(Message);
            }
        }

        /// <summary>The condition lines for the race HUD with their live state (red when they can no longer be met).</summary>
        public List<ChallengeConditionLine> HudLines()
        {
            var list = new List<ChallengeConditionLine>();
            if (Run == null || Session?.Challenge == null) return list;
            var cond = Run.Conditions;
            var me = Run.Race.Sim.GetHorse(Run.PlayerSlot);
            foreach (var l in Session.Challenge.Labels)
            {
                var line = new ChallengeConditionLine { Kind = l.Kind, Text = l.Text, Ok = true };
                switch (l.Kind)
                {
                    case "whips":
                        line.Value = "ムチ " + Run.WhipsUsed.ToString(CultureInfo.InvariantCulture) + "/" + (cond.MaxWhips ?? 0).ToString(CultureInfo.InvariantCulture);
                        line.Ok = !Run.WhipsBroken;
                        break;
                    case "place":
                        if (me.Rank > 0) line.Value = "現在 " + me.Rank.ToString(CultureInfo.InvariantCulture) + "位";
                        line.Ok = !me.Finished || (me.Rank > 0 && me.Rank <= (cond.MaxPlace ?? 12));
                        break;
                    case "time":
                        line.Value = HudModel.FormatTime(Run.ElapsedMs);
                        line.Ok = !Run.TimeBroken;
                        break;
                    case "style":
                        line.Ok = true; // checked at the start (the server refuses another style)
                        break;
                }
                list.Add(line);
            }
            return list;
        }

        /// <summary>Call when the race has finished: shows the device's verdict and sends the run.</summary>
        public async Task<ActionResult> SubmitAsync(CancellationToken ct = default)
        {
            if (Run == null || !Run.Race.IsFinished) return ActionResult.Error("レースが終わっていません");
            DeviceVerdict ??= Run.Evaluate();
            Phase = ChallengePhase.Submitting;
            try
            {
                Result = await B.Api.SubmitWeeklyChallengeAsync(Session, Run, ct);
                Phase = ChallengePhase.Result;
                await LoadAsync(ct); // progress, cleared count and the badge
                Phase = ChallengePhase.Result;
                return ActionResult.Success(ResultHeadline);
            }
            catch (ApiException e)
            {
                Message = UxText.For(e);
                // a transient failure keeps the run: the same submit is safe to retry (the server stores the result per session)
                Phase = GameBackend.IsTransient(e) ? ChallengePhase.Submitting : ChallengePhase.List;
                return ActionResult.Error(Message);
            }
        }

        /// <summary>Back to the list after the result.</summary>
        public void Continue()
        {
            if (Phase != ChallengePhase.Result) return;
            Phase = ChallengePhase.List; Run = null; Session = null; Result = null; DeviceVerdict = null;
        }

        // ------------------------------------------------------------------------------------------- result

        /// <summary>"CLEAR" / "FAILED" (the server's verdict; the device's until it arrives).</summary>
        public string ResultHeadline => (Result?.Evaluation ?? DeviceVerdict) == null ? null : ((Result?.Cleared ?? DeviceVerdict.Cleared) ? "チャレンジ達成" : "チャレンジ失敗");
        public bool Cleared => Result?.Cleared ?? DeviceVerdict?.Cleared ?? false;

        /// <summary>Each condition with ○/× and what happened.</summary>
        public List<ChallengeConditionLine> ResultLines()
        {
            var ev = Result?.Evaluation ?? DeviceVerdict;
            var list = new List<ChallengeConditionLine>();
            if (ev == null || Session?.Challenge == null) return list;
            foreach (var l in Session.Challenge.Labels)
            {
                var chk = ev.Check(l.Kind) ?? ev.Check("finish");
                string value = null;
                switch (l.Kind)
                {
                    case "place": value = ev.Place.HasValue ? ev.Place.Value.ToString(CultureInfo.InvariantCulture) + "着" : "完走できず"; break;
                    case "whips": value = "ムチ " + ev.Whips.ToString(CultureInfo.InvariantCulture) + "回"; break;
                    case "time": value = ev.TimeMs.HasValue ? HudModel.FormatTime(ev.TimeMs.Value) : "完走できず"; break;
                    case "finish": value = ev.Finished ? "完走" : "完走できず"; break;
                    case "style": value = StyleTexts.TryGetValue(ev.Style ?? "", out var s) ? s : ev.Style; break;
                }
                list.Add(new ChallengeConditionLine { Kind = l.Kind, Text = l.Text, Value = value, Ok = chk != null && chk.Ok });
            }
            return list;
        }

        /// <summary>"報酬：無償コイン10枚" on the first clear this week; "今週の報酬は受け取り済み" on a repeat; null on a fail.</summary>
        public string RewardLine => Result == null || !Result.Cleared ? null : Result.FirstClear && Result.Reward != null ? "報酬：" + RewardText(Result.Reward) : "今週の報酬は受け取り済み";
        /// <summary>"バッジ「青葉の一閃章」を獲得" when this clear completed the week.</summary>
        public string BadgeLine => Result?.Badge != null && Result.Badge.NewlyEarned ? "バッジ「" + Result.Badge.Name + "」を獲得" : null;
        /// <summary>"今週 2/3 クリア".</summary>
        public string WeekLine => Result == null ? null : "今週 " + Result.ClearedCount.ToString(CultureInfo.InvariantCulture) + "/3 クリア";

        private string PendingKey(string scope)
        {
            var stored = (Kv.Get(KeyPendingStart) ?? "").Split('|');
            if (stored.Length == 2 && stored[0] == scope) return stored[1];
            string key = B.Api.NewIdempotencyKey();
            Kv.Set(KeyPendingStart, scope + "|" + key);
            return key;
        }
    }
}
