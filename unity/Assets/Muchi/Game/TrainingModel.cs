using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-TRAIN-001..014 (contracts/protocol.md §25, docs/handoff-codex-round11-training.md): 調教, the game layer.
    // Pure C#: Codex's screen binds to the public fields, feeds taps from the input layer and plays the animations.
    // The model never decides an outcome — the server re-scores the taps (TrainingScorer is the same algorithm, used for
    // the instant on-screen judgement) and applies the growth.

    /// <summary>One menu card (坂路 / ウッド / プール / 併せ馬) for the selected horse.</summary>
    public sealed class TrainingMenuCard
    {
        public string Id, Name;
        /// <summary>"瞬発・根性・スタミナ" — the stats it grows, heaviest first.</summary>
        public string FocusText;
        /// <summary>"疲れ +30" / "疲れ −20（回復）".</summary>
        public string FatigueText;
        /// <summary>"絆が効く ×2" for 併せ馬, else null.</summary>
        public string BondText;
        public bool Enabled;
        /// <summary>Why it is disabled (one sentence), null when enabled.</summary>
        public string BlockedText;
    }

    /// <summary>The mini-game phase on screen.</summary>
    public enum TrainingPhase { Choose, Ready, Playing, Submitting, Result }

    /// <summary>
    /// The training screen: pick a horse and a menu, play (or skip) the timing mini-game, see the growth.
    /// Rules the model keeps for the screen:
    ///  - the session starts on the server (a slot is used then); the beats come from the server, and the taps are times in
    ///    ms after the mini-game began (<see cref="BeginMiniGame"/>), recorded only when the server would accept them;
    ///  - the finish keeps its idempotency key until the server answers, so a retry after a timeout never counts twice;
    ///  - an open session found on load (app closed mid-game) is finished as skipped — the time has passed;
    ///  - <see cref="RulesText"/> states the fairness rules as they are (ranked normalises the growth, fatigue reaches no race);
    ///  - no paid shortcut exists, so the screen never links to the shop.
    /// </summary>
    public sealed class TrainingModel : ScreenModel
    {
        public const string KeyPendingStart = "muchi.training.start";
        public const string KeyPendingFinish = "muchi.training.finish";
        public const string KeyHorse = "muchi.training.horse";

        public static readonly IReadOnlyDictionary<string, string> StatNames = new Dictionary<string, string>
        {
            ["speed"] = "スピード", ["stamina"] = "スタミナ", ["burst"] = "瞬発", ["guts"] = "根性", ["temper"] = "気性",
        };
        static readonly string[] StatOrder = { "speed", "stamina", "burst", "guts", "temper" };

        public static readonly IReadOnlyDictionary<string, string> BlockedTexts = new Dictionary<string, string>
        {
            ["no_slots"] = "今日の調教はおしまい。4:00に戻ります",
            ["horse_daily_limit"] = "この馬は今日はここまで。別の馬を選べます",
            ["potential_full"] = "この馬は素質いっぱいまで伸びました",
            ["tired"] = "疲れがたまっています。プールか、1日休ませましょう",
            ["retired"] = "引退した馬は調教できません",
        };

        public static readonly IReadOnlyDictionary<string, string> GradeTexts = new Dictionary<string, string>
        {
            ["great"] = "◎ 会心の追い切り", ["good"] = "○ いい動き", ["normal"] = "△ まずまず",
        };

        public static readonly IReadOnlyDictionary<string, string> ConditionTexts = new Dictionary<string, string>
        {
            ["fresh"] = "好調", ["normal"] = "ふつう", ["tired"] = "お疲れ",
        };

        public const string RulesText = "調教で伸びた能力はレースで使われます。ランク戦・大会・タイムアタックではこれまでどおりクラスの上限にそろえます。疲れはどのレースにも影響しません。伸びは仔には受け継がれません。";

        public TrainingModel(GameBackend backend, IKeyValueStore store = null) : base(backend, store ?? backend?.Store) { }

        public TrainingView View { get; private set; }
        public string HorseId { get; private set; }
        public TrainingHorse Horse => View?.Horse(HorseId);
        public TrainingPhase Phase { get; private set; } = TrainingPhase.Choose;
        public TrainingSession Session { get; private set; }
        public TrainingStart Started { get; private set; }
        public TrainingResult Result { get; private set; }
        public bool Skipped { get; private set; }
        private readonly List<int> _taps = new List<int>();
        public IReadOnlyList<int> Taps => _taps;
        /// <summary>Judgement of each recorded tap ("perfect" | "good" | "miss") for the flashes.</summary>
        public List<string> Judgements { get; } = new List<string>();
        private long _miniGameStart = -1;

        public bool Enabled => View != null && View.Enabled;
        public int SlotsLeft => View?.SlotsLeft ?? 0;
        /// <summary>"今日の調教 あと2回".</summary>
        public string SlotsText => View == null ? null : "今日の調教 あと" + View.SlotsLeft.ToString(CultureInfo.InvariantCulture) + "回";
        /// <summary>"素質 126 / 240" (growth so far over the horse's potential).</summary>
        public string PotentialText => Horse == null ? null : "素質 " + Horse.TrainedTotal.ToString(CultureInfo.InvariantCulture) + " / " + Horse.Potential.ToString(CultureInfo.InvariantCulture);
        /// <summary>0..1 for the potential meter.</summary>
        public float PotentialProgress => Horse == null || Horse.Potential <= 0 ? 0f : Math.Min(1f, Horse.TrainedTotal / (float)Horse.Potential);
        /// <summary>"疲れ 30（好調）".</summary>
        public string FatigueText => Horse == null ? null : "疲れ " + Horse.Fatigue.ToString(CultureInfo.InvariantCulture) + "（" + ConditionText(Horse.Condition) + "）";
        /// <summary>0..1 for the fatigue gauge (warning colour from RestAt).</summary>
        public float FatigueProgress => Horse == null || View.FatigueMax <= 0 ? 0f : Math.Min(1f, Horse.Fatigue / (float)View.FatigueMax);
        public bool FatigueWarning => Horse != null && Horse.Fatigue >= View.RestAt;
        public TrainingItem Apple => View?.Items.FirstOrDefault(i => i.Owned > 0);
        public bool CanUseItem => Apple != null && Horse != null && Horse.Fatigue > 0 && Phase == TrainingPhase.Choose;

        public static string ConditionText(string c) => c != null && ConditionTexts.TryGetValue(c, out var t) ? t : "ふつう";

        public List<TrainingMenuCard> Cards
        {
            get
            {
                var list = new List<TrainingMenuCard>();
                if (View == null) return list;
                foreach (var m in View.Menus)
                {
                    string blocked = Horse == null ? "no_horse" : (Horse.MenuBlocked.TryGetValue(m.Id, out var b) ? b : Horse.Blocked);
                    list.Add(new TrainingMenuCard
                    {
                        Id = m.Id, Name = m.Name, FocusText = FocusText(m),
                        FatigueText = m.Fatigue >= 0 ? "疲れ +" + m.Fatigue.ToString(CultureInfo.InvariantCulture) : "疲れ −" + (-m.Fatigue).ToString(CultureInfo.InvariantCulture) + "（回復）",
                        BondText = m.BondMultiplier > 1 ? "絆が効く ×" + m.BondMultiplier.ToString(CultureInfo.InvariantCulture) : null,
                        Enabled = blocked == null && View.SlotsLeft > 0 && Phase == TrainingPhase.Choose,
                        BlockedText = blocked == null ? (View.SlotsLeft > 0 ? null : BlockedTexts["no_slots"]) : (BlockedTexts.TryGetValue(blocked, out var t) ? t : "選べません"),
                    });
                }
                return list;
            }
        }

        public static string FocusText(TrainingMenu m) =>
            string.Join("・", m.Weights.Where(kv => kv.Value > 0).OrderByDescending(kv => kv.Value).ThenBy(kv => Array.IndexOf(StatOrder, kv.Key)).Select(kv => StatNames.TryGetValue(kv.Key, out var n) ? n : kv.Key));

        /// <summary>Loads the screen. An open session left from a closed app is finished as skipped (its time has passed).</summary>
        public async Task<ActionResult> LoadAsync(string horseId = null, CancellationToken ct = default)
        {
            Message = null;
            Phase = TrainingPhase.Choose; Session = null; Result = null; Started = null;
            if (!ServerAvailable) { View = null; return Offline("調教はオンラインで行えます"); }
            try
            {
                View = await B.Api.GetTrainingAsync(ct);
                Online = true;
                if (!View.Enabled) return ActionResult.Success();
                SelectHorse(horseId ?? Kv.Get(KeyHorse) ?? B.Partner?.Id);
                if (View.Open != null)
                {
                    Session = View.Open;
                    Skipped = true;
                    return await FinishAsync(ct);
                }
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>Selects a horse (falls back to the first active horse that can still train today).</summary>
        public void SelectHorse(string horseId)
        {
            if (View == null) return;
            var h = View.Horse(horseId) ?? View.Horses.FirstOrDefault(x => x.Blocked == null) ?? View.Horses.FirstOrDefault();
            HorseId = h?.HorseId;
            if (HorseId != null) Kv.Set(KeyHorse, HorseId);
        }

        /// <summary>Starts the session on the server (uses a slot). Then show the "READY" cue and call <see cref="BeginMiniGame"/>.</summary>
        public async Task<ActionResult> StartAsync(string menuId, CancellationToken ct = default)
        {
            var card = Cards.FirstOrDefault(c => c.Id == menuId);
            if (card == null || !card.Enabled) return ActionResult.Error(card?.BlockedText ?? "選べません");
            string key = PendingKey(KeyPendingStart, HorseId + ":" + menuId + ":" + View.UsedToday);
            try
            {
                Started = await B.Api.StartTrainingAsync(HorseId, menuId, key, ct);
                Kv.Set(KeyPendingStart, "");
                Session = Started.Session;
                if (Started.Training != null) View = Started.Training.MergeInto(View);
                _taps.Clear(); Judgements.Clear(); _miniGameStart = -1; Skipped = false; Result = null;
                Phase = TrainingPhase.Ready;
                return ActionResult.Success();
            }
            catch (ApiException e) { return Failed(e, KeyPendingStart); }
        }

        /// <summary>The mini-game begins now (local monotonic ms, e.g. Time.realtimeSinceStartup × 1000).</summary>
        public void BeginMiniGame(long nowMs)
        {
            if (Phase != TrainingPhase.Ready) return;
            _miniGameStart = nowMs;
            Phase = TrainingPhase.Playing;
        }

        /// <summary>Elapsed mini-game time for the beat track (0..DurationMs).</summary>
        public int Elapsed(long nowMs) => _miniGameStart < 0 ? 0 : (int)Math.Max(0, Math.Min(View.Timing.DurationMs, nowMs - _miniGameStart));

        /// <summary>Whether the beat track has run out (then call <see cref="FinishAsync"/>).</summary>
        public bool MiniGameOver(long nowMs) => Phase == TrainingPhase.Playing && nowMs - _miniGameStart >= View.Timing.DurationMs;

        /// <summary>A tap at local time <paramref name="nowMs"/>. Returns the judgement for the flash, or null when the tap is not recorded.</summary>
        public string Tap(long nowMs)
        {
            if (Phase != TrainingPhase.Playing || Session == null) return null;
            int t = (int)(nowMs - _miniGameStart);
            if (!TrainingScorer.Accepts(View.Timing, _taps, t)) return null;
            _taps.Add(t);
            var j = TrainingScorer.Judge(View.Timing, Session.Beats, t);
            Judgements.Add(j);
            return j;
        }

        /// <summary>The live score (same steps as the server).</summary>
        public TimingScore LiveScore => Session == null || View == null ? new TimingScore() : TrainingScorer.Score(View.Timing, Session.Beats, _taps);

        /// <summary>"スキップ": no mini-game, no bonus (the growth itself is unchanged).</summary>
        public void Skip()
        {
            if (Phase != TrainingPhase.Ready && Phase != TrainingPhase.Playing) return;
            Skipped = true;
            _taps.Clear(); Judgements.Clear();
        }

        /// <summary>Sends the taps; the server re-scores them and applies the growth.</summary>
        public async Task<ActionResult> FinishAsync(CancellationToken ct = default)
        {
            if (Session == null) return ActionResult.Error("調教が始まっていません");
            Phase = TrainingPhase.Submitting;
            string key = PendingKey(KeyPendingFinish, Session.SessionId);
            try
            {
                Result = await B.Api.FinishTrainingAsync(Session.SessionId, Skipped ? null : _taps.ToArray(), Skipped, key, ct);
                Kv.Set(KeyPendingFinish, "");
                if (Result.Training != null) View = Result.Training.MergeInto(View);
                Session = null;
                Phase = TrainingPhase.Result;
                return ActionResult.Success(ResultHeadline);
            }
            catch (ApiException e)
            {
                if (e.Code == ApiErrorCode.TrainingSessionExpired || e.Code == ApiErrorCode.TrainingSessionUsed)
                {
                    // the server already settled it (skipped); reload so the counts are right
                    Kv.Set(KeyPendingFinish, "");
                    Session = null;
                    await LoadAsync(HorseId, ct);
                    Message = "時間切れのため、ミニゲームなしで記録しました";
                    return ActionResult.Error(Message);
                }
                Phase = GameBackend.IsTransient(e) ? TrainingPhase.Submitting : TrainingPhase.Choose;
                return Failed(e, KeyPendingFinish);
            }
        }

        /// <summary>Back to the menu cards after the result.</summary>
        public void Continue()
        {
            if (Phase != TrainingPhase.Result) return;
            Result = null; Phase = TrainingPhase.Choose;
        }

        /// <summary>"◎ 会心の追い切り".</summary>
        public string GradeText => Result == null ? null : (GradeTexts.TryGetValue(Result.Grade ?? "normal", out var t) ? t : Result.Grade);
        /// <summary>"+6".</summary>
        public string ResultHeadline => Result == null ? null : (Result.Total > 0 ? "+" + Result.Total.ToString(CultureInfo.InvariantCulture) : "伸びは次回へ持ち越し");
        /// <summary>"瞬発+3・スタミナ+2・根性+1".</summary>
        public string GainText
        {
            get
            {
                if (Result == null) return null;
                var g = Result.Gain;
                var parts = new List<string>();
                void Add(string k, int v) { if (v > 0) parts.Add(StatNames[k] + "+" + v.ToString(CultureInfo.InvariantCulture)); }
                Add("speed", g.Speed); Add("stamina", g.Stamina); Add("burst", g.Burst); Add("guts", g.Guts); Add("temper", g.Temper);
                return parts.Count == 0 ? "（小さな伸びは次回に加わります）" : string.Join("・", parts);
            }
        }
        /// <summary>"ミニゲーム ◎4 ○1 ×0（+9%）" or "ミニゲームなし".</summary>
        public string TimingText => Result == null ? null : Result.Settled != "done" ? "ミニゲームなし"
            : "ミニゲーム ◎" + Result.Timing.Perfect + " ○" + Result.Timing.Good + " ×" + Result.Timing.Miss + "（+" + (Result.Timing.BonusPermille / 10).ToString(CultureInfo.InvariantCulture) + "%）";
        /// <summary>"見込み +6〜+7" from the start preview (in whole points, the fraction carries over).</summary>
        public string PreviewText => Started == null ? null : "見込み +" + Started.PreviewMinMilli / 1000 + "." + (Started.PreviewMinMilli % 1000) / 100 + "〜+" + Started.PreviewMaxMilli / 1000 + "." + (Started.PreviewMaxMilli % 1000) / 100;

        /// <summary>Gives the training item (fatigue relief) to the selected horse.</summary>
        public async Task<ActionResult> UseItemAsync(CancellationToken ct = default)
        {
            if (!CanUseItem) return ActionResult.Error(Apple == null ? UxText.Errors["INSUFFICIENT_ITEMS"] : "疲れていません");
            try
            {
                var r = await B.Api.UseTrainingItemAsync(Apple.ItemId, HorseId, null, ct);
                if (r.Training != null) View = r.Training.MergeInto(View);
                return ActionResult.Success("疲れ " + r.FatigueBefore + " → " + r.Fatigue);
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        private string PendingKey(string kvKey, string scope)
        {
            var stored = (Kv.Get(kvKey) ?? "").Split('|');
            if (stored.Length == 2 && stored[0] == scope) return stored[1];
            string key = B.Api.NewIdempotencyKey();
            Kv.Set(kvKey, scope + "|" + key);
            return key;
        }

        private ActionResult Failed(ApiException e, string kvKey)
        {
            if (!GameBackend.IsTransient(e)) Kv.Set(kvKey, "");
            Message = UxText.For(e);
            return ActionResult.Error(Message);
        }
    }
}
