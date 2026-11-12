using System.Text.Json;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-TKT-001..017: the support thread client (contracts/protocol.md §73).</summary>
    public class ApiClientSupportTicketsTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientSupportTicketsTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (PlayerService.helpInquiryMessage / helpInquiry / helpInquiries, §73)
        internal const string Thread = @"{""ticketId"":""q_1"",""category"":""purchase_missing"",""categoryTitle"":""購入したのに届かない"",""status"":""received"",""statusText"":""受付済み"",""createdAt"":1794279600000,""updatedAt"":1794286800000,""lang"":""ja"",""inquiryText"":""コイン1,020を買ったのに増えていません。"",""redacted"":0,""attachments"":[],""diagnostics"":{""appVersion"":null,""platform"":null,""playerId"":""u1"",""lastRaceIds"":[]},""messages"":[{""from"":""support"",""messageText"":""ストアの支払いを確認しています。少しお待ちください。"",""at"":1794283200000},{""from"":""player"",""messageText"":""昨日の夜に購入しました。"",""at"":1794286800000}],""unread"":true,""canReply"":true,""replyUntil"":null,""autoCloseAt"":null,""shareDiagnostics"":false,""compensation"":[]}";
        internal const string Closed = @"{""ticketId"":""q_1"",""category"":""purchase_missing"",""categoryTitle"":""購入したのに届かない"",""status"":""closed"",""statusText"":""クローズ"",""createdAt"":1794279600000,""updatedAt"":1794290400000,""lang"":""ja"",""inquiryText"":""コイン1,020を買ったのに増えていません。"",""redacted"":0,""attachments"":[],""diagnostics"":{""appVersion"":null,""platform"":null,""playerId"":""u1"",""lastRaceIds"":[]},""messages"":[{""from"":""support"",""messageText"":""ストアの支払いを確認しています。少しお待ちください。"",""at"":1794283200000},{""from"":""player"",""messageText"":""昨日の夜に購入しました。"",""at"":1794286800000},{""from"":""support"",""messageText"":""確認できました。コインを付与しました。"",""at"":1794290400000}],""unread"":true,""canReply"":true,""replyUntil"":1795500000000,""autoCloseAt"":null,""shareDiagnostics"":false,""compensation"":[{""ref"":""comp_1"",""at"":1794290400000,""screen"":""gift_box""}]}";
        internal const string List = @"{""items"":[{""ticketId"":""q_1"",""category"":""purchase_missing"",""categoryTitle"":""購入したのに届かない"",""status"":""closed"",""statusText"":""クローズ"",""createdAt"":1794279600000,""updatedAt"":1794290400000,""unread"":true,""canReply"":true}],""unread"":1,""limits"":{""openMax"":3,""open"":0,""perDay"":5,""today"":1,""retryAt"":null,""repliesPerDay"":10,""repliesToday"":1}}";

        [Fact]
        public async Task ReplyKeepsOneKeyAcrossRetriesAndParsesTheThread()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, Thread);
            var t = await _api.SendInquiryMessageAsync("q_1", "昨日の夜に購入しました。", "c:reply-1");
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal("/v1/help/inquiries/q_1/messages", _http.Requests[1].Path);
            Assert.Equal("c:reply-1", _http.Requests[0].Headers["idempotency-key"]);
            Assert.Equal("c:reply-1", _http.Requests[1].Headers["idempotency-key"]);
            using (var body = JsonDocument.Parse(_http.Requests[1].Body))
                Assert.Equal(new[] { "content" }, body.RootElement.EnumerateObject().Select(p => p.Name).ToArray());
            Assert.Equal(InquiryStatuses.Received, t.Status);
            Assert.Equal(new[] { "support", "player" }, t.Messages.Select(m => m.From).ToArray());
            Assert.True(t.CanReply);
            Assert.False(t.ShareDiagnostics);
            Assert.Null(t.Diagnostics.AppVersion);
            Assert.Null(t.AutoCloseAt);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.SendInquiryMessageAsync("../q", "x"));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.SendInquiryMessageAsync("q_1", "  "));
        }

        [Fact]
        public async Task ClosedThreadShowsTheReopenWindowAndTheCompensation()
        {
            _http.Reply(200, Closed).Reply(200, List);
            var t = await _api.GetInquiryAsync("q_1");
            Assert.Equal(InquiryStatuses.Closed, t.Status);
            Assert.Equal("クローズ", t.StatusText);
            Assert.Equal(1795500000000, t.ReplyUntil);
            Assert.Equal("comp_1", t.Compensation[0].Ref);
            Assert.Equal("gift_box", t.Compensation[0].Screen);
            var l = await _api.GetInquiriesAsync();
            Assert.True(l.Items[0].CanReply);
            Assert.Equal(10, l.Limits.RepliesPerDay);
            Assert.Equal(1, l.Limits.RepliesToday);
        }

        [Fact]
        public async Task DiagnosticsOnlyWithConsent()
        {
            _http.Reply(200, Thread);
            var d = new InquiryDraft { Category = InquiryCategories.PurchaseMissing, Description = "コイン1,020を買ったのに増えていません。", AppVersion = "1.4.0", Platform = "ios", ShareDiagnostics = false };
            await _api.SubmitInquiryAsync(d, "c:form-2");
            using var body = JsonDocument.Parse(_http.Requests[0].Body);
            Assert.False(body.RootElement.TryGetProperty("diagnostics", out _));
            Assert.False(body.RootElement.GetProperty("shareDiagnostics").GetBoolean());
        }

        [Fact]
        public void StatusWordsMatchTheServer()
        {
            string help = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "help.ts"));
            foreach (var s in InquiryStatuses.All)
            {
                Assert.Contains("  " + s + ": { ja: '" + InquiryStatuses.TextOf(s) + "', en: '" + InquiryStatuses.TextOf(s, true) + "' }", help);
            }
            Assert.True(InquiryStatuses.IsOpen("in_progress"));
            Assert.False(InquiryStatuses.IsOpen("answered"));
        }
    }
}
