using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-NEW-001..020: アップデートのお知らせ (server/src/domain/releaseNotes.ts, contracts/protocol.md §64).
    // Ops' illustrated pages per app version, shown once to a player who updated, the first time they reach the home screen
    // after the update; the past notes are a list under お知らせ › アップデート情報. The server answers in the request's
    // language with the numbers already filled from data. Display only: nothing here moves coins or items.

    /// <summary>Where a page's one CTA leads (null on the page = no CTA). Never the shop or a paid product (the server's check).</summary>
    public sealed class ReleaseNoteTarget
    {
        public const string KindScreen = "screen", KindHelp = "help", KindTip = "tip";
        public static readonly string[] Kinds = { KindScreen, KindHelp, KindTip };
        /// <summary><see cref="KindScreen"/> (a §48.1 screen id), <see cref="KindHelp"/> (a help article id) or <see cref="KindTip"/> (a tip card id).</summary>
        public string Kind, Id;
        /// <summary>The link text, ready to show ("ヘルプ：観戦中の応援" / "Help: …", "ヒントを開く").</summary>
        public string Label;
        internal static ReleaseNoteTarget Parse(JsonNode o) => o == null ? null : new ReleaseNoteTarget { Kind = J.Str(o, "kind"), Id = J.Str(o, "id"), Label = J.Str(o, "label") };
    }

    /// <summary>One page: an art key (§57 tip art), a short title and body (numbers filled from data) and an optional target.</summary>
    public sealed class ReleaseNotePage
    {
        public string Art, Title, Body;
        public ReleaseNoteTarget Target;
        internal static ReleaseNotePage Parse(JsonNode o) => new ReleaseNotePage { Art = J.Str(o, "art"), Title = J.Str(o, "title"), Body = J.Str(o, "body"), Target = ReleaseNoteTarget.Parse(J.Opt(o, "target")) };
    }

    /// <summary>The notes of one app version (the sheet's content, or a row of the past list).</summary>
    public sealed class ReleaseNote
    {
        public string AppVersion, ReleasedOn;
        /// <summary>Only in the past list: this player was shown it.</summary>
        public bool Seen;
        /// <summary>Only in a check: older versions this player also skipped (the last page links to the past list).</summary>
        public int Skipped;
        /// <summary>Only in a check: there are other notes up to this app version (the past list is worth a link).</summary>
        public bool HasPast;
        public List<ReleaseNotePage> Pages = new List<ReleaseNotePage>();
        internal static ReleaseNote Parse(JsonNode o) => o == null ? null : new ReleaseNote
        {
            AppVersion = J.Str(o, "appVersion"), ReleasedOn = J.Str(o, "releasedOn"), Seen = J.Bool(o, "seen"), Skipped = J.Int(o, "skipped"), HasPast = J.Bool(o, "hasPast"),
            Pages = J.List(o, "pages", ReleaseNotePage.Parse),
        };
    }

    /// <summary>POST /v1/release-notes/check: the note to show at this home arrival, or null and why not.</summary>
    public sealed class ReleaseNotesCheck
    {
        /// <summary>Why nothing is shown (null when <see cref="Show"/> is set).</summary>
        public const string ReasonDisabled = "disabled", ReasonUnknownVersion = "unknown_version", ReasonFtue = "ftue", ReasonNewInstall = "new_install", ReasonSeen = "seen", ReasonNone = "none";
        public bool Enabled;
        public string AppVersion, Reason;
        public ReleaseNote Show;
        public static ReleaseNotesCheck Parse(JsonNode o) => new ReleaseNotesCheck { Enabled = J.Bool(o, "enabled"), AppVersion = J.Str(o, "appVersion"), Reason = J.Str(o, "reason"), Show = ReleaseNote.Parse(J.Opt(o, "show")) };
    }

    /// <summary>POST /v1/release-notes/seen.</summary>
    public sealed class ReleaseNotesSeen
    {
        public bool Marked;
        public List<string> Seen = new List<string>();
        internal static ReleaseNotesSeen Parse(JsonNode o) => new ReleaseNotesSeen { Marked = J.Bool(o, "marked"), Seen = J.List(o, "seen", v => v.AsString()) };
    }

    /// <summary>GET /v1/release-notes: お知らせ › アップデート情報 (newest first, up to the app's version).</summary>
    public sealed class ReleaseNotesHistory
    {
        public bool Enabled;
        public string AppVersion;
        public List<ReleaseNote> Notes = new List<ReleaseNote>();
        public static ReleaseNotesHistory Parse(JsonNode o) => new ReleaseNotesHistory { Enabled = J.Bool(o, "enabled"), AppVersion = J.Str(o, "appVersion"), Notes = J.List(o, "notes", ReleaseNote.Parse) };
    }

    /// <summary>
    /// The one prompt gate (R21 integration: protocol §58.11 = §64.6, REQ-CNS / REQ-LNOTIF / REQ-REV / REQ-NEW-012). At most ONE
    /// system-ish prompt per app session (one launch, or until the signed-in account changes), and none during the FTUE.
    /// When several are due at one moment the highest in <see cref="Priority"/> takes the session; the others stay due for a
    /// later session (their own rules keep them due — nothing is lost). While <see cref="ApiClient.Outage"/> is not None
    /// (maintenance, a forced update, offline) nothing is claimed at all — the §46 screens are never covered.
    /// Every model that can interrupt the player shares one instance: MaintenanceModel (recommended update), ConsentModel,
    /// ComebackModel (welcome), ReleaseNotesModel, LocalNotificationModel (reminders card), AccountLinkPrompt, ReviewPromptModel.
    /// </summary>
    public sealed class SessionPrompts
    {
        /// <summary>Priority order, highest first (protocol §58.11 table). The §46 maintenance / update screens are not prompts: they block all of these.</summary>
        /// R22 integration: §68 PromotionOutcome (earned feedback, right after the release notes) and §69 Survey (an opinion only,
        /// the lowest). The §67 play-time reminder is NOT a prompt here: the player asked for it, so it neither takes nor waits for
        /// the session's one prompt (the exempt row of the §58.11 table).
        public const string RecommendedUpdate = "recommended_update", ConsentPrePrompt = "consent_pre_prompt", ComebackWelcome = "comeback_welcome",
            ReleaseNotes = "release_notes", PromotionOutcome = "promotion_outcome", RemindersPrePermission = "reminders_pre_permission", AccountLink = "account_link",
            ReviewPrompt = "review_prompt", Survey = "survey";
        public static readonly string[] Priority = { RecommendedUpdate, ConsentPrePrompt, ComebackWelcome, ReleaseNotes, PromotionOutcome, RemindersPrePermission, AccountLink, ReviewPrompt, Survey };

        private readonly Func<OutageKind> _outage;
        private readonly Func<bool> _inFtue;
        /// <param name="outage">The client's outage (ApiClient.Outage); none when omitted.</param>
        /// <param name="inFtue">Whether the player is still in the FTUE (no prompt at all then); never when omitted.</param>
        public SessionPrompts(Func<OutageKind> outage = null, Func<bool> inFtue = null)
        {
            _outage = outage ?? (() => OutageKind.None);
            _inFtue = inFtue ?? (() => false);
        }

        /// <summary>The prompt that took this session (null = none yet).</summary>
        public string Claimed { get; private set; }

        private static int Rank(string kind)
        {
            int rank = Array.IndexOf(Priority, kind);
            if (rank < 0) throw new ArgumentException("unknown prompt " + kind, nameof(kind));
            return rank;
        }

        private bool Open => _outage() == OutageKind.None && !_inFtue();

        /// <summary>Whether <paramref name="kind"/> may show now: nothing else took this session (the same one again is fine — a sheet built twice), no outage, not in the FTUE.</summary>
        public bool CanShow(string kind)
        {
            Rank(kind);
            return Open && (Claimed == null || Claimed == kind);
        }

        /// <summary>
        /// Claims the session for <paramref name="kind"/> when <see cref="CanShow"/> and no higher prompt in
        /// <paramref name="alsoDue"/> (the other prompts due at this moment) outranks it. Returns true when the caller may show it.
        /// </summary>
        public bool TryClaim(string kind, IEnumerable<string> alsoDue = null)
        {
            int rank = Rank(kind);
            if (!CanShow(kind)) return false;
            if (Claimed == kind) return true;
            if (alsoDue != null && alsoDue.Any(k => { int r = Array.IndexOf(Priority, k); return r >= 0 && r < rank; })) return false;
            Claimed = kind;
            return true;
        }

        /// <summary>Of the prompts due at one moment, the one to show (by <see cref="Priority"/>), or null when none may show.</summary>
        public string Pick(IEnumerable<string> due)
        {
            if (due == null) return null;
            var set = new HashSet<string>(due);
            foreach (var k in Priority) if (set.Contains(k) && CanShow(k)) return k;
            return null;
        }

        /// <summary>Whether a prompt could still be shown this session (for a model that would otherwise fetch for nothing).</summary>
        public bool Free => Claimed == null && Open;

        /// <summary>A new app session (cold start), or another account signed in on this device. The claim is never persisted.</summary>
        public void NewSession() => Claimed = null;
    }

    public sealed partial class ApiClient
    {
        private static readonly System.Text.RegularExpressions.Regex AppVersionRe = new System.Text.RegularExpressions.Regex(@"^\d{1,4}\.\d{1,4}\.\d{1,4}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        /// <summary>An x.y.z app version (the form x-client-version and the release notes use).</summary>
        public static bool IsAppVersion(string v) => v != null && AppVersionRe.IsMatch(v);

        /// <summary>REQ-NEW-006: at each home arrival — the note to show (the app's version goes in x-client-version, <see cref="ApiClientOptions.AppVersion"/>).</summary>
        public Task<ReleaseNotesCheck> CheckReleaseNotesAsync(CancellationToken ct = default) => Call("POST", "/v1/release-notes/check", null, true, null, true, ReleaseNotesCheck.Parse, ct);

        /// <summary>REQ-NEW-009: the sheet was shown (idempotent).</summary>
        public Task<ReleaseNotesSeen> MarkReleaseNotesSeenAsync(string appVersion, CancellationToken ct = default)
        {
            if (!IsAppVersion(appVersion)) throw new ArgumentException("bad app version " + appVersion, nameof(appVersion));
            return Call("POST", "/v1/release-notes/seen", JsonNode.Obj().Set("appVersion", appVersion), true, null, true, ReleaseNotesSeen.Parse, ct);
        }

        /// <summary>REQ-NEW-010: お知らせ › アップデート情報.</summary>
        public Task<ReleaseNotesHistory> GetReleaseNotesAsync(CancellationToken ct = default) => Call("GET", "/v1/release-notes", null, true, null, true, ReleaseNotesHistory.Parse, ct);
    }
}
