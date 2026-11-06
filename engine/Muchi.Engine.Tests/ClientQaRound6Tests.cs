using Muchi.Client;

namespace Muchi.Engine.Tests
{
    /// <summary>Round 6 client QA: token provider failures must reach callers as ApiException (finding 1).</summary>
    public class ClientQaRound6Tests
    {
        private sealed class ThrowingAuth : IAuthTokenProvider
        {
            public Exception Error;
            public Task<string> GetTokenAsync(bool forceRefresh, CancellationToken ct) => throw Error;
        }

        private static ApiClient Api(IAuthTokenProvider auth, FakeHttp http)
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test/" };
            opt.Retry.Jitter = _ => 0;
            return new ApiClient(http, auth, opt, new FakeDelay(), new SeqIds());
        }

        [Fact]
        public async Task NonApiTokenFailureBecomesNetworkException()
        {
            var http = new FakeHttp();
            var api = Api(new ThrowingAuth { Error = new InvalidOperationException("FirebaseException: network error (token refresh)") }, http);
            var e = await Assert.ThrowsAsync<NetworkException>(() => api.GetPlayerAsync());
            Assert.Contains("token", e.Message);
            Assert.IsType<InvalidOperationException>(e.InnerException);
            Assert.Empty(http.Requests); // nothing was sent without a token
        }

        [Fact]
        public async Task ApiExceptionFromTokenProviderIsKept()
        {
            var api = Api(new ThrowingAuth { Error = new AuthException("NOT_SIGNED_IN", "signed out", 401) }, new FakeHttp());
            var e = await Assert.ThrowsAsync<AuthException>(() => api.GetPlayerAsync());
            Assert.Equal("NOT_SIGNED_IN", e.WireCode);
        }

        [Fact]
        public async Task CancellationIsNotWrapped()
        {
            using var cts = new CancellationTokenSource();
            cts.Cancel();
            var api = Api(new ThrowingAuth { Error = new OperationCanceledException(cts.Token) }, new FakeHttp());
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => api.GetPlayerAsync(cts.Token));
        }
    }
}
