// 観戦中の応援 (REQ-CHEER-001..016, contracts/protocol.md §55): CheerModel over a LockstepClient fed by hand. Spectator: chips
// (horse numbers), the three buttons, the 2 s pace, a toast, the burst and per-horse totals; an older server (no offer) shows
// no buttons. Racer: the indicator for our horse only, the device setting, reduced motion. KPI: one cheer_send / cheer_seen
// per race. The race never changes (same hash with and without cheers). English for every text.
using System.Text.Json;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class CheerChecks
{
    sealed class Recorder : ITransport
    {
        public readonly List<string> Sent = new List<string>();
        public void Send(string message) => Sent.Add(message);
    }

    static RaceConfig Config(RulesetParams rs) => RaceFactory.Practice(rs, new HorseSpec
    {
        Id = "me", Name = "アイボウ", Speed = 600, Stamina = 600, Burst = 600, Guts = 600, Temper = 500, DistMinM = 1600, DistMaxM = 2400, Surface = Surface.Turf,
    }, 7);

    static string Start(RaceConfig cfg, int you, bool offer)
    {
        var o = JsonNode.Obj();
        o.Set("t", "start"); o.Set("you", you); o.Set("startAtMs", 1000L); o.Set("config", ProtocolCodec.ConfigToJson(cfg));
        if (you < 0)
        {
            var sp = JsonNode.Obj(); sp.Set("delayMs", 0);
            if (offer) sp.Set("cheer", JsonNode.Parse("{\"kinds\":[\"go\",\"close\",\"hold\"],\"minIntervalMs\":2000,\"windowMs\":1000}"));
            o.Set("spectator", sp);
        }
        return o.ToString();
    }

    static string Bundle(int from, int to) => "{\"t\":\"b\",\"from\":" + from + ",\"to\":" + to + ",\"in\":[]}";

    public static void Run(Action<bool, string> check, string root, RulesetParams rs)
    {
        var cfg = Config(rs);
        long now = 10_000;
        var events = new List<AnalyticsEvent>();
        var store = new MemoryKeyValueStore();

        // ---- spectator
        var t = new Recorder();
        var spec = new LockstepClient(t, "cheer_ck", "tk");
        spec.HandleMessage(Start(cfg, -1, true));
        var m = new CheerModel(store, () => now, e => events.Add(e));
        m.AttachSpectator(spec);
        check(m.Horses.Count == 12 && m.Horses[0].NumberText == "1番" && m.Horses[0].Selected && m.SelectedSlot == 0, "spectator: chips with horse numbers, the first selected");
        check(m.Buttons.Select(b => b.Label).SequenceEqual(new[] { "いけ！", "差せ！", "粘れ！" }) && m.Buttons.All(b => !b.Enabled), "spectator: three preset buttons, greyed before the race shows");
        spec.HandleMessage(Bundle(0, 19));
        m.Refresh();
        check(m.Available && m.Buttons.All(b => b.Enabled), "spectator: buttons on once the race is live");
        m.Select(2);
        check(m.Send(CheerKinds.Close) && t.Sent.Last() == "{\"t\":\"cheer\",\"slot\":2,\"kind\":\"close\"}" && m.Toast == "3番に「差せ！」", "send: one cheer for the selected horse, toast");
        check(!m.Send(CheerKinds.Go) && m.Buttons.All(b => !b.Enabled) && t.Sent.Count(s => s.Contains("cheer")) == 1, "pace: a second tap within 2 s sends nothing, buttons greyed");
        now += 2000;
        m.Refresh();
        check(m.Buttons.All(b => b.Enabled) && m.Send(CheerKinds.Go), "pace: after 2 s the next cheer goes");
        check(m.Note == CheerModel.PaceNote, "note: the pace line");
        spec.HandleMessage("{\"t\":\"cheers\",\"n\":[[2,\"close\",4],[0,\"go\",1]]}");
        check(m.Burst.Lines.Count == 2 && m.Burst.Lines[0].Slot == 2 && m.Horses[2].Total == 4 && m.Burst.Visible(now), "burst: biggest line first, per-horse totals");
        m.Finish();
        check(events.Count == 2 && events[0].Name == "cheer_send" && events[0].PropsJson.Contains("\"count\":2") && events[1].Name == "cheer_seen" && events[1].PropsJson.Contains("\"role\":\"spectator\"") && events[1].PropsJson.Contains("\"count\":5"),
            "KPI: one cheer_send (2) and one cheer_seen (5) for the race");
        m.Finish();
        check(events.Count == 2, "KPI: never twice");

        // an older server: no offer → no buttons, the unavailable note
        var old = new LockstepClient(new Recorder(), "cheer_ck", "tk");
        old.HandleMessage(Start(cfg, -1, false));
        old.HandleMessage(Bundle(0, 19));
        var mo = new CheerModel(store, () => now);
        mo.AttachSpectator(old);
        check(!mo.Available && mo.Buttons.All(b => !b.Enabled) && mo.Note == CheerModel.UnavailableNote && !mo.Send(CheerKinds.Go), "older server: no cheers, the note says so");

        // ---- racer: our horse only; setting; reduced motion; the race is unchanged
        events.Clear();
        var plain = new LockstepClient(new Recorder(), "cheer_ck", "tk");
        var racer = new LockstepClient(new Recorder(), "cheer_ck", "tk");
        plain.HandleMessage(Start(cfg, 0, false));
        racer.HandleMessage(Start(cfg, 0, false));
        var rm = new CheerModel(store, () => now, e => events.Add(e));
        rm.AttachRacer(racer);
        check(rm.IndicatorOn && !rm.Indicator.Visible(now), "racer: on by default, nothing shown before a cheer");
        for (int from = 0; !plain.Sim.IsFinished && from < rs.MaxTicks; from += 20)
        {
            plain.HandleMessage(Bundle(from, from + 19));
            racer.HandleMessage(Bundle(from, from + 19));
            if (from == 200) racer.HandleMessage("{\"t\":\"cheers\",\"n\":[[0,\"go\",3],[1,\"hold\",9]]}");
        }
        check(plain.Sim.IsFinished && racer.Sim.IsFinished && plain.Sim.Result.Hash == racer.Sim.Result.Hash, "racer: the same result hash with and without cheers");
        check(rm.Indicator.Total == 3 && rm.Indicator.Text == "応援 ×3" && rm.Indicator.Visible(now), "racer: 「応援 ×3」 for our horse only");
        rm.Finish();
        check(events.Count == 1 && events[0].Name == "cheer_seen" && events[0].PropsJson.Contains("\"role\":\"racer\""), "racer KPI: one cheer_seen, no cheer_send");

        rm.IndicatorOn = false;
        var off = new CheerModel(store, () => now, e => events.Add(e), new AccessibilitySettings { ReduceMotion = true });
        var r2 = new LockstepClient(new Recorder(), "cheer_ck", "tk");
        r2.HandleMessage(Start(cfg, 0, false));
        off.AttachRacer(r2);
        r2.HandleMessage("{\"t\":\"cheers\",\"n\":[[0,\"go\",3]]}");
        check(!off.IndicatorOn && !off.Indicator.Visible(now) && off.Indicator.Total == 3, "setting off (stored on the device): counted, never shown");
        off.IndicatorOn = true;
        r2.HandleMessage("{\"t\":\"cheers\",\"n\":[[0,\"go\",1]]}");
        check(off.Indicator.Visible(now) && !off.Indicator.Pulse, "reduced motion: the text without the pulse");
        events.Clear();
        off.Finish();
        check(events.Count == 1 && events[0].PropsJson.Contains("\"count\":1"), "cheer_seen counts only what was on screen");
        rm.IndicatorOn = true;

        // ---- replay markers
        var data = ReplayData.FromJson("{\"raceId\":\"cheer_ck\",\"owner\":\"me\",\"focusSlot\":0,\"playable\":true,\"entrants\":[],\"replayLog\":{\"v\":1,\"config\":"
            + ProtocolCodec.ConfigToJson(cfg) + ",\"endTick\":1600,\"inputs\":[]},\"cheerMoments\":[{\"tick\":800,\"count\":6}]}");
        var marks = CheerModel.MomentMarkers(data);
        check(marks.Count == 1 && Math.Abs(marks[0].Fraction - 0.5) < 1e-9 && marks[0].Caption == "応援 6", "replay: one marker half way, 「応援 6」");

        // ---- English
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        var en = doc.RootElement.GetProperty("strings").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString());
        var texts = new[] { CheerModel.Title, CheerModel.TargetLabel, CheerModel.HorseNumber, CheerModel.PaceNote, CheerModel.FairnessNote, CheerModel.UnavailableNote, CheerModel.SentToast,
            CheerModel.IndicatorSetting, CheerModel.IndicatorSettingDesc, CheerModel.MomentLabel, CheerModel.MomentCount, CheerIndicator.TextFormat, CheerKinds.LabelGo, CheerKinds.LabelClose, CheerKinds.LabelHold };
        check(texts.All(x => en.ContainsKey(x)), "English: every cheer text is in ui-en.json");
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.SetLocale("en");
        try { check(Loc.T("3番に「差せ！」") == "\"Close in!\" for No. 3" && Loc.T("応援 ×12") == "Cheers ×12", "English: templates fill in"); }
        finally { Loc.SetLocale("ja"); }
    }
}
