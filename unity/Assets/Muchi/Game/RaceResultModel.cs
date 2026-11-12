using System;
using System.Collections.Generic;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Game
{
    /// <summary>
    /// Watches one race for the HUD and the result screen: the race-feel tracker (stamina warnings, the whip cue,
    /// slipstream, kakari), the debrief recorder (REQ-UXS-005) and the camera rig. Offline races are recorded on
    /// every engine tick (exact); online races once per frame. Call <see cref="Update"/> every frame after the
    /// driver updated, and use <see cref="Hud"/> instead of <c>HudModel.Build</c>.
    /// </summary>
    public sealed class RaceObserver : IDisposable
    {
        private readonly IRaceDriver _d;
        private OfflineRace _offline;
        private RaceSim _sim;

        public RaceFeelTracker Feel { get; private set; }
        public RaceDebriefRecorder Recorder { get; private set; }
        /// <summary>Camera helper for the player's horse (null until the race config is known).</summary>
        public RaceCameraRig Camera { get; private set; }

        public RaceObserver(IRaceDriver driver)
        {
            _d = driver ?? throw new ArgumentNullException(nameof(driver));
            Attach();
        }

        private void Attach()
        {
            if (Recorder != null || _d.Sim == null || _d.Config == null || _d.PlayerSlot < 0) return;
            _sim = _d.Sim;
            Feel = new RaceFeelTracker(_d.PlayerSlot);
            Recorder = new RaceDebriefRecorder(_d.PlayerSlot);
            Camera = RaceCameraRig.For(_d.Config, _d.Visuals?.Track);
            if (_d is OfflineRaceDriver o) { _offline = o.Race; _offline.Stepped += OnStepped; }
        }

        private void OnStepped(OfflineRace r) => Recorder.Observe(r.Sim);

        public void Update()
        {
            Attach();
            if (Recorder == null) return;
            if (_offline == null && _d.Sim == _sim) Recorder.Observe(_sim);
        }

        public HudSnapshot Hud(long nowMs)
        {
            Update();
            return HudModel.Build(_d, nowMs, Feel);
        }

        /// <summary>World-space camera shot for the player's horse at <paramref name="nowMs"/> (null before the race starts).</summary>
        public WorldCameraShot? CameraShot(CourseFrame frame, long nowMs)
        {
            if (Camera == null || frame == null || !_d.TryGetRender(_d.PlayerSlot, nowMs, out var from, out var to, out var alpha)) return null;
            return frame.ToWorld(Camera.Shot(from, to, alpha));
        }

        /// <summary>The debrief once the race has finished (null before, or when the player was not riding).</summary>
        public RaceDebrief Debrief()
        {
            Update();
            if (Recorder == null || _sim == null || !_sim.IsFinished || _sim.Result == null) return null;
            return RaceDebrief.Build(_sim, Recorder);
        }

        public void Dispose()
        {
            if (_offline != null) _offline.Stepped -= OnStepped;
            _offline = null;
        }
    }

    /// <summary>One row of the result table (the player's row is highlighted).</summary>
    public sealed class ResultRow
    {
        public int Place;
        public int Slot;
        public string Name;
        /// <summary>Margin behind the previous place in racing terms (「クビ」「1馬身」), empty for the winner.</summary>
        public string Margin;
        public bool IsPlayer;
    }

    /// <summary>
    /// What the result screen shows (06 §6.4): ① place (big) ② the win/loss line (REQ-UXS-005) ③ rewards (filled by
    /// the screen from the server) ④ the result table with the player's row ⑤ "もう一度" as the primary button.
    /// Built from the engine's result — the line always agrees with the place shown. Nothing here touches UnityEngine.
    /// </summary>
    public sealed class RaceResultModel
    {
        public bool HasResult;
        public bool Online;
        public bool Tutorial;
        /// <summary>1-based place (0 = unknown / spectating).</summary>
        public int Place;
        public int Runners;
        public bool Won;
        public long TimeMs;
        public string TimeText = "";
        /// <summary>Big text: 「差し切った！」 for the tutorial win, else 「1着」…</summary>
        public string Headline = "";
        /// <summary>The debrief line, e.g. 「残り200mのムチで2頭抜いた」 (null while verifying / void / spectating).</summary>
        public string DebriefLine;
        public string DebriefTip;
        /// <summary>
        /// Ruleset 1.4: the lesson from re-simulated races (GoCounterfactual) — 「仕掛けがあと0.5秒早ければ2着」 or
        /// 「仕掛けのタイミングは最善だった」; null when not computed (tutorial, older rulesets, no inputs). Use <see cref="AddGoLesson"/>.
        /// </summary>
        public string GoLesson;
        /// <summary>Ruleset 1.4: 「会心のムチ 3/5」 (null without whips after the go).</summary>
        public string PerfectLine;
        /// <summary>Ruleset 1.4: the counterfactual itself (shift, places, simulations) for KPI / tests.</summary>
        public GoCounterfactual Counterfactual;
        public string DebriefCode;
        public DebriefReason? Reason;
        /// <summary>Status line for online races (「結果を照合中…」, void notice), null otherwise.</summary>
        public string Status;
        /// <summary>Primary button: 「もう一度」 (same mode). Secondary: 「ホーム」. Tutorial win: 「相棒に名前をつける」.</summary>
        public string PrimaryAction = "もう一度";
        public string SecondaryAction = "ホーム";
        /// <summary>Tutorial loss: retry from the same scene (the next attempt number, assisted from 3).</summary>
        public bool TutorialRetry;
        public int NextTutorialAttempt;
        public List<ResultRow> Rows = new List<ResultRow>();

        public const string VerifyingText = "結果を照合中…";
        public const string VoidText = "このレースは無効になりました。参加費は返しました";

        /// <summary>Result of a finished race. <paramref name="tutorialAttempt"/> = the attempt just run (tutorial only).</summary>
        public static RaceResultModel Build(IRaceDriver d, RaceObserver observer, int tutorialAttempt = 0)
        {
            var m = new RaceResultModel();
            if (d == null || d.Sim == null || d.Config == null || !d.Sim.IsFinished || d.Sim.Result == null) return m;
            var sim = d.Sim;
            var res = sim.Result;
            m.HasResult = true;
            m.Online = d.Online;
            m.Tutorial = d.Config.Mode == RaceMode.Tutorial && !d.Online;
            m.Runners = res.Order.Length;
            int[] order = res.Order;
            if (d.Online && d.Final != null)
            {
                if (d.Final.Status == FinalStatus.Void) { m.Status = VoidText; }
                else if (d.Final.Status == FinalStatus.Verifying) m.Status = VerifyingText;
                if (d.Final.Order != null && d.Final.Order.Length > 0) order = d.Final.Order; // the room's decision wins
            }
            else if (d.Online && d.Phase == RacePhase.Verifying) m.Status = VerifyingText;

            int idx = d.PlayerSlot >= 0 ? Array.IndexOf(order, d.PlayerSlot) : -1;
            m.Place = idx < 0 ? 0 : idx + 1;
            m.Won = m.Place == 1 && m.Status != VoidText;
            m.TimeMs = RaceClock.ElapsedMs(sim, d.Config, d.PlayerSlot);
            m.TimeText = HudModel.FormatTime(m.TimeMs);
            m.Headline = m.Status == VoidText ? "無効" : m.Place <= 0 ? "—" : m.Tutorial && m.Won ? "差し切った！" : m.Place + "着";

            for (int p = 0; p < order.Length; p++)
            {
                int slot = order[p];
                int local = Array.IndexOf(res.Order, slot);
                m.Rows.Add(new ResultRow
                {
                    Place = p + 1,
                    Slot = slot,
                    Name = slot >= 0 && slot < d.Config.Entrants.Count ? d.Config.Entrants[slot].Horse.Name : "?",
                    Margin = p == 0 || local < 0 ? "" : RaceFeel.MarginText(res.Margins[local].ToMilli()),
                    IsPlayer = slot == d.PlayerSlot,
                });
            }

            // the line explains the place shown: only when the engine's order and the shown order agree for the player
            var debrief = observer?.Debrief();
            bool agrees = debrief != null && debrief.Place == m.Place && m.Status != VoidText && m.Status != VerifyingText;
            if (agrees)
            {
                m.DebriefLine = debrief.Line;
                m.DebriefTip = debrief.Tip;
                m.DebriefCode = debrief.Code;
                m.Reason = debrief.Reason;
            }

            // ruleset 1.4: the data-driven 仕掛け lesson for an offline race (online: AddGoLesson with the confirmed inputs)
            if (!m.Tutorial && agrees && d is OfflineRaceDriver od && d.Config.Ruleset.HasTacticsKeys)
                m.AddGoLesson(d.Config, od.Race.AllInputs(), d.PlayerSlot);

            if (m.Tutorial)
            {
                if (tutorialAttempt <= 0 && d is OfflineRaceDriver o && o.Race.Director is TutorialDirector td) tutorialAttempt = td.Attempt;
                m.TutorialRetry = !m.Won;
                m.NextTutorialAttempt = m.Won ? 0 : Math.Max(1, tutorialAttempt) + 1;
                m.PrimaryAction = m.Won ? "相棒に名前をつける" : "もう一度";
                m.SecondaryAction = null;
            }
            return m;
        }

        /// <summary>
        /// Runs <see cref="GoCounterfactual.Analyze"/> (about ten races on the device) and fills <see cref="GoLesson"/>,
        /// <see cref="PerfectLine"/> and, when it says more than the debrief, the tip. Online races pass the confirmed inputs
        /// (<c>LockstepClient.ConfirmedInputs</c>); only for a confirmed result.
        /// </summary>
        public void AddGoLesson(RaceConfig config, IList<InputRecord> inputs, int slot)
        {
            if (config == null || inputs == null || slot < 0 || !config.Ruleset.HasTacticsKeys || config.Mode == RaceMode.Tutorial) return;
            var cf = GoCounterfactual.Analyze(config, inputs, slot);
            if (cf.ActualPlace != Place) return; // the lesson must explain the place shown
            Counterfactual = cf;
            GoLesson = cf.Line;
            PerfectLine = cf.PerfectLine;
            if (cf.Tip != null && (cf.NoDecision || cf.BestShiftTicks != 0 || Reason == DebriefReason.LossOutpaced)) DebriefTip = cf.Tip;
        }
    }
}
