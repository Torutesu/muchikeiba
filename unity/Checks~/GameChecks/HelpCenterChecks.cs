// ヘルプセンター (REQ-HELP-001..024, contracts/protocol.md §48): HelpCenterModel over a fake API. The index and categories,
// contextual help (odds → pity, coin shortfall → buying coins), help_article_view once per opening with its source, search
// (late answers dropped, help_search without the query), title matching with the server's fold, "was this helpful", the form
// (limits, history rows, diagnostics rows, one key kept across retries, offline keeps the draft), my inquiries and read marks.
using Muchi.Client;
using Muchi.Game;

static class HelpCenterChecks
{
    sealed class FakeApi : IHelpApi
    {
        public readonly List<string> Calls = new List<string>();
        public readonly List<string> Keys = new List<string>();
        public int FailSubmits;
        public TaskCompletionSource<bool> SearchGate;
        public bool Answered;

        public Task<HelpIndex> GetHelpAsync(CancellationToken ct = default)
        {
            Calls.Add("index");
            var i = new HelpIndex { Enabled = true, Version = 1, Lang = "ja", DescriptionMin = 10, DescriptionMax = 1000, AttachMax = 2, DiagnosticsNote = "送信すると、アプリの版…" };
            i.Categories.Add(new HelpCategoryInfo { Id = HelpCategories.Scout, Title = "スカウト（提供割合・天井）", Icon = "scout", Count = 2 });
            i.Categories.Add(new HelpCategoryInfo { Id = HelpCategories.Purchases, Title = "購入・返金", Icon = "coin", Count = 1 });
            i.Articles.Add(new HelpArticleRef { Id = "pity", Category = HelpCategories.Scout, Title = "天井（交換pt）のしくみ" });
            i.Articles.Add(new HelpArticleRef { Id = "scout_rates", Category = HelpCategories.Scout, Title = "スカウトの提供割合" });
            i.Articles.Add(new HelpArticleRef { Id = "buy_coins", Category = HelpCategories.Purchases, Title = "コインの購入（有償コインと無償コイン）" });
            i.Contexts[HelpContexts.GachaOdds] = "pity";
            i.Contexts[HelpContexts.CoinShortfall] = "buy_coins";
            i.InquiryCategories.Add(new InquiryCategoryInfo { Id = InquiryCategories.PurchaseMissing, Title = "購入したのに届かない", History = true });
            i.InquiryCategories.Add(new InquiryCategoryInfo { Id = InquiryCategories.Bug, Title = "不具合の報告", History = false });
            return Task.FromResult(i);
        }
        public Task<HelpArticle> GetHelpArticleAsync(string articleId, CancellationToken ct = default)
        {
            Calls.Add("article:" + articleId);
            return Task.FromResult(new HelpArticle { Id = articleId, Category = articleId == "pity" ? HelpCategories.Scout : HelpCategories.Purchases, Title = articleId, Body = "常設のスカウトでは100回分たまると…\n\n・天井までに必要なコインは最大10,000コインです" });
        }
        public async Task<HelpSearchResult> SearchHelpAsync(string q, string category = null, int limit = 20, CancellationToken ct = default)
        {
            Calls.Add("search:" + q);
            if (SearchGate != null && q == "てんじょう") await SearchGate.Task;
            var r = new HelpSearchResult { Total = q == "なし" ? 0 : 1, QueryLength = HelpText.Fold(q).Length };
            if (q != "なし") r.Items.Add(new HelpArticleRef { Id = q == "てんじょう" ? "pity" : "buy_coins", Title = q });
            return r;
        }
        public Task<HelpFeedbackResult> SendHelpFeedbackAsync(string articleId, bool helpful, CancellationToken ct = default)
        {
            Calls.Add("vote:" + articleId + ":" + helpful);
            return Task.FromResult(new HelpFeedbackResult { ArticleId = articleId, Helpful = helpful, Changed = true });
        }
        public Task<InquiryList> GetInquiriesAsync(CancellationToken ct = default)
        {
            Calls.Add("list");
            var l = new InquiryList { Unread = Answered ? 1 : 0, Limits = new InquiryLimits { OpenMax = 3, Open = Answered ? 0 : 1, PerDay = 5, Today = 1 } };
            l.Items.Add(new Inquiry { TicketId = "q_1", Category = InquiryCategories.PurchaseMissing, Status = Answered ? InquiryStatuses.Answered : InquiryStatuses.Received, StatusText = Answered ? "回答済み" : "受付済み", Unread = Answered });
            return Task.FromResult(l);
        }
        public Task<Inquiry> GetInquiryAsync(string ticketId, CancellationToken ct = default)
        {
            Calls.Add("detail:" + ticketId);
            var t = new Inquiry { TicketId = ticketId, Status = InquiryStatuses.Answered, Unread = Answered, InquiryText = "コインが届きません" };
            t.Messages.Add(new InquiryMessage { From = "support", MessageText = "確認しました。", At = 1 });
            return Task.FromResult(t);
        }
        public Task<Inquiry> SubmitInquiryAsync(InquiryDraft draft, string idempotencyKey = null, CancellationToken ct = default)
        {
            Calls.Add("submit:" + draft.Category + ":" + draft.Refs.Count + ":" + draft.Platform + ":" + draft.AppVersion);
            Keys.Add(idempotencyKey);
            if (FailSubmits-- > 0) throw new NetworkException("POST /v1/help/inquiries: timeout", null);
            return Task.FromResult(new Inquiry { TicketId = "q_1", Category = draft.Category, Status = InquiryStatuses.Received, StatusText = "受付済み" });
        }
        public Task<InquiryReadResult> MarkInquiryReadAsync(string ticketId, CancellationToken ct = default)
        {
            Calls.Add("read:" + ticketId);
            return Task.FromResult(new InquiryReadResult { TicketId = ticketId, UnreadTotal = 0 });
        }
    }

    public static async Task Run(Action<bool, string> check)
    {
        var api = new FakeApi();
        var events = new List<AnalyticsEvent>();
        bool online = true;
        int keyN = 0;
        var m = new HelpCenterModel(api, "1.4.0", "ios", () => online, e => events.Add(e), () => 1, () => "c:help:" + (++keyN));

        check(m.BadgeText == null, "badge: hidden at 0");
        m.SetBadge(new HelpBadge { UnreadReplies = 2 });
        check(m.BadgeText == "2", "badge: the player view's unread replies");

        // contextual help loads the index on demand, then opens the article with source=context
        var a = await m.OpenContextAsync(HelpContexts.GachaOdds);
        check(a != null && a.Id == "pity" && api.Calls.SequenceEqual(new[] { "index", "article:pity" }), "context: odds screen → the pity article (index loaded first)");
        check(events.Count == 1 && events[0].Name == "help_article_view" && events[0].PropsJson.Contains("\"source\":\"context\""), "context: help_article_view with source=context");
        check(m.ContextArticle(HelpContexts.CoinShortfall) == "buy_coins", "context: coin shortfall → buying coins");
        check(m.ArticlesIn(HelpCategories.Scout).Count == 2, "category: its articles in master order");

        // title matching uses the server's fold (hiragana / half-width)
        check(m.TitleMatches("ｽｶｳﾄ").Select(x => x.Id).SequenceEqual(new[] { "scout_rates" }), "title match: half-width katakana finds スカウト");
        check(m.TitleMatches("こいん").Count == 1, "title match: hiragana finds コイン");

        // search: a late answer for an older query is dropped; the KPI never carries the query
        api.SearchGate = new TaskCompletionSource<bool>();
        var slow = m.SearchAsync("てんじょう");
        await m.SearchAsync("こいん", HelpCategories.Purchases);
        api.SearchGate.SetResult(true);
        await slow;
        check(m.Results.Items[0].Id == "buy_coins" && m.Query == "こいん", "search: the older query's late answer is dropped");
        var se = events.Where(e => e.Name == "help_search").ToList();
        check(se.Count == 1 && se[0].PropsJson.Contains("\"category\":\"purchases\"") && !se[0].PropsJson.Contains("こいん") && !se[0].PropsJson.Contains("コイン"), "search: help_search has category / length / count, never the query");
        await m.SearchAsync("なし");
        check(m.Message == HelpCenterModel.NoResults, "search: no result → the contact hint");

        // vote
        await m.OpenArticleAsync("buy_coins", "search");
        check(await m.VoteAsync(true) && m.Vote == true && api.Calls.Contains("vote:buy_coins:True") && m.Message == HelpCenterModel.ThanksText, "vote: sent for the open article");

        // the form: limits, history rows, diagnostics
        await m.LoadInquiriesAsync();
        var d = m.StartInquiry(InquiryCategories.PurchaseMissing);
        check(m.OffersHistory, "form: a purchase category offers the history rows first");
        check(m.ToggleRef("P-1A2B3C4D") && m.ToggleRef("C-120") && !m.ToggleRef("G-3") && m.Message == HelpCenterModel.AttachLimitText, "form: up to AttachMax rows");
        check(m.ToggleRef("C-120") && d.Refs.Count == 1, "form: tapping a row again removes it");
        m.SetDescription("短い");
        check(m.Problem() == HelpCenterModel.TooShortText && m.Counter == "2 / 1000", "form: too short, with the counter");
        m.SetDescription("コイン1,020を買ったのに増えていません。確認をお願いします。");
        check(m.Problem() == null, "form: ready");
        var rows = m.DiagnosticsRows();
        check(rows.Count == 4 && rows[0].Value == "1.4.0" && rows[1].Value == "iOS" && rows.All(r => !r.Value.Contains("@")), "form: diagnostics rows — app version, platform, player id, race ids (nothing personal)");

        // offline keeps the draft and sends nothing
        online = false;
        check(await m.SubmitAsync() == null && m.Message == HelpCenterModel.OfflineDraftText && m.Draft != null && !api.Calls.Any(c => c.StartsWith("submit")), "offline: nothing sent, the draft is kept");
        online = true;

        // a timeout, then the retry uses the same key
        api.FailSubmits = 1;
        check(await m.SubmitAsync() == null && m.Draft != null, "timeout: the draft stays");
        var t = await m.SubmitAsync();
        check(t != null && api.Keys.Count == 2 && api.Keys[0] == api.Keys[1] && api.Keys[0] == "c:help:1", "retry: the same idempotency key (one inquiry on the server)");
        check(api.Calls.Contains("submit:purchase_missing:1:ios:1.4.0") && m.Draft == null && m.Message == HelpCenterModel.SentText, "sent: category, rows, platform and version; the draft is cleared");
        m.StartInquiry(InquiryCategories.Bug);
        m.SetDescription("レースの途中で止まりました。毎回同じ場所です。");
        await m.SubmitAsync();
        check(api.Keys.Last() == "c:help:2", "a new form gets a new key");

        // my inquiries: an answered ticket is marked read when opened
        api.Answered = true;
        await m.LoadInquiriesAsync();
        check(m.UnreadReplies == 1 && m.BadgeText == "1", "list: the unread replies feed the badge");
        var q = await m.OpenInquiryAsync("q_1");
        check(q.Messages[0].From == "support" && api.Calls.Contains("read:q_1") && m.UnreadReplies == 0 && !m.Inquiries.Items[0].Unread, "detail: the reply is shown and marked read");

        // offline screen
        online = false;
        var m2 = new HelpCenterModel(api, "1.4.0", "android", () => false);
        check(!await m2.OpenAsync() && m2.Message == HelpCenterModel.OfflineText, "offline: the help screen says it is available online");
    }
}
