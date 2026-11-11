using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-LNOTIF-001..020 端末のローカル通知 — on-device local notifications (server/src/domain/localNotify.ts, contracts/protocol.md §61).
    // The device schedules reminders for times it already knows (an open training session's deadline, the next game day's login bonus,
    // the end of the weekly challenge / rival week, an event exchange closing, a gift expiring), without a server round trip.
    // LocalNotificationPlanner.Plan is the same pure function as the server's planLocalNotifications (contracts/local-notifications.vectors.json):
    // the same categories and quiet hours as push, a daily cap per game day, real deadlines only, never a shop / purchase nudge, texts in
    // Japanese and English by the device language and player-typed names only with ShowDetails. The OS side is ILocalNotificationPlatform
    // (Codex wires the Unity Mobile Notifications package behind it, docs/handoff-codex-round20-local-notifications.md).

    /// <summary>The OS notification permission as the device reports it.</summary>
    public enum LocalNotificationPermission { Unknown, Granted, Provisional, Denied }

    /// <summary>bootstrap / GET /v1/player <c>localReminders</c> (§61.3): the deadlines the device plans from. Read-only on the server.</summary>
    public sealed class LocalRemindersDigest
    {
        public bool Enabled;
        public long Now, NextDayAt;
        /// <summary>The next game day ("YYYY-MM-DD", the server's day rule): the daily bonus reminder's id.</summary>
        public string NextDay;
        public List<string> Kinds = new List<string>();
        public int DailyCap = 2, DailyHourJst = 12, HorizonDays = 7, MaxPending = 8, TrainingLeadMin = 3;
        public Dictionary<string, int> LeadHours = new Dictionary<string, int>();
        public int PrePromptMaxAsks = 2, PrePromptRetryDays = 14;
        /// <summary>The push categories (season, friends, invites, events, comeback, gifts, reminders) as stored on the server.</summary>
        public Dictionary<string, bool> Categories = new Dictionary<string, bool>();
        /// <summary>JST quiet hours; null = none (the same as push).</summary>
        public int? QuietStartHour, QuietEndHour;
        public bool Deleting, Onboarding, LoginBonusUnlocked;
        public string TrainingSessionId, TrainingHorseId;
        public long? TrainingExpiresAt;
        public bool TrainedEver;
        /// <summary>Null when there is no weekly challenge this week.</summary>
        public WeeklyInfo WeeklyChallenge;
        /// <summary>Null when there is no rival this week.</summary>
        public RivalInfo Rival;
        public List<ExchangeInfo> Exchanges = new List<ExchangeInfo>();
        /// <summary>expiresAt of the unclaimed gifts that have one (earliest first, at most 20).</summary>
        public List<long> Gifts = new List<long>();

        public sealed class WeeklyInfo { public bool Unlocked; public long EndsAt; public int Uncleared; }
        public sealed class RivalInfo { public long WeekEndsAt; public int RankedRaces; }
        public sealed class ExchangeInfo { public string EventId; public int Points; public long ClosesAt; }

        public bool CategoryOn(string category) => category != null && Categories.TryGetValue(category, out var on) && on;

        /// <summary>Null from an older server (no field): the device plans nothing.</summary>
        public static LocalRemindersDigest Parse(JsonNode o)
        {
            if (o == null || o.Kind != JsonKind.Object) return null;
            var d = new LocalRemindersDigest { Enabled = J.Bool(o, "enabled") };
            if (!d.Enabled) return d;
            d.Now = J.Long(o, "now"); d.NextDayAt = J.Long(o, "nextDayAt"); d.NextDay = J.Str(o, "nextDay");
            var c = J.Opt(o, "config");
            d.Kinds = J.Strs(c, "kinds").ToList();
            d.DailyCap = J.Int(c, "dailyCap", 2); d.DailyHourJst = J.Int(c, "dailyHourJst", 12); d.HorizonDays = J.Int(c, "horizonDays", 7);
            d.MaxPending = J.Int(c, "maxPending", 8); d.TrainingLeadMin = J.Int(c, "trainingLeadMin", 3);
            d.LeadHours = J.Map(c, "leadHours", x => x.AsInt());
            var pp = J.Opt(c, "prePrompt");
            d.PrePromptMaxAsks = J.Int(pp, "maxAsks", 2); d.PrePromptRetryDays = J.Int(pp, "retryDays", 14);
            d.Categories = J.Map(o, "categories", x => x.AsBool());
            var q = J.Opt(o, "quietHours");
            if (q != null) { d.QuietStartHour = J.Int(q, "startHour"); d.QuietEndHour = J.Int(q, "endHour"); }
            d.Deleting = J.Bool(o, "deleting"); d.Onboarding = J.Bool(o, "onboarding");
            d.LoginBonusUnlocked = J.Bool(J.Opt(o, "loginBonus"), "unlocked");
            var t = J.Opt(o, "training");
            d.TrainingSessionId = J.Str(t, "sessionId"); d.TrainingHorseId = J.Str(t, "horseId"); d.TrainingExpiresAt = J.LongN(t, "expiresAt"); d.TrainedEver = J.Bool(t, "trainedEver");
            var w = J.Opt(o, "weeklyChallenge");
            if (w != null) d.WeeklyChallenge = new WeeklyInfo { Unlocked = J.Bool(w, "unlocked"), EndsAt = J.Long(w, "endsAt"), Uncleared = J.Int(w, "uncleared") };
            var r = J.Opt(o, "rival");
            if (r != null) d.Rival = new RivalInfo { WeekEndsAt = J.Long(r, "weekEndsAt"), RankedRaces = J.Int(r, "rankedRaces") };
            d.Exchanges = J.List(o, "exchanges", x => new ExchangeInfo { EventId = J.Str(x, "eventId"), Points = J.Int(x, "points"), ClosesAt = J.Long(x, "closesAt") });
            d.Gifts = J.List(o, "gifts", x => x.AsLong());
            return d;
        }
    }

    /// <summary>What the planner reads (§61.2). Everything the device already has; nothing is sent to the server.</summary>
    public sealed class LocalNotificationSnapshot
    {
        public long Now;
        /// <summary>The device language, "ja" or "en" (not the app's language setting).</summary>
        public string Locale = "ja";
        public LocalNotificationPermission Permission = LocalNotificationPermission.Unknown;
        /// <summary>Device setting, off by default: counts, points and the training horse's name on the lock screen.</summary>
        public bool ShowDetails;
        public bool SignedIn;
        public LocalRemindersDigest Digest;
        /// <summary>The device's horse names (read only with ShowDetails; never translated).</summary>
        public Dictionary<string, string> HorseNames = new Dictionary<string, string>();
    }

    /// <summary>One notification to schedule.</summary>
    public sealed class LocalNotificationItem
    {
        /// <summary>lnotif.{kind}.{ref}: stable for one event (a changed time keeps the id).</summary>
        public string Id;
        public string Kind, Category, Screen, RefId, Title, Body;
        public long FireAt;
        /// <summary>What the device remembers to re-schedule only changes (time and texts).</summary>
        public string Fingerprint => FireAt.ToString(CultureInfo.InvariantCulture) + "|" + Title + "|" + Body;
    }

    public sealed class LocalNotificationDrop { public string Id, Kind, Reason; }

    public sealed class LocalNotificationPlan
    {
        /// <summary>ok | no_permission (planned, not scheduled) | off | signed_out.</summary>
        public string Status;
        public List<LocalNotificationItem> Items = new List<LocalNotificationItem>();
        /// <summary>kind_off | category_off | quiet_hours | past | horizon | daily_cap | max_pending.</summary>
        public List<LocalNotificationDrop> Dropped = new List<LocalNotificationDrop>();
        public bool Schedules => Status == "ok";
    }

    /// <summary>The OS side (Codex: Unity Mobile Notifications — iOS UNUserNotificationCenter / Android channels). Only ids this app scheduled.</summary>
    public interface ILocalNotificationPlatform
    {
        LocalNotificationPermission Permission { get; }
        /// <summary>Shows the OS dialog once (iOS can only ask once; Android 13+ POST_NOTIFICATIONS). Never call it on first launch.</summary>
        Task<LocalNotificationPermission> RequestPermissionAsync();
        /// <summary>Schedules (or replaces) the notification with this id. data: kind, screen, refId for the tap.</summary>
        void Schedule(LocalNotificationItem item);
        void Cancel(string id);
        /// <summary>Cancels every notification this app scheduled (logout, account switch, transfer, deletion, the kill switch).</summary>
        void CancelAll();
        /// <summary>Opens the OS notification settings of the app (after a denial).</summary>
        void OpenSettings();
    }

    /// <summary>The same rules as server/src/domain/localNotify.ts (contracts/local-notifications.vectors.json).</summary>
    public static class LocalNotificationPlanner
    {
        /// <summary>Highest priority first (the daily cap keeps the first ones).</summary>
        public static readonly string[] Kinds = { "training_session", "gift_expiring", "exchange_closing", "weekly_challenge_closing", "rival_week_closing", "daily_bonus" };

        /// <summary>The push category that switches each kind (one settings screen for push and local).</summary>
        public static readonly IReadOnlyDictionary<string, string> KindCategory = new Dictionary<string, string>
        {
            { "training_session", "reminders" }, { "daily_bonus", "reminders" }, { "weekly_challenge_closing", "events" },
            { "rival_week_closing", "friends" }, { "exchange_closing", "events" }, { "gift_expiring", "gifts" },
        };

        /// <summary>The screen a tap opens, fixed in code (never the shop).</summary>
        public static readonly IReadOnlyDictionary<string, string> KindScreen = new Dictionary<string, string>
        {
            { "training_session", "training" }, { "daily_bonus", "home" }, { "weekly_challenge_closing", "weekly_challenge" },
            { "rival_week_closing", "rival" }, { "exchange_closing", "event_exchange" }, { "gift_expiring", "gift_box" },
        };

        private sealed class KindText { public string Title, Body, Detail, DetailOne; }
        private static KindText K(string t, string b, string d, string one = null) => new KindText { Title = t, Body = b, Detail = d, DetailOne = one };

        /// <summary>Both languages (server LNOTIF_TEXTS). {date} JST date and time, {time} JST clock, {n} a count, {horse} the player's horse name.</summary>
        private static readonly Dictionary<string, KindText[]> Texts = new Dictionary<string, KindText[]>
        {
            { "training_session", new[] {
                K("調教の仕上げ", "始めた調教が仕上げを待っています（{time}まで）", "{horse}の調教が仕上げを待っています（{time}まで）"),
                K("Finish your training", "A training session is waiting to be finished (until {time})", "{horse}'s training session is waiting to be finished (until {time})") } },
            { "daily_bonus", new[] {
                K("ログインボーナス", "今日のログインボーナスを受け取れます", "今日のログインボーナスを受け取れます"),
                K("Login bonus", "Today's login bonus is ready to collect", "Today's login bonus is ready to collect") } },
            { "weekly_challenge_closing", new[] {
                K("週替わりチャレンジ", "今週のチャレンジは{date}に入れ替わります", "未クリアのチャレンジが{n}つあります。{date}に入れ替わります"),
                K("Weekly challenges", "This week's challenges change on {date}", "{n} challenges left to clear. They change on {date}", "1 challenge left to clear. It changes on {date}") } },
            { "rival_week_closing", new[] {
                K("ライバル", "今週のライバルの週は{date}に締まります", "今週はまだランク戦を走っていません。ライバルの週は{date}に締まります"),
                K("Rival", "This rival week ends on {date}", "No ranked race yet this week. The rival week ends on {date}") } },
            { "exchange_closing", new[] {
                K("イベント交換所", "交換所は{date}に閉まります。残ったポイントは素材になります", "{n}ポイント残っています。交換所は{date}に閉まります（残りは素材になります）"),
                K("Event exchange", "The exchange closes on {date}. Leftover points become materials", "{n} points left. The exchange closes on {date} (leftovers become materials)", "1 point left. The exchange closes on {date} (leftovers become materials)") } },
            { "gift_expiring", new[] {
                K("プレゼントボックス", "受け取り期限が{date}の品があります", "受け取り期限が近い品が{n}件あります（最初は{date}）"),
                K("Gift box", "A gift box item can be collected until {date}", "{n} gift box items expire soon (the first on {date})", "1 gift box item can be collected until {date}") } },
        };

        /// <summary>Every title / body template in both languages (tests and the legal lint).</summary>
        public static IEnumerable<string> AllTexts() => Texts.Values.SelectMany(a => a).SelectMany(t => new[] { t.Title, t.Body, t.Detail, t.DetailOne }).Where(s => s != null);

        private const long Hour = 3_600_000L, Day = 24 * Hour, Minute = 60_000L, Jst = 9 * Hour;

        private static DateTime JstAt(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms + Jst).UtcDateTime;
        public static int JstHour(long ms) => JstAt(ms).Hour;

        /// <summary>「11月16日 4:00」 / "11/16 at 4:00" (JST).</summary>
        public static string DateText(long ms, string lang)
        {
            var t = JstAt(ms);
            string hm = t.Hour.ToString(CultureInfo.InvariantCulture) + ":" + t.Minute.ToString("00", CultureInfo.InvariantCulture);
            return lang == "en" ? t.Month.ToString(CultureInfo.InvariantCulture) + "/" + t.Day.ToString(CultureInfo.InvariantCulture) + " at " + hm
                : t.Month.ToString(CultureInfo.InvariantCulture) + "月" + t.Day.ToString(CultureInfo.InvariantCulture) + "日 " + hm;
        }

        /// <summary>「21:42」 (JST).</summary>
        public static string TimeText(long ms) { var t = JstAt(ms); return t.Hour.ToString(CultureInfo.InvariantCulture) + ":" + t.Minute.ToString("00", CultureInfo.InvariantCulture); }

        /// <summary>The same as server push.ts inQuietHours.</summary>
        public static bool InQuietHours(int? start, int? end, long ms)
        {
            if (!start.HasValue || !end.HasValue || start.Value == end.Value) return false;
            int h = JstHour(ms);
            return start.Value > end.Value ? h >= start.Value || h < end.Value : h >= start.Value && h < end.Value;
        }

        /// <summary>The same as server push.ts quietHoursEnd: the next endHour:00 JST after ms.</summary>
        public static long QuietHoursEnd(int end, long ms)
        {
            long dayStart = FloorDiv(ms + Jst, Day) * Day - Jst;
            long t = dayStart + end * Hour;
            while (t <= ms) t += Day;
            return t;
        }

        private static long FloorDiv(long a, long b) { long q = a / b; if ((a % b != 0) && ((a < 0) != (b < 0))) q--; return q; }

        private sealed class Cand { public string Kind, Id, RefId, HorseId; public long FireAt, Deadline, DateAt; public int? N; }

        /// <summary>REQ-LNOTIF-003..007: what the device schedules for one snapshot (pure).</summary>
        public static LocalNotificationPlan Plan(LocalNotificationSnapshot x)
        {
            var d = x.Digest;
            if (!x.SignedIn) return new LocalNotificationPlan { Status = "signed_out" };
            if (d == null || !d.Enabled || d.Deleting || d.Onboarding) return new LocalNotificationPlan { Status = "off" };
            long now = x.Now;
            var cands = new List<Cand>();
            if (d.TrainingSessionId != null && d.TrainingExpiresAt.HasValue)
                cands.Add(new Cand { Kind = "training_session", Id = "lnotif.training_session." + d.TrainingSessionId, FireAt = d.TrainingExpiresAt.Value - d.TrainingLeadMin * Minute, Deadline = d.TrainingExpiresAt.Value, RefId = d.TrainingHorseId, HorseId = d.TrainingHorseId, DateAt = d.TrainingExpiresAt.Value });
            if (d.LoginBonusUnlocked)
            {
                long at = d.NextDayAt + (((d.DailyHourJst - JstHour(d.NextDayAt)) % 24 + 24) % 24) * Hour;
                cands.Add(new Cand { Kind = "daily_bonus", Id = "lnotif.daily_bonus." + (d.NextDay ?? JstAt(d.NextDayAt).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)), FireAt = at, Deadline = d.NextDayAt + Day, DateAt = at });
            }
            long Lead(string k) => (d.LeadHours.TryGetValue(k, out var h) ? h : 24) * Hour;
            var wc = d.WeeklyChallenge;
            if (wc != null && wc.Unlocked && wc.Uncleared > 0)
                cands.Add(new Cand { Kind = "weekly_challenge_closing", Id = "lnotif.weekly_challenge_closing." + wc.EndsAt.ToString(CultureInfo.InvariantCulture), FireAt = wc.EndsAt - Lead("weekly_challenge_closing"), Deadline = wc.EndsAt, N = wc.Uncleared, DateAt = wc.EndsAt });
            var rv = d.Rival;
            if (rv != null && rv.RankedRaces == 0)
                cands.Add(new Cand { Kind = "rival_week_closing", Id = "lnotif.rival_week_closing." + rv.WeekEndsAt.ToString(CultureInfo.InvariantCulture), FireAt = rv.WeekEndsAt - Lead("rival_week_closing"), Deadline = rv.WeekEndsAt, DateAt = rv.WeekEndsAt });
            var ex = d.Exchanges.ToList();
            ex.Sort((a, b) => a.ClosesAt != b.ClosesAt ? a.ClosesAt.CompareTo(b.ClosesAt) : string.CompareOrdinal(a.EventId, b.EventId));
            foreach (var e in ex)
            {
                if (e.Points <= 0) continue;
                cands.Add(new Cand { Kind = "exchange_closing", Id = "lnotif.exchange_closing." + e.EventId, FireAt = e.ClosesAt - Lead("exchange_closing"), Deadline = e.ClosesAt, RefId = e.EventId, N = e.Points, DateAt = e.ClosesAt });
            }
            var gifts = d.Gifts.Where(g => g > now).OrderBy(g => g).ToList();
            if (gifts.Count > 0)
            {
                long first = gifts[0];
                cands.Add(new Cand { Kind = "gift_expiring", Id = "lnotif.gift_expiring." + first.ToString(CultureInfo.InvariantCulture), FireAt = first - Lead("gift_expiring"), Deadline = first, N = gifts.Count(g => g <= first + Day), DateAt = first });
            }

            var plan = new LocalNotificationPlan();
            void Drop(Cand k, string reason) => plan.Dropped.Add(new LocalNotificationDrop { Id = k.Id, Kind = k.Kind, Reason = reason });
            var live = new List<Cand>();
            foreach (var k in cands)
            {
                if (!d.Kinds.Contains(k.Kind)) { Drop(k, "kind_off"); continue; }
                if (!d.CategoryOn(KindCategory[k.Kind])) { Drop(k, "category_off"); continue; }
                if (InQuietHours(d.QuietStartHour, d.QuietEndHour, k.FireAt))
                {
                    if (k.Kind == "training_session") { Drop(k, "quiet_hours"); continue; }
                    long later = QuietHoursEnd(d.QuietEndHour.Value, k.FireAt);
                    if (later > k.Deadline - Hour) { Drop(k, "quiet_hours"); continue; }
                    k.FireAt = later;
                }
                if (k.FireAt <= now) { Drop(k, "past"); continue; }
                if (k.FireAt > now + d.HorizonDays * Day) { Drop(k, "horizon"); continue; }
                live.Add(k);
            }
            int Prio(Cand k) => Array.IndexOf(Kinds, k.Kind);
            live.Sort((a, b) => Prio(a) != Prio(b) ? Prio(a) - Prio(b) : a.FireAt != b.FireAt ? a.FireAt.CompareTo(b.FireAt) : string.CompareOrdinal(a.Id, b.Id));
            var perDay = new Dictionary<long, int>();
            var capped = new List<Cand>();
            foreach (var k in live)
            {
                long day = FloorDiv(k.FireAt - d.NextDayAt, Day);
                perDay.TryGetValue(day, out int used);
                if (used >= d.DailyCap) { Drop(k, "daily_cap"); continue; }
                perDay[day] = used + 1;
                capped.Add(k);
            }
            capped.Sort((a, b) => a.FireAt != b.FireAt ? a.FireAt.CompareTo(b.FireAt) : Prio(a) != Prio(b) ? Prio(a) - Prio(b) : string.CompareOrdinal(a.Id, b.Id));
            for (int i = d.MaxPending; i < capped.Count; i++) Drop(capped[i], "max_pending");
            foreach (var k in capped.Take(Math.Max(0, d.MaxPending))) plan.Items.Add(Render(k, x));
            plan.Status = x.Permission == LocalNotificationPermission.Granted || x.Permission == LocalNotificationPermission.Provisional ? "ok" : "no_permission";
            return plan;
        }

        private static LocalNotificationItem Render(Cand k, LocalNotificationSnapshot x)
        {
            string lang = x.Locale == "en" ? "en" : "ja";
            var tx = Texts[k.Kind][lang == "en" ? 1 : 0];
            string horse = null;
            if (k.HorseId != null && x.HorseNames != null) x.HorseNames.TryGetValue(k.HorseId, out horse);
            bool detail = x.ShowDetails && (k.Kind != "training_session" || !string.IsNullOrEmpty(horse));
            string tpl = !detail ? tx.Body : k.N == 1 && tx.DetailOne != null ? tx.DetailOne : tx.Detail;
            string body = tpl.Replace("{date}", DateText(k.DateAt, lang)).Replace("{time}", TimeText(k.DateAt))
                .Replace("{n}", k.N.HasValue ? k.N.Value.ToString(CultureInfo.InvariantCulture) : "").Replace("{horse}", horse ?? "");
            return new LocalNotificationItem { Id = k.Id, Kind = k.Kind, Category = KindCategory[k.Kind], FireAt = k.FireAt, Screen = KindScreen[k.Kind], RefId = k.RefId, Title = tx.Title, Body = body };
        }

        /// <summary>REQ-LNOTIF-011: what to cancel / schedule against what the device scheduled (id → fingerprint). Added = ids not scheduled before (KPI).</summary>
        public static LocalNotificationDiff Diff(IReadOnlyDictionary<string, string> previous, IReadOnlyList<LocalNotificationItem> items)
        {
            previous = previous ?? new Dictionary<string, string>();
            var next = items.ToDictionary(i => i.Id);
            var r = new LocalNotificationDiff();
            foreach (var kv in previous) if (!next.TryGetValue(kv.Key, out var i) || i.Fingerprint != kv.Value) r.Cancel.Add(kv.Key);
            r.Cancel.Sort(string.CompareOrdinal);
            foreach (var i in items)
            {
                if (!previous.TryGetValue(i.Id, out var fp)) { r.Schedule.Add(i); r.Added.Add(i.Id); }
                else if (fp != i.Fingerprint) r.Schedule.Add(i);
            }
            return r;
        }
    }

    public sealed class LocalNotificationDiff
    {
        public List<string> Cancel = new List<string>();
        public List<LocalNotificationItem> Schedule = new List<LocalNotificationItem>();
        public List<string> Added = new List<string>();
    }

    public sealed partial class AnalyticsEvent
    {
        private static string LnotifKind(string kind)
        {
            if (Array.IndexOf(LocalNotificationPlanner.Kinds, kind) < 0) throw new ArgumentException("unknown local notification kind " + kind);
            return kind;
        }
        /// <summary>REQ-LNOTIF-013: a local notification id newly scheduled (not on a re-schedule of the same id).</summary>
        public static AnalyticsEvent LocalNotificationScheduled(long atMs, string kind) => new AnalyticsEvent("lnotif_scheduled", atMs, JsonNode.Obj().Set("kind", LnotifKind(kind)));
        /// <summary>REQ-LNOTIF-013: the app was opened from a local notification.</summary>
        public static AnalyticsEvent LocalNotificationOpened(long atMs, string kind) => new AnalyticsEvent("lnotif_opened", atMs, JsonNode.Obj().Set("kind", LnotifKind(kind)));
        /// <summary>REQ-LNOTIF-013: result = granted | provisional | denied | later (the pre-prompt put off).</summary>
        public static AnalyticsEvent LocalNotificationPermissionResult(long atMs, string result)
        {
            if (result != "granted" && result != "provisional" && result != "denied" && result != "later") throw new ArgumentException("unknown permission result " + result);
            return new AnalyticsEvent("lnotif_permission", atMs, JsonNode.Obj().Set("result", result));
        }
    }
}
