// 固有スキル in the game layer (REQ-UXS-050/051): horse detail / gacha / breeding texts from the server's catalog, and the
// race HUD's cut-in read from the engine's Skill events. Uses the committed skill golden race; no network.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class SkillChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
            => Task.FromResult(Routes.TryGetValue(r.Method + " " + r.Path, out var h) ? h(r) : new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    const string Catalog = "{\"skills\":[{\"id\":\"sk_oudou\",\"name\":\"王道の構え\",\"rarity\":\"SSR\",\"styles\":[\"senko\"],\"trigger\":\"finalStraight\",\"value\":4,"
        + "\"speedPermille\":20,\"accelPermille\":0,\"drainSavePermille\":0,\"recoverPermille\":0,\"durationTicks\":80,\"condition\":\"最後の直線で前に4頭以内\",\"effect\":\"4秒間 目標速度+2%\",\"rankedEffect\":\"4秒間 目標速度+1.8%\"}],"
        + "\"notice\":\"固有スキルは条件を満たすと1レースに1回発動します\"}";

    public static async Task Run(Action<bool, string> check, string root)
    {
        // catalog → horse detail
        var s = new FakeServer();
        s.Routes["GET /v1/skills"] = _ => new HttpResponse(200, Catalog);
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var cat = await api.GetSkillsAsync();
        check(cat.Skills.Count == 1 && cat.Find("sk_oudou")?.Trigger == "finalStraight", "skills: catalog parses (GET /v1/skills)");
        var horse = new Horse { Id = "h1", Name = "ギンガノカナタ", SkillId = "sk_oudou" };
        var v = HorseSkillView.ForHorse(horse, cat);
        check(v != null && v.Name == "王道の構え" && v.CappedInRanked && v.DetailText.Contains("ランク戦: 4秒間 目標速度+1.8%"), "skills: horse detail shows condition, effect and the ranked cap");
        check(HorseSkillView.ForHorse(new Horse { Id = "h2" }, cat) == null, "skills: a horse without a skill shows none");

        // gacha odds row and breeding preview (display only)
        var row = Muchi.Net.JsonNode.Parse("{\"templateId\":\"t_ginga\",\"name\":\"ギンガノカナタ\",\"rarity\":\"SSR\",\"ppm\":10000,\"rate\":\"1.0000%\",\"skill\":{\"id\":\"sk_oudou\",\"name\":\"王道の構え\",\"rarity\":\"SSR\",\"condition\":\"最後の直線で前に4頭以内\",\"effect\":\"4秒間 目標速度+2%\"}}");
        var odds = Muchi.Net.JsonNode.Parse("{\"bannerId\":\"b\",\"items\":[" + row + "]}");
        s.Routes["GET /v1/gacha/b/odds"] = _ => new HttpResponse(200, odds.ToString());
        var disclosure = await api.GetOddsAsync("b");
        check(disclosure.Items[0].Skill?.Name == "王道の構え" && disclosure.Items[0].Ppm == 10000, "skills: gacha odds rows carry the skill (ppm untouched)");
        var pvJson = "{\"stats\":{},\"styles\":{},\"distance\":{\"minM\":1400,\"maxM\":2400},\"surface\":\"turf\",\"skill\":{\"nonePermille\":600,\"candidates\":["
            + "{\"id\":\"sk_oudou\",\"name\":\"王道の構え\",\"rarity\":\"SSR\",\"condition\":\"c\",\"effect\":\"e\",\"permille\":200,\"from\":[\"sire\"]},"
            + "{\"id\":\"sk_shippu\",\"name\":\"疾風の先駆け\",\"rarity\":\"SSR\",\"condition\":\"c\",\"effect\":\"e\",\"permille\":200,\"from\":[\"dam\"]}]}}";
        s.Routes["POST /v1/breeding/preview"] = _ => new HttpResponse(200, pvJson);
        var pv = await api.BreedingPreviewAsync("h1", "h2");
        var lines = SkillInheritLines.Of(pv);
        check(lines.Count == 3 && lines[0] == "スキル継承 20.0%  王道の構え ← 父" && lines[2] == "スキルなし 60.0%", "skills: breeding preview lists the inheritance odds from the server");

        // race HUD: the committed skill golden (ruleset 1.3) — cut-ins come from the engine's tick-stamped events
        var doc = Muchi.Net.JsonNode.Parse(File.ReadAllText(Path.Combine(root, "contracts", "golden", "race-turf2000-skills.json")));
        var log = ProtocolCodec.ParseReplayLog(doc.Get("log"));
        var outp = RaceReplay.Run(log.Config, log.Inputs);
        var all = SkillHud.All(outp.Sim, log.Config, -1);
        check(all.Count >= 6 && all.TrueForAll(c => c.SkillName != null && c.HorseName != null), "skills: every fired skill has a cut-in with the horse and skill names");
        check(outp.Result.Hash == doc.Get("expected").Get("resultHash").AsString(), "skills: golden replays to its recorded hash in the game layer");

        // live: step a fresh sim and watch the player's cut-in appear for one second
        // the player = a horse whose skill fires mid-race (not at the gate, where the gate call has the floor)
        int player = outp.Sim.Events.First(e => e.Type == RaceEventType.Skill && e.Tick > log.Config.Ruleset.GateOpenTick + 300).Slot;
        var sim = new RaceSim(log.Config);
        var byTick = log.Inputs.GroupBy(i => i.Tick).ToDictionary(g => g.Key, g => g.ToList());
        int shownFrom = -1, shownTicks = 0;
        bool sawActive = false;
        var cmds = new byte[log.Config.Entrants.Count];
        while (!sim.IsFinished)
        {
            Array.Clear(cmds, 0, cmds.Length);
            if (byTick.TryGetValue(sim.Tick, out var list)) foreach (var r in list) cmds[r.Slot] |= r.Cmd;
            sim.Step(cmds);
            var hud = SkillHud.Build(sim, log.Config, player);
            if (hud.CutIn != null && hud.CutIn.IsPlayer) { if (shownFrom < 0) shownFrom = hud.CutIn.Tick; shownTicks++; }
            if (hud.Active) sawActive = true;
        }
        var final = SkillHud.Build(sim, log.Config, player);
        check(final.HasSkill && final.Fired && final.SkillName == log.Config.Entrants[player].Horse.Skill.Name, "skills: HUD knows the player's skill and that it fired");
        check(shownFrom >= 0 && shownTicks == SkillHud.CutInTicks, "skills: the player's cut-in shows for exactly one second (" + shownTicks + " ticks)");
        check(sawActive, "skills: HUD reports the effect while it runs");
        var none = SkillHud.Build(sim, log.Config, 11);
        check(!none.HasSkill, "skills: a horse without a skill shows no skill on the HUD");

        // commentary: a skill line, deterministic, never overlapping
        var tpl = CommentaryTemplates.Parse(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "commentary-ja.json")));
        List<CommentaryLine> Speak()
        {
            var c = new Commentator(tpl, log.Config, player);
            var sm = new RaceSim(log.Config);
            while (!sm.IsFinished)
            {
                Array.Clear(cmds, 0, cmds.Length);
                if (byTick.TryGetValue(sm.Tick, out var l)) foreach (var r in l) cmds[r.Slot] |= r.Cmd;
                sm.Step(cmds);
                c.Process(sm);
            }
            return c.Lines.ToList();
        }
        var a = Speak();
        var b = Speak();
        check(a.Exists(l => l.Kind == "skill" && l.Slot == player && l.Text.Contains(log.Config.Entrants[player].Horse.Skill.Name)), "skills: the commentary calls the player's skill by name");
        check(a.Select(l => l.ToString()).SequenceEqual(b.Select(l => l.ToString())), "skills: skill commentary is deterministic");
        bool overlap = false;
        for (int i = 1; i < a.Count; i++) if (a[i].Tick < a[i - 1].Tick + a[i - 1].DurationTicks) overlap = true;
        check(!overlap, "skills: commentary lines never overlap with skill lines");
    }
}
