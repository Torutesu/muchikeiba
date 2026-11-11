using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-QCHAT-*: 支部の定型チャット. server/src/domain/quickChat.ts + teamFeed.ts (item kind "qchat"), contracts/protocol.md §52.
    // Fixed phrases only: the client sends a phrase id and slot values (ids from the picker's options) — never a text.
    // Texts (qchatText / qchatTemplate / qchatValue) arrive already in the request language: show them as they are.

    /// <summary>The slot names a phrase can have (§52.2).</summary>
    public static class QuickChatSlots
    {
        public const string Course = "course", Horse = "horse", Race = "race", Time = "time", Cup = "cup", Player = "player";
        public static readonly string[] All = { Course, Horse, Race, Time, Cup, Player };
    }

    /// <summary>One phrase of the catalog, in the request language. <see cref="Template"/> keeps its "{course}" style slots.</summary>
    public sealed class QuickChatPhrase
    {
        public string Id, Category, Template;
        public List<string> Slots = new List<string>();
        /// <summary>A "{player}" phrase: the named member gets one activity entry (§52.8).</summary>
        public bool Mention;
        internal static QuickChatPhrase Parse(JsonNode o) => new QuickChatPhrase
        {
            Id = J.Str(o, "id"), Category = J.Str(o, "category"), Template = J.Str(o, "qchatTemplate"),
            Slots = J.List(o, "slots", x => x.AsString()), Mention = J.Bool(o, "mention"),
        };

        /// <summary>The phrase with the given slot texts filled in; a slot not chosen yet shows <paramref name="blank"/>.</summary>
        public string Fill(IDictionary<string, string> values, string blank = "＿＿")
        {
            string t = Template ?? "";
            foreach (var s in Slots)
                t = t.Replace("{" + s + "}", values != null && values.TryGetValue(s, out var v) && !string.IsNullOrEmpty(v) ? v : blank);
            return t;
        }
    }

    /// <summary>A value the server accepts for a slot: <see cref="Ref"/> is sent, <see cref="Text"/> is shown (never translated again).</summary>
    public sealed class QuickChatOption
    {
        public string Ref, Text;
        internal static QuickChatOption Parse(JsonNode o) => new QuickChatOption { Ref = J.Str(o, "ref"), Text = J.Str(o, "qchatValue") };
    }

    /// <summary>GET /v1/teams/me/quick-chat (§52.5): phrases, the values a post would accept, limits and today's usage.</summary>
    public sealed class QuickChatPicker
    {
        public bool Enabled;
        public string TeamId;
        public bool Deleting;
        public int PostIntervalMs = 15000, PostsPerDay = 30, MentionsPerDay = 10, RepeatWindowMs = 600000;
        public int PostsToday, MentionsToday;
        public long NextPostAt;
        public List<QuickChatPhrase> Phrases = new List<QuickChatPhrase>();
        public Dictionary<string, List<QuickChatOption>> Options = new Dictionary<string, List<QuickChatOption>>();
        public List<QuickChatOption> OptionsFor(string slot) => Options.TryGetValue(slot, out var l) ? l : new List<QuickChatOption>();
        internal static QuickChatPicker Parse(JsonNode o)
        {
            var l = J.Opt(o, "limits");
            var u = J.Opt(o, "usage");
            var opts = J.Opt(o, "options");
            var p = new QuickChatPicker
            {
                Enabled = J.Bool(o, "enabled"), TeamId = J.Str(o, "teamId"), Deleting = J.Bool(o, "deleting"),
                PostIntervalMs = J.Int(l, "postIntervalMs", 15000), PostsPerDay = J.Int(l, "postsPerDay", 30), MentionsPerDay = J.Int(l, "mentionsPerDay", 10), RepeatWindowMs = J.Int(l, "repeatWindowMs", 600000),
                PostsToday = J.Int(u, "postsToday"), MentionsToday = J.Int(u, "mentionsToday"), NextPostAt = J.Long(u, "nextPostAt"),
                Phrases = J.List(o, "phrases", QuickChatPhrase.Parse),
            };
            foreach (var s in QuickChatSlots.All) p.Options[s] = J.List(opts, s, QuickChatOption.Parse);
            return p;
        }
    }

    /// <summary>A quick chat post in the feed (FeedItem.Kind == "qchat"), as this viewer reads it.</summary>
    public sealed class FeedQuickChat
    {
        public string PhraseId, Category;
        /// <summary>The phrase in my language with its values filled in (show as it is).</summary>
        public string Text;
        public bool Mention, MentionsMe;
        /// <summary>The author left the branch: shown as 「元メンバー」 (no player id; nothing to mute).</summary>
        public bool Anon;
        public List<QuickChatSlotValue> Slots = new List<QuickChatSlotValue>();
        /// <summary>The report target (§18 report now; Round 17's §47 report centre takes the same descriptor).</summary>
        public string ReportKind, ReportTeamId;
        public long ReportSeq;
        internal static FeedQuickChat Parse(JsonNode o)
        {
            if (o == null) return null;
            var r = J.Opt(o, "report");
            return new FeedQuickChat
            {
                PhraseId = J.Str(o, "phraseId"), Category = J.Str(o, "category"), Text = J.Str(o, "qchatText"),
                Mention = J.Bool(o, "mention"), MentionsMe = J.Bool(o, "mentionsMe"), Anon = J.Bool(o, "anon"),
                Slots = J.List(o, "slots", QuickChatSlotValue.Parse),
                ReportKind = J.Str(r, "kind"), ReportTeamId = J.Str(r, "teamId"), ReportSeq = J.Long(r, "seq"),
            };
        }
    }

    public sealed class QuickChatSlotValue
    {
        public string Name, Ref, Text;
        internal static QuickChatSlotValue Parse(JsonNode o) => new QuickChatSlotValue { Name = J.Str(o, "name"), Ref = J.Str(o, "ref"), Text = J.Str(o, "qchatValue") };
    }

    public sealed class QuickChatPostResult
    {
        public string TeamId, PhraseId;
        public long Seq, At;
        internal static QuickChatPostResult Parse(JsonNode o) => new QuickChatPostResult { TeamId = J.Str(o, "teamId"), PhraseId = J.Str(o, "phraseId"), Seq = J.Long(o, "seq"), At = J.Long(o, "at") };
    }

    public sealed partial class ApiClient
    {
        // ------------------------------------------------------------------ 支部の定型チャット (REQ-QCHAT-*)

        /// <summary>The phrases in my language, the values a post would accept, the limits and today's usage (§52.5).</summary>
        public Task<QuickChatPicker> GetQuickChatAsync(CancellationToken ct = default)
            => Call("GET", "/v1/teams/me/quick-chat", null, true, null, true, QuickChatPicker.Parse, ct);

        /// <summary>
        /// Post a phrase. <paramref name="slots"/> = slot name → the option's <see cref="QuickChatOption.Ref"/>. Never retried
        /// (a post is not idempotent): RateLimitedException = 15 s / 30 a day / same phrase again / mentions a day,
        /// ConflictException NOT_ELIGIBLE = a value that cannot be used (e.g. a member in a block relation),
        /// NotFoundException NOT_IN_TEAM / quick chat off, PurchaseBlockedException DELETION_PENDING.
        /// </summary>
        public Task<QuickChatPostResult> PostQuickChatAsync(string phraseId, IDictionary<string, string> slots = null, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("phraseId", phraseId);
            var s = JsonNode.Obj();
            if (slots != null) foreach (var kv in slots.OrderBy(x => x.Key, System.StringComparer.Ordinal)) s.Set(kv.Key, kv.Value);
            b.Set("slots", s);
            return Call("POST", "/v1/teams/me/feed/quick-chat", b, true, null, false, QuickChatPostResult.Parse, ct);
        }
    }
}
