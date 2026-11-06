// Round 9 game-layer checks (docs/planning/06 §7 item 12 / §7.3): replay share (ReplayShareModel → IClipRecorder → IShareSheet,
// REQ-UXS-070..072), the one-time account-link prompt (REQ-UXS-073) and the time attack ghost picker defaulting to friends
// (REQ-UXS-074).
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class Round9Checks
{
    sealed class FakeRecorder : IClipRecorder
    {
        public bool Video = true, Throw;
        public int Frames, Stills, Cancels, Begins;
        public ShareCard Card;
        public bool SupportsVideo => Video;
        public void Begin(ReplayClip clip, ShareCard card) { Begins++; Card = card; }
        public Task CaptureFrameAsync(ReplayClipFrame frame, CancellationToken ct) { if (Throw && Frames > 10) throw new IOException("disk full"); Frames++; return Task.CompletedTask; }
        public Task<string> FinishAsync(CancellationToken ct) => Task.FromResult("/tmp/clip.mp4");
        public Task<string> CaptureStillAsync(ReplayClipFrame frame, ShareCard card, CancellationToken ct) { Stills++; Card = card; return Task.FromResult("/tmp/card.png"); }
        public void Cancel() => Cancels++;
    }

    sealed class FakeSheet : IShareSheet
    {
        public bool Answer = true;
        public string Path, Text;
        public Task<bool> ShareAsync(string filePath, string text, CancellationToken ct) { Path = filePath; Text = text; return Task.FromResult(Answer); }
    }

    sealed class FakeAuth : IFirebaseAuthBackend
    {
        public bool Anonymous = true;
        public string Uid = "anon";
        public bool HasUser => true;
        public bool IsAnonymous => Anonymous;
        public string UserId => Uid;
        public Task SignInAnonymouslyAsync(CancellationToken ct) => Task.CompletedTask;
        public void SignOut() { }
        public Task<string> GetIdTokenAsync(bool force, CancellationToken ct) => Task.FromResult("tok");
        public Task LinkAsync(FederatedCredential c, CancellationToken ct) { Anonymous = false; return Task.CompletedTask; }
        public Task SignInWithAsync(FederatedCredential c, CancellationToken ct) => Task.CompletedTask;
    }

    static (AnalyticsClient client, List<AnalyticsEvent> sent) Analytics()
    {
        var sent = new List<AnalyticsEvent>();
        var c = new AnalyticsClient((p, v, ev, ct) => { sent.AddRange(ev); return Task.FromResult(new AnalyticsIngestResult { Accepted = ev.Count }); }, new AnalyticsOptions());
        return (c, sent);
    }

    /// <summary>A practice race ridden like the race screen: start on the gate, whips from 350 m.</summary>
    static OfflineRaceDriver Ridden(RulesetParams ruleset, string name, ulong seed)
    {
        var horse = RaceFactory.DefaultPartner(name);
        var d = new OfflineRaceDriver(RaceFactory.Practice(ruleset, horse, seed), 0, autoStart: true);
        var input = new RaceInput();
        long now = 1_000_000;
        int whips = 0;
        for (int f = 0; f < 60 * 300 && !d.Done; f++)
        {
            var me = d.Sim.GetHorse(0);
            long rem = (d.Sim.Track.Distance - me.Distance).ToMilli();
            if (me.Departed && whips < 3 && rem <= (350 - whips * 70) * 1000L) { input.Spur(); whips++; }
            d.Input(input.Collect(me));
            d.Update(now);
            now += 16;
        }
        return d;
    }

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        // ---------------------------------------------------------------- replay share
        var d = Ridden(ruleset, "アカツキ", 21);
        check(d.Done && ReplayShareModel.CanShare(d), "a finished race the player rode can be shared");
        var share = ReplayShareModel.From(d, "きらめき競馬場 芝2000m");
        check(share != null && share.Clip.ResultHash == d.Sim.Result.Hash, "the clip re-simulates the race from config + inputs to the same hash (" + share?.Clip.ResultHash.Substring(0, 12) + ")");
        var clip = share.Clip;
        var startState = clip.StatesAt(clip.StartTick)[0];
        double startRem = d.Config.Track.DistanceM - TrackGeometry.DistanceM(startState.Distance);
        check(clip.DurationMs <= 10_000 && startRem <= 200.01 && clip.FinishAtMs > 0,
            "clip: last " + startRem.ToString("0") + " m, " + clip.DurationMs + " ms (≤ 10 s), finish at " + clip.FinishAtMs + " ms, " + clip.FrameCount + " frames @30fps");
        int place = Array.IndexOf(d.Sim.Result.Order, 0) + 1;
        var card = share.Card;
        check(card.Watermark == "ムチ一閃" && card.HorseName == "アカツキ" && card.CourseName == "きらめき競馬場 芝2000m" && card.PlaceText == place + "着 / 12頭"
              && card.TimeText == HudModel.FormatTime(d.Race.FinishTimeMs(0)),
            "share card: " + card.PlaceText + " " + card.TimeText + " " + card.HorseName + " " + card.CourseName + " / watermark " + card.Watermark);
        string all = string.Join("|", card.Watermark, card.PlaceText, card.TimeText, card.HorseName, card.CourseName, card.ModeLabel, card.ShareText, string.Join("|", card.SkillLines));
        check(!all.Contains("local") && d.Config.Entrants.Skip(1).All(e => !all.Contains(e.Horse.Name)), "share card: no player id, no rival names (only the chosen horse) — " + card.ShareText);
        var posed = share.Pose(clip.Frame(clip.FrameCount / 2));
        check(posed.Horses.Length == 12 && posed.Camera.FieldOfViewDegrees > 0 && RaceCameraRig.InFrame(clip.Frame(clip.FrameCount / 2).Camera, clip.PoseOf(clip.Frame(clip.FrameCount / 2), 0), 1.2),
            "a posed frame places all 12 horses and a camera that has the partner in frame (" + posed.Camera.Mode + ")");

        var rec = new FakeRecorder(); var sheet = new FakeSheet(); var (an, sent) = Analytics();
        int posedFrames = 0;
        var outc = await share.RecordAndShareAsync(rec, sheet, p => posedFrames++, an, () => 1_700_000_000_000);
        await an.FlushAllAsync(1_700_000_001_000);
        check(outc.Kind == ShareOutcomeKind.Shared && rec.Begins == 1 && rec.Frames == clip.FrameCount && posedFrames == clip.FrameCount && sheet.Path == "/tmp/clip.mp4" && sheet.Text == card.ShareText,
            "video: every frame is posed then captured, the file goes to the share sheet with the card's text");
        check(sent.Count(e => e.Name == "share") == 1, "`share` KPI (replay_video) sent once after sharing");
        var (an2, sent2) = Analytics();
        var o2 = await share.RecordAndShareAsync(new FakeRecorder(), new FakeSheet { Answer = false }, null, an2);
        await an2.FlushAllAsync(1_700_000_001_000);
        check(o2.Kind == ShareOutcomeKind.Cancelled && sent2.Count == 0, "share sheet cancelled → no KPI");
        var still = new FakeRecorder { Video = false };
        var o3 = await share.RecordAndShareAsync(still, new FakeSheet(), null, null);
        check(o3.Kind == ShareOutcomeKind.Shared && o3.MediaKind == "replay_image" && still.Stills == 1 && still.Frames == 0 && still.Card.Kind == "replay_image",
            "no video encoder → one still image of the finish with the card");
        var broken = new FakeRecorder { Throw = true };
        var o4 = await share.RecordAndShareAsync(broken, new FakeSheet(), null, null);
        check(o4.Kind == ShareOutcomeKind.Failed && broken.Cancels == 1 && o4.Message.StartsWith(ReplayShareModel.TextFailed), "recorder error → recording cancelled, message 「" + o4.Message + "」");
        var unfinished = new OfflineRaceDriver(RaceFactory.Practice(ruleset, RaceFactory.DefaultPartner("ミカン"), 3), 0, autoStart: true);
        unfinished.Update(0);
        check(!ReplayShareModel.CanShare(unfinished) && ReplayShareModel.From(unfinished) == null && !ReplayShareModel.CanShare(null), "an unfinished race cannot be shared");
        var tut = new OfflineRaceDriver(OfflinePresets.TutorialRace(ruleset, 3));
        long tn = 0; while (!tut.Done && tn < 600_000) { tut.Update(tn); tn += 16; }
        var ts = ReplayShareModel.From(tut);
        check(ts != null && ts.Clip.ResultHash == tut.Sim.Result.Hash, "the tutorial race (player + director rival inputs) replays to the same hash");

        // ---------------------------------------------------------------- account-link prompt
        var kv = new MemoryKeyValueStore();
        var lp = new AccountLinkPrompt(kv);
        check(!lp.ShouldShow(LinkPromptContext.Home, anonymous: true, gameDay: 2, ftueDone: true, online: true), "day 2, no purchase: not yet");
        check(!lp.ShouldShow(LinkPromptContext.Tutorial, true, 3, false, true) && !lp.ShouldShow(LinkPromptContext.Home, true, 3, false, true), "never during the FTUE (day 3 but the first ranked race is not done)");
        check(!lp.ShouldShow(LinkPromptContext.Race, true, 3, true, true) && !lp.ShouldShow(LinkPromptContext.Other, true, 3, true, true), "never in a race / matching / result screen or on other screens");
        check(!lp.ShouldShow(LinkPromptContext.Home, true, 3, true, false) && !lp.ShouldShow(LinkPromptContext.Home, true, 3, true, true, deletionScheduled: true), "not offline, not while an account deletion is scheduled");
        check(!lp.ShouldShow(LinkPromptContext.Home, anonymous: false, 3, true, true), "already linked (not anonymous): never");
        check(lp.ShouldShow(LinkPromptContext.Home, true, 3, true, true) && lp.ShouldShow(LinkPromptContext.ResultClosed, true, 3, true, true) && lp.TriggerFor(3, false) == LinkPromptTrigger.Day3,
            "day 3, FTUE done: shown on home or after closing a result");
        var view = lp.Show(LinkPromptTrigger.Day3, ios: true);
        check(view.Title == "機種変更でも相棒を引き継げます" && view.Providers[0] == "apple" && view.LaterLabel == "あとで" && lp.Shown, "prompt screen: one title, Apple first on iOS, 「あとで」; marked shown when displayed");
        check(!lp.ShouldShow(LinkPromptContext.Home, true, 4, true, true) && !new AccountLinkPrompt(kv).ShouldShow(LinkPromptContext.PurchaseComplete, true, 9, true, true, purchased: true),
            "once only: not again the next day, after a restart, or after a later purchase");
        lp.Dismiss();
        check(lp.State == "dismissed" && !lp.ShouldShow(LinkPromptContext.Home, true, 30, true, true), "「あとで」 dismisses it for good (Settings keeps the entry)");

        var lp2 = new AccountLinkPrompt(new MemoryKeyValueStore());
        check(!lp2.ShouldShow(LinkPromptContext.Home, true, 1, true, true), "day 1 without a purchase: not shown");
        lp2.NotePurchase();
        check(lp2.ShouldShow(LinkPromptContext.PurchaseComplete, true, 1, true, true) && lp2.TriggerFor(1, false) == LinkPromptTrigger.FirstPurchase,
            "right after the first purchase (day 1): shown — whichever comes first");
        check(!lp2.ShouldShow(LinkPromptContext.PurchaseComplete, true, 1, false, true), "…but a purchase inside the FTUE waits until it is over");
        var pv = lp2.Show(LinkPromptTrigger.FirstPurchase, ios: false);
        check(pv.Providers[0] == "google" && pv.Body.Contains("購入"), "first-purchase wording, Google first on Android");

        var fb = new FakeAuth();
        var auth = new FirebaseAuthTokenProvider(fb);
        var (an3, sent3) = Analytics();
        var r = await lp2.LinkAsync(auth, FederatedCredential.FromGoogle("gid"), an3, () => 1_700_000_000_000);
        await an3.FlushAllAsync(1_700_000_001_000);
        check(r == LinkResult.Linked && lp2.Linked && sent3.Count(e => e.Name == "account_link") == 1, "linked → `account_link` KPI sent once, prompt never again");
        check(lp2.OnLinkResult(LinkResult.Linked, "google", 0) == null, "a second report of the same link sends nothing");
        var lp3 = new AccountLinkPrompt(new MemoryKeyValueStore());
        check(lp3.OnLinkResult(LinkResult.CredentialInUse, "apple", 0) == null && !lp3.Shown, "credential in use (another account): no KPI, nothing recorded");
        check(lp3.OnLinkResult(LinkResult.ProviderAlreadyLinked, "apple", 0) == null && lp3.Linked, "provider already linked: no KPI, prompt closed for good");
        var ftuePlayer = new PlayerView { PartnerHorseId = "h1", TutorialGachaUsed = true, RankedRaces = 0 };
        check(!AccountLinkPrompt.FtueDone(ftuePlayer) && AccountLinkPrompt.FtueDone(new PlayerView { PartnerHorseId = "h1", TutorialGachaUsed = true, RankedRaces = 1 }),
            "FTUE is over after the first ranked race (partner named, welcome scout done)");

        // ---------------------------------------------------------------- time attack ghosts: friends first
        GhostEntry G(string id, long ms) => new GhostEntry { PlayerId = id, DisplayName = id, HorseName = "馬" + id, TimeMs = ms, Path = "/v1/time-attack/ghosts/2026-11/aoba_turf_1600/" + id };
        GhostList L(string kind, params GhostEntry[] g) => new GhostList { Kind = kind, Ghosts = g.ToList() };
        var withFriends = GhostPicker.Build(L("friends", G("f2", 98_000), G("f1", 96_500), G("f3", 99_900)), L("top", G("t1", 93_000), G("me", 97_000)), L("me", G("me", 97_000)), "me", 97_000);
        check(withFriends.Tab == GhostKind.Friends && !withFriends.FellBack && withFriends.Note == null && withFriends.Friends.Select(g => g.PlayerId).SequenceEqual(new[] { "f1", "f2", "f3" }),
            "friend ghosts exist → the picker opens on フレンド, fastest first");
        check(withFriends.Selected.PlayerId == "f1" && withFriends.TimeLine(withFriends.Selected) == "1:36.5（あと0.5秒）", "default pick: the nearest friend faster than my best (" + withFriends.TimeLine(withFriends.Selected) + ")");
        check(withFriends.Top.All(g => g.PlayerId != "me") && withFriends.Mine.Single().PlayerId == "me", "my own run is only in 自分");
        var noFriends = GhostPicker.Build(L("friends"), L("top", G("t2", 95_000), G("t1", 93_000)), L("me"), "me", null);
        check(noFriends.Tab == GhostKind.Top && noFriends.FellBack && noFriends.Note == GhostPicker.NoteFallback && noFriends.Selected.PlayerId == "t1",
            "no friend ghosts → falls back to 上位 with 「" + noFriends.Note + "」 (no best yet: the fastest)");
        noFriends.SelectTab(GhostKind.Friends);
        check(noFriends.Selected == null && noFriends.Current.Count == 0, "the フレンド tab stays reachable (empty)");
        var faster = GhostPicker.Build(L("friends", G("f1", 99_000)), L("top"), L("me"), "me", 95_000);
        check(faster.Selected.PlayerId == "f1" && faster.TimeLine(faster.Selected).EndsWith("（自己ベストより遅い）"), "faster than every friend → still a friend, marked slower than my best");
        var none = GhostPicker.Build(null, null, null, "me");
        check(none.Selected == null && none.Note == GhostPicker.NoteEmpty, "no ghosts at all → run alone with 「" + none.Note + "」");
        check(GhostPicker.TabOrder.Select(GhostPicker.TabLabel).SequenceEqual(new[] { "フレンド", "上位", "自分" }), "tabs: フレンド / 上位 / 自分");
    }
}
