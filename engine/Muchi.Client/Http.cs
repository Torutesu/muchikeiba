using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Muchi.Client
{
    /// <summary>One HTTP request. Path is relative to the API base URL (e.g. "/v1/player").</summary>
    public sealed class HttpRequest
    {
        public string Method;
        public string Path;
        public readonly Dictionary<string, string> Headers = new Dictionary<string, string>();
        /// <summary>JSON body or null.</summary>
        public string Body;

        public override string ToString() => Method + " " + Path;
    }

    /// <summary>HTTP response. Status 0 is not allowed: transport failures must throw (see <see cref="IHttp"/>).</summary>
    public sealed class HttpResponse
    {
        public int Status;
        public string Body;

        public HttpResponse() { }
        public HttpResponse(int status, string body) { Status = status; Body = body; }
    }

    /// <summary>
    /// Transport for the REST API. Codex implements this with UnityWebRequest.
    /// Throw any exception (e.g. <see cref="System.IO.IOException"/>) when no response was received
    /// (DNS failure, timeout, connection reset): ApiClient treats that as a network error and may retry.
    /// </summary>
    public interface IHttp
    {
        Task<HttpResponse> SendAsync(HttpRequest request, CancellationToken cancellationToken);
    }

    /// <summary>Firebase Auth ID token source (anonymous sign-in by default).</summary>
    public interface IAuthTokenProvider
    {
        /// <param name="forceRefresh">true after the server rejected the token with UNAUTHORIZED.</param>
        Task<string> GetTokenAsync(bool forceRefresh, CancellationToken cancellationToken);
    }

    /// <summary>Waiting, injectable so tests do not sleep.</summary>
    public interface IDelay
    {
        Task Delay(int milliseconds, CancellationToken cancellationToken);
    }

    public sealed class TaskDelay : IDelay
    {
        public static readonly TaskDelay Instance = new TaskDelay();
        public Task Delay(int milliseconds, CancellationToken cancellationToken) => Task.Delay(milliseconds, cancellationToken);
    }

    /// <summary>Creates idempotency keys. The default uses random GUIDs.</summary>
    public interface IIdGenerator
    {
        string NewId();
    }

    public sealed class GuidIdGenerator : IIdGenerator
    {
        public string NewId() => Guid.NewGuid().ToString("N");
    }

    /// <summary>Retry policy for safe requests (network errors, 5xx, 429). Exponential backoff with jitter.</summary>
    public sealed class RetryPolicy
    {
        public int MaxRetries = 3;
        public int BaseDelayMs = 300;
        public int MaxDelayMs = 4000;
        /// <summary>Returns a jitter in [0, max). Replace in tests for determinism.</summary>
        public Func<int, int> Jitter = max => max <= 0 ? 0 : ThreadSafeRandom.Next(max);

        public int DelayFor(int attempt)
        {
            long d = (long)BaseDelayMs << Math.Min(attempt, 16);
            if (d > MaxDelayMs) d = MaxDelayMs;
            return (int)d + Jitter((int)d / 4 + 1);
        }
    }

    internal static class ThreadSafeRandom
    {
        private static readonly object Gate = new object();
        private static readonly Random Rng = new Random();
        public static int Next(int max) { lock (Gate) return Rng.Next(max); }
    }
}
