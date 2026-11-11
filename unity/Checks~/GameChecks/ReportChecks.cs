// 通報とブロック (REQ-RPT-001..020, contracts/protocol.md §47): ReportModel and BlockListModel over a fake API. Reasons that
// fit the reported content only, the note counted like the server, one send at a time, "also block", the error readings
// (daily limit, content gone, not in the race), offline; the block list (current names, effects per feature), unblock only
// after a confirmation, one change per row, the full list.
using Muchi.Client;
using Muchi.Game;

static class ReportChecks
{
    sealed class FakeApi : IReportApi
    {
        public readonly List<string> Calls = new List<string>();
        public TaskCompletionSource<bool> Gate;
        public string FailWith;
        public int Remaining = 9;
        public readonly List<BlockedPlayer> Blocked = new List<BlockedPlayer> { new BlockedPlayer { PlayerId = "b", Name = "ベニ" }, new BlockedPlayer { PlayerId = "gone", Name = "プレイヤー" } };

        public Task<ReportOptions> GetReportOptionsAsync(CancellationToken ct = default)
        {
            var o = new ReportOptions { Enabled = true, NoteMaxChars = 10, RemainingToday = Remaining };
            o.Categories.Add(new ReportCategoryOption { Id = "name", Label = "不適切な名前", Kinds = new[] { "display_name", "horse_name", "stable_name" } });
            o.Categories.Add(new ReportCategoryOption { Id = "text", Label = "不適切なキャプション・文", Kinds = new[] { "replay_title", "photo_caption" } });
            o.Categories.Add(new ReportCategoryOption { Id = "cheating", Label = "不正の疑い", Kinds = new[] { "race" } });
            o.Categories.Add(new ReportCategoryOption { Id = "harassment", Label = "嫌がらせ", Kinds = ReportContentKinds.All });
            o.Categories.Add(new ReportCategoryOption { Id = "other", Label = "その他", Kinds = ReportContentKinds.All });
            return Task.FromResult(o);
        }

        public async Task<ReportResult> SubmitReportAsync(ReportTarget target, string category, string source, string note = null, bool alsoBlock = false, CancellationToken ct = default)
        {
            Calls.Add("report:" + target.Kind + ":" + category + ":" + source + ":" + (note ?? "-") + ":" + alsoBlock);
            if (Gate != null) await Gate.Task;
            if (FailWith != null) throw new ApiException(ApiErrorCode.Unknown, FailWith, FailWith, FailWith == "RATE_LIMITED" ? 429 : 404);
            return new ReportResult { Received = true, Blocked = alsoBlock, RemainingToday = Remaining - 1 };
        }

        public Task<BlockList> GetBlocksAsync(CancellationToken ct = default)
        {
            var l = new BlockList { Count = Blocked.Count, Max = 100 };
            l.Blocked.AddRange(Blocked);
            foreach (var f in new[] { "activity", "team_feed", "rival", "stable", "hall", "replays", "cups", "links", "showcase" }) l.Effects.Add(new BlockEffect { Feature = f, Text = "効果:" + f });
            return Task.FromResult(l);
        }

        public Task<BlockChange> BlockAsync(string playerId, CancellationToken ct = default)
        {
            Calls.Add("block:" + playerId);
            if (FailWith != null) throw new ApiException(ApiErrorCode.Unknown, FailWith, FailWith, 409);
            if (!Blocked.Any(b => b.PlayerId == playerId)) Blocked.Insert(0, new BlockedPlayer { PlayerId = playerId, Name = "?" });
            return Task.FromResult(new BlockChange { PlayerId = playerId, Blocked = true, Count = Blocked.Count, Max = 100 });
        }

        public async Task<BlockChange> UnblockAsync(string playerId, CancellationToken ct = default)
        {
            Calls.Add("unblock:" + playerId);
            if (Gate != null) await Gate.Task;
            if (FailWith != null) throw new ApiException(ApiErrorCode.Unknown, FailWith, FailWith, 503);
            Blocked.RemoveAll(b => b.PlayerId == playerId);
            return new BlockChange { PlayerId = playerId, Blocked = false, Count = Blocked.Count, Max = 100 };
        }
    }

    public static async Task Run(Action<bool, string> check)
    {
        // ---- the report sheet
        var api = new FakeApi();
        var m = new ReportModel(api, new ReportTarget("p9", ReportContentKinds.DisplayName), ReportSources.Profile) { TargetName = "ワルイナマエ" };
        await m.OpenAsync();
        check(string.Join(",", m.Reasons.Select(r => r.Id)) == "name,harassment,other", "sheet: only the reasons that fit a display name");
        check(!m.CanSend, "sheet: no reason chosen → cannot send");
        m.Select("name");
        check(m.SelectedReason == "name" && m.CanSend, "sheet: a reason → can send");
        m.Note = " 😀あいうえおかきくけ ";
        check(m.NoteLength == 10 && !m.NoteOver && m.NoteCounter == "10/10", "note: counted in characters after trimming (an emoji is one)");
        m.Note = "あいうえおかきくけこさ";
        check(m.NoteOver && !m.CanSend, "note: over the limit → cannot send");
        check(!await m.SendAsync() && m.Message == ReportModel.NoteTooLongText && api.Calls.Count == 0, "note too long: nothing sent, the reason shown");
        m.Note = "  ";
        m.AlsoBlock = true;
        api.Gate = new TaskCompletionSource<bool>();
        var first = m.SendAsync();
        check(m.Sending && !m.CanSend, "sending: the button is off");
        var second = await m.SendAsync();
        api.Gate.SetResult(true);
        var ok = await first;
        check(ok && !second && api.Calls.Count(c => c.StartsWith("report:")) == 1, "one send at a time (a second tap sends nothing)");
        check(api.Calls[0] == "report:display_name:name:profile:-:True", "sent: kind, reason, source, an empty note left out, also block");
        check(m.Sent && m.Blocked && m.Message == ReportModel.SentBlockedText && !m.CanSend, "after sending: done, blocked, the thank-you line");

        var race = new ReportModel(api, new ReportTarget("p9", ReportContentKinds.Race, "race_1"), ReportSources.Replay);
        await race.OpenAsync();
        check(string.Join(",", race.Reasons.Select(r => r.Id)) == "cheating,harassment,other", "race: cheating offered");
        race.Select("cheating");
        api.FailWith = "NOT_ELIGIBLE";
        check(!await race.SendAsync() && race.Message == ReportModel.NotInRaceText && race.SelectedReason == "cheating", "not in the race: explained, choices kept for another try");
        api.FailWith = "NOT_FOUND";
        await race.SendAsync();
        check(race.Message == ReportModel.GoneText, "content gone: explained");
        api.FailWith = "RATE_LIMITED";
        await race.SendAsync();
        check(race.Message == ReportModel.LimitText, "daily limit: explained (back at 4:00)");
        api.FailWith = null;

        var limited = new ReportModel(new FakeApi { Remaining = 0 }, new ReportTarget("p9", ReportContentKinds.Player), ReportSources.Friends);
        await limited.OpenAsync();
        limited.Select("other");
        check(!limited.CanSend && limited.Message == ReportModel.LimitText, "nothing left today: the sheet says so before sending");

        var off = new ReportModel(api, new ReportTarget("p9", ReportContentKinds.Player), ReportSources.Hall, () => false);
        await off.OpenAsync();
        check(off.Message == ReportModel.OfflineText && off.Reasons.Count == 0 && !await off.SendAsync(), "offline: nothing sent");
        bool threw = false;
        try { new ReportModel(api, new ReportTarget("p9", ReportContentKinds.Player), "chat"); } catch (ArgumentException) { threw = true; }
        check(threw, "unknown source refused");
        // Round 18 integration: a quick chat phrase row hands its §47 target (kind qchat, feedRef "teamId:seq") to the sheet
        var phrase = new FeedQuickChat { PhraseId = "otsukare", ReportKind = "team_feed", ReportTeamId = "t1", ReportSeq = 4 };
        var qt = phrase.ReportTargetFor("p9");
        check(qt != null && qt.Kind == ReportContentKinds.Qchat && qt.Ref == "t1:4", "quick chat: the phrase is a report target (" + qt?.Ref + ")");
        check(new FeedQuickChat { Anon = true, ReportTeamId = "t1", ReportSeq = 5 }.ReportTargetFor("") == null, "quick chat: a former member's phrase keeps the feed report");
        var qm = new ReportModel(api, qt, ReportSources.TeamFeed);
        await qm.OpenAsync();
        check(qm.Reasons.Count > 0, "quick chat: the sheet opens with reasons for a phrase");

        // ---- the block list
        var bapi = new FakeApi();
        var b = new BlockListModel(bapi);
        await b.OpenAsync();
        check(b.Rows.Count == 2 && b.Rows[0].Name == "ベニ" && b.CountText == "2/100", "list: names as the server sends them, the count");
        check(b.Effects.Count == 9 && b.Effects.All(e => e.Icon != "info"), "effects: one line per feature, each with an icon");
        b.AskUnblock(b.Rows[0]);
        check(b.Confirming?.PlayerId == "b" && !bapi.Calls.Any(c => c.StartsWith("unblock")), "unblock: asks first, sends nothing yet");
        b.CancelUnblock();
        check(b.Confirming == null && b.Rows.Count == 2, "cancel: nothing changes");
        b.AskUnblock(b.Rows[0]);
        bapi.FailWith = "INTERNAL";
        check(!await b.ConfirmUnblockAsync() && b.Rows.Count == 2 && b.Message != null, "a failed unblock leaves the row");
        bapi.FailWith = null;
        b.AskUnblock(b.Rows[0]);
        check(await b.ConfirmUnblockAsync() && b.Rows.Count == 1 && !b.IsBlocked("b") && b.Message == BlockListModel.UnblockedText, "unblocked after the confirmation");
        check(await b.BlockAsync("x", "エックス") && b.Rows[0].PlayerId == "x" && b.IsBlocked("x"), "block from a profile: on top of the list");
        bapi.FailWith = "TEAM_LIMIT";
        check(!await b.BlockAsync("y", "ワイ") && b.Message == BlockListModel.FullText, "full list: explained");
        bapi.FailWith = null;
        var boff = new BlockListModel(bapi, () => false);
        await boff.OpenAsync();
        check(boff.Message == BlockListModel.OfflineText && boff.Rows.Count == 0, "offline: the message, no list");
        check(ActivityModel.LineOf(new ActivityItem { Id = "1", Kind = ActivityKinds.OpsNotice, Screen = ActivityScreens.Safety, Text = "運営からのお願い" }).Label == "運営", "activity: support's notice has its label and leads to 通報とブロック");
    }
}
