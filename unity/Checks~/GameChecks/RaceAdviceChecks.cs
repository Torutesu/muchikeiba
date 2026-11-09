// 出走前アドバイス (REQ-ADV-001..016, contracts/protocol.md §39): RaceAdviceModel over a fake API fed with the shared vectors.
// The panel rows use words (never betting marks), the selected horse's tips are recomputed on the device and equal the
// server's, the setting turns everything off (no request, no KPI), the tutorial is fixed, offline computes on the device,
// advice_view / advice_follow, the whip line on the result screen, English.
using Muchi.Client;
using Muchi.Game;
using Muchi.Net;

static class RaceAdviceChecks
{
    sealed class FakeApi : IRaceAdviceApi
    {
        public readonly List<string> Calls = new List<string>();
        public RaceAdviceResult Reply;
        public bool Fail;
        public Task<RaceAdviceResult> GetRaceAdviceAsync(RaceAdviceQuery query, CancellationToken ct = default)
        {
            Calls.Add(query.Context + ":" + (query.TrackId ?? query.ChallengeId ?? "-"));
            if (Fail) throw new ApiException(ApiErrorCode.Network, "NETWORK", "down", 0);
            return Task.FromResult(Reply);
        }
    }

    public static Task Run(Action<bool, string> check, string root)
    {
        var vectors = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "contracts", "race-advice.vectors.json"))).Get("cases");
        JsonNode Case(int i) => vectors[i];
        RaceAdviceResult ServerReply(int i, string context)
        {
            var o = JsonNode.Parse(Case(i).Get("output").ToString());
            o.Set("context", context);
            o.Set("input", Case(i).Get("input"));
            return RaceAdviceResult.Parse(o);
        }
        return RunAsync(check, ServerReply, Case);
    }

    static async Task RunAsync(Action<bool, string> check, Func<int, string, RaceAdviceResult> serverReply, Func<int, JsonNode> caseOf)
    {
        var api = new FakeApi { Reply = serverReply(3, "friend") }; // minato soft 2400, focus on the nige horse
        var kv = new MemoryKeyValueStore();
        var events = new List<string>();
        var m = new RaceAdviceModel(api, kv, () => true, e => events.Add(e.Name), () => 1);
        check(m.Enabled, "advice is on by default");
        await m.OpenAsync(new RaceAdviceQuery { Context = "friend", TrackId = "minato_turf_2400", Going = "soft", HorseId = "h3" });
        check(m.Visible && api.Calls.Count == 1 && !m.ComputedOnDevice, "opened from the server");
        var rows = m.Rows;
        check(rows.Count == 3 && rows[0].GradeText == "よく合う" && rows[0].Suggested && rows[2].GradeText == "条件外あり", "rows: words for the fit, the suggestion marked (" + string.Join(",", rows.Select(r => r.GradeText)) + ")");
        check(rows.All(r => !r.GradeText.Contains("◎") && !r.GradeText.Contains("○") && !r.GradeText.Contains("△")), "no betting marks");
        check(rows.First(r => r.HorseId == "h3").Selected, "the horse picked on screen is selected");
        check(m.Lines.Any(l => l.Contains("気性が荒い")), "tips are about the selected horse (temper 380: the rein tip)");
        check(m.Lines.All(l => RaceAdvice.BannedJa.All(w => !l.Contains(w))), "no banned word in the lines");

        // the player switches horse: recomputed on the device, equal to what the server says for that focus
        m.Select("h2");
        var expected = RaceAdvice.Compute(AdviceInput.Parse(caseOf(3).Get("input")).WithFocus("h2"));
        check(m.ComputedOnDevice && m.SelectedHorseId == "h2" && !m.Lines.Any(l => l.Contains("気性が荒い")) && m.Lines.Count == expected.Lines.Count, "selecting another horse recomputes the tips on the device");
        check(api.Calls.Count == 1, "no second request for a selection change");

        // KPI: advice_view once per opening, advice_follow once per entry, only with a suggestion
        m.OnEnter("h2");
        m.OnEnter("h2");
        check(events.SequenceEqual(new[] { "advice_view", "advice_follow" }), "advice_view then advice_follow, once each (" + string.Join(",", events) + ")");

        // the whip line on the result screen (REQ-ADV-014)
        var rec = new RaceDebriefRecorder(0);
        rec.WhipRemainingMm.Add(380_000);
        check(m.DebriefLine(rec) == "ムチはアドバイスどおり残り400mから", "the result line: the whip followed the tip");
        var early = new RaceDebriefRecorder(0);
        early.WhipRemainingMm.Add(700_000);
        check(m.DebriefLine(early) == "ムチがアドバイス（残り400m）より早かった", "the result line: too early");

        // the setting: off = no request, no panel, no KPI
        m.Enabled = false;
        check(kv.Get(RaceAdviceModel.KeyEnabled) == "0", "the setting is stored on the device");
        events.Clear();
        await m.OpenAsync(new RaceAdviceQuery { Context = "ranked" });
        check(!m.Visible && m.Message == RaceAdviceModel.OffText && api.Calls.Count == 1 && events.Count == 0, "off: no request, no panel, no KPI");
        m.OnEnter("h1");
        check(events.Count == 0, "off: no advice_follow");

        // the tutorial is fixed and shown even with the setting off
        await m.OpenAsync(new RaceAdviceQuery { Context = "tutorial" });
        check(m.Visible && m.Result.Tutorial && m.Rows.Count == 0 && m.Lines.Count == 2 && api.Calls.Count == 1, "tutorial: the fixed version, no request, no ranking");
        m.Enabled = true;

        // offline: the game's own input is computed on the device (the same function as the server)
        var off = new RaceAdviceModel(new FakeApi { Fail = true }, new MemoryKeyValueStore(), () => true);
        var input = AdviceInput.Parse(caseOf(1).Get("input"));
        await off.OpenAsync(new RaceAdviceQuery { Context = "friend", TrackId = "bellmoor_turf_1200" }, input);
        check(off.Visible && off.ComputedOnDevice && off.SuggestedHorseId == "h6", "server down: computed on the device from the local input");
        var none = new RaceAdviceModel(api, new MemoryKeyValueStore(), () => false);
        await none.OpenAsync(new RaceAdviceQuery { Context = "ranked" });
        check(!none.Visible && none.Message != null, "offline without local data: nothing invented");

        // English: the device-computed lines translate with the server table
        Loc.SetLocale("en");
        var enLines = off.Lines;
        var enRows = off.Rows;
        Loc.SetLocale("ja");
        check(enLines.All(l => !Loc.HasJapanese(l.Replace("アオゾラマーチ", "").Replace("一番槍", ""))) && enRows[0].GradeText == "Good fit", "English lines and grade words (" + string.Join(" | ", enLines.Take(2)) + ")");
        Loc.SetLocale("en");
        var foot = Loc.T(RaceAdviceModel.Footnote);
        var offText = Loc.T(RaceAdviceModel.OffText);
        Loc.SetLocale("ja");
        check(!Loc.HasJapanese(foot) && !Loc.HasJapanese(offText) && !foot.ToLowerInvariant().Contains("odds") && !foot.ToLowerInvariant().Contains("chance"), "footnote and the off text in English: " + foot);
    }
}
