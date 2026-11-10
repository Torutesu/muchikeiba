using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-RECAP-001..016: シーズンの振り返り (server/src/domain/seasonRecap.ts, contracts/protocol.md §43).
    // The server freezes one recap per ranked season (JST month) and per game year (rolls over at 04:00 JST) from confirmed data
    // only, and writes every line (Japanese, or English with ?lang=en / Accept-Language). The client steps through it and turns
    // the share cards into the existing ShareCard (REQ-UXS-071). Horse names are what players typed: never translated. A recap
    // never holds another player's name or id, and never a coin or purchase figure.

    /// <summary>A row of GET /v1/recaps.</summary>
    public sealed class RecapSummary
    {
        public string Id, Kind, PeriodId, Title;
        public bool Short, Opened, Completed;
        public long BuiltAt;
        public bool IsYear => Kind == "year";
        internal static RecapSummary Parse(JsonNode o) => new RecapSummary
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), PeriodId = J.Str(o, "periodId"), Title = J.Str(o, "title"), Short = J.Bool(o, "short"),
            Opened = J.Bool(o, "opened"), Completed = J.Bool(o, "completed"), BuiltAt = J.Long(o, "builtAt"),
        };
    }

    /// <summary>GET /v1/recaps: newest first; <see cref="Unseen"/> = the newest recap not opened yet (the profile badge).</summary>
    public sealed class RecapList
    {
        public bool Enabled;
        public List<RecapSummary> Recaps = new List<RecapSummary>();
        public string Unseen;
        internal static RecapList Parse(JsonNode o) => new RecapList { Enabled = J.Bool(o, "enabled"), Recaps = J.List(o, "recaps", RecapSummary.Parse), Unseen = J.Str(o, "unseen") };
        public static RecapList FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    /// <summary>One moment line (kind: promotion | hall | first_win | big_win | streak | ta_best).</summary>
    public sealed class RecapMoment
    {
        public string Kind, Text, HorseName;
        internal static RecapMoment Parse(JsonNode o) => new RecapMoment { Kind = J.Str(o, "kind"), Text = J.Str(o, "text"), HorseName = J.Str(o, "horseName") };
    }

    /// <summary>
    /// One page of the step-through. Key: races | wins | best_finish | rank | horse | time_attack | style | rival | team | hall |
    /// replays | moments | end. <see cref="Value"/> is the big text (a number, "1着", "B級", a time), null for name / list pages.
    /// </summary>
    public sealed class RecapStep
    {
        public string Key, Label, Value, Unit, HorseName;
        public List<string> Notes = new List<string>();
        public List<string> HorseNames = new List<string>();
        public List<RecapMoment> Moments = new List<RecapMoment>();
        internal static RecapStep Parse(JsonNode o)
        {
            var s = new RecapStep
            {
                Key = J.Str(o, "key"), Label = J.Str(o, "label"), Value = J.Str(o, "value"), Unit = J.Str(o, "unit"), HorseName = J.Str(o, "horseName"),
                Notes = new List<string>(J.Strs(o, "notes") ?? new string[0]), Moments = J.List(o, "moments", RecapMoment.Parse),
            };
            foreach (var h in J.List(o, "horses", x => J.Str(x, "horseName"))) s.HorseNames.Add(h);
            return s;
        }
    }

    /// <summary>A share card as the server wrote it (card: summary | horse | moment | rank). <see cref="Rank"/> cards go with 「順位を隠す」.</summary>
    public sealed class RecapShareCardData
    {
        public string Card, Title, Headline, Unit, HorseName;
        public List<string> Lines = new List<string>();
        public bool Rank;
        internal static RecapShareCardData Parse(JsonNode o) => new RecapShareCardData
        {
            Card = J.Str(o, "card"), Title = J.Str(o, "title"), Headline = J.Str(o, "headline"), Unit = J.Str(o, "unit"), HorseName = J.Str(o, "horseName"),
            Lines = new List<string>(J.Strs(o, "lines") ?? new string[0]), Rank = J.Bool(o, "rank"),
        };
    }

    /// <summary>GET /v1/recaps/:id.</summary>
    public sealed class RecapView
    {
        public string Id, Kind, PeriodId, Title;
        public bool Short;
        /// <summary>"2026-11-09からの記録です" when the record began mid-period (REQ-RECAP-006), else null.</summary>
        public string SinceNote;
        public List<RecapStep> Steps = new List<RecapStep>();
        public List<RecapShareCardData> ShareCards = new List<RecapShareCardData>();
        public long? OpenedAt, CompletedAt;
        internal static RecapView Parse(JsonNode o) => new RecapView
        {
            Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), PeriodId = J.Str(o, "periodId"), Title = J.Str(o, "title"), Short = J.Bool(o, "short"),
            SinceNote = J.Str(o, "sinceNote"), Steps = J.List(o, "steps", RecapStep.Parse), ShareCards = J.List(o, "shareCards", RecapShareCardData.Parse),
            OpenedAt = J.LongN(o, "openedAt"), CompletedAt = J.LongN(o, "completedAt"),
        };
        public static RecapView FromJson(string json) => Parse(JsonNode.Parse(json));
    }

    /// <summary>POST /v1/recaps/:id/progress: the first open / complete times (kept by the server).</summary>
    public sealed class RecapProgress
    {
        public long? OpenedAt, CompletedAt;
        internal static RecapProgress Parse(JsonNode o) => new RecapProgress { OpenedAt = J.LongN(o, "openedAt"), CompletedAt = J.LongN(o, "completedAt") };
    }

    /// <summary>
    /// REQ-RECAP-011: recap share cards through the existing <see cref="ShareCard"/> path (watermark 「ムチ一閃」, #ムチ一閃). Only the
    /// player's own horse names and numbers; <c>hideRank</c> drops every rank card. Kind = "recap_" + card (analytics recap_share).
    /// </summary>
    public static class RecapShare
    {
        public static List<ShareCard> Build(RecapView view, bool hideRank)
        {
            if (view == null) throw new ArgumentNullException(nameof(view));
            var list = new List<ShareCard>();
            foreach (var d in view.ShareCards)
            {
                if (hideRank && d.Rank) continue;
                list.Add(ToShareCard(d));
            }
            return list;
        }

        public static ShareCard ToShareCard(RecapShareCardData d)
        {
            var headline = string.IsNullOrEmpty(d.Headline) ? "" : d.Headline + UnitSuffix(d.Unit);
            var c = new ShareCard
            {
                Kind = "recap_" + d.Card, ModeLabel = d.Title, PlaceText = headline, HorseName = d.HorseName ?? "", CourseName = null, TimeMs = -1, TimeText = null,
            };
            c.Lines.AddRange(d.Lines);
            var parts = new List<string> { d.Title };
            if (headline.Length > 0) parts.Add(headline);
            if (!string.IsNullOrEmpty(d.HorseName)) parts.Add(d.HorseName);
            if (d.Lines.Count > 0) parts.Add(d.Lines[d.Lines.Count - 1]);
            parts.Add(ShareCard.Hashtag);
            c.ShareText = string.Join("　", parts);
            return c;
        }

        /// <summary>"24戦" in Japanese, "24 races" in English (a unit written in Latin letters gets a space).</summary>
        public static string UnitSuffix(string unit)
        {
            if (string.IsNullOrEmpty(unit)) return "";
            return unit[0] < 0x80 ? " " + unit : unit;
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-RECAP-010: my recaps, newest first (a period that just ended is closed by this request).</summary>
        public Task<RecapList> GetRecapsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/recaps", null, true, null, true, RecapList.Parse, ct);

        /// <summary>REQ-RECAP-010: one recap (NotFound for an unknown id).</summary>
        public Task<RecapView> GetRecapAsync(string recapId, CancellationToken ct = default)
            => Call("GET", "/v1/recaps/" + Seg(recapId), null, true, null, true, RecapView.Parse, ct);

        /// <summary>REQ-RECAP-010/015: step "open" or "complete". The server keeps the first time: safe to retry.</summary>
        public Task<RecapProgress> RecapProgressAsync(string recapId, string step, CancellationToken ct = default)
        {
            if (step != "open" && step != "complete") throw new ArgumentException("step must be open or complete", nameof(step));
            var b = JsonNode.Obj().Set("step", step);
            return Call("POST", "/v1/recaps/" + Seg(recapId) + "/progress", b, true, null, true, RecapProgress.Parse, ct);
        }
    }
}
