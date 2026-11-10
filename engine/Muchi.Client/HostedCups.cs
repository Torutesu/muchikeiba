using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Client
{
    // =====================================================================================================
    // プレイヤー主催カップ (REQ-CUP-001..018, contracts/protocol.md §42, server/src/domain/hostedCups.ts).
    //
    // A small unranked cup for friends or the branch: the host picks the rules (RoomConditions, as for a friend room), the
    // entry count, one race or three on points, and a window. Races run as friend rooms (mode "cup"): after StartCupRaceAsync
    // every entrant gets the seat from GetMatchStatusAsync, like any friend race. Nothing but the standings and a cosmetic
    // trophy comes of it. Cup names and player names are what players typed: never translated or romanized.
    // =====================================================================================================

    /// <summary>Join codes: 8 characters of a 31-letter alphabet (no 0/O/1/I/L), shown as XXXX-XXXX.</summary>
    public static class CupCode
    {
        public const string Alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
        public const int Length = 8;

        /// <summary>What the player typed → the 8 stored characters (upper case, hyphens and spaces dropped); null when it cannot be a code.</summary>
        public static string Normalize(string raw)
        {
            if (raw == null) return null;
            var sb = new StringBuilder();
            foreach (var ch0 in raw.Normalize(NormalizationForm.FormKC))
            {
                if (ch0 == '-' || char.IsWhiteSpace(ch0)) continue;
                var ch = char.ToUpperInvariant(ch0);
                if (Alphabet.IndexOf(ch) < 0) return null;
                sb.Append(ch);
            }
            return sb.Length == Length ? sb.ToString() : null;
        }

        /// <summary>K7PMQ2XD → K7PM-Q2XD (input already normalized or displayed).</summary>
        public static string Display(string code)
        {
            var n = Normalize(code);
            return n == null ? code : n.Substring(0, 4) + "-" + n.Substring(4);
        }
    }

    public static class CupFormats
    {
        public const string Single = "single";
        public const string BestOf3 = "best_of_3";
    }

    /// <summary>The rules of a cup (the same shape as the friend-room conditions).</summary>
    public sealed class CupConditions
    {
        public string TrackId, Going, Weather;
        public bool? Night;
        public int TemperatureC, WindKmh;
        internal static CupConditions Parse(JsonNode o) => o == null ? null : new CupConditions
        {
            TrackId = J.Str(o, "trackId"), Going = J.Str(o, "going"), Night = J.Opt(o, "night") == null ? (bool?)null : J.Bool(o, "night"),
            Weather = J.Str(o, "weather"), TemperatureC = J.Int(o, "temperatureC"), WindKmh = J.Int(o, "windKmh"),
        };
        public JsonNode ToJson() => JsonNode.Obj()
            .Set("trackId", TrackId == null ? JsonNode.Null() : JsonNode.Str(TrackId)).Set("going", Going == null ? JsonNode.Null() : JsonNode.Str(Going))
            .Set("night", Night.HasValue ? JsonNode.Bool(Night.Value) : JsonNode.Null()).Set("weather", Weather).Set("temperatureC", TemperatureC).Set("windKmh", WindKmh);
    }

    public sealed class CupEntrant
    {
        public string PlayerId, DisplayName, HorseName;
        public bool Withdrawn;
        internal static CupEntrant Parse(JsonNode o) => new CupEntrant { PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), HorseName = J.Str(o, "horseName"), Withdrawn = J.Bool(o, "withdrawn") };
    }

    public sealed class CupRace
    {
        public int Index;
        public string RaceId, Status;
        public long StartAtMs;
        /// <summary>Place per player id (null = no-show / left out / void).</summary>
        public Dictionary<string, int?> Places = new Dictionary<string, int?>();
        internal static CupRace Parse(JsonNode o)
        {
            var r = new CupRace { Index = J.Int(o, "index"), RaceId = J.Str(o, "raceId"), Status = J.Str(o, "status"), StartAtMs = J.Long(o, "startAtMs") };
            var p = J.Opt(o, "places");
            if (p != null) foreach (var kv in p.Props) r.Places[kv.Key] = kv.Value.IsNull ? (int?)null : kv.Value.AsInt();
            return r;
        }
    }

    public sealed class CupStanding
    {
        public string PlayerId, DisplayName, Trophy;
        public int Rank, Points;
        public List<int?> Places = new List<int?>();
        internal static CupStanding Parse(JsonNode o)
        {
            var s = new CupStanding { PlayerId = J.Str(o, "playerId"), DisplayName = J.Str(o, "displayName"), Trophy = J.Str(o, "trophy"), Rank = J.Int(o, "rank"), Points = J.Int(o, "points") };
            var p = J.Opt(o, "places");
            if (p != null) foreach (var it in p.Items) s.Places.Add(it.IsNull ? (int?)null : it.AsInt());
            return s;
        }
    }

    /// <summary>GET /v1/cups/:cupId (and the cup in create / join answers).</summary>
    public sealed class HostedCup
    {
        public string CupId, CupName, HostId, HostName, Role, Code, Format, Status, CancelReason, StartProblem;
        public int Capacity, RacesTotal, RacesDone, MinEntrants;
        public long OpensAt, ClosesAt;
        public long? FinishedAt;
        public bool Partial, CanStart;
        public CupConditions Conditions;
        public List<CupEntrant> Entrants = new List<CupEntrant>();
        public List<CupRace> Races = new List<CupRace>();
        public List<CupStanding> Standings = new List<CupStanding>();
        public bool IsHost => Role == "host";
        public bool Closed => Status == "finished" || Status == "cancelled";
        internal static HostedCup Parse(JsonNode o) => o == null ? null : new HostedCup
        {
            CupId = J.Str(o, "cupId"), CupName = J.Str(o, "cupName"), HostId = J.Str(o, "hostId"), HostName = J.Str(o, "hostName"), Role = J.Str(o, "role"),
            Code = J.Str(o, "code"), Format = J.Str(o, "format"), Status = J.Str(o, "status"), CancelReason = J.Str(o, "cancelReason"), StartProblem = J.Str(o, "startProblem"),
            Capacity = J.Int(o, "capacity"), RacesTotal = J.Int(o, "racesTotal"), RacesDone = J.Int(o, "racesDone"), MinEntrants = J.Int(o, "minEntrants", 2),
            OpensAt = J.Long(o, "opensAt"), ClosesAt = J.Long(o, "closesAt"), FinishedAt = J.LongN(o, "finishedAt"), Partial = J.Bool(o, "partial"), CanStart = J.Bool(o, "canStart"),
            Conditions = CupConditions.Parse(J.Opt(o, "conditions")), Entrants = J.List(o, "entrants", CupEntrant.Parse), Races = J.List(o, "races", CupRace.Parse),
            Standings = J.List(o, "standings", CupStanding.Parse),
        };
        public static HostedCup FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    /// <summary>POST /v1/cups/lookup: what a code shows before joining (only the host's name).</summary>
    public sealed class CupPreview
    {
        public string CupId, CupName, HostName, Format, Role;
        public int Capacity, Entrants;
        public long OpensAt, ClosesAt;
        public CupConditions Conditions;
        public bool Full => Entrants >= Capacity;
        internal static CupPreview Parse(JsonNode o) => new CupPreview
        {
            CupId = J.Str(o, "cupId"), CupName = J.Str(o, "cupName"), HostName = J.Str(o, "hostName"), Format = J.Str(o, "format"), Role = J.Str(o, "role"),
            Capacity = J.Int(o, "capacity"), Entrants = J.Int(o, "entrants"), OpensAt = J.Long(o, "opensAt"), ClosesAt = J.Long(o, "closesAt"), Conditions = CupConditions.Parse(J.Opt(o, "conditions")),
        };
    }

    public sealed class CupInvite
    {
        public string CupId, CupName, HostId, HostName;
        public long At, Until;
        internal static CupInvite Parse(JsonNode o) => new CupInvite { CupId = J.Str(o, "cupId"), CupName = J.Str(o, "cupName"), HostId = J.Str(o, "hostId"), HostName = J.Str(o, "hostName"), At = J.Long(o, "at"), Until = J.Long(o, "until") };
    }

    /// <summary>A closed cup in the player's history (the trophy shelf reads it).</summary>
    public sealed class CupResult
    {
        public string CupId, CupName, Format, Status, CancelReason, Trophy;
        public int? Rank, Points;
        public int Entrants;
        public long At;
        public bool Partial;
        internal static CupResult Parse(JsonNode o) => new CupResult
        {
            CupId = J.Str(o, "cupId"), CupName = J.Str(o, "cupName"), Format = J.Str(o, "format"), Status = J.Str(o, "status"), CancelReason = J.Str(o, "cancelReason"),
            Trophy = J.Str(o, "trophy"), Rank = J.IntN(o, "rank"), Points = J.IntN(o, "points"), Entrants = J.Int(o, "entrants"), At = J.Long(o, "at"), Partial = J.Bool(o, "partial"),
        };
    }

    public sealed class CupTrophies
    {
        public int Gold, Silver, Bronze;
        public int Total => Gold + Silver + Bronze;
        internal static CupTrophies Parse(JsonNode o) => new CupTrophies { Gold = J.Int(o, "gold"), Silver = J.Int(o, "silver"), Bronze = J.Int(o, "bronze") };
    }

    public sealed class CupLimits
    {
        public int MaxActivePerHost, MaxEntriesPerPlayer, MinCapacity = 4, MaxCapacity = 8, MinEntrants = 2, NameMaxChars = 20, MinWindowMinutes = 15, MaxWindowHours = 72, MaxLeadHours = 168;
        public List<int> PointsByPlace = new List<int>();
        internal static CupLimits Parse(JsonNode o)
        {
            if (o == null) return new CupLimits();
            var l = new CupLimits
            {
                MaxActivePerHost = J.Int(o, "maxActivePerHost"), MaxEntriesPerPlayer = J.Int(o, "maxEntriesPerPlayer"), MinCapacity = J.Int(o, "minCapacity", 4), MaxCapacity = J.Int(o, "maxCapacity", 8),
                MinEntrants = J.Int(o, "minEntrants", 2), NameMaxChars = J.Int(o, "nameMaxChars", 20), MinWindowMinutes = J.Int(o, "minWindowMinutes", 15), MaxWindowHours = J.Int(o, "maxWindowHours", 72), MaxLeadHours = J.Int(o, "maxLeadHours", 168),
            };
            var p = J.Opt(o, "pointsByPlace");
            if (p != null) foreach (var it in p.Items) l.PointsByPlace.Add(it.AsInt());
            return l;
        }
    }

    /// <summary>GET /v1/cups.</summary>
    public sealed class MyCups
    {
        public bool Enabled;
        public CupLimits Limits = new CupLimits();
        public List<HostedCup> Active = new List<HostedCup>();
        public List<CupInvite> Invites = new List<CupInvite>();
        public List<CupResult> History = new List<CupResult>();
        public CupTrophies Trophies = new CupTrophies();
        public string TeamId;
        public int Hosting { get { int n = 0; foreach (var c in Active) if (c.IsHost) n++; return n; } }
        public bool CanHost => Enabled && Hosting < Limits.MaxActivePerHost && Active.Count < Limits.MaxEntriesPerPlayer;
        internal static MyCups Parse(JsonNode o) => new MyCups
        {
            Enabled = J.Bool(o, "enabled"), Limits = CupLimits.Parse(J.Opt(o, "limits")), Active = J.List(o, "active", HostedCup.Parse),
            Invites = J.List(o, "invites", CupInvite.Parse), History = J.List(o, "history", CupResult.Parse),
            Trophies = J.Opt(o, "trophies") == null ? new CupTrophies() : CupTrophies.Parse(J.Opt(o, "trophies")), TeamId = J.Str(o, "teamId"),
        };
        public static MyCups FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    public sealed class CupCreateResult { public HostedCup Cup; public bool Created; internal static CupCreateResult Parse(JsonNode o) => new CupCreateResult { Cup = HostedCup.Parse(J.Opt(o, "cup")), Created = J.Bool(o, "created") }; }
    public sealed class CupJoinResult { public HostedCup Cup; public bool Joined; internal static CupJoinResult Parse(JsonNode o) => new CupJoinResult { Cup = HostedCup.Parse(J.Opt(o, "cup")), Joined = J.Bool(o, "joined") }; }
    public sealed class CupLeaveResult { public bool Left, Cancelled; public HostedCup Cup; internal static CupLeaveResult Parse(JsonNode o) => new CupLeaveResult { Left = J.Bool(o, "left"), Cancelled = J.Bool(o, "cancelled"), Cup = HostedCup.Parse(J.Opt(o, "cup")) }; }
    public sealed class CupInviteResult { public int Invited, Skipped; internal static CupInviteResult Parse(JsonNode o) => new CupInviteResult { Invited = J.Int(o, "invited"), Skipped = J.Int(o, "skipped") }; }
    public sealed class CupRaceStart { public string RaceId; public int RaceIndex; public long StartAtMs; internal static CupRaceStart Parse(JsonNode o) => new CupRaceStart { RaceId = J.Str(o, "raceId"), RaceIndex = J.Int(o, "raceIndex"), StartAtMs = J.Long(o, "startAtMs") }; }

    /// <summary>What POST /v1/cups takes.</summary>
    public sealed class CupCreateRequest
    {
        public string CupName, Format = CupFormats.Single, HorseId;
        public int Capacity = 4;
        public long OpensAt, ClosesAt;
        /// <summary>The rules; null with <see cref="UsePreset"/> = the player's saved friend-room conditions.</summary>
        public CupConditions Conditions;
        public bool UsePreset;
        public JsonNode ToJson()
        {
            var b = JsonNode.Obj().Set("cupName", CupName).Set("capacity", Capacity).Set("format", Format).Set("opensAt", OpensAt).Set("closesAt", ClosesAt).Set("horseId", HorseId);
            if (Conditions != null) b.Set("conditions", Conditions.ToJson());
            if (UsePreset) b.Set("usePreset", true);
            return b;
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-CUP-007: my cups (limits, active cups, invitations, history, trophies).</summary>
        public Task<MyCups> GetCupsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/cups", null, true, null, true, MyCups.Parse, ct);

        /// <summary>
        /// REQ-CUP-001: create a cup (keyed: reuse the key until an answer arrives — the same key always names the same cup).
        /// ValidationException INVALID_NAME / NG_NAME / BAD_REQUEST; ConflictException CUP_LIMIT, DELETION_PENDING.
        /// </summary>
        public Task<CupCreateResult> CreateCupAsync(CupCreateRequest req, string idempotencyKey = null, CancellationToken ct = default)
        {
            if (req == null) throw new ArgumentNullException(nameof(req));
            return Call("POST", "/v1/cups", req.ToJson(), true, idempotencyKey ?? NewIdempotencyKey(), true, CupCreateResult.Parse, ct);
        }

        public Task<HostedCup> GetCupAsync(string cupId, CancellationToken ct = default)
            => Call("GET", "/v1/cups/" + Seg(cupId), null, true, null, true, HostedCup.Parse, ct);

        /// <summary>REQ-CUP-003: what a code shows before joining. Counts an attempt (RateLimitedException past the hourly cap); NotFoundException CUP_CODE_INVALID.</summary>
        public Task<CupPreview> LookupCupCodeAsync(string code, CancellationToken ct = default)
            => Call("POST", "/v1/cups/lookup", JsonNode.Obj().Set("code", CupCode.Normalize(code) ?? code), true, null, false, CupPreview.Parse, ct);

        /// <summary>REQ-CUP-005: join with my own horse, by code or (invited) by cup id. ConflictException CUP_FULL / CUP_CLOSED / CUP_LIMIT.</summary>
        public Task<CupJoinResult> JoinCupAsync(string horseId, string code = null, string cupId = null, string idempotencyKey = null, CancellationToken ct = default)
        {
            if ((code == null) == (cupId == null)) throw new ArgumentException("pass a code or a cupId");
            var b = JsonNode.Obj().Set("horseId", horseId);
            if (code != null) b.Set("code", CupCode.Normalize(code) ?? code); else b.Set("cupId", cupId);
            return Call("POST", "/v1/cups/join", b, true, idempotencyKey ?? NewIdempotencyKey(), true, CupJoinResult.Parse, ct);
        }

        /// <summary>REQ-CUP-011: leave (the host leaving cancels the cup). Idempotent.</summary>
        public Task<CupLeaveResult> LeaveCupAsync(string cupId, string idempotencyKey = null, CancellationToken ct = default)
            => Call("POST", "/v1/cups/" + Seg(cupId) + "/leave", JsonNode.Obj(), true, idempotencyKey ?? NewIdempotencyKey(), true, CupLeaveResult.Parse, ct);

        /// <summary>REQ-CUP-004: host only, before the first race: friends and/or the whole branch.</summary>
        public Task<CupInviteResult> InviteToCupAsync(string cupId, IList<string> friendIds = null, bool team = false, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            if (friendIds != null && friendIds.Count > 0) { var a = JsonNode.Arr(); foreach (var f in friendIds) a.Add(JsonNode.Str(f)); b.Set("friendIds", a); }
            if (team) b.Set("team", true);
            if (b.Count == 0) throw new ArgumentException("nothing to invite");
            return Call("POST", "/v1/cups/" + Seg(cupId) + "/invite", b, true, null, false, CupInviteResult.Parse, ct);
        }

        /// <summary>REQ-CUP-008: host only — the next race; every entrant then finds the seat in GetMatchStatusAsync. ConflictException CUP_NOT_READY / ALREADY_IN_RACE.</summary>
        public Task<CupRaceStart> StartCupRaceAsync(string cupId, CancellationToken ct = default)
            => Call("POST", "/v1/cups/" + Seg(cupId) + "/start", JsonNode.Obj(), true, null, false, CupRaceStart.Parse, ct);
    }

    /// <summary>
    /// REQ-CUP-014: the cup result card, built on the existing <see cref="ShareCard"/> (same layout, watermark and share sheet).
    /// Like every share card it shows no player names: the place, the field, the format and the horse — not the cup name
    /// (another player's typed text) nor the other entrants.
    /// </summary>
    public static class CupResultCard
    {
        public const string Kind = "cup_result";

        public static ShareCard Build(HostedCup cup, string myPlayerId, string horseName, string courseName)
        {
            if (cup == null) throw new ArgumentNullException(nameof(cup));
            CupStanding mine = null;
            foreach (var s in cup.Standings) if (s.PlayerId == myPlayerId) mine = s;
            int field = cup.Entrants.Count;
            var c = new ShareCard
            {
                Place = mine?.Rank ?? 0, Runners = field, HorseName = horseName ?? "", CourseName = courseName ?? "", ModeLabel = ShareCard.ModeText(RaceMode.Cup),
                TimeText = "", Kind = Kind,
            };
            string fmt = cup.Format == CupFormats.BestOf3 ? "3レース" : "1レース";
            c.PlaceText = mine == null ? "参加" : mine.Rank + "位 / " + field + "人";
            if (mine != null && cup.Format == CupFormats.BestOf3) c.SkillLines.Add(mine.Points.ToString(CultureInfo.InvariantCulture) + "pt（" + fmt + "）");
            else c.SkillLines.Add(fmt);
            c.ShareText = c.HorseName + "　" + c.ModeLabel + "　" + c.PlaceText + "　" + ShareCard.Hashtag;
            return c;
        }
    }
}
