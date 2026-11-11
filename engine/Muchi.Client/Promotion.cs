using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-PROMO-001..020: 昇級戦と降級の猶予 (server/src/domain/promotion.ts, contracts/protocol.md §68).
    // When the ranked season points reach the class's promotion line, a short promotion series decides the month's promotion
    // (the class still changes at the season close). The server decides everything from verified ranked results; the client
    // only shows the series (pips, 「昇級戦 2/3」), its outcome and the grace window. Nothing here is purchasable or granted.

    /// <summary>Pip values of <see cref="PromotionSeries.Pips"/>.</summary>
    public static class PromotionPip
    {
        public const string Top = "top", Miss = "miss", Open = "open", Skip = "skip";
    }

    /// <summary>Series status values.</summary>
    public static class PromotionStatus
    {
        public const string Active = "active", Passed = "passed", Failed = "failed", SeasonEnd = "season_end";
    }

    /// <summary>progression.promotion (GET /v1/promotion <c>rules</c>).</summary>
    public sealed class PromotionRules
    {
        public int Races, NeedTop, TopPlace, SetbackPoints, GraceRaces;
        internal static PromotionRules Parse(JsonNode o) => new PromotionRules
        {
            Races = J.Int(o, "races"), NeedTop = J.Int(o, "needTop"), TopPlace = J.Int(o, "topPlace"), SetbackPoints = J.Int(o, "setbackPoints"), GraceRaces = J.Int(o, "graceRaces"),
        };
    }

    public sealed class PromotionRaceResult
    {
        public string RaceId;
        public int Place;
        /// <summary>Placed at or above TopPlace and the CPU did not ride for the player.</summary>
        public bool Top;
        /// <summary>The CPU finished the race after a disconnect (always a miss).</summary>
        public bool Cpu;
        internal static PromotionRaceResult Parse(JsonNode o) => new PromotionRaceResult { RaceId = J.Str(o, "raceId"), Place = J.Int(o, "place"), Top = J.Bool(o, "top"), Cpu = J.Bool(o, "cpu") };
    }

    /// <summary>The running series, or the last one of this season and class.</summary>
    public sealed class PromotionSeries
    {
        public string Id, Status;
        public int Races, NeedTop, TopPlace, Tops, Misses;
        /// <summary>The race to run next (1..Races) while active; null once decided.</summary>
        public int? Next;
        public List<PromotionRaceResult> Results = new List<PromotionRaceResult>();
        /// <summary>top | miss | open | skip, Races long.</summary>
        public List<string> Pips = new List<string>();
        public long StartedAt;
        public long? EndedAt;
        /// <summary>Season points after a failed series' setback.</summary>
        public int? SetbackTo;
        /// <summary>The result sheet was seen (AckPromotionAsync).</summary>
        public bool Seen;
        public bool Active => Status == PromotionStatus.Active;
        public bool Passed => Status == PromotionStatus.Passed;
        public bool Failed => Status == PromotionStatus.Failed;
        /// <summary>Decided (passed / failed) and its sheet not seen yet.</summary>
        public bool OutcomePending => (Passed || Failed) && !Seen;
        internal static PromotionSeries Parse(JsonNode o) => o == null ? null : new PromotionSeries
        {
            Id = J.Str(o, "id"), Status = J.Str(o, "status"), Races = J.Int(o, "races"), NeedTop = J.Int(o, "needTop"), TopPlace = J.Int(o, "topPlace"),
            Tops = J.Int(o, "tops"), Misses = J.Int(o, "misses"), Next = J.IntN(o, "next"), Results = J.List(o, "results", PromotionRaceResult.Parse),
            Pips = new List<string>(J.Strs(o, "pips") ?? new string[0]), StartedAt = J.Long(o, "startedAt"), EndedAt = J.LongN(o, "endedAt"),
            SetbackTo = J.IntN(o, "setbackTo"), Seen = J.Bool(o, "seen"),
        };
    }

    public sealed class PromotionGrace
    {
        public string ClassId;
        public int RacesLeft;
        internal static PromotionGrace Parse(JsonNode o) => o == null ? null : new PromotionGrace { ClassId = J.Str(o, "classId"), RacesLeft = J.Int(o, "racesLeft") };
    }

    /// <summary>GET /v1/promotion.</summary>
    public sealed class PromotionView
    {
        /// <summary>false = the kill switch (no series, no shield; Series / Grace are null).</summary>
        public bool Enabled;
        public string SeasonId, ClassId, ToClassId;
        public int? Line;
        public int Points, Earned;
        public PromotionRules Rules;
        public PromotionSeries Series;
        public bool PassedThisSeason, ShieldUsedThisSeason;
        public PromotionGrace Grace;
        internal static PromotionView Parse(JsonNode o) => new PromotionView
        {
            Enabled = J.Bool(o, "enabled"), SeasonId = J.Str(o, "seasonId"), ClassId = J.Str(o, "classId"), ToClassId = J.Str(o, "toClassId"),
            Line = J.IntN(o, "line"), Points = J.Int(o, "points"), Earned = J.Int(o, "earned"), Rules = PromotionRules.Parse(J.Opt(o, "rules")),
            Series = PromotionSeries.Parse(J.Opt(o, "series")), PassedThisSeason = J.Bool(o, "passedThisSeason"),
            ShieldUsedThisSeason = J.Bool(o, "shieldUsedThisSeason"), Grace = PromotionGrace.Parse(J.Opt(o, "grace")),
        };
        public static PromotionView FromJson(string json) => Parse(JsonNode.Parse(json));
        /// <summary>A series is running (the home shows 「昇級戦 {next}/{races}」).</summary>
        public bool InSeries => Enabled && Series != null && Series.Active;
    }

    /// <summary>The words and marks the screens use (Japanese; the view shows Loc.T(text)).</summary>
    public static class PromotionPips
    {
        /// <summary>○ top, ● miss, ◌ open, – skip (the same marks as the prototype; none of them is a Japanese character).</summary>
        public static string Glyph(string pip)
        {
            switch (pip)
            {
                case PromotionPip.Top: return "○";
                case PromotionPip.Miss: return "●";
                case PromotionPip.Skip: return "–";
                default: return "◌";
            }
        }

        public static string Marks(PromotionSeries s)
        {
            if (s == null) return "";
            var b = new StringBuilder();
            foreach (var p in s.Pips) b.Append(Glyph(p));
            return b.ToString();
        }

        /// <summary>The home's ranked button label: 「昇級戦 2/3」 (null when no series runs).</summary>
        public static string HomeLabel(PromotionView v) => v != null && v.InSeries && v.Series.Next.HasValue ? "昇級戦 " + v.Series.Next.Value + "/" + v.Series.Races : null;

        /// <summary>The rule line: 「3戦で3着以内が2回で突破」.</summary>
        public static string RuleLine(PromotionSeries s) => s == null ? "" : s.Races + "戦で" + s.TopPlace + "着以内が" + s.NeedTop + "回で突破";

        /// <summary>「降級の猶予 残り7戦」 (null when no window is open).</summary>
        public static string GraceLabel(PromotionView v) => v != null && v.Enabled && v.Grace != null && v.Grace.RacesLeft > 0 ? "降級の猶予 残り" + v.Grace.RacesLeft + "戦" : null;

        /// <summary>Title of the outcome sheet (passed / failed), else null.</summary>
        public static string OutcomeTitle(PromotionView v)
        {
            if (v?.Series == null) return null;
            if (v.Series.Passed) return v.ToClassId + "級へ昇級確定";
            if (v.Series.Failed) return "昇級ならず";
            return null;
        }

        /// <summary>Body of the outcome sheet.</summary>
        public static string OutcomeBody(PromotionView v)
        {
            if (v?.Series == null) return null;
            if (v.Series.Passed) return "シーズンの締めで" + v.ToClassId + "級に上がります";
            if (v.Series.Failed && v.Series.SetbackTo.HasValue && v.Line.HasValue) return "ポイントは" + v.Series.SetbackTo.Value + "ptに戻りました。あと" + Math.Max(0, v.Line.Value - v.Series.SetbackTo.Value) + "ptでもう一度挑めます";
            return null;
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-PROMO-013: the series, the grace window and the rules (a read).</summary>
        public Task<PromotionView> GetPromotionAsync(CancellationToken ct = default)
            => Call("GET", "/v1/promotion", null, true, null, true, PromotionView.Parse, ct);

        /// <summary>REQ-PROMO-014: the outcome sheet of an ended series was seen (idempotent; safe to retry).</summary>
        public Task<bool> AckPromotionAsync(string seriesId, CancellationToken ct = default)
            => Call("POST", "/v1/promotion/ack", JsonNode.Obj().Set("seriesId", seriesId), true, null, true, o => J.Bool(o, "seen"), ct);
    }
}
