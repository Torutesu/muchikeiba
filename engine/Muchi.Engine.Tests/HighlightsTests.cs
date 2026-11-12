using System.IO;
using System.Linq;
using Muchi.Client;
using Muchi.Net;
using Muchi.Verifier;

namespace Muchi.Engine.Tests
{
    /// <summary>REQ-HL-001..015: レースの見どころ — detection on the golden replays (= the verifier's vectors), invariants, the reel, captions, sharing (contracts/protocol.md §72).</summary>
    public class HighlightsTests
    {
        internal static string GoldenDir => Path.Combine(TestUtil.RepoRoot, "contracts", "golden");
        internal static string VectorsPath => Path.Combine(TestUtil.RepoRoot, "contracts", "highlights.vectors.json");
        private static string Res(string f) => File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Resources", "Muchi", f));

        internal static ReplayLog Golden(string name) => ProtocolCodec.ParseReplayLog(JsonNode.Parse(File.ReadAllText(Path.Combine(GoldenDir, name))).Get("log"));

        /// <summary>The ReplayData the server would send for a golden race (own horse = <paramref name="focus"/>).</summary>
        internal static ReplayData Data(string golden, int focus, string hash = null)
        {
            var log = Golden(golden);
            hash ??= RaceReplay.Run(log.Config, log.Inputs).Result.Hash;
            var o = JsonNode.Obj().Set("raceId", "r-hl").Set("owner", "me").Set("resultHash", hash).Set("focusSlot", focus)
                .Set("rulesetVersion", log.Config.Ruleset.RulesetVersion).Set("playable", true).Set("reason", JsonNode.Null())
                .Set("entrants", JsonNode.Arr()).Set("replayLog", ProtocolCodec.ReplayLogToJson(log));
            return ReplayData.FromJson(o.ToString());
        }

        private static void Invariants(HighlightSet set, int endTick, int hz)
        {
            Assert.InRange(set.Moments.Count, 1, HighlightRules.MaxMoments);
            Assert.Equal(Enumerable.Range(1, set.Moments.Count), set.Moments.Select(m => m.Rank).OrderBy(r => r));
            for (int i = 0; i < set.Moments.Count; i++)
            {
                var m = set.Moments[i];
                Assert.InRange(m.StartTick, 0, m.EndTick);
                Assert.InRange(m.EndTick, m.StartTick, endTick);
                Assert.Contains(m.Kind, HighlightKinds.Order);
                if (i > 0) Assert.True(set.Moments[i - 1].EndTick < m.StartTick, "chronological, no overlap");
            }
            Assert.True(set.Moments.GroupBy(m => m.Kind).All(g => g.Count() <= HighlightRules.MaxPerKind));
            Assert.True(set.Moments.Where(m => m.Kind == HighlightKinds.WhipBurst).GroupBy(m => m.Slot).All(g => g.Count() == 1));
            Assert.True(set.TotalTicks <= HighlightRules.Ticks(HighlightRules.MaxTotalMs, hz));
            if (endTick >= HighlightRules.Ticks(HighlightRules.MinTotalMs, hz) + 2) Assert.True(set.TotalTicks >= HighlightRules.Ticks(HighlightRules.MinTotalMs, hz), "15 s at least");
            Assert.Single(set.Moments, m => m.Rank == 1);
        }

        [Fact]
        public void DeviceDetectionEqualsTheSharedVectorsAndTheVerifier()
        {
            // the verifier's check (Muchi.Verifier highlights) and the device path (ReplayPlayer → ReplayHighlights) on the same rows
            Assert.Empty(HighlightVectors.Check(GoldenDir, VectorsPath));
            var doc = JsonNode.Parse(File.ReadAllText(VectorsPath));
            Assert.Equal(HighlightRules.Version, doc.Get("version").AsInt());
            int rows = 0;
            foreach (var row in doc.Get("cases").Items)
            {
                string g = row.Get("golden").AsString();
                int focus = row.Get("focusSlot").AsInt();
                var want = HighlightJson.ToJson(HighlightJson.Parse(row.Get("expected"))).ToString();
                if (focus >= 0)
                {
                    var p = ReplayPlayer.Open(Data(g, focus));
                    Assert.True(p.Playable, p.Reason);
                    Assert.Equal(want, HighlightJson.ToJson(ReplayHighlights.Detect(p)).ToString());
                }
                var log = Golden(g);
                Assert.Equal(want, HighlightJson.ToJson(HighlightDetector.Detect(log.Config, log.Inputs, focus, row.Get("resultHash").AsString())).ToString());
                rows++;
            }
            Assert.True(rows >= 10, "every golden with three focus slots");
        }

        [Fact]
        public void DetectionOnlyReadsTheGoldensStayTheSame()
        {
            foreach (var path in Directory.GetFiles(GoldenDir, "race-*.json"))
            {
                var doc = JsonNode.Parse(File.ReadAllText(path));
                var log = ProtocolCodec.ParseReplayLog(doc.Get("log"));
                var before = RaceReplay.Run(log.Config, log.Inputs);
                var a = HighlightDetector.Detect(log.Config, log.Inputs, 0);
                var b = HighlightDetector.Detect(log.Config, log.Inputs, 0);
                var after = RaceReplay.Run(log.Config, log.Inputs);
                Assert.Equal(before.Result.Hash, after.Result.Hash);
                Assert.Equal(doc.Get("expected").Get("resultHash").AsString(), after.Result.Hash); // the golden itself
                Assert.Equal(before.Checksums, after.Checksums);
                Assert.Equal(HighlightJson.ToJson(a).ToString(), HighlightJson.ToJson(b).ToString()); // deterministic
                Invariants(a, a.EndTick, log.Config.Net.TickHz);
            }
        }

        [Fact]
        public void ManyRacesKeepTheRulesAndCoverTheKinds()
        {
            var kinds = new HashSet<string>();
            for (ulong seed = 1; seed <= 40; seed++)
            {
                var (cfg, inputs) = DeterminismTests.Scenario(seed);
                foreach (int focus in new[] { -1, 3 })
                {
                    var set = HighlightDetector.Detect(cfg, inputs, focus);
                    Invariants(set, set.EndTick, cfg.Net.TickHz);
                    foreach (var m in set.Moments)
                    {
                        kinds.Add(m.Kind);
                        if (focus >= 0 && (m.Slot == focus || m.Slot2 == focus)) Assert.True(m.Score >= HighlightRules.FocusBonus);
                        if (m.Kind == HighlightKinds.WhipBurst) Assert.True(m.Value >= HighlightRules.WhipGainPlaces);
                        if (m.Kind == HighlightKinds.PhotoFinish) Assert.True(m.Value < HighlightRules.PhotoMarginMm);
                        if (m.Kind == HighlightKinds.NearMiss) Assert.InRange(m.Value, HighlightRules.PhotoMarginMm, HighlightRules.NearMissMarginMm - 1);
                        if (m.Kind == HighlightKinds.LeadChange) Assert.InRange(m.Value, 0, HighlightRules.FinalLeadM);
                        if (m.Kind == HighlightKinds.Comeback) { Assert.InRange(m.Place, 1, 3); Assert.True(m.Value - 1 >= 12 - (12 + 2) / 3); }
                    }
                }
            }
            foreach (var k in new[] { HighlightKinds.WhipBurst, HighlightKinds.LeadChange, HighlightKinds.Finish })
                Assert.True(kinds.Contains(k), k + " seen in 40 races: " + string.Join(",", kinds));
            Assert.True(kinds.Contains(HighlightKinds.PhotoFinish) || kinds.Contains(HighlightKinds.NearMiss), string.Join(",", kinds));
        }

        [Fact]
        public void TheFocusHorseMovesUpButNeverChangesWhatHappened()
        {
            var log = Golden("race-turf1600-mixed.json");
            var none = HighlightDetector.Detect(log.Config, log.Inputs, -1);
            var mine = HighlightDetector.Detect(log.Config, log.Inputs, 0);
            // slot 0 lost a near miss: it is a highlight only for its own rider (it was 8th, not in the top three pairs)
            Assert.DoesNotContain(none.Moments, m => m.Kind == HighlightKinds.NearMiss);
            var nm = Assert.Single(mine.Moments, m => m.Kind == HighlightKinds.NearMiss);
            Assert.Equal(0, nm.Slot);
            Assert.Equal(1, nm.Rank);
        }

        [Fact]
        public void AWrongHashIsNeverHighlightedAndBrokenLogsThrow()
        {
            var log = Golden("race-turf2000-cpu12.json");
            Assert.Throws<InvalidOperationException>(() => HighlightDetector.Detect(log.Config, log.Inputs, 0, new string('0', 64)));
            var bad = new List<InputRecord>(log.Inputs) { new InputRecord(5, 99, Cmd.Whip) };
            Assert.Throws<ArgumentException>(() => HighlightDetector.Detect(log.Config, bad, 0));
            var p = ReplayPlayer.Open(Data("race-turf2000-cpu12.json", 0, new string('0', 64)));
            Assert.False(p.Playable);
            Assert.Throws<InvalidOperationException>(() => ReplayHighlights.Detect(p));
            Assert.Throws<InvalidOperationException>(() => HighlightReel.Open(p));
        }

        [Fact]
        public void ASoloRaceStillHasItsFinishStretchedTo15Seconds()
        {
            var rs = TestUtil.Ruleset();
            var cfg = TestUtil.Cfg(TestUtil.StraightTrack(1600), rs, new[] { TestUtil.H("solo") }, 1);
            var inputs = new List<InputRecord> { new InputRecord(rs.GateOpenTick, 0, Cmd.Start) };
            var set = HighlightDetector.Detect(cfg, inputs, 0);
            var m = Assert.Single(set.Moments);
            Assert.Equal(HighlightKinds.Finish, m.Kind);
            Assert.Equal(HighlightRules.Ticks(HighlightRules.MinTotalMs, cfg.Net.TickHz), set.TotalTicks); // a lone window may take the whole 15 s
        }

        [Fact]
        public void TheReelPlaysTheWindowsBackToBackAndSkips()
        {
            var p = ReplayPlayer.Open(Data("race-turf1600-mixed.json", 0));
            var started = new List<string>();
            var reel = new HighlightReel(p, ReplayHighlights.Detect(p));
            reel.MomentStarted += m => started.Add(m.Kind);
            Assert.Equal(3, reel.Set.Moments.Count);
            Assert.InRange(reel.TotalMs, HighlightRules.MinTotalMs, HighlightRules.MaxTotalMs);
            var first = reel.Current;
            Assert.Equal(first.StartTick * 50, p.TimeMs);
            Assert.Equal(first.Slot, p.CameraSlot);
            Assert.Equal(1.0, p.Speed);
            reel.Advance(first.DurationTicks * 50 - 100);
            Assert.Same(first, reel.Current);
            reel.Advance(200); // crosses into the second window: a cut, the camera on its subject
            var second = reel.Current;
            Assert.NotSame(first, second);
            Assert.Equal(second.Slot, p.CameraSlot);
            Assert.Equal(second.StartTick * 50 + 100, p.TimeMs);
            Assert.Equal(first.DurationTicks * 50 + 100, reel.ElapsedMs);
            reel.Next();
            Assert.Equal(reel.Set.Moments[2], reel.Current);
            reel.Advance(60_000);
            Assert.True(reel.Done);
            Assert.Null(reel.Current);
            Assert.Equal(reel.TotalMs, reel.ElapsedMs);
            Assert.Equal(new[] { reel.Set.Moments[1].Kind, reel.Set.Moments[2].Kind }, started);
            var again = HighlightReel.Open(ReplayPlayer.Open(Data("race-turf1600-mixed.json", 0)));
            again.Skip();
            Assert.True(again.Done);
            Assert.Equal(again.TotalMs, again.ElapsedMs);
            Assert.NotNull(again.Frame()); // the player still answers frames (the screen fades out)
        }

        [Fact]
        public void CommentaryInsideTheWindowsOnlyWithTheEquippedPack()
        {
            var log = Golden("race-turf2000-soft-night.json");
            var std = CommentaryTemplates.Parse(Res("commentary-ja.json"));
            var set = HighlightDetector.Detect(log.Config, log.Inputs, 0);
            var lines = HighlightReel.Commentary(std, log.Config, log.Inputs, 0);
            Assert.NotEmpty(lines);
            int inside = 0;
            foreach (var m in set.Moments)
            {
                var l = HighlightReel.LinesIn(lines, m);
                Assert.All(l, x => Assert.InRange(x.Tick, m.StartTick, m.EndTick));
                inside += l.Count;
            }
            Assert.True(inside > 0 && inside < lines.Count, inside + " of " + lines.Count);
            // a §36 pack changes the words, never the moments
            var cat = CommentaryPackCatalog.Parse(Res("commentary-packs.json"));
            var pack = cat.Packs.First(x => !x.IsStandard);
            var packed = HighlightReel.Commentary(CommentaryPackCatalog.Apply(std, pack), log.Config, log.Inputs, 0);
            Assert.NotEqual(string.Join("|", lines.Select(x => x.Text)), string.Join("|", packed.Select(x => x.Text)));
            Assert.Equal(HighlightJson.ToJson(set).ToString(), HighlightJson.ToJson(HighlightDetector.Detect(log.Config, log.Inputs, 0)).ToString());
            Assert.Empty(HighlightReel.LinesIn(null, set.Moments[0]));
        }

        [Fact]
        public void CaptionsHaveEnglishAndOnlyHorseNames()
        {
            var cfg = Golden("race-turf2000-cpu12.json").Config;
            var mk = (string kind, int value, int place, int rem) => new HighlightMoment { Kind = kind, Value = value, Place = place, RemainingM = rem, Slot = 2 };
            Assert.Equal("最後の直線で3頭抜き", HighlightCaptions.Headline(mk(HighlightKinds.WhipBurst, 3, 1, 150), cfg));
            Assert.Equal("ムチ一閃、2頭抜き", HighlightCaptions.Headline(mk(HighlightKinds.WhipBurst, 2, 4, 900), cfg));
            Assert.Equal("残り120mで先頭が替わる", HighlightCaptions.Headline(mk(HighlightKinds.LeadChange, 120, 1, 120), cfg));
            Assert.Equal("10番手から追い込んで2着", HighlightCaptions.Headline(mk(HighlightKinds.Comeback, 10, 2, 0), cfg));
            Assert.Equal(cfg.Entrants[2].Horse.Name + "（あなた）", HighlightCaptions.Subject(mk(HighlightKinds.Finish, 0, 1, 0), cfg, 2));
            Assert.Equal(cfg.Entrants[2].Horse.Name, HighlightCaptions.Subject(mk(HighlightKinds.Finish, 0, 1, 0), cfg, 0));
            var en = new LocaleCatalog();
            en.Add(Res("ui-en.json"));
            var samples = new[]
            {
                mk(HighlightKinds.PhotoFinish, 100, 2, 0), mk(HighlightKinds.NearMiss, 900, 3, 0), mk(HighlightKinds.LeadChange, 120, 1, 120),
                mk(HighlightKinds.WhipBurst, 3, 1, 150), mk(HighlightKinds.WhipBurst, 2, 4, 900), mk(HighlightKinds.Comeback, 10, 2, 0),
                mk(HighlightKinds.UniqueSkill, 4, 1, 500), mk(HighlightKinds.Finish, 0, 1, 0),
            };
            foreach (var m in samples)
            {
                string ja = HighlightCaptions.Headline(m, cfg), e = en.Translate(ja);
                Assert.False(e == null || Loc.HasJapanese(e), ja + " → " + e);
                Assert.DoesNotMatch("倍|今だけ|残りわずか|お得|通常価格", ja);
            }
            Assert.Equal("Charged from 10th to finish 2nd", en.Translate("10番手から追い込んで2着"));
            Assert.Equal("Passed 3 in the final straight", en.Translate("最後の直線で3頭抜き"));
            foreach (var k in new[] { "見どころ", "次へ", "スキップ", "見どころを共有", "画像で共有", "リンクで送る", "保存して公開すると、リンクで送れます", "見どころはありません" })
                Assert.False(en.Translate(k) == null, k);
        }

        [Fact]
        public async Task ShareCardAndReplayLinkCarryNoIds()
        {
            var p = ReplayPlayer.Open(Data("race-turf2000-soft-night.json", 3));
            var set = ReplayHighlights.Detect(p);
            var card = HighlightShare.Card(p, set, "青葉");
            Assert.Equal(HighlightShare.CardKind, card.Kind);
            Assert.Contains("ゴール前、写真判定の大接戦", card.Lines);
            Assert.StartsWith("ゴール前、写真判定の大接戦", card.ShareText);
            Assert.DoesNotContain("p0", card.ShareText);
            foreach (var e in p.Config.Entrants) if (!string.IsNullOrEmpty(e.PlayerId)) Assert.DoesNotContain(e.PlayerId, card.ShareText);
            Assert.Equal(set.Top.StartTick, HighlightShare.StartTick(set));
            Assert.Null(HighlightShare.StartTick(new HighlightSet()));

            var http = new FakeHttp();
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            var api = new ApiClient(http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
            http.Reply(200, "{\"token\":\"abcdefghjkmnpqrstuvwxy\",\"url\":\"https://link.muchi-issen.example/l/abcdefghjkmnpqrstuvwxy\",\"appUrl\":\"muchi://l/abcdefghjkmnpqrstuvwxy\",\"type\":\"replay\",\"createdAt\":1,\"expiresAt\":2,\"created\":true,\"shareText\":\"ムチ一閃のリプレイを見てください\\nhttps://link.muchi-issen.example/l/abcdefghjkmnpqrstuvwxy\"}");
            var link = await api.CreateReplayLinkAsync("r-hl", HighlightShare.StartTick(set));
            Assert.Equal("POST", http.Requests[0].Method);
            Assert.Equal("/v1/links", http.Requests[0].Path);
            Assert.Equal("{\"type\":\"replay\",\"target\":{\"raceId\":\"r-hl\",\"startTick\":" + set.Top.StartTick + "}}", http.Requests[0].Body);
            Assert.DoesNotContain(set.Top.StartTick.ToString(), link.Url); // the URL is only the token
            http.Reply(200, "{}");
            await api.CreateReplayLinkAsync("r-hl", 999_999);
            Assert.Contains("\"startTick\":72000", http.Requests[1].Body);

            var resolved = ResolvedLink.Parse(JsonNode.Parse("{\"state\":\"ok\",\"type\":\"replay\",\"screen\":\"friend_replay\",\"target\":{\"ownerId\":\"u1\",\"raceId\":\"r-hl\",\"replayTitle\":null,\"startTick\":" + set.Top.StartTick + "},\"expiresAt\":9}"));
            Assert.Equal(set.Top.StartTick, resolved.StartTick);
            Assert.Equal(set.Top.StartTick * 50, HighlightShare.StartTimeMs(resolved, p));
            var far = ResolvedLink.Parse(JsonNode.Parse("{\"state\":\"ok\",\"type\":\"replay\",\"target\":{\"raceId\":\"r\",\"startTick\":70000}}"));
            Assert.Equal(p.EndTick * 50, HighlightShare.StartTimeMs(far, p)); // clamped to the race
            Assert.Null(ResolvedLink.Parse(JsonNode.Parse("{\"state\":\"ok\",\"type\":\"replay\",\"target\":{\"raceId\":\"r\"}}")).StartTick);
        }

        [Fact]
        public void KpiEventsNameNoRaceOrPlayer()
        {
            var v = AnalyticsEvent.HighlightView(5, "result", HighlightKinds.PhotoFinish, 3);
            Assert.Equal("highlight_view", v.Name);
            Assert.Equal("{\"surface\":\"result\",\"top\":\"photo_finish\",\"moments\":3}", v.PropsJson);
            Assert.Equal("{\"surface\":\"link\",\"via\":\"link\"}", AnalyticsEvent.HighlightShare(5, "link", true).PropsJson);
            Assert.Equal("{\"surface\":\"my_replays\",\"via\":\"card\"}", AnalyticsEvent.HighlightShare(5, "my_replays", false).PropsJson);
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.HighlightView(5, "home", HighlightKinds.Finish, 1));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.HighlightView(5, "result", "dance", 1));
            Assert.Throws<ArgumentException>(() => AnalyticsEvent.HighlightShare(5, "x", true));
        }
    }

    /// <summary>REQ-HL-007: detection for a 12-horse race well under 50 ms (wall clock: runs alone, after the parallel tests).</summary>
    [Collection(nameof(WallClockSerial))]
    public class HighlightPerformanceTests
    {
        [Fact]
        public void TwelveHorseDetectionIsUnder50ms()
        {
            var log = HighlightsTests.Golden("race-turf2000-cpu12.json");
            Assert.Equal(12, log.Config.Entrants.Count);
            for (int i = 0; i < 3; i++) HighlightDetector.Detect(log.Config, log.Inputs, 0); // JIT warm-up
            var samples = new List<double>();
            for (int i = 0; i < 9; i++)
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                HighlightDetector.Detect(log.Config, log.Inputs, 0);
                sw.Stop();
                samples.Add(sw.Elapsed.TotalMilliseconds);
            }
            samples.Sort();
            string msg = "ms: " + string.Join(", ", samples.Select(x => x.ToString("F1")));
            Assert.True(samples[0] < 50, msg);   // the budget, on the least-disturbed run (a desktop runs it in a few ms)
            Assert.True(samples[4] < 150, msg);  // the median with headroom for a loaded CI runner
        }
    }
}
