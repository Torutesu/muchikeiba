using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Verifier
{
    /// <summary>Replays a log and returns the verify output (REQ-VER-001..003).</summary>
    public static class VerifyService
    {
        public const int MaxBodyBytes = 4 * 1024 * 1024;

        public static (int status, string body) Verify(string json)
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
                return (200, ProtocolCodec.VerifyOutputToJson(outp).ToString());
            }
            catch (ArgumentException e)
            {
                return (400, Error(e.Message));
            }
        }

        private static string Error(string message)
        {
            var o = JsonNode.Obj();
            o.Set("error", message);
            return o.ToString();
        }
    }
}
