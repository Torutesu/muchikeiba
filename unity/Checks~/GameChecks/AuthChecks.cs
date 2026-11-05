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
        public Task<string> GetIdTokenAsync(bool force, CancellationToken ct) { TokenCalls++; if (force) ForcedTokens++; return Task.FromResult("tok-" + Uid + (force ? "-fresh" : "")); }
        public Task LinkAsync(FederatedCredential c, CancellationToken ct)
        {
            if (Owner != null && Owner != Uid) throw new CredentialInUseException();
            Linked = c.Provider; Anonymous = false; return Task.CompletedTask;
        }
        public Task SignInWithAsync(FederatedCredential c, CancellationToken ct) { Uid = Owner; Anonymous = false; return Task.CompletedTask; }
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
    }
}
