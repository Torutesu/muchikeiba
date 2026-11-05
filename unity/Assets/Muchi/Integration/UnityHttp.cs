using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using UnityEngine.Networking;

namespace Muchi.Unity
{
    /// <summary>
    /// <see cref="IHttp"/> on UnityWebRequest. Must be called on the main thread (ApiClient keeps its
    /// continuations on Unity's SynchronizationContext). No response (DNS, timeout, reset) → IOException,
    /// which ApiClient treats as a retryable network error; any HTTP status (incl. 4xx/5xx) → HttpResponse.
    /// </summary>
    public sealed class UnityHttp : IHttp
    {
        private readonly string _baseUrl;
        private readonly int _timeoutSeconds;

        public UnityHttp(string baseUrl, int timeoutMs)
        {
            _baseUrl = (baseUrl ?? "").TrimEnd('/');
            _timeoutSeconds = Math.Max(1, timeoutMs / 1000);
        }

        public Task<HttpResponse> SendAsync(HttpRequest request, CancellationToken cancellationToken)
        {
            var tcs = new TaskCompletionSource<HttpResponse>();
            var req = new UnityWebRequest(_baseUrl + request.Path, request.Method)
            {
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = _timeoutSeconds,
            };
            if (request.Body != null)
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(request.Body));
                req.SetRequestHeader("content-type", "application/json");
            }
            foreach (var h in request.Headers) req.SetRequestHeader(h.Key, h.Value);

            var op = req.SendWebRequest();
            var reg = cancellationToken.Register(() => { if (!op.isDone) req.Abort(); });
            op.completed += _ =>
            {
                try
                {
                    if (cancellationToken.IsCancellationRequested) tcs.TrySetCanceled();
                    else if (req.result == UnityWebRequest.Result.ConnectionError || req.result == UnityWebRequest.Result.DataProcessingError || req.responseCode == 0)
                        tcs.TrySetException(new IOException(req.error ?? "no response"));
                    else
                        tcs.TrySetResult(new HttpResponse((int)req.responseCode, req.downloadHandler?.text ?? ""));
                }
                finally
                {
                    reg.Dispose();
                    req.Dispose();
                }
            };
            return tcs.Task;
        }
    }
}
