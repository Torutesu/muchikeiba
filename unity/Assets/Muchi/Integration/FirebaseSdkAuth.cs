// Firebase Unity SDK adapter for FirebaseAuthTokenProvider (Assets/Muchi/Game/FirebaseAuth.cs).
// Compiled only with the scripting define MUCHI_FIREBASE (Project Settings → Player → Scripting Define Symbols),
// after importing FirebaseAuth.unitypackage and adding google-services.json / GoogleService-Info.plist.
// Without the define the app keeps working with dev auth (local) or offline mode. See docs/handoff-unity-3d.md.
#if MUCHI_FIREBASE
using System;
using System.Threading;
using System.Threading.Tasks;
using Firebase;
using Firebase.Auth;
using Muchi.Game;

namespace Muchi.Unity
{
    public sealed class FirebaseSdkAuthBackend : IFirebaseAuthBackend
    {
        private static FirebaseAuth Auth => FirebaseAuth.DefaultInstance;

        public bool HasUser => Auth.CurrentUser != null;
        public bool IsAnonymous => Auth.CurrentUser != null && Auth.CurrentUser.IsAnonymous;
        public string UserId => Auth.CurrentUser?.UserId;

        public async Task SignInAnonymouslyAsync(CancellationToken ct) { await Auth.SignInAnonymouslyAsync(); }

        public Task<string> GetIdTokenAsync(bool forceRefresh, CancellationToken ct)
        {
            var user = Auth.CurrentUser ?? throw new InvalidOperationException("not signed in");
            return user.TokenAsync(forceRefresh);
        }

        private static Credential ToCredential(FederatedCredential c) =>
            c.Provider == FederatedCredential.Apple
                ? OAuthProvider.GetCredential("apple.com", c.IdToken, c.RawNonce, null)
                : GoogleAuthProvider.GetCredential(c.IdToken, c.AccessToken);

        public async Task LinkAsync(FederatedCredential credential, CancellationToken ct)
        {
            var user = Auth.CurrentUser ?? throw new InvalidOperationException("not signed in");
            try
            {
                await user.LinkWithCredentialAsync(ToCredential(credential));
            }
            catch (FirebaseException e) when (e.ErrorCode == (int)AuthError.CredentialAlreadyInUse || e.ErrorCode == (int)AuthError.ProviderAlreadyLinked)
            {
                throw new CredentialInUseException(e.Message);
            }
        }

        public async Task SignInWithAsync(FederatedCredential credential, CancellationToken ct) { await Auth.SignInWithCredentialAsync(ToCredential(credential)); }
    }

    /// <summary>Call <see cref="InitializeAsync"/> once at startup, before <see cref="MuchiServices.Create"/>.</summary>
    public static class MuchiFirebase
    {
        public static FirebaseAuthTokenProvider Tokens { get; private set; }

        public static async Task InitializeAsync()
        {
            var status = await FirebaseApp.CheckAndFixDependenciesAsync();
            if (status != DependencyStatus.Available) throw new InvalidOperationException("Firebase dependencies unavailable: " + status);
            Tokens = new FirebaseAuthTokenProvider(new FirebaseSdkAuthBackend());
            await Tokens.EnsureSignedInAsync(CancellationToken.None);
            MuchiServices.FirebaseTokens = Tokens;
        }
    }
}
#endif
