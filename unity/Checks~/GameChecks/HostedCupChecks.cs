// プレイヤー主催カップ (REQ-CUP-001..018, contracts/protocol.md §42): HostedCupModel over a routed fake server. The list
// (limits, trophy shelf), the create form's local checks and the keyed create, code entry (normalized, a wrong code / the
// hourly cap / a full cup), the lobby (entrants as typed, rules, start hints, the host's leave warning), the standings
// table and the result card (no names), and English with player-typed names untouched.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class HostedCupChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    const string PlayerJson = "{\"id\":\"me\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[{\"id\":\"h1\",\"name\":\"ハヤテ\",\"rarity\":\"SR\",\"status\":\"active\",\"base\":{\"speed\":700}}],\"equipment\":{\"tack\":{},\"decor\":[]}}";
    static string Cup(string role, string status, string startProblem, bool canStart, int racesDone, string standings, string cancel = null) =>
        "{\"cupId\":\"cup_abcdefghijklmnop\",\"cupName\":\"1着\",\"hostId\":\"h\",\"hostName\":\"トオル\",\"role\":\"" + role + "\",\"code\":\"K7PM-Q2XD\",\"format\":\"best_of_3\",\"capacity\":6,\"racesTotal\":3,\"racesDone\":" + racesDone + "," +
        "\"conditions\":{\"trackId\":\"aoba_turf_1600\",\"going\":\"yielding\",\"night\":true,\"weather\":\"sunny\",\"temperatureC\":18,\"windKmh\":0},\"opensAt\":1796695200000,\"closesAt\":1796706000000,\"status\":\"" + status + "\",\"partial\":false,\"cancelReason\":" + (cancel == null ? "null" : "\"" + cancel + "\"") + ",\"finishedAt\":null," +
        "\"entrants\":[{\"playerId\":\"h\",\"displayName\":\"トオル\",\"horseName\":\"アイボウ\",\"withdrawn\":false},{\"playerId\":\"me\",\"displayName\":\"ゆう\",\"horseName\":\"ハヤテ\",\"withdrawn\":false},{\"playerId\":\"x\",\"displayName\":\"Kenta\",\"horseName\":\"\",\"withdrawn\":true}]," +
        "\"races\":[],\"standings\":[" + standings + "],\"canStart\":" + (canStart ? "true" : "false") + ",\"startProblem\":" + (startProblem == null ? "null" : "\"" + startProblem + "\"") + ",\"minEntrants\":2}";
    const string Standings = "{\"playerId\":\"me\",\"rank\":1,\"points\":27,\"places\":[2,1,1],\"displayName\":\"ゆう\",\"trophy\":\"gold\"},{\"playerId\":\"h\",\"rank\":2,\"points\":17,\"places\":[1,null,2],\"displayName\":\"トオル\",\"trophy\":\"silver\"}";
    const string Mine = "{\"enabled\":true,\"limits\":{\"maxActivePerHost\":2,\"maxEntriesPerPlayer\":4,\"minCapacity\":4,\"maxCapacity\":8,\"minEntrants\":2,\"nameMaxChars\":20,\"minWindowMinutes\":15,\"maxWindowHours\":72,\"maxLeadHours\":168,\"pointsByPlace\":[10,7,5,4]},\"active\":[],\"invites\":[],\"history\":[],\"trophies\":{\"gold\":1,\"silver\":0,\"bronze\":2},\"teamId\":null}";

    static HttpResponse Ok(string body) => new HttpResponse(200, body);
    static HttpResponse Err(int status, string code) => new HttpResponse(status, "{\"error\":{\"code\":\"" + code + "\",\"message\":\"" + code + "\"}}");

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/cups"] = _ => Ok(Mine);
        string lobby = Cup("host", "open", "not_open", false, 0, "");
        s.Routes["POST /v1/cups"] = r => r.Headers.ContainsKey("idempotency-key") ? Ok("{\"cup\":" + lobby + ",\"created\":true}") : Err(400, "IDEMPOTENCY_KEY_REQUIRED");
        int lookups = 0;
        s.Routes["POST /v1/cups/lookup"] = r =>
        {
            lookups++;
            if (lookups > 3) return Err(429, "RATE_LIMITED");
            return r.Body.Contains("K7PMQ2XD") ? Ok("{\"cupId\":\"cup_abcdefghijklmnop\",\"cupName\":\"1着\",\"hostName\":\"トオル\",\"format\":\"single\",\"capacity\":4,\"entrants\":3,\"conditions\":null,\"opensAt\":1,\"closesAt\":2,\"role\":\"none\"}") : Err(404, "CUP_CODE_INVALID");
        };
        s.Routes["POST /v1/cups/join"] = r => r.Body.Contains("K7PMQ2XD") ? Err(409, "CUP_FULL") : Ok("{\"cup\":" + Cup("entrant", "open", null, false, 0, "") + ",\"joined\":true}");
        s.Routes["GET /v1/cups/cup_abcdefghijklmnop"] = _ => Ok(lobby);
        s.Routes["POST /v1/cups/cup_abcdefghijklmnop/start"] = _ => Err(409, "CUP_NOT_READY");
        s.Routes["POST /v1/cups/cup_abcdefghijklmnop/leave"] = _ => Ok("{\"left\":true,\"cancelled\":true,\"cup\":null}");
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, new MemoryKeyValueStore(), ruleset);
        await b.InitializeAsync();
        var m = new HostedCupModel(b, id => id == "aoba_turf_1600" ? "青葉 芝1600m" : id, () => 1796690000000L) { MyPlayerId = "me" };

        var load = await m.LoadAsync();
        check(load.Ok && m.Enabled && m.CanHost && m.LimitsText == "主催 0/2・参加 0/4" && m.TrophyShelfText == "金 1・銀 0・銅 2", "cups: list, limits and trophy shelf (" + m.LimitsText + ")");

        // create: local checks, then a keyed create
        var req = new CupCreateRequest { CupName = "", Capacity = 6, Format = CupFormats.BestOf3, OpensAt = 1796695200000, ClosesAt = 1796706000000, HorseId = "h1", Conditions = new CupConditions { TrackId = "aoba_turf_1600", Weather = "sunny", TemperatureC = 18 } };
        check(m.CreateProblem(req) == "カップ名は1〜20文字です", "cups: an empty name is caught before sending");
        req.CupName = "1着"; req.Capacity = 9;
        check(m.CreateProblem(req) == "人数は4〜8人です", "cups: capacity out of range is caught");
        req.Capacity = 6; req.ClosesAt = req.OpensAt + 5 * 60_000;
        check(m.CreateProblem(req) == "開催の時間は15分〜72時間です", "cups: a window too short is caught");
        req.ClosesAt = 1796706000000;
        int before = s.Sent.Count;
        var created = await m.CreateAsync(req);
        check(created.Ok && m.Cup.IsHost && m.Cup.Code == "K7PM-Q2XD" && s.Sent.Skip(before).Any(x => x.Path == "/v1/cups" && x.Headers.ContainsKey("idempotency-key")), "cups: create is keyed and opens the lobby with the code");

        // lobby
        check(m.EntrantRows.Count == 3 && m.EntrantRows[0].Name == "トオル" && m.EntrantRows[0].Badge == "主催" && m.EntrantRows[1].Badge == "あなた" && m.EntrantRows[2].Badge == "棄権" && m.EntrantRows[2].Name == "Kenta", "cups: entrants as typed with host / you / withdrawn badges");
        check(m.RulesText(m.Cup.Conditions) == "青葉 芝1600m・稍重・ナイター" && m.SeatsText == "3/6人" && m.ProgressText == "第1レース / 全3レース", "cups: rules, seats and progress (" + m.RulesText(m.Cup.Conditions) + ")");
        check(m.StartHint == "開催の時間になると出走できます", "cups: the host sees why 出走 is off");
        var st = await m.StartAsync();
        check(!st.Ok && st.Message == "開催の時間になると出走できます", "cups: a refused start says why (CUP_NOT_READY)");
        check(m.LeaveConfirmText == HostedCupModel.TextHostLeave, "cups: the host's leave warns the cup is cancelled");
        check(!HostedCupModel.TextUnranked.Contains("報酬が") && HostedCupModel.TextUnranked.Contains("ランク外"), "cups: the unranked note");

        // code entry
        check(HostedCupModel.CodeForButton("k7pm q2xd") == "K7PM-Q2XD" && HostedCupModel.CodeForButton("K7PM") == null && HostedCupModel.CodeForButton("K7PM-Q2X0") == null, "cups: typed codes are normalized; incomplete ones keep 参加 off");
        var bad = await m.LookupAsync("AAAA-BBBB");
        check(!bad.Ok && bad.Message == HostedCupModel.TextCodeInvalid, "cups: a wrong code never says why");
        var ok = await m.LookupAsync("k7pm-q2xd");
        check(ok.Ok && m.Preview.CupName == "1着" && m.Preview.HostName == "トオル" && !m.Preview.Full, "cups: the preview shows the cup and its host only");
        var full = await m.JoinAsync("h1", code: "K7PM-Q2XD");
        check(!full.Ok && full.Message == HostedCupModel.TextFull, "cups: the last slot went to someone else → 満員");
        await m.LookupAsync("CCCC-DDDD");
        var limited = await m.LookupAsync("K7PM-Q2XD");
        check(!limited.Ok && limited.Message == HostedCupModel.TextCodeLimit, "cups: the hourly code cap");
        var inv = await m.JoinAsync("h1", cupId: "cup_x");
        check(inv.Ok && m.Cup.Role == "entrant", "cups: joining by invitation");

        // standings and the result card
        s.Routes["GET /v1/cups/cup_abcdefghijklmnop"] = _ => Ok(Cup("entrant", "finished", null, false, 3, Standings));
        await m.OpenAsync("cup_abcdefghijklmnop");
        var rows = m.StandingRows;
        check(rows.Count == 2 && rows[0].IsMe && rows[0].ScoreText == "27pt" && rows[0].PlacesText == "2-1-1" && rows[1].PlacesText == "1-—-2" && rows[0].Trophy == "gold", "cups: standings with points and per-race places");
        check(HostedCupModel.TrophyText("gold") == "金のトロフィー" && m.ProgressText == "全レースが終わりました", "cups: trophy and finished lines");
        var card = m.ResultCard("ハヤテ");
        check(card != null && card.PlaceText == "1位 / 3人" && card.ModeLabel == "主催カップ" && !card.ShareText.Contains("トオル") && !card.ShareText.Contains("1着"), "cups: the result card on the share card shows no names (" + card?.ShareText + ")");
        check(HostedCupModel.CancelText("host_left") == "主催者が抜けたため中止になりました", "cups: cancel reasons");
        var left = await m.LeaveAsync();
        check(left.Ok && m.Cup == null, "cups: leaving clears the lobby");

        // English: the game layer's texts in English, player-typed names untouched
        Loc.SetLocale("en");
        try
        {
            s.Routes["GET /v1/cups/cup_abcdefghijklmnop"] = _ => Ok(Cup("host", "open", "too_few", false, 1, Standings));
            await m.OpenAsync("cup_abcdefghijklmnop");
            var en = m.EntrantRows;
            check(en[0].Name == "トオル" && en[0].Badge == "Host" && m.Cup.CupName == "1着", "cups (en): names as typed, badges in English");
            check(!Loc.HasJapanese(m.ProgressText) && !Loc.HasJapanese(m.StartHint) && !Loc.HasJapanese(m.SeatsText) && !Loc.HasJapanese(m.LimitsText) && !Loc.HasJapanese(m.TrophyShelfText), "cups (en): progress, start hint, seats, limits, shelf (" + m.ProgressText + " / " + m.StartHint + ")");
            check(!Loc.HasJapanese(HostedCupModel.FormatText(CupFormats.BestOf3)) && !Loc.HasJapanese(m.StandingRows[0].ScoreText) && !Loc.HasJapanese(Loc.T(HostedCupModel.TextUnranked)), "cups (en): format, score and the unranked note");
            check(m.RulesText(m.Cup.Conditions) == "青葉 芝1600m · Yielding · Night", "cups (en): rules line (" + m.RulesText(m.Cup.Conditions) + ")");
        }
        finally { Loc.SetLocale("ja"); }
    }
}
