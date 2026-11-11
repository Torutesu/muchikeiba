// Round 18: 練習レース (REQ-PRAC-*, contracts/protocol.md §50) for the web prototype. The real PracticeSession of Muchi.Client
// over the WASM engine: the config built on the device from the catalog (MuchiLogic.practiceCatalog = GET /v1/practice/catalog),
// same-seed / new-seed restarts, the previous finished attempt as a GhostPlayer ghost, the whip band from the advice check
// range, the 0.5× clock for the last 400 m (PracticeClock: the race itself is unchanged), and the result (Round 8 debrief,
// the advice line, the ghost delta, 「報酬はありません（練習）」). Nothing is sent anywhere: practice grants nothing.
using System;
using System.Globalization;
using System.Runtime.InteropServices.JavaScript;
using System.Text;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

public static partial class MuchiRace
{
    private static PracticeSession _practice;
    private static string _practiceCatalogJson;
    private static PracticeCatalog _practiceCatalog;

    private static PracticeSetup ParseSetup(string json)
    {
        var o = JsonNode.Parse(json);
        return new PracticeSetup
        {
            HorseId = o.Get("horseId").AsString(), TrackId = o.Get("trackId").AsString(), Going = o.Get("going").AsString(),
            Night = o.TryGet("night", out var n) && n.AsBool(), FieldSize = o.Get("fieldSize").AsInt(), StrengthId = o.Get("strengthId").AsString(),
        };
    }

    private static PracticeCatalog CatalogOf(string json)
    {
        if (_practiceCatalog == null || json != _practiceCatalogJson) { _practiceCatalog = PracticeCatalog.FromJson(json); _practiceCatalogJson = json; }
        return _practiceCatalog;
    }

    /// <summary>Why the setup cannot be raced ("" when it can) — PracticeSetup.Problem on the catalog.</summary>
    [JSExport]
    public static string PracticeProblem(string catalogJson, string setupJson) => ParseSetup(setupJson).Problem(CatalogOf(catalogJson)) ?? "";

    /// <summary>
    /// mode: start (a new session, or the same session with the new setup — the ghost stays on the same course) |
    /// same_seed | new_seed (PracticeSession.Restart). options: { whipWindow, slowFinal, ghost }. Returns Begin's race info + "practice".
    /// </summary>
    [JSExport]
    public static string PracticeBegin(string catalogJson, string setupJson, string optionsJson, double seed, string mode)
    {
        var c = CatalogOf(catalogJson);
        var setup = ParseSetup(setupJson);
        var p = setup.Problem(c);
        if (p != null) return "{\"ok\":false,\"message\":\"" + Esc(p) + "\"}";
        var oj = JsonNode.Parse(string.IsNullOrEmpty(optionsJson) ? "{}" : optionsJson);
        bool Opt(string k, bool d) => oj.TryGet(k, out var v) && !v.IsNull ? v.AsBool() : d;
        OfflineRace race;
        if (_practice == null || _practice.Catalog != c)
        {
            _practice = new PracticeSession(c, setup, (ulong)seed, new PracticeOptions { WhipWindow = Opt("whipWindow", true), SlowFinal = Opt("slowFinal", false), Ghost = Opt("ghost", true) });
            race = _practice.Start();
        }
        else
        {
            _practice.Options.WhipWindow = Opt("whipWindow", true); _practice.Options.SlowFinal = Opt("slowFinal", false); _practice.Options.Ghost = Opt("ghost", true);
            if (!_practice.Options.Ghost) _practice.Forget();
            if (mode == "same_seed") race = _practice.Restart(PracticeRestart.SameSeed);
            else if (mode == "new_seed") race = _practice.Restart(PracticeRestart.NewSeed);
            else { if (_practice.Setup.Encode() != setup.Encode()) _practice.ChangeSetup(setup); race = _practice.Restart(PracticeRestart.None); }
        }
        _taRun = null; _chRun = null;
        var info = Begin("practice", new OfflineRaceDriver(race));
        var w = _practice.WhipWindow;
        var sb = new StringBuilder(info, 0, info.Length - 1, info.Length + 512);
        sb.Append(",\"ok\":true,\"practice\":{\"raceId\":\"").Append(Esc(_practice.Config.RaceId)).Append("\",\"seed\":\"").Append(_practice.Seed.ToString(CultureInfo.InvariantCulture))
          .Append("\",\"attempt\":").Append(_practice.Attempt).Append(",\"restart\":\"").Append(PracticeSession.RestartWire(_practice.LastRestart))
          .Append("\",\"strength\":\"").Append(Esc(_practice.Setup.StrengthId)).Append("\",\"fieldSize\":").Append(_practice.Config.Entrants.Count)
          .Append(",\"band\":").Append(w == null ? "null" : "{\"from\":" + w.FromRemainingM + ",\"to\":" + w.ToRemainingM + ",\"start\":" + w.StartRemainingM + "}")
          .Append(",\"slowFinal\":").Append(B(_practice.Options.SlowFinal))
          .Append(",\"ghost\":").Append(_practice.Ghost == null ? "null" : "{\"horse\":\"" + Esc(_practice.GhostHorseName) + "\",\"time\":\"" + HudModel.FormatTime(_practice.GhostTimeMs) + "\",\"timeMs\":" + _practice.GhostTimeMs + "}")
          .Append(",\"adviceLines\":[");
        if (_practice.Advice != null)
            for (int i = 0; i < _practice.Advice.Lines.Count; i++) { if (i > 0) sb.Append(','); sb.Append('"').Append(Esc(Loc.T(_practice.Advice.Lines[i].Text))).Append('"'); }
        sb.Append("]}}");
        return sb.ToString();
    }

    /// <summary>
    /// R19 integration (§57 × §50): a race lesson (position / stamina / reins) is a practice race built by PracticeSession — one
    /// practice path, the same builder as 練習レース — on its own session (the player's practice session, its attempts and
    /// ghost are left alone), with the practice options off. It runs on the normal clock; nothing is sent anywhere.
    /// </summary>
    [JSExport]
    public static string LessonBegin(string catalogJson, string setupJson, double seed)
    {
        var c = CatalogOf(catalogJson);
        var setup = ParseSetup(setupJson);
        var p = setup.Problem(c);
        if (p != null) return "{\"ok\":false,\"message\":\"" + Esc(p) + "\"}";
        var session = new PracticeSession(c, setup, (ulong)Math.Max(1, seed), new PracticeOptions { WhipWindow = false, SlowFinal = false, Ghost = false });
        _taRun = null; _chRun = null;
        var info = Begin("practice", new OfflineRaceDriver(session.Start()));
        return info.Substring(0, info.Length - 1) + ",\"ok\":true,\"raceId\":\"" + Esc(session.Config.RaceId) + "\"}";
    }

    /// <summary>The practice race clock for a real time (photo mode pauses and resumes the race on this clock).</summary>
    [JSExport]
    public static double PracticeNow(double realMs) => _practice == null ? realMs : _practice.RaceNow((long)realMs);

    /// <summary>One practice frame: Frame on the practice clock, plus the band, slow motion and the ghost.</summary>
    [JSExport]
    public static string PracticeFrame(double realMs)
    {
        if (_practice == null || _driver == null) return Frame(realMs);
        long now = _practice.RaceNow((long)realMs);
        var f = Frame(now);
        var sb = new StringBuilder(f, 0, f.Length - 1, f.Length + 256);
        var me = _driver.Sim.GetHorse(_driver.PlayerSlot);
        var w = _practice.WhipWindow;
        bool inBand = w != null && me.Departed && !me.Finished && w.Contains(RaceFeel.RemainingMm(_driver.Sim, me));
        sb.Append(",\"practice\":{\"slow\":").Append(B(_practice.Clock.Slow)).Append(",\"inBand\":").Append(B(inBand));
        var g = _practice.Ghost;
        if (g != null)
        {
            int alpha = _driver.Race.InterpolationAlphaPermille(now);
            var p = _frame.Horse(g.PreviousHorse, g.Horse, alpha);
            sb.Append(",\"ghostGapM\":").Append(F(_practice.GhostGapM ?? 0));
            sb.Append("},\"ghostPoses\":[[").Append(F(p.X + _xShift)).Append(',').Append(F(p.Z)).Append(',').Append(F(p.YawDegrees)).Append(',')
              .Append(B(g.Horse.Departed && !g.Finished)).Append(',').Append(F(_practice.GhostGapM ?? 0)).Append("]]}");
        }
        else sb.Append("}}");
        return sb.ToString();
    }

    /// <summary>The result of the finished attempt (PracticeSession.Result) in the app's language.</summary>
    [JSExport]
    public static string PracticeResultJson()
    {
        if (_practice?.Race == null || !_practice.Race.IsFinished) return "{\"ok\":false}";
        var r = _practice.Result();
        var sb = new StringBuilder("{\"ok\":true");
        sb.Append(",\"finished\":").Append(B(r.Finished)).Append(",\"place\":").Append(r.Place).Append(",\"runners\":").Append(r.Runners)
          .Append(",\"timeMs\":").Append(r.TimeMs).Append(",\"time\":\"").Append(r.TimeMs >= 0 ? HudModel.FormatTime(r.TimeMs) : "").Append('"')
          .Append(",\"verdict\":").Append(r.AdviceVerdict == null ? "null" : "\"" + r.AdviceVerdict.Value.ToString() + "\"")
          .Append(",\"deltaMs\":").Append(r.DeltaMs?.ToString(CultureInfo.InvariantCulture) ?? "null")
          .Append(",\"hash\":\"").Append(r.ResultHash).Append("\",\"kpiPlace\":").Append(_practice.KpiPlace)
          .Append(",\"debriefLine\":\"").Append(Esc(Loc.T(r.Debrief?.Line))).Append("\",\"debriefTip\":\"").Append(Esc(Loc.T(r.Debrief?.Tip)))
          .Append("\",\"adviceLine\":\"").Append(Esc(Loc.T(r.AdviceLine))).Append("\",\"ghostLine\":\"").Append(Esc(Loc.T(r.GhostLine)))
          .Append("\",\"noReward\":\"").Append(Esc(Loc.T(r.NoRewardLine))).Append("\",\"lines\":[");
        var lines = r.Lines;
        for (int i = 0; i < lines.Count; i++) { if (i > 0) sb.Append(','); sb.Append('"').Append(Esc(Loc.T(lines[i]))).Append('"'); }
        return sb.Append("]}").ToString();
    }
}
