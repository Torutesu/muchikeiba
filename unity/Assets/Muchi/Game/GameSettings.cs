using System;
using Muchi.Net;

namespace Muchi.Game
{
    /// <summary>
    /// Where the app talks to (Assets/Resources/Muchi/server-config.json, overridable per device).
    /// Local development runs the server with `npm run dev` (DEV_MODE=1) and authenticates with x-dev-user.
    /// </summary>
    public sealed class GameSettings
    {
        /// <summary>"local" | "staging" | "production". Only "local" may use DevUserId (the server refuses DEV_MODE elsewhere).</summary>
        public string Environment = "local";
        public string BaseUrl = "http://127.0.0.1:8787";
        /// <summary>Dev identity (x-dev-user). Empty = generate one per install. Ignored outside "local".</summary>
        public string DevUserId = "";
        /// <summary>Skip the server entirely (screens use local presentation data, races run offline).</summary>
        public bool OfflineOnly;
        public int RequestTimeoutMs = 10000;
        public int MatchPollMs = 1000;
        public int MatchTimeoutMs = 60000;

        public bool UsesDevAuth => Environment == "local";

        /// <summary>WebSocket URL for a race (wsPath from the match assignment, e.g. "/v1/race/r_x/ws").</summary>
        public string WebSocketUrl(string wsPath)
        {
            string b = (BaseUrl ?? "").TrimEnd('/');
            if (b.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) b = "wss://" + b.Substring(8);
            else if (b.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) b = "ws://" + b.Substring(7);
            return b + wsPath;
        }

        public static GameSettings Parse(string json)
        {
            var s = new GameSettings();
            if (string.IsNullOrWhiteSpace(json)) return s;
            var o = JsonNode.Parse(json);
            if (o.TryGet("environment", out var v) && v.Kind == JsonKind.String) s.Environment = v.AsString();
            if (o.TryGet("baseUrl", out v) && v.Kind == JsonKind.String) s.BaseUrl = v.AsString();
            if (o.TryGet("devUserId", out v) && v.Kind == JsonKind.String) s.DevUserId = v.AsString();
            if (o.TryGet("offlineOnly", out v) && v.Kind == JsonKind.Bool) s.OfflineOnly = v.AsBool();
            if (o.TryGet("requestTimeoutMs", out v) && v.Kind == JsonKind.Number) s.RequestTimeoutMs = v.AsInt();
            if (o.TryGet("matchPollMs", out v) && v.Kind == JsonKind.Number) s.MatchPollMs = v.AsInt();
            if (o.TryGet("matchTimeoutMs", out v) && v.Kind == JsonKind.Number) s.MatchTimeoutMs = v.AsInt();
            return s;
        }
    }
}
