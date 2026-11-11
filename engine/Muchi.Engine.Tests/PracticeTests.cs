using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-PRAC-001..018 (contracts/protocol.md §50): practice races built and run on the device.</summary>
    public class PracticeTests
    {
        private static PracticeCatalog Sample() => PracticeCatalog.FromJson(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "practice-catalog.sample.json")));

        private static PracticeSetup Setup(PracticeCatalog c, string track = "kirameki_turf_2000", int field = 8, string strength = "normal", string going = null, bool night = false)
        {
            var s = PracticeSetup.Default(c);
            s.TrackId = track; s.FieldSize = field; s.StrengthId = strength; s.Going = going ?? c.Course(track).TodayGoing; s.Night = night;
            return s;
        }

        /// <summary>A scripted rider: START when the gate opens, whips from 400 m out every 25 ticks.</summary>
        private static void Ride(OfflineRace race, int slot, int whipFromM = 400)
        {
            int lastWhip = -1000;
            while (!race.IsFinished)
            {
                var me = race.Sim.GetHorse(slot);
                if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start);
                long rem = RaceFeel.RemainingMm(race.Sim, me);
                if (me.Departed && !me.Finished && rem <= whipFromM * 1000L && race.Sim.Tick - lastWhip >= 25) { race.Input(Cmd.Whip); lastWhip = race.Sim.Tick; }
                race.StepOnce();
            }
        }

        [Fact]
        public void TheServerCatalogParses_AndTheStrengthsAreTheFallbackOnes()
        {
            var c = Sample();
            Assert.Equal(8, c.Courses.Count);
            Assert.Equal(2, c.FieldMin);
            Assert.Equal(12, c.FieldMax);
            Assert.Equal(8, c.FieldDefault);
            Assert.NotNull(c.Ruleset);
            Assert.True(c.CpuHorses.Count >= 11);
            Assert.Equal(3, c.Horses.Count);
            Assert.Single(c.Horses.FindAll(h => h.Partner));
            // the C# fallback pins the same numbers the server resolves from its definitions (server test pins them too)
            var fb = PracticeCatalog.DefaultStrengths();
            Assert.Equal(fb.Count, c.Strengths.Count);
            for (int i = 0; i < fb.Count; i++)
            {
                Assert.Equal(fb[i].Id, c.Strengths[i].Id);
                Assert.Equal(fb[i].Name, c.Strengths[i].Name);
                Assert.Equal(fb[i].Note, c.Strengths[i].Note);
                Assert.Equal(fb[i].CpuLevel, c.Strengths[i].CpuLevel);
                Assert.Equal(fb[i].CpuStatPermille, c.Strengths[i].CpuStatPermille);
            }
            var lit = c.Courses.FindAll(x => x.Lights);
            Assert.NotEmpty(lit);
            foreach (var x in c.Courses) Assert.Equal(4, x.Goings.Count);
        }

        [Fact]
        public void BuildConfigIsPure_AndFollowsTheSetup()
        {
            var c = Sample();
            var s = Setup(c, "minato_turf_2400", 10, "easy", "soft");
            var a = ProtocolCodec.ConfigToJson(PracticeSession.BuildConfig(c, s, 12345)).ToString();
            var b = ProtocolCodec.ConfigToJson(PracticeSession.BuildConfig(c, s, 12345)).ToString();
            Assert.Equal(a, b);
            Assert.NotEqual(a, ProtocolCodec.ConfigToJson(PracticeSession.BuildConfig(c, s, 12346)).ToString());
            var cfg = PracticeSession.BuildConfig(c, s, 12345);
            Assert.Equal(10, cfg.Entrants.Count);
            Assert.Equal(RaceMode.Friend, cfg.Mode);
            Assert.StartsWith("practice_", cfg.RaceId);
            Assert.True(PracticeSession.IsPractice(cfg));
            Assert.Equal(Going.SoftOrSloppy, cfg.Track.Going);
            Assert.Equal(false, cfg.Track.Night);
            Assert.Equal(2400, cfg.Track.DistanceM);
            var humans = cfg.Entrants.FindAll(e => e.Kind == EntrantKind.Human);
            Assert.Single(humans);
            var me = c.Horse(s.HorseId).Spec;
            Assert.Equal(me.Name, humans[0].Horse.Name);
            Assert.Equal(me.Speed, humans[0].Horse.Speed); // the player's horse is never scaled
            var names = new HashSet<string>();
            foreach (var e in cfg.Entrants)
            {
                Assert.True(names.Add(e.Horse.Name), "a horse appears twice: " + e.Horse.Name);
                if (e.Kind != EntrantKind.Cpu) continue;
                Assert.Equal(1, e.CpuLevel);
                var src = c.CpuHorses.Find(h => h.Id == e.Horse.Id);
                Assert.Equal(src.Speed * 780 / 1000, e.Horse.Speed); // easy = the beginner match's CPU stats
            }
        }

        [Fact]
        public void EveryCourseGoingFieldAndStrengthBuildsAValidRace()
        {
            var c = Sample();
            foreach (var course in c.Courses)
                foreach (var g in course.Goings)
                    foreach (var st in c.Strengths)
                        for (int n = 2; n <= 12; n += 5)
                        {
                            var s = Setup(c, course.TrackId, n, st.Id, g, course.Lights);
                            Assert.Null(s.Problem(c));
                            var cfg = PracticeSession.BuildConfig(c, s, (ulong)(n * 31 + 7));
                            cfg.Validate();
                            Assert.Equal(n, cfg.Entrants.Count);
                        }
        }

        [Fact]
        public void TheGateIsDrawn_TheCpusDifferBySeed()
        {
            var c = Sample();
            var s = Setup(c, field: 12);
            var slots = new HashSet<int>();
            for (ulong seed = 1; seed <= 40; seed++) slots.Add(PracticeSession.SlotOfPlayer(PracticeSession.BuildConfig(c, s, seed)));
            Assert.True(slots.Count > 4, "the player's gate is drawn, not fixed");
        }

        [Fact]
        public void BadSetupsAreRefusedWithAReason()
        {
            var c = Sample();
            var unlit = c.Courses.Find(x => !x.Lights);
            Assert.Equal(PracticeTexts.NightNeedsLights, Setup(c, unlit.TrackId, night: true).Problem(c));
            Assert.Equal(PracticeTexts.GoingMismatch, Setup(c, "kirameki_turf_2000", going: "sloppy").Problem(c));
            Assert.Equal("頭数は2〜12頭です", Setup(c, field: 1).Problem(c));
            Assert.Equal("頭数は2〜12頭です", Setup(c, field: 13).Problem(c));
            Assert.Equal(PracticeTexts.PickStrength, Setup(c, strength: "insane").Problem(c));
            var s = Setup(c); s.HorseId = "nope";
            Assert.Equal(PracticeTexts.PickHorse, s.Problem(c));
            s = Setup(c); s.TrackId = "nope";
            Assert.Equal(PracticeTexts.PickCourse, s.Problem(c));
            Assert.Throws<ArgumentException>(() => new PracticeSession(c, Setup(c, field: 13), 1));
            Assert.Throws<ArgumentException>(() => PracticeSession.BuildConfig(c, Setup(c, field: 0), 1));
        }

        [Fact]
        public void APlayerHorseNamedLikeACpuNeverMeetsItsTwin()
        {
            var c = Sample();
            var twin = c.CpuHorses[0];
            c.Horses.Add(new PracticeHorse { Spec = new HorseSpec { Id = "mine", Name = twin.Name, Speed = 500, Stamina = 500, Burst = 500, Guts = 500, Temper = 500, Style = RunningStyle.Sashi, DistMinM = 1600, DistMaxM = 2400, Surface = Surface.Turf } });
            var s = Setup(c, field: 12); s.HorseId = "mine";
            for (ulong seed = 1; seed < 20; seed++)
                Assert.Single(PracticeSession.BuildConfig(c, s, seed).Entrants.FindAll(e => e.Horse.Name == twin.Name));
        }

        [Fact]
        public void SameSeedRestart_ReplaysTheSameRace_AndTheGhostNeverTouchesIt()
        {
            var c = Sample();
            var session = new PracticeSession(c, Setup(c, field: 8), 777);
            var r1 = session.Start();
            Ride(r1, session.PlayerSlot);
            var res1 = session.Result();
            Assert.True(res1.Finished);
            Assert.Null(res1.GhostLine); // no ghost on the first attempt
            var hash1 = r1.ResultHash;
            var time1 = res1.TimeMs;

            var r2 = session.Restart(PracticeRestart.SameSeed);
            Assert.Equal(PracticeRestart.SameSeed, session.LastRestart);
            Assert.Equal(2, session.Attempt);
            Assert.NotNull(session.Ghost);
            Ride(r2, session.PlayerSlot);
            Assert.Equal(hash1, r2.ResultHash); // same seed + same inputs = the same race, ghost or not
            Assert.True(session.Ghost.Finished);
            Assert.Equal(time1, session.Ghost.FinishTimeMs); // the ghost reproduces attempt 1 exactly
            var res2 = session.Result();
            Assert.Equal(0, res2.DeltaMs);
            Assert.Equal(PracticeTexts.GhostSame, res2.GhostLine);

            // without the ghost the same inputs give the same hash too
            var plain = new OfflineRace(PracticeSession.BuildConfig(c, session.Setup, 777), session.PlayerSlot);
            Ride(plain, session.PlayerSlot);
            Assert.Equal(hash1, plain.ResultHash);
        }

        [Fact]
        public void NewSeedRestart_IsDeterministic_AndChangesTheField()
        {
            var c = Sample();
            var a = new PracticeSession(c, Setup(c), 5);
            var b = new PracticeSession(c, Setup(c), 5);
            a.Restart(PracticeRestart.NewSeed);
            b.Restart(PracticeRestart.NewSeed);
            Assert.Equal(a.Seed, b.Seed);
            Assert.NotEqual(5UL, a.Seed);
            Assert.Equal(PracticeSession.NextSeed(5), a.Seed);
            Assert.Equal(ProtocolCodec.ConfigToJson(a.Config).ToString(), ProtocolCodec.ConfigToJson(b.Config).ToString());
            Assert.Equal(PracticeRestart.NewSeed, a.LastRestart);
        }

        [Fact]
        public void TheGhostStaysWhenTheFieldChanges_AndGoesWhenTheCourseChanges()
        {
            var c = Sample();
            var session = new PracticeSession(c, Setup(c), 9);
            Ride(session.Start(), session.PlayerSlot);
            var s2 = Setup(c, field: 4, strength: "top");
            session.ChangeSetup(s2);
            session.Start();
            Assert.NotNull(session.Ghost);
            Assert.True(session.GhostTimeMs > 0);
            session.ChangeSetup(Setup(c, "aoba_turf_1600"));
            session.Start();
            Assert.Null(session.Ghost);
            Assert.False(session.HasPreviousRun);
            // the ghost option off: no ghost even on the same course
            var off = new PracticeSession(c, Setup(c), 9, new PracticeOptions { Ghost = false });
            Ride(off.Start(), off.PlayerSlot);
            off.Restart(PracticeRestart.SameSeed);
            Assert.Null(off.Ghost);
        }

        [Fact]
        public void AnUnfinishedAttemptIsNotAGhost()
        {
            var c = Sample();
            var session = new PracticeSession(c, Setup(c), 3);
            var r = session.Start();
            for (int i = 0; i < 200; i++) r.StepOnce(); // restart mid-race
            session.Restart(PracticeRestart.SameSeed);
            Assert.Null(session.Ghost);
        }

        [Fact]
        public void TheWhipBandIsTheAdviceCheckRange()
        {
            var c = Sample();
            var session = new PracticeSession(c, Setup(c), 1);
            Assert.NotNull(session.Advice);
            Assert.NotNull(session.Advice.Whip);
            var w = session.WhipWindow;
            Assert.Equal(session.Advice.Whip.StartRemainingM + RaceAdvice.WhipEarlyToleranceM, w.FromRemainingM);
            Assert.Equal(Math.Max(0, session.Advice.Whip.StartRemainingM - RaceAdvice.WhipLateToleranceM), w.ToRemainingM);
            Assert.True(w.Contains(w.StartRemainingM * 1000L));
            Assert.False(w.Contains((w.FromRemainingM + 1) * 1000L));
            Assert.False(w.Contains((w.ToRemainingM - 1) * 1000L));
            Assert.Null(new PracticeSession(c, Setup(c), 1, new PracticeOptions { WhipWindow = false }).WhipWindow);
            // the advice knows the field: every other runner's style
            Assert.Equal(7, session.Advice.Field.Known);
        }

        [Fact]
        public void TheResultHasTheDebrief_TheAdviceLine_AndNoReward()
        {
            var c = Sample();
            var session = new PracticeSession(c, Setup(c), 42);
            Ride(session.Start(), session.PlayerSlot, whipFromM: session.Advice.Whip.StartRemainingM);
            var res = session.Result();
            Assert.True(res.Place >= 1 && res.Place <= 8);
            Assert.True(res.TimeMs > 0);
            Assert.NotNull(res.Debrief);
            Assert.Equal(WhipTipVerdict.Followed, res.AdviceVerdict);
            Assert.StartsWith("ムチはアドバイスどおり", res.AdviceLine);
            Assert.Equal(PracticeTexts.NoReward, res.Lines[res.Lines.Count - 1]);
            Assert.Equal(res.Place, session.KpiPlace);
            Assert.False(PracticeSession.GrantsRewards);
            // no whip at all → the line says so
            var s2 = new PracticeSession(c, Setup(c), 42);
            Ride(s2.Start(), s2.PlayerSlot, whipFromM: 0);
            Assert.Equal(WhipTipVerdict.NoWhip, s2.Result().AdviceVerdict);
        }

        [Fact]
        public void SlowMotionOnlySlowsTheClock_TheRaceIsTheSame()
        {
            var c = Sample();
            var setup = Setup(c, "bellmoor_turf_1200", 6);
            // reference: the scripted rider by ticks
            var refRace = new OfflineRace(PracticeSession.BuildConfig(c, setup, 11), PracticeSession.SlotOfPlayer(PracticeSession.BuildConfig(c, setup, 11)));
            Ride(refRace, refRace.PlayerSlot);
            long refTicks = refRace.Sim.Tick;

            foreach (bool slow in new[] { false, true })
            {
                var session = new PracticeSession(c, setup, 11, new PracticeOptions { SlowFinal = slow });
                var race = session.Start();
                long real = 1_000_000;
                race.Start(session.RaceNow(real));
                int lastWhip = -1000;
                bool sawSlow = false;
                while (!race.IsFinished)
                {
                    var me = race.Sim.GetHorse(race.PlayerSlot);
                    if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start);
                    long rem = RaceFeel.RemainingMm(race.Sim, me);
                    if (me.Departed && !me.Finished && rem <= 400_000 && race.Sim.Tick - lastWhip >= 25) { race.Input(Cmd.Whip); lastWhip = race.Sim.Tick; }
                    real += 25; // 40 fps: at most one tick per frame
                    race.Update(session.RaceNow(real));
                    sawSlow |= session.Clock.Slow;
                }
                Assert.Equal(refRace.ResultHash, race.ResultHash);
                Assert.Equal(slow, sawSlow);
                long realMs = real - 1_000_000;
                long raceMs = refTicks * 50;
                if (slow) Assert.True(realMs > raceMs + 4000, $"the last 400 m took longer in real time ({realMs} vs {raceMs})");
                else Assert.True(Math.Abs(realMs - raceMs) < 200, $"1x real time ≈ race time ({realMs} vs {raceMs})");
            }
        }

        [Fact]
        public void TheClockMapsRealTime()
        {
            var k = new PracticeClock();
            Assert.Equal(1000, k.Now(1000, false));
            Assert.Equal(1100, k.Now(1100, false));
            Assert.Equal(1200, k.Now(1200, true));  // the rate changes from this frame on
            Assert.Equal(1250, k.Now(1300, true));
            Assert.Equal(1300, k.Now(1400, false));
            Assert.Equal(1400, k.Now(1500, false));
            Assert.Equal(1400, k.Now(1400, false)); // a clock going back never moves the race back
        }

        [Fact]
        public void TheFallbackRacesOffline()
        {
            var ruleset = TestUtil.Ruleset();
            var partner = new HorseSpec { Id = "local_partner", Name = "アイボウ", Speed = 560, Stamina = 540, Burst = 580, Guts = 520, Temper = 600, Style = RunningStyle.Sashi, DistMinM = 1600, DistMaxM = 2400, Surface = Surface.Turf };
            var c = PracticeCatalog.Fallback(ruleset, partner);
            Assert.True(c.IsFallback);
            Assert.Single(c.Courses);
            Assert.Equal(12, c.MaxField);
            var s = PracticeSetup.Default(c);
            Assert.Equal("local_partner", s.HorseId);
            Assert.Equal("normal", s.StrengthId);
            Assert.Null(s.Problem(c));
            var session = new PracticeSession(c, s, 99);
            Ride(session.Start(), session.PlayerSlot);
            Assert.True(session.Result().Finished);
        }

        [Fact]
        public void SetupAndOptionsRoundTripOnTheDevice()
        {
            var c = Sample();
            var s = Setup(c, "minato_dirt_1800", 5, "strong", "muddy", true);
            var d = PracticeSetup.Decode(s.Encode());
            Assert.Equal(s.Encode(), d.Encode());
            Assert.Null(PracticeSetup.Decode("garbage"));
            var o = PracticeOptions.Decode(new PracticeOptions { WhipWindow = false, SlowFinal = true, Ghost = false }.Encode());
            Assert.False(o.WhipWindow); Assert.True(o.SlowFinal); Assert.False(o.Ghost);
            var def = PracticeOptions.Decode(null);
            Assert.True(def.WhipWindow); Assert.False(def.SlowFinal); Assert.True(def.Ghost);
        }

        [Fact]
        public void PhotoAndShareCardsSayPractice()
        {
            var c = Sample();
            var session = new PracticeSession(c, Setup(c), 4);
            Ride(session.Start(), session.PlayerSlot);
            var snap = PhotoSnapshot.Capture(session.Config, new List<InputRecord>(session.Race.RecordedInputs), 100);
            var card = PhotoShareCard.Build(snap, new PhotoSpec { Camera = new PhotoCameraParams() }, session.PlayerSlot);
            Assert.Equal("練習レース", card.ModeLabel);
            Assert.Equal("practice", PhotoSource.ModeOf(session.Config.Mode, online: false));
            Assert.False(PhotoSource.IsShared("practice"));
        }

        [Fact]
        public void KpiEventsCarryOnlyCourseFieldStrengthAndPlace()
        {
            var e = AnalyticsEvent.PracticeStart(1, "minato_turf_2400", 8, "strong", "same_seed");
            Assert.Equal("practice_start", e.Name);
            var f = AnalyticsEvent.PracticeFinish(1, "minato_turf_2400", 8, "strong", 0);
            Assert.Equal("practice_finish", f.Name);
            Assert.Throws<ArgumentOutOfRangeException>(() => AnalyticsEvent.PracticeStart(1, "minato_turf_2400", 13, "strong", "none"));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.PracticeStart(1, "minato_turf_2400", 8, "strong", "again"));
            Assert.Throws<ArgumentOutOfRangeException>(() => AnalyticsEvent.PracticeFinish(1, "minato_turf_2400", 8, "strong", 13));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.PracticeFinish(1, "Bad Track!", 8, "strong", 1));
        }

        [Fact]
        public void TheCodecHorseHelpersRoundTrip()
        {
            foreach (var h in Sample().CpuHorses)
                Assert.Equal(ProtocolCodec.HorseToJson(h).ToString(), ProtocolCodec.HorseToJson(ProtocolCodec.ParseHorse(ProtocolCodec.HorseToJson(h))).ToString());
        }
    }
}
