using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-HELP-001..024 (contracts/protocol.md §48, docs/handoff-codex-round17-help-center.md): ヘルプセンター, the game layer.
    // Pure C#: Codex's screens bind to the public fields. Display + inquiries only — nothing here moves coins or items.
    // The inquiry text and support replies are a person's words: never translated (InquiryText / MessageText).

    /// <summary>The server calls the help center needs (ApiClient in the app, a fake in the checks).</summary>
    public interface IHelpApi
    {
        Task<HelpIndex> GetHelpAsync(CancellationToken ct = default);
        Task<HelpArticle> GetHelpArticleAsync(string articleId, CancellationToken ct = default);
        Task<HelpSearchResult> SearchHelpAsync(string q, string category = null, int limit = 20, CancellationToken ct = default);
        Task<HelpFeedbackResult> SendHelpFeedbackAsync(string articleId, bool helpful, CancellationToken ct = default);
        Task<InquiryList> GetInquiriesAsync(CancellationToken ct = default);
        Task<Inquiry> GetInquiryAsync(string ticketId, CancellationToken ct = default);
        Task<Inquiry> SubmitInquiryAsync(InquiryDraft draft, string idempotencyKey = null, CancellationToken ct = default);
        Task<InquiryReadResult> MarkInquiryReadAsync(string ticketId, CancellationToken ct = default);
    }

    /// <summary><see cref="IHelpApi"/> over the real client.</summary>
    public sealed class ApiHelp : IHelpApi
    {
        private readonly ApiClient _api;
        public ApiHelp(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<HelpIndex> GetHelpAsync(CancellationToken ct = default) => _api.GetHelpAsync(ct);
        public Task<HelpArticle> GetHelpArticleAsync(string articleId, CancellationToken ct = default) => _api.GetHelpArticleAsync(articleId, ct);
        public Task<HelpSearchResult> SearchHelpAsync(string q, string category = null, int limit = 20, CancellationToken ct = default) => _api.SearchHelpAsync(q, category, limit, ct);
        public Task<HelpFeedbackResult> SendHelpFeedbackAsync(string articleId, bool helpful, CancellationToken ct = default) => _api.SendHelpFeedbackAsync(articleId, helpful, ct);
        public Task<InquiryList> GetInquiriesAsync(CancellationToken ct = default) => _api.GetInquiriesAsync(ct);
        public Task<Inquiry> GetInquiryAsync(string ticketId, CancellationToken ct = default) => _api.GetInquiryAsync(ticketId, ct);
        public Task<Inquiry> SubmitInquiryAsync(InquiryDraft draft, string idempotencyKey = null, CancellationToken ct = default) => _api.SubmitInquiryAsync(draft, idempotencyKey, ct);
        public Task<InquiryReadResult> MarkInquiryReadAsync(string ticketId, CancellationToken ct = default) => _api.MarkInquiryReadAsync(ticketId, ct);
    }

    /// <summary>
    /// The help center: categories, articles, search, contextual help, "was this helpful", the inquiry form and my inquiries.
    /// Rules the model keeps:
    ///  - articles and the index come from the server in the request's language (Japanese or English); numbers inside are data;
    ///  - search: one request at a time per query (a late answer for an older query is dropped); help_search carries the folded
    ///    length, the category and the count — never the query;
    ///  - help_article_view once per opening, with where it was opened from (list / search / context / link / related);
    ///  - the form keeps one idempotency key until the server accepted it (a retry after a timeout never sends a second inquiry);
    ///    offline it keeps the draft and sends nothing;
    ///  - opening an answered inquiry marks its replies read (the settings badge follows).
    /// </summary>
    public sealed class HelpCenterModel
    {
        public const string Title = "ヘルプ・お問い合わせ";
        public const string OfflineText = "ヘルプはオンラインで見られます";
        public const string SearchHint = "キーワードで探す（ひらがな・カタカナどちらでも）";
        public const string NoResults = "見つかりませんでした。言葉を変えるか、問い合わせてください";
        public const string HelpfulQuestion = "この記事は役に立ちましたか？";
        public const string HelpfulYes = "役に立った";
        public const string HelpfulNo = "役に立たなかった";
        public const string ThanksText = "ご意見ありがとうございます";
        public const string ContactCta = "問い合わせる";
        public const string MyInquiriesTitle = "自分の問い合わせ";
        public const string SentText = "問い合わせを受け付けました。返信はアクティビティでお知らせします";
        public const string OfflineDraftText = "オフラインのため送信していません。入力した内容は残っています";
        public const string TooShortText = "内容をもう少し詳しく書いてください";
        public const string TooLongText = "内容が長すぎます";
        public const string LimitText = "いまは送信できません。返信をお待ちいただくか、時間をおいてください";
        public const string AttachLimitText = "添えられる記録の数を超えています";
        public const string EmptyInquiriesText = "まだ問い合わせはありません";
        public const string SupportLabel = "運営からの返信";
        public static readonly IReadOnlyDictionary<string, string> CategoryIcons = new Dictionary<string, string>
        {
            [HelpCategories.GettingStarted] = "start", [HelpCategories.Races] = "race", [HelpCategories.Horses] = "horse", [HelpCategories.Scout] = "scout",
            [HelpCategories.Purchases] = "coin", [HelpCategories.Account] = "account", [HelpCategories.Deletion] = "delete", [HelpCategories.Accessibility] = "a11y",
        };

        private readonly IHelpApi _api;
        private readonly Func<bool> _online;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;
        private readonly Func<string> _newKey;
        private readonly string _appVersion, _platform;
        private int _searchGen;
        private string _pendingKey;

        public HelpCenterModel(IHelpApi api, string appVersion, string platform, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null, Func<string> newKey = null)
        {
            _api = api;
            _appVersion = string.IsNullOrEmpty(appVersion) ? "0" : appVersion;
            _platform = platform == "ios" || platform == "android" ? platform : "editor";
            _online = online ?? (() => true);
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _newKey = newKey ?? (() => "c:help:" + Guid.NewGuid().ToString("N"));
        }

        public HelpIndex Index { get; private set; }
        public HelpArticle Article { get; private set; }
        /// <summary>The vote sent for the open article this session (null = not voted).</summary>
        public bool? Vote { get; private set; }
        public HelpSearchResult Results { get; private set; }
        public string Query { get; private set; } = "";
        public string Category { get; private set; }
        public InquiryList Inquiries { get; private set; }
        public Inquiry Inquiry { get; private set; }
        public string Message { get; private set; }
        public bool Loading { get; private set; }
        /// <summary>The settings badge (GET /v1/player `help.unreadReplies`, then each list).</summary>
        public int UnreadReplies { get; private set; }
        public string BadgeText => UnreadReplies <= 0 ? null : UnreadReplies > 9 ? "9+" : UnreadReplies.ToString(CultureInfo.InvariantCulture);

        // ---- the form
        public InquiryDraft Draft { get; private set; }
        public bool Sending { get; private set; }

        public void SetBadge(HelpBadge b) { if (b != null) UnreadReplies = Math.Max(0, b.UnreadReplies); }

        /// <summary>Loads the index (categories, titles, contexts, the form's settings). Offline: <see cref="OfflineText"/>.</summary>
        public async Task<bool> OpenAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!_online() || _api == null) { Message = OfflineText; return false; }
            try { Index = await _api.GetHelpAsync(ct); return true; }
            catch (ApiException e) { Message = UxText.For(e); return false; }
        }

        /// <summary>Articles of one category (master order).</summary>
        public IReadOnlyList<HelpArticleRef> ArticlesIn(string category) => Index == null ? new HelpArticleRef[0] : Index.Articles.Where(a => a.Category == category).ToList();

        /// <summary>Titles matching the query with the same fold as the server (instant filtering while typing; the server search adds keywords and bodies).</summary>
        public IReadOnlyList<HelpArticleRef> TitleMatches(string q)
        {
            var words = HelpText.Words(q);
            if (Index == null || words.Length == 0) return new HelpArticleRef[0];
            return Index.Articles.Where(a => { var t = HelpText.Fold(a.Title); return words.All(w => t.Contains(w)); }).ToList();
        }

        /// <summary>Opens an article: help_article_view once (source = list | search | context | link | related).</summary>
        public async Task<HelpArticle> OpenArticleAsync(string articleId, string source, CancellationToken ct = default)
        {
            Message = null;
            if (!_online() || _api == null) { Message = OfflineText; return null; }
            if (!ApiClient.IsHelpArticleId(articleId)) return null;
            Loading = true;
            try
            {
                Article = await _api.GetHelpArticleAsync(articleId, ct);
                Vote = null;
                if (Array.IndexOf(AnalyticsEvent.HelpViewSources, source) >= 0) _track?.Invoke(AnalyticsEvent.HelpArticleView(_clock(), articleId, source));
                return Article;
            }
            catch (ApiException e) { Message = UxText.For(e); return null; }
            finally { Loading = false; }
        }

        /// <summary>REQ-HELP-008: the article for a screen (odds → pity, coin shortfall → buying coins…). Loads the index first when needed.</summary>
        public async Task<HelpArticle> OpenContextAsync(string context, CancellationToken ct = default)
        {
            if (Index == null && !await OpenAsync(ct)) return null;
            if (Index == null || context == null || !Index.Contexts.TryGetValue(context, out var id)) return null;
            return await OpenArticleAsync(id, "context", ct);
        }

        /// <summary>The article a context leads to (null when unknown or not loaded) — for a "?" button's target without opening it.</summary>
        public string ContextArticle(string context) => Index != null && context != null && Index.Contexts.TryGetValue(context, out var id) ? id : null;

        /// <summary>REQ-HELP-006: server search (category null = all). A late answer for an older query is dropped.</summary>
        public async Task SearchAsync(string q, string category = null, CancellationToken ct = default)
        {
            var gen = ++_searchGen;
            Query = q ?? ""; Category = category; Message = null;
            if (HelpText.Words(Query).Length == 0) { Results = null; return; }
            if (!_online() || _api == null) { Message = OfflineText; return; }
            try
            {
                var r = await _api.SearchHelpAsync(Query.Trim(), category, 20, ct);
                if (gen != _searchGen) return;
                Results = r;
                if (r.Items.Count == 0) Message = NoResults;
                _track?.Invoke(AnalyticsEvent.HelpSearch(_clock(), HelpText.KpiLength(Query), category, r.Total));
            }
            catch (ApiException e) { if (gen == _searchGen) Message = UxText.For(e); }
        }

        /// <summary>REQ-HELP-007: "was this helpful" for the open article (sending the same answer again is a no-op on the server).</summary>
        public async Task<bool> VoteAsync(bool helpful, CancellationToken ct = default)
        {
            if (Article == null || !_online() || _api == null) return false;
            try { await _api.SendHelpFeedbackAsync(Article.Id, helpful, ct); Vote = helpful; Message = ThanksText; return true; }
            catch (ApiException e) { Message = UxText.For(e); return false; }
        }

        // ------------------------------------------------------------------------------------------- inquiry form

        /// <summary>Starts (or keeps) a draft. A category whose form offers history rows first shows the picker.</summary>
        public InquiryDraft StartInquiry(string category = null)
        {
            if (Draft == null) { Draft = new InquiryDraft { AppVersion = _appVersion, Platform = _platform }; _pendingKey = null; }
            if (category != null && Array.IndexOf(InquiryCategories.All, category) >= 0) Draft.Category = category;
            return Draft;
        }
        public void DiscardInquiry() { Draft = null; _pendingKey = null; }

        public bool OffersHistory => Draft != null && (Index?.InquiryCategories.FirstOrDefault(c => c.Id == Draft.Category)?.History ?? Array.IndexOf(new[] { "purchase_missing", "refund", "coins", "gacha" }, Draft.Category) >= 0);
        public int AttachMax => Index?.AttachMax ?? 10;
        public int DescriptionMin => Index?.DescriptionMin ?? 10;
        public int DescriptionMax => Index?.DescriptionMax ?? 1000;

        /// <summary>Adds or removes one §33 reference (P-/C-/G-) from the draft; false = over the limit.</summary>
        public bool ToggleRef(string reference)
        {
            StartInquiry();
            if (string.IsNullOrEmpty(reference)) return false;
            if (Draft.Refs.Remove(reference)) return true;
            if (Draft.Refs.Count >= AttachMax) { Message = AttachLimitText; return false; }
            Draft.Refs.Add(reference);
            return true;
        }

        public void SetDescription(string text) { StartInquiry().Description = text ?? ""; }

        /// <summary>"12 / 1000" under the text box.</summary>
        public string Counter => (Draft == null ? 0 : CharCount(Draft.Description.Trim())).ToString(CultureInfo.InvariantCulture) + " / " + DescriptionMax.ToString(CultureInfo.InvariantCulture);
        private static int CharCount(string s) { var e = StringInfo.GetTextElementEnumerator(s ?? ""); int n = 0; while (e.MoveNext()) n++; return n; }

        /// <summary>Why the form cannot be sent yet (null = it can).</summary>
        public string Problem()
        {
            if (Draft == null) return TooShortText;
            int n = CharCount(Draft.Description.Trim());
            if (n < DescriptionMin) return TooShortText;
            if (n > DescriptionMax) return TooLongText;
            if (Draft.Refs.Count > AttachMax) return AttachLimitText;
            if (Inquiries != null && !Inquiries.Limits.CanSend) return LimitText;
            return null;
        }

        /// <summary>What the form says is attached automatically (REQ-HELP-011), as label / value rows (show Loc.T of both); the server's note goes under them.</summary>
        public IReadOnlyList<(string Label, string Value)> DiagnosticsRows() => new List<(string, string)>
        {
            ("アプリの版", _appVersion),
            ("端末の種類", _platform == "ios" ? "iOS" : _platform == "android" ? "Android" : "Editor"),
            ("プレイヤーID", "自動で添えます"),
            ("直近のレースID", "最大3件・自動で添えます"),
        };

        /// <summary>
        /// Sends the draft with one idempotency key kept until the server accepted it (a retry after a timeout returns the same
        /// inquiry). Offline: nothing is sent and the draft stays.
        /// </summary>
        public async Task<Inquiry> SubmitAsync(CancellationToken ct = default)
        {
            if (Sending || Draft == null) return null;
            var problem = Problem();
            if (problem != null) { Message = problem; return null; }
            if (!_online() || _api == null) { Message = OfflineDraftText; return null; }
            _pendingKey ??= _newKey();
            Sending = true;
            try
            {
                var t = await _api.SubmitInquiryAsync(Draft, _pendingKey, ct);
                Draft = null; _pendingKey = null;
                Inquiry = t;
                Message = SentText;
                await LoadInquiriesAsync(ct);
                return t;
            }
            catch (RateLimitedException) { Message = LimitText; return null; }
            catch (ApiException e) { Message = UxText.For(e); return null; }
            finally { Sending = false; }
        }

        // ------------------------------------------------------------------------------------------- my inquiries

        public async Task LoadInquiriesAsync(CancellationToken ct = default)
        {
            if (!_online() || _api == null) { Message = OfflineText; return; }
            try
            {
                Inquiries = await _api.GetInquiriesAsync(ct);
                UnreadReplies = Inquiries.Unread;
            }
            catch (ApiException e) { Message = UxText.For(e); }
        }

        /// <summary>Opens one inquiry; unread support replies are marked read (the badge follows).</summary>
        public async Task<Inquiry> OpenInquiryAsync(string ticketId, CancellationToken ct = default)
        {
            if (!_online() || _api == null) { Message = OfflineText; return null; }
            try
            {
                Inquiry = await _api.GetInquiryAsync(ticketId, ct);
                if (Inquiry.Unread)
                {
                    try
                    {
                        var r = await _api.MarkInquiryReadAsync(ticketId, ct);
                        UnreadReplies = r.UnreadTotal;
                        var row = Inquiries?.Items.FirstOrDefault(x => x.TicketId == ticketId);
                        if (row != null) row.Unread = false;
                    }
                    catch (ApiException) { /* marked on the next opening */ }
                }
                return Inquiry;
            }
            catch (ApiException e) { Message = UxText.For(e); return null; }
        }

        public static string When(long at) => DateTimeOffset.FromUnixTimeMilliseconds(at).ToOffset(TimeSpan.FromHours(9)).ToString("MM/dd HH:mm", CultureInfo.InvariantCulture);
    }
}
