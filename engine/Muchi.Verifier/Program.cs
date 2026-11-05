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
    foreach (var path in GoldenGenerator.WriteAll(args[1], File.ReadAllText(args[2])))
        Console.WriteLine("wrote " + path);
    return 0;
}
if (args.Length >= 2 && args[0] == "balance")
{
    var rsNode = Muchi.Net.JsonNode.Parse(File.ReadAllText(args[1]));
    // track options: surface=turf|dirt going=<name> apt=mix ; everything else overrides a ruleset key
    string surface = "turf", goingName = null; bool aptMix = false;
    foreach (var kv in args.Skip(3))
    {
        var parts = kv.Split('=');
        if (parts[0] == "surface") surface = parts[1];
        else if (parts[0] == "going") goingName = parts[1];
        else if (parts[0] == "apt") aptMix = parts[1] == "mix";
        else rsNode.Set(parts[0], long.Parse(parts[1]));
    }
    var rs = Muchi.Net.ProtocolCodec.ParseRuleset(rsNode);
    int n = args.Length >= 3 ? int.Parse(args[2]) : 200;
    var track = surface == "dirt" ? SampleRaces.Dirt1800() : SampleRaces.Turf2000();
    if (goingName != null) track.Going = Muchi.Net.ProtocolCodec.ParseGoing(goingName, track.Surface);
    var rep = BalanceProbe.Run(rs, n, 1, 150, track, aptMix);
    Console.Write(rep.Describe(20, rs.GateOpenTick));
    return 0;
}
if (args.Length >= 1 && args[0] == "serve")
{
    var builder = WebApplication.CreateBuilder(args.Skip(1).ToArray());
    var app = builder.Build();
    app.MapGet("/healthz", () => Results.Text("ok"));
    app.MapPost("/verify", async (HttpRequest req) =>
    {
        using var reader = new StreamReader(req.Body);
        string body = await reader.ReadToEndAsync();
        if (body.Length > VerifyService.MaxBodyBytes) return Results.Text("{\"error\":\"body too large\"}", "application/json", statusCode: 413);
        var (status, json) = VerifyService.Verify(body);
        return Results.Text(json, "application/json", statusCode: status);
    });
    app.Run();
    return 0;
}
Console.Error.WriteLine("usage: replay <log.json> | golden <outDir> <ruleset.json> | serve [--urls ...]");
return 1;
