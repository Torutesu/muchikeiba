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

        public static TrackSpec Dirt1800(Going? going = null) => new TrackSpec
        {
            Id = "sample_dirt_1800",
            Surface = Surface.Dirt,
            DistanceM = 1800,
            Going = going,
            Segments =
            {
                new TrackSegment(SegmentKind.Straight, 300),
                new TrackSegment(SegmentKind.Corner, 500, 100),
                new TrackSegment(SegmentKind.Straight, 350),
                new TrackSegment(SegmentKind.Corner, 300, 95),
                new TrackSegment(SegmentKind.Straight, 350),
            },
        };

        public static TrackSpec WithGoing(TrackSpec t, Going? going, bool? night = null)
        {
            t.Going = going;
            t.Night = night;
            return t;
        }

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

        /// <summary>One skill per trigger kind (golden files and tests; the game's skills live in server/master/skills.json).</summary>
        public static List<SkillSpec> SampleSkills() => new List<SkillSpec>
        {
            new SkillSpec { Id = "sk_t_start", Name = "テストスタート", Trigger = SkillTrigger.GoodStart, Value = 1, AccelPermille = 200, DurationTicks = 40 },
            new SkillSpec { Id = "sk_t_lead", Name = "テストセンドウ", Trigger = SkillTrigger.Leading, Value = 600, SpeedPermille = 20, DurationTicks = 80 },
            new SkillSpec { Id = "sk_t_straight", Name = "テストチョクセン", Trigger = SkillTrigger.FinalStraight, Value = 3, SpeedPermille = 20, DurationTicks = 80 },
            new SkillSpec { Id = "sk_t_slip", Name = "テストカゼヨミ", Trigger = SkillTrigger.Slipstream, Value = 60, DrainSavePermille = 250, DurationTicks = 100 },
            new SkillSpec { Id = "sk_t_behind", Name = "テストスエアシ", Trigger = SkillTrigger.SpurtBehind, Value = 4, SpeedPermille = 20, DurationTicks = 100 },
            new SkillSpec { Id = "sk_t_low", Name = "テストコンジョウ", Trigger = SkillTrigger.LowStamina, Value = 200, RecoverPermille = 30 },
            new SkillSpec { Id = "sk_t_rail", Name = "テストウチラチ", Trigger = SkillTrigger.CornerRail, Value = 1, DrainSavePermille = 250, DurationTicks = 100 },
            new SkillSpec { Id = "sk_t_last", Name = "テストラスト", Trigger = SkillTrigger.Remaining, Value = 150, SpeedPermille = 15, DurationTicks = 60 },
        };

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

            // 3) heavy (soft) turf at night, mixed ground aptitudes, two humans (REQ-RACE-034/035)
            var rng3 = new Pcg32(7031, 11);
            var horses3 = new List<HorseSpec>();
            for (int i = 0; i < 12; i++)
            {
                var h = SampleRaces.RandomHorse(ref rng3, "g3_" + i);
                h.GoingAptitude = (GoingAptitude)(i % 3);
                horses3.Add(h);
            }
            var cfg3 = SampleRaces.Config("golden_turf2000_soft_night", 9007199254740993UL,
                SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.SoftOrSloppy, true), ruleset, horses3, 2, 3);
            var inputs3 = new List<InputRecord>
            {
                new InputRecord(gate, 0, Cmd.Start),
                new InputRecord(gate + 2, 1, Cmd.Start),
                new InputRecord(gate + 300, 1, Cmd.ReinPress),
                new InputRecord(gate + 700, 1, Cmd.ReinRelease),
            };
            for (int k = 0; k < 6; k++) inputs3.Add(new InputRecord(gate + 1350 + k * 25, 1, Cmd.Whip));
            yield return ("race-turf2000-soft-night.json", new ReplayLog { Config = cfg3, Inputs = inputs3 });

            // 4) sloppy dirt, dirt-bred field with mixed ground aptitudes, all CPU
            var rng4 = new Pcg32(5150, 13);
            var horses4 = new List<HorseSpec>();
            for (int i = 0; i < 12; i++)
            {
                var h = SampleRaces.RandomHorse(ref rng4, "g4_" + i);
                h.Surface = i % 4 == 3 ? Surface.Turf : i % 4 == 2 ? Surface.Both : Surface.Dirt; // some off-surface runners
                h.GoingAptitude = (GoingAptitude)((i + 1) % 3);
                horses4.Add(h);
            }
            var cfg4 = SampleRaces.Config("golden_dirt1800_sloppy", 424242424242UL, SampleRaces.Dirt1800(Going.SoftOrSloppy), ruleset, horses4, 0, 4);
            yield return ("race-dirt1800-sloppy.json", new ReplayLog { Config = cfg4, Inputs = new List<InputRecord>() });

            // 5) unique skills (ruleset 1.3, REQ-UXS-051): every trigger kind, two humans (one with a good start), yielding turf
            if (ruleset.HasSkillKeys)
            {
                var rng5 = new Pcg32(130, 17);
                var horses5 = new List<HorseSpec>();
                var sk = SampleRaces.SampleSkills();
                SkillSpec With(SkillSpec s, int value) => new SkillSpec { Id = s.Id + "_" + value, Name = s.Name, Trigger = s.Trigger, Value = value, SpeedPermille = s.SpeedPermille, AccelPermille = s.AccelPermille, DrainSavePermille = s.DrainSavePermille, RecoverPermille = s.RecoverPermille, DurationTicks = s.DurationTicks };
                // slot → skill: conditions chosen so that every trigger kind fires in this race (slot 11 has none)
                var plan = new[]
                {
                    sk[0],              // 0 human, perfect start → goodStart
                    sk[7],              // 1 human → remaining 150
                    With(sk[1], 1999),  // 2 front-runner → leading
                    With(sk[3], 20),    // 3 → slipstream (1 s)
                    With(sk[4], 2),     // 4 closer → spurtBehind
                    With(sk[5], 600),   // 5 → lowStamina
                    With(sk[6], 3),     // 6 → cornerRail
                    With(sk[2], 11),    // 7 → finalStraight (any place)
                    With(sk[4], 6),     // 8 closer → spurtBehind
                    With(sk[1], 1999),  // 9 front-runner → leading
                    sk[3],              // 10 → slipstream (3 s)
                    null,
                };
                for (int i = 0; i < 12; i++)
                {
                    var h = SampleRaces.RandomHorse(ref rng5, "g5_" + i);
                    h.Skill = plan[i];
                    if (i == 2 || i == 9) h.Style = RunningStyle.Nige;
                    if (i == 4 || i == 8) h.Style = RunningStyle.Oikomi;
                    horses5.Add(h);
                }
                var cfg5 = SampleRaces.Config("golden_turf2000_skills", 1300000000000000013UL,
                    SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.YieldingOrMuddy), ruleset, horses5, 2, 3);
                var inputs5 = new List<InputRecord>
                {
                    new InputRecord(gate, 0, Cmd.Start),
                    new InputRecord(gate + 6, 1, Cmd.Start),
                    new InputRecord(gate + 400, 1, Cmd.ReinPress),
                    new InputRecord(gate + 800, 1, Cmd.ReinRelease),
                };
                for (int k = 0; k < 6; k++) inputs5.Add(new InputRecord(gate + 1380 + k * 24, 0, Cmd.Whip));
                inputs5.Sort((a, b) => a.Tick != b.Tick ? a.Tick.CompareTo(b.Tick) : a.Slot.CompareTo(b.Slot));
                yield return ("race-turf2000-skills.json", new ReplayLog { Config = cfg5, Inputs = inputs5 });
            }
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
