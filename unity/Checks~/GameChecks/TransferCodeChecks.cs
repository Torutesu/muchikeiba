// 引き継ぎコード (REQ-TRF-001..020, contracts/protocol.md §54): TransferCodeModel over a fake API, the custom-token sign-in on
// FirebaseAuthTokenProvider (ICustomTokenAuthBackend), SESSION_REPLACED sign-out, English UI text.
using Muchi.Client;
using Muchi.Game;

static class TransferCodeChecks
{
    internal sealed class FakeApi : ITransferCodeApi
    {
        public readonly List<string> Calls = new List<string>();
        public readonly List<string> Keys = new List<string>();
        public TransferCodeStatus Status = new TransferCodeStatus
        {
            Enabled = true, IssuesPerDay = 5, ExpiryDays = 30, PasswordMin = 8, PasswordMax = 32,
            Rules = { new TransferRule { Id = "length", Text = "8〜32文字" }, new TransferRule { Id = "charset", Text = "半角の英数字と記号" }, new TransferRule { Id = "mix", Text = "英字と数字を両方使う" }, new TransferRule { Id = "common", Text = "よく使われるパスワードは使えません" } },
        };
        public Queue<Exception> RedeemErrors = new Queue<Exception>();
        public bool LostResponse;
        public Task<TransferCodeStatus> GetTransferCodeAsync(CancellationToken ct = default) { Calls.Add("status"); return Task.FromResult(Status); }
        public Task<IssuedTransferCode> IssueTransferCodeAsync(string password, CancellationToken ct = default)
        {
            Calls.Add(password == null ? "issue:generated" : "issue:custom");
            Status.Code = new TransferCodeInfo { CodeId = "K7M-Q3X-PHR", Mode = password == null ? "generated" : "custom", IssuedAt = 1794279600000, ExpiresAt = 1794279600000 + 30L * 86_400_000 };
            return Task.FromResult(new IssuedTransferCode { CodeId = "K7M-Q3X-PHR", Mode = Status.Code.Mode, Password = password == null ? "abcd-efgh-jkmn" : null });
        }
        public Task<bool> RevokeTransferCodeAsync(CancellationToken ct = default) { Calls.Add("revoke"); var had = Status.Code != null; Status.Code = null; return Task.FromResult(had); }
        public Task<TransferRedeemResult> RedeemTransferCodeAsync(string codeId, string password, bool confirmDiscard, string key, string installId = null, CancellationToken ct = default)
        {
            Calls.Add("redeem:" + codeId + ":" + confirmDiscard);
            Keys.Add(key);
            if (RedeemErrors.Count > 0) throw RedeemErrors.Dequeue();
            if (LostResponse) { LostResponse = false; throw new NetworkException("lost", null); }
            return Task.FromResult(new TransferRedeemResult { CustomToken = "ct-old", DisplayName = "ハヤテ", ExpiresInSec = 3600 });
        }
    }

    sealed class FakeFirebase : IFirebaseAuthBackend, ICustomTokenAuthBackend
    {
        public string Uid; public bool Anonymous; public int SignIns; public bool FailCustom;
        public bool HasUser => Uid != null;
        public bool IsAnonymous => Anonymous;
        public string UserId => Uid;
        public Task SignInAnonymouslyAsync(CancellationToken ct) { SignIns++; Uid = "anon-" + SignIns; Anonymous = true; return Task.CompletedTask; }
        public Task<string> GetIdTokenAsync(bool f, CancellationToken ct) => Task.FromResult("tok-" + Uid);
        public Task LinkAsync(FederatedCredential c, CancellationToken ct) => Task.CompletedTask;
        public Task SignInWithAsync(FederatedCredential c, CancellationToken ct) => Task.CompletedTask;
        public Task SignInWithCustomTokenAsync(string token, CancellationToken ct)
        {
            if (FailCustom) { FailCustom = false; throw new NetworkException("firebase offline", null); }
            Uid = token.Replace("ct-", ""); Anonymous = false; return Task.CompletedTask;
        }
        public void SignOut() { Uid = null; Anonymous = false; }
    }

    static TransferException Err(ApiErrorCode c, string wire, int status, string details = null)
        => new TransferException(c, wire, "x", status, details == null ? null : Muchi.Net.JsonNode.Parse(details));

    public static async Task Run(Action<bool, string> check)
    {
        // ---- issue screen
        var api = new FakeApi();
        var m = new TransferCodeModel(api);
        await m.LoadAsync();
        check(m.Visible && m.CodeLine == TransferCodeModel.NoCodeText && m.ExpiryLine == null, "issue screen: visible, no code yet");
        var lines = m.RuleLines("abc");
        check(lines.Count == 4 && !lines[0].Ok && lines[1].Ok && !lines[2].Ok && lines[3].Ok, "checklist ticks as the player types (length / mix broken for 'abc')");
        check(m.RuleLines("").All((l) => !l.Ok), "an empty field ticks nothing");
        check(!m.CanIssue("Haneda2026!", "Haneda2026") && m.CanIssue("Haneda2026!", "Haneda2026!"), "「発行する」 needs every rule and the same password twice");
        check(!await m.IssueAsync("Haneda2026!", "Haneda2027!") && m.Message == TransferCodeModel.MismatchText && !api.Calls.Contains("issue:custom"), "mismatch is caught on the device (nothing sent)");
        check(!await m.IssueAsync("Password1", "Password1") && m.Message == "よく使われるパスワードは使えません", "a common password is refused with its rule line");
        check(await m.IssueAsync("Haneda2026!", "Haneda2026!") && m.CodeLine == "K7M-Q3X-PHR" && m.GeneratedPassword == null && m.CopyText == "K7M-Q3X-PHR", "custom: the ID is shown and copied; the password is never echoed");
        check(m.ExpiryLine == "有効期限：" + ExchangeModel.JstDateTime(api.Status.Code.ExpiresAt - 60_000) + "まで", "expiry line in JST");
        check(await m.IssueAsync(null) && m.GeneratedPassword == "abcd-efgh-jkmn" && m.CopyText.Contains("abcd-efgh-jkmn"), "generated: shown once, included in the copy");
        m.LeaveIssueScreen();
        check(m.GeneratedPassword == null && m.CopyText == "K7M-Q3X-PHR", "leaving the screen forgets the generated password");
        check(await m.RevokeAsync() && m.Message == TransferCodeModel.RevokedText && m.CodeLine == TransferCodeModel.NoCodeText, "revoke");
        var off = new TransferCodeModel(new FakeApi { Status = new TransferCodeStatus { Enabled = false } });
        await off.LoadAsync();
        check(!off.Visible, "server switched off → the screen shows Apple / Google only");

        // ---- redeem screen
        var fb = new FakeFirebase();
        var tokens = new FirebaseAuthTokenProvider(fb);
        await tokens.GetTokenAsync(false, CancellationToken.None);
        string changed = null;
        tokens.UserChanged += (u) => changed = u;
        api = new FakeApi();
        int n = 0;
        var r = new TransferCodeModel(api, new FirebaseTransferSignIn(tokens), newKey: () => "key-" + (++n), installId: "install-1");
        check(r.RedeemAvailable && tokens.SupportsCustomToken, "redeem available with a custom-token backend");
        check(!r.CanRedeem("K7M-Q3X", "x") && r.CanRedeem("ｋ７ｍ－ｑ３ｘ－ｐｈｒ", "pw"), "CanRedeem normalises full-width / lower-case ids");
        check(!await r.RedeemAsync("K7M", "pw") && r.RedeemMessage == TransferCodeModel.IdFormatText && api.Calls.Count == 0, "malformed id: caught on the device");
        api.RedeemErrors.Enqueue(Err(ApiErrorCode.TransferConfirmRequired, "TRANSFER_CONFIRM_REQUIRED", 409, "{\"paidCoins\":310,\"freeCoins\":20,\"horses\":3,\"races\":5,\"purchases\":1}"));
        check(!await r.RedeemAsync("k7m-q3x-phr", "Haneda2026!") && r.State == RedeemState.NeedsConfirm, "this device has progress → confirm sheet");
        check(r.ConfirmText == "この端末のデータ（有償コイン310枚・無償コイン20枚・馬3頭・レース5回）は、引き継ぎの後に使えなくなります。", "confirm line names paid coins first: " + r.ConfirmText);
        api.LostResponse = true;
        check(!await r.ConfirmAsync("k7m-q3x-phr", "Haneda2026!") && r.RedeemMessage == TransferCodeModel.OfflineText && r.PendingKey == "key-1", "a lost response keeps the key");
        check(await r.ConfirmAsync("K7MQ3XPHR", "Haneda2026!") && r.State == RedeemState.Done, "retry succeeds");
        check(api.Keys.SequenceEqual(new[] { "key-1", "key-1", "key-1" }) && api.Calls.Last() == "redeem:K7MQ3XPHR:True", "one idempotency key across the attempt (confirm and retry): " + string.Join(",", api.Keys));
        check(fb.Uid == "old" && !fb.Anonymous && changed == "old" && r.ArrivedName == "ハヤテ" && r.State == RedeemState.Done, "signed in as the original account with the custom token");
        check(r.PendingKey == null, "the key is forgotten after the sign-in");

        // sign-in fails after a successful redeem: the same key brings a fresh token
        var fb2 = new FakeFirebase { FailCustom = true };
        var t2 = new FirebaseAuthTokenProvider(fb2);
        var api2 = new FakeApi();
        var r2 = new TransferCodeModel(api2, new FirebaseTransferSignIn(t2), newKey: () => "k" + (++n));
        check(!await r2.RedeemAsync("K7M-Q3X-PHR", "pw") && r2.RedeemMessage == TransferCodeModel.SignInLaterText && r2.PendingKey != null, "sign-in failed after the redeem: keep the key, ask to press again");
        var kept = r2.PendingKey;
        check(await r2.RedeemAsync("K7M-Q3X-PHR", "pw") && api2.Keys.Last() == kept && fb2.Uid == "old", "pressing again replays with the same key and signs in");

        // one message per failure, never "unknown id"
        var cases = new (Exception e, string text)[]
        {
            (Err(ApiErrorCode.TransferInvalid, "TRANSFER_INVALID", 400), TransferCodeModel.InvalidText),
            (Err(ApiErrorCode.TransferExpired, "TRANSFER_EXPIRED", 410), TransferCodeModel.ExpiredText),
            (Err(ApiErrorCode.TransferLocked, "TRANSFER_LOCKED", 429, "{\"retryAfterSec\":3600}"), "入力の回数が多すぎます。60分ほど待ってからお試しください"),
            (Err(ApiErrorCode.TransferSameAccount, "TRANSFER_SAME_ACCOUNT", 409), TransferCodeModel.SameAccountText),
            (Err(ApiErrorCode.TransferRefused, "TRANSFER_REFUSED", 403, "{\"reason\":\"banned\"}"), TransferCodeModel.BannedText),
            (Err(ApiErrorCode.TransferRefused, "TRANSFER_REFUSED", 403, "{\"reason\":\"deletion_pending\"}"), TransferCodeModel.DeletionText),
            (new ApiException(ApiErrorCode.NotFound, "NOT_FOUND", "x", 404), TransferCodeModel.UnavailableText),
        };
        foreach (var (e, text) in cases)
        {
            var a = new FakeApi();
            a.RedeemErrors.Enqueue(e);
            var mm = new TransferCodeModel(a, null, newKey: () => "k" + (++n));
            await mm.RedeemAsync("K7M-Q3X-PHR", "pw");
            check(mm.State == RedeemState.Error && mm.RedeemMessage == text && mm.PendingKey == null, ((ApiException)e).WireCode + " → " + text);
        }
        var offline = new TransferCodeModel(new FakeApi(), null, online: () => false);
        check(!await offline.RedeemAsync("K7M-Q3X-PHR", "pw") && offline.RedeemMessage == TransferCodeModel.OfflineText, "offline");

        // REQ-TRF-010: the old device after SESSION_REPLACED signs out; the next request is a new anonymous player
        var fb3 = new FakeFirebase();
        var t3 = new FirebaseAuthTokenProvider(fb3);
        await t3.GetTokenAsync(false, CancellationToken.None);
        check(t3.SignOutReplacedSession() && fb3.Uid == null, "SESSION_REPLACED: sign out");
        check(await t3.GetTokenAsync(false, CancellationToken.None) == "tok-anon-2", "...and the next request signs in anonymously again");

        // English
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(Root(), "engine", "Muchi.Client", "Resources", "Muchi", "ui-en.json")));
        Loc.LoadEnglish(File.ReadAllText(Path.Combine(Root(), "engine", "Muchi.Client", "Resources", "Muchi", "server-en.json")));
        Loc.SetLocale("en");
        try
        {
            var en = new[] { TransferCodeModel.IssueTitle, TransferCodeModel.RedeemTitle, TransferCodeModel.InvalidText, TransferCodeModel.ReplacedBody, r.ConfirmText ?? "この端末のデータ（有償コイン310枚・馬3頭）は、引き継ぎの後に使えなくなります。", TransferCodeModel.DoneText, "入力の回数が多すぎます。60分ほど待ってからお試しください", m.ExpiryLine ?? "有効期限：12月11日 11:59まで", "有効期限が切れています" };
            foreach (var s in en) check(!Loc.HasJapanese(Loc.T(s)), "English: " + Loc.T(s));
        }
        finally { Loc.SetLocale("ja"); }
    }

    static string Root()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "contracts", "protocol.md"))) d = d.Parent;
        return d!.FullName;
    }
}
