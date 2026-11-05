using System.Text.RegularExpressions;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>contracts/assets.md: asset keys, manifest coverage, race visuals (C# side of REQ-ASSET-*).</summary>
    public class AssetContractTests
    {
        private static readonly string ManifestPath = Path.Combine(TestUtil.RepoRoot, "contracts", "assets.manifest.json");
        private static readonly string VisualsPath = Path.Combine(TestUtil.RepoRoot, "server", "master", "visuals.json");
        private static readonly string HorsesPath = Path.Combine(TestUtil.RepoRoot, "server", "master", "horses.json");
        private static readonly string CommentaryPath = Path.Combine(TestUtil.RepoRoot, "engine", "Muchi.Client", "Data", "commentary-ja.json");

        private static HashSet<string> ManifestKeys() => new HashSet<string>(AssetKeys.ParseManifestKeys(File.ReadAllText(ManifestPath)));

        [Fact]
        public void ManifestKeysAreValidAndEveryKindHasItsFallback()
        {
            var man = JsonNode.Parse(File.ReadAllText(ManifestPath));
            var keys = ManifestKeys();
            Assert.True(keys.Count > 100);
            foreach (var k in keys) Assert.True(AssetKeys.IsValid(k), "malformed " + k);
            foreach (var kv in man.Get("kinds").Props)
            {
                Assert.Contains(AssetKeys.Fallback(kv.Key), keys);
                Assert.Equal(AssetKeys.Fallback(kv.Key), kv.Value.Get("fallback").AsString());
            }
        }

        [Fact]
        public void KeysBuiltByTheClientMatchTheManifest()
        {
            var keys = ManifestKeys();
            var vis = JsonNode.Parse(File.ReadAllText(VisualsPath));
            // template looks (same data the server sends)
            foreach (var kv in vis.Get("horse").Get("templates").Props)
            {
                var a = new Appearance
                {
                    Coat = kv.Value.Get("coat").AsString(), Face = kv.Value.Get("face").AsString(), Mane = kv.Value.Get("mane").AsString(),
                    Build = kv.Value.Get("build").AsString(), Legs = kv.Value.Get("legs").Items.Select(x => x.AsString()).ToArray(),
                };
                foreach (var k in AssetKeys.HorseKeys(a)) Assert.Contains(k, keys);
            }
            // horse names are voiced by FNV-1a 64 of the name: same hash as the server (TypeScript)
            foreach (var t in JsonNode.Parse(File.ReadAllText(HorsesPath)).Get("templates").Items)
                Assert.Contains(AssetKeys.VoiceName(t.Get("name").AsString()), keys);
            // every fixed commentary clip has a voice key
            var tpl = CommentaryTemplates.Parse(File.ReadAllText(CommentaryPath));
            foreach (var clip in tpl.AllFixedClips().Keys) Assert.Contains(AssetKeys.VoiceClip(clip, null), keys);
            for (int n = 1; n <= 12; n++) Assert.Contains(AssetKeys.VoiceClip("num:" + n, null), keys);
            Assert.Equal(AssetKeys.VoiceName("シンセイアカツキ"), AssetKeys.VoiceClip("name:h1", id => id == "h1" ? "シンセイアカツキ" : null));
            Assert.Null(AssetKeys.VoiceClip("name:h2", id => null));
            for (int b = 1; b <= 8; b++) Assert.Contains(AssetKeys.Gate(b), keys);
            foreach (var p in vis.Get("silks").Get("patterns").Items) Assert.Contains(AssetKeys.SilksPattern(p.Get("id").AsString()), keys);
            Assert.Contains(AssetKeys.Going("sloppy"), keys);
            Assert.Contains(AssetKeys.Night("minato"), keys);
            Assert.Contains(AssetKeys.SurfaceScene("aoba", "dirt"), keys);
        }

        [Fact]
        public void KeyRulesAndFallbacks()
        {
            Assert.True(AssetKeys.IsValid("horse/coat/bay"));
            Assert.True(AssetKeys.IsValid("scene/venue/aoba@v2"));
            Assert.False(AssetKeys.IsValid("Horse/coat/bay"));
            Assert.False(AssetKeys.IsValid("coat"));
            Assert.False(AssetKeys.IsValid("horse/coat/bay-2"));
            Assert.False(AssetKeys.IsValid("horse//bay"));
            Assert.Equal("scene/venue", AssetKeys.KindOf("scene/venue/aoba@v2"));
            Assert.Equal("voice/ja/phrase/gate_open_1_p0", AssetKeys.VoicePhrase("gate_open_1#0"));
            Assert.Equal("cbf29ce484222325", AssetKeys.Fnv64Hex(""));
            Assert.Equal("af63dc4c8601ec8c", AssetKeys.Fnv64Hex("a"));
            var have = new HashSet<string> { "horse/coat/bay", "horse/coat/default" };
            Assert.Equal("horse/coat/bay", AssetKeys.Resolve("horse/coat/bay", have.Contains));
            Assert.Equal("horse/coat/default", AssetKeys.Resolve("horse/coat/palomino", have.Contains));
            Assert.Null(AssetKeys.Resolve("silks/pattern/hoops", have.Contains));
            Assert.Null(AssetKeys.Resolve(null, have.Contains));
        }

        [Fact]
        public void GateBracketsFollowTheEightBracketRule()
        {
            Assert.Equal(new[] { 1, 2, 3, 4, 5, 6, 7, 8 }, Enumerable.Range(1, 8).Select(g => AssetKeys.BracketOf(g, 8)));
            Assert.Equal(new[] { 1, 2, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8 }, Enumerable.Range(1, 12).Select(g => AssetKeys.BracketOf(g, 12)));
            Assert.Equal(new[] { 1, 2, 3, 4, 5, 6, 7, 7, 8, 8 }, Enumerable.Range(1, 10).Select(g => AssetKeys.BracketOf(g, 10)));
        }

        // ---------------------------------------------------------------- race visuals from `start`

        private const string StartVisualsJson = "{\"v\":1,\"track\":{\"trackId\":\"minato_turf_2400\",\"venue\":\"minato\",\"direction\":\"left\",\"surface\":\"turf\",\"going\":\"soft\",\"night\":true," +
            "\"keys\":{\"venue\":\"scene/venue/minato\",\"surface\":\"scene/surface/minato_turf\",\"night\":\"scene/night/minato\",\"going\":\"fx/going/soft\"}}," +
            "\"entrants\":[{\"slot\":0,\"gate\":1,\"bracket\":1,\"voiceName\":\"voice/ja/name/n0000000000000001\",\"appearance\":{\"coat\":\"gray\",\"face\":\"blaze\",\"legs\":[\"sock\",\"none\",\"none\",\"stocking\"],\"mane\":\"flaxen\",\"build\":\"rangy\"}," +
            "\"silks\":{\"pattern\":\"hoops\",\"colors\":[\"red\",\"white\"],\"cap\":\"star\"},\"displayName\":\"アリス\",\"titleId\":\"first_win\"}]}";

        [Fact]
        public void ParsesStartVisuals()
        {
            var v = RaceVisuals.Parse(JsonNode.Parse(StartVisualsJson));
            Assert.Equal("minato", v.Track.Venue);
            Assert.True(v.Track.LeftHanded);
            Assert.True(v.Track.Night);
            Assert.Equal("fx/going/soft", v.Track.GoingKey);
            var e = v.ForSlot(0);
            Assert.Equal("gray", e.Appearance.Coat);
            Assert.Equal(new[] { "sock", "none", "none", "stocking" }, e.Appearance.Legs);
            Assert.Equal(new[] { "red", "white" }, e.Silks.Colors);
            Assert.Equal("アリス", e.DisplayName);
            Assert.Contains("horse/coat/gray", AssetKeys.HorseKeys(e.Appearance));
        }

        [Fact]
        public void LockstepClientKeepsStartVisualsAndSessionFallsBackWithoutThem()
        {
            var log = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "golden", "race-turf2000-cpu12.json"))).Get("log");
            string cfg = log.Get("config").ToString();
            var sent = new List<string>();
            var c = new LockstepClient(new ListTransport(sent), "r", "t");
            c.HandleMessage("{\"t\":\"start\",\"you\":0,\"startAtMs\":1000,\"config\":" + cfg + ",\"visuals\":" + StartVisualsJson + "}", 0);
            Assert.NotNull(c.StartVisuals);
            Assert.Equal("minato", RaceVisuals.Parse(c.StartVisuals).Track.Venue);

            var old = new LockstepClient(new ListTransport(sent), "r", "t");
            old.HandleMessage("{\"t\":\"start\",\"you\":0,\"startAtMs\":1000,\"config\":" + cfg + "}", 0);
            Assert.Null(old.StartVisuals);
            var fb = RaceVisuals.Fallback(old.Config);
            Assert.Equal(old.Config.Entrants.Count, fb.Entrants.Count);
            Assert.Equal("scene/venue/" + old.Config.Track.Id.Split('_')[0], fb.Track.VenueKey);
            Assert.All(fb.Entrants, e => Assert.Equal(AssetKeys.BracketOf(e.Slot + 1, fb.Entrants.Count), e.Bracket));
        }

        private sealed class ListTransport : ITransport
        {
            private readonly List<string> _sent;
            public ListTransport(List<string> sent) { _sent = sent; }
            public void Send(string message) => _sent.Add(message);
        }

        // ---------------------------------------------------------------- API

        [Fact]
        public async Task VisualsCatalogSilksAndEmblemCalls()
        {
            var http = new FakeHttp();
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            var api = new ApiClient(http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());

            http.Reply(200, "{\"version\":1,\"palette\":[{\"id\":\"red\",\"hex\":\"#D3302F\"}],\"horse\":{\"coats\":[\"bay\"],\"faces\":[\"none\"],\"legs\":[\"none\"],\"manes\":[\"normal\"],\"builds\":[\"standard\"]}," +
                "\"silks\":{\"patterns\":[{\"id\":\"lightning\",\"colors\":3,\"unlockItem\":\"costume_starter\"}],\"caps\":[\"plain\"]},\"gateBrackets\":[{\"bracket\":1,\"cloth\":\"white\",\"number\":\"black\"}]," +
                "\"venues\":{},\"tracks\":[],\"emblem\":{\"shapes\":[\"shield\"],\"symbols\":[\"crown\"]},\"sfx\":{\"race\":[\"whip\"],\"ui\":[\"tap\"]}," +
                "\"templates\":{\"t_x\":{\"appearance\":{\"coat\":\"bay\",\"face\":\"star\",\"legs\":[\"none\",\"none\",\"none\",\"none\"],\"mane\":\"normal\",\"build\":\"standard\"}}}," +
                "\"items\":{\"costume_starter\":{\"icon\":\"item/costume_starter\"}},\"banners\":{\"standard\":\"banner/gacha/standard\"},\"events\":{},\"titles\":{\"debut\":\"title/debut\"}}");
            var cat = await api.GetVisualsAsync();
            Assert.Equal(1, cat.Version);
            Assert.Equal("#D3302F", cat.Palette["red"]);
            Assert.Equal("costume_starter", cat.SilksPatterns[0].UnlockItem);
            Assert.Equal(new[] { "white", "black" }, cat.GateBrackets[1]);
            Assert.Equal("star", cat.TemplateAppearances["t_x"].Face);
            Assert.Equal("item/costume_starter", cat.ItemIcons["costume_starter"]);
            var r = Assert.Single(http.Requests);
            Assert.Equal("GET", r.Method);
            Assert.Equal("/v1/visuals", r.Path);

            http.Requests.Clear();
            http.Reply(200, "{\"silks\":{\"pattern\":\"hoops\",\"colors\":[\"red\",\"white\"],\"cap\":\"star\"}}");
            var s = await api.SetSilksAsync(new Silks { Pattern = "hoops", Colors = new[] { "red", "white" }, Cap = "star" });
            Assert.Equal("hoops", s.Pattern);
            r = Assert.Single(http.Requests);
            Assert.Equal("PUT", r.Method);
            Assert.Equal("/v1/player/silks", r.Path);
            Assert.Equal(JsonNode.Parse("{\"pattern\":\"hoops\",\"colors\":[\"red\",\"white\"],\"cap\":\"star\"}").ToString(), JsonNode.Parse(r.Body).ToString());

            http.Requests.Clear();
            http.Reply(200, "{\"teamId\":\"t1\",\"name\":\"x\",\"joinPolicy\":\"open\",\"members\":[],\"requests\":[],\"emblem\":{\"shape\":\"shield\",\"symbol\":\"crown\",\"colors\":[\"red\",\"gold\"]}}");
            var team = await api.UpdateTeamAsync(null, null, new Emblem { Shape = "shield", Symbol = "crown", Colors = new[] { "red", "gold" } });
            Assert.Equal("crown", team.Emblem.Symbol);
            r = Assert.Single(http.Requests);
            Assert.Equal(JsonNode.Parse("{\"emblem\":{\"shape\":\"shield\",\"symbol\":\"crown\",\"colors\":[\"red\",\"gold\"]}}").ToString(), JsonNode.Parse(r.Body).ToString());
        }

        [Fact]
        public void PlayerViewAndPullCarryLooks()
        {
            var p = typeof(PlayerView).GetMethod("Parse", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
            var view = (PlayerView)p.Invoke(null, new object[] { JsonNode.Parse(
                "{\"id\":\"p\",\"wallet\":{},\"horses\":[{\"id\":\"h1\",\"name\":\"A\",\"appearance\":{\"coat\":\"black\",\"face\":\"star\",\"legs\":[\"none\",\"sock\",\"none\",\"none\"],\"mane\":\"dark\",\"build\":\"compact\"}}]," +
                "\"profile\":{\"displayName\":\"騎手\",\"titleId\":null,\"silks\":{\"pattern\":\"sash\",\"colors\":[\"navy\",\"gold\"],\"cap\":\"peak\"}}}") })!;
            Assert.Equal("black", view.Horses[0].Appearance.Coat);
            Assert.Equal("sash", view.Silks.Pattern);
            Assert.Equal("騎手", view.DisplayName);
            // older servers: defaults, never null
            var old = (PlayerView)p.Invoke(null, new object[] { JsonNode.Parse("{\"id\":\"p\",\"wallet\":{},\"horses\":[{\"id\":\"h1\"}]}") })!;
            Assert.NotNull(old.Horses[0].Appearance);
            Assert.NotNull(old.Silks);
        }
    }

    /// <summary>contracts/assets.md §5: render-only course geometry.</summary>
    public class TrackGeometryTests
    {
        private static TrackSpec Spec(params (SegmentKind k, int len, int r)[] segs)
        {
            var t = new TrackSpec { Id = "test_turf", Surface = Surface.Turf, DistanceM = segs.Sum(s => s.len) };
            foreach (var s in segs) t.Segments.Add(new TrackSegment(s.k, s.len, s.r));
            return t;
        }

        private static double Dist(TrackPose a, TrackPose b) => Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Z - b.Z) * (a.Z - b.Z));
        private static double YawDiff(double a, double b) { double d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return Math.Abs(d); }

        [Fact]
        public void StraightStartsAtOriginFacingPlusZ()
        {
            var g = new TrackGeometry(Spec((SegmentKind.Straight, 300, 0)));
            var a = g.PoseAt(0);
            var b = g.PoseAt(300);
            Assert.Equal(0, a.X, 3); Assert.Equal(0, a.Z, 3); Assert.Equal(0, a.YawDegrees, 3);
            Assert.Equal(300, b.Z, 2);
            Assert.Equal(300, g.LengthM);
            // left-handed course: the outside (lanes) is on the right (+X at the start)
            Assert.Equal(2.4, g.PoseAt(10, 2.4).X, 3);
            Assert.Equal(-2.4, new TrackGeometry(Spec((SegmentKind.Straight, 300, 0)), leftHanded: false).PoseAt(10, 2.4).X, 3);
        }

        [Fact]
        public void CornerTurnsByLengthOverRadiusAndLanesRunOnAWiderArc()
        {
            // 100*pi/2 metres on radius 100 = quarter turn
            int len = (int)Math.Round(100 * Math.PI / 2);
            var g = new TrackGeometry(Spec((SegmentKind.Straight, 100, 0), (SegmentKind.Corner, len, 100), (SegmentKind.Straight, 100, 0)));
            var end = g.PoseAt(100 + len);
            Assert.True(YawDiff(end.YawDegrees, 270) < 0.1, end.ToString()); // left turn = yaw decreases
            // corner centre is 100 m to the left of the rail at the corner start: (-100, 100)
            for (int d = 100; d <= 100 + len; d += 10)
            {
                var rail = g.PoseAt(d);
                var outer = g.PoseAt(d, 6);
                Assert.Equal(100, Math.Sqrt((rail.X + 100) * (rail.X + 100) + (rail.Z - 100) * (rail.Z - 100)), 2);
                Assert.Equal(106, Math.Sqrt((outer.X + 100) * (outer.X + 100) + (outer.Z - 100) * (outer.Z - 100)), 2);
            }
        }

        [Fact]
        public void ContinuousAtSegmentJoinsAndLateralIsPerpendicular()
        {
            var g = new TrackGeometry(Spec((SegmentKind.Straight, 350, 0), (SegmentKind.Corner, 600, 120), (SegmentKind.Straight, 450, 0), (SegmentKind.Corner, 300, 110), (SegmentKind.Straight, 300, 0)));
            foreach (double join in new[] { 350.0, 950, 1400, 1700 })
                foreach (double lat in new[] { 0.0, 3.6, 13.2 })
                {
                    var before = g.PoseAt(join - 1e-4, lat);
                    var after = g.PoseAt(join + 1e-4, lat);
                    Assert.True(Dist(before, after) < 0.01, $"gap at {join} lat {lat}");
                    Assert.True(YawDiff(before.YawDegrees, after.YawDegrees) < 0.01, $"kink at {join}");
                }
            for (double d = 0; d < g.LengthM; d += 37)
            {
                var rail = g.PoseAt(d);
                var off = g.PoseAt(d, 5);
                double yaw = rail.YawDegrees * Math.PI / 180;
                double fx = Math.Sin(yaw), fz = Math.Cos(yaw);
                double dx = off.X - rail.X, dz = off.Z - rail.Z;
                Assert.Equal(5, Math.Sqrt(dx * dx + dz * dz), 3);
                Assert.Equal(0, dx * fx + dz * fz, 3); // perpendicular to the heading
            }
        }

        [Fact]
        public void RailPolylineLengthEqualsCourseDistanceAndRightHandedMirrors()
        {
            var spec = Spec((SegmentKind.Straight, 350, 0), (SegmentKind.Corner, 600, 120), (SegmentKind.Straight, 650, 0));
            var left = new TrackGeometry(spec);
            var pts = left.Polyline(0.5);
            double total = 0;
            for (int i = 1; i < pts.Count; i++) total += Dist(pts[i - 1], pts[i]);
            Assert.Equal(1600, total, 0);
            var right = new TrackGeometry(spec, leftHanded: false);
            for (double d = 0; d <= 1600; d += 50)
            {
                var a = left.PoseAt(d, 2);
                var b = right.PoseAt(d, 2);
                Assert.Equal(a.X, -b.X, 2);
                Assert.Equal(a.Z, b.Z, 2);
            }
        }

        [Fact]
        public void FollowsEngineHorsesAndInterpolates()
        {
            var golden = JsonNode.Parse(File.ReadAllText(Path.Combine(TestUtil.RepoRoot, "contracts", "golden", "race-turf2000-cpu12.json"))).Get("log");
            var cfg = ProtocolCodec.ParseConfig(golden.Get("config"));
            var sim = new RaceSim(cfg);
            var g = TrackGeometry.For(cfg);
            var cmds = new byte[cfg.Entrants.Count];
            for (int t = 0; t < 400; t++) sim.Step(cmds);
            int lw = cfg.Ruleset.LaneWidthMm;
            for (int s = 0; s < cfg.Entrants.Count; s++)
            {
                var prev = sim.GetPreviousHorse(s);
                var cur = sim.GetHorse(s);
                var p0 = g.Interpolated(prev, cur, 0, lw);
                var p1 = g.Interpolated(prev, cur, 1000, lw);
                var mid = g.Interpolated(prev, cur, 500, lw);
                Assert.Equal(g.PoseOf(prev, lw).X, p0.X, 3);
                Assert.Equal(g.PoseOf(cur, lw).Z, p1.Z, 3);
                Assert.True(Dist(p0, mid) <= Dist(p0, p1) + 1e-3);
                Assert.False(float.IsNaN(mid.X) || float.IsInfinity(mid.Z));
            }
        }
    }
}
