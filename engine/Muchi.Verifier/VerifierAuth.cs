using System.Security.Cryptography;
using System.Text;

namespace Muchi.Verifier
{
    /// <summary>
    /// Service-to-service auth for <c>POST /verify</c>: only the Worker (which holds the shared secret) may call it.
    /// The secret comes from <c>VERIFIER_AUTH_SECRET</c> (Cloud Run: Secret Manager). Compared in constant time.
    /// With <c>VERIFIER_REQUIRE_AUTH=1</c> (set in the container image) the service refuses to start without a secret,
    /// so a misconfigured deploy fails closed instead of exposing an open verifier.
    /// </summary>
    public static class VerifierAuth
    {
        public const string SecretEnv = "VERIFIER_AUTH_SECRET";
        public const string RequireEnv = "VERIFIER_REQUIRE_AUTH";
        public const int MinSecretLength = 32;

        /// <summary>Reads the configured secret. Returns null when auth is off (local dev). Throws when required but missing/weak.</summary>
        public static string FromEnvironment(Func<string, string> getEnv)
        {
            string secret = getEnv(SecretEnv);
            bool required = getEnv(RequireEnv) == "1";
            if (string.IsNullOrEmpty(secret))
            {
                if (required) throw new InvalidOperationException(SecretEnv + " is required (" + RequireEnv + "=1) but not set");
                return null;
            }
            if (secret.Length < MinSecretLength) throw new InvalidOperationException(SecretEnv + " must be at least " + MinSecretLength + " characters");
            return secret;
        }

        /// <summary>True when auth is off, or the Authorization header is exactly <c>Bearer &lt;secret&gt;</c>.</summary>
        public static bool IsAuthorized(string authorizationHeader, string secret)
        {
            if (secret == null) return true;
            if (string.IsNullOrEmpty(authorizationHeader)) return false;
            // hash both sides so the comparison is constant-time regardless of length
            byte[] a = SHA256.HashData(Encoding.UTF8.GetBytes(authorizationHeader));
            byte[] b = SHA256.HashData(Encoding.UTF8.GetBytes("Bearer " + secret));
            return CryptographicOperations.FixedTimeEquals(a, b);
        }
    }
}
