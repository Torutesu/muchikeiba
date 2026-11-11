// イベントカレンダー（予定表） (REQ-CAL-001..020, contracts/protocol.md §65): CalendarModel over a fake API. Month and week
// lists over the server's days, rows per day in the server's order, the JST time line in both languages, paid rows (dates
// only: the pass opens nothing, a banner opens the rates page), marks that flip at once, are kept offline and sent on the
// next load, a refusal flips back, the mark limit, and the KPI rows (calendar_view per load / mode, calendar_entry_open).
using Muchi.Client;
using Muchi.Game;

static class CalendarChecks
{
    sealed class FakeApi : ICalendarApi
    {
        public readonly List<string> Calls = new List<string>();
        public bool Down;
        public string Refuse; // "gone" | "ended"
        public int Count = 1;

        public Task<CalendarView> GetCalendarAsync(string from = null, string to = null, CancellationToken ct = default)
        {
            Calls.Add("GET " + (from ?? "today"));
            if (Down) throw new NetworkException("offline", null);
            var v = new CalendarView { From = from ?? "2026-11-11", To = "2026-12-15", Today = "2026-11-11", TimeZone = "日本時間", MarkCount = Count, MarkMax = 3 };
            v.Entries.Add(new CalendarEntry { Id = "event:sprint_cup_2026_11", Kind = CalendarKinds.Event, Title = "イベントレース", Name = "青葉スプリント杯", StartAt = 1, EndAt = 2, StartJst = "11/01 00:00", EndJst = "12/01 00:00", FirstDay = "2026-11-01", LastDay = "2026-11-30", Rule = CalendarRules.Exact, Status = "open", LinkScreen = "event", LinkId = "sprint_cup_2026_11", Markable = true, Marked = true });
            v.Entries.Add(new CalendarEntry { Id = "pass:2026-11", Kind = CalendarKinds.SeasonPass, Title = "シーズンパスを買える期間", Name = "2026年11月シーズン", StartAt = 1, EndAt = 2, StartJst = "11/01 00:00", EndJst = "12/01 00:00", FirstDay = "2026-11-01", LastDay = "2026-11-30", Rule = CalendarRules.CalendarMonth, Status = "open", Paid = true, Markable = true });
            v.Entries.Add(new CalendarEntry { Id = "banner:pickup_ginga", Kind = CalendarKinds.Banner, Title = "スカウト", Name = "ピックアップ：ギンガノカナタ", StartAt = 1, EndAt = 2, StartJst = "11/01 00:00", EndJst = "12/01 00:00", FirstDay = "2026-11-01", LastDay = "2026-11-30", Rule = CalendarRules.Exact, Status = "open", Paid = true, LinkScreen = "gacha_rates", LinkId = "pickup_ginga", Markable = true });
            v.Entries.Add(new CalendarEntry { Id = "tour:tour_a", Kind = CalendarKinds.Tournament, Title = "大会の開始", Name = "秋のミニ大会", StartAt = 5, EndAt = 5, StartJst = "11/14 12:00", EndJst = "11/14 12:00", FirstDay = "2026-11-14", LastDay = "2026-11-14", Rule = CalendarRules.Exact, Status = "upcoming", Spectate = true, LinkScreen = "tournament", LinkId = "tour_a", Markable = true });
            v.Entries.Add(new CalendarEntry { Id = "cup:cup_aaaaaaaaaaaaaaaa", Kind = CalendarKinds.Cup, Title = "主催カップ", CupName = "ミドリの週末杯", StartAt = 3, EndAt = 4, StartJst = "11/20 13:00", EndJst = "11/20 17:00", FirstDay = "2026-11-20", LastDay = "2026-11-20", Rule = CalendarRules.Exact, Status = "upcoming", LinkScreen = "cup", LinkId = "cup_aaaaaaaaaaaaaaaa", Markable = true });
            v.Entries.Add(new CalendarEntry { Id = "treg:tour_old", Kind = CalendarKinds.TournamentRegistration, Title = "大会の受付", Name = "前の大会", StartAt = 0, EndAt = 1, StartJst = "11/11 05:00", EndJst = "11/11 06:00", FirstDay = "2026-11-11", LastDay = "2026-11-11", Rule = CalendarRules.Exact, Status = "ended", Markable = false });
            return Task.FromResult(v);
        }

        public Task<CalendarMarkResult> MarkCalendarAsync(string entryId, bool on, CancellationToken ct = default)
        {
            Calls.Add((on ? "PUT " : "DELETE ") + entryId);
            if (Down) throw new NetworkException("offline", null);
            if (Refuse == "gone") throw new NotFoundException(ApiErrorCode.NotFound, "NOT_FOUND", "no such calendar entry", 404);
            if (Refuse == "ended") throw new ConflictException(ApiErrorCode.Unknown, "CONFLICT", "the entry has ended", 409);
            Count += on ? 1 : -1;
            return Task.FromResult(new CalendarMarkResult { Marked = on, Id = entryId, Count = Count, Max = 3 });
        }
    }

    public static async Task Run(Action<bool, string> check, string root)
    {
        var api = new FakeApi();
        var kv = new MemoryKeyValueStore();
        var online = true;
        var rows = new List<AnalyticsEvent>();
        var m = new CalendarModel(api, kv, () => online, rows.Add, () => 1000);
        await m.LoadAsync();
        check(m.View != null && m.Mode == CalendarModel.ModeMonth && m.Days.Count == 35 && m.Days[0] == "2026-11-11", "loads 35 days from today as a month list");
        check(rows.Count == 1 && rows[0].Name == "calendar_view", "calendar_view once per load");
        m.SetMode(CalendarModel.ModeWeek);
        check(m.Days.Count == 7 && m.Days[6] == "2026-11-17" && rows.Count == 2, "the week list shows 7 days (calendar_view again)");
        check(m.ShiftWeek(1) && m.Days[0] == "2026-11-18" && m.ShiftWeek(-1) && !m.ShiftWeek(-1), "weeks move inside the loaded range only");
        m.SetMode(CalendarModel.ModeWeek);
        check(rows.Count == 2, "the same mode again sends nothing");
        var day = m.RowsOn("2026-11-14").Select(e => e.Id).ToList();
        check(day.SequenceEqual(new[] { "event:sprint_cup_2026_11", "pass:2026-11", "banner:pickup_ginga", "tour:tour_a" }), "rows on a day keep the server's order");
        check(!m.RowsOn("2026-12-10").Any(), "a day with nothing shows 「" + CalendarModel.EmptyDayText + "」");

        // JST in both languages; dates only, no countdown
        var ev = m.View.Entry("event:sprint_cup_2026_11");
        var tour = m.View.Entry("tour:tour_a");
        check(CalendarModel.TimeText(ev, false) == "11/01 00:00〜12/01 00:00（日本時間）" && CalendarModel.TimeText(ev, true) == "11/01 00:00–12/01 00:00 JST", "times are JST, labelled in Japanese and English");
        check(CalendarModel.TimeText(tour, true) == "11/14 12:00 JST" && CalendarModel.NoteText(tour) == CalendarModel.SpectateLabel, "a tournament start is one time and can be watched");
        // paid rows: dates only — the pass opens nothing, a banner opens its rates page
        var pass = m.View.Entry("pass:2026-11");
        check(m.Open(pass) == null && CalendarModel.NoteText(pass) == CalendarModel.PaidNote, "the season pass row opens nothing (no purchase screen)");
        var target = m.Open(m.View.Entry("banner:pickup_ginga"));
        check(target.HasValue && target.Value.screen == "gacha_rates" && target.Value.id == "pickup_ginga", "a banner row opens the rates page");
        check(rows.Count(r => r.Name == "calendar_entry_open") == 1, "calendar_entry_open only for rows that open something");
        check(m.View.Entry("cup:cup_aaaaaaaaaaaaaaaa").DisplayName == "ミドリの週末杯", "a cup shows the name its host typed");

        // marks: flip at once, sent; ended rows refused; the limit
        check(await m.ToggleMarkAsync("tour:tour_a") && m.View.Entry("tour:tour_a").Marked && api.Calls.Last() == "PUT tour:tour_a" && m.MarkCount == 2, "a mark flips at once and is sent");
        check(!await m.ToggleMarkAsync("treg:tour_old") && m.Message == CalendarModel.EndedText && !api.Calls.Contains("PUT treg:tour_old"), "an ended row is not marked");
        await m.ToggleMarkAsync("cup:cup_aaaaaaaaaaaaaaaa");
        check(m.MarkCount == 3 && !await m.ToggleMarkAsync("banner:pickup_ginga") && m.Message == CalendarModel.LimitText, "no more marks than the server allows");
        check(await m.ToggleMarkAsync("tour:tour_a") && !m.View.Entry("tour:tour_a").Marked && api.Calls.Last() == "DELETE tour:tour_a", "unmarking sends DELETE");

        // offline: kept on the device, sent on the next load; the row shows the change meanwhile
        online = false;
        check(await m.ToggleMarkAsync("tour:tour_a") && m.PendingMarks.Contains("tour:tour_a=1") && api.Calls.Last() == "DELETE tour:tour_a", "offline: the mark is kept on the device");
        online = true;
        var m2 = new CalendarModel(api, kv, () => online, rows.Add, () => 1000);
        await m2.LoadAsync();
        check(api.Calls.Contains("PUT tour:tour_a") && m2.PendingMarks.Count == 0, "the kept mark is sent on the next load");

        // a refusal flips back
        api.Refuse = "gone";
        await m2.ToggleMarkAsync("event:sprint_cup_2026_11");
        check(m2.View.Entry("event:sprint_cup_2026_11").Marked && m2.Message == CalendarModel.GoneText && m2.PendingMarks.Count == 0, "a row the server no longer has flips back");
        api.Refuse = null;

        // offline load and the paid wording
        api.Down = true;
        var m3 = new CalendarModel(api, new MemoryKeyValueStore(), () => true, rows.Add, () => 1000);
        await m3.LoadAsync();
        check(m3.Message == CalendarModel.OfflineText && m3.View == null, "offline: 「" + CalendarModel.OfflineText + "」");
        foreach (var t in new[] { CalendarModel.Title, CalendarModel.PaidNote, CalendarModel.MarkNote, CalendarModel.StatusOpen, CalendarModel.StatusUpcoming })
            check(!t.Contains("今だけ") && !t.Contains("残りわずか") && !t.Contains("お得") && !t.Contains("倍"), "no urgency words: " + t);

        // English: every model text has an entry in ui-en.json
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.SetLocale("en");
        try
        {
            var texts = new[] { CalendarModel.Title, CalendarModel.OfflineText, CalendarModel.MonthLabel, CalendarModel.WeekLabel, CalendarModel.TodayLabel, CalendarModel.EmptyDayText,
                CalendarModel.MarkLabel, CalendarModel.UnmarkLabel, CalendarModel.MarkNote, CalendarModel.PaidNote, CalendarModel.PartialText, CalendarModel.EndedText,
                CalendarModel.GoneText, CalendarModel.LimitText, CalendarModel.StatusOpen, CalendarModel.StatusUpcoming, CalendarModel.StatusEnded, CalendarModel.SpectateLabel };
            var missing = texts.Where(t => Loc.T(t) == t).ToList();
            check(missing.Count == 0, "every calendar text has English" + (missing.Count > 0 ? ": " + string.Join(", ", missing) : ""));
        }
        finally { Loc.SetLocale("ja"); }
    }
}
