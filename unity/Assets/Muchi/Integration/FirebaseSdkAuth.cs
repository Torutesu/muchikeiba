// Firebase Unity SDK adapter for FirebaseAuthTokenProvider (Assets/Muchi/Game/FirebaseAuth.cs).
// Compiled only with the scripting define MUCHI_FIREBASE (Project Settings → Player → Scripting Define Symbols),
// after importing FirebaseAuth.unitypackage and adding google-services.json / GoogleService-Info.plist.
// Without the define the app keeps working with dev auth (local) or offline mode. See docs/handoff-unity-3d.md.
// Type-checked against stubs of the SDK API in unity/Checks~/UnityFirebase (not the real SDK).
#if MUCHI_FIREBASE
using System;
using System.Threading;
using System.Threading.Tasks;
using Firebase;
using Firebase.Auth;
using Muchi.Client;
using Muchi.Game;

namespace Muchi.Unity
{
    public sealed class FirebaseSdkAuthBackend : IFirebaseAuthBackend
    {
        private static FirebaseAuth Auth => FirebaseAuth.DefaultInstance;

        public bool HasUser => Auth.CurrentUser != null;
        public bool IsAnonymous => Auth.CurrentUser != null && Auth.CurrentUser.IsAnonymous;
        public string UserId => Auth.CurrentUser?.UserId;

        /// <summary>SDK errors → ApiException so callers' offline/error paths apply (no network → NetworkException, else AuthException).</summary>
        private static Exception Map(FirebaseException e) =>
            e.ErrorCode == (int)AuthError.NetworkRequestFailed
                ? (Exception)new NetworkException("firebase: " + e.Message, e)
                : new AuthException("FIREBASE_" + ((AuthError)e.ErrorCode).ToString().ToUpperInvariant(), "firebase: " + e.Message, 401);

        public async Task SignInAnonymouslyAsync(CancellationToken ct)
        {
            try { await Auth.SignInAnonymouslyAsync(); }
            catch (FirebaseException e) { throw Map(e); }
        }

        public async Task<string> GetIdTokenAsync(bool forceRefresh, CancellationToken ct)
        {
            // The provider signs in again when HasUser turns false (signed out since); a null user here is a race with that.
            var user = Auth.CurrentUser ?? throw new AuthException("NOT_SIGNED_IN", "firebase: not signed in", 401);
            try { return await user.TokenAsync(forceRefresh); }
            catch (FirebaseException e) { throw Map(e); }
        }

        private static Credential ToCredential(FederatedCredential c)
        {
            if (c.SdkCredential is Credential sdk) return sdk; // replacement handed back by Firebase (Apple: single-use)
            return c.Provider == FederatedCredential.Apple
                ? OAuthProvider.GetCredential("apple.com", c.IdToken, c.RawNonce, null)
                : GoogleAuthProvider.GetCredential(c.IdToken, c.AccessToken);
        }

        public async Task LinkAsync(FederatedCredential credential, CancellationToken ct)
        {
            var user = Auth.CurrentUser ?? throw new AuthException("NOT_SIGNED_IN", "firebase: not signed in", 401);
            try
            {
                await user.LinkWithCredentialAsync(ToCredential(credential));
            }
            catch (FirebaseAccountLinkException e) when (e.ErrorCode == (int)AuthError.CredentialAlreadyInUse)
            {
                // The original Apple credential is spent: switching must use the replacement Firebase returns here.
                var updated = e.UserInfo?.UpdatedCredential;
                throw new CredentialInUseException(e.Message, updated != null && updated.IsValid() ? FederatedCredential.FromSdk(credential.Provider, updated) : null);
            }
            catch (FirebaseException e) when (e.ErrorCode == (int)AuthError.CredentialAlreadyInUse)
            {
                throw new CredentialInUseException(e.Message);
            }
            catch (FirebaseException e) when (e.ErrorCode == (int)AuthError.ProviderAlreadyLinked)
            {
                // This account already has an identity of this provider: not "owned by another account".
                throw new ProviderAlreadyLinkedException(e.Message);
            }
            catch (FirebaseException e) { throw Map(e); }
        }

        public async Task SignInWithAsync(FederatedCredential credential, CancellationToken ct)
        {
            try { await Auth.SignInWithCredentialAsync(ToCredential(credential)); }
            catch (FirebaseException e) { throw Map(e); }
        }
    }

    /// <summary>
    /// Startup wiring (MuchiApp, under MUCHI_FIREBASE): <see cref="Prepare"/> before <see cref="MuchiServices.Create"/> so
    /// the API client gets the token provider even when the first launch is offline, then <see cref="InitializeAsync"/>
    /// (dependency check + first sign-in, failures tolerated — the provider signs in on the next request).
    /// </summary>
    public static class MuchiFirebase
    {
        public static FirebaseAuthTokenProvider Tokens { get; private set; }
        public static bool Available { get; private set; }

        /// <summary>No network: creates the provider and hands it to <see cref="MuchiServices"/>.</summary>
        public static void Prepare()
        {
            if (Tokens != null) return;
            Tokens = new FirebaseAuthTokenProvider(new FirebaseSdkAuthBackend());
            MuchiServices.FirebaseTokens = Tokens;
        }

        /// <summary>Returns false (instead of throwing) when Firebase is unavailable or the first sign-in failed.</summary>
        public static async Task<bool> InitializeAsync()
        {
            Prepare();
            var status = await FirebaseApp.CheckAndFixDependenciesAsync();
            Available = status == DependencyStatus.Available;
            if (!Available) { UnityEngine.Debug.LogWarning("Firebase dependencies unavailable: " + status); return false; }
            try { await Tokens.EnsureSignedInAsync(CancellationToken.None); return true; }
            catch (Exception e) { UnityEngine.Debug.LogWarning("firebase sign-in (will retry on the next request): " + e.Message); return false; }
        }
    }
}
#endif
