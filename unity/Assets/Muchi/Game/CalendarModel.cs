using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-CAL-001..020 (contracts/protocol.md §65, docs/handoff-codex-round21-event-calendar.md): 予定表, the game layer.
    // Pure C#: Codex's screens bind to the public members. Read only — nothing here moves coins or items, and the server
    // never sends a notification for a mark (device reminders come with §61; see the handoff).

    /// <summary>The server calls the calendar needs (ApiClient in the app, a fake in the checks).</summary>
    public interface ICalendarApi
    {
        Task<CalendarView> GetCalendarAsync(string from = null, string to = null, CancellationToken ct = default);
        Task<CalendarMarkResult> MarkCalendarAsync(string entryId, bool on, CancellationToken ct = default);
    }

    /// <summary><see cref="ICalendarApi"/> over the real client.</summary>
    public sealed class ApiCalendar : ICalendarApi
    {
        private readonly ApiClient _api;
        public ApiCalendar(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<CalendarView> GetCalendarAsync(string from = null, string to = null, CancellationToken ct = default) => _api.GetCalendarAsync(from, to, ct);
        public Task<CalendarMarkResult> MarkCalendarAsync(string entryId, bool on, CancellationToken ct = default) => _api.MarkCalendarAsync(entryId, on, ct);
    }

    /// <summary>
    /// The 予定表 screen: a month list (the server's 35 game days) or a week list (7 of them), rows per day in the server's
    /// order, the JST time line, marks and where a row leads. Rules the model keeps:
    ///  - every row and date comes from the server (each feature's own data); the model never invents a deadline or a countdown;
    ///  - times are JST in both languages: <see cref="TimeText"/> appends 「（日本時間）」 / " JST";
    ///  - paid rows (season pass, banners) show dates and <see cref="PaidNote"/> only: no price, no purchase button. A banner
    ///    row opens the rates page; the pass row opens nothing (<see cref="Open"/> returns null);
    ///  - a mark flips at once and is sent (PUT / DELETE are idempotent). Offline it is kept on the device
    ///    (<see cref="KeyPendingMarks"/>) and sent on the next load; a refusal (row gone / ended / full) flips it back;
    ///  - KPI: calendar_view once per load or mode change, calendar_entry_open when a row is opened.
    /// </summary>
    public sealed class CalendarModel
    {
        public const string Title = "予定表";
        public const string OfflineText = "予定表はオンラインで見られます";
        public const string MonthLabel = "月ごと";
        public const string WeekLabel = "週ごと";
        public const string TodayLabel = "今日";
        public const string EmptyDayText = "予定はありません";
        public const string MarkLabel = "印を付ける";
        public const string UnmarkLabel = "印を外す";
        public const string MarkNote = "印を付けても、お知らせは届きません";
        public const string PaidNote = "期間だけを載せています";
        public const string PartialText = "一部の予定を読み込めませんでした";
        public const string EndedText = "終わった予定には印を付けられません";
        public const string GoneText = "この予定は表示できなくなりました";
        public const string LimitText = "印はこれ以上付けられません";
        public const string StatusOpen = "開催中";
        public const string StatusUpcoming = "これから";
        public const string StatusEnded = "終了";
        public const string SpectateLabel = "観戦できます";
        public const string JstSuffixJa = "（日本時間）";
        public const string JstSuffixEn = " JST";
        public const string ModeMonth = "month", ModeWeek = "week";
        public const string KeyPendingMarks = "muchi.calendar.marks.pending";
        public const int PendingMax = 60;

        private readonly ICalendarApi _api;
        private readonly IKeyValueStore _kv;
        private readonly Func<bool> _online;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;

        public CalendarModel(ICalendarApi api, IKeyValueStore store = null, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            _api = api;
            _kv = store ?? new MemoryKeyValueStore();
            _online = online ?? (() => true);
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        public CalendarView View { get; private set; }
        public string Mode { get; private set; } = ModeMonth;
        /// <summary>The first day of the week list (a day of the loaded range).</summary>
        public string WeekStart { get; private set; }
        public string Message { get; private set; }
        public bool Loading { get; private set; }

        /// <summary>The days the list shows: the whole range (month) or 7 days from <see cref="WeekStart"/> (week), inside the range.</summary>
        public IReadOnlyList<string> Days
        {
            get
            {
                if (View == null) return new List<string>();
                var all = DaysBetween(View.From, View.To);
                if (Mode == ModeMonth) return all;
                var i = Math.Max(0, all.IndexOf(WeekStart ?? View.From));
                return all.Skip(i).Take(7).ToList();
            }
        }
        public IEnumerable<CalendarEntry> RowsOn(string day) => View?.OnDay(day) ?? Enumerable.Empty<CalendarEntry>();
        /// <summary>Marks on the account (the server's count, moved here at once when a mark flips).</summary>
        public int MarkCount => View?.MarkCount ?? 0;
        public IReadOnlyList<string> PendingMarks => Pending().Select(p => p.Key + "=" + (p.Value ? "1" : "0")).ToList();

        /// <summary>Loads 35 days from <paramref name="from"/> (null = today) after sending marks made offline.</summary>
        public async Task LoadAsync(string from = null, CancellationToken ct = default)
        {
            Message = null;
            if (!_online() || _api == null) { Message = OfflineText; return; }
            Loading = true;
            try
            {
                await FlushMarksAsync(ct);
                var v = await _api.GetCalendarAsync(from, null, ct);
                // a mark changed here and not yet confirmed shows as changed
                var pending = Pending();
                foreach (var e in v.Entries) if (pending.TryGetValue(e.Id, out var on)) e.Marked = on;
                View = v;
                if (WeekStart == null || string.CompareOrdinal(WeekStart, v.From) < 0 || string.CompareOrdinal(WeekStart, v.To) > 0) WeekStart = v.From;
                if (v.Partial.Count > 0) Message = PartialText;
                TrackView();
            }
            catch (ApiException e) { Message = e is NetworkException ? OfflineText : UxText.For(e); }
            finally { Loading = false; }
        }

        /// <summary>Month or week (calendar_view once per change).</summary>
        public void SetMode(string mode)
        {
            if (mode != ModeMonth && mode != ModeWeek || mode == Mode) return;
            Mode = mode;
            TrackView();
        }

        /// <summary>Week list: the next / previous 7 days inside the loaded range (returns false at its ends).</summary>
        public bool ShiftWeek(int dir)
        {
            if (View == null) return false;
            var all = DaysBetween(View.From, View.To);
            var i = all.IndexOf(WeekStart ?? View.From) + 7 * Math.Sign(dir);
            if (i < 0 || i >= all.Count) return false;
            WeekStart = all[i];
            return true;
        }

        /// <summary>Where a row leads (screen, id), or null: the season pass row never opens anything (dates only).</summary>
        public (string screen, string id)? Open(CalendarEntry e)
        {
            if (e == null || e.LinkScreen == null) return null;
            _track?.Invoke(AnalyticsEvent.CalendarEntryOpen(_clock(), e.Kind));
            return (e.LinkScreen, e.LinkId);
        }

        /// <summary>The time line of a row: 「11/01 00:00〜12/01 00:00（日本時間）」 / "11/01 00:00–12/01 00:00 JST"; a time point shows one time.</summary>
        public static string TimeText(CalendarEntry e, bool english)
        {
            var t = e.IsPoint ? e.StartJst : e.StartJst + (english ? "–" : "〜") + e.EndJst;
            return t + (english ? JstSuffixEn : JstSuffixJa);
        }

        public static string StatusText(CalendarEntry e) => e.Status == "open" ? StatusOpen : e.Status == "ended" ? StatusEnded : StatusUpcoming;

        /// <summary>The second line under a row (paid rows: <see cref="PaidNote"/>; a watchable tournament: <see cref="SpectateLabel"/>).</summary>
        public static string NoteText(CalendarEntry e) => e.Paid ? PaidNote : e.Spectate ? SpectateLabel : null;

        /// <summary>Flips a row's mark now and sends it (offline: kept and sent later). Ended rows cannot be marked.</summary>
        public async Task<bool> ToggleMarkAsync(string entryId, CancellationToken ct = default)
        {
            var e = View?.Entry(entryId);
            if (e == null) return false;
            var on = !e.Marked;
            if (on && !e.Markable) { Message = EndedText; return false; }
            if (on && View.MarkMax > 0 && View.MarkCount >= View.MarkMax) { Message = LimitText; return false; }
            e.Marked = on;
            View.MarkCount = Math.Max(0, View.MarkCount + (on ? 1 : -1));
            Message = null;
            var p = Pending();
            p[entryId] = on;
            SavePending(p);
            if (!_online() || _api == null) return true;
            await FlushMarksAsync(ct);
            return true;
        }

        /// <summary>Sends the queued marks in order. A refusal flips the row back; a network failure keeps the rest for later.</summary>
        public async Task FlushMarksAsync(CancellationToken ct = default)
        {
            if (!_online() || _api == null) return;
            var p = Pending();
            foreach (var kv in p.ToList())
            {
                try
                {
                    var r = await _api.MarkCalendarAsync(kv.Key, kv.Value, ct);
                    if (View != null) View.MarkCount = r.Count;
                }
                catch (NetworkException) { return; }
                catch (ApiException ex) when (ex is NotFoundException || ex is ConflictException)
                {
                    var e = View?.Entry(kv.Key);
                    if (e != null) e.Marked = !kv.Value;
                    var full = View != null && View.MarkMax > 0 && View.MarkCount >= View.MarkMax;
                    if (View != null && kv.Value) View.MarkCount = Math.Max(0, View.MarkCount - 1);
                    Message = ex is NotFoundException ? GoneText : full ? LimitText : EndedText;
                }
                catch (ApiException) { return; }
                p.Remove(kv.Key);
                SavePending(p);
            }
        }

        private void TrackView()
        {
            if (View == null) return;
            var n = Mode == ModeMonth ? View.Entries.Count : Days.SelectMany(RowsOn).Distinct().Count();
            _track?.Invoke(AnalyticsEvent.CalendarView(_clock(), Mode, Math.Min(200, n)));
        }

        private Dictionary<string, bool> Pending()
        {
            var raw = _kv.Get(KeyPendingMarks);
            var d = new Dictionary<string, bool>();
            if (string.IsNullOrEmpty(raw)) return d;
            foreach (var part in raw.Split(','))
            {
                var i = part.LastIndexOf('=');
                if (i <= 0) continue;
                var id = part.Substring(0, i);
                if (ApiClient.IsCalendarEntryId(id)) d[id] = part.Substring(i + 1) == "1";
            }
            return d;
        }

        private void SavePending(Dictionary<string, bool> d) =>
            _kv.Set(KeyPendingMarks, string.Join(",", d.Skip(Math.Max(0, d.Count - PendingMax)).Select(x => x.Key + "=" + (x.Value ? "1" : "0"))));

        /// <summary>"YYYY-MM-DD" days from..to (both included).</summary>
        public static List<string> DaysBetween(string from, string to)
        {
            var list = new List<string>();
            if (!DateTime.TryParseExact(from, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var a)) return list;
            if (!DateTime.TryParseExact(to, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var b)) return list;
            for (var d = a; d <= b && list.Count < 62; d = d.AddDays(1)) list.Add(d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
            return list;
        }
    }
}
