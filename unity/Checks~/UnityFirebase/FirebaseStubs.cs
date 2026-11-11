// Compile-time stubs of the Firebase Unity SDK 11.x auth surface used by Assets/Muchi/Integration/FirebaseSdkAuth.cs.
// Shapes follow the SDK's public API (Firebase.FirebaseException.ErrorCode, Firebase.Auth.AuthError,
// FirebaseAccountLinkException.UserInfo.UpdatedCredential, Credential.IsValid, FirebaseUser.TokenAsync, …).
// They are an assumption, not the SDK: only for type-checking the MUCHI_FIREBASE build outside Unity.
using System.Threading.Tasks;

namespace Firebase
{
    public enum DependencyStatus { Available, UnavailableDisabled, UnavailableInvalid, UnavilableMissing, UnavailablePermission, UnavailableUpdaterequired, UnavailableUpdating, UnavailableOther }
    public class FirebaseException : System.Exception { public int ErrorCode { get; } }
    public sealed class FirebaseApp { public static Task<DependencyStatus> CheckAndFixDependenciesAsync() => Task.FromResult(DependencyStatus.Available); }
}

namespace Firebase.Auth
{
    public enum AuthError { None = 0, CredentialAlreadyInUse = 10, ProviderAlreadyLinked = 18, NetworkRequestFailed = 23 }
    public class Credential { public bool IsValid() => true; }
    public sealed class AdditionalUserInfo { public Credential UpdatedCredential { get; } }
    public sealed class FirebaseAccountLinkException : FirebaseException { public AdditionalUserInfo UserInfo { get; } }
    public sealed class AuthResult { public FirebaseUser User { get; } }
    public sealed class FirebaseUser
    {
        public bool IsAnonymous { get; }
        public string UserId { get; }
        public Task<string> TokenAsync(bool forceRefresh) => Task.FromResult("");
        public Task<AuthResult> LinkWithCredentialAsync(Credential credential) => Task.FromResult(new AuthResult());
    }
    public sealed class FirebaseAuth
    {
        public static FirebaseAuth DefaultInstance { get; } = new FirebaseAuth();
        public FirebaseUser CurrentUser { get; }
        public Task<AuthResult> SignInAnonymouslyAsync() => Task.FromResult(new AuthResult());
        public Task<FirebaseUser> SignInWithCredentialAsync(Credential credential) => Task.FromResult(new FirebaseUser());
        public Task<AuthResult> SignInWithCustomTokenAsync(string token) => Task.FromResult(new AuthResult());
        public void SignOut() { }
    }
    public static class OAuthProvider { public static Credential GetCredential(string providerId, string idToken, string rawNonce, string accessToken) => new Credential(); }
    public static class GoogleAuthProvider { public static Credential GetCredential(string idToken, string accessToken) => new Credential(); }
}
