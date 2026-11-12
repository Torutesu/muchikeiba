using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-LIMIT-001..022: 使いすぎ・遊びすぎの防止 — the shared reminder rule (contracts/self-limits.vectors.json), the clock, the views, the API and the refusal (protocol §67).</summary>
    public class SelfLimitsTests
    {
        private static JsonNode Get(JsonNode o, string k) { Assert.True(o.TryGet(k, out var x), k); return x; }
        private static int? IntN(JsonNode o, string k) => o.TryGet(k, out var x) && !x.IsNull ? x.AsInt() : (int?)null;
        private static JsonNode Vectors() => JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "self-limits.vectors.json")));

        private static PlaytimeSnapshot Snapshot(JsonNode s)
        {
            var st = Get(s, "settings"); var mk = Get(s, "marks");
            return new PlaytimeSnapshot
            {
                Now = Get(s, "now").AsLong(), LocalOffsetMin = Get(s, "localOffsetMin").AsInt(), Locale = Get(s, "locale").AsString(),
                Settings = new PlaytimeSettings { SessionMin = IntN(st, "sessionMin"), DailyMin = IntN(st, "dailyMin"), QuietAfterHour = IntN(st, "quietAfterHour") },
                SessionPlayedMin = Get(s, "sessionPlayedMin").AsInt(), DayPlayedMin = Get(s, "dayPlayedMin").AsInt(), Place = Get(s, "place").AsString(),
                Marks = new PlaytimeMarks { SessionMark = IntN(mk, "sessionMark"), DayKey = Get(mk, "dayKey").IsNull ? null : Get(mk, "dayKey").AsString(), DailyShown = Get(mk, "dailyShown").AsBool(), QuietShown = Get(mk, "quietShown").AsBool() },
            };
        }

        [Fact]
        public void DecideMatchesTheServerVectors()
        {
            int n = 0;
            foreach (var c in Get(Vectors(), "cases").Items)
            {
                string name = Get(c, "name").AsString();
                var got = PlaytimeReminderPolicy.Decide(Snapshot(Get(c, "snapshot")));
                var e = Get(c, "expect");
                Assert.True(Get(e, "show").AsBool() == got.Show, name + " show");
                Assert.Equal(Get(e, "reasons").Items.Select(x => x.AsString()).ToList(), got.Reasons);
                Assert.True((Get(e, "blockedBy").IsNull ? null : Get(e, "blockedBy").AsString()) == got.BlockedBy, name + " blockedBy " + got.BlockedBy);
                Assert.Equal(Get(e, "lines").Items.Select(x => x.AsString()).ToList(), got.Lines);
                Assert.Equal(Get(e, "title").IsNull ? null : Get(e, "title").AsString(), got.Title);
                Assert.Equal(Get(e, "note").IsNull ? null : Get(e, "note").AsString(), got.Note);
                var b = Get(e, "buttons");
                if (b.IsNull) Assert.Null(got.Buttons);
                else { Assert.Equal(Get(b, "continue").AsString(), got.Buttons.Continue); Assert.Equal(Get(b, "stop").AsString(), got.Buttons.Stop); Assert.Equal(Get(b, "settings").AsString(), got.Buttons.Settings); }
                var m = Get(e, "marks");
                Assert.True(IntN(m, "sessionMark") == got.Marks.SessionMark && Get(m, "dayKey").AsString() == got.Marks.DayKey
                    && Get(m, "dailyShown").AsBool() == got.Marks.DailyShown && Get(m, "quietShown").AsBool() == got.Marks.QuietShown, name + " marks");
                n++;
            }
            Assert.True(n >= 25);
        }

        private const long Jst = 9 * 3_600_000L;
        private static long At(int y, int mo, int d, int h, int mi = 0) => new DateTimeOffset(y, mo, d, h, mi, 0, TimeSpan.Zero).ToUnixTimeMilliseconds() - Jst;

        [Fact]
        public void ClockCountsForegroundOnlyAndStartsNewSessionsAndDays()
        {
            var c = new PlaytimeClock();
            long t = At(2026, 11, 10, 20);
            c.Foreground(t);
            c.Tick(t + 40 * 60_000L);
            Assert.Equal(40, c.SessionMinutes);
            Assert.Equal(40, c.DayMinutes);
            c.Background(t + 45 * 60_000L);
            // 10 min away: same session
            c.Foreground(t + 55 * 60_000L);
            c.Tick(t + 60 * 60_000L);
            Assert.Equal(50, c.SessionMinutes);
            var s = new PlaytimeSettings { SessionMin = 30 };
            var d = c.Ask(t + 61 * 60_000L, s, PlaytimePlaces.Race, "ja");
            Assert.False(d.Show);
            Assert.Equal("not_safe", d.BlockedBy);
            d = c.Ask(t + 62 * 60_000L, s, PlaytimePlaces.RaceResult, "ja");
            Assert.True(d.Show);
            Assert.Equal(new[] { "遊びはじめて30分たちました" }, d.Lines);
            c.Accept(d);
            Assert.False(c.Ask(t + 63 * 60_000L, s, PlaytimePlaces.Home, "ja").Show);
            // 30 min away: a new session (the mark resets), the day total stays
            c.Background(t + 63 * 60_000L);
            c.Foreground(t + 93 * 60_000L);
            Assert.Equal(0, c.SessionMinutes);
            Assert.Null(c.Marks.SessionMark);
            Assert.Equal(53, c.DayMinutes);
            // a stretch across 4:00 counts for the new day only from 4:00
            var n = new PlaytimeClock();
            n.Foreground(At(2026, 11, 11, 3, 30));
            n.Tick(At(2026, 11, 11, 4, 20));
            Assert.Equal(50, n.SessionMinutes);
            Assert.Equal(20, n.DayMinutes);
            Assert.Equal("2026-11-11", n.DayKey);
            // saved and restored: no extra time while closed; a long gap starts a new session
            var saved = n.ToJson().ToString();
            var r = PlaytimeClock.FromJson(JsonNode.Parse(saved));
            Assert.Equal(50, r.SessionMinutes);
            r.Foreground(At(2026, 11, 11, 9));
            Assert.Equal(0, r.SessionMinutes);
            Assert.Equal(20, r.DayMinutes);
        }

        private const string View = "{\"rev\":3,\"spending\":{\"limitYen\":3000,\"ageLimitYen\":5000,\"ageBand\":\"under16\",\"effectiveLimitYen\":3000,\"binding\":\"self\",\"month\":\"2026-11\",\"monthSpentYen\":2400,\"remainingYen\":600,"
            + "\"pending\":{\"limitYen\":null,\"requestedAt\":1,\"effectiveAt\":2},\"choicesYen\":[1000,3000,5000],\"custom\":{\"minYen\":100,\"maxYen\":5000,\"stepYen\":100},\"coolOffHours\":72,"
            + "\"statusText\":\"自分で決めた上限 ¥3,000（今月の残り ¥600）\",\"pendingText\":\"x\",\"rulesText\":[\"a\",\"b\"]},"
            + "\"playtime\":{\"sessionMin\":60,\"dailyMin\":null,\"quietAfterHour\":22,\"enabled\":true,\"choices\":{\"sessionMin\":[30,60],\"dailyMin\":[60],\"quietAfterHour\":[21,22]},\"rulesText\":[\"c\"]},"
            + "\"history\":[{\"at\":1,\"kind\":\"remove_requested\",\"fromYen\":3000,\"toYen\":null}]}";

        [Fact]
        public void ParsesTheViewAndChecksAmounts()
        {
            var v = SelfLimitsView.Parse(JsonNode.Parse(View));
            Assert.Equal(3, v.Rev);
            Assert.Equal(3000, v.Spending.LimitYen);
            Assert.Equal("self", v.Spending.Binding);
            Assert.Null(v.Spending.Pending.LimitYen);
            Assert.Equal(new List<int> { 1000, 3000, 5000 }, v.Spending.ChoicesYen);
            Assert.True(v.Spending.IsValidAmount(2500));
            Assert.False(v.Spending.IsValidAmount(2550));
            Assert.False(v.Spending.IsValidAmount(6000));
            Assert.True(v.Spending.AppliesNow(1000));
            Assert.False(v.Spending.AppliesNow(5000));
            Assert.False(v.Spending.AppliesNow(null));
            Assert.True(v.Playtime.Settings.Enabled);
            Assert.Equal(22, v.Playtime.Settings.QuietAfterHour);
            Assert.Equal("remove_requested", v.History[0].Kind);
            Assert.Null(SelfLimitsDigest.Parse(null));
            var dg = SelfLimitsDigest.Parse(JsonNode.Parse("{\"playtime\":{\"sessionMin\":null,\"dailyMin\":120,\"quietAfterHour\":null,\"enabled\":true},\"spending\":{\"limitYen\":null,\"effectiveLimitYen\":5000,\"pending\":null}}"));
            Assert.Equal(120, dg.Playtime.DailyMin);
            Assert.Equal(5000, dg.EffectiveLimitYen);
        }

        private static (ApiClient api, FakeHttp http) Api()
        {
            var http = new FakeHttp();
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            return (new ApiClient(http, new FakeAuth(), opt, new FakeDelay(), new SeqIds()), http);
        }

        [Fact]
        public async Task ApiCallsAndTheRefusal()
        {
            var (api, http) = Api();
            string res = "{\"applied\":\"pending\",\"view\":" + View + "}";
            http.Reply(200, View).Reply(200, res).Reply(200, res).Reply(200, "{\"applied\":\"cancelled\",\"view\":" + View + "}").Reply(200, "{\"changed\":[\"sessionMin\"],\"view\":" + View + "}");
            await api.GetSelfLimitsAsync();
            Assert.Equal("GET", http.Requests[0].Method);
            Assert.Equal("/v1/self-limits", http.Requests[0].Path);
            var r = await api.SetSpendingLimitAsync(10000);
            Assert.Equal("pending", r.Applied);
            Assert.Equal("PUT", http.Requests[1].Method);
            Assert.Equal("{\"limitYen\":10000}", http.Requests[1].Body);
            await api.SetSpendingLimitAsync(null);
            Assert.Equal("{\"limitYen\":null}", http.Requests[2].Body);
            Assert.Equal("cancelled", (await api.CancelSpendingRaiseAsync()).Applied);
            Assert.Equal("DELETE", http.Requests[3].Method);
            Assert.Equal("/v1/self-limits/spending/pending", http.Requests[3].Path);
            var p = await api.SetPlaytimeAsync(new PlaytimeSettings { SessionMin = 60 }, session: true, daily: false, quietAfter: false);
            Assert.Equal("{\"sessionMin\":60}", http.Requests[4].Body);
            Assert.Equal(new List<string> { "sessionMin" }, p.Changed);

            Assert.Contains("SELF_LIMIT_EXCEEDED", ApiErrorCodes.WireCodes);
            var ex = ApiErrorCodes.Create("SELF_LIMIT_EXCEEDED", "own monthly limit", 409, JsonNode.Parse("{\"selfLimitYen\":3000,\"monthSpentYen\":2400,\"priceYen\":800,\"month\":\"2026-11\",\"settings\":\"self_limits\"}"));
            var se = Assert.IsType<SelfLimitExceededException>(ex);
            Assert.IsAssignableFrom<PurchaseBlockedException>(ex);
            Assert.Equal(ApiErrorCode.SelfLimitExceeded, se.Code);
            Assert.Equal(3000, se.SelfLimitYen);
            Assert.Equal(800, se.PriceYen);
            Assert.Equal("self_limits", se.Settings);

            var intent = JsonNode.Parse("{\"product\":{\"id\":\"coin_480\"},\"monthSpentYen\":0,\"monthlyLimitYen\":null,\"remainingYen\":null,\"selfLimitYen\":3000,\"effectiveLimitYen\":3000,\"selfLimitBinding\":true,\"selfLimitPending\":{\"limitYen\":5000,\"requestedAt\":1,\"effectiveAt\":2}}");
            http.Reply(200, intent.ToString());
            var pi = await api.PurchaseIntentAsync("coin_480");
            Assert.Equal(3000, pi.SelfLimitYen);
            Assert.True(pi.SelfLimitBinding);
            Assert.Equal(5000, pi.SelfLimitPending.LimitYen);
            Assert.Contains(HelpContexts.SelfLimits, HelpContexts.All);
        }

        [Fact]
        public void AnalyticsEventRoundsAndOrders()
        {
            var e = AnalyticsEvent.PlaytimeReminderShown(5, new[] { "session", "quiet_after" }, 63, 128, "continue");
            Assert.Equal("playtime_reminder_shown", e.Name);
            Assert.Equal("{\"reasons\":\"quiet_after,session\",\"sessionMin\":60,\"dayMin\":125,\"choice\":\"continue\"}", e.PropsJson);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.PlaytimeReminderShown(5, new[] { "nap" }, 1, 1, "continue"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.PlaytimeReminderShown(5, new[] { "daily" }, 1, 1, "more"));
        }
    }
}
