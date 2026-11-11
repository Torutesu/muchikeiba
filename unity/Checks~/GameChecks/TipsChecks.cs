// チュートリアルのやり直しとヒント集 (REQ-TUT-001..018, contracts/protocol.md §57): TipsModel over a fake API and
// TutorialReplayModel over a real offline GameBackend. Topics and cards, a closed card never opens, the "?" contexts
// (tip_context_open + tip_view), NEW cleared at once and sent in batches of at most 20 (offline kept on the device, sent on
// the next load, a failure keeps the rest), tours (only open ones, only open pages, start / finish), and the race lessons:
// the whip lesson is the FTUE tutorial race (honest rule, never assisted), the others the practice race without assist,
// and no lesson touches the FTUE step, its attempt count or its tutorial_step KPI.
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class TipsChecks
{
    sealed class FakeApi : ITipsApi
    {
        public readonly List<List<string>> Seen = new List<List<string>>();
        public int FailSeen;
        public int IndexCalls;

        public Task<TipsIndex> GetTipsAsync(CancellationToken ct = default)
        {
            IndexCalls++;
            var i = new TipsIndex { Enabled = true, Version = 1, Lang = "ja", NewCount = 30 };
            i.Topics.Add(new TipTopicInfo { Id = TipTopics.Race, Title = "レース", Count = 2 });
            i.Topics.Add(new TipTopicInfo { Id = TipTopics.Scout, Title = "スカウト", Count = 1 });
            i.Topics.Add(new TipTopicInfo { Id = TipTopics.Horses, Title = "馬を育てる", Count = 1 });
            i.Tips.Add(new TipCard { Id = "whip_window", Topic = TipTopics.Race, Art = "whip", Unlocked = true, New = true, Title = "光ったら、ムチ", Body = "最後の直線で…", HelpArticleId = "whip" });
            i.Tips.Add(new TipCard { Id = "whip_spacing", Topic = TipTopics.Race, Art = "whip", Unlocked = true, New = true, Title = "ムチは間をあけて", Body = "ムチは1レースで6回まで…" });
            i.Tips.Add(new TipCard { Id = "scout_pity_tip", Topic = TipTopics.Scout, Art = "pity", Unlocked = true, New = true, Title = "交換ptで選べる", Body = "常設では100回分で…" });
            i.Tips.Add(new TipCard { Id = "breeding_pair", Topic = TipTopics.Horses, Art = "breeding", Unlock = "breeding", Unlocked = false, New = false, Title = "配合のきほん", Body = null });
            for (int n = 0; n < 26; n++) i.Tips.Add(new TipCard { Id = "extra_" + n, Topic = TipTopics.Race, Art = "whip", Unlocked = true, New = true, Title = "x", Body = "y" });
            i.Tutorials.Add(new TutorialEntry { Id = "race_whip", Kind = TutorialEntry.KindRace, Lesson = RaceLessons.Whip, Unlocked = true, Title = "ムチのタイミング", Tips = { "whip_window", "whip_spacing" } });
            i.Tutorials.Add(new TutorialEntry { Id = "race_reins", Kind = TutorialEntry.KindRace, Lesson = RaceLessons.Reins, Unlocked = true, Title = "手綱", Tips = { "whip_window" } });
            i.Tutorials.Add(new TutorialEntry { Id = "tour_scout", Kind = TutorialEntry.KindTour, Unlock = "scout", Unlocked = true, Title = "スカウトのツアー", Tips = { "scout_pity_tip", "breeding_pair", "whip_window" } });
            i.Tutorials.Add(new TutorialEntry { Id = "tour_breeding", Kind = TutorialEntry.KindTour, Unlock = "breeding", Unlocked = false, Title = "配合のツアー", Tips = { "breeding_pair" } });
            i.Contexts[TipContexts.GachaOdds] = "scout_pity_tip";
            i.Contexts[TipContexts.Breeding] = "breeding_pair";
            return Task.FromResult(i);
        }

        public Task<TipsSeenResult> MarkTipsSeenAsync(IReadOnlyCollection<string> ids, CancellationToken ct = default)
        {
            if (FailSeen > 0) { FailSeen--; throw new NetworkException("offline", null); }
            Seen.Add(ids.ToList());
            return Task.FromResult(new TipsSeenResult { Marked = ids.ToList(), NewCount = 0 });
        }
    }

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var ev = new List<AnalyticsEvent>();
        var api = new FakeApi();
        var kv = new MemoryKeyValueStore();
        bool online = true;
        var m = new TipsModel(api, kv, () => online, ev.Add, () => 1000);
        await m.LoadAsync();
        check(m.Index != null && m.Topic == TipTopics.Race && m.Cards.All(c => c.Topic == TipTopics.Race), "loads the index; the first topic is shown");
        check(m.Lessons.Count() == 2 && m.Tours.Count() == 2, "lessons and tours are listed apart");
        int before = m.NewCount;
        check(!m.OpenCard("breeding_pair") && m.Open == null, "a closed card never opens (title + 「" + TipsModel.LockedText + "」 only)");
        check(m.OpenCard("whip_window") && m.Open.Id == "whip_window" && !m.Open.New && m.NewCount == before - 1, "reading a card clears its NEW at once");
        check(ev.Last().Name == "tip_view" && ev.Last().PropsJson.Contains("\"source\":\"list\""), "tip_view with source list");
        ev.Clear();
        var ctx = m.OpenContext(TipContexts.GachaOdds);
        check(ctx?.Id == "scout_pity_tip" && ev.Select(e => e.Name).SequenceEqual(new[] { "tip_context_open", "tip_view" }) && ev[1].PropsJson.Contains("context"),
            "the rates screen's 「？」 opens the pity card: tip_context_open then tip_view (context)");
        check(m.OpenContext(TipContexts.Breeding) == null && m.OpenContext("home") == null, "a 「？」 to a closed card or an unknown screen opens nothing");

        // tours: only open ones, only open pages, start / finish
        ev.Clear();
        check(!m.StartTour("tour_breeding") && m.Message == TipsModel.TourLockedText, "a tour of a closed feature does not start");
        check(!m.StartTour("race_whip"), "a race lesson is not a tour");
        check(m.StartTour("tour_scout") && m.TourPages.Count == 2 && m.TourPages.All(p => p.Unlocked), "the scout tour pages are its open cards (the closed one is left out)");
        bool more = m.NextPage();
        check(more && m.TourOnLastPage && m.Open.Id == "whip_window", "next page");
        check(!m.NextPage() && m.Tour == null, "after the last page the tour closes");
        var names = ev.Select(e => e.Name + (e.PropsJson.Contains("\"stage\":\"finish\"") ? ":finish" : e.PropsJson.Contains("\"stage\":\"start\"") ? ":start" : "")).ToList();
        check(names.SequenceEqual(new[] { "tutorial_replay:start", "tip_view", "tip_view", "tutorial_replay:finish" }), "tour KPI: start, a tip_view per page, finish (" + string.Join(",", names) + ")");

        // seen ids: batches of at most 20; offline kept on the device; a failure keeps the rest
        foreach (var c in m.Index.Tips.Where(t => t.Id.StartsWith("extra_"))) m.OpenCard(c.Id);
        int pending = m.PendingSeen.Count;
        await m.FlushSeenAsync();
        check(api.Seen.Count == 2 && api.Seen.All(b => b.Count <= ApiClient.TipsSeenMaxPerRequest) && api.Seen.Sum(b => b.Count) == pending && m.PendingSeen.Count == 0,
            "read cards go out in batches of at most 20 (" + string.Join("+", api.Seen.Select(b => b.Count)) + ")");
        online = false;
        m.OpenCard("whip_spacing");
        await m.FlushSeenAsync();
        check(m.PendingSeen.SequenceEqual(new[] { "whip_spacing" }) && kv.Get(TipsModel.KeyPendingSeen) == "whip_spacing" && api.Seen.Count == 2, "offline: the read card is kept on the device, nothing sent");
        await m.LoadAsync();
        check(m.Message == TipsModel.OfflineText && m.Index != null, "offline load: the message, the last index stays");
        var m2 = new TipsModel(api, kv, () => true, ev.Add, () => 1000);
        api.FailSeen = 1;
        await m2.LoadAsync();
        check(m2.PendingSeen.Count == 1 && !m2.Index.Card("whip_spacing").New, "a failed send keeps the id, and the card stays read after a reload");
        await m2.LoadAsync();
        check(m2.PendingSeen.Count == 0 && api.Seen.Last().SequenceEqual(new[] { "whip_spacing" }), "the next load sends it (once)");

        // race lessons on a real offline backend: never the FTUE's state
        var bkv = new MemoryKeyValueStore();
        bkv.Set(OnboardingFlow.KeyStep, ((int)FtueStep.Done).ToString());
        bkv.Set(GameBackend.KeyTutorialAttempts, "2");
        bkv.Set(OnboardingFlow.KeyKpiSent, "consent,race1_start,race1_whip,race1_win");
        var b = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, bkv, ruleset);
        b.AssistLevel = AssistLevel.Full;
        var rev = new List<AnalyticsEvent>();
        var r = new TutorialReplayModel(b, rev.Add, () => 5000, () => 7);
        check(!r.Open(m.Index.Tutorial("tour_scout")), "a tour is not a race lesson");
        check(r.Open(m.Index.Tutorial("race_whip")), "opens the whip lesson");
        var lost = r.StartRace();
        check(lost is OfflineRaceDriver od && od.Race.Director is TutorialDirector td && td.Attempt == 1 && od.Config.Track.Id == "tutorial_straight_400",
            "the whip lesson is the FTUE tutorial race with its director (attempt 1: the honest rule)");
        check(AssistModel.RidingLevel(lost) == AssistLevel.Off, "never assisted, even with かんたん操作 on");
        var lostRes = Drive(lost, new int[0]);
        r.FinishRace(lostRes);
        check(!r.Won && r.ResultText == TutorialReplayModel.WhipLostText && lostRes.Place == 2, "no whips: a close 2nd and 「" + TutorialReplayModel.WhipLostText + "」");
        for (int i = 0; i < 3; i++) { var again = r.StartRace(); var res = Drive(again, new int[0]); r.FinishRace(res); }
        check(!r.Won && r.Tries == 4, "the 4th try without whips is still a 2nd: a replay is never assisted to a win (REQ-UXS-004 is the FTUE's only)");
        var win = r.StartRace();
        r.FinishRace(Drive(win, new[] { 260, 180 }));
        check(r.Won && r.ResultText == TutorialReplayModel.WonText, "two whips in the last 300 m win: 「差し切った！」");
        check(rev.Count == 10 && rev.All(e => e.Name == "tutorial_replay"), "tutorial_replay start / finish per try (" + rev.Count + " rows), no tutorial_step");
        check(bkv.Get(GameBackend.KeyTutorialAttempts) == "2" && bkv.Get(OnboardingFlow.KeyStep) == ((int)FtueStep.Done).ToString() && bkv.Get(OnboardingFlow.KeyKpiSent) == "consent,race1_start,race1_whip,race1_win",
            "the FTUE step, the tutorial attempt count and the sent FTUE KPI steps are untouched");
        check(r.Open(m.Index.Tutorial("race_reins")), "opens the reins lesson");
        var reins = r.StartRace();
        // R19 integration: one practice path — the lesson race is built by §50's PracticeSession (the built-in catalog offline),
        // not by a second race builder; it carries no かんたん操作 and the practice options (band, slow, ghost) stay off
        check(reins is OfflineRaceDriver pd && pd.Config.RaceId.StartsWith(PracticeSession.RaceIdPrefix) && PracticeSession.IsPractice(pd.Config)
            && AssistModel.RidingLevel(reins) == AssistLevel.Off, "the other lessons ride a §50 practice race (PracticeSession), without かんたん操作");
        var reins2 = (OfflineRaceDriver)r.StartRace();
        check(reins2.Config.RaceId != ((OfflineRaceDriver)reins).Config.RaceId, "each lesson try is a new practice seed");
        check(TutorialReplayModel.FocusOf(RaceLessons.Reins).Contains(RaceFeelCueKind.Kakari) && TutorialReplayModel.FocusOf(RaceLessons.Whip).Contains(RaceFeelCueKind.WhipChance)
            && RaceLessons.All.All(l => TutorialReplayModel.FocusOf(l).Length > 0), "each lesson highlights its RaceFeel cues");
        check(b.CreatePracticeRace(1) is IRaceDriver p0 && AssistModel.RidingLevel(p0) == AssistLevel.Full, "the normal practice race still carries かんたん操作 (unchanged)");
    }

    static RaceResultModel Drive(IRaceDriver d, int[] whipAtM)
    {
        var obs = new RaceObserver(d);
        var input = new RaceInput();
        long now = 2_000_000;
        int k = 0;
        for (int f = 0; f < 60 * 300 && !d.Done; f++)
        {
            var sim = d.Sim;
            if (sim != null && d.PlayerSlot >= 0)
            {
                var me = sim.GetHorse(d.PlayerSlot);
                long rem = (sim.Track.Distance - me.Distance).ToMilli();
                if (!me.Departed && sim.GateOpened) input.Spur();
                else if (me.Departed && k < whipAtM.Length && rem <= whipAtM[k] * 1000L) { input.Spur(); k++; }
                d.Input(input.Collect(me));
            }
            d.Update(now);
            obs.Hud(now);
            now += 16;
        }
        var r = RaceResultModel.Build(d, obs);
        obs.Dispose();
        return r;
    }
}
