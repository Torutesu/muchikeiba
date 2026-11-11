using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-ORG-001..016: 厩舎の整理 (server/src/domain/roster.ts, contracts/protocol.md §44).
    // Sort / filter / search the stable, favourites and locks, bulk retire. The sorting rules are the server's (applyRosterQuery)
    // and run on the device too, so a saved view works offline; contracts/roster-query.vectors.json keeps both in step.
    // A bulk action repeats the single-horse retire inside one server transaction: all or nothing, keyed, nothing is paid back.
    // Horse names are what players typed: never translated.

    /// <summary>REQ-ORG-009: why a bulk action refuses a horse (protocol §44.4), in the server's order.</summary>
    public static class BulkReason
    {
        public const string NotFound = "not_found", Locked = "locked", Partner = "partner", NotActive = "not_active", OnLoan = "on_loan",
            InTraining = "in_training", TournamentEntry = "tournament_entry", CupEntry = "cup_entry", HallPending = "hall_pending";
        public static readonly string[] All = { NotFound, Locked, Partner, NotActive, OnLoan, InTraining, TournamentEntry, CupEntry, HallPending };
    }

    /// <summary>One horse of GET /v1/roster (REQ-ORG-001).</summary>
    public sealed class RosterRow
    {
        public string HorseId, Name, TemplateId, Rarity, Sex, Style, Surface, GoingAptitude = "any", Status, SkillId;
        public int DistMinM, DistMaxM, Rating, AcquiredSeq, AgeDays, Races, Wins;
        public long BornAt;
        public bool Partner, Locked, Favorite;
        /// <summary>Why a bulk retire would refuse it now (empty = can be selected).</summary>
        public string[] Blocks = new string[0];
        public Appearance Appearance;
        public bool IsActive => Status == "active";
        public bool Selectable => Blocks.Length == 0;

        public static RosterRow Parse(JsonNode o) => new RosterRow
        {
            HorseId = J.Str(o, "horseId"), Name = J.Str(o, "name"), TemplateId = J.Str(o, "templateId"), Rarity = J.Str(o, "rarity"), Sex = J.Str(o, "sex"),
            Style = J.Str(o, "style"), Surface = J.Str(o, "surface"), GoingAptitude = J.Str(o, "goingAptitude") ?? "any", Status = J.Str(o, "status"),
            SkillId = J.Str(o, "skillId"), DistMinM = J.Int(o, "distMinM"), DistMaxM = J.Int(o, "distMaxM"), Rating = J.Int(o, "rating"),
            AcquiredSeq = J.Int(o, "acquiredSeq"), AgeDays = J.Int(o, "ageDays"), Races = J.Int(o, "races"), Wins = J.Int(o, "wins"), BornAt = J.Long(o, "bornAt"),
            Partner = J.Bool(o, "partner"), Locked = J.Bool(o, "locked"), Favorite = J.Bool(o, "favorite"), Blocks = J.Strs(o, "blocks") ?? new string[0],
            Appearance = Appearance.Parse(J.Opt(o, "appearance")),
        };
    }

    /// <summary>GET /v1/roster.</summary>
    public sealed class RosterView
    {
        public int Total, Active, Retired, Locked, Favorites, BulkMax;
        public string[] Actions = new string[0];
        public string PartnerHorseId, Notice;
        public List<RosterRow> Horses = new List<RosterRow>();
        internal static RosterView Parse(JsonNode o) => new RosterView
        {
            Total = J.Int(o, "total"), Active = J.Int(o, "active"), Retired = J.Int(o, "retired"), Locked = J.Int(o, "locked"), Favorites = J.Int(o, "favorites"),
            BulkMax = J.Int(o, "bulkMax", 50), Actions = J.Strs(o, "actions") ?? new string[0], PartnerHorseId = J.Str(o, "partnerHorseId"), Notice = J.Str(o, "notice"),
            Horses = J.List(o, "horses", RosterRow.Parse),
        };
    }

    /// <summary>One horse of a bulk preview / refusal.</summary>
    public sealed class BulkHorseCheck
    {
        public string HorseId, Name;
        public bool Ok;
        public string[] Reasons = new string[0];
        internal static BulkHorseCheck Parse(JsonNode o) => new BulkHorseCheck
        {
            HorseId = J.Str(o, "horseId"), Name = J.Str(o, "name"), Ok = J.Bool(o, "ok"), Reasons = J.Strs(o, "reasons") ?? new string[0],
        };
    }

    /// <summary>What a bulk action gives back. Retiring gives nothing back (always zero); shown as 「なし」.</summary>
    public sealed class BulkRefund
    {
        public int PaidCoins, FreeCoins;
        public Dictionary<string, int> Materials = new Dictionary<string, int>(), Items = new Dictionary<string, int>();
        public bool IsNothing => PaidCoins == 0 && FreeCoins == 0 && Materials.Values.All(v => v == 0) && Items.Values.All(v => v == 0);
        internal static BulkRefund Parse(JsonNode o)
        {
            var r = new BulkRefund { PaidCoins = J.Int(o, "paidCoins"), FreeCoins = J.Int(o, "freeCoins") };
            foreach (var kv in J.Map(o, "materials", x => x.AsInt())) r.Materials[kv.Key] = kv.Value;
            foreach (var kv in J.Map(o, "items", x => x.AsInt())) r.Items[kv.Key] = kv.Value;
            return r;
        }
    }

    /// <summary>POST /v1/roster/bulk/preview (REQ-ORG-007): changes nothing.</summary>
    public sealed class BulkPreview
    {
        public string Action, ConfirmToken;
        public int Count, Eligible, Refused;
        public bool CanConfirm;
        public List<BulkHorseCheck> Horses = new List<BulkHorseCheck>();
        public BulkRefund Refund = new BulkRefund();
        internal static BulkPreview Parse(JsonNode o) => new BulkPreview
        {
            Action = J.Str(o, "action"), ConfirmToken = J.Str(o, "confirmToken"), Count = J.Int(o, "count"), Eligible = J.Int(o, "eligible"), Refused = J.Int(o, "refused"),
            CanConfirm = J.Bool(o, "canConfirm"), Horses = J.List(o, "horses", BulkHorseCheck.Parse), Refund = BulkRefund.Parse(J.Opt(o, "refund")),
        };
    }

    /// <summary>POST /v1/roster/bulk (REQ-ORG-008): every horse retired, each with its ceremony (§34).</summary>
    public sealed class BulkResult
    {
        public sealed class Done { public string HorseId, Name; public HallCeremony Ceremony; }
        public string Action;
        public int Count;
        public List<Done> Horses = new List<Done>();
        public BulkRefund Refund = new BulkRefund();
        internal static BulkResult Parse(JsonNode o) => new BulkResult
        {
            Action = J.Str(o, "action"), Count = J.Int(o, "count"), Refund = BulkRefund.Parse(J.Opt(o, "refund")),
            Horses = J.List(o, "horses", x => new Done { HorseId = J.Str(x, "horseId"), Name = J.Str(x, "name"), Ceremony = HallCeremony.Parse(J.Opt(x, "ceremony")) }),
        };
    }

    /// <summary>The course an aptitude sort is measured against (surface + distance, and the going when chosen).</summary>
    public sealed class RosterCourse
    {
        public string Surface, Going;
        public int DistanceM;
        /// <summary>Server tracks.json id when known (sent as trackId for a server-side query).</summary>
        public string TrackId;
    }

    /// <summary>
    /// REQ-ORG-002..004: a sort + filters + search. Kept per device (Encode → PlayerPrefs), never on the server. Unknown keys /
    /// values decode to the defaults. Null filters = no filter.
    /// </summary>
    public sealed class RosterQuery
    {
        public static readonly string[] SortKeys = { "rating", "aptitude", "age", "acquired", "races", "rarity", "name" };
        public static readonly string[] Bands = { "sprint", "mile", "intermediate", "long" };
        public static readonly string[] Styles = { "nige", "senko", "sashi", "oikomi" };
        public const int QueryMaxChars = 20;

        public string Sort = "acquired", Dir = "desc";
        public RosterCourse Course;
        public string Surface, Band, Style;
        public string Status = "all";
        public bool? Skill, Partner, Locked, Favorite;
        public bool FavoritesFirst = true;
        public string Q = "";

        public RosterQuery Clone() => (RosterQuery)MemberwiseClone();

        /// <summary>Filters in use (the roster_sort KPI's count; the search counts as one).</summary>
        public int FilterCount =>
            (Surface != null ? 1 : 0) + (Band != null ? 1 : 0) + (Style != null ? 1 : 0) + (Status != "all" ? 1 : 0) + (Skill.HasValue ? 1 : 0)
            + (Partner.HasValue ? 1 : 0) + (Locked.HasValue ? 1 : 0) + (Favorite.HasValue ? 1 : 0) + (string.IsNullOrEmpty(Q) ? 0 : 1);

        private static string B(bool? b) => b.HasValue ? (b.Value ? "1" : "0") : null;
        private static bool? ParseB(string v) => v == "1" ? true : v == "0" ? (bool?)false : null;

        /// <summary>The device-side form, e.g. <c>v1;sort=rating;dir=desc;surface=turf</c>. The course is kept by track id and distance.</summary>
        public string Encode()
        {
            var parts = new List<string> { "v1", "sort=" + Sort, "dir=" + Dir };
            void Add(string k, string v) { if (!string.IsNullOrEmpty(v)) parts.Add(k + "=" + Uri.EscapeDataString(v)); }
            if (Course != null) { Add("cs", Course.Surface); Add("cd", Course.DistanceM.ToString(CultureInfo.InvariantCulture)); Add("cg", Course.Going); Add("ct", Course.TrackId); }
            Add("surface", Surface); Add("band", Band); Add("style", Style); if (Status != "all") Add("status", Status);
            Add("skill", B(Skill)); Add("partner", B(Partner)); Add("locked", B(Locked)); Add("favorite", B(Favorite));
            if (!FavoritesFirst) Add("ff", "0");
            Add("q", Q);
            return string.Join(";", parts);
        }

        public static RosterQuery Decode(string s)
        {
            var q = new RosterQuery();
            if (string.IsNullOrEmpty(s)) return q;
            var parts = s.Split(';');
            if (parts.Length == 0 || parts[0] != "v1") return q;
            var kv = new Dictionary<string, string>();
            foreach (var p in parts.Skip(1)) { int i = p.IndexOf('='); if (i > 0) { try { kv[p.Substring(0, i)] = Uri.UnescapeDataString(p.Substring(i + 1)); } catch (Exception) { /* ignore a broken value */ } } }
            string Get(string k) => kv.TryGetValue(k, out var v) ? v : null;
            if (Array.IndexOf(SortKeys, Get("sort")) >= 0) q.Sort = Get("sort");
            if (Get("dir") == "asc" || Get("dir") == "desc") q.Dir = Get("dir");
            if ((Get("cs") == "turf" || Get("cs") == "dirt") && int.TryParse(Get("cd"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var d) && d > 0)
                q.Course = new RosterCourse { Surface = Get("cs"), DistanceM = d, Going = RosterSorter.GoingWetOrNull(Get("cg")) == null ? null : Get("cg"), TrackId = Get("ct") };
            if (q.Sort == "aptitude" && q.Course == null) q.Sort = "acquired";
            if (Get("surface") == "turf" || Get("surface") == "dirt") q.Surface = Get("surface");
            if (Array.IndexOf(Bands, Get("band")) >= 0) q.Band = Get("band");
            if (Array.IndexOf(Styles, Get("style")) >= 0) q.Style = Get("style");
            if (Get("status") == "active" || Get("status") == "retired") q.Status = Get("status");
            q.Skill = ParseB(Get("skill")); q.Partner = ParseB(Get("partner")); q.Locked = ParseB(Get("locked")); q.Favorite = ParseB(Get("favorite"));
            q.FavoritesFirst = Get("ff") != "0";
            var text = Get("q") ?? "";
            q.Q = text.Length > QueryMaxChars ? text.Substring(0, QueryMaxChars) : text;
            return q;
        }

        /// <summary>The query string for GET /v1/roster (the server sorts the same way). The course needs a track id there.</summary>
        public string ToQueryString()
        {
            var p = new List<string>();
            void Add(string k, string v) { if (!string.IsNullOrEmpty(v)) p.Add(k + "=" + Uri.EscapeDataString(v)); }
            if (Sort != "aptitude" || Course?.TrackId != null) { Add("sort", Sort); Add("dir", Dir); }
            if (Course?.TrackId != null) { Add("trackId", Course.TrackId); Add("going", Course.Going); }
            Add("surface", Surface); Add("band", Band); Add("style", Style); if (Status != "all") Add("status", Status);
            Add("skill", B(Skill)); Add("partner", B(Partner)); Add("locked", B(Locked)); Add("favorite", B(Favorite));
            if (!FavoritesFirst) Add("favoritesFirst", "0");
            Add("q", Q);
            return p.Count == 0 ? "" : "?" + string.Join("&", p);
        }

        /// <summary>The server's query shape (contracts/roster-query.vectors.json).</summary>
        public static RosterQuery FromJson(JsonNode o)
        {
            bool? NB(string k) { var v = J.Opt(o, k); return v == null ? (bool?)null : v.AsBool(); }
            var c = J.Opt(o, "course");
            return new RosterQuery
            {
                Sort = J.Str(o, "sort") ?? "acquired", Dir = J.Str(o, "dir") ?? "desc",
                Course = c == null ? null : new RosterCourse { Surface = J.Str(c, "surface"), DistanceM = J.Int(c, "distanceM"), Going = J.Str(c, "going") },
                Surface = J.Str(o, "surface"), Band = J.Str(o, "band"), Style = J.Str(o, "style"), Status = J.Str(o, "status") ?? "all",
                Skill = NB("skill"), Partner = NB("partner"), Locked = NB("locked"), Favorite = NB("favorite"), FavoritesFirst = J.Bool(o, "favoritesFirst", true), Q = J.Str(o, "q") ?? "",
            };
        }
    }

    /// <summary>Aptitude for a course (REQ-ORG-002): the engine's conditions as a score and a mark ◎ ○ △ ×.</summary>
    public struct RosterAptitude
    {
        public int Score, GoingFit;
        public bool SurfaceOk, DistanceOk;
        public string Mark;
    }

    /// <summary>REQ-ORG-002/003: the server's applyRosterQuery, on the device. Pure and deterministic (ties → acquired order).</summary>
    public static class RosterSorter
    {
        public static readonly IReadOnlyDictionary<string, int[]> BandRanges = new Dictionary<string, int[]>
        {
            ["sprint"] = new[] { 0, 1400 }, ["mile"] = new[] { 1401, 1800 }, ["intermediate"] = new[] { 1801, 2400 }, ["long"] = new[] { 2401, 99999 },
        };
        private static readonly Dictionary<string, int> RarityRank = new Dictionary<string, int> { ["R"] = 1, ["SR"] = 2, ["SSR"] = 3 };

        internal static int? GoingWetOrNull(string g)
        {
            switch (g)
            {
                case "firm": case "fast": return -2;
                case "good": return 0;
                case "yielding": case "muddy": return 1;
                case "soft": case "sloppy": return 2;
                default: return null;
            }
        }
        /// <summary>-2 firm/fast, 0 good (or no going), 1 yielding/muddy, 2 soft/sloppy.</summary>
        public static int GoingWet(string going) => GoingWetOrNull(going) ?? 0;

        public static RosterAptitude Aptitude(RosterRow h, RosterCourse c)
        {
            bool surfaceOk = h.Surface == "both" || h.Surface == c.Surface;
            int gap = c.DistanceM < h.DistMinM ? h.DistMinM - c.DistanceM : c.DistanceM > h.DistMaxM ? c.DistanceM - h.DistMaxM : 0;
            bool distanceOk = gap == 0;
            int wet = GoingWet(c.Going);
            int fit = h.GoingAptitude == "fast" ? -wet : h.GoingAptitude == "heavy" ? wet : 0;
            int score = (surfaceOk ? 200 : 0) + Math.Max(0, 200 - gap / 2) + 25 * fit;
            string mark = surfaceOk && distanceOk ? (fit >= 0 ? "◎" : "○") : surfaceOk || distanceOk ? "△" : "×";
            return new RosterAptitude { Score = score, GoingFit = fit, SurfaceOk = surfaceOk, DistanceOk = distanceOk, Mark = mark };
        }

        /// <summary>The one search fold (the server's searchFold): the same as the help center's HelpText.Fold.</summary>
        public static string FoldSearch(string s) => HelpText.Fold(s);

        private static int Value(RosterRow r, RosterQuery q)
        {
            switch (q.Sort)
            {
                case "rating": return r.Rating;
                case "aptitude": return q.Course != null ? Aptitude(r, q.Course).Score : 0;
                case "age": return r.AgeDays;
                case "races": return r.Races;
                case "rarity": return r.Rarity != null && RarityRank.TryGetValue(r.Rarity, out var k) ? k : 0;
                default: return r.AcquiredSeq;
            }
        }

        public static List<RosterRow> Apply(IEnumerable<RosterRow> rows, RosterQuery q)
        {
            string needle = string.IsNullOrEmpty(q.Q) ? "" : FoldSearch(q.Q);
            int[] band = q.Band != null && BandRanges.TryGetValue(q.Band, out var b) ? b : null;
            var list = rows.Where(r =>
            {
                if (q.Status != "all" && r.Status != q.Status) return false;
                if (q.Surface != null && r.Surface != "both" && r.Surface != q.Surface) return false;
                if (band != null && (r.DistMaxM < band[0] || r.DistMinM > band[1])) return false;
                if (q.Style != null && r.Style != q.Style) return false;
                if (q.Skill.HasValue && (r.SkillId != null) != q.Skill.Value) return false;
                if (q.Partner.HasValue && r.Partner != q.Partner.Value) return false;
                if (q.Locked.HasValue && r.Locked != q.Locked.Value) return false;
                if (q.Favorite.HasValue && r.Favorite != q.Favorite.Value) return false;
                if (needle.Length > 0 && !FoldSearch(r.Name).Contains(needle)) return false;
                return true;
            }).ToList();
            int sign = q.Dir == "asc" ? 1 : -1;
            list.Sort((x, y) =>
            {
                if (q.FavoritesFirst && x.Favorite != y.Favorite) return x.Favorite ? -1 : 1;
                int c = q.Sort == "name" ? Math.Sign(string.CompareOrdinal(x.Name ?? "", y.Name ?? "")) : Value(x, q).CompareTo(Value(y, q));
                if (c != 0) return sign * c;
                return x.AcquiredSeq.CompareTo(y.AcquiredSeq);
            });
            return list;
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-ORG-001: the organiser rows. With a query the server sorts / filters the same way <see cref="RosterSorter"/> does.</summary>
        public Task<RosterView> GetRosterAsync(RosterQuery query = null, CancellationToken ct = default)
            => Call("GET", "/v1/roster" + (query?.ToQueryString() ?? ""), null, true, null, true, RosterView.Parse, ct);

        /// <summary>REQ-ORG-005: lock / unlock (a value replacement, safe to retry). A locked horse is never retired.</summary>
        public Task<bool> SetHorseLockAsync(string horseId, bool locked, CancellationToken ct = default)
            => Call("PUT", "/v1/horses/" + Seg(horseId) + "/lock", JsonNode.Obj().Set("locked", locked), true, null, true, o => J.Bool(o, "locked"), ct);

        /// <summary>REQ-ORG-005: favourite on / off (a value replacement, safe to retry).</summary>
        public Task<bool> SetHorseFavoriteAsync(string horseId, bool favorite, CancellationToken ct = default)
            => Call("PUT", "/v1/horses/" + Seg(horseId) + "/favorite", JsonNode.Obj().Set("favorite", favorite), true, null, true, o => J.Bool(o, "favorite"), ct);

        private static JsonNode BulkBody(string action, IEnumerable<string> horseIds, string confirmToken)
        {
            var ids = JsonNode.Arr();
            foreach (var id in horseIds) ids.Add(JsonNode.Str(id));
            var b = JsonNode.Obj().Set("action", action).Set("horseIds", ids);
            if (confirmToken != null) b.Set("confirmToken", confirmToken);
            return b;
        }

        /// <summary>REQ-ORG-007: what a bulk action would do (every horse, its reasons, the refund). Changes nothing.</summary>
        public Task<BulkPreview> PreviewBulkAsync(string action, IEnumerable<string> horseIds, CancellationToken ct = default)
            => Call("POST", "/v1/roster/bulk/preview", BulkBody(action, horseIds, null), true, null, true, BulkPreview.Parse, ct);

        /// <summary>
        /// REQ-ORG-008: run the previewed bulk action (keyed: a retry with the same key returns the first result). All or nothing:
        /// <see cref="BulkRefusedException"/> (ROSTER_BULK_REFUSED, with each refused horse) or ConflictException ROSTER_BULK_STALE
        /// (preview again) change nothing.
        /// </summary>
        public Task<BulkResult> RunBulkAsync(BulkPreview preview, IEnumerable<string> horseIds, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/roster/bulk", BulkBody(preview.Action, horseIds, preview.ConfirmToken), true, idempotencyKey ?? NewIdempotencyKey(), true, BulkResult.Parse, ct);
    }
}
