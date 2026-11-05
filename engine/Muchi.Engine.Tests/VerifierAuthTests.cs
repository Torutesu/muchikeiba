using System;
using System.Collections.Generic;
using Muchi.Verifier;
using Xunit;

namespace Muchi.Engine.Tests
{
    public class VerifierAuthTests
    {
        private const string Secret = "0123456789abcdef0123456789abcdef-test";

        private static Func<string, string> Env(Dictionary<string, string> d) => k => d.TryGetValue(k, out var v) ? v : null;

        [Fact]
        public void OffWhenNoSecretAndNotRequired()
        {
            Assert.Null(VerifierAuth.FromEnvironment(Env(new Dictionary<string, string>())));
            Assert.True(VerifierAuth.IsAuthorized(null, null));
        }

        [Fact]
        public void RequiredButMissingFailsClosed()
        {
            Assert.Throws<InvalidOperationException>(() => VerifierAuth.FromEnvironment(Env(new Dictionary<string, string> { [VerifierAuth.RequireEnv] = "1" })));
        }

        [Fact]
        public void WeakSecretRejected()
        {
            Assert.Throws<InvalidOperationException>(() => VerifierAuth.FromEnvironment(Env(new Dictionary<string, string> { [VerifierAuth.SecretEnv] = "short" })));
        }

        [Fact]
        public void BearerMustMatchExactly()
        {
            string s = VerifierAuth.FromEnvironment(Env(new Dictionary<string, string> { [VerifierAuth.SecretEnv] = Secret, [VerifierAuth.RequireEnv] = "1" }));
            Assert.True(VerifierAuth.IsAuthorized("Bearer " + Secret, s));
            Assert.False(VerifierAuth.IsAuthorized(null, s));
            Assert.False(VerifierAuth.IsAuthorized("", s));
            Assert.False(VerifierAuth.IsAuthorized(Secret, s));
            Assert.False(VerifierAuth.IsAuthorized("Bearer " + Secret + "x", s));
            Assert.False(VerifierAuth.IsAuthorized("bearer " + Secret, s));
        }
    }
}
