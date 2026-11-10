using System.Collections.Generic;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>支部の定型チャット (REQ-QCHAT-014, contracts/protocol.md §52): the picker, the post body and the feed item.</summary>
    public class QuickChatTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public QuickChatTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test/" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // the real server's answer (TeamsService.quickChat in English)
        const string Picker = "{\"enabled\":true,\"teamId\":\"tabc123456\",\"deleting\":false,\"limits\":{\"postIntervalMs\":15000,\"postsPerDay\":30,\"mentionsPerDay\":10,\"repeatWindowMs\":600000},"
            + "\"phrases\":[{\"id\":\"run_together\",\"category\":\"invite\",\"slots\":[\"course\"],\"mention\":false,\"qchatTemplate\":\"Let's race together at {course}\"},{\"id\":\"nice_player\",\"category\":\"cheer\",\"slots\":[\"player\"],\"mention\":true,\"qchatTemplate\":\"Nice one, {player}!\"}],"
            + "\"options\":{\"course\":[{\"ref\":\"aoba_turf_1600\",\"qchatValue\":\"Aoba Racecourse, Turf 1600 m\"}],\"horse\":[],\"race\":[],\"time\":[],\"cup\":[],\"player\":[{\"ref\":\"lead\",\"qchatValue\":\"シノノメ\"}]},"
            + "\"usage\":{\"postsToday\":3,\"mentionsToday\":1,\"nextPostAt\":1794614415000}}";

        [Fact]
        public async Task PickerParsesPhrasesOptionsAndUsage()
        {
            _http.Reply(200, Picker);
            var p = await _api.GetQuickChatAsync();
            Assert.Single(_http.Requests);
            Assert.Equal("GET", _http.Requests[0].Method);
            Assert.Equal("/v1/teams/me/quick-chat", _http.Requests[0].Path);
            Assert.True(p.Enabled);
            Assert.Equal(2, p.Phrases.Count);
            Assert.True(p.Phrases[1].Mention);
            Assert.Equal(new List<string> { "course" }, p.Phrases[0].Slots);
            Assert.Equal("シノノメ", p.OptionsFor("player")[0].Text);
            Assert.Empty(p.OptionsFor("horse"));
            Assert.Equal(3, p.PostsToday);
            Assert.Equal(1794614415000L, p.NextPostAt);
            // the template with a chosen value / a blank
            Assert.Equal("Let's race together at Aoba Racecourse, Turf 1600 m", p.Phrases[0].Fill(new Dictionary<string, string> { ["course"] = "Aoba Racecourse, Turf 1600 m" }));
            Assert.Equal("Let's race together at ＿＿", p.Phrases[0].Fill(null));
        }

        [Fact]
        public async Task PostSendsOnlyThePhraseIdAndSlotIdsAndIsNeverRetried()
        {
            _http.Reply(200, "{\"teamId\":\"tabc123456\",\"seq\":41,\"at\":1794614400000,\"phraseId\":\"run_together\"}");
            var r = await _api.PostQuickChatAsync("run_together", new Dictionary<string, string> { ["course"] = "aoba_turf_1600" });
            Assert.Equal("POST", _http.Requests[0].Method);
            Assert.Equal("/v1/teams/me/feed/quick-chat", _http.Requests[0].Path);
            Assert.Equal("{\"phraseId\":\"run_together\",\"slots\":{\"course\":\"aoba_turf_1600\"}}", _http.Requests[0].Body);
            Assert.Equal(41, r.Seq);

            _http.Requests.Clear();
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\",\"message\":\"x\"}}");
            await Assert.ThrowsAnyAsync<ApiException>(() => _api.PostQuickChatAsync("otsukare"));
            Assert.Single(_http.Requests); // not idempotent: no automatic retry
            Assert.Equal("{\"phraseId\":\"otsukare\",\"slots\":{}}", _http.Requests[0].Body);

            _http.Requests.Clear();
            _http.Reply(409, "{\"error\":{\"code\":\"NOT_ELIGIBLE\",\"message\":\"this member cannot be named\"}}");
            var e = await Assert.ThrowsAnyAsync<ApiException>(() => _api.PostQuickChatAsync("nice_player", new Dictionary<string, string> { ["player"] = "x" }));
            Assert.Equal(ApiErrorCode.NotEligible, e.Code);
        }

        [Fact]
        public async Task FeedCarriesQuickChatItems()
        {
            _http.Reply(200, "{\"teamId\":\"tabc123456\",\"items\":[{\"seq\":41,\"at\":5,\"kind\":\"qchat\",\"playerId\":\"\",\"displayName\":\"元メンバー\",\"mine\":false,\"stampId\":null,\"stampAsset\":null,\"race\":null,\"goal\":null,"
                + "\"qchat\":{\"phraseId\":\"nice_player\",\"category\":\"cheer\",\"mention\":true,\"mentionsMe\":true,\"anon\":true,\"qchatText\":\"シノノメさんナイス！\",\"slots\":[{\"name\":\"player\",\"ref\":\"me\",\"qchatValue\":\"シノノメ\"}],\"report\":{\"kind\":\"team_feed\",\"teamId\":\"tabc123456\",\"seq\":41}},"
                + "\"reactions\":[{\"stampId\":\"nice\",\"count\":1,\"mine\":true}],\"myReaction\":\"nice\"}],\"nextBefore\":null,\"latestSeq\":41,\"muted\":[]}");
            var page = await _api.GetTeamFeedAsync();
            var it = page.Items[0];
            Assert.True(it.IsQuickChat);
            Assert.Equal("シノノメさんナイス！", it.QuickChat.Text);
            Assert.True(it.QuickChat.Anon && it.QuickChat.MentionsMe && it.QuickChat.Mention);
            Assert.Equal("player", it.QuickChat.Slots[0].Name);
            Assert.Equal(41, it.QuickChat.ReportSeq);
            Assert.Equal("team_feed", it.QuickChat.ReportKind);
        }
    }
}
