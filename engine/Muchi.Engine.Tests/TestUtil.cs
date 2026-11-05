using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    internal static class TestUtil
    {
        private static string _root;

        public static string RepoRoot
        {
            get
            {
                if (_root != null) return _root;
                var dir = new DirectoryInfo(AppContext.BaseDirectory);
                while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "contracts"))) dir = dir.Parent;
                if (dir == null) throw new InvalidOperationException("repo root (with contracts/) not found");
                return _root = dir.FullName;
            }
        }

        public static string DefaultRulesetPath => Path.Combine(RepoRoot, "contracts", "ruleset-params.default.json");

        public static RulesetParams Ruleset(params (string key, long value)[] overrides)
        {
            var node = JsonNode.Parse(File.ReadAllText(DefaultRulesetPath));
            foreach (var (k, v) in overrides) node.Set(k, v);
            return ProtocolCodec.ParseRuleset(node);
        }

        public static TrackSpec StraightTrack(int distance = 1200) => new TrackSpec
        {
            Id = "straight_" + distance,
            Surface = Surface.Turf,
            DistanceM = distance,
            Segments = { new TrackSegment(SegmentKind.Straight, distance) },
        };

        public static TrackSpec CornerTrack(int distance = 1200) => new TrackSpec
        {
            Id = "corner_" + distance,
            Surface = Surface.Turf,
            DistanceM = distance,
            Segments =
            {
                new TrackSegment(SegmentKind.Straight, 100),
                new TrackSegment(SegmentKind.Corner, distance - 400, 100),
                new TrackSegment(SegmentKind.Straight, 300),
            },
        };

        public static RaceConfig Cfg(TrackSpec track, RulesetParams rs, IList<HorseSpec> horses, int humans, ulong seed = 99, int cpuLevel = 3)
            => SampleRaces.Config("t_" + seed, seed, track, rs, horses, humans, cpuLevel);

        public static HorseSpec H(string id, int stat = 500, RunningStyle style = RunningStyle.Senko, int temper = 1000)
            => SampleRaces.Horse(id, stat, style, temper);

        /// <summary>Runs a race where inputs are produced per tick by a script.</summary>
        public static RaceSim RunScripted(RaceConfig cfg, Func<RaceSim, int, byte[]> script, Action<RaceSim> afterStep = null)
        {
            var sim = new RaceSim(cfg);
            while (!sim.IsFinished)
            {
                sim.Step(script(sim, sim.Tick));
                afterStep?.Invoke(sim);
            }
            return sim;
        }

        public static byte[] Only(int n, int slot, byte cmd)
        {
            var a = new byte[n];
            a[slot] = cmd;
            return a;
        }
    }
}
