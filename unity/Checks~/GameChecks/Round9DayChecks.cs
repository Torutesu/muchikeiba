// Round 9: the game day rolls over at the server's progression.dayRollover hour (REQ-DAY-001..006, contracts/protocol.md
// §15). Same values as engine/Muchi.Engine.Tests/ApiClientDayRolloverTests.cs and server/test/day-rollover.test.ts:
// 0:00 JST until 2026-12-01 04:00 JST, 4:00 JST from then on (2026-12-01 is a 28 h game day).
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static partial class Round8Checks
{
    static long Jst(int y, int mo, int d, int h = 0, int mi = 0, int sec = 0, int ms = 0)
        => new DateTimeOffset(y, mo, d, h, mi, sec, TimeSpan.FromHours(9)).ToUnixTimeMilliseconds() + ms;

    const string ConfigWithRollover = "{\"versionId\":\"base\",\"hash\":\"base\",\"rulesetVersion\":\"1.3.0\",\"activatedAt\":null,\"visualsVersion\":1,"
        + "\"dayRollover\":{\"hourJst\":4,\"previousHourJst\":0,\"effectiveAtMs\":1796065200000}}";

    public static async Task DayRollover(Action<bool, string> check, RulesetParams rs)
    {
        Console.WriteLine("== round 9: game day rolls over at the server's hour (REQ-DAY-001..006)");
        var before = GameDay.Rule;
        try
        {
            var r = new DayRolloverInfo { HourJst = 4, PreviousHourJst = 0, EffectiveAtMs = 1796065200000L };
            check(r.EffectiveAtMs == Jst(2026, 12, 1, 4), "the shipped switch instant is 2026-12-01 04:00 JST");

            // 03:59 / 04:00 JST after the switch
            check(GameDay.Key(Jst(2026, 12, 5, 3, 59, 59, 999), r) == "2026-12-04" && GameDay.Key(Jst(2026, 12, 5, 4), r) == "2026-12-05"
                && GameDay.Key(Jst(2026, 12, 5, 0, 30), r) == "2026-12-04" && GameDay.Key(Jst(2026, 12, 5, 23, 59), r) == "2026-12-05",
                "after the switch: 03:59:59.999 JST is still the previous game day, 04:00 starts the next one");
            check(GameDay.Index(Jst(2026, 12, 5, 4), r) - GameDay.Index(Jst(2026, 12, 5, 3, 59, 59, 999), r) == 1, "the index moves by exactly one at 04:00");
            // before the switch: midnight
            check(GameDay.Key(Jst(2026, 11, 20, 23, 59, 59, 999), r) == "2026-11-20" && GameDay.Key(Jst(2026, 11, 21), r) == "2026-11-21",
                "before the switch the day still rolls over at 00:00 JST");

            // the switch day: 2026-12-01 runs from 12-01 00:00 to 12-02 04:00 (28 h, no double reset, no lost day)
            check(GameDay.Key(Jst(2026, 11, 30, 23, 30), r) == "2026-11-30" && GameDay.Key(Jst(2026, 12, 1, 0, 30), r) == "2026-12-01"
                && GameDay.Key(Jst(2026, 12, 1, 3, 59), r) == "2026-12-01" && GameDay.Key(Jst(2026, 12, 1, 4), r) == "2026-12-01"
                && GameDay.Key(Jst(2026, 12, 2, 0, 30), r) == "2026-12-01" && GameDay.Key(Jst(2026, 12, 2, 4), r) == "2026-12-02",
                "switch day: 12-01 00:30 and 12-02 00:30 are both game day 2026-12-01; no reset at 04:00 on 12-01 nor at midnight after it");
            check(GameDay.Index(Jst(2026, 12, 2, 4), r) - GameDay.Index(Jst(2026, 11, 30, 23, 30), r) == 2, "no game day is skipped across the switch");

            // when the counters reset next (the 「明日 4:00 に更新」 lines)
            check(GameDay.NextRolloverMs(Jst(2026, 11, 30, 12), r) == Jst(2026, 12, 1) && GameDay.NextRolloverMs(Jst(2026, 12, 1, 0, 30), r) == Jst(2026, 12, 2, 4)
                && GameDay.NextRolloverMs(Jst(2026, 12, 1, 5), r) == Jst(2026, 12, 2, 4) && GameDay.NextRolloverMs(Jst(2026, 12, 5, 2), r) == Jst(2026, 12, 5, 4),
                "next reset: 12-01 00:00 before the switch, 12-02 04:00 on the switch day, 04:00 the same morning after midnight");
            check(GameDay.NextResetLabel(Jst(2026, 11, 30, 12), r) == "明日 0:00" && GameDay.NextResetLabel(Jst(2026, 12, 1, 0, 30), r) == "明日 4:00"
                && GameDay.NextResetLabel(Jst(2026, 12, 5, 12), r) == "明日 4:00" && GameDay.NextResetLabel(Jst(2026, 12, 5, 2), r) == "今日 4:00",
                "reset labels: 「明日 0:00」 before the switch, 「明日 4:00」 after, 「今日 4:00」 between midnight and 04:00");

            // QA r9: a later rule moving the hour earlier (4 → 0, allowed at any instant) — the next reset is the server's
            // gameDayStartMs of the next day: the switch instant itself, never a midnight that is still under the old hour
            var early = new DayRolloverInfo { HourJst = 0, PreviousHourJst = 4, EffectiveAtMs = Jst(2027, 1, 10, 2) };
            check(GameDay.NextRolloverMs(Jst(2027, 1, 9, 12), early) == Jst(2027, 1, 10, 2) && GameDay.NextRolloverMs(Jst(2027, 1, 10, 1), early) == Jst(2027, 1, 10, 2)
                && GameDay.NextRolloverMs(Jst(2027, 1, 10, 3), early) == Jst(2027, 1, 11) && GameDay.NextRolloverMs(Jst(2027, 1, 8, 12), early) == Jst(2027, 1, 9, 4),
                "4 → 0 switched at 02:00: the next reset after 01-09 12:00 is the switch instant 01-10 02:00 (not 01-10 00:00)");
            var early4 = new DayRolloverInfo { HourJst = 0, PreviousHourJst = 4, EffectiveAtMs = Jst(2027, 1, 10, 4) };
            check(GameDay.NextRolloverMs(Jst(2027, 1, 9, 12), early4) == Jst(2027, 1, 10, 4), "4 → 0 switched at 04:00: next reset 01-10 04:00");

            // countdowns: the season (calendar month) ends 2027-01-01 00:00 JST
            long end = Jst(2027, 1, 1);
            check(GameDay.DaysUntil(end, Jst(2026, 12, 31, 12), r) == 1 && GameDay.DaysUntil(end, Jst(2026, 12, 31, 2), r) == 2
                && GameDay.DaysUntil(end, Jst(2026, 12, 24, 4), r) == 8 && GameDay.DaysUntil(end, end, r) == 0,
                "remainingDays: 1 on the last game day; 02:00 on the 31st is still game day 12-30 (2 left)");

            // the backend installs the server's rule from GET /v1/config; an older server (no field) means midnight
            GameDay.Use(null);
            check(GameDay.Key(Jst(2026, 12, 5, 0, 30)) == "2026-12-05", "without a rule from the server: midnight");
            var s = new FakeServer();
            s.Routes["GET /v1/config"] = _ => Ok(ConfigWithRollover);
            var (_, b, _) = Setup(new P { ConsentRequired = false }, rs, null, s);
            check(s.Count("GET", "/v1/config") == 1 && b.Config?.DayRollover?.HourJst == 4 && GameDay.Rule.HourJst == 4 && GameDay.Rule.EffectiveAtMs == 1796065200000L
                && GameDay.Key(Jst(2026, 12, 5, 0, 30)) == "2026-12-04", "bootstrap loads /v1/config and the device uses the server's 04:00 rule");
            var day = new FakeServer();
            day.Routes["GET /v1/config"] = _ => Ok("{\"versionId\":\"base\",\"hash\":\"base\",\"rulesetVersion\":\"1.3.0\",\"activatedAt\":null,\"visualsVersion\":1}");
            Setup(new P { ConsentRequired = false }, rs, null, day);
            check(GameDay.Rule.HourJst == 0 && GameDay.Rule.PreviousHourJst == 0, "an older server without dayRollover: back to midnight");
            GameDay.Use(r);
            var down = new FakeServer();
            down.Routes["GET /v1/config"] = _ => Err(503, "INTERNAL");
            var (_, b3, _) = Setup(new P { ConsentRequired = false }, rs, null, down);
            check(b3.Online && GameDay.Rule.HourJst == 4, "config unavailable: still online, the last rule stays");

            // the models read the rule: the allowance's second-claim message on game day 12-05 at 02:00 JST
            GameDay.Use(r);
            var player = new P { ConsentRequired = false, PartnerId = "h1", GachaUsed = true, Horses = "[" + Horse1 + "]", Unlocks = AllUnlocks };
            var (fs, fb, _) = Setup(player, rs);
            fs.Routes["GET /v1/shop/allowance"] = _ => Ok(AllowanceClaimed);
            long t = Jst(2026, 12, 5, 2);
            var a = new AllowanceModel(fb, () => t);
            await a.LoadAsync();
            check(!(await a.ClaimAsync()).Ok && a.Message.Contains("今日 4:00"), "already claimed at 02:00 JST: 「今日 4:00 に更新」 (" + a.Message + ")");
            t = Jst(2026, 12, 5, 3, 59, 59, 999);
            check(!a.Stale, "03:59:59.999 is still the same game day: no refetch");
            t = Jst(2026, 12, 5, 4);
            check(a.Stale, "at 04:00 JST the view is stale: refetch before claiming");
        }
        finally { GameDay.Use(before); }
    }
}
