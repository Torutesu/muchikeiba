using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-RPT-001..020 (contracts/protocol.md §47, docs/handoff-codex-round17-reports.md): 通報とブロック, the game layer.
    // Pure C#: Codex's report sheet and block screen bind to the public fields. Japanese here is the source; screens show
    // Loc.T(model.X). Player names and the note are never translated.

    /// <summary>The server calls the report sheet and the block screen need (ApiClient in the app, a fake in the checks).</summary>
    public interface IReportApi
    {
        Task<ReportOptions> GetReportOptionsAsync(CancellationToken ct = default);
        Task<ReportResult> SubmitReportAsync(ReportTarget target, string category, string source, string note = null, bool alsoBlock = false, CancellationToken ct = default);
        Task<BlockList> GetBlocksAsync(CancellationToken ct = default);
        Task<BlockChange> BlockAsync(string playerId, CancellationToken ct = default);
        Task<BlockChange> UnblockAsync(string playerId, CancellationToken ct = default);
    }

    /// <summary><see cref="IReportApi"/> over the real client.</summary>
    public sealed class ApiReports : IReportApi
    {
        private readonly ApiClient _api;
        public ApiReports(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<ReportOptions> GetReportOptionsAsync(CancellationToken ct = default) => _api.GetReportOptionsAsync(ct);
        public Task<ReportResult> SubmitReportAsync(ReportTarget target, string category, string source, string note = null, bool alsoBlock = false, CancellationToken ct = default)
            => _api.SubmitReportAsync(target, category, source, note, alsoBlock, ct);
        public Task<BlockList> GetBlocksAsync(CancellationToken ct = default) => _api.GetBlocksAsync(ct);
        public Task<BlockChange> BlockAsync(string playerId, CancellationToken ct = default) => _api.BlockAsync(playerId, ct);
        public Task<BlockChange> UnblockAsync(string playerId, CancellationToken ct = default) => _api.UnblockAsync(playerId, ct);
    }

    /// <summary>One reason row of the sheet (label from the server, already English in English mode).</summary>
    public sealed class ReportReasonRow
    {
        public string Id, Label;
        public bool Selected;
    }

    /// <summary>
    /// The report sheet (通報シート). Rules the model keeps:
    ///  - only the reasons that fit what is reported are offered (the server's category → kinds table);
    ///  - the note is optional, counted in characters like the server (code points after trimming), never translated;
    ///  - 「この人もブロックする」 is off by default; the result says whether the block happened;
    ///  - one send at a time (a second tap while sending does nothing); after a success the sheet is done;
    ///  - offline: nothing is sent, <see cref="OfflineText"/>; a failed send keeps the choices for 「もう一度送る」;
    ///  - nothing here tells the reported player anything, and the sheet never shows how many others reported.
    /// </summary>
    public sealed class ReportModel
    {
        public const string Title = "通報する";
        public const string Lead = "運営が内容を確認します。通報したことは相手に知らされません。";
        public const string ReasonLabel = "理由";
        public const string NoteLabel = "補足（任意）";
        public const string NotePlaceholder = "気になった点を短く";
        public const string AlsoBlockLabel = "この人をブロックする";
        public const string SendCta = "送る";
        public const string ResendCta = "もう一度送る";
        public const string SentText = "通報を受け付けました。ご協力ありがとうございます";
        public const string SentBlockedText = "通報を受け付け、ブロックしました";
        public const string OfflineText = "通報はオンラインで送れます";
        public const string LimitText = "今日はこれ以上通報できません。4:00に戻ります";
        public const string GoneText = "通報する内容が見つかりませんでした。変更・削除された可能性があります";
        public const string NotInRaceText = "出走したレースだけ「不正の疑い」で通報できます";
        public const string NoteTooLongText = "補足が長すぎます";
        public const string UnavailableText = "いまは通報を受け付けていません";

        private readonly IReportApi _api;
        private readonly Func<bool> _online;
        private ReportOptions _options;

        public ReportModel(IReportApi api, ReportTarget target, string source, Func<bool> online = null)
        {
            _api = api;
            Target = target ?? throw new ArgumentNullException(nameof(target));
            if (Array.IndexOf(ReportSources.All, source) < 0) throw new ArgumentException("unknown source " + source, nameof(source));
            Source = source;
            _online = online ?? (() => true);
        }

        public ReportTarget Target { get; }
        public string Source { get; }
        /// <summary>The reported player's name as the opening screen shows it (never translated).</summary>
        public string TargetName { get; set; }
        public List<ReportReasonRow> Reasons { get; } = new List<ReportReasonRow>();
        public string SelectedReason => Reasons.FirstOrDefault(r => r.Selected)?.Id;
        public string Note { get; set; } = "";
        public bool AlsoBlock { get; set; }
        public int NoteMax { get; private set; }
        public bool NotesOff => _options != null && NoteMax == 0;
        public int RemainingToday { get; private set; }
        public bool Loading { get; private set; }
        public bool Sending { get; private set; }
        public bool Sent { get; private set; }
        public bool Blocked { get; private set; }
        /// <summary>The line under the button: an error, the offline text or the thank-you line after sending.</summary>
        public string Message { get; private set; }

        /// <summary>Characters as the server counts them (code points of the NFKC-trimmed text; NFKC is close enough for a hint).</summary>
        public int NoteLength => CodePoints((Note ?? "").Trim());
        public bool NoteOver => NoteLength > NoteMax;
        /// <summary>"12/100" under the note box.</summary>
        public string NoteCounter => NoteLength + "/" + NoteMax;
        public bool CanSend => _online() && _options != null && _options.Enabled && SelectedReason != null && !NoteOver && !Sending && !Sent && RemainingToday > 0;

        public static int CodePoints(string s)
        {
            int n = 0;
            for (int i = 0; i < s.Length; i++) { n++; if (char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) i++; }
            return n;
        }

        /// <summary>Opens the sheet: the reasons that fit <see cref="Target"/>, the note limit and today's allowance.</summary>
        public async Task OpenAsync(CancellationToken ct = default)
        {
            Reasons.Clear(); Message = null; Sent = false; Blocked = false; _options = null;
            if (!_online() || _api == null) { Message = OfflineText; return; }
            Loading = true;
            try
            {
                var o = await _api.GetReportOptionsAsync(ct);
                _options = o;
                NoteMax = o.NoteMaxChars;
                RemainingToday = o.RemainingToday;
                foreach (var c in o.Categories.Where(c => c.Allows(Target.Kind))) Reasons.Add(new ReportReasonRow { Id = c.Id, Label = c.Label });
                if (!o.Enabled) Message = UnavailableText;
                else if (RemainingToday <= 0) Message = LimitText;
            }
            catch (ApiException e) { Message = UxText.For(e); }
            finally { Loading = false; }
        }

        public void Select(string reasonId)
        {
            foreach (var r in Reasons) r.Selected = r.Id == reasonId;
        }

        /// <summary>Sends once. Returns true when the report was received.</summary>
        public async Task<bool> SendAsync(CancellationToken ct = default)
        {
            if (!_online() || _api == null) { Message = OfflineText; return false; }
            if (NoteOver) { Message = NoteTooLongText; return false; }
            if (!CanSend) return false;
            Sending = true;
            Message = null;
            try
            {
                var note = NotesOff || string.IsNullOrWhiteSpace(Note) ? null : Note.Trim();
                var r = await _api.SubmitReportAsync(Target, SelectedReason, Source, note, AlsoBlock, ct);
                Sent = r.Received;
                Blocked = r.Blocked;
                RemainingToday = r.RemainingToday;
                Message = r.Blocked && AlsoBlock ? SentBlockedText : SentText;
                return r.Received;
            }
            catch (ApiException e) { Message = ErrorText(e); return false; }
            finally { Sending = false; }
        }

        /// <summary>The report-specific reading of an error (the generic table elsewhere).</summary>
        public static string ErrorText(ApiException e)
        {
            switch (e.WireCode)
            {
                case "RATE_LIMITED": return LimitText;
                case "NOT_FOUND": return GoneText;
                case "NOT_ELIGIBLE": return NotInRaceText;
                case "BAD_REQUEST": return NoteTooLongText;
                default: return UxText.For(e);
            }
        }
    }
}
