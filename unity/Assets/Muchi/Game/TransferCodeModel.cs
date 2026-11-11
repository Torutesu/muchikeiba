using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    // REQ-TRF-001..020 (contracts/protocol.md §54, docs/handoff-codex-round19-transfer-code.md): 引き継ぎコード, the game layer.
    // Pure C#: Codex's issue screen (settings → 引き継ぎ → IDとパスワード), redeem screen (title → データ引き継ぎ), confirm
    // sheet and the "moved to another device" notice bind to the public fields. Passwords are only held while a screen is
    // open and are never logged or sent to analytics; a server-generated password is shown once and forgotten on leaving.

    /// <summary>The server calls the transfer screens need (ApiClient in the app, a fake in the checks).</summary>
    public interface ITransferCodeApi
    {
        Task<TransferCodeStatus> GetTransferCodeAsync(CancellationToken ct = default);
        Task<IssuedTransferCode> IssueTransferCodeAsync(string password, CancellationToken ct = default);
        Task<bool> RevokeTransferCodeAsync(CancellationToken ct = default);
        Task<TransferRedeemResult> RedeemTransferCodeAsync(string codeId, string password, bool confirmDiscard, string idempotencyKey, string installId = null, CancellationToken ct = default);
    }

    public sealed class ApiTransferCode : ITransferCodeApi
    {
        private readonly ApiClient _api;
        public ApiTransferCode(ApiClient api) { _api = api ?? throw new ArgumentNullException(nameof(api)); }
        public Task<TransferCodeStatus> GetTransferCodeAsync(CancellationToken ct = default) => _api.GetTransferCodeAsync(ct);
        public Task<IssuedTransferCode> IssueTransferCodeAsync(string password, CancellationToken ct = default) => _api.IssueTransferCodeAsync(password, ct);
        public Task<bool> RevokeTransferCodeAsync(CancellationToken ct = default) => _api.RevokeTransferCodeAsync(ct);
        public Task<TransferRedeemResult> RedeemTransferCodeAsync(string codeId, string password, bool confirmDiscard, string idempotencyKey, string installId = null, CancellationToken ct = default)
            => _api.RedeemTransferCodeAsync(codeId, password, confirmDiscard, idempotencyKey, installId, ct);
    }

    /// <summary>Signs in with the redeem's custom token (FirebaseAuthTokenProvider.SignInWithCustomTokenAsync under MUCHI_FIREBASE).</summary>
    public interface ITransferSignIn
    {
        bool SupportsCustomToken { get; }
        Task SignInWithCustomTokenAsync(string customToken, CancellationToken ct = default);
    }

    /// <summary><see cref="ITransferSignIn"/> over the Firebase token provider.</summary>
    public sealed class FirebaseTransferSignIn : ITransferSignIn
    {
        private readonly FirebaseAuthTokenProvider _p;
        public FirebaseTransferSignIn(FirebaseAuthTokenProvider p) { _p = p ?? throw new ArgumentNullException(nameof(p)); }
        public bool SupportsCustomToken => _p.SupportsCustomToken;
        public Task SignInWithCustomTokenAsync(string customToken, CancellationToken ct = default) => _p.SignInWithCustomTokenAsync(customToken, ct);
    }

    /// <summary>One line of the password checklist (ticks as the player types; the server checks the same rules).</summary>
    public sealed class PasswordRuleLine
    {
        public string Id, Text;
        public bool Ok;
    }

    public enum RedeemState { Idle, Busy, NeedsConfirm, Done, Error }

    /// <summary>
    /// Both transfer screens. Rules the model keeps:
    ///  - the issue screen shows the ID (formatted), the expiry and the rule checklist; 「発行する」 stays off until every rule
    ///    ticks and the two password fields match; a generated password is shown once (<see cref="GeneratedPassword"/>) and
    ///    cleared by <see cref="LeaveIssueScreen"/>;
    ///  - the redeem screen sends one request at a time and keeps the same idempotency key for the same ID + password until the
    ///    custom-token sign-in finished (a lost response is retried as a replay, not as a new attempt);
    ///  - TRANSFER_CONFIRM_REQUIRED → <see cref="RedeemState.NeedsConfirm"/> with <see cref="ConfirmText"/> (this device's
    ///    progress, paid coins first); <see cref="ConfirmAsync"/> sends again with confirmDiscard;
    ///  - every failure is one message from <see cref="ErrorText"/> — never "the ID does not exist" (the server does not say).
    /// </summary>
    public sealed class TransferCodeModel
    {
        public const string Title = "引き継ぎコード";
        public const string IssueTitle = "IDとパスワードで引き継ぐ";
        public const string RedeemTitle = "データ引き継ぎ";
        public const string IdLabel = "ID";
        public const string PasswordLabel = "パスワード";
        public const string PasswordAgainLabel = "パスワード（確認）";
        public const string IssueCta = "発行する";
        public const string GenerateCta = "自動で作る";
        public const string CopyCta = "コピー";
        public const string CopiedText = "コピーしました";
        public const string RevokeCta = "このコードを取り消す";
        public const string RevokedText = "コードを取り消しました";
        public const string RedeemCta = "引き継ぐ";
        public const string ConfirmCta = "引き継ぐ（この端末のデータは使えなくなります）";
        public const string CancelCta = "やめる";
        public const string NoCodeText = "まだ発行していません";
        public const string MismatchText = "パスワードが一致しません";
        public const string GeneratedNote = "このパスワードはこの画面でしか表示されません。メモしてから閉じてください";
        public const string KeepSecretNote = "IDとパスワードは人に教えないでください。運営からたずねることはありません";
        public const string SingleUseNote = "コードは1回だけ使えます。使った後は新しく発行してください";
        public const string IdFormatText = "IDは9文字です（例：K7M-Q3X-PHR）";
        public const string UnavailableText = "引き継ぎコードはいま使えません。Apple・Googleで引き継いでください";
        public const string OfflineText = "オフラインです。通信できる場所でお試しください";
        public const string InvalidText = "IDまたはパスワードが違います";
        public const string ExpiredText = "このコードは有効期限が切れています。前の端末で発行し直してください";
        public const string LockedText = "入力の回数が多すぎます。しばらく待ってからお試しください";
        public const string SameAccountText = "この端末で使っているアカウントのコードです";
        public const string BannedText = "このアカウントは引き継げません。お問い合わせください";
        public const string DeletionText = "このアカウントは削除の手続き中のため引き継げません。前の端末で削除を取り消すか、お問い合わせください";
        public const string IssueLimitText = "今日はこれ以上発行できません。明日もう一度お試しください";
        public const string SignInLaterText = "引き継ぎは受け付けました。通信できる場所で「引き継ぐ」をもう一度押してください";
        public const string ErrorFallback = "引き継げませんでした。時間をおいてお試しください";
        // REQ-TRF-010: the old device after SESSION_REPLACED
        public const string ReplacedTitle = "別の端末に引き継がれました";
        public const string ReplacedBody = "このアカウントは別の端末に引き継がれたため、この端末では遊べません。新しく始めるか、引き継ぎコードを入力してください。";
        public const string ReplacedNewCta = "新しく始める";
        public const string ReplacedRedeemCta = "引き継ぎコードを入力";

        private readonly ITransferCodeApi _api;
        private readonly ITransferSignIn _signIn;
        private readonly Func<bool> _online;
        private readonly Func<string> _newKey;
        private readonly string _installId;
        private string _pendingKey, _pendingFor;
        private bool _confirmed;

        public TransferCodeModel(ITransferCodeApi api, ITransferSignIn signIn = null, Func<bool> online = null, Func<string> newKey = null, string installId = null)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            _signIn = signIn;
            _online = online ?? (() => true);
            _newKey = newKey ?? (() => "trf-" + Guid.NewGuid().ToString("N"));
            _installId = installId;
        }

        // ------------------------------------------------------------------ issue screen
        public TransferCodeStatus Status { get; private set; }
        /// <summary>False: the server has the feature off (show Apple / Google only).</summary>
        public bool Visible => Status != null && Status.Enabled;
        /// <summary>The redeem screen needs a backend that signs in with custom tokens (MUCHI_FIREBASE); the dev / offline builds hide it.</summary>
        public bool RedeemAvailable => _signIn == null || _signIn.SupportsCustomToken;
        public bool Busy { get; private set; }
        public string Message { get; private set; }
        /// <summary>The server-generated password, set right after issuing and cleared by <see cref="LeaveIssueScreen"/>.</summary>
        public string GeneratedPassword { get; private set; }

        public async Task LoadAsync(CancellationToken ct = default)
        {
            Message = null;
            if (!_online()) { Message = OfflineText; return; }
            try { Status = await _api.GetTransferCodeAsync(ct); }
            catch (NetworkException) { Message = OfflineText; }
            catch (ApiException e) { Message = ErrorText(e); }
        }

        public string CodeLine => Status?.Code == null ? NoCodeText : Status.Code.CodeId;
        public string ExpiryLine => Status?.Code == null ? null
            : Status.Code.Expired ? "有効期限が切れています" : "有効期限：" + ExchangeModel.JstDateTime(Status.Code.ExpiresAt - 60_000) + "まで";

        /// <summary>The checklist as the player types (the server's rule texts; the same checks as the server).</summary>
        public List<PasswordRuleLine> RuleLines(string password)
        {
            var min = Status?.PasswordMin ?? TransferCodeRules.DefaultMin;
            var max = Status?.PasswordMax ?? TransferCodeRules.DefaultMax;
            var broken = TransferCodeRules.PasswordProblems(password ?? "", min, max);
            var texts = Status?.Rules?.Count > 0 ? Status.Rules : DefaultRules(min, max);
            return texts.Select((r) => new PasswordRuleLine { Id = r.Id, Text = r.Text, Ok = !broken.Contains(r.Id) && !string.IsNullOrEmpty(password) }).ToList();
        }
        private static List<TransferRule> DefaultRules(int min, int max) => new List<TransferRule>
        {
            new TransferRule { Id = TransferCodeRules.Length, Text = min + "〜" + max + "文字" },
            new TransferRule { Id = TransferCodeRules.Charset, Text = "半角の英数字と記号" },
            new TransferRule { Id = TransferCodeRules.Mix, Text = "英字と数字を両方使う" },
            new TransferRule { Id = TransferCodeRules.Common, Text = "よく使われるパスワードは使えません" },
        };

        public bool CanIssue(string password, string again) => !Busy && RuleLines(password).All((r) => r.Ok) && password == again;

        /// <summary>Issues with the player's password (null = let the server create one, shown once).</summary>
        public async Task<bool> IssueAsync(string password, string again = null, CancellationToken ct = default)
        {
            Message = null;
            if (Busy) return false;
            if (password != null && password != (again ?? password)) { Message = MismatchText; return false; }
            if (password != null && !RuleLines(password).All((r) => r.Ok)) { Message = RuleLines(password).First((r) => !r.Ok).Text; return false; }
            if (!_online()) { Message = OfflineText; return false; }
            Busy = true;
            try
            {
                var r = await _api.IssueTransferCodeAsync(password, ct);
                GeneratedPassword = r.Password;
                Status = await _api.GetTransferCodeAsync(ct);
                return true;
            }
            catch (NetworkException) { Message = OfflineText; return false; }
            catch (TransferException e) when (e.Code == ApiErrorCode.TransferPasswordWeak)
            {
                Message = RuleLines(password).FirstOrDefault((l) => e.Rules.Contains(l.Id))?.Text ?? ErrorFallback;
                return false;
            }
            catch (ApiException e) { Message = ErrorText(e); return false; }
            finally { Busy = false; }
        }

        /// <summary>What 「コピー」 puts on the clipboard: the ID, plus the generated password while it is shown.</summary>
        public string CopyText => Status?.Code == null ? null
            : GeneratedPassword == null ? Status.Code.CodeId : IdLabel + "：" + Status.Code.CodeId + "\n" + PasswordLabel + "：" + GeneratedPassword;

        /// <summary>The generated password is never shown again once the screen is left.</summary>
        public void LeaveIssueScreen() { GeneratedPassword = null; Message = null; }

        public async Task<bool> RevokeAsync(CancellationToken ct = default)
        {
            Message = null;
            try
            {
                var r = await _api.RevokeTransferCodeAsync(ct);
                GeneratedPassword = null;
                Status = await _api.GetTransferCodeAsync(ct);
                if (r) Message = RevokedText;
                return r;
            }
            catch (NetworkException) { Message = OfflineText; return false; }
            catch (ApiException e) { Message = ErrorText(e); return false; }
        }

        // ------------------------------------------------------------------ redeem screen
        public RedeemState State { get; private set; } = RedeemState.Idle;
        public string RedeemMessage { get; private set; }
        public TransferConfirm Confirm { get; private set; }
        /// <summary>Player-typed name of the account that arrived — its own line under <see cref="DoneText"/>, never translated.</summary>
        public string ArrivedName { get; private set; }
        public const string DoneText = "データを引き継ぎました";

        /// <summary>The confirm sheet's line: this device's own progress, paid coins first (資金決済法: say what is lost).</summary>
        public string ConfirmText
        {
            get
            {
                if (Confirm == null) return null;
                var parts = new List<string>();
                if (Confirm.PaidCoins > 0) parts.Add("有償コイン" + Confirm.PaidCoins + "枚");
                if (Confirm.FreeCoins > 0) parts.Add("無償コイン" + Confirm.FreeCoins + "枚");
                if (Confirm.Horses > 0) parts.Add("馬" + Confirm.Horses + "頭");
                if (Confirm.Races > 0) parts.Add("レース" + Confirm.Races + "回");
                var what = parts.Count == 0 ? "この端末のデータ" : "この端末のデータ（" + string.Join("・", parts) + "）";
                return what + "は、引き継ぎの後に使えなくなります。";
            }
        }

        public bool CanRedeem(string codeId, string password) => State != RedeemState.Busy && TransferCodeRules.NormalizeCodeId(codeId) != null && !string.IsNullOrEmpty(TransferCodeRules.Normalize(password));

        public Task<bool> RedeemAsync(string codeId, string password, CancellationToken ct = default) { _confirmed = false; return Send(codeId, password, ct); }
        public Task<bool> ConfirmAsync(string codeId, string password, CancellationToken ct = default) { _confirmed = true; return Send(codeId, password, ct); }
        public void CancelConfirm() { if (State == RedeemState.NeedsConfirm) { State = RedeemState.Idle; Confirm = null; } }

        private async Task<bool> Send(string codeId, string password, CancellationToken ct)
        {
            if (State == RedeemState.Busy) return false;
            RedeemMessage = null;
            var id = TransferCodeRules.NormalizeCodeId(codeId);
            if (id == null) { State = RedeemState.Error; RedeemMessage = IdFormatText; return false; }
            if (!_online()) { State = RedeemState.Error; RedeemMessage = OfflineText; return false; }
            var pw = TransferCodeRules.Normalize(password);
            var key = KeyFor(id + "\n" + pw);
            State = RedeemState.Busy;
            TransferRedeemResult r;
            try { r = await _api.RedeemTransferCodeAsync(id, pw, _confirmed, key, _installId, ct); }
            catch (TransferException e) when (e.Code == ApiErrorCode.TransferConfirmRequired)
            {
                Confirm = e.Confirm;
                State = RedeemState.NeedsConfirm;
                return false;
            }
            catch (NetworkException) { State = RedeemState.Error; RedeemMessage = OfflineText; return false; }
            catch (ApiException e) { ForgetKey(); State = RedeemState.Error; RedeemMessage = ErrorText(e); return false; }
            ArrivedName = r.DisplayName;
            if (_signIn != null)
            {
                try { await _signIn.SignInWithCustomTokenAsync(r.CustomToken, ct); }
                catch (Exception)
                {
                    // the code is used; the same key brings a fresh token for the same account (server replay, 1 h)
                    State = RedeemState.Error; RedeemMessage = SignInLaterText; return false;
                }
            }
            ForgetKey();
            Confirm = null;
            State = RedeemState.Done;
            return true;
        }

        private string KeyFor(string attempt)
        {
            if (_pendingKey == null || _pendingFor != attempt) { _pendingKey = _newKey(); _pendingFor = attempt; }
            return _pendingKey;
        }
        private void ForgetKey() { _pendingKey = null; _pendingFor = null; }
        /// <summary>For tests and the screen's debug overlay: the key a retry would reuse (null = none pending).</summary>
        public string PendingKey => _pendingKey;

        /// <summary>One player-facing line per failure (no line ever tells whether an ID exists).</summary>
        public static string ErrorText(ApiException e)
        {
            switch (e.Code)
            {
                case ApiErrorCode.TransferInvalid: return InvalidText;
                case ApiErrorCode.TransferExpired: return ExpiredText;
                case ApiErrorCode.TransferLocked:
                    var min = e is TransferException t && t.RetryAfterSec > 0 ? (t.RetryAfterSec + 59) / 60 : 0;
                    return min > 0 ? "入力の回数が多すぎます。" + min + "分ほど待ってからお試しください" : LockedText;
                case ApiErrorCode.TransferSameAccount: return SameAccountText;
                case ApiErrorCode.TransferRefused: return e is TransferException r && r.Reason == TransferRefusedReasons.DeletionPending ? DeletionText : BannedText;
                case ApiErrorCode.TransferIssueLimit: return IssueLimitText;
                case ApiErrorCode.NotFound: return UnavailableText;
                case ApiErrorCode.Banned: return BannedText;
                case ApiErrorCode.DeletionPending: return "アカウント削除の手続き中は発行できません";
                case ApiErrorCode.Network: return OfflineText;
                default: return ErrorFallback;
            }
        }
    }
}
