using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Verifier
{
    /// <summary>Replays a log and returns the verify output (REQ-VER-001..003).</summary>
    public static class VerifyService
    {
        public const int MaxBodyBytes = 4 * 1024 * 1024;

        /// <summary>
        /// Request header with which the server asks for <c>skillsFired</c> ("1"). Opt-in so that a new verifier never adds the
        /// key for an older server whose strict output schema would reject it: the verifier can always be deployed first
        /// (docs/ops/deploy.md §7.1). The server's HttpVerifierClient always asks.
        /// </summary>
        public const string SkillsHeader = "X-Muchi-Verify-Skills";

        /// <summary>True when the request asked for <c>skillsFired</c> (header value "1").</summary>
        public static bool WantsSkills(string headerValue) => headerValue != null && headerValue.Trim() == "1";

        /// <param name="withSkills">
        /// Adds <c>skillsFired</c> (slots whose unique skill fired in the re-simulation, ascending). The HTTP endpoint sends
        /// it when the server asks (<see cref="SkillsHeader"/>) so the server credits skill activations (REQ-ACH-002) from the verifier, never from a lone client's claim; the
        /// golden files keep the plain output (contracts/protocol.md §8).
        /// </param>
        public static (int status, string body) Verify(string json, bool withSkills = false)
        {
            ReplayLog log;
            try
            {
                log = ProtocolCodec.ParseReplayLog(json);
            }
            catch (FormatException e)
            {
                return (400, Error(e.Message));
            }
            catch (ArgumentException e)
            {
                return (400, Error(e.Message));
            }
            try
            {
                var outp = RaceReplay.Run(log.Config, log.Inputs);
                var o = ProtocolCodec.VerifyOutputToJson(outp);
                if (withSkills)
                {
                    var fired = JsonNode.Arr();
                    foreach (int s in SkillsFired(outp, log.Config.Entrants.Count)) fired.Add(JsonNode.Num(s));
                    o.Set("skillsFired", fired);
                }
                return (200, o.ToString());
            }
            catch (ArgumentException e)
            {
                return (400, Error(e.Message));
            }
        }

        /// <summary>Slots whose unique skill fired during the replay (REQ-ACH-002), ascending.</summary>
        public static List<int> SkillsFired(ReplayOutput outp, int entrants)
        {
            var l = new List<int>();
            for (int s = 0; s < entrants; s++) if (outp.Sim.GetHorse(s).SkillUsed) l.Add(s);
            return l;
        }

        private static string Error(string message)
        {
            var o = JsonNode.Obj();
            o.Set("error", message);
            return o.ToString();
        }
    }
}
