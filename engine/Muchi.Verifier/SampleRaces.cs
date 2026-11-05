using Muchi.Engine;
using Muchi.Net;

namespace Muchi.Verifier
{
    /// <summary>Sample tracks/horses used for golden files, tests and balance measurements.</summary>
    public static class SampleRaces
    {
        public static TrackSpec Turf2000() => new TrackSpec
        {
            Id = "sample_turf_2000",
            Surface = Surface.Turf,
            DistanceM = 2000,
            Segments =
            {
                new TrackSegment(SegmentKind.Straight, 300),
                new TrackSegment(SegmentKind.Corner, 500, 120),
                new TrackSegment(SegmentKind.Straight, 400),
                new TrackSegment(SegmentKind.Corner, 400, 110),
                new TrackSegment(SegmentKind.Straight, 400),
            },
        };

        public static TrackSpec Turf1600() => new TrackSpec
        {
            Id = "sample_turf_1600",
            Surface = Surface.Turf,
            DistanceM = 1600,
            Segments =
            {
                new TrackSegment(SegmentKind.Straight, 350),
                new TrackSegment(SegmentKind.Corner, 450, 110),
                new TrackSegment(SegmentKind.Straight, 300),
                new TrackSegment(SegmentKind.Corner, 200, 100),
                new TrackSegment(SegmentKind.Straight, 300),
            },
        };

        public static HorseSpec Horse(string id, int stat, RunningStyle style, int temper = 500)
        {
            return new HorseSpec
            {
                Id = id,
                Name = "テストバ" + id,
                Speed = stat, Stamina = stat, Burst = stat, Guts = stat, Temper = temper,
                Style = style,
                DistMinM = 1400, DistMaxM = 2400,
                Surface = Surface.Turf,
            };
        }

        public static HorseSpec RandomHorse(ref Pcg32 rng, string id, int center = 500, int spread = 150)
        {
            var v = new int[5];
            for (int k = 0; k < 5; k++) v[k] = Math.Clamp(center + rng.Range(-spread, spread), 0, 1000);
            return new HorseSpec
            {
                Id = id,
                Name = "ランダム" + id,
                Speed = v[0], Stamina = v[1], Burst = v[2], Guts = v[3], Temper = v[4],
                Style = (RunningStyle)rng.NextInt(4),
                DistMinM = 1400, DistMaxM = 2400,
                Surface = Surface.Turf,
            };
        }

        public static RaceConfig Config(string raceId, ulong seed, TrackSpec track, RulesetParams ruleset, IList<HorseSpec> horses, int humanCount = 0, int cpuLevel = 3, RaceMode mode = RaceMode.Ranked)
        {
            var c = new RaceConfig
            {
                RaceId = raceId,
                Mode = mode,
                Seed = seed,
                Track = track,
                Ruleset = ruleset,
                Net = new NetParams(),
            };
            for (int i = 0; i < horses.Count; i++)
            {
                bool human = i < humanCount;
                c.Entrants.Add(new Entrant
                {
                    Slot = i,
                    Kind = human ? EntrantKind.Human : EntrantKind.Cpu,
                    PlayerId = human ? "p_" + i : null,
                    CpuLevel = cpuLevel,
                    Horse = horses[i],
                });
            }
            c.Validate();
            return c;
        }

        public static RulesetParams LoadRuleset(string path) => ProtocolCodec.ParseRuleset(File.ReadAllText(path));
    }

    /// <summary>Writes contracts/golden/race-*.json (contracts/protocol.md §9).</summary>
    public static class GoldenGenerator
    {
        public static IEnumerable<(string name, ReplayLog log)> Build(RulesetParams ruleset)
        {
            // 1) twelve CPUs, varied horses
            var rng = new Pcg32(20261105, 7);
            var horses = new List<HorseSpec>();
            for (int i = 0; i < 12; i++) horses.Add(SampleRaces.RandomHorse(ref rng, "g1_" + i));
            var cfg1 = SampleRaces.Config("golden_turf2000_cpu12", 1234567890123456789UL, SampleRaces.Turf2000(), ruleset, horses, 0);
            yield return ("race-turf2000-cpu12.json", new ReplayLog { Config = cfg1, Inputs = new List<InputRecord>() });

            // 2) four humans with scripted inputs + takeover/resume, eight CPUs
            var rng2 = new Pcg32(42, 9);
            var horses2 = new List<HorseSpec>();
            for (int i = 0; i < 12; i++) horses2.Add(SampleRaces.RandomHorse(ref rng2, "g2_" + i, 550, 120));
            var cfg2 = SampleRaces.Config("golden_turf1600_mixed", 18446744073709551557UL, SampleRaces.Turf1600(), ruleset, horses2, 4, 4);
            int gate = ruleset.GateOpenTick;
            var inputs = new List<InputRecord>
            {
                new InputRecord(gate, 0, Cmd.Start),
                new InputRecord(gate + 1, 1, Cmd.Start),
                new InputRecord(gate + 3, 2, Cmd.Start),
                // slot 3 never presses start → late start
                new InputRecord(gate + 40, 0, Cmd.LaneOut),
                new InputRecord(gate + 200, 1, Cmd.ReinPress),
                new InputRecord(gate + 500, 1, Cmd.ReinRelease),
                new InputRecord(gate + 600, 2, Cmd.CpuTakeover),
                new InputRecord(gate + 650, 3, Cmd.LaneIn),
                new InputRecord(gate + 800, 2, Cmd.HumanResume),
                new InputRecord(gate + 900, 0, Cmd.ReinPress | Cmd.ReinRelease),
            };
            for (int k = 0; k < 6; k++)
            {
                inputs.Add(new InputRecord(gate + 1150 + k * 25, 0, Cmd.Whip));
                inputs.Add(new InputRecord(gate + 1160 + k * 3, 3, Cmd.Whip)); // mashing
            }
            inputs.Sort((a, b) => a.Tick != b.Tick ? a.Tick.CompareTo(b.Tick) : a.Slot.CompareTo(b.Slot));
            yield return ("race-turf1600-mixed.json", new ReplayLog { Config = cfg2, Inputs = inputs });
        }

        public static List<string> WriteAll(string outDir, string rulesetJson)
        {
            var ruleset = ProtocolCodec.ParseRuleset(rulesetJson);
            Directory.CreateDirectory(outDir);
            var written = new List<string>();
            foreach (var (name, log) in Build(ruleset))
            {
                var outp = RaceReplay.Run(log.Config, log.Inputs);
                log.EndTick = outp.Result.EndTick;
                var doc = JsonNode.Obj();
                doc.Set("log", ProtocolCodec.ReplayLogToJson(log));
                doc.Set("expected", ProtocolCodec.VerifyOutputToJson(outp));
                string path = Path.Combine(outDir, name);
                File.WriteAllText(path, doc.ToString() + "\n");
                written.Add(path);
            }
            return written;
        }
    }
}
