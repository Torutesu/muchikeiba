using System;
using System.Collections.Generic;
using Muchi.Engine;

namespace Muchi.Client
{
    // =====================================================================================================
    // Replay share (docs/planning/06 §7 item 12 / §7.3, REQ-UXS-070..072).
    //
    // A race is re-simulated on the device from its config + confirmed inputs (REQ-RACE-073): the engine is
    // deterministic, so the clip shows exactly the race that was run, with no video or state shipped from the
    // server. ReplayClip runs the race twice: pass 1 finds the window (the focus horse's last FinalDistanceM,
    // at most MaxDurationMs including PostFinishMs after its finish) and checks the result hash; pass 2 keeps
    // the engine states of every horse for the ticks of the window. Frames, camera keyframes (RaceCameraRig)
    // and the share card are built from those states. Recording and encoding are the Unity side's job
    // (Muchi.Game.IClipRecorder); this file is pure C# and never touches the simulation it reads.
    // =====================================================================================================

    public sealed class ReplayClipOptions
    {
        /// <summary>The clip starts when the focus horse has this many metres left (06 §7.3: the last 200 m).</summary>
        public int FinalDistanceM = 200;
        /// <summary>Longest clip, ms (06 §7.3: 10 seconds). The finish is always inside; a slow run starts later.</summary>
        public int MaxDurationMs = 10_000;
        /// <summary>Time kept after the focus horse crosses the line (the side-on finish shot).</summary>
        public int PostFinishMs = 1_500;
        /// <summary>Frames per second of <see cref="ReplayClip.Frames"/> (the recorder's frame rate).</summary>
        public int FramesPerSecond = 30;
        /// <summary>Spacing of <see cref="ReplayClip.CameraKeys"/> (a key is also added at every camera mode change).</summary>
        public int CameraKeyIntervalMs = 250;

        public void Validate()
        {
            if (FinalDistanceM < 1 || FinalDistanceM > 1000) throw new ArgumentException("FinalDistanceM must be 1..1000");
            if (MaxDurationMs < 1000 || MaxDurationMs > 30_000) throw new ArgumentException("MaxDurationMs must be 1000..30000");
            if (PostFinishMs < 0 || PostFinishMs >= MaxDurationMs) throw new ArgumentException("PostFinishMs must be 0..MaxDurationMs-1");
            if (FramesPerSecond < 1 || FramesPerSecond > 60) throw new ArgumentException("FramesPerSecond must be 1..60");
            if (CameraKeyIntervalMs < 16) throw new ArgumentException("CameraKeyIntervalMs must be >= 16");
        }
    }

    /// <summary>One video frame: two engine states per horse and the interpolation between them, plus the camera.</summary>
    public sealed class ReplayClipFrame
    {
        public int Index;
        /// <summary>Time from the start of the clip, ms.</summary>
        public int TimeMs;
        /// <summary>Engine tick the frame lies in (states <see cref="From"/> = after tick-1, <see cref="To"/> = after tick).</summary>
        public int Tick;
        public int AlphaPermille;
        /// <summary>Per slot (index = slot). Shared read-only arrays: do not modify.</summary>
        public HorseState[] From, To;
        /// <summary>Camera on the focus horse (RaceCameraRig: Follow / FinalStraight / Finish).</summary>
        public RaceCameraShot Camera;
        /// <summary>Metres the focus horse has left (0 once finished).</summary>
        public double FocusRemainingM;
    }

    /// <summary>A camera keyframe (course space) for recorders that tween instead of placing the camera every frame.</summary>
    public struct ReplayCameraKey
    {
        public int TimeMs;
        public RaceCameraShot Shot;
        public override string ToString() => TimeMs + "ms " + Shot;
    }

    /// <summary>A presentation event inside the clip (whip, skill cut-in, finish, lead change), timed from the clip start.</summary>
    public struct ReplayClipEvent
    {
        public int TimeMs;
        public RaceEventType Type;
        public int Slot;
        public int Value;
        public override string ToString() => TimeMs + "ms " + Type + " slot " + Slot + " v" + Value;
    }

    /// <summary>A unique skill that fired for the focus horse during the race (share card line).</summary>
    public struct SkillActivation
    {
        public string SkillId, SkillName;
        public int Tick;
        /// <summary>Metres left when it fired.</summary>
        public int RemainingM;
        /// <summary>1-based place when it fired.</summary>
        public int Place;
    }

    /// <summary>
    /// The last ~200 m of a race, re-simulated from its config and inputs (REQ-UXS-070). Build it once after the race;
    /// it holds its own copy of the states, so the live race can be disposed.
    /// </summary>
    public sealed class ReplayClip
    {
        private readonly List<HorseState[]> _states;   // _states[i] = all horses when sim.Tick == StartTick + i
        private readonly int _msPerTick;
        private readonly RaceCameraRig _rig;
        private readonly List<ReplayCameraKey> _keys = new List<ReplayCameraKey>();

        public RaceConfig Config { get; }
        public ReplayClipOptions Options { get; }
        public int FocusSlot { get; }
        /// <summary>First tick shown (states when sim.Tick == StartTick).</summary>
        public int StartTick { get; }
        /// <summary>Last tick shown (inclusive).</summary>
        public int EndTick { get; }
        public int DurationMs => (EndTick - StartTick) * _msPerTick;
        public int FrameCount => DurationMs * Options.FramesPerSecond / 1000 + 1;
        /// <summary>The re-simulated result (equals the live race's result: same config, same inputs).</summary>
        public RaceResult Result { get; }
        public string ResultHash => Result.Hash;
        /// <summary>1-based place of the focus horse (0 = not in the order).</summary>
        public int FocusPlace { get; }
        /// <summary>Race time of the focus horse from the gate, ms (-1 = did not finish). Same formula as OfflineRace.FinishTimeMs.</summary>
        public long FocusTimeMs { get; }
        /// <summary>Clip time at which the focus horse crosses the line (-1 = not in the clip).</summary>
        public int FinishAtMs { get; }
        public List<SkillActivation> FocusSkills { get; } = new List<SkillActivation>();
        public List<ReplayClipEvent> Events { get; } = new List<ReplayClipEvent>();
        public IReadOnlyList<ReplayCameraKey> CameraKeys => _keys;
        public RaceCameraRig CameraRig => _rig;

        private ReplayClip(RaceConfig config, ReplayClipOptions options, int focus, int start, int end, List<HorseState[]> states, RaceResult result, TrackVisual visual)
        {
            Config = config; Options = options; FocusSlot = focus; StartTick = start; EndTick = end; _states = states; Result = result;
            _msPerTick = 1000 / config.Net.TickHz;
            _rig = RaceCameraRig.For(config, visual);
            FocusPlace = Array.IndexOf(result.Order, focus) + 1;
            var last = states[states.Count - 1][focus];
            FocusTimeMs = FinishTimeMs(config, result, focus);
            FinishAtMs = last.Finished && last.FinishTick >= start ? (int)((last.FinishTick - start) * (long)_msPerTick + (long)last.FinishFracRaw * _msPerTick / 65536) : -1;
        }

        /// <summary>
        /// Re-simulate <paramref name="config"/> with <paramref name="inputs"/> and cut the clip for <paramref name="focusSlot"/>.
        /// <paramref name="expectedResultHash"/> (the live race's / server's hash) is checked when given: a replay that does not
        /// reproduce it (another engine version, a broken log) throws <see cref="InvalidOperationException"/> instead of
        /// sharing a different race.
        /// </summary>
        public static ReplayClip Build(RaceConfig config, IList<InputRecord> inputs, int focusSlot, ReplayClipOptions options = null,
            TrackVisual visual = null, string expectedResultHash = null)
        {
            if (config == null) throw new ArgumentNullException(nameof(config));
            if (inputs == null) throw new ArgumentNullException(nameof(inputs));
            options = options ?? new ReplayClipOptions();
            options.Validate();
            config.Validate();
            if (focusSlot < 0 || focusSlot >= config.Entrants.Count) throw new ArgumentException("focus slot out of range");
            int msPerTick = 1000 / config.Net.TickHz;
            var byTick = Index(config, inputs);

            // ---- pass 1: the window and the focus horse's skills
            var sim = new RaceSim(config);
            var cmds = new byte[config.Entrants.Count];
            long finalMm = options.FinalDistanceM * 1000L;
            int startAt = -1, eventIdx = 0;
            var skills = new List<SkillActivation>();
            while (!sim.IsFinished)
            {
                Step(sim, byTick, cmds);
                var me = sim.GetHorse(focusSlot);
                long rem = Math.Max(0, (sim.Track.Distance - me.Distance).ToMilli());
                if (startAt < 0 && me.Departed && rem <= finalMm) startAt = sim.Tick;
                for (; eventIdx < sim.Events.Count; eventIdx++)
                {
                    var e = sim.Events[eventIdx];
                    if (e.Type != RaceEventType.Skill || e.Slot != focusSlot) continue;
                    var k = sim.SkillOf(focusSlot);
                    skills.Add(new SkillActivation { SkillId = k?.Id, SkillName = k?.Name, Tick = e.Tick, RemainingM = (int)(rem / 1000), Place = e.Value + 1 });
                }
            }
            var result = sim.Result;
            if (expectedResultHash != null && !string.Equals(expectedResultHash, result.Hash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("replay does not reproduce the race (hash " + result.Hash + ", expected " + expectedResultHash + ")");
            int simEnd = sim.Tick; // states exist for 0..simEnd
            var focusFinal = sim.GetHorse(focusSlot);
            int end = focusFinal.Finished ? Math.Min(simEnd, focusFinal.FinishTick + 1 + (options.PostFinishMs + msPerTick - 1) / msPerTick) : simEnd;
            int maxTicks = options.MaxDurationMs / msPerTick;
            int start = startAt < 0 ? end - maxTicks : startAt;
            if (end - start > maxTicks) start = end - maxTicks;
            if (start < 0) start = 0;
            if (start >= end) start = Math.Max(0, end - 1);

            // ---- pass 2: keep every horse's state for StartTick..EndTick (the same deterministic run again)
            var sim2 = new RaceSim(config);
            var states = new List<HorseState[]>(end - start + 1);
            int n = config.Entrants.Count;
            while (true)
            {
                if (sim2.Tick >= start)
                {
                    var row = new HorseState[n];
                    for (int s = 0; s < n; s++) row[s] = sim2.GetHorse(s);
                    states.Add(row);
                }
                if (sim2.Tick >= end || sim2.IsFinished) break;
                Step(sim2, byTick, cmds);
            }
            if (sim2.Tick < end) end = sim2.Tick;
            var clip = new ReplayClip(config, options, focusSlot, start, end, states, result, visual);
            clip.FocusSkills.AddRange(skills);
            foreach (var e in sim2.Events)
            {
                if (e.Tick < start || e.Tick >= end) continue;
                if (e.Type != RaceEventType.Whip && e.Type != RaceEventType.Skill && e.Type != RaceEventType.Finish && e.Type != RaceEventType.LeaderChanged) continue;
                clip.Events.Add(new ReplayClipEvent { TimeMs = (e.Tick + 1 - start) * msPerTick, Type = e.Type, Slot = e.Slot, Value = e.Value });
            }
            clip.BuildCameraKeys();
            return clip;
        }

        private static SortedDictionary<int, List<InputRecord>> Index(RaceConfig config, IList<InputRecord> inputs)
        {
            var byTick = new SortedDictionary<int, List<InputRecord>>();
            foreach (var r in inputs)
            {
                if (r.Slot < 0 || r.Slot >= config.Entrants.Count) throw new ArgumentException("input slot out of range");
                if (r.Tick < 0 || r.Tick >= config.Ruleset.MaxTicks) throw new ArgumentException("input tick out of range");
                if (!byTick.TryGetValue(r.Tick, out var list)) byTick[r.Tick] = list = new List<InputRecord>();
                list.Add(r);
            }
            return byTick;
        }

        // the same stepping as RaceReplay.Run (Muchi.Engine/Replay.cs)
        private static void Step(RaceSim sim, SortedDictionary<int, List<InputRecord>> byTick, byte[] cmds)
        {
            Array.Clear(cmds, 0, cmds.Length);
            if (byTick.TryGetValue(sim.Tick, out var list)) foreach (var r in list) cmds[r.Slot] |= r.Cmd;
            sim.Step(cmds);
        }

        public static long FinishTimeMs(RaceConfig config, RaceResult result, int slot)
        {
            int place = Array.IndexOf(result.Order, slot);
            if (place < 0 || result.FinishTicks[place] < 0) return -1;
            int msPerTick = 1000 / config.Net.TickHz;
            return (long)(result.FinishTicks[place] - config.Ruleset.GateOpenTick) * msPerTick + result.FinishFracOrDistanceRaw[place] * msPerTick / 65536;
        }

        /// <summary>All horses at a tick of the window (null outside it).</summary>
        public HorseState[] StatesAt(int tick) => tick < StartTick || tick > EndTick ? null : _states[tick - StartTick];

        /// <summary>The frame at clip time <paramref name="timeMs"/> (clamped to the clip).</summary>
        public ReplayClipFrame FrameAt(int timeMs, int index = -1)
        {
            int t = Math.Max(0, Math.Min(DurationMs, timeMs));
            int whole = t / _msPerTick;
            int alpha = (t % _msPerTick) * 1000 / _msPerTick;
            int i = Math.Min(_states.Count - 1, whole + 1);
            int j = Math.Max(0, i - 1);
            if (whole + 1 > _states.Count - 1) alpha = 1000;
            var from = _states[j];
            var to = _states[i];
            var me0 = from[FocusSlot];
            var me1 = to[FocusSlot];
            double rem0 = Config.Track.DistanceM - TrackGeometry.DistanceM(me0.Distance), rem1 = Config.Track.DistanceM - TrackGeometry.DistanceM(me1.Distance);
            double rem = Math.Max(0, rem0 + (rem1 - rem0) * alpha / 1000.0);
            return new ReplayClipFrame
            {
                Index = index, TimeMs = t, Tick = StartTick + i - 1, AlphaPermille = alpha, From = from, To = to,
                Camera = _rig.Shot(me0, me1, alpha), FocusRemainingM = rem,
            };
        }

        /// <summary>Frame <paramref name="index"/> at <see cref="ReplayClipOptions.FramesPerSecond"/>.</summary>
        public ReplayClipFrame Frame(int index)
        {
            if (index < 0 || index >= FrameCount) throw new ArgumentOutOfRangeException(nameof(index));
            return FrameAt((int)((long)index * 1000 / Options.FramesPerSecond), index);
        }

        /// <summary>Every frame in order (what the recorder captures).</summary>
        public IEnumerable<ReplayClipFrame> Frames()
        {
            for (int i = 0; i < FrameCount; i++) yield return Frame(i);
        }

        /// <summary>Course-space pose of a horse in a frame (Unity converts it with CourseFrame like the live race).</summary>
        public TrackPose PoseOf(ReplayClipFrame f, int slot)
        {
            double a = f.AlphaPermille / 1000.0;
            var h0 = f.From[slot]; var h1 = f.To[slot];
            int lw = Config.Ruleset.LaneWidthMm;
            double d = TrackGeometry.DistanceM(h0.Distance) + (TrackGeometry.DistanceM(h1.Distance) - TrackGeometry.DistanceM(h0.Distance)) * a;
            double l = TrackGeometry.LateralM(h0.Lane, lw) + (TrackGeometry.LateralM(h1.Lane, lw) - TrackGeometry.LateralM(h0.Lane, lw)) * a;
            return _rig.Geometry.PoseAt(d, l);
        }

        private void BuildCameraKeys()
        {
            int step = Options.CameraKeyIntervalMs;
            RaceCameraMode? last = null;
            for (int t = 0; t <= DurationMs; t += 16)
            {
                var f = FrameAt(t);
                bool onGrid = t % step < 16;
                if (onGrid || last != f.Camera.Mode || t + 16 > DurationMs) _keys.Add(new ReplayCameraKey { TimeMs = t, Shot = f.Camera });
                last = f.Camera.Mode;
            }
            if (_keys.Count == 0 || _keys[_keys.Count - 1].TimeMs != DurationMs) _keys.Add(new ReplayCameraKey { TimeMs = DurationMs, Shot = FrameAt(DurationMs).Camera });
        }
    }

    /// <summary>
    /// What the share image / the video's end card shows (REQ-UXS-071): place, time, the chosen horse's name, the course,
    /// the focus horse's skill activations and the watermark (the game title). Nothing else about the player: no player
    /// id, jockey/display name, friend or rival player names, class or rating. Text is built here, the screen only lays it out.
    /// </summary>
    public sealed class ShareCard
    {
        /// <summary>The watermark (06 §7.3: the title). Not localised.</summary>
        public const string GameTitle = "ムチ一閃";
        public const string Hashtag = "#ムチ一閃";

        public string Watermark = GameTitle;
        public int Place, Runners;
        /// <summary>「1着」「3着 / 12頭」, 「完走ならず」 for a DNF.</summary>
        public string PlaceText;
        public long TimeMs = -1;
        /// <summary>m:ss.f (HudModel.FormatTime), "—" for a DNF.</summary>
        public string TimeText;
        public string HorseName;
        public string CourseName;
        /// <summary>「ランク戦」「タイムアタック」…, null when not shown.</summary>
        public string ModeLabel;
        /// <summary>「固有スキル「末脚」 残り320m」 lines, in firing order.</summary>
        public List<string> SkillLines = new List<string>();
        /// <summary>One line for the OS share sheet (no URL: the store link is added by the Unity side if wanted).</summary>
        public string ShareText;
        /// <summary>analytics `share` kind: replay_video or replay_image.</summary>
        public string Kind = "replay_video";
        /// <summary>REQ-PHOTO-009: photo mode overlays (look, frame, stamps, caption, name plates); null for a replay share.</summary>
        public PhotoOverlay Photo;

        public static string FormatTime(long ms)
        {
            if (ms < 0) return "—";
            long tenths = ms / 100;
            return (tenths / 600) + ":" + (tenths / 10 % 60).ToString("00") + "." + (tenths % 10);
        }

        /// <summary>A course label from the spec when the app has no display name: 「芝2000m」/「ダート1400m」.</summary>
        public static string CourseLabel(TrackSpec track) => (track.Surface == Surface.Dirt ? "ダート" : "芝") + track.DistanceM + "m";

        public static string ModeText(RaceMode mode)
        {
            switch (mode)
            {
                case RaceMode.Ranked: return "ランク戦";
                case RaceMode.Friend: return "フレンド戦";
                case RaceMode.TimeAttack: return "タイムアタック";
                case RaceMode.Event: return "イベント";
                case RaceMode.Tournament: return "大会";
                case RaceMode.Challenge: return "週替わりチャレンジ";
                default: return null;
            }
        }

        /// <param name="courseName">Display name of the course (server tracks.json name); null → <see cref="CourseLabel"/>.</param>
        public static ShareCard Build(ReplayClip clip, string courseName = null)
        {
            if (clip == null) throw new ArgumentNullException(nameof(clip));
            var cfg = clip.Config;
            var c = new ShareCard
            {
                Place = clip.FocusPlace, Runners = cfg.Entrants.Count, TimeMs = clip.FocusTimeMs,
                HorseName = cfg.Entrants[clip.FocusSlot].Horse?.Name ?? "",
                CourseName = string.IsNullOrEmpty(courseName) ? CourseLabel(cfg.Track) : courseName,
                ModeLabel = ModeText(cfg.Mode),
            };
            bool finished = clip.FocusTimeMs >= 0;
            bool solo = c.Runners <= 1; // time attack: a place out of 1 means nothing
            c.PlaceText = !finished ? "完走ならず" : solo ? "完走" : c.Place + "着 / " + c.Runners + "頭";
            c.TimeText = FormatTime(clip.FocusTimeMs);
            foreach (var s in clip.FocusSkills)
                c.SkillLines.Add("固有スキル「" + (s.SkillName ?? s.SkillId) + "」 残り" + s.RemainingM + "m");
            string head = !finished ? c.HorseName + "　" + c.CourseName : solo ? c.HorseName + "　" + c.CourseName + "　" + c.TimeText
                : c.HorseName + "　" + c.CourseName + "　" + c.Place + "着　" + c.TimeText;
            c.ShareText = head + "　" + Hashtag;
            return c;
        }
    }
}
