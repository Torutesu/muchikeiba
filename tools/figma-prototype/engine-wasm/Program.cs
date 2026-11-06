// Browser entry for the web prototype: the same OfflineRaceDriver / RaceInput / HudModel / CommentaryFeed path that
// unity/Assets/Muchi/Runtime/MuchiApp.cs uses in Unity, exported to JavaScript.
using System;
using System.Globalization;
using System.Runtime.InteropServices.JavaScript;
using System.Text;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

public static partial class Program
{
    public static void Main() { }
}

public static partial class MuchiRace
{
    private static RulesetParams _ruleset;
    private static CommentaryTemplates _templates;
    private static OfflineRaceDriver _driver;
    private static CommentaryFeed _commentary;
    private static TrackGeometry _geo;
    private static CourseFrame _frame;
    private static double _xShift;
    private static readonly RaceInput _input = new RaceInput();
    private static string _subtitle = "";
    private static RaceObserver _obs;
    private static TutorialDirector _director;
    private static int _eventIdx;
    private static string _mode = "";
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    [JSExport]
    public static string Init(string rulesetJson, string commentaryJson)
    {
        _ruleset = RaceFactory.ParseRuleset(rulesetJson);
        _templates = CommentaryTemplates.Parse(commentaryJson);
        return _ruleset.RulesetVersion;
    }

    /// <summary>mode "tutorial" = OfflinePresets tutorial (starts near the finish); otherwise the 12-runner 2000 m practice race.</summary>
    [JSExport]
    public static string Start(string mode, string partnerName, string partnerJson, double seed)
    {
        RaceConfig cfg;
        if (mode == "tutorial") cfg = RaceFactory.Tutorial(_ruleset);
        else
        {
            var p = RaceFactory.DefaultPartner(partnerName);
            if (!string.IsNullOrEmpty(partnerJson))
            {
                var j = Muchi.Net.JsonNode.Parse(partnerJson);
                p.Speed = j.Get("speed").AsInt(); p.Stamina = j.Get("stamina").AsInt(); p.Burst = j.Get("burst").AsInt();
                p.Guts = j.Get("guts").AsInt(); p.Temper = j.Get("temper").AsInt();
                p.Style = RaceFactory.StyleOf(j.Get("style").AsString());
                p.DistMinM = j.Get("distMinM").AsInt(); p.DistMaxM = j.Get("distMaxM").AsInt();
            }
            cfg = RaceFactory.Practice(_ruleset, p, (ulong)seed);
        }
        return Begin(mode, new OfflineRaceDriver(cfg, 0, true));
    }

    /// <summary>
    /// The tutorial with its TutorialDirector (REQ-UXS-004): rival on slot 1, whip-only controls; 2+ counted whips in the
    /// last 300 m win, 0-1 give a close 2nd, attempt 3+ is assisted. <paramref name="attempt"/> is 1-based.
    /// </summary>
    [JSExport]
    public static string StartTutorial(int attempt)
    {
        var race = OfflinePresets.TutorialRace(_ruleset, Math.Max(1, attempt));
        return Begin("tutorial", new OfflineRaceDriver(race));
    }

    /// <summary>A race from a server-built RaceStartConfig (server/src/domain/raceConfig.ts buildRaceConfig), ridden by <paramref name="playerId"/>.</summary>
    [JSExport]
    public static string StartConfig(string configJson, string playerId)
    {
        var cfg = Muchi.Net.ProtocolCodec.ParseConfig(configJson);
        int slot = 0;
        foreach (var e in cfg.Entrants) if (e.Kind == EntrantKind.Human && e.PlayerId == playerId) { slot = e.Slot; break; }
        return Begin("config", new OfflineRaceDriver(cfg, slot, false)); // the player presses START (late = 出遅れ)
    }

    private static string Begin(string mode, OfflineRaceDriver driver)
    {
        _obs?.Dispose();
        _driver = driver;
        _mode = mode;
        var cfg = driver.Config;
        _director = driver.Race.Director as TutorialDirector;
        _obs = new RaceObserver(_driver);
        _eventIdx = 0;
        _commentary = new CommentaryFeed(_templates, cfg, driver.PlayerSlot);
        _geo = TrackGeometry.For(cfg);
        _input.Reset();
        _subtitle = "";
        var sb = new StringBuilder();
        sb.Append("{\"mode\":\"").Append(mode).Append("\",\"distanceM\":").Append(cfg.Track.DistanceM)
          .Append(",\"trackId\":\"").Append(Esc(cfg.Track.Id)).Append("\",\"playerSlot\":").Append(driver.PlayerSlot)
          .Append(",\"tutorialAttempt\":").Append(_director?.Attempt ?? 0).Append(",\"rivalSlot\":").Append(_director?.RivalSlot ?? -1)
          .Append(",\"surface\":\"").Append(cfg.Track.Surface == Surface.Dirt ? "dirt" : "turf").Append("\",\"laneCount\":").Append(cfg.Ruleset.LaneCount)
          .Append(",\"laneWidthM\":").Append(F(cfg.Ruleset.LaneWidthMm / 1000.0)).Append(",\"names\":[");
        for (int i = 0; i < cfg.Entrants.Count; i++) { if (i > 0) sb.Append(','); sb.Append('"').Append(Esc(cfg.Entrants[i].Horse.Name)).Append('"'); }
        sb.Append("],\"skills\":[");
        for (int i = 0; i < cfg.Entrants.Count; i++)
        {
            if (i > 0) sb.Append(',');
            var k = driver.Sim.SkillOf(i);
            if (k == null) sb.Append("null"); else sb.Append("{\"id\":\"").Append(Esc(k.Id)).Append("\",\"name\":\"").Append(Esc(k.Name)).Append("\"}");
        }
        // RaceWorld.StartRace: CourseFrame (finish at z=420 facing +Z), straight courses reuse the Greenfield straight
        // with the field centred between its rails (xShift); bends get the generated course (BuildCourse).
        var visuals = _driver.Visuals;
        _frame = CourseFrame.For(cfg, visuals);
        bool straight = cfg.Track.Segments.TrueForAll(s => s.Kind == SegmentKind.Straight);
        _xShift = straight ? -(_frame.LaneCount * _frame.LaneWidthMm / 1000.0) / 2 : 0;
        sb.Append("],\"world\":{\"straight\":").Append(B(straight)).Append(",\"xShift\":").Append(F(_xShift))
          .Append(",\"outsideSign\":").Append(F(_frame.OutsideSign)).Append(",\"night\":").Append(B(visuals?.Track != null && visuals.Track.Night))
          .Append(",\"innerRailM\":").Append(F(CourseFrame.InnerRailM)).Append(",\"outerRailM\":").Append(F(_frame.OuterRailM));
        var b = _frame.Bounds();
        sb.Append(",\"bounds\":[").Append(F(b.minX)).Append(',').Append(F(b.minZ)).Append(',').Append(F(b.maxX)).Append(',').Append(F(b.maxZ)).Append(']');
        double mid = (CourseFrame.InnerRailM + _frame.OuterRailM) / 2;
        sb.Append(",\"surface\":"); Line(sb, _frame.Line(mid, 8));
        sb.Append(",\"inner\":"); Line(sb, _frame.Line(CourseFrame.InnerRailM, 10));
        sb.Append(",\"outer\":"); Line(sb, _frame.Line(_frame.OuterRailM, 10));
        sb.Append(",\"entrants\":[");
        for (int i = 0; i < cfg.Entrants.Count; i++)
        {
            var e = visuals?.ForSlot(i);
            if (i > 0) sb.Append(',');
            sb.Append("{\"coat\":\"").Append(Esc(e?.Appearance?.Coat)).Append("\",\"mane\":\"").Append(Esc(e?.Appearance?.Mane)).Append("\",\"colors\":[");
            if (e?.Silks?.Colors != null) for (int c = 0; c < e.Silks.Colors.Length; c++) { if (c > 0) sb.Append(','); sb.Append('"').Append(Esc(e.Silks.Colors[c])).Append('"'); }
            sb.Append("]}");
        }
        sb.Append("]}");
        sb.Append("}");
        return sb.ToString();
    }

    [JSExport] public static void Lane(int dir) => _input.Lane(dir);
    [JSExport] public static void Spur() => _input.Spur();
    [JSExport] public static void Rein(bool held) => _input.SetRein(held);

    /// <summary>One frame: collect input (as MuchiApp.Update does), advance the race to nowMs, return HUD + interpolated poses.</summary>
    [JSExport]
    public static string Frame(double nowMs)
    {
        if (_driver == null) return "{}";
        long now = (long)nowMs;
        if (_driver.Sim != null) _driver.Input(_input.Collect(_driver.Sim.GetHorse(_driver.PlayerSlot)));
        _driver.Update(now);
        var hud = _obs.Hud(now);
        if (_driver.Sim != null) { var s = _commentary.Update(_driver.Sim); if (s != null) _subtitle = s; }
        var sb = new StringBuilder(2048);
        sb.Append("{\"tick\":").Append(_driver.Sim.Tick).Append(",\"rank\":").Append(hud.Rank).Append(",\"runners\":").Append(hud.Runners)
          .Append(",\"remainingM\":").Append(hud.RemainingM).Append(",\"distanceM\":").Append(hud.DistanceM)
          .Append(",\"stamina\":").Append(hud.StaminaPermille).Append(",\"whips\":").Append(hud.WhipsLeft).Append(",\"maxWhips\":").Append(hud.MaxWhips)
          .Append(",\"kakari\":").Append(B(hud.Kakari)).Append(",\"reining\":").Append(B(hud.Reining)).Append(",\"spurt\":").Append(B(hud.Spurt))
          .Append(",\"departed\":").Append(B(hud.Departed)).Append(",\"finished\":").Append(B(hud.Finished)).Append(",\"gateOpen\":").Append(B(hud.GateOpen))
          .Append(",\"gateTicks\":").Append(hud.GateCountdownTicks).Append(",\"elapsedMs\":").Append(hud.ElapsedMs)
          .Append(",\"finishPlace\":").Append(hud.FinishPlace).Append(",\"done\":").Append(B(_driver.Done))
          .Append(",\"playerSlot\":").Append(_driver.PlayerSlot).Append(",\"rankKnown\":").Append(B(hud.RankKnown))
          .Append(",\"time\":\"").Append(HudModel.FormatTime(hud.ElapsedMs)).Append("\",\"subtitle\":\"").Append(Esc(_subtitle)).Append("\",\"progress\":[");
        for (int i = 0; i < hud.Progress.Length; i++) { if (i > 0) sb.Append(','); sb.Append(F(hud.Progress[i])); }
        sb.Append(']');
        AppendFeel(sb, hud, now);
        sb.Append(",\"horses\":[");
        int n = _driver.Config.Entrants.Count, laneW = _driver.Config.Ruleset.LaneWidthMm;
        for (int i = 0; i < n; i++)
        {
            // RaceWorld.Present: frame.Horse(from, to, alpha), then x + xShift
            double x = 0, z = 0, yaw = 0; bool whip = false, run = false; bool ok = false;
            if (_driver.TryGetRender(i, now, out var from, out var to, out int a))
            {
                var p = _frame.Horse(from, to, a);
                x = p.X + _xShift; z = p.Z; yaw = p.YawDegrees; whip = to.IsWhipActive; run = to.Departed && !to.Finished; ok = true;
            }
            if (i > 0) sb.Append(',');
            sb.Append('[').Append(F(x)).Append(',').Append(F(z)).Append(',').Append(F(yaw)).Append(',').Append(_driver.Sim.GetHorse(i).Rank).Append(',').Append(B(whip)).Append(',').Append(B(run)).Append(',').Append(B(ok)).Append(']');
        }
        sb.Append(']');
        if (_driver.Done && _driver.Sim?.Result != null)
        {
            var res = _driver.Sim.Result;
            sb.Append(",\"order\":[").Append(string.Join(",", res.Order)).Append("],\"hash\":\"").Append(res.Hash).Append('"');
            // per place: finish tick (-1 = did not finish) and margin to the previous place in meters (web result table)
            sb.Append(",\"tickHz\":").Append(_driver.Config.Net.TickHz).Append(",\"finishTicks\":[").Append(string.Join(",", res.FinishTicks)).Append("],\"margins\":[");
            for (int i = 0; i < res.Margins.Length; i++) { if (i > 0) sb.Append(','); sb.Append(F(res.Margins[i].Raw / (double)Fx.OneRaw)); }
            sb.Append(']');
            AppendResult(sb);
        }
        sb.Append('}');
        return sb.ToString();
    }

    /// <summary>Race feel (RaceFeelTracker via RaceObserver/HudModel), skill activations (engine Skill events), tutorial director state and the camera rig shot.</summary>
    private static void AppendFeel(StringBuilder sb, HudSnapshot hud, long now)
    {
        sb.Append(",\"feel\":{\"level\":\"").Append(hud.Stamina.ToString()).Append("\",\"blink\":").Append(B(hud.StaminaBlink))
          .Append(",\"whipChance\":").Append(B(hud.WhipChance)).Append(",\"slipstream\":").Append(B(hud.Slipstream))
          .Append(",\"kakariWarning\":").Append(B(hud.KakariWarning)).Append(",\"runaway\":").Append(B(hud.RunawayWarning))
          .Append(",\"mashed\":").Append(B(hud.WhipMashed)).Append(",\"whipActive\":").Append(B(hud.WhipActive)).Append(",\"blocked\":").Append(B(hud.Blocked))
          .Append(",\"gapAhead\":\"").Append(hud.GapAheadMm < 0 ? "" : Esc(RaceFeel.MarginText(hud.GapAheadMm)))
          .Append("\",\"gapAheadMm\":").Append(hud.GapAheadMm).Append(",\"gapBehindMm\":").Append(hud.GapBehindMm)
          .Append(",\"hint\":\"").Append(Esc(hud.Hint)).Append("\",\"cues\":[");
        for (int i = 0; i < hud.Cues.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"kind\":\"").Append(hud.Cues[i].Kind.ToString()).Append("\",\"text\":\"").Append(Esc(hud.Cues[i].Text)).Append("\"}");
        }
        sb.Append("]}");
        var sim = _driver.Sim;
        int ps = _driver.PlayerSlot;
        var mySkill = sim.SkillOf(ps);
        var me = sim.GetHorse(ps);
        sb.Append(",\"skill\":{\"name\":\"").Append(Esc(mySkill?.Name)).Append("\",\"used\":").Append(B(me.SkillUsed)).Append(",\"active\":").Append(B(me.IsSkillActive))
          .Append(",\"ticksLeft\":").Append(me.SkillTicksLeft).Append("},\"skillEvents\":[");
        var evs = sim.Events;
        bool first = true;
        for (; _eventIdx < evs.Count; _eventIdx++)
        {
            var e = evs[_eventIdx];
            if (e.Type != RaceEventType.Skill) continue;
            var k = sim.SkillOf(e.Slot);
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"slot\":").Append(e.Slot).Append(",\"tick\":").Append(e.Tick).Append(",\"rank\":").Append(e.Value + 1)
              .Append(",\"name\":\"").Append(Esc(k?.Name)).Append("\",\"horse\":\"").Append(Esc(_driver.Config.Entrants[e.Slot].Horse.Name)).Append("\"}");
        }
        sb.Append(']');
        if (_director != null)
            sb.Append(",\"tutorial\":{\"attempt\":").Append(_director.Attempt).Append(",\"countedWhips\":").Append(_director.CountedWhips)
              .Append(",\"qualified\":").Append(B(_director.Qualified)).Append(",\"assisted\":").Append(B(_director.Assisted))
              .Append(",\"outcome\":\"").Append(_director.Outcome.ToString()).Append("\",\"windowM\":").Append(TutorialDirector.WhipWindowM).Append('}');
        var shot = _obs.CameraShot(_frame, now);
        if (shot.HasValue)
        {
            var c = shot.Value;
            sb.Append(",\"cam\":[").Append(F(c.Position.X + _xShift)).Append(',').Append(F(c.Height)).Append(',').Append(F(c.Position.Z)).Append(',')
              .Append(F(c.LookAt.X + _xShift)).Append(',').Append(F(c.LookAtHeight)).Append(',').Append(F(c.LookAt.Z)).Append(',').Append(F(c.FieldOfViewDegrees))
              .Append(",\"").Append(c.Mode.ToString()).Append("\"]");
        }
    }

    /// <summary>RaceResultModel (06 §6.4): headline, the debrief line and tip (RaceDebrief, REQ-UXS-005), result rows with margins, tutorial retry.</summary>
    private static void AppendResult(StringBuilder sb)
    {
        var m = RaceResultModel.Build(_driver, _obs);
        var d = _obs.Debrief();
        sb.Append(",\"result\":{\"place\":").Append(m.Place).Append(",\"runners\":").Append(m.Runners).Append(",\"won\":").Append(B(m.Won))
          .Append(",\"time\":\"").Append(Esc(m.TimeText)).Append("\",\"headline\":\"").Append(Esc(m.Headline))
          .Append("\",\"line\":\"").Append(Esc(m.DebriefLine)).Append("\",\"tip\":\"").Append(Esc(m.DebriefTip))
          .Append("\",\"code\":\"").Append(Esc(m.DebriefCode)).Append("\",\"reason\":\"").Append(m.Reason?.ToString() ?? "")
          .Append("\",\"marginMm\":").Append(d?.MarginMm ?? 0).Append(",\"margin\":\"").Append(d == null ? "" : Esc(RaceFeel.MarginText(d.MarginMm)))
          .Append("\",\"primary\":\"").Append(Esc(m.PrimaryAction)).Append("\",\"secondary\":\"").Append(Esc(m.SecondaryAction))
          .Append("\",\"tutorialRetry\":").Append(B(m.TutorialRetry)).Append(",\"nextAttempt\":").Append(m.NextTutorialAttempt);
        if (d != null)
        {
            var f = d.Facts;
            sb.Append(",\"facts\":{\"whips\":").Append(f.WhipCount).Append(",\"earlyWhips\":").Append(f.EarlyWhips).Append(",\"mashed\":").Append(f.MashedWhips)
              .Append(",\"passes\":").Append(f.PassesMade).Append(",\"kakari\":").Append(f.KakariCount).Append(",\"lateStart\":").Append(B(f.LateStart))
              .Append(",\"slipstreamTicks\":").Append(f.SlipstreamTicks).Append(",\"staminaEmptyM\":").Append(f.StaminaEmptyRemainingMm < 0 ? -1 : f.StaminaEmptyRemainingMm / 1000).Append('}');
        }
        sb.Append(",\"rows\":[");
        for (int i = 0; i < m.Rows.Count; i++)
        {
            var r = m.Rows[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"place\":").Append(r.Place).Append(",\"slot\":").Append(r.Slot).Append(",\"name\":\"").Append(Esc(r.Name))
              .Append("\",\"margin\":\"").Append(Esc(r.Margin)).Append("\",\"player\":").Append(B(r.IsPlayer)).Append('}');
        }
        sb.Append("]}");
    }

    /// <summary>Re-run a golden race file ({log, expected}) in WebAssembly and return the result hash (must equal expected.resultHash).</summary>
    [JSExport]
    public static string ReplayGolden(string goldenJson)
    {
        var g = Muchi.Net.JsonNode.Parse(goldenJson);
        var log = Muchi.Net.ProtocolCodec.ParseReplayLog(g.Get("log"));
        var outp = RaceReplay.Run(log.Config, log.Inputs);
        return outp.Result.Hash;
    }

    private static void Line(StringBuilder sb, System.Collections.Generic.List<WorldPose> line)
    {
        sb.Append('[');
        for (int i = 0; i < line.Count; i++) { if (i > 0) sb.Append(','); sb.Append('[').Append(F(line[i].X)).Append(',').Append(F(line[i].Z)).Append(']'); }
        sb.Append(']');
    }

    private static string F(double v) => v.ToString("0.###", Inv);
    private static string B(bool b) => b ? "true" : "false";
    private static string Esc(string s) => (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n");
}
