// Race feel and result checks (docs/planning/06 §2.3, §6.3, §6.4): the tutorial's win rule through the app's glue
// (REQ-UXS-004), the HUD race-feel fields (stamina warnings, the one-time whip cue, slipstream, kakari), the camera
// keeping the partner in frame, and the result model's debrief line (REQ-UXS-005).
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class RaceFeelChecks
{
    /// <summary>Drives a race frame by frame like the race screen (16 ms frames), whipping at the given remaining metres.</summary>
    static (HudSnapshot last, List<HudSnapshot> frames, RaceObserver obs) Drive(IRaceDriver d, int[] whipAtM, CourseFrame frame = null, Action<RaceObserver, long> perFrame = null)
    {
        var obs = new RaceObserver(d);
        var input = new RaceInput();
        var frames = new List<HudSnapshot>();
        long now = 2_000_000;
        int k = 0;
        for (int f = 0; f < 60 * 300 && !d.Done; f++)
        {
            var sim = d.Sim;
            if (sim != null && d.PlayerSlot >= 0)
            {
                var me = sim.GetHorse(d.PlayerSlot);
                long rem = (sim.Track.Distance - me.Distance).ToMilli();
                if (!me.Departed && sim.GateOpened) input.Spur();
                else if (me.Departed && k < whipAtM.Length && rem <= whipAtM[k] * 1000L) { input.Spur(); k++; }
                d.Input(input.Collect(me));
            }
            d.Update(now);
            frames.Add(obs.Hud(now));
            perFrame?.Invoke(obs, now);
            now += 16;
        }
        return (frames.Count > 0 ? frames[^1] : null, frames, obs);
    }

    public static void Run(Action<bool, string> check, RulesetParams ruleset)
    {
        // ---- REQ-UXS-004 through GameBackend: attempts are counted on the device, the 3rd is assisted
        var kv = new MemoryKeyValueStore();
        var backend = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, kv, ruleset);
        var table = new (int[] whips, int place)[] { (new int[0], 2), (new[] { 220 }, 2), (new int[0], 1) };
        for (int attempt = 1; attempt <= 3; attempt++)
        {
            var d = backend.CreateTutorialRace();
            var (last, _, obs) = Drive(d, table[attempt - 1].whips);
            var result = RaceResultModel.Build(d, obs);
            check(d.Done && result.Place == table[attempt - 1].place && backend.TutorialAttempts == attempt,
                "tutorial attempt " + attempt + " with " + table[attempt - 1].whips.Length + " whip(s) → place " + result.Place + " (expected " + table[attempt - 1].place + ")");
            if (attempt == 1)
                check(result.TutorialRetry && result.PrimaryAction == "もう一度" && result.NextTutorialAttempt == 2 && result.DebriefLine == "ムチを使わなかった",
                    "tutorial loss: 「もう一度」 is the main button, next attempt 2, line: " + result.DebriefLine + " / tip: " + result.DebriefTip);
            if (attempt == 3)
                check(result.Won && result.Headline == "差し切った！" && result.PrimaryAction == "相棒に名前をつける" && !result.TutorialRetry,
                    "3rd attempt is assisted to a win: " + result.Headline + " / " + result.DebriefLine);
            obs.Dispose();
        }
        var win = backend.CreateTutorialRace(1);
        var (_, winFrames, winObs) = Drive(win, new[] { 260, 180 });
        var won = RaceResultModel.Build(win, winObs);
        check(won.Won && won.Place == 1 && won.DebriefLine == "残り250mのムチで差し切った" && won.Reason == DebriefReason.WinWhipFinish,
            "two whips in the last 300 m win; result line: " + won.DebriefLine + " / tip: " + won.DebriefTip);
        check(won.Rows.Count == 8 && won.Rows[0].IsPlayer && won.Rows.Count(r => r.IsPlayer) == 1 && won.Rows[1].Margin.Length > 0,
            "result table: 8 rows, the player's row marked, margins in racing terms (2nd: " + won.Rows[1].Margin + ")");
        // quality pass 2 (docs/quality/ranked.md §4): the horse-or-riding line is for ranked losses only
        var savedMode = win.Config.Mode;
        win.Config.Mode = RaceMode.Ranked;
        var fc = RankedFieldCheck.For(win.Config, win.PlayerSlot, 2);
        win.Config.Mode = savedMode;
        check(won.FieldLine == null && fc != null && fc.Line.Contains("相棒 " + fc.HorseTotal) && RankedFieldCheck.For(win.Config, win.PlayerSlot, 2) == null,
            "result: no horse-or-riding line outside ranked; on a ranked loss: " + fc?.Line);
        check(win is OfflineRaceDriver ow && RaceReplayHash(ow) == win.Sim.Result.Hash, "tutorial (player + rival director) replays from AllInputs to the same hash");

        // ---- HUD: the whip cue is only in the window, never from the gate
        var cueFrames = winFrames.Where(h => h.WhipChance).ToList();
        check(cueFrames.Count > 0 && cueFrames.All(h => h.RemainingM <= 300 && h.RemainingM >= 255) && winFrames.Count(h => h.Cues.Any(c => c.Kind == RaceFeelCueKind.WhipChance)) == 1,
            "「今だ、ムチ！」 lights once, only from 300 m to the first whip (" + cueFrames.Count + " frames, " + (cueFrames.Count > 0 ? cueFrames.Max(h => h.RemainingM) + "→" + cueFrames.Min(h => h.RemainingM) + " m" : "-") + ")");
        check(winFrames.Where(h => h.WhipChance).All(h => h.Hint == RaceFeel.TextWhipChance), "the HUD hint during the cue is 「今だ、ムチ！」");
        var pre = winFrames.Where(h => h.HasRace && !h.GateOpen).ToList();
        check(pre.Count > 0 && pre.All(h => !h.RankKnown && !h.WhipChance), "before the gate: rank shown as 「—」 (RankKnown false) and no cue");
        winObs.Dispose();

        // ---- HUD: stamina thresholds 30 / 10 / 0 % and runaway on a long race with a weak stayer
        var weak = RaceFactory.DefaultPartner("テスト"); weak.Stamina = 0;
        var practice = new OfflineRaceDriver(RaceFactory.Practice(ruleset, weak, 7), 0, autoStart: true);
        var (_, pf, pobs) = Drive(practice, new[] { 300, 250, 200 });
        var kinds = pobs.Feel.Cues.Select(c => c.Kind).Where(k => k <= RaceFeelCueKind.StaminaEmpty).ToList();
        check(kinds.SequenceEqual(new[] { RaceFeelCueKind.StaminaLow, RaceFeelCueKind.StaminaCritical, RaceFeelCueKind.StaminaEmpty }),
            "stamina warnings fire once each, in order: " + string.Join(", ", kinds));
        check(pf.Any(h => h.Stamina == StaminaWarning.Low) && pf.Any(h => h.StaminaBlink) && pf.Any(h => h.Stamina == StaminaWarning.Empty && h.Hint == RaceFeel.TextStaminaEmpty),
            "HUD gauge: yellow at 30 %, red + blink at 10 %, 「脚が上がった」 at 0");
        check(pf.Any(h => h.RunawayWarning), "runaway warning when burning stamina faster than the distance left");
        var pr = RaceResultModel.Build(practice, pobs);
        check(pr.HasResult && pr.DebriefLine != null && (pr.Won == (pr.Reason.HasValue && (int)pr.Reason.Value < 200)),
            "practice result: the line agrees with the place (" + pr.Place + "着: " + pr.DebriefLine + " / " + pr.DebriefTip + ")");
        pobs.Dispose();

        // ---- HUD: kakari warning (temperamental horse, rein never used) and slipstream on a full field
        var hot = RaceFactory.DefaultPartner("カカリ"); hot.Temper = 0;
        var cfg = RaceFactory.Practice(OfflinePresets.Override(ruleset, ("kakariChancePer100000PerTickAtTemper0", 2000)), hot, 11);
        var kd = new OfflineRaceDriver(cfg, 0, autoStart: true);
        var (_, kf, kobs) = Drive(kd, new int[0]);
        check(kf.Any(h => h.KakariWarning && h.Hint == RaceFeel.TextKakari) && kobs.Feel.Cues.Count(c => c.Kind == RaceFeelCueKind.Kakari) == 1,
            "kakari: 「掛かっている：手綱を長押し」 while pulling unreined, raised once");
        bool anySlip = kf.Any(h => h.Slipstream) || pf.Any(h => h.Slipstream);
        check(anySlip, "slipstream flag is set while drafting in a 12-runner field");
        kobs.Dispose();

        // ---- camera keeps the partner in frame (2000 m course with corners, both directions)
        foreach (var left in new[] { true, false })
        {
            var cd = new OfflineRaceDriver(RaceFactory.Practice(ruleset, RaceFactory.DefaultPartner("カメラ"), 3), 0, autoStart: true);
            var visuals = cd.Visuals; // the same descriptors the observer's camera rig reads
            if (visuals.Track != null) visuals.Track.Direction = left ? "left" : "right";
            var frame = CourseFrame.For(cd.Config, visuals);
            bool allIn = true; int shots = 0; var modes = new HashSet<RaceCameraMode>(); string bad = null;
            Drive(cd, new[] { 400, 350, 300 }, frame, (obs, now) =>
            {
                var shot = obs.CameraShot(frame, now);
                if (shot == null || !cd.TryGetRender(0, now, out var from, out var to, out var a)) return;
                var horse = frame.Horse(from, to, a);
                bool ok = InFrame(shot.Value, horse, 1.2);
                if (!ok && bad == null) bad = shot.Value.Mode + " cam (" + shot.Value.Position + ") horse " + horse;
                allIn &= ok; shots++; modes.Add(shot.Value.Mode);
            });
            check(allIn && shots > 1000 && modes.Contains(RaceCameraMode.FinalStraight) && modes.Contains(RaceCameraMode.Finish),
                "camera keeps the partner in frame every frame (" + (left ? "left" : "right") + "-handed, " + shots + " frames, modes " + string.Join("/", modes) + ")" + (bad != null ? " first miss: " + bad : ""));
        }
    }

    static string RaceReplayHash(OfflineRaceDriver d) => RaceReplay.Run(d.Config, d.Race.AllInputs()).Result.Hash;

    /// <summary>The world-space version of RaceCameraRig.InFrame (16:9, 10 % margin).</summary>
    static bool InFrame(WorldCameraShot s, WorldPose subject, double height)
    {
        double lx = s.LookAt.X - s.Position.X, lz = s.LookAt.Z - s.Position.Z, ly = s.LookAtHeight - s.Height;
        double sx = subject.X - s.Position.X, sz = subject.Z - s.Position.Z, sy = height - s.Height;
        double lh = Math.Sqrt(lx * lx + lz * lz), sh = Math.Sqrt(sx * sx + sz * sz);
        if (lh < 1e-6 || sh < 1e-6) return false;
        double yaw = Math.Acos(Math.Clamp((lx * sx + lz * sz) / (lh * sh), -1, 1));
        double pitch = Math.Abs(Math.Atan2(sy, sh) - Math.Atan2(ly, lh));
        double v = s.FieldOfViewDegrees * Math.PI / 360, h = Math.Atan(Math.Tan(v) * 16 / 9);
        return yaw <= h * 0.9 && pitch <= v * 0.9;
    }
}
