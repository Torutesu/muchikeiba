// おすすめフレンド (REQ-FSUG-001..016, contracts/protocol.md §49): FriendSuggestionsModel over a fake API. Cards with the
// server's reason line, request / dismiss take the card out at once (back on failure, gone on 404), no double send while a
// call is in flight, fsug_view once per visit, offline / empty / disabled, the 「おすすめに表示しない」 switch, English UI text.
using System.Text.Json;
using Muchi.Client;
using Muchi.Game;

static class FriendSuggestionsChecks
{
    sealed class FakeApi : IFriendSuggestionsApi
    {
        public readonly List<string> Calls = new List<string>();
        public bool Enabled = true, FailNext, Gone;
        public TaskCompletionSource<bool> Gate;
        public Task<FriendSuggestions> GetFriendSuggestionsAsync(CancellationToken ct = default)
        {
            Calls.Add("list");
            var r = new FriendSuggestions { Enabled = Enabled };
            if (Enabled)
            {
                r.Items.Add(new FriendSuggestion { PlayerId = "b", DisplayName = "ベニ", ClassId = "C", Text = "同じ支部・共通のフレンド2人", Reasons = { new FriendSuggestionReason { Kind = "team" }, new FriendSuggestionReason { Kind = "mutual", N = 2 } } });
                r.Items.Add(new FriendSuggestion { PlayerId = "a", DisplayName = "アオイ", ClassId = "B", Text = "最近のレースで対戦", Reasons = { new FriendSuggestionReason { Kind = "opponent" } } });
            }
            return Task.FromResult(r);
        }
        public async Task<FriendOpResult> RequestSuggestedFriendAsync(string playerId, CancellationToken ct = default)
        {
            Calls.Add("request:" + playerId);
            if (Gate != null) await Gate.Task;
            Throw();
            return new FriendOpResult { Status = "requested", PlayerId = playerId };
        }
        public Task<bool> DismissSuggestionAsync(string playerId, CancellationToken ct = default) { Calls.Add("dismiss:" + playerId); Throw(); return Task.FromResult(true); }
        public Task<bool> SetSuggestionsHiddenAsync(bool hidden, CancellationToken ct = default) { Calls.Add("hidden:" + hidden); Throw(); return Task.FromResult(hidden); }
        void Throw()
        {
            if (Gone) { Gone = false; throw new ApiException(ApiErrorCode.NotFound, "NOT_FOUND", "no such suggestion", 404); }
            if (FailNext) { FailNext = false; throw new ApiException(ApiErrorCode.Unknown, "INTERNAL", "down", 503); }
        }
    }

    public static async Task Run(Action<bool, string> check, string root)
    {
        var api = new FakeApi();
        var events = new List<AnalyticsEvent>();
        var m = new FriendSuggestionsModel(api, () => true, e => events.Add(e), () => 1);
        await m.OpenAsync();
        check(m.Visible && m.Lines.Count == 2 && m.Lines[0].Name == "ベニ" && m.Lines[0].Reason == "同じ支部・共通のフレンド2人" && m.Lines[0].Icon == "team", "cards: name, reason line from the server, icon of the strongest reason");
        check(m.Lines[1].Icon == "opponent" && m.Message == null, "cards: opponent icon, no message");
        m.Shown(); m.Shown();
        check(events.Count(e => e.Name == "fsug_view") == 1, "fsug_view: once per visit");
        await m.OpenAsync(newVisit: false);
        m.Shown();
        check(events.Count(e => e.Name == "fsug_view") == 1, "fsug_view: a refresh in the same visit sends nothing");

        // request: the card leaves at once; a second tap while in flight sends nothing
        api.Gate = new TaskCompletionSource<bool>();
        var line = m.Lines[0];
        var t1 = m.RequestAsync(line);
        check(m.Lines.Count == 1 && m.Lines[0].PlayerId == "a", "request: the card leaves at once");
        var t2 = m.RequestAsync(line);
        api.Gate.SetResult(true);
        await Task.WhenAll(t1, t2);
        api.Gate = null;
        check(api.Calls.Count(c => c == "request:b") == 1 && m.Toast == FriendSuggestionsModel.RequestedText, "request: sent once, toast");

        // failure puts the card back with the error text
        api.FailNext = true;
        await m.DismissAsync(m.Lines[0]);
        check(m.Lines.Count == 1 && m.Lines[0].PlayerId == "a" && m.Toast != null, "dismiss failed: the card comes back");
        // 404: no longer suggestable → stays gone, empty text, no reason given
        api.Gone = true;
        await m.RequestAsync(m.Lines[0]);
        check(m.Lines.Count == 0 && m.Message == FriendSuggestionsModel.EmptyText, "request 404: the card stays gone, empty text");

        // the setting
        check(await m.SetHiddenAsync(true) && m.Hidden, "setting: saved");
        api.FailNext = true;
        check(!await m.SetHiddenAsync(false) && m.Hidden, "setting: a failed save goes back");

        // one load at a time: a list from an older open is dropped (no duplicates)
        var api2 = new FakeApi();
        var m2 = new FriendSuggestionsModel(api2, () => true, null, () => 1);
        await Task.WhenAll(m2.OpenAsync(), m2.OpenAsync());
        check(m2.Lines.Count == 2, "reopened: one list");

        var off = new FriendSuggestionsModel(new FakeApi(), () => false, e => events.Add(e));
        await off.OpenAsync();
        off.Shown();
        check(off.Message == FriendSuggestionsModel.OfflineText && off.Lines.Count == 0 && events.Count(e => e.Name == "fsug_view") == 1, "offline: the message, no cards, no view event");
        var disabled = new FriendSuggestionsModel(new FakeApi { Enabled = false });
        await disabled.OpenAsync();
        check(!disabled.Visible && disabled.Message == null, "disabled on the server: the section is left out");

        // every UI string has English (client ui-en.json)
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        var en = doc.RootElement.GetProperty("strings").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString());
        var texts = new[] { FriendSuggestionsModel.Title, FriendSuggestionsModel.OfflineText, FriendSuggestionsModel.EmptyText, FriendSuggestionsModel.RequestCta, FriendSuggestionsModel.DismissCta,
            FriendSuggestionsModel.RequestedText, FriendSuggestionsModel.BecameFriendsText, FriendSuggestionsModel.HiddenLabel, FriendSuggestionsModel.HiddenNote };
        check(texts.All(t => en.ContainsKey(t)), "English: every section text is in ui-en.json");
    }
}
