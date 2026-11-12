// Round 21 game-layer checks: ディープリンク・再戦 (DeepLinkModel / RematchModel, REQ-LINK-001..024). The bodies are the shapes
// the real server returns (server/test/deep-links.test.ts, engine/Muchi.Engine.Tests/ApiClientDeepLinksTests.cs).
using Muchi.Client;
using Muchi.Game;
using Muchi.Net;

static class DeepLinkChecks
{
    const string Tok = "k7mq3xphr2abcdefghjkmn";
    const string Room = @"{""state"":""ok"",""type"":""room"",""screen"":""friend_room_join"",""target"":{""passphrase"":""123456""},""expiresAt"":1794281400000}";

    sealed class FakeLinks : IDeepLinkApi
    {
        public string Body = Room;
        public ApiException Fail;
        public readonly List<string> Resolved = new();
        public readonly List<string> Created = new();
        public Task<ResolvedLink> ResolveAsync(string token, CancellationToken ct)
        {
            Resolved.Add(token);
            if (Fail != null) throw Fail;
            return Task.FromResult(ResolvedLink.Parse(JsonNode.Parse(Body)));
        }
        public Task<CreatedLink> CreateAsync(string type, IDictionary<string, string> target, CancellationToken ct)
        {
            Created.Add(type);
            if (Fail != null) throw Fail;
            return Task.FromResult(new CreatedLink { Token = Tok, Type = type, Url = "https://link.muchi-issen.example/l/" + Tok, ShareText = "ムチ一閃のフレンド部屋に招待します\nhttps://link.muchi-issen.example/l/" + Tok, Created = true });
        }
    }

    sealed class Sheet : IShareSheet
    {
        public string Text;
        public Task<bool> ShareAsync(string filePath, string text, CancellationToken ct) { Text = text; return Task.FromResult(true); }
    }

    sealed class FakeRematch : IRematchApi
    {
        public string Next;
        public int Calls;
        public TaskCompletionSource<bool> Gate;
        public async Task<RematchView> PressAsync(string raceId, string horseId, CancellationToken ct) { Calls++; if (Gate != null) await Gate.Task; return RematchView.Parse(JsonNode.Parse(Next)); }
        public Task<RematchView> StatusAsync(string raceId, CancellationToken ct) { Calls++; return Task.FromResult(RematchView.Parse(JsonNode.Parse(Next))); }
        public Task<RematchView> DeclineAsync(string raceId, CancellationToken ct) { Calls++; return Task.FromResult(RematchView.Parse(JsonNode.Parse(Next))); }
    }

    public static async Task Run(Action<bool, string> check)
    {
        var kv = new MemoryKeyValueStore();
        var api = new FakeLinks();
        var sent = new List<AnalyticsEvent>();
        bool ftueDone = false;
        var m = new DeepLinkModel(api, kv, () => ftueDone, sent.Add, () => 7);

        // FTUE: the link waits (one slot, survives a restart), opens after the FTUE
        check(!m.Receive("https://evil.example/p/x"), "not a link: refused, nothing kept");
        check(m.Notice == DeepLinkModel.TextInvalid && m.Pending == null, "not a link: notice, nothing pending");
        check(m.Receive("https://link.muchi-issen.example/l/" + Tok), "a universal link is accepted");
        check(m.Queued && m.Notice == DeepLinkModel.TextQueued, "during the FTUE the link is queued");
        check(await m.TryOpenAsync(true) == null && api.Resolved.Count == 0, "nothing is resolved during the FTUE");
        var m2 = new DeepLinkModel(api, kv, () => ftueDone, sent.Add, () => 7);
        check(m2.Pending == Tok, "the queued link survives a restart (key-value store)");
        ftueDone = true;
        check(await m2.TryOpenAsync(false) == null && api.Resolved.Count == 0, "offline: still waiting");
        var route = await m2.TryOpenAsync(true);
        check(route != null && route.Screen == DeepLinkRoutes.FriendRoomJoin && route.Link.Passphrase == "123456", "after the FTUE the link routes to the friend room join screen");
        check(route.RequiresConfirm, "the screen opens on a confirmation: nothing is joined / spent automatically");
        check(m2.Pending == null, "the link is used once");
        check(sent.Count == 1 && sent[0].Name == "deep_link_open" && sent[0].PropsJson.Contains("\"universal\"") && sent[0].PropsJson.Contains("\"room\"") && !sent[0].PropsJson.Contains(Tok), "KPI: entry and type, never the token");

        // the newest link wins; scheme links; network failure keeps the link
        m.Receive("muchi://l/" + Tok);
        m.Receive(DeepLinkParser.Format(Tok).ToUpperInvariant());
        check(kv.Get(DeepLinkModel.KeyPendingEntry) == DeepLinkEntries.Typed, "one slot: the newest link (typed) replaces the earlier one");
        api.Fail = new ApiException(ApiErrorCode.Network, "NETWORK", "x", 0);
        check(await m.TryOpenAsync(true) == null && m.Pending == Tok, "a network failure keeps the link for the next try");
        api.Fail = null;

        // one neutral notice per state
        foreach (var (body, text) in new[] {
            (@"{""state"":""unavailable""}", DeepLinkModel.TextUnavailable),
            (@"{""state"":""friends_only"",""type"":""replay""}", DeepLinkModel.TextFriendsOnly),
            (@"{""state"":""maintenance"",""type"":""room"",""endAt"":1,""endsAtJst"":""11/11 13:00"",""message"":""m""}", DeepLinkModel.TextMaintenance),
            (@"{""state"":""update_required"",""type"":""team"",""minVersion"":""2.0.0"",""storeUrl"":""https://apps.apple.com/app/id0""}", DeepLinkModel.TextUpdate),
            (@"{""state"":""ok"",""type"":""future_type"",""target"":{}}", DeepLinkModel.TextUpdate) })
        {
            api.Body = body;
            m.Receive(Tok);
            check(await m.TryOpenAsync(true) == null && m.Notice == text, "state → notice: " + text);
        }
        check(sent.Last().PropsJson.Contains("\"none\""), "a link that did not open is counted as type none");
        api.Fail = new RateLimitedException("RATE_LIMITED", "x", 429);
        m.Receive(Tok);
        check(await m.TryOpenAsync(true) == null && m.Notice == DeepLinkModel.TextWait && m.Pending == null, "too many lookups: wait notice, the link is dropped (not retried in a loop)");
        api.Fail = null;

        // invite / friend links open their screens only (the invite code is entered by the player: §19 rewards unchanged)
        api.Body = @"{""state"":""ok"",""type"":""invite"",""screen"":""invite_redeem"",""target"":{""code"":""92W65BGF""}}";
        m.Receive(Tok);
        var inv = await m.TryOpenAsync(true);
        check(inv.Screen == DeepLinkRoutes.InviteRedeem && inv.Link.Code == "92W65BGF" && inv.RequiresConfirm, "invite link → the code entry screen, pre-filled, not redeemed");

        // Android install referrer: read once
        var kv2 = new MemoryKeyValueStore();
        var m3 = new DeepLinkModel(api, kv2, () => true);
        check(m3.ReceiveInstallReferrer("utm_source=google-play&link%3D" + Tok) && kv2.Get(DeepLinkModel.KeyPendingEntry) == DeepLinkEntries.Referrer, "the install referrer carries the token (Android deferred link)");
        check(!m3.ReceiveInstallReferrer("link=" + Tok), "the referrer is read only on the first launch");

        // share
        var sheet = new Sheet();
        check(await m.ShareAsync(sheet, LinkTypes.Room, new Dictionary<string, string> { ["passphrase"] = "123456" }) && sheet.Text.Contains("/l/" + Tok), "share: the server's text and link go to the share sheet");
        api.Fail = new ApiException(ApiErrorCode.LinkLimit, "LINK_LIMIT", "x", 429);
        check(!await m.ShareAsync(sheet, LinkTypes.Friend) && m.Notice == "今日はこれ以上リンクを作れません", "the daily link limit is a notice");
        api.Fail = null;

        // rematch
        var ra = new FakeRematch { Next = @"{""raceId"":""r-9"",""state"":""waiting"",""reason"":null,""you"":""pressed"",""pressed"":1,""eligible"":3,""windowSec"":20,""deadlineAt"":20000,""room"":null}" };
        var rm = new RematchModel(ra, "r-9", () => 8000);
        check(rm.ButtonLabel == "再戦 »" && rm.CanPress, "the result screen shows 再戦");
        ra.Gate = new TaskCompletionSource<bool>();
        var p1 = rm.PressAsync("h1");
        var p2 = rm.PressAsync("h1"); // double tap while the first call is in flight
        ra.Gate.SetResult(true);
        await Task.WhenAll(p1, p2);
        check(ra.Calls == 1, "a double tap sends one press");
        check(rm.Pressed && rm.ShouldPoll && rm.StatusText == "再戦を待っています（1/3人・あと12秒）", "waiting: count and the real seconds left");
        ra.Gate = null;
        ra.Next = @"{""raceId"":""r-9"",""state"":""opened"",""reason"":null,""you"":""pressed"",""pressed"":2,""eligible"":3,""windowSec"":20,""deadlineAt"":20000,""room"":{""passphrase"":""654321"",""members"":2,""host"":false}}";
        await rm.PollAsync();
        check(rm.RoomPassphrase == "654321" && !rm.ShouldPoll && rm.StatusText == "新しい部屋ができました", "opened: go to the new room, polling stops");
        check(!rm.CanPress, "after the outcome the button is not pressable");
        ra.Next = @"{""raceId"":""r-9"",""state"":""closed"",""reason"":""not_included"",""you"":""pressed"",""pressed"":2,""eligible"":3,""windowSec"":20,""deadlineAt"":20000,""room"":null}";
        await rm.PollAsync();
        check(rm.RoomPassphrase == null && rm.StatusText == "この再戦には入れませんでした", "left out: one neutral line (never why)");
        ra.Next = @"{""raceId"":""r-9"",""state"":""closed"",""reason"":""too_few"",""you"":""pressed"",""pressed"":1,""eligible"":3,""windowSec"":20,""deadlineAt"":20000,""room"":null}";
        await rm.PollAsync();
        check(rm.StatusText == "人数がそろわず、再戦は開きませんでした", "too few: the rematch did not open");
    }
}
