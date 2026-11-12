using System.Text.Json;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-HELP-001..024: /v1/help client methods, models and the search fold (contracts/protocol.md §48).</summary>
    public class ApiClientHelpTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientHelpTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (help.ts helpIndex / helpArticle / searchHelp, PlayerService inquiries)
        internal const string Index = "{\"enabled\":true,\"version\":1,\"lang\":\"ja\",\"categories\":[{\"id\":\"getting_started\",\"title\":\"はじめに\",\"icon\":\"start\",\"count\":2},{\"id\":\"races\",\"title\":\"レース・ムチ\",\"icon\":\"race\",\"count\":2}],\"articles\":[{\"id\":\"first_steps\",\"category\":\"getting_started\",\"title\":\"最初の遊び方\"},{\"id\":\"gift_box\",\"category\":\"getting_started\",\"title\":\"プレゼントボックスの受け取り\"},{\"id\":\"whip\",\"category\":\"races\",\"title\":\"ムチのタイミング\"}],\"contexts\":{\"gacha_odds\":\"pity\",\"coin_shortfall\":\"buy_coins\",\"purchase\":\"buy_coins\",\"race_whip\":\"whip\",\"race_result\":\"race_modes\",\"training\":\"training\",\"breeding\":\"breeding\",\"history\":\"history_help\",\"gift_box\":\"gift_box\",\"account_link\":\"data_transfer\",\"deletion\":\"delete_account\",\"accessibility\":\"accessibility_settings\"},\"supportSite\":\"https://support.muchi-issen.example/\",\"inquiry\":{\"categories\":[{\"id\":\"purchase_missing\",\"title\":\"購入したのに届かない\",\"history\":true},{\"id\":\"refund\",\"title\":\"返金について\",\"history\":true}],\"descriptionMin\":10,\"descriptionMax\":1000,\"attachMax\":10,\"diagnosticsNote\":\"送信すると、アプリの版・端末の種類（iOS／Android）・プレイヤーID・直近のレースID（最大3件）が自動で添えられます。名前・メールアドレス・端末の機種名・位置情報は送りません。\",\"privacyNote\":\"本文にメールアドレス・電話番号・パスワード・カード番号は書かないでください（メールアドレスや電話番号らしい部分は自動で消します）。\"}}";
        internal const string Article = "{\"id\":\"pity\",\"category\":\"scout\",\"categoryTitle\":\"スカウト（提供割合・天井）\",\"title\":\"天井（交換pt）のしくみ\",\"body\":\"スカウトを引いた回数だけ交換ptがたまります。常設のスカウトでは100回分たまると、対象の馬から好きな馬を選んで交換できます。\\n\\n・天井までに必要なコインは最大10,000コインです\\n・期間のあるスカウトの交換ptは、期間が終わると常設の交換ptへ移ります（失効しません）\\n・たまった交換ptはスカウトの画面で確認できます\",\"links\":[{\"type\":\"screen\",\"screen\":\"gacha_odds\",\"label\":\"提供割合を開く\"},{\"type\":\"screen\",\"screen\":\"gacha\",\"label\":\"スカウトを開く\"}],\"related\":[{\"id\":\"scout_rates\",\"title\":\"スカウトの提供割合\"}],\"version\":1}";
        internal const string Search = "{\"items\":[{\"id\":\"pity\",\"category\":\"scout\",\"title\":\"天井（交換pt）のしくみ\",\"snippet\":\"スカウトを引いた回数だけ交換ptがたまります。常設のスカウトでは100回分たまると、対象の馬から好きな馬を選んで交換で…\"}],\"total\":1,\"query\":{\"length\":5}}";
        internal const string Detail = "{\"ticketId\":\"q_1\",\"category\":\"bug\",\"categoryTitle\":\"不具合の報告\",\"status\":\"answered\",\"statusText\":\"返信あり\",\"createdAt\":1794279600000,\"updatedAt\":1794279600000,\"lang\":\"ja\",\"inquiryText\":\"レースの途中で止まりました。もう一度試しても同じです。\",\"redacted\":0,\"attachments\":[],\"diagnostics\":{\"appVersion\":\"1.4.0\",\"platform\":\"ios\",\"playerId\":\"u1\",\"lastRaceIds\":[]},\"messages\":[{\"from\":\"support\",\"messageText\":\"ご連絡ありがとうございます。修正版を準備しています。\",\"at\":1794279600000}],\"unread\":true}";
        internal const string List = "{\"items\":[{\"ticketId\":\"q_1\",\"category\":\"bug\",\"categoryTitle\":\"不具合の報告\",\"status\":\"answered\",\"statusText\":\"返信あり\",\"createdAt\":1794279600000,\"updatedAt\":1794279600000,\"unread\":true}],\"unread\":1,\"limits\":{\"openMax\":3,\"open\":0,\"perDay\":5,\"today\":1,\"retryAt\":1794279660000}}";

        [Fact]
        public async Task IndexArticleAndSearchParse()
        {
            _http.Reply(200, Index).Reply(200, Article).Reply(200, Search);
            var idx = await _api.GetHelpAsync();
            Assert.Equal("/v1/help", _http.Requests[0].Path);
            Assert.True(idx.Enabled);
            Assert.Equal(HelpCategories.GettingStarted, idx.Categories[0].Id);
            Assert.Equal(2, idx.Categories[0].Count);
            Assert.Equal("pity", idx.Contexts[HelpContexts.GachaOdds]);
            Assert.Equal("buy_coins", idx.Contexts[HelpContexts.CoinShortfall]);
            Assert.True(idx.InquiryCategories[0].History);
            Assert.Contains("プレイヤーID", idx.DiagnosticsNote);
            Assert.Equal(1000, idx.DescriptionMax);
            var a = await _api.GetHelpArticleAsync("pity");
            Assert.Equal("/v1/help/articles/pity", _http.Requests[1].Path);
            Assert.Equal(2, a.Paragraphs().Length);
            Assert.Contains("100回分", a.Body);
            Assert.Equal(HelpLink.Screen, a.Links[0].Type);
            Assert.Equal("gacha_odds", a.Links[0].ScreenId);
            Assert.Equal("scout_rates", a.Related[0].Id);
            var s = await _api.SearchHelpAsync("てんじょう");
            Assert.StartsWith("/v1/help/search?q=%E3%81%A6", _http.Requests[2].Path);
            Assert.Equal("pity", s.Items[0].Id);
            Assert.Equal(5, s.QueryLength);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.GetHelpArticleAsync("../x"));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.SearchHelpAsync("x", "casino"));
        }

        [Fact]
        public async Task SubmitKeepsOneKeyAcrossRetriesAndSendsOnlyVersionAndPlatform()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, Detail);
            var d = new InquiryDraft { Category = InquiryCategories.Bug, Description = "レースの途中で止まりました。", AppVersion = "1.4.0", Platform = "ios" };
            d.Refs.Add("G-3");
            var t = await _api.SubmitInquiryAsync(d, "c:form-1");
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal("c:form-1", _http.Requests[0].Headers["idempotency-key"]);
            Assert.Equal("c:form-1", _http.Requests[1].Headers["idempotency-key"]);
            using (var body = JsonDocument.Parse(_http.Requests[1].Body))
            {
                var diag = body.RootElement.GetProperty("diagnostics");
                Assert.Equal(new[] { "appVersion", "platform" }, diag.EnumerateObject().Select(p => p.Name).ToArray());
                Assert.Equal("G-3", body.RootElement.GetProperty("refs")[0].GetString());
            }
            Assert.Equal("q_1", t.TicketId);
            Assert.Equal(InquiryStatuses.Answered, t.Status);
            Assert.Equal("support", t.Messages[0].From);
            Assert.Equal("ご連絡ありがとうございます。修正版を準備しています。", t.Messages[0].MessageText);
            Assert.Equal("u1", t.Diagnostics.PlayerId);
            Assert.True(t.Unread);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.SubmitInquiryAsync(new InquiryDraft { Category = "casino" }));
        }

        [Fact]
        public async Task ListFeedbackAndReadParse()
        {
            _http.Reply(200, List).Reply(200, "{\"articleId\":\"pity\",\"helpful\":true,\"changed\":true}").Reply(200, "{\"ticketId\":\"q_1\",\"unread\":false,\"unreadTotal\":0}");
            var l = await _api.GetInquiriesAsync();
            Assert.Equal(1, l.Unread);
            Assert.Equal("返信あり", l.Items[0].StatusText);
            Assert.Equal(3, l.Limits.OpenMax);
            Assert.True(l.Limits.CanSend);
            Assert.Equal(1794279660000, l.Limits.RetryAt);
            var f = await _api.SendHelpFeedbackAsync("pity", true);
            Assert.Equal("/v1/help/articles/pity/feedback", _http.Requests[1].Path);
            Assert.Equal("{\"helpful\":true}", _http.Requests[1].Body);
            Assert.True(f.Changed);
            var r = await _api.MarkInquiryReadAsync("q_1");
            Assert.Equal("/v1/help/inquiries/q_1/read", _http.Requests[2].Path);
            Assert.Equal(0, r.UnreadTotal);
        }

        [Fact]
        public async Task PlayerViewCarriesTheBadge()
        {
            _http.Reply(200, "{\"id\":\"u1\",\"help\":{\"unreadReplies\":2}}");
            Assert.Equal(2, (await _api.GetPlayerAsync()).Help.UnreadReplies);
        }

        [Fact]
        public void FoldMatchesTheServerVectors()
        {
            var json = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "help-fold.vectors.json"));
            using var doc = JsonDocument.Parse(json);
            int n = 0;
            foreach (var v in doc.RootElement.GetProperty("vectors").EnumerateArray())
            {
                var input = v.GetProperty("input").GetString();
                Assert.Equal(v.GetProperty("fold").GetString(), HelpText.Fold(input));
                Assert.Equal(v.GetProperty("words").EnumerateArray().Select(x => x.GetString()).ToArray(), HelpText.Words(input));
                n++;
            }
            Assert.True(n >= 20);
            Assert.Equal(5, HelpText.KpiLength("てんじょう"));
        }

        [Fact]
        public async Task HelpEventsMatchTheServerSchema()
        {
            _http.Reply(200, "{\"accepted\":2}");
            await _api.SendAnalyticsAsync("ios", "1", new[] { AnalyticsEvent.HelpSearch(5, 4, null, 3), AnalyticsEvent.HelpArticleView(6, "pity", "context") });
            Assert.Contains("\"name\":\"help_search\"", _http.Requests[0].Body);
            Assert.Contains("\"category\":\"all\"", _http.Requests[0].Body);
            Assert.DoesNotContain("query", _http.Requests[0].Body);
            Assert.Contains("\"source\":\"context\"", _http.Requests[0].Body);
            Assert.Throws<ArgumentOutOfRangeException>(() => AnalyticsEvent.HelpSearch(0, 0, null, 0));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.HelpArticleView(0, "pity", "push"));
            string ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "kpi.ts"));
            Assert.Contains("z.literal('help_search')", ts);
            foreach (var s in AnalyticsEvent.HelpViewSources) Assert.Contains("'" + s + "'", ts);
            foreach (var c in HelpCategories.All) Assert.Contains("'" + c + "'", ts);
            string help = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "help.ts"));
            foreach (var c in HelpContexts.All) Assert.Contains("'" + c + "'", help);
            foreach (var c in InquiryCategories.All) Assert.Contains("'" + c + "'", help);
        }
    }
}
