// アップデートのお知らせ (REQ-NEW-001..020, contracts/protocol.md §64): ReleaseNotesModel over a fake API and SessionPrompts.
// The sheet opens only when the server shows a note and the session is free (one system prompt per session, a higher one
// due at the same time wins, nothing over maintenance / forced update / offline), is marked seen once when it opens, never
// twice in a session, pages with 次へ / はじめる, skip, a target closes it, the past link after skipped versions, the past
// list (offline text, empty text) and the KPI rows.
using Muchi.Client;
using Muchi.Game;

static class ReleaseNotesChecks
{
    sealed class FakeApi : IReleaseNotesApi
    {
        public ReleaseNotesCheck Next;
        public int Checks, FailSeen, FailCheck;
        public readonly List<string> Seen = new List<string>();

        public static ReleaseNote Note(string v, int pages, int skipped = 0, bool hasPast = false)
        {
            var n = new ReleaseNote { AppVersion = v, ReleasedOn = "2026-11-05", Skipped = skipped, HasPast = hasPast };
            for (int i = 0; i < pages; i++) n.Pages.Add(new ReleaseNotePage { Art = "cups", Title = "観戦中に応援できる", Body = "応援は2秒ごとに送れます。", Target = i == 0 ? new ReleaseNoteTarget { Kind = ReleaseNoteTarget.KindHelp, Id = "spectator_cheer", Label = "ヘルプ：観戦中の応援" } : null });
            return n;
        }

        public Task<ReleaseNotesCheck> CheckReleaseNotesAsync(CancellationToken ct = default)
        {
            Checks++;
            if (FailCheck > 0) { FailCheck--; throw new NetworkException("offline", null); }
            return Task.FromResult(Next ?? new ReleaseNotesCheck { Enabled = true, Reason = ReleaseNotesCheck.ReasonNone });
        }

        public Task<ReleaseNotesSeen> MarkReleaseNotesSeenAsync(string appVersion, CancellationToken ct = default)
        {
            if (FailSeen > 0) { FailSeen--; throw new NetworkException("offline", null); }
            Seen.Add(appVersion);
            return Task.FromResult(new ReleaseNotesSeen { Marked = true, Seen = new List<string>(Seen) });
        }

        public Task<ReleaseNotesHistory> GetReleaseNotesAsync(CancellationToken ct = default)
        {
            var h = new ReleaseNotesHistory { Enabled = true, AppVersion = "1.2.0" };
            h.Notes.Add(Note("1.2.0", 3)); h.Notes.Add(Note("1.1.0", 2)); h.Notes[1].Seen = true;
            return Task.FromResult(h);
        }
    }

    public static async Task Run(Action<bool, string> check)
    {
        var ev = new List<AnalyticsEvent>();
        var api = new FakeApi();
        var outage = OutageKind.None;
        bool online = true;
        var prompts = new SessionPrompts(() => outage);
        var m = new ReleaseNotesModel(api, prompts, () => online, ev.Add, () => 1000);

        // nothing to show (an FTUE / new install / seen answer): no sheet, the session stays free
        api.Next = new ReleaseNotesCheck { Enabled = true, Reason = ReleaseNotesCheck.ReasonFtue };
        check(!await m.OnHomeArrivedAsync() && m.LastReason == ReleaseNotesCheck.ReasonFtue && prompts.Free, "no note (FTUE): no sheet, no prompt claimed");

        // offline / maintenance / forced update: never asks, never shows
        api.Next = new ReleaseNotesCheck { Enabled = true, Show = FakeApi.Note("1.2.0", 3, skipped: 1, hasPast: true) };
        int calls = api.Checks;
        online = false;
        check(!await m.OnHomeArrivedAsync() && api.Checks == calls, "offline: nothing is asked or shown");
        online = true;
        outage = OutageKind.Maintenance;
        check(!await m.OnHomeArrivedAsync() && api.Checks == calls, "during maintenance: nothing over the maintenance screen");
        outage = OutageKind.UpgradeRequired;
        check(!await m.OnHomeArrivedAsync() && !m.Showing, "a forced update: nothing over the update screen");
        outage = OutageKind.None;
        api.FailCheck = 1;
        check(!await m.OnHomeArrivedAsync() && !m.Showing && prompts.Free, "the check fails (network): nothing shown, no cached sheet");

        // a higher prompt due at the same time takes the session; the note waits for the next one (nothing marked)
        check(!await m.OnHomeArrivedAsync(new[] { SessionPrompts.ConsentPrePrompt }) && !m.Showing && api.Seen.Count == 0, "the consent pre-prompt (§58) outranks the sheet; nothing marked seen");
        prompts.TryClaim(SessionPrompts.ConsentPrePrompt);
        check(!await m.OnHomeArrivedAsync() && !m.Showing, "one system prompt per session: after the consent prompt, no sheet");

        // next session: the sheet opens, marked seen once, KPI shown
        m.NewSession();
        check(await m.OnHomeArrivedAsync(new[] { SessionPrompts.AccountLink, SessionPrompts.ReviewPrompt }) && m.Showing && prompts.Claimed == SessionPrompts.ReleaseNotes, "the sheet takes the session over the account-link and review prompts");
        check(api.Seen.SequenceEqual(new[] { "1.2.0" }), "marked seen once when it opens");
        check(ev.Last().Name == "release_notes_view" && ev.Last().PropsJson.Contains("\"stage\":\"shown\""), "KPI release_notes_view shown");
        check(m.Page == 0 && m.CtaLabel == ReleaseNotesModel.NextLabel && !m.ShowPastLink && m.CurrentPage.Target != null, "first page: 次へ, its target link");
        check(ReleaseNotesModel.VersionLabel("1.2.0") == "Ver. 1.2.0", "the version label");
        check(m.Next() && m.Next() && m.OnLastPage && m.CtaLabel == ReleaseNotesModel.StartLabel && m.ShowPastLink, "last page: はじめる and 「過去のアップデート情報」 (a skipped version)");
        check(!m.Next() && !m.Showing && ev.Last().PropsJson.Contains("\"stage\":\"finished\""), "はじめる on the last page closes it (finished)");
        check(!await m.OnHomeArrivedAsync() && !m.Showing, "never twice in one session");

        // skip and target
        m.NewSession();
        api.Next = new ReleaseNotesCheck { Enabled = true, Show = FakeApi.Note("1.3.0", 3) };
        api.FailSeen = 1;
        check(await m.OnHomeArrivedAsync() && m.Showing && api.Seen.Count == 1, "a failed seen mark keeps the sheet open (the next session may show it again)");
        m.Next();
        m.Skip();
        check(!m.Showing && ev.Last().PropsJson.Contains("\"stage\":\"skipped\"") && ev.Last().PropsJson.Contains("\"page\":2"), "スキップ closes early (skipped on page 2)");
        m.NewSession();
        check(await m.OnHomeArrivedAsync() && m.Showing, "not marked → shown again next session");
        var t = m.OpenTarget();
        check(t != null && t.Kind == ReleaseNoteTarget.KindHelp && t.Id == "spectator_cheer" && !m.Showing, "the page's target closes the sheet and says where to go");
        check(ev.Any(e => e.Name == "release_notes_target" && e.PropsJson.Contains("\"target\":\"spectator_cheer\"")), "KPI release_notes_target");
        check(m.CurrentPage == null && m.OpenTarget() == null, "no sheet, no target");

        // the past list
        await m.LoadHistoryAsync("notices");
        check(m.History.Notes.Count == 2 && m.History.Notes[1].Seen && m.Message == null, "the past list, newest first, with seen marks");
        check(ev.Last().Name == "release_notes_history" && ev.Last().PropsJson.Contains("\"source\":\"notices\""), "KPI release_notes_history (from お知らせ)");
        online = false;
        await m.LoadHistoryAsync("tips");
        check(m.Message == ReleaseNotesModel.OfflineText, "offline list: 「" + ReleaseNotesModel.OfflineText + "」");
        online = true;

        // the KPI rows match the server's schema shape (props)
        check(ev.All(e => e.Name.StartsWith("release_notes_")), "every row is a release_notes_* event");
    }
}
