using System.Text.Json;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-CAL-001..020: /v1/calendar client methods, models and KPI rows (contracts/protocol.md §65).</summary>
    public class ApiClientCalendarTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public ApiClientCalendarTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        // produced by the real server (calendar.ts calendarView for a veteran player on 2026-11-11, rows trimmed to seven)
        internal const string View = "{\"from\":\"2026-11-11\",\"to\":\"2026-11-20\",\"today\":\"2026-11-11\",\"serverNow\":1794366000000,\"timeZone\":\"日本時間\",\"partial\":[],\"marks\":{\"count\":1,\"max\":30},\"entries\":[{\"id\":\"event:sprint_cup_2026_11\",\"kind\":\"event\",\"title\":\"イベントレース\",\"name\":\"青葉スプリント杯\",\"startAt\":1793458800000,\"endAt\":1796050800000,\"startJst\":\"11/01 00:00\",\"endJst\":\"12/01 00:00\",\"firstDay\":\"2026-11-01\",\"lastDay\":\"2026-11-30\",\"rule\":\"exact\",\"status\":\"open\",\"paid\":false,\"link\":{\"screen\":\"event\",\"id\":\"sprint_cup_2026_11\"},\"spectate\":false,\"groups\":null,\"markable\":true,\"marked\":true},{\"id\":\"pass:2026-11\",\"kind\":\"season_pass\",\"title\":\"シーズンパスを買える期間\",\"name\":\"2026年11月シーズン\",\"startAt\":1793458800000,\"endAt\":1796050800000,\"startJst\":\"11/01 00:00\",\"endJst\":\"12/01 00:00\",\"firstDay\":\"2026-11-01\",\"lastDay\":\"2026-11-30\",\"rule\":\"calendar_month\",\"status\":\"open\",\"paid\":true,\"link\":null,\"spectate\":false,\"groups\":null,\"markable\":true,\"marked\":false},{\"id\":\"banner:pickup_ginga\",\"kind\":\"banner\",\"title\":\"スカウト\",\"name\":\"ピックアップ：ギンガノカナタ\",\"startAt\":1793458800000,\"endAt\":1796050800000,\"startJst\":\"11/01 00:00\",\"endJst\":\"12/01 00:00\",\"firstDay\":\"2026-11-01\",\"lastDay\":\"2026-11-30\",\"rule\":\"exact\",\"status\":\"open\",\"paid\":true,\"link\":{\"screen\":\"gacha_rates\",\"id\":\"pickup_ginga\"},\"spectate\":false,\"groups\":null,\"markable\":true,\"marked\":false},{\"id\":\"treg:tour_a\",\"kind\":\"tournament_registration\",\"title\":\"大会の受付\",\"name\":\"秋のミニ大会\",\"startAt\":1794362400000,\"endAt\":1794538800000,\"startJst\":\"11/11 11:00\",\"endJst\":\"11/13 12:00\",\"firstDay\":\"2026-11-11\",\"lastDay\":\"2026-11-13\",\"rule\":\"exact\",\"status\":\"open\",\"paid\":false,\"link\":{\"screen\":\"tournament\",\"id\":\"tour_a\"},\"spectate\":false,\"groups\":null,\"markable\":true,\"marked\":false},{\"id\":\"cup:cup_aaaaaaaaaaaaaaaa\",\"kind\":\"cup\",\"title\":\"主催カップ\",\"name\":null,\"cupName\":\"ミドリの週末杯\",\"startAt\":1794369600000,\"endAt\":1794384000000,\"startJst\":\"11/11 13:00\",\"endJst\":\"11/11 17:00\",\"firstDay\":\"2026-11-11\",\"lastDay\":\"2026-11-11\",\"rule\":\"exact\",\"status\":\"upcoming\",\"paid\":false,\"link\":{\"screen\":\"cup\",\"id\":\"cup_aaaaaaaaaaaaaaaa\"},\"spectate\":false,\"groups\":null,\"markable\":true,\"marked\":false},{\"id\":\"tour:tour_a\",\"kind\":\"tournament\",\"title\":\"大会の開始\",\"name\":\"秋のミニ大会\",\"startAt\":1794625200000,\"endAt\":1794625200000,\"startJst\":\"11/14 12:00\",\"endJst\":\"11/14 12:00\",\"firstDay\":\"2026-11-14\",\"lastDay\":\"2026-11-14\",\"rule\":\"exact\",\"status\":\"upcoming\",\"paid\":false,\"link\":{\"screen\":\"tournament\",\"id\":\"tour_a\"},\"spectate\":true,\"groups\":null,\"markable\":true,\"marked\":false},{\"id\":\"wch:2026-11-16\",\"kind\":\"weekly_challenge\",\"title\":\"週替わりチャレンジ\",\"name\":\"直線の覇者章\",\"startAt\":1794754800000,\"endAt\":1795359600000,\"startJst\":\"11/16 00:00\",\"endJst\":\"11/23 00:00\",\"firstDay\":\"2026-11-16\",\"lastDay\":\"2026-11-22\",\"rule\":\"game_day\",\"status\":\"upcoming\",\"paid\":false,\"link\":{\"screen\":\"weekly_challenge\",\"id\":null},\"spectate\":false,\"groups\":null,\"markable\":true,\"marked\":false}]}";
        internal const string Marked = "{\"marked\":true,\"id\":\"treg:tour_a\",\"count\":2,\"max\":30}";

        [Fact]
        public async Task ViewParsesRowsDaysLinksAndPaidRows()
        {
            _http.Reply(200, View);
            var v = await _api.GetCalendarAsync("2026-11-11", "2026-11-20");
            Assert.Equal("/v1/calendar?from=2026-11-11&to=2026-11-20", _http.Requests[0].Path);
            Assert.Equal("2026-11-11", v.Today);
            Assert.Equal("日本時間", v.TimeZone);
            Assert.Equal(1, v.MarkCount);
            Assert.Equal(30, v.MarkMax);
            Assert.Empty(v.Partial);
            var ev = v.Entry("event:sprint_cup_2026_11");
            Assert.Equal(CalendarKinds.Event, ev.Kind);
            Assert.True(ev.Marked && ev.Markable);
            Assert.Equal("event", ev.LinkScreen);
            Assert.Equal("11/01 00:00", ev.StartJst);
            Assert.True(ev.OnDay("2026-11-15"));
            Assert.False(ev.OnDay("2026-12-01"));
            // paid rows: dates only; the pass leads nowhere, a banner to its rates page
            var pass = v.Entry("pass:2026-11");
            Assert.True(pass.Paid);
            Assert.Null(pass.LinkScreen);
            Assert.Equal(CalendarRules.CalendarMonth, pass.Rule);
            var banner = v.Entry("banner:pickup_ginga");
            Assert.True(banner.Paid);
            Assert.Equal("gacha_rates", banner.LinkScreen);
            Assert.Equal("pickup_ginga", banner.LinkId);
            // the player's cup name is shown as written; a tournament start is a time point that can be watched
            var cup = v.Entry("cup:cup_aaaaaaaaaaaaaaaa");
            Assert.Null(cup.Name);
            Assert.Equal("ミドリの週末杯", cup.DisplayName);
            var tour = v.Entry("tour:tour_a");
            Assert.True(tour.IsPoint && tour.Spectate);
            Assert.Equal(CalendarRules.GameDay, v.Entry("wch:2026-11-16").Rule);
            Assert.Equal(2, v.OnDay("2026-11-11").Count(e => e.Kind == CalendarKinds.TournamentRegistration || e.Kind == CalendarKinds.Cup));
            foreach (var e in v.Entries) Assert.Contains(e.Kind, CalendarKinds.All);
        }

        [Fact]
        public async Task MarksAreFlagsOnlyAndIdsAreCheckedFirst()
        {
            _http.Reply(200, Marked).Reply(200, "{\"marked\":false,\"id\":\"treg:tour_a\",\"count\":1,\"max\":30}");
            var on = await _api.MarkCalendarAsync("treg:tour_a", true);
            Assert.Equal("PUT", _http.Requests[0].Method);
            Assert.Equal("/v1/calendar/marks/treg%3Atour_a", _http.Requests[0].Path);
            Assert.True(on.Marked);
            Assert.Equal(2, on.Count);
            var off = await _api.MarkCalendarAsync("treg:tour_a", false);
            Assert.Equal("DELETE", _http.Requests[1].Method);
            Assert.False(off.Marked);
            await Assert.ThrowsAsync<ArgumentException>(() => _api.MarkCalendarAsync("bad id", true));
            await Assert.ThrowsAsync<ArgumentException>(() => _api.GetCalendarAsync("11/11"));
            Assert.Equal(2, _http.Requests.Count);
        }

        [Fact]
        public async Task CalendarEventsMatchTheServerSchema()
        {
            _http.Reply(200, "{\"accepted\":2}");
            await _api.SendAnalyticsAsync("ios", "1", new[] { AnalyticsEvent.CalendarView(5, "month", 12), AnalyticsEvent.CalendarEntryOpen(6, CalendarKinds.Banner) });
            var body = _http.Requests[0].Body;
            Assert.Contains("\"name\":\"calendar_view\"", body);
            Assert.Contains("\"entries\":12", body);
            Assert.Contains("\"kind\":\"banner\"", body);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.CalendarView(0, "year", 1));
            Assert.Throws<ArgumentOutOfRangeException>(() => AnalyticsEvent.CalendarView(0, "week", 201));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.CalendarEntryOpen(0, "shop"));
            string ts = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "kpi.ts"));
            foreach (var n in new[] { "calendar_view", "calendar_entry_open" }) Assert.Contains("z.literal('" + n + "')", ts);
            string cal = File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "server", "src", "domain", "calendar.ts"));
            foreach (var k in CalendarKinds.All) Assert.Contains("'" + k + "'", cal);
            Assert.Contains("maxRangeDays: " + ApiClient.CalendarMaxRangeDays + ",", cal);
        }
    }
}
