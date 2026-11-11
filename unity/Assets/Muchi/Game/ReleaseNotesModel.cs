using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-NEW-001..020 (contracts/protocol.md §64, docs/handoff-codex-round21-whats-new.md): アップデートのお知らせ, the game layer.
    // Pure C#: Codex's screens bind to the public fields. Display only — nothing here moves coins or items.

    /// <summary>The server calls the what's-new sheet needs (ApiClient in the app, a fake in the checks).</summary>
    public interface IReleaseNotesApi
    {
        Task<ReleaseNotesCheck> CheckReleaseNotesAsync(CancellationToken ct = default);
        Task<ReleaseNotesSeen> MarkReleaseNotesSeenAsync(string appVersion, CancellationToken ct = default);
        Task<ReleaseNotesHistory> GetReleaseNotesAsync(CancellationToken ct = default);
    }

    /// <summary><see cref="IReleaseNotesApi"/> over the real client (the app's version goes in x-client-version).</summary>
    public sealed class ApiReleaseNotes : IReleaseNotesApi
    {
        private readonly ApiClient _api;
        public ApiReleaseNotes(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<ReleaseNotesCheck> CheckReleaseNotesAsync(CancellationToken ct = default) => _api.CheckReleaseNotesAsync(ct);
        public Task<ReleaseNotesSeen> MarkReleaseNotesSeenAsync(string appVersion, CancellationToken ct = default) => _api.MarkReleaseNotesSeenAsync(appVersion, ct);
        public Task<ReleaseNotesHistory> GetReleaseNotesAsync(CancellationToken ct = default) => _api.GetReleaseNotesAsync(ct);
    }

    /// <summary>
    /// The what's-new sheet over the home screen and the お知らせ › アップデート情報 list.
    /// Rules the model keeps:
    ///  - at each home arrival (<see cref="OnHomeArrivedAsync"/>) it asks the server only while a prompt could still be shown this
    ///    session (<see cref="SessionPrompts.Free"/>: nothing claimed yet, no maintenance / forced update / offline); offline it
    ///    does nothing at all (never a cached sheet);
    ///  - the sheet opens only when <see cref="SessionPrompts.TryClaim"/> gives it the session (a higher prompt due at the same
    ///    time wins, protocol §64.6); a note that loses waits for the next session (the server marked nothing);
    ///  - when it opens it is marked seen at once (POST /v1/release-notes/seen, idempotent). A failed mark is not retried in
    ///    this session and the sheet never re-opens in the same session; the next session may show it again (better than never);
    ///  - pages: <see cref="Next"/> (the last page's CTA is <see cref="StartLabel"/>), <see cref="Skip"/> at any time,
    ///    <see cref="OpenTarget"/> closes the sheet and returns where to go; the last page links to the past list when
    ///    versions were skipped or older notes exist;
    ///  - KPI: release_notes_view shown / finished / skipped (page, pages), release_notes_target, release_notes_history.
    /// </summary>
    public sealed class ReleaseNotesModel
    {
        public const string Title = "アップデート情報";
        public const string NextLabel = "次へ";
        public const string StartLabel = "はじめる";
        public const string SkipLabel = "スキップ";
        public const string PastLabel = "過去のアップデート情報";
        public const string OfflineText = "アップデート情報はオンラインで見られます";
        public const string EmptyText = "まだアップデート情報はありません";
        public const string NewBadge = "NEW";
        /// <summary>"Ver. 1.2.0" — the version is a number, the same in both languages.</summary>
        public static string VersionLabel(string appVersion) => "Ver. " + appVersion;

        private readonly IReleaseNotesApi _api;
        private readonly SessionPrompts _prompts;
        private readonly Func<bool> _online;
        private readonly Action<AnalyticsEvent> _track;
        private readonly Func<long> _clock;

        public ReleaseNotesModel(IReleaseNotesApi api, SessionPrompts prompts, Func<bool> online = null, Action<AnalyticsEvent> track = null, Func<long> clock = null)
        {
            _api = api;
            _prompts = prompts ?? new SessionPrompts();
            _online = online ?? (() => true);
            _track = track;
            _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        /// <summary>The note on the sheet (null = no sheet).</summary>
        public ReleaseNote Sheet { get; private set; }
        /// <summary>The page shown (0-based).</summary>
        public int Page { get; private set; }
        public bool Showing => Sheet != null;
        public ReleaseNotePage CurrentPage => Sheet == null || Sheet.Pages.Count == 0 ? null : Sheet.Pages[Math.Min(Page, Sheet.Pages.Count - 1)];
        public bool OnLastPage => Sheet != null && Page >= Sheet.Pages.Count - 1;
        /// <summary>The CTA of the page: 次へ, or はじめる on the last page.</summary>
        public string CtaLabel => OnLastPage ? StartLabel : NextLabel;
        /// <summary>The last page shows 「過去のアップデート情報 ›」 (skipped versions, or older notes exist).</summary>
        public bool ShowPastLink => OnLastPage && Sheet != null && (Sheet.Skipped > 0 || Sheet.HasPast);
        /// <summary>Why the last check showed nothing (the server's reason; null = shown or not asked).</summary>
        public string LastReason { get; private set; }
        /// <summary>The sheet was opened once in this app session (never twice).</summary>
        public bool ShownThisSession { get; private set; }

        public ReleaseNotesHistory History { get; private set; }
        public string Message { get; private set; }
        public bool Loading { get; private set; }

        /// <summary>
        /// REQ-NEW-006/012: the home screen was reached. <paramref name="alsoDue"/> = other system prompts due right now
        /// (SessionPrompts kinds). Returns true when the sheet opened.
        /// </summary>
        public async Task<bool> OnHomeArrivedAsync(IEnumerable<string> alsoDue = null, CancellationToken ct = default)
        {
            LastReason = null;
            if (ShownThisSession || Showing || _api == null || !_online() || !_prompts.Free) return false;
            ReleaseNotesCheck c;
            try { c = await _api.CheckReleaseNotesAsync(ct); }
            catch (ApiException) { return false; } // offline, maintenance, an old server: show nothing
            if (c?.Show == null || c.Show.Pages.Count == 0) { LastReason = c?.Reason; return false; }
            if (!_prompts.TryClaim(SessionPrompts.ReleaseNotes, alsoDue)) return false;
            Sheet = c.Show; Page = 0; ShownThisSession = true;
            _track?.Invoke(AnalyticsEvent.ReleaseNotesView(_clock(), Sheet.AppVersion, "shown", 1, Sheet.Pages.Count));
            try { await _api.MarkReleaseNotesSeenAsync(Sheet.AppVersion, ct); }
            catch (ApiException) { /* the sheet stays open; the next session may show it again */ }
            return true;
        }

        /// <summary>次へ / はじめる. Returns true while the sheet stays open (false after the last page: finished).</summary>
        public bool Next()
        {
            if (Sheet == null) return false;
            if (OnLastPage)
            {
                _track?.Invoke(AnalyticsEvent.ReleaseNotesView(_clock(), Sheet.AppVersion, "finished", Page + 1, Sheet.Pages.Count));
                Close();
                return false;
            }
            Page++;
            return true;
        }

        /// <summary>スキップ: closes the sheet early (skipped on this page).</summary>
        public void Skip()
        {
            if (Sheet == null) return;
            _track?.Invoke(AnalyticsEvent.ReleaseNotesView(_clock(), Sheet.AppVersion, OnLastPage ? "finished" : "skipped", Page + 1, Sheet.Pages.Count));
            Close();
        }

        /// <summary>REQ-NEW-011: the page's target — closes the sheet and returns where to go (null = this page has none).</summary>
        public ReleaseNoteTarget OpenTarget()
        {
            var t = CurrentPage?.Target;
            if (t == null) return null;
            _track?.Invoke(AnalyticsEvent.ReleaseNotesTarget(_clock(), Sheet.AppVersion, Page + 1, t.Kind, t.Id));
            Skip();
            return t;
        }

        /// <summary>The last page's 「過去のアップデート情報 ›」: closes the sheet; then <see cref="LoadHistoryAsync"/>("sheet").</summary>
        public void OpenPastFromSheet() => Skip();

        private void Close() { Sheet = null; Page = 0; }

        /// <summary>REQ-NEW-010/013: the past list. <paramref name="source"/> = notices (お知らせ) | tips (設定 › ヒント) | sheet.</summary>
        public async Task LoadHistoryAsync(string source, CancellationToken ct = default)
        {
            Message = null;
            _track?.Invoke(AnalyticsEvent.ReleaseNotesHistory(_clock(), source));
            if (!_online() || _api == null) { Message = OfflineText; return; }
            Loading = true;
            try
            {
                History = await _api.GetReleaseNotesAsync(ct);
                if (History.Notes.Count == 0) Message = EmptyText;
            }
            catch (ApiException e) { Message = e is NetworkException ? OfflineText : UxText.For(e); }
            finally { Loading = false; }
        }

        /// <summary>A new app session: the sheet may show again (only if the server still has an unseen note).</summary>
        public void NewSession() { ShownThisSession = false; Close(); _prompts.NewSession(); }
    }
}
