// Checks for FirebaseAuthTokenProvider (Assets/Muchi/Game/FirebaseAuth.cs) with a fake Firebase backend.
using Muchi.Game;

static class AuthChecks
{
    sealed class FakeFirebase : IFirebaseAuthBackend
    {
        public string Uid;
        public bool Anonymous;
        public int SignIns, TokenCalls, ForcedTokens;
        public string Owner; // uid that already owns the linked identity, if any
        public string Linked;
        public bool FailNextSignIn;
        public bool AppleSingleUse; // like Firebase: an Apple credential refused by a link cannot be used again
        public string LinkedProvider; // the current user already has this provider linked
        public Exception TokenError;
        public object Replacement = new object();
        public FederatedCredential SignedInWith;
        private readonly HashSet<FederatedCredential> _spent = new HashSet<FederatedCredential>();
        public bool HasUser => Uid != null;
        public bool IsAnonymous => Anonymous;
        public string UserId => Uid;
        public async Task SignInAnonymouslyAsync(CancellationToken ct)
        {
            await Task.Delay(20, ct);
            SignIns++;
            if (FailNextSignIn) { FailNextSignIn = false; throw new Exception("network"); }
            Uid = "anon-" + SignIns; Anonymous = true;
        }
        public void SignOut() { Uid = null; Anonymous = false; }
        public Task<string> GetIdTokenAsync(bool force, CancellationToken ct) { if (TokenError != null) throw TokenError; TokenCalls++; if (force) ForcedTokens++; return Task.FromResult("tok-" + Uid + (force ? "-fresh" : "")); }
        public Task LinkAsync(FederatedCredential c, CancellationToken ct)
        {
            if (LinkedProvider == c.Provider) throw new ProviderAlreadyLinkedException();
            if (Owner != null && Owner != Uid)
            {
                if (AppleSingleUse && c.Provider == FederatedCredential.Apple) { _spent.Add(c); throw new CredentialInUseException("in use", FederatedCredential.FromSdk(c.Provider, Replacement)); }
                throw new CredentialInUseException();
            }
            Linked = c.Provider; Anonymous = false; return Task.CompletedTask;
        }
        public Task SignInWithAsync(FederatedCredential c, CancellationToken ct)
        {
            if (_spent.Contains(c)) throw new InvalidOperationException("Apple credential already used");
            SignedInWith = c; Uid = Owner; Anonymous = false; return Task.CompletedTask;
        }
    }

    public static async Task Run(Action<bool, string> check)
    {
        var fb = new FakeFirebase();
        var p = new FirebaseAuthTokenProvider(fb);
        string changed = null;
        p.UserChanged += (u) => changed = u;
        var tokens = await Task.WhenAll(Enumerable.Range(0, 8).Select((_) => p.GetTokenAsync(false, CancellationToken.None)));
        check(fb.SignIns == 1 && tokens.All((t) => t == "tok-anon-1"), "first launch: one anonymous sign-in even with 8 concurrent requests");
        check(changed == "anon-1", "UserChanged reports the new anonymous user");
        check(await p.GetTokenAsync(true, CancellationToken.None) == "tok-anon-1-fresh" && fb.ForcedTokens == 1, "forceRefresh (after UNAUTHORIZED) fetches a fresh token");

        var fb2 = new FakeFirebase { FailNextSignIn = true };
        var p2 = new FirebaseAuthTokenProvider(fb2);
        bool threw = false;
        try { await p2.GetTokenAsync(false, CancellationToken.None); } catch { threw = true; }
        check(threw && await p2.GetTokenAsync(false, CancellationToken.None) == "tok-anon-2", "a failed sign-in is retried on the next request (not cached)");

        check(await p.LinkAsync(FederatedCredential.FromGoogle("gid")) == LinkResult.Linked && fb.Linked == "google.com" && !p.IsAnonymous, "linking Google keeps the same user (progress moves with the identity)");
        bool needsNonce = false;
        try { await p.LinkAsync(FederatedCredential.FromApple("aid", null)); } catch (ArgumentException) { needsNonce = true; }
        check(needsNonce, "Sign in with Apple without the raw nonce is refused");

        var other = new FakeFirebase { Owner = "existing-user" };
        var p3 = new FirebaseAuthTokenProvider(other);
        await p3.GetTokenAsync(false, CancellationToken.None);
        check(await p3.LinkAsync(FederatedCredential.FromApple("aid", "nonce")) == LinkResult.CredentialInUse, "identity owned by another account → CredentialInUse (UI asks the player)");
        await p3.SwitchToExistingAccountAsync(FederatedCredential.FromApple("aid", "nonce"));
        check(p3.UserId == "existing-user" && await p3.GetTokenAsync(false, CancellationToken.None) == "tok-existing-user", "switching to the existing account (new device recovery)");

        // QA round 6: Apple credentials are single-use - switching must use Firebase's replacement credential.
        var apple = new FakeFirebase { Owner = "apple-owner", AppleSingleUse = true };
        var pa = new FirebaseAuthTokenProvider(apple);
        await pa.GetTokenAsync(false, CancellationToken.None);
        var original = FederatedCredential.FromApple("aid", "nonce");
        check(await pa.LinkAsync(original) == LinkResult.CredentialInUse && pa.PendingSwitchCredential?.SdkCredential == apple.Replacement, "Apple link refused -> the SDK's replacement credential is kept for the switch");
        string switchError = null;
        try { await pa.SwitchToExistingAccountAsync(original); } catch (Exception e) { switchError = e.Message; }
        check(switchError == null && apple.SignedInWith?.SdkCredential == apple.Replacement && pa.UserId == "apple-owner", "switching after an Apple refusal signs in with the replacement, not the spent original (" + (switchError ?? "ok") + ")");
        check(pa.PendingSwitchCredential == null, "...and the pending replacement is cleared");

        var linked = new FakeFirebase { LinkedProvider = FederatedCredential.Google };
        var pl = new FirebaseAuthTokenProvider(linked);
        await pl.GetTokenAsync(false, CancellationToken.None);
        check(await pl.LinkAsync(FederatedCredential.FromGoogle("other-gid")) == LinkResult.ProviderAlreadyLinked && pl.PendingSwitchCredential == null, "a second Google account on an already-linked user -> ProviderAlreadyLinked (not an account switch)");

        // Firebase signed the user out (token revoked / user deleted): the next request signs in again.
        var gone = new FakeFirebase();
        var pg = new FirebaseAuthTokenProvider(gone);
        await pg.GetTokenAsync(false, CancellationToken.None);
        gone.SignOut();
        check(await pg.GetTokenAsync(false, CancellationToken.None) == "tok-anon-2" && gone.SignIns == 2, "after Firebase signs the user out, the next request signs in anonymously again");

        // SDK failures reach ApiClient as ApiException so screens' offline/error paths handle them.
        var broken = new FakeFirebase { TokenError = new InvalidOperationException("sdk exploded") };
        var pb = new FirebaseAuthTokenProvider(broken);
        Exception thrown = null;
        try { await pb.GetTokenAsync(false, CancellationToken.None); } catch (Exception e) { thrown = e; }
        check(thrown is Muchi.Client.NetworkException, "a Firebase SDK error while getting a token surfaces as NetworkException (" + thrown?.GetType().Name + ")");
    }
}
