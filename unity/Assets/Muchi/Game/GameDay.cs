using System;
using System.Globalization;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>
    /// Game-day arithmetic, the same as server/src/domain/time.ts (REQ-UXS-011, REQ-DAY-001..006): the day rolls over at
    /// the hour of the server's <c>progression.dayRollover</c> rule (GET /v1/config → <see cref="ConfigInfo.DayRollover"/>,
    /// contracts/protocol.md §15) — <see cref="DayRolloverInfo.PreviousHourJst"/> before its
    /// <see cref="DayRolloverInfo.EffectiveAtMs"/>, <see cref="DayRolloverInfo.HourJst"/> from then on (shipped: 0:00 → 4:00 JST
    /// at 2026-12-01 04:00 JST). The hour is never a constant here: <see cref="GameBackend"/> installs the server's rule with
    /// <see cref="Use"/>; until then (or from an older server without the field) midnight is assumed.
    /// The client only uses this to keep a countdown honest between two server fetches; the server's
    /// remainingDays / endsAt stay the source of truth. Only real period ends are counted down (season end,
    /// 厩舎手当 end date), never a made-up sale timer (06 §5.1, 03).
    /// </summary>
    public static class GameDay
    {
        public const long DayMs = 24L * 3600 * 1000;
        private const long JstOffsetMs = 9L * 3600 * 1000;
        private const long HourMs = 3600L * 1000;

        /// <summary>Midnight JST with no switch: what an older server (no <c>dayRollover</c> in /v1/config) means.</summary>
        public static DayRolloverInfo Midnight => new DayRolloverInfo { HourJst = 0, PreviousHourJst = 0, EffectiveAtMs = 0 };
        private static DayRolloverInfo _rule = Midnight;

        /// <summary>The rule in use (the last one installed with <see cref="Use"/>).</summary>
        public static DayRolloverInfo Rule => _rule;

        /// <summary>Installs the server's rule (null = midnight, an older server).</summary>
        public static void Use(DayRolloverInfo rule) => _rule = rule ?? Midnight;

        /// <summary>The rollover hour (JST) that applies at <paramref name="ms"/>.</summary>
        public static int HourAt(long ms, DayRolloverInfo rule = null) => (rule ?? _rule).HourAt(ms);

        /// <summary>Whole game days since the epoch (server gameDayIndex).</summary>
        public static long Index(long ms, DayRolloverInfo rule = null) => (rule ?? _rule).Index(ms);

        /// <summary>The game day "YYYY-MM-DD" (server gameDayKey).</summary>
        public static string Key(long ms, DayRolloverInfo rule = null) => (rule ?? _rule).Key(ms);

        /// <summary>
        /// Game days left until <paramref name="endMs"/> (exclusive), counting today; 0 once it has passed
        /// (server gameDaysUntil: the day holding the last instant before the end is day 1).
        /// </summary>
        public static int DaysUntil(long endMs, long nowMs, DayRolloverInfo rule = null) => (rule ?? _rule).DaysUntil(endMs, nowMs);

        /// <summary>
        /// The first instant of the next game day (when the daily counters reset). On the switch day (0 → 4) that is the
        /// next calendar day's 04:00, so that game day is 28 h long.
        /// </summary>
        public static long NextRolloverMs(long nowMs, DayRolloverInfo rule = null)
        {
            var r = rule ?? _rule;
            // server gameDayStartMs of the next game day
            long next = r.Index(nowMs) + 1;
            long baseMs = next * DayMs - JstOffsetMs;
            long atOld = baseMs + r.PreviousHourJst * HourMs; // the start under the hour before the switch
            if (atOld < r.EffectiveAtMs) return atOld;
            // a later hour after the switch: that hour; an earlier one (4 → 0): the switch instant itself (QA r9)
            return Math.Max(baseMs + r.HourJst * HourMs, r.EffectiveAtMs);
        }

        /// <summary>"明日 4:00" — or "今日 4:00" between midnight and the rollover: when the daily counters reset next.</summary>
        public static string NextResetLabel(long nowMs, DayRolloverInfo rule = null)
        {
            var at = DateTimeOffset.FromUnixTimeMilliseconds(NextRolloverMs(nowMs, rule) + JstOffsetMs).UtcDateTime;
            var today = DateTimeOffset.FromUnixTimeMilliseconds(nowMs + JstOffsetMs).UtcDateTime.Date;
            return (at.Date == today ? "今日 " : "明日 ") + at.Hour.ToString(CultureInfo.InvariantCulture) + ":" + at.Minute.ToString("00", CultureInfo.InvariantCulture);
        }

        /// <summary>Game days from <paramref name="fromKey"/> to <paramref name="toKey"/> ("YYYY-MM-DD"), e.g. an allowance end date.</summary>
        public static int DaysBetweenKeys(string fromKey, string toKey)
        {
            if (!TryParseKey(fromKey, out var a) || !TryParseKey(toKey, out var b)) return 0;
            return (int)Math.Round((b - a).TotalDays);
        }

        public static bool TryParseKey(string key, out DateTime day)
            => DateTime.TryParseExact(key ?? "", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out day);

        /// <summary>
        /// "11月30日 23:59まで" for a period that ends at <paramref name="endMs"/> (exclusive; a season ends at the first
        /// instant of the next JST month, so the last minute shown is the previous day's 23:59).
        /// </summary>
        public static string UntilLabel(long endMs)
        {
            var last = DateTimeOffset.FromUnixTimeMilliseconds(endMs - 60_000 + JstOffsetMs).UtcDateTime;
            return last.Month.ToString(CultureInfo.InvariantCulture) + "月" + last.Day.ToString(CultureInfo.InvariantCulture) + "日 "
                + last.Hour.ToString("00", CultureInfo.InvariantCulture) + ":" + last.Minute.ToString("00", CultureInfo.InvariantCulture) + "まで";
        }

        /// <summary>"あと6日" / "今日まで" (last game day) / null once ended.</summary>
        public static string RemainingLabel(int remainingDays) => remainingDays <= 0 ? null : remainingDays == 1 ? "今日まで" : "あと" + remainingDays.ToString(CultureInfo.InvariantCulture) + "日";
    }

    /// <summary>The clock the models read (Unix ms). Tests pass a fixed one; Unity passes the device clock.</summary>
    public delegate long NowMs();
}
