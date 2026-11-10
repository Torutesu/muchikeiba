namespace Muchi.Net
{
    /// <summary>
    /// The lockstep engine level this build speaks (contracts/protocol.md §46.4, REQ-MNT-008). Sent in the race
    /// <c>hello</c> as <c>engine</c> and on API requests as <c>x-engine-level</c>; the server refuses a level below
    /// what a race needs (err VERSION_MISMATCH + close 4026, or 426 UPGRADE_REQUIRED reason "engine").
    /// Raise it together with server/src/domain/maintenance.ts ENGINE_LEVEL only when the race math changes shape;
    /// existing rulesets keep their results (goldens do not move).
    /// </summary>
    public static class EngineInfo
    {
        public const int Level = 1;
    }
}
