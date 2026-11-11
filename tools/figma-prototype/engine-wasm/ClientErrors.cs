// Round 20: クライアントのエラー報告 (REQ-CERR-*, contracts/protocol.md §60) for the web prototype. The real ErrorReporter
// (Muchi.Client) and ClientErrorModel (Unity game layer) in WASM: the page's window.onerror / unhandledrejection feed
// CeOnError the way Unity's logMessageReceivedThreaded feeds the model in the app. A batch the reporter sends lands in an
// outbox; the page hands it to the server's domain code (MuchiLogic.clientErrors.ingest = POST /v1/client-errors) and
// gives the answer back with CeAnswer, so sampling, ids and retries run exactly as on a device.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices.JavaScript;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Client;
using Muchi.Game;
using Muchi.Net;

public static partial class MuchiRace
{
    private static ErrorReporter _ceReporter;
    private static ClientErrorModel _ceModel;
    private static long _ceNow;
    private static bool _ceConsent = true;
    private static readonly Queue<(string Json, TaskCompletionSource<ClientErrorBatchResult> Done)> _ceOutbox = new Queue<(string, TaskCompletionSource<ClientErrorBatchResult>)>();
    private static TaskCompletionSource<ClientErrorBatchResult> _ceWaiting;

    private sealed class PrefsStore : IClientErrorStore
    {
        public string Saved;
        public string Load() => Saved;
        public void Save(string json) => Saved = json;
    }
    private static readonly PrefsStore _ceStore = new PrefsStore();

    /// <summary>Creates the reporter (once; a second call keeps the queue). <paramref name="stored"/> = the page's saved queue JSON.</summary>
    [JSExport]
    public static void CeInit(string platform, string appVersion, string deviceModel, string osVersion, double nowMs, string stored)
    {
        _ceNow = (long)nowMs;
        if (_ceReporter != null) return;
        _ceStore.Saved = string.IsNullOrEmpty(stored) ? null : stored;
        _ceReporter = new ErrorReporter(Send, new ClientErrorOptions { Platform = platform, AppVersion = appVersion, DeviceModel = deviceModel, OsVersion = osVersion, FlushIntervalMs = 3_600_000 }, _ceStore, _ceNow);
        _ceReporter.AllowsDiagnostics = () => _ceConsent; // the §58 consent hook (stand-in toggle in the prototype)
        _ceModel = new ClientErrorModel(_ceReporter, () => _ceNow) { Screen = "home" };
    }

    private static Task<ClientErrorBatchResult> Send(JsonNode batch, CancellationToken ct)
    {
        var tcs = new TaskCompletionSource<ClientErrorBatchResult>();
        _ceOutbox.Enqueue((batch.ToString(), tcs));
        return tcs.Task;
    }

    /// <summary>window.onerror: "TypeError: x is not a function" + error.stack, on the screen in front.</summary>
    [JSExport]
    public static void CeOnError(string condition, string stack, string screen, double nowMs)
    {
        if (_ceModel == null) return;
        _ceNow = (long)nowMs;
        if (!string.IsNullOrEmpty(screen)) _ceModel.Screen = screen;
        _ceModel.OnLogMessage(condition, stack, GameLogType.Exception);
    }

    [JSExport]
    public static void CeSetConsent(bool allows) => _ceConsent = allows;

    /// <summary>R20 integration (§54 × §60.6): the account changed — what is queued goes without a player id.</summary>
    [JSExport]
    public static void CeAccountChanged() => _ceReporter?.AccountChanged();

    /// <summary>Starts a send of everything queued (as on going to the background). Poll <see cref="CeTakeOutbox"/> next.</summary>
    [JSExport]
    public static void CeFlush(double nowMs)
    {
        if (_ceModel == null) return;
        _ceNow = (long)nowMs;
        _ = _ceModel.OnPause(true);
    }

    /// <summary>The next batch the reporter wants to send ("" when none). Answer it with <see cref="CeAnswer"/>.</summary>
    [JSExport]
    public static string CeTakeOutbox()
    {
        if (_ceWaiting != null || _ceOutbox.Count == 0) return "";
        var (json, done) = _ceOutbox.Dequeue();
        _ceWaiting = done;
        return json;
    }

    /// <summary>The server's answer (POST /v1/client-errors body), or status 429 / 400 / 0 (offline) for a refusal.</summary>
    [JSExport]
    public static void CeAnswer(int status, string json)
    {
        var w = _ceWaiting;
        _ceWaiting = null;
        if (w == null) return;
        if (status == 200) w.SetResult(ClientErrorBatchResult.Parse(JsonNode.Parse(json)));
        else if (status == 429) w.SetException(new RateLimitedException("RATE_LIMITED", "rate limited", 429));
        else if (status == 400 || status == 413) w.SetException(new ValidationException(ApiErrorCode.BadRequest, "BAD_REQUEST", "invalid", status));
        else w.SetException(new NetworkException("offline", null));
    }

    /// <summary>The queue as the device holds it (scrubbed): [{category, title, count, fingerprint, sampleRate}], and the counters.</summary>
    [JSExport]
    public static string CeState()
    {
        if (_ceReporter == null) return "{\"items\":[],\"pending\":0,\"sent\":0,\"dropped\":0,\"stored\":\"\"}";
        var sb = new StringBuilder("{\"items\":[");
        bool first = true;
        foreach (var i in _ceReporter.Queued)
        {
            if (!first) sb.Append(',');
            first = false;
            string title = i.Category == "exception" ? i.Type + ": " + ErrorFingerprint.MessageTemplate(i.Message)
                : i.Category == "api" ? i.Method + " " + i.Route + " → " + i.Status
                : i.Category == "desync" ? "desync (" + i.Mode + ")" : i.Category == "asset" ? "asset " + i.AssetKey : i.Kind + " on " + i.Screen;
            sb.Append("{\"category\":\"").Append(Esc(i.Category)).Append("\",\"title\":\"").Append(Esc(title)).Append("\",\"count\":").Append(i.Count)
              .Append(",\"fingerprint\":\"").Append(i.Fingerprint).Append("\",\"stack\":\"").Append(Esc(i.Stack ?? "")).Append("\"}");
        }
        sb.Append("],\"pending\":").Append(_ceReporter.Pending).Append(",\"sent\":").Append(_ceReporter.Sent).Append(",\"dropped\":").Append(_ceReporter.Dropped)
          .Append(",\"consent\":").Append(B(_ceConsent)).Append(",\"stored\":\"").Append(Esc(_ceStore.Saved ?? "")).Append("\"}");
        return sb.ToString();
    }
}
