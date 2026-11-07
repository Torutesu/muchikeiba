using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Verifier
{
    /// <summary>Replays a log and returns the verify output (REQ-VER-001..003).</summary>
    public static class VerifyService
    {
        public const int MaxBodyBytes = 4 * 1024 * 1024;

        /// <param name="withSkills">
        /// Adds <c>skillsFired</c> (slots whose unique skill fired in the re-simulation, ascending). The HTTP endpoint sends
        /// it so the server credits skill activations (REQ-ACH-002) from the verifier, never from a lone client's claim; the
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
