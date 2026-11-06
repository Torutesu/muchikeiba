using System;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>
    /// <see cref="ITransportFactory"/> on System.Net.WebSockets.ClientWebSocket (Unity Mono/IL2CPP on iOS,
    /// Android and desktop; NOT WebGL). The socket runs on the thread pool; callbacks arrive on any thread and
    /// <see cref="RaceSession"/> queues them for its main-thread Update. Sends are queued and written in order.
    /// </summary>
    public sealed class WebSocketTransportFactory : ITransportFactory
    {
        public IConnection Open(string url, Action onOpen, Action<string> onMessage, Action<int> onClosed)
        {
            var c = new Connection(new Uri(url), onOpen, onMessage, onClosed);
            Task.Run(c.RunAsync);
            return c;
        }

        private sealed class Connection : IConnection
        {
            private readonly Uri _uri;
            private readonly Action _onOpen;
            private readonly Action<string> _onMessage;
            private readonly Action<int> _onClosed;
            private readonly ClientWebSocket _ws = new ClientWebSocket();
            private readonly CancellationTokenSource _cts = new CancellationTokenSource();
            private readonly Queue<string> _outbox = new Queue<string>();
            private readonly SemaphoreSlim _signal = new SemaphoreSlim(0);
            private int _closed;
            /// <summary>The room's close code; stays 1006 when the socket drops or fails without a close frame.</summary>
            private int _closeCode = CloseCodes.Abnormal;

            public Connection(Uri uri, Action onOpen, Action<string> onMessage, Action<int> onClosed)
            {
                _uri = uri; _onOpen = onOpen; _onMessage = onMessage; _onClosed = onClosed;
            }

            public async Task RunAsync()
            {
                try
                {
                    await _ws.ConnectAsync(_uri, _cts.Token);
                    _onOpen?.Invoke();
                    var sender = SendLoopAsync();
                    var buf = new byte[1 << 16];
                    var sb = new StringBuilder();
                    while (_ws.State == WebSocketState.Open && !_cts.IsCancellationRequested)
                    {
                        var r = await _ws.ReceiveAsync(new ArraySegment<byte>(buf), _cts.Token);
                        if (r.MessageType == WebSocketMessageType.Close)
                        {
                            // e.g. 4000 "replaced": RaceSession must not reconnect (see CloseCodes); 1005 = no status in the frame
                            var status = r.CloseStatus ?? _ws.CloseStatus;
                            _closeCode = status.HasValue ? (int)status.Value : 1005;
                            break;
                        }
                        sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
                        if (!r.EndOfMessage) continue;
                        string msg = sb.ToString();
                        sb.Clear();
                        _onMessage?.Invoke(msg);
                    }
                    _cts.Cancel();
                    try { await sender; } catch (OperationCanceledException) { }
                }
                catch (Exception) { /* connection failure or abort: reported through onClosed */ }
                finally { Finish(); }
            }

            private async Task SendLoopAsync()
            {
                while (!_cts.IsCancellationRequested)
                {
                    await _signal.WaitAsync(_cts.Token);
                    string next;
                    lock (_outbox) { if (_outbox.Count == 0) continue; next = _outbox.Dequeue(); }
                    var bytes = Encoding.UTF8.GetBytes(next);
                    await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token);
                }
            }

            public void Send(string message)
            {
                if (Volatile.Read(ref _closed) != 0) return;
                lock (_outbox) _outbox.Enqueue(message);
                _signal.Release();
            }

            public void Close()
            {
                if (Volatile.Read(ref _closed) != 0) return;
                _cts.Cancel();
                try { _ws.Abort(); } catch (Exception) { }
            }

            private void Finish()
            {
                if (Interlocked.Exchange(ref _closed, 1) != 0) return;
                try { _ws.Dispose(); } catch (Exception) { }
                _onClosed?.Invoke(_closeCode);
            }
        }
    }
}
