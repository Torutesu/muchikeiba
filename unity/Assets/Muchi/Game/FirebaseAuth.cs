using System;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>
    /// The part of Firebase Auth the app needs. The real implementation (Firebase Unity SDK) lives in
    /// Assets/Muchi/Integration/FirebaseSdkAuth.cs behind the MUCHI_FIREBASE scripting define, so the project
    /// compiles (and these rules are tested) without the SDK.
    /// </summary>
    public interface IFirebaseAuthBackend
    {
        bool HasUser { get; }
        bool IsAnonymous { get; }
        string UserId { get; }
        Task SignInAnonymouslyAsync(CancellationToken ct);
        /// <summary>Firebase caches the ID token and refreshes it when it is close to expiry; force = always fetch a new one.</summary>
        Task<string> GetIdTokenAsync(bool forceRefresh, CancellationToken ct);
        /// <summary>Attaches an Apple/Google identity to the current (anonymous) user. Throws <see cref="CredentialInUseException"/>.</summary>
        Task LinkAsync(FederatedCredential credential, CancellationToken ct);
        /// <summary>Signs in as the user that owns this credential (account recovery on a new device).</summary>
        Task SignInWithAsync(FederatedCredential credential, CancellationToken ct);
    }

    /// <summary>
    /// REQ-TRF-009/010 (§54): the custom-token side of Firebase Auth, kept out of <see cref="IFirebaseAuthBackend"/> so existing
    /// backends keep compiling. The SDK backend (MUCHI_FIREBASE) implements both.
    /// </summary>
    public interface ICustomTokenAuthBackend
    {
        /// <summary>Signs in as the account a 引き継ぎコード redeem returned a custom token for.</summary>
        Task SignInWithCustomTokenAsync(string customToken, CancellationToken ct);
        /// <summary>Forgets the current user (after SESSION_REPLACED); the next request signs in anonymously again.</summary>
        void SignOut();
    }

    /// <summary>An Apple or Google sign-in result to link or sign in with.</summary>
    public sealed class FederatedCredential
    {
        public const string Apple = "apple.com";
        public const string Google = "google.com";
        public string Provider;
        public string IdToken;
        /// <summary>Apple: the raw nonce whose SHA-256 was sent to Sign in with Apple.</summary>
        public string RawNonce;
        /// <summary>Google: optional OAuth access token.</summary>
        public string AccessToken;
        /// <summary>
        /// An SDK credential to use as-is instead of building one from the tokens. Set when Firebase hands back a
        /// replacement credential after a failed link: Apple credentials are single-use, so switching accounts must
        /// sign in with the replacement (FirebaseAccountLinkException.UserInfo.UpdatedCredential), not the original.
        /// </summary>
        public object SdkCredential;

        public static FederatedCredential FromApple(string idToken, string rawNonce) => new FederatedCredential { Provider = Apple, IdToken = idToken, RawNonce = rawNonce };
        public static FederatedCredential FromGoogle(string idToken, string accessToken = null) => new FederatedCredential { Provider = Google, IdToken = idToken, AccessToken = accessToken };
        /// <summary>Wraps a replacement credential returned by the SDK (see <see cref="SdkCredential"/>).</summary>
        public static FederatedCredential FromSdk(string provider, object sdkCredential) => new FederatedCredential { Provider = provider, SdkCredential = sdkCredential };

        internal bool Usable => SdkCredential != null || !string.IsNullOrEmpty(IdToken);
    }

    /// <summary>The Apple/Google identity already belongs to another Muchi account.</summary>
    public sealed class CredentialInUseException : Exception
    {
        /// <summary>Credential to sign in with when switching to that account (null = the original can be reused, e.g. Google).</summary>
        public FederatedCredential Replacement { get; }
        public CredentialInUseException(string message = "credential already in use", FederatedCredential replacement = null) : base(message) { Replacement = replacement; }
    }

    /// <summary>The current user already has an identity of this provider (a different Apple/Google account is linked).</summary>
    public sealed class ProviderAlreadyLinkedException : Exception
    {
        public ProviderAlreadyLinkedException(string message = "provider already linked") : base(message) { }
    }

    /// <summary>
    /// Linked: done. CredentialInUse: another Muchi account owns this identity (UI may offer
    /// <see cref="FirebaseAuthTokenProvider.SwitchToExistingAccountAsync"/>). ProviderAlreadyLinked: this account already
    /// has an Apple/Google identity — nothing to switch to; tell the player it is already linked.
    /// </summary>
    public enum LinkResult { Linked, CredentialInUse, ProviderAlreadyLinked }

    /// <summary>
    /// REQ-API-001 (client side): Firebase ID tokens for <see cref="ApiClient"/>.
    ///  - First launch: signs in anonymously (no account screen; play starts immediately).
    ///  - Every request: the current ID token; on UNAUTHORIZED the client asks again with forceRefresh.
    ///  - Account linking: Apple/Google are linked to the anonymous user, so progress moves with the identity
    ///    (a reinstall or a new device signs in with it). If the identity already owns another account the
    ///    caller decides: keep the current progress (cancel) or <see cref="SwitchToExistingAccountAsync"/>.
    /// Sign-in runs once even when many requests ask for a token at the same time.
    /// </summary>
    public sealed class FirebaseAuthTokenProvider : IAuthTokenProvider
    {
        private readonly IFirebaseAuthBackend _auth;
        private readonly object _gate = new object();
        private Task _signIn;

        public FirebaseAuthTokenProvider(IFirebaseAuthBackend auth) { _auth = auth ?? throw new ArgumentNullException(nameof(auth)); }

        public string UserId => _auth.UserId;
        public bool IsAnonymous => _auth.IsAnonymous;

        /// <summary>Raised after the signed-in user changed (anonymous sign-in, switching accounts).</summary>
        public event Action<string> UserChanged;

        /// <summary>
        /// The ID token for <see cref="ApiClient"/>. Failures are reported as <see cref="ApiException"/> so every caller's
        /// offline/error path works: SDK and network problems → <see cref="NetworkException"/> (retry later), a backend that
        /// already classified its error (it throws ApiException) is passed through unchanged.
        /// </summary>
        public async Task<string> GetTokenAsync(bool forceRefresh, CancellationToken cancellationToken)
        {
            try
            {
                await EnsureSignedInAsync(cancellationToken);
                return await _auth.GetIdTokenAsync(forceRefresh, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (ApiException) { throw; }
            catch (Exception e) { throw new NetworkException("firebase: " + e.Message, e); }
        }

        public Task EnsureSignedInAsync(CancellationToken ct)
        {
            if (_auth.HasUser) return Task.CompletedTask;
            lock (_gate)
            {
                // A finished sign-in with no user means Firebase signed the user out since (refresh token revoked, user
                // deleted): sign in again instead of reusing the old, completed task. A running one is shared.
                if (_signIn == null || _signIn.IsCompleted) _signIn = SignInAnonymouslyOnce(ct);
                return _signIn;
            }
        }

        private async Task SignInAnonymouslyOnce(CancellationToken ct)
        {
            await _auth.SignInAnonymouslyAsync(ct);
            UserChanged?.Invoke(_auth.UserId);
        }

        /// <summary>Link Apple/Google to the current user (call from the settings / data transfer screen).</summary>
        public async Task<LinkResult> LinkAsync(FederatedCredential credential, CancellationToken ct = default)
        {
            if (credential == null || string.IsNullOrEmpty(credential.IdToken)) throw new ArgumentException("credential with an id token required");
            if (credential.Provider == FederatedCredential.Apple && string.IsNullOrEmpty(credential.RawNonce)) throw new ArgumentException("Sign in with Apple needs the raw nonce");
            await EnsureSignedInAsync(ct);
            PendingSwitchCredential = null;
            try
            {
                await _auth.LinkAsync(credential, ct);
                return LinkResult.Linked;
            }
            catch (CredentialInUseException e)
            {
                // Apple credentials are single-use: keep the SDK's replacement for the switch. Google can reuse the original.
                PendingSwitchCredential = e.Replacement ?? credential;
                return LinkResult.CredentialInUse;
            }
            catch (ProviderAlreadyLinkedException)
            {
                return LinkResult.ProviderAlreadyLinked;
            }
        }

        /// <summary>After <see cref="LinkResult.CredentialInUse"/>: the credential to switch with (the SDK's replacement when it gave one).</summary>
        public FederatedCredential PendingSwitchCredential { get; private set; }

        /// <summary>
        /// Recovery on a new device: sign in as the account that owns this identity. Progress of the current
        /// anonymous user on this device is left behind, so the UI must confirm with the player first.
        /// Pass null (or the credential that was just refused) to use <see cref="PendingSwitchCredential"/> — for Apple
        /// this is the single-use replacement Firebase returned, re-using the original would fail.
        /// </summary>
        public async Task SwitchToExistingAccountAsync(FederatedCredential credential = null, CancellationToken ct = default)
        {
            var pending = PendingSwitchCredential;
            var use = pending != null && (credential == null || credential.Provider == pending.Provider) ? pending : credential;
            if (use == null || !use.Usable) throw new ArgumentException("credential with an id token (or an SDK replacement credential) required");
            await _auth.SignInWithAsync(use, ct);
            PendingSwitchCredential = null;
            UserChanged?.Invoke(_auth.UserId);
        }

        /// <summary>True when the backend can sign in with a custom token (引き継ぎコード, REQ-TRF-009).</summary>
        public bool SupportsCustomToken => _auth is ICustomTokenAuthBackend;

        /// <summary>
        /// 引き継ぎコード (REQ-TRF-009): sign in as the original account with the custom token the redeem returned. Like
        /// <see cref="SwitchToExistingAccountAsync"/>, this device's anonymous progress is left behind (the server asked first).
        /// </summary>
        public async Task SignInWithCustomTokenAsync(string customToken, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(customToken)) throw new ArgumentException("custom token required");
            if (!(_auth is ICustomTokenAuthBackend c)) throw new NotSupportedException("this auth backend cannot sign in with a custom token");
            await c.SignInWithCustomTokenAsync(customToken, ct);
            PendingSwitchCredential = null;
            UserChanged?.Invoke(_auth.UserId);
        }

        /// <summary>
        /// REQ-TRF-010: after SESSION_REPLACED (the account moved to another device) — forget the user; the next request signs
        /// in anonymously as a new player. Returns false when the backend cannot sign out (nothing changed).
        /// </summary>
        public bool SignOutReplacedSession()
        {
            if (!(_auth is ICustomTokenAuthBackend c)) return false;
            c.SignOut();
            lock (_gate) _signIn = null;
            return true;
        }
    }
}
