using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-HELP-001..024: ヘルプセンター (server/src/domain/help.ts, contracts/protocol.md §48).
    // FAQ articles (the server answers in the request's language: Japanese or English, side by side in master/help.json),
    // search, "was this helpful", contextual links from screens, and inquiries with their status and support replies.
    // Display + inquiries only: nothing here moves coins or items. The inquiry text and support replies are a person's words
    // and are never translated (InquiryText / MessageText).

    /// <summary>GET /v1/player `help`: the settings badge.</summary>
    public sealed class HelpBadge
    {
        public int UnreadReplies;
        internal static HelpBadge Parse(JsonNode o) => o == null ? new HelpBadge() : new HelpBadge { UnreadReplies = J.Int(o, "unreadReplies") };
    }

    public static class HelpCategories
    {
        public const string GettingStarted = "getting_started", Races = "races", Horses = "horses", Scout = "scout", Purchases = "purchases",
            Account = "account", Deletion = "deletion", Accessibility = "accessibility";
        public static readonly string[] All = { GettingStarted, Races, Horses, Scout, Purchases, Account, Deletion, Accessibility };
    }

    /// <summary>Screens that deep-link to an article (`contexts`, REQ-HELP-008).</summary>
    public static class HelpContexts
    {
        public const string GachaOdds = "gacha_odds", CoinShortfall = "coin_shortfall", Purchase = "purchase", RaceWhip = "race_whip", RaceResult = "race_result",
            Training = "training", Breeding = "breeding", History = "history", GiftBox = "gift_box", AccountLink = "account_link", Deletion = "deletion", Accessibility = "accessibility",
            /// <summary>Round 18 integration: settings › privacy (the data export article, §51).</summary>
            Privacy = "privacy",
            Storage = "storage", // §56: the storage screen's ? link
            /// <summary>R19 integration: the practice setup (§50) → practice_races.</summary>
            Practice = "practice",
            /// <summary>Round 20: settings › privacy › ads and analytics, and the pre-prompt sheet (§58).</summary>
            PrivacyChoices = "privacy_choices",
            /// <summary>Round 20: settings › notifications (the device reminders article, §61).</summary>
            Notifications = "notifications",
            /// <summary>Round 21 (§65): the calendar's ? link → calendar.</summary>
            Calendar = "calendar";
        public static readonly string[] All = { GachaOdds, CoinShortfall, Purchase, RaceWhip, RaceResult, Training, Breeding, History, GiftBox, AccountLink, Deletion, Accessibility, Privacy, Storage, Practice, PrivacyChoices, Notifications, Calendar };
    }

    /// <summary>Inquiry categories (the first four are the §33 ticket topics).</summary>
    public static class InquiryCategories
    {
        public const string PurchaseMissing = "purchase_missing", Refund = "refund", Coins = "coins", Gacha = "gacha", Race = "race", Account = "account",
            Deletion = "deletion", Accessibility = "accessibility", Bug = "bug", Other = "other";
        public static readonly string[] All = { PurchaseMissing, Refund, Coins, Gacha, Race, Account, Deletion, Accessibility, Bug, Other };
    }

    public static class InquiryStatuses
    {
        public const string Received = "received", Answered = "answered", Closed = "closed";
    }

    public sealed class HelpCategoryInfo
    {
        public string Id, Title, Icon;
        public int Count;
        internal static HelpCategoryInfo Parse(JsonNode o) => new HelpCategoryInfo { Id = J.Str(o, "id"), Title = J.Str(o, "title"), Icon = J.Str(o, "icon"), Count = J.Int(o, "count") };
    }

    public sealed class HelpArticleRef
    {
        public string Id, Category, Title, Snippet;
        internal static HelpArticleRef Parse(JsonNode o) => new HelpArticleRef { Id = J.Str(o, "id"), Category = J.Str(o, "category"), Title = J.Str(o, "title"), Snippet = J.Str(o, "snippet") };
    }

    public sealed class InquiryCategoryInfo
    {
        public string Id, Title;
        /// <summary>The form offers the §33 history rows first for this category (any category may attach them).</summary>
        public bool History;
        internal static InquiryCategoryInfo Parse(JsonNode o) => new InquiryCategoryInfo { Id = J.Str(o, "id"), Title = J.Str(o, "title"), History = J.Bool(o, "history") };
    }

    /// <summary>GET /v1/help: the index (categories, article titles, screen contexts, the inquiry form's settings).</summary>
    public sealed class HelpIndex
    {
        public bool Enabled;
        public int Version;
        public string Lang, SupportSite;
        public List<HelpCategoryInfo> Categories = new List<HelpCategoryInfo>();
        public List<HelpArticleRef> Articles = new List<HelpArticleRef>();
        public Dictionary<string, string> Contexts = new Dictionary<string, string>();
        public List<InquiryCategoryInfo> InquiryCategories = new List<InquiryCategoryInfo>();
        public int DescriptionMin = 10, DescriptionMax = 1000, AttachMax = 10;
        /// <summary>What is attached automatically and what is never sent (show it on the form, REQ-HELP-011).</summary>
        public string DiagnosticsNote, PrivacyNote;

        internal static HelpIndex Parse(JsonNode o)
        {
            var q = J.Opt(o, "inquiry");
            return new HelpIndex
            {
                Enabled = J.Bool(o, "enabled"), Version = J.Int(o, "version"), Lang = J.Str(o, "lang"), SupportSite = J.Str(o, "supportSite"),
                Categories = J.List(o, "categories", HelpCategoryInfo.Parse), Articles = J.List(o, "articles", HelpArticleRef.Parse),
                Contexts = J.Map(o, "contexts", v => v.AsString()),
                InquiryCategories = J.List(q, "categories", InquiryCategoryInfo.Parse),
                DescriptionMin = J.Int(q, "descriptionMin", 10), DescriptionMax = J.Int(q, "descriptionMax", 1000), AttachMax = J.Int(q, "attachMax", 10),
                DiagnosticsNote = J.Str(q, "diagnosticsNote"), PrivacyNote = J.Str(q, "privacyNote"),
            };
        }
    }

    /// <summary>A link under an article: an in-app screen, a legal page, another article or the official support site.</summary>
    public sealed class HelpLink
    {
        public const string Screen = "screen", Legal = "legal", Article = "article", Url = "url";
        public string Type, Label, ScreenId, Doc, ArticleId, Href;
        internal static HelpLink Parse(JsonNode o) => new HelpLink
        {
            Type = J.Str(o, "type"), Label = J.Str(o, "label"), ScreenId = J.Str(o, "screen"), Doc = J.Str(o, "doc"), ArticleId = J.Str(o, "articleId"), Href = J.Str(o, "url"),
        };
    }

    /// <summary>GET /v1/help/articles/:id — the body with every number filled from data (paragraphs: blank lines; bullets: 「・」 / "•").</summary>
    public sealed class HelpArticle
    {
        public string Id, Category, CategoryTitle, Title, Body;
        public int Version;
        public List<HelpLink> Links = new List<HelpLink>();
        public List<HelpArticleRef> Related = new List<HelpArticleRef>();
        internal static HelpArticle Parse(JsonNode o) => new HelpArticle
        {
            Id = J.Str(o, "id"), Category = J.Str(o, "category"), CategoryTitle = J.Str(o, "categoryTitle"), Title = J.Str(o, "title"), Body = J.Str(o, "body"),
            Version = J.Int(o, "version"), Links = J.List(o, "links", HelpLink.Parse), Related = J.List(o, "related", HelpArticleRef.Parse),
        };

        /// <summary>The body as paragraphs; a bullet line keeps its mark.</summary>
        public string[] Paragraphs() => (Body ?? "").Replace("\r", "").Split(new[] { "\n\n" }, StringSplitOptions.RemoveEmptyEntries);
    }

    public sealed class HelpSearchResult
    {
        public List<HelpArticleRef> Items = new List<HelpArticleRef>();
        public int Total;
        /// <summary>The normalised query length (all the server echoes; the query is never stored).</summary>
        public int QueryLength;
        internal static HelpSearchResult Parse(JsonNode o) => new HelpSearchResult { Items = J.List(o, "items", HelpArticleRef.Parse), Total = J.Int(o, "total"), QueryLength = J.Int(J.Opt(o, "query"), "length") };
    }

    public sealed class HelpFeedbackResult
    {
        public string ArticleId;
        public bool Helpful, Changed;
        internal static HelpFeedbackResult Parse(JsonNode o) => new HelpFeedbackResult { ArticleId = J.Str(o, "articleId"), Helpful = J.Bool(o, "helpful"), Changed = J.Bool(o, "changed") };
    }

    public sealed class InquiryAttachment
    {
        public string Ref, Kind, Title, Detail;
        public long At;
        internal static InquiryAttachment Parse(JsonNode o) => new InquiryAttachment { Ref = J.Str(o, "ref"), Kind = J.Str(o, "kind"), At = J.Long(o, "at"), Title = J.Str(o, "title"), Detail = J.Str(o, "detail") };
    }

    public sealed class InquiryMessage
    {
        /// <summary>"support" (an operator's reply) or "player".</summary>
        public string From;
        /// <summary>A person's words: never translated.</summary>
        public string MessageText;
        public long At;
        internal static InquiryMessage Parse(JsonNode o) => new InquiryMessage { From = J.Str(o, "from"), MessageText = J.Str(o, "messageText"), At = J.Long(o, "at") };
    }

    public sealed class InquiryDiagnostics
    {
        public string AppVersion, Platform, PlayerId;
        public string[] LastRaceIds = new string[0];
        internal static InquiryDiagnostics Parse(JsonNode o) => new InquiryDiagnostics { AppVersion = J.Str(o, "appVersion"), Platform = J.Str(o, "platform"), PlayerId = J.Str(o, "playerId"), LastRaceIds = J.Strs(o, "lastRaceIds") };
    }

    /// <summary>One inquiry (list row: no text, attachments or messages).</summary>
    public sealed class Inquiry
    {
        public string TicketId, Category, CategoryTitle, Status, StatusText, Lang;
        public long CreatedAt, UpdatedAt;
        public bool Unread;
        /// <summary>What the player sent (after personal data was replaced). Never translated.</summary>
        public string InquiryText;
        public int Redacted;
        public List<InquiryAttachment> Attachments = new List<InquiryAttachment>();
        public InquiryDiagnostics Diagnostics;
        public List<InquiryMessage> Messages = new List<InquiryMessage>();
        internal static Inquiry Parse(JsonNode o) => new Inquiry
        {
            TicketId = J.Str(o, "ticketId"), Category = J.Str(o, "category"), CategoryTitle = J.Str(o, "categoryTitle"), Status = J.Str(o, "status"), StatusText = J.Str(o, "statusText"),
            Lang = J.Str(o, "lang"), CreatedAt = J.Long(o, "createdAt"), UpdatedAt = J.Long(o, "updatedAt"), Unread = J.Bool(o, "unread"),
            InquiryText = J.Str(o, "inquiryText"), Redacted = J.Int(o, "redacted"), Attachments = J.List(o, "attachments", InquiryAttachment.Parse),
            Diagnostics = J.Opt(o, "diagnostics") == null ? null : InquiryDiagnostics.Parse(J.Opt(o, "diagnostics")), Messages = J.List(o, "messages", InquiryMessage.Parse),
        };
    }

    public sealed class InquiryLimits
    {
        public int OpenMax, Open, PerDay, Today;
        /// <summary>When the next inquiry can be sent (null = now, or after an answer when OpenMax is reached).</summary>
        public long? RetryAt;
        public bool CanSend => Open < OpenMax && Today < PerDay;
        internal static InquiryLimits Parse(JsonNode o) => new InquiryLimits { OpenMax = J.Int(o, "openMax"), Open = J.Int(o, "open"), PerDay = J.Int(o, "perDay"), Today = J.Int(o, "today"), RetryAt = J.LongN(o, "retryAt") };
    }

    public sealed class InquiryList
    {
        public List<Inquiry> Items = new List<Inquiry>();
        public int Unread;
        public InquiryLimits Limits = new InquiryLimits();
        internal static InquiryList Parse(JsonNode o) => new InquiryList { Items = J.List(o, "items", Inquiry.Parse), Unread = J.Int(o, "unread"), Limits = InquiryLimits.Parse(J.Opt(o, "limits")) };
    }

    public sealed class InquiryReadResult
    {
        public string TicketId;
        public int UnreadTotal;
        internal static InquiryReadResult Parse(JsonNode o) => new InquiryReadResult { TicketId = J.Str(o, "ticketId"), UnreadTotal = J.Int(o, "unreadTotal") };
    }

    /// <summary>The inquiry form (POST /v1/help/inquiries). Diagnostics carry only the app version and the platform; the server adds the rest.</summary>
    public sealed class InquiryDraft
    {
        public string Category = InquiryCategories.Other;
        public string Description = "";
        public List<string> Refs = new List<string>();
        public string AppVersion, Platform;

        internal JsonNode ToJson()
        {
            var refs = JsonNode.Arr();
            foreach (var r in Refs) refs.Add(JsonNode.Str(r));
            return JsonNode.Obj().Set("category", Category).Set("description", Description ?? "").Set("refs", refs)
                .Set("diagnostics", JsonNode.Obj().Set("appVersion", AppVersion ?? "0").Set("platform", Platform ?? "editor"));
        }
    }

    /// <summary>
    /// REQ-HELP-006: the search fold, the same as the server's helpFold (help.ts): NFKC, lower-case Latin, whitespace removed,
    /// hiragana → katakana, long-vowel marks unified then removed, small kana → large, ヴ → ブ.
    /// </summary>
    public static class HelpText
    {
        private const string Small = "ァィゥェォッャュョヮヵヶ";
        private const string HalfKana = "｡｢｣､･ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ";
        private const string FullKana = "。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン";

        /// <summary>
        /// NFKC for what search needs, without depending on the platform's normalisation tables (invariant-globalization
        /// builds and IL2CPP stripping): half-width katakana (with ﾞ ﾟ) → full-width, full-width ASCII → ASCII, the
        /// ideographic space → a space; then the platform's NFKC when it has one (the same result for these characters).
        /// </summary>
        public static string Nfkc(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length);
            for (int k = 0; k < s.Length; k++)
            {
                char c = s[k];
                int h = HalfKana.IndexOf(c);
                if (h >= 0)
                {
                    char f = FullKana[h];
                    char next = k + 1 < s.Length ? s[k + 1] : '\0';
                    if (next == 'ﾞ' && (f == 'ウ' || (f >= 'カ' && f <= 'ト') || (f >= 'ハ' && f <= 'ホ'))) { f = f == 'ウ' ? 'ヴ' : (char)(f + 1); k++; }
                    else if (next == 'ﾟ' && f >= 'ハ' && f <= 'ホ') { f = (char)(f + 2); k++; }
                    sb.Append(f);
                }
                else if (c == 'ﾞ') sb.Append('\u3099');
                else if (c == 'ﾟ') sb.Append('\u309A');
                else if (c >= '\uFF01' && c <= '\uFF5E') sb.Append((char)(c - 0xFEE0));
                else if (c == '\u3000') sb.Append(' ');
                else sb.Append(c);
            }
            var r = sb.ToString();
            try { r = r.Normalize(NormalizationForm.FormKC); } catch (Exception) { /* no tables: the mapping above covers search */ }
            return r;
        }
        private const string Large = "アイウエオツヤユヨワカケ";

        public static string Fold(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var n = Nfkc(Nfkc(s).ToLowerInvariant());
            var sb = new StringBuilder(n.Length);
            foreach (var ch0 in n)
            {
                var ch = ch0;
                if (char.IsWhiteSpace(ch)) continue;
                if (ch >= 'ぁ' && ch <= 'ゖ') ch = (char)(ch + 0x60);
                if ("-‐‑‒–—―−ｰ～〜ー".IndexOf(ch) >= 0) continue; // long-vowel marks (unified to ー, then removed)
                int i = Small.IndexOf(ch);
                if (i >= 0) ch = Large[i];
                if (ch == 'ヴ') ch = 'ブ';
                sb.Append(ch);
            }
            return sb.ToString();
        }

        /// <summary>The query split into folded words (what the server matches; blank → none).</summary>
        public static string[] Words(string q) => Nfkc(q ?? "").Split(new[] { ' ', '\t', '\n', '\r', '　' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(Fold).Where(w => w.Length > 0).ToArray();

        /// <summary>The help_search KPI length (the folded words joined, 1..64).</summary>
        public static int KpiLength(string q) => Math.Max(1, Math.Min(64, string.Concat(Words(q)).Length));
    }

    public sealed partial class ApiClient
    {
        private static readonly System.Text.RegularExpressions.Regex ArticleIdRe = new System.Text.RegularExpressions.Regex("^[a-z0-9_]{2,40}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        private static readonly System.Text.RegularExpressions.Regex TicketIdRe = new System.Text.RegularExpressions.Regex("^q_[0-9]{1,9}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        /// <summary>A well-formed article id (^[a-z0-9_]{2,40}$).</summary>
        public static bool IsHelpArticleId(string id) => id != null && ArticleIdRe.IsMatch(id);
        public static bool IsInquiryId(string id) => id != null && TicketIdRe.IsMatch(id);

        /// <summary>REQ-HELP-001: the help index.</summary>
        public Task<HelpIndex> GetHelpAsync(CancellationToken ct = default) => Call("GET", "/v1/help", null, true, null, true, HelpIndex.Parse, ct);

        /// <summary>REQ-HELP-001/005: one article (numbers filled from data on the server).</summary>
        public Task<HelpArticle> GetHelpArticleAsync(string articleId, CancellationToken ct = default)
        {
            if (!IsHelpArticleId(articleId)) throw new ArgumentException("bad article id", nameof(articleId));
            return Call("GET", "/v1/help/articles/" + articleId, null, true, null, true, HelpArticle.Parse, ct);
        }

        /// <summary>REQ-HELP-006: search (category null = all).</summary>
        public Task<HelpSearchResult> SearchHelpAsync(string q, string category = null, int limit = 20, CancellationToken ct = default)
        {
            if (string.IsNullOrWhiteSpace(q)) throw new ArgumentException("query required", nameof(q));
            if (category != null && Array.IndexOf(HelpCategories.All, category) < 0) throw new ArgumentException("unknown category " + category);
            var path = "/v1/help/search?q=" + Uri.EscapeDataString(q.Trim()) + (category != null ? "&category=" + category : "") + "&limit=" + limit.ToString(CultureInfo.InvariantCulture);
            return Call("GET", path, null, true, null, true, HelpSearchResult.Parse, ct);
        }

        /// <summary>REQ-HELP-007: "was this helpful" (one vote per article; sending the same value again changes nothing).</summary>
        public Task<HelpFeedbackResult> SendHelpFeedbackAsync(string articleId, bool helpful, CancellationToken ct = default)
        {
            if (!IsHelpArticleId(articleId)) throw new ArgumentException("bad article id", nameof(articleId));
            return Call("POST", "/v1/help/articles/" + articleId + "/feedback", JsonNode.Obj().Set("helpful", helpful), true, null, true, HelpFeedbackResult.Parse, ct);
        }

        /// <summary>REQ-HELP-014: the player's inquiries, newest first.</summary>
        public Task<InquiryList> GetInquiriesAsync(CancellationToken ct = default) => Call("GET", "/v1/help/inquiries", null, true, null, true, InquiryList.Parse, ct);

        public Task<Inquiry> GetInquiryAsync(string ticketId, CancellationToken ct = default)
        {
            if (!IsInquiryId(ticketId)) throw new ArgumentException("bad ticket id", nameof(ticketId));
            return Call("GET", "/v1/help/inquiries/" + ticketId, null, true, null, true, Inquiry.Parse, ct);
        }

        /// <summary>
        /// REQ-HELP-012: send an inquiry. Pass the same key when retrying the same form (the server returns the first answer);
        /// a new form gets a new key (null = one is made here).
        /// </summary>
        public Task<Inquiry> SubmitInquiryAsync(InquiryDraft draft, string idempotencyKey = null, CancellationToken ct = default)
        {
            if (draft == null) throw new ArgumentNullException(nameof(draft));
            if (Array.IndexOf(InquiryCategories.All, draft.Category) < 0) throw new ArgumentException("unknown category " + draft.Category);
            return Call("POST", "/v1/help/inquiries", draft.ToJson(), true, idempotencyKey ?? NewIdempotencyKey(), true, Inquiry.Parse, ct);
        }

        /// <summary>REQ-HELP-014: mark a ticket's replies read (idempotent).</summary>
        public Task<InquiryReadResult> MarkInquiryReadAsync(string ticketId, CancellationToken ct = default)
        {
            if (!IsInquiryId(ticketId)) throw new ArgumentException("bad ticket id", nameof(ticketId));
            return Call("POST", "/v1/help/inquiries/" + ticketId + "/read", JsonNode.Obj(), true, null, true, InquiryReadResult.Parse, ct);
        }
    }
}
