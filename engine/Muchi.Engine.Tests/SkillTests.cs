using Muchi.Engine;
using Muchi.Net;
using Muchi.Verifier;
using Xunit;

namespace Muchi.Engine.Tests
{
    /// <summary>Unique skills (固有スキル, ruleset 1.3, REQ-UXS-050/051, docs/planning/06 §7.1).</summary>
    public class SkillTests
    {
        private static string Golden(string name) => Path.Combine(TestUtil.RepoRoot, "contracts", "golden", name);

        private static RulesetParams WithoutSkillKeys(RulesetParams rs)
        {
            var node = ProtocolCodec.RulesetToJson(rs);
            var trimmed = JsonNode.Obj();
            foreach (var p in node.Props) if (Array.IndexOf(RulesetParams.SkillIntKeys, p.Key) < 0) trimmed.Set(p.Key, p.Value);
            return ProtocolCodec.ParseRuleset(trimmed);
        }

        private static List<HorseSpec> Field(int n, uint seed, bool skills)
        {
            var rng = new Pcg32(seed, 3);
            var list = new List<HorseSpec>();
            var sk = SampleRaces.SampleSkills();
            for (int i = 0; i < n; i++)
            {
                var h = SampleRaces.RandomHorse(ref rng, "s" + i);
                if (skills) h.Skill = sk[i % sk.Count];
                list.Add(h);
            }
            return list;
        }

        private static ReplayOutput Run(RulesetParams rs, List<HorseSpec> horses, ulong seed, TrackSpec track = null)
            => RaceReplay.Run(SampleRaces.Config("sk_" + seed, seed, track ?? SampleRaces.Turf2000(), rs, horses, 0, 3), new List<InputRecord>());

        // ---------------------------------------------------------------- ruleset group

        [Fact]
        public void DefaultRulesetIs130WithTheSkillKeys()
        {
            var rs = TestUtil.Ruleset();
            Assert.Equal("1.3.0", rs.RulesetVersion);
            Assert.True(rs.HasSkillKeys);
            Assert.True(rs.HasDistanceKeys && rs.HasBalanceKeys && rs.HasGoingKeys);
        }

        [Fact]
        public void PartialSkillKeySetIsRejected()
        {
            var node = JsonNode.Parse(File.ReadAllText(TestUtil.DefaultRulesetPath));
            var trimmed = JsonNode.Obj();
            foreach (var p in node.Props) if (p.Key != "skillMaxRecoverPermille") trimmed.Set(p.Key, p.Value);
            Assert.Throws<FormatException>(() => ProtocolCodec.ParseRuleset(trimmed));
        }

        [Fact]
        public void Ruleset120WithoutSkillKeysParsesAndRoundTrips()
        {
            var doc = JsonNode.Parse(File.ReadAllText(Golden(Path.Combine("legacy", "race-turf2000-cpu12.ruleset-1.2.0.json"))));
            var cfgNode = doc.Get("log").Get("config");
            var cfg = ProtocolCodec.ParseConfig(cfgNode);
            Assert.Equal("1.2.0", cfg.Ruleset.RulesetVersion);
            Assert.True(cfg.Ruleset.HasDistanceKeys);
            Assert.False(cfg.Ruleset.HasSkillKeys);
            Assert.Equal(cfgNode.ToString(), ProtocolCodec.ConfigToJson(cfg).ToString());
        }

        [Fact]
        public void ArchivedRuleset120GoldensStillVerifyWithTheirRecordedOutput()
        {
            foreach (var name in new[] { "race-turf2000-cpu12", "race-turf1600-mixed", "race-turf2000-soft-night", "race-dirt1800-sloppy" })
            {
                string f = Golden(Path.Combine("legacy", name + ".ruleset-1.2.0.json"));
                var doc = JsonNode.Parse(File.ReadAllText(f));
                var (status, body) = VerifyService.Verify(doc.Get("log").ToString());
                Assert.Equal(200, status);
                Assert.Equal(doc.Get("expected").ToString(), JsonNode.Parse(body).ToString());
            }
        }

        [Fact]
        public void WithoutSkillsRuleset130RacesExactlyLike120()
        {
            // the 1.3.0 keys only enable skills: a field without skills gives the very same race (checksums, order, ticks)
            var doc = JsonNode.Parse(File.ReadAllText(Golden(Path.Combine("legacy", "race-turf1600-mixed.ruleset-1.2.0.json"))));
            var log = ProtocolCodec.ParseReplayLog(doc.Get("log"));
            var old = RaceReplay.Run(log.Config, log.Inputs);
            log.Config.Ruleset = TestUtil.Ruleset();
            var now = RaceReplay.Run(log.Config, log.Inputs);
            Assert.Equal(old.Result.Order, now.Result.Order);
            Assert.Equal(old.Result.FinishTicks, now.Result.FinishTicks);
            Assert.Equal(old.Checksums, now.Checksums);
            Assert.Equal(old.Sim.Events.Select(e => e.ToString()), now.Sim.Events.Select(e => e.ToString()));
            Assert.NotEqual(old.Result.Hash, now.Result.Hash); // only the version string in the canonical result differs
        }

        [Fact]
        public void SkillsAreIgnoredWhenTheRulesetHasNoSkillKeys()
        {
            var rs = WithoutSkillKeys(TestUtil.Ruleset());
            var plain = Run(rs, Field(12, 5, false), 77);
            var skilled = Run(rs, Field(12, 5, true), 77);
            Assert.Equal(plain.Result.Hash, skilled.Result.Hash);
            Assert.Equal(plain.Checksums, skilled.Checksums);
            Assert.DoesNotContain(skilled.Sim.Events, e => e.Type == RaceEventType.Skill);
            Assert.Null(skilled.Sim.SkillOf(0));
        }

        // ---------------------------------------------------------------- behaviour

        [Fact]
        public void SkillRacesAreDeterministicAndFireAtMostOncePerHorse()
        {
            var rs = TestUtil.Ruleset();
            var a = Run(rs, Field(12, 11, true), 2024);
            var b = Run(rs, Field(12, 11, true), 2024);
            Assert.Equal(a.Result.Hash, b.Result.Hash);
            Assert.Equal(a.Checksums, b.Checksums);
            Assert.Equal(a.Sim.Events.Select(e => e.ToString()), b.Sim.Events.Select(e => e.ToString()));
            var fired = a.Sim.Events.Where(e => e.Type == RaceEventType.Skill).ToList();
            Assert.NotEmpty(fired);
            Assert.Equal(fired.Count, fired.Select(e => e.Slot).Distinct().Count());
            // skills change the race (otherwise they would be pointless)
            Assert.NotEqual(Run(rs, Field(12, 11, false), 2024).Checksums, a.Checksums);
        }

        [Fact]
        public void SkillUsesNoRandomDraw()
        {
            // conditions only (docs/planning/06 §7.1): adding a skill that never fires changes nothing at all
            var rs = TestUtil.Ruleset();
            var plain = Field(12, 13, false);
            var never = Field(12, 13, false);
            foreach (var h in never) h.Skill = new SkillSpec { Id = "sk_never", Name = "ネバー", Trigger = SkillTrigger.LowStamina, Value = 0, SpeedPermille = 30, DurationTicks = 100 };
            var a = Run(rs, plain, 5);
            var b = Run(rs, never, 5);
            // LowStamina 0 can fire only for a horse that runs dry; compare up to the first such tick
            int firstFire = b.Sim.Events.Where(e => e.Type == RaceEventType.Skill).Select(e => e.Tick).DefaultIfEmpty(int.MaxValue).Min();
            foreach (var kv in a.Checksums) if (kv.Key < firstFire) Assert.Equal(kv.Value, b.Checksums[kv.Key]);
        }

        [Fact]
        public void RemainingDistanceSkillFiresAtItsMarkAndSpeedsTheHorseUp()
        {
            var rs = TestUtil.Ruleset(("conditionVariancePermille", 0));
            var track = TestUtil.StraightTrack(1200);
            HorseSpec Solo(SkillSpec sk) { var h = TestUtil.H("solo", 600, RunningStyle.Senko); h.Skill = sk; return h; }
            var skill = new SkillSpec { Id = "sk_r", Name = "ラスト", Trigger = SkillTrigger.Remaining, Value = 200, SpeedPermille = 30, DurationTicks = 100 };
            var with = Run(rs, new List<HorseSpec> { Solo(skill) }, 1, track);
            var without = Run(rs, new List<HorseSpec> { Solo(null) }, 1, track);
            var ev = Assert.Single(with.Sim.Events, e => e.Type == RaceEventType.Skill);
            Assert.Equal(0, ev.Slot);
            Assert.Equal(0, ev.Value); // rank: alone, so leading
            Assert.True(with.Result.FinishTicks[0] < without.Result.FinishTicks[0] || (with.Result.FinishTicks[0] == without.Result.FinishTicks[0] && with.Result.FinishFracOrDistanceRaw[0] < without.Result.FinishFracOrDistanceRaw[0]));
            // identical up to the trigger tick (nothing happens before the condition holds)
            foreach (var kv in without.Checksums) if (kv.Key < ev.Tick) Assert.Equal(kv.Value, with.Checksums[kv.Key]);
        }

        [Fact]
        public void EffectsAreClampedToTheRulesetCaps()
        {
            var rs = TestUtil.Ruleset();
            var huge = new SkillSpec { Id = "sk_h", Name = "ハイ", Trigger = SkillTrigger.Remaining, Value = 400, SpeedPermille = 1000, AccelPermille = 1000, DrainSavePermille = 1000, RecoverPermille = 1000, DurationTicks = 1200 };
            var capped = new SkillSpec { Id = "sk_h", Name = "ハイ", Trigger = SkillTrigger.Remaining, Value = 400, SpeedPermille = rs.SkillMaxSpeedPermille, AccelPermille = rs.SkillMaxAccelPermille, DrainSavePermille = rs.SkillMaxDrainSavePermille, RecoverPermille = rs.SkillMaxRecoverPermille, DurationTicks = rs.SkillMaxDurationTicks };
            var f1 = Field(8, 21, false); f1[3].Skill = huge;
            var f2 = Field(8, 21, false); f2[3].Skill = capped;
            var a = Run(rs, f1, 9);
            var b = Run(rs, f2, 9);
            Assert.Equal(a.Checksums, b.Checksums);
            Assert.Equal(a.Result.Hash, b.Result.Hash);
            Assert.Equal((rs.SkillMaxSpeedPermille, rs.SkillMaxAccelPermille, rs.SkillMaxDrainSavePermille, rs.SkillMaxRecoverPermille, rs.SkillMaxDurationTicks), a.Sim.SkillEffect(3));
        }

        [Fact]
        public void GoodStartFiresOnlyForAQuickStart()
        {
            var rs = TestUtil.Ruleset();
            var horses = Field(4, 31, false);
            var sk = new SkillSpec { Id = "sk_s", Name = "スタート", Trigger = SkillTrigger.GoodStart, Value = 1, AccelPermille = 200, DurationTicks = 40 };
            horses[0].Skill = sk; horses[1].Skill = sk;
            var cfg = SampleRaces.Config("gs", 3, SampleRaces.Turf1600(), rs, horses, 2, 3);
            int gate = rs.GateOpenTick;
            var sim = TestUtil.RunScripted(cfg, (s, t) =>
            {
                var c = new byte[4];
                if (t == gate) c[0] = Cmd.Start;      // perfect start
                if (t == gate + 5) c[1] = Cmd.Start;  // slow start
                return c;
            });
            var fired = sim.Events.Where(e => e.Type == RaceEventType.Skill).ToList();
            var only = Assert.Single(fired);
            Assert.Equal(0, only.Slot);
            Assert.Equal(gate, only.Tick);
        }

        [Fact]
        public void EveryTriggerKindFiresInTheSkillGolden()
        {
            var doc = JsonNode.Parse(File.ReadAllText(Golden("race-turf2000-skills.json")));
            var log = ProtocolCodec.ParseReplayLog(doc.Get("log"));
            var outp = RaceReplay.Run(log.Config, log.Inputs);
            Assert.Equal(doc.Get("expected").Get("resultHash").AsString(), outp.Result.Hash);
            var kinds = outp.Sim.Events.Where(e => e.Type == RaceEventType.Skill).Select(e => log.Config.Entrants[e.Slot].Horse.Skill.Trigger).Distinct().ToList();
            foreach (SkillTrigger k in Enum.GetValues(typeof(SkillTrigger))) Assert.Contains(k, kinds);
        }

        // ---------------------------------------------------------------- commentary

        private static (List<Muchi.Client.CommentaryLine> lines, RaceConfig cfg, int focus) SpeakSkillGolden(Muchi.Client.CommentaryTemplates t)
        {
            var doc = JsonNode.Parse(File.ReadAllText(Golden("race-turf2000-skills.json")));
            var log = ProtocolCodec.ParseReplayLog(doc.Get("log"));
            // focus: the first horse whose skill fires mid-race (at the gate the gate call has the floor)
            int focus = RaceReplay.Run(log.Config, log.Inputs).Sim.Events.First(e => e.Type == RaceEventType.Skill && e.Tick > log.Config.Ruleset.GateOpenTick + 300).Slot;
            var c = new Muchi.Client.Commentator(t, log.Config, focus);
            var sim = new RaceSim(log.Config);
            var byTick = log.Inputs.GroupBy(i => i.Tick).ToDictionary(g => g.Key, g => g.ToList());
            var cmds = new byte[log.Config.Entrants.Count];
            while (!sim.IsFinished)
            {
                Array.Clear(cmds, 0, cmds.Length);
                if (byTick.TryGetValue(sim.Tick, out var l)) foreach (var r in l) cmds[r.Slot] |= r.Cmd;
                sim.Step(cmds);
                c.Process(sim);
            }
            return (c.Lines.ToList(), log.Config, focus);
        }

        private static Muchi.Client.CommentaryTemplates Templates()
            => Muchi.Client.CommentaryTemplates.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", "commentary-ja.json")));

        [Fact]
        public void CommentaryCallsSkillsByNameDeterministicallyWithoutOverlap()
        {
            var t = Templates();
            Assert.True(t.Phrases.ContainsKey("skill"));
            var (a, cfg, focus) = SpeakSkillGolden(t);
            var (b, _, _) = SpeakSkillGolden(t);
            Assert.Equal(a.Select(l => l.ToString()), b.Select(l => l.ToString()));
            var mine = Assert.Single(a, l => l.Kind == "skill" && l.Slot == focus);
            Assert.Contains(cfg.Entrants[focus].Horse.Skill.Name, mine.Text);
            Assert.Contains(cfg.Entrants[focus].Horse.Name, mine.Text);
            Assert.Contains("skill:" + cfg.Entrants[focus].Horse.Skill.Id, mine.ClipKeys);
            // other horses' skills: only leaders (rank < 3) and at most MaxOtherSkillLines
            Assert.True(a.Count(l => l.Kind == "skill" && l.Slot != focus) <= t.MaxOtherSkillLines);
            for (int i = 1; i < a.Count; i++) Assert.True(a[i].Tick >= a[i - 1].Tick + a[i - 1].DurationTicks, a[i - 1] + " overlaps " + a[i]);
            // the skill name is voiced like a horse name (by its text)
            Assert.Equal(Muchi.Client.AssetKeys.VoiceName(cfg.Entrants[focus].Horse.Skill.Name),
                Muchi.Client.AssetKeys.VoiceClip("skill:" + cfg.Entrants[focus].Horse.Skill.Id, null, id => cfg.Entrants.Select(e => e.Horse.Skill).First(s => s != null && s.Id == id).Name));
            Assert.Null(Muchi.Client.AssetKeys.VoiceClip("skill:x", null, null));
            // key moments are unaffected
            Assert.Single(a, l => l.Kind == "gate_open");
            Assert.Single(a, l => Muchi.Client.Commentator.IsWinKind(l.Kind));
        }

        [Fact]
        public void TemplatesWithoutTheSkillKindSayNoSkillLines()
        {
            var t = Templates();
            t.Phrases.Remove("skill");
            var (a, _, _) = SpeakSkillGolden(t);
            Assert.DoesNotContain(a, l => l.Kind == "skill");
        }

        // ---------------------------------------------------------------- wire format

        [Fact]
        public void SkillRoundTripsInTheConfigAndIsOmittedWhenAbsent()
        {
            var rs = TestUtil.Ruleset();
            var horses = Field(3, 41, false);
            horses[1].Skill = SampleRaces.SampleSkills()[2];
            var cfg = SampleRaces.Config("rt", 1, SampleRaces.Turf2000(), rs, horses);
            var json = ProtocolCodec.ConfigToJson(cfg).ToString();
            var back = ProtocolCodec.ParseConfig(json);
            Assert.Equal(json, ProtocolCodec.ConfigToJson(back).ToString());
            Assert.Null(back.Entrants[0].Horse.Skill);
            var s = back.Entrants[1].Horse.Skill;
            Assert.Equal(SkillTrigger.FinalStraight, s.Trigger);
            Assert.Equal(3, s.Value);
            Assert.Equal(20, s.SpeedPermille);
            Assert.Contains("\"trigger\":\"finalStraight\"", json);
            Assert.False(JsonNode.Parse(json).Get("entrants")[0].Get("horse").Has("skill"));
        }

        [Theory]
        [InlineData("\"trigger\":\"finalStraight\"", "\"trigger\":\"teleport\"")]
        [InlineData("\"value\":3", "\"value\":12")]
        [InlineData("\"speedPermille\":20", "\"speedPermille\":-1")]
        [InlineData("\"durationTicks\":80", "\"durationTicks\":5000")]
        public void InvalidSkillsAreRejected(string from, string to)
        {
            var rs = TestUtil.Ruleset();
            var horses = Field(3, 41, false);
            horses[1].Skill = SampleRaces.SampleSkills()[2];
            var json = ProtocolCodec.ConfigToJson(SampleRaces.Config("bad", 1, SampleRaces.Turf2000(), rs, horses)).ToString();
            Assert.Contains(from, json);
            Assert.Throws<FormatException>(() => ProtocolCodec.ParseConfig(json.Replace(from, to)));
        }

        // ---------------------------------------------------------------- balance (R9)

        [Fact]
        public void EverySkillMeetsR9AndStyleParityHoldsWithSkills()
        {
            // docs/spec/balance-targets.md R9 and S2: no skill wins more than 1.15× as often as the same horse without it (ranked
            // caps), and with every runner carrying a skill each running style stays within ±25% of uniform on every course × going
            var master = SkillMaster.Load(Path.Combine(TestUtil.RepoRoot, "server", "master", "skills.json"));
            Assert.InRange(master.Skills.Count, 12, 16);
            var tracks = BalanceHarness.LoadServerTracks(Path.Combine(TestUtil.RepoRoot, "server", "master", "tracks.json"));
            var rep = SkillBalance.Run(TestUtil.Ruleset(), master, tracks, 1, open: false);
            Assert.True(rep.AllPass, "skill targets missed:\n" + string.Join("\n", rep.Metrics.Where(m => !m.Pass)));
        }

        [Fact]
        public void MasterSkillsStayInsideTheRulesetCaps()
        {
            var rs = TestUtil.Ruleset();
            var master = SkillMaster.Load(Path.Combine(TestUtil.RepoRoot, "server", "master", "skills.json"));
            foreach (var s in master.Skills.Select(x => x.Spec))
            {
                s.Validate();
                Assert.True(s.SpeedPermille <= rs.SkillMaxSpeedPermille && s.AccelPermille <= rs.SkillMaxAccelPermille && s.DrainSavePermille <= rs.SkillMaxDrainSavePermille
                    && s.RecoverPermille <= rs.SkillMaxRecoverPermille && s.DurationTicks <= rs.SkillMaxDurationTicks, s.Id);
            }
        }

        [Fact]
        public void VerifierReportsTheSkillsThatFiredOnlyWhenAsked()
        {
            // QA R11 (REQ-ACH-002): the server credits skill activations from the verifier's re-simulation, not from a
            // lone client's `skills` claim; the golden output (no flag) is unchanged
            var doc = JsonNode.Parse(File.ReadAllText(Golden("race-turf2000-skills.json")));
            string log = doc.Get("log").ToString();
            var plain = JsonNode.Parse(VerifyService.Verify(log).body);
            Assert.False(plain.Has("skillsFired"));
            var (status, body) = VerifyService.Verify(log, withSkills: true);
            Assert.Equal(200, status);
            var o = JsonNode.Parse(body);
            var fired = o.Get("skillsFired").Items.Select(x => (int)x.AsLong()).ToList();
            var parsed = ProtocolCodec.ParseReplayLog(doc.Get("log"));
            var replay = RaceReplay.Run(parsed.Config, parsed.Inputs);
            var expected = Enumerable.Range(0, parsed.Config.Entrants.Count).Where(s => replay.Sim.GetHorse(s).SkillUsed).ToList();
            Assert.NotEmpty(expected);
            Assert.Equal(expected, fired);
            Assert.All(fired, s => Assert.NotNull(parsed.Config.Entrants[s].Horse.Skill));
            Assert.Equal(plain.Get("resultHash").AsString(), o.Get("resultHash").AsString());
        }

        [Fact]
        public void SkillsFiredIsOptIn_ByTheServersHeader()
        {
            // Round 13 deploy order: the verifier sends skillsFired only when the server asks, so it can always go first
            Assert.True(VerifyService.WantsSkills("1"));
            Assert.False(VerifyService.WantsSkills(null));
            Assert.False(VerifyService.WantsSkills(""));
            Assert.False(VerifyService.WantsSkills("0"));
            Assert.Equal("X-Muchi-Verify-Skills", VerifyService.SkillsHeader);
        }
    }
}
