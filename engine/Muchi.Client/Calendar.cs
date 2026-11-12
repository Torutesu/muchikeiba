using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-CAL-001..020: イベントカレンダー（予定表） (server/src/domain/calendar.ts, contracts/protocol.md §65).
    // One read-only calendar the server builds from each feature's own data (events, exchange, weekly challenge, branch goal
    // and league, seasons, the season pass month, announced banners, tournaments, the player's cups, maintenance, the
    // comeback window). Display only: nothing here moves coins or items. Paid rows (pass, banners) carry dates only — no
    // price and no purchase link; a banner row opens the rates page. Times are JST (also in English: label them "JST").
    // A mark is a flag on the server; the server never pushes for it (device-local reminders arrive with §61).

    /// <summary>The kinds of calendar rows (`kind`).</summary>
    public static class CalendarKinds
    {
        public const string Event = "event", EventExchange = "event_exchange", WeeklyChallenge = "weekly_challenge", TeamGoal = "team_goal",
            LeagueSeason = "league_season", Season = "season", SeasonPass = "season_pass", Banner = "banner",
            TournamentRegistration = "tournament_registration", Tournament = "tournament", Cup = "cup", Maintenance = "maintenance", Comeback = "comeback";
        public static readonly string[] All = { Event, EventExchange, WeeklyChallenge, TeamGoal, LeagueSeason, Season, SeasonPass, Banner, TournamentRegistration, Tournament, Cup, Maintenance, Comeback };
    }

    /// <summary>How a row's days are counted: game days (the 04:00 rollover), calendar months (0:00) or exact times.</summary>
    public static class CalendarRules
    {
        public const string GameDay = "game_day", CalendarMonth = "calendar_month", Exact = "exact";
    }

    /// <summary>One calendar row. <see cref="FirstDay"/>..<see cref="LastDay"/> are the days ("YYYY-MM-DD") it shows on.</summary>
    public sealed class CalendarEntry
    {
        public string Id, Kind, Title, Name, CupName, StartJst, EndJst, FirstDay, LastDay, Rule, Status;
        public long StartAt, EndAt;
        public bool Paid, Spectate, Markable, Marked;
        /// <summary>Where the row leads (null = nowhere: the season pass row never opens a purchase screen).</summary>
        public string LinkScreen, LinkId;
        /// <summary>Maintenance rows: the groups the window closes ("all" = everything).</summary>
        public List<string> Groups = new List<string>();

        /// <summary>A time point (the tournament start): no end.</summary>
        public bool IsPoint => EndAt <= StartAt;
        /// <summary>The name to show: the player's cup name (never translated), else the source's name, else the kind's title.</summary>
        public string DisplayName => !string.IsNullOrEmpty(CupName) ? CupName : !string.IsNullOrEmpty(Name) ? Name : Title;
        /// <summary>Whether the row touches the day ("YYYY-MM-DD", ordinal compare).</summary>
        public bool OnDay(string day) => string.CompareOrdinal(FirstDay, day) <= 0 && string.CompareOrdinal(day, LastDay) <= 0;

        internal static CalendarEntry Parse(JsonNode o)
        {
            var link = J.Opt(o, "link");
            return new CalendarEntry
            {
                Id = J.Str(o, "id"), Kind = J.Str(o, "kind"), Title = J.Str(o, "title"), Name = J.Str(o, "name"), CupName = J.Str(o, "cupName"),
                StartAt = J.Long(o, "startAt"), EndAt = J.Long(o, "endAt"), StartJst = J.Str(o, "startJst"), EndJst = J.Str(o, "endJst"),
                FirstDay = J.Str(o, "firstDay"), LastDay = J.Str(o, "lastDay"), Rule = J.Str(o, "rule"), Status = J.Str(o, "status"),
                Paid = J.Bool(o, "paid"), Spectate = J.Bool(o, "spectate"), Markable = J.Bool(o, "markable"), Marked = J.Bool(o, "marked"),
                LinkScreen = J.Str(link, "screen"), LinkId = J.Str(link, "id"),
                Groups = J.Opt(o, "groups") == null ? new List<string>() : J.List(o, "groups", v => v.AsString()),
            };
        }
    }

    /// <summary>GET /v1/calendar: the range, today (game day), the time zone label and the rows.</summary>
    public sealed class CalendarView
    {
        public string From, To, Today, TimeZone;
        public long ServerNow;
        public List<string> Partial = new List<string>();
        public int MarkCount, MarkMax;
        public List<CalendarEntry> Entries = new List<CalendarEntry>();

        public CalendarEntry Entry(string id) => Entries.FirstOrDefault(e => e.Id == id);
        /// <summary>Rows that show on a day, in the server's order (start, then kind).</summary>
        public IEnumerable<CalendarEntry> OnDay(string day) => Entries.Where(e => e.OnDay(day));

        public static CalendarView Parse(JsonNode o)
        {
            var marks = J.Opt(o, "marks");
            return new CalendarView
            {
                From = J.Str(o, "from"), To = J.Str(o, "to"), Today = J.Str(o, "today"), TimeZone = J.Str(o, "timeZone"), ServerNow = J.Long(o, "serverNow"),
                Partial = J.List(o, "partial", v => v.AsString()), MarkCount = J.Int(marks, "count"), MarkMax = J.Int(marks, "max"),
                Entries = J.List(o, "entries", CalendarEntry.Parse),
            };
        }
    }

    /// <summary>PUT / DELETE /v1/calendar/marks/:entryId.</summary>
    public sealed class CalendarMarkResult
    {
        public bool Marked;
        public string Id;
        public int Count, Max;
        internal static CalendarMarkResult Parse(JsonNode o) => new CalendarMarkResult { Marked = J.Bool(o, "marked"), Id = J.Str(o, "id"), Count = J.Int(o, "count"), Max = J.Int(o, "max") };
    }

    public sealed partial class ApiClient
    {
        private static readonly Regex CalendarIdRe = new Regex("^[a-z]{3,8}:[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant);
        private static readonly Regex CalendarDayRe = new Regex("^\\d{4}-\\d{2}-\\d{2}$", RegexOptions.CultureInvariant);
        /// <summary>The longest range one GET /v1/calendar covers (days, both ends included).</summary>
        public const int CalendarMaxRangeDays = 35;
        /// <summary>A well-formed calendar row id (`event:sprint_cup`, `banner:winter_2026`, …).</summary>
        public static bool IsCalendarEntryId(string id) => id != null && CalendarIdRe.IsMatch(id);

        /// <summary>REQ-CAL-004: the calendar for game days <paramref name="from"/>..<paramref name="to"/> ("YYYY-MM-DD", both null = 35 days from today).</summary>
        public Task<CalendarView> GetCalendarAsync(string from = null, string to = null, CancellationToken ct = default)
        {
            if (from != null && !CalendarDayRe.IsMatch(from)) throw new ArgumentException("from: YYYY-MM-DD", nameof(from));
            if (to != null && !CalendarDayRe.IsMatch(to)) throw new ArgumentException("to: YYYY-MM-DD", nameof(to));
            var q = new List<string>();
            if (from != null) q.Add("from=" + from);
            if (to != null) q.Add("to=" + to);
            return Call("GET", "/v1/calendar" + (q.Count > 0 ? "?" + string.Join("&", q) : ""), null, true, null, true, CalendarView.Parse, ct);
        }

        /// <summary>REQ-CAL-010: mark (true) or unmark (false) a row. Idempotent both ways; the server sends no notification for it (the device plans one through §61 `calendar_mark`, R21 integration).</summary>
        public Task<CalendarMarkResult> MarkCalendarAsync(string entryId, bool on, CancellationToken ct = default)
        {
            if (!IsCalendarEntryId(entryId)) throw new ArgumentException("bad calendar entry id " + entryId, nameof(entryId));
            return Call(on ? "PUT" : "DELETE", "/v1/calendar/marks/" + Uri.EscapeDataString(entryId), null, true, null, true, CalendarMarkResult.Parse, ct);
        }
    }
}
