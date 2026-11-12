using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-NEW-001..020: /v1/release-notes client methods, models, KPI rows and the one-prompt-per-session rule (contracts/protocol.md §64).</summary>
    public class ApiClientReleaseNotesTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientReleaseNotesTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test", Platform = "ios", AppVersion = "1.2.0" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (releaseNotes.ts checkReleaseNotes / markReleaseNotesSeen / releaseNotesHistory, an account from before both releases)
        internal const string Check = """{"enabled":true,"appVersion":"1.2.0","reason":null,"show":{"appVersion":"1.2.0","releasedOn":"2026-11-05","skipped":1,"hasPast":true,"pages":[{"art":"cups","title":"観戦中に応援できる","body":"フレンドのレースを見ながら、スタンプで応援できます。応援は2秒ごとに送れます。レースの結果には影響しません。","target":{"kind":"help","id":"spectator_cheer","label":"ヘルプ：観戦中の応援"}},{"art":"stamina","title":"画質と省電力を選べる","body":"その他 › 設定で、画質・省電力・通信量を選べます。端末に合わせた設定から始まります。","target":{"kind":"help","id":"data_storage","label":"ヘルプ：データ通信量と容量・画質の設定"}},{"art":"training","title":"馬ごとの目標","body":"馬ごとに次の目標が出ます。達成すると、次の目標が見えてきます。","target":{"kind":"tip","id":"goals_tip","label":"ヒント：馬ごとの目標"}}]}}""";
        internal const string CheckNone = """{"enabled":true,"appVersion":"1.2.0","reason":"seen","show":null}""";
        internal const string Seen = """{"marked":true,"seen":["1.1.0","1.2.0"]}""";
        internal const string History = """{"enabled":true,"appVersion":"1.2.0","notes":[{"appVersion":"1.2.0","releasedOn":"2026-11-05","seen":false,"pages":[{"art":"cups","title":"Cheer while you watch","body":"Send a cheer while you watch a friend race, up to once every 2 seconds. Cheers never change the result.","target":{"kind":"help","id":"spectator_cheer","label":"Help: Cheering while you watch"}},{"art":"stamina","title":"Graphics and battery","body":"Choose graphics quality, battery saving and data use in More › Settings. It starts from a setting that suits your device.","target":{"kind":"help","id":"data_storage","label":"Help: Data usage, storage and graphics"}},{"art":"training","title":"Goals for each horse","body":"Each horse now shows its next goal. Reach it and the next one appears.","target":{"kind":"tip","id":"goals_tip","label":"Tip: Goals for each horse"}}]},{"appVersion":"1.1.0","releasedOn":"2026-10-20","seen":true,"pages":[{"art":"whip","title":"Replay the lessons","body":"Practice whip timing, positioning, stamina and reins any time from More › Tips.","target":{"kind":"screen","id":"tips","label":"Open tips"}},{"art":"roster","title":"Move devices with a code","body":"Set an ID and password to move your data to another device.","target":{"kind":"help","id":"transfer_code","label":"Help: Transfer code (ID and password)"}}]}]}""";

        [Fact]
        public async Task CheckSendsTheAppVersionAndParsesTheSheet()
        {
            _http.Reply(200, Check).Reply(200, CheckNone);
            var c = await _api.CheckReleaseNotesAsync();
            Assert.Equal("/v1/release-notes/check", _http.Requests[0].Path);
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.Equal("1.2.0", _http.Requests[0].Headers["x-client-version"]);
            Assert.Null(c.Reason);
            Assert.Equal("1.2.0", c.Show.AppVersion);
            Assert.Equal(1, c.Show.Skipped);
            Assert.True(c.Show.HasPast);
            Assert.Equal(3, c.Show.Pages.Count);
            Assert.Contains("2秒ごと", c.Show.Pages[0].Body);
            Assert.Equal(ReleaseNoteTarget.KindHelp, c.Show.Pages[0].Target.Kind);
            Assert.Equal("ヒント：馬ごとの目標", c.Show.Pages[2].Target.Label);
            var none = await _api.CheckReleaseNotesAsync();
            Assert.Null(none.Show);
            Assert.Equal(ReleaseNotesCheck.ReasonSeen, none.Reason);
        }

        [Fact]
        public async Task SeenSendsTheVersionOnlyAndChecksItFirst()
        {
            _http.Reply(200, Seen);
            var r = await _api.MarkReleaseNotesSeenAsync("1.2.0");
            Assert.Equal("/v1/release-notes/seen", _http.Requests[0].Path);
            Assert.Equal("{\"appVersion\":\"1.2.0\"}", _http.Requests[0].Body);
            Assert.True(r.Marked);
            Assert.Equal(new[] { "1.1.0", "1.2.0" }, r.Seen);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.MarkReleaseNotesSeenAsync("latest"));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.MarkReleaseNotesSeenAsync(null));
            Assert.Single(_http.Requests);
        }

        [Fact]
        public async Task HistoryParsesNewestFirstWithSeenFlags()
        {
            _http.Reply(200, History);
            var h = await _api.GetReleaseNotesAsync();
            Assert.Equal("/v1/release-notes", _http.Requests[0].Path);
            Assert.Equal(new[] { "1.2.0", "1.1.0" }, h.Notes.Select(n => n.AppVersion));
            Assert.False(h.Notes[0].Seen);
            Assert.True(h.Notes[1].Seen);
            Assert.Equal("Open tips", h.Notes[1].Pages[0].Target.Label);
            Assert.Equal(ReleaseNoteTarget.KindScreen, h.Notes[1].Pages[0].Target.Kind);
        }

        [Fact]
        public void SessionPromptsGiveTheSessionToOnePromptInPriorityOrder()
        {
            var outage = OutageKind.None;
            var p = new SessionPrompts(() => outage);
            // a higher prompt due at the same time wins
            Assert.False(p.TryClaim(SessionPrompts.ReleaseNotes, new[] { SessionPrompts.ConsentPrePrompt }));
            Assert.True(p.TryClaim(SessionPrompts.ConsentPrePrompt));
            // one per session: everything else waits for the next session
            Assert.False(p.TryClaim(SessionPrompts.ReleaseNotes));
            Assert.False(p.TryClaim(SessionPrompts.ReviewPrompt));
            p.NewSession();
            Assert.True(p.TryClaim(SessionPrompts.ReleaseNotes, new[] { SessionPrompts.AccountLink, SessionPrompts.ReviewPrompt }));
            Assert.Equal(SessionPrompts.ReleaseNotes, p.Claimed);
            // never over the §46 screens (maintenance, forced update, offline)
            p.NewSession();
            outage = OutageKind.Maintenance;
            Assert.False(p.Free);
            Assert.False(p.TryClaim(SessionPrompts.ConsentPrePrompt));
            outage = OutageKind.UpgradeRequired;
            Assert.False(p.TryClaim(SessionPrompts.ReleaseNotes));
            outage = OutageKind.None;
            Assert.True(p.TryClaim(SessionPrompts.ReviewPrompt));
            Assert.Throws<ArgumentException>(() => p.TryClaim("banner"));
            // the order the spec states (protocol §58.11 = §64.6, R21 integration: the one table for every prompt)
            Assert.Equal(new[] { "recommended_update", "consent_pre_prompt", "comeback_welcome", "release_notes", "promotion_outcome", "reminders_pre_permission", "account_link", "review_prompt", "survey" }, SessionPrompts.Priority);
        }

        [Fact]
        public void SessionPromptsAreTheOneGateForEveryPromptAndNoneInTheFtue()
        {
            bool ftue = true;
            var p = new SessionPrompts(null, () => ftue);
            // none during the FTUE, whatever the kind
            foreach (var k in SessionPrompts.Priority) { Assert.False(p.CanShow(k)); Assert.False(p.TryClaim(k)); }
            Assert.False(p.Free);
            Assert.Null(p.Pick(SessionPrompts.Priority));
            ftue = false;
            // several due at one moment: the table decides
            Assert.Equal(SessionPrompts.ReleaseNotes, p.Pick(new[] { SessionPrompts.ReviewPrompt, SessionPrompts.RemindersPrePermission, SessionPrompts.ReleaseNotes }));
            Assert.Equal(SessionPrompts.RemindersPrePermission, p.Pick(new[] { SessionPrompts.ReviewPrompt, SessionPrompts.AccountLink, SessionPrompts.RemindersPrePermission }));
            Assert.False(p.TryClaim(SessionPrompts.RemindersPrePermission, new[] { SessionPrompts.ComebackWelcome }));
            Assert.True(p.TryClaim(SessionPrompts.RemindersPrePermission, new[] { SessionPrompts.AccountLink, SessionPrompts.ReviewPrompt }));
            // the sheet on screen may be built again (the same kind); nothing else shows this session
            Assert.True(p.CanShow(SessionPrompts.RemindersPrePermission));
            Assert.True(p.TryClaim(SessionPrompts.RemindersPrePermission));
            foreach (var k in SessionPrompts.Priority.Where(k => k != SessionPrompts.RemindersPrePermission)) Assert.False(p.CanShow(k));
            Assert.Null(p.Pick(new[] { SessionPrompts.RecommendedUpdate, SessionPrompts.ConsentPrePrompt }));
            Assert.Throws<ArgumentException>(() => p.CanShow("banner"));
            // a new session (next launch, or another account on this device)
            p.NewSession();
            Assert.True(p.Free);
            Assert.Null(p.Claimed);
        }

        [Fact]
        public async Task ReleaseNotesEventsMatchTheServerSchema()
        {
            _http.Reply(200, "{\"accepted\":3}");
            await _api.SendAnalyticsAsync("ios", "1.2.0", new[]
            {
                AnalyticsEvent.ReleaseNotesView(5, "1.2.0", "skipped", 2, 3),
                AnalyticsEvent.ReleaseNotesTarget(6, "1.2.0", 1, ReleaseNoteTarget.KindHelp, "spectator_cheer"),
                AnalyticsEvent.ReleaseNotesHistory(7, "notices"),
            });
            var body = _http.Requests[0].Body;
            Assert.Contains("\"name\":\"release_notes_view\"", body);
            Assert.Contains("\"stage\":\"skipped\"", body);
            Assert.Contains("\"name\":\"release_notes_target\"", body);
            Assert.Contains("\"source\":\"notices\"", body);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ReleaseNotesView(0, "1.2", "shown", 1, 1));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ReleaseNotesView(0, "1.2.0", "opened", 1, 1));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ReleaseNotesView(0, "1.2.0", "shown", 4, 3));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ReleaseNotesView(0, "1.2.0", "shown", 1, 6));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ReleaseNotesTarget(0, "1.2.0", 1, "shop", "coin_1500"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.ReleaseNotesHistory(0, "push"));
            string ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "kpi.ts"));
            foreach (var n in new[] { "release_notes_view", "release_notes_target", "release_notes_history" }) Assert.Contains("z.literal('" + n + "')", ts);
            foreach (var s in AnalyticsEvent.ReleaseNotesStages) Assert.Contains("'" + s + "'", ts);
            foreach (var s in AnalyticsEvent.ReleaseNotesHistorySources) Assert.Contains("'" + s + "'", ts);
            foreach (var k in ReleaseNoteTarget.Kinds) Assert.Contains("'" + k + "'", ts);
        }
    }
}
