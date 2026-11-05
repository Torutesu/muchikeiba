// Generates the race replay shown in the Figma gallery: runs the REAL engine (RaceSim) and commentator
// over a golden race log and samples horse positions on the course with TrackGeometry.
// usage: dotnet run -- <golden.json> <commentary-ja.json> <out.json>
using System.Globalization;
using System.Text;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;

var golden = JsonNode.Parse(File.ReadAllText(args[0]));
var log = ProtocolCodec.ParseReplayLog(golden.Get("log"));
var templates = CommentaryTemplates.Parse(File.ReadAllText(args[1]));
var cfg = log.Config;
var sim = new RaceSim(cfg);
var geo = TrackGeometry.For(cfg);
var commentator = new Commentator(templates, cfg);
int n = cfg.Entrants.Count, laneW = cfg.Ruleset.LaneWidthMm;
var byTick = log.Inputs.GroupBy(i => i.Tick).ToDictionary(g => g.Key, g => g.ToList());
var inv = CultureInfo.InvariantCulture;
string F(double v) => v.ToString("0.##", inv);

var frames = new StringBuilder();
var lines = new StringBuilder();
var cmds = new byte[n];
int sampled = 0;
while (!sim.IsFinished && sim.Tick < cfg.Ruleset.MaxTicks)
{
    Array.Clear(cmds, 0, n);
    if (byTick.TryGetValue(sim.Tick, out var list)) foreach (var r in list) cmds[r.Slot] |= r.Cmd;
    sim.Step(cmds);
    foreach (var l in commentator.Process(sim))
    {
        if (lines.Length > 0) lines.Append(',');
        lines.Append("[").Append(l.Tick).Append(',').Append(l.DurationTicks).Append(",\"").Append(l.Text.Replace("\\", "\\\\").Replace("\"", "\\\"")).Append("\"]");
    }
    if ((sim.Tick - 1) % 2 != 0) continue;
    if (sampled++ > 0) frames.Append(',');
    frames.Append('[').Append(sim.Tick - 1);
    for (int s = 0; s < n; s++)
    {
        var h = sim.GetHorse(s);
        var p = geo.PoseOf(h, laneW);
        frames.Append(',').Append(F(p.X)).Append(',').Append(F(p.Z)).Append(',').Append(h.Rank).Append(',').Append(h.StaminaPermille).Append(',').Append(h.WhipsLeft);
    }
    frames.Append(']');
}
var rail = new StringBuilder();
for (double d = 0; d <= geo.LengthM; d += 4) { var p = geo.PoseAt(d); if (rail.Length > 0) rail.Append(','); rail.Append('[').Append(F(p.X)).Append(',').Append(F(p.Z)).Append(']'); }
var outer = new StringBuilder();
for (double d = 0; d <= geo.LengthM; d += 4) { var p = geo.PoseAt(d, cfg.Ruleset.LaneCount * laneW / 1000.0); if (outer.Length > 0) outer.Append(','); outer.Append('[').Append(F(p.X)).Append(',').Append(F(p.Z)).Append(']'); }
var names = string.Join(",", cfg.Entrants.Select(e => "\"" + e.Horse.Name + "\""));
var order = string.Join(",", sim.Result.Order);
var json = "{\"raceId\":\"" + cfg.RaceId + "\",\"track\":\"" + cfg.Track.Id + "\",\"distanceM\":" + cfg.Track.DistanceM +
  ",\"tickHz\":" + cfg.Net.TickHz + ",\"gateOpenTick\":" + cfg.Ruleset.GateOpenTick + ",\"names\":[" + names + "],\"rail\":[" + rail + "],\"outer\":[" + outer +
  "],\"frames\":[" + frames + "],\"lines\":[" + lines + "],\"order\":[" + order + "],\"hash\":\"" + sim.Result.Hash + "\",\"expectedHash\":\"" +
  golden.Get("expected").Get("resultHash").AsString() + "\"}";
File.WriteAllText(args[2], json);
Console.WriteLine($"frames={sampled} lines={lines.ToString().Split("],[").Length} hash={(sim.Result.Hash == golden.Get("expected").Get("resultHash").AsString() ? "MATCH" : "MISMATCH")}");
