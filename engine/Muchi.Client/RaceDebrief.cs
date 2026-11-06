using System;
using System.Collections.Generic;
using Muchi.Engine;

namespace Muchi.Client
{
    /// <summary>Why the race was won or lost (REQ-UXS-005). Values 100..199 are wins, 200..299 losses.</summary>
    public enum DebriefReason
    {
        /// <summary>Whips in the final stretch passed horses (「残り200mのムチで2頭抜いた」).</summary>
        WinWhipFinish = 100,
        /// <summary>Led most of the way and held on (逃げ切り).</summary>
        WinFromFront = 101,
        /// <summary>Saved stamina in a slipstream, then came through.</summary>
        WinSlipstream = 102,
        /// <summary>Nothing stood out: the horse simply lasted.</summary>
        WinStaminaKept = 103,

        /// <summary>Pulled (掛かり) without the rein and ran out of stamina.</summary>
        LossKakari = 200,
        /// <summary>Stamina hit 0 well before the line.</summary>
        LossStaminaEmpty = 201,
        /// <summary>Never used the whip.</summary>
        LossNoWhip = 202,
        /// <summary>Whips came before the final stretch, where they barely work.</summary>
        LossEarlyWhip = 203,
        /// <summary>The first real whip came too close to the line.</summary>
        LossLateWhip = 204,
        /// <summary>Whips were mashed inside each other's effect (diminished, R4a).</summary>
        LossWhipMash = 205,
        /// <summary>Tutorial: fewer than two whips in the last 300 m (REQ-UXS-004).</summary>
        LossTooFewWhips = 206,
        /// <summary>Boxed in behind slower horses in the final stretch.</summary>
        LossBlocked = 207,
        /// <summary>Lost ground running wide on the corners.</summary>
        LossWide = 208,
        /// <summary>Left the gate late (出遅れ).</summary>
        LossLateStart = 209,
        /// <summary>Rode well enough; the others were faster.</summary>
        LossOutpaced = 210,
    }

    /// <summary>
    /// Numbers behind a debrief, gathered tick by tick from the engine state and events. Feed it every tick
    /// (<c>OfflineRace.Stepped</c>) or every frame (catch-up gaps are weighted by the ticks they cover).
    /// The values are settable so facts from another source (a server replay, a test) can be debriefed too.
    /// </summary>
    public sealed class RaceDebriefRecorder
    {
        private int _lastTick = -1, _lastRank = -1, _eventIndex;

        public int Slot { get; }
        public int WhipCount { get; set; }
        /// <summary>Whips outside the spurt zone (they only have earlyWhipEffect, 15 %).</summary>
        public int EarlyWhips { get; set; }
        /// <summary>Whips inside the previous whip's diminish window.</summary>
        public int MashedWhips { get; set; }
        /// <summary>Remaining mm at the first whip inside the spurt zone (-1 = none).</summary>
        public long FirstSpurtWhipRemainingMm { get; set; } = -1;
        /// <summary>Remaining mm at every whip, in order.</summary>
        public List<long> WhipRemainingMm { get; } = new List<long>();
        /// <summary>0-based rank just before each whip (same order as <see cref="WhipRemainingMm"/>).</summary>
        public List<int> WhipRankBefore { get; } = new List<int>();
        /// <summary>0-based rank just before the first spurt-zone whip (-1 = none).</summary>
        public int RankAtFirstSpurtWhip { get; set; } = -1;
        public int KakariCount { get; set; }
        /// <summary>Ticks spent pulling without the rein.</summary>
        public int KakariUnreinedTicks { get; set; }
        public bool LateStart { get; set; }
        public int StaminaEmptyTick { get; set; } = -1;
        /// <summary>Remaining mm when stamina hit 0 (-1 = never).</summary>
        public long StaminaEmptyRemainingMm { get; set; } = -1;
        public int SlipstreamTicks { get; set; }
        public int RunningTicks { get; set; }
        public int LedTicks { get; set; }
        public int BlockedFinalTicks { get; set; }
        /// <summary>Ground lost to running off the rail on corners, mm.</summary>
        public long WideLossMm { get; set; }
        /// <summary>Horses passed (sum of rank gains between observations).</summary>
        public int PassesMade { get; set; }
        public int TimesPassed { get; set; }

        public RaceDebriefRecorder(int slot) { Slot = slot; }

        public void Observe(RaceSim sim)
        {
            if (sim == null || Slot < 0 || Slot >= sim.EntrantCount || sim.Tick == _lastTick) return;
            int dt = _lastTick < 0 ? 1 : sim.Tick - _lastTick;
            _lastTick = sim.Tick;
            var p = sim.P;
            var h = sim.GetHorse(Slot);
            long remaining = Math.Max(0, (sim.Track.Distance - h.Distance).ToMilli());
            int rankBefore = _lastRank >= 0 ? _lastRank : h.Rank;

            var events = sim.Events;
            for (; _eventIndex < events.Count; _eventIndex++)
            {
                var e = events[_eventIndex];
                if (e.Slot != Slot) continue;
                switch (e.Type)
                {
                    case RaceEventType.Whip:
                        WhipCount++;
                        WhipRemainingMm.Add(remaining);
                        bool spurt = remaining <= sim.SpurtZoneM * 1000L;
                        if (!spurt) EarlyWhips++;
                        if (spurt && FirstSpurtWhipRemainingMm < 0) { FirstSpurtWhipRemainingMm = remaining; RankAtFirstSpurtWhip = rankBefore; }
                        if (WhipRemainingMm.Count > 1 && e.Tick - _prevWhipTick < p.WhipDiminishWindowTicks) MashedWhips++;
                        _prevWhipTick = e.Tick;
                        WhipRankBefore.Add(rankBefore);
                        break;
                    case RaceEventType.Kakari: KakariCount++; break;
                    case RaceEventType.LateStart: LateStart = true; break;
                }
            }
            if (!h.Departed) { _lastRank = h.Rank; return; }
            if (!h.Finished)
            {
                RunningTicks += dt;
                if (h.Rank == 0) LedTicks += dt;
                if (RaceFeel.InSlipstream(sim, Slot)) SlipstreamTicks += dt;
                if (h.IsKakari && !h.Reining) KakariUnreinedTicks += dt;
                if (h.Blocked && h.InSpurt) BlockedFinalTicks += dt;
                if (h.Stamina.Raw <= 0 && StaminaEmptyTick < 0) { StaminaEmptyTick = sim.Tick - 1; StaminaEmptyRemainingMm = remaining; }
                var seg = sim.Track.Segment(sim.Track.SegmentIndexAt(h.Distance));
                if (seg.Kind == SegmentKind.Corner && seg.RadiusM > 0)
                {
                    long offsetMm = h.Lane.ToMilli() * p.LaneWidthMm / 1000;
                    WideLossMm += h.LastAdvance.ToMilli() * offsetMm / (seg.RadiusM * 1000L) * dt;
                }
            }
            if (_lastRank >= 0 && !(h.Finished && h.FinishTick < sim.Tick - 1))
            {
                if (h.Rank < _lastRank) PassesMade += _lastRank - h.Rank;
                else if (h.Rank > _lastRank) TimesPassed += h.Rank - _lastRank;
            }
            _lastRank = h.Rank;
        }

        private int _prevWhipTick = -100000;
    }

    /// <summary>
    /// REQ-UXS-005: one short Japanese line on why the race was won or lost, a reason code and one tip, from the
    /// engine's events and state (whip timing and count, kakari, where stamina hit 0, passes, slipstream, wide
    /// running, blocking). Deterministic, and it never contradicts the result: a win always gets a 1xx reason, a
    /// loss a 2xx reason, and the line never claims a place the horse did not get.
    /// </summary>
    public sealed class RaceDebrief
    {
        public DebriefReason Reason { get; private set; }
        /// <summary>Stable snake_case id of <see cref="Reason"/> (analytics, localisation keys).</summary>
        public string Code { get; private set; }
        /// <summary>One short line, e.g. 「残り200mのムチで2頭抜いた」.</summary>
        public string Line { get; private set; }
        /// <summary>One improvement tip, e.g. 「掛かったら手綱を長押し」.</summary>
        public string Tip { get; private set; }
        public bool Won { get; private set; }
        /// <summary>1-based finishing place (0 = not in the result).</summary>
        public int Place { get; private set; }
        public int Runners { get; private set; }
        /// <summary>Distance behind the winner (losses) or ahead of the 2nd (wins), mm.</summary>
        public long MarginMm { get; private set; }
        public RaceDebriefRecorder Facts { get; private set; }

        public bool IsWinReason => (int)Reason >= 100 && (int)Reason < 200;

        // thresholds (metres / ticks / permille)
        public const int StaminaEmptyMinRemainingM = 50;
        public const int KakariMinUnreinedTicks = 20;
        public const int LateWhipM = 100;
        public const int WideLossMinM = 5;
        public const int BlockedMinTicks = 20;
        public const int FrontRunnerLedPermille = 600;
        public const int SlipstreamPermille = 150;

        public static string CodeOf(DebriefReason r)
        {
            switch (r)
            {
                case DebriefReason.WinWhipFinish: return "win_whip_finish";
                case DebriefReason.WinFromFront: return "win_from_front";
                case DebriefReason.WinSlipstream: return "win_slipstream";
                case DebriefReason.WinStaminaKept: return "win_stamina_kept";
                case DebriefReason.LossKakari: return "loss_kakari";
                case DebriefReason.LossStaminaEmpty: return "loss_stamina_empty";
                case DebriefReason.LossNoWhip: return "loss_no_whip";
                case DebriefReason.LossEarlyWhip: return "loss_early_whip";
                case DebriefReason.LossLateWhip: return "loss_late_whip";
                case DebriefReason.LossWhipMash: return "loss_whip_mash";
                case DebriefReason.LossTooFewWhips: return "loss_too_few_whips";
                case DebriefReason.LossBlocked: return "loss_blocked";
                case DebriefReason.LossWide: return "loss_wide";
                case DebriefReason.LossLateStart: return "loss_late_start";
                default: return "loss_outpaced";
            }
        }

        /// <summary>Debrief of a finished race from a recorder that observed it.</summary>
        public static RaceDebrief Build(RaceSim sim, RaceDebriefRecorder facts)
        {
            if (sim == null) throw new ArgumentNullException(nameof(sim));
            if (facts == null) throw new ArgumentNullException(nameof(facts));
            if (!sim.IsFinished || sim.Result == null) throw new InvalidOperationException("the race has not finished");
            var res = sim.Result;
            int idx = Array.IndexOf(res.Order, facts.Slot);
            bool won = idx == 0 && res.FinishTicks[0] >= 0;
            long margin = 0;
            if (won) margin = res.Order.Length > 1 ? res.Margins[1].ToMilli() : 0;
            else if (idx > 0) for (int i = 1; i <= idx; i++) margin += res.Margins[i].ToMilli();
            return FromFacts(facts, idx < 0 ? 0 : idx + 1, res.Order.Length, margin, sim.Config.Mode == RaceMode.Tutorial);
        }

        /// <summary>
        /// The decision on its own: <paramref name="place"/> 1 is a win (1xx reason), anything else a loss (2xx).
        /// <paramref name="marginMm"/> = ahead of the 2nd for a win, behind the winner for a loss.
        /// </summary>
        public static RaceDebrief FromFacts(RaceDebriefRecorder facts, int place, int runners, long marginMm, bool tutorial)
        {
            if (facts == null) throw new ArgumentNullException(nameof(facts));
            var d = new RaceDebrief { Facts = facts, Place = place, Runners = runners, Won = place == 1, MarginMm = Math.Abs(marginMm) };
            if (d.Won) d.PickWin(tutorial, facts); else d.PickLoss(tutorial, facts);
            d.Code = CodeOf(d.Reason);
            return d;
        }

        /// <summary>
        /// Debrief from the input log: re-runs the race (config + every slot's inputs, e.g. OfflineRace.AllInputs or
        /// the room's confirmed inputs) with a recorder on <paramref name="slot"/>.
        /// </summary>
        public static RaceDebrief FromInputs(RaceConfig config, IList<InputRecord> inputs, int slot)
        {
            var sim = new RaceSim(config);
            var rec = new RaceDebriefRecorder(slot);
            var byTick = new Dictionary<int, List<InputRecord>>();
            foreach (var r in inputs)
            {
                if (!byTick.TryGetValue(r.Tick, out var l)) byTick[r.Tick] = l = new List<InputRecord>();
                l.Add(r);
            }
            var cmds = new byte[config.Entrants.Count];
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, cmds.Length);
                if (byTick.TryGetValue(sim.Tick, out var list)) foreach (var r in list) if (r.Slot >= 0 && r.Slot < cmds.Length) cmds[r.Slot] |= r.Cmd;
                sim.Step(cmds);
                rec.Observe(sim);
            }
            return Build(sim, rec);
        }

        private static string Metres(long mm)
        {
            long m = (mm + 25000) / 50000 * 50; // nearest 50 m: 「残り200m」
            if (m < 50) m = (mm + 5000) / 10000 * 10;
            if (m < 10) m = 10;
            return m + "m";
        }

        private void PickWin(bool tutorial, RaceDebriefRecorder f)
        {
            // the whip that started the run: the first spurt-zone whip (tutorial: the first one that counted)
            long whipMm = f.FirstSpurtWhipRemainingMm;
            int rankAtWhip = f.RankAtFirstSpurtWhip;
            if (tutorial)
            {
                whipMm = -1; rankAtWhip = -1;
                for (int i = 0; i < f.WhipRemainingMm.Count; i++)
                    if (TutorialDirector.CountsAt(f.WhipRemainingMm[i])) { whipMm = f.WhipRemainingMm[i]; rankAtWhip = f.WhipRankBefore[i]; break; }
            }
            int gained = rankAtWhip >= 0 ? rankAtWhip - (Place - 1) : 0;
            int led = f.RunningTicks <= 0 ? 0 : f.LedTicks * 1000 / f.RunningTicks;
            int slip = f.RunningTicks <= 0 ? 0 : f.SlipstreamTicks * 1000 / f.RunningTicks;
            if (whipMm >= 0 && gained > 0)
            {
                Reason = DebriefReason.WinWhipFinish;
                Line = "残り" + Metres(whipMm) + "のムチで" + (gained == 1 ? "差し切った" : gained + "頭抜いた");
                Tip = f.MashedWhips > 0 ? "ムチは間をあけると、もっと伸びる" : "このタイミングを覚えておこう";
            }
            else if (led >= FrontRunnerLedPermille && f.TimesPassed == 0) // 「譲らず」: never headed
            {
                Reason = DebriefReason.WinFromFront;
                Line = "先頭を譲らず逃げ切った";
                Tip = "前半は手綱で脚をためると、最後も粘れる";
            }
            else if (slip >= SlipstreamPermille)
            {
                Reason = DebriefReason.WinSlipstream;
                Line = "前の馬の後ろで脚をため、最後に抜け出した";
                Tip = "風よけの位置取りを続けよう";
            }
            else if (whipMm >= 0)
            {
                Reason = DebriefReason.WinWhipFinish;
                Line = "残り" + Metres(whipMm) + "からのムチで押し切った";
                Tip = "このタイミングを覚えておこう";
            }
            else
            {
                Reason = DebriefReason.WinStaminaKept;
                Line = "最後まで脚が持った";
                Tip = tutorial ? "次は残り300mからムチを2回" : "最後の直線でムチを使えば、もっと離せる";
            }
        }

        private void PickLoss(bool tutorial, RaceDebriefRecorder f)
        {
            long emptyM = f.StaminaEmptyRemainingMm;
            // kakari only explains the loss when the horse pulled unreined for a while and it cost stamina
            bool kakariHurt = f.KakariCount > 0 && f.KakariUnreinedTicks >= KakariMinUnreinedTicks
                && (emptyM >= 0 || f.KakariUnreinedTicks >= KakariMinUnreinedTicks * 2);
            if (kakariHurt)
            {
                Reason = DebriefReason.LossKakari;
                Line = "掛かって脚が早く尽きた";
                Tip = "掛かったら手綱を長押し";
                return;
            }
            if (emptyM >= StaminaEmptyMinRemainingM * 1000L)
            {
                Reason = DebriefReason.LossStaminaEmpty;
                Line = "残り" + Metres(emptyM) + "で脚が上がった";
                Tip = "前半は手綱で脚をためよう";
                return;
            }
            if (f.WhipCount == 0)
            {
                Reason = DebriefReason.LossNoWhip;
                Line = "ムチを使わなかった";
                Tip = tutorial ? "残り300mから、ムチを2回" : "最後の直線でムチを入れよう";
                return;
            }
            int counted = 0, early = 0, late = 0;
            foreach (var mm in f.WhipRemainingMm)
            {
                if (TutorialDirector.CountsAt(mm)) counted++;
                else if (mm > TutorialDirector.WhipWindowM * 1000L) early++;
                else late++;
            }
            if (tutorial && counted < TutorialDirector.WhipsToWin)
            {
                if (counted == 0 && early > 0 && late == 0) { Reason = DebriefReason.LossEarlyWhip; Line = "ムチが早すぎた"; Tip = "ボタンが光る残り300mからムチを2回"; return; }
                if (counted == 0) { Reason = DebriefReason.LossLateWhip; Line = "ムチが遅かった"; Tip = "ボタンが光る残り300mからムチを2回"; return; }
                Reason = DebriefReason.LossTooFewWhips;
                Line = "残り300mからのムチが1回だけ。あと" + MarginText() + "届かなかった";
                Tip = "残り300mから、ムチをもう1回";
                return;
            }
            if (f.MashedWhips >= 2 && f.MashedWhips * 2 >= f.WhipCount)
            {
                Reason = DebriefReason.LossWhipMash;
                Line = "ムチを連打して効きが落ちた";
                Tip = "ムチは間をあけて";
                return;
            }
            if (f.EarlyWhips * 2 > f.WhipCount)
            {
                Reason = DebriefReason.LossEarlyWhip;
                Line = "ムチが早すぎて、あまり効かなかった";
                Tip = "ムチは最後の直線に入ってから";
                return;
            }
            if (f.FirstSpurtWhipRemainingMm >= 0 && f.FirstSpurtWhipRemainingMm < LateWhipM * 1000L)
            {
                Reason = DebriefReason.LossLateWhip;
                Line = "ムチが残り" + Metres(f.FirstSpurtWhipRemainingMm) + "からで遅かった";
                Tip = "ムチはもう少し早く、残り400m前後から";
                return;
            }
            if (f.WideLossMm >= WideLossMinM * 1000L && f.WideLossMm >= MarginMm)
            {
                Reason = DebriefReason.LossWide;
                Line = "コーナーで外を回り、" + (f.WideLossMm / 1000) + "m損した";
                Tip = "コーナーは内へ寄せよう";
                return;
            }
            if (f.BlockedFinalTicks >= BlockedMinTicks)
            {
                Reason = DebriefReason.LossBlocked;
                Line = "直線で前が詰まった";
                Tip = "前が詰まったら外へ出そう";
                return;
            }
            if (f.LateStart)
            {
                Reason = DebriefReason.LossLateStart;
                Line = "出遅れが響いた";
                Tip = "ゲートが開いたらすぐスタート";
                return;
            }
            Reason = DebriefReason.LossOutpaced;
            Line = "勝ち馬まで" + MarginText() + "届かなかった";
            Tip = f.SlipstreamTicks * 10 < f.RunningTicks ? "前の馬の後ろで脚をためよう" : "相棒を育てて、もう一度";
        }

        private string MarginText() => RaceFeel.MarginText(MarginMm);

        public override string ToString() => Code + " " + Line + " / " + Tip;
    }
}
