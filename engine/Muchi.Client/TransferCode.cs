using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-TRF-001..020: 引き継ぎコード (server/src/domain/transferCode.ts / transferService.ts, contracts/protocol.md §54).
    // The old device issues an ID + password; the new device enters them and receives a Firebase custom token for the
    // original account (same uid — paid coins and purchases stay with it). Passwords never leave the screens except in the
    // issue / redeem request bodies; never log them. A server-generated password is in the issue response once, only.

    /// <summary>The same normalisation, formats and password rules as the server (transferCode.ts), so screens can check as the player types.</summary>
    public static class TransferCodeRules
    {
        public const string IdAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
        public const string GeneratedAlphabet = "23456789abcdefghjkmnpqrstuvwxyz";
        public const int IdLength = 9, GeneratedLength = 12, DefaultMin = 8, DefaultMax = 32;
        public const string Length = "length", Charset = "charset", Mix = "mix", Common = "common";
        public static readonly string[] AllRules = { Length, Charset, Mix, Common };
        public const string ModeCustom = "custom", ModeGenerated = "generated";

        /// <summary>Lower-case, compared after normalisation (server COMMON_PASSWORDS).</summary>
        public static readonly string[] CommonPasswords =
        {
            "password1", "password12", "password123", "passw0rd", "p@ssw0rd", "qwerty123", "qwerty12", "qwer1234", "asdf1234", "abcd1234", "abc12345", "a1234567",
            "abc123456", "1234abcd", "1q2w3e4r", "1qaz2wsx", "zaq12wsx", "iloveyou1", "monkey123", "dragon123", "baseball1", "letmein1", "welcome1", "muchi1234", "keiba1234",
        };

        private const string Dashes = "-‐‑‒–—―−ーｰ";

        /// <summary>NFKC (full-width → half-width), spaces and dashes removed — what the server hashes and compares.</summary>
        public static string Normalize(string raw)
        {
            if (raw == null) return "";
            // full-width ASCII → half-width first (the part of NFKC that matters here; works without ICU, e.g. invariant
            // globalization), then NFKC where the runtime has it. The server applies NFKC again, so both agree.
            var f = new StringBuilder(raw.Length);
            foreach (var ch in raw) f.Append(ch >= '！' && ch <= '～' ? (char)(ch - 0xFEE0) : ch == '　' ? ' ' : ch);
            var s = f.ToString();
            try { s = s.Normalize(NormalizationForm.FormKC); } catch (PlatformNotSupportedException) { }
            var b = new StringBuilder(s.Length);
            foreach (var ch in s) if (!char.IsWhiteSpace(ch) && Dashes.IndexOf(ch) < 0) b.Append(ch);
            return b.ToString();
        }

        /// <summary>The canonical 9-character id, or null when it is not one.</summary>
        public static string NormalizeCodeId(string raw)
        {
            var s = Normalize(raw).ToUpperInvariant();
            if (s.Length != IdLength) return null;
            foreach (var ch in s) if (IdAlphabet.IndexOf(ch) < 0) return null;
            return s;
        }

        /// <summary>K7MQ3XPHR → K7M-Q3X-PHR (already formatted input is returned formatted).</summary>
        public static string FormatCodeId(string id)
        {
            var n = NormalizeCodeId(id);
            return n == null ? id : n.Substring(0, 3) + "-" + n.Substring(3, 3) + "-" + n.Substring(6, 3);
        }

        /// <summary>Every rule a custom password breaks (empty = acceptable), in the server's order.</summary>
        public static List<string> PasswordProblems(string password, int min = DefaultMin, int max = DefaultMax)
        {
            var pw = Normalize(password);
            var out_ = new List<string>();
            int len = 0;
            for (int i = 0; i < pw.Length; i++) { len++; if (char.IsHighSurrogate(pw[i]) && i + 1 < pw.Length) i++; }
            if (len < min || len > max) out_.Add(Length);
            if (pw.Any((c) => c < 0x21 || c > 0x7e)) out_.Add(Charset);
            if (!pw.Any((c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) || !pw.Any((c) => c >= '0' && c <= '9')) out_.Add(Mix);
            if (CommonPasswords.Contains(pw.ToLowerInvariant())) out_.Add(Common);
            return out_;
        }
    }

    public sealed class TransferRule
    {
        public string Id, Text;
        internal static TransferRule Parse(JsonNode o) => new TransferRule { Id = J.Str(o, "id"), Text = J.Str(o, "text") };
    }

    public sealed class TransferCodeInfo
    {
        /// <summary>Formatted <c>ABC-DEF-GHJ</c>. Not a secret on its own; the password is never returned.</summary>
        public string CodeId, Mode;
        public long IssuedAt, ExpiresAt;
        public bool Expired;
        internal static TransferCodeInfo Parse(JsonNode o) => o == null || o.IsNull ? null : new TransferCodeInfo
        {
            CodeId = J.Str(o, "codeId"), Mode = J.Str(o, "mode"), IssuedAt = J.Long(o, "issuedAt"), ExpiresAt = J.Long(o, "expiresAt"), Expired = J.Bool(o, "expired"),
        };
    }

    /// <summary>GET /v1/transfer/code.</summary>
    public sealed class TransferCodeStatus
    {
        /// <summary>False: switched off or no signing key on the server — show Apple / Google only.</summary>
        public bool Enabled;
        public TransferCodeInfo Code;
        public long? LastTransferredAt;
        public int IssuesToday, IssuesPerDay, PasswordMin = TransferCodeRules.DefaultMin, PasswordMax = TransferCodeRules.DefaultMax, ExpiryDays;
        public List<TransferRule> Rules = new List<TransferRule>();
        internal static TransferCodeStatus Parse(JsonNode o) => new TransferCodeStatus
        {
            Enabled = J.Bool(o, "enabled"), Code = TransferCodeInfo.Parse(J.Opt(o, "code")), LastTransferredAt = J.LongN(o, "lastTransferredAt"),
            IssuesToday = J.Int(o, "issuesToday"), IssuesPerDay = J.Int(o, "issuesPerDay"),
            PasswordMin = J.Int(o, "passwordMin", TransferCodeRules.DefaultMin),
            PasswordMax = J.Int(o, "passwordMax", TransferCodeRules.DefaultMax),
            ExpiryDays = J.Int(o, "expiryDays"), Rules = J.List(o, "rules", TransferRule.Parse),
        };
    }

    /// <summary>POST /v1/transfer/code. <see cref="Password"/> is set only for a generated password and only in this response.</summary>
    public sealed class IssuedTransferCode
    {
        public string CodeId, Mode, Password;
        public long IssuedAt, ExpiresAt;
        internal static IssuedTransferCode Parse(JsonNode o) => new IssuedTransferCode
        {
            CodeId = J.Str(o, "codeId"), Mode = J.Str(o, "mode"), Password = J.Str(o, "password"), IssuedAt = J.Long(o, "issuedAt"), ExpiresAt = J.Long(o, "expiresAt"),
        };
    }

    /// <summary>POST /v1/transfer/redeem: sign in with <see cref="CustomToken"/> (FirebaseAuthTokenProvider.SignInWithCustomTokenAsync).</summary>
    public sealed class TransferRedeemResult
    {
        public string CustomToken, DisplayName;
        public int ExpiresInSec;
        internal static TransferRedeemResult Parse(JsonNode o) => new TransferRedeemResult { CustomToken = J.Str(o, "customToken"), DisplayName = J.Str(o, "displayName"), ExpiresInSec = J.Int(o, "expiresInSec") };
    }

    /// <summary>409 TRANSFER_CONFIRM_REQUIRED: what this device's own account would leave behind (the confirm screen).</summary>
    public sealed class TransferConfirm
    {
        public int PaidCoins, FreeCoins, Horses, Races, Purchases;
        internal static TransferConfirm Parse(JsonNode o) => o == null ? null : new TransferConfirm
        {
            PaidCoins = J.Int(o, "paidCoins"), FreeCoins = J.Int(o, "freeCoins"), Horses = J.Int(o, "horses"), Races = J.Int(o, "races"), Purchases = J.Int(o, "purchases"),
        };
    }

    public static class TransferRefusedReasons
    {
        public const string Banned = "banned", DeletionPending = "deletion_pending";
    }

    /// <summary>TRANSFER_* errors with their details (weak password rules, the lock's wait, the refusal reason, the confirmation).</summary>
    public sealed class TransferException : ApiException
    {
        public List<string> Rules { get; }
        public int RetryAfterSec { get; }
        public string Reason { get; }
        public TransferConfirm Confirm { get; }
        public TransferException(ApiErrorCode c, string wire, string message, int status, JsonNode details) : base(c, wire, message, status)
        {
            Rules = details == null ? new List<string>() : J.List(details, "rules", (n) => n.AsString());
            RetryAfterSec = details == null ? 0 : J.Int(details, "retryAfterSec");
            Reason = details == null ? null : J.Str(details, "reason");
            Confirm = c == ApiErrorCode.TransferConfirmRequired ? TransferConfirm.Parse(details) : null;
        }
    }

    /// <summary>401 SESSION_REPLACED: this account moved to another device. Never retried; sign out and show the notice.</summary>
    public sealed class SessionReplacedException : ApiException
    {
        public SessionReplacedException(string wire, string message, int status) : base(ApiErrorCode.SessionReplaced, wire, message, status) { }
    }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-TRF-010: raised once per response that says this device's session was moved to another device.</summary>
        public event Action SessionReplaced;
        internal void NoteSessionReplaced() => SessionReplaced?.Invoke();

        public Task<TransferCodeStatus> GetTransferCodeAsync(CancellationToken ct = default)
            => Call("GET", "/v1/transfer/code", null, true, null, true, TransferCodeStatus.Parse, ct);

        /// <summary>Issues a new code (the previous one stops working). <paramref name="password"/> null = let the server create one.</summary>
        public Task<IssuedTransferCode> IssueTransferCodeAsync(string password, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            if (password == null) b.Set("mode", TransferCodeRules.ModeGenerated);
            else { b.Set("mode", TransferCodeRules.ModeCustom); b.Set("password", password); }
            // not retried: a lost response would issue a second code (the first one silently replaced)
            return Call("POST", "/v1/transfer/code", b, true, null, false, IssuedTransferCode.Parse, ct);
        }

        public Task<bool> RevokeTransferCodeAsync(CancellationToken ct = default)
            => Call("DELETE", "/v1/transfer/code", null, true, null, true, (o) => J.Bool(o, "revoked"), ct);

        /// <summary>
        /// Enters an id + password on the new device. Keep <paramref name="idempotencyKey"/> until the custom-token sign-in has
        /// finished: a retry with the same key after a lost response gets a fresh token instead of "invalid" (the code is used).
        /// </summary>
        public Task<TransferRedeemResult> RedeemTransferCodeAsync(string codeId, string password, bool confirmDiscard, string idempotencyKey, string installId = null, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(idempotencyKey)) throw new ArgumentException("an idempotency key is required");
            var b = JsonNode.Obj();
            b.Set("codeId", codeId ?? "");
            b.Set("password", password ?? "");
            if (confirmDiscard) b.Set("confirmDiscard", true);
            if (!string.IsNullOrEmpty(installId)) b.Set("installId", installId);
            return Call("POST", "/v1/transfer/redeem", b, true, idempotencyKey, true, TransferRedeemResult.Parse, ct);
        }
    }
}
