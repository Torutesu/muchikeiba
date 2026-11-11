using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Game
{
    // REQ-LNOTIF-001..020 端末のローカル通知 (contracts/protocol.md §61). Pure C#: Codex's settings screen, the pre-permission sheet
    // and the OS package (Unity Mobile Notifications behind ILocalNotificationPlatform) bind to the public members.
    //
    // Rules the model keeps:
    //  - the plan is LocalNotificationPlanner.Plan over the bootstrap digest (same as the server, shared vectors); only the
    //    difference to what this device scheduled is cancelled / scheduled (Diff), so a training finished early loses its reminder;
    //  - what was scheduled is remembered per account: another account, a logout, a transfer, a deletion or the kill switch cancels
    //    everything this app scheduled (ForgetAll); being offline keeps what is scheduled;
    //  - the OS dialog is never shown on first launch: the pre-prompt comes after the first training started (or the digest's
    //    trainedEver), at most maxAsks times, retryDays apart, never pre-ticked; after an OS denial only the settings link remains;
    //  - player-typed names reach the lock screen only with ShowDetails (a device setting, default off);
    //  - KPI lnotif_scheduled for a newly scheduled id, lnotif_opened on a tap, lnotif_permission for the answer.

    /// <summary>One settings row: a local reminder and whether its push category lets it through.</summary>
    public sealed class LocalReminderRow
    {
        public string Kind, Category;
        public string Label, CategoryLabel;
        public bool On;
    }

    /// <summary>One upcoming reminder for the settings list (already in the app language).</summary>
    public sealed class UpcomingReminderRow
    {
        public string Id, Kind, WhenText, Title, Body, Screen;
    }

    public sealed class LocalNotificationModel : ScreenModel
    {
        public const string KeyScheduled = "muchi.lnotif.scheduled";
        public const string KeyShowDetails = "muchi.lnotif.details";
        public const string KeyAsks = "muchi.lnotif.asks";
        public const string KeyTrainingStarted = "muchi.lnotif.trainingStarted";

        public const string SectionTitle = "端末のリマインダー";
        public const string SectionNote = "この端末の中で予約するお知らせです。上の通知の種類と静かな時間帯がそのまま使われます。1日2件まで。";
        public const string DetailsLabel = "ロック画面に詳しく表示";
        public const string DetailsNote = "オンにすると、件数や馬の名前が通知に出ます（オフでは出しません）。";
        public const string UpcomingTitle = "次の予定";
        public const string UpcomingEmpty = "予定はありません";
        public const string PrePromptTitle = "調教とログインボーナスのお知らせ";
        public const string PrePromptBody = "調教の仕上げや、ログインボーナスを受け取れる日を、この端末からお知らせします。1日2件まで・静かな時間帯は送りません。あとから設定で変えられます。";
        public const string PrePromptAccept = "お知らせを受け取る";
        public const string PrePromptLater = "今はしない";
        public const string OpenOsSettings = "端末の設定を開く";

        private static readonly Dictionary<string, string> KindLabels = new Dictionary<string, string>
        {
            { "training_session", "調教の仕上げ" }, { "daily_bonus", "ログインボーナス（1日1回）" }, { "weekly_challenge_closing", "週替わりチャレンジの入れ替わり" },
            { "rival_week_closing", "ライバルの週の締め" }, { "exchange_closing", "イベント交換所が閉まる" }, { "gift_expiring", "プレゼントの受け取り期限" },
        };
        private static readonly Dictionary<string, string> CategoryLabels = new Dictionary<string, string>
        {
            { "reminders", "リマインダー" }, { "events", "イベント" }, { "friends", "フレンド" }, { "gifts", "プレゼント" },
        };

        private readonly ILocalNotificationPlatform _os;
        private readonly Action<AnalyticsEvent> _track;
        private readonly NowMs _now;
        private readonly Func<string> _deviceLanguage;

        /// <param name="deviceLanguage">The device language tag (Unity: Application.systemLanguage → "ja"/"en"); texts follow it, not the app setting.</param>
        public LocalNotificationModel(GameBackend backend, ILocalNotificationPlatform platform, Action<AnalyticsEvent> track = null, NowMs now = null, Func<string> deviceLanguage = null)
            : base(backend, backend?.Store)
        {
            _os = platform ?? throw new ArgumentNullException(nameof(platform));
            _track = track;
            _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _deviceLanguage = deviceLanguage ?? (() => Loc.Ja);
        }

        /// <summary>The last plan (null before the first Refresh).</summary>
        public LocalNotificationPlan Plan { get; private set; }
        public List<LocalReminderRow> Rows { get; private set; } = new List<LocalReminderRow>();
        public List<UpcomingReminderRow> Upcoming { get; private set; } = new List<UpcomingReminderRow>();
        public LocalNotificationPermission Permission => _os.Permission;
        public bool ShowDetails => Kv.Get(KeyShowDetails) == "1";
        /// <summary>The OS refused: show <see cref="OpenOsSettings"/> (the OS dialog is never shown again).</summary>
        public bool CanOpenOsSettings => Permission == LocalNotificationPermission.Denied;
        private LocalRemindersDigest Digest => B.Player?.LocalReminders;

        /// <summary>One line on the OS permission for the settings section.</summary>
        public string PermissionText
        {
            get
            {
                switch (Permission)
                {
                    case LocalNotificationPermission.Granted: return "通知は許可されています";
                    case LocalNotificationPermission.Provisional: return "通知センターに静かに届きます（仮の許可）";
                    case LocalNotificationPermission.Denied: return "端末の設定で通知がオフになっています";
                    default: return "通知はまだ許可されていません";
                }
            }
        }

        /// <summary>Plan again and apply the difference (start, foreground, after a training / claim / clear / exchange / setting change).</summary>
        public LocalNotificationPlan Refresh()
        {
            var player = B.Player;
            if (player == null)
            {
                // offline: keep what is scheduled (the last plan is still right until the server says otherwise)
                RebuildRows(Digest);
                return Plan;
            }
            var stored = Load();
            if (stored.Account != null && stored.Account != player.Id) { _os.CancelAll(); stored = new Stored(); } // another account on this device
            Plan = LocalNotificationPlanner.Plan(Snapshot(player, _deviceLanguage()));
            if (!Plan.Schedules)
            {
                // off (kill switch, deletion, onboarding) or no OS permission: nothing of ours stays scheduled
                if (stored.Ids.Count > 0) _os.CancelAll();
                Save(new Stored { Account = player.Id });
            }
            else
            {
                var diff = LocalNotificationPlanner.Diff(stored.Ids, Plan.Items);
                foreach (var id in diff.Cancel) _os.Cancel(id);
                foreach (var it in diff.Schedule) _os.Schedule(it);
                long at = _now();
                foreach (var id in diff.Added) { var it = Plan.Items.First(x => x.Id == id); _track?.Invoke(AnalyticsEvent.LocalNotificationScheduled(at, it.Kind)); }
                Save(new Stored { Account = player.Id, Ids = Plan.Items.ToDictionary(i => i.Id, i => i.Fingerprint) });
            }
            RebuildRows(Digest);
            return Plan;
        }

        /// <summary>Logout, account switch, transfer (引き継ぎ), account deletion: cancel everything this app scheduled and forget it.</summary>
        public void ForgetAll()
        {
            _os.CancelAll();
            Save(new Stored());
            Plan = null;
            Upcoming = new List<UpcomingReminderRow>();
        }

        public void SetShowDetails(bool on)
        {
            Kv.Set(KeyShowDetails, on ? "1" : "");
            Refresh();
        }

        // ------------------------------------------------------------------------------------- pre-permission sheet (§61.4)

        /// <summary>Call after POST /v1/training/start succeeded. Returns whether the pre-prompt should show now.</summary>
        public bool OnTrainingStarted()
        {
            Kv.Set(KeyTrainingStarted, "1");
            Refresh();
            bool due = PrePromptDue;
            if (due && Prompts != null) due = Prompts.TryClaim(SessionPrompts.RemindersPrePermission); // the caller shows the sheet now
            return due;
        }

        /// <summary>§58.11 (R21 integration): the session's one prompt gate, shared by every model that can interrupt the player.</summary>
        public SessionPrompts Prompts { get; set; }

        /// <summary>The sheet is due: reminders off, a training started, not denied by the OS, asks left and retryDays since the last.</summary>
        public bool PrePromptDue
        {
            get
            {
                var d = Digest;
                if (d == null || !d.Enabled || d.Onboarding || d.Deleting || d.CategoryOn("reminders")) return false;
                if (Prompts != null && !Prompts.CanShow(SessionPrompts.RemindersPrePermission)) return false; // §58.11: one prompt per session
                if (Permission == LocalNotificationPermission.Denied) return false;
                if (Kv.Get(KeyTrainingStarted) != "1" && !d.TrainedEver) return false;
                var (asks, last) = Asks();
                if (asks >= d.PrePromptMaxAsks) return false;
                return last == 0 || _now() - last >= d.PrePromptRetryDays * GameDay.DayMs;
            }
        }

        /// <summary>「お知らせを受け取る」: turn the reminders category on, then the OS dialog if it was never asked.</summary>
        public async Task<ActionResult> AcceptPrePromptAsync(CancellationToken ct = default)
        {
            CountAsk();
            if (ServerAvailable)
            {
                try
                {
                    var p = await B.Api.SetPushPreferencesAsync(new PushPreferencesPatch { Reminders = true }, ct);
                    if (Digest != null) Digest.Categories["reminders"] = p.Reminders;
                }
                catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
            }
            else return Offline("リマインダーの設定はオンラインで変えられます");
            var perm = Permission;
            if (perm == LocalNotificationPermission.Unknown) perm = await _os.RequestPermissionAsync();
            _track?.Invoke(AnalyticsEvent.LocalNotificationPermissionResult(_now(), ResultOf(perm)));
            Refresh();
            return ActionResult.Success();
        }

        /// <summary>「今はしない」: nothing changes; asked again at most maxAsks times, retryDays later.</summary>
        public void DeclinePrePrompt()
        {
            CountAsk();
            _track?.Invoke(AnalyticsEvent.LocalNotificationPermissionResult(_now(), "later"));
        }

        /// <summary>The settings switch of the reminders category (the other categories are the push settings' own switches).</summary>
        public async Task<ActionResult> SetRemindersAsync(bool on, CancellationToken ct = default)
        {
            if (!ServerAvailable) return Offline("リマインダーの設定はオンラインで変えられます");
            try
            {
                var p = await B.Api.SetPushPreferencesAsync(new PushPreferencesPatch { Reminders = on }, ct);
                if (Digest != null) Digest.Categories["reminders"] = p.Reminders;
                if (on && Permission == LocalNotificationPermission.Unknown)
                    _track?.Invoke(AnalyticsEvent.LocalNotificationPermissionResult(_now(), ResultOf(await _os.RequestPermissionAsync())));
                Refresh();
                return ActionResult.Success();
            }
            catch (ApiException e) { Message = UxText.For(e); return ActionResult.Error(Message); }
        }

        /// <summary>A notification was tapped: KPI lnotif_opened and the screen to open (never the shop). Null for an id that is not ours.</summary>
        public string OnOpened(string id)
        {
            string kind = LocalNotificationPlanner.Kinds.FirstOrDefault(k => id != null && id.StartsWith("lnotif." + k + ".", StringComparison.Ordinal));
            if (kind == null) return null;
            _track?.Invoke(AnalyticsEvent.LocalNotificationOpened(_now(), kind));
            return LocalNotificationPlanner.KindScreen[kind];
        }

        // ------------------------------------------------------------------------------------- internals

        private LocalNotificationSnapshot Snapshot(PlayerView p, string lang) => new LocalNotificationSnapshot
        {
            Now = _now(), Locale = Loc.Normalize(lang), Permission = Permission, ShowDetails = ShowDetails, SignedIn = true, Digest = p.LocalReminders,
            HorseNames = p.Horses.Where(h => h.Id != null && h.Name != null).GroupBy(h => h.Id).ToDictionary(g => g.Key, g => g.First().Name),
        };

        private void RebuildRows(LocalRemindersDigest d)
        {
            Rows = LocalNotificationPlanner.Kinds.Select(k =>
            {
                string cat = LocalNotificationPlanner.KindCategory[k];
                return new LocalReminderRow { Kind = k, Category = cat, Label = KindLabels[k], CategoryLabel = CategoryLabels[cat], On = d != null && d.Enabled && d.Kinds.Contains(k) && d.CategoryOn(cat) };
            }).ToList();
            // the list is shown in the app's language (the notifications themselves follow the device language)
            var shown = B.Player != null ? LocalNotificationPlanner.Plan(Snapshot(B.Player, Loc.Current)) : null;
            Upcoming = (shown?.Items ?? new List<LocalNotificationItem>()).Select(i => new UpcomingReminderRow
            {
                Id = i.Id, Kind = i.Kind, Screen = i.Screen, Title = i.Title, Body = i.Body,
                WhenText = LocalNotificationPlanner.DateText(i.FireAt, Loc.Current),
            }).ToList();
        }

        private static string ResultOf(LocalNotificationPermission p) =>
            p == LocalNotificationPermission.Granted ? "granted" : p == LocalNotificationPermission.Provisional ? "provisional" : "denied";

        private (int asks, long last) Asks()
        {
            var parts = (Kv.Get(KeyAsks) ?? "").Split('|');
            int.TryParse(parts[0], out int n);
            long last = 0;
            if (parts.Length > 1) long.TryParse(parts[1], out last);
            return (n, last);
        }

        private void CountAsk()
        {
            var (n, _) = Asks();
            Kv.Set(KeyAsks, (n + 1).ToString(System.Globalization.CultureInfo.InvariantCulture) + "|" + _now().ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        private sealed class Stored { public string Account; public Dictionary<string, string> Ids = new Dictionary<string, string>(); }

        private Stored Load()
        {
            var raw = Kv.Get(KeyScheduled);
            if (string.IsNullOrEmpty(raw)) return new Stored();
            try
            {
                var o = JsonNode.Parse(raw);
                var s = new Stored { Account = o.TryGet("account", out var a) && !a.IsNull ? a.AsString() : null };
                if (o.TryGet("ids", out var ids) && ids.Kind == JsonKind.Object) foreach (var kv in ids.Props) s.Ids[kv.Key] = kv.Value.AsString();
                return s;
            }
            catch (FormatException) { return new Stored(); }
        }

        private void Save(Stored s)
        {
            var ids = JsonNode.Obj();
            foreach (var kv in s.Ids) ids.Set(kv.Key, kv.Value);
            Kv.Set(KeyScheduled, JsonNode.Obj().Set("account", s.Account == null ? JsonNode.Null() : JsonNode.Str(s.Account)).Set("ids", ids).ToString());
        }
    }
}
