using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>Profile, titles, stats, leaderboards and friends endpoints (server/src/http/app.ts, round 2).</summary>
    public class ApiClientSocialTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly FakeDelay _delay = new FakeDelay();
        private readonly ApiClient _api;

        public ApiClientSocialTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, _delay, new SeqIds());
        }

        private static string Canon(string json) => JsonNode.Parse(json).ToString();

        private HttpRequest Single(string method, string path, string body = null)
        {
            var r = Assert.Single(_http.Requests);
            Assert.Equal(method, r.Method);
            Assert.Equal(path, r.Path);
            if (body == null) Assert.True(r.Body == null || r.Body == "{}", "unexpected body " + r.Body);
            else Assert.Equal(Canon(body), Canon(r.Body));
            Assert.False(r.Headers.ContainsKey("idempotency-key"));
            return r;
        }

        private const string Profile = "{\"playerId\":\"p2\",\"displayName\":\"騎手AB12\",\"titleId\":\"t_first_win\",\"classId\":\"B\",\"rating\":1612,\"stats\":{\"races\":30,\"wins\":7,\"top3\":15},\"lastSeenAt\":1730000000000}";

        [Fact]
        public async Task SetDisplayName()
        {
            _http.Reply(200, "{\"displayName\":\"ハヤテ\"}");
            Assert.Equal("ハヤテ", await _api.SetDisplayNameAsync("ハヤテ"));
            Single("PUT", "/v1/player/profile", "{\"displayName\":\"ハヤテ\"}");
        }

        [Fact]
        public async Task TitlesAndEquip()
        {
            _http.Reply(200, "{\"equipped\":null,\"titles\":[{\"id\":\"t_first_win\",\"name\":\"初勝利\",\"unlocked\":true},{\"id\":\"t_100\",\"name\":\"百戦錬磨\",\"unlocked\":false}]}");
            var t = await _api.GetTitlesAsync();
            Assert.Null(t.Equipped);
            Assert.Equal(2, t.Titles.Count);
            Assert.True(t.Titles[0].Unlocked);
            Assert.False(t.Titles[1].Unlocked);
            Single("GET", "/v1/titles");

            _http.Requests.Clear();
            _http.Reply(200, "{\"titleId\":\"t_first_win\"}");
            Assert.Equal("t_first_win", await _api.EquipTitleAsync("t_first_win"));
            Single("PUT", "/v1/player/title", "{\"titleId\":\"t_first_win\"}");

            _http.Requests.Clear();
            _http.Reply(200, "{\"titleId\":null}");
            Assert.Null(await _api.EquipTitleAsync(null));
            Single("PUT", "/v1/player/title", "{\"titleId\":null}");
        }

        [Fact]
        public async Task Stats()
        {
            _http.Reply(200, "{\"races\":12,\"wins\":3,\"top3\":6,\"byStyle\":{\"sashi\":{\"races\":8,\"wins\":2}},\"byTrack\":{\"kirameki_turf_2000\":{\"races\":5,\"wins\":1,\"bestFinishTick\":1790}},\"whipPerfectWins\":1,\"bestStartReactionTicks\":0,\"perfectStarts\":2}");
            var s = await _api.GetStatsAsync();
            Assert.Equal(12, s.Races);
            Assert.Equal(0, s.BestStartReactionTicks);
            Assert.Equal(2, s.ByStyle["sashi"].Wins);
            Assert.Equal(1790, s.ByTrack["kirameki_turf_2000"].BestFinishTick);
            Single("GET", "/v1/stats");
        }

        [Fact]
        public async Task MyRankBeforeAndAfterSnapshot()
        {
            _http.Reply(200, "{\"rank\":null,\"standing\":null,\"generatedAt\":null}");
            var none = await _api.GetMyRankAsync();
            Assert.Null(none.Rank);
            Assert.Null(none.GeneratedAt);
            Single("GET", "/v1/leaderboards/me");

            _http.Requests.Clear();
            _http.Reply(200, "{\"rank\":{\"classId\":\"A\",\"classRank\":4,\"classTotal\":120,\"ratingRank\":40,\"ratingTotal\":900},\"standing\":{\"classId\":\"A\",\"points\":310,\"rating\":1700,\"races\":22},\"generatedAt\":1730000000000}");
            var r = await _api.GetMyRankAsync();
            Assert.Equal(4, r.Rank.ClassRank);
            Assert.Equal(310, r.Standing.Points);
        }

        [Fact]
        public async Task LeaderboardIsPublicAndEscaped()
        {
            _http.Reply(200, "{\"seasonId\":\"2026-11\",\"board\":\"class-A\",\"generatedAt\":1730000000000,\"total\":2,\"entries\":[{\"rank\":1,\"playerId\":\"p1\",\"displayName\":\"騎手\",\"titleId\":null,\"classId\":\"A\",\"points\":400,\"rating\":1800,\"races\":30}]}");
            var b = await _api.GetLeaderboardAsync("current", "class-A");
            Assert.Equal(2, b.Total);
            Assert.Equal(400, Assert.Single(b.Entries).Points);
            var req = Single("GET", "/v1/leaderboards/current/class-A");
            Assert.False(req.Headers.ContainsKey("authorization")); // public snapshot
        }

        [Fact]
        public async Task LeaderboardIndex()
        {
            _http.Reply(200, "{\"seasonId\":\"2026-11\",\"generatedAt\":1,\"boards\":[{\"board\":\"rating\",\"total\":900,\"key\":\"lb/2026-11/rating.json\"}]}");
            var idx = await _api.GetLeaderboardAsync("2026-11", "index");
            Assert.Equal("rating", Assert.Single(idx.Boards).Board);
        }

        [Fact]
        public async Task FriendList()
        {
            _http.Reply(200, "{\"friends\":[" + Profile + "],\"incoming\":[{\"playerId\":\"p3\",\"displayName\":\"x\",\"titleId\":null,\"classId\":\"C\",\"rating\":1500,\"stats\":{\"races\":0,\"wins\":0,\"top3\":0},\"lastSeenAt\":0,\"requestedAt\":5}],\"outgoing\":[],\"invites\":[{\"from\":" + Profile + ",\"passphrase\":\"hayate\",\"at\":9}]}");
            var f = await _api.GetFriendsAsync();
            var p = Assert.Single(f.Friends);
            Assert.Equal(1612, p.Rating);
            Assert.Equal(7, p.Wins);
            Assert.Equal(5, Assert.Single(f.Incoming).RequestedAt);
            Assert.Empty(f.Outgoing);
            Assert.Equal("hayate", Assert.Single(f.Invites).Passphrase);
            Assert.Equal("p2", f.Invites[0].From.PlayerId);
            Single("GET", "/v1/friends");
        }

        [Fact]
        public async Task FriendCodeAndRequest()
        {
            _http.Reply(200, "{\"code\":\"123456789\"}");
            Assert.Equal("123456789", await _api.GetFriendCodeAsync());
            Single("GET", "/v1/friends/code");

            _http.Requests.Clear();
            _http.Reply(200, "{\"status\":\"requested\",\"playerId\":\"p2\"}");
            var r = await _api.SendFriendRequestAsync("987654321");
            Assert.Equal("requested", r.Status);
            Single("POST", "/v1/friends/requests", "{\"code\":\"987654321\"}");
        }

        [Fact]
        public async Task AcceptDeclineCancelRemoveInvite()
        {
            _http.Reply(200, "{\"status\":\"friends\",\"playerId\":\"p/2\"}");
            Assert.Equal("friends", (await _api.AcceptFriendRequestAsync("p/2")).Status);
            Single("POST", "/v1/friends/requests/p%2F2/accept");

            _http.Requests.Clear();
            _http.Reply(200, "{\"ok\":true}");
            Assert.True(await _api.DeclineFriendRequestAsync("p3"));
            Single("POST", "/v1/friends/requests/p3/decline");

            _http.Requests.Clear();
            _http.Reply(200, "{\"ok\":true}");
            Assert.True(await _api.CancelFriendRequestAsync("p4"));
            Single("DELETE", "/v1/friends/requests/p4");

            _http.Requests.Clear();
            _http.Reply(200, "{\"ok\":true}");
            Assert.True(await _api.RemoveFriendAsync("p5"));
            Single("DELETE", "/v1/friends/p5");

            _http.Requests.Clear();
            _http.Reply(200, "{\"ok\":true}");
            Assert.True(await _api.InviteToFriendRoomAsync("hayate", "p2"));
            Single("POST", "/v1/friend-rooms/hayate/invite", "{\"friendId\":\"p2\"}");
        }

        [Fact]
        public async Task FriendOpsAreRetriedOnTransientErrors()
        {
            _http.Reply(503, "{\"error\":\"INTERNAL\"}").Reply(200, "{\"ok\":true}");
            Assert.True(await _api.RemoveFriendAsync("p5"));
            Assert.Equal(2, _http.Requests.Count);
        }

        [Theory]
        [InlineData("FRIEND_LIMIT", ApiErrorCode.FriendLimit)]
        [InlineData("ALREADY_IN_RACE", ApiErrorCode.AlreadyInRace)]
        [InlineData("ROOM_TOO_SMALL", ApiErrorCode.RoomTooSmall)]
        public async Task NewRuleErrorsAreTypedConflicts(string wire, ApiErrorCode code)
        {
            _http.Reply(409, "{\"error\":{\"code\":\"" + wire + "\",\"message\":\"x\"}}");
            var e = await Assert.ThrowsAsync<ConflictException>(() => _api.SendFriendRequestAsync("123456789"));
            Assert.Equal(code, e.Code);
        }
    }
}
