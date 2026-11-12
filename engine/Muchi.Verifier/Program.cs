using Muchi.Verifier;

// Usage:
//   Muchi.Verifier replay <log.json>          → prints verify output JSON (exit 2 on bad input)
//   Muchi.Verifier golden <outDir> <ruleset>  → writes race-*.json golden files
//   Muchi.Verifier balance <ruleset> [races] [key=value...] → prints CPU-only balance statistics
//   Muchi.Verifier serve [--urls http://0.0.0.0:8080] → HTTP POST /verify
if (args.Length >= 2 && args[0] == "replay")
{
    string text = File.ReadAllText(args[1]);
    // also accept a golden file ({"log":…,"expected":…})
    try { var doc = Muchi.Net.JsonNode.Parse(text); if (doc.Kind == Muchi.Net.JsonKind.Object && doc.Has("log")) text = doc.Get("log").ToString(); } catch (FormatException) { }
    var (status, body) = VerifyService.Verify(text);
    Console.WriteLine(body);
    return status == 200 ? 0 : 2;
}
if (args.Length >= 3 && args[0] == "golden")
{
    // golden <outDir> <ruleset> [<ruleset 1.4 tactics>] — the 1.4 file adds race-turf2000-tactics.json; the others never change
    foreach (var path in GoldenGenerator.WriteAll(args[1], File.ReadAllText(args[2]), args.Length >= 4 ? File.ReadAllText(args[3]) : null))
        Console.WriteLine("wrote " + path);
    return 0;
}
if (args.Length >= 3 && args[0] == "highlights")
{
    // REQ-HL-001 (§72): `highlights <goldenDir> <vectors.json> [write]` checks (or writes) the shared highlight vectors
    if (args.Length >= 4 && args[3] == "write")
    {
        File.WriteAllText(args[2], HighlightVectors.Render(HighlightVectors.Compute(args[1])));
        Console.WriteLine("wrote " + args[2]);
        return 0;
    }
    var problems = HighlightVectors.Check(args[1], args[2]);
    foreach (var p in problems) Console.WriteLine(p);
    Console.WriteLine(problems.Count == 0 ? "highlights: no drift" : "highlights: " + problems.Count + " mismatches");
    return problems.Count == 0 ? 0 : 1;
}
if (args.Length >= 2 && args[0] == "balance")
{
    var rsNode = Muchi.Net.JsonNode.Parse(File.ReadAllText(args[1]));
    // track options: surface=turf|dirt going=<name> apt=mix tracks=<tracks.json> track=<id> ; everything else overrides a ruleset key
    string surface = "turf", goingName = null, tracksFile = null, trackId = null; bool aptMix = false;
    foreach (var kv in args.Skip(3))
    {
        var parts = kv.Split('=');
        if (parts[0] == "surface") surface = parts[1];
        else if (parts[0] == "going") goingName = parts[1];
        else if (parts[0] == "apt") aptMix = parts[1] == "mix";
        else if (parts[0] == "tracks") tracksFile = parts[1];
        else if (parts[0] == "track") trackId = parts[1];
        else rsNode.Set(parts[0], long.Parse(parts[1]));
    }
    var rs = Muchi.Net.ProtocolCodec.ParseRuleset(rsNode);
    int n = args.Length >= 3 ? int.Parse(args[2]) : 200;
    var track = tracksFile != null && trackId != null
        ? BalanceHarness.LoadServerTracks(tracksFile).Single(t => t.Id == trackId)
        : surface == "dirt" ? SampleRaces.Dirt1800() : SampleRaces.Turf2000();
    if (goingName != null) track.Going = Muchi.Net.ProtocolCodec.ParseGoing(goingName, track.Surface);
    var rep = BalanceProbe.Run(rs, n, 1, 150, track, aptMix);
    Console.Write(rep.Describe(20, rs.GateOpenTick));
    return 0;
}
if (args.Length >= 3 && args[0] == "harness-tracks")
{
    // harness-tracks <ruleset.json> <server/master/tracks.json> [scale] [key=value...] → per-course targets T1/T2/T7 (docs/spec/balance-targets.md §2.1)
    var tNode = Muchi.Net.JsonNode.Parse(File.ReadAllText(args[1]));
    int tScale = 1;
    foreach (var kv in args.Skip(3))
    {
        if (!kv.Contains('=')) { tScale = int.Parse(kv); continue; }
        var parts = kv.Split('=');
        tNode.Set(parts[0], long.Parse(parts[1]));
    }
    var rs = Muchi.Net.ProtocolCodec.ParseRuleset(tNode);
    var rep = BalanceHarness.TrackRun(rs, BalanceHarness.LoadServerTracks(args[2]), tScale);
    Console.WriteLine(rep.Markdown());
    return rep.AllPass ? 0 : 1;
}
if (args.Length >= 2 && args[0] == "harness-ranked")
{
    // harness-ranked <contracts/ranked-fields.sample.json> [<ruleset.json> to ride the fields on another ruleset] [races per set]
    // → win / top-3 rates per class × horse × rider on the fields the server issues (docs/spec/balance-targets.md §2.5)
    var rsOverride = args.Length >= 3 && args[2] != "-" ? Muchi.Net.ProtocolCodec.ParseRuleset(File.ReadAllText(args[2])) : null;
    int maxRaces = args.Length >= 4 ? int.Parse(args[3]) : int.MaxValue;
    var sets = RankedHarness.Load(args[1], rsOverride);
    Console.Write(RankedHarness.Markdown(RankedHarness.RunAll(sets, maxRaces)));
    return 0;
}
if (args.Length >= 4 && args[0] == "harness-ranked-vectors")
{
    // harness-ranked-vectors <contracts/ranked-fields.sample.json> <contracts/ruleset-params.1.4.0.json> <out.json>
    // → contracts/ranked-places.vectors.json (every cell's place counts on 1.3 and 1.4; the economy test reads them)
    var cells = RankedHarness.RunAll(RankedHarness.Load(args[1]));
    cells.AddRange(RankedHarness.RunAll(RankedHarness.Load(args[1], Muchi.Net.ProtocolCodec.ParseRuleset(File.ReadAllText(args[2])))));
    File.WriteAllText(args[3], RankedHarness.Vectors(cells));
    Console.WriteLine("wrote " + args[3]);
    return 0;
}
if (args.Length >= 2 && args[0] == "harness-audit")
{
    // harness-audit <ruleset.json> [races] → what each riding decision is worth (docs/quality/race-play.md §2)
    var aNode = Muchi.Net.JsonNode.Parse(File.ReadAllText(args[1]));
    int races = args.Length >= 3 ? int.Parse(args[2]) : 160;
    var rs = Muchi.Net.ProtocolCodec.ParseRuleset(aNode);
    var rows = TacticsHarness.Audit(rs, races, 27182);
    double baseMs = rows[0].ms;
    foreach (var (what, ms, win) in rows)
        Console.WriteLine("| " + what + " | " + TacticsHarness.F(ms - baseMs) + " ms | " + TacticsHarness.F(win * 100) + "% |");
    return 0;
}
if (args.Length >= 2 && args[0] == "harness-tactics")
{
    // harness-tactics <ruleset 1.4+.json> [scale] [key=value...] → the 1.4 tactics targets K1..K8 (docs/spec/balance-targets.md §2.4)
    var kNode = Muchi.Net.JsonNode.Parse(File.ReadAllText(args[1]));
    int kScale = 1; bool curve = false, free = false; int margin = -100;
    foreach (var kv in args.Skip(2))
    {
        if (kv == "curve") { curve = true; continue; }
        if (kv == "free") { free = true; continue; }
        if (kv.StartsWith("margin=")) { margin = int.Parse(kv.Substring(7)); continue; }
        if (!kv.Contains('=')) { kScale = int.Parse(kv); continue; }
        var parts = kv.Split('=');
        kNode.Set(parts[0], long.Parse(parts[1]));
    }
    var rs = Muchi.Net.ProtocolCodec.ParseRuleset(kNode);
    var sw = System.Diagnostics.Stopwatch.StartNew();
    if (curve)
    {
        foreach (var (off, ms, win) in TacticsHarness.GoCurve(rs, 160 * kScale, 31415, new[] { -500, -350, -250, -150, -50, 0, 50, 150, 250, 350, 500, 800 }, !free, margin))
            Console.WriteLine("go offset " + off + "‰: " + TacticsHarness.F(ms) + " ms, win " + TacticsHarness.F(win * 100) + "%");
        return 0;
    }
    var rep = TacticsHarness.Run(rs, kScale);
    Console.Write(rep.Markdown());
    Console.WriteLine("elapsed " + sw.ElapsedMilliseconds + "ms, all pass: " + rep.AllPass);
    return rep.AllPass ? 0 : 1;
}
if (args.Length >= 2 && args[0] == "harness")
{
    // harness <ruleset.json> [scale] → every race-side balance target (docs/spec/balance-targets.md)
    var hNode = Muchi.Net.JsonNode.Parse(File.ReadAllText(args[1]));
    int scale = 1;
    foreach (var kv in args.Skip(2))
    {
        if (!kv.Contains('=')) { scale = int.Parse(kv); continue; }
        var parts = kv.Split('=');
        hNode.Set(parts[0], long.Parse(parts[1]));
    }
    var rs = Muchi.Net.ProtocolCodec.ParseRuleset(hNode);
    var sw = System.Diagnostics.Stopwatch.StartNew();
    var rep = BalanceHarness.Run(rs, scale);
    Console.Write(rep.Markdown());
    Console.WriteLine("elapsed " + sw.ElapsedMilliseconds + "ms, all pass: " + rep.AllPass);
    return rep.AllPass ? 0 : 1;
}
if (args.Length >= 4 && args[0] == "harness-skills")
{
    // harness-skills <ruleset.json> <server/master/skills.json> <server/master/tracks.json> [scale] [key=value...]
    //   → R9 per skill (win-rate ratio with/without, ranked caps and uncapped) and style parity with skills on every course × going
    var sNode = Muchi.Net.JsonNode.Parse(File.ReadAllText(args[1]));
    int sScale = 1;
    foreach (var kv in args.Skip(4))
    {
        if (!kv.Contains('=')) { sScale = int.Parse(kv); continue; }
        var parts = kv.Split('=');
        sNode.Set(parts[0], long.Parse(parts[1]));
    }
    var rs = Muchi.Net.ProtocolCodec.ParseRuleset(sNode);
    var sw = System.Diagnostics.Stopwatch.StartNew();
    var rep = SkillBalance.Run(rs, SkillMaster.Load(args[2]), BalanceHarness.LoadServerTracks(args[3]), sScale);
    Console.Write(rep.Markdown());
    Console.WriteLine("elapsed " + sw.ElapsedMilliseconds + "ms, all pass: " + rep.AllPass);
    return rep.AllPass ? 0 : 1;
}
if (args.Length >= 3 && args[0] == "ta-thresholds")
{
    // ta-thresholds <ruleset.json> <server/master/tracks.json> [statCap] → gold/silver/bronze per track (ms)
    var rs = SampleRaces.LoadRuleset(args[1]);
    int cap = args.Length >= 4 ? int.Parse(args[3]) : 3200;
    foreach (var (track, gold, silver, bronze) in BalanceHarness.TimeAttackThresholds(rs, BalanceHarness.LoadServerTracks(args[2]), cap, 80))
        Console.WriteLine(track + " gold " + gold + " silver " + silver + " bronze " + bronze);
    return 0;
}
if (args.Length >= 3 && args[0] == "style-dist")
{
    // style-dist <ruleset.json> <tracks.json> [races] [lv=0..5] [riders=1] [key=value...]
    //   → per-runner win rate (%) by running style for every course × going (diagnosis for balance-targets.md §2.1 T2)
    var node = Muchi.Net.JsonNode.Parse(File.ReadAllText(args[1]));
    int races = 240, lvMode = 3; bool riders = false;
    foreach (var kv in args.Skip(3))
    {
        if (!kv.Contains('=')) { races = int.Parse(kv); continue; }
        var parts = kv.Split('=');
        if (parts[0] == "lv") lvMode = int.Parse(parts[1]);
        else if (parts[0] == "riders") riders = parts[1] == "1";
        else node.Set(parts[0], long.Parse(parts[1]));
    }
    var rs = Muchi.Net.ProtocolCodec.ParseRuleset(node);
    var combos = new List<(Muchi.Engine.TrackSpec t, string g)>();
    foreach (var t in BalanceHarness.LoadServerTracks(args[2]))
        foreach (var gi in new[] { Muchi.Engine.Going.FirmOrFast, Muchi.Engine.Going.Good, Muchi.Engine.Going.YieldingOrMuddy, Muchi.Engine.Going.SoftOrSloppy })
            combos.Add((new Muchi.Engine.TrackSpec { Id = t.Id, Surface = t.Surface, DistanceM = t.DistanceM, Segments = t.Segments, Going = gi }, gi.ToString()));
    var rows = new string[combos.Count];
    double worst = 0;
    Parallel.For(0, combos.Count, k =>
    {
        var (t, g) = combos[k];
        var r = BalanceHarness.StyleRates(rs, t, races, 70807, lvMode);
        string line = t.Id.PadRight(22) + g.PadRight(16) + string.Join(" ", r.Select(x => (x * 100).ToString("F1").PadLeft(5)));
        double dev = r.Max(x => Math.Abs(x * 12 - 1));
        if (riders)
        {
            var sk = BalanceHarness.RiderStyleRates(rs, t, () => new SkilledRider(), races, 90901);
            var ca = BalanceHarness.RiderStyleRates(rs, t, () => new CasualRider(), races, 90901);
            line += "  | skilled " + string.Join(" ", sk.Select(x => (x * 100).ToString("F0").PadLeft(3))) + " | casual " + string.Join(" ", ca.Select(x => (x * 100).ToString("F0").PadLeft(3)));
        }
        rows[k] = line + "  maxdev " + (dev * 100).ToString("F0") + "%";
        lock (rows) worst = Math.Max(worst, dev);
    });
    Console.WriteLine("track".PadRight(22) + "going".PadRight(16) + " Nige Senko Sashi Oikomi (per-runner win %, uniform 8.33)");
    foreach (var l in rows) Console.WriteLine(l);
    Console.WriteLine("worst deviation from uniform: " + (worst * 100).ToString("F0") + "%");
    return 0;
}
if (args.Length >= 2 && args[0] == "rider-sweep")
{
    var rs = SampleRaces.LoadRuleset(args[1]);
    int n = args.Length >= 3 ? int.Parse(args[2]) : 144;
    var variants = new List<(string, Func<IRider>)>
    {
        ("skilled", () => new SkilledRider()),
        ("skilled rein-50", () => new SkilledRider { ReinMargin = -50 }),
        ("skilled rein-200", () => new SkilledRider { ReinMargin = -200 }),
        ("casual", () => new CasualRider()),
        ("casual+start", () => new CasualRider { PerfectStart = true }),
        ("casual+rail", () => new CasualRider { DriftToRail = true }),
        ("casual+whip", () => new CasualRider { GoodWhips = true }),
        ("casual+start+rail", () => new CasualRider { PerfectStart = true, DriftToRail = true }),
        ("casual+all", () => new CasualRider { PerfectStart = true, DriftToRail = true, GoodWhips = true }),
    };
    foreach (var (name, f) in variants)
    {
        var r = BalanceHarness.RiderVsCpu(rs, f, n, 777);
        Console.WriteLine(name.PadRight(22) + " gained " + r.placesGained.ToString("F2") + " win " + (r.riderWin * 100).ToString("F1") + "% vs cpu " + (r.cpuWin * 100).ToString("F1") + "%");
    }
    return 0;
}
if (args.Length >= 2 && args[0] == "gate-debug")
{
    var node = Muchi.Net.JsonNode.Parse(File.ReadAllText(args[1]));
    foreach (var kv in args.Skip(2)) { var parts = kv.Split('='); node.Set(parts[0], long.Parse(parts[1])); }
    var rs = Muchi.Net.ProtocolCodec.ParseRuleset(node);
    var straight = new Muchi.Engine.TrackSpec { Id = "straight", Surface = Muchi.Engine.Surface.Turf, DistanceM = 2000, Segments = { new Muchi.Engine.TrackSegment(Muchi.Engine.SegmentKind.Straight, 2000) } };
    foreach (var (name, t) in new[] { ("turf2000", SampleRaces.Turf2000()), ("straight2000", straight) })
    {
        var g = BalanceHarness.GateGroupWinRates(rs, 600, 31, t);
        Console.WriteLine(name + " inner " + (g[0] * 100).ToString("F1") + "% mid " + (g[1] * 100).ToString("F1") + "% outer " + (g[2] * 100).ToString("F1") + "%");
    }
    return 0;
}
if (args.Length >= 1 && args[0] == "serve")
{
    string authSecret = VerifierAuth.FromEnvironment(Environment.GetEnvironmentVariable); // fails closed when required
    var serveArgs = args.Skip(1).ToArray();
    var builder = WebApplication.CreateBuilder(serveArgs);
    // Cloud Run passes the port in $PORT; an explicit --urls wins.
    string port = Environment.GetEnvironmentVariable("PORT");
    if (!serveArgs.Contains("--urls") && !string.IsNullOrEmpty(port)) builder.WebHost.UseUrls("http://0.0.0.0:" + port);
    var app = builder.Build();
    if (authSecret == null) app.Logger.LogWarning("verifier auth is OFF (no {Env}); only acceptable for local development", VerifierAuth.SecretEnv);
    app.MapGet("/healthz", () => Results.Text("ok"));
    app.MapPost("/verify", async (HttpRequest req) =>
    {
        if (!VerifierAuth.IsAuthorized(req.Headers.Authorization.ToString(), authSecret))
            return Results.Text("{\"error\":\"unauthorized\"}", "application/json", statusCode: 401);
        using var reader = new StreamReader(req.Body);
        string body = await reader.ReadToEndAsync();
        if (body.Length > VerifyService.MaxBodyBytes) return Results.Text("{\"error\":\"body too large\"}", "application/json", statusCode: 413);
        var (status, json) = VerifyService.Verify(body, withSkills: VerifyService.WantsSkills(req.Headers[VerifyService.SkillsHeader].ToString()));
        return Results.Text(json, "application/json", statusCode: status);
    });
    app.Run();
    return 0;
}
Console.Error.WriteLine("usage: replay <log.json> | golden <outDir> <ruleset.json> | serve [--urls ...]");
return 1;
