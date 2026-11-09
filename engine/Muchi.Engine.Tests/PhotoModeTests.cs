using System.Linq;
using Muchi.Client;
using Muchi.Net;

namespace Muchi.Engine.Tests
{
    /// <summary>
    /// フォトモード (REQ-PHOTO-002/003/007/008/009/015, contracts/protocol.md §38): the snapshot re-simulates the race to a
    /// tick without touching the live race and reproduces its states (and checksum), the camera stays inside the limits
    /// and above the course, name plates mask non-friends, captions follow the wording rules, and the API client speaks §38.
    /// </summary>
    public class PhotoModeTests
    {
        private readonly FakeHttp _http = new FakeHttp();
        private readonly ApiClient _api;

        public PhotoModeTests()
        {
            var opt = new ApiClientOptions { BaseUrl = "https://api.example.test" };
            opt.Retry.Jitter = _ => 0;
            _api = new ApiClient(_http, new FakeAuth(), opt, new FakeDelay(), new SeqIds());
        }

        private static RaceConfig Field(ulong seed = 11)
        {
            var rs = TestUtil.Ruleset();
            var horses = Enumerable.Range(0, 6).Select(i => TestUtil.H("h" + i, 520 + i * 9, (RunningStyle)(i % 4))).ToList();
            horses[0].Name = "アカツキ";
            horses[1].Name = "フレンドノウマ";
            horses[2].Name = "シラナイウマ";
            var cfg = TestUtil.Cfg(TestUtil.CornerTrack(1600), rs, horses, 3, seed);
            cfg.Mode = RaceMode.TimeAttack;
            cfg.Entrants[0].PlayerId = "me";
            cfg.Entrants[1].PlayerId = "friend_1";
            cfg.Entrants[2].PlayerId = "stranger_secret_id";
            return cfg;
        }

        /// <summary>Rides slot 0 to <paramref name="untilTick"/> (start + whips), returns the race paused there.</summary>
        private static OfflineRace RideTo(RaceConfig cfg, int untilTick)
        {
            var race = new OfflineRace(cfg, 0);
            int lastWhip = -100;
            while (!race.IsFinished && race.Sim.Tick < untilTick)
            {
                if (race.Sim.Tick == race.Sim.P.GateOpenTick) race.Input(Cmd.Start);
                if (race.Sim.GetHorse(0).Departed && race.Sim.Tick > 400 && race.Sim.Tick - lastWhip >= 30) { lastWhip = race.Sim.Tick; race.Input(Cmd.Whip); }
                race.StepOnce();
            }
            return race;
        }

        [Fact]
        public void SnapshotReproducesThePausedRaceWithoutTouchingIt()
        {
            var cfg = Field();
            var race = RideTo(cfg, 700);
            int tick = race.Sim.Tick;
            string liveSum = race.Sim.ComputeChecksum();
            var live = Enumerable.Range(0, cfg.Entrants.Count).Select(s => race.Sim.GetHorse(s)).ToArray();

            var snap = PhotoSnapshot.Capture(race);
            Assert.Equal(tick, snap.Tick);
            Assert.False(snap.AtEnd);
            Assert.Equal(liveSum, snap.Fingerprint); // REQ-PHOTO-002: the very same state
            for (int s = 0; s < live.Length; s++)
                Assert.True(live[s].Distance == snap.States[s].Distance && live[s].Lane == snap.States[s].Lane && live[s].Speed == snap.States[s].Speed && live[s].Stamina == snap.States[s].Stamina, "slot " + s);
            // the live race did not move and still finishes with the same hash as an untouched copy
            Assert.Equal(tick, race.Sim.Tick);
            var twin = RideTo(Field(), 700);
            Assert.Equal(twin.Sim.ComputeChecksum(), liveSum);
            while (!race.IsFinished) race.StepOnce();
            while (!twin.IsFinished) twin.StepOnce();
            Assert.Equal(twin.Sim.Result.Hash, race.Sim.Result.Hash);

            // re-rendering later from (race, tick) gives the same fingerprint (deterministic); a later tick differs
            var again = PhotoSnapshot.Capture(cfg, race.AllInputs(), tick);
            Assert.Equal(snap.Fingerprint, again.Fingerprint);
            Assert.NotEqual(snap.Fingerprint, PhotoSnapshot.Capture(cfg, race.AllInputs(), tick + 20).Fingerprint);
            // a tick past the end is clamped to the end of the race
            var end = PhotoSnapshot.Capture(cfg, race.AllInputs(), 100_000);
            Assert.True(end.AtEnd);
            Assert.Equal(race.Sim.Tick, end.Tick);
            Assert.Throws<System.ArgumentOutOfRangeException>(() => PhotoSnapshot.Capture(cfg, race.AllInputs(), -1));
        }

        [Fact]
        public void CameraIsClampedOrbitsTheHorseAndNeverGoesUnderTheCourse()
        {
            var lim = PhotoCameraLimits.Default;
            var wild = new PhotoCameraParams { FocusSlot = 9, OrbitDeg = 270, DistanceDm = 999, HeightDm = -40, FovDeg = 5, Dof = 9 };
            var c = PhotoCamera.Clamp(wild, lim, 6);
            Assert.Equal(5, c.FocusSlot);
            Assert.Equal(-90, c.OrbitDeg); // wraps around
            Assert.Equal(200, c.DistanceDm);
            Assert.Equal(PhotoCameraLimits.MinHeightDm, c.HeightDm);
            Assert.Equal(20, c.FovDeg);
            Assert.Equal(3, c.Dof);
            Assert.True(PhotoCamera.Valid(c, lim, 6));
            Assert.False(PhotoCamera.Valid(wild, lim, 6));
            // a looser remote limit still cannot put the camera under the course
            var loose = new PhotoCameraLimits { HeightDm = new PhotoRange(0, 100) };
            Assert.Equal(PhotoCameraLimits.MinHeightDm, PhotoCamera.Clamp(new PhotoCameraParams { HeightDm = 0 }, loose, 6).HeightDm);
            Assert.False(PhotoCamera.Valid(new PhotoCameraParams { HeightDm = 0 }, loose, 6));

            var cfg = Field();
            var snap = PhotoSnapshot.Capture(RideTo(cfg, 600));
            foreach (int orbit in new[] { -180, -90, 0, 45, 90, 180 })
            {
                var p = new PhotoCameraParams { FocusSlot = 0, OrbitDeg = orbit, DistanceDm = 60, HeightDm = 3, FovDeg = 40 };
                var shot = PhotoCamera.Shot(snap, p, lim);
                var subject = snap.PoseOf(0);
                double dx = shot.Position.X - subject.X, dz = shot.Position.Z - subject.Z;
                Assert.Equal(6.0, System.Math.Sqrt(dx * dx + dz * dz), 3);
                Assert.True(shot.Height >= 0.3f - 1e-6, "height " + shot.Height);
                Assert.Equal(40, shot.FieldOfViewDegrees);
                Assert.True(RaceCameraRig.InFrame(shot, subject, PhotoCamera.LookAtHeightM, 16.0 / 9.0, 100), "orbit " + orbit + " keeps the horse in frame");
            }
            // 0° is behind the horse: the camera is further back along the course than the horse
            var behind = PhotoCamera.Shot(snap, new PhotoCameraParams { OrbitDeg = 0, DistanceDm = 100, HeightDm = 20, FovDeg = 40 });
            var front = PhotoCamera.Shot(snap, new PhotoCameraParams { OrbitDeg = 180, DistanceDm = 100, HeightDm = 20, FovDeg = 40 });
            var horse = snap.PoseOf(0);
            double yaw = horse.YawDegrees * System.Math.PI / 180;
            double Along(TrackPose p) => (p.X - horse.X) * System.Math.Sin(yaw) + (p.Z - horse.Z) * System.Math.Cos(yaw);
            Assert.True(Along(behind.Position) < -9.9 && Along(front.Position) > 9.9);
        }

        [Fact]
        public void NamePlatesMaskStrangersShowFriendsAndCanBeHidden()
        {
            var cfg = Field();
            var friends = new Dictionary<string, string> { ["friend_1"] = "ともだち" };
            var plates = PhotoNames.Plates(cfg, 0, friends, PhotoNameModes.Masked);
            Assert.Equal(6, plates.Count);
            Assert.Equal("あなた", plates[0].Rider);
            Assert.True(plates[0].You);
            Assert.Equal("ともだち", plates[1].Rider);
            Assert.Equal("p2", plates[2].Rider); // a non-friend human: p<slot>, never the id or name
            Assert.Equal("シラナイウマ", plates[2].HorseName);
            Assert.All(plates.Skip(3), p => Assert.Equal("CPU", p.Rider));
            Assert.DoesNotContain(plates, p => p.Rider.Contains("stranger"));
            Assert.Empty(PhotoNames.Plates(cfg, 0, friends, PhotoNameModes.Hidden));
            Assert.Equal("p1", PhotoNames.Plates(cfg, 0, null, PhotoNameModes.Masked)[1].Rider);
        }

        [Fact]
        public void CaptionCheckFollowsTheWordingRules()
        {
            Assert.Null(PhotoCaption.Problem(null));
            Assert.Null(PhotoCaption.Problem("   "));
            Assert.Null(PhotoCaption.Problem("差し切った！"));
            Assert.Equal("ムチ 一閃", PhotoCaption.Normalize("  ﾑﾁ　一閃 "));
            Assert.Null(PhotoCaption.Problem(new string('あ', 24)));
            Assert.Equal("ひとことは24文字までです", PhotoCaption.Problem(new string('あ', 25)));
            Assert.Equal(PhotoCaption.TextUrl, PhotoCaption.Problem("見て https://x.example"));
            foreach (var w in PhotoCaption.BannedWords) Assert.Equal(PhotoCaption.TextWording, PhotoCaption.Problem("今日は" + w));
        }

        [Fact]
        public void ShareCardCarriesTheOverlaysAndNeverOtherPlayersNames()
        {
            var cfg = Field();
            var snap = PhotoSnapshot.Capture(RideTo(cfg, 650));
            var spec = new PhotoSpec
            {
                Source = new PhotoSource { Kind = PhotoSourceKinds.Paused, Mode = "time_attack", RaceId = "local:1", Tick = snap.Tick },
                Camera = new PhotoCameraParams { OrbitDeg = 45, DistanceDm = 80, HeightDm = 12, FovDeg = 35, Dof = 2 },
                LookId = "film", FrameId = "victory", Caption = " ゴール前 ",
            };
            spec.Stamps.Add(new PhotoStampPlacement { Id = "crown", XPermille = 800, YPermille = 150 });
            var card = PhotoShareCard.Build(snap, spec, 0, "青葉 芝1600m", new Dictionary<string, string> { ["friend_1"] = "ともだち" });
            Assert.Equal("photo_image", card.Kind);
            Assert.Equal(ShareCard.GameTitle, card.Watermark); // the game logo
            Assert.Equal("アカツキ", card.HorseName);
            Assert.Equal("タイムアタック", card.ModeLabel);
            Assert.Equal("photo/look/film", card.Photo.LookAsset);
            Assert.Equal("photo/frame/victory", card.Photo.FrameAsset);
            Assert.Equal(new[] { "photo/stamp/crown" }, card.Photo.StampAssets);
            Assert.Equal("ゴール前", card.Photo.Caption);
            Assert.Equal(2, card.Photo.Dof);
            Assert.Equal("アカツキ　青葉 芝1600m　ゴール前　#ムチ一閃", card.ShareText);
            Assert.DoesNotContain("ともだち", card.ShareText);
            Assert.DoesNotContain("stranger", card.ShareText);
            Assert.Equal("p2", card.Photo.Plates[2].Rider);
            // the still for the replay share recorder: both states = the photo tick, posed with the photo camera
            var shot = PhotoCamera.Shot(snap, spec.Camera);
            var frame = snap.ToFrame(shot);
            Assert.Equal(snap.Tick, frame.Tick);
            Assert.Equal(1000, frame.AlphaPermille);
            Assert.Same(frame.From, frame.To);
            Assert.Equal(shot.Position.X, frame.Camera.Position.X);
        }

        // ---- API client (bodies produced by the server's photoMode.ts)
        internal const string Catalog = "{\"enabled\":true,\"version\":1,\"limits\":{\"maxSaved\":30,\"captionMaxChars\":24,\"stampsMax\":3,\"camera\":{\"orbitDeg\":[-180,180],\"distanceDm\":[20,200],\"heightDm\":[3,100],\"fovDeg\":[20,70],\"dof\":[0,3]}},"
            + "\"looks\":[{\"id\":\"natural\",\"name\":\"ナチュラル\",\"asset\":\"photo/look/natural\",\"unlock\":{\"kind\":\"default\"},\"unlockText\":\"最初から使える\",\"unlocked\":true}],"
            + "\"frames\":[{\"id\":\"plain\",\"name\":\"シンプル\",\"asset\":\"photo/frame/plain\",\"unlock\":{\"kind\":\"default\"},\"unlockText\":\"最初から使える\",\"unlocked\":true},{\"id\":\"victory\",\"name\":\"勝利の額縁\",\"asset\":\"photo/frame/victory\",\"unlock\":{\"kind\":\"achievement\",\"achievementId\":\"wins\",\"tier\":1},\"unlockText\":\"実績「勝利の記録」の1段目で解放\",\"unlocked\":false}],"
            + "\"stamps\":[{\"id\":\"carrot_pop\",\"name\":\"にんじんポップ\",\"asset\":\"photo/stamp/carrot_pop\",\"unlock\":{\"kind\":\"cosmetic\",\"itemId\":\"photo_stamp_carrot_pop\"},\"price\":100,\"currency\":\"any\",\"unlockText\":\"見た目ショップで購入（100コイン）\",\"unlocked\":false}],"
            + "\"notice\":\"フォトモードの見た目は写真だけに使われ、レースの能力には影響しません。\"}";
        internal const string Saved = "{\"photo\":{\"id\":\"ph_1\",\"createdAt\":1794193200000,\"source\":{\"kind\":\"paused\",\"mode\":\"practice\",\"raceId\":\"local:abc\",\"tick\":640},\"camera\":{\"focusSlot\":0,\"orbitDeg\":30,\"distanceDm\":60,\"heightDm\":15,\"fovDeg\":40,\"dof\":1},\"lookId\":\"film\",\"frameId\":\"plain\",\"stamps\":[{\"id\":\"hoof\",\"xPermille\":800,\"yPermille\":200,\"scalePermille\":1000,\"rotDeg\":-10}],\"caption\":\"ゴール前\",\"names\":\"masked\",\"hideUi\":true},\"count\":1,\"max\":30}";

        [Fact]
        public async Task CatalogParsesLimitsUnlocksAndShopItems()
        {
            _http.Reply(200, Catalog);
            var c = await _api.GetPhotoCatalogAsync();
            Assert.Equal("/v1/photo/catalog", _http.Requests[0].Path);
            Assert.True(c.Enabled);
            Assert.Equal(30, c.MaxSaved);
            Assert.Equal(3, c.StampsMax);
            Assert.Equal(new PhotoRange(3, 100).Hi, c.Camera.HeightDm.Hi);
            Assert.Equal(-180, c.Camera.OrbitDeg.Lo);
            var v = c.Find("frames", "victory");
            Assert.False(v.Unlocked);
            Assert.Equal("achievement", v.Unlock.Kind);
            Assert.Equal(1, v.Unlock.Tier);
            Assert.False(v.Buyable);
            var carrot = c.Find("stamps", "carrot_pop");
            Assert.True(carrot.Buyable);
            Assert.Equal(100, carrot.Price);
            Assert.Equal("photo_stamp_carrot_pop", carrot.Unlock.ItemId);
            _http.Reply(200, "{\"enabled\":false}");
            Assert.False((await _api.GetPhotoCatalogAsync()).Enabled);
            // offline: the free looks and the free frames / stamps of the shipped catalog
            var off = PhotoCatalog.Offline();
            Assert.Equal(5, off.Looks.Count);
            Assert.True(off.Looks.Concat(off.Frames).Concat(off.Stamps).All(x => x.Unlocked && x.Unlock.Kind == "default"));
        }

        [Fact]
        public async Task SaveSendsTheSpecWithAnIdempotencyKeyAndParsesTheRecord()
        {
            _http.Reply(200, Saved);
            var spec = new PhotoSpec
            {
                Source = new PhotoSource { Kind = "paused", Mode = "practice", RaceId = "local:abc", Tick = 640 },
                Camera = new PhotoCameraParams { OrbitDeg = 30, DistanceDm = 60, HeightDm = 15, FovDeg = 40, Dof = 1 },
                LookId = "film", FrameId = "plain", Caption = "ゴール前",
            };
            spec.Stamps.Add(new PhotoStampPlacement { Id = "hoof", XPermille = 800, YPermille = 200, RotDeg = -10 });
            var r = await _api.SavePhotoAsync(spec, "k1");
            var req = _http.Requests[0];
            Assert.Equal("POST", req.Method);
            Assert.Equal("/v1/photos", req.Path);
            Assert.Equal("k1", req.Headers["idempotency-key"]);
            var body = JsonNode.Parse(req.Body);
            Assert.Equal("paused", body.Get("source").Get("kind").AsString());
            Assert.Equal(640, body.Get("source").Get("tick").AsInt());
            Assert.Equal(15, body.Get("camera").Get("heightDm").AsInt());
            Assert.Equal("hoof", body.Get("stamps").Items[0].Get("id").AsString());
            Assert.Equal("masked", body.Get("names").AsString());
            Assert.True(body.Get("hideUi").AsBool());
            Assert.Equal("ph_1", r.Saved.Id);
            Assert.Equal(640, r.Saved.Spec.Source.Tick);
            Assert.Equal(-10, r.Saved.Spec.Stamps[0].RotDeg);
            Assert.Equal(1, r.Count);
            Assert.False(r.Full);
            // an empty caption is sent as null (no caption)
            _http.Reply(200, Saved);
            spec.Caption = "";
            await _api.SavePhotoAsync(spec, "k2");
            Assert.True(JsonNode.Parse(_http.Requests[1].Body).Get("caption").IsNull);
        }

        [Fact]
        public async Task ErrorsMapToTypedCodes()
        {
            _http.Reply(409, "{\"error\":{\"code\":\"PHOTO_LIMIT\",\"message\":\"at most 30 photos\"}}");
            var e = await Assert.ThrowsAnyAsync<ApiException>(() => _api.SavePhotoAsync(new PhotoSpec { Source = new PhotoSource { RaceId = "r" } }, "k"));
            Assert.Equal(ApiErrorCode.PhotoLimit, e.Code);
            Assert.Equal(ApiErrorCode.PhotoLocked, ApiErrorCodes.Parse("PHOTO_LOCKED"));
            Assert.Equal(ApiErrorCode.PhotoSourceInvalid, ApiErrorCodes.Parse("PHOTO_SOURCE_INVALID"));
            _http.Reply(200, "{\"deleted\":true,\"count\":0,\"max\":30}");
            var d = await _api.DeletePhotoAsync("ph_1");
            Assert.Equal("DELETE", _http.Requests[1].Method);
            Assert.Equal("/v1/photos/ph_1", _http.Requests[1].Path);
            Assert.Equal(0, d.Count);
        }

        [Fact]
        public void AnalyticsEventsMatchTheServerSchema()
        {
            var t = AnalyticsEvent.PhotoTake(1, "paused", "film");
            Assert.Equal("photo_take", t.Name);
            var s = AnalyticsEvent.PhotoShare(1, "replay", true);
            Assert.Equal("photo_share", s.Name);
            Assert.Throws<System.ArgumentException>(() => AnalyticsEvent.PhotoTake(1, "live", "film"));
            Assert.Equal("photo/frame/x", AssetKeys.PhotoFrame("x"));
            Assert.Equal("photo/look", AssetKeys.KindOf("photo/look/film"));
        }
    }
}
