// アクティビティ (REQ-ACT-001..016, contracts/protocol.md §40): ActivityModel over a fake API. The bell (hidden at 0, 99+),
// first page + activity_open once, mark read up to the newest id (kept and retried when it fails), paging with the server's
// cursor (one load at a time, a page from a closed opening is dropped), deep links + activity_tap, gift rows link to the box
// (never a claim), what's-new as a link only, offline text.
using Muchi.Client;
using Muchi.Game;

static class ActivityChecks
{
    sealed class FakeApi : IActivityApi
    {
        public readonly List<string> Calls = new List<string>();
        public bool FailRead;
        public TaskCompletionSource<bool> Gate;
        public async Task<ActivityPage> GetActivityAsync(string cursor = null, int limit = 20, CancellationToken ct = default)
        {
            Calls.Add("page:" + (cursor ?? "-"));
            if (Gate != null) await Gate.Task;
            var p = new ActivityPage { Unread = 2, WhatsNew = 1, NextCursor = cursor == null ? "5" : null };
            if (cursor == null)
            {
                p.Items.Add(new ActivityItem { Id = "9", Kind = ActivityKinds.StableLike, Category = "friends", At = 1794193200000, Count = 12, Unread = true, Text = "マイ厩舎に12件のいいねが届きました", Screen = ActivityScreens.Stable });
                p.Items.Add(new ActivityItem { Id = "7", Kind = ActivityKinds.TournamentResult, Category = "events", At = 1794190000000, Count = 1, Unread = true, Text = "「秋の大会」の最終順位は2位でした", Screen = ActivityScreens.Tournaments, LinkId = "t1" });
            }
            else p.Items.Add(new ActivityItem { Id = "5", Kind = ActivityKinds.GiftArrived, Category = "gifts", At = 1794180000000, Count = 2, Text = "プレゼントボックスに2件のプレゼントが届きました", Screen = ActivityScreens.GiftBox });
            return p;
        }
        public Task<ActivityReadResult> MarkActivityReadAsync(string upTo = null, CancellationToken ct = default)
        {
            Calls.Add("read:" + upTo);
            if (FailRead) throw new ApiException(ApiErrorCode.Unknown, "INTERNAL", "down", 503);
            return Task.FromResult(new ActivityReadResult { ReadUpTo = upTo, Unread = 0 });
        }
    }

    public static async Task Run(Action<bool, string> check)
    {
        var api = new FakeApi();
        var events = new List<string>();
        var m = new ActivityModel(api, () => true, e => events.Add(e.Name), () => 1);
        check(m.BadgeText == null, "bell: hidden at 0");
        m.SetBadge(new ActivityBadge { Unread = 3 });
        check(m.BadgeText == "3", "bell: the player view's number");
        m.SetBadge(new ActivityBadge { Unread = 99 });
        check(m.BadgeText == "99+", "bell: 99+ at the server's cap");
        m.SetBadge(new ActivityBadge { Unread = 3 });

        await m.OpenAsync();
        check(events.Count(e => e == "activity_open") == 1, "open: activity_open once");
        check(m.Lines.Count == 2 && m.Lines[0].Text.Contains("12件") && m.Lines[0].Label == "マイ厩舎" && m.Lines[0].Icon == "like", "list: newest first, collapsed likes with label and icon");
        check(api.Calls.Contains("read:9") && m.Unread == 0 && m.BadgeText == null, "open: marked read up to the newest id; the bell clears");
        check(m.WhatsNew == 1, "what's new: a link count, not entries");
        await m.MoreAsync();
        check(m.Lines.Count == 3 && !m.HasMore, "more: the server's cursor, then the end");
        var gift = m.Lines[2];
        check(gift.Cta == "プレゼントボックスへ" && gift.Screen == ActivityScreens.GiftBox, "gift row: leads to the gift box (no claim here)");
        check(m.Lines.All(l => l.Cta == "見る" || l.Cta == "プレゼントボックスへ"), "no row offers a claim");
        var (screen, id) = m.Tap(m.Lines[1]);
        check(screen == ActivityScreens.Tournaments && id == "t1" && events.Contains("activity_tap"), "tap: the deep link and activity_tap");

        // a failed mark-read is kept and sent again on the next open
        var api2 = new FakeApi { FailRead = true };
        var m2 = new ActivityModel(api2, () => true, null, () => 1);
        await m2.OpenAsync();
        check(m2.Unread == 2, "mark read failed: the number stays");
        api2.FailRead = false;
        await m2.FlushReadAsync();
        check(api2.Calls.Count(c => c == "read:9") == 2 && m2.Unread == 0, "mark read: retried later (idempotent on the server)");

        // one load at a time; a page from an earlier opening is dropped
        var api3 = new FakeApi { Gate = new TaskCompletionSource<bool>() };
        var m3 = new ActivityModel(api3, () => true, null, () => 1);
        var first = m3.OpenAsync();
        check(m3.Loading, "loading while the page is on its way");
        var second = m3.OpenAsync();
        api3.Gate.SetResult(true);
        await Task.WhenAll(first, second);
        check(m3.Lines.Count == 2 && m3.Lines.Select(l => l.Id).Distinct().Count() == 2, "reopened: one list, no duplicate rows");

        var off = new ActivityModel(new FakeApi(), () => false);
        await off.OpenAsync();
        check(off.Message == ActivityModel.OfflineText && off.Lines.Count == 0, "offline: the message, no list");
        check(ActivityModel.When(1794193200000) == "11/09 12:00", "time: JST");
    }
}
