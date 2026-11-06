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
        _driver = new OfflineRaceDriver(cfg, 0, true);
        _commentary = new CommentaryFeed(_templates, cfg, 0);
        _geo = TrackGeometry.For(cfg);
        _input.Reset();
        _subtitle = "";
        var sb = new StringBuilder();
        sb.Append("{\"mode\":\"").Append(mode).Append("\",\"distanceM\":").Append(cfg.Track.DistanceM)
          .Append(",\"surface\":\"").Append(cfg.Track.Surface == Surface.Dirt ? "dirt" : "turf").Append("\",\"laneCount\":").Append(cfg.Ruleset.LaneCount)
          .Append(",\"laneWidthM\":").Append(F(cfg.Ruleset.LaneWidthMm / 1000.0)).Append(",\"names\":[");
        for (int i = 0; i < cfg.Entrants.Count; i++) { if (i > 0) sb.Append(','); sb.Append('"').Append(Esc(cfg.Entrants[i].Horse.Name)).Append('"'); }
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
        var hud = HudModel.Build(_driver, now);
        if (_driver.Sim != null) { var s = _commentary.Update(_driver.Sim); if (s != null) _subtitle = s; }
        var sb = new StringBuilder(2048);
        sb.Append("{\"rank\":").Append(hud.Rank).Append(",\"runners\":").Append(hud.Runners)
          .Append(",\"remainingM\":").Append(hud.RemainingM).Append(",\"distanceM\":").Append(hud.DistanceM)
          .Append(",\"stamina\":").Append(hud.StaminaPermille).Append(",\"whips\":").Append(hud.WhipsLeft).Append(",\"maxWhips\":").Append(hud.MaxWhips)
          .Append(",\"kakari\":").Append(B(hud.Kakari)).Append(",\"reining\":").Append(B(hud.Reining)).Append(",\"spurt\":").Append(B(hud.Spurt))
          .Append(",\"departed\":").Append(B(hud.Departed)).Append(",\"finished\":").Append(B(hud.Finished)).Append(",\"gateOpen\":").Append(B(hud.GateOpen))
          .Append(",\"gateTicks\":").Append(hud.GateCountdownTicks).Append(",\"elapsedMs\":").Append(hud.ElapsedMs)
          .Append(",\"finishPlace\":").Append(hud.FinishPlace).Append(",\"done\":").Append(B(_driver.Done))
          .Append(",\"time\":\"").Append(HudModel.FormatTime(hud.ElapsedMs)).Append("\",\"subtitle\":\"").Append(Esc(_subtitle)).Append("\",\"progress\":[");
        for (int i = 0; i < hud.Progress.Length; i++) { if (i > 0) sb.Append(','); sb.Append(F(hud.Progress[i])); }
        sb.Append("],\"horses\":[");
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
            sb.Append(",\"order\":[").Append(string.Join(",", _driver.Sim.Result.Order)).Append("],\"hash\":\"").Append(_driver.Sim.Result.Hash).Append('"');
        sb.Append('}');
        return sb.ToString();
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
