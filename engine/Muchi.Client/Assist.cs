using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Muchi.Net;

namespace Muchi.Client
{
    // REQ-ASSIST-008..011: かんたん操作 setting on the server (contracts/protocol.md §27, server/src/domain/assist.ts).
    // The assist itself is InputAssistant (InputAssist.cs): it runs on the device and only sends normal inputs.

    /// <summary>GET /v1/player/assist (also `assist` in GET /v1/player).</summary>
    public sealed class AssistSettings
    {
        public AssistLevel Level = AssistLevel.Off;
        /// <summary>Show the one-time suggestion sheet now (3 last places in a row, assist off, not shown before).</summary>
        public bool PromptDue;
        public bool PromptShown;
        public int LastPlaceStreak;
        /// <summary>Fixed policy texts for the Settings row: ranked "allowed", never shown to opponents, off in the tutorial.</summary>
        public string RankedPolicy = "allowed", TutorialPolicy = "off";
        public bool ShownToOpponents;

        internal static AssistSettings Parse(JsonNode o)
        {
            if (o == null) return new AssistSettings();
            var r = J.Opt(o, "rules");
            return new AssistSettings
            {
                Level = AssistLevels.Parse(J.Str(o, "level")), PromptDue = J.Bool(o, "promptDue"), PromptShown = J.Bool(o, "promptShown"),
                LastPlaceStreak = J.Int(o, "lastPlaceStreak"), RankedPolicy = J.Str(r, "ranked") ?? "allowed", TutorialPolicy = J.Str(r, "tutorial") ?? "off",
                ShownToOpponents = J.Bool(r, "shownToOpponents"),
            };
        }
    }

    /// <summary>Where the player chose the level (KPI assist_enable s2).</summary>
    public enum AssistSource { Settings, Prompt }

    public sealed partial class ApiClient
    {
        /// <summary>REQ-ASSIST-008: the setting (default Off).</summary>
        public Task<AssistSettings> GetAssistAsync(CancellationToken ct = default)
            => Call("GET", "/v1/player/assist", null, true, null, true, AssistSettings.Parse, ct);

        /// <summary>REQ-ASSIST-008: Off / Whip / Full. Idempotent (the same level twice changes nothing).</summary>
        public Task<AssistSettings> SetAssistAsync(AssistLevel level, AssistSource source = AssistSource.Settings, CancellationToken ct = default)
        {
            var b = JsonNode.Obj();
            b.Set("level", AssistLevels.Wire(level));
            b.Set("source", source == AssistSource.Prompt ? "prompt" : "settings");
            return Call("PUT", "/v1/player/assist", b, true, null, true, AssistSettings.Parse, ct);
        }

        /// <summary>REQ-ASSIST-010: the suggestion sheet was shown (once; the server ignores it before it is due).</summary>
        public Task<AssistSettings> MarkAssistPromptSeenAsync(CancellationToken ct = default)
            => Call("POST", "/v1/player/assist/prompt-seen", JsonNode.Obj(), true, null, true, AssistSettings.Parse, ct);
    }
}
