using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using UnityEngine.Networking;

namespace Muchi.Unity
{
    /// <summary>
    /// <see cref="IAssetHttp"/> on UnityWebRequest (REQ-DLV-006). The body is streamed straight into the downloader's
    /// partial file through a <see cref="DownloadHandlerScript"/> (no whole-file buffer in memory); resume uses a Range
    /// header. Must be called on the main thread (the AssetDownloader keeps its continuations on Unity's context).
    /// No response / broken transfer → IOException (the downloader keeps what arrived and resumes).
    /// </summary>
    public sealed class UnityAssetHttp : IAssetHttp
    {
        private readonly int _timeoutSeconds;

        /// <param name="timeoutSeconds">Whole-request timeout; large bundles need minutes on slow links (0 = none).</param>
        public UnityAssetHttp(int timeoutSeconds = 0) { _timeoutSeconds = Math.Max(0, timeoutSeconds); }

        private sealed class Sink : DownloadHandlerScript
        {
            private readonly UnityWebRequest _req;
            private readonly Func<AssetHttpHead, Stream> _open;
            private Stream _out;
            private bool _opened;
            private long _length = -1;
            public Exception Error;

            public Sink(UnityWebRequest req, Func<AssetHttpHead, Stream> open) : base(new byte[64 * 1024]) { _req = req; _open = open; }

            public void EnsureOpened()
            {
                if (_opened) return;
                _opened = true;
                _out = _open(new AssetHttpHead { Status = (int)_req.responseCode, ContentLength = _length });
            }

            protected override void ReceiveContentLengthHeader(ulong contentLength) { _length = (long)contentLength; }

            protected override bool ReceiveData(byte[] data, int dataLength)
            {
                try
                {
                    EnsureOpened();
                    _out?.Write(data, 0, dataLength);
                    return true;
                }
                catch (Exception e) { Error = e; return false; } // aborts the request; the downloader sees the disk error
            }
        }

        public Task<int> GetAsync(AssetHttpRequest request, Func<AssetHttpHead, Stream> openBody, CancellationToken ct)
        {
            var tcs = new TaskCompletionSource<int>();
            var req = new UnityWebRequest(request.Url, "GET") { timeout = _timeoutSeconds };
            var sink = new Sink(req, openBody);
            req.downloadHandler = sink;
            if (request.RangeStart > 0) req.SetRequestHeader("Range", "bytes=" + request.RangeStart + "-");
            var op = req.SendWebRequest();
            var reg = ct.Register(() => { if (!op.isDone) req.Abort(); });
            op.completed += _ =>
            {
                try
                {
                    if (ct.IsCancellationRequested) tcs.TrySetCanceled();
                    else if (sink.Error != null) tcs.TrySetException(sink.Error);
                    else if (req.responseCode == 0 || req.result == UnityWebRequest.Result.ConnectionError || req.result == UnityWebRequest.Result.DataProcessingError)
                        tcs.TrySetException(new IOException(req.error ?? "no response"));
                    else
                    {
                        sink.EnsureOpened(); // empty body (e.g. 404) still reports its status
                        tcs.TrySetResult((int)req.responseCode);
                    }
                }
                catch (Exception e) { tcs.TrySetException(e); }
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
