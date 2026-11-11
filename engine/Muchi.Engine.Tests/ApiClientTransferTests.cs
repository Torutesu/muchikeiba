using System.Text.Json;
using Muchi.Client;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-TRF-001..020: /v1/transfer client methods, the shared rules and SESSION_REPLACED (contracts/protocol.md §54).</summary>
    public class ApiClientTransferTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly FakeAuth _auth = new FakeAuth();
        private readonly ApiClient _api;

        public ApiClientTransferTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, _auth, opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (transferStateView, TransferService.issue / redeem)
        internal const string Status = "{\"enabled\":true,\"code\":{\"codeId\":\"K7M-Q3X-PHR\",\"mode\":\"custom\",\"issuedAt\":1794279600000,\"expiresAt\":1796871600000,\"expired\":false},\"lastTransferredAt\":null,\"issuesToday\":1,\"issuesPerDay\":5,\"rules\":[{\"id\":\"length\",\"text\":\"8〜32文字\"},{\"id\":\"charset\",\"text\":\"半角の英数字と記号\"},{\"id\":\"mix\",\"text\":\"英字と数字を両方使う\"},{\"id\":\"common\",\"text\":\"よく使われるパスワードは使えません\"}],\"passwordMin\":8,\"passwordMax\":32,\"expiryDays\":30}";
        internal const string Issued = "{\"codeId\":\"K7M-Q3X-PHR\",\"mode\":\"generated\",\"password\":\"abcd-efgh-jkmn\",\"issuedAt\":1794279600000,\"expiresAt\":1796871600000}";
        internal const string Redeemed = "{\"customToken\":\"eyJ.token.sig\",\"expiresInSec\":3600,\"displayName\":\"ハヤテ\"}";

        [Fact]
        public void RulesMatchTheServer()
        {
            Assert.Equal(31, TransferCodeRules.IdAlphabet.Length);
            Assert.Equal("K7MQ3XPHR", TransferCodeRules.NormalizeCodeId("k7m-q3x-phr"));
            Assert.Equal("K7MQ3XPHR", TransferCodeRules.NormalizeCodeId("Ｋ７Ｍ－Ｑ３Ｘ－ＰＨＲ"));
            Assert.Equal("K7MQ3XPHR", TransferCodeRules.NormalizeCodeId(" K7M ー Q3X PHR "));
            Assert.Null(TransferCodeRules.NormalizeCodeId("K7MQ3XPH0"));
            Assert.Equal("K7M-Q3X-PHR", TransferCodeRules.FormatCodeId("k7mq3xphr"));
            Assert.Empty(TransferCodeRules.PasswordProblems("Haneda2026!"));
            Assert.Equal(new[] { "length" }, TransferCodeRules.PasswordProblems("abc1"));
            Assert.Equal(new[] { "mix" }, TransferCodeRules.PasswordProblems("abcdefghij"));
            Assert.Equal(new[] { "charset" }, TransferCodeRules.PasswordProblems("あいうえおかきく1a"));
            Assert.Equal(new[] { "common" }, TransferCodeRules.PasswordProblems("Password1"));
            Assert.Equal(new[] { "length", "mix" }, TransferCodeRules.PasswordProblems("ab"));
            Assert.Equal("Haneda2026!", TransferCodeRules.Normalize("Ｈａｎｅｄａ２０２６！"));
            Assert.Equal(new[] { "length" }, TransferCodeRules.PasswordProblems("abcdefg1", 10, 32));
        }

        [Fact]
        public void CommonPasswordListIsTheServers()
        {
            var ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "transferCode.ts"));
            var start = ts.IndexOf("COMMON_PASSWORDS: readonly string[] = [");
            var list = ts.Substring(start, ts.IndexOf("];", start) - start);
            var server = System.Text.RegularExpressions.Regex.Matches(list, "'([^']+)'").Select(m => m.Groups[1].Value).ToArray();
            Assert.Equal(server, TransferCodeRules.CommonPasswords);
        }

        [Fact]
        public async Task StatusIssueRevokeParse()
        {
            _http.Reply(200, Status).Reply(200, Issued).Reply(200, "{\"revoked\":true}");
            var s = await _api.GetTransferCodeAsync();
            Assert.Equal("/v1/transfer/code", _http.Requests[0].Path);
            Assert.True(s.Enabled);
            Assert.Equal("K7M-Q3X-PHR", s.Code.CodeId);
            Assert.False(s.Code.Expired);
            Assert.Null(s.LastTransferredAt);
            Assert.Equal(4, s.Rules.Count);
            Assert.Equal(TransferCodeRules.Mix, s.Rules[2].Id);
            Assert.Equal(30, s.ExpiryDays);
            var i = await _api.IssueTransferCodeAsync(null);
            Assert.Equal("POST", _http.Requests[1].Method);
            using (var body = JsonDocument.Parse(_http.Requests[1].Body)) Assert.Equal("generated", body.RootElement.GetProperty("mode").GetString());
            Assert.Equal("abcd-efgh-jkmn", i.Password);
            Assert.True(await _api.RevokeTransferCodeAsync());
            Assert.Equal("DELETE", _http.Requests[2].Method);
        }

        [Fact]
        public async Task IssueIsNotRetriedAndWeakPasswordCarriesTheRules()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}");
            await Assert.ThrowsAsync<ServerException>(() => _api.IssueTransferCodeAsync("Haneda2026!"));
            Assert.Single(_http.Requests);
            using (var body = JsonDocument.Parse(_http.Requests[0].Body)) Assert.Equal("custom", body.RootElement.GetProperty("mode").GetString());
            _http.Reply(400, "{\"error\":{\"code\":\"TRANSFER_PASSWORD_WEAK\",\"message\":\"x\",\"details\":{\"rules\":[\"length\",\"mix\"]}}}");
            var e = await Assert.ThrowsAsync<TransferException>(() => _api.IssueTransferCodeAsync("ab"));
            Assert.Equal(ApiErrorCode.TransferPasswordWeak, e.Code);
            Assert.Equal(new[] { "length", "mix" }, e.Rules);
        }

        [Fact]
        public async Task RedeemKeepsOneKeyAcrossRetriesAndParsesErrors()
        {
            _http.Reply(503, "{\"error\":{\"code\":\"INTERNAL\"}}").Reply(200, Redeemed);
            var r = await _api.RedeemTransferCodeAsync("K7M-Q3X-PHR", "Haneda2026!", false, "trf-1", "install-123456");
            Assert.Equal(2, _http.Requests.Count);
            Assert.Equal("trf-1", _http.Requests[0].Headers["idempotency-key"]);
            Assert.Equal("trf-1", _http.Requests[1].Headers["idempotency-key"]);
            using (var body = JsonDocument.Parse(_http.Requests[1].Body))
            {
                Assert.Equal("K7M-Q3X-PHR", body.RootElement.GetProperty("codeId").GetString());
                Assert.False(body.RootElement.TryGetProperty("confirmDiscard", out _));
                Assert.Equal("install-123456", body.RootElement.GetProperty("installId").GetString());
            }
            Assert.Equal("eyJ.token.sig", r.CustomToken);
            Assert.Equal("ハヤテ", r.DisplayName);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.RedeemTransferCodeAsync("x", "y", false, null));

            _http.Reply(409, "{\"error\":{\"code\":\"TRANSFER_CONFIRM_REQUIRED\",\"message\":\"x\",\"details\":{\"paidCoins\":310,\"freeCoins\":20,\"horses\":3,\"races\":5,\"purchases\":1}}}");
            var c = await Assert.ThrowsAsync<TransferException>(() => _api.RedeemTransferCodeAsync("K7M-Q3X-PHR", "Haneda2026!", false, "trf-2"));
            Assert.Equal(310, c.Confirm.PaidCoins);
            Assert.Equal(3, c.Confirm.Horses);
            _http.Reply(429, "{\"error\":{\"code\":\"TRANSFER_LOCKED\",\"message\":\"x\",\"details\":{\"retryAfterSec\":3600}}}");
            var l = await Assert.ThrowsAsync<TransferException>(() => _api.RedeemTransferCodeAsync("K7M-Q3X-PHR", "x", true, "trf-3"));
            Assert.Equal(ApiErrorCode.TransferLocked, l.Code);
            Assert.Equal(3600, l.RetryAfterSec);
            Assert.Equal(4, _http.Requests.Count); // the lock is not retried
            _http.Reply(403, "{\"error\":{\"code\":\"TRANSFER_REFUSED\",\"message\":\"x\",\"details\":{\"reason\":\"deletion_pending\"}}}");
            var f = await Assert.ThrowsAsync<TransferException>(() => _api.RedeemTransferCodeAsync("K7M-Q3X-PHR", "x", true, "trf-4"));
            Assert.Equal(TransferRefusedReasons.DeletionPending, f.Reason);
            foreach (var w in new[] { "TRANSFER_INVALID", "TRANSFER_EXPIRED", "TRANSFER_LOCKED", "TRANSFER_PASSWORD_WEAK", "TRANSFER_CONFIRM_REQUIRED", "TRANSFER_SAME_ACCOUNT", "TRANSFER_REFUSED", "TRANSFER_ISSUE_LIMIT", "SESSION_REPLACED" })
                Assert.Contains(w, ApiErrorCodes.WireCodes);
        }

        [Fact]
        public async Task SessionReplacedIsNotRetriedAndRaisesTheEvent()
        {
            int events = 0;
            _api.SessionReplaced += () => events++;
            _http.Reply(401, "{\"error\":{\"code\":\"SESSION_REPLACED\",\"message\":\"この端末のデータは別の端末に引き継がれました\"}}");
            await Assert.ThrowsAsync<SessionReplacedException>(() => _api.GetTransferCodeAsync());
            Assert.Single(_http.Requests); // no token refresh round trip
            Assert.Equal(0, _auth.Forced);
            Assert.Equal(1, events);
            // a plain 401 still refreshes the token once
            _http.Reply(401, "{\"error\":{\"code\":\"UNAUTHORIZED\"}}").Reply(200, Status);
            await _api.GetTransferCodeAsync();
            Assert.Equal(1, _auth.Forced);
            Assert.Equal(1, events);
        }
    }
}
