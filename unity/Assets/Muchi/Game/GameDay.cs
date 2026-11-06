using System;
using System.Globalization;

namespace Muchi.Game
{
    /// <summary>
    /// Game-day arithmetic, the same as server/src/domain/time.ts (REQ-UXS-011): the day rolls over at
    /// <see cref="RolloverHourJst"/> JST (0 = midnight today; the spec proposes 4:00, a one-line change on both sides).
    /// The client only uses this to keep a countdown honest between two server fetches; the server's
    /// remainingDays / endsAt stay the source of truth. Only real period ends are counted down (season end,
    /// 厩舎手当 end date), never a made-up sale timer (06 §5.1, 03).
    /// </summary>
    public static class GameDay
    {
        public const int RolloverHourJst = 0;
        public const long DayMs = 24L * 3600 * 1000;
        private const long JstOffsetMs = 9L * 3600 * 1000;
        private const long HourMs = 3600L * 1000;

        /// <summary>Whole game days since the epoch (server gameDayIndex).</summary>
        public static long Index(long ms, int rolloverHour = RolloverHourJst)
            => FloorDiv(ms + JstOffsetMs - rolloverHour * HourMs, DayMs);

        /// <summary>The game day "YYYY-MM-DD" (server gameDayKey).</summary>
        public static string Key(long ms, int rolloverHour = RolloverHourJst)
            => DateTimeOffset.FromUnixTimeMilliseconds(ms + JstOffsetMs - rolloverHour * HourMs).UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        /// <summary>
        /// Game days left until <paramref name="endMs"/> (exclusive), counting today; 0 once it has passed
        /// (server gameDaysUntil: the day holding the last instant before the end is day 1).
        /// </summary>
        public static int DaysUntil(long endMs, long nowMs, int rolloverHour = RolloverHourJst)
        {
            if (endMs <= nowMs) return 0;
            return (int)(Index(endMs - 1, rolloverHour) - Index(nowMs, rolloverHour) + 1);
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

        private static long FloorDiv(long a, long b) => a >= 0 ? a / b : -((-a + b - 1) / b);
    }

    /// <summary>The clock the models read (Unix ms). Tests pass a fixed one; Unity passes the device clock.</summary>
    public delegate long NowMs();
}
