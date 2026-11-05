using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>Ground conditions, dirt and night races (REQ-RACE-034..036).</summary>
    public class GoingTests
    {
        private static string Golden(string name) => Path.Combine(TestUtil.RepoRoot, "contracts", "golden", name);

        private static (string hash, string body) Replay(string goldenPath)
        {
            var doc = JsonNode.Parse(File.ReadAllText(goldenPath));
            var (status, body) = VerifyService.Verify(doc.Get("log").ToString());
            Assert.Equal(200, status);
            return (JsonNode.Parse(body).Get("resultHash").AsString(), body);
        }

        // ---------------------------------------------------------------- backward compatibility

        [Theory]
        [InlineData("race-turf2000-cpu12")]
        [InlineData("race-turf1600-mixed")]
        public void PreGroundRulesetReplaysStillVerifyWithTheirRecordedHash(string name)
        {
            // legacy/ holds the goldens exactly as they were before the ground keys existed (no going/night/goingAptitude,
            // no going* ruleset keys). They must parse and reproduce the recorded output byte-for-byte.
            string legacy = Golden(Path.Combine("legacy", name + ".ruleset-1.0.json"));
            var doc = JsonNode.Parse(File.ReadAllText(legacy));
            Assert.False(doc.Get("log").Get("config").Get("ruleset").Has("goingTurfSoftSpeedPermille"));
            var (hash, body) = Replay(legacy);
            Assert.Equal(doc.Get("expected").Get("resultHash").AsString(), hash);
            Assert.Equal(doc.Get("expected").ToString(), JsonNode.Parse(body).ToString());
        }

        [Theory]
        [InlineData("race-turf2000-cpu12")]
        [InlineData("race-turf1600-mixed")]
        public void AddingTheGroundKeysDidNotChangeExistingGoldenResults(string name)
        {
            var legacy = JsonNode.Parse(File.ReadAllText(Golden(Path.Combine("legacy", name + ".ruleset-1.0.json"))));
            var current = JsonNode.Parse(File.ReadAllText(Golden(name + ".json")));
            Assert.Equal(legacy.Get("expected").ToString(), current.Get("expected").ToString());
            Assert.True(current.Get("log").Get("config").Get("ruleset").Has("goingTurfSoftSpeedPermille"));
        }

        [Fact]
        public void LegacyRulesetRoundTripsWithoutGainingKeys()
        {
            var legacy = JsonNode.Parse(File.ReadAllText(Golden(Path.Combine("legacy", "race-turf2000-cpu12.ruleset-1.0.json"))));
            var cfgNode = legacy.Get("log").Get("config");
            var cfg = ProtocolCodec.ParseConfig(cfgNode);
            Assert.False(cfg.Ruleset.HasGoingKeys);
            Assert.Null(cfg.Track.Going);
            Assert.Null(cfg.Track.Night);
            Assert.Equal(cfgNode.ToString(), ProtocolCodec.ConfigToJson(cfg).ToString());
        }

        [Fact]
        public void PartialGroundKeySetIsRejected()
        {
            var node = JsonNode.Parse(File.ReadAllText(TestUtil.DefaultRulesetPath));
            var trimmed = JsonNode.Obj();
            foreach (var p in node.Props) if (p.Key != "goingSpecialistPermille") trimmed.Set(p.Key, p.Value);
            Assert.Throws<FormatException>(() => ProtocolCodec.ParseRuleset(trimmed));
        }

        [Fact]
        public void ExplicitGoodGoingEqualsAbsentGoing()
        {
            var rs = TestUtil.Ruleset();
            var horses = Field(12, 7);
            var a = Run(SampleRaces.Turf2000(), rs, horses, 99);
            var b = Run(SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.Good), rs, horses, 99);
            Assert.Equal(a.Hash, b.Hash);
        }

        [Fact]
        public void NightHasNoEffectOnTheSimulation()
        {
            var rs = TestUtil.Ruleset();
            var horses = Field(12, 8);
            var day = Run(SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.SoftOrSloppy, false), rs, horses, 5);
            var night = Run(SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.SoftOrSloppy, true), rs, horses, 5);
            Assert.Equal(day.Hash, night.Hash);
        }

        // ---------------------------------------------------------------- physics

        [Fact]
        public void SoftTurfIsThreeToSixPercentSlowerThanGood()
        {
            var rs = TestUtil.Ruleset();
            var good = BalanceProbe.Run(rs, 120, 1, 150, SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.Good));
            var soft = BalanceProbe.Run(rs, 120, 1, 150, SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.SoftOrSloppy));
            double g = good.AvgWinnerSeconds(20, rs.GateOpenTick), s = soft.AvgWinnerSeconds(20, rs.GateOpenTick);
            double slower = s / g - 1;
            Assert.InRange(slower, 0.03, 0.06);
            Assert.Equal(0, soft.Dnf);
        }

        [Fact]
        public void FirmTurfIsFasterThanGood()
        {
            var rs = TestUtil.Ruleset();
            var good = BalanceProbe.Run(rs, 80, 3, 150, SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.Good));
            var firm = BalanceProbe.Run(rs, 80, 3, 150, SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.FirmOrFast));
            Assert.True(firm.AvgWinnerSeconds(20, rs.GateOpenTick) < good.AvgWinnerSeconds(20, rs.GateOpenTick));
        }

        [Fact]
        public void HeavyGroundSpecialistsWinMoreOnSoftAndLessOnFirm()
        {
            var rs = TestUtil.Ruleset();
            var soft = BalanceProbe.Run(rs, 300, 11, 150, SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.SoftOrSloppy), aptMix: true);
            Assert.True(soft.AptWinRate(GoingAptitude.Heavy) > soft.AptWinRate(GoingAptitude.Any));
            Assert.True(soft.AptWinRate(GoingAptitude.Any) > soft.AptWinRate(GoingAptitude.Fast));
            var firm = BalanceProbe.Run(rs, 300, 11, 150, SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.FirmOrFast), aptMix: true);
            Assert.True(firm.AptWinRate(GoingAptitude.Fast) > firm.AptWinRate(GoingAptitude.Heavy));
        }

        [Fact]
        public void GroundDoesNotSkewRunningStylesExcessively()
        {
            var rs = TestUtil.Ruleset();
            foreach (var t in new[] { SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.SoftOrSloppy), SampleRaces.Dirt1800(Going.Good), SampleRaces.Dirt1800(Going.SoftOrSloppy) })
            {
                var rep = BalanceProbe.Run(rs, 300, 21, 150, t);
                for (int s = 0; s < 4; s++) Assert.InRange(rep.StyleWinRate((RunningStyle)s), 0.04, 0.17);
            }
        }

        [Fact]
        public void SpecialistAdjustmentIsSymmetricAndHalvedOnYielding()
        {
            Assert.Equal(0, RaceSim.GoingSpecialistPermille(GoingAptitude.Heavy, Going.Good, 8));
            Assert.Equal(8, RaceSim.GoingSpecialistPermille(GoingAptitude.Heavy, Going.SoftOrSloppy, 8));
            Assert.Equal(4, RaceSim.GoingSpecialistPermille(GoingAptitude.Heavy, Going.YieldingOrMuddy, 8));
            Assert.Equal(-8, RaceSim.GoingSpecialistPermille(GoingAptitude.Heavy, Going.FirmOrFast, 8));
            Assert.Equal(8, RaceSim.GoingSpecialistPermille(GoingAptitude.Fast, Going.FirmOrFast, 8));
            Assert.Equal(-8, RaceSim.GoingSpecialistPermille(GoingAptitude.Fast, Going.SoftOrSloppy, 8));
            Assert.Equal(0, RaceSim.GoingSpecialistPermille(GoingAptitude.Any, Going.SoftOrSloppy, 8));
        }

        [Fact]
        public void DirtRacesRunToTheEndAndPunishTurfOnlyHorses()
        {
            var rs = TestUtil.Ruleset();
            var horses = Field(12, 3);
            for (int i = 0; i < 12; i++) horses[i].Surface = i == 0 ? Surface.Turf : Surface.Dirt;
            var r = Run(SampleRaces.Dirt1800(Going.Good), rs, horses, 17);
            Assert.All(r.FinishTicks, t => Assert.True(t > 0));
            var sim = new RaceSim(SampleRaces.Config("x", 17, SampleRaces.Dirt1800(Going.Good), rs, horses, 0));
            Assert.True(sim.TopSpeed(0) < sim.TopSpeed(1) || horses[0].Speed > horses[1].Speed);
            // same horse, dirt vs turf aptitude on a dirt track
            var h = SampleRaces.Horse("a", 500, RunningStyle.Senko);
            var t1 = new RaceSim(SampleRaces.Config("y", 1, SampleRaces.Dirt1800(), rs, new List<HorseSpec> { Clone(h, Surface.Dirt), Clone(h, Surface.Turf) }, 0));
            Assert.True(t1.TopSpeed(0) > t1.TopSpeed(1));
        }

        [Fact]
        public void DirtIsSlowerThanTurfPerMetre()
        {
            var rs = TestUtil.Ruleset();
            var turf = BalanceProbe.Run(rs, 80, 31, 150, SampleRaces.Turf2000());
            var dirt = BalanceProbe.Run(rs, 80, 31, 150, SampleRaces.Dirt1800(Going.Good));
            double perMTurf = turf.AvgWinnerSeconds(20, rs.GateOpenTick) / 2000, perMDirt = dirt.AvgWinnerSeconds(20, rs.GateOpenTick) / 1800;
            Assert.True(perMDirt > perMTurf);
        }

        // ---------------------------------------------------------------- protocol

        [Fact]
        public void CodecRoundTripsGroundFields()
        {
            var rs = TestUtil.Ruleset();
            var horses = Field(4, 2);
            horses[1].GoingAptitude = GoingAptitude.Heavy;
            horses[2].GoingAptitude = GoingAptitude.Fast;
            horses[3].GoingAptitude = GoingAptitude.Any;
            var cfg = SampleRaces.Config("rt", 1, SampleRaces.Dirt1800(Going.YieldingOrMuddy), rs, horses, 0);
            cfg.Track.Night = true;
            var json = ProtocolCodec.ConfigToJson(cfg).ToString();
            Assert.Contains("\"going\":\"muddy\"", json);
            Assert.Contains("\"night\":true", json);
            Assert.Contains("\"goingAptitude\":\"heavy\"", json);
            Assert.DoesNotContain("goingAptitude\":null", json);
            var back = ProtocolCodec.ParseConfig(json);
            Assert.Equal(Going.YieldingOrMuddy, back.Track.Going);
            Assert.True(back.Track.Night);
            Assert.Null(back.Entrants[0].Horse.GoingAptitude);
            Assert.Equal(GoingAptitude.Heavy, back.Entrants[1].Horse.GoingAptitude);
            Assert.Equal(json, ProtocolCodec.ConfigToJson(back).ToString());
        }

        [Fact]
        public void GoingNameMustMatchTheSurface()
        {
            var cfg = SampleRaces.Config("bad", 1, SampleRaces.Turf2000(), TestUtil.Ruleset(), Field(2, 1), 0);
            var node = ProtocolCodec.ConfigToJson(cfg);
            node.Get("track").Set("going", "muddy"); // dirt name on turf
            Assert.Throws<FormatException>(() => ProtocolCodec.ParseConfig(node.ToString()));
            node.Get("track").Set("going", "soft");
            Assert.Equal(Going.SoftOrSloppy, ProtocolCodec.ParseConfig(node.ToString()).Track.Going);
            node.Get("entrants")[0].Get("horse").Set("goingAptitude", "wet");
            Assert.Throws<FormatException>(() => ProtocolCodec.ParseConfig(node.ToString()));
        }

        [Theory]
        [InlineData("race-turf2000-soft-night")]
        [InlineData("race-dirt1800-sloppy")]
        public void NewGroundGoldensReplay(string name)
        {
            var doc = JsonNode.Parse(File.ReadAllText(Golden(name + ".json")));
            var (hash, _) = Replay(Golden(name + ".json"));
            Assert.Equal(doc.Get("expected").Get("resultHash").AsString(), hash);
            Assert.True(doc.Get("log").Get("config").Get("track").Has("going"));
        }

        // ---------------------------------------------------------------- commentary (REQ-RACE-036)

        [Fact]
        public void EveryGroundAndNightCombinationHasAPhrase()
        {
            var t = CommentaryTests.Templates();
            foreach (var surface in new[] { Surface.Turf, Surface.Dirt })
                foreach (Going g in Enum.GetValues(typeof(Going)))
                    foreach (var night in new[] { false, true })
                    {
                        string kind = Muchi.Client.Commentator.IntroKind(new TrackSpec { Surface = surface, Going = g, Night = night });
                        Assert.True(t.Phrases.ContainsKey(kind), kind);
                    }
            Assert.Null(Muchi.Client.Commentator.IntroKind(SampleRaces.Turf2000())); // old configs: no extra line
            Assert.Equal("ground_turf_good_night", Muchi.Client.Commentator.IntroKind(new TrackSpec { Surface = Surface.Turf, Night = true }));
        }

        [Fact]
        public void GroundLineIsSpokenBeforeTheGateAndGateLineStillFollows()
        {
            var horses = Field(12, 4);
            var cfg = SampleRaces.Config("cm_soft", 4, SampleRaces.WithGoing(SampleRaces.Turf2000(), Going.SoftOrSloppy, true), TestUtil.Ruleset(), horses, 0);
            var lines = Narrate(cfg);
            Assert.Equal("ground_turf_soft_night", lines[0].Kind);
            Assert.Contains("重", lines[0].Text);
            Assert.Contains("ナイター", lines[0].Text);
            Assert.Equal("gate_open", lines[1].Kind);
            Assert.True(lines[1].Tick >= lines[0].Tick + lines[0].DurationTicks);

            var plain = Narrate(SampleRaces.Config("cm_plain", 4, SampleRaces.Turf2000(), TestUtil.Ruleset(), horses, 0));
            Assert.Equal("gate_open", plain[0].Kind);
            Assert.DoesNotContain(plain, l => l.Kind.StartsWith("ground_"));
        }

        private static List<Muchi.Client.CommentaryLine> Narrate(RaceConfig cfg)
        {
            var sim = new RaceSim(cfg);
            var c = new Muchi.Client.Commentator(CommentaryTests.Templates(), cfg, 0);
            var lines = new List<Muchi.Client.CommentaryLine>();
            var empty = new byte[cfg.Entrants.Count];
            while (!sim.IsFinished)
            {
                sim.Step(empty);
                lines.AddRange(c.Process(sim));
            }
            return lines;
        }

        // ---------------------------------------------------------------- helpers

        private static List<HorseSpec> Field(int n, uint seed)
        {
            var rng = new Pcg32(seed, 5);
            var list = new List<HorseSpec>();
            for (int i = 0; i < n; i++) list.Add(SampleRaces.RandomHorse(ref rng, "f" + i));
            return list;
        }

        private static HorseSpec Clone(HorseSpec h, Surface s) => new HorseSpec
        {
            Id = h.Id + s, Name = h.Name, Speed = h.Speed, Stamina = h.Stamina, Burst = h.Burst, Guts = h.Guts, Temper = h.Temper,
            Style = h.Style, DistMinM = h.DistMinM, DistMaxM = h.DistMaxM, Surface = s, GoingAptitude = h.GoingAptitude,
        };

        private static RaceResult Run(TrackSpec track, RulesetParams rs, List<HorseSpec> horses, ulong seed)
        {
            var cfg = SampleRaces.Config("g_" + seed, seed, track, rs, horses, 0);
            return RaceReplay.Run(cfg, new List<InputRecord>()).Result;
        }
    }
}
