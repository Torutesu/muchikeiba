// 端末のローカル通知 (REQ-LNOTIF-001..020, contracts/protocol.md §61): LocalNotificationModel over a routed fake server and a fake OS.
// The plan from the bootstrap digest, only differences re-scheduled (a finished training cancels its reminder), KPI lnotif_scheduled once
// per new id, no scheduling without the OS permission, an account switch / logout / deletion cancelling everything, offline keeping what
// is scheduled, the pre-prompt (after the first training, never on first launch, maxAsks / retryDays, the reminders category on, the OS
// dialog once, denied = settings link only), ShowDetails for the horse name, the tap → screen (never the shop), English labels.
using System.Linq;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;

static class LocalNotificationChecks
{
    sealed class FakeServer : IHttp
    {
        public readonly List<HttpRequest> Sent = new List<HttpRequest>();
        public readonly Dictionary<string, Func<HttpRequest, HttpResponse>> Routes = new Dictionary<string, Func<HttpRequest, HttpResponse>>();
        public Task<HttpResponse> SendAsync(HttpRequest r, CancellationToken ct)
        {
            Sent.Add(r);
            if (Routes.TryGetValue(r.Method + " " + r.Path, out var h)) return Task.FromResult(h(r));
            return Task.FromResult(new HttpResponse(404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no route\"}}"));
        }
    }
    sealed class Tokens : IAuthTokenProvider { public Task<string> GetTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok"); }

    internal sealed class FakeOs : ILocalNotificationPlatform
    {
        public LocalNotificationPermission Current = LocalNotificationPermission.Unknown;
        public LocalNotificationPermission Answer = LocalNotificationPermission.Granted;
        public readonly Dictionary<string, LocalNotificationItem> Pending = new Dictionary<string, LocalNotificationItem>();
        public int Requests, Schedules, CancelAlls, Settings;
        public LocalNotificationPermission Permission => Current;
        public Task<LocalNotificationPermission> RequestPermissionAsync() { Requests++; Current = Answer; return Task.FromResult(Current); }
        public void Schedule(LocalNotificationItem item) { Schedules++; Pending[item.Id] = item; }
        public void Cancel(string id) => Pending.Remove(id);
        public void CancelAll() { CancelAlls++; Pending.Clear(); }
        public void OpenSettings() => Settings++;
    }

    const long Now = 1796698800000L; // 2026-12-08 12:00 JST
    const long NextDay = 1796756400000L; // 2026-12-09 04:00 JST
    const long WeekEnd = 1797188400000L; // 2026-12-14 04:00 JST

    internal static string Digest(bool reminders, string session, bool deleting = false, bool trainedEver = false) =>
        "{\"v\":1,\"enabled\":true,\"now\":" + Now + ",\"nextDayAt\":" + NextDay + ",\"nextDay\":\"2026-12-09\",\"config\":{\"kinds\":[\"training_session\",\"gift_expiring\",\"exchange_closing\",\"weekly_challenge_closing\",\"rival_week_closing\",\"daily_bonus\"],"
        + "\"dailyCap\":2,\"dailyHourJst\":12,\"horizonDays\":7,\"maxPending\":8,\"trainingLeadMin\":3,\"leadHours\":{\"weekly_challenge_closing\":24,\"rival_week_closing\":24,\"exchange_closing\":24,\"gift_expiring\":24},\"prePrompt\":{\"maxAsks\":2,\"retryDays\":14}},"
        + "\"categories\":{\"season\":true,\"friends\":true,\"invites\":true,\"events\":true,\"comeback\":false,\"gifts\":true,\"reminders\":" + (reminders ? "true" : "false") + "},\"quietHours\":{\"startHour\":22,\"endHour\":8},"
        + "\"deleting\":" + (deleting ? "true" : "false") + ",\"onboarding\":false,\"loginBonus\":{\"unlocked\":true},"
        + "\"training\":" + (session == null ? "{\"sessionId\":null,\"horseId\":null,\"expiresAt\":null,\"trainedEver\":" + (trainedEver ? "true" : "false") + "}" : "{\"sessionId\":\"" + session + "\",\"horseId\":\"h1\",\"expiresAt\":" + (Now + 480000) + ",\"trainedEver\":true}") + ","
        + "\"weeklyChallenge\":{\"unlocked\":true,\"endsAt\":" + WeekEnd + ",\"uncleared\":2},\"rival\":null,\"exchanges\":[],\"gifts\":[" + (Now + 3 * 86400000L) + "]}";

    internal static string Player(string id, string digest) =>
        "{\"id\":\"" + id + "\",\"wallet\":{\"paid\":0,\"free\":0,\"total\":0,\"debt\":0},\"season\":{\"id\":\"2026-12\",\"classId\":\"C\",\"points\":0},\"items\":{},"
        + "\"horses\":[{\"id\":\"h1\",\"name\":\"アカツキ\",\"rarity\":\"SR\",\"status\":\"active\"}],\"equipment\":{\"tack\":{},\"decor\":[]},\"deletion\":{\"status\":\"none\"},\"localReminders\":" + digest + "}";

    public static async Task Run(Action<bool, string> check, RulesetParams ruleset, string root)
    {
        var s = new FakeServer();
        string id = "g1"; bool reminders = false; string session = null; bool deleting = false; bool trainedEver = false;
        string Body() => Player(id, Digest(reminders, session, deleting, trainedEver));
        s.Routes["POST /v1/player/bootstrap"] = _ => new HttpResponse(200, Body());
        s.Routes["GET /v1/player"] = _ => new HttpResponse(200, Body());
        s.Routes["PUT /v1/push/preferences"] = r =>
        {
            reminders = r.Body.Contains("\"reminders\":true");
            return new HttpResponse(200, "{\"categories\":{\"season\":true,\"friends\":true,\"invites\":true,\"events\":true,\"comeback\":false,\"gifts\":true,\"reminders\":" + (reminders ? "true" : "false") + "},\"quietHours\":{\"startHour\":22,\"endHour\":8},\"dailyCap\":2,\"devices\":1,\"topics\":{\"subscribe\":[],\"unsubscribe\":[]}}");
        };
        var api = new ApiClient(s, new Tokens(), new ApiClientOptions { BaseUrl = "http://fake", Retry = new RetryPolicy { MaxRetries = 0 } });
        var kv = new MemoryKeyValueStore();
        var b = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv, ruleset);
        await b.InitializeAsync();
        var events = new List<AnalyticsEvent>();
        long now = Now;
        var os = new FakeOs();
        var m = new LocalNotificationModel(b, os, events.Add, () => now);

        // first launch: nothing asked, nothing scheduled without the permission; the settings list still shows what would come
        var p0 = m.Refresh();
        check(p0.Status == "no_permission" && os.Pending.Count == 0 && os.Requests == 0, "lnotif: no OS permission → planned, nothing scheduled, the OS dialog not shown on launch");
        check(!m.PrePromptDue, "lnotif: no pre-prompt before the first training");
        check(m.Upcoming.Count > 0 && m.Upcoming.All(u => u.Kind != "daily_bonus" && u.Kind != "training_session"), "lnotif: the reminders category is off by default → no daily bonus / training rows (" + string.Join(",", m.Upcoming.Select(u => u.Kind)) + ")");
        check(m.Rows.Count == 6 && !m.Rows.First(r => r.Kind == "daily_bonus").On && m.Rows.First(r => r.Kind == "gift_expiring").On && m.Rows.First(r => r.Kind == "daily_bonus").CategoryLabel == "リマインダー", "lnotif: settings rows follow the push categories");
        check(m.PermissionText == "通知はまだ許可されていません", "lnotif: the permission line");

        // the first training: the pre-prompt is due; accept → reminders on, OS dialog once, KPI granted, scheduled with KPI per id
        session = "ts1";
        await b.RefreshAsync();
        bool due = m.OnTrainingStarted();
        check(due && m.PrePromptDue, "lnotif: the pre-prompt after the first training started");
        var acc = await m.AcceptPrePromptAsync();
        check(acc.Ok && reminders && os.Requests == 1 && events.Any(e => e.Name == "lnotif_permission" && e.PropsJson.Contains("granted")), "lnotif: accept turns reminders on and asks the OS once (KPI granted)");
        await b.RefreshAsync();
        m.Refresh();
        check(os.Pending.ContainsKey("lnotif.training_session.ts1") && os.Pending.Values.Any(i => i.Kind == "daily_bonus"), "lnotif: training and daily bonus scheduled once reminders are on (" + string.Join(",", os.Pending.Keys) + ")");
        check(os.Pending.Values.All(i => !i.Body.Contains("アカツキ")), "lnotif: no horse name on the lock screen by default");
        int scheduledKpi = events.Count(e => e.Name == "lnotif_scheduled");
        check(scheduledKpi == os.Pending.Count, "lnotif: lnotif_scheduled once per new id (" + scheduledKpi + ")");
        check(!m.PrePromptDue, "lnotif: no pre-prompt once reminders are on");

        // nothing changed → nothing re-sent; details on → same ids re-scheduled (texts) without new KPI
        int sch = os.Schedules;
        m.Refresh();
        check(os.Schedules == sch, "lnotif: an unchanged plan schedules nothing again");
        m.SetShowDetails(true);
        check(os.Pending["lnotif.training_session.ts1"].Body.Contains("アカツキ") && events.Count(e => e.Name == "lnotif_scheduled") == scheduledKpi, "lnotif: ShowDetails puts the horse name in (re-schedule, no new KPI)");
        m.SetShowDetails(false);

        // the training is finished early: its reminder is cancelled
        session = null; trainedEver = true;
        await b.RefreshAsync();
        m.Refresh();
        check(!os.Pending.ContainsKey("lnotif.training_session.ts1") && os.Pending.Count > 0, "lnotif: a finished training loses its reminder, the rest stays");

        // the tap opens the kind's screen (never the shop) and sends lnotif_opened
        check(m.OnOpened("lnotif.gift_expiring." + (Now + 3 * 86400000L)) == "gift_box" && events.Any(e => e.Name == "lnotif_opened"), "lnotif: a tap opens the gift box (KPI lnotif_opened)");
        check(m.OnOpened("someone.else") == null, "lnotif: a notification that is not ours is ignored");

        // offline keeps what is scheduled
        int before = os.Pending.Count, alls = os.CancelAlls;
        var offline = new GameBackend(new GameSettings { OfflineOnly = true }, null, null, kv, ruleset);
        await offline.InitializeAsync();
        new LocalNotificationModel(offline, os, events.Add, () => now).Refresh();
        check(os.Pending.Count == before && os.CancelAlls == alls, "lnotif: offline keeps the scheduled reminders");

        // another account on this device: everything of the first is cancelled first
        id = "g2";
        await b.RefreshAsync();
        m.Refresh();
        check(os.CancelAlls == alls + 1, "lnotif: another account cancels the first account's reminders");
        // a scheduled deletion cancels everything; logout forgets everything
        deleting = true;
        await b.RefreshAsync();
        m.Refresh();
        check(os.Pending.Count == 0 && m.Plan.Status == "off", "lnotif: a scheduled deletion cancels every reminder");
        deleting = false;
        await b.RefreshAsync();
        m.Refresh();
        check(os.Pending.Count > 0, "lnotif: after cancelling the deletion the reminders come back");
        m.ForgetAll();
        check(os.Pending.Count == 0 && (kv.Get(LocalNotificationModel.KeyScheduled) ?? "").Contains("\"account\":null"), "lnotif: logout / transfer forgets everything");

        // a fresh device: decline twice → never a third ask; retryDays apart; an OS denial = settings link only
        var kv2 = new MemoryKeyValueStore();
        reminders = false; id = "g3"; trainedEver = true;
        var b2 = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv2, ruleset);
        await b2.InitializeAsync();
        var os2 = new FakeOs();
        var m2 = new LocalNotificationModel(b2, os2, events.Add, () => now);
        check(m2.PrePromptDue, "lnotif: trainedEver from the server is a trigger too (a reinstall)");
        m2.DeclinePrePrompt();
        check(!m2.PrePromptDue && events.Any(e => e.Name == "lnotif_permission" && e.PropsJson.Contains("later")), "lnotif: 今はしない → KPI later, not asked again right away");
        now += 14 * GameDay.DayMs;
        check(m2.PrePromptDue, "lnotif: asked again after retryDays");
        m2.DeclinePrePrompt();
        now += 30 * GameDay.DayMs;
        check(!m2.PrePromptDue, "lnotif: never more than maxAsks");
        os2.Current = LocalNotificationPermission.Denied;
        check(m2.CanOpenOsSettings && m2.PermissionText == "端末の設定で通知がオフになっています", "lnotif: an OS denial shows the settings link");
        var kv3 = new MemoryKeyValueStore();
        var b3 = new GameBackend(new GameSettings { BaseUrl = "http://fake" }, api, null, kv3, ruleset);
        await b3.InitializeAsync();
        var os3 = new FakeOs { Current = LocalNotificationPermission.Denied };
        check(!new LocalNotificationModel(b3, os3, events.Add, () => now).PrePromptDue, "lnotif: no pre-prompt after an OS denial");
        os3.Current = LocalNotificationPermission.Provisional;
        reminders = true;
        await b3.RefreshAsync();
        var m3 = new LocalNotificationModel(b3, os3, events.Add, () => Now);
        check(m3.Refresh().Status == "ok" && os3.Pending.Count > 0, "lnotif: provisional permission schedules");

        // English labels for every line the model shows
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        try
        {
            Loc.SetLocale("en");
            var texts = m.Rows.SelectMany(r => new[] { r.Label, r.CategoryLabel }).Concat(new[] {
                LocalNotificationModel.SectionTitle, LocalNotificationModel.SectionNote, LocalNotificationModel.DetailsLabel, LocalNotificationModel.DetailsNote,
                LocalNotificationModel.UpcomingTitle, LocalNotificationModel.UpcomingEmpty, LocalNotificationModel.PrePromptTitle, LocalNotificationModel.PrePromptBody,
                LocalNotificationModel.PrePromptAccept, LocalNotificationModel.PrePromptLater, LocalNotificationModel.OpenOsSettings, m2.PermissionText, m3.PermissionText });
            var missing = texts.Where(t => Loc.HasJapanese(Loc.T(t))).ToList();
            check(missing.Count == 0, "lnotif: every label has English" + (missing.Count > 0 ? " (missing: " + string.Join(" | ", missing) + ")" : ""));
            m3.Refresh();
            check(m3.Upcoming.Count > 0 && m3.Upcoming.All(u => !Loc.HasJapanese(u.Title + u.Body + u.WhenText)), "lnotif: the upcoming list follows the app language (" + m3.Upcoming[0].WhenText + " " + m3.Upcoming[0].Body + ")");
        }
        finally { Loc.SetLocale("ja"); }
        var all = LocalNotificationPlanner.AllTexts().Concat(new[] { LocalNotificationModel.PrePromptBody, LocalNotificationModel.SectionNote });
        check(all.All(t => !t.Contains("今だけ") && !t.Contains("残りわずか") && !t.Contains("お得") && !t.Contains("ショップ")), "lnotif: no urgency or shop words");
    }
}
