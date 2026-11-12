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
    // REQ-CAREER-001..024 (contracts/protocol.md §66, docs/handoff-codex-round22-career.md): 騎手の道, the game layer. Pure C#:
    // Codex's screens bind to the public fields and play the animations. The model never decides a clear or a star: the server
    // re-simulates the run with the verifier and judges every objective; the device shows the same verdict (CareerRun.StarsNow)
    // while the answer is on its way, then the server's. No energy, no paid continue, no paid skip: a retry is always free.

    /// <summary>One race node on the career map.</summary>
    public sealed class CareerNode
    {
        public string RaceId, ChapterId, Title;
        /// <summary>"第1戦".</summary>
        public string Index;
        public bool Unlocked, Cleared, Next;
        public int Stars, MaxStars;
        /// <summary>"星 2/3" (stars are never shown by colour alone, §41).</summary>
        public string StarsText;
        /// <summary>"★★☆" (shapes for the badge; the text above is what a screen reader says).</summary>
        public string StarGlyphs;
    }

    /// <summary>One chapter band of the map (a stretch of the vertical road).</summary>
    public sealed class CareerChapterRow
    {
        public string ChapterId, Art, Title, Subtitle;
        /// <summary>"第1章".</summary>
        public string Kicker;
        public bool Unlocked, Cleared;
        /// <summary>"星 4/9".</summary>
        public string StarsText;
        /// <summary>"能力の上限 2,800".</summary>
        public string CapText;
        public List<CareerNode> Races = new List<CareerNode>();
    }

    /// <summary>One objective line of the race detail / result.</summary>
    public sealed class CareerObjectiveLine
    {
        public int Star;
        /// <summary>"星1　3着以内でゴール".</summary>
        public string Text;
        /// <summary>"報酬：配合素材×1" or "受け取り済み", null when the objective pays nothing.</summary>
        public string RewardText;
        /// <summary>Detail: already earned. Result: met in this run.</summary>
        public bool Ok;
        /// <summary>Result: earned for the first time by this run.</summary>
        public bool Newly;
    }

    public enum CareerPhase { Map, Detail, Racing, Submitting, Result }

    public sealed class CareerModel : ScreenModel
    {
        public const string KeyPendingStart = "muchi.career.start";
        public const string RulesText = "どの馬も章ごとの能力の上限にそろえ、固有スキルは使いません。相棒でも上限まで届きます。報酬は初クリアと星ごとに一度だけ。何度でも無料でやり直せます。";
        public const string NotCountedText = "ランク戦のレーティング・クラス・ランキング・ミッションには数えません。";

        public CareerModel(GameBackend backend, IKeyValueStore store = null) : base(backend, store ?? backend?.Store) { }

        public CareerView View { get; private set; }
        public CareerPhase Phase { get; private set; } = CareerPhase.Map;
        public string SelectedRaceId { get; private set; }
        public CareerSession Session { get; private set; }
        public CareerRun Run { get; private set; }
        /// <summary>The device's stars once the race has finished (before the server answers).</summary>
        public int[] DeviceStars { get; private set; }
        public CareerResult Result { get; private set; }

        public bool Enabled => View != null && View.Enabled;
        /// <summary>The entry on the race lobby is shown after the FTUE only (§66.9).</summary>
        public static bool EntryVisible(bool inFtue) => !inFtue;

        // ------------------------------------------------------------------------------------------- map

        /// <summary>"星 12/51".</summary>
        public string HeaderStars => Enabled ? StarsText(View.TotalStars, View.MaxStars) : null;
        /// <summary>"クリア 4/17".</summary>
        public string HeaderClears => Enabled ? "クリア " + N(View.ClearedRaces) + "/" + N(View.TotalRaces) : null;

        public static string StarsText(int have, int max) => "星 " + N(have) + "/" + N(max);
        public static string Glyphs(int have, int max) => new string('★', Math.Min(have, max)) + new string('☆', Math.Max(0, max - have));

        public List<CareerChapterRow> Map()
        {
            var rows = new List<CareerChapterRow>();
            if (!Enabled) return rows;
            for (int c = 0; c < View.Chapters.Count; c++)
            {
                var ch = View.Chapters[c];
                var row = new CareerChapterRow
                {
                    ChapterId = ch.Id, Art = ch.Art, Title = ch.Title, Subtitle = ch.Subtitle, Kicker = "第" + N(c + 1) + "章",
                    Unlocked = ch.Unlocked, Cleared = ch.Cleared, StarsText = StarsText(ch.Stars, ch.MaxStars), CapText = "能力の上限 " + ch.StatCap.ToString("N0", CultureInfo.InvariantCulture),
                };
                for (int i = 0; i < ch.Races.Count; i++)
                {
                    var r = ch.Races[i];
                    int stars = r.Progress?.Stars.Length ?? 0;
                    row.Races.Add(new CareerNode
                    {
                        RaceId = r.Id, ChapterId = ch.Id, Title = r.Title, Index = "第" + N(i + 1) + "戦", Unlocked = r.Progress?.Unlocked ?? false, Cleared = r.Progress?.Cleared ?? false,
                        Next = r.Id == View.NextRaceId, Stars = stars, MaxStars = r.MaxStars, StarsText = StarsText(stars, r.MaxStars), StarGlyphs = Glyphs(stars, r.MaxStars),
                    });
                }
                rows.Add(row);
            }
            return rows;
        }

        public async Task<ActionResult> LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!ServerAvailable) return Offline("騎手の道はオンラインで遊べます。練習レースはオフラインでも遊べます");
            try
            {
                View = await B.Api.GetCareerAsync(ct);
                Online = true;
                if (Phase == CareerPhase.Result || Phase == CareerPhase.Map) Phase = CareerPhase.Map;
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        // ------------------------------------------------------------------------------------------- detail

        public CareerRace Selected => SelectedRaceId == null ? null : View?.Race(SelectedRaceId);

        /// <summary>Opens a race's detail (story, conditions, objectives). A locked race only shows what opens it.</summary>
        public ActionResult Select(string raceId)
        {
            var r = View?.Race(raceId);
            if (r == null) return ActionResult.Error("このレースはありません");
            SelectedRaceId = raceId;
            Phase = CareerPhase.Detail;
            return ActionResult.Success();
        }

        public void BackToMap() { if (Phase == CareerPhase.Detail || Phase == CareerPhase.Result) { Phase = CareerPhase.Map; Run = null; Session = null; Result = null; DeviceStars = null; } }

        public static readonly IReadOnlyDictionary<string, string> GoingTexts = WeeklyChallengeModel.GoingTexts;
        public static readonly IReadOnlyDictionary<string, string> StyleTexts = WeeklyChallengeModel.StyleTexts;

        /// <summary>"芝1600m・良" / "芝2400m・重・ナイター".</summary>
        public static string CourseText(CareerRace r)
        {
            var s = (r.Surface == "dirt" ? "ダート" : "芝") + N(r.DistanceM) + "m・" + (GoingTexts.TryGetValue(r.Going ?? "good", out var g) ? g : "良");
            return r.Night ? s + "・ナイター" : s;
        }

        /// <summary>"6頭立て・CPU Lv1" (+ "・相手は逃げ・先行").</summary>
        public static string FieldText(CareerRace r)
        {
            var s = N(r.FieldSize) + "頭立て・CPU Lv" + N(r.CpuLevel);
            if (r.CpuStyles.Count > 0) s += "・相手は" + string.Join("・", r.CpuStyles.Select(x => StyleTexts.TryGetValue(x, out var t) ? t : x));
            return s;
        }

        public static string RewardText(Reward r) => r == null ? null : UxText.Reward(r, ItemName);
        public static string ItemName(string id) => id == "breeding_material" ? "配合素材" : id == "training_apple" ? "りんごのおやつ" : id;

        public List<CareerObjectiveLine> DetailLines()
        {
            var r = Selected;
            var list = new List<CareerObjectiveLine>();
            if (r == null) return list;
            foreach (var o in r.Objectives)
            {
                bool earned = r.Progress != null && r.Progress.HasStar(o.Star);
                bool paid = r.Progress != null && (o.Star == 1 ? r.Progress.Rewarded.Clear : o.Star == 2 ? r.Progress.Rewarded.Star2 : r.Progress.Rewarded.Star3);
                list.Add(new CareerObjectiveLine
                {
                    Star = o.Star, Text = "星" + N(o.Star) + "　" + o.Text, Ok = earned,
                    RewardText = o.Reward == null ? null : paid ? "受け取り済み" : "報酬：" + RewardText(o.Reward),
                });
            }
            return list;
        }

        /// <summary>"前のレースをクリアすると開きます" for a locked race, null otherwise.</summary>
        public string LockedText => Selected?.Progress != null && !Selected.Progress.Unlocked ? "前のレースをクリアすると開きます" : null;
        public bool CanStart => Selected?.Progress != null && Selected.Progress.Unlocked && ServerAvailable;
        /// <summary>"挑戦 2回・最高 2着" or null before the first try.</summary>
        public string ProgressText => Selected?.Progress == null || Selected.Progress.Attempts == 0 ? null
            : "挑戦 " + N(Selected.Progress.Attempts) + "回" + (Selected.Progress.BestPlace.HasValue ? "・最高 " + N(Selected.Progress.BestPlace.Value) + "着" : "");

        // ------------------------------------------------------------------------------------------- race

        /// <summary>Starts the selected race with an own horse; then race <see cref="Run"/>. Free and unlimited (no energy).</summary>
        public async Task<ActionResult> StartAsync(string horseId, CancellationToken ct = default)
        {
            var r = Selected;
            if (r == null) return ActionResult.Error("レースを選んでください");
            if (string.IsNullOrEmpty(horseId)) return ActionResult.Error("馬を選んでください");
            if (r.Progress != null && !r.Progress.Unlocked) return ActionResult.Error("前のレースをクリアすると開きます");
            if (!ServerAvailable) return Offline("騎手の道はオンラインで遊べます。練習レースはオフラインでも遊べます");
            int attempts = r.Progress?.Attempts ?? 0;
            string key = PendingKey(r.Id + ":" + horseId + ":" + N(attempts));
            try
            {
                Session = await B.Api.StartCareerRaceAsync(r.Id, horseId, key, ct);
                Kv.Set(KeyPendingStart, "");
                Run = new CareerRun(Session);
                DeviceStars = null; Result = null;
                Phase = CareerPhase.Racing;
                return ActionResult.Success();
            }
            catch (ApiException e)
            {
                if (!GameBackend.IsTransient(e)) Kv.Set(KeyPendingStart, "");
                Message = UxText.For(e);
                return ActionResult.Error(Message);
            }
        }

        /// <summary>The clear objective in the race HUD with its live state (red once it can no longer be met).</summary>
        public List<ChallengeConditionLine> HudLines()
        {
            var list = new List<ChallengeConditionLine>();
            var clear = Session?.Race?.Clear;
            if (Run == null || clear == null) return list;
            var ch = Run.Challenge;
            var me = Run.Race.Sim.GetHorse(Run.PlayerSlot);
            foreach (var l in clear.Labels)
            {
                var line = new ChallengeConditionLine { Kind = l.Kind, Text = l.Text, Ok = true };
                switch (l.Kind)
                {
                    case "whips":
                        line.Value = "ムチ " + N(ch.WhipsUsed) + "/" + N(ch.Conditions.MaxWhips ?? 0);
                        line.Ok = !ch.WhipsBroken;
                        break;
                    case "place":
                        if (me.Rank > 0) line.Value = "現在 " + N(me.Rank) + "位";
                        line.Ok = !me.Finished || (me.Rank > 0 && me.Rank <= (ch.Conditions.MaxPlace ?? 12));
                        break;
                    case "time":
                        line.Value = HudModel.FormatTime(ch.ElapsedMs);
                        line.Ok = !ch.TimeBroken;
                        break;
                }
                list.Add(line);
            }
            return list;
        }

        /// <summary>Call when the race has finished: shows the device's stars and sends the run.</summary>
        public async Task<ActionResult> SubmitAsync(CancellationToken ct = default)
        {
            if (Run == null || !Run.Race.IsFinished) return ActionResult.Error("レースが終わっていません");
            DeviceStars ??= Run.StarsNow();
            Phase = CareerPhase.Submitting;
            try
            {
                Result = await B.Api.SubmitCareerRaceAsync(Session, Run, ct);
                Phase = CareerPhase.Result;
                await LoadAsync(ct); // stars, the next race, the chapter
                Phase = CareerPhase.Result;
                return ActionResult.Success(Headline);
            }
            catch (ApiException e)
            {
                Message = UxText.For(e);
                // a transient failure keeps the run: the same submit is safe to retry (the server stores the result per session)
                Phase = GameBackend.IsTransient(e) ? CareerPhase.Submitting : CareerPhase.Detail;
                return ActionResult.Error(Message);
            }
        }

        // ------------------------------------------------------------------------------------------- result

        public bool Cleared => Result?.Cleared ?? (DeviceStars != null && DeviceStars.Contains(1));
        /// <summary>"クリア" / "あと一歩" (the server's verdict; the device's until it arrives). Never a loss screen with a paid retry.</summary>
        public string Headline => Result == null && DeviceStars == null ? null : Cleared ? "クリア" : "あと一歩";
        /// <summary>"星 2/3" for this race after the run.</summary>
        public string ResultStarsText => Result == null ? null : StarsText(Result.Stars.Length, Session?.Race?.MaxStars ?? CareerLimits.StarsPerRace);
        public string ResultGlyphs => Result == null ? null : Glyphs(Result.Stars.Length, Session?.Race?.MaxStars ?? CareerLimits.StarsPerRace);

        public List<CareerObjectiveLine> ResultLines()
        {
            var list = new List<CareerObjectiveLine>();
            var race = Session?.Race;
            if (race == null) return list;
            foreach (var o in race.Objectives)
            {
                var sr = Result?.Objectives.Find(x => x.Star == o.Star);
                bool ok = sr != null ? sr.Ok : DeviceStars != null && DeviceStars.Contains(o.Star);
                list.Add(new CareerObjectiveLine { Star = o.Star, Text = "星" + N(o.Star) + "　" + o.Text, Ok = ok, Newly = sr?.Newly ?? false });
            }
            return list;
        }

        /// <summary>"報酬：配合素材×1" per grant of this run (first clear / new stars, once ever).</summary>
        public List<string> RewardLines => Result == null ? new List<string>() : Result.Rewards.Select(g => "報酬：" + RewardText(g.Reward)).ToList();
        /// <summary>"次のレース「長い直線」が開きました".</summary>
        public string UnlockLine
        {
            get
            {
                if (Result?.UnlockedRaceId == null) return null;
                var next = View?.Race(Result.UnlockedRaceId);
                return next == null ? null : "次のレース「" + next.Title + "」が開きました";
            }
        }
        /// <summary>"第1章 クリア" when this first clear finished the chapter.</summary>
        public string ChapterLine
        {
            get
            {
                if (Result == null || !Result.ChapterCleared || View == null) return null;
                int i = View.Chapters.FindIndex(c => c.Id == Result.ChapterId);
                return i < 0 ? null : "第" + N(i + 1) + "章 クリア";
            }
        }
        /// <summary>The story's closing line, shown after a clear only.</summary>
        public string StoryAfter => Cleared ? Session?.Race?.StoryAfter : null;
        /// <summary>The line under a fail: the retry is free.</summary>
        public string RetryNote => Result != null && !Result.Cleared ? "何度でも無料でやり直せます" : null;

        /// <summary>Back to the race's detail (to retry it or read it again).</summary>
        public void Continue()
        {
            if (Phase != CareerPhase.Result) return;
            Phase = CareerPhase.Detail; Run = null; Session = null; Result = null; DeviceStars = null;
        }

        private string PendingKey(string scope)
        {
            var stored = (Kv.Get(KeyPendingStart) ?? "").Split('|');
            if (stored.Length == 2 && stored[0] == scope) return stored[1];
            string key = B.Api.NewIdempotencyKey();
            Kv.Set(KeyPendingStart, scope + "|" + key);
            return key;
        }

        private static string N(int v) => v.ToString(CultureInfo.InvariantCulture);
    }
}
