// Time attack end to end (REQ-TA-*): start on the TS server → ride on the device with the Unity client SDK
// (OfflineRace) → submit inputs → the server re-simulates with the real C# verifier → personal best,
// ghost published → download the ghost and replay it with GhostPlayer → same finish.
// Also checks: a retried submit returns the stored result, and a tampered run is rejected.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Net;

sealed class TimeAttackReport
{
    public bool ok { get; set; }
    public string user { get; set; }
    public string sessionId { get; set; }
    public string localHash { get; set; }
    public string serverHash { get; set; }
    public long localTimeMs { get; set; }
    public long serverTimeMs { get; set; }
    public bool seasonBest { get; set; }
    public bool published { get; set; }
    public bool retryReturnedSameResult { get; set; }
    public int tamperedStatus { get; set; }
    public string tamperedCode { get; set; }
    public long ghostTimeMs { get; set; }
    public List<string> problems { get; set; } = new();
}

static class TimeAttackScenario
{
    const string Track = "kirameki_turf_2000";

    static (OfflineRace race, string configRaw, string sessionId, string token) Run(JsonNode start, bool whip = true)
    {
        var cfgNode = start.Get("config");
        var cfg = ProtocolCodec.ParseConfig(cfgNode);
        var race = new OfflineRace(cfg, 0);
        var p = race.Sim.P;
        int lastWhip = -100, whips = 0;
        while (!race.IsFinished)
        {
            int tick = race.Sim.Tick;
            var left = race.Sim.Track.Distance - race.Sim.GetHorse(0).Distance;
            if (tick == p.GateOpenTick) race.Input(Cmd.Start);
            if (whip && left <= Fx.FromInt(400) && whips < p.MaxWhips && tick - lastWhip >= 24) { whips++; lastWhip = tick; race.Input(Cmd.Whip); }
            race.StepOnce();
        }
        return (race, cfgNode.ToString(), start.Get("sessionId").AsString(), start.Get("token").AsString());
    }

    static string SubmitBody(string sessionId, string token, IEnumerable<InputRecord> inputs, string hash, string configRaw)
    {
        var b = JsonNode.Obj();
        b.Set("sessionId", sessionId);
        b.Set("token", token);
        b.Set("resultHash", hash);
        var arr = JsonNode.Arr();
        foreach (var r in inputs)
        {
            var t = JsonNode.Arr();
            t.Add(JsonNode.Num(r.Tick)); t.Add(JsonNode.Num(r.Slot)); t.Add(JsonNode.Num(r.Cmd));
            arr.Add(t);
        }
        b.Set("inputs", arr);
        b.Set("config", JsonNode.Parse(configRaw));
        return b.ToString();
    }

    public static async Task<TimeAttackReport> RunAsync(Bot bot)
    {
        var rep = new TimeAttackReport { user = bot.Report.user };
        var startBody = "{\"trackId\":\"" + Track + "\",\"horseId\":\"" + bot.HorseId + "\"}";

        // 1) honest run
        var (st, stText) = await bot.SendRawAsync(HttpMethod.Post, "/v1/time-attack/start", startBody);
        if (st != 200) { rep.problems.Add("start " + st + " " + stText); return rep; }
        var (race, cfgRaw, sid, token) = Run(JsonNode.Parse(stText));
        rep.sessionId = sid;
        rep.localHash = race.ResultHash;
        rep.localTimeMs = race.FinishTimeMs(0);
        string body = SubmitBody(sid, token, race.RecordedInputs, race.ResultHash, cfgRaw);
        var (s1, t1) = await bot.SendRawAsync(HttpMethod.Post, "/v1/time-attack/submit", body);
        if (s1 != 200) { rep.problems.Add("submit " + s1 + " " + t1); return rep; }
        var r1 = JsonNode.Parse(t1);
        rep.serverHash = r1.Get("resultHash").AsString();
        rep.serverTimeMs = r1.Get("timeMs").AsLong();
        rep.seasonBest = r1.Get("seasonBest").AsBool();
        rep.published = r1.Get("published").AsBool();
        if (rep.serverHash != rep.localHash) rep.problems.Add("hash differs");
        if (rep.serverTimeMs != rep.localTimeMs) rep.problems.Add("time differs");
        if (!rep.seasonBest || !rep.published) rep.problems.Add("not recorded as a published personal best");

        // 2) retried submit → stored result, not a second submission
        var (s2, t2) = await bot.SendRawAsync(HttpMethod.Post, "/v1/time-attack/submit", body);
        rep.retryReturnedSameResult = s2 == 200 && JsonNode.Parse(t2).Get("timeMs").AsLong() == rep.serverTimeMs;
        if (!rep.retryReturnedSameResult) rep.problems.Add("retry " + s2 + " " + t2);

        // 3) tampered run: drop the gate START (the horse then starts late) but claim the honest hash
        var (st3, st3Text) = await bot.SendRawAsync(HttpMethod.Post, "/v1/time-attack/start", startBody);
        var (race3, cfg3, sid3, token3) = Run(JsonNode.Parse(st3Text));
        var forged = race3.RecordedInputs.ToList();
        forged.RemoveAt(forged.FindIndex(r => (r.Cmd & Cmd.Start) != 0));
        var (s3, t3) = await bot.SendRawAsync(HttpMethod.Post, "/v1/time-attack/submit", SubmitBody(sid3, token3, forged, race3.ResultHash, cfg3));
        rep.tamperedStatus = s3;
        rep.tamperedCode = s3 >= 400 ? JsonNode.Parse(t3).Get("error").Get("code").AsString() : null;
        if (rep.tamperedCode != "TA_RESULT_MISMATCH") rep.problems.Add("tampered run not rejected: " + s3 + " " + t3);

        // 4) my ghost → download → replay with the client SDK → same finish time
        var (s4, t4) = await bot.SendRawAsync(HttpMethod.Get, "/v1/time-attack/" + Track + "/ghosts?kind=me");
        var list = JsonNode.Parse(t4).Get("ghosts");
        if (s4 != 200 || list.Count != 1) { rep.problems.Add("ghost list " + s4 + " " + t4); return rep; }
        var (s5, t5) = await bot.SendRawAsync(HttpMethod.Get, list[0].Get("path").AsString());
        if (s5 != 200) { rep.problems.Add("ghost download " + s5); return rep; }
        var gp = new GhostPlayer(Ghost.Parse(JsonNode.Parse(t5)));
        gp.RunToEnd();
        rep.ghostTimeMs = gp.FinishTimeMs;
        if (rep.ghostTimeMs != rep.serverTimeMs) rep.problems.Add("ghost replay time differs");

        rep.ok = rep.problems.Count == 0;
        return rep;
    }
}
