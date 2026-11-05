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

        public static FederatedCredential FromApple(string idToken, string rawNonce) => new FederatedCredential { Provider = Apple, IdToken = idToken, RawNonce = rawNonce };
        public static FederatedCredential FromGoogle(string idToken, string accessToken = null) => new FederatedCredential { Provider = Google, IdToken = idToken, AccessToken = accessToken };
    }

    /// <summary>The Apple/Google identity already belongs to another Muchi account.</summary>
    public sealed class CredentialInUseException : Exception
    {
        public CredentialInUseException(string message = "credential already in use") : base(message) { }
    }

    public enum LinkResult { Linked, CredentialInUse }

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

        public async Task<string> GetTokenAsync(bool forceRefresh, CancellationToken cancellationToken)
        {
            await EnsureSignedInAsync(cancellationToken);
            return await _auth.GetIdTokenAsync(forceRefresh, cancellationToken);
        }

        public Task EnsureSignedInAsync(CancellationToken ct)
        {
            if (_auth.HasUser) return Task.CompletedTask;
            lock (_gate)
            {
                if (_signIn == null || _signIn.IsFaulted || _signIn.IsCanceled) _signIn = SignInAnonymouslyOnce(ct);
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
            try
            {
                await _auth.LinkAsync(credential, ct);
                return LinkResult.Linked;
            }
            catch (CredentialInUseException)
            {
                return LinkResult.CredentialInUse;
            }
        }

        /// <summary>
        /// Recovery on a new device: sign in as the account that owns this identity. Progress of the current
        /// anonymous user on this device is left behind, so the UI must confirm with the player first.
        /// </summary>
        public async Task SwitchToExistingAccountAsync(FederatedCredential credential, CancellationToken ct = default)
        {
            if (credential == null || string.IsNullOrEmpty(credential.IdToken)) throw new ArgumentException("credential with an id token required");
            await _auth.SignInWithAsync(credential, ct);
            UserChanged?.Invoke(_auth.UserId);
        }
    }
}
