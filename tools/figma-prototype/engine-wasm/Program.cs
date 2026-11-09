// Browser entry for the web prototype: the same OfflineRaceDriver / RaceInput / HudModel / CommentaryFeed path that
// unity/Assets/Muchi/Runtime/MuchiApp.cs uses in Unity, exported to JavaScript.
using System;
using System.Globalization;
using System.Runtime.InteropServices.JavaScript;
using System.Collections.Generic;
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
    private static TimeAttackRun _taRun;
    private static ChallengeRun _chRun;
    private static ReplayShareModel _share;
    private static readonly Dictionary<string, Ghost> _ghosts = new Dictionary<string, Ghost>();
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    [JSExport]
    public static string Init(string rulesetJson, string commentaryJson)
    {
        _ruleset = RaceFactory.ParseRuleset(rulesetJson);
        _templates = CommentaryTemplates.Parse(commentaryJson);
        return _ruleset.RulesetVersion;
    }

    /// <summary>
    /// REQ-L10N-012: the commentary language from the next race (commentary-ja.json / commentary-en.json); the English
    /// tables (server-en.json + ui-en.json) give the English horse and skill names. Returns the language.
    /// </summary>
    [JSExport]
    public static string SetLanguage(string lang, string commentaryJson, string serverEnJson, string uiEnJson)
    {
        if (!string.IsNullOrEmpty(serverEnJson) && Loc.English.Count == 0) { Loc.LoadEnglish(serverEnJson); Loc.LoadEnglish(uiEnJson); }
        Loc.SetLocale(lang);
        _templates = CommentaryTemplates.Parse(commentaryJson);
        return _templates.Language;
    }

    /// <summary>mode "tutorial" = OfflinePresets tutorial (starts near the finish); otherwise the 12-runner 2000 m practice race.</summary>
    [JSExport]
    public static string Start(string mode, string partnerName, string partnerJson, double seed)
    {
        _taRun = null; _chRun = null;
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
        _taRun = null; _chRun = null;
        var race = OfflinePresets.TutorialRace(_ruleset, Math.Max(1, attempt));
        return Begin("tutorial", new OfflineRaceDriver(race));
    }

    /// <summary>A race from a server-built RaceStartConfig (server/src/domain/raceConfig.ts buildRaceConfig), ridden by <paramref name="playerId"/>.</summary>
    [JSExport]
    public static string StartConfig(string configJson, string playerId)
    {
        _taRun = null; _chRun = null;
        var cfg = Muchi.Net.ProtocolCodec.ParseConfig(configJson);
        int slot = 0;
        foreach (var e in cfg.Entrants) if (e.Kind == EntrantKind.Human && e.PlayerId == playerId) { slot = e.Slot; break; }
        return Begin("config", new OfflineRaceDriver(cfg, slot, false)); // the player presses START (late = 出遅れ)
    }

    private static string Begin(string mode, OfflineRaceDriver driver)
    {
        _obs?.Dispose();
        _share = null;
        _driver = driver;
        _mode = mode;
        var cfg = driver.Config;
        // round 12: かんたん操作 (REQ-ASSIST-*) — the same AssistModel.Attach the game layer uses; never in the tutorial
        if (mode != "tutorial") AssistModel.Attach(driver, _assist);
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
        // time attack ghosts beside the player (names for the HUD; poses come with every frame)
        sb.Append(",\"ghosts\":[");
        if (_taRun != null)
            for (int i = 0; i < _taRun.Ghosts.Count; i++)
            {
                var m = _taRun.Ghosts[i].Meta;
                if (i > 0) sb.Append(',');
                sb.Append("{\"name\":\"").Append(Esc(m?.DisplayName)).Append("\",\"horse\":\"").Append(Esc(m?.HorseName)).Append("\",\"timeMs\":").Append(m?.TimeMs ?? -1).Append('}');
            }
        sb.Append("]}");
        return sb.ToString();
    }

    [JSExport] public static void Lane(int dir) => _input.Lane(dir);
    [JSExport] public static void Spur() => _input.Spur();
    [JSExport] public static void Rein(bool held) => _input.SetRein(held);

    private static AssistLevel _assist = AssistLevel.Off;
    /// <summary>Round 12: the かんたん操作 level ("off" | "whip" | "full", the server setting) used from the next race.</summary>
    [JSExport] public static string SetAssist(string level) { _assist = AssistLevels.Parse(level); return AssistLevels.Wire(_assist); }

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
        // round 12: the level riding this race and the HUD chip (HudSnapshot.Assist / AssistLabel)
        sb.Append(",\"assist\":\"").Append(AssistLevels.Wire(hud.Assist)).Append("\",\"assistLabel\":\"").Append(Esc(hud.AssistLabel)).Append("\",\"assistCmds\":")
          .Append(_driver.Race.Assistant?.CommandsSent ?? 0);
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
        AppendGhosts(sb, now);
        if (_chRun != null)
            sb.Append(",\"challenge\":{\"whips\":").Append(_chRun.WhipsUsed).Append(",\"whipsBroken\":").Append(B(_chRun.WhipsBroken))
              .Append(",\"timeBroken\":").Append(B(_chRun.TimeBroken)).Append(",\"elapsedMs\":").Append(_chRun.ElapsedMs).Append('}');
        if (_driver.Done && _driver.Sim?.Result != null)
        {
            var res = _driver.Sim.Result;
            sb.Append(",\"order\":[").Append(string.Join(",", res.Order)).Append("],\"hash\":\"").Append(res.Hash).Append('"');
            // per place: finish tick (-1 = did not finish) and margin to the previous place in meters (web result table)
            sb.Append(",\"tickHz\":").Append(_driver.Config.Net.TickHz).Append(",\"finishTicks\":[").Append(string.Join(",", res.FinishTicks)).Append("],\"margins\":[");
            for (int i = 0; i < res.Margins.Length; i++) { if (i > 0) sb.Append(','); sb.Append(F(res.Margins[i].Raw / (double)Fx.OneRaw)); }
            sb.Append(']');
            AppendResult(sb);
            if (_chRun != null)
            {
                // what the device submits (inputs + hash) and its own verdict (ChallengeEvaluator; the server's decides)
                var ev = _chRun.Evaluate();
                sb.Append(",\"challengeRun\":{\"hash\":\"").Append(_chRun.Race.ResultHash).Append("\",\"inputs\":[");
                for (int i = 0; i < _chRun.Race.RecordedInputs.Count; i++) { var r = _chRun.Race.RecordedInputs[i]; if (i > 0) sb.Append(','); sb.Append('[').Append(r.Tick).Append(',').Append(r.Slot).Append(',').Append(r.Cmd).Append(']'); }
                sb.Append("],\"cleared\":").Append(B(ev.Cleared)).Append(",\"place\":").Append(ev.Place?.ToString() ?? "null").Append(",\"timeMs\":").Append(ev.TimeMs?.ToString() ?? "null").Append(",\"whips\":").Append(ev.Whips).Append('}');
            }
            if (_taRun != null)
            {
                // the run's replay log (config + the player's inputs): what the device submits, and what becomes a ghost
                var log = new Muchi.Net.ReplayLog { Config = _taRun.Race.Config, EndTick = -1, Inputs = new List<InputRecord>(_taRun.Race.RecordedInputs) };
                sb.Append(",\"ta\":{\"timeMs\":").Append(_taRun.FinishTimeMs).Append(",\"log\":").Append(Muchi.Net.ProtocolCodec.ReplayLogToJson(log).ToString()).Append(",\"ghostTimes\":[");
                for (int i = 0; i < _taRun.Ghosts.Count; i++) { if (i > 0) sb.Append(','); _taRun.Ghosts[i].RunToEnd(); sb.Append(_taRun.Ghosts[i].FinishTimeMs); }
                sb.Append("]}");
            }
        }
        sb.Append('}');
        return sb.ToString();
    }

    /// <summary>Time attack ghosts (GhostPlayer: their own RaceSim, stepped with the player's race), drawn translucent.</summary>
    private static void AppendGhosts(StringBuilder sb, long now)
    {
        if (_taRun == null || _taRun.Ghosts.Count == 0) return;
        int alpha = _driver.Race.InterpolationAlphaPermille(now);
        var me = _driver.Sim.GetHorse(_driver.PlayerSlot);
        sb.Append(",\"ghostPoses\":[");
        for (int i = 0; i < _taRun.Ghosts.Count; i++)
        {
            var g = _taRun.Ghosts[i];
            var p = _frame.Horse(g.PreviousHorse, g.Horse, alpha);
            if (i > 0) sb.Append(',');
            sb.Append('[').Append(F(p.X + _xShift)).Append(',').Append(F(p.Z)).Append(',').Append(F(p.YawDegrees)).Append(',')
              .Append(B(g.Horse.Departed && !g.Finished)).Append(',').Append(F((g.Horse.Distance - me.Distance).Raw / (double)Fx.OneRaw)).Append(']');
        }
        sb.Append(']');
    }

    // ================================================================= round 9 (06 §7 item 12 / §7.3)

    /// <summary>
    /// Ghost runs for the time attack picker: each entry {id, name, horse, kind, config, whips[]} is ridden by a scripted
    /// rider (START on the gate, rein 1200→700 m, whips at the given metres left) in its own OfflineRace; its replay log is
    /// kept as a Ghost (timed by replaying it with GhostPlayer). An entry with "log" (the player's own best) is replayed as is.
    /// Returns [{id, kind, timeMs}].
    /// </summary>
    [JSExport]
    public static string TaGhosts(string entriesJson)
    {
        var arr = Muchi.Net.JsonNode.Parse(entriesJson);
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (var e in arr.Items)
        {
            string id = e.Get("id").AsString();
            Muchi.Net.ReplayLog log;
            if (e.TryGet("log", out var lg) && !lg.IsNull) log = Muchi.Net.ProtocolCodec.ParseReplayLog(lg);
            else
            {
                var cfg = Muchi.Net.ProtocolCodec.ParseConfig(e.Get("config"));
                var race = new OfflineRace(cfg, 0);
                var whips = new List<int>();
                if (e.TryGet("whips", out var w)) foreach (var x in w.Items) whips.Add(x.AsInt());
                int k = 0; bool rein = false, released = false;
                while (!race.IsFinished)
                {
                    var me = race.Sim.GetHorse(0);
                    var left = race.Sim.Track.Distance - me.Distance;
                    if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start);
                    if (!rein && left < Fx.FromInt(1200) && left > Fx.FromInt(700)) { rein = true; race.Input(Cmd.ReinPress); }
                    if (rein && !released && left <= Fx.FromInt(700)) { released = true; race.Input(Cmd.ReinRelease); }
                    if (me.Departed && k < whips.Count && left <= Fx.FromInt(whips[k])) { k++; race.Input(Cmd.Whip); }
                    race.StepOnce();
                }
                log = new Muchi.Net.ReplayLog { Config = cfg, EndTick = -1, Inputs = new List<InputRecord>(race.RecordedInputs) };
            }
            var gp = new GhostPlayer(log);
            gp.RunToEnd();
            var meta = new GhostMeta
            {
                PlayerId = id, DisplayName = e.Get("name").AsString(), HorseName = e.TryGet("horse", out var hn) ? hn.AsString() : "",
                TrackId = log.Config.Track.Id, TimeMs = gp.FinishTimeMs, FinishTick = gp.Horse.FinishTick, FinishFrac = gp.Horse.FinishFracRaw,
            };
            _ghosts[id] = new Ghost { Meta = meta, Log = log };
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"id\":\"").Append(Esc(id)).Append("\",\"kind\":\"").Append(Esc(e.Get("kind").AsString())).Append("\",\"timeMs\":").Append(gp.FinishTimeMs).Append('}');
        }
        return sb.Append(']').ToString();
    }

    private static string K(GhostKind k) => k == GhostKind.Friends ? "friends" : k == GhostKind.Top ? "top" : "me";

    /// <summary>
    /// GhostPicker (REQ-UXS-074): entries [{id, name, horse, kind: friends|top|me, timeMs}] → the picker state (opens on フレンド,
    /// falls back to 上位, default pick = the nearest ghost faster than my best). tab / selectedId apply the player's choice.
    /// </summary>
    [JSExport]
    public static string PickGhosts(string entriesJson, string myId, double myBestMs, string tab, string selectedId)
    {
        var lists = new Dictionary<string, GhostList> { ["friends"] = new GhostList { Kind = "friends" }, ["top"] = new GhostList { Kind = "top" }, ["me"] = new GhostList { Kind = "me" } };
        foreach (var e in Muchi.Net.JsonNode.Parse(entriesJson).Items)
            lists[e.Get("kind").AsString()].Ghosts.Add(new GhostEntry { PlayerId = e.Get("id").AsString(), DisplayName = e.Get("name").AsString(), HorseName = e.Get("horse").AsString(), TimeMs = e.Get("timeMs").AsLong() });
        var p = GhostPicker.Build(lists["friends"], lists["top"], lists["me"], myId, myBestMs > 0 ? (long?)myBestMs : null);
        if (!string.IsNullOrEmpty(tab)) p.SelectTab(tab == "friends" ? GhostKind.Friends : tab == "top" ? GhostKind.Top : GhostKind.Me);
        if (!string.IsNullOrEmpty(selectedId)) { var sel = p.Current.Find(g => g.PlayerId == selectedId); if (sel != null) p.Select(sel); }
        var sb = new StringBuilder();
        sb.Append("{\"tab\":\"").Append(K(p.Tab)).Append("\",\"fellBack\":").Append(B(p.FellBack)).Append(",\"note\":\"").Append(Esc(p.Note))
          .Append("\",\"selected\":\"").Append(Esc(p.Selected?.PlayerId)).Append("\",\"tabs\":[");
        for (int i = 0; i < GhostPicker.TabOrder.Length; i++)
        {
            var k = GhostPicker.TabOrder[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"kind\":\"").Append(K(k)).Append("\",\"label\":\"").Append(GhostPicker.TabLabel(k)).Append("\",\"count\":").Append(p.List(k).Count).Append('}');
        }
        sb.Append("],\"list\":[");
        for (int i = 0; i < p.Current.Count; i++)
        {
            var g = p.Current[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"id\":\"").Append(Esc(g.PlayerId)).Append("\",\"name\":\"").Append(Esc(g.DisplayName)).Append("\",\"horse\":\"").Append(Esc(g.HorseName))
              .Append("\",\"time\":\"").Append(HudModel.FormatTime(g.TimeMs)).Append("\",\"line\":\"").Append(Esc(p.TimeLine(g))).Append("\",\"selected\":").Append(B(g == p.Selected)).Append('}');
        }
        return sb.Append("]}").ToString();
    }

    /// <summary>A time attack run (TimeAttackRun on the server-issued config) with the chosen ghost (from TaGhosts) beside the player.</summary>
    [JSExport]
    public static string StartTimeAttack(string configJson, string ghostId)
    {
        var cfgNode = Muchi.Net.JsonNode.Parse(configJson);
        var session = new TimeAttackSession { SessionId = "proto", Token = "", ConfigJson = cfgNode, Config = Muchi.Net.ProtocolCodec.ParseConfig(cfgNode), AttemptsLeft = 0 };
        var run = new TimeAttackRun(session);
        if (!string.IsNullOrEmpty(ghostId) && _ghosts.TryGetValue(ghostId, out var g)) run.AddGhost(g);
        _taRun = run; _chRun = null;
        return Begin("timeattack", new OfflineRaceDriver(run.Race));
    }

    /// <summary>
    /// 週替わりチャレンジ (REQ-WCH-*, protocol §31): the server-issued challenge config ridden in the player's slot (ChallengeRun:
    /// the CPUs ride themselves, inputs capped like the server), the conditions shown live in the HUD (frame "challenge").
    /// </summary>
    [JSExport]
    public static string StartChallenge(string configJson, int playerSlot, string conditionsJson)
    {
        _taRun = null;
        var cfg = Muchi.Net.ProtocolCodec.ParseConfig(configJson);
        var c = Muchi.Net.JsonNode.Parse(string.IsNullOrEmpty(conditionsJson) ? "{}" : conditionsJson);
        var cond = new ChallengeConditions
        {
            MaxPlace = c.Has("maxPlace") ? c.Get("maxPlace").AsInt() : (int?)null, Style = c.Has("style") ? c.Get("style").AsString() : null,
            MaxWhips = c.Has("maxWhips") ? c.Get("maxWhips").AsInt() : (int?)null, MaxTimeMs = c.Has("maxTimeMs") ? c.Get("maxTimeMs").AsLong() : (long?)null,
        };
        _chRun = new ChallengeRun(cfg, playerSlot, cond);
        return Begin("challenge", new OfflineRaceDriver(_chRun.Race));
    }

    /// <summary>The verifier's re-simulation of a replay log (Muchi.Verifier: RaceReplay.Run → protocol §8 output).</summary>
    [JSExport]
    public static string VerifyReplay(string logJson)
    {
        var log = Muchi.Net.ProtocolCodec.ParseReplayLog(Muchi.Net.JsonNode.Parse(logJson));
        log.Config.Validate();
        return Muchi.Net.ProtocolCodec.VerifyOutputToJson(RaceReplay.Run(log.Config, log.Inputs)).ToString();
    }

    /// <summary>
    /// Replay share (REQ-UXS-070, 071) for the race that just finished: ReplayShareModel.From re-simulates it from the
    /// config + inputs (must reproduce the live hash), cuts the last 200 m (≤ 10 s) and builds the share card.
    /// </summary>
    [JSExport]
    public static string ShareClip(string courseName)
    {
        _share = ReplayShareModel.From(_driver, string.IsNullOrEmpty(courseName) ? null : courseName);
        if (_share == null) return "{\"ok\":false,\"message\":\"" + ReplayShareModel.TextUnavailable + "\"}";
        var c = _share.Card; var clip = _share.Clip;
        var st = clip.StatesAt(clip.StartTick)[clip.FocusSlot];
        double startRem = clip.Config.Track.DistanceM - TrackGeometry.DistanceM(st.Distance);
        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"card\":{\"watermark\":\"").Append(Esc(c.Watermark)).Append("\",\"place\":").Append(c.Place).Append(",\"runners\":").Append(c.Runners)
          .Append(",\"placeText\":\"").Append(Esc(c.PlaceText)).Append("\",\"time\":\"").Append(Esc(c.TimeText)).Append("\",\"horse\":\"").Append(Esc(c.HorseName))
          .Append("\",\"course\":\"").Append(Esc(c.CourseName)).Append("\",\"mode\":\"").Append(Esc(c.ModeLabel)).Append("\",\"shareText\":\"").Append(Esc(c.ShareText)).Append("\",\"skills\":[");
        for (int i = 0; i < c.SkillLines.Count; i++) { if (i > 0) sb.Append(','); sb.Append('"').Append(Esc(c.SkillLines[i])).Append('"'); }
        sb.Append("]},\"clip\":{\"durationMs\":").Append(clip.DurationMs).Append(",\"frames\":").Append(clip.FrameCount).Append(",\"fps\":").Append(clip.Options.FramesPerSecond)
          .Append(",\"finishAtMs\":").Append(clip.FinishAtMs).Append(",\"startRemainingM\":").Append(F(startRem)).Append(",\"hash\":\"").Append(clip.ResultHash)
          .Append("\",\"liveHash\":\"").Append(_driver.Sim.Result.Hash).Append("\",\"cameraKeys\":").Append(clip.CameraKeys.Count).Append(",\"modes\":[");
        string last = null; bool firstMode = true;
        foreach (var k in clip.CameraKeys) { var m = k.Shot.Mode.ToString(); if (m == last) continue; last = m; if (!firstMode) sb.Append(','); firstMode = false; sb.Append('"').Append(m).Append('"'); }
        sb.Append("],\"events\":[");
        for (int i = 0; i < clip.Events.Count; i++)
        {
            var e = clip.Events[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"t\":").Append(e.TimeMs).Append(",\"type\":\"").Append(e.Type.ToString()).Append("\",\"slot\":").Append(e.Slot).Append(",\"value\":").Append(e.Value).Append('}');
        }
        return sb.Append("]}}").ToString();
    }

    /// <summary>One clip frame posed in world space (ReplayShareModel.Pose: the same CourseFrame transform as the live race).</summary>
    [JSExport]
    public static string ClipFrame(double timeMs)
    {
        if (_share == null) return "{}";
        var f = _share.Clip.FrameAt((int)timeMs);
        var p = _share.Pose(f);
        var sb = new StringBuilder(1024);
        sb.Append("{\"t\":").Append(f.TimeMs).Append(",\"remainingM\":").Append(F(f.FocusRemainingM)).Append(",\"horses\":[");
        for (int i = 0; i < p.Horses.Length; i++)
        {
            if (i > 0) sb.Append(',');
            var h = p.Horses[i];
            sb.Append('[').Append(F(h.X + _xShift)).Append(',').Append(F(h.Z)).Append(',').Append(F(h.YawDegrees)).Append(',').Append(f.To[i].Rank).Append(',').Append(B(p.WhipActive[i])).Append(",true,true]");
        }
        var c = p.Camera;
        sb.Append("],\"cam\":[").Append(F(c.Position.X + _xShift)).Append(',').Append(F(c.Height)).Append(',').Append(F(c.Position.Z)).Append(',')
          .Append(F(c.LookAt.X + _xShift)).Append(',').Append(F(c.LookAtHeight)).Append(',').Append(F(c.LookAt.Z)).Append(',').Append(F(c.FieldOfViewDegrees)).Append(",\"").Append(c.Mode.ToString()).Append("\"]}");
        return sb.ToString();
    }

    /// <summary>
    /// AccountLinkPrompt (REQ-UXS-073) on a store mirrored from localStorage (the PlayerPrefs keys muchi.link.*).
    /// op: eval {context, anonymous, day, ftueDone, online, deletion} | show {trigger, ios} | dismiss | purchase | linked {provider, at}.
    /// Returns {show?, trigger?, view?, event?, store}.
    /// </summary>
    [JSExport]
    public static string LinkPrompt(string op, string storeJson, string argsJson)
    {
        var kv = new MemoryKeyValueStore();
        var store = Muchi.Net.JsonNode.Parse(string.IsNullOrEmpty(storeJson) ? "{}" : storeJson);
        var keys = new[] { AccountLinkPrompt.KeyState, AccountLinkPrompt.KeyFirstPurchase };
        foreach (var key in keys)
            if (store.TryGet(key, out var v) && !v.IsNull) kv.Set(key, v.AsString());
        var a = Muchi.Net.JsonNode.Parse(string.IsNullOrEmpty(argsJson) ? "{}" : argsJson);
        var lp = new AccountLinkPrompt(kv);
        var sb = new StringBuilder("{");
        bool Bool(string k) => a.TryGet(k, out var x) && x.AsBool();
        if (op == "eval")
        {
            var ctx = (LinkPromptContext)Enum.Parse(typeof(LinkPromptContext), a.Get("context").AsString());
            int day = a.Get("day").AsInt();
            // FTUE over (AccountLinkPrompt.FtueDone): partner named, welcome scout done, first ranked race run
            bool ftue = a.TryGet("rankedRaces", out var rr)
                ? AccountLinkPrompt.FtueDone(new PlayerView { PartnerHorseId = Bool("partner") ? "partner" : null, TutorialGachaUsed = Bool("gacha"), RankedRaces = rr.AsInt() })
                : Bool("ftueDone");
            bool show = lp.ShouldShow(ctx, Bool("anonymous"), day, ftue, Bool("online"), Bool("deletion"));
            sb.Append("\"ftueDone\":").Append(B(ftue)).Append(",\"show\":").Append(B(show)).Append(",\"trigger\":\"").Append(lp.TriggerFor(day, false).ToString()).Append("\",");
        }
        else if (op == "show")
        {
            var v = lp.Show((LinkPromptTrigger)Enum.Parse(typeof(LinkPromptTrigger), a.Get("trigger").AsString()), Bool("ios"));
            sb.Append("\"view\":{\"title\":\"").Append(Esc(v.Title)).Append("\",\"body\":\"").Append(Esc(v.Body)).Append("\",\"providers\":[\"").Append(string.Join("\",\"", v.Providers))
              .Append("\"],\"apple\":\"").Append(Esc(v.AppleLabel)).Append("\",\"google\":\"").Append(Esc(v.GoogleLabel)).Append("\",\"later\":\"").Append(Esc(v.LaterLabel))
              .Append("\",\"footnote\":\"").Append(Esc(v.Footnote)).Append("\"},");
        }
        else if (op == "dismiss") lp.Dismiss();
        else if (op == "purchase") lp.NotePurchase();
        else if (op == "linked")
        {
            var e = lp.OnLinkResult(LinkResult.Linked, a.Get("provider").AsString(), a.Get("at").AsLong());
            if (e != null) sb.Append("\"event\":{\"name\":\"").Append(e.Name).Append("\",\"at\":").Append(e.AtMs).Append("},");
        }
        sb.Append("\"store\":{");
        bool firstKey = true;
        foreach (var key in keys)
        {
            var v = kv.Get(key);
            if (v == null) continue;
            if (!firstKey) sb.Append(',');
            firstKey = false;
            sb.Append('"').Append(key).Append("\":\"").Append(Esc(v)).Append('"');
        }
        return sb.Append("}}").ToString();
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
