// 厩舎の整理 (REQ-ORG-001..016, contracts/protocol.md §44): RosterOrganiserModel over a routed fake server. Local sort / filters /
// search kept per device, lock / favourite, bulk selection (blocked horses never selected), the two-step confirmation (every
// horse, nothing given back, same-size buttons), the keyed confirm, an all-or-nothing refusal, a stale preview, KPI and English.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using Muchi.Net;

static class RosterChecks
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

    const string PlayerJson = "{\"id\":\"a\",\"wallet\":{\"paid\":0,\"free\":500,\"total\":500,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},\"horses\":[{\"id\":\"h1\",\"name\":\"アイボウ\",\"rarity\":\"SR\",\"status\":\"active\",\"base\":{\"speed\":700}}],\"equipment\":{\"tack\":{},\"decor\":[]}}";
    static string Row(int i, string name, string rarity, int rating, bool partner = false, bool locked = false, bool fav = false, string status = "active", string surface = "turf", int min = 1600, int max = 2400, string blocks = "") =>
        "{\"horseId\":\"h" + i + "\",\"name\":\"" + name + "\",\"templateId\":null,\"rarity\":\"" + rarity + "\",\"sex\":\"male\",\"style\":\"sashi\",\"surface\":\"" + surface + "\",\"distMinM\":" + min + ",\"distMaxM\":" + max +
        ",\"goingAptitude\":\"any\",\"status\":\"" + status + "\",\"rating\":" + rating + ",\"skillId\":null,\"partner\":" + (partner ? "true" : "false") + ",\"locked\":" + (locked ? "true" : "false") + ",\"favorite\":" + (fav ? "true" : "false") +
        ",\"acquiredSeq\":" + i + ",\"bornAt\":0,\"ageDays\":" + (10 - i) + ",\"races\":" + (i * 2) + ",\"wins\":" + i + ",\"blocks\":[" + blocks + "]}";
    static string View(params string[] rows) => "{\"total\":" + rows.Length + ",\"active\":" + rows.Count(r => r.Contains("\"active\"")) + ",\"retired\":" + rows.Count(r => r.Contains("\"retired\"")) +
        ",\"locked\":0,\"favorites\":0,\"bulkMax\":50,\"actions\":[\"retire\"],\"partnerHorseId\":\"h1\",\"horses\":[" + string.Join(",", rows) + "],\"notice\":\"まとめて引退しても、コインや素材は返ってきません\"}";
    static HttpResponse Ok(string body) => new HttpResponse(200, body);
    const string NoRefund = "{\"paidCoins\":0,\"freeCoins\":0,\"materials\":{},\"items\":{}}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset)
    {
        var s = new FakeServer();
        s.Routes["POST /v1/player/bootstrap"] = _ => Ok(PlayerJson);
        s.Routes["GET /v1/player"] = _ => Ok(PlayerJson);
        bool h4Locked = true, retired = false;
        s.Routes["GET /v1/roster"] = _ => Ok(View(
            Row(1, "アイボウ", "SR", 2600, partner: true, blocks: "\"partner\""),
            Row(2, "ミドリノカゼ", "SSR", 3100, status: retired ? "retired" : "active", blocks: retired ? "\"not_active\",\"hall_pending\"" : ""),
            Row(3, "ハヤテ", "R", 2100, surface: "dirt", min: 1000, max: 1400, status: retired ? "retired" : "active", blocks: retired ? "\"not_active\",\"hall_pending\"" : ""),
            Row(4, "ヨゾラ", "SR", 2400, locked: h4Locked, blocks: h4Locked ? "\"locked\"" : "")));
        s.Routes["PUT /v1/horses/h4/lock"] = r => { h4Locked = r.Body.Contains("true"); return Ok("{\"horseId\":\"h4\",\"locked\":" + (h4Locked ? "true" : "false") + "}"); };
        s.Routes["PUT /v1/horses/h3/favorite"] = r => Ok("{\"horseId\":\"h3\",\"favorite\":" + (r.Body.Contains("true") ? "true" : "false") + "}");
        string previewFor(string body)
        {
            var ids = new[] { "h2", "h3", "h4" }.Where(id => body.Contains("\"" + id + "\"")).ToList();
            var hs = ids.Select(id => "{\"horseId\":\"" + id + "\",\"name\":\"" + (id == "h2" ? "ミドリノカゼ" : id == "h3" ? "ハヤテ" : "ヨゾラ") + "\",\"ok\":" + (id == "h4" && h4Locked ? "false" : "true") + ",\"reasons\":[" + (id == "h4" && h4Locked ? "\"locked\"" : "") + "]}");
            bool ok = !(ids.Contains("h4") && h4Locked);
            return "{\"action\":\"retire\",\"count\":" + ids.Count + ",\"eligible\":" + (ok ? ids.Count : ids.Count - 1) + ",\"refused\":" + (ok ? 0 : 1) + ",\"horses\":[" + string.Join(",", hs) + "],\"refund\":" + NoRefund + ",\"canConfirm\":" + (ok ? "true" : "false") + ",\"confirmToken\":\"r1-" + ids.Count + (ok ? "ok" : "no") + "\"}";
        }
        s.Routes["POST /v1/roster/bulk/preview"] = r => Ok(previewFor(r.Body));
        var keys = new List<string>();
        int bulkCalls = 0;
        s.Routes["POST /v1/roster/bulk"] = r =>
        {
            bulkCalls++;
            keys.Add(r.Headers.TryGetValue("idempotency-key", out var k) ? k : null);
            if (bulkCalls == 1) return new HttpResponse(409, "{\"error\":{\"code\":\"ROSTER_BULK_STALE\",\"message\":\"stale\"}}");
            if (bulkCalls == 2) return new HttpResponse(409, "{\"error\":{\"code\":\"ROSTER_BULK_REFUSED\",\"message\":\"refused\",\"details\":{\"horses\":[{\"horseId\":\"h3\",\"name\":\"ハヤテ\",\"ok\":false,\"reasons\":[\"in_training\"]}]}}}");
            retired = true;
            return Ok("{\"action\":\"retire\",\"count\":2,\"horses\":[{\"horseId\":\"h2\",\"name\":\"ミドリノカゼ\",\"ceremony\":{\"horseId\":\"h2\",\"horseName\":\"ミドリノカゼ\",\"retiredAt\":1,\"partner\":false,\"career\":{},\"highlights\":[],\"inducted\":false,\"reasons\":[],\"rewardItemId\":null,\"ackedAt\":null}},{\"horseId\":\"h3\",\"name\":\"ハヤテ\",\"ceremony\":null}],\"refund\":" + NoRefund + "}");
        };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var store = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, store, ruleset);
        await b.InitializeAsync();
        var events = new List<AnalyticsEvent>();
        long clock = 1_000_000;
        var m = new RosterOrganiserModel(b, events.Add, () => clock);

        var load = await m.LoadAsync();
        check(load.Ok && m.CountText == "4頭（現役4・引退0）" && m.Lines.Count == 4, "roster: list loads (" + m.CountText + ")");
        check(m.Lines[0].HorseId == "h4" && m.Lines[0].Name == "ヨゾラ" && m.Lines[0].Locked && !m.Lines[0].Selectable && m.Lines[0].BlockText == "ロック中", "roster: newest first, a locked horse shows 「ロック中」 and cannot be selected");
        check(m.Lines.Single(l => l.HorseId == "h1").BlockText == "最初の相棒はまとめて引退できません", "roster: the first partner is not selectable in bulk");

        m.SetSort("rating");
        check(string.Join(",", m.Rows.Select(r => r.HorseId)) == "h2,h1,h4,h3" && m.SortText == "並び：能力（高い順）", "roster: sort by rating (" + m.SortText + ")");
        clock += 200;
        m.SetSort("rating");
        check(string.Join(",", m.Rows.Select(r => r.HorseId)) == "h3,h4,h1,h2" && m.SortText == "並び：能力（低い順）", "roster: the same key again flips the direction");
        check(events.Count == 1 && events[0].Name == "roster_sort", "roster: roster_sort at most once a second (" + events.Count + ")");
        clock += 2000;
        m.SetFilters(q => q.Surface = "dirt");
        check(m.Rows.Single().HorseId == "h3" && events.Count == 2, "roster: filter dirt");
        m.SetFilters(q => q.Surface = "snow");
        check(m.Query.Surface == null, "roster: an unknown filter value falls back to no filter");
        m.SetSearch("みどり");
        check(m.Rows.Single().Name == "ミドリノカゼ", "roster: search folds hiragana");
        m.SetSort("aptitude", new RosterCourse { Surface = "dirt", DistanceM = 1200, Going = "good" });
        check(m.Lines.Single().AptitudeMark == "×", "roster: the aptitude mark for the chosen course");
        var saved = store.Get(RosterOrganiserModel.KeyView);
        var m2 = new RosterOrganiserModel(b, null, () => clock);
        check(m2.Query.Encode() == saved && m2.Query.Sort == "aptitude" && m2.Query.Q == "みどり", "roster: the view is kept on this device (" + saved + ")");
        m.ClearFilters();
        m.SetSort("acquired");
        check(m.Rows.Count == 4, "roster: clear filters");

        var fav = await m.ToggleFavoriteAsync("h3");
        check(fav.Ok && m.Rows[0].HorseId == "h3", "roster: a favourite goes to the top");

        m.EnterSelectMode();
        check(!m.ToggleSelect("h4") && !m.ToggleSelect("h1") && m.ToggleSelect("h2") && m.ToggleSelect("h3") && m.Selected.Count == 2, "roster: blocked horses are never selected");
        var pv = await m.PreviewAsync();
        var sh = m.Sheet;
        check(pv.Ok && sh.CanConfirm && sh.Lines.Count == 2 && sh.Lines.All(l => l.Ok) && sh.Title == "2頭をまとめて引退させますか？", "roster: preview lists every horse (" + sh.Title + ")");
        check(sh.RefundText == RosterOrganiserModel.TextNothingBack && sh.Warning == RosterOrganiserModel.TextCannotUndo && sh.ButtonsSameSize && !sh.HasDefaultButton && sh.CancelLabel == "やめる" && sh.ConfirmLabel == "まとめて引退させる",
            "roster: the sheet says nothing comes back, cannot be undone, same-size buttons, no default");

        var stale = await m.ConfirmAsync();
        check(!stale.Ok && stale.Message == RosterOrganiserModel.TextStale && m.Sheet == null, "roster: a stale preview asks to check again");
        await m.PreviewAsync();
        var refused = await m.ConfirmAsync();
        check(!refused.Ok && !m.Sheet.CanConfirm && m.Sheet.Lines.Single(l => l.HorseId == "h3").ReasonText == "調教中", "roster: an all-or-nothing refusal names the horse and why");
        check(!retired, "roster: nothing retired on a refusal");
        var keyAfterRefusal = keys[1];
        await m.PreviewAsync();
        var done = await m.ConfirmAsync();
        check(done.Ok && done.Message == "2頭を引退させました" && m.Ceremonies.Count == 1 && !m.SelectMode, "roster: retired, one ceremony to show (" + done.Message + ")");
        check(keys.All(k => k != null) && keys[2] != keyAfterRefusal, "roster: every confirmation is keyed (a new key per preview)");
        check(m.CountText == "4頭（現役2・引退2）", "roster: reloaded after the bulk retire (" + m.CountText + ")");

        // lock toggling through the model
        var lk = await m.ToggleLockAsync("h4");
        check(lk.Ok && !h4Locked && m.Lines.Single(l => l.HorseId == "h4").Selectable, "roster: unlocking makes the horse selectable");

        // English: model texts translate, horse names stay as typed
        Loc.SetLocale("en");
        try
        {
            check(m.CountText == "4 horses (2 active, 2 retired)", "roster (en): count (" + m.CountText + ")");
            check(m.SortText == "Sort: Acquired (high to low)", "roster (en): sort line (" + m.SortText + ")");
            var line = m.Lines.Single(l => l.HorseId == "h4");
            check(line.Name == "ヨゾラ" && line.Meta == "Closer / Turf 1,600–2,400m" && line.RatingText == "Rating 2,400" && line.RecordText == "8 races, 4 wins", "roster (en): row texts; the name stays as typed (" + line.Meta + " | " + line.RecordText + ")");
            check(RosterOrganiserModel.Reason("tournament_entry") == "Entered in a tournament", "roster (en): reasons");
        }
        finally { Loc.SetLocale("ja"); }
    }
}
