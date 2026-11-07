using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// 友達招待 on the wire (contracts/protocol.md §19). The bodies were produced by the real server code (invite.ts with the
    /// shipped master data: alice invited bob and carol, bob finished the beginner missions), so their shapes match the server.
    /// </summary>
    public class ApiClientInviteTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientInviteTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        internal const string Inviter = @"{""code"":""92W65BGF"",""displayCode"":""92W6-5BGF"",""share"":{""deepLink"":""muchi://invite/92W65BGF"",""url"":""https://invite.muchi-issen.example/i/92W65BGF"",""text"":""騎手LICEさんから「ムチ一閃」への招待です。招待コード 92W6-5BGF を入力すると、はじめてのプレゼントがもらえます。\nhttps://invite.muchi-issen.example/i/92W65BGF""},""redeem"":{""eligible"":true,""reason"":null,""windowDays"":7,""daysLeft"":7,""invitedBy"":null,""welcomeGift"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""invitees"":[{""playerId"":""bob"",""at"":1793934000000,""counted"":true,""milestones"":[{""id"":""im_graduate"",""at"":1793937600000,""rewarded"":true}],""displayName"":""ボブ""},{""playerId"":""carol"",""at"":1793937600000,""counted"":true,""milestones"":[],""displayName"":""キャロル""}],""counted"":2,""cap"":10,""milestones"":[{""id"":""im_graduate"",""kind"":""beginner_complete"",""classId"":null,""target"":null,""reward"":{""freeCoins"":100},""rewardYen"":160},{""id"":""im_class_b"",""kind"":""class"",""classId"":""B"",""target"":null,""reward"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]},""rewardYen"":160}],""termsKey"":""terms.invite""}";
        internal const string Invitee = @"{""code"":""6TB4JFMB"",""displayCode"":""6TB4-JFMB"",""share"":{""deepLink"":""muchi://invite/6TB4JFMB"",""url"":""https://invite.muchi-issen.example/i/6TB4JFMB"",""text"":""騎手BOBさんから「ムチ一閃」への招待です。招待コード 6TB4-JFMB を入力すると、はじめてのプレゼントがもらえます。\nhttps://invite.muchi-issen.example/i/6TB4JFMB""},""redeem"":{""eligible"":false,""reason"":""already_redeemed"",""windowDays"":7,""daysLeft"":7,""invitedBy"":{""playerId"":""alice"",""at"":1793934000000,""milestones"":[""im_graduate""],""displayName"":""ハヤテ騎手""},""welcomeGift"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]}},""invitees"":[],""counted"":0,""cap"":10,""milestones"":[{""id"":""im_graduate"",""kind"":""beginner_complete"",""classId"":null,""target"":null,""reward"":{""freeCoins"":100},""rewardYen"":160},{""id"":""im_class_b"",""kind"":""class"",""classId"":""B"",""target"":null,""reward"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]},""rewardYen"":160}],""termsKey"":""terms.invite""}";
        internal const string Redeem = @"{""status"":""redeemed"",""inviter"":{""playerId"":""alice"",""displayName"":""ハヤテ騎手""},""welcomeGift"":{""items"":[{""itemId"":""gacha_ticket"",""qty"":1}]},""friended"":true}";

        [Fact]
        public async Task GetInviteSendsTheInstallIdHeaderAndParsesEverything()
        {
            _http.Reply(200, Inviter);
            var v = await _api.GetInviteAsync("inst-alice-0001");
            var r = _http.Requests[0];
            Assert.Equal("GET", r.Method);
            Assert.Equal("/v1/invite", r.Path);
            Assert.Equal("inst-alice-0001", r.Headers["x-install-id"]);
            Assert.Equal("92W65BGF", v.Code);
            Assert.Equal("92W6-5BGF", v.DisplayCode);
            Assert.Equal("muchi://invite/92W65BGF", v.Share.DeepLink);
            Assert.Equal("https://invite.muchi-issen.example/i/92W65BGF", v.Share.Url);
            Assert.Contains("92W6-5BGF", v.Share.Text);
            Assert.True(v.Redeem.Eligible);
            Assert.Null(v.Redeem.InvitedBy);
            Assert.Equal("gacha_ticket", v.Redeem.WelcomeGift.Items[0].ItemId);
            Assert.Equal(2, v.Counted);
            Assert.Equal(10, v.Cap);
            Assert.Equal(new[] { "bob", "carol" }, v.Invitees.Select(x => x.PlayerId).ToArray());
            Assert.Equal("ボブ", v.Invitees[0].DisplayName);
            Assert.True(v.Invitees[0].Milestones[0].Rewarded);
            Assert.Equal(new[] { "im_graduate", "im_class_b" }, v.Milestones.Select(x => x.Id).ToArray());
            Assert.Equal(100, v.Milestones[0].Reward.FreeCoins);
            Assert.Equal("B", v.Milestones[1].ClassId);
            Assert.All(v.Milestones, x => Assert.True(x.RewardYen <= 200));
            Assert.Equal("terms.invite", v.TermsKey);

            _http.Reply(200, Invitee);
            var b = await _api.GetInviteAsync();
            Assert.False(_http.Requests[1].Headers.ContainsKey("x-install-id"));
            Assert.Equal("already_redeemed", b.Redeem.Reason);
            Assert.Equal("ハヤテ騎手", b.Redeem.InvitedBy.DisplayName);
            Assert.Equal(new[] { "im_graduate" }, b.Redeem.InvitedBy.Milestones);
        }

        [Fact]
        public async Task RedeemPostsCodeAndInstallIdAndMapsErrors()
        {
            _http.Reply(200, Redeem);
            var r = await _api.RedeemInviteAsync("92w6-5bgf", "inst-bob-0001");
            var req = _http.Requests[0];
            Assert.Equal("POST", req.Method);
            Assert.Equal("/v1/invite/redeem", req.Path);
            Assert.Equal("{\"code\":\"92w6-5bgf\",\"installId\":\"inst-bob-0001\"}", req.Body);
            Assert.Equal("redeemed", r.Status);
            Assert.Equal("alice", r.InviterId);
            Assert.Equal("ハヤテ騎手", r.InviterName);
            Assert.True(r.Friended);
            Assert.Equal(1, r.WelcomeGift.Items[0].Qty);

            _http.Reply(400, "{\"error\":{\"code\":\"INVITE_CODE_INVALID\",\"message\":\"not an invite code\"}}");
            var e1 = await Assert.ThrowsAsync<ValidationException>(() => _api.RedeemInviteAsync("x", "inst-bob-0001"));
            Assert.Equal(ApiErrorCode.InviteCodeInvalid, e1.Code);
            foreach (var (wire, code) in new[] { ("INVITE_SELF", ApiErrorCode.InviteSelf), ("INVITE_ALREADY_REDEEMED", ApiErrorCode.InviteAlreadyRedeemed), ("INVITE_WINDOW_CLOSED", ApiErrorCode.InviteWindowClosed), ("INVITE_REFUSED", ApiErrorCode.InviteRefused) })
            {
                _http.Reply(409, "{\"error\":{\"code\":\"" + wire + "\",\"message\":\"m\"}}");
                var e = await Assert.ThrowsAsync<ConflictException>(() => _api.RedeemInviteAsync("92W65BGF", "inst-bob-0001"));
                Assert.Equal(code, e.Code);
            }
            int before = _http.Requests.Count;
            _http.Reply(429, "{\"error\":{\"code\":\"RATE_LIMITED\",\"message\":\"m\"}}");
            await Assert.ThrowsAsync<RateLimitedException>(() => _api.RedeemInviteAsync("92W65BGF", "inst-bob-0001"));
            Assert.Equal(before + 1, _http.Requests.Count); // a redeem is not retried automatically (each try counts toward the limit)
            await Assert.ThrowsAsync<ArgumentException>(() => _api.RedeemInviteAsync("92W65BGF", ""));
        }

        [Fact]
        public void CodesNormaliseLikeTheServerAndLinksResolve()
        {
            Assert.Equal("92W65BGF", InviteCodes.Normalize("92w6-5bgf"));
            Assert.Equal("92W65BGF", InviteCodes.Normalize(" 92W6 5BGF "));
            Assert.Equal("6TB4JFMB", InviteCodes.Normalize("6TB4-JFMB"));
            Assert.Null(InviteCodes.Normalize("92W65BGG")); // check symbol
            Assert.Null(InviteCodes.Normalize("92W65BG"));
            Assert.Null(InviteCodes.Normalize("A2W65BGF")); // vowels are never in a code
            Assert.Equal("92W6-5BGF", InviteCodes.Display("92W65BGF"));
            Assert.Equal("92W65BGF", InviteCodes.FromLink("muchi://invite/92W65BGF"));
            Assert.Equal("92W65BGF", InviteCodes.FromLink("muchi://invite/92w65bgf/?src=line"));
            Assert.Equal("92W65BGF", InviteCodes.FromLink("https://invite.muchi-issen.example/i/92W65BGF#x"));
            Assert.Null(InviteCodes.FromLink("muchi://race/92W65BGF"));
            Assert.Null(InviteCodes.FromLink("https://example.com/other/92W65BGF"));
            Assert.Null(InviteCodes.FromLink(null));
        }

        [Fact]
        public void AlphabetAndCheckSymbolMatchTheServer()
        {
            string ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "invite.ts"));
            var alpha = Regex.Match(ts, "INVITE_ALPHABET = '([0-9A-Z]+)'").Groups[1].Value;
            Assert.Equal(InviteCodes.Alphabet, alpha);
            Assert.Contains("(A.indexOf(body[i]!) + 1) * (i + 2)", ts); // same weights as InviteCodes.Check
        }

        [Fact]
        public async Task InviteShareEventMatchesTheServerSchema()
        {
            _http.Reply(200, "{\"accepted\":1,\"dropped\":0}");
            await _api.SendAnalyticsAsync("ios", "1", new[] { AnalyticsEvent.InviteShare(5, "os_share") });
            Assert.Equal("{\"platform\":\"ios\",\"appVersion\":\"1\",\"events\":[{\"name\":\"invite_share\",\"at\":5,\"props\":{\"channel\":\"os_share\"}}]}", _http.Requests[0].Body);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.InviteShare(0, "sms"));
            string ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "kpi.ts"));
            Assert.Contains("z.literal('invite_share')", ts);
            Assert.Contains("'os_share', 'copy_code', 'copy_link'", ts);
        }
    }
}
