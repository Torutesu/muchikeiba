using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-GOAL-001..012 目標の階段 (contracts/protocol.md「目標の階段」, docs/quality/goals-rewards.md). Pure C#: Codex's home
    // binds to the public fields.
    //
    // Home shows three rungs — 今日 / 今週 (or はじめの10歩 for a new player) / シーズン — each one line with an honest figure, and
    // the goals sheet shows the rows behind them with one 「まとめて受け取る」. Rules the model keeps:
    //  - the figures are the server's (GET /v1/home/goals); the model never invents progress or a pace;
    //  - each reward says what it does for the player's horses (ItemPurpose) — a reward without a use is a smell;
    //  - "why climb" is the class cap: how much of the partner's strength ranked lets it use now and in the next class
    //    (nothing purchasable is a way up: REQ-RATE-003);
    //  - no countdowns, no urgency words, no shop link (the same legal guard as 次にやること).

    /// <summary>One row of the goals sheet.</summary>
    public sealed class LadderGoalRow
    {
        public string Id, Table, Title, ProgressText, RewardText, PurposeText;
        /// <summary>0..1 for the gauge.</summary>
        public float Fill;
        public bool Done, Claimed, Claimable;
        /// <summary>Paid automatically (today's first-win bonus): shown, never claimed.</summary>
        public bool Auto;
    }

    /// <summary>One rung on home (今日 / 今週 / はじめの10歩 / シーズン).</summary>
    public sealed class GoalRung
    {
        /// <summary>today | path | week | season</summary>
        public string Key;
        public string Label, Main, Figure, Sub;
        public float Fill;
        /// <summary>Something on this rung can be claimed now (a gold dot, no animation loop).</summary>
        public bool Ready;
    }

    /// <summary>
    /// REQ-GOAL-014 (quality pass 2, the first week): the partner's growth on home — the stage of five (the 馬カード's
    /// GrowthStages), a gauge from the stage's start to the next one, what training added today / the game day before, and
    /// how many sessions are left today. Display only: nothing is granted by a stage.
    /// </summary>
    public sealed class PartnerGrowthLine
    {
        public string HorseId, Name, StageName;
        public int Stage, Stages;
        /// <summary>0..1 from this stage's start to the next stage (1 at 完成).</summary>
        public float Fill;
        /// <summary>「成長期　調教 +29」.</summary>
        public string Line;
        /// <summary>「今日 +10」 / 「昨日 +10」 / null — the latest growth the player can feel.</summary>
        public string DeltaLine;
        /// <summary>「次の段階まで あと55」 / 「完成」.</summary>
        public string NextLine;
        /// <summary>「今日あと2回 調教できます」 / 「今日の調教は終わりました」 / null (training not open yet).</summary>
        public string TrainLine;
        public bool CanTrain;
    }

    /// <summary>One class of the ladder sheet.</summary>
    public sealed class ClassRow
    {
        public string ClassId, Title, CapText, LineText, RewardText;
        public bool Current, Reached;
    }

    public sealed class GoalLadderModel : ScreenModel
    {
        public const string KeyCache = "muchi.goals.cache";
        public const string KeyPendingClaim = "muchi.goals.claim";

        private readonly NowMs _now;
        private readonly Func<string, string> _itemName;

        public GoalLadderModel(GameBackend backend, NowMs now = null, Func<string, string> itemName = null) : base(backend, backend?.Store)
        {
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _itemName = itemName ?? ItemName;
        }

        public GoalLadderView View { get; private set; }
        public List<GoalRung> Rungs { get; private set; } = new List<GoalRung>();
        public List<LadderGoalRow> Today { get; private set; } = new List<LadderGoalRow>();
        public LadderGoalRow PathStep { get; private set; }
        public List<LadderGoalRow> SeasonMissions { get; private set; } = new List<LadderGoalRow>();
        public List<ClassRow> Ladder { get; private set; } = new List<ClassRow>();
        /// <summary>「相棒の力 2,800 / 3,320」 — how much of the partner ranked lets it use in this class (null without a horse).</summary>
        public string PowerLine { get; private set; }
        /// <summary>Why climb: 「B級なら 3,200 まで出せます」 / 「いまのクラスで相棒の力をすべて出せています」.</summary>
        public string WhyClimbLine { get; private set; }
        /// <summary>REQ-GOAL-011: 「明日のログインボーナス：繁殖牝馬1頭」 after today's claim (a fact, not a countdown), null when closed.</summary>
        public string LoginLine { get; private set; }
        /// <summary>The pace line, only from the server's own estimate: 「いまのペースで あと約9戦」.</summary>
        public string PaceLine { get; private set; }
        /// <summary>Quality integration: 「パス報酬 2段」 on the goals sheet (opens the season pass), null when nothing to receive.
        /// Home's 次にやること no longer says the pass rewards — the season rung's dot does.</summary>
        public string PassLine { get; private set; }
        /// <summary>Quality integration: where the ladder talks about the class cap it links to this horse's card
        /// (HorseProfileModel: training layers and the ranked line). Null without a horse.</summary>
        public string CapCardHorseId { get; private set; }
        public string CapCardLink => CapCardHorseId == null ? null : "馬カードで見る";
        /// <summary>「まとめて受け取る（4件）」, null when nothing is claimable.</summary>
        public string ClaimText => View != null && View.Claimable > 0 ? "まとめて受け取る（" + View.Claimable + "件）" : null;
        /// <summary>After a claim: the lines of the moment (「無償コイン 45枚」「配合素材 ×1」…) and the total.</summary>
        public List<string> LastClaimLines { get; private set; } = new List<string>();

        // ---- the first week (quality pass 2, docs/quality/first-week.md)
        /// <summary>REQ-GOAL-013: one line for home once today's set is done — 「明日：繁殖牝馬1頭・配合が開く」 (facts from the server:
        /// tomorrow's login bonus, up to two features opening by day count, else the training slots). Null when there is nothing.</summary>
        public string TomorrowLine { get; private set; }
        /// <summary>REQ-GOAL-013: the goals sheet's 「明日」 block, one fact per line, and its time (「4:00から」).</summary>
        public List<string> TomorrowLines { get; private set; } = new List<string>();
        public string TomorrowAt { get; private set; }
        /// <summary>REQ-GOAL-014: the partner's growth (null without a partner or from an older server).</summary>
        public PartnerGrowthLine Partner { get; private set; }
        /// <summary>REQ-GOAL-015: where the current first step is done (scout | silks | care | race | breeding | friends | teams |
        /// time_attack | collection — fixed in code on the server, never the shop) and, while that screen is not open yet, why.</summary>
        public string PathScreen { get; private set; }
        public string PathLockText { get; private set; }
        /// <summary>At most this many features in the one home line (the sheet lists them all).</summary>
        public const int TomorrowHomeFeatures = 1;

        public static readonly IReadOnlyDictionary<string, string> KindTitles = new Dictionary<string, string>
        {
            ["races"] = "レースに出る", ["wins"] = "1着になる", ["top3"] = "3着以内に入る", ["training"] = "調教をする", ["first_win"] = "今日の初勝利（ランク戦）",
            ["gacha"] = "スカウトを1回", ["silks"] = "勝負服を変える", ["care"] = "飼い葉をあげる", ["ranked_top3"] = "ランク戦で3着以内", ["breed"] = "配合を1回",
            ["friends"] = "フレンドを追加", ["team"] = "支部に入る", ["ta_finish"] = "タイムアタックを完走", ["ranked_races"] = "ランク戦に出る", ["points"] = "シーズンptを集める",
            ["promotion_line"] = "昇級ラインに届く", ["collect"] = "図鑑の馬を迎える",
        };

        /// <summary>Item names when the screen has no catalog (the server's master names; English in server-en.json).</summary>
        public static string ItemName(string id)
        {
            switch (id)
            {
                case "breeding_material": return "配合素材";
                case "training_apple": return "りんごのおやつ";
                case "gacha_ticket": return "スカウト券";
                case "gacha_ticket_10": return "10連スカウト券";
                case "ticket_sr_plus": return "SR以上確定スカウト券";
                default: return id;
            }
        }

        /// <summary>What a reward does for the player's horses (shown under the reward). Coins and pass XP have their own line.</summary>
        public static string ItemPurpose(Reward r)
        {
            if (r == null) return null;
            var id = r.Items.Count > 0 ? r.Items[0].ItemId : null;
            switch (id)
            {
                case "breeding_material": return "配合で良い仔を狙う・馬の覚醒に使う";
                case "training_apple": return "次の調教の伸びが少し良くなる";
                case "gacha_ticket": return "新しい馬をスカウト（1回）";
                case "gacha_ticket_10": return "新しい馬をスカウト（10回）";
                case "ticket_sr_plus": return "SR以上の馬をスカウト（1回）";
            }
            if (r.Broodmare != null) return "繁殖牝馬が厩舎に来る（配合ができる）";
            if (r.PassXp > 0) return "シーズンパスのレベルが上がる";
            if (r.FreeCoins > 0) return "スカウト・覚醒に使える無償コイン";
            return null;
        }

        /// <summary>GET /v1/home/goals; offline the last ladder (figures as they were, the claim off).</summary>
        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (ServerAvailable)
            {
                try { Use(await B.Api.GetGoalsAsync(ct)); Online = true; return ActionResult.Success(); }
                catch (ApiException e) { Message = UxText.For(e); }
            }
            Online = false;
            var cached = GoalLadderView.FromJson(Kv.Get(KeyCache));
            if (cached != null && cached.Day == GameDay.Key(_now())) { View = cached; Rebuild(); }
            return Message == null ? ActionResult.Success() : ActionResult.Error(Message);
        }

        public void Use(GoalLadderView v, string json = null)
        {
            if (v == null) return;
            View = v;
            if (json != null) Kv.Set(KeyCache, json);
            Rebuild();
        }

        /// <summary>REQ-GOAL-009: claim everything claimable (keyed per game day until the server answers: a retry never pays twice).</summary>
        public async Task<ActionResult> ClaimAllAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) return Offline("受け取りにはサーバーが必要です");
            if (View == null || View.Claimable == 0) return ActionResult.Error(UxText.Errors["NOT_ELIGIBLE"]);
            string slot = KeyPendingClaim + ":" + GameDay.Key(_now());
            string key = Kv.Get(slot);
            if (string.IsNullOrEmpty(key)) { key = B.Api.NewIdempotencyKey(); Kv.Set(slot, key); }
            try
            {
                var r = await B.Api.ClaimGoalsAsync(key, ct);
                Kv.Set(slot, "");
                LastClaimLines = RewardLines(r.Total);
                Use(r.Ladder);
                await B.RefreshAsync(ct);
                Message = r.Claimed.Count + "件受け取りました";
                return ActionResult.Success(Message);
            }
            catch (ConflictException e) when (e.Code == ApiErrorCode.NotEligible || e.Code == ApiErrorCode.AlreadyClaimed)
            {
                Kv.Set(slot, "");
                await LoadAsync(ct);
                Message = UxText.For(e);
                return ActionResult.Error(Message);
            }
            catch (ApiException e)
            {
                if (!GameBackend.IsTransient(e)) Kv.Set(slot, "");
                Message = UxText.For(e);
                return ActionResult.Error(Message);
            }
        }

        /// <summary>The claim moment, one line per kind of reward (coins, each item, pass XP).</summary>
        public List<string> RewardLines(Reward r)
        {
            var l = new List<string>();
            if (r == null) return l;
            if (r.FreeCoins > 0) l.Add("無償コイン " + Num(r.FreeCoins) + "枚");
            foreach (var it in r.Items) l.Add(_itemName(it.ItemId) + " ×" + it.Qty);
            if (r.PassXp > 0) l.Add("パスXP " + Num(r.PassXp));
            return l;
        }

        private static string Num(int n) => n.ToString("#,0", CultureInfo.InvariantCulture);
        private static string Title(string kind) => kind != null && KindTitles.TryGetValue(kind, out var t) ? t : kind ?? "";

        private LadderGoalRow Row(GoalItem i) => new LadderGoalRow
        {
            Id = i.Id, Table = i.Table, Title = Title(i.Kind), ProgressText = Math.Min(i.Progress, i.Target) + "/" + i.Target,
            RewardText = UxText.Reward(i.Reward, _itemName), PurposeText = ItemPurpose(i.Reward),
            Fill = i.Target <= 0 ? 1f : Math.Min(1f, (float)i.Progress / i.Target), Done = i.Done, Claimed = i.Claimed, Claimable = i.Claimable, Auto = i.Table == "first_win",
        };

        private void Rebuild()
        {
            var v = View;
            Rungs = new List<GoalRung>();
            Today = v.Today.Items.Select(Row).ToList();
            PathStep = v.Path?.Current == null ? null : Row(v.Path.Current);
            SeasonMissions = v.Season.Missions.Select(Row).ToList();

            BuildFirstWeek(v);
            // 今日 (quality pass 2: once the set is done, the rung says what tomorrow brings)
            if (v.Today.Open)
                Rungs.Add(new GoalRung
                {
                    Key = "today", Label = "今日",
                    Main = v.Today.Complete ? TomorrowLine ?? "今日の目標は完了" : v.Today.Claimable > 0 ? "受け取れる報酬があります" : NextToday(v),
                    // once done the tomorrow line takes the whole rung (the figure would only repeat 「5/5」)
                    Figure = v.Today.Complete && TomorrowLine != null ? null : v.Today.Done + "/" + v.Today.Total, Fill = v.Today.Total == 0 ? 0 : (float)v.Today.Done / v.Today.Total,
                    Sub = v.Today.Complete ? GameDay.NextResetLabel(_now()) + " に更新" : null, Ready = v.Today.Claimable > 0,
                });
            // はじめの10歩 (a new player) or 今週
            if (v.Path != null)
                Rungs.Add(new GoalRung
                {
                    Key = "path", Label = "はじめの" + v.Path.Steps + "歩", Main = v.Path.Current.Claimable ? "受け取れる報酬があります" : Title(v.Path.Current.Kind),
                    Figure = v.Path.Done + "/" + v.Path.Steps, Fill = (float)v.Path.Done / Math.Max(1, v.Path.Steps),
                    Sub = "最後に " + UxText.Reward(v.Path.FinalReward, _itemName), Ready = v.Path.Current.Claimable,
                });
            if (v.Week != null)
            {
                var parts = new List<string>();
                if (v.Week.HasChallenge) parts.Add("チャレンジ " + v.Week.ChallengeCleared + "/" + v.Week.ChallengeTotal);
                if (v.Week.HasRivalResult) parts.Add("ライバル 結果発表");
                else if (v.Week.HasRival) parts.Add("ライバル " + v.Week.RivalMe + "-" + v.Week.RivalThem);
                if (v.Week.HasTeamGoal) parts.Add("支部 " + v.Week.TeamReached + "/" + v.Week.TeamTiers + "段");
                Rungs.Add(new GoalRung
                {
                    Key = "week", Label = "今週", Main = string.Join("　·　", parts), Figure = null,
                    Fill = v.Week.HasChallenge && v.Week.ChallengeTotal > 0 ? (float)v.Week.ChallengeCleared / v.Week.ChallengeTotal : 0,
                    Sub = GameDay.UntilLabel(v.Week.EndsAt),
                });
            }
            // シーズン
            var s = v.Season;
            var cls = s.ClassId + "級";
            var rung = new GoalRung { Key = "season", Label = "シーズン", Ready = s.Missions.Any(x => x.Claimable) || s.PassFreeClaimable > 0 };
            PassLine = s.PassFreeClaimable > 0 ? "パス報酬 " + s.PassFreeClaimable + "段" : null;
            CapCardHorseId = s.HasPower && !string.IsNullOrEmpty(s.PowerHorseId) ? s.PowerHorseId : null;
            switch (s.Status)
            {
                case "rookie": rung.Main = "ルーキー　·　ランク戦でクラスが決まります"; break;
                case "top": rung.Main = cls + "　·　最上位クラス"; rung.Figure = Num(s.Points) + "pt"; rung.Fill = 1f; break;
                case "line_reached": rung.Main = cls + "　·　昇級ラインに到達"; rung.Figure = Num(s.Points) + "pt"; rung.Fill = 1f; rung.Sub = "シーズンの締めで " + s.NextClassId + "級へ"; break;
                default:
                    rung.Main = cls + "　·　昇級まで あと" + Num(s.Left ?? 0) + "pt"; rung.Figure = Num(s.Points) + "/" + Num(s.Line ?? 0);
                    rung.Fill = s.Line.HasValue && s.Line.Value > 0 ? Math.Min(1f, (float)s.Points / s.Line.Value) : 0; break;
            }
            if (s.PromotionStatus == "active" && s.PromotionNext.HasValue) rung.Sub = "昇級戦 " + s.PromotionNext.Value + "/" + s.PromotionRaces;
            Rungs.Add(rung);

            var t = v.Today;
            if (!t.LoginBonusOpen || t.LoginNextReward == null) LoginLine = null;
            else if (t.LoginBonusClaimedToday) LoginLine = "明日のログインボーナス：" + UxText.Reward(t.LoginNextReward, _itemName);
            else LoginLine = "今日のログインボーナス：" + UxText.Reward(t.LoginNextReward, _itemName);
            PaceLine = s.RacesToLine.HasValue ? "いまのペースで あと約" + s.RacesToLine.Value + "戦" : null;
            if (s.HasPower)
            {
                PowerLine = "相棒の力 " + Num(s.PowerUsable) + " / " + Num(s.PowerTotal) + "（" + cls + "の上限 " + Num(s.PowerCap) + "）";
                WhyClimbLine = s.PowerHeld == 0 ? "いまのクラスで相棒の力をすべて出せています"
                    : s.PowerNextUsable.HasValue ? s.NextClassId + "級なら " + Num(s.PowerNextUsable.Value) + " まで出せます"
                    : null;
            }
            else { PowerLine = null; WhyClimbLine = null; }
            Ladder = s.Ladder.Select(c => new ClassRow
            {
                ClassId = c.ClassId, Title = c.ClassId + "級", Current = c.Current, Reached = c.Reached,
                CapText = "能力の上限 " + Num(c.StatCap),
                LineText = c.PromotePoints.HasValue ? "昇級 " + Num(c.PromotePoints.Value) + "pt" : "最上位",
                RewardText = TopBand(c),
            }).ToList();
        }

        /// <summary>REQ-GOAL-013..015: tomorrow, the partner's growth and the next step's screen.</summary>
        private void BuildFirstWeek(GoalLadderView v)
        {
            var t = v.Today.Tomorrow;
            TomorrowLines = new List<string>();
            TomorrowLine = null; TomorrowAt = null;
            if (t != null)
            {
                var home = new List<string>();
                if (t.LoginReward != null)
                {
                    var r = UxText.Reward(t.LoginReward, _itemName);
                    home.Add(r);
                    TomorrowLines.Add((t.LoginTrack == "beginner" ? "ログインボーナス " + t.LoginDay + "日目：" : "ログインボーナス：") + r);
                }
                var names = t.Opens.Select(k => UnlockGate.Titles.TryGetValue(k, out var n) ? n : null).Where(n => n != null).ToList();
                if (names.Count > 0)
                {
                    home.Add(string.Join("・", names.Take(TomorrowHomeFeatures)) + "が開く");
                    TomorrowLines.Add(string.Join("・", names) + "が開きます");
                }
                if (t.TrainingSlots.HasValue)
                {
                    if (home.Count == 0) home.Add("調教 " + t.TrainingSlots.Value + "回");
                    TomorrowLines.Add("調教がまた" + t.TrainingSlots.Value + "回できます");
                }
                if (home.Count > 0) TomorrowLine = "明日：" + string.Join("　·　", home);
                if (TomorrowLines.Count > 0) TomorrowAt = AtLabel(t.At);
            }

            var p = v.Partner;
            if (p == null) Partner = null;
            else
            {
                int idx = Math.Max(0, Math.Min(GrowthStages.Ja.Length - 1, p.Stage));
                int span = p.NextStageAt.HasValue ? Math.Max(1, p.NextStageAt.Value - p.StageFrom) : 1;
                Partner = new PartnerGrowthLine
                {
                    HorseId = p.HorseId, Name = p.Name, Stage = idx, Stages = p.Stages > 0 ? p.Stages : GrowthStages.Ja.Length, StageName = GrowthStages.Ja[idx],
                    Fill = p.NextStageAt.HasValue ? Math.Max(0f, Math.Min(1f, (float)(p.TrainedTotal - p.StageFrom) / span)) : 1f,
                    Line = GrowthStages.Ja[idx] + "　調教 +" + Num(p.TrainedTotal),
                    DeltaLine = p.GainedToday > 0 ? "今日 +" + Num(p.GainedToday) : p.GainedYesterday > 0 ? "昨日 +" + Num(p.GainedYesterday) : null,
                    NextLine = p.Full ? "完成" : p.NextStageAt.HasValue ? GrowthStages.Ja[Math.Min(idx + 1, GrowthStages.Ja.Length - 1)] + "まで あと" + Num(Math.Max(0, p.NextStageAt.Value - p.TrainedTotal)) : null,
                    TrainLine = !p.TrainingOpen || p.Full ? null : p.SessionsLeft > 0 ? "今日あと" + p.SessionsLeft + "回 調教できます" : "今日の調教は終わりました",
                    CanTrain = p.TrainingOpen && !p.Full && p.SessionsLeft > 0,
                };
            }

            var cur = v.Path?.Current;
            PathScreen = cur?.Screen;
            PathLockText = cur != null && !cur.Open ? LockText(cur.Kind, t) : null;
        }

        /// <summary>「明日 4:00」 for the server's next game day start (a time of day, never a countdown).</summary>
        private string AtLabel(long at)
        {
            const long Jst = 9 * 3_600_000L;
            var a = DateTimeOffset.FromUnixTimeMilliseconds(at + Jst).UtcDateTime;
            var today = DateTimeOffset.FromUnixTimeMilliseconds(_now() + Jst).UtcDateTime.Date;
            return (a.Date == today ? "今日 " : "明日 ") + a.Hour.ToString(CultureInfo.InvariantCulture) + ":" + a.Minute.ToString("00", CultureInfo.InvariantCulture);
        }

        /// <summary>Why the current first step's screen is not open: 「明日開きます」 when tomorrow's day count opens it.</summary>
        private static string LockText(string kind, GoalTomorrow t)
        {
            var feature = kind == "breed" ? "breeding" : kind == "friends" ? "friends" : kind == "team" ? "teams" : kind == "ta_finish" ? "time_attack" : kind == "care" ? "bond" : null;
            if (feature != null && t != null && t.Opens.Contains(feature)) return "明日開きます";
            return "レースを重ねると開きます";
        }

        private string TopBand(GoalClassRow c)
        {
            if (c.TopReward == null) return null;
            if (c.TopMaxRank == 1) return "1位 " + UxText.Reward(c.TopReward, _itemName);
            return "上位" + c.TopMaxRank + "位 " + UxText.Reward(c.TopReward, _itemName);
        }

        /// <summary>The first open daily goal as the rung's line (「3着以内に入る 1/2」).</summary>
        private string NextToday(GoalLadderView v)
        {
            var next = v.Today.Items.FirstOrDefault(i => !i.Done);
            return next == null ? "今日の目標は完了" : Title(next.Kind) + " " + Math.Min(next.Progress, next.Target) + "/" + next.Target;
        }
    }
}
