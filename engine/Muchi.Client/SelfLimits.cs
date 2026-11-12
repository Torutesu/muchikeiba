using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-LIMIT-001..022 使いすぎ・遊びすぎの防止 — the player's own monthly spending limit and the play-time reminder
    // (server/src/domain/selfLimits.ts, contracts/protocol.md §67).
    //  - The spending limit lives on the server (min(age cap, own limit) is judged by every purchase path; a refusal is
    //    SelfLimitExceededException with the numbers and the setting to open). Lowering applies at once; raising / removing waits
    //    CoolOffHours and can be cancelled. Nothing here moves coins.
    //  - The play-time reminder is off by default. The settings are synced through the server; the DEVICE counts the time
    //    (PlaytimeClock: foreground only, a new session after 30 min in the background, the day rolls over at 4:00 local time) and
    //    asks PlaytimeReminderPolicy.Decide at safe points (after a race result, on the home) — the same pure rule as the server's
    //    decidePlaytimeReminder (contracts/self-limits.vectors.json). The sheet is player-requested: it does not go through
    //    SessionPrompts (the exempt row of the §58.11 table) and is not a notification (§61).

    public sealed class SelfLimitPending
    {
        /// <summary>The amount it changes to; null = removing the limit.</summary>
        public int? LimitYen;
        public long RequestedAt, EffectiveAt;
        internal static SelfLimitPending Parse(JsonNode o) => o == null ? null : new SelfLimitPending
        {
            LimitYen = J.IntN(o, "limitYen"), RequestedAt = J.Long(o, "requestedAt"), EffectiveAt = J.Long(o, "effectiveAt"),
        };
    }

    /// <summary>GET /v1/self-limits <c>spending</c> (§67.6).</summary>
    public sealed class SpendingLimitView
    {
        /// <summary>The player's own limit in effect (null = none). AgeLimitYen null = no age cap (adult or age not registered).</summary>
        public int? LimitYen, AgeLimitYen, EffectiveLimitYen, RemainingYen;
        public string AgeBand, Month;
        /// <summary>self | age | none — which cap binds (equal → age).</summary>
        public string Binding = "none";
        public int MonthSpentYen, CoolOffHours = 72, CustomMinYen = 100, CustomMaxYen, CustomStepYen = 100;
        public SelfLimitPending Pending;
        public List<int> ChoicesYen = new List<int>();
        public string StatusText, PendingText;
        public List<string> RulesText = new List<string>();
        internal static SpendingLimitView Parse(JsonNode o)
        {
            var c = J.Opt(o, "custom");
            return new SpendingLimitView
            {
                LimitYen = J.IntN(o, "limitYen"), AgeLimitYen = J.IntN(o, "ageLimitYen"), EffectiveLimitYen = J.IntN(o, "effectiveLimitYen"), RemainingYen = J.IntN(o, "remainingYen"),
                AgeBand = J.Str(o, "ageBand"), Month = J.Str(o, "month"), Binding = J.Str(o, "binding") ?? "none", MonthSpentYen = J.Int(o, "monthSpentYen"),
                CoolOffHours = J.Int(o, "coolOffHours", 72), CustomMinYen = J.Int(c, "minYen", 100), CustomMaxYen = J.Int(c, "maxYen"), CustomStepYen = J.Int(c, "stepYen", 100),
                Pending = SelfLimitPending.Parse(J.Opt(o, "pending")), ChoicesYen = J.List(o, "choicesYen", v => v.AsInt()),
                StatusText = J.Str(o, "statusText"), PendingText = J.Str(o, "pendingText"), RulesText = J.List(o, "rulesText", v => v.AsString()),
            };
        }
        /// <summary>A custom amount the server will accept (a listed choice, or on the step within range and not above the age cap).</summary>
        public bool IsValidAmount(int yen)
        {
            if (AgeLimitYen.HasValue && yen > AgeLimitYen.Value) return false;
            if (ChoicesYen.Contains(yen)) return true;
            return yen >= CustomMinYen && yen <= CustomMaxYen && CustomStepYen > 0 && yen % CustomStepYen == 0;
        }
        /// <summary>Saving this would apply at once (a lower amount, or a first limit); otherwise it waits CoolOffHours.</summary>
        public bool AppliesNow(int? yen) => yen.HasValue && (!LimitYen.HasValue || yen.Value < LimitYen.Value);
    }

    public sealed class PlaytimeSettings
    {
        /// <summary>Null = not used. QuietAfterHour is the device's local hour (0..23).</summary>
        public int? SessionMin, DailyMin, QuietAfterHour;
        public bool Enabled => SessionMin.HasValue || DailyMin.HasValue || QuietAfterHour.HasValue;
        internal static PlaytimeSettings Parse(JsonNode o) => new PlaytimeSettings
        {
            SessionMin = J.IntN(o, "sessionMin"), DailyMin = J.IntN(o, "dailyMin"), QuietAfterHour = J.IntN(o, "quietAfterHour"),
        };
    }

    /// <summary>GET /v1/self-limits <c>playtime</c>.</summary>
    public sealed class PlaytimeView
    {
        public PlaytimeSettings Settings = new PlaytimeSettings();
        public List<int> SessionChoices = new List<int>(), DailyChoices = new List<int>(), QuietAfterChoices = new List<int>();
        public List<string> RulesText = new List<string>();
        internal static PlaytimeView Parse(JsonNode o)
        {
            var c = J.Opt(o, "choices");
            return new PlaytimeView
            {
                Settings = PlaytimeSettings.Parse(o), SessionChoices = J.List(c, "sessionMin", v => v.AsInt()), DailyChoices = J.List(c, "dailyMin", v => v.AsInt()),
                QuietAfterChoices = J.List(c, "quietAfterHour", v => v.AsInt()), RulesText = J.List(o, "rulesText", v => v.AsString()),
            };
        }
    }

    public sealed class SelfLimitHistoryRow
    {
        public long At;
        /// <summary>set | raise_requested | remove_requested | raise_applied | raise_cancelled | playtime.</summary>
        public string Kind;
        public int? FromYen, ToYen;
        internal static SelfLimitHistoryRow Parse(JsonNode o) => new SelfLimitHistoryRow { At = J.Long(o, "at"), Kind = J.Str(o, "kind"), FromYen = J.IntN(o, "fromYen"), ToYen = J.IntN(o, "toYen") };
    }

    /// <summary>GET /v1/self-limits (§67.6). Texts are server-built (English at the response boundary).</summary>
    public sealed class SelfLimitsView
    {
        public int Rev;
        public SpendingLimitView Spending = new SpendingLimitView();
        public PlaytimeView Playtime = new PlaytimeView();
        /// <summary>Newest first.</summary>
        public List<SelfLimitHistoryRow> History = new List<SelfLimitHistoryRow>();
        public static SelfLimitsView Parse(JsonNode o) => new SelfLimitsView
        {
            Rev = J.Int(o, "rev"), Spending = SpendingLimitView.Parse(J.Opt(o, "spending")), Playtime = PlaytimeView.Parse(J.Opt(o, "playtime")),
            History = J.List(o, "history", SelfLimitHistoryRow.Parse),
        };
    }

    /// <summary>PUT /v1/self-limits/spending and DELETE …/pending: <c>applied</c> = now | pending | unchanged | cancelled.</summary>
    public sealed class SpendingLimitResult
    {
        public string Applied;
        public SelfLimitsView View;
        internal static SpendingLimitResult Parse(JsonNode o) => new SpendingLimitResult { Applied = J.Str(o, "applied"), View = SelfLimitsView.Parse(J.Opt(o, "view")) };
    }

    public sealed class PlaytimeResult
    {
        public List<string> Changed = new List<string>();
        public SelfLimitsView View;
        internal static PlaytimeResult Parse(JsonNode o) => new PlaytimeResult { Changed = J.List(o, "changed", v => v.AsString()), View = SelfLimitsView.Parse(J.Opt(o, "view")) };
    }

    /// <summary>bootstrap / GET /v1/player <c>selfLimits</c>: what the device needs to time the reminder (null from an older server).</summary>
    public sealed class SelfLimitsDigest
    {
        public PlaytimeSettings Playtime = new PlaytimeSettings();
        public int? LimitYen, EffectiveLimitYen;
        public SelfLimitPending Pending;
        public static SelfLimitsDigest Parse(JsonNode o)
        {
            if (o == null) return null;
            var sp = J.Opt(o, "spending");
            return new SelfLimitsDigest
            {
                Playtime = PlaytimeSettings.Parse(J.Opt(o, "playtime")), LimitYen = J.IntN(sp, "limitYen"), EffectiveLimitYen = J.IntN(sp, "effectiveLimitYen"),
                Pending = SelfLimitPending.Parse(J.Opt(sp, "pending")),
            };
        }
    }

    // ------------------------------------------------------------------------------------------------ the reminder (§67.4)

    public static class PlaytimeReasons
    {
        public const string QuietAfter = "quiet_after", Daily = "daily", Session = "session";
        /// <summary>Sheet order.</summary>
        public static readonly string[] All = { QuietAfter, Daily, Session };
    }

    /// <summary>Where the app is when it asks. Only RaceResult and Home are safe points.</summary>
    public static class PlaytimePlaces
    {
        public const string RaceResult = "race_result", Home = "home", Race = "race", Matchmaking = "matchmaking", Purchase = "purchase", Tutorial = "tutorial", Other = "other";
        public static bool IsSafe(string place) => place == RaceResult || place == Home;
    }

    public sealed class PlaytimeMarks
    {
        /// <summary>The session minute mark last reminded (null = none this session; PlaytimeClock clears it on a new session).</summary>
        public int? SessionMark;
        /// <summary>The device day ("YYYY-MM-DD", local, 4:00 roll-over) the two flags belong to.</summary>
        public string DayKey;
        public bool DailyShown, QuietShown;
        public PlaytimeMarks Clone() => new PlaytimeMarks { SessionMark = SessionMark, DayKey = DayKey, DailyShown = DailyShown, QuietShown = QuietShown };
    }

    public sealed class PlaytimeSnapshot
    {
        public long Now;
        /// <summary>The device's UTC offset in minutes (JST = 540).</summary>
        public int LocalOffsetMin = 540;
        public string Locale = "ja";
        public PlaytimeSettings Settings = new PlaytimeSettings();
        public int SessionPlayedMin, DayPlayedMin;
        public PlaytimeMarks Marks = new PlaytimeMarks();
        public string Place = PlaytimePlaces.Other;
    }

    public sealed class PlaytimeButtons { public string Continue, Stop, Settings; }

    public sealed class PlaytimeDecision
    {
        public bool Show;
        /// <summary>Due reasons in sheet order (also when not shown: they wait for the next safe point).</summary>
        public List<string> Reasons = new List<string>();
        /// <summary>off | not_due | not_safe; null when shown.</summary>
        public string BlockedBy;
        public string Title, Note;
        public List<string> Lines = new List<string>();
        public PlaytimeButtons Buttons;
        /// <summary>Save these once the sheet was shown (equal to the input otherwise, with the day rolled over).</summary>
        public PlaytimeMarks Marks;
    }

    /// <summary>REQ-LIMIT-011: the same pure rule as the server's decidePlaytimeReminder (contracts/self-limits.vectors.json).</summary>
    public static class PlaytimeReminderPolicy
    {
        public const int SessionGapMin = 30;
        public const int DayStartHour = 4;

        /// <summary>The device day of <paramref name="now"/> (local, rolling over at 4:00) and the minutes since that roll-over.</summary>
        public static (string dayKey, int minuteOfDay) Day(long now, int offsetMin)
        {
            var t = DateTimeOffset.FromUnixTimeMilliseconds(now + offsetMin * 60_000L - DayStartHour * 3_600_000L).UtcDateTime;
            return (t.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), t.Hour * 60 + t.Minute);
        }

        private static string QuietEn(int h) => "It is past " + (h == 0 ? "midnight" : h < 12 ? h + " a.m." : h == 12 ? "noon" : (h - 12) + " p.m.");

        public static PlaytimeDecision Decide(PlaytimeSnapshot x)
        {
            var (dayKey, minuteOfDay) = Day(x.Now, x.LocalOffsetMin);
            bool sameDay = x.Marks.DayKey == dayKey;
            var marks = new PlaytimeMarks { SessionMark = x.Marks.SessionMark, DayKey = dayKey, DailyShown = sameDay && x.Marks.DailyShown, QuietShown = sameDay && x.Marks.QuietShown };
            var st = x.Settings;
            PlaytimeDecision None(string why, List<string> reasons = null) => new PlaytimeDecision { Show = false, BlockedBy = why, Reasons = reasons ?? new List<string>(), Marks = marks };
            if (!st.Enabled) return None("off");
            var due = new List<string>();
            if (st.QuietAfterHour.HasValue && !marks.QuietShown)
            {
                int from = ((st.QuietAfterHour.Value - DayStartHour + 24) % 24) * 60;
                if (minuteOfDay >= from) due.Add(PlaytimeReasons.QuietAfter);
            }
            if (st.DailyMin.HasValue && !marks.DailyShown && x.DayPlayedMin >= st.DailyMin.Value) due.Add(PlaytimeReasons.Daily);
            int? sessionMark = marks.SessionMark;
            if (st.SessionMin.HasValue && x.SessionPlayedMin >= (marks.SessionMark ?? 0) + st.SessionMin.Value)
            {
                due.Add(PlaytimeReasons.Session);
                sessionMark = x.SessionPlayedMin / st.SessionMin.Value * st.SessionMin.Value;
            }
            if (due.Count == 0) return None("not_due");
            if (!PlaytimePlaces.IsSafe(x.Place)) return None("not_safe", due);
            bool en = x.Locale == "en";
            var lines = due.Select(r => r == PlaytimeReasons.QuietAfter
                ? (en ? QuietEn(st.QuietAfterHour.Value) : st.QuietAfterHour.Value + "時を過ぎました")
                : r == PlaytimeReasons.Daily
                    ? (en ? "You have played " + x.DayPlayedMin + " minutes in total today" : "今日は合計" + x.DayPlayedMin + "分遊びました")
                    : (en ? "You have been playing for " + sessionMark.Value + " minutes" : "遊びはじめて" + sessionMark.Value + "分たちました")).ToList();
            return new PlaytimeDecision
            {
                Show = true, Reasons = due, BlockedBy = null, Lines = lines,
                Title = en ? "Time for a short break?" : "ひと息つきませんか",
                Note = en ? "This is the reminder you set for yourself. Carry on or stop here, as you like." : "ご自身で決めた目安のお知らせです。続けるか、ここで終えるかはご自由に",
                Buttons = en ? new PlaytimeButtons { Continue = "Continue", Stop = "Done for today", Settings = "Reminder settings" }
                             : new PlaytimeButtons { Continue = "続ける", Stop = "今日はここまで", Settings = "お知らせの設定" },
                Marks = new PlaytimeMarks { SessionMark = sessionMark, DayKey = dayKey, DailyShown = marks.DailyShown || due.Contains(PlaytimeReasons.Daily), QuietShown = marks.QuietShown || due.Contains(PlaytimeReasons.QuietAfter) },
            };
        }
    }

    /// <summary>
    /// REQ-LIMIT-010: counts foreground play time on the device. Session = from launch, and again after SessionGapMin minutes in the
    /// background; the day rolls over at 4:00 local time. Never sent to the server (only the rounded minutes in the KPI). Persist with
    /// <see cref="ToJson"/> / <see cref="FromJson"/> per account (an account change starts it afresh, like §58.11).
    /// </summary>
    public sealed class PlaytimeClock
    {
        public int LocalOffsetMin = 540;
        public string DayKey;
        public long SessionMs, DayMs;
        /// <summary>Set while in the foreground (the start of the current counting stretch).</summary>
        public long? ForegroundSince;
        public long? BackgroundSince;
        public PlaytimeMarks Marks = new PlaytimeMarks();

        /// <summary>App start or back to the foreground.</summary>
        public void Foreground(long now)
        {
            if (ForegroundSince.HasValue) return;
            if (DayKey == null || (BackgroundSince.HasValue && now - BackgroundSince.Value >= PlaytimeReminderPolicy.SessionGapMin * 60_000L)) NewSession();
            BackgroundSince = null;
            Roll(now);
            ForegroundSince = now;
        }

        /// <summary>The app went to the background (or is closing).</summary>
        public void Background(long now)
        {
            Tick(now);
            ForegroundSince = null;
            BackgroundSince = now;
        }

        /// <summary>Adds the time since the last tick (call before asking). Splits a stretch that crosses 4:00 between the two days.</summary>
        public void Tick(long now)
        {
            if (!ForegroundSince.HasValue) { Roll(now); return; }
            long from = ForegroundSince.Value;
            if (now <= from) return;
            var (k0, _) = PlaytimeReminderPolicy.Day(from, LocalOffsetMin);
            var (k1, _) = PlaytimeReminderPolicy.Day(now, LocalOffsetMin);
            SessionMs += now - from;
            if (k0 != k1)
            {
                // the new day started at 4:00 local time of k1: only the part after it counts for that day
                var d = DateTime.ParseExact(k1, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
                long boundary = new DateTimeOffset(d, TimeSpan.Zero).ToUnixTimeMilliseconds() - LocalOffsetMin * 60_000L + PlaytimeReminderPolicy.DayStartHour * 3_600_000L;
                DayKey = k1; DayMs = Math.Max(0, now - boundary);
            }
            else { if (DayKey != k0) { DayKey = k0; DayMs = 0; } DayMs += now - from; }
            ForegroundSince = now;
        }

        private void Roll(long now)
        {
            var (k, _) = PlaytimeReminderPolicy.Day(now, LocalOffsetMin);
            if (DayKey != k) { DayKey = k; DayMs = 0; }
        }

        private void NewSession() { SessionMs = 0; Marks.SessionMark = null; }

        public int SessionMinutes => (int)(SessionMs / 60_000L);
        public int DayMinutes => (int)(DayMs / 60_000L);

        /// <summary>Ticks, then asks the policy at <paramref name="place"/>. Call <see cref="Accept"/> with the decision once the sheet is shown.</summary>
        public PlaytimeDecision Ask(long now, PlaytimeSettings settings, string place, string locale)
        {
            Tick(now);
            return PlaytimeReminderPolicy.Decide(new PlaytimeSnapshot
            {
                Now = now, LocalOffsetMin = LocalOffsetMin, Locale = locale, Settings = settings ?? new PlaytimeSettings(),
                SessionPlayedMin = SessionMinutes, DayPlayedMin = DayMinutes, Marks = Marks.Clone(), Place = place,
            });
        }

        public void Accept(PlaytimeDecision d) { if (d != null && d.Marks != null) Marks = d.Marks.Clone(); }

        public JsonNode ToJson()
        {
            var o = JsonNode.Obj().Set("offset", LocalOffsetMin).Set("day", DayKey).Set("sessionMs", SessionMs).Set("dayMs", DayMs)
                .Set("dailyShown", Marks.DailyShown).Set("quietShown", Marks.QuietShown).Set("marksDay", Marks.DayKey);
            o.Set("sessionMark", Marks.SessionMark.HasValue ? JsonNode.Num(Marks.SessionMark.Value) : JsonNode.Null());
            o.Set("backgroundSince", BackgroundSince.HasValue ? JsonNode.Num(BackgroundSince.Value) : ForegroundSince.HasValue ? JsonNode.Num(ForegroundSince.Value) : JsonNode.Null());
            return o;
        }

        /// <summary>Restores a saved clock as if it had gone to the background when saved (a crash counts no extra time).</summary>
        public static PlaytimeClock FromJson(JsonNode o)
        {
            if (o == null) return new PlaytimeClock();
            return new PlaytimeClock
            {
                LocalOffsetMin = J.Int(o, "offset", 540), DayKey = J.Str(o, "day"), SessionMs = J.Long(o, "sessionMs"), DayMs = J.Long(o, "dayMs"),
                BackgroundSince = J.LongN(o, "backgroundSince"),
                Marks = new PlaytimeMarks { SessionMark = J.IntN(o, "sessionMark"), DayKey = J.Str(o, "marksDay"), DailyShown = J.Bool(o, "dailyShown"), QuietShown = J.Bool(o, "quietShown") },
            };
        }
    }

    /// <summary>REQ-LIMIT-005: 409 SELF_LIMIT_EXCEEDED — over the player's own monthly limit. Open the setting named by <see cref="Settings"/>.</summary>
    public sealed class SelfLimitExceededException : PurchaseBlockedException
    {
        public int SelfLimitYen { get; }
        public int MonthSpentYen { get; }
        public int PriceYen { get; }
        public string Month { get; }
        /// <summary>The screen to open: "self_limits".</summary>
        public string Settings { get; }
        public SelfLimitExceededException(string wire, string message, int status, JsonNode details) : base(ApiErrorCode.SelfLimitExceeded, wire, message, status)
        {
            SelfLimitYen = J.Int(details, "selfLimitYen"); MonthSpentYen = J.Int(details, "monthSpentYen"); PriceYen = J.Int(details, "priceYen");
            Month = J.Str(details, "month"); Settings = J.Str(details, "settings") ?? "self_limits";
        }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-LIMIT-013: GET /v1/self-limits (read-only).</summary>
        public Task<SelfLimitsView> GetSelfLimitsAsync(CancellationToken ct = default)
            => Call("GET", "/v1/self-limits", null, true, null, true, SelfLimitsView.Parse, ct);

        /// <summary>REQ-LIMIT-001/002: null = remove the limit. Lowering applies now; raising / removing waits the cool-off. Idempotent by content.</summary>
        public Task<SpendingLimitResult> SetSpendingLimitAsync(int? limitYen, CancellationToken ct = default)
            => Call("PUT", "/v1/self-limits/spending", JsonNode.Obj().Set("limitYen", limitYen.HasValue ? JsonNode.Num(limitYen.Value) : JsonNode.Null()), true, null, true, SpendingLimitResult.Parse, ct);

        /// <summary>REQ-LIMIT-002: cancels a waiting raise / removal (nothing waiting = unchanged).</summary>
        public Task<SpendingLimitResult> CancelSpendingRaiseAsync(CancellationToken ct = default)
            => Call("DELETE", "/v1/self-limits/spending/pending", null, true, null, true, SpendingLimitResult.Parse, ct);

        /// <summary>REQ-LIMIT-009: the reminder settings. Only the keys named in <paramref name="set"/> are sent (null value = not used).</summary>
        public Task<PlaytimeResult> SetPlaytimeAsync(PlaytimeSettings values, bool session = true, bool daily = true, bool quietAfter = true, CancellationToken ct = default)
        {
            JsonNode N(int? v) => v.HasValue ? JsonNode.Num(v.Value) : JsonNode.Null();
            var b = JsonNode.Obj();
            if (session) b.Set("sessionMin", N(values.SessionMin));
            if (daily) b.Set("dailyMin", N(values.DailyMin));
            if (quietAfter) b.Set("quietAfterHour", N(values.QuietAfterHour));
            return Call("PUT", "/v1/self-limits/playtime", b, true, null, true, PlaytimeResult.Parse, ct);
        }
    }

    public sealed partial class AnalyticsEvent
    {
        private static int Round5(int min) => Math.Max(0, Math.Min(1440, min)) / 5 * 5;
        /// <summary>REQ-LIMIT-016: the play-time sheet was shown and answered (continue | stop | settings). Minutes are rounded down to 5.</summary>
        public static AnalyticsEvent PlaytimeReminderShown(long atMs, IList<string> reasons, int sessionMin, int dayMin, string choice)
        {
            if (reasons == null || reasons.Count == 0 || reasons.Any(r => Array.IndexOf(PlaytimeReasons.All, r) < 0)) throw new ArgumentException("unknown play-time reason");
            if (choice != "continue" && choice != "stop" && choice != "settings") throw new ArgumentException("unknown choice " + choice);
            var ordered = PlaytimeReasons.All.Where(reasons.Contains);
            return new AnalyticsEvent("playtime_reminder_shown", atMs, JsonNode.Obj().Set("reasons", string.Join(",", ordered))
                .Set("sessionMin", Round5(sessionMin)).Set("dayMin", Round5(dayMin)).Set("choice", choice));
        }
    }
}
